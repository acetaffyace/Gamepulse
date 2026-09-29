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
    // Comparison badges state their direction instead of a bare percentage.
    for (const badge of await page.locator('.compare-change').allTextContents()) assert.match(badge, /^B 较 A [+−±]/);

    /* One fixed colour per (game, version): identical on chips, comparison legend, comparison chart,
       players tiles/legend/table, and unchanged when the selected subset changes. */
    const rgb = hex => { const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16 & 255}, ${n >> 8 & 255}, ${n & 255})`; };
    const pairKeys = await page.evaluate(() => subjects.map(s => s.key));
    const expectedColors = await page.evaluate(() => Object.fromEntries(subjects.map(s => [s.key, versionColor(catalog, s.gameId, s.versionKey)])));
    assert.notEqual(expectedColors[pairKeys[0]], expectedColors[pairKeys[1]], 'adjacent versions must be distinguishable');
    const surfaceColors = async () => page.evaluate(() => ({
      chips: [...document.querySelectorAll('#subjectChips .subject-chip')].map(c => [c.dataset.key, getComputedStyle(c.querySelector('.mark')).backgroundColor]),
      legend: [...document.querySelectorAll('#compareLegend i')].map(i => getComputedStyle(i).backgroundColor),
      chart: echarts.getInstanceByDom(document.getElementById('compareChart')).getOption().series.map(s => s.itemStyle.color),
    }));
    const seen = await surfaceColors();
    assert.deepEqual(seen.chips, pairKeys.map(k => [k, rgb(expectedColors[k])]));
    assert.deepEqual(seen.legend, pairKeys.map(k => rgb(expectedColors[k])));
    assert.deepEqual(seen.chart, pairKeys.map(k => expectedColors[k]));

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

    await page.click('.studio-nav [data-page-nav="players"]');
    await page.waitForTimeout(200);
    const players = await page.evaluate(() => ({
      tiles: [...document.querySelectorAll('#tiles .tile .swatch')].map(s => getComputedStyle(s).backgroundColor),
      legend: [...document.querySelectorAll('#legend [data-subject] .mark')].map(m => getComputedStyle(m).backgroundColor),
      table: [...document.querySelectorAll('#langTable thead .swatch')].map(m => getComputedStyle(m).backgroundColor),
      keys: subjects.map(s => s.key),
    }));
    const inOrder = players.keys.map(k => rgb(expectedColors[k]));
    assert.deepEqual(players.tiles, inOrder); assert.deepEqual(players.legend, inOrder); assert.deepEqual(players.table, inOrder);
    // Players page names the version-window rate the same way as the comparison page.
    assert.match(await page.locator('#tiles').innerText(), /版本窗口好评率/);
    // Adding a third version or removing one never repaints the survivors.
    const extra = await page.evaluate(() => { const g = catalog.find(g => g.game_id === subjects[0].gameId); return g.versions.map(v => g.game_id + '@' + v.key).find(k => !subjects.some(s => s.key === k)); });
    if (extra) {
      await page.selectOption('#subjectAdd', extra);
      await page.waitForFunction(k => subjects.some(s => s.key === k && s.snap), extra);
      const after = await page.evaluate(() => Object.fromEntries(subjects.map(s => [s.key, s.color])));
      for (const k of players.keys) assert.equal(after[k], expectedColors[k], `${k} keeps its colour after adding ${extra}`);
      await page.click(`#subjectChips [data-remove="${players.keys[0]}"]`);
      await page.waitForFunction(k => !subjects.some(s => s.key === k), players.keys[0]);
      const remaining = await page.evaluate(() => Object.fromEntries(subjects.map(s => [s.key, s.color])));
      assert.equal(remaining[players.keys[1]], expectedColors[players.keys[1]]);
    }

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
    assert.equal(await page.locator('.video-empty').count(), 1, 'sources without data collapse into one line');
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

    /* Default path for every game: no blank KPI, dangling unit, empty ranking or 「0 支」 video scope. */
    const gameIds = await page.evaluate(() => catalog.map(g => g.game_id));
    for (const id of gameIds) {
      await page.click('.studio-nav [data-page-nav="overview"]');
      await page.click(`[data-game="${id}"]`);
      await page.waitForFunction(g => subjects.length === 1 && subjects[0].key === g && subjects[0].snap, id);
      for (const days of [90, 3]) {
        await page.click(`#rangeSeg [data-days="${days}"]`);
        const kpis = await page.evaluate(() => [...document.querySelectorAll('#tiles .tile')].filter(t => t.offsetParent !== null).map(t => t.innerText));
        assert.equal(kpis.length, 4, `${id} overview shows four KPI cards`);
        for (const text of kpis) {
          assert.doesNotMatch(text, /—/, `${id} ${days}d KPI must not be blank: ${text}`);
          assert.doesNotMatch(text, /\n\s*(h|%|条\/日)\s*(\n|$)/, `${id} ${days}d KPI has a dangling unit: ${text}`);
        }
        assert.ok(await page.locator('#studioRanking .rank-row').count() > 0, `${id} ${days}d content ranking is not empty`);
        assert.ok(await page.locator('#studioEvents .event-row').count() > 0, `${id} ${days}d events card is not empty`);
      }
      await page.click('#rangeSeg [data-days="90"]');
      await page.click('.studio-nav [data-page-nav="videos"]');
      await page.waitForSelector('.video-dashboard');
      assert.doesNotMatch(await page.locator('.video-scope').innerText(), /(^|\D)0 支|暂无/, `${id} videos page is not empty`);
      assert.ok(await page.locator('.video-facet').count() > 0, `${id} videos page shows at least one chart`);
    }
    await page.click(`[data-game="${gameIds[0]}"]`);
    await page.waitForFunction(g => subjects[0].key === g && subjects[0].snap, gameIds[0]);

    for (const section of ['versions', 'videos', 'overview', 'players', 'sources', 'trends']) {
      await page.click(`.studio-nav [data-page-nav="${section}"]`);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, `${section} must fit a phone`);
      // Every page and every game is reachable on a phone without hidden horizontal scrolling.
      const reach = await page.evaluate(() => [...document.querySelectorAll('.studio-nav button, .game-nav button')].map(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth; }));
      assert.ok(reach.length >= 7 && reach.every(Boolean), `${section}: nav and game switcher fully visible on a phone`);
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
    console.log('Studio checks passed: raw-data comparison, 3/7/14-day windows, swap, metric switch, ranking, cross-source bar clicks, timeline, missing-data states, platform formulas, CSV/PNG, share restoration, fixed version colours across pages, no blank default KPIs per game, mobile reachability.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
