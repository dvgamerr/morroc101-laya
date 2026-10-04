// Refining/forging ores and elemental stones are deposited before any sale.
const ORES = new Set([969, 984, 985, 990, 991, 992, 993, 994, 995, 996, 997, 998, 999, 1000, 1001, 1002, 1003, 1010, 1011]);
export const isOre = i => !i.gear && (ORES.has(i.ITID) || /\b(?:ore|oridecon|elunium|bradium|carnium)\b|แร่/i.test(i.name || ''));
export const oresIn = snap => (snap.inventory || []).filter(i => i.count > 0 && !i.equipped && isOre(i));
