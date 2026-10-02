import { mkdirSync, appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

mkdirSync('logs', { recursive: true });

// Windows consoles start on code page 437, which prints our Thai as mojibake: switch the
// console to UTF-8 once. The readable log (logs/bot.log) starts with a UTF-8 BOM so Notepad
// and Windows PowerShell's Get-Content read the Thai right without -Encoding.
if (process.platform === 'win32') {
  try {
    execSync('chcp 65001', { stdio: 'ignore' });
  } catch {}
}
const READABLE = 'logs/bot.log';
if (!existsSync(READABLE)) writeFileSync(READABLE, '﻿');

// Failures worth a code fix. They also go to logs/incidents.jsonl, one line each, so a
// watcher (a Claude Code session, see README) can pick them up without reading every action.
const INCIDENTS = new Set([
  'loop_error', 'laya_error', 'planner_error', 'planner_bad_json', 'chat_error', 'notify_error',
  'travel_failed', 'errand_failed', 'errand_no_shop', 'jobchange_failed', 'jobchange_no_npc',
  'npc_laya_error', 'skills_plan_error', 'skill_upgrade_plan_error', 'world_error', 'llm_warm_error',
  'storage_failed', 'errand_sell_failed', 'potion_unseen', 'slow_tick', 'not_in_game',
  'fight_long', 'potion_no_effect',
]);

export function log(kind, data = {}) {
  const line = { t: new Date().toISOString(), kind, ...data };
  const json = JSON.stringify(line) + '\n';
  appendFileSync('logs/decisions.jsonl', json);
  if (INCIDENTS.has(kind)) appendFileSync('logs/incidents.jsonl', json);
  const brief = Object.entries(data)
    .filter(([, v]) => typeof v !== 'object' || v === null)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  const text = `[${line.t.slice(11, 19)}] ${kind} ${brief}`;
  console.log(text);
  appendFileSync(READABLE, text + '\n');
}
