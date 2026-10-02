/**
 * Skill id -> aegis name, for the skills the agent reasons about by name (the
 * owner's Merchant -> Blacksmith -> Whitesmith -> Mechanic path, plus common
 * buffs). Newer clients send no names in the skill list, and the client keeps its
 * own SkillInfo table private; it only exposes display names (DB.getSkillName),
 * which page-agent passes along as `label`.
 *
 * Ids are rAthena's (db/re/skill_db.yml). Anything missing still works by its
 * display label — the LLM knows skills by either name.
 */
export const AEGIS = {
  1: 'NV_BASIC', 142: 'NV_FIRSTAID', 143: 'NV_TRICKDEAD',
  // Merchant
  36: 'MC_INCCARRY', 37: 'MC_DISCOUNT', 38: 'MC_OVERCHARGE', 39: 'MC_PUSHCART', 40: 'MC_IDENTIFY',
  41: 'MC_VENDING', 42: 'MC_MAMMONITE', 153: 'MC_CARTREVOLUTION', 154: 'MC_CHANGECART', 155: 'MC_LOUD',
  // Blacksmith
  94: 'BS_IRON', 95: 'BS_STEEL', 96: 'BS_ENCHANTEDSTONE', 97: 'BS_ORIDEOCON', 98: 'BS_DAGGER', 99: 'BS_SWORD',
  100: 'BS_TWOHANDSWORD', 101: 'BS_AXE', 102: 'BS_MACE', 103: 'BS_KNUCKLE', 104: 'BS_SPEAR', 105: 'BS_HILTBINDING',
  106: 'BS_FINDINGORE', 107: 'BS_WEAPONRESEARCH', 108: 'BS_REPAIRWEAPON', 109: 'BS_SKINTEMPER', 110: 'BS_HAMMERFALL',
  111: 'BS_ADRENALINE', 112: 'BS_WEAPONPERFECT', 113: 'BS_OVERTHRUST', 114: 'BS_MAXIMIZE', 1013: 'BS_GREED',
  // Whitesmith
  384: 'WS_MELTDOWN', 385: 'WS_CREATECOIN', 386: 'WS_CREATENUGGET', 387: 'WS_CARTBOOST', 388: 'WS_SYSTEMCREATE',
  477: 'WS_WEAPONREFINE', 485: 'WS_CARTTERMINATION', 486: 'WS_OVERTHRUSTMAX',
  // Mechanic
  2255: 'NC_MADOLICENCE', 2256: 'NC_BOOSTKNUCKLE', 2257: 'NC_PILEBUNKER', 2258: 'NC_VULCANARM', 2259: 'NC_FLAMELAUNCHER',
  2260: 'NC_COLDSLOWER', 2261: 'NC_ARMSCANNON', 2262: 'NC_ACCELERATION', 2263: 'NC_HOVERING', 2264: 'NC_F_SIDESLIDE',
  2265: 'NC_B_SIDESLIDE', 2266: 'NC_MAINFRAME', 2267: 'NC_SELFDESTRUCTION', 2268: 'NC_SHAPESHIFT', 2269: 'NC_EMERGENCYCOOL',
  2270: 'NC_INFRAREDSCAN', 2271: 'NC_ANALYZE', 2272: 'NC_MAGNETICFIELD', 2273: 'NC_NEUTRALBARRIER', 2274: 'NC_STEALTHFIELD',
  2275: 'NC_REPAIR', 2276: 'NC_TRAININGAXE', 2277: 'NC_RESEARCHFE', 2278: 'NC_AXEBOOMERANG', 2279: 'NC_POWERSWING',
  2280: 'NC_AXETORNADO', 2281: 'NC_SILVERSNIPER', 2282: 'NC_MAGICDECOY', 2283: 'NC_DISJOINT',
  // Common buffs from other classes (party/scrolls)
  29: 'AL_INCAGI', 34: 'AL_BLESSING', 33: 'AL_ANGELUS',
};

/** Give every skill a usable name: what the server sent, else the aegis name by id, else the display label. */
export function withNames(list) {
  return (list || []).map((s) => ({ ...s, name: s.name || AEGIS[s.id] || s.label || `#${s.id}` }));
}
