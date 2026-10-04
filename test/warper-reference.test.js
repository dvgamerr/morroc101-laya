import { test, expect, mock } from 'bun:test';

process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';
mock.module('../src/logger.js', () => ({ log: () => {} }));
const { isWarper, observeWarpers, warperSpots, warpraMayServe, warpOptions, WARP_PATHS } = await import('../src/warper-reference.js');
const { buildWorld, travelCosts, pickHuntingGrounds, GO_COST } = await import('../src/world.js');

const portal = (to) => [0, 0, to, 0, 0, 1, 1, 0, '', 0];
function fixture(extra = {}) {
  const mob = {
    mobs: { 1: ['Poring', 5, 55, 'Plant', 'Water', 1, 'Medium', 150, 40, []] },
    spawns: [['far_field', 1, 40], ['near_field', 1, 40]],
  };
  const map = {
    edges: {
      town: [portal('near_field')],
      near_field: [portal('town')],
      far_field: [portal('far_town')],
      far_town: [portal('far_field')],
    },
    go: [],
    nogo: [],
  };
  const npc = { npcs: [['far_town', 5, 5, 'Warpra', 1, 'x'], ['town', 10, 10, 'Warpra', 1, 'x']] };
  return Object.assign(buildWorld(mob, map, { shops: [] }, npc), extra);
}

test('isWarper accepts Warpa, Warpra and Warper, with an instance suffix', () => {
  expect(isWarper('Warpra')).toBe(true);
  expect(isWarper('warper#3')).toBe(true);
  expect(isWarper('Warpa')).toBe(true);
  expect(isWarper('Warpra Helper')).toBe(false);
  expect(isWarper(null)).toBe(false);
});

test('observed warpers replace the directory entries of that map', () => {
  const world = fixture();
  observeWarpers(world, { me: { map: 'town' }, npcs: [{ name: 'Warpra', x: 20, y: 21 }, { name: 'Kafra', x: 1, y: 1 }] });
  const here = world.npcs.filter((n) => n.map === 'town' && isWarper(n.name));
  expect(here).toEqual([{ name: 'Warpra', map: 'town', x: 20, y: 21 }]);
  observeWarpers(world, { me: { map: 'town' }, npcs: [] }); // nothing seen: keep what we know
  expect(world.npcs.filter((n) => n.map === 'town' && isWarper(n.name))).toHaveLength(1);
});

test('only the real Warpra spots are used when the directory has them; reference is the fallback', () => {
  const world = fixture();
  expect(warperSpots(world).map((n) => n.map).sort()).toEqual(['far_town', 'town']);
  const none = { npcs: [] };
  expect(warperSpots(none).length).toBeGreaterThan(10); // rAthena reference towns
});

test('Warpra is skipped once the live board is known not to list the destination', () => {
  const world = fixture();
  expect(warpraMayServe(world, 'far_field')).toBe(true); // board not read yet
  world.warpraPlaces = [{ map: 'far_field', lock: 0 }];
  expect(warpraMayServe(world, 'far_field')).toBe(true);
  expect(warpraMayServe(world, 'moc_fild03')).toBe(false);
});

test('warp options: board listing wins, locked or absent places are not priced, cost is walk + GO_COST', () => {
  const world = fixture();
  const costs = travelCosts(world, 'town', 0, 0);
  expect(warpOptions(world, costs, 'unknown_map')).toEqual([]); // not in reference paths either
  world.warpraPlaces = [{ map: 'far_field', lock: 0, name: 'Far Field', groupName: 'Dungeons' }, { map: 'locked_map', lock: 1, name: 'L', groupName: 'Dungeons' }];
  expect(warpOptions(world, costs, 'locked_map')).toEqual([]);
  expect(warpOptions(world, costs, 'not_on_board')).toEqual([]);
  const [best] = warpOptions(world, costs, 'far_field');
  expect(best.npc.map).toBe('town');
  expect(best.path).toEqual(['Dungeons', 'Far Field']);
  expect(best.cost).toBe(costs.to('town', 10, 10) + GO_COST);
  expect(Object.keys(WARP_PATHS).length).toBeGreaterThan(50);
});

test('a warp that costs more than walking is not used for hunting grounds', () => {
  const world = fixture();
  world.warpraPlaces = [{ map: 'near_field', lock: 0, name: 'Near', groupName: 'Dungeons' }, { map: 'far_field', lock: 0, name: 'Far', groupName: 'Dungeons' }];
  const grounds = pickHuntingGrounds(world, { level: 8, fromMap: 'town', limit: 10 });
  const near = grounds.find((c) => c.map === 'near_field');
  const far = grounds.find((c) => c.map === 'far_field');
  expect(near.warp).toBe(null); // one portal away: walking is cheaper than warp (walk to warper + GO_COST)
  expect(far.warp?.town).toBe('town'); // not reachable by walking from town? it is not: no portal
});
