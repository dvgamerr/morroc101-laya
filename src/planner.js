import * as llm from './llm.js';
import { log } from './logger.js';
import { PLANNER_SYSTEM } from './prompts.js';
import { GOAL_KEYS, jobInfo, nextJob, jobChangeReady } from './goals.js';
import { jobReference } from './job-reference.js';
import { stockHp, stockSp } from './potions.js';
import { recentLessons } from './lessons.js';

export { GOAL_KEYS };

export const DEFAULT_PLAN = {
  goal: 'level',
  objective: 'เก็บเลเวลกับมอนแถวนี้ เก็บของขายเป็นเงิน',
  hunt_map: null,
  target_monsters: [],
  avoid_monsters: [],
  hp_potion_pct: 45,
  retreat_hp_pct: 25,
  loot: true,
  fly_wing_when_empty: true,
  todo: [],
};

function summarize(snap, why, recent, ctx) {
  const me = snap.me;
  const candidates = [...ctx.candidates].sort((a,b) => a.map.localeCompare(b.map));
  return [
    'เหตุ: ' + why,
    'goal: ' + (ctx.goal || 'level'),
    'Base ' + me.baseLevel + ' | อาชีพ ' + jobInfo(me.jobId).name +
      ' | HP ' + me.hp + '/' + me.maxHp + ' SP ' + me.sp + '/' + me.maxSp +
      ' | zeny ' + me.zeny,
    'current_map (ตำแหน่งจริงตอนนี้): ' + me.map + ' (' + me.x + ',' + me.y + ')' +
      (ctx.inTown ? ' เมือง' : '') +
      (candidates.some(c => c.map === me.map) ? ' — เลือกล่าต่อที่นี่ได้' : ' — ไม่อยู่ในตัวเลือก'),
    'ยาสำรอง: HP รวม ' + Math.round(stockHp(snap.inventory, me)) + ' / SP รวม ' + Math.round(stockSp(snap.inventory)),
    'อุปกรณ์: ' + snap.inventory.filter(i => i.equipped).map(i => i.name).join(', '),
    'ผลล่าสุด: ' + recent,
    'บทเรียน (เป็นประวัติ ไม่ใช่รายการแมพที่อนุญาต):',
    ...recentLessons(8, me.baseLevel),
    'ข้อมูลตัวเลือก: map | จำนวนเปลี่ยนแมพ | มอน | อันตราย',
    ...candidates.map(c => c.map + ' | ' + c.hops + ' | ' +
      c.targets.map(t => t.name + ': Lv=' + t.level + ' count=' + t.count + ' HP=' + (t.hp ?? '?') + ' EXP=' + (t.baseExp ?? '?')).join(', ') +
      ' | ' + (c.avoid.join(', ') || '-') +
      (ctx.goal === 'money' ? ' | drops=' + JSON.stringify(c.targets.map(t => ({mob:t.name,knownZenyPerKill:t.drops?.knownZenyPerKill,unknownPrices:t.drops?.unknownPrices,items:t.drops?.items.map(d => ({id:d.id,name:d.name,chancePct:d.rate/100,sellPrice:d.sellPrice}))}))) : '')),
    'ยืนยัน current_map=' + me.map + '; Base=' + me.baseLevel + '; goal=' + ctx.goal + '; แมพอื่นต้องเดินทาง ห้ามอ้างว่าอยู่แล้ว',
    'allowed_maps: ' + JSON.stringify(candidates.map(c => c.map)),
  ].join('\n');
}

/**
 * High-level brain. Slow and occasional: every few minutes or on a notable event.
 * ctx.candidates are hunting grounds computed from real spawn data (world.js);
 * the planner may choose among them but not invent a map.
 */
