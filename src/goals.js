import { config } from './config.js';
import { stockHp } from './potions.js';
import { jobReference, jobLevelEligible } from './job-reference.js';

/**
 * Goals, taken one-to-one from the original system document (the long agent
 * prompt + the priority architecture), and the signals the code itself can see
 * that call for each of them ("Priority 60 — important gameplay" in the doc).
 *
 * `auto` is what the agent can carry out on its own today. The others are still
 * planned and announced, so the owner knows, but the hands-on part (NPC dialogs,
 * quests, shops, refining) isn't automated yet.
 */
export const GOALS = {
  level: { label: 'เก็บเลเวล', emoji: '⚔️', auto: true, when: 'ปกติ: ล่ามอนที่เลเวลเหมาะ จนถึง Base 99 และต่อไปจนขึ้น Class 4' },
  money: { label: 'หาเงิน', emoji: '💰', auto: true, when: 'zeny ต่ำกว่าเงินสำรองจนกระทบการเล่น: ล่ามอนที่ drop ขายได้ เก็บของทุกชิ้น' },
  build: { label: 'พัฒนา build', emoji: '📈', auto: true, when: 'มี status/skill point เหลือ: อัป stat และ skill เองตาม build (BUILD)' },
  job_change: { label: 'เปลี่ยนอาชีพ', emoji: '🎓', auto: true, when: 'Job/Base level ถึงเงื่อนไข: @go prontera คุย Job Master เลือกอาชีพถัดไปตามสาย (CLASS_PATH)' },
  sell: { label: 'ขายของ', emoji: '🏪', auto: true, when: 'น้ำหนัก >= 80%: @go/เดินไป Tool Dealer ที่ใกล้สุด ขายของ ETC (ไม่ขายการ์ด/อุปกรณ์)' },
  buy: { label: 'ซื้อของ', emoji: '🛒', auto: true, when: 'potion ใกล้หมดและมีเงินเกินเงินสำรอง: ไปซื้อ potion ตามเลเวลเอง' },
  gear: { label: 'อัปเกรดอุปกรณ์', emoji: '🛡️', auto: false, when: 'มีเงินพอซื้อ/ตีบวก/ใส่การ์ดที่เพิ่ม damage, ความอึด หรือ EXP/ชม. อย่างคุ้มค่า' },
  card_hunt: { label: 'ล่าการ์ด/ไอเทม', emoji: '🃏', auto: false, when: 'มีการ์ดหรือไอเทมที่เหมาะกับ class/build/เลเวลนี้ ที่ล่าเองคุ้มกว่าซื้อ' },
  quest: { label: 'ทำเควส', emoji: '📜', auto: false, when: 'มีเควสที่ช่วยให้เลเวลหรือพัฒนาตัวละครเร็วขึ้น' },
  rest: { label: 'พัก/ฟื้นตัว', emoji: '💤', auto: true, when: 'ตายติดกัน, damage ที่โดนสูงผิดปกติ, หรือ potion ไม่พอให้สู้ต่อ' },
};

export const GOAL_KEYS = Object.keys(GOALS);

