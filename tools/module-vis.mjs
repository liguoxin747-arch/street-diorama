/**
 * 模块可见度审计：逐个隐藏 root/fx 下的子组，统计它在一块画面里"实际占了多少像素"，
 * 用来确认没有哪个模块被别的东西完全挡住（也就是"做了但看不见"）。
 * node tools/module-vis.mjs
 */
import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const url = process.env.DIORAMA_URL || 'http://127.0.0.1:4175/';

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--hide-scrollbars', '--window-size=1280,760', '--window-position=30,30'],
  defaultViewport: { width: 1280, height: 760, deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', String(e)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2000));

  const rows = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    d.setPaused(true);
    const { renderer, scene, camera } = d;
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;

    const grab = () => {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };

    const full = grab();
    const list = [];
    for (const holder of scene.children) {
      if (!holder.isGroup) continue;
      for (const child of holder.children) {
        if (child.isLight) continue;
        const wasVisible = child.visible;
        child.visible = false;
        const without = grab();
        child.visible = wasVisible;

        let changed = 0;
        let lum = 0;
        let n = 0;
        for (let i = 0; i < w * h; i += 1) {
          const o = i * 4;
          const dr = Math.abs(full[o] - without[o]) + Math.abs(full[o + 1] - without[o + 1]) + Math.abs(full[o + 2] - without[o + 2]);
          if (dr > 6) {
            changed += 1;
            lum += (full[o] * 0.299 + full[o + 1] * 0.587 + full[o + 2] * 0.114) / 255;
            n += 1;
          }
        }
        list.push({
          name: (child.name || child.type || 'unnamed').slice(0, 26),
          meshes: (() => {
            let c = 0;
            child.traverse((o) => {
              if (o.isMesh) c += 1;
            });
            return c;
          })(),
          px: changed,
          pct: +((changed / (w * h)) * 100).toFixed(2),
          lum: +(lum / Math.max(n, 1)).toFixed(3),
        });
      }
    }
    return { total: w * h, list: list.sort((a, b) => b.px - a.px) };
  });

  console.log(`画布像素 ${rows.total}（默认机位）`);
  console.log('模块名                          mesh    像素     占比     平均亮度');
  for (const r of rows.list) {
    console.log(`${r.name.padEnd(30)} ${String(r.meshes).padEnd(7)} ${String(r.px).padEnd(8)} ${String(r.pct).padStart(6)}%  ${r.lum}`);
  }
} finally {
  await browser.close();
}
