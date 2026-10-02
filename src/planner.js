import * as llm from './llm.js';
import { log } from './logger.js';
import { PLANNER_SYSTEM } from './prompts.js';
import { GOAL_KEYS, jobInfo, nextJob, jobChangeReady } from './goals.js';
import { jobReference, jobReferenceContext } from './job-reference.js';
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
  const monsters = Object.entries(
    snap.monsters.reduce((acc, m) => ((acc[m.name] = (acc[m.name] || 0) + 1), acc), {}),
  ).map(([n, c]) => `${n} x${c}`);
  const consumables = snap.inventory
    .filter((i) => i.type === 0 || i.type === 2 || i.type === 11)
    .map((i) => `${i.name} x${i.count}`);
  const candidates = ctx.candidates.map((c, i) => {
    const mobs = c.targets.map((t) => `${t.name} lv${t.level} x${t.count}`).join(', ');
    const avoid = c.avoid.length ? ` | อันตราย: ${c.avoid.join(', ')}` : '';
    const route = c.warp ? ` | ${c.warp.npc}@${c.warp.town}: ${c.warp.path.join(' > ')}` : '';
    return `${i + 1}. ${c.map} (h${c.hops}) มอน: ${mobs}${avoid}${route}`;
  });
  return [
    `เหตุที่เรียก planner: ${why}`,
    `ตัวละคร: ${me.name} อาชีพ ${jobInfo(me.jobId).name} Base ${me.baseLevel} (${me.baseExp ?? '?'}/${me.baseExpNext ?? '?'}) Job ${me.jobLevel}`,
    jobReferenceContext(me, jobInfo(me.jobId).name, nextJob(me), { details: !!jobChangeReady(me) || (ctx.signals || []).some((s) => s.goal === 'job_change') }),
    `Stat: ${JSON.stringify(me.stats || {})} | สกิล: ${(me.skills || []).map((s) => `${s.name}${s.level}`).join(', ') || '-'}`,
    `HP ${me.hp}/${me.maxHp} SP ${me.sp}/${me.maxSp} Zeny ${me.zeny} น้ำหนัก ${me.weight}/${me.maxWeight}`,
    `Status point เหลือ ${me.statusPoints ?? '?'} Skill point เหลือ ${me.skillPoints ?? '?'}`,
    `แมพ ${me.map} (${me.x},${me.y})${ctx.inTown ? ' — เป็นเมือง ไม่มีมอน' : ''}`,
    `มอนที่เห็น: ${monsters.join(', ') || 'ไม่มี'}`,
    `ของใช้ในกระเป๋า: ${consumables.join(', ') || 'ไม่มี'}`,
    `อุปกรณ์ที่ใส่: ${snap.inventory.filter((i) => i.equipped).map((i) => i.name).join(', ') || '-'}`,
    `สรุปช่วงที่ผ่านมา: ${recent}`,
    `สัญญาณจากระบบ: ${(ctx.signals || []).map((s) => `[${s.goal}] ${s.text}`).join(' | ') || 'ไม่มี'}`,
    '',
    'ความทรงจำ (MEMORY.md — ปัญหาที่เคยเจอ อย่าทำซ้ำ):',
    ...(recentLessons().length ? recentLessons() : ['(ยังไม่มี)']),
    '',
    `แมพล่ามอนที่เหมาะกับเลเวล ${me.baseLevel} (เรียงจากดีที่สุด, h = จำนวนครั้งที่ต้องเปลี่ยนแมพ):`,
    ...(candidates.length ? candidates : ['(ไม่มีข้อมูล)']),
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
    { role: 'user', content: `แผนปัจจุบัน: ${JSON.stringify(current)}\n\n${summarize(snap, why, recent, ctx)}` },
  ];
  // A plan is a JSON object. The model sometimes loops into a list ("Mantis x1 … x20"): ask once more, cooler.
  const isPlan = (p) => !!p && typeof p === 'object' && !Array.isArray(p);
  let text = await llm.chat(messages, { maxTokens: 500, temperature: 0.3, json: true });
  let parsed = llm.parseJson(text);
  if (!isPlan(parsed)) {
    text = await llm.chat(messages, { maxTokens: 500, temperature: 0.1, json: true });
    parsed = llm.parseJson(text);
  }
  if (!isPlan(parsed)) {
    log('planner_bad_json', { text: text.slice(0, 300) });
    return current;
  }
  const next = { ...sanitize(parsed, ctx.candidates), signals: (ctx.signals || []).map((s) => s.text) };
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
  const hunt = candidates.find((c) => c.map === p.hunt_map) || candidates[0] || null;
  const onMap = new Set(hunt ? hunt.targets.map((t) => t.name) : []);
  const targets = list(p.target_monsters).filter((n) => !hunt || onMap.has(n));
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
