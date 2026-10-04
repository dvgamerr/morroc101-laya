import { test, expect } from 'bun:test';
import { observeFarmTrip, finishFarmTrip, abortFarmTravel, settleFarmErrand } from '../src/farm-profit.js';

test('town detour and no-op shopping do not assess unsold loot as zero profit', () => {
  let trip = observeFarmTrip(null, { map: 'field', zeny: 10000 }, false, 'field', 1000);
  trip = observeFarmTrip(trip, { map: 'town', zeny: 10000 }, true, 'field', 5000);
  expect(finishFarmTrip(trip, 10000, 6000, null, true)).toBeNull();
  trip = settleFarmErrand(trip, { ok: true, sold: 0, bought: [] });
  expect(finishFarmTrip(trip, 10000, 7000, null, true)).toBeNull();
  trip = observeFarmTrip(trip, { map: 'field', zeny: 10000 }, false, 'field', 7100);
  expect(trip.returned).toBe(false);
  expect(trip.startZeny).toBe(10000);
  trip = observeFarmTrip(trip, { map: 'town', zeny: 12000 }, true, 'field', 7500);
  trip = settleFarmErrand(trip, { ok: true, sold: 10, bought: [] });
  expect(finishFarmTrip(trip, 12000, 8000, null, true).net).toBe(2000);
});

test('compares money before travel with cash after selling and restocking', () => {
  let trip = observeFarmTrip(null, { map: 'town', zeny: 10000 }, true, 'field');
  trip = observeFarmTrip(trip, { map: 'field', zeny: 9500 }, false, 'field');
  trip = observeFarmTrip(trip, { map: 'town', zeny: 9500 }, true, 'field');
  trip = observeFarmTrip(trip, { map: 'town', zeny: 13000 }, true, 'field');
  expect(finishFarmTrip(trip, 9000).net).toBe(-1000);
  expect(finishFarmTrip(trip, 10000).net).toBe(0);
  expect(finishFarmTrip(trip, 12000).net).toBe(2000);
});

test('does not judge an unfinished hunt or a town-only shop visit', () => {
  let trip = observeFarmTrip(null, { map: 'town', zeny: 10000 }, true, 'field');
  expect(finishFarmTrip(trip, 9000)).toBeNull();
  trip = observeFarmTrip(trip, { map: 'field', zeny: 9500 }, false, 'field');
  expect(finishFarmTrip(trip, 9500)).toBeNull();
});

test('survives serialization and remembers all hunted maps in a losing trip', () => {
  let trip = observeFarmTrip(null, { map: 'field', zeny: 10000 }, false, 'field');
  trip = JSON.parse(JSON.stringify(trip));
  trip = observeFarmTrip(trip, { map: 'other', zeny: 9500 }, false, 'other');
  trip = observeFarmTrip(trip, { map: 'town', zeny: 9500 }, true, 'other');
  expect(finishFarmTrip(trip, 9500).maps).toEqual(['field', 'other']);
});

test('failed outbound trip includes supply spending without inventing hunted maps', () => {
  let trip = observeFarmTrip(null, { map: 'morocc', zeny: 82990 }, true, 'yuno_fild06', 1000);
  trip = observeFarmTrip(trip, { map: 'yuno_fild04', zeny: 82000 }, false, 'yuno_fild06', 2000);
  trip = abortFarmTravel(trip, 'supplies exhausted before arrival');
  trip = JSON.parse(JSON.stringify(trip));
  trip = observeFarmTrip(trip, { map: 'morocc', zeny: 82000 }, true, 'yuno_fild06', 5000);
  const result = finishFarmTrip(trip, 63707, 8000);
  expect(result.net).toBe(-19283);
  expect(result.observedSpend).toBe(19283);
  expect(result.durationMs).toBe(6000);
  expect(result.maps).toEqual([]);
  expect(result.routeMaps).toEqual(['yuno_fild04']);
  expect(result.huntMap).toBe('yuno_fild06');
  expect(result.routeFailure).toBe('supplies exhausted before arrival');
});

