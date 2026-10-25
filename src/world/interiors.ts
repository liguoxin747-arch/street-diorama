import * as THREE from 'three';
import type { BuildContext } from '../core/context';
import type { Rng } from '../core/rng';
import { box, group, instanced, mesh, softBox, type InstanceTransform } from '../core/geo';
import { PALETTE } from '../core/palette';
import { glowMaterial, toonMaterial, withOutline } from '../core/materials';
import type { Rect } from './layout';

/**
 * 街区建筑内构：样板 + 首批三栋（面朝主路口、从默认机位能看见窗洞进深）。
 *
 * 只做**透窗可见**的内构。外壳是按材质合批的实体墙，没有在墙上切真洞，
 * 所以除样板外不开"可走入"——否则玩家会穿墙进去，比不能进更糟。
 * 每栋包一层 LOD：默认俯瞰距离下整组室内不渲染，拉近或第一人称才出现。
 */

interface InteriorSpec {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  floors: number;
  floorH: number;
  slab: number;
  /** 可走入：需要墙上有真洞，目前只有样板满足 */
  enterable: boolean;
  /** 门在临街面上的位置（仅 enterable 用） */
  door?: { x: number; w: number; h: number };
  note: string;
}

const SPECS: InteriorSpec[] = [
  // 样板：西北角三层临街住宅，正门朝大道
  { x0: -30, x1: -16, z0: -26, z1: -13.5, floors: 3, floorH: 3.2, slab: 0.22, enterable: true, door: { x: -21.2, w: 1.15, h: 2.15 }, note: '样板：可走入' },
  // 主楼东侧三层住宅（隔一条小巷），主楼机位能直接看进它的窗
  { x0: 36, x1: 45.5, z0: -32, z1: -14.5, floors: 3, floorH: 3.2, slab: 0.22, enterable: false, note: '主楼东侧' },
  // 大道南侧两层商铺（正对样板楼）
  { x0: -30, x1: -14, z0: 14, z1: 30, floors: 2, floorH: 3.6, slab: 0.24, enterable: false, note: '大道南侧商铺' },
  // 路口东南角四层公寓（钟表店残骸那栋）
  { x0: 14, x1: 32, z0: 14, z1: 34, floors: 4, floorH: 3.0, slab: 0.2, enterable: false, note: '路口东南角公寓' },
];

const APERTURES: Rect[] = [];

export function interiorApertures(): Rect[] {
  return APERTURES;
}

const M = {
  plaster: toonMaterial(0x6f6a60, { steps: 2, emissive: 0x3a322a, emissiveIntensity: 0.9 }),
  plasterDark: toonMaterial(0x55514a, { steps: 2 }),
  floor: toonMaterial(0x5a534a, { steps: 2, emissive: 0x2e2820, emissiveIntensity: 0.85 }),
  floorDark: toonMaterial(0x3f3a33, { steps: 2 }),
  wood: toonMaterial(PALETTE.woodOld, { steps: 2, emissive: 0x332a20, emissiveIntensity: 0.85 }),
  woodDark: toonMaterial(PALETTE.woodDark, { steps: 2 }),
  cloth: toonMaterial(0x4a453f, { steps: 2, emissive: 0x2a2724, emissiveIntensity: 0.85 }),
  sandbag: toonMaterial(PALETTE.sandbagDark, { steps: 2, emissive: 0x2a2418, emissiveIntensity: 0.85 }),
  iron: toonMaterial(0x3a3f45, { steps: 2 }),
  paper: toonMaterial(0xb9b2a2, { steps: 2, emissive: 0x4a4236, emissiveIntensity: 0.9 }),
  void: new THREE.MeshBasicMaterial({ color: 0x04060a }),
};

interface Litter {
  books: InstanceTransform[];
  papers: InstanceTransform[];
  rubble: InstanceTransform[];
}

