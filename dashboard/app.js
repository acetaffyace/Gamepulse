/* GamePulse dashboard —— 配置驱动的多轨道综合图
 *
 * 设计约束：
 * - 浅色、桌面端、单图承载全部信息；
 * - 轨道共享同一日期轴，各自独立纵轴 —— 这是 small multiples，
 *   不是双轴图（双轴会凭空制造相关性）；
 * - 颜色只在轨道内部区分系列。不同轨道可复用同一色位，因为轨道在垂直方向
 *   分开、各有标题和独立纵轴，识别靠位置与标题，不靠颜色；
 * - reconstructed（回填）与 observed（逐日采集）分开呈现，不连成一条线。
 *
 * 轨道不再硬编码在这个文件里，而是来自 data/dashboard_config.json
 * （由 config/dashboard.yml 编译并校验）。本文件只提供 ADAPTERS ——
 * 「怎么从快照里取数」的有限几种模式。加一个指标改 YAML，
 * 加一种取数模式才改这里。
 */

const FONT = 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';

const C = {
  gridline:  '#e1e0d9',
  baseline:  '#c3c2b7',
  muted:     '#898781',
  secondary: '#52514e',
  primary:   '#0b0b0b',
  surface:   '#fcfcfb',
};

const STORAGE_KEY = 'gamepulse.view.v2';

let config = null;      // dashboard_config.json
let snapshot = null;
let chart = null;
let rangeDays = 90;
let viewMode = 'single';       // single | compare，compare.js 读取
let laneState = [];            // [{id, height, enabled}]，顺序即显示顺序
let currentGame = null;

const fmt = n => (n === null || n === undefined) ? '—' : n.toLocaleString('zh-CN');
const pct = n => (n === null || n === undefined) ? '—' : n.toFixed(2) + '%';

/* 全程使用 UTC 构造日期：本地时间解析 + toISOString 会在 UTC+8 下退回一天，
   使 addDays 永远返回同一天。 */
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function daysBetween(aIso, bIso) {
  const p = s => { const [y, m, d] = s.split('-').map(Number);
                   return Date.UTC(y, m - 1, d); };
  return Math.round((p(bIso) - p(aIso)) / 864e5);
}

function dateRange(start, end) {
  const out = [];
  let cur = start, guard = 0;
  while (cur <= end && guard++ < 4000) { out.push(cur); cur = addDays(cur, 1); }
  return out;
}

function resolve(obj, path) {
  return path.split('.').reduce((n, k) => (n && typeof n === 'object') ? n[k] : undefined, obj);
}

/* ---------- 单位格式化 ---------- */

/* 单位换算必须发生在**取数时**，不能只做在轴标签上。
   把分钟原样喂给 ECharts、只在 formatter 里除以 60，会得到
   「0.0h / 8.3h / 17h / 25h」这种刻度 —— 因为分档是按分钟算的。
   先换算成小时，刻度才会落在整数上。 */
const SCALES = {
  minutes_as_hours: v => (v == null ? null : v / 60),
};

const UNITS = {
  count: v => {
    if (v == null) return '';
    if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(Math.abs(v) >= 1e5 ? 0 : 1) + '万';
    if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + 'k';
    return String(v);
  },
  percent: v => v == null ? '' : v + '%',
  minutes_as_hours: v => v == null ? '' : v + 'h',
};

const TOOLTIP_UNITS = {
  count: v => fmt(v),
  percent: v => v == null ? '—' : v.toFixed(2) + '%',
  minutes_as_hours: v => v == null ? '—' : v.toFixed(1) + ' 小时',
};

const unitFmt = u => UNITS[u] || UNITS.count;
const tipFmt = u => TOOLTIP_UNITS[u] || TOOLTIP_UNITS.count;
const scaleOf = u => SCALES[u] || (v => v);

function color(slot) {
  return (config.palette && config.palette[slot]) || C.muted;
}

/* ---------- ADAPTERS：配置与代码之间唯一的契约 ----------
 *
 * 每个 adapter 接收 (lane, snapshot, axis)，返回统一结构：
 *   { series: [...], empty: bool, note: string }
 * series 里的每一项描述一条可绘制的线/柱/点，绘制细节由 buildLaneSeries 统一处理。
 * 新增 adapter 需要在 pipeline/build_dashboard_config.py 的 ADAPTER_SHAPES 同步登记，
 * 否则配置校验会拒绝使用它。
 */

