// 截图并检查页面：node tools/screenshot.cjs "?page=versions&game=wuthering_waves" out.png [宽] [高] [light|dark]
// 用 dist/ 里的发布包（先运行 python -m store.build），打印就绪耗时、页面宽度与控制台错误。
const { chromium } = require(process.cwd() + '/node_modules/playwright');
const { spawn } = require('child_process');
(async () => {
  const [,, url, out, w, h, theme] = process.argv;
  const server = spawn('python', ['-m', 'http.server', '8792', '--bind', '127.0.0.1', '-d', 'dist'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1200));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: +w || 1440, height: +h || 900 }, colorScheme: theme || 'light' });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  const t0 = Date.now();
  await page.goto('http://127.0.0.1:8792/' + url);
  await page.waitForSelector('h1', { timeout: 30000 });
  await page.waitForTimeout(1200);
  console.log('ready ms', Date.now() - t0);
  await page.screenshot({ path: out, fullPage: true });
  const docWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  console.log('doc width', docWidth, 'errors', JSON.stringify(errors, null, 1));
  await browser.close(); server.kill();
})();
