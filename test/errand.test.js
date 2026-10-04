import { test, expect, mock, beforeEach, afterEach, setSystemTime } from 'bun:test';

process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';
const calls = [];
let refuseSell = false; // the client refuses a sale (protected gear, unreadable bag): act('sell') -> false
mock.module('../src/browser.js', () => ({
  act: async (_p, name, arg) => (name === 'sell' && refuseSell ? (calls.push([name, arg]), false) : calls.push([name, arg])),
  exploreTarget: async () => null,
  query: async () => [],
}));
mock.module('../src/logger.js', () => ({ log: () => {} }));
let layaDown = false;
// LAYA picks the first loadout it is offered.
mock.module('../src/laya.js', () => ({
  choose: async (_state, _instructions, options) => { if (layaDown) throw new Error('LAYA down'); return { choice: Object.keys(options)[0], confidence: 0.9 }; },
  ask: async () => ({}),
}));
const { createErrand, MONEY_RESERVE, moneyTarget } = await import('../src/errand.js');
const { POTIONS } = await import('../src/potions.js');
const RED = POTIONS[0];
const { buildWorld } = await import('../src/world.js');

const portal = (to) => [0, 0, to, 0, 0, 1, 1, 0, '', 0];
const edges = { field: [portal('town')], town: [portal('town_in'), portal('field')], town_in: [portal('town')] };
// 'field' has a monster spawn, so it is not a town; 'town' (an @go city) and 'town_in' are.
const spawns = [['field', 1002, 5]];
const world = buildWorld(
  { mobs: {}, spawns, immobile: [] },
  { edges, go: [['town', 0, 0]] },
  // No Fly Wings sold here: the wing top-up has its own test (and world) below.
  { shops: [['town_in', 20, 30, 'Tool Dealer', [[501, -1], [502, -1], [503, -1]], 1], ['far_in', 5, 5, 'Tool Dealer', [[501, -1]], 1]] },
);
const shopWorld = (...shops) => buildWorld({ mobs: {}, spawns, immobile: [] }, { edges, go: [['town', 0, 0]] }, { shops });
const fakeTravel = () => {
  const t = { dest: null, canGo: true, async start(m) { t.dest = m; }, async stop() { t.dest = null; }, async tick() { return 'traveling'; } };
  return t;
};
// The client has no junk-sale support here: the junk step is skipped and the normal sale goes on.
const page = { evaluate: async () => false };
const me = (over = {}) => ({ map: 'field', x: 50, y: 50, baseLevel: 20, zeny: 200000, weight: 3000, maxWeight: 20000, maxHp: 500, hp: 500, walking: false, ...over });
const snap = (over = {}) => ({ me: me(over.me), inventory: [], npcs: [], shop: null, ...over, me: me(over.me) });
const mk = (w = world, getDps = () => null, review = null, storage = null, p = page) => createErrand(p, w, fakeTravel(), getDps, review, storage);

/** A trip starts only after potions have looked low for 3s: look twice, 3s apart. */
function startAfterConfirm(e, s) {
  const t = Date.now();
  const first = e.maybeStart(s);
  if (first) return first;
  setSystemTime(t + 3100); // stays moved on: later steps must not travel back before the cooldowns
  return e.maybeStart(s);
}

/** Town services are done once per return from the field: use up the first trip, then it is the top-ups' turn. */
async function serviceTown(e, s, after = 0) {
  const t0 = Date.now();
  expect(e.maybeStart(s)).not.toBeNull();
  setSystemTime(t0 + 16 * 60 * 1000);
  expect(await e.tick(s)).toMatchObject({ ok: false }); // the trip ends (travel timeout)
  setSystemTime(t0 + 16 * 60 * 1000 + 10 * 60 * 1000 + 1000 + after); // past the failure cooldown and the shop's blacklisting
}

const atShop = (over = {}) => snap({ me: { map: 'town_in', x: 19, y: 29, ...over.me }, npcs: [{ GID: 77, name: 'Tool Dealer', x: 20, y: 30 }], ...over, me: { map: 'town_in', x: 19, y: 29, ...over.me } });
/** From arriving on the shop's map to its buy list being open: sale step first (nothing to sell), then talk again to buy. */
async function reachBuyList(e, list, over = {}) {
  for (let i = 0; i < 3; i++) await e.tick(atShop(over)); // travel -> deposit -> approach -> talk_sell
  await e.tick(atShop(over)); // talk
  await e.tick(atShop({ ...over, shop: { naid: 77, stage: 'select' } })); // sell side
  await e.tick(atShop({ ...over, shop: { naid: 77, stage: 'sell', list: [] } })); // junk step skipped
  await e.tick(atShop({ ...over, shop: { naid: 77, stage: 'sell', list: [] } })); // nothing to sell: close, back to the counter
  await e.tick(atShop(over)); // talk
  await e.tick(atShop({ ...over, shop: { naid: 77, stage: 'select' } })); // buy side
  await e.tick(atShop({ ...over, shop: { naid: 77, stage: 'buy', list } }));
  return calls.at(-1);
}

