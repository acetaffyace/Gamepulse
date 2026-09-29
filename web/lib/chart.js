// ECharts 封装：所有图表共用同一套标记规格与交互（见 dataviz 规范）。
//   线 2px；柱最宽 24px、数据端 4px 圆角；网格线为实线细线；一张图只有一根纵轴。
//   两个及以上系列一定有图例，四条以内的折线在线尾直接标名称；提示框列出同一横坐标下的全部系列。
//   标签都是数据，放进提示框前一律转义。

import { cssVar, otherColor } from './palette.js';

const charts = new Set();

export function disposeAll() {
  for (const c of charts) c.dispose();
  charts.clear();
}

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function theme() {
  return { ink: cssVar('--ink'), ink2: cssVar('--ink-2'), muted: cssVar('--muted'), grid: cssVar('--grid'),
           axis: cssVar('--axis'), surface: cssVar('--surface') };
}

function tooltipBox(t) {
  return { backgroundColor: t.surface, borderColor: t.axis, borderWidth: 1, padding: [8, 10],
           textStyle: { color: t.ink, fontSize: 12 }, extraCssText: 'box-shadow: 0 4px 14px rgba(0,0,0,.12); border-radius: 8px;' };
}

function key(color, line) {
  return line
    ? `<span style="display:inline-block;width:12px;height:2px;background:${color};vertical-align:3px;margin-right:6px"></span>`
    : `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${color};margin-right:6px"></span>`;
}