/** 一层陈设（绝对坐标，便于不同楼共用同一套布置逻辑） */
function furnish(spec: InteriorSpec, rng: Rng, y: number, out: Litter): THREE.Group {
  const g = group(`room-${y.toFixed(1)}`);
  const w = spec.x1 - spec.x0;
  const d = spec.z1 - spec.z0;
  const px = (f: number): number => (spec.x0 + spec.x1) / 2 + f * w;
  const pz = (f: number): number => (spec.z0 + spec.z1) / 2 + f * d;

  const table = box(1.6, 0.07, 0.95, M.wood);
  table.position.set(px(-0.18), y + 0.34, pz(-0.1));
  table.rotation.set(0.06, 0.3, 1.35); // 侧翻
  g.add(table);
  for (let i = 0; i < 3; i += 1) {
    const chair = group('chair');
    chair.add(box(0.42, 0.05, 0.42, M.woodDark));
    chair.add(box(0.42, 0.5, 0.05, M.woodDark).translateY(0.25).translateZ(-0.2));
    chair.position.set(px(rng.range(0.02, 0.3)), y + 0.24, pz(rng.range(-0.05, 0.25)));
    chair.rotation.set(rng.range(-1.4, 1.4), rng.range(0, 3), rng.range(-1.4, 1.4));
    g.add(chair);
  }
  // 破沙发：露出弹簧
  const sofa = group('sofa');
  sofa.add(box(1.5, 0.42, 0.75, M.cloth));
  sofa.add(box(1.5, 0.6, 0.18, M.cloth).translateY(0.35).translateZ(-0.32));
  for (let i = 0; i < 4; i += 1) {
    const spring = box(0.5, 0.02, 0.02, M.iron);
    spring.position.set(-0.5 + i * 0.32, 0.44, 0.05);
    spring.rotation.z = rng.range(-0.5, 0.5);
    sofa.add(spring);
  }
  sofa.position.set(px(0.22), y + 0.21, pz(0.18));
  sofa.rotation.y = rng.range(-0.4, 0.4);
  g.add(sofa);
  // 拉开的衣柜 + 掉落的柜门
  const wardrobe = box(0.75, 1.9, 0.55, M.woodDark);
  wardrobe.position.set(px(-0.36), y + 0.95, pz(0.3));
  g.add(wardrobe);
  const doorPanel = box(0.36, 1.7, 0.04, M.wood);
  doorPanel.position.set(px(-0.25), y + 0.95, pz(0.3) + 0.3);
  doorPanel.rotation.y = 0.9;
  g.add(doorPanel);
  // 厨房残骸
  const cabinet = box(0.9, 1.5, 0.5, M.plasterDark);
  cabinet.position.set(px(0.34), y + 0.6, pz(-0.34));
  cabinet.rotation.x = 0.85;
  g.add(cabinet);
  for (let i = 0; i < 3; i += 1) {
    const pot = mesh(new THREE.CylinderGeometry(0.14, 0.11, 0.16, 8), M.iron);
    pot.position.set(px(rng.range(0.2, 0.4)), y + 0.08, pz(rng.range(-0.2, -0.42)));
    pot.rotation.z = rng.range(0, 3);
    g.add(pot);
  }
  // 避难角：沙袋 + 毯子
  for (let i = 0; i < 3; i += 1) {
    const bag = softBox(0.6, 0.24, 0.38, 0.14, M.sandbag);
    bag.position.set(px(-0.42) + (i % 2) * 0.34, y + 0.12 + Math.floor(i / 2) * 0.22, pz(-0.42) + rng.range(-0.04, 0.04));
    bag.rotation.y = rng.range(-0.3, 0.3);
    g.add(bag);
  }
  const blanket = box(0.9, 0.04, 0.7, M.cloth);
  blanket.position.set(px(-0.38), y + 0.36, pz(-0.4));
  blanket.rotation.set(rng.range(-0.1, 0.1), rng.range(0, 1), rng.range(-0.1, 0.1));
  g.add(blanket);

  // 地面散落：书 / 纸 / 瓦砾（实例化）
  for (let i = 0; i < 12; i += 1) {
    out.books.push({
      position: new THREE.Vector3(spec.x0 + 0.8 + rng.range(0, w - 1.6), y + 0.04, spec.z0 + 0.8 + rng.range(0, d - 1.6)),
      rotation: new THREE.Euler(rng.range(-0.1, 0.1), rng.range(0, 3), rng.range(-0.1, 0.1)),
      scale: new THREE.Vector3(rng.range(0.8, 1.2), 1, rng.range(0.8, 1.2)),
    });
  }
  for (let i = 0; i < 22; i += 1) {
    out.papers.push({
      position: new THREE.Vector3(spec.x0 + 0.6 + rng.range(0, w - 1.2), y + 0.03, spec.z0 + 0.6 + rng.range(0, d - 1.2)),
      rotation: new THREE.Euler(0, rng.range(0, 3), 0),
      scale: new THREE.Vector3(1, 1, 1),
    });
  }
  for (let i = 0; i < 26; i += 1) {
    out.rubble.push({
      position: new THREE.Vector3(spec.x0 + 0.5 + rng.range(0, w - 1), y + 0.05, spec.z0 + 0.5 + rng.range(0, d - 1)),
      rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)),
      scale: new THREE.Vector3(1, 1, 1).multiplyScalar(rng.range(0.5, 1.4)),
    });
  }

  // 应急灯：惨淡黄绿，自发光（不占点光预算）
  const lamp = mesh(new THREE.SphereGeometry(0.075, 8, 6), glowMaterial(0xd8e6a8, 0.9));
  lamp.position.set(spec.x0 + 1.1, y + spec.floorH - 0.65, spec.z0 + d * 0.5);
  lamp.castShadow = false;
  g.add(lamp);
  return g;
}

