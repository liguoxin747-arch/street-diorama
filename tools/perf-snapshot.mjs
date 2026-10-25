/**
 * 真实帧时与渲染统计（基线/优化对比用）
 * node tools/perf-snapshot.mjs [--url=http://127.0.0.1:4186/] [--wait=4000] [--repeat=3]
 */
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const url = flag('url', process.env.DIORAMA_URL || 'http://127.0.0.1:4186/');
const wait = Number(flag('wait', '4000'));
const repeat = Number(flag('repeat', '3'));
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--hide-scrollbars', '--window-size=1600,900', '--window-position=30,30',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', String(e).slice(0, 240)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 120000 });
  await new Promise((r) => setTimeout(r, wait));
  const result = await page.evaluate(async (repeat) => {
    const d = window.__dioramaDebug;
    const { renderer, scene, camera } = d;
    let meshCount = 0;
    let triCount = 0;
    const byRoot = {};
    scene.traverse((o) => {
      if (!o.isMesh) return;
      meshCount += 1;
      const tris = (o.geometry.index ? o.geometry.index.count : o.geometry.getAttribute('position')?.count ?? 0) / 3;
      triCount += tris;
      let root = o;
      while (root.parent && root.parent !== scene) root = root.parent;
      const key = root.name || root.type;
      byRoot[key] = (byRoot[key] ?? 0) + tris;
    });
    // 用一次显式渲染收集真实渲染量（当前渲染器按 info 最后一次 pass 统计）
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    const calls = renderer.info.render.calls;
    const renderTris = renderer.info.render.triangles;
    const frames = [];
    await new Promise((resolve) => {
      let last = performance.now();
      let n = 0;
      const step = (now) => {
        const dt = now - last;
        last = now;
        if (n++ > 12) frames.push(dt);
        if (n > 132) resolve();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    const sorted = [...frames].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    return {
      meshes: meshCount,
      tris: Math.round(triCount),
      directCalls: calls,
      directTris: renderTris,
      frameMedianMs: +median.toFixed(2),
      frameP95Ms: +p95.toFixed(2),
      byRoot,
    };
  }, repeat);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
