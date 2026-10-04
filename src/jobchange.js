import { act } from './browser.js';
import { log } from './logger.js';
import { learn } from './lessons.js';
import { findNpcs } from './world.js';
import { jobChangeReady, nextJob, jobInfo } from './goals.js';
import { jobChooser, findNpcEntity } from './npc.js';
import { jobReference, loadJobGuide } from './job-reference.js';

const JOB_NPC = 'Job Master';
const TALK_RANGE = 3;
const VERIFY_MS = 5000;
const RETRY_AFTER_MS = 30 * 60 * 1000;
const MAX_RETRY_AFTER_MS = 8 * 60 * 60 * 1000; // repeated failures back off: 30m, 1h, 2h ... 8h
const TRIP_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Prerequisites the server's Job Master enforces (rAthena npc/custom/jobmaster.txt): no cart, falcon,
 * Peco or mount, and all skill points spent. There is no quest, fee or weight limit. The snapshot
 * does not expose the mount/cart state yet, so only an observed violation refuses (and says which);
 * unreadable values are reported as "unknown" in the log.
 * @returns {{ok: boolean, reason?: string, observed: object}}
 */
export function checkRequirements(me, guide) {
  const req = guide?.requirements;
  if (!req) return { ok: true, observed: {} };
  const mounted = me.cart === true || me.hasCart === true || me.falcon === true || me.riding === true || me.mounting === true;
  const observed = { cart: me.cart ?? me.hasCart ?? 'unknown', skillPoints: me.skillPoints ?? 'unknown' };
  const problems = [];
  if ((req.noCart || req.noMount) && mounted) problems.push('has a cart/falcon/mount (remove it first)');
  if (req.skillPoints != null && typeof me.skillPoints === 'number' && me.skillPoints > req.skillPoints) problems.push(`skill points ${me.skillPoints} left`);
  return problems.length ? { ok: false, reason: 'prerequisites not met: ' + problems.join('; '), observed } : { ok: true, observed };
}

/**
 * Job change trip: when the character qualifies for the next job on CLASS_PATH
 * (and has spent its skill points — the usual Job Master refuses otherwise),
 * travel to the server's Job Master (prontera 153,193 on Morroc 101), talk to it
 * with a chooser that aims for that job, and check the job really changed.
 * A failed attempt keeps the transcript, so the owner can read what the NPC asked for, and the
 * retry interval doubles with each consecutive failure. The server's Job Master changes job directly
 * (no quest chain); a guide's `requirements` (cart/mount, skill points) are checked before the trip starts.
 */
