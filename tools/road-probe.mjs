/**
 * 找出路面上的"扁平异物"：bbox 中心落在车行道内、高度很矮、面积较大的 mesh。
 * node tools/road-probe.mjs
 */
import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--window-size=1200,800', '--window-position=30,30'],
  defaultViewport: { width: 1200, height: 800 },
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', String(e)));
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2000));

  const rows = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    const { THREE, scene } = d;
    const out = [];
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const box = new THREE.Box3().setFromObject(o);
      if (!Number.isFinite(box.min.x)) return;
      const c = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const onAvenue = Math.abs(c.z) < 9 && Math.abs(c.x) < 72;
      const onCross = Math.abs(c.x) < 8 && Math.abs(c.z) < 72;
      if (!onAvenue && !onCross) return;
      if (size.y > 0.9) return; // 只找矮东西
      if (size.x < 0.8 && size.z < 0.8) return; // 只找有一定面积的
      let root = o;
      const chain = [];
      while (root.parent && root.parent !== scene) {
        chain.unshift(root.name || root.type);
        root = root.parent;
      }
      chain.unshift(root.name || root.type);
      out.push({
        chain: chain.join(' > '),
        name: o.name || o.geometry.type,
        center: [+c.x.toFixed(1), +c.y.toFixed(2), +c.z.toFixed(1)],
        size: [+size.x.toFixed(2), +size.y.toFixed(2), +size.z.toFixed(2)],
        visible: o.visible,
        matType: Array.isArray(o.material) ? 'multi' : o.material?.type,
        color: Array.isArray(o.material) ? '-' : o.material?.color ? `#${o.material.color.getHexString()}` : '-',
      });
    });
    out.sort((a, b) => b.size[0] * b.size[2] - a.size[0] * a.size[2]);
    return out.slice(0, 30);
  });

  console.log('路面上的扁平异物：');
  for (const r of rows) {
    console.log(`${r.chain.padEnd(46)} ${r.name.padEnd(16)} c=${JSON.stringify(r.center)} size=${JSON.stringify(r.size)} ${r.matType} ${r.color} vis=${r.visible}`);
  }
} finally {
  await browser.close();
}
