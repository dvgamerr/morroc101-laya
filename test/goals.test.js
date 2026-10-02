import { test, expect } from 'bun:test';
import { detectSignals, jobChangeReady, jobInfo, GOALS, GOAL_KEYS, zenyReserve } from '../src/goals.js';
import { nextStat } from '../src/build.js';

const me = (over = {}) => ({ jobId: 1, baseLevel: 30, jobLevel: 20, zeny: 50000, weight: 100, maxWeight: 1000, maxHp: 1000, skillPoints: 0, ...over });
// 30 White Potions ~ 11k HP: well above 4 bars of 1000 HP.
const stocked = [{ ITID: 504, count: 30, type: 0 }];

test('every goal from the system document is represented', () => {
  expect(GOAL_KEYS).toEqual(['level', 'money', 'build', 'job_change', 'sell', 'buy', 'gear', 'card_hunt', 'quest', 'rest']);
  for (const g of Object.values(GOALS)) expect(Boolean(g.label && g.when)).toBe(true);
});

test('no signals for a healthy, stocked character', () => {
  expect(detectSignals({ me: me(), inventory: stocked })).toEqual([]);
});

test('weight, potions, zeny, deaths and skill points raise the right goals', () => {
  const goals = (m, inv = stocked, o) => detectSignals({ me: me(m), inventory: inv }, o).map((s) => s.goal);
  expect(goals({ weight: 850 })).toEqual(['sell']);
  expect(goals({}, [])).toEqual(['buy']);
  expect(goals({ zeny: 100 }, [])).toEqual(['money']);
  expect(goals({ zeny: 100 })).toEqual(['money']);
  expect(goals({}, stocked, { recentDeaths: 2 })).toEqual(['rest']);
  expect(goals({ skillPoints: 3 })).toEqual(['build']);
});

test('job change readiness follows the standard requirements', () => {
  expect(jobChangeReady({ jobId: 0, baseLevel: 10, jobLevel: 10 })).toContain('อาชีพ 1');
  expect(jobChangeReady({ jobId: 1, baseLevel: 40, jobLevel: 39 })).toBe(null);
  expect(jobChangeReady({ jobId: 1, baseLevel: 40, jobLevel: 40 })).toContain('อาชีพ 2');
  expect(jobChangeReady({ jobId: 7, baseLevel: 98, jobLevel: 50 })).toBe(null);
  expect(jobChangeReady({ jobId: 4008, baseLevel: 99, jobLevel: 50 })).toContain('อาชีพ 3');
  expect(jobChangeReady({ jobId: 4054, baseLevel: 200, jobLevel: 70 })).toContain('อาชีพ 4');
  expect(jobInfo(4252).tier).toBe(4);
});

test('zeny reserve grows with level', () => {
  expect(zenyReserve(1)).toBe(2000);
  expect(zenyReserve(80)).toBe(40000);
});

test('stat build: next point goes to the stat furthest behind its share, within cost and cap', () => {
  const cost = { str: 2, agi: 2, vit: 2, int: 2, dex: 2, luk: 2 };
  const sword = { jobId: 1, baseLevel: 20, statusPoints: 10, stats: { str: 10, agi: 1, vit: 1, int: 1, dex: 1, luk: 1 }, statCost: cost };
  expect(nextStat(sword, null)).toBe('vit');
  expect(nextStat({ ...sword, stats: { ...sword.stats, vit: 7, agi: 5, dex: 5 } }, null)).toBe('str');
  expect(nextStat({ ...sword, statusPoints: 1 }, null)).toBe(null); // can't afford anything
  expect(nextStat({ ...sword, statusPoints: 0 }, null)).toBe(null);
  expect(nextStat({ ...sword, jobId: 2, stats: { str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1 } }, null)).toBe('int');
  // The owner's BUILD (axe_meister) wins over the job family: a Mage would still go STR.
  expect(nextStat({ ...sword, jobId: 2, stats: { str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1 } })).toBe('str');
});
