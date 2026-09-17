/* GamePulse 引擎层 —— 对比对象模型、对齐、取数适配器、综合图渲染
 *
 * 这一层不碰 DOM 控件，只负责「把 N 个对比对象画到同一组轨道上」。
 * UI 接线在 app.js。
 *
 * 核心抽象是**对比对象（subject）**，而不是「游戏」：
 *
 *   {key, kind:'game'|'version', gameId, label, color, day0, window:{start,end}}
 *
 * 一个游戏是一个对象，一个版本窗口也是一个对象。于是
 *   单个游戏      = 1 个 game 对象
 *   多游戏对照    = N 个 game 对象
 *   同游戏版本对照 = 同一 gameId 的 N 个 version 对象
 *   跨游戏版本对照 = 不同 gameId 的 N 个 version 对象
 * 全都是同一条渲染路径，不需要第二套视图代码。
 *
 * 对齐有两种：
 *   calendar  横轴是日历日期，看同期表现
 *   day0      横轴是「自己起点后的第 N 天」—— 游戏的起点是上线日，
 *             版本的起点是该版本更新日。这样「3.1 的第 7 天」和
 *             「3.2 的第 7 天」才是同一件事。
 *             窗口长度不齐时统一截断到最短的那个，否则长的那条会在
 *             短的那条结束后继续延伸，看上去像是它表现更持久。
 */

const FONT = 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';

/* 与 index.html 的 CSS 变量一一对应。muted 从 #898781 提到 #6f6d68 是
   对比度修正（3.50:1 → 5.10:1，WCAG AA 正文需 4.5:1）——
   轨道标题的副标题、坐标轴刻度、提示框次要文字都走这个色。 */
const C = {
  gridline:  '#e1e0d9',
  baseline:  '#c3c2b7',
  marker:    '#9a978c',   // 版本更新竖线：承载信息，不能和网格线一样淡
  muted:     '#6f6d68',
  secondary: '#52514e',
  primary:   '#0b0b0b',
  surface:   '#fcfcfb',
  warning:   '#8a6300',   // 「数据积累中」状态文字，对浅底 ≥4.5:1
};

const fmt = n => (n === null || n === undefined) ? '—' : n.toLocaleString('zh-CN');

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
   「0.0h / 8.3h / 17h / 25h」这种刻度 —— 因为分档是按分钟算的。 */
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
  pp: v => v == null ? '' : (v > 0 ? '+' : '') + v + 'pp',
  minutes_as_hours: v => v == null ? '' : v + 'h',
  /* 相对本语区中位数的倍数。对数轴的刻度是 0.01 / 0.1 / 1 / 10 / 100，
     小于 1 的那几档必须按量级给小数位 —— 一律 toFixed(1) 会把
     0.01 显示成「0.0×」，正好是对数轴最不该出现的那个数字。 */
  ratio: v => {
    if (v == null) return '';
    if (v >= 1) return Math.round(v) + '×';
    if (v >= 0.1) return v.toFixed(1) + '×';
    return v.toFixed(2) + '×';
  },
};

const TOOLTIP_UNITS = {
  count: v => fmt(v),
  percent: v => v == null ? '—' : v.toFixed(2) + '%',
  pp: v => v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + 'pp',
  minutes_as_hours: v => v == null ? '—' : v.toFixed(1) + ' 小时',
  ratio: v => v == null ? '—' : v.toFixed(2) + '× 本语区中位数',
};

const unitFmt = u => UNITS[u] || UNITS.count;
const tipFmt = u => TOOLTIP_UNITS[u] || TOOLTIP_UNITS.count;
const scaleOf = u => SCALES[u] || (v => v);

/* ---------- 颜色 ---------- */

/* 颜色代表**对比对象**这个身份。同一个游戏的多个版本共享基色，
   靠明度拉开 —— 这样「蓝色是鸣潮」这条规则不会被版本对比破坏。
   只有当整屏只有一个对象时，颜色才退回去区分轨道内的指标系列。 */
function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(c => {
    const t = amount < 0 ? 0 : 255;
    return Math.round(c + (t - c) * Math.abs(amount));
  });
  return '#' + ch.map(c => c.toString(16).padStart(2, '0')).join('');
}

/* 同游戏多版本时的明度分布。首尾留白避免过黑/过白，
   只有一个版本时不加明度偏移，保持与该游戏的基色一致。 */
function shadeFor(index, total) {
  if (total <= 1) return 0;
  return -0.3 + (0.66 * index) / (total - 1);
}

/* ---------- 语区 ----------
 *
 * 语区身份用**形状**承载，颜色只是辅助。两个理由：
 *   一是本页调色板里 aqua 与 magenta 对浅底低于 3:1，CSS 顶部那条
 *     relief 规则要求颜色不能是唯一线索；
 *   二是多对象时颜色已经被「对比对象」占用了，形状是唯一还空着的通道。
 * 四个符号刻意挑了轮廓差异大的（圆 / 三角 / 方 / 菱形），
 * 在 9px 的散点尺寸下也能分得开。
 */
const LOCALE_LABEL = {
  global: '全球', ja: '日语', ko: '韩语', 'zh-tw': '繁中', 'zh-cn': '简中',
};
const LOCALE_SYMBOL = {
  global: 'circle', ja: 'triangle', ko: 'rect', 'zh-tw': 'diamond',
  'zh-cn': 'pin',
};
const LOCALE_SLOT = {
  global: 'slot1', ja: 'slot2', ko: 'slot3', 'zh-tw': 'slot5', 'zh-cn': 'slot7',
};
const localeLabel = code => LOCALE_LABEL[code] || code;

/* ---------- 对比对象 ---------- */

/* catalog 来自 data/index.json，带每个游戏的配色与版本窗口目录。 */
function makeGameSubject(entry) {
  return {
    key: entry.game_id,
    kind: 'game',
    gameId: entry.game_id,
    label: entry.short_name || entry.display_name,
    sublabel: [entry.developer, `上线 ${entry.review_start || '—'}`]
      .filter(Boolean).join(' · '),
    color: entry.color,
    day0: entry.review_start,
    window: { start: entry.review_start, end: entry.snapshot_date },
    days: entry.review_days || 0,
    originLabel: '上线',
  };
}

function makeVersionSubject(entry, version) {
  return {
    key: `${entry.game_id}@${version.key}`,
    kind: 'version',
    gameId: entry.game_id,
    versionId: version.version_id,
    versionKey: version.key,
    label: `${entry.short_name || entry.display_name} ${version.version_id}`,
    sublabel: `${version.date_local} → ${version.open_ended ? '至今' : version.end_local}` +
              ` · ${version.days} 天${version.open_ended ? '（仍在进行）' : ''}`,
    color: entry.color,
    day0: version.date_local,
    window: { start: version.date_local, end: version.end_local },
    days: version.days,
    openEnded: !!version.open_ended,
    originLabel: '更新',
  };
}

/* 解析 subject key（'wuthering_waves' 或 'wuthering_waves@2026-08-20'） */
function subjectFromKey(catalog, key) {
  const [gameId, versionKey] = key.split('@');
  const entry = catalog.find(g => g.game_id === gameId);
  if (!entry) return null;
  if (!versionKey) return makeGameSubject(entry);
  const version = (entry.versions || []).find(v => v.key === versionKey);
  return version ? makeVersionSubject(entry, version) : null;
}

