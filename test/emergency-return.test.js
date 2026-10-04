import { test, expect, mock, beforeEach } from 'bun:test';

process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';
const calls = [];
mock.module('../src/browser.js', () => ({
  act: async (_p, n, a) => calls.push([n, a]), snapshot: async () => null, holdCombatForEscape: () => {},
}));
mock.module('../src/logger.js', () => ({ log: () => {} }));
const { createEmergencyReturn } = await import('../src/emergency-return.js');

beforeEach(() => (calls.length = 0));
const snap = (over = {}) => ({ me: { map: 'field', hp: 900, maxHp: 1000, weight: 950, maxWeight: 1000, ...over }, inventory: [] });

test('overweight outside town sends @go, then lets the loop run instead of freezing it', async () => {
  const back = createEmergencyReturn({}, () => false, () => true);
  expect(await back(snap())).toBe(true);
  expect(calls.map(([n]) => n)).toEqual(['say']);
  expect(await back(snap())).toBe(true); // the @go is in flight
});

test('overweight with @go unavailable does nothing and does not hold the bot', async () => {
  const back = createEmergencyReturn({}, () => false, () => false);
  expect(await back(snap())).toBe(false);
  expect(calls).toEqual([]);
});

test('overweight stops retrying @go on a map where it never works', async () => {
  const back = createEmergencyReturn({}, () => false, () => true);
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    for (let i = 0; i < 6; i++) { await back(snap()); now += 3100; }
  } finally { Date.now = realNow; }
  expect(calls.filter(([n]) => n === 'say').length).toBe(3);
});
