/* 看板视觉自检：用真实浏览器渲染页面，截图并回收控制台错误。
 *
 * 配置驱动的前端最容易出的问题不是崩溃，而是「某条轨道静默画空」——
 * 页面照样 200、照样好看，只是那条线不见了。因此这里除了截图，
 * 还会把每条启用轨道的系列数据点数量打出来，0 个点会被标成问题。
 *
 * 用法：
 *   node tools/shoot.mjs                       默认视图
 *   node tools/shoot.mjs --preset player_profile
 *   node tools/shoot.mjs --all                 逐个预设各截一张
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.GAMEPULSE_URL || 'http://127.0.0.1:8771/dashboard/index.html';
const OUT = resolve('dashboard/shots');

const args = process.argv.slice(2);
const wantAll = args.includes('--all');
const presetArg = args.includes('--preset') ? args[args.indexOf('--preset') + 1] : null;
const subjectsArg = args.includes('--subjects') ? args[args.indexOf('--subjects') + 1] : null;
const alignArg = args.includes('--align') ? args[args.indexOf('--align') + 1] : null;

async function shoot(browser, preset, label, subjectKeys = subjectsArg,
                     alignMode = alignArg) {
  const page = await browser.newPage({
    viewport: { width: 1520, height: 1400 },
    deviceScaleFactor: 2,
  });

  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  // 对比对象放在 URL hash 里，与页面自己的分享链接同一套格式，
  // 因此这里测的就是用户真正会打开的那个视图。
  const url = subjectKeys
    ? `${BASE}#s=${subjectKeys}&a=${alignMode || 'day0'}&r=0`
    : BASE;
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#app:not(.hidden)', { timeout: 15000 });

  if (preset) {
    await page.selectOption('#presetSelect', preset);
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(600);

  // 轨道自检：每条启用轨道的每个系列有多少个非空点
  const lanes = await page.evaluate(() => {
    const ctx = buildCtx();
    return activeLanes().map(lane => {
      const built = ADAPTERS[lane.adapter](lane, ctx);
      return {
        id: lane.id,
        height: lane.height,
        note: built.note || '',
        series: built.series.map(s => ({
          name: s.name,
          points: s.points ? s.points.length
                           : (s.values || []).filter(v => v != null).length,
        })),
      };
    });
  });

  const subjectInfo = await page.evaluate(() => ({
    keys: subjects.map(s => `${s.label}[${s.key}]`),
    align,
    axis: buildCtx().axis.keys.length,
  }));

  // 轨道标题是用 rich text 拼的，取数对象的字段名写错不会报错，
  // 只会渲染出「undefined 每日…」这种标题。曾经因为改了 laneTitle 的签名
  // 而没同步 compare.js 的调用方，对比视图的第一条轨道标题就变成了 undefined。
  const titles = await page.evaluate(() => chart.getOption().title.map(t => t.text));
  const badTitles = titles.filter(t => /undefined|null/.test(t));

  mkdirSync(OUT, { recursive: true });
  const file = `${OUT}/${label}.png`;
  await page.screenshot({ path: file, fullPage: true });

  console.log(`\n== ${label} ==`);
  console.log(`  对象 ${subjectInfo.keys.join(' + ')}`);
  console.log(`  对齐 ${subjectInfo.align} · 横轴 ${subjectInfo.axis} 格`);
  let empty = 0;
  if (badTitles.length) {
    console.log('  标题渲染异常：');
    badTitles.forEach(t => console.log('    ' + t));
  }
  lanes.forEach(l => {
    if (!l.series.length) {
      // 单对象专用轨道在多对象下会主动退让并给出说明，这不算空轨道
      console.log(`  ${l.id.padEnd(20)} ${(l.note || '无系列').slice(0, 52)}`);
      if (!l.note) empty++;
      return;
    }
    l.series.forEach(s => {
      const flag = s.points === 0 ? '  <== 空轨道' : '';
      if (s.points === 0) empty++;
      console.log(`  ${l.id.padEnd(20)} ${String(s.name).slice(0, 22).padEnd(24)} ${String(s.points).padStart(5)} 点${flag}`);
    });
  });
  if (errors.length) {
    console.log('  控制台错误：');
    errors.forEach(e => console.log('    ' + e.slice(0, 160)));
  }
  console.log(`  截图 → ${file}`);

  await page.close();
  return { empty, errors: errors.length + badTitles.length };
}

const browser = await chromium.launch();
let totals = { empty: 0, errors: 0 };
try {
  if (wantAll) {
    // 既跑各个预设，也跑三种对比形态 —— 单对象、多游戏、同游戏多版本。
    // 引擎合并之后这三者走的是同一条渲染路径，正因如此才必须都测到：
    // 一个只在「多对象」下才触发的分支，在单对象截图里是看不出来的。
    const cases = [
      ['', 'default', null, null],
      ['player_profile', 'player_profile', null, null],
      ['propagation', 'propagation', null, null],
      ['online_focus', 'online_focus', null, null],
      ['compare', 'compare_games', 'wuthering_waves|zenless_zone_zero|neverness_to_everness', 'calendar'],
      ['versions', 'compare_versions', 'wuthering_waves@2026-07-10|wuthering_waves@2026-08-20', 'day0'],
      ['versions', 'compare_cross_game', 'wuthering_waves@2026-08-20|zenless_zone_zero@2026-09-09', 'day0'],
    ];
    for (const [p, label, subs, al] of cases) {
      const r = await shoot(browser, p || null, label, subs, al);
      totals.empty += r.empty; totals.errors += r.errors;
    }
  } else {
    const r = await shoot(browser, presetArg || null, presetArg || 'default');
    totals = r;
  }
} finally {
  await browser.close();
}

console.log(`\n合计：空轨道 ${totals.empty} 条，错误（控制台 + 标题）${totals.errors} 条`);
process.exit(totals.errors > 0 ? 1 : 0);