/* 同游戏的多个版本按时间顺序取明度，颜色才与版本先后一致。 */
function paintSubjects(subjects) {
  const byGame = new Map();
  subjects.forEach(s => {
    if (s.kind !== 'version') return;
    const list = byGame.get(s.gameId) || [];
    list.push(s);
    byGame.set(s.gameId, list);
  });
  byGame.forEach(list => {
    list.sort((a, b) => a.day0 < b.day0 ? -1 : 1);
    list.forEach((s, i) => { s.color = shade(s.color, shadeFor(i, list.length)); });
  });
  return subjects;
}

/* ---------- 对齐与横轴 ---------- */

/* 某个日期在该对象的横轴上对应哪个 key；不在窗口内返回 null。
   窗口过滤在两种对齐下都生效 —— 一个版本对象就是「那一段」，
   在日历模式下也不该把它画到窗口之外。 */
function axisKeyOf(dateIso, subject, align) {
  if (!dateIso) return null;
  const w = subject.window;
  if (w.start && dateIso < w.start) return null;
  if (w.end && dateIso > w.end) return null;
  return align === 'day0' ? String(daysBetween(subject.day0, dateIso)) : dateIso;
}

function buildAxis(subjects, align, rangeDays, videoLanes = []) {
  if (!subjects.length) return { keys: [], align };
  // 只有启用按发布日期定位的轨道时，版本视频才会把横轴向更新日前扩展。
  // 每条轨道按自己的来源和内容类型筛选，避免无关平台的视频留下空白区间。
  const previews = subjects.flatMap(s => prereleaseVideoDates(s, videoLanes));

  if (align === 'day0') {
    // 截断到最短的那个窗口：长窗口在短窗口结束后继续延伸，
    // 会被读成「它更持久」，其实只是它有更多天的数据。
    const span = Math.min(...subjects.map(s => s.days || 0));
    const capped = rangeDays ? Math.min(span, rangeDays) : span;
    const firstDay = previews.length
      ? Math.min(0, ...previews.map(p => daysBetween(p.subject.day0, p.date))) : 0;
    const keys = [];
    for (let d = firstDay; d < Math.max(capped, 1); d++) keys.push(String(d));
    return { keys, align, truncatedTo: span };
  }

  const starts = subjects.map(s => s.window.start).filter(Boolean)
    .concat(previews.map(p => p.date));
  const ends = subjects.map(s => s.window.end).filter(Boolean);
  if (!starts.length || !ends.length) return { keys: [], align };
  const all = dateRange(starts.reduce((a, b) => a < b ? a : b),
                        ends.reduce((a, b) => a > b ? a : b));
  const from = rangeDays ? Math.max(0, all.length - rangeDays) : 0;
  // 保留被选中视频轨道实际使用的更新前日期；rangeDays 仍限定更新后的常规区间。
  const firstPreview = previews.length
    ? all.indexOf(previews.map(p => p.date).sort()[0]) : -1;
  const start = firstPreview >= 0 ? Math.min(from, firstPreview) : from;
  return { keys: all.slice(start), align };
}

const axisLabelOf = (key, align) => align === 'day0' ? `${key} 天` : key.slice(5);

/* 版本对象通常从更新日开始显示普通指标。若视频轨道把横轴扩展到了
   更新日前，则把该游戏已有的历史序列映射到同一批负天数；超出横轴的
   早期历史仍不显示。版本滚动累计线单独使用 axisKeyOf，继续从第 0 天起算。 */
function dataAxisKeyOf(dateIso, subject, ctx) {
  const key = axisKeyOf(dateIso, subject, ctx.axis.align);
  if (key !== null) return key;
  if (subject.kind !== 'version' || !ctx.includesVideoLanes || !dateIso ||
      !subject.window.start || dateIso >= subject.window.start ||
      (subject.window.end && dateIso > subject.window.end)) return null;
  const preUpdateKey = ctx.axis.align === 'day0'
    ? String(daysBetween(subject.day0, dateIso)) : dateIso;
  return ctx.axis.keys.includes(preUpdateKey) ? preUpdateKey : null;
}

/* 已人工确认属于某版本的视频通常早于正式更新日发布。把这些预告保留在
   版本图上，横轴从实际发布日期显示。 */
function prereleaseVideoDates(subject, lanes = []) {
  if (subject.kind !== 'version') return [];
  return lanes.flatMap(lane => {
    const source = resolve(subject.snap, lane.path);
    const videos = Array.isArray(source) ? source
      : source && typeof source === 'object'
        ? Object.values(source).flatMap(locale => locale.videos || [])
        : [];
    return videos.filter(v =>
      (!Array.isArray(lane.content_types) || lane.content_types.includes(v.content_type)) &&
      v.version_confirmed && v.version_id === subject.versionId &&
      v.pubdate && v.pubdate < subject.window.start
    ).map(v => ({ subject, date: v.pubdate }));
  });
}

function videoAxisKeyOf(video, subject, align) {
  const confirmedPreview = subject.kind === 'version' &&
    video.version_confirmed && video.version_id === subject.versionId &&
    video.pubdate && video.pubdate < subject.window.start &&
    (!subject.window.end || video.pubdate <= subject.window.end);
  if (!confirmedPreview) return axisKeyOf(video.pubdate, subject, align);
  return align === 'day0'
    ? String(daysBetween(subject.day0, video.pubdate))
    : video.pubdate;
}

/* ---------- 取数适配器 ----------
 *
 * 每个 adapter 接收 (lane, ctx)，返回 {series, empty, note}。
 * ctx = {axis:{keys,align}, subjects:[{...subject, snap}], multi}
 * series 里每项描述一条可绘制的线/柱/点，绘制细节交给 buildLaneSeries。
 *
 * 新增 adapter 需要在 pipeline/build_dashboard_config.py 的 ADAPTER_SHAPES
 * 同步登记，否则配置校验会拒绝使用它。
 */

/* 多对象时每条轨道只画一条线/对象，否则 N 个对象 × M 个子系列会糊成一片。
   画哪一条由 lane.compare_field 指定，没指定就取第一条。 */
function seriesDefsFor(lane, multi) {
  const defs = lane.series || [{
    field: lane.field, name: lane.title, color: lane.color, width: 2,
  }];
  if (!multi) return defs;
  const picked = lane.compare_field
    ? defs.find(d => d.field === lane.compare_field)
    : null;
  return [picked || defs[0]];
}

/* 对象名 + 系列名。单对象时不必重复对象名，多对象时必须带上。 */
function seriesName(subject, def, lane, multi) {
  if (!multi) return def.name || lane.title;
  const suffix = (lane.series || []).length > 1 ? ` · ${def.name}` : '';
  return subject.label + suffix;
}

/* 哪些视频属于这个对比对象。
 *
 * 游戏对象取该游戏全部登记视频。版本对象要挑出「属于这个版本」的那些，
 * 而这件事不能靠发布日机械归类 —— 角色 PV 通常在版本更新日之前
 * 5-12 天发布，按日期归类会把它算进上一个版本。
 * 所以分两种情况：
 *   标题自带版本号、登记表已确认的（version_confirmed），按版本号归属，
 *   这是官方声明的事实，不是推断；
 *   其余视频按发布日落在该版本窗口内归属，并且只在没有任何确认归属的
 *   视频时才这么做 —— 否则一个版本会同时收到「确认属于它的」和
 *   「碰巧发布在它窗口里的」两批，口径就混了。
 */
