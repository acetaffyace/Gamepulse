// 版本分析只组织对象和窗口；指标仍通过统一查询生成器计算。
import { addDays, daysBetween } from './format.js';

export const subjectKey = v => `${v.game_id}@${v.version_id}`;

export function commonWindow(subjects, anchors, wanted) {
  const available = subjects.map(v => !anchors[v.game_id] || anchors[v.game_id] < v.start_date ? 0
    : Math.min(v.days, daysBetween(v.start_date, anchors[v.game_id]) + 1));
  const common = available.length ? Math.min(...available) : 0;
  const requested = [3, 7, 14, 30].includes(Number(wanted)) ? Number(wanted) : 14;
  return { common, days: wanted === 'all' ? common : Math.min(common, requested) };
}

const eq = (dim, value) => ({ dim, op: 'eq', value });
const between = (dim, from, to) => ({ dim, op: 'between', value: [from, to] });
const one = (store, metrics, filters) => store.query({ metrics, filters }).rows[0] || {};

export function periodMetrics(store, game, from, to) {
  const filters = [eq('game_id', game), between('date', from, to)];
  const anchor = store.reviewAnchor(game);
  const detailEnd = anchor && anchor < to ? anchor : to;
  return {
    ...one(store, ['daily_reviews', 'reviews_per_day', 'daily_positive_rate', 'review_days'], filters),
    ...one(store, ['avg_players', 'online_days'], filters),
    ...(anchor && anchor >= from
      ? one(store, ['playtime_median_h'], [eq('game_id', game), between('created_date', from, detailEnd)])
      : { playtime_median_h: null }),
  };
}

export function updateImpact(store, version) {
  const from = addDays(version.start_date, -7);
  const beforeEnd = addDays(version.start_date, -1);
  const afterEnd = addDays(version.start_date, 6);
  const before = periodMetrics(store, version.game_id, from, beforeEnd);
  const after = periodMetrics(store, version.game_id, version.start_date, afterEnd);
  const otherUpdates = store.versions(version.game_id).filter(v => v.start_date >= from && v.start_date <= afterEnd
    && v.version_id !== version.version_id);
  const complete = before.review_days === 7 && after.review_days === 7 && !otherUpdates.length;
  return { version, from, beforeEnd, afterEnd, before, after, otherUpdates, complete,
    onlineComplete: complete && before.online_days === 7 && after.online_days === 7 };
}

export function versionIntervals(versions) {
  return [...versions].sort((a, b) => a.start_date.localeCompare(b.start_date)).map((v, i, all) => ({
    ...v, previous: all[i - 1]?.version_id ?? null,
    interval: i ? daysBetween(all[i - 1].start_date, v.start_date) : null,
  }));
}

export function cadenceMetrics(store, game, versions) {
  // 旧发布库没有新增目录项时保留日期列表，均值留空，直到加载含新目录的发布包。
  if (!store.catalog.metrics.avg_version_interval || !versions.length) return {};
  return one(store, ['version_count', 'version_interval_count', 'avg_version_interval'],
    [eq('game_id', game), { dim: 'version_id', op: 'in', value: versions.map(v => v.version_id) }]);
}
