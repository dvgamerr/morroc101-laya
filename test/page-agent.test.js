import { test, expect, beforeEach } from 'bun:test';
import { installPageAgent } from '../src/page-agent.js';

// Minimal stand-in for roBrowser's window.RO, shaped after DebugBridge.install().
function fakeRO({ inventory = null } = {}) {
  const sent = [];
  const Struct = (name) =>
    function () {
      this.__name = name;
    };
  const me = { GID: 100, display: { name: 'Bot' }, ACTION: { IDLE: 0, WALK: 1, SIT: 2, DIE: 3 }, action: 0, clevel: 10, joblevel: 5 };
  const others = new Map([
    [200, { GID: 200, objecttype: 0, display: { name: 'KemRO' } }],
    [300, { GID: 300, objecttype: 1, display: { name: 'Kafra' } }],
  ]);
  const RO = {
    sent,
    observer: null,
    Session: { Entity: me, AID: 100, zeny: 1234 },
    PACKETVER: { value: 20211103 },
    PACKET: {
      CZ: Object.fromEntries(
        ['USE_ITEM', 'USE_ITEM2', 'ITEM_PICKUP', 'REQUEST_ACT2', 'RESTART', 'REQUEST_CHAT_PARTY', 'GUILD_CHAT', 'WHISPER'].map((n) => [n, Struct(n)]),
      ),
    },
    Network: {
      setPacketObserver: (cb) => (RO.observer = cb),
      sendPacket: (pkt) => sent.push({ ...pkt }),
    },
    EntityManager: { get: (gid) => (gid === 100 ? me : others.get(gid)) },
    UIManager: {
      getComponent: (name) => {
        if (name === 'Inventory' && inventory) return { list: inventory };
        throw new Error(`UIManager.getComponent() - Component "${name}" not found`);
      },
    },
    DB: { getItemInfo: (id) => ({ identifiedDisplayName: id === 501 ? 'Red Potion' : 'Thing' }) },
    AutoCombat: { target: () => null, isChaining: () => false, stop() {} },
    me: () => ({ name: 'Bot', GID: 100, map: 'prt_fild08', x: 50, y: 60, hp: 80, maxHp: 100, sp: 10, maxSp: 20, playing: true }),
    entities: () => [
      { GID: 100, type: 0, name: 'Bot', x: 50, y: 60, dist: 0 },
      { GID: 7, type: 5, name: 'Poring', x: 52, y: 60, dist: 2 },
      { GID: 8, type: 5, name: 'Dead Poring', x: 53, y: 60, dist: 3, hp: 0 },
      { GID: 50, type: 2, name: 'Jellopy', x: 51, y: 60, dist: 1 },
      { GID: 200, type: 0, name: 'KemRO', x: 55, y: 60, dist: 5 },
    ],
    attack: (GID) => sent.push({ __name: 'attack', GID }),
    moveTo: (x, y) => sent.push({ __name: 'move', x, y }),
    say: (text) => sent.push({ __name: 'say', text }),
  };
  return RO;
}

let RO;
beforeEach(() => {
  globalThis.window = new EventTarget();
  RO = fakeRO({ inventory: [{ index: 3, ITID: 501, count: 7, type: 0 }] });
  window.RO = RO;
  installPageAgent();
});

test('attaches the packet observer', () => {
  expect(typeof RO.observer).toBe('function');
});

test('turns chat packets into events and drops our own / NPC lines', () => {
  RO.observer('PACKET_ZC_NOTIFY_CHAT', { GID: 200, msg: 'KemRO : สวัสดี|00' });
  RO.observer('PACKET_ZC_NOTIFY_CHAT', { GID: 300, msg: 'Kafra : Welcome' });
  RO.observer('PACKET_ZC_NOTIFY_CHAT_PARTY', { AID: 100, msg: 'Bot : my own line' });
  RO.observer('PACKET_ZC_NOTIFY_CHAT_PARTY', { AID: 200, msg: 'KemRO : ไปไหนต่อ' });
  RO.observer('PACKET_ZC_WHISPER', { sender: 'Alice', msg: 'พี่เขมอยู่ไหม' });
  const events = window.__agent.drain().map(({ t, ...e }) => e);
  expect(events).toEqual([
    { type: 'chat', channel: 'public', from: 'KemRO', gid: 200, text: 'สวัสดี' },
    { type: 'chat', channel: 'party', from: 'KemRO', gid: 200, text: 'ไปไหนต่อ' },
    { type: 'chat', channel: 'whisper', from: 'Alice', text: 'พี่เขมอยู่ไหม' },
  ]);
  expect(window.__agent.drain()).toEqual([]);
});

test('tracks stats including int64 EXP and emits level ups', () => {
  RO.observer('PACKET_ZC_PAR_CHANGE', { varID: 11, count: 10 });
  RO.observer('PACKET_ZC_LONGLONGPAR_CHANGE', { varID: 1, amount: 123456789012n });
  RO.observer('PACKET_ZC_PAR_CHANGE', { varID: 11, count: 11 });
  const s = window.__agent.snapshot();
  expect(s.me.baseLevel).toBe(11);
  expect(s.me.baseExp).toBe(123456789012);
  expect(window.__agent.drain().map((e) => e.type)).toEqual(['level_up']);
});

