/**
 * 冷启动探针：把控制台/页面异常原样打出来，并报告 __dioramaReady 何时（或为何）不成立。
 * node tools/_readyprobe.mjs [--timeout=180000]
 */
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const url = flag('url', 'http://127.0.0.1:4175/');
const timeout = Number(flag('timeout', '180000'));
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: [
    '--no-sandbox',
    '--hide-scrollbars',
    '--window-size=1280,720',
    '--window-position=30,30',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  page.on('console', (m) => console.log(`[console.${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => console.log('[pageerror] ' + String(e).slice(0, 800)));
  page.on('requestfailed', (r) => console.log('[requestfailed] ' + r.url()));
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const ready = await page
    .waitForFunction('window.__dioramaReady === true', { timeout, polling: 1000 })
    .then(() => true)
    .catch(() => false);
  console.log(`ready=${ready} 用时=${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const state = await page.evaluate(() => {
    const bar = document.querySelector('.loading, #loading, [class*="loading"]');
    return {
      hasDebug: !!window.__dioramaDebug,
      loaderText: bar ? bar.textContent.trim().slice(0, 120) : null,
    };
  });
  console.log(JSON.stringify(state));
} finally {
  await browser.close();
}
