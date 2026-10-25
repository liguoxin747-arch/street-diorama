/**
 * 打印场景主要网格的世界包围盒，用于排查"谁挡在前面 / 尺寸是否离谱"。
 * node tools/bbox.mjs
 */
import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const url = process.env.DIORAMA_URL || 'http://127.0.0.1:4175/';

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--window-size=900,600', '--window-position=40,40'],
  defaultViewport: { width: 900, height: 600 },
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', String(e)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 30000 });

  const out = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    d.setPaused(true);
    const { THREE, scene } = d;
    const rows = [];
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      const hex = mat?.color ? `#${mat.color.getHexString()}` : '-';
      const box = new THREE.Box3().setFromObject(o);
      const size = box.getSize(new THREE.Vector3());
      rows.push({
        name: o.name || o.geometry.type,
        color: hex,
        type: mat?.type,
        min: box.min.toArray().map((v) => +v.toFixed(2)),
        max: box.max.toArray().map((v) => +v.toFixed(2)),
        size: size.toArray().map((v) => +v.toFixed(2)),
        tris: (o.geometry.index ? o.geometry.index.count : o.geometry.getAttribute('position')?.count ?? 0) / 3,
      });
    });
    rows.sort((a, b) => b.size[0] * b.size[1] * b.size[2] - a.size[0] * a.size[1] * a.size[2]);
    return rows.slice(0, 12);
  });
  out.forEach((r) => console.log(`${r.type.padEnd(18)} ${r.color.padEnd(9)} ${r.name.padEnd(14)} size=${JSON.stringify(r.size)} min=${JSON.stringify(r.min)} max=${JSON.stringify(r.max)}`));
} finally {
  await browser.close();
}