test('counts damage only when we are the target', () => {
  RO.observer('PACKET_ZC_NOTIFY_ACT', { GID: 7, targetGID: 100, damage: 12, leftDamage: 0 });
  RO.observer('PACKET_ZC_NOTIFY_ACT', { GID: 100, targetGID: 7, damage: 40, leftDamage: 0 });
  const s = window.__agent.snapshot();
  expect(s.attackers).toEqual([7]);
  expect(s.damageTaken6s).toBe(12);
});

test('snapshot splits entities and skips dead monsters', () => {
  const s = window.__agent.snapshot();
  expect(s.inGame).toBe(true);
  expect(s.monsters.map((m) => m.name)).toEqual(['Poring']);
  expect(s.items.map((m) => m.GID)).toEqual([50]);
  expect(s.players.map((m) => m.name)).toEqual(['KemRO']);
  expect(s.inventory).toEqual([{ index: 3, ITID: 501, name: 'Red Potion', count: 7, type: 0, equipped: false }]);
  expect(s.me.zeny).toBe(1234);
});

test('snapshot survives the Inventory UI not existing yet', () => {
  window.RO = fakeRO();
  expect(window.__agent.snapshot().inventory).toEqual([]);
});

test('use_item sends USE_ITEM2 with our GID on this packetver', () => {
  expect(window.__agent.act('use_item', { index: 3 })).toBe(true);
  expect(RO.sent.at(-1)).toEqual({ __name: 'USE_ITEM2', index: 3, AID: 100 });
  expect(window.__agent.act('use_item', { index: 99 })).toBe(false);
});

test('chat actions prefix our name where the server expects it', () => {
  window.__agent.act('party', { text: 'โอเค' });
  window.__agent.act('whisper', { to: 'Alice', text: 'ทำงานอยู่' });
  expect(RO.sent.slice(-2)).toEqual([
    { __name: 'REQUEST_CHAT_PARTY', msg: 'Bot : โอเค' },
    { __name: 'WHISPER', receiver: 'Alice', msg: 'ทำงานอยู่' },
  ]);
});

test('re-installing (agent restarted, browser kept) keeps stats and re-points the observer', () => {
  RO.observer('PACKET_ZC_PAR_CHANGE', { varID: 11, count: 42 });
  const old = RO.observer;
  installPageAgent();
  expect(RO.observer).not.toBe(old);
  expect(window.__agent.snapshot().me.baseLevel).toBe(42);
});

test('hp 0 before the first status packet is not death', () => {
  RO.me = () => ({ name: 'Bot', GID: 100, map: 'prt_fild08', x: 50, y: 60, hp: 0, maxHp: 0, playing: true });
  expect(window.__agent.snapshot().me.dead).toBe(false);
});

test('map names lose the client .gat suffix so they match the navigation data', () => {
  RO.me = () => ({ name: 'Bot', GID: 100, map: 'yuno_fild03.gat', x: 50, y: 60, hp: 10, maxHp: 10, playing: true });
  expect(window.__agent.snapshot().me.map).toBe('yuno_fild03');
});

// 10x7 map with a wall at x=5 from y=0..5; the only gap is at y=6.
function walledGrid() {
  const w = 10, h = 7, cells = new Uint8Array(w * h).fill(1);
  for (let y = 0; y <= 5; y++) cells[5 + y * w] = 0;
  return { width: w, height: h, cells, type: { WALKABLE: 1 } };
}

test('waypoint walks round a wall instead of into it', () => {
  RO.PathFinding = { getGat: walledGrid };
  RO.me = () => ({ x: 2, y: 1, map: 'x', playing: true });
  const wp = window.__agent.waypoint(8, 1, 50);
  expect(wp.exact).toBe(true);
  expect(wp.x).toBeGreaterThanOrEqual(7);
  expect(wp.length).toBeGreaterThan(8); // down to y=6, through the gap, back up
  const first = window.__agent.waypoint(8, 1, 3);
  expect(first.y).toBeGreaterThan(1); // first steps head down toward the gap, not into the wall
});

test('waypoint to an unreachable cell goes to the nearest reachable one', () => {
  const g = walledGrid();
  g.cells[5 + 6 * 10] = 0; // close the gap
  RO.PathFinding = { getGat: () => g };
  RO.me = () => ({ x: 2, y: 1, map: 'x', playing: true });
  const wp = window.__agent.waypoint(8, 1, 50);
  expect(wp.exact).toBe(false);
  expect(wp.x).toBe(4);
});

test('exploreTarget only returns reachable cells, never inside the wall', () => {
  const g = walledGrid();
  g.cells[5 + 6 * 10] = 0; // right half unreachable
  RO.PathFinding = { getGat: () => g };
  RO.me = () => ({ x: 1, y: 1, map: 'x', playing: true });
  for (let i = 0; i < 20; i++) {
    const p = window.__agent.exploreTarget(3, 30);
    expect(p).not.toBe(null);
    expect(p.x).toBeLessThan(5);
  }
});
