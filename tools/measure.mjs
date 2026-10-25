/**
 * 单次成像测量：用当前代码里的实际光照/曝光直接读像素，输出画面亮度统计。
 * node tools/measure.mjs
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
  await new Promise((r) => setTimeout(r, 900));

  const stats = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    d.setPaused(true);
    const { renderer, scene, camera } = d;
    const gl = renderer.getContext();
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

    const buckets = new Array(10).fill(0);
    let sum = 0;
    let max = 0;
    let n = 0;
    // 画面下半部分（模型主体，readPixels 原点左下）
    for (let y = 0; y < h * 0.62; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 4;
        const l = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255;
        sum += l;
        n += 1;
        if (l > max) max = l;
        buckets[Math.min(9, Math.floor(l * 10))] += 1;
      }
    }
    const hist = buckets.map((b) => +((b / n) * 100).toFixed(1));
    return {
      exposure: renderer.toneMappingExposure,
      mean: +(sum / n).toFixed(4),
      max: +max.toFixed(3),
      hist,
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    };
  });
  console.log(JSON.stringify(stats, null, 2));
} finally {
  await browser.close();
}
