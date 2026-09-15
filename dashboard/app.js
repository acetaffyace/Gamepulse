/* GamePulse dashboard —— UI 接线层
 *
 * 引擎（对比对象、对齐、取数、绘图）在 engine.js。这里只负责
 * 控件、指标卡、表格、导出和引导。
 *
 * 只有一个视图。过去的「单游戏」和「三方对比」是同一件事的两个特例：
 * 对比对象列表长度为 1 就是单游戏。因此轨道自定义、预设、导出、
 * 数据表对两种情形一视同仁，不存在「这个功能只有某个视图才有」。
 */

const STORAGE_KEY = 'gamepulse.view.v3';

let config = null;            // dashboard_config.json
let catalog = [];             // index.json 的 games，即对比对象目录
const snapCache = new Map();  // game_id -> snapshot
let chart = null;

let subjects = [];            // 当前对比对象（长度 1 即单游戏）
let align = 'calendar';       // calendar | day0
let rangeDays = 90;
let laneState = [];           // [{id, height, enabled}]，顺序即显示顺序
let laneData = [];            // 最近一次渲染的轨道数据，供图例/数据表复用

const pct = n => (n === null || n === undefined) ? '—' : n.toFixed(2) + '%';

function color(slot) {
  return (config.palette && config.palette[slot]) || C.muted;
}

const LANG_LABEL = {
  english: 'English', russian: 'Русский', schinese: '简体中文', tchinese: '繁體中文',
  japanese: '日本語', koreana: '한국어', spanish: 'Español', latam: 'Español (LATAM)',
  brazilian: 'Português (BR)', german: 'Deutsch', french: 'Français',
  thai: 'ไทย', vietnamese: 'Tiếng Việt', indonesian: 'Indonesia',
  polish: 'Polski', turkish: 'Türkçe', italian: 'Italiano', ukrainian: 'Українська',
  other: '其他',
};

/* ---------- 快照加载 ---------- */

async function snapshotOf(gameId) {
  if (!snapCache.has(gameId)) {
    const res = await fetch(`../data/snapshot_${gameId}.json`);
    snapCache.set(gameId, await res.json());
  }
  return snapCache.get(gameId);
}

/* 对象本身只有元信息，快照按需挂上去 —— 三份快照合计 1.3MB，
   只有真正被加进对比列表的游戏才值得下载。 */
async function hydrate(list) {
  await Promise.all([...new Set(list.map(s => s.gameId))].map(snapshotOf));
  list.forEach(s => { s.snap = snapCache.get(s.gameId); });
  return list;
}

/* ---------- 视图状态 ---------- */

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
  const on = laneState.filter(l => l.enabled).map(l => `${l.id}.${l.height}`).join(',');
  return `s=${subjects.map(s => s.key).join('|')}&a=${align}&r=${rangeDays}&l=${on}`;
}

function parseView(str) {
  const params = new URLSearchParams(str);
  const out = {};
  if (params.get('s')) out.subjectKeys = params.get('s').split('|').filter(Boolean);
  if (params.get('a')) out.align = params.get('a') === 'day0' ? 'day0' : 'calendar';
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
  if (restored.align) align = restored.align;
  return restored.subjectKeys || null;
}

function persistView() {
  try { localStorage.setItem(STORAGE_KEY, serializeView()); } catch (e) { /* 忽略 */ }
  history.replaceState(null, '', '#' + serializeView());
}

/* ---------- 渲染总入口 ---------- */

function activeLanes() {
  const byId = new Map(config.lanes.map(l => [l.id, l]));
  return laneState
    .filter(s => s.enabled && byId.has(s.id))
    .map(s => ({ ...byId.get(s.id), height: s.height }));
}

function buildCtx() {
  return {
    axis: buildAxis(subjects, align, rangeDays),
    subjects,
    multi: subjects.length > 1,
  };
}

