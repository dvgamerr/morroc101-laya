import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Gameplay evidence in MEMORY.md: combat risk, farming results and confirmed game rules.
 * Transient service failures belong in logs, not in the planner's long-term memory. The same lesson
 * again bumps its count instead of adding a line. The planner (Qwen) reads the list
 * before every decision.
 */
// Resolved per call, so a test can point it elsewhere whatever loaded this module first.
const file = () => process.env.LESSONS_FILE || 'MEMORY.md';
const HEADER = '# MEMORY — บทเรียนที่ agent เจอ\n\nเก็บเฉพาะข้อมูลที่ช่วยตัดสินใจเล่นเกม เช่น ความเสี่ยงมอน ผลฟาร์ม และกติกาที่ทราบจริง ไม่เก็บข้อผิดพลาดระบบชั่วคราวหรือยอดเงินไม่พอซื้อของ\n\n';
const LINE = /^- \[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] (.*?)(?: \(×(\d+)\))?$/;
const transient = text => /^ไปร้าน.*(?:ไม่สำเร็จ|เงินไม่พอซื้อยา)/.test(text)
  || /timeout|LAYA\s+\d{3}|ยังไม่ทราบสาเหตุ/i.test(text);

function read() {
  if (!existsSync(file())) return [];
  return readFileSync(file(), 'utf8')
    .split('\n')
    .map((l) => LINE.exec(l))
    .filter(Boolean)
    .map((m) => ({ at: m[1], text: m[2], count: Number(m[3] || 1) }))
    .filter(i => !transient(i.text));
}

function ownerPolicy() {
  if (!existsSync(file())) return '';
  return readFileSync(file(), 'utf8').match(/<!-- owner-hunting-policy:start -->[\s\S]*?<!-- owner-hunting-policy:end -->/)?.[0] || '';
}

function write(items) {
  const body = items.map((i) => `- [${i.at}] ${i.text}${i.count > 1 ? ` (×${i.count})` : ''}`).join('\n');
  writeFileSync(file(), HEADER + (ownerPolicy() ? ownerPolicy() + '\n\n' : '') + body + '\n');
}

const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

/** Remember a lesson (one line of Thai). Same text again: count it, move it to "now". */
export function learn(text, context = {}) {
  if (transient(text)) return;
  if (Number.isInteger(context.level) && context.level > 0) text += ' [Base ' + context.level + '; retry Base ' + (context.level + 5) + ']';
  if (process.env.NODE_ENV === 'test' && !process.env.LESSONS_FILE) return;
  const items = read();
  const same = items.find((i) => i.text === text);
  if (same) {
    same.count += 1;
    same.at = stamp();
  } else {
    items.push({ at: stamp(), text, count: 1 });
  }
  // newest last; keep the list readable
  items.sort((a, b) => a.at.localeCompare(b.at));
  write(items.slice(-100));
}

/** The most recent lessons, for the planner's prompt. */
export function recentLessons(limit = 25, baseLevel = null) {
  const lessons = read()
    .filter(i => {
      const retry = /retry Base (\d+)/.exec(i.text);
      return !retry || !Number.isFinite(baseLevel) || baseLevel < Number(retry[1]);
    })
    .slice(-limit)
    .map((i) => `- ${i.text}${i.count > 1 ? ` (เกิด ${i.count} ครั้ง)` : ''}`);
  return [...ownerPolicy().split('\n').filter(line => line.startsWith('- ')), ...lessons];
}
