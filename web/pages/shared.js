// 各页面共用的筛选与表头。

import { addDays, compareVersions, daysBetween, dimLabel, formatValue } from '../lib/format.js';
import { themed } from '../lib/palette.js';
import { el, infoMenu, select } from '../lib/ui.js';

export function header(title, lead) {
  return [el('div', { class: 'page-heading' }, el('h1', { tabindex: '-1' }, title),
    lead ? infoMenu('说明', el('p', {}, lead)) : null)];
}

export function currentGame(store, params) {
  const id = params.get('game');
  return store.gameById[id] ? id : store.games[0].game_id;
}

export function gameColor(store, gameId) {
  return themed(store.gameById[gameId]?.color || '#2a78d6');
}

export function gameSelect(store, gameId, set) {
  return select('游戏', store.games.map(g => ({ value: g.game_id, label: g.display_name })), gameId,
    v => set({ game: v, a: null, b: null, version: null, pair: null, player_versions: null, curve_ids: null }));
}

export function sortedVersions(store, gameId) {
  return [...store.versions(gameId)].sort((x, y) => compareVersions(x.version_id, y.version_id));
}

// 版本已有多少个"完整日"可比：开放中的版本截到最后一个完整的评测日
export function availableDays(version, anchor) {
  if (!anchor || anchor < version.start_date) return 0;
  return Math.min(version.days, daysBetween(version.start_date, anchor) + 1);
}

export function rangeDays(from, to) {
  return daysBetween(from, to) + 1;
}

export function windowRange(anchor, days, first) {
  const start = days === 'all' ? first : addDays(anchor, -(Number(days) - 1));
  return { start: first && start < first ? first : start, end: anchor };
}

export function metricText(store, id, value) {
  return formatValue(value, store.catalog.metrics[id].format);
}

// 仅缩短界面名称，指标目录、SQL 与导出列名保持完整。
export function shortMetricLabel(id, metric) {
  return { daily_reviews: '评测数', review_count: '评测数', daily_positive_rate: '好评率', positive_rate: '好评率',
    reviews_per_day: '日均评测', review_days: '覆盖天数', avg_players: '日均在线', online_days: '在线天数',
    review_share: '评测占比', playtime_median_h: '时长中位数', playtime_p25_h: '时长P25', playtime_p75_h: '时长P75',
    playtime_sample_count: '时长样本', rated_count: '评价样本', post_review_sample_count: '后续样本',
    still_playing_share: '评测后游玩', post_review_median_h: '后续时长', short_play_share: '短时占比',
    latest_views: '累计播放', video_views: '累计播放', latest_engagement: '互动率', video_engagement: '互动率',
    version_count: '开放版本', version_interval_count: '有效间隔', avg_version_interval: '平均间隔',
  }[id] || metric.label.replace(/（[^）]*）/g, '');
}

export function dimText(store, dim, value) {
  return dimLabel(store.catalog, store, dim, value);
}

export function scopeLine(...parts) {
  const valid = parts.filter(Boolean);
  return el('div', { class: 'scope', 'data-full-scope': valid.join(' · ') },
    el('span', { class: 'scope-label' }, valid[0]),
    valid.length > 1 ? infoMenu('口径', valid.slice(1).map(text => el('p', {}, text))) : null);
}

// 一次查询只取一行时的便捷写法
export function one(store, spec) {
  return store.query(spec).rows[0] || {};
}

export const f = {
  eq: (dim, value) => ({ dim, op: 'eq', value }),
  in: (dim, value) => ({ dim, op: 'in', value }),
  between: (dim, a, b) => ({ dim, op: 'between', value: [a, b] }),
};
