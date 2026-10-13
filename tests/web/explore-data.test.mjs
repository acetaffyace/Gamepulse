import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canCombine, completeSum, fillAxis, seriesScore } from '../../web/lib/explore-data.js';

test('weekly axes preserve weekly grain while keeping missing weeks', () => {
  assert.deepEqual(fillAxis('date', ['2026-09-07', '2026-09-21'], 7), ['2026-09-07', '2026-09-14', '2026-09-21']);
  assert.deepEqual(fillAxis('date', ['2026-09-07', '2026-09-09']), ['2026-09-07', '2026-09-08', '2026-09-09']);
  assert.deepEqual(fillAxis('integer', [0, 2]), [0, 1, 2]);
});

test('other groups never convert missing or partially observed data to zero', () => {
  assert.equal(completeSum([null, null]), null);
  assert.equal(completeSum([5, null]), null);
  assert.equal(completeSum([undefined, 4]), null);
  assert.equal(completeSum([0, 0]), 0);
  assert.equal(completeSum([2, 3]), 5);
});

test('a graph cannot undo the metric catalog required grouping', () => {
  const cumulative = { agg: 'SUM(views)', must_group_by: ['locale', 'video_id'], must_group_by_one_of: [['date'], ['days_since_pub']] };
  assert.equal(canCombine(cumulative, 'video_id'), false);
  assert.equal(canCombine(cumulative, 'locale'), false);
  assert.equal(canCombine({ agg: 'SUM(reviews)' }, 'language'), true);
  assert.equal(canCombine({ agg: 'SUM(value)', must_group_by_one_of: [['date']] }, 'date'), false);
  assert.equal(canCombine({ agg: 'COUNT(*)', kind: 'share' }, 'language'), true);
  assert.equal(canCombine({ agg: '100.0 * SUM(positive) / SUM(reviews)' }, 'game_id'), false);
});

test('snapshot rankings use the latest observed value instead of accumulated dates', () => {
  const cumulative = { agg: 'SUM(views)', must_group_by_one_of: [['date']] };
  assert.equal(seriesScore(cumulative, [200, 200, null]), 200);
  assert.equal(seriesScore(cumulative, [300]), 300);
  assert.equal(seriesScore({ agg: 'SUM(reviews)' }, [2, 3]), 5);
});
