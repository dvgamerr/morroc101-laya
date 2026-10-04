import * as laya from './laya.js';
import * as llm from './llm.js';
import { act } from './browser.js';
import { log } from './logger.js';
import { remember, history } from './memory.js';
import { CHAT_SYSTEM } from './prompts.js';
import { config } from './config.js';
import { jobInfo, nextJob } from './goals.js';
import { jobReferenceContext } from './job-reference.js';

const REPLY_MODES = {
  ignore: 'ข้อความไม่ได้คุยกับเรา เป็นสแปม ประกาศขายของ หรือคุยกันเองระหว่างคนอื่น',
  reply: 'ข้อความทักหรือถามเรา ควรตอบแล้วเล่นต่อตามปกติ',
  reply_and_follow: 'ข้อความขอให้เราเดินตามไป หรือชวนไปด้วยกัน',
  reply_and_wait: 'ข้อความขอให้เราหยุด รอ หรือหยุดตีสักครู่',
};

/**
 * Priority 80: a player talked. LAYA decides whether/how to react (cheap, fast),
 * the LLM writes the actual line. Runs off the combat loop so farming keeps going.
 */
const PUBLIC_REPLY_CONFIDENCE = 0.7;
const PUBLIC_REPLY_RANGE = 3;
const ABOUT_OWNER_P = 0.8;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// OWNER_NAME comes from .env: escape it, and never let an empty name become an empty alternative
// (that would match every message).
const OWNER_WORDS = new RegExp(`(${[config.game.ownerName.replace(/^พี่/, '').trim(), 'เจ้าของ', 'คนเล่น', 'owner', 'ใครเล่น', 'ตัวจริง'].filter(Boolean).map(escapeRegExp).join('|')})`, 'i');
// Qwen sometimes drifts into Chinese/Japanese/Korean mid-sentence; such a line is not sent.
const FOREIGN_SCRIPT = /[぀-ヿ㐀-鿿가-힯]/;

// Two bots answering each other would never stop; neither would a spammer.
const PER_PLAYER_PER_MIN = 4;
const TOTAL_PER_MIN = 10;
// Inbound limits: every message we look at can cost a LAYA call, and a flood of public lines must
// not push a real whisper out of the queue.
const IN_PER_PLAYER_PER_MIN = 8;
const IN_TOTAL_PER_MIN = 30;
const QUEUE_MAX = 10;
// Whisper/public lines may only make us follow or stop when the sender is standing close by.
const FOLLOW_RANGE = 10;

