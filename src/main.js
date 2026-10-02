import { readFileSync, writeFileSync } from 'node:fs';
import { config } from './config.js';
import { openGame, waitForInGame, snapshot, drainEvents, act } from './browser.js';
import { createReflex } from './reflex.js';
import { createChat } from './chat.js';
import { createTravel } from './travel.js';
import { loadWorld, pickHuntingGrounds, isTown, spawnsOn, bossNames } from './world.js';
import { createScout } from './scout.js';
import { plan, planFromCandidate, DEFAULT_PLAN } from './planner.js';
import { log } from './logger.js';
import { notifyGoalChange } from './notify.js';
import { detectSignals } from './goals.js';
import { createSkillBook } from './skills.js';
import { nextStat } from './build.js';
import { createErrand, potionBudget } from './errand.js';
import { createDamageTracker, choosePotion, stockHp, bagHps, KEEP_UP, POTION_GAP_MS, tooEasy } from './potions.js';
import { createJobChange } from './jobchange.js';
import { createDialog } from './npc.js';
import { createHealer } from './heal.js';
import { createStorage } from './storage.js';
import { gearToWear } from './gear.js';
import { createHotkeys } from './hotkeys.js';
import { learn } from './lessons.js';
import { createTrader, createBeggar } from './social.js';
import { notify, setIdentity } from './notify.js';
import * as llm from './llm.js';

const REPICK_EVERY_LEVELS = 3;
const EXCLUDE_FOR_MS = 30 * 60 * 1000;
const DEATHS_TO_ABANDON_MAP = 2;
const STAT_GAP_MS = 400;
const SIGNAL_REPLAN_GAP_MS = 60000;
const FIGHT_TICK_MS = 120;
const DISABLE_WINDOW_MS = 10 * 60 * 1000;
const DISABLES_TO_AVOID = 2;
const LOW_FLIP_CONFIRM_MS = 5000;
const REFUSAL = /(ไม่ให้|ไม่มีเงิน|ไม่มีตัง|ขอทาน|ไปไกล|รำคาญ|\bno\b|\bnope\b)/i;
const LEVEL_DROP_PER_DEATH = 5;
const DRINK_WINDOW_MS = 120000;
const DRINK_SHARE_TO_LEAVE = 0.4; // 40% of the time drinking = not really fighting
const MAP_CHOICE_WINDOW_MS = 30000;
const CHEAPEST_POTION_BATCH = 500; // 10 Red Potions
const MAX_LEVEL_DROP = 30;
const ESCAPE_WINDOW_MS = 5 * 60 * 1000;
const ESCAPE_DEDUPE_MS = 10000;
const SLOW_TICK_MS = 3000;
const ESCAPES_TO_LEAVE = 2; // wing escapes on the hunting map within the window: leave it now
const EASY_CHECKS = 5; // potion checks run once a minute
const LEVEL_UP_WHEN_EASY = 3;
const MAX_LEVEL_ABOVE = 5;
const STATE_FILE = 'logs/agent-state.json';
const STATE_TH = { stun: 'มึน', freeze: 'แข็ง', sleep: 'หลับ', stone: 'กลายเป็นหิน', imprison: 'ถูกขัง', silence: 'ใบ้' };

const brain = {
  plan: { ...DEFAULT_PLAN },
  // farm (default) | follow a player | wait in place — set by chat
  mode: { kind: 'farm' },
  planning: false,
  lastPlanAt: 0,
  huntLevel: 0,
  excluded: new Map(), // map -> until (maps we couldn't reach or kept dying on)
  hardMaps: new Map(), // map -> {dps, level}: hit harder than potions keep up with, at that base level
  disablers: new Map(), // monster name -> [timestamps] it stunned/froze/slept us
  avoidExtra: new Set(), // monsters learned to be not worth fighting (kept across plans)
  // Hunt this many levels below/above our own: lowered by deaths, eased back by clean level-ups.
  // The character's gear decides what it can farm, not just its level.
  levelOffset: 0,
  moneyMode: true, // farming money up to errand.moneyTarget (kept in the state file)
  mapChoiceOpenUntil: 0, // planner may change the hunting map only before this
  scoutDropped: new Set(), // @where/@mobsearch found useless on this account
  drinks: [], // timestamps of potions drunk (for drinkShare)
  deathsOn: new Map(), // map -> [timestamps]
  counters: { deaths: 0, actions: {} },
};

// Ctrl+C stops the agent only. The browser is its own process and keeps the session.
process.on('SIGINT', () => {
  log('exit', { note: 'browser left open' });
  process.exit(0);
});

const { page, reused } = await openGame();
log('boot', { url: config.game.url, laya: config.laya.model, llm: config.llm.model, session: reused ? 'reused' : 'new' });

// A cold oMLX model takes ~40s to load; do it while the player is still logging in.
llm.chat([{ role: 'user', content: 'ping' }], { maxTokens: 1, timeoutMs: 120000 })
  .then(() => log('llm_warm'))
  .catch((err) => log('llm_warm_error', { error: err.message }));

const world = await loadWorld()
  .then((w) => (log('world_loaded', { maps: w.spawnsByMap.size, mobs: w.mobs.size }), w))
  .catch((err) => (log('world_error', { error: err.message }), null));

if (!reused) console.log('>> ล็อกอินและเลือกตัวละครในหน้าต่างเบราว์เซอร์ได้เลย agent จะเริ่มเมื่อเข้าแมพแล้ว');
await waitForInGame(page, (snap) => {
  if (snap && snap.ready === false) process.stdout.write('.');
});
log('in_game');

