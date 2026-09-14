/* 三方对比视图
 *
 * 与单游戏视图的关键差别：颜色跟随「游戏」这个实体，固定不变。
 * 筛掉一款游戏不会让其余重新着色，读者学到的「鸣潮是蓝色」始终成立。
 *
 * 两种对齐方式解决同一个问题的两面：
 *   日历日期   看同期表现，但三款上线时间不同，新游的上线尖峰会与
 *              老游的稳态混在一起
 *   上线后天数 看发行曲线形状，把「上线热度」与「同期表现」分开
 */

let cmpChart = null;
let compareData = null;
let alignMode = 'absolute';
const cmpHidden = new Set();

const CMP_LANES = [
  { top: 46,  height: 160, key: 'new_reviews' },
  { top: 250, height: 120, key: 'cum_rate'    },
  { top: 412, height: 104, key: 'online'      },
  { top: 560, height: 74,  key: 'versions'    },
  { top: 686, height: 150, key: 'videos'      },
];

/* 相对模式的数据点是 [天数, 数值] 二元组，绝对模式是标量。
   端点标签与提示框必须统一取值，否则会在相对模式下调用 undefined.toFixed。 */
const numOf = v => (Array.isArray(v) ? v[1] : v);

function cmpDateAxis(start, end) {
  const out = [];
  let cur = start, guard = 0;
  while (cur <= end && guard++ < 2000) { out.push(cur); cur = addDays(cur, 1); }
  return out;
}

/* 可见窗口：绝对模式取共同窗口末尾 N 天；相对模式取上线后前 N 天 */
function cmpWindow() {
  const w = compareData.common_window;
  if (alignMode === 'relative') {
    const max = compareData.relative_days;          // 最长者，鸣潮 444 天
    return { relMax: rangeDays ? Math.min(rangeDays, max) : max,
             common: compareData.relative_common_days };
  }
  const axis = cmpDateAxis(w.start, w.end);
  const from = rangeDays ? Math.max(0, axis.length - rangeDays) : 0;
  return { axis: axis.slice(from) };
}

function seriesFor(game, key, win) {
  const pts = game[key] || [];
  if (alignMode === 'relative') {
    return pts.filter(p => p.t >= 0 && p.t <= win.relMax)
              .map(p => [p.t, p.v]);
  }
  const set = new Set(win.axis);
  const by = new Map(pts.filter(p => set.has(p.d)).map(p => [p.d, p.v]));
  return win.axis.map(d => (by.has(d) ? by.get(d) : null));
}