function videosForSubject(subject, lane) {
  return filterVideos(resolve(subject.snap, lane.path) || [], subject, lane);
}

/* 同样的归属规则，但直接吃一个视频数组 —— 语区轨道的视频挂在
   youtube.locales.<code>.videos 下，取数路径不是一条固定的 lane.path。 */
function filterVideos(list, subject, lane) {
  let videos = (list || [])
    .filter(v => !lane.content_types || lane.content_types.includes(v.content_type));

  if (subject.kind !== 'version') return videos;

  const confirmed = videos.filter(
    v => v.version_confirmed && v.version_id === subject.versionId);
  if (confirmed.length) return confirmed;

  // 兜底时必须先排除「已确认属于别的版本」的视频。版本 PV 通常在更新日
  // 之前十来天发布，落在上一个版本的窗口里 —— 3.6 版本 PV 出现在 3.5
  // 名下是纯粹的错误，哪怕日期确实落在那一段。
  const w = subject.window;
  return videos.filter(v =>
    !(v.version_confirmed && v.version_id && v.version_id !== subject.versionId) &&
    v.pubdate && v.pubdate >= w.start && v.pubdate <= w.end);
}

/* 语种构成必须按**对象自己的窗口**重算。
   游戏对象继续使用自然 7 日桶；版本对象使用 pipeline 按版本更新日
   重新起算的相对周（第 1 周 = 更新日到第 7 天）。不能从自然周桶里
   挑重叠桶，否则版本边界会把相邻版本的评测整桶带进来。 */
function languageShareFor(subject) {
  const profile = subject.snap.review_profile || {};
  const share = profile.language_share || {};
  if (subject.kind !== 'version') return share;

  const w = subject.window;
  const versionShare = (profile.version_language_share || [])
    .find(v => v.date_local === w.start);
  if (versionShare) {
    return { ...versionShare, windowed: true, relative: true };
  }

  // 旧快照没有相对周数据时宁可显示为空，也不要退回旧的整桶重叠算法。
  if (!(profile.daily || []).length) {
    return { languages: share.languages || [], overall: {}, overall_total: 0,
             buckets: [], windowed: true };
  }
  return { languages: share.languages || [], overall: {}, overall_total: 0,
           buckets: [], windowed: true };
}

function alignRows(rows, subject, ctx) {
  const by = new Map();
  (rows || []).forEach(r => {
    const k = dataAxisKeyOf(r.date_local, subject, ctx);
    if (k !== null) by.set(k, r);
  });
  return by;
}

