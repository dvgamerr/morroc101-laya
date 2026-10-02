import {act} from './browser.js';
import {createDialog, findNpcEntity} from './npc.js';
import {isWarper, observeWarpers, warperSpots} from './warper-reference.js';
import {travelCosts} from './world.js';
import {inspectWarpra, closeWarpra, clickWarpraDestination} from './warpra-ui.js';
import {log} from './logger.js';

// Owns the trip until Warpra has answered. Navigation is used only to reach
// the service/required unlock NPC, or after the board rules out a direct warp.
export function createWarpraTravel(page, world, feeder, go) {
  const dialog = createDialog(page);
  let t = null;
  const setStage = stage => { t.stage = stage; t.at = Date.now(); };
  async function stop() {
    if (t) await closeWarpra(page);
    t = null;
    if (feeder.dest) await feeder.stop();
  }
  function start(dest) { t = {dest,stage:'check',at:Date.now(),started:Date.now(),unlock:null,verified:false}; }
  async function approach(snap, spot) {
    if (snap.me.map !== spot.map) {
      if (feeder.dest !== spot.map) await feeder.start(spot.map);
      return await feeder.tick(snap) === 'failed' ? 'failed' : 'moving';
    }
    if (feeder.dest) await feeder.stop();
    const found = findNpcEntity(snap, spot);
    const norm = name => String(name || '').replace(/#.*$/, '').trim().toLowerCase();
    const npc = found && norm(found.name) === norm(spot.name) ? found : null;
    const x = npc?.x ?? spot.x, y = npc?.y ?? spot.y;
    if (Math.max(Math.abs(snap.me.x-x), Math.abs(snap.me.y-y)) > 3) {
      if (snap.me.sitting) await act(page,'stand');
      if (!snap.me.walking) await act(page,'walk_to',{x,y});
      return 'moving';
    }
    return npc || 'failed';
  }
  const chooser = purpose => ({goal:purpose,allowLaya:false,rules(options) {
    const i=options.findIndex(s=>/^(yes|yes[,.! ].*|ok|okay|confirm|register|unlock|save|enter|go inside|ใช่|ตกลง|ยืนยัน|ปลดล็อก|ลงทะเบียน|เข้า)([.! ]*)$/i.test(s.trim()));
    return i<0?null:{index:i,why:purpose};
  }});
  async function consumeBoard(snap, board) {
    if (board.feed) world.warpraPlaces = board.feed.places.map(p=>({...p,groupName:board.feed.groups[p.group]}));
    if (board.state==='unreadable' && !t.refreshed) {
      t.refreshed = true; await closeWarpra(page); setStage('recheck'); return 'traveling';
    }
    if (board.state==='open') {
      if (t.unlock) {t.verified=true;log('travel_unlock_verified',{to:t.dest,helper:t.unlock});}
      if ((snap.me.zeny || 0) < board.place.price) {await closeWarpra(page);return 'fallback';}
      if (snap.me.map===t.dest) {await closeWarpra(page);return 'arrived';}
      if (!await clickWarpraDestination(page,board)) return 'traveling';
      setStage('verifyWarp');return 'traveling';
    }
    if (board.state==='locked') {
      if (t.unlock) {await closeWarpra(page);log('travel_unlock_failed',{to:t.dest,reason:'board still locked'});return 'failed';}
      let spot=board.spot;
      if (!spot && board.place.group===0) spot=(world.npcs||[]).find(n=>isWarper(n.name)&&n.map===(board.place.unlock||board.place.map));
      if (!spot) {await closeWarpra(page);log('travel_unlock_failed',{to:t.dest,reason:'no unlock NPC location'});return 'failed';}
      t.unlock=spot;t.entry=board.entry;
      log('travel_unlock_required',{to:t.dest,helper:spot,entry:t.entry});
      await closeWarpra(page);
      setStage(t.entry?'entry':'helper');return 'traveling';
    }
    await closeWarpra(page);
    if (t.unlock && board.state === 'unavailable' && board.place.group > 0 && board.feed.places.some(p => p.group === board.place.group && p.lock === 0)) {
      log('travel_unlock_verified', { to:t.dest, helper:t.unlock, walkingFinalFloor:true });
      return 'fallback';
    }
    return t.unlock ? 'failed' : 'fallback';
  }
  async function tick(snap) {
    if (!t) return 'fallback';
    if (Date.now()-t.started>30*60*1000) return 'failed';
    observeWarpers(world,snap);
    if (t.stage==='check'||t.stage==='board'||t.stage==='recheck') {
      const board=await inspectWarpra(page,t.dest);
      if (board) return consumeBoard(snap,board);
      if (t.stage==='board') {
        if (Date.now()-t.at<10000) return 'traveling';
        // A legacy NPC may answer with ordinary pages before opening the board.
        if (snap.dialog?.state==='next') {await act(page,'npc_next',{naid:snap.dialog.naid});t.at=Date.now();return 'traveling';}
        if (snap.dialog) await act(page,'npc_close',{naid:snap.dialog.naid});
        return t.unlock?'failed':'fallback';
      }
      const costs=travelCosts(world,snap.me.map,snap.me.x,snap.me.y,{canGo:go.canGo});
      const candidates=warperSpots(world).map(npc=>({npc,cost:costs.to(npc.map,npc.x,npc.y)})).filter(n=>Number.isFinite(n.cost)).sort((a,b)=>a.cost-b.cost);
      t.npc=candidates[0]?.npc;
      if (!t.npc) return t.unlock?'failed':'fallback';
      setStage('warper');
    }
    if (t.stage==='warper') {
      const npc=await approach(snap,t.npc);
      if (npc==='moving') return 'traveling';
      if (npc==='failed') return t.unlock?'failed':'fallback';
      await act(page,'talk',{GID:npc.GID});setStage('board');return 'traveling';
    }
    if (t.stage==='entry'||t.stage==='helper') {
      const npc=await approach(snap,t.stage==='entry'?t.entry:t.unlock);
      if (npc==='moving') return 'traveling';
      if (npc==='failed') return 'failed';
      const purpose=t.stage==='entry'?'enter dungeon to reach unlock helper':'unlock dungeon for Warpra';
      await dialog.start(npc,chooser(purpose));setStage(t.stage==='entry'?'entryDialog':'helperDialog');return 'traveling';
    }
    if (t.stage==='entryDialog'||t.stage==='helperDialog') {
      const board=await inspectWarpra(page,t.dest);
      if (board) return consumeBoard(snap,board);
      const result=await dialog.tick(snap);
      if (!result) return 'traveling';
      if (!result.ok) return 'failed';
      if (t.stage==='entryDialog') setStage('helper');
      else {log('travel_unlock_spoken',{to:t.dest,helper:t.unlock});setStage('recheck');}
      return 'traveling';
    }
    if (t.stage==='verifyWarp') {
      if (snap.me.map===t.dest) {await closeWarpra(page);return 'arrived';}
      if (Date.now()-t.at<10000) return 'traveling';
      await closeWarpra(page);
      return 'fallback';
    }
    return 'traveling';
  }
  return {start,stop,tick,get stage(){return t?.stage;},get inDialog(){return ['board','entryDialog','helperDialog','verifyWarp'].includes(t?.stage);}};
}
