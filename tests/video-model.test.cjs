const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../dashboard/video-model.js');
const record = (points, overrides = {}) => ({ gameId: 'g', source: 'bilibili', platform: 'bilibili',
  video: { bvid: 'BV1', pubdate: '2026-01-01', points }, ...overrides });
const point = (date, view, extra = {}) => ({ date_local: date, stats: { view, ...extra } });
const view = { metric: 'view', mode: 'snapshot', compareDays: 3 };
test('latest usable metric ignores failed recent collections and retains a real zero', () => {
  const r = record([point('2026-01-01', 0), point('2026-01-02', null)]);
  assert.equal(M.series(r, view).points[0].value, 0);
  assert.equal(M.series(r, view).points[0].date, '2026-01-01');
});
test('publication age uses dates across a month boundary', () => {
  const r = record([point('2026-02-01', 20)]);
  assert.equal(M.series(r, view).points[0].age, 31);
});
test('same-age comparison requires all requested day samples, not only endpoints', () => {
  const r = record([point('2026-01-01', 10), point('2026-01-03', 30)]);
  assert.deepEqual(M.series(r, { ...view, mode: 'age' }).points, []);
  r.video.points.splice(1, 0, point('2026-01-02', 0));
  assert.deepEqual(M.series(r, { ...view, mode: 'age' }).points.map(p => p.value), [10, 0, 30]);
});
test('late-registered videos never fabricate a launch curve', () => {
  const r = record([point('2026-01-07', 100), point('2026-01-08', 150)]);
  assert.equal(M.series(r, { ...view, mode: 'age', compareDays: 7 }).points.length, 0);
});
test('tracking starts at first valid capture, preserves gaps and downward corrections', () => {
  const r = record([point('2026-01-07', 100), point('2026-01-09', 90)]);
  const result = M.series(r, { ...view, mode: 'tracking' });
  assert.deepEqual(result.points.map(p => p.value), [0, null, -10]);
  assert.equal(result.baseline.age, 6);
  assert.equal(result.points[2].date, '2026-01-09');
});
test('hidden counters stay null; unsupported counters do not become zero', () => {
  assert.equal(M.metric(point('2026-01-01', 10, { like: null }), 'like_rate', 'youtube'), null);
  assert.equal(M.metric(point('2026-01-01', 10, { like: 0 }), 'like_rate', 'youtube'), 0);
  assert.equal(M.metric(point('2026-01-01', 0, { like: 0 }), 'like_rate', 'youtube'), null);
  assert.equal(M.metric(point('2026-01-01', 10, { coin: 7 }), 'coin', 'youtube'), null);
});
test('platform formulas are derived from documented counters, not legacy engagement fields', () => {
  const p = point('2026-01-01', 100, { like: 4, coin: 2, favorite: 1, comment: 3, reply: 5 });
  assert.ok(Math.abs(M.metric(p, 'engagement', 'bilibili') - 7) < 1e-10);
  assert.ok(Math.abs(M.metric(p, 'engagement', 'youtube') - 7) < 1e-10);
  assert.equal(M.metric(p, 'comment', 'bilibili'), 5);
});
test('daily deltas never put a multi-day increase in a single day', () => {
  const r = record([point('2026-01-01', 10), point('2026-01-03', 30), point('2026-01-04', 27)]);
  const result = M.series(r, { ...view, mode: 'daily' });
  assert.deepEqual(result.points.map(p => p.value), [null, null, -3]);
  r.observationStart = '2026-01-04';
  assert.equal(M.series(r, { ...view, mode: 'daily' }).points.length, 1);
});
test('relative scale carries the raw value and reference into the export', () => {
  const r = record([point('2026-01-01', 200)], { referenceMedian: 100 });
  const config = { ...view, scale: 'index' };
  const prepared = M.prepare([r], config);
  assert.equal(prepared[0].points[0].value, 2);
  const row = M.exportRows(prepared, config)[0];
  assert.equal(row.value, 2); assert.equal(row.raw_value, 200);
  assert.equal(row.reference_median, 100); assert.equal(row.unit, 'ratio');
});
test('only verified pair IDs link platforms; identical titles are insufficient', () => {
  const a = record([]), b = record([], { source: 'youtube:ja', platform: 'youtube' });
  assert.notEqual(M.pairKey(a), M.pairKey(b));
  a.video.pair_id = b.video.pair_id = 'pair';
  assert.equal(M.pairKey(a), M.pairKey(b));
  b.gameId = 'other'; assert.notEqual(M.pairKey(a), M.pairKey(b));
});
test('export uses the exact comparison mode, focus, values, and missing samples', () => {
  const a = record([point('2026-01-07', 100), point('2026-01-09', 120)]);
  const b = record([point('2026-01-07', 500)], { gameId: 'other' });
  const config = { ...view, mode: 'tracking', focusPair: M.pairKey(a) };
  const rows = M.exportRows(M.prepare([a, b], config), config);
  assert.deepEqual(rows.map(r => r.value), [0, null, 20]);
  assert.equal(rows[0].baseline_date, '2026-01-07');
  assert.equal(rows.length, 3);
});
