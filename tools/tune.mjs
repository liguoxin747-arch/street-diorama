/**
 * 亮度标定实验：在页面内直接读像素，比较不同曝光/灯光倍率下的成像亮度。
 * node tools/tune.mjs
 */
import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const url = process.env.DIORAMA_URL || 'http://127.0.0.1:4175/';

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--hide-scrollbars', '--window-size=1200,760', '--window-position=40,40'],
  defaultViewport: { width: 1200, height: 760, deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', String(e)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1000));

  const rows = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    d.setPaused(true);
    const { THREE, renderer, scene, camera } = d;
    const gl = renderer.getContext();

    // 收集灯光
    const lights = [];
    scene.traverse((o) => {
      if (o.isLight) lights.push(o);
    });
    const baseIntensity = lights.map((l) => l.intensity);

    const measure = () => {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let sum = 0;
      let max = 0;
      let n = 0;
      let bright = 0;
      // 只统计画面下半部分（模型区域；readPixels 原点在左下）
      for (let y = 0; y < h * 0.62; y += 2) {
        for (let x = 0; x < w; x += 2) {
          const i = (y * w + x) * 4;
          const l = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255;
          sum += l;
          n += 1;
          if (l > max) max = l;
          if (l > 0.35) bright += 1;
        }
      }
      return { mean: +(sum / n).toFixed(4), max: +max.toFixed(3), brightFrac: +(bright / n).toFixed(4) };
    };

    const results = [];
    for (const exposure of [1.32, 2.2, 3.2]) {
      for (const mul of [1, 2, 4]) {
        renderer.toneMappingExposure = exposure;
        lights.forEach((l, i) => {
          l.intensity = baseIntensity[i] * mul;
        });
        results.push({ exposure, mul, ...measure() });
      }
    }
    renderer.toneMappingExposure = 1.32;
    lights.forEach((l, i) => {
      l.intensity = baseIntensity[i];
    });
    return results;
  });

  console.log('exposure  lightMul   mean     max   brightFrac');
  for (const r of rows) {
    console.log(`${String(r.exposure).padEnd(9)} ${String(r.mul).padEnd(9)} ${String(r.mean).padEnd(8)} ${String(r.max).padEnd(5)} ${r.brightFrac}`);
  }
} finally {
  await browser.close();
}
