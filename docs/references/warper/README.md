# Warpa / Warpra travel

Runtime checks the live Warpra board before starting navigation to the final destination. Selectors and the version-1 WARPRA feed are based on https://morroc101.duckdns.org/play/Online.js (checked 2026-10-02).

- Clear search, select the dungeon/town tab, expand floors if needed, and click the advertised destination with Playwright. Verify the resulting map.
- For a locked dungeon, read and click its unlock route. Travel to Dungeon Pass first if advertised, then talk to the specified Warpra Helper. Reopen a Warpra board and require an unlocked server feed. Reaching the hunting map or finishing the conversation alone is insufficient.
- Navigation handles NPC approach and fallback when the destination is absent, unavailable, unaffordable, or a warp fails. An unfinished or failed unlock falls back to the normal walk / @go route; if that route does not exist the trip fails there. Deep floors may require walking after the dungeon group is verified unlocked.
- The hunting loop continues unfinished trips even on the target map and avoids opening other service dialogs during Warpra/Helper conversations.

routes.json retains legacy rAthena estimates for planning only. Live board data overrides those estimates, and known locked destinations are not priced as available warps. Observed Warpa/Warpra/Warper NPC locations are preferred; Helpers are excluded from main service selection.
