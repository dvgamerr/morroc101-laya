import { test, expect, mock, beforeEach, setSystemTime, afterEach } from 'bun:test';

process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';

const calls = [];
mock.module('../src/browser.js', () => ({
  act: async (_p, name, arg) => calls.push([name, arg]),
  exploreTarget: async () => null,
  query: async (_p, cmd) => (calls.push(['say', { text: cmd }]), []),
}));
mock.module('../src/logger.js', () => ({ log: () => {} }));
const { createTravel } = await import('../src/travel.js');

let now;
const tick = (ms) => setSystemTime((now += ms));
/** Keep ticking travel every 2s for ms (a real stall, not a pause). */
async function stall(t, s, ms) {
  let last;
  for (let left = ms; left > 0; left -= 2000) {
    tick(2000);
    last = await t.tick(s);
  }
  return last;
}
beforeEach(() => {
  calls.length = 0;
  now = Date.UTC(2026, 9, 1);
  setSystemTime(now);
});
afterEach(() => setSystemTime());

const snap = (me, navi) => ({ me: { map: 'morocc', x: 150, y: 100, walking: false, ...me }, navi });

test('starts the client route planner without Kafra/NPC legs', async () => {
  const t = createTravel({});
  await t.start('moc_fild07');
  expect(calls).toEqual([['navi_start', { map: 'moc_fild07', useGo: true }]]);
});

test('walks a few cells up the planned path, and onto the portal when close', async () => {
  const t = createTravel({});
  await t.start('moc_fild07');
  calls.length = 0;
  const leg = { kind: 'portal', x: 160, y: 40, toMap: 'moc_fild07' };
  expect(await t.tick(snap({}, { dest: 'moc_fild07', leg, ahead: { x: 152, y: 90 } }))).toBe('traveling');
  expect(calls).toEqual([['move', { x: 152, y: 90 }]]);
  tick(1000);
  await t.tick(snap({ x: 159, y: 41 }, { dest: 'moc_fild07', leg, ahead: { x: 160, y: 40 } }));
  expect(calls.at(-1)).toEqual(['move', { x: 160, y: 40 }]);
});

test('does not re-send moves every tick while walking', async () => {
  const t = createTravel({});
  await t.start('moc_fild07');
  calls.length = 0;
  const n = { dest: 'moc_fild07', leg: { kind: 'portal', x: 160, y: 40 }, ahead: { x: 152, y: 90 } };
  await t.tick(snap({}, n));
  tick(300);
  await t.tick(snap({ walking: true, x: 151 }, n));
  tick(300);
  await t.tick(snap({ walking: true, x: 152 }, n));
  expect(calls.filter(([c]) => c === 'move').length).toBe(1);
});

test('arrives when the map matches and clears the route', async () => {
  const t = createTravel({});
  await t.start('moc_fild07');
  calls.length = 0;
  expect(await t.tick(snap({ map: 'moc_fild07' }, null))).toBe('arrived');
  expect(calls).toEqual([['navi_clear', undefined]]);
  expect(t.dest).toBe(null);
});

test('unconfirmed @go only falls back for this trip and never disables other towns', async () => {
  const go = { canGo: true };
  const t = createTravel({}, go);
  await t.start('prt_fild08');
  calls.length = 0;
  const n = { dest: 'prt_fild08', leg: { kind: 'go', goIndex: 0, toMap: 'prontera' } };
  await t.tick(snap({}, n));
  expect(calls).toEqual([['say', { text: '@go 0' }]]);
  tick(1000);
  await t.tick(snap({}, n)); // too soon to retry
  expect(calls.length).toBe(1);
  tick(10000);
  await t.tick(snap({}, n));
  tick(10000);
  await t.tick(snap({}, n));
  expect(go.canGo).toBe(true); // one town refused: not a reason to stop using @go
  expect(calls.at(-1)).toEqual(['navi_start', { map: 'prt_fild08', useGo: false }]);
  const t2 = createTravel({}, go);
  await t2.start('x');
  for (let k = 0; k < 3; k++) {
    tick(10000);
    await t2.tick(snap({}, { dest: 'x', leg: { kind: 'go', goIndex: 12, toMap: 'umbala' } }));
  }
  expect(go.canGo).toBe(true); // Missing confirmation never disables shared @go
});

