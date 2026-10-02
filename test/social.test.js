import { test, expect, mock, beforeEach } from 'bun:test';

process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';
const calls = [];
mock.module('../src/browser.js', () => ({ act: async (_p, n, a) => calls.push([n, a]), exploreTarget: async () => null, query: async () => [] }));
mock.module('../src/logger.js', () => ({ log: () => {} }));
const { createTrader } = await import('../src/social.js');

beforeEach(() => (calls.length = 0));
const names = () => calls.map(([n]) => n);

test('trade: accept, lock our empty side only after they lock with zeny in, then OK', async () => {
  const t = createTrader({});
  await t.tick({ trade: { stage: 'requested', from: 'Kem', zeny: 0, items: [] } });
  expect(names()).toEqual(['trade_accept']);
  await t.tick({ trade: { stage: 'open', from: 'Kem', zeny: 5000, items: [], otherLocked: false, selfLocked: false } });
  expect(names()).toEqual(['trade_accept']); // they haven't locked yet: wait
  await t.tick({ trade: { stage: 'open', from: 'Kem', zeny: 5000, items: [], otherLocked: true, selfLocked: false } });
  await t.tick({ trade: { stage: 'open', from: 'Kem', zeny: 5000, items: [], otherLocked: true, selfLocked: true } });
  expect(names()).toEqual(['trade_accept', 'trade_lock', 'trade_ok']);
});

test('trade: they lock with nothing in it -> cancel, never OK', async () => {
  const t = createTrader({});
  await t.tick({ trade: { stage: 'requested', from: 'Scam', zeny: 0, items: [] } });
  await t.tick({ trade: { stage: 'open', from: 'Scam', zeny: 0, items: [], otherLocked: true, selfLocked: false } });
  expect(names()).toEqual(['trade_accept', 'trade_cancel']);
  expect(names()).not.toContain('trade_ok');
});

test('the agent has no way to give anything away in a trade', async () => {
  const src = await Bun.file('src/page-agent.js').text();
  expect(src).not.toMatch(/ADD_EXCHANGE_ITEM\(|CZ\.ADD_EXCHANGE/);
});
