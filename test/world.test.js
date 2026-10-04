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

test('level 4 in town goes to the starter field, not the town (band is Base-10..Base-1)', () => {
  const [best] = pickHuntingGrounds(world, { level: 4, fromMap: 'town' });
  expect(best.map).toBe('field_a');
  expect(best.targets.map((t) => t.name)).toEqual(['Poring', 'Drops']);
  expect(best.avoid).toContain('Furious Drops');
});

test('level 15 moves on to monsters just below its level', () => {
  const [best] = pickHuntingGrounds(world, { level: 15, fromMap: 'town' });
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
  expect(levelBand(1)).toEqual({ min: 1, max: 1, danger: 4 });
  expect(levelBand(50)).toEqual({ min: 40, max: 49, danger: 53 });
});

test('planner cannot invent a hunting map or monsters', () => {
  const candidates = pickHuntingGrounds(world, { level: 1, fromMap: 'town', canGo: true });
  const p = sanitize({ hunt_map: 'morocc', target_monsters: ['Baphomet'], retreat_hp_pct: 0 }, candidates);
  expect(p.hunt_map).toBe(null); // never picks a map by itself
  expect(p.target_monsters).toEqual([]);
  expect(p.retreat_hp_pct).toBe(15);
  const chosen = sanitize({ hunt_map: candidates[1].map, target_monsters: ['Baphomet'] }, candidates);
  expect(chosen.hunt_map).toBe(candidates[1].map);
  expect(chosen.target_monsters).toEqual(candidates[1].targets.map((t) => t.name)); // unknown names dropped
});

test('plan from candidate carries its targets and avoid list', () => {
  const [best] = pickHuntingGrounds(world, { level: 1, fromMap: 'town' });
  const p = planFromCandidate(best);
  expect(p.hunt_map).toBe('field_a');
  expect(p.avoid_monsters).toContain('Furious Drops');
});

test('a map crowded with avoided monsters (they come to us) is not offered', () => {
  const offered = (avoid) => pickHuntingGrounds(world, { level: 1, fromMap: 'town', limit: 10, avoid }).map((c) => c.map);
  expect(offered([])).toContain('field_a');
  expect(offered(['Drops'])).not.toContain('field_a'); // 30 Drops there
  expect(offered(['Furious Drops'])).toContain('field_a'); // only 2: still fine
});

test('money hunts well below us in big crowds (safe, cheap, many drops); level hunts for EXP', () => {
  // Level 20: for EXP, Baby Desert Wolf (14) on field_b; money looks at the wider Base-20..Base-1 band.
  const forExp = pickHuntingGrounds(world, { level: 20, fromMap: 'town', limit: 10 });
  expect(forExp[0].map).toBe('field_b');
  const forMoney = pickHuntingGrounds(world, { level: 20, goal: 'money', fromMap: 'town', canGo: true, limit: 10 });
  expect(forMoney.every((c) => c.targets.every((t) => t.level <= 19))).toBe(true);
  expect(forMoney.every((c) => c.population >= 20)).toBe(true);
  expect(levelBand(80, 'money')).toEqual({ min: 60, max: 79, danger: 80 });
});

test('bosses (MVP-size HP) are never targets and go on the avoid list, whatever their level', () => {
  const w = buildWorld(
    { mobs: { 1: ['Hode', 63, 2000, '', '', 1, '', 2000, 1000, []], 2: ['Phreeoni', 69, 300000, '', '', 1, '', 90000, 30000, []] }, spawns: [['desert', 1, 40], ['desert', 2, 1]], immobile: [] },
    { edges: { town: [portal('desert')], desert: [portal('town')] }, go: [['town', 0, 0]] },
  );
  const [ground] = pickHuntingGrounds(w, { level: 66, fromMap: 'town' });
  expect(ground.targets.map((t) => t.name)).toEqual(['Hode']);
  expect(ground.avoid).toContain('Phreeoni');
});

test('travelCosts: cheapest portal/@go path, shared by every consumer', async () => {
  const { travelCosts, GO_COST } = await import('../src/world.js');
  const costs = travelCosts(world, 'town', 0, 0, { canGo: false });
  expect(costs.toMap('field_a')).toBe(3);
  expect(costs.toMap('field_b')).toBe(6);
  expect(costs.toMap('field_e')).toBe(Infinity); // only via @go
  const withGo = travelCosts(world, 'field_b', 0, 0, { canGo: true });
  expect(withGo.toMap('other_town')).toBe(GO_COST);
  expect(withGo.toMap('field_e')).toBe(GO_COST + 3);
  expect(withGo.toMap('town')).toBe(6); // two portals back beat the jump
});

test('travelCosts on a larger graph matches a brute-force Bellman-Ford', async () => {
  const { travelCosts } = await import('../src/world.js');
  // A 40-map ring with chords: every portal costs 3.
  const edges = {};
  const n = 40;
  for (let i = 0; i < n; i++) {
    edges['m' + i] = [portal('m' + ((i + 1) % n)), portal('m' + ((i + n - 1) % n))];
    if (i % 5 === 0) edges['m' + i].push(portal('m' + ((i + 17) % n)));
  }
  const w = buildWorld({ mobs: {}, spawns: [] }, { edges, go: [], nogo: [] });
  const costs = travelCosts(w, 'm0', 0, 0);
  const dist = new Array(n).fill(Infinity);
  dist[0] = 0;
  for (let round = 0; round < n; round++) {
    for (let i = 0; i < n; i++) for (const e of edges['m' + i]) {
      const j = +e[2].slice(1);
      if (dist[i] + 3 < dist[j]) dist[j] = dist[i] + 3;
    }
  }
  for (let i = 0; i < n; i++) expect(costs.toMap('m' + i)).toBe(dist[i]);
});

test('hunting grounds: a warp is used only when it is cheaper than walking', async () => {
  const w = buildWorld(mob, map, { shops: [] }, { npcs: [['town', 1, 1, 'Warpra', 1, 'x']] });
  w.warpraPlaces = [{ map: 'field_a', lock: 0, name: 'A', groupName: 'Dungeons' }, { map: 'field_b', lock: 0, name: 'B', groupName: 'Dungeons' }];
  const grounds = pickHuntingGrounds(w, { level: 4, fromMap: 'town', limit: 10 });
  expect(grounds.find((c) => c.map === 'field_a').warp).toBe(null); // one portal: walking costs 3, a warp 40+
});

test('loadWorld times out a stalled data server and logs a missing optional file', async () => {
  const { loadWorld } = await import('../src/world.js');
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push([String(url), !!opts?.signal]);
    if (String(url).includes('navi_shop') || String(url).includes('navi_npc')) throw new Error('boom');
    return { ok: true, json: async () => (String(url).includes('navi_mob') ? mob : map) };
  };
  try {
    const w = await loadWorld('http://data.test/');
    expect(w.shops).toEqual([]);
    expect(w.npcs).toEqual([]);
    expect(seen.every(([, hasSignal]) => hasSignal)).toBe(true); // every request has an abort timeout
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    await expect(loadWorld('http://data.test/')).rejects.toThrow('HTTP 503');
  } finally {
    globalThis.fetch = real;
  }
});
