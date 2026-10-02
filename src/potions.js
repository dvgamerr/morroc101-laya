/**
 * HP potions and the arithmetic for choosing one: does it heal faster than we
 * are being hurt, how much of each bottle is wasted on overheal, and what each
 * point of HP actually healed costs in zeny and weight.
 *
 * Heal ranges are Renewal NPC potions; weight in client units (x10); price is the
 * usual NPC price, replaced by the shop's real price when the list is open.
 */
export const POTIONS = [
  { ITID: 501, name: 'Red Potion', heal: [45, 65], price: 50, weight: 70 },
  { ITID: 502, name: 'Orange Potion', heal: [105, 145], price: 200, weight: 100 },
  { ITID: 503, name: 'Yellow Potion', heal: [175, 235], price: 550, weight: 130 },
  { ITID: 504, name: 'White Potion', heal: [325, 405], price: 1200, weight: 150 },
];

// Not for sale but worth drinking: Novice Potion, herbs, the condensed ones.
const OTHER_HEALS = {
  518: [70, 100], 526: [325, 405],
  569: [45, 65], 507: [18, 30], 508: [38, 58], 509: [75, 115], 545: [45, 65], 546: [175, 235], 547: [325, 405],
  512: [16, 18], 513: [17, 21], 515: [18, 20], 516: [15, 17],
};

/** SP potions the Tool Dealer sells (SP restored range; price = usual NPC price). */
export const SP_POTIONS = [{ ITID: 505, name: 'Blue Potion', sp: [40, 60], price: 5000, weight: 150 }];
const SP_RANGE = { 505: [40, 60], 510: [15, 30], 518: [20, 40], 526: [40, 60], 11502: [40, 60], 11503: [100, 150] };
export const spRange = (id) => SP_RANGE[id] || null;

/** Total SP the SP items in the bag can give back. */
export function stockSp(inv) {
  return (inv || []).reduce((sum, i) => {
    const r = i.count > 0 && SP_RANGE[i.ITID];
    return r ? sum + (i.count * (r[0] + r[1])) / 2 : sum;
  }, 0);
}

/** One potion every this many ms (the reflex enforces it). Owner: pump HP faster (was 800). */
export const POTION_GAP_MS = 400;
/** The reflex drinks below this share of max HP by default, so up to this much is missing. */
const DRINK_AT = 0.45;
/**
 * Potions must heal this many times faster than the enemies hit (p90). At 1.25x the
 * character drank ~80% of the time and barely fought; at 2.5x drinking takes at most
 * ~40% of the time and the rest goes to killing.
 */
export const KEEP_UP = 2.5;

const avg = ([lo, hi]) => (lo + hi) / 2;
export const healRange = (itid) => POTIONS.find((p) => p.ITID === itid)?.heal || OTHER_HEALS[itid] || null;

/** Average HP one bottle gives this character: VIT adds 2% per point to potion healing. */
export function healOf(potion, me) {
  return avg(potion.heal) * (1 + ((me.stats && me.stats.vit) || 0) * 0.02);
}

/** Total HP the healing items in the bag can give back (what matters, not the bottle count). */
export function stockHp(inv, me) {
  const vit = 1 + ((me.stats && me.stats.vit) || 0) * 0.02;
  return (inv || []).reduce((sum, i) => {
    const r = i.count > 0 && healRange(i.ITID);
    return r ? sum + i.count * avg(r) * vit : sum;
  }, 0);
}

/** The fastest healing the bottles we carry can give (HP/s), 0 with none. */
export function bagHps(inv, me) {
  const vit = 1 + ((me.stats && me.stats.vit) || 0) * 0.02;
  let best = 0;
  for (const i of inv || []) {
    const r = i.count > 0 && healRange(i.ITID);
    if (r) best = Math.max(best, (avg(r) * vit) / (POTION_GAP_MS / 1000));
  }
  return best;
}

/** HP per second when drinking back to back. */
export const hpsOf = (potion, me) => healOf(potion, me) / (POTION_GAP_MS / 1000);

/** The part of a bottle that lands, given it's drunk at DRINK_AT of max HP. */
// A heal under this share of max HP isn't worth a bottle's turn: not bought while a stronger
// one is affordable, and sold off (errand.js) once the stronger ones cover the bag.
export const WEAK_HEAL_SHARE = 0.025;

export function usefulHeal(potion, me) {
  const missing = (me.maxHp || Infinity) * (1 - DRINK_AT);
  return Math.min(healOf(potion, me), missing);
}

