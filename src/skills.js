import * as llm from './llm.js';
import { log } from './logger.js';
import { jobInfo } from './goals.js';
import { config } from './config.js';
import { zenyReserve } from './goals.js';

// Skills that cost zeny per use (Mammonite: 100 x level). Only spent above the reserve.
const ZENY_COST = { MC_MAMMONITE: (lv) => lv * 100 };
// Owner's rule: skills that burn zeny are for bosses and mini-bosses only — Mammonite on every
// Goblin ate the whole purse. On ordinary monsters the next skill (or a normal hit) is used.
export const BOSS_ONLY = new Set(['MC_MAMMONITE']);
// On/off toggles: casting again switches them OFF, and they drain SP while on.
// Never treated as buffs to "refresh".
export const TOGGLES = new Set(['BS_MAXIMIZE', 'LK_BERSERK', 'CR_DEFENDER', 'TF_HIDING', 'AS_CLOAKING', 'ST_CHASEWALK', 'NC_HOVERING', 'SM_AUTOBERSERK']);

// Left out of the skill plan (fallback and the LLM's list): Greed picks up loot around us and
// this server has autoloot. Not in the plan = never cast; no separate rule needed.
export const NOT_PLANNED = new Set(['BS_GREED']);
const planned = (s) => !NOT_PLANNED.has(s.name) && s.label !== 'Greed';

// Splash skills worth their SP only on a group: how many monsters must stand in the splash
// (the target's 3x3) before casting. Owner's rule: gather 2-3 first, then Cart Revolution.
export const SPLASH_MIN = { MC_CARTREVOLUTION: 2 };

// Toggles the owner wants ON while fighting -> the status (EFST index) that shows it's on.
// Pressed only when that status is absent; pressing while on would switch it off.
export const TOGGLE_ON = { BS_MAXIMIZE: 26 }; // EFST_MAXIMIZE (Adrenaline 23, Weapon Perfection 24, Power Thrust 25)
const TOGGLE_GAP_MS = 5000; // let the status packet arrive before judging (a double press = off again)

// ZC_SKILLINFO target kinds (bit flags).
export const INF = { ENEMY: 1, GROUND: 2, SELF: 4, ALLY: 16 };

// Spam skills: the only gap we impose is against sending two casts in one breath; the
// real limit is the server's own cooldown (ZC_SKILL_POSTDELAY -> me.cooldowns).
const GLOBAL_GAP_MS = 150;
// A failed cast backs off 1s, doubling while it keeps failing (no cart, no Madogear, ...)
// up to 30s; quiet for 30s and the count starts over.
const FAIL_BACKOFF_MS = 1000;
const FAIL_BACKOFF_MAX_MS = 30000;
const FAIL_FORGET_MS = 30000;
const BUFF_REFRESH_MS = 90000; // recast a buff whose status we never saw, this often
// Owner's rule: press a buff once and wait for it to run out. Never sooner than this after a cast,
// whatever the status bookkeeping says (a wrong status mapping once had Power Thrust pressed 4x/s).
const BUFF_MIN_GAP_MS = 15000;
const BUFF_MIN_DURATION_MS = 5000; // a status counts as "the buff's" only if it has a real timer
const BUFF_VERIFY_MS = 3000; // the mapped status must show up this soon after a cast
const BUFF_LEARN_WINDOW_MS = 2000;

// Well-known self buffs worth keeping up while farming, for the no-LLM fallback.
const KNOWN_BUFFS = new Set([
  'SM_ENDURE', 'KN_TWOHANDQUICKEN', 'KN_ONEHAND', 'CR_SPEARQUICKEN', 'LK_AURABLADE', 'LK_CONCENTRATION', 'RK_ENCHANTBLADE',
  'AC_CONCENTRATION', 'SN_SIGHT', 'SN_WINDWALK', 'AL_BLESSING', 'AL_INCAGI', 'AL_ANGELUS', 'PR_MAGNIFICAT', 'PR_GLORIA',
  'MC_LOUD', 'BS_ADRENALINE', 'BS_WEAPONPERFECT', 'BS_OVERTHRUST', 'WS_OVERTHRUSTMAX', 'MO_EXPLOSIONSPIRITS',
  'AS_ENCHANTPOISON', 'MG_ENERGYCOAT', 'CR_AUTOGUARD', 'TK_RUN', 'GS_GATLINGFEVER', 'NJ_NEN', 'SR_GENTLETOUCH_REVITALIZE',
]);

