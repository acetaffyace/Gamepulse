// 视频传播：精选范围内的官方视频，按频道语区分开看。
// 同一支 PV 在各语区频道各发一次，播放量不能跨语区相加（指标目录强制按语区分组）。
// 不同视频的发布天数不同，"最新值"只适合在同一语区内粗看；比较传播节奏用"发布后同龄"。

import { compact, compareVersions, dimLabel, shortDate } from '../lib/format.js';
import { colorByOrder, slot } from '../lib/palette.js';
import { chartCard, chips, el, segmented, select, tableCard } from '../lib/ui.js';
import { currentGame, dimText, f, gameSelect, header, metricText, scopeLine, sortedVersions } from './shared.js';

const IMPORTANT = ['version_trailer', 'character_trailer', 'character_demo', 'character_ep'];
const AGES = [{ value: 7, label: '7 天' }, { value: 14, label: '14 天' }, { value: 30, label: '30 天' }];
const CURVES = 6;
let pickerOpen = false;
const originalUrl = v => v.platform === 'bilibili' ? `https://www.bilibili.com/video/${encodeURIComponent(v.video_id)}`
  : `https://www.youtube.com/watch?v=${encodeURIComponent(v.video_id)}`;
const contentLabel = (store, v) => [v.version_id, v.character_name, dimText(store, 'content_type', v.content_type)].filter(Boolean).join(' · ');