const ADAPTERS = {
  /* 按日期对齐的普通序列。lane.series 可声明多条共用纵轴的线。 */
  series(lane, ctx) {
    const scale = scaleOf(lane.unit);
    const defs = seriesDefsFor(lane, ctx.multi);
    const out = [];
    let any = false;

    ctx.subjects.forEach(subject => {
      const rows = resolve(subject.snap, lane.path) || [];
      if (rows.length) any = true;
      const versionProfile = lane.id === 'review_rate' && subject.kind === 'version'
        ? ((subject.snap.review_profile || {}).version_cumulative_review_rate || [])
            .find(v => v.date_local === subject.window.start)
        : null;
      const versionBy = new Map((versionProfile && versionProfile.series || [])
        .map(r => [axisKeyOf(r.date_local, subject, ctx.axis.align), r]));
      const by = alignRows(rows, subject, ctx);
      defs.forEach(def => {
        const isGlobalCumulative = lane.id === 'review_rate' &&
          subject.kind === 'version' && def.field === 'cumulative_review_rate';
        const name = isGlobalCumulative ? '全局累计好评率' : def.name;
        const values = ctx.axis.keys.map(k => {
          const r = by.get(k);
          const v = r ? r[def.field] : null;
          return (v === undefined) ? null : scale(v);
        });
        if (values.some(v => v != null)) any = true;
        out.push({
          name: ctx.multi ? `${subject.label} · ${name}` : name,
          subject,
          kind: lane.chart === 'bar' ? 'bar' : 'line',
          color: ctx.multi ? subject.color : color(def.color || lane.color),
          width: def.width, opacity: def.opacity, smooth: def.smooth,
          dashed: def.dashed, endLabel: def.end_label && !ctx.multi ? true : def.end_label,
          symbol: lane.symbol,
          values,
        });
      });

      // 版本对象额外增加一条从版本第一天重新起算的滚动累计线；
      // 全局累计线保留，便于看出版本自身口碑与游戏整体存量口碑的差异。
      if (lane.id === 'review_rate' && subject.kind === 'version') {
        const values = ctx.axis.keys.map(k => {
          const r = versionBy.get(k);
          return r ? scale(r.value) : null;
        });
        if (values.some(v => v != null)) any = true;
        out.push({
          name: ctx.multi ? `${subject.label} · 版本滚动累计好评率`
                          : '版本滚动累计好评率',
          subject, kind: 'line', color: ctx.multi ? subject.color : color('slot5'),
          width: 2.8, smooth: true, endLabel: !ctx.multi, values,
        });
      }
    });
    return { series: out, empty: !any };
  },

  /* 视频散点：x = 发布日（或发布时该对象的第几天），y = 当前累计值或互动率。
     纵轴是「当前累计值」而不是当日值 —— 接口只返回当前累计，没有历史。
     lane.content_types 可把散点限定到同一类内容，跨类比播放量没有意义。 */
  video_scatter(lane, ctx) {
    const bag = lane.from_rates ? 'rates' : 'stats';
    const out = [];
    let any = false;

    ctx.subjects.forEach(subject => {
      const videos = videosForSubject(subject, lane);
      if (videos.length) any = true;
      const keys = new Set(ctx.axis.keys);
      const points = videos.map(v => {
        const k = videoAxisKeyOf(v, subject, ctx.axis.align);
        if (k === null || !keys.has(k)) return null;
        const value = ((v.latest || {})[bag] || {})[lane.field];
        return value == null ? null : { key: k, value, meta: { ...v, subject } };
      }).filter(Boolean);
      out.push({
        name: ctx.multi ? subject.label : lane.title,
        subject, kind: 'scatter',
        color: ctx.multi ? subject.color : color(lane.color),
        points,
      });
    });
    return { series: out, empty: !any };
  },

  /* 单个视频一条增长曲线：x = 发布后第 N 天，y = 累计播放。
     这是唯一一种跨视频公平的播放量对比 —— 拿「当前累计」比，
     等于拿上线一年的游戏和上线一周的游戏比总流水。
     接口不返回历史，曲线只能从开始采集那天往后长，因此
     ramp.available=false 的视频用虚线画，并在图例里标出缺口。 */
  /* 这条轨道走**自己的横轴**：x 是「该视频发布后第 N 天」，用的是视频自己的
     时钟，和对象的日历/起点轴不是一回事。版本 PV 常在版本更新日之前十来天
     发布，硬套对象的轴会整条画到窗口之外。ECharts 本来就是每条轨道一个
     x 轴，这里只是不再给它喂共享的那份 data —— 代价是它不参与十字准线联动，
     轨道标题会写明这一点。 */
  video_ramp(lane, ctx) {
    const picked = [];
    let partial = 0, maxDay = 0;

    ctx.subjects.forEach(subject => {
      videosForSubject(subject, lane)
        .filter(v => (v.ramp || {}).points && v.ramp.points.length)
        .forEach(v => {
          picked.push({ subject, v });
          if (!v.ramp.available) partial++;
          v.ramp.points.forEach(p => { if (p.day > maxDay) maxDay = p.day; });
        });
    });

    if (!picked.length) return { series: [], empty: true };

    const axisKeys = [];
    for (let d = 0; d <= maxDay; d++) axisKeys.push(String(d));

    // 同一对象下的多个视频靠明度区分，仍保持该对象的基色
    const seenPerSubject = new Map();
    const countPerSubject = new Map();
    picked.forEach(({ subject }) =>
      countPerSubject.set(subject.key, (countPerSubject.get(subject.key) || 0) + 1));

    const series = picked.map(({ subject, v }) => {
      const i = seenPerSubject.get(subject.key) || 0;
      seenPerSubject.set(subject.key, i + 1);
      const by = new Map(v.ramp.points.map(p => [String(p.day), p[lane.field] ?? p.view]));
      return {
        name: `${ctx.multi ? subject.label + ' · ' : ''}${compactVideoLabel(v, subject)}`,
        subject, kind: 'line',
        color: shade(subject.color, shadeFor(i, countPerSubject.get(subject.key))),
        width: 1.8,
        dashed: !v.ramp.available,
        symbol: true,
        meta: v,
        values: axisKeys.map(k => by.has(k) ? by.get(k) : null),
      };
    });

    const note = `${picked.length} 支视频 · 横轴为各自发布后天数（独立于上方轨道）` +
      (partial ? ` · ${partial} 支缺起跑段，画为虚线` : '');
    return { series, empty: false, note, axisKeys, axisUnit: 'day' };
  },

  /* 多语区同图对照。
   *
   * 四个语区原本是四条并排的独立轨道，理由写在 dashboard.yml 里：
   * 播放量跨语区不可直接比大小，频道订阅体量差一个数量级
   * （global 186 万 vs NTE 韩语 3.3 万），量差主要来自盘子大小。
   * 那个理由在**线性共享纵轴**下完全成立 —— 实测各语区播放中位数
   * global 118k / ja 58k / ko 39k / zh-tw 17k，最大值 6.07M，跨近三个
   * 数量级，硬叠在一起繁中区会被压成贴底的一条直线。
   *
   * 放进一张图要成立，得换三样东西：
   *
   * 1. **对数纵轴**。读的不再是「谁的柱子高」，而是垂直距离 = 倍数关系。
   *    语区之间那段恒定的垂直位移就是体量差本身，看见它之后，
   *    真正有意义的问题变成「某支视频偏离本语区常态多少」。
   * 2. **相对本语区中位数的标尺**（scale=index）。把每个点除以该语区
   *    自己的中位数，体量差被除掉，跨语区比较这才真正合法 ——
   *    「这支 PV 在日语区跑到常态的 8 倍、在全球区只有 3 倍」是可说的。
   * 3. **形状 + 颜色双编码**。四个语区各有固定符号，不靠颜色单独承载
   *    语区身份（本页调色板里 aqua/magenta 对比度低于 3:1，
   *    CSS 顶部那条 relief 规则要求颜色不能是唯一线索）。
   *
   * 多对象时颜色改由对象承担、形状仍归语区，于是
   * 「蓝色是鸣潮、三角是日语区」两条规则可以同时读。
   */
  locale_scatter(lane, ctx) {
    const bag = lane.from_rates ? 'rates' : 'stats';
    const wanted = lane.locales;
    const indexed = lane.scale === 'index';
    const out = [];
    let any = false;

    ctx.subjects.forEach(subject => {
      const root = resolve(subject.snap, lane.path) || {};
      const order = (wanted && wanted.length)
        ? wanted
        : (resolve(subject.snap, lane.order_path) || Object.keys(root));

      order.forEach(code => {
        const node = root[code];
        if (!node) return;
        const videos = filterVideos(node.videos, subject, lane);
        const keys = new Set(ctx.axis.keys);

        // 基线必须用**该语区该对象的全部视频**算，不能只用落在当前
        // 时间范围内的那些 —— 否则切一下「最近 30 天」，基线跟着变，
        // 同一支视频的倍数会莫名其妙地跳。
        const all = (node.videos || [])
          .map(v => ((v.latest || {})[bag] || {})[lane.field])
          .filter(v => v != null && v > 0)
          .sort((a, b) => a - b);
        const median = all.length
          ? all[Math.floor(all.length / 2)] : null;

        const points = videos.map(v => {
          const k = videoAxisKeyOf(v, subject, ctx.axis.align);
          if (k === null || !keys.has(k)) return null;
          const raw = ((v.latest || {})[bag] || {})[lane.field];
          // 对数轴不接受 0 与负数；这类点是「没采到」而不是「值为 0」
          if (raw == null || raw <= 0) return null;
          if (indexed && !median) return null;
          return { key: k, value: indexed ? raw / median : raw, raw, median,
                   meta: { ...v, subject, locale: code } };
        }).filter(Boolean);

        if (points.length) any = true;
        out.push({
          name: ctx.multi ? `${subject.label} · ${localeLabel(code)}`
                          : localeLabel(code),
          subject, locale: code, kind: 'scatter',
          color: ctx.multi ? subject.color : color(LOCALE_SLOT[code] || 'slot1'),
          symbol: LOCALE_SYMBOL[code] || 'circle',
          median, points,
        });
      });
    });

    const shown = out.filter(s => s.points.length).length;
    // 相对标尺下 1× 是一条对所有语区都成立的共同基线，值得画出来；
    // 绝对标尺下没有这样一条线（各语区的常态本来就不在一个高度）。
    const baseline = indexed ? 1 : null;
    // 对数轴只在「跨数量级」时才是对的。播放量跨三个数量级，要对数；
    // 互动率本来就是 1%~20% 的截面比值，套上对数只会把它压扁 ——
    // 所以绝对标尺是否取对数由 lane.log 决定，相对标尺则一律取对数
    // （倍数是乘性的，0.5× 与 2× 只有在对数轴上才关于 1× 对称）。
    const logScale = indexed || !!lane.log;
    const axisNote = logScale ? '对数纵轴' : '线性纵轴';
    const note = indexed
      ? `${shown} 个语区 · 各自除以本语区中位数 · ${axisNote} · 1× 为该语区常态`
      : `${shown} 个语区 · ${axisNote}` +
        (logScale ? ' · 语区间的垂直落差＝频道体量差' : ' · 截面比值，可直接比大小');
    return { series: out, empty: !any, logScale, baseline, note,
             valueUnit: indexed ? 'ratio' : lane.unit };
  },

  /* 全部登记视频的播放量日增量合计。跨天的增量记在结束日，
     因此 span_days > 1 的点标记出来，不假装是单日增量。 */
  video_delta(lane, ctx) {
    const out = [];
    let any = false;

    ctx.subjects.forEach(subject => {
      const videos = videosForSubject(subject, lane);
      const sums = new Map(), spans = new Map();
      videos.forEach(v => (v.points || []).forEach(p => {
        const d = (p.deltas || {})[lane.field];
        if (d == null) return;
        const k = videoAxisKeyOf({ ...v, pubdate: p.date_local }, subject, ctx.axis.align);
        if (k === null) return;
        sums.set(k, (sums.get(k) || 0) + d);
        if ((p.span_days || 1) > 1) spans.set(k, p.span_days);
      }));
      if (sums.size) any = true;
      out.push({
        name: ctx.multi ? subject.label : lane.title,
        subject, kind: 'bar',
        color: ctx.multi ? subject.color : color(lane.color),
        values: ctx.axis.keys.map(k => sums.has(k) ? sums.get(k) : null),
        spans,
      });
    });
    return { series: out, empty: !any };
  },

  /* 版本节奏：每个对象一行，标出落在窗口内的版本更新日。
     多对象对照时，版本竖线画在这条轨道里而不是贯穿全图 ——
     三款游戏各自的版本线叠在一起会让人误以为是同一个事件。 */
  version_marks(lane, ctx) {
    const out = [];
    let any = false;
    const keys = new Set(ctx.axis.keys);

    ctx.subjects.forEach(subject => {
      const bounds = (subject.snap.events || []).filter(e => e.is_version_boundary);
      const points = bounds.map(b => {
        const k = axisKeyOf(b.date_local, subject, ctx.axis.align);
        if (k === null || !keys.has(k)) return null;
        return { key: k, value: subject.label,
                 meta: { ...b, subject, label: b.version_id } };
      }).filter(Boolean);
      if (points.length) any = true;
      out.push({ name: subject.label, subject, kind: 'marks',
                 color: subject.color, points });
    });
    return { series: out, empty: !any };
  },

  /* 语种构成堆叠面积。游戏对象是自然 7 天窗口；版本对象是从更新日
     重新起算的相对周。把桶内每一天都填成该桶的占比，因此轨道呈现阶梯，
     而不是低评测量下噪声很大的逐日曲线。 */
  stacked_share(lane, ctx) {
    if (ctx.multi) {
      return { series: [], empty: true,
               note: '堆叠构成只在单个对比对象下可读，多对象请看下方语种对照表' };
    }
    const subject = ctx.subjects[0];
    const share = languageShareFor(subject);
    const buckets = (share && share.buckets) || [];
    if (!buckets.length) return { series: [], empty: true };

    const langs = share.languages || [];
    const ramp = config.share_ramp || [];
    const rampFor = (lang, i) => {
      if (lang === 'other') return config.share_other || C.baseline;
      const span = langs.filter(l => l !== 'other').length || 1;
      return ramp[Math.min(ramp.length - 1,
                           Math.round(i / Math.max(1, span - 1) * (ramp.length - 1)))];
    };
    const bucketAt = key => buckets.find(b => {
      const s = axisKeyOf(b.start, subject, ctx.axis.align);
      const e = axisKeyOf(b.end, subject, ctx.axis.align);
      if (s === null && e === null) return false;
      if (ctx.axis.align === 'day0') {
        return Number(key) >= Number(s ?? -1e9) && Number(key) <= Number(e ?? 1e9);
      }
      return key >= b.start && key <= b.end;
    });

    return {
      series: langs.map((lang, i) => ({
        name: LANG_LABEL[lang] || lang,
        subject, kind: 'line', stack: 'lang', area: true,
        color: rampFor(lang, i),
        width: 0,
        values: ctx.axis.keys.map(k => {
          const b = bucketAt(k);
          return b ? (b.shares[lang] ?? null) : null;
        }),
      })),
      empty: false,
      note: subject.kind === 'version'
        ? '按版本更新日计第 N 周 · 首尾周可能不足 7 天'
        : null,
    };
  },

  /* 语种结构**变化**：相对首个分桶的百分点差，0 为基线。
     100% 堆叠面积里中间层没有稳定基线，1-2pp 的结构变化人眼读不出来；
     改画相对首桶的偏离量之后每条线各有自己的基线，升降一目了然。
     只画变化幅度最大的几个语种 —— 尾部语种的占比本来就在噪声量级。 */
  share_delta(lane, ctx) {
    if (ctx.multi) {
      return { series: [], empty: true,
               note: '结构变化只在单个对比对象下可读，多对象请看下方语种对照表' };
    }
    const subject = ctx.subjects[0];
    const share = languageShareFor(subject);
    const buckets = (share && share.buckets) || [];
    if (buckets.length < 2) {
      return { series: [], empty: true,
               note: subject.kind === 'version'
                 ? '该版本内不足两个相对周，算不出结构变化'
                 : '该窗口内不足两个 7 天分桶，算不出结构变化' };
    }

    const base = buckets[0].shares;
    const last = buckets[buckets.length - 1].shares;
    const topN = lane.top_n || 5;
    const langs = (share.languages || [])
      .filter(l => l !== 'other' && base[l] != null && last[l] != null)
      .sort((a, b) => Math.abs(last[b] - base[b]) - Math.abs(last[a] - base[a]))
      .slice(0, topN);

    // 这里的语种是并列类别，不是有序量，所以用分类色位而不是顺序色阶。
    // 顺序色阶在堆叠图里对（由深到浅 = 由大到小），但换成几条独立折线之后
    // 深浅只会让人分不清谁是谁。
    const SLOTS = ['slot1', 'slot2', 'slot3', 'slot5', 'slot7'];
    const bucketAt = key => buckets.find(b =>
      ctx.axis.align === 'day0'
        ? Number(key) >= Number(axisKeyOf(b.start, subject, 'day0') ?? -1e9) &&
          Number(key) <= Number(axisKeyOf(b.end, subject, 'day0') ?? 1e9)
        : key >= b.start && key <= b.end);

    return {
      series: langs.map((lang, i) => ({
        name: LANG_LABEL[lang] || lang,
        subject, kind: 'line',
        color: color(SLOTS[i % SLOTS.length]),
        width: 2, endLabel: true, endLabelUnit: 'pp',
        values: ctx.axis.keys.map(k => {
          const b = bucketAt(k);
          if (!b || b.shares[lang] == null) return null;
          return Number((b.shares[lang] - base[lang]).toFixed(2));
        }),
      })),
      empty: false,
      note: subject.kind === 'version'
        ? `基线第 ${buckets[0].relative_week || 1} 周 · 变化最大的 ${langs.length} 个语种`
        : `基线 ${buckets[0].start} · 变化最大的 ${langs.length} 个语种`,
    };
  },
};

