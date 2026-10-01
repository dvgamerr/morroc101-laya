import { test, expect } from 'bun:test';
import { buildWorld, isTown, pickHuntingGrounds, hopsFrom, levelBand } from '../src/world.js';
import { sanitize, planFromCandidate } from '../src/planner.js';

// A tiny world shaped like navi_mob.txt / navi_map.txt:
//   town --portal--> field_a (lv 1-3) --portal--> field_b (lv 12-14) --portal--> field_c (lv 40 + lv 80 boss crowd)
//   town --portal--> field_d (too few monsters)   other_town reachable by @go only -> field_e (lv 2)
const mob = {
  immobile: [9],
  mobs: {
    1: ['Poring', 1, 55, 'Plant', 'Water', 1, 'Medium', 150, 40, []],
    2: ['Drops', 3, 60, 'Plant', 'Fire', 1, 'Medium', 180, 40, []],
    3: ['Condor', 12, 300, 'Brute', 'Wind', 1, 'Medium', 400, 300, []],
    4: ['Baby Desert Wolf', 14, 300, 'Brute', 'Fire', 1, 'Small', 450, 300, []],
    5: ['Wolf', 40, 2000, 'Brute', 'Earth', 1, 'Medium', 2000, 1500, []],
    6: ['Grand Orc', 80, 20000, 'Demi-Human', 'Earth', 2, 'Large', 9000, 7000, []],
    7: ['Furious Drops', 3, 600, 'Plant', 'Fire', 1, 'Medium', 1800, 400, []],
    9: ['Red Plant', 1, 10, 'Plant', 'Earth', 1, 'Small', 0, 0, []],
  },
  spawns: [
    ['field_a', 1, 40], ['field_a', 2, 30], ['field_a', 7, 2], ['field_a', 9, 10],
    ['field_b', 3, 50], ['field_b', 4, 40],
    ['field_c', 5, 60], ['field_c', 6, 5],
    ['field_d', 1, 3],
    ['field_e', 1, 60],
    ['town', 9, 5],
    ['1@inst', 1, 99],
  ],
};
const portal = (to) => [0, 0, to, 0, 0, 1, 1, 0, '', 0];
const map = {
  edges: {
    town: [portal('field_a'), portal('field_d'), [1, 1, 'field_e', 0, 0, 1, 1, 1, 'Kafra', 600]],
    field_a: [portal('town'), portal('field_b'), portal('1@inst')],
    field_b: [portal('field_a'), portal('field_c')],
    field_c: [portal('field_b')],
    other_town: [portal('field_e')],
    field_e: [portal('other_town')],
  },
  go: [['town', 0, 0], ['other_town', 0, 0]],
  nogo: [],
};
const world = buildWorld(mob, map);

test('towns: no mobile spawns, or an @go destination', () => {
  expect(isTown(world, 'town')).toBe(true);
  expect(isTown(world, 'other_town')).toBe(true);
  expect(isTown(world, 'field_a')).toBe(false);
});

test('travel distance uses portals only, plus @go when allowed (never Kafra)', () => {
  const walk = hopsFrom(world, 'town', { canGo: false });
  expect(walk.get('field_b')).toBe(2);
  expect(walk.has('field_e')).toBe(false);
  const go = hopsFrom(world, 'field_b', { canGo: true });
  expect(go.get('field_e')).toBe(2);
});

test('level 1 in town goes to the starter field, not the town', () => {
  const [best] = pickHuntingGrounds(world, { level: 1, fromMap: 'town' });
  expect(best.map).toBe('field_a');
  expect(best.targets.map((t) => t.name)).toEqual(['Poring', 'Drops']);
  expect(best.avoid).toContain('Furious Drops');
});

test('level 12 moves on to monsters of its level', () => {
  const [best] = pickHuntingGrounds(world, { level: 12, fromMap: 'town' });
  expect(best.map).toBe('field_b');
});

test('skips instances, thin maps, unreachable maps and maps with a crowd far above the band', () => {
  const maps = pickHuntingGrounds(world, { level: 40, fromMap: 'town', limit: 10 }).map((c) => c.map);
  expect(maps).not.toContain('field_c'); // 5 Grand Orc lv80
  const low = pickHuntingGrounds(world, { level: 1, fromMap: 'town', limit: 10 }).map((c) => c.map);
  expect(low).not.toContain('1@inst');
  expect(low).not.toContain('field_d');
  expect(low).not.toContain('field_e'); // only via Kafra or @go
  expect(pickHuntingGrounds(world, { level: 1, fromMap: 'town', canGo: true, limit: 10 }).map((c) => c.map)).toContain('field_e');
});

test('excluded maps are not offered', () => {
  const maps = pickHuntingGrounds(world, { level: 1, fromMap: 'town', exclude: ['field_a'] }).map((c) => c.map);
  expect(maps).not.toContain('field_a');
});

test('level band', () => {
  expect(levelBand(1)).toEqual({ min: 1, max: 5, danger: 11 });
  expect(levelBand(50)).toEqual({ min: 44, max: 54, danger: 60 });
});

test('planner cannot invent a hunting map or monsters', () => {
  const candidates = pickHuntingGrounds(world, { level: 1, fromMap: 'town', canGo: true });
  const p = sanitize({ hunt_map: 'morocc', target_monsters: ['Baphomet'], retreat_hp_pct: 0 }, candidates);
  expect(p.hunt_map).toBe(candidates[0].map);
  expect(p.target_monsters).toEqual(candidates[0].targets.map((t) => t.name));
  expect(p.retreat_hp_pct).toBe(15);
  const chosen = sanitize({ hunt_map: candidates[1].map }, candidates);
  expect(chosen.hunt_map).toBe(candidates[1].map);
});

test('plan from candidate carries its targets and avoid list', () => {
  const [best] = pickHuntingGrounds(world, { level: 1, fromMap: 'town' });
  const p = planFromCandidate(best);
  expect(p.hunt_map).toBe('field_a');
  expect(p.avoid_monsters).toContain('Furious Drops');
});
