// Consumable ids the combat code (reflex, hotkeys) agrees on. Renewal/pre-renewal items.
export const HP_ITEMS = [569, 501, 507, 502, 508, 503, 545, 504, 546, 547, 509, 512, 513, 515, 516];
export const SP_ITEMS = [505, 510, 518, 526, 11502, 11503];
// Novice Fly Wing first, then existing Fly Wings (601). Only Novice Fly Wing may be bought.
// Use carried wings to find monsters. No Butterfly Wing to go to town: @go does that. Novice Butterfly Wing
// stays as a last-resort escape.
export const FLY_WING = [23280, 12323, 601];
export const BUTTERFLY_WING = [12324];