// ---- Jobs ---------------------------------------------------------------------
// tier: 0 novice, 1 first class, 2 second, 2.5 transcendent second, 3 third, 4 fourth.
// family picks the stat build (build.js).
const JOB_TABLE = {
  0: ['Novice', 0, 'novice'], 4001: ['High Novice', 0, 'novice'], 4023: ['Baby Novice', 0, 'novice'],
  1: ['Swordman', 1, 'sword'], 2: ['Mage', 1, 'mage'], 3: ['Archer', 1, 'archer'], 4: ['Acolyte', 1, 'acolyte'],
  5: ['Merchant', 1, 'merchant'], 6: ['Thief', 1, 'thief'],
  4002: ['High Swordman', 1, 'sword'], 4003: ['High Mage', 1, 'mage'], 4004: ['High Archer', 1, 'archer'],
  4005: ['High Acolyte', 1, 'acolyte'], 4006: ['High Merchant', 1, 'merchant'], 4007: ['High Thief', 1, 'thief'],
  24: ['Gunslinger', 1, 'gunner'], 25: ['Ninja', 1, 'ninja'], 4046: ['Taekwon', 1, 'taekwon'],
  7: ['Knight', 2, 'sword'], 14: ['Crusader', 2, 'sword'], 8: ['Priest', 2, 'acolyte'], 15: ['Monk', 2, 'monk'],
  9: ['Wizard', 2, 'mage'], 16: ['Sage', 2, 'mage'], 10: ['Blacksmith', 2, 'merchant'], 18: ['Alchemist', 2, 'alchemist'],
  11: ['Hunter', 2, 'archer'], 19: ['Bard', 2, 'archer'], 20: ['Dancer', 2, 'archer'],
  12: ['Assassin', 2, 'thief'], 17: ['Rogue', 2, 'rogue'], 23: ['Super Novice', 2, 'novice'],
  4047: ['Star Gladiator', 2, 'taekwon'], 4049: ['Soul Linker', 2, 'mage'],
  4008: ['Lord Knight', 2.5, 'sword'], 4015: ['Paladin', 2.5, 'sword'], 4009: ['High Priest', 2.5, 'acolyte'],
  4016: ['Champion', 2.5, 'monk'], 4010: ['High Wizard', 2.5, 'mage'], 4017: ['Professor', 2.5, 'mage'],
  4011: ['Whitesmith', 2.5, 'merchant'], 4019: ['Creator', 2.5, 'alchemist'], 4012: ['Sniper', 2.5, 'archer'],
  4020: ['Clown', 2.5, 'archer'], 4021: ['Gypsy', 2.5, 'archer'], 4013: ['Assassin Cross', 2.5, 'thief'],
  4018: ['Stalker', 2.5, 'rogue'],
  4054: ['Rune Knight', 3, 'sword'], 4060: ['Rune Knight', 3, 'sword'], 4066: ['Royal Guard', 3, 'sword'], 4073: ['Royal Guard', 3, 'sword'],
  4055: ['Warlock', 3, 'mage'], 4061: ['Warlock', 3, 'mage'], 4067: ['Sorcerer', 3, 'mage'], 4074: ['Sorcerer', 3, 'mage'],
  4056: ['Ranger', 3, 'archer'], 4062: ['Ranger', 3, 'archer'], 4068: ['Minstrel', 3, 'archer'], 4075: ['Minstrel', 3, 'archer'],
  4069: ['Wanderer', 3, 'archer'], 4076: ['Wanderer', 3, 'archer'],
  4057: ['Arch Bishop', 3, 'acolyte'], 4063: ['Arch Bishop', 3, 'acolyte'], 4070: ['Sura', 3, 'monk'], 4077: ['Sura', 3, 'monk'],
  4058: ['Mechanic', 3, 'merchant'], 4064: ['Mechanic', 3, 'merchant'], 4071: ['Genetic', 3, 'alchemist'], 4078: ['Genetic', 3, 'alchemist'],
  4059: ['Guillotine Cross', 3, 'thief'], 4065: ['Guillotine Cross', 3, 'thief'], 4072: ['Shadow Chaser', 3, 'rogue'], 4079: ['Shadow Chaser', 3, 'rogue'],
  4252: ['Dragon Knight', 4, 'sword'], 4258: ['Imperial Guard', 4, 'sword'], 4255: ['Arch Mage', 4, 'mage'],
  4261: ['Elemental Master', 4, 'mage'], 4257: ['Windhawk', 4, 'archer'], 4263: ['Troubadour', 4, 'archer'],
  4264: ['Trouvere', 4, 'archer'], 4256: ['Cardinal', 4, 'acolyte'], 4262: ['Inquisitor', 4, 'monk'],
  4253: ['Meister', 4, 'merchant'], 4259: ['Biolo', 4, 'alchemist'], 4254: ['Shadow Cross', 4, 'thief'],
  4260: ['Abyss Chaser', 4, 'rogue'],
};

export function jobInfo(jobId) {
  const row = JOB_TABLE[jobId];
  return row ? { id: jobId, name: row[0], tier: row[1], family: row[2] } : { id: jobId, name: `Job#${jobId}`, tier: null, family: 'unknown' };
}

/**
 * Is the character ready for its next job change? Standard Renewal requirements:
 * Novice job 10 -> 1st; 1st job 40 -> 2nd; 2nd base 99 / job 50 -> rebirth or 3rd;
 * transcendent 2nd base 99 / job 50 (70 max) -> 3rd; 3rd base 200 / job 70 -> 4th.
 * The server may differ; this only raises the signal, it changes nothing.
 */