const ADAPTERS = {
  /* 按 date_local 对齐的普通序列。lane.series 可声明多条共用纵轴的线。 */
  series(lane, snap, axis) {
    const rows = resolve(snap, lane.path) || [];
    const by = new Map(rows.map(r => [r.date_local, r]));
    const scale = scaleOf(lane.unit);
    const defs = lane.series || [{
      field: lane.field, name: lane.title, color: lane.color,
      width: 2, smooth: false,
    }];
    return {
      series: defs.map(def => ({
        name: def.name || lane.title,
        kind: lane.chart === 'bar' ? 'bar' : 'line',
        color: color(def.color || lane.color),
        width: def.width, opacity: def.opacity, smooth: def.smooth,
        dashed: def.dashed, endLabel: def.end_label,
        symbol: lane.symbol,
        values: axis.map(d => {
          const r = by.get(d);
          const v = r ? r[def.field] : null;
          return (v === undefined) ? null : scale(v);
        }),
      })),
      empty: rows.length === 0,
    };
  },

  /* 视频散点：x = 发布日，y = 该视频最新的某个统计值或互动率。
     纵轴是「当前累计值」而不是当日值 —— 接口只返回当前累计，没有历史曲线。 */
  video_scatter(lane, snap, axis) {
    const videos = resolve(snap, lane.path) || [];
    const inAxis = new Set(axis);
    const bag = lane.from_rates ? 'rates' : 'stats';
    const points = videos
      .filter(v => v.pubdate && inAxis.has(v.pubdate) && v.latest)
      .map(v => {
        const value = (v.latest[bag] || {})[lane.field];
        return (value == null) ? null : { date: v.pubdate, value, meta: v };
      })
      .filter(Boolean);
    return {
      series: [{ name: lane.title, kind: 'scatter', color: color(lane.color), points }],
      empty: videos.length === 0,
    };
  },

  /* 全部登记视频的日增量合计。跨天的增量会被记在结束日，
     因此 span_days > 1 的点标记出来，不假装是单日增量。 */
  video_delta(lane, snap, axis) {
    const videos = resolve(snap, lane.path) || [];
    const sums = new Map();
    const spans = new Map();
    videos.forEach(v => (v.points || []).forEach(p => {
      const d = (p.deltas || {})[lane.field];
      if (d == null) return;
      sums.set(p.date_local, (sums.get(p.date_local) || 0) + d);
      if ((p.span_days || 1) > 1) spans.set(p.date_local, p.span_days);
    }));
    return {
      series: [{
        name: lane.title, kind: 'bar', color: color(lane.color),
        values: axis.map(d => sums.has(d) ? sums.get(d) : null),
        spans,
      }],
      empty: sums.size === 0,
    };
  },

  /* 语种构成堆叠面积。分桶是 7 天日历窗口，把桶内每一天都填成该桶的占比，
     因此这条轨道呈现的是阶梯而不是逐日曲线 —— 日粒度的语种占比在低评测量
     的日期噪声极大，算不出有意义的数字。 */
  stacked_share(lane, snap, axis) {
    const share = resolve(snap, lane.path);
    if (!share || !share.buckets || !share.buckets.length) {
      return { series: [], empty: true };
    }
    const byDate = new Map();
    share.buckets.forEach(b => {
      dateRange(b.start, b.end).forEach(d => byDate.set(d, b.shares));
    });
    const langs = share.languages || [];
    // 顺序色阶：语种已按占比排序，由深到浅对应由大到小。
    // 「其他」固定用中性灰，明确它不是色阶里的一档。
    const ramp = config.share_ramp || [];
    const rampFor = (lang, i) => {
      if (lang === 'other') return config.share_other || C.baseline;
      const span = langs.filter(l => l !== 'other').length || 1;
      const idx = Math.round(i / Math.max(span - 1, 1) * (ramp.length - 1));
      return ramp[Math.min(idx, ramp.length - 1)] || color('slot1');
    };
    return {
      series: langs.map((lang, i) => ({
        name: LANG_LABEL[lang] || lang,
        kind: 'line', stack: 'lang', area: true,
        color: rampFor(lang, i),
        opacity: 1,
        width: 0,
        values: axis.map(d => {
          const s = byDate.get(d);
          return s ? (s[lang] ?? null) : null;
        }),
      })),
      empty: false,
    };
  },
};

/* ---------- 视图状态：URL → localStorage → 配置默认值 ---------- */

function defaultLaneState() {
  return config.lanes.map(l => ({
    id: l.id, height: l.height || 120, enabled: !!l.enabled,
  }));
}

function applyPreset(name) {
  const preset = (config.presets || {})[name];
  if (!preset) return;
  const wanted = preset.lanes;
  const byId = new Map(config.lanes.map(l => [l.id, l]));
  const on = wanted.map(id => ({
    id, height: (byId.get(id) || {}).height || 120, enabled: true,
  }));
  const off = config.lanes
    .filter(l => !wanted.includes(l.id))
    .map(l => ({ id: l.id, height: l.height || 120, enabled: false }));
  laneState = on.concat(off);
}

function serializeView() {
  const on = laneState.filter(l => l.enabled)
    .map(l => `${l.id}.${l.height}`).join(',');
  return `g=${currentGame}&r=${rangeDays}&l=${on}`;
}

function parseView(str) {
  const params = new URLSearchParams(str);
  const out = {};
  if (params.get('g')) out.game = params.get('g');
  if (params.get('r') !== null) out.range = Number(params.get('r'));
  const l = params.get('l');
  if (l) {
    const known = new Set(config.lanes.map(x => x.id));
    const on = l.split(',').map(part => {
      const [id, h] = part.split('.');
      return { id, height: Number(h) || 120, enabled: true };
    }).filter(x => known.has(x.id));
    if (on.length) {
      const onIds = new Set(on.map(x => x.id));
      const off = config.lanes.filter(x => !onIds.has(x.id))
        .map(x => ({ id: x.id, height: x.height || 120, enabled: false }));
      out.lanes = on.concat(off);
    }
  }
  return out;
}

function restoreView() {
  laneState = defaultLaneState();
  let restored = {};
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) restored = parseView(saved);
  } catch (e) { /* 隐私模式下 localStorage 不可用，用默认值即可 */ }

  // URL 优先于 localStorage：分享出去的链接必须能覆盖对方的本地设置
  if (location.hash.length > 1) {
    Object.assign(restored, parseView(location.hash.slice(1)));
  }
  if (restored.lanes) laneState = restored.lanes;
  if (restored.range !== undefined) rangeDays = restored.range;
  return restored.game || null;
}

function persistView() {
  try { localStorage.setItem(STORAGE_KEY, serializeView()); } catch (e) { /* 忽略 */ }
  history.replaceState(null, '', '#' + serializeView());
}

/* ---------- 数据装配 ---------- */

function buildAxis(snap) {
  const dates = [];
  const push = d => { if (d) dates.push(d); };

  (snap.review_history || []).forEach(r => push(r.date_local));
  (snap.online_series || []).forEach(r => push(r.date_local));
  (snap.online_daily || []).forEach(r => push(r.date_local));
  ((snap.review_profile || {}).daily || []).forEach(r => push(r.date_local));
  (((snap.bilibili || {}).videos) || []).forEach(v => push(v.pubdate));
  (((snap.youtube || {}).videos) || []).forEach(v => push(v.pubdate));
  push(snap.snapshot_date);

  if (!dates.length) return [];
  dates.sort();
  return dateRange(dates[0], dates[dates.length - 1]);
}