/**
 * 用射线量出**真实楼体**的轮廓。
 *
 * 地块矩形 ≠ 建筑实体：town.ts 只在地块里建一栋进深更小的楼（商铺尤其浅），
 * 若直接按地块满铺内构，楼板就会从楼背后穿出去（截图里那些悬空平台就是）。
 * 这里对 town 组从上往下打一片射线，命中格就是屋顶覆盖范围，
 * 取命中格的 AABB 作为楼体轮廓，再取最高命中点作为屋顶高度。
 */
function measureEnvelope(
  scene: THREE.Object3D,
  rect: Rect,
): { x0: number; x1: number; z0: number; z1: number; roofY: number } | null {
  const town = scene.getObjectByName('town');
  if (!town) return null;
  const ray = new THREE.Raycaster();
  ray.far = 60;
  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3(0, -1, 0);
  // 0.7 m 网格会打上千条射线到合并批次上（构建期明显卡顿）；2.2 m 足够量出 AABB
  const step = 2.2;

  // 采样：记录每个命中格（含高度）。只保留"上方确实有实体"的格子。
  const cols = Math.max(2, Math.floor((rect.x1 - rect.x0) / step));
  const rows = Math.max(2, Math.floor((rect.z1 - rect.z0) / step));
  const grid: Array<Array<{ x: number; z: number; y: number } | null>> = [];
  for (let r = 0; r < rows; r += 1) {
    const line: Array<{ x: number; z: number; y: number } | null> = [];
    for (let c = 0; c < cols; c += 1) {
      const x = rect.x0 + ((c + 0.5) / cols) * (rect.x1 - rect.x0);
      const z = rect.z0 + ((r + 0.5) / rows) * (rect.z1 - rect.z0);
      origin.set(x, 40, z);
      ray.set(origin, dir);
      const hit = ray.intersectObject(town, true)[0];
      line.push(hit && hit.point.y > 1.2 ? { x, z, y: hit.point.y } : null);
    }
    grid.push(line);
  }

  // 连通聚类：只取"包住地块中心"的那一团。
  // 否则邻楼的屋顶会把轮廓撑大 —— 内构就会铺到墙外去（截图里的散架就是这么来的）。
  const seen = new Set<string>();
  const clusters: Array<Array<{ x: number; z: number; y: number }>> = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const key = `${r},${c}`;
      if (seen.has(key) || !grid[r]![c]) continue;
      const cluster: Array<{ x: number; z: number; y: number }> = [];
      const stack: Array<[number, number]> = [[r, c]];
      seen.add(key);
      while (stack.length > 0) {
        const [cr, cc] = stack.pop()!;
        const cell = grid[cr]?.[cc];
        if (!cell) continue;
        cluster.push(cell);
        for (const [dr, dc] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as Array<[number, number]>) {
          const nr = cr + dr;
          const nc = cc + dc;
          const nk = `${nr},${nc}`;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          if (seen.has(nk) || !grid[nr]![nc]) continue;
          seen.add(nk);
          stack.push([nr, nc]);
        }
      }
      clusters.push(cluster);
    }
  }
  if (clusters.length === 0) return null;

  // 选中"包含距地块中心最近的格子"的那一团
  const ccx = (rect.x0 + rect.x1) / 2;
  const ccz = (rect.z0 + rect.z1) / 2;
  let best = clusters[0]!;
  let bestD = Infinity;
  for (const cluster of clusters) {
    const d = Math.min(...cluster.map((p) => (p.x - ccx) ** 2 + (p.z - ccz) ** 2));
    if (d < bestD) {
      bestD = d;
      best = cluster;
    }
  }
  if (best.length < 4) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let roofY = 0;
  for (const p of best) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
    if (p.y > roofY) roofY = p.y;
  }
  // 二次保险：轮廓夹回地块内缩范围，无论如何不得超出地块
  return {
    x0: Math.max(rect.x0 + 0.6, minX - step * 0.5),
    x1: Math.min(rect.x1 - 0.6, maxX + step * 0.5),
    z0: Math.max(rect.z0 + 0.6, minZ - step * 0.5),
    z1: Math.min(rect.z1 - 0.6, maxZ + step * 0.5),
    roofY,
  };
}