// Skills that do nothing for a fighting axe build — shops, crafting, loot pick-up. Never put a
// point in them while anything else can be raised (the LLM plan once led with MC_VENDING).
export const NO_POINTS = new Set([
  'MC_VENDING', 'MC_IDENTIFY', 'MC_CHANGECART', 'BS_GREED', 'BS_FINDINGORE', 'BS_REPAIRWEAPON',
  'BS_IRON', 'BS_STEEL', 'BS_ENCHANTEDSTONE', 'BS_ORIDEOCON', 'BS_DAGGER', 'BS_SWORD', 'BS_TWOHANDSWORD',
  'BS_AXE', 'BS_MACE', 'BS_KNUCKLE', 'BS_SPEAR', 'WS_CREATECOIN', 'WS_CREATENUGGET', 'WS_SYSTEMCREATE',
]);

// Skill-point order for the owner's path (Merchant -> Blacksmith -> Whitesmith -> Mechanic ->
// Meister, two-handed axe) when the LLM can't be asked: [name, target level].
const UPGRADE_FALLBACK = [
  ['NV_BASIC', 9],
  ['MC_INCCARRY', 3], ['MC_DISCOUNT', 3], ['MC_PUSHCART', 5], ['MC_MAMMONITE', 10], ['MC_OVERCHARGE', 5], ['MC_INCCARRY', 10],
  ['BS_AXEMASTERY', 10], ['BS_HILTBINDING', 1], ['BS_ADRENALINE', 5], ['BS_WEAPONPERFECT', 5], ['BS_OVERTHRUST', 5], ['BS_SKINTEMPER', 5],
  ['WS_MELTDOWN', 10], ['WS_OVERTHRUSTMAX', 5], ['WS_CARTBOOST', 5], ['WS_CARTTERMINATION', 10],
  ['NC_TRAININGAXE', 10], ['NC_AXEBOOMERANG', 5], ['NC_POWERSWING', 10], ['NC_AXETORNADO', 5],
  ['MT_TWOAXEDEF', 10], ['MT_AXE_STOMP', 5], ['MT_RUSH_QUAKE', 10],
];

/**
 * The character's skills, ordered for farming: which buffs to keep up, and which
 * attack skills hit hardest. The order comes from the LLM (it knows RO skills by
 * name) and is redone only when the skill list changes; it can only name skills
 * the character really has. Without the LLM, attack skills are ranked by SP cost
 * (costlier ~ stronger) and buffs come from a known list.
 */
