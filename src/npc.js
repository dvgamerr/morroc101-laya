import { mkdirSync, appendFileSync } from 'node:fs';
import { act } from './browser.js';
import { log } from './logger.js';
import * as laya from './laya.js';

const START_TIMEOUT_MS = 8000; // NPC never answered the click
const IDLE_END_MS = 8000; // script went quiet without a Close button
const DIALOG_TIMEOUT_MS = 90000;
const CANCEL = 255;

// Never pick these, whatever the goal: they cost the character something it can't get back.
export const FORBIDDEN = /(reset|delete|remove|stylist|cash|refund|รีเซ็ต|ลบ|ทิ้ง)/i;
const CONFIRM = /^(yes|ok|okay|sure|confirm|accept|ใช่|ตกลง|ยืนยัน|แน่นอน)\b/i;
const ADVANCE = /(job ?change|change ?job|jobchange|เปลี่ยนอาชีพ|continue|next|proceed|ต่อไป)/i;

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9ก-๙]+/g, '');

/**
 * The NPC entity standing for a directory entry ({name, x, y}): same name near the
 * spot (exact first, then one name containing the other, nearest first). A different
 * NPC standing close by is never taken for it — talking to the wrong one buys, sells
 * or warps for the wrong reason. Nameless entities (hidden script NPCs, effects) are
 * never picked either. An entry with no name at all falls back to the nearest named NPC.
 */
export function findNpcEntity(snap, want, radius = 3) {
  const named = (snap.npcs || []).filter((n) => n.name && Math.max(Math.abs(n.x - want.x), Math.abs(n.y - want.y)) <= radius);
  const d = (n) => Math.max(Math.abs(n.x - want.x), Math.abs(n.y - want.y));
  if (!want.name) return named.sort((a, b) => d(a) - d(b))[0] || null;
  const wanted = norm(want.name);
  return named.find((n) => norm(n.name) === wanted)
    || named.filter((n) => norm(n.name).includes(wanted) || wanted.includes(norm(n.name))).sort((a, b) => d(a) - d(b))[0]
    || null;
}

/**
 * Menu chooser for a job change toward `target` (e.g. "Blacksmith").
 * Order: the job itself → rebirth when the target is a High Novice → "yes" to a
 * confirmation → anything that moves a job-change script along → LAYA → cancel.
 */
export function jobChooser(target, goalText = `change job to ${target}`, { aliases = [target], strict = false } = {}) {
  return {
    goal: goalText,
    allowLaya: !strict,
    rules(options, lines) {
      const ok = options.map((o, i) => ({ o, i })).filter(({ o }) => o && !FORBIDDEN.test(o));
      const t = norm(target);
      const names = [...new Set([target, ...aliases])].map(norm);
      const exact = ok.find(({ o }) => names.includes(norm(o)))
        || ok.find(({ o }) => strict
          ? names.includes(norm(o.replace(/\s*\([^)]*\)\s*$/, '')))
          : norm(o).includes(t));
      if (exact) return { index: exact.i, why: `matches ${target}` };
      if (!strict && /high novice/i.test(target)) {
        const reb = ok.find(({ o }) => /(rebirth|reborn|transcend|เกิดใหม่)/i.test(o));
        if (reb) return { index: reb.i, why: 'rebirth' };
      }
      const text = (strict ? lines.slice(-1) : lines).join(' ');
      const yes = ok.find(({ o }) => CONFIRM.test(o));
      if (yes && ((strict ? names.some((name) => norm(text).includes(name)) : norm(text).includes(t)) || (!strict && /(sure|really|confirm|แน่ใจ|ยืนยัน)/i.test(text)))) return { index: yes.i, why: 'confirm' };
      const adv = ok.find(({ o }) => strict
        ? /^(job change|change job|jobchange|เปลี่ยนอาชีพ|continue|next|proceed|ต่อไป)$/i.test(o.trim())
        : ADVANCE.test(o));
      if (adv) return { index: adv.i, why: 'advances job change' };
      return null;
    },
  };
}

/**
 * Drive one NPC conversation from click to close: press Next, answer menus with
 * `chooser`, fill inputs, close. Every line and choice goes into a transcript
 * that is also appended to logs/npc/<npc>.jsonl, so what an NPC really says can
 * be read afterwards ("let the agent go and look").
 */
