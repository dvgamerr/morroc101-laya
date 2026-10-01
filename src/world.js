import { config } from './config.js';

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
// Instances, arenas, job/quest rooms, interiors: not hunting grounds.
const NOT_A_FIELD = /(^\d@|@|_in\d*$|_in_|pvp|gvg|arena|^job_|^que_|^prt_are|guild|_cas|^poring_w|^force_|^ordeal|^06guild|^te_)/;

export async function loadWorld(baseUrl = config.game.dataUrl) {
  const get = async (file) => {
    const res = await fetch(`${baseUrl.replace(/\/?$/, '/')}${file}`);
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    return res.json();
  };
  const [mob, map] = await Promise.all([get('navi_mob.txt'), get('navi_map.txt')]);
  return buildWorld(mob, map);
}

export function buildWorld(mob, map) {
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
  for (const [from, rows] of Object.entries(map.edges || {})) {
    portals.set(from, [...new Set(rows.filter((r) => r[7] === PORTAL && r[2] !== from).map((r) => r[2]))]);
  }
  const go = (map.go || []).map((r, index) => ({ index, map: r[0] }));
  const noGo = new Set(map.nogo || []);
  return { mobs, immobile, spawnsByMap, portals, go, noGo };
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

/** Level band worth hunting: Renewal gives full EXP within a few levels either side. */
export function levelBand(level) {
  return { min: Math.max(1, level - 6), max: level + 4, danger: level + 10 };
}

/**
 * Rank hunting grounds for a character level. Pure code, no LLM: only real maps
 * with real spawns come out, so the planner can choose but not invent.
 *
 * Score = sum over in-band monsters of count * baseExp / hp (EXP per point of
 * damage, times how many there are), divided by travel distance. Maps holding a
 * crowd of monsters far above the band are dropped as too dangerous.
 */
export function pickHuntingGrounds(world, { level, fromMap, canGo = false, limit = 5, exclude = [] }) {
  const band = levelBand(level);
  const hops = hopsFrom(world, fromMap, { canGo });
  const out = [];
  for (const [map] of world.spawnsByMap) {
    if (NOT_A_FIELD.test(map) || exclude.includes(map) || !hops.has(map)) continue;
    const spawns = spawnsOn(world, map);
    const dangerous = spawns.filter((s) => s.level > band.danger && !ELITE.test(s.name));
    if (dangerous.reduce((n, s) => n + s.count, 0) >= 3) continue;
    const targets = spawns.filter((s) => s.level >= band.min && s.level <= band.max && !ELITE.test(s.name) && s.baseExp > 0);
    const population = targets.reduce((n, s) => n + s.count, 0);
    if (population < 10) continue;
    const value = targets.reduce((v, s) => v + (s.count * s.baseExp) / s.hp, 0);
    const h = hops.get(map);
    out.push({
      map,
      hops: h,
      score: Math.round((value / (1 + 0.35 * h)) * 100) / 100,
      population,
      targets: merge(targets).map(({ name, level, count }) => ({ name, level, count })),
      avoid: merge(spawns.filter((s) => s.level > band.max + 3 || ELITE.test(s.name))).map((s) => s.name),
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