test('walks round with BFS when the client has no path or progress stalls', async () => {
  const tr = createTravel({});
  await tr.start('moc_fild07');
  calls.length = 0;
  const leg = { kind: 'portal', x: 160, y: 40 };
  await tr.tick(snap({}, { dest: 'moc_fild07', leg, ahead: null }));
  expect(calls).toEqual([['walk_to', { x: 160, y: 40 }]]);
  calls.length = 0;
  calls.length = 0;
  await stall(tr, snap({}, { dest: 'moc_fild07', leg, ahead: { x: 150, y: 90 } }), 10000); // standing still past DETOUR_AFTER_MS
  calls.splice(0, calls.length - 1);
  expect(calls).toEqual([['walk_to', { x: 160, y: 40 }]]);
});

test('fails when there is no route or the character stops moving', async () => {
  const t = createTravel({});
  await t.start('nowhere');
  for (let i = 0; i < 3; i++) {
    expect(await t.tick(snap({}, { dest: 'nowhere', lost: true }))).toBe('traveling');
    tick(3000);
  }
  expect(await t.tick(snap({}, { dest: 'nowhere', lost: true }))).toBe('failed');

  await t.start('moc_fild07');
  const n = { dest: 'moc_fild07', leg: { kind: 'portal', x: 160, y: 40 }, ahead: { x: 152, y: 90 } };
  await t.tick(snap({}, n));
  expect(await stall(t, snap({}, n), 28000)).toBe('failed');
});

test('re-asks the planner when the client dropped the destination', async () => {
  const t = createTravel({});
  await t.start('moc_fild07');
  calls.length = 0;
  await t.tick(snap({}, null));
  expect(calls).toEqual([['navi_start', { map: 'moc_fild07', useGo: true }]]);
});

test('time spent away from travel (healer, fight) is not counted as being stuck', async () => {
  const t = createTravel({});
  await t.start('moc_fild07');
  const n = { dest: 'moc_fild07', leg: { kind: 'portal', x: 160, y: 40 }, ahead: { x: 152, y: 90 } };
  await t.tick(snap({}, n));
  tick(40000); // 40s at the Healer, travel not ticked
  expect(await t.tick(snap({}, n))).toBe('traveling');
});

test('"@go to the town we are in" is skipped: walk from here instead of warping to the same town over and over', async () => {
  const t = createTravel({});
  await t.start('in_sphinx1');
  calls.length = 0;
  await t.tick(snap({ map: 'morocc' }, { dest: 'in_sphinx1', leg: { kind: 'go', goIndex: 1, toMap: 'morocc' } }));
  expect(calls.some(([n, a]) => n === 'navi_start' && a.useGo === false)).toBe(true);
  expect(calls.some(([n]) => n === 'query')).toBe(false);
});

test('keeps destination across warp, stale go leg and transient lost route', async () => {
  const t = createTravel({});
  await t.start('lhz_fild01');
  await t.tick(snap({map:'morocc'}, {dest:'lhz_fild01',leg:{kind:'go',goIndex:20,toMap:'lighthalzen'}}));
  calls.length = 0;
  const stale = snap({map:'lighthalzen'}, {dest:'lhz_fild01',lost:true});
  expect(await t.tick(stale)).toBe('traveling');
  expect(t.dest).toBe('lhz_fild01');
  tick(1000);
  expect(await t.tick(stale)).toBe('traveling');
  expect(calls.filter(([n]) => n === 'navi_start').length).toBe(1);
  tick(2000);
  expect(await t.tick(snap({map:'lighthalzen'}, {dest:'lhz_fild01',leg:{kind:'go',goIndex:20,toMap:'lighthalzen'}}))).toBe('traveling');
  expect(calls.at(-1)).toEqual(['navi_start',{map:'lhz_fild01',useGo:false}]);
  tick(3000);
  expect(await t.tick(stale)).toBe('traveling');
  expect(t.dest).toBe('lhz_fild01');
  tick(3000);
  const route = {dest:'lhz_fild01',leg:{kind:'portal',x:160,y:100},ahead:{x:155,y:100}};
  expect(await t.tick(snap({map:'lighthalzen'},route))).toBe('traveling');
  expect(calls.at(-1)).toEqual(['move',{x:155,y:100}]);
  expect(calls.some(([n]) => n === 'say')).toBe(false);
  expect(await t.tick(snap({map:'lhz_fild01'},null))).toBe('arrived');
});