/**
 * Which potion to buy.
 *
 *  need   = worst damage per second seen while fighting (p90) x SAFETY; with no
 *           fight data yet, 5% of max HP per second.
 *  fits   = potions that heal at least `need` per second.
 *  choice = among those, the cheapest per HP that actually lands (overheal is
 *           waste), counting weight as a tie-breaker; the budget must buy >= minBuy.
 *
 * When nothing in budget keeps up, it returns the strongest affordable one with
 * outpaced = true: the hunting ground hurts more than potions can mend, which is a
 * reason to hunt somewhere easier rather than to buy more.
 */
export function choosePotion({ me, dps = null, budget = Infinity, prices = null, minBuy = 10 }) {
  const need = (dps && dps > 0 ? dps : (me.maxHp || 100) * 0.05) * KEEP_UP;
  const offered = POTIONS.map((p) => ({ ...p, price: prices ? prices[p.ITID] : p.price })).filter((p) => p.price > 0);
  const canPay = offered.filter((p) => budget >= p.price * minBuy);
  const strong = canPay.filter((p) => healOf(p, me) >= (me.maxHp || 0) * WEAK_HEAL_SHARE);
  const affordable = strong.length ? strong : canPay;
  if (!affordable.length) return { potion: null, need, outpaced: false, reason: 'งบไม่พอซื้อยา' };

  const scored = affordable.map((p) => {
    const useful = usefulHeal(p, me);
    return { p, hps: hpsOf(p, me), zenyPerHp: p.price / useful, weightPerHp: p.weight / useful };
  });
  const fits = scored.filter((s) => s.hps >= need);
  if (fits.length) {
    fits.sort((a, b) => a.zenyPerHp - b.zenyPerHp || a.weightPerHp - b.weightPerHp);
    const best = fits[0];
    return {
      potion: best.p,
      need,
      hps: best.hps,
      outpaced: false,
      reason: `${best.p.name}: ฟื้น ${Math.round(best.hps)} HP/วิ ≥ ต้องการ ${Math.round(need)} · ${best.zenyPerHp.toFixed(2)} z/HP`,
    };
  }
  const strongest = scored.sort((a, b) => b.hps - a.hps)[0];
  return {
    potion: strongest.p,
    need,
    hps: strongest.hps,
    outpaced: true,
    reason: `ยาที่แรงสุดที่ซื้อได้ (${strongest.p.name} ${Math.round(strongest.hps)} HP/วิ) ไม่ทันดาเมจ ${Math.round(need)} HP/วิ`,
  };
}

/**
 * Which bottle to drink from what's in the bag: the biggest heal that doesn't
 * overshoot what's missing (no waste), or — when even the smallest overshoots —
 * the smallest. In an emergency (below `emergencyPct`) the biggest, full stop.
 */
export function pickBottle(inv, me, emergencyPct = 0.25) {
  const bottles = inv.filter((i) => i.count > 0 && healRange(i.ITID)).map((i) => ({ item: i, heal: avg(healRange(i.ITID)) * (1 + ((me.stats && me.stats.vit) || 0) * 0.02) }));
  if (!bottles.length) return null;
  const missing = (me.maxHp || 0) - (me.hp || 0);
  if (me.maxHp && me.hp / me.maxHp < emergencyPct) return bottles.sort((a, b) => b.heal - a.heal)[0].item;
  const under = bottles.filter((b) => b.heal <= missing).sort((a, b) => b.heal - a.heal);
  return (under[0] || bottles.sort((a, b) => a.heal - b.heal)[0]).item;
}

/**
 * Damage taken per second while fighting, sampled every tick; p90 is "a bad
 * stretch" without being one freak crit.
 */
export function createDamageTracker(size = 300) {
  const samples = [];
  return {
    sample(snap) {
      if (!snap.attackers || !snap.attackers.length) return;
      samples.push(snap.damageTaken6s / 6);
      if (samples.length > size) samples.shift();
    },
    p90() {
      if (samples.length < 20) return null; // not enough fighting seen yet
      const sorted = [...samples].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.9)];
    },
    reset() {
      samples.length = 0;
    },
  };
}

/** Comfortable by this margin over KEEP_UP, with almost no time spent drinking: the monsters are too weak for us. */
export const EASY_MARGIN = 1.5;
export const EASY_DRINK_SHARE = 0.1;
export const tooEasy = ({ dps, carried, drinkShare }) =>
  dps !== null && dps !== undefined && carried >= dps * KEEP_UP * EASY_MARGIN && drinkShare < EASY_DRINK_SHARE;
