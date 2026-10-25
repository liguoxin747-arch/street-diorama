/**
 * Draw call 归因：逐个只让一个子树可见并渲染，读 renderer.info.render.calls。
 * 用于回答"这 400 次调用是谁加的"，而不是靠 mesh 数猜。
 * node tools/_drawcalls.mjs [--depth=warzone]
 */
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const depth = flag('depth', 'warzone');
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  protocolTimeout: 600000,
  args: [
    '--no-sandbox',
    '--hide-scrollbars',
    '--use-angle=default',
    '--ignore-gpu-blocklist',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--window-size=1600,900',
    '--window-position=30,30',
  ],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', String(e).slice(0, 200)));
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 120000 });

  const report = await page.evaluate((target) => {
    const d = window.__dioramaDebug;
    const { renderer, scene, camera } = d;
    const root = scene.getObjectByName('diorama-root');
    const parent = target === 'root' ? root : scene.getObjectByName(target) ?? root;

    renderer.shadowMap.autoUpdate = false;
    const measure = () => {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return renderer.info.render.calls;
    };
    const kids = parent.children.filter((c) => c !== undefined);
    const saved = kids.map((k) => k.visible);
    const rows = [];
    // 基线：整个父节点隐藏 → 剩下的调用数
    const parentVisible = parent.visible;
    parent.visible = false;
    const base = measure();
    parent.visible = parentVisible;

    for (const k of kids) {
      kids.forEach((o, i) => (o.visible = i === kids.indexOf(k) ? saved[i] : false));
      const calls = measure();
      let meshes = 0;
      k.traverse((o) => {
        if (o.isMesh || o.isPoints) meshes += 1;
      });
      rows.push({ name: k.name || k.type, calls: Math.max(0, calls - base), meshes });
    }
    kids.forEach((o, i) => (o.visible = saved[i]));
    measure();
    rows.sort((a, b) => b.calls - a.calls);
    return { total: measure(), base, rows: rows.slice(0, 26) };
  }, depth);

  console.log(`全场景 drawCall=${report.total}（父节点隐藏后基线 ${report.base}）`);
  for (const r of report.rows) {
    console.log(`  ${r.name.padEnd(30)} calls=${String(r.calls).padStart(5)}  mesh=${r.meshes}`);
  }
} finally {
  await browser.close();
}
