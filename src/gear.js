import { config } from './config.js';

// Names this class line goes by in item descriptions ("อาชีพที่ใช้ได้: ...").
const LINE_NAMES = ['merchant', 'blacksmith', 'whitesmith', 'mastersmith', 'mechanic', 'meister', 'genetic'];
// Wording for "anyone can wear it" (an empty jobs line means the same).
const EVERYONE = /(ทุกอาชีพ|every ?job|all ?jobs?|all classes)/i;
// The build (two-handed axe Meister): the only weapons worth keeping are axes.
const BUILD_WEAPON = /(axe|ขวาน)/i;
const WEAPON = 5;
const SHIELD_SLOT = 32; // a two-handed axe leaves no hand for a shield

/** Could this class line ever wear it (now or later on the path)? */
export function wearableByLine(gear, classPath = config.classPath) {
  const jobs = String(gear.jobs || '').toLowerCase();
  if (!jobs || EVERYONE.test(jobs)) return true;
  const names = new Set([...LINE_NAMES, ...classPath.map((c) => c.toLowerCase().replace(/^high /, ''))]);
  names.delete('novice');
  return [...names].some((n) => jobs.includes(n));
}

/** How good a piece is in its slot: Atk for weapons, Def for armour, plus its refine. */
const score = (g, type) => (type === WEAPON ? g.atk : g.def) + (g.refine || 0) * (type === WEAPON ? 5 : 1);

/**
 * Owner's rule for gear: sell what we will never wear (other classes, weapons outside the
 * axe build), and what we could wear but is no better than what we have on in that slot.
 * Kept: anything better than what's worn (or for an empty slot) — one of each — and
 * whatever the client's junk rules protect (refined, carded, signed: `keep`).
 * Without knowing what we wear, nothing is judged "worse": only never-wearable goes.
 * @returns {Set<number>} inventory indexes of gear to sell
 */
export function spareGear(inv, worn, classPath = config.classPath) {
  const sell = new Set();
  const keptBest = new Map(); // slot mask -> best kept score so far
  const gear = (inv || []).filter((i) => i.gear && !i.equipped && !i.keep);
  // Best first, so the one copy worth keeping is the strongest.
  gear.sort((a, b) => score(b.gear, b.type) - score(a.gear, a.type));
  for (const it of gear) {
    const g = it.gear;
    if (!wearableByLine(g, classPath) || (it.type === WEAPON && !BUILD_WEAPON.test(g.kind || '')) || (it.type !== WEAPON && g.loc === SHIELD_SLOT)) {
      sell.add(it.index);
      continue;
    }
    if (!worn) continue;
    const on = worn.find((w) => (w.loc & g.loc) !== 0);
    const mine = score(g, it.type);
    if (on && score(on, it.type) >= mine) {
      sell.add(it.index); // what we wear is at least as good
      continue;
    }
    const slot = g.loc;
    if (keptBest.has(slot) && keptBest.get(slot) >= mine) {
      sell.add(it.index); // a better (or equal) spare is already kept
      continue;
    }
    keptBest.set(slot, mine);
  }
  return sell;
}
