import { test, expect, mock, beforeEach, setSystemTime } from 'bun:test';

process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';
const calls = [];
mock.module('../src/browser.js', () => ({
  act: async (_p, name, arg) => calls.push([name, arg]),
  exploreTarget: async () => null,
  query: async () => [],
}));
mock.module('../src/logger.js', () => ({ log: () => {} }));
const { createErrand, purchase, sellable } = await import('../src/errand.js');
const { POTIONS } = await import('../src/potions.js');
const RED = POTIONS[0];
const { buildWorld } = await import('../src/world.js');

const portal = (to) => [0, 0, to, 0, 0, 1, 1, 0, '', 0];
const world = buildWorld(
  { mobs: {}, spawns: [], immobile: [] },
  { edges: { field: [portal('town')], town: [portal('town_in'), portal('field')], town_in: [portal('town')] }, go: [['town', 0, 0]] },
  // No Fly Wings sold here: the wing top-up has its own test (and world) below.
  { shops: [['town_in', 20, 30, 'Tool Dealer', [[501, -1], [502, -1], [503, -1]], 1], ['far_in', 5, 5, 'Tool Dealer', [[501, -1]], 1]] },
);
const fakeTravel = () => {
  const t = { dest: null, canGo: true, async start(m) { t.dest = m; }, async stop() { t.dest = null; }, async tick() { return 'traveling'; } };
  return t;
};
const me = (over = {}) => ({ map: 'field', x: 50, y: 50, baseLevel: 20, zeny: 20000, weight: 3000, maxWeight: 20000, maxHp: 500, hp: 500, walking: false, ...over });
const snap = (over = {}) => ({ me: me(over.me), inventory: [], npcs: [], shop: null, ...over, me: me(over.me) });

test('selling waits for restored equipment confirmation even after the shop opens', async () => {
  let ready = false;
  const loot = { index: 9, ITID: 909, type: 3, count: 40 };
  const review = { equipmentReady: () => ready, saleItems: () => [loot] };
  const e = createErrand({}, world, fakeTravel(), () => null, review);
  const s = snap({ me: { map: 'town_in', x: 20, y: 30 }, inventory: [loot], npcs: [{ GID: 77, name: 'Tool Dealer', x: 20, y: 30 }] });
  e.requestSell();
  expect(e.maybeStart(s)).not.toBeNull();
  await e.tick(s);
  await e.tick(s);
  expect(e.stage).toBe('review');
  await e.tick(s);
  expect(e.stage).toBe('review');
  ready = true;
  await e.tick(s);
  await e.tick(s);
  await e.tick({ ...s, shop: { naid: 77, stage: 'select' } });
  expect(e.stage).toBe('selling');
  const selling = { ...s, shop: { naid: 77, stage: 'sell', list: [{ index: 9, price: 3 }] } };
  ready = false;
  calls.length = 0;
  await e.tick(selling);
  expect(calls).toEqual([]);
  expect(e.stage).toBe('selling');
  ready = true;
  await e.tick(selling);
  expect(calls).toEqual([['sell', { items: [{ index: 9, count: 40 }] }]]);
});

beforeEach(() => (calls.length = 0));

test('approved loot sells without waiting for unrelated appraisal or review', async () => {
  const loot = { index: 9, ITID: 909, count: 10, type: 3 };
  const review = { equipmentReady: () => true, saleItems: () => [loot],
    identify: async () => { throw new Error('must not wait for appraisal'); },
    observe: () => { throw new Error('must not wait for review'); } };
  const e = createErrand({}, world, fakeTravel(), () => null, review);
  const s = snap({ me: { map: 'town_in', x: 20, y: 30 }, inventory: [loot], npcs: [{ GID: 77, name: 'Tool Dealer', x: 20, y: 30 }] });
  e.requestSell(); e.maybeStart(s);
  await e.tick(s); await e.tick(s); await e.tick(s);
  expect(e.stage).toBe('talk_sell');
  await e.tick(s);
  await e.tick({ ...s, shop: { naid: 77, stage: 'select' } });
  await e.tick({ ...s, shop: { stage: 'sell', list: [{ index: 9, price: 3 }] } });
  expect(calls.at(-1)).toEqual(['sell', { items: [{ index: 9, count: 10 }] }]);
});

