import { test, expect, mock, beforeEach } from 'bun:test';

process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';
const calls = [];
let layaAnswer = { choice: 'option_1', confidence: 0.9 };
mock.module('../src/browser.js', () => ({
  act: async (_p, name, arg) => calls.push([name, arg]),
  exploreTarget: async () => null,
  query: async () => [],
}));
mock.module('../src/logger.js', () => ({ log: () => {} }));
// The skill-point planner asks the LLM in the background; keep tests off the network.
mock.module('../src/llm.js', () => ({ chat: async () => '{}', parseJson: (t) => JSON.parse(t) }));
mock.module('../src/laya.js', () => ({
  choose: async () => layaAnswer,
  ask: async () => ({}),
}));
const { createDialog, jobChooser, FORBIDDEN } = await import('../src/npc.js');
const { createJobChange } = await import('../src/jobchange.js');
const { nextJob } = await import('../src/goals.js');
const { buildWorld } = await import('../src/world.js');
const { createSkillBook } = await import('../src/skills.js');

beforeEach(() => {
  calls.length = 0;
  layaAnswer = { choice: 'option_1', confidence: 0.9 };
});

const PATH = ['Merchant', 'Blacksmith', 'High Novice', 'High Merchant', 'Whitesmith', 'Mechanic', 'Meister'];

test('next job follows the owner path Merchant -> ... -> Meister, through rebirth', () => {
  const at = (jobId) => nextJob({ jobId }, PATH);
  expect(at(0)).toBe('Merchant');
  expect(at(5)).toBe('Blacksmith');
  expect(at(10)).toBe('High Novice');
  expect(at(4001)).toBe('High Merchant');
  expect(at(4006)).toBe('Whitesmith');
  expect(at(4011)).toBe('Mechanic');
  expect(at(4064)).toBe('Meister');
  expect(at(4253)).toBe(null); // end of the path
  expect(at(1)).toBe(null); // off the path: never guess
});

test('job chooser: the target job, rebirth, confirmations; never forbidden options', () => {
  const c = jobChooser('Blacksmith');
  expect(c.rules(['Alchemist', 'Blacksmith', 'Cancel'], [])).toMatchObject({ index: 1 });
  expect(jobChooser('Mechanic').rules(['Genetic', 'Mechanic (Madogear)'], []).index).toBe(1); // contains, when no exact
  expect(jobChooser('Merchant').rules(['High Merchant', 'Merchant'], []).index).toBe(1); // exact wins
  expect(jobChooser('High Novice').rules(['Rebirth', 'Cancel'], []).index).toBe(0);
  expect(c.rules(['Yes', 'No'], ['Do you really want to become a Blacksmith?']).index).toBe(0);
  expect(c.rules(['Reset Stats', 'Leave'], [])).toBe(null);
  expect(FORBIDDEN.test('Reset Skills')).toBe(true);
});

const snapWith = (dialog) => ({ me: {}, dialog: dialog && { at: Date.now(), idleMs: 0, ...dialog } });

test('dialog: Next, menu by rules, Close — and a transcript', async () => {
  const d = createDialog({});
  await d.start({ GID: 9, name: 'Job Master' }, jobChooser('Blacksmith'));
  expect(calls.at(-1)).toEqual(['talk', { GID: 9 }]);
  await d.tick(snapWith({ naid: 9, state: 'next', lines: ['Hello! I can change your job.'] }));
  expect(calls.at(-1)).toEqual(['npc_next', { naid: 9 }]);
  await d.tick(snapWith({ naid: 9, state: 'menu', lines: ['Hello! I can change your job.', 'Pick one:'], menu: ['Alchemist', 'Blacksmith', 'Cancel'] }));
  expect(calls.at(-1)).toEqual(['npc_menu', { naid: 9, num: 2 }]);
  const done = await d.tick(snapWith({ naid: 9, state: 'close', lines: ['Hello! I can change your job.', 'Pick one:', 'Congratulations!'], menu: null }));
  expect(calls.at(-1)).toEqual(['npc_close', { naid: 9 }]);
  expect(done.ok).toBe(true);
  expect(done.transcript).toEqual([
    { npc: ['Hello! I can change your job.'] },
    { npc: ['Pick one:'] },
    { menu: ['Alchemist', 'Blacksmith', 'Cancel'], chose: 'Blacksmith', why: 'matches Blacksmith' },
    { npc: ['Congratulations!'] },
  ]);
});

