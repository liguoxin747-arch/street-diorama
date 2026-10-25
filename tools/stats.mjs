/**
 * 模型区域统计：先用白色覆盖材质求出"模型遮罩"，再用真实材质统计遮罩内亮度。
 * 这样可以把背景渐变从统计里剔除，得到真实的受光水平。
 * node tools/stats.mjs
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

  const res = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    d.setPaused(true);
    const { THREE, renderer, scene, camera } = d;
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;

    const grab = () => {
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };

    const bg = scene.background;
    scene.background = null;
    renderer.setClearColor(0x000000, 1);

    // 1) 白色遮罩
    scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    const maskPx = grab();
    scene.overrideMaterial = null;

    // 2) 真实材质
    renderer.render(scene, camera);
    const realPx = grab();

    let n = 0;
    let sum = 0;
    let max = 0;
    const hist = new Array(10).fill(0);
    let warm = 0;
    const gridCols = 48;
    const gridRows = 22;
    const grid = new Float64Array(gridCols * gridRows);
    const gridCount = new Float64Array(gridCols * gridRows);
    for (let i = 0; i < w * h; i += 1) {
      const o = i * 4;
      const m = maskPx[o];
      const x = i % w;
      const y = Math.floor(i / w);
      const gx = Math.min(gridCols - 1, Math.floor((x / w) * gridCols));
      // readPixels 原点左下：翻转成"上到下"
      const gy = Math.min(gridRows - 1, Math.floor((1 - y / h) * gridRows));
      if (m < 120) continue;
      n += 1;
      const r = realPx[o];
      const g = realPx[o + 1];
      const b = realPx[o + 2];
      const l = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
      sum += l;
      if (l > max) max = l;
      hist[Math.min(9, Math.floor(l * 10))] += 1;
      if (r > b * 1.2 && l > 0.15) warm += 1;
      grid[gy * gridCols + gx] += l;
      gridCount[gy * gridCols + gx] += 1;
    }

    const ramp = ' .:-=+*#%@';
    const lines = [];
    for (let ry = 0; ry < gridRows; ry += 1) {
      let line = '';
      for (let rx = 0; rx < gridCols; rx += 1) {
        const idx = ry * gridCols + rx;
        const c = gridCount[idx] ?? 0;
        if (!c) {
          line += ' ';
          continue;
        }
        const v = Math.min(1, (grid[idx] ?? 0) / c / 0.45);
        line += ramp[Math.min(ramp.length - 1, Math.floor(v * (ramp.length - 1)))];
      }
      lines.push(line);
    }

    scene.background = bg;
    return {
      maskPixels: n,
      maskFrac: +(n / (w * h)).toFixed(3),
      meanLum: +(sum / n).toFixed(4),
      maxLum: +max.toFixed(3),
      warmFrac: +(warm / n).toFixed(4),
      histPct: hist.map((v) => +((v / n) * 100).toFixed(1)),
      exposure: renderer.toneMappingExposure,
      grid: lines,
    };
  });
  console.log(JSON.stringify(res, null, 2));
} finally {
  await browser.close();
}