test('review deadline keeps unapproved items and does not blacklist the shop', async () => {
  let deferred = false;
  const review = { equipmentReady: () => false, defer: () => { deferred = true; }, saleItems: () => [] };
  const e = createErrand({}, world, fakeTravel(), () => null, review);
  const s = snap({ me: { map: 'town_in', x: 20, y: 30 } });
  e.requestSell(); e.maybeStart(s);
  await e.tick(s); await e.tick(s);
  const now = Date.now();
  try {
    setSystemTime(now + 31000);
    const result = await e.tick(s);
    expect(result.ok).toBe(true);
    expect(result.note).toBe('review deferred: items kept');
    expect(deferred).toBe(true);
    expect(calls.some(([n]) => n === 'sell')).toBe(false);
    setSystemTime(now + 3600000);
    e.requestSell();
    expect(e.maybeStart(s).shop.map).toBe('town_in');
  } finally { setSystemTime(); }
});

test('approach releases a leftover shop and dialog before walking after restart', async () => {
  const e = createErrand({}, world, fakeTravel(), () => null);
  const s = snap({ me: { map: 'town_in', x: 10, y: 10 } });
  e.requestSell();
  expect(e.maybeStart(s)).not.toBeNull();
  await e.tick(s);
  await e.tick({ ...s, shop: { stage: 'buy' } });
  expect(calls.at(-1)).toEqual(['close_shop', undefined]);
  await e.tick({ ...s, dialog: { state: 'next', naid: 123 } });
  expect(calls.at(-1)).toEqual(['npc_next', { naid: 123 }]);
  await e.tick(s);
  expect(calls.at(-1)).toEqual(['walk_to', { x: 20, y: 30 }]);
});

/** A trip starts only after potions have looked low for 3s: look twice, 3s apart. */
function startAfterConfirm(e, s) {
  const t = Date.now();
  const first = e.maybeStart(s);
  if (first) return first;
  setSystemTime(t + 3100);
  const r = e.maybeStart(s);
  setSystemTime();
  return r;
}

test('the trip buys what the damage calls for (potions.js), not what the level suggests', () => {
  const hardHits = createErrand({}, world, fakeTravel(), () => 140);
  expect(startAfterConfirm(hardHits, snap({ me: { maxHp: 1000, hp: 1000, zeny: 100000 }, inventory: [] })).why).toContain('Yellow Potion');
  // A potion no shop sells is never planned: White isn't sold here, so heavy hits get Yellow.
  const brutal = createErrand({}, world, fakeTravel(), () => 400);
  expect(startAfterConfirm(brutal, snap({ me: { maxHp: 1000, hp: 1000, zeny: 100000 }, inventory: [] })).why).toContain('Yellow Potion');
  const softHits = createErrand({}, world, fakeTravel(), () => 10);
  expect(startAfterConfirm(softHits, snap({ me: { maxHp: 1000, hp: 1000, zeny: 100000 }, inventory: [] })).why).toContain('Red Potion');
});

test('everything unused is sold — never cards, equipped items, potions/food, SP items, wings or protected gear', () => {
  const inv = [
    { index: 1, type: 3, count: 20, ITID: 909 }, // Jellopy: sell
    { index: 2, type: 6, count: 1, ITID: 4001 }, // card: storage, not the shop
    { index: 3, type: 4, count: 1, ITID: 1101 }, // spare sword: sell
    { index: 4, type: 0, count: 5, ITID: 501 }, // Red Potion: keep
    { index: 5, type: 3, count: 1, ITID: 7000, equipped: true },
    { index: 6, type: 2, count: 2, ITID: 604 }, // Dead Branch: sell
    { index: 7, type: 2, count: 99, ITID: 601 }, // Fly Wing we use: keep
    { index: 8, type: 0, count: 9, ITID: 505 }, // Blue Potion: keep
    { index: 9, type: 5, count: 1, ITID: 2301, keep: 'ตีบวกแล้ว' }, // refined armour: keep
    { index: 10, type: 8, count: 1, ITID: 10004 }, // Pacifier (pet gear): sell
  ];
  expect(sellable(inv).map((i) => i.index)).toEqual([1, 3, 6, 10]);
});

test('purchase stays within budget above half the reserve, weight room and target stock', () => {
  const s = snap({ inventory: [{ ITID: 501, count: 5, type: 0 }] });
  // refill to 15 bars of 500 HP = 7500, minus 5 Red already carried (275) -> 132 Red
  expect(purchase(s, [{ ITID: 501, price: 50 }], RED)).toEqual([{ ITID: 501, count: 132, name: 'Red Potion' }]);
  const poor = snap({ me: { zeny: 6000 } });
  // no potions at all: the reserve may go on an emergency supply, keeping 1000 -> (6000 - 1000) / 50
  expect(purchase(poor, [{ ITID: 501, price: 50 }], RED)[0].count).toBe(100);
  const heavy = snap({ me: { weight: 13500 } });
  expect(purchase(heavy, [{ ITID: 501, price: 50 }], RED)[0].count).toBe(7); // (14000 - 13500) / 70
});

