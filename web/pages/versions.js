// 版本对比：同一款游戏的两个版本，按各自的更新日对齐（D0 = Steam 开放当天），比较相同阶段。
// 两个版本用同一个窗口 D0…D(n-1)：开放中的版本只算到最后一个完整的评测日，窗口截到两者共同的长度，
// 否则长的一方会多出几天，被误读成"表现更持久"。指标卡、图表、构成全部用这个窗口。

import { compact, formatDelta } from '../lib/format.js';
import { ordinal, slot } from '../lib/palette.js';
import { chartCard, el, segmented, select, tile } from '../lib/ui.js';
import { availableDays, currentGame, dimText, f, gameSelect, header, metricText, one, scopeLine, sortedVersions } from './shared.js';

const WINDOWS = [{ value: 3, label: '3 天' }, { value: 7, label: '7 天' }, { value: 14, label: '14 天' },
                 { value: 30, label: '30 天' }, { value: 'all', label: '共同全部' }];
const TOP_LANGUAGES = 6;

export function render({ store, root, params, set }) {
  const game = currentGame(store, params);
  const anchor = store.reviewAnchor(game);
  const versions = sortedVersions(store, game).filter(v => availableDays(v, anchor) > 0);
  root.append(...header('版本对比', '同一款游戏的两个版本，按各自的 Steam 开放日对齐，比较更新后相同天数内的表现。'));
  if (versions.length < 2) {
    root.append(el('div', { class: 'filters' }, gameSelect(store, game, set)),
      el('div', { class: 'empty' }, '这款游戏已开放的版本少于两个，暂时无法对比。'));
    return;
  }
  const ids = versions.map(v => v.version_id);
  const b = ids.includes(params.get('b')) ? params.get('b') : ids[ids.length - 1];
  // A 默认取 B 的上一个版本；B 已经是第一个版本时取下一个，保证两边不是同一个版本
  const fallback = ids[ids.indexOf(b) - 1] ?? ids[ids.indexOf(b) + 1];
  const a = ids.includes(params.get('a')) && params.get('a') !== b ? params.get('a') : fallback;
  const va = versions.find(v => v.version_id === a);
  const vb = versions.find(v => v.version_id === b);
  const dayParam = params.get('days');
  const wanted = WINDOWS.some(w => String(w.value) === dayParam) ? (dayParam === 'all' ? 'all' : Number(dayParam)) : 14;
  const common = Math.min(availableDays(va, anchor), availableDays(vb, anchor));
  const n = wanted === 'all' ? common : Math.min(Number(wanted), common);

  const options = versions.map(v => ({ value: v.version_id, label: `${v.version_id} · ${v.start_date}` }));
  root.append(el('div', { class: 'filters' }, gameSelect(store, game, set),
    // 选成和另一边同一个版本时直接交换，避免 A、B 相同
    select('基准版本 A', options, a, v => set(v === b ? { a: v, b: a } : { a: v, b })),
    el('button', { type: 'button', onclick: () => set({ a: b, b: a }), 'aria-label': '交换 A 和 B' }, '⇄ 交换'),
    select('对比版本 B', options, b, v => set(v === a ? { b: v, a: b } : { b: v, a })),
    segmented('更新后', WINDOWS, wanted, v => set({ days: v }))));

  const shortNote = wanted !== 'all' && n < Number(wanted)
    ? `所选 ${wanted} 天超过了两个版本共同已有的 ${common} 天，按 ${n} 天比较` : null;
  root.append(scopeLine(`比较 D0–D${n - 1}（共 ${n} 天）`,
    `A：${a}，${va.start_date} 起`, `B：${b}，${vb.start_date} 起`, shortNote,
    vb.is_open || va.is_open ? `开放中的版本只算到最后一个完整评测日 ${anchor}` : null));

  const color = { [a]: slot(0), [b]: slot(1) };
  const label = v => (v === a ? `A · ${a}` : `B · ${b}`);
  const scope = [f.eq('game_id', game), f.in('version_id', [a, b]), f.between('day_index', 0, n - 1)];
  const perVersion = (metrics, extra = []) => {
    const rows = store.query({ metrics, dims: ['version_id'], filters: [...scope, ...extra] }).rows;
    return Object.fromEntries(rows.map(r => [r.version_id, r]));
  };
  const daily = perVersion(['daily_reviews', 'reviews_per_day', 'daily_positive_rate']);
  const online = perVersion(['avg_players', 'online_days']);
  const detail = perVersion(['playtime_median_h', 'short_play_share']);

  const pairTile = (title, id, source, unit, note, comparable = true) => {
    const m = store.catalog.metrics[id];
    const av = source[a]?.[id];
    const bv = source[b]?.[id];
    const diff = comparable ? formatDelta(m, bv, av) : null;
    return el('div', { class: 'tile' },
      el('div', { class: 'tile-label' }, title),
      el('div', { class: 'pair' },
        el('span', {}, el('span', { class: 'swatch', style: { background: color[a] } }), ' A'),
        el('div', { class: 'tile-value' }, metricText(store, id, av), unit ? el('small', {}, unit) : null),
        el('span', {}, el('span', { class: 'swatch', style: { background: color[b] } }), ' B'),
        el('div', { class: 'tile-value' }, metricText(store, id, bv), unit ? el('small', {}, unit) : null)),
      diff ? el('div', { class: 'tile-delta' }, `B 较 A ${diff}`) : null,
      note ? el('div', { class: 'tile-note' }, note) : null);
  };
  const onlineComparable = [a, b].every(v => online[v]?.online_days === n);
  const onlineNote = onlineComparable
    ? 'SteamDB 全天平均的窗口均值，不是 DAU'
    : `SteamDB 覆盖：A ${online[a]?.online_days ?? 0}/${n} 天，B ${online[b]?.online_days ?? 0}/${n} 天；覆盖天数不同，不比较`;
  root.append(el('div', { class: 'tiles' },
    pairTile('窗口评测数', 'daily_reviews', daily, '条', '按创建日统计仍存续的评测'),
    pairTile('日均评测数', 'reviews_per_day', daily, '条/日'),
    pairTile('窗口好评率', 'daily_positive_rate', daily, null, '窗口内好评 ÷ 评价已知的评测'),
    pairTile('日均同时在线', 'avg_players', online, '人', onlineNote, onlineComparable),
    pairTile('写评测时游戏时长（中位数）', 'playtime_median_h', detail, '小时'),
  ));

  const days = Array.from({ length: n }, (_, i) => i);
  const xs = days.map(d => `D${d}`);
  const series = (rows, metric, name) => [a, b].map(v => {
    const byDay = Object.fromEntries(rows.filter(r => r.version_id === v).map(r => [r.day_index, r[metric]]));
    return { name: label(v), color: color[v], data: days.map(d => byDay[d] ?? null) };
  });
  const tableRows = (rows, metrics) => days.map(d => {
    const row = { day: `D${d}` };
    for (const v of [a, b]) {
      const r = rows.find(x => x.version_id === v && x.day_index === d) || {};
      for (const m of metrics) row[`${v}:${m}`] = r[m] ?? null;
    }
    return row;
  });
  const tableColumns = (metrics, labels) => [{ key: 'day', label: '更新后' }, ...[a, b].flatMap(v => metrics.map((m, i) => ({
    key: `${v}:${m}`, label: `${label(v)} ${labels[i]}`, num: true, format: x => metricText(store, m, x) })))];

  const reviewRows = store.query({ metrics: ['daily_reviews', 'daily_positive_rate'], dims: ['version_id', 'day_index'], filters: scope }).rows;
  const onlineRows = store.query({ metrics: ['avg_players'], dims: ['version_id', 'day_index'], filters: scope }).rows;
  const grid = el('div', { class: 'grid-2' },
    chartCard({ title: '每日评测数', sub: '按更新后第几天对齐', filename: `${game}-${a}-vs-${b}-reviews`,
      chart: { type: 'bar', x: xs, series: series(reviewRows, 'daily_reviews'), format: v => `${metricText(store, 'daily_reviews', v)} 条` },
      columns: tableColumns(['daily_reviews'], ['评测数']), rows: tableRows(reviewRows, ['daily_reviews']) }),
    chartCard({ title: '每日好评率', sub: '评测少的日子波动大', filename: `${game}-${a}-vs-${b}-positive-rate`,
      chart: { type: 'line', x: xs, fitY: true, percent: true, series: series(reviewRows, 'daily_positive_rate'),
               format: v => metricText(store, 'daily_positive_rate', v), axisFormat: v => `${v}%` },
      columns: tableColumns(['daily_reviews', 'daily_positive_rate'], ['评测数', '好评率']),
      rows: tableRows(reviewRows, ['daily_reviews', 'daily_positive_rate']) }),
    chartCard({ title: '日均同时在线', sub: 'SteamDB 全天平均同时在线；缺数据的日子留空', filename: `${game}-${a}-vs-${b}-online`,
      empty: onlineRows.length ? null : '窗口内没有 SteamDB 在线数据',
      chart: { type: 'line', x: xs, fitY: true, series: series(onlineRows, 'avg_players'),
               format: v => `${metricText(store, 'avg_players', v)} 人`, axisFormat: compact },
      columns: tableColumns(['avg_players'], ['日均同时在线']), rows: tableRows(onlineRows, ['avg_players']) }),
    compositionCard(store, game, a, b, n, scope, label),
  );
  root.append(grid, languageCard(store, game, a, b, scope, label, color));
}

