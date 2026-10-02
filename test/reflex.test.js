import { test, expect, mock, beforeEach, setSystemTime } from 'bun:test';

process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';

const calls = [];
let layaChoice = 'attack_monster';
let layaAsked = 0;

mock.module('../src/browser.js', () => ({
  act: async (_page, name, arg) => (calls.push([name, arg]), name === 'walk_to' ? { x: arg.x, y: arg.y } : undefined),
  exploreTarget: async () => ({ x: 120, y: 100 }),
  query: async () => [],
}));
mock.module('../src/laya.js', () => ({
  choose: async (_state, _instructions, options) => {
    layaAsked++;
    return { choice: options[layaChoice] ? layaChoice : Object.keys(options)[0], confidence: 0.9 };
  },
}));
const logged = [];
mock.module('../src/logger.js', () => ({ log: (kind, data) => logged.push([kind, data]) }));

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
  expect(calls.filter(([n]) => n === 'use_item')).toEqual([['use_item', { index: 2 }]]);
  // Owner's rule: moving while drinking (a step in a circle, away from the attacker).
  const step = calls.find(([n]) => n === 'walk_to');
  expect(step).toBeTruthy();
  expect(step[1].x).toBeLessThan(100); // the Poring is at x 103: the step goes the other way
});

test('low HP without potions flies away when attacked', async () => {
  const tick = createReflex({}, brain);
  await tick(snap({ me: { hp: 15 }, attackers: [7], inventory: [{ index: 9, ITID: 12323, count: 3, type: 2 }] }));
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
  expect(calls.filter(([n]) => n === 'walk_to').length).toBe(1);
});

test('explore heads for where @where says the targets are, round walls via walk_to', async () => {
  brain.plan = { ...brain.plan, hunt_map: 'prt_fild08', target_monsters: ['Poring'] };
  const scout = { locate: async () => [{ x: 140, y: 90, name: 'Poring' }] };
  const tick = createReflex({}, brain, scout);
  layaChoice = 'explore';
  await tick(snap({ monsters: [], inventory: [] }));
  expect(calls).toEqual([['walk_to', { x: 140, y: 90 }]]);
});

test('explore falls back to a random reachable cell when the server reports nothing', async () => {
  const tick = createReflex({}, brain, { locate: async () => [] });
  layaChoice = 'explore';
  await tick(snap({ monsters: [], inventory: [] }));
  expect(calls).toEqual([['walk_to', { x: 120, y: 100 }]]);
});

