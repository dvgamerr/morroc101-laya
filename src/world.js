import { dropValue } from './drop-values.js';
import { config } from './config.js';
import { warpOptions } from './warper-reference.js';

/**
 * World knowledge from the client's own navigation bundles (the same files the
 * game loads into NaviData): every monster with level/HP/EXP, where each one
 * spawns and how many, and the portal graph between maps.
 *
 * navi_mob.txt  { mobs: { id: [name, level, hp, race, element, elLv, size, baseExp, jobExp, drops] },
 *                 spawns: [[map, mobId, count]], immobile: [mobId] }
 * navi_map.txt  { edges: { map: [[x, y, toMap, tx, ty, w, h, kind, label, zeny, ...]] },
 *                 go: [[map, x, y]], nogo: [map] }
 */

// Edge kinds in navi_map (NaviData.KIND). Only portals are walked by the agent;
// Kafra/NPC warps need dialog handling it doesn't do yet.
const PORTAL = 0;
// The client's own list of variants that hit far harder than the monster they're named after.
const ELITE = /(Solid|Swift|Elusive|Furious|Angry|Ringleader|Nightmare|Wanderer \(Nig)/;
// Bosses (MVPs, mini-bosses) aren't flagged in the data: their HP gives them away. Never a target —
// pulling a Hode next to Phreeoni and its slaves put seven on us.
export const BOSS_HP = 30000;
const isBoss = (s) => (s.hp || 0) >= BOSS_HP;

/** Names of bosses and mini-bosses (boss-sized HP, or one of the client's elite variants). */
export function bossNames(world) {
  const names = new Set();
  for (const m of world?.mobs?.values() || []) if (isBoss(m) || ELITE.test(m.name)) names.add(m.name);
  return names;
}
// Instances, arenas, job/quest rooms, interiors: not hunting grounds.
const NOT_A_FIELD = /(^\d@|@|_in\d*$|_in_|pvp|gvg|arena|^job_|^que_|^prt_are|guild|_cas|^poring_w|^force_|^ordeal|^06guild|^te_)/;

export async function loadWorld(baseUrl = config.game.dataUrl) {
  const get = async (file) => {
    const res = await fetch(`${baseUrl.replace(/\/?$/, '/')}${file}`);
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    return res.json();
  };
  const [mob, map, shop, npc] = await Promise.all([
    get('navi_mob.txt'),
    get('navi_map.txt'),
    get('navi_shop.txt').catch(() => ({ shops: [] })),
    get('navi_npc.txt').catch(() => ({ npcs: [] })),
  ]);
  return buildWorld(mob, map, shop, npc);
}

/** navi_shop.txt { shops: [[map, x, y, npcName, [[itemId, price(-1 = item's own)]], region]] } */
export function shopsSelling(world, itemId) {
  return world.shops.filter((s) => s.items.includes(itemId));
}

/** NPCs by exact name (navi_npc.txt rows: [map, x, y, name, sprite, region]), instances left out. */
export function findNpcs(world, name) {
  return world.npcs.filter((n) => n.name === name && !/^d@/.test(n.map));
}

export function buildWorld(mob, map, shop = { shops: [] }, npc = { npcs: [] }) {
  const immobile = new Set(mob.immobile || []);
  const mobs = new Map();
  for (const [id, r] of Object.entries(mob.mobs || {})) {
    mobs.set(+id, { id: +id, name: r[0], level: r[1], hp: r[2] || 1, baseExp: r[7] || 0, jobExp: r[8] || 0, drops: r[9] || [] });
  }
  const spawnsByMap = new Map();
  for (const [m, id, count] of mob.spawns || []) {
    if (!spawnsByMap.has(m)) spawnsByMap.set(m, []);
    spawnsByMap.get(m).push({ id, count });
  }
  const portals = new Map();
  const edges = new Map(); // map -> [{x, y, to, tx, ty}] walkable portals with their cells
  for (const [from, rows] of Object.entries(map.edges || {})) {
    const out = rows.filter((r) => r[7] === PORTAL && r[2] !== from);
    portals.set(from, [...new Set(out.map((r) => r[2]))]);
    edges.set(from, out.map((r) => ({ x: r[0], y: r[1], to: r[2], tx: r[3], ty: r[4] })));
  }
  const go = (map.go || []).map((r, index) => ({ index, map: r[0], x: r[1] || 0, y: r[2] || 0 }));
  // Real walking distances between a map's graph points (portal cells), where the bundle has them.
  const walks = new Map();
  for (const [m, w] of Object.entries(map.walks || {})) {
    const index = new Map((w.p || []).map(([x, y], i) => [x * 1000 + y, i]));
    const dist = new Map();
    const d = w.d || [];
    for (let i = 0; i + 2 < d.length; i += 3) dist.set(d[i] * 4096 + d[i + 1], d[i + 2]);
    walks.set(m, { index, dist, factor: w.f || 1 });
  }
  const noGo = new Set(map.nogo || []);
  const shops = (shop.shops || []).map((r) => ({ map: r[0], x: r[1], y: r[2], name: r[3], items: (r[4] || []).map((i) => i[0]) }));
  const npcs = (npc.npcs || []).map((r) => ({ map: r[0], x: r[1], y: r[2], name: r[3] }));
  return { mobs, immobile, spawnsByMap, portals, edges, go, noGo, walks, shops, npcs };
}

/** A map with no monster spawns (or an @go destination) is a town. */
export function isTown(world, map) {
  return !(world.spawnsByMap.get(map) || []).some((s) => !world.immobile.has(s.id)) || world.go.some((g) => g.map === map);
}

/** What actually spawns on a map, worth knowing for fighting. */
export function spawnsOn(world, map) {
  return (world.spawnsByMap.get(map) || [])
    .filter((s) => !world.immobile.has(s.id) && world.mobs.has(s.id))
    .map((s) => ({ ...world.mobs.get(s.id), count: s.count }));
}

// ---- Travel cost, in cells walked ------------------------------------------------
// @go is a cast plus a loading screen: worth about this many cells of walking.
export const GO_COST = 40;
const AVOIDED_CROWD = 10; // this many avoided monsters on a map rules it out
const PORTAL_COST = 3; // the loading screen behind every portal

/**
 * Cells to walk between two points on one map: the bundle's measured walk when it
 * has the pair (it knows the walls), else the straight line scaled by the map's
 * walk factor. Infinity when the bundle says there's no way.
 */
export function walkCells(world, map, x1, y1, x2, y2) {
  const w = world.walks.get(map);
  if (w) {
    const a = w.index.get(x1 * 1000 + y1);
    const b = w.index.get(x2 * 1000 + y2);
    if (a !== undefined && b !== undefined) {
      const d = w.dist.get(a * 4096 + b) ?? w.dist.get(b * 4096 + a);
      if (d === -1) return Infinity;
      if (d !== undefined) return d;
    }
  }
  const dx = Math.abs(x1 - x2);
  const dy = Math.abs(y1 - y2);
  return (Math.max(dx, dy) + 0.41 * Math.min(dx, dy)) * (w ? w.factor : 1);
}

/**
 * Cheapest way from (map, x, y) to everywhere: Dijkstra over portal cells, with
 * @go to every town as one fixed-cost jump when allowed. Returns
 *   toMap(map)        cost to arrive on a map at all
 *   to(map, x, y)     cost to stand at that cell (arrival + the walk from there)
 */
export function travelCosts(world, from, x, y, { canGo = false } = {}) {
  const best = new Map(); // "map:x:y" -> cost
  const arrivals = new Map(); // map -> [{x, y, cost}]
  const heap = [[0, from, x, y]];
  const push = (c, m, px, py) => {
    const k = `${m}:${px}:${py}`;
    if ((best.get(k) ?? Infinity) <= c) return;
    best.set(k, c);
    heap.push([c, m, px, py]);
  };
  best.set(`${from}:${x}:${y}`, 0);
  while (heap.length) {
    // Small graph (a few thousand portal cells): a linear-scan min is plenty.
    let bi = 0;
    for (let i = 1; i < heap.length; i++) if (heap[i][0] < heap[bi][0]) bi = i;
    const [c, m, px, py] = heap.splice(bi, 1)[0];
    if (c > (best.get(`${m}:${px}:${py}`) ?? Infinity)) continue;
    if (!arrivals.has(m)) arrivals.set(m, []);
    arrivals.get(m).push({ x: px, y: py, cost: c });
    for (const e of world.edges.get(m) || []) {
      const walk = walkCells(world, m, px, py, e.x, e.y);
      if (walk !== Infinity) push(c + walk + PORTAL_COST, e.to, e.tx, e.ty);
    }
    if (canGo && !world.noGo.has(m)) for (const g of world.go) push(c + GO_COST, g.map, g.x, g.y);
  }
  return {
    toMap: (map) => (arrivals.has(map) ? Math.min(...arrivals.get(map).map((a) => a.cost)) : Infinity),
    to: (map, tx, ty) => {
      const list = arrivals.get(map);
      if (!list) return Infinity;
      return Math.min(...list.map((a) => a.cost + walkCells(world, map, a.x, a.y, tx, ty)));
    },
  };
}

/** Fewest map changes from `from` to every map: portals, plus @go to towns when allowed. */
export function hopsFrom(world, from, { canGo }) {
  const dist = new Map([[from, 0]]);
  const queue = [from];
  while (queue.length) {
    const m = queue.shift();
    const d = dist.get(m);
    const next = [...(world.portals.get(m) || [])];
    if (canGo && !world.noGo.has(m)) next.push(...world.go.map((g) => g.map));
    for (const n of next) {
      if (!dist.has(n)) {
        dist.set(n, d + 1);
        queue.push(n);
      }
    }
  }
  return dist;
}

/** Owner's hunting band uses the real player level for every hunting goal. */
export function levelBand(level, goal = 'level', priestSupport = false) {
  return { min: Math.max(1, level - (goal === 'money' ? 20 : 10)), max: Math.max(1, level - 1), danger: goal === 'money' ? level : level + 3 };
}

/** Money grounds need a crowd: drops come per kill. */
const MIN_POPULATION = { level: 10, money: 20 };

/**
 * Rank hunting grounds for a character level. Pure code, no LLM: only real maps
 * with real spawns come out, so the planner can choose but not invent.
 *
 * Score (goal 'level') = sum over in-band monsters of count * baseExp / hp (EXP per point of
 * damage, times how many there are). Score (goal 'money') = sum of count * drops / sqrt(hp): many
 * monsters that die fast and drop things. Either is divided by travel cost in cells (travelCosts).
 * Priest support expands the level band and uses baseExp / sqrt(hp) to favor higher EXP per kill.
 * Maps holding a crowd of monsters far above the band are dropped as too dangerous.
 */
export function pickHuntingGrounds(world, { level, goal = 'level', priestSupport = false, fromMap, fromX = 0, fromY = 0, canGo = false, limit = 5, exclude = [], avoid = [] }) {
  const band = levelBand(level, goal, priestSupport);
  const hops = hopsFrom(world, fromMap, { canGo });
  const travel = travelCosts(world, fromMap, fromX, fromY, { canGo });
  const out = [];
  for (const [map] of world.spawnsByMap) {
    if (NOT_A_FIELD.test(map) || exclude.includes(map)) continue;
    const warp = warpOptions(world, travel, map)[0];
    if (!hops.has(map) && !warp) continue;
    const spawns = spawnsOn(world, map);
    // Monsters we learned to stay away from (they stun/silence us): a map full of them is no
    // hunting ground even if we don't attack them — they come to us.
    if (spawns.filter((s) => avoid.includes(s.name)).reduce((n, s) => n + s.count, 0) >= AVOIDED_CROWD) continue;
    const dangerous = spawns.filter((s) => s.level > band.danger && !ELITE.test(s.name));
    if (dangerous.reduce((n, s) => n + s.count, 0) >= 3) continue;
    const targets = spawns.filter((s) => s.level >= band.min && s.level <= band.max && !ELITE.test(s.name) && !isBoss(s) && s.baseExp > 0 && !avoid.includes(s.name));
    const population = targets.reduce((n, s) => n + s.count, 0);
    if (population < (MIN_POPULATION[goal] ?? 10)) continue;
    const value =
      goal === 'money'
        ? targets.reduce((v, s) => v + (s.count * dropValue(s.drops).knownZenyPerKill) / Math.sqrt(s.hp), 0)
        // With healing support, give more weight to EXP per kill while still penalizing HP.
        : targets.reduce((v, s) => v + (s.count * s.baseExp) / ((priestSupport ? Math.sqrt(s.hp) : s.hp) * (1 + Math.abs(s.level - level) / 3)), 0);
    const h = warp ? (hops.get(warp.npc.map) ?? 0) + 1 : hops.get(map);
    // Distance in cells walked (portals + @go), not just map count: two "1 hop" maps can be
    // a minute apart. ~150 cells is about what a map change used to stand for.
    const cost = Math.round(Math.min(warp ? warp.cost : travel.toMap(map), 2000));
    out.push({
      map,
      hops: h,
      cost,
      warp: warp ? { npc: warp.npc.name, town: warp.npc.map, path: warp.path } : null,
      score: Math.round((value / (1 + cost / 150)) * 100) / 100,
      population,
      targets: merge(targets).map(({ name, level, count, hp, baseExp, drops }) => ({ name, level, count, hp, baseExp, drops: dropValue(drops) })),
      avoid: merge(spawns.filter((s) => s.level > band.max + 3 || ELITE.test(s.name) || isBoss(s))).map((s) => s.name),
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// The same monster can have several spawn rows on one map.
function merge(list) {
  const byName = new Map();
  for (const s of list) {
    const prev = byName.get(s.name);
    if (prev) prev.count += s.count;
    else byName.set(s.name, { ...s });
  }
  return [...byName.values()].sort((a, b) => b.count - a.count);
}