function compositionCard(store, game, a, b, n, scope, label) {
  const bands = store.catalog.dimensions.playtime_band.order;
  const rows = store.query({ metrics: ['review_share', 'review_count'], dims: ['version_id', 'playtime_band'],
    filters: [...scope, { dim: 'playtime_band', op: 'notnull' }], shareDim: 'playtime_band' }).rows;
  const value = (v, band) => rows.find(r => r.version_id === v && r.playtime_band === band)?.review_share ?? 0;
  return chartCard({ title: '写评测时的游戏时长构成', sub: `D0–D${n - 1} 内的评测，按写评测时已玩的时长分段`,
    filename: `${game}-${a}-vs-${b}-playtime`,
    chart: { type: 'stacked100', x: [label(a), label(b)],
             series: bands.map(band => ({ name: dimText(store, 'playtime_band', band), color: ordinal(bands, band),
                                          data: [value(a, band), value(b, band)] })),
             format: v => metricText(store, 'review_share', v), axisFormat: v => `${v}%` },
    columns: [{ key: 'version_id', label: '版本', format: v => label(v) },
              { key: 'playtime_band', label: '时长段', format: v => dimText(store, 'playtime_band', v) },
              { key: 'review_count', label: '评测数', num: true },
              { key: 'review_share', label: '占比', num: true, format: v => metricText(store, 'review_share', v) }],
    rows });
}

