import { test, expect, mock, beforeAll, afterAll } from 'bun:test';
import { chromium } from 'playwright';
mock.module('../src/logger.js', () => ({ log() {} }));
const { createReconnect } = await import('../src/reconnect.js');
let browser;
beforeAll(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
afterAll(async () => { await browser?.close(); });

test('login submits populated credentials and rejects stale inGame after the cooldown', async () => {
  const page = await browser.newPage();
  const originalNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  try {
    await page.setContent('<section id="WinLogin"><input class="user" value="fixture"><input class="pass" type="password" value="fixture"><button class="connect">Login</button></section>');
    await page.evaluate(() => {
      window.RO = { Session: { Playing: true, Entity: {} } };
      window.submissions = 0;
      document.querySelector('.connect').onclick = () => { window.submissions++; document.querySelector('section').remove(); };
    });
    const reconnect = createReconnect(page);
    const stale = { inGame: true, me: { name: 'Hero' } };
    expect(await reconnect(stale)).toBe(true);
    expect(await page.evaluate(() => window.submissions)).toBe(1);
    now += 15000;
    expect(await reconnect(stale)).toBe(true);
    await page.evaluate(() => { window.RO.Session.Entity = {}; });
    now += 1000;
    expect(await reconnect(stale)).toBe(false);
  } finally { Date.now = originalNow; await page.close(); }
});

test('empty login stays blocked without submitting or accepting stale inGame', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<section id="WinLogin"><input class="user"><input class="pass" type="password"><button class="connect">Login</button></section>');
    await page.evaluate(() => {
      window.submissions = 0;
      document.querySelector('.connect').onclick = () => window.submissions++;
    });
    expect(await createReconnect(page)({ inGame: true, me: { name: 'Hero' } })).toBe(true);
    expect(await page.evaluate(() => window.submissions)).toBe(0);
  } finally { await page.close(); }
});