/* ---------- 综合图渲染 ---------- */

const LANE_GAP = 46;     // 轨道之间的留白，需容纳轨道标题
const CHART_TOP = 44;
const CHART_BOTTOM = 42;

function laneTitle(lane, top, note, thin) {
  const sub = [lane.subtitle, note].filter(Boolean).join(' · ');
  return {
    text: `{h|${lane.title}}` + (sub ? `  {${thin ? 'w' : 's'}|${sub}}` : ''),
    left: 2, top: top - 30,
    textStyle: {
      fontFamily: FONT,
      rich: {
        h: { fontSize: 12.5, fontWeight: 600, color: C.primary, fontFamily: FONT },
        s: { fontSize: 11.5, color: C.muted, fontFamily: FONT },
        // 「数据还在积累」是一种状态，不是一句注释，要和普通副标题区分开
        w: { fontSize: 11.5, color: C.warning, fontFamily: FONT, fontWeight: 500 },
      },
    },
  };
}

/* 一条轨道画得出来、但覆盖率极低时，必须把「数据还在积累」和
   「这个指标本来就低」区分开。典型是 Steam 同时在线：它无法回填，
   只能从开始采集那天往后长，90 天的横轴上目前只有 2 个点 ——
   而它在默认预设里，新用户第一眼看到的就是一条近乎空白的轨道。
   散点轨道（视频）天然稀疏，不参与这个判断。 */
