// Playwright locators pierce the client's open shadow roots. locator.click()
// sends mouse input and checks visibility, stability and whether the target is
// covered; never force-click or guess a screen coordinate for a hidden button.
const TIMEOUT = 1200;
export const UI_ACTIONS = new Set(['npc_next', 'npc_menu', 'npc_input', 'npc_close', 'identify', 'close_shop', 'storage_close']);

export async function clickGameUi(page, action, arg = {}) {
  const state = await page.evaluate(() => ({
    dialog: window.__agent?.dialog && { ...window.__agent.dialog },
    identify: window.__agent?.identify && { ...window.__agent.identify },
  }));
  const npcAction = action.startsWith('npc_');
  if (npcAction && state.dialog?.naid !== arg.naid) return false;
  const locator = (selector) => page.locator(selector);
  const click = (selector) => locator(selector).click({ timeout: TIMEOUT });
  const visible = (selector) => locator(selector).isVisible();
  async function unchanged() {
    return page.evaluate(({ action, state }) => {
      const a = window.__agent;
      if (action === 'identify') return a?.identify?.at === state.identify?.at;
      return a?.dialog?.naid === state.dialog?.naid && a?.dialog?.at === state.dialog?.at;
    }, { action, state });
  }
  async function close(selector, panel) {
    await click(selector);
    await locator(panel).waitFor({ state: 'hidden', timeout: TIMEOUT });
  }

  switch (action) {
    case 'npc_next':
      if (state.dialog?.state !== 'next') return false;
      await click('#NpcBox ui-button.next');
      break;
    case 'npc_menu': {
      if (state.dialog?.state !== 'menu') return false;
      if (arg.num === 255) {
        await close('#NpcMenu ui-button.cancel', '#NpcMenu');
        break;
      }
      if (!Number.isInteger(arg.num) || arg.num < 1 || arg.num > (state.dialog.menu?.length || 0)) return false;
      const row = `#NpcMenu .content div[data-index="${arg.num - 1}"]`;
      await click(row);
      if (!await unchanged() || !await visible(`${row}.selected`)) return false;
      await click('#NpcMenu ui-button.ok');
      break;
    }
    case 'npc_input':
      if (state.dialog?.state !== 'input') return false;
      await locator('#inputbox input').fill(String(arg.value), { timeout: TIMEOUT });
      if (!await unchanged()) return false;
      await close('#inputbox ui-button', '#inputbox');
      break;
    case 'identify': {
      if (!Number.isInteger(arg.index) || !state.identify?.indices.includes(arg.index)) return false;
      await click(`#ItemSelection .item[data-index="${arg.index}"]`);
      if (!await unchanged()) return false;
      await close('#ItemSelection ui-button.ok', '#ItemSelection');
      break;
    }
    case 'npc_close':
      if (await visible('#NpcMenu ui-button.cancel')) await close('#NpcMenu ui-button.cancel', '#NpcMenu');
      else if (await visible('#NpcBox ui-button.close')) await close('#NpcBox ui-button.close', '#NpcBox');
      else if (await visible('#NpcBox') || await visible('#NpcMenu')) return false;
      break;
    case 'close_shop':
      if (await visible('#NpcStore .PurchaseResult ui-button.ok')) await click('#NpcStore .PurchaseResult ui-button.ok');
      if (await visible('#NpcStore .OutputWindow ui-button.cancel')) await close('#NpcStore .OutputWindow ui-button.cancel', '#NpcStore');
      if (await visible('#NpcStore')) throw new Error('Shop window did not close');
      break;
    case 'storage_close':
      if (await visible('#Storage ui-button.close')) await close('#Storage ui-button.close', '#Storage');
      else if (await visible('#Storage')) throw new Error('Storage window did not close');
      break;
    default:
      return false;
  }

  // Only acknowledge our old snapshot: a click may already have caused the
  // server to send the next menu. Do not overwrite that new state or send a
  // second packet after the client's normal button handler has sent one.
  await page.evaluate(({ action, arg, state }) => {
    const a = window.__agent;
    if (!a) return;
    if (action.startsWith('npc_') && a.dialog?.naid === state.dialog?.naid && a.dialog?.at === state.dialog?.at) {
      a.dialog.state = action === 'npc_close' || (action === 'npc_menu' && arg.num === 255) ? 'ended' : 'text';
    }
    if (action === 'identify' && a.identify?.at === state.identify?.at) a.identify = null;
    if (action === 'close_shop') a.shop = null;
    if (action === 'storage_close') a.storage = null;
  }, { action, arg, state });
  return true;
}
