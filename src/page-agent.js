/**
 * Runs INSIDE the game page (Playwright addInitScript). Everything here talks to
 * the client's own `window.RO` debug bridge, which roBrowser only installs when
 * `development: true` — browser.js forces that by rewriting Config.local.js.
 *
 * Exposes window.__agent:
 *   snapshot()      game state for the decision loop
 *   drain()         chat / combat events since the last call
 *   act(name, arg)  run one action
 */
export function installPageAgent() {
  // Re-installing over an older copy (agent restarted, browser kept) replaces it
  // and re-points the packet observer here, keeping the stats it has learned.
  const prev = window.__agent;

  const TYPE = { PC: 0, ITEM: 2, MOB: 5, NPC: 6, ITEM2: 11 };
  // ZC_PAR_CHANGE / ZC_LONGPAR_CHANGE varID -> name (StatusProperty in the client)
  const STAT = {
    1: 'baseExp', 2: 'jobExp', 9: 'statusPoints', 11: 'baseLevel', 12: 'skillPoints',
    19: 'job', 20: 'zeny', 22: 'baseExpNext', 23: 'jobExpNext', 24: 'weight',
    25: 'maxWeight', 55: 'jobLevel',
  };

  const A = { events: [], stats: { ...(prev && prev.stats) }, hits: [], attached: false };
  window.__agent = A;

  const push = (e) => {
    A.events.push({ t: Date.now(), ...e });
    if (A.events.length > 200) A.events.shift();
  };
  const clean = (s) => String(s || '').replace(/\|\d{2}/g, '').replace(/<[^>]+>/g, '').trim();
  const split = (msg) => {
    const i = msg.indexOf(' : ');
    return i === -1 ? [null, msg] : [msg.slice(0, i).trim(), msg.slice(i + 3).trim()];
  };
  const myName = () => window.RO?.Session?.Entity?.display?.name;
  const myGID = () => window.RO?.Session?.Entity?.GID;

  function observe(name, p) {
    const RO = window.RO;
    switch (name) {
      case 'PACKET_ZC_PAR_CHANGE':
      case 'PACKET_ZC_LONGPAR_CHANGE':
      case 'PACKET_ZC_LONGLONGPAR_CHANGE': {
        const key = STAT[p.varID];
        if (key) {
          const prev = A.stats[key];
          // Renewal sends EXP as int64 (LONGLONGPAR); keep everything a plain number.
          A.stats[key] = Number(p.count ?? p.amount);
          if (key === 'baseLevel' && prev && A.stats[key] > prev) push({ type: 'level_up', kind: 'base', level: A.stats[key] });
          if (key === 'jobLevel' && prev && A.stats[key] > prev) push({ type: 'level_up', kind: 'job', level: A.stats[key] });
        }
        break;
      }
      case 'PACKET_ZC_NOTIFY_CHAT': {
        const ent = RO.EntityManager.get(p.GID);
        if (!ent || ent.objecttype !== TYPE.PC || p.GID === myGID()) break;
        const [from, text] = split(clean(p.msg));
        push({ type: 'chat', channel: 'public', from: from || ent.display?.name, gid: p.GID, text });
        break;
      }
      case 'PACKET_ZC_WHISPER':
      case 'PACKET_ZC_WHISPER2':
        push({ type: 'chat', channel: 'whisper', from: clean(p.sender), text: clean(p.msg) });
        break;
      case 'PACKET_ZC_NOTIFY_CHAT_PARTY': {
        const [from, text] = split(clean(p.msg));
        if (from && from === myName()) break;
        push({ type: 'chat', channel: 'party', from, gid: p.AID, text });
        break;
      }
      case 'PACKET_ZC_GUILD_CHAT': {
        const [from, text] = split(clean(p.msg));
        if (from && from === myName()) break;
        push({ type: 'chat', channel: 'guild', from, text });
        break;
      }
      case 'PACKET_ZC_NOTIFY_ACT':
      case 'PACKET_ZC_NOTIFY_ACT2':
      case 'PACKET_ZC_NOTIFY_ACT3':
        if (p.targetGID && p.targetGID === myGID() && p.damage > 0) {
          A.hits.push({ t: Date.now(), from: p.GID, damage: p.damage + (p.leftDamage || 0) });
          if (A.hits.length > 100) A.hits.shift();
        }
        break;
      case 'PACKET_ZC_NOTIFY_VANISH':
        if (p.GID === myGID() && p.type === 1) push({ type: 'died' });
        break;
    }
  }

  function attach() {
    if (A.attached || !window.RO?.Network?.setPacketObserver) return;
    window.RO.Network.setPacketObserver(observe);
    A.attached = true;
  }
  window.addEventListener('robrowser-debug-ready', attach);
  attach();

  // getComponent throws until the UI has been built.
  function component(name) {
    try {
      return window.RO.UIManager.getComponent(name);
    } catch {
      return null;
    }
  }

  function inventory() {
    const RO = window.RO;
    const inv = component('Inventory');
    const list = (inv && inv.list) || [];
    return list.map((it) => ({
      index: it.index,
      ITID: it.ITID,
      name: (RO.DB.getItemInfo(it.ITID) || {}).identifiedDisplayName || String(it.ITID),
      count: it.count,
      type: it.type,
      equipped: !!it.WearState,
    }));
  }

  A.snapshot = () => {
    const RO = window.RO;
    if (!RO) return { ready: false };
    const me = RO.me();
    if (!me || !me.playing || me.x === undefined) return { ready: true, inGame: false };

    const now = Date.now();
    A.hits = A.hits.filter((h) => now - h.t < 6000);
    const attackers = [...new Set(A.hits.map((h) => h.from))];
    const ents = RO.entities();
    const target = RO.AutoCombat.target && RO.AutoCombat.target();
    const pick = (e) => ({ GID: e.GID, name: e.name, x: e.x, y: e.y, dist: e.dist, hp: e.hp, maxHp: e.maxHp });
    const session = RO.Session.Entity || {};

    return {
      ready: true,
      inGame: true,
      me: {
        ...me,
        // MapRenderer.currentMap is "prontera.gat"; the navigation data and the server say "prontera".
        map: String(me.map || '').replace(/\.(gat|rsw)$/i, ''),
        baseLevel: A.stats.baseLevel ?? session.clevel,
        jobLevel: A.stats.jobLevel ?? session.joblevel,
        jobId: A.stats.job ?? session._job ?? session.job,
        zeny: A.stats.zeny ?? RO.Session.zeny,
        baseExp: A.stats.baseExp, baseExpNext: A.stats.baseExpNext,
        jobExp: A.stats.jobExp, jobExpNext: A.stats.jobExpNext,
        weight: A.stats.weight, maxWeight: A.stats.maxWeight,
        statusPoints: A.stats.statusPoints, skillPoints: A.stats.skillPoints,
        sitting: !!session.ACTION && session.action === session.ACTION.SIT,
        walking: !!session.ACTION && session.action === session.ACTION.WALK,
        // hp is 0 for a moment after login, before the first status packet; that isn't death.
        dead: (me.maxHp > 0 && me.hp === 0) || (!!session.ACTION && session.action === session.ACTION.DIE),
      },
      target: target ? { GID: target.GID, name: target.display?.name } : null,
      autoCombat: !!(RO.AutoCombat.isChaining && RO.AutoCombat.isChaining()),
      damageTaken6s: A.hits.reduce((s, h) => s + h.damage, 0),
      attackers,
      monsters: ents.filter((e) => e.type === TYPE.MOB && e.hp !== 0).slice(0, 15).map(pick),
      items: ents.filter((e) => e.type === TYPE.ITEM || e.type === TYPE.ITEM2).slice(0, 10).map(pick),
      players: ents.filter((e) => e.type === TYPE.PC && e.GID !== me.GID).slice(0, 10).map(pick),
      npcs: ents.filter((e) => e.type === TYPE.NPC).slice(0, 10).map(pick),
      inventory: inventory(),
      navi: navi(),
    };
  };

  // The client's own cross-map route planner (the /navi window). It plans; we walk.
  function navi() {
    const N = window.RO.NaviRoute;
    const dest = N && N.getDestination();
    if (!dest) return null;
    const leg = N.getLeg();
    return {
      dest: dest.map,
      lost: N.isLost(),
      leg: leg ? { kind: leg.kind, x: leg.x, y: leg.y, toMap: leg.toMap, goIndex: leg.goIndex } : null,
      ahead: N.getAheadCell(12) || null,
      remaining: N.getRemainingCells(),
    };
  }

  A.drain = () => A.events.splice(0, A.events.length);

  // ---- Walking on the map grid -------------------------------------------------
  // The client's PathFinding.search stops at ~145 nodes, like the server's own
  // walk limit; fine for one step, useless for getting round a long wall. This is
  // a plain BFS over the same GAT cells, so it finds the way round anything.

  function grid() {
    const g = window.RO.PathFinding.getGat();
    if (!g || !g.cells || !g.width) return null;
    const WALK = g.type.WALKABLE;
    return { w: g.width, h: g.height, ok: (x, y) => x >= 0 && y >= 0 && x < g.width && y < g.height && (g.cells[x + y * g.width] & WALK) !== 0 };
  }

  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

  /** BFS from (sx,sy); stops at `goal(x,y)` or after `maxSteps`. Returns {found, prev, dist, g}. */
  function bfs(sx, sy, goal, maxSteps) {
    const g = grid();
    if (!g || !g.ok(sx, sy)) return null;
    const size = g.w * g.h;
    const dist = new Int16Array(size).fill(-1);
    const prev = new Int32Array(size).fill(-1);
    const queue = new Int32Array(size);
    let head = 0;
    let tail = 0;
    const start = sx + sy * g.w;
    dist[start] = 0;
    queue[tail++] = start;
    while (head < tail) {
      const i = queue[head++];
      const x = i % g.w;
      const y = (i / g.w) | 0;
      if (goal && goal(x, y)) return { found: i, prev, dist, g };
      if (dist[i] >= maxSteps) continue;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        // No corner cutting: a diagonal needs both sides open, as in the client.
        if (!g.ok(nx, ny) || (dx && dy && (!g.ok(x + dx, y) || !g.ok(x, y + dy)))) continue;
        const j = nx + ny * g.w;
        if (dist[j] !== -1) continue;
        dist[j] = dist[i] + 1;
        prev[j] = i;
        queue[tail++] = j;
      }
    }
    return { found: -1, prev, dist, g };
  }

  /** Path cells from start to `end` index, start excluded. */
  function trace(r, end) {
    const out = [];
    for (let i = end; i !== -1 && r.dist[i] > 0; i = r.prev[i]) out.push([i % r.g.w, (i / r.g.w) | 0]);
    return out.reverse();
  }

  /**
   * The next waypoint (at most `step` cells along the real path) toward (tx,ty),
   * or toward the nearest walkable cell to it. null when there is no way at all.
   */
  A.waypoint = (tx, ty, step = 12, maxSteps = 600) => {
    const me = window.RO.me();
    const sx = Math.round(me.x);
    const sy = Math.round(me.y);
    const r = bfs(sx, sy, (x, y) => Math.abs(x - tx) <= 1 && Math.abs(y - ty) <= 1, maxSteps);
    if (!r) return null;
    let end = r.found;
    if (end === -1) {
      // Target itself unreachable (wall, water): go to the reachable cell closest to it.
      let best = Infinity;
      for (let i = 0; i < r.dist.length; i++) {
        if (r.dist[i] < 0) continue;
        const d = Math.max(Math.abs((i % r.g.w) - tx), Math.abs(((i / r.g.w) | 0) - ty));
        if (d < best) {
          best = d;
          end = i;
        }
      }
      if (end === -1 || r.dist[end] === 0) return null;
    }
    const path = trace(r, end);
    if (!path.length) return { x: sx, y: sy, length: 0, exact: true }; // already there
    const [x, y] = path[Math.min(step, path.length) - 1];
    return { x, y, length: path.length, exact: r.found !== -1 };
  };

  /** A random cell we can actually walk to, between minSteps and maxSteps away. */
  A.exploreTarget = (minSteps = 10, maxSteps = 35, avoid = []) => {
    const me = window.RO.me();
    const r = bfs(Math.round(me.x), Math.round(me.y), null, maxSteps);
    if (!r) return null;
    const far = [];
    for (let i = 0; i < r.dist.length; i++) {
      if (r.dist[i] < minSteps) continue;
      const x = i % r.g.w;
      const y = (i / r.g.w) | 0;
      // Prefer places we haven't just been (coarse 20-cell buckets).
      if (avoid.some(([ax, ay]) => Math.abs(ax - x) < 20 && Math.abs(ay - y) < 20)) continue;
      far.push([x, y]);
    }
    if (!far.length) for (let i = 0; i < r.dist.length; i++) if (r.dist[i] >= minSteps) far.push([i % r.g.w, (i / r.g.w) | 0]);
    if (!far.length) return null;
    const [x, y] = far[(Math.random() * far.length) | 0];
    return { x, y };
  };

  const send = (Struct, fields) => {
    const pkt = new Struct();
    Object.assign(pkt, fields);
    window.RO.Network.sendPacket(pkt);
  };

  A.act = (name, arg = {}) => {
    const RO = window.RO;
    const { PACKET } = RO;
    switch (name) {
      case 'attack':
        return RO.attack(arg.GID);
      case 'move':
        return RO.moveTo(arg.x, arg.y);
      case 'walk_to': {
        // Walk toward any cell, round walls: next waypoint on the BFS path, <=12 cells
        // so rAthena's 17-cell walk limit never drops the request.
        const wp = A.waypoint(arg.x, arg.y, arg.step || 12);
        if (wp) RO.moveTo(wp.x, wp.y);
        return wp;
      }
      case 'stop_auto':
        return RO.AutoCombat.stop();
      case 'pickup':
        return send(PACKET.CZ.ITEM_PICKUP, { ITAID: arg.GID });
      case 'use_item': {
        const inv = component('Inventory');
        const item = inv && inv.list.find((it) => it.index === arg.index);
        if (!item) return false;
        // Straight packet, not inv.useItem(): that one equips/refines when handed gear.
        // Same version switch as the client's own onUseItem.
        const Struct = RO.PACKETVER.value >= 20180307 ? PACKET.CZ.USE_ITEM2 : PACKET.CZ.USE_ITEM;
        send(Struct, { index: item.index, AID: RO.Session.Entity.GID });
        return true;
      }
      case 'sit':
        return send(PACKET.CZ.REQUEST_ACT2 || PACKET.CZ.REQUEST_ACT, { targetGID: 0, action: 2 });
      case 'stand':
        return send(PACKET.CZ.REQUEST_ACT2 || PACKET.CZ.REQUEST_ACT, { targetGID: 0, action: 3 });
      case 'respawn':
        return send(PACKET.CZ.RESTART, { type: 0 });
      case 'navi_start':
        // Kafra and NPC warps need dialog handling the agent doesn't do: plan around them.
        RO.NaviRoute.setOptions({ useGo: !!arg.useGo, useKafra: false, useTalk: false });
        RO.NaviRoute.setDestination({ map: arg.map, x: 0, y: 0, name: arg.map });
        return true;
      case 'navi_clear':
        return RO.NaviRoute.clear();
      case 'say':
        return RO.say(arg.text);
      case 'party':
        return send(PACKET.CZ.REQUEST_CHAT_PARTY, { msg: `${myName()} : ${arg.text}` });
      case 'guild':
        return send(PACKET.CZ.GUILD_CHAT, { msg: `${myName()} : ${arg.text}` });
      case 'whisper':
        return send(PACKET.CZ.WHISPER, { receiver: arg.to, msg: arg.text });
      default:
        throw new Error(`unknown action ${name}`);
    }
  };
}
