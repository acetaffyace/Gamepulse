/* 看板视觉自检：用真实浏览器渲染工作台各页面，截图并回收控制台错误。
 *
 * 配置驱动的前端最容易出的问题不是崩溃，而是「某条轨道静默画空」——
 * 页面照样 200、照样好看，只是那条线不见了。因此这里除了截图，
 * 还会把每条启用轨道的系列数据点数量打出来，0 个点会被标成问题。
 *
 * 先在项目根目录启动静态服务：python -m http.server 8771 --bind 127.0.0.1
 *
 * 用法：
 *   node tools/shoot.mjs            六个主页面 × 桌面 1440×900 / 手机 390×844
 *                                   → dashboard/shots/studio-<页面>[-mobile].png
 *   node tools/shoot.mjs --all      另外逐个预设、多游戏 / 同游戏双版本 / 跨游戏版本
 *                                   各截一张（写到系统临时目录，不进仓库）
 *
 * 对比对象全部从 data/index.json 的目录推导（最近两个版本、各游戏最新版本），
 * 不写死任何版本号或游戏名 —— 目录新增或插入版本后脚本照样可用。
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const ROOT = process.env.GAMEPULSE_URL || 'http://127.0.0.1:8771/dashboard/index.html';
const OUT = resolve('dashboard/shots');
const EXTRA_OUT = join(tmpdir(), 'gamepulse-shots');
const PAGES = ['overview', 'versions', 'videos', 'sources', 'players', 'trends'];
const VIEWPORTS = [
  { suffix: '', width: 1440, height: 900, deviceScaleFactor: 1 },
  { suffix: '-mobile', width: 390, height: 844, deviceScaleFactor: 2 },
];
const wantAll = process.argv.includes('--all');

async function open(browser, url, viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
  await page.waitForTimeout(900);
  return { context, page, errors };
}

/* 轨道自检：每条启用轨道的每个系列有多少个非空点；标题里不能出现 undefined。 */
async function inspect(page) {
  return page.evaluate(() => {
    const ctx = buildCtx();
    const lanes = activeLanes().filter(lane => lane.adapter !== 'video_compare').map(lane => {
      const built = ADAPTERS[lane.adapter](lane, ctx);
      return { id: lane.id, note: built.note || '', series: built.series.map(s => ({
        name: s.name, points: s.points ? s.points.length : (s.values || []).filter(v => v != null).length })) };
    }).concat(videoViews.map(view => {
      const rows = VideoModel.prepare(selectedVideoRecords(view, ctx), view);
      return { id: 'video-' + view.id,
        note: view.mode === 'age' ? '发布同龄要求完整日采样；缺失视图是明确空态' : '',
        series: rows.filter(r => r.points.some(p => p.value != null)).map(r => ({
          name: r.source + ' · ' + r.name, points: r.points.filter(p => p.value != null).length })) };
    }));
    const titles = (chart.getOption().title || []).map(t => t.text);
    return {
      subjects: subjects.map(s => `${s.label}[${s.key}]`), align, axis: ctx.axis.keys.length, lanes,
      badTitles: titles.filter(t => /undefined|null/.test(t)),
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
}

function report(label, file, info, errors) {
  console.log(`\n== ${label} ==`);
  console.log(`  对象 ${info.subjects.join(' + ')} · 对齐 ${info.align} · 横轴 ${info.axis} 格`);
  let empty = 0;
  info.badTitles.forEach(t => console.log('  标题渲染异常：' + t));
  if (info.overflow > 0) console.log(`  页面横向溢出 ${info.overflow}px`);
  info.lanes.forEach(l => {
    if (!l.series.length) {
      // 单对象专用轨道在多对象下会主动退让并给出说明，这不算空轨道
      if (!l.note) empty++;
      console.log(`  ${l.id.padEnd(22)} ${(l.note || '无系列  <== 空轨道').slice(0, 52)}`);
      return;
    }
    l.series.forEach(s => {
      if (s.points === 0) empty++;
      console.log(`  ${l.id.padEnd(22)} ${String(s.name).slice(0, 24).padEnd(26)} ${String(s.points).padStart(5)} 点${s.points === 0 ? '  <== 空轨道' : ''}`);
    });
  });
  errors.forEach(e => console.log('  控制台错误：' + e.slice(0, 160)));
  console.log(`  截图 → ${file}`);
  return { empty, errors: errors.length + info.badTitles.length + (info.overflow > 0 ? 1 : 0) };
}

async function shootPage(browser, pageName, viewport) {
  const { context, page, errors } = await open(browser, `${ROOT}?page=${pageName}`, viewport);
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `studio-${pageName}${viewport.suffix}.png`);
  await page.screenshot({ path: file, fullPage: true });
  const result = report(`${pageName} ${viewport.width}×${viewport.height}`, file, await inspect(page), errors);
  await context.close();
  return result;
}

async function shootCase(browser, label, hash, preset) {
  const viewport = VIEWPORTS[0];
  const { context, page, errors } = await open(browser, `${ROOT}?page=explore${hash ? '#' + hash : ''}`, viewport);
  if (preset) {
    if (await page.locator('#studioAdvanced').isHidden()) await page.click('#demoFilters');
    await page.selectOption('#presetSelect', preset);
    await page.waitForTimeout(700);
  }
  mkdirSync(EXTRA_OUT, { recursive: true });
  const file = join(EXTRA_OUT, `${label}.png`);
  await page.screenshot({ path: file, fullPage: true });
  const result = report(label, file, await inspect(page), errors);
  await context.close();
  return result;
}

const browser = await chromium.launch();
const totals = { empty: 0, errors: 0 };
const add = r => { totals.empty += r.empty; totals.errors += r.errors; };
try {
  for (const pageName of PAGES) for (const viewport of VIEWPORTS) add(await shootPage(browser, pageName, viewport));
  if (wantAll) {
    const index = await (await fetch(new URL('../data/index.json', ROOT))).json();
    const config = await (await fetch(new URL('../data/' + (index.config_file || 'dashboard_config.json'), ROOT))).json();
    const catalog = index.games;
    const [first, second] = catalog;
    const recent = first.versions.slice(-2).map(v => `${first.game_id}@${v.key}`);
    const latest = [first, second].filter(Boolean).map(g => `${g.game_id}@${g.versions.at(-1).key}`);
    // 预设 + 三种对比形态：单对象、多游戏、同游戏多版本、跨游戏版本。
    // 引擎合并之后这几种走的是同一条渲染路径，正因如此才必须都测到。
    const presets = Object.keys(config.presets || {}).filter(k => !['compare', 'versions'].includes(k));
    for (const preset of presets) add(await shootCase(browser, `preset-${preset}`, `s=${first.game_id}&a=calendar&r=90`, preset));
    add(await shootCase(browser, 'compare-games', `s=${catalog.map(g => g.game_id).join('|')}&a=calendar&r=90`, 'compare'));
    add(await shootCase(browser, 'compare-versions', `s=${recent.join('|')}&a=day0&r=0`, 'versions'));
    if (latest.length === 2) add(await shootCase(browser, 'compare-cross-game', `s=${latest.join('|')}&a=day0&r=0`, 'versions'));
  }
} finally {
  await browser.close();
}

console.log(`\n合计：空轨道 ${totals.empty} 条，错误（控制台 + 标题 + 横向溢出）${totals.errors} 条`);
process.exit(totals.errors > 0 ? 1 : 0);
