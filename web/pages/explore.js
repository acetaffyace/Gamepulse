// 自助查询：选数据表 → 指标 → 横轴与拆分维度 → 筛选，现场生成 SQL 在浏览器里执行。
// 和固定看板用同一份指标目录与查询生成器，所以这里查出来的数和看板上的数一定一致。
// 目录里的规则（例如播放量不能跨语区相加）在生成 SQL 时强制执行，违反时给出原因而不是给出一个错数。

import { addDays, compareVersions, compact, daysBetween, dimLabel, formatValue, shortDate } from '../lib/format.js';
import { colorByOrder, ordinal, otherColor, slot, themed } from '../lib/palette.js';
import { QueryError, checkReadOnlySql, limitSql } from '../lib/query.js';
import { chartCard, chips, download, el, select, tableCard } from '../lib/ui.js';
import { header } from './shared.js';

const MAX_SERIES = 8;
const CHART_TYPES = [{ value: 'auto', label: '自动' }, { value: 'line', label: '折线' }, { value: 'bar', label: '柱状' },
                     { value: 'stacked', label: '堆叠柱' }, { value: 'table', label: '只看表格' }];

// 示例查询按当前数据生成（第一款游戏、它最近的两个版本），游戏或版本变化后仍然可用
export function presets(store) {
  const game = store.games[0];
  const versions = store.versions(game.game_id).map(v => v.version_id).sort(compareVersions);
  const lastTwo = versions.slice(-2);
  const out = [
    { label: `${game.display_name}各版本前 14 天 · 按语种拆分评测数`,
      params: { fact: 'review', m: 'review_count', x: 'version_id', s: 'language', games: game.game_id, d0: 0, d1: 13, chart: 'stacked' } },
    { label: '各游戏 · 每周好评率', params: { fact: 'review_daily', m: 'daily_positive_rate', x: 'week_start', s: 'game_id' } },
    { label: '各版本窗口 · 评测时长中位数与好评率',
      params: { fact: 'review', m: 'playtime_median_h,positive_rate', x: 'version_id', s: 'game_id' } },
    { label: 'YouTube 各语区 · 最新互动率（按内容类型）',
      params: { fact: 'video_latest', m: 'latest_engagement', x: 'content_type', s: 'locale', locales: 'global,ja,ko,zh-tw' } },
  ];
  if (lastTwo.length === 2) {
    out.splice(1, 0, { label: `${game.display_name} ${lastTwo[0]} 与 ${lastTwo[1]} · 更新后每日评测数`,
      params: { fact: 'review_daily', m: 'daily_reviews', x: 'day_index', s: 'version_id', games: game.game_id,
                versions: lastTwo.join(','), d0: 0, d1: 29 } });
  }
  return out;
}

const list = v => (v ? v.split(',').filter(Boolean) : []);

