import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * The agent's memory of what went wrong, in MEMORY.md as a plain list the owner can
 * read and edit. Every problem worth not repeating becomes one line; the same lesson
 * again bumps its count instead of adding a line. The planner (Qwen) reads the list
 * before every decision.
 */
// Resolved per call, so a test can point it elsewhere whatever loaded this module first.
const file = () => process.env.LESSONS_FILE || 'MEMORY.md';
const HEADER = '# MEMORY — บทเรียนที่ agent เจอ\n\nรายการปัญหาที่เคยเกิด agent อ่านไฟล์นี้ก่อนวางแผนทุกครั้ง แก้/ลบบรรทัดได้\n\n';
const LINE = /^- \[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] (.*?)(?: \(×(\d+)\))?$/;

function read() {
  if (!existsSync(file())) return [];
  return readFileSync(file(), 'utf8')
    .split('\n')
    .map((l) => LINE.exec(l))
    .filter(Boolean)
    .map((m) => ({ at: m[1], text: m[2], count: Number(m[3] || 1) }));
}

function write(items) {
  const body = items.map((i) => `- [${i.at}] ${i.text}${i.count > 1 ? ` (×${i.count})` : ''}`).join('\n');
  writeFileSync(file(), HEADER + body + '\n');
}

const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

/** Remember a lesson (one line of Thai). Same text again: count it, move it to "now". */
export function learn(text) {
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
export function recentLessons(limit = 25) {
  return read()
    .slice(-limit)
    .map((i) => `- ${i.text}${i.count > 1 ? ` (เกิด ${i.count} ครั้ง)` : ''}`);
}
