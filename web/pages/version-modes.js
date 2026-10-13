import { addDays, compact, dateAxisLabel, daysBetween, formatDelta, formatValue } from '../lib/format.js';
import { cadenceMetrics, commonWindow, periodMetrics, subjectKey, updateImpact, versionIntervals } from '../lib/version-analysis.js';
import { slot } from '../lib/palette.js';
import { chartCard, disclosure, el, segmented, select, tableCard, tile } from '../lib/ui.js';
import { availableDays, currentGame, f, gameSelect, metricText, scopeLine, sortedVersions } from './shared.js';

const WINDOWS = [{ value: 3, label: '3 天' }, { value: 7, label: '7 天' }, { value: 14, label: '14 天' },
  { value: 30, label: '30 天' }, { value: 'all', label: '共同全部' }];
const MAX_OBJECTS = 6;
const titleOf = (store, v) => `${store.gameById[v.game_id].display_name} ${v.version_id}`;

export function renderMode(ctx, mode) {
  if (mode === 'multi') return multi(ctx);
  if (mode === 'before-after') return beforeAfter(ctx);
  return cadence(ctx);
}

function selectedSubjects(store, params) {
  const anchors = Object.fromEntries(store.games.map(g => [g.game_id, store.reviewAnchor(g.game_id)]));
  const available = store.versionRows.filter(v => availableDays(v, anchors[v.game_id]) > 0 && store.gameById[v.game_id]);
  const requested = [...new Set((params.get('objects') || '').split(','))];
  const byKey = new Map(available.map(v => [subjectKey(v), v]));
  const valid = requested.filter(k => byKey.has(k)).map(k => byKey.get(k)).slice(0, MAX_OBJECTS);
  const game = currentGame(store, params);
  const selected = valid.length ? valid : sortedVersions(store, game).filter(v => byKey.has(subjectKey(v))).slice(-3);
  return { anchors, available, selected };
}

function objectSelector(store, available, selected, set) {
  const keys = selected.map(subjectKey);
  const candidates = available.filter(v => !keys.includes(subjectKey(v)));
  const box = el('div', { class: 'object-selection' },
    el('div', { class: 'object-chips', role: 'group', 'aria-label': '已选对比对象' }, selected.map((v, i) =>
      el('button', { type: 'button', class: 'chip', disabled: keys.length === 1, 'aria-label': `移除 ${titleOf(store, v)}`,
        onclick: () => set({ objects: keys.filter(k => k !== subjectKey(v)) }) },
      el('span', { class: 'swatch', style: { background: slot(i) } }), titleOf(store, v), ' ×'))));
  if (keys.length < MAX_OBJECTS && candidates.length) {
    box.append(select('添加版本', [{ value: '', label: '选择游戏与版本…' }, ...candidates.map(v =>
      ({ value: subjectKey(v), label: `${titleOf(store, v)} · ${v.start_date}` }))], '',
    value => { if (value) set({ objects: [...keys, value] }); }));
  }
  box.append(el('span', { class: 'note' }, `${keys.length}/${MAX_OBJECTS}`));
  return box;
}

