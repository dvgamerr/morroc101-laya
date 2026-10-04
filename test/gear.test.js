import { test, expect } from 'bun:test';

process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';
const { spareGear, wearableByLine } = await import('../src/gear.js');

const PATH = ['Merchant', 'Blacksmith', 'High Novice', 'High Merchant', 'Whitesmith', 'Mechanic', 'Meister'];
const g = (index, type, gear, over = {}) => ({ index, type, count: 1, gear: { refine: 0, reqLv: 0, ...gear }, ...over });

// What the bag held on 2026-10-01 (descriptions from the client's iteminfo).
const REVOLVER = g(4, 5, { loc: 34, kind: 'Revolvers', atk: 100, jobs: 'Gunslinger, Rebellion' });
const FIST = g(13, 5, { loc: 2, kind: 'Knuckles', atk: 80, jobs: 'Priest, Monk' });
const DAGGER = g(20, 5, { loc: 2, kind: 'Daggers', atk: 17, jobs: 'Novice, Swordman, Mage, Archer, Merchant, Thief' });
const ANGELIC_GUARD = g(12, 4, { loc: 32, kind: 'อุปกรณ์สวมใส่', def: 30, jobs: 'Novice' });
const NUT_SHELL = g(3, 4, { loc: 256, kind: 'อุปกรณ์สวมใส่', def: 8, jobs: '' });
const NUT_SHELL2 = g(30, 4, { loc: 256, kind: 'อุปกรณ์สวมใส่', def: 8, jobs: '' });
const HOOD = g(15, 4, { loc: 4, kind: 'อุปกรณ์สวมใส่', def: 1, jobs: '' });
const AXE = g(40, 5, { loc: 34, kind: 'Two-Handed Axes', atk: 250, jobs: 'Merchant, Blacksmith' });

const WORN = [
  { slot: 'weapon', loc: 34, atk: 180, def: 0, refine: 0 }, // a two-handed axe
  { slot: 'head_top', loc: 256, atk: 0, def: 4, refine: 0 },
  { slot: 'garment', loc: 4, atk: 0, def: 5, refine: 0 },
];

test('who can wear it: our class line (any stage), or everyone; Novice-only and other classes are out', () => {
  expect(wearableByLine({ jobs: '' }, PATH)).toBe(true);
  expect(wearableByLine({ jobs: 'ทุกอาชีพ ยกเว้น Novice' }, PATH)).toBe(true);
  expect(wearableByLine({ jobs: 'Merchant, Blacksmith' }, PATH)).toBe(true);
  expect(wearableByLine({ jobs: 'Mechanic' }, PATH)).toBe(true);
  expect(wearableByLine({ jobs: 'Novice' }, PATH)).toBe(false);
  expect(wearableByLine({ jobs: 'Priest, Monk' }, PATH)).toBe(false);
});

test('sell: other classes, non-axe weapons, shields (two-handed build), and anything no better than what is worn', () => {
  const sell = spareGear([REVOLVER, FIST, DAGGER, ANGELIC_GUARD, NUT_SHELL, NUT_SHELL2, HOOD, AXE], WORN, PATH);
  expect(sell.has(4)).toBe(true); // gunslinger
  expect(sell.has(13)).toBe(true); // priest/monk
  expect(sell.has(20)).toBe(true); // dagger: a merchant can hold one, but the build is axes
  expect(sell.has(12)).toBe(true); // novice shield
  expect(sell.has(15)).toBe(true); // hood DEF 1 < worn garment DEF 5
  expect(sell.has(40)).toBe(false); // ATK 250 axe beats the worn 180: keep for later
  // Nut Shell DEF 8 beats the worn hat (4): keep ONE, sell the duplicate.
  expect([sell.has(3), sell.has(30)].filter(Boolean).length).toBe(1);
});

test('refined / carded / signed gear (client junk rules) is never sold; unknown worn gear: only never-wearable goes', () => {
  const refined = g(50, 4, { loc: 4, def: 1, jobs: '' }, { keep: 'ตีบวกแล้ว' });
  expect(spareGear([refined], WORN, PATH).has(50)).toBe(false);
  const sell = spareGear([HOOD, FIST], null, PATH);
  expect(sell.has(13)).toBe(true);
  expect(sell.has(15)).toBe(false);
});
