// Shared item ids and supply numbers for the errand side (were repeated across errand, item-review, sell-junk, potion-loadout).

export const NOVICE_FLY_WING = 23280;
/** Every wing we carry for warping around the hunting map (Novice Fly Wing, the other Fly Wing variant, Fly Wing). */
export const WING_IDS = [NOVICE_FLY_WING, 12323, 601];
/** Wings, Magnifier and the other consumables that are never sold or reviewed away. */
export const SUPPLY_IDS = [601, 602, 611, 23280, 12323, 12324];

// Refining ores and the upgrade ratio (5 lower ore -> 1 higher).
export const ORE_IDS = { roughOridecon: 756, roughElunium: 757, oridecon: 984, elunium: 985, enrichedOridecon: 7619, enrichedElunium: 7620 };
export const ORE_RATIO = 5;

// Supply sizing shared by the errand and the potion loadout.
export const POCKET_MONEY = 1000; // never spend the last of it
export const LOW_REFILLS = 4; // full HP bars of potions: go shopping below this
export const TARGET_REFILLS = 15; // buy up to this
export const SP_STOCK_REFILLS = 8;
export const SP_LOW_REFILLS = 2;
export const EMERGENCY_HP_REFILLS = 4;
export const EMERGENCY_SP_REFILLS = 2;
export const SPEND_SHARE = 0.6; // of zeny on one trip
export const EMERGENCY_SPEND_SHARE = 0.25;
export const WEIGHT_SHARE = 0.45; // of max weight a normal loadout purchase may fill
export const EMERGENCY_WEIGHT_SHARE = 0.7; // an emergency may use more room: a short bag is worse than a heavy one
export const HP_TRIP_MINUTES = 20; // minutes of HP use a normal trip covers
export const SP_TRIP_MINUTES = 30;