const skills = createSkillBook();
skills.setBosses(bossNames(world));
const hotkeys = createHotkeys(page);
loadState(); // monsters to avoid, hunting level, excluded maps, useless server commands
const scout = createScout(page, {
  dropped: [...brain.scoutDropped],
  onDrop: (cmd) => {
    brain.scoutDropped.add(cmd);
    saveState();
  },
});
const reflex = createReflex(page, brain, scout, skills, hotkeys, world);
const trader = createTrader(page);
const beggar = createBeggar(page);
// One @go state for every traveller (hunting, shopping, job change).
const goState = { canGo: true, bad: new Set() };
const travelForErrands = createTravel(page, goState);
const damage = createDamageTracker();
const errand = createErrand(page, world, travelForErrands, () => damage.p90());
const jobChange = createJobChange(page, world, travelForErrands, createDialog(page));
const healer = createHealer(page, world, createDialog(page));
const storage = createStorage(page, world, createDialog(page));
const chat = createChat(page, brain);
const travel = createTravel(page, goState);
const getSnap = () => snapshot(page);

/** Swap in a new plan; tell Discord when the goal or the hunting map actually changes. */
function setPlan(next, snap) {
  const prev = brain.plan;
  // Monsters we learned to avoid stay avoided whatever the planner says.
  next.avoid_monsters = [...new Set([...(next.avoid_monsters || []), ...brain.avoidExtra])];
  brain.plan = next;
  if (!brain.announced || prev.goal !== next.goal || prev.hunt_map !== next.hunt_map) {
    notifyGoalChange(brain.announced ? prev : null, next, snap);
    brain.announced = true;
  }
}

function recentDeaths() {
  let n = 0;
  for (const list of brain.deathsOn.values()) n += list.filter((t) => Date.now() - t < EXCLUDE_FOR_MS).length;
  return n;
}

const signals = (snap) => detectSignals(snap, { recentDeaths: recentDeaths() });

/** A new signal (weight full, potions low, job change ready, ...) is a reason to ask the planner again. */
function checkSignals(snap) {
  const now = signals(snap);
  const keys = now.map((s) => s.key).sort().join(',');
  if (keys === brain.signalKeys) return;
  // A signal flapping at its threshold (potions 10 -> 9 -> 10) must not hammer the planner;
  // leave signalKeys stale so a still-present signal is picked up once the minute is over.
  if (Date.now() - brain.lastPlanAt < SIGNAL_REPLAN_GAP_MS) return;
  const added = now.filter((s) => !(brain.signalKeys || '').split(',').includes(s.key));
  brain.signalKeys = keys;
  if (added.length) {
    log('signals', { added: added.map((s) => `[${s.goal}] ${s.text}`).join(' | ') });
    replan(snap, `สัญญาณใหม่: ${added.map((s) => s.text).join(', ')}`);
  }
}

/** Spend status points by the job's build, one point per packet, only when safe. */
let lastStatAt = 0;
async function buildTick(snap) {
  if (Date.now() - lastStatAt < STAT_GAP_MS) return;
  const stat = nextStat(snap.me);
  if (stat) {
    lastStatAt = Date.now();
    await act(page, 'raise_stat', { stat });
    log('stat_up', { stat, from: snap.me.stats[stat], pointsLeft: snap.me.statusPoints });
    return;
  }
  // Skill points too: by the build's plan, and the Job Master wants them spent before a change.
  const skill = skills.pickUpgrade(snap);
  if (skill) {
    lastStatAt = Date.now();
    await act(page, 'upgrade_skill', { SKID: skill.id });
    log('skill_up', { skill: skill.name, from: skill.level, pointsLeft: snap.me.skillPoints });
  }
}

/** Too hard at this base level: stays off the list until we're HARD_MAP_LEVELS stronger (survives restarts and resets). */
const HARD_MAP_LEVELS = 5;
const tooHard = (baseLevel) => [...brain.hardMaps].filter(([, h]) => (baseLevel || 1) < h.level + HARD_MAP_LEVELS).map(([m]) => m);

function excluded() {
  const now = Date.now();
  for (const [map, until] of brain.excluded) if (until < now) brain.excluded.delete(map);
  return [...brain.excluded.keys()];
}

/** Out of potions (less than one HP bar's worth): hunt well below our level until resupplied. */
const NO_POTION_LEVEL_DROP = 15;
// Not judged in the first seconds on a map: the inventory reloads in pieces after a map change.
const lowOnPotions = (snap) =>
  (snap.mapAgeMs ?? Infinity) >= 15000 ? stockHp(snap.inventory, snap.me) < (snap.me.maxHp || 0) : !!brain.lowOnPotions;

function candidates(snap) {
  if (!world) return [];
  // Owner's rule: money and level want different grounds. Money: monsters well below us (no
  // deaths, few potions) in big crowds for drops — the band in world.levelBand does the "below".
  // Level: the most EXP we can take, adjusted by what we've learned (levelOffset).
  const goal = committedGoal(snap);
  const base = snap.me.baseLevel || 1;
  const level =
    goal === 'money'
      ? Math.max(1, base + Math.min(0, brain.levelOffset))
      : Math.max(1, base + brain.levelOffset - (lowOnPotions(snap) ? NO_POTION_LEVEL_DROP : 0));
  return pickHuntingGrounds(world, {
    level,
    goal,
    fromMap: snap.me.map,
    fromX: snap.me.x,
    fromY: snap.me.y,
    canGo: travel.canGo,
    exclude: [...new Set([...excluded(), ...tooHard(snap.me.baseLevel)])],
    avoid: [...brain.avoidExtra],
    limit: 5,
  });
}

