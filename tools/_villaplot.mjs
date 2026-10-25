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
  const d = window.__dioramaDebug;
  const claims = d.occupancy.claims();
  const bad = claims.filter((c) => c.x0 < 34 && c.x1 > 12 && c.z0 < 30 && c.z1 > 11);
  const lamps = [];
  d.scene.traverse((o) => {
    if (/^prop-lamp-/.test(o.name)) lamps.push([o.name, +o.position.x.toFixed(1), +o.position.z.toFixed(1)]);
  });
  const villa = d.scene.getObjectByName('custom-villa');
  return {
    villaPos: villa ? [villa.position.x, villa.position.z] : null,
    claimsNearPlot: bad,
    lamps,
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
