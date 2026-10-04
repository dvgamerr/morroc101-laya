import { readFileSync, writeFileSync } from 'node:fs';
const FILE = 'logs/drop-sell-prices.json';
// Loaded on first use, and never from the real logs/ directory under test.
let prices = null;
function load() {
  if (prices) return prices;
  prices = {};
  if (process.env.NODE_ENV !== 'test') {
    try { prices = JSON.parse(readFileSync(FILE, 'utf8')); } catch {}
  }
  return prices;
}
export function observeSellPrices(snap) {
  if (snap.shop?.stage !== 'sell') return;
  const prices = load();
  let changed = false;
  for (const row of snap.shop.list || []) {
    const item = snap.inventory.find(i => i.index === row.index);
    if (!item || !Number.isFinite(row.price) || row.price < 0) continue;
    if (prices[item.ITID]?.price === row.price) continue;
    prices[item.ITID] = { name: item.name, price: row.price }; changed = true;
  }
  if (changed && process.env.NODE_ENV !== 'test') {
    try { writeFileSync(FILE, JSON.stringify(prices, null, 2)); } catch {}
  }
}
export function dropValue(drops = []) {
  const prices = load();
  const items = drops.map(([id, rate]) => ({ id, rate, name: prices[id]?.name, sellPrice: prices[id]?.price ?? null }));
  return { items, knownZenyPerKill: items.reduce((sum,d) => sum + (d.sellPrice ?? 0) * d.rate / 10000, 0),
    unknownPrices: items.filter(d => d.sellPrice === null).length };
}
