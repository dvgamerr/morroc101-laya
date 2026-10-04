import { observeFarmTrip, finishFarmTrip, abortFarmTravel, settleFarmErrand } from './farm-profit.js';
import { createEmergencyReturn } from './emergency-return.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { config } from './config.js';
import { openGame, waitForInGame, snapshot, drainEvents, act } from './browser.js';
import { createReflex } from './reflex.js';
import { createChat } from './chat.js';
import { createTravel } from './travel.js';
import { observeWarpers } from './warper-reference.js';
import { loadWorld, pickHuntingGrounds, isTown, spawnsOn, bossNames } from './world.js';
import { createScout } from './scout.js';
import { plan, DEFAULT_PLAN } from './planner.js';
import { log } from './logger.js';
import { notifyGoalChange } from './notify.js';
import { detectSignals } from './goals.js';
import { createSkillBook } from './skills.js';
import { nextStat } from './build.js';
import { createErrand, potionBudget } from './errand.js';
import { createDamageTracker, choosePotion, stockHp, bagHps, KEEP_UP, POTION_GAP_MS, tooEasy } from './potions.js';
import { createJobChange } from './jobchange.js';
import { createDialog } from './npc.js';
import { createHealer, weaponBlocked } from './heal.js';
import { createStorage } from './storage.js';
import { createItemReview } from './item-review.js';
import { createWeaponRecovery } from './weapon-recovery.js';
import { rememberEquipped } from './equipment-memory.js';
import { createGearUpgrade } from './gear-upgrade.js';
import { createHotkeys } from './hotkeys.js';
import { learn } from './lessons.js';
import { createTrader } from './social.js';
import { notify, setIdentity } from './notify.js';
import * as llm from './llm.js';
import { createReconnect } from './reconnect.js';
import { oresIn } from './ores.js';

const REPICK_EVERY_LEVELS = 3;
const EXCLUDE_FOR_MS = 30 * 60 * 1000;
const DEATHS_TO_ABANDON_MAP = 2;
const STAT_GAP_MS = 400;
const SIGNAL_REPLAN_GAP_MS = 60000;
const FIGHT_TICK_MS = 120;
const DISABLE_WINDOW_MS = 10 * 60 * 1000;
const DISABLES_TO_AVOID = 2;
const LOW_FLIP_CONFIRM_MS = 5000;
const LEVEL_DROP_PER_DEATH = 5;
const DRINK_WINDOW_MS = 120000;
const DRINK_SHARE_TO_LEAVE = 0.4; // 40% of the time drinking = not really fighting
const MAP_CHOICE_WINDOW_MS = 30000;
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
  avoidAtLevel: new Map(), // monster -> Base Level at the failed encounter
  avoidExtra: new Set(), // monsters learned to be not worth fighting (kept across plans)
  // Hunt this many levels below/above our own: lowered by deaths, eased back by clean level-ups.
  // The character's gear decides what it can farm, not just its level.
  levelOffset: 0,
  moneyMode: false, // enter below reserve, then farm up to errand.moneyTarget
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
const reconnect = createReconnect(page);
log('boot', { url: config.game.url, laya: config.laya.model, llm: config.llm.model, session: reused ? 'reused' : 'new' });

// A cold oMLX model takes ~40s to load; do it while the player is still logging in.
llm.chat([{ role: 'user', content: 'ping' }], { maxTokens: 1, timeoutMs: 120000 })
  .then(() => log('llm_warm'))
  .catch((err) => log('llm_warm_error', { error: err.message }));

const world = await loadWorld()
  .then((w) => (log('world_loaded', { maps: w.spawnsByMap.size, mobs: w.mobs.size }), w))
  .catch((err) => (log('world_error', { error: err.message }), null));

