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
const VIEW_STATE_VERSION = 4;

let config = null;            // dashboard_config.json
let catalog = [];             // index.json 的 games，即对比对象目录
const snapCache = new Map();  // game_id -> snapshot
let chart = null;

let subjects = [];            // 当前对比对象（长度 1 即单游戏）
let align = 'calendar';       // calendar | day0
let rangeDays = 90;
let laneState = [];           // [{id, height, enabled}]，顺序即显示顺序
let laneData = [];            // 最近一次渲染的轨道数据，供图例/数据表复用
let hiddenSubjects = new Set();  // 图例里被临时隐藏的对象（不进 URL，刷新即复位）

const pct = n => (n === null || n === undefined) ? '—' : n.toFixed(2) + '%';

function color(slot) {
  return (config.palette && config.palette[slot]) || C.muted;
}

/* 就近口径：每个指标一条，点 ⓘ 在原地展开。
   这些话原本全都挤在页面最底部那段 400 字里 —— 离它解释的数字有三屏远。 */
const METRIC_INFO = {
  online: { t: 'Steam 同时在线',
    d: '平台同时在线测值，不是 DAU，也不是总玩家数。<b>无法回填</b>：只能从开始采集那天往后逐日积累，所以采集点数量决定了这条曲线有多长。' },
  cum_rate: { t: '累计好评率',
    d: '好评 / 全部评测，口径是<b>今天仍然存在</b>的评测。这是存量指标，评测基数越大，单日事件对它的影响越小 —— 想看短期变化请看「当日好评率」。' },
  avg7: { t: '近 7 日均新增评测',
    d: '新增评测量用作<b>讨论热度的代理</b>，不是玩家数。百分比是最近 7 天日均与前 7 天日均之比。' },
  playtime: { t: '评测者中位时长',
    d: '写下评测那一刻已游玩的时长。取最近 14 天里有值的那些天的中位数 —— 单日样本量太小，逐日看噪声压过信号。' },
  bili_engagement: { t: 'B 站互动率',
    d: '（点赞+投币+收藏）/ 播放。<b>截面比值</b>，不受推荐位与频道体量影响，是跨视频唯一公平的比法；播放量不是。' },
  version: { t: '当前版本',
    d: '版本更新日取自 Steam 官方公告，构建号来自 SteamCMD 第三方镜像（仅作旁证）。事件只表示时间节点，不表示因果。' },
  daily_avg: { t: '窗口内日均新增评测',
    d: '该对象<b>自己完整窗口</b>内的新增评测 ÷ 天数。窗口长度不同的对象之间，日均与比率可比，<b>绝对量不可比</b>。' },
  window_table: { t: '窗口对照',
    d: '每个对象统计的是它自己的完整窗口，不受图上「时间范围」与起点对齐截断的影响。窗口之外该游戏可能仍在运营，不代表数值为 0。' },
  version_table: { t: '版本更新前后 7 天对比',
    d: '只比较前后各有完整 7 天的版本。版本更新同时带来<b>新玩家涌入</b>与<b>老玩家回流</b>，评测量变化包含两者，不能单独归因于内容质量。' },
  lang_table: { t: '评测语言分布',
    d: '按 7 天分桶汇总的评测语种构成，反映 Steam 版本的玩家来源结构。样本是评测者，不是玩家全体。' },
  cadence_table: { t: '版本节奏',
    d: '最近 6 个版本的更新间隔均值，取自各自 Steam 官方公告。间隔变化本身不说明好坏，只用来判断某次更新是提前还是延后。' },
};

const infoBtn = key => `<button class="info" data-info="${key}"
  aria-label="${(METRIC_INFO[key] || {}).t || ''} 的口径说明">ⓘ</button>`;

const LANG_LABEL = {
  english: 'English', russian: 'Русский', schinese: '简体中文', tchinese: '繁體中文',
  japanese: '日本語', koreana: '한국어', spanish: 'Español', latam: 'Español (LATAM)',
  brazilian: 'Português (BR)', german: 'Deutsch', french: 'Français',
  thai: 'ไทย', vietnamese: 'Tiếng Việt', indonesian: 'Indonesia',
  polish: 'Polski', turkish: 'Türkçe', italian: 'Italiano', ukrainian: 'Українська',
  other: '其他',
};

/* ---------- 快照加载 ---------- */

/* 快照是最容易缺失的一环（体积最大，且忘了跑 pipeline 就没有），
   却原本是全链路里唯一没有错误处理的 fetch —— 失败时页面会永远停在
   「正在加载快照…」，只在控制台留一句 Failed to fetch。 */
async function snapshotOf(gameId) {
  if (!snapCache.has(gameId)) {
    const url = `../data/snapshot_${gameId}.json`;
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new LoadError(`读不到 ${url}`,
        'HTTP 服务必须从<b>项目根目录</b>启动，而不是 dashboard/ 子目录；' +
        '在 dashboard/ 里启动会让 ../data/*.json 全部 404。');
    }
    if (!res.ok) {
      throw new LoadError(`${url} 返回 HTTP ${res.status}`,
        `快照文件不存在或不可读。先运行 <code>python pipeline/build_snapshot.py</code> 生成它。`);
    }
    try {
      snapCache.set(gameId, await res.json());
    } catch (e) {
      throw new LoadError(`${url} 不是合法 JSON`,
        '快照可能写到一半被中断了，重新运行 <code>python pipeline/build_snapshot.py</code>。');
    }
  }
  return snapCache.get(gameId);
}

class LoadError extends Error {
  constructor(message, hint) { super(message); this.hint = hint; }
}

/* 对象本身只有元信息，快照按需挂上去 —— 三份快照合计 1.3MB，
   只有真正被加进对比列表的游戏才值得下载。 */
async function hydrate(list) {
  await Promise.all([...new Set(list.map(s => s.gameId))].map(snapshotOf));
  list.forEach(s => { s.snap = snapCache.get(s.gameId); });
  return list;
}

