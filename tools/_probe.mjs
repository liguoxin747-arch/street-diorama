import { writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const url = process.env.DIORAMA_URL || 'http://127.0.0.1:4175/';
const log = [];
const say = (...a) => { const s = a.join(' '); log.push(s); console.log(s); };

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  protocolTimeout: 30000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--window-size=1200,700'],
  defaultViewport: { width: 1200, height: 700, deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => say('PAGEERROR:', e.stack || String(e)));
  page.on('console', (m) => { if (m.type() === 'error') say('CONSOLE.ERR:', m.text()); });
  page.on('requestfailed', (r) => say('REQFAIL:', r.url(), r.failure()?.errorText));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 8000));
  try {
    const ready = await page.evaluate(() => window.__dioramaReady);
    say('ready =', String(ready));
  } catch (e) {
    say('EVAL FAILED (main thread blocked?):', String(e).slice(0, 200));
  }
} catch (e) {
  say('OUTER ERROR:', String(e).slice(0, 400));
} finally {
  await browser.close().catch(() => {});
  writeFileSync('tools/_probe.log', log.join('\n'), 'utf8');
}
