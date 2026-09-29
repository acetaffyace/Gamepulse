// 用 Playwright 跑 bench.html：本机无限速一次，再模拟 20 Mbps / 5 Mbps 下载各一次
const { chromium } = require('../node_modules/playwright');
const { spawn } = require('child_process');

const PORT = 8791;
const profiles = [
  { name: 'local', throughput: null },
  { name: '20Mbps', throughput: 20e6 / 8, latency: 40 },
  { name: '5Mbps', throughput: 5e6 / 8, latency: 80 },
];

(async () => {
  const server = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: __dirname, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1200));
  const browser = await chromium.launch();
  try {
    for (const p of profiles) {
      const page = await browser.newPage();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      if (p.throughput) {
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false, latency: p.latency, downloadThroughput: p.throughput, uploadThroughput: p.throughput,
        });
      }
      const started = Date.now();
      await page.goto(`http://127.0.0.1:${PORT}/bench.html`);
      await page.waitForFunction(() => window.__result, null, { timeout: 120000 });
      const result = await page.evaluate(() => window.__result);
      console.log(JSON.stringify({ profile: p.name, wall_ms: Date.now() - started, ...result }, null, 2));
      await page.close();
    }
  } finally {
    await browser.close();
    server.kill();
  }
})();
