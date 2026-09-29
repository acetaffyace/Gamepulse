/* Video facets live beside the shared operations timeline, with their own clocks. */
const videoCharts = [];
const VIDEO_SOURCE_LABELS = { bilibili: 'B 站', 'youtube:global': 'YouTube · 全球',
  'youtube:ja': 'YouTube · 日语', 'youtube:ko': 'YouTube · 韩语', 'youtube:zh-tw': 'YouTube · 繁中' };
const VIDEO_SOURCE_COLORS = { bilibili: '#ae4377', 'youtube:global': '#246cc3',
  'youtube:ja': '#ad571f', 'youtube:ko': '#167b60', 'youtube:zh-tw': '#694bb4' };
const videoEscape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const videoNumber = (n, metric) => n == null ? '—' : VideoModel.METRICS[metric].unit === '%'
  ? n.toFixed(2) + '%' : n.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
function disposeVideoCharts() { videoCharts.splice(0).forEach(c => c.dispose()); }
window.addEventListener('resize', () => videoCharts.forEach(c => c.resize()));

function selectedVideoRecords(view, ctx) {
  const records = [], seen = new Set();
  ctx.subjects.forEach(subject => {
    videoCompareGroups(subject, view).forEach(group => group.videos.forEach(video => {
      const source = group.platform === 'bilibili' ? 'bilibili' : 'youtube:' + group.locale;
      const id = subject.key + ':' + source + ':' + (video.bvid || video.video_id);
      if (seen.has(id)) return;
      const key = videoAxisKeyOf(video, subject, ctx.axis.align);
      // Version-assigned previews remain visible; ordinary timeline is never extended by them.
      const preview = subject.kind === 'version' && video.version_confirmed &&
        video.version_id === subject.versionId && video.pubdate < subject.window.start;
      if (view.mode !== 'daily' && !preview && (key == null || !ctx.axis.keys.includes(key))) return;
      seen.add(id);
      const baseline = group.allVideos.map(v => VideoModel.samples({ video: v, platform: group.platform }, 'view').at(-1)?.value).filter(v => v != null && v > 0).sort((a, b) => a - b);
      const middle = Math.floor(baseline.length / 2);
      const referenceMedian = baseline.length ? (baseline[middle] + baseline[Math.floor((baseline.length - 1) / 2)]) / 2 : null;
      const window = analysisWindow(subject);
      records.push({ video, source, platform: group.platform, locale: group.locale, referenceMedian,
        observationStart: window.start, observationEnd: window.end,
        type: group.type, subjectKey: subject.key, subjectLabel: subject.label,
        gameId: subject.gameId, snapshotDate: subject.snap.snapshot_date,
        name: compactVideoLabel(video, subject), color: subject.color });
    }));
  });
  return records;
}

function videoExport(view, records) {
  const rows = VideoModel.exportRows(VideoModel.prepare(records, view), view);
  if (!rows.length) { toast('当前条件没有可导出的有效观测'); return; }
  const keys = Object.keys(rows[0]);
  const safe = v => typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
  const text = [keys.join(','), ...rows.map(row => keys.map(k => csvEscape(safe(row[k]))).join(','))].join('\r\n');
  downloadBlob(`gamepulse_video_${view.mode}_${view.metric}.csv`, '\ufeff' + text, 'text/csv;charset=utf-8');
}