function multi({ store, root, params, set }) {
  const { anchors, available, selected } = selectedSubjects(store, params);
  if (!selected.length) { root.append(el('div', { class: 'empty' }, '还没有可比较的已开放版本。')); return; }
  const wanted = WINDOWS.some(w => String(w.value) === params.get('days')) ? params.get('days') : '14';
  const { common, days: n } = commonWindow(selected, anchors, wanted);
  const alignment = params.get('alignment') === 'calendar' ? 'calendar' : 'day0';
  root.append(el('div', { class: 'filters' }, objectSelector(store, available, selected, set),
    segmented('更新后', WINDOWS, wanted, value => set({ days: value })),
    segmented('时间轴', [{ value: 'day0', label: '各自起点 D0' }, { value: 'calendar', label: '日历日期' }],
      alignment, value => set({ alignment: value }))));
  if (n < 1) { root.append(el('div', { class: 'empty' }, '所选对象还没有共同的完整评测日。')); return; }
  root.append(scopeLine(`所有对象统一比较 D0–D${n - 1}（共 ${n} 天）`,
    alignment === 'calendar' ? '图上使用真实日期，统计窗口仍是各版本开放后的共同天数' : 'D0 为各版本在 Steam 开放的日期',
    wanted !== 'all' && n < Number(wanted) ? `所选 ${wanted} 天截到共同可用的 ${common} 天` : null));
  const summaries = selected.map(v => {
    const end = addDays(v.start_date, n - 1);
    return { ...v, object: titleOf(store, v), end, ...periodMetrics(store, v.game_id, v.start_date, end) };
  });
  const reviewComplete = summaries.every(r => r.review_days === n);
  const onlineComplete = summaries.every(r => r.online_days === n);
  root.append(disclosure('可比性',
    el('strong', {}, `${selected.length} 个版本 · 同阶段 ${n} 天`),
    el('p', {}, reviewComplete ? '各对象评测均覆盖完整窗口，可在下方对照声量与口碑。' : '部分对象评测覆盖不足，汇总指标留空，逐日图保留已有观测。'),
    el('p', {}, onlineComplete ? '各对象 SteamDB 在线均覆盖完整窗口。' : '部分对象在线覆盖不足；已有在线点继续展示，不作完整窗口排名。')));
  const summaryColumns = [
    { key: 'object', label: '游戏 / 版本' }, { key: 'start_date', label: 'Steam 开放日' }, { key: 'end', label: '统计截至' },
    { key: 'review_days', label: '评测覆盖', format: v => `${v ?? 0}/${n} 天` },
    ...['daily_reviews', 'daily_positive_rate', 'playtime_median_h'].map(id => ({ key: id, label: store.catalog.metrics[id].label,
      num: true, format: (value, row) => metricText(store, id, row.review_days === n ? value : null),
      csv: (value, row) => row.review_days === n ? value : null })),
    { key: 'online_days', label: '在线覆盖', format: v => `${v ?? 0}/${n} 天` },
    { key: 'avg_players', label: '窗口平均在线', num: true, format: (v, row) => metricText(store, 'avg_players', row.online_days === n ? v : null),
      csv: (v, row) => row.online_days === n ? v : null },
  ];
  root.append(tableCard({ title: '共同窗口指标', sub: '覆盖不足的汇总留空；好评率使用分子合计 ÷ 分母合计，时长为全部评测的中位数',
    columns: summaryColumns, rows: summaries, filename: 'versions-common-window' }));
  const data = selected.map(v => ({ v,
    reviews: store.query({ metrics: ['daily_reviews', 'daily_positive_rate'], dims: ['date', 'day_index'],
      filters: [f.eq('game_id', v.game_id), f.eq('version_id', v.version_id), f.between('day_index', 0, n - 1)] }).rows,
    online: store.query({ metrics: ['avg_players'], dims: ['date', 'day_index'],
      filters: [f.eq('game_id', v.game_id), f.eq('version_id', v.version_id), f.between('day_index', 0, n - 1)] }).rows }));
  const axis = alignment === 'day0' ? Array.from({ length: n }, (_, i) => i)
    : [...new Set(selected.flatMap(v => Array.from({ length: n }, (_, i) => addDays(v.start_date, i))))].sort();
  // 日历模式也补出窗口之间的日期，但不把对象画到各自窗口之外。
  const xs = alignment === 'day0' ? axis : Array.from({ length: daysBetween(axis[0], axis.at(-1)) + 1 },
    (_, i) => addDays(axis[0], i));
  const grid = el('div', { class: 'grid-2' });
  for (const [id, title, kind] of [['daily_reviews', '每日评测数', 'reviews'], ['daily_positive_rate', '每日好评率', 'reviews'],
    ['avg_players', '日均同时在线', 'online']]) {
    const series = data.map(({ v, ...rest }, i) => {
      const indexed = new Map(rest[kind].map(r => [alignment === 'day0' ? r.day_index : r.date, r[id]]));
      return { name: titleOf(store, v), color: slot(i), data: xs.map(x => indexed.get(x) ?? null) };
    });
    const tableRows = xs.map((x, j) => Object.fromEntries([['x', alignment === 'day0' ? `D${x}` : x],
      ...selected.map((v, i) => [subjectKey(v), series[i].data[j]])]));
    grid.append(chartCard({ title, sub: id === 'avg_players' ? 'SteamDB 全天平均；缺采与窗口外留空，不是 DAU' : '全部对象共用同阶段窗口',
      filename: `versions-multi-${id}-${alignment}`,
      chart: { type: 'line', x: xs.map(x => alignment === 'day0' ? `D${x}` : x), xFormat: alignment === 'calendar' ? dateAxisLabel(xs) : undefined,
        series, fitY: id !== 'daily_reviews', percent: id === 'daily_positive_rate',
        format: value => metricText(store, id, value), axisFormat: id === 'daily_positive_rate' ? value => `${value}%` : compact,
        noEndLabels: true },
      columns: [{ key: 'x', label: alignment === 'day0' ? '更新后' : '日期' }, ...selected.map(v =>
        ({ key: subjectKey(v), label: titleOf(store, v), num: true, format: value => metricText(store, id, value) }))], rows: tableRows }));
  }
  root.append(grid, disclosure('读数边界', el('p', { class: 'note' }, '跨游戏数据仍只代表各自 Steam 平台。时长、语言等结构差异不能直接解释成版本质量或因果。')));
}

