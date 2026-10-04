import { expect, test } from 'bun:test';
import { moneyEvidence, moneyReason } from '../src/planner-evidence.js';
const results = { ein_fild08: { maps: ['ein_fild08'], net: 1537, zenyPerMinute: 234, finishedAt: 1234 } };
test('another maps profit claim never appears as selected-map evidence', () => {
  const p = { hunt_map: 'yuno_fild08', reason: 'กำไรจริง 1537 zeny', money_evidence: moneyEvidence('ein_fild08', results) };
  expect(moneyReason(p, results)).toContain('ยังไม่มีผลวัดกำไรต่อเวลา');
  expect(moneyReason(p, results)).not.toContain('1537');
});
test('missing, null and incorrect model evidence do not change verified figures', () => {
  for (const money_evidence of [undefined, null, { net: 99999 }]) {
    const p = { hunt_map: 'ein_fild08', reason: 'กำไร 99999 zeny', money_evidence };
    expect(moneyReason(p, results)).toContain('ein_fild08: สุทธิ 1537 zeny/รอบ, 234 zeny/นาที');
    expect(moneyReason(p, results)).not.toContain('99999');
  }
});
test('failed routes and combined hunts are not single-map performance evidence', () => {
  expect(moneyEvidence('ein_fild08', { ein_fild08: { ...results.ein_fild08, routeFailure: 'restock' } })).toBeNull();
  expect(moneyEvidence('ein_fild08', { ein_fild08: { ...results.ein_fild08, maps: ['ein_fild08', 'other'] } })).toBeNull();
});
