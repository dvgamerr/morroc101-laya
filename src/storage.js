import { act } from './browser.js';
import { log } from './logger.js';
import { learn } from './lessons.js';
import { isTown } from './world.js';
import { FORBIDDEN, findNpcEntity } from './npc.js';
import { readGearStorage, recordGearStorage } from './gear-goal.js';
import { oresIn } from './ores.js';

const KAFRA = /^kafra( employee| service| staff)?$/i;
const TALK_RANGE = 3;
const WALK_TIMEOUT_MS = 60000;
const OPEN_TIMEOUT_MS = 6000;
const PUT_GAP_MS = 400;
const VERIFY_MS = 4000;
const RETRY_AFTER_MS = 2 * 60 * 1000;
const GONE_CONFIRM_MS = 1500;
const UNSTORABLE_RETRY_MS = 30 * 60 * 1000; // an item that wouldn't go in (full, no-storage) isn't offered again for this long

/** Menu chooser for a Kafra: "Use Storage" (or "yes" to its confirmation); never anything forbidden. */
export const storageChooser = {
  goal: 'open Kafra storage to deposit individually reviewed items',
  rules(options) {
    const ok = options.map((o, i) => ({ o, i })).filter(({ o }) => o && !FORBIDDEN.test(o));
    const store = ok.find(({ o }) => /(storage|คลัง|โกดัง|ฝาก)/i.test(o) && !/(guild|กิลด์)/i.test(o)) || ok.find(({ o }) => /^(yes|ok|okay|sure|ใช่|ตกลง)\b/i.test(o));
    return store ? { index: store.i, why: 'storage' } : null;
  },
};

/**
 * Deposit ores as requested by the owner; other items require LAYA review.
 */
