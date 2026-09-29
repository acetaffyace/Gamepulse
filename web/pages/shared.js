// 各页面共用的筛选与表头。

import { addDays, compareVersions, daysBetween, dimLabel, formatValue } from '../lib/format.js';
import { themed } from '../lib/palette.js';
import { el, select } from '../lib/ui.js';

export function header(title, lead) {
  return [el('h1', {}, title), lead ? el('p', { class: 'page-lead' }, lead) : null];
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
    v => set({ game: v, a: null, b: null, version: null, pair: null }));
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

export function dimText(store, dim, value) {
  return dimLabel(store.catalog, store, dim, value);
}

export function scopeLine(...parts) {
  return el('p', { class: 'scope' }, parts.filter(Boolean).join(' · '));
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
