import { test, expect } from 'bun:test';
import { jobReference, jobLevelEligible, loadJobGuide, jobReferenceContext } from '../src/job-reference.js';

test('finds the transition for a job pair and nothing for an unknown one', () => {
  const ref = jobReference('Merchant', 'Blacksmith');
  expect(ref).toMatchObject({ id: 'merchant-blacksmith', base: 1, job: 40 });
  expect(jobReference('Merchant', 'Meister')).toBe(null);
});

test('level eligibility needs both Base and Job', () => {
  const ref = jobReference('Blacksmith', 'High Novice');
  expect(jobLevelEligible({ baseLevel: 99, jobLevel: 50 }, ref)).toBe(true);
  expect(jobLevelEligible({ baseLevel: 98, jobLevel: 50 }, ref)).toBe(false);
  expect(jobLevelEligible({ baseLevel: 99, jobLevel: 49 }, ref)).toBe(false);
  expect(jobLevelEligible({ baseLevel: 99, jobLevel: 50 }, null)).toBe(false);
});

test('loads the stage guide only for a reference from the index, and caches it', () => {
  const ref = jobReference('Merchant', 'Blacksmith');
  const guide = loadJobGuide(ref);
  expect(guide.to).toBe('Blacksmith');
  expect(guide.aliases).toContain('Blacksmith');
  expect(loadJobGuide(ref)).toBe(guide);
  expect(loadJobGuide({ ...ref })).toBe(null); // not the indexed object
  expect(loadJobGuide(null)).toBe(null);
});

test('context never invents a transition', () => {
  const me = { baseLevel: 50, jobLevel: 40, skillPoints: 0 };
  const known = jobReferenceContext(me, 'Merchant', 'Blacksmith');
  expect(known).toContain('"reference":"merchant-blacksmith"');
  expect(known).toContain('"levelEligible":true');
  expect(jobReferenceContext(me, 'Merchant', 'Meister')).toContain('ห้ามเดา');
  expect(jobReferenceContext(me, 'Meister', null)).toContain('จบสาย');
  expect(jobReferenceContext(me, 'Merchant', 'Blacksmith', { details: true })).toContain('"guide"');
});
