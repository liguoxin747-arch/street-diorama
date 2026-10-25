import puppeteer from 'puppeteer-core';
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--hide-scrollbars', '--window-size=1200,700'],
  defaultViewport: { width: 1200, height: 700 },
});
try {
  const page = await browser.newPage();
  page.on('console', (m) => console.log('[console.' + m.type() + ']', m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', String(e)));
  page.on('requestfailed', (r) => console.log('[reqfail]', r.url(), r.failure()?.errorText));
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 6000));
  console.log('ready =', await page.evaluate(() => window.__dioramaReady));
} finally {
  await browser.close();
}
