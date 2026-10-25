/** 临时探针：在指定机位向屏幕像素发射线，报告命中的网格与父链（定位画面里的异物） */
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
    '--window-size=1600,900',
  ],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.__dioramaReady === true', { timeout: 120000 });
const points = process.argv.slice(2).map((s) => s.split(',').map(Number));
const rows = await page.evaluate((pts) => {
  const d = window.__dioramaDebug;
  const THREE = d.THREE;
  window.__setView(4, 55, 46, 79, 0, -46);
  d.camera.updateMatrixWorld(true);
  d.camera.updateProjectionMatrix();
  const ray = new THREE.Raycaster();
  const out = [];
  for (const [px, py] of pts) {
    const ndc = new THREE.Vector2((px / 1600) * 2 - 1, -(py / 900) * 2 + 1);
    ray.setFromCamera(ndc, d.camera);
    const hits = ray.intersectObjects(d.scene.children, true).slice(0, 3);
    out.push({
      px,
      py,
      hits: hits.map((h) => {
        const chain = [];
        let o = h.object;
        for (let i = 0; i < 4 && o; i += 1) {
          chain.push(o.name || o.type);
          o = o.parent;
        }
        const m = h.object.material;
        return {
          chain: chain.join(' < '),
          col: m && m.color ? `#${m.color.getHexString()}` : '?',
          point: [h.point.x, h.point.y, h.point.z].map((n) => +n.toFixed(2)),
          matType: m ? m.type : '?',
        };
      }),
    });
  }
  return out;
}, points);
console.log(JSON.stringify(rows, null, 1));
await browser.close();
