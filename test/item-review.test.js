import { test, expect, mock } from 'bun:test';
process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';
mock.module('../src/browser.js', () => ({ act: async () => true }));
mock.module('../src/logger.js', () => ({ log() {} }));
let requests = 0;
let response, lastRequest;
mock.module('../src/laya.js', () => ({ ask: async (state, questions) => { requests++; lastRequest = { state, questions }; if (response) return response; throw new Error('service unavailable'); } }));
const { createItemReview } = await import('../src/item-review.js');
const snap = () => ({ me: { jobId: 10, baseLevel: 98 }, worn: [], mapAgeMs: 60000,
  inventory: [{ index: 9, ITID: 909, name: 'Jellopy', count: 10, type: 3 }], attackers: [] });

test('failed item review keeps items and does not immediately request another sale trip', async () => {
  requests = 0;
  const review = createItemReview({});
  const s = snap();
  expect(review.needsSaleReview(s)).toBe(true);
  expect(review.observe(s)).toBe(true);
  await Bun.sleep(0);
  expect(review.observe(s)).toBe(false);
  expect(review.needsSaleReview(s)).toBe(false);
  expect(review.saleItems(s)).toEqual([]);
  expect(requests).toBe(1);
});

test('deferring unknown items prevents repeated trips without approving a sale', () => {
  const review = createItemReview({});
  const s = snap();
  s.inventory[0].gear = { identified: false };
  review.defer(s);
  expect(review.needsSaleReview(s)).toBe(false);
  expect(review.saleItems(s)).toEqual([]);
  s.inventory[0].gear.identified = true;
  expect(review.needsSaleReview(s)).toBe(true);
});

test('ordinary loot uses a focused question and only a confident approval becomes sellable', async () => {
  response = { item_9: { choice: 'sell', confidence: 0.95 } };
  try {
    const review = createItemReview({});
    const s = snap();
    review.observe(s);
    await Bun.sleep(0);
    expect(lastRequest.state.gear_goal).toBeUndefined();
    expect(lastRequest.questions.item_9.criteria).toEqual({ sell: 'Ordinary unused loot; sell to NPC for money', keep: 'Useful or unknown item; keep' });
    expect(review.saleItems(s).map(i => i.index)).toEqual([9]);
    s.inventory[0].keep = true;
    expect(review.saleItems(s)).toEqual([]);
  } finally { response = undefined; }
});
