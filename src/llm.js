import { config } from './config.js';

/**
 * Chat completion against oMLX (OpenAI-compatible).
 * Thinking is turned off: replies must be fast and short, and the planner asks for JSON.
 */
export async function chat(messages, { maxTokens = 256, temperature = 0.7, json = false, timeoutMs = 60000 } = {}) {
  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.llm.key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.llm.model,
      messages,
      max_tokens: maxTokens,
      temperature,
      chat_template_kwargs: { enable_thinking: false },
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new Error(`oMLX ${res.status}: ${body.error?.message || body.detail || JSON.stringify(body)}`);
  }
  const text = body.choices?.[0]?.message?.content ?? '';
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/** Pull the first JSON object out of a reply, tolerating code fences or chatter around it. */
export function parseJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
