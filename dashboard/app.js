/* GamePulse dashboard
 *
 * 设计约束：
 * - 浅色、桌面端、单图承载全部信息；
 * - 四条轨道共享同一日期轴，各自独立纵轴 —— 这是 small multiples，
 *   不是双轴图（双轴会凭空制造相关性）；
 * - 颜色只承载身份，不承载数值；低对比度的两个色位配有表格视图与直接标注；
 * - reconstructed（回填）与 observed（逐日采集）分开呈现，不连成一条线。
 */

const C = {
  newReviews: '#2a78d6',
  rateDaily:  '#eb6834',
  rateCum:    '#1baf7a',
  online:     '#4a3aa7',
  video:      '#e87ba4',
  gridline:   '#e1e0d9',
  baseline:   '#c3c2b7',
  muted:      '#898781',
  secondary:  '#52514e',
  primary:    '#0b0b0b',
  surface:    '#fcfcfb',
};

const FONT = 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';

const SERIES_META = [
  { key: '每日新增评测', color: C.newReviews, shape: 'bar',
    note: '回填重建 · 讨论热度代理' },
  { key: '当日好评率',   color: C.rateDaily, shape: 'line' },
  { key: '累计好评率',   color: C.rateCum,   shape: 'line' },
  { key: 'Steam 同时在线', color: C.online,  shape: 'line',
    note: '逐日采集 · 非 DAU' },
  { key: 'B 站官方视频',  color: C.video,    shape: 'dot',
    note: '按发布日定位 · 纵轴为当前累计播放量' },
];

let chart = null;
let snapshot = null;
let rangeDays = 90;
let viewMode = 'single';   // single | compare，compare.js 读取
const hidden = new Set();

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
  let cur = start;
  let guard = 0;
  while (cur <= end && guard++ < 4000) { out.push(cur); cur = addDays(cur, 1); }
  return out;
}

/* ---------- 数据装配 ---------- */

function buildModel(snap) {
  const hist = snap.review_history || [];
  const videos = snap.character_videos || [];
  const online = snap.online_series || [];

  const candidates = [];
  if (hist.length) candidates.push(hist[0].date_local);
  videos.forEach(v => v.pubdate && candidates.push(v.pubdate));
  online.forEach(o => candidates.push(o.date_local));
  const start = candidates.sort()[0];

  const ends = [];
  if (hist.length) ends.push(hist[hist.length - 1].date_local);
  online.forEach(o => ends.push(o.date_local));
  ends.push(snap.snapshot_date);
  const end = ends.sort().slice(-1)[0];

  const axis = dateRange(start, end);
  const idx = new Map(axis.map((d, i) => [d, i]));

  const histBy = new Map(hist.map(r => [r.date_local, r]));
  const onlineBy = new Map(online.map(r => [r.date_local, r]));

  return {
    axis, idx,
    newReviews: axis.map(d => histBy.has(d) ? histBy.get(d).new_reviews : null),
    rateDaily:  axis.map(d => histBy.has(d) ? histBy.get(d).daily_review_rate : null),
    rateCum:    axis.map(d => histBy.has(d) ? histBy.get(d).cumulative_review_rate : null),
    online:     axis.map(d => {
      const r = onlineBy.get(d);
      return (r && r.value !== null && r.value !== undefined) ? r.value : null;
    }),
    videos: videos.filter(v => v.pubdate && idx.has(v.pubdate)),
    histBy, onlineBy,
    boundaries: (snap.events || []).filter(e => e.is_version_boundary),
    previews:   (snap.events || []).filter(e => e.type === 'version_preview'),
  };
}

function slice(model) {
  if (!rangeDays) return { from: 0, to: model.axis.length - 1 };
  const to = model.axis.length - 1;
  return { from: Math.max(0, to - rangeDays + 1), to };
}

/* ---------- 图表 ---------- */

/* 轨道位置：标题置于 top-30，需与该轨道纵轴顶端刻度保持间距，
   否则 "10.0k" / "500万" 这类最大值标签会被标题压住。 */
const LANES = [
  { top: 46,  height: 148 },
  { top: 238, height: 114 },
  { top: 396, height: 94  },
  { top: 536, height: 148 },
];