beforeEach(() => (calls.length = 0));
afterEach(() => setSystemTime());

test('outbound hunt ignores leftover sale candidates and ordinary potion topups', () => {
  const loot = { index: 9, ITID: 909, type: 3, count: 40 };
  const e = mk(world, () => null, { needsSaleReview: () => true, saleItems: () => [loot] });
  const s = snap({ mapAgeMs: 60000, me: { map: 'town', zeny: 120000 }, inventory: [loot, { ITID: 501, count: 1 }] });
  e.observe(s, 'money', { hunting: false });
  expect(e.maybeStart(s, { outbound: true })).toBeNull();
  expect(e.maybeStart({ ...s, me: { ...s.me, map: 'field' } }, { outbound: true })).toBeNull();
});

test('outbound: a pending potion upgrade is still bought before leaving (it used to wait a minute into the hunt)', () => {
  const e = mk(world);
  e.requestBuy(RED, 'potions too weak');
  const s = snap({ mapAgeMs: 60000, me: { map: 'field' }, inventory: [{ ITID: 501, count: 400 }] });
  expect(e.maybeStart(s, { outbound: true })).toMatchObject({ goal: 'buy' });
});

test('outbound: HP potions that are nearly gone (not zero) go now, confirmed for 3s, and nothing else does', () => {
  const loot = { index: 9, ITID: 909, type: 3, count: 40 };
  const e = mk(world, () => null, { needsSaleReview: () => true, saleItems: () => [loot] });
  const s = snap({ mapAgeMs: 60000, me: { map: 'field' }, inventory: [loot, { ITID: 501, count: 1 }] });
  expect(e.maybeStart(s, { outbound: true })).toBeNull();
  setSystemTime(Date.now() + 3100);
  const trip = e.maybeStart(s, { outbound: true });
  expect(trip).toMatchObject({ goal: 'buy' });
});

test('long hunts do not leave for low but nonempty supplies or 80 percent weight', () => {
  const loot = { index: 9, ITID: 909, type: 3, count: 40 };
  const e = mk(world, () => null, { needsSaleReview: () => true, saleItems: () => [loot] });
  const s = snap({ mapAgeMs: 3600000, me: { map: 'field', zeny: 200000, weight: 17000 }, inventory: [loot, { ITID: 501, count: 1 }] });
  e.observe(s, 'money', { hunting: true });
  expect(e.maybeStart(s)).toBeNull();
  e.requestBuy(RED, 'routine low stock');
  expect(e.maybeStart(s)).toBeNull();
  expect(e.maybeStart({ ...s, me: { ...s.me, map: 'town' } })).not.toBeNull();
});

test('outbound hunt still allows confirmed empty supplies and disabling weight', () => {
  const e = mk(world, () => null, { needsSaleReview: () => true, saleItems: () => [] });
  const s = snap({ mapAgeMs: 60000, inventory: [{ ITID: 909, count: 5 }] });
  expect(e.maybeStart(s, { outbound: true })).toBeNull();
  setSystemTime(Date.now() + 4000);
  expect(e.maybeStart(s, { outbound: true })).not.toBeNull();
  const heavy = mk(world, () => null, { needsSaleReview: () => true, saleItems: () => [] });
  expect(heavy.maybeStart(snap({ me: { weight: 19000 }, inventory: [{ ITID: 501, count: 10 }] }), { outbound: true })).not.toBeNull();
});

test('selling waits for restored equipment confirmation even after the shop opens', async () => {
  let ready = false;
  const loot = { index: 9, ITID: 909, type: 3, count: 40 };
  const e = mk(world, () => null, { equipmentReady: () => ready, saleItems: () => [loot] });
  const s = atShop({ inventory: [loot] });
  e.requestSell();
  expect(e.maybeStart(s)).not.toBeNull();
  for (let i = 0; i < 3; i++) await e.tick(s); // travel -> deposit -> approach -> talk_sell
  await e.tick(s); // talk
  await e.tick({ ...s, shop: { naid: 77, stage: 'select' } });
  expect(e.stage).toBe('selling');
  const selling = { ...s, shop: { naid: 77, stage: 'sell', list: [{ index: 9, price: 3 }] } };
  await e.tick(selling); // junk step (skipped here)
  calls.length = 0;
  await e.tick(selling);
  expect(calls).toEqual([]);
  expect(e.stage).toBe('selling');
  ready = true;
  await e.tick(selling);
  expect(calls).toEqual([['sell', { items: [{ index: 9, count: 40 }] }]]);
});