test('decides on its own to go shopping when potions run low, then walks the whole trip', async () => {
  const e = createErrand({}, world, fakeTravel());
  expect(startAfterConfirm(e, snap({ inventory: [{ ITID: 501, count: 40, type: 0 }] }))).toBe(null); // 2200 HP >= 4 bars of 500
  expect(startAfterConfirm(e, snap({ inventory: [{ ITID: 504, count: 6, type: 0 }] }))).toBe(null); // 6 White = 2190 HP: few bottles, plenty of HP
  const started = startAfterConfirm(e, snap({ inventory: [{ ITID: 501, count: 2, type: 0 }, { index: 9, ITID: 909, type: 3, count: 40 }] }));
  expect(started).toMatchObject({ goal: 'buy', shop: { map: 'town_in', name: 'Tool Dealer' } });

  // arrive at the shop map and walk up to the NPC
  await e.tick(snap({ me: { map: 'town_in', x: 10, y: 10 } }));
  await e.tick(snap({ me: { map: 'town_in', x: 10, y: 10 } }));
  expect(calls.at(-1)).toEqual(['walk_to', { x: 20, y: 30 }]);
  const atShop = (over = {}) => snap({ me: { map: 'town_in', x: 19, y: 29 }, npcs: [{ GID: 77, name: 'Tool Dealer', x: 20, y: 30 }], inventory: [{ ITID: 501, count: 2, type: 0 }, { index: 9, ITID: 909, type: 3, count: 40 }], ...over });
  await e.tick(atShop());
  await e.tick(atShop());
  expect(calls.at(-1)).toEqual(['talk', { GID: 77 }]);

  // sell the ETC loot first
  await e.tick(atShop({ shop: { naid: 77, stage: 'select' } }));
  expect(calls.at(-1)).toEqual(['deal', { naid: 77, type: 1 }]);
  await e.tick(atShop({ shop: { naid: 77, stage: 'sell', list: [{ index: 9, price: 3 }] } }));
  expect(calls.at(-1)).toEqual(['sell', { items: [{ index: 9, count: 40 }] }]);
  expect(await e.onEvent({ type: 'shop_result', kind: 'sell', ok: true }, atShop())).toBe(null);

  // then talk again and buy potions
  await e.tick(atShop());
  expect(calls.at(-1)).toEqual(['talk', { GID: 77 }]);
  await e.tick(atShop({ shop: { naid: 77, stage: 'select' } }));
  expect(calls.at(-1)).toEqual(['deal', { naid: 77, type: 0 }]);
  await e.tick(atShop({ shop: { naid: 77, stage: 'buy', list: [{ ITID: 501, price: 50 }, { ITID: 601, price: 60 }] } }));
  // Potions first, then Fly Wings with what's left (here the weight room caps them at 31).
  expect(calls.at(-1)).toEqual(['buy', { items: [{ ITID: 501, count: 135 }, { ITID: 601, count: 31 }] }]);
  const done = await e.onEvent({ type: 'shop_result', kind: 'buy', ok: true }, atShop());
  expect(done).toMatchObject({ ok: true, sold: 40, bought: ['Red Potion x135', 'Fly Wing x31'] });
  expect(e.active).toBe(false);
});

test('goes to sell when the bag is heavy, even with potions', () => {
  const e = createErrand({}, world, fakeTravel());
  const started = startAfterConfirm(e, snap({ me: { weight: 17000 }, inventory: [{ ITID: 501, count: 40, type: 0 }, { index: 9, ITID: 909, type: 3, count: 40 }] }));
  expect(started.goal).toBe('sell');
});

test('gives up cleanly when the NPC is not where the data says', async () => {
  const e = createErrand({}, world, fakeTravel());
  startAfterConfirm(e, snap({ inventory: [] }));
  await e.tick(snap({ me: { map: 'town_in', x: 20, y: 30 } }));
  await e.tick(snap({ me: { map: 'town_in', x: 20, y: 30 } }));
  const done = await e.tick(snap({ me: { map: 'town_in', x: 20, y: 30 } }));
  expect(done).toMatchObject({ ok: false });
  expect(e.active).toBe(false);
});

