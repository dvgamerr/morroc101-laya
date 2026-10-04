import { readFileSync, writeFileSync } from 'node:fs';
import reference from '../docs/references/gear/upgrade.json';
import catalog from '../docs/references/gear/npc-catalog.json';

const STORAGE_FILE = 'logs/gear-storage.json';
const materialIds = new Set(reference.materials.map(i => i.id));
const targets = new Set(reference.candidateIdsByPriority);
export const gearReference = reference;
export function gearTargets(snap) {
  const job = snap.me.jobId;
  const selected = reference.ownerSelectedByJob?.[job] || {};
  if (![10, 4011, 4058, 4064, 4253].includes(job)) return [];
  const tier = job === 10 ? 'Normal' : job === 4011 ? 'Upper' : job === 4253 ? 'Fourth' : 'All_Third';
  const slots = ['weapon', 'head_top', 'armor', 'garment', 'shoes'];
  const slotOf = i => i.server?.subType === '2hAxe' ? 'weapon' : i.server?.locations?.Head_Top ? 'head_top' : i.server?.locations?.Armor ? 'armor' : i.server?.locations?.Garment ? 'garment' : i.server?.locations?.Shoes ? 'shoes' : null;
  const eligible = catalog.items.filter(i => i.server?.refineable && i.server.minLevel <= snap.me.baseLevel &&
    (i.server.classes.All || i.server.classes[tier]) &&
    (i.server.jobs.Blacksmith || (i.server.jobs.All && i.server.jobs.Blacksmith !== false)) && slotOf(i));
  return slots.map(slot => eligible.filter(i => slotOf(i) === slot)
    .map(i => ({ ...i, slot, shop: [...i.shops].filter(s => s.price > 0).sort((a,b) => a.price-b.price)[0] }))
    .filter(i => i.shop).sort((a,b) => Number(b.id === selected[slot])-Number(a.id === selected[slot]) || b.shop.price-a.shop.price || Number(targets.has(b.id))-Number(targets.has(a.id)) || (b.server.defense-a.server.defense))[0]).filter(Boolean);
}
export const GEAR_POLICY = 'เจ้าของสั่งอัปเกรดอุปกรณ์อาชีพปัจจุบันเป็น +7: ใช้ขวานสองมือเท่านั้น ใช้ชุดที่เจ้าของเลือกใน ownerSelectedByJob ก่อน ถ้าไม่มีจึงเลือกของ NPC แพงสุดที่ใส่ได้จริงอย่างละ 1 ชิ้น ตรวจ Equipment/Inventory/Kafra ก่อนซื้อ ห้ามขายวัสดุตีบวกหรือของเป้าหมาย; +7 อาวุธ Lv1-4/เกราะทั่วไปพลาดไม่แตกและไม่ลดระดับ แต่เสียเงิน/วัสดุ ของอาจกลับเข้ากระเป๋า ต้องอ่าน index ใหม่และ equip กลับ; หยุดที่ +7 และเหลือสำรอง 100000 zeny';

export function readGearStorage() {
  try { return JSON.parse(readFileSync(STORAGE_FILE, 'utf8')); } catch { return null; }
}
export function recordGearStorage(snap) {
  if (!snap.storage?.open || !Array.isArray(snap.storage.items) || snap.storage.count !== snap.storage.items.length) return false;
  writeFileSync(STORAGE_FILE, JSON.stringify({ checkedAt: new Date().toISOString(), items: snap.storage.items }, null, 2));
  return true;
}
export function keepForGear(item, snap) {
  return materialIds.has(item.ITID) || targets.has(item.ITID) || (snap && gearTargets(snap).some(t => t.id === item.ITID)) || (item.type === 5 && /two[ -]handed axes/i.test(item.gear?.kind || ''));
}
export function allowedGearWeapon(item) {
  return item.type !== 5 || /two[ -]handed axes/i.test(item.gear?.kind || '');
}

export function gearObjective(snap, currentJob) {
  const storage = readGearStorage();
  const worn = snap.worn || [];
  const owned = [...worn.map(i => ({ ...i, count: 1, equipped: true, gear: i, where: 'equipment' })),
    ...(snap.inventory || []).filter(i => i.count > 0).map(i => ({ ...i, where: 'inventory' })),
    ...(storage?.items || []).map(i => ({ ...i, where: 'kafra_last_audit' }))];
  const pieces = gearTargets(snap).map(item => {
    const id = item.id;
    const matches = owned.filter(i => i.ITID === id);
    return { id, name: item.name, shops: item.shops, description: item.description,
      owned: matches.map(i => ({ index: i.index, where: i.where, refine: i.gear?.refine ?? null })),
      targetRefine: 7, needsPurchase: storage ? matches.length === 0 : null };
  });
  const complete = pieces.length === 5 && pieces.every(p => p.owned.some(i => i.where === 'equipment' && i.refine >= 7));
  return { goal: 'gear', status: complete ? 'complete' : 'pending', currentJob,
    researchJob: reference.jobAtResearch.name, recheckJob: currentJob !== reference.jobAtResearch.name,
    policy: GEAR_POLICY, targetRefine: 7, storageCheckedAt: storage?.checkedAt ?? null,
    nextStep: !storage ? 'audit_kafra' : 'verify_current_job_and_live_npc_quotes',
    candidates: pieces, candidateCaveat: reference.candidateCaveat,
    materials: reference.materials.map(m => ({ ...m, owned: owned.filter(i => i.ITID === m.id).reduce((n, i) => n + (i.count || 0), 0) })),
    normalChanceToReach: reference.normalChanceToReach, steps: reference.steps, sources: reference.sources,
    execution: { storageAudit: 'automatic', purchaseAndRefine: 'automatic_with_server_quotes_and_reserve' } };
}
