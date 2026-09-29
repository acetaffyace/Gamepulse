const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

/* 主工作台（dashboard/index.html）的数据正确性与鲁棒性检查：
   视频分面、配对联动、导出、分享恢复、3/7/14/自定义窗口、预设、手机布局、
   焦点管理、离线资源、XSS 转义与 CSV 公式注入。版本与游戏一律从目录读取，
   不写死版本号 —— 目录新增或插入版本后测试照样成立。 */
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
    const origin = `http://127.0.0.1:${server.address().port}`;
    const base = `${origin}/dashboard/index.html?page=videos`;
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('#app:not(.hidden)');
    await page.waitForSelector('.video-dashboard');
    assert.equal(await page.locator('.video-dashboard').count(), 1);
    assert.equal(await page.locator('.video-facet').count(), 5);
    assert.equal(await page.locator('.video-chart canvas').count(), 5);
    assert.equal(await page.evaluate(() => videoCharts.length), 5);
    await page.screenshot({ path: path.join(os.tmpdir(), 'gamepulse-new-desktop.png'), fullPage: true });

    const pair = await page.locator('[data-video-control="pair"] option').nth(1).getAttribute('value');
    await page.selectOption('[data-video-control="pair"]', pair);
    assert.equal(await page.locator('.video-selected strong').count(), 5);
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
    const csv = fs.readFileSync(await (await downloadPromise).path(), 'utf8');
    assert.match(csv, /baseline_date/);
    assert.match(csv, /tracking/);
    assert.match(csv, /snapshot_date/);
    const pngPromise = page.waitForEvent('download');
    await page.click('[data-export-video-png]');
    assert.equal(fs.readFileSync(await (await pngPromise).path()).subarray(1, 4).toString(), 'PNG');
    // Sources without a complete launch window collapse into one explanatory line, not five blank panels.
    await page.selectOption('[data-video-control="mode"]', 'age');
    assert.equal(await page.locator('.video-empty').count(), 1);
    assert.equal(await page.locator('.video-facet').count(), 0);
    assert.match(await page.locator('.video-empty').innerText(), /5 个来源.*首 \d+ 天完整采样/);
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

    // A 14-day comparison of the two latest versions uses the same window in chart, tiles and table.
    const index = JSON.parse(fs.readFileSync(path.join(root, 'data/index.json'), 'utf8'));
    const game = index.games[0];
    const [older, newer] = game.versions.slice(-2);
    await page.goto(`${origin}/dashboard/index.html?page=players#s=${game.game_id}@${older.key}|${game.game_id}@${newer.key}&a=day0&r=14`, { waitUntil: 'networkidle' });
    await page.waitForFunction(keys => subjects.map(s => s.key).join('|') === keys && subjects.every(s => s.snap),
      `${game.game_id}@${older.key}|${game.game_id}@${newer.key}`);
    const stats = await page.evaluate(() => subjects.map(s => windowStats(s)));
    assert.deepEqual(stats.map(s => s.historicalDays), [14, 14]);
    const snapshot = await page.evaluate(() => subjects[0].snap);
    const end = start => new Date(Date.parse(start + 'T00:00:00Z') + 13 * 864e5).toISOString().slice(0, 10);
    const expectedTotals = [older.date_local, newer.date_local].map(start =>
      snapshot.review_history.filter(r => r.date_local >= start && r.date_local <= end(start)).reduce((n, r) => n + r.new_reviews, 0));
    assert.deepEqual(stats.map(s => s.historicalReviews), expectedTotals);
    assert.equal(await page.evaluate(() => buildCtx().axis.keys.length), 14);
    // Legend and tiles describe the same D0–D13 window as the chart, not the whole version length.
    const legend = await page.locator('#legend').innerText();
    assert.match(legend, /D0–D13/);
    assert.match(await page.locator('#tiles').innerText(), /D0–D13/);
    await page.click('#demoFilters');
    await page.fill('#customDays', '5'); await page.click('#applyDays');
    assert.equal(await page.evaluate(() => buildCtx().axis.keys.length), 5);
    assert.deepEqual(await page.evaluate(() => subjects.map(s => windowStats(s).historicalDays)), [5, 5]);
    assert.match(await page.locator('#legend').innerText(), /D0–D4/);
    await page.click('#rangeSeg [data-days="7"]');
    assert.equal(await page.evaluate(() => buildCtx().axis.keys.length), 7);
    await page.click('#rangeSeg [data-days="3"]');
    assert.equal(await page.evaluate(() => buildCtx().axis.keys.length), 3);

    await page.click('.studio-nav [data-page-nav="explore"]');
    for (const preset of await page.evaluate(() => Object.keys(config.presets || {}))) {
      await page.selectOption('#presetSelect', preset);
      assert.equal(await page.evaluate(() => videoCharts.filter(c => c.isDisposed()).length), 0);
      assert.equal(await page.evaluate(() => (chart.getOption().title || []).some(t => /undefined/.test(t.text))), false, preset);
    }
    await page.selectOption('#presetSelect', 'default');
    const allGames = index.games.map(g => g.game_id).join('|');
    await page.goto(`${origin}/dashboard/index.html?page=explore#s=${allGames}&a=calendar&r=90`, { waitUntil: 'networkidle' });
    await page.waitForFunction(n => subjects.length === n && subjects.every(s => s.snap), index.games.length);
    assert.equal(await page.evaluate(() => chart.getOption().title.some(t => /undefined/.test(t.text))), false);
    // Main chart is announced to assistive technology.
    assert.equal(await page.evaluate(() => { const a = chart.getOption().aria; return (Array.isArray(a) ? a[0] : a).enabled; }), true);
    assert.equal(await page.locator('#pulse').getAttribute('role'), 'img');

    await page.goto(`${origin}/dashboard/index.html?page=trends#s=${game.game_id}&a=calendar&r=90`, { waitUntil: 'networkidle' });
    await page.waitForFunction(id => subjects.length === 1 && subjects[0].key === id && subjects[0].snap, game.game_id);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.equal(dimensions.scroll, dimensions.width, 'mobile page must not overflow');
    await page.screenshot({ path: path.join(os.tmpdir(), 'gamepulse-new-mobile.png'), fullPage: true });
    if (await page.locator('#studioAdvanced').isHidden()) await page.click('#demoFilters');
    await page.click('#studioConfigure');
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('#lanePanel')), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'studioConfigure', 'focus returns to the visible opener');
    // The data-table toggle keeps its icon when its label changes.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.click('#toggleTable');
    assert.equal(await page.locator('#toggleTable svg').count(), 1);
    assert.match(await page.locator('#toggleTable').innerText(), /隐藏数据表/);
    await page.click('#toggleTable');
    assert.equal(await page.locator('#toggleTable svg').count(), 1);
    await page.clock.setFixedTime(new Date('2027-01-01T12:00:00Z'));
    await page.evaluate(() => renderAll());
    assert.equal(await page.locator('#dataStatus').isVisible(), true, 'stale snapshot warning is visible in the workspace');

    const broken = await browser.newPage();
    const brokenErrors = [];
    broken.on('pageerror', e => brokenErrors.push(e.message));
    await broken.route('**/vendor/echarts-5.5.0.min.js', route => route.abort());
    await broken.goto(base, { waitUntil: 'networkidle' });
    assert.match(await broken.locator('#loading').innerText(), /图表资源加载失败/);
    assert.equal(await broken.locator('#retryLoad').isVisible(), true);
    assert.deepEqual(brokenErrors, []);
    await broken.close();

    // A missing data catalog explains how to serve the project instead of blaming the JSON.
    const missing = await browser.newPage();
    await missing.route('**/data/index.json?*', route => route.fulfill({ status: 404, body: '' }));
    await missing.goto(base, { waitUntil: 'networkidle' });
    assert.match(await missing.locator('#loading').innerText(), /项目根目录/);
    await missing.close();

    // Hostile strings from data and config are rendered as text everywhere, never as HTML.
    const payload = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';
    const hostile = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const hostileErrors = [];
    hostile.on('pageerror', e => hostileErrors.push(e.message));
    await hostile.route('**/data/index.json?*', async route => {
      const body = await (await route.fetch()).json();
      body.games[0].short_name = '鸣潮' + payload;
      await route.fulfill({ json: body });
    });
    await hostile.route(`**/data/${game.file}*`, async route => {
      const body = await (await route.fetch()).json();
      body.game.short_name = '鸣潮' + payload;
      body.sources[0] = { ...body.sources[0], label: payload, name: payload, note: payload };
      const videos = body.bilibili.videos;
      videos.forEach(v => { v.short_title = '标题' + payload; v.character_name = payload; });
      Object.values(body.youtube.locales || {}).forEach(l => (l.videos || []).forEach(v => { v.short_title = '=HYPERLINK("x")' + payload; }));
      (body.events || []).filter(e => e.type === 'content').forEach(e => { e.label = payload; });
      (body.review_profile.version_windows || []).forEach(w => w.comparisons.forEach(c => { c.label = payload; }));
      await route.fulfill({ json: body });
    });
    await hostile.goto(`${origin}/dashboard/index.html?page=overview`, { waitUntil: 'networkidle' });
    await hostile.waitForSelector('#app:not(.hidden)');
    for (const section of ['videos', 'versions', 'players', 'sources', 'trends', 'explore']) {
      await hostile.click(`.studio-nav [data-page-nav="${section}"]`);
      await hostile.waitForTimeout(250);
    }
    await hostile.click('.studio-nav [data-page-nav="videos"]');
    await hostile.waitForSelector('.video-chart canvas');
    await hostile.evaluate(() => {
      document.querySelector('.video-details').open = true;
      videoCharts.forEach(c => c.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: 0 }));
      const ctx = buildCtx();
      const lane = { ...activeLanes()[0] };
      // Engine tooltips are HTML: feed a hostile series name straight into them.
      document.body.insertAdjacentHTML('beforeend', '<div id="tipProbe" hidden></div>');
      document.getElementById('tipProbe').innerHTML = buildTooltip([{ axisValue: ctx.axis.keys.at(-1), seriesName: 'x' }],
        [{ lane, built: { series: [{ name: '<img src=x onerror="window.__xss=(window.__xss||0)+1">', color: '#000', values: ctx.axis.keys.map(() => 1) }] } }], ctx);
    });
    await hostile.click('#toggleTable');
    await hostile.waitForTimeout(400);
    assert.equal(await hostile.evaluate(() => window.__xss), undefined, 'no injected handler may run');
    assert.ok(await hostile.evaluate(() => document.body.innerText.includes('<img src=x')), 'hostile text is shown literally');
    assert.equal(await hostile.evaluate(() => document.querySelectorAll('img[src="x"]').length), 0);
    // CSV cells that look like formulas are neutralised; numbers keep their sign; CR/LF are quoted.
    assert.deepEqual(await hostile.evaluate(() => [csvEscape('=1+1'), csvEscape('+cmd'), csvEscape('-x'), csvEscape('@a'),
      csvEscape('\tx'), csvEscape('a\rb'), csvEscape(-5), csvEscape('普通,标题')]),
      ["'=1+1", "'+cmd", "'-x", "'@a", "'\tx", '"a\rb"', '-5', '"普通,标题"']);
    assert.deepEqual(hostileErrors, []);
    await hostile.close();

    assert.deepEqual(errors, []);
    console.log('Browser checks passed: offline assets, facets, pairing, overlay, formulas, collapsed empty sources, exports, sharing, 3/7/14/custom windows with matching legend, presets, mobile, focus return, icon-safe toggle, stale warning, load errors, XSS escaping, CSV formula guard.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
