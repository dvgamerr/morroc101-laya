const MAX_MESSAGES = 12;
const FORGET_AFTER_MS = 30 * 60 * 1000;

const players = new Map();

export function remember(name, from, text) {
  const now = Date.now();
  let p = players.get(name);
  if (!p || now - p.lastInteraction > FORGET_AFTER_MS) {
    p = { name, recentMessages: [], lastInteraction: now };
    players.set(name, p);
  }
  p.recentMessages.push({ from, text });
  if (p.recentMessages.length > MAX_MESSAGES) p.recentMessages.shift();
  p.lastInteraction = now;
  return p;
}

export function history(name) {
  return players.get(name)?.recentMessages ?? [];
}
