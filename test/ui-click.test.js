import { test, expect } from 'bun:test';
import { clickGameUi } from '../src/ui-click.js';

test('shop close ignores its visible shadow host and verifies only the actual shop panel', async () => {
  let open = true, acknowledged = false;
  const selectors = [];
  const page = {
    async evaluate(_fn, arg) {
      if (!arg) return {};
      acknowledged = true;
    },
    locator(selector) {
      selectors.push(selector);
      const realPanel = selector.includes(':has(.OutputWindow):not(:has(#NpcStore))');
      return {
        async isVisible() {
          if (selector.includes('.PurchaseResult')) return false;
          // Both the wrapper and inner panel are visible. Unscoped queries
          // reproduce the strict-mode error reported by the real browser.
          if (!realPanel) throw new Error('strict mode violation: 2 elements');
          return open;
        },
        async click() { expect(realPanel).toBe(true); open = false; },
        async waitFor() { expect(realPanel).toBe(true); expect(open).toBe(false); },
      };
    },
  };
  expect(await clickGameUi(page, 'close_shop')).toBe(true);
  expect(acknowledged).toBe(true);
  expect(selectors.every(s => s.includes(':not(:has(#NpcStore))'))).toBe(true);
});

function npcPage({ state = 'close', closeButton = true, shown = true, hostVisible = false } = {}) {
  const dialog = { naid: 123, at: 1, state, lines: [] };
  const clicks = [];
  const waits = [];
  const elements = [
    { selector: '#NpcBox', visible: hostVisible, host: true },
    { selector: '#NpcBox', visible: shown },
    { selector: '#NpcBox ui-button.close', visible: false },
    { selector: '#NpcBox ui-button.close', visible: shown && closeButton },
    { selector: '#NpcBox ui-button.next', visible: false },
    { selector: '#NpcBox ui-button.next', visible: shown && state === 'next' },
  ];
  const page = {
    async evaluate(fn, arg) {
      if (!arg) return { dialog: { ...dialog } };
      return true;
    },
    locator(selector) {
      const visibleOnly = selector.endsWith(':visible');
      const base = (visibleOnly ? selector.slice(0, -8) : selector).replaceAll(':has(> .border)', '');
      const matches = () => elements.filter(e => e.selector === base && (!selector.includes(':has(> .border)') || !e.host) && (!visibleOnly || e.visible));
      const single = () => {
        const found = matches();
        if (found.length > 1) throw new Error('strict mode violation');
        return found[0];
      };
      return {
        async isVisible() { return !!single()?.visible; },
        async click() {
          if (!single()?.visible) throw new Error('No visible button');
          clicks.push(base);
          if (base.endsWith('.close')) elements.forEach(e => { e.visible = false; });
        },
        async waitFor({ state }) {
          waits.push(base);
          expect(state).toBe('hidden');
          expect(single()?.visible ?? false).toBe(false);
        },
      };
    },
  };
  return { page, clicks, waits };
}

test('NPC close ignores hidden duplicate panels and buttons, including close wait', async () => {
  const { page, clicks, waits } = npcPage();
  expect(await clickGameUi(page, 'npc_close', { naid: 123 })).toBe(true);
  expect(clicks).toEqual(['#NpcBox ui-button.close']);
  expect(waits).toEqual(['#NpcBox']);
});

test('visible NPC panel without a close button remains open despite a hidden duplicate', async () => {
  const { page, clicks } = npcPage({ closeButton: false });
  expect(await clickGameUi(page, 'npc_close', { naid: 123 })).toBe(false);
  expect(clicks).toEqual([]);
});

test('hidden duplicate NPC panels are already closed', async () => {
  const { page, clicks } = npcPage({ shown: false });
  expect(await clickGameUi(page, 'npc_close', { naid: 123 })).toBe(true);
  expect(clicks).toEqual([]);
});

test('NPC next clicks the visible button when a hidden copy remains', async () => {
  const { page, clicks } = npcPage({ state: 'next' });
  expect(await clickGameUi(page, 'npc_next', { naid: 123 })).toBe(true);
  expect(clicks).toEqual(['#NpcBox ui-button.next']);
});

test('NPC close checks the actual panel when its empty shadow host is also visible', async () => {
  const { page, clicks } = npcPage({ closeButton: false, hostVisible: true });
  expect(await clickGameUi(page, 'npc_close', { naid: 123 })).toBe(false);
  expect(clicks).toEqual([]);
});

function identifyPage({ selected = true, selectionWorks = true, changed = false } = {}) {
  const clicks = [];
  let closed = false;
  const page = {
    async evaluate(fn, arg) {
      if (!arg) return { identify: { indices: [18, 20], at: 1 } };
      return !changed;
    },
    locator(selector) {
      return {
        async evaluate(fn) {
          return fn({ style: { backgroundColor: selected ? 'rgb(205, 224, 255)' : 'transparent' } });
        },
        async click() {
          if (selector.includes('.item[')) {
            // Clicking the already selected default item must not block OK.
            if (selected) throw new Error('Unnecessary selection');
            clicks.push('item');
            selected = selectionWorks;
          } else {
            expect(selector).toBe('#ItemSelection:has(> .head) ui-button.ok:visible');
            clicks.push('OK');
            closed = true;
          }
        },
        async waitFor({ state }) {
          expect(selector).toBe('#ItemSelection:has(> .head):visible');
          expect(state).toBe('hidden');
          expect(closed).toBe(true);
        },
      };
    },
  };
  return { page, clicks };
}

test('appraisal confirms the item already selected after F9 with OK', async () => {
  const { page, clicks } = identifyPage();
  expect(await clickGameUi(page, 'identify', { index: 18 })).toBe(true);
  expect(clicks).toEqual(['OK']);
});

test('appraisal selects another offered item before clicking OK', async () => {
  const { page, clicks } = identifyPage({ selected: false });
  expect(await clickGameUi(page, 'identify', { index: 20 })).toBe(true);
  expect(clicks).toEqual(['item', 'OK']);
});

test('appraisal does not confirm an unselected item or a changed list', async () => {
  for (const options of [{ selected: false, selectionWorks: false }, { changed: true }]) {
    const { page, clicks } = identifyPage(options);
    expect(await clickGameUi(page, 'identify', { index: 18 })).toBe(false);
    expect(clicks).not.toContain('OK');
  }
});

test('appraisal does not click OK for an index absent from the server list', async () => {
  const { page, clicks } = identifyPage();
  expect(await clickGameUi(page, 'identify', { index: 99 })).toBe(false);
  expect(clicks).toEqual([]);
});
