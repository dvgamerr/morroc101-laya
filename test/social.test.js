import { test, expect, mock, beforeEach } from 'bun:test';

process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';
const calls = [];
mock.module('../src/browser.js', () => ({ act: async (_p, n, a) => calls.push([n, a]), exploreTarget: async () => null, query: async () => [] }));
mock.module('../src/logger.js', () => ({ log: () => {} }));
mock.module('../src/llm.js', () => ({ chat: async () => 'ขอค่ายาสักนิดได้ไหมคะ 🥺', parseJson: (t) => JSON.parse(t) }));
const { createTrader, createBeggar } = await import('../src/social.js');

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

test('begging: only in Morroc, nearest player, once per player, a gap between asks, never someone who refused', async () => {
  const b = createBeggar({});
  const town = (players) => ({ me: { map: 'morocc' }, players });
  expect(await b.maybeAsk({ me: { map: 'prontera' }, players: [{ name: 'A', dist: 2 }] })).toBe(0); // not Morroc
  expect(await b.maybeAsk(town([{ name: 'A', dist: 2 }, { name: 'B', dist: 5 }]))).toBeGreaterThan(0);
  expect(calls.at(-1)[0]).toBe('say');
  expect(calls.at(-1)[1].text).toContain('A'); // one of the fixed polite lines, addressed to the nearest player
  expect(await b.maybeAsk(town([{ name: 'B', dist: 2 }]))).toBe(0); // 2-minute gap
  const b2 = createBeggar({});
  b2.refused('C');
  expect(await b2.maybeAsk(town([{ name: 'C', dist: 1 }]))).toBe(0);
});

test('begging: never asks our own character (it once begged from itself)', async () => {
  const b = createBeggar({});
  const snap = { me: { map: 'morocc', name: 'nomyai' }, players: [{ name: 'nomyai', dist: 0 }, { name: 'nomyai', dist: 1 }] };
  expect(await b.maybeAsk(snap)).toBe(0);
  expect(await b.maybeAsk({ ...snap, players: [{ name: 'Other', dist: 0 }] })).toBe(0); // on our own cell = us
});
