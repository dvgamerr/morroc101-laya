import { readFileSync, writeFileSync } from 'node:fs';
import { POTIONS, SP_POTIONS, healRange, spRange, stockHp, stockSp } from './potions.js';
import * as laya from './laya.js';
import { log } from './logger.js';
import { POCKET_MONEY, LOW_REFILLS, TARGET_REFILLS, SP_STOCK_REFILLS, SP_LOW_REFILLS, SPEND_SHARE, EMERGENCY_SPEND_SHARE, WEIGHT_SHARE, EMERGENCY_WEIGHT_SHARE, EMERGENCY_HP_REFILLS, EMERGENCY_SP_REFILLS, HP_TRIP_MINUTES, SP_TRIP_MINUTES } from './supply.js';

export { SP_STOCK_REFILLS, SP_LOW_REFILLS };
const SP_SPLIT = 0.6; // share of money and room kept for the HP item while SP is still short
const FILE = 'logs/potion-selection.json';
const known = [...POTIONS, ...SP_POTIONS,
  { ITID: 518, name: 'Honey', weight: 100 }, { ITID: 526, name: 'Royal Jelly', weight: 150 },
  { ITID: 569, name: 'Novice Potion', weight: 10 }, { ITID: 507, name: 'Red Herb', weight: 30 },
  { ITID: 508, name: 'Yellow Herb', weight: 50 }, { ITID: 509, name: 'White Herb', weight: 70 },
  { ITID: 510, name: 'Blue Herb', weight: 70 },
  { ITID: 545, name: 'Condensed Red Potion', weight: 20 }, { ITID: 546, name: 'Condensed Yellow Potion', weight: 30 },
  { ITID: 547, name: 'Condensed White Potion', weight: 50 },
];
export const isHealing = (i) => !!(healRange(i.ITID) || spRange(i.ITID));
const countOf = (snap, id) => snap.inventory.filter((i) => i.ITID === id).reduce((n, i) => n + i.count, 0);
const valid = (s) => s && (s.hp != null || s.sp != null) &&
  (s.hp == null || (Number.isInteger(s.hp) && healRange(s.hp))) &&
  (s.sp == null || (Number.isInteger(s.sp) && spRange(s.sp))) &&
  (s.hp === s.sp || (!spRange(s.hp) && !healRange(s.sp)));

/**
 * An item we only hold (no shop offer or not affordable) counts as a loadout candidate when it is a real
 * stock: one Honey picked up off a monster must not become "the loadout" and get the Red Potions sold.
 */
const worthCarrying = (snap, p) => p.count > 0 && (p.price > 0 || (p.hp || 0) * p.count >= (snap.me.maxHp || 0) || (p.sp || 0) * p.count >= (snap.me.maxSp || 0));

