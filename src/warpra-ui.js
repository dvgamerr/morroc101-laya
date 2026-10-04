import { closePanel } from './close-panel.js';
// Warpra board protocol and selectors verified against the server's Online.js.
// Read advertised state; only the actual button handler may submit a warp.
export function parseWarpraFeed(lines) {
  for (const line of [...(lines || [])].reverse()) {
    const match = /<WARPRA>([\s\S]*?)<\/WARPRA>/.exec(line);
    if (!match) continue;
    const parts = match[1].split('|');
    if (parts.length !== 4 || parts[0] !== '1') continue;
    const groups = parts[2].split('~');
    const places = [];
    let valid = true;
    for (const row of parts[3].split(';').filter(Boolean)) {
      const f = row.split('*');
      const [code, group, price, users, lock] = [f[0], f[1], f[4], f[5], f[6]].map(Number);
      if (f.length !== 8 || ![code, group, price, users, lock].every(Number.isInteger) || code <= 1 || group < 0 || group >= groups.length || price < 0 || users < 0 || lock < 0 || lock > 3 || !f[2] || !/^[a-z0-9_]+$/i.test(f[3])) { valid = false; break; }
      places.push({code, group, name:f[2], map:f[3], price, lock, unlock:f[7]});
    }
    if (valid && places.length) return {groups, places};
  }
  return null;
}
// GUIComponent gives both the shadow host and inner panel the same ID.
// Only the real panel owns the toolbar directly; ignore hidden old panels.
const BOARD = '#Warpra:has(> .toolbar):visible';
const opts = {timeout:1500};
export async function closeWarpra(page) {
  await closePanel(page.locator(BOARD), page.locator(BOARD + ' .leave'), 1500);
}
export async function inspectWarpra(page, destination) {
  if (!await page.locator(BOARD).isVisible()) return null;
  const lines = await page.evaluate(() => window.__agent?.dialog?.lines || []);
  const feed = parseWarpraFeed(lines);
  if (!feed) return {state:'unreadable'};
  const place = feed.places.find(p => p.map === destination);
  if (!place) return {state:'absent', feed};
  await page.locator(BOARD + ' .search').fill('', opts);
  await page.locator(BOARD + ' .tabs [data-tab="'+(place.group === 0 ? 'town' : 'dun')+'"]').click(opts);
  const card = page.locator(BOARD + ' .card[data-group="'+place.group+'"]');
  const groupLocked = place.group > 0 && feed.places.some(p => p.group === place.group && p.lock === 1) && !feed.places.some(p => p.group === place.group && p.lock === 0);
  if (place.lock === 1 || groupLocked) {
    const lead = place.group ? card.locator('.unlock:not(.entry) .lead') : null;
    const entry = place.group ? card.locator('.unlock.entry .lead') : null;
    const readSpot = async locator => locator && await locator.count() ? locator.evaluate(e=>({map:e.dataset.map,x:+e.dataset.x,y:+e.dataset.y,name:e.dataset.name})) : null;
    const spot = await readSpot(lead);
    const entrySpot = await readSpot(entry);
    if (spot) await lead.click(opts);
    return {state:'locked', place, spot, entry:entrySpot, feed};
  }
  if (place.lock !== 0) return {state:'unavailable', place, feed};
  if (place.group && await card.locator('[data-open]').count()) await card.locator('[data-open]').click(opts);
  const selector = BOARD + ' .grid '+(place.group ? '.floor' : '.town')+'[data-code="'+place.code+'"]';
  if (!await page.locator(selector).count() || !await page.locator(selector).isEnabled()) return {state:'unavailable',place,feed};
  return {state:'open',place,selector,feed};
}
export async function clickWarpraDestination(page, choice) {
  // Re-read the feed immediately before clicking in case the server refreshed it.
  const current = parseWarpraFeed(await page.evaluate(()=>window.__agent?.dialog?.lines || []));
  const p = current?.places.find(p=>p.code===choice.place.code && p.map===choice.place.map);
  if (!p || p.lock !== 0) return false;
  await page.locator(choice.selector).click(opts);
  return true;
}
