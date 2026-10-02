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
const OWNER_WORDS = new RegExp(`(${config.game.ownerName.replace(/^พี่/, '')}|เจ้าของ|คนเล่น|owner|ใครเล่น|ตัวจริง)`, 'i');
// Qwen sometimes drifts into Chinese/Japanese/Korean mid-sentence; such a line is not sent.
const FOREIGN_SCRIPT = /[぀-ヿ㐀-鿿가-힯]/;

// Two bots answering each other would never stop; neither would a spammer.
const PER_PLAYER_PER_MIN = 4;
const TOTAL_PER_MIN = 10;

export function createChat(page, brain) {
  const queue = [];
  const sent = []; // { t, to }
  let busy = false;

  function allowed(to) {
    const now = Date.now();
    while (sent.length && now - sent[0].t > 60000) sent.shift();
    return sent.length < TOTAL_PER_MIN && sent.filter((s) => s.to === to).length < PER_PLAYER_PER_MIN;
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
    reply = reply.split('\n')[0].replace(/^["'“]|["'”]$/g, '').replace(/^[@/]+/, '').trim().slice(0, 90);
    if (!reply) return;
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
      queue.push(ev);
      if (queue.length > 10) queue.shift();
      pump(getSnap);
    },
  };
}
