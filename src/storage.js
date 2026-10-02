import { act } from './browser.js';
import { log } from './logger.js';
import { learn } from './lessons.js';
import { isTown } from './world.js';
import { FORBIDDEN, findNpcEntity } from './npc.js';

const CARD = 6;
const KAFRA = /^kafra( employee| service| staff)?$/i;
const TALK_RANGE = 3;
const WALK_TIMEOUT_MS = 60000;
const OPEN_TIMEOUT_MS = 6000;
const PUT_GAP_MS = 400;
const VERIFY_MS = 4000;
const RETRY_AFTER_MS = 2 * 60 * 1000;
const GONE_CONFIRM_MS = 1500;

/** Menu chooser for a Kafra: "Use Storage" (or "yes" to its confirmation); never anything forbidden. */
export const storageChooser = {
  goal: 'open Kafra storage to deposit cards',
  rules(options) {
    const ok = options.map((o, i) => ({ o, i })).filter(({ o }) => o && !FORBIDDEN.test(o));
    const store = ok.find(({ o }) => /(storage|คลัง|โกดัง|ฝาก)/i.test(o) && !/(guild|กิลด์)/i.test(o)) || ok.find(({ o }) => /^(yes|ok|okay|sure|ใช่|ตกลง)\b/i.test(o));
    return store ? { index: store.i, why: 'storage' } : null;
  },
};

/** Cards in the bag that aren't slotted into gear. */
export const cardsIn = (inv) => (inv || []).filter((i) => i.type === CARD && i.count > 0 && !i.equipped);

/**
 * Owner's rule: cards are kept, never sold — into Kafra storage. In a town with a Kafra and
 * cards in the bag (typically right after a shopping trip): walk over, open storage, put
 * every card in, close it.
 */
export function createStorage(page, world, dialog) {
  const s = { active: false, stage: 'idle', npc: null, startedAt: 0, stageAt: 0, cooldownUntil: 0, lastPutAt: 0, stored: 0 };

  function kafraHere(map) {
    return (world?.npcs || []).filter((n) => n.map === map && KAFRA.test(n.name));
  }

  function maybeStart(snap) {
    if (s.active || Date.now() < s.cooldownUntil || !world) return false;
    const me = snap.me;
    if (!cardsIn(snap.inventory).length || !isTown(world, me.map)) return false;
    const d = (n) => Math.max(Math.abs(n.x - me.x), Math.abs(n.y - me.y));
    const npc = kafraHere(me.map).sort((a, b) => d(a) - d(b))[0];
    if (!npc) return false;
    const startCards = cardsIn(snap.inventory).reduce((n, c) => n + c.count, 0);
    Object.assign(s, { active: true, stage: 'walk', npc, startedAt: Date.now(), stageAt: Date.now(), stored: 0, startCards, tries: new Map(), lastPutAt: 0, goneSince: 0 });
    log('storage_start', { map: me.map, npc: `${npc.name} ${npc.x},${npc.y}`, cards: cardsIn(snap.inventory).map((c) => `${c.name} x${c.count}`).join(', ') });
    return true;
  }

  function to(stage) {
    s.stage = stage;
    s.stageAt = Date.now();
  }

  async function finish(ok, note, snap) {
    if (snap?.storage) await act(page, 'storage_close');
    log(ok ? 'storage_done' : 'storage_failed', { note, stored: s.stored });
    if (!ok && s.npc) learn(`ฝากการ์ดที่ ${s.npc.name} (${s.npc.map}) ไม่สำเร็จ: ${note}`);
    s.cooldownUntil = Date.now() + RETRY_AFTER_MS;
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
        if (d > TALK_RANGE) {
          if (Date.now() - s.startedAt > WALK_TIMEOUT_MS) return finish(false, 'could not reach the Kafra', snap);
          if (me.sitting) await act(page, 'stand');
          if (!me.walking) await act(page, 'walk_to', { x: s.npc.x, y: s.npc.y });
          return null;
        }
        const ent = findNpcEntity(snap, s.npc);
        if (!ent) return finish(false, `no Kafra at ${s.npc.x},${s.npc.y}`, snap);
        await dialog.start(ent, storageChooser);
        to('talk');
        return null;
      }
      case 'talk': {
        // The storage window can open while the script is still "talking" (openstorage; end).
        if (snap.storage?.open) {
          to('put');
          return null;
        }
        const done = await dialog.tick(snap);
        if (!done) return null;
        to('open');
        return null;
      }
      case 'open':
        if (snap.storage?.open) to('put');
        else if (Date.now() - s.stageAt > OPEN_TIMEOUT_MS) return finish(false, 'storage did not open (fee? menu?)', snap);
        return null;
      case 'put': {
        const cards = cardsIn(snap.inventory);
        s.stored = Math.max(0, s.startCards - cards.reduce((n, c) => n + c.count, 0));
        // "No cards left" must hold for a moment on a real bag: the inventory refreshes in pieces
        // around storage windows, and one such read once reported 6 cards stored that never moved.
        if (!cards.length && (snap.inventory || []).length) {
          s.goneSince ||= Date.now();
          if (Date.now() - s.goneSince >= GONE_CONFIRM_MS) return finish(true, 'all cards stored', snap);
          return null;
        }
        s.goneSince = 0;
        if (Date.now() - s.lastPutAt < PUT_GAP_MS) return null;
        // Each stack gets two tries; one that won't go in (storage full, no-storage item) is left.
        const c = cards.find((k) => (s.tries.get(k.index) || 0) < 2);
        if (!c) {
          if (Date.now() - s.lastPutAt < VERIFY_MS) return null;
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
    get active() {
      return s.active;
    },
  };
}