/** One HP + one SP type, or exactly one dual-purpose type. LAYA picks the loadout. */
export function createPotionLoadout() {
  let selection = null;
  if (process.env.NODE_ENV !== 'test') try {
    const saved = JSON.parse(readFileSync(FILE, 'utf8'));
    if (valid(saved)) selection = saved;
  } catch {}
  function options(snap, list) {
    const ids = new Set([...snap.inventory.map((i) => i.ITID), ...list.map((i) => i.ITID)]);
    return [...ids].map((ITID) => {
      const item = snap.inventory.find((i) => i.ITID === ITID);
      const k = known.find((i) => i.ITID === ITID);
      const offer = list.find((i) => i.ITID === ITID && i.price > 0 && (i.stock == null || i.stock > 0));
      return { ITID, name: item?.name || k?.name || String(ITID), hp: stockHp([{ ITID, count: 1 }], snap.me), sp: stockSp([{ ITID, count: 1 }]), weight: k?.weight ?? item?.weight, count: countOf(snap, ITID), price: offer?.price ?? null, stock: offer?.stock ?? null };
    }).filter((p) => (p.hp || p.sp) && (worthCarrying(snap, p) || (p.price > 0 && p.price <= Math.max(0, snap.me.zeny - POCKET_MONEY))) && p.weight > 0);
  }
  async function choose(snap, list, dps, rates) {
    const potions = options(snap, list);
    let pairs = [];
    for (const p of potions.filter((p) => p.hp && p.sp)) pairs.push({ hp: p.ITID, sp: p.ITID });
    for (const hp of potions.filter((p) => p.hp && !p.sp)) for (const sp of potions.filter((p) => p.sp && !p.hp)) pairs.push({ hp: hp.ITID, sp: sp.ITID });
    if (!potions.some((p) => p.sp)) for (const hp of potions.filter((p) => p.hp)) pairs.push({ hp: hp.ITID, sp: null });
    if (!potions.some((p) => p.hp)) for (const sp of potions.filter((p) => p.sp)) pairs.push({ hp: null, sp: sp.ITID });
    if (!pairs.length) return null;
    // Never offer LAYA a weaker loadout when another restores at least as
    // much of both resources per item. Compare strength, not stack totals.
    const power = pair => ({ hp: potions.find(p => p.ITID === pair.hp)?.hp || 0, sp: potions.find(p => p.ITID === pair.sp)?.sp || 0 });
    const kinds = pair => new Set([pair.hp, pair.sp].filter(id => id != null)).size;
    pairs = pairs.filter(pair => {
      const a = power(pair);
      return !pairs.some(other => {
        const b = power(other);
        return b.hp >= a.hp && b.sp >= a.sp &&
          (b.hp > a.hp || b.sp > a.sp || kinds(other) < kinds(pair));
      });
    });
    try {
      const answer = await laya.choose({ character: snap.me, incomingDps: dps, usePerMinute: rates, combatPolicy: "normal attack for 3 seconds, then damage skills; prepare extra SP", potions, current: selection },
        'Choose a practical healing loadout: exactly one HP type and one SP type, OR one dual HP/SP type alone. Keep the strongest restoration per item; sell the weakest HP/SP items first, not the smallest stacks or cheapest items. Weaker dominated loadouts have already been excluded. For equally strong choices use stock, weight and price; for dual-resource tradeoffs compare BOTH HP and SP. Avoid an unbuyable item with too little stock for the trip. Unselected healing items will be sold only after selected replacements are present.',
        Object.fromEntries(pairs.map((p, i) => [`loadout_${i}`, JSON.stringify(p)])));
      const index = pairs.findIndex((_, i) => answer?.choice === `loadout_${i}`);
      // These are already constrained valid loadouts. A fixed 70% softmax cutoff
      // rejects legitimate winners when there are many HP/SP combinations.
      if (index >= 0) {
        selection = pairs[index];
        if (process.env.NODE_ENV !== 'test') try { writeFileSync(FILE, JSON.stringify(selection)); } catch {}
        log('potion_loadout', { ...selection, confidence: answer.confidence ?? answer.answer_confidence });
      }
    } catch (err) { log('potion_loadout_error', { error: err.message }); }
    return pairs.some((p) => p.hp === selection?.hp && p.sp === selection?.sp) ? selection : null;
  }
  function ready(snap, chosen = selection) {
    return valid(chosen) && (chosen.hp == null || countOf(snap, chosen.hp) > 0) && (chosen.sp == null || countOf(snap, chosen.sp) > 0);
  }
  function surplus(snap, chosen = selection) {
    if (!ready(snap, chosen)) return [];
    // The weaker bottles are drunk too (reflex): they only go once the selected ones cover the stock we aim for
    // by themselves, never as soon as one replacement bottle is in the bag.
    const have = (id) => id == null ? 0 : stockHp([{ ITID: id, count: countOf(snap, id) }], snap.me);
    const haveSp = (id) => id == null ? 0 : stockSp([{ ITID: id, count: countOf(snap, id) }]);
    if (chosen.hp != null && have(chosen.hp) < (snap.me.maxHp || 0) * TARGET_REFILLS) return [];
    if (chosen.sp != null && snap.me.maxSp > 0 && haveSp(chosen.sp) < snap.me.maxSp * SP_STOCK_REFILLS) return [];
    const hp = stockHp([{ ITID: chosen.hp, count: 1 }], snap.me);
    const sp = stockSp([{ ITID: chosen.sp, count: 1 }]);
    const strength = i => ({ hp: stockHp([{ ITID: i.ITID, count: 1 }], snap.me), sp: stockSp([{ ITID: i.ITID, count: 1 }]) });
    const relative = i => { const p = strength(i); return Math.max(p.hp && hp ? p.hp / hp : 0, p.sp && sp ? p.sp / sp : 0); };
    return snap.inventory.filter((i) => {
      const p = strength(i);
      return i.count > 0 && !i.keep && !i.equipped && isHealing(i) &&
        i.ITID !== chosen.hp && i.ITID !== chosen.sp &&
        (!p.hp || (chosen.hp != null && p.hp <= hp)) &&
        (!p.sp || (chosen.sp != null && p.sp <= sp));
    }).sort((a, b) => relative(a) - relative(b) || a.ITID - b.ITID);
  }
  function purchase(snap, list, rates, chosen = selection, reservedZeny = 0, emergency = false) {
    if (!valid(chosen)) return [];
    const catalog = options(snap, list);
    let budget = Math.max(0, Math.min(snap.me.zeny - POCKET_MONEY, snap.me.zeny * (emergency ? EMERGENCY_SPEND_SHARE : SPEND_SHARE)) - reservedZeny);
    let room = snap.me.maxWeight ? Math.max(0, snap.me.maxWeight * (emergency ? EMERGENCY_WEIGHT_SHARE : WEIGHT_SHARE) - snap.me.weight) : 0;
    const out = [];
    for (const id of new Set([chosen.hp, chosen.sp])) {
      const p = catalog.find((p) => p.ITID === id && p.price > 0);
      if (!p) continue;
      const hpTarget = emergency ? (snap.me.maxHp || 0) * EMERGENCY_HP_REFILLS : Math.max((rates?.hp || 0) * HP_TRIP_MINUTES, (snap.me.maxHp || 0) * TARGET_REFILLS);
      const spTarget = emergency ? (snap.me.maxSp || 0) * EMERGENCY_SP_REFILLS : Math.max((rates?.sp || 0) * SP_TRIP_MINUTES, (snap.me.maxSp || 0) * SP_STOCK_REFILLS);
      const target = Math.max(id === chosen.hp ? Math.ceil(hpTarget / p.hp) : 0, id === chosen.sp ? Math.ceil(spTarget / p.sp) : 0);
      const spItem = catalog.find(p => p.ITID === chosen.sp && p.price > 0);
      const reserveSp = id === chosen.hp && chosen.hp !== chosen.sp && spItem && spItem.count * spItem.sp < spTarget;
      const spend = reserveSp ? budget * SP_SPLIT : budget;
      const weightRoom = reserveSp ? room * SP_SPLIT : room;
      const count = Math.max(0, Math.floor(Math.min(target - p.count, spend / p.price, weightRoom / p.weight, p.stock ?? Infinity)));
      if (!count) continue;
      out.push({ ITID: id, name: p.name, count, weight: p.weight });
      budget -= count * p.price;
      room -= count * p.weight;
    }
    return out;
  }
  return { choose, ready, surplus, purchase, get selection() { return selection; } };
}
