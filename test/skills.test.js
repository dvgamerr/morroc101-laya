import { test, expect, mock, beforeEach } from 'bun:test';

process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';
let llmReply = '{}';
mock.module('../src/llm.js', () => ({
  chat: async () => llmReply,
  parseJson: (t) => JSON.parse(t),
}));
mock.module('../src/logger.js', () => ({ log: () => {} }));
const { createSkillBook, sanitizeSkillPlan, INF } = await import('../src/skills.js');

const SKILLS = [
  { id: 5, name: 'SM_BASH', inf: INF.ENEMY, level: 10, sp: 15, range: 1 },
  { id: 7, name: 'SM_MAGNUM', inf: INF.SELF, level: 5, sp: 30, range: 0 },
  { id: 8, name: 'SM_ENDURE', inf: INF.SELF, level: 3, sp: 10, range: 0 },
  { id: 2, name: 'SM_SWORD', inf: 0, level: 10, sp: 0, range: 0 },
];
const snap = (over = {}) => ({
  me: { GID: 100, jobId: 1, baseLevel: 30, jobLevel: 20, sp: 100, maxSp: 100, skills: SKILLS, status: {}, cooldowns: {}, ...over },
});
const target = { GID: 7, name: 'Poring', x: 101, y: 100, dist: 1 };

let book;
beforeEach(() => {
  llmReply = '{}';
  book = createSkillBook();
});

test('fallback: buffs from the known list, attacks by SP cost; passives never cast', () => {
  book.ensurePlan(snap());
  expect(book.book.buffs).toEqual([8]);
  expect(book.book.attack).toEqual([5]);
});

test('LLM plan is limited to skills the character has, each in the right list', () => {
  const plan = sanitizeSkillPlan({ attack: ['SM_BASH', 'MG_FIREBOLT', 'SM_SWORD'], aoe: ['SM_MAGNUM'], buffs: ['SM_ENDURE', 'SM_BASH'] }, SKILLS);
  expect(plan).toEqual({ attack: [5], aoe: [7], buffs: [8] });
});

test('buff first when it is down, then the damage skill, then a normal attack', () => {
  book.ensurePlan(snap());
  const buff = book.pickBuff(snap());
  expect(buff).toMatchObject({ id: 8, targetID: 100 });
  book.noteCast(buff);
  book.book.lastCastAt = 0; // skip the global gap for the test
  expect(book.pickBuff(snap())).toBe(null); // just cast, status unknown -> assume it's up
  expect(book.pickAttack(snap(), target)).toMatchObject({ id: 5, targetID: 7 });
  expect(book.pickAttack(snap({ sp: 10 }), target)).toBe(null); // SP floor / cost
  expect(book.pickAttack(snap({ cooldowns: { 5: 800 } }), target)).toBe(null);
  expect(book.pickAttack(snap(), { ...target, dist: 5 })).toMatchObject({ approach: true }); // out of range: walk up, don't swing
});

test('buffs: press once, wait for the status to run out; learn only timed statuses; drop a wrong mapping', () => {
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    book.ensurePlan(snap());
    book.noteCast(book.pickBuff(snap()));
    book.onEvent({ type: 'status', index: 622, on: true, remain: 0 }); // timer-less: not the buff's
    book.onEvent({ type: 'status', index: 21, on: true, remain: 60000 });
    expect(book.book.buffStatus[8]).toBe(21);
    t += 1000;
    expect(book.pickBuff(snap({ status: {} }))).toBe(null); // just cast: never spam (the 4x/s bug)
    t += 20000;
    expect(book.pickBuff(snap({ status: { 21: 40000 } }))).toBe(null); // still up
    expect(book.pickBuff(snap({ status: {} }))).toMatchObject({ id: 8 }); // ran out: press again
    // a mapping whose status never shows after a cast is forgotten
    book.noteCast({ id: 8 });
    book.book.buffStatus[8] = 999;
    t += 16000;
    book.pickBuff(snap({ status: {} }));
    expect(book.book.buffStatus[8]).toBe(undefined);
  } finally {
    Date.now = realNow;
  }
});

test('a failed cast backs that skill off', () => {
  book.ensurePlan(snap());
  book.onEvent({ type: 'skill_fail', SKID: 5 });
  expect(book.pickAttack(snap(), target)).toBe(null);
});

test('area skills come first when monsters bunch up', async () => {
  llmReply = JSON.stringify({ attack: ['SM_BASH'], aoe: ['SM_MAGNUM'], buffs: [] });
  book.ensurePlan(snap());
  await Bun.sleep(10);
  expect(book.pickAttack(snap(), target, 1)).toMatchObject({ id: 5 });
  expect(book.pickAttack(snap(), target, 4)).toMatchObject({ id: 7, targetID: 100 });
});

