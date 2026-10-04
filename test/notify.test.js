import { test, expect, mock, afterAll } from 'bun:test';

process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';
process.env.DISCORD_WEBHOOK_URL = 'https://discord.test/webhook';

const posts = [];
const realFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = realFetch; }); // other test files must not see the mock
globalThis.fetch = mock(async (url, init) => {
  posts.push({ url, body: JSON.parse(init.body) });
  return new Response('', { status: 204 });
});

const { goalChangeTitle, notifyGoalChange } = await import('../src/notify.js');
// .env may hold the real webhook (Bun loads it for tests too); never let a test aim at it.
(await import('../src/config.js')).config.discordWebhook = 'https://discord.test/webhook';
const { sanitize } = await import('../src/planner.js');

test('titles: first plan, goal change, map-only change', () => {
  const lv = { goal: 'level', hunt_map: 'moc_fild07' };
  expect(goalChangeTitle(null, lv)).toBe('⚔️ เริ่มเล่น: เก็บเลเวล');
  expect(goalChangeTitle(lv, { goal: 'sell', hunt_map: 'moc_fild07' })).toBe('🏪 เปลี่ยนเป้าหมาย: เก็บเลเวล → ขายของ');
  expect(goalChangeTitle(lv, { goal: 'level', hunt_map: 'moc_fild11' })).toBe('🗺️ ย้ายที่ล่า: moc_fild07 → moc_fild11');
});

test('posts an embed to the webhook, warning when the agent cannot do the goal itself', async () => {
  const snap = { me: { name: 'Bot', baseLevel: 12, jobLevel: 9, zeny: 1500, map: 'morocc' } };
  notifyGoalChange({ goal: 'level' }, { goal: 'quest', objective: 'ทำเควส Eden', hunt_map: 'moc_fild11', todo: ['คุย NPC เควส'] }, snap);
  await Bun.sleep(50);
  expect(posts.length).toBe(1);
  const embed = posts[0].body.embeds[0];
  expect(posts[0].url).toBe('https://discord.test/webhook');
  expect(embed.title).toBe('📜 เปลี่ยนเป้าหมาย: เก็บเลเวล → ทำเควส');
  expect(embed.description).toContain('ยังทำเรื่องนี้เองไม่ได้');
  expect(embed.fields.find((f) => f.name === 'แมพล่า').value).toBe('moc_fild11');
});

test('planner goal is limited to known categories', () => {
  expect(sanitize({ goal: 'money' }).goal).toBe('money');
  expect(sanitize({ goal: 'go shopping' }).goal).toBe('level');
});

test('automated goals (buy/sell) carry no "do it yourself" warning', async () => {
  posts.length = 0;
  notifyGoalChange({ goal: 'level' }, { goal: 'buy', objective: 'potion ใกล้หมด ไปซื้อ Red Potion' }, { me: { name: 'Bot' } });
  await Bun.sleep(3100);
  expect(posts.at(-1).body.embeds[0].description).toBe('potion ใกล้หมด ไปซื้อ Red Potion');
});

test('character name and level go in the webhook name, not in every embed', async () => {
  posts.length = 0;
  notifyGoalChange(null, { goal: 'level', objective: 'ล่า Goat', hunt_map: 'yuno_fild04' }, { me: { name: 'KemSmith', baseLevel: 83, jobLevel: 45, zeny: 1, map: 'yuno' } });
  await Bun.sleep(3100);
  const body = posts.at(-1).body;
  expect(body.username).toBe('KemSmith Lv.83/45');
  expect(body.embeds[0].fields.map((f) => f.name)).not.toContain('ตัวละคร');
  expect(body.embeds[0].fields.map((f) => f.name)).not.toContain('เลเวล');
});

test('over-long titles and descriptions are cut to the Discord limits', async () => {
  const before = posts.length;
  const { notify } = await import('../src/notify.js');
  notify('t'.repeat(500), 'd'.repeat(5000));
  await Bun.sleep(3100); // MIN_GAP_MS between posts
  const embed = posts[before].body.embeds[0];
  expect(embed.title.length).toBe(256);
  expect(embed.description.length).toBe(4096);
});
