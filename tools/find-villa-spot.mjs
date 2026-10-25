/**
 * 空地扫描（真实几何判定）：用场景里所有"建筑体量"的包围盒，
 * 找一块能放下别墅的净空地 —— 这是唯一可信的判空依据
 * （占位表只登记了道路与分区，不含建筑地块）。
 *
 * node tools/find-villa-spot.mjs [--scale=1]
 */
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const url = flag('url', 'http://127.0.0.1:4175/');
// 别墅 footprint（rotation=π/2, scale=1）：X 半宽 3.5+女儿墙 → 4.4；Z 半深 6.5+屋檐 → 7.4
const HW = 4.4;
const HD = 7.4;

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--hide-scrollbars', '--window-size=1200,800', '--window-position=20,20'],
  defaultViewport: { width: 1200, height: 800 },
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', String(e).slice(0, 200)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 40000 });
  await new Promise((r) => setTimeout(r, 1500));

  const res = await page.evaluate(
    ({ hw, hd }) => {
      const d = window.__dioramaDebug;
      const THREE = d.THREE;
      const boxes = [];
      d.scene.traverse((o) => {
        if (!o.isMesh) return;
        if (o.name.startsWith('villa')) return;
        const b = new THREE.Box3().setFromObject(o);
        if (!Number.isFinite(b.min.x)) return;
        const h = b.max.y - b.min.y;
        if (h < 2.0) return;
        if (b.max.y < 1.2) return;
        const s = b.getSize(new THREE.Vector3());
        if (s.x * s.z < 6) return;
        boxes.push(b);
      });
      const hits = (r) =>
        boxes.some((b) => b.min.x < r.x1 && b.max.x > r.x0 && b.min.z < r.z1 && b.max.z > r.z0);
      const out = [];
      // 顶点级判空：把每个 mesh 的顶点变换到世界坐标，统计落在候选矩形里的"建筑级"顶点
      const v = new THREE.Vector3();
      const buildingVerts = [];
      d.scene.traverse((o) => {
        if (!o.isMesh) return;
        if (o.name.startsWith('villa')) return;
        const pos = o.geometry?.getAttribute?.('position');
        if (!pos) return;
        const step = Math.max(1, Math.floor(pos.count / 1500));
        for (let i = 0; i < pos.count; i += step) {
          v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
          if (v.y > 1.6) buildingVerts.push(v.x, v.y, v.z);
        }
      });
      const hitVerts = (r) => {
        for (let i = 0; i < buildingVerts.length; i += 3) {
          const x = buildingVerts[i];
          const z = buildingVerts[i + 2];
          if (x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) return true;
        }
        return false;
      };
      for (let cz = -130; cz <= 130; cz += 2) {
        for (let cx = -130; cx <= 130; cx += 2) {
          const dist = Math.hypot(cx, cz);
          if (dist < 20) continue;
          if (Math.abs(cz) < 15 || Math.abs(cx) < 15) continue;
          const r = { x0: cx - hw, x1: cx + hw, z0: cz - hd, z1: cz + hd };
          if (!hitVerts(r)) out.push([cx, cz]);
        }
      }
      out.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));
      return { buildingBoxes: boxes.length, free: out.slice(0, 24), vertCount: buildingVerts.length / 3 };
    },
    { hw: HW, hd: HD },
  );

  console.log('建筑级包围盒数量:', res.buildingBoxes);
  console.log('真实净空候选（距中心由近到远）:');
  for (const [x, z] of res.free) console.log(`  x=${x}  z=${z}  d=${Math.hypot(x, z).toFixed(0)}m`);
} finally {
  await browser.close();
}
