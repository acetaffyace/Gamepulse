// 端到端：用合成数据生成发布包，在无头 Chromium 里逐页检查。
//   node tests/web/e2e.cjs
// 页面上的数字和独立写的 SQL 算出来的结果比对；也检查导出、自助查询的规则拦截、深色模式、手机宽度与加载失败。

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { after, before, describe, test } = require('node:test');
const { chromium, firefox, webkit } = require('playwright');
const BROWSER = process.env.GP_TEST_BROWSER || 'chromium';

const ROOT = join(__dirname, '..', '..');
const PORT = 8800 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}/`;
const PAGES = { overview: '运营总览', versions: '版本对比', videos: '视频传播', players: '玩家结构', explore: '自助查询', sources: '数据来源' };
let server;
let browser;

async function open(path, { viewport = { width: 1366, height: 900 }, colorScheme = 'light', route } = {}) {
  const context = await browser.newContext({ viewport, colorScheme, acceptDownloads: true, permissions: BROWSER === 'chromium' ? ['clipboard-read', 'clipboard-write'] : [] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  if (route) await route(page);
  await page.goto(BASE + path);
  return { page, errors, context };
}

async function ready(page) {
  await page.waitForFunction(() => window.gamepulse && document.querySelector('#page[data-ready="true"] h1'), null, { timeout: 30000 });
  await page.waitForTimeout(300);
}

async function runSql(page) {
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.sql-results')?.getAttribute('aria-busy') !== 'true');
}

const sql = (page, text, params = []) => page.evaluate(([t, p]) => window.gamepulse.rows(t, p), [text, params]);
const number = text => Number(String(text).replace(/[^\d.\-−]/g, '').replace('−', '-'));

before(async () => {
  const out = execFileSync('python', ['-m', 'tests.support.web_fixture', mkdtempSync(join(tmpdir(), 'gp-e2e-'))],
    { cwd: ROOT, encoding: 'utf-8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  const info = JSON.parse(out.trim().split('\n').pop());
  server = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '-d', info.dist], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1500));
  browser = await ({ chromium, firefox, webkit })[BROWSER].launch();
});

after(async () => {
  await browser?.close();
  server?.kill();
});

describe('every page', () => {
  for (const [page, title] of Object.entries(PAGES)) {
    for (const game of ['alpha', 'beta']) {
      test(`${page} (${game}) renders without errors`, async () => {
        const { page: p, errors, context } = await open(`?page=${page}&game=${game}`);
        await ready(p);
        assert.equal(await p.textContent('main h1'), title);
        assert.equal(await p.locator('.error').count(), 0, await p.locator('.error').allTextContents().then(t => t.join()));
        assert.deepEqual(errors, []);
        await context.close();
      });
    }
  }
});

test('overview tiles agree with an independent SQL computation', async () => {
  const { page, context } = await open('?page=overview&game=alpha&days=14');
  await ready(page);
  const [{ anchor }] = await sql(page, "SELECT MAX(date) AS anchor FROM v_review_daily WHERE game_id = 'alpha' AND complete_day = 1");
  const [expected] = await sql(page, "SELECT SUM(reviews) AS n, 100.0 * SUM(positive) / (SUM(positive) + SUM(negative)) AS rate "
    + "FROM v_review_daily WHERE game_id = 'alpha' AND date BETWEEN date(?, '-13 day') AND ?", [anchor, anchor]);
  assert.equal(number(await page.locator('[data-metric="daily_reviews"] .tile-value').textContent()), expected.n);
  assert.ok(Math.abs(number(await page.locator('[data-metric="daily_positive_rate"] .tile-value').textContent()) - expected.rate) < 0.006);
  assert.match(await page.textContent('.scope'), /共 14 天/);
  await context.close();
});

test('version comparison uses the same window for both versions and can swap', async () => {
  const { page, context } = await open('?page=versions&game=alpha&a=1.1&b=1.2&days=7');
  await ready(page);
  const counts = await sql(page, "SELECT version_id, COUNT(*) AS n FROM v_review WHERE game_id = 'alpha' "
    + "AND version_id IN ('1.1', '1.2') AND day_index BETWEEN 0 AND 6 GROUP BY version_id ORDER BY version_id");
  const firstTile = await page.locator('.tile').first().locator('.tile-value').allTextContents();
  assert.deepEqual(firstTile.map(number), [counts[1].n]);
  await page.getByRole('button', { name: '交换 A 和 B' }).click();
  await page.waitForFunction(() => new URLSearchParams(location.search).get('a') === '1.2');
  // 网址先变、页面随后重绘：等指标卡真正换过来再读
  await page.waitForFunction(first => document.querySelector('.tile .tile-value')?.textContent !== first, firstTile[0]);
  const swapped = await page.locator('.tile').first().locator('.tile-value').allTextContents();
  assert.deepEqual(swapped.map(number), [counts[0].n]);
  await context.close();
});

test('data table toggle and CSV export', async () => {
  const { page, context } = await open('?page=overview&game=beta');
  await ready(page);
  const card = page.locator('section.card').first();
  await card.getByRole('button', { name: '数据表' }).click();
  assert.ok(await card.locator('table.data tbody tr').count() > 5);
  await card.getByText('导出', { exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), card.getByRole('button', { name: '导出 CSV' }).click()]);
  const text = readFileSync(await download.path(), 'utf-8');
  assert.match(text, /日期,评测数/);
  await context.close();
});

test('explore: presets run, rules block meaningless queries, SQL mode is read-only', async () => {
  const { page, errors, context } = await open('?page=explore&fact=review_daily&m=daily_reviews&x=day_index&s=version_id&games=alpha');
  await ready(page);
  assert.match(await page.textContent('.scope'), /\d+ 行/);
  assert.match(await page.textContent('pre.sql'), /FROM "v_review_daily"/);

  await page.goto(`${BASE}?page=explore&fact=video_latest&m=latest_views&x=content_type`);
  await ready(page);
  assert.match(await page.textContent('.error'), /必须按「频道语区」分开看/);

  await page.goto(`${BASE}?page=explore`);
  await ready(page);
  await page.getByText('示例查询', { exact: true }).click();
  await page.locator('.query-presets button').first().click();
  await page.waitForFunction(() => new URLSearchParams(location.search).get('s') === 'language');
  await ready(page);
  assert.equal(await page.locator('.error').count(), 0);
  assert.ok(await page.locator('.chart').count() >= 1);

  await page.goto(`${BASE}?page=explore&mode=sql`);
  await ready(page);
  assert.equal(await page.locator('.error').count(), 0, '默认示例 SQL 应该能直接运行');
  assert.ok(await page.locator('table.data tbody tr').count() > 0);
  await page.fill('textarea.sql', 'DELETE FROM game');
  await runSql(page);
  await page.waitForSelector('.error');
  assert.match(await page.textContent('.error'), /只能执行 SELECT/);
  assert.equal((await sql(page, 'SELECT COUNT(*) AS n FROM game'))[0].n, 2);
  assert.deepEqual(errors, []);
  await context.close();
});

test('explore refuses stacked rates, keeps date gaps and validates filters', async () => {
  const { page, context } = await open('?page=explore&fact=review_daily&m=daily_positive_rate&x=week_start&s=game_id&chart=stacked');
  await ready(page);
  assert.match(await page.textContent('.error'), /不能画成堆叠图/);
  await page.goto(`${BASE}?page=explore&fact=review_daily&m=daily_reviews&x=date&from=2026-09-10&to=2026-09-01`);
  await ready(page);
  assert.match(await page.textContent('.error'), /晚于结束日期/);
  await page.goto(`${BASE}?page=explore&fact=review_daily&m=daily_reviews&x=date&d0=abc`);
  await ready(page);
  assert.match(await page.textContent('.error'), /必须是整数/);
  // 视频观测按日期看，每支视频中间漏采的日子应当留空
  await page.goto(`${BASE}?page=explore&fact=video_obs&m=video_views&x=date&s=video_id&locales=global&games=beta`);
  await ready(page);
  assert.equal(await page.locator('.error').count(), 0);
  await context.close();
});

test('raw SQL from a link is not run automatically and writes are impossible', async () => {
  const evil = encodeURIComponent('WITH x AS (SELECT 1) DELETE FROM version');
  const { page, context } = await open(`?page=explore&mode=sql&sql=${evil}`);
  await ready(page);
  assert.equal(await page.locator('table.data').count(), 0);
  assert.match(await page.textContent('main'), /查询待运行/);
  await runSql(page);
  await page.waitForSelector('.error');
  assert.match(await page.textContent('.error'), /不能修改数据/);
  // 就算绕过了文字检查，数据库本身也是只读的
  const error = await page.evaluate(() => { try { window.gamepulse.db.run('DELETE FROM version'); return ''; } catch (e) { return e.message; } });
  assert.match(error, /readonly|read-only|attempt to write/i);
  assert.ok((await sql(page, 'SELECT COUNT(*) AS n FROM version'))[0].n > 0);
  await context.close();
});

test('weekly chart uses one point per week without inventing daily gaps', async () => {
  const { page, context } = await open('?page=explore&fact=review_daily&m=daily_positive_rate&x=week_start&s=game_id');
  await ready(page);
  const weeks = await sql(page, 'SELECT DISTINCT week_start FROM v_review_daily WHERE complete_day = 1 ORDER BY week_start');
  const axis = await page.evaluate(() => echarts.getInstanceByDom(document.querySelector('.chart')).getOption().xAxis[0].data);
  assert.deepEqual(axis, weeks.map(r => r.week_start));
  assert.doesNotMatch(await page.textContent('main'), /个日期没有数据/);
  await context.close();
});

test('explore inherits the game and can expand back to all games', async () => {
  const { page, context } = await open('?page=overview&game=beta');
  await ready(page);
  await page.locator('a[data-page="explore"]').click();
  await ready(page);
  const games = page.locator('[aria-label="游戏"]');
  assert.deepEqual(await games.locator('[aria-pressed="true"]').allTextContents(), ['测试乙']);
  const other = games.locator('[aria-pressed="false"]').first();
  await other.click();
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="游戏"] [aria-pressed="true"]').length === 2);
  assert.equal(new URL(page.url()).searchParams.has('game'), false);
  await context.close();
});

test('SQL schema browsing preserves the draft and does not execute it', async () => {
  const { page, context } = await open('?page=explore&mode=sql');
  await ready(page);
  const result = await page.locator('table.data').textContent();
  await page.fill('textarea.sql', 'SELECT 42 AS draft');
  await page.getByRole('button', { name: 'v_review', exact: true }).click();
  assert.equal(await page.locator('textarea.sql').inputValue(), 'SELECT 42 AS draft');
  assert.equal(await page.locator('table.data').textContent(), result);
  assert.match(await page.locator('.schema-fields').textContent(), /created_date/);
  await page.getByRole('button', { name: 'v_review', exact: true }).click();
  assert.equal(await page.locator('.schema-fields').count(), 0);
  await context.close();
});

test('tables browse the full result and export all rows despite searching and sorting', async () => {
  const { page, context } = await open('?page=explore&mode=sql');
  await ready(page);
  await page.fill('textarea.sql', 'WITH RECURSIVE numbers(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM numbers WHERE n<120) SELECT n FROM numbers');
  await runSql(page);
  assert.equal(await page.locator('tbody tr').count(), 50);
  await page.getByRole('button', { name: '查询结果下一页' }).click();
  assert.equal(await page.locator('tbody tr').first().textContent(), '50');
  await page.getByRole('button', { name: '按n排序' }).click();
  await page.getByRole('button', { name: '按n排序' }).click();
  assert.equal(await page.locator('tbody tr').first().textContent(), '120');
  await page.getByRole('searchbox', { name: '搜索查询结果' }).fill('120');
  assert.equal(await page.locator('tbody tr').count(), 1);
  await page.locator('section.card').filter({ has: page.getByRole('heading', { name: '查询结果', exact: true }) }).getByText('导出', { exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '导出 CSV' }).click()]);
  assert.equal(readFileSync(await download.path(), 'utf8').trim().split('\n').length, 122);
  await context.close();
});

test('wrapped legends toggle series, sample tooltips agree with records, and PNG retains context', async () => {
  const { page, context } = await open('?page=versions&game=alpha&a=1.1&b=1.2&days=7');
  await ready(page);
  const card = page.locator('section.card').filter({ has: page.getByRole('heading', { name: '每日好评率', exact: true }) });
  const [sample] = await sql(page, "SELECT COUNT(*) AS n FROM v_review WHERE game_id='alpha' AND version_id='1.1' AND day_index=0 AND voted_up IS NOT NULL");
  await card.scrollIntoViewIfNeeded();
  await card.locator('.chart').evaluate(el => echarts.getInstanceByDom(el).dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: 0 }));
  assert.match(await card.textContent(), new RegExp(`评价已知 ${sample.n} 条`));
  const legend = card.locator('.legend-item').first();
  await legend.click();
  const hidden = await card.locator('.chart').evaluate(el => echarts.getInstanceByDom(el).getOption().legend[0].selected['A · 1.1']);
  assert.equal(hidden, false);
  await legend.click();
  await card.getByRole('button', { name: '数据表', exact: true }).click();
  await card.getByText('导出', { exact: true }).click();
  const [png] = await Promise.all([page.waitForEvent('download'), card.getByRole('button', { name: '导出 PNG' }).click()]);
  const bytes = readFileSync(await png.path());
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  assert.ok(bytes.readUInt32BE(20) > 700, '导出图片应包含图之外的上下文空间');
  await card.getByText('导出', { exact: true }).click();
  const [metadata] = await Promise.all([page.waitForEvent('download'), card.getByRole('button', { name: '下载口径说明' }).click()]);
  const info = JSON.parse(readFileSync(await metadata.path(), 'utf8'));
  assert.equal(info.filters.game, 'alpha');
  assert.equal(info.title, '每日好评率');
  assert.match(info.scope, /D0–D6/);
  await context.close();
});

test('phone explorer starts with results and expands filters on demand', async () => {
  const { page, context } = await open('?page=explore&game=alpha', { viewport: { width: 390, height: 844 } });
  await ready(page);
  assert.equal(await page.locator('.query-controls').getAttribute('open'), null);
  assert.ok(await page.locator('.chart').isVisible());
  assert.ok(await page.locator('.chart').evaluate(el => el.getBoundingClientRect().top < 650));
  await page.locator('.query-controls > summary').click();
  assert.ok(await page.locator('.panel fieldset').first().isVisible());
  await context.close();
});

test('multi-game explorer starts with separate series and allows explicit aggregation', async () => {
  const { page, context } = await open('?page=explore');
  await ready(page);
  const names = await page.locator('.legend-item').allTextContents();
  assert.deepEqual(names, ['测试甲', '测试乙']);
  await page.getByLabel('拆分为多条').selectOption('none');
  await page.waitForFunction(() => new URLSearchParams(location.search).get('s') === 'none');
  await page.waitForFunction(() => document.querySelector('.card-sub')?.textContent.includes('合并统计'));
  assert.equal(await page.locator('.legend-item').count(), 0);
  await context.close();
});

test('video hand selection retains missing early ages and shows measured coverage', async () => {
  const { page, context } = await open('?page=videos&game=alpha&locale=global&age=30&curve_ids=YTglobal1');
  await ready(page);
  const card = page.locator('section.card').filter({ has: page.getByRole('heading', { name: '同龄对比', exact: true }) });
  const [expected] = await sql(page, "SELECT COUNT(*) AS n FROM v_video_obs WHERE game_id='alpha' AND locale='global' AND video_id='YTglobal1' AND days_since_pub BETWEEN 0 AND 29");
  assert.equal(await card.locator('.coverage-track .observed').count(), expected.n);
  const data = await card.locator('.chart').evaluate(el => echarts.getInstanceByDom(el).getOption().series[0].data);
  assert.deepEqual(data.slice(0, 3), [null, null, null]);
  assert.equal(data.filter(v => v !== null).length, expected.n);
  await card.locator('.curve-picker > summary').click();
  await card.locator('input[value="YTglobal0"]').check();
  await page.waitForFunction(() => new URLSearchParams(location.search).get('curve_ids').includes('YTglobal0'));
  await page.waitForFunction(() => document.querySelectorAll('.coverage-row').length === 2);
  assert.ok(await card.locator('.curve-picker').getAttribute('open') !== null, '连续选择时选择器应保持展开');
  await context.close();
});

test('player interval and same-stage samples agree with independent SQL', async () => {
  const { page, errors, context } = await open('?page=players&game=alpha&stage=14');
  await ready(page);
  assert.match(await page.textContent('.scope'), /共 14 天/);
  const expected = await sql(page, "SELECT version_id, quantile(playtime_at_review,0.25)/60.0 AS low, quantile(playtime_at_review,0.5)/60.0 AS mid, quantile(playtime_at_review,0.75)/60.0 AS high FROM v_review WHERE game_id='alpha' AND day_index BETWEEN 0 AND 13 GROUP BY version_id ORDER BY version_id");
  const card = page.locator('section.card').filter({ has: page.getByRole('heading', { name: '时长分布', exact: true }) });
  const actual = await card.locator('.chart').evaluate(el => echarts.getInstanceByDom(el).getOption().series[0]);
  assert.equal(actual.type, 'custom');
  assert.deepEqual(actual.data, expected.map((r, i) => [i, r.low, r.mid, r.high]));
  await card.getByRole('button', { name: '数据表', exact: true }).click();
  const [sample] = await sql(page, "SELECT COUNT(playtime_at_review) AS n FROM v_review WHERE game_id='alpha' AND version_id='1.0' AND day_index BETWEEN 0 AND 13");
  assert.match(await card.locator('tbody tr').first().textContent(), new RegExp(String(sample.n)));
  assert.deepEqual(errors, []);
  await context.close();
});

test('source filters prioritize attention and keep game scope in investigation links', async () => {
  const { page, context } = await open('?page=sources');
  await ready(page);
  assert.equal(await page.locator('.source-alert').first().locator('.status.failed, .status.missing').count(), 1);
  assert.ok(await page.locator('.source-alert.failed').count() > 0, '最近失败不能被一般过期来源挤出摘要');
  await page.getByLabel('游戏范围').selectOption('beta');
  await page.waitForFunction(() => new URLSearchParams(location.search).get('source_game') === 'beta');
  await page.waitForFunction(() => [...document.querySelectorAll('.source-alert strong')].every(e => e.textContent.includes('测试乙')));
  const links = await page.locator('.source-alert a').evaluateAll(as => as.map(a => a.getAttribute('href')));
  assert.ok(links.length > 0);
  assert.ok(links.every(href => new URLSearchParams(href.slice(1)).get('game') === 'beta'));
  const [expected] = await sql(page, "SELECT COUNT(*) AS n FROM v_source_status WHERE game_id='beta' AND status NOT IN ('healthy','disabled','skipped')");
  const card = page.locator('section.card').filter({ has: page.getByRole('heading', { name: '来源状态', exact: true }) });
  assert.equal(await card.locator('tbody tr').count(), expected.n);
  await context.close();
});

test('wide charts remain a balanced two-column group', async () => {
  const { page, context } = await open('?page=versions&game=alpha', { viewport: { width: 1920, height: 1080 } });
  await ready(page);
  const positions = await page.locator('.grid-2 > .card').evaluateAll(cards => cards.map(c => {
    const r = c.getBoundingClientRect(); return { left: r.left, top: r.top };
  }));
  assert.equal(positions[0].top, positions[1].top);
  assert.equal(positions[2].top, positions[3].top);
  assert.ok(positions[2].top > positions[0].top);
  assert.equal(positions[2].left, positions[0].left);
  await context.close();
});

test('multiple versions across games share a window and preserve values on a calendar axis', async () => {
  const { page, errors, context } = await open('?page=versions&comparison=multi&objects=alpha@1.0,alpha@1.1,beta@2.0&days=all');
  await ready(page);
  assert.match(await page.textContent('.scope'), /共 30 天/);
  const expected = [];
  for (const [game, version] of [['alpha', '1.0'], ['alpha', '1.1'], ['beta', '2.0']]) {
    const [r] = await sql(page, 'SELECT COUNT(*) AS n FROM v_review WHERE game_id = ? AND version_id = ? AND day_index BETWEEN 0 AND 29', [game, version]);
    expected.push(r.n);
  }
  const counts = async () => page.locator('section.card').first().locator('tbody tr').evaluateAll(rows => rows.map(r => r.querySelector('td.num').textContent));
  assert.deepEqual((await counts()).map(number), expected);
  await page.getByRole('button', { name: '日历日期', exact: true }).click();
  await page.waitForFunction(() => new URLSearchParams(location.search).get('alignment') === 'calendar');
  await ready(page);
  await page.waitForFunction(() => echarts.getInstanceByDom(document.querySelector('.chart'))?.getOption().xAxis[0].data[0] === '2026-06-01');
  assert.deepEqual((await counts()).map(number), expected);
  const secondSeries = await page.evaluate(() => echarts.getInstanceByDom(document.querySelector('.chart')).getOption().series[1].data);
  assert.ok(secondSeries.slice(0, 30).every(v => v === null), '第二版本不能被画到开放前');
  await page.getByLabel('添加版本').selectOption('alpha@1.2');
  await page.waitForFunction(() => document.querySelectorAll('section.card:first-of-type tbody tr').length === 4);
  await page.getByRole('button', { name: '移除 测试甲 1.1', exact: true }).click();
  await page.waitForFunction(() => !new URLSearchParams(location.search).get('objects').includes('alpha@1.1'));
  assert.deepEqual(errors, []);
  await context.close();
});

test('before/after windows match independent SQL and incomplete coverage is explicit', async () => {
  const { page, errors, context } = await open('?page=versions&comparison=before-after&game=alpha');
  await ready(page);
  assert.match(await page.textContent('.scope'), /D−7–D−1/);
  const rows = page.locator('section.card tbody tr');
  assert.equal(await rows.count(), 3);
  assert.match(await rows.first().textContent(), /覆盖不足/);
  const second = rows.nth(1);
  const [before] = await sql(page, "SELECT COUNT(*) AS n FROM v_review WHERE game_id='alpha' AND created_date BETWEEN '2026-06-24' AND '2026-06-30'");
  const [after] = await sql(page, "SELECT COUNT(*) AS n FROM v_review WHERE game_id='alpha' AND created_date BETWEEN '2026-07-01' AND '2026-07-07'");
  assert.equal(await second.locator('.window-change').first().locator('span').textContent(), `${before.n.toLocaleString('zh-CN')} → ${after.n.toLocaleString('zh-CN')}`);
  assert.match(await second.textContent(), /完整可比/);
  await page.locator('section.card').getByText('导出', { exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '导出 CSV' }).click()]);
  assert.match(readFileSync(await download.path(), 'utf-8'), /不可比/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('cadence and new comparison modes render on phone and dark mode', async () => {
  for (const comparison of ['multi', 'before-after', 'cadence']) {
    const { page, errors, context } = await open(`?page=versions&comparison=${comparison}&game=alpha`,
      { viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
    await ready(page);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390));
    assert.equal(await page.locator('.error').count(), 0);
    assert.deepEqual(errors, []);
    if (comparison === 'cadence') {
      const intervals = await page.locator('table.data tbody tr td.num').allTextContents();
      assert.deepEqual(intervals, ['—', '30', '31']);
    }
    await context.close();
  }
});

test('version selection never compares a version with itself', async () => {
  const { page, context } = await open('?page=versions&game=alpha&b=1.0&days=-5');
  await ready(page);
  const [a, b] = await page.locator('.filters select').evaluateAll(els => els.slice(1, 3).map(e => e.value));
  assert.notEqual(a, b);
  assert.match(await page.textContent('.scope'), /共 \d+ 天/);
  assert.doesNotMatch(await page.textContent('.scope'), /共 -/);
  await page.selectOption('.filters select >> nth=1', b);   // 把 A 选成和 B 一样：应当交换
  await page.waitForFunction(() => { const q = new URLSearchParams(location.search); return q.get('a') !== q.get('b'); });
  await context.close();
});

test('clicking a filter caption does not change the filter', async () => {
  const { page, context } = await open('?page=overview&game=alpha&days=90');
  await ready(page);
  await page.getByText('时间范围', { exact: true }).click();
  await page.waitForTimeout(300);
  assert.equal(new URL(page.url()).searchParams.get('days'), '90');
  await context.close();
});

test('back button undoes a filter change', async () => {
  const { page, context } = await open('?page=overview&game=alpha&days=90');
  await ready(page);
  await page.getByRole('button', { name: '7 天' }).click();
  await page.waitForFunction(() => new URLSearchParams(location.search).get('days') === '7');
  await page.goBack();
  await page.waitForFunction(() => new URLSearchParams(location.search).get('days') === '90');
  await context.close();
});

test('dark mode is selectable and remembered', async () => {
  const { page, context } = await open('?page=players&game=alpha');
  await ready(page);
  await page.click('#theme-toggle');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  await page.reload();
  await ready(page);
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  await context.close();
});

test('share button copies the current view', { skip: BROWSER !== 'chromium' }, async () => {
  const { page, context } = await open('?page=versions&game=alpha&a=1.1&b=1.2');
  await ready(page);
  await page.click('#share');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), page.url());
  await context.close();
});

test('pages fit a 390px phone without horizontal scrolling', async () => {
  for (const name of [...Object.keys(PAGES), 'explore&mode=sql']) {
    const { page, context } = await open(`?page=${name}&game=alpha`, { viewport: { width: 390, height: 844 } });
    await ready(page);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= 390, `${name}: ${width}px`);
    await context.close();
  }
});

test('stale data is shown as stale, based on the viewer\'s date', async () => {
  const { page, context } = await open('?page=sources');
  await ready(page);
  // 合成数据截至 2026-09-20；任何晚于这一周的日期打开都应显示过期，而不是正常
  const statuses = await sql(page, 'SELECT DISTINCT status FROM v_source_status');
  assert.ok(statuses.some(s => s.status !== 'healthy'));
  assert.match(await page.textContent('#data-status'), /项异常/);
  await context.close();
});

test('a missing database file shows a readable error with a retry button', async () => {
  const { page, context } = await open('?page=overview', { route: p => p.route('**/*.sqlite.gz', r => r.fulfill({ status: 404 })) });
  await page.waitForSelector('.error');
  assert.match(await page.textContent('.error'), /数据库下载失败/);
  assert.equal(await page.getByRole('button', { name: '重新加载' }).count(), 1);
  await context.close();
});

test('a database from another build is refused', async () => {
  const { page, context } = await open('?page=overview', { route: p => p.route('**/manifest.json', async r => {
    const res = await r.fetch();
    const body = await res.json();
    await r.fulfill({ response: res, json: { ...body, build_id: 'other-build' } });
  }) });
  await page.waitForSelector('.error');
  assert.match(await page.textContent('.error'), /不是同一次发布/);
  await context.close();
});

test('latest navigation wins when an earlier page import is delayed', async () => {
  const { page, context } = await open('?page=overview&game=alpha');
  await ready(page);
  await page.route('**/pages/versions.js', async route => { await new Promise(r => setTimeout(r, 800)); await route.continue(); });
  const pending = page.waitForRequest('**/pages/versions.js');
  await page.locator('nav a[data-page="versions"]').click();
  await pending;
  await page.locator('nav a[data-page="videos"]').click();
  await ready(page);
  await page.waitForTimeout(900);
  assert.equal(new URL(page.url()).searchParams.get('page'), 'videos');
  assert.equal(await page.locator('main h1').textContent(), '视频传播');
  assert.equal(await page.locator('nav a[aria-current="page"]').getAttribute('data-page'), 'videos');
  await context.close();
});

test('a failed page import offers a working retry', async () => {
  const { page, context } = await open('?page=overview&game=alpha');
  await ready(page);
  let attempts = 0;
  const uncaught = [];
  page.on('pageerror', e => uncaught.push(e.message));
  await page.route('**/pages/versions.js*', route => ++attempts === 1 ? route.abort() : route.continue());
  await page.locator('nav a[data-page="versions"]').click();
  await page.locator('.error-state').waitFor();
  assert.equal(await page.locator('main h1').textContent(), '版本对比');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await ready(page);
  assert.ok(attempts >= 2);
  assert.equal(await page.locator('.error-state').count(), 0);
  assert.deepEqual(uncaught, []);
  await context.close();
});

test('theme and navigation preserve SQL drafts without executing them', async () => {
  const { page, context } = await open('?page=explore&mode=sql&game=alpha');
  await ready(page);
  await page.evaluate(() => {
    const raw = gamepulse.raw.bind(gamepulse);
    window.draftRuns = 0;
    gamepulse.raw = (...args) => { window.draftRuns++; return raw(...args); };
  });
  await page.locator('textarea.sql').fill('SELECT 123 AS user_draft');
  await page.locator('#theme-toggle').click();
  await ready(page);
  assert.equal(await page.locator('textarea.sql').inputValue(), 'SELECT 123 AS user_draft');
  assert.equal(await page.evaluate(() => draftRuns), 0);
  await runSql(page);
  assert.equal(await page.locator('tbody tr').first().textContent(), '123');
  await page.locator('textarea.sql').fill('SELECT 456 AS pending_draft');
  await page.locator('nav a[data-page="overview"]').click(); await ready(page);
  await page.locator('nav a[data-page="explore"]').click(); await ready(page);
  assert.equal(await page.locator('textarea.sql').inputValue(), 'SELECT 456 AS pending_draft');
  assert.equal(await page.locator('tbody tr').first().textContent(), '123');
  assert.equal(await page.evaluate(() => draftRuns), 1);
  await context.close();
});

test('keyboard filters retain focus and page navigation keeps its heading visible', async () => {
  const { page, context } = await open('?page=overview&game=alpha');
  await ready(page);
  await page.getByRole('button', { name: '14 天', exact: true }).focus();
  await page.keyboard.press('Enter');
  await ready(page);
  assert.equal(await page.evaluate(() => document.activeElement.textContent), '14 天');
  await page.locator('nav a[data-page="versions"]').click(); await ready(page);
  const visible = await page.evaluate(() => document.querySelector('h1').getBoundingClientRect().top >= document.querySelector('.topbar').getBoundingClientRect().bottom);
  assert.ok(visible);
  await page.locator('nav a[data-page="overview"]').click(); await ready(page);
  assert.equal(new URL(page.url()).searchParams.get('days'), '14');
  await context.close();
});

test('phone query controls stay open across consecutive edits', async () => {
  const { page, context } = await open('?page=explore&game=alpha', { viewport: { width: 390, height: 844 } });
  await ready(page);
  await page.locator('.query-controls > summary').click();
  await page.getByLabel('横轴').focus();
  await page.getByLabel('横轴').selectOption('week_start'); await ready(page);
  assert.notEqual(await page.locator('.query-controls').getAttribute('open'), null);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '横轴');
  await page.getByLabel('图表', { exact: true }).selectOption('bar'); await ready(page);
  assert.notEqual(await page.locator('.query-controls').getAttribute('open'), null);
  await context.close();
});

test('theme retains chart visibility, legend choices and table position', async () => {
  const { page, context } = await open('?page=versions&game=alpha');
  await ready(page);
  const first = page.locator('section.card').first();
  await first.locator('.legend-item').first().click();
  await first.getByRole('button', { name: '数据表', exact: true }).click();
  await page.locator('#theme-toggle').click(); await ready(page);
  assert.ok(await first.locator('.table-view').isVisible());
  assert.equal(await first.locator('.legend-item').first().getAttribute('aria-pressed'), 'false');
  assert.equal(await first.getByRole('button', { name: '图表', exact: true }).count(), 1);
  await context.close();
});

test('default game carries into queries and data-only routes avoid chart downloads', async () => {
  const { page, context } = await open('?page=overview'); await ready(page);
  const game = await page.getByLabel('游戏', { exact: true }).inputValue();
  await page.locator('nav a[data-page="explore"]').click(); await ready(page);
  assert.equal(new URL(page.url()).searchParams.get('game'), game);
  await context.close();
  const requests = [];
  const fresh = await open('?page=explore&mode=sql', { route: p => p.route('**/*', route => { requests.push(route.request().url()); return route.continue(); }) });
  await ready(fresh.page);
  assert.ok(!requests.some(url => url.includes('echarts.min.js')));
  await fresh.context.close();
});

test('an all-game source view keeps the saved game and window of the destination page', async () => {
  const { page, context } = await open('?page=overview&game=beta&days=7'); await ready(page);
  await page.locator('nav a[data-page="sources"]').click(); await ready(page);
  await page.getByLabel('游戏范围').selectOption(''); await ready(page);
  await page.locator('nav a[data-page="overview"]').click(); await ready(page);
  assert.equal(new URL(page.url()).searchParams.get('game'), 'beta');
  assert.equal(new URL(page.url()).searchParams.get('days'), '7');
  assert.equal(await page.getByLabel('游戏', { exact: true }).inputValue(), 'beta');
  await context.close();
});

test('navigation during data loading takes effect even if the unneeded chart engine fails', async () => {
  const { page, context } = await open('?page=overview&game=beta', { route: p => {
    p.route('**/*.sqlite.gz', async route => { await new Promise(r => setTimeout(r, 1200)); await route.continue(); });
    return p.route('**/echarts.min.js', route => route.abort());
  } });
  const uncaught = []; page.on('pageerror', e => uncaught.push(e.message));
  await page.locator('nav a[data-page="sources"]').click();
  await ready(page);
  assert.equal(await page.locator('main h1').textContent(), '数据来源');
  assert.equal(new URL(page.url()).searchParams.get('source_game'), 'beta');
  assert.equal(await page.locator('.error').count(), 0);
  assert.deepEqual(uncaught, []);
  await context.close();
});

test('metric cards have short labels and two visible text rows; phone popovers stay in view', async () => {
  const { page, context } = await open('?page=overview&game=alpha', { viewport: { width: 390, height: 844 } });
  await ready(page);
  const metrics = await page.locator('.tile').evaluateAll(cards => cards.map(card => {
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    const boxes = [];
    for (let node; node = walker.nextNode();) {
      if (!node.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      for (const r of range.getClientRects()) if (r.width && r.height) boxes.push({ top: r.top, bottom: r.bottom });
    }
    boxes.sort((a,b) => a.top-b.top);
    const rows = [];
    for (const box of boxes) {
      const last = rows.at(-1);
      if (last && box.top <= last.bottom + 2) last.bottom = Math.max(last.bottom, box.bottom); else rows.push({ ...box });
    }
    return { label: card.querySelector('.tile-label').textContent, rows: rows.length, longNotes: card.querySelectorAll('.tile-note').length };
  }));
  assert.ok(metrics.every(m => m.label.length <= 6 && m.rows <= 2 && m.longNotes === 0), JSON.stringify(metrics));
  await page.locator('.context-row').getByText(/^覆盖/).click();
  await page.waitForTimeout(100);
  const bounds = await page.locator('.context-row .info-menu[open] .menu-items').evaluate(el => { const r=el.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}; });
  assert.ok(bounds.left >= 0 && bounds.right <= 390 && bounds.top >= 0 && bounds.bottom <= 844, JSON.stringify(bounds));
  await context.close();
});
