import * as THREE from 'three';
import type { BuildContext } from '../core/context';
import type { Rng } from '../core/rng';
import {
  batchGroupByMaterial,
  box,
  cyl,
  group,
  instanced,
  mergeOutlineHulls,
  mesh,
  softBox,
  type InstanceTransform,
} from '../core/geo';
import { PALETTE } from '../core/palette';
import { glowMaterial, toonMaterial, withOutline } from '../core/materials';
import { ALLEYS, BASE, HERO, TOWN_PLOTS, isOnRoadCorridor, type Rect } from './layout';
import { noteRefusal, reserve } from './occupancy';

/**
 * 空地填充：先扫描、再按空地尺寸决定内容，而不是往建筑里硬塞。
 *
 * 扫描域 = 核心区（|x|,|z| ≤ 72）+ 内圈带（74..90）。理由：
 *  - 核心区有完整的地块数据（TOWN_PLOTS / HERO），能精确判空；
 *  - 三个新分区的建筑足迹没有集中登记，盲扫会压到楼里，所以只扫这两个已知域。
 *
 * 结论会随地图密度变化：本图核心已经排满，扫描器主要会找到巷子与地块间隙，
 * 于是产出以"路障与哨卡"为主；足够大的空地才会升级成营地 / 残骸区。
 *
 * 碰撞体统一导出（viewMode 消费同一份 rect），不再各自维护一套。
 */

const COLLIDERS: Rect[] = [];
/** 与 reserve() 一致的申请安全边距：扫描阶段就要算进去，否则会生成一堆互相挨太近、注定被拒的点 */
const CLAIM_PAD = 0.3;

/** 供第一人称取用的碰撞矩形（含本次填充产生的） */
export function fillColliders(): Rect[] {
  return COLLIDERS;
}

interface Spot {
  rect: Rect;
  cx: number;
  cz: number;
  size: number;
}

/** 与 roads / 既有地块 / 主楼 / 已选中的空地互不重叠 */
const EXISTING: Rect[] = [
  ...TOWN_PLOTS.map((p) => ({ x0: p.x0, x1: p.x1, z0: p.z0, z1: p.z1 })),
  { x0: HERO.x0, x1: HERO.x1, z0: HERO.z0, z1: HERO.z1 },
  // 巷道是设计好的步行动线，不往里塞东西（第一人称探索的价值在这里）
  ...ALLEYS.map((a) => ({ x0: a.x0, x1: a.x1, z0: a.z0, z1: a.z1 })),
];

function overlaps(a: Rect, b: Rect, pad = 0): boolean {
  return a.x0 < b.x1 + pad && a.x1 > b.x0 - pad && a.z0 < b.z1 + pad && a.z1 > b.z0 - pad;
}

function expand(r: Rect, pad: number): Rect {
  return { x0: r.x0 - pad, x1: r.x1 + pad, z0: r.z0 - pad, z1: r.z1 + pad };
}

function free(rect: Rect, chosen: Rect[]): boolean {
  if (isOnRoadCorridor((rect.x0 + rect.x1) / 2, (rect.z0 + rect.z1) / 2, 0)) return false;
  // 四角也要在走廊外，否则会压到人行道
  for (const [x, z] of [
    [rect.x0, rect.z0],
    [rect.x1, rect.z0],
    [rect.x0, rect.z1],
    [rect.x1, rect.z1],
  ] as Array<[number, number]>) {
    if (isOnRoadCorridor(x, z, 0.4)) return false;
  }
  if (EXISTING.some((r) => overlaps(rect, r))) return false;
  if (chosen.some((r) => overlaps(expand(rect, CLAIM_PAD), expand(r, CLAIM_PAD)) && overlaps(rect, r))) return false;
  if (chosen.some((r) => overlaps(rect, r, CLAIM_PAD))) return false;
  return true;
}

/**
 * 贪心扫描：先按 8 m 找营地，再 5 m 找残骸，最后 3 m 找路障。
 * 同一块空地只放一次——大块被占掉后，小块自然落在别处。
 */
