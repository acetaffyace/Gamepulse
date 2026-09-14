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
const presetArg = args[args.indexOf('--preset') + 1];

async function shoot(browser, preset, label) {
  const page = await browser.newPage({
    viewport: { width: 1520, height: 1400 },
    deviceScaleFactor: 2,
  });

  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#app:not(.hidden)', { timeout: 15000 });

  if (preset) {
    await page.selectOption('#presetSelect', preset);
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(600);

  // 轨道自检：每条启用轨道的每个系列有多少个非空点
  const lanes = await page.evaluate(() => {
    const axisFull = buildAxis(snapshot);
    const { from, to } = slice(axisFull);
    const axis = axisFull.slice(from, to + 1);
    return activeLanes().map(lane => {
      const built = ADAPTERS[lane.adapter](lane, snapshot, axis);
      return {
        id: lane.id,
        height: lane.height,
        series: built.series.map(s => ({
          name: s.name,
          points: s.points ? s.points.length
                           : (s.values || []).filter(v => v != null).length,
        })),
      };
    });
  });

  mkdirSync(OUT, { recursive: true });
  const file = `${OUT}/${label}.png`;
  await page.screenshot({ path: file, fullPage: true });

  console.log(`\n== ${label} ==`);
  let empty = 0;
  lanes.forEach(l => {
    l.series.forEach(s => {
      const flag = s.points === 0 ? '  <== 空轨道' : '';
      if (s.points === 0) empty++;
      console.log(`  ${l.id.padEnd(20)} ${s.name.padEnd(18)} ${String(s.points).padStart(5)} 点${flag}`);
    });
  });
  if (errors.length) {
    console.log('  控制台错误：');
    errors.forEach(e => console.log('    ' + e.slice(0, 160)));
  }
  console.log(`  截图 → ${file}`);

  await page.close();
  return { empty, errors: errors.length };
}

const browser = await chromium.launch();
let totals = { empty: 0, errors: 0 };
try {
  if (wantAll) {
    const presets = ['', 'player_profile', 'propagation', 'online_focus'];
    for (const p of presets) {
      const r = await shoot(browser, p || null, p || 'default');
      totals.empty += r.empty; totals.errors += r.errors;
    }
  } else {
    const r = await shoot(browser, presetArg || null, presetArg || 'default');
    totals = r;
  }
} finally {
  await browser.close();
}

console.log(`\n合计：空轨道 ${totals.empty} 条，控制台错误 ${totals.errors} 条`);
process.exit(totals.errors > 0 ? 1 : 0);
