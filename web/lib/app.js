// 应用入口：加载数据、页面路由、网址状态、深浅色、数据状态提示。
// 筛选条件都存在网址里（?page=versions&game=…），复制链接就能把当前视图发给别人。
// 链接不锁定数据版本：打开时显示的是届时最新发布的数据。

import { disposeAll } from './chart.js';
import { LoadError, loadManifest, openStore } from './data.js';
import { el, toast } from './ui.js';

const PAGES = {
  overview: () => import('../pages/overview.js'),
  versions: () => import('../pages/versions.js'),
  videos: () => import('../pages/videos.js'),
  players: () => import('../pages/players.js'),
  explore: () => import('../pages/explore.js'),
  sources: () => import('../pages/sources.js'),
};
const NEW_DATA_CHECK_MS = 10 * 60 * 1000;

const root = document.getElementById('page');
let store = null;

function params() {
  return new URLSearchParams(location.search);
}

function setParams(updates, { push = false } = {}) {
  const next = params();
  for (const [k, v] of Object.entries(updates)) {
    if (v === null || v === undefined || v === '') next.delete(k);
    else next.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const url = `${location.pathname}?${next.toString()}`;
  history[push ? 'pushState' : 'replaceState'](null, '', url);
  render();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.getElementById('theme-toggle').textContent = theme === 'dark' ? '浅色' : '深色';
}

function initialTheme() {
  const saved = localStorage.getItem('gp-theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function statusLine(manifest) {
  const box = document.getElementById('data-status');
  box.replaceChildren();
  const published = new Date(manifest.generated_at);
  const text = `数据发布于 ${published.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}（北京时间）`;
  if (!store) {
    box.append(text);
    return;
  }
  const problems = store.rows("SELECT COUNT(*) AS n FROM v_source_status WHERE status NOT IN ('healthy', 'disabled', 'skipped')")[0].n;
  box.append(el('span', { class: problems ? 'dot warn' : 'dot', 'aria-hidden': 'true' }), text);
  if (problems) box.append(el('a', { href: '?page=sources', style: { marginLeft: '8px' } }, `${problems} 项来源需要注意`));
}

async function render() {
  if (!store) return;
  const page = PAGES[params().get('page')] ? params().get('page') : 'overview';
  for (const a of document.querySelectorAll('.sidebar nav a')) {
    a.toggleAttribute('aria-current', a.dataset.page === page);
    if (a.dataset.page === page) a.setAttribute('aria-current', 'page');
  }
  const module = await PAGES[page]();
  disposeAll();
  root.replaceChildren();
  try {
    module.render({ store, root, params: params(), set: setParams });
    document.title = `${root.querySelector('h1')?.textContent || 'GamePulse'} · GamePulse`;
  } catch (err) {
    console.error(err);
    root.replaceChildren(el('div', { class: 'error' }, `页面出错：${err.message}`));
  }
}

function watchForNewData(manifest) {
  setInterval(async () => {
    try {
      const latest = await loadManifest();
      if (latest.build_id !== manifest.build_id) {
        const banner = document.getElementById('banner');
        banner.replaceChildren('有新发布的数据。',
          el('button', { type: 'button', class: 'primary', style: { marginLeft: '10px' }, onclick: () => location.reload() }, '刷新查看'));
        banner.hidden = false;
      }
    } catch { /* 网络暂时不可用时下次再试 */ }
  }, NEW_DATA_CHECK_MS);
}

async function start() {
  applyTheme(initialTheme());
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('gp-theme', next);
    applyTheme(next);
    render();
  });
  document.getElementById('share').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast('已复制当前视图的链接');
    } catch {
      toast('复制失败，请直接复制地址栏');
    }
  });
  document.querySelector('.sidebar nav').addEventListener('click', event => {
    const link = event.target.closest('a[data-page]');
    if (!link || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    const keep = {};
    for (const k of ['game']) if (params().get(k)) keep[k] = params().get(k);
    history.pushState(null, '', `?${new URLSearchParams({ page: link.dataset.page, ...keep })}`);
    render();
    root.focus();
  });
  window.addEventListener('popstate', render);

  let manifest;
  try {
    manifest = await loadManifest();
    statusLine(manifest);
    const bar = document.getElementById('load-progress');
    store = await openStore(manifest, p => { bar.value = p; });
  } catch (err) {
    console.error(err);
    const message = err instanceof LoadError ? err.message : `加载失败：${err.message}`;
    root.replaceChildren(el('div', { class: 'error' }, message),
      el('button', { type: 'button', onclick: () => location.reload() }, '重新加载'));
    return;
  }
  window.gamepulse = store;   // 方便在浏览器控制台里直接用 gamepulse.rows('SELECT …') 查询
  statusLine(manifest);
  await render();
  watchForNewData(manifest);
}

start();
