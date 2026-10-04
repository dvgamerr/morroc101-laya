import { isOre } from './ores.js';
import { isProtectedEquipment } from './equipment-memory.js';
import { keepForGear } from './gear-goal.js';
import { isHealing } from './potion-loadout.js';

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
  const chosen = await panel.locator('.row:has(.checkbox[data-checked="1"])').evaluateAll(rows => rows.map(row => ({
    ITID: Number(row.querySelector('.icon').dataset.item),
    count: Number(row.querySelector('.amount').textContent.replace(/^x/, '')),
  })));
  // Preserve equipment and supplies protection even if the client has a saved override.
  const unsafe = chosen.some(row => {
    const items = snap.inventory.filter(i => i.ITID === row.ITID);
    return !items.length || !Number.isInteger(row.count) || row.count <= 0 || items.some(i =>
      i.equipped || i.keep || isOre(i) || isHealing(i) || isProtectedEquipment(i) || keepForGear(i, snap) ||
      [601, 602, 611, 23280, 12323, 12324].includes(i.ITID));
  });
  if (unsafe || !chosen.length) {
    await panel.locator('.footer .cancel').click({ timeout: 1200 });
    if (unsafe) throw new Error('junk selection contains protected items');
    return { count: 0 };
  }
  await panel.locator('.footer .ok').click({ timeout: 1200 });
  return { count: chosen.reduce((sum, i) => sum + i.count, 0), items: chosen };
}
