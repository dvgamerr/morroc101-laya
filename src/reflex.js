import * as laya from './laya.js';
import { act } from './browser.js';
import { log } from './logger.js';

// Renewal/pre-renewal consumables. Unknown healing items fall back to item type 0 (HEALING).
const HP_ITEMS = [569, 501, 507, 502, 508, 503, 545, 504, 546, 547, 509, 512, 513, 515, 516];
const SP_ITEMS = [505, 510, 11502, 11503];
const FLY_WING = [601, 12323];
const BUTTERFLY_WING = [602, 12324];

// Commands that put the character on a path. Re-sending them every tick makes it
// jitter in place, so each kind has its own minimum gap.
const MOVE_GAP_MS = { explore: 2500, pickup_item: 1200, retreat: 1500 };
const ATTACK_RESEND_MS = 3000;
const POTION_GAP_MS = 800;
const RESPAWN_GAP_MS = 5000;
const NO_TARGET_FLY_MS = 15000;
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
export function createReflex(page, brain) {
  const mem = {
    attackGID: 0,
    lastAttackAt: 0,
    lastPotionAt: 0,
    lastRespawnAt: 0,
    lastMoveAt: {},
    lastTargetSeenAt: Date.now(),
    lastPos: null,
    lastMovedAt: Date.now(),
    lastAction: '',
    defendOnly: false,
  };

  function wanted(snap) {
    const avoid = new Set(brain.plan.avoid_monsters || []);
    const prefer = new Set(brain.plan.target_monsters || []);
    // Something already hitting us is fought regardless of the avoid list.
    // Travelling: only answer what is already hitting us.
    if (mem.defendOnly) return snap.monsters.filter((m) => snap.attackers.includes(m.GID)).sort((a, b) => a.dist - b.dist);
    const mobs = snap.monsters.filter((m) => m.dist <= 14 && (!avoid.has(m.name) || snap.attackers.includes(m.GID)));
    const rank = (m) => (snap.attackers.includes(m.GID) ? 0 : prefer.has(m.name) ? 1 : 2);
    return mobs.sort((a, b) => rank(a) - rank(b) || a.dist - b.dist);
  }

  function view(snap) {
    const { me, inventory: inv } = snap;
    const targets = wanted(snap);
    const current = snap.monsters.find((m) => m.GID === mem.attackGID) || null;
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
      hpPotion: hpItem(inv),
      spPotion: findItem(inv, SP_ITEMS),
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
    if (v.hp < 95 && v.hpPotion) actions.use_hp_potion = `ดื่มยาฟื้น HP ตอนนี้ HP ${v.hp}%`;
    if (v.sp < 30 && v.spPotion) actions.use_sp_potion = `ดื่มยาฟื้น SP ตอนนี้ SP ${v.sp}%`;
    if (v.lootable.length && !attacked) actions.pickup_item = 'เดินไปเก็บของที่ดรอปอยู่บนพื้นใกล้ๆ เมื่อไม่มีมอนตีอยู่';
    if (attacked) actions.retreat = `ถอยหนีออกจากมอนที่รุมอยู่ ${snap.attackers.length} ตัว เมื่อ HP ต่ำหรือโดนรุมหนัก`;
    if (v.fly && (attacked || (!mem.defendOnly && brain.plan.fly_wing_when_empty !== false && !v.targets.length))) {
      actions.fly_wing = 'ใช้ Fly Wing วาร์ปสุ่มในแมพ เพื่อหนีอันตราย หรือหามอนใหม่เมื่อแถวนี้ไม่มีมอน';
    }
    if (!attacked && (v.hp < 60 || v.sp < 40) && !v.targets.some((t) => t.dist < 5)) actions.rest = 'นั่งพักฟื้น HP/SP เมื่อปลอดภัยไม่มีมอนใกล้';
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

  /** Priority 100: rules LAYA cannot overrule. Returns [action, why] or null. */
  function emergency(snap, v) {
    if (snap.me.dead) return ['respawn', 'dead'];
    const retreatAt = brain.plan.retreat_hp_pct ?? 25;
    const potionAt = brain.plan.hp_potion_pct ?? 45;
    if (v.hp < potionAt && v.hpPotion) return ['use_hp_potion', `hp<${potionAt}`];
    if (v.hp < retreatAt && snap.attackers.length) {
      if (v.fly) return ['fly_wing', `hp<${retreatAt} no potion`];
      if (v.butterfly) return ['butterfly_wing', `hp<${retreatAt} no potion/fly`];
      return ['retreat', `hp<${retreatAt} nothing to escape with`];
    }
    // Nothing to fight for a while and no way to find more by walking: let a wing do it.
    if (v.fly && !v.targets.length && !snap.attackers.length && v.emptyFor > NO_TARGET_FLY_MS && brain.plan.fly_wing_when_empty !== false) {
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
        mem.lastAttackAt = Date.now();
        return act(page, 'attack', { GID: t.GID });
      }
      case 'keep_fighting':
        // The continuous attack is already running; re-send now and then in case the server dropped it.
        if (Date.now() - mem.lastAttackAt < ATTACK_RESEND_MS) return;
        mem.lastAttackAt = Date.now();
        return act(page, 'attack', { GID: v.current.GID });
      case 'use_hp_potion':
        // The HP bar lags the heal by a tick; don't chug three potions for one hit.
        if (Date.now() - mem.lastPotionAt < POTION_GAP_MS) return;
        mem.lastPotionAt = Date.now();
        return act(page, 'use_item', { index: v.hpPotion.index });
      case 'use_sp_potion':
        if (Date.now() - mem.lastPotionAt < POTION_GAP_MS) return;
        mem.lastPotionAt = Date.now();
        return act(page, 'use_item', { index: v.spPotion.index });
      case 'fly_wing':
      case 'butterfly_wing':
        mem.attackGID = 0;
        return act(page, 'use_item', { index: (name === 'fly_wing' ? v.fly : v.butterfly).index });
      case 'pickup_item': {
        const item = [...v.lootable].sort((a, b) => a.dist - b.dist)[0];
        if (item.dist <= 1.5) return act(page, 'pickup', { GID: item.GID });
        if (movedRecently('pickup_item')) return;
        markMove('pickup_item');
        return act(page, 'walk_to', { x: item.x, y: item.y });
      }
      case 'retreat': {
        if (movedRecently('retreat')) return;
        markMove('retreat');
        mem.attackGID = 0;
        const foes = snap.monsters.filter((m) => snap.attackers.includes(m.GID));
        const cx = foes.reduce((s, m) => s + m.x, 0) / (foes.length || 1);
        const cy = foes.reduce((s, m) => s + m.y, 0) / (foes.length || 1);
        const dx = Math.sign(me.x - cx) || 1;
        const dy = Math.sign(me.y - cy) || 1;
        // walk_to goes round walls, or to the reachable cell nearest the escape point.
        return act(page, 'walk_to', { x: me.x + dx * 10, y: me.y + dy * 10 });
      }
      case 'rest':
        return me.sitting ? undefined : act(page, 'sit');
      case 'explore': {
        if (me.walking || movedRecently('explore')) return;
        markMove('explore');
        if (me.sitting) await act(page, 'stand');
        // rAthena drops walk requests whose path exceeds 17 cells, so keep legs short.
        const angle = Math.random() * Math.PI * 2;
        const r = 7 + Math.random() * 6;
        return act(page, 'move', { x: Math.round(me.x + Math.cos(angle) * r), y: Math.round(me.y + Math.sin(angle) * r) });
      }
      case 'respawn':
        if (Date.now() - mem.lastRespawnAt < RESPAWN_GAP_MS) return;
        mem.lastRespawnAt = Date.now();
        mem.attackGID = 0;
        return act(page, 'respawn');
      case 'wait':
        return;
    }
  }

  /** Stuck = we keep choosing to walk but the position hasn't changed for a while. */
  function trackStuck(snap, name) {
    const pos = `${snap.me.x},${snap.me.y}`;
    if (pos !== mem.lastPos) {
      mem.lastPos = pos;
      mem.lastMovedAt = Date.now();
      return false;
    }
    return (name === 'explore' || name === 'pickup_item') && Date.now() - mem.lastMovedAt > 20000;
  }

  /** @param {{defendOnly?: boolean}} opts defendOnly while travelling: fight back, nothing else. */
  return async function tick(snap, { defendOnly = false } = {}) {
    mem.defendOnly = defendOnly;
    const v = view(snap);
    const actions = buildActions(snap, v);
    let name;
    let source = 'rule';
    let why = '';
    let confidence = 1;

    const rule = emergency(snap, v);
    if (rule) {
      [name, why] = rule;
    } else if (Object.keys(actions).length === 1) {
      name = 'wait';
    } else if (actions.keep_fighting && !snap.attackers.some((g) => g !== mem.attackGID) && v.hp >= 60) {
      // Plain 1v1 with healthy HP: nothing to weigh, skip the round trip.
      name = 'keep_fighting';
      why = 'safe 1v1';
    } else {
      try {
        const answer = await laya.choose(
          layaState(snap, v),
          'You control a Ragnarok Online character. Choose the safest and most useful next action for the current goal.',
          actions,
        );
        name = answer.choice;
        confidence = answer.confidence ?? 0;
        source = 'laya';
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
      });
    }
    mem.lastAction = name;
    await execute(name, snap, v);
    return { action: name, stuck: trackStuck(snap, name) };
  };
}