if (!reused) console.log('>> ล็อกอินและเลือกตัวละครในหน้าต่างเบราว์เซอร์ได้เลย agent จะเริ่มเมื่อเข้าแมพแล้ว');
const startupSnapshot = await waitForInGame(page, (snap) => {
  if (snap && snap.ready === false) process.stdout.write('.');
}, reconnect);
log('in_game');
const startupEquipment = rememberEquipped(startupSnapshot);
console.table(startupEquipment.map(i => ({ item: i.name, ITID: i.ITID, refine: i.refine || 0, slot: i.slot || 'equipped', rule: 'ห้ามขาย' })));
log('equipment_protected', { items: startupEquipment.map(i => ({ ITID: i.ITID, name: i.name, refine: i.refine || 0 })) });

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
const reflex = createReflex(page, brain, scout, skills, hotkeys, world, () => snapshot(page));
const trader = createTrader(page);
// One @go state for every traveller (hunting, shopping, job change).
const goState = { canGo: true, bad: new Set() };
const travelForErrands = createTravel(page, goState, world);
const damage = createDamageTracker();
const weapons = createWeaponRecovery(brain.restoreWeapon, weapon => { brain.restoreWeapon = weapon; saveState(); });
const itemReview = createItemReview(page, weapons);
const storage = createStorage(page, world, createDialog(page), itemReview);
const errand = createErrand(page, world, travelForErrands, () => damage.p90(), itemReview, storage);
const jobChange = createJobChange(page, world, travelForErrands, createDialog(page));
const healer = createHealer(page, world, createDialog(page), createTravel(page, goState, world));
const chat = createChat(page, brain);
const travel = createTravel(page, goState, world);
const gearUpgrade = createGearUpgrade(page, createTravel(page, goState, world), storage);
const emergencyReturn = createEmergencyReturn(page, map => map === 'morocc' || !!world && isTown(world, map));
const getSnap = () => snapshot(page);
// Safety polling continues while LAYA, NPC dialogs or other actions are awaited.
let checkingEmergency = false;
const emergencyTimer = setInterval(async () => {
  if (checkingEmergency) return;
  checkingEmergency = true;
  try {
    const live = await getSnap();
    if (live?.inGame) await emergencyReturn(live);
  } catch (err) {
    log('emergency_check_error', { error: err.message });
  } finally { checkingEmergency = false; }
}, 150);
emergencyTimer.unref();

