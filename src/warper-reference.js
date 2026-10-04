import { readFileSync } from 'node:fs';
import { GO_COST } from './world.js';

const reference = JSON.parse(readFileSync(new URL('../docs/references/warper/routes.json', import.meta.url), 'utf8'));
export const WARP_PATHS = reference.paths;
export const isWarper = (name) => /^(warpa|warpra|warper)(?:\s*#.*)?$/i.test(String(name || '').trim());

export function observeWarpers(world, snap) {
  if (!world) return;
  const seen = (snap.npcs || []).filter((n) => isWarper(n.name));
  if (!seen.length) return;
  world.npcs = world.npcs.filter((n) => n.map !== snap.me.map || !isWarper(n.name));
  world.npcs.push(...seen.map((n) => ({ name: n.name, map: snap.me.map, x: n.x, y: n.y })));
}

/**
 * Warper NPCs we can really use: the ones in the server's NPC directory or seen live. The rAthena
 * reference spots (named "Warper", ~43 towns) are only a fallback for when the directory has none:
 * the real NPC is "Warpra" and exists in far fewer towns.
 */
export function warperSpots(world) {
  const live = (world.npcs || []).filter((n) => isWarper(n.name));
  return live.length ? live : reference.spots;
}

/** Is this destination worth a trip to Warpra? False once the live board is known and does not list it. */
export function warpraMayServe(world, destination) {
  if (world.warpraPlaces) return world.warpraPlaces.some((p) => p.map === destination);
  return true; // Board not read yet: ask it once, the answer is cached in world.warpraPlaces.
}

export function warpOptions(world, costs, destination) {
  const advertised = world.warpraPlaces?.find((p) => p.map === destination);
  if (world.warpraPlaces && !advertised) return [];
  if (advertised && advertised.lock !== 0) return [];
  if (!advertised && !WARP_PATHS[destination]) return [];
  return warperSpots(world)
    .map((npc) => ({ npc, path: advertised ? [advertised.groupName, advertised.name] : WARP_PATHS[destination], cost: costs.to(npc.map, npc.x, npc.y) + GO_COST }))
    .filter((w) => Number.isFinite(w.cost))
    .sort((a, b) => a.cost - b.cost);
}
