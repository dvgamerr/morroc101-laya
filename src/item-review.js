import { act } from './browser.js';
import { config } from './config.js';
import { jobInfo } from './goals.js';
import { healRange, spRange } from './potions.js';
import * as laya from './laya.js';
import { log } from './logger.js';

const SUPPLIES = new Set([601, 602, 611, 12323, 12324]);
const unknown = (i) => !!i.gear && (i.gear.identified !== true || !i.gear.description || !i.name || /^(undefined|null|\d+)$/i.test(i.name));
const fingerprint = (i) => JSON.stringify([i.index, i.ITID, i.name, i.gear, i.description, i.keep]);
const contextKey = (s) => JSON.stringify([s.me.jobId, s.me.baseLevel, s.worn, config.build]);

/** LAYA reviews individual items; missing data or an uncertain answer means keep. */
export function createItemReview(page) {
  const cache = new Map();
  let busy = false;
  let retryAt = 0;
  let identifying = null;
  const identifyRetry = new Map();
  const candidates = (s) => (s.inventory || []).filter((i) => i.count > 0 && !i.equipped && !SUPPLIES.has(i.ITID) && !healRange(i.ITID) && !spRange(i.ITID));
  function decision(snap, item) {
    const d = cache.get(item.index);
    return d?.key === contextKey(snap) && d.item === fingerprint(item) && (!d.retryAt || Date.now() < d.retryAt) ? d : null;
  }
  function items(snap, action) {
    return candidates(snap).filter((i) => !unknown(i) && decision(snap, i)?.action === action && (action !== 'sell' || !i.keep));
  }
  function observe(snap) {
    if (busy || Date.now() < retryAt || snap.me.dead || snap.attackers?.length || !snap.inventory?.length || (snap.mapAgeMs ?? Infinity) < 15000) return;
    const pending = candidates(snap).filter((i) => !unknown(i) && !decision(snap, i)).slice(0, 6);
    if (!pending.length) return;
    busy = true;
    const key = contextKey(snap);
    const questions = Object.fromEntries(pending.map((i) => [`item_${i.index}`, {
      type: 'choice',
      instructions: `Decide for inventory index ${i.index} using its full description and the character's CURRENT class, level, build and worn equipment. For equipment: equip only if usable NOW and better overall in its slot (bonuses, refine, cards, slots and build, not just ATK/DEF); sell inferior/equal duplicates or unusable items with no useful future role. Store only a specifically useful future item. For cards/materials/other items decide individual usefulness, never store merely because of item type. If information is insufficient choose keep. Protected items cannot be sold.`,
      criteria: { keep: 'Keep in bag / defer uncertain decision', ...(!i.keep ? { sell: 'Sell unused or inferior item' } : {}), store: 'Store this item for a concrete future use', ...(i.gear && !i.gear.damaged && snap.worn && i.gear.loc && (i.gear.reqLv || 0) <= snap.me.baseLevel ? { equip: 'Wear now: compatible with current class and an upgrade over worn gear' } : {}) },
    }]));
    laya.ask({ character: { job: jobInfo(snap.me.jobId).name, level: snap.me.baseLevel, stats: snap.me.stats, build: config.buildDescription, classPath: config.classPath }, worn: snap.worn, inventory: candidates(snap), review: pending.map((i) => i.index) }, questions)
      .then((answers) => {
        for (const i of pending) {
          const a = answers[`item_${i.index}`];
          if (!a || !Object.hasOwn(questions[`item_${i.index}`].criteria, a.choice) || (a.confidence ?? a.answer_confidence ?? 0) < 0.6) {
            // Defer this item without starving every later item in the review queue.
            cache.set(i.index, { key, item: fingerprint(i), action: 'keep', retryAt: Date.now() + 120000 });
            continue;
          }
          cache.set(i.index, { key, item: fingerprint(i), action: a.choice });
          log('item_review', { item: i.name, index: i.index, action: a.choice, confidence: a.confidence ?? a.answer_confidence });
        }
      })
      .catch((err) => log('item_review_error', { error: err.message }))
      .finally(() => { busy = false; retryAt = Date.now() + 10000; });
  }
  async function identify(snap) {
    if (snap.me.dead || snap.attackers?.length) return false;
    const now = Date.now();
    if (identifying) {
      const item = snap.inventory.find((i) => i.index === identifying.index && i.ITID === identifying.ITID);
      if (!item || item.gear?.identified === true || now - identifying.at > 8000) {
        identifyRetry.set(identifying.ITID, now + 60000);
        identifying = null;
        return false;
      }
      if (!identifying.sent && snap.identify?.at >= identifying.at && snap.identify.indices.includes(item.index)) {
        identifying.sent = await act(page, 'identify', { index: item.index }) !== false;
      }
      return true;
    }
    const item = candidates(snap).find((i) => i.gear?.identified === false && now >= (identifyRetry.get(i.ITID) || 0));
    if (!item) return false;
    const skill = snap.me.skills?.find((s) => s.id === 40 && s.level > 0 && (s.sp || 0) <= snap.me.sp);
    const glass = snap.inventory.find((i) => i.ITID === 611 && i.count > 0);
    if (!skill && !glass) return false;
    identifying = { index: item.index, ITID: item.ITID, at: now };
    await act(page, 'hotkey_set', { index: 8, isSkill: !!skill, ID: skill ? 40 : 611, count: skill?.level || 1 });
    await act(page, 'hotkey_press', { index: 8 });
    log('item_appraisal', { index: item.index, key: 'F9' });
    return true;
  }
  return {
    observe, identify, decision,
    saleItems: (s) => items(s, 'sell'),
    storageItems: (s) => items(s, 'store'),
    pickEquip: (s) => {
      const i = items(s, 'equip').find((i) => i.gear?.identified && i.gear.loc && (i.gear.reqLv || 0) <= s.me.baseLevel);
      return i ? { index: i.index, loc: i.gear.loc, name: i.name, why: 'LAYA: usable upgrade for current class and build' } : null;
    },
  };
}