test('approved loot sells without waiting for unrelated appraisal or review', async () => {
  const loot = { index: 9, ITID: 909, count: 10, type: 3 };
  const review = { equipmentReady: () => true, saleItems: () => [loot],
    identify: async () => { throw new Error('must not wait for appraisal'); },
    observe: () => { throw new Error('must not wait for review'); } };
  const e = mk(world, () => null, review);
  const s = atShop({ inventory: [loot] });
  e.requestSell(); e.maybeStart(s);
  await e.tick(s); await e.tick(s); await e.tick(s);
  expect(e.stage).toBe('talk_sell');
  await e.tick(s);
  await e.tick({ ...s, shop: { naid: 77, stage: 'select' } });
  const selling = { ...s, shop: { naid: 77, stage: 'sell', list: [{ index: 9, price: 3 }] } };
  await e.tick(selling); // junk step (skipped here)
  await e.tick(selling);
  expect(calls.at(-1)).toEqual(['sell', { items: [{ index: 9, count: 10 }] }]);
});

test('a refused sale ends the trip at once instead of waiting in sell_wait, and releases the travel', async () => {
  const loot = { index: 9, ITID: 909, count: 10, type: 3 };
  const t = fakeTravel();
  const e = createErrand(page, world, t, () => null, { equipmentReady: () => true, saleItems: () => [loot] }, null);
  const s = atShop({ inventory: [loot] });
  e.requestSell(); e.maybeStart(s);
  for (let i = 0; i < 4; i++) await e.tick(s);
  t.dest = 'town_in'; // the shared travel still points at the shop
  await e.tick({ ...s, shop: { naid: 77, stage: 'select' } });
  const selling = { ...s, shop: { naid: 77, stage: 'sell', list: [{ index: 9, price: 3 }] } };
  await e.tick(selling); // junk step (skipped here)
  refuseSell = true;
  const result = await e.tick(selling);
  refuseSell = false;
  expect(result).toMatchObject({ ok: false, note: 'sale refused by the client' });
  expect(e.active).toBe(false);
  expect(t.dest).toBe(null);
});

test('a failed trip stops the shared travel', async () => {
  const t = fakeTravel();
  const e = createErrand(page, world, t, () => null, { equipmentReady: () => true, saleItems: () => [{ index: 9, ITID: 909, count: 10, type: 3 }] }, null);
  const s = snap({ inventory: [{ ITID: 501, count: 10 }], me: { map: 'field', weight: 19000 } });
  e.requestSell();
  expect(e.maybeStart(s)).not.toBeNull();
  await e.tick(s); // travel starts toward the shop map
  expect(t.dest).not.toBe(null);
  setSystemTime(Date.now() + 16 * 60 * 1000);
  expect(await e.tick(s)).toMatchObject({ ok: false });
  expect(t.dest).toBe(null);
});

test('a junk sale that throws (client without JunkData, panel that will not open) does not stop the trip', async () => {
  const loot = { index: 9, ITID: 909, count: 10, type: 3 };
  const e = mk(world, () => null, { equipmentReady: () => true, saleItems: () => [loot] }, null, {}); // {} has no evaluate: sellJunk throws
  const s = atShop({ inventory: [loot] });
  e.requestSell(); e.maybeStart(s);
  for (let i = 0; i < 4; i++) await e.tick(s);
  const selling = { ...s, shop: { naid: 77, stage: 'sell', list: [{ index: 9, price: 3 }] } };
  await e.tick({ ...s, shop: { naid: 77, stage: 'select' } });
  await e.tick(selling);
  expect(e.active).toBe(true);
  await e.tick(selling);
  expect(calls.at(-1)).toEqual(['sell', { items: [{ index: 9, count: 10 }] }]);
});

