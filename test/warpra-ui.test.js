import { test, expect, mock } from 'bun:test';

mock.module('../src/logger.js', () => ({ log: () => {} }));
const { parseWarpraFeed, inspectWarpra, clickWarpraDestination, closeWarpra } = await import('../src/warpra-ui.js');

const feed = (rows, groups = 'Towns~Dungeons') => [`<WARPRA>1|x|${groups}|${rows}</WARPRA>`];

test('parses a version-1 feed and rejects malformed rows', () => {
  const ok = parseWarpraFeed(feed('2*0*Einbroch*einbroch*100*3*0*;3*1*Floor 1*dun_01*500*0*1*helper'));
  expect(ok.groups).toEqual(['Towns', 'Dungeons']);
  expect(ok.places).toEqual([
    { code: 2, group: 0, name: 'Einbroch', map: 'einbroch', price: 100, lock: 0, unlock: '' },
    { code: 3, group: 1, name: 'Floor 1', map: 'dun_01', price: 500, lock: 1, unlock: 'helper' },
  ]);
  expect(parseWarpraFeed(feed('2*0*Einbroch*einbroch*100*3*9*'))).toBe(null); // lock out of range
  expect(parseWarpraFeed(feed('2*5*Einbroch*einbroch*100*3*0*'))).toBe(null); // unknown group
  expect(parseWarpraFeed(feed('1*0*Reserved*x*100*3*0*'))).toBe(null); // code <= 1
  expect(parseWarpraFeed(['<WARPRA>2|x|a|b</WARPRA>'])).toBe(null);
  expect(parseWarpraFeed(null)).toBe(null);
});

test('uses the newest feed line', () => {
  const lines = [...feed('2*0*Old*old_map*100*0*0*'), ...feed('2*0*New*new_map*100*0*0*')];
  expect(parseWarpraFeed(lines).places[0].map).toBe('new_map');
});

const page = (overrides = {}) => {
  const locator = () => ({
    isVisible: async () => true,
    fill: async () => {},
    click: async () => {},
    count: async () => 1,
    isEnabled: async () => true,
    waitFor: async () => {},
    evaluate: async () => ({}),
    locator,
    ...overrides,
  });
  return { locator, evaluate: async () => feed('2*0*Einbroch*einbroch*100*3*0*') };
};

test('no board on screen means null; an unlisted map is absent; a listed open town is open', async () => {
  expect(await inspectWarpra(page({ isVisible: async () => false }), 'einbroch')).toBe(null);
  expect((await inspectWarpra(page(), 'morocc')).state).toBe('absent');
  const open = await inspectWarpra(page(), 'einbroch');
  expect(open.state).toBe('open');
  expect(open.place.price).toBe(100);
});

test('a Playwright timeout is reported as state "error" instead of throwing', async () => {
  const timeout = async () => {
    throw Object.assign(new Error('Timeout 1500ms exceeded.\nlog'), { name: 'TimeoutError' });
  };
  expect(await inspectWarpra(page({ fill: timeout }), 'einbroch')).toEqual({ state: 'error' });
  const board = await inspectWarpra(page(), 'einbroch');
  expect(await clickWarpraDestination(page({ click: timeout }), board)).toBe(false);
  await closeWarpra(page({ click: timeout })); // must not throw
});

test('the destination is re-checked against the feed before clicking', async () => {
  const board = await inspectWarpra(page(), 'einbroch');
  expect(await clickWarpraDestination(page(), board)).toBe(true);
  expect(await clickWarpraDestination(page(), { ...board, place: { ...board.place, code: 99 } })).toBe(false);
});
