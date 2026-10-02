import { act } from './browser.js';
import { log } from './logger.js';
import { healRange } from './potions.js';

// The shortcut bar, as the owner wants it: 3 rows of 9.
//   F1-F8 buffs; F9 (slot 8) Item Appraisal / Magnifier
//   1-9    (slots 9-17)  attack skills
//   Q-O    (slots 18-26) items: HP potions, SP potion, Novice Fly/Butterfly Wing
export const ROWS = { buffs: 0, attacks: 9, items: 18 };
export const KEY_NAMES = [
  ...['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9'],
  ...['1', '2', '3', '4', '5', '6', '7', '8', '9'],
  ...['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O'],
];

const SP_ITEMS = [505, 510, 518, 526, 11502, 11503];
const WINGS = [23280, 12323, 601, 12324]; // Novice Fly Wing, Fly Wing (only what's in the bag), Novice Butterfly Wing
const SYNC_EVERY_MS = 10000;

/**
 * Keeps the client's shortcut bar laid out from what the agent uses, and uses
 * things by pressing their slot — the same path as the player pressing the key
 * (ShortCut.onShortCut EXECUTE<n>), so it shows on screen and needs no keyboard
 * focus. Slot changes are saved to the server like a drag-and-drop would.
 */
export function createHotkeys(page) {
  const h = { slots: new Map(), lastSyncAt: 0 }; // slot -> "s:ID" | "i:ID"
  const where = new Map(); // "s:ID" | "i:ID" -> slot

  /**
   * What should sit in each slot now. A skill or item already on the bar keeps its
   * key (the order of buffs can shift between plans; keys shouldn't move with it),
   * new ones fill the free slots of their row.
   */
  function layout(snap, book) {
    const want = new Map();
    const skills = snap.me.skills || [];
    const lvl = (id) => skills.find((s) => s.id === id)?.level || 0;
    const inv = snap.inventory || [];
    const heals = inv.filter((i) => i.count > 0 && healRange(i.ITID) && !SP_ITEMS.includes(i.ITID));
    // strongest first, so Q is the big bottle
    heals.sort((a, b) => healRange(b.ITID)[0] - healRange(a.ITID)[0]);
    const items = [...heals, ...inv.filter((i) => i.count > 0 && SP_ITEMS.includes(i.ITID)), ...inv.filter((i) => i.count > 0 && WINGS.includes(i.ITID))];
    const rows = [
      [ROWS.buffs, book.buffs.filter(lvl).map((id) => ({ isSkill: true, ID: id, count: lvl(id) }))],
      [ROWS.attacks, [...book.attack, ...book.aoe].filter(lvl).map((id) => ({ isSkill: true, ID: id, count: lvl(id) }))],
      [ROWS.items, items.map((it) => ({ isSkill: false, ID: it.ITID, count: it.count }))],
    ];
    for (const [start, entries] of rows) {
      const slotsOfRow = Array.from({ length: start === ROWS.buffs ? 8 : 9 }, (_, i) => start + i);
      const pending = [];
      for (const e of entries.slice(0, slotsOfRow.length)) {
        const keep = slotsOfRow.find((sl) => h.slots.get(sl) === `${e.isSkill ? 's' : 'i'}:${e.ID}`);
        if (keep !== undefined) want.set(keep, e);
        else pending.push(e);
      }
      for (const e of pending) {
        const free = slotsOfRow.find((sl) => !want.has(sl));
        if (free !== undefined) want.set(free, e);
      }
    }
    if (lvl(40)) want.set(8, { isSkill: true, ID: 40, count: lvl(40) });
    else if (inv.some((i) => i.ITID === 611 && i.count > 0)) want.set(8, { isSkill: false, ID: 611, count: 1 });
    return want;
  }

  /** Put the layout on the bar, changing only slots that differ. */
  async function sync(snap, book) {
    if (Date.now() - h.lastSyncAt < SYNC_EVERY_MS) return;
    h.lastSyncAt = Date.now();
    const want = layout(snap, book);
    for (const [slot, s] of want) {
      const key = `${s.isSkill ? 's' : 'i'}:${s.ID}`;
      if (h.slots.get(slot) === key) continue;
      await act(page, 'hotkey_set', { index: slot, isSkill: s.isSkill, ID: s.ID, count: s.count });
      h.slots.set(slot, key);
      log('hotkey_set', { key: KEY_NAMES[slot], what: key });
    }
    where.clear();
    for (const [slot, key] of h.slots) where.set(key, slot);
  }

  /** Press the slot holding this skill/item. false if it isn't on the bar. */
  async function press(kind, ID) {
    const slot = where.get(`${kind === 'skill' ? 's' : 'i'}:${ID}`);
    if (slot === undefined) return false;
    await act(page, 'hotkey_press', { index: slot });
    return true;
  }

  return { sync, press, layout, slots: h.slots };
}
