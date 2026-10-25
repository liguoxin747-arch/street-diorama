/**
 * 诊断：暂停主循环后分别用"真实材质"和"白色覆盖材质"直接渲染并截图，
 * 用来区分「几何没渲染」与「光照/材质太暗」。
 * node tools/diagnose.mjs [--url=...]
 */
import puppeteer from 'puppeteer-core';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const url = flag('url', 'http://127.0.0.1:4175/');
const outDir = flag('outdir', 'tests/e2e/out');
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--hide-scrollbars', '--window-size=1400,860', '--window-position=40,40'],
  defaultViewport: { width: 1400, height: 860, deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', String(e)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1200));

  const stats = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    d.setPaused(true);
    d.renderDirect();
    return { calls: d.renderer.info.render.calls, tris: d.renderer.info.render.triangles };
  });
  console.log('direct render:', JSON.stringify(stats));
  await page.screenshot({ path: resolve(outDir, 'diagnose-real.png') });

  await page.evaluate(() => {
    const d = window.__dioramaDebug;
    d.scene.overrideMaterial = new d.THREE.MeshBasicMaterial({ color: 0xffffff });
    d.renderDirect();
  });
  await new Promise((r) => setTimeout(r, 250));
  await page.screenshot({ path: resolve(outDir, 'diagnose-white.png') });

  console.log('saved diagnose-real.png / diagnose-white.png');
} finally {
  await browser.close();
}
