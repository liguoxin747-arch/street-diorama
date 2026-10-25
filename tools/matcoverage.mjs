/**
 * 按材质统计画面占比与亮度：找出"到底是谁把画面压黑了"。
 * node tools/matcoverage.mjs
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
  await new Promise((r) => setTimeout(r, 800));

  const out = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    d.setPaused(true);
    const { renderer, scene, camera } = d;
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;

    const meshes = [];
    scene.traverse((o) => {
      if (o.isMesh) meshes.push(o);
    });

    const bg = scene.background;
    scene.background = null;
    renderer.setClearColor(0x000000, 1);

    const grab = () => {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };

    const hidden = [];
    meshes.forEach((m) => {
      if (m.visible) {
        hidden.push(m);
        m.visible = false;
      }
    });

    const byMat = new Map();
    meshes.forEach((m) => {
      const mat = Array.isArray(m.material) ? m.material[0] : m.material;
      if (!mat) return;
      const key = mat.uuid;
      if (!byMat.has(key)) byMat.set(key, { mat, list: [] });
      byMat.get(key).list.push(m);
    });

    const rows = [];
    byMat.forEach(({ mat, list }) => {
      list.forEach((m) => {
        m.visible = true;
      });
      const px = grab();
      list.forEach((m) => {
        m.visible = false;
      });
      let n = 0;
      let sum = 0;
      for (let i = 0; i < w * h; i += 1) {
        const o = i * 4;
        if (px[o] + px[o + 1] + px[o + 2] === 0) continue;
        const l = (px[o] * 0.299 + px[o + 1] * 0.587 + px[o + 2] * 0.114) / 255;
        n += 1;
        sum += l;
      }
      rows.push({
        type: mat.type,
        color: mat.color ? `#${mat.color.getHexString()}` : '-',
        meshes: list.length,
        pxPct: +((n / (w * h)) * 100).toFixed(2),
        meanLum: +(sum / Math.max(n, 1)).toFixed(4),
      });
    });

    hidden.forEach((m) => {
      m.visible = true;
    });
    scene.background = bg;

    rows.sort((a, b) => b.pxPct - a.pxPct);
    return rows.slice(0, 24);
  });

  console.log('type                 color     meshes  px%    meanLum');
  for (const r of out) {
    console.log(`${r.type.padEnd(20)} ${String(r.color).padEnd(9)} ${String(r.meshes).padEnd(7)} ${String(r.pxPct).padEnd(6)} ${r.meanLum}`);
  }
} finally {
  await browser.close();
}