export function render({ store, root, params, set }) {
  const game = currentGame(store, params);
  const configuredLocales = new Set(store.distinct('v_video', 'locale', 'game_id = ? AND curated = 1', [game]));
  const localeOrder = store.catalog.dimensions.locale.order.filter(l => configuredLocales.has(l));
  if (!localeOrder.length) localeOrder.push(...store.catalog.dimensions.locale.order);
  const locale = localeOrder.includes(params.get('locale')) ? params.get('locale') : 'zh-cn';
  const availableTypes = [...IMPORTANT, ...store.distinct('v_video', 'content_type', 'game_id = ? AND curated = 1', [game]).filter(t => !IMPORTANT.includes(t))];
  const types = (params.get('types') || '').split(',').filter(t => availableTypes.includes(t));
  const selectedTypes = types.length ? types : availableTypes;
  const versions = [...sortedVersions(store, game), ...store.rows("SELECT version_id, status FROM version WHERE game_id = ? AND status = 'scheduled' ORDER BY cn_start_date", [game])];
  const version = versions.some(v => v.version_id === params.get('version')) ? params.get('version') : '';
  const metric = params.get('metric') === 'engagement' ? 'engagement' : 'views';
  const age = AGES.some(a => String(a.value) === params.get('age')) ? Number(params.get('age')) : 30;

  root.append(...header('视频传播', '登记范围内的官方视频，按频道语区分开看；内容类型沿用版本、角色宣传，并支持游戏实际登记的活动、联动和赛事内容。'));
  root.append(el('div', { class: 'filters' }, gameSelect(store, game, set),
    select('频道语区', localeOrder.map(l => ({ value: l, label: dimText(store, 'locale', l) })), locale, v => set({ locale: v, curve_ids: null })),
    chips('内容类型', availableTypes.map(t => ({ value: t, label: dimText(store, 'content_type', t) })), selectedTypes,
      v => set({ types: v.length === availableTypes.length ? null : v })),
    select('版本', [{ value: '', label: '全部版本' }, ...versions.map(v => ({ value: v.version_id, label: `${v.version_id}${v.status === 'scheduled' ? '（预告）' : ''}` }))],
      version, v => set({ version: v })),
    segmented('指标', [{ value: 'views', label: '累计播放' }, { value: 'engagement', label: '互动率' }], metric, v => set({ metric: v }))));

  const base = [f.eq('game_id', game), f.eq('locale', locale), f.in('content_type', selectedTypes),
                ...(version ? [f.eq('version_id', version)] : [])];
  const latestId = metric === 'views' ? 'latest_views' : 'latest_engagement';
  const obsId = metric === 'views' ? 'video_views' : 'video_engagement';
  const fmt = v => (metric === 'views' ? `${compact(v)} 次` : metricText(store, obsId, v));
  const engagementNote = locale === 'zh-cn' ? '互动率 =（点赞 + 投币 + 收藏）÷ 播放' : '互动率 =（点赞 + 评论）÷ 播放';
  root.append(scopeLine(`频道语区：${dimText(store, 'locale', locale)}`,
    metric === 'engagement' ? `${engagementNote}；B 站与 YouTube 公式不同，不能直接比较` : '累计播放是观看次数，不是独立观众数'));

  const latest = store.query({ metrics: [latestId, 'latest_views'], dims: ['platform', 'video_id', 'title', 'character_name', 'pub_date', 'content_type',
    'version_id', 'days_since_pub', 'first_obs_age', 'date'], filters: base, order: [{ key: latestId, desc: true }] }).rows;
  const ranked = latest.filter(v => v[latestId] != null).slice(0, 10);
  const color = colorByOrder(localeOrder, locale);
  root.append(chartCard({ title: metric === 'views' ? '最新累计播放' : '最新互动率',
    sub: '前 10 支 · 每支视频最近一次观测；发布年龄不同，完整列表和原视频链接见数据表', filename: `${game}-${locale}-latest`,
    empty: ranked.length ? null : latest.length ? '已登记的视频尚无该指标的有效观测' : '没有符合条件的视频',
    chart: { type: 'hbar', x: ranked.map(v => contentLabel(store, v)), height: Math.max(270, ranked.length*32+60),
             labelWidth: window.innerWidth < 600 ? 115 : 240, tooltipTitle: (_, i) => ranked[i]?.title,
             series: [{ name: metric === 'views' ? '最新累计播放' : '最新互动率', color, data: ranked.map(v => v[latestId]) }],
             format: fmt, axisFormat: metric === 'views' ? compact : v => `${v}%` },
    columns: videoColumns(store, latestId), rows: latest }));

  // 发布后同龄：只取在 D0…D(age-1) 内确实有观测的视频（多数视频是发布后才登记的），取发布最晚的几支，按发布先后固定配色
  const inWindow = latest.filter(v => v.first_obs_age !== null && v.first_obs_age < age);
  const requested = [...new Set((params.get('curve_ids') || '').split(','))].filter(id => latest.some(v => v.video_id === id)).slice(0, CURVES);
  const recent = (requested.length ? latest.filter(v => requested.includes(v.video_id))
    : [...inWindow].sort((x, y) => (y.pub_date || '').localeCompare(x.pub_date || '')).slice(0, CURVES))
    .sort((x, y) => (x.pub_date || '').localeCompare(y.pub_date || ''));
  const curveRows = recent.length ? store.query({ metrics: [obsId], dims: ['video_id', 'days_since_pub'],
    filters: [...base, f.in('video_id', recent.map(v => v.video_id)), f.between('days_since_pub', 0, age - 1)] }).rows : [];
  const ages = Array.from({ length: age }, (_, i) => i);
  const colorOrder = store.distinct('v_video', 'video_id', 'game_id = ? AND locale = ?', [game, locale]);
  const series = recent.map((v, i) => {
    const byAge = Object.fromEntries(curveRows.filter(r => r.video_id === v.video_id).map(r => [r.days_since_pub, r[obsId]]));
    return { name: `${v.character_name ? `${v.character_name} ` : ''}${dimText(store, 'content_type', v.content_type)} · ${shortDate(v.pub_date)}`,
             color: slot(Math.max(0, colorOrder.indexOf(v.video_id))), dashed: v.first_obs_age > 0, data: ages.map(d => byAge[d] ?? null) };
  });
  const missingStart = recent.filter(v => v.first_obs_age > 0);
  const tableRows = ages.map(d => Object.fromEntries([['age', `D${d}`], ...recent.map((v, i) => [v.video_id, series[i].data[d]])]));
  const skipped = latest.length - inWindow.length;
  const starts = missingStart.map(v => v.first_obs_age);
  const chosen = recent.map(v => v.video_id);
  const picker = el('details', { class: 'curve-picker', 'data-state-key': 'curve-picker', open: pickerOpen, ontoggle: e => { pickerOpen = e.currentTarget.open; } },
    el('summary', {}, `选择视频 · ${recent.length}/${CURVES}`),
    el('p', { class: 'note' }, '最多 6 支。取消一支后可加入其他视频；灰色选项在当前同龄窗口内没有观测。'),
    ...[...latest].sort((a, b) => (b.pub_date || '').localeCompare(a.pub_date || '')).map(v => {
      const checked = chosen.includes(v.video_id);
      return el('label', { class: 'curve-option' }, el('input', { type: 'checkbox', value: v.video_id, checked,
        disabled: !checked && (chosen.length >= CURVES || v.first_obs_age === null || v.first_obs_age >= age), onchange: e => {
          const next = e.target.checked ? [...chosen, v.video_id] : chosen.filter(id => id !== v.video_id);
          if (!next.length) { e.target.checked = true; return; }
          pickerOpen = true; set({ curve_ids: next });
        } }), el('span', {}, contentLabel(store, v), el('small', {}, `${v.pub_date || '未知发布日期'} · 首次观测 ${v.first_obs_age == null ? '未知' : `D${v.first_obs_age}`}`)));
    }));
  const coverage = el('div', { class: 'coverage-list', 'aria-label': '同龄观测覆盖' }, recent.map((v, i) =>
    el('div', { class: 'coverage-row' }, el('span', { class: 'coverage-label' }, contentLabel(store, v)),
             el('div', { class: 'coverage-track', role: 'img', 'aria-label': `${contentLabel(store, v)}：${series[i].data.filter(x => x != null).length}/${age} 个日期有有效指标`,
        style: { gridTemplateColumns: `repeat(${age}, minmax(0, 1fr))` } }, series[i].data.map((value, d) =>
        el('span', { class: value == null ? 'gap' : 'observed', title: `D${d}：${value == null ? '无观测' : fmt(value)}`,
          style: value == null ? undefined : { background: series[i].color } }))),
      el('small', {}, `${series[i].data.filter(x => x != null).length}/${age}`))));
  const common = recent.length ? ages.filter(d => series.every(s => s.data[d] != null)).length : 0;
  root.append(chartCard({ title: '同龄对比', sub: `D0 = 发布当天 · ${requested.length ? '手动选择' : '自动选择最新'} ${recent.length} 支`,
    context: { game, locale, age, compared_videos: chosen, common_observed_days: common },
    controls: el('div', { class: 'curve-controls' }, segmented('同龄窗口', AGES, age, v => set({ age: v })), picker,
      el('span', { class: 'coverage-badge', title: '所选指标的共同有效观测；缺失不记为零' }, `共同 ${common}/${age} 天`), coverage),
    filename: `${game}-${locale}-by-age`,
    empty: series.some(s => s.data.some(v => v != null)) ? null : latest.length
      ? `当前所选视频在发布前 ${age} 天内没有有效指标观测。可延长同龄窗口或另选视频。`
      : '没有符合条件的视频',
    caveat: [missingStart.length ? `${missingStart.length} 支视频首次采到时已发布 ${Math.min(...starts)}–${Math.max(...starts)} 天（虚线），之前的起跑段没有数据，不从累计值倒推；中间漏采的日子留空，不连线。` : '',
             skipped ? `范围内另有 ${skipped} 支视频在前 ${age} 天内没有观测。` : ''].filter(Boolean).join('') ||
             (recent.every(v => v.first_obs_age === 0) ? '所选视频首次观测均为发布当天。' : '部分视频没有有效首次观测，不倒推缺失数据。'),
    chart: { type: 'line', x: ages.map(d => `D${d}`), series, format: fmt, axisFormat: metric === 'views' ? compact : v => `${v}%`,
             noEndLabels: series.length > 4, fitY: metric !== 'views' },
    columns: [{ key: 'age', label: '发布后' }, ...recent.map((v, i) => ({ key: v.video_id, label: series[i].name, num: true, format: fmt }))],
    rows: tableRows }));

  root.append(pairTable(store, game, selectedTypes, version, metric));
}

