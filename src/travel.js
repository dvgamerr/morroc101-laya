import { act, query } from './browser.js';
import { log } from './logger.js';
import { createWarpraTravel } from './warpra-travel.js';

const GO_RETRY_MS = 10000;
const ROUTE_SETTLE_MS = 3000;
const ROUTE_RETRIES = 3;
const GO_MAX_TRIES = 2;
const MOVE_GAP_MS = 2500;
const IDLE_MOVE_GAP_MS = 700;
const STUCK_MS = 25000;
const TRIP_TIMEOUT_MS = 15 * 60 * 1000;
const PLANNING_GRACE_MS = 60000;
const DETOUR_AFTER_MS = 8000;
const PAUSE_GAP_MS = 3000;

/**
 * Check Warpra's live board first, unlock the destination when required, then
 * use NaviRoute only for NPC approach or a walking fallback. This walks one
 * leg at a time: a few cells up the planned path per move, step onto portals,
 * type @go when the leg says so.
 *
 * A missing warp confirmation only falls back for this trip. It is not evidence
 * that a town or @go is permanently unavailable.
 */
export function createTravel(page, go = { canGo: true, bad: new Set() }, world = null) {
  const feeder = world ? createTravel(page, go) : null;
  const warpra = world ? createWarpraTravel(page, world, feeder, go) : null;
  const t = {
    dest: null,
    tripNoGo: false, // this trip walks (a town refused @go)
    goTries: 0,
    lastGoAt: 0,
    lastMoveAt: 0,
    lastMap: null,
    lastPos: null,
    lastProgressAt: 0,
    startedAt: 0,
  };

  const useGo = () => go.canGo && !t.tripNoGo;

  async function start(map, { walking = false } = {}) {
    t.dest = map;
    t.lastMap = null;
    t.routeReadyAt = 0;
    t.routeRetries = 0;
    t.wingKey = null;
    t.wingBlocked = new Set();
    t.warpChecked = walking;
    t.goTries = 0;
    t.lastGoAt = 0;
    t.tripNoGo = walking;
    t.walkingOnly = walking;
    t.closedNaid = null;
    t.startedAt = t.lastProgressAt = Date.now();
    if (warpra && !walking) { warpra.start(map); await act(page, 'navi_clear'); }
    else await act(page, 'navi_start', { map, useGo: useGo() });
    log('travel_start', { to: map, useGo: useGo() });
  }

  async function refreshRoute() {
    t.routeReadyAt = Date.now() + ROUTE_SETTLE_MS;
    t.lastProgressAt = Date.now();
    await act(page, 'navi_start', { map: t.dest, useGo: useGo() });
  }

  async function stop() {
    if (!t.dest) return;
    if (warpra) await warpra.stop();
    t.dest = null;
    t.warp = null;
    if (feeder?.dest) await feeder.stop();
    await act(page, 'navi_clear');
  }

  /** @returns {'arrived'|'traveling'|'failed'} */
  async function tick(snap) {
    const me = snap.me;
    const now = Date.now();
    if (!t.dest) return 'failed';
    // Already here: do not leave to inspect or use a warper.
    if (me.map === t.dest) {
      log('travel_arrived', { map: t.dest, seconds: Math.round((now - t.startedAt) / 1000) });
      await stop();
      return 'arrived';
    }
    if (warpra && !t.warpChecked) {
      t.legKind = 'warper';
      const result = await warpra.tick(snap);
      t.lastProgressAt = now;
      if (result === 'traveling') return result;
      if (result === 'failed') { await stop(); return 'failed'; }
      t.warpChecked = true;
      if (result === 'fallback') {
        await warpra.stop();
        t.startedAt = now;
        await refreshRoute();
        log('travel_warper_fallback', { to: t.dest });
        return 'traveling'; // Wait for a fresh route snapshot, not the feeder's old lost flag.
      }
    }

    // Travel paused for something else (a fight, the Healer, a shop): that time isn't
    // being stuck, so the no-progress clock starts over when we come back.
    if (now - (t.lastTickAt || now) > PAUSE_GAP_MS) t.lastProgressAt = now;
    t.lastTickAt = now;

    const pos = `${me.map}:${me.x},${me.y}`;
    if (pos !== t.lastPos) {
      t.lastPos = pos;
      t.lastProgressAt = now;
    }
    if (me.map !== t.lastMap) {
      const changed = t.lastMap !== null;
      t.lastMap = me.map;
      t.goTries = 0;
      t.routeRetries = 0;
      if (changed) {
        // An earlier unconfirmed warp applies only to the map we just left.
        t.tripNoGo = t.walkingOnly;
        log('travel_map_changed', { map: me.map, to: t.dest });
        await refreshRoute();
        return 'traveling';
      }
    }
    if (now < t.routeReadyAt) return 'traveling';
    if (now - t.lastProgressAt > STUCK_MS || now - t.startedAt > TRIP_TIMEOUT_MS) {
      log('travel_failed', { to: t.dest, reason: now - t.lastProgressAt > STUCK_MS ? 'stuck' : 'timeout', map: me.map });
      await stop();
      return 'failed';
    }

    const n = snap.navi;
    // Destination dropped (map change, client reload): ask again.
    if (!n || n.dest !== t.dest) {
      await act(page, 'navi_start', { map: t.dest, useGo: useGo() });
      return 'traveling';
    }
    if (n.lost) {
      if (t.routeRetries < ROUTE_RETRIES) {
        t.routeRetries++;
        log('travel_route_retry', { map: me.map, to: t.dest, attempt: t.routeRetries });
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
        // No map change is inconclusive: never blacklist towns or disable shared @go.
        t.tripNoGo = true;
        log('travel_go_unconfirmed', { map: me.map, index: leg.goIndex, toward: leg.toMap, tries: t.goTries });
        await act(page, 'navi_start', { map: t.dest, useGo: false });
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
    const wings = (snap.inventory || []).filter(i => [23280, 12323, 601].includes(i.ITID) && i.count > 0);
    const wingCount = wings.reduce((n,i) => n + i.count, 0);
    const wing = wings.find(i => i.ITID === 23280) || wings.find(i => i.ITID === 12323) || wings[0];
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
    if (blocked && snap.dialog && snap.dialog.state !== 'ended' && !t.closedNaid) {
      t.closedNaid = snap.dialog.naid;
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