function replan(snap, why) {
  if (brain.planning) return;
  brain.planning = true;
  brain.lastPlanAt = Date.now();
  const recent = `actions ${JSON.stringify(brain.counters.actions)}, deaths ${brain.counters.deaths}`;
  const ctx = { candidates: candidates(snap), inTown: world ? isTown(world, snap.me.map) : false, signals: signals(snap) };
  plan(snap, why, recent, brain.plan, ctx)
    .then((next) => {
      // One big goal, owned by the code, not flipped by every planner call: level up
      // (loot sold on the way pays for things), or money only while we can't even buy
      // potions. Errands (shop, job change, healer) are tasks inside it, not new goals.
      next.goal = errand.active || jobChange.active ? brain.plan.goal : committedGoal(snap);
      // The planner may choose the hunting map only when we're picking one anyway;
      // otherwise we stay and hunt where we are.
      // And only one of the candidates it was shown: it once sent us straight back to a map
      // that had just been excluded for out-hitting our potions.
      const offered = ctx.candidates.some((c) => c.map === next.hunt_map);
      if ((Date.now() > brain.mapChoiceOpenUntil || !offered) && brain.plan.hunt_map) {
        if (!offered && next.hunt_map && next.hunt_map !== brain.plan.hunt_map) log('planner_map_rejected', { map: next.hunt_map, keep: brain.plan.hunt_map });
        next.hunt_map = brain.plan.hunt_map;
        next.target_monsters = brain.plan.target_monsters;
        next.avoid_monsters = brain.plan.avoid_monsters;
      }
      const goalChanged = next.goal !== brain.plan.goal && !errand.active && !jobChange.active;
      setPlan(next, snap);
      brain.counters.actions = {};
      // Money <-> level: a different kind of hunting ground. Pick again for the new goal.
      if (goalChanged) chooseHunt(snap, next.goal === 'money' ? 'เป้าหมายเปลี่ยนเป็นหาเงิน: ล่ามอนเลเวลต่ำที่มีเยอะ ดรอปขายได้' : 'เป้าหมายกลับมาเก็บเลเวล: ล่ามอนที่ได้ EXP เยอะ');
    })
    .catch((err) => log('planner_error', { error: err.message }))
    .finally(() => (brain.planning = false));
}

/** Pick a hunting ground right away from the data, then let the planner refine it. */

let moneyGoal = { at: 0, t: null };
/** The money goal (errand.moneyTarget), worked out from the current bag; logged when it moves. */
function currentMoneyTarget(snap) {

  const t = errand.moneyTarget(snap);
  const prev = moneyGoal.t;
  if (!prev || Math.abs(t.target - prev.target) > prev.target * 0.1) log('money_target', { zeny: snap.me.zeny, ...t });
  moneyGoal = { at: Date.now(), t };
  return t;
}

/**
 * Owner's rule: farm money until the purse pays for what the bag is short of plus 6 levelling
 * trips of supplies and a fixed 100,000 zeny reserve (errand.moneyTarget), then level;
 * back to money when it falls under 5 trips plus the same reserve.
 * Also money when out of potions with no money to buy even a few.
 */
function committedGoal(snap) {
  const zeny = snap.me.zeny || 0;
  const t = currentMoneyTarget(snap);
  if (brain.moneyMode && zeny >= t.target) {
    brain.moneyMode = false;
    saveState();
    log('money_goal_reached', { zeny, ...t });
    notify(`💰 เก็บเงินครบ ${t.target.toLocaleString()} zeny แล้ว`, `พอซื้อของเก็บเลเวลได้อีก ${t.trips} รอบ + เงินสำรอง ${t.reserve.toLocaleString()} zeny (รอบละ ~${t.tripCost.toLocaleString()} z: ${t.trip}) กลับไปเก็บเลเวล`, {}, 0xffc107);
  } else if (!brain.moneyMode && zeny < t.resume) {
    brain.moneyMode = true;
    saveState();
    log('money_goal_resume', { zeny, resume: t.resume, target: t.target, tripCost: t.tripCost, trip: t.trip });
    notify(`💸 เงินเหลือ ${zeny.toLocaleString()} zeny`, `ไม่พอซื้อของอีก 5 รอบ + เงินสำรอง ${t.reserve.toLocaleString()} zeny ไปหาเงินจนถึง ${t.target.toLocaleString()} zeny`, {}, 0xff9800);
  }
  if (brain.moneyMode) return 'money';
  const broke = lowOnPotions(snap) && potionBudget(snap.me, snap.inventory) < CHEAPEST_POTION_BATCH;
  return broke ? 'money' : 'level';
}

function chooseHunt(snap, why) {
  // The planner gets a short window to prefer another of the candidates.
  brain.mapChoiceOpenUntil = Date.now() + MAP_CHOICE_WINDOW_MS;
  let list = candidates(snap);
  if (!list.length && brain.excluded.size) {
    // Ruled everything out (a run of travel failures): forgive and look again.
    log('hunt_reset_exclusions', { excluded: [...brain.excluded.keys()].join(', ') });
    brain.excluded.clear();
    list = candidates(snap);
  }
  if (!list.length) {
    // Still nothing: keep hunting where we are rather than re-picking every tick.
    brain.huntLevel = snap.me.baseLevel || 1;
    log('hunt_none', { why, map: snap.me.map });
    setPlan({ ...brain.plan, hunt_map: snap.me.map }, snap);
    return;
  }
  brain.huntLevel = snap.me.baseLevel || 1;
  setPlan({ ...planFromCandidate(list[0]), goal: brain.plan.goal, todo: brain.plan.todo }, snap);
  log('hunt_pick', {
    why,
    map: brain.plan.hunt_map,
    level: brain.huntLevel,
    candidates: list.map((c) => `${c.map}(h${c.hops}) ${c.targets.map((t) => `${t.name}/${t.level}`).join(',')}`),
  });
  replan(snap, why);
}

function exclude(map, why) {
  if (!map) return;
  brain.excluded.set(map, Date.now() + EXCLUDE_FOR_MS);
  saveState();
  log('map_excluded', { map, why });
}

let lastFollowMoveAt = 0;
async function followTick(snap) {
  const leader = snap.players.find((p) => p.name === brain.mode.name);
  if (!leader) {
    // Out of sight (warped, changed map): give up after a while instead of standing forever.
    brain.mode.lostAt ??= Date.now();
    if (Date.now() - brain.mode.lostAt > 30000) {
      log('follow_lost', { name: brain.mode.name });
      brain.mode = { kind: 'farm' };
    }
    return;
  }
  brain.mode.lostAt = undefined;
  if (leader.dist > 3 && Date.now() - lastFollowMoveAt > 1000) {
    lastFollowMoveAt = Date.now();
    await act(page, 'move', { x: leader.x, y: leader.y });
  }
}

/**
 * On the hunting map, if even the strongest potion we could buy heals slower than
 * the damage we take, more potions won't fix it: hunt somewhere easier.
 */
