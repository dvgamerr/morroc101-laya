import { jobInfo } from './goals.js';
import { config } from './config.js';

/**
 * Stat builds for farming, per job family: relative weights of where points go.
 * Standard leveling builds — damage first, enough VIT/DEX to survive and hit.
 */
export const BUILDS = {
  novice: { str: 3, agi: 3, vit: 2, dex: 2 },
  sword: { str: 5, vit: 3, agi: 2, dex: 2 },
  mage: { int: 5, dex: 4, vit: 2 },
  archer: { dex: 6, agi: 3, vit: 1 },
  acolyte: { int: 4, vit: 3, dex: 3 },
  monk: { str: 5, agi: 3, vit: 2, dex: 1 },
  merchant: { str: 5, vit: 3, dex: 2 },
  alchemist: { str: 3, int: 3, dex: 3, vit: 2 },
  thief: { agi: 5, str: 4, dex: 1 },
  rogue: { str: 4, dex: 4, agi: 2 },
  gunner: { dex: 6, agi: 2, vit: 1 },
  ninja: { dex: 4, str: 3, agi: 2 },
  taekwon: { agi: 4, str: 3, vit: 2 },
  unknown: { str: 3, vit: 3, dex: 3, agi: 1 },
  // Owner's build: two-handed axe, Merchant -> ... -> Meister.
  axe_meister: { str: 6, dex: 3, vit: 3, agi: 2 },
};

/** The configured build (BUILD in .env) if it names one, else the job family's default. */
export function buildFor(jobId, buildKey = config.build) {
  return BUILDS[buildKey] || BUILDS[jobInfo(jobId).family] || BUILDS.unknown;
}

const STATS = ['str', 'agi', 'vit', 'int', 'dex', 'luk'];

/**
 * Which stat the next point goes to: the one furthest below its share of the
 * build, that we can afford and isn't capped. null when nothing to do.
 */
export function nextStat(me, buildKey = config.build) {
  const points = me.statusPoints || 0;
  if (points <= 0 || !me.stats || me.stats.str === undefined) return null;
  const weights = buildFor(me.jobId, buildKey);
  const cap = (me.baseLevel || 1) > 99 ? 130 : 99;
  let best = null;
  for (const stat of STATS) {
    const w = weights[stat] || 0;
    if (!w) continue;
    const value = me.stats[stat] || 1;
    const cost = (me.statCost || {})[stat] ?? 2;
    if (value >= cap || cost > points) continue;
    const share = (value - 1) / w; // lower = further behind its share
    // Ties (e.g. all still at 1) go to the stat the build weighs most.
    if (!best || share < best.share || (share === best.share && w > best.w)) best = { stat, share, w };
  }
  return best ? best.stat : null;
}
