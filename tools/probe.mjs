/**
 * 页面内探针：打印渲染统计、对象数量、相机与包围盒（验收用）。
 * node tools/probe.mjs [--url=...]
 */
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const url = flag('url', 'http://127.0.0.1:4175/');
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
  await new Promise((r) => setTimeout(r, 1800));
  const info = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    if (!d) return { error: 'no debug hook' };
    const THREEBox = d.scene;
    let meshes = 0;
    let tris = 0;
    let lights = 0;
    const groups = {};
    THREEBox.traverse((o) => {
      if (o.isMesh) {
        meshes += 1;
        const g = o.geometry;
        tris += (g.index ? g.index.count : g.getAttribute('position')?.count ?? 0) / 3;
        let root = o;
        while (root.parent && root.parent !== THREEBox) root = root.parent;
        groups[root.name || root.type] = (groups[root.name || root.type] ?? 0) + 1;
      }
      if (o.isLight) lights += 1;
    });
    const r = d.renderer;
    return {
      meshes,
      triangles: Math.round(tris),
      lights,
      groups,
      drawCalls: r.info.render.calls,
      renderTriangles: r.info.render.triangles,
      programs: r.info.programs?.length ?? -1,
      camera: d.camera.position.toArray().map((v) => +v.toFixed(2)),
      target: d.controls.target.toArray().map((v) => +v.toFixed(2)),
      exposure: r.toneMappingExposure,
      size: [r.domElement.width, r.domElement.height],
    };
  });
  console.log(JSON.stringify(info, null, 2));
} finally {
  await browser.close();
}
