import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: false,
  args: [
    '--no-sandbox',
    '--use-angle=default',
    '--ignore-gpu-blocklist',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--window-position=60,60',
    '--window-size=1000,700',
  ],
  defaultViewport: { width: 1000, height: 700 },
});
const page = await browser.newPage();
await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.__dioramaReady === true', { timeout: 60000 });
const out = await page.evaluate(() => {
  const v = window.__dioramaDebug.view;
  const pts = {
    mainHouseDoorAisle: [19.2, 21],
    rightBlock: [15.7, 16.8],
    leftBlockRear: [23.4, 23.8],
    garageInside: [28.0, 20.7],
    frontYard: [22, 15.0],
    oldFrontLine: [22, 11.8],
    sidewalk: [22, 10.5],
  };
  const res = {};
  for (const [k, [x, z]] of Object.entries(pts)) res[k] = v.canStand(x, z);
  const near = v.debugRects().filter((r) => r.x0 < 34 && r.x1 > 10 && r.z0 < 30 && r.z1 > 12);
  return { res, near };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