function languageCard(store, game, a, b, scope, label, color) {
  const rows = store.query({ metrics: ['review_share', 'review_count'], dims: ['version_id', 'language'],
    filters: scope, shareDim: 'language' }).rows;
  const totals = {};
  for (const r of rows) totals[r.language] = (totals[r.language] || 0) + r.review_count;
  const top = Object.keys(totals).sort((x, y) => totals[y] - totals[x]).slice(0, TOP_LANGUAGES);
  const share = (v, lang) => rows.find(r => r.version_id === v && r.language === lang)?.review_share ?? 0;
  const other = v => Math.max(0, 100 - top.reduce((s, lang) => s + share(v, lang), 0));
  const x = [...top.map(lang => dimText(store, 'language', lang)), '其他'];
  return chartCard({ title: '评测语种构成', sub: `各版本窗口内每种语言的评测占比（前 ${TOP_LANGUAGES} 种，其余合并为"其他"）`,
    caveat: '语种是写评测时选择的语言，不等于玩家所在地区。', filename: `${game}-${a}-vs-${b}-languages`,
    chart: { type: 'bar', x, series: [a, b].map(v => ({ name: label(v), color: color[v],
             data: [...top.map(lang => share(v, lang)), other(v)] })),
             format: v => metricText(store, 'review_share', v), axisFormat: v => `${v}%` },
    columns: [{ key: 'version_id', label: '版本', format: v => label(v) },
              { key: 'language', label: '语种', format: v => dimText(store, 'language', v) },
              { key: 'review_count', label: '评测数', num: true },
              { key: 'review_share', label: '占比', num: true, format: v => metricText(store, 'review_share', v) }],
    rows });
}

