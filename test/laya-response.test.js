import { afterEach, expect, test } from 'bun:test';
process.env.LAYA_API_KEY ||= 'test'; process.env.OMLX_API_KEY ||= 'test';
const { ask } = await import('../src/laya.js?response-tests');
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
test('LAYA body timeout is not silently treated as no review answers', async () => {
  globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => { throw new DOMException('timed out', 'TimeoutError'); } });
  await expect(ask({}, {})).rejects.toThrow('response body read failed');
});
test('LAYA rejects missing answers and preserves valid responses', async () => {
  globalThis.fetch = async () => Response.json({});
  await expect(ask({}, {})).rejects.toThrow('missing or invalid answers');
  globalThis.fetch = async () => Response.json({ answers: { item_9: { choice: 'keep' } } });
  expect(await ask({}, {})).toEqual({ item_9: { choice: 'keep' } });
});
