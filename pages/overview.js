// 运营总览：一款游戏在所选时间范围内的评测、口碑、在线与官方视频。
// 一行指标卡共用同一个时间范围和截止日；某个来源没覆盖到这么晚时，在卡片上写明覆盖了几天。

import { addDays, compact, dateAxisLabel, formatDelta } from '../lib/format.js';
import { colorByOrder } from '../lib/palette.js';
import { chartCard, el, emptyState, infoMenu, segmented, tableCard, tile } from '../lib/ui.js';
import { currentGame, dimText, f, gameColor, gameSelect, header, metricText, one, rangeDays, scopeLine, windowRange } from './shared.js';

const WINDOWS = [{ value: 7, label: '7 天' }, { value: 14, label: '14 天' }, { value: 30, label: '30 天' },
                 { value: 90, label: '90 天' }, { value: 'all', label: '全部' }];

export function render({ store, root, params, set }) {
  const game = currentGame(store, params);
  const days = WINDOWS.some(w => String(w.value) === params.get('days')) ? (params.get('days') === 'all' ? 'all' : Number(params.get('days'))) : 30;
  const anchor = store.reviewAnchor(game);
  const first = store.scalar('SELECT MIN(date) FROM v_review_daily WHERE game_id = ?', [game]);
  const g = store.gameById[game];

  root.append(...header('运营总览', `${g.display_name}（${g.developer || ''}）：评测、口碑、Steam 在线与官方视频，放在同一个时间范围里看。`));
  root.append(el('div', { class: 'filters' }, gameSelect(store, game, set),
    segmented('时间范围', WINDOWS, days, v => set({ days: v }))));
  if (!anchor) {
    root.append(emptyState('尚无评测观测', [{ label: '数据来源', href: `?page=sources&source_game=${game}` }]));
    return;
  }

  const { start, end } = windowRange(anchor, days, first);
  const n = rangeDays(start, end);
  // 之前的同样天数必须完整落在评测数据范围内才比较，否则"变化"是拿空白日子比出来的
  const candidate = days === 'all' ? null : { start: addDays(start, -n), end: addDays(start, -1) };
  const prev = candidate && candidate.start >= first ? candidate : null;

  const inRange = (r, dim = 'date') => [f.eq('game_id', game), f.between(dim, r.start, r.end)];
  const daily = r => one(store, { metrics: ['daily_reviews', 'reviews_per_day', 'daily_positive_rate', 'review_days'],
    filters: inRange(r) });
  const online = r => one(store, { metrics: ['avg_players', 'online_days'], filters: inRange(r) });
  const playtime = r => one(store, { metrics: ['playtime_median_h', 'positive_count', 'negative_count'], filters: inRange(r, 'created_date') });
  const cur = { d: daily({ start, end }), o: online({ start, end }), p: playtime({ start, end }) };
  const old = prev ? { d: daily(prev), o: online(prev), p: playtime(prev) } : null;
  const m = id => store.catalog.metrics[id];
  const delta = (id, a, b) => (old ? formatDelta(m(id), a, b) : null);
  const onlineThrough = store.lastDate('v_online', game);
  const onlineComplete = cur.o.online_days === n && (!old || old.o.online_days === n);
  const reviewsComplete = cur.d.review_days === n && (!old || old.d.review_days === n);
  root.append(el('div', { class: 'context-row' },
    scopeLine(`${start} – ${end} · 共 ${n} 天`, `${g.display_name} · 北京时间；完整评测日截至 ${end}`),
    infoMenu(cur.o.online_days !== n || cur.d.review_days !== n ? '覆盖不足' : '覆盖',
      el('dl', { class: 'facts' },
        el('dt', {}, '评测'), el('dd', {}, `${cur.d.review_days ?? 0}/${n} 天`),
        el('dt', {}, 'Steam 在线'), el('dd', {}, `${cur.o.online_days ?? 0}/${n} 天 · ${onlineThrough || '—'}`),
        el('dt', {}, '评价样本'), el('dd', {}, `${(cur.p.positive_count ?? 0) + (cur.p.negative_count ?? 0)} 条`),
        el('dt', {}, '日均评测'), el('dd', {}, metricText(store, 'reviews_per_day', cur.d.reviews_per_day)),
        el('dt', {}, '时长中位数'), el('dd', {}, `${metricText(store, 'playtime_median_h', cur.p.playtime_median_h)} 小时`)),
      el('p', {}, prev ? `对照 ${prev.start} – ${prev.end}，共 ${n} 天` : '暂无完整前期对照'),
      el('p', {}, '好评率按窗口合计；趋势“点”为百分点；Steam 在线不是 DAU。'),
      el('a', { href: `?page=sources&source_game=${game}` }, '数据来源'))));

  root.append(el('div', { class: 'tiles primary-tiles' },
    tile({ label: '评测数', metric: 'daily_reviews', value: metricText(store, 'daily_reviews', cur.d.daily_reviews), unit: '条',
           delta: reviewsComplete ? delta('daily_reviews', cur.d.daily_reviews, old?.d.daily_reviews) : null,
           note: `日均 ${metricText(store, 'reviews_per_day', cur.d.reviews_per_day)} 条 · 按创建日统计仍存续评测` }),
    tile({ label: '好评率', metric: 'daily_positive_rate', value: metricText(store, 'daily_positive_rate', cur.d.daily_positive_rate),
           delta: reviewsComplete ? delta('daily_positive_rate', cur.d.daily_positive_rate, old?.d.daily_positive_rate) : null,
           note: `${(cur.p.positive_count ?? 0) + (cur.p.negative_count ?? 0)} 条评价已知的评测 · 窗口合计比率` }),
    tile({ label: '日均在线', metric: 'avg_players', status: cur.o.online_days === n ? null : 'partial',
           value: metricText(store, 'avg_players', cur.o.avg_players), unit: '人',
           delta: onlineComplete ? delta('avg_players', cur.o.avg_players, old?.o.avg_players) : null,
           note: `有效覆盖 ${cur.o.online_days ?? 0}/${n} 天 · 截至 ${onlineThrough || '—'} · 不是 DAU` }),
  ));
  root.append(el('nav', { class: 'analysis-links', 'aria-label': '进一步分析' },
    el('a', { href: `?page=versions&game=${game}` }, '版本对比 →'),
    el('a', { href: `?page=players&game=${game}` }, '玩家结构 →'),
    el('a', { href: `?page=videos&game=${game}` }, '视频传播 →')));

  const events = store.rows("SELECT date, version_id, label FROM event WHERE game_id = ? AND type = 'version_update' "
    + 'AND date BETWEEN ? AND ? ORDER BY date', [game, start, end]);
  const markers = events.map(e => ({ x: e.date, label: `${e.version_id} 更新` }));
  const color = gameColor(store, game);

  const reviews = store.query({ metrics: ['daily_reviews', 'daily_positive_rate'], dims: ['date'], filters: inRange({ start, end }) }).rows;
  const dates = reviews.map(r => r.date);
  const axisLabel = dateAxisLabel(dates);
  const counts = store.query({ metrics: ['positive_count', 'negative_count'], dims: ['created_date'], filters: inRange({ start, end }, 'created_date') }).rows;
  const known = Object.fromEntries(counts.map(r => [r.created_date, (r.positive_count ?? 0) + (r.negative_count ?? 0)]));
  const grid = document.createElement('div');
  grid.className = 'grid-2';
  grid.append(
    chartCard({ title: '每日评测数', tone: 'yellow', sub: '按评测创建日；没有评测的日子是 0', filename: `${game}-daily-reviews`,
      chart: { type: 'bar', x: dates, xFormat: axisLabel, markers, series: [{ name: '评测数', color, data: reviews.map(r => r.daily_reviews) }],
               format: v => `${metricText(store, 'daily_reviews', v)} 条` },
      columns: [{ key: 'date', label: '日期' }, { key: 'daily_reviews', label: '评测数', num: true }], rows: reviews }),
    chartCard({ title: '每日好评率', tone: 'pink', sub: '悬停可查看当天评测数与有效评价样本', filename: `${game}-daily-positive-rate`,
      chart: { type: 'line', x: dates, xFormat: axisLabel, markers, noEndLabels: true, fitY: true, percent: true,
               series: [{ name: '好评率', color, data: reviews.map(r => r.daily_positive_rate) }],
               format: v => metricText(store, 'daily_positive_rate', v), axisFormat: v => `${v}%`,
               tooltipExtra: i => `当天 ${reviews[i]?.daily_reviews ?? 0} 条评测 · 评价已知 ${known[dates[i]] ?? 0} 条` },
      columns: [{ key: 'date', label: '日期' }, { key: 'daily_reviews', label: '评测数', num: true },
                { key: 'daily_positive_rate', label: '好评率', num: true, format: v => metricText(store, 'daily_positive_rate', v) }],
      rows: reviews }),
  );
  root.append(grid);

  const onlineRows = store.query({ metrics: ['avg_players'], dims: ['date'], filters: inRange({ start, end }) }).rows;
  const byDate = Object.fromEntries(onlineRows.map(r => [r.date, r.avg_players]));
  const grid2 = document.createElement('div');
  grid2.className = 'grid-2';
  const monthly = onlineRows.length ? [] : store.query({ metrics: ['monthly_avg_players', 'monthly_peak_players'], dims: ['month_start'],
    filters: [f.eq('game_id', game), f.between('month_start', start.slice(0, 7) + '-01', end)] }).rows;
  if (monthly.length) {
    grid2.append(chartCard({ title: '自然月在线参考', tone: 'cyan', filename: `${game}-monthly-online`,
      sub: 'SteamCharts 已结束自然月的平均同时在线；包含起点所在整月，不是上方窗口的日均在线，也不是 DAU。',
      context: { game, start, end, source: 'SteamCharts', grain: '已结束自然月' },
      chart: { type: 'bar', x: monthly.map(r => r.month_start.slice(0, 7)),
        series: [{ name: '月平均同时在线', color, data: monthly.map(r => r.monthly_avg_players) }],
        format: v => `${metricText(store, 'monthly_avg_players', v)} 人`, axisFormat: compact },
      columns: [{ key: 'month_start', label: '自然月起始日' },
        { key: 'monthly_avg_players', label: '月平均同时在线', num: true, format: v => metricText(store, 'monthly_avg_players', v) },
        { key: 'monthly_peak_players', label: '月峰值同时在线', num: true, format: v => metricText(store, 'monthly_peak_players', v) }], rows: monthly }));
  } else {
  grid2.append(chartCard({ title: '日均同时在线', tone: 'cyan', sub: `SteamDB 全天平均同时在线，数据截至 ${onlineThrough || '—'}；只代表 Steam 平台`,
    filename: `${game}-online`, empty: onlineRows.length ? null : '尚无 SteamDB 在线观测',
    emptyActions: [{ label: '数据来源', href: `?page=sources&source_game=${game}` }],
    chart: { type: 'line', x: dates, xFormat: axisLabel, markers, noEndLabels: true,
             fitY: true, series: [{ name: '日均同时在线', color, data: dates.map(d => byDate[d] ?? null) }],
             format: v => `${metricText(store, 'avg_players', v)} 人`, axisFormat: compact },
    columns: [{ key: 'date', label: '日期' }, { key: 'avg_players', label: '日均同时在线', num: true, format: v => metricText(store, 'avg_players', v) }],
    rows: onlineRows }));
  }

  const videos = store.query({ metrics: ['latest_views'], dims: ['locale', 'title', 'pub_date', 'content_type', 'character_name', 'version_id'],
    filters: [f.eq('game_id', game), f.between('pub_date', start, end), f.eq('locale', 'zh-cn')],
    order: [{ key: 'latest_views', desc: true }], limit: 8 }).rows;
  const locales = store.catalog.dimensions.locale.order;
  grid2.append(chartCard({ title: '官方视频', tone: 'pink', sub: 'B 站 · 最新累计播放；发布年龄不同。',
    filename: `${game}-videos`, empty: videos.length ? null : '时间范围内没有精选的 B 站官方视频',
    emptyActions: [{ label: '全部视频', href: `?page=videos&game=${game}` }, { label: '全部日期', href: `?page=overview&game=${game}&days=all` }],
    chart: { type: 'hbar', x: videos.map(v => [v.character_name || v.version_id, dimText(store, 'content_type', v.content_type)].filter(Boolean).join(' · ')),
             labelWidth: window.innerWidth < 600 ? 110 : 180, tooltipTitle: (_, i) => videos[i]?.title,
             series: [{ name: '最新累计播放', color: colorByOrder(locales, 'zh-cn'),
             data: videos.map(v => v.latest_views) }], format: v => `${compact(v)} 次`, axisFormat: compact },
    columns: [{ key: 'title', label: '标题' }, { key: 'pub_date', label: '发布日期' },
              { key: 'latest_views', label: '最新累计播放', num: true, format: v => metricText(store, 'latest_views', v) }],
    rows: videos }));
  root.append(grid2);

  const versions = store.rows('SELECT version_id, start_date, end_date, days, is_open FROM v_version_window '
    + 'WHERE game_id = ? AND end_date >= ? AND start_date <= ? ORDER BY start_date DESC', [game, start, end]);
  root.append(tableCard({ title: '范围内的版本', sub: '版本窗口：本次 Steam 开放日至下个版本前一天；最新版本开放到今天',
    filename: `${game}-versions`,
    columns: [{ key: 'version_id', label: '版本', format: v => el('a', { href: `?page=versions&game=${game}&b=${encodeURIComponent(v)}` }, v) }, { key: 'start_date', label: 'Steam 开放日' },
              { key: 'end_date', label: '窗口结束', format: (v, r) => (r.is_open ? `${v}（进行中）` : v) },
              { key: 'days', label: '天数', num: true }],
    rows: versions }));
}
