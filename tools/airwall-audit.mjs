/**
 * 空气墙审计：在第一人称可行走域上铺网格，找出"被挡但四周空旷"的小块孤岛。
 *
 * 判据：某格被 canStand 判为不可走，但它 5×5 邻域里有一半以上格子可走 ——
 * 建筑是成片的实体块（邻域几乎全挡），只有空气墙才会长成"空旷地里的小孤岛"。
 *
 * 对每个孤岛再用射线复核：向正下方打一条（y=25 → 地面），若 1.2 m 高度上没有命中，
 * 说明那里确实没有实体，属误挡。
 *
 * node tools/airwall-audit.mjs [--url=...] [--step=0.5] [--limit=92]
 */
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const url = flag('url', process.env.DIORAMA_URL || 'http://127.0.0.1:4187/');
const step = Number(flag('step', '0.5'));
const limit = Number(flag('limit', '92'));
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  protocolTimeout: 900000,
  args: ['--no-sandbox', '--window-size=1280,720', '--window-position=30,30', '--disable-backgrounding-occluded-windows'],
  defaultViewport: { width: 1280, height: 720 },
});

try {
  const page = await browser.newPage();
  await page.bringToFront();
  await page.goto(`${url}?v=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 180000 });
  await new Promise((r) => setTimeout(r, 4000));

  const out = await page.evaluate(({ step, limit }) => {
    const d = window.__dioramaDebug;
    const view = d.view;
    const THREE = d.THREE;
    // layout.ts 里设计好的巷子（canStand 只认数据，这里照抄一份用于专项验证）
    const alleyRects = [
      { x0: 34, x1: 36, z0: -34, z1: -13, name: '主楼东侧小巷' },
      { x0: -16, x1: -12, z0: -28, z1: -13, name: 'NW 街区侧巷' },
      { x0: 32, x1: 34, z0: 14, z1: 34, name: 'SE 街区窄巷' },
    ];
    const n = Math.floor((limit * 2) / step);
    const grid = new Uint8Array(n * n);
    const px = (i) => -limit + i * step;
    let walk = 0;
    for (let iz = 0; iz < n; iz += 1) {
      for (let ix = 0; ix < n; ix += 1) {
        const ok = view.canStand(px(ix), px(iz)) ? 1 : 0;
        grid[iz * n + ix] = ok;
        if (ok) walk += 1;
      }
    }
    // 边界带与"地块内部的楼体"不算空气墙：行走域本身在 |x|,|z| ≤ 90 处收边，
    // 5×5 邻域在边界上只有一半落在域内，必然被判成孤岛。
    const BAND = 88;
    const islands = [];
    for (let iz = 0; iz < n; iz += 1) {
      for (let ix = 0; ix < n; ix += 1) {
        if (grid[iz * n + ix]) continue;
        if (Math.abs(px(ix)) > BAND || Math.abs(px(iz)) > BAND) continue;
        let open = 0;
        let total = 0;
        for (let dz = -2; dz <= 2; dz += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            const jz = iz + dz;
            const jx = ix + dx;
            if (jx < 0 || jz < 0 || jx >= n || jz >= n) continue;
            total += 1;
            open += grid[jz * n + jx];
          }
        }
        // 阈值 0.28：2 m 宽的巷子只有 4 格宽，被挡成一条时开阔邻域占比也只有三成左右
        if (open / total >= 0.28) islands.push({ x: px(ix), z: px(iz), open });
      }
    }

    // 孤岛聚合成簇（0.5 m 连通）
    const clusters = [];
    const used = new Uint8Array(islands.length);
    const near = (a, b) => Math.abs(a.x - b.x) <= step * 1.5 && Math.abs(a.z - b.z) <= step * 1.5;
    for (let i = 0; i < islands.length; i += 1) {
      if (used[i]) continue;
      const stack = [i];
      used[i] = 1;
      const group = [];
      while (stack.length) {
        const k = stack.pop();
        const a = islands[k];
        group.push(a);
        for (let j = 0; j < islands.length; j += 1) {
          if (used[j]) continue;
          if (near(a, islands[j])) {
            used[j] = 1;
            stack.push(j);
          }
        }
      }
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (const g of group) {
        x0 = Math.min(x0, g.x);
        x1 = Math.max(x1, g.x);
        z0 = Math.min(z0, g.z);
        z1 = Math.max(z1, g.z);
      }
      clusters.push({ cells: group.length, x0, x1, z0, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 });
    }
    clusters.sort((a, b) => b.cells - a.cells);

    // 射线复核：孤岛中心 1.2m 高处是否有实体（墙体/箱子/沙袋）
    // 只拿显式收集的可见 mesh 数组、recursive=false —— 直接对 scene.children 递归
    // 会碰到被摘下但仍被引用的节点（parent 为 null），在 three 内部抛错。
    const meshes = [];
    d.scene.traverse((o) => {
      if (o.isMesh && o.visible && o.name !== 'sky-dome') meshes.push(o);
    });
    const ray = new THREE.Raycaster();
    const dirDown = new THREE.Vector3(0, -1, 0);
    const solids = [];
    for (const c of clusters.slice(0, 60)) {
      const origin = new THREE.Vector3(c.cx, 25, c.cz);
      ray.set(origin, dirDown);
      ray.far = 40;
      const hits = ray.intersectObjects(meshes, false);
      const top = hits.find((h) => h.object.visible);
      const topY = top ? top.point.y : -999;
      // 1.2m 高度横向 4 向 0.55m 内是否有墙
      let side = 0;
      for (const a of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
        ray.set(new THREE.Vector3(c.cx, 1.2, c.cz), new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
        ray.far = 0.55;
        const hs = ray.intersectObjects(meshes, false);
        if (hs.some((h) => h.object.visible)) side += 1;
      }
      solids.push({ ...c, topY: +topY.toFixed(2), sideHits: side });
    }
    // —— 专项：地块之间的窄缝（巷子）是否真的走得通 ——
    // 直接拿碰撞矩形求"间隙条带"，比随机采样更能对准用户说的"建筑区域小巷"。
    const rects = view.debugRects ? view.debugRects() : [];
    const inRect = (r, x, z) =>
      x > r.x0 - 0.3 && x < r.x1 + 0.3 && z > r.z0 - 0.3 && z < r.z1 + 0.3;
    const gapReport = [];
    const testStrip = (x0, x1, z0, z1) => {
      let total = 0;
      let blocked = 0;
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      if (x1 - x0 >= z1 - z0) {
        for (let x = x0 + 0.25; x <= x1 - 0.25; x += 0.5) {
          total += 1;
          if (!view.canStand(x, cz)) blocked += 1;
        }
      } else {
        for (let z = z0 + 0.25; z <= z1 - 0.25; z += 0.5) {
          total += 1;
          if (!view.canStand(cx, z)) blocked += 1;
        }
      }
      return { total, blocked };
    };
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i];
        const b = rects[j];
        // x 向间隙 + z 向重叠
        const z0 = Math.max(a.z0, b.z0);
        const z1 = Math.min(a.z1, b.z1);
        if (z1 - z0 >= 2) {
          const gx0 = a.x1 < b.x0 ? a.x1 : b.x1 < a.x0 ? b.x1 : null;
          const gx1 = a.x1 < b.x0 ? b.x0 : b.x1 < a.x0 ? a.x0 : null;
          if (gx0 !== null && gx1 !== null && gx1 - gx0 >= 0.8 && gx1 - gx0 <= 4.5) {
            const t = testStrip(gx0, gx1, z0, z1);
            if (t.blocked > 0) gapReport.push({ axis: 'x', x0: gx0, x1: gx1, z0, z1, width: +(gx1 - gx0).toFixed(2), ...t });
          }
        }
        // z 向间隙 + x 向重叠
        const x0 = Math.max(a.x0, b.x0);
        const x1 = Math.min(a.x1, b.x1);
        if (x1 - x0 >= 2) {
          const gz0 = a.z1 < b.z0 ? a.z1 : b.z1 < a.z0 ? b.z1 : null;
          const gz1 = a.z1 < b.z0 ? b.z0 : b.z1 < a.z0 ? a.z0 : null;
          if (gz0 !== null && gz1 !== null && gz1 - gz0 >= 0.8 && gz1 - gz0 <= 4.5) {
            const t = testStrip(x0, x1, gz0, gz1);
            if (t.blocked > 0) gapReport.push({ axis: 'z', x0, x1, z0: gz0, z1: gz1, width: +(gz1 - gz0).toFixed(2), ...t });
          }
        }
      }
    }
    gapReport.sort((a, b) => b.blocked - a.blocked);
    const alleyReport = alleyRects.map((a) => ({ ...a, ...testStrip(a.x0, a.x1, a.z0, a.z1) }));

    return {
      grid: { n, step, walkCells: walk, total: n * n },
      islandCells: islands.length,
      clusters: clusters.length,
      detail: solids,
      alleys: alleyReport,
      gaps: gapReport,
    };
  }, { step, limit });

  console.log(`网格 ${out.grid.n}×${out.grid.n}（${out.grid.step}m）｜可走 ${out.grid.walkCells}/${out.grid.total}`);
  console.log(`空气墙孤岛：${out.islandCells} 格，聚成 ${out.clusters} 簇`);
  console.log('前 20 簇（topY=该点正上方最高实体高度，sideHits=1.2m 高四周 0.55m 内的墙数）:');
  for (const c of out.detail.slice(0, 20)) {
    const verdict = c.topY < 1.4 && c.sideHits === 0 ? '  ← 确实是空气墙' : '';
    console.log(
      `  ${String(c.cells).padStart(4)} 格  中心(${c.cx.toFixed(1)}, ${c.cz.toFixed(1)})  范围 x[${c.x0.toFixed(1)},${c.x1.toFixed(1)}] z[${c.z0.toFixed(1)},${c.z1.toFixed(1)}]  topY=${c.topY}  侧墙=${c.sideHits}${verdict}`,
    );
  }
  const real = out.detail.filter((c) => c.topY < 1.4 && c.sideHits === 0).length;
  console.log(`\n其中确认无实体（真空气墙）：${real} / ${out.detail.length} 簇`);

  console.log('\n设计巷子通行性:');
  for (const a of out.alleys) {
    console.log(`  ${a.name.padEnd(14)} 采样 ${a.total} 点，被挡 ${a.blocked}${a.blocked ? '  ← 巷子里有空气墙' : '  OK'}`);
  }

  console.log(`\n地块窄缝（0.8~4.5m 间隙，两侧都是碰撞矩形）共 ${out.gaps.length} 条，其中被挡的:`);
  for (const g of out.gaps.slice(0, 18)) {
    console.log(
      `  ${g.axis} 向窄缝 宽 ${g.width}m  范围 x[${g.x0.toFixed(1)},${g.x1.toFixed(1)}] z[${g.z0.toFixed(1)},${g.z1.toFixed(1)}]  采样 ${g.total}，被挡 ${g.blocked}`,
    );
  }
  if (!out.gaps.length) console.log('  （无）');
} finally {
  await browser.close();
}
