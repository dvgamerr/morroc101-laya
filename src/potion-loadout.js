import { readFileSync, writeFileSync } from 'node:fs';
import { POTIONS, SP_POTIONS, healRange, spRange, stockHp, stockSp } from './potions.js';
import * as laya from './laya.js';
import { log } from './logger.js';

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
    }).filter((p) => (p.hp || p.sp) && (p.count > 0 || (p.price > 0 && p.price <= Math.max(0, snap.me.zeny - 1000))) && p.weight > 0);
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
      const answer = await laya.choose({ character: snap.me, incomingDps: dps, usePerMinute: rates, potions, current: selection },
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
  function purchase(snap, list, rates, chosen = selection) {
    if (!valid(chosen)) return [];
    const catalog = options(snap, list);
    let budget = Math.max(0, Math.min(snap.me.zeny - 1000, snap.me.zeny * 0.6));
    let room = snap.me.maxWeight ? Math.max(0, snap.me.maxWeight * 0.45 - snap.me.weight) : 0;
    const out = [];
    for (const id of new Set([chosen.hp, chosen.sp])) {
      const p = catalog.find((p) => p.ITID === id && p.price > 0);
      if (!p) continue;
      const hpTarget = Math.max((rates?.hp || 0) * 20, (snap.me.maxHp || 0) * 15);
      const spTarget = Math.max((rates?.sp || 0) * 20, (snap.me.maxSp || 0) * 4);
      const target = Math.max(id === chosen.hp ? Math.ceil(hpTarget / p.hp) : 0, id === chosen.sp ? Math.ceil(spTarget / p.sp) : 0);
      const count = Math.max(0, Math.floor(Math.min(target - p.count, budget / p.price, room / p.weight, p.stock ?? Infinity)));
      if (!count) continue;
      out.push({ ITID: id, name: p.name, count, weight: p.weight });
      budget -= count * p.price;
      room -= count * p.weight;
    }
    return out;
  }
  return { choose, ready, surplus, purchase, get selection() { return selection; } };
}