/* 轨道标题与说明放在同一行（rich text），避免两行文字与纵轴顶端刻度重叠。 */
function laneTitle(text, sub, top) {
  return {
    text: `{h|${text}}` + (sub ? `  {s|${sub}}` : ''),
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

function boundaryMarkLine(model, withLabel) {
  return {
    silent: true,
    symbol: 'none',
    lineStyle: { color: C.baseline, width: 1, type: 'solid' },
    label: withLabel ? {
      show: true, position: 'start', distance: 6,
      formatter: p => p.name, fontSize: 11, color: C.secondary,
      fontFamily: FONT, fontWeight: 500,
      backgroundColor: C.surface, padding: [2, 5], borderRadius: 3,
    } : { show: false },
    data: model.boundaries.map(b => ({
      xAxis: b.date_local,
      name: (b.version_id || '') + ' 上线',
    })),
  };
}

function render() {
  const model = buildModel(snapshot);
  const { from, to } = slice(model);
  const axis = model.axis.slice(from, to + 1);
  const cut = arr => arr.slice(from, to + 1);

  const on = k => !hidden.has(k);

  // right 需容纳累计好评率与在线人数的端点标签，否则会被裁切
  const grids = LANES.map(l => ({
    left: 62, right: 78, top: l.top, height: l.height,
  }));

  const xAxes = LANES.map((l, i) => ({
    gridIndex: i,
    type: 'category',
    data: axis,
    boundaryGap: i === 0,
    axisLine: { lineStyle: { color: C.baseline } },
    axisTick: { show: false },
    axisLabel: i === 3 ? {
      color: C.muted, fontSize: 11, fontFamily: FONT, margin: 12,
      formatter: v => v.slice(5),
      hideOverlap: true,
    } : { show: false },
    splitLine: { show: false },
    axisPointer: { label: { show: i === 3, formatter: p => p.value,
      backgroundColor: C.primary, fontFamily: FONT } },
  }));

  const yStyle = {
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: C.gridline, width: 1 } },
    axisLabel: { color: C.muted, fontSize: 11, fontFamily: FONT },
  };

  const yAxes = [
    { gridIndex: 0, ...yStyle,
      axisLabel: { ...yStyle.axisLabel, formatter: v => v >= 1000 ? (v / 1000) + 'k' : v } },
    { gridIndex: 1, ...yStyle, min: v => Math.max(0, Math.floor(v.min - 4)), max: 100,
      axisLabel: { ...yStyle.axisLabel, formatter: v => v + '%' } },
    { gridIndex: 2, ...yStyle,
      axisLabel: { ...yStyle.axisLabel, formatter: v => v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v } },
    { gridIndex: 3, ...yStyle,
      axisLabel: { ...yStyle.axisLabel, formatter: v => v >= 10000 ? (v / 10000) + '万' : v } },
  ];

  const series = [];

  // Lane 0 — 每日新增评测
  series.push({
    name: '每日新增评测', type: 'bar', xAxisIndex: 0, yAxisIndex: 0,
    data: on('每日新增评测') ? cut(model.newReviews) : [],
    itemStyle: { color: C.newReviews, borderRadius: [3, 3, 0, 0] },
    barMaxWidth: 9,
    markLine: boundaryMarkLine(model, true),
  });

  // Lane 1 — 好评率（两条线，同一单位同一纵轴）
  series.push({
    name: '当日好评率', type: 'line', xAxisIndex: 1, yAxisIndex: 1,
    data: on('当日好评率') ? cut(model.rateDaily) : [],
    showSymbol: false, smooth: false,
    lineStyle: { color: C.rateDaily, width: 1.5, opacity: .75 },
    itemStyle: { color: C.rateDaily },
    connectNulls: false,
  });
  series.push({
    name: '累计好评率', type: 'line', xAxisIndex: 1, yAxisIndex: 1,
    data: on('累计好评率') ? cut(model.rateCum) : [],
    showSymbol: false, smooth: true,
    lineStyle: { color: C.rateCum, width: 2.5 },
    itemStyle: { color: C.rateCum },
    endLabel: {
      show: true, fontFamily: FONT, fontSize: 11.5, fontWeight: 600,
      color: C.rateCum, formatter: p => p.value != null ? p.value.toFixed(2) + '%' : '',
      distance: 6,
    },
    markLine: boundaryMarkLine(model, false),
  });

  // Lane 2 — Steam 同时在线
  const onlinePts = cut(model.online);
  const onlineCount = onlinePts.filter(v => v !== null).length;
  series.push({
    name: 'Steam 同时在线', type: 'line', xAxisIndex: 2, yAxisIndex: 2,
    data: on('Steam 同时在线') ? onlinePts : [],
    showSymbol: true, symbolSize: 8, smooth: false, connectNulls: true,
    lineStyle: { color: C.online, width: 2 },
    itemStyle: { color: C.online, borderColor: C.surface, borderWidth: 2 },
    endLabel: onlineCount ? {
      show: true, fontFamily: FONT, fontSize: 11.5, fontWeight: 600,
      color: C.online, formatter: p => p.value != null ? fmt(p.value) : '', distance: 6,
    } : { show: false },
    markLine: boundaryMarkLine(model, false),
  });

  // Lane 3 — B 站官方视频（散点：x 发布日，y 当前累计播放量）
  const vdata = model.videos
    .filter(v => model.idx.get(v.pubdate) >= from && model.idx.get(v.pubdate) <= to)
    .map(v => ({
      value: [v.pubdate, v.latest_view],
      meta: v,
    }));
  series.push({
    name: 'B 站官方视频', type: 'scatter', xAxisIndex: 3, yAxisIndex: 3,
    data: on('B 站官方视频') ? vdata : [],
    symbolSize: d => {
      const v = d[1] || 0;
      return Math.max(9, Math.min(26, 9 + Math.sqrt(v) / 160));
    },
    itemStyle: { color: C.video, opacity: .85,
                 borderColor: C.surface, borderWidth: 2 },
    markLine: boundaryMarkLine(model, false),
  });

  const option = {
    animationDuration: 420,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: FONT },
    title: [
      laneTitle('每日新增评测', '回填重建 · 讨论热度代理', LANES[0].top),
      laneTitle('好评率', '当日 / 累计', LANES[1].top),
      laneTitle('Steam 同时在线人数',
        onlineCount <= 2 ? `逐日采集中 · 当前 ${onlineCount} 个数据点，历史无法回填`
                         : '逐日采集 · 平台同时在线，非 DAU', LANES[2].top),
      laneTitle('B 站官方视频', '横轴为发布日 · 纵轴为当前累计播放量', LANES[3].top),
    ],
    legend: { show: false, data: SERIES_META.map(s => s.key) },
    grid: grids,
    xAxis: xAxes,
    yAxis: yAxes,
    axisPointer: {
      link: [{ xAxisIndex: 'all' }],
      lineStyle: { color: C.baseline, width: 1 },
      label: { backgroundColor: C.primary, fontFamily: FONT },
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#fff',
      borderColor: 'rgba(11,11,11,0.12)',
      borderWidth: 1,
      padding: [10, 12],
      textStyle: { color: C.primary, fontSize: 12.5, fontFamily: FONT },
      extraCssText: 'box-shadow:0 6px 22px rgba(11,11,11,0.10);border-radius:9px;',
      formatter: params => {
        if (!params.length) return '';
        const date = params[0].axisValueLabel || params[0].axisValue;
        const h = model.histBy.get(date);
        const o = model.onlineBy.get(date);
        let s = `<div style="font-weight:600;margin-bottom:6px">${date}</div>`;
        const row = (color, label, value) =>
          `<div style="display:flex;align-items:center;gap:7px;margin:3px 0">
             <span style="width:8px;height:8px;border-radius:2px;background:${color};flex:none"></span>
             <span style="color:${C.secondary}">${label}</span>
             <span style="margin-left:auto;font-weight:600;font-variant-numeric:tabular-nums">${value}</span>
           </div>`;
        if (h) {
          s += row(C.newReviews, '新增评测', `${fmt(h.new_reviews)} 条`);
          s += row(C.rateDaily, '当日好评率', pct(h.daily_review_rate));
          s += row(C.rateCum, '累计好评率', pct(h.cumulative_review_rate));
        }
        if (o && o.value !== null) s += row(C.online, 'Steam 同时在线', fmt(o.value));
        const vids = model.videos.filter(v => v.pubdate === date);
        vids.forEach(v => {
          s += `<div style="margin-top:7px;padding-top:7px;border-top:1px solid ${C.gridline}">
                  <div style="display:flex;align-items:center;gap:7px">
                    <span style="width:8px;height:8px;border-radius:50%;background:${C.video};flex:none"></span>
                    <span style="color:${C.secondary}">B 站发布</span>
                  </div>
                  <div style="margin:3px 0 0 15px;max-width:300px">${v.title || ''}</div>
                  <div style="margin-left:15px;color:${C.muted};font-size:11.5px">
                    当前播放 ${fmt(v.latest_view)}${v.version_id ? ' · ' + v.version_id + ' 版本' : ''}
                  </div>
                </div>`;
        });
        const b = model.boundaries.find(x => x.date_local === date);
        if (b) s += `<div style="margin-top:7px;padding-top:7px;border-top:1px solid ${C.gridline};
                      color:${C.primary};font-weight:600">★ ${b.version_id} 版本更新</div>`;
        const p = model.previews.find(x => x.date_local === date);
        if (p) s += `<div style="margin-top:6px;color:${C.muted}">${p.version_id} 前瞻节目</div>`;
        return s;
      },
    },
    series,
  };

  chart.setOption(option, true);
}