/** Swap in a new plan; tell Discord when the goal or the hunting map actually changes. */
function setPlan(next, snap) {
  const prev = brain.plan;
  // Only current combat lessons constrain the new plan.
  const bosses = bossNames(world);
  const currentAvoid = (next.avoid_monsters || []).filter(name => {
    const level = brain.avoidAtLevel.get(name);
    return level === undefined || bosses.has(name) || (level > 0 && snap.me.baseLevel < level + HARD_MAP_LEVELS);
  });
  next.avoid_monsters = [...new Set([...currentAvoid, ...brain.avoidExtra])];
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
    // Initial selection and a mode change are handled once by farmTick.
    if (brain.plan.hunt_map && !brain.huntPending && brain.plan.goal === committedGoal(snap)) {
      replan(snap, `สัญญาณใหม่: ${added.map((s) => s.text).join(', ')}`);
    }
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

function refreshCombatMemory(snap) {
  const level = snap.me.baseLevel;
  if (!Number.isFinite(level)) return;
  const released = [];
  for (const name of brain.avoidExtra) {
    const at = brain.avoidAtLevel.get(name);
    if (!at || level >= at + HARD_MAP_LEVELS) {
      brain.avoidExtra.delete(name);
      brain.disablers.delete(name);
      released.push(name);
    }
  }
  for (const [map, h] of brain.hardMaps) {
    if (level >= h.level + HARD_MAP_LEVELS) {
      brain.hardMaps.delete(map);
      brain.excluded.delete(map);
      released.push(map);
    }
  }
  if (released.length) {
    brain.plan.avoid_monsters = (brain.plan.avoid_monsters || []).filter(name => !released.includes(name));
    brain.huntLevel = 0;
    brain.lastPlanAt = 0;
    brain.mapChoiceOpenUntil = Date.now() + MAP_CHOICE_WINDOW_MS;
    saveState();
    log('combat_memory_recheck', { level, released });
  }
}

function excluded() {
  const now = Date.now();
  for (const [map, until] of brain.excluded) if (until < now) brain.excluded.delete(map);
  return [...brain.excluded.keys()];
}

/** Out of potions (less than one HP bar's worth): hunt well below our level until resupplied. */

// Not judged in the first seconds on a map: the inventory reloads in pieces after a map change.
const lowOnPotions = (snap) =>
  !config.priestSupport && ((snap.mapAgeMs ?? Infinity) >= 15000 ? stockHp(snap.inventory, snap.me) < (snap.me.maxHp || 0) : !!brain.lowOnPotions);

function candidates(snap) {
  if (!world) return [];
  observeWarpers(world, snap);
  // Compare EXP for leveling and drop value / low damage for money.
  const goal = committedGoal(snap);
  const base = snap.me.baseLevel || 1;
  const level = Math.max(1, base + Math.min(0, brain.levelOffset));
  return pickHuntingGrounds(world, {
    level,
    goal,
    priestSupport: config.priestSupport,
    fromMap: snap.me.map,
    fromX: snap.me.x,
    fromY: snap.me.y,
    canGo: travel.canGo,
    exclude: [...new Set([...excluded(), ...tooHard(snap.me.baseLevel), ...Object.keys(brain.farmResults || {}).filter(map => goal === 'money' && brain.farmResults[map].goal !== 'level' && brain.farmResults[map].net <= 0 && base < brain.farmResults[map].level + HARD_MAP_LEVELS)])],
    avoid: [...brain.avoidExtra],
    limit: Infinity,
  }).sort((a, b) => a.map.localeCompare(b.map));
}

function replan(snap, why) {
  if (!brain.huntPending && (travel.dest || errand.active || jobChange.active) &&
      /^(สัญญาณใหม่|ทบทวนแผน|ยาสำรองต่ำ|เติมยาแล้ว)/.test(why)) {
    brain.lastPlanAt = Date.now();
    log('planner_keep_route', { why, map: brain.plan.hunt_map });
    return;
  }
  if (brain.planning) {
    // Routine observations are already included in the pending request.
    if (!/^(สัญญาณใหม่|ทบทวนแผน|ยาสำรองต่ำ|เติมยาแล้ว)/.test(why)) brain.queuedPlan = { snap, why };
    return;
  }
  brain.planning = true;
  brain.lastPlanAt = Date.now();
  const revision = brain.huntRevision || 0;
  const recent = 'actions ' + JSON.stringify(brain.counters.actions) + ', deaths ' + brain.counters.deaths + ', previous_hunt_map ' + brain.plan.hunt_map + ', farmResults ' + JSON.stringify(brain.farmResults || {});
  const ctx = { candidates: candidates(snap), inTown: world ? isTown(world, snap.me.map) : false, signals: signals(snap), goal: committedGoal(snap), moneyTarget: currentMoneyTarget(snap), farmResults: structuredClone(brain.farmResults || {}) };
  if (!ctx.candidates.length) {
    brain.planning = false;
    log('hunt_none', { why, level: snap.me.baseLevel });
    return;
  }
  plan(snap, why, recent, brain.plan, ctx)
    .then(async (next) => {
      if (revision !== (brain.huntRevision || 0)) return;
      const fresh = await getSnap();
      if (revision !== (brain.huntRevision || 0)) return;
      if (!fresh?.inGame || !fresh.me) return;
      if (!brain.huntPending && (travel.dest || errand.active || jobChange.active)) {
        log('planner_keep_route', { why: 'trip started while planning', map: brain.plan.hunt_map });
        return;
      }
      const eligible = candidates(fresh);
      const goal = committedGoal(fresh);
      if (fresh.me.map !== snap.me.map || goal !== ctx.goal || !ctx.candidates.some(c => c.map === next.hunt_map) || !eligible.some(c => c.map === next.hunt_map)) {
        log('planner_map_rejected', { map: next.hunt_map, reason: 'context changed or map no longer eligible' });
        brain.queuedPlan = { snap: fresh, why: 'ข้อมูลเปลี่ยน: เลือกแมพใหม่' };
        return;
      }
      next.goal = errand.active || jobChange.active ? brain.plan.goal : goal;
      setPlan(next, fresh);
      brain.huntPending = false;
      brain.huntLevel = fresh.me.baseLevel || 1;
      brain.counters.actions = {};
      log('hunt_pick', { by: 'planner', why, map: next.hunt_map, level: brain.huntLevel, reason: next.reason });
    })
    .catch((err) => log('planner_error', { error: err.message }))
    .finally(async () => {
      brain.planning = false;
      const queued = brain.queuedPlan;
      brain.queuedPlan = null;
      if (queued) {
        const fresh = await getSnap().catch(() => null);
        if (fresh?.inGame && fresh.me) replan(fresh, queued.why);
      }
    });
}

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
 * Enter money mode below reserve, continue until cash covers six levelling trips, then level.
 * Reserve is only the entry threshold; it is not added to the target.
 */
function committedGoal(snap) {
  if (gearUpgrade.needsMoney(snap)) return 'money';
  const zeny = snap.me.zeny;
  if (!Number.isFinite(zeny)) return brain.moneyMode ? 'money' : 'level';
  const t = currentMoneyTarget(snap);
  if (brain.moneyMode && zeny >= t.target) {
    brain.moneyMode = false;
    saveState();
    log('money_goal_reached', { zeny, ...t });
    notify(`💰 เก็บเงินครบ ${t.target.toLocaleString()} zeny แล้ว`, `ค่าใช้จ่ายรอบละ ~${t.tripCost.toLocaleString()} zeny × ${t.trips} รอบ (${t.trip}) กลับไปเก็บเลเวล`, {}, 0xffc107);
  } else if (!brain.moneyMode && zeny < t.resume && zeny < t.target) {
    brain.moneyMode = true;
    saveState();
    log('money_goal_resume', { zeny, resume: t.resume, target: t.target, tripCost: t.tripCost, trip: t.trip });
    notify(`💸 เงินเหลือ ${zeny.toLocaleString()} zeny`, `ต่ำกว่าเงินสำรอง ${t.reserve.toLocaleString()} zeny ไปหาเงินจนถึง ${t.target.toLocaleString()} zeny`, {}, 0xff9800);
  }
  if (brain.moneyMode) return 'money';
  return 'level';
}

function chooseHunt(snap, why) {
  if (brain.huntPending && brain.huntWhy === why) return;
  brain.huntPending = true;
  brain.huntWhy = why;
  brain.huntRevision = (brain.huntRevision || 0) + 1;
  log('hunt_wait_plan', { why, level: snap.me.baseLevel });
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
  if (brain.huntPending) return;
  const huntMap = brain.plan.hunt_map;
  if ((action === 'fly_wing' || action === 'butterfly_wing') && snap.attackers.length &&
      huntMap && snap.me.map !== huntMap && travel.dest === huntMap && !brain.huntPending) {
    const key = huntMap + ':' + snap.me.map;
    const times = brain.routeEscapes?.key === key
      ? brain.routeEscapes.times.filter(t => Date.now() - t < ESCAPE_WINDOW_MS) : [];
    if (Date.now() - (times.at(-1) || 0) < ESCAPE_DEDUPE_MS) return;
    times.push(Date.now());
    brain.routeEscapes = { key, times };
    if (times.length >= ESCAPES_TO_LEAVE) {
      brain.routeEscapes = null;
      const why = `หนีซ้ำระหว่างทางที่ ${snap.me.map}: ไป ${huntMap} ไม่ปลอดภัย`;
      brain.farmTrip = abortFarmTravel(brain.farmTrip, why);
      exclude(huntMap, why);
      chooseHunt(snap, why);
    }
    return;
  }
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
  learn(`ที่ ${huntMap} ต้องใช้ปีกหนีซ้ำ (มอนก้าวร้าวรุม) — อย่ากลับมาจนกว่าจะแข็งแรงขึ้น`, { level: snap.me.baseLevel });
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
    learn('ที่ ' + huntMap + ' รับดาเมจสูงหลังย้ายแมพ ยังสู้ไม่ไหว', { level: snap.me.baseLevel });
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
  if (brain.plan.goal !== 'money' && buyable.potion && !buyable.outpaced) {
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
  learn(`ที่ ${huntMap} ศัตรูตี ${Math.round(dps)} HP/วิ ยาที่ซื้อได้ฟื้นไม่ทัน (ต้อง ${Math.round(need)}) — อย่าล่าแมพนี้จนกว่าจะแข็งแรงขึ้น`, { level: snap.me.baseLevel });
  brain.hardMaps.set(huntMap, { dps: Math.round(dps), level: snap.me.baseLevel || 1 });
  saveState();
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
  brain.farmTrip = settleFarmErrand(brain.farmTrip, done);
  brain.profitSettleAfter = Date.now() + 3000; // Wait for a fresh purse after shop result packets.
  const what = [done.sold ? `ขายของ ${done.sold} ชิ้น` : '', done.bought.length ? `ซื้อ ${done.bought.join(', ')}` : ''].filter(Boolean).join(', ');
  const objective = done.ok ? `${what || 'ธุระเสร็จ'} — กลับไปล่าที่ ${brain.plan.hunt_map || 'แมพเดิม'}` : `ไปร้านไม่สำเร็จ (${done.note}) — กลับไปล่าก่อน`;
  setPlan({ ...brain.plan, goal: committedGoal(snap), objective, reason: done.note }, snap);
}

const triedWear = new Map(); // inventory index -> last try (the server may refuse: level, job, broken)
let lastWearCheck = 0;
let recoveringWeapon = false;
async function wearBetterGear(snap) {
  if (weaponBlocked(snap.me)) return;
  if (Date.now() - lastWearCheck < 3000) return;
  lastWearCheck = Date.now();
  const pick = weapons.pick(snap) || (!weapons.pending(snap) ? itemReview.pickEquip(snap) : null);
  if (!pick || Date.now() - (triedWear.get(pick.index) || 0) < 60000) return;
  triedWear.set(pick.index, Date.now());
  await act(page, 'equip', { index: pick.index, loc: pick.loc });
  log('equip', { item: pick.name, why: pick.why });
  notify(`🛡️ ใส่ ${pick.name}`, pick.why === 'empty slot' ? 'ช่องนี้ว่างอยู่' : pick.why, {}, 0x607d8b);
}

let huntSample = null;
function sampleHuntResult(snap) {
  const me = snap.me;
  const active = brain.plan.goal === 'level' && !brain.huntPending && !travel.dest &&
    me.map === brain.plan.hunt_map && !me.dead && Number.isFinite(me.baseExp);
  const now = Date.now();
  if (!active) { huntSample = null; return; }
  const key = me.map + ':' + me.baseLevel;
  if (!huntSample || huntSample.key !== key || now - huntSample.at > 10000 || me.baseExp < huntSample.exp) {
    huntSample = {key, at:now, exp:me.baseExp, gained:0, seconds:0, minHp:100};
    return;
  }
  huntSample.gained += me.baseExp - huntSample.exp;
  huntSample.seconds += (now - huntSample.at) / 1000;
  huntSample.exp = me.baseExp;
  huntSample.at = now;
  if (me.maxHp) huntSample.minHp = Math.min(huntSample.minHp, Math.round(me.hp / me.maxHp * 100));
  if (huntSample.seconds >= 120) {
    const perMinute = Math.round(huntSample.gained * 60 / huntSample.seconds);
    learn('ผลทดลองล่า ' + me.map + ': Base EXP ประมาณ ' + perMinute + '/นาที ใน ' + Math.round(huntSample.seconds) + ' วินาที, HP ต่ำสุด ' + huntSample.minHp + '% (ผลที่วัดได้ ไม่ใช่การรับประกันรอบหน้า)', {level:me.baseLevel});
    log('hunt_observed', {map:me.map,level:me.baseLevel,expPerMinute:perMinute,minHp: huntSample.minHp});
    huntSample = null;
  }
}

async function farmTick(snap) {
  // Capture the equipped weapon even on ticks that immediately enter combat.
  weapons.observe(snap);
  // Remember reaching the target even when combat or recovery returns early.
  // Spending below target afterwards must not restart farming above the reserve.
  const moneyObjective = committedGoal(snap);
  const overweight = snap.me.maxWeight > 0 && snap.me.weight / snap.me.maxWeight >= 0.9;
  if (overweight && world && isTown(world, snap.me.map) && !errand.active) errand.requestSell();
  if (world && !snap.me.dead && (snap.mapAgeMs ?? Infinity) >= 3000) {
    const trip = observeFarmTrip(brain.farmTrip, snap.me, isTown(world, snap.me.map), brain.plan.hunt_map, Date.now(), moneyObjective);
    if (JSON.stringify(trip) !== JSON.stringify(brain.farmTrip)) { brain.farmTrip = trip; saveState(); }
  }
  // Combat preempts planning, equipment, services and travel; survival stays first in reflex.
  if (!snap.me.dead && (snap.attackers.length || snap.unseenAttackers)) {
    brain.fighting = true;
    const { action, drank } = await reflex(snap, { defendOnly: true, inTown: !!world && isTown(world, snap.me.map) });
    noteEscape(snap, action);
    if (drank) brain.drinks.push(Date.now());
    brain.counters.actions[action] = (brain.counters.actions[action] || 0) + 1;
    return;
  }
  // Map changes briefly expose empty equipment/inventory and arrival dialogs.
  // Let those settle before services can interrupt the current hunting trip.
  if (!snap.me.dead && (snap.mapAgeMs ?? Infinity) < 3000) return;
  if (snap.me.sitting && !snap.me.dead) { await act(page, 'stand'); return; }

  // Owner's +9 project owns its NPC/refine sequence, including intentional
  // equipment returns to Inventory. Restore-stripped-weapon logic resumes after it.
  if (!snap.me.dead && !weaponBlocked(snap.me) && !errand.active && !jobChange.active && !healer.active &&
      (gearUpgrade.active || (!travel.inDialog && !storage.active && snap.me.hp / snap.me.maxHp >= 0.9))) {
    if (await gearUpgrade.tick(snap)) {
      // Closing an arrival dialog while idle does not start a gear project.
      // Stopping here used to reset Warpra after every warp and send us back
      // to Morroc instead of continuing the already checked walking route.
      if (gearUpgrade.active && travel.dest) await travel.stop();
      return;
    }
  }

  const wornWeapon = snap.worn?.find(i => i.slot === 'weapon');
  if (wornWeapon) recoveringWeapon = false;
  if (!snap.me.dead && (weaponBlocked(snap.me) || recoveringWeapon || weapons.pending(snap))) {
    recoveringWeapon = true;
    if (travel.dest) await travel.stop();
    if (weaponBlocked(snap.me) || healer.active) {
      if (healer.active || healer.maybeStart(snap)) {
        const done = await healer.tick(snap);
        if (done?.cleansed) { triedWear.clear(); lastWearCheck = 0; }
      }
    } else {
      await wearBetterGear(snap);
    }
    return;
  }
  if (!errand.active && !jobChange.active && !brain.huntPending &&
      ['level', 'money'].includes(brain.plan.goal) && brain.plan.goal !== moneyObjective) {
    chooseHunt(snap, moneyObjective === 'money'
      ? (snap.me.zeny < currentMoneyTarget(snap).reserve ? 'เงินต่ำกว่าเงินสำรอง: หาเงิน' : 'หาเงินต่อจากรอบเดิมให้ถึงเป้าหมายสะสม')
      : 'เงินสำรองเพียงพอ: กลับไปเก็บเลเวลสู่ Class 4 เลเวล 255');
  }
  errand.observe(snap, brain.plan.goal); // usage rates of potions and wings, for balanced shopping
  const hp = snap.me.maxHp ? snap.me.hp / snap.me.maxHp : 1;
  const huntMap = brain.plan.hunt_map;
  // The live map is authoritative, including after restarting in the hunting ground.
  if (huntMap && snap.me.map === huntMap && travel.dest) await travel.stop();
  const away = !!huntMap && snap.me.map !== huntMap;

  // In town and hurt (e.g. just respawned): the Healer NPC is free, potions aren't.
  if (!travel.inDialog && !snap.me.dead && !snap.attackers.length && (healer.active || healer.maybeStart(snap))) {
    await healer.tick(snap);
    return;
  }

  if (!oresIn(snap).length && !travel.inDialog && !snap.me.dead && !snap.attackers.length && !errand.active && !storage.active && !jobChange.active && await itemReview.identify(snap)) return;
  // Wear only a current LAYA-reviewed upgrade, between fights.
  if (!travel.inDialog && !snap.me.dead && !snap.attackers.length && !errand.active && !storage.active) await wearBetterGear(snap);

  // Ores go to Kafra before the shop; other deposits still require review.
  if (!travel.inDialog && !snap.me.dead && !snap.attackers.length && !errand.active && !jobChange.active && (storage.active || storage.maybeStart(snap))) {
    const done = await storage.tick(snap);
    if (done?.stored) notify(`📦 ฝากไอเทมเข้า Kafra storage แล้ว ${done.stored} ชิ้น`, done.note, {}, 0x9c27b0);
    return;
  }

  // Survival first, wherever we are. On the way somewhere, only fight back — except monsters we
  // avoid (plants that shoot and stone us): fighting back held us a minute in range of Parasites
  // instead of taking the @go out, and the stone that followed was fatal. Keep travelling.
  const avoid = new Set(brain.plan.avoid_monsters || []);
  const onlyAvoided = away && snap.attackers.length > 0 && snap.attackers.every((g) => { const m = snap.monsters.find((x) => x.GID === g); return m && avoid.has(m.name); });
  // Leaving a map with @go at hand: the warp is the escape. Fighting back on the way kept us on
  // mjolnir_04 winging from pack to pack. Below 25% HP the emergency rules still take over.
  // Only when the next step really is the @go: walking away with a pack behind us is no escape.
  if (!brain.huntPending && away && travel.canGo && hp >= 0.25 && !snap.me.dead && snap.attackers.length && !onlyAvoided) {
    if (travel.dest !== huntMap) await travel.start(huntMap);
    // The route's first step is only known once travel has planned it: plan now, even mid-fight.
    if (travel.legKind === null) await travel.tick(snap);
    if (travel.legKind === 'go') {
      await travel.tick(snap);
      return;
    }
  }
  if (snap.me.dead || (snap.attackers.length && !(onlyAvoided && hp >= 0.4)) || (hp < 0.4 && stockHp(snap.inventory, snap.me) > 0 && !errand.active && !(world && isTown(world, snap.me.map)))) {
    const inTown = !!world && isTown(world, snap.me.map);
    const { action, drank } = await reflex(snap, { defendOnly: away || brain.huntPending, inTown });
    noteEscape(snap, action);
    brain.fighting = action === 'attack_monster' || action === 'keep_fighting';
    if (drank) brain.drinks.push(Date.now());
    brain.counters.actions[action] = (brain.counters.actions[action] || 0) + 1;
    return;
  }

  // Shopping trip: decided here from the bag (potions low and affordable, or too heavy), then
  // it runs until done and hunting picks up again (travel back to the hunt map is automatic).
  if (world && isTown(world, snap.me.map) && (snap.mapAgeMs ?? Infinity) < 3000) return;
  if (!travel.inDialog && !errand.active) {
    const started = errand.maybeStart(snap);
    if (started) {
      brain.farmTrip = abortFarmTravel(brain.farmTrip, 'กลับเติมเสบียง/ขายของก่อนถึงแมพล่า');
      saveState();
      if (travel.dest) await travel.stop();
      setPlan({ ...brain.plan, goal: started.goal, objective: started.why, reason: started.why }, snap);
    }
  }
  if (errand.active) {
    const done = await errand.tick(snap);
    if (done) endErrand(done, snap);
    return;
  }

  // Compare settled cash after town services, before departing for another hunt.
  if (Date.now() < (brain.profitSettleAfter || 0)) return;
  if (world && isTown(world, snap.me.map)) {
    const result = finishFarmTrip(brain.farmTrip, snap.me.zeny, Date.now(), snap.me);
    if (result) {
      brain.farmTrip = observeFarmTrip(null, snap.me, true, brain.plan.hunt_map, Date.now(), moneyObjective);
      brain.farmResults ||= {};
      for (const map of result.maps) brain.farmResults[map] = { ...result, level: snap.me.baseLevel };
      log(result.goal === 'level' || moneyObjective === 'level' ? 'level_efficiency' : 'farm_profit', result);
      saveState();
      if (result.routeFailure) {
        exclude(result.huntMap, result.routeFailure);
        if (brain.plan.hunt_map === result.huntMap && !brain.huntPending) {
          chooseHunt(snap, `${result.routeFailure}; เงินสุทธิ ${result.net} zeny: เลือกแมพใหม่`);
        }
        return;
      }
      if (result.goal === 'level' || moneyObjective === 'level') {
        chooseHunt(snap, 'จบรอบเก็บเลเวล: EXP เพิ่ม ' + (result.expPercent?.toFixed(2) ?? 'ไม่ทราบ') + '%; ' +
          (result.expPercentPerMinute?.toFixed(2) ?? 'ไม่ทราบ') + '%/นาที; ใช้เงินที่สังเกตได้ ' + result.observedSpend +
          ' zeny; ประเมิน EXP% เทียบเวลาและค่าใช้จ่ายเพื่อเลือกแมพต่อไป ไม่ตัดแมพเพราะขายของขาดทุน');
        return;
      }
      if (result.net <= 0) {
        brain.levelOffset = Math.max(-MAX_LEVEL_DROP, brain.levelOffset - LEVEL_DROP_PER_DEATH);
        for (const map of result.maps) exclude(map, 'กลับมาขายและเติมของแล้วเงินไม่เพิ่ม');
        chooseHunt(snap, 'รอบฟาร์มเงินไม่เพิ่ม (' + result.net + ' zeny): ลดระดับและเปลี่ยนแมพ');
        return;
      }
      chooseHunt(snap, 'จบรอบขายและเติมเสบียง: กำไรสุทธิ ' + result.net + ' zeny' +
        (result.zenyPerMinute !== null ? ' (' + result.zenyPerMinute + ' zeny/นาที)' : '') +
        ' ประเมินว่าจะฟาร์มแมพเดิมหรือย้ายเพื่อเพิ่มรายได้สุทธิต่อเวลา พร้อมระบุเหตุผล');
      return;
    }
  }

  // A failed sale must not send a character unable to attack back to the hunting ground.
  if (overweight) {
    if (travel.dest) await travel.stop();
    return;
  }

  // Job change: qualified for the next job on CLASS_PATH -> go to the Job Master.
  if (!travel.inDialog && !jobChange.active) {
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
    replan(snap, low ? 'ยาสำรองต่ำ: ระบบกำลังจัดการเติมยา คงแมพเดิมถ้ายังเหมาะ' : 'เติมยาแล้ว: ประเมินแผนเดิมต่อ');
  }

  // While choosing a map, service/survival work above remains available.
  // Do not start travelling or farm an arbitrary map on its behalf.
  if (brain.huntPending) {
    if (travel.dest) await travel.stop();
    if (!brain.planning && Date.now() - brain.lastPlanAt >= 10000) replan(snap, brain.huntWhy);
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
    const travelResult = await travel.tick(snap);
    if (travelResult === 'failed') {
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
    writeFileSync(STATE_FILE, JSON.stringify({ avoidExtra: [...brain.avoidExtra], avoidAtLevel: Object.fromEntries(brain.avoidAtLevel), levelOffset: brain.levelOffset, excluded: Object.fromEntries(brain.excluded), hardMaps: Object.fromEntries(brain.hardMaps), moneyMode: brain.moneyMode, farmTrip: brain.farmTrip, farmResults: brain.farmResults, restoreWeapon: brain.restoreWeapon, scoutDropped: [...brain.scoutDropped] }, null, 2));
  } catch (err) {
    log('state_save_error', { error: err.message });
  }
}

function loadState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    for (const [name, level] of Object.entries(s.avoidAtLevel || {})) brain.avoidAtLevel.set(name, Number(level));
    for (const name of s.avoidExtra || []) {
      // Legacy bans have no encounter level; do not turn them into permanent bans.
      if (!brain.avoidAtLevel.has(name)) brain.avoidAtLevel.set(name, 0);
      if (brain.avoidAtLevel.get(name) > 0) brain.avoidExtra.add(name);
    }
    brain.levelOffset = Number(s.levelOffset) || 0;
    for (const cmd of s.scoutDropped || []) brain.scoutDropped.add(cmd);
    for (const [map, h] of Object.entries(s.hardMaps || {})) brain.hardMaps.set(map, h);
    brain.moneyMode = s.moneyMode ?? false;
    brain.farmTrip = s.farmTrip || null;
    brain.farmResults = s.farmResults || {};
    brain.restoreWeapon = s.restoreWeapon || null;
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
      brain.avoidAtLevel.set(name, snap.me.baseLevel || 1);
      saveState();
      brain.plan.avoid_monsters = [...new Set([...(brain.plan.avoid_monsters || []), name])];
      brain.plan.target_monsters = (brain.plan.target_monsters || []).filter((n) => n !== name);
      log('avoid_monster', { name, why: `${ev.state} x${times.length}` });
      learn(`${name} ทำให้${STATE_TH[ev.state] || ev.state} บ่อย — อย่าตีและอย่าล่าแมพที่มีมันเยอะ (ต้องมีการ์ดกันสถานะก่อน)`, { level: snap.me.baseLevel });
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
  learn(`ตายที่ ${map}${killers.length ? ` โดน ${killers.join(', ')} รุม` : ''} (Base ${snap.me.baseLevel}, ระดับมอน ${brain.levelOffset})`, { level: snap.me.baseLevel });
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
    if (await reconnect(snap)) {
      await Bun.sleep(1000);
      lastTickEnd = Date.now();
      continue;
    }
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
    if (await emergencyReturn(snap)) {
      await Bun.sleep(100);
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

    if (!snap.me.dead && (snap.attackers.length || snap.unseenAttackers)) {
      await farmTick(snap);
      await Bun.sleep(Math.max(0, FIGHT_TICK_MS - (Date.now() - started)));
      lastTickEnd = Date.now();
      continue;
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

    sampleHuntResult(snap);
    refreshCombatMemory(snap);
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

clearInterval(emergencyTimer);
