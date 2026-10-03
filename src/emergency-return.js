import { act, snapshot, holdCombatForEscape } from './browser.js';
import { choose } from './laya.js';
import { healRange, healOf, POTION_GAP_MS } from './potions.js';
import { log } from './logger.js';

// Owner confirmed: no automatic @go for rapid damage; ask LAYA below 10% HP only.
export function createEmergencyReturn(page, inTown = map => map === 'morocc') {
  let nextAt = 0, busy = false;
  return async function emergencyReturn(snap) {
    if (busy) return true;
    const me = snap.me;
    if (me && !me.dead && me.maxWeight > 0 && me.weight / me.maxWeight >= 0.9 && !inTown(me.map)) {
      holdCombatForEscape();
      if (Date.now() < nextAt) return true;
      busy = true;
      try {
        if (snap.dialog && snap.dialog.state !== 'ended') await act(page, 'npc_close', {naid:snap.dialog.naid});
        if (me.sitting) await act(page, 'stand');
        await act(page, 'say', {text:'@go 1'});
        nextAt = Date.now() + 3000;
        log('overweight_return', {from:me.map, weight:me.weight, maxWeight:me.maxWeight, to:'morocc'});
        return true;
      } finally { busy = false; }
    }
    if (!me || me.dead || !me.maxHp || me.hp / me.maxHp >= 0.1) return false;
    if (Date.now() < nextAt) return true;
    const items = (snap.inventory || []).filter(i => i.count > 0 && i.index >= 0 && healRange(i.ITID))
      .map(i => ({ index:i.index, ITID:i.ITID, name:i.name, count:i.count,
        heal:healOf({heal:healRange(i.ITID)},me) })).sort((a,b) => b.heal-a.heal);
    const options = Object.fromEntries(items.map(i => ['heal_'+i.index, 'Use '+i.name+'; estimated HP +'+Math.round(i.heal)]));
    if (me.map !== 'morocc') options.escape = 'Escape to Morroc using @go 1';
    if (!Object.keys(options).length) return false;
    busy = true;
    holdCombatForEscape(600);
    try {
      let choice, source = 'laya';
      try {
        const answer = await choose({
          hp:me.hp, maxHp:me.maxHp, map:me.map, attackers:snap.attackers?.length || 0,
          damageTaken6s:snap.damageTaken6s || 0, items,
        }, 'HP is below 10%. Choose an available healing item or escape. Compare healing with incoming damage. No attack or walking.',
        options, {timeoutMs:350});
        choice = answer.choice;
      } catch (err) {
        log('emergency_laya_error', {error:err.message});
      }
      if (!Object.hasOwn(options,choice)) {
        choice = items.length ? 'heal_'+items[0].index : 'escape';
        source = 'fallback';
      }
      // Discard a stale decision if healing, death or a warp happened while awaiting LAYA.
      const fresh = await snapshot(page);
      if (!fresh?.inGame || !fresh.me || fresh.me.dead || fresh.me.map !== me.map ||
          fresh.me.hp / fresh.me.maxHp >= 0.1) return true;
      if (choice.startsWith('heal_')) {
        const selected = items.find(i => 'heal_'+i.index === choice);
        if (!(fresh.inventory || []).some(i => i.index === selected.index && i.ITID === selected.ITID && i.count > 0)) return true;
        await act(page, 'use_item', {index:selected.index});
        nextAt = Date.now() + POTION_GAP_MS;
        log('emergency_heal', {item:selected.name, hp:fresh.me.hp, maxHp:fresh.me.maxHp, source});
      } else {
        holdCombatForEscape();
        if (fresh.dialog && fresh.dialog.state !== 'ended') await act(page, 'npc_close', {naid:fresh.dialog.naid});
        if (fresh.me.sitting) await act(page, 'stand');
        await act(page, 'say', {text:'@go 1'});
        nextAt = Date.now() + 3000;
        log('emergency_go', {from:me.map, to:'morocc', hp:Math.round(fresh.me.hp/fresh.me.maxHp*100), source});
      }
      return true;
    } finally { busy = false; }
  };
}