test('dialog: unknown menu goes to LAYA; unsure LAYA cancels', async () => {
  const d = createDialog({});
  await d.start({ GID: 9, name: 'Job Master' }, jobChooser('Blacksmith'));
  layaAnswer = { choice: 'option_2', confidence: 0.8 };
  await d.tick(snapWith({ naid: 9, state: 'menu', lines: ['?'], menu: ['Talk', 'Requirements'] }));
  expect(calls.at(-1)).toEqual(['npc_menu', { naid: 9, num: 2 }]);

  const d2 = createDialog({});
  await d2.start({ GID: 9, name: 'Job Master' }, jobChooser('Blacksmith'));
  layaAnswer = { choice: 'option_1', confidence: 0.3 };
  const done = await d2.tick(snapWith({ naid: 9, state: 'menu', lines: ['?'], menu: ['Talk', 'Requirements'] }));
  expect(calls.slice(-2)).toEqual([['npc_menu', { naid: 9, num: 255 }], ['npc_close', { naid: 9 }]]);
  expect(done).toMatchObject({ ok: false });
});

test('dialog: NPC that never answers times out, and we cancel+close so the server lets us move again', async () => {
  const d = createDialog({});
  await d.start({ GID: 9, name: 'Healer' }, jobChooser('Blacksmith'));
  const stale = { me: {}, dialog: null };
  expect(await d.tick(stale)).toBe(null);
  const realNow = Date.now;
  Date.now = () => realNow() + 9000;
  const done = await d.tick(stale);
  Date.now = realNow;
  expect(done).toMatchObject({ ok: false, reason: 'NPC did not answer' });
  expect(calls.slice(-2)).toEqual([['npc_menu', { naid: 9, num: 255 }], ['npc_close', { naid: 9 }]]);
});

test('job change trip: qualifies -> travel -> Job Master -> dialog -> verified', async () => {
  const world = buildWorld({ mobs: {}, spawns: [] }, { edges: {}, go: [['prontera', 0, 0]] }, { shops: [] }, { npcs: [['prontera', 153, 193, 'Job Master', '4_M_JOB', 1]] });
  const travel = { dest: null, canGo: true, async start(m) { this.dest = m; }, async stop() { this.dest = null; }, async tick() { return 'traveling'; } };
  const dialog = createDialog({});
  const jc = createJobChange({}, world, travel, dialog);
  const merchant = (over = {}) => ({ me: { jobId: 5, baseLevel: 45, jobLevel: 40, skillPoints: 0, map: 'morocc', x: 1, y: 1, ...over }, npcs: [] });

  expect(jc.maybeStart(merchant({ jobLevel: 30 }))).toBe(null); // not ready
  expect(jc.maybeStart(merchant({ skillPoints: 3 }))).toBe(null); // spend points first
  const started = jc.maybeStart(merchant());
  expect(started).toMatchObject({ goal: 'job_change', target: 'Blacksmith' });

  await jc.tick(merchant());
  expect(travel.dest).toBe('prontera');
  await jc.tick(merchant({ map: 'prontera', x: 150, y: 150 }));
  await jc.tick(merchant({ map: 'prontera', x: 150, y: 150 }));
  expect(calls.at(-1)).toEqual(['walk_to', { x: 153, y: 193 }]);
  const near = (over = {}) => ({ ...merchant({ map: 'prontera', x: 152, y: 191, ...over.me }), npcs: [{ GID: 42, name: 'Job Master', x: 153, y: 193 }], ...over });
  await jc.tick(near());
  expect(calls.at(-1)).toEqual(['talk', { GID: 42 }]);
  await jc.tick(near({ dialog: { naid: 42, state: 'menu', lines: ['Choose'], menu: ['Blacksmith', 'Alchemist'], at: Date.now(), idleMs: 0 } }));
  expect(calls.at(-1)).toEqual(['npc_menu', { naid: 42, num: 1 }]);
  await jc.tick(near({ dialog: { naid: 42, state: 'close', lines: ['Choose', 'Done!'], menu: null, at: Date.now(), idleMs: 0 } }));
  const done = await jc.tick(near({ me: { jobId: 10 } }));
  expect(done).toMatchObject({ ok: true, from: 'Merchant', to: 'Blacksmith', now: 'Blacksmith' });
  expect(jc.active).toBe(false);
});

