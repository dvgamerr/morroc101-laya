// Smoke test with the real prompts: can we reach LAYA and oMLX, how fast, and do the answers make sense?
import * as laya from './laya.js';
import * as llm from './llm.js';
import { config } from './config.js';
import { CHAT_SYSTEM, PLANNER_SYSTEM } from './prompts.js';

let ok = true;
const timed = async (label, fn) => {
  const t = Date.now();
  try {
    const out = await fn();
    console.log(`${label} ok (${Date.now() - t}ms)`, typeof out === 'string' ? out : JSON.stringify(out));
    return out;
  } catch (err) {
    ok = false;
    console.error(`${label} failed (${Date.now() - t}ms):`, err.message);
  }
};

const combat = () =>
  laya.choose(
    { hp_percent: 22, monsters_attacking_me: 3, hp_potions: 0, fly_wings: 2 },
    'You control a Ragnarok Online character. Choose the safest next action.',
    {
      attack_monster: 'keep attacking the nearest monster',
      fly_wing: 'teleport away with a Fly Wing',
      rest: 'sit down to regenerate',
    },
  );
await timed('LAYA combat #1', combat);
await timed('LAYA combat #2', combat);

for (const message of ['พี่เขมอยู่ไหมครับ', 'ฟาร์มตรงนี้ดีไหม', 'ขายของไหม']) {
  await timed(`LAYA noul "${message}"`, async () => {
    const a = await laya.ask(
      { channel: 'whisper', from: 'KemRO', message },
      {
        about_owner: {
          type: 'noul',
          instructions: `Does the message ask about the character's owner or real player (${config.game.ownerName}), e.g. where they are or whether they are here?`,
        },
      },
    );
    return { about_owner: a.about_owner.probability };
  });
}

await timed('oMLX warm-up', () => llm.chat([{ role: 'user', content: 'ping' }], { maxTokens: 5, timeoutMs: 120000 }));
await timed('oMLX chat', () =>
  llm.chat(
    [
      { role: 'system', content: CHAT_SYSTEM },
      { role: 'system', content: `สถานการณ์ตอนนี้:\nแมพ: prt_fild08\nกำลังทำ: เก็บเลเวล\nช่องแชท: whisper\nผู้เล่นถามถึงเจ้าของตัวละคร -> ตอบว่า${config.game.ownerName}ทำงานอยู่` },
      { role: 'user', content: 'KemRO: พี่เขมอยู่ไหมครับ' },
    ],
    { maxTokens: 80 },
  ),
);
await timed('oMLX planner', async () => {
  const text = await llm.chat(
    [
      { role: 'system', content: PLANNER_SYSTEM },
      { role: 'user', content: 'เหตุที่เรียก planner: เริ่มเล่น\nตัวละคร: Test jobId=0 Base 5 Job 3\nHP 60/60 Zeny 500\nแมพ prt_fild08\nมอนที่เห็น: Poring x4, Lunatic x1\nของใช้ในกระเป๋า: Novice Potion x10' },
    ],
    { maxTokens: 500, temperature: 0.3, json: true },
  );
  const plan = llm.parseJson(text);
  if (!plan) throw new Error(`not JSON: ${text.slice(0, 200)}`);
  return plan;
});

process.exit(ok ? 0 : 1);