export function scanEmptySpots(): Spot[] {
  const spots: Spot[] = [];
  const chosen: Rect[] = [];
  const tiers: Array<{ size: number; step: number; limit: number }> = [
    { size: 8, step: 2, limit: 2 },
    { size: 5, step: 2, limit: 4 },
    { size: 3, step: 1.5, limit: 9 },
  ];
  for (const tier of tiers) {
    let found = 0;
    for (let z = -BASE.coreHalf + tier.size / 2; z <= BASE.coreHalf - tier.size / 2 && found < tier.limit; z += tier.step) {
      for (let x = -BASE.coreHalf + tier.size / 2; x <= BASE.coreHalf - tier.size / 2 && found < tier.limit; x += tier.step) {
        // 内圈带也纳入扫描
        const inCore = Math.abs(x) <= BASE.coreHalf && Math.abs(z) <= BASE.coreHalf;
        const inRing =
          (Math.abs(x) <= BASE.coreHalf && Math.abs(z) > 74 && Math.abs(z) < 89) ||
          (Math.abs(z) <= BASE.coreHalf && Math.abs(x) > 74 && Math.abs(x) < 89);
        if (!inCore && !inRing) continue;
        const rect: Rect = {
          x0: x - tier.size / 2,
          x1: x + tier.size / 2,
          z0: z - tier.size / 2,
          z1: z + tier.size / 2,
        };
        if (!free(rect, chosen)) continue;
        chosen.push(rect);
        spots.push({ rect, cx: x, cz: z, size: tier.size });
        found += 1;
      }
    }
  }
  return spots;
}

/* ------------------------------------------------------------------ *
 * 材料（全部三渲二 + 描边）
 * ------------------------------------------------------------------ */

const M = {
  sandbag: toonMaterial(PALETTE.sandbag, { steps: 2 }),
  sandbagDark: toonMaterial(PALETTE.sandbagDark, { steps: 2 }),
  crate: toonMaterial(PALETTE.woodOld, { steps: 2 }),
  tent: toonMaterial(0x4b5342, { steps: 2 }),
  tentDark: toonMaterial(0x3a4135, { steps: 2 }),
  tire: toonMaterial(PALETTE.tire, { steps: 2 }),
  board: toonMaterial(PALETTE.woodDark, { steps: 2 }),
  brick: toonMaterial(PALETTE.brick, { steps: 2 }),
  brickDark: toonMaterial(PALETTE.brickDark, { steps: 2 }),
  steel: toonMaterial(0x3c4249, { steps: 2 }),
  burnt: toonMaterial(PALETTE.burntVehicle, { steps: 2 }),
  canvas: toonMaterial(0x555c48, { steps: 2 }),
};

/** 一顶帐篷：三角脊 + 两块垂布 + 褶皱棱线 */
function tent(rng: Rng, w: number, d: number, h: number): THREE.Group {
  const g = group('tent');
  const body = mesh(new THREE.CylinderGeometry(w * 0.5, w * 0.5, d, 3, 1, false, 0, Math.PI), M.tent);
  body.rotation.z = Math.PI / 2;
  body.rotation.y = Math.PI / 2;
  body.scale.set(1, h / (w * 0.5), 1);
  body.position.y = h * 0.5;
  g.add(body);
  // 门帘：一块下垂的布，带褶皱
  for (let i = 0; i < 3; i += 1) {
    const flap = box(w * 0.34, h * 0.8, 0.05, i % 2 === 0 ? M.tentDark : M.tent);
    flap.position.set(rng.range(-w * 0.2, w * 0.2), h * 0.34, (d * 0.5 + 0.03) * (i === 1 ? -1 : 1));
    flap.rotation.x = rng.range(-0.22, 0.22);
    flap.rotation.z = rng.range(-0.12, 0.12);
    g.add(flap);
  }
  // 脊线与地钉
  const ridge = cyl(0.03, 0.03, d * 1.02, 4, M.steel);
  ridge.rotation.x = Math.PI / 2;
  ridge.position.y = h * 0.98;
  g.add(ridge);
  return g;
}

