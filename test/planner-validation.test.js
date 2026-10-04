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

test('wrong current map retry supplies the authoritative map separately from the hunt map', async () => {
  requests.length = 0;
  const snap = { me: { map: 'morocc', baseLevel: 98, jobId: 10, hp: 8000, maxHp: 8000, sp: 100, maxSp: 100, zeny: 85104 }, inventory: [], worn: [] };
  const ctx = { goal: 'money', candidates: [{ map: 'moc_fild17', hops: 2, targets: [{ name: 'Hode', level: 63, count: 10 }], avoid: [] }] };
  const answer = { current_map: 'moc_fild17', hunt_map: 'moc_fild17', target_monsters: ['Hode'], reason: 'hunt' };
  replies.push(answer, { ...answer, current_map: 'morocc' });
  const result = await plan(snap, 'returned to town', '', null, ctx);
  expect(result.hunt_map).toBe('moc_fild17');
  expect(requests).toHaveLength(2);
  expect(requests[1].at(-1).content).toContain('"current_map":"morocc"');
  expect(requests[1].at(-1).content).toContain('current_map ที่ตอบ = "moc_fild17"');
  requests.length = 0;
});

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

const snapMorocc = { me: { map: 'morocc', baseLevel: 98, jobId: 10, hp: 8000, maxHp: 8000, sp: 100, maxSp: 100, zeny: 5325 }, inventory: [], worn: [] };
const oneMap = (extra = {}) => ({ goal: 'level', candidates: [{ map: 'in_sphinx1', hops: 1, targets: [{ name: 'Requiem', level: 71, count: 10 }, { name: 'Marduk', level: 70, count: 5 }], avoid: [] }], ...extra });

test('a wrong monster name is retried with the valid names, and repaired rather than rejecting the plan', async () => {
  requests.length = 0;
  const bad = { current_map: 'morocc', hunt_map: 'in_sphinx1', goal: 'level', target_monsters: ['Baphomet'], reason: 'x' };
  replies.push(bad, bad);
  const result = await plan(snapMorocc, 'test', '', null, oneMap());
  expect(requests).toHaveLength(2);
  expect(requests[1].at(-1).content).toContain('["Requiem","Marduk"]');
  expect(result.hunt_map).toBe('in_sphinx1');
  expect(result.target_monsters).toEqual(['Requiem', 'Marduk']);
});

test('a missing reason after the retry does not reject a valid map', async () => {
  requests.length = 0;
  const noReason = { current_map: 'morocc', hunt_map: 'in_sphinx1', goal: 'level', target_monsters: ['Requiem'] };
  replies.push(noReason, noReason);
  const result = await plan(snapMorocc, 'test', '', null, oneMap());
  expect(result.target_monsters).toEqual(['Requiem']);
});

test('LLM failure keeps the current plan while its map is still a candidate, never picks another map', async () => {
  const current = { hunt_map: 'in_sphinx1', target_monsters: ['Requiem'], goal: 'level', objective: 'o', reason: 'r' };
  // The mocked chat reads replies; an empty queue makes JSON.parse(undefined) throw like an LLM outage.
  replies.length = 0;
  const kept = await plan(snapMorocc, 'test', '', current, oneMap());
  expect(kept.hunt_map).toBe('in_sphinx1');
  expect(kept.target_monsters).toEqual(['Requiem']);
  await expect(plan(snapMorocc, 'test', '', { ...current, hunt_map: 'gone' }, oneMap())).rejects.toThrow();
  await expect(plan(snapMorocc, 'test', '', null, oneMap())).rejects.toThrow();
});

test('a planner answer of goal job_change never leaves the planner', async () => {
  const answer = { current_map: 'morocc', hunt_map: 'in_sphinx1', goal: 'job_change', target_monsters: ['Requiem'], reason: 'r' };
  replies.push(answer);
  const result = await plan(snapMorocc, 'test', '', null, { candidates: oneMap().candidates });
  expect(result.goal).toBe('level');
});