let damageMap = null;
let damageMapSince = 0;
const QUIET_MAP_MS = 3 * 60 * 1000;
let lastOutpacedCheck = 0;
/** Share of the last DRINK_WINDOW_MS spent drinking (each potion costs a POTION_GAP_MS turn). */
function drinkShare() {
  const since = Date.now() - DRINK_WINDOW_MS;
  brain.drinks = brain.drinks.filter((t) => t > since);
  return Math.min(1, (brain.drinks.length * POTION_GAP_MS) / DRINK_WINDOW_MS);
}

/**
 * A wing used while being hit on the hunting map is an escape. A wing lands at random: on a map
 * crowded with aggressive monsters the second escape lands in the next pack (gef_fild08: 4, then 7
 * on us, dead). So two escapes in the window = leave this map now, not at the next potion check.
 */
function noteEscape(snap, action) {
  const huntMap = brain.plan.hunt_map;
  if (!((action === 'fly_wing' || action === 'butterfly_wing') && snap.attackers.length && snap.me.map === huntMap)) return;
  brain.escapes = (brain.escapes || []).filter((t) => Date.now() - t < ESCAPE_WINDOW_MS);
  // One escape is seen by both the fight tick and the farm tick (and a wing press can repeat while
  // the warp loads): count it once — it was once counted twice two seconds apart.
  if (Date.now() - (brain.escapes.at(-1) || 0) < ESCAPE_DEDUPE_MS) return;
  brain.escapes.push(Date.now());
  if (brain.escapes.length < ESCAPES_TO_LEAVE) return;
  brain.escapes = [];
  brain.levelOffset = Math.max(-MAX_LEVEL_DROP, brain.levelOffset - LEVEL_UP_WHEN_EASY);
  brain.hardMaps.set(huntMap, { dps: Math.round(damage.p90() ?? 0), level: snap.me.baseLevel || 1, escapes: true });
  saveState();
  log('level_offset', { offset: brain.levelOffset, why: `หนีด้วยปีกซ้ำที่ ${huntMap}: มอนรุมเยอะเกิน` });
  learn(`ที่ ${huntMap} ต้องใช้ปีกหนีซ้ำ (มอนก้าวร้าวรุม) — อย่ากลับมาจนกว่าจะแข็งแรงขึ้น`);
  exclude(huntMap, 'หนีด้วยปีกซ้ำ: มอนรุมเยอะเกิน');
  chooseHunt(snap, `หนีซ้ำที่ ${huntMap}: ย้ายแมพ`);
}

/** Escaping instead of drinking hides a map that's too hard from drinkShare: count those too. */
function tooManyEscapes() {
  brain.escapes = (brain.escapes || []).filter((t) => Date.now() - t < ESCAPE_WINDOW_MS);
  return brain.escapes.length >= ESCAPES_TO_LEAVE;
}

function checkOutpaced(snap) {
  const huntMap = brain.plan.hunt_map;
  if (snap.me.map !== huntMap) return;
  if (damageMap !== huntMap) {
    damageMap = huntMap;
    damageMapSince = Date.now();
    damage.reset();
    brain.easyChecks = 0;
  }
  damage.sample(snap);
  if (Date.now() - lastOutpacedCheck < 60000) return;
  lastOutpacedCheck = Date.now();
  // Hardly ever hit (not even 20 samples) after a few minutes here: that IS easy — count it as 0
  // damage, or the "too easy, climb" rule never runs (12 minutes at full HP on mjolnir_07).
  const measured = damage.p90();
  const dps = measured ?? (Date.now() - damageMapSince > QUIET_MAP_MS ? 0 : null);
  if (dps === null) return;
  // An empty or freshly reloading bag reads as "no potions" (carried=0) and once excluded a map on a blink.
  if (!(snap.inventory || []).length || (snap.mapAgeMs ?? Infinity) < 15000) return;
  // Compare the fights here with the bottles we actually carry, then with what we can buy.
  const need = dps * KEEP_UP;
  const carried = bagHps(snap.inventory, snap.me);
  const buyable = choosePotion({ me: snap.me, dps, budget: potionBudget(snap.me, snap.inventory) });
  log('potion_check', { map: huntMap, dps: Math.round(dps), need: Math.round(need), carried: Math.round(carried), buyable: buyable.outpaced ? null : buyable.potion?.name });
  // The other way too: a drop for a bad map (or a death) must not stick forever. Easy for
  // EASY_CHECKS minutes running → hunt stronger monsters (more EXP per kill).
  // Only when levelling: hunting for money, easy is the point.
  brain.easyChecks = brain.plan.goal === 'level' && tooEasy({ dps, carried, drinkShare: drinkShare() }) ? (brain.easyChecks || 0) + 1 : 0;
  if (brain.easyChecks >= EASY_CHECKS && brain.levelOffset < MAX_LEVEL_ABOVE) {
    brain.easyChecks = 0;
    brain.levelOffset = Math.min(MAX_LEVEL_ABOVE, brain.levelOffset + LEVEL_UP_WHEN_EASY);
    saveState();
    log('level_offset', { offset: brain.levelOffset, why: `สบายเกินที่ ${huntMap}: ดาเมจ ${Math.round(dps)} HP/วิ ยาฟื้นได้ ${Math.round(carried)}` });
    chooseHunt(snap, `ที่ ${huntMap} มอนอ่อนเกินไป (EXP น้อย): เพิ่มระดับมอนเป็น เลเวลตัวเอง ${brain.levelOffset}`);
    brain.climbedTo = { from: huntMap, at: Date.now() }; // the next map is on probation
    return;
  }
  // Just climbed and the first look already says the potions can't keep up: step back at once,
  // don't wait to be drinking 40% of the time (a +3 climb once met 327 HP/s and died in a minute).
  if (brain.climbedTo && brain.climbedTo.from !== huntMap && carried < need) {
    brain.climbedTo = null;
    brain.levelOffset -= LEVEL_UP_WHEN_EASY;
    brain.hardMaps.set(huntMap, { dps: Math.round(dps), level: snap.me.baseLevel || 1 });
    saveState();
    log('level_offset', { offset: brain.levelOffset, why: `ขยับขึ้นแล้วเจอ ${huntMap} แรงเกิน (${Math.round(dps)} HP/วิ): ถอยกลับ` });
    exclude(huntMap, `ดาเมจ ${Math.round(dps)} HP/วิ หลังขยับระดับมอน`);
    chooseHunt(snap, `${huntMap} แรงเกินหลังขยับขึ้น: กลับไประดับเดิม`);
    return;
  }
  if (brain.climbedTo && brain.climbedTo.from !== huntMap) brain.climbedTo = null; // passed probation
  if (carried >= need) return;
  // Leave only when it really is "drinking instead of fighting": the share of the last
  // two minutes spent drinking, not the theory alone (that bounced us off fine maps).
  const share = drinkShare();
  log('potion_check_share', { map: huntMap, drinkShare: Math.round(share * 100) });
  if (buyable.potion && !buyable.outpaced) {
    // A stronger potion fixes it and we can pay: go get it.
    if (errand.requestBuy(buyable.potion, `ยาในตัวฟื้น ${Math.round(carried)} HP/วิ ไม่พอสู้ดาเมจ ${Math.round(dps)} HP/วิ (ต้อง ${Math.round(need)}) → ซื้อ ${buyable.potion.name}`)) {
      log('potion_upgrade', { from: Math.round(carried), want: buyable.potion.name });
    }
    return;
  }
  // Coping in practice: little time drinking and no string of wing escapes.
  const escaping = tooManyEscapes();
  if (share < DRINK_SHARE_TO_LEAVE && !escaping) return;
  if (escaping) log('potion_check_escapes', { map: huntMap, escapes: brain.escapes.length });
  brain.escapes = [];
  // Nothing we can buy keeps up and we're mostly drinking: too strong for us. Hunt weaker ones.
  brain.levelOffset = Math.max(-MAX_LEVEL_DROP, brain.levelOffset - LEVEL_DROP_PER_DEATH);
  saveState();
  log('level_offset', { offset: brain.levelOffset, why: `ยาไม่ทันดาเมจที่ ${huntMap}` });
  learn(`ที่ ${huntMap} ศัตรูตี ${Math.round(dps)} HP/วิ ยาที่ซื้อได้ฟื้นไม่ทัน (ต้อง ${Math.round(need)}) — อย่าล่าแมพนี้จนกว่าจะแข็งแรงขึ้น`);
  brain.hardMaps.set(huntMap, { dps: Math.round(dps), level: snap.me.baseLevel || 1 });
  exclude(huntMap, `ดาเมจ ${Math.round(dps)} HP/วิ เกินที่ยาซื้อได้จะตามทัน`);
  chooseHunt(snap, `ยาไม่ทันดาเมจที่ ${huntMap} (${Math.round(dps)} HP/วิ): ลดระดับมอน`);
}

