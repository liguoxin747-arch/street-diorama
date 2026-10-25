/**
 * 几何与性能审计：越界 / 埋地 / 悬空 / 灯光数量 / 每帧渲染耗时。
 * node tools/audit.mjs
 */
import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const url = process.env.DIORAMA_URL || 'http://127.0.0.1:4175/';

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  // 窗口被其他窗口完全遮挡时 Chrome 会把 rAF 降到 1fps，构建里的 yieldFrame 就再也不返回了
  args: [
    '--no-sandbox',
    '--hide-scrollbars',
    '--window-size=1600,900',
    '--window-position=30,30',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', String(e)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // 改过 core/ 里的模块会让 vite 重新变换整棵依赖树，冷启动可以远超 30s
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 120000 });
  await new Promise((r) => setTimeout(r, 2500));

  const audit = await page.evaluate(async () => {
    const d = window.__dioramaDebug;
    const { THREE, renderer, scene, camera } = d;

    const outOfBounds = [];
    const underground = [];
    const above = [];
    let meshes = 0;
    const lights = [];
    const groupStats = {};

    scene.traverse((o) => {
      if (o.isLight) {
        lights.push({ type: o.type, name: o.name || '', pos: [o.position.x, o.position.y, o.position.z].map((v) => +v.toFixed(1)), intensity: +o.intensity.toFixed(1) });
      }
      if (!o.isMesh) return;
      meshes += 1;
      let root = o;
      while (root.parent && root.parent !== scene) root = root.parent;
      const key = root.name || root.type;
      groupStats[key] = groupStats[key] ?? { meshes: 0, tris: 0 };
      groupStats[key].meshes += 1;
      groupStats[key].tris += (o.geometry.index ? o.geometry.index.count : o.geometry.getAttribute('position')?.count ?? 0) / 3;

      const b = new THREE.Box3().setFromObject(o);
      const label = `${o.name || o.geometry.type} @${o.position.x.toFixed(1)},${o.position.y.toFixed(1)},${o.position.z.toFixed(1)}`;
      // 白名单：展台底座自身的结构件（plinth/skirt/rim 故意大于底座）、车队（在底座外雾里排队等候）
      const isPool = o.geometry?.type === 'PlaneGeometry' && o.parent?.name === 'base';
      let inBase = false;
      let inConvoy = false;
      // 远景剪影/边缘伪装/雾墙/边界山形：按设计就在底座之外，不参与越界与高空判定
      let inOutskirts = false;
      for (let p = o; p; p = p.parent) {
        const pn = p.name || '';
        if (/convoy/.test(pn)) inConvoy = true;
        if (pn === 'base') inBase = true;
        if (/^(skyline|edge-|outskirts|fx-fog|border|terminal|far-|cloud-shadow|sky)/.test(pn)) inOutskirts = true;
        if (p === scene) break;
      }
      const lim = d.base.half + 0.5;
      if (!isPool && !inBase && !inConvoy && !inOutskirts && (b.min.x < -lim || b.max.x > lim || b.min.z < -lim || b.max.z > lim)) outOfBounds.push(label + ` box=[${b.min.x.toFixed(1)},${b.max.x.toFixed(1)}]x[${b.min.z.toFixed(1)},${b.max.z.toFixed(1)}]`);
      if (!inBase && !inOutskirts && b.max.y < -0.7) underground.push(label + ` maxY=${b.max.y.toFixed(2)}`);
      if (!inOutskirts && b.min.y > 26) above.push(label + ` minY=${b.min.y.toFixed(2)}`);
    });

    // 渲染耗时
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    const t0 = performance.now();
    const frames = 40;
    for (let i = 0; i < frames; i += 1) renderer.render(scene, camera);
    const ms = (performance.now() - t0) / frames;

    // 真实循环帧率（含后期）
    const deltas = [];
    await new Promise((resolve) => {
      let last = performance.now();
      let count = 0;
      const step = (now) => {
        deltas.push(now - last);
        last = now;
        count += 1;
        if (count > 120) resolve();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    const sorted = deltas.slice(10).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;

    // 战争废墟层自带的统计快照 + 特效粒子场占用
    const warzone = scene.getObjectByName('warzone');    const fxFields = [];
    scene.traverse((o) => {
      if (o.isPoints && /fx-/.test(o.name || '')) {
        fxFields.push({ name: o.name, live: o.geometry.drawRange.count });
      }
    });

    return {
      meshes,
      drawCalls: renderer.info.render.calls,
      renderTriangles: renderer.info.render.triangles,
      lights,
      warzoneStats: warzone?.userData?.warzone ?? null,
      fxFields,
      groupStats,
      outOfBounds: outOfBounds.slice(0, 40),
      outOfBoundsCount: outOfBounds.length,
      underground: underground.slice(0, 8),
      undergroundCount: underground.length,
      above: above.slice(0, 8),
      aboveCount: above.length,
      frameMsDirect: +ms.toFixed(2),
      loopMsMedian: +median.toFixed(2),
      loopMsP95: +p95.toFixed(2),
      pixelRatio: renderer.getPixelRatio(),
    };
  });

  console.log(`mesh=${audit.meshes} drawCall=${audit.drawCalls} 三角面=${audit.renderTriangles} 直渲帧耗时=${audit.frameMsDirect}ms 循环帧时=${audit.loopMsMedian}ms(p95 ${audit.loopMsP95}ms → ${Math.round(1000 / Math.max(audit.loopMsMedian, 0.01))}fps) dpr=${audit.pixelRatio}`);
  console.log(`光源(${audit.lights.length})：${audit.lights.map((l) => `${l.name || l.type}@${l.pos.join('/')}`).join('  ')}`);
  console.log(`战争废墟统计：${JSON.stringify(audit.warzoneStats)}`);
  console.log(`粒子场：${audit.fxFields.map((f) => `${f.name}=${f.live}`).join('  ')}`);
  console.log('分组：');
  Object.entries(audit.groupStats)
    .sort((a, b) => b[1].tris - a[1].tris)
    .forEach(([k, v]) => console.log(`  ${k.padEnd(16)} mesh=${String(v.meshes).padEnd(5)} tris=${Math.round(v.tris)}`));
  console.log(`越界网格：${audit.outOfBoundsCount}`);
  audit.outOfBounds.forEach((l) => console.log('  ' + l));
  console.log(`埋地网格：${audit.undergroundCount}`);
  audit.underground.forEach((l) => console.log('  ' + l));
  console.log(`高空异常：${audit.aboveCount}`);
  audit.above.forEach((l) => console.log('  ' + l));
} finally {
  await browser.close();
}