/** 篝火：石圈 + 交叉柴 + 火芯 + 点光 */
function campfire(ctx: BuildContext, rng: Rng): THREE.Group {
  const g = group('campfire');
  for (let i = 0; i < 9; i += 1) {
    const a = (i / 9) * Math.PI * 2 + rng.range(-0.12, 0.12);
    const stone = mesh(new THREE.DodecahedronGeometry(rng.range(0.12, 0.2), 0), M.steel);
    stone.position.set(Math.cos(a) * 0.62, 0.08, Math.sin(a) * 0.62);
    stone.scale.y = 0.7;
    g.add(stone);
  }
  for (let i = 0; i < 5; i += 1) {
    const log = cyl(0.055, 0.07, 0.9, 5, M.board);
    log.rotation.set(Math.PI / 2, 0, (i / 5) * Math.PI + rng.range(-0.2, 0.2));
    log.position.y = 0.16;
    g.add(log);
  }
  const ember = mesh(new THREE.ConeGeometry(0.26, 0.7, 6), glowMaterial(0xff7a2f, 0.95));
  ember.position.y = 0.34;
  ember.castShadow = false;
  g.add(ember);
  const core = mesh(new THREE.ConeGeometry(0.14, 0.42, 6), glowMaterial(0xffd28a, 1));
  core.position.y = 0.26;
  core.castShadow = false;
  g.add(core);
  const light = new THREE.PointLight(0xff8a3c, 3.2, 13, 2);
  light.position.set(0, 1.1, 0);
  ctx.addLight(light);
  // 跳动：只改缩放与光强，不新增对象
  ctx.ticker.add((t) => {
    const f = 0.82 + 0.18 * Math.sin(t * 11.3) + 0.08 * Math.sin(t * 27.1);
    ember.scale.set(0.9 + f * 0.18, 0.8 + f * 0.3, 0.9 + f * 0.18);
    core.scale.setScalar(0.85 + f * 0.2);
    light.intensity = 2.6 + f * 1.1;
  });
  return g;
}

/** 半埋的坦克残骸：倾斜炮塔 + 散落履带板 + 焦黑 */
function wreckTank(rng: Rng): THREE.Group {
  const g = group('wreck-tank');
  const hull = mesh(new THREE.CylinderGeometry(1.3, 1.45, 4.4, 6), M.burnt);
  hull.rotation.x = Math.PI / 2;
  hull.position.y = 0.32;
  hull.rotation.z = rng.range(-0.06, 0.06);
  hull.scale.y = 0.62;
  g.add(hull);
  const turret = mesh(new THREE.CylinderGeometry(0.95, 1.15, 0.6, 7), M.burnt);
  turret.position.set(rng.range(-0.2, 0.2), 0.85, -0.3);
  turret.rotation.set(rng.range(0.1, 0.28), rng.range(-0.5, 0.5), rng.range(-0.18, 0.18));
  g.add(turret);
  const gun = cyl(0.075, 0.09, 3.0, 6, M.steel);
  gun.rotation.set(Math.PI / 2.3, 0, rng.range(-0.3, 0.3));
  gun.position.set(0.2, 1.05, 1.4);
  g.add(gun);
  // 断裂履带：一节一节散在土里
  for (let i = 0; i < 9; i += 1) {
    const pad = box(0.6, 0.09, 0.38, M.steel);
    pad.position.set(rng.range(-2.2, 2.2), 0.05, rng.range(-2.6, 2.6));
    pad.rotation.set(rng.range(-0.2, 0.2), rng.range(0, 3), rng.range(-0.2, 0.2));
    g.add(pad);
  }
  // 余烬红光
  const ember = mesh(new THREE.SphereGeometry(0.16, 6, 5), glowMaterial(0xff5722, 0.6));
  ember.position.set(0.1, 0.72, -0.1);
  ember.castShadow = false;
  g.add(ember);
  return g;
}

/** 半塌砖墙：错缝砖块逐块立起来（实例化） */
function brickWall(inst: { strong: InstanceTransform[]; dark: InstanceTransform[] }, rng: Rng, x: number, z: number, w: number, h: number): void {
  const rows = Math.floor(h / 0.08);
  const cols = Math.floor(w / 0.26);
  for (let r = 0; r < rows; r += 1) {
    // 越往上塌得越多：顶部只留零星几块
    const keep = r < rows * 0.6 ? 1 : r < rows * 0.85 ? 0.55 : 0.22;
    for (let c = 0; c < cols; c += 1) {
      if (rng.next() > keep) continue;
      const off = r % 2 === 0 ? 0.13 : 0;
      const item: InstanceTransform = {
        position: new THREE.Vector3(x + c * 0.26 + off + rng.range(-0.01, 0.01), r * 0.08 + 0.04, z + rng.range(-0.015, 0.015)),
        rotation: new THREE.Euler(rng.range(-0.03, 0.03), rng.range(-0.06, 0.06), rng.range(-0.03, 0.03)),
        scale: new THREE.Vector3(1, 1, 1),
      };
      (rng.chance(0.7) ? inst.strong : inst.dark).push(item);
    }
  }
}