function activeLanes() {
  const byId = new Map(config.lanes.map(l => [l.id, l]));
  return laneState
    .filter(s => s.enabled && byId.has(s.id))
    .map(s => ({ ...byId.get(s.id), height: s.height }));
}

function slice(axis) {
  if (!rangeDays) return { from: 0, to: axis.length - 1 };
  const to = axis.length - 1;
  return { from: Math.max(0, to - rangeDays + 1), to };
}

/* ---------- 图表 ---------- */

const LANE_GAP = 46;     // 轨道之间的留白，需容纳轨道标题
const CHART_TOP = 44;
const CHART_BOTTOM = 42;

function laneTitle(lane, top, note) {
  const sub = [lane.subtitle, note].filter(Boolean).join(' · ');
  return {
    text: `{h|${lane.title}}` + (sub ? `  {s|${sub}}` : ''),
    left: 2, top: top - 30,
    textStyle: {
      fontFamily: FONT,
      rich: {
        h: { fontSize: 12.5, fontWeight: 600, color: C.primary, fontFamily: FONT },
        s: { fontSize: 11.5, color: C.muted, fontFamily: FONT },
      },
    },
  };
}

function boundaryMarkLine(boundaries, withLabel) {
  return {
    silent: true, symbol: 'none',
    lineStyle: { color: C.baseline, width: 1 },
    label: withLabel ? {
      show: true, position: 'start', distance: 6,
      formatter: p => p.name, fontSize: 11, color: C.secondary,
      fontFamily: FONT, fontWeight: 500,
      backgroundColor: C.surface, padding: [2, 5], borderRadius: 3,
    } : { show: false },
    data: boundaries.map(b => ({
      xAxis: b.date_local, name: (b.version_id || '') + ' 上线',
    })),
  };
}

function buildLaneSeries(def, laneIndex, axisSlice, boundaries, isFirst) {
  const base = {
    xAxisIndex: laneIndex, yAxisIndex: laneIndex,
    name: def.name,
    markLine: boundaryMarkLine(boundaries, isFirst),
  };

  if (def.kind === 'scatter') {
    return {
      ...base, type: 'scatter',
      data: (def.points || []).map(p => ({ value: [p.date, p.value], meta: p.meta })),
      symbolSize: d => {
        const v = Math.abs(d[1]) || 0;
        // 面积随数值开方增长：直接用数值做直径会让大视频吞掉整条轨道
        return Math.max(9, Math.min(26, 9 + Math.sqrt(v) / 160));
      },
      itemStyle: { color: def.color, opacity: .85,
                   borderColor: C.surface, borderWidth: 2 },
    };
  }

  if (def.kind === 'bar') {
    return {
      ...base, type: 'bar',
      data: def.values,
      itemStyle: { color: def.color, borderRadius: [3, 3, 0, 0] },
      barMaxWidth: 9,
    };
  }

  return {
    ...base, type: 'line',
    data: def.values,
    stack: def.stack,
    showSymbol: !!def.symbol,
    symbolSize: 8,
    smooth: !!def.smooth,
    connectNulls: false,
    areaStyle: def.area ? { opacity: def.opacity ?? .85 } : undefined,
    lineStyle: {
      color: def.color,
      width: def.width === 0 ? 0 : (def.width || 2),
      opacity: def.opacity ?? 1,
      type: def.dashed ? 'dashed' : 'solid',
    },
    itemStyle: { color: def.color, borderColor: C.surface,
                 borderWidth: def.symbol ? 2 : 0 },
    endLabel: def.endLabel ? {
      show: true, fontFamily: FONT, fontSize: 11.5, fontWeight: 600,
      color: def.color, distance: 6,
      formatter: p => p.value != null ? p.value.toFixed(2) + '%' : '',
    } : { show: false },
  };
}

function render() {
  const axisFull = buildAxis(snapshot);
  if (!axisFull.length) return;
  const { from, to } = slice(axisFull);
  const axis = axisFull.slice(from, to + 1);

  const lanes = activeLanes();
  const boundaries = (snapshot.events || []).filter(e => e.is_version_boundary);

  const el = document.getElementById('pulse');
  if (!lanes.length) {
    chart.clear();
    el.style.height = '120px';
    document.getElementById('legend').innerHTML =
      '<span class="muted">没有启用任何轨道。点击右上角「自定义轨道」选择要显示的指标。</span>';
    return;
  }

  // 轨道高度可调，因此容器高度必须跟着算，不能写死
  const totalHeight = CHART_TOP + CHART_BOTTOM
    + lanes.reduce((s, l) => s + l.height, 0) + LANE_GAP * (lanes.length - 1);
  el.style.height = totalHeight + 'px';

  const grids = [], xAxes = [], yAxes = [], series = [], titles = [];
  const laneData = [];
  let top = CHART_TOP;

  lanes.forEach((lane, i) => {
    const adapter = ADAPTERS[lane.adapter];
    const built = adapter ? adapter(lane, snapshot, axis)
                          : { series: [], empty: true, note: '未知 adapter' };
    laneData.push({ lane, built });

    grids.push({ left: 64, right: 80, top, height: lane.height });

    const isLast = i === lanes.length - 1;
    xAxes.push({
      gridIndex: i, type: 'category', data: axis,
      boundaryGap: lane.chart === 'bar',
      axisLine: { lineStyle: { color: C.baseline } },
      axisTick: { show: false },
      axisLabel: isLast ? {
        color: C.muted, fontSize: 11, fontFamily: FONT, margin: 12,
        formatter: v => v.slice(5), hideOverlap: true,
      } : { show: false },
      splitLine: { show: false },
      axisPointer: { label: { show: isLast, formatter: p => p.value,
                              backgroundColor: C.primary, fontFamily: FONT } },
    });

    const isShare = lane.adapter === 'stacked_share';
    yAxes.push({
      gridIndex: i,
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: C.gridline, width: 1 } },
      axisLabel: { color: C.muted, fontSize: 11, fontFamily: FONT,
                   formatter: unitFmt(lane.unit) },
      max: isShare ? 100 : undefined,
      // 好评率这类高位窄幅指标，从 0 起会把全部变化压成一条直线
      min: (lane.unit === 'percent' && !isShare)
        ? (v => Math.max(0, Math.floor(v.min - 4))) : undefined,
    });

    const note = built.empty ? '暂无数据' : built.note;
    titles.push(laneTitle(lane, top, note));

    built.series.forEach(def => {
      series.push(buildLaneSeries(def, i, axis, boundaries, i === 0));
    });

    top += lane.height + LANE_GAP;
  });

  chart.setOption({
    animationDuration: 380,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: FONT },
    title: titles,
    grid: grids, xAxis: xAxes, yAxis: yAxes,
    axisPointer: {
      link: [{ xAxisIndex: 'all' }],
      lineStyle: { color: C.baseline, width: 1 },
      label: { backgroundColor: C.primary, fontFamily: FONT },
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#fff',
      borderColor: 'rgba(11,11,11,0.12)', borderWidth: 1,
      padding: [10, 12],
      textStyle: { color: C.primary, fontSize: 12.5, fontFamily: FONT },
      extraCssText: 'box-shadow:0 6px 22px rgba(11,11,11,0.10);border-radius:9px;',
      formatter: params => buildTooltip(params, axis, laneData, boundaries),
    },
    series,
  }, true);

  renderLegend(laneData);
}