export function createJobChange(page, world, travel, dialog) {
  const j = { active: false, stage: 'idle', target: null, npc: null, stageAt: 0, startedAt: 0, cooldownUntil: 0, failures: 0, fromJob: null, transcript: null };

  function maybeStart(snap) {
    if (j.active || Date.now() < j.cooldownUntil || !world) return null;
    const me = snap.me;
    const target = nextJob(me);
    if (!target || !jobChangeReady(me)) return null;
    const ref = jobReference(jobInfo(me.jobId).name, target);
    const guide = loadJobGuide(ref);
    if (!guide) {
      j.cooldownUntil = Date.now() + RETRY_AFTER_MS;
      log('jobchange_no_reference', { from: jobInfo(me.jobId).name, to: target });
      return null;
    }
    if ((me.skillPoints || 0) > 0) return null; // spend them first (build tick does)
    const pre = checkRequirements(me, guide);
    log('jobchange_prereq', { from: jobInfo(me.jobId).name, to: target, confirmed: guide.requirements?.confirmed ?? null, ok: pre.ok, ...pre.observed });
    if (!pre.ok) {
      j.cooldownUntil = Date.now() + Math.min(RETRY_AFTER_MS * 2 ** j.failures, MAX_RETRY_AFTER_MS);
      j.failures++;
      learn(`เปลี่ยนอาชีพ ${jobInfo(me.jobId).name} → ${target} ยังไม่เริ่ม: ${pre.reason}`);
      log('jobchange_failed', { from: jobInfo(me.jobId).name, to: target, note: pre.reason });
      return null;
    }
    const npc = findNpcs(world, JOB_NPC)[0];
    if (!npc) {
      j.cooldownUntil = Date.now() + RETRY_AFTER_MS;
      log('jobchange_no_npc', { npc: JOB_NPC });
      return null;
    }
    Object.assign(j, { active: true, stage: 'travel', target, guide, npc, stageAt: Date.now(), startedAt: Date.now(), fromJob: jobInfo(me.jobId).name, transcript: null });
    log('jobchange_start', { from: j.fromJob, to: target, npc: `${npc.name}@${npc.map} ${npc.x},${npc.y}` });
    return { goal: 'job_change', why: `${j.fromJob} → ${target}: ไปคุย ${npc.name} ที่ ${npc.map} (${npc.x},${npc.y})`, target };
  }

  function to(stage) {
    j.stage = stage;
    j.stageAt = Date.now();
  }

  // Always releases the shared travel: a failed trip must not leave the next one resuming this destination.
  async function finish(ok, note, snap) {
    const result = { ok, note, from: j.fromJob, to: j.target, now: jobInfo(snap.me.jobId).name, transcript: j.transcript };
    log(ok ? 'jobchange_done' : 'jobchange_failed', { from: j.fromJob, to: j.target, now: result.now, note });
    if (ok) j.failures = 0;
    else {
      learn(`เปลี่ยนอาชีพ ${j.fromJob} → ${j.target} ไม่สำเร็จ: ${note}`);
      j.cooldownUntil = Date.now() + Math.min(RETRY_AFTER_MS * 2 ** j.failures, MAX_RETRY_AFTER_MS);
      j.failures++;
    }
    Object.assign(j, { active: false, stage: 'idle' });
    if (travel.dest) await travel.stop();
    return result;
  }

  /** @returns null while working, or {ok, note, from, to, now, transcript}. */
  async function tick(snap) {
    if (!j.active) return null;
    const me = snap.me;
    if (Date.now() - j.startedAt > TRIP_TIMEOUT_MS) return finish(false, `timeout at ${j.stage}`, snap);

    switch (j.stage) {
      case 'travel':
        if (me.map !== j.npc.map) {
          if (travel.dest !== j.npc.map) await travel.start(j.npc.map);
          if ((await travel.tick(snap)) === 'failed') return finish(false, 'travel failed', snap);
          return null;
        }
        if (travel.dest) await travel.stop();
        to('approach');
        return null;
      case 'approach': {
        const d = Math.max(Math.abs(me.x - j.npc.x), Math.abs(me.y - j.npc.y));
        if (d > TALK_RANGE) {
          if (!me.walking) await act(page, 'walk_to', { x: j.npc.x, y: j.npc.y });
          if (Date.now() - j.stageAt > 60000) return finish(false, 'could not reach the NPC', snap);
          return null;
        }
        const npc = findNpcEntity(snap, j.npc);
        if (!npc) return finish(false, `no "${j.npc.name}" at ${j.npc.x},${j.npc.y}`, snap);
        await dialog.start(npc, jobChooser(j.target, `change job from ${j.fromJob} to ${j.target}`, { aliases: j.guide.aliases, strict: true }));
        to('dialog');
        return null;
      }
      case 'dialog': {
        const done = await dialog.tick(snap);
        if (!done) return null;
        j.transcript = done.transcript;
        if (!done.ok) return finish(false, `dialog failed: ${done.reason}`, snap);
        to('verify');
        return null;
      }
      case 'verify':
        // The job packet lands a moment after the dialog closes.
        if (jobInfo(me.jobId).name === j.target) return finish(true, 'job changed', snap);
        if (Date.now() - j.stageAt > VERIFY_MS) return finish(false, 'job did not change (see transcript)', snap);
        return null;
      default:
        return null;
    }
  }

  return {
    maybeStart,
    tick,
    get active() {
      return j.active;
    },
  };
}
