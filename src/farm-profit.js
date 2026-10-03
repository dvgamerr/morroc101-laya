// Cash-to-cash comparison includes travel, sale proceeds and the next restock.
export function observeFarmTrip(trip, me, inTown, huntMap, now = Date.now()) {
  if (!Number.isFinite(me.zeny)) return trip;
  if (inTown) {
    if (trip?.maps.length) return { ...trip, returned: true };
    return { startZeny: me.zeny, maps: [], returned: false };
  }
  if (me.map !== huntMap || trip?.returned) return trip;
  trip ||= { startZeny: me.zeny, maps: [], returned: false };
  if (trip.maps.includes(me.map)) return trip;
  return { ...trip, startedAt: trip.startedAt ?? now, maps: [...trip.maps, me.map] };
}

export function finishFarmTrip(trip, zeny, now = Date.now()) {
  if (!trip?.returned || !trip.maps.length || !Number.isFinite(zeny)) return null;
  // Time runs from arrival at the hunting ground through sale and restocking.
  // Old persisted trips have no start time; do not invent a rate for them.
  const durationMs = Number.isFinite(trip.startedAt) && now > trip.startedAt ? now - trip.startedAt : null;
  const net = zeny - trip.startZeny;
  return {
    maps: trip.maps, startZeny: trip.startZeny, endZeny: zeny, net,
    durationMs, zenyPerMinute: durationMs ? Math.round(net * 60000 / durationMs) : null,
    finishedAt: now,
  };
}
