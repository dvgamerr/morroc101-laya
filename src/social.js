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