export function createSkillBook() {
  const book = {
    signature: '',
    bosses: new Set(), // monster names that count as boss / mini-boss (from the world data)
    attack: [], // skill ids, strongest first
    aoe: [], // ground/self-area attack ids, used when monsters bunch up
    buffs: [], // skill ids to keep up
    planning: false,
    lastCastAt: 0,
    blockedUntil: {}, // id -> ms (failures)
    fails: {}, // id -> { count, at }
    lastBuffAt: {}, // id -> ms
    buffStatus: {}, // id -> EFST index, learned
    pendingBuff: null, // { id, at }
    lastToggleAt: {}, // id -> ms
  };

  const signatureOf = (skills) => skills.map((s) => `${s.id}:${s.level}`).sort().join(',');
  const up = { signature: '', order: UPGRADE_FALLBACK, planning: false };

  /** Re-plan the skill-point order when the tree changes (a job change brings new skills). */
  function ensureUpgradePlan(snap) {
    const tree = snap.me.skillTree || [];
    const sig = [jobInfo(snap.me.jobId).name, ...tree.map((s) => s.id).sort()].join(',');
    if (sig === up.signature || up.planning || !tree.length) return;
    up.signature = sig;
    up.planning = true;
    const list = tree.map((s) => `${s.name}${showLabel(s)} lv${s.level}${s.upgradable ? ' (can raise now)' : ''}`).join('\n');
    llm
      .chat(
        [
          {
            role: 'system',
            content:
              'You are an expert Ragnarok Online (Renewal) player. Plan where skill points go for this build, levelling as fast as possible. ' +
              'Use only skill names from the list. Answer JSON only: {"order": [["SKILL_NAME", targetLevel], ...]} highest priority first; ' +
              'include prerequisites before the skills that need them.',
          },
          { role: 'user', content: `Build: ${config.buildDescription}\nJob: ${jobInfo(snap.me.jobId).name}\nSkill tree:\n${list}` },
        ],
        { maxTokens: 500, temperature: 0.2, json: true },
      )
      .then((text) => {
        const p = llm.parseJson(text);
        // The LLM may answer with either name; keep the name the tree uses.
        const resolve = byAnyName(tree);
        const order = (Array.isArray(p?.order) ? p.order : [])
          .filter((r) => Array.isArray(r) && resolve(r[0]) && Number(r[1]) > 0)
          .map((r) => [resolve(r[0]).name, Number(r[1])]);
        if (order.length) {
          // The fallback stays behind the LLM order, so nothing learnable is ever left unspent.
          up.order = [...order, ...UPGRADE_FALLBACK];
          log('skill_upgrade_plan', { order: order.map((r) => r.join(':')).join(', ') });
        }
      })
      .catch((err) => log('skill_upgrade_plan_error', { error: err.message }))
      .finally(() => (up.planning = false));
  }

  /** The skill a point should go into now, or null. */
  function pickUpgrade(snap) {
    if (!((snap.me.skillPoints || 0) > 0)) return null;
    ensureUpgradePlan(snap);
    const tree = snap.me.skillTree || [];
    for (const [name, target] of up.order) {
      if (NO_POINTS.has(name)) continue;
      const s = tree.find((k) => k.name === name);
      if (s && s.upgradable && s.level < target) return s;
    }
    // Anything still raisable: points left unspent block job changes. Useless ones only as the very last resort.
    return tree.find((k) => k.upgradable && !NO_POINTS.has(k.name)) || tree.find((k) => k.upgradable) || null;
  }

  function fallbackPlan(skills) {
    const attack = skills
      .filter((s) => s.inf & INF.ENEMY && s.sp > 0)
      .sort((a, b) => b.sp - a.sp || b.level - a.level)
      .map((s) => s.id);
    const buffs = skills.filter((s) => KNOWN_BUFFS.has(s.name) && s.inf & (INF.SELF | INF.ALLY)).map((s) => s.id);
    return { attack, aoe: [], buffs };
  }

  /** Re-plan when the skill list changed. Fallback applies at once; the LLM refines it. */
  function ensurePlan(snap) {
    const skills = (snap.me.skills || []).filter(planned);
    const sig = signatureOf(skills);
    if (sig === book.signature) return;
    book.signature = sig;
    Object.assign(book, fallbackPlan(skills));
    log('skills_fallback', { attack: names(skills, book.attack), buffs: names(skills, book.buffs) });
    if (!skills.length || book.planning) return;
    book.planning = true;
    planWithLlm(snap, skills)
      .then((plan) => {
        if (!plan || sig !== book.signature) return;
        Object.assign(book, plan);
        log('skills_plan', { attack: names(skills, book.attack), aoe: names(skills, book.aoe), buffs: names(skills, book.buffs) });
      })
      .catch((err) => log('skills_plan_error', { error: err.message }))
      .finally(() => (book.planning = false));
  }

  async function planWithLlm(snap, skills) {
    const job = jobInfo(snap.me.jobId);
    const kind = (s) => [s.inf & INF.ENEMY && 'enemy', s.inf & INF.GROUND && 'ground', s.inf & INF.SELF && 'self', s.inf & INF.ALLY && 'ally'].filter(Boolean).join('/') || 'passive';
    const list = skills.map((s) => `${s.name}${showLabel(s)} lv${s.level} sp${s.sp} range${s.range} [${kind(s)}]`).join('\n');
    const text = await llm.chat(
      [
        {
          role: 'system',
          content:
            'You are an expert Ragnarok Online (Renewal) player. Given a character\'s learned skills, plan a farming rotation that levels up as fast as possible. ' +
            'Use only skill names from the list. Passive skills cannot be cast. Answer JSON only: ' +
            '{"attack": [single-target damage skills, highest damage per SP first], "aoe": [area damage skills for groups], "buffs": [self buffs that raise damage/attack speed/survival, worth keeping up while farming]}',
        },
        { role: 'user', content: `Build: ${config.buildDescription}\nJob: ${job.name}, Base ${snap.me.baseLevel}, Job ${snap.me.jobLevel}, stats ${JSON.stringify(snap.me.stats || {})}\nSkills:\n${list}` },
      ],
      { maxTokens: 400, temperature: 0.2, json: true },
    );
    const p = llm.parseJson(text);
    if (!p) return null;
    return sanitizeSkillPlan(p, skills);
  }

  /**
   * A buff to cast now, if one is down: the status it gives is gone (learned), or
   * we never saw its status and it's been a while.
   */
  function pickBuff(snap) {
    const me = snap.me;
    const now = Date.now();
    if (now - book.lastCastAt < GLOBAL_GAP_MS) return null;
    for (const id of book.buffs) {
      const s = (me.skills || []).find((k) => k.id === id);
      if (!s || !usable(s, me, now)) continue;
      const since = now - (book.lastBuffAt[id] || 0);
      if (since < BUFF_MIN_GAP_MS) continue; // just cast: it's up (or the server refused) — don't spam
      const efst = book.buffStatus[id];
      // A mapping that didn't show its status after the last cast was wrong: forget it.
      if (efst !== undefined && book.lastBuffAt[id] && since < BUFF_MIN_GAP_MS + BUFF_VERIFY_MS && !(efst in (me.status || {}))) {
        delete book.buffStatus[id];
        log('buff_unlearned', { skill: id, status: efst });
      }
      const mapped = book.buffStatus[id];
      const active = mapped !== undefined ? mapped in (me.status || {}) : since < BUFF_REFRESH_MS;
      if (!active) return { id: s.id, level: s.level, targetID: me.GID, name: s.name };
    }
    return null;
  }

  /** A wanted toggle (Maximize Power) that is OFF: switch it on. Never pressed while its status shows. */
  function pickToggle(snap) {
    const me = snap.me;
    const now = Date.now();
    if (now - book.lastCastAt < GLOBAL_GAP_MS) return null;
    for (const s of me.skills || []) {
      const efst = TOGGLE_ON[s.name];
      if (efst === undefined || efst in (me.status || {})) continue;
      if (now - (book.lastToggleAt[s.id] || 0) < TOGGLE_GAP_MS || !usable(s, me, now)) continue;
      return { id: s.id, level: s.level, targetID: me.GID, name: s.name, toggle: true };
    }
    return null;
  }

  /** The hardest-hitting attack skill usable on `target` right now; {approach} if it's ready but out of reach; null for a normal attack. */
  function pickAttack(snap, target, crowd = 1, splash = 1, areaOnly = false) {
    const me = snap.me;
    const now = Date.now();
    if (!target || now - book.lastCastAt < GLOBAL_GAP_MS) return null;
    // Owner's rule: skills always, as long as the SP is there (buffs are picked before this anyway).
    const order = crowd >= 3 ? [...book.aoe, ...book.attack] : book.attack;
    let tooFar = null;
    for (const id of order) {
      const s = (me.skills || []).find((k) => k.id === id);
      if (!s || !usable(s, me, now)) continue;
      if (areaOnly && !SPLASH_MIN[s.name] && !book.aoe.includes(id)) continue;
      if ((SPLASH_MIN[s.name] || 0) > splash) continue; // not enough of them bunched up yet
      if (BOSS_ONLY.has(s.name) && !book.bosses.has(target.name)) continue;
      const range = Math.max(1, s.range || 1);
      if (target.dist > range + 0.5 && !(s.inf & INF.SELF)) {
        tooFar ??= { approach: true, name: s.name, range };
        continue;
      }
      if (s.inf & INF.SELF && !(s.inf & INF.ENEMY) && target.dist > 2) continue; // self-centred AoE: only when close
      if (s.inf & INF.GROUND && !(s.inf & INF.ENEMY)) return { id: s.id, level: s.level, x: target.x, y: target.y, name: s.name };
      return { id: s.id, level: s.level, targetID: s.inf & INF.ENEMY ? target.GID : me.GID, name: s.name };
    }
    // A skill is ready but the target is out of its reach: walk up (a normal attack to close in
    // would start swinging, and that has to be cancelled with a step before the cast).
    return tooFar;
  }

  function usable(s, me, now) {
    if (s.sp > (me.sp ?? 0)) return false;
    const zeny = ZENY_COST[s.name];
    if (zeny && (me.zeny ?? 0) - zeny(s.level) < zenyReserve(me.baseLevel)) return false;
    if ((me.cooldowns || {})[s.id]) return false;
    return (book.blockedUntil[s.id] || 0) <= now;
  }

  function noteCast(cast) {
    const now = Date.now();
    book.lastCastAt = now;
    if (cast.toggle) book.lastToggleAt[cast.id] = now;
    if (book.buffs.includes(cast.id)) {
      book.lastBuffAt[cast.id] = now;
      if (book.buffStatus[cast.id] === undefined) book.pendingBuff = { id: cast.id, at: now };
    }
  }

  /** Learn from packets: failed casts back off; a status appearing right after a buff is that buff's. */
  function onEvent(ev) {
    const now = Date.now();
    if (ev.type === 'skill_fail') {
      const prev = book.fails[ev.SKID];
      const count = prev && now - prev.at < FAIL_FORGET_MS ? prev.count + 1 : 1;
      book.fails[ev.SKID] = { count, at: now };
      book.blockedUntil[ev.SKID] = now + Math.min(FAIL_BACKOFF_MS * 2 ** (count - 1), FAIL_BACKOFF_MAX_MS);
      book.needStep = true; // the reflex steps one cell before the next cast
      if (book.pendingBuff?.id === ev.SKID) book.pendingBuff = null;
    } else if (ev.type === 'status' && ev.on && (ev.remain || 0) >= BUFF_MIN_DURATION_MS && book.pendingBuff && now - book.pendingBuff.at < BUFF_LEARN_WINDOW_MS) {
      // Only a status that just appeared with a real timer can be the buff's (permanent or
      // timer-less statuses that happen to flip at the same moment were learned by mistake).
      const owner = Object.entries(book.buffStatus).find(([, idx]) => idx === ev.index);
      if (!owner) {
        book.buffStatus[book.pendingBuff.id] = ev.index;
        log('buff_learned', { skill: book.pendingBuff.id, status: ev.index });
      }
      book.pendingBuff = null;
    }
  }

  const setBosses = (names) => (book.bosses = new Set(names));
  return { ensurePlan, pickBuff, pickToggle, pickAttack, noteCast, onEvent, pickUpgrade, setBosses, book };
}

