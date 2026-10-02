import * as laya from './laya.js';
import { act, exploreTarget } from './browser.js';
import { log } from './logger.js';
import { pickBottle, POTION_GAP_MS } from './potions.js';
import { SPLASH_MIN } from './skills.js';

// Renewal/pre-renewal consumables. Unknown healing items fall back to item type 0 (HEALING).
const HP_ITEMS = [569, 501, 507, 502, 508, 503, 545, 504, 546, 547, 509, 512, 513, 515, 516];
const SP_ITEMS = [505, 510, 518, 526, 11502, 11503];
// Novice Fly Wing first, then existing Fly Wings (601). Only Novice Fly Wing may be bought.
// Use carried wings to find monsters. No Butterfly Wing to go to town — @go does that. Novice Butterfly Wing
// stays as a last-resort escape.
const FLY_WING = [23280, 12323, 601];
const BUTTERFLY_WING = [12324];

// Commands that put the character on a path. Re-sending them every tick makes it
// jitter in place, so each kind has its own minimum gap.
const MOVE_GAP_MS = { explore: 2500, pickup_item: 1200, retreat: 1500 };
const STUCK_MS = 20000;
const NORMAL_ATTACK_TRIAL_MS = 3000; // single target only; groups use damage skills immediately
const LAYA_MIN_CONFIDENCE = 0.35;
const LAYA_TIMEOUT_MS = 2000; // the loop waits on it: keep it short
const UNDER_ATTACK_POTION_PCT = 60; // drink at this while being hit
const MOB_ATTACKERS = 3; // this many on us and hurt -> escape
const SWARM_ATTACKERS = 5; // this many on us -> escape at any HP
const LOSING_TWO_HP_PCT = 50; // two on us and below this -> wing out
const LOSING_HP_PCT = 35; // anything on us and below this even with potions -> wing out
const REENGAGE_HP_PCT = 70; // don't start a new fight below this
const PACK_SIZE = 3; // a target with more than this many neighbours is a pack
const SP_DRINK_PCT = 50; // below this: drink SP potions up to REFILL_TO (no sitting for SP)
const REFILL_TO = 90; // once drinking starts, drink up to this (HP and SP) — owner: 90% is enough
const ATTACK_RESEND_MS = 3000;
// Between casts (global gap, cooldowns) wait for the next skill instead of swinging: a swing
// would need a step to cancel before every cast. Swing only to finish, or when skills stay out this long.
const SKILL_WAIT_MS = 2000;
const POTION_MEMORY_MS = 30000;
const KITE_GAP_MS = 600; // a new step this often while drinking under attack
const KITE_STEP = 3; // cells per step
const KITE_TURN = Math.PI / 4; // turn 45 degrees each step: a circle, not a straight run into walls
const PULL_TO = 3; // gather this many before a splash skill
const PULL_TO_NO_WING = 2;
const PULL_MAX_VISIBLE = 3; // nearby monsters; distant mobs do not count toward the pull
const PULL_MAX_DPS_SHARE = 0.015; // pull only while taking under 1.5% of max HP per second
const PULL_RANGE = 7;
const PULL_MIN_HP = 80;
const PULL_LEVEL_GAP = 10;
const PULL_HIT_TIMEOUT_MS = 4000;
const PULL_GROUP_TIMEOUT_MS = 2500;
const PULL_COOLDOWN_MS = 5000;
const NO_PROGRESS_MS = 10000;
const IGNORE_TARGET_MS = 2 * 60 * 1000;
const FIGHT_LONG_MS = 45000; // one monster taking longer than this is worth a look (incident)
const POTION_WATCH_MS = 20000; // this many drinks inside this window with HP not rising: incident
const POTION_WATCH_DRINKS = 8;
const POTION_ALERT_GAP_MS = 60000;
const APPROACH_RESEND_MS = 500; // re-aim the walk at a moving monster
const APPROACH_GIVE_UP_MS = 6000;
const RESPAWN_GAP_MS = 5000;
const NO_TARGET_FLY_MS = 15000;
// Owner's rule: on the hunting map, nothing in sight -> Novice Fly Wing straight away instead of
// walking far to look. Just long enough for monsters to show after landing.
const HUNT_MAP_FLY_MS = 2000;
const LOOT_MAX_WEIGHT_PCT = 85;

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 100);
const findItem = (inv, ids) => {
  for (const id of ids) {
    const it = inv.find((i) => i.ITID === id && i.count > 0);
    if (it) return it;
  }
  return null;
};
const hpItem = (inv) => findItem(inv, HP_ITEMS) || inv.find((i) => i.type === 0 && i.count > 0 && !SP_ITEMS.includes(i.ITID));
const countOf = (inv, ids) => inv.filter((i) => ids.includes(i.ITID)).reduce((s, i) => s + i.count, 0);

/**
 * The low-level brain. Each tick: build the allowed action set from code,
 * let LAYA pick one, execute it. Survival rules run before LAYA and win.
 */
/**
 * @param {{locate?: Function}} [scout] asks the server where monsters are (scout.js)
 * @param {ReturnType<import('./skills.js').createSkillBook>} [skills] buffs + damage skills
 */
