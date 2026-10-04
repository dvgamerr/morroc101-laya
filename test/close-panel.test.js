import { expect, test } from 'bun:test';
import { closePanel } from '../src/close-panel.js';

const timeout = () => Object.assign(new Error('timeout'), { name: 'TimeoutError' });
test('a panel disappearing during the close click is already closed', async () => {
  let visible = true, clicks = 0;
  await closePanel({ isVisible: async () => visible }, { click: async () => {
    clicks++; visible = false; throw timeout();
  } }, 10);
  expect(clicks).toBe(1);
});
test('a transient close timeout is retried once and closure verified', async () => {
  let clicks = 0, verified = false;
  await closePanel({ isVisible: async () => true, waitFor: async () => { verified = true; } }, {
    click: async () => { if (++clicks === 1) throw timeout(); },
  }, 10);
  expect(clicks).toBe(2);
  expect(verified).toBe(true);
});
test('a persistently blocked window is not acknowledged as closed', async () => {
  let clicks = 0;
  await expect(closePanel({ isVisible: async () => true }, {
    click: async () => { clicks++; throw timeout(); },
  }, 10)).rejects.toThrow('timeout');
  expect(clicks).toBe(2);
});