/** " (Display Name)" when the client gave a display label that differs from the name. */
const showLabel = (s) => (s.label && s.label !== s.name ? ` (${s.label})` : '');

/** Find a skill by aegis name or display label, ignoring case, spaces and punctuation. */
function byAnyName(skills) {
  const key = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9ก-๙]/g, '');
  const map = new Map();
  for (const s of skills) {
    if (s.label) map.set(key(s.label), s);
    if (s.name) map.set(key(s.name), s);
  }
  return (n) => map.get(key(n)) || null;
}

function names(skills, ids) {
  return ids.map((id) => skills.find((s) => s.id === id)?.name || id).join(', ');
}

/** Only skills the character has, castable, each in one list. */
export function sanitizeSkillPlan(p, skills) {
  const resolve = byAnyName(skills);
  const pick = (list, ok) => {
    const out = [];
    for (const n of Array.isArray(list) ? list : []) {
      const s = resolve(n);
      if (s && ok(s) && !out.includes(s.id)) out.push(s.id);
    }
    return out;
  };
  const attack = pick(p.attack, (s) => s.inf & INF.ENEMY);
  const aoe = pick(p.aoe, (s) => s.inf & (INF.ENEMY | INF.GROUND | INF.SELF)).filter((id) => !attack.includes(id));
  const buffs = pick(p.buffs, (s) => s.inf & (INF.SELF | INF.ALLY) && !TOGGLES.has(s.name)).filter((id) => !aoe.includes(id));
  return { attack, aoe, buffs };
}
