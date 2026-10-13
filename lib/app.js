// 网址保存筛选；内存保存草稿、展开、表格与焦点。只有最新一次渲染可以提交。
import { disposeAll } from './chart.js';
import { loadManifest, openStore } from './data.js';
import { loadChartEngine, loadQueryEngine } from './engines.js';
import { captureView, restoreView } from './view-state.js';
import { el, infoMenu, toast } from './ui.js';

const PAGES = {
  overview: { title: '运营总览', load: retry => import(`../pages/overview.js${retry ? `?retry=${retry}` : ''}`) },
  versions: { title: '版本对比', load: retry => import(`../pages/versions.js${retry ? `?retry=${retry}` : ''}`) },
  videos: { title: '视频传播', load: retry => import(`../pages/videos.js${retry ? `?retry=${retry}` : ''}`) },
  players: { title: '玩家结构', load: retry => import(`../pages/players.js${retry ? `?retry=${retry}` : ''}`) },
  explore: { title: '自助查询', load: retry => import(`../pages/explore.js${retry ? `?retry=${retry}` : ''}`) },
  sources: { title: '数据来源', load: retry => import(`../pages/sources.js${retry ? `?retry=${retry}` : ''}`) },
};
const root = document.getElementById('page');
const states = new Map();
const queries = new Map();
let store;
let displayedKey;
let displayedParams;
let renderId = 0;
let loadingId = 0;
let watcher;
const params = () => new URLSearchParams(location.search);
const pageOf = q => PAGES[q.get('page')] ? q.get('page') : 'overview';
const keyOf = q => `${pageOf(q)}:${q.get('mode') || q.get('comparison') || 'default'}`;
const chartsNeeded = q => pageOf(q) !== 'sources' && !(pageOf(q) === 'explore' && q.get('mode') === 'sql');
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

