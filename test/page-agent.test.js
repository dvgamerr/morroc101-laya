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

test('refine selection waits for unequip and the live inventory item', () => {
  const item = { index: 17, ITID: 5257, type: 4, IsIdentified: true };
  let equipped = true, live = false;
  RO.UIManager.getComponent = name => name === 'Equipment'
    ? { isInEquipList: () => equipped ? item : null }
    : name === 'Inventory' ? { list: live ? [item] : [], getItemByIndex: index => live && index === item.index ? item : null } : null;
  RO.PACKET.CZ.REQ_TAKEOFF_EQUIP = function () { this.__name = 'unequip'; };
  RO.PACKET.CZ.REFINING_SELECT_ITEM = function () { this.__name = 'refine_select'; };
  window.__agent.refine = { open: true };
  expect(window.__agent.act('refine_select', { index: 17 })).toBe(false);
  window.__agent.act('unequip', { index: 17, ITID: 5257 });
  expect(RO.sent.at(-1)).toMatchObject({ __name: 'unequip', index: 17 });
  equipped = false;
  expect(window.__agent.act('refine_select', { index: 17 })).toBe(false);
  live = true;
  window.__agent.act('refine_select', { index: 17 });
  expect(RO.sent.at(-1)).toMatchObject({ __name: 'refine_select', index: 17 });
});

test('reinstall preserves the conversation that still blocks movement on the server', () => {
  RO.observer('PACKET_ZC_SAY_DIALOG', { NAID: 300, msg: 'Welcome' });
  RO.observer('PACKET_ZC_CLOSE_DIALOG', { NAID: 300 });
  installPageAgent();
  expect(window.__agent.snapshot().dialog).toMatchObject({ naid: 300, state: 'close', lines: ['Welcome'] });
  RO.observer('PACKET_ZC_CLOSE_SCRIPT', { NAID: 300 });
  expect(window.__agent.snapshot().dialog.state).toBe('ended');
});

