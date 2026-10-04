import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const file = () => process.env.LESSONS_FILE || 'MEMORY.md';
const START = '<!-- protected-equipment:start -->';
const END = '<!-- protected-equipment:end -->';
const section = /<!-- protected-equipment:start -->[\s\S]*?<!-- protected-equipment:end -->/;
let protectedIds = null;

function readMemory() {
  return existsSync(file()) ? readFileSync(file(), 'utf8') : '# MEMORY\n';
}

function idsFrom(text) {
  return new Set([...text.matchAll(/ITID=(\d+)/g)].map(m => Number(m[1])));
}

// Protect by item ID: inventory indexes change after storage, relogging and refining.
// This deliberately protects other copies of the same item as well.
export function isProtectedEquipment(item) {
  protectedIds ??= idsFrom(readMemory().match(section)?.[0] || '');
  return !!item.equipped || protectedIds.has(Number(item.ITID));
}

export function rememberEquipped(snap) {
  if (!snap?.inGame || !Array.isArray(snap.worn) || !Array.isArray(snap.inventory)) {
    throw new Error('Cannot protect startup equipment: equipment snapshot unavailable');
  }
  const current = [...snap.worn, ...snap.inventory.filter(i => i.equipped)
    .map(i => ({ ...i, refine: i.gear?.refine || 0 }))];
  if (current.some(i => !Number.isInteger(i.ITID) || i.ITID <= 0)) {
    throw new Error('Cannot protect startup equipment: invalid item ID');
  }
  let text = readMemory();
  const previous = text.match(section)?.[0] || '';
  const rows = new Map(previous.split('\n').filter(line => /ITID=\d+/.test(line))
    .map(line => [Number(/ITID=(\d+)/.exec(line)[1]), line.trimEnd()]));
  for (const i of current) {
    rows.set(i.ITID, `- ห้ามขาย ITID=${i.ITID}: ${String(i.name).replace(/[\r\n]/g, ' ')} +${i.refine || 0} (${i.slot || 'equipped'})`);
  }
  const block = [START,
    '- ทุกครั้งที่เริ่ม bun start ให้แสดงรายการที่สวมใส่และจำเพิ่มในรายการห้ามขายถาวร แม้ถอดออกแล้ว; กันทุกชิ้นที่มี ITID เดียวกัน และไม่ลบรายการเก่าอัตโนมัติ',
    ...rows.values(), END].join('\n');
  if (previous) text = text.replace(section, () => block);
  else if (text.includes('<!-- owner-hunting-policy:end -->')) {
    text = text.replace('<!-- owner-hunting-policy:end -->', () => `${block}\n<!-- owner-hunting-policy:end -->`);
  } else text += `\n<!-- owner-hunting-policy:start -->\n${block}\n<!-- owner-hunting-policy:end -->\n`;
  writeFileSync(file(), text);
  protectedIds = idsFrom(block);
  return current;
}
