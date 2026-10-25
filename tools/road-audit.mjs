/**
 * 道路净空审计（顶点级）：不看 bbox，直接把每个 mesh 的顶点变换到世界坐标，
 * 统计真正"立在路面上"的几何量。合并批次也不会误报。
 *
 * 检查两个区域：
 *  1) 车队车道：x ∈ [1.2, 5.4]，z ∈ [-78, 78]（南向行车线）
 *  2) 车行道全域：|z| <= 9（大道）或 |x| <= 8（纵街）
 *
 * node tools/road-audit.mjs
 */
import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  // 窗口被遮挡时 Chrome 把 rAF 降到 1fps，构建里的 yieldFrame 再也不返回 → 就绪超时
  args: ['--no-sandbox', '--window-size=1200,800', '--window-position=30,30', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
  defaultViewport: { width: 1200, height: 800 },
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', String(e)));
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2200));

  const result = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    const { THREE, scene, layout } = d;
    const v = new THREE.Vector3();
    const LANE = layout.convoyLane;
    const inRects = (rs, x, z) => rs.some((r) => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1);

    // 静态地面层（路面本身、标线、积水、草垫）——不算障碍
    // 路面自身（含铁轨的道砟/枕木/钢轨这些贴地件）不算障碍
    const isGroundLayer = (chain, name) =>
      /^(base-plinth|base-skirt|base-rim|base-bevel|base-ground|road-|road-markings|sidewalk|curbs|puddles|puddle-rims|puddle-silt|ground-|outer-|asphalt-cracks|stains|mud|sidewalk-seams|grates|grate-bars|manhole|edge-darken|crater-|rail-|sky-dome|war-decal)/.test(
        `${name}|${chain.slice(-1)[0]}`,
      ) || /puddle|weed|outer-dirt|ground-|stain|mud|marking|dash|rail|sleeper|ballast|crossing/.test(name);

    const chains = new Map();
    const addHit = (key, info) => {
      const cur = chains.get(key) ?? { key, laneVerts: 0, roadVerts: 0, maxY: 0, samples: [], tris: 0 };
      cur.laneVerts += info.laneVerts;
      cur.roadVerts += info.roadVerts;
      cur.maxY = Math.max(cur.maxY, info.maxY);
      cur.tris += info.tris;
      if (info.samples.length && cur.samples.length < 3) cur.samples.push(...info.samples.slice(0, 3 - cur.samples.length));
      chains.set(key, cur);
    };

    scene.traverse((o) => {
      if (!o.isMesh) return;
      let root = o;
      const chain = [];
      while (root.parent && root.parent !== scene) {
        chain.unshift(root.name || root.type);
        root = root.parent;
      }
      chain.unshift(root.name || root.type);
      if (chain[0] === 'diorama-fx') return; // 雨/烟不阻挡
      // 车队是动体，本来就跑在自己的车道上，不算静态障碍
      if (/convoy/.test(chain.join('>'))) return;
      const name = o.name || o.geometry?.type || 'mesh';
      if (isGroundLayer(chain, name)) return;
      if (!o.geometry?.getAttribute) return;
      const pos = o.geometry.getAttribute('position');
      if (!pos) return;

      // 实例化网格：局部坐标必须乘 instanceMatrix，否则所有路灯都会在原点
      // 堆成一根假的"路口灯柱"。这里逐实例抽样。
      const instanced = !!o.isInstancedMesh;
      const instCount = instanced ? o.count : 1;
      const instStep = instanced ? Math.max(1, Math.ceil(instCount / 64)) : 1;
      const instMat = new THREE.Matrix4();
      const world = new THREE.Matrix4();

      // 快速 bbox 预筛（非实例化）；实例化的包围盒不含 instanceMatrix，不能信
      if (!instanced) {
        const box = new THREE.Box3().setFromObject(o);
        if (!Number.isFinite(box.min.x)) return;
        if (box.max.y < 0.25) return; // 全部贴地
        const touchesLane =
          box.max.x > LANE.x0 && box.min.x < LANE.x1 && box.max.z > LANE.z0 && box.min.z < LANE.z1;
        const touchesRoad = layout.carriageways.some(
          (r) => box.max.x > r.x0 && box.min.x < r.x1 && box.max.z > r.z0 && box.min.z < r.z1,
        );
        if (!touchesLane && !touchesRoad) return;
      }

      let laneVerts = 0;
      let roadVerts = 0;
      let maxY = 0;
      const samples = [];
      const step = Math.max(1, Math.floor(pos.count / (instanced ? 300 : 6000))); // 大网格抽样
      for (let ii = 0; ii < instCount; ii += instStep) {
        if (instanced) {
          o.getMatrixAt(ii, instMat);
          world.multiplyMatrices(o.matrixWorld, instMat);
        } else {
          world.copy(o.matrixWorld);
        }
        for (let i = 0; i < pos.count; i += step) {
          v.fromBufferAttribute(pos, i).applyMatrix4(world);
          if (v.y < 0.25) continue;
          if (v.x > LANE.x0 && v.x < LANE.x1 && v.z > LANE.z0 && v.z < LANE.z1) {
            laneVerts += 1;
            if (samples.length < 6 && Math.random() < 0.02) samples.push([+v.x.toFixed(1), +v.y.toFixed(1), +v.z.toFixed(1)]);
          }
          if (inRects(layout.carriageways, v.x, v.z)) roadVerts += 1;
          if (laneVerts > 0 || roadVerts > 0) maxY = Math.max(maxY, v.y);
        }
      }
      if (laneVerts === 0 && roadVerts === 0) return;

      const key = `${chain[0]}>${name}`;
      addHit(key, {
        laneVerts,
        roadVerts,
        maxY,
        samples,
        tris: (o.geometry.index ? o.geometry.index.count : pos.count) / 3,
      });
    });

    const all = [...chains.values()].sort((a, b) => b.laneVerts - a.laneVerts || b.roadVerts - a.roadVerts);
    return {
      lane: all.filter((c) => c.laneVerts > 0).slice(0, 20),
      road: all.filter((c) => c.roadVerts >= 40).sort((a, b) => b.roadVerts - a.roadVerts).slice(0, 20),
    };
  });

  console.log(`\n【车队车道 x∈[1.2,5.4]】有立体几何的网格组：${result.lane.length}`);
  for (const c of result.lane) {
    console.log(`  ${c.key.padEnd(44)} 车道顶点=${String(c.laneVerts).padStart(5)} 最高y=${c.maxY.toFixed(1)} tris=${Math.round(c.tris)} 例=${JSON.stringify(c.samples)}`);
  }
  console.log(`\n【车行道全域】顶点数较多的网格组（>40）：${result.road.length}`);
  for (const c of result.road) {
    console.log(`  ${c.key.padEnd(44)} 路面顶点=${String(c.roadVerts).padStart(6)} 车道顶点=${String(c.laneVerts).padStart(5)} 最高y=${c.maxY.toFixed(1)}`);
  }
} finally {
  await browser.close();
}
