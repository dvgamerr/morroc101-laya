import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { abortFarmTravel } from '../src/farm-profit.js';

// Exercise the real dispatcher without booting main.js's browser and bot loop.
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const start = main.indexOf('async function farmTick(snap) {');
const end = main.indexOf('\n/**', start);
const source = main.slice(start, end);

function fixture(active = false) {
  const calls = [];
  const context = {
    weapons: { observe() {} }, committedGoal: () => 'money', world: null,
    brain: { counters: { actions: {} }, drinks: [] },
    weaponBlocked: () => false,
    errand: { active: false }, jobChange: { active: false }, healer: { active: false },
    storage: { active: false },
    gearUpgrade: { active, tick: async () => { calls.push('gear'); return true; } },
    travel: { dest: 'yuno_fild08', inDialog: false, stop: async () => { calls.push('stop'); } },
    reflex: async () => { calls.push('combat'); return { action: 'keep_fighting' }; },
    noteEscape() {},
  };
  const farmTick = runInNewContext(source + '\nfarmTick;', context);
  const snap = {
    me: { map: 'yuno', hp: 100, maxHp: 100, dead: false, sitting: false },
    attackers: [], mapAgeMs: 4000,
  };
  return { calls, farmTick, snap };
}

test('idle gear dialog cleanup preserves the hunting trip after a warp', async () => {
  const { calls, farmTick, snap } = fixture();
  snap.dialog = { state: 'close', naid: 123 };
  await farmTick(snap);
  expect(calls).toEqual(['gear']);
});

test('an active gear project still interrupts hunting travel', async () => {
  const { calls, farmTick, snap } = fixture(true);
  await farmTick(snap);
  expect(calls).toEqual(['gear', 'stop']);
});

test('unsettled map equipment does not interrupt hunting travel', async () => {
  const { calls, farmTick, snap } = fixture();
  snap.mapAgeMs = 1000;
  snap.worn = [];
  snap.inventory = [];
  await farmTick(snap);
  expect(calls).toEqual([]);
});

test('combat still takes priority during map settling', async () => {
  const { calls, farmTick, snap } = fixture();
  snap.mapAgeMs = 1000;
  snap.attackers = [123];
  await farmTick(snap);
  expect(calls).toEqual(['combat']);
});

test('repeated transit escapes reject the destination, deduplicating repeated ticks', () => {
  const from = main.indexOf('function noteEscape(snap, action) {');
  const until = main.indexOf('\n/**', from);
  let now = 100000;
  const calls = [];
  const brain = {
    plan: { hunt_map: 'yuno_fild06' },
    farmTrip: { startedAt: 1, maps: [], huntMap: 'yuno_fild06' },
  };
  const escape = runInNewContext(main.slice(from, until) + '\nnoteEscape;', {
    brain, travel: { dest: 'yuno_fild06' }, abortFarmTravel,
    ESCAPE_WINDOW_MS: 60000, ESCAPE_DEDUPE_MS: 3000, ESCAPES_TO_LEAVE: 2,
    Date: { now: () => now },
    exclude: (map, why) => calls.push(['exclude', map, why]),
    chooseHunt: (_snap, why) => { calls.push(['choose', why]); brain.huntPending = true; },
  });
  const snap = { me: { map: 'yuno_fild04' }, attackers: [1, 2] };
  escape(snap, 'fly_wing');
  now += 500;
  escape(snap, 'fly_wing');
  expect(calls).toEqual([]);
  now += 5000;
  escape(snap, 'fly_wing');
  expect(calls.map(c => c[0])).toEqual(['exclude', 'choose']);
  expect(calls[0][1]).toBe('yuno_fild06');
  expect(brain.farmTrip.routeFailure).toContain('yuno_fild04');
  expect(brain.farmTrip.maps).toEqual([]);
  // Once replanning, even escapes on the old hunting map cannot penalize it again.
  snap.me.map = 'yuno_fild06';
  now += 5000;
  escape(snap, 'fly_wing');
  expect(calls).toHaveLength(2);
});
