# Item review

- F9 is reserved for learned Item Appraisal (MC_IDENTIFY / skill 40), or an already-carried Magnifier (611). The bot waits for the server identify list, submits only an offered inventory index, and waits for identified inventory data. No appraisal result means no speculative sale.
- LAYA compares identified equipment with the currently worn slots using class, level, build, description, bonuses, refine, cards and slots. Its choices are equip upgrade, sell inferior/unusable, store for future use, or defer when uncertain. Decisions are invalidated when equipment/class/level changes.
- LAYA also decides whether individual cards, materials and other unused items should be kept, sold or stored, with the current bag and worn equipment in context. Active healing supplies, wings and Magnifiers are handled separately. Kafra accepts only an explicit store decision for that item; item type alone never starts a deposit.
- Existing protected-item and equipped-item sale restrictions remain. Unknown equipment is never sold or stored without identification and review. F9 requires learned Item Appraisal with enough SP or a carried Magnifier; otherwise the item is left in the bag. Storage does not automatically swap bank equipment.

The identify packet and F9 shortcut were checked against the [server client](https://morroc101.duckdns.org/play/Online.js): F9 executes shortcut slot 8; ITEMIDENTIFY_LIST supplies inventory indices; REQ_ITEMIDENTIFY submits one index; ACK_ITEMIDENTIFY result 0 confirms success.
