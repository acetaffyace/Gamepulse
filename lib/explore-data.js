// 查询结果转成图形时仍要保留粒度、缺失和指标目录的拆分约束。
import { addDays, daysBetween } from './format.js';

export function fillAxis(type, xs, step = 1) {
  if (xs.length < 2 || !['date', 'integer'].includes(type)) return xs;
  const [first, last] = [xs[0], xs[xs.length - 1]];
  const span = type === 'date' ? daysBetween(first, last) : last - first;
  if (span > 3000) return xs;
  return Array.from({ length: Math.floor(span / step) + 1 }, (_, i) =>
    type === 'date' ? addDays(first, i * step) : first + i * step);
}

export function additive(metric) {
  return metric.kind === 'share' || (/^(COUNT|SUM)\(/.test(metric.agg.trim()) && !metric.agg.includes('/'));
}

export function canCombine(metric, split) {
  if (!additive(metric) || (metric.must_group_by || []).includes(split)) return false;
  const alternatives = metric.must_group_by_one_of || [];
  return !alternatives.length || alternatives.some(group => !group.includes(split));
}

// 任一成员缺失时无法得到完整合计，不能把缺失转换成0。
export function completeSum(values) {
  return values.some(v => v === null || v === undefined) ? null : values.reduce((a, b) => a + b, 0);
}

// 时点值以最后一个有效值排名，不能跨日期累加累计值或比率。
export function seriesScore(metric, values) {
  const known = values.filter(v => v !== null && v !== undefined);
  if (!known.length) return -Infinity;
  if (!additive(metric) || metric.kind === 'share' || (metric.must_group_by_one_of || []).length) {
    return Math.abs(known[known.length - 1]);
  }
  return known.reduce((total, value) => total + Math.abs(value), 0);
}