test('on the hunting map only level-matched targets are attacked (unless they attack first)', async () => {
  brain.plan = { ...brain.plan, hunt_map: 'prt_fild08', target_monsters: ['Poring'] };
  const tick = createReflex({}, brain);
  layaChoice = 'attack_monster';
  const monsters = [{ GID: 8, name: 'Orc Lord', x: 101, y: 100, dist: 1 }, { GID: 7, name: 'Poring', x: 105, y: 100, dist: 5 }];
  await tick(snap({ monsters }));
  expect(calls).toEqual([['attack', { GID: 7 }]]);
  calls.length = 0;
  const off = createReflex({}, brain);
  await off(snap({ monsters: [monsters[0]], attackers: [8] }));
  expect(calls).toEqual([['attack', { GID: 8 }]]);
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

test('nothing in sight and healthy: explore by rule, without asking LAYA (it once chose to stand still for 20s)', async () => {
  const tick = createReflex({}, brain);
  layaChoice = 'wait';
  const r = await tick(snap({ monsters: [], inventory: [] }));
  expect(r.action).toBe('explore');
  expect(layaAsked).toBe(0);
});

test('a long fight followed by one explore is not "stuck" (it used to abandon good maps)', async () => {
  const tick = createReflex({}, brain);
  const t0 = Date.now();
  setSystemTime(t0);
  await tick(snap({ attackers: [7] })); // fighting in place
  setSystemTime(t0 + 60000); // a minute later, same cell
  await tick(snap({ attackers: [7] }));
  setSystemTime(t0 + 61000);
  const r = await tick(snap({ monsters: [], inventory: [] }));
  expect(r.action).toBe('explore');
  expect(r.stuck).toBe(false);
  setSystemTime();
});

test('combat: buff first, then skills always; a plain hit only to finish a nearly-dead monster', async () => {
  const casts = [];
  const skills = {
    ensurePlan() {},
    pickBuff: (s) => (s.buffDown ? { id: 8, level: 1, targetID: 100, name: 'BUFF' } : null),
    pickAttack: () => ({ id: 5, level: 10, targetID: 7, name: 'SKILL' }),
    noteCast: (c) => casts.push(c.name),
  };
  const tick = createReflex({}, brain, null, skills);
  layaChoice = 'attack_monster';
  await tick({ ...snap(), buffDown: true });
  expect(casts).toEqual(['BUFF']);
  await tick(snap({ attackers: [7] }));
  expect(casts).toEqual(['BUFF', 'SKILL']);
  calls.length = 0;
  await tick(snap({ attackers: [7], monsters: [{ GID: 7, name: 'Poring', x: 101, y: 100, dist: 1, hp: 5, maxHp: 100 }] }));
  expect(casts).toEqual(['BUFF', 'SKILL']); // 5% HP left: no skill wasted
  expect(calls.filter(([n]) => n === 'attack').length).toBeLessThanOrEqual(1);
});

test('a coin-flip LAYA answer falls back to the obvious move; no potion offered above 75% HP', async () => {
  const tick = createReflex({}, brain);
  layaChoice = 'wait';
  const r = await tick(snap({ me: { hp: 80 }, attackers: [7, 9], monsters: [{ GID: 7, name: 'Poring', x: 101, y: 100, dist: 1 }, { GID: 9, name: 'Poring', x: 102, y: 100, dist: 2 }] }));
  expect(r.action).not.toBe('use_hp_potion');
});

// The death on yuno_fild04: HP hovering ~45%, walked into a pack, 6 on us, no escape until too late.
const pack = (n) => Array.from({ length: n }, (_, i) => ({ GID: 100 + i, name: 'Mastering', x: 101 + (i % 3), y: 100 + Math.floor(i / 3), dist: 1 + (i % 3) }));

test('mobbed (3+ on us) and under 60% HP: escape with the Novice Fly Wing, before more potions', async () => {
  const tick = createReflex({}, brain);
  const monsters = pack(6);
  const r = await tick(snap({ me: { hp: 46 }, monsters, attackers: monsters.slice(0, 6).map((m) => m.GID), inventory: [{ index: 2, ITID: 501, count: 30, type: 0 }, { index: 9, ITID: 12323, count: 2, type: 2 }] }));
  expect(r.action).toBe('fly_wing');
  expect(calls.at(-1)).toEqual(['use_item', { index: 9 }]);
});

test('under attack: drink at 60%, not 45%', async () => {
  const tick = createReflex({}, brain);
  const r = await tick(snap({ me: { hp: 55 }, attackers: [7] }));
  expect(r.action).toBe('use_hp_potion');
});

test('out of combat below 70%: sit (free) instead of starting a fight; potion only with a monster close', async () => {
  const tick = createReflex({}, brain);
  const far = await tick(snap({ me: { hp: 50 }, monsters: [{ GID: 7, name: 'Poring', x: 110, y: 100, dist: 10 }], inventory: [] }));
  expect(far.action).toBe('rest'); // no potions at all: sit
  const close = await tick(snap({ me: { hp: 50 } })); // Poring at dist 3
  expect(close.action).toBe('use_hp_potion');
});

test('a monster sitting in a pack is skipped while a lone one is available', async () => {
  const tick = createReflex({}, brain);
  layaChoice = 'attack_monster';
  const lone = { GID: 7, name: 'Goat', x: 120, y: 100, dist: 8 };
  await tick(snap({ monsters: [...pack(5), lone] }));
  expect(calls.at(-1)).toEqual(['attack', { GID: 7 }]);
});

test('in town (e.g. after respawning) the reflex never drinks out of combat: it sits', async () => {
  const tick = createReflex({}, brain);
  const r = await tick(snap({ me: { hp: 1 }, monsters: [], inventory: [{ index: 2, ITID: 504, count: 99, type: 0 }] }), { inTown: true });
  expect(r.action).toBe('rest');
});

test('mobbed with no wing: drink before running (running while being hit just dies tired)', async () => {
  const tick = createReflex({}, brain);
  const monsters = pack(3);
  const r = await tick(snap({ me: { hp: 55 }, monsters, attackers: monsters.map((m) => m.GID) }));
  expect(r.action).toBe('use_hp_potion');
});

test('a failed skill makes the next move one step aside before casting again (unstick)', async () => {
  const skills = {
    book: { needStep: true },
    ensurePlan() {},
    pickBuff: () => null,
    pickAttack: () => ({ id: 5, level: 10, targetID: 7, name: 'SKILL' }),
    noteCast() {},
  };
  const tick = createReflex({}, brain, null, skills);
  layaChoice = 'attack_monster';
  await tick(snap());
  expect(calls.some(([n, a]) => n === 'walk_to' && a.step === 1)).toBe(true);
  expect(skills.book.needStep).toBe(false);
});

test('SP: low -> drink Blue Potions to 95% (no sitting, in a fight or not); town: no potions', async () => {
  const blue = { index: 8, ITID: 505, count: 9, type: 0 };
  const inv = [{ index: 2, ITID: 501, count: 5, type: 0 }, blue];
  const tick = createReflex({}, brain);
  expect((await tick(snap({ me: { sp: 5, maxSp: 50 }, attackers: [7], inventory: inv }))).action).toBe('use_sp_potion');
  expect((await tick(snap({ me: { sp: 20, maxSp: 50 }, monsters: [], inventory: inv }))).action).toBe('use_sp_potion');
  expect((await tick(snap({ me: { sp: 48, maxSp: 50 }, monsters: [], inventory: inv }))).action).not.toBe('use_sp_potion');
  const calm = createReflex({}, brain);
  expect((await calm(snap({ me: { sp: 10, maxSp: 50 }, monsters: [], inventory: inv }))).action).toBe('use_sp_potion'); // not 'rest'
  const town = createReflex({}, brain);
  expect((await town(snap({ me: { sp: 10, maxSp: 50 }, monsters: [], inventory: inv }), { inTown: true })).action).not.toBe('use_sp_potion');
});

test('HP: once the potion rule fires, keep drinking to 95% even after the attacker is gone', async () => {
  const tick = createReflex({}, brain);
  expect((await tick(snap({ me: { hp: 50 }, attackers: [7] }))).action).toBe('use_hp_potion');
  expect((await tick(snap({ me: { hp: 80 }, monsters: [] }))).action).toBe('use_hp_potion');
  expect((await tick(snap({ me: { hp: 96 }, monsters: [] }))).action).not.toBe('use_hp_potion');
});

test('drank is true only when a bottle actually goes down (not every tick of the potion gap)', async () => {
  const tick = createReflex({}, brain);
  const first = await tick(snap({ me: { hp: 50 }, attackers: [7] }));
  const second = await tick(snap({ me: { hp: 50 }, attackers: [7] })); // inside the 800ms gap
  expect([first.drank, second.drank]).toEqual([true, false]);
});

test('a normal attack is running and a skill is ready: step one cell to cancel the swing, then cast', async () => {
  let ready = false;
  const skills = {
    book: {},
    ensurePlan() {},
    pickBuff: () => null,
    pickAttack: () => (ready ? { id: 5, level: 10, targetID: 7, name: 'MC_MAMMONITE' } : null),
    noteCast() {},
  };
  const tick = createReflex({}, brain, null, skills);
  layaChoice = 'attack_monster';
  await tick(snap()); // no skill ready: plain attack
  expect(calls.at(-1)).toEqual(['attack', { GID: 7 }]);
  ready = true;
  await tick(snap());
  expect(calls.at(-1)[0]).toBe('walk_to'); // cancel the attack first
  expect(calls.at(-1)[1].step).toBe(1);
  await tick(snap());
  expect(calls.at(-1)).toMatchObject(['skill', { SKID: 5 }]); // now the skill goes out
});

test('between casts (skill on cooldown) it waits for the next skill instead of swinging and stepping each time', async () => {
  let ready = true;
  const skills = {
    book: {},
    ensurePlan() {},
    pickBuff: () => null,
    pickAttack: () => (ready ? { id: 5, level: 10, targetID: 7, name: 'MC_CARTREVOLUTION' } : null),
    noteCast() {},
  };
  const tick = createReflex({}, brain, null, skills);
  layaChoice = 'attack_monster';
  await tick(snap());
  expect(calls.at(-1)).toMatchObject(['skill', { SKID: 5 }]);
  ready = false; // global gap / cooldown
  const before = calls.length;
  await tick(snap());
  expect(calls.slice(before).some(([n]) => n === 'attack' || n === 'walk_to')).toBe(false);
  ready = true;
  await tick(snap());
  expect(calls.at(-1)).toMatchObject(['skill', { SKID: 5 }]); // straight out, no cancel step needed
});

test('a skill is ready but the monster is out of its reach: walk up to it, no swing to cancel later', async () => {
  const skills = {
    book: {},
    ensurePlan() {},
    pickBuff: () => null,
    pickAttack: (_s, t) => (t.dist > 1.5 ? { approach: true, name: 'MC_MAMMONITE', range: 1 } : { id: 42, level: 10, targetID: t.GID, name: 'MC_MAMMONITE' }),
    noteCast() {},
  };
  const tick = createReflex({}, brain, null, skills);
  layaChoice = 'attack_monster';
  await tick(snap()); // Poring at dist 3
  expect(calls.at(-1)).toEqual(['walk_to', { x: 103, y: 100 }]);
  expect(calls.some(([n]) => n === 'attack')).toBe(false);
});

test('on the hunting map with nothing in sight: Novice Fly Wing at once, no long walk to look', async () => {
  const { setSystemTime } = require('bun:test');
  brain.plan = { ...brain.plan, hunt_map: 'prt_fild08', target_monsters: ['Poring'] };
  const wing = { index: 9, ITID: 12323, count: 5, type: 2 };
  const inv = [{ index: 2, ITID: 501, count: 5, type: 0 }, wing];
  const tick = createReflex({}, brain);
  const t0 = Date.now();
  setSystemTime(t0 + 2500);
  const r = await tick(snap({ monsters: [], inventory: inv }));
  expect(r.action).toBe('fly_wing');
  // Not the hunting map (travelling through): walk around for a while first.
  const other = createReflex({}, brain);
  const r2 = await other(snap({ me: { map: 'prt_fild01' }, monsters: [], inventory: inv }));
  expect(r2.action).not.toBe('fly_wing');
  setSystemTime();
});

test('a target we neither close in on nor hurt for 10s (across water, in a wall) is dropped for another', async () => {
  const { setSystemTime } = require('bun:test');
  const t0 = Date.now();
  const golem = { GID: 7, name: 'Wooden Golem', x: 108, y: 100, dist: 8, hp: 100, maxHp: 100 };
  const other = { GID: 8, name: 'Wootan Fighter', x: 95, y: 100, dist: 5 };
  const tick = createReflex({}, brain);
  layaChoice = 'attack_monster';
  await tick(snap({ monsters: [golem] }));
  expect(calls.at(-1)).toEqual(['attack', { GID: 7 }]);
  setSystemTime(t0 + 200);
  await tick(snap({ monsters: [golem] })); // fighting it now
  setSystemTime(t0 + 11000);
  await tick(snap({ monsters: [golem, other] })); // 11s, same distance, same HP
  setSystemTime(t0 + 11500);
  await tick(snap({ monsters: [golem, other] }));
  expect(calls.at(-1)).toEqual(['attack', { GID: 8 }]);
  setSystemTime();
});

test('next to a monster with damage known: 10s with nothing landing drops it; damage going in keeps it', async () => {
  const { setSystemTime } = require('bun:test');
  const t0 = Date.now();
  const hard = { GID: 7, name: 'Elder Willow', x: 101, y: 100, dist: 1, hp: -1, maxHp: -1 };
  const other = { GID: 8, name: 'Willow', x: 95, y: 100, dist: 5, hp: -1, maxHp: -1 };
  layaChoice = 'attack_monster';
  const tick = createReflex({}, brain);
  await tick(snap({ monsters: [hard], dealt: {} }));
  setSystemTime(t0 + 200);
  await tick(snap({ monsters: [hard], dealt: { 7: { dmg: 0, hits: 0, misses: 4 } } }));
  setSystemTime(t0 + 11000);
  await tick(snap({ monsters: [hard, other], dealt: { 7: { dmg: 0, hits: 0, misses: 9 } } }));
  setSystemTime(t0 + 11500);
  await tick(snap({ monsters: [hard, other], dealt: { 7: { dmg: 0, hits: 0, misses: 9 } } }));
  expect(calls.at(-1)).toEqual(['attack', { GID: 8 }]);

  calls.length = 0;
  const t1 = t0 + 20000;
  setSystemTime(t1);
  const ok = createReflex({}, brain);
  const fresh = { ...hard, GID: 9 };
  await ok(snap({ monsters: [fresh], dealt: {} }));
  for (let i = 1; i <= 12; i++) {
    setSystemTime(t1 + i * 1000);
    await ok(snap({ monsters: [fresh, other], dealt: { 9: { dmg: i * 300, hits: i, misses: 0 } } }));
  }
  expect(calls.some(([n, a]) => n === 'attack' && a.GID === 8)).toBe(false);
  setSystemTime();
});

test('a long fight is logged once (fight_long) with what we dealt; many drinks with HP stuck log potion_no_effect', async () => {
  const { setSystemTime } = require('bun:test');
  const t0 = Date.now();
  logged.length = 0;
  const mob = { GID: 7, name: 'Elder Willow', x: 101, y: 100, dist: 1, hp: -1, maxHp: -1 };
  layaChoice = 'attack_monster';
  const tick = createReflex({}, brain);
  for (let i = 0; i <= 60; i += 5) {
    setSystemTime(t0 + i * 1000);
    await tick(snap({ monsters: [mob], attackers: [7], dealt: { 7: { dmg: i * 10, hits: i, misses: 1 } } }));
  }
  const long = logged.filter(([k]) => k === 'fight_long');
  expect(long.length).toBe(1);
  expect(long[0][1]).toMatchObject({ name: 'Elder Willow', dealt: 550, hitsUs: true });

  logged.length = 0;
  const drink = createReflex({}, brain);
  const inv = [{ index: 2, ITID: 501, name: 'Red Potion', count: 50, type: 0 }];
  for (let i = 0; i < 10; i++) {
    setSystemTime(t0 + 100000 + i * 1000);
    await drink(snap({ me: { hp: 40 }, monsters: [], attackers: [], inventory: inv }));
  }
  const stuck = logged.filter(([k]) => k === 'potion_no_effect');
  expect(stuck.length).toBe(1);
  expect(stuck[0][1]).toMatchObject({ hpFrom: 40, hpTo: 40 });
  setSystemTime();
});

test('no Novice Fly Wing: a Fly Wing (601) already in the bag is used; Novice first when both', async () => {
  const { setSystemTime } = require('bun:test');
  brain.plan = { ...brain.plan, hunt_map: 'prt_fild08', target_monsters: ['Poring'] };
  const t0 = Date.now();
  const tick = createReflex({}, brain);
  const both = createReflex({}, brain);
  setSystemTime(t0 + 2500);
  await tick(snap({ monsters: [], inventory: [{ index: 4, ITID: 601, count: 113, type: 2 }] }));
  expect(calls.at(-1)).toEqual(['use_item', { index: 4 }]);
  await both(snap({ monsters: [], inventory: [{ index: 4, ITID: 601, count: 113, type: 2 }, { index: 9, ITID: 12323, count: 1, type: 2 }] }));
  expect(calls.at(-1)).toEqual(['use_item', { index: 9 }]);
  setSystemTime();
});

test('mid-fight the Fly Wing is not on offer (LAYA winged away from half-dead monsters); escapes stay with the emergency rule', async () => {
  const tick = createReflex({}, brain);
  layaChoice = 'fly_wing';
  const wing = { index: 4, ITID: 601, count: 113, type: 2 };
  const r = await tick(snap({ me: { hp: 90 }, attackers: [7], monsters: [{ GID: 7, name: 'Wooden Golem', x: 101, y: 100, dist: 1, hp: 50, maxHp: 100 }], inventory: [{ index: 2, ITID: 501, count: 5, type: 0 }, wing] }));
  expect(r.action).not.toBe('fly_wing');
  expect(calls.some(([n, a]) => n === 'use_item' && a.index === 4)).toBe(false);
});

test('a fight going badly: wing out to a safe spot (2 on us under 50%, or under 35% at all) — drink there after', async () => {
  const wing = { index: 4, ITID: 601, count: 113, type: 2 };
  const inv = [{ index: 2, ITID: 501, count: 30, type: 0 }, wing];
  const two = [{ GID: 7, name: 'Wild Rose', x: 101, y: 100, dist: 1 }, { GID: 8, name: 'Wild Rose', x: 99, y: 100, dist: 1 }];
  const a = createReflex({}, brain);
  expect((await a(snap({ me: { hp: 45 }, attackers: [7, 8], monsters: two, inventory: inv }))).action).toBe('fly_wing');
  const b = createReflex({}, brain);
  expect((await b(snap({ me: { hp: 30 }, attackers: [7], monsters: two.slice(0, 1), inventory: inv }))).action).toBe('fly_wing');
  const c = createReflex({}, brain);
  expect((await c(snap({ me: { hp: 55 }, attackers: [7], monsters: two.slice(0, 1), inventory: inv }))).action).toBe('use_hp_potion'); // 1v1 at 55%: drink, keep fighting
});

test('splash skill waiting for a group: tag another monster nearby so it follows, then the splash can go out', async () => {
  const skills = {
    book: {},
    ensurePlan() {},
    pickBuff: () => null,
    pickAttack: () => null, // Cart Revolution waits: only one on us
    noteCast() {},
  };
  const tick = createReflex({}, brain, null, skills);
  const a = { GID: 7, name: 'Poring', x: 101, y: 100, dist: 1 };
  const b = { GID: 8, name: 'Poring', x: 104, y: 100, dist: 4 };
  const me = { sp: 50, maxSp: 50, skills: [{ id: 153, name: 'MC_CARTREVOLUTION', sp: 12, level: 1 }] };
  layaChoice = 'attack_monster';
  await tick(snap({ me, monsters: [a] })); // engage the first
  calls.length = 0;
  await tick(snap({ me, attackers: [7], monsters: [a, b] }));
  expect(calls).toContainEqual(['attack', { GID: 8 }]); // pulled the second one
});

test('no pulling where it already hurts (the ein_fild08 death), and two at most without a wing', async () => {
  const skills = { book: {}, ensurePlan() {}, pickBuff: () => null, pickAttack: () => null, noteCast() {} };
  const a = { GID: 7, name: 'Poring', x: 101, y: 100, dist: 1 };
  const b = { GID: 8, name: 'Poring', x: 104, y: 100, dist: 4 };
  const c = { GID: 9, name: 'Poring', x: 96, y: 100, dist: 4 };
  const me = { sp: 50, maxSp: 50, maxHp: 1000, hp: 1000, skills: [{ id: 153, name: 'MC_CARTREVOLUTION', sp: 12, level: 1 }] };
  layaChoice = 'attack_monster';
  const hurt = createReflex({}, brain, null, skills);
  await hurt(snap({ me, monsters: [a] }));
  calls.length = 0;
  await hurt(snap({ me, attackers: [7], damageTaken6s: 600, monsters: [a, b] })); // 100 HP/s on a 1000 HP character
  expect(calls).not.toContainEqual(['attack', { GID: 8 }]);
  const noWing = createReflex({}, brain, null, skills);
  await noWing(snap({ me, monsters: [a] }));
  calls.length = 0;
  await noWing(snap({ me, attackers: [7, 8], monsters: [a, b, c] })); // already two on us, no wing
  expect(calls).not.toContainEqual(['attack', { GID: 9 }]);
});

test('Cart Revolution only with 2+ monsters in its splash (saves Blue Potions); a lone one gets normal hits', async () => {
  let seenSplash = null;
  const skills = {
    book: {},
    ensurePlan() {},
    pickBuff: () => null,
    pickAttack: (_s, t, _crowd, splash) => {
      seenSplash = splash;
      return splash >= 2 ? { id: 153, level: 1, targetID: t.GID, name: 'MC_CARTREVOLUTION' } : null;
    },
    noteCast() {},
  };
  const me = { sp: 50, maxSp: 50, skills: [{ id: 153, name: 'MC_CARTREVOLUTION', sp: 12, level: 1 }] };
  const a = { GID: 7, name: 'Poring', x: 101, y: 100, dist: 1 };
  layaChoice = 'attack_monster';
  const lone = createReflex({}, brain, null, skills);
  await lone(snap({ me, monsters: [a] })); // nobody else in sight
  expect(seenSplash).toBe(1);
  expect(calls.at(-1)).toEqual(['attack', { GID: 7 }]);
  const b = { GID: 8, name: 'Poring', x: 102, y: 101, dist: 2 };
  const pair = createReflex({}, brain, null, skills);
  await pair(snap({ me, monsters: [a, b] }));
  expect(seenSplash).toBe(2);
  expect(calls.at(-1)).toMatchObject(['skill', { SKID: 153 }]);
});

test('no pulling with a crowd in sight (packs of aggressive monsters gather by themselves)', async () => {
  const skills = { book: {}, ensurePlan() {}, pickBuff: () => null, pickAttack: () => null, noteCast() {} };
  const me = { sp: 50, maxSp: 50, maxHp: 1000, hp: 1000, skills: [{ id: 153, name: 'MC_CARTREVOLUTION', sp: 12, level: 1 }] };
  const crowd = [0, 1, 2, 3, 4].map((i) => ({ GID: 7 + i, name: 'Petite', x: 101 + i, y: 100, dist: 1 + i }));
  layaChoice = 'attack_monster';
  const tick = createReflex({}, brain, null, skills);
  await tick(snap({ me, monsters: crowd.slice(0, 1) }));
  calls.length = 0;
  await tick(snap({ me, attackers: [7], monsters: crowd }));
  expect(calls.some(([n, a]) => n === 'attack' && a.GID !== 7)).toBe(false);
});

test('a bag read without the potions right after a map change (it loads in pieces) still drinks the potion seen moments ago', async () => {
  const tick = createReflex({}, brain);
  await tick(snap({ me: { hp: 100 } })); // bag with Red Potion seen
  calls.length = 0;
  const r = await tick(snap({ me: { hp: 40 }, attackers: [7], inventory: [{ index: 9, ITID: 909, count: 3, type: 3 }] })); // partial bag: no potion in it
  expect(r.action).toBe('use_hp_potion');
  expect(calls.some(([n]) => n === 'use_item')).toBe(true);
});

test('only packs in sight: no attack (it walked into 15 and died); swarmed by 5+: wing out at any HP', async () => {
  const wing = { index: 4, ITID: 601, count: 50, type: 2 };
  const inv = [{ index: 2, ITID: 501, count: 30, type: 0 }, wing];
  const herd = Array.from({ length: 8 }, (_, i) => ({ GID: 50 + i, name: 'Poring', x: 105 + (i % 3), y: 100 + Math.floor(i / 3), dist: 5 + (i % 3) }));
  layaChoice = 'attack_monster';
  const tick = createReflex({}, brain);
  await tick(snap({ monsters: herd, inventory: inv }));
  expect(calls.some(([n]) => n === 'attack')).toBe(false);
  const swarm = herd.slice(0, 5);
  const t2 = createReflex({}, brain);
  const r = await t2(snap({ me: { hp: 90 }, attackers: swarm.map((m) => m.GID), monsters: swarm, inventory: inv }));
  expect(r.action).toBe('fly_wing');
});

test('in a fight the loop never waits on LAYA (a slow answer froze it while HP drained)', async () => {
  const tick = createReflex({}, brain);
  const two = [{ GID: 7, name: 'Baby Leopard', x: 101, y: 100, dist: 1 }, { GID: 8, name: 'Baby Leopard', x: 99, y: 100, dist: 1 }];
  layaChoice = 'retreat';
  const before = layaAsked;
  const r = await tick(snap({ me: { hp: 80 }, attackers: [7, 8], monsters: two }));
  expect(layaAsked).toBe(before);
  expect(['attack_monster', 'keep_fighting']).toContain(r.action);
});

test('hit by monsters we cannot see (entity list empty after a warp): still counts as a fight going badly', async () => {
  const wing = { index: 4, ITID: 601, count: 50, type: 2 };
  const tick = createReflex({}, brain);
  const r = await tick(snap({ me: { hp: 45 }, monsters: [], attackers: [], unseenAttackers: 3, inventory: [{ index: 2, ITID: 501, count: 30, type: 0 }, wing] }));
  expect(r.action).toBe('fly_wing');
});
