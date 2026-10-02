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

test('a town that ignores @go: this trip walks; @go stays on for other towns until 3 refuse', async () => {
  const go = { canGo: true, bad: new Set() };
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
  expect(go.bad.has(0)).toBe(true);
  expect(calls.at(-1)).toEqual(['navi_start', { map: 'prt_fild08', useGo: false }]);
  go.bad.add(5);
  go.bad.add(9);
  const t2 = createTravel({}, go);
  await t2.start('x');
  for (let k = 0; k < 3; k++) {
    tick(10000);
    await t2.tick(snap({}, { dest: 'x', leg: { kind: 'go', goIndex: 12, toMap: 'umbala' } }));
  }
  expect(go.canGo).toBe(false); // the fourth refusing town turns it off
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