function buildTooltip(params, axis, laneData, boundaries) {
  if (!params.length) return '';
  const date = params[0].axisValueLabel || params[0].axisValue;
  const at = axis.indexOf(date);
  if (at < 0) return '';

  const row = (c, label, value, extra) =>
    `<div style="display:flex;align-items:center;gap:7px;margin:3px 0">
       <span style="width:8px;height:8px;border-radius:2px;background:${c};flex:none"></span>
       <span style="color:${C.secondary}">${label}</span>
       <span style="margin-left:auto;font-weight:600;font-variant-numeric:tabular-nums">${value}</span>
     </div>` + (extra ? `<div style="margin-left:15px;color:${C.muted};font-size:11px">${extra}</div>` : '');

  let s = `<div style="font-weight:600;margin-bottom:6px">${date}</div>`;
  let any = false;

  laneData.forEach(({ lane, built }) => {
    const toText = tipFmt(lane.unit);
    built.series.forEach(def => {
      if (def.points) {
        def.points.filter(p => p.date === date).forEach(p => {
          any = true;
          const m = p.meta || {};
          s += row(def.color, def.name, toText(p.value),
            `${(m.title || '').slice(0, 42)}${m.version_id ? ' · ' + m.version_id + ' 版本' : ''}`);
        });
        return;
      }
      const v = def.values ? def.values[at] : null;
      if (v == null) return;
      any = true;
      const span = def.spans && def.spans.get(date);
      s += row(def.color, def.name, toText(v),
               span ? `跨 ${span} 天的增量，不是单日值` : '');
    });
  });

  if (!any) s += `<div style="color:${C.muted}">该日无数据</div>`;

  const b = boundaries.find(x => x.date_local === date);
  if (b) s += `<div style="margin-top:7px;padding-top:7px;border-top:1px solid ${C.gridline};
                 color:${C.primary};font-weight:600">★ ${b.version_id} 版本更新</div>`;
  const p = (snapshot.events || []).find(
    x => x.date_local === date && x.type === 'version_preview');
  if (p) s += `<div style="margin-top:6px;color:${C.muted}">${p.version_id} 前瞻节目</div>`;
  const bu = (snapshot.events || []).find(
    x => x.date_local === date && x.type === 'build_update');
  if (bu) s += `<div style="margin-top:6px;color:${C.muted}">构建 ${bu.buildid}（third-party 旁证）</div>`;
  return s;
}

/* ---------- 图例：显示当前轨道的系列与口径提示 ---------- */

function renderLegend(laneData) {
  const el = document.getElementById('legend');
  el.innerHTML = laneData.map(({ lane, built }) => {
    const marks = built.series.map(def => {
      const shape = def.kind === 'scatter' ? 'mark dot'
                  : def.kind === 'bar' ? 'mark bar' : 'mark';
      return `<span class="${shape}" style="background:${def.color}"></span>
              <span>${def.name}</span>`;
    }).join('<span style="width:8px"></span>');
    const caveat = lane.caveat
      ? `<span style="color:${C.muted}">· ${lane.caveat}</span>` : '';
    return `<div class="legend-item" style="cursor:default">${marks}${caveat}</div>`;
  }).join('');
}

/* ---------- 自定义面板 ---------- */

