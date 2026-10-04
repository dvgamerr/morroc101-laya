import { chromium } from 'playwright';
import { ensureBrowser } from './browser-start.js';
import { config } from './config.js';
import { installPageAgent } from './page-agent.js';
import { withNames } from './skilldb.js';
import { clickGameUi, UI_ACTIONS } from './ui-click.js';
import { log } from './logger.js';
import { isProtectedEquipment } from './equipment-memory.js';

const CDP_URL = `http://127.0.0.1:${config.game.cdpPort}`;

export function observeGameErrors(page) {
  page.on('dialog', async (dialog) => {
    log('game_dialog', { type: dialog.type(), message: dialog.message() });
    await dialog.accept().catch(() => {});
  });
  page.on('pageerror', (error) => log('game_error', { error: error.message }));
  page.on('console', (message) => {
    if (message.type() === 'error') log('game_error', { error: message.text() });
  });
}

/** Reuse Chrome when available; otherwise start a detached process with the same profile. */
export async function openGame() {
  await ensureBrowser({ port: config.game.cdpPort, fallbackExecutable: chromium.executablePath(), ready: cdpReady });
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];

  await forceDevelopmentMode(context);
  await context.addInitScript(blockServiceWorker);
  await context.addInitScript(installPageAgent);

  let page = context.pages().find((p) => p.url().startsWith(config.game.url));
  let reused = false;
  if (page) {
    observeGameErrors(page);
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
    observeGameErrors(page);
    await page.goto(config.game.url, { waitUntil: 'domcontentloaded' });
  }
  await page.bringToFront().catch(() => {});
  return { browser, context, page, reused };
}

async function cdpReady() {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * roBrowser installs window.RO only in development mode. Flip it for this
 * browser only by appending an override after the server's own Config.local.js.
 */
export async function forceDevelopmentMode(context) {
  await context.route('**/Config.local.js*', async (route) => {
    let res;
    let body;
    try {
      res = await route.fetch();
      body = await res.text();
    } catch (error) {
      // Never hand the client a Config.local.js without its own settings: it would boot in
      // production mode with no window.RO and the bot would wait for a game that cannot be driven.
      log('game_config_failed', { error: error.message });
      await route.abort('failed').catch(() => {});
      return;
    }
    if (!res.ok()) {
      // An error page is not JavaScript; appending to it breaks the client. Pass it through as is.
      log('game_config_failed', { status: res.status() });
      await route.fulfill({ response: res, body }).catch(() => {});
      return;
    }
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

// Logging in by hand the first time can take a while; waiting forever hides a broken client.
const IN_GAME_TIMEOUT_MS = 30 * 60 * 1000;

export async function waitForInGame(page, onWait, reconnect, { timeoutMs = IN_GAME_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await snapshot(page).catch(() => null);
    const recovering = reconnect ? await reconnect(snap) : false;
    if (snap?.inGame && !recovering) return snap;
    if (Date.now() >= deadline) throw new Error(`not in game after ${Math.round(timeoutMs / 1000)}s (ready=${snap?.ready ?? 'no snapshot'}, recovering=${recovering})`);
    onWait?.(snap);
    await Bun.sleep(2000);
  }
}

export async function snapshot(page) {
  const snap = await page.evaluate(() => window.__agent?.snapshot() ?? { ready: false });
  if (snap.me) {
    snap.me.skills = withNames(snap.me.skills);
    snap.me.skillTree = withNames(snap.me.skillTree);
  }
  return snap;
}
export const drainEvents = (page) => page.evaluate(() => window.__agent?.drain() ?? []);
export const query = (page, command, waitMs) => page.evaluate(([c, w]) => window.__agent.query(c, w), [command, waitMs]);
export const exploreTarget = (page, min, max, avoid) =>
  page.evaluate(([a, b, c]) => window.__agent.exploreTarget(a, b, c), [min, max, avoid ?? []]);
let escapeUntil = 0;
export const holdCombatForEscape = (durationMs = 3000) => { escapeUntil = Date.now() + durationMs; };
const INTERRUPTED_BY_ESCAPE = new Set(['attack', 'move', 'walk_to', 'skill', 'talk', 'navi_start']);
export const act = async (page, name, arg) => {
  if (name === 'sell') {
    const snap = await snapshot(page);
    // Say why: callers only see false, and a sale that silently never happens looks like a stuck shop.
    const blocked = (reason) => {
      log('sale_blocked', { reason });
      return false;
    };
    if (!snap?.inGame) return blocked('not in game');
    if (!Array.isArray(snap.inventory)) return blocked('inventory unreadable');
    if (!Array.isArray(snap.worn)) return blocked('worn equipment unreadable (Equipment window not ready)');
    const worn = new Set(snap.worn.map(i => i.ITID));
    if (!arg?.items?.length) return blocked('no items to sell');
    if (arg.items.some(request => {
      const item = snap.inventory.find(i => i.index === request.index);
      return !item || worn.has(item.ITID) || isProtectedEquipment(item);
    })) return blocked('protected equipment or unknown inventory item');
  }
  return Date.now() < escapeUntil && INTERRUPTED_BY_ESCAPE.has(name)
  ? Promise.resolve(false)
  : UI_ACTIONS.has(name)
  ? clickGameUi(page, name, arg ?? {})
  : page.evaluate(([n, a]) => window.__agent.act(n, a), [name, arg ?? {}]);
};
