const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../dashboard/video-model.js');
const cases = require('./fixtures/video-metric-contract.json');

test('frontend metrics satisfy the same fixtures as the Python snapshot builder', () => {
  for (const fixture of cases) {
    const value = model.metric({ stats: fixture.stats }, 'engagement', fixture.platform);
    if (fixture.engagement === null) assert.equal(value, null);
    else assert.ok(Math.abs(value - fixture.engagement) < 1e-8);
  }
});