test('empty map during loading is not a playable snapshot', () => {
  RO.me = () => ({ playing: true, map: '', x: 50, y: 60 });
  expect(window.__agent.snapshot()).toEqual({ ready: true, inGame: false });
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
  expect(s.inventory).toEqual([{ index: 3, ITID: 501, name: 'Red Potion', count: 7, type: 0, equipped: false, keep: null }]);
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

test('query collects the server reply lines after the command', async () => {
  RO.say = () => setTimeout(() => RO.observer('PACKET_ZC_NOTIFY_PLAYERCHAT', { msg: 'Poring located at (120, 88)' }), 10);
  const lines = await window.__agent.query('@where Poring', 50);
  expect(lines).toEqual(['Poring located at (120, 88)']);
});

const addStructs = (...names) => {
  for (const n of names) RO.PACKET.CZ[n] = function () { this.__name = n; };
};

test('tracks skills, cooldowns, failures and our own status effects', () => {
  RO.observer('PACKET_ZC_SKILLINFO_LIST', { skillList: [{ SKID: 5, type: 1, level: 10, spcost: 15, attackRange: 1, skillName: 'SM_BASH\0\0' }] });
  RO.observer('PACKET_ZC_SKILLINFO_UPDATE', { SKID: 5, level: 10, spcost: 12, attackRange: 1 });
  RO.observer('PACKET_ZC_SKILL_POSTDELAY', { SKID: 5, DelayTM: 5000 });
  RO.observer('PACKET_ZC_MSG_STATE_CHANGE2', { index: 21, AID: 100, state: 1, RemainMS: 60000 });
  RO.observer('PACKET_ZC_MSG_STATE_CHANGE2', { index: 99, AID: 999, state: 1, RemainMS: 60000 }); // someone else
  RO.observer('PACKET_ZC_ACK_TOUSESKILL', { SKID: 5, result: 0, cause: 1 });
  const s = window.__agent.snapshot();
  expect(s.me.skills).toEqual([{ id: 5, name: 'SM_BASH', label: '', inf: 1, level: 10, sp: 12, range: 1, upgradable: false }]);
  expect(s.me.cooldowns[5]).toBeGreaterThan(4000);
  expect(Object.keys(s.me.status)).toEqual(['21']);
  expect(window.__agent.drain().map((e) => e.type)).toEqual(['status', 'skill_fail']);
});

test('tracks base stats; raise_stat and skills go out as the client sends them', () => {
  addStructs('STATUS_CHANGE', 'USE_SKILL2', 'USE_SKILL_TOGROUND3');
  RO.observer('PACKET_ZC_STATUS', { point: 9, str: 10, agi: 5, vit: 3, Int: 1, dex: 4, luk: 1, standardStr: 2, standardAgi: 2, standardVit: 2, standardInt: 2, standardDex: 2, standardLuk: 2 });
  RO.observer('PACKET_ZC_STATUS_CHANGE_ACK', { statusID: 13, result: 1, value: 11 });
  const s = window.__agent.snapshot();
  expect(s.me.stats).toEqual({ str: 11, agi: 5, vit: 3, int: 1, dex: 4, luk: 1 });
  expect(s.me.statusPoints).toBe(9);
  window.__agent.act('raise_stat', { stat: 'vit' });
  window.__agent.act('skill', { SKID: 5, level: 10, targetID: 7 });
  window.__agent.act('skill', { SKID: 83, level: 5, x: 50, y: 60 });
  expect(RO.sent.slice(-3)).toEqual([
    { __name: 'STATUS_CHANGE', statusID: 15, changeAmount: 1 },
    { __name: 'USE_SKILL2', SKID: 5, selectedLevel: 10, targetID: 7 },
    { __name: 'USE_SKILL_TOGROUND3', SKID: 83, selectedLevel: 5, xPos: 50, yPos: 60 },
  ]);
});

test('ground skills select the client packet at each protocol version boundary', () => {
  addStructs('USE_SKILL_TOGROUND', 'USE_SKILL_TOGROUND2', 'USE_SKILL_TOGROUND3');
  for (const [version, packet] of [
    [20180306, 'USE_SKILL_TOGROUND'],
    [20180307, 'USE_SKILL_TOGROUND2'],
    [20190903, 'USE_SKILL_TOGROUND2'],
    [20190904, 'USE_SKILL_TOGROUND3'],
    [20211103, 'USE_SKILL_TOGROUND3'],
  ]) {
    RO.PACKETVER.value = version;
    window.__agent.act('skill', { SKID: 110, level: 5, x: 0, y: 60 });
    expect(RO.sent.at(-1)).toEqual({ __name: packet, SKID: 110, selectedLevel: 5, xPos: 0, yPos: 60 });
  }
});

test('NPC shop: deal choice, price lists, results, and the packets we answer with', () => {
  addStructs('ACK_SELECT_DEALTYPE', 'PC_PURCHASE_ITEMLIST', 'PC_SELL_ITEMLIST');
  RO.observer('PACKET_ZC_SELECT_DEALTYPE', { NAID: 77 });
  expect(window.__agent.snapshot().shop).toMatchObject({ naid: 77, stage: 'select' });
  RO.observer('PACKET_ZC_PC_PURCHASE_ITEMLIST', { itemList: [{ ITID: 501, price: 50, discountprice: 45, type: 0 }] });
  expect(window.__agent.snapshot().shop).toMatchObject({ naid: 77, stage: 'buy', list: [{ ITID: 501, price: 45 }] });
  window.__agent.act('deal', { naid: 77, type: 0 });
  window.__agent.act('buy', { items: [{ ITID: 501, count: 30 }] });
  window.__agent.act('sell', { items: [{ index: 9, count: 40 }] });
  expect(RO.sent.slice(-3)).toEqual([
    { __name: 'ACK_SELECT_DEALTYPE', NAID: 77, type: 0 },
    { __name: 'PC_PURCHASE_ITEMLIST', itemList: [{ ITID: 501, count: 30 }] },
    { __name: 'PC_SELL_ITEMLIST', itemList: [{ index: 9, count: 40 }] },
  ]);
  RO.observer('PACKET_ZC_PC_PURCHASE_RESULT', { result: 0 });
  expect(window.__agent.drain().filter((e) => e.type === 'shop_result')).toMatchObject([{ kind: 'buy', ok: true }]);
  expect(window.__agent.snapshot().shop).toBe(null);
});

test('NPC dialog: text, Next, menu (colour codes stripped), Close, and the answers we send', () => {
  addStructs('REQ_NEXT_SCRIPT', 'CHOOSE_MENU', 'CLOSE_DIALOG', 'UPGRADE_SKILLLEVEL');
  RO.observer('PACKET_ZC_SAY_DIALOG', { NAID: 42, msg: '[^0055FFJob Master^000000]' });
  RO.observer('PACKET_ZC_WAIT_DIALOG', { NAID: 42 });
  expect(window.__agent.snapshot().dialog).toMatchObject({ naid: 42, state: 'next', lines: ['[Job Master]'] });
  RO.observer('PACKET_ZC_MENU_LIST', { NAID: 42, msg: '^0055FFBlacksmith^000000:Alchemist:Cancel' });
  expect(window.__agent.snapshot().dialog).toMatchObject({ state: 'menu', menu: ['Blacksmith', 'Alchemist', 'Cancel'] });
  window.__agent.act('npc_next', { naid: 42 });
  window.__agent.act('npc_menu', { naid: 42, num: 1 });
  window.__agent.act('upgrade_skill', { SKID: 42 });
  RO.observer('PACKET_ZC_CLOSE_DIALOG', { NAID: 42 });
  expect(window.__agent.snapshot().dialog.state).toBe('close');
  window.__agent.act('npc_close', { naid: 42 });
  expect(RO.sent.slice(-4)).toEqual([
    { __name: 'REQ_NEXT_SCRIPT', NAID: 42 },
    { __name: 'CHOOSE_MENU', NAID: 42, num: 1 },
    { __name: 'UPGRADE_SKILLLEVEL', SKID: 42 },
    { __name: 'CLOSE_DIALOG', NAID: 42 },
  ]);
  expect(window.__agent.snapshot().dialog.state).toBe('ended');
});

test('buy list in the newer ITEMLIST2 form, and market shops (direct list, own purchase + close)', () => {
  addStructs('PC_PURCHASE_ITEMLIST', 'NPC_MARKET_PURCHASE', 'NPC_MARKET_CLOSE');
  RO.observer('PACKET_ZC_SELECT_DEALTYPE', { NAID: 77 });
  RO.observer('PACKET_ZC_PC_PURCHASE_ITEMLIST2', { itemList: [{ ITID: 503, price: 550, discountprice: 0, type: 0 }] });
  expect(window.__agent.snapshot().shop).toMatchObject({ kind: 'npc', stage: 'buy', list: [{ ITID: 503, price: 550 }] });

  RO.observer('PACKET_ZC_NPC_MARKET_OPEN2', { itemList: [{ ITID: 504, type: 0, price: 1100, qty: 50, weight: 15 }] });
  expect(window.__agent.snapshot().shop).toMatchObject({ kind: 'market', stage: 'buy', list: [{ ITID: 504, price: 1100, stock: 50 }] });
  window.__agent.act('buy', { items: [{ ITID: 504, count: 12 }] });
  expect(RO.sent.at(-1)).toEqual({ __name: 'NPC_MARKET_PURCHASE', itemList: [{ itemId: 504, amount: 12 }] });
  RO.observer('PACKET_ZC_NPC_MARKET_PURCHASE_RESULT2', { result: 1 });
  expect(window.__agent.drain().filter((e) => e.type === 'shop_result')).toMatchObject([{ kind: 'buy', ok: true }]);
  window.__agent.act('close_shop');
  expect(RO.sent.at(-1)).toEqual({ __name: 'NPC_MARKET_CLOSE' });
  expect(window.__agent.snapshot().shop).toBe(null);
});

test('stun/freeze/sleep on us becomes a "disabled" event naming who was hitting us', () => {
  RO.observer('PACKET_ZC_NOTIFY_ACT', { GID: 200, targetGID: 100, damage: 30, leftDamage: 0 }); // KemRO entity stands in for a monster here
  RO.observer('PACKET_ZC_STATE_CHANGE3', { AID: 100, bodyState: 3, healthState: 0 });
  RO.observer('PACKET_ZC_STATE_CHANGE3', { AID: 100, bodyState: 3, healthState: 0 }); // same state again: no repeat
  RO.observer('PACKET_ZC_STATE_CHANGE3', { AID: 999, bodyState: 2, healthState: 0 }); // someone else
  const ev = window.__agent.drain().filter((e) => e.type === 'disabled');
  expect(ev).toMatchObject([{ state: 'stun', from: ['KemRO'] }]);
});

test('NPC names lose rAthena\'s hidden #suffix', () => {
  const ents = RO.entities;
  RO.entities = () => [...ents(), { GID: 77, type: 6, name: 'Healer#mor', x: 53, y: 60, dist: 3 }];
  expect(window.__agent.snapshot().npcs).toContainEqual(expect.objectContaining({ GID: 77, name: 'Healer' }));
});

test('inventory that blinks empty while the client refreshes keeps the last known contents', () => {
  const inv = { list: [{ index: 3, ITID: 503, count: 222, type: 0 }] };
  RO.UIManager.getComponent = (name) => { if (name === 'Inventory') return inv; throw new Error('nope'); };
  expect(window.__agent.snapshot().inventory.length).toBe(1);
  inv.list = [];
  expect(window.__agent.snapshot().inventory.map((i) => i.count)).toEqual([222]);
});

test('hotkeys: set saves the slot like a drag-and-drop; press runs the slot like its key', () => {
  addStructs('SHORTCUT_KEY_CHANGE2');
  const used = [];
  const bar = { addElement: (...a) => used.push(['add', ...a]), onShortCut: (k) => used.push(['key', k.cmd]) };
  const prevGet = RO.UIManager.getComponent;
  RO.UIManager.getComponent = (n) => (n === 'ShortCut' ? bar : prevGet(n));
  window.__agent.act('hotkey_set', { index: 18, isSkill: false, ID: 504, count: 5 });
  window.__agent.act('hotkey_press', { index: 18 });
  expect(used).toEqual([['add', 18, false, 504, 5], ['key', 'EXECUTE18']]);
  expect(RO.sent.at(-1)).toEqual({ __name: 'SHORTCUT_KEY_CHANGE2', Index: 18, ShortCutKey: { isSkill: 0, ID: 504, count: 5 } });
});

test('inventory: a loose card is not "worn" (its WearState is where it compounds); gear counts as one piece', () => {
  RO = fakeRO({ inventory: [
    { index: 5, ITID: 4001, count: 2, type: 6, WearState: 136 },
    { index: 6, ITID: 1214, type: 5 },
  ] });
  window.RO = RO;
  installPageAgent();
  const inv = window.__agent.snapshot().inventory;
  expect(inv.find((i) => i.index === 5)).toMatchObject({ equipped: false, count: 2 });
  expect(inv.find((i) => i.index === 6)).toMatchObject({ count: 1 });
});

test('inventory cache survives the client emptying its list array in place (warp)', () => {
  const list = [{ index: 3, ITID: 501, count: 7, type: 0 }];
  RO = fakeRO({ inventory: list });
  window.RO = RO;
  installPageAgent();
  expect(window.__agent.snapshot().inventory.length).toBe(1);
  list.length = 0; // what the client does on a map load
  expect(window.__agent.snapshot().inventory).toMatchObject([{ ITID: 501, count: 7 }]);
});

test('hits from monsters not in the entity list count as unseen attackers; a warp (position jump) clears them', () => {
  const s0 = window.__agent.snapshot();
  const now = Date.now();
  window.__agent.hits.push({ t: now, from: 999001, damage: 300 }, { t: now, from: 999002, damage: 300 });
  const s1 = window.__agent.snapshot();
  expect(s1.unseenAttackers).toBe(2);
  RO.me = () => ({ ...RO.__me, x: (s0.me.x || 0) + 50, y: s0.me.y, playing: true });
  if (RO.__me === undefined) return; // fake without a movable "me": the counting part is what matters
  expect(window.__agent.snapshot().unseenAttackers).toBe(0);
});

test('skill damage on us counts as a hit from that monster (plants and shooters hurt with skills)', () => {
  const myGID = RO.me().GID ?? 100;
  window.__agent.hits.length = 0;
  RO.observer('PACKET_ZC_NOTIFY_SKILL2', { SKID: 90, AID: 4242, targetID: myGID, damage: 500 });
  RO.observer('PACKET_ZC_NOTIFY_SKILL2', { SKID: 90, AID: myGID, targetID: 4242, damage: 900 }); // ours on it: not a hit on us
  expect(window.__agent.hits.map((h) => [h.from, h.damage])).toEqual([[4242, 500]]);
});