test('market shop: list opens straight after talking — buy without the buy/sell step', async () => {
  const e = createErrand({}, world, fakeTravel());
  startAfterConfirm(e, snap({ inventory: [] }));
  const atShop = (over = {}) => snap({ me: { map: 'town_in', x: 19, y: 29 }, npcs: [{ GID: 77, name: 'Tool Dealer', x: 20, y: 30 }], inventory: [], ...over });
  await e.tick(atShop());
  await e.tick(atShop());
  await e.tick(atShop()); // talk
  await e.tick(atShop({ shop: { kind: 'market', stage: 'buy', list: [{ ITID: 501, price: 50, stock: 20 }] } }));
  await e.tick(atShop({ shop: { kind: 'market', stage: 'buy', list: [{ ITID: 501, price: 50, stock: 20 }] } }));
  expect(calls.at(-1)).toEqual(['buy', { items: [{ ITID: 501, count: 20 }] }]); // capped by the market's stock
});

test('out of potions: the reserve may be spent on an emergency supply (it exists for potions)', async () => {
  const { potionBudget } = await import('../src/errand.js');
  const broke = { zeny: 18000, baseLevel: 83, maxHp: 4847 }; // reserve at 83 = 41500
  expect(potionBudget(broke, [])).toBe(17000); // keep 1000 pocket money
  expect(potionBudget(broke, [{ ITID: 504, count: 50 }])).toBeLessThan(0); // stocked: normal rule, no spending
  const e = createErrand({}, world, fakeTravel(), () => 50);
  const started = startAfterConfirm(e, snap({ me: { zeny: 18000, baseLevel: 83, maxHp: 4847, hp: 4847 }, inventory: [] }));
  expect(started && started.goal).toBe('buy');
});

test('a single empty-inventory blink does not start a trip (it once looped to the shop every 10s)', () => {
  const e = createErrand({}, world, fakeTravel());
  expect(e.maybeStart(snap({ inventory: [] }))).toBe(null); // first sight of "no potions": wait
  expect(e.maybeStart(snap({ inventory: [{ ITID: 504, count: 222, type: 0 }] }))).toBe(null); // it was a blink
  expect(e.maybeStart(snap({ inventory: [] }))).toBe(null); // the clock started over
});

test('right after a map change the bag is still reloading: no shopping decision is made', () => {
  const e = createErrand({}, world, fakeTravel());
  expect(startAfterConfirm(e, snap({ inventory: [], mapAgeMs: 2000 }))).toBe(null);
  // An empty bag within a minute of a warp is still the reload (it read empty 1-3s after @go).
  expect(startAfterConfirm(e, snap({ inventory: [], mapAgeMs: 20000 }))).toBe(null);
  // A real bag (loot, no potions) after the settle time: go shopping.
  expect(startAfterConfirm(e, snap({ inventory: [{ index: 9, ITID: 909, count: 3, type: 3 }], mapAgeMs: 20000 }))).not.toBe(null);
});

test('SP running low: the trip buys Blue Potions too (after HP), within what is left', () => {
  const blueWorld = buildWorld(
    { mobs: {}, spawns: [], immobile: [] },
    { edges: { field: [portal('town')], town: [portal('town_in'), portal('field')], town_in: [portal('town')] }, go: [['town', 0, 0]] },
    { shops: [['town_in', 20, 30, 'Tool Dealer', [[501, -1], [502, -1], [503, -1], [505, -1]], 1]] },
  );
  const e = createErrand({}, blueWorld, fakeTravel());
  const rich = { me: { maxSp: 400, sp: 50, zeny: 100000, maxHp: 500, hp: 500 } };
  const started = startAfterConfirm(e, snap({ ...rich, inventory: [{ ITID: 504, count: 50, type: 0 }] })); // HP fine, SP none
  expect(started.why).toContain('Blue Potion');
  const items = purchase(snap({ ...rich, inventory: [{ ITID: 504, count: 50, type: 0 }] }), [{ ITID: 505, price: 5000 }], null, null, { ITID: 505, name: 'Blue Potion', sp: [40, 60], weight: 150 });
  expect(items[0]).toMatchObject({ ITID: 505 });
  expect(items[0].count).toBeGreaterThan(0);
  expect(items[0].count * 5000).toBeLessThanOrEqual(100000);
});