// First characters the game treats as something other than plain speech: @ and # run atcommands
// (@go, #warp), / is a client command, % and $ switch to party/guild chat, ! is shout/broadcast.
// NFKC below already folds the full-width forms into these.
const COMMAND_CHARS = /^[@#/%$!]/;
// Quotes, brackets and invisible characters a model (or a prompt injection) can hide a command behind.
const LEADING_NOISE = /^[\s"'`\u2018\u2019\u201C\u201D\u00AB\u00BB\u300C\u300D\u300E\u300F\u200B-\u200F\u2060\uFEFF\u0000-\u001F]+/;

/**
 * The one line we may type for a model reply, or '' when it must not be sent at all.
 * A reply that is (or hides behind quotes/spaces) a game command is dropped, not repaired.
 */
export function sanitizeReply(text) {
  const lines = String(text ?? '').normalize('NFKC').split(/[\r\n]/).map((l) => l.replace(LEADING_NOISE, ''));
  const line = lines.find(Boolean) ?? '';
  if (COMMAND_CHARS.test(line)) return '';
  return line.replace(/["'\u201C\u201D]+$/, '').trim().slice(0, 90);
}

export function createChat(page, brain) {
  const queue = [];
  const sent = []; // { t, to }
  const received = []; // { t, from }
  let busy = false;

  function allowed(to) {
    const now = Date.now();
    while (sent.length && now - sent[0].t > 60000) sent.shift();
    return sent.length < TOTAL_PER_MIN && sent.filter((s) => s.to === to).length < PER_PLAYER_PER_MIN;
  }

  function receivedAllowed(from) {
    const now = Date.now();
    while (received.length && now - received[0].t > 60000) received.shift();
    if (received.length >= IN_TOTAL_PER_MIN || received.filter((r) => r.from === from).length >= IN_PER_PLAYER_PER_MIN) return false;
    received.push({ t: now, from });
    return true;
  }

  async function handle(ev, snap) {
    if (!snap.inGame) return;
    if (!allowed(ev.from)) {
      remember(ev.from, ev.from, ev.text);
      log('chat_rate_limited', { from: ev.from, text: ev.text });
      return;
    }
    const myName = snap.me?.name || '';
    const near = snap.players.find((p) => p.name === ev.from);
    const mentionsMe = !!myName && ev.text.toLowerCase().includes(myName.toLowerCase());
    const directed = ev.channel !== 'public' || mentionsMe;
    // Public chat that neither names us nor comes from someone beside us never reaches LAYA (a paid
    // call); it could not be answered anyway.
    if (ev.channel === 'public' && !mentionsMe && !(near && near.dist <= PUBLIC_REPLY_RANGE)) {
      remember(ev.from, ev.from, ev.text);
      return;
    }

    const answers = await laya.ask(
      {
        channel: ev.channel,
        from: ev.from,
        message: ev.text,
        my_name: myName,
        mentions_me: mentionsMe,
        sender_distance: near ? near.dist : 'far',
        previous: history(ev.from).slice(-3).map((m) => `${m.from}: ${m.text}`).join(' | ') || 'none',
      },
      {
        mode: {
          type: 'choice',
          instructions: 'A player sent this chat message in Ragnarok Online. How should our character react?',
          criteria: REPLY_MODES,
        },
        about_owner: {
          type: 'noul',
          instructions: `Does the message ask about the character's owner or real player (${config.game.ownerName}), e.g. where they are, whether they are here, or why they are not answering?`,
        },
      },
    );

    let mode = answers.mode?.choice || 'ignore';
    // Whisper/party/guild are always addressed to us.
    if (mode === 'ignore' && directed) mode = 'reply';
    // Public chat that doesn't name us: only someone standing right next to us, and only when
    // LAYA is sure it's meant for us. (Other players' auto-shouts were being answered.)
    if (ev.channel === 'public' && !mentionsMe && mode !== 'ignore') {
      const sure = (answers.mode?.confidence ?? 0) >= PUBLIC_REPLY_CONFIDENCE;
      if (!(near && near.dist <= PUBLIC_REPLY_RANGE && sure)) mode = 'ignore';
    }
    // "Asking about the owner" needs both LAYA's say-so and words that actually point at the owner.
    const aboutOwner = (answers.about_owner?.probability ?? 0) > ABOUT_OWNER_P && OWNER_WORDS.test(ev.text);
    log('chat_in', { channel: ev.channel, from: ev.from, text: ev.text, mode, aboutOwner });
    remember(ev.from, ev.from, ev.text);
    if (mode === 'ignore') return;
    // Anyone can whisper or name us from across the map; only someone close may pin us in place
    // or make us walk after them. Party/guild are the owner's own channels.
    if ((mode === 'reply_and_follow' || mode === 'reply_and_wait') && (ev.channel === 'whisper' || ev.channel === 'public') && !(near && near.dist <= FOLLOW_RANGE)) {
      mode = 'reply';
    }

    const situation = [
      jobReferenceContext(snap.me, jobInfo(snap.me.jobId).name, nextJob(snap.me), { details: /อาชีพ|จุติ|ไฮคลาส|class|job|rebirth|blacksmith|whitesmith|mechanic|meister/i.test(ev.text) }),
      `แมพ: ${snap.me.map} ตำแหน่ง ${snap.me.x},${snap.me.y}`,
      `เลเวล: ${snap.me.baseLevel}/${snap.me.jobLevel} HP ${snap.me.hp}/${snap.me.maxHp}`,
      `กำลังทำ: ${brain.plan.objective || 'เก็บเลเวล'}${snap.target ? ` (ตี ${snap.target.name} อยู่)` : ''}`,
      `ช่องแชท: ${ev.channel}`,
      aboutOwner ? `ผู้เล่นถามถึงเจ้าของตัวละคร -> ตอบว่า${config.game.ownerName}ทำงานอยู่` : '',
      mode === 'reply_and_follow' ? 'เราจะเดินตามเขาไป ให้ตอบรับสั้นๆ' : '',
      mode === 'reply_and_wait' ? 'เราจะหยุดรอสักครู่ ให้ตอบรับสั้นๆ' : '',
    ].filter(Boolean).join('\n');

    const messages = [
      { role: 'system', content: CHAT_SYSTEM },
      { role: 'system', content: `สถานการณ์ตอนนี้:\n${situation}` },
      ...history(ev.from).slice(0, -1).map((m) => ({
        role: m.from === 'me' ? 'assistant' : 'user',
        content: m.from === 'me' ? m.text : `${ev.from}: ${m.text}`,
      })),
      { role: 'user', content: `${ev.from}: ${ev.text}` },
    ];
    let reply = await llm.chat(messages, { maxTokens: 80, temperature: 0.8 });
    const raw = reply;
    reply = sanitizeReply(raw);
    if (!reply) {
      log('chat_dropped', { reason: 'empty or command-like reply', text: String(raw).slice(0, 90) });
      return;
    }
    if (FOREIGN_SCRIPT.test(reply)) {
      log('chat_dropped', { reason: 'foreign script', text: reply });
      return;
    }

    // A beat of "typing" time so it doesn't read like an instant bot.
    await Bun.sleep(800 + Math.min(reply.length * 60, 3000));
    if (ev.channel === 'whisper') await act(page, 'whisper', { to: ev.from, text: reply });
    else if (ev.channel === 'party') await act(page, 'party', { text: reply });
    else if (ev.channel === 'guild') await act(page, 'guild', { text: reply });
    else await act(page, 'say', { text: reply });
    sent.push({ t: Date.now(), to: ev.from });
    remember(ev.from, 'me', reply);
    log('chat_out', { channel: ev.channel, to: ev.from, text: reply });

    if (mode === 'reply_and_follow') {
      brain.mode = { kind: 'follow', name: ev.from, until: Date.now() + 5 * 60 * 1000 };
    } else if (mode === 'reply_and_wait') {
      brain.mode = { kind: 'wait', until: Date.now() + 60 * 1000 };
    }
  }

  async function pump(getSnap) {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const ev = queue.shift();
        try {
          await handle(ev, await getSnap());
        } catch (err) {
          log('chat_error', { error: err.message, from: ev.from });
        }
      }
    } finally {
      busy = false;
    }
  }

  return {
    push(ev, getSnap) {
      if (!ev.text || !ev.from) return;
      if (!receivedAllowed(ev.from)) {
        log('chat_flood', { from: ev.from, channel: ev.channel });
        return;
      }
      queue.push(ev);
      if (queue.length > QUEUE_MAX) {
        // Shed public chatter first so a whisper/party line is the last thing to go.
        const i = queue.findIndex((q) => q.channel === 'public');
        queue.splice(i === -1 ? 0 : i, 1);
      }
      pump(getSnap);
    },
  };
}
