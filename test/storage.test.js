import { test, expect, mock } from 'bun:test';

process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';
const calls = [];
mock.module('../src/browser.js', () => ({ act: async (_p, n, a) => calls.push([n, a]), exploreTarget: async () => null, query: async () => [] }));
mock.module('../src/logger.js', () => ({ log: () => {} }));
mock.module('../src/llm.js', () => ({ chat: async () => '{}', parseJson: (t) => JSON.parse(t) }));
mock.module('../src/laya.js', () => ({ choose: async () => ({ choice: 'option_1', confidence: 0.1 }), ask: async () => ({}) }));
// logs/gear-storage.json is the real bot's file: without it (or with it) the result must not change. Only the file is faked.
const realGearGoal = await import('../src/gear-goal.js');
mock.module('../src/gear-goal.js', () => ({ ...realGearGoal, readGearStorage: () => ({}), recordGearStorage: () => true }));
const { createStorage, storageChooser } = await import('../src/storage.js');
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

// Cards are no longer stored on sight: only what the item review (LAYA) decided to store goes in.
const reviewing = (...ids) => ({ storageItems: (snap) => snap.inventory.filter((i) => ids.includes(i.ITID) && !i.equipped && i.count > 0) });

test('items the review chose to store, in a town with a Kafra: walk over, open storage, put every one in, close', async () => {
  calls.length = 0;
  const s = createStorage({}, world, createDialog({}), reviewing(4001, 4079));
  expect(s.maybeStart({ me: me(), inventory: [POT] })).toBe(false); // nothing chosen by the review
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
  const open = { open: true, at: Date.now(), items: [], count: 0 };
  const realNow = Date.now;
  await s.tick({ me: near, inventory: [POT, POR, MAN], npcs: [], storage: open }); // talk -> audit
  Date.now = () => realNow() + 1100; // the audit waits a second for the storage list
  await s.tick({ me: near, inventory: [POT, POR, MAN], npcs: [], storage: open });
  await s.tick({ me: near, inventory: [POT, POR, MAN], npcs: [], storage: open });
  expect(calls.at(-1)).toEqual(['storage_put', { index: 7, count: 2 }]);
  Date.now = () => realNow() + 2100;
  await s.tick({ me: near, inventory: [POT, MAN], npcs: [], storage: open });
  expect(calls.at(-1)).toEqual(['storage_put', { index: 8, count: 1 }]);
  Date.now = () => realNow() + 3100;
  expect(await s.tick({ me: near, inventory: [POT], npcs: [], storage: open })).toBe(null); // gone: confirm it holds
  Date.now = () => realNow() + 3300;
  expect(await s.tick({ me: near, inventory: [], npcs: [], storage: open })).toBe(null); // an empty read proves nothing
  Date.now = () => realNow() + 5100;
  expect(await s.tick({ me: near, inventory: [POT], npcs: [], storage: open })).toBe(null);
  Date.now = () => realNow() + 6700;
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

test('what would not go in is not offered again (and paid for) on the next visit', async () => {
  calls.length = 0;
  const s = createStorage({}, world, createDialog({}), reviewing(4001));
  const bag = [POT, POR];
  const near = me({ x: 155, y: 96 });
  const open = { open: true, at: Date.now(), items: [], count: 0 };
  expect(s.maybeStart({ me: near, inventory: bag })).toBe(true);
  const realNow = Date.now;
  try {
    let t = realNow();
    const at = (ms) => { Date.now = () => t + ms; };
    await s.tick({ me: near, inventory: bag, npcs: [{ GID: 9, name: 'Kafra Employee', x: 156, y: 97 }] }); // walk -> talk
    await s.tick({ me: near, inventory: bag, npcs: [], dialog: { naid: 9, state: 'menu', menu: ['Use Storage'], lines: ['Hi'], at: Date.now(), idleMs: 0 } });
    await s.tick({ me: near, inventory: bag, npcs: [], storage: open });
    await s.tick({ me: near, inventory: bag, npcs: [], storage: open });
    let done = null;
    // The card never leaves the bag: two tries, then it is given up.
    for (const ms of [1100, 1100, 1600, 2100, 2600, 7000]) { at(ms); done ||= await s.tick({ me: near, inventory: bag, npcs: [], storage: open }); }
    expect(done).toMatchObject({ ok: false });
    // Past the 2 minute retry gap, the same card is not a reason for another visit.
    at(3 * 60 * 1000);
    expect(s.maybeStart({ me: near, inventory: bag })).toBe(false);
  } finally { Date.now = realNow; }
});
