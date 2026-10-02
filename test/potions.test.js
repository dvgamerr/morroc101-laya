import { test, expect } from 'bun:test';
import { choosePotion, pickBottle, hpsOf, healOf, usefulHeal, createDamageTracker, POTIONS } from '../src/potions.js';

const potion = (name) => POTIONS.find((p) => p.name === name);
const me = (over = {}) => ({ maxHp: 1000, hp: 400, stats: { vit: 0 }, ...over });

test('heal per bottle grows with VIT (2% per point); HP/s is that over the drink gap', () => {
  expect(healOf(potion('Red Potion'), me())).toBe(55);
  expect(healOf(potion('Red Potion'), me({ stats: { vit: 50 } }))).toBe(110);
  expect(hpsOf(potion('White Potion'), me())).toBeCloseTo(365 / 0.4);
});

test('overheal is waste: a White Potion on a 200 HP character lands only the missing part', () => {
  expect(usefulHeal(potion('White Potion'), me({ maxHp: 200 }))).toBeCloseTo(110);
  expect(usefulHeal(potion('White Potion'), me({ maxHp: 5000 }))).toBe(365);
});

test('light damage: the cheapest potion per healed HP that keeps up (Red)', () => {
  const c = choosePotion({ me: me(), dps: 20 });
  expect(c.potion.name).toBe('Red Potion');
  expect(c.outpaced).toBe(false);
});

test('heals must run 2.5x the enemy damage (fight, not just drink): heavier hits need stronger potions', () => {
  // One bottle every 0.4s: Red ~138 HP/s, Orange ~312, Yellow ~512, White ~912.
  expect(choosePotion({ me: me(), dps: 50 }).potion.name).toBe('Red Potion'); // need 125
  expect(choosePotion({ me: me(), dps: 80 }).potion.name).toBe('Orange Potion'); // need 200; Red too slow
  expect(choosePotion({ me: me(), dps: 140 }).potion.name).toBe('Yellow Potion'); // need 350; Orange too slow
  expect(choosePotion({ me: me(), dps: 300 }).potion.name).toBe('White Potion'); // need 750; Yellow too slow
  expect(choosePotion({ me: me(), dps: 400 }).outpaced).toBe(true); // need 1000: nothing keeps up -> hunt elsewhere
});

test('budget limits the choice; outpaced when nothing affordable keeps up', () => {
  const c = choosePotion({ me: me(), dps: 140, budget: 3000 });
  expect(c.potion.name).toBe('Orange Potion'); // Yellow x10 = 5500 > budget
  expect(c.outpaced).toBe(true);
  expect(choosePotion({ me: me(), dps: 20, budget: 100 }).potion).toBe(null);
});

test('real shop prices change the pick', () => {
  const prices = { 501: 500, 502: 200, 503: 550, 504: 1200 }; // Red overpriced here
  expect(choosePotion({ me: me(), dps: 20, prices }).potion.name).toBe('Orange Potion');
});

test('no fight data yet: plan for 5% of max HP per second', () => {
  expect(choosePotion({ me: me({ maxHp: 1000 }) }).need).toBeCloseTo(125);
});

test('drinking: the bottle that fits the missing HP; the biggest in an emergency', () => {
  const inv = [
    { index: 1, ITID: 501, count: 10 },
    { index: 2, ITID: 504, count: 3 },
  ];
  expect(pickBottle(inv, me({ hp: 900 })).ITID).toBe(501); // 100 missing: White would waste most
  expect(pickBottle(inv, me({ hp: 550 })).ITID).toBe(504); // 450 missing: White fits
  expect(pickBottle(inv, me({ hp: 960 })).ITID).toBe(501); // even Red overshoots: the smallest
  expect(pickBottle(inv, me({ hp: 100 })).ITID).toBe(504); // emergency
  expect(pickBottle([{ index: 5, ITID: 909, count: 3 }], me())).toBe(null);
});

test('damage tracker: p90 of damage/s while being hit, after enough samples', () => {
  const t = createDamageTracker();
  for (let i = 0; i < 10; i++) t.sample({ attackers: [1], damageTaken6s: 60 });
  expect(t.p90()).toBe(null);
  for (let i = 0; i < 20; i++) t.sample({ attackers: [1], damageTaken6s: 60 + i * 6 });
  t.sample({ attackers: [], damageTaken6s: 9999 }); // not fighting: ignored
  expect(t.p90()).toBeGreaterThan(20);
  expect(t.p90()).toBeLessThan(40);
});

test('bagHps: the fastest healing the carried bottles give', async () => {
  const { bagHps } = await import('../src/potions.js');
  expect(bagHps([], me())).toBe(0);
  expect(bagHps([{ ITID: 501, count: 3 }, { ITID: 503, count: 1 }], me())).toBeCloseTo(205 / 0.4);
});

test('too easy: potions keep up with room to spare and we hardly drink → hunt stronger monsters', async () => {
  const { tooEasy } = await import('../src/potions.js');
  // The live case at mjolnir_04: 63 HP/s taken, 446 HP/s carried, barely drinking.
  expect(tooEasy({ dps: 63, carried: 446, drinkShare: 0.02 })).toBe(true);
  expect(tooEasy({ dps: 150, carried: 446, drinkShare: 0.02 })).toBe(false); // needs 375, margin too thin
  expect(tooEasy({ dps: 63, carried: 446, drinkShare: 0.3 })).toBe(false); // drinking a lot anyway
  expect(tooEasy({ dps: null, carried: 446, drinkShare: 0 })).toBe(false); // no fights seen yet
});
