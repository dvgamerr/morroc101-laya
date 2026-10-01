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