test('SP gone and broke below the reserve: spend it on what Blue Potions it can buy (no sitting)', () => {
  const blueWorld = buildWorld(
    { mobs: {}, spawns: [], immobile: [] },
    { edges: { field: [portal('town')], town: [portal('town_in'), portal('field')], town_in: [portal('town')] }, go: [['town', 0, 0]] },
    { shops: [['town_in', 20, 30, 'Tool Dealer', [[501, -1], [505, -1]], 1]] },
  );
  const e = createErrand({}, blueWorld, fakeTravel());
  // The live case: Base 85, 12300 zeny (reserve 42000), plenty of HP potions, SP at 1.
  const broke = { me: { baseLevel: 85, zeny: 12300, maxSp: 300, sp: 1, maxHp: 5000, hp: 4000 }, inventory: [{ ITID: 504, count: 50, type: 0 }] };
  const started = startAfterConfirm(e, snap(broke));
  expect(started.why).toContain('Blue Potion');
  const items = purchase(snap(broke), [{ ITID: 505, price: 5000 }], null, null, { ITID: 505, name: 'Blue Potion', sp: [40, 60], weight: 150 });
  expect(items[0]).toMatchObject({ ITID: 505, count: 2 }); // 11300 spendable, 1000 kept
});

test('out of Fly Wings (owner: warp around for monsters): a trip of its own, wings bought with pocket money kept', () => {
  const wingWorld = buildWorld(
    { mobs: {}, spawns: [], immobile: [] },
    { edges: { field: [portal('town')], town: [portal('town_in'), portal('field')], town_in: [portal('town')] }, go: [['town', 0, 0]] },
    { shops: [['town_in', 20, 30, 'Tool Dealer', [[501, -1], [601, -1]], 1]] },
  );
  const e = createErrand({}, wingWorld, fakeTravel());
  const stocked = [{ ITID: 504, count: 50, type: 0 }]; // potions fine
  const started = startAfterConfirm(e, snap({ me: { zeny: 3000 }, inventory: stocked }));
  expect(started).toMatchObject({ goal: 'buy' });
  expect(started.why).toContain('Fly Wing');
  const items = purchase(snap({ me: { zeny: 3000 }, inventory: stocked }), [{ ITID: 601, price: 60 }], null, null, null, true);
  expect(items).toEqual([{ ITID: 601, count: 30, name: 'Fly Wing' }]); // at most 60% of 3000 zeny: 1800 / 60
  // Plenty of wings: no trip for them.
  const e2 = createErrand({}, wingWorld, fakeTravel());
  expect(startAfterConfirm(e2, snap({ me: { zeny: 3000 }, inventory: [...stocked, { ITID: 601, count: 40, type: 2 }] }))).toBe(null);
});

test('the price the shop really asked is what the next trip is judged by (Blue Potion ~230 here, not 5000)', async () => {
  const blueWorld = buildWorld(
    { mobs: {}, spawns: [], immobile: [] },
    { edges: { field: [portal('town')], town: [portal('town_in'), portal('field')], town_in: [portal('town')] }, go: [['town', 0, 0]] },
    { shops: [['town_in', 20, 30, 'Tool Dealer', [[501, -1], [505, -1]], 1]] },
  );
  const e = createErrand({}, blueWorld, fakeTravel());
  const bag = [{ ITID: 504, count: 50, type: 0 }, { ITID: 505, count: 5, type: 0 }];
  // 3000 zeny, reserve 10000 at Base 20: by the table (5000 each) not even one is affordable.
  const poor = { me: { zeny: 3000, maxSp: 400, sp: 300, baseLevel: 20 }, inventory: bag };
  expect(startAfterConfirm(e, snap(poor))).toBe(null);
  // A trip shows the real price...
  e.requestBuy(RED, 'test');
  e.maybeStart(snap(poor));
  const atShop = (over = {}) => snap({ me: { map: 'town_in', x: 19, y: 29, zeny: 3000, maxSp: 400, sp: 300, baseLevel: 20 }, npcs: [{ GID: 77, name: 'Tool Dealer', x: 20, y: 30 }], inventory: bag, ...over });
  await e.tick(atShop());
  await e.tick(atShop());
  await e.tick(atShop());
  await e.tick(atShop({ shop: { naid: 77, stage: 'select' } }));
  await e.tick(atShop({ shop: { naid: 77, stage: 'buy', list: [{ ITID: 501, price: 50 }, { ITID: 505, price: 230 }] } }));
  // ...and at the counter SP potions were topped up too, unplanned.
  expect(calls.at(-1)[0]).toBe('buy');
  expect(calls.at(-1)[1].items.some((i) => i.ITID === 505)).toBe(true);
});

