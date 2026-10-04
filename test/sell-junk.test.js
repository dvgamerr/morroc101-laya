import { test, expect, mock } from 'bun:test';
import { chromium } from 'playwright';
mock.module('../src/logger.js', () => ({ log() {} }));
const { sellJunk } = await import('../src/sell-junk.js');

test('junk sale deselects protected items across redraws and sells only the remainder', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    for (const onlyProtected of [false, true]) {
      await page.setContent('<div id="NpcStore"><button class="junk">ขายขยะ</button></div>');
      await page.evaluate(onlyProtected => {
        window.RO = { JunkData: { isReady: () => true } };
        window.sold = [];
        document.querySelector('.junk').onclick = () => {
          const host = document.createElement('div'); document.body.append(host);
          const root = host.attachShadow({ mode: 'open' });
          const rows = [{ id: 985, checked: true }, { id: 501, checked: true }, ...(!onlyProtected ? [{ id: 909, checked: true }] : [])];
          function draw() {
            root.innerHTML = '<div class="SellJunk"><div class="content">' + rows.map((r, i) => `<div class="row" data-row="${i}"><button class="checkbox" data-checked="${r.checked ? 1 : 0}">check</button><div class="icon" data-item="${r.id}"></div><span class="amount">x5</span></div>`).join('') + '</div><div class="footer"><button class="ok">Sell</button><button class="cancel">Cancel</button></div></div>';
            root.querySelectorAll('.checkbox').forEach((button, i) => button.onclick = () => { rows[i].checked = !rows[i].checked; draw(); });
            root.querySelector('.ok').onclick = () => { window.sold = rows.filter(r => r.checked).map(r => r.id); host.remove(); };
            root.querySelector('.cancel').onclick = () => host.remove();
          }
          draw();
        };
      }, onlyProtected);
      const snap = { me: { jobId: 0 }, shop: { stage: 'sell' }, inventory: [
        { ITID: 985, name: 'Elunium', count: 5 }, { ITID: 501, name: 'Red Potion', count: 5 }, { ITID: 909, name: 'Jellopy', count: 5 },
      ] };
      const result = await sellJunk(page, snap);
      expect(result.count).toBe(onlyProtected ? 0 : 5);
      expect(await page.evaluate(() => window.sold)).toEqual(onlyProtected ? [] : [909]);
      expect(await page.locator('.SellJunk').count()).toBe(0);
    }
  } finally { await browser.close(); }
});