test('passing through a town keeps outbound costs without failing the route', () => {
  let trip = observeFarmTrip(null, { map: 'morocc', zeny: 10000 }, true, 'field', 1000);
  trip = observeFarmTrip(trip, { map: 'transit', zeny: 9500 }, false, 'field', 2000);
  trip = observeFarmTrip(trip, { map: 'yuno', zeny: 9000 }, true, 'field', 3000);
  expect(finishFarmTrip(trip, 9000, 4000)).toBeNull();
  expect(trip.startZeny).toBe(10000);
  trip = observeFarmTrip(trip, { map: 'field', zeny: 9000 }, false, 'field', 5000);
  trip = abortFarmTravel(trip, 'normal restock after hunting');
  trip = observeFarmTrip(trip, { map: 'town', zeny: 11000 }, true, 'field', 6000);
  expect(finishFarmTrip(trip, 11000, 7000).routeFailure).toBeNull();
  expect(finishFarmTrip(trip, 11000, 7000).net).toBe(1000);
});

test('town-only shopping does not mark a route failure', () => {
  const trip = observeFarmTrip(null, { map: 'morocc', zeny: 10000 }, true, 'field', 1000);
  expect(abortFarmTravel(trip, 'shopping')).toBe(trip);
});

test('a no-op or failed review does not blame the hunting destination', () => {
  const trip = { huntMap: 'field', startedAt: 1000, maps: [], startZeny: 10000, returned: true,
    routeFailure: 'กลับเติมเสบียง/ขายของก่อนถึงแมพล่า' };
  const resumed = settleFarmErrand(trip, { ok: false, sold: 0, bought: [] });
  expect(resumed.routeFailure).toBeUndefined();
  expect(resumed.returned).toBe(false);
  expect(resumed.startZeny).toBe(10000);
  expect(finishFarmTrip(resumed, 10000)).toBeNull();
  expect(settleFarmErrand(trip, { sold: 0, bought: ['Potion x1'] })).toBe(trip);
  const escape = { ...trip, routeFailure: 'repeated escapes' };
  expect(settleFarmErrand(escape, { sold: 0, bought: [] })).toBe(escape);
});

test('a sale counts even when the purchase after it failed', () => {
  const trip = { huntMap: 'field', startedAt: 1000, maps: ['field'], startZeny: 10000, returned: true };
  expect(settleFarmErrand(trip, { ok: false, sold: 5, bought: [] }).saleSettled).toBe(true);
});

test('a new hunting map does not inherit an unsold or aborted trip of the old one', () => {
  let trip = observeFarmTrip(null, { map: 'a', zeny: 10000 }, false, 'a', 1000);
  trip = observeFarmTrip(trip, { map: 'town', zeny: 10000 }, true, 'a', 2000);
  trip = observeFarmTrip(trip, { map: 'b', zeny: 10000 }, false, 'b', 3000);
  expect(trip.huntMap).toBe('b');
  expect(trip.returned).toBe(false);
  let aborted = observeFarmTrip(null, { map: 'x', zeny: 10000 }, false, 'a', 1000);
  aborted = abortFarmTravel(aborted, 'unsafe');
  aborted = observeFarmTrip(aborted, { map: 'b', zeny: 10000 }, false, 'b', 2000);
  expect(aborted.routeFailure).toBeUndefined();
  expect(aborted.huntMap).toBe('b');
});

test('leaving a detour town after hunting is not a walking-only return', () => {
  const me = { zeny: 1000, baseLevel: 50, baseExp: 0, baseExpNext: 100 };
  let trip = observeFarmTrip(null, me, false, 'hunt', 1000);
  trip = observeFarmTrip(trip, me, false, 'hunt', 1100);
  trip = observeFarmTrip({ ...trip, maps: ['hunt'], returned: false }, me, true, 'hunt', 1200);
  expect(trip.returned).toBe(true);
  trip = observeFarmTrip(trip, { ...me, map: 'field' }, false, 'hunt', 1300);
  expect(trip.returned).toBe(false);
  expect(trip.detour).toBe(true);
  trip = observeFarmTrip(trip, { ...me, map: 'hunt' }, false, 'hunt', 1400);
  expect(trip.detour).toBe(false);
});
