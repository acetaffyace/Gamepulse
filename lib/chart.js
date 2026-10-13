// ECharts 封装：所有图表共用同一套标记规格与交互（见 dataviz 规范）。
//   线 2px；柱最宽 24px、数据端 4px 圆角；网格线为实线细线；一张图只有一根纵轴。
//   两个及以上系列一定有图例，四条以内的折线在线尾直接标名称；提示框列出同一横坐标下的全部系列。
//   标签都是数据，放进提示框前一律转义。

import { cssVar, otherColor } from './palette.js';

const charts = new Set();
const observers = new Map();

export function disposeAll() {
  for (const c of charts) { observers.get(c)?.disconnect(); c.dispose(); }
  charts.clear();
  observers.clear();
}

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function theme() {
  return { ink: cssVar('--ink'), ink2: cssVar('--ink-2'), muted: cssVar('--muted'), grid: cssVar('--grid'),
           axis: cssVar('--axis'), surface: cssVar('--surface') };
}

function tooltipBox(t) {
  return { backgroundColor: t.surface, borderColor: t.axis, borderWidth: 1, padding: [8, 10],
           textStyle: { color: t.ink, fontSize: 12 }, extraCssText: 'box-shadow: 0 4px 14px rgba(0,0,0,.12); border-radius: 8px; max-width: min(360px, calc(100vw - 48px)); white-space: normal; overflow-wrap: anywhere;' };
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
    const observer = new ResizeObserver(() => { if (el.clientWidth && el.clientHeight) chart.resize(); });
    observer.observe(el); observers.set(chart, observer);
  }
  const t = theme();
  const fmt = spec.format || (v => v);
  const axisFmt = spec.axisFormat || fmt;
  const isLine = spec.type === 'line';
  const horizontal = spec.type === 'hbar';
  const stacked = spec.type === 'stacked' || spec.type === 'stacked100';
  const many = spec.series.length >= 2;
  const directLabels = isLine && spec.series.length <= 4 && !spec.noEndLabels && el.clientWidth > 500;

  const series = spec.series.map((s, i) => {
    const base = { name: s.name, data: s.data, itemStyle: { color: s.color }, emphasis: { focus: 'series' } };
    if (spec.type === 'interval') {
      return { ...base, type: 'custom', encode: { x: 0, y: [1, 2, 3] }, renderItem: (params, api) => {
        const x = api.value(0); const low = api.coord([x, api.value(1)]); const mid = api.coord([x, api.value(2)]); const high = api.coord([x, api.value(3)]);
        if (![1, 2, 3].every(i => Number.isFinite(api.value(i)))) return;
        const style = { stroke: s.color, lineWidth: 2 };
        return { type: 'group', children: [
          { type: 'line', shape: { x1: low[0], y1: low[1], x2: high[0], y2: high[1] }, style },
          { type: 'line', shape: { x1: low[0]-5, y1: low[1], x2: low[0]+5, y2: low[1] }, style },
          { type: 'line', shape: { x1: high[0]-5, y1: high[1], x2: high[0]+5, y2: high[1] }, style },
          { type: 'circle', shape: { cx: mid[0], cy: mid[1], r: 5 }, style: { fill: s.color } },
        ] };
      } };
    }
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
      label: horizontal ? { show: true, position: 'right', color: t.ink2, fontSize: 11, formatter: p => fmt(p.value) } : undefined,
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
    max: spec.type === 'stacked100' || (spec.percent && !stacked && (!isLine || dataMax > 95)) ? 100 : undefined,
    splitNumber: horizontal && el.clientWidth < 550 ? 2 : 5,
    splitLine: { lineStyle: { color: t.grid, type: 'solid', width: 1 } },
    axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true, formatter: v => axisFmt(v) }, axisLine: { show: false } };

  chart.setOption({
    animation: false,
    textStyle: { fontFamily: getComputedStyle(document.body).fontFamily },
    grid: { left: horizontal ? 8 : 12, right: horizontal ? 84 : directLabels ? 88 : 16, top: 16, bottom: 24, containLabel: true },
    legend: { show: false, data: spec.series.map(s => s.name) },
    tooltip: {
      trigger: horizontal ? 'item' : 'axis', confine: true, ...tooltipBox(t),
      axisPointer: { type: isLine ? 'line' : 'shadow', lineStyle: { color: t.axis }, shadowStyle: { color: 'rgba(127,127,127,.08)' } },
      formatter: params => {
        const list = Array.isArray(params) ? params : [params];
        const head = escapeHtml(horizontal ? (spec.tooltipTitle ? spec.tooltipTitle(list[0].name, list[0].dataIndex) : list[0].name)
          : (spec.tooltipTitle ? spec.tooltipTitle(list[0].axisValue) : list[0].axisValue));
        const rows = list.filter(p => p.value !== null && p.value !== undefined && p.value !== '-')
          .map(p => `<div>${key(p.color, isLine)}<strong>${escapeHtml(fmt(Array.isArray(p.value) ? p.value[spec.valueIndex ?? 1] : p.value))}</strong>`
            + ` <span style="color:${t.ink2}">${escapeHtml(horizontal && !many ? '' : p.seriesName)}</span></div>`);
        const extra = spec.tooltipExtra ? spec.tooltipExtra(list[0].dataIndex) : '';
        return `<div style="margin-bottom:4px;color:${t.ink2}">${head}</div>${rows.join('') || '<div>没有数据</div>'}`
          + (extra ? `<div style="margin-top:4px;color:${t.ink2}">${escapeHtml(extra).replace(/\n/g, '<br>')}</div>` : '');
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

export function toggleSeries(el, name) {
  echarts.getInstanceByDom(el)?.dispatchAction({ type: 'legendToggleSelect', name });
}

export async function exportPng(el, filename, context = {}) {
  const chart = echarts.getInstanceByDom(el);
  if (!chart) return;
  await document.fonts.ready;
  const img = new Image();
  img.src = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: cssVar('--surface') });
  await img.decode();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = Math.max(720, img.width+64);
  const font = getComputedStyle(document.body).fontFamily;
  const width = canvas.width-64;
  function lines(text, size, maxWidth = width) {
    ctx.font = `${size}px ${font}`;
    const out = []; let line = '';
    for (const ch of String(text || '')) {
      if (ch === '\n' || (line && ctx.measureText(line+ch).width > maxWidth)) { out.push(line); line = ch === '\n' ? '' : ch; }
      else line += ch;
    }
    if (line) out.push(line);
    return out;
  }
  const option = chart.getOption();
  const visibleSeries = option.series.filter(s => option.legend[0]?.selected?.[s.name] !== false);
  const titleLines = lines(context.title || 'GamePulse', 34);
  const infoLines = lines([context.page, context.description, context.selection, context.scope,
    context.published].filter(Boolean).join('\n'), 23);
  const legends = visibleSeries.length > 1 ? visibleSeries.map(s => ({ color: s.itemStyle?.color || cssVar('--accent'), text: lines(s.name, 23, width-32) })) : [];
  const caveatLines = lines(context.caveat, 22);
  const header = 40+titleLines.length*44+(infoLines.length+legends.reduce((n, l) => n+l.text.length, 0))*32+20;
  canvas.height = header+img.height+caveatLines.length*30+48;
  ctx.fillStyle = cssVar('--surface'); ctx.fillRect(0, 0, canvas.width, canvas.height);
  let y = 44;
  ctx.fillStyle = cssVar('--ink'); ctx.font = `600 34px ${font}`;
  for (const text of titleLines) { ctx.fillText(text, 32, y); y += 44; }
  ctx.fillStyle = cssVar('--ink-2'); ctx.font = `23px ${font}`;
  for (const text of infoLines) { ctx.fillText(text, 32, y); y += 32; }
  for (const legend of legends) {
    ctx.fillStyle = legend.color; ctx.fillRect(32, y-15, 16, 8);
    ctx.fillStyle = cssVar('--ink-2');
    for (const text of legend.text) { ctx.fillText(text, 64, y); y += 32; }
  }
  ctx.drawImage(img, 32, header);
  y = header+img.height+28; ctx.font = `22px ${font}`;
  for (const text of caveatLines) { ctx.fillText(text, 32, y); y += 30; }
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = filename;
  a.click();
}

export { otherColor };
