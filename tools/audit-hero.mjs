/**
 * 只审计主楼（hero-building）分组：mesh 数 / 三角面 / draw call。
 * node tools/audit-hero.mjs
 */
import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const url = process.env.DIORAMA_URL || 'http://127.0.0.1:4175/';

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--hide-scrollbars', '--window-size=1600,900'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', String(e)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 40000 });
  await new Promise((r) => setTimeout(r, 2000));

  const out = await page.evaluate(() => {
    const { THREE, renderer, scene, camera } = window.__dioramaDebug;
    const hero = scene.getObjectByName('hero-building');
    if (!hero) return { error: 'no hero-building group' };
    let meshes = 0;
    let tris = 0;
    const mats = new Map();
    hero.traverse((o) => {
      if (!o.isMesh) return;
      meshes += 1;
      const t = (o.geometry.index ? o.geometry.index.count : o.geometry.getAttribute('position')?.count ?? 0) / 3;
      tris += t;
      const key = o.material?.name || o.material?.uuid?.slice(0, 6) || '?';
      mats.set(key, (mats.get(key) ?? 0) + 1);
    });
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    return { meshes, tris: Math.round(tris), materials: mats.size, renderTris: renderer.info.render.triangles, calls: renderer.info.render.calls };
  });
  console.log(JSON.stringify(out, null, 2));
} finally {
  await browser.close();
}
