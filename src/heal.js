import { act } from './browser.js';
import { log } from './logger.js';
import { learn } from './lessons.js';
import { findNpcs, isTown, travelCosts } from './world.js';
import { FORBIDDEN, findNpcEntity } from './npc.js';

// Client EFST: NOEQUIPWEAPON=50, WEAKNESS=418.
export const weaponBlocked = (me) => [50, 418].some(id => Object.hasOwn(me.status || {}, id));
const HEALER = 'Healer';
const TALK_RANGE = 3;
const WALK_TIMEOUT_MS = 60000;
const RETRY_AFTER_MS = 30000; // between attempts anywhere
const BAD_HEALER_MS = 5 * 60 * 1000; // a healer that didn't heal us (its own cooldown): skip it this long
const HEAL_BELOW_HP = 0.9;
const HEAL_BELOW_SP = 0.6;

/** Menu chooser for a healer: the heal / yes option; never anything forbidden. */
export const healChooser = {
  goal: 'heal HP and SP at the town healer',
  rules(options) {
    const ok = options.map((o, i) => ({ o, i })).filter(({ o }) => o && !FORBIDDEN.test(o));
    const heal = ok.find(({ o }) => /(heal|recover|restore|ฟื้น|รักษา|ฮีล)/i.test(o)) || ok.find(({ o }) => /^(yes|ok|okay|sure|ใช่|ตกลง)\b/i.test(o));
    return heal ? { index: heal.i, why: 'heal' } : null;
  },
};

/**
 * In town and hurt (typically right after respawning): walk to the town's Healer
 * and talk to it instead of drinking potions. Morroc 101 has one in every town.
 */
export function createHealer(page, world, dialog, travel = null) {
  const h = { active: false, stage: 'idle', npc: null, startedAt: 0, cooldownUntil: 0, skipUntil: new Map() };

  function needs(me) {
    const hp = me.maxHp ? me.hp / me.maxHp : 1;
    const sp = me.maxSp ? me.sp / me.maxSp : 1;
    return weaponBlocked(me) || hp < HEAL_BELOW_HP || sp < HEAL_BELOW_SP;
  }

  /** The healer on this town map, if we're in a town and need one. */
  function maybeStart(snap) {
    if (h.active || Date.now() < h.cooldownUntil || !world) return false;
    const me = snap.me;
    const cleanse = weaponBlocked(me);
    if (!needs(me) || (!cleanse && !isTown(world, me.map))) return false;
    const costs = cleanse && travel ? travelCosts(world, me.map, me.x, me.y, { canGo: travel.canGo }) : null;
    const npc = findNpcs(world, HEALER)
      .filter(n => (h.skipUntil.get(n.map) || 0) <= Date.now())
      .filter(n => n.map === me.map || (costs && Number.isFinite(costs.toMap(n.map))))
      .sort((a,b) => (a.map === me.map ? 0 : costs.toMap(a.map)) - (b.map === me.map ? 0 : costs.toMap(b.map)))[0];
    if (!npc || (h.skipUntil.get(npc.map) || 0) > Date.now()) return false;
    Object.assign(h, { active: true, stage: npc.map === me.map ? 'walk' : 'travel', npc, cleanse, startedAt: Date.now() });
    log('heal_start', { map: me.map, npc: `${npc.x},${npc.y}`, hp: me.hp, maxHp: me.maxHp });
    return true;
  }

  function finish(ok, note) {
    log(ok ? 'heal_done' : 'heal_failed', { note });
    if (!ok && h.npc) learn(`Healer ที่ ${h.npc.map} รักษาไม่สำเร็จ (${note}) — ยังไม่ทราบสาเหตุ`);
    h.cooldownUntil = Date.now() + RETRY_AFTER_MS;
    if (!ok && h.npc) h.skipUntil.set(h.npc.map, Date.now() + BAD_HEALER_MS);
    Object.assign(h, { active: false, stage: 'idle' });
    return { ok, note, cleansed: ok && h.cleanse };
  }

  /** @returns null while busy, or {ok, note} when done. */
  async function tick(snap) {
    if (!h.active) return null;
    const me = snap.me;
    if (h.stage === 'travel') {
      if (travel.dest !== h.npc.map) await travel.start(h.npc.map);
      const result = await travel.tick(snap);
      if (result === 'failed') return finish(false, 'cannot reach status healer');
      if (result === 'arrived') { h.stage = 'walk'; h.startedAt = Date.now(); }
      return null;
    }
    if (me.map !== h.npc.map) return finish(false, 'left the town');
    switch (h.stage) {
      case 'walk': {
        const d = Math.max(Math.abs(me.x - h.npc.x), Math.abs(me.y - h.npc.y));
        if (d > TALK_RANGE) {
          if (Date.now() - h.startedAt > WALK_TIMEOUT_MS) return finish(false, 'could not reach the healer');
          if (me.sitting) await act(page, 'stand');
          if (!me.walking) await act(page, 'walk_to', { x: h.npc.x, y: h.npc.y });
          return null;
        }
        const ent = findNpcEntity(snap, h.npc);
        if (!ent) return finish(false, `no Healer at ${h.npc.x},${h.npc.y}`);
        await dialog.start(ent, healChooser);
        h.stage = 'talk';
        return null;
      }
      case 'talk': {
        const done = await dialog.tick(snap);
        if (!done) return null;
        // Judge by HP, not by the window: some healers heal on click with no dialog at all,
        // and a closed window proves nothing.
        h.stage = 'verify';
        h.verifyAt = Date.now();
        h.dialogNote = done.reason;
        return null;
      }
      case 'verify':
        if (h.cleanse ? !weaponBlocked(me) : !needs(me)) return finish(true, `healed (${h.dialogNote})`);
        if (Date.now() - h.verifyAt > 3000) return finish(false, `${h.cleanse ? "weapon-blocking status remains" : "HP/SP not restored"} (${h.dialogNote})`);
        return null;
      default:
        return null;
    }
  }

  return {
    maybeStart,
    tick,
    get active() {
      return h.active;
    },
  };
}