function renderCompare() {
  const win = cmpWindow();
  const rel = alignMode === 'relative';
  const games = compareData.games.filter(g => !cmpHidden.has(g.game_id));
  const shown = compareData.games;

  const grids = CMP_LANES.map(l => ({
    left: 66, right: 80, top: l.top, height: l.height,
  }));

  const baseX = {
    type: rel ? 'value' : 'category',
    axisLine: { lineStyle: { color: C.baseline } },
    axisTick: { show: false },
    splitLine: { show: false },
  };
  if (rel) { baseX.min = 0; baseX.max = win.relMax; }
  else { baseX.data = win.axis; }

  const xAxes = CMP_LANES.map((l, i) => ({
    ...baseX, gridIndex: i,
    boundaryGap: rel ? false : (l.key === 'new_reviews'),
    axisLabel: i === CMP_LANES.length - 1 ? {
      color: C.muted, fontSize: 11, fontFamily: FONT, margin: 12, hideOverlap: true,
      formatter: v => rel ? `${v}天` : String(v).slice(5),
    } : { show: false },
    axisPointer: { label: { show: i === CMP_LANES.length - 1,
      formatter: p => rel ? `上线后 ${p.value} 天` : p.value,
      backgroundColor: C.primary, fontFamily: FONT } },
  }));

  const yBase = {
    axisLine: { show: false }, axisTick: { show: false },
    splitLine: { lineStyle: { color: C.gridline } },
    axisLabel: { color: C.muted, fontSize: 11, fontFamily: FONT },
  };

  const yAxes = [
    { gridIndex: 0, ...yBase,
      axisLabel: { ...yBase.axisLabel, formatter: v => v >= 1000 ? (v/1000)+'k' : v } },
    { gridIndex: 1, ...yBase, scale: true,
      axisLabel: { ...yBase.axisLabel, formatter: v => v + '%' } },
    { gridIndex: 2, ...yBase,
      axisLabel: { ...yBase.axisLabel, formatter: v => v >= 1000 ? (v/1000).toFixed(0)+'k' : v } },
    { gridIndex: 3, type: 'category',
      data: shown.map(g => g.short_name).reverse(),
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { color: C.secondary, fontSize: 11.5, fontFamily: FONT } },
    { gridIndex: 4, ...yBase,
      axisLabel: { ...yBase.axisLabel, formatter: v => v >= 10000 ? (v/10000)+'万' : v } },
  ];

  const series = [];

  games.forEach(g => {
    series.push({
      name: g.short_name, type: 'line', xAxisIndex: 0, yAxisIndex: 0,
      data: seriesFor(g, 'new_reviews', win),
      showSymbol: false, smooth: false, connectNulls: false,
      lineStyle: { color: g.color, width: 1.8 }, itemStyle: { color: g.color },
    });
    series.push({
      name: g.short_name + '_rate', type: 'line', xAxisIndex: 1, yAxisIndex: 1,
      data: seriesFor(g, 'cum_rate', win),
      showSymbol: false, smooth: true, connectNulls: false,
      lineStyle: { color: g.color, width: 2.2 }, itemStyle: { color: g.color },
      endLabel: { show: true, fontFamily: FONT, fontSize: 11.5, fontWeight: 600,
        color: g.color, distance: 6,
        formatter: p => { const v = numOf(p.value);
                          return v != null ? v.toFixed(2) + '%' : ''; } },
      // 三条线的终值可能只差零点几个百分点，端点标签会叠在一起；
      // shiftY 让它们纵向错开而不是互相压住。
      labelLayout: { moveOverlap: 'shiftY' },
    });
    series.push({
      name: g.short_name + '_online', type: 'line', xAxisIndex: 2, yAxisIndex: 2,
      data: seriesFor(g, 'online', win),
      showSymbol: true, symbolSize: 8, connectNulls: true,
      lineStyle: { color: g.color, width: 2 },
      itemStyle: { color: g.color, borderColor: C.surface, borderWidth: 2 },
      endLabel: { show: true, fontFamily: FONT, fontSize: 11.5, fontWeight: 600,
        color: g.color, distance: 6,
        formatter: p => { const v = numOf(p.value);
                          return v != null ? fmt(v) : ''; } },
      labelLayout: { moveOverlap: 'shiftY' },
    });
  });

  // 版本节奏轨道：每款游戏一行，标记版本更新日
  const laneIdx = new Map(shown.map((g, i) => [g.game_id, shown.length - 1 - i]));
  games.forEach(g => {
    const pts = (g.boundaries || [])
      .filter(b => rel ? (b.t >= 0 && b.t <= win.relMax)
                       : win.axis.includes(b.d))
      .map(b => ({ value: [rel ? b.t : b.d, g.short_name], meta: { ...b, game: g.short_name } }));
    series.push({
      name: g.short_name + '_ver', type: 'scatter', xAxisIndex: 3, yAxisIndex: 3,
      data: pts, symbol: 'rect', symbolSize: [3, 22],
      itemStyle: { color: g.color },
      label: {
        // 必须放右侧而不是上方：行高仅 ~24px，position:'top' 会把版本号
        // 推进相邻游戏的行里（曾出现「鸣潮3.0」「1|3」这类重叠）。
        // 放右侧则纵向居中于自己所在行，只需处理横向错开。
        show: true, position: 'right', distance: 5,
        fontFamily: FONT, fontSize: 10.5, fontWeight: 600, color: g.color,
        formatter: p => p.data.meta.version || '',
      },
      labelLayout: { moveOverlap: 'shiftX' },
      z: 5,
    });
  });

  // B 站官方视频
  games.forEach(g => {
    const pts = (g.videos || [])
      .filter(v => v.v != null && (rel ? (v.t >= 0 && v.t <= win.relMax)
                                      : win.axis.includes(v.d)))
      .map(v => ({ value: [rel ? v.t : v.d, v.v], meta: { ...v, game: g.short_name } }));
    series.push({
      name: g.short_name + '_vid', type: 'scatter', xAxisIndex: 4, yAxisIndex: 4,
      data: pts,
      symbolSize: d => Math.max(8, Math.min(24, 8 + Math.sqrt(d[1]) / 190)),
      itemStyle: { color: g.color, opacity: .82,
                   borderColor: C.surface, borderWidth: 2 },
    });
  });

  // 相对模式下在线轨道基本不可比：每款游戏只有 1 个采集点，且各自
  // 处于上线后的不同天数，落在横轴的不同位置，连不成可比的曲线。
  const onlineNote = rel
    ? '相对对齐下暂不可比 · 各游戏仅 1 个采集点且处于上线后不同天数'
    : '逐日采集 · 历史不可回填';

  const laneTitles = [
    ['每日新增评测', '讨论热度代理 · 回填重建'],
    ['累计好评率', rel ? '自上线起累计' : '截至该日累计'],
    ['Steam 同时在线', onlineNote],
    ['版本节奏', '各自 Steam 官方公告的版本更新日'],
    ['B 站官方视频', rel ? '上线后第 N 天发布 · 当前累计播放量'
                         : '发布日 · 当前累计播放量'],
  ];

  cmpChart.setOption({
    animationDuration: 420,
    textStyle: { fontFamily: FONT },
    // laneTitle 来自 app.js，签名是 (lane, top)，lane 需要 title/subtitle 两个字段。
    // 对比视图的轨道不来自 dashboard.yml（它是固定的五轨对照），
    // 所以在这里就地构造出同样形状的对象，而不是让 laneTitle 兼容两种入参。
    title: CMP_LANES.map((l, i) => laneTitle(
      { title: laneTitles[i][0], subtitle: laneTitles[i][1] }, l.top)),
    grid: grids, xAxis: xAxes, yAxis: yAxes,
    axisPointer: {
      link: [{ xAxisIndex: 'all' }],
      lineStyle: { color: C.baseline, width: 1 },
      label: { backgroundColor: C.primary, fontFamily: FONT },
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#fff', borderColor: 'rgba(11,11,11,0.12)', borderWidth: 1,
      padding: [10, 12], textStyle: { color: C.primary, fontSize: 12.5, fontFamily: FONT },
      extraCssText: 'box-shadow:0 6px 22px rgba(11,11,11,0.10);border-radius:9px;',
      formatter: params => {
        if (!params.length) return '';
        const key = params[0].axisValue;
        const head = rel ? `上线后第 ${key} 天` : key;
        let s = `<div style="font-weight:600;margin-bottom:6px">${head}</div>`;
        const row = (color, label, value) =>
          `<div style="display:flex;align-items:center;gap:7px;margin:3px 0">
             <span style="width:8px;height:8px;border-radius:2px;background:${color};flex:none"></span>
             <span style="color:${C.secondary}">${label}</span>
             <span style="margin-left:auto;font-weight:600;font-variant-numeric:tabular-nums">${value}</span>
           </div>`;
        games.forEach(g => {
          const find = (arr) => {
            const p = (arr || []).find(x => rel ? x.t === Number(key) : x.d === key);
            return p ? p.v : null;
          };
          const nr = find(g.new_reviews), cr = find(g.cum_rate), on = find(g.online);
          if (nr == null && cr == null && on == null) return;
          s += `<div style="margin-top:6px;font-weight:600;color:${g.color}">${g.short_name}</div>`;
          if (nr != null) s += row(g.color, '新增评测', fmt(nr) + ' 条');
          if (cr != null) s += row(g.color, '累计好评率', cr.toFixed(2) + '%');
          if (on != null) s += row(g.color, '同时在线', fmt(on));
        });
        games.forEach(g => {
          (g.boundaries || []).filter(b => rel ? b.t === Number(key) : b.d === key)
            .forEach(b => {
              s += `<div style="margin-top:7px;padding-top:7px;border-top:1px solid ${C.gridline};
                     font-weight:600;color:${g.color}">★ ${g.short_name} ${b.version} 版本更新</div>`;
            });
          (g.videos || []).filter(v => rel ? v.t === Number(key) : v.d === key)
            .forEach(v => {
              s += `<div style="margin-top:6px;padding-top:6px;border-top:1px solid ${C.gridline}">
                      <div style="color:${g.color};font-weight:600">${g.short_name} · B 站发布</div>
                      <div style="max-width:300px;margin-top:2px">${v.title || ''}</div>
                      <div style="color:${C.muted};font-size:11.5px">当前播放 ${fmt(v.v)}</div>
                    </div>`;
            });
        });
        return s;
      },
    },
    series,
  }, true);
}