export function createStorage(page, world, dialog, review = null) {
  const s = { active: false, stage: 'idle', npc: null, startedAt: 0, stageAt: 0, cooldownUntil: 0, lastPutAt: 0, stored: 0, unstorable: new Map() };
  const selected = (snap) => [...new Map([...oresIn(snap), ...(review?.storageItems(snap) || [])].map(i => [i.index, i])).values()]
    .filter((i) => (s.unstorable.get(i.ITID) || 0) <= Date.now())
    .filter((i) => !s.active || s.selected?.get(i.index) === i.ITID);

  function kafraHere(map) {
    return (world?.npcs || []).filter((n) => n.map === map && KAFRA.test(n.name));
  }

  function maybeStart(snap, gearRequest = []) {
    if (s.active || Date.now() < s.cooldownUntil || !world) return false;
    const me = snap.me;
    const audit = !readGearStorage();
    if ((!audit && !gearRequest.length && !selected(snap).length) || !isTown(world, me.map)) return false;
    const d = (n) => Math.max(Math.abs(n.x - me.x), Math.abs(n.y - me.y));
    const npc = kafraHere(me.map).sort((a, b) => d(a) - d(b))[0];
    if (!npc) return false;
    const items = selected(snap);
    const startCards = items.reduce((n, c) => n + c.count, 0);
    Object.assign(s, { active: true, stage: 'walk', audit, npc, startedAt: Date.now(), stageAt: Date.now(), stored: 0, startCards, selected: new Map(items.map((i) => [i.index, i.ITID])), tries: new Map(), lastPutAt: 0, goneSince: 0 });
    s.gearRequest = gearRequest;
    s.pendingTake = null;
    log('storage_start', { map: me.map, npc: `${npc.name} ${npc.x},${npc.y}`, items: items.map((c) => `${c.name} x${c.count}`).join(', ') });
    return true;
  }

  function to(stage) {
    s.stage = stage;
    s.stageAt = Date.now();
  }

  async function finish(ok, note, snap) {
    if (snap?.storage) await act(page, 'storage_close');
    log(ok ? 'storage_done' : 'storage_failed', { note, stored: s.stored });
    if (!ok && s.npc) learn(`ฝากไอเทมที่ ${s.npc.name} (${s.npc.map}) ไม่สำเร็จ: ${note}`);
    // A completed withdrawal must not block depositing the leftover ores on
    // the very next shopping trip. Back off only failed/partial operations.
    s.cooldownUntil = ok && !note.startsWith('not stored:') ? 0 : Date.now() + RETRY_AFTER_MS;
    Object.assign(s, { active: false, stage: 'idle' });
    return { ok, note, stored: s.stored };
  }

  /** @returns null while busy, or {ok, note, stored} when done. */
  async function tick(snap) {
    if (!s.active) return null;
    const me = snap.me;
    if (me.map !== s.npc.map) return finish(false, 'left the town', snap);
    switch (s.stage) {
      case 'walk': {
        const d = Math.max(Math.abs(me.x - s.npc.x), Math.abs(me.y - s.npc.y));
        if (Date.now() - s.startedAt > WALK_TIMEOUT_MS) {
          log('storage_approach_blocked', { map: me.map, x: me.x, y: me.y,
            npc: s.npc.name, targetX: s.npc.x, targetY: s.npc.y, distance: d,
            walking: !!me.walking, dialog: snap.dialog?.state, shop: snap.shop?.stage });
          return finish(false, 'could not reach the Kafra', snap);
        }
        // Arrival scripts (notably Geffen) and leftover shops can prevent
        // walking or talking. Re-read after each action before approaching.
        if (snap.shop) {
          await act(page, snap.shop.stage === 'barter' ? 'barter_close' : 'close_shop');
          return null;
        }
        if (snap.dialog && snap.dialog.state !== 'ended') {
          const action = snap.dialog.state === 'next' ? 'npc_next'
            : snap.dialog.state === 'menu' ? 'npc_menu' : 'npc_close';
          const closed = await act(page, action, { naid: snap.dialog.naid,
            ...(action === 'npc_menu' ? { num: 255 } : {}) });
          log('storage_approach_dialog', { state: snap.dialog.state, action, closed });
          return null;
        }
        if (d > TALK_RANGE) {
          if (me.sitting) await act(page, 'stand');
          if (!me.walking) await act(page, 'walk_to', { x: s.npc.x, y: s.npc.y });
          return null;
        }
        const ent = findNpcEntity(snap, s.npc);
        if (!ent) return finish(false, `no Kafra at ${s.npc.x},${s.npc.y}`, snap);
        await dialog.start(ent, s.gearRequest.length || s.audit ? { ...storageChooser, goal: 'inspect Kafra and withdraw existing gear/refining materials for +9 goal' } : storageChooser);
        to('talk');
        return null;
      }
      case 'talk': {
        // The storage window can open while the script is still "talking" (openstorage; end).
        if (snap.storage?.open) {
          to('audit');
          return null;
        }
        const done = await dialog.tick(snap);
        if (!done) return null;
        to('open');
        return null;
      }
      case 'open':
        if (snap.storage?.open) to('audit');
        else if (Date.now() - s.stageAt > OPEN_TIMEOUT_MS) return finish(false, 'storage did not open (fee? menu?)', snap);
        return null;
      case 'audit': {
        if (Date.now() - s.stageAt < 1000) return null;
        if (recordGearStorage(snap)) {
          log('gear_storage_audit', { items: snap.storage.items.length });
          if (s.gearRequest.length) { to('gear_take'); return null; }
          if (!s.selected.size) return finish(true, 'Kafra inventory recorded for +9 gear goal', snap);
          to('put');
        } else if (Date.now() - s.stageAt > OPEN_TIMEOUT_MS) return finish(false, 'storage item list incomplete', snap);
        return null;
      }
      case 'gear_take': {
        const count = id => (snap.inventory || []).filter(i => i.ITID === id).reduce((n,i) => n+i.count, 0) + (snap.worn || []).filter(i => i.ITID === id).length;
        if (s.pendingTake) {
          if (count(s.pendingTake.id) > s.pendingTake.before) s.pendingTake = null;
          else if (Date.now() - s.lastPutAt > VERIFY_MS) return finish(false, 'gear withdrawal was not confirmed', snap);
          else return null;
        }
        for (const need of s.gearRequest) {
          const missing = need.count - count(need.id);
          const item = snap.storage?.items?.find(i => i.ITID === need.id && i.count > 0);
          if (missing <= 0 || !item) continue;
          if (snap.me.maxWeight && snap.me.weight / snap.me.maxWeight >= 0.8) return finish(false, 'too heavy to withdraw gear supplies', snap);
          const amount = Math.min(missing, item.count);
          s.pendingTake = { id: need.id, before: count(need.id) };
          s.lastPutAt = Date.now();
          await act(page, 'storage_get', { index: item.index, ITID: item.ITID, count: amount });
          log('gear_storage_take', { item: item.name, count: amount });
          return null;
        }
        recordGearStorage(snap);
        return finish(true, 'gear and refining materials checked/withdrawn from Kafra', snap);
      }
      case 'put': {
        const cards = selected(snap);
        const remaining = snap.inventory.filter((i) => s.selected.get(i.index) === i.ITID);
        s.stored = Math.max(0, s.startCards - remaining.reduce((n, c) => n + c.count, 0));
        // "No cards left" must hold for a moment on a real bag: the inventory refreshes in pieces
        // around storage windows, and one such read once reported 6 cards stored that never moved.
        if (!remaining.length && (snap.inventory || []).length) {
          s.goneSince ||= Date.now();
          if (Date.now() - s.goneSince >= GONE_CONFIRM_MS) return finish(true, 'reviewed items stored', snap);
          return null;
        }
        s.goneSince = 0;
        if (Date.now() - s.lastPutAt < PUT_GAP_MS) return null;
        // Each stack gets two tries; one that won't go in (storage full, no-storage item) is left.
        const c = cards.find((k) => (s.tries.get(k.index) || 0) < 2);
        if (!c) {
          if (Date.now() - s.lastPutAt < VERIFY_MS) return null;
          // Remember what wouldn't go in, so the next visit (and its Kafra fee) isn't spent on it again.
          for (const k of cards) s.unstorable.set(k.ITID, Date.now() + UNSTORABLE_RETRY_MS);
          return finish(s.stored > 0, `not stored: ${cards.map((k) => k.name).join(', ')}`, snap);
        }
        s.tries.set(c.index, (s.tries.get(c.index) || 0) + 1);
        s.lastPutAt = Date.now();
        await act(page, 'storage_put', { index: c.index, count: c.count });
        log('storage_put', { item: c.name, count: c.count });
        return null;
      }
      default:
        return null;
    }
  }

  return {
    maybeStart,
    tick,
    get retryAt() { return s.cooldownUntil; },
    get active() {
      return s.active;
    },
  };
}
