import { readFileSync } from 'node:fs';

const reference = JSON.parse(readFileSync(new URL('../docs/references/warper/routes.json', import.meta.url), 'utf8'));
export const WARP_PATHS = reference.paths;
export const isWarper = (name) => /^(warpa|warpra|warper)(?:\s*#.*)?$/i.test(String(name || '').trim());
const failed = new Map();
const key = (npc, map) => `${npc.map}:${npc.x}:${npc.y}:${map}`;
export const failWarp = (npc, map) => failed.set(key(npc, map), Date.now() + 10 * 60 * 1000);

export function observeWarpers(world, snap) {
  if (!world) return;
  const seen = (snap.npcs || []).filter((n) => isWarper(n.name));
  if (!seen.length) return;
  world.npcs = world.npcs.filter((n) => n.map !== snap.me.map || !isWarper(n.name));
  world.npcs.push(...seen.map((n) => ({ name: n.name, map: snap.me.map, x: n.x, y: n.y })));
}

export function warperSpots(world) {
  const live = (world.npcs || []).filter((n) => isWarper(n.name));
  return live.length ? live : reference.spots;
}

export function warpOptions(world, costs, destination) {
  const advertised = world.warpraPlaces?.find(p => p.map === destination);
  if (world.warpraPlaces && !advertised) return [];
  if (advertised && advertised.lock !== 0) return [];
  if (!advertised && !WARP_PATHS[destination]) return [];
  const live = (world.npcs || []).filter((n) => isWarper(n.name));
  const maps = new Set(live.map((n) => n.map));
  const spots = [...live, ...reference.spots.filter((n) => !maps.has(n.map))];
  return spots.filter((n) => (failed.get(key(n, destination)) || 0) <= Date.now())
    .map((npc) => ({ npc, path: advertised ? [advertised.groupName, advertised.name] : WARP_PATHS[destination], cost: costs.to(npc.map, npc.x, npc.y) + 40 }))
    .filter((w) => Number.isFinite(w.cost)).sort((a, b) => a.cost - b.cost);
}