test('returning to a hunted field can bypass Warpra and town warps', async () => {
  const t = createTravel({}, { canGo: true }, {});
  await t.start('prt_fild09', { walking: true });
  expect(calls).toEqual([['navi_start', { map: 'prt_fild09', useGo: false }]]);
  calls.length = 0;
  await t.tick(snap({ map: 'prt_fild07' }, { legs: [], lost: false }));
  expect(calls.some(([name]) => name === 'say')).toBe(false);
});

test('advances an NPC Next prompt before trying to warp', async () => {
  const t = createTravel({});
  await t.start('prontera');
  calls.length = 0;
  const s = snap({}, { dest: 'prontera', leg: { kind: 'go', goIndex: 0, toMap: 'prontera' } });
  s.dialog = { state: 'next', naid: 300 };
  await t.tick(s);
  expect(calls).toEqual([['npc_next', { naid: 300 }]]);
});

test('a map change restores @go after an unconfirmed warp on the previous map', async () => {
  const t = createTravel({});
  await t.start('prt_fild08');
  const n = { dest: 'prt_fild08', leg: { kind: 'go', goIndex: 0, toMap: 'prontera' } };
  await t.tick(snap({}, n));
  tick(10000);
  await t.tick(snap({}, n));
  tick(10000);
  await t.tick(snap({}, n));
  expect(calls.at(-1)[1].useGo).toBe(false);
  await t.tick(snap({ map: 'prontera' }, n));
  expect(calls.at(-1)).toEqual(['navi_start', { map: 'prt_fild08', useGo: true }]);
});

test('an unconfirmed @go is remembered for that map: the next trip walks out of it without retrying', async () => {
  const go = { canGo: true };
  const t = createTravel({}, go);
  await t.start('prt_fild08');
  const n = { dest: 'prt_fild08', leg: { kind: 'go', goIndex: 0, toMap: 'prontera' } };
  for (let i = 0; i < 3; i++) {
    tick(10000);
    await t.tick(snap({}, n));
  }
  expect(go.refused.has('morocc')).toBe(true);
  expect(go.canGo).toBe(true);
  await t.stop();
  // A later trip, even from another travel instance sharing `go`, starts walking on that map.
  const t2 = createTravel({}, go);
  await t2.start('prt_fild08');
  calls.length = 0;
  tick(1000);
  expect(await t2.tick(snap({}, { dest: 'prt_fild08', leg: { kind: 'portal', x: 1, y: 1 } }))).toBe('traveling');
  expect(calls).toEqual([['navi_start', { map: 'prt_fild08', useGo: false }]]);
  // Another map is not affected.
  tick(4000);
  await t2.tick(snap({ map: 'geffen' }, { dest: 'prt_fild08', leg: { kind: 'go', goIndex: 3, toMap: 'prontera' } }));
  tick(4000);
  calls.length = 0;
  await t2.tick(snap({ map: 'geffen' }, { dest: 'prt_fild08', leg: { kind: 'go', goIndex: 3, toMap: 'prontera' } }));
  expect(calls).toEqual([['say', { text: '@go 3' }]]);
  // The refusal expires.
  tick(11 * 60 * 1000);
  const t3 = createTravel({}, go);
  await t3.start('prt_fild08');
  calls.length = 0;
  await t3.tick(snap({}, { dest: 'prt_fild08', leg: { kind: 'portal', x: 1, y: 1 } }));
  expect(calls.some(([name]) => name === 'navi_start')).toBe(false);
});