const THIN_COVERAGE = 0.25;

function coverageOf(built, ctx) {
  if (built.note) return { note: built.note, thin: false };
  const span = ctx.axis.keys.length;
  const dense = built.series.filter(s => s.values && s.kind !== 'scatter');
  if (!span || !dense.length) return { note: undefined, thin: false };
  const covered = Math.max(...dense.map(
    s => s.values.filter(v => v != null).length));
  if (!covered || covered / span >= THIN_COVERAGE) {
    return { note: undefined, thin: false };
  }
  return { note: `数据积累中 · ${span} 天里只有 ${covered} 天有值`, thin: true };
}

/* 贯穿竖线只在「单个对象」时画版本更新日 —— 多对象各有各的版本节奏，
   叠在一起会被读成同一个事件；那种情况下版本改由 version_marks 轨道承载。
   day0 对齐时第 0 天就是各自的起点，画一条 0 位竖线即可。 */
function laneMarkLine(ctx, withLabel) {
  if (ctx.axis.align === 'day0') {
    const s = ctx.subjects[0];
    return {
      silent: true, symbol: 'none',
      lineStyle: { color: C.marker, width: 1 },
      label: withLabel ? {
        show: true, position: 'start', distance: 6, fontSize: 11,
        color: C.secondary, fontFamily: FONT, fontWeight: 500,
        backgroundColor: C.surface, padding: [2, 5], borderRadius: 3,
        formatter: p => p.name,
      } : { show: false },
      data: [{ xAxis: '0', name: ctx.multi ? '各自起点' : `${s.originLabel}日` }],
    };
  }
  if (ctx.multi) return undefined;
  const s = ctx.subjects[0];
  const bounds = (s.snap.events || []).filter(e => e.is_version_boundary);
  return {
    silent: true, symbol: 'none',
    lineStyle: { color: C.marker, width: 1 },
    label: withLabel ? {
      show: true, position: 'start', distance: 6,
      formatter: p => p.name, fontSize: 11, color: C.secondary,
      fontFamily: FONT, fontWeight: 500,
      backgroundColor: C.surface, padding: [2, 5], borderRadius: 3,
    } : { show: false },
    data: bounds
      .map(b => ({ date: axisKeyOf(b.date_local, s, 'calendar'), b }))
      .filter(x => x.date !== null)
      .map(x => ({ xAxis: x.date, name: (x.b.version_id || '') + ' 上线' })),
  };
}

function buildLaneSeries(def, laneIndex, ctx, isFirst, ownAxis) {
  const base = {
    xAxisIndex: laneIndex, yAxisIndex: laneIndex,
    name: def.name,
    // 自带横轴的轨道不画版本竖线：那些竖线的横坐标属于另一套时钟
    markLine: ownAxis ? undefined : laneMarkLine(ctx, isFirst),
  };

  if (def.kind === 'scatter') {
    // 语区轨道用固定尺寸：纵轴已经在编码数值，再让直径也跟着数值走
    // 就是同一个量编码两遍，而且会让大点吞掉相邻语区的点。
    // 形状在这里承载语区身份，尺寸必须让位给形状的可辨识度。
    const fixed = !!def.symbol && def.symbol !== true;
    return {
      ...base, type: 'scatter',
      data: (def.points || []).map(p => ({ value: [p.key, p.value], meta: p.meta })),
      symbol: fixed ? def.symbol : 'circle',
      symbolSize: fixed ? 10 : (d => {
        const v = Math.abs(d[1]) || 0;
        // 面积随数值开方增长：直接用数值做直径会让大视频吞掉整条轨道
        return Math.max(9, Math.min(26, 9 + Math.sqrt(v) / 160));
      }),
      itemStyle: { color: def.color, opacity: .85,
                   borderColor: C.surface, borderWidth: fixed ? 1 : 2 },
    };
  }

  /* 版本标记：每个对象一行的窄竖条，版本号标在右侧。
     行高只有 ~24px，标签放上方会被推进相邻对象的行里。 */
  if (def.kind === 'marks') {
    return {
      ...base, type: 'scatter',
      data: (def.points || []).map(p => ({ value: [p.key, p.value], meta: p.meta })),
      symbol: 'rect', symbolSize: [3, 22],
      itemStyle: { color: def.color },
      label: {
        show: true, position: 'right', distance: 5,
        fontFamily: FONT, fontSize: 10.5, fontWeight: 600, color: def.color,
        formatter: p => (p.data.meta || {}).label || '',
      },
      labelLayout: { moveOverlap: 'shiftX' },
      z: 5,
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
    symbolSize: 7,
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
      formatter: p => {
        const v = Array.isArray(p.value) ? p.value[1] : p.value;
        if (v == null) return '';
        return def.endLabelUnit === 'pp'
          ? (v > 0 ? '+' : '') + v.toFixed(1) + 'pp'
          : v.toFixed(2) + '%';
      },
    } : { show: false },
    // 多个对象的终值可能只差零点几个百分点，端点标签会叠在一起
    labelLayout: { moveOverlap: 'shiftY' },
  };
}