export function jobChangeReady(me) {
  const job = jobInfo(me.jobId);
  const ref = jobReference(job.name, nextJob(me));
  if (ref) return jobLevelEligible(me, ref)
    ? `${ref.from} → ${ref.to} (${ref.kind}): ถึงเกณฑ์ Base ${ref.base}/Job ${ref.job}; แนะนำ Job ${ref.recommendedJob}; ต้องตรวจเงื่อนไข NPC` : null;
  const b = me.baseLevel || 0;
  const j = me.jobLevel || 0;
  switch (job.tier) {
    case 0: return j >= 10 ? `${job.name} job ${j} → เปลี่ยนเป็นอาชีพ 1 ได้` : null;
    case 1: return j >= 40 ? `${job.name} job ${j} → เปลี่ยนเป็นอาชีพ 2 ได้ (รอ job 50 จะได้ skill point ครบ)` : null;
    case 2:
    case 2.5: return b >= 99 && j >= 50 ? `${job.name} base ${b} job ${j} → เปลี่ยนเป็นอาชีพ 3 ได้` : null;
    case 3: return b >= 200 && j >= 70 ? `${job.name} base ${b} job ${j} → เปลี่ยนเป็นอาชีพ 4 ได้` : null;
    default: return null;
  }
}

/**
 * The next job on the configured path (CLASS_PATH), or null at the end / off the path.
 * Novice counts as the step before the first entry.
 */
export function nextJob(me, path = config.classPath) {
  const name = jobInfo(me.jobId).name;
  if (name === 'Novice') return path[0] || null;
  const i = path.indexOf(name);
  return i === -1 ? null : path[i + 1] || null;
}

// ---- Signals --------------------------------------------------------------------

// Potion stock in full HP bars it can refill (potions.js stockHp), same rule as errand.js.
const LOW_REFILLS = 4;

/** Zeny to keep back for potions and travel; grows with level. */
export const zenyReserve = (baseLevel) => Math.max(2000, (baseLevel || 1) * 500);

/**
 * What the code can see that needs a goal, strongest first. Each signal names
 * the goal it argues for; the planner weighs them, and they're also what makes
 * the agent ask the planner again when something new comes up.
 */
export function detectSignals(snap, { recentDeaths = 0 } = {}) {
  const me = snap.me;
  const inv = snap.inventory || [];
  const out = [];
  const weightPct = me.maxWeight ? Math.round((me.weight / me.maxWeight) * 100) : 0;
  const stock = Math.round(stockHp(inv, me));
  const lowStock = stock < (me.maxHp || 0) * LOW_REFILLS;
  const reserve = zenyReserve(me.baseLevel);

  if (recentDeaths >= 2) out.push({ key: 'deaths', goal: 'rest', text: `ตาย ${recentDeaths} ครั้งใน 30 นาที` });
  if (weightPct >= 80) out.push({ key: 'weight', goal: 'sell', text: `น้ำหนัก ${weightPct}%` });
  // Right after a map change the bag is still reloading: don't report potions from it.
  if (lowStock && (snap.mapAgeMs ?? Infinity) >= 15000) {
    out.push(me.zeny >= reserve
      ? { key: 'potions', goal: 'buy', text: `ยาฟื้นได้รวม ${stock} HP (< ${LOW_REFILLS} หลอด) มีเงิน ${me.zeny}` }
      : { key: 'potions_broke', goal: 'money', text: `ยาฟื้นได้รวม ${stock} HP และเงิน ${me.zeny} ต่ำกว่าสำรอง ${reserve}` });
  }
  if (me.zeny !== undefined && me.zeny < reserve && !out.some((s) => s.goal === 'money')) {
    out.push({ key: 'zeny', goal: 'money', text: `zeny ${me.zeny} ต่ำกว่าเงินสำรอง ${reserve}` });
  }
  const ready = jobChangeReady(me);
  const next = nextJob(me);
  if (ready && next) out.push({ key: 'job', goal: 'job_change', text: `${ready} → ตามสายไป ${next}` });
  if (me.skillPoints > 0) out.push({ key: 'skill', goal: 'build', text: `skill point เหลือ ${me.skillPoints}` });
  return out;
}