function renderPanel() {
  const byId = new Map(config.lanes.map(l => [l.id, l]));
  const on = laneState.filter(s => s.enabled);
  const off = laneState.filter(s => !s.enabled);

  const rowHtml = (state, idx, list, isOn) => {
    const lane = byId.get(state.id);
    if (!lane) return '';
    const swatch = lane.color
      ? `<span class="swatch" style="background:${color(lane.color)}"></span>`
      : `<span class="swatch" style="background:${C.muted}"></span>`;
    return `
      <div class="lane-row" data-off="${isOn ? 'false' : 'true'}">
        <input type="checkbox" data-toggle="${state.id}" ${isOn ? 'checked' : ''}>
        ${swatch}
        <div class="lane-name">${lane.title}<span>${lane.subtitle || ''}</span></div>
        ${isOn ? `
          <button class="icon-btn" data-move="up" data-id="${state.id}"
                  ${idx === 0 ? 'disabled' : ''} title="上移">↑</button>
          <button class="icon-btn" data-move="down" data-id="${state.id}"
                  ${idx === list.length - 1 ? 'disabled' : ''} title="下移">↓</button>` : ''}
      </div>
      ${isOn ? `
      <div class="height-row" style="margin:-3px 0 10px 10px">
        <span style="font-size:11px;color:${C.muted}">高度</span>
        <input type="range" min="70" max="260" step="10"
               value="${state.height}" data-height="${state.id}">
        <span class="val">${state.height}</span>
      </div>` : ''}`;
  };

  document.getElementById('laneList').innerHTML =
    on.map((s, i) => rowHtml(s, i, on, true)).join('')
    || `<p class="hint">当前没有启用的轨道。</p>`;
  document.getElementById('laneListOff').innerHTML =
    off.map((s, i) => rowHtml(s, i, off, false)).join('')
    || `<p class="hint">全部轨道都已启用。</p>`;

  const panel = document.getElementById('lanePanel');

  panel.querySelectorAll('[data-toggle]').forEach(cb => {
    cb.onchange = () => {
      const entry = laneState.find(s => s.id === cb.dataset.toggle);
      entry.enabled = cb.checked;
      if (entry.enabled) {
        // 新启用的轨道放到已启用列表末尾，而不是停在原来的位置
        laneState = laneState.filter(s => s !== entry);
        const lastOn = laneState.reduce(
          (acc, s, i) => s.enabled ? i : acc, -1);
        laneState.splice(lastOn + 1, 0, entry);
      }
      afterLaneChange();
    };
  });

  panel.querySelectorAll('[data-move]').forEach(btn => {
    btn.onclick = () => {
      const i = laneState.findIndex(s => s.id === btn.dataset.id);
      const dir = btn.dataset.move === 'up' ? -1 : 1;
      // 只在已启用的轨道之间移动，跳过中间可能夹着的未启用项
      let j = i + dir;
      while (j >= 0 && j < laneState.length && !laneState[j].enabled) j += dir;
      if (j < 0 || j >= laneState.length) return;
      [laneState[i], laneState[j]] = [laneState[j], laneState[i]];
      afterLaneChange();
    };
  });

  panel.querySelectorAll('[data-height]').forEach(slider => {
    slider.oninput = () => {
      const entry = laneState.find(s => s.id === slider.dataset.height);
      entry.height = Number(slider.value);
      slider.parentElement.querySelector('.val').textContent = slider.value;
      render();
    };
    slider.onchange = () => persistView();
  });
}

function afterLaneChange() {
  renderPanel();
  render();
  renderDataTable();
  persistView();
  // 手工改过之后就不再对应任何预设
  document.getElementById('presetSelect').value = '';
}

/* ---------- 指标卡 ---------- */

function renderTiles() {
  const hist = snapshot.review_history || [];
  const last = hist[hist.length - 1];
  const online = (snapshot.online_series || []).filter(o => o.value != null);
  const bili = (snapshot.bilibili || {}).totals || {};
  const boundaries = (snapshot.events || []).filter(e => e.is_version_boundary);
  const current = boundaries[boundaries.length - 1];
  const profile = (snapshot.review_profile || {}).daily || [];

  const last7 = hist.slice(-7), prev7 = hist.slice(-14, -7);
  const avg = a => a.length ? a.reduce((s, r) => s + r.new_reviews, 0) / a.length : null;
  const a7 = avg(last7), p7 = avg(prev7);
  const delta = (a7 != null && p7) ? (a7 - p7) / p7 * 100 : null;
  const daysSince = current ? daysBetween(current.date_local, snapshot.snapshot_date) : null;

  // 中位时长取最近 14 天里有值的那些天，单日样本量太小
  const recentMedians = profile.slice(-14)
    .map(r => r.playtime_at_review_median).filter(v => v != null);
  const medianPlaytime = recentMedians.length
    ? recentMedians.sort((a, b) => a - b)[Math.floor(recentMedians.length / 2)]
    : null;

  const tiles = [
    { k: 'Steam 同时在线', swatch: color('slot7'),
      v: online.length ? fmt(online[online.length - 1].value) : '—',
      n: online.length ? `${online.length} 个采集点 · 历史不可回填` : '尚未采集' },
    { k: '累计好评率', swatch: color('slot3'),
      v: last ? last.cumulative_review_rate.toFixed(2) : '—', unit: '%',
      n: last ? `${fmt(last.cumulative_reviews)} 条评测` : '—' },
    { k: '近 7 日均新增评测', swatch: color('slot1'),
      v: a7 != null ? a7.toFixed(1) : '—',
      n: delta != null
        ? `<span class="${delta >= 0 ? 'good' : 'bad'}">${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%</span> 对比前 7 日`
        : '—' },
    { k: '评测者中位时长', swatch: color('slot2'),
      v: medianPlaytime != null ? (medianPlaytime / 60).toFixed(1) : '—', unit: 'h',
      n: '近 14 天 · 写评测时已玩时长' },
    { k: 'B 站互动率', swatch: color('slot5'),
      v: bili.rates && bili.rates.engagement != null
        ? bili.rates.engagement.toFixed(2) : '—', unit: '%',
      n: bili.videos ? `${bili.videos} 支官方视频 · 点赞+投币+收藏` : '—' },
    { k: '当前版本',
      v: current ? current.version_id : '—',
      n: daysSince != null ? `上线 ${daysSince} 天 · ${current.date_local}` : '—' },
  ];

  document.getElementById('tiles').innerHTML = tiles.map(t => `
    <div class="tile">
      <div class="k">${t.swatch ? `<span class="swatch" style="background:${t.swatch}"></span>` : ''}${t.k}</div>
      <div class="v">${t.v}${t.unit ? `<span class="unit">${t.unit}</span>` : ''}</div>
      <div class="n">${t.n}</div>
    </div>`).join('');
}

