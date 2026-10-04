import { readFileSync, writeFileSync } from 'node:fs';
import { act } from './browser.js';
import { createDialog, findNpcEntity } from './npc.js';
import { gearTargets, gearReference, readGearStorage } from './gear-goal.js';
import { log } from './logger.js';

const RESERVE = 100000;
const LOC = { weapon: 34, head_top: 256, armor: 16, garment: 4, shoes: 64 };
const count = (s, id) => s.inventory.filter(i => i.ITID === id && i.count > 0).reduce((n,i) => n+i.count, 0) + (s.worn || []).filter(i => i.ITID === id).length;
const owned = (s, id) => {
  const worn = s.worn?.find(i => i.ITID === id);
  return worn ? { ...worn, equipped: true, gear: worn } : s.inventory.find(i => i.ITID === id && i.count > 0);
};
const strictChooser = (text, option) => ({ goal: text, allowLaya: false, rules(options) {
  const index = options.findIndex(o => o.trim() === option);
  return index >= 0 ? { index, why: text } : null;
} });

/** Owner-authorized NPC shopping and +7 refining. Every spend uses a fresh server quote. */
export function createGearUpgrade(page, travel, storage) {
  const dialog = createDialog(page);
  const audit = readGearStorage();
  const g = { stage: 'idle', at: 0, auditDone: !!audit && Date.now()-Date.parse(audit.checkedAt)<5*60*1000, active: false, funding: 0, retryAt: 0 };
  try {
    const previous=JSON.parse(readFileSync('logs/gear-progress.json','utf8'));
    if (previous.targetRefine === 7 && Number.isFinite(previous.requiredZeny) && previous.requiredZeny>RESERVE) g.funding=previous.requiredZeny;
  } catch {}
  function stage(name) { g.stage = name; g.at = Date.now(); }
  function report(s, note) {
    writeFileSync('logs/gear-progress.json', JSON.stringify({ at: new Date().toISOString(), stage: g.stage, note, requiredZeny: g.funding, target: g.target?.name, currentZeny: s.me.zeny, targetRefine: 7, complete: g.stage === 'complete' }, null, 2));
    log('gear_upgrade', { stage: g.stage, item: g.target?.name, note });
  }
  async function release(s) {
    if (s.refine?.open) await act(page, 'refine_close');
    if (s.shop) await act(page, s.shop.stage === 'barter' ? 'barter_close' : 'close_shop');
    if (travel.dest) await travel.stop();
    g.active = false;
  }
  async function fail(s, note) {
    await release(s);
    g.retryAt = Date.now() + 60000;
    stage('idle'); report(s, note);
    return true;
  }
  async function fund(s, amount) {
    const item = g.target && owned(s,g.target.id);
    if (item && !item.equipped) {
      if (s.refine?.open) await act(page,'refine_close');
      if (s.shop) await act(page,'close_shop');
      await act(page,'equip',{index:item.index,loc:LOC[g.target.slot]});
      g.pendingFunding = RESERVE + amount;
      stage('fund_equip_wait');
      return true;
    }
    g.funding = RESERVE + amount;
    await release(s);
    stage('idle'); report(s, 'หาเงินสำหรับขั้นถัดไป โดยไม่ใช้เงินสำรอง');
    return false;
  }
  async function reach(s, npc) {
    if (s.me.map !== npc.map) {
      if (travel.dest !== npc.map) await travel.start(npc.map);
      if (await travel.tick(s) === 'failed') throw new Error('cannot reach '+npc.map);
      return false;
    }
    if (travel.dest) await travel.stop();
    if (Math.max(Math.abs(s.me.x-npc.x),Math.abs(s.me.y-npc.y)) > 3) {
      if (!s.me.walking) await act(page, 'walk_to', { x:npc.x,y:npc.y });
      return false;
    }
    return true;
  }
  async function tick(s) {
    if (s.me.dead || s.attackers?.length || s.unseenAttackers) return false;
    if (Date.now() < g.retryAt || s.me.zeny < g.funding) return false;
    const targets = gearTargets(s);
    if (targets.length !== 5) return false;
    if (g.active && g.target && !targets.some(t => t.id === g.target.id)) return fail(s,'job/level changed; reselect usable gear');
    if (g.stage !== 'idle' && g.stage !== 'complete' && Date.now()-g.at > 180000) return fail(s, 'stage timeout; will retry from observed inventory');
    try {
      if (g.stage==='idle' && s.shop?.stage==='barter') { await act(page,'barter_close'); return true; }
      // Arrival scripts (e.g. Geffen's messenger) can hold the character in
      // conversation and reject all walking. Release them before starting a service.
      if (['idle','choose','storage','buy_travel','smelt_travel','refine_travel'].includes(g.stage) &&
          !storage.active && !travel.inDialog && s.dialog && ['next','close','menu'].includes(s.dialog.state)) {
        const name=s.dialog.state==='next'?'npc_next':s.dialog.state==='menu'?'npc_menu':'npc_close';
        await act(page,name,{naid:s.dialog.naid,...(name==='npc_menu'?{num:255}:{})});
        return true;
      }
      if (g.stage === 'idle' || g.stage === 'complete') {
        g.target = targets.find(t => { const i = owned(s,t.id); return !i?.equipped || (i.gear?.refine ?? 0) < 7; });
        if (!g.target) { g.active=false; if (g.stage !== 'complete') { stage('complete'); report(s,'อุปกรณ์เป้าหมาย +7 ใส่ครบแล้ว'); } return false; }
        g.funding = 0;
        g.active = true;
        stage(g.auditDone ? 'choose' : 'storage'); report(s,'เริ่มเป้าหมายอุปกรณ์ NPC +7');
      }
      if (g.stage === 'storage') {
        if (storage.active) {
          const done = await storage.tick(s);
          if (done) { if (!done.ok) return fail(s,done.note); g.auditDone=true; stage('choose'); }
          return true;
        }
        const requests = [...targets.map(t=>({id:t.id,count:1})), ...gearReference.materials.filter(m=>[984,985,756,757,7619,7620].includes(m.id)).map(m=>({id:m.id,count:[756,757].includes(m.id)?100:25}))];
        if (storage.maybeStart(s, requests)) return true;
        if (!await reach(s,{map:'morocc',x:160,y:94})) return true;
        return true;
      }
      if (g.stage === 'choose') {
        const item = owned(s,g.target.id);
        if (!item) {
          g.purchase = { id:g.target.id, name:g.target.name, shop:g.target.shop, limit:g.target.shop.price };
          stage('buy_travel');
        } else if (!item.gear?.identified) return fail(s,'target must be identified before refining');
        else if (item.gear.damaged) return fail(s,'target is damaged; repair before refining');
        else if (!item.equipped && item.gear.refine < 7) {
          await act(page,'equip',{index:item.index,loc:LOC[g.target.slot]}); stage('prepare_equip_wait');
        }
        else if (item.gear.refine >= 7) stage('equip');
        else {
          const weapon = g.target.slot==='weapon';
          const normal = weapon?984:985, enriched = weapon?7620:7619, rough = weapon?756:757;
          if (!count(s,normal) && !count(s,enriched) && count(s,rough)<5 &&
              readGearStorage()?.items.some(i => [normal,enriched,rough].includes(i.ITID) && i.count>0)) {
            g.auditDone=false; stage('storage'); return true;
          }
          if (!count(s,normal) && !count(s,enriched) && count(s,rough)>=5) { g.smelt=weapon?'Make Oridecon':'Make Elunium'; stage('smelt_travel'); }
          else if (!count(s,normal) && !count(s,enriched)) {
            g.purchase={id:enriched,name:weapon?'Enriched Oridecon':'Enriched Elunium',limit:300000,shop:{map:'morocc',x:154,y:109,name:'Craft Supply Dealer'},menu:'Refine ores'};
            stage('buy_travel');
          } else stage('refine_travel');
        }
        return true;
      }
      if (g.stage === 'buy_travel') {
        if (count(s,g.purchase.id)>0) { stage('choose'); return true; }
        if (!await reach(s,g.purchase.shop)) return true;
        const npc=findNpcEntity(s,g.purchase.shop);
        if (!npc) return fail(s,'shop NPC not found');
        if (g.purchase.menu) await dialog.start(npc,strictChooser('ซื้อแร่ตี +7',g.purchase.menu));
        else await act(page,'talk',{GID:npc.GID});
        stage('buy_open'); return true;
      }
      if (g.stage === 'buy_open') {
        if (s.shop?.stage==='select') { await act(page,'deal',{naid:s.shop.naid,type:0}); return true; }
        if (s.shop?.stage!=='buy') { if (g.purchase.menu) await dialog.tick(s); return true; }
        const offer=s.shop.list.find(i=>i.ITID===g.purchase.id);
        if (!offer || !(offer.price>0) || offer.price>g.purchase.limit) return fail(s,'NPC quote missing or higher than researched price');
        if (count(s,g.purchase.id)>0) { await act(page,'close_shop'); stage('choose'); return true; }
        const nextFee=g.purchase.menu?(g.target.slot==='weapon'?20000:2000):0;
        if (s.me.zeny-offer.price-nextFee<RESERVE) return fund(s,offer.price+nextFee);
        g.before=count(s,g.purchase.id);
        await act(page,'buy',{items:[{ITID:g.purchase.id,count:1}]});
        stage('buy_wait'); report(s,'ซื้อหนึ่งชิ้นตามราคาหน้าร้าน '+offer.price); return true;
      }
      if (g.stage === 'buy_wait') {
        if (count(s,g.purchase.id)>g.before) { await act(page,'close_shop'); stage('choose'); }
        else if (Date.now()-g.at>8000) return fail(s,'purchase not confirmed');
        return true;
      }
      if (g.stage === 'smelt_travel') {
        const npc=gearReference.smelt.npc;
        if (!await reach(s,npc)) return true;
        const ent=findNpcEntity(s,npc); if (!ent) return fail(s,'smelting NPC not found');
        const chooser=strictChooser('แปลง rough 5 ชิ้นเป็นแร่ 1 ชิ้น',g.smelt);
        const choose=chooser.rules;
        chooser.rules=options=>choose(options)||strictChooser('เปิดร้านแปลง rough','View advanced smelting ores').rules(options)||strictChooser('เปิดเมนูแปลง rough','Purify Rough Ores').rules(options);
        g.smeltBefore=count(s,g.smelt==='Make Oridecon'?984:985);
        await dialog.start(ent,chooser);
        stage('smelt_dialog'); return true;
      }
      if (g.stage === 'smelt_dialog' || g.stage === 'smelt_shop_wait') {
        if (s.shop?.stage==='barter') {
          const id=g.smelt==='Make Oridecon'?984:985;
          const offer=s.shop.list.find(i=>i.ITID===id);
          if (!offer) return fail(s,'rough exchange missing from server list');
          g.smeltCount=Math.floor(count(s,id===984?756:757)/5);
          const ok=await act(page,'barter_smelt',{ITID:id,shopIndex:offer.index,quoteAt:s.shop.at,count:g.smeltCount});
          if (ok===false) return fail(s,'server rough exchange does not match verified free 5:1 recipe');
          stage('smelt_wait'); return true;
        }
        if (g.stage==='smelt_shop_wait') {
          if (Date.now()-g.at>8000) return fail(s,'smelting shop did not open');
          return true;
        }
        const done=await dialog.tick(s);
        if (done) {
          if (!done.ok) return fail(s,done.reason);
          if (count(s,g.smelt==='Make Oridecon'?984:985)<=g.smeltBefore) { stage('smelt_shop_wait'); return true; }
          stage(count(s,g.smelt==='Make Oridecon'?756:757)>=5?'smelt_travel':'choose');
        }
        return true;
      }
      if (g.stage === 'smelt_wait') {
        if (count(s,g.smelt==='Make Oridecon'?984:985)>=g.smeltBefore+g.smeltCount) {
          await act(page,'barter_close'); report(s,'แปลงแร่สำเร็จ '+g.smeltCount+' ชิ้น'); stage('choose');
        } else if (Date.now()-g.at>8000) return fail(s,'barter result not confirmed');
        return true;
      }
      if (g.stage === 'refine_travel') {
        if (s.me.zeny-RESERVE < (g.target.slot==='weapon'?20000:2000)) return fund(s,g.target.slot==='weapon'?20000:2000);
        if (s.refine?.open) { stage('refine_select'); return true; }
        const npc=gearReference.refiners[0];
        if (!await reach(s,npc)) return true;
        const ent=findNpcEntity(s,npc); if (!ent) return fail(s,'refiner NPC not found');
        await dialog.start(ent,strictChooser('เปิดหน้าต่างตีบวก +7',''));
        stage('refine_open'); return true;
      }
      if (g.stage === 'refine_open') {
        if (s.refine?.open) stage('refine_select');
        else await dialog.tick(s);
        return true;
      }
      if (g.stage === 'refine_select') {
        const item=owned(s,g.target.id); if (!item) return fail(s,'refine target not found; do not buy a replacement');
        if (item.gear.refine>=7) { await act(page,'refine_close'); stage('equip'); return true; }
        if (item.equipped) {
          if (await act(page,'unequip',{index:item.index,ITID:item.ITID}) !== false) stage('refine_unequip_wait');
          return true;
        }
        g.index=item.index;
        if (await act(page,'refine_select',{index:item.index}) !== false) stage('refine_quote');
        return true;
      }
      if (g.stage === 'refine_unequip_wait') {
        const item=owned(s,g.target.id);
        if (item && !item.equipped) stage('refine_select');
        else if (Date.now()-g.at>10000) return fail(s,'unequip not confirmed; no refine request sent');
        return true;
      }
      if (g.stage === 'refine_quote') {
        const quote=s.refine;
        if (!quote?.materials || quote.index!==g.index) return true;
        const choices=quote.materials.filter(m=>[984,985,7619,7620].includes(m.itemId)&&m.chance>0&&count(s,m.itemId)>0)
          .sort((a,b)=>((a.zeny+([7619,7620].includes(a.itemId)?300000:0))/a.chance)-((b.zeny+([7619,7620].includes(b.itemId)?300000:0))/b.chance));
        if (!choices.length) { await act(page,'refine_close'); stage('choose'); return true; }
        const m=choices[0]; if (s.me.zeny-m.zeny<RESERVE) return fund(s,m.zeny);
        g.resultAt=quote.resultAt||0;
        const sent=await act(page,'refine_attempt',{index:g.index,ITID:g.target.id,material:m.itemId,quoteAt:quote.at});
        if (sent===false) { stage('refine_select'); return true; }
        stage('refine_wait'); report(s,`ตีหนึ่งครั้ง material=${m.itemId} fee=${m.zeny} chance=${m.chance}%`); return true;
      }
      if (g.stage === 'refine_wait') {
        if (s.refine?.resultAt>g.resultAt) { stage('refine_select'); report(s,'ผลตีบวก '+s.refine.result+' ระดับ '+s.refine.level); }
        else if (Date.now()-g.at>10000) return fail(s,'refine result not confirmed; recheck item before retry');
        return true;
      }
      if (g.stage === 'equip') {
        const item=owned(s,g.target.id); if (!item) return fail(s,'target missing before equip');
        if (item.equipped) { stage('idle'); return true; }
        await act(page,'equip',{index:item.index,loc:LOC[g.target.slot]}); stage('equip_wait'); return true;
      }
      if (g.stage === 'equip_wait') {
        if (s.worn?.some(i=>i.ITID===g.target.id&&i.refine>=7)) { report(s,'ยืนยัน +7 ใน Equipment'); stage('idle'); }
        else if (Date.now()-g.at>5000) return fail(s,'equip was not confirmed');
        return true;
      }
      if (g.stage === 'prepare_equip_wait') {
        if (s.worn?.some(i=>i.ITID===g.target.id)) stage('choose');
        else if (Date.now()-g.at>5000) return fail(s,'current job cannot equip target or server refused');
        return true;
      }
      if (g.stage === 'fund_equip_wait') {
        if (s.worn?.some(i=>i.ITID===g.target.id)) {
          g.funding=g.pendingFunding;
          await release(s); stage('idle'); report(s,'ใส่อุปกรณ์กลับแล้ว หาเงินก่อนตีบวกต่อ');
          return false;
        }
        if (Date.now()-g.at>5000) return fail(s,'cannot confirm equipment before farming');
        return true;
      }
      return false;
    } catch(err) { return fail(s,err.message); }
  }
  return { tick, get active(){return g.active;}, needsMoney: s => g.funding > s.me.zeny };
}
