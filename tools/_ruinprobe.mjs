/** 临时探针：列出空地范围内体积最大的网格，定位"浅灰大白板"来源 */
import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--use-angle=default',
    '--ignore-gpu-blocklist',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--window-size=800,600',
  ],
  defaultViewport: { width: 800, height: 600 },
});
const page = await browser.newPage();
await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.__dioramaReady === true', { timeout: 120000 });
const rows = await page.evaluate(() => {
  const d = window.__dioramaDebug;
  d.scene.updateMatrixWorld(true);
  const box = new d.THREE.Box3();
  const v = new d.THREE.Vector3();
  const out = [];
  d.scene.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh) return;
    box.setFromObject(o);
    const c = box.getCenter(v);
    if (c.x < 62 || c.x > 96 || c.z < -78 || c.z > -28) return;
    const m = o.material;
    const col = m && m.color ? `#${m.color.getHexString()}` : '?';
    out.push({
      name: o.name || '(anon)',
      parent: o.parent ? o.parent.name : '',
      col,
      size: [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z].map((n) => +n.toFixed(2)),
      center: [c.x, c.y, c.z].map((n) => +n.toFixed(1)),
    });
  });
  return out.sort((a, b) => b.size[0] * b.size[2] - a.size[0] * a.size[2]).slice(0, 36);
});
console.log(JSON.stringify(rows, null, 1));
await browser.close();
