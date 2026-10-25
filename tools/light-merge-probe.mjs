/**
 * 近邻灯合并试验：把 3.2m 内的同型点光并成一盏（强度相加），只测量帧时收益。
 * 不改代码、不落盘，用于判断"灯光合并"值不值得做。
 *
 * node tools/light-merge-probe.mjs [--url=...]
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
  args: ['--no-sandbox', '--window-size=1280,720', '--window-position=30,30', '--disable-backgrounding-occluded-windows'],
  defaultViewport: { width: 1280, height: 720 },
});

try {
  const page = await browser.newPage();
  await page.bringToFront();
  await page.goto(`${url}?v=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 180000 });
  await new Promise((r) => setTimeout(r, 6000));

  const out = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    const { renderer, scene } = d;
    const gl = renderer.getContext();
    const px = new Uint8Array(4);
    d.setPaused(true);
    const bench = (fn) => {
      fn();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const t0 = performance.now();
      for (let i = 0; i < 30; i += 1) fn();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return +((performance.now() - t0) / 30).toFixed(2);
    };
    const pts = [];
    scene.traverse((o) => {
      if (o.isPointLight) pts.push(o);
    });
    const res = { total: pts.length };
    res.before = bench(() => d.post.render(0.016));

    const radius2 = 3.2 * 3.2;
    const removed = [];
    const used = new Set();
    for (let i = 0; i < pts.length; i += 1) {
      const a = pts[i];
      if (used.has(a)) continue;
      for (let j = i + 1; j < pts.length; j += 1) {
        const c = pts[j];
        if (used.has(c)) continue;
        if (a.position.distanceToSquared(c.position) < radius2) {
          a.intensity += c.intensity;
          c.visible = false;
          used.add(c);
          removed.push(c);
        }
      }
    }
    res.removed = removed.length;
    res.afterMerge = bench(() => d.post.render(0.016));
    removed.forEach((c) => {
      c.visible = true;
    });
    d.setPaused(false);
    return res;
  });
  console.log('LIGHTMERGE ' + JSON.stringify(out));
} finally {
  await browser.close();
}
