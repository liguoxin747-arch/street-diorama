import puppeteer from 'puppeteer-core';
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=default', '--ignore-gpu-blocklist', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--window-position=60,60', '--window-size=800,450'],
  defaultViewport: { width: 800, height: 450 },
});
const page = await browser.newPage();
await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.__dioramaReady === true', { timeout: 60000 });
const out = await page.evaluate(() => {
  const list = [];
  window.__dioramaDebug.scene.traverse((o) => {
    if (!o.isInstancedMesh) return;
    o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox;
    list.push({
      name: o.name || o.parent?.name || '(unnamed)',
      count: o.count,
      yMax: +bb.max.y.toFixed(1),
      yMin: +bb.min.y.toFixed(1),
    });
  });
  return list.filter((x) => x.yMax > 5.5);
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