function endJobChange(done, snap) {
  if (done.ok) {
    notify(`🎓 เปลี่ยนอาชีพสำเร็จ: ${done.from} → ${done.now}`, `ต่อไปตามสาย: ${config.classPath.join(' → ')}`, {}, 0x4caf50);
    // New job, new skills and build weights: re-plan skills and pick a hunting ground again.
    brain.huntLevel = 0;
  } else {
    const said = (done.transcript || []).map((t) => (t.npc ? t.npc.join(' ') : t.menu ? `[เมนู] ${t.menu.join(' / ')} → ${t.chose}` : '')).join('\n').slice(-900);
    notify(`⚠️ เปลี่ยนอาชีพไม่สำเร็จ: ${done.from} → ${done.to}`, `${done.note} (ลองใหม่ใน 30 นาที)`, { 'NPC พูดว่า': said || '-' }, 0xff9800);
  }
  setPlan({ ...brain.plan, goal: committedGoal(snap), objective: done.ok ? `เป็น ${done.now} แล้ว กลับไปเก็บเลเวล` : `เปลี่ยนอาชีพไม่สำเร็จ (${done.note}) กลับไปเก็บเลเวลก่อน`, reason: done.note }, snap);
}

function endErrand(done, snap) {
  const what = [done.sold ? `ขายของ ${done.sold} ชิ้น` : '', done.bought.length ? `ซื้อ ${done.bought.join(', ')}` : ''].filter(Boolean).join(', ');
  const objective = done.ok ? `${what || 'ธุระเสร็จ'} — กลับไปล่าที่ ${brain.plan.hunt_map || 'แมพเดิม'}` : `ไปร้านไม่สำเร็จ (${done.note}) — กลับไปล่าก่อน`;
  setPlan({ ...brain.plan, goal: committedGoal(snap), objective, reason: done.note }, snap);
}

const triedWear = new Map(); // inventory index -> last try (the server may refuse: level, job, broken)
let lastWearCheck = 0;
async function wearBetterGear(snap) {
  if (Date.now() - lastWearCheck < 3000) return;
  lastWearCheck = Date.now();
  const pick = gearToWear(snap.inventory, snap.worn, snap.me.baseLevel);
  if (!pick || Date.now() - (triedWear.get(pick.index) || 0) < 60000) return;
  triedWear.set(pick.index, Date.now());
  await act(page, 'equip', { index: pick.index, loc: pick.loc });
  log('equip', { item: pick.name, why: pick.why });
  notify(`🛡️ ใส่ ${pick.name}`, pick.why === 'empty slot' ? 'ช่องนี้ว่างอยู่' : pick.why, {}, 0x607d8b);
}