function renderAll() {
  const ctx = buildCtx();
  const lanes = activeLanes();
  const el = document.getElementById('pulse');

  if (!subjects.length) {
    chart.clear();
    el.style.height = '120px';
    document.getElementById('legend').innerHTML =
      '<span class="muted">还没有选择对比对象。用上方的「＋ 添加对象」挑一个游戏或版本。</span>';
    return;
  }
  if (!lanes.length) {
    chart.clear();
    el.style.height = '120px';
    document.getElementById('legend').innerHTML =
      '<span class="muted">没有启用任何轨道。点击右上角「自定义轨道」选择要显示的指标。</span>';
    return;
  }

  laneData = renderPulse(chart, el, lanes, ctx);
  renderLegend(ctx);
  renderPulseNote(ctx);
  renderTiles(ctx);
  renderWindowTable(ctx);
  renderCadenceTable(ctx);
  renderVersionTable(ctx);
  renderLangSection(ctx);
  renderDataTable(ctx);
  renderSources(ctx);
  persistView();
}

function renderPulseNote(ctx) {
  const parts = [];
  parts.push(ctx.axis.align === 'day0'
    ? `横轴是「各自起点后的第 N 天」：游戏从上线日起算，版本从该版本更新日起算。`
    : `轨道共享同一日历日期轴。`);
  if (ctx.axis.align === 'day0' && ctx.multi) {
    parts.push(`窗口长度不齐，已统一截断到最短的 ${ctx.axis.truncatedTo} 天。`);
  }
  parts.push('各轨道单位不同，分别独立计量，不共用纵轴。');
  parts.push(ctx.multi
    ? '颜色代表对比对象；同一游戏的多个版本共用基色、以明度区分。'
    : '颜色在轨道内部区分指标系列。');
  parts.push('轨道由 config/dashboard.yml 定义，可在右上角「自定义轨道」中增删、排序与调整高度。');
  document.getElementById('pulseNote').textContent = parts.join(' ');
}

/* ---------- 对比对象控件 ---------- */

function renderSubjectBar() {
  const chips = document.getElementById('subjectChips');
  chips.innerHTML = subjects.map(s => `
    <span class="subject-chip" data-key="${s.key}" title="${s.sublabel}">
      <span class="mark" style="background:${s.color}"></span>
      <span class="sc-label">${s.label}</span>
      <button class="sc-x" data-remove="${s.key}" title="移除">×</button>
    </span>`).join('') ||
    '<span class="muted" style="font-size:12px">未选择对象</span>';

  chips.querySelectorAll('[data-remove]').forEach(btn => {
    btn.onclick = async () => {
      subjects = subjects.filter(s => s.key !== btn.dataset.remove);
      paintSubjects(subjects.map(s => rebase(s)));
      await refresh();
    };
  });

  const chosen = new Set(subjects.map(s => s.key));
  const sel = document.getElementById('subjectAdd');
  const groups = catalog.map(g => {
    const opts = [`<option value="${g.game_id}" ${chosen.has(g.game_id) ? 'disabled' : ''}>整段 · ${g.short_name}</option>`];
    (g.versions || []).slice().reverse().forEach(v => {
      const key = `${g.game_id}@${v.key}`;
      const tail = v.open_ended ? '进行中' : `${v.days} 天`;
      opts.push(`<option value="${key}" ${chosen.has(key) ? 'disabled' : ''}>${g.short_name} ${v.version_id} · ${v.date_local} · ${tail}</option>`);
    });
    return `<optgroup label="${g.short_name}">${opts.join('')}</optgroup>`;
  }).join('');
  sel.innerHTML = `<option value="">＋ 添加对象</option>${groups}`;
}

/* 移除对象后其余对象要换回自己的基色，否则上一次的明度偏移会留在身上。 */
function rebase(s) {
  const entry = catalog.find(g => g.game_id === s.gameId);
  return entry ? { ...s, color: entry.color } : s;
}

async function refresh() {
  await hydrate(subjects);
  renderSubjectBar();
  renderAll();
}

/* ---------- 图例 ---------- */