const { withNames } = await import('../src/skilldb.js');

test('nameless skills from newer clients get aegis names by id, else the display label', () => {
  const named = withNames([
    { id: 155, name: '', label: 'Crazy Uproar', inf: INF.SELF, level: 1, sp: 8 },
    { id: 42, name: '', label: 'Mammonite', inf: INF.ENEMY, level: 5, sp: 5 },
    { id: 9999, name: '', label: 'Mystery Skill', inf: INF.ENEMY, level: 1, sp: 1 },
  ]);
  expect(named.map((s) => s.name)).toEqual(['MC_LOUD', 'MC_MAMMONITE', 'Mystery Skill']);
});

test('Merchant buffs and attacks work with no names from the server (the bug that left buffs unpressed)', () => {
  const merchant = withNames([
    { id: 155, name: '', label: 'Crazy Uproar', inf: INF.SELF, level: 1, sp: 8, range: 0 },
    { id: 42, name: '', label: 'Mammonite', inf: INF.ENEMY, level: 5, sp: 5, range: 1 },
  ]);
  const b = createSkillBook();
  const s = { me: { GID: 100, jobId: 5, baseLevel: 50, zeny: 100000, sp: 50, maxSp: 50, skills: merchant, status: {}, cooldowns: {} } };
  b.ensurePlan(s);
  expect(b.pickBuff(s)).toMatchObject({ id: 155, name: 'MC_LOUD' });
  b.book.lastCastAt = 0;
  b.book.lastBuffAt[155] = Date.now();
  expect((b.setBosses(['Phreeoni']), b.pickAttack(s, { GID: 7, name: 'Phreeoni', x: 1, y: 1, dist: 1 }))).toMatchObject({ id: 42 });
});

test('the LLM may name skills by display label', () => {
  const skills = withNames([{ id: 42, name: '', label: 'Mammonite', inf: INF.ENEMY, level: 5, sp: 5 }]);
  expect(sanitizeSkillPlan({ attack: ['mammonite'] }, skills).attack).toEqual([42]);
});

test('spam: casts allowed back to back after the short gap; failures back off 1s, 2s, 4s…', () => {
  book.ensurePlan(snap());
  book.book.lastBuffAt[8] = Date.now(); // buff is up
  const first = book.pickAttack(snap(), target);
  book.noteCast(first);
  expect(book.pickAttack(snap(), target)).toBe(null); // same breath
  book.book.lastCastAt = Date.now() - 200;
  expect(book.pickAttack(snap(), target)).toMatchObject({ id: 5 }); // 200ms later: again
  book.onEvent({ type: 'skill_fail', SKID: 5 });
  const first_block = book.book.blockedUntil[5] - Date.now();
  book.onEvent({ type: 'skill_fail', SKID: 5 });
  book.onEvent({ type: 'skill_fail', SKID: 5 });
  const third_block = book.book.blockedUntil[5] - Date.now();
  expect(first_block).toBeLessThanOrEqual(1000);
  expect(third_block).toBeGreaterThan(3000);
});

test('Mammonite costs zeny: only cast while money stays above the reserve (61 casts once drained the purse)', () => {
  const skills = withNames([{ id: 42, name: '', label: 'Mammonite', inf: INF.ENEMY, level: 10, sp: 5, range: 1 }]);
  const b = createSkillBook();
  const at = (zeny) => ({ me: { GID: 100, jobId: 5, baseLevel: 80, zeny, sp: 50, maxSp: 50, skills, status: {}, cooldowns: {} } });
  b.ensurePlan(at(100000));
  expect((b.setBosses(['Phreeoni']), b.pickAttack(at(100000), { GID: 7, name: 'Phreeoni', x: 1, y: 1, dist: 1 }))).toMatchObject({ id: 42 });
  expect(b.pickAttack(at(40500), { GID: 7, name: 'Phreeoni', x: 1, y: 1, dist: 1 })).toBe(null); // reserve at 80 = 40000; 40500 - 1000 < it
});

test('on/off toggles (Maximize Power) are never kept up as buffs: recasting would switch them off', () => {
  const skills = withNames([
    { id: 114, name: '', label: 'Maximize Power', inf: INF.SELF, level: 5, sp: 10 },
    { id: 111, name: '', label: 'Adrenaline Rush', inf: INF.SELF, level: 5, sp: 20 },
  ]);
  expect(sanitizeSkillPlan({ buffs: ['BS_MAXIMIZE', 'BS_ADRENALINE'] }, skills).buffs).toEqual([111]);
});

