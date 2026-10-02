import { config } from './config.js';

/**
 * Ask LAYA one or more typed questions about a state in a single forward pass.
 *
 * questions: { key: { type: 'choice', instructions, criteria: { option: description } }
 *            | { type: 'noul', instructions, criteria?: { false, true } }
 *            | { type: 'score', instructions, criteria: [ordered labels] } }
 *
 * Returns answers keyed like the questions:
 *   choice -> { choice, probabilities, confidence }
 *   noul   -> { noul, probability }  (`probability` = P(true), copied from `noul`)
 */
export async function ask(state, questions, { timeoutMs = 5000 } = {}) {
  const res = await fetch(config.laya.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.laya.key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: config.laya.model, state, questions }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new Error(`LAYA ${res.status}: ${body.error?.message || JSON.stringify(body)}`);
  }
  const answers = body.answers || {};
  for (const [key, q] of Object.entries(questions)) {
    if (q.type === 'noul' && answers[key]) answers[key].probability = yesProbability(answers[key]);
  }
  return answers;
}

function yesProbability(answer) {
  // The hosted API returns P(true) as `noul`.
  if (typeof answer.noul === 'number') return answer.noul;
  if (typeof answer.probability === 'number') return answer.probability;
  const p = answer.probabilities || {};
  if (typeof p.true === 'number') return p.true;
  if (typeof p.yes === 'number') return p.yes;
  if (answer.choice === true || answer.choice === 'true' || answer.choice === 'yes') return answer.answer_confidence ?? 1;
  if (answer.choice === false || answer.choice === 'false' || answer.choice === 'no') return 1 - (answer.answer_confidence ?? 1);
  return 0;
}

/** Shortcut: pick one option. `options` is { name: description }. */
export async function choose(state, instructions, options, opts = {}) {
  const { decision } = await ask(state, {
    decision: { type: 'choice', instructions, criteria: options },
  }, opts);
  return decision;
}
