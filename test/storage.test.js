import { test, expect, mock } from 'bun:test';

process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';
const calls = [];
mock.module('../src/browser.js', () => ({ act: async (_p, n, a) => calls.push([n, a]), exploreTarget: async () => null, query: async () => [] }));
mock.module('../src/logger.js', () => ({ log: () => {} }));
mock.module('../src/llm.js', () => ({ chat: async () => '{}', parseJson: (t) => JSON.parse(t) }));
mock.module('../src/laya.js', () => ({ choose: async () => ({ choice: 'option_1', confidence: 0.1 }), ask: async () => ({}) }));
const { createStorage, storageChooser, cardsIn } = await import('../src/storage.js');
const { createDialog } = await import('../src/npc.js');
const { buildWorld } = await import('../src/world.js');

const world = buildWorld(
  { mobs: { 1: ['Poring', 1, 50, '', '', 1, '', 1, 1, []] }, spawns: [['moc_fild07', 1, 50]] },
  { edges: {}, go: [['morocc', 156, 93]] },
  { shops: [] },
  { npcs: [['morocc', 156, 97, 'Kafra Employee', '4_F_KAFRA1', 1]] },
);
const me = (over) => ({ map: 'morocc', x: 150, y: 90, hp: 100, maxHp: 100, walking: false, ...over });
const POR = { index: 7, ITID: 4001, name: 'Poring Card', count: 2, type: 6 };
const MAN = { index: 8, ITID: 4079, name: 'Mantis Card', count: 1, type: 6 };
const POT = { index: 2, ITID: 501, name: 'Red Potion', count: 5, type: 0 };

test('cards in the bag, in a town with a Kafra: walk over, open storage, put every card in, close', async () => {
  calls.length = 0;
  const s = createStorage({}, world, createDialog({}));
  expect(s.maybeStart({ me: me(), inventory: [POT] })).toBe(false); // no cards
  expect(s.maybeStart({ me: me({ map: 'moc_fild07' }), inventory: [POR] })).toBe(false); // not a town
  expect(s.maybeStart({ me: me(), inventory: [POT, POR, MAN] })).toBe(true);
  await s.tick({ me: me(), inventory: [POT, POR, MAN], npcs: [] });
  expect(calls.at(-1)).toEqual(['walk_to', { x: 156, y: 97 }]);
  const near = me({ x: 155, y: 96 });
  await s.tick({ me: near, inventory: [POT, POR, MAN], npcs: [{ GID: 9, name: 'Kafra Employee', x: 156, y: 97 }] });
  expect(calls.at(-1)).toEqual(['talk', { GID: 9 }]);
  // The Kafra's menu: Storage is picked.
  await s.tick({ me: near, inventory: [POT, POR, MAN], npcs: [], dialog: { naid: 9, state: 'menu', menu: ['Save', 'Use Storage', 'Cancel'], lines: ['Welcome'], at: Date.now(), idleMs: 0 } });
  expect(calls.at(-1)).toEqual(['npc_menu', { naid: 9, num: 2 }]);
  // Storage opens.
  const open = { open: true, at: Date.now() };
  await s.tick({ me: near, inventory: [POT, POR, MAN], npcs: [], storage: open });
  await s.tick({ me: near, inventory: [POT, POR, MAN], npcs: [], storage: open });
  expect(calls.at(-1)).toEqual(['storage_put', { index: 7, count: 2 }]);
  const realNow = Date.now;
  Date.now = () => realNow() + 1000;
  await s.tick({ me: near, inventory: [POT, MAN], npcs: [], storage: open });
  expect(calls.at(-1)).toEqual(['storage_put', { index: 8, count: 1 }]);
  Date.now = () => realNow() + 2000;
  expect(await s.tick({ me: near, inventory: [POT], npcs: [], storage: open })).toBe(null); // gone: confirm it holds
  Date.now = () => realNow() + 2200;
  expect(await s.tick({ me: near, inventory: [], npcs: [], storage: open })).toBe(null); // an empty read proves nothing
  Date.now = () => realNow() + 4000;
  expect(await s.tick({ me: near, inventory: [POT], npcs: [], storage: open })).toBe(null);
  Date.now = () => realNow() + 5600;
  const done = await s.tick({ me: near, inventory: [POT], npcs: [], storage: open });
  Date.now = realNow;
  expect(done).toMatchObject({ ok: true, stored: 3 });
  expect(calls.at(-1)).toEqual(['storage_close', undefined]);
});

test('Kafra menus: Storage (not guild storage) or yes; never a forbidden option', () => {
  expect(storageChooser.rules(['Save', 'Use Storage', 'Use Guild Storage', 'Cancel']).index).toBe(1);
  expect(storageChooser.rules(['Use Guild Storage', 'Storage']).index).toBe(1);
  expect(storageChooser.rules(['Yes', 'No']).index).toBe(0);
  expect(storageChooser.rules(['Delete Storage'])).toBe(null);
});

test('only loose cards count — not ones slotted into worn gear', () => {
  expect(cardsIn([POT, POR, { ...MAN, equipped: true }]).map((c) => c.index)).toEqual([7]);
});