export function render({ store, root, params, set }) {
  const cat = store.catalog;
  root.append(...header('自助查询', '选择指标、维度和筛选条件，现场在浏览器里计算。口径与看板完全相同。'));
  const mode = params.get('mode') === 'sql' ? 'sql' : 'builder';
  root.append(el('div', { class: 'filters' },
    el('div', { class: 'segmented', role: 'group', 'aria-label': '查询方式' },
      el('button', { type: 'button', 'aria-pressed': String(mode === 'builder'), onclick: () => set({ mode: null }) }, '选择指标'),
      el('button', { type: 'button', 'aria-pressed': String(mode === 'sql'), onclick: () => set({ mode: 'sql' }) }, '直接写 SQL')),
    el('span', { class: 'note' }, '示例：'),
    ...presets(store).map(p => el('button', { type: 'button', class: 'ghost', onclick: () => set(presetParams(p.params)) }, p.label))));
  if (mode === 'sql') {
    sqlMode(store, root, params, set);
    return;
  }

  const factId = cat.facts[params.get('fact')] ? params.get('fact') : 'review_daily';
  const fact = cat.facts[factId];
  const factMetrics = Object.entries(cat.metrics).filter(([, m]) => m.fact === factId).map(([id]) => id);
  const metrics = list(params.get('m')).filter(id => factMetrics.includes(id));
  const chosen = metrics.length ? metrics : [factMetrics[0]];
  const dims = fact.dimensions;
  const x = dims.includes(params.get('x')) ? params.get('x') : fact.date_dimension;
  const s = dims.includes(params.get('s')) && params.get('s') !== x ? params.get('s') : '';
  const games = list(params.get('games')).filter(g => store.gameById[g]);
  const gameIds = games.length ? games : store.games.map(g => g.game_id);
  const chartType = CHART_TYPES.some(c => c.value === params.get('chart')) ? params.get('chart') : 'auto';

  const panel = el('div', { class: 'panel' });
  const output = el('div', {});
  root.append(el('div', { class: 'explore' }, panel, output));

  panel.append(
    el('fieldset', {}, el('legend', {}, '1. 数据表'),
      select('', Object.entries(cat.facts).map(([id, f]) => ({ value: id, label: `${f.label}（一行 = ${f.grain}）` })), factId,
        v => set({ fact: v, m: null, x: null, s: null })),
      el('p', { class: 'note' }, fact.note)),
    el('fieldset', {}, el('legend', {}, '2. 指标'),
      ...factMetrics.map(id => {
        const m = cat.metrics[id];
        const box = el('input', { type: 'checkbox', checked: chosen.includes(id), onchange: e => {
          const next = e.target.checked ? [...chosen, id] : chosen.filter(v => v !== id);
          if (next.length) set({ m: next });
          else e.target.checked = true;
        } });
        return el('label', { class: 'option' }, box, el('span', {}, `${m.label}（${m.unit}）`, m.note ? el('small', {}, m.note) : null));
      })),
    el('fieldset', {}, el('legend', {}, '3. 维度'),
      select('横轴', dims.map(d => ({ value: d, label: cat.dimensions[d].label })), x, v => set({ x: v })),
      select('拆分为多条', [{ value: '', label: '不拆分' }, ...dims.filter(d => d !== x).map(d => ({ value: d, label: cat.dimensions[d].label }))],
        s, v => set({ s: v })),
      select('图表', CHART_TYPES, chartType, v => set({ chart: v === 'auto' ? null : v }))),
    filterFields(store, fact, params, set, gameIds),
  );

  let result;
  try {
    const spec = { metrics: chosen, dims: s ? [x, s] : [x], filters: buildFilters(store, fact, params, gameIds),
                   useDefaultFilters: params.get('nodefault') !== '1', shareDim: s || x };
    result = store.query(spec);
  } catch (err) {
    if (!(err instanceof QueryError)) throw err;
    output.append(el('div', { class: 'error', role: 'alert' }, err.message));
    return;
  }
  showResult(store, output, result, { x, s, chosen, chartType, factId });
}

function presetParams(p) {
  const clear = { fact: null, m: null, x: null, s: null, games: null, versions: null, from: null, to: null, d0: null, d1: null,
                  locales: null, types: null, chart: null, nodefault: null, mode: null, sql: null };
  return { ...clear, ...p };
}

function filterFields(store, fact, params, set, gameIds) {
  const cat = store.catalog;
  const has = d => fact.dimensions.includes(d);
  const box = el('fieldset', {}, el('legend', {}, '4. 筛选'));
  box.append(chips('游戏', store.games.map(g => ({ value: g.game_id, label: g.display_name, color: themed(g.color) })), gameIds,
    v => set({ games: v.length === store.games.length ? null : v, versions: null })));
  if (has('version_id')) {
    const versions = [...new Set(store.versionRows.filter(v => gameIds.includes(v.game_id)).map(v => v.version_id))].sort(compareVersions);
    const picked = list(params.get('versions'));
    box.append(chips('版本', versions.map(v => ({ value: v, label: v })), picked.length ? picked : versions,
      v => set({ versions: v.length === versions.length ? null : v })));
  }
  const dateDim = fact.date_dimension;
  const dateLabel = cat.dimensions[dateDim].label;
  box.append(el('div', { class: 'field' }, el('span', { class: 'field-label' }, `${dateLabel}从`),
    el('input', { type: 'date', 'aria-label': `${dateLabel}起始`, value: params.get('from') || '', onchange: e => set({ from: e.target.value }) }), '到',
    el('input', { type: 'date', 'aria-label': `${dateLabel}结束`, value: params.get('to') || '', onchange: e => set({ to: e.target.value }) })));
  const range = has('day_index') ? 'day_index' : has('days_since_pub') ? 'days_since_pub' : null;
  if (range) {
    const rangeLabel = cat.dimensions[range].label;
    box.append(el('div', { class: 'field' }, el('span', { class: 'field-label' }, `${rangeLabel}从`),
      el('input', { type: 'number', step: 1, 'aria-label': `${rangeLabel}起始`, style: { width: '70px' }, value: params.get('d0') ?? '', onchange: e => set({ d0: e.target.value }) }), '到',
      el('input', { type: 'number', step: 1, 'aria-label': `${rangeLabel}结束`, style: { width: '70px' }, value: params.get('d1') ?? '', onchange: e => set({ d1: e.target.value }) })));
  }
  if (has('locale')) {
    const order = cat.dimensions.locale.order;
    const picked = list(params.get('locales'));
    box.append(chips('频道语区', order.map(l => ({ value: l, label: dimLabel(cat, store, 'locale', l), color: colorByOrder(order, l) })),
      picked.length ? picked : order, v => set({ locales: v.length === order.length ? null : v })));
  }
  if (has('content_type')) {
    const types = Object.keys(cat.dimensions.content_type.values);
    const picked = list(params.get('types'));
    box.append(chips('内容类型', types.map(t => ({ value: t, label: dimLabel(cat, store, 'content_type', t) })),
      picked.length ? picked : types, v => set({ types: v.length === types.length ? null : v })));
  }
  const defaults = Object.keys(fact.default_filters || {});
  if (defaults.length) {
    const text = defaults.map(d => ({ curated: '包含精选范围以外的登记视频', complete_day: '包含最后一次回填当天（只统计到运行时刻，不完整）' }[d] || d));
    box.append(el('label', { class: 'option' }, el('input', { type: 'checkbox', checked: params.get('nodefault') === '1',
      onchange: e => set({ nodefault: e.target.checked ? '1' : null }) }), el('span', {}, text.join('；'))));
  }
  return box;
}

