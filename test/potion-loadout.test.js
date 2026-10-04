import { test, expect, mock } from 'bun:test';

process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';
mock.module('../src/logger.js', () => ({ log: () => {} }));
let offered = null;
let pick = (pairs) => pairs[0];
mock.module('../src/laya.js', () => ({
  choose: async (_state, _instructions, options) => {
    offered = Object.values(options).map((v) => JSON.parse(v));
    const chosen = pick(offered);
    return { choice: `loadout_${offered.indexOf(chosen)}`, confidence: 0.9 };
  },
  ask: async () => ({}),
}));
const { createPotionLoadout } = await import('../src/potion-loadout.js');

const me = { zeny: 20000, maxHp: 2000, hp: 2000, maxSp: 300, sp: 300, weight: 1000, maxWeight: 20000, stats: {} };
const snap = (inventory, over = {}) => ({ me: { ...me, ...over }, inventory });
const RED = (count) => ({ index: 1, ITID: 501, name: 'Red Potion', count, type: 0 });
const WHITE = (count) => ({ index: 2, ITID: 504, name: 'White Potion', count, type: 0 });
const BLUE = (count) => ({ index: 3, ITID: 505, name: 'Blue Potion', count, type: 0 });

test('the weaker bottles are not sold the moment one stronger bottle is in the bag', async () => {
  const loadout = createPotionLoadout();
  const list = [{ ITID: 501, price: 50 }, { ITID: 504, price: 1200 }, { ITID: 505, price: 230 }];
  pick = (pairs) => pairs.find((p) => p.hp === 504 && p.sp === 505) || pairs[0];
  const bag = [RED(300), WHITE(2), BLUE(11)];
  const selection = await loadout.choose(snap(bag), list, null, null);
  expect(selection).toEqual({ hp: 504, sp: 505 });
  // 300 Red Potions are most of the HP we have: they stay until White covers the stock we aim for.
  expect(loadout.surplus(snap(bag), selection)).toEqual([]);
  // Plenty of White (well past 15 bars) and Blue (8 bars): now the Red Potions are surplus.
  const stocked = [RED(300), WHITE(120), BLUE(60)];
  expect(loadout.surplus(snap(stocked), selection).map((i) => i.ITID)).toEqual([501]);
});

test('one Honey picked up off a monster is not "the loadout": the Red Potions are not sold for it', async () => {
  const loadout = createPotionLoadout();
  pick = (pairs) => pairs[0];
  const bag = [RED(300), { index: 4, ITID: 518, name: 'Honey', count: 1, type: 0 }];
  await loadout.choose(snap(bag), [], null, null);
  expect(offered.every((p) => p.hp !== 518 && p.sp !== 518)).toBe(true);
  expect(offered).toContainEqual({ hp: 501, sp: null });
});

test('an emergency may fill up more of the bag than a normal visit (a short bag is worse than a heavy one)', async () => {
  const heavy = { weight: 8000, maxWeight: 20000, zeny: 200000 }; // 40% full: under 45%, over 45% once potions are in
  const list = [{ ITID: 501, price: 50 }];
  const normal = createPotionLoadout();
  pick = (pairs) => pairs[0];
  const selected = await normal.choose(snap([], heavy), list, null, null);
  const bought = (loadout, emergency) => loadout.purchase(snap([], heavy), list, null, selected, 0, emergency).reduce((n, i) => n + i.count, 0);
  expect(bought(normal, true)).toBeGreaterThan(0);
  const room = (share) => Math.floor((20000 * share - 8000) / 70);
  expect(bought(normal, false)).toBeLessThanOrEqual(room(0.45));
  expect(bought(normal, true)).toBeLessThanOrEqual(room(0.7));
});
