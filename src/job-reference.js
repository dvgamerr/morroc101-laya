import { readFileSync } from 'node:fs';

const root = new URL('../docs/references/job-change/', import.meta.url);
// Only the small condition index is read at startup. Stage guides are read on demand.
const index = JSON.parse(readFileSync(new URL('index.json', root), 'utf8'));
const cache = new Map();
export function jobReference(from, to) {
  return index.find((r) => r.from === from && r.to === to) || null;
}
export function jobLevelEligible(me, ref) {
  return !!ref && (me.baseLevel || 0) >= ref.base && (me.jobLevel || 0) >= ref.job;
}
export function loadJobGuide(ref) {
  if (!ref || !index.includes(ref)) return null;
  if (!cache.has(ref.id)) {
    try {
      const guide = JSON.parse(readFileSync(new URL(ref.id + '.json', root), 'utf8'));
      if (guide.from !== ref.from || guide.to !== ref.to) return null;
      cache.set(ref.id, guide);
    } catch { return null; }
  }
  return cache.get(ref.id);
}
export function jobReferenceContext(me, from, to, { details = false } = {}) {
  const ref = jobReference(from, to);
  const summary = { current: from, next: to, reference: ref?.id || null,
    authority: 'ใช้ข้อมูลนี้แทนแผนเก่าหรือความจำที่ขัดกัน ห้ามแต่งชื่ออาชีพ เงื่อนไข หรือค่าธรรมเนียม',
    status: !to ? 'จบสายหรืออยู่นอก CLASS_PATH' : !ref ? 'ไม่มี reference สำหรับ transition นี้ ห้ามเดา/เปลี่ยนอัตโนมัติ' : 'เงื่อนไขเลเวลเป็นเกณฑ์อ้างอิง ยังต้องให้ NPC เซิร์ฟจริงยืนยัน',
  };
  if (ref) Object.assign(summary, { kind: ref.kind, minimum: { base: ref.base, job: ref.job }, recommendedJob: ref.recommendedJob,
    levelEligible: jobLevelEligible(me, ref), unspentSkillPoints: me.skillPoints ?? 'unknown' });
  if (details && ref) summary.guide = loadJobGuide(ref) || 'โหลดรายละเอียดไม่ได้ ห้ามเดาขั้นตอน';
  return 'job_reference: ' + JSON.stringify(summary);
}