function buildFilters(store, fact, params, gameIds) {
  const has = d => fact.dimensions.includes(d);
  const out = [];
  const from = params.get('from');
  const to = params.get('to');
  if (from && to && from > to) throw new QueryError(`起始日期 ${from} 晚于结束日期 ${to}`);
  for (const key of ['d0', 'd1']) {
    const v = params.get(key);
    if (v !== null && v !== '' && !Number.isInteger(Number(v))) throw new QueryError(`天数必须是整数：${v}`);
  }
  if (params.get('d0') && params.get('d1') && Number(params.get('d0')) > Number(params.get('d1'))) {
    throw new QueryError('起始天数大于结束天数');
  }
  if (gameIds.length < store.games.length) out.push({ dim: 'game_id', op: 'in', value: gameIds });
  if (has('version_id') && list(params.get('versions')).length) out.push({ dim: 'version_id', op: 'in', value: list(params.get('versions')) });
  const dateDim = fact.date_dimension;
  if (params.get('from')) out.push({ dim: dateDim, op: 'gte', value: params.get('from') });
  if (params.get('to')) out.push({ dim: dateDim, op: 'lte', value: params.get('to') });
  const range = has('day_index') ? 'day_index' : has('days_since_pub') ? 'days_since_pub' : null;
  if (range && params.get('d0') !== null && params.get('d0') !== '') out.push({ dim: range, op: 'gte', value: Number(params.get('d0')) });
  if (range && params.get('d1') !== null && params.get('d1') !== '') out.push({ dim: range, op: 'lte', value: Number(params.get('d1')) });
  if (has('locale') && list(params.get('locales')).length) out.push({ dim: 'locale', op: 'in', value: list(params.get('locales')) });
  if (has('content_type') && list(params.get('types')).length) out.push({ dim: 'content_type', op: 'in', value: list(params.get('types')) });
  return out;
}

function seriesColor(store, dim, value, index) {
  const cat = store.catalog;
  if (dim === 'game_id') return themed(store.gameById[value]?.color || '#2a78d6');
  if (dim === 'locale') return colorByOrder(cat.dimensions.locale.order, value);
  if (dim === 'playtime_band') return ordinal(cat.dimensions.playtime_band.order, value);
  return slot(index);
}

