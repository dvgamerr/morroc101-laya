import { act } from './browser.js';
import { log } from './logger.js';

const TRADE_TIMEOUT_MS = 60000;

/**
 * Someone opens a trade with us: accept it, put NOTHING of ours in, and confirm only
 * when they have actually put zeny or items in and locked. Anything else is cancelled.
 * There is no code path here (or in page-agent) that adds our items or zeny.
 */
export function createTrader(page) {
  const t = { lockedAt: 0, okSent: false, openedAt: 0 };

  /** @returns {{ok, from, zeny, items}|null} when a trade finishes. */
  async function tick(snap) {
    const tr = snap.trade;
    if (!tr) {
      t.lockedAt = 0;
      t.okSent = false;
      return null;
    }
    const now = Date.now();
    if (tr.stage === 'requested') {
      t.openedAt = now;
      await act(page, 'trade_accept');
      log('trade_accept', { from: tr.from });
      return null;
    }
    if (tr.stage !== 'open') return null;
    if (now - t.openedAt > TRADE_TIMEOUT_MS) {
      await act(page, 'trade_cancel');
      log('trade_cancel', { from: tr.from, why: 'timeout' });
      return null;
    }
    const gets = (tr.zeny || 0) > 0 || tr.items.length > 0;
    // They locked: lock our (empty) side only if they're giving something; otherwise walk away.
    if (tr.otherLocked && !tr.selfLocked && !t.lockedAt) {
      if (!gets) {
        await act(page, 'trade_cancel');
        log('trade_cancel', { from: tr.from, why: 'they locked with nothing in it' });
        return null;
      }
      t.lockedAt = now;
      await act(page, 'trade_lock');
      log('trade_lock', { from: tr.from, zeny: tr.zeny, items: tr.items.length });
      return null;
    }
    if (tr.otherLocked && tr.selfLocked && !t.okSent && gets) {
      t.okSent = true;
      await act(page, 'trade_ok');
      log('trade_ok', { from: tr.from, zeny: tr.zeny, items: tr.items.length });
    }
    return null;
  }

  return { tick };
}

const BEG_PER_PLAYER_MS = 60 * 60 * 1000; // each player at most once an hour
const BEG_GAP_MS = 2 * 60 * 1000; // and never more often than this overall
const BEG_RANGE = 6;
const LINGER_MS = 20000; // give them a moment to answer or open a trade
const BEG_TOWNS = new Set(['morocc']);
// Cute and polite, never pushy, never pretending to be in trouble.
const BEG_LINES = [
  (n) => `${n} จ๋า ขอค่ายาสักนิดได้ไหมคะ 🥺`,
  (n) => `สวัสดีค่ะ ${n} ขอแบ่งค่ายาหน่อยได้ไหมคะ จะตั้งใจเก็บเลเวลค่ะ 🙏`,
  (n) => `${n} ใจดีจัง~ ขอ zeny นิดนึงไว้ซื้อยาได้ไหมคะ 💕`,
  (n) => `ขอโทษที่รบกวนนะคะ ${n} มีเศษ zeny แบ่งหนูซื้อยาสักหน่อยได้ไหมคะ 🥹`,
];

/**
 * In Morroc, ask a nearby player for a little zeny — cute and polite, never pushy:
 * once per player per hour, a couple of minutes between asks, and nobody who said no.
 */
export function createBeggar(page) {
  const b = { lastAt: 0, asked: new Map(), refused: new Set() };

  function candidate(snap) {
    if (!BEG_TOWNS.has(snap.me.map) || Date.now() - b.lastAt < BEG_GAP_MS) return null;
    return (snap.players || [])
      .filter((p) => p.name && p.name !== snap.me.name && p.dist > 0 && p.dist <= BEG_RANGE && !b.refused.has(p.name) && Date.now() - (b.asked.get(p.name) || 0) > BEG_PER_PLAYER_MS)
      .sort((a, c) => a.dist - c.dist)[0] || null;
  }

  /** Ask someone if it's the moment. @returns ms to stay around for an answer, or 0. */
  async function maybeAsk(snap) {
    const p = candidate(snap);
    if (!p) return 0;
    b.lastAt = Date.now();
    b.asked.set(p.name, Date.now());
    // Fixed lines, picked at random: the LLM's begging came out garbled Thai more than once.
    const line = BEG_LINES[Math.floor(Math.random() * BEG_LINES.length)](p.name);
    await act(page, 'say', { text: line });
    log('beg', { to: p.name, text: line });
    return LINGER_MS;
  }

  /** They said no (chat) — never ask them again. */
  function refused(name) {
    b.refused.add(name);
  }

  return { maybeAsk, refused };
}