export function createReflex(page, brain, scout = null, skills = null, hotkeys = null, world = null, readLive = null) {
  // Snapshot entities have no level; use the real world directory, conservatively
  // taking the highest level when several records share a name.
  const mobLevels = new Map();
  for (const m of world?.mobs?.values() || []) {
    mobLevels.set(m.name, Math.max(mobLevels.get(m.name) || 0, m.level || 0));
  }
  /** Use an item through its shortcut key when it's on the bar, else directly. */
  const useItem = async (item) => ((hotkeys && (await hotkeys.press('item', item.ITID))) || (item.index >= 0 ? act(page, 'use_item', { index: item.index }) : false));
  const mem = {
    attackGID: 0,
    normalFight: null, // {gid,map,at}: timer begins when normal attacks reach the target
    lastAttackAt: 0,
    lastCastAt: 0,
    seenPotion: {}, // kind -> { item, at }: the last potion stack seen, for bag reads mid-refresh
    lastKiteAt: 0,
    pull: null,
    pullUntil: 0,
    lastApproachAt: 0,
    approachSince: 0,
    meleeOn: false, // a normal attack is running: it holds the character and skills won't go out until we step
    lastPotionAt: 0,
    lastRespawnAt: 0,
    lastMoveAt: {},
    lastTargetSeenAt: Date.now(),
    lastPos: null,
    lastMovedAt: Date.now(),
    lastAction: '',
    defendOnly: false,
    refill: { hp: false, sp: false }, // once a potion rule fires, keep drinking to REFILL_TO
    lastSpPotionAt: 0,
    exploreGoal: null,
    visited: [], // recent explore goals, so we don't pace the same corner
    engage: null, // { GID, progressAt, dist, hp }: is the fight with the current target going anywhere?
    ignored: new Map(), // GID -> until: targets we couldn't get at
  };

  function wanted(snap) {
    const avoid = new Set(brain.plan.avoid_monsters || []);
    const prefer = new Set(brain.plan.target_monsters || []);
    // Something already hitting us is fought regardless of the avoid list.
    // Travelling: only answer what is already hitting us.
    if (mem.defendOnly) return snap.monsters.filter((m) => snap.attackers.includes(m.GID)).sort((a, b) => a.dist - b.dist);
    // On the chosen hunting map, only the monsters picked for our level (plus anything hitting us).
    const onHuntMap = brain.plan.hunt_map && brain.plan.hunt_map === snap.me.map && prefer.size > 0;
    const now = Date.now();
    const mobs = snap.monsters.filter(
      (m) => snap.attackers.includes(m.GID) || (m.dist <= 14 && !((mem.ignored.get(m.GID) || 0) > now) && !avoid.has(m.name) && (!onHuntMap || prefer.has(m.name))),
    );
    // Don't pull a pack: a monster with more than PACK_SIZE others around it is skipped
    // (unless it's already on us, or there's nothing else to fight).
    const crowd = (m) => snap.monsters.filter((o) => o.GID !== m.GID && Math.max(Math.abs(o.x - m.x), Math.abs(o.y - m.y)) <= 4).length;
    const open = mobs.filter((m) => snap.attackers.includes(m.GID) || crowd(m) <= PACK_SIZE);
    // Only packs in sight: don't walk into one (15 Karakasa/Hydra, 10 on us, dead). With nothing
    // to fight the wing rule moves us somewhere else.
    const pool = open;
    const rank = (m) => (snap.attackers.includes(m.GID) ? 0 : prefer.has(m.name) ? 1 : 2);
    return pool.sort((a, b) => rank(a) - rank(b) || a.dist - b.dist);
  }

  /**
   * Many bottles in a short time and HP still not going up: the potions aren't landing, or the
   * damage taken outruns them. Log it once a minute with what's hitting us, for a code fix.
   */
  function watchPotions(snap, v) {
    const now = Date.now();
    mem.drinks = (mem.drinks || []).filter((d) => now - d.t < POTION_WATCH_MS);
    mem.drinks.push({ t: now, hp: v.hp });
    if (mem.drinks.length < POTION_WATCH_DRINKS || now - (mem.potionAlertAt || 0) < POTION_ALERT_GAP_MS) return;
    const first = mem.drinks[0];
    if (v.hp > first.hp + 5) return;
    mem.potionAlertAt = now;
    log('potion_no_effect', {
      drinks: mem.drinks.length, secs: Math.round((now - first.t) / 1000), hpFrom: first.hp, hpTo: v.hp,
      maxHp: snap.me.maxHp, taken6s: snap.damageTaken6s ?? 0, attackers: snap.attackers.length,
      unseen: snap.unseenAttackers ?? 0, map: snap.me.map,
    });
  }

  /**
   * A target we neither get closer to nor hurt, and that isn't hitting us, for NO_PROGRESS_MS
   * (across water, up a cliff, stuck in a wall) is dropped for a while — it once held the
   * character for half a minute with not one skill going out.
   */
  function stillWorthIt(snap, current) {
    if (!current) {
      mem.engage = null;
      mem.normalFight = null;
      mem.meleeOn = false;
      return null;
    }
    const now = Date.now();
    const e = mem.engage;
    const dealt = snap.dealt?.[current.GID];
    if (!e || e.GID !== current.GID) {
      mem.engage = { GID: current.GID, name: current.name, start: now, progressAt: now, dist: current.dist, hp: current.hp, dmg: dealt?.dmg || 0, casts: 0, logged: false };
      return current;
    }
    // Monster HP bars are unknown (-1) on this server: what we dealt is the real "is it working".
    const hurt = (current.hp >= 0 && e.hp >= 0 && current.hp < e.hp) || (dealt?.dmg || 0) > e.dmg;
    // Standing next to it only counts where we can't see our damage; with damage known, ten
    // seconds adjacent without one point landing means the swings/skills aren't going in.
    const adjacent = current.dist <= 1.5 && !snap.dealt;
    if (current.dist < e.dist - 0.5 || hurt || adjacent || snap.attackers.includes(current.GID)) e.progressAt = now;
    e.dist = Math.min(e.dist, current.dist);
    e.hp = current.hp;
    e.dmg = Math.max(e.dmg, dealt?.dmg || 0);
    if (!e.logged && now - e.start > FIGHT_LONG_MS) {
      e.logged = true;
      log('fight_long', {
        name: current.name, secs: Math.round((now - e.start) / 1000), dist: current.dist, casts: e.casts,
        dealt: dealt?.dmg || 0, hits: dealt?.hits || 0, misses: dealt?.misses || 0,
        hitsUs: snap.attackers.includes(current.GID), attackers: snap.attackers.length, map: snap.me.map,
      });
    }
    if (now - e.progressAt <= NO_PROGRESS_MS) return current;
    mem.ignored.set(current.GID, now + IGNORE_TARGET_MS);
    for (const [gid, until] of mem.ignored) if (until < now) mem.ignored.delete(gid);
    log('target_unreachable', { name: current.name, dist: current.dist, secs: Math.round((now - e.progressAt + NO_PROGRESS_MS) / 1000) });
    mem.attackGID = 0;
    mem.engage = null;
    return null;
  }

  /**
   * The bag arrives in pieces after a map change: the first piece can lack the potions, and the
   * character once sat down "with no potions" holding 96 Orange Potions. A potion seen in the last
   * POTION_MEMORY_MS still counts (it's pressed by its hotkey, which the client resolves itself).
   */
  function remembered(kind, item) {
    const now = Date.now();
    if (item) {
      mem.seenPotion[kind] = { item, at: now };
      return item;
    }
    const last = mem.seenPotion[kind];
    if (last && now - last.at < POTION_MEMORY_MS) return last.item;
    // Still nothing: if an HP potion sits on the hotkey bar, press that — the client knows its
    // own bag even when our read of it is empty (fresh start after a restart, mid-warp).
    if (kind === 'hp' && hotkeys && hotkeys.slots) {
      for (const key of hotkeys.slots.values()) {
        const id = Number(String(key).replace(/^i:/, ''));
        if (String(key).startsWith('i:') && HP_ITEMS.includes(id)) {
          if (now - (mem.noPotionLoggedAt || 0) > 10000) {
            mem.noPotionLoggedAt = now;
            log('potion_unseen', { kind, using: 'hotkey', ITID: id });
          }
          return { ITID: id, index: -1, count: 1, fromHotkey: true };
        }
      }
    }
    if (kind === 'hp' && now - (mem.noPotionLoggedAt || 0) > 10000) {
      mem.noPotionLoggedAt = now;
      log('potion_unseen', { kind, using: 'none' });
    }
    return null;
  }

  function view(snap) {
    const { me, inventory: inv } = snap;
    // Judge the current fight first: a target dropped here must not be picked again this tick.
    // Stop chasing an unrelated target as soon as a visible attacker hits us.
    if (snap.attackers.length && !snap.attackers.includes(mem.attackGID) &&
        snap.monsters.some(m => snap.attackers.includes(m.GID))) {
      mem.attackGID = 0;
      mem.approachSince = 0;
      if (mem.pull) endPull('under attack');
    }
    const current = stillWorthIt(snap, snap.monsters.find((m) => m.GID === mem.attackGID) || null);
    const targets = wanted(snap);
    const weightPct = pct(me.weight, me.maxWeight);
    const lootable = snap.items.filter((i) => i.dist <= 10);
    if (targets.length || mem.defendOnly) mem.lastTargetSeenAt = Date.now();
    return {
      hp: pct(me.hp, me.maxHp),
      sp: pct(me.sp, me.maxSp),
      targets,
      current,
      weightPct,
      lootable: weightPct < LOOT_MAX_WEIGHT_PCT && brain.plan.loot !== false && !mem.defendOnly ? lootable : [],
      hpPotion: remembered('hp', hpItem(inv)),
      spPotion: remembered('sp', findItem(inv, SP_ITEMS)),
      fly: findItem(inv, FLY_WING),
      butterfly: findItem(inv, BUTTERFLY_WING),
      emptyFor: Date.now() - mem.lastTargetSeenAt,
    };
  }

  function buildActions(snap, v) {
    const attacked = snap.attackers.length > 0;
    const actions = {};
    if (v.current) actions.keep_fighting = `ตี ${v.current.name} ต่อ เพราะกำลังสู้อยู่และ HP ยังไหว`;
    else if (v.targets.length) actions.attack_monster = `โจมตี ${v.targets[0].name} ที่ห่าง ${v.targets[0].dist} ช่อง เมื่อ HP ยังปลอดภัย`;
    // Below 75% only: higher than that a potion is mostly overheal (the emergency rule covers real danger).
    if (v.hp < 75 && v.hpPotion) actions.use_hp_potion = `ดื่มยาฟื้น HP ตอนนี้ HP ${v.hp}%`;
    if (v.sp < 30 && v.spPotion) actions.use_sp_potion = `ดื่มยาฟื้น SP ตอนนี้ SP ${v.sp}%`;
    if (v.lootable.length && !attacked) actions.pickup_item = 'เดินไปเก็บของที่ดรอปอยู่บนพื้นใกล้ๆ เมื่อไม่มีมอนตีอยู่';
    if (attacked) actions.retreat = `ถอยหนีออกจากมอนที่รุมอยู่ ${snap.attackers.length} ตัว เมื่อ HP ต่ำหรือโดนรุมหนัก`;
    // Only to find monsters when there's nothing to fight. Never mid-fight: LAYA once winged away
    // from every half-dead monster. Real danger (mobbed, HP at the retreat line) is the emergency rule's.
    if (v.fly && !attacked && !v.current && !v.targets.length && !mem.defendOnly && brain.plan.fly_wing_when_empty !== false) {
      actions.fly_wing = 'ใช้ Fly Wing วาร์ปสุ่มในแมพ เพื่อหามอนใหม่เมื่อแถวนี้ไม่มีมอน';
    }
    if (!mem.defendOnly && !v.targets.length && !v.lootable.length && !attacked) actions.explore = 'เดินสำรวจหามอนเมื่อแถวนี้ไม่มีมอนให้ตี';
    actions.wait = 'รอดูสถานการณ์ ไม่ทำอะไร';
    return actions;
  }

  function layaState(snap, v) {
    return {
      goal: brain.plan.objective || 'เก็บเลเวลและหาเงิน',
      hp_percent: v.hp,
      sp_percent: v.sp,
      level: `${snap.me.baseLevel}/${snap.me.jobLevel}`,
      map: snap.me.map,
      current_target: v.current?.name || 'none',
      monsters_attacking_me: snap.attackers.length,
      damage_taken_last_6s: snap.damageTaken6s,
      nearest_monsters: v.targets.slice(0, 4).map((m) => `${m.name} (${m.dist})`).join(', ') || 'none',
      items_on_ground: v.lootable.length,
      hp_potions: v.hpPotion?.count ?? 0,
      fly_wings: countOf(snap.inventory, FLY_WING),
      weight_percent: v.weightPct,
    };
  }

  const refillHp = (why) => {
    mem.refill.hp = true;
    return ['use_hp_potion', why];
  };

  /** Priority 100: rules LAYA cannot overrule. Returns [action, why] or null. */
  function emergency(snap, v) {
    if (snap.me.dead) return ['respawn', 'dead'];
    const retreatAt = brain.plan.retreat_hp_pct ?? 25;
    const potionAt = Math.max(brain.plan.hp_potion_pct ?? 45, UNDER_ATTACK_POTION_PCT);
    // Hits from monsters we can't see (entity list empty after a warp) still count for danger.
    const attacked = snap.attackers.length + (snap.unseenAttackers || 0);
    const escape = (why) => {
      if (v.fly) return ['fly_wing', why];
      if (v.butterfly) return ['butterfly_wing', why];
      // No wing: running away while still being hit just dies tired. Drink first.
      if (v.hpPotion && v.hp < potionAt) return ['use_hp_potion', `${why}, no wing`];
      return ['retreat', why];
    };
    // Mobbed and already hurt: potions can't out-heal several monsters at once — leave.
    if (attacked >= MOB_ATTACKERS && v.hp < UNDER_ATTACK_POTION_PCT) return escape(`${attacked} attackers, hp ${v.hp}%`);
    // Swarmed: leave at once, whatever the HP — ten on us took the last 67% in a second.
    if (attacked >= SWARM_ATTACKERS && (v.fly || v.butterfly)) return escape(`${attacked} attackers: swarmed, wing out now`);
    // Owner's rule: a wing is also the way out of a fight that's going badly — land somewhere
    // quiet, drink up there, then come back to hunting. Only with a wing (running doesn't help).
    if (attacked >= 2 && v.hp < LOSING_TWO_HP_PCT && (v.fly || v.butterfly)) return escape(`${attacked} attackers, hp ${v.hp}%: wing out to a safe spot`);
    if (attacked && v.hp < LOSING_HP_PCT && (v.fly || v.butterfly)) return escape(`hp ${v.hp}% under attack, potions not keeping up: wing out`);
    // Owner's rule: a potion rule that fired keeps drinking until 95%, not one bottle at a time.
    if (mem.inTown && !attacked) mem.refill = { hp: false, sp: false }; // town: Healer/services, not sitting
    if (v.hp >= REFILL_TO || !v.hpPotion) mem.refill.hp = false;
    if (v.sp >= REFILL_TO || !v.spPotion) mem.refill.sp = false;
    if (mem.refill.hp) return ['use_hp_potion', `refill HP to ${REFILL_TO}%`];
    if (mem.refill.sp) return ['use_sp_potion', `refill SP to ${REFILL_TO}%`];
    // Under attack: drink early, not at the last moment.
    if (attacked && v.hp < potionAt && v.hpPotion) return refillHp(`attacked, hp<${potionAt}`);
    if (attacked && v.hp < retreatAt) return escape(`hp<${retreatAt}, no potion`);
    // Out of combat and low: never start a fight like this. Use a potion or let the service loop obtain supplies.
    if (!attacked && v.hp < REENGAGE_HP_PCT) {
      // Town services handle healing and supplies.
      if (mem.inTown) return ['wait', 'town services: sell loot and restock'];
      // No sitting: drink available supplies, otherwise wait for a supply trip.
      if (v.hpPotion) return refillHp(`hp<${REENGAGE_HP_PCT}, refill before the next fight`);
      return ['wait', `hp<${REENGAGE_HP_PCT}, no potions: need supplies`];
    }
    // SP: skills are the whole damage plan. Owner's rule: no sitting for SP (too slow) —
    // drink Blue Potions to 95% whenever SP runs low, in a fight or not (town aside).
    if (v.sp < SP_DRINK_PCT && v.spPotion && !mem.inTown) {
      mem.refill.sp = true;
      return ['use_sp_potion', `sp<${SP_DRINK_PCT}`];
    }
    // Nothing to fight: let a wing find more (at once on the hunting map, after a while elsewhere).
    const onHuntMap = !!brain.plan.hunt_map && brain.plan.hunt_map === snap.me.map && !mem.defendOnly;
    const emptyLimit = onHuntMap ? HUNT_MAP_FLY_MS : NO_TARGET_FLY_MS;
    if (v.fly && !v.current && !v.targets.length && !snap.attackers.length && !v.lootable.length && v.emptyFor > emptyLimit && brain.plan.fly_wing_when_empty !== false) {
      mem.lastTargetSeenAt = Date.now();
      return ['fly_wing', 'no monsters for a while'];
    }
    return null;
  }

  const movedRecently = (kind) => Date.now() - (mem.lastMoveAt[kind] || 0) < MOVE_GAP_MS[kind];
  const markMove = (kind) => (mem.lastMoveAt[kind] = Date.now());

  async function execute(name, snap, v) {
    const me = snap.me;
    switch (name) {
      case 'attack_monster': {
        const t = v.targets[0];
        if (me.sitting) await act(page, 'stand');
        mem.attackGID = t.GID;
        const used = await useSkill(snap, t, v);
        if (used === true || (used === false && skillDue(snap, t) && waitingForSkill())) return;
        mem.lastAttackAt = Date.now();
        mem.meleeOn = true;
        noteNormal(snap, t);
        return act(page, 'attack', { GID: t.GID });
      }
      case 'keep_fighting': {
        const used = await useSkill(snap, v.current, v);
        if (used === true) return;
        if (used === false && skillDue(snap, v.current) && waitingForSkill()) return;
        // The continuous attack is already running; re-send now and then in case the server dropped it
        // (a skill cast interrupts it, which is why useSkill resets lastAttackAt).
        if (Date.now() - mem.lastAttackAt < ATTACK_RESEND_MS) return;
        mem.lastAttackAt = Date.now();
        mem.meleeOn = true;
        noteNormal(snap, v.current);
        return act(page, 'attack', { GID: v.current.GID });
      }
      case 'use_hp_potion':
        // Owner's rule: keep moving in a circle while drinking, so melee monsters can't stand and hit.
        await kite(snap);
        // The HP bar lags the heal by a tick; don't chug three potions for one hit.
        if (Date.now() - mem.lastPotionAt < POTION_GAP_MS) return;
        mem.lastPotionAt = Date.now();
        mem.drank = true;
        watchPotions(snap, v);
        // The bottle that fits what's missing (no overheal waste); the biggest when it's an emergency.
        return useItem(pickBottle(snap.inventory, me, (brain.plan.retreat_hp_pct ?? 25) / 100) || v.hpPotion);
      case 'use_sp_potion':
        // Own clock: HP and SP potions don't wait for each other.
        if (Date.now() - mem.lastSpPotionAt < POTION_GAP_MS) return;
        mem.lastSpPotionAt = Date.now();
        mem.drank = true;
        return useItem(v.spPotion);
      case 'fly_wing':
      case 'butterfly_wing':
        mem.attackGID = 0;
        return useItem(name === 'fly_wing' ? v.fly : v.butterfly);
      case 'pickup_item': {
        const item = [...v.lootable].sort((a, b) => a.dist - b.dist)[0];
        if (item.dist <= 1.5) return act(page, 'pickup', { GID: item.GID });
        if (movedRecently('pickup_item')) return;
        markMove('pickup_item');
        mem.meleeOn = false;
        return act(page, 'walk_to', { x: item.x, y: item.y });
      }
      case 'retreat': {
        if (movedRecently('retreat')) return;
        markMove('retreat');
        mem.attackGID = 0;
        mem.meleeOn = false;
        const foes = snap.monsters.filter((m) => snap.attackers.includes(m.GID));
        const cx = foes.reduce((s, m) => s + m.x, 0) / (foes.length || 1);
        const cy = foes.reduce((s, m) => s + m.y, 0) / (foes.length || 1);
        const dx = Math.sign(me.x - cx) || 1;
        const dy = Math.sign(me.y - cy) || 1;
        // walk_to goes round walls, or to the reachable cell nearest the escape point.
        return act(page, 'walk_to', { x: me.x + dx * 10, y: me.y + dy * 10 });
      }
      case 'rest':
        return me.sitting ? act(page, 'stand') : undefined;
      case 'explore':
        mem.meleeOn = false;
        return explore(snap);
      case 'respawn':
        if (Date.now() - mem.lastRespawnAt < RESPAWN_GAP_MS) return;
        mem.lastRespawnAt = Date.now();
        mem.attackGID = 0;
        return act(page, 'respawn');
      case 'wait':
        return;
    }
  }

  /**
   * The splash count a splash skill is judged by. Owner's rule (to save money on Blue Potions):
   * Cart Revolution only with 2+ monsters in its splash; a lone one gets normal hits.
   */
  const splashFor = (snap, target) => splashAround(snap, target);

  /** Monsters in a target's 3x3 (itself included): what a splash skill like Cart Revolution hits. */
  const splashAround = (snap, target) => snap.monsters.filter((m) => Math.max(Math.abs(m.x - target.x), Math.abs(m.y - target.y)) <= 1).length;

  // A low level alone is not proof that a pack is safe: require observed damage,
  // project it onto the whole group with a 2x margin, and keep survival rules first.
  function pullSafe(snap, v, members, limit) {
    if (!skills || mem.defendOnly || mem.inTown || v.hp < PULL_MIN_HP || !hpItem(snap.inventory || []) || snap.unseenAttackers) return false;
    const near = snap.monsters.filter((m) => m.dist <= PULL_RANGE || snap.attackers.includes(m.GID));
    if (near.length > PULL_MAX_VISIBLE || snap.attackers.length > limit) return false;
    const avoid = new Set(brain.plan.avoid_monsters || []);
    const easy = (m) => {
      const level = mobLevels.get(m.name) || m.level;
      return Number.isFinite(level) && level > 0 && snap.me.baseLevel - level >= PULL_LEVEL_GAP
        && !avoid.has(m.name) && !skills.book?.bosses?.has(m.name);
    };
    if (![...near, ...members].every(easy)) return false;
    if (brain.hardMaps?.has(snap.me.map)) return false;
    const projected = (snap.damageTaken6s || 0) / 6 / Math.max(1, snap.attackers.length) * limit * 2;
    if (!snap.attackers.length || !(projected > 0) || projected > snap.me.maxHp * PULL_MAX_DPS_SHARE) return false;
    if (snap.me.hp - projected * 10 < snap.me.maxHp * 0.6) return false;
    return (snap.me.skills || []).some((s) => SPLASH_MIN[s.name] && s.level > 0 && s.sp <= (snap.me.sp || 0)
      && !snap.me.cooldowns?.[s.id] && (skills.book?.blockedUntil?.[s.id] || 0) <= Date.now());
  }

  function endPull(reason) {
    if (mem.pull) log('pull_end', { reason, tagged: mem.pull.ids.size });
    mem.pull = null;
    mem.pullUntil = Date.now() + PULL_COOLDOWN_MS;
  }

  /** Tag each target once, waiting for damage confirmation before switching. */
  async function maybePull(snap, v) {
    const now = Date.now();
    let p = mem.pull;
    const limit = p?.limit || (v.fly || v.butterfly ? PULL_TO : PULL_TO_NO_WING);
    const current = v.current || v.targets[0];
    const candidates = v.targets.filter((m) => m.dist <= PULL_RANGE && m.hp !== 0);
    if (!p) {
      if (now < mem.pullUntil || !current || splashAround(snap, current) >= 2) return false;
      // Establish that a normal attack actually landed on the first monster.
      if (!(snap.dealt?.[current.GID]?.dmg > 0) || !snap.attackers.includes(current.GID)) return false;
      if (!candidates.some((m) => m.GID !== current.GID && !snap.attackers.includes(m.GID))) return false;
      if (!pullSafe(snap, v, candidates, limit)) return false;
      p = mem.pull = { map: snap.me.map, x: snap.me.x, y: snap.me.y, limit,
        ids: new Set([current.GID, ...snap.attackers]), pending: null, gatherAt: 0, startedAt: now };
    }
    const members = snap.monsters.filter((m) => p.ids.has(m.GID));
    if (p.map !== snap.me.map || Math.max(Math.abs(snap.me.x - p.x), Math.abs(snap.me.y - p.y)) > 15
      || now - p.startedAt > 12000 || !pullSafe(snap, v, members, limit)) {
      endPull('conditions changed');
      return false;
    }
    for (const gid of snap.attackers) p.ids.add(gid);
    if (p.pending) {
      const t = snap.monsters.find((m) => m.GID === p.pending.GID);
      const hit = !t || (snap.dealt?.[t.GID]?.dmg || 0) > p.pending.damage
        || (!snap.dealt && t.hp >= 0 && p.pending.hp >= 0 && t.hp < p.pending.hp);
      if (!hit && now - p.pending.at < PULL_HIT_TIMEOUT_MS) return true;
      if (!hit) {
        mem.ignored.set(t.GID, now + IGNORE_TARGET_MS);
        endPull('tag did not land');
        await stepOne(snap, 'cancel failed pull');
        mem.attackGID = 0;
        return true;
      }
      log('pull_hit', { GID: p.pending.GID });
      p.pending = null;
    }
    const other = p.ids.size < limit ? candidates.find((m) => !p.ids.has(m.GID) && !snap.attackers.includes(m.GID)) : null;
    if (other) {
      if (!pullSafe(snap, v, [...members, other], limit)) { endPull('unsafe next target'); return false; }
      p.ids.add(other.GID);
      p.pending = { GID: other.GID, hp: other.hp, damage: snap.dealt?.[other.GID]?.dmg || 0, at: now };
      mem.attackGID = other.GID;
      mem.lastAttackAt = now;
      mem.meleeOn = true;
      log('pull', { name: other.name, dist: other.dist, tagged: p.ids.size, limit, levelGap: snap.me.baseLevel - (mobLevels.get(other.name) || other.level) });
      await act(page, 'attack', { GID: other.GID });
      return true;
    }
    // Stop the last normal attack after its first confirmed hit, let them close,
    // then aim at the member whose splash actually contains the most monsters.
    if (mem.meleeOn) { await stepOne(snap, 'tag confirmed; gather for splash'); return true; }
    const target = members.sort((a, b) => splashAround(snap, b) - splashAround(snap, a))[0];
    if (target && splashAround(snap, target) >= 2) {
      mem.attackGID = target.GID;
      await useSkill(snap, target, v);
      return true;
    }
    p.gatherAt ||= now;
    if (now - p.gatherAt < PULL_GROUP_TIMEOUT_MS) return true;
    endPull('group did not close');
    return false;
  }

  /**
   * One step of a circle around the spot we're drinking at, on the side away from whoever's on us:
   * melee monsters have to chase instead of hitting. Only with something attacking us.
   */
  async function kite(snap) {
    if (!snap.attackers.length || Date.now() - mem.lastKiteAt < KITE_GAP_MS) return;
    mem.lastKiteAt = Date.now();
    const me = snap.me;
    const foes = snap.monsters.filter((m) => snap.attackers.includes(m.GID));
    const cx = foes.length ? foes.reduce((n, m) => n + m.x, 0) / foes.length : me.x;
    const cy = foes.length ? foes.reduce((n, m) => n + m.y, 0) / foes.length : me.y;
    // Away from them, turned a bit further each step so the path bends round instead of running straight.
    mem.kiteTurn = ((mem.kiteTurn || 0) + KITE_TURN) % (2 * Math.PI);
    const away = Math.atan2(me.y - cy, me.x - cx) + mem.kiteTurn;
    const x = Math.round(me.x + Math.cos(away) * KITE_STEP);
    const y = Math.round(me.y + Math.sin(away) * KITE_STEP);
    mem.meleeOn = false;
    await act(page, 'walk_to', { x, y });
  }

  const waitingForSkill = () => Date.now() - mem.lastCastAt < SKILL_WAIT_MS;

  /** One cell aside: cancels a running normal attack / unsticks a cast. */
  async function stepOne(snap, why) {
    const me = snap.me;
    await act(page, 'walk_to', { x: me.x + (Math.random() < 0.5 ? 1 : -1), y: me.y, step: 1 });
    mem.lastAttackAt = 0;
    mem.meleeOn = false;
    log('unstick_step', { why });
  }

  /**
   * Groups skip the normal-attack trial; single targets keep their three-second trial.
   */
  function skillDue(snap, target) {
    if (!target) return false;
    if (snap.attackers.length + (snap.unseenAttackers || 0) >= 2 || splashFor(snap, target) >= 2) return true;
    const fight = mem.normalFight;
    if (!fight || fight.gid !== target.GID || fight.map !== snap.me.map) return false;
    if (fight.at == null && (target.dist <= (snap.me.attackRange || 2) || snap.dealt?.[target.GID]?.dmg > 0)) fight.at = Date.now();
    return fight.at != null && Date.now() - fight.at >= NORMAL_ATTACK_TRIAL_MS;
  }

  function noteNormal(snap, target) {
    if (!mem.normalFight || mem.normalFight.gid !== target.GID || mem.normalFight.map !== snap.me.map) {
      mem.normalFight = { gid: target.GID, map: snap.me.map, at: target.dist <= (snap.me.attackRange || 2) ? Date.now() : null };
    }
  }

  async function useSkill(snap, target, v = null) {
    if (!skills || !skillDue(snap, target)) return false;
    skills.ensurePlan(snap);
    // Owner's rule: a skill that wouldn't go out (stuck, flinching) -> take one step, then cast again.
    if (skills.book?.needStep) {
      skills.book.needStep = false;
      await stepOne(snap, 'skill failed');
      return true;
    }
    const crowd = snap.monsters.filter((m) => Math.max(Math.abs(m.x - target.x), Math.abs(m.y - target.y)) <= 3).length;
    // Prioritize damage immediately for groups, or after the single-target trial.
    const cast = skills.pickAttack(snap, target, crowd, splashFor(snap, target, v), false, true);
    if (!cast) return false;
    if (cast.approach) {
      // Walk into skill range rather than start a swing. Can't get there for a while (walls,
      // a monster that keeps backing off): fall back to the normal attack's own pathing.
      mem.approachSince ||= Date.now();
      if (Date.now() - mem.approachSince > APPROACH_GIVE_UP_MS) return false;
      if (Date.now() - mem.lastApproachAt >= APPROACH_RESEND_MS) {
        mem.lastApproachAt = Date.now();
        mem.meleeOn = false;
        await act(page, 'walk_to', { x: target.x, y: target.y });
      }
      return true;
    }
    mem.approachSince = 0;
    // Owner's rule: a normal attack we started (a finishing hit, or no skill was ready) keeps the
    // character swinging and the skill won't go out — step one cell to cancel it, cast next tick.
    if (mem.meleeOn) {
      await stepOne(snap, `cancel normal attack before ${cast.name}`);
      return true;
    }
    // Self-cast (buffs, self-centred AoE): press its shortcut key. Skills aimed at a monster
    // still go out directly — a key press would wait for a click on the target.
    const self = cast.x === undefined && cast.targetID === snap.me.GID;
    const pressed = self && hotkeys && (await hotkeys.press('skill', cast.id));
    if (!pressed) await act(page, 'skill', { SKID: cast.id, level: cast.level, targetID: cast.targetID, x: cast.x, y: cast.y });
    skills.noteCast(cast);
    if (mem.pull && SPLASH_MIN[cast.name]) endPull('splash cast');
    mem.lastAttackAt = 0;
    mem.lastCastAt = Date.now();
    if (mem.engage && mem.engage.GID === target.GID) mem.engage.casts++;
    log('cast', { skill: cast.name, level: cast.level, target: target.name, crowd });
    return true;
  }

  /**
   * Head for somewhere monsters should be: where the server says they are
   * (@where), else a random cell we can actually reach that we haven't just
   * visited. Each step is a BFS waypoint, so walls are walked round.
   */
  async function explore(snap) {
    const me = snap.me;
    const goal = mem.exploreGoal;
    if (goal && Math.max(Math.abs(me.x - goal.x), Math.abs(me.y - goal.y)) <= 3) mem.exploreGoal = null;
    if (Date.now() - mem.lastMovedAt > STUCK_MS / 2) mem.exploreGoal = null; // this way is blocked, pick another
    if (me.walking || movedRecently('explore')) return;
    markMove('explore');
    if (me.sitting) await act(page, 'stand');

    if (!mem.exploreGoal) {
      const names = brain.plan.target_monsters || [];
      const spots = scout && brain.plan.hunt_map === me.map ? await scout.locate(snap, names) : [];
      const next = spots[0] || (await exploreTarget(page, 10, 35, mem.visited));
      if (!next) return;
      mem.exploreGoal = { x: next.x, y: next.y, why: spots[0] ? `@where ${spots[0].name}` : 'random reachable' };
      mem.visited.push([next.x, next.y]);
      if (mem.visited.length > 6) mem.visited.shift();
      log('explore_goal', mem.exploreGoal);
    }
    const wp = await act(page, 'walk_to', { x: mem.exploreGoal.x, y: mem.exploreGoal.y });
    if (!wp) mem.exploreGoal = null; // no way there at all
  }

  /** Stuck = we keep choosing to walk but the position hasn't changed for a while. */
  function trackStuck(snap, name) {
    const pos = `${snap.me.x},${snap.me.y}`;
    const walking = name === 'explore' || name === 'pickup_item';
    // Standing still while fighting, drinking or waiting isn't being stuck: only time spent
    // trying to walk counts (otherwise a long fight followed by one explore reads as "stuck").
    if (pos !== mem.lastPos || !walking) {
      mem.lastPos = pos;
      mem.lastMovedAt = Date.now();
      return false;
    }
    // Explore already re-routes after STUCK_MS/2; still not moving after twice that is a real dead end.
    return (name === 'explore' || name === 'pickup_item') && Date.now() - mem.lastMovedAt > STUCK_MS * 2;
  }

  /** @param {{defendOnly?: boolean}} opts defendOnly while travelling: fight back, nothing else. */
  return async function tick(snap, { defendOnly = false, inTown = false } = {}) {
    mem.defendOnly = defendOnly;
    mem.inTown = inTown;
    const v = view(snap);
    const actions = buildActions(snap, v);
    let name;
    let source = 'rule';
    let why = '';
    let confidence = 1;

    const rule = emergency(snap, v);
    if (!rule && skills && !inTown && !defendOnly && !snap.me.dead && !snap.attackers.length && !v.current && v.sp >= SP_DRINK_PCT) {
      skills.ensurePlan(snap);
      const buff = skills.pickBuff(snap) || skills.pickToggle?.(snap);
      if (buff) {
        if (mem.meleeOn) await stepOne(snap, 'cancel attack before buff');
        else {
          if (snap.me.sitting) await act(page, 'stand');
          const pressed = hotkeys && await hotkeys.press('skill', buff.id);
          if (!pressed) await act(page, 'skill', {SKID:buff.id,level:buff.level,targetID:snap.me.GID});
          skills.noteCast(buff);
          log('buff', {skill:buff.name,level:buff.level});
        }
        return {action:'buff',stuck:false,drank:false};
      }
    }
    if (rule) {
      if (mem.pull) endPull('survival rule');
      [name, why] = rule;
    } else if (Object.keys(actions).length === 1) {
      name = 'wait';
    } else if (actions.keep_fighting && !snap.attackers.some((g) => g !== mem.attackGID) && v.hp >= 60) {
      // Plain 1v1 with healthy HP: nothing to weigh, skip the round trip.
      name = 'keep_fighting';
      why = 'safe 1v1';
    } else if (snap.attackers.length && (actions.keep_fighting || actions.attack_monster)) {
      // In a fight, never wait on LAYA: a slow answer (seconds) froze the loop while three Baby
      // Leopards took HP from 87% to 10% with no potion and no escape. The emergency rules above
      // run every tick; here the obvious move is to keep hitting.
      name = actions.keep_fighting ? 'keep_fighting' : 'attack_monster';
      why = 'in a fight: rules only';
    } else if (snap.unseenAttackers) {
      name = 'wait';
      why = 'attacker not visible yet';
    } else if (actions.explore && !v.targets.length && !snap.attackers.length && v.hp >= 60) {
      // Nothing here and nothing hurting us: standing still won't bring monsters.
      name = 'explore';
      why = 'nothing in sight';
    } else {
      try {
        const pending = laya.choose(
          layaState(snap, v),
          'You control a Ragnarok Online character. Choose the safest and most useful next action for the current goal.',
          actions,
          { timeoutMs: LAYA_TIMEOUT_MS },
        );
        // Poll only while a slow decision is pending; late answers cannot issue actions.
        const settled = pending.then(answer => ({ answer }), error => ({ error }));
        let result;
        for (;;) {
          let timer;
          result = readLive ? await Promise.race([settled, new Promise(resolve => {
            timer = setTimeout(() => resolve(null), 120);
          })]) : await settled;
          clearTimeout(timer);
          if (result) break;
          const live = await readLive();
          if (!live?.inGame || live.me?.map !== snap.me.map) return { action: 'wait', stuck: false, drank: false };
          if (live.me.dead || live.attackers.length || live.unseenAttackers) {
            return tick(live, { defendOnly: true, inTown });
          }
        }
        if (result.error) throw result.error;
        const answer = result.answer;
        name = answer.choice;
        confidence = answer.confidence ?? 0;
        source = 'laya';
        // A coin-flip answer isn't a decision: fall back to the obvious move.
        if (confidence < LAYA_MIN_CONFIDENCE) {
          name = actions.keep_fighting ? 'keep_fighting' : actions.attack_monster ? 'attack_monster' : actions.explore ? 'explore' : name;
          source = 'laya-unsure';
        }
      } catch (err) {
        log('laya_error', { error: err.message });
        name = actions.keep_fighting ? 'keep_fighting' : actions.attack_monster ? 'attack_monster' : 'wait';
        source = 'fallback';
      }
      if (!actions[name]) name = 'wait';
    }

    if (name !== mem.lastAction || name === 'attack_monster') {
      log('action', {
        action: name, source, why, confidence: Math.round(confidence * 100) / 100,
        hp: v.hp, sp: v.sp, map: snap.me.map, target: v.current?.name ?? v.targets[0]?.name,
        // Enough context to tell from one log line why it chose what it chose.
        attackers: snap.attackers.length, monsters: snap.monsters.length, options: Object.keys(actions).join('/'),
      });
    }
    if (mem.pull && name !== 'attack_monster' && name !== 'keep_fighting') endPull('non-combat action');
    mem.lastAction = name;
    mem.drank = false;
    await execute(name, snap, v);
    // drank: a bottle actually went down this tick (the action repeats while the potion gap runs)
    return { action: name, stuck: trackStuck(snap, name), drank: mem.drank };
  };
}