/* ---------- 版本前后对比表（直接读 pipeline 算好的结果） ---------- */

function renderVersionTable() {
  const windows = ((snapshot.review_profile || {}).version_windows || [])
    .filter(w => w.complete);
  const tb = document.querySelector('#versionTable tbody');
  const head = document.querySelector('#versionTable thead tr');

  if (!windows.length) {
    tb.innerHTML = `<tr><td colspan="8" class="muted">暂无具备完整前后 7 天窗口的版本</td></tr>`;
    document.getElementById('versionNote').innerHTML =
      '版本更新会同时带来新玩家涌入与老玩家回流，评测量变化同时包含两者，不能单独归因于内容质量。';
    return;
  }

  const fields = windows[0].comparisons;
  head.innerHTML = `<th>版本</th><th>更新日</th>` +
    fields.map(c => `<th class="num">${c.label}</th>`).join('');

  const cell = c => {
    if (c.before == null || c.after == null) return `<td class="num muted">—</td>`;
    const unit = c.change_kind === 'pp' ? '%' : '';
    const arrow = `${c.before}${unit} → <b>${c.after}${unit}</b>`;
    if (c.change == null) {
      const why = c.confounded ? ` title="${c.note}"` : '';
      return `<td class="num"${why}>${arrow}<br><span class="muted" style="font-size:11px">不可比</span></td>`;
    }
    const cls = c.change >= 0 ? 'pos' : 'neg';
    const sign = c.change >= 0 ? '+' : '';
    const suffix = c.change_kind === 'pp' ? 'pp' : '%';
    return `<td class="num">${arrow}<br>
            <span class="${cls}" style="font-size:11px">${sign}${c.change}${suffix}</span></td>`;
  };

  tb.innerHTML = windows.map(w => `
    <tr>
      <td><span class="chip">${w.version_id}</span></td>
      <td class="muted">${w.date_local}</td>
      ${w.comparisons.map(cell).join('')}
    </tr>`).join('');

  const incomplete = ((snapshot.review_profile || {}).version_windows || [])
    .filter(w => !w.complete).map(w => w.version_id);
  const notes = [];
  if (incomplete.length) {
    notes.push(`${incomplete.join('、')} 无完整前后窗口，已排除。`);
  }
  notes.push(`留存类指标不出现在本表：它依赖「今天的累计游玩时长」快照，
    更新日之后的窗口离今天更近、观测时间必然更短，前后差值是窗口差而不是留存差。`);
  notes.push(`版本更新会同时带来新玩家涌入与老玩家回流，评测量变化同时包含两者，
    不能单独归因于内容质量。`);
  document.getElementById('versionNote').innerHTML = notes.join(' ');
}

const LANG_LABEL = {
  english: 'English', russian: 'Русский', schinese: '简体中文', tchinese: '繁體中文',
  japanese: '日本語', koreana: '한국어', spanish: 'Español', latam: 'Español (LATAM)',
  brazilian: 'Português (BR)', german: 'Deutsch', french: 'Français',
  thai: 'ไทย', vietnamese: 'Tiếng Việt', indonesian: 'Indonesia',
  polish: 'Polski', turkish: 'Türkçe', italian: 'Italiano', ukrainian: 'Українська',
  other: '其他',
};

function renderLangTable() {
  const share = (snapshot.review_profile || {}).language_share;
  const overall = (share && share.overall) || {};
  const total = (share && share.overall_total) || 0;
  const rows = Object.entries(overall).sort((a, b) => b[1] - a[1]);
  const max = rows.length ? rows[0][1] : 1;

  // 首尾两桶的占比差：说明玩家来源结构是否在变
  const buckets = (share && share.buckets) || [];
  const trend = new Map();
  if (buckets.length >= 2) {
    const first = buckets[0].shares, lastB = buckets[buckets.length - 1].shares;
    Object.keys(overall).forEach(k => {
      if (first[k] != null && lastB[k] != null) trend.set(k, lastB[k] - first[k]);
    });
  }

  document.querySelector('#langTable tbody').innerHTML = rows.map(([k, v]) => {
    const t = trend.get(k);
    const tText = t == null ? '' :
      `<span class="${Math.abs(t) < 0.5 ? 'muted' : (t > 0 ? 'pos' : 'neg')}"
             style="font-size:11px">${t > 0 ? '+' : ''}${t.toFixed(1)}pp</span>`;
    return `
    <tr>
      <td>${LANG_LABEL[k] || k}</td>
      <td class="num">${fmt(v)}</td>
      <td>
        <div class="bar-cell">
          <div class="bar-track"><div class="bar-fill"
            style="width:${(v / max * 100).toFixed(1)}%;background:${color('slot1')}"></div></div>
          <span style="min-width:44px;text-align:right;font-variant-numeric:tabular-nums">
            ${total ? (v / total * 100).toFixed(1) : '—'}%</span>
        </div>
      </td>
      <td class="num">${tText}</td>
    </tr>`;
  }).join('');
}

/* ---------- 数据表：列跟随当前启用的轨道 ---------- */

function datedColumns() {
  const axisFull = buildAxis(snapshot);
  const { from, to } = slice(axisFull);
  const axis = axisFull.slice(from, to + 1);
  const cols = [];
  activeLanes().forEach(lane => {
    if (!['series', 'video_delta'].includes(lane.adapter)) return;
    const built = ADAPTERS[lane.adapter](lane, snapshot, axis);
    built.series.forEach(def => {
      if (!def.values) return;
      cols.push({ name: def.name, unit: lane.unit, values: def.values });
    });
  });
  return { axis, cols };
}