test('a trip for one thing tops up the rest at the counter (HP potions on an SP/wing trip)', async () => {
  const e = createErrand({}, world, fakeTravel());
  e.requestBuy(RED, 'test');
  e.plan = null;
  e.maybeStart(snap({ inventory: [] }));
  // Pretend the plan was SP-only: no HP potion planned.
  const atShop = (over = {}) => snap({ me: { map: 'town_in', x: 19, y: 29 }, npcs: [{ GID: 77, name: 'Tool Dealer', x: 20, y: 30 }], inventory: [{ ITID: 501, count: 3, type: 0 }], ...over });
  await e.tick(atShop());
  await e.tick(atShop());
  await e.tick(atShop());
  await e.tick(atShop({ shop: { naid: 77, stage: 'select' } }));
  await e.tick(atShop({ shop: { naid: 77, stage: 'buy', list: [{ ITID: 501, price: 50 }] } }));
  expect(calls.at(-1)[0]).toBe('buy');
  expect(calls.at(-1)[1].items[0]).toMatchObject({ ITID: 501 });
  // A full bag: nothing more of it.
  expect(purchase(snap({ inventory: [{ ITID: 504, count: 99, type: 0 }] }), [{ ITID: 501, price: 50 }], RED)).toEqual([]);
});

test('SP / wing top-ups wait 5 minutes after a trip; an HP shortage does not wait', async () => {
  const { setSystemTime } = require('bun:test');
  const wingWorld = buildWorld(
    { mobs: {}, spawns: [], immobile: [] },
    { edges: { field: [portal('town')], town: [portal('town_in'), portal('field')], town_in: [portal('town')] }, go: [['town', 0, 0]] },
    // Two dealers: the failed trip below marks the first one bad for 10 minutes.
    { shops: [['town_in', 20, 30, 'Tool Dealer', [[501, -1], [601, -1]], 1], ['town_in', 40, 30, 'General Store', [[501, -1], [601, -1]], 1]] },
  );
  const e = createErrand({}, wingWorld, fakeTravel());
  const t0 = Date.now();
  e.requestBuy(RED, 'test');
  e.maybeStart(snap({ inventory: [] }));
  setSystemTime(t0 + 16 * 60 * 1000);
  expect(await e.tick(snap())).toMatchObject({ ok: false }); // the trip ends (travel timeout)
  const after = t0 + 16 * 60 * 1000 + 61000; // past the failure cooldown
  const stocked = [{ ITID: 504, count: 50, type: 0 }, { ITID: 505, count: 3, type: 0 }]; // HP fine, no wings
  setSystemTime(after);
  expect(e.maybeStart(snap({ me: { zeny: 3000 }, inventory: stocked }))).toBe(null);
  setSystemTime(after + 3100);
  expect(e.maybeStart(snap({ me: { zeny: 3000 }, inventory: stocked }))).toBe(null); // wings low, but it waits
  // HP potions gone: that one goes at once (no 5-minute wait).
  setSystemTime(after + 3200);
  const first = e.maybeStart(snap({ me: { zeny: 3000 }, inventory: [] }));
  setSystemTime(after + 6400);
  const second = first || e.maybeStart(snap({ me: { zeny: 3000 }, inventory: [] }));
  expect(second).toMatchObject({ goal: 'buy' });
  setSystemTime();
});

test('potions before wings: short of HP potions, the money goes on them (reserve too), wings only after', () => {
  // Base 89-ish reserve, 6000 zeny, 2 Red Potions left: the live case that bought 26 Fly Wings and no potions.
  const poor = snap({ me: { zeny: 6000, baseLevel: 89, maxHp: 5700, hp: 5700 }, inventory: [{ ITID: 501, count: 2, type: 0 }] });
  const items = purchase(poor, [{ ITID: 502, price: 38 }, { ITID: 601, price: 190 }], RED, 150, null, true);
  expect(items[0]).toMatchObject({ ITID: 502 });
  expect(items[0].count).toBeGreaterThan(0);
  const wings = items.find((i) => i.ITID === 601);
  if (wings) expect(wings.count * 190 + items[0].count * 38).toBeLessThanOrEqual(5000);
});

