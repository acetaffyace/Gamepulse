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

export function render({ store, root, params, set }) {
  const game = currentGame(store, params);
  const localeOrder = store.catalog.dimensions.locale.order;
  const locale = localeOrder.includes(params.get('locale')) ? params.get('locale') : 'zh-cn';
  const types = (params.get('types') || '').split(',').filter(t => IMPORTANT.includes(t));
  const selectedTypes = types.length ? types : IMPORTANT;
  const versions = sortedVersions(store, game);
  const version = versions.some(v => v.version_id === params.get('version')) ? params.get('version') : '';
  const metric = params.get('metric') === 'engagement' ? 'engagement' : 'views';
  const age = AGES.some(a => String(a.value) === params.get('age')) ? Number(params.get('age')) : 30;

  root.append(...header('视频传播', '精选范围内的官方视频（版本 PV、角色 PV、角色演示、角色 EP），按频道语区分开看。'));
  root.append(el('div', { class: 'filters' }, gameSelect(store, game, set),
    segmented('频道语区', localeOrder.map(l => ({ value: l, label: dimText(store, 'locale', l) })), locale, v => set({ locale: v })),
    chips('内容类型', IMPORTANT.map(t => ({ value: t, label: dimText(store, 'content_type', t) })), selectedTypes,
      v => set({ types: v.length === IMPORTANT.length ? null : v })),
    select('版本', [{ value: '', label: '全部版本' }, ...versions.map(v => ({ value: v.version_id, label: v.version_id }))],
      version, v => set({ version: v })),
    segmented('指标', [{ value: 'views', label: '累计播放' }, { value: 'engagement', label: '互动率' }], metric, v => set({ metric: v })),
    segmented('同龄对比', AGES, age, v => set({ age: v }))));

  const base = [f.eq('game_id', game), f.eq('locale', locale), f.in('content_type', selectedTypes),
                ...(version ? [f.eq('version_id', version)] : [])];
  const latestId = metric === 'views' ? 'latest_views' : 'latest_engagement';
  const obsId = metric === 'views' ? 'video_views' : 'video_engagement';
  const fmt = v => (metric === 'views' ? `${compact(v)} 次` : metricText(store, obsId, v));
  const engagementNote = locale === 'zh-cn' ? '互动率 =（点赞 + 投币 + 收藏）÷ 播放' : '互动率 =（点赞 + 评论）÷ 播放';
  root.append(scopeLine(`频道语区：${dimText(store, 'locale', locale)}`,
    metric === 'engagement' ? `${engagementNote}；B 站与 YouTube 公式不同，不能直接比较` : '累计播放是观看次数，不是独立观众数'));

  const latest = store.query({ metrics: [latestId, 'latest_views'], dims: ['video_id', 'title', 'character_name', 'pub_date', 'content_type',
    'version_id', 'days_since_pub', 'first_obs_age', 'date'], filters: base, order: [{ key: latestId, desc: true }] }).rows;
  const ranked = latest.slice(0, 15);
  const color = colorByOrder(localeOrder, locale);
  root.append(chartCard({ title: metric === 'views' ? '最新累计播放' : '最新互动率',
    sub: '每支视频最近一次采到的值；发布越早的视频累计时间越长，只适合粗看', filename: `${game}-${locale}-latest`,
    empty: ranked.length ? null : '没有符合条件的视频',
    chart: { type: 'hbar', x: ranked.map(v => v.title), labelWidth: window.innerWidth < 600 ? 120 : 260,
             series: [{ name: metric === 'views' ? '最新累计播放' : '最新互动率', color, data: ranked.map(v => v[latestId]) }],
             format: fmt, axisFormat: metric === 'views' ? compact : v => `${v}%` },
    columns: videoColumns(store, latestId), rows: latest }));

  // 发布后同龄：只取在 D0…D(age-1) 内确实有观测的视频（多数视频是发布后才登记的），取发布最晚的几支，按发布先后固定配色
  const inWindow = latest.filter(v => v.first_obs_age !== null && v.first_obs_age < age);
  const recent = [...inWindow].sort((x, y) => (y.pub_date || '').localeCompare(x.pub_date || '')).slice(0, CURVES)
    .sort((x, y) => (x.pub_date || '').localeCompare(y.pub_date || ''));
  const curveRows = recent.length ? store.query({ metrics: [obsId], dims: ['video_id', 'days_since_pub'],
    filters: [...base, f.in('video_id', recent.map(v => v.video_id)), f.between('days_since_pub', 0, age - 1)] }).rows : [];
  const ages = Array.from({ length: age }, (_, i) => i);
  const series = recent.map((v, i) => {
    const byAge = Object.fromEntries(curveRows.filter(r => r.video_id === v.video_id).map(r => [r.days_since_pub, r[obsId]]));
    return { name: `${v.character_name ? `${v.character_name} ` : ''}${dimText(store, 'content_type', v.content_type)} · ${shortDate(v.pub_date)}`,
             color: slot(i), dashed: v.first_obs_age > 0, data: ages.map(d => byAge[d] ?? null) };
  });
  const missingStart = recent.filter(v => v.first_obs_age > 0);
  const tableRows = ages.map(d => Object.fromEntries([['age', `D${d}`], ...recent.map((v, i) => [v.video_id, series[i].data[d]])]));
  const skipped = latest.length - inWindow.length;
  const starts = missingStart.map(v => v.first_obs_age);
  root.append(chartCard({ title: '发布后同龄对比', sub: `按发布后第几天对齐（D0 = 发布当天），发布最晚的 ${recent.length} 支`,
    filename: `${game}-${locale}-by-age`,
    empty: curveRows.length ? null : latest.length
      ? `符合条件的 ${latest.length} 支视频都是在发布 ${age} 天之后才开始采集，没有这一段的数据。可以把"同龄对比"调到更长的天数。`
      : '没有符合条件的视频',
    caveat: [missingStart.length ? `${missingStart.length} 支视频首次采到时已发布 ${Math.min(...starts)}–${Math.max(...starts)} 天（虚线），之前的起跑段没有数据，不从累计值倒推；中间漏采的日子留空，不连线。` : '',
             skipped ? `另有 ${skipped} 支视频在前 ${age} 天内没有任何观测，未画出。` : ''].filter(Boolean).join('') || '所有曲线都从发布当天开始采集。',
    chart: { type: 'line', x: ages.map(d => `D${d}`), series, format: fmt, axisFormat: metric === 'views' ? compact : v => `${v}%`,
             noEndLabels: series.length > 4, fitY: metric !== 'views' },
    columns: [{ key: 'age', label: '发布后' }, ...recent.map((v, i) => ({ key: v.video_id, label: series[i].name, num: true, format: fmt }))],
    rows: tableRows }));

  root.append(pairTable(store, game, selectedTypes, version, metric));
}