/* ---------- 图例（自定义，承担显隐切换） ---------- */

function renderLegend() {
  const el = document.getElementById('legend');
  el.innerHTML = '';
  SERIES_META.forEach((s, i) => {
    if (i === 3) {
      const sep = document.createElement('div');
      sep.className = 'legend-sep';
      el.appendChild(sep);
    }
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.dataset.off = hidden.has(s.key) ? 'true' : 'false';
    const shapeClass = s.shape === 'dot' ? 'mark dot' : s.shape === 'bar' ? 'mark bar' : 'mark';
    item.innerHTML = `<span class="${shapeClass}" style="background:${s.color}"></span>
                      <span>${s.key}</span>` +
                     (s.note ? `<span style="color:#898781">· ${s.note}</span>` : '');
    item.onclick = () => {
      hidden.has(s.key) ? hidden.delete(s.key) : hidden.add(s.key);
      renderLegend(); render();
    };
    el.appendChild(item);
  });
}

/* ---------- 指标卡 ---------- */

function renderTiles() {
  const hist = snapshot.review_history || [];
  const last = hist[hist.length - 1];
  const online = (snapshot.online_series || []).filter(o => o.value != null);
  const videos = snapshot.character_videos || [];
  const boundaries = (snapshot.events || []).filter(e => e.is_version_boundary);
  const current = boundaries[boundaries.length - 1];

  const last7 = hist.slice(-7);
  const prev7 = hist.slice(-14, -7);
  const avg = a => a.length ? a.reduce((s, r) => s + r.new_reviews, 0) / a.length : null;
  const a7 = avg(last7), p7 = avg(prev7);
  const delta = (a7 != null && p7) ? (a7 - p7) / p7 * 100 : null;

  const daysSince = current
    ? daysBetween(current.date_local, snapshot.snapshot_date)
    : null;

  const totalViews = videos.reduce((s, v) => s + (v.latest_view || 0), 0);

  const tiles = [
    { k: 'Steam 同时在线', swatch: C.online,
      v: online.length ? fmt(online[online.length - 1].value) : '—',
      n: online.length ? `${online.length} 个采集点 · 历史不可回填` : '尚未采集' },
    { k: '累计好评率', swatch: C.rateCum,
      v: last ? last.cumulative_review_rate.toFixed(2) : '—', unit: '%',
      n: last ? `${fmt(last.cumulative_reviews)} 条评测` : '—' },
    { k: '近 7 日均新增评测', swatch: C.newReviews,
      v: a7 != null ? a7.toFixed(1) : '—',
      n: delta != null
        ? `<span class="${delta >= 0 ? 'good' : 'bad'}">${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%</span> 对比前 7 日`
        : '—', raw: true },
    { k: '当前版本',
      v: current ? current.version_id : '—',
      n: daysSince != null ? `上线 ${daysSince} 天 · ${current.date_local}` : '—' },
    { k: '登记官方视频', swatch: C.video,
      v: fmt(videos.length),
      n: `累计播放 ${(totalViews / 1e4).toFixed(0)} 万` },
    { k: '评测历史覆盖',
      v: snapshot.review_history_coverage ? snapshot.review_history_coverage.days : '—',
      unit: '天',
      n: snapshot.review_history_coverage
        ? `${snapshot.review_history_coverage.start} 起` : '—' },
  ];

  document.getElementById('tiles').innerHTML = tiles.map(t => `
    <div class="tile">
      <div class="k">${t.swatch ? `<span class="swatch" style="background:${t.swatch}"></span>` : ''}${t.k}</div>
      <div class="v">${t.v}${t.unit ? `<span class="unit">${t.unit}</span>` : ''}</div>
      <div class="n">${t.n}</div>
    </div>`).join('');
}