test('Maximize Power (a toggle): switched on only while its status is absent — never pressed while on', () => {
  const { setSystemTime } = require('bun:test');
  const MAX = { id: 114, name: 'BS_MAXIMIZE', inf: INF.SELF, level: 5, sp: 10, range: 0 };
  const skills = [...SKILLS, MAX];
  book.ensurePlan(snap({ skills }));
  expect(book.book.buffs).not.toContain(114); // not a "refresh" buff
  const off = book.pickToggle(snap({ skills }));
  expect(off).toMatchObject({ id: 114, toggle: true });
  book.noteCast(off);
  setSystemTime(Date.now() + 1000);
  expect(book.pickToggle(snap({ skills }))).toBe(null); // just pressed: wait for the status, no double press
  setSystemTime(Date.now() + 10000);
  expect(book.pickToggle(snap({ skills, status: { 26: 0 } }))).toBe(null); // on: leave it alone
  expect(book.pickToggle(snap({ skills }))).toMatchObject({ id: 114 }); // went off: on again
  setSystemTime();
});

test('Greed is left out of the plan (the server has autoloot): not offered to the LLM, not in the fallback', async () => {
  const GREED = { id: 1013, name: 'BS_GREED', label: 'Greed', inf: INF.SELF, level: 1, sp: 10, range: 0 };
  const LOUD = { id: 155, name: 'MC_LOUD', inf: INF.SELF, level: 1, sp: 8, range: 0 };
  const skills = [GREED, LOUD];
  llmReply = JSON.stringify({ attack: [], aoe: ['BS_GREED'], buffs: ['BS_GREED', 'MC_LOUD'] });
  book.ensurePlan(snap({ skills }));
  expect(book.book.buffs).toEqual([155]);
  await Bun.sleep(10); // the LLM plan lands
  expect(book.book.buffs).toEqual([155]);
  expect(book.book.aoe).toEqual([]);
});

test('Cart Revolution waits for a group: 2+ monsters in the target 3x3, otherwise not cast (saves SP)', () => {
  const CART = { id: 153, name: 'MC_CARTREVOLUTION', inf: INF.ENEMY, level: 1, sp: 12, range: 1 };
  const skills = [CART];
  book.ensurePlan(snap({ skills }));
  book.book.attack = [153];
  expect(book.pickAttack(snap({ skills }), target, 1, 1)).toBe(null); // alone: normal attack
  expect(book.pickAttack(snap({ skills }), target, 2, 2)).toMatchObject({ id: 153 }); // two bunched up
});

test('Mammonite (costs zeny) only on bosses / mini-bosses; ordinary monsters get the next skill', () => {
  const MAMMO = { id: 42, name: 'MC_MAMMONITE', inf: INF.ENEMY, level: 10, sp: 5, range: 1 };
  const skills = [MAMMO, SKILLS[0]];
  book.ensurePlan(snap({ skills }));
  book.book.attack = [42, 5];
  book.setBosses(['Phreeoni', 'Furious Goblin']);
  const rich = { skills, zeny: 500000 };
  expect(book.pickAttack(snap(rich), { ...target, name: 'Goblin' })).toMatchObject({ id: 5 });
  expect(book.pickAttack(snap(rich), { ...target, name: 'Phreeoni' })).toMatchObject({ id: 42 });
  expect(book.pickAttack(snap(rich), { ...target, name: 'Furious Goblin' })).toMatchObject({ id: 42 });
});

test('bossNames: boss-sized HP or an elite variant', async () => {
  const { bossNames } = await import('../src/world.js');
  const world = { mobs: new Map([[1, { name: 'Goblin', hp: 1200 }], [2, { name: 'Phreeoni', hp: 300000 }], [3, { name: 'Furious Goblin', hp: 9000 }]]) };
  expect([...bossNames(world)].sort()).toEqual(['Furious Goblin', 'Phreeoni']);
});

test('skill points never go into Vending / crafting while a fighting skill can still be raised', () => {
  const tree = [
    { id: 41, name: 'MC_VENDING', level: 1, upgradable: true },
    { id: 109, name: 'BS_SKINTEMPER', level: 4, upgradable: true },
  ];
  const s = { me: { jobId: 10, skillPoints: 1, skillTree: tree } };
  book.book; // plan from the fallback (LLM reply is '{}')
  expect(book.pickUpgrade(s)).toMatchObject({ name: 'BS_SKINTEMPER' });
  // Only Vending left: it gets the point (unspent points block job changes).
  expect(book.pickUpgrade({ me: { jobId: 10, skillPoints: 1, skillTree: [tree[0]] } })).toMatchObject({ name: 'MC_VENDING' });
});