function renderDataTable() {
  const { axis, cols } = datedColumns();
  const evByDate = new Map();
  (snapshot.events || []).forEach(e => {
    const arr = evByDate.get(e.date_local) || [];
    if (e.is_version_boundary) arr.push(`★ ${e.version_id} 版本更新`);
    else if (e.type === 'version_preview') arr.push(`${e.version_id} 前瞻`);
    else if (e.type === 'build_update') arr.push(`构建 ${e.buildid}`);
    else if (e.type === 'content') arr.push(e.label);
    evByDate.set(e.date_local, arr);
  });

  document.querySelector('#dataTable thead tr').innerHTML =
    `<th>日期</th>` + cols.map(c => `<th class="num">${c.name}</th>`).join('')
    + `<th>事件</th>`;

  const rows = [];
  for (let i = axis.length - 1; i >= 0; i--) {
    const d = axis[i];
    const cells = cols.map(c => {
      const v = c.values[i];
      return `<td class="num">${v == null ? '—' : tipFmt(c.unit)(v)}</td>`;
    }).join('');
    rows.push(`<tr><td>${d}</td>${cells}
               <td class="muted">${(evByDate.get(d) || []).join('、')}</td></tr>`);
  }
  document.querySelector('#dataTable tbody').innerHTML = rows.join('');
}

/* ---------- 导出 ---------- */

function downloadBlob(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv() {
  const { axis, cols } = datedColumns();
  const evByDate = new Map();
  (snapshot.events || []).forEach(e => {
    const arr = evByDate.get(e.date_local) || [];
    arr.push(e.label || e.title || e.type);
    evByDate.set(e.date_local, arr);
  });

  const header = ['date', ...cols.map(c => c.name), 'events'];
  const lines = [header.map(csvEscape).join(',')];
  axis.forEach((d, i) => {
    lines.push([d, ...cols.map(c => c.values[i] ?? ''),
                (evByDate.get(d) || []).join(' / ')].map(csvEscape).join(','));
  });
  // BOM 让 Excel 正确识别 UTF-8，否则中文列名会乱码
  downloadBlob(`gamepulse_${currentGame}_${axis[0]}_${axis[axis.length - 1]}.csv`,
               '﻿' + lines.join('\n'), 'text/csv;charset=utf-8');
}

function exportVideosCsv() {
  const rows = [];
  const push = (platform, videos, idKey) => (videos || []).forEach(v => {
    const stats = (v.latest || {}).stats || {};
    const rates = (v.latest || {}).rates || {};
    rows.push({
      platform, id: v[idKey], title: v.title, pubdate: v.pubdate,
      character: v.character_name, version: v.version_id,
      content_type: v.content_type,
      view: stats.view, like: stats.like, coin: stats.coin,
      favorite: stats.favorite, reply: stats.reply ?? stats.comment,
      danmaku: stats.danmaku, share: stats.share,
      engagement_rate: rates.engagement,
      captured: (v.latest || {}).date_local,
      ramp_available: (v.ramp || {}).available,
    });
  });
  push('bilibili', (snapshot.bilibili || {}).videos, 'bvid');
  push('youtube', (snapshot.youtube || {}).videos, 'video_id');

  if (!rows.length) { alert('当前游戏没有登记视频。'); return; }
  const header = Object.keys(rows[0]);
  const lines = [header.join(',')].concat(
    rows.map(r => header.map(h => csvEscape(r[h])).join(',')));
  downloadBlob(`gamepulse_${currentGame}_videos.csv`,
               '﻿' + lines.join('\n'), 'text/csv;charset=utf-8');
}

function exportPng() {
  const url = chart.getDataURL({
    type: 'png', pixelRatio: 2, backgroundColor: '#fcfcfb',
  });
  const a = document.createElement('a');
  a.href = url;
  a.download = `gamepulse_${currentGame}_${snapshot.snapshot_date}.png`;
  a.click();
}

async function copyLink() {
  const url = location.origin + location.pathname + '#' + serializeView();
  try {
    await navigator.clipboard.writeText(url);
    flash('已复制当前视图链接');
  } catch (e) {
    // 非 HTTPS 下 clipboard API 不可用，退回让用户手动复制
    prompt('复制下面的链接：', url);
  }
}

function flash(msg) {
  const btn = document.getElementById('openExport');
  const old = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = old; }, 1600);
}

/* ---------- 来源与口径 ---------- */

function renderSources() {
  document.getElementById('sources').innerHTML =
    (snapshot.sources || []).map(s => `
      <div class="source">
        <span class="tag">${s.label}</span>
        <div class="t">${s.name}</div>
        <div class="d">${s.note}</div>
      </div>`).join('');

  const cov = snapshot.review_history_coverage;
  const online = (snapshot.online_series || []).filter(o => o.value != null).length;
  const hourly = (snapshot.online_daily || []).length;
  const yt = (snapshot.youtube || {}).available;

  document.getElementById('caveat').innerHTML = `
    <b>口径限制</b>
    评测历史由 Steam appreviews 游标翻页回填重建（${cov ? cov.days + ' 天，' + cov.start + ' 起' : '—'}），
    只含<b>今天仍然存在</b>的评测，被删除或隐藏的不会出现，因此越早的日期越可能低估当日真实值。
    玩家结构指标同样基于这批评测，且<b>评测者不是玩家的随机样本</b>。
    「评测后仍在玩」依赖今天的累计时长快照，观测窗口不足 14 天的日期一律留空，
    并已排除在版本前后对比之外 —— 更新日之后的窗口必然更短，前后差值是窗口差不是留存差。
    Steam 同时在线人数<b>无法回填</b>（SteamDB 不可程序化访问、SteamCharts 未收录该 App），
    目前有 ${online} 个逐日采集点、${hourly} 天小时级采样，需持续积累。
    B 站与 YouTube 接口只返回<b>当前</b>累计值，没有历史曲线，散点表示"发布日 × 当前累计值"。
    ${yt ? '' : 'YouTube 尚未配置 API Key，该平台数据为空。'}
    版本更新竖线取自 Steam 官方公告，构建号事件来自 SteamCMD 第三方镜像，仅作旁证。
    所有事件仅表示时间节点，<b>不自动表示因果关系</b>。`;
}

