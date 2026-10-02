import { test, expect, mock, beforeEach } from 'bun:test';

process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';
const calls = [];
mock.module('../src/browser.js', () => ({ act: async (_p, n, a) => calls.push([n, a]), exploreTarget: async () => null, query: async () => [] }));
mock.module('../src/logger.js', () => ({ log: () => {} }));
const { createHotkeys, KEY_NAMES, ROWS } = await import('../src/hotkeys.js');

beforeEach(() => (calls.length = 0));

const book = { buffs: [111, 112], attack: [42, 153], aoe: [] };
const snap = {
  me: { skills: [{ id: 111, level: 5 }, { id: 112, level: 5 }, { id: 42, level: 10 }, { id: 153, level: 1 }] },
  inventory: [
    { index: 3, ITID: 501, count: 20 },
    { index: 4, ITID: 504, count: 5 },
    { index: 5, ITID: 505, count: 9 },
    { index: 6, ITID: 12323, count: 3 },
    { index: 7, ITID: 909, count: 50 },
  ],
};

test('layout: F1-F9 buffs, 1-9 attack skills, Q-O items (strongest potion on Q)', () => {
  const want = createHotkeys({}).layout(snap, book);
  const show = [...want].map(([slot, s]) => `${KEY_NAMES[slot]}=${s.isSkill ? 'skill' : 'item'}:${s.ID}`);
  expect(show).toEqual(['F1=skill:111', 'F2=skill:112', '1=skill:42', '2=skill:153', 'Q=item:504', 'W=item:501', 'E=item:505', 'R=item:12323']);
  expect(ROWS).toEqual({ buffs: 0, attacks: 9, items: 18 });
});

test('sync puts it on the bar once (changed slots only), then items are used by pressing their key', async () => {
  const hk = createHotkeys({});
  await hk.sync(snap, book);
  expect(calls.filter(([n]) => n === 'hotkey_set').length).toBe(8);
  expect(calls[0]).toEqual(['hotkey_set', { index: 0, isSkill: true, ID: 111, count: 5 }]);
  calls.length = 0;
  expect(await hk.press('item', 504)).toBe(true);
  expect(calls).toEqual([['hotkey_press', { index: 18 }]]);
  expect(await hk.press('item', 999)).toBe(false); // not on the bar
});

test('a skill already on the bar keeps its key when the buff order changes', async () => {
  const hk = createHotkeys({});
  await hk.sync(snap, book);
  calls.length = 0;
  const swapped = { ...book, buffs: [112, 111] };
  const want = hk.layout(snap, swapped);
  expect(want.get(0).ID).toBe(111); // F1 still Adrenaline
  expect(want.get(1).ID).toBe(112);
});
