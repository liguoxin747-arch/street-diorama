/**
 * 色彩管线校验：用纯色不受光材质验证「线性 → sRGB 输出转换」是否发生。
 * 期望：0x808080 输出约 128；若输出约 54，说明没有做 sRGB 编码。
 */
import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const url = process.env.DIORAMA_URL || 'http://127.0.0.1:4175/';

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--window-size=800,600', '--window-position=40,40'],
  defaultViewport: { width: 800, height: 600 },
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', String(e)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 30000 });

  const out = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    d.setPaused(true);
    const { THREE, renderer } = d;
    const gl = renderer.getContext();

    const testScene = new THREE.Scene();
    testScene.background = null;
    const testCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    testCam.position.z = 2;
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ color: 0x808080 }));
    testScene.add(quad);

    const readCenter = () => {
      renderer.setRenderTarget(null);
      renderer.setClearColor(0x000000, 1);
      renderer.render(testScene, testCam);
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const px = new Uint8Array(4);
      gl.readPixels(Math.floor(w / 2), Math.floor(h / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return [px[0], px[1], px[2]];
    };

    const prevTone = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    const plain = readCenter();
    renderer.toneMapping = prevTone;
    const toned = readCenter();

    return {
      outputColorSpace: renderer.outputColorSpace,
      toneMapping: renderer.toneMapping,
      noTone: plain,
      withTone: toned,
      gl: {
        drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
        attrs: gl.getContextAttributes()?.alpha,
      },
    };
  });
  console.log(JSON.stringify(out, null, 2));
} finally {
  await browser.close();
}
