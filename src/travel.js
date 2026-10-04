import { act, query } from './browser.js';
import { log } from './logger.js';
import { createWarpraTravel, TRIP_TIMEOUT_MS } from './warpra-travel.js';
import { travelCosts } from './world.js';
import { FLY_WING } from './item-ids.js';

const GO_RETRY_MS = 10000;
const ROUTE_SETTLE_MS = 3000;
const ROUTE_RETRIES = 3;
const GO_MAX_TRIES = 2;
const MOVE_GAP_MS = 2500;
const IDLE_MOVE_GAP_MS = 700;
const STUCK_MS = 25000;
const PLANNING_GRACE_MS = 60000;
const DETOUR_AFTER_MS = 8000;
const PAUSE_GAP_MS = 3000;
const GO_REFUSED_MS = 10 * 60 * 1000; // a town where @go went unconfirmed is walked out of for this long
const MAX_VIA = 2;

// Shared through `go` so the warper leg, errands and the hunting trip all learn from one refusal.
const goRefused = (go, map) => (go.refused?.get(map) || 0) > Date.now();
const refuseGo = (go, map) => (go.refused ||= new Map()).set(map, Date.now() + GO_REFUSED_MS);

/**
 * Check Warpra's live board first, unlock the destination when required, then
 * use NaviRoute only for NPC approach or a walking fallback. This walks one
 * leg at a time: a few cells up the planned path per move, step onto portals,
 * type @go when the leg says so.
 *
 * A missing @go confirmation (two tries, no map change) is remembered for GO_REFUSED_MS on that
 * map only, in the shared `go` state: later trips walk out of it instead of repeating the two
 * tries. It never disables @go elsewhere. When walking from such a map finds no route, the trip
 * first walks to the nearest town where @go can still be used (`via`), then asks for the route again.
 */