function videoColumns(store, latestId) {
  return [
    { key: 'title', label: '标题' },
    { key: 'content_type', label: '类型', format: v => dimText(store, 'content_type', v) },
    { key: 'version_id', label: '版本' },
    { key: 'pub_date', label: '发布日期' },
    { key: 'date', label: '最近采集' },
    { key: 'days_since_pub', label: '发布天数', num: true },
    { key: 'first_obs_age', label: '首次采到于发布后', num: true, format: v => (v > 0 ? `第 ${v} 天（缺起跑段）` : '当天') },
    { key: latestId, label: store.catalog.metrics[latestId].label, num: true, format: v => metricText(store, latestId, v) },
  ];
}

// 同一内容在各语区：只并排展示，不相加
function pairTable(store, game, types, version, metric) {
  const localeOrder = store.catalog.dimensions.locale.order;
  const id = metric === 'views' ? 'latest_views' : 'latest_engagement';
  const rows = store.query({ metrics: [id], dims: ['pair_id', 'locale', 'character_name', 'content_type', 'version_id'],
    filters: [f.eq('game_id', game), f.in('content_type', types), { dim: 'pair_id', op: 'notnull' },
              ...(version ? [f.eq('version_id', version)] : [])] }).rows;
  const pairs = new Map();
  for (const r of rows) {
    const p = pairs.get(r.pair_id) || { pair_id: r.pair_id,
                                         name: [r.character_name, dimText(store, 'content_type', r.content_type)].filter(Boolean).join(' · '),
                                         version_id: r.version_id };
    p[r.locale] = r[id];
    pairs.set(r.pair_id, p);
  }
  const list = [...pairs.values()].sort((a, b) => compareVersions(b.version_id ?? '0', a.version_id ?? '0'));
  return tableCard({ title: '同一内容在各语区', sub: `同一支内容在 B 站与 YouTube 各语区频道的${metric === 'views' ? '最新累计播放' : '最新互动率'}，只并排展示、不相加`,
    caveat: '不同语区频道的订阅规模、推荐机制不同；频道语区是"发给谁看"，不是观众所在地区。',
    filename: `${game}-pairs`,
    columns: [{ key: 'name', label: '内容' }, { key: 'version_id', label: '版本' },
              ...localeOrder.map(l => ({ key: l, label: dimLabel(store.catalog, store, 'locale', l), num: true,
                                         format: v => metricText(store, id, v) }))],
    rows: list });
}
