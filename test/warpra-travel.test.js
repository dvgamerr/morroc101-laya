import { test, expect, mock, beforeEach, setSystemTime, afterEach } from 'bun:test';

process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';

const calls = [];
let walkResult = true;
mock.module('../src/browser.js', () => ({
  act: async (_p, name, arg) => (calls.push([name, arg]), name === 'walk_to' ? walkResult : true),
  exploreTarget: async () => null,
  query: async () => [],
}));
mock.module('../src/logger.js', () => ({ log: () => {} }));
const { createWarpraTravel } = await import('../src/warpra-travel.js');
const { buildWorld } = await import('../src/world.js');

const portal = (to) => [0, 0, to, 0, 0, 1, 1, 0, '', 0];
const world = () =>
  buildWorld(
    { mobs: {}, spawns: [] },
    { edges: { town: [portal('field')], field: [portal('town')] }, go: [], nogo: [] },
    { shops: [] },
    { npcs: [['town', 10, 10, 'Warpra', 1, 'x']] },
  );

/** A page whose Warpra board shows `rows`; `broken` makes every UI call time out. */
function fakePage({ rows, visible = true, broken = false, count = 1 }) {
  const lines = [`<WARPRA>1|x|Towns~Dungeons|${rows}</WARPRA>`];
  const fail = async () => {
    throw new Error('Timeout 1500ms exceeded.\ncall log');
  };
  const locator = (sel) => ({
    isVisible: async () => (broken ? fail() : visible),
    fill: async () => (broken ? fail() : undefined),
    click: async () => (broken ? fail() : calls.push(['click', sel])),
    count: async () => count,
    isEnabled: async () => true,
    waitFor: async () => {},
    evaluate: async () => ({}),
    locator: (sub) => locator(sel + ' ' + sub),
  });
  return { locator, evaluate: async () => lines };
}

const feeder = { dest: null, start: async () => {}, stop: async () => {}, tick: async () => 'traveling' };
const go = { canGo: true };
let now;
const tick = (ms) => setSystemTime((now += ms));
beforeEach(() => {
  calls.length = 0;
  walkResult = true;
  now = Date.UTC(2026, 9, 1);
  setSystemTime(now);
});
afterEach(() => setSystemTime());

const snap = (me = {}, extra = {}) => ({
  me: { map: 'town', x: 10, y: 10, zeny: 1e6, ...me },
  npcs: [{ name: 'Warpra', GID: 77, x: 10, y: 11 }],
  ...extra,
});
const ROW = (map, lock = 0, price = 100) => `2*0*${map}*${map}*${price}*0*${lock}*`;

test('serves() is false once the live board is known and lacks the map; needsUnlockAt() sees locked towns', () => {
  const w = world();
  const t = createWarpraTravel(fakePage({ rows: ROW('einbroch') }), w, feeder, go);
  expect(t.serves('einbroch')).toBe(true);
  w.warpraPlaces = [{ map: 'einbroch', lock: 1 }, { map: 'morocc', lock: 0 }];
  expect(t.serves('moc_fild03')).toBe(false);
  expect(t.needsUnlockAt('einbroch')).toBe(true);
  expect(t.needsUnlockAt('morocc')).toBe(false);
});

test('reads the open board, clicks the advertised town and arrives', async () => {
  const w = world();
  const t = createWarpraTravel(fakePage({ rows: ROW('einbroch') }), w, feeder, go);
  t.start('einbroch');
  expect(await t.tick(snap())).toBe('traveling');
  expect(calls.some(([n]) => n === 'click')).toBe(true);
  expect(t.stage).toBe('verifyWarp');
  expect(w.warpraPlaces.map((p) => p.map)).toEqual(['einbroch']);
  tick(1000);
  expect(await t.tick(snap({ map: 'einbroch' }))).toBe('arrived');
});

test('too little zeny, or an absent destination, falls back to walking', async () => {
  const w = world();
  const poor = createWarpraTravel(fakePage({ rows: ROW('einbroch', 0, 5000) }), w, feeder, go);
  poor.start('einbroch');
  expect(await poor.tick(snap({ zeny: 10 }))).toBe('fallback');
  const absent = createWarpraTravel(fakePage({ rows: ROW('morocc') }), w, feeder, go);
  absent.start('moc_fild03');
  expect(await absent.tick(snap())).toBe('fallback');
});

test('a locked destination with no known unlock NPC falls back instead of failing the trip', async () => {
  const t = createWarpraTravel(fakePage({ rows: '2*1*Dun*dun_01*100*0*1*', count: 0 }), world(), feeder, go);
  t.start('dun_01');
  expect(await t.tick(snap())).toBe('fallback');
});

test('Playwright timeouts on the board are counted, not thrown, and end in a fallback', async () => {
  const t = createWarpraTravel(fakePage({ rows: ROW('einbroch'), broken: true }), world(), feeder, go);
  t.start('einbroch');
  expect(await t.tick(snap())).toBe('traveling');
  tick(500);
  expect(await t.tick(snap())).toBe('traveling');
  tick(500);
  expect(await t.tick(snap())).toBe('fallback');
});

test('walking to a Warpra that never gets closer is stuck, not a 30 minute wait', async () => {
  const t = createWarpraTravel(fakePage({ rows: ROW('einbroch'), visible: false }), world(), feeder, go);
  t.start('einbroch');
  const far = snap({ x: 100, y: 100 }, { npcs: [] });
  let result;
  for (let i = 0; i < 20 && result !== 'fallback'; i++) {
    result = await t.tick(far);
    tick(2000);
  }
  expect(result).toBe('fallback');
});

test('walk_to finding no path three times gives up on that NPC', async () => {
  walkResult = null;
  const t = createWarpraTravel(fakePage({ rows: ROW('einbroch'), visible: false }), world(), feeder, go);
  t.start('einbroch');
  const far = snap({ x: 100, y: 100 }, { npcs: [] });
  const results = [];
  for (let i = 0; i < 4; i++) {
    results.push(await t.tick(far));
    tick(2000);
  }
  expect(results.slice(0, 2)).toEqual(['traveling', 'traveling']);
  expect(results.at(-1)).toBe('fallback');
});

test('a paused trip does not run out its timeout', async () => {
  const t = createWarpraTravel(fakePage({ rows: ROW('einbroch'), visible: false }), world(), feeder, go);
  t.start('einbroch');
  const far = snap({ x: 100, y: 100 }, { npcs: [] });
  expect(await t.tick(far)).toBe('traveling');
  tick(14 * 60 * 1000); // paused for 14 minutes (a long fight), then comes back
  expect(await t.tick(far)).toBe('traveling');
  tick(2 * 60 * 1000);
  expect(await t.tick({ ...far, me: { ...far.me, x: 90, y: 90 } })).toBe('traveling');
});