test('review deadline keeps unapproved items and does not blacklist the shop', async () => {
  let items = [{ index: 9, ITID: 909, count: 10, type: 3 }];
  let deferred = false;
  // The junk panel is there but the client says nothing is junk: straight on to the review.
  const junkPage = { evaluate: async () => true, locator: () => ({ count: async () => 1, isDisabled: async () => true }) };
  const review = { equipmentReady: () => false, defer: () => { deferred = true; }, saleItems: () => items };
  const e = mk(world, () => null, review, null, junkPage);
  const s = atShop({ inventory: items });
  e.requestSell(); e.maybeStart(s);
  for (let i = 0; i < 4; i++) await e.tick(s);
  await e.tick({ ...s, shop: { naid: 77, stage: 'select' } });
  await e.tick({ ...s, shop: { naid: 77, stage: 'sell', list: [] } });
  expect(e.stage).toBe('review');
  const now = Date.now();
  items = [];
  setSystemTime(now + 31000);
  const result = await e.tick(s);
  expect(result.ok).toBe(true);
  expect(result.note).toBe('review deferred: items kept');
  expect(deferred).toBe(true);
  expect(calls.some(([n]) => n === 'sell')).toBe(false);
  setSystemTime(now + 3600000);
  items = [{ index: 9, ITID: 909, count: 10, type: 3 }];
  e.requestSell();
  expect(e.maybeStart(s).shop.map).toBe('town_in');
});

test('approach releases a leftover shop and dialog before walking after restart', async () => {
  const e = mk();
  const s = snap({ me: { map: 'town_in', x: 10, y: 10 } });
  e.requestSell();
  expect(e.maybeStart(s)).not.toBeNull();
  await e.tick(s); // travel -> deposit
  await e.tick(s); // deposit -> approach
  await e.tick({ ...s, shop: { stage: 'buy' } });
  expect(calls.at(-1)).toEqual(['close_shop', undefined]);
  await e.tick({ ...s, dialog: { state: 'next', naid: 123 } });
  expect(calls.at(-1)).toEqual(['npc_next', { naid: 123 }]);
  await e.tick(s);
  expect(calls.at(-1)).toEqual(['walk_to', { x: 20, y: 30 }]);
});

test('ores in the bag and no Kafra here (most Tool Dealers are indoors): the trip goes on, the ores stay', async () => {
  const ore = { index: 4, ITID: 984, name: 'Oridecon', count: 1, type: 3 };
  const storage = { active: false, retryAt: 0, maybeStart: () => false, tick: async () => null };
  const e = mk(world, () => null, null, storage);
  const s = snap({ me: { map: 'town_in', x: 10, y: 10 }, inventory: [ore] });
  e.requestSell();
  expect(e.maybeStart(s)).not.toBeNull();
  await e.tick(s); // travel -> deposit
  expect(await e.tick(s)).toBe(null); // no Kafra: not a failure
  expect(e.active).toBe(true);
  expect(e.stage).toBe('approach');
  await e.tick(s);
  expect(calls.at(-1)).toEqual(['walk_to', { x: 20, y: 30 }]);
});

test('ores that could not be stored do not fail the trip either', async () => {
  const ore = { index: 4, ITID: 984, name: 'Oridecon', count: 1, type: 3 };
  let busy = true;
  const storage = { get active() { return busy; }, retryAt: 0, maybeStart: () => false, tick: async () => { busy = false; return { ok: false, note: 'storage full' }; } };
  const e = mk(world, () => null, null, storage);
  const s = snap({ me: { map: 'town_in', x: 10, y: 10 }, inventory: [ore] });
  e.requestSell(); e.maybeStart(s);
  await e.tick(s); // travel -> deposit
  await e.tick(s); // storage tick: gave up
  expect(e.active).toBe(true);
  expect(e.stage).toBe('approach');
});

test('the trip buys what the damage calls for (potions.js), not what the level suggests', async () => {
  // Low (not zero) stock in town, once the first town service is behind us.
  const low = { me: { map: 'town', maxHp: 1000, hp: 1000, zeny: 200000 }, inventory: [{ ITID: 501, count: 2, type: 0 }] };
  const planFor = async (dps) => {
    const e = mk(world, () => dps);
    await serviceTown(e, snap(low));
    return startAfterConfirm(e, snap(low));
  };
  expect((await planFor(140)).why).toContain('Yellow Potion');
  // A potion no shop sells is never planned: White isn't sold here, so heavy hits get Yellow.
  expect((await planFor(400)).why).toContain('Yellow Potion');
  expect((await planFor(10)).why).toContain('Red Potion');
});