/* ---------- 下方表格 ---------- */

function renderVersionTable() {
  const hist = snapshot.review_history || [];
  const byDate = new Map(hist.map(r => [r.date_local, r]));
  const dates = hist.map(r => r.date_local);
  const boundaries = (snapshot.events || []).filter(e => e.is_version_boundary);

  const rows = boundaries.map(b => {
    const i = dates.indexOf(b.date_local);
    if (i < 0) return null;
    const pre = dates.slice(Math.max(0, i - 7), i).map(d => byDate.get(d));
    const post = dates.slice(i, i + 7).map(d => byDate.get(d));
    if (pre.length < 4 || post.length < 4) return null;
    const mean = a => a.reduce((s, r) => s + r.new_reviews, 0) / a.length;
    const rate = a => a.reduce((s, r) => s + r.new_positive, 0) /
                      a.reduce((s, r) => s + r.new_reviews, 0) * 100;
    const pn = mean(pre), qn = mean(post), pr = rate(pre), qr = rate(post);
    return { v: b.version_id, d: b.date_local, pn, qn,
             dn: (qn - pn) / pn * 100, pr, qr, dr: qr - pr };
  }).filter(Boolean);

  const tb = document.querySelector('#versionTable tbody');
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="6" class="muted">暂无具备完整前后 7 天窗口的版本</td></tr>`;
    return;
  }
  tb.innerHTML = rows.map(r => `
    <tr>
      <td><span class="chip">${r.v}</span></td>
      <td class="muted">${r.d}</td>
      <td class="num">${r.pn.toFixed(1)} → <b>${r.qn.toFixed(1)}</b></td>
      <td class="num ${r.dn >= 0 ? 'pos' : 'neg'}">${r.dn >= 0 ? '+' : ''}${r.dn.toFixed(1)}%</td>
      <td class="num">${r.pr.toFixed(2)}% → <b>${r.qr.toFixed(2)}%</b></td>
      <td class="num ${r.dr >= 0 ? 'pos' : 'neg'}">${r.dr >= 0 ? '+' : ''}${r.dr.toFixed(2)}pp</td>
    </tr>`).join('');

  // 说明被排除的版本，避免读者误以为数据缺失
  const excluded = boundaries
    .filter(b => !rows.some(r => r.v === b.version_id))
    .map(b => b.version_id);
  const notes = [];
  if (excluded.length) {
    notes.push(`${excluded.join('、')} 无完整前后窗口：该版本即 Steam 首发日，
                之前没有评测数据可比。`);
  }
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
};

function renderLangTable() {
  const agg = {};
  (snapshot.review_history || []).forEach(r => {
    Object.entries(r.top_languages || {}).forEach(([k, v]) => {
      agg[k] = (agg[k] || 0) + v;
    });
  });
  const total = Object.values(agg).reduce((a, b) => a + b, 0);
  const rows = Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const max = rows.length ? rows[0][1] : 1;

  document.querySelector('#langTable tbody').innerHTML = rows.map(([k, v]) => `
    <tr>
      <td>${LANG_LABEL[k] || k}</td>
      <td class="num">${fmt(v)}</td>
      <td>
        <div class="bar-cell">
          <div class="bar-track"><div class="bar-fill"
            style="width:${(v / max * 100).toFixed(1)}%;background:${C.newReviews}"></div></div>
          <span style="min-width:44px;text-align:right;font-variant-numeric:tabular-nums">
            ${(v / total * 100).toFixed(1)}%</span>
        </div>
      </td>
    </tr>`).join('');
}

function renderDataTable() {
  const model = buildModel(snapshot);
  const { from, to } = slice(model);
  const evByDate = new Map();
  (snapshot.events || []).forEach(e => {
    const arr = evByDate.get(e.date_local) || [];
    if (e.is_version_boundary) arr.push(`★ ${e.version_id} 版本更新`);
    else if (e.type === 'version_preview') arr.push(`${e.version_id} 前瞻`);
    else if (e.type === 'content') arr.push(e.label);
    evByDate.set(e.date_local, arr);
  });

  const rows = model.axis.slice(from, to + 1).reverse().map(d => {
    const h = model.histBy.get(d);
    const o = model.onlineBy.get(d);
    const ev = (evByDate.get(d) || []).join('、');
    return `<tr>
      <td>${d}</td>
      <td class="num">${h ? fmt(h.new_reviews) : '—'}</td>
      <td class="num">${h ? fmt(h.new_positive) : '—'}</td>
      <td class="num">${h ? fmt(h.new_negative) : '—'}</td>
      <td class="num">${h ? pct(h.daily_review_rate) : '—'}</td>
      <td class="num">${h ? pct(h.cumulative_review_rate) : '—'}</td>
      <td class="num">${o && o.value != null ? fmt(o.value) : '—'}</td>
      <td class="muted">${ev}</td>
    </tr>`;
  });
  document.querySelector('#dataTable tbody').innerHTML = rows.join('');
}

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
  document.getElementById('caveat').innerHTML = `
    <b>口径限制</b>
    评测历史由 Steam appreviews 游标翻页回填重建（${cov ? cov.days + ' 天，' + cov.start + ' 起' : '—'}），
    只含<b>今天仍然存在</b>的评测，被删除或隐藏的不会出现，因此越早的日期越可能低估当日真实值。
    Steam 同时在线人数<b>无法回填</b>（SteamDB 不可程序化访问、SteamCharts 未收录该 App），
    目前仅有 ${online} 个逐日采集点，需持续积累。
    B 站接口只返回<b>当前</b>累计播放量，没有历史播放曲线，图中散点表示"发布日 × 当前播放量"，不是当日播放量。
    版本更新竖线取自 Steam 官方公告的 Update Announcement，已与前瞻节目公告区分。
    所有事件仅表示时间节点，<b>不自动表示因果关系</b>。`;
}

/* ---------- 引导 ---------- */

async function loadGame(gameId) {
  const res = await fetch(`../data/snapshot_${gameId}.json`);
  snapshot = await res.json();

  document.getElementById('metaDate').textContent = snapshot.snapshot_date;
  const cov = snapshot.review_history_coverage;
  document.getElementById('metaBadges').innerHTML =
    `<span class="badge live"><span class="dot"></span>逐日采集 observed</span>
     ${cov ? `<span class="badge recon" style="margin-left:6px"><span class="dot"></span>评测历史 reconstructed ${cov.days} 天</span>` : ''}`;

  renderTiles();
  renderLegend();
  render();
  renderVersionTable();
  renderLangTable();
  renderDataTable();
  renderSources();

  document.getElementById('loading').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  chart.resize();
}

async function boot() {
  chart = echarts.init(document.getElementById('pulse'), null, { renderer: 'canvas' });
  window.addEventListener('resize', () => chart.resize());

  const idx = await fetch('../data/index.json').then(r => r.json()).catch(() => null);
  const games = (idx && idx.games) || [];
  const sel = document.getElementById('gameSelect');

  if (!games.length) {
    document.getElementById('loading').textContent =
      '没有可用快照。请先运行 python pipeline/build_snapshot.py';
    return;
  }
  sel.innerHTML = games.map(g =>
    `<option value="${g.game_id}">${g.display_name}</option>`).join('');
  sel.onchange = () => loadGame(sel.value);

  const pressOnly = (sel, btn) => {
    document.querySelectorAll(sel).forEach(b => b.setAttribute('aria-pressed', 'false'));
    btn.setAttribute('aria-pressed', 'true');
  };

  document.querySelectorAll('#rangeSeg button').forEach(btn => {
    btn.onclick = () => {
      pressOnly('#rangeSeg button', btn);
      rangeDays = Number(btn.dataset.days);
      if (viewMode === 'compare') { renderCompare(); }
      else { render(); renderDataTable(); }
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
      document.getElementById('alignGroup').classList.toggle('hidden', !compare);
      document.getElementById('toggleTable').classList.toggle('hidden', compare);
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

  const tbtn = document.getElementById('toggleTable');
  tbtn.onclick = () => {
    const card = document.getElementById('tableCard');
    const show = card.classList.contains('hidden');
    card.classList.toggle('hidden', !show);
    tbtn.textContent = show ? '隐藏数据表' : '显示数据表';
  };

  await loadGame(games[0].game_id);
}

boot();
