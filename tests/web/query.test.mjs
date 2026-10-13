// 浏览器端查询层：查询生成器的规则、分位数函数与 Python 端交叉核对、在真实（合成）发布库上执行。
// 用合成数据生成一份发布包，再用 sql.js 在 Node 里打开，和浏览器里跑的是同一套代码。

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { before, describe, test } from 'node:test';

import { QueryError, buildQuery, checkReadOnlySql, limitSql } from '../../web/lib/query.js';
import { quantile, registerQuantile } from '../../web/lib/quantile.js';
import { compareVersions, formatDelta, formatValue } from '../../web/lib/format.js';
import { Store } from '../../web/lib/data.js';
import { cadenceMetrics, periodMetrics, updateImpact } from '../../web/lib/version-analysis.js';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
let db;
let catalog;

function rows(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const out = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}
const run = spec => { const q = buildQuery(catalog, spec); return rows(q.sql, q.params); };

before(async () => {
  const out = execFileSync('python', ['-m', 'tests.support.web_fixture', join(tmpdir(), `gp-web-unit-${process.pid}`)],
    { cwd: ROOT, encoding: 'utf-8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  const info = JSON.parse(out.trim().split('\n').pop());
  // web/ 下是 ES 模块，vendor 里的 sql-wasm.js 是 UMD 脚本：按脚本执行，测的就是网页用的那一份文件
  const module = { exports: {} };
  new Function('module', 'exports', '__dirname', 'require', readFileSync(join(ROOT, 'web/vendor/sql-wasm.js'), 'utf-8'))(
    module, module.exports, join(ROOT, 'web/vendor'), (await import('node:module')).createRequire(import.meta.url));
  const initSqlJs = module.exports;
  const SQL = await initSqlJs({ locateFile: f => join(ROOT, 'web/vendor', f) });
  db = new SQL.Database(gunzipSync(readFileSync(info.database)));
  registerQuantile(db);
  catalog = JSON.parse(rows("SELECT value FROM app_config WHERE key = 'catalog'")[0].value);
});

describe('quantile', () => {
  const cases = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/quantile-cases.json'), 'utf-8'));
  test('pure function matches the shared cases', () => {
    for (const c of cases) {
      const got = quantile(c.values, c.p);
      if (c.expected === null) assert.equal(got, null, c.note);
      else assert.ok(Math.abs(got - c.expected) < 1e-9, `${c.note}: ${got}`);
    }
  });
  test('SQL aggregate matches the shared cases', () => {
    for (const c of cases) {
      const values = c.values.length ? c.values.map(v => (v === null ? 'NULL' : v)).map(v => `SELECT ${v} AS x`).join(' UNION ALL ')
        : 'SELECT NULL AS x WHERE 0';
      const got = rows(`SELECT quantile(x, ${c.p}) AS q FROM (${values})`)[0].q;
      if (c.expected === null) assert.equal(got, null, c.note);
      else assert.ok(Math.abs(got - c.expected) < 1e-9, `${c.note}: ${got}`);
    }
  });
});

describe('version update windows', () => {
  test('sample counts use their actual eligibility and keep absent mature rates null', () => {
    const records = rows("SELECT voted_up, playtime_at_review, post_review_minutes FROM v_review WHERE game_id='alpha' AND version_id='1.2'");
    const [computed] = run({ metrics: ['playtime_sample_count', 'rated_count', 'post_review_sample_count'],
      filters: [{ dim: 'game_id', op: 'eq', value: 'alpha' }, { dim: 'version_id', op: 'eq', value: '1.2' }] });
    assert.equal(computed.playtime_sample_count, records.filter(r => r.playtime_at_review !== null).length);
    assert.equal(computed.rated_count, records.filter(r => r.voted_up !== null).length);
    assert.equal(computed.post_review_sample_count, records.filter(r => r.post_review_minutes !== null).length);
    const [recent] = run({ metrics: ['post_review_sample_count', 'still_playing_share'],
      filters: [{ dim: 'game_id', op: 'eq', value: 'alpha' }, { dim: 'created_date', op: 'eq', value: '2026-09-19' }] });
    assert.equal(recent.post_review_sample_count, 0);
    assert.equal(recent.still_playing_share, null);
  });
  test('cadence metrics agree with hand-calculated dates and use the shared catalog', () => {
    const store = new Store(db, {});
    const all = cadenceMetrics(store, 'alpha', store.versions('alpha'));
    assert.equal(all.version_count, 3);
    assert.equal(all.version_interval_count, 2);
    assert.equal(all.avg_version_interval, 30.5); // 6/1→7/1 = 30，7/1→8/1 = 31
    const latest = cadenceMetrics(store, 'alpha', store.versions('alpha').slice(-1));
    assert.equal(latest.avg_version_interval, 31, '筛选最后一版仍引用完整历史中的前版');
    assert.equal(cadenceMetrics(store, 'beta', store.versions('beta')).avg_version_interval, 35);
  });
  test('before and after values agree with independent review records', () => {
    const store = new Store(db, {});
    const v = store.versions('alpha').find(v => v.version_id === '1.1');
    const impact = updateImpact(store, v);
    assert.equal(impact.complete, true);
    assert.equal(impact.from, '2026-06-24');
    assert.equal(impact.afterEnd, '2026-07-07');
    for (const [period, from, to] of [[impact.before, '2026-06-24', '2026-06-30'], [impact.after, '2026-07-01', '2026-07-07']]) {
      const records = rows('SELECT voted_up, playtime_at_review FROM v_review WHERE game_id = ? AND created_date BETWEEN ? AND ?', ['alpha', from, to]);
      const known = records.filter(r => r.voted_up !== null);
      const rate = 100 * known.filter(r => r.voted_up === 1).length / known.length;
      const times = records.map(r => r.playtime_at_review).filter(v => v !== null).sort((a, b) => a - b);
      const mid = Math.floor(times.length / 2);
      const median = (times.length % 2 ? times[mid] : (times[mid - 1] + times[mid]) / 2) / 60;
      assert.equal(period.daily_reviews, records.length);
      assert.ok(Math.abs(period.daily_positive_rate - rate) < 1e-9);
      assert.ok(Math.abs(period.playtime_median_h - median) < 1e-9);
      assert.equal(period.review_days, 7);
    }
  });
  test('release without a before-window and closely spaced updates are not comparable', () => {
    const store = new Store(db, {});
    assert.equal(updateImpact(store, store.versions('alpha')[0]).complete, false);
    const original = store.versions.bind(store);
    store.versions = game => [...original(game), { game_id: game, version_id: 'extra', start_date: '2026-07-04' }];
    const impact = updateImpact(store, original('alpha').find(v => v.version_id === '1.1'));
    assert.equal(impact.complete, false);
    assert.equal(impact.otherUpdates[0].version_id, 'extra');
  });
  test('playtime excludes the incomplete backfill date just like daily review metrics', () => {
    const store = new Store(db, {});
    const complete = periodMetrics(store, 'alpha', '2026-09-15', '2026-09-19');
    const withIncomplete = periodMetrics(store, 'alpha', '2026-09-15', '2026-09-20');
    assert.equal(withIncomplete.review_days, complete.review_days);
    assert.equal(withIncomplete.playtime_median_h, complete.playtime_median_h);
    store.reviewAnchor = () => null;
    assert.equal(periodMetrics(store, 'alpha', '2026-09-15', '2026-09-20').playtime_median_h, null);
  });
});

describe('buildQuery rules', () => {
  test('metrics from different facts cannot be mixed', () => {
    assert.throws(() => buildQuery(catalog, { metrics: ['review_count', 'avg_players'], dims: ['game_id'] }), QueryError);
  });
  test('dimension outside the fact is rejected', () => {
    assert.throws(() => buildQuery(catalog, { metrics: ['avg_players'], dims: ['language'] }), /不能按「评测语种」拆分/);
  });
  test('views cannot be summed across locales', () => {
    assert.throws(() => buildQuery(catalog, { metrics: ['latest_views'], dims: ['content_type'] }), /必须按「频道语区」分开看/);
    assert.doesNotThrow(() => buildQuery(catalog, { metrics: ['latest_views'], dims: ['locale', 'content_type'] }));
    // 筛选成单个语区也可以
    assert.doesNotThrow(() => buildQuery(catalog, { metrics: ['latest_views'], dims: ['content_type'],
      filters: [{ dim: 'locale', op: 'eq', value: 'ja' }] }));
    assert.throws(() => buildQuery(catalog, { metrics: ['latest_views'], dims: ['content_type'],
      filters: [{ dim: 'locale', op: 'in', value: ['ja', 'ko'] }] }), QueryError);
  });
  test('cumulative views need a date or an age, per video', () => {
    assert.throws(() => buildQuery(catalog, { metrics: ['video_views'], dims: ['locale', 'video_id'] }), /「日期」 或 「发布后第几天」/);
    // 审核 1：多支视频的累计值按日期相加，会把"多追踪了几支视频"画成增长
    assert.throws(() => buildQuery(catalog, { metrics: ['video_views'], dims: ['locale', 'date'] }), /必须按「视频」分开看/);
    assert.doesNotThrow(() => buildQuery(catalog, { metrics: ['video_views'], dims: ['locale', 'video_id', 'days_since_pub'] }));
  });
  test('values are bound as parameters, never spliced into SQL', () => {
    const evil = "x'); DROP TABLE game; --";
    const q = buildQuery(catalog, { metrics: ['review_count'], dims: ['language'], filters: [{ dim: 'game_id', op: 'eq', value: evil }] });
    assert.ok(!q.sql.includes('DROP'));
    assert.deepEqual(q.params, [evil]);
  });
  test('default filters apply unless disabled', () => {
    const on = buildQuery(catalog, { metrics: ['latest_views'], dims: ['locale'] });
    assert.ok(on.sql.includes('"curated" = ?'));
    const off = buildQuery(catalog, { metrics: ['latest_views'], dims: ['locale'], useDefaultFilters: false });
    assert.ok(!off.sql.includes('curated'));
  });
  test('order keys and limits are validated', () => {
    assert.throws(() => buildQuery(catalog, { metrics: ['review_count'], dims: ['language'], order: [{ key: 'nope' }] }), QueryError);
    assert.throws(() => buildQuery(catalog, { metrics: ['review_count'], dims: ['language'], limit: 0 }), QueryError);
  });
  test('read-only SQL guard', () => {
    assert.equal(checkReadOnlySql(' select 1; '), 'select 1');
    assert.throws(() => checkReadOnlySql('DELETE FROM game'), QueryError);
    assert.throws(() => checkReadOnlySql('SELECT 1; SELECT 2'), QueryError);
    const commented = '-- 说明\n/* 块注释 */\nSELECT 1';
    assert.equal(checkReadOnlySql(commented), commented);
    assert.throws(() => checkReadOnlySql('-- 说明\nDROP TABLE game'), QueryError);
    // 审核 3：WITH 后面可以跟写语句
    assert.throws(() => checkReadOnlySql('WITH x AS (SELECT 1) DELETE FROM game'), /不能修改数据/);
    // 审核 15：字符串和注释里的分号不是语句分隔
    assert.doesNotThrow(() => checkReadOnlySql("SELECT ';'"));
    assert.doesNotThrow(() => checkReadOnlySql('SELECT 1 /* ; */'));
    assert.doesNotThrow(() => checkReadOnlySql('SELECT 1; -- note'));
    assert.doesNotThrow(() => checkReadOnlySql("SELECT replace(title, 'a', 'b'), created_date FROM v_video"));
  });
});

describe('buildQuery results on the fixture database', () => {
  test('daily totals equal the review rows', () => {
    const viaDaily = run({ metrics: ['daily_reviews'], dims: ['game_id'], useDefaultFilters: false });
    const viaRows = run({ metrics: ['review_count'], dims: ['game_id'] });
    assert.deepEqual(viaDaily.map(r => [r.game_id, r.daily_reviews]), viaRows.map(r => [r.game_id, r.review_count]));
  });
  test('positive rate is pooled, not an average of daily rates', () => {
    const [pooled] = run({ metrics: ['daily_positive_rate'], filters: [{ dim: 'game_id', op: 'eq', value: 'alpha' }] });
    const raw = rows("SELECT 100.0 * SUM(positive) / (SUM(positive) + SUM(negative)) AS r FROM v_review_daily WHERE game_id = 'alpha' AND complete_day = 1")[0];
    assert.ok(Math.abs(pooled.daily_positive_rate - raw.r) < 1e-9);
  });
  test('shares add up to 100 within each group', () => {
    const shares = run({ metrics: ['review_share'], dims: ['version_id', 'playtime_band'],
      filters: [{ dim: 'game_id', op: 'eq', value: 'alpha' }, { dim: 'playtime_band', op: 'notnull' }], shareDim: 'playtime_band' });
    const byVersion = {};
    for (const r of shares) byVersion[r.version_id] = (byVersion[r.version_id] || 0) + r.review_share;
    for (const total of Object.values(byVersion)) assert.ok(Math.abs(total - 100) < 1e-6);
  });
  test('median equals an independent computation', () => {
    const [m] = run({ metrics: ['playtime_median_h'], filters: [{ dim: 'game_id', op: 'eq', value: 'beta' }] });
    const values = rows("SELECT playtime_at_review AS p FROM v_review WHERE game_id = 'beta' AND playtime_at_review IS NOT NULL ORDER BY 1").map(r => r.p);
    const mid = values.length % 2 ? values[(values.length - 1) / 2] : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;
    assert.ok(Math.abs(m.playtime_median_h - mid / 60) < 1e-9);
  });
  test('video engagement uses the platform formula', () => {
    const got = run({ metrics: ['latest_engagement'], dims: ['locale'], filters: [{ dim: 'game_id', op: 'eq', value: 'alpha' }] });
    const bili = rows("SELECT 100.0 * SUM(likes + coins + favorites) / SUM(views) AS e FROM v_video_latest WHERE game_id = 'alpha' AND locale = 'zh-cn' AND curated = 1")[0].e;
    const yt = rows("SELECT 100.0 * SUM(likes + comments) / SUM(views) AS e FROM v_video_latest WHERE game_id = 'alpha' AND locale = 'global' AND curated = 1")[0].e;
    assert.ok(Math.abs(got.find(r => r.locale === 'zh-cn').latest_engagement - bili) < 1e-9);
    assert.ok(Math.abs(got.find(r => r.locale === 'global').latest_engagement - yt) < 1e-9);
  });
  test('daily reviews exclude the incomplete last day by default', () => {
    const [withDefault] = run({ metrics: ['review_days'], filters: [{ dim: 'game_id', op: 'eq', value: 'alpha' }] });
    const [all] = run({ metrics: ['review_days'], filters: [{ dim: 'game_id', op: 'eq', value: 'alpha' }], useDefaultFilters: false });
    assert.equal(all.review_days - withDefault.review_days, 1);
  });
  test('the page opens the database read-only', () => {
    db.run('PRAGMA query_only = 1');
    assert.throws(() => db.run('DELETE FROM game'), /readonly|read-only|attempt to write/i);
    assert.throws(() => db.run('WITH x AS (SELECT 1) UPDATE v_review_daily SET reviews = 0'), /readonly|read-only|attempt to write/i);
    assert.equal(rows('SELECT COUNT(*) AS n FROM game')[0].n, 2);
  });
  test('row limit stops an endless recursive query', () => {
    const got = rows(limitSql('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c', 10));
    assert.equal(got.length, 10);
  });
  test('every catalog metric runs', () => {
    for (const [id, m] of Object.entries(catalog.metrics)) {
      const fact = catalog.facts[m.fact];
      const dims = [...new Set(['game_id', ...(m.must_group_by || []), ...((m.must_group_by_one_of || [])[0] || [])])];
      const spec = { metrics: [id], dims: m.kind === 'share' ? [...dims, fact.dimensions.find(d => !dims.includes(d))] : dims };
      assert.doesNotThrow(() => run(spec), id);
    }
  });
});

describe('format', () => {
  test('deltas use points for rates and percent otherwise, with no good/bad colouring', () => {
    assert.equal(formatDelta({ format: 'percent' }, 81.42, 83.66), '−2.24 个百分点');
    assert.equal(formatDelta({ format: 'integer' }, 1017, 1475), '−31.1%');
    assert.equal(formatDelta({ format: 'integer' }, 5, 0), null);
  });
  test('missing values are a dash, not zero', () => {
    assert.equal(formatValue(null, 'integer'), '—');
    assert.equal(formatValue(0, 'integer'), '0');
  });
  test('versions sort numerically', () => {
    assert.deepEqual(['3.10', '3.2', '2.8'].sort(compareVersions), ['2.8', '3.2', '3.10']);
  });
});