function setParams(updates, { push = true } = {}) {
  const next = params();
  for (const [k, v] of Object.entries(updates)) {
    if (v === null || v === undefined || v === '') next.delete(k);
    else next.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  history[push ? 'pushState' : 'replaceState'](null, '', `${location.pathname}?${next}`);
  render({ reason: 'filter' });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.getElementById('theme-toggle').textContent = theme === 'dark' ? '浅色' : '深色';
}

function currentScope(q) {
  if (!store) return (q.get('source_game') || q.get('games') || q.get('game') || '').split(',').filter(Boolean);
  if (pageOf(q) === 'versions' && q.get('comparison') === 'multi') {
    const ids = [...new Set((q.get('objects') || '').split(',').map(v => v.slice(0, v.lastIndexOf('@'))))].filter(id => store.gameById[id]);
    if (ids.length) return ids;
  }
  const explicit = q.get('source_game') || q.get('games') || q.get('game');
  if (explicit) {
    const ids = explicit.split(',').filter(id => store.gameById[id]);
    if (ids.length) return ids;
  }
  return ['explore', 'sources'].includes(pageOf(q)) ? [] : [store.games[0].game_id];
}

function statusLine() {
  if (!store) return;
  const box = document.getElementById('data-status');
  const date = new Date(store.manifest.generated_at);
  const full = date.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
  const short = date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' });
  const ids = currentScope(params());
  const problems = store.rows("SELECT COUNT(*) AS n FROM v_source_status WHERE status NOT IN ('healthy', 'disabled', 'skipped')"
    + (ids.length ? ` AND game_id IN (${ids.map(() => '?').join(',')})` : ''), ids)[0].n;
  const href = `?${new URLSearchParams({ page: 'sources', ...(ids.length === 1 ? { source_game: ids[0] } : {}) })}`;
  box.dataset.publishedAt = `${full}（北京时间）`;
  box.replaceChildren(infoMenu(`数据 ${short}`, el('p', {}, `发布 ${full} · 北京时间`),
    el('p', {}, ids.length ? ids.map(id => store.gameById[id].display_name).join('、') : '全部游戏'),
    el('a', { href }, '数据来源')));
  if (problems) box.append(el('a', { class: 'source-link', href },
    el('span', { class: 'dot warn', 'aria-hidden': 'true' }), `${problems} 项异常`));
}

function pendingPage() {
  return el('div', { class: 'page-pending', role: 'status', 'aria-label': '页面加载中' },
    el('span', { class: 'sr-only' }, '载入中'),
    el('div', { class: 'skeleton skeleton-title', 'aria-hidden': 'true' }),
    el('div', { class: 'skeleton skeleton-filter', 'aria-hidden': 'true' }),
    el('div', { class: 'skeleton-grid', 'aria-hidden': 'true' }, Array.from({ length: 3 }, () => el('div', { class: 'skeleton skeleton-tile' }))));
}

function showError(title, err, retry, button = '重试') {
  root.replaceChildren(el('h1', { tabindex: '-1' }, title),
    el('div', { class: 'error-state error', role: 'alert' }, el('strong', {}, '加载失败'),
      el('button', { type: 'button', class: 'primary', onclick: retry }, button),
      el('details', {}, el('summary', {}, '详情'), el('p', {}, err.message))));
  root.removeAttribute('aria-busy');
  root.dataset.ready = 'error';
  document.title = `${title} · GamePulse`;
}

async function render({ reason = 'navigation' } = {}) {
  if (!store) return;
  const id = ++renderId;
  const q = params();
  const page = pageOf(q);
  const key = keyOf(q);
  const samePage = displayedKey === key;
  if (displayedKey && root.dataset.ready === 'true') {
    states.get(displayedKey).ui = captureView(root);
    queries.set(pageOf(displayedParams), displayedParams.toString());
  }
  const state = states.get(key) || {};
  states.set(key, state);
  const previousScroll = samePage || reason === 'history' ? state.ui?.scroll || 0 : 0;
  displayedKey = null;
  disposeAll();
  root.dataset.ready = 'loading';
  root.dataset.page = page;
  root.setAttribute('aria-busy', 'true');
  for (const a of document.querySelectorAll('.sidebar nav a')) {
    if (a.dataset.page === page) { a.setAttribute('aria-current', 'page'); root.dataset.tone = a.dataset.tone; }
    else a.removeAttribute('aria-current');
  }
  root.replaceChildren(pendingPage());
  statusLine();
  try {
    const [module] = await Promise.all([PAGES[page].load(reason === 'retry' ? id : 0), chartsNeeded(q) ? loadChartEngine() : Promise.resolve()]);
    if (id !== renderId) return;
    root.replaceChildren();
    module.render({ store, root, params: q, set: setParams, state });
    const keepFocus = samePage && reason !== 'theme';
    const focusRestored = restoreView(root, state.ui, { focus: keepFocus, components: false });
    await nextFrame();
    if (id !== renderId) return;
    restoreView(root, state.ui, { focus: keepFocus && !focusRestored });
    root.dataset.ready = 'true';
    root.removeAttribute('aria-busy');
    displayedKey = key;
    displayedParams = q;
    queries.set(page, q.toString());
    document.title = `${PAGES[page].title} · GamePulse`;
    window.scrollTo({ top: previousScroll, behavior: 'instant' });
    if (reason === 'navigation' || reason === 'history') root.querySelector('h1')?.focus({ preventScroll: true });
    document.getElementById('view-status').textContent = `${PAGES[page].title}已更新`;
  } catch (err) {
    if (id !== renderId) return;
    showError(PAGES[page].title, err, () => render({ reason: 'retry' }));
  }
}

function navigate(page) {
  queries.set(pageOf(params()), params().toString());
  const scope = currentScope(params());
  const next = new URLSearchParams(queries.get(page) || '');
  const oldScope = next.get('source_game') || next.get('games') || next.get('game') || '';
  next.set('page', page);
  if (scope.length) {
    for (const key of ['game', 'games', 'source_game']) next.delete(key);
    if (page === 'explore' && scope.length > 1) next.set('games', scope.join(','));
    else next.set(page === 'sources' ? 'source_game' : 'game', scope[0]);
    if (oldScope !== scope.join(',')) {
      for (const key of ['a', 'b', 'version', 'pair', 'player_versions', 'curve_ids', 'objects', 'versions']) next.delete(key);
    }
  }
  history.pushState(null, '', `${location.pathname}?${next}`);
  if (store) render({ reason: 'navigation' });
  else {
    for (const a of document.querySelectorAll('.sidebar nav a')) {
      if (a.dataset.page === page) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    document.title = `${PAGES[page].title} · GamePulse`;
  }
}

function watchForNewData(manifest) {
  clearInterval(watcher);
  watcher = setInterval(async () => {
    try {
      const latest = await loadManifest();
      if (latest.build_id !== manifest.build_id) {
        const banner = document.getElementById('banner');
        banner.replaceChildren('数据已更新', el('button', { type: 'button', class: 'primary', onclick: () => location.reload() }, '刷新'));
        banner.hidden = false;
      }
    } catch { /* 保留已加载的数据，下一次再检查。 */ }
  }, 10 * 60 * 1000);
}

async function loadData() {
  const id = ++loadingId;
  ++renderId;
  root.dataset.ready = 'loading';
  root.setAttribute('aria-busy', 'true');
  const bar = el('progress', { max: 1, value: 0, 'aria-label': '数据下载' });
  const label = el('p', {}, '下载中');
  root.replaceChildren(el('div', { class: 'loading', role: 'status' }, label, bar));
  document.getElementById('data-status').textContent = '载入中';
  let storeReady;
  try {
    const engineReady = loadQueryEngine();
    engineReady.catch(() => {});
    const graphReady = chartsNeeded(params()) ? loadChartEngine() : Promise.resolve();
    graphReady.catch(() => {});
    storeReady = loadManifest().then(manifest => openStore(manifest, p => {
      bar.value = p; if (p === 1) label.textContent = '初始化';
    }, { engineReady }));
    const opened = await storeReady;
    if (id !== loadingId) { opened.db.close(); return; }
    store = opened;
    window.gamepulse = store;
    statusLine();
    await render();
    watchForNewData(store.manifest);
  } catch (err) {
    storeReady?.then(opened => { if (opened !== store) opened.db.close(); }).catch(() => {});
    if (id !== loadingId) return;
    showError('数据加载', err, loadData, '重新加载');
    document.getElementById('data-status').textContent = '加载失败';
  }
}

const saved = localStorage.getItem('gp-theme');
applyTheme(saved === 'light' || saved === 'dark' ? saved : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
history.scrollRestoration = 'manual';
document.getElementById('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('gp-theme', next); applyTheme(next); render({ reason: 'theme' });
});
document.getElementById('share').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(location.href); toast('链接已复制'); }
  catch { toast('复制失败，请复制地址栏'); }
});
document.querySelector('.sidebar nav').addEventListener('click', event => {
  const link = event.target.closest('a[data-page]');
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); navigate(link.dataset.page);
});
window.addEventListener('popstate', () => render({ reason: 'history' }));
function followLink(event) {
  const link = event.target.closest('a[href]');
  if (!link || !store || link.target || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const url = new URL(link.href);
  if (url.origin !== location.origin || url.pathname !== location.pathname || !PAGES[url.searchParams.get('page')]) return;
  event.preventDefault();
  history.pushState(null, '', `${url.pathname}${url.search}`);
  render({ reason: 'navigation' });
}
root.addEventListener('click', followLink);
document.getElementById('data-status').addEventListener('click', followLink);
loadData();