function showResult(store, output, result, { x, s, chosen, chartType, factId }) {
  const cat = store.catalog;
  const rows = result.rows;
  const label = (dim, v) => dimLabel(cat, store, dim, v);
  const sortX = (a, b) => (x === 'version_id' ? compareVersions(a, b) : (a > b) - (a < b));
  const xs = fillAxis(cat.dimensions[x].type, [...new Set(rows.map(r => r[x]))].sort(sortX));
  const index = new Map(rows.map(r => [`${r[x]}\u0000${s ? r[s] : ''}`, r]));
  const type = chartType === 'auto'
    ? (['date', 'integer'].includes(cat.dimensions[x].type) ? 'line' : 'bar') : chartType;

  output.append(el('p', { class: 'scope' }, `${rows.length} 行 · 查询耗时 ${result.ms.toFixed(0)} ms`,
    result.filters.some(f => f.dim === 'curated') ? ' · 只含精选范围内的视频' : ''));
  if (!rows.length) {
    output.append(el('div', { class: 'empty' }, '没有符合条件的数据。可以放宽筛选条件。'));
  } else if (type !== 'table') {
    for (const id of chosen) {
      const m = cat.metrics[id];
      if (type === 'stacked' && !additive(m)) {
        output.append(el('div', { class: 'error', role: 'alert' },
          `「${m.label}」是比率或分位数，不同类别的值不能相加，不能画成堆叠图。请改用折线或柱状。`));
        continue;
      }
      let groups = s ? [...new Set(rows.map(r => r[s]))] : [null];
      let note = '';
      let rest = [];
      if (groups.length > MAX_SERIES) {
        const totals = new Map(groups.map(g => [g, rows.filter(r => r[s] === g).reduce((t, r) => t + Math.abs(r[id] || 0), 0)]));
        groups = groups.sort((a, b) => totals.get(b) - totals.get(a));
        rest = groups.slice(MAX_SERIES - 1);
        groups = groups.slice(0, MAX_SERIES - 1);
        note = additive(m)
          ? `拆分出的类别超过 ${MAX_SERIES} 个，其余 ${rest.length} 个合并为"其他"，完整结果见数据表。`
          : `拆分出的类别超过 ${MAX_SERIES} 个，图中只画数值最大的 ${groups.length} 个（这个指标不能相加，不合并为"其他"），完整结果见数据表。`;
      }
      if (s === 'version_id') groups.sort(compareVersions);
      const value = (v, g) => index.get(`${v}\u0000${s ? g : ''}`)?.[id] ?? null;
      const series = groups.map((g, i) => ({
        name: s ? label(s, g) : m.label, color: s ? seriesColor(store, s, g, i) : slot(0), data: xs.map(v => value(v, g)) }));
      if (rest.length && additive(m)) {
        series.push({ name: '其他', color: otherColor(), data: xs.map(v => rest.reduce((t, g) => t + (value(v, g) || 0), 0)) });
      }
      const fmt = v => (m.format === 'integer' && Math.abs(v) >= 1e4 ? compact(v) : formatValue(v, m.format));
      output.append(chartCard({ title: `${m.label}（${m.unit}）`, sub: `按「${cat.dimensions[x].label}」${s ? `，拆分为「${cat.dimensions[s].label}」` : ''}`,
        caveat: [m.note, note, gapNote(cat.dimensions[x].type, xs, rows, x)].filter(Boolean).join(' '),
        filename: `gamepulse-${factId}-${id}`,
        chart: { type: type === 'stacked' ? 'stacked' : type, x: xs.map(v => label(x, v)),
                 xFormat: cat.dimensions[x].type === 'date' ? shortDate : undefined, series, format: fmt,
                 axisFormat: v => (m.format === 'percent' ? `${v}%` : compact(v)), fitY: type === 'line', percent: m.format === 'percent',
                 noEndLabels: series.length > 4 },
        columns: resultColumns(store, result), rows }));
    }
  }
  if (type === 'table' || rows.length) {
    output.append(tableCard({ title: '查询结果', filename: `gamepulse-${factId}`, columns: resultColumns(store, result), rows }));
  }
  const sqlText = formatSql(result.sql, result.params);
  output.append(el('section', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', {}, '生成的 SQL'),
    el('div', { class: 'card-actions' }, el('button', { type: 'button', onclick: () => navigator.clipboard?.writeText(sqlText) }, '复制'))),
    el('pre', { class: 'sql' }, sqlText),
    el('p', { class: 'note' }, 'quantile(x, p) 是本项目注册的分位数函数（线性插值，p = 0.5 为中位数）。可以复制到"直接写 SQL"里修改。')));
}

// 日期、整数横轴补齐中间缺的值：缺采的日子留空，而不是被直接跳过、让折线直接连过去
function fillAxis(type, xs) {
  if (xs.length < 2 || !['date', 'integer'].includes(type)) return xs;
  const [first, last] = [xs[0], xs[xs.length - 1]];
  const span = type === 'date' ? daysBetween(first, last) : last - first;
  if (span > 3000) return xs;
  return Array.from({ length: span + 1 }, (_, i) => (type === 'date' ? addDays(first, i) : first + i));
}

function gapNote(type, xs, rows, x) {
  if (!['date', 'integer'].includes(type)) return '';
  const have = new Set(rows.map(r => r[x]));
  const missing = xs.filter(v => !have.has(v)).length;
  return missing ? `其中 ${missing} 个${type === 'date' ? '日期' : '位置'}没有数据，图上留空。` : '';
}