function renderCmpLegend() {
  const el = document.getElementById('cmpLegend');
  el.innerHTML = '';
  compareData.games.forEach(g => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.dataset.off = cmpHidden.has(g.game_id) ? 'true' : 'false';
    item.innerHTML =
      `<span class="mark" style="background:${g.color}"></span>
       <span style="font-weight:500">${g.short_name}</span>
       <span style="color:#898781">· ${g.developer || ''} · 上线 ${g.review_start}</span>`;
    item.onclick = () => {
      cmpHidden.has(g.game_id) ? cmpHidden.delete(g.game_id) : cmpHidden.add(g.game_id);
      if (cmpHidden.size === compareData.games.length) cmpHidden.delete(g.game_id);
      renderCmpLegend(); renderCompare();
    };
    el.appendChild(item);
  });
}

function renderCmpTiles() {
  document.getElementById('cmpTiles').innerHTML = compareData.summary.map(s => {
    const g = compareData.games.find(x => x.game_id === s.game_id);
    return `<div class="tile">
      <div class="k"><span class="swatch" style="background:${s.color}"></span>${s.short_name}</div>
      <div class="v">${fmt(s.latest_online)}<span class="unit">在线</span></div>
      <div class="n">窗口内日均 ${s.window_daily_avg} 条评测 · 好评率 ${s.window_rate}%</div>
      <div class="n" style="margin-top:2px">累计 ${fmt(g.total_reviews)} 条 · 共 ${g.review_days} 天数据</div>
    </div>`;
  }).join('');
}

