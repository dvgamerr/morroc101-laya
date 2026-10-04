// Cash-to-cash comparison includes travel, sale proceeds and the next restock.
const expProgress = (me) => Number.isFinite(me.baseLevel) && Number.isFinite(me.baseExp) && me.baseExpNext > 0
  ? (me.baseLevel + me.baseExp / me.baseExpNext) * 100 : null;

export function abortFarmTravel(trip, reason) {
  if (!trip?.startedAt || trip.maps.length || !trip.huntMap) return trip;
  return { ...trip, routeFailure: reason };
}

export function settleFarmErrand(trip, done) {
  if (trip?.maps.length && done.ok && done.sold > 0) return { ...trip, saleSettled: true };
  if (trip?.routeFailure !== 'กลับเติมเสบียง/ขายของก่อนถึงแมพล่า' ||
      trip.maps.length || done.sold || done.bought?.length) return trip;
  const { routeFailure, ...outbound } = trip;
  return { ...outbound, returned: false };
}

export function observeFarmTrip(trip, me, inTown, huntMap, now = Date.now(), goal = 'money') {
  if (!Number.isFinite(me.zeny)) return trip;
  const progress = expProgress(me);
  const fresh = () => ({ startZeny: me.zeny, maps: [], returned: false, goal,
    startLevel: me.baseLevel, startProgress: progress, lastZeny: me.zeny, observedSpend: 0 });
  if (trip) trip = { ...trip,
    observedSpend: (trip.observedSpend || 0) + Math.max(0, (trip.lastZeny ?? me.zeny) - me.zeny),
    lastZeny: me.zeny,
    expInvalid: trip.expInvalid || (Number.isFinite(trip.startLevel) && me.baseLevel < trip.startLevel),
  };
  if (inTown) {
    if (trip?.maps.length || trip?.routeFailure) return { ...trip, returned: true };
    // A town can be a waypoint. Keep outbound costs until hunting or an
    // explicit supply/escape interruption determines the outcome.
    if (trip?.startedAt) return trip;
    return fresh();
  }
  // Include outbound travel in the elapsed time, even before reaching the hunt map.
  trip ||= fresh();
  // Leaving a detour without a sale continues the same cash-to-cash trip.
  if (trip.returned && !trip.saleSettled && !trip.routeFailure && trip.huntMap === huntMap) trip = { ...trip, returned: false };
  if (!trip.returned) trip = { ...trip, startedAt: trip.startedAt ?? now,
    huntMap: trip.huntMap ?? huntMap,
    routeMaps: [...new Set([...(trip.routeMaps || []), me.map])] };
  if (me.map !== huntMap || trip?.returned || trip.routeFailure) return trip;
  if (trip.maps.includes(me.map)) return trip;
  return { ...trip, startedAt: trip.startedAt ?? now, maps: [...trip.maps, me.map] };
}

export function finishFarmTrip(trip, zeny, now = Date.now(), me = null, requireSale = false) {
  if (!trip?.returned || (!trip.maps.length && !trip.routeFailure) || !Number.isFinite(zeny)) return null;
  // Visiting a town (including a routing detour) doesn't value unsold loot.
  if (requireSale && !trip.routeFailure && !trip.saleSettled) return null;
  // Time includes outbound travel, hunting, return, sale and restocking.
  // Old persisted trips have no start time; do not invent a rate for them.
  const durationMs = Number.isFinite(trip.startedAt) && now > trip.startedAt ? now - trip.startedAt : null;
  const net = zeny - trip.startZeny;
  const endProgress = me && expProgress(me);
  const expPercent = !trip.expInvalid && Number.isFinite(trip.startProgress) && Number.isFinite(endProgress)
    && me.baseLevel >= trip.startLevel ? endProgress - trip.startProgress : null;
  const observedSpend = (trip.observedSpend || 0) + Math.max(0, (trip.lastZeny ?? zeny) - zeny);
  return {
    goal: trip.goal || 'money', startLevel: trip.startLevel, endLevel: me?.baseLevel,
    huntMap: trip.huntMap, routeMaps: trip.routeMaps || [], routeFailure: trip.routeFailure || null,
    expPercent, expPercentPerMinute: expPercent !== null && durationMs ? expPercent * 60000 / durationMs : null,
    observedSpend, zenyPerExpPercent: expPercent > 0 ? observedSpend / expPercent : null,
    maps: trip.maps, startZeny: trip.startZeny, endZeny: zeny, net,
    durationMs, zenyPerMinute: durationMs ? Math.round(net * 60000 / durationMs) : null,
    finishedAt: now,
  };
}
