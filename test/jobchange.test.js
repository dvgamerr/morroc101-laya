import { test, expect, mock, beforeEach, setSystemTime, afterEach } from 'bun:test';

process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';

mock.module('../src/browser.js', () => ({
  act: async () => true,
  exploreTarget: async () => null,
  query: async () => [],
}));
mock.module('../src/logger.js', () => ({ log: () => {} }));
const { createJobChange } = await import('../src/jobchange.js');
const { buildWorld } = await import('../src/world.js');

const world = buildWorld(
  { mobs: {}, spawns: [] },
  { edges: {}, go: [], nogo: [] },
  { shops: [] },
  { npcs: [['prontera', 153, 193, 'Job Master', 1, 'x']] },
);
// Merchant (jobId 5) with job level 40: ready for Blacksmith.
const merchant = (me = {}) => ({ me: { jobId: 5, baseLevel: 50, jobLevel: 40, skillPoints: 0, map: 'prontera', x: 153, y: 192, ...me }, npcs: [{ name: 'Job Master', GID: 9, x: 153, y: 193 }] });

let now;
const tick = (ms) => setSystemTime((now += ms));
beforeEach(() => {
  now = Date.UTC(2026, 9, 1);
  setSystemTime(now);
});
afterEach(() => setSystemTime());

function make({ dialogResult = null, travelFails = false } = {}) {
  const stopped = [];
  const travel = {
    dest: null,
    start: async function (map) { this.dest = map; },
    tick: async () => (travelFails ? 'failed' : 'traveling'),
    stop: async function () { stopped.push(this.dest); this.dest = null; },
  };
  const dialog = { start: async () => {}, tick: async () => dialogResult };
  return { jc: createJobChange({}, world, travel, dialog), travel, stopped };
}

test('does not start until the level condition and skill points are met', () => {
  const { jc } = make();
  expect(jc.maybeStart(merchant({ jobLevel: 10 }))).toBe(null);
  expect(jc.maybeStart(merchant({ skillPoints: 3 }))).toBe(null);
  expect(jc.maybeStart(merchant())?.goal).toBe('job_change');
  expect(jc.active).toBe(true);
});

test('a failed trip releases the shared travel so the next trip does not resume this one', async () => {
  const { jc, travel, stopped } = make({ travelFails: true });
  jc.maybeStart(merchant());
  const result = await jc.tick(merchant({ map: 'morocc' }));
  expect(result.ok).toBe(false);
  expect(result.note).toBe('travel failed');
  expect(travel.dest).toBe(null);
  expect(stopped).toEqual(['prontera']);
  expect(jc.active).toBe(false);
});

test('a dialog that ended unsuccessfully is reported with its reason instead of waiting for verify', async () => {
  const { jc } = make({ dialogResult: { ok: false, reason: 'cancelled (no matching menu)', transcript: [{ npc: ['hello'] }] } });
  jc.maybeStart(merchant());
  await jc.tick(merchant()); // travel -> approach
  await jc.tick(merchant()); // approach -> dialog
  const result = await jc.tick(merchant());
  expect(result.ok).toBe(false);
  expect(result.note).toContain('cancelled (no matching menu)');
  expect(result.transcript).toEqual([{ npc: ['hello'] }]);
});

test('repeated failures back off instead of retrying every 30 minutes forever', async () => {
  const { jc } = make({ travelFails: true });
  const me = merchant({ map: 'morocc' });
  for (const minutes of [30, 60, 120]) {
    expect(jc.maybeStart(me)).not.toBe(null);
    await jc.tick(me); // fails
    tick((minutes - 1) * 60 * 1000);
    expect(jc.maybeStart(me)).toBe(null); // still cooling down
    tick(2 * 60 * 1000);
  }
  expect(jc.maybeStart(me)).not.toBe(null);
});

test('success resets the back-off', async () => {
  const { jc } = make({ dialogResult: { ok: true, reason: 'closed', transcript: [] } });
  jc.maybeStart(merchant());
  await jc.tick(merchant());
  await jc.tick(merchant());
  await jc.tick(merchant());
  const result = await jc.tick(merchant({ jobId: 10 })); // Blacksmith
  expect(result.ok).toBe(true);
  expect(jc.active).toBe(false);
});

test('rebirth prerequisites from the guide (cart/mount) block the trip with a reason and back off', () => {
  const { jc } = make();
  const bs = (me = {}) => ({ me: { jobId: 10, baseLevel: 99, jobLevel: 50, skillPoints: 0, map: 'prontera', x: 153, y: 192, zeny: 2000000, weight: 0, ...me }, npcs: [] });
  expect(jc.maybeStart(bs({ cart: true }))).toBe(null);
  expect(jc.active).toBe(false);
  tick(31 * 60 * 1000);
  expect(jc.maybeStart(bs({ riding: true }))).toBe(null);
  tick(61 * 60 * 1000);
  // No fee and no weight limit: a loaded, poor character may rebirth.
  expect(jc.maybeStart(bs({ zeny: 100, weight: 5000 }))?.goal).toBe('job_change');
});

test('checkRequirements only refuses on observed violations', async () => {
  const { checkRequirements } = await import('../src/jobchange.js');
  const guide = { requirements: { noCart: true, noMount: true, skillPoints: 0 } };
  expect(checkRequirements({}, guide).ok).toBe(true); // nothing observable: do not guess
  expect(checkRequirements({ cart: true }, guide).reason).toContain('cart/falcon/mount');
  expect(checkRequirements({ riding: true }, guide).ok).toBe(false);
  expect(checkRequirements({ skillPoints: 3 }, guide).reason).toContain('skill points 3');
  expect(checkRequirements({ zeny: 1, weight: 9000, skillPoints: 0 }, guide).ok).toBe(true); // no fee or weight limit
});