function videoColumns(store, latestId) {
  return [
    { key: 'title', label: '标题 / 原视频', wrap: true, format: (title, v) => el('a', { href: originalUrl(v), target: '_blank', rel: 'noopener noreferrer' }, title || v.video_id) },
    { key: 'content_type', label: '类型', format: v => dimText(store, 'content_type', v) },
    { key: 'version_id', label: '版本' },
    { key: 'pub_date', label: '发布日期' },
    { key: 'date', label: '最近采集' },
    { key: 'days_since_pub', label: '发布天数', num: true },
    { key: 'first_obs_age', label: '首次采到于发布后', num: true, format: v => (v == null ? '—' : v > 0 ? `第 ${v} 天（缺起跑段）` : '当天') },
    { key: latestId, label: store.catalog.metrics[latestId].label, num: true, format: v => metricText(store, latestId, v) },
  ];
}

// 语区对照：只并排展示，不相加
function pairTable(store, game, types, version, metric) {
  const availableLocales = new Set(store.distinct('v_video', 'locale', 'game_id = ? AND curated = 1', [game]));
  const localeOrder = store.catalog.dimensions.locale.order.filter(l => availableLocales.has(l));
  const contentTitles = new Map();
  for (const v of store.rows("SELECT pair_id, title FROM v_video WHERE game_id = ? AND pair_id IS NOT NULL ORDER BY CASE locale WHEN 'zh-cn' THEN 0 WHEN 'global' THEN 1 ELSE 2 END", [game])) {
    if (!contentTitles.has(v.pair_id)) contentTitles.set(v.pair_id, v.title);
  }
  const id = metric === 'views' ? 'latest_views' : 'latest_engagement';
  const rows = store.query({ metrics: [id], dims: ['pair_id', 'locale', 'character_name', 'content_type', 'version_id'],
    filters: [f.eq('game_id', game), f.in('content_type', types), { dim: 'pair_id', op: 'notnull' },
              ...(version ? [f.eq('version_id', version)] : [])] }).rows;
  const pairs = new Map();
  for (const r of rows) {
    const p = pairs.get(r.pair_id) || { pair_id: r.pair_id,
                                         name: !IMPORTANT.includes(r.content_type) && !r.character_name ? contentTitles.get(r.pair_id) || dimText(store, 'content_type', r.content_type)
                                           : [r.character_name, dimText(store, 'content_type', r.content_type)].filter(Boolean).join(' · '),
                                         version_id: r.version_id };
    p[r.locale] = r[id];
    pairs.set(r.pair_id, p);
  }
  const list = [...pairs.values()].sort((a, b) => compareVersions(b.version_id ?? '0', a.version_id ?? '0'));
  return tableCard({ title: '语区对照', sub: `固定展示所有语区的${metric === 'views' ? '最新累计播放' : '最新互动率'}，不受上方语区选择影响，只并排展示`,
    context: { scope: '所选游戏、内容类型与版本下，全部频道语区', selection: '此表固定展示全部频道语区', filters: { game, types, version, metric, locales: localeOrder } },
    caveat: `不同频道的订阅规模与推荐机制不同，频道语区不是观众所在地区。${metric === 'engagement' ? 'B 站与 YouTube 互动率公式不同，不直接比较。' : '各语区播放不相加。'}`,
    filename: `${game}-pairs`,
    columns: [{ key: 'name', label: '内容', wrap: true }, { key: 'version_id', label: '版本' },
              ...localeOrder.map(l => ({ key: l, label: dimLabel(store.catalog, store, 'locale', l), num: true,
                                         format: v => metricText(store, id, v) }))],
    rows: list });
}
