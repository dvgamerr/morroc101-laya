import { readFileSync, writeFileSync } from 'node:fs';
import { act } from './browser.js';
import { findNpcEntity } from './npc.js';
import { spareGear } from './gear.js';
import { log } from './logger.js';
import { learn } from './lessons.js';
import { shopsSelling, travelCosts } from './world.js';
import { zenyReserve } from './goals.js';
import { POTIONS, SP_POTIONS, choosePotion, stockHp, stockSp, healOf, healRange, WEAK_HEAL_SHARE } from './potions.js';

const MIN_BUY = 10; // not worth the trip for fewer
const MIN_SP_BUY = 3; // Blue Potions are dear; a few are already worth it
const ITEM = { HEALING: 0, ETC: 3, CARD: 6 };

// Owner's request: carry Fly Wings to warp around the hunting map for monsters instead of walking.
// (Novice Fly Wings aren't sold anywhere; the Tool Dealer's Fly Wing does the same.)
export const FLY_WING = { ITID: 601, name: 'Fly Wing', price: 60, weight: 50 };
const WING_LOW = 10; // fewer than this: worth a trip on its own
const WING_TARGET = 100; // top up to this on any trip
const MIN_WING_BUY = 10;
export const wingsIn = (inv) => (inv || []).filter((i) => (i.ITID === 601 || i.ITID === 12323) && i.count > 0).reduce((n, i) => n + i.count, 0);

// Potion stock is measured in full HP bars it can refill, whatever the bottles are:
// 9 White Potions is plenty, 9 Red Potions is not.
const LOW_REFILLS = 4; // go shopping below this
const TARGET_REFILLS = 15; // buy up to this
const LOW_CONFIRM_MS = 3000;
const AFTER_TRIP_MS = 20000; // let the inventory settle before thinking about another trip
// Top-ups that can wait (SP potions, wings): not a trip of their own within this long of the last
// one — trips came every 2-3 minutes for a few Blue Potions. Out of HP potions or too heavy: go now.
const TOPUP_GAP_MS = 5 * 60 * 1000;
const USAGE_WINDOW_MS = 30 * 60 * 1000; // usage rates over the last half hour
const MIN_USAGE_SPAN_MS = 5 * 60 * 1000; // need this much history before trusting them
const LOW_MINUTES = 4; // with usage rates known: go when something runs out within this long
const TRIP_MINUTES = 20; // buy enough for this long a stretch of hunting, judged by past use
const SPEND_SHARE = 0.6; // and never more than this share of our zeny on one trip (HP emergencies aside)
const RATES_FILE = 'logs/usage-rates.json'; // last known rates, so a restart doesn't start blind
const RATES_FRESH_MS = 2 * 60 * 60 * 1000;
const SAVE_RATES_SPAN_MS = 10 * 60 * 1000;
// Owner's money goal: farm money until the purse covers what the bag is short of now plus this
// many more levelling trips' worth of supplies; back to money below RESUME_TRIPS' worth.
export const SUPPLY_TRIPS = 6;
export const RESUME_TRIPS = 5;
export const MONEY_RESERVE = 100000; // fixed reserve added to the supply money goal
const BROKE_RETRY_MS = 10 * 60 * 1000; // went to buy and couldn't afford anything: don't keep going back
const SETTLE_AFTER_MAP_MS = 15000;
const SELL_AT_WEIGHT_PCT = 80;
const STAGE_TIMEOUT_MS = 20000;
const RETRY_AFTER_MS = 10 * 60 * 1000;
const TALK_RANGE = 4;


