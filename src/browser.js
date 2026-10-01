import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { config } from './config.js';
import { installPageAgent } from './page-agent.js';

const CDP_URL = `http://127.0.0.1:${config.game.cdpPort}`;

/**
 * The browser is its own process, started detached with a debugging port, and
 * the agent only connects to it. Stopping or restarting the agent leaves the
 * window, the login and the game session exactly where they were; the next
 * `bun start` reconnects to the same tab.
 */
export async function openGame() {
  const running = await cdpReady();
  if (!running) await launchDetached();
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];

  await forceDevelopmentMode(context);
  await context.addInitScript(blockServiceWorker);
  await context.addInitScript(installPageAgent);

  let page = context.pages().find((p) => p.url().startsWith(config.game.url));
  let reused = false;
  if (page) {
    page.on('dialog', (d) => d.accept().catch(() => {}));
    if (await page.evaluate(() => !!window.RO).catch(() => false)) {
      // Init scripts only reach new documents; put the current agent into this one by hand.
      await page.evaluate(installPageAgent);
      reused = true;
    } else {
      // Loaded while no agent was connected, so without development mode: there is no
      // window.RO to drive. Only a reload fixes that (and it means logging in again).
      await page.reload({ waitUntil: 'domcontentloaded' });
    }
  } else {
    page = context.pages().find((p) => p.url() === 'about:blank') || (await context.newPage());
    page.on('dialog', (d) => d.accept().catch(() => {}));
    await page.goto(config.game.url, { waitUntil: 'domcontentloaded' });
  }
  await page.bringToFront().catch(() => {});
  return { browser, context, page, reused, launched: !running };
}

async function cdpReady() {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const candidates = {
    chrome: [
      join(pf, 'Google/Chrome/Application/chrome.exe'),
      join(pf86, 'Google/Chrome/Application/chrome.exe'),
      join(local, 'Google/Chrome/Application/chrome.exe'),
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome',
    ],
    msedge: [
      join(pf86, 'Microsoft/Edge/Application/msedge.exe'),
      join(pf, 'Microsoft/Edge/Application/msedge.exe'),
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
  };
  const list = candidates[config.game.browserChannel] || [];
  const exe = list.find((p) => existsSync(p)) || (config.game.browserChannel === 'chromium' ? chromium.executablePath() : null);
  if (!exe) throw new Error(`cannot find ${config.game.browserChannel}; set CHROME_PATH in .env`);
  return exe;
}

async function launchDetached() {
  const child = spawn(
    findBrowser(),
    [
      `--remote-debugging-port=${config.game.cdpPort}`,
      `--user-data-dir=${resolve('.browser-profile')}`,
      '--start-maximized',
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await cdpReady()) return;
    await Bun.sleep(500);
  }
  throw new Error(`browser started but its debugging port ${config.game.cdpPort} never answered`);
}

/**
 * roBrowser installs window.RO only in development mode. Flip it for this
 * browser only by appending an override after the server's own Config.local.js.
 */
export async function forceDevelopmentMode(context) {
  await context.route('**/Config.local.js*', async (route) => {
    let body = '';
    try {
      const res = await route.fetch();
      body = await res.text();
    } catch {}
    body += '\n;window.ROConfigLocal = Object.assign(window.ROConfigLocal || {}, { development: true });\n';
    await route.fulfill({ status: 200, contentType: 'application/javascript', body });
  });
}

// A service worker would serve Config.local.js from its cache, past the route above.
// A CDP-attached context can't use Playwright's serviceWorkers:'block', so do it in-page.
function blockServiceWorker() {
  const sw = navigator.serviceWorker;
  if (!sw) return;
  try {
    sw.register = () => Promise.reject(new Error('service worker blocked by agent'));
    sw.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
  } catch {}
}

export async function waitForInGame(page, onWait) {
  for (;;) {
    const snap = await snapshot(page).catch(() => null);
    if (snap?.inGame) return snap;
    onWait?.(snap);
    await Bun.sleep(2000);
  }
}

export const snapshot = (page) => page.evaluate(() => window.__agent?.snapshot() ?? { ready: false });
export const drainEvents = (page) => page.evaluate(() => window.__agent?.drain() ?? []);
export const act = (page, name, arg) => page.evaluate(([n, a]) => window.__agent.act(n, a), [name, arg ?? {}]);