export function createTravel(page, go = { canGo: true }, world = null) {
  const feeder = world ? createTravel(page, go) : null;
  const warpra = world ? createWarpraTravel(page, world, feeder, go) : null;
  const t = {
    dest: null,
    tripNoGo: false, // this trip walks on the current map (a town refused @go)
    via: null, // town we are walking to, to use @go from there
    viaCount: 0,
    goTries: 0,
    lastGoAt: 0,
    lastMoveAt: 0,
    lastMap: null,
    lastPos: null,
    lastProgressAt: 0,
    startedAt: 0,
  };

  const useGo = () => go.canGo && !t.tripNoGo && !t.via;
  const routeDest = () => t.via || t.dest;

  /** Nearest town (by walking) where @go may still be used. */
  function pickVia(me) {
    if (!world || !go.canGo || t.walkingOnly || t.viaCount >= MAX_VIA) return null;
    const costs = travelCosts(world, me.map, me.x, me.y, { canGo: false });
    let best = null;
    for (const g of world.go) {
      if (g.map === me.map || world.noGo.has(g.map) || goRefused(go, g.map)) continue;
      const cost = costs.toMap(g.map);
      if (Number.isFinite(cost) && (!best || cost < best.cost)) best = { map: g.map, cost };
    }
    return best?.map || null;
  }

  async function start(map, { walking = false } = {}) {
    t.dest = map;
    t.lastMap = null;
    t.routeReadyAt = 0;
    t.routeRetries = 0;
    t.wingKey = null;
    t.wingBlocked = new Set();
    // Skip Warpra when walking is forced or the live board is known not to list this map.
    t.warpChecked = walking || !(warpra?.serves(map) ?? false);
    t.goTries = 0;
    t.lastGoAt = 0;
    t.tripNoGo = walking;
    t.via = null;
    t.viaCount = 0;
    t.walkingOnly = walking;
    t.closedNaids = new Set();
    t.startedAt = t.lastProgressAt = Date.now();
    if (warpra && !t.warpChecked) { warpra.start(map); await act(page, 'navi_clear'); }
    else await act(page, 'navi_start', { map, useGo: useGo() });
    log('travel_start', { to: map, useGo: useGo() });
  }

  async function refreshRoute() {
    t.routeReadyAt = Date.now() + ROUTE_SETTLE_MS;
    t.lastProgressAt = Date.now();
    await act(page, 'navi_start', { map: routeDest(), useGo: useGo() });
  }

  async function stop() {
    if (!t.dest) return;
    if (warpra) await warpra.stop();
    t.dest = null;
    t.via = null;
    if (feeder?.dest) await feeder.stop();
    await act(page, 'navi_clear');
  }

  /** @returns {'arrived'|'traveling'|'failed'} */
  async function tick(snap) {
    const me = snap.me;
    const now = Date.now();
    if (!t.dest) return 'failed';
    // Travel paused for something else (a fight, the Healer, a shop): that time isn't
    // being stuck and doesn't count against the trip budget, so both clocks start over when we come back.
    const pausedMs = now - (t.lastTickAt || now);
    if (pausedMs > PAUSE_GAP_MS) {
      t.lastProgressAt = now;
      t.startedAt += pausedMs;
    }
    t.lastTickAt = now;
    // Already here: do not leave to inspect or use a warper. A locked Warpra town is the exception:
    // standing in it does not unlock it, so the unlock talk still has to happen.
    if (me.map === t.dest && !(warpra && !t.warpChecked && warpra.needsUnlockAt(me.map))) {
      log('travel_arrived', { map: t.dest, seconds: Math.round((now - t.startedAt) / 1000) });
      await stop();
      return 'arrived';
    }
    if (warpra && !t.warpChecked) {
      t.legKind = 'warper';
      const result = await warpra.tick(snap);
      t.lastProgressAt = now;
      if (result === 'traveling') return result;
      t.warpChecked = true;
      if (result === 'arrived') {
        log('travel_arrived', { map: t.dest, via: 'warpra', seconds: Math.round((now - t.startedAt) / 1000) });
        await stop();
        return 'arrived';
      }
      // 'fallback' (or any Warpra failure): carry on by walking / @go for this trip.
      await warpra.stop();
      t.startedAt = now;
      await refreshRoute();
      log('travel_warper_fallback', { to: t.dest, result });
      return 'traveling'; // Wait for a fresh route snapshot, not the feeder's old lost flag.
    }

    const pos = `${me.map}:${me.x},${me.y}`;
    if (pos !== t.lastPos) {
      t.lastPos = pos;
      t.lastProgressAt = now;
    }
    if (me.map !== t.lastMap) {
      const changed = t.lastMap !== null;
      const wasNoGo = t.tripNoGo;
      t.lastMap = me.map;
      t.goTries = 0;
      t.routeRetries = 0;
      // A refusal or skipped @go applies only to the map it happened on; a remembered refusal
      // from an earlier trip applies when we stand on that map again.
      t.tripNoGo = t.walkingOnly || goRefused(go, me.map);
      if (changed || t.tripNoGo !== wasNoGo) {
        if (changed) log('travel_map_changed', { map: me.map, to: t.dest });
        await refreshRoute();
        return 'traveling';
      }
    }
    if (t.via && me.map === t.via) {
      log('travel_via_arrived', { via: t.via, to: t.dest });
      t.via = null;
      t.tripNoGo = goRefused(go, me.map);
      await refreshRoute();
      return 'traveling';
    }
    if (now < t.routeReadyAt) return 'traveling';
    if (now - t.lastProgressAt > STUCK_MS || now - t.startedAt > TRIP_TIMEOUT_MS) {
      log('travel_failed', { to: t.dest, reason: now - t.lastProgressAt > STUCK_MS ? 'stuck' : 'timeout', map: me.map });
      await stop();
      return 'failed';
    }

    const n = snap.navi;
    // Destination dropped (map change, client reload): ask again.
    if (!n || n.dest !== routeDest()) {
      await act(page, 'navi_start', { map: routeDest(), useGo: useGo() });
      return 'traveling';
    }
    if (n.lost) {
      if (t.routeRetries < ROUTE_RETRIES) {
        t.routeRetries++;
        log('travel_route_retry', { map: me.map, to: t.dest, attempt: t.routeRetries });
        await refreshRoute();
        return 'traveling';
      }
      const via = !t.via && !useGo() ? pickVia(me) : null;
      if (via) {
        t.via = via;
        t.viaCount++;
        log('travel_via_go_town', { map: me.map, via, to: t.dest });
        await refreshRoute();
        return 'traveling';
      }
      log('travel_failed', { to: t.dest, reason: useGo() ? 'no route' : 'no walking route', map: me.map, useGo: useGo() });
      await stop();
      return 'failed';
    }
    const leg = n.leg;
    if (leg) t.routeRetries = 0;
    t.legKind = leg ? leg.kind : null;
    if (!leg) {
      // Still planning (or NaviData still loading): standing still isn't being stuck, for a while.
      if (now - t.startedAt < PLANNING_GRACE_MS) t.lastProgressAt = now;
      return 'traveling';
    }

    if (leg.kind === 'go') {
      // "@go to the town we're standing in": the warp lands us in the middle of the same town and
      // the route asks for it again — Morroc seven times in six minutes, never leaving. Walk instead.
      if (leg.toMap === me.map) {
        t.tripNoGo = true;
        log('travel_skip_go', { map: me.map, index: leg.goIndex, to: t.dest });
        await refreshRoute();
        return 'traveling';
      }
      if (snap.dialog && snap.dialog.state !== 'ended') {
        const action = snap.dialog.state === 'next' ? 'npc_next' : 'npc_close';
        const closed = await act(page, action, { naid: snap.dialog.naid });
        log('travel_go_dialog', { state: snap.dialog.state, closed });
        t.lastProgressAt = now;
        return 'traveling'; // Re-read the dialog before sending or counting an attempt.
      }
      if (now - t.lastGoAt < GO_RETRY_MS) return 'traveling';
      if (t.goTries >= GO_MAX_TRIES) {
        // No map change is inconclusive: remember it for this map only, never disable @go elsewhere.
        t.tripNoGo = true;
        refuseGo(go, me.map);
        log('travel_go_unconfirmed', { map: me.map, index: leg.goIndex, toward: leg.toMap, tries: t.goTries });
        await act(page, 'navi_start', { map: routeDest(), useGo: false });
        return 'traveling';
      }
      t.lastGoAt = now;
      if (me.sitting) await act(page, 'stand');
      // Read what the server says back: a refusal usually explains itself (cooldown, banned town).
      let reply;
      try { reply = await query(page, `@go ${leg.goIndex}`, 1200); }
      catch (err) {
        log('travel_go_send_error', { index: leg.goIndex, error: err.message });
        return 'traveling';
      }
      t.goTries++;
      log('travel_go', { index: leg.goIndex, toward: leg.toMap, reply: reply.join(' | ').slice(0, 160) });
      return 'traveling';
    }

    // portal / arrive: walk. Near the portal, step exactly onto it.
    const gap = me.walking ? MOVE_GAP_MS : IDLE_MOVE_GAP_MS;
    if (now - t.lastMoveAt < gap) return 'traveling';
    t.lastMoveAt = now;
    if (me.sitting) await act(page, 'stand');
    const dLeg = Math.max(Math.abs(me.x - leg.x), Math.abs(me.y - leg.y));
    const wingKey = me.map + ':' + leg.x + ':' + leg.y;
    if (t.wingKey !== wingKey) {
      t.wingKey = wingKey; t.wingTries = 0; t.wingDone = false; t.wingPending = null;
    }
    if (t.wingPending) {
      const pending = t.wingPending;
      const moved = Math.max(Math.abs(me.x - pending.x), Math.abs(me.y - pending.y)) > 8;
      const remaining = (snap.inventory || []).filter(i => i.ITID === pending.item).reduce((n,i) => n + i.count, 0);
      if (moved && remaining < pending.count) {
        t.wingDone = dLeg < pending.distance || dLeg <= 40 || t.wingTries >= 3;
        t.wingPending = null;
        t.lastProgressAt = now;
        log('travel_wing_landed', { map:me.map, before:pending.distance, after:dLeg, walk:t.wingDone });
        await act(page, 'navi_start', { map:t.dest, useGo:useGo() });
        return 'traveling';
      }
      if (now - pending.at < 5000) return 'traveling';
      t.wingPending = null; t.wingDone = true;
      t.wingBlocked.add(me.map);
      log('travel_wing_unavailable', {map:me.map});
    }
    const wings = (snap.inventory || []).filter(i => FLY_WING.includes(i.ITID) && i.count > 0);
    const wingCount = wings.reduce((n,i) => n + i.count, 0);
    const wing = wings.find(i => i.ITID === FLY_WING[0]) || wings.find(i => i.ITID === FLY_WING[1]) || wings[0];
    if (dLeg > 100 && !t.wingDone && !t.wingBlocked.has(me.map) && t.wingTries < 3 &&
        wingCount > 5 && wing && !me.dead && (!snap.dialog || snap.dialog.state === 'ended') &&
        now - (t.lastWingAt || 0) >= 3000) {
      if (me.sitting) await act(page, 'stand');
      t.lastWingAt = now; t.wingTries++;
      if (await act(page, 'use_item', {index:wing.index}) === false) {
        t.wingDone = true; t.wingBlocked.add(me.map);
      } else {
        t.wingPending = {at:now,x:me.x,y:me.y,distance:dLeg,item:wing.ITID,count:wings.filter(i => i.ITID === wing.ITID).reduce((n,i) => n+i.count,0)};
        log('travel_wing', {map:me.map,item:wing.ITID,distance:dLeg,attempt:t.wingTries});
        return 'traveling';
      }
    }
    const blocked = now - t.lastProgressAt > DETOUR_AFTER_MS;
    // Not moving: a conversation the server still thinks is open freezes walking and @go.
    // Close the last one we had before trying anything cleverer.
    if (blocked && snap.dialog && snap.dialog.state !== 'ended' && !t.closedNaids.has(snap.dialog.naid)) {
      t.closedNaids.add(snap.dialog.naid);
      await act(page, 'npc_close', { naid: snap.dialog.naid });
      log('travel_close_dialog', { naid: snap.dialog.naid });
    }
    if (dLeg <= 3) await act(page, 'move', { x: leg.x, y: leg.y });
    else if (n.ahead && !blocked) await act(page, 'move', { x: n.ahead.x, y: n.ahead.y });
    // No client path yet, or following it isn't getting us anywhere: our own BFS round the obstacle.
    else await act(page, 'walk_to', { x: leg.x, y: leg.y });
    return 'traveling';
  }

  return {
    start,
    stop,
    tick,
    get dest() {
      return t.dest;
    },
    get inDialog() { return !!warpra?.inDialog; },
    get canGo() {
      return go.canGo;
    },
    /** What the route does next: 'go' (an @go warp), a walk, or null while planning. */
    get legKind() {
      return t.legKind || null;
    },
  };
}