// spec: { type: line|bar|stacked|stacked100|hbar, x: [类目], xName, series: [{ name, color, data, dashed }],
//         format: 数值 → 文本, axisFormat, markers: [{ x, label }], yMin, log, height }
export function renderChart(el, spec) {
  let chart = echarts.getInstanceByDom(el);
  if (!chart) {
    chart = echarts.init(el, null, { renderer: 'canvas' });
    charts.add(chart);
    new ResizeObserver(() => chart.resize()).observe(el);
  }
  const t = theme();
  const fmt = spec.format || (v => v);
  const axisFmt = spec.axisFormat || fmt;
  const isLine = spec.type === 'line';
  const horizontal = spec.type === 'hbar';
  const stacked = spec.type === 'stacked' || spec.type === 'stacked100';
  const many = spec.series.length >= 2;
  const directLabels = isLine && spec.series.length <= 4 && !spec.noEndLabels;

  const series = spec.series.map((s, i) => {
    const base = { name: s.name, data: s.data, itemStyle: { color: s.color }, emphasis: { focus: 'series' } };
    if (isLine) {
      // 缺采的日子留空、不连线；前后都缺的孤立点只有画出圆点才看得见
      const isolated = s.data.some((v, j) => v !== null && v !== undefined
        && (s.data[j - 1] ?? null) === null && (s.data[j + 1] ?? null) === null);
      return { ...base, type: 'line', showSymbol: isolated, symbol: 'circle', symbolSize: 8, connectNulls: false,
        lineStyle: { width: 2, type: s.dashed ? 'dashed' : 'solid', color: s.color, cap: 'round', join: 'round' },
        endLabel: directLabels ? { show: true, formatter: p => s.name, color: t.ink2, fontSize: 11 } : undefined,
        markLine: i === 0 && spec.markers?.length ? markerLines(spec.markers, t) : undefined };
    }
    return { ...base, type: 'bar', barMaxWidth: 24, stack: stacked ? 'total' : undefined,
      itemStyle: { color: s.color, borderRadius: stacked ? 0 : (horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]),
                   borderColor: stacked ? t.surface : undefined, borderWidth: stacked ? 1 : 0 },
      markLine: i === 0 && spec.markers?.length ? markerLines(spec.markers, t) : undefined };
  });

  const category = { type: 'category', data: spec.x, name: spec.xName, nameLocation: 'end', nameGap: 8,
    nameTextStyle: { color: t.muted, fontSize: 11, align: 'right', verticalAlign: 'top', padding: [22, 0, 0, 0] },
    axisLine: { lineStyle: { color: t.axis } }, axisTick: { show: false },
    axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true, formatter: spec.xFormat },
    boundaryGap: !isLine };
  // 折线不必从 0 开始（spec.fitY 时由 ECharts 按数据范围选整齐的刻度），柱状图的长度就是数值，始终从 0 开始。
  // 百分比数据接近 100% 时把上限固定为 100%，避免出现 105% 这种不存在的刻度。
  const dataMax = Math.max(...spec.series.flatMap(s => s.data).filter(v => typeof v === 'number'));
  const value = { type: spec.log ? 'log' : 'value', min: spec.yMin, scale: Boolean(spec.fitY),
    max: spec.type === 'stacked100' || (spec.percent && dataMax > 95) ? 100 : undefined,
    splitLine: { lineStyle: { color: t.grid, type: 'solid', width: 1 } },
    axisLabel: { color: t.muted, fontSize: 11, formatter: v => axisFmt(v) }, axisLine: { show: false } };

  chart.setOption({
    animation: false,
    textStyle: { fontFamily: getComputedStyle(document.body).fontFamily },
    grid: { left: horizontal ? 8 : 12, right: directLabels ? 88 : 20, top: many ? 36 : 16, bottom: 24, containLabel: true },
    legend: many ? { show: true, top: 0, left: 0, icon: isLine ? 'path://M0,4 L14,4 L14,6 L0,6 Z' : 'roundRect',
      itemWidth: 14, itemHeight: isLine ? 6 : 10, textStyle: { color: t.ink2, fontSize: 12 }, type: 'scroll' } : { show: false },
    tooltip: {
      trigger: horizontal ? 'item' : 'axis', ...tooltipBox(t),
      axisPointer: { type: isLine ? 'line' : 'shadow', lineStyle: { color: t.axis }, shadowStyle: { color: 'rgba(127,127,127,.08)' } },
      formatter: params => {
        const list = Array.isArray(params) ? params : [params];
        const head = escapeHtml(horizontal ? list[0].name : (spec.tooltipTitle ? spec.tooltipTitle(list[0].axisValue) : list[0].axisValue));
        const rows = list.filter(p => p.value !== null && p.value !== undefined && p.value !== '-')
          .map(p => `<div>${key(p.color, isLine)}<strong>${escapeHtml(fmt(Array.isArray(p.value) ? p.value[1] : p.value))}</strong>`
            + ` <span style="color:${t.ink2}">${escapeHtml(horizontal && !many ? '' : p.seriesName)}</span></div>`);
        const extra = spec.tooltipExtra ? spec.tooltipExtra(list[0].dataIndex) : '';
        return `<div style="margin-bottom:4px;color:${t.ink2}">${head}</div>${rows.join('') || '<div>没有数据</div>'}`
          + (extra ? `<div style="margin-top:4px;color:${t.muted}">${escapeHtml(extra)}</div>` : '');
      },
    },
    xAxis: horizontal ? value : category,
    yAxis: horizontal ? { ...category, inverse: true, boundaryGap: true,
      axisLabel: { color: t.ink2, fontSize: 12, width: spec.labelWidth || 140, overflow: 'truncate' } } : value,
    series,
  }, true);
  return chart;
}

function markerLines(markers, t) {
  return {
    symbol: 'none', silent: true, animation: false,
    lineStyle: { color: t.axis, type: 'solid', width: 1 },
    label: { formatter: p => p.name, color: t.muted, fontSize: 10, position: 'insideEndTop' },
    data: markers.map(m => ({ xAxis: m.x, name: m.label })),
  };
}

export function exportPng(el, filename) {
  const chart = echarts.getInstanceByDom(el);
  if (!chart) return;
  const url = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: cssVar('--surface') });
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
}

export { otherColor };