test('decides on its own to go shopping when potions run low, then walks the whole trip', async () => {
  let reviewed = false; // the loot is approved for sale until it has been sold
  const loot = { index: 9, ITID: 909, type: 3, count: 40 };
  const e = mk(world, () => null, { equipmentReady: () => true, needsSaleReview: () => !reviewed, saleItems: () => (reviewed ? [] : [loot]) });
  const town = (inventory) => snap({ me: { map: 'town' }, inventory });
  await serviceTown(e, town([]));
  expect(startAfterConfirm(e, town([{ ITID: 501, count: 40, type: 0 }]))).toBe(null); // 2200 HP >= 4 bars of 500
  expect(startAfterConfirm(e, town([{ ITID: 504, count: 6, type: 0 }]))).toBe(null); // 6 White = 2190 HP: few bottles, plenty of HP
  const bag = [{ ITID: 501, count: 2, type: 0 }, { index: 9, ITID: 909, type: 3, count: 40 }];
  const started = startAfterConfirm(e, town(bag));
  expect(started).toMatchObject({ goal: 'buy', shop: { map: 'town_in', name: 'Tool Dealer' } });

  // arrive at the shop map and walk up to the NPC
  await e.tick(snap({ me: { map: 'town_in', x: 10, y: 10 } }));
  await e.tick(snap({ me: { map: 'town_in', x: 10, y: 10 } }));
  await e.tick(snap({ me: { map: 'town_in', x: 10, y: 10 } }));
  expect(calls.at(-1)).toEqual(['walk_to', { x: 20, y: 30 }]);
  const there = (over = {}) => atShop({ inventory: bag, ...over });
  await e.tick(there());
  await e.tick(there());
  expect(calls.at(-1)).toEqual(['talk', { GID: 77 }]);

  // sell the ETC loot first (the junk step is skipped by this client)
  await e.tick(there({ shop: { naid: 77, stage: 'select' } }));
  expect(calls.at(-1)).toEqual(['deal', { naid: 77, type: 1 }]);
  const selling = there({ shop: { naid: 77, stage: 'sell', list: [{ index: 9, price: 3 }] } });
  await e.tick(selling);
  await e.tick(selling);
  expect(calls.at(-1)).toEqual(['sell', { items: [{ index: 9, count: 40 }] }]);
  reviewed = true;
  expect(await e.onEvent({ type: 'shop_result', kind: 'sell', ok: true }, there())).toBe(null);
  expect(e.stage).toBe('review');

  // the sale is reviewed once the inventory settled, then talk again and buy potions
  setSystemTime(Date.now() + 2000);
  await e.tick(there());
  await e.tick(there());
  expect(calls.at(-1)).toEqual(['talk', { GID: 77 }]);
  await e.tick(there({ shop: { naid: 77, stage: 'select' } }));
  expect(calls.at(-1)).toEqual(['deal', { naid: 77, type: 0 }]);
  await e.tick(there({ shop: { naid: 77, stage: 'buy', list: [{ ITID: 501, price: 50 }, { ITID: 601, price: 60 }] } }));
  // The loadout (LAYA) decides at the counter; only Novice Fly Wings are ever bought, never 601.
  const bought = calls.at(-1);
  expect(bought[0]).toBe('buy');
  expect(bought[1].items.map((i) => i.ITID)).toEqual([501]);
  const count = bought[1].items[0].count;
  expect(count).toBeGreaterThan(0);
  expect(await e.onEvent({ type: 'shop_result', kind: 'buy', ok: true }, there())).toBe(null);
  setSystemTime(Date.now() + 2000);
  const done = await e.tick(there({ inventory: [{ ITID: 501, count: 2 + count, type: 0 }] }));
  expect(done).toMatchObject({ ok: true, sold: 40, bought: [`Red Potion x${count}`] });
  expect(e.active).toBe(false);
});

test('goes to sell when the bag is too heavy to fight, even with potions', () => {
  const loot = { index: 9, ITID: 909, type: 3, count: 40 };
  const e = mk(world, () => null, { needsSaleReview: () => true, saleItems: () => [loot] });
  const started = startAfterConfirm(e, snap({ me: { weight: 19000 }, inventory: [{ ITID: 501, count: 400, type: 0 }, loot] }));
  expect(started.goal).toBe('sell');
});

test('a weight sale request with nothing to sell is dropped, not repeated every cooldown', () => {
  const e = mk();
  e.requestSell();
  const s = snap({ me: { map: 'town', weight: 19500 }, inventory: [{ ITID: 501, count: 400, type: 0 }] });
  // Only the town return (reviewing the supplies) is left; no "sell" trip for loot that isn't there.
  expect(e.maybeStart(s)?.goal).not.toBe('sell');
});