test('one trip, everything for the same stretch: amounts follow how fast each is used, within money and weight', async () => {
  const { balancedPurchase } = await import('../src/errand.js');
  const me = { zeny: 20000, maxHp: 5000, hp: 5000, maxSp: 300, sp: 300, weight: 1000, maxWeight: 20000, baseLevel: 89 };
  const list = [{ ITID: 502, price: 38 }, { ITID: 505, price: 1520 }, { ITID: 601, price: 190 }];
  // Per minute: 2000 HP of potions, 100 SP, 3 wings. Nothing in the bag.
  const items = balancedPurchase(snap({ me, inventory: [] }), list, { hp: 2000, sp: 100, wing: 3 }, 50);
  const by = Object.fromEntries(items.map((i) => [i.ITID, i.count]));
  expect(by[505]).toBeGreaterThan(0);
  expect(by[601]).toBeGreaterThan(0);
  expect(by[502]).toBeGreaterThan(0);
  const cost = (by[502] || 0) * 38 + (by[505] || 0) * 1520 + (by[601] || 0) * 190;
  expect(cost).toBeLessThanOrEqual(19000); // pocket money kept
  // Each lasts about the same: minutes of SP ≈ minutes of wings.
  const spMin = (by[505] * 50) / 100;
  const wingMin = by[601] / 3;
  expect(Math.abs(spMin - wingMin)).toBeLessThan(1.5);
  expect(items.minutes).toBeGreaterThan(0);
  // Already stocked for longer than the cap: nothing to buy.
  const full = [{ ITID: 502, count: 2000, type: 0 }, { ITID: 505, count: 200, type: 0 }, { ITID: 601, count: 500, type: 2 }];
  expect(balancedPurchase(snap({ me, inventory: full }), list, { hp: 2000, sp: 100, wing: 3 }, 50)).toEqual([]);
});

test('usage rates come from the bag shrinking over time; a partial bag read is not counted as use', () => {
  const { setSystemTime } = require('bun:test');
  const e = createErrand({}, world, fakeTravel());
  const t0 = Date.now();
  const bag = (wings, extra = []) => [{ ITID: 601, count: wings, type: 2 }, { ITID: 909, count: 5, type: 3 }, { ITID: 910, count: 5, type: 3 }, { ITID: 911, count: 5, type: 3 }, { ITID: 912, count: 5, type: 3 }, ...extra];
  e.observe(snap({ inventory: bag(100) }));
  setSystemTime(t0 + 60000);
  e.observe(snap({ inventory: [{ ITID: 601, count: 1, type: 2 }] })); // half the bag missing: a refresh, not use
  setSystemTime(t0 + 120000);
  e.observe(snap({ inventory: bag(94) }));
  expect(e.rates()).toBe(null); // not enough history yet
  setSystemTime(t0 + 6 * 60000);
  e.observe(snap({ inventory: bag(82) }));
  const r = e.rates();
  setSystemTime();
  expect(r.wing).toBeCloseTo(3, 0); // 18 wings in 6 minutes
  expect(r.hp).toBe(0);
});

test('with usage rates known, SP "low" means it runs out within 4 minutes — not a fixed amount', () => {
  const { setSystemTime } = require('bun:test');
  const blueWorld = buildWorld(
    { mobs: {}, spawns: [], immobile: [] },
    { edges: { field: [portal('town')], town: [portal('town_in'), portal('field')], town_in: [portal('town')] }, go: [['town', 0, 0]] },
    { shops: [['town_in', 20, 30, 'Tool Dealer', [[501, -1], [505, -1]], 1]] },
  );
  const e = createErrand({}, blueWorld, fakeTravel());
  const t0 = Date.now();
  const me = { maxSp: 300, sp: 300, zeny: 100000, maxHp: 500, hp: 500 };
  const bag = (blue) => [{ ITID: 504, count: 99, type: 0 }, { ITID: 505, count: blue, type: 0 }, { ITID: 909, count: 1, type: 3 }];
  // 6 minutes of history using one Blue Potion (50 SP) every 3 minutes: ~17 SP/min.
  e.observe(snap({ me, inventory: bag(10) }));
  setSystemTime(t0 + 3 * 60000);
  e.observe(snap({ me, inventory: bag(9) }));
  setSystemTime(t0 + 6 * 60000);
  e.observe(snap({ me, inventory: bag(8) }));
  // 8 Blue Potions = 400 SP: under the old "4 x max SP" (1200) it would go shopping; at 17/min it lasts ~24 min.
  expect(startAfterConfirm(e, snap({ me, inventory: bag(8) }))).toBe(null);
  setSystemTime();
});