/** 路障：轮胎 + 木板 + 应急红灯 */
function barricade(ctx: BuildContext, rng: Rng, w: number, d: number): THREE.Group {
  const g = group('barricade');
  const n = Math.max(2, Math.round(w / 1.1));
  for (let i = 0; i < n; i += 1) {
    const t = cyl(0.34, 0.34, 0.26, 10, M.tire);
    t.rotation.set(Math.PI / 2, rng.range(-0.2, 0.2), rng.range(0, 3));
    t.position.set(-w / 2 + (i + 0.5) * (w / n), rng.range(0.28, 0.62), rng.range(-d * 0.2, d * 0.2));
    g.add(t);
  }
  for (let i = 0; i < 3; i += 1) {
    const b = box(w * rng.range(0.5, 0.9), 0.07, 0.24, M.board);
    b.position.set(rng.range(-w * 0.2, w * 0.2), 0.5 + i * 0.12, rng.range(-0.3, 0.3));
    b.rotation.set(rng.range(-0.1, 0.1), rng.range(-0.4, 0.4), rng.range(-0.16, 0.16));
    g.add(b);
  }
  // 应急红灯：挂在路障一侧的木杆上，缓慢闪烁
  const pole = cyl(0.045, 0.05, 1.9, 5, M.steel);
  pole.position.set(w * 0.42, 0.95, 0);
  g.add(pole);
  const lamp = mesh(new THREE.SphereGeometry(0.13, 8, 6), glowMaterial(0xff4b3e, 1));
  lamp.position.set(w * 0.42, 1.95, 0);
  lamp.castShadow = false;
  g.add(lamp);
  ctx.ticker.add((t) => {
    const blink = Math.sin(t * 2.6) > 0.55 ? 1 : 0.12;
    (lamp.material as THREE.MeshBasicMaterial).opacity = blink;
  });
  // 弹壳与丢弃的防毒面具（小件，不描边）
  for (let i = 0; i < 7; i += 1) {
    const shell = cyl(0.015, 0.018, rng.range(0.08, 0.14), 5, M.brickDark);
    shell.rotation.set(Math.PI / 2, rng.range(0, 3), rng.range(0, 3));
    shell.position.set(rng.range(-w * 0.5, w * 0.5), 0.04, rng.range(-d * 0.4, d * 0.4));
    shell.castShadow = false;
    g.add(shell);
  }
  return g;
}

/* ------------------------------------------------------------------ *
 * 组装
 * ------------------------------------------------------------------ */