export function createDialog(page) {
  const d = { active: false };

  async function start(npc, chooser) {
    Object.assign(d, { active: true, npc, chooser, startedAt: Date.now(), naid: null, lastKey: '', transcript: [], seenLines: 0 });
    await act(page, 'talk', { GID: npc.GID });
    log('npc_talk', { npc: npc.name, goal: chooser.goal });
  }

  /** Make sure the server isn't keeping us in a conversation: cancel any menu, close. */
  async function releaseNpc(naid) {
    await act(page, 'npc_menu', { naid, num: CANCEL });
    await act(page, 'npc_close', { naid });
  }

  function finish(ok, reason) {
    const result = { ok, reason, npc: d.npc.name, transcript: d.transcript };
    // `bun test` sets NODE_ENV=test: fake NPCs must never end up in the real transcripts.
    if (process.env.NODE_ENV !== 'test') try {
      mkdirSync('logs/npc', { recursive: true });
      appendFileSync(`logs/npc/${d.npc.name.replace(/[^\w-]+/g, '_')}.jsonl`, JSON.stringify({ t: new Date().toISOString(), goal: d.chooser.goal, ok, reason, transcript: d.transcript }) + '\n');
    } catch {}
    log('npc_dialog', { npc: d.npc.name, ok, reason, steps: d.transcript.length });
    d.active = false;
    return result;
  }

  async function choose(options, lines) {
    const rule = d.chooser.rules(options, lines);
    // A rule's answer must be one of the options on screen; anything else is ignored, never sent.
    if (rule && Number.isInteger(rule.index) && rule.index >= 0 && rule.index < options.length) return { num: rule.index + 1, why: rule.why };
    if (d.chooser.allowLaya === false) return { num: CANCEL, why: 'no reference match' };
    // Nothing obvious: let LAYA pick among the safe options for the goal, or back out.
    const safe = options.map((o, i) => ({ o, i })).filter(({ o }) => o && !FORBIDDEN.test(o));
    if (!safe.length) return { num: CANCEL, why: 'only forbidden options' };
    try {
      const criteria = Object.fromEntries(safe.map(({ o, i }) => [`option_${i + 1}`, o]));
      const answer = await laya.choose(
        { goal: d.chooser.goal, npc: d.npc.name, npc_says: lines.slice(-4).join(' ') },
        'Pick the NPC menu option that moves toward the goal.',
        criteria,
      );
      // Only an option we offered counts (not a made-up key, and never a forbidden or out-of-range number).
      const key = typeof answer?.choice === 'string' ? answer.choice : null;
      const offered = key !== null && Object.hasOwn(criteria, key);
      const num = offered ? Number(key.replace('option_', '')) : 0;
      const confidence = Number(answer?.confidence);
      if (offered && Number.isInteger(num) && num >= 1 && num <= options.length && confidence >= 0.5) return { num, why: `LAYA ${Math.round(confidence * 100)}%` };
    } catch (err) {
      log('npc_laya_error', { error: err.message });
    }
    return { num: CANCEL, why: 'unsure' };
  }

  /** @returns null while talking, or {ok, reason, npc, transcript} when it's over. */
  async function clickDialog(name, arg) {
    try {
      const ok = await act(page, name, arg);
      if (ok === false) d.lastKey = '';
      return ok !== false;
    } catch (err) {
      d.lastKey = '';
      throw err;
    }
  }

  async function tick(snap) {
    if (!d.active) return null;
    const now = Date.now();
    const dlg = snap.dialog && snap.dialog.at >= d.startedAt - 1000 ? snap.dialog : null;
    if (!dlg) {
      if (now - d.startedAt <= START_TIMEOUT_MS) return null;
      // We saw nothing, but the server may still hold us "in conversation" (a script with no
      // window) — and while it does, rAthena refuses walking and @go. Cancel and close.
      await releaseNpc(d.npc.GID);
      return finish(false, 'NPC did not answer');
    }
    d.naid = dlg.naid;

    // New lines since last tick go into the transcript.
    if (dlg.lines.length > d.seenLines) {
      d.transcript.push({ npc: dlg.lines.slice(d.seenLines) });
      d.seenLines = dlg.lines.length;
    }
    if (now - d.startedAt > DIALOG_TIMEOUT_MS) {
      if (dlg.state === 'menu') await act(page, 'npc_menu', { naid: d.naid, num: CANCEL });
      if (!await clickDialog('npc_close', { naid: d.naid })) return null;
      return finish(false, 'dialog timeout');
    }

    // Act once per distinct dialog state.
    const key = `${dlg.state}:${dlg.lines.length}:${(dlg.menu || []).join('|')}`;
    if (key === d.lastKey) {
      if (dlg.state === 'text' && dlg.idleMs > IDLE_END_MS) {
        if (!await clickDialog('npc_close', { naid: d.naid })) return null;
        return finish(true, 'script went quiet');
      }
      return null;
    }
    d.lastKey = key;

    switch (dlg.state) {
      case 'next':
        if (!await clickDialog('npc_next', { naid: d.naid })) return null;
        return null;
      case 'menu': {
        const { num, why } = await choose(dlg.menu, dlg.lines);
        d.transcript.push({ menu: dlg.menu, chose: num === CANCEL ? 'cancel' : dlg.menu[num - 1], why });
        log('npc_menu', { npc: d.npc.name, options: dlg.menu.join(' | '), chose: num === CANCEL ? 'cancel' : dlg.menu[num - 1], why });
        if (!await clickDialog('npc_menu', { naid: d.naid, num })) return null;
        if (num === CANCEL) {
          if (!await clickDialog('npc_close', { naid: d.naid })) return null;
          return finish(false, `cancelled (${why})`);
        }
        return null;
      }
      case 'input': {
        // No chooser for the input: never type 0 or an empty text on our own (docs/FLOW.md). Back out.
        const value = d.chooser.input ? d.chooser.input(dlg.lines, dlg.input) : null;
        const valid = dlg.input === 'number' ? Number.isFinite(value) && value >= 0 : typeof value === 'string';
        if (!valid) {
          d.transcript.push({ input: dlg.input, value: null, why: 'no confirmed answer for this input' });
          await releaseNpc(d.naid);
          return finish(false, 'input prompt without a confirmed answer');
        }
        d.transcript.push({ input: dlg.input, value });
        if (!await clickDialog('npc_input', { naid: d.naid, value })) return null;
        return null;
      }
      case 'close':
        if (!await clickDialog('npc_close', { naid: d.naid })) return null;
        return finish(true, 'closed');
      case 'ended':
        if (!await clickDialog('npc_close', { naid: d.naid })) return null;
        return finish(true, 'script ended');
      default:
        return null;
    }
  }

  return {
    start,
    tick,
    releaseNpc,
    get active() {
      return d.active;
    },
  };
}
