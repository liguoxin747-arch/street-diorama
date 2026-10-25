/**
 * 道具模块预算测量：统计 street-props 组的 mesh / 三角面 / 描边数 / 子组明细。
 * node tools/_measure.mjs
 */
import { writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const url = process.env.DIORAMA_URL || 'http://127.0.0.1:4175/';
const log = [];
const say = (...a) => { const s = a.join(' '); log.push(s); console.log(s); };

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  protocolTimeout: 60000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--window-size=1600,900'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => say('PAGEERROR:', e.stack || String(e)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));

  const res = await page.evaluate(() => {
    const { THREE, scene, camera, renderer } = window.__dioramaDebug;
    const trisOf = (o) =>
      (o.geometry.index ? o.geometry.index.count : (o.geometry.getAttribute('position')?.count ?? 0)) / 3;

    const groups = {};
    let total = { meshes: 0, tris: 0, outlines: 0, instanced: 0, instTris: 0 };
    let sceneMeshes = 0;
    let sceneTris = 0;
    scene.traverse((o) => {
      if (!o.isMesh) return;
      sceneMeshes += 1;
      sceneTris += trisOf(o);
    });

    // 找到 street-props 组
    let propsRoot = null;
    scene.traverse((o) => { if (o.name === 'street-props') propsRoot = o; });
    if (!propsRoot) return { error: 'street-props not found', sceneMeshes, sceneTris: Math.round(sceneTris) };

    const visit = (obj, key) => {
      if (obj.isMesh) {
        const t = obj.isInstancedMesh ? trisOf(obj) * obj.count : trisOf(obj);
        groups[key] = groups[key] ?? { meshes: 0, tris: 0, outlines: 0 };
        groups[key].meshes += 1;
        groups[key].tris += t;
        total.meshes += 1;
        total.tris += t;
        if (obj.userData['isOutline']) { groups[key].outlines += 1; total.outlines += 1; }
        if (obj.isInstancedMesh) { total.instanced += 1; total.instTris += t; }
      }
      for (const c of obj.children) visit(c, key);
    };
    for (const c of propsRoot.children) visit(c, c.name || c.type);

    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    const drawCalls = renderer.info.render.calls;

    return {
      sceneMeshes, sceneTris: Math.round(sceneTris), drawCalls,
      total: {
        meshes: total.meshes,
        tris: Math.round(total.tris),
        outlines: total.outlines,
        instancedMeshes: total.instanced,
        instancedTris: Math.round(total.instTris),
      },
      groups: Object.fromEntries(
        Object.entries(groups)
          .map(([k, v]) => [k, { meshes: v.meshes, tris: Math.round(v.tris), outlines: v.outlines }])
          .sort((a, b) => b[1].tris - a[1].tris),
      ),
    };
  });

  if (res.error) { say('ERROR:', res.error); }
  else {
    say(`全场景: mesh=${res.sceneMeshes} 三角面=${res.sceneTris} drawCall=${res.drawCalls}`);
    say(`道具组: mesh=${res.total.meshes} 三角面=${res.total.tris} 描边=${res.total.outlines} instanced网格=${res.total.instancedMeshes}(三角面 ${res.total.instancedTris})`);
    say('  --- 子组 ---');
    for (const [k, v] of Object.entries(res.groups)) {
      say(`  ${String(k).padEnd(22)} mesh=${String(v.meshes).padEnd(5)} tris=${String(v.tris).padEnd(7)} outline=${v.outlines}`);
    }
  }
} catch (e) {
  say('OUTER ERROR:', String(e).slice(0, 600));
} finally {
  await browser.close().catch(() => {});
  writeFileSync('tools/_measure.log', log.join('\n'), 'utf8');
}
