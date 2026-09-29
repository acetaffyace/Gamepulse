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
      res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' }[path.extname(filename)] || 'text/plain');
      res.end(fs.readFileSync(filename));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const base = `http://127.0.0.1:${server.address().port}/dashboard/index.html`;
    await page.goto(base + '?page=versions', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => subjects.length === 2 && subjects.every(s => s.snap));
    assert.equal(await page.evaluate(() => !versionedBatch || (config.build_id === snapshotBuildId && subjects.every(s => s.snap.build_id === snapshotBuildId))), true, 'manifest, config and snapshots must share a batch');
    assert.equal(await page.locator('.compare-metric').count(), 4);
    assert.equal(await page.evaluate(() => align), 'day0');

    for (const days of [3, 7, 14]) {
      await page.click(`#rangeSeg [data-days="${days}"]`);
      // Compare with the raw review history, independently from the windowStats helper.
      const expected = await page.evaluate(days => subjects.map(s => {
        const end = new Date(Date.parse(s.day0 + 'T00:00:00Z') + (days - 1) * 86400000).toISOString().slice(0, 10);
        return s.snap.review_history.filter(r => r.date_local >= s.day0 && r.date_local <= end).reduce((sum, r) => sum + r.new_reviews, 0).toLocaleString('zh-CN');
      }), days);
      assert.deepEqual(await page.locator('.compare-metric').first().locator('strong').allTextContents(), expected);
      assert.equal(await page.evaluate(() => echarts.getInstanceByDom(document.getElementById('compareChart')).getOption().xAxis[0].data.length), days);
    }
    const before = await page.evaluate(() => subjects.map(s => s.key));
    await page.click('#compareSwap');
    await page.waitForFunction(first => subjects[0].key === first, before[1]);
    assert.deepEqual(await page.evaluate(() => subjects.map(s => s.key)), before.slice().reverse());
    await page.click('[data-compare-metric="review_rate"]');
    assert.equal(await page.evaluate(() => echarts.getInstanceByDom(document.getElementById('compareChart')).getOption().series.length), 2);
    const comparisonExport = page.waitForEvent('download');
    await page.click('#compareChartPng');
    assert.equal(fs.readFileSync(await (await comparisonExport).path()).subarray(1, 4).toString(), 'PNG');
    await page.click('#studioFullTimeline>summary');
    assert.equal(await page.locator('#timelineCard').isVisible(), true);

    await page.click('[data-game="wuthering_waves"]');
    await page.waitForFunction(() => subjects.length === 1 && subjects[0].kind === 'game' && subjects[0].snap);
    await page.click('#rangeSeg [data-days="90"]');
    await page.click('.studio-nav [data-page-nav="videos"]');
    await page.waitForSelector('.studio-video-ranking');
    assert.equal(await page.locator('.video-facet').count(), 5);
    const ranked = await page.evaluate(() => {
      const c = echarts.getInstanceByDom(document.querySelector('.video-chart'));
      return c.getOption().series[0].data.map(d => ({ value: d.value, observed: d.point.value, pair: d.pair }));
    });
    assert.ok(ranked.length > 1);
    assert.ok(ranked.every((r, i) => r.value === r.observed && (!i || r.value <= ranked[i - 1].value)));
    // Click a real rendered bar and verify cross-source content focus.
    const coords = await page.evaluate(() => {
      const el = document.querySelector('.video-chart');
      const c = echarts.getInstanceByDom(el);
      const d = c.getOption().series[0].data[0];
      const p = c.convertToPixel({ seriesIndex: 0 }, [d.value / 2, 0]);
      const box = el.getBoundingClientRect(); return { x: box.left + p[0], y: box.top + p[1] };
    });
    await page.mouse.click(coords.x, coords.y);
    await page.waitForFunction(pair => videoViews[0].focusPair === pair, ranked[0].pair);
    assert.equal(await page.locator('.video-selected strong').count(), 5);
    const csvExport = page.waitForEvent('download');
    await page.click('[data-export-video]');
    const csv = fs.readFileSync(await (await csvExport).path(), 'utf8');
    assert.match(csv, /snapshot/);assert.match(csv, /sampled/);assert.match(csv, /age_days/);
    const videoExport = page.waitForEvent('download');await page.click('[data-export-video-png]');
    assert.equal(fs.readFileSync(await (await videoExport).path()).subarray(1, 4).toString(), 'PNG');
    await page.click('[data-clear-pair]');
    await page.click('[data-video-presentation="timeline"]');
    assert.equal(await page.evaluate(() => echarts.getInstanceByDom(document.querySelector('.video-chart')).getOption().series[0].type), 'scatter');
    await page.click('[data-video-presentation="rank"]');
    await page.click('[data-layout="overlay"]');
    assert.equal(await page.locator('.video-facet').count(), 1);
    await page.selectOption('[data-video-control="metric"]', 'engagement');
    assert.equal(await page.locator('.video-facet').count(), 5);
    assert.equal(await page.locator('[data-layout="overlay"]').isDisabled(), true);
    await page.selectOption('[data-video-control="mode"]', 'age');
    assert.equal(await page.locator('.video-empty').count(), 5);
    assert.equal(await page.locator('[data-video-presentation]').count(), 0);
    await page.selectOption('[data-video-control="metric"]', 'view');
    await page.selectOption('[data-video-control="mode"]', 'snapshot');
    await page.click('[data-video-presentation="timeline"]');
    await page.click('#demoShare');
    const link = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(link, /page=videos/);assert.match(link, /videoDisplay=timeline/);
    const restored = await context.newPage();await restored.goto(link, { waitUntil: 'networkidle' });
    assert.equal(await restored.locator('[data-video-presentation="timeline"]').getAttribute('aria-pressed'), 'true');
    await restored.close();
    await page.click('[data-video-presentation="rank"]');
    for (const section of ['versions', 'videos', 'overview']) {
      await page.click(`.studio-nav [data-page-nav="${section}"]`);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, `${section} must fit a phone`);
      await page.screenshot({ path: path.join(os.tmpdir(), `gamepulse-studio-${section}-mobile.png`), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1050 });
    }
    assert.equal(await page.evaluate(() => localStorage.getItem('gamepulse.view.v3')), null, 'workspace keeps classic-view preferences separate');
    await page.click('.studio-nav [data-page-nav="sources"]');
    if (await page.evaluate(() => Boolean(subjects[0].snap.source_health))) {
      assert.equal(await page.locator('#studioHealthPanel').isVisible(), true);
      await page.clock.setFixedTime(new Date('2027-01-01T12:00:00Z'));
      await page.evaluate(() => renderAll());
      assert.equal(await page.locator('#studioSnapshot').getAttribute('data-health'), 'degraded');
    }
    const invalid = await context.newPage();
    await invalid.route('**/data/index.json?*', async route => {
      const response = await route.fetch();const body = await response.json();
      body.config_file='missing-batch/dashboard_config.json';
      await route.fulfill({ json: body });
    });
    await invalid.goto(base, { waitUntil: 'networkidle' });
    assert.match(await invalid.locator('#loading').innerText(), /无法加载/);
    assert.equal(await invalid.locator('#retryLoad').isVisible(), true);
    await invalid.close();
    assert.deepEqual(errors, []);
    console.log('Studio checks passed: raw-data comparison, 3/7/14-day windows, swap, metric switch, ranking, cross-source bar clicks, timeline, missing-data states, platform formulas, CSV/PNG, share restoration, mobile.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