async function farmTick(snap) {
  errand.observe(snap, brain.plan.goal); // usage rates of potions and wings, for balanced shopping
  const hp = snap.me.maxHp ? snap.me.hp / snap.me.maxHp : 1;
  const huntMap = brain.plan.hunt_map;
  const away = !!huntMap && snap.me.map !== huntMap;

  // In town and hurt (e.g. just respawned): the Healer NPC is free, potions aren't.
  if (!snap.me.dead && !snap.attackers.length && (healer.active || healer.maybeStart(snap))) {
    await healer.tick(snap);
    return;
  }

  // Gear: an empty slot (a stripped weapon) or a better piece in the bag goes on, between fights.
  if (!snap.me.dead && !snap.attackers.length && !errand.active && !storage.active) await wearBetterGear(snap);

  // Owner's rule: cards are never sold — in a town with a Kafra, put them into storage.
  if (!snap.me.dead && !snap.attackers.length && !errand.active && !jobChange.active && (storage.active || storage.maybeStart(snap))) {
    const done = await storage.tick(snap);
    if (done?.stored) notify(`🃏 ฝากการ์ดเข้า Kafra storage แล้ว ${done.stored} ใบ`, done.note, {}, 0x9c27b0);
    return;
  }

  // Owner's request: in Morroc, ask a nearby player for a little zeny (polite, rate-limited),
  // then hang around briefly for an answer or a trade.
  if (!snap.attackers.length && !errand.active && !jobChange.active) {
    const linger = await beggar.maybeAsk(snap);
    if (linger) {
      brain.mode = { kind: 'wait', until: Date.now() + linger };
      return;
    }
  }

  // Survival first, wherever we are. On the way somewhere, only fight back — except monsters we
  // avoid (plants that shoot and stone us): fighting back held us a minute in range of Parasites
  // instead of taking the @go out, and the stone that followed was fatal. Keep travelling.
  const avoid = new Set(brain.plan.avoid_monsters || []);
  const onlyAvoided = away && snap.attackers.length > 0 && snap.attackers.every((g) => { const m = snap.monsters.find((x) => x.GID === g); return m && avoid.has(m.name); });
  // Leaving a map with @go at hand: the warp is the escape. Fighting back on the way kept us on
  // mjolnir_04 winging from pack to pack. Below 25% HP the emergency rules still take over.
  // Only when the next step really is the @go: walking away with a pack behind us is no escape.
  if (away && travel.canGo && hp >= 0.25 && !snap.me.dead && snap.attackers.length && !onlyAvoided) {
    if (travel.dest !== huntMap) await travel.start(huntMap);
    // The route's first step is only known once travel has planned it: plan now, even mid-fight.
    if (travel.legKind === null) await travel.tick(snap);
    if (travel.legKind === 'go') {
      await travel.tick(snap);
      return;
    }
  }
  if (snap.me.dead || (snap.attackers.length && !(onlyAvoided && hp >= 0.4)) || hp < 0.4) {
    const inTown = !!world && isTown(world, snap.me.map);
    const { action, drank } = await reflex(snap, { defendOnly: away, inTown });
    noteEscape(snap, action);
    brain.fighting = action === 'attack_monster' || action === 'keep_fighting';
    if (drank) brain.drinks.push(Date.now());
    brain.counters.actions[action] = (brain.counters.actions[action] || 0) + 1;
    return;
  }

  // Shopping trip: decided here from the bag (potions low and affordable, or too heavy), then
  // it runs until done and hunting picks up again (travel back to the hunt map is automatic).
  if (!errand.active) {
    const started = errand.maybeStart(snap);
    if (started) {
      if (travel.dest) await travel.stop();
      setPlan({ ...brain.plan, goal: started.goal, objective: started.why, reason: started.why }, snap);
    }
  }
  if (errand.active) {
    const done = await errand.tick(snap);
    if (done) endErrand(done, snap);
    return;
  }

  // Job change: qualified for the next job on CLASS_PATH -> go to the Job Master.
  if (!jobChange.active) {
    const started = jobChange.maybeStart(snap);
    if (started) {
      if (travel.dest) await travel.stop();
      setPlan({ ...brain.plan, goal: 'job_change', objective: started.why, reason: started.why }, snap);
    }
  }
  if (jobChange.active) {
    const done = await jobChange.tick(snap);
    if (done) endJobChange(done, snap);
    return;
  }

  // Potions ran out (or came back): the safe hunting level changed, pick again. Only once
  // the new state has held for a few seconds — the inventory reads empty for a moment on
  // every map load, and reacting to that bounced the character between two maps.
  const lowNow = lowOnPotions(snap);
  if (lowNow !== !!brain.lowOnPotions) brain.lowFlipSince ??= Date.now();
  else brain.lowFlipSince = undefined;
  const low = brain.lowFlipSince && Date.now() - brain.lowFlipSince >= LOW_FLIP_CONFIRM_MS ? lowNow : !!brain.lowOnPotions;
  if (world && huntMap && low !== !!brain.lowOnPotions) {
    brain.lowFlipSince = undefined;
    brain.lowOnPotions = low;
    chooseHunt(snap, low ? `ยาหมด: ล่ามอนต่ำกว่าเลเวลตัวเอง ${NO_POTION_LEVEL_DROP} จนกว่าจะซื้อยาได้` : 'มียาแล้ว: กลับไปล่าตามเลเวล');
    return;
  }

  // A hunting map can also come from the planner; start counting levels from there.
  if (huntMap && !brain.huntLevel) brain.huntLevel = snap.me.baseLevel || 1;
  if (world && (!huntMap || (snap.me.baseLevel || 1) - brain.huntLevel >= REPICK_EVERY_LEVELS)) {
    chooseHunt(snap, huntMap ? `เลเวลขึ้นเป็น ${snap.me.baseLevel}` : 'เริ่มเล่น');
    return;
  }

  if (away) {
    if (travel.dest !== huntMap) await travel.start(huntMap);
    if ((await travel.tick(snap)) === 'failed') {
      exclude(huntMap, 'เดินทางไปไม่ได้');
      chooseHunt(snap, `ไป ${huntMap} ไม่ได้`);
    }
    return;
  }

  if (travel.dest) await travel.stop();
  const { action, stuck, drank } = await reflex(snap);
  noteEscape(snap, action);
  brain.fighting = action === 'attack_monster' || action === 'keep_fighting';
  brain.counters.actions[action] = (brain.counters.actions[action] || 0) + 1;
  if (stuck) {
    exclude(huntMap, 'หามอนไม่เจอ/เดินไม่ไป');
    chooseHunt(snap, `ติดอยู่ที่ ${snap.me.map}`);
  }
}

