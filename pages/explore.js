// 自助查询：选数据表 → 指标 → 横轴与拆分维度 → 筛选，现场生成 SQL 在浏览器里执行。
// 和固定看板用同一份指标目录与查询生成器，所以这里查出来的数和看板上的数一定一致。
// 目录里的规则（例如播放量不能跨语区相加）在生成 SQL 时强制执行，违反时给出原因而不是给出一个错数。

import { compareVersions, compact, dateAxisLabel, dimLabel, formatValue } from '../lib/format.js';
import { additive, canCombine, completeSum, fillAxis, seriesScore } from '../lib/explore-data.js';
import { colorByOrder, ordinal, otherColor, slot, themed } from '../lib/palette.js';
import { QueryError, checkReadOnlySql, limitSql } from '../lib/query.js';
import { chartCard, chips, disclosure, download, el, emptyState, infoMenu, menu, select, tableCard, toast } from '../lib/ui.js';
import { header, shortMetricLabel } from './shared.js';

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

export function render({ store, root, params, set, state = {} }) {
  const cat = store.catalog;
  root.append(...header('自助查询', '选择指标、维度和筛选条件，现场在浏览器里计算。口径与看板完全相同。'));
  const mode = params.get('mode') === 'sql' ? 'sql' : 'builder';
  const examples = menu('示例查询', presets(store).map(p => ({ label: p.label, run: () => set(presetParams(p.params)) })));
  examples.classList.add('query-presets');
  root.append(el('div', { class: 'filters' },
    el('div', { class: 'segmented', role: 'group', 'aria-label': '查询方式' },
      el('button', { type: 'button', 'aria-pressed': String(mode === 'builder'), onclick: () => set({ mode: null }) }, '选择指标'),
      el('button', { type: 'button', 'aria-pressed': String(mode === 'sql'), onclick: () => set({ mode: 'sql' }) }, '直接写 SQL')),
    examples));
  if (mode === 'sql') {
    sqlMode(store, root, params, state);
    return;
  }

  const factId = cat.facts[params.get('fact')] ? params.get('fact') : 'review_daily';
  const fact = cat.facts[factId];
  const factMetrics = Object.entries(cat.metrics).filter(([, m]) => m.fact === factId).map(([id]) => id);
  const metrics = list(params.get('m')).filter(id => factMetrics.includes(id));
  const chosen = metrics.length ? metrics : [factMetrics[0]];
  const dims = fact.dimensions;
  const x = dims.includes(params.get('x')) ? params.get('x') : fact.date_dimension;
  const games = list(params.has('games') ? params.get('games') : params.get('game')).filter(g => store.gameById[g]);
  const gameIds = games.length ? games : store.games.map(g => g.game_id);
  const s = dims.includes(params.get('s')) && params.get('s') !== x ? params.get('s')
    : !params.has('s') && gameIds.length > 1 && x !== 'game_id' ? 'game_id' : '';
  const chartType = CHART_TYPES.some(c => c.value === params.get('chart')) ? params.get('chart') : 'auto';

  const panel = el('div', { class: 'panel', 'data-state-key': 'query-panel' });
  const output = el('div', {});
  const controls = el('details', { class: 'query-controls', 'data-state-key': 'query-controls', open: !matchMedia('(max-width: 1024px)').matches },
    el('summary', {}, `筛选 · ${gameIds.length === 1 ? store.gameById[gameIds[0]].display_name : `${gameIds.length} 游戏`}`), panel);
  root.append(el('div', { class: 'explore' }, controls, output));

  panel.append(
    el('fieldset', {}, el('legend', {}, '数据表'),
      select('', Object.entries(cat.facts).map(([id, f]) => ({ value: id, label: f.label })), factId,
        v => set({ fact: v, m: null, x: v === 'video_latest' ? 'content_type' : null,
          s: v === 'steam_daily' ? 'game_id' : v === 'video_obs' ? 'video_id' : v === 'video_latest' ? 'locale' : null,
          locales: v === 'video_obs' && !params.get('locales') ? 'zh-cn' : params.get('locales') })),
      infoMenu('口径', el('p', {}, fact.note), ...factMetrics.map(id => el('p', {}, el('strong', {}, cat.metrics[id].label), ' · ', cat.metrics[id].note || cat.metrics[id].unit)))),
    el('fieldset', {}, el('legend', {}, '指标'),
      ...factMetrics.map(id => {
        const m = cat.metrics[id];
        const box = el('input', { type: 'checkbox', 'aria-label': `${m.label}（${m.unit}）`, checked: chosen.includes(id), onchange: e => {
          const next = e.target.checked ? [...chosen, id] : chosen.filter(v => v !== id);
          if (next.length) set({ m: next });
          else e.target.checked = true;
        } });
        return el('label', { class: 'option' }, box, el('span', {}, shortMetricLabel(id, m)));
      })),
    el('fieldset', {}, el('legend', {}, '维度'),
      select('横轴', dims.map(d => ({ value: d, label: cat.dimensions[d].label })), x, v => set({ x: v })),
      select('拆分为多条', [{ value: 'none', label: '不拆分' }, ...dims.filter(d => d !== x).map(d => ({ value: d, label: cat.dimensions[d].label }))],
        s || 'none', v => set({ s: v })),
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
  const clear = { fact: null, m: null, x: null, s: null, game: null, games: null, versions: null, from: null, to: null, d0: null, d1: null,
                  locales: null, types: null, chart: null, nodefault: null, mode: null, sql: null };
  return { ...clear, ...p };
}

function filterFields(store, fact, params, set, gameIds) {
  const cat = store.catalog;
  const has = d => fact.dimensions.includes(d);
  const box = el('fieldset', {}, el('legend', {}, '筛选'));
  box.append(chips('游戏', store.games.map(g => ({ value: g.game_id, label: g.display_name, color: themed(g.color) })), gameIds,
    v => set({ game: v.length === 1 ? v[0] : null, games: v.length === store.games.length ? null : v, versions: null })));
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
    const text = defaults.map(d => ({ curated: '含非精选', complete_day: '含未完整日' }[d] || d));
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
  const xs = fillAxis(cat.dimensions[x].type, [...new Set(rows.map(r => r[x]))].sort(sortX), x === 'week_start' ? 7 : 1);
  const index = new Map(rows.map(r => [`${r[x]}\u0000${s ? r[s] : ''}`, r]));
  const type = chartType === 'auto'
    ? (['date', 'integer'].includes(cat.dimensions[x].type) ? 'line' : 'bar') : chartType;

  output.append(el('p', { class: 'scope' }, `${rows.length} 行`,
    result.filters.some(f => f.dim === 'curated') ? ' · 只含精选范围内的视频' : ''));
  if (!rows.length) {
    const reset = new URLSearchParams(location.search);
    for (const key of ['from', 'to', 'd0', 'd1', 'versions', 'types', 'locales']) reset.delete(key);
    output.append(emptyState('筛选无匹配，可放宽日期或条件', [{ label: '清除筛选', href: `?${reset}` }]));
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
        const totals = new Map(groups.map(g => [g, seriesScore(m, rows.filter(r => r[s] === g).map(r => r[id]))]));
        groups = groups.sort((a, b) => totals.get(b) - totals.get(a));
        const keep = canCombine(m, s) ? MAX_SERIES - 1 : MAX_SERIES;
        rest = groups.slice(keep);
        groups = groups.slice(0, keep);
        note = canCombine(m, s)
          ? `拆分出的类别超过 ${MAX_SERIES} 个，其余 ${rest.length} 个合并为"其他"，完整结果见数据表。`
          : `拆分出的类别超过 ${MAX_SERIES} 个，图中显示最近有效值最大的 ${groups.length} 个（保留指标的独立拆分，不合并为"其他"），完整结果见数据表。`;
      }
      if (s === 'version_id') groups.sort(compareVersions);
      const value = (v, g) => index.get(`${v}\u0000${s ? g : ''}`)?.[id] ?? null;
      const series = groups.map((g, i) => ({
        name: s ? label(s, g) : shortMetricLabel(id, m), color: s ? seriesColor(store, s, g, i) : slot(0), data: xs.map(v => value(v, g)) }));
      if (rest.length && canCombine(m, s)) {
        series.push({ name: '其他', color: otherColor(), data: xs.map(v => completeSum(rest.map(g => value(v, g)))) });
        note += ' 合并类别在任一成员缺失时留空，不将缺采当成0。';
      }
      const fmt = v => (m.format === 'integer' && Math.abs(v) >= 1e4 ? compact(v) : formatValue(v, m.format));
      const title = id === 'daily_reviews' ? (x === 'week_start' ? '每周评测' : ['date', 'day_index', 'game_day_index'].includes(x) ? '每日评测' : '评测合计')
        : id === 'daily_positive_rate' && x === 'week_start' ? '每周好评' : shortMetricLabel(id, m);
      output.append(chartCard({ title, sub: `${metricLabel(m.label, x)} · ${m.unit}；按「${cat.dimensions[x].label}」${s ? `，拆分为「${cat.dimensions[s].label}」` : '，所选对象合并统计'}`,
        caveat: [m.note, note, gapNote(cat.dimensions[x].type, xs, rows, x)].filter(Boolean).join(' '),
        filename: `gamepulse-${factId}-${id}`,
        chart: { type: type === 'stacked' ? 'stacked' : type, x: xs.map(v => label(x, v)),
                 xFormat: cat.dimensions[x].type === 'date' ? dateAxisLabel(xs) : undefined, series, format: fmt,
                 axisFormat: v => (m.format === 'percent' ? `${v}%` : `${compact(v)} ${m.unit}`), fitY: type === 'line', percent: m.format === 'percent',
                 noEndLabels: series.length > 4 },
        columns: resultColumns(store, result, x), rows }));
    }
  }
  if (type === 'table' || rows.length) {
    output.append(tableCard({ title: '查询结果', filename: `gamepulse-${factId}`, columns: resultColumns(store, result, x), rows }));
  }
  const sqlText = formatSql(result.sql, result.params);
  output.append(disclosure('查看生成的 SQL',
    el('div', { class: 'card-actions' }, el('button', { type: 'button', onclick: async () => {
      try { await navigator.clipboard.writeText(sqlText); toast('已复制 SQL'); } catch { toast('复制失败，请手动复制'); }
    } }, '复制'), el('button', { type: 'button', onclick: () => set({ mode: 'sql', sql: sqlText }) }, '编辑这条 SQL')),
    el('pre', { class: 'sql' }, sqlText),
    el('p', { class: 'note' }, 'quantile(x, p) 是本项目注册的分位数函数（线性插值，p = 0.5 为中位数）。可以复制到"直接写 SQL"里修改。')));
}

