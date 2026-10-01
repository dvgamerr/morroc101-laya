import { test, expect, mock, beforeEach } from 'bun:test';

process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';

const calls = [];
let layaChoice = 'attack_monster';
let layaAsked = 0;

mock.module('../src/browser.js', () => ({
  act: async (_page, name, arg) => calls.push([name, arg]),
}));
mock.module('../src/laya.js', () => ({
  choose: async (_state, _instructions, options) => {
    layaAsked++;
    return { choice: options[layaChoice] ? layaChoice : Object.keys(options)[0], confidence: 0.9 };
  },
}));
mock.module('../src/logger.js', () => ({ log: () => {} }));

const { createReflex } = await import('../src/reflex.js');
const { DEFAULT_PLAN } = await import('../src/planner.js');

const snap = ({ me, ...over } = {}) => ({
  inGame: true,
  attackers: [],
  damageTaken6s: 0,
  monsters: [{ GID: 7, name: 'Poring', x: 103, y: 100, dist: 3 }],
  items: [],
  players: [],
  inventory: [{ index: 2, ITID: 501, name: 'Red Potion', count: 5, type: 0 }],
  ...over,
  me: { name: 'Bot', x: 100, y: 100, hp: 100, maxHp: 100, sp: 50, maxSp: 50, weight: 10, maxWeight: 100, map: 'prt_fild08', ...me },
});

let brain;
beforeEach(() => {
  calls.length = 0;
  layaAsked = 0;
  layaChoice = 'attack_monster';
  brain = { plan: { ...DEFAULT_PLAN } };
});

test('attacks the monster LAYA picks', async () => {
  const tick = createReflex({}, brain);
  const r = await tick(snap());
  expect(r.action).toBe('attack_monster');
  expect(calls).toEqual([['attack', { GID: 7 }]]);
});

test('safe 1v1 keeps fighting without asking LAYA or re-sending the attack', async () => {
  const tick = createReflex({}, brain);
  await tick(snap());
  layaAsked = 0;
  calls.length = 0;
  const r = await tick(snap({ attackers: [7] }));
  expect(r.action).toBe('keep_fighting');
  expect(layaAsked).toBe(0);
  expect(calls).toEqual([]);
});

test('low HP drinks a potion before anything else, once per gap', async () => {
  const tick = createReflex({}, brain);
  const s = snap({ me: { hp: 30 }, attackers: [7] });
  await tick(s);
  await tick(s);
  expect(calls).toEqual([['use_item', { index: 2 }]]);
});

test('low HP without potions flies away when attacked', async () => {
  const tick = createReflex({}, brain);
  await tick(snap({ me: { hp: 15 }, attackers: [7], inventory: [{ index: 9, ITID: 601, count: 3, type: 2 }] }));
  expect(calls).toEqual([['use_item', { index: 9 }]]);
});

test('dead -> respawn is not spammed', async () => {
  const tick = createReflex({}, brain);
  const s = snap({ me: { hp: 0, dead: true } });
  await tick(s);
  await tick(s);
  expect(calls).toEqual([['respawn', undefined]]);
});

test('explore does not re-send a walk every tick', async () => {
  const tick = createReflex({}, brain);
  layaChoice = 'explore';
  const s = snap({ monsters: [], inventory: [] });
  await tick(s);
  await tick(s);
  await tick(s);
  expect(calls.filter(([n]) => n === 'move').length).toBe(1);
});

test('does not loot when overweight', async () => {
  const tick = createReflex({}, brain);
  layaChoice = 'pickup_item';
  const r = await tick(snap({ monsters: [], me: { weight: 90 }, items: [{ GID: 50, x: 101, y: 100, dist: 1 }] }));
  expect(r.action).not.toBe('pickup_item');
});

test('picks up adjacent loot', async () => {
  const tick = createReflex({}, brain);
  layaChoice = 'pickup_item';
  await tick(snap({ monsters: [], items: [{ GID: 50, x: 101, y: 100, dist: 1 }] }));
  expect(calls).toEqual([['pickup', { GID: 50 }]]);
});

test('avoided monsters are skipped unless they attack first', async () => {
  brain.plan.avoid_monsters = ['Poring'];
  const tick = createReflex({}, brain);
  layaChoice = 'attack_monster';
  const r1 = await tick(snap());
  expect(r1.action).not.toBe('attack_monster');
  const r2 = await tick(snap({ attackers: [7] }));
  expect(r2.action).toBe('attack_monster');
});

test('LAYA answer outside the allowed set falls back to wait', async () => {
  const tick = createReflex({}, brain);
  layaChoice = 'fly_wing'; // no wing in inventory -> not offered
  const r = await tick(snap({ monsters: [] , inventory: [] }));
  expect(['explore', 'wait']).toContain(r.action);
});

test('defendOnly (travelling): ignores idle monsters and loot, fights back attackers', async () => {
  const tick = createReflex({}, brain);
  layaChoice = 'attack_monster';
  const idle = await tick(snap({ items: [{ GID: 50, x: 101, y: 100, dist: 1 }] }), { defendOnly: true });
  expect(idle.action).toBe('wait');
  const hit = await tick(snap({ attackers: [7] }), { defendOnly: true });
  expect(hit.action).toBe('attack_monster');
});