test('gives up cleanly when the NPC is not where the data says', async () => {
  const e = mk();
  startAfterConfirm(e, snap({ inventory: [] }));
  const there = snap({ me: { map: 'town_in', x: 20, y: 30 } });
  await e.tick(there);
  await e.tick(there);
  await e.tick(there);
  const done = await e.tick(there);
  expect(done).toMatchObject({ ok: false });
  expect(e.active).toBe(false);
});

test('market shop: list opens straight after talking — buy without the buy/sell step', async () => {
  const e = mk();
  startAfterConfirm(e, snap({ inventory: [] }));
  const market = { kind: 'market', stage: 'buy', list: [{ ITID: 501, price: 50, stock: 20 }] };
  for (let i = 0; i < 3; i++) await e.tick(atShop()); // travel -> deposit -> approach -> talk_sell
  await e.tick(atShop()); // talk
  // The plan is only about the supplies (reviewPotions): the market shop still gets to sell us potions.
  await e.tick(atShop({ shop: market }));
  expect(e.stage).toBe('buying');
  await e.tick(atShop({ shop: market }));
  expect(calls.at(-1)).toEqual(['buy', { items: [{ ITID: 501, count: 20 }] }]); // capped by the market's stock
});

test('out of potions: the reserve may be spent on an emergency supply (it exists for potions)', async () => {
  const { potionBudget } = await import('../src/errand.js');
  const broke = { zeny: 18000, baseLevel: 83, maxHp: 4847 };
  expect(potionBudget(broke, [])).toBe(17000); // keep 1000 pocket money
  expect(potionBudget(broke, [{ ITID: 504, count: 50 }])).toBeLessThan(0); // stocked: normal rule, no spending
  const e = mk(world, () => 50);
  const started = startAfterConfirm(e, snap({ me: { zeny: 18000, baseLevel: 83, maxHp: 4847, hp: 4847 }, inventory: [] }));
  expect(started && started.goal).toBe('buy');
});

test('a single empty-inventory blink does not start a trip (it once looped to the shop every 10s)', () => {
  const e = mk();
  expect(e.maybeStart(snap({ inventory: [] }))).toBe(null); // first sight of "no potions": wait
  expect(e.maybeStart(snap({ inventory: [{ ITID: 504, count: 222, type: 0 }] }))).toBe(null); // it was a blink
  expect(e.maybeStart(snap({ inventory: [] }))).toBe(null); // the clock started over
});

test('right after a map change the bag is still reloading: no shopping decision is made', () => {
  const e = mk();
  expect(startAfterConfirm(e, snap({ inventory: [], mapAgeMs: 2000 }))).toBe(null);
  // An empty bag within a minute of a warp is still the reload (it read empty 1-3s after @go).
  expect(startAfterConfirm(e, snap({ inventory: [], mapAgeMs: 20000 }))).toBe(null);
  // A real bag (loot, no potions) after the settle time: go shopping.
  expect(startAfterConfirm(e, snap({ inventory: [{ index: 9, ITID: 909, count: 3, type: 3 }], mapAgeMs: 20000 }))).not.toBe(null);
});

test('SP gone: the trip goes to a shop that really sells Blue Potions, not just any potion shop', async () => {
  const w = shopWorld(['far_in', 5, 5, 'Tool Dealer', [[501, -1]], 1], ['town_in', 20, 30, 'Tool Dealer', [[501, -1], [505, -1]], 1]);
  const e = mk(w);
  const rich = { me: { maxSp: 400, sp: 0, zeny: 100000, maxHp: 500, hp: 500 } };
  const bag = [{ ITID: 504, count: 50, type: 0 }]; // HP fine, SP none
  const started = startAfterConfirm(e, snap({ ...rich, inventory: bag }));
  expect(started.shop).toMatchObject({ map: 'town_in' });
  const buy = await reachBuyList(e, [{ ITID: 505, price: 5000 }], { ...rich, inventory: bag });
  const items = buy[1].items;
  expect(items[0]).toMatchObject({ ITID: 505 });
  expect(items[0].count).toBeGreaterThan(0);
  expect(items[0].count * 5000).toBeLessThanOrEqual(100000);
});

