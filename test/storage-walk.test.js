import { test, expect, mock, afterEach, setSystemTime } from 'bun:test';
process.env.LAYA_API_KEY ||= 'test'; process.env.OMLX_API_KEY ||= 'test';
const calls = [], logs = [];
mock.module('../src/browser.js', () => ({ act: async (_p, name, arg) => { calls.push([name, arg]); return true; } }));
mock.module('../src/logger.js', () => ({ log: (kind, data) => logs.push([kind, data]) }));
mock.module('../src/lessons.js', () => ({ learn() {} }));
mock.module('../src/gear-goal.js', () => ({ readGearStorage: () => ({}), recordGearStorage: () => true }));
const { createStorage } = await import('../src/storage.js');
const { buildWorld } = await import('../src/world.js');
const world = buildWorld({ mobs: {}, spawns: [], immobile: [] },
  { edges: {}, go: [['geffen', 120, 100]] }, { shops: [] },
  { npcs: [['geffen', 120, 62, 'Kafra Employee', '', 1]] });
const item = { index: 7, ITID: 4001, count: 1, name: 'Poring Card' };
function setup() {
  calls.length = 0; logs.length = 0;
  const dialog = { start: async npc => { calls.push(['talk', npc.GID]); }, tick: async () => null };
  const storage = createStorage({}, world, dialog, { storageItems: () => [item] });
  const snap = { me: { map: 'geffen', x: 120, y: 100, walking: false }, inventory: [item], npcs: [] };
  expect(storage.maybeStart(snap)).toBe(true);
  return { storage, snap };
}
afterEach(() => setSystemTime());
test('successful gear withdrawal does not block the next ore deposit', async () => {
  const storage = createStorage({}, world, { start: async () => {}, tick: async () => null });
  const snap = { me: { map: 'geffen', x: 120, y: 62 }, inventory: [],
    npcs: [{ GID: 9, name: 'Kafra Employee', x: 120, y: 62 }], storage: { open: true, items: [] } };
  expect(storage.maybeStart(snap, [{ id: 985, count: 1 }])).toBe(true);
  await storage.tick(snap); // talk
  await storage.tick(snap); // audit
  setSystemTime(Date.now() + 1100);
  await storage.tick(snap); // gear_take
  expect(await storage.tick(snap)).toMatchObject({ ok: true });
  expect(storage.retryAt).toBe(0);
  snap.storage = null;
  snap.inventory = [{ index: 8, ITID: 985, count: 1, name: 'Elunium' }];
  expect(storage.maybeStart(snap)).toBe(true);
});
test('Geffen arrival dialog is advanced and closed before walking to Kafra', async () => {
  const { storage, snap } = setup();
  await storage.tick({ ...snap, dialog: { naid: 55, state: 'next' } });
  await storage.tick({ ...snap, dialog: { naid: 55, state: 'close' } });
  expect(calls).toEqual([['npc_next', { naid: 55 }], ['npc_close', { naid: 55 }]]);
  await storage.tick({ ...snap, dialog: { state: 'ended' } });
  expect(calls.at(-1)).toEqual(['walk_to', { x: 120, y: 62 }]);
  await storage.tick({ ...snap, me: { ...snap.me, y: 64 }, npcs: [{ GID: 9, name: 'Kafra Employee', x: 120, y: 62 }] });
  expect(calls.at(-1)).toEqual(['talk', 9]);
});
test('leftover shop and NPC menu are released without walking in the same tick', async () => {
  const { storage, snap } = setup();
  await storage.tick({ ...snap, shop: { stage: 'buy' } });
  await storage.tick({ ...snap, dialog: { state: 'menu', naid: 55 } });
  expect(calls).toEqual([['close_shop', undefined], ['npc_menu', { naid: 55, num: 255 }]]);
});
test('an unresponsive dialog still times out with position diagnostics', async () => {
  const { storage, snap } = setup();
  const stuck = { ...snap, dialog: { naid: 55, state: 'close' } };
  await storage.tick(stuck);
  setSystemTime(Date.now() + 61000);
  expect(await storage.tick(stuck)).toMatchObject({ ok: false, stored: 0 });
  expect(logs.find(([kind]) => kind === 'storage_approach_blocked')[1]).toMatchObject({ map: 'geffen', x: 120, y: 100, targetX: 120, targetY: 62, dialog: 'close' });
});