/** 一栋楼的内构 */
function buildOne(spec: InteriorSpec, rng: Rng): { obj: THREE.Group; meshes: number; litter: number } {
  const root = group('interior');
  const cx = (spec.x0 + spec.x1) / 2;
  const cz = (spec.z0 + spec.z1) / 2;
  const sx0 = spec.x0 + 1.2;
  const sx1 = spec.x0 + 3.4;
  const sz0 = spec.z0 + 1.0;
  const sz1 = spec.z0 + 4.2;

  // 楼板：拆四块拼出楼梯洞口（不用 CSG）
  for (let f = 1; f <= spec.floors; f += 1) {
    const y = f * spec.floorH;
    const parts: Array<[number, number, number, number]> = [
      [spec.x0, sx0, spec.z0, spec.z1],
      [sx1, spec.x1, spec.z0, spec.z1],
      [sx0, sx1, spec.z0, sz0],
      [sx0, sx1, sz1, spec.z1],
    ];
    for (const [x0, x1, z0, z1] of parts) {
      if (x1 - x0 < 0.1 || z1 - z0 < 0.1) continue;
      const slab = box(x1 - x0, spec.slab, z1 - z0, M.floor);
      slab.position.set((x0 + x1) / 2, y - spec.slab / 2, (z0 + z1) / 2);
      slab.receiveShadow = true;
      root.add(slab);
    }
    for (let s = 0; s < 8; s += 1) {
      const step = box(1.4, 0.16, 0.34, M.floorDark);
      step.position.set((sx0 + sx1) / 2, y - 0.35 - s * 0.34, sz1 - 0.3 - s * 0.38);
      root.add(step);
    }
  }
  // 承重隔墙：临街 / 里间，中间留 1.2 m 门洞
  for (let f = 0; f < spec.floors; f += 1) {
    const y = f * spec.floorH;
    for (const [x0, x1] of [
      [spec.x0 + 0.3, cx - 0.6],
      [cx + 0.6, spec.x1 - 0.3],
    ] as Array<[number, number]>) {
      if (x1 - x0 < 0.3) continue;
      const wall = box(x1 - x0, spec.floorH - 0.1, 0.18, M.plaster);
      wall.position.set((x0 + x1) / 2, y + (spec.floorH - 0.1) / 2, cz - 1.2);
      root.add(wall);
    }
  }
  // 地下室暗示：楼梯口下方一块纯黑
  const pit = mesh(new THREE.PlaneGeometry(2.2, 3.2), M.void);
  pit.rotation.x = -Math.PI / 2;
  pit.position.set(sx0 + 1.1, 0.03, sz0 + 1.6);
  pit.receiveShadow = false;
  root.add(pit);

  // 门套：只有可走入的楼才加（其它楼的门在 town.ts 里已经画好）
  if (spec.enterable && spec.door) {
    const door = group('door');
    const { x: dx, w: dw, h: dh } = spec.door;
    const panel = box(dw * 0.92, dh, 0.08, M.woodDark);
    panel.position.set(dx - dw * 0.5, dh / 2, spec.z1 + 0.12);
    panel.rotation.y = 1.15;
    door.add(panel);
    for (const s of [-1, 1] as const) {
      const jamb = box(0.12, dh + 0.1, 0.34, M.plasterDark);
      jamb.position.set(dx + (s * dw) / 2, (dh + 0.1) / 2, spec.z1 + 0.1);
      door.add(jamb);
    }
    const sill = box(dw, 0.12, 0.5, M.floorDark);
    sill.position.set(dx, 0.06, spec.z1 + 0.2);
    door.add(sill);
    root.add(door);
    APERTURES.push({ x0: dx - 0.85, x1: dx + 0.85, z0: spec.z1 - 3.2, z1: spec.z1 + 0.6 });
  }

  const litter: Litter = { books: [], papers: [], rubble: [] };
  for (let f = 0; f < spec.floors; f += 1) {
    root.add(furnish(spec, rng.fork(f + 1), f * spec.floorH + 0.02, litter));
  }
  if (litter.books.length > 0) {
    const b = instanced(new THREE.BoxGeometry(0.17, 0.035, 0.23), M.woodDark, litter.books);
    b.name = 'interior-books';
    const p = instanced(new THREE.PlaneGeometry(0.2, 0.28).rotateX(-Math.PI / 2), M.paper, litter.papers);
    p.name = 'interior-papers';
    p.castShadow = false;
    const r = instanced(new THREE.DodecahedronGeometry(0.09, 0), M.plasterDark, litter.rubble);
    r.name = 'interior-rubble';
    r.castShadow = false;
    root.add(b, p, r);
  }

  withOutline(root, 0.004);
  let meshes = 0;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes += 1;
  });
  return { obj: root, meshes, litter: litter.books.length + litter.papers.length + litter.rubble.length };
}

