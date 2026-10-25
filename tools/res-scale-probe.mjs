/**
 * 渲染分辨率缩放收益：确认"填充受限"场景下降低内部像素比能换回多少帧。
 * node tools/res-scale-probe.mjs [--url=...]
 */
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const url = flag('url', process.env.DIORAMA_URL || 'http://127.0.0.1:4187/');
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  protocolTimeout: 900000,
  args: ['--no-sandbox', '--window-size=1600,900', '--window-position=30,30', '--disable-backgrounding-occluded-windows'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
});

try {
  const page = await browser.newPage();
  await page.bringToFront();
  await page.goto(`${url}?v=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 180000 });
  await new Promise((r) => setTimeout(r, 6000));

  const out = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    const { renderer } = d;
    const gl = renderer.getContext();
    const px = new Uint8Array(4);
    d.setPaused(true);
    const bench = (fn) => {
      fn();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const t0 = performance.now();
      for (let i = 0; i < 25; i += 1) fn();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return +((performance.now() - t0) / 25).toFixed(2);
    };
    const w = window.innerWidth;
    const h = window.innerHeight;
    const res = {};
    for (const scale of [1, 0.85, 0.7, 0.6]) {
      renderer.setPixelRatio(scale);
      d.post.setSize(w, h);
      res[`scale_${scale}`] = bench(() => d.post.render(0.016));
    }
    renderer.setPixelRatio(1);
    d.post.setSize(w, h);
    d.setPaused(false);
    return res;
  });
  console.log('RESSCALE ' + JSON.stringify(out));
} finally {
  await browser.close();
}