test('skill points: Basic Skill first for a Novice, then the build order, then anything raisable', () => {
  const book = createSkillBook();
  const snap = (tree, points = 1) => ({ me: { jobId: 0, skillPoints: points, skillTree: tree } });
  expect(book.pickUpgrade(snap([{ id: 1, name: 'NV_BASIC', level: 3, upgradable: true }])).name).toBe('NV_BASIC');
  const merchant = [
    { id: 36, name: 'MC_INCCARRY', level: 3, upgradable: true },
    { id: 42, name: 'MC_MAMMONITE', level: 0, upgradable: true },
    { id: 41, name: 'MC_VENDING', level: 0, upgradable: true },
  ];
  expect(book.pickUpgrade({ me: { jobId: 5, skillPoints: 1, skillTree: merchant } }).name).toBe('MC_MAMMONITE');
  expect(book.pickUpgrade({ me: { jobId: 5, skillPoints: 0, skillTree: merchant } })).toBe(null);
  expect(book.pickUpgrade({ me: { jobId: 5, skillPoints: 1, skillTree: [{ id: 41, name: 'MC_VENDING', level: 0, upgradable: true }] } }).name).toBe('MC_VENDING');
});

const { findNpcEntity } = await import('../src/npc.js');

test('finding the NPC: exact name near the spot; never a nameless entity (the Healer mix-up)', () => {
  const snap = { npcs: [
    { GID: 1, name: '', x: 155, y: 95 }, // hidden script NPC: talking to it gets no answer
    { GID: 2, name: 'Warpra', x: 154, y: 97 },
    { GID: 3, name: 'Healer', x: 153, y: 97 },
  ] };
  expect(findNpcEntity(snap, { name: 'Healer', x: 153, y: 97 }).GID).toBe(3);
  // A different NPC standing next to the spot is not the one we want (it would sell, heal or warp for the wrong reason).
  expect(findNpcEntity({ npcs: [snap.npcs[0], snap.npcs[1]] }, { name: 'Healer', x: 153, y: 97 })).toBe(null);
  expect(findNpcEntity({ npcs: [{ GID: 4, name: 'Kafra Employee#1', x: 150, y: 90 }] }, { name: 'Kafra Employee', x: 151, y: 90 }).GID).toBe(4);
  expect(findNpcEntity(snap, { x: 154, y: 97 }).GID).toBe(2); // an entry without a name: the nearest named one
  expect(findNpcEntity({ npcs: [snap.npcs[0]] }, { name: 'Healer', x: 153, y: 97 })).toBe(null);
});

test('dialog: a rule answering outside the options, or LAYA naming an option we did not offer, is never sent', async () => {
  const d = createDialog({});
  await d.start({ GID: 9, name: 'Job Master' }, { goal: 'x', rules: () => ({ index: 7, why: 'bad' }) });
  layaAnswer = { choice: 'option_9', confidence: 0.9 };
  const done = await d.tick(snapWith({ naid: 9, state: 'menu', lines: ['?'], menu: ['Talk', 'Requirements'] }));
  expect(calls.slice(-2)).toEqual([['npc_menu', { naid: 9, num: 255 }], ['npc_close', { naid: 9 }]]);
  expect(done).toMatchObject({ ok: false });
  for (const bad of [{ choice: 'option_3', confidence: 0.9 }, { choice: 7, confidence: 0.9 }, { choice: 'option_1', confidence: 'high' }, undefined]) {
    calls.length = 0;
    layaAnswer = bad;
    const d2 = createDialog({});
    await d2.start({ GID: 9, name: 'Job Master' }, jobChooser('Blacksmith'));
    await d2.tick(snapWith({ naid: 9, state: 'menu', lines: ['?'], menu: ['Talk', 'Requirements'] }));
    expect(calls.some(([n, a]) => n === 'npc_menu' && a.num !== 255)).toBe(false);
  }
});

test('dialog: an input prompt with no confirmed answer backs out; it never types 0 or an empty text on its own', async () => {
  const d = createDialog({});
  await d.start({ GID: 9, name: 'Job Master' }, jobChooser('Blacksmith'));
  const done = await d.tick(snapWith({ naid: 9, state: 'input', input: 'number', lines: ['How many?'] }));
  expect(calls.some(([n]) => n === 'npc_input')).toBe(false);
  expect(done).toMatchObject({ ok: false });
  // A chooser that knows the answer still gets it through.
  calls.length = 0;
  const d2 = createDialog({});
  await d2.start({ GID: 9, name: 'Job Master' }, { goal: 'x', rules: () => null, input: () => 5 });
  await d2.tick(snapWith({ naid: 9, state: 'input', input: 'number', lines: ['How many?'] }));
  expect(calls.at(-1)).toEqual(['npc_input', { naid: 9, value: 5 }]);
});
