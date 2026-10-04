import { afterEach, expect, test } from 'bun:test';

process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';
const { chat } = await import('../src/llm.js?response-validation');
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('body timeout is preserved instead of returning empty planner JSON', async () => {
  const timeout = new DOMException('The operation timed out', 'TimeoutError');
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw timeout; } });
  try {
    await chat([]);
    throw new Error('Expected body timeout');
  } catch (error) {
    expect(error.cause).toBe(timeout);
    expect(error.message).toContain('response body read failed (TimeoutError');
  }
});

test('non-JSON response is reported as a response read failure', async () => {
  globalThis.fetch = async () => new Response('<html>Gateway timeout</html>', { status: 504 });
  await expect(chat([])).rejects.toThrow('oMLX 504: response body read failed');
});

test('missing and invalid completion envelopes are rejected', async () => {
  for (const body of [null, {}, { choices: [] }, { choices: [{ message: { content: [] } }] }]) {
    globalThis.fetch = async () => Response.json(body);
    await expect(chat([])).rejects.toThrow('missing or invalid message content');
  }
});

test('empty and thinking-only completions include finish diagnostics', async () => {
  for (const content of ['', '  ', '<think>reasoning</think>']) {
    globalThis.fetch = async () => Response.json({
      choices: [{ message: { content }, finish_reason: 'length' }], usage: { completion_tokens: 2048 },
    });
    await expect(chat([])).rejects.toThrow('empty completion (finishReason=length, completionTokens=2048)');
  }
});

test('valid non-streaming completion preserves text and metadata', async () => {
  let request;
  let completion;
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return Response.json({
      choices: [{ message: { content: '<think>reasoning</think> {"hunt_map":"moc_fild01"} ' }, finish_reason: 'stop' }],
      usage: { completion_tokens: 20 },
    });
  };
  expect(await chat([], { json: true, onCompletion: info => { completion = info; } })).toBe('{"hunt_map":"moc_fild01"}');
  expect(request.stream).toBe(false);
  expect(request.response_format).toEqual({ type: 'json_object' });
  expect(completion).toEqual({ finishReason: 'stop', completionTokens: 20 });
});

test('API errors still propagate', async () => {
  globalThis.fetch = async () => Response.json({ error: { message: 'Model unavailable' } }, { status: 503 });
  await expect(chat([])).rejects.toThrow('oMLX 503: Model unavailable');
});