function renderCmpTables() {
  const w = compareData.common_window;
  document.getElementById('cmpWindowNote').textContent =
    `共同窗口 ${w.start} → ${w.end}（${w.days} 天），起点取三者评测起点的最大值，` +
    `即最晚上线的异环。窗口之前其余游戏已在运营，不代表数值为 0。`;

  document.querySelector('#cmpTable tbody').innerHTML = compareData.summary.map(s => `
    <tr>
      <td><span class="swatch" style="display:inline-block;width:8px;height:8px;
           border-radius:2px;background:${s.color};margin-right:6px"></span>${s.short_name}</td>
      <td class="num">${fmt(s.window_reviews)}</td>
      <td class="num"><b>${s.window_daily_avg}</b></td>
      <td class="num">${s.window_rate}%</td>
      <td class="num">${fmt(s.latest_online)}</td>
      <td class="num">${s.versions_in_window}</td>
    </tr>`).join('');

  document.querySelector('#cadenceTable tbody').innerHTML = compareData.games.map(g => {
    const inWin = (g.boundaries || []).filter(b => b.d >= w.start && b.d <= w.end);
    const all = (g.boundaries || []).slice(-6);
    let gap = '—';
    if (all.length >= 2) {
      const days = [];
      for (let i = 1; i < all.length; i++) {
        days.push((new Date(all[i].d + 'T00:00:00Z') - new Date(all[i-1].d + 'T00:00:00Z')) / 864e5);
      }
      gap = Math.round(days.reduce((a, b) => a + b, 0) / days.length) + ' 天';
    }
    const list = inWin.length
      ? inWin.map(b => `<span class="chip">${b.version}</span>`).join(' ')
      : '<span class="muted">窗口内无版本更新</span>';
    return `<tr>
      <td><span class="swatch" style="display:inline-block;width:8px;height:8px;
           border-radius:2px;background:${g.color};margin-right:6px"></span>${g.short_name}</td>
      <td>${list}</td>
      <td class="num">${gap}</td>
    </tr>`;
  }).join('');

  document.getElementById('cmpCaveat').innerHTML =
    '<b>对比口径限制</b> ' +
    compareData.caveats.map(c => c).join(' ');
}

async function loadCompare() {
  if (!compareData) {
    compareData = await fetch('../data/compare.json').then(r => r.json());
  }
  if (!cmpChart) {
    cmpChart = echarts.init(document.getElementById('cmpPulse'), null, { renderer: 'canvas' });
    window.addEventListener('resize', () => cmpChart && cmpChart.resize());
  }
  document.getElementById('cmpNote').textContent =
    '五条轨道共享同一横轴。各轨道单位不同，分别独立计量，不共用纵轴；' +
    '颜色固定跟随游戏，筛选不会改变其余游戏的配色。';
  renderCmpTiles();
  renderCmpLegend();
  renderCompare();
  renderCmpTables();
  cmpChart.resize();
}
