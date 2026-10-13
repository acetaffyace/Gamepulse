import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commonWindow, subjectKey, versionIntervals } from '../../web/lib/version-analysis.js';

test('cross-game objects retain game identity and share the shortest complete stage', () => {
  const versions = [
    { game_id: 'a', version_id: '1.0', start_date: '2026-08-01', days: 31 },
    { game_id: 'b', version_id: '1.0', start_date: '2026-09-01', days: 30 },
  ];
  assert.notEqual(subjectKey(versions[0]), subjectKey(versions[1]));
  const anchors = { a: '2026-09-28', b: '2026-09-09' };
  assert.deepEqual(commonWindow(versions, anchors, '14'), { common: 9, days: 9 });
  assert.deepEqual(commonWindow(versions, anchors, 'all'), { common: 9, days: 9 });
  assert.deepEqual(commonWindow(versions, anchors, '7'), { common: 9, days: 7 });
  assert.equal(commonWindow(versions, { a: '2026-09-28' }, 'all').days, 0);
});

test('cadence uses chronological release dates, not version numbering or today', () => {
  assert.deepEqual(versionIntervals([
    { version_id: '3.0', start_date: '2026-07-24' }, { version_id: '2.8', start_date: '2026-06-12' },
  ]).map(v => [v.version_id, v.previous, v.interval]), [['2.8', null, null], ['3.0', '2.8', 42]]);
});