test('a sensible amount, money kept: 20 minutes of past use, at most 60% of zeny (all of it only when HP potions are short)', async () => {
  const { balancedPurchase } = await import('../src/errand.js');
  const list = [{ ITID: 502, price: 38 }, { ITID: 505, price: 1520 }, { ITID: 601, price: 190 }];
  const rates = { hp: 1000, sp: 50, wing: 2 };
  const stocked = [{ ITID: 502, count: 100, type: 0 }]; // ~12500 HP, over 4 bars of 2000: not short
  // Rich: buys for 20 minutes only, far below what the money could pay for.
  const rich = { zeny: 1000000, maxHp: 2000, hp: 2000, maxSp: 300, sp: 300, weight: 0, maxWeight: 100000 };
  const lots = balancedPurchase(snap({ me: rich, inventory: stocked }), list, rates, 30);
  expect(lots.minutes).toBe(20);
  const by = Object.fromEntries(lots.map((i) => [i.ITID, i.count]));
  expect(by[601]).toBe(40); // 2/min x 20
  expect(by[505]).toBe(20); // 50 SP/min x 20 = 1000 SP / 50 per bottle
  // Poor-ish: spends at most 60% of what it has.
  const some = { ...rich, zeny: 10000 };
  const few = balancedPurchase(snap({ me: some, inventory: stocked }), list, rates, 30);
  const cost = few.reduce((z, i) => z + i.count * list.find((o) => o.ITID === i.ITID).price, 0);
  expect(cost).toBeLessThanOrEqual(6000);
});

test('SP potions are bought by use: slow use with stock to spare buys none; out of them buys 20 minutes worth', async () => {
  const { balancedPurchase } = await import('../src/errand.js');
  const list = [{ ITID: 502, price: 38 }, { ITID: 505, price: 1520 }, { ITID: 601, price: 190 }];
  const me = { zeny: 50000, maxHp: 2000, hp: 2000, maxSp: 400, sp: 400, weight: 0, maxWeight: 100000 };
  const rest = [{ ITID: 502, count: 400, type: 0 }, { ITID: 601, count: 200, type: 2 }];
  const rates = { hp: 500, sp: 9, wing: 2 };
  // 4 bottles = 200 SP: more than 20 minutes at 9/min (180) — nothing to buy, whatever max SP is.
  const enough = balancedPurchase(snap({ me, inventory: [...rest, { ITID: 505, count: 4, type: 0 }] }), list, rates, 30);
  expect(enough.find((x) => x.ITID === 505)).toBeUndefined();
  // None left: 180 SP for 20 minutes -> 4 bottles.
  const none = balancedPurchase(snap({ me, inventory: rest }), list, rates, 30);
  expect(none.find((x) => x.ITID === 505)).toMatchObject({ count: 4 });
});

test('a trip sent by the HP-potion line buys well past it (twice), not to one potion over it', async () => {
  const { balancedPurchase } = await import('../src/errand.js');
  const list = [{ ITID: 501, price: 7 }, { ITID: 502, price: 38 }];
  const me = { zeny: 34520, maxHp: 6391, hp: 6391, maxSp: 385, sp: 385, weight: 23960, maxWeight: 75200 };
  // ~3.9 bars of potions (just under the 4-bar line), slow use: 20 minutes is already covered.
  const bag = [{ ITID: 502, count: 180, type: 0 }];
  const items = balancedPurchase(snap({ me, inventory: bag }), list, { hp: 500, sp: 0, wing: 0 }, 50);
  const { stockHp, healOf, POTIONS } = await import('../src/potions.js');
  const after = stockHp(bag, me) + items.reduce((n, i) => n + i.count * healOf(POTIONS.find((p) => p.ITID === i.ITID), me), 0);
  // Up to 8 bars if money and weight allow; here Red Potions' weight caps it, still far past the 4-bar line.
  expect(after).toBeGreaterThanOrEqual(me.maxHp * 4 * 1.5);
});

test('a zero SP rate (not measured) still buys SP potions when the bag is under half an SP bar', async () => {
  const { balancedPurchase } = await import('../src/errand.js');
  const list = [{ ITID: 502, price: 38 }, { ITID: 505, price: 1520 }];
  const me = { zeny: 50000, maxHp: 2000, hp: 2000, maxSp: 400, sp: 400, weight: 0, maxWeight: 100000 };
  const items = balancedPurchase(snap({ me, inventory: [{ ITID: 502, count: 400, type: 0 }] }), list, { hp: 100, sp: 0, wing: 0 }, 30);
  expect(items.find((i) => i.ITID === 505)).toMatchObject({ count: 4 }); // up to 200 SP = half a bar
});
