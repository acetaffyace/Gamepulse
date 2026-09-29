// 运营总览：一款游戏在所选时间范围内的评测、口碑、在线与官方视频。
// 一行指标卡共用同一个时间范围和截止日；某个来源没覆盖到这么晚时，在卡片上写明覆盖了几天。

import { addDays, compact, formatDelta, shortDate } from '../lib/format.js';
import { colorByOrder } from '../lib/palette.js';
import { chartCard, el, segmented, tableCard, tile } from '../lib/ui.js';
import { currentGame, f, gameColor, gameSelect, header, metricText, one, rangeDays, scopeLine, windowRange } from './shared.js';

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
    root.append(el('div', { class: 'empty' }, '这款游戏还没有评测数据。'));
    return;
  }

  const { start, end } = windowRange(anchor, days, first);
  const n = rangeDays(start, end);
  const prev = days === 'all' ? null : { start: addDays(start, -n), end: addDays(start, -1) };
  root.append(scopeLine(`统计范围 ${start} 至 ${end}，共 ${n} 天（北京时间）`,
    '截止日是最后一个完整的评测日，最后一次回填当天只统计到运行时刻，不计入',
    prev ? `变化与之前的 ${n} 天（${prev.start} 至 ${prev.end}）比较` : null));

  const inRange = (r, dim = 'date') => [f.eq('game_id', game), f.between(dim, r.start, r.end)];
  const daily = r => one(store, { metrics: ['daily_reviews', 'reviews_per_day', 'daily_positive_rate', 'review_days'],
    filters: inRange(r) });
  const online = r => one(store, { metrics: ['avg_players', 'online_days'], filters: inRange(r) });
  const playtime = r => one(store, { metrics: ['playtime_median_h'], filters: inRange(r, 'created_date') });
  const cur = { d: daily({ start, end }), o: online({ start, end }), p: playtime({ start, end }) };
  const old = prev ? { d: daily(prev), o: online(prev), p: playtime(prev) } : null;
  const m = id => store.catalog.metrics[id];
  const delta = (id, a, b) => (old ? formatDelta(m(id), a, b) : null);
  const onlineThrough = store.lastDate('v_online', game);
  const onlineComplete = cur.o.online_days === n && (!old || old.o.online_days === n);

  root.append(el('div', { class: 'tiles' },
    tile({ label: '评测数', value: metricText(store, 'daily_reviews', cur.d.daily_reviews), unit: '条',
           delta: delta('daily_reviews', cur.d.daily_reviews, old?.d.daily_reviews),
           note: '按创建日统计仍存续的评测' }),
    tile({ label: '日均评测数', value: metricText(store, 'reviews_per_day', cur.d.reviews_per_day), unit: '条/日',
           delta: delta('reviews_per_day', cur.d.reviews_per_day, old?.d.reviews_per_day) }),
    tile({ label: '好评率', value: metricText(store, 'daily_positive_rate', cur.d.daily_positive_rate),
           delta: delta('daily_positive_rate', cur.d.daily_positive_rate, old?.d.daily_positive_rate),
           note: '范围内好评 ÷ 评价已知的评测；不是商店显示的累计好评率' }),
    tile({ label: '日均同时在线（SteamDB）', value: metricText(store, 'avg_players', cur.o.avg_players), unit: '人',
           delta: onlineComplete ? delta('avg_players', cur.o.avg_players, old?.o.avg_players) : null,
           note: cur.o.online_days === n ? 'Steam 平台全天平均，不是 DAU'
             : `只覆盖 ${cur.o.online_days}/${n} 天：SteamDB 数据截至 ${onlineThrough || '—'}` }),
    tile({ label: '写评测时游戏时长（中位数）', value: metricText(store, 'playtime_median_h', cur.p.playtime_median_h), unit: '小时',
           delta: delta('playtime_median_h', cur.p.playtime_median_h, old?.p.playtime_median_h),
           note: '范围内全部评测的标准中位数' }),
  ));

  const events = store.rows("SELECT date, version_id, label FROM event WHERE game_id = ? AND type = 'version_update' "
    + 'AND date BETWEEN ? AND ? ORDER BY date', [game, start, end]);
  const markers = events.map(e => ({ x: e.date, label: `${e.version_id} 更新` }));
  const color = gameColor(store, game);

  const reviews = store.query({ metrics: ['daily_reviews', 'daily_positive_rate'], dims: ['date'], filters: inRange({ start, end }) }).rows;
  const dates = reviews.map(r => r.date);
  const grid = document.createElement('div');
  grid.className = 'grid-2';
  grid.append(
    chartCard({ title: '每日评测数', sub: '按评测创建日；没有评测的日子是 0', filename: `${game}-daily-reviews`,
      chart: { type: 'bar', x: dates, xFormat: shortDate, markers, series: [{ name: '评测数', color, data: reviews.map(r => r.daily_reviews) }],
               format: v => `${metricText(store, 'daily_reviews', v)} 条` },
      columns: [{ key: 'date', label: '日期' }, { key: 'daily_reviews', label: '评测数', num: true }], rows: reviews }),
    chartCard({ title: '每日好评率', sub: '评测少的日子波动大，请结合左图的评测数看', filename: `${game}-daily-positive-rate`,
      chart: { type: 'line', x: dates, xFormat: shortDate, markers, noEndLabels: true, fitY: true, percent: true,
               series: [{ name: '好评率', color, data: reviews.map(r => r.daily_positive_rate) }],
               format: v => metricText(store, 'daily_positive_rate', v), axisFormat: v => `${v}%`,
               tooltipExtra: i => `当天 ${reviews[i]?.daily_reviews ?? 0} 条评测` },
      columns: [{ key: 'date', label: '日期' }, { key: 'daily_reviews', label: '评测数', num: true },
                { key: 'daily_positive_rate', label: '好评率', num: true, format: v => metricText(store, 'daily_positive_rate', v) }],
      rows: reviews }),
  );
  root.append(grid);

  const onlineRows = store.query({ metrics: ['avg_players'], dims: ['date'], filters: inRange({ start, end }) }).rows;
  const byDate = Object.fromEntries(onlineRows.map(r => [r.date, r.avg_players]));
  const grid2 = document.createElement('div');
  grid2.className = 'grid-2';
  grid2.append(chartCard({ title: '日均同时在线', sub: `SteamDB 全天平均同时在线，数据截至 ${onlineThrough || '—'}；只代表 Steam 平台`,
    filename: `${game}-online`, empty: onlineRows.length ? null : '所选范围内没有 SteamDB 在线数据',
    chart: { type: 'line', x: dates, xFormat: shortDate, markers, noEndLabels: true,
             fitY: true, series: [{ name: '日均同时在线', color, data: dates.map(d => byDate[d] ?? null) }],
             format: v => `${metricText(store, 'avg_players', v)} 人`, axisFormat: compact },
    columns: [{ key: 'date', label: '日期' }, { key: 'avg_players', label: '日均同时在线', num: true, format: v => metricText(store, 'avg_players', v) }],
    rows: onlineRows }));

  const videos = store.query({ metrics: ['latest_views'], dims: ['locale', 'title', 'pub_date', 'content_type'],
    filters: [f.eq('game_id', game), f.between('pub_date', start, end), f.eq('locale', 'zh-cn')],
    order: [{ key: 'latest_views', desc: true }], limit: 8 }).rows;
  const locales = store.catalog.dimensions.locale.order;
  grid2.append(chartCard({ title: '范围内发布的官方视频（B 站）', sub: '最新累计播放；不同视频的发布天数不同，详见视频传播页',
    filename: `${game}-videos`, empty: videos.length ? null : '所选范围内没有发布精选范围内的官方视频',
    chart: { type: 'hbar', x: videos.map(v => v.title), labelWidth: 210, series: [{ name: '最新累计播放', color: colorByOrder(locales, 'zh-cn'),
             data: videos.map(v => v.latest_views) }], format: v => `${compact(v)} 次`, axisFormat: compact },
    columns: [{ key: 'title', label: '标题' }, { key: 'pub_date', label: '发布日期' },
              { key: 'latest_views', label: '最新累计播放', num: true, format: v => metricText(store, 'latest_views', v) }],
    rows: videos }));
  root.append(grid2);

  const versions = store.rows('SELECT version_id, start_date, end_date, days, is_open FROM v_version_window '
    + 'WHERE game_id = ? AND end_date >= ? AND start_date <= ? ORDER BY start_date DESC', [game, start, end]);
  root.append(tableCard({ title: '范围内的版本', sub: '版本窗口：本次 Steam 开放日至下个版本前一天；最新版本开放到今天',
    filename: `${game}-versions`,
    columns: [{ key: 'version_id', label: '版本' }, { key: 'start_date', label: 'Steam 开放日' },
              { key: 'end_date', label: '窗口结束', format: (v, r) => (r.is_open ? `${v}（进行中）` : v) },
              { key: 'days', label: '天数', num: true }],
    rows: versions }));
}
