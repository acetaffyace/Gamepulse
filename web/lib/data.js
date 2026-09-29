// 数据访问：读 manifest → 下载并解压数据库 → 在浏览器里用 SQL 查询。
// 页面只通过 store.query(spec)（指标目录 + 查询生成器）取指标，保证同一个数字在哪里看都一样。

import { buildQuery } from './query.js';
import { registerQuantile } from './quantile.js';

export class LoadError extends Error {}

export async function loadManifest() {
  const res = await fetch('data/manifest.json', { cache: 'no-store' });
  if (!res.ok) throw new LoadError(`找不到数据目录（data/manifest.json 返回 ${res.status}）`);
  return res.json();
}

async function download(url, expectedBytes, onProgress) {
  const res = await fetch(url);   // 文件名带内容哈希，可以放心使用浏览器缓存
  if (!res.ok) throw new LoadError(`数据库下载失败（${res.status}）`);
  if (typeof DecompressionStream === 'undefined') {
    throw new LoadError('这个浏览器不支持解压数据库，请使用较新版本的 Chrome、Edge、Firefox 或 Safari');
  }
  let received = 0;
  const counted = res.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength;
      onProgress?.(Math.min(1, received / expectedBytes));
      controller.enqueue(chunk);
    },
  }));
  const raw = await new Response(counted.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return new Uint8Array(raw);
}

export async function openStore(manifest, onProgress) {
  if (typeof initSqlJs !== 'function') throw new LoadError('查询引擎（sql.js）没有加载成功');
  const [SQL, bytes] = await Promise.all([
    initSqlJs({ locateFile: file => `vendor/${file}` }),
    download(`data/${manifest.database.file}`, manifest.database.gzip_bytes, onProgress),
  ]);
  const db = new SQL.Database(bytes);
  // 页面从不写数据库。打开后立即设为只读：自助查询里任何写语句（包括 WITH … DELETE）都会被 SQLite 本身拒绝
  db.run('PRAGMA query_only = 1');
  registerQuantile(db);
  const store = new Store(db, manifest);
  const build = JSON.parse(store.scalar("SELECT value FROM app_config WHERE key = 'build'"));
  if (build.build_id !== manifest.build_id) {
    throw new LoadError('数据库与数据目录不是同一次发布，请刷新页面');
  }
  return store;
}

export class Store {
  constructor(db, manifest) {
    this.db = db;
    this.manifest = manifest;
    this.catalog = JSON.parse(this.scalar("SELECT value FROM app_config WHERE key = 'catalog'"));
    this.games = this.rows('SELECT game_id, display_name, short_name, developer, color, steam_release FROM game '
      + 'WHERE active = 1 ORDER BY rowid');
    this.gameById = Object.fromEntries(this.games.map(g => [g.game_id, g]));
    this.versionRows = this.rows('SELECT * FROM v_version_window ORDER BY game_id, seq');
  }

  rows(sql, params = []) {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const out = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      return out;
    } finally {
      stmt.free();
    }
  }

  scalar(sql, params = []) {
    const row = this.rows(sql, params)[0];
    return row ? Object.values(row)[0] : undefined;
  }

  // 自助查询的"直接写 SQL"：返回列名与原始值
  raw(sql) {
    const result = this.db.exec(sql);
    if (!result.length) return { columns: [], values: [] };
    return result[result.length - 1];
  }

  query(spec) {
    const built = buildQuery(this.catalog, spec);
    const started = performance.now();
    const rows = this.rows(built.sql, built.params);
    const ms = performance.now() - started;
    if (ms > 400) console.warn(`慢查询 ${ms.toFixed(0)} ms`, built.sql);
    return { ...built, rows, ms };
  }

  versions(gameId) {
    return this.versionRows.filter(v => v.game_id === gameId);
  }

  // 每日评测最后一个完整日（最后一次回填当天只统计到运行时刻，不算完整日）
  reviewAnchor(gameId) {
    return this.scalar('SELECT MAX(date) FROM v_review_daily WHERE game_id = ? AND complete_day = 1', [gameId]);
  }

  lastDate(view, gameId, column = 'date') {
    return this.scalar(`SELECT MAX(${column}) FROM ${view} WHERE game_id = ?`, [gameId]);
  }

  distinct(view, column, where = '1', params = []) {
    return this.rows(`SELECT DISTINCT ${column} AS v FROM ${view} WHERE ${where} AND ${column} IS NOT NULL ORDER BY 1`, params)
      .map(r => r.v);
  }
}
