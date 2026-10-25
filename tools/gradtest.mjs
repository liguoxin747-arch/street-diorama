/**
 * 检查场景中真实使用的 toon 材质与渐变贴图，并测试替换渐变贴图后的亮度变化。
 * node tools/gradtest.mjs
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
    const { THREE, renderer, scene, camera } = d;
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;

    const measure = () => {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let n = 0;
      let sum = 0;
      let max = 0;
      for (let i = 0; i < w * h; i += 1) {
        const x = i % w;
        const y = Math.floor(i / w);
        if (x < w * 0.15 || x > w * 0.85 || y < h * 0.12 || y > h * 0.55) continue;
        const o = i * 4;
        const l = (px[o] * 0.299 + px[o + 1] * 0.587 + px[o + 2] * 0.114) / 255;
        if (l < 0.02) continue;
        n += 1;
        sum += l;
        if (l > max) max = l;
      }
      return { n, mean: +(sum / Math.max(n, 1)).toFixed(4), max: +max.toFixed(3) };
    };

    const toonMats = new Map();
    const types = {};
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        types[m.type] = (types[m.type] ?? 0) + 1;
        if (m.isMeshToonMaterial && !toonMats.has(m.uuid)) toonMats.set(m.uuid, m);
      });
    });

    const sample = [...toonMats.values()][0];
    const grad = sample?.gradientMap;
    const gradInfo = grad
      ? {
          type: grad.type,
          w: grad.image?.width,
          h: grad.image?.height,
          data: grad.image?.data ? Array.from(grad.image.data).slice(0, 12) : null,
          colorSpace: grad.colorSpace,
          minFilter: grad.minFilter,
          magFilter: grad.magFilter,
          flipY: grad.flipY,
          unpackAlignment: grad.unpackAlignment,
        }
      : null;

    const before = measure();

    // 用一个全新的渐变贴图替换所有 toon 材质的渐变贴图
    const fresh = new THREE.DataTexture(new Uint8Array([120, 120, 120, 255, 190, 190, 190, 255, 255, 255, 255, 255]), 3, 1, THREE.RGBAFormat);
    fresh.minFilter = THREE.NearestFilter;
    fresh.magFilter = THREE.NearestFilter;
    fresh.needsUpdate = true;
    toonMats.forEach((m) => {
      m.gradientMap = fresh;
      m.needsUpdate = true;
    });
    const after = measure();

    // 把所有 toon 材质固有色改成白色，看看上限
    toonMats.forEach((m) => {
      m.color.set(0xffffff);
    });
    const white = measure();

    return {
      materialTypes: types,
      toonMaterialCount: toonMats.size,
      gradInfo,
      before,
      afterGradientSwap: after,
      afterWhiteColor: white,
    };
  });
  console.log(JSON.stringify(out, null, 2));
} finally {
  await browser.close();
}