test('no walking route from a refused map: walk to the nearest town where @go works, then route again', async () => {
  const portal = (to) => [0, 0, to, 0, 0, 1, 1, 0, '', 0];
  const { buildWorld } = await import('../src/world.js');
  const world = buildWorld(
    { mobs: {}, spawns: [] },
    { edges: { morocc: [portal('moc_fild01')], moc_fild01: [portal('morocc'), portal('geffen')], geffen: [portal('moc_fild01')] }, go: [['morocc', 0, 0], ['geffen', 0, 0]], nogo: [] },
    { shops: [] },
    { npcs: [] },
  );
  const go = { canGo: true, refused: new Map([['morocc', Date.now() + 600000]]) };
  world.warpraPlaces = []; // the live board does not list the destination: no Warpra phase
  const tr = createTravel({}, go, world);
  await tr.start('far_fild');
  calls.length = 0;
  let r;
  for (let i = 0; i < 5; i++) {
    tick(3500);
    r = await tr.tick(snap({}, { dest: 'far_fild', lost: true }));
  }
  expect(r).toBe('traveling');
  expect(calls.at(-1)).toEqual(['navi_start', { map: 'geffen', useGo: false }]);
  // Arriving there asks for the real destination again, with @go allowed.
  tick(3500);
  await tr.tick(snap({ map: 'geffen' }, { dest: 'geffen', lost: false }));
  tick(3500);
  await tr.tick(snap({ map: 'geffen' }, { dest: 'geffen', lost: false }));
  expect(calls.at(-1)).toEqual(['navi_start', { map: 'far_fild', useGo: true }]);
});

test('the trip timeout does not count time paused for a fight or shop', async () => {
  const t = createTravel({});
  await t.start('moc_fild07');
  const n = { dest: 'moc_fild07', leg: { kind: 'portal', x: 160, y: 40 }, ahead: { x: 152, y: 90 } };
  await t.tick(snap({}, n));
  tick(14 * 60 * 1000); // paused 14 minutes
  expect(await t.tick(snap({}, n))).toBe('traveling');
  tick(2 * 60 * 1000);
  expect(await t.tick(snap({ x: 151, y: 91 }, n))).toBe('traveling'); // 16 minutes since start, 2 active
});

test('Warpra is not visited when the live board does not list the destination', async () => {
  const world = { warpraPlaces: [{ map: 'morocc', lock: 0 }], npcs: [], go: [], edges: new Map(), noGo: new Set() };
  const t = createTravel({}, { canGo: true }, world);
  await t.start('moc_fild03');
  expect(calls).toEqual([['navi_start', { map: 'moc_fild03', useGo: true }]]);
});

test('a locked Warpra town is not "arrived" just by standing in it', async () => {
  const world = { warpraPlaces: [{ map: 'einbroch', lock: 1 }], npcs: [], go: [], edges: new Map(), noGo: new Set(), walks: new Map() };
  const t = createTravel({ locator: () => ({ isVisible: async () => false }), evaluate: async () => [] }, { canGo: true }, world);
  await t.start('einbroch');
  const result = await t.tick(snap({ map: 'einbroch' }, null));
  expect(result).not.toBe('arrived');
  expect(t.dest).toBe('einbroch');
});

test('each stuck NPC dialog is closed once, not only the first of the trip', async () => {
  const t = createTravel({});
  await t.start('moc_fild07');
  const n = { dest: 'moc_fild07', leg: { kind: 'portal', x: 160, y: 40 }, ahead: { x: 152, y: 90 } };
  const dialogs = (naid) => ({ ...snap({}, n), dialog: { state: 'open', naid } });
  await t.tick(dialogs(1));
  calls.length = 0;
  await stall(t, dialogs(1), 10000);
  await stall(t, dialogs(2), 10000);
  const closes = calls.filter(([name]) => name === 'npc_close').map(([, a]) => a.naid);
  expect(closes).toEqual([1, 2]);
});
