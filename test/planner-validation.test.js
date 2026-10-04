import { expect, mock, test } from 'bun:test';

process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';
const replies = [], requests = [];
mock.module('../src/llm.js', () => ({
  chat: async messages => { requests.push(messages); return JSON.stringify(replies.shift()); },
  parseJson: JSON.parse,
}));
mock.module('../src/logger.js', () => ({ log() {} }));
const { plan } = await import('../src/planner.js');

test('planner accepts a valid map without copying the models cross-map profit claim', async () => {
  const snap = { me: { map: 'morocc', baseLevel: 98, jobId: 10, hp: 8000, maxHp: 8000, sp: 100, maxSp: 100, zeny: 5325 }, inventory: [], worn: [] };
  const ctx = {
    goal: 'money', candidates: [{ map: 'yuno_fild08', hops: 2, targets: [{ name: 'Goat', level: 80, count: 10 }], avoid: [] }],
    farmResults: { ein_fild08: { maps: ['ein_fild08'], net: 1537, zenyPerMinute: 234, finishedAt: 1234 } },
  };
  const base = { current_map: 'morocc', hunt_map: 'yuno_fild08', goal: 'money', target_monsters: ['Goat'] };
  replies.push({ ...base, reason: 'กำไรจริง 1537 zeny', money_evidence: { map: 'ein_fild08', net: 1537, zenyPerMinute: 234, finishedAt: 1234 } });
  const result = await plan(snap, 'test', '', null, ctx);
  expect(requests).toHaveLength(1);
  expect(result.hunt_map).toBe('yuno_fild08');
  expect(result.reason).toContain('ยังไม่มีผลวัดกำไรต่อเวลา');
  expect(result.reason).not.toContain('1537');
});

test('numeric reason and null evidence do not block a valid measured hunting map', async () => {
  requests.length = 0;
  const snap = { me: { map: 'morocc', baseLevel: 98, jobId: 10, hp: 8000, maxHp: 8000, sp: 100, maxSp: 100, zeny: 5325 }, inventory: [], worn: [] };
  const ctx = { goal: 'money', candidates: [{ map: 'in_sphinx1', hops: 1, targets: [{ name: 'Requiem', level: 71, count: 10 }], avoid: [] }],
    farmResults: { in_sphinx1: { maps: ['in_sphinx1'], net: 270, zenyPerMinute: 400, finishedAt: 1234 } } };
  replies.push({ current_map: 'morocc', hunt_map: 'in_sphinx1', target_monsters: ['Requiem'], reason: 'Base 98 มีเงิน 5325', money_evidence: null });
  const result = await plan(snap, 'test', '', null, ctx);
  expect(requests).toHaveLength(1);
  expect(result.reason).toContain('สุทธิ 270 zeny/รอบ, 400 zeny/นาที');
});

test('invalid maps still exhaust retries without automatically selecting a destination', async () => {
  requests.length = 0;
  const snap = { me: { map: 'morocc', baseLevel: 98, jobId: 10, hp: 8000, maxHp: 8000, sp: 100, maxSp: 100, zeny: 5325 }, inventory: [], worn: [] };
  const ctx = { goal: 'money', candidates: [{ map: 'in_sphinx1', hops: 1, targets: [{ name: 'Requiem', level: 71, count: 10 }], avoid: [] }] };
  replies.push({ hunt_map: 'invented' }, { hunt_map: 'invented' });
  await expect(plan(snap, 'test', '', null, ctx)).rejects.toThrow('map_not_in_candidates');
  expect(requests).toHaveLength(2);
});
