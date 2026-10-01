import * as llm from './llm.js';
import { log } from './logger.js';
import { PLANNER_SYSTEM } from './prompts.js';

export const DEFAULT_PLAN = {
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
    return `${i + 1}. ${c.map} (h${c.hops}) มอน: ${mobs}${avoid}`;
  });
  return [
    `เหตุที่เรียก planner: ${why}`,
    `ตัวละคร: ${me.name} jobId=${me.jobId} Base ${me.baseLevel} (${me.baseExp ?? '?'}/${me.baseExpNext ?? '?'}) Job ${me.jobLevel}`,
    `HP ${me.hp}/${me.maxHp} SP ${me.sp}/${me.maxSp} Zeny ${me.zeny} น้ำหนัก ${me.weight}/${me.maxWeight}`,
    `Status point เหลือ ${me.statusPoints ?? '?'} Skill point เหลือ ${me.skillPoints ?? '?'}`,
    `แมพ ${me.map} (${me.x},${me.y})${ctx.inTown ? ' — เป็นเมือง ไม่มีมอน' : ''}`,
    `มอนที่เห็น: ${monsters.join(', ') || 'ไม่มี'}`,
    `ของใช้ในกระเป๋า: ${consumables.join(', ') || 'ไม่มี'}`,
    `อุปกรณ์ที่ใส่: ${snap.inventory.filter((i) => i.equipped).map((i) => i.name).join(', ') || '-'}`,
    `สรุปช่วงที่ผ่านมา: ${recent}`,
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
export async function plan(snap, why, recent, current, ctx = { candidates: [], inTown: false }) {
  const text = await llm.chat(
    [
      { role: 'system', content: PLANNER_SYSTEM },
      { role: 'user', content: `แผนปัจจุบัน: ${JSON.stringify(current)}\n\n${summarize(snap, why, recent, ctx)}` },
    ],
    { maxTokens: 500, temperature: 0.3, json: true },
  );
  const parsed = llm.parseJson(text);
  if (!parsed) {
    log('planner_bad_json', { text: text.slice(0, 300) });
    return current;
  }
  const next = sanitize(parsed, ctx.candidates);
  log('plan', { why, objective: next.objective, hunt_map: next.hunt_map, reason: next.reason, plan: next });
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