/* 把 N 个对比对象画到 M 条轨道上。返回 laneData 供图例与提示框复用。 */
function renderPulse(chart, el, lanes, ctx) {
  if (!lanes.length || !ctx.axis.keys.length) {
    chart.clear();
    el.style.height = '120px';
    return [];
  }

  // 轨道高度可调，因此容器高度必须跟着算，不能写死
  const totalHeight = CHART_TOP + CHART_BOTTOM
    + lanes.reduce((s, l) => s + l.height, 0) + LANE_GAP * (lanes.length - 1);
  el.style.height = totalHeight + 'px';

  const grids = [], xAxes = [], yAxes = [], series = [], titles = [];
  const laneData = [];
  const ownAxisLanes = [];   // 不参与十字准线联动的轨道
  let top = CHART_TOP;

  lanes.forEach((lane, i) => {
    const adapter = ADAPTERS[lane.adapter];
    const built = adapter ? adapter(lane, ctx)
                          : { series: [], empty: true, note: '未知 adapter' };
    laneData.push({ lane, built });

    grids.push({ left: 64, right: 96, top, height: lane.height });

    // 自带横轴的轨道（目前只有视频爬坡）必须自己显示刻度，
    // 否则它会借用最底下那条轨道的日期刻度，读起来完全是错的
    const ownAxis = !!built.axisKeys;
    if (ownAxis) ownAxisLanes.push(i);
    const isLast = i === lanes.length - 1;
    const showLabel = ownAxis || isLast;
    const isMarks = lane.adapter === 'version_marks';
    xAxes.push({
      gridIndex: i, type: 'category',
      data: built.axisKeys || ctx.axis.keys,
      boundaryGap: lane.chart === 'bar',
      axisLine: { lineStyle: { color: C.baseline } },
      axisTick: { show: false },
      axisLabel: showLabel ? {
        color: C.muted, fontSize: 11, fontFamily: FONT, margin: 12,
        formatter: v => ownAxis ? `${v} 天` : axisLabelOf(v, ctx.axis.align),
        hideOverlap: true,
      } : { show: false },
      splitLine: { show: false },
      axisPointer: { label: { show: showLabel,
        formatter: p => ownAxis
          ? `发布后第 ${p.value} 天`
          : ctx.axis.align === 'day0'
            ? (Number(p.value) < 0 && ctx.subjects.some(s => s.kind === 'version')
              ? `正式更新前 ${Math.abs(Number(p.value))} 天` : `第 ${p.value} 天`)
            : p.value,
        backgroundColor: C.primary, fontFamily: FONT } },
    });

    const isShare = lane.adapter === 'stacked_share';
    if (isMarks) {
      // 版本轨道的纵轴是对象名，不是数值
      yAxes.push({
        gridIndex: i, type: 'category',
        data: ctx.subjects.map(s => s.label).reverse(),
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { color: C.secondary, fontSize: 11.5, fontFamily: FONT },
      });
    } else {
      // 跨数量级的轨道（语区播放量：中位数 17k~118k、最大 607 万）走对数轴，
      // 读的是垂直距离＝倍数关系，而不是柱子高低
      const unit = built.valueUnit || lane.unit;
      yAxes.push({
        gridIndex: i,
        type: built.logScale ? 'log' : 'value',
        logBase: 10,
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: C.gridline, width: 1 } },
        axisLabel: { color: C.muted, fontSize: 11, fontFamily: FONT,
                     formatter: unitFmt(unit) },
        max: isShare ? 100 : undefined,
        // 好评率这类高位窄幅指标，从 0 起会把全部变化压成一条直线
        min: (lane.unit === 'percent' && !isShare && !built.logScale)
          ? (v => Math.max(0, Math.floor(v.min - 4))) : undefined,
      });
    }

    const cov = built.empty
      ? { note: built.note || '暂无数据', thin: true }
      : coverageOf(built, ctx);
    built.coverage = cov;
    titles.push(laneTitle(lane, top, cov.note, cov.thin));

    built.series.forEach(def => {
      // 图例点掉的对象只是不画，轨道结构（纵轴、标题、其余对象）保持不变
      if (def.subject && ctx.hidden && ctx.hidden.has(def.subject.key)) return;
      series.push(buildLaneSeries(def, i, ctx, i === 0, ownAxis));
    });

    // 相对标尺下的 1× 基准线。它对所有语区同时成立，是这个视图里
    // 唯一一条跨语区可读的横线 —— 绝对标尺下没有这种线。
    if (built.baseline != null) {
      series.push({
        type: 'line', xAxisIndex: i, yAxisIndex: i, data: [], silent: true,
        markLine: {
          symbol: 'none', silent: true,
          lineStyle: { color: C.marker, width: 1, type: 'dashed' },
          // 标签放在网格外的右侧留白里：画在网格内会正好压在
          // 最密集的那一簇点上（1× 附近本来就是点最多的地方）
          label: { show: true, position: 'end', distance: 4,
                   formatter: '1× 本语区常态',
                   fontSize: 10.5, color: C.secondary, fontFamily: FONT },
          data: [{ yAxis: built.baseline }],
        },
      });
    }

    top += lane.height + LANE_GAP;
  });

  chart.setOption({
    animationDuration: 380,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: FONT },
    title: titles,
    grid: grids, xAxis: xAxes, yAxis: yAxes,
    axisPointer: {
      // 只联动共享横轴的那些轨道；自带横轴的轨道横坐标含义不同，
      // 把它拉进联动会让「同一条竖线」跨越两种时间语义
      link: [{ xAxisIndex: lanes.map((_, i) => i).filter(i => !ownAxisLanes.includes(i)) }],
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
      formatter: params => buildTooltip(params, laneData, ctx),
    },
    series,
  }, true);

  return laneData;
}

function buildTooltip(params, laneData, ctx) {
  if (!params.length) return '';
  const key = String(params[0].axisValue);
  // 悬停在自带横轴的轨道上时，key 可能不在共享轴里 —— 这不是错误，
  // 下面按轨道各自的刻度取值
  const at = ctx.axis.keys.indexOf(key);

  const row = (c, label, value, extra) =>
    `<div style="display:flex;align-items:center;gap:7px;margin:3px 0">
       <span style="width:8px;height:8px;border-radius:2px;background:${c};flex:none"></span>
       <span style="color:${C.secondary}">${label}</span>
       <span style="margin-left:auto;font-weight:600;font-variant-numeric:tabular-nums">${value}</span>
     </div>` + (extra ? `<div style="margin-left:15px;color:${C.muted};font-size:11px">${extra}</div>` : '');

  const head = ctx.axis.align === 'day0'
    ? (Number(key) < 0 && ctx.subjects.some(s => s.kind === 'version')
      ? `正式更新前 ${Math.abs(Number(key))} 天`
      : `起点后第 ${key} 天`) + (ctx.multi ? '' : ` · ${dateForKey(key, ctx.subjects[0])}`)
    : key;
  let s = `<div style="font-weight:600;margin-bottom:6px">${head}</div>`;
  let any = false;

  laneData.forEach(({ lane, built }) => {
    const toText = tipFmt(built.valueUnit || lane.unit);
    // 自带横轴的轨道要按自己的刻度找下标，不能用共享轴的
    const laneAt = built.axisKeys ? built.axisKeys.indexOf(key) : at;
    built.series.forEach(def => {
      if (def.points) {
        def.points.filter(p => p.key === key).forEach(p => {
          any = true;
          const m = p.meta || {};
          // 相对标尺下光给倍数不够：读者需要知道「8× 的绝对值是多少」，
          // 以及这个语区的常态本身在什么量级
          const scaleNote = (p.raw != null && p.median)
            ? `<br>${fmt(p.raw)} · 本语区中位数 ${fmt(p.median)}` : '';
          const extra = def.kind === 'marks'
            ? ''
            : `${m.title ? compactVideoLabel(m, m.subject || def.subject) : ''}${scaleNote}`;
          s += row(def.color, def.kind === 'marks' ? `${def.name} 版本更新` : def.name,
                   def.kind === 'marks' ? (m.label || '') : toText(p.value), extra);
        });
        return;
      }
      if (laneAt < 0) return;
      const v = def.values ? def.values[laneAt] : null;
      if (v == null) return;
      any = true;
      const span = def.spans && def.spans.get(key);
      s += row(def.color, def.name, toText(v),
               span ? `跨 ${span} 天的增量，不是单日值` : '');
    });
  });

  if (!any) s += `<div style="color:${C.muted}">该日无数据</div>`;

  // 单对象日历模式下，版本/构建事件作为脚注补充
  if (!ctx.multi && ctx.axis.align === 'calendar') {
    const ev = ctx.subjects[0].snap.events || [];
    const b = ev.find(x => x.date_local === key && x.is_version_boundary);
    if (b) s += `<div style="margin-top:7px;padding-top:7px;border-top:1px solid ${C.gridline};
                   color:${C.primary};font-weight:600">★ ${b.version_id} 版本更新</div>`;
    const p = ev.find(x => x.date_local === key && x.type === 'version_preview');
    if (p) s += `<div style="margin-top:6px;color:${C.muted}">${p.version_id} 前瞻节目</div>`;
    const bu = ev.find(x => x.date_local === key && x.type === 'build_update');
    if (bu) s += `<div style="margin-top:6px;color:${C.muted}">构建 ${bu.buildid}（third-party 旁证）</div>`;
  }
  return s;
}

const dateForKey = (key, subject) =>
  subject && subject.day0 ? addDays(subject.day0, Number(key)) : '';

