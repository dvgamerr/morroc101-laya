import { act } from './browser.js';
import { log } from './logger.js';

const GO_RETRY_MS = 6000;
const GO_MAX_TRIES = 2;
const MOVE_GAP_MS = 2500;
const IDLE_MOVE_GAP_MS = 700;
const STUCK_MS = 25000;
const TRIP_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Get to another map. The client's NaviRoute plans the whole trip (portals and
 * @go only — the agent can't drive Kafra/NPC dialogs yet); this walks it one
 * leg at a time: a few cells up the planned path per move, step onto portals,
 * type @go when the leg says so.
 *
 * Whether this server lets a player use @go is learned, not assumed: if the map
 * doesn't change after two tries, @go is switched off and the route replanned.
 */
export function createTravel(page) {
  const t = {
    dest: null,
    canGo: true,
    goTries: 0,
    lastGoAt: 0,
    lastMoveAt: 0,
    lastMap: null,
    lastPos: null,
    lastProgressAt: 0,
    startedAt: 0,
  };

  async function start(map) {
    t.dest = map;
    t.goTries = 0;
    t.startedAt = t.lastProgressAt = Date.now();
    await act(page, 'navi_start', { map, useGo: t.canGo });
    log('travel_start', { to: map, useGo: t.canGo });
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
      await act(page, 'navi_start', { map: t.dest, useGo: t.canGo });
      return 'traveling';
    }
    if (n.lost) {
      log('travel_failed', { to: t.dest, reason: 'no route', map: me.map, useGo: t.canGo });
      await stop();
      return 'failed';
    }
    const leg = n.leg;
    if (!leg) return 'traveling'; // still planning

    if (leg.kind === 'go') {
      if (now - t.lastGoAt < GO_RETRY_MS) return 'traveling';
      if (t.goTries >= GO_MAX_TRIES) {
        // Typed it twice and we're still here: this account can't @go.
        t.canGo = false;
        log('travel_no_go', { map: me.map });
        await act(page, 'navi_start', { map: t.dest, useGo: false });
        return 'traveling';
      }
      t.goTries++;
      t.lastGoAt = now;
      if (me.sitting) await act(page, 'stand');
      await act(page, 'say', { text: `@go ${leg.goIndex}` });
      log('travel_go', { index: leg.goIndex, toward: leg.toMap });
      return 'traveling';
    }

    // portal / arrive: walk. Near the portal, step exactly onto it.
    const dLeg = Math.max(Math.abs(me.x - leg.x), Math.abs(me.y - leg.y));
    const target = dLeg <= 3 || !n.ahead ? { x: leg.x, y: leg.y } : n.ahead;
    const gap = me.walking ? MOVE_GAP_MS : IDLE_MOVE_GAP_MS;
    if (now - t.lastMoveAt >= gap) {
      t.lastMoveAt = now;
      if (me.sitting) await act(page, 'stand');
      await act(page, 'move', { x: target.x, y: target.y });
    }
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
      return t.canGo;
    },
  };
}