function renderLegend(ctx) {
  const el = document.getElementById('legend');
  if (ctx.multi) {
    // 多对象时图例的主体是对象本身，点击可临时隐藏
    el.innerHTML = subjects.map(s => `
      <div class="legend-item" data-subject="${s.key}">
        <span class="mark" style="background:${s.color}"></span>
        <span style="font-weight:500">${s.label}</span>
        <span style="color:${C.muted}">· ${s.sublabel}</span>
      </div>`).join('');
    return;
  }
  el.innerHTML = laneData.map(({ lane, built }) => {
    const marks = built.series.slice(0, 8).map(def => {
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

/* ---------- 窗口统计 ---------- */

function windowStats(subject) {
  const w = subject.window;
  const rows = (subject.snap.review_history || [])
    .filter(r => r.date_local >= w.start && r.date_local <= w.end);
  const reviews = rows.reduce((s, r) => s + (r.new_reviews || 0), 0);
  const positive = rows.reduce((s, r) => s + (r.new_positive || 0), 0);
  // 在线人数只有「现在」这一个观测值，无法回溯。已经结束的版本窗口
  // 拿当前在线来代表，会让两个历史版本显示出同一个数 —— 那不是它们
  // 各自窗口里的在线，只是今天的在线。所以窗口已结束时一律留空。
  const live = subject.kind !== 'version' || subject.openEnded;
  const online = live
    ? (subject.snap.online_series || []).filter(o => o.value != null) : [];
  const versions = (subject.snap.events || []).filter(
    e => e.is_version_boundary && e.date_local >= w.start && e.date_local <= w.end);

  const last7 = rows.slice(-7), prev7 = rows.slice(-14, -7);
  const avg = a => a.length ? a.reduce((s, r) => s + (r.new_reviews || 0), 0) / a.length : null;
  const a7 = avg(last7), p7 = avg(prev7);

  return {
    days: rows.length,
    reviews,
    dailyAvg: rows.length ? reviews / rows.length : null,
    rate: reviews ? positive / reviews * 100 : null,
    cumRate: rows.length ? rows[rows.length - 1].cumulative_review_rate : null,
    totalReviews: rows.length ? rows[rows.length - 1].cumulative_reviews : null,
    online: online.length ? online[online.length - 1].value : null,
    onlinePoints: online.length,
    onlineLive: live,
    versions: versions.length,
    versionList: versions,
    avg7: a7,
    delta7: (a7 != null && p7) ? (a7 - p7) / p7 * 100 : null,
  };
}

const deltaHtml = d => d == null ? ''
  : `<span class="${d >= 0 ? 'good' : 'bad'}">${d >= 0 ? '+' : ''}${d.toFixed(1)}%</span>`;

/* ---------- 指标卡 ---------- */

function renderTiles(ctx) {
  const box = document.getElementById('tiles');

  // 单个游戏对象：保留原来那组更细的指标卡
  if (!ctx.multi && subjects[0].kind === 'game') {
    box.style.gridTemplateColumns = '';
    box.innerHTML = singleGameTiles(subjects[0]);
    return;
  }

  box.style.gridTemplateColumns = `repeat(${Math.min(subjects.length, 4)},1fr)`;
  box.innerHTML = subjects.map(s => {
    const w = windowStats(s);
    const onlineNote = !w.onlineLive ? '窗口已结束 · 在线无法回溯'
      : w.onlinePoints ? `${fmt(w.online)} 在线 · ${w.onlinePoints} 个采集点`
      : '在线尚未采集';
    return `<div class="tile">
      <div class="k"><span class="swatch" style="background:${s.color}"></span>${s.label}</div>
      <div class="v">${w.dailyAvg != null ? w.dailyAvg.toFixed(1) : '—'}<span class="unit">条/日</span></div>
      <div class="n">${deltaHtml(w.delta7)} ${w.delta7 != null ? '近 7 日对比前 7 日' : '窗口内日均新增评测'}</div>
      <div class="n" style="margin-top:2px">窗口好评率 ${pct(w.rate)} · ${fmt(w.reviews)} 条 / ${w.days} 天</div>
      <div class="n" style="margin-top:2px">${onlineNote}</div>
    </div>`;
  }).join('');
}

function singleGameTiles(subject) {
  const snap = subject.snap;
  const w = windowStats(subject);
  const bili = (snap.bilibili || {}).totals || {};
  const bounds = (snap.events || []).filter(e => e.is_version_boundary);
  const current = bounds[bounds.length - 1];
  const profile = (snap.review_profile || {}).daily || [];
  const daysSince = current ? daysBetween(current.date_local, snap.snapshot_date) : null;

  // 中位时长取最近 14 天里有值的那些天，单日样本量太小
  const recent = profile.slice(-14).map(r => r.playtime_at_review_median).filter(v => v != null);
  const medianPlaytime = recent.length
    ? recent.sort((a, b) => a - b)[Math.floor(recent.length / 2)] : null;

  const tiles = [
    { k: 'Steam 同时在线', swatch: color('slot7'),
      v: w.onlinePoints ? fmt(w.online) : '—',
      n: w.onlinePoints ? `${w.onlinePoints} 个采集点 · 历史不可回填` : '尚未采集' },
    { k: '累计好评率', swatch: color('slot3'),
      v: w.cumRate != null ? w.cumRate.toFixed(2) : '—', unit: '%',
      n: w.totalReviews != null ? `${fmt(w.totalReviews)} 条评测` : '—' },
    { k: '近 7 日均新增评测', swatch: color('slot1'),
      v: w.avg7 != null ? w.avg7.toFixed(1) : '—',
      n: w.delta7 != null ? `${deltaHtml(w.delta7)} 对比前 7 日` : '—' },
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

  return tiles.map(t => `
    <div class="tile">
      <div class="k">${t.swatch ? `<span class="swatch" style="background:${t.swatch}"></span>` : ''}${t.k}</div>
      <div class="v">${t.v}${t.unit ? `<span class="unit">${t.unit}</span>` : ''}</div>
      <div class="n">${t.n}</div>
    </div>`).join('');
}

/* ---------- 窗口对照表 ---------- */

function renderWindowTable(ctx) {
  const note = ctx.axis.align === 'day0'
    ? `各对象按自己的起点对齐，统一截断到最短窗口的 ${ctx.axis.truncatedTo} 天。下表统计的是各对象**自己的完整窗口**，不受截断影响。`
    : `下表统计的是各对象自己的完整窗口。窗口之外该游戏可能已在运营，不代表数值为 0。`;
  document.getElementById('cmpWindowNote').textContent = note;

  document.querySelector('#cmpTable tbody').innerHTML = subjects.map(s => {
    const w = windowStats(s);
    return `<tr>
      <td><span class="swatch" style="display:inline-block;width:8px;height:8px;
           border-radius:2px;background:${s.color};margin-right:6px"></span>${s.label}
          <div class="muted" style="font-size:11px">${s.window.start} → ${s.window.end}</div></td>
      <td class="num">${fmt(w.reviews)}</td>
      <td class="num"><b>${w.dailyAvg != null ? w.dailyAvg.toFixed(1) : '—'}</b></td>
      <td class="num">${pct(w.rate)}</td>
      <td class="num">${w.onlinePoints ? fmt(w.online)
        : `<span class="muted" title="${w.onlineLive ? '尚未采集' : '窗口已结束，在线人数无法回溯'}">—</span>`}</td>
      <td class="num">${w.versions}</td>
    </tr>`;
  }).join('');
}

/* ---------- 版本节奏表 ---------- */

function renderCadenceTable(ctx) {
  const games = [...new Set(subjects.map(s => s.gameId))];
  document.querySelector('#cadenceTable tbody').innerHTML = games.map(gid => {
    const entry = catalog.find(g => g.game_id === gid);
    const snap = snapCache.get(gid);
    const bounds = (snap.events || []).filter(e => e.is_version_boundary);
    const recent = bounds.slice(-6);
    let gap = '—';
    if (recent.length >= 2) {
      const days = [];
      for (let i = 1; i < recent.length; i++) {
        days.push(daysBetween(recent[i - 1].date_local, recent[i].date_local));
      }
      gap = Math.round(days.reduce((a, b) => a + b, 0) / days.length) + ' 天';
    }
    const list = recent.length
      ? recent.map(b => `<span class="chip">${b.version_id}</span>`).join(' ')
      : '<span class="muted">无版本记录</span>';
    return `<tr>
      <td><span class="swatch" style="display:inline-block;width:8px;height:8px;
           border-radius:2px;background:${entry.color};margin-right:6px"></span>${entry.short_name}</td>
      <td>${list}</td>
      <td class="num">${gap}</td>
    </tr>`;
  }).join('');
}

/* ---------- 版本前后 7 天对比表（pipeline 算好的结果） ---------- */

function renderVersionTable(ctx) {
  const games = [...new Set(subjects.map(s => s.gameId))];
  // 选了具体版本时只列这些版本，否则列该游戏全部有完整窗口的版本
  const pinned = new Set(subjects.filter(s => s.kind === 'version').map(s => s.versionKey));

  const rows = [];
  let fields = null;
  games.forEach(gid => {
    const entry = catalog.find(g => g.game_id === gid);
    const snap = snapCache.get(gid);
    ((snap.review_profile || {}).version_windows || [])
      .filter(w => w.complete)
      .filter(w => !pinned.size || pinned.has(w.date_local))
      .forEach(w => {
        fields = fields || w.comparisons;
        rows.push({ entry, w, multi: games.length > 1 });
      });
  });

  const tb = document.querySelector('#versionTable tbody');
  const head = document.querySelector('#versionTable thead tr');

  if (!rows.length) {
    head.innerHTML = '<th>版本</th><th>更新日</th>';
    tb.innerHTML = `<tr><td colspan="8" class="muted">所选对象没有具备完整前后 7 天窗口的版本</td></tr>`;
    document.getElementById('versionNote').textContent =
      '版本更新会同时带来新玩家涌入与老玩家回流，评测量变化同时包含两者，不能单独归因于内容质量。';
    return;
  }

  head.innerHTML = `<th>版本</th><th>更新日</th>` +
    fields.map(c => `<th class="num">${c.label}</th>`).join('');

  const cell = c => {
    if (c.before == null || c.after == null) return `<td class="num muted">—</td>`;
    const unit = c.change_kind === 'pp' ? '%' : '';
    const arrow = `<span class="muted">${c.before}${unit} →</span> <b>${c.after}${unit}</b>`;
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

  tb.innerHTML = rows.map(({ entry, w, multi }) => `
    <tr>
      <td>${multi ? `<span class="swatch" style="display:inline-block;width:8px;height:8px;
             border-radius:2px;background:${entry.color};margin-right:6px"></span>` : ''}
          <span class="chip">${w.version_id}</span></td>
      <td class="muted">${w.date_local}</td>
      ${w.comparisons.map(cell).join('')}
    </tr>`).join('');

  const notes = [];
  if (pinned.size) notes.push('已按所选版本筛选。');
  notes.push(`留存类指标不出现在本表：它依赖「今天的累计游玩时长」快照，
    更新日之后的窗口离今天更近、观测时间必然更短，前后差值是窗口差而不是留存差。`);
  notes.push(`版本更新会同时带来新玩家涌入与老玩家回流，评测量变化同时包含两者，
    不能单独归因于内容质量。`);
  document.getElementById('versionNote').textContent = notes.join(' ');
}

/* ---------- 语种 ---------- */

function renderLangSection(ctx) {
  const head = document.querySelector('#langTable thead tr');
  const body = document.querySelector('#langTable tbody');

  if (ctx.multi) {
    // 多对象：行是语种，列是对象，直接看结构差异
    const shares = subjects.map(s => ({ s, share: languageShareFor(s) }));
    const langs = [...new Set(shares.flatMap(x => x.share.languages || []))]
      .filter(l => l !== 'other').slice(0, 10);
    head.innerHTML = `<th>语言</th>` + shares.map(x =>
      `<th class="num"><span class="swatch" style="display:inline-block;width:8px;height:8px;
        border-radius:2px;background:${x.s.color};margin-right:5px"></span>${x.s.label}</th>`).join('');
    body.innerHTML = langs.map(lang => `<tr>
      <td>${LANG_LABEL[lang] || lang}</td>
      ${shares.map(x => {
        const total = x.share.overall_total || 0;
        const v = (x.share.overall || {})[lang];
        return `<td class="num">${(v != null && total) ? (v / total * 100).toFixed(1) + '%' : '—'}</td>`;
      }).join('')}
    </tr>`).join('');
    const windowed = shares.some(x => x.share.windowed);
    document.getElementById('langNote').textContent =
      '各对象窗口内评测的语言构成，按 7 天分桶汇总。' +
      (windowed ? '版本对象只统计落在该版本窗口内的分桶，因此两列是各自的结构，不是同一个全局值。'
                : '不同对象的回填起点不同，占比反映的是各自窗口内的结构，不是同一时间段的对照。');
    return;
  }

  const subject = subjects[0];
  const share = languageShareFor(subject);
  const overall = share.overall || {};
  const total = share.overall_total || 0;
  const rows = Object.entries(overall).sort((a, b) => b[1] - a[1]);
  const max = rows.length ? rows[0][1] : 1;

  // 首尾两桶的占比差：说明玩家来源结构是否在变
  const buckets = share.buckets || [];
  const trend = new Map();
  if (buckets.length >= 2) {
    const first = buckets[0].shares, lastB = buckets[buckets.length - 1].shares;
    Object.keys(overall).forEach(k => {
      if (first[k] != null && lastB[k] != null) trend.set(k, lastB[k] - first[k]);
    });
  }

  head.innerHTML = `<th>语言</th><th class="num">评测数</th><th style="width:40%">占比</th>
                    <th class="num">首尾桶变化</th>`;
  body.innerHTML = rows.map(([k, v]) => {
    const t = trend.get(k);
    const tText = t == null ? '' :
      `<span class="${Math.abs(t) < 0.5 ? 'muted' : (t > 0 ? 'pos' : 'neg')}"
             style="font-size:11px">${t > 0 ? '+' : ''}${t.toFixed(1)}pp</span>`;
    return `<tr>
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
  document.getElementById('langNote').textContent =
    '回填期内全部评测的语言构成，反映 Steam 版本的实际玩家来源。末列为首个 7 天桶与最后一个 7 天桶的占比差；' +
    '想看结构随时间怎么变，在「自定义轨道」里打开「评测语种结构变化」轨道。';
}

/* ---------- 自定义面板 ---------- */

function renderPanel() {
  const byId = new Map(config.lanes.map(l => [l.id, l]));
  const on = laneState.filter(s => s.enabled);
  const off = laneState.filter(s => !s.enabled);

  const rowHtml = (state, idx, list, isOn) => {
    const lane = byId.get(state.id);
    if (!lane) return '';
    const swatch = `<span class="swatch" style="background:${lane.color ? color(lane.color) : C.muted}"></span>`;
    const solo = lane.single_only
      ? `<span class="chip" style="font-size:10px">仅单对象</span>` : '';
    return `
      <div class="lane-row" data-off="${isOn ? 'false' : 'true'}">
        <input type="checkbox" data-toggle="${state.id}" ${isOn ? 'checked' : ''}>
        ${swatch}
        <div class="lane-name">${lane.title} ${solo}<span>${lane.subtitle || ''}</span></div>
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
        const lastOn = laneState.reduce((acc, s, i) => s.enabled ? i : acc, -1);
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
      renderAll();
    };
    slider.onchange = () => persistView();
  });
}

function afterLaneChange() {
  renderPanel();
  renderAll();
  // 手工改过之后就不再对应任何预设
  document.getElementById('presetSelect').value = '';
}

/* ---------- 数据表 ---------- */

function datedColumns(ctx) {
  const cols = [];
  activeLanes().forEach(lane => {
    if (!['series', 'video_delta', 'share_delta'].includes(lane.adapter)) return;
    const built = ADAPTERS[lane.adapter](lane, ctx);
    built.series.forEach(def => {
      if (!def.values) return;
      cols.push({ name: def.name, unit: lane.unit, values: def.values });
    });
  });
  return cols;
}

function renderDataTable(ctx) {
  const cols = datedColumns(ctx);
  const axis = ctx.axis.keys;

  const evByKey = new Map();
  if (!ctx.multi) {
    (subjects[0].snap.events || []).forEach(e => {
      const k = axisKeyOf(e.date_local, subjects[0], ctx.axis.align);
      if (k === null) return;
      const arr = evByKey.get(k) || [];
      if (e.is_version_boundary) arr.push(`★ ${e.version_id} 版本更新`);
      else if (e.type === 'version_preview') arr.push(`${e.version_id} 前瞻`);
      else if (e.type === 'build_update') arr.push(`构建 ${e.buildid}`);
      else if (e.type === 'content') arr.push(e.label);
      evByKey.set(k, arr);
    });
  }

  const label = ctx.axis.align === 'day0' ? '起点后天数' : '日期';
  document.querySelector('#dataTable thead tr').innerHTML =
    `<th>${label}</th>` + cols.map(c => `<th class="num">${c.name}</th>`).join('')
    + `<th>事件</th>`;

  const rows = [];
  for (let i = axis.length - 1; i >= 0; i--) {
    const k = axis[i];
    const cells = cols.map(c => {
      const v = c.values[i];
      return `<td class="num">${v == null ? '—' : tipFmt(c.unit)(v)}</td>`;
    }).join('');
    rows.push(`<tr><td>${ctx.axis.align === 'day0' ? k + ' 天' : k}</td>${cells}
               <td class="muted">${(evByKey.get(k) || []).join('、')}</td></tr>`);
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

const exportSlug = () => subjects.map(s => s.key.replace('@', '_')).join('+') || 'empty';

function exportCsv() {
  const ctx = buildCtx();
  const cols = datedColumns(ctx);
  const header = [ctx.axis.align === 'day0' ? 'day' : 'date', ...cols.map(c => c.name)];
  const lines = [header.map(csvEscape).join(',')];
  ctx.axis.keys.forEach((k, i) => {
    lines.push([k, ...cols.map(c => c.values[i] ?? '')].map(csvEscape).join(','));
  });
  // BOM 让 Excel 正确识别 UTF-8，否则中文列名会乱码
  downloadBlob(`gamepulse_${exportSlug()}.csv`, '﻿' + lines.join('\n'),
               'text/csv;charset=utf-8');
}

function exportVideosCsv() {
  const rows = [];
  subjects.forEach(s => {
    const push = (platform, videos, idKey) => (videos || []).forEach(v => {
      const stats = (v.latest || {}).stats || {};
      const rates = (v.latest || {}).rates || {};
      rows.push({
        subject: s.label, platform, id: v[idKey], title: v.title, pubdate: v.pubdate,
        character: v.character_name, version: v.version_id,
        content_type: v.content_type,
        view: stats.view, like: stats.like, coin: stats.coin,
        favorite: stats.favorite, reply: stats.reply ?? stats.comment,
        danmaku: stats.danmaku, share: stats.share,
        engagement_rate: rates.engagement,
        captured: (v.latest || {}).date_local,
        days_since_pub: (v.latest || {}).days_since_pub,
        ramp_available: (v.ramp || {}).available,
        ramp_first_day: (v.ramp || {}).first_capture_days_since_pub,
      });
    });
    push('bilibili', (s.snap.bilibili || {}).videos, 'bvid');
    push('youtube', (s.snap.youtube || {}).videos, 'video_id');
  });

  if (!rows.length) { alert('所选对象没有登记视频。'); return; }
  const header = Object.keys(rows[0]);
  const lines = [header.join(',')].concat(
    rows.map(r => header.map(h => csvEscape(r[h])).join(',')));
  downloadBlob(`gamepulse_${exportSlug()}_videos.csv`, '﻿' + lines.join('\n'),
               'text/csv;charset=utf-8');
}

function exportPng() {
  const url = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fcfcfb' });
  const a = document.createElement('a');
  a.href = url;
  a.download = `gamepulse_${exportSlug()}.png`;
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

function renderSources(ctx) {
  const snap = subjects[0].snap;
  document.getElementById('sources').innerHTML =
    (snap.sources || []).map(s => `
      <div class="source">
        <span class="tag">${s.label}</span>
        <div class="t">${s.name}</div>
        <div class="d">${s.note}</div>
      </div>`).join('');

  const onlinePts = subjects.map(s =>
    (s.snap.online_series || []).filter(o => o.value != null).length);
  const ramps = subjects.flatMap(s => ((s.snap.bilibili || {}).videos || []));
  const rampReady = ramps.filter(v => (v.ramp || {}).available).length;

  // 版本对象要报它自己那段窗口，不是整个游戏的回填覆盖 ——
  // 否则「鸣潮 3.5」和「鸣潮 3.6」会并排显示同一个 444 天
  const covLines = subjects.map(s => {
    if (s.kind === 'version') {
      return `${s.label} ${s.days} 天（${s.window.start} 起）`;
    }
    const cov = s.snap.review_history_coverage;
    return `${s.label} ${cov ? cov.days + ' 天（' + cov.start + ' 起）' : '—'}`;
  }).join('、');

  document.getElementById('caveat').innerHTML = `
    <b>口径限制</b>
    评测历史由 Steam appreviews 游标翻页回填重建（${covLines}），
    只含<b>今天仍然存在</b>的评测，被删除或隐藏的不会出现，因此越早的日期越可能低估当日真实值。
    玩家结构指标同样基于这批评测，且<b>评测者不是玩家的随机样本</b>。
    Steam 同时在线人数<b>无法回填</b>（SteamDB 不可程序化访问、SteamCharts 未收录该 App），
    目前各对象分别有 ${onlinePts.join(' / ')} 个逐日采集点，需持续积累。
    B 站与 YouTube 接口只返回<b>当前</b>累计值，没有历史曲线：散点轨道画的是
    「发布日 × 当前累计值」，跨发布时间不可比；「发布后播放曲线」只能从开始采集那天往后长，
    ${ramps.length} 支视频中有 ${rampReady} 支覆盖了完整起跑段，其余用虚线标出缺口。
    跨视频比较请优先看互动率 —— 播放量受推荐位影响极大，互动率不受。
    ${ctx.multi ? '不同对象的窗口长度与回填起点不同，绝对量不可直接相比，日均与比率才可比。' : ''}
    版本更新竖线取自 Steam 官方公告，构建号事件来自 SteamCMD 第三方镜像，仅作旁证。
    所有事件仅表示时间节点，<b>不自动表示因果关系</b>。`;
}

/* ---------- 引导 ---------- */

function pressOnly(selector, btn) {
  document.querySelectorAll(selector).forEach(b => b.setAttribute('aria-pressed', 'false'));
  btn.setAttribute('aria-pressed', 'true');
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
  catalog = (idx && idx.games) || [];
  if (!catalog.length) {
    loading.textContent = '没有可用快照。请先运行 python pipeline/build_snapshot.py';
    return;
  }

  const wantedKeys = restoreView();
  const keys = (wantedKeys && wantedKeys.length) ? wantedKeys : [catalog[0].game_id];
  subjects = paintSubjects(keys.map(k => subjectFromKey(catalog, k)).filter(Boolean));
  if (!subjects.length) subjects = [makeGameSubject(catalog[0])];

  document.getElementById('metaDate').textContent = idx.generated_at;
  document.getElementById('metaBadges').innerHTML =
    `<span class="badge live"><span class="dot"></span>逐日采集 observed</span>
     <span class="badge recon" style="margin-left:6px"><span class="dot"></span>评测历史 reconstructed</span>`;

  // 添加对比对象
  const addSel = document.getElementById('subjectAdd');
  addSel.onchange = async () => {
    const key = addSel.value;
    addSel.value = '';
    if (!key || subjects.some(s => s.key === key)) return;
    const s = subjectFromKey(catalog, key);
    if (!s) return;
    subjects = paintSubjects(subjects.map(rebase).concat(s));
    // 加入版本对象时自动切到起点对齐 —— 按日历排开的两个版本窗口不重叠，
    // 并排画出来只会各占横轴的一段，没有可比性
    if (s.kind === 'version' && align === 'calendar' && subjects.length > 1) {
      align = 'day0';
      document.querySelectorAll('#alignSeg button').forEach(b =>
        b.setAttribute('aria-pressed', String(b.dataset.align === 'day0')));
    }
    await refresh();
  };

  const presetSel = document.getElementById('presetSelect');
  presetSel.innerHTML = `<option value="">自定义</option>` +
    Object.entries(config.presets || {}).map(([k, p]) =>
      `<option value="${k}">${p.label}</option>`).join('');
  presetSel.onchange = () => {
    if (!presetSel.value) return;
    applyPreset(presetSel.value);
    renderPanel(); renderAll();
  };

  document.querySelectorAll('#rangeSeg button').forEach(btn => {
    btn.setAttribute('aria-pressed', String(Number(btn.dataset.days) === rangeDays));
    btn.onclick = () => {
      pressOnly('#rangeSeg button', btn);
      rangeDays = Number(btn.dataset.days);
      renderAll();
    };
  });

  document.querySelectorAll('#alignSeg button').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.align === align));
    btn.onclick = () => {
      pressOnly('#alignSeg button', btn);
      align = btn.dataset.align;
      renderAll();
    };
  });

  // 自定义面板
  const panel = document.getElementById('lanePanel');
  const scrim = document.getElementById('panelScrim');
  const closePanel = () => {
    panel.classList.remove('open'); scrim.classList.remove('open');
    chart.resize();
  };
  document.getElementById('openPanel').onclick = () => {
    panel.classList.add('open'); scrim.classList.add('open');
  };
  document.getElementById('closePanel').onclick = closePanel;
  scrim.onclick = closePanel;
  document.getElementById('resetLanes').onclick = () => {
    laneState = defaultLaneState();
    presetSel.value = '';
    renderPanel(); renderAll();
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

  await hydrate(subjects);
  renderSubjectBar();
  renderPanel();
  renderAll();

  loading.classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  chart.resize();
}

boot();
