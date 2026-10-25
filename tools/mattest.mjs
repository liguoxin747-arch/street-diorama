/**
 * 材质/光照对照实验：用同一种白色材质替换全场景，比较 Basic / Lambert / Toon 的成像亮度，
 * 判断"太暗"是光照不足、卡通渐变贴图异常，还是固有色过深。
 * node tools/mattest.mjs
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

    const renderAndMeasure = () => {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let n = 0;
      let sum = 0;
      let max = 0;
      for (let i = 0; i < w * h; i += 1) {
        const o = i * 4;
        // 只在画面中部取样，避开背景与贴边区域
        const x = i % w;
        const y = Math.floor(i / w);
        if (x < w * 0.15 || x > w * 0.85 || y < h * 0.12 || y > h * 0.55) continue;
        const l = (px[o] * 0.299 + px[o + 1] * 0.587 + px[o + 2] * 0.114) / 255;
        if (l < 0.02) continue; // 跳过背景/空洞
        n += 1;
        sum += l;
        if (l > max) max = l;
      }
      return { n, mean: +(sum / Math.max(n, 1)).toFixed(4), max: +max.toFixed(3) };
    };

    const bg = scene.background;
    scene.background = null;
    renderer.setClearColor(0x000000, 1);

    const results = [];
    const gradient = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255, 200, 200, 200, 255, 255, 255, 255, 255]), 3, 1, THREE.RGBAFormat);
    gradient.minFilter = THREE.NearestFilter;
    gradient.magFilter = THREE.NearestFilter;
    gradient.needsUpdate = true;

    const tests = [
      ['basic-white', new THREE.MeshBasicMaterial({ color: 0xffffff })],
      ['lambert-white', new THREE.MeshLambertMaterial({ color: 0xffffff })],
      ['toon-white-nograd', new THREE.MeshToonMaterial({ color: 0xffffff })],
      ['toon-white-grad', new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: gradient })],
      ['toon-grey0x3b414b', new THREE.MeshToonMaterial({ color: 0x3b414b })],
    ];
    for (const [label, mat] of tests) {
      scene.overrideMaterial = mat;
      results.push({ label, ...renderAndMeasure() });
      mat.dispose();
    }
    scene.overrideMaterial = null;
    scene.background = bg;

    return {
      exposure: renderer.toneMappingExposure,
      results,
    };
  });
  console.log(JSON.stringify(out, null, 2));
} finally {
  await browser.close();
}
