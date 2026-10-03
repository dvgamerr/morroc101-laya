import { test, expect } from 'bun:test';
import { observeFarmTrip, finishFarmTrip } from '../src/farm-profit.js';

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