async function exportVideoPng(section, view) {
  const cards = [...section.querySelectorAll('.video-facet')];
  const columns = Math.min(3, cards.length), tileWidth = 430, tileHeight = 330;
  const canvas = document.createElement('canvas');
  canvas.width = columns * tileWidth; canvas.height = 110 + Math.ceil(cards.length / columns) * tileHeight;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#172637'; ctx.font = 'bold 19px sans-serif';
  ctx.fillText('GamePulse · ' + VideoModel.METRICS[view.metric].label, 20, 30);
  ctx.font = '13px sans-serif';
  const scope = section.querySelector('[data-video-control="pair"]');
  ctx.fillText(scope.selectedOptions[0].textContent.slice(0, 85), 20, 53);
  const snapshotLabel = section.dataset.snapshotPresentation === 'rank' ? '当前累计 · 来源内排行' : '当前累计 · 按发布日期';
  ctx.fillText(`${{ snapshot: snapshotLabel, tracking: '追踪后增量 · T0 为各自首采', age: '发布同龄 · D0 为发布日', daily: '每日净增 · 按采样日期' }[view.mode]} · ${view.sharedY || view.layout === 'overlay' ? '统一刻度' : '独立刻度'}${view.mode === 'age' || view.mode === 'tracking' ? ' · 首 ' + view.compareDays + ' 天' : ''}`, 20, 76);
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i], x = (i % columns) * tileWidth, y = 110 + Math.floor(i / columns) * tileHeight;
    ctx.fillStyle = '#172637'; ctx.font = 'bold 14px sans-serif';
    ctx.fillText(card.querySelector('h3').textContent, x + 20, y + 20);
    ctx.font = '12px sans-serif'; ctx.fillStyle = '#596877';
    ctx.fillText(card.querySelector('.video-selected').textContent.slice(0, 58), x + 20, y + 42);
    const chart = echarts.getInstanceByDom(card.querySelector('.video-chart'));
    if (chart) {
      const img = new Image();
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject;
        img.src = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' }); });
      ctx.drawImage(img, x + 10, y + 52, tileWidth - 20, 240);
    } else ctx.fillText('缺少符合条件的有效观测', x + 20, y + 150);
  }
  const link = document.createElement('a'); link.download = `gamepulse_video_${view.mode}_${view.metric}.png`;
  link.href = canvas.toDataURL('image/png'); link.click();
}

function renderVideoDashboards(ctx) {
  const host = document.getElementById('videoDashboards');
  const active = document.activeElement;
  const focusKey = active?.dataset?.videoControl;
  const focusView = active?.closest('[data-view-id]')?.dataset.viewId;
  disposeVideoCharts();
  host.replaceChildren();
  videoViews.forEach(view => renderVideoDashboard(host, view, ctx));
  if (focusKey && focusView) {
    [...host.querySelectorAll('[data-video-control]')].find(el =>
      el.dataset.videoControl === focusKey && el.closest('[data-view-id]').dataset.viewId === focusView)?.focus({ preventScroll: true });
  }
}

