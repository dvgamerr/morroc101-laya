import { test, expect } from 'bun:test';
import { rmSync, readFileSync, existsSync } from 'node:fs';
import { learn, recentLessons } from '../src/lessons.js';

test('lessons go to a markdown list; the same lesson again is counted, not repeated', () => {
  // Set only for this test: bun loads every test file first, so a top-level env would leak.
  process.env.LESSONS_FILE = 'logs/test-memory.md';
  try {
    rmSync('logs/test-memory.md', { force: true });
    learn('ตายที่ yuno_fild04 โดน Harpy รุม');
    learn('Healer ที่ aldebaran ไม่ฟื้นให้');
    learn('ตายที่ yuno_fild04 โดน Harpy รุม');
    const text = readFileSync('logs/test-memory.md', 'utf8');
    expect(text).toStartWith('# MEMORY');
    expect(text.match(/yuno_fild04/g).length).toBe(1);
    expect(text).toContain('(×2)');
    expect(recentLessons().sort()).toEqual(['- Healer ที่ aldebaran ไม่ฟื้นให้', '- ตายที่ yuno_fild04 โดน Harpy รุม (เกิด 2 ครั้ง)'].sort());
  } finally {
    rmSync('logs/test-memory.md', { force: true });
    delete process.env.LESSONS_FILE;
  }
});

test('tests never write the real MEMORY.md', () => {
  const before = existsSync('MEMORY.md') ? readFileSync('MEMORY.md', 'utf8') : null;
  learn('should not be written');
  const after = existsSync('MEMORY.md') ? readFileSync('MEMORY.md', 'utf8') : null;
  expect(after).toBe(before);
});
