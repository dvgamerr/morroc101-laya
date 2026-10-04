import { test, expect } from 'bun:test';
process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';
const { parseLocations } = await import('../src/scout.js');

test('reads coordinates from common reply shapes', () => {
  expect(parseLocations(['Poring located at (120, 88)', 'Poring: 33,41'], 'prt_fild08')).toEqual([{ x: 120, y: 88 }, { x: 33, y: 41 }]);
  expect(parseLocations(['prt_fild08 150 200'], 'prt_fild08')).toEqual([]); // no separator, could be anything
  expect(parseLocations(['prt_fild08.gat (150, 200)'], 'prt_fild08')).toEqual([{ x: 150, y: 200 }]);
});

test('skips lines about other maps', () => {
  expect(parseLocations(['moc_fild07 (10, 20)', 'prt_fild08 (30, 40)'], 'prt_fild08')).toEqual([{ x: 30, y: 40 }]);
});

test('ignores error replies', () => {
  expect(parseLocations(['Character not found.', 'Invalid monster ID or name.'], 'prt_fild08')).toEqual([]);
});

test('commands found useless before are never typed again (they go out as public chat)', async () => {
  const { createScout } = await import('../src/scout.js');
  const sc = createScout({}, { dropped: ['@where', '@mobsearch'] });
  expect(await sc.locate({ me: { map: 'x', x: 1, y: 1 } }, ['Poring'])).toEqual([]);
});

test('one query per call; a command that never replies is dropped after repeated misses', async () => {
  const { setSystemTime } = require('bun:test');
  const { createScout } = await import('../src/scout.js');
  const dropped = [];
  const sc = createScout({}, { onDrop: (c) => dropped.push(c) });
  const t0 = Date.now();
  for (let i = 0; i < 12; i++) {
    setSystemTime(t0 + i * 20000);
    await sc.locate({ me: { map: 'x', x: 1, y: 1 } }, ['Poring']);
  }
  setSystemTime();
  // the fake page never answers (no reply at all): that is what gets a command dropped, after 3 misses each
  expect(dropped).toEqual(['@where', '@mobsearch']);
});
