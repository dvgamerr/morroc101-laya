import { config } from './config.js';

/**
 * Chat completion against oMLX (OpenAI-compatible).
 * Thinking is turned off: replies must be fast and short, and the planner asks for JSON.
 */
export async function chat(messages, { maxTokens = 256, temperature = 0.7, json = false, timeoutMs = 60000, onCompletion } = {}) {
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
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  // Body reads can time out after fetch has already received the headers.
  // Never turn a transport failure into an apparently successful empty reply.
  let body;
  try {
    body = await res.json();
  } catch (error) {
    throw new Error(`oMLX ${res.status}: response body read failed (${error.name}: ${error.message})`, { cause: error });
  }
  if (!res.ok || body?.error) {
    throw new Error(`oMLX ${res.status}: ${body?.error?.message || body?.detail || JSON.stringify(body)}`);
  }
  const choice = body?.choices?.[0];
  onCompletion?.({ finishReason: choice?.finish_reason, completionTokens: body?.usage?.completion_tokens });
  const content = choice?.message?.content;
  if (typeof content !== 'string') {
    throw new Error(`oMLX ${res.status}: missing or invalid message content`);
  }
  const text = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text) {
    throw new Error(`oMLX ${res.status}: empty completion (finishReason=${choice.finish_reason ?? 'unknown'}, completionTokens=${body?.usage?.completion_tokens ?? 'unknown'})`);
  }
  return text;
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
