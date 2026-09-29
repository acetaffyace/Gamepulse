const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

(async () => {
  const server = http.createServer((req, res) => {
    const filename = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://local').pathname));
    if (!filename.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
      const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
      res.setHeader('Content-Type', mime[path.extname(filename)] || 'text/plain');
      res.end(fs.readFileSync(filename));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // The entire dashboard must render without third-party scripts or network access.
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const base = `http://127.0.0.1:${server.address().port}/dashboard/index.html`;
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('#app:not(.hidden)');
    assert.equal(await page.locator('.video-dashboard').count(), 1);
    assert.equal(await page.locator('.video-facet').count(), 5);
    assert.equal(await page.locator('.video-chart canvas').count(), 5);
    const initialCharts = await page.evaluate(() => videoCharts.length);
    assert.equal(initialCharts, 5);
    await page.screenshot({ path: path.join(os.tmpdir(), 'gamepulse-new-desktop.png'), fullPage: true });

    const pair = await page.locator('[data-video-control="pair"] option').nth(1).getAttribute('value');
    await page.selectOption('[data-video-control="pair"]', pair);
    assert.equal(await page.locator('.video-selected strong').count(), 5);
    await page.locator('.video-dashboard').screenshot({ path: path.join(os.tmpdir(), 'gamepulse-video-facets.png') });
    await page.click('[data-layout="overlay"]');
    assert.equal(await page.locator('.video-facet').count(), 1);
    assert.equal(await page.evaluate(() => videoCharts.length), 1);
    await page.selectOption('[data-video-control="metric"]', 'engagement');
    assert.equal(await page.locator('[data-layout="overlay"]').isDisabled(), true);
    assert.equal(await page.locator('.video-facet').count(), 5);
    await page.selectOption('[data-video-control="metric"]', 'view');
    await page.selectOption('[data-video-control="mode"]', 'tracking');
    assert.equal(await page.evaluate(() => videoViews[0].mode), 'tracking');
    const downloadPromise = page.waitForEvent('download');
    await page.click('[data-export-video]');
    const download = await downloadPromise;
    const csv = fs.readFileSync(await download.path(), 'utf8');
    assert.match(csv, /baseline_date/);
    assert.match(csv, /tracking/);
    assert.match(csv, /snapshot_date/);
    const pngPromise = page.waitForEvent('download');
    await page.click('[data-export-video-png]');
    const png = await pngPromise;
    assert.equal(fs.readFileSync(await png.path()).subarray(1, 4).toString(), 'PNG');
    await page.selectOption('[data-video-control="mode"]', 'age');
    assert.equal(await page.locator('.video-empty').count(), 5);
    assert.match(await page.locator('.video-status-inline').first().innerText(), /0\/\d+ 支完整采样/);
    await page.selectOption('[data-video-control="mode"]', 'snapshot');
    await page.selectOption('[data-video-control="scale"]', 'index');
    assert.equal(await page.evaluate(() => videoViews[0].scale), 'index');
    await page.selectOption('[data-video-control="mode"]', 'daily');
    assert.equal(await page.evaluate(() => videoViews[0].mode), 'daily');
    await page.selectOption('[data-video-control="mode"]', 'snapshot');
    await page.selectOption('[data-video-control="scale"]', 'abs');
    await page.uncheck('[data-source-pick="youtube:ko"]');
    assert.equal(await page.locator('.video-facet').count(), 4);
    await page.check('[data-source-pick="youtube:ko"]');
    assert.equal(await page.locator('.video-facet').count(), 5);

    // Share links restore layout, source selection, mode, metric and paired-content focus.
    const hash = await page.evaluate(() => location.hash);
    const second = await browser.newPage();
    await second.goto(base + hash, { waitUntil: 'networkidle' });
    await second.waitForSelector('#app:not(.hidden)');
    assert.equal(await second.evaluate(() => videoViews[0].focusPair), pair);
    await second.close();

    // A 14-day version comparison uses the same window in the chart, tiles and table.
    await page.goto(base + '#s=wuthering_waves@2026-07-10|wuthering_waves@2026-08-20&a=day0&r=14', { waitUntil: 'networkidle' });
    const stats = await page.evaluate(() => subjects.map(s => windowStats(s)));
    assert.deepEqual(stats.map(s => s.historicalDays), [14, 14]);
    const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'data/snapshot_wuthering_waves.json'), 'utf8'));
    const expectedTotals = [['2026-07-10', '2026-07-23'], ['2026-08-20', '2026-09-02']].map(([start, end]) =>
      snapshot.review_history.filter(r => r.date_local >= start && r.date_local <= end).reduce((n, r) => n + r.new_reviews, 0));
    assert.deepEqual(stats.map(s => s.historicalReviews), expectedTotals);
    assert.equal(await page.evaluate(() => buildCtx().axis.keys.length), 14);
    await page.fill('#customDays', '5'); await page.click('#applyDays');
    assert.equal(await page.evaluate(() => buildCtx().axis.keys.length), 5);
    assert.deepEqual(await page.evaluate(() => subjects.map(s => windowStats(s).historicalDays)), [5, 5]);
    await page.click('#rangeSeg [data-days="7"]');
    assert.equal(await page.evaluate(() => buildCtx().axis.keys.length), 7);
    await page.click('#rangeSeg [data-days="3"]');
    assert.equal(await page.evaluate(() => buildCtx().axis.keys.length), 3);

    for (const preset of ['default', 'compare', 'versions', 'player_profile', 'propagation', 'online_focus', 'yt_locales', 'jp_market']) {
      await page.selectOption('#presetSelect', preset);
      assert.equal(await page.evaluate(() => videoCharts.filter(c => c.isDisposed()).length), 0);
      assert.equal(await page.evaluate(() => (chart.getOption().title || []).some(t => /undefined/.test(t.text))), false);
    }
    await page.selectOption('#presetSelect', 'default');
    await page.goto(base + '#s=wuthering_waves|zenless_zone_zero|neverness_to_everness&a=calendar&r=90', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => subjects.length === 3 && subjects.every(s => s.snap));
    assert.equal(await page.locator('.video-facet').count(), 5);
    assert.equal(await page.evaluate(() => chart.getOption().title.some(t => /undefined/.test(t.text))), false);

    await page.goto(base + '#s=wuthering_waves&a=calendar&r=90', { waitUntil: 'networkidle' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.equal(dimensions.scroll, dimensions.width, 'mobile page must not overflow');
    await page.screenshot({ path: path.join(os.tmpdir(), 'gamepulse-new-mobile.png'), fullPage: true });
    await page.click('#openPanel');
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('#lanePanel')), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'openPanel');
    await page.clock.setFixedTime(new Date('2027-01-01T12:00:00Z'));
    await page.evaluate(() => renderAll());
    assert.equal(await page.locator('#dataStatus').isVisible(), true);
    const broken = await browser.newPage();
    const brokenErrors = [];
    broken.on('pageerror', e => brokenErrors.push(e.message));
    await broken.route('**/vendor/echarts-5.5.0.min.js', route => route.abort());
    await broken.goto(base, { waitUntil: 'networkidle' });
    assert.match(await broken.locator('#loading').innerText(), /图表资源加载失败/);
    assert.equal(await broken.locator('#retryLoad').isVisible(), true);
    assert.deepEqual(brokenErrors, []);
    await broken.close();
    assert.deepEqual(errors, []);
    console.log('Browser checks passed: offline assets, facets, pairing, overlay, formulas, missing samples, exports, sharing, 3/7/14/custom windows, mobile, focus.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
