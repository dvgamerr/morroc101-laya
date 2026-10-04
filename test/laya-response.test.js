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
test('a choice outside the offered options, or an answer that is not an object, is not passed on as a decision', async () => {
  const options = { loadout_0: 'a', loadout_1: 'b' };
  globalThis.fetch = async () => Response.json({ answers: { decision: { choice: 'loadout_9', confidence: 0.99 } } });
  const { choose } = await import('../src/laya.js?response-tests');
  expect((await choose({}, 'pick', options)).choice).toBe(null);
  globalThis.fetch = async () => Response.json({ answers: { decision: { choice: 'loadout_1', confidence: 0.9 } } });
  expect((await choose({}, 'pick', options)).choice).toBe('loadout_1');
  globalThis.fetch = async () => Response.json({ answers: { decision: 'loadout_1' } });
  expect(await choose({}, 'pick', options)).toBeUndefined();
  globalThis.fetch = async () => Response.json({ answers: { decision: null } });
  expect(await choose({}, 'pick', options)).toBeUndefined();
});