/**
 * Stunned / frozen / put to sleep / petrified / silenced. A monster that does it to
 * us twice within the window isn't worth fighting with this gear: avoid it from now
 * on (prevention would be a card — Orc Hero for stun, Marc for freeze — see gear goal).
 */
/** What the agent learned and must not forget on a restart (monsters to avoid). */
function saveState() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ avoidExtra: [...brain.avoidExtra], levelOffset: brain.levelOffset, excluded: Object.fromEntries(brain.excluded), hardMaps: Object.fromEntries(brain.hardMaps), moneyMode: brain.moneyMode, scoutDropped: [...brain.scoutDropped] }, null, 2));
  } catch (err) {
    log('state_save_error', { error: err.message });
  }
}

function loadState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    for (const name of s.avoidExtra || []) brain.avoidExtra.add(name);
    brain.levelOffset = Number(s.levelOffset) || 0;
    for (const cmd of s.scoutDropped || []) brain.scoutDropped.add(cmd);
    for (const [map, h] of Object.entries(s.hardMaps || {})) brain.hardMaps.set(map, h);
    brain.moneyMode = s.moneyMode ?? true;
    for (const [map, until] of Object.entries(s.excluded || {})) if (until > Date.now()) brain.excluded.set(map, until);
    log('state_loaded', { avoid: [...brain.avoidExtra].join(', '), levelOffset: brain.levelOffset, moneyMode: brain.moneyMode });
  } catch {}
}

const AVOIDED_HERE_TO_LEAVE = 5; // this many of a newly avoided monster spawn on the hunting map: leave it

function onDisabled(ev, snap) {
  log('disabled', { state: ev.state, by: ev.from.join(', ') || '?', map: snap.me.map });
  const now = Date.now();
  for (const name of new Set(ev.from)) { // two Punks hitting us is still one stoning
    const times = (brain.disablers.get(name) || []).filter((t) => now - t < DISABLE_WINDOW_MS);
    times.push(now);
    brain.disablers.set(name, times);
    if (times.length >= DISABLES_TO_AVOID && !brain.avoidExtra.has(name)) {
      brain.avoidExtra.add(name);
      saveState();
      brain.plan.avoid_monsters = [...new Set([...(brain.plan.avoid_monsters || []), name])];
      brain.plan.target_monsters = (brain.plan.target_monsters || []).filter((n) => n !== name);
      log('avoid_monster', { name, why: `${ev.state} x${times.length}` });
      learn(`${name} ทำให้${STATE_TH[ev.state] || ev.state} บ่อย — อย่าตีและอย่าล่าแมพที่มีมันเยอะ (ต้องมีการ์ดกันสถานะก่อน)`);
      notify(`🚫 เลิกตี ${name}`, `โดน${STATE_TH[ev.state] || ev.state} ${times.length} ครั้งใน ${DISABLE_WINDOW_MS / 60000} นาที — ถ้าจะสู้ต้องใช้การ์ดกันสถานะ`, { แมพ: snap.me.map }, 0xff9800);
      // Nothing left worth hitting here — or plenty of them around: not hitting them doesn't stop
      // them hitting us (Parasites are plants that shoot; it stoned us again a few seconds later).
      const many = brain.plan.hunt_map && world ? spawnsOn(world, brain.plan.hunt_map).filter((m) => m.name === name).reduce((n, m) => n + m.count, 0) >= AVOIDED_HERE_TO_LEAVE : false;
      if ((!brain.plan.target_monsters.length || many) && brain.plan.hunt_map) {
        exclude(brain.plan.hunt_map, many ? `มี ${name} เยอะ (ทำให้${STATE_TH[ev.state] || ev.state})` : `เหลือแต่มอนที่ทำให้${STATE_TH[ev.state] || ev.state}`);
        chooseHunt(snap, `${name} ที่ ${brain.plan.hunt_map} ทำให้ติดสถานะ: ย้ายแมพ`);
      }
    } else if (brain.avoidExtra.has(name) && snap.me.map === brain.plan.hunt_map && brain.plan.hunt_map) {
      // Already avoided and still getting us: it isn't avoidable here. Leave.
      exclude(brain.plan.hunt_map, `${name} ยังทำให้${STATE_TH[ev.state] || ev.state} ทั้งที่ไม่ได้ตี`);
      chooseHunt(snap, `${name} ยังทำให้ติดสถานะที่ ${brain.plan.hunt_map}: ย้ายแมพ`);
    }
  }
}

function onDeath(snap) {
  brain.counters.deaths++;
  const map = snap.me.map;
  const killers = [...new Set((snap.monsters || []).filter((m) => snap.attackers.includes(m.GID)).map((m) => m.name))];
  learn(`ตายที่ ${map}${killers.length ? ` โดน ${killers.join(', ')} รุม` : ''} (Base ${snap.me.baseLevel}, ระดับมอน ${brain.levelOffset})`);
  if (map === brain.plan.hunt_map) {
    // Died where we chose to hunt: that level of monster is too much for this character now.
    brain.levelOffset = Math.max(-MAX_LEVEL_DROP, brain.levelOffset - LEVEL_DROP_PER_DEATH);
    brain.levelsSinceDeath = 0;
    saveState();
    log('level_offset', { offset: brain.levelOffset, why: `ตายที่ ${map}` });
    // Remembered past the 30-minute exclusion: until we're HARD_MAP_LEVELS stronger (it once sent
    // us straight back to ein_fild08 forty minutes after dying there).
    brain.hardMaps.set(map, { dps: Math.round(damage.p90() ?? 0), level: snap.me.baseLevel || 1, died: true });
    exclude(map, 'ตายที่นี่: มอนแรงเกินตัว');
    chooseHunt(snap, `ตายที่ ${map}: ลดระดับมอนเป็น เลเวลตัวเอง ${brain.levelOffset}`);
    return;
  }
  const recent = (brain.deathsOn.get(map) || []).filter((t) => Date.now() - t < EXCLUDE_FOR_MS);
  recent.push(Date.now());
  brain.deathsOn.set(map, recent);
  log('died', { map, timesHere: recent.length });
  // Killed (partly) by monsters we already avoid: they come to us here, so this map is out.
  const byAvoided = (snap.monsters || []).some((m) => snap.attackers.includes(m.GID) && brain.avoidExtra.has(m.name));
  if (byAvoided && map === brain.plan.hunt_map) {
    exclude(map, 'มอนที่เลิกตีตามมาตีเรา');
    chooseHunt(snap, `ตายเพราะมอนที่เลิกตีแล้วที่ ${map}`);
  } else if (recent.length >= DEATHS_TO_ABANDON_MAP && map === brain.plan.hunt_map) {
    exclude(map, `ตาย ${recent.length} ครั้ง`);
    chooseHunt(snap, `ตายที่ ${map} บ่อย`);
  } else {
    replan(snap, 'ตัวละครตาย');
  }
}

