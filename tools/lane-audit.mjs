/**
 * 车队车道净空审计：只检查车队实际行驶的走廊里有没有实体障碍。
 * 车道：纵街南向车道 x ∈ [1.2, 5.4]，z ∈ [-78, 78]，高 > 0.25 视为障碍。
 * 同时检查路口核心区（|x|<=8, |z|<=9）是否被非路面物体占据。
 *
 * node tools/lane-audit.mjs
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
  await new Promise((r) => setTimeout(r, 2200));

  const out = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    const { THREE, scene, layout } = d;
    const LANE = { ...layout.convoyLane, minH: 0.25 };
    const CARR = layout.carriageways;
    /** 任意两条车行道的交叠（路口核心区） */
    const junctions = [];
    for (const a of CARR) for (const b of CARR) {
      if (a === b) continue;
      const x0 = Math.max(a.x0, b.x0), x1 = Math.min(a.x1, b.x1);
      const z0 = Math.max(a.z0, b.z0), z1 = Math.min(a.z1, b.z1);
      if (x1 - x0 > 1 && z1 - z0 > 1) junctions.push({ x0, x1, z0, z1 });
    }
    const laneHits = [];
    const junctionHits = [];

    const rootOf = (o) => {
      let r = o;
      const chain = [];
      while (r.parent && r.parent !== scene) {
        chain.unshift(r.name || r.type);
        r = r.parent;
      }
      chain.unshift(r.name || r.type);
      return chain;
    };

    scene.traverse((o) => {
      if (!o.isMesh) return;
      const chain = rootOf(o);
      // 跳过特效/后期层、环境层（路面、底座、标线、积水、草垫、车辙贴片）
      if (chain[0] === 'diorama-fx') return;
      // 车队是动体，本来就跑在自己的车道上，不算静态障碍
      if (/convoy/.test(chain.join('>'))) return;
      const n = (o.name || '') + '>' + chain.slice(0, 3).join('>');
      if (/^(base|diorama-lights)/.test(chain[0])) return;
      if (/outer-weed|outer-dirt|asphalt-cracks|puddle|road-|sidewalk|curbs|ground-|stains|mud|base-|rail-|edge-|sky-dome/.test(n)) return;

      const box = new THREE.Box3().setFromObject(o);
      if (!Number.isFinite(box.min.x)) return;
      if (box.max.y - box.min.y < 0.12) return; // 贴地薄片不算
      const s = box.getSize(new THREE.Vector3());
      const c = box.getCenter(new THREE.Vector3());

      // 车道
      const overlapX = Math.min(box.max.x, LANE.x1) - Math.max(box.min.x, LANE.x0);
      const overlapZ = Math.min(box.max.z, LANE.z1) - Math.max(box.min.z, LANE.z0);
      if (overlapX > 0.05 && overlapZ > 0.05 && box.max.y > LANE.minH) {
        laneHits.push({
          chain: chain.join('>'),
          name: o.name || o.geometry.type,
          center: [+c.x.toFixed(1), +c.y.toFixed(2), +c.z.toFixed(1)],
          size: [+s.x.toFixed(1), +s.y.toFixed(1), +s.z.toFixed(1)],
          area: +(overlapX * overlapZ).toFixed(1),
        });
      }
      // 路口核心：任何两条车行道的交叠区都不许有立体障碍
      for (const j of junctions) {
        const ax = Math.min(box.max.x, j.x1) - Math.max(box.min.x, j.x0);
        const az = Math.min(box.max.z, j.z1) - Math.max(box.min.z, j.z0);
        if (ax > 0.35 && az > 0.35 && box.max.y > 0.3) {
          junctionHits.push({
            chain: chain.join('>'),
            name: o.name || o.geometry.type,
            center: [+c.x.toFixed(1), +c.y.toFixed(2), +c.z.toFixed(1)],
            area: +(ax * az).toFixed(1),
          });
          break;
        }
      }
    });

    laneHits.sort((a, b) => b.area - a.area);
    junctionHits.sort((a, b) => b.area - a.area);
    return { laneHits: laneHits.slice(0, 25), junctionHits: junctionHits.slice(0, 25), laneTotal: laneHits.length, junctionTotal: junctionHits.length };
  });

  console.log(`\n【车队车道】x∈[1.2,5.4] 上的障碍：${out.laneTotal} 个`);
  for (const h of out.laneHits) {
    console.log(`  ${h.name.padEnd(22)} @${JSON.stringify(h.center)} size=${JSON.stringify(h.size)} 重叠=${h.area}m²  [${h.chain}]`);
  }
  console.log(`\n【路口核心】|x|<8,|z|<9 上的实体：${out.junctionTotal} 个`);
  for (const h of out.junctionHits) {
    console.log(`  ${h.name.padEnd(22)} @${JSON.stringify(h.center)} 重叠=${h.area}m²  [${h.chain}]`);
  }
} finally {
  await browser.close();
}
