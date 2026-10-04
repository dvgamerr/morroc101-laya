import * as llm from './llm.js';
import { log } from './logger.js';
import { PLANNER_SYSTEM } from './prompts.js';
import { GOAL_KEYS, jobInfo, zenyReserve } from './goals.js';
import { stockHp, stockSp } from './potions.js';
import { recentLessons } from './lessons.js';
import { gearObjective } from './gear-goal.js';
import { moneyEvidence, moneyReason } from './planner-evidence.js';

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
  const reserve = zenyReserve(me.baseLevel);
  const hasZeny = Number.isFinite(me.zeny);
  const belowReserve = hasZeny && me.zeny < reserve;
  const moneyStatus = !hasZeny ? 'unknown' : belowReserve ? 'below_reserve'
    : ctx.goal === 'money' ? 'continuing_to_target' : 'reserve_met';
  return [
    'เหตุ: ' + why,
    'goal: ' + (ctx.goal || 'level'),
    'money_reference: ' + JSON.stringify({ zeny: hasZeny ? me.zeny : null, reserve, status: moneyStatus, target: ctx.moneyTarget?.target ?? null }),
    'Base ' + me.baseLevel + ' | อาชีพ ' + jobInfo(me.jobId).name +
      ' | HP ' + me.hp + '/' + me.maxHp + ' SP ' + me.sp + '/' + me.maxSp +
      ' | zeny ' + me.zeny,
    'current_map (ตำแหน่งจริงตอนนี้): ' + me.map + ' (' + me.x + ',' + me.y + ')' +
      (ctx.inTown ? ' เมือง' : '') +
      (candidates.some(c => c.map === me.map) ? ' — เลือกล่าต่อที่นี่ได้' : ' — ไม่อยู่ในตัวเลือก'),
    'ยาสำรอง: HP รวม ' + Math.round(stockHp(snap.inventory, me)) + ' / SP รวม ' + Math.round(stockSp(snap.inventory)),
    'อุปกรณ์: ' + (snap.worn || []).map(i => `+${i.refine || 0} ${i.name}`).join(', '),
    'gear_reference: ' + JSON.stringify(gearObjective(snap, jobInfo(me.jobId).name)),
    'ผลล่าสุด: ' + recent,
    'หน่วยข้อมูล: knownZenyPerKill = รายได้ดรอปคาดหมาย zeny/ตัว ก่อนต้นทุน; farmResults.zenyPerMinute = กำไรสุทธิ zeny/นาที ที่วัดจริง รวมเดินทางและเติมของ ห้ามนำสองหน่วยนี้มาเทียบตรงๆ; แมพไม่มีผลวัดให้ระบุว่ายังไม่ทราบกำไรต่อเวลา',
    ctx.goal === 'level'
      ? 'ประเมิน farmResults ด้วย expPercent (เปอร์เซ็นต์ความคืบหน้า Base EXP สุทธิ รวมข้ามเลเวลและหัก EXP ที่เสีย), expPercentPerMinute เป็นหลัก เทียบ observedSpend และ zenyPerExpPercent กับเงินที่ใช้ได้เหนือ reserve; เป้าหมาย Class 4 Base 255 ไม่ใช่กำไรขายของ แมพขาดทุนแต่ EXP คุ้มและเงินสำรองพอยังใช้ได้ ห้ามลดระดับมอนหรือตัดแมพเพียงเพราะ net <= 0; เปรียบเทียบเฉพาะช่วงเลเวลใกล้เคียงเพราะ EXP ที่ต้องใช้ต่อเลเวลต่างกัน'
      : 'ประเมิน farmResults ด้วย net และ zenyPerMinute: เงินสุทธิหลังขายและเติมเสบียงเทียบก่อนออกฟาร์ม เลือกแมพที่ทำกำไรจริง ห้ามถือราคาดรอปเป็นกำไรสุทธิ',
    'หลังจบรอบเปรียบเทียบ previous_hunt_map กับ allowed_maps และระบุเหตุผลอยู่ต่อหรือย้ายตาม goal; durationMs รวมเดินทางไปล่า กลับเมือง ขายและเติมเสบียง; observedSpend คือยอดเงินลดลงที่สังเกตระหว่าง snapshot ไม่ใช่ต้นทุนรวมที่แน่นอนหากรายรับรายจ่ายเกิดพร้อมกัน; ตรวจ finishedAt, startLevel/endLevel และความเสี่ยงตาย; maps หลายแมพเป็นผลรวมทั้งรอบ ห้ามอ้างเป็นผลของแมพเดียว; null คือไม่ทราบ ห้ามแต่งค่าประสิทธิภาพแมพที่ยังไม่เคยทดลอง',
    'บทเรียน (เป็นประวัติ ไม่ใช่รายการแมพที่อนุญาต):',
    ...recentLessons(8, me.baseLevel),
    'ข้อมูลตัวเลือก: map | จำนวนเปลี่ยนแมพ | มอน | อันตราย',
    ...candidates.map(c => c.map + ' | ' + c.hops + ' | ' +
      c.targets.map(t => t.name + ': Lv=' + t.level + ' count=' + t.count + ' HP=' + (t.hp ?? '?') + ' EXP=' + (t.baseExp ?? '?')).join(', ') +
      ' | ' + (c.avoid.join(', ') || '-') +
      (ctx.goal === 'money' ? ' | drops=' + JSON.stringify(c.targets.map(t => ({mob:t.name,knownZenyPerKill:t.drops?.knownZenyPerKill,unknownPrices:t.drops?.unknownPrices,items:t.drops?.items.map(d => ({id:d.id,name:d.name,chancePct:d.rate/100,sellPrice:d.sellPrice}))}))) : '')),
    'ยืนยัน current_map=' + me.map + '; Base=' + me.baseLevel + '; goal=' + ctx.goal + '; แมพอื่นต้องเดินทาง ห้ามอ้างว่าอยู่แล้ว',
    'allowed_maps: ' + JSON.stringify(candidates.map(c => c.map)),
    ...(ctx.goal === 'money' ? [
      'money_evidence_by_map: ' + JSON.stringify(Object.fromEntries(candidates.map(c => [c.map, moneyEvidence(c.map, ctx.farmResults)]))),
      'goal=money: ใช้ money_evidence_by_map ประกอบการเลือกแมพ (null คือยังไม่มีผลวัดของแมพนั้น) ห้ามอ้างผลของแมพอื่น ไม่ต้องคัดลอกตารางในคำตอบ ระบบจะเติมผลวัดจริงของแมพที่เลือกเอง',
    ] : []),
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
  // Fatal: the answer cannot be used at all (no JSON, or a map that is not a candidate). Never fixed up.
  const fatalReason = (p) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return 'invalid_or_incomplete_json';
    if (!ctx.candidates.some(c => c.map === p.hunt_map)) return 'map_not_in_candidates';
    return null;
  };
  // Fixable: worth one retry, but sanitize() repairs it when the retry does not (a monster name that is
  // not on the map is dropped, a missing target list becomes every target, current_map is the real one).
  const invalidReason = (p) => {
    const fatal = fatalReason(p);
    if (fatal) return fatal;
    if (p.current_map !== snap.me.map) return 'incorrect_current_map';
    const onMap = ctx.candidates.find(c => c.map === p.hunt_map).targets;
    if (!Array.isArray(p.target_monsters) || !p.target_monsters.length ||
        !p.target_monsters.every(name => onMap.some(t => t.name === name))) return 'invalid_target_monsters';
    if (typeof p.reason !== 'string' || !p.reason.trim()) return 'missing_reason';
    return null;
  };
  // The LLM being down, or answering with no usable map twice, must not stop the hunt when the plan
  // we already have is still a candidate. Never picks a new map by itself.
  const keepCurrent = (error) => {
    if (!current || !ctx.candidates.some(c => c.map === current.hunt_map)) return null;
    log('planner_keep_current', { error: error.message, map: current.hunt_map });
    return { ...current, signals: (ctx.signals || []).map((s) => s.text) };
  };
  let completion = {};
  const onCompletion = (info) => { completion = info; };
  const reportInvalid = (parsed, text, attempt) => log('planner_bad_json', {
    attempt, cause: invalidReason(parsed), map: parsed?.hunt_map,
    expectedCurrentMap: snap.me.map, receivedCurrentMap: parsed?.current_map,
    ...completion, chars: text.length, tail: text.slice(-200),
  });
  let text, parsed;
  try {
    text = await llm.chat(messages, { maxTokens: 2048, temperature: 0.3, json: true, timeoutMs: 120000, onCompletion });
    parsed = llm.parseJson(text);
  } catch (error) {
    const kept = keepCurrent(error);
    if (kept) return kept;
    throw error;
  }
  if (invalidReason(parsed)) {
    reportInvalid(parsed, text, 1);
    completion = {};
    const chosen = ctx.candidates.find(c => c.map === parsed?.hunt_map);
    try {
      text = await llm.chat([...messages, { role: 'user', content:
        'คำตอบก่อนหน้าใช้ไม่ได้: ' + invalidReason(parsed) +
        '; current_map ที่ตอบ = ' + JSON.stringify(parsed?.current_map ?? null) +
        '; ตำแหน่งจริงจากเกม current_map ต้องเป็น ' + JSON.stringify(snap.me.map) +
        ' เท่านั้น ไม่ใช่ previous_hunt_map หรือ hunt_map; goal ต้องเป็น ' + JSON.stringify(ctx.goal) +
        '; hunt_map ที่ตอบ = ' + JSON.stringify(parsed?.hunt_map ?? null) +
        '; allowed_maps = ' + JSON.stringify(ctx.candidates.map(c => c.map).sort()) +
        '. เลือก hunt_map จาก allowed_maps เท่านั้น ตอบ JSON โดยคง current_map ตามนี้: ' +
        JSON.stringify({ current_map: snap.me.map, hunt_map: 'เลือกจาก allowed_maps', goal: ctx.goal, target_monsters: ['มอนในแมพที่เลือก'], reason: 'เหตุผลสั้นๆ' }) +
        ' ห้ามเลือกแมพนอกนี้แม้เคยอยู่ในแผนเก่า' +
        (chosen ? '; มอนที่ล่าได้ในแมพ ' + chosen.map + ' = ' + JSON.stringify(chosen.targets.map(t => t.name)) + ' target_monsters ต้องเลือกจากรายการนี้เท่านั้น' : '')
      }], { maxTokens: 2048, temperature: 0.1, json: true, timeoutMs: 120000, onCompletion });
      parsed = llm.parseJson(text);
    } catch (error) {
      const kept = keepCurrent(error);
      if (kept) return kept;
      throw error;
    }
  }
  if (fatalReason(parsed)) {
    reportInvalid(parsed, text, 2);
    const error = new Error('Plan rejected: ' + fatalReason(parsed) + '; no automatic map selection');
    const kept = keepCurrent(error);
    if (kept) return kept;
    throw error;
  }
  // Fixable problems that survived the retry are logged and repaired by sanitize(), not rejected.
  if (invalidReason(parsed)) reportInvalid(parsed, text, 2);
  const next = { ...sanitize(parsed, ctx.candidates), signals: (ctx.signals || []).map((s) => s.text) };
  if (ctx.goal === 'money') next.reason = moneyReason(parsed, ctx.farmResults);
  if (ctx.goal === 'money' || ctx.goal === 'level') {
    next.goal = ctx.goal;
    next.objective = ctx.goal === 'money' ? 'หาเงินจากดรอปโดยเสีย HP และค่ายาน้อย' : 'เก็บเลเวลกับมอนในช่วง Base-10 ถึง Base-1';
  }
  // The Job Master trip is started by jobchange.js from the character's state, never by the plan.
  else if (next.goal === 'job_change') {
    next.goal = 'level';
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