/* ---------- 引导 ---------- */

async function loadGame(gameId) {
  currentGame = gameId;
  const res = await fetch(`../data/snapshot_${gameId}.json`);
  snapshot = await res.json();

  document.getElementById('metaDate').textContent = snapshot.snapshot_date;
  const cov = snapshot.review_history_coverage;
  document.getElementById('metaBadges').innerHTML =
    `<span class="badge live"><span class="dot"></span>逐日采集 observed</span>
     ${cov ? `<span class="badge recon" style="margin-left:6px"><span class="dot"></span>评测历史 reconstructed ${cov.days} 天</span>` : ''}`;

  renderTiles();
  render();
  renderPanel();
  renderVersionTable();
  renderLangTable();
  renderDataTable();
  renderSources();
  persistView();

  document.getElementById('loading').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  chart.resize();
}

async function boot() {
  chart = echarts.init(document.getElementById('pulse'), null, { renderer: 'canvas' });
  window.addEventListener('resize', () => chart.resize());

  const loading = document.getElementById('loading');
  config = await fetch('../data/dashboard_config.json').then(r => r.json()).catch(() => null);
  if (!config) {
    loading.textContent = '缺少轨道配置。请先运行 python pipeline/build_dashboard_config.py';
    return;
  }

  const idx = await fetch('../data/index.json').then(r => r.json()).catch(() => null);
  const games = (idx && idx.games) || [];
  if (!games.length) {
    loading.textContent = '没有可用快照。请先运行 python pipeline/build_snapshot.py';
    return;
  }

  const wantedGame = restoreView();

  const sel = document.getElementById('gameSelect');
  sel.innerHTML = games.map(g =>
    `<option value="${g.game_id}">${g.display_name}</option>`).join('');
  sel.onchange = () => loadGame(sel.value);

  const presetSel = document.getElementById('presetSelect');
  presetSel.innerHTML = `<option value="">自定义</option>` +
    Object.entries(config.presets || {}).map(([k, p]) =>
      `<option value="${k}">${p.label}</option>`).join('');
  presetSel.onchange = () => {
    if (!presetSel.value) return;
    applyPreset(presetSel.value);
    renderPanel(); render(); renderDataTable(); persistView();
  };

  const pressOnly = (selector, btn) => {
    document.querySelectorAll(selector).forEach(b => b.setAttribute('aria-pressed', 'false'));
    btn.setAttribute('aria-pressed', 'true');
  };

  document.querySelectorAll('#rangeSeg button').forEach(btn => {
    btn.setAttribute('aria-pressed', String(Number(btn.dataset.days) === rangeDays));
    btn.onclick = () => {
      pressOnly('#rangeSeg button', btn);
      rangeDays = Number(btn.dataset.days);
      if (viewMode === 'compare') { renderCompare(); }
      else { render(); renderDataTable(); persistView(); }
    };
  });

  document.querySelectorAll('#viewSeg button').forEach(btn => {
    btn.onclick = async () => {
      pressOnly('#viewSeg button', btn);
      viewMode = btn.dataset.view;
      const compare = viewMode === 'compare';
      document.getElementById('app').classList.toggle('hidden', compare);
      document.getElementById('compareApp').classList.toggle('hidden', !compare);
      document.getElementById('gameGroup').classList.toggle('hidden', compare);
      document.getElementById('presetGroup').classList.toggle('hidden', compare);
      document.getElementById('alignGroup').classList.toggle('hidden', !compare);
      document.getElementById('toggleTable').classList.toggle('hidden', compare);
      document.getElementById('openPanel').classList.toggle('hidden', compare);
      if (compare) await loadCompare();
      else { chart.resize(); render(); }
    };
  });

  document.querySelectorAll('#alignSeg button').forEach(btn => {
    btn.onclick = () => {
      pressOnly('#alignSeg button', btn);
      alignMode = btn.dataset.align;
      renderCompare();
    };
  });

  // 自定义面板
  const panel = document.getElementById('lanePanel');
  const scrim = document.getElementById('panelScrim');
  const openPanel = () => { panel.classList.add('open'); scrim.classList.add('open'); };
  const closePanel = () => {
    panel.classList.remove('open'); scrim.classList.remove('open');
    chart.resize();
  };
  document.getElementById('openPanel').onclick = openPanel;
  document.getElementById('closePanel').onclick = closePanel;
  scrim.onclick = closePanel;
  document.getElementById('resetLanes').onclick = () => {
    laneState = defaultLaneState();
    presetSel.value = '';
    renderPanel(); render(); renderDataTable(); persistView();
  };

  // 导出菜单
  const exportMenu = document.getElementById('exportMenu');
  document.getElementById('openExport').onclick = e => {
    e.stopPropagation();
    exportMenu.classList.toggle('hidden');
  };
  document.addEventListener('click', () => exportMenu.classList.add('hidden'));
  exportMenu.onclick = e => e.stopPropagation();
  exportMenu.querySelectorAll('[data-export]').forEach(btn => {
    btn.onclick = () => {
      exportMenu.classList.add('hidden');
      ({ csv: exportCsv, videos: exportVideosCsv,
         png: exportPng, link: copyLink })[btn.dataset.export]();
    };
  });

  const tbtn = document.getElementById('toggleTable');
  tbtn.onclick = () => {
    const card = document.getElementById('tableCard');
    const show = card.classList.contains('hidden');
    card.classList.toggle('hidden', !show);
    tbtn.textContent = show ? '隐藏数据表' : '显示数据表';
  };

  const initial = games.some(g => g.game_id === wantedGame)
    ? wantedGame : games[0].game_id;
  sel.value = initial;
  await loadGame(initial);
}

boot();
