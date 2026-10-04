import {act} from './browser.js';
import {createDialog, findNpcEntity} from './npc.js';
import {isWarper, observeWarpers, warperSpots, warpraMayServe} from './warper-reference.js';
import {travelCosts} from './world.js';
import {inspectWarpra, closeWarpra, clickWarpraDestination} from './warpra-ui.js';
import {log} from './logger.js';

// One trip budget for the whole destination, shared with travel.js (the Warpra phase and the walk).
export const TRIP_TIMEOUT_MS = 15 * 60 * 1000;
const BOARD_WAIT_MS = 10000; // the board (or a legacy dialog) must answer within this
const STUCK_MS = 25000; // not changing cell while walking to a Warpra/helper NPC
const PAUSE_GAP_MS = 3000; // a longer gap between ticks means the trip was paused (fight, shop)
const MAX_UI_ERRORS = 3; // Playwright timeouts on the board before giving up on Warpra
const MAX_NO_PATH = 3; // walk_to found no path this many times in a row

// Owns the trip until Warpra has answered. Navigation is used only to reach
// the service/required unlock NPC, or after the board rules out a direct warp.
// Every failure ends in 'fallback' (walk / @go the normal way): a Warpra problem is never a reason
// to drop a hunting map that can be walked to.
export function createWarpraTravel(page, world, feeder, go) {
  const dialog = createDialog(page);
  let t = null;
  const setStage = stage => { t.stage = stage; t.at = Date.now(); t.posAt = Date.now(); };
  async function stop() {
    if (t) await closeWarpra(page);
    t = null;
    if (feeder.dest) await feeder.stop();
  }
  function start(dest) {
    const now = Date.now();
    t = {dest,stage:'check',at:now,started:now,posAt:now,lastTickAt:now,pos:null,unlock:null,verified:false,uiErrors:0,noPath:0};
  }
  const giveUp = reason => { log('warpra_fallback',{to:t.dest,stage:t.stage,reason,unlock:!!t.unlock}); return 'fallback'; };
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
      const pos = `${snap.me.map}:${snap.me.x},${snap.me.y}`;
      if (pos !== t.pos) { t.pos = pos; t.posAt = Date.now(); }
      if (Date.now() - t.posAt > STUCK_MS) return 'failed';
      if (snap.me.sitting) await act(page,'stand');
      if (!snap.me.walking) {
        const wp = await act(page,'walk_to',{x,y});
        t.noPath = wp ? 0 : t.noPath + 1;
        if (t.noPath >= MAX_NO_PATH) return 'failed';
      }
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
    if (board.state==='error') {
      if (++t.uiErrors < MAX_UI_ERRORS) return 'traveling';
      await closeWarpra(page);
      return giveUp('board UI errors');
    }
    if (board.state==='unreadable' && !t.refreshed) {
      t.refreshed = true; await closeWarpra(page); setStage('recheck'); return 'traveling';
    }
    if (board.state==='open') {
      if (t.unlock) {t.verified=true;log('travel_unlock_verified',{to:t.dest,helper:t.unlock});}
      if ((snap.me.zeny || 0) < board.place.price) {await closeWarpra(page);return giveUp('not enough zeny');}
      if (snap.me.map===t.dest) {await closeWarpra(page);return 'arrived';}
      if (!await clickWarpraDestination(page,board)) return 'traveling';
      setStage('verifyWarp');return 'traveling';
    }
    if (board.state==='locked') {
      if (t.unlock) {await closeWarpra(page);log('travel_unlock_failed',{to:t.dest,reason:'board still locked'});return giveUp('board still locked');}
      let spot=board.spot;
      if (!spot && board.place.group===0) spot=(world.npcs||[]).find(n=>isWarper(n.name)&&n.map===(board.place.unlock||board.place.map));
      if (!spot) {await closeWarpra(page);log('travel_unlock_failed',{to:t.dest,reason:'no unlock NPC location'});return giveUp('no unlock NPC location');}
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
    return giveUp('board state ' + board.state);
  }
  async function tick(snap) {
    if (!t) return 'fallback';
    const now = Date.now();
    // Time spent paused (a fight, the Healer) is not trip time.
    const gap = now - t.lastTickAt;
    if (gap > PAUSE_GAP_MS) { t.started += gap; t.posAt = now; }
    t.lastTickAt = now;
    if (now-t.started>TRIP_TIMEOUT_MS) return giveUp('timeout');
    observeWarpers(world,snap);
    if (t.stage==='check'||t.stage==='board'||t.stage==='recheck') {
      const board=await inspectWarpra(page,t.dest);
      if (board) return consumeBoard(snap,board);
      if (t.stage==='board') {
        if (Date.now()-t.at<BOARD_WAIT_MS) return 'traveling';
        // A legacy NPC may answer with ordinary pages before opening the board.
        if (snap.dialog?.state==='next') {await act(page,'npc_next',{naid:snap.dialog.naid});t.at=Date.now();return 'traveling';}
        if (snap.dialog) await act(page,'npc_close',{naid:snap.dialog.naid});
        return giveUp('board did not open');
      }
      const costs=travelCosts(world,snap.me.map,snap.me.x,snap.me.y,{canGo:go.canGo});
      const candidates=warperSpots(world).map(npc=>({npc,cost:costs.to(npc.map,npc.x,npc.y)})).filter(n=>Number.isFinite(n.cost)).sort((a,b)=>a.cost-b.cost);
      t.npc=candidates[0]?.npc;
      if (!t.npc) return giveUp('no reachable Warpra');
      setStage('warper');
    }
    if (t.stage==='warper') {
      const npc=await approach(snap,t.npc);
      if (npc==='moving') return 'traveling';
      if (npc==='failed') return giveUp('cannot reach Warpra');
      await act(page,'talk',{GID:npc.GID});setStage('board');return 'traveling';
    }
    if (t.stage==='entry'||t.stage==='helper') {
      const npc=await approach(snap,t.stage==='entry'?t.entry:t.unlock);
      if (npc==='moving') return 'traveling';
      if (npc==='failed') return giveUp('cannot reach ' + (t.stage==='entry'?'dungeon entry':'unlock helper'));
      const purpose=t.stage==='entry'?'enter dungeon to reach unlock helper':'unlock dungeon for Warpra';
      await dialog.start(npc,chooser(purpose));setStage(t.stage==='entry'?'entryDialog':'helperDialog');return 'traveling';
    }
    if (t.stage==='entryDialog'||t.stage==='helperDialog') {
      const board=await inspectWarpra(page,t.dest);
      if (board) return consumeBoard(snap,board);
      const result=await dialog.tick(snap);
      if (!result) return 'traveling';
      if (!result.ok) return giveUp('unlock dialog: ' + result.reason);
      if (t.stage==='entryDialog') setStage('helper');
      else {log('travel_unlock_spoken',{to:t.dest,helper:t.unlock});setStage('recheck');}
      return 'traveling';
    }
    if (t.stage==='verifyWarp') {
      if (snap.me.map===t.dest) {await closeWarpra(page);return 'arrived';}
      if (Date.now()-t.at<BOARD_WAIT_MS) return 'traveling';
      await closeWarpra(page);
      return giveUp('warp not confirmed');
    }
    return 'traveling';
  }
  return {
    start,stop,tick,
    /** Worth asking Warpra about this destination at all (false once the live board lacks it). */
    serves:dest=>warpraMayServe(world,dest),
    /** The destination town is on the board but locked: arriving on foot does not unlock it. */
    needsUnlockAt:map=>world.warpraPlaces?.find(p=>p.map===map)?.lock===1,
    get stage(){return t?.stage;},
    get inDialog(){return ['board','entryDialog','helperDialog','verifyWarp'].includes(t?.stage);},
  };
}