function gapNote(type, xs, rows, x) {
  if (!['date', 'integer'].includes(type)) return '';
  const have = new Set(rows.map(r => r[x]));
  const missing = xs.filter(v => !have.has(v)).length;
  return missing ? `其中 ${missing} 个${x === 'week_start' ? '周' : type === 'date' ? '日期' : '位置'}没有数据，图上留空。` : '';
}

function metricLabel(label, x) {
  return label.replace('（按日）', x === 'week_start' ? '（按周）' : ['date', 'day_index', 'game_day_index'].includes(x) ? '（按日）' : '（合计）');
}

function resultColumns(store, result, x) {
  return result.columns.map(c => (c.kind === 'dimension'
    ? { key: c.key, label: c.label, format: v => dimLabel(store.catalog, store, c.key, v), csv: v => v }
    : { key: c.key, label: `${metricLabel(c.label, x)}（${c.unit}）`, num: true, format: v => formatValue(v, c.format) }));
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

function sqlMode(store, root, params, state) {
  const fromLink = params.get('sql');
  if (!state.sql || state.sql.link !== fromLink) state.sql = { link: fromLink, draft: fromLink || SQL_EXAMPLE };
  const editor = state.sql;
  const draftStatus = el('span', { class: 'draft-status', role: 'status' }, editor.draft !== editor.executed ? '待运行' : '');
  const area = el('textarea', { class: 'sql', spellcheck: 'false', 'aria-label': 'SQL 查询' });
  area.value = editor.draft;
  area.addEventListener('input', () => { editor.draft = area.value; draftStatus.textContent = editor.draft !== editor.executed ? '待运行' : ''; });
  const out = el('div', { class: 'sql-results' });
  const show = () => {
    out.replaceChildren();
    if (editor.error) out.append(el('div', { class: 'error', role: 'alert' }, editor.error));
    const result = editor.result;
    if (!result) return;
    const columns = result.columns.map((c, i) => ({ key: c, label: c,
      num: result.values.some(row => typeof row[i] === 'number') && result.values.every(row => row[i] == null || typeof row[i] === 'number') }));
    const truncated = result.values.length > SQL_ROW_LIMIT;
    const rows = result.values.slice(0, SQL_ROW_LIMIT).map(v => Object.fromEntries(result.columns.map((c, i) => [c, v[i]])));
    out.append(el('p', { class: 'scope' }, `${rows.length} 行`, editor.error ? ' · 上次结果' : '', truncated ? ' · 已截断' : ''),
      tableCard({ title: '查询结果', filename: 'gamepulse-sql', columns, rows,
        sub: `${editor.ms.toFixed(0)} ms${truncated ? ` · 前 ${SQL_ROW_LIMIT} 行` : ''}`,
        context: { sql: editor.executed, truncated } }));
  };
  const run = () => {
    const started = performance.now();
    editor.draft = area.value;
    editor.initialized = true;
    try {
      editor.result = store.raw(limitSql(checkReadOnlySql(area.value), SQL_ROW_LIMIT + 1));
      editor.executed = area.value;
      editor.error = null;
      editor.ms = performance.now() - started;
    } catch (err) { editor.error = err.message; }
    draftStatus.textContent = editor.error ? '失败' : '';
    show();
  };
  const views = store.rows("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name");
  root.append(el('div', { class: 'explore' },
    el('details', { class: 'query-controls sql-schema', 'data-state-key': 'sql-schema', open: !matchMedia('(max-width: 1024px)').matches },
      el('summary', {}, '数据表'), el('div', { class: 'panel' },
      el('ul', {}, views.map(v => el('li', {}, el('button', { type: 'button', class: 'ghost', 'aria-expanded': 'false', onclick: event => {
        const button = event.currentTarget;
        const existing = button.parentElement.querySelector('.schema-fields');
        if (existing) { existing.remove(); button.setAttribute('aria-expanded', 'false'); editor.expanded = (editor.expanded || []).filter(name => name !== v.name); return; }
        const cols = store.rows(`SELECT name, type FROM pragma_table_info('${v.name.replace(/'/g, "''")}')`);
        button.setAttribute('aria-expanded', 'true');
        editor.expanded = [...new Set([...(editor.expanded || []), v.name])];
        button.parentElement.append(el('div', { class: 'schema-fields' },
          ...cols.map(c => el('div', {}, el('code', {}, c.name), el('span', { class: 'muted' }, ` ${c.type || '计算列'}`)))));
      } }, v.name))))),
    ),
    el('div', {},
      el('section', { class: 'card' }, area,
        el('div', { class: 'card-actions', style: { marginTop: '8px' } },
          el('button', { type: 'button', class: 'primary', onclick: async event => {
            const button = event.currentTarget;
            if (out.getAttribute('aria-busy') === 'true') return;
            // 把查询记进网址方便分享，但不重新渲染页面
            const next = new URLSearchParams(location.search);
            if (area.value === SQL_EXAMPLE) next.delete('sql'); else next.set('sql', area.value);
            history.replaceState(null, '', `${location.pathname}?${next}`);
            if (next.has('sql')) params.set('sql', next.get('sql')); else params.delete('sql');
            editor.link = next.get('sql');
            out.setAttribute('aria-busy', 'true');
            button.setAttribute('aria-disabled', 'true');
            button.textContent = '查询中';
            await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
            if (!button.isConnected) return;
            run();
            out.removeAttribute('aria-busy'); button.removeAttribute('aria-disabled'); button.textContent = '运行';
            document.getElementById('view-status').textContent = editor.error ? '查询失败' : '查询完成';
          } }, '运行'),
          el('button', { type: 'button', onclick: () => download('query.sql', area.value, 'text/plain;charset=utf-8') }, '保存 SQL'), draftStatus),
        disclosure('只读 SQL', el('p', {}, '仅允许一条 SELECT / WITH；链接带入的查询需手动运行。'))),
      out)));
  if (editor.initialized) {
    show();
  } else if (fromLink) {
    // 链接里带来的查询不自动执行：先让人看清楚内容再点"运行"
    out.append(el('p', { class: 'note' }, '查询待运行'));
  } else {
    run();
  }
  if (editor.expanded?.length) requestAnimationFrame(() => {
    root.querySelectorAll('.sql-schema button').forEach(button => {
      if (button.isConnected && editor.expanded.includes(button.textContent)) button.click();
    });
  });
}