/* 把 #loading 变成一个说得清楚、且能重试的错误页。
   retry 用整页重载而不是重新 fetch：出错时状态可能只恢复了一半。 */
function fail(title, hint) {
  const box = document.getElementById('loading');
  box.innerHTML = `
    <div style="max-width:520px;margin:0 auto;text-align:left">
      <div style="font-size:15px;font-weight:600;color:var(--text-primary);
                  margin-bottom:8px">看板没能加载</div>
      <div style="color:var(--text-secondary);font-size:13px;line-height:1.7">
        <div style="margin-bottom:6px">${title}</div>
        ${hint ? `<div style="color:var(--text-muted)">${hint}</div>` : ''}
      </div>
      <button class="linkish" id="retryLoad" style="margin-top:14px">重新加载</button>
    </div>`;
  box.classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  document.getElementById('retryLoad').onclick = () => location.reload();
}

/* ---------- 视图状态 ---------- */

/* 有些轨道的纵轴不止一种读法（语区播放量：绝对值 vs 相对本语区中位数），
   由 dashboard.yml 的 lane.scales 声明，默认取第一个。 */
const defaultScale = l => ((l.scales || [])[0] || {}).id || null;

function defaultLaneState() {
  return config.lanes.map(l => ({
    id: l.id, height: l.height || 120, enabled: !!l.enabled,
    scale: defaultScale(l),
  }));
}

function applyPreset(name) {
  const preset = (config.presets || {})[name];
  if (!preset) return;
  const wanted = preset.lanes;
  const byId = new Map(config.lanes.map(l => [l.id, l]));
  const make = (id, enabled) => {
    const l = byId.get(id) || {};
    return { id, height: l.height || 120, enabled, scale: defaultScale(l) };
  };
  laneState = wanted.map(id => make(id, true))
    .concat(config.lanes.filter(l => !wanted.includes(l.id))
                        .map(l => make(l.id, false)));
}

/* 轨道序列化成 id.height 或 id.height.scale。第三段是后加的，
   解析时按缺省处理，老链接与老 localStorage 仍然能读。 */
function serializeView() {
  const on = laneState.filter(l => l.enabled)
    .map(l => `${l.id}.${l.height}${l.scale ? '.' + l.scale : ''}`).join(',');
  return `v=${VIEW_STATE_VERSION}&s=${subjects.map(s => s.key).join('|')}&a=${align}&r=${rangeDays}&l=${on}`;
}

