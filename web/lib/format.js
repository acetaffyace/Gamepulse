// 数字与维度值的显示。数字格式由指标目录的 format 决定；维度值的中文名来自目录的 values。

const INT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const ONE = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const TWO = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatValue(value, format) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (format === 'integer') return INT.format(Math.round(value));
  if (format === 'decimal1') return ONE.format(value);
  if (format === 'percent') return `${TWO.format(value)}%`;
  return String(value);
}

// 大数字压缩显示：1.2 万、3.4 亿
export function compact(value) {
  if (value === null || value === undefined) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${ONE.format(value / 1e8)} 亿`;
  if (abs >= 1e4) return `${ONE.format(value / 1e4)} 万`;
  return INT.format(value);
}

export function formatMetric(metric, value) {
  const text = formatValue(value, metric.format);
  if (text === '—' || metric.format === 'percent') return text;
  return text;
}

// 变化：比率类用百分点，其余用相对百分比。变化本身不带好坏色，是否是好事由读者判断。
export function formatDelta(metric, current, previous) {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  if (metric.format === 'percent') {
    const pp = current - previous;
    return `${pp >= 0 ? '+' : '−'}${TWO.format(Math.abs(pp))} 个百分点`;
  }
  if (previous === 0) return null;
  const pct = (current - previous) / Math.abs(previous) * 100;
  return `${pct >= 0 ? '+' : '−'}${ONE.format(Math.abs(pct))}%`;
}

export function dimLabel(catalog, store, dim, value) {
  if (value === null || value === undefined) return '（空）';
  if (dim === 'game_id') return store?.gameById[value]?.display_name || String(value);
  const def = catalog.dimensions[dim] || {};
  if (def.values && def.values[String(value)] !== undefined) return def.values[String(value)];
  if (def.format) return def.format.replace('{}', value);
  if (def.type === 'boolean') return value ? '是' : '否';
  return String(value);
}

export function compareVersions(a, b) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(a)) && /^\d{4}-\d{2}-\d{2}$/.test(String(b))) {
    return String(a).localeCompare(String(b));
  }
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

export function shortDate(iso) {
  return iso ? iso.slice(5) : '';
}

export function dateAxisLabel(dates) {
  const years = new Set(dates.filter(Boolean).map(d => String(d).slice(0, 4)));
  return years.size > 1 ? iso => iso ? String(iso).slice(2) : '' : shortDate;
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}
