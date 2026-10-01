import { mkdirSync, appendFileSync } from 'node:fs';

mkdirSync('logs', { recursive: true });

export function log(kind, data = {}) {
  const line = { t: new Date().toISOString(), kind, ...data };
  appendFileSync('logs/decisions.jsonl', JSON.stringify(line) + '\n');
  const brief = Object.entries(data)
    .filter(([, v]) => typeof v !== 'object' || v === null)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.log(`[${line.t.slice(11, 19)}] ${kind} ${brief}`);
}