function renderVideoDashboard(host, view, ctx) {
  const records = selectedVideoRecords(view, ctx);
  const prepared = VideoModel.prepare(records, view);
  const sources = (view.platforms.includes('bilibili') ? ['bilibili'] : [])
    .concat(view.platforms.includes('youtube') ? view.locales.map(l => 'youtube:' + l) : []);
  const pairMap = new Map();
  prepared.slice().sort((a, b) => b.video.pubdate.localeCompare(a.video.pubdate)).forEach(r => {
    if (!pairMap.has(r.pair)) pairMap.set(r.pair, { label: (ctx.multi ? r.subjectLabel + ' · ' : '') + r.name, paired: !!r.video.pair_id });
  });
  if (view.focusPair && !pairMap.has(view.focusPair)) view.focusPair = '';
  const mixedRates = view.metric === 'engagement' && view.platforms.length > 1;
  if (mixedRates) view.layout = 'facets';
  const field = VideoModel.METRICS[view.metric];
  const percent = field.unit === '%';
  const indexed = view.mode === 'snapshot' && view.metric === 'view' && view.scale === 'index';
  const allPairs = [...pairMap.keys()];
  const palette = ['#246cc3', '#b05e20', '#167b60', '#694bb4', '#ae4377', '#7e6626'];
  const pairColor = key => palette[allPairs.indexOf(key) % palette.length];
  const valid = prepared.filter(r => r.points.some(p => p.value != null));
  // Keep curve overview readable, with an explicit count and access to every content via the picker.
  const curvePairs = [...pairMap.keys()].filter(pair => valid.some(r => r.pair === pair)).slice(0, 3);
  const shown = prepared.filter(r => view.mode === 'snapshot' ||
    (view.focusPair ? r.pair === view.focusPair : curvePairs.includes(r.pair)));
  const section = document.createElement('section');
  section.className = 'card video-dashboard'; section.dataset.viewId = view.id;
  const control = (key, title, options, selected) => `<label>${title}<select data-video-control="${key}" aria-label="${title}">${options.map(([value, label]) =>
    `<option value="${videoEscape(value)}" ${value === selected ? 'selected' : ''}>${videoEscape(label)}</option>`).join('')}</select></label>`;
  section.innerHTML = `<div class="video-head"><div><h2>官方视频</h2><span class="video-scope">${videoEscape(view.content_types.map(t => VIDEO_CONTENT_LABELS[t]).join(' / '))} · ${records.length} 支</span></div>
    <div class="segmented" role="group" aria-label="视频布局"><button data-layout="facets" aria-pressed="${view.layout !== 'overlay'}">分面</button><button data-layout="overlay" aria-pressed="${view.layout === 'overlay'}" ${mixedRates ? 'disabled title="平台互动率公式不同，请使用点赞 / 播放进行叠图"' : ''}>叠图</button></div></div>
    <div class="video-source-picks" role="group" aria-label="视频来源">${Object.entries(VIDEO_SOURCE_LABELS).map(([key, name]) => `<label><input type="checkbox" data-source-pick="${key}" data-video-control="source:${key}" ${sources.includes(key) ? 'checked' : ''}>${name}</label>`).join('')}</div>
    <div class="video-toolbar">${control('metric', '指标', Object.entries(VideoModel.METRICS).map(([k, v]) => [k, v.label]), view.metric)}
    ${control('mode', '观察方式', [['snapshot', '当前累计'], ['tracking', '追踪后增量'], ['age', '发布同龄'], ['daily', '每日净增']], view.mode)}
    <label class="video-days" ${['snapshot', 'daily'].includes(view.mode) ? 'hidden' : ''}>${view.mode === 'age' ? '发布后首' : '首次采样后首'}<input data-video-control="days" aria-label="视频比较天数" type="number" min="1" max="365" value="${view.compareDays}">天</label>
    ${control('type', '内容类型', [['all', '全部重点类型'], ...Object.entries(VIDEO_CONTENT_LABELS)], view.content_types.length === 1 ? view.content_types[0] : 'all')}
    ${view.mode === 'snapshot' && view.metric === 'view' ? control('scale', '数值标尺', [['abs', '实际累计值'], ['index', '相对同来源同类中位数']], view.scale) : ''}
    <label class="video-scale"><input data-video-control="shared" type="checkbox" ${view.sharedY ? 'checked' : ''} ${view.layout === 'overlay' ? 'disabled' : ''}>统一纵轴</label>
    <div class="video-export-actions"><button class="linkish" data-export-video aria-label="导出当前视频视图 CSV">CSV</button><button class="linkish" data-export-video-png aria-label="导出当前视频视图 PNG">PNG</button></div></div>
    <div class="video-focus">${control('pair', '联动内容', [['', '全部内容'], ...[...pairMap].map(([key, p]) => [key, p.label + (p.paired ? '' : ' · 未配对')])], view.focusPair)}
    <button class="linkish" data-clear-pair ${!view.focusPair ? 'disabled' : ''}>取消选择</button>
    <span class="video-status-inline" role="status">${view.mode === 'snapshot' ? (indexed ? '同来源同类中位数＝1× · 未校正视频年龄' : '按发布日期定位 · 点击图点联动同内容') : view.mode === 'daily' ? '按采样日期 · 仅相邻自然日作差 · 缺采不补零' : view.mode === 'age'
      ? `D0–D${view.compareDays - 1} · ${valid.length}/${prepared.length} 支完整采样`
      : `T0＝各自首次有效采样 · ${view.focusPair ? '所选内容' : `最近 ${curvePairs.length} 个有数据的内容`} · 缺采断线`}</span></div>
    ${mixedRates ? '<p class="video-status-inline">B 站：（赞＋币＋藏）/播放；YouTube：（赞＋评）/观看。公式不同，分开展示。</p>' : ''}
    <div class="video-content-picks" role="group" aria-label="联动内容快捷选择">${[...pairMap].slice(0, 6).map(([key, info]) => `<button data-focus-key="${videoEscape(key)}" aria-pressed="${view.focusPair === key}"><i style="background:${pairColor(key)}"></i>${videoEscape(info.label)}</button>`).join('')}${pairMap.size > 6 ? '<span>更多内容见上方选择器</span>' : ''}</div>
    <div class="video-facets ${view.layout === 'overlay' ? 'overlay' : ''}"></div>
    <details class="video-details"><summary>视频明细 · 发布时间、年龄与采样</summary><div class="table-wrap"><table><thead><tr><th>内容</th><th>来源</th><th>发布</th><th>最近有效采样</th><th>视频年龄</th><th>${videoEscape(field.label)}</th><th>首采年龄</th><th>状态</th></tr></thead><tbody></tbody></table></div></details>`;
  host.append(section);
  function change() { renderAll(); }
  section.querySelectorAll('[data-source-pick]').forEach(input => input.onchange = () => {
    const selected = [...section.querySelectorAll('[data-source-pick]:checked')].map(el => el.dataset.sourcePick);
    if (!selected.length) { input.checked = true; toast('至少保留一个视频来源'); return; }
    view.platforms = [...new Set(selected.map(key => key.startsWith('youtube') ? 'youtube' : 'bilibili'))];
    view.locales = selected.filter(key => key.startsWith('youtube:')).map(key => key.split(':')[1]);
    change();
  });
  section.querySelectorAll('[data-focus-key]').forEach(button => button.onclick = () => { view.focusPair = view.focusPair === button.dataset.focusKey ? '' : button.dataset.focusKey; change(); });
  const scaleControl = section.querySelector('[data-video-control="scale"]');
  if (scaleControl) scaleControl.onchange = e => { view.scale = e.target.value; change(); };
  section.querySelectorAll('[data-layout]').forEach(btn => btn.onclick = () => { view.layout = btn.dataset.layout; change(); });
  section.querySelector('[data-video-control="metric"]').onchange = e => { view.metric = e.target.value; change(); };
  section.querySelector('[data-video-control="mode"]').onchange = e => { view.mode = e.target.value; change(); };
  section.querySelector('[data-video-control="days"]').onchange = e => {
    if (!e.target.checkValidity()) { e.target.reportValidity(); return; }
    view.compareDays = Math.max(1, Math.min(365, Math.floor(Number(e.target.value)))); change();
  };
  section.querySelector('[data-video-control="type"]').onchange = e => {
    view.content_types = e.target.value === 'all' ? [...config.important_video_types] : [e.target.value]; change();
  };
  section.querySelector('[data-video-control="shared"]').onchange = e => { view.sharedY = e.target.checked; change(); };
  section.querySelector('[data-video-control="pair"]').onchange = e => { view.focusPair = e.target.value; change(); };
  section.querySelector('[data-clear-pair]').onclick = () => { view.focusPair = ''; change(); };
  section.querySelector('[data-export-video]').onclick = () => videoExport(view, shown);
  section.querySelector('[data-export-video-png]').onclick = () => exportVideoPng(section, view).catch(() => toast('图片导出失败，请重试'));
  const displayed = shown.filter(r => r.points.some(p => p.value != null));
  const values = displayed.flatMap(r => r.points.map(p => p.value).filter(v => v != null));
  const maxValue = values.length ? Math.max(...values) : 1;
  const minValue = values.length ? Math.min(0, ...values) : 0;
  const magnitude = maxValue > 0 ? 10 ** Math.floor(Math.log10(maxValue)) : 1;
  const bound = maxValue > 0 ? Math.ceil(maxValue / magnitude) * magnitude : 1;
  const colorFor = r => view.layout === 'overlay' ? VIDEO_SOURCE_COLORS[r.source]
    : pairColor(r.pair);
  const xDates = [...new Set(view.mode === 'daily' ? prepared.flatMap(r => r.points.map(p => p.date)) : prepared.map(r => r.video.pubdate))].sort();
  const chartSets = view.layout === 'overlay' ? [{ key: 'all', rows: shown, label: '所选来源 · 统一纵轴' }]
    : sources.map(key => ({ key, rows: shown.filter(r => r.source === key), label: VIDEO_SOURCE_LABELS[key] }));
  const viewCharts = [];
  chartSets.forEach(({ key, rows, label }) => {
    const card = document.createElement('article'); card.className = 'video-facet';
    const selected = rows.find(r => r.pair === view.focusPair);
    const usable = rows.filter(r => r.points.some(p => p.value != null));
    const latest = selected?.points.filter(p => p.value != null).at(-1);
    card.innerHTML = `<div class="video-facet-head"><h3>${label}</h3><span>${view.layout === 'overlay' || view.sharedY ? '统一刻度' : '独立刻度'}</span></div>
      <div class="video-selected">${selected && latest ? `<strong>${indexed ? latest.value.toFixed(2) + '×' : ['tracking', 'daily'].includes(view.mode) && percent ? latest.value.toFixed(2) + 'pp' : videoNumber(latest.value, view.metric)}</strong><span>${view.mode === 'tracking' ? '追踪后变化 · ' : ''}采于 ${latest.date} · 当时发布 ${latest.age} 天</span>` : `<span>${usable.length}/${rows.length} 支有数据${field.biliOnly && key.startsWith('youtube') ? ' · 平台无此指标' : ''}</span>`}</div>
      <div class="video-chart" style="height:${Math.max(190, view.height)}px"></div>`;
    section.querySelector('.video-facets').append(card);
    const el = card.querySelector('.video-chart');
    if (!usable.length) {
      el.classList.add('video-empty');
      el.textContent = !records.length ? '当前发布日期范围内没有视频' : view.mode === 'age'
        ? `没有首 ${view.compareDays} 天完整采样 · 可切换当前累计或追踪后增量`
        : '所选内容或指标暂无观测';
      return;
    }
    const chart = echarts.init(el); videoCharts.push(chart); viewCharts.push(chart);
    const metricUnit = indexed ? '×' : ['tracking', 'daily'].includes(view.mode) && percent ? 'pp' : field.unit;
    const series = usable.map(r => ({
      type: view.mode === 'snapshot' ? 'scatter' : view.mode === 'daily' ? 'bar' : 'line', name: r.subjectLabel + ' · ' + r.name + ' · ' + VIDEO_SOURCE_LABELS[r.source],
      data: r.points.map(p => ({ value: [['snapshot', 'daily'].includes(view.mode) ? p.x + 'T00:00:00Z' : p.x, p.value], pair: r.pair, record: r, point: p })),
      symbolSize: view.focusPair === r.pair ? 12 : 8, showSymbol: true, connectNulls: false,
      lineStyle: { width: 2, type: r.video.ramp?.available === false ? 'dashed' : 'solid', opacity: view.focusPair && r.pair !== view.focusPair ? .18 : 1 },
      itemStyle: { color: colorFor(r), opacity: view.focusPair && r.pair !== view.focusPair ? .18 : .9 },
      emphasis: { scale: 1.5 },
    }));
    const shared = view.sharedY || view.layout === 'overlay';
    chart.setOption({ animation: false, useUTC: true, aria: { enabled: true, description: `${label}，${field.label}，${view.mode === 'snapshot' ? '横轴为发布日期' : view.mode === 'daily' ? '横轴为采样日期' : '横轴为相对天数'}。详细数据见视频明细。` },
      grid: { left: 52, right: 18, top: 25, bottom: 33 },
      xAxis: ['snapshot', 'daily'].includes(view.mode) ? { type: 'time', min: xDates[0] + 'T00:00:00Z',
        max: (xDates.length === 1 ? addDays(xDates[0], 1) : xDates.at(-1)) + 'T00:00:00Z',
        axisLabel: { formatter: v => new Date(v).toISOString().slice(5, 10), hideOverlap: true }, axisTick: { show: false } }
        : { type: 'value', min: 0, max: view.compareDays > 1 ? view.compareDays - 1 : 1, minInterval: 1,
          axisLabel: { formatter: v => `${view.mode === 'age' ? 'D' : 'T'}${v}`, hideOverlap: true } },
      yAxis: { type: 'value', name: metricUnit, nameTextStyle: { color: '#656d78' }, min: shared ? minValue : (['tracking', 'daily'].includes(view.mode) ? undefined : 0), max: shared ? bound : undefined,
        axisLabel: { fontSize: 11, formatter: v => percent || indexed ? Number(v.toFixed(1)) : v >= 10000 ? Number((v / 10000).toFixed(1)) + '万' : Number(v.toFixed(0)) }, splitLine: { lineStyle: { color: '#e8ebef' } } },
      tooltip: { trigger: 'item', confine: true, formatter: p => {
        const d = p.data, r = d.record, sample = d.point;
        return `<b>${videoEscape(r.name)}</b><br>${videoEscape(VIDEO_SOURCE_LABELS[r.source])}<br>${videoEscape(field.label)}：${sample.value == null ? '缺采' : (percent || indexed ? sample.value.toFixed(2) : fmt(sample.value))} ${metricUnit}<br>发布 ${r.video.pubdate}<br>采样 ${sample.date || '缺采'} · 视频年龄 ${sample.age ?? '—'} 天${indexed ? `<br>实际 ${fmt(sample.rawValue)} 次 · 参考中位数 ${fmt(r.referenceMedian)}` : ''}${r.baseline ? `<br>基线 ${r.baseline.date} · 当时发布 ${r.baseline.age} 天` : ''}`;
      } }, series,
    });
    chart.on('click', p => { if (p.data?.pair) { view.focusPair = view.focusPair === p.data.pair ? '' : p.data.pair; change(); } });
    chart.on('mouseover', p => {
      if (!p.data?.pair) return;
      viewCharts.forEach(other => {
        const options = other.getOption();
        options.series.forEach((s, seriesIndex) => s.data.forEach((d, dataIndex) => {
          if (d.pair === p.data.pair) other.dispatchAction({ type: 'highlight', seriesIndex, dataIndex });
        }));
      });
    });
    chart.on('globalout', () => viewCharts.forEach(other => other.dispatchAction({ type: 'downplay' })));
  });
  const tbody = section.querySelector('tbody');
  prepared.filter(r => !view.focusPair || r.pair === view.focusPair).forEach(r => {
    const last = r.samples.at(-1), first = r.samples[0];
    const url = r.platform === 'bilibili' ? 'https://www.bilibili.com/video/' + encodeURIComponent(r.video.bvid)
      : 'https://www.youtube.com/watch?v=' + encodeURIComponent(r.video.video_id);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><a href="${url}" target="_blank" rel="noopener noreferrer">${videoEscape(r.name)}</a>${!r.video.pair_id ? '<span class="chip">未配对</span>' : ''}</td><td>${VIDEO_SOURCE_LABELS[r.source]}</td><td>${r.video.pubdate}</td><td>${last?.date || '—'}</td><td>${last ? last.age + ' 天' : '—'}</td><td>${videoNumber(last?.value, view.metric)}</td><td>${first ? first.age + ' 天' : '—'}</td><td>${r.reason || (first?.age > 0 ? '缺起跑段' : '已观测')}</td>`;
    tbody.append(tr);
  });
}
