import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions } from '../../web/lib/format.js';

test('date-labelled patches sort chronologically alongside the existing numeric format', () => {
  assert.deepEqual(['2026-09-17', '2026-07-30', '2026-09-03'].sort(compareVersions),
    ['2026-07-30', '2026-09-03', '2026-09-17']);
  assert.deepEqual(['3.10', '3.2', '3.1'].sort(compareVersions), ['3.1', '3.2', '3.10']);
});
