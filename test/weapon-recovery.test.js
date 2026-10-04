import { test, expect } from 'bun:test';
import { createWeaponRecovery } from '../src/weapon-recovery.js';

const axe = { slot: 'weapon', index: 2, ITID: 1360, name: 'Two-Handed Axe', loc: 34 };
const loose = { ...axe, type: 5, count: 1, equipped: false, gear: { identified: true, damaged: false } };
const worn = { worn: [axe], inventory: [] };
const stripped = { worn: [], inventory: [loose] };

test('remembers Equipment weapon even when it is absent from Inventory', () => {
  const saved = [];
  const weapons = createWeaponRecovery(null, w => saved.push(w));
  weapons.observe(worn);
  expect(saved).toEqual([{ index: 2, ITID: 1360, name: 'Two-Handed Axe', loc: 34 }]);
  expect(weapons.pick(stripped)).toMatchObject({ index: 2, loc: 34 });
  expect(weapons.protected(stripped, loose)).toBe(true);
  expect(weapons.ready(stripped)).toBe(false);
  // Sending equip is not enough: only Equipment confirms the restoration.
  expect(weapons.pending(stripped)).toBe(true);
  expect(weapons.ready(worn)).toBe(true);
  expect(weapons.pick(worn)).toBeNull();
});

test('restores the saved weapon after restart without a strip status', () => {
  const weapons = createWeaponRecovery(axe);
  expect(weapons.pick({ ...stripped, me: { status: {} } })).toMatchObject({ index: 2 });
  expect(weapons.ready(stripped)).toBe(false);
});

test('does not substitute a duplicate or reuse an index belonging to another item', () => {
  const weapons = createWeaponRecovery(axe);
  for (const item of [{ ...loose, index: 9 }, { ...loose, ITID: 28705 }, { ...loose, count: 0 }]) {
    const s = { worn: [], inventory: [item] };
    expect(weapons.pick(s)).toBeNull();
    expect(weapons.ready(s)).toBe(false);
  }
});

test('broken stripped weapon stays protected and blocks selling', () => {
  const weapons = createWeaponRecovery(axe);
  const item = { ...loose, gear: { identified: true, damaged: true } };
  const s = { worn: [], inventory: [item] };
  expect(weapons.pick(s)).toBeNull();
  expect(weapons.protected(s, item)).toBe(true);
  expect(weapons.ready(s)).toBe(false);
});

test('unavailable Equipment does not clear remembered weapon or permit a sale', () => {
  const weapons = createWeaponRecovery(axe);
  expect(weapons.ready({ worn: null, inventory: [] })).toBe(false);
  expect(weapons.pick({ worn: null, inventory: [] })).toBeNull();
  expect(weapons.pick(stripped)).toMatchObject({ index: 2 });
});

test('a confirmed replacement becomes the remembered weapon', () => {
  const weapons = createWeaponRecovery(axe);
  const next = { ...axe, index: 20, ITID: 28705, name: 'Crimson Dagger', loc: 2 };
  weapons.observe({ worn: [next], inventory: [loose] });
  expect(weapons.protected({ worn: [next], inventory: [loose] }, loose)).toBe(false);
  const item = { ...loose, ...next };
  expect(weapons.pick({ worn: [], inventory: [loose, item] })).toMatchObject({ index: 20, loc: 2 });
});
