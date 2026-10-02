import { config } from './config.js';
import { log } from './logger.js';
import { GOALS } from './goals.js';

export { GOALS };

const AUTO_NOTE = {
  true: '',
  partial: '\nℹ️ agent ทำได้บางส่วน (stat อัปเอง, skill ต้องทำเอง)',
  false: '\n⚠️ agent ยังทำเรื่องนี้เองไม่ได้ ต้องให้เจ้าของทำ — ระหว่างนี้จะเล่นต่อตามปกติ',
};

const MIN_GAP_MS = 3000; // Discord allows ~30/min per webhook; we send far fewer, but never in bursts.

const queue = [];
let sending = false;
let lastSentAt = 0;
let sender = 'Morroc101 AI';

/**
 * Who the messages come from: the character's name and level go in the webhook's
 * display name, so the embeds don't have to repeat them every time.
 */
export function setIdentity(me) {
  if (!me || !me.name) return;
  // Discord: 1-80 chars, and the word "discord" isn't allowed in a webhook name.
  sender = `${me.name} Lv.${me.baseLevel ?? '?'}/${me.jobLevel ?? '?'}`.replace(/discord/gi, 'd1scord').slice(0, 80);
}

/**
 * Post an embed to the Discord webhook (DISCORD_WEBHOOK_URL). Fire-and-forget:
 * a failed notification is logged and never stops the agent.
 */
export function notify(title, description, fields = {}, color = 0xe8b84b) {
  if (!config.discordWebhook) return;
  queue.push({
    username: sender,
    title,
    description,
    color,
    fields: Object.entries(fields)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([name, value]) => ({ name, value: String(value).slice(0, 1024), inline: String(value).length < 40 })),
    timestamp: new Date().toISOString(),
  });
  pump();
}

async function pump() {
  if (sending) return;
  sending = true;
  try {
    while (queue.length) {
      const wait = lastSentAt + MIN_GAP_MS - Date.now();
      if (wait > 0) await Bun.sleep(wait);
      const { username, ...embed } = queue.shift();
      lastSentAt = Date.now();
      try {
        const res = await fetch(config.discordWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, embeds: [embed] }),
          signal: AbortSignal.timeout(10000),
        });
        if (res.status === 429) {
          // Rate limited: put it back and wait what Discord asks.
          const body = await res.json().catch(() => ({}));
          queue.unshift({ username, ...embed });
          await Bun.sleep(Math.ceil((body.retry_after || 2) * 1000));
        } else if (!res.ok) {
          log('notify_error', { status: res.status, title: embed.title });
        }
      } catch (err) {
        log('notify_error', { error: err.message, title: embed.title });
      }
    }
  } finally {
    sending = false;
  }
}

/** Title for a plan change: first plan, a new goal, or only a new hunting map. */
export function goalChangeTitle(prev, next) {
  const g = GOALS[next.goal] || GOALS.level;
  if (!prev) return `${g.emoji} เริ่มเล่น: ${g.label}`;
  if (prev.goal !== next.goal) return `${g.emoji} เปลี่ยนเป้าหมาย: ${(GOALS[prev.goal] || GOALS.level).label} → ${g.label}`;
  return `🗺️ ย้ายที่ล่า: ${prev.hunt_map || '-'} → ${next.hunt_map || '-'}`;
}

/** Tell Discord the agent changed what it is working toward. prev is null for the first plan. */
export function notifyGoalChange(prev, next, snap) {
  const g = GOALS[next.goal] || GOALS.level;
  setIdentity(snap.me);
  notify(
    goalChangeTitle(prev, next),
    next.objective + AUTO_NOTE[String(g.auto)],
    {
      แมพล่า: next.hunt_map,
      มอน: (next.target_monsters || []).join(', '),
      เหตุผล: next.reason,
      สัญญาณ: (next.signals || []).join('\n'),
      'ต้องทำเอง (todo)': (next.todo || []).join('\n'),
    },
    g.auto === true ? 0x4caf50 : 0xff9800,
  );
}