// What the shops really charge, remembered across restarts (the item table's prices are official ones).
const PRICES_FILE = 'logs/shop-prices.json';
function loadPrices() {
  if (process.env.NODE_ENV === 'test') return {};
  try {
    return JSON.parse(readFileSync(PRICES_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function loadRates() {
  if (process.env.NODE_ENV === 'test') return null;
  try {
    return JSON.parse(readFileSync(RATES_FILE, 'utf8'));
  } catch {
    return null;
  }
}
function savePrices(prices) {
  if (process.env.NODE_ENV === 'test') return;
  try {
    writeFileSync(PRICES_FILE, JSON.stringify(prices));
  } catch {}
}

/** Zeny we may spend: everything above half the reserve. */
export const budgetOf = (me) => (me.zeny || 0) - zenyReserve(me.baseLevel || 1) / 2;

/**
 * What may go on potions. Normally the budget above half the reserve — but the
 * reserve exists FOR potions: with less than one HP bar of them left, spend it,
 * keeping only pocket money. Fighting with no potions is how characters die.
 */
const POCKET_MONEY = 1000;
export function potionBudget(me, inv) {
  const out = stockHp(inv || [], me) < (me.maxHp || 0);
  return out ? Math.max(budgetOf(me), (me.zeny || 0) - POCKET_MONEY) : budgetOf(me);
}

/** Same idea for SP: with less than one SP bar of Blue Potions, skills are dead — spend the reserve. */
export function spBudget(me, inv) {
  const out = stockSp(inv || []) < (me.maxSp || 0);
  return out ? Math.max(budgetOf(me), (me.zeny || 0) - POCKET_MONEY) : budgetOf(me);
}



// What the agent uses itself and never sells: SP items and wings (HP healers are matched by healRange).
const IN_USE = new Set([505, 510, 11502, 11503, 12323, 601, 12324]);

/**
 * Owner's rule: everything we don't use goes — loot, spare gear, odd consumables. Never sold:
 * cards (they go to Kafra storage), anything equipped, potions/healing food, SP items and wings
 * we use, and what the client's own junk rules protect (refined, carded or signed gear, rebirth items).
 */
export function sellable(inv, worn = null, me = null, rates = null) {
  // Gear is judged piece by piece (gear.js): never wearable on our path, or no better than what's on.
  const spare = spareGear(inv, worn);
  const out = (inv || []).filter(
    (i) => i.count > 0 && !i.equipped && !i.keep && i.type !== ITEM.CARD && !IN_USE.has(i.ITID) && !healRange(i.ITID) && (!i.gear || spare.has(i.index)),
  );
  return me?.maxHp ? [...out, ...spareSupplies(inv, me, rates)] : out;
}

// Owner's rule for the things we do use: what we no longer use goes, and of the rest only what's
// needed stays. A heal under this share of max HP isn't worth a bottle's turn (Red Potions and
// herbs at 6500 HP), as long as the stronger bottles cover LOW_REFILLS bars on their own.
const KEEP_HP_BARS = TARGET_REFILLS * 2; // HP potions above this many bars of max HP are surplus
const KEEP_SP_BARS = TARGET_REFILLS * 2;
const KEEP_WINGS = WING_TARGET * 2;

/** Weak healers and the surplus over what's needed, as {…item, count: how many to sell}. */
export function spareSupplies(inv, me, rates = null) {
  const vit = 1 + ((me.stats && me.stats.vit) || 0) * 0.02;
  const heal = (i) => { const r = healRange(i.ITID); return r ? ((r[0] + r[1]) / 2) * vit : 0; };
  const loose = (inv || []).filter((i) => i.count > 0 && !i.equipped && !i.keep);
  const healers = loose.filter((i) => heal(i) > 0);
  const strong = healers.filter((i) => heal(i) >= (me.maxHp || 0) * WEAK_HEAL_SHARE);
  const strongHp = strong.reduce((n, i) => n + i.count * heal(i), 0);
  const out = [];
  if (strongHp >= (me.maxHp || 0) * LOW_REFILLS) for (const i of healers) if (!strong.includes(i)) out.push({ ...i });
  // Surplus: keep the strongest first, sell what's past the cap.
  const trim = (items, worth, cap) => {
    let kept = 0;
    for (const i of [...items].sort((a, b) => worth(b) - worth(a))) {
      const keep = Math.max(0, Math.min(i.count, Math.ceil((cap - kept) / worth(i))));
      kept += keep * worth(i);
      if (i.count > keep) out.push({ ...i, count: i.count - keep });
    }
  };
  trim(strongHp >= (me.maxHp || 0) * LOW_REFILLS ? strong : healers, heal, Math.max((me.maxHp || 0) * KEEP_HP_BARS, (rates?.hp || 0) * TRIP_MINUTES * 2));
  const sp = (i) => stockSp([{ ...i, count: 1 }]);
  if (me.maxSp > 0) trim(loose.filter((i) => sp(i) > 0), sp, Math.max(me.maxSp * KEEP_SP_BARS, (rates?.sp || 0) * TRIP_MINUTES * 2));
  trim(loose.filter((i) => i.ITID === FLY_WING.ITID || i.ITID === 12323), () => 1, Math.max(KEEP_WINGS, (rates?.wing || 0) * TRIP_MINUTES * 2));
  return out;
}

/**
 * Shopping trip, decided by the agent itself: low on potions (and can pay), or
 * bags too heavy. Travel to the nearest Tool Dealer (portals + @go via travel.js),
 * walk up to the NPC, sell ETC loot, buy potions with what's left above the
 * reserve, then hand back to hunting.
 */
/**
 * @param {() => number|null} getDps worst damage per second seen while fighting (potions.js tracker)
 */
export function createErrand(page, world, travel, getDps = () => null) {
  const e = { active: false, stage: 'idle', shop: null, stageAt: 0, badShops: new Map(), cooldownUntil: 0, plan: null, sold: 0, bought: [], prices: loadPrices(), usage: [], prevStock: null, obsSince: 0, savedRates: loadRates(), goal: null, goalSince: 0 };
  e.levelRates = e.savedRates?.level || null;

  /** Asked from outside: the bottles we carry can't keep up with this map — buy this one. */
  function requestBuy(potion, why) {
    if (e.active || Date.now() < e.cooldownUntil) return false;
    e.request = { potion, why, at: Date.now() };
    return true;
  }

  function need(snap) {
    const me = snap.me;
    const inv = snap.inventory || [];
    if (e.request) {
      const r = e.request;
      e.request = null;
      e.choice = { potion: r.potion, reason: r.why, stock: stockHp(inv, me) };
      return { buy: r.potion, sell: sellable(inv, snap.worn, snap.me, e.levelRates).length > 0 };
    }
    // Which potion is decided by how hard we're being hit, not by level (potions.js).
    // Only potions some shop on this server actually sells.
    // Prices the shops really asked last time (this server's Blue Potion is ~230, not the 5000 in the
    // table — judging by the table once sent us back to the counter a minute after a trip).
    const priceOf = (p) => e.prices[p.ITID] ?? p.price;
    const sold = Object.fromEntries(POTIONS.filter((p) => shopsSelling(world, p.ITID).length).map((p) => [p.ITID, priceOf(p)]));
    const choice = choosePotion({ me, dps: getDps(), budget: potionBudget(me, inv), prices: sold, minBuy: MIN_BUY });
    const potion = choice.potion;
    const stock = stockHp(inv, me);
    // Low for a few seconds running, not on one snapshot (a refreshing inventory reads empty),
    // and never judged right after a map change, when the bag reloads in pieces.
    if ((snap.mapAgeMs ?? Infinity) < SETTLE_AFTER_MAP_MS) return null;
    // Just after a warp an empty read is the bag reloading, never a shopping list.
    if (!inv.length && (snap.mapAgeMs ?? Infinity) < 60000) return null;
    // With usage rates known, "low" means "runs out within LOW_MINUTES" — a fixed amount sent us
    // to the counter for SP potions we were barely using (and the trip then bought none).
    const r = rates();
    const runsOut = (have, rate) => rate > 0 && have / rate < LOW_MINUTES;
    const low = stock < (me.maxHp || 0) * LOW_REFILLS || (!!r && runsOut(stock, r.hp));
    if (!low) e.lowSince = 0;
    else if (!e.lowSince) e.lowSince = Date.now();
    const wantPotions = low && Date.now() - e.lowSince >= LOW_CONFIRM_MS && !!potion;
    if (wantPotions) e.choice = { ...choice, stock };
    // SP too (owner's rule: Blue Potions, not sitting): low SP stock and money left for a few.
    const blueRow = SP_POTIONS.find((p) => shopsSelling(world, p.ITID).length);
    const blue = blueRow && { ...blueRow, price: priceOf(blueRow) };
    const hpSpend = wantPotions ? Math.min(potionBudget(me, inv), potion.price * MIN_BUY) : 0;
    // Rates known: only "runs out soon" — a "below max SP" floor sent us shopping with 20 minutes of SP left.
    // A zero SP rate means "not measured using any", not "never needed": under half a bar is low then.
    const spShort = r && r.sp > 0 ? runsOut(stockSp(inv), r.sp) : stockSp(inv) < (me.maxSp || 0) * (r ? 0.5 : LOW_REFILLS);
    // Confirmed for a few seconds like HP potions: right after a warp the bag reads empty for 1-3s.
    if (!spShort) e.spLowSince = 0;
    else if (!e.spLowSince) e.spLowSince = Date.now();
    const spLow = spShort && Date.now() - e.spLowSince >= LOW_CONFIRM_MS;
    const spOut = stockSp(inv) < (me.maxSp || 0);
    const wantSp = !!blue && spLow && spBudget(me, inv) - hpSpend >= blue.price * (spOut ? 1 : MIN_SP_BUY);
    const heavy = me.maxWeight && (me.weight / me.maxWeight) * 100 >= SELL_AT_WEIGHT_PCT && sellable(inv, snap.worn, snap.me, e.levelRates).length > 0;
    // Wings: out of them and pocket money left for a handful after the potions.
    const spSpend = wantSp ? blue.price * MIN_SP_BUY : 0;
    // Same 3-second confirmation as potions: an inventory blink reads as "no wings" too.
    const wingsShort = r && r.wing > 0 ? runsOut(wingsIn(inv), r.wing) : wingsIn(inv) < WING_LOW;
    const wingLow = shopsSelling(world, FLY_WING.ITID).length > 0 && wingsShort && (me.zeny || 0) - POCKET_MONEY - hpSpend - spSpend >= FLY_WING.price * MIN_WING_BUY;
    if (!wingLow) e.wingLowSince = 0;
    else if (!e.wingLowSince) e.wingLowSince = Date.now();
    const wantWing = wingLow && Date.now() - e.wingLowSince >= LOW_CONFIRM_MS;
    const topUpOnly = !wantPotions && !heavy;
    if (topUpOnly && Date.now() - (e.lastTripAt || 0) < TOPUP_GAP_MS && stockSp(inv) > 0) return null;
    if (!wantPotions && !wantSp && !wantWing && !heavy) return null;
    const buying = wantPotions || wantSp || wantWing;
    return { buy: wantPotions ? potion : null, buySp: wantSp ? blue : null, buyWing: wantWing, sell: heavy || (buying && sellable(inv, snap.worn, snap.me, e.levelRates).length > 0) };
  }

  /**
   * The shop we can reach for the fewest cells walked from where we stand
   * (portals, the walk inside each map, @go as a fixed cost) — not the fewest map
   * changes, which makes every @go town look equally close.
   */
  function pickShop(snap, potion) {
    const now = Date.now();
    const id = potion ? potion.ITID : 501; // selling only: any Tool Dealer buys loot
    const me = snap.me;
    const cost = travelCosts(world, me.map, me.x, me.y, { canGo: travel.canGo });
    const ranked = shopsSelling(world, id)
      .filter((s) => (e.badShops.get(`${s.map}:${s.name}`) || 0) < now)
      .map((s) => ({ ...s, cost: cost.to(s.map, s.x, s.y) }))
      .filter((s) => s.cost < Infinity)
      .sort((a, b) => a.cost - b.cost);
    return ranked[0] || null;
  }

  /** Start a trip if one is needed. Returns the reason (for the goal/notification) or null. */
  /**
   * How fast we go through HP potions, SP potions and wings (stock drops between looks at the bag),
   * so a trip can buy each for the same stretch of hunting and they run out together.
   * Called every tick; a bag read mid-refresh (fewer stacks than last time) is ignored.
   */
  function observe(snap, goal = null) {
    const inv = snap.inventory || [];
    const now = Date.now();
    if (goal !== e.goal) {
      e.goal = goal;
      e.goalSince = now;
    }
    if (e.active || (snap.mapAgeMs ?? Infinity) < SETTLE_AFTER_MAP_MS || !inv.length) {
      e.prevStock = null;
      return;
    }
    const cur = { hp: stockHp(inv, snap.me), sp: stockSp(inv), wing: wingsIn(inv), stacks: inv.length };
    const prev = e.prevStock;
    if (prev && cur.stacks < prev.stacks * 0.8) return; // a partial read: wait for the real bag
    if (prev) for (const k of ['hp', 'sp', 'wing']) if (prev[k] > cur[k]) e.usage.push({ t: now, k, d: prev[k] - cur[k] });
    e.prevStock = cur;
    e.obsSince ||= now;
    e.usage = e.usage.filter((u) => now - u.t < USAGE_WINDOW_MS);
  }

  /** Use per minute of each, or null until there's enough history. */
  function rates() {
    const span = Math.min(USAGE_WINDOW_MS, Date.now() - (e.obsSince || Date.now()));
    if (span < MIN_USAGE_SPAN_MS) {
      // Too little history since the start: the rates we had before the restart, if recent.
      const saved = e.savedRates;
      return saved && Date.now() - saved.at < RATES_FRESH_MS ? { hp: saved.hp, sp: saved.sp, wing: saved.wing } : null;
    }
    const per = (k) => (e.usage.filter((u) => u.k === k).reduce((n, u) => n + u.d, 0) / span) * 60000;
    const r = { hp: per('hp'), sp: per('sp'), wing: per('wing') };
    // Saved for the next start only when measured over a real stretch: a few minutes of travel
    // once saved "0 HP, 0 SP per minute" and the next trip bought no SP potions at all.
    if (span >= SAVE_RATES_SPAN_MS && Date.now() - (e.savedRates?.at || 0) > 60000) {
      // Use while levelling is what the money goal is sized by: kept apart, and only from a
      // window spent wholly on levelling (money maps are easy and use next to nothing).
      if (e.goal === 'level' && Date.now() - e.goalSince >= span) e.levelRates = { ...r, dps: getDps(), at: Date.now() };
      e.savedRates = { ...r, at: Date.now(), level: e.levelRates };
      if (process.env.NODE_ENV !== 'test') try { writeFileSync(RATES_FILE, JSON.stringify(e.savedRates)); } catch {}
    }
    return r;
  }

  function maybeStart(snap) {
    if (e.active || Date.now() < e.cooldownUntil || !world) return null;
    const n = need(snap);
    if (!n) return null;
    const shop = pickShop(snap, n.buy || n.buySp || (n.buyWing ? FLY_WING : null));
    if (!shop) {
      e.cooldownUntil = Date.now() + RETRY_AFTER_MS;
      log('errand_no_shop', { potion: n.buy?.name });
      return null;
    }
    Object.assign(e, { active: true, stage: 'travel', shop, plan: n, stageAt: Date.now(), sold: 0, bought: [] });
    const goal = n.buy || n.buySp || n.buyWing ? 'buy' : 'sell';
    const where = `${shop.name} (${shop.map}, ~${Math.round(shop.cost)} ช่อง)`;
    const stock = `ยาในตัวฟื้นได้รวม ${Math.round(e.choice?.stock || 0)} HP (< ${LOW_REFILLS} หลอด = ${(snap.me.maxHp || 0) * LOW_REFILLS})`;
    const what = [n.buy && n.buy.name, n.buySp && n.buySp.name, n.buyWing && FLY_WING.name].filter(Boolean).join(' + ');
    const why = n.buy ? `${stock} → ไปซื้อ ${what} ที่ ${where} — ${e.choice?.reason || ''}` : n.buySp ? `SP ใกล้หมด → ไปซื้อ ${what} ที่ ${where}` : n.buyWing ? `Fly Wing ใกล้หมด → ไปซื้อที่ ${where}` : `ของหนัก ไปขายที่ ${where}`;
    log('errand_start', { goal, shop: `${shop.name}@${shop.map} ${shop.x},${shop.y}`, sell: n.sell, buy: n.buy?.name, buySp: n.buySp?.name, buyWing: n.buyWing || undefined });
    return { goal, why, shop };
  }

  function to(stage) {
    e.stage = stage;
    e.stageAt = Date.now();
  }

  function finish(ok, note) {
    log(ok ? 'errand_done' : 'errand_failed', { stage: e.stage, note, sold: e.sold, bought: e.bought.join(', ') });
    if (!ok && e.shop) learn(`ไปร้าน ${e.shop.name} ที่ ${e.shop.map} ไม่สำเร็จ: ${note}`);
    if (note === 'nothing affordable') learn('ไปร้านแล้วเงินไม่พอซื้อยา — ต้องหาเงิน/ขายของก่อนไปร้าน');
    if (!ok && e.shop) e.badShops.set(`${e.shop.map}:${e.shop.name}`, Date.now() + RETRY_AFTER_MS);
    e.cooldownUntil = Date.now() + (note === 'nothing affordable' ? BROKE_RETRY_MS : ok ? AFTER_TRIP_MS : 60000);
    e.lastTripAt = Date.now();
    e.lowSince = 0;
    const summary = { ok, note, sold: e.sold, bought: [...e.bought] };
    Object.assign(e, { active: false, stage: 'idle', shop: null, plan: null });
    return summary;
  }

  const npcAt = (snap) => findNpcEntity(snap, e.shop);

  /**
   * One step. @returns null while working, or {ok, note, sold, bought} when the trip ends.
   */
  async function tick(snap) {
    if (!e.active) return null;
    const me = snap.me;
    const shop = e.shop;
    if (Date.now() - e.stageAt > (e.stage === 'travel' ? 15 * 60 * 1000 : STAGE_TIMEOUT_MS)) return finish(false, `timeout at ${e.stage}`);

    switch (e.stage) {
      case 'travel': {
        if (me.map !== shop.map) {
          if (travel.dest !== shop.map) await travel.start(shop.map);
          if ((await travel.tick(snap)) === 'failed') return finish(false, 'travel failed');
          return null;
        }
        if (travel.dest) await travel.stop();
        to('approach');
        return null;
      }
      case 'approach': {
        const d = Math.max(Math.abs(me.x - shop.x), Math.abs(me.y - shop.y));
        if (d > TALK_RANGE) {
          if (!me.walking) await act(page, 'walk_to', { x: shop.x, y: shop.y });
          return null;
        }
        // Judge "anything to sell" again at the counter: the plan was made from one snapshot, and a
        // bag read mid-refresh (right after a storage window) once sent us past the sale with 40 spares.
        e.plan.sell = e.plan.sell || sellable(snap.inventory, snap.worn, snap.me, e.levelRates).length > 0;
        to(e.plan.sell ? 'talk_sell' : 'talk_buy');
        return null;
      }
      case 'talk_sell':
      case 'talk_buy': {
        const npc = npcAt(snap);
        if (!npc) return finish(false, `no NPC "${shop.name}" at ${shop.x},${shop.y}`);
        await act(page, 'talk', { GID: npc.GID });
        e.npc = npc;
        to(e.stage === 'talk_sell' ? 'select_sell' : 'select_buy');
        return null;
      }
      case 'select_sell':
      case 'select_buy': {
        // A market shop skips the buy/sell choice and opens its list straight away (and buys nothing).
        if (snap.shop?.stage === 'buy') {
          if (e.stage === 'select_sell' && !e.plan.buy && !e.plan.buySp && !e.plan.buyWing) return finish(true, 'market shop: cannot sell here');
          to('buying');
          return null;
        }
        if (snap.shop?.stage !== 'select') return null;
        await act(page, 'deal', { naid: snap.shop.naid, type: e.stage === 'select_sell' ? 1 : 0 });
        to(e.stage === 'select_sell' ? 'selling' : 'buying');
        return null;
      }
      case 'selling': {
        if (snap.shop?.stage !== 'sell') return null;
        const sellableIdx = new Set(snap.shop.list.map((i) => i.index));
        const items = sellable(snap.inventory, snap.worn, snap.me, e.levelRates).filter((i) => sellableIdx.has(i.index)).map((i) => ({ index: i.index, count: i.count }));
        if (!items.length) {
          await act(page, 'close_shop');
          return afterSell(snap);
        }
        await act(page, 'sell', { items });
        e.sold = items.reduce((n, i) => n + i.count, 0);
        to('sell_wait');
        return null;
      }
      case 'buying': {
        if (snap.shop?.stage !== 'buy') return null;
        for (const o of snap.shop.list) if (o.price > 0) e.prices[o.ITID] = o.price;
        savePrices(e.prices);
        // At the counter anyway: top SP potions up too if the shop has them, planned or not.
        const spRow = e.plan.buySp || SP_POTIONS.find((sp) => snap.shop.list.some((o) => o.ITID === sp.ITID)) || null;
        // HP potions likewise: top up to the target on any trip (purchase re-picks the kind at the
        // shop's prices; nothing is bought when the bag is already full enough).
        const hpRow = e.plan.buy || POTIONS.find((hp) => snap.shop.list.some((o) => o.ITID === hp.ITID)) || null;
        // Owner's rule: one trip buys everything, in amounts that last equally long (by how fast each
        // is used), so trips come in rounds instead of one item at a time. No history yet: the old way.
        const r = rates();
        // With rates known the balanced plan decides alone (an empty plan = nothing needed); the old
        // spend-up-to-the-reserve path is only for a fresh start with no usage history at all.
        const balanced = r ? balancedPurchase(snap, snap.shop.list, r, getDps()) : null;
        const items = balanced || purchase(snap, snap.shop.list, hpRow, getDps(), spRow, true);
        if (balanced) log('errand_balanced', { rates: `hp ${Math.round(r.hp)}/min sp ${Math.round(r.sp)}/min wings ${r.wing.toFixed(1)}/min`, minutes: balanced.minutes });
        if (!items.length) {
          await act(page, 'close_shop');
          return finish(true, 'nothing affordable');
        }
        await act(page, 'buy', { items: items.map(({ ITID, count }) => ({ ITID, count })) });
        e.bought = items.map((i) => `${i.name} x${i.count}`);
        to('buy_wait');
        return null;
      }
      default:
        return null; // *_wait: resolved by onEvent
    }
  }

  function afterSell(snap) {
    if (e.plan.buy || e.plan.buySp || e.plan.buyWing) {
      to('talk_buy'); // a sale ends the NPC session; talk again to buy
      return null;
    }
    return finish(true, 'sold');
  }

  /** Shop results arrive as events (page-agent). Returns a finished summary or null. */
  async function onEvent(ev, snap) {
    if (!e.active || ev.type !== 'shop_result') return null;
    await act(page, 'close_shop');
    if (ev.kind === 'sell' && e.stage === 'sell_wait') {
      if (!ev.ok) log('errand_sell_failed', { result: ev.result });
      return afterSell(snap);
    }
    if (ev.kind === 'buy' && e.stage === 'buy_wait') return finish(ev.ok, ev.ok ? 'bought' : `buy result ${ev.result}`);
    return null;
  }

  return {
    requestBuy,
    observe,
    rates,
    /** The zeny to farm up to before levelling (see moneyTarget), with what we know now. */
    moneyTarget: (snap) => {
      rates(); // Update the separately observed levelling rates before estimating.
      const levelRates = e.levelRates && Date.now() - e.levelRates.at < RATES_FRESH_MS ? e.levelRates : null;
      return moneyTarget(snap, levelRates, e.prices);
    },
    maybeStart,
    tick,
    onEvent,
    get active() {
      return e.active;
    },
    get stage() {
      return e.stage;
    },
  };
}

/**
 * How much zeny levelling needs: the supplies the bag is short of for one trip right now, plus
 * SUPPLY_TRIPS more full trips, plus the reserve. One trip = TRIP_MINUTES of use at the levelling
 * rates (or, unmeasured, the same minimums a shopping trip buys up to), at the prices the shops
 * really charge, with the HP potion fitting our level and max HP.
 */
export function moneyTarget(snap, rates, prices = {}, trips = SUPPLY_TRIPS) {
  const me = snap.me;
  const inv = snap.inventory || [];
  const r = rates || { hp: 0, sp: 0, wing: 0 };
  const price = (p) => prices[p.ITID] || p.price;
  const hpPot = choosePotion({ me, dps: rates?.dps, prices: Object.fromEntries(POTIONS.map((p) => [p.ITID, price(p)])), minBuy: 1 }).potion;
  const sp = SP_POTIONS[0];
  const lines = [
    hpPot && { name: hpPot.name, unit: healOf(hpPot, me), price: price(hpPot), perTrip: Math.max(r.hp * TRIP_MINUTES, (me.maxHp || 0) * (rates ? LOW_REFILLS * 2 : TARGET_REFILLS)), stock: stockHp(inv, me) },
    { name: sp.name, unit: (sp.sp[0] + sp.sp[1]) / 2, price: price(sp), perTrip: Math.max(r.sp * TRIP_MINUTES, (me.maxSp || 0) * (rates ? 0.5 : LOW_REFILLS)), stock: stockSp(inv) },
    { name: FLY_WING.name, unit: 1, price: price(FLY_WING), perTrip: Math.max(r.wing * TRIP_MINUTES, rates ? WING_LOW * 2 : WING_TARGET), stock: wingsIn(inv) },
  ].filter(Boolean);
  const count = (amount, l) => Math.max(0, Math.ceil(amount / l.unit));
  const tripCost = lines.reduce((z, l) => z + count(l.perTrip, l) * l.price, 0);
  const nowCost = lines.reduce((z, l) => z + count(l.perTrip - l.stock, l) * l.price, 0);
  const reserve = MONEY_RESERVE;
  return {
    target: Math.round(nowCost + trips * tripCost + reserve),
    resume: Math.round(nowCost + RESUME_TRIPS * tripCost + reserve),
    tripCost: Math.round(tripCost),
    reserve,
    trips,
    minutesPerTrip: TRIP_MINUTES,
    source: rates ? "levelling_usage" : "stock_estimate",
    items: lines.map((l) => ({ name: l.name, price: l.price, stock: l.stock, unit: l.unit, perTrip: count(l.perTrip, l), buyNow: count(l.perTrip - l.stock, l) })),
    nowCost: Math.round(nowCost),
    trip: lines.map((l) => `${l.name} x${count(l.perTrip, l)}`).join(', '),
  };
}

/**
 * What to buy: the potion choosePotion picks at the shop's prices, enough to
 * refill TARGET_REFILLS HP bars counting the bottles already carried, within the
 * zeny above half the reserve, 70% of max weight and the shop's stock.
 */
export function purchase(snap, list, planned, dps = null, spPlanned = null, wings = false) {
  const potions = purchasePotions(snap, list, planned, dps, spPlanned);
  return wings ? [...potions, ...purchaseWings(snap, list, potions)] : potions;
}

/**
 * Buy HP potions, SP potions and Fly Wings for TRIP_MINUTES of hunting at the rate each was used
 * (so they run out together), not "as much as the money allows": owner's rule — a sensible amount,
 * keep money. At most SPEND_SHARE of our zeny (all but pocket money only when HP potions are short),
 * 70% weight; when that can't cover TRIP_MINUTES, the stretch shrinks evenly for all three.
 * HP potion kind is chosen by the damage we take, at shop prices.
 * @param {{hp:number, sp:number, wing:number}} rates use per minute (HP points, SP points, wings)
 * @returns {Array<{ITID, count, name}>} with .minutes = the stretch it was sized for
 */
export function balancedPurchase(snap, list, rates, dps = null) {
  const me = snap.me;
  const inv = snap.inventory || [];
  const prices = Object.fromEntries(list.filter((i) => i.price > 0).map((i) => [i.ITID, i.price]));
  const hpShort = stockHp(inv, me) < (me.maxHp || 0) * LOW_REFILLS;
  const budget = hpShort ? (me.zeny || 0) - POCKET_MONEY : Math.min((me.zeny || 0) - POCKET_MONEY, (me.zeny || 0) * SPEND_SHARE);
  const room = me.maxWeight ? me.maxWeight * 0.7 - (me.weight || 0) : Infinity;
  const lines = [];
  const hpPot = choosePotion({ me, dps, budget, prices, minBuy: 1 }).potion;
  // Each line also has a floor — the same one that sends us shopping — so a trip never comes back
  // still "low" (that once made the old buy-everything path take over and spend the reserve).
  // Floors sit at twice the line that sends us shopping: buying only up to that line had us one
  // potion away from the next trip (bought 12 Red Potions to land 62 HP over it).
  if (hpPot && prices[hpPot.ITID]) lines.push({ ITID: hpPot.ITID, name: hpPot.name, unit: healOf(hpPot, me), price: prices[hpPot.ITID], weight: hpPot.weight, rate: rates.hp, stock: stockHp(inv, me), floor: (me.maxHp || 0) * LOW_REFILLS * 2 });
  const sp = SP_POTIONS.find((x) => prices[x.ITID]);
  // SP potions are dear: their floor is just a couple of trigger windows of use, not a full SP bar.
  if (sp) lines.push({ ITID: sp.ITID, name: sp.name, unit: (sp.sp[0] + sp.sp[1]) / 2, price: prices[sp.ITID], weight: sp.weight, rate: rates.sp, stock: stockSp(inv), floor: rates.sp > 0 ? rates.sp * LOW_MINUTES * 2 : (me.maxSp || 0) * 0.5 });
  if (prices[FLY_WING.ITID]) lines.push({ ITID: FLY_WING.ITID, name: FLY_WING.name, unit: 1, price: prices[FLY_WING.ITID], weight: FLY_WING.weight, rate: rates.wing, stock: wingsIn(inv), floor: rates.wing > 0 ? WING_LOW * 2 : 0 });
  if (!lines.length || budget <= 0) return [];
  const fits = (counts) => {
    const cost = counts.reduce((z, c, i) => z + c * lines[i].price, 0);
    const weight = counts.reduce((w, c, i) => w + c * lines[i].weight, 0);
    return cost <= budget && weight <= room;
  };
  // Floors as far as money and weight allow: scaled down together when they can't all be met
  // (dropping them outright once bought nothing at all with 34k zeny in the bag).
  const withFloors = (minutes, f) => lines.map((l) => Math.max(0, Math.ceil((Math.max(l.rate * minutes, minutes > 0 ? l.floor * f : 0) - l.stock) / l.unit)));
  let f = 1;
  if (!fits(withFloors(0.01, 1))) {
    let flo = 0;
    let fhi = 1;
    for (let k = 0; k < 25; k++) { const mid = (flo + fhi) / 2; if (fits(withFloors(0.01, mid))) flo = mid; else fhi = mid; }
    f = flo;
  }
  const countsFor = (minutes) => withFloors(minutes, f);
  let lo = 0;
  let hi = TRIP_MINUTES;
  if (fits(countsFor(hi))) lo = hi;
  else for (let k = 0; k < 30; k++) { const mid = (lo + hi) / 2; if (fits(countsFor(mid))) lo = mid; else hi = mid; }
  const out = countsFor(lo)
    .map((count, i) => ({ ITID: lines[i].ITID, count, name: lines[i].name }))
    .filter((x) => x.count > 0);
  out.minutes = Math.round(lo);
  return out;
}

/** Fly Wings with what's left after the potions (keeping pocket money), up to WING_TARGET. */
function purchaseWings(snap, list, already) {
  const me = snap.me;
  const offer = list.find((i) => i.ITID === FLY_WING.ITID);
  if (!offer || !offer.price) return [];
  const spent = already.reduce((z, i) => z + i.count * (list.find((o) => o.ITID === i.ITID)?.price || 0), 0);
  const weightUsed = already.reduce((w, i) => w + i.count * ([...POTIONS, ...SP_POTIONS].find((p) => p.ITID === i.ITID)?.weight || 100), 0);
  const budget = Math.min((me.zeny || 0) - POCKET_MONEY, (me.zeny || 0) * SPEND_SHARE) - spent;
  const room = (me.maxWeight ? me.maxWeight * 0.7 - (me.weight || 0) : Infinity) - weightUsed;
  const have = wingsIn(snap.inventory);
  // Potions first: no wings while the bag (with what's being bought) still holds under LOW_REFILLS bars of HP.
  const healBought = already.reduce((n, i) => { const pt = POTIONS.find((x) => x.ITID === i.ITID); return n + (pt ? i.count * healOf(pt, me) : 0); }, 0);
  if (stockHp(snap.inventory || [], me) + healBought < (me.maxHp || 0) * LOW_REFILLS) return [];
  const count = Math.floor(Math.min(WING_TARGET - have, budget / offer.price, room / FLY_WING.weight, offer.stock > 0 ? offer.stock : Infinity));
  if (count <= 0 || (count < MIN_WING_BUY && have >= WING_LOW)) return [];
  return [{ ITID: FLY_WING.ITID, count, name: FLY_WING.name }];
}

function purchasePotions(snap, list, planned, dps, spPlanned) {
  const hp = planned ? purchaseHp(snap, list, planned, dps) : [];
  if (!spPlanned) return hp;
  const me = snap.me;
  const offer = list.find((i) => i.ITID === spPlanned.ITID);
  if (!offer || !offer.price) return hp;
  const spent = hp.reduce((z, i) => z + i.count * (list.find((o) => o.ITID === i.ITID)?.price || 0), 0);
  const weightUsed = hp.reduce((w, i) => w + i.count * (POTIONS.find((p) => p.ITID === i.ITID)?.weight || 100), 0);
  const budget = spBudget(me, snap.inventory) - spent;
  const room = (me.maxWeight ? me.maxWeight * 0.7 - (me.weight || 0) : Infinity) - weightUsed;
  const missingSp = (me.maxSp || 0) * TARGET_REFILLS - stockSp(snap.inventory || []);
  const avgSp = (spPlanned.sp[0] + spPlanned.sp[1]) / 2;
  const count = Math.floor(Math.min(Math.ceil(missingSp / avgSp), budget / offer.price, room / spPlanned.weight, offer.stock > 0 ? offer.stock : Infinity));
  return count > 0 ? [...hp, { ITID: spPlanned.ITID, count, name: spPlanned.name }] : hp;
}

/**
 * HP potions come before anything else bought on a trip: below LOW_REFILLS bars the reserve may
 * go on them (keeping pocket money) — a trip for potions once came back with 26 Fly Wings and none.
 */
function hpBudget(me, inv) {
  const short = stockHp(inv || [], me) < (me.maxHp || 0) * LOW_REFILLS;
  return short ? Math.max(potionBudget(me, inv), (me.zeny || 0) - POCKET_MONEY) : potionBudget(me, inv);
}

function purchaseHp(snap, list, planned, dps) {
  const me = snap.me;
  // Decide again with the shop's real prices (servers change them; discounts apply).
  const prices = Object.fromEntries(list.map((i) => [i.ITID, i.price]));
  const potion = choosePotion({ me, dps, budget: hpBudget(me, snap.inventory), prices, minBuy: 1 }).potion || planned;
  const offer = list.find((i) => i.ITID === potion.ITID) || null;
  if (!offer || !offer.price) return [];
  // Top up to TARGET_REFILLS bars of HP, counting what's already in the bag (any potion type).
  const missingHp = (me.maxHp || 0) * TARGET_REFILLS - stockHp(snap.inventory || [], me);
  const budget = hpBudget(me, snap.inventory);
  const roomWeight = me.maxWeight ? me.maxWeight * 0.7 - (me.weight || 0) : Infinity;
  const stock = offer.stock > 0 ? offer.stock : Infinity; // market shops run out
  const count = Math.floor(Math.min(Math.ceil(missingHp / healOf(potion, me)), budget / offer.price, roomWeight / potion.weight, stock));
  return count > 0 ? [{ ITID: potion.ITID, count, name: potion.name }] : [];
}