function parseView(str) {
  const params = new URLSearchParams(str);
  const viewVersion = Number(params.get('v') || 0);
  const out = {};
  if (params.get('s')) out.subjectKeys = params.get('s').split('|').filter(Boolean);
  if (params.get('a')) out.align = params.get('a') === 'day0' ? 'day0' : 'calendar';
  if (params.get('r') !== null) out.range = Number(params.get('r'));
  const l = params.get('l');
  if (l) {
    const byId = new Map(config.lanes.map(x => [x.id, x]));
    const on = l.split(',').map(part => {
      const [id, h, scale] = part.split('.');
      const lane = byId.get(id);
      if (!lane) return null;
      // 链接里的 scale 必须是该轨道真的声明过的，否则退回默认 ——
      // 老链接没有这一段，改过配置的链接可能带着已删掉的标尺
      const known = (lane.scales || []).some(s => s.id === scale);
      return { id, height: Number(h) || 120, enabled: true,
               scale: known ? scale : defaultScale(lane) };
    }).filter(Boolean);
    if (on.length) {
      // 旧视图只启用了 B 站轨道。补入现在已接入的四语区 YouTube 轨道一次，
      // 随后的视图链接带 v=4，用户以后手动关闭也会保留自己的选择。
      if (viewVersion < VIEW_STATE_VERSION) {
        const onIds = new Set(on.map(x => x.id));
        config.lanes.filter(x => x.enabled &&
          ['yt_view_locales', 'yt_engagement_locales'].includes(x.id) &&
          !onIds.has(x.id)).forEach(x => on.push({
            id: x.id, height: x.height || 120, enabled: true,
            scale: defaultScale(x),
          }));
      }
      const onIds = new Set(on.map(x => x.id));
      const off = config.lanes.filter(x => !onIds.has(x.id))
        .map(x => ({ id: x.id, height: x.height || 120, enabled: false,
                     scale: defaultScale(x) }));
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
    .map(s => ({ ...byId.get(s.id), height: s.height,
                 scale: s.scale || defaultScale(byId.get(s.id)) }));
}

function buildCtx() {
  const lanes = activeLanes();
  // 散点、日增量和语区对照都按发布日期定位；发布后爬升曲线用独立横轴，
  // 不应改变版本主图的起点或数据表日期范围。
  const videoLanes = lanes.filter(lane =>
    ['video_scatter', 'video_delta', 'locale_scatter'].includes(lane.adapter));
  return {
    axis: buildAxis(subjects, align, rangeDays, videoLanes),
    subjects,
    multi: subjects.length > 1,
    includesVideoLanes: videoLanes.length > 0,
    // 图例里被点掉的对象只从图上消失，下方表格照常统计 ——
    // 隐藏是为了看清剩下那几条线，不是把对象移出这次对比
    hidden: hiddenSubjects,
  };
}

function clearDashboardState(message) {
  chart.clear();
  laneData = [];
  hiddenSubjects.clear();

  document.getElementById('pulse').style.height = '120px';
  document.getElementById('legend').innerHTML = `<span class="muted">${message}</span>`;
  document.getElementById('pulseNote').textContent = '';
  document.getElementById('pulseFineText').textContent = '';
  document.getElementById('tiles').innerHTML = '';
  document.getElementById('readout').innerHTML = '';

  document.getElementById('cmpWindowNote').textContent = '';
  document.querySelector('#cmpTable tbody').innerHTML = '';
  document.querySelector('#cadenceTable tbody').innerHTML = '';

  document.querySelector('#versionTable thead tr').innerHTML =
    '<th>版本</th><th>更新日</th>';
  document.querySelector('#versionTable tbody').innerHTML = '';
  document.getElementById('versionLead').innerHTML = '';
  document.getElementById('versionNote').textContent = '';

  document.querySelector('#langTable thead tr').innerHTML = '';
  document.querySelector('#langTable tbody').innerHTML = '';
  document.getElementById('langNote').textContent = '';

  document.querySelector('#dataTable thead tr').innerHTML = `
    <th>日期</th>
    <th class="num">新增评测</th>
    <th class="num">好评</th>
    <th class="num">差评</th>
    <th class="num">当日好评率</th>
    <th class="num">累计好评率</th>
    <th class="num">Steam 同时在线</th>
    <th>事件</th>`;
  document.querySelector('#dataTable tbody').innerHTML = '';

  document.getElementById('sources').innerHTML = '';
  document.getElementById('caveat').innerHTML = '';

  document.getElementById('pulseFine').open = false;
  document.getElementById('versionFine').open = false;
  document.getElementById('tableCard').classList.add('hidden');
  const toggleTable = document.getElementById('toggleTable');
  toggleTable.textContent = '显示数据表';
  toggleTable.setAttribute('aria-expanded', 'false');
}

function renderAll() {
  const ctx = buildCtx();
  const lanes = activeLanes();
  const el = document.getElementById('pulse');

  const blank = msg => {
    clearDashboardState(msg);
    persistView();
  };
  if (!subjects.length) {
    return blank('还没有选择对比对象。用上方的「＋ 添加对象」挑一个游戏或版本。');
  }
  if (!lanes.length) {
    return blank('没有启用任何轨道。点击右上角「自定义轨道」选择要显示的指标。');
  }

  laneData = renderPulse(chart, el, lanes, ctx);
  renderLegend(ctx);
  syncRangeLabel();
  renderPulseNote(ctx);
  renderTiles(ctx);
  renderReadout(ctx);
  renderWindowTable(ctx);
  renderCadenceTable(ctx);
  renderVersionTable(ctx);
  renderLangSection(ctx);
  renderDataTable(ctx);
  renderSources(ctx);
  persistView();
}

/* 显眼位置只留「横轴现在是什么、取了哪一段」—— 这两件事会随控件变，
   读错就全错。其余固定不变的口径收进可折叠的 fine print，
   原来那一整段 5 句话的注释里有 4 句每次渲染都一模一样。 */
function renderPulseNote(ctx) {
  const hasVersion = subjects.some(s => s.kind === 'version');
  const hasVideoLanes = ctx.includesVideoLanes;
  const head = ctx.axis.align === 'day0'
    ? '横轴＝各自起点后的第 N 天（游戏从上线日起算，版本从该版本更新日起算）' +
      (hasVersion && hasVideoLanes
        ? '；已确认归属该版本的视频也按正式更新前的实际发布日期显示' : '')
    : '横轴＝日历日期';
  const span = rangeDays
    ? (ctx.axis.align === 'day0' ? `，取起点后的头 ${rangeDays} 天`
                                 : `，取最近 ${rangeDays} 天`)
    : '，取全部区间';
  document.getElementById('pulseNote').textContent = head + span + '。';

  const fine = [];
  if (ctx.axis.align === 'day0' && ctx.multi) {
    fine.push(`各对象窗口长度不齐，已统一截断到最短的 ${ctx.axis.truncatedTo} 天 ——
      否则长窗口会在短窗口结束后继续延伸，被读成「它表现更持久」，
      其实只是它有更多天的数据。`);
  }
  if (hasVersion && hasVideoLanes) {
    fine.push('版本对象的负天数由已确认归属该版本的视频确定；评测、在线等普通指标按已有历史数据延伸，版本滚动累计好评率从更新日起算。');
  }
  fine.push('各轨道单位不同，分别独立计量，不共用纵轴。');
  fine.push(ctx.multi
    ? '颜色代表对比对象；同一游戏的多个版本共用基色、以明度区分。点击图例可把某个对象从图上暂时拿掉，下方表格不受影响。'
    : '颜色在轨道内部区分指标系列。');
  fine.push('轨道由 config/dashboard.yml 定义，可在右上角「自定义轨道」中增删、排序与调整高度。');
  // 轨道各自的口径限制原本挤在图例尾巴上，现在跟着轨道说明走
  laneData.forEach(({ lane }) => {
    if (lane.caveat) fine.push(`${lane.title}：${lane.caveat}。`);
  });
  document.getElementById('pulseFineText').textContent =
    fine.join(' ').replace(/\s+/g, ' ');
}

/* 同样是「30 天」，日历对齐取的是**最近** 30 天，起点对齐取的是起点后的
   **头** 30 天 —— 方向相反。控件文案必须跟着对齐方式变，否则用户切换对齐时
   时间窗口悄悄掉了个头，而页面上没有任何地方提示这件事。 */
function syncRangeLabel() {
  const el = document.getElementById('rangeLabel');
  el.textContent = align === 'day0' ? '起点后' : '最近';
  el.title = align === 'day0'
    ? '从各对象自己的起点往后数'
    : '从最新一天往回数';
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

/* ---------- 图例 ----------
 *
 * 单对象时不画图例：那时图例的每一项都是轨道标题的复述
 * （「每日新增评测」「当日好评率」…），已经印在图里各轨道的左上角，
 * 而它却是整页最宽的一块文字。单对象下唯一有增量的是轨道的 caveat，
 * 那个跟着轨道标题走更合适。
 *
 * 多对象时图例才真正承载信息 —— 它标的是「哪个颜色是哪个对象」，
 * 并且可以点掉某个对象把图让给其余的。
 */
const SYMBOL_GLYPH = {
  circle: '●', triangle: '▲', rect: '■', diamond: '◆', pin: '⬟',
};

/* 单对象时只给「一条轨道里有多个系列」的轨道出图例 ——
   那才是图上看不出来的东西。单系列轨道的名字就是轨道标题，
   已经印在图里了，再列一遍只是把全页最宽的一行文字浪费掉。 */
function laneLegends() {
  const rows = new Map();   // 相同的图例内容只出一行，由多条轨道共用
  laneData
    .filter(({ built }) => (built.series || []).length > 1 && !built.empty)
    .forEach(({ lane, built }) => {
      const marks = built.series.slice(0, 8).map(def => {
        const glyph = def.symbol && SYMBOL_GLYPH[def.symbol];
        const mark = glyph
          ? `<span style="color:${def.color};font-size:10px;line-height:1">${glyph}</span>`
          : `<span class="${def.kind === 'scatter' ? 'mark dot'
              : def.kind === 'bar' ? 'mark bar' : 'mark'}"
                   style="background:${def.color}"></span>`;
        return `${mark}<span>${def.name}</span>`;
      }).join('<span style="width:10px"></span>');
      const entry = rows.get(marks) || { titles: [], marks };
      entry.titles.push(lane.title);
      rows.set(marks, entry);
    });

  // 两条语区轨道的图例完全一样（都是那四个语区），合成一行而不是印两遍
  return [...rows.values()].map(({ titles, marks }) =>
    `<div class="legend-item" style="cursor:default">
       <span style="color:${C.muted}">${titles.join(' / ')}：</span>${marks}
     </div>`).join('');
}

/* 形状 → 语区。多对象时颜色已被对象占用，形状是语区身份的唯一线索。 */
function shapeLegend() {
  const seen = new Map();
  laneData.forEach(({ built }) => (built.series || []).forEach(def => {
    if (def.locale && def.symbol && !seen.has(def.locale)) {
      seen.set(def.locale, def.symbol);
    }
  }));
  if (!seen.size) return '';
  const items = [...seen].map(([code, sym]) =>
    `<span style="font-size:10px;line-height:1;color:${C.secondary}">${
      SYMBOL_GLYPH[sym] || '●'}</span><span>${localeLabel(code)}</span>`)
    .join('<span style="width:10px"></span>');
  return `<div class="legend-item" style="cursor:default">
            <span style="color:${C.muted}">形状＝语区：</span>${items}
          </div>`;
}

function renderLegend(ctx) {
  const el = document.getElementById('legend');
  if (!ctx.multi) { el.innerHTML = laneLegends(); return; }

  el.innerHTML = subjects.map(s => {
    const off = hiddenSubjects.has(s.key);
    return `
      <button class="legend-item" data-subject="${s.key}" data-off="${off}"
              aria-pressed="${!off}"
              title="${off ? '点击显示' : '点击从图上隐藏'}（仅影响图，下方表格不变）">
        <span class="mark" style="background:${s.color}"></span>
        <span style="font-weight:500">${s.label}</span>
        <span style="color:${C.muted}">· ${s.sublabel}</span>
      </button>`;
  }).join('');

  // 多对象时颜色归对象、形状归语区，两套编码同时在场，形状那套要单独说明
  el.innerHTML += shapeLegend();

  el.querySelectorAll('[data-subject]').forEach(btn => {
    btn.onclick = () => {
      const key = btn.dataset.subject;
      if (hiddenSubjects.has(key)) hiddenSubjects.delete(key);
      else hiddenSubjects.add(key);
      // 全部点掉就等于没图，最后一个保留下来
      if (hiddenSubjects.size >= subjects.length) hiddenSubjects.delete(key);
      renderAll();
    };
  });
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

/* 列数交给 CSS 的 auto-fit 决定，JS 不再写 inline grid-template-columns ——
   inline 样式的优先级高于媒体查询，原来的 repeat(min(n,4),1fr) 会在窄屏上
   把 4 列硬撑出去，也会在 6 个对象时留下 4+2 的孤行。 */
function renderTiles(ctx) {
  const box = document.getElementById('tiles');

  // 单个游戏对象：保留原来那组更细的指标卡
  if (!ctx.multi && subjects[0].kind === 'game') {
    box.innerHTML = singleGameTiles(subjects[0]);
    return;
  }

  box.innerHTML = subjects.map(s => {
    const w = windowStats(s);
    const rateLabel = s.kind === 'version' ? '版本滚动累计好评率' : '窗口好评率';
    const onlineNote = !w.onlineLive ? '窗口已结束 · 在线无法回溯'
      : w.onlinePoints ? `${fmt(w.online)} 在线 · ${w.onlinePoints} 个采集点`
      : '在线尚未采集';
    return `<div class="tile">
      <div class="k"><span class="swatch" style="background:${s.color}"></span>${s.label}${infoBtn('daily_avg')}</div>
      <div class="v">${w.dailyAvg != null ? w.dailyAvg.toFixed(1) : '—'}<span class="unit">条/日</span></div>
      <div class="n">${deltaHtml(w.delta7)} ${w.delta7 != null ? '近 7 日对比前 7 日' : '窗口内日均新增评测'}</div>
      <div class="n" style="margin-top:2px">${rateLabel} ${pct(w.rate)} · ${fmt(w.reviews)} 条 / ${w.days} 天</div>
      <div class="n" style="margin-top:2px">${onlineNote}</div>
    </div>`;
  }).join('');
}

function singleGameTiles(subject) {
  const snap = subject.snap;
  const w = windowStats(subject);
  const bili = importantBiliSummary(snap);
  const bounds = (snap.events || []).filter(e => e.is_version_boundary);
  const current = bounds[bounds.length - 1];
  const profile = (snap.review_profile || {}).daily || [];
  const daysSince = current ? daysBetween(current.date_local, snap.snapshot_date) : null;

  // 中位时长取最近 14 天里有值的那些天，单日样本量太小
  const recent = profile.slice(-14).map(r => r.playtime_at_review_median).filter(v => v != null);
  const medianPlaytime = recent.length
    ? recent.sort((a, b) => a - b)[Math.floor(recent.length / 2)] : null;

  const tiles = [
    { k: 'Steam 同时在线', swatch: color('slot7'), info: 'online',
      v: w.onlinePoints ? fmt(w.online) : '—',
      n: w.onlinePoints ? `${w.onlinePoints} 个采集点 · 历史不可回填` : '尚未采集' },
    { k: '累计好评率', swatch: color('slot3'), info: 'cum_rate',
      v: w.cumRate != null ? w.cumRate.toFixed(2) : '—', unit: '%',
      n: w.totalReviews != null ? `${fmt(w.totalReviews)} 条评测` : '—' },
    { k: '近 7 日均新增评测', swatch: color('slot1'), info: 'avg7',
      v: w.avg7 != null ? w.avg7.toFixed(1) : '—',
      n: w.delta7 != null ? `${deltaHtml(w.delta7)} 对比前 7 日` : '—' },
    { k: '评测者中位时长', swatch: color('slot2'), info: 'playtime',
      v: medianPlaytime != null ? (medianPlaytime / 60).toFixed(1) : '—', unit: 'h',
      n: '近 14 天 · 写评测时已玩时长' },
    { k: 'B 站互动率', swatch: color('slot5'), info: 'bili_engagement',
      v: bili.rates && bili.rates.engagement != null
        ? bili.rates.engagement.toFixed(2) : '—', unit: '%',
      n: bili.videos ? `${bili.videos} 支重点官方视频 · 点赞+投币+收藏` : '—' },
    { k: '当前版本', info: 'version',
      v: current ? current.version_id : '—',
      n: daysSince != null ? `上线 ${daysSince} 天 · ${current.date_local}` : '—' },
  ];

  return tiles.map(t => `
    <div class="tile">
      <div class="k">${t.swatch ? `<span class="swatch" style="background:${t.swatch}"></span>` : ''}${t.k}${t.info ? infoBtn(t.info) : ''}</div>
      <div class="v">${t.v}${t.unit ? `<span class="unit">${t.unit}</span>` : ''}</div>
      <div class="n">${t.n}</div>
    </div>`).join('');
}

/* ---------- 结论层 ----------
 *
 * 整页原本只有数字没有判断：读者要自己在版本对比表的几十个
 * 「旧值 → 新值 / 增幅」格子里做归纳，而这些归纳 pipeline 早就算出来了。
 * 这里把它直接说成一句话，放在指标卡下面、图表上面。
 *
 * 只说数据本身支持的事实（谁高谁低、变了多少），不做因果推断 ——
 * 「3.6 比 3.5 差」是事实陈述，「3.6 的内容质量不如 3.5」不是。
 */

const sign = v => (v >= 0 ? '+' : '');
const cls = v => (Math.abs(v) < 1 ? 'flat' : (v > 0 ? 'up' : 'down'));
const delta = (v, unit) => v == null ? ''
  : `<span class="${cls(v)}">${sign(v)}${v.toFixed(unit === 'pp' ? 2 : 1)}${unit}</span>`;

/* 版本节奏：最近 6 个版本的平均间隔。窗口对照表和结论层都要用。 */
function cadenceOf(gameId) {
  const snap = snapCache.get(gameId);
  const recent = ((snap || {}).events || [])
    .filter(e => e.is_version_boundary).slice(-6);
  if (recent.length < 2) return { recent, avgGap: null };
  const gaps = [];
  for (let i = 1; i < recent.length; i++) {
    gaps.push(daysBetween(recent[i - 1].date_local, recent[i].date_local));
  }
  return { recent, avgGap: Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) };
}

function renderReadout(ctx) {
  const box = document.getElementById('readout');
  const lines = ctx.multi ? multiReadout(ctx) : singleReadout(ctx);
  box.innerHTML = lines.map(t => `<p>${t}</p>`).join('');
}

function singleReadout(ctx) {
  const s = subjects[0];
  const w = windowStats(s);
  const out = [];

  const trend = w.delta7 != null
    ? `，较前 7 日 ${delta(w.delta7, '%')}`
    : '';
  out.push(`<b>${s.label}</b> 近 7 日均新增评测 <b>${
    w.avg7 != null ? w.avg7.toFixed(1) : '—'}</b> 条${trend}。` +
    (w.cumRate != null
      ? ` 累计好评率 <b>${w.cumRate.toFixed(2)}%</b>（${fmt(w.totalReviews)} 条评测）。`
      : ''));

  if (s.kind === 'game') {
    const { avgGap } = cadenceOf(s.gameId);
    const bounds = (s.snap.events || []).filter(e => e.is_version_boundary);
    const cur = bounds[bounds.length - 1];
    if (cur) {
      const since = daysBetween(cur.date_local, s.snap.snapshot_date);
      const vs = avgGap
        ? `，该游戏近 ${Math.min(bounds.length, 6)} 个版本的平均间隔是 ${avgGap} 天`
        : '';
      out.push(`<span class="rank">当前版本 <b>${cur.version_id}</b> 已上线 ${since} 天${vs}。</span>`);
    }
  } else {
    out.push(`<span class="rank">窗口 ${s.window.start} → ${
      s.openEnded ? '至今' : s.window.end}，共 ${s.days} 天，` +
      `窗口内 ${fmt(w.reviews)} 条评测、版本滚动累计好评率 ${pct(w.rate)}。</span>`);
  }
  return out;
}

/* 两个同游戏版本 → 说差值（谁相对谁变了多少，旧版本作基线）。
   其余多对象 → 说排名（跨对象的绝对量不可比，只排日均与比率）。 */
function multiReadout(ctx) {
  const stats = subjects.map(s => ({ s, w: windowStats(s) }));
  const versions = stats.filter(x => x.s.kind === 'version');
  const sameGame = new Set(subjects.map(s => s.gameId)).size === 1;

  if (stats.length === 2 && versions.length === 2 && sameGame) {
    const [older, newer] = stats.slice()
      .sort((a, b) => a.s.day0 < b.s.day0 ? -1 : 1);
    const parts = [];
    if (older.w.dailyAvg && newer.w.dailyAvg != null) {
      const d = (newer.w.dailyAvg - older.w.dailyAvg) / older.w.dailyAvg * 100;
      parts.push(`日均新增评测 <b>${newer.w.dailyAvg.toFixed(1)}</b> 条，` +
                 `较 ${older.w.dailyAvg.toFixed(1)} 条 ${delta(d, '%')}`);
    }
    if (older.w.rate != null && newer.w.rate != null) {
      parts.push(`版本滚动累计好评率 <b>${newer.w.rate.toFixed(2)}%</b>，` +
                 `较 ${older.w.rate.toFixed(2)}% ${delta(newer.w.rate - older.w.rate, 'pp')}`);
    }
    return [
      `<b>${newer.s.label}</b> 相对 <b>${older.s.label}</b>：${parts.join('，')}。`,
      `<span class="rank">两个窗口分别为 ${older.s.days} 天与 ${newer.s.days} 天；` +
      `版本更新同时带来新玩家涌入与老玩家回流，评测量变化包含两者。</span>`,
    ];
  }

  const rank = (key, fmtv, label) => {
    const rows = stats.filter(x => x.w[key] != null)
      .sort((a, b) => b.w[key] - a.w[key]);
    if (rows.length < 2) return null;
    return `${label}：` + rows.map((x, i) =>
      `<b>${x.s.label}</b> ${fmtv(x.w[key])}`).join(' <span class="rank">></span> ') + '。';
  };

  return [
    rank('dailyAvg', v => v.toFixed(1) + ' 条/日', '窗口内日均新增评测'),
    rank('rate', v => v.toFixed(2) + '%', '窗口好评率'),
    `<span class="rank">窗口长度与回填起点各不相同，<b>绝对量不可直接比</b>，` +
    `上面这两项（日均、比率）才是可比的。</span>`,
  ].filter(Boolean);
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
    const { recent, avgGap } = cadenceOf(gid);
    const gap = avgGap == null ? '—' : avgGap + ' 天';
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

/* 这张表最多会有 10 行 × 5 列、每格三层数字 —— 150 个数字里读者最想知道的
   其实是「最近这次更新怎么样」。把它单独说成一句放在表上面。
   只报声量与口碑两项：它们是本表里口径最硬的两个，玩家结构类指标
   在 7 天窗口上噪声大，适合看表不适合下结论。 */
function versionLead(rows) {
  const latest = rows.slice().sort(
    (a, b) => a.w.date_local < b.w.date_local ? -1 : 1).pop();
  if (!latest) return '';
  const pick = field => latest.w.comparisons.find(c => c.field === field);
  const say = c => {
    if (!c || c.before == null || c.after == null) return null;
    const unit = c.change_kind === 'pp' ? '%' : '';
    const tail = c.change == null ? '<span class="rank">（不可比）</span>'
      : `（${delta(c.change, c.change_kind === 'pp' ? 'pp' : '%')}）`;
    return `${c.label} <span class="rank">${c.before}${unit} →</span> <b>${c.after}${unit}</b>${tail}`;
  };
  const parts = [say(pick('reviews')), say(pick('review_rate'))].filter(Boolean);
  if (!parts.length) return '';
  const who = rows.length > 1 && latest.multi ? `${latest.entry.short_name} ` : '';
  return `最近一次更新是 <b>${who}${latest.w.version_id}</b>（${latest.w.date_local}）。` +
         `更新后 7 天相对更新前 7 天：${parts.join('，')}。`;
}

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
  const lead = document.getElementById('versionLead');

  if (!rows.length) {
    head.innerHTML = '<th>版本</th><th>更新日</th>';
    tb.innerHTML = `<tr><td colspan="8" class="muted">所选对象没有具备完整前后 7 天窗口的版本</td></tr>`;
    lead.innerHTML = '';
    document.getElementById('versionNote').textContent =
      '版本更新会同时带来新玩家涌入与老玩家回流，评测量变化同时包含两者，不能单独归因于内容质量。';
    return;
  }

  lead.innerHTML = versionLead(rows);

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
      (windowed
        ? '版本对象从更新日开始计算第 N 周，只汇总版本窗口内的每日评测；首尾周可能不足 7 天。'
        : '各对象窗口内评测的语言构成，按自然 7 天分桶汇总。') +
      (windowed ? '不同版本按各自的相对周对齐。'
                : '不同对象的回填起点不同，占比反映各自窗口内的结构。');
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
                    <th class="num">${subject.kind === 'version' ? '首尾周变化' : '首尾桶变化'}</th>`;
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
  document.getElementById('langNote').textContent = subject.kind === 'version'
    ? '该版本窗口内全部评测的语言构成；末列为版本第一个相对周与最后一个相对周的占比差。'
    : '回填期内全部评测的语言构成，反映 Steam 版本的实际玩家来源。末列为首个自然 7 天桶与最后一个自然 7 天桶的占比差；' +
      '想看结构随时间怎么变，在「自定义轨道」里打开「评测语种结构变化」轨道。';
}

/* 视频注册表可以保留全量官方投稿，但默认指标只跟随 dashboard.yml
   声明的重点内容范围，避免卡片口径和视频轨道口径不一致。 */
function isImportantVideo(video) {
  const types = config && config.important_video_types;
  return !Array.isArray(types) || types.includes(video.content_type);
}

function importantBiliSummary(snap) {
  const videos = ((snap.bilibili || {}).videos || []).filter(isImportantVideo);
  const totals = { view: 0, like: 0, coin: 0, favorite: 0 };
  let counted = 0;

  videos.forEach(video => {
    const stats = (video.latest || {}).stats;
    if (!stats) return;
    counted++;
    Object.keys(totals).forEach(key => {
      if (stats[key] != null) totals[key] += stats[key];
    });
  });

  const complete = totals.view && [totals.like, totals.coin, totals.favorite]
    .every(value => value != null);
  return {
    videos: counted,
    rates: complete
      ? { engagement: (totals.like + totals.coin + totals.favorite) /
          totals.view * 100 }
      : null,
  };
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
      <div class="height-row" style="margin:-3px 0 ${lane.scales ? 4 : 10}px 10px">
        <span style="font-size:11px;color:${C.muted}">高度</span>
        <input type="range" min="70" max="260" step="10"
               value="${state.height}" data-height="${state.id}">
        <span class="val">${state.height}</span>
      </div>` : ''}
      ${isOn && lane.scales ? `
      <div class="scale-row">
        <span style="font-size:11px;color:${C.muted}">纵轴</span>
        <div class="segmented">
          ${lane.scales.map(sc => `
            <button data-scale="${state.id}" data-scale-id="${sc.id}"
                    title="${sc.hint || ''}"
                    aria-pressed="${(state.scale || defaultScale(lane)) === sc.id}"
              >${sc.label}</button>`).join('')}
        </div>
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

  panel.querySelectorAll('[data-scale]').forEach(btn => {
    btn.onclick = () => {
      const entry = laneState.find(s => s.id === btn.dataset.scale);
      entry.scale = btn.dataset.scaleId;
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
      const k = e.type === 'content'
        ? videoAxisKeyOf({version_confirmed: e.version_confirmed,
                          version_id: e.version_id, pubdate: e.date_local},
                         subjects[0], ctx.axis.align)
        : axisKeyOf(e.date_local, subjects[0], ctx.axis.align);
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
      const push = (platform, locale, videos, idKey) => (videos || [])
        .filter(isImportantVideo).forEach(v => {
      const stats = (v.latest || {}).stats || {};
      const rates = (v.latest || {}).rates || {};
      rows.push({
        subject: s.label, platform, locale,
        id: v[idKey], title: v.title, pubdate: v.pubdate,
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
    push('bilibili', 'zh-cn', (s.snap.bilibili || {}).videos, 'bvid');
    // YouTube 的视频挂在 youtube.locales.<语区>.videos 下，没有 youtube.videos ——
    // 原来这里读的是后者，于是视频明细 CSV 里一条 YouTube 都导不出来，
    // 而文件本身照样生成、照样有 B 站数据，看不出少了东西。
    const locales = (s.snap.youtube || {}).locales || {};
    ((s.snap.youtube || {}).locale_order || Object.keys(locales)).forEach(code =>
      push('youtube', code, (locales[code] || {}).videos, 'video_id'));
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
  // 多对象时来源要合并去重，原来只取 subjects[0] 会把其余对象的来源丢掉
  const seen = new Map();
  subjects.forEach(s => (s.snap.sources || []).forEach(src => {
    if (!seen.has(src.name)) seen.set(src.name, src);
  }));
  document.getElementById('sources').innerHTML =
    [...seen.values()].map(s => `
      <div class="source">
        <span class="tag">${s.label}</span>
        <div class="t">${s.name}</div>
        <div class="d">${s.note}</div>
      </div>`).join('');

  const onlinePts = subjects.map(s =>
    (s.snap.online_series || []).filter(o => o.value != null).length);
  const ramps = subjects.flatMap(s =>
    ((s.snap.bilibili || {}).videos || []).filter(isImportantVideo));
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

  /* 原来这里是连续 400 字、12.5px 灰字的一整段。内容本身是这个项目最有
     价值的部分（把口径讲清楚的看板不多），但那种形式的必然结果是没人读。
     改成：三条最要紧的常驻 + 其余折叠，每条独立成行。 */
  const items = [
    `<b>评测历史是重建的，不是原始记录。</b>由 Steam appreviews 游标翻页回填
     （${covLines}），只含<b>今天仍然存在</b>的评测 —— 被删除或隐藏的不会出现，
     因此越早的日期越可能低估当日真实值。`,
    `<b>Steam 同时在线人数无法回填。</b>SteamDB 不可程序化访问、SteamCharts 未收录该 App，
     只能从开始采集那天往后逐日积累，目前各对象分别有 ${onlinePts.join(' / ')} 个采集点。`,
    `<b>所有事件只表示时间节点，不表示因果关系。</b>版本更新竖线取自 Steam 官方公告，
     构建号来自 SteamCMD 第三方镜像（仅作旁证）。`,
  ];
  const more = [
    `<b>评测者不是玩家的随机样本。</b>玩家结构类指标（时长分布、语种构成）
     全部基于这批评测，反映的是「愿意写评测的人」的结构。`,
    `<b>视频接口只返回当前累计值，没有历史曲线。</b>散点轨道画的是
     「发布日 × 当前累计值」，发布越久累计越高，跨发布时间不可比；
     「发布后播放曲线」只能从开始采集那天往后长，${ramps.length} 支视频中
     ${rampReady} 支覆盖了完整起跑段，其余用虚线标出缺口。`,
    `<b>跨视频比较请优先看互动率。</b>播放量受推荐位影响极大，
     互动率以播放为分母，是截面比值，不受推荐位与频道体量影响。`,
  ];
  if (ctx.multi) {
    more.push(`<b>不同对象的绝对量不可直接相比。</b>窗口长度与回填起点都不同，
      日均与比率才可比。`);
  }

  const li = xs => `<ul>${xs.map(x => `<li>${x}</li>`).join('')}</ul>`;
  document.getElementById('caveat').innerHTML =
    `<b>读这张看板前，有三件事必须知道</b>${li(items)}` +
    `<details class="fine-print"><summary>其余 ${more.length} 条口径限制</summary>` +
    `${li(more)}</details>`;
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
    fail('读不到 ../data/dashboard_config.json',
      '先运行 <code>python pipeline/build_dashboard_config.py</code> 编译轨道配置。' +
      '如果文件确实存在，检查 HTTP 服务是不是从项目根目录启动的。');
    return;
  }

  const idx = await fetch('../data/index.json').then(r => r.json()).catch(() => null);
  catalog = (idx && idx.games) || [];
  if (!catalog.length) {
    fail('没有可用快照',
      '先运行 <code>python collect.py</code> 采集，再运行 ' +
      '<code>python pipeline/build_snapshot.py</code> 生成快照。');
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
    // 并排画出来只会各占横轴的一段，没有可比性。
    // 这是替用户改了他自己设过的控件，必须说一声，否则只会看到对齐莫名其妙变了。
    if (s.kind === 'version' && align === 'calendar' && subjects.length > 1) {
      align = 'day0';
      document.querySelectorAll('#alignSeg button').forEach(b =>
        b.setAttribute('aria-pressed', String(b.dataset.align === 'day0')));
      toast('已切到「各自起点」对齐 —— 两个版本窗口在日历轴上不重叠，' +
            '并排画只会各占横轴的一段。');
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

  // 自定义面板 —— 它是一个模态对话框，就得按模态对话框接线：
  // Esc 关闭、打开时焦点进面板、关闭时焦点还给触发按钮、Tab 不跑出面板。
  const panel = document.getElementById('lanePanel');
  const scrim = document.getElementById('panelScrim');
  const openBtn = document.getElementById('openPanel');
  const panelOpen = () => panel.classList.contains('open');

  const closePanel = () => {
    if (!panelOpen()) return;
    panel.classList.remove('open'); scrim.classList.remove('open');
    openBtn.setAttribute('aria-expanded', 'false');
    openBtn.focus();
    chart.resize();
  };
  openBtn.onclick = () => {
    panel.classList.add('open'); scrim.classList.add('open');
    openBtn.setAttribute('aria-expanded', 'true');
    // 面板关闭时是 visibility:hidden，而 visibility:hidden 的元素不可聚焦。
    // 同一帧里刚加上 .open 就 focus()，样式还没重算完，focus() 会静默失败 ——
    // 等一帧再送焦点。
    requestAnimationFrame(() => {
      const first = panel.querySelector('input, button');
      if (first) first.focus();
    });
  };
  document.getElementById('closePanel').onclick = closePanel;
  scrim.onclick = closePanel;
  document.getElementById('resetLanes').onclick = () => {
    laneState = defaultLaneState();
    presetSel.value = '';
    renderPanel(); renderAll();
  };

  // 焦点陷阱：面板打开时 Tab 在面板内部循环，不会掉到底下那一整页控件上
  panel.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    const items = [...panel.querySelectorAll(
      'input, button, select, [tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.disabled && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // 导出菜单
  const exportMenu = document.getElementById('exportMenu');
  const exportBtn = document.getElementById('openExport');
  const closeExport = () => {
    exportMenu.classList.add('hidden');
    exportBtn.setAttribute('aria-expanded', 'false');
  };
  exportBtn.onclick = e => {
    e.stopPropagation();
    const show = exportMenu.classList.contains('hidden');
    exportMenu.classList.toggle('hidden', !show);
    exportBtn.setAttribute('aria-expanded', String(show));
  };
  exportMenu.onclick = e => e.stopPropagation();
  exportMenu.querySelectorAll('[data-export]').forEach(btn => {
    btn.onclick = () => {
      closeExport();
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
    tbtn.setAttribute('aria-expanded', String(show));
  };

  // ⓘ 就近口径气泡
  document.addEventListener('click', e => {
    const btn = e.target.closest('.info');
    closeInfo();
    closeExport();
    if (!btn) return;
    e.stopPropagation();
    openInfo(btn);
  });

  // 一个 Esc 关掉当前最上面那一层
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (popover) { closeInfo(); return; }
    if (!exportMenu.classList.contains('hidden')) { closeExport(); exportBtn.focus(); return; }
    closePanel();
  });

  try {
    await hydrate(subjects);
  } catch (err) {
    fail(err instanceof LoadError ? err.message : '加载快照时出错',
         err instanceof LoadError ? err.hint : String(err && err.message || err));
    return;
  }
  renderSubjectBar();
  renderPanel();
  renderAll();

  loading.classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  chart.resize();
}

/* ---------- ⓘ 气泡与 toast ---------- */

let popover = null;

function closeInfo() {
  if (popover) { popover.remove(); popover = null; }
}

function openInfo(btn) {
  const info = METRIC_INFO[btn.dataset.info];
  if (!info) return;
  popover = document.createElement('div');
  popover.className = 'popover';
  popover.setAttribute('role', 'tooltip');
  popover.innerHTML = `<b>${info.t}</b>${info.d}`;
  document.body.appendChild(popover);

  // 贴在按钮下方，右侧越界时向左收，永远不出视口
  const r = btn.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const left = Math.min(r.left + window.scrollX,
                        window.scrollX + vw - popover.offsetWidth - 12);
  popover.style.left = Math.max(window.scrollX + 8, left) + 'px';
  popover.style.top = (r.bottom + window.scrollY + 6) + 'px';
}

/* 页面替用户改了某个控件时说一声。原来这类自动行为（加版本对象自动切对齐）
   完全静默，用户只会看到对齐莫名其妙变了。 */
let toastTimer = null;
function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}

boot();
