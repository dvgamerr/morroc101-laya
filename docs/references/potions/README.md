# Potion loadout

At the shop, LAYA chooses from enumerated loadouts: one HP type plus one SP type, or one dual-purpose item alone. Candidates include recognized carried items and the shop's actual list, with healing, stock, price, weight, measured use and incoming damage. An invalid answer does not invent a choice; a previous LAYA selection may be reused.

When only one resource has any available items, LAYA can select that resource alone. Unselected healing items are retained until replacements for every resource they restore are present. The choice must match an enumerated option; a fixed confidence threshold is not used for this many-option decision.

Buy the selected types, confirm success and inventory presence, sell unselected healing items, then refill the same selection once with the freed weight. Purchases stay within 45% weight. Protected items are not sold. The selection is saved in logs/potion-selection.json and also drives the money target. Wings have a separate quantity policy.

Known dual-purpose items currently include Honey (518) and Royal Jelly (526), using [rAthena healing data](https://github.com/rathena/rathena/blob/master/db/pre-re/item_db_usable.yml). They are recognized by both HP and SP use and hotkeys. Unknown healing effects are not guessed by LAYA.
