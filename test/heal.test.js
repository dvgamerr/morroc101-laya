import { test, expect, mock } from 'bun:test';

process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';
const calls = [];
mock.module('../src/browser.js', () => ({ act: async (_p, n, a) => calls.push([n, a]), exploreTarget: async () => null, query: async () => [] }));
mock.module('../src/logger.js', () => ({ log: () => {} }));
mock.module('../src/llm.js', () => ({ chat: async () => '{}', parseJson: (t) => JSON.parse(t) }));
mock.module('../src/laya.js', () => ({ choose: async () => ({ choice: 'option_1', confidence: 0.1 }), ask: async () => ({}) }));
const { createHealer, healChooser } = await import('../src/heal.js');
const { createDialog } = await import('../src/npc.js');
const { buildWorld } = await import('../src/world.js');

const world = buildWorld(
  { mobs: { 1: ['Poring', 1, 50, '', '', 1, '', 1, 1, []] }, spawns: [['moc_fild07', 1, 50]] },
  { edges: {}, go: [['morocc', 156, 93]] },
  { shops: [] },
  { npcs: [['morocc', 160, 100, 'Healer', '4_F_NURSE', 1]] },
);
const me = (over) => ({ map: 'morocc', x: 156, y: 93, hp: 1, maxHp: 1000, sp: 10, maxSp: 100, walking: false, ...over });

test('after respawn in town: walk to the Healer and talk to it', async () => {
  const h = createHealer({}, world, createDialog({}));
  expect(h.maybeStart({ me: me({ hp: 950, sp: 90 }) })).toBe(false); // healthy
  expect(h.maybeStart({ me: me({ map: 'moc_fild07' }) })).toBe(false); // not a town
  expect(h.maybeStart({ me: me() })).toBe(true);
  await h.tick({ me: me(), npcs: [] });
  expect(calls.at(-1)).toEqual(['walk_to', { x: 160, y: 100 }]);
  await h.tick({ me: me({ x: 159, y: 99 }), npcs: [{ GID: 5, name: 'Healer', x: 160, y: 100 }] });
  expect(calls.at(-1)).toEqual(['talk', { GID: 5 }]);
  await h.tick({ me: me({ x: 159, y: 99 }), npcs: [], dialog: { naid: 5, state: 'close', lines: ['You have been healed.'], at: Date.now(), idleMs: 0 } });
  expect(calls.at(-1)).toEqual(['npc_close', { naid: 5 }]);
  // success is judged by HP, not by the window closing
  const done = await h.tick({ me: me({ x: 159, y: 99, hp: 1000, sp: 100 }), npcs: [] });
  expect(done).toMatchObject({ ok: true });
});

test('healer menus: pick heal / yes, never a forbidden option', () => {
  expect(healChooser.rules(['Buff', 'Heal', 'Cancel']).index).toBe(1);
  expect(healChooser.rules(['Yes', 'No']).index).toBe(0);
  expect(healChooser.rules(['Reset Stats'])).toBe(null);
});

test('a healer that did not heal (its own cooldown) is skipped for a while instead of retried every 30s', async () => {
  calls.length = 0;
  const h = createHealer({}, world, createDialog({}));
  expect(h.maybeStart({ me: me() })).toBe(true);
  await h.tick({ me: me({ x: 159, y: 99 }), npcs: [{ GID: 5, name: 'Healer', x: 160, y: 100 }] });
  await h.tick({ me: me({ x: 159, y: 99 }), npcs: [], dialog: { naid: 5, state: 'close', lines: [], at: Date.now(), idleMs: 0 } });
  // HP never came back
  const realNow = Date.now;
  Date.now = () => realNow() + 4000;
  const done = await h.tick({ me: me({ x: 159, y: 99 }), npcs: [] });
  expect(done.ok).toBe(false);
  Date.now = () => realNow() + 60000; // past the 30s retry, inside the 5 min skip
  expect(h.maybeStart({ me: me() })).toBe(false);
  Date.now = realNow;
});