let notInGameSince = 0;
// Slow ticks come in runs when the game page stalls: one line a minute with the count and the worst.
const slow = { since: 0, n: 0, worst: 0, last: null };
function slowTick(info) {
  slow.n++;
  if (info.ms > slow.worst) { slow.worst = info.ms; slow.last = info; }
  if (Date.now() - slow.since < 60000) return;
  log('slow_tick', { ...slow.last, count: slow.n, worstMs: slow.worst });
  Object.assign(slow, { since: Date.now(), n: 0, worst: 0, last: null });
}
let lastTickEnd = Date.now();
for (;;) {
  const started = Date.now();
  // A gap between ticks (a slow await somewhere) or a stretch of "not in game" snapshots once hid
  // 12 seconds in which HP went from 76% to 22% with nothing decided: record them as incidents.
  if (started - lastTickEnd > SLOW_TICK_MS) slowTick({ ms: started - lastTickEnd, fighting: brain.fighting });
  brain.fighting = false; // set again by this tick's reflex if we are still in a fight
  try {
    const snapAt = Date.now();
    const snap = await snapshot(page);
    if (Date.now() - snapAt > SLOW_TICK_MS) slowTick({ ms: Date.now() - snapAt, phase: 'snapshot', map: snap.me?.map, players: snap.players?.length });
    if (snap.me) setIdentity(snap.me);
    if (!snap.inGame) {
      notInGameSince ||= Date.now();
      if (Date.now() - notInGameSince > 3000 && !brain.notInGameLogged) {
        brain.notInGameLogged = true;
        log('not_in_game', { ready: snap.ready, secs: Math.round((Date.now() - notInGameSince) / 1000) });
      }
      await Bun.sleep(1000);
      lastTickEnd = Date.now();
      continue;
    }
    notInGameSince = 0;
    brain.notInGameLogged = false;

    for (const ev of await drainEvents(page)) {
      if (ev.type === 'status' || ev.type === 'skill_fail') skills.onEvent(ev);
      if (ev.type === 'skill_fail') {
        // Which skill the server refused and why (cause = ZC_ACK_TOUSESKILL reason, e.g. no cart/SP/weapon).
        const s = (snap.me.skills || []).find((k) => k.id === ev.SKID);
        log('skill_fail', { skill: s ? s.name : ev.SKID, cause: ev.cause });
      }
      if (ev.type === 'shop_result') {
        const done = await errand.onEvent(ev, snap);
        if (done) endErrand(done, snap);
      }
      if (ev.type === 'chat' && REFUSAL.test(ev.text)) beggar.refused(ev.from); // never ask them again
      if (ev.type === 'chat') chat.push(ev, getSnap);
      else if (ev.type === 'level_up') {
        log('level_up', { kind: ev.kind, level: ev.level });
        // A clean base level (no death since) earns back one level of difficulty.
        if (ev.kind === 'base' && brain.levelOffset < 0) {
          brain.levelOffset += 1;
          saveState();
          log('level_offset', { offset: brain.levelOffset, why: 'เลเวลขึ้นโดยไม่ตาย' });
        }
      }
      else if (ev.type === 'died') onDeath(snap);
      else if (ev.type === 'disabled') onDisabled(ev, snap);
      else if (ev.type === 'trade_done' && ev.ok) {
        log('trade_received', { from: ev.from, zeny: ev.zeny, items: ev.items });
        notify(`🎁 ได้รับจาก ${ev.from}`, `zeny ${ev.zeny || 0}${ev.items ? ` + ของ ${ev.items} ชิ้น` : ''}`, {}, 0x4caf50);
        await act(page, 'say', { text: `ขอบคุณมากๆ นะคะ ${ev.from} 💕` });
      }
    }

    if (brain.mode.kind !== 'farm' && Date.now() > brain.mode.until) brain.mode = { kind: 'farm' };
    // Someone trading with us: handle it before anything else (receive only).
    if (snap.trade) {
      await trader.tick(snap);
      await Bun.sleep(config.tickMs);
      continue;
    }
    const hp = snap.me.maxHp ? snap.me.hp / snap.me.maxHp : 1;
    const safe = !snap.attackers.length && hp >= 0.4 && !snap.me.dead;

    checkSignals(snap);
    checkOutpaced(snap);
    if (safe) await buildTick(snap);
    if (safe) await hotkeys.sync(snap, skills.book); // F1-F9 buffs, 1-9 attacks, Q-O items

    if (brain.mode.kind === 'follow' && safe) await followTick(snap);
    else if (brain.mode.kind === 'wait' && safe) {
      // stand still, chat keeps working
    } else await farmTick(snap);

    if (Date.now() - brain.lastPlanAt > config.plannerIntervalMs) replan(snap, 'ทบทวนแผนตามรอบ');
  } catch (err) {
    log('loop_error', { error: err.message });
    if (/Target (page|closed)|has been closed|browser has disconnected/i.test(err.message)) break;
    await Bun.sleep(1000);
  }
  // In a fight, tick fast so skills go out as soon as their cooldown allows.
  const tick = brain.fighting ? FIGHT_TICK_MS : config.tickMs;
  const spent = Date.now() - started;
  if (spent > SLOW_TICK_MS) slowTick({ ms: spent, phase: 'tick', fighting: brain.fighting });
  await Bun.sleep(Math.max(0, tick - spent));
  lastTickEnd = Date.now();
}