export function buildInteriors(ctx: BuildContext): THREE.Group {
  const root = group('interiors');
  const rng = ctx.rng.fork(0x1e70);
  let meshes = 0;
  let litter = 0;
  let placed = 0;
  const rejected: string[] = [];

  SPECS.forEach((raw, i) => {
    // 用真实楼体轮廓替换地块矩形（town 已建好，可以直接量）
    const env = measureEnvelope(ctx.root, raw);
    if (!env) {
      rejected.push(`${raw.note}(未量到楼体)`);
      return;
    }
    const fit: InteriorSpec = {
      ...raw,
      // 2.2 m 采样网格会带来约 1 m 的轮廓误差，再内缩 1.1 m 兜住，
      // 保证任何构件都不会伸出真实墙体（之前 0.35 m 会让楼板从墙外露出来）
      x0: env.x0 + 1.1,
      x1: env.x1 - 1.1,
      z0: env.z0 + 1.1,
      z1: env.z1 - 1.1,
      // 楼比图纸矮时按实际屋顶收层，避免楼板穿出屋面
      floors: Math.max(1, Math.min(raw.floors, Math.floor((env.roofY - 0.8) / raw.floorH))),
    };
    // 门只对可走入的样板楼有意义，且必须落在量到的临街面上
    const door =
      fit.enterable && fit.door
        ? {
            ...fit.door,
            x: Math.min(Math.max(fit.door.x, fit.x0 + 1.2), fit.x1 - 1.2),
          }
        : undefined;
    const spec: InteriorSpec = { ...fit, door };

    const built = buildOne(spec, rng.fork(i + 1));
    meshes += built.meshes;
    litter += built.litter;
    placed += 1;
    const lod = new THREE.LOD();
    lod.name = `interior-lod-${i}`;
    lod.addLevel(built.obj, 0);
    lod.addLevel(new THREE.Object3D(), 85);
    root.add(lod);
  });

  console.info(
    `[interiors] 落位 ${placed}/${SPECS.length} 栋（${SPECS.filter((s) => s.enterable).length} 栋可走入）｜mesh ${meshes}｜实例化小件 ${litter}` +
      (rejected.length ? `｜跳过：${rejected.join('、')}` : ''),
  );
  return root;
}
