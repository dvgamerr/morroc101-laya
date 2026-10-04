import { log } from './logger.js';

// Use the client's visible controls; standing still alone is not a disconnect.
export function createReconnect(page) {
  let character = '';
  let nextCheck = 0;
  let nextAction = 0;
  let recovering = false;
  let blocked = false;
  let lastState = '';
  const report = (state, detail = {}) => {
    if (state === lastState) return;
    lastState = state;
    log('game_reconnect', { state, ...detail });
  };

  return async function reconnect(snap) {
    const now = Date.now();
    if (now < nextCheck) return blocked;
    nextCheck = now + 1000;
    try {
      const popup = page.locator('#win_popup:visible').filter({
        has: page.locator('.text', { hasText: /disconnect|connection (?:lost|closed)|failed to connect|server closed/i }),
      });
      if (await popup.count()) {
        character ||= snap?.me?.name || '';
        recovering = blocked = true;
        const ok = popup.locator('button[data-background="btn_ok.bmp"]:visible');
        if (await ok.count() === 1 && now >= nextAction) {
          nextAction = now + 5000;
          await ok.click({ timeout: 1200 });
          report('disconnect_ok', { character });
        } else report('waiting_for_client');
        return true;
      }

      // Inner panels only: the client uses duplicate IDs on shadow hosts.
      const panel = page.locator('#CharSelectV4:has(> .char_select_container):visible, #charselect:has(> .charinfo):visible, #CharSelectV2:has(> .charinfo):visible, #CharSelectV3:has(> .charinfo):visible');
      if (await panel.count() === 1) {
        recovering = blocked = true;
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
          nextAction = now + 10000;
          await ok.click({ timeout: 1200 });
          report('character_selected', { character });
        }
        return true;
      }
      if (recovering && (!snap?.inGame || now < nextAction)) {
        blocked = true;
        report('waiting_for_game');
        return true;
      }
      if (recovering) report('in_game', { character: snap.me?.name });
      recovering = blocked = false;
      if (snap?.inGame && snap.me?.name) character = snap.me.name;
      return false;
    } catch (error) {
      // Reloads destroy the execution context while reconnecting.
      blocked = true;
      report('retry', { error: error.message });
      return true;
    }
  };
}