const CONTENT_LABEL = {
  version_trailer: '版本 PV',
  character_trailer: '角色 PV',
  character_demo: '角色演示',
  character_ep: '角色 EP',
  season_teaser: '季前瞻',
  ep: 'EP',
  theme_mv: '主题曲 MV',
  animation_short: '动画短片',
  behind_the_scenes: '幕后',
  other: '其他',
};

function roleVideoKind(video) {
  const title = video.title || '';
  const type = video.content_type;
  if (type === 'character_ep') return 'ep';
  if (type === 'character_demo') return 'demo';
  if (type === 'character_trailer') return 'pv';
  if (type === 'season_teaser' && /character\s+(?:teaser|pv)|角色\s*PV/i.test(title)) return 'pv';
  if (/\bcharacter\s+short\b/i.test(title)) return 'short';
  if (/\banimated\s+short\b/i.test(title)) return 'animated_short';
  return null;
}

function cleanVideoName(value) {
  return String(value || '')
    .replace(/^(?:zenless zone zero|wuthering waves|nte(?: global)?)[\s|｜丨ح]*/i, '')
    .replace(/^《[^》]+》\s*/u, '')
    .split(/[◇◆]/u)[0]
    .replace(/^[\s"'“”‘’「『【(\[{|｜丨ح:：·-]+/u, '')
    .replace(/[\s"'“”‘’」』】)\]}|｜丨ح:：·-]+$/u, '')
    .trim();
}

function roleNameFromTitle(video, kind) {
  const title = String(video.title || '').replace(/\s+/g, ' ').trim();
  const cjk = '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}]{1,12}';
  const cjkPattern = kind === 'demo'
    ? new RegExp(`(?:^|[》】])\\s*(${cjk})\\s*角色(?:展示|演示|实机战斗)`, 'u')
    : kind === 'pv'
      ? new RegExp(`(?:^|[》】])\\s*(${cjk})\\s*(?:角色)?PV`, 'iu')
      : kind === 'ep'
        ? new RegExp(`(?:^|[》】])\\s*(${cjk})\\s*(?:角色)?EP`, 'iu')
        : null;
  const cjkMatch = cjkPattern && title.match(cjkPattern);
  if (cjkMatch) return cleanVideoName(cjkMatch[1]);

  const beforeRole = title.match(/^(.+?)\s+character\s+(?:demo|teaser|pv|trailer|short)\b/i);
  if (beforeRole) return cleanVideoName(beforeRole[1]);

  const episodeName = title.match(/[—–-]\s*([^—–-]+?)\s+EP\b/i);
  if (episodeName) return cleanVideoName(episodeName[1]);
  const leadingEpisode = title.match(/^(.+?)\s+EP\b/i);
  if (leadingEpisode) return cleanVideoName(leadingEpisode[1]);
  if (kind === 'ep') {
    const episodeSuffix = title.match(/[—–]\s*([^—–]+)$/u);
    if (episodeSuffix) return cleanVideoName(episodeSuffix[1]);
  }

  const showcase = title.match(/(?:combat|resonator combat)\s+showcase\s*[|｜丨ح]\s*([^|｜丨ح]+)/i);
  if (showcase) return cleanVideoName(showcase[1]);

  const end = title.split(/[|｜丨ح]/u).pop();
  return cleanVideoName(end);
}

function registeredChineseCharacterName(video, subject, kind) {
  if (video.character_name) return String(video.character_name).trim();
  const records = (subject && subject.snap && subject.snap.bilibili && subject.snap.bilibili.videos) || [];
  if (!video.pubdate || !records.length) return '';
  const target = Date.parse(`${video.pubdate}T00:00:00Z`);
  const candidates = records
    .filter(v => v.character_name && roleVideoKind(v) === kind && v.pubdate)
    .map(v => ({name: String(v.character_name).trim(),
                days: Math.abs(Date.parse(`${v.pubdate}T00:00:00Z`) - target) / 86400000}))
    .filter(v => v.days <= 1)
    .sort((a, b) => a.days - b.days);
  if (!candidates.length) return '';
  const nearest = candidates.filter(v => v.days === candidates[0].days);
  const names = [...new Set(nearest.map(v => v.name))];
  return names.length === 1 ? names[0] : '';
}

function compactVideoLabel(video, subject) {
  if (video.short_title || video.display_title) return String(video.short_title || video.display_title).trim();
  const title = String(video.title || '').replace(/\s+/g, ' ').trim();
  const type = video.content_type;
  const roleKind = roleVideoKind(video);

  if (roleKind) {
    const name = registeredChineseCharacterName(video, subject, roleKind) ||
      (video.character_name ? String(video.character_name).trim() : roleNameFromTitle(video, roleKind));
    if ((roleKind === 'short' || roleKind === 'animated_short')) {
      const part = title.match(/(?:ver\.?|part)\s*(\d+)/i);
      const label = roleKind === 'short' ? '角色短片' : '动画短片';
      return `${name ? name + ' ' : ''}${label}${part ? ' ' + part[1] : ''}`;
    }
    if (roleKind === 'ep' && !name && /theme song|主题曲/i.test(title)) return '主题曲 MV';
    const suffix = {ep: 'EP', pv: 'PV', demo: '角色展示'}[roleKind];
    return `${name || '角色'} ${suffix}`;
  }

  const ver = title.match(/\b(?:version|ver(?:sion)?\.?|v)\s*(\d+(?:\.\d+)+)\b|\b(\d+\.\d+)\s*版本/i);
  const version = (ver && (ver[1] || ver[2])) || String(video.version_id || '').replace(/^v/i, '');
  if (version && (type === 'version_trailer' || type === 'season_teaser')) {
    if (/preview\s+recap/i.test(title)) {
      const topic = cleanVideoName(title.split(/[|｜丨ح]/u).pop())
        .replace(/^(?:new|updated)\s+/i, '')
        .replace(/^(?:water\s+)?(?:vehicle|region|district)\s*[-:：]\s*/i, '')
        .slice(0, 20);
      return `${version}版本回顾${topic ? ' · ' + topic : ''}`;
    }
    if (/special\s+program|preview\s+special\s+(?:broadcast|program)|前瞻特別節目|前瞻特别节目/i.test(title)) {
      return `${version}版本前瞻`;
    }
    if (/now live|goes live|is live|上线|上線|正式リリース|출시/i.test(title)) return `${version}版本上线`;
    if (/geographic preview|地理预览|地理預覽/i.test(title)) return `${version}版本地图预览`;
    if (/new region gameplay demo/i.test(title)) return `${version}版本区域实机`;
    if (/preview\s+recap/i.test(title)) return `${version}版本回顾`;
    if (/teaser|\bPV\b|official trailer|预告/i.test(title)) return `${version}版本PV`;
    return `${version}版本`;
  }

  if (type === 'version_trailer') return '版本 PV';
  if (type === 'season_teaser') {
    if (/steam release announcement/i.test(title)) return 'Steam 版上线';
    if (/collab|collaboration|联动/i.test(title)) return '联动 PV';
    if (/summer|夏日|夏季/i.test(title)) return '夏日 PV';
    if (/worldview|世界观/i.test(title)) return '世界观 PV';
    if (/world tour/i.test(title)) return '世界巡游 PV';
    if (/xuanfang trailer/i.test(title)) {
      const name = cleanVideoName(title.split(/[|｜丨ح]/u).pop());
      return `${name || '主题'} PV`;
    }
    return '主题 PV';
  }
  return CONTENT_LABEL[type] || '官方视频';
}
