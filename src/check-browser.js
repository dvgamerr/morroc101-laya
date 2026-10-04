// Headless check that the Config.local.js override really brings up window.RO
// and that the page agent attached its packet observer. Does not log in.
import { chromium } from 'playwright';

// This check never calls LAYA or the LLM, but config.js throws when their keys are missing.
process.env.LAYA_API_KEY ||= 'check-browser';
process.env.OMLX_API_KEY ||= 'check-browser';
const { config } = await import('./config.js');
const { installPageAgent } = await import('./page-agent.js');
const { forceDevelopmentMode } = await import('./browser.js');

const channel = config.game.browserChannel === 'chromium' ? undefined : config.game.browserChannel;
const browser = await chromium.launch({ channel, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block' });
await forceDevelopmentMode(context);
await context.addInitScript(installPageAgent);
const page = await context.newPage();
page.on('dialog', (d) => d.accept().catch(() => {}));

let ok = false;
try {
  await page.goto(config.game.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.RO && window.__agent?.attached, null, { timeout: 60000 });
  const info = await page.evaluate(() => ({
    development: window.ROConfig?.development,
    roKeys: Object.keys(window.RO).length,
    attached: window.__agent.attached,
    naviRoute: ['setOptions', 'setDestination', 'getLeg', 'getAheadCell', 'isLost'].every((f) => typeof window.RO.NaviRoute?.[f] === 'function'),
    naviData: window.RO.NaviData?.isReady?.() ?? null,
    snapshot: window.__agent.snapshot(),
  }));
  console.log('browser ok', JSON.stringify(info));
  ok = info.development === true && info.attached && info.naviRoute;
} catch (err) {
  console.error('browser failed:', err.message);
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);
