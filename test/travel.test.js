import { test, expect, mock, beforeEach, setSystemTime, afterEach } from 'bun:test';

process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';

const calls = [];
mock.module('../src/browser.js', () => ({ act: async (_p, name, arg) => calls.push([name, arg]) }));
mock.module('../src/logger.js', () => ({ log: () => {} }));
const { createTravel } = await import('../src/travel.js');

let now;
const tick = (ms) => setSystemTime((now += ms));
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

test('types @go, and turns @go off when the server ignores it', async () => {
  const t = createTravel({});
  await t.start('prt_fild08');
  calls.length = 0;
  const n = { dest: 'prt_fild08', leg: { kind: 'go', goIndex: 0, toMap: 'prontera' } };
  await t.tick(snap({}, n));
  expect(calls).toEqual([['say', { text: '@go 0' }]]);
  tick(1000);
  await t.tick(snap({}, n)); // too soon to retry
  expect(calls.length).toBe(1);
  tick(6000);
  await t.tick(snap({}, n));
  tick(6000);
  await t.tick(snap({}, n));
  expect(t.canGo).toBe(false);
  expect(calls.at(-1)).toEqual(['navi_start', { map: 'prt_fild08', useGo: false }]);
});

test('fails when there is no route or the character stops moving', async () => {
  const t = createTravel({});
  await t.start('nowhere');
  expect(await t.tick(snap({}, { dest: 'nowhere', lost: true }))).toBe('failed');

  await t.start('moc_fild07');
  const n = { dest: 'moc_fild07', leg: { kind: 'portal', x: 160, y: 40 }, ahead: { x: 152, y: 90 } };
  await t.tick(snap({}, n));
  tick(26000);
  expect(await t.tick(snap({}, n))).toBe('failed');
});

test('re-asks the planner when the client dropped the destination', async () => {
  const t = createTravel({});
  await t.start('moc_fild07');
  calls.length = 0;
  await t.tick(snap({}, null));
  expect(calls).toEqual([['navi_start', { map: 'moc_fild07', useGo: true }]]);
});
