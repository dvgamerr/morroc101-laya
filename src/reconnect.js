import { log } from './logger.js';

// Retries back off (a server that is down or a wrong password must not be hammered every few
// seconds) and a recovery that drags on is reported as an incident instead of failing silently.
const MAX_BACKOFF_MS = 2 * 60 * 1000;
const STUCK_REPORT_MS = 5 * 60 * 1000;

// Use the client's visible controls; standing still alone is not a disconnect.
export function createReconnect(page) {
  let character = '';
  let nextCheck = 0;
  let nextAction = 0;
  let recovering = false;
  let blocked = false;
  let lastState = '';
  let attempts = 0;
  let blockedSince = 0;
  let lastStuckReport = 0;
  // Delay before the next click: base, 2x, 4x ... capped. Reset once we are back in the game.
  const backoff = (base) => Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(attempts++, 6));
  async function beginRecovery() {
    if (!recovering) await page.evaluate(() => {
      window.__agentReconnectEntity = window.RO?.Session?.Entity;
    });
    recovering = blocked = true;
    blockedSince ||= Date.now();
  }
  const report = (state, detail = {}) => {
    const key = state + (detail.error ?? '');
    if (key === lastState) return;
    lastState = key;
    log('game_reconnect', { state, ...detail });
  };
  function reportStuck(now) {
    if (!blockedSince || now - blockedSince < STUCK_REPORT_MS || now - lastStuckReport < STUCK_REPORT_MS) return;
    lastStuckReport = now;
    log('game_reconnect_failed', { state: lastState, attempts, minutes: Math.round((now - blockedSince) / 60000), character });
  }

  return async function reconnect(snap) {
    const now = Date.now();
    if (now < nextCheck) return blocked;
    nextCheck = now + 1000;
    reportStuck(now);
    try {
      const popup = page.locator('#win_popup:visible').filter({
        has: page.locator('.text', { hasText: /disconnect|connection (?:lost|closed)|failed to connect|server closed/i }),
      });
      if (await popup.count()) {
        character ||= snap?.me?.name || '';
        await beginRecovery();
        const ok = popup.locator('button[data-background="btn_ok.bmp"]:visible');
        if (await ok.count() === 1 && now >= nextAction) {
          nextAction = now + backoff(5000);
          await ok.click({ timeout: 1200 });
          report('disconnect_ok', { character, attempts });
        } else report('waiting_for_client');
        return true;
      }

      const login = page.locator('section#WinLogin:visible');
      if (await login.count() === 1) {
        character ||= snap?.me?.name || '';
        await beginRecovery();
        if (now < nextAction) return true;
        // Check presence in the page; never return/log the credentials.
        const filled = await login.evaluate(el => !!el.querySelector('input.user')?.value && !!el.querySelector('input.pass')?.value);
        if (!filled) {
          report('waiting_for_login_credentials');
          return true;
        }
        const connect = login.locator('button.connect:visible');
        if (await connect.isEnabled()) {
          nextAction = now + backoff(10000);
          await connect.click({ timeout: 1200 });
          report('login_submitted', { attempts });
        }
        return true;
      }

      // Inner panels only: the client uses duplicate IDs on shadow hosts.
      const panel = page.locator('#CharSelectV4:has(> .char_select_container):visible, #charselect:has(> .charinfo):visible, #CharSelectV2:has(> .charinfo):visible, #CharSelectV3:has(> .charinfo):visible');
      if (await panel.count() === 1) {
        await beginRecovery();
        if (now < nextAction) return true;
        const cards = panel.locator('.char_canvas');
        if (await cards.count()) {
          const names = await cards.locator('.name').allTextContents();
          const occupied = names.map((name, index) => ({ name: name.trim(), index })).filter(c => c.name);
          const target = character ? occupied.find(c => c.name === character) : occupied.length === 1 ? occupied[0] : null;
          if (!target) {
            report('waiting_for_character', { character, reason: 'no unique matching character' });
            return true;
          }
          await cards.nth(target.index).locator('canvas').click({ timeout: 1200 });
          character = target.name;
        } else {
          const selected = (await panel.locator('.charinfo .name').textContent())?.trim();
          if (!selected || (character && selected !== character)) {
            report('waiting_for_character', { character });
            return true;
          }
          character = selected;
        }
        const ok = panel.locator('ui-button.ok:visible');
        if (await ok.count() === 1) {
          nextAction = now + backoff(10000);
          await ok.click({ timeout: 1200 });
          report('character_selected', { character, attempts });
        }
        return true;
      }
      const freshSession = !recovering || await page.evaluate(() => {
        const session = window.RO?.Session;
        return session?.Playing === true && !!session.Entity && session.Entity !== window.__agentReconnectEntity;
      });
      if (recovering && (!snap?.inGame || !freshSession || now < nextAction)) {
        blocked = true;
        report('waiting_for_game');
        return true;
      }
      if (recovering) report('in_game', { character: snap.me?.name });
      recovering = blocked = false;
      attempts = 0;
      blockedSince = 0;
      if (snap?.inGame && snap.me?.name) character = snap.me.name;
      return false;
    } catch (error) {
      // Reloads destroy the execution context while reconnecting, so a failed check is retried;
      // but it keeps the bot blocked, so it is recorded (and escalated by reportStuck).
      blocked = true;
      blockedSince ||= Date.now();
      report('retry', { error: error.message });
      return true;
    }
  };
}