test('SP gone and broke below the reserve: spend it on what Blue Potions it can buy (no sitting)', async () => {
  const w = shopWorld(['town_in', 20, 30, 'Tool Dealer', [[501, -1], [505, -1]], 1]);
  const e = mk(w);
  // The live case: Base 85, 12300 zeny (reserve 100000), plenty of HP potions, SP at 1.
  const broke = { me: { baseLevel: 85, zeny: 12300, maxSp: 300, sp: 1, maxHp: 5000, hp: 4000 }, inventory: [{ ITID: 504, count: 50, type: 0 }] };
  expect(startAfterConfirm(e, snap({ me: { ...broke.me, maxSp: 300 }, inventory: [{ ITID: 504, count: 50, type: 0 }] }))).toMatchObject({ goal: 'buy' });
  // An emergency spends at most a quarter of the zeny at the counter, so the price that matters is the real one.
  const buy = await reachBuyList(e, [{ ITID: 505, price: 230 }], broke);
  expect(buy[1].items[0]).toMatchObject({ ITID: 505 });
  expect(buy[1].items[0].count * 230).toBeLessThanOrEqual(11300); // 1000 kept
});

test('out of Fly Wings (owner: warp around for monsters): a trip of its own, wings bought with pocket money kept', async () => {
  const w = shopWorld(['town_in', 20, 30, 'Tool Dealer', [[501, -1], [23280, -1]], 1], ['town_in', 40, 30, 'General Store', [[501, -1], [23280, -1]], 1]);
  const e = mk(w);
  const stocked = [{ ITID: 504, count: 50, type: 0 }]; // potions fine
  const town = { me: { map: 'town', zeny: 150000 }, inventory: stocked };
  await serviceTown(e, snap(town));
  const started = startAfterConfirm(e, snap(town));
  expect(started).toMatchObject({ goal: 'buy' });
  expect(started.why).toContain('Fly Wing');
  // Plenty of wings: no trip for them.
  const e2 = mk(w);
  await serviceTown(e2, snap(town));
  expect(startAfterConfirm(e2, snap({ ...town, inventory: [...stocked, { ITID: 601, count: 40, type: 2 }] }))).toBe(null);
});

test('the price the shop really asked is what the money target is judged by (Blue Potion ~230 here, not 5000)', async () => {
  const w = shopWorld(['town_in', 20, 30, 'Tool Dealer', [[501, -1], [505, -1]], 1]);
  const e = mk(w);
  const bag = [{ ITID: 504, count: 50, type: 0 }, { ITID: 505, count: 5, type: 0 }];
  const poor = { me: { zeny: 3000, maxSp: 400, sp: 300, baseLevel: 20 }, inventory: bag };
  const blue = (t) => t.items.find((i) => i.name === 'Blue Potion').price;
  expect(blue(e.moneyTarget(snap(poor)))).toBe(5000);
  e.requestBuy(RED, 'test');
  expect(e.maybeStart(snap({ me: { map: 'town', zeny: 200000 }, inventory: bag }))).not.toBeNull();
  await reachBuyList(e, [{ ITID: 501, price: 50 }, { ITID: 505, price: 230 }], { me: { zeny: 200000, maxSp: 400, sp: 300 }, inventory: bag });
  expect(blue(e.moneyTarget(snap(poor)))).toBe(230);
});

test('the money target never falls below the reserve that ends money mode', () => {
  const t = moneyTarget(snap({ inventory: [{ ITID: 504, count: 500, type: 0 }] }), { hp: 0, sp: 0, wing: 0 }, {}, 1);
  expect(t.target).toBeGreaterThanOrEqual(MONEY_RESERVE);
});

test('a requested potion trip buys potions at the counter', async () => {
  const e = mk();
  const bag = [{ ITID: 501, count: 3, type: 0 }];
  const town = { me: { map: 'town' }, inventory: bag };
  await serviceTown(e, snap(town));
  e.requestBuy(RED, 'test');
  expect(e.maybeStart(snap(town))).toMatchObject({ goal: 'buy' });
  const buy = await reachBuyList(e, [{ ITID: 501, price: 50 }], { inventory: bag });
  expect(buy[0]).toBe('buy');
  expect(buy[1].items[0]).toMatchObject({ ITID: 501 });
});

test("LAYA being down is our problem, not the shop's: the shop is not blacklisted", async () => {
  const w = shopWorld(['town_in', 20, 30, 'Tool Dealer', [[501, -1]], 1]);
  const e = mk(w);
  expect(startAfterConfirm(e, snap({ inventory: [] }))).not.toBeNull();
  layaDown = true;
  try {
    const buy = await reachBuyList(e, [{ ITID: 501, price: 50 }], { inventory: [] });
    expect(buy?.[0]).not.toBe('buy');
    expect(e.active).toBe(false);
  } finally { layaDown = false; }
  setSystemTime(Date.now() + 61000);
  expect(startAfterConfirm(e, snap({ inventory: [] }))?.shop?.map).toBe('town_in'); // same (only) shop: not blacklisted
});