export async function plan(snap, why, recent, current, ctx = { candidates: [], inTown: false, signals: [] }) {
  const messages = [
    { role: 'system', content: PLANNER_SYSTEM },
    { role: 'user', content: summarize(snap, why, recent, ctx) },
  ];
  const invalidReason = (p) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return 'invalid_or_incomplete_json';
    if (!ctx.candidates.some(c => c.map === p.hunt_map)) return 'map_not_in_candidates';
    if (p.current_map !== snap.me.map) return 'incorrect_current_map';
    if ((!Array.isArray(p.target_monsters) || !p.target_monsters.length ||
        !p.target_monsters.every(name => ctx.candidates.find(c => c.map === p.hunt_map).targets.some(t => t.name === name)))) return 'invalid_target_monsters';
    if (typeof p.reason !== 'string' || !p.reason.trim()) return 'missing_reason';
    return null;
  };
  let completion = {};
  const onCompletion = (info) => { completion = info; };
  const reportInvalid = (parsed, text, attempt) => log('planner_bad_json', {
    attempt, cause: invalidReason(parsed), map: parsed?.hunt_map,
    ...completion, chars: text.length, tail: text.slice(-200),
  });
  let text = await llm.chat(messages, { maxTokens: 2048, temperature: 0.3, json: true, onCompletion });
  let parsed = llm.parseJson(text);
  if (invalidReason(parsed)) {
    reportInvalid(parsed, text, 1);
    completion = {};
    text = await llm.chat([...messages, { role: 'user', content:
      'คำตอบก่อนหน้าใช้ไม่ได้: ' + invalidReason(parsed) +
      '; hunt_map ที่ตอบ = ' + JSON.stringify(parsed?.hunt_map ?? null) +
      '; allowed_maps = ' + JSON.stringify(ctx.candidates.map(c => c.map).sort()) +
      '. เลือกใหม่จาก allowed_maps เท่านั้น ตอบ JSON: {current_map, hunt_map, goal, target_monsters, reason} เหตุผลสั้นๆ ห้ามเลือกแมพนอกนี้แม้เคยอยู่ในแผนเก่า'
    }], { maxTokens: 2048, temperature: 0.1, json: true, onCompletion });
    parsed = llm.parseJson(text);
  }
  if (invalidReason(parsed)) {
    reportInvalid(parsed, text, 2);
    throw new Error('Plan rejected: ' + invalidReason(parsed) + '; no automatic map selection');
  }
  const next = { ...sanitize(parsed, ctx.candidates), signals: (ctx.signals || []).map((s) => s.text) };
  if (ctx.goal === 'money' || ctx.goal === 'level') {
    next.goal = ctx.goal;
    next.objective = ctx.goal === 'money' ? 'หาเงินจากดรอปโดยเสีย HP และค่ายาน้อย' : 'เก็บเลเวลกับมอนในช่วง Base-10 ถึง Base-1';
  }
  if (next.goal === 'job_change') {
    const ref = jobReference(jobInfo(snap.me.jobId).name, nextJob(snap.me));
    const ready = ref && jobChangeReady(snap.me) && snap.me.skillPoints === 0;
    next.goal = ready ? 'job_change' : 'level';
    next.objective = ready ? `ไปตรวจเงื่อนไขกับ Job Master: ${ref.from} → ${ref.to}` : 'เก็บเลเวลและเตรียมเงื่อนไขเปลี่ยนอาชีพตาม reference';
    next.reason = ref ? `${ref.from} → ${ref.to}: Base ${ref.base}/Job ${ref.job}; NPC ต้องยืนยันเงื่อนไขเซิร์ฟ` : 'ไม่มี reference สำหรับเส้นทางนี้';
    next.todo = []; // Do not execute or preserve invented job-change instructions.
  }
  log('plan', { why, suggested_goal: next.goal, objective: next.objective, hunt_map: next.hunt_map, reason: next.reason, plan: next });
  return next;
}

/** Plan straight from the best candidate, for when there is no time (or no LLM) to ask. */
export function planFromCandidate(c) {
  if (!c) return { ...DEFAULT_PLAN };
  return sanitize({ objective: `ไปล่า ${c.targets.map((t) => t.name).join(', ')} ที่ ${c.map}`, hunt_map: c.map }, [c]);
}

// A 9B model's JSON is usually right but not always typed right; never let it
// switch off survival (e.g. retreat at 0%), crash the reflex with a string list,
// or send the character to a map that isn't a computed hunting ground.
export function sanitize(p, candidates = []) {
  const list = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : []);
  const num = (x, lo, hi, fallback) => (Number.isFinite(Number(x)) ? Math.min(hi, Math.max(lo, Number(x))) : fallback);
  const hunt = candidates.find((c) => c.map === p.hunt_map) || null;
  const onMap = new Set(hunt ? hunt.targets.map((t) => t.name) : []);
  const targets = list(p.target_monsters).filter((n) => hunt && onMap.has(n));
  return {
    goal: GOAL_KEYS.includes(p.goal) ? p.goal : 'level',
    objective: typeof p.objective === 'string' && p.objective ? p.objective : DEFAULT_PLAN.objective,
    reason: typeof p.reason === 'string' ? p.reason : '',
    hunt_map: hunt ? hunt.map : null,
    target_monsters: targets.length || !hunt ? targets : hunt.targets.map((t) => t.name),
    avoid_monsters: [...new Set([...list(p.avoid_monsters), ...(hunt ? hunt.avoid : [])])],
    hp_potion_pct: num(p.hp_potion_pct, 20, 80, DEFAULT_PLAN.hp_potion_pct),
    retreat_hp_pct: num(p.retreat_hp_pct, 15, 50, DEFAULT_PLAN.retreat_hp_pct),
    loot: p.loot !== false,
    fly_wing_when_empty: p.fly_wing_when_empty !== false,
    todo: list(p.todo),
  };
}
