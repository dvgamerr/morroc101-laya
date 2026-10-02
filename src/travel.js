import { act, query } from './browser.js';
import { log } from './logger.js';
import { learn } from './lessons.js';

const GO_RETRY_MS = 10000;
const GO_MAX_TRIES = 2;
const GO_BAD_TOWNS_TO_DISABLE = 3; // only give up on @go entirely after this many towns refuse it
const MOVE_GAP_MS = 2500;
const IDLE_MOVE_GAP_MS = 700;
const STUCK_MS = 25000;
const TRIP_TIMEOUT_MS = 15 * 60 * 1000;
const PLANNING_GRACE_MS = 60000;
const DETOUR_AFTER_MS = 8000;
const PAUSE_GAP_MS = 3000;

/**
 * Get to another map. The client's NaviRoute plans the whole trip (portals and
 * @go only — the agent can't drive Kafra/NPC dialogs yet); this walks it one
 * leg at a time: a few cells up the planned path per move, step onto portals,
 * type @go when the leg says so.
 *
 * Whether @go works is learned, not assumed. A town that doesn't take us after two
 * tries is marked bad and this trip walks instead; @go as a whole is switched off only
 * when several towns refuse it. `go` is shared by every travel instance (hunting,
 * shopping, job change) so they agree on it.
 */
export function createTravel(page, go = { canGo: true, bad: new Set() }) {
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

  async function start(map) {
    t.dest = map;
    t.goTries = 0;
    t.tripNoGo = false;
    t.closedNaid = null;
    t.startedAt = t.lastProgressAt = Date.now();
    await act(page, 'navi_start', { map, useGo: useGo() });
    log('travel_start', { to: map, useGo: useGo() });
  }

  async function stop() {
    if (!t.dest) return;
    t.dest = null;
    await act(page, 'navi_clear');
  }

  /** @returns {'arrived'|'traveling'|'failed'} */
  async function tick(snap) {
    const me = snap.me;
    const now = Date.now();
    if (!t.dest) return 'failed';
    if (me.map === t.dest) {
      log('travel_arrived', { map: t.dest, seconds: Math.round((now - t.startedAt) / 1000) });
      await stop();
      return 'arrived';
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
      t.lastMap = me.map;
      t.goTries = 0;
    }
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
      log('travel_failed', { to: t.dest, reason: useGo() ? 'no route' : 'no walking route', map: me.map, useGo: useGo() });
      await stop();
      return 'failed';
    }
    const leg = n.leg;
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
        await act(page, 'navi_start', { map: t.dest, useGo: false });
        return 'traveling';
      }
      if (now - t.lastGoAt < GO_RETRY_MS) return 'traveling';
      if (t.goTries >= GO_MAX_TRIES) {
        // Typed it twice and we're still here: that town refuses us. Walk this trip; turn
        // @go off altogether only when several towns have refused.
        go.bad.add(leg.goIndex);
        t.tripNoGo = true;
        if (go.bad.size >= GO_BAD_TOWNS_TO_DISABLE) go.canGo = false;
        log('travel_no_go', { map: me.map, index: leg.goIndex, toward: leg.toMap, badTowns: go.bad.size, goOff: !go.canGo });
        learn(`@go ${leg.goIndex} (${leg.toMap}) ใช้ไม่ได้จาก ${me.map} — ต้องเดินไปแทน`);
        await act(page, 'navi_start', { map: t.dest, useGo: false });
        return 'traveling';
      }
      t.goTries++;
      t.lastGoAt = now;
      if (me.sitting) await act(page, 'stand');
      // Read what the server says back: a refusal usually explains itself (cooldown, banned town).
      const reply = await query(page, `@go ${leg.goIndex}`, 1200).catch(() => []);
      log('travel_go', { index: leg.goIndex, toward: leg.toMap, reply: reply.join(' | ').slice(0, 160) });
      return 'traveling';
    }

    // portal / arrive: walk. Near the portal, step exactly onto it.
    const gap = me.walking ? MOVE_GAP_MS : IDLE_MOVE_GAP_MS;
    if (now - t.lastMoveAt < gap) return 'traveling';
    t.lastMoveAt = now;
    if (me.sitting) await act(page, 'stand');
    const dLeg = Math.max(Math.abs(me.x - leg.x), Math.abs(me.y - leg.y));
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
    get canGo() {
      return go.canGo;
    },
    /** What the route does next: 'go' (an @go warp), a walk, or null while planning. */
    get legKind() {
      return t.legKind || null;
    },
  };
}
