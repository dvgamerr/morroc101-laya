import { isOre } from './ores.js';
import { isProtectedEquipment } from './equipment-memory.js';
import { keepForGear } from './gear-goal.js';
import { isHealing } from './potion-loadout.js';
import { log } from './logger.js';

export async function sellJunk(page, snap) {
  if (snap.shop?.stage !== 'sell') return null;
  const ready = await page.evaluate(() => window.RO?.JunkData?.isReady?.() === true);
  if (!ready) return null;
  const button = page.locator('#NpcStore button.junk:visible');
  if (await button.count() !== 1) return null;
  if (await button.isDisabled()) return { count: 0 };
  await button.click({ timeout: 1200 });
  const panel = page.locator('.SellJunk:has(> .footer):visible');
  await panel.waitFor({ state: 'visible', timeout: 1200 });
  const readChosen = () => panel.locator('.row:has(.checkbox[data-checked="1"])').evaluateAll(rows => rows.map(row => ({
    row: row.dataset.row,
    ITID: Number(row.querySelector('.icon').dataset.item),
    count: Number(row.querySelector('.amount').textContent.replace(/^x/, '')),
  })));
  // Preserve equipment and supplies protection even if the client has a saved override.
  const unsafe = row => {
    const items = snap.inventory.filter(i => i.ITID === row.ITID);
    return !items.length || !Number.isInteger(row.count) || row.count <= 0 || items.some(i =>
      i.equipped || i.keep || isOre(i) || isHealing(i) || isProtectedEquipment(i) || keepForGear(i, snap) ||
      [601, 602, 611, 23280, 12323, 12324].includes(i.ITID));
  };
  const excluded = [];
  for (const item of (await readChosen()).filter(unsafe)) {
    if (!/^\d+$/.test(item.row || '')) {
      await panel.locator('.footer .cancel').click({ timeout: 1200 });
      return { count: 0, reason: 'junk row identity unavailable' };
    }
    const checkbox = panel.locator(`.row[data-row="${item.row}"] .checkbox[data-checked="1"]`);
    await checkbox.click({ timeout: 1200 });
    excluded.push(item.ITID);
  }
  if (excluded.length) log('junk_items_kept', { items: excluded });
  // Clicking a checkbox redraws the entire list. Verify the final selection
  // before confirming; never reuse stale row positions or broaden the sale.
  const chosen = await readChosen();
  if (chosen.some(unsafe) || !chosen.length) {
    await panel.locator('.footer .cancel').click({ timeout: 1200 });
    return { count: 0, excluded };
  }
  await panel.locator('.footer .ok').click({ timeout: 1200 });
  return { count: chosen.reduce((sum, i) => sum + i.count, 0), items: chosen };
}
