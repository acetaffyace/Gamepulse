// 端到端：用合成数据生成发布包，在无头 Chromium 里逐页检查。
//   node tests/web/e2e.cjs
// 页面上的数字和独立写的 SQL 算出来的结果比对；也检查导出、自助查询的规则拦截、深色模式、手机宽度与加载失败。

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { after, before, describe, test } = require('node:test');
const { chromium } = require('playwright');

const ROOT = join(__dirname, '..', '..');
const PORT = 8800 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}/`;
const PAGES = { overview: '运营总览', versions: '版本对比', videos: '视频传播', players: '玩家结构', explore: '自助查询', sources: '数据来源' };
let server;
let browser;

async function open(path, { viewport = { width: 1366, height: 900 }, colorScheme = 'light', route } = {}) {
  const context = await browser.newContext({ viewport, colorScheme, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  if (route) await route(page);
  await page.goto(BASE + path);
  return { page, errors, context };
}

async function ready(page) {
  await page.waitForFunction(() => window.gamepulse && document.querySelector('main h1'), null, { timeout: 30000 });
  await page.waitForTimeout(300);
}

const sql = (page, text, params = []) => page.evaluate(([t, p]) => window.gamepulse.rows(t, p), [text, params]);
const number = text => Number(String(text).replace(/[^\d.\-−]/g, '').replace('−', '-'));

before(async () => {
  const out = execFileSync('python', ['-m', 'tests.support.web_fixture', mkdtempSync(join(tmpdir(), 'gp-e2e-'))],
    { cwd: ROOT, encoding: 'utf-8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  const info = JSON.parse(out.trim().split('\n').pop());
  server = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '-d', info.dist], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1500));
  browser = await chromium.launch();
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
  const values = await page.locator('.tile .tile-value').allTextContents();
  assert.equal(number(values[0]), expected.n);
  assert.ok(Math.abs(number(values[2]) - expected.rate) < 0.006);
  assert.match(await page.textContent('.scope'), /共 14 天/);
  await context.close();
});

test('version comparison uses the same window for both versions and can swap', async () => {
  const { page, context } = await open('?page=versions&game=alpha&a=1.1&b=1.2&days=7');
  await ready(page);
  const counts = await sql(page, "SELECT version_id, COUNT(*) AS n FROM v_review WHERE game_id = 'alpha' "
    + "AND version_id IN ('1.1', '1.2') AND day_index BETWEEN 0 AND 6 GROUP BY version_id ORDER BY version_id");
  const firstTile = await page.locator('.tile').first().locator('.tile-value').allTextContents();
  assert.deepEqual(firstTile.map(number), counts.map(r => r.n));
  await page.getByRole('button', { name: '交换 A 和 B' }).click();
  await page.waitForFunction(() => new URLSearchParams(location.search).get('a') === '1.2');
  // 网址先变、页面随后重绘：等指标卡真正换过来再读
  await page.waitForFunction(first => document.querySelector('.tile .tile-value')?.textContent !== first, firstTile[0]);
  const swapped = await page.locator('.tile').first().locator('.tile-value').allTextContents();
  assert.deepEqual(swapped.map(number), counts.map(r => r.n).reverse());
  await context.close();
});

test('data table toggle and CSV export', async () => {
  const { page, context } = await open('?page=overview&game=beta');
  await ready(page);
  const card = page.locator('section.card').first();
  await card.getByRole('button', { name: '数据表' }).click();
  assert.ok(await card.locator('table.data tbody tr').count() > 5);
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
  await page.locator('.filters button.ghost').first().click();
  await page.waitForFunction(() => new URLSearchParams(location.search).get('s') === 'language');
  assert.equal(await page.locator('.error').count(), 0);
  assert.ok(await page.locator('.chart').count() >= 1);

  await page.goto(`${BASE}?page=explore&mode=sql`);
  await ready(page);
  assert.equal(await page.locator('.error').count(), 0, '默认示例 SQL 应该能直接运行');
  assert.ok(await page.locator('table.data tbody tr').count() > 0);
  await page.fill('textarea.sql', 'DELETE FROM game');
  await page.getByRole('button', { name: '运行' }).click();
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
  assert.match(await page.textContent('main'), /确认内容后点"运行"/);
  await page.getByRole('button', { name: '运行' }).click();
  await page.waitForSelector('.error');
  assert.match(await page.textContent('.error'), /不能修改数据/);
  // 就算绕过了文字检查，数据库本身也是只读的
  const error = await page.evaluate(() => { try { window.gamepulse.db.run('DELETE FROM version'); return ''; } catch (e) { return e.message; } });
  assert.match(error, /readonly|read-only|attempt to write/i);
  assert.ok((await sql(page, 'SELECT COUNT(*) AS n FROM version'))[0].n > 0);
  await context.close();
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

test('share button copies the current view', async () => {
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
  assert.match(await page.textContent('#data-status'), /项来源需要注意/);
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
