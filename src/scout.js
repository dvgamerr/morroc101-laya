import { query } from './browser.js';
import { log } from './logger.js';

// Server commands that report where a monster is. Which one this server accepts
// (and for this account) is learned at runtime; the first that answers with
// coordinates wins and is used from then on.
const COMMANDS = ['@where', '@mobsearch'];
const QUERY_GAP_MS = 15000;
const MISSES_TO_DROP = 3;
const REFUSED = /unknown command|not (?:a )?(?:valid|recognized)|no such command|permission|not allowed|don't have|cannot use/i;

/**
 * Pull "x, y" coordinates out of a server reply. Lines naming another map are
 * skipped when the current map is known; the line format differs per command
 * and per server, so this only relies on the "(x, y)" / "x,y" shape.
 */
export function parseLocations(lines, currentMap) {
  const out = [];
  for (const line of lines) {
    const other = /([a-z][a-z0-9_]{2,})(?:\.gat)?/gi;
    const maps = [...line.matchAll(other)].map((m) => m[1].toLowerCase()).filter((m) => /_|\d/.test(m));
    if (currentMap && maps.length && !maps.includes(currentMap)) continue;
    for (const m of line.matchAll(/(\d{1,3})\s*[,:]\s*(\d{1,3})/g)) {
      const x = +m[1];
      const y = +m[2];
      if (x > 0 && y > 0 && x < 1000 && y < 1000) out.push({ x, y });
    }
  }
  return out;
}

/**
 * @param {{dropped?: string[], onDrop?: (cmd: string) => void}} [known] commands already
 *   found useless in earlier runs (so they aren't typed again — a refused command goes out
 *   as public chat for everyone to read), and a hook to remember new ones.
 */
export function createScout(page, known = {}) {
  const dropped = new Set(known.dropped || []);
  const s = { commands: COMMANDS.filter((c) => !dropped.has(c)), misses: {}, lastAt: 0, working: null, turn: 0 };

  /**
   * Where are monsters with these names on this map? [{x, y, name}] nearest first, or [].
   * One query per call (each waits up to ~1.5s for the reply, and the reflex waits on this): the
   * names and commands are tried in turn over successive calls.
   */
  async function locate(snap, names) {
    const now = Date.now();
    if (!names.length || !s.commands.length || now - s.lastAt < QUERY_GAP_MS) return [];
    s.lastAt = now;
    const me = snap.me;
    const pool = names.slice(0, 2);
    const cmd = s.working || s.commands[Math.floor(s.turn / pool.length) % s.commands.length];
    const name = pool[s.turn % pool.length];
    s.turn++;
    const lines = await Promise.resolve().then(() => query(page, `${cmd} ${name}`)).catch(() => []);
    const spots = parseLocations(lines, me.map).map((p) => ({ ...p, name }));
    log('scout', { cmd, name, found: spots.length, reply: lines.slice(0, 3).join(' | ').slice(0, 200) });
    if (spots.length) {
      s.working = cmd;
      s.misses[cmd] = 0;
      return spots.sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y));
    }
    // "Nobody of that name here" is a real answer, not a broken command. Only a command that gets no
    // reply at all, or is refused, is dropped (and dropped for good: it is remembered across runs).
    if (!s.working && (!lines.length || REFUSED.test(lines.join(' ')))) {
      s.misses[cmd] = (s.misses[cmd] || 0) + 1;
      if (s.misses[cmd] >= MISSES_TO_DROP) {
        s.commands = s.commands.filter((c) => c !== cmd);
        log('scout_drop_command', { cmd });
        known.onDrop?.(cmd);
      }
    }
    return [];
  }

  return { locate };
}
