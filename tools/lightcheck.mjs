/**
 * 光照排查：分别关闭阴影 / 只留平行光 / 只留半球光，比较成像亮度。
 * node tools/lightcheck.mjs
 */
import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const url = process.env.DIORAMA_URL || 'http://127.0.0.1:4175/';

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--hide-scrollbars', '--window-size=1000,640', '--window-position=40,40'],
  defaultViewport: { width: 1000, height: 640, deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', String(e)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 900));

  const rows = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    d.setPaused(true);
    const { renderer, scene, camera } = d;
    const gl = renderer.getContext();
    const lights = [];
    scene.traverse((o) => {
      if (o.isLight) lights.push(o);
    });
    const state = lights.map((l) => ({ intensity: l.intensity, visible: l.visible, castShadow: !!l.castShadow }));
    const dir = lights.find((l) => l.isDirectionalLight);
    const hemi = lights.find((l) => l.isHemisphereLight);

    const measure = () => {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let sum = 0;
      let n = 0;
      let max = 0;
      const hist = new Array(8).fill(0);
      for (let y = 0; y < h * 0.6; y += 2) {
        for (let x = 0; x < w; x += 2) {
          const i = (y * w + x) * 4;
          const l = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255;
          sum += l;
          n += 1;
          if (l > max) max = l;
          hist[Math.min(7, Math.floor(l * 20))] += 1;
        }
      }
      return { mean: +(sum / n).toFixed(4), max: +max.toFixed(3), hist: hist.map((v) => +((v / n) * 100).toFixed(1)) };
    };

    const out = [];
    out.push({ label: '当前设置', ...measure() });

    if (dir) {
      dir.castShadow = false;
      out.push({ label: '关闭阴影', ...measure() });
      dir.castShadow = true;
    }
    if (dir && hemi) {
      hemi.visible = false;
      out.push({ label: '仅平行光', ...measure() });
      hemi.visible = true;
      dir.visible = false;
      out.push({ label: '仅半球光', ...measure() });
      dir.visible = true;
    }
    // 复原
    lights.forEach((l, i) => {
      l.intensity = state[i].intensity;
      l.visible = state[i].visible;
      if (l.isDirectionalLight) l.castShadow = state[i].castShadow;
    });
    return out;
  });

  for (const r of rows) console.log(r.label.padEnd(10), JSON.stringify(r));
} finally {
  await browser.close();
}