export function buildFills(ctx: BuildContext): THREE.Group {
  const root = group('empty-fills');
  const rng = ctx.rng.fork(0xf111);
  const spots = scanEmptySpots();
  const bagA: InstanceTransform[] = [];
  const bagB: InstanceTransform[] = [];
  const crateA: InstanceTransform[] = [];
  const brickStrong: InstanceTransform[] = [];
  const brickDark: InstanceTransform[] = [];

  let camps = 0;
  let wrecks = 0;
  let barricades = 0;

  for (const spot of spots) {
    // 统一占位校验：与道路/铁路/其它 prop 相交就放弃这个点（而不是硬塞）
    const claim = reserve(spot.rect, 'prop', `fill:${spot.size}@${spot.cx},${spot.cz}`, CLAIM_PAD);
    if (!claim.ok) {
      noteRefusal(`fill:${spot.cx},${spot.cz}`, claim.reason ?? 'occupancy conflict');
      continue;
    }
    const local = group(`fill-${spot.size}`);
    local.position.set(spot.cx, 0.045, spot.cz);
    const half = spot.size / 2;
    const solid = half * 0.6;
    COLLIDERS.push({
      x0: spot.cx - solid,
      x1: spot.cx + solid,
      z0: spot.cz - solid,
      z1: spot.cz + solid,
    });

    if (spot.size >= 8) {
      camps += 1;
      // 营地：两顶帐篷 + 篝火 + 沙袋圈 + 弹药箱
      const t1 = tent(rng, 3.0, 3.6, 2.0);
      withOutline(t1, 0.005);
      t1.position.set(-1.9, 0, -1.6);
      t1.rotation.y = rng.range(-0.4, 0.4);
      local.add(t1);
      const t2 = tent(rng, 2.4, 2.9, 1.7);
      t2.position.set(1.8, 0, 1.5);
      t2.rotation.y = Math.PI + rng.range(-0.5, 0.5);
      local.add(t2);
      const fire = campfire(ctx, rng);
      fire.position.set(rng.range(-0.6, 0.6), 0, rng.range(-0.6, 0.6));
      local.add(fire);
      // 沙袋半环（实例化）
      for (let i = 0; i < 14; i += 1) {
        const a = Math.PI * 0.15 + (i / 14) * Math.PI * 0.7;
        bagA.push({
          position: new THREE.Vector3(spot.cx + Math.cos(a) * 3.1, 0.16, spot.cz + Math.sin(a) * 3.1),
          rotation: new THREE.Euler(0, -a + rng.range(-0.2, 0.2), rng.range(-0.08, 0.08)),
          scale: new THREE.Vector3(1, 1, 1),
        });
      }
      for (let i = 0; i < 6; i += 1) {
        crateA.push({
          position: new THREE.Vector3(spot.cx + rng.range(-2.6, 2.6), 0.18 + (i % 2) * 0.34, spot.cz + rng.range(-2.6, 2.6)),
          rotation: new THREE.Euler(0, rng.range(0, 3), 0),
          scale: new THREE.Vector3(1, 1, 1),
        });
      }
    } else if (spot.size >= 5) {
      wrecks += 1;
      const tank = wreckTank(rng);
      withOutline(tank, 0.005);
      tank.position.set(rng.range(-0.8, 0.8), 0, rng.range(-0.8, 0.8));
      tank.rotation.y = rng.range(0, 6.28);
      local.add(tank);
      brickWall({ strong: brickStrong, dark: brickDark }, rng, spot.cx - half + 0.4, spot.cz + half - 1.0, 2.6, 1.6);
      // 生活小物：翻倒的童车、书
      const pram = box(0.5, 0.34, 0.7, M.canvas);
      pram.position.set(spot.cx + 1.6, 0.2, spot.cz - 1.5);
      pram.rotation.set(rng.range(0.4, 0.8), rng.range(0, 3), rng.range(-0.3, 0.3));
      local.add(pram);
      for (let i = 0; i < 5; i += 1) {
        const book = box(0.16, 0.03, 0.22, M.board);
        book.position.set(spot.cx + rng.range(-1.8, 1.8), 0.05, spot.cz + rng.range(-1.8, 1.8));
        book.rotation.set(0, rng.range(0, 3), rng.range(-0.1, 0.1));
        book.castShadow = false;
        local.add(book);
      }
    } else {
      barricades += 1;
      local.add(barricade(ctx, rng, Math.min(3.0, spot.size * 0.8), Math.min(2.2, spot.size * 0.6)));
      for (let i = 0; i < 4; i += 1) {
        bagB.push({
          position: new THREE.Vector3(spot.cx + rng.range(-1.2, 1.2), 0.16, spot.cz + rng.range(-1.2, 1.2)),
          rotation: new THREE.Euler(0, rng.range(0, 3), rng.range(-0.08, 0.08)),
          scale: new THREE.Vector3(0.9, 0.9, 0.9),
        });
      }
    }
    root.add(local);
  }

  // —— 实例化批次 ——
  const bagGeo = softBox(0.62, 0.26, 0.4, 0.16, M.sandbag).geometry;
  for (const [list, mat, name] of [
    [bagA, M.sandbag, 'fill-sandbags'],
    [bagB, M.sandbagDark, 'fill-sandbags-b'],
  ] as Array<[InstanceTransform[], THREE.Material, string]>) {
    if (list.length === 0) continue;
    const inst = instanced(bagGeo, mat, list);
    inst.name = name;
    inst.castShadow = false;
    root.add(inst);
  }
  if (crateA.length > 0) {
    const inst = instanced(new THREE.BoxGeometry(0.62, 0.44, 0.46), M.crate, crateA);
    inst.name = 'fill-crates';
    root.add(inst);
  }
  for (const [list, mat, name] of [
    [brickStrong, M.brick, 'fill-bricks'],
    [brickDark, M.brickDark, 'fill-bricks-dark'],
  ] as Array<[InstanceTransform[], THREE.Material, string]>) {
    if (list.length === 0) continue;
    const inst = instanced(new THREE.BoxGeometry(0.25, 0.075, 0.12), mat, list);
    inst.name = name;
    inst.castShadow = false;
    root.add(inst);
  }

  // —— 全部静态：描边壳合并一次，再按材质合批 ——
  // 空地填充是 300+ 件独立网格、300+ 次 draw call 的最大来源；合并后只剩十几次。
  // 闪烁的警灯/篝火是 isNightGlow 材质，已由 batchGroupByMaterial 豁免，动画不受影响。
  mergeOutlineHulls(root, 'fill-outline');
  root.traverse((o) => {
    if (o.userData['hasOutline']) o.userData['hasOutline'] = false;
  });
  batchGroupByMaterial(root, 'fill-batch');

  root.userData['fills'] = { camps, wrecks, barricades, spots: spots.length };
  console.info(`[fills] 空地点 ${spots.length}｜营地 ${camps}｜残骸区 ${wrecks}｜路障 ${barricades}`);
  return root;
}