// 可以把若干类别加总成"其他"的指标：计数、求和、占比。比率和分位数不能相加。
function additive(metric) {
  if (metric.kind === 'share') return true;
  return /^(COUNT|SUM)\(/.test(metric.agg.trim()) && !metric.agg.includes('/');
}

function resultColumns(store, result) {
  return result.columns.map(c => (c.kind === 'dimension'
    ? { key: c.key, label: c.label, format: v => dimLabel(store.catalog, store, c.key, v), csv: v => v }
    : { key: c.key, label: `${c.label}（${c.unit}）`, num: true, format: v => formatValue(v, c.format) }));
}

function formatSql(sql, params) {
  let i = 0;
  const inlined = sql.replace(/\?/g, () => {
    const v = params[i++];
    return typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
  });
  return inlined.replace(/ (FROM|WHERE|GROUP BY|ORDER BY|LIMIT) /g, '\n$1 ');
}

const SQL_ROW_LIMIT = 5000;
const SQL_EXAMPLE = `-- 各游戏各版本：评测数、好评率、写评测时时长中位数（小时）
SELECT game_id, version_id, COUNT(*) AS reviews,
       ROUND(100.0 * SUM(voted_up = 1) / SUM(voted_up IS NOT NULL), 2) AS positive_rate,
       ROUND(quantile(playtime_at_review, 0.5) / 60.0, 1) AS median_hours
FROM v_review
WHERE version_id IS NOT NULL
GROUP BY game_id, version_id
ORDER BY game_id, MIN(created_date)`;

function sqlMode(store, root, params, set) {
  const fromLink = params.get('sql');
  const text = fromLink || SQL_EXAMPLE;
  const area = el('textarea', { class: 'sql', spellcheck: 'false', 'aria-label': 'SQL 查询' });
  area.value = text;
  const out = el('div', {});
  const run = () => {
    out.replaceChildren();
    let result;
    const started = performance.now();
    try {
      result = store.raw(limitSql(checkReadOnlySql(area.value), SQL_ROW_LIMIT + 1));
    } catch (err) {
      out.append(el('div', { class: 'error', role: 'alert' }, err.message));
      return;
    }
    const columns = result.columns.map(c => ({ key: c, label: c, num: false }));
    const truncated = result.values.length > SQL_ROW_LIMIT;
    const rows = result.values.slice(0, SQL_ROW_LIMIT).map(v => Object.fromEntries(result.columns.map((c, i) => [c, v[i]])));
    out.append(el('p', { class: 'scope' }, `${rows.length} 行 · ${(performance.now() - started).toFixed(0)} ms`,
      truncated ? ` · 超过 ${SQL_ROW_LIMIT} 行，只取前 ${SQL_ROW_LIMIT} 行` : ''),
      tableCard({ title: '查询结果', filename: 'gamepulse-sql', columns, rows }));
  };
  const views = store.rows("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name");
  root.append(el('div', { class: 'explore' },
    el('div', { class: 'panel' }, el('h2', {}, '可以查询的表和视图'),
      el('p', { class: 'note' }, '以 v_ 开头的是口径视图，看板上的数字都从它们算出。点名字可以看列。'),
      el('ul', {}, views.map(v => el('li', {}, el('button', { type: 'button', class: 'ghost', onclick: () => {
        const cols = store.rows(`SELECT name FROM pragma_table_info('${v.name.replace(/'/g, "''")}')`).map(c => c.name);
        area.value = `SELECT ${cols.join(', ')}\nFROM ${v.name}\nLIMIT 100`;
        run();
      } }, v.name)))),
    ),
    el('div', {},
      el('section', { class: 'card' }, area,
        el('div', { class: 'card-actions', style: { marginTop: '8px' } },
          el('button', { type: 'button', class: 'primary', onclick: () => {
            // 把查询记进网址方便分享，但不重新渲染页面
            const next = new URLSearchParams(location.search);
            if (area.value === SQL_EXAMPLE) next.delete('sql'); else next.set('sql', area.value);
            history.replaceState(null, '', `${location.pathname}?${next}`);
            run();
          } }, '运行'),
          el('button', { type: 'button', onclick: () => download('query.sql', area.value, 'text/plain;charset=utf-8') }, '保存 SQL')),
        el('p', { class: 'note' }, '只能执行一条 SELECT / WITH 查询。数据库是浏览器里的一份副本，不会影响任何人。')),
      out)));
  if (fromLink) {
    // 链接里带来的查询不自动执行：先让人看清楚内容再点"运行"
    out.append(el('p', { class: 'note' }, '这个链接带来了一条查询，确认内容后点"运行"。'));
  } else {
    run();
  }
}
