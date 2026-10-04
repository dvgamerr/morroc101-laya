import { mkdirSync, appendFileSync, existsSync, writeFileSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

// Anchored to the project, not the working directory.
const LOG_DIR = join(import.meta.dir, '..', 'logs');
mkdirSync(LOG_DIR, { recursive: true });

// Windows consoles start on code page 437, which prints our Thai as mojibake: switch the
// console to UTF-8 once (not under test). The readable log (logs/bot.log) starts with a UTF-8 BOM
// so Notepad and Windows PowerShell's Get-Content read the Thai right without -Encoding.
if (process.platform === 'win32' && process.env.NODE_ENV !== 'test') {
  try {
    execSync('chcp 65001', { stdio: 'ignore' });
  } catch {}
}
const DECISIONS = join(LOG_DIR, 'decisions.jsonl');
const INCIDENT_FILE = join(LOG_DIR, 'incidents.jsonl');
const READABLE = join(LOG_DIR, 'bot.log');
if (!existsSync(READABLE)) writeFileSync(READABLE, '﻿');

// One generation is kept as <file>.1; the files never grow past about twice this.
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const FLUSH_MS = 250;
const sizes = new Map();
const buffers = new Map();
let timer = null;

function sizeOf(file) {
  if (!sizes.has(file)) {
    try { sizes.set(file, statSync(file).size); } catch { sizes.set(file, 0); }
  }
  return sizes.get(file);
}

function flush() {
  timer = null;
  for (const [file, text] of buffers) {
    try {
      if (sizeOf(file) > MAX_LOG_BYTES) {
        renameSync(file, file + '.1');
        sizes.set(file, 0);
      }
      appendFileSync(file, text);
      sizes.set(file, sizeOf(file) + Buffer.byteLength(text));
    } catch {}
  }
  buffers.clear();
}
process.on('exit', flush);

function write(file, text) {
  buffers.set(file, (buffers.get(file) || '') + text);
  timer ??= setTimeout(flush, FLUSH_MS);
  timer.unref?.();
}

// Failures worth a code fix. They also go to logs/incidents.jsonl, one line each, so a
// watcher (a Claude Code session, see README) can pick them up without reading every action.
const INCIDENTS = new Set([
  'game_dialog', 'game_error',
  'loop_error', 'laya_error', 'planner_error', 'planner_bad_json', 'chat_error', 'notify_error',
  'travel_failed', 'errand_failed', 'errand_no_shop', 'jobchange_failed', 'jobchange_no_npc',
  'npc_laya_error', 'skills_plan_error', 'skill_upgrade_plan_error', 'world_error', 'llm_warm_error',
  'storage_failed', 'errand_sell_failed', 'potion_unseen', 'slow_tick', 'not_in_game',
  'fight_long', 'potion_no_effect', 'game_reconnect_failed', 'game_config_failed', 'sale_blocked',
]);

// The game page can repeat the same console error many times a second.
const THROTTLED = new Set(['game_error', 'game_dialog']);
const THROTTLE_MS = 5000;
const lastSeen = new Map();

export function log(kind, data = {}) {
  const line = { t: new Date().toISOString(), kind, ...data };
  if (THROTTLED.has(kind)) {
    const key = kind + JSON.stringify(data);
    const now = Date.now();
    if (now - (lastSeen.get(key) || 0) < THROTTLE_MS) return;
    if (lastSeen.size > 200) lastSeen.clear();
    lastSeen.set(key, now);
  }
  const json = JSON.stringify(line) + '\n';
  write(DECISIONS, json);
  if (INCIDENTS.has(kind)) write(INCIDENT_FILE, json);
  const brief = Object.entries(data)
    .filter(([, v]) => typeof v !== 'object' || v === null)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  const text = `[${line.t.slice(11, 19)}] ${kind} ${brief}`;
  console.log(text);
  write(READABLE, text + '\n');
}