function beforeAfter({ store, root, params, set }) {
  const game = currentGame(store, params);
  const versions = sortedVersions(store, game);
  const all = params.get('history') === 'all';
  const shown = all ? versions : versions.slice(-6);
  root.append(el('div', { class: 'filters' }, gameSelect(store, game, set),
    segmented('版本范围', [{ value: 'recent', label: '最近 6 个' }, { value: 'all', label: '全部版本' }],
      all ? 'all' : 'recent', value => set({ history: value }))));
  root.append(scopeLine('更新前 D−7–D−1 与更新后 D0–D6，各 7 天', '只有完整前后覆盖且窗口内没有其他版本更新才显示变化'));
  const rows = shown.map(v => {
    const r = updateImpact(store, v);
    return { ...r, object: v.version_id, date: v.start_date,
      coverage: `${r.before.review_days ?? 0}/7 → ${r.after.review_days ?? 0}/7 天`,
      status: r.otherUpdates.length ? `窗口还有 ${r.otherUpdates.map(v => v.version_id).join('、')} 更新，变化不可比`
        : r.complete ? '完整可比' : '评测覆盖不足，变化不可比' };
  });
  root.append(disclosure('可比性', el('strong', {}, `${rows.filter(r => r.complete).length}/${rows.length} 个版本具备完整前后窗口`),
    el('p', {}, '这里衡量更新前后公开信号的变化，不把变化归因于更新内容；评测后仍在玩等观察时长不一致的指标不进入此表。')));
  const comparisonColumn = (id, label, online = false) => ({ key: id, label, num: true, sortValue: row => row.after[id],
    format: (_, row) => {
      const bv = row.before[id]; const av = row.after[id];
      const complete = online ? row.onlineComplete : row.complete;
      const diff = complete ? formatDelta(store.catalog.metrics[id], av, bv) : null;
      return el('div', { class: 'window-change' }, el('span', {}, `${metricText(store, id, bv)} → ${metricText(store, id, av)}`),
        el('small', { class: 'muted' }, diff || (complete ? '基准为0或无有效样本，不算变化' : '不可比')));
    },
    csv: (_, row) => `${row.before[id] ?? ''} -> ${row.after[id] ?? ''}; ${
      (online ? row.onlineComplete : row.complete) ? formatDelta(store.catalog.metrics[id], row.after[id], row.before[id]) || '' : '不可比'}` });
  root.append(tableCard({ title: '前后对照', sub: '前值 → 后值；覆盖不足时显示已有观测并标不可比', filename: `${game}-before-after-7`,
    caveat: '在线要求前后各 7 天完整覆盖；时长为窗口内全部评测的标准中位数；语种不等于地区，在线不是 DAU。',
    columns: [{ key: 'object', label: '版本' }, { key: 'date', label: '更新日' }, { key: 'coverage', label: '前后评测覆盖' },
      comparisonColumn('daily_reviews', '评测数'), comparisonColumn('daily_positive_rate', '好评率'),
      comparisonColumn('playtime_median_h', '评测时时长（小时）'), comparisonColumn('avg_players', '平均在线', true),
      { key: 'status', label: '可比性' }], rows }));
}

function cadence({ store, root, params, set }) {
  const game = currentGame(store, params);
  const all = params.get('history') === 'all';
  const intervals = versionIntervals(store.versions(game));
  const rows = all ? intervals : intervals.slice(-6);
  const summary = cadenceMetrics(store, game, rows);
  root.append(el('div', { class: 'filters' }, gameSelect(store, game, set),
    segmented('版本范围', [{ value: 'recent', label: '最近 6 个' }, { value: 'all', label: '全部版本' }],
      all ? 'all' : 'recent', value => set({ history: value }))));
  root.append(scopeLine('仅统计已在 Steam 开放的版本', '间隔为本次开放日 − 上次开放日，不代表内容产量'));
  root.append(el('div', { class: 'tiles' },
    tile({ label: '开放版本', value: summary.version_count ?? rows.length, unit: '个' }),
    tile({ label: '平均间隔', value: formatValue(summary.avg_version_interval, 'decimal1'), unit: '天',
      note: `${summary.version_interval_count ?? '—'} 个有效间隔；窗口内首版可以引用更早的上一版日期` })));
  root.append(tableCard({ title: '更新节奏', sub: '开放中的版本也只以已发生的更新日期计算间隔', filename: `${game}-cadence`,
    columns: [{ key: 'version_id', label: '版本' }, { key: 'start_date', label: 'Steam 开放日' }, { key: 'previous', label: '上个版本' },
      { key: 'interval', label: '距上版（天）', num: true }, { key: 'is_open', label: '窗口状态', format: v => v ? '进行中' : '已结束' }], rows }));
}