test('a deadline that passes while the purchase is being verified is not the shop\'s fault', async () => {
  const w = shopWorld(['town_in', 20, 30, 'Tool Dealer', [[501, -1]], 1]);
  const e = mk(w);
  startAfterConfirm(e, snap({ inventory: [] }));
  await reachBuyList(e, [{ ITID: 501, price: 50 }], { inventory: [] });
  expect(e.stage).toBe('buy_wait');
  await e.onEvent({ type: 'shop_result', kind: 'buy', ok: true }, atShop({ inventory: [] }));
  expect(e.stage).toBe('verify_buy');
  // The bag never shows the potions within the stage deadline (a slow inventory refresh).
  setSystemTime(Date.now() + 25000);
  expect(await e.tick(atShop({ inventory: [] }))).toMatchObject({ ok: false });
  setSystemTime(Date.now() + 61000);
  expect(startAfterConfirm(e, snap({ inventory: [] }))?.shop?.map).toBe('town_in');
});

test('SP / wing top-ups wait 5 minutes after a trip; an HP shortage does not wait', async () => {
  const wingWorld = shopWorld(['town_in', 20, 30, 'Tool Dealer', [[501, -1], [23280, -1]], 1], ['town_in', 40, 30, 'General Store', [[501, -1], [23280, -1]], 1]);
  const e = mk(wingWorld);
  const town = { me: { map: 'town', zeny: 150000 } };
  const t0 = Date.now();
  expect(e.maybeStart(snap({ ...town, inventory: [{ ITID: 504, count: 50, type: 0 }] }))).not.toBeNull(); // the town return
  setSystemTime(t0 + 16 * 60 * 1000);
  expect(await e.tick(snap())).toMatchObject({ ok: false }); // the trip ends (travel timeout)
  const after = t0 + 16 * 60 * 1000 + 61000; // past the failure cooldown
  const stocked = [{ ITID: 504, count: 50, type: 0 }, { ITID: 505, count: 3, type: 0 }]; // HP fine, no wings
  setSystemTime(after);
  expect(e.maybeStart(snap({ ...town, inventory: stocked }))).toBe(null);
  setSystemTime(after + 3100);
  expect(e.maybeStart(snap({ ...town, inventory: stocked }))).toBe(null); // wings low, but it waits
  // HP potions gone: that one goes at once (no 5-minute wait).
  setSystemTime(after + 3200);
  const first = e.maybeStart(snap({ ...town, inventory: [] }));
  setSystemTime(after + 6400);
  const second = first || e.maybeStart(snap({ ...town, inventory: [] }));
  expect(second).toMatchObject({ goal: 'buy' });
});

test('usage rates come from the bag shrinking over time; a partial bag read is not counted as use', () => {
  const e = mk();
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
  expect(r.wing).toBeCloseTo(3, 0); // 18 wings in 6 minutes
  expect(r.hp).toBe(0);
});

test('with usage rates known, SP "low" is the larger of 6 minutes of use and two SP bars — not a fixed amount', async () => {
  const w = shopWorld(['town_in', 20, 30, 'Tool Dealer', [[501, -1], [505, -1]], 1], ['far_in', 5, 5, 'Tool Dealer', [[501, -1], [505, -1]], 1]);
  const e = mk(w);
  const me = { map: 'town', maxSp: 300, sp: 300, zeny: 100000, maxHp: 500, hp: 500 };
  const bag = (blue) => [{ ITID: 504, count: 99, type: 0 }, { ITID: 505, count: blue, type: 0 }, { ITID: 909, count: 1, type: 3 }];
  await serviceTown(e, snap({ me, inventory: bag(14) }), 0);
  const t0 = Date.now();
  // 6 minutes of history using one Blue Potion (50 SP) every 3 minutes: ~17 SP/min.
  e.observe(snap({ me, inventory: bag(16) }));
  setSystemTime(t0 + 3 * 60000);
  e.observe(snap({ me, inventory: bag(15) }));
  setSystemTime(t0 + 6 * 60000);
  e.observe(snap({ me, inventory: bag(14) }));
  setSystemTime(t0 + 6 * 60000 + 3100);
  // 14 Blue Potions = 700 SP: above two bars (600) and 6 minutes of use (100): no trip.
  expect(startAfterConfirm(e, snap({ me, inventory: bag(14) }))).toBe(null);
  // 10 Blue Potions = 500 SP: under two bars.
  expect(startAfterConfirm(e, snap({ me, inventory: bag(10) }))).toMatchObject({ goal: 'buy' });
});
