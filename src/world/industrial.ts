import * as THREE from 'three';
import type { BuildContext } from '../core/context';
import type { Rng } from '../core/rng';
import { createRng } from '../core/rng';
import { jitter, type InstanceTransform } from '../core/geo';
import { brickGeometry, chippedSlab, debrisRing, mergeAll, windowFrameGeometry } from '../core/detail';
import { basicMaterial, canvasTexture, toonMaterial, withOutline } from '../core/materials';
import { PALETTE } from '../core/palette';
import { HOTSPOTS, RAIL, ZONES, canPlace, hitsCarriageway, insideBase, type Rect } from './layout';

/**
 * 废弃工业区：东境厂区（indN / indS）、南端装卸场（indSiding）与正线上的车辆。
 *
 * 画面条目（美术总监清单）逐条对应：
 *  A. 半坍塌红砖厂房：锯齿天窗（玻璃残片成排、半数碎裂）+ 屋面塌洞（露出钢屋架、桁架
 *     与地面上的碎机械剪影）+ 墙面破口（错缝砖芯立体凸起 + 外露扭曲钢筋）+ 成束烟囱的焦黑流痕。
 *  B. 生锈巨型储水罐：环形焊缝带 + 外露铆钉圈 + 绕罐螺旋爬梯 + 顶部护栏 + 断裂输水管；
 *     锈蚀全部用**色块几何**分层（四档锈色 + 竖向流痕），不用贴图。
 *  C. 车辆：棚车（滑门 + 门把手 + 锁钩）、罐车、平车（裸枕木与原木），derailed 点位一节
 *     斜出轨距的漏斗车（车体侧倾、轮对悬空、滑板与制动缸外露、车顶撞裂）+ 脱轨拖痕
 *     （撕裂枕木、切断的钢轨切片、散落轮对与货物木箱）。
 *  D. 硬表面：门窗真实凹陷进深、铰链/把手/锁扣、管道法兰与卡箍、罐体与管架的工字钢截面、
 *     地面道钉 / 油污 / 散落螺栓 / 钢轨切片。
 *  E. 叙事：装卸站台边缘被砸烂的黄色油漆线、倒塌的门式吊车梁、成排油桶与倾覆集装箱、
 *     煤堆与砂石堆（instanced 碎块 + 推土痕迹）、厂区铁丝网围栏（立柱 + 网面 + 剪开的口子）。
 *     变电站残骸属于别的模块，这里不做。
 *  F. 暖色与动效：厂房深处余烬火苗 + 故障厂区路灯不规则闪烁 + 塌顶与烟囱飘散的黑烟
 *    （自建少量 instanced 面片，不改 fx/smoke.ts）。真实点光只申请 2 盏。
 *
 * 工程约定：
 *  - 一切落位矩形都必须过 `canPlace()`；铁路资产（车厢 / 信号机 / 围栏门 / 道口杆）走
 *    `canPlaceRail()`——同样严禁压车行道，但允许落在 RAIL 走廊内。
 *  - 零件按材质 + 描边 + 阴影合并成极少数网格（`Sink`），碎件一律 instanced。
 *  - `withOutline()` 只给剪影体块；far 档不描边、不投影（阴影相机只覆盖中段）。
 *  - 随机一律来自 `ctx.rng.fork(...)`，禁止 Math.random()。
 */

/* ------------------------------------------------------------------ *
 * 0. 工具与 LOD
 * ------------------------------------------------------------------ */

const TAU = Math.PI * 2;

/** 色板颜色在线性空间里压暗：雨夜里所有工业材质都要被水与烟熏旧一层 */
function dim(hex: number, k: number): number {
  const c = new THREE.Color(hex);
  c.multiplyScalar(k);
  return c.getHex();
}

/** 确定性 hash（FX 相位用，避免每帧随机） */
function hash2(a: number, b: number): number {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

const clamp = THREE.MathUtils.clamp;

type Tier = 'near' | 'mid' | 'far';

interface Lod {
  tier: Tier;
  dist: number;
  /** 逐砖 / 逐螺栓级精细件是否生成 */
  fine: boolean;
  /** 剪影体块是否描边 */
  outline: boolean;
  /** 是否投影：far 一律 false，且阴影相机只覆盖中段（±86） */
  shadow: boolean;
}

function lodAt(x: number, z: number): Lod {
  const dist = Math.hypot(x, z);
  const tier: Tier = dist < 95 ? 'near' : dist < 120 ? 'mid' : 'far';
  return {
    tier,
    dist,
    fine: tier !== 'far',
    outline: tier !== 'far',
    shadow: tier !== 'far' && Math.max(Math.abs(x), Math.abs(z)) <= 86,
  };
}

function rectOf(x0: number, x1: number, z0: number, z1: number): Rect {
  return { x0, x1, z0, z1 };
}

/** 把矩形收进 zone 边界内（Zone.margin 是建筑到边界必须留出的间距） */
function fitZone(r: Rect, z: Rect, margin: number): Rect {
  return {
    x0: Math.max(r.x0, z.x0 + margin),
    x1: Math.min(r.x1, z.x1 - margin),
    z0: Math.max(r.z0, z.z0 + margin),
    z1: Math.min(r.z1, z.z1 - margin),
  };
}

function zoneRect(id: string): Rect {
  const z = ZONES.find((v) => v.id === id);
  return z ? { x0: z.x0, x1: z.x1, z0: z.z0, z1: z.z1 } : rectOf(0, 1, 0, 1);
}

const IND_ZONES = ZONES.filter((z) => z.use === 'industrial');
/** 装卸场的建筑退线（Zone.margin） */
const SIDING_MARGIN = IND_ZONES.find((z) => z.id === 'indSiding')?.margin ?? 0.6;

/** 普通资产：必须过 canPlace */
function guard(rect: Rect, label: string, pad = 0): void {
  if (!canPlace(rect, pad)) {
    console.warn(`[industrial] canPlace 未过：${label}`, rect, { pad });
  }
}

const MAIN_CORRIDOR = { x0: RAIL.at - 5.4, x1: RAIL.at + 5.4, z0: RAIL.from, z1: RAIL.to };
const SPUR_CORRIDOR = { x0: RAIL.spur.from, x1: RAIL.spur.to, z0: RAIL.spur.at - 5.4, z1: RAIL.spur.at + 5.4 };

/** 铁路资产（车厢、信号机、转辙器、围栏门）：绝不允许压车行道，允许在铁路走廊内 */
function railGuard(rect: Rect, label: string, o: { spill?: boolean } = {}): void {
  if (hitsCarriageway(rect, 0)) console.warn(`[industrial] 铁路资产压车行道：${label}`, rect);
  if (!insideBase(rect)) console.warn(`[industrial] 铁路资产越出底座：${label}`, rect);
  if (o.spill) return; // 脱轨的车体本来就该甩在线路之外
  const inMain = rect.x0 >= MAIN_CORRIDOR.x0 && rect.x1 <= MAIN_CORRIDOR.x1 && rect.z0 >= MAIN_CORRIDOR.z0 && rect.z1 <= MAIN_CORRIDOR.z1;
  const inSpur = rect.z0 >= SPUR_CORRIDOR.z0 && rect.z1 <= SPUR_CORRIDOR.z1 && rect.x0 >= SPUR_CORRIDOR.x0 && rect.x1 <= SPUR_CORRIDOR.x1;
  if (!inMain && !inSpur) console.warn(`[industrial] 铁路资产不在铁路走廊内：${label}`, rect);
}

/* ------------------------------------------------------------------ *
 * 1. 材质（共享缓存；合并批次按材质分桶）
 * ------------------------------------------------------------------ */

const M = {
  // —— 砖与抹灰 ——
  brick: toonMaterial(dim(PALETTE.brick, 0.6), { steps: 3 }),
  brickMid: toonMaterial(dim(PALETTE.brick, 0.5), { steps: 3 }),
  brickDark: toonMaterial(dim(PALETTE.brickDark, 0.66), { steps: 3 }),
  brickCore: toonMaterial(dim(PALETTE.brick, 0.44), { steps: 2 }),
  brickCoreDark: toonMaterial(dim(PALETTE.brickDark, 0.52), { steps: 2 }),
  plaster: toonMaterial(dim(PALETTE.plaster, 0.52), { steps: 3 }),
  plasterCold: toonMaterial(dim(PALETTE.plasterCold, 0.54), { steps: 3 }),
  // —— 混凝土与钢 ——
  concrete: toonMaterial(dim(PALETTE.concrete, 0.56), { steps: 3 }),
  concreteDark: toonMaterial(dim(PALETTE.concreteDark, 0.62), { steps: 3 }),
  steel: toonMaterial(dim(0x6c757e, 0.62), { steps: 3 }),
  metal: toonMaterial(dim(PALETTE.metalDoor, 0.66), { steps: 3 }),
  metalDark: toonMaterial(dim(0x474f58, 0.78), { steps: 2 }),
  railSteel: toonMaterial(dim(0x59616a, 0.7), { steps: 2 }),
  wire: toonMaterial(dim(0x5b636c, 0.6), { steps: 2 }),
  // —— 锈（色块分层的四档）——
  rust: toonMaterial(dim(PALETTE.rust, 0.74), { steps: 3 }),
  rustDark: toonMaterial(dim(PALETTE.rustDark, 0.78), { steps: 3 }),
  rustWarm: toonMaterial(dim(0x8a5a33, 0.7), { steps: 3 }),
  rustDeep: toonMaterial(dim(0x3f2a1e, 0.9), { steps: 2 }),
  // —— 屋面 / 铁皮 ——
  roof: toonMaterial(dim(PALETTE.roof, 0.6), { steps: 3 }),
  roofDark: toonMaterial(dim(0x4a4e55, 0.66), { steps: 3 }),
  roofRust: toonMaterial(dim(PALETTE.roofRust, 0.62), { steps: 3 }),
  // —— 木 ——
  wood: toonMaterial(dim(PALETTE.woodOld, 0.7), { steps: 3 }),
  woodDark: toonMaterial(dim(PALETTE.woodDark, 0.78), { steps: 3 }),
  board: toonMaterial(dim(0x9d8e73, 0.6), { steps: 2 }),
  // —— 玻璃 / 洞口 ——
  glass: toonMaterial(dim(PALETTE.glassDark, 0.95), { steps: 2 }),
  glassBroken: toonMaterial(dim(PALETTE.glassBroken, 0.8), { steps: 2 }),
  reveal: toonMaterial(dim(0x22262a, 0.95), { steps: 2 }),
  dark: toonMaterial(0x14171a, { steps: 2 }),
  // —— 烧灼 ——
  burnt: toonMaterial(PALETTE.burnt, { steps: 2 }),
  soot: toonMaterial(PALETTE.soot, { steps: 2 }),
  // —— 地面 ——
  dirt: toonMaterial(dim(PALETTE.dirt, 0.82), { steps: 2 }),
  mud: toonMaterial(dim(PALETTE.mud, 0.84), { steps: 2 }),
  coal: toonMaterial(0x1b1d21, { steps: 2 }),
  gravel: toonMaterial(dim(0x5f605a, 0.68), { steps: 3 }),
  weed: toonMaterial(0x2b3327, { steps: 2 }),
  // —— 涂装（全部去饱和）——
  paint: toonMaterial(dim(PALETTE.paint, 0.72), { steps: 2 }),
  paintYellow: toonMaterial(dim(0xc2a03f, 0.62), { steps: 2 }),
  paintRed: toonMaterial(dim(PALETTE.fabricRed, 0.72), { steps: 2 }),
  signGreen: toonMaterial(dim(PALETTE.signGreen, 0.78), { steps: 2 }),
  container: toonMaterial(dim(0x5c6a55, 0.66), { steps: 3 }),
  containerAlt: toonMaterial(dim(0x4d5c68, 0.66), { steps: 3 }),
  barrel: toonMaterial(dim(PALETTE.barrelRust, 0.7), { steps: 3 }),
};

/** 半透贴地贴片（油污、尘圈、焦痕） */
const oilMat = basicMaterial(0x14181d, { opacity: 0.44, transparent: true, fog: true });
const dustMat = basicMaterial(0x2a2620, { opacity: 0.32, transparent: true, fog: true });
const rustStainMat = basicMaterial(0x3a2418, { opacity: 0.34, transparent: true, fog: true });

/* ------------------------------------------------------------------ *
 * 2. 碎件几何变体（只造一次，全局共享 → 同材质同几何自动并成一个 InstancedMesh）
 * ------------------------------------------------------------------ */

function cached<T>(make: () => T): () => T {
  let v: T | null = null;
  return () => {
    if (v === null) v = make();
    return v as T;
  };
}

const localRng = createRng('industrial-variants');

const G = {
  brick: cached(() => brickGeometry(localRng.fork(11))),
  chipA: cached(() => chippedSlab(1.15, 0.95, 0.12, localRng.fork(21), 0.26)),
  chipB: cached(() => chippedSlab(0.85, 1.15, 0.1, localRng.fork(22), 0.22)),
  chipC: cached(() => chippedSlab(1.35, 0.7, 0.14, localRng.fork(23), 0.3)),
  debris: cached(() => new THREE.TetrahedronGeometry(0.1, 0)),
  chunkA: cached(() => jitter(new THREE.DodecahedronGeometry(0.5, 0), 0.1, localRng.fork(31))),
  chunkB: cached(() => jitter(new THREE.DodecahedronGeometry(0.42, 0), 0.1, localRng.fork(32))),
  chunkC: cached(() => jitter(new THREE.IcosahedronGeometry(0.46, 0), 0.09, localRng.fork(33))),
  bolt: cached(() => new THREE.CylinderGeometry(0.055, 0.055, 0.06, 6)),
  spike: cached(() => new THREE.BoxGeometry(0.06, 0.09, 0.06)),
  wheel: cached(() => new THREE.CylinderGeometry(0.45, 0.45, 0.13, 14)),
  hub: cached(() => new THREE.CylinderGeometry(0.16, 0.16, 0.26, 8)),
  tire: cached(() => new THREE.TorusGeometry(0.45, 0.075, 5, 14)),
  rivet: cached(() => new THREE.BoxGeometry(0.09, 0.09, 0.07)),
  rung: cached(() => new THREE.BoxGeometry(0.46, 0.045, 0.05)),
  leaf: cached(() => new THREE.TorusGeometry(0.3, 0.055, 4, 8, Math.PI)),
  weedTuft: cached(() => new THREE.ConeGeometry(0.16, 0.6, 4)),
  drum: cached(() => new THREE.CylinderGeometry(0.3, 0.3, 0.9, 12)),
  crate: cached(() => new THREE.BoxGeometry(0.9, 0.75, 0.9)),
  sleeper: cached(() => new THREE.BoxGeometry(2.6, 0.16, 0.26)),
};

/** 碎块三变体轮转（煤堆 / 砂石堆不会每颗一模一样） */
function chunkAt(i: number): THREE.BufferGeometry {
  const m = i % 3;
  return m === 0 ? G.chunkA() : m === 1 ? G.chunkB() : G.chunkC();
}

/** 单位立方体：给"靠 scale 变形"的 instanced 窄条用（壁波纹、面板分格） */
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

/* ------------------------------------------------------------------ *
 * 3. Sink：静态件按材质 / 描边 / 阴影合并，碎件走 InstancedMesh
 * ------------------------------------------------------------------ */

interface Bucket {
  mat: THREE.Material;
  outline: boolean;
  shadow: boolean;
  geos: THREE.BufferGeometry[];
}

interface InstBucket {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
  shadow: boolean;
  matrices: THREE.Matrix4[];
}

class Sink {
  private readonly buckets = new Map<string, Bucket>();
  private readonly insts = new Map<string, InstBucket>();
  meshes = 0;
  tris = 0;

  add(geo: THREE.BufferGeometry, mat: THREE.Material, outline: boolean, shadow: boolean): void {
    const key = `${mat.uuid}|${outline ? 1 : 0}|${shadow ? 1 : 0}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = { mat, outline, shadow, geos: [] };
      this.buckets.set(key, b);
    }
    b.geos.push(geo);
  }

  instance(geo: THREE.BufferGeometry, mat: THREE.Material, matrices: THREE.Matrix4[], shadow: boolean): void {
    if (matrices.length === 0) return;
    const key = `${geo.uuid}|${mat.uuid}|${shadow ? 1 : 0}`;
    let b = this.insts.get(key);
    if (!b) {
      b = { geo, mat, shadow, matrices: [] };
      this.insts.set(key, b);
    }
    for (const m of matrices) b.matrices.push(m);
  }

  flush(parent: THREE.Object3D): void {
    let i = 0;
    this.buckets.forEach((b) => {
      if (b.geos.length === 0) return;
      const geo = mergeAll(b.geos);
      const mesh = new THREE.Mesh(geo, b.mat);
      mesh.name = `ind-static-${i}`;
      mesh.castShadow = b.shadow;
      mesh.receiveShadow = b.shadow;
      if (b.outline) withOutline(mesh);
      parent.add(mesh);
      this.tris += geo.getAttribute('position').count / 3;
      this.meshes += 1 + (b.outline ? 1 : 0);
      i += 1;
    });
    let j = 0;
    this.insts.forEach((b) => {
      const inst = new THREE.InstancedMesh(b.geo, b.mat, b.matrices.length);
      b.matrices.forEach((m, k) => inst.setMatrixAt(k, m));
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = b.shadow;
      inst.receiveShadow = b.shadow;
      inst.name = `ind-inst-${j}-${b.matrices.length}`;
      parent.add(inst);
      const pos = b.geo.getAttribute('position');
      this.tris += ((b.geo.index ? b.geo.index.count : pos.count) / 3) * b.matrices.length;
      this.meshes += 1;
      j += 1;
    });
    this.buckets.clear();
    this.insts.clear();
  }
}

/* ------------------------------------------------------------------ *
 * 4. Kit：在一个资产的局部坐标系里攒零件，统一变换进 Sink
 * ------------------------------------------------------------------ */

interface BoxOpts {
  rx?: number;
  ry?: number;
  rz?: number;
  outline?: boolean;
  shadow?: boolean;
}

const IDENTITY = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _one = new THREE.Vector3(1, 1, 1);
const _m = new THREE.Matrix4();

class Kit {
  /** 本资产的世界包围盒（供审计与调试） */
  readonly bounds = new THREE.Box3();

  constructor(
    readonly sink: Sink,
    readonly rng: Rng,
    readonly lod: Lod,
    readonly frame: THREE.Matrix4 = IDENTITY,
  ) {}

  get fine(): boolean {
    return this.lod.fine;
  }

  /** 按 LOD 缩数量 */
  n(base: number): number {
    const f = this.lod.tier === 'near' ? 1 : this.lod.tier === 'mid' ? 0.7 : 0.45;
    return Math.max(1, Math.round(base * f));
  }

  private emit(geo: THREE.BufferGeometry, mat: THREE.Material, outline: boolean, shadow: boolean): void {
    if (this.frame !== IDENTITY) geo.applyMatrix4(this.frame);
    geo.computeBoundingBox();
    if (geo.boundingBox) this.bounds.union(geo.boundingBox);
    this.sink.add(geo, mat, outline && this.lod.outline, shadow && this.lod.shadow);
  }

  push(geo: THREE.BufferGeometry, mat: THREE.Material, outline = false, shadow = true): void {
    this.emit(geo, mat, outline, shadow);
  }

  box(mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, o: BoxOpts = {}): void {
    const g = new THREE.BoxGeometry(w, h, d);
    if (o.rx) g.rotateX(o.rx);
    if (o.rz) g.rotateZ(o.rz);
    if (o.ry) g.rotateY(o.ry);
    g.translate(x, y, z);
    this.emit(g, mat, o.outline ?? false, o.shadow ?? true);
  }

  /** 地面片（贴 XZ，永不描边、不投影） */
  slab(mat: THREE.Material, w: number, d: number, x: number, y: number, z: number, ry = 0): void {
    const g = new THREE.PlaneGeometry(w, d);
    g.rotateX(-Math.PI / 2);
    if (ry !== 0) g.rotateY(ry);
    g.translate(x, y, z);
    this.emit(g, mat, false, false);
  }

  /** 不规则平面片（污渍 / 锈斑 / 尘圈）：共面多边形，不会顶出墙面 */
  blob(mat: THREE.Material, r: number, x: number, y: number, z: number, ry = 0, squash = 1, rough = 0.26): void {
    const seg = 9;
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i < seg; i += 1) {
      const a = (i / seg) * TAU;
      const rr = r * this.rng.range(1 - rough, 1 + rough * 0.5);
      pts.push(new THREE.Vector2(Math.cos(a) * rr, Math.sin(a) * rr * squash));
    }
    const g = new THREE.ShapeGeometry(new THREE.Shape(pts), 1);
    g.rotateX(-Math.PI / 2);
    if (ry !== 0) g.rotateY(ry);
    g.translate(x, y, z);
    this.emit(g, mat, false, false);
  }

  /** 竖直 / 倾斜面片（锈色分层、网面、招牌底板） */
  plate(mat: THREE.Material, w: number, h: number, x: number, y: number, z: number, ry = 0, rz = 0): void {
    const g = new THREE.PlaneGeometry(w, h);
    if (rz !== 0) g.rotateZ(rz);
    if (ry !== 0) g.rotateY(ry);
    g.translate(x, y, z);
    this.emit(g, mat, false, false);
  }

  cyl(mat: THREE.Material, rt: number, rb: number, h: number, x: number, y: number, z: number, seg = 12, o: BoxOpts = {}): void {
    const g = new THREE.CylinderGeometry(rt, rb, h, seg);
    if (o.rx) g.rotateX(o.rx);
    if (o.rz) g.rotateZ(o.rz);
    if (o.ry) g.rotateY(o.ry);
    g.translate(x, y, z);
    this.emit(g, mat, o.outline ?? false, o.shadow ?? true);
  }

  /** 圆环（焊缝带、护栏圈、管卡）：axis 指环的法线方向 */
  ring(mat: THREE.Material, r: number, tube: number, x: number, y: number, z: number, axis: 'x' | 'y' | 'z' = 'y', seg = 16): void {
    const g = new THREE.TorusGeometry(r, tube, 5, seg);
    if (axis === 'y') g.rotateX(Math.PI / 2);
    else if (axis === 'x') g.rotateY(Math.PI / 2);
    g.translate(x, y, z);
    this.emit(g, mat, false, true);
  }

  /** 竖直的不规则色块（墙面锈斑 / 剥落 / 烟熏）：共面于墙面，不顶出墙体 */
  patch(mat: THREE.Material, w: number, h: number, x: number, y: number, z: number, ry = 0, rough = 0.3): void {
    const seg = 8;
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i < seg; i += 1) {
      const a = (i / seg) * TAU;
      pts.push(
        new THREE.Vector2(
          Math.cos(a) * (w / 2) * this.rng.range(1 - rough, 1),
          Math.sin(a) * (h / 2) * this.rng.range(1 - rough, 1),
        ),
      );
    }
    const g = new THREE.ShapeGeometry(new THREE.Shape(pts), 1);
    if (ry !== 0) g.rotateY(ry);
    g.translate(x, y, z);
    this.emit(g, mat, false, false);
  }

  /** 两点之间的杆件（钢筋、拉杆、爬梯扶手、断管） */
  rod(mat: THREE.Material, r: number, from: THREE.Vector3, to: THREE.Vector3, seg = 6, shadow = true): void {
    _dir.copy(to).sub(from);
    const len = Math.max(0.002, _dir.length());
    _dir.normalize();
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1, false);
    _q.setFromUnitVectors(_v.set(0, 1, 0), _dir);
    _a.copy(from).add(to).multiplyScalar(0.5);
    _m.compose(_a, _q, _one);
    g.applyMatrix4(_m);
    this.emit(g, mat, false, shadow);
  }

  /** 轴对齐杆件 */
  bar(mat: THREE.Material, r: number, len: number, x: number, y: number, z: number, along: 'x' | 'y' | 'z' = 'x', seg = 6): void {
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1, false);
    if (along === 'x') g.rotateZ(Math.PI / 2);
    else if (along === 'z') g.rotateX(Math.PI / 2);
    g.translate(x, y, z);
    this.emit(g, mat, false, true);
  }

  /** 工字钢（上下翼缘 + 腹板）：型钢截面是硬表面的底线 */
  beam(mat: THREE.Material, h: number, w: number, len: number, x: number, y: number, z: number, along: 'x' | 'y' | 'z' = 'y', o: BoxOpts = {}): void {
    const flange = 0.11;
    const parts: THREE.BufferGeometry[] = [];
    for (const s of [-1, 1] as const) {
      const f = new THREE.BoxGeometry(len, flange, w);
      f.translate(0, (s * (h - flange)) / 2, 0);
      parts.push(f);
    }
    parts.push(new THREE.BoxGeometry(len, Math.max(0.02, h - flange * 2), 0.085));
    const g = mergeAll(parts);
    if (along === 'y') g.rotateZ(Math.PI / 2);
    else if (along === 'z') g.rotateY(Math.PI / 2);
    if (o.rx) g.rotateX(o.rx);
    if (o.rz) g.rotateZ(o.rz);
    if (o.ry) g.rotateY(o.ry);
    g.translate(x, y, z);
    this.emit(g, mat, o.outline ?? false, o.shadow ?? true);
  }

  /** 法兰盘 + 螺栓圈 */
  flange(mat: THREE.Material, r: number, x: number, y: number, z: number, axis: 'x' | 'y' | 'z' = 'y', bolts = 8): void {
    this.cyl(mat, r * 1.28, r * 1.28, 0.07, x, y, z, 12, {
      rx: axis === 'x' ? Math.PI / 2 : 0,
      rz: axis === 'z' ? Math.PI / 2 : 0,
    });
    if (!this.fine) return;
    const list: InstanceTransform[] = [];
    const count = Math.max(4, this.n(bolts));
    for (let i = 0; i < count; i += 1) {
      const a = (i / count) * TAU;
      list.push({
        position: offsetOnRing(axis, r * 1.12, a, _b.set(x, y, z)).clone(),
        rotation: axisRotation(axis, a),
        scale: _one.clone(),
      });
    }
    this.inst(G.bolt(), mat, list);
  }

  /** 卡箍（抱箍 + 螺栓耳朵） */
  clampBand(mat: THREE.Material, r: number, x: number, y: number, z: number, axis: 'x' | 'y' | 'z' = 'y'): void {
    this.ring(mat, r + 0.04, 0.05, x, y, z, axis, 12);
    if (this.fine) this.box(mat, 0.16, 0.09, 0.09, x, y + r + 0.07, z);
  }

  /** 可倾斜的板（倒塌的雨棚、翘裂的屋面板、歪掉的吊车梁） */
  tiltBox(mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, rx: number, rz: number, outline = false): void {
    this.box(mat, w, h, d, x, y, z, { rx, rz, outline });
  }

  /** 实例化一组局部变换（碎砖、煤块、铆钉、轮对…） */
  inst(geo: THREE.BufferGeometry, mat: THREE.Material, list: InstanceTransform[], shadow = true): void {
    if (list.length === 0) return;
    const out: THREE.Matrix4[] = [];
    for (const t of list) {
      _q.setFromEuler(t.rotation ?? new THREE.Euler());
      _m.compose(t.position, _q, t.scale ?? _one);
      _m.premultiply(this.frame);
      out.push(_m.clone());
    }
    this.sink.instance(geo, mat, out, shadow && this.lod.shadow);
  }
}

/** 螺栓朝向：沿给定轴分布一圈 */
function axisRotation(axis: 'x' | 'y' | 'z', a: number): THREE.Euler {
  if (axis === 'x') return new THREE.Euler(Math.PI / 2, 0, a);
  if (axis === 'z') return new THREE.Euler(a, 0, 0);
  return new THREE.Euler(0, a, 0);
}

function offsetOnRing(axis: 'x' | 'y' | 'z', r: number, a: number, center: THREE.Vector3): THREE.Vector3 {
  if (axis === 'x') return new THREE.Vector3(center.x, center.y + Math.cos(a) * r, center.z + Math.sin(a) * r);
  if (axis === 'z') return new THREE.Vector3(center.x + Math.cos(a) * r, center.y + Math.sin(a) * r, center.z);
  return new THREE.Vector3(center.x + Math.cos(a) * r, center.y, center.z + Math.sin(a) * r);
}

/* ------------------------------------------------------------------ *
 * 5. 带真洞口的砖墙（十字分解）：窗有进深、门有门槛
 * ------------------------------------------------------------------ */

interface WallCfg {
  /** 墙的法线轴：'x' 表示墙面朝 ±x（沿 z 展开），'z' 表示面朝 ±z */
  axis: 'x' | 'z';
  /** 墙外表面所在轴坐标 */
  at: number;
  /** 沿墙方向的起止（局部坐标） */
  u0: number;
  u1: number;
  y0: number;
  y1: number;
  /** 墙厚（朝屋内方向增长） */
  t: number;
  /** 内方向：at 增大的方向是否为屋内 */
  inward: 1 | -1;
  /** 洞口：[u0, v0, u1, v1] */
  breaks?: Array<[number, number, number, number]>;
}

/** 墙上的一点：u 沿墙、v 竖向、d 沿法线（>0 朝墙外） */
function wallPoint(c: WallCfg, u: number, v: number, d: number, out: THREE.Vector3): THREE.Vector3 {
  if (c.axis === 'x') return out.set(c.at + d * c.inward, v, u);
  return out.set(u, v, c.at - d * c.inward);
}

/** 该墙在厚方向上的轴 */
function thickAxis(c: WallCfg): 'x' | 'z' {
  return c.axis === 'x' ? 'x' : 'z';
}

function boxOf(c: WallCfg, alongU: number, h: number, alongD: number): [number, number, number] {
  return thickAxis(c) === 'x' ? [alongD, h, alongU] : [alongU, h, alongD];
}

/** 砌一堵带洞口的墙：洞口覆盖的格子留空，实心格按行合并成体块 */
function curtainWall(k: Kit, c: WallCfg, mat: THREE.Material, outline = true): void {
  const breaks = c.breaks ?? [];
  const xs = new Set<number>([c.u0, c.u1]);
  const ys = new Set<number>([c.y0, c.y1]);
  for (const b of breaks) {
    xs.add(clamp(b[0], c.u0, c.u1));
    xs.add(clamp(b[2], c.u0, c.u1));
    ys.add(clamp(b[1], c.y0, c.y1));
    ys.add(clamp(b[3], c.y0, c.y1));
  }
  const xc = [...xs].sort((a, b) => a - b);
  const yc = [...ys].sort((a, b) => a - b);
  const nx = xc.length - 1;
  const ny = yc.length - 1;
  const solid: boolean[][] = [];
  for (let j = 0; j < ny; j += 1) {
    const row: boolean[] = [];
    for (let i = 0; i < nx; i += 1) {
      const mu = (xc[i] + xc[i + 1]) / 2;
      const mv = (yc[j] + yc[j + 1]) / 2;
      let open = false;
      for (const b of breaks) {
        if (mu > b[0] + 1e-4 && mu < b[2] - 1e-4 && mv > b[1] + 1e-4 && mv < b[3] - 1e-4) {
          open = true;
          break;
        }
      }
      row.push(!open);
    }
    solid.push(row);
  }
  for (let j = 0; j < ny; j += 1) {
    let i = 0;
    while (i < nx) {
      if (!solid[j][i]) {
        i += 1;
        continue;
      }
      let q = i;
      while (q + 1 < nx && solid[j][q + 1]) q += 1;
      const u = (xc[i] + xc[q + 1]) / 2;
      const lenU = xc[q + 1] - xc[i];
      const v = (yc[j] + yc[j + 1]) / 2;
      const h = yc[j + 1] - yc[j];
      const p = wallPoint(c, u, v, -c.t / 2, _b);
      const [bw, bh, bd] = boxOf(c, lenU, h, c.t);
      k.box(mat, bw, bh, bd, p.x, p.y, p.z, { outline });
      i = q + 1;
    }
  }
}

/** 洞口内壁（四壁压暗 + 洞内一片黑） */
function reveal(k: Kit, c: WallCfg, b: [number, number, number, number], th = 0.05): void {
  const uMid = (b[0] + b[2]) / 2;
  const vMid = (b[1] + b[3]) / 2;
  const w = b[2] - b[0];
  const h = b[3] - b[1];
  const dIn = -c.t + th / 2;
  const segs: Array<[number, number, number, number]> = [
    [uMid, b[3] - th / 2, w, th],
    [uMid, b[1] + th / 2, w, th],
    [b[0] + th / 2, vMid, th, h],
    [b[2] - th / 2, vMid, th, h],
  ];
  for (const [u, v, su, sv] of segs) {
    const p = wallPoint(c, u, v, dIn, _b);
    const [bw, , bd] = boxOf(c, su, sv, c.t - th);
    k.box(M.reveal, bw, sv, bd, p.x, p.y, p.z);
  }
  const pb = wallPoint(c, uMid, vMid, -c.t - 0.02, _b);
  const back = thickAxis(c) === 'x' ? 0.05 : w;
  const backD = thickAxis(c) === 'x' ? w : 0.05;
  k.box(M.dark, back, h, backD, pb.x, pb.y, pb.z);
}

/**
 * 一扇有进深的工业窗：外挑窗台（带滴水）+ 洞口侧壁 + 内退钢窗框 + 玻璃（半数碎裂）。
 * broken 时留参差的碎玻璃碴，boarded 时钉木板。
 */
function industrialWindow(k: Kit, c: WallCfg, b: [number, number, number, number], o: { broken?: boolean; boarded?: boolean; lit?: boolean; sash?: number } = {}): void {
  const w = b[2] - b[0];
  const h = b[3] - b[1];
  const uMid = (b[0] + b[2]) / 2;
  const vMid = (b[1] + b[3]) / 2;
  const alongX = thickAxis(c) === 'x';
  reveal(k, c, b);

  const deep = c.t * 0.62;
  const pf = wallPoint(c, uMid, vMid, -deep, _b);
  const frameGeo = windowFrameGeometry(w * 0.94, h * 0.94, 0.11, true);
  if (alongX) frameGeo.rotateY(Math.PI / 2);
  frameGeo.translate(pf.x, pf.y, pf.z);
  k.push(frameGeo, M.metalDark);

  const pg = wallPoint(c, uMid, vMid, -deep + 0.04, _b);
  const gw = alongX ? 0.02 : w * 0.9;
  const gd = alongX ? w * 0.9 : 0.02;
  k.box(o.lit ? M.paintYellow : M.glass, gw, h * 0.86, gd, pg.x, pg.y, pg.z, { shadow: false });

  if (o.broken && k.fine) {
    for (let i = 0; i < k.n(5); i += 1) {
      const su = uMid + k.rng.range(-w * 0.4, w * 0.4);
      const sv = vMid + k.rng.range(-h * 0.36, h * 0.36);
      const p = wallPoint(c, su, sv, -deep + 0.05, _b);
      const sw = k.rng.range(0.08, 0.24);
      const sh = k.rng.range(0.07, 0.2);
      k.box(M.glassBroken, alongX ? 0.03 : sw, sh, alongX ? sw : 0.03, p.x, p.y, p.z, {
        rx: k.rng.range(-0.6, 0.6),
        ry: k.rng.range(-0.5, 0.5),
        rz: k.rng.range(-0.9, 0.9),
      });
    }
  }

  // 窗台（外挑 + 滴水斜面）
  const ps = wallPoint(c, uMid, b[1] - 0.07, 0.1, _b);
  const [sw2, , sd2] = boxOf(c, w + 0.4, 0.11, 0.42);
  k.box(M.concrete, sw2, 0.11, sd2, ps.x, ps.y, ps.z);
  const ps2 = wallPoint(c, uMid, b[1] - 0.02, 0.16, _b);
  k.box(M.concreteDark, sw2 * 0.98, 0.06, sd2 * 1.06, ps2.x, ps2.y, ps2.z, { rx: alongX ? 0 : 0.2, rz: alongX ? 0.2 : 0 });

  // 窗楣
  const pl = wallPoint(c, uMid, b[3] + 0.11, 0.05, _b);
  const [lw, , ld] = boxOf(c, w + 0.34, 0.2, 0.18);
  k.box(M.brickDark, lw, 0.2, ld, pl.x, pl.y, pl.z);

  if (o.boarded) {
    const planks = k.n(3);
    for (let i = 0; i < planks; i += 1) {
      const pv = b[1] + ((i + 0.5) * h) / planks + k.rng.range(-0.04, 0.04);
      const p = wallPoint(c, uMid, pv, 0.02, _b);
      const bw = alongX ? 0.06 : w + 0.28;
      const bd = alongX ? w + 0.28 : 0.06;
      k.box(i % 2 === 0 ? M.board : M.woodDark, bw, 0.18, bd, p.x, p.y, p.z, { rz: k.rng.range(-0.14, 0.14) });
    }
  }

  const sash = o.sash ?? 2;
  for (let i = 1; i < sash; i += 1) {
    const su = b[0] + (i * w) / sash;
    const p = wallPoint(c, su, vMid, -deep + 0.06, _b);
    k.box(M.metalDark, alongX ? 0.09 : 0.07, h * 0.94, alongX ? 0.07 : 0.09, p.x, p.y, p.z);
  }
}

/**
 * 破口：错缝砖芯立体凸起 + 崩裂碎屑环 + 立体剥碎片 + 外露扭曲钢筋。
 * 砖芯必须**凸出墙面**、逐支起伏，才读得出体积与错缝。
 */
function breach(k: Kit, c: WallCfg, b: [number, number, number, number], o: { rebar?: number; chips?: number; debris?: number } = {}): void {
  const alongX = thickAxis(c) === 'x';
  const w = b[2] - b[0];
  const h = b[3] - b[1];
  const uMid = (b[0] + b[2]) / 2;
  const vMid = (b[1] + b[3]) / 2;
  const rng = k.rng;

  const rows = Math.max(2, Math.round(h / 0.15));
  const cols = Math.max(2, Math.round(w / 0.31));
  const list: InstanceTransform[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let col = 0; col < cols; col += 1) {
      const off = r % 2 === 0 ? 0 : 0.155; // 错缝：奇偶行半砖错位
      const bu = b[0] + col * 0.31 + off + rng.range(-0.012, 0.012);
      const bv = b[1] + r * (h / rows) + 0.05;
      if (bu > b[2] - 0.08) continue;
      const edge = Math.min(bu - b[0], b[2] - bu, bv - b[1], b[3] - bv);
      const bump = edge < 0.55 ? 0.06 : -0.05; // 边缘凸起，中间塌进去
      const p = wallPoint(c, bu, bv, bump, _b);
      const rot = new THREE.Euler(0, alongX ? Math.PI / 2 : 0, rng.range(-0.07, 0.07));
      list.push({
        position: p.clone(),
        rotation: rot,
        scale: new THREE.Vector3(rng.range(0.9, 1.2), rng.range(0.8, 1.15), rng.range(0.9, 1.3)),
      });
    }
  }
  if (list.length) k.inst(G.brick(), rng.chance(0.55) ? M.brickCore : M.brickCoreDark, list);

  const ringCount = Math.max(1, o.debris ?? 12);
  const dr: InstanceTransform[] = [];
  for (const t of debrisRing(k.n(ringCount), Math.max(w, h) * 0.56, rng, 0.5)) {
    const p = wallPoint(c, uMid + t.position.x, vMid + t.position.y, 0.05 + t.position.z, _b);
    dr.push({ position: p.clone(), rotation: t.rotation, scale: t.scale });
  }
  k.inst(G.debris(), M.brickDark, dr);

  // 立体剥落：三变体破片各成一批（带厚度、边缘参差）
  const chips = Math.max(1, k.n(o.chips ?? 3));
  const geos = [G.chipA(), G.chipB(), G.chipC()];
  for (let i = 0; i < chips; i += 1) {
    const rawV = vMid + rng.range(-h * 0.55, h * 0.55);
    const cv = clamp(rawV, c.y0 + 0.45, c.y1 - 0.35); // 破片不许挂到地面以下
    const p = wallPoint(c, uMid + rng.range(-w * 0.6, w * 0.6), cv, 0.02, _b);
    k.inst(geos[i % 3], i % 2 === 0 ? M.plaster : M.plasterCold, [
      {
        position: p.clone(),
        rotation: new THREE.Euler(rng.range(-0.12, 0.12), alongX ? Math.PI / 2 : 0, rng.range(-0.6, 0.6)),
        scale: new THREE.Vector3(w * rng.range(0.3, 0.55), h * rng.range(0.3, 0.55), 1),
      },
    ]);
  }

  // 外露扭曲钢筋（两段折线，弯出墙面）
  for (let i = 0; i < (o.rebar ?? 0); i += 1) {
    const u = b[0] + rng.range(0.1, w - 0.1);
    const v = rng.chance(0.5) ? b[1] + rng.range(0, 0.25) : b[3] - rng.range(0, 0.25);
    const bend = rng.range(-0.9, 0.9);
    // 洞口下沿的钢筋只准往上弯，否则会插进地里
    const dir = v < 1.4 ? 1 : rng.chance(0.5) ? -1 : 1;
    const len = dir < 0 ? Math.min(rng.range(0.5, 1.4), Math.max(0.35, v - 0.25)) : rng.range(0.5, 1.5);
    const a = wallPoint(c, u, v, -c.t * 0.3, _v).clone();
    const mid = wallPoint(c, u + bend * 0.4, v + dir * len * 0.4, c.t * 0.35 + 0.14, _v).clone();
    const end = wallPoint(c, u + bend, v + dir * len, c.t * 0.55 + 0.22, _v).clone();
    k.rod(M.rustDark, 0.028, a, mid, 5);
    k.rod(M.rustDark, 0.028, mid, end, 5);
  }
}

/** 墙面分层：雨痕 / 积灰 / 烟熏（竖向色块，保证同一面墙至少三级明度） */
function wallGrime(k: Kit, c: WallCfg, count: number, mat: THREE.Material = M.concreteDark): void {
  for (let i = 0; i < count; i += 1) {
    const u = k.rng.range(c.u0 + 0.4, c.u1 - 0.4);
    const h = k.rng.range(0.9, 2.8);
    const v = k.rng.range(c.y0 + h / 2 + 0.2, c.y1 - h / 2);
    const p = wallPoint(c, u, v, 0.03, _b);
    const ry = c.axis === 'x' ? (Math.PI / 2) * c.inward : c.inward > 0 ? Math.PI : 0;
    k.patch(mat, k.rng.range(0.3, 0.85), h, p.x, p.y, p.z, ry, 0.32);
  }
}

/* ------------------------------------------------------------------ *
 * 6. 通用工业零件
 * ------------------------------------------------------------------ */

/** 工字钢柱 + 底垫板 + 节点板 */
function steelColumn(k: Kit, x: number, z: number, h: number, w = 0.34): void {
  k.beam(M.steel, w, w, h, x, h / 2, z, 'y');
  k.box(M.metalDark, w * 1.6, 0.12, w * 1.6, x, 0.06, z);
  if (k.fine) {
    for (const s of [-1, 1] as const) k.box(M.steel, w * 1.3, 0.1, 0.1, x, h - 0.32, z + (s * w) / 2);
  }
}

/**
 * 管架：工字柱 + 横梁 + 半圆管卡 + 管道（法兰与卡箍齐全）。
 * 沿 x 方向敷设（本厂区的管线都是东西向）。
 */
function pipeRack(k: Kit, x0: number, x1: number, z: number, y: number, radii: number[]): void {
  const len = x1 - x0;
  const cx = (x0 + x1) / 2;
  const posts = Math.max(2, Math.round(len / 5));
  for (let i = 0; i <= posts; i += 1) {
    const px = x0 + (len * i) / posts;
    steelColumn(k, px, z - 0.5, y);
    steelColumn(k, px, z + 0.5, y);
    if (i > 0 && i < posts && k.fine) {
      const qx = x0 + (len * (i - 1)) / posts;
      k.rod(M.steel, 0.05, new THREE.Vector3(qx, 0.4, z - 0.5), new THREE.Vector3(px, y - 0.4, z + 0.5), 5);
      k.rod(M.steel, 0.05, new THREE.Vector3(qx, 0.4, z + 0.5), new THREE.Vector3(px, y - 0.4, z - 0.5), 5);
    }
  }
  for (const s of [-1, 1] as const) {
    k.beam(M.metalDark, 0.26, 0.3, len, cx, y + 0.12, z + s * 0.5, 'x');
  }
  radii.forEach((r, idx) => {
    const pz = z + (idx - (radii.length - 1) / 2) * 0.72;
    const py = y + 0.12 + r + 0.24;
    k.bar(M.rust, r, len, cx, py, pz, 'x', 12);
    for (let i = 0; i <= posts; i += 1) {
      const px = x0 + (len * i) / posts;
      k.clampBand(M.metalDark, r, px, py, pz, 'x');
    }
    const flanges = Math.max(2, Math.round(len / 9));
    for (let i = 0; i <= flanges; i += 1) {
      const px = x0 + (len * i) / flanges;
      k.flange(M.metal, r, px, py, pz, 'x', 7);
    }
  });
}

/** 铁丝网围栏：混凝土立柱 + 网面 + 顶部三股刺线；可留门与剪开的口子 */
function wireFence(k: Kit, x0: number, z0: number, x1: number, z1: number, h: number, o: { gate?: [number, number]; cut?: number } = {}): void {
  const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
  const len = Math.hypot(x1 - x0, z1 - z0);
  const panel = 2.4;
  const count = Math.max(2, Math.round(len / panel));
  const rng = k.rng;
  for (let i = 0; i < count; i += 1) {
    const t = i / count;
    const px = x0 + (x1 - x0) * t;
    const pz = z0 + (z1 - z0) * t;
    const along = alongX ? px : pz;
    const isGate = o.gate !== undefined && along > o.gate[0] && along < o.gate[1];
    if (isGate && i % 2 !== 0) continue;
    const ph = h * rng.range(0.96, 1.04);
    k.box(M.concreteDark, 0.17, ph, 0.17, px, ph / 2, pz, { ry: rng.gauss(0, 0.03) });
    if (k.fine) k.box(M.metalDark, 0.24, 0.09, 0.24, px, ph + 0.04, pz);
    const mx = alongX ? px + panel / 2 : px;
    const mz = alongX ? pz : pz + panel / 2;
    for (let j = 0; j < 2; j += 1) {
      const my = h * (0.36 + j * 0.32);
      if (alongX) k.plate(M.wire, panel * 1.02, h * 0.62, mx, my, mz + 0.02);
      else k.plate(M.wire, panel * 1.02, h * 0.62, mx, my, mz, Math.PI / 2);
    }
    for (let j = 0; j < 3; j += 1) {
      const wy = h + 0.1 + j * 0.15;
      if (alongX) k.bar(M.wire, 0.018, panel, mx, wy, mz + (j - 1) * 0.12, 'x', 4);
      else k.bar(M.wire, 0.018, panel, mx + (j - 1) * 0.12, wy, mz, 'z', 4);
    }
    // 网面斜撑（稀疏竖条，读出网眼）
    if (k.fine) {
      for (let j = 0; j < 3; j += 1) {
        const o2 = (j - 1) * (panel / 3);
        if (alongX) k.bar(M.wire, 0.02, h * 0.9, mx + o2, h * 0.5, mz + 0.03, 'y', 4);
        else k.bar(M.wire, 0.02, h * 0.9, mx + 0.03, h * 0.5, mz + o2, 'y', 4);
      }
    }
  }
  // 剪开的口子：网片被掀到两侧 + 地上散落的铁丝结
  if (o.cut !== undefined) {
    const along = o.cut;
    const cx2 = alongX ? along : x0;
    const cz2 = alongX ? z0 : along;
    for (const s of [-1, 1] as const) {
      const geo = chippedSlab(1.15, 1.45, 0.05, rng, 0.36);
      geo.rotateY(alongX ? Math.PI / 2 : 0);
      geo.translate(cx2 + (alongX ? s * 0.75 : 0), h * 0.52, cz2 + (alongX ? 0 : s * 0.75));
      k.push(geo, M.wire);
    }
    const knots: InstanceTransform[] = [];
    for (let i = 0; i < 8; i += 1) {
      // 剪下来的铁丝结只往院内一侧散，别滚到人行道/线路上去
      const kx = alongX ? rng.range(-1.6, 1.6) : rng.range(-0.35, 1.6);
      const kz = alongX ? rng.range(-0.35, 1.6) : rng.range(-1.6, 1.6);
      knots.push({
        position: new THREE.Vector3(cx2 + kx, rng.range(0.04, 0.16), cz2 + kz),
        rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)),
        scale: new THREE.Vector3(rng.range(0.6, 1.3), rng.range(0.4, 0.8), rng.range(0.6, 1.3)),
      });
    }
    k.inst(G.bolt(), M.metalDark, knots);
  }
}

/** 散落的小金属件（螺栓头、道钉）——全部 instanced */
function metalLitter(k: Kit, cx: number, cz: number, w: number, d: number, count: number): void {
  const rng = k.rng;
  const bolts: InstanceTransform[] = [];
  const spikes: InstanceTransform[] = [];
  for (let i = 0; i < count; i += 1) {
    const x = cx + rng.range(-w / 2, w / 2);
    const z = cz + rng.range(-d / 2, d / 2);
    if (rng.next() < 0.5) {
      bolts.push({
        position: new THREE.Vector3(x, 0.05, z),
        rotation: new THREE.Euler(rng.range(-0.2, 0.2), rng.range(0, 3), rng.range(-0.2, 0.2)),
        scale: new THREE.Vector3(1, 1, 1).multiplyScalar(rng.range(0.7, 1.5)),
      });
    } else {
      spikes.push({
        position: new THREE.Vector3(x, 0.06, z),
        rotation: new THREE.Euler(rng.range(-1.3, 1.3), rng.range(0, 3), rng.range(-1.3, 1.3)),
        scale: new THREE.Vector3(1, rng.range(0.6, 1.6), 1),
      });
    }
  }
  k.inst(G.bolt(), M.rustDark, bolts);
  k.inst(G.spike(), M.metalDark, spikes);
}

/** 轨道间道钉：沿给定轴线成排钉在枕木上（只准在铁路走廊内调用） */
function trackSpikes(k: Kit, axis: 'x' | 'z', at: number, from: number, to: number): void {
  const list: InstanceTransform[] = [];
  const rng = k.rng;
  for (let t = from; t < to; t += 1.24) {
    for (const s of [-1, 1] as const) {
      const gauge = (RAIL.gauge / 2) * s;
      const x = axis === 'x' ? t : at + gauge;
      const z = axis === 'x' ? at + gauge : t;
      list.push({
        position: new THREE.Vector3(x, 0.245, z),
        rotation: new THREE.Euler(rng.gauss(0, 0.06), rng.range(0, 3), rng.gauss(0, 0.06)),
        scale: new THREE.Vector3(1, rng.range(0.7, 1.3), 1),
      });
    }
  }
  k.inst(G.spike(), M.metalDark, list);
}

/** 一段被切断的钢轨切片（脱轨拖痕 / 废料堆） */
function railSlice(k: Kit, x: number, z: number, len: number, ry: number): void {
  k.box(M.railSteel, 0.14, 0.16, len, x, 0.24, z, { ry });
  k.box(M.metalDark, 0.24, 0.05, len * 0.96, x, 0.34, z, { ry });
}

/** 一扇有铰链 / 把手 / 锁扣的门（世界坐标，ry 是门朝向） */
function doorLeaf(k: Kit, x: number, y: number, z: number, w: number, h: number, ry: number, o: { handle?: boolean; hinge?: boolean; lock?: boolean; mat?: THREE.Material } = {}): void {
  const mat = o.mat ?? M.metal;
  k.box(mat, w, h, 0.09, x, y, z, { ry, outline: true });
  const nx = Math.cos(ry);
  const nz = -Math.sin(ry);
  if (k.fine) {
    for (let i = 0; i < 2; i += 1) {
      k.box(M.metalDark, w * 0.84, 0.06, 0.04, x, y - h / 2 + (i + 0.7) * (h / 2.6), z, { ry });
    }
  }
  if (o.hinge !== false) {
    for (let i = 0; i < 3; i += 1) {
      const hy = y - h / 2 + (i + 0.5) * (h / 3);
      k.box(M.rustDark, 0.1, 0.2, 0.14, x - nz * w * 0.46, hy, z + nx * w * 0.46, { ry });
    }
  }
  if (o.handle !== false && k.fine) {
    k.bar(M.rust, 0.035, 0.42, x + nx * 0.1 - nz * w * 0.32, y, z + nz * 0.1 + nx * w * 0.32, 'y', 6);
    k.box(M.metalDark, 0.16, 0.07, 0.1, x + nx * 0.1 - nz * w * 0.28, y - 0.16, z + nz * 0.1 + nx * w * 0.28, { ry });
  }
  if (o.lock && k.fine) {
    k.box(M.rustDark, 0.18, 0.24, 0.12, x + nx * 0.09 + nz * w * 0.4, y + 0.3, z + nz * 0.09 - nx * w * 0.4, { ry });
    k.ring(M.metal, 0.06, 0.02, x + nx * 0.16 + nz * w * 0.4, y + 0.24, z + nz * 0.16 - nx * w * 0.4, 'x', 8);
  }
}

/* ------------------------------------------------------------------ *
 * 7. 招牌贴图
 * ------------------------------------------------------------------ */

function plateTexture(title: string, sub: string, bg: string, fg: string, wide: boolean): THREE.CanvasTexture {
  const tex = canvasTexture(wide ? 512 : 256, wide ? 160 : 256, (c, w, h) => {
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);
    c.strokeStyle = fg;
    c.lineWidth = 6;
    c.strokeRect(10, 10, w - 20, h - 20);
    c.fillStyle = fg;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = `bold ${wide ? 50 : 42}px "Segoe UI",Arial,sans-serif`;
    c.fillText(title, w / 2, sub ? h * 0.4 : h / 2);
    if (sub) {
      c.font = `${wide ? 26 : 22}px "Segoe UI",Arial,sans-serif`;
      c.globalAlpha = 0.75;
      c.fillText(sub, w / 2, h * 0.72);
      c.globalAlpha = 1;
    }
    const seed = hashSeedOf(title);
    for (let i = 0; i < 42; i += 1) {
      c.globalAlpha = 0.2;
      c.fillStyle = i % 2 === 0 ? '#0d0f12' : '#5d4630';
      c.fillRect(((seed + i * 97) % w), (i * 53) % h, 4 + (i % 7) * 5, 3 + (i % 5) * 4);
    }
    c.globalAlpha = 1;
  });
  return tex;
}

function hashSeedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return Math.abs(h) % 4096;
}

/* ------------------------------------------------------------------ *
 * 8. FX：工厂黑烟 / 余烬光晕 / 火星 / 火舌（自建 instanced 面片，动画全在 shader 里）
 * ------------------------------------------------------------------ */

function quadField(count: number): THREE.InstancedBufferGeometry {
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setAttribute('uv', base.getAttribute('uv'));
  geo.instanceCount = count;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 24, 0), 300);
  return geo;
}

/** 挂在 mesh.userData.tick 上的 FX 更新函数（循环里只写 uniform，不 new 对象） */
type TickFn = (t: number) => void;

function markTick(mesh: THREE.Mesh, mat: THREE.ShaderMaterial): THREE.Mesh {
  const fn: TickFn = (t: number) => {
    mat.uniforms['uTime'].value = t;
  };
  mesh.userData['tick'] = fn;
  return mesh;
}

/** 烟团贴图（自建，不复用 fx/smoke.ts 的实例） */
function puffTexture(seed: number): THREE.CanvasTexture {
  return canvasTexture(128, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    let a = seed >>> 0;
    const rnd = () => {
      a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
      return a / 4294967296;
    };
    const cx = w / 2;
    const cy = h / 2;
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, w * 0.5);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.34, 'rgba(255,255,255,0.58)');
    g.addColorStop(0.66, 'rgba(255,255,255,0.2)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 6; i += 1) {
      const ang = rnd() * TAU;
      const d = w * (0.12 + rnd() * 0.22);
      const r = w * (0.14 + rnd() * 0.2);
      const px = cx + Math.cos(ang) * d;
      const py = cy + Math.sin(ang) * d;
      const pg = c.createRadialGradient(px, py, 0, px, py, r);
      pg.addColorStop(0, `rgba(255,255,255,${(0.13 + rnd() * 0.18).toFixed(3)})`);
      pg.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = pg;
      c.beginPath();
      c.arc(px, py, r, 0, TAU);
      c.fill();
    }
  });
}

interface SmokeEmitter {
  x: number;
  y: number;
  z: number;
  /** 上升总高度 */
  rise: number;
  driftX: number;
  driftZ: number;
  size0: number;
  size1: number;
  alpha: number;
  life: number;
  color: THREE.Color;
}

/** 工厂黑烟：底浓顶散，随风缓慢飘；一次 draw call */
function smokeField(emitters: SmokeEmitter[], perEmitter: number, map: THREE.CanvasTexture, name: string): THREE.Mesh {
  const count = emitters.length * perEmitter;
  const origins = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const p1 = new Float32Array(count * 4);
  const p2 = new Float32Array(count * 4);
  let i = 0;
  for (const e of emitters) {
    for (let j = 0; j < perEmitter; j += 1, i += 1) {
      const s1 = hash2(i * 1.7, 3.1);
      const s2 = hash2(i * 2.3, 7.7);
      const s3 = hash2(i * 5.1, 1.9);
      origins[i * 3] = e.x + (s1 - 0.5) * 2.4;
      origins[i * 3 + 1] = e.y + (s2 - 0.5) * 0.7;
      origins[i * 3 + 2] = e.z + (s3 - 0.5) * 2.4;
      p1[i * 4] = s1 * TAU;
      p1[i * 4 + 1] = e.rise * (0.82 + s2 * 0.45);
      p1[i * 4 + 2] = e.driftX * (0.7 + s2);
      p1[i * 4 + 3] = e.driftZ * (0.7 + s2);
      p2[i * 4] = e.size0 * (0.8 + s3 * 0.5);
      p2[i * 4 + 1] = e.size1;
      p2[i * 4 + 2] = e.alpha * (0.72 + s2 * 0.5);
      p2[i * 4 + 3] = e.life * (0.85 + s1 * 0.3);
      const tint = 0.78 + hash2(i, 11.3) * 0.5;
      colors[i * 3] = e.color.r * tint;
      colors[i * 3 + 1] = e.color.g * tint;
      colors[i * 3 + 2] = e.color.b * (tint * 1.05);
    }
  }
  const geo = quadField(count);
  geo.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(origins, 3));
  geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(p1, 4));
  geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(p2, 4));
  geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 3));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: { value: 0 }, uMap: { value: map } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute vec3 aOrigin;
      attribute vec4 aParam;
      attribute vec4 aSize;
      attribute vec3 aColor;
      varying vec2 vUv;
      varying float vAlpha;
      varying vec3 vColor;
      void main() {
        vUv = uv;
        float life = max(0.5, aSize.w);
        float c = fract((uTime + aParam.x * life) / life);
        float h = c * aParam.y;
        vec3 p = aOrigin;
        p.x += aParam.z * h + sin(uTime * 0.19 + aParam.x * 6.28) * 0.9 * c;
        p.z += aParam.w * h + cos(uTime * 0.15 + aParam.x * 4.1) * 0.8 * c;
        p.y += h;
        float grow = 1.0 - (1.0 - c) * (1.0 - c) * (1.0 - c);
        float size = mix(aSize.x, aSize.y, grow);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        mv.xy += position.xy * size;
        gl_Position = projectionMatrix * mv;
        vAlpha = aSize.z * smoothstep(0.0, 0.14, c) * pow(1.0 - c, 1.15);
        vColor = aColor;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      varying vec2 vUv;
      varying float vAlpha;
      varying vec3 vColor;
      void main() {
        float a = texture2D(uMap, vUv).a * vAlpha;
        if (a < 0.004) discard;
        gl_FragColor = vec4(vColor, a);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = 9;
  return markTick(mesh, mat);
}

/** 余烬光晕：柔核 + 外扩，自带呼吸与偶发爆发 */
function glowField(spots: Array<{ x: number; y: number; z: number; r: number; color: THREE.Color }>, name: string): THREE.Mesh {
  const count = Math.max(1, spots.length);
  const origins = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const params = new Float32Array(count * 4);
  spots.forEach((s, i) => {
    origins[i * 3] = s.x;
    origins[i * 3 + 1] = s.y;
    origins[i * 3 + 2] = s.z;
    colors[i * 3] = s.color.r;
    colors[i * 3 + 1] = s.color.g;
    colors[i * 3 + 2] = s.color.b;
    params[i * 4] = s.r;
    params[i * 4 + 1] = hash2(i, 2.7) * TAU;
    params[i * 4 + 2] = 0.5 + hash2(i, 9.1) * 0.55;
    params[i * 4 + 3] = 0.6 + hash2(i, 4.3) * 1.5;
  });
  const geo = quadField(count);
  geo.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(origins, 3));
  geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 3));
  geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(params, 4));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute vec3 aOrigin;
      attribute vec3 aColor;
      attribute vec4 aParam;
      varying vec2 vUv;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(aOrigin, 1.0);
        mv.xy += position.xy * aParam.x * 2.0;
        gl_Position = projectionMatrix * mv;
        float breathe = 0.5 + 0.3 * sin(uTime * aParam.w + aParam.y) + 0.2 * sin(uTime * aParam.w * 2.6 + aParam.y * 1.7);
        float flare = pow(max(0.0, sin(uTime * 0.37 + aParam.y)), 14.0);
        vAlpha = aParam.z * max(0.1, breathe) + flare * 0.55;
        vColor = aColor;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        float a = (exp(-d * d * 3.1) + exp(-d * d * 0.85) * 0.3) * vAlpha;
        if (a < 0.004) discard;
        gl_FragColor = vec4(vColor, a);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = 13;
  return markTick(mesh, mat);
}

/** 崩出的火星：GPU 循环抛物线抛射 */
function sparkField(origin: { x: number; y: number; z: number }, count: number, name: string): THREE.Mesh {
  const origins = new Float32Array(count * 3);
  const params = new Float32Array(count * 4);
  for (let i = 0; i < count; i += 1) {
    origins[i * 3] = origin.x + (hash2(i, 1.3) - 0.5) * 1.8;
    origins[i * 3 + 1] = origin.y + (hash2(i, 2.9) - 0.5) * 0.6;
    origins[i * 3 + 2] = origin.z + (hash2(i, 4.7) - 0.5) * 1.8;
    params[i * 4] = 1.2 + hash2(i, 6.1) * 1.8;
    params[i * 4 + 1] = hash2(i, 8.3);
    params[i * 4 + 2] = 0.9 + hash2(i, 9.7) * 1.4;
    params[i * 4 + 3] = 0.05 + hash2(i, 3.7) * 0.09;
  }
  const geo = quadField(count);
  geo.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(origins, 3));
  geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(params, 4));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(PALETTE.fireCore) } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute vec3 aOrigin;
      attribute vec4 aParam;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        vUv = uv;
        float c = fract(uTime / aParam.x + aParam.y);
        float live = 1.0 - step(0.42, c);
        float k = clamp(c / 0.42, 0.0, 1.0);
        float ang = aParam.y * 62.83 + aParam.z * 3.1;
        vec3 off = vec3(cos(ang) * aParam.z, 1.0, sin(ang) * aParam.z * 0.8);
        vec3 world = aOrigin + off * k * 1.1 - vec3(0.0, 3.4 * k * k, 0.0);
        vec4 mv = modelViewMatrix * vec4(world, 1.0);
        mv.xy += vec2(position.x, position.y * 1.8) * aParam.w;
        gl_Position = projectionMatrix * mv;
        vAlpha = live * smoothstep(0.0, 0.1, c) * pow(1.0 - k, 1.6);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        float a = exp(-d * d * 2.4) * vAlpha;
        if (a < 0.005) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = 14;
  return markTick(mesh, mat);
}

/** 三层火舌（核心近白 / 外焰橙 / 上层暗红）：靠 uv.y 切色阶，相位互质所以不规则 */
function flameField(origin: { x: number; y: number; z: number }, scale: number, name: string): THREE.Mesh {
  const tiers = 3;
  const per = 3;
  const count = tiers * per;
  const origins = new Float32Array(count * 3);
  const params = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 3);
  const TIER = [
    { w: 0.44, h: 1.0 },
    { w: 0.62, h: 0.62 },
    { w: 0.3, h: 0.34 },
  ];
  let i = 0;
  for (let t = 0; t < tiers; t += 1) {
    const tier = TIER[t] as { w: number; h: number };
    for (let j = 0; j < per; j += 1, i += 1) {
      origins[i * 3] = origin.x + (hash2(i, 1.1) - 0.5) * 0.9;
      origins[i * 3 + 1] = origin.y;
      origins[i * 3 + 2] = origin.z + (hash2(i, 2.2) - 0.5) * 0.9;
      params[i * 3] = (j / per) * Math.PI + (hash2(i, 3.3) - 0.5) * 0.5;
      params[i * 3 + 1] = (0.34 + hash2(i, 4.4) * 0.2) * scale * tier.w;
      params[i * 3 + 2] = (0.8 + hash2(i, 5.5) * 0.4) * scale * tier.h;
      seeds[i * 3] = hash2(i, 6.6);
      seeds[i * 3 + 1] = t;
      seeds[i * 3 + 2] = hash2(i, 7.7) * 100;
    }
  }
  const geo = quadField(count);
  geo.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(origins, 3));
  geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(params, 3));
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uCore: { value: new THREE.Color(0xfff0cd) },
      uMid: { value: new THREE.Color(PALETTE.fireCore) },
      uFire: { value: new THREE.Color(PALETTE.fire) },
      uEdge: { value: new THREE.Color(0x8e2c12) },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute vec3 aOrigin;
      attribute vec3 aParam;
      attribute vec3 aSeed;
      varying vec2 vUv;
      varying float vTier;
      varying float vFlick;
      void main() {
        vUv = uv;
        float seed = aSeed.x * 6.2831853 + aSeed.z;
        float gate = 0.5 + 0.5 * sin(uTime * 1.31 + seed * 0.9);
        vFlick = 0.8 + 0.16 * sin(uTime * 9.1 + seed) + 0.1 * sin(uTime * 21.7 + seed * 2.7) + pow(gate, 3.0) * 0.22;
        vTier = aSeed.y;
        float h = aParam.z * vFlick;
        vec3 right = vec3(cos(aParam.x), 0.0, sin(aParam.x)) * aParam.y;
        vec3 world = aOrigin + right * position.x + vec3(0.0, (position.y + 0.5) * h, 0.0);
        world.x += sin(uTime * 4.6 + seed) * 0.05 * (position.y + 0.5);
        world.z += cos(uTime * 4.1 + seed * 1.4) * 0.05 * (position.y + 0.5);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uCore;
      uniform vec3 uMid;
      uniform vec3 uFire;
      uniform vec3 uEdge;
      varying vec2 vUv;
      varying float vTier;
      varying float vFlick;
      void main() {
        float y = vUv.y;
        vec3 col;
        float bright;
        if (vTier < 0.5) {
          col = mix(uMid, uFire, smoothstep(0.02, 0.42, y));
          col = mix(col, uEdge, smoothstep(0.6, 0.98, y));
          bright = 0.82;
        } else if (vTier < 1.5) {
          col = mix(uMid, uFire, smoothstep(0.05, 0.55, y));
          bright = 1.0;
        } else {
          col = mix(uCore, uMid, smoothstep(0.05, 0.45, y));
          bright = 1.25;
        }
        float edge = smoothstep(1.0, 0.62, abs(vUv.x - 0.5) * 2.0);
        float top = 1.0 - smoothstep(0.72, 1.0, y);
        float a = edge * top * 0.85;
        if (a < 0.006) discard;
        gl_FragColor = vec4(col * bright * (0.82 + 0.38 * vFlick), a);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = 14;
  return markTick(mesh, mat);
}

/* ------------------------------------------------------------------ *
 * 9. FX 收集器与坐标框架
 * ------------------------------------------------------------------ */

interface Fx {
  smoke: SmokeEmitter[];
  glow: Array<{ x: number; y: number; z: number; r: number; color: THREE.Color }>;
  sparks: Array<{ x: number; y: number; z: number }>;
}

const EMBER_COLOR = new THREE.Color(PALETTE.ember);
const FIRE_COLOR = new THREE.Color(PALETTE.fire);
const SMOKE_BLACK = new THREE.Color(0x1d2226);
const SMOKE_GREY = new THREE.Color(0x2f363d);

function frameOf(x: number, z: number, rotY = 0, y = 0, tilt?: THREE.Euler): THREE.Matrix4 {
  const e = tilt ? tilt.clone() : new THREE.Euler(0, 0, 0);
  e.y += rotY;
  const q = new THREE.Quaternion().setFromEuler(e);
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, _one.clone());
}

/* ------------------------------------------------------------------ *
 * 10. 半坍塌红砖厂房（factoryMain / indN）
 * ------------------------------------------------------------------ */

const FACTORY_BAYS = 9;

function buildFactory(sink: Sink, rng: Rng, fx: Fx): { x: number; y: number; z: number } {
  const zone = zoneRect('indN');
  const r = fitZone(rectOf(111.2, 127.0, -71.0, -31.0), zone, 1.2);
  guard(r, 'factoryMain');
  const cx = (r.x0 + r.x1) / 2;
  const cz = (r.z0 + r.z1) / 2;
  const W = r.x1 - r.x0;
  const L = r.z1 - r.z0;
  const k = new Kit(sink, rng, lodAt(cx, cz), frameOf(cx, cz));
  const halfW = W / 2;
  const halfL = L / 2;
  const T = 0.62;
  const eave = 9.2;
  const bay = L / FACTORY_BAYS;
  const collapsed = [4, 5, 6];
  const wall = M.brick;

  // —— 地坪 ——
  k.slab(M.concrete, W - 0.3, L - 0.3, 0, 0.14, 0);
  k.blob(oilMat, 4.2, -2, 0.16, 3);

  // —— 四面带洞口的砖墙 ——
  const longOpenings = (mirror: boolean): Array<[number, number, number, number]> => {
    const list: Array<[number, number, number, number]> = [];
    for (let b = 0; b < FACTORY_BAYS; b += 1) {
      const u0 = -halfL + b * bay + bay * 0.22;
      const u1 = -halfL + b * bay + bay * 0.78;
      for (const v of [2.35, 6.35]) {
        if (mirror && b === 3) continue; // 留出装卸门
        list.push([u0, v - 0.95, u1, v + 0.95]);
      }
    }
    if (!mirror) list.push([-halfL + bay * 3.1, 0.2, -halfL + bay * 3.1 + 3.4, 4.6]);
    return list;
  };

  const west: WallCfg = { axis: 'x', at: -halfW, u0: -halfL, u1: halfL, y0: 0, y1: eave, t: T, inward: -1 };
  const east: WallCfg = { axis: 'x', at: halfW, u0: -halfL, u1: halfL, y0: 0, y1: eave, t: T, inward: 1 };
  // 南、北山墙：洞口位置不同
  const gableOpenings = (north: boolean): Array<[number, number, number, number]> => {
    const list: Array<[number, number, number, number]> = [];
    if (north) {
      for (const u of [-halfW + 2.2, -2.2, halfW - 2.2]) {
        for (const v of [2.6, 6.4]) list.push([u - 1.1, v - 0.9, u + 1.1, v + 0.9]);
      }
      list.push([-1.7, 0.2, 1.7, 4.4]); // 大门
    } else {
      list.push([-halfW + 1.6, 0.4, -halfW + 4.6, 3.6]); // 破损的大窗
      list.push([2.4, 0, 7.4, 4.8]); // 被炸开的破口
      for (const u of [-halfW + 2.6, -1.4, 1.2]) list.push([u - 1, 6.5, u + 1, 8.2]);
    }
    return list;
  };
  const north: WallCfg = { axis: 'z', at: -halfL, u0: -halfW, u1: halfW, y0: 0, y1: eave + 0.7, t: T, inward: 1 };
  const south: WallCfg = { axis: 'z', at: halfL, u0: -halfW, u1: halfW, y0: 0, y1: eave + 0.7, t: T, inward: -1 };

  west.breaks = longOpenings(false);
  east.breaks = longOpenings(true);
  north.breaks = gableOpenings(true);
  south.breaks = gableOpenings(false);

  curtainWall(k, west, wall);
  curtainWall(k, east, wall);
  curtainWall(k, north, wall);
  curtainWall(k, south, wall);

  for (const cfg of [west, east, north, south] as WallCfg[]) {
    for (const b of cfg.breaks ?? []) {
      const h = b[3] - b[1];
      const w = b[2] - b[0];
      const isDoor = b[1] < 0.5 && h > 3.8;
      if (isDoor) {
        // 装卸门：洞口内壁 + 滑门（门下塞着碎砖）+ 上导轨
        reveal(k, cfg, b);
        const uMid = (b[0] + b[2]) / 2;
        const p = wallPoint(cfg, uMid, h / 2 + 0.1, -T * 0.45, _b);
        const alongX = thickAxis(cfg) === 'x';
        doorLeaf(k, p.x, p.y, p.z, alongX ? 0.1 : w * 0.86, h * 0.92, alongX ? Math.PI / 2 : 0, {
          mat: rng.chance(0.5) ? M.rust : M.metal,
          lock: true,
        });
        const pr = wallPoint(cfg, uMid, h + 0.35, 0.2, _b);
        k.beam(M.rustDark, 0.2, 0.2, w * 1.3, pr.x, pr.y, pr.z, alongX ? 'z' : 'x');
      } else {
        industrialWindow(k, cfg, b, {
          broken: rng.chance(0.52),
          boarded: rng.chance(0.22),
          lit: false,
          sash: w > 2 ? 3 : 2,
        });
      }
    }
  }

  // 破口：南山墙的炸开的洞（错缝砖芯 + 钢筋）
  const southBreach = (south.breaks ?? []).find((b) => b[3] - b[1] > 4 && b[2] - b[0] > 4);
  if (southBreach) {
    breach(k, south, southBreach, { rebar: 6, chips: 4 });
    // 洞内的黑洞 + 塌落到地的碎砖
    const p = wallPoint(south, (southBreach[0] + southBreach[2]) / 2, 2.2, -T - 0.1, _b);
    k.box(M.dark, 0.1, 4.2, 4.4, p.x - 0.3, p.y, p.z);
    rubblePile(k, rng, p.x + 1.4, p.z, 3.2, 1.6, M.brickDark, 26);
  }
  // 东墙的裂缝与剥落
  const eastPeel: [number, number, number, number] = [halfL - 12.4, 1.4, halfL - 9.6, 5.4];
  breach(k, east, eastPeel, { rebar: 3, chips: 3, debris: 10 });
  wallGrime(k, west, k.n(7));
  wallGrime(k, east, k.n(6));
  wallGrime(k, north, k.n(4));
  wallGrime(k, south, k.n(4), M.soot);

  // —— 锯齿天窗屋面 ——
  const rise = 3.1;
  const slope = Math.hypot(bay, rise);
  const ang = Math.atan2(rise, bay);
  for (let b = 0; b < FACTORY_BAYS; b += 1) {
    const z0 = -halfL + b * bay;
    const zm = z0 + bay / 2;
    const isDown = collapsed.includes(b);
    if (!isDown) {
      // 斜坡板（带厚度，锈色分档）
      const slabMat = b % 3 === 0 ? M.roofRust : b % 3 === 1 ? M.roof : M.roofDark;
      k.box(slabMat, W + 0.5, 0.16, slope, 0, eave + rise / 2 + 0.08, zm + bay / 4, { rx: ang });
      // 垂直玻璃面（朝北），玻璃残片成排
      k.box(M.metalDark, W + 0.4, 0.14, 0.3, 0, eave + rise - 0.1, z0 + 0.1, {});
      k.box(M.glass, W + 0.2, rise * 0.82, 0.06, 0, eave + rise / 2 + 0.1, z0 + 0.2, { rx: 0.06 });
      // 玻璃碎掉的：把玻璃面切成几块，缺几块、歪几块
      if (rng.chance(0.5)) {
        const pieces = k.n(7);
        for (let i = 0; i < pieces; i += 1) {
          const px = -W / 2 + ((i + 0.5) * W) / pieces + rng.range(-0.1, 0.1);
          const py = eave + rise * 0.4 + rng.range(-0.4, 0.9);
          if (rng.chance(0.45)) continue; // 这块玻璃没了 → 露出洞口
          k.box(rng.chance(0.5) ? M.glassBroken : M.glass, W / pieces * 0.8, rise * 0.3, 0.05, px, py, z0 + 0.24, {
            rz: rng.range(-0.25, 0.25),
          });
        }
        // 碎裂玻璃的碴（沿框边）
        if (k.fine) {
          for (let i = 0; i < k.n(9); i += 1) {
            k.box(M.glassBroken, rng.range(0.1, 0.34), rng.range(0.08, 0.26), 0.03,
              rng.range(-W / 2, W / 2), eave + rng.range(0.4, rise - 0.2), z0 + 0.26,
              { rx: rng.range(-0.9, 0.9), rz: rng.range(-1.2, 1.2) });
          }
        }
      }
      // 天沟
      k.bar(M.rustDark, 0.11, W + 0.4, 0, eave + 0.06, z0 + 0.34, 'x', 6);
    } else {
      // 塌掉的开间：断梁、悬垂的檩条、翘裂的屋面板
      for (let i = 0; i < 3; i += 1) {
        const px = rng.range(-W * 0.42, W * 0.42);
        k.beam(M.rustDark, 0.24, 0.26, rng.range(2.4, 5.4), px, eave + rng.range(0.4, 2.6), z0 + rng.range(0.4, bay), 'x', {
          ry: rng.range(-0.5, 0.5),
          rz: rng.range(-0.6, 0.6),
        });
      }
      // 洞口边缘的崩裂屋面板（立体破片）
      for (const s of [-1, 1] as const) {
        const geo = chippedSlab(2.2, 1.1, 0.16, rng, 0.3);
        geo.rotateX(ang * s * 0.4);
        geo.translate(s * (W / 2 - 1.2), eave + rise * 0.6, zm + s * bay * 0.22);
        k.push(geo, M.roofRust);
      }
      const dr: InstanceTransform[] = [];
      for (const t of debrisRing(k.n(16), 3.4, rng, 0.35)) {
        dr.push({
          position: new THREE.Vector3(t.position.x * (W / 8), eave + 0.3 + t.position.y * 0.2, zm + t.position.z * 1.4),
          rotation: t.rotation,
          scale: t.scale,
        });
      }
      k.inst(G.debris(), M.roofRust, dr);
    }
  }
  // 屋脊压边与山墙压顶
  k.box(M.rustDark, W + 0.6, 0.18, 0.4, 0, eave + rise + 0.1, halfL - 0.2);
  k.box(M.brickDark, W + 0.8, 0.22, 0.34, 0, eave + 0.7, -halfL + 0.1);
  k.box(M.brickDark, W + 0.8, 0.22, 0.34, 0, eave + 0.7, halfL - 0.1);

  // —— 室内：钢屋架 / 桁架 + 二层夹层 + 碎机械剪影 ——
  for (let b = 0; b <= FACTORY_BAYS; b += 1) {
    const z = -halfL + b * bay;
    truss(k, z, W - 1.0, eave - 0.3, collapsed.includes(b) ? 0.55 : 0.85);
  }
  for (let i = 0; i < 4; i += 1) {
    const z = -halfL + (i + 2.5) * bay;
    k.bar(M.steel, 0.09, W - 1.2, 0, eave + rise - 0.35, z, 'x', 5);
  }
  // 二层夹层（北三段）：混凝土楼板 + 工字柱 + 钢栏
  const mezZ0 = -halfL;
  const mezZ1 = -halfL + bay * 3;
  k.box(M.concreteDark, W - T * 2, 0.24, mezZ1 - mezZ0, 0, 4.5, (mezZ0 + mezZ1) / 2, { outline: false });
  for (let i = 0; i <= 3; i += 1) {
    const z = mezZ0 + (i * (mezZ1 - mezZ0)) / 3;
    steelColumn(k, -2.6, z, 4.5, 0.3);
    steelColumn(k, 2.6, z, 4.5, 0.3);
  }
  for (const s of [-1, 1] as const) {
    for (let i = 0; i < 8; i += 1) {
      const z = mezZ0 + 0.4 + i * ((mezZ1 - mezZ0 - 0.8) / 7);
      k.box(M.metalDark, 0.06, 0.9, 0.06, s * (W / 2 - T - 0.4), 5.05, z);
    }
    k.bar(M.rust, 0.045, mezZ1 - mezZ0 - 0.6, s * (W / 2 - T - 0.4), 5.45, (mezZ0 + mezZ1) / 2, 'z', 5);
  }
  // 钢楼梯（通向夹层，一半被掀掉）
  for (let i = 0; i < 8; i += 1) {
    k.box(M.metalDark, 1.1, 0.07, 0.3, W / 2 - 1.8, 0.55 + i * 0.5, mezZ1 - 0.4 - i * 0.32);
  }
  k.bar(M.rust, 0.05, 4.6, W / 2 - 2.3, 4.9, mezZ1 - 1.7, 'z', 5);

  // 地面上的碎机械剪影（塌顶下方看得见的地方）
  const machines = k.n(7);
  for (let i = 0; i < machines; i += 1) {
    const x = rng.range(-W * 0.34, W * 0.34);
    const z = -halfL + (3.4 + rng.range(0, 4.2)) * bay;
    machineSilhouette(k, x, z, rng);
  }
  // 塌顶下方的碎砖与机件
  rubblePile(k, rng, 0, -halfL + 5 * bay, 4.6, 2.2, M.brickDark, k.n(30));
  rubblePile(k, rng, -2.4, -halfL + 5.6 * bay, 3.2, 1.4, M.rustDark, k.n(18));
  metalLitter(k, 1.2, -halfL + 4.6 * bay, 5, 6, k.n(22));

  // 立柱式设备、配电柜与油渍
  for (let i = 0; i < 3; i += 1) {
    const x = -W / 2 + 1.8 + i * 3.2;
    k.box(M.metalDark, 1.0, 1.9, 0.7, x, 1.05, halfL - 2.4);
    k.box(M.rust, 1.04, 0.1, 0.12, x, 1.6, halfL - 2.05);
    if (k.fine) k.box(M.paintRed, 0.2, 0.2, 0.05, x + 0.3, 1.4, halfL - 2.02);
    k.blob(oilMat, rng.range(1.2, 2.2), x, 0.155, halfL - 3.4, 0, 0.7);
  }
  // 厂房内的余烬火苗（暖色锚点 F）
  const fireX = cx - 1.6;
  const fireZ = cz + bay * 0.6;
  k.box(M.burnt, 2.2, 0.34, 1.6, -1.6, 0.3, bay * 0.6);
  k.blob(dustMat, 2.4, -1.6, 0.155, bay * 0.6, 0, 0.6);
  fx.glow.push({ x: fireX, y: 1.35, z: fireZ, r: 1.5, color: FIRE_COLOR.clone() });
  fx.glow.push({ x: fireX - 0.9, y: 0.95, z: fireZ + 0.6, r: 0.8, color: EMBER_COLOR.clone() });
  fx.glow.push({ x: cx + 3.4, y: 1.1, z: cz - 2 * bay, r: 0.7, color: EMBER_COLOR.clone() });
  fx.sparks.push({ x: fireX, y: 1.5, z: fireZ });
  fx.smoke.push(
    { x: cx - 0.6, y: eave + rise * 0.6, z: cz - bay * 0.4, rise: 13, driftX: 1.1, driftZ: 2.6, size0: 1.1, size1: 5.4, alpha: 0.3, life: 11, color: SMOKE_BLACK.clone() },
    { x: cx + 2.2, y: eave + 1.2, z: cz + bay * 0.6, rise: 10, driftX: 1.4, driftZ: 2.2, size0: 0.8, size1: 4.2, alpha: 0.24, life: 13, color: SMOKE_GREY.clone() },
  );

  // 落水管（接口环齐全，第一段从散水往上起）
  for (const s of [-1, 1] as const) {
    const px = s * (halfW - 0.35);
    const ph = (eave - 0.7) / 4;
    for (let i = 0; i < 4; i += 1) {
      k.cyl(M.rust, 0.09, 0.09, ph - 0.08, px, 0.55 + ph * (i + 0.5), halfL - 0.9, 8);
      k.ring(M.rustDark, 0.11, 0.03, px, 0.55 + ph * i, halfL - 0.9, 'y', 10);
    }
    k.box(M.concreteDark, 0.5, 0.16, 0.5, px, 0.42, halfL - 0.9);
  }
  // 厂房名牌（西立面朝 yard，跟 frame 一起变换）
  const signGeo = new THREE.PlaneGeometry(4.6, 1.5);
  signGeo.rotateY(-Math.PI / 2);
  signGeo.translate(-halfW - 0.12, 7.4, -halfL + 2.6);
  k.push(
    signGeo,
    new THREE.MeshBasicMaterial({ map: plateTexture('ЗАВОД №4', '机 电 厂', '#1e2620', '#c8c0a4', true), fog: true, color: 0xbfc4c0 }),
    false,
    false,
  );
  return { x: fireX, y: 0.5, z: fireZ };
}

/** 简支钢桁架（上下弦 + 斜腹杆）：塌过的开间少几根腹杆、微微歪 */
function truss(k: Kit, z: number, span: number, y: number, integrity: number): void {
  const depth = 1.05;
  k.beam(M.steel, 0.3, 0.26, span, 0, y, z, 'x');
  k.beam(M.steel, 0.3, 0.26, span, 0, y + depth, z, 'x');
  const n = 7;
  for (let i = 0; i <= n; i += 1) {
    const x = -span / 2 + (i * span) / n;
    if (i % 2 === 0 && integrity < 0.7) continue;
    k.beam(M.steel, 0.22, 0.2, depth, x, y + depth / 2, z, 'y');
    if (i < n) {
      const x2 = -span / 2 + ((i + 1) * span) / n;
      const a = new THREE.Vector3(x, y + 0.1, z);
      const b = new THREE.Vector3(x2, y + depth - 0.1, z);
      const dirSign = i % 2 === 0 ? 1 : -1;
      k.rod(M.steel, 0.055, dirSign > 0 ? a : b, dirSign > 0 ? b : a, 5);
    }
  }
}

/** 车间里的一台碎机械：底座 + 立柱 + 悬臂 + 主轴 + 歪掉的护罩 */
function machineSilhouette(k: Kit, x: number, z: number, rng: Rng): void {
  const w = rng.range(1.4, 2.6);
  const h = rng.range(1.1, 2.2);
  const mat = rng.chance(0.5) ? M.metalDark : M.rustDark;
  k.box(mat, w, 0.42, w * 0.75, x, 0.36, z);
  k.box(M.dark, w * 0.72, 0.14, w * 0.6, x, 0.62, z);
  k.box(mat, 0.36, h, 0.36, x + w * 0.28, 0.42 + h / 2, z);
  k.beam(mat, 0.28, 0.3, w * 1.1, x - w * 0.1, 0.42 + h, z, 'x', { ry: rng.range(-0.06, 0.06) });
  k.cyl(M.rust, 0.2, 0.2, 0.5, x - w * 0.4, 0.42 + h - 0.42, z, 8, { rz: Math.PI / 2 });
  if (rng.chance(0.6)) {
    k.box(M.rust, w * 0.5, rng.range(0.4, 0.9), 0.08, x - w * 0.2, 0.42 + h * 0.42, z + w * 0.34, {
      rx: rng.range(-0.5, 0.5),
      rz: rng.range(-0.4, 0.4),
    });
  }
  if (k.fine) {
    const list: InstanceTransform[] = [];
    for (let i = 0; i < 6; i += 1) {
      list.push({
        position: new THREE.Vector3(x + rng.range(-1.8, 1.8), 0.2, z + rng.range(-1.4, 1.4)),
        rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)),
        scale: new THREE.Vector3(rng.range(0.5, 1.2), rng.range(0.3, 0.8), rng.range(0.5, 1.2)),
      });
    }
    k.inst(G.debris(), mat, list);
  }
}

/** 碎砖/瓦砾堆：三层分布的 instanced 碎块 + 一层尘片 */
function rubblePile(k: Kit, rng: Rng, x: number, z: number, w: number, h: number, mat: THREE.Material, count: number): void {
  const list: InstanceTransform[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = rng.next();
    const s = rng.range(0.3, 1) * (1 - t * 0.4);
    list.push({
      position: new THREE.Vector3(
        x + rng.range(-w / 2, w / 2) * (1 - t * 0.3),
        0.12 + t * h,
        z + rng.range(-w / 3, w / 3) * (1 - t * 0.3),
      ),
      rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 6), rng.range(0, 3)),
      scale: new THREE.Vector3(s, s * rng.range(0.5, 0.9), s),
    });
  }
  for (let i = 0; i < count; i += 3) k.inst(chunkAt(i), mat, [list[i] as InstanceTransform]);
  k.inst(G.brick(), M.brickCore, list.slice(0, Math.round(count * 0.35)));
  k.blob(dustMat, w * 0.62, x, 0.15, z, 0, 0.75);
}

/* ------------------------------------------------------------------ *
 * 11. 成束烟囱（chimney / indN）：焦黑流痕
 * ------------------------------------------------------------------ */

function buildChimney(sink: Sink, rng: Rng, fx: Fx): void {
  const zone = zoneRect('indN');
  const hots = HOTSPOTS.chimney;
  const r = fitZone(rectOf(hots.x - 2.6, hots.x + 2.6, hots.z - 2.6, hots.z + 2.6), zone, 1.2);
  guard(r, 'chimney');
  const stacks: Array<{ x: number; z: number; h: number; r0: number; r1: number }> = [
    { x: hots.x, z: hots.z, h: 25, r0: 1.35, r1: 0.92 },
    { x: hots.x - 2.6, z: hots.z + 1.2, h: 16, r0: 1.0, r1: 0.72 },
    { x: hots.x + 2.4, z: hots.z + 1.9, h: 11.5, r0: 0.86, r1: 0.62 },
  ];
  for (const s of stacks) {
    const k = new Kit(sink, rng, lodAt(s.x, s.z), frameOf(s.x, s.z));
    // 混凝土基础 + 砖身（逐段收分）
    k.cyl(M.concreteDark, s.r0 + 0.5, s.r0 + 0.6, 1.1, 0, 0.55, 0, 14, { outline: true });
    const segs = 7;
    for (let i = 0; i < segs; i += 1) {
      const t0 = i / segs;
      const t1 = (i + 1) / segs;
      const rb = s.r0 + (s.r1 - s.r0) * t0;
      const rt = s.r0 + (s.r1 - s.r0) * t1;
      const h = (s.h - 1.1) / segs;
      const mat = i % 2 === 0 ? M.brickMid : M.brick;
      k.cyl(mat, rt, rb, h, 0, 1.1 + h * (t0 + 1 / segs / 2), 0, 14, i === 0 ? { outline: true } : {});
      // 混凝土箍带
      if (i % 2 === 0) k.ring(M.concrete, rt + 0.06, 0.09, 0, 1.1 + h * (t0 + 1 / segs), 0, 'y', 14);
    }
    // 顶口
    k.cyl(M.concreteDark, s.r1 + 0.22, s.r1 + 0.14, 0.5, 0, s.h + 0.2, 0, 14);
    k.cyl(M.dark, s.r1 * 0.86, s.r1 * 0.9, 0.4, 0, s.h + 0.3, 0, 12);
    // 焦黑流痕：竖向色块，宽窄与浓淡不一（几何不是贴图）
    const streaks = k.n(16);
    for (let i = 0; i < streaks; i += 1) {
      const a = (i / streaks) * TAU + rng.range(-0.1, 0.1);
      const hh = rng.range(1.6, 6.5);
      const wid = rng.range(0.18, 0.62);
      const y0 = rng.range(s.h * 0.42, s.h * 0.8);
      const rr = s.r0 * 0.78 + (s.r1 * 0.4) * 0.5 + 0.035;
      const px = Math.cos(a) * rr;
      const pz = Math.sin(a) * rr;
      k.plate(rng.chance(0.5) ? M.burnt : M.soot, wid, hh, px, y0 + hh / 2, pz, -a);
      // 流痕末端的滴挂（一小块凸起）
      if (k.fine && rng.chance(0.4)) {
        k.box(M.burnt, wid * 0.6, 0.3, 0.06, px, y0 + hh / 2 + 0.2, pz, { ry: -a });
      }
    }
    // 顶口的烟熏（内圈压暗）
    k.ring(M.burnt, s.r1 * 0.95, 0.14, 0, s.h + 0.42, 0, 'y', 14);
    // 检修爬梯 + 平台
    if (s.h > 14) {
      const list: InstanceTransform[] = [];
      for (let y = 1.6; y < s.h - 1.2; y += 0.42) {
        list.push({ position: new THREE.Vector3(s.r0 - 0.16 + (y / s.h) * (s.r1 - s.r0), y, 0), rotation: new THREE.Euler(0, 0, 0), scale: new THREE.Vector3(1, 1, 1) });
      }
      k.inst(G.rung(), M.rustDark, list);
      k.bar(M.rust, 0.035, s.h - 3, s.r0 - 0.05, (s.h + 1) / 2, 0, 'y', 5);
      k.bar(M.rust, 0.035, s.h - 3, s.r0 - 0.3, (s.h + 1) / 2, 0, 'y', 5);
      k.ring(M.steel, s.r0 * 0.72, 0.06, 0, s.h * 0.72, 0, 'y', 12);
      for (let i = 0; i < 8; i += 1) {
        const a = (i / 8) * TAU;
        k.box(M.steel, 0.05, 1.05, 0.05, Math.cos(a) * s.r0 * 0.72, s.h * 0.72 + 0.55, Math.sin(a) * s.r0 * 0.72);
      }
    }
    if (s.h > 20) {
      fx.smoke.push({
        x: s.x,
        y: s.h + 0.4,
        z: s.z,
        rise: 16,
        driftX: 1.6,
        driftZ: 3.2,
        size0: 1.3,
        size1: 7,
        alpha: 0.2,
        life: 15,
        color: SMOKE_BLACK.clone(),
      });
    }
  }
  // 烟囱基座的连廊与烟道（接北边的锅炉间：-Z 为北）
  const k0 = new Kit(sink, rng, lodAt(hots.x, hots.z - 4), frameOf(hots.x, hots.z));
  k0.box(M.brickDark, 3.4, 2.6, 1.6, 0.4, 1.3, -3.3);
  k0.cyl(M.rustDark, 0.55, 0.62, 2.6, -2.1, 1.5, -2.6, 10, { rx: Math.PI / 2 - 0.34 });
  k0.flange(M.metal, 0.55, -2.6, 1.2, -3.0, 'z', 8);
  // 倒在地上的钢梯与砖堆
  rubblePile(k0, rng, 3.2, 3.4, 3.4, 0.9, M.brickDark, k0.n(18));
  metalLitter(k0, -3.4, 3.2, 3, 3, k0.n(10));
}

/* ------------------------------------------------------------------ *
 * 12. 生锈巨型储水罐（waterTank / indS）
 * ------------------------------------------------------------------ */

/** 罐壁 / 圆柱面上的一片色块（沿半径朝外，法线正确，不会顶出罐壁） */
function shellPlate(k: Kit, radius: number, a: number, y: number, w: number, h: number, mat: THREE.Material, tilt = 0): void {
  const g = new THREE.PlaneGeometry(w, h);
  if (tilt !== 0) g.rotateZ(tilt);
  g.rotateY(a);
  g.translate(Math.sin(a) * radius, y, Math.cos(a) * radius);
  k.push(g, mat, false, false);
}

function buildWaterTank(sink: Sink, rng: Rng, fx: Fx): void {
  const hots = HOTSPOTS.waterTank;
  const zone = zoneRect('indS');
  const R = 4.8;
  const H = 10.6;
  const r = fitZone(rectOf(hots.x - R - 1.6, hots.x + R + 1.6, hots.z - R - 1.6, hots.z + R + 1.6), zone, 1.2);
  guard(r, 'waterTank');
  const k = new Kit(sink, rng, lodAt(hots.x, hots.z), frameOf(hots.x, hots.z));

  // 环形基础 + 散水
  k.cyl(M.concreteDark, R + 0.55, R + 0.85, 0.75, 0, 0.38, 0, 22, { outline: true });
  k.ring(M.concrete, R + 1.3, 0.12, 0, 0.06, 0, 'y', 22);
  k.blob(dustMat, R + 2.4, 0, 0.05, 0, 0, 0.55);

  // 罐壁：四节圈板（每节一档明度 → 锈的色块分层）
  const courses = 4;
  const ch = H / courses;
  const courseMats = [M.rustDark, M.metal, M.rust, M.rustWarm];
  for (let i = 0; i < courses; i += 1) {
    const rr = R - i * 0.05;
    k.cyl(courseMats[i] as THREE.Material, rr, rr, ch - 0.06, 0, 0.75 + ch * (i + 0.5), 0, 24, i === 0 ? { outline: true } : {});
    // 环形焊缝带
    k.ring(M.metalDark, rr + 0.03, 0.08, 0, 0.75 + ch * (i + 1), 0, 'y', 24);
    // 外露铆钉圈（每节上下各一圈）
    const rivets: InstanceTransform[] = [];
    const rows = k.fine ? 2 : 1;
    for (let j = 0; j < rows; j += 1) {
      const count = k.n(30);
      for (let m = 0; m < count; m += 1) {
        const a = (m / count) * TAU;
        rivets.push({
          position: new THREE.Vector3(Math.sin(a) * (rr + 0.05), 0.75 + ch * i + 0.22 + j * (ch - 0.5), Math.cos(a) * (rr + 0.05)),
          rotation: new THREE.Euler(0, a, 0),
          scale: new THREE.Vector3(1, 1, 1),
        });
      }
    }
    k.inst(G.rivet(), M.metalDark, rivets);
  }

  // 锈蚀色块分层：竖向流痕 + 剥落补丁（几何分层，不用贴图）
  const streaks = k.n(22);
  for (let i = 0; i < streaks; i += 1) {
    const a = rng.range(0, TAU);
    const w = rng.range(0.4, 1.5);
    const h = rng.range(1.1, 4.6);
    const y = rng.range(1.6, H - 1.0);
    const mat = rng.chance(0.34) ? M.rustDeep : rng.chance(0.5) ? M.rustDark : M.rustWarm;
    shellPlate(k, R + 0.05, a, y, w, h, mat, rng.range(-0.1, 0.1));
    // 焊缝带下方挂的锈瘤
    if (rng.chance(0.35)) shellPlate(k, R + 0.06, a + 0.05, y - h / 2 - 0.2, w * 0.4, 0.4, M.rustDeep);
  }
  for (let i = 0; i < k.n(5); i += 1) {
    const a = rng.range(0, TAU);
    const geo = chippedSlab(rng.range(0.8, 1.6), rng.range(0.7, 1.3), 0.06, rng, 0.3);
    geo.rotateY(a);
    geo.translate(Math.sin(a) * (R + 0.07), rng.range(1.4, H - 1.2), Math.cos(a) * (R + 0.07));
    k.push(geo, M.rustWarm);
  }

  // 罐顶：浅锥 + 压边 + 通气帽
  k.cyl(M.roofRust, 1.5, R + 0.06, 1.5, 0, H + 0.75 + 0.75, 0, 24, { outline: true });
  k.ring(M.metalDark, R + 0.1, 0.1, 0, H + 0.8, 0, 'y', 24);
  k.cyl(M.metal, 0.34, 0.4, 0.5, 0, H + 1.9, 0, 10);
  k.cyl(M.dark, 0.26, 0.26, 0.2, 0, H + 1.65, 0, 10);
  k.cyl(M.rust, 0.5, 0.55, 0.7, 1.6, H + 1.5, 0.9, 10);

  // 顶部护栏（剪影：罐顶一圈栏杆）
  const posts = k.n(18);
  for (let i = 0; i < posts; i += 1) {
    const a = (i / posts) * TAU;
    k.box(M.metalDark, 0.06, 1.05, 0.06, Math.sin(a) * (R - 0.15), H + 1.32, Math.cos(a) * (R - 0.15));
  }
  k.ring(M.metalDark, R - 0.15, 0.05, 0, H + 1.82, 0, 'y', 24);
  k.ring(M.metalDark, R - 0.15, 0.04, 0, H + 1.42, 0, 'y', 24);

  // 绕罐螺旋爬梯（踏步 + 两条边筋 + 外侧护条）
  const turnY0 = 1.4;
  const turnY1 = H + 1.1;
  const turnA0 = -0.6;
  const turnA1 = turnA0 + TAU * 1.25;
  const stepCount = k.n(30);
  const rungs: InstanceTransform[] = [];
  for (let i = 0; i <= stepCount; i += 1) {
    const t = i / stepCount;
    const a = turnA0 + (turnA1 - turnA0) * t;
    const y = turnY0 + (turnY1 - turnY0) * t;
    rungs.push({
      position: new THREE.Vector3(Math.sin(a) * (R + 0.34), y, Math.cos(a) * (R + 0.34)),
      rotation: new THREE.Euler(0, a, 0),
      scale: new THREE.Vector3(1, 1, 1),
    });
    // 托架（把爬梯顶出罐壁）
    if (k.fine && i % 2 === 0) {
      k.box(M.rustDark, 0.07, 0.07, 0.36, Math.sin(a) * (R + 0.17), y - 0.05, Math.cos(a) * (R + 0.17), { ry: a });
    }
  }
  k.inst(G.rung(), M.rustDark, rungs);
  for (const side of [-1, 1] as const) {
    let prev: THREE.Vector3 | null = null;
    for (let i = 0; i <= stepCount; i += 1) {
      const t = i / stepCount;
      const a = turnA0 + (turnA1 - turnA0) * t + side * 0.1;
      const y = turnY0 + (turnY1 - turnY0) * t + 0.28;
      const p = new THREE.Vector3(Math.sin(a) * (R + 0.36), y, Math.cos(a) * (R + 0.36));
      if (prev) k.rod(M.rust, 0.035, prev, p, 5);
      prev = p;
    }
  }
  // 罐壁检修孔（真开洞：法兰圈 + 内退盖板 + 把手）
  for (let i = 0; i < 2; i += 1) {
    const a = 1.9 + i * 2.4;
    const y = 3.2 + i * 3.4;
    const px = Math.sin(a) * R;
    const pz = Math.cos(a) * R;
    k.cyl(M.metalDark, 0.52, 0.52, 0.16, px, y, pz, 12, { rx: Math.PI / 2 - a });
    k.cyl(M.dark, 0.42, 0.42, 0.2, px * 0.965, y, pz * 0.965, 10, { rx: Math.PI / 2 - a });
    k.flange(M.rust, 0.5, px * 1.02, y, pz * 1.02, 'z', 8);
    if (k.fine) k.bar(M.rust, 0.04, 0.34, px * 1.06, y + 0.1, pz * 1.06, 'y', 5);
  }

  // 一条断裂的输水管（下面全部是**罐体局部坐标**，frame 已经把原点放在罐心）：
  // 罐壁接出 → 支墩 → 法兰断开 → 后半截歪倒向南边的空地
  const py = 2.3;
  const x0 = R;
  k.bar(M.rust, 0.42, 2.9, x0 + 1.45, py, 0, 'x', 12);
  k.flange(M.metal, 0.42, x0 + 0.15, py, 0, 'x', 9);
  k.flange(M.metal, 0.42, x0 + 2.8, py, 0, 'x', 9);
  k.clampBand(M.metalDark, 0.42, x0 + 1.4, py, 0, 'x');
  // 阀体与手轮
  k.cyl(M.metalDark, 0.56, 0.56, 0.5, x0 + 2.0, py, 0, 10, { rz: Math.PI / 2 });
  k.bar(M.rust, 0.06, 0.7, x0 + 2.0, py + 0.62, 0, 'y', 6);
  k.ring(M.rust, 0.34, 0.05, x0 + 2.0, py + 1.0, 0, 'y', 12);
  if (k.fine) {
    for (let i = 0; i < 4; i += 1) {
      const a = (i / 4) * Math.PI;
      const g = new THREE.BoxGeometry(0.62, 0.04, 0.04);
      g.rotateY(a);
      g.translate(x0 + 2.0, py + 1.0, 0);
      k.push(g, M.rust);
    }
  }
  // 支撑墩（型钢截面）
  for (const bx of [x0 + 1.0, x0 + 2.6]) {
    k.beam(M.steel, 0.3, 0.32, 2.0, bx, 1.0, 0, 'y');
    k.beam(M.metalDark, 0.22, 0.5, 1.1, bx, 2.06, 0, 'x');
    k.box(M.concreteDark, 0.7, 0.14, 0.7, bx, 0.07, 0);
  }
  // 断开处：法兰错位、管口斜插进泥地、漏出的水渍
  const breakX = x0 + 3.1;
  k.flange(M.metal, 0.42, breakX, py - 0.1, 0.2, 'x', 8);
  const fallen = new THREE.Vector3(breakX + 1.4, 1.0, 2.1);
  k.rod(M.rust, 0.42, new THREE.Vector3(breakX + 0.2, py - 0.3, 0.3), fallen, 12);
  k.rod(M.rust, 0.42, fallen, new THREE.Vector3(breakX + 0.8, 0.34, 4.6), 12);
  k.flange(M.metal, 0.42, breakX + 0.75, 0.5, 1.4, 'z', 8);
  k.box(M.dark, 0.5, 0.5, 0.12, breakX + 0.3, py - 0.35, 0.4, { ry: 0.4 });
  k.blob(oilMat, 2.8, breakX + 1.4, 0.05, 2.6, 0, 0.65);
  k.blob(rustStainMat, 1.8, breakX + 0.8, 0.055, 0.9, 0.6, 0.5);
  // 断墩（连带歪掉的管托）
  k.beam(M.steel, 0.3, 0.32, 1.4, breakX + 1.4, 0.7, 2.4, 'y', { rz: 0.24 });

  // 罐底的油泥与碎砖
  rubblePile(k, rng, -R - 1.6, R + 0.4, 2.6, 0.6, M.rustDark, k.n(12));
  metalLitter(k, R + 2.2, -R + 0.6, 3, 3, k.n(10));

  fx.glow.push({ x: hots.x - 1.4, y: 1.5, z: hots.z + R - 0.4, r: 0.6, color: EMBER_COLOR.clone() });
}

/** 从储水罐通向仓库的管架（型钢 + 法兰 + 卡箍） */
function buildTankPipeline(sink: Sink, rng: Rng): void {
  const zone = zoneRect('indS');
  const r = fitZone(rectOf(111.2, 126.8, 43.4, 46.2), zone, 1.2);
  guard(r, 'tankPipeline');
  const k = new Kit(sink, rng, lodAt(119, 44.8), IDENTITY);
  // 罐西侧的短管架 + 沿东西向架到仓库北墙
  pipeRack(k, 111.6, 118.0, 45.4, 3.4, [0.3, 0.22]);
  pipeRack(k, 113.0, 126.4, 44.4, 3.4, [0.34]);
}

/* ------------------------------------------------------------------ *
 * 13. 拱顶仓库 / 修理车间 / 厂部 / 木棚 / 锅炉间（其余厂区建筑）
 * ------------------------------------------------------------------ */

/** 拱（圆心在 (0,yc)、半径 Rc）的一段壳与一段肋 */
function arcGeo(Rc: number, dz: number, a0: number, a1: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(Rc, Rc, dz, 12, 1, true, a0 + Math.PI / 2, a1 - a0);
  g.rotateX(Math.PI / 2);
  return g;
}

function ribGeo(Rc: number, tube: number, a0: number, a1: number): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(Rc, tube, 4, 12, a1 - a0);
  g.rotateZ(a0);
  return g;
}

function buildWarehouse(sink: Sink, rng: Rng, fx: Fx): void {
  const zone = zoneRect('indS');
  const r = fitZone(rectOf(111.2, 127.0, 16.6, 41.4), zone, 1.2);
  guard(r, 'warehouse');
  const cx = (r.x0 + r.x1) / 2;
  const cz = (r.z0 + r.z1) / 2;
  const W = r.x1 - r.x0;
  const L = r.z1 - r.z0;
  const k = new Kit(sink, rng, lodAt(cx, cz), frameOf(cx, cz));
  const halfW = W / 2;
  const halfL = L / 2;
  const T = 0.55;
  const eave = 6.6;
  const rise = 3.2;
  const Rc = (halfW * halfW + rise * rise) / (2 * rise);
  const yc = eave - Rc + rise;
  const a0 = Math.atan2(Rc - rise, halfW);
  const a1 = Math.PI - a0;
  const segs = 7;
  const dz = (L - 1.2) / segs;
  const collapsedSeg = 4;

  // 地坪与散水
  k.slab(M.concrete, W + 1.4, L + 1.4, 0, 0.1, 0);

  // —— 长墙（带真洞口）——
  const longBreaks = (withDoor: boolean): Array<[number, number, number, number]> => {
    const list: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 5; i += 1) {
      const u = -halfL + 3 + i * (L - 7) / 4;
      list.push([u - 0.95, 2.5, u + 0.95, 4.3]);
    }
    if (withDoor) list.push([-2.6, 0.2, 2.6, 5.2]);
    return list;
  };
  const w1: WallCfg = { axis: 'x', at: -halfW, u0: -halfL, u1: halfL, y0: 0, y1: eave, t: T, inward: -1, breaks: longBreaks(true) };
  const w2: WallCfg = { axis: 'x', at: halfW, u0: -halfL, u1: halfL, y0: 0, y1: eave, t: T, inward: 1, breaks: longBreaks(false) };
  curtainWall(k, w1, M.brickMid);
  curtainWall(k, w2, M.brickMid);
  for (const cfg of [w1, w2] as WallCfg[]) {
    for (const b of cfg.breaks ?? []) {
      const h = b[3] - b[1];
      if (b[1] < 0.5) {
        reveal(k, cfg, b);
        const p = wallPoint(cfg, (b[0] + b[2]) / 2, h / 2, -T * 0.5, _b);
        doorLeaf(k, p.x, p.y, p.z, 0.1, h * 0.9, Math.PI / 2, { mat: M.rust, lock: true });
      } else {
        industrialWindow(k, cfg, b, { broken: rng.chance(0.6), boarded: rng.chance(0.2), sash: 2 });
      }
    }
    wallGrime(k, cfg, k.n(6));
  }

  // —— 山墙（砖 + 钢门框）——
  for (const s of [-1, 1] as const) {
    const g: WallCfg = {
      axis: 'z',
      at: (s * L) / 2,
      u0: -halfW,
      u1: halfW,
      y0: 0,
      y1: eave,
      t: T,
      inward: s > 0 ? -1 : 1,
      breaks: s > 0 ? [[-1.9, 0.2, 1.9, 4.6]] : [[-3.4, 2.6, -1.4, 4.2], [1.4, 2.6, 3.4, 4.2]],
    };
    curtainWall(k, g, M.brick);
    for (const b of g.breaks ?? []) {
      if (b[1] < 0.5) {
        reveal(k, g, b);
        const p = wallPoint(g, 0, 2.3, -T * 0.5, _b);
        doorLeaf(k, p.x, p.y, p.z, 3.4, 4.4, 0, { mat: M.metalDark });
      } else {
        industrialWindow(k, g, b, { broken: rng.chance(0.5) });
      }
    }
    // 山墙拱端封板
    const cap = arcGeo(Rc, 0.2, a0, a1);
    cap.translate(0, yc, (s * L) / 2);
    k.push(cap, M.brickDark);
    wallGrime(k, g, k.n(4));
  }

  // —— 拱肋 + 拱壳（分 7 段，缺一段 = 塌口）——
  for (let i = 0; i <= segs; i += 1) {
    const z = -halfL + 0.6 + i * dz;
    const rib = ribGeo(Rc, 0.2, a0, a1);
    rib.translate(0, yc, z);
    k.push(rib, i === collapsedSeg ? M.rustDark : M.steel);
    if (i === collapsedSeg) {
      // 塌了的肋：断成两截、歪着
      const broken = ribGeo(Rc * 1.02, 0.18, a0 + 0.4, a0 + 0.9);
      broken.translate(0.5, yc - 0.6, z + 0.4);
      k.push(broken, M.rust);
    }
  }
  for (let i = 0; i < segs; i += 1) {
    const z = -halfL + 0.6 + (i + 0.5) * dz;
    if (i === collapsedSeg) {
      // 塌口：破铁皮边、悬垂的檩条、洞里掉下去的碎件
      for (const s of [-1, 1] as const) {
        const geo = chippedSlab(2.6, 1.1, 0.09, rng, 0.32);
        geo.rotateZ(s * 0.5);
        geo.translate(s * (halfW - 1.4), eave + rise * 0.72, z + s * 0.6);
        k.push(geo, M.roofRust);
      }
      for (let j = 0; j < 3; j += 1) {
        k.bar(M.rustDark, 0.09, rng.range(3, 6), rng.range(-halfW * 0.6, halfW * 0.6), eave + rng.range(0.6, 2.4), z + rng.range(-1, 1), 'x', 5);
      }
      rubblePile(k, rng, rng.range(-2, 2), z, 3.4, 0.9, M.roofRust, k.n(16));
      fx.smoke.push({ x: cx, y: eave + 0.4, z: cz - halfL + (i + 0.5) * dz, rise: 6, driftX: 1.2, driftZ: 2.0, size0: 0.7, size1: 3.2, alpha: 0.16, life: 12, color: SMOKE_GREY.clone() });
      continue;
    }
    const shell = arcGeo(Rc, dz, a0, a1);
    shell.translate(0, yc, z);
    k.push(shell, i % 3 === 0 ? M.roofRust : i % 3 === 1 ? M.roof : M.roofDark);
    // 压型铁皮的色带（沿弧的窄条，明度分层）
    for (const band of [0.2, 0.62, 1.0]) {
      const a = a0 + (a1 - a0) * band;
      const strip = arcGeo(Rc + 0.03, dz * 0.94, a - 0.06, a + 0.06);
      strip.translate(0, yc, z);
      k.push(strip, rng.chance(0.5) ? M.rustWarm : M.rustDark);
    }
    // 天沟
    for (const s of [-1, 1] as const) {
      k.bar(M.rustDark, 0.11, L - 0.8, s * (halfW + 0.1), eave + 0.1, 0, 'z', 6);
    }
  }
  // 屋脊通风天窗（一段玻璃 + 钢架）
  k.box(M.metalDark, 1.6, 0.5, L * 0.5, 0, eave + rise + 0.3, -L * 0.12);
  k.box(M.glass, 1.2, 0.36, L * 0.48, 0, eave + rise + 0.42, -L * 0.12, { shadow: false });
  for (let i = 0; i < 8; i += 1) {
    k.bar(M.rust, 0.05, 1.6, 0, eave + rise + 0.3, -L * 0.12 - L * 0.24 + i * (L * 0.48 / 7), 'x', 4);
  }

  // —— 库内：木箱、麻袋、钢轨堆 ——
  for (let i = 0; i < 10; i += 1) {
    const x = rng.range(-halfW + 2, halfW - 2);
    const z = rng.range(-halfL + 2, halfL - 2);
    const s = rng.range(0.8, 1.3);
    k.box(rng.chance(0.5) ? M.wood : M.woodDark, s, s * 0.8, s, x, 0.2 + s * 0.4, z, { ry: rng.range(0, 1.4), outline: i % 4 === 0 });
    if (k.fine && rng.chance(0.5)) k.box(M.board, s * 0.9, 0.05, s * 0.1, x, 0.2 + s * 0.9, z + s * 0.4, { ry: rng.range(-0.4, 0.4) });
  }
  const sacks: InstanceTransform[] = [];
  for (let i = 0; i < k.n(24); i += 1) {
    const x = rng.range(-halfW + 1.6, halfW - 1.6);
    const z = rng.range(-halfL + 1.6, halfL - 1.6);
    sacks.push({
      position: new THREE.Vector3(x, 0.25 + rng.range(0, 0.4), z),
      rotation: new THREE.Euler(rng.range(-0.2, 0.2), rng.range(0, 3), rng.range(-0.3, 0.3)),
      scale: new THREE.Vector3(rng.range(0.7, 1.1), rng.range(0.4, 0.6), rng.range(0.8, 1.2)),
    });
  }
  k.inst(G.chunkA(), M.paint, sacks);
  for (let i = 0; i < 5; i += 1) {
    k.bar(M.railSteel, 0.09, L * 0.6, -halfW + 1.6 + i * 0.26, 0.3 + i * 0.12, -halfL + 3 + i * 0.1, 'z', 5);
  }

  // 库内外的碎料：靠墙一侧的碎砖与金属件（都留在院内）
  rubblePile(k, rng, halfW - 1.4, halfL - 2.4, 2.8, 0.7, M.brickDark, k.n(14));
  metalLitter(k, -halfW + 1.4, 2, 2.4, 4, k.n(9));
}

/** 修理车间：砖勒脚 + 钢框架 + 波纹铁皮 + 半塌屋面 */
function buildRepairShop(sink: Sink, rng: Rng, fx: Fx): void {
  const zone = zoneRect('indS');
  const r = fitZone(rectOf(111.2, 127.0, 60.0, 88.6), zone, 1.2);
  guard(r, 'repairShop');
  const cx = (r.x0 + r.x1) / 2;
  const cz = (r.z0 + r.z1) / 2;
  const W = r.x1 - r.x0;
  const L = r.z1 - r.z0;
  const k = new Kit(sink, rng, lodAt(cx, cz), frameOf(cx, cz));
  const halfW = W / 2;
  const halfL = L / 2;
  const eave = 6.2;
  const T = 0.5;

  // 勒脚（砖）+ 上部波纹钢板（分格 = 三渲二的墙板）
  const skirt: WallCfg = { axis: 'x', at: -halfW, u0: -halfL, u1: halfL, y0: 0, y1: 2.3, t: T, inward: -1, breaks: [[-3.4, 0.2, 3.4, 4.6]] };
  const skirt2: WallCfg = { axis: 'x', at: halfW, u0: -halfL, u1: halfL, y0: 0, y1: 2.3, t: T, inward: 1, breaks: [] };
  curtainWall(k, skirt, M.brick);
  curtainWall(k, skirt2, M.brick);
  for (const s of [-1, 1] as const) {
    for (let i = 0; i < 12; i += 1) {
      const u = -halfL + (i + 0.5) * ((L - 1) / 12);
      k.box(i % 2 === 0 ? M.metal : M.metalDark, 0.16, 3.5, s === 1 ? 0.7 : 0.7, s * (halfW + 0.05), 4.1, u, { outline: false });
    }
    // 上部钢窗带（通透的暗色玻璃）
    k.box(M.glass, 0.06, 1.5, L - 1.4, s * (halfW + 0.1), 5.0, 0, { shadow: false });
    for (let i = 0; i < 9; i += 1) {
      const u = -halfL + 0.7 + i * ((L - 1.4) / 8);
      k.box(M.metalDark, 0.12, 1.7, 0.1, s * (halfW + 0.14), 5.0, u);
    }
  }
  wallGrime(k, skirt, k.n(5));
  wallGrime(k, skirt2, k.n(4));
  // 大门（南端面向装卸场）
  const south: WallCfg = { axis: 'z', at: halfL, u0: -halfW, u1: halfW, y0: 0, y1: eave, t: T, inward: -1, breaks: [[-3.2, 0.2, 3.2, 4.8], [-halfW + 1.2, 2.6, -halfW + 3.4, 4.4]] };
  curtainWall(k, south, M.brickDark);
  reveal(k, south, [-3.2, 0.2, 3.2, 4.8]);
  for (const s of [-1, 1] as const) {
    const p = wallPoint(south, s * 1.7, 2.4, -0.3, _b);
    doorLeaf(k, p.x, p.y, p.z, 3.2, 4.5, 0, { mat: M.rust, handle: s < 0 });
  }
  industrialWindow(k, south, [-halfW + 1.2, 2.6, -halfW + 3.4, 4.4], { broken: true });
  const north: WallCfg = { axis: 'z', at: -halfL, u0: -halfW, u1: halfW, y0: 0, y1: eave, t: T, inward: 1, breaks: [[-2.2, 2.4, 2.2, 4.4]] };
  curtainWall(k, north, M.brickDark);
  industrialWindow(k, north, [-2.2, 2.4, 2.2, 4.4], { boarded: true });
  breach(k, north, [-halfW + 0.6, 0.5, -halfW + 3.2, 3.4] as [number, number, number, number], { rebar: 4, chips: 3 });
  // 补一块被炸开后临时钉上的铁皮
  const pb = wallPoint(north, -halfW + 1.9, 2.0, 0.16, _b);
  k.box(M.roofRust, 3.2, 3.4, 0.08, pb.x, pb.y, pb.z, { rz: 0.07 });

  // 门式钢架（屋内可见）+ 半塌屋面
  const frames = 5;
  for (let i = 0; i <= frames; i += 1) {
    const z = -halfL + (i * L) / frames;
    for (const s of [-1, 1] as const) k.beam(M.steel, 0.3, 0.34, eave, s * (halfW - 0.5), eave / 2, z, 'y');
    k.beam(M.steel, 0.34, 0.34, W - 1, 0, eave + 0.2, z, 'x');
    if (k.fine) {
      k.rod(M.steel, 0.06, new THREE.Vector3(-halfW + 0.5, 1.2, z), new THREE.Vector3(halfW - 0.5, eave - 0.4, z), 5);
    }
  }
  for (let i = 0; i < frames; i += 1) {
    const z = -halfL + (i + 0.5) * (L / frames);
    if (i === 3) {
      // 塌了的开间：翘裂的铁皮、裸露的檩条
      for (let j = 0; j < 4; j += 1) k.bar(M.rustDark, 0.08, W - 1.2, 0, eave + rng.range(-0.4, 0.5), z + rng.range(-1, 1), 'x', 5);
      const geo = chippedSlab(3.4, 1.6, 0.1, rng, 0.3);
      geo.rotateZ(0.3);
      geo.translate(halfW * 0.4, eave + 0.5, z);
      k.push(geo, M.roofRust);
      rubblePile(k, rng, 0, z, 4, 0.8, M.rustDark, k.n(16));
      continue;
    }
    k.box(rng.chance(0.4) ? M.roofRust : M.roof, W + 0.6, 0.14, L / frames - 0.1, 0, eave + 0.36, z);
    if (i % 2 === 0) k.box(M.glass, W * 0.5, 0.1, L / frames * 0.4, 0, eave + 0.44, z, { shadow: false });
  }
  k.box(M.roofDark, W + 0.8, 0.3, 0.5, 0, eave + 0.5, -halfL + 0.2);

  // 车间内：机床剪影、油桶、零件架
  for (let i = 0; i < 4; i += 1) machineSilhouette(k, rng.range(-halfW * 0.5, halfW * 0.5), -halfL + (i + 0.6) * (L / 4.4), rng);
  for (let i = 0; i < 3; i += 1) {
    k.box(M.metalDark, 0.28, 2.6, 0.28, -halfW + 1.4 + i * 2.2, 1.3, halfL - 1.6);
    for (let j = 0; j < 4; j += 1) k.box(M.wood, 2.0, 0.09, 0.5, -halfW + 2.4 + i * 2.2, 0.6 + j * 0.62, halfL - 1.6);
  }
  // 院内堆的废钢与报废车壳（修到一半的车，留在车间里而不是墙外）
  k.box(M.burnt, 2.2, 0.9, 4.4, -halfW + 3.4, 0.6, -halfL + 2.6, { ry: 0.3, outline: true });
  k.box(M.rustDark, 1.9, 0.6, 1.6, -halfW + 3.4, 1.3, -halfL + 2.0, { ry: 0.3 });
  rubblePile(k, rng, halfW - 2.2, halfL - 2.6, 3.0, 0.8, M.rustDark, k.n(14));

  fx.glow.push({ x: cx - 2, y: 1.2, z: cz + 2, r: 0.7, color: EMBER_COLOR.clone() });
  fx.smoke.push({ x: cx + 1, y: eave, z: cz - L * 0.1, rise: 5, driftX: 1.0, driftZ: 1.8, size0: 0.6, size1: 2.6, alpha: 0.14, life: 11, color: SMOKE_GREY.clone() });
}

/** 厂部办公楼（两层，抹灰 + 砖）：门口台阶、倒塌的雨棚、封板窗 */
function buildAdmin(sink: Sink, rng: Rng): void {
  const zone = zoneRect('indN');
  const r = fitZone(rectOf(111.2, 120.8, -88.0, -77.0), zone, 1.2);
  guard(r, 'adminBlock');
  const cx = (r.x0 + r.x1) / 2;
  const cz = (r.z0 + r.z1) / 2;
  const W = r.x1 - r.x0;
  const L = r.z1 - r.z0;
  const k = new Kit(sink, rng, lodAt(cx, cz), frameOf(cx, cz));
  const halfW = W / 2;
  const halfL = L / 2;
  const T = 0.5;
  const g0 = 3.6;
  const H = g0 + 3.2;

  const faces: WallCfg[] = [
    { axis: 'x', at: -halfW, u0: -halfL, u1: halfL, y0: 0, y1: H, t: T, inward: -1, breaks: [] },
    { axis: 'x', at: halfW, u0: -halfL, u1: halfL, y0: 0, y1: H, t: T, inward: 1, breaks: [] },
    { axis: 'z', at: -halfL, u0: -halfW, u1: halfW, y0: 0, y1: H, t: T, inward: 1, breaks: [] },
    { axis: 'z', at: halfL, u0: -halfW, u1: halfW, y0: 0, y1: H, t: T, inward: -1, breaks: [] },
  ];
  for (let fi = 0; fi < faces.length; fi += 1) {
    const cfg = faces[fi] as WallCfg;
    const along = cfg.u1 - cfg.u0;
    const cols = Math.max(2, Math.round(along / 3.4));
    for (let c = 0; c < cols; c += 1) {
      const u = cfg.u0 + (c + 0.5) * (along / cols);
      for (let lvl = 0; lvl < 2; lvl += 1) {
        const v = lvl === 0 ? 1.95 : g0 + 1.75;
        if (fi === 3 && lvl === 0 && c === Math.floor(cols / 2)) {
          cfg.breaks?.push([u - 0.85, 0.2, u + 0.85, 2.6]);
          continue;
        }
        cfg.breaks?.push([u - 0.72, v - 0.78, u + 0.72, v + 0.78]);
      }
    }
    curtainWall(k, cfg, fi === 0 || fi === 1 ? M.plaster : M.plasterCold);
    for (const b of cfg.breaks ?? []) {
      if (b[1] < 0.5) {
        reveal(k, cfg, b);
        const p = wallPoint(cfg, (b[0] + b[2]) / 2, 1.4, -T * 0.5, _b);
        doorLeaf(k, p.x, p.y, p.z, thickAxis(cfg) === 'x' ? 0.1 : 1.6, 2.3, thickAxis(cfg) === 'x' ? Math.PI / 2 : 0, { mat: M.woodDark, lock: true });
        // 台阶（被砸裂）
        const st = wallPoint(cfg, (b[0] + b[2]) / 2, 0.1, 0.5, _b);
        k.box(M.concrete, 2.0, 0.2, 0.9, st.x, st.y, st.z);
        k.box(M.concreteDark, 0.9, 0.16, 0.8, st.x + 0.3, 0.3, st.z + 0.1, { ry: 0.2 });
      } else {
        industrialWindow(k, cfg, b, { broken: rng.chance(0.45), boarded: rng.chance(0.35) });
      }
    }
    wallGrime(k, cfg, k.n(5));
    // 檐口与腰线
    const pe = wallPoint(cfg, 0, H - 0.16, 0.08, _b);
    const [pw, , pd] = boxOf(cfg, along + 0.5, 0.26, 0.34);
    k.box(M.paint, pw, 0.26, pd, pe.x, pe.y, pe.z);
    const bl = wallPoint(cfg, 0, g0 + 0.06, 0.06, _b);
    const [bw2, , bd2] = boxOf(cfg, along, 0.14, 0.2);
    k.box(M.paint, bw2, 0.14, bd2, bl.x, bl.y, bl.z);
  }
  // 平屋顶 + 女儿墙
  k.box(M.roofDark, W - 0.2, 0.22, L - 0.2, 0, H + 0.1, 0);
  for (const s of [-1, 1] as const) {
    k.box(M.plaster, W, 0.7, 0.24, 0, H + 0.5, s * (halfL - 0.12));
    k.box(M.plaster, 0.24, 0.7, L, s * (halfW - 0.12), H + 0.5, 0);
    k.box(M.paint, W + 0.1, 0.1, 0.34, 0, H + 0.88, s * (halfL - 0.12));
  }
  // 倒塌的雨棚与入口立柱
  k.tiltBox(M.roofRust, 4.4, 0.12, 1.6, 0, 3.1, halfL + 0.9, -0.42, 0.14);
  k.beam(M.concrete, 0.34, 0.34, 3.0, -1.6, 1.5, halfL + 1.3, 'y');
  k.box(M.concreteDark, 0.5, 0.2, 0.5, -1.6, 0.1, halfL + 1.3);
  // 厂牌（南立面）
  const signGeo = new THREE.PlaneGeometry(3.4, 1.1);
  signGeo.translate(0, H - 1.1, halfL + 0.26);
  k.push(
    signGeo,
    new THREE.MeshBasicMaterial({ map: plateTexture('КОНТОРА', '厂 部', '#20262b', '#c9c1a6', true), fog: true, color: 0xbcc0bd }),
    false,
    false,
  );
  rubblePile(k, rng, halfW + 1.2, halfL + 1.6, 2.4, 0.55, M.concreteDark, k.n(12));
}

/* ------------------------------------------------------------------ *
 * 14. 木棚 / 堆料场（indN 北端）
 * ------------------------------------------------------------------ */

function buildTimberYard(sink: Sink, rng: Rng): void {
  const zone = zoneRect('indN');
  const r = fitZone(rectOf(121.8, 127.6, -88.0, -76.0), zone, 1.2);
  guard(r, 'timberShed');
  const cx = (r.x0 + r.x1) / 2;
  const cz = (r.z0 + r.z1) / 2;
  const W = r.x1 - r.x0;
  const L = r.z1 - r.z0;
  const k = new Kit(sink, rng, lodAt(cx, cz), frameOf(cx, cz));
  const h = 3.1;
  // 四柱 + 单坡波纹顶（半边的顶已经不见）
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      k.box(M.woodDark, 0.16, h, 0.16, (sx * W) / 2 + sx * 0.1, h / 2, (sz * L) / 2 + sz * 0.1, { outline: sx < 0 && sz < 0 });
    }
  }
  for (const sz of [-1, 1] as const) {
    k.beam(M.wood, 0.24, 0.24, W + 0.4, 0, h + 0.1, (sz * L) / 2, 'x');
  }
  for (let i = 0; i < 5; i += 1) {
    k.box(i % 2 === 0 ? M.roofRust : M.roof, W + 0.6, 0.1, L / 5 - 0.06, 0, h + 0.28 - (i % 2) * 0.04, -L / 2 + (i + 0.5) * (L / 5), { rx: 0.08 });
  }
  // 原木堆（instanced 长杆，端面可见）
  const logs: InstanceTransform[] = [];
  for (let i = 0; i < k.n(22); i += 1) {
    const row = Math.floor(i / 8);
    logs.push({
      position: new THREE.Vector3(rng.range(-W * 0.3, W * 0.3), 0.28 + row * 0.42, -L * 0.1 + rng.range(-1.4, 1.4)),
      rotation: new THREE.Euler(Math.PI / 2, rng.range(-0.06, 0.06), 0),
      scale: new THREE.Vector3(rng.range(0.8, 1.2), 1, rng.range(0.8, 1.2)),
    });
  }
  const logGeo = new THREE.CylinderGeometry(0.2, 0.2, L * 0.7, 8);
  k.inst(logGeo, M.wood, logs);
  // 锯台与木料
  k.box(M.woodDark, 2.2, 0.16, 1.0, W * 0.24, 0.9, L * 0.28);
  for (const s of [-1, 1] as const) k.box(M.woodDark, 0.14, 0.9, 0.14, W * 0.24 + s * 0.9, 0.45, L * 0.28);
  for (let i = 0; i < 6; i += 1) k.box(M.board, rng.range(0.8, 2.2), 0.08, 0.24, rng.range(-W * 0.3, W * 0.3), 0.2 + i * 0.1, L * 0.05, { ry: rng.range(-0.4, 0.4) });
  metalLitter(k, 0, 0, W * 0.7, L * 0.6, k.n(12));
  k.blob(dustMat, 3.2, 0, 0.06, 0, 0, 0.6);
}

/** 锅炉间 / 动力车间（indN，紧贴烟囱）：钢构 + 铁皮 + 短烟囱 */
function buildBoilerShop(sink: Sink, rng: Rng, fx: Fx): void {
  const zone = zoneRect('indN');
  const r = fitZone(rectOf(115.4, 127.0, -30.2, -21.5), zone, 1.2);
  guard(r, 'boilerShop');
  const cx = (r.x0 + r.x1) / 2;
  const cz = (r.z0 + r.z1) / 2;
  const W = r.x1 - r.x0;
  const L = r.z1 - r.z0;
  const k = new Kit(sink, rng, lodAt(cx, cz), frameOf(cx, cz));
  const halfW = W / 2;
  const halfL = L / 2;
  const eave = 7.4;
  const T = 0.5;

  // 砖墙 + 高窗 + 大门
  const cfgs: WallCfg[] = [
    { axis: 'x', at: -halfW, u0: -halfL, u1: halfL, y0: 0, y1: eave, t: T, inward: -1, breaks: [] },
    { axis: 'x', at: halfW, u0: -halfL, u1: halfL, y0: 0, y1: eave, t: T, inward: 1, breaks: [] },
  ];
  for (const cfg of cfgs) {
    const along = cfg.u1 - cfg.u0;
    for (let i = 0; i < 4; i += 1) {
      const u = -along / 2 + (i + 0.5) * (along / 4);
      cfg.breaks?.push([u - 1, 4.4, u + 1, 6.4]);
      if (i === 1 && cfg.inward === -1) cfg.breaks?.push([u - 1.4, 0.2, u + 1.4, 3.6]);
    }
    curtainWall(k, cfg, M.brickDark);
    for (const b of cfg.breaks ?? []) {
      if (b[1] < 0.5) {
        reveal(k, cfg, b);
        const p = wallPoint(cfg, (b[0] + b[2]) / 2, 1.9, -T * 0.5, _b);
        doorLeaf(k, p.x, p.y, p.z, 0.1, 3.4, Math.PI / 2, { mat: M.metalDark });
      } else {
        industrialWindow(k, cfg, b, { broken: rng.chance(0.7), sash: 3 });
      }
    }
    wallGrime(k, cfg, k.n(6), M.soot);
  }
  const ends: WallCfg[] = [
    { axis: 'z', at: -halfL, u0: -halfW, u1: halfW, y0: 0, y1: eave + 0.8, t: T, inward: 1, breaks: [[-2.4, 4.6, 2.4, 6.6]] },
    { axis: 'z', at: halfL, u0: -halfW, u1: halfW, y0: 0, y1: eave + 0.8, t: T, inward: -1, breaks: [] },
  ];
  for (const cfg of ends) {
    curtainWall(k, cfg, M.brickDark);
    for (const b of cfg.breaks ?? []) industrialWindow(k, cfg, b, { boarded: true });
  }
  // 钢屋架 + 波纹铁皮双坡
  const rise = 1.9;
  const slope = Math.hypot(halfW, rise);
  const ang = Math.atan2(rise, halfW);
  for (let i = 0; i <= 4; i += 1) {
    const z = -halfL + (i * L) / 4;
    for (const s of [-1, 1] as const) k.beam(M.steel, rise + 0.4, 0.26, slope * 0.98, s * halfW * 0.5, eave + rise * 0.45, z, 'x', { rz: -s * ang });
    k.beam(M.steel, 0.3, 0.3, W, 0, eave, z, 'x');
  }
  for (const s of [-1, 1] as const) {
    k.box(M.roofRust, slope + 0.3, 0.14, L + 0.6, s * halfW * 0.5, eave + rise * 0.5, 0, { rx: s * ang, outline: true });
  }
  k.box(M.rustDark, 0.4, 0.3, L + 0.7, 0, eave + rise + 0.05, 0);
  // 屋面锈穿的洞（补过的铁皮）
  for (let i = 0; i < 3; i += 1) {
    const px = rng.range(-halfW * 0.6, halfW * 0.6);
    const pz = rng.range(-halfL * 0.6, halfL * 0.6);
    k.box(M.metal, rng.range(0.9, 1.8), 0.12, rng.range(0.8, 1.6), px, eave + rise * 0.55 + 0.12, pz, { rx: rng.range(-ang, ang) });
  }
  // 短烟囱与烟管
  const sx = halfW - 1.4;
  k.cyl(M.rustDark, 0.52, 0.6, 5.2, sx, eave + 2.2, -halfL + 1.6, 12, { outline: true });
  k.ring(M.concrete, 0.62, 0.09, sx, eave + 4.2, -halfL + 1.6, 'y', 12);
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * TAU;
    k.plate(i % 2 === 0 ? M.burnt : M.soot, 0.3, rng.range(1.4, 3.6), sx + Math.sin(a) * 0.62, eave + 2.8, -halfL + 1.6 + Math.cos(a) * 0.62, -a);
  }
  k.bar(M.rust, 0.42, 3.4, sx - 1.7, eave - 0.6, -halfL + 1.6, 'x', 10);
  k.flange(M.metal, 0.42, sx - 3.3, eave - 0.6, -halfL + 1.6, 'x', 8);
  // 配电柜、油管与地面上的油污
  for (let i = 0; i < 4; i += 1) {
    k.box(M.metalDark, 0.9, 2.0, 0.6, -halfW + 1.2 + i * 1.3, 1.0, -halfL + 1.2);
    if (k.fine) k.box(M.paintRed, 0.18, 0.18, 0.05, -halfW + 1.5 + i * 1.3, 1.5, -halfL + 0.9);
  }
  for (let i = 0; i < 3; i += 1) k.blob(oilMat, rng.range(1.6, 2.8), rng.range(-halfW * 0.5, halfW * 0.5), 0.16, rng.range(-halfL * 0.4, halfL * 0.4), 0, 0.7);
  k.slab(M.concrete, W - 0.4, L - 0.4, 0, 0.14, 0);
  fx.smoke.push({ x: cx + sx, y: eave + 5.0, z: cz - halfL + 1.6, rise: 7, driftX: 1.1, driftZ: 2.2, size0: 0.7, size1: 3.4, alpha: 0.22, life: 10, color: SMOKE_BLACK.clone() });
}

/* ------------------------------------------------------------------ *
 * 15. 谷物筒仓（silo / wasteNE 锚点）：坍了半边
 * ------------------------------------------------------------------ */

function buildSilo(sink: Sink, rng: Rng, fx: Fx): void {
  const zone = zoneRect('wasteNE');
  const hots = HOTSPOTS.silo;
  const bins = 8;
  const ringR = 5.6;
  const binR = 2.5;
  const r = fitZone(
    rectOf(hots.x - ringR - binR - 1, hots.x + ringR + binR + 1, hots.z - ringR - binR - 1, hots.z + ringR + binR + 4),
    zone,
    0.8,
  );
  guard(r, 'silo');
  const heights = [15.5, 16, 12.5, 6.5, 4.5, 13, 15.8, 14.2];
  const collapsed = [3, 4];
  const kBase = new Kit(sink, rng, lodAt(hots.x, hots.z), frameOf(hots.x, hots.z));
  kBase.slab(M.concrete, ringR * 2 + 6, ringR * 2 + 6, 0, 0.12, 0);
  for (let i = 0; i < bins; i += 1) {
    const a = (i / bins) * TAU;
    const bx = hots.x + Math.sin(a) * ringR;
    const bz = hots.z + Math.cos(a) * ringR;
    const h = heights[i] as number;
    const isDown = collapsed.includes(i);
    const k = new Kit(sink, rng, lodAt(bx, bz), frameOf(bx, bz));
    if (isDown) {
      // 坍了半边：只有下半截筒壁，上沿参差，钢板外翻
      const low = h;
      k.cyl(M.metalDark, binR, binR * 1.02, low, 0, low / 2, 0, 16, { outline: true });
      for (let j = 0; j < 7; j += 1) {
        const aa = (j / 7) * TAU;
        const hh = low + rng.range(-1.2, 1.6);
        k.box(M.rust, 0.5, 0.7, 0.14, Math.sin(aa) * binR, hh, Math.cos(aa) * binR, { ry: -aa, rz: rng.range(-0.5, 0.5) });
      }
      // 外翻的壁板（带厚度的破片）
      for (let j = 0; j < 3; j += 1) {
        const geo = chippedSlab(2.2, 1.6, 0.12, rng, 0.34);
        geo.rotateY(rng.range(0, TAU));
        geo.translate(rng.range(-binR, binR), low * 0.4, rng.range(-binR, binR));
        k.push(geo, M.rustWarm);
      }
      k.blob(dustMat, binR * 2.2, 0, 0.06, 0, 0, 0.6);
      rubblePile(k, rng, binR + 1.6, 1.2, 3.4, 1.1, M.metalDark, k.n(22));
      fx.smoke.push({ x: bx, y: low + 0.6, z: bz, rise: 4, driftX: 1.0, driftZ: 1.8, size0: 0.6, size1: 2.6, alpha: 0.12, life: 12, color: SMOKE_GREY.clone() });
    } else {
      // 完好的仓筒：一圈圈钢板 + 环焊缝 + 顶部锥帽与检修平台
      const courses = 6;
      for (let c = 0; c < courses; c += 1) {
        const ch = h / courses;
        k.cyl(c % 2 === 0 ? M.metal : M.steel, binR, binR, ch - 0.05, 0, ch * (c + 0.5), 0, 16, c === 0 ? { outline: true } : {});
        k.ring(M.rustDark, binR + 0.03, 0.07, 0, ch * (c + 1), 0, 'y', 16);
      }
      k.cyl(M.roofRust, 0.5, binR + 0.1, 1.5, 0, h + 0.75, 0, 16);
      k.cyl(M.rust, 0.4, 0.44, 0.8, 0, h + 1.8, 0, 10);
      // 竖向流痕锈斑
      for (let j = 0; j < k.n(9); j += 1) {
        const aa = rng.range(0, TAU);
        shellPlate(k, binR + 0.04, aa, rng.range(1.5, h - 1), rng.range(0.35, 1.1), rng.range(1.2, 4), rng.chance(0.5) ? M.rustDark : M.rustWarm);
      }
      // 爬梯与提升塔
      const rungs: InstanceTransform[] = [];
      for (let y = 0.8; y < h - 0.6; y += 0.44) {
        rungs.push({ position: new THREE.Vector3(Math.sin(a) * (binR + 0.3), y, Math.cos(a) * (binR + 0.3)), rotation: new THREE.Euler(0, a, 0), scale: _one.clone() });
      }
      k.inst(G.rung(), M.rustDark, rungs);
      k.ring(M.steel, binR + 0.2, 0.07, 0, h + 0.2, 0, 'y', 16);
      for (let j = 0; j < k.n(10); j += 1) {
        const aa = (j / 10) * TAU;
        k.box(M.metalDark, 0.05, 0.9, 0.05, Math.sin(aa) * (binR + 0.2), h + 0.65, Math.cos(aa) * (binR + 0.2));
      }
    }
  }
  // 输送栈桥（朝厂区方向的提升塔在南侧，塌了一段）
  const kk = new Kit(sink, rng, lodAt(hots.x, hots.z), frameOf(hots.x, hots.z));
  const towerH = 17.5;
  for (const [tx, tz] of [[0, ringR + 3.6], [0, ringR + 6.2]] as Array<[number, number]>) {
    kk.box(M.metalDark, 0.6, towerH, 0.6, tx, towerH / 2, tz, { outline: true });
    for (let i = 0; i < 8; i += 1) {
      kk.bar(M.steel, 0.07, 1.4, tx, 1.6 + i * 2, tz, 'x', 5);
      kk.rod(M.steel, 0.05, new THREE.Vector3(tx - 0.7, 1.2 + i * 2, tz), new THREE.Vector3(tx + 0.7, 3.2 + i * 2, tz), 5);
    }
  }
  kk.box(M.roofRust, 3.2, 2.6, 2.2, 0, towerH + 0.6, ringR + 4.9, { outline: true });
  // 斜廊到厂房（中段被砸断）
  const from = new THREE.Vector3(0, towerH - 1.2, ringR + 3.2);
  const to = new THREE.Vector3(-6.4, towerH - 4.2, ringR - 1.4);
  kk.rod(M.rust, 0.34, from, to, 8);
  kk.ring(M.metalDark, 0.36, 0.06, from.x / 2, (from.y + to.y) / 2, (from.z + to.z) / 2, 'z', 10);
  const breakEnd = new THREE.Vector3(-7.6, towerH - 7.4, ringR + 3.4);
  kk.rod(M.rust, 0.34, to.clone().add(new THREE.Vector3(0, -0.4, 0)), breakEnd, 8, false);
  for (let i = 0; i < 4; i += 1) {
    kk.box(M.rustWarm, 1.6, 0.12, 0.9, to.x + rng.range(-1, 1), to.y + rng.range(-1.2, 0.4), to.z + rng.range(-1, 1), {
      rx: rng.range(-0.7, 0.7),
      rz: rng.range(-0.6, 0.6),
    });
  }
  rubblePile(kk, rng, 2, ringR + 4, 4.4, 1.2, M.metalDark, kk.n(26));
  metalLitter(kk, 3, ringR + 3, 4, 4, kk.n(12));
  // 溢出的谷物与草
  const grain: InstanceTransform[] = [];
  for (let i = 0; i < kk.n(40); i += 1) {
    grain.push({
      position: new THREE.Vector3(rng.range(-ringR - 3, ringR + 3), rng.range(0.16, 0.5), rng.range(-ringR - 3, ringR + 3)),
      rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)),
      scale: new THREE.Vector3(rng.range(0.14, 0.34), rng.range(0.1, 0.24), rng.range(0.14, 0.34)),
    });
  }
  kk.inst(G.chunkB(), M.paint, grain);
  const weeds: InstanceTransform[] = [];
  for (let i = 0; i < kk.n(34); i += 1) {
    const rr = rng.range(ringR + 1.2, ringR + 3.0);
    const aa = rng.range(0, TAU);
    weeds.push({
      position: new THREE.Vector3(Math.sin(aa) * rr, 0.3, Math.cos(aa) * rr),
      rotation: new THREE.Euler(rng.range(-0.2, 0.2), rng.range(0, 3), rng.range(-0.2, 0.2)),
      scale: new THREE.Vector3(1, rng.range(0.7, 1.8), 1),
    });
  }
  kk.inst(G.weedTuft(), M.weed, weeds);
}

/* ------------------------------------------------------------------ *
 * 16. 货车：棚车 / 罐车 / 平车 / 脱轨的漏斗车
 *     模型局部：+X 为车长方向，Z 为横向（轨距方向），y=0 = 轨顶
 * ------------------------------------------------------------------ */

const RAIL_Y = 0.33;
const HALF_GAUGE = RAIL.gauge / 2;

/** 转向架与底架：侧梁（工字）、横梁、枕梁、摇枕弹簧、制动缸与拉杆、风缸、车钩 */
function underframe(k: Kit, len: number): void {
  const half = len / 2;
  for (const s of [-1, 1] as const) {
    // 侧梁沿车长（局部 X），横向摆在 z = ±1.26
    k.beam(M.steel, 0.4, 0.3, len - 0.5, 0, 1.06, s * 1.26, 'x');
    k.box(M.metalDark, len - 0.4, 0.06, 0.12, 0, 1.3, s * 1.4);
  }
  const nb = 6;
  for (let i = 0; i < nb; i += 1) {
    const x = -half + 0.7 + (i * (len - 1.4)) / (nb - 1);
    // 横梁跨车宽（局部 Z），沿车长等距排开
    k.beam(M.metalDark, 0.3, 0.24, 2.5, x, 0.94, 0, 'z');
  }
  const bx = half - 2.1;
  for (const s of [-1, 1] as const) {
    k.box(M.metalDark, 0.52, 0.52, 2.7, s * bx, 1.02, 0);
    if (k.fine) k.box(M.rust, 0.58, 0.12, 2.9, s * bx, 1.3, 0);
    // 侧架（滑板）与承载鞍
    for (const t of [-1, 1] as const) {
      k.box(M.rustDark, 1.9, 0.26, 0.2, s * bx, 0.66, t * 0.98);
      k.box(M.metal, 0.42, 0.16, 0.34, s * (bx - 0.9 * (t > 0 ? -1 : 1)), 0.86, t * 0.98);
    }
    // 轴箱与板簧
    const springs: InstanceTransform[] = [];
    for (const wx of [s * bx - 0.9, s * bx + 0.9]) {
      for (const t of [-1, 1] as const) {
        springs.push({
          position: new THREE.Vector3(wx, 0.78, t * (HALF_GAUGE + 0.16)),
          rotation: new THREE.Euler(0, Math.PI / 2, 0),
          scale: new THREE.Vector3(1, 1, 1),
        });
      }
    }
    k.inst(G.leaf(), M.rustDark, springs);
  }
  // 基础制动装置：制动梁、拉杆、闸瓦钎、制动缸与副风缸
  k.beam(M.rust, 0.18, 0.18, 2.2, 0, 0.72, 0, 'z');
  k.bar(M.metalDark, 0.055, len * 0.5, -len * 0.14, 0.86, 0, 'x', 5);
  k.bar(M.metalDark, 0.05, 1.8, 0, 0.98, 0.5, 'z', 5);
  k.cyl(M.metal, 0.2, 0.2, 0.66, 0.9, 0.8, -0.42, 10, { rz: Math.PI / 2 });
  k.ring(M.rustDark, 0.21, 0.035, 0.6, 0.8, -0.42, 'x', 10);
  for (const s of [-1, 1] as const) {
    k.cyl(M.rust, 0.28, 0.28, 0.9, s * 2.4, 1.5, s * 0.62, 10, { rz: Math.PI / 2 });
    k.bar(M.rustDark, 0.05, 0.5, s * 2.4, 1.1, s * 0.62, 'y', 5);
  }
  // 车钩与从板
  for (const s of [-1, 1] as const) {
    k.box(M.metalDark, 0.7, 0.42, 0.5, s * (half + 0.15), 1.06, 0);
    k.cyl(M.metal, 0.14, 0.16, 0.34, s * (half + 0.5), 0.98, 0, 8, { rz: Math.PI / 2 });
    k.box(M.rust, 0.3, 0.26, 0.62, s * (half + 0.72), 0.92, 0);
    if (k.fine) {
      k.bar(M.metalDark, 0.04, 0.4, s * (half + 0.3), 1.32, 0.2, 'z', 4);
      k.box(M.metalDark, 0.5, 0.1, 0.66, s * (half + 0.05), 1.32, 0);
    }
  }
}

/** 轮对（4 轴 8 轮）；detached 时只留下轴箱，轮对另在地上 */
function wagonWheels(k: Kit, len: number, o: { detached?: boolean; loose?: boolean } = {}): void {
  const half = len / 2;
  const bx = half - 2.1;
  const xs = [-bx - 0.9, -bx + 0.9, bx - 0.9, bx + 0.9];
  const discs: InstanceTransform[] = [];
  const hubs: InstanceTransform[] = [];
  const tires: InstanceTransform[] = [];
  for (const wx of xs) {
    for (const s of [-1, 1] as const) {
      const p = new THREE.Vector3(wx, 0.5, s * HALF_GAUGE);
      discs.push({ position: p.clone(), rotation: new THREE.Euler(Math.PI / 2, 0, 0), scale: _one.clone() });
      hubs.push({ position: p.clone(), rotation: new THREE.Euler(Math.PI / 2, 0, 0), scale: _one.clone() });
      tires.push({ position: p.clone(), rotation: new THREE.Euler(0, 0, 0), scale: _one.clone() });
    }
    // 车轴
    k.bar(M.metalDark, 0.09, RAIL.gauge + 0.3, wx, 0.5, 0, 'z', 6);
  }
  if (!o.detached) {
    k.inst(G.wheel(), M.metalDark, discs);
    k.inst(G.hub(), M.rustDark, hubs);
    k.inst(G.tire(), M.metalDark, tires);
  }
}

/** 棚车：带滑门、门把手、锁钩、上导轨与滚轮 */
function buildBoxcar(k: Kit, len: number, o: { doorOpen?: number; battered?: boolean } = {}): void {
  const rng = k.rng;
  underframe(k, len);
  wagonWheels(k, len);
  const half = len / 2;
  const floorY = 1.36;
  const wallH = 3.0;
  const sideZ = 1.45;
  const t = 0.14;
  const doorU = 0.9;
  const doorW = 2.5;
  const breaks: Array<[number, number, number, number]> = [[doorU - doorW / 2, floorY + 0.05, doorU + doorW / 2, floorY + wallH - 0.35]];
  if (o.battered && rng.chance(0.6)) breaks.push([-half + 1.2, floorY + 0.4, -half + 2.6, floorY + wallH - 0.8]);

  for (const s of [-1, 1] as const) {
    const cfg: WallCfg = {
      axis: 'z',
      at: s * sideZ,
      u0: -half,
      u1: half,
      y0: floorY,
      y1: floorY + wallH,
      t,
      inward: s > 0 ? -1 : 1,
      breaks: s < 0 ? breaks : [breaks[0] as [number, number, number, number]],
    };
    curtainWall(k, cfg, s < 0 ? M.rust : M.rustWarm, false);
    for (const b of cfg.breaks ?? []) {
      if (b[2] - b[0] < 1.6) breach(k, cfg, b, { rebar: 2, chips: 2, debris: 8 });
      else reveal(k, cfg, b);
    }
    // 侧柱（压型 ribs）
    if (k.fine) {
      for (let i = 0; i < 9; i += 1) {
        const x = -half + 0.4 + (i * (len - 0.8)) / 8;
        if (Math.abs(x - doorU) < doorW / 2 + 0.2) continue;
        k.box(M.rustDark, 0.1, wallH - 0.2, 0.1, x, floorY + wallH / 2, s * (sideZ + 0.05));
      }
    }
    // 上侧梁与下侧梁的明度差
    k.box(M.metalDark, len, 0.16, 0.12, 0, floorY + wallH + 0.06, s * sideZ);
  }
  // 滑门：一扇半开（挂在导轨上、滚轮可见），门把手 + 锁钩 + 铰链
  const open = o.doorOpen ?? rng.range(0, doorW * 0.55);
  for (const s of [-1, 1] as const) {
    const p = _b.set(doorU + open * (s < 0 ? 1 : -1), floorY + wallH / 2 - 0.1, s * (sideZ + 0.06));
    const leafW = doorW - open * 0.2;
    doorLeaf(k, p.x, p.y, p.z, leafW, wallH - 0.45, 0, {
      mat: s < 0 ? M.rust : M.rustDark,
      hinge: false,
      handle: true,
      lock: s < 0,
    });
    if (k.fine) {
      // 滚轮与导轨
      for (const g of [-1, 1] as const) {
        k.cyl(M.metal, 0.08, 0.08, 0.1, p.x + g * leafW * 0.4, floorY + wallH - 0.2, p.z + (s > 0 ? 0.1 : -0.1), 6, { rx: Math.PI / 2 });
      }
    }
  }
  for (const s of [-1, 1] as const) {
    k.beam(M.rustDark, 0.16, 0.16, len * 0.5, doorU + len * 0.12, floorY + wallH + 0.2, s * (sideZ + 0.08), 'x');
  }
  // 端墙 + 通风窗
  for (const s of [-1, 1] as const) {
    const cfg: WallCfg = { axis: 'x', at: s * half, u0: -sideZ, u1: sideZ, y0: floorY, y1: floorY + wallH, t: 0.12, inward: s > 0 ? 1 : -1, breaks: [] };
    curtainWall(k, cfg, M.rust, false);
    for (let i = 0; i < 2; i += 1) {
      k.box(M.dark, 0.06, 0.34, 0.5, s * (half + 0.04), floorY + wallH - 0.7 - i * 0.5, 0);
    }
    // 扶手（登车梯）
    if (k.fine) {
      for (let i = 0; i < 3; i += 1) k.bar(M.rustDark, 0.028, 0.34, s * (half + 0.16), floorY + 0.9 + i * 0.7, sideZ - 0.2, 'z', 4);
    }
  }
  // 车顶：微拱 + 通风罩 + 撞裂的缝
  const roofMat = o.battered ? M.rustDeep : M.roofDark;
  k.box(roofMat, len - 0.1, 0.14, sideZ * 2 + 0.06, 0, floorY + wallH + 0.2, 0, { outline: true });
  for (let i = 0; i < 4; i += 1) {
    k.box(M.rustDark, 0.1, 0.1, sideZ * 2, -half + 1 + i * (len - 2) / 3, floorY + wallH + 0.26, 0);
  }
  for (const x of [-len * 0.26, len * 0.3]) {
    k.cyl(M.metal, 0.26, 0.3, 0.3, x, floorY + wallH + 0.42, 0, 10);
    k.ring(M.rust, 0.3, 0.05, x, floorY + wallH + 0.56, 0, 'y', 10);
  }
  if (o.battered) {
    // 被撞裂的车顶：几片翘起的铁皮 + 裂缝
    for (let i = 0; i < 4; i += 1) {
      const x = rng.range(-half + 1, half - 1);
      k.box(M.rustWarm, rng.range(0.6, 1.4), 0.08, rng.range(0.5, 1.2), x, floorY + wallH + 0.34, rng.range(-1, 1), {
        rx: rng.range(-0.5, 0.5),
        rz: rng.range(-0.6, 0.6),
      });
    }
    k.bar(M.dark, 0.06, len * 0.4, 0, floorY + wallH + 0.26, 0.2, 'x', 4);
  }
  // 侧面铭文板与锈色分层
  for (const s of [-1, 1] as const) {
    k.plate(M.paint, 1.9, 0.34, doorU - 2.4, floorY + wallH * 0.62, s * (sideZ + 0.09), s > 0 ? Math.PI : 0);
    for (let i = 0; i < k.n(6); i += 1) {
      k.plate(rng.chance(0.5) ? M.rustDark : M.rustDeep, rng.range(0.3, 1.1), rng.range(0.4, 1.4), rng.range(-half + 0.6, half - 0.6), floorY + rng.range(0.4, wallH - 0.4), s * (sideZ + 0.07), s > 0 ? Math.PI : 0);
    }
  }
  // 车号牌（西侧墙，跟车身一起被 frame 变换）
  const tagGeo = new THREE.PlaneGeometry(1.1, 0.32);
  tagGeo.rotateY(Math.PI);
  tagGeo.translate(-half + 2.4, floorY + wallH - 0.75, -sideZ - 0.1);
  k.push(
    tagGeo,
    new THREE.MeshBasicMaterial({ map: plateTexture('G-12', 'х 4718 · 棚车', '#2b241d', '#cfc3a2', true), fog: true, color: 0xb9bdba }),
    false,
    false,
  );
}

/** 罐车：卧式罐体 + 鞍座 + 顶部走台 + 装卸口 + 扶梯 */
function buildTankCar(k: Kit, len: number): void {
  const rng = k.rng;
  underframe(k, len);
  wagonWheels(k, len);
  const R = 1.42;
  const cy = 1.36 + R + 0.16;
  const bodyLen = len - 2.4;
  k.cyl(M.rust, R, R, bodyLen, 0, cy, 0, 18, { rz: Math.PI / 2, outline: true });
  for (const s of [-1, 1] as const) {
    k.cyl(M.rustWarm, 0.02, R, 0.9, s * (bodyLen / 2 + 0.45), cy, 0, 18, { rz: s > 0 ? -Math.PI / 2 : Math.PI / 2 });
  }
  // 环形焊缝与铆钉带
  for (let i = 0; i < 5; i += 1) {
    const x = -bodyLen / 2 + (i * bodyLen) / 4;
    k.ring(M.rustDark, R + 0.02, 0.06, x, cy, 0, 'x', 18);
    const rivets: InstanceTransform[] = [];
    const count = k.n(20);
    for (let j = 0; j < count; j += 1) {
      const a = (j / count) * TAU;
      rivets.push({
        position: new THREE.Vector3(x, cy + Math.cos(a) * (R + 0.04), Math.sin(a) * (R + 0.04)),
        rotation: new THREE.Euler(a, 0, 0),
        scale: _one.clone(),
      });
    }
    k.inst(G.rivet(), M.metalDark, rivets);
  }
  // 鞍座（把罐体压在底架上）
  for (const s of [-1, 1] as const) {
    k.box(M.metalDark, 0.5, 0.7, 2.4, s * (bodyLen / 2 - 0.9), 1.5, 0);
    k.beam(M.steel, 0.24, 0.3, 2.6, s * (bodyLen / 2 - 0.9), 1.2, 0, 'z');
  }
  // 顶部走台、护栏与装卸口
  k.box(M.metal, bodyLen * 0.9, 0.08, 0.7, -bodyLen * 0.05, cy + R + 0.1, 0);
  for (let i = 0; i < 8; i += 1) {
    const x = -bodyLen * 0.45 + (i * bodyLen * 0.9) / 7;
    k.box(M.rustDark, 0.05, 0.7, 0.05, x, cy + R + 0.45, 0.32);
  }
  k.bar(M.rust, 0.035, bodyLen * 0.9, -bodyLen * 0.05, cy + R + 0.78, 0.32, 'x', 5);
  for (const x of [-bodyLen * 0.3, bodyLen * 0.28]) {
    k.cyl(M.metalDark, 0.34, 0.36, 0.34, x, cy + R + 0.24, 0, 10);
    k.cyl(M.dark, 0.28, 0.28, 0.1, x, cy + R + 0.4, 0, 10);
    if (k.fine) k.bar(M.rust, 0.04, 0.5, x, cy + R + 0.5, 0.2, 'z', 5);
  }
  // 卸料管 + 法兰 + 阀
  const ex = bodyLen / 2 - 0.4;
  k.bar(M.rust, 0.14, 1.1, ex, cy - R - 0.3, 0, 'y', 8);
  k.flange(M.metal, 0.14, ex, cy - R - 0.85, 0, 'y', 7);
  k.cyl(M.metalDark, 0.2, 0.2, 0.3, ex, cy - R - 0.6, 0, 8, { rx: Math.PI / 2 });
  // 两端扶梯
  for (const s of [-1, 1] as const) {
    const rungs: InstanceTransform[] = [];
    for (let y = 1.6; y < cy + R; y += 0.44) rungs.push({ position: new THREE.Vector3(s * (len / 2 - 0.1), y, 0.28), rotation: new THREE.Euler(0, 0, Math.PI / 2), scale: _one.clone() });
    k.inst(G.rung(), M.rustDark, rungs);
    for (const t of [-1, 1] as const) k.bar(M.rust, 0.03, cy + R - 1.5, s * (len / 2 - 0.1), (1.5 + cy + R) / 2, 0.28 + t * 0.24, 'y', 5);
  }
  // 锈色分层
  for (let i = 0; i < k.n(12); i += 1) {
    const a = rng.range(0, TAU);
    const x = rng.range(-bodyLen / 2, bodyLen / 2);
    k.plate(rng.chance(0.4) ? M.rustDeep : M.rustWarm, rng.range(0.4, 1.3), rng.range(0.5, 1.6), x, cy + Math.cos(a) * R * 0.9, Math.sin(a) * R * 0.9, -a * 0.0 + rng.range(-0.3, 0.3));
  }
}

/** 平车：裸枕木面板 + 立柱 + 原木与散枕木 */
function buildFlatcar(k: Kit, len: number): void {
  const rng = k.rng;
  underframe(k, len);
  wagonWheels(k, len);
  const half = len / 2;
  const deckY = 1.4;
  // 裸枕木面板（横铺，一根一根看得见）
  const planks: InstanceTransform[] = [];
  const count = Math.round((len - 0.4) / 0.34);
  for (let i = 0; i < count; i += 1) {
    planks.push({
      position: new THREE.Vector3(-half + 0.25 + i * ((len - 0.5) / count) + rng.range(-0.01, 0.01), deckY, 0),
      rotation: new THREE.Euler(0, rng.gauss(0, 0.006), rng.gauss(0, 0.01)),
      scale: new THREE.Vector3(rng.range(0.9, 1.1), rng.range(0.8, 1), 1),
    });
  }
  const plankGeo = new THREE.BoxGeometry(0.3, 0.11, 2.86);
  k.inst(plankGeo, M.wood, planks);
  // 侧梁与端梁
  for (const s of [-1, 1] as const) k.box(M.woodDark, len - 0.2, 0.24, 0.18, 0, deckY - 0.1, s * 1.42);
  // 可拆立柱 + 侧栏
  for (const s of [-1, 1] as const) {
    for (let i = 0; i < 5; i += 1) {
      const x = -half + 0.8 + i * ((len - 1.6) / 4);
      if (i === 2) continue;
      k.box(M.wood, 0.14, 0.9, 0.14, x, deckY + 0.5, s * 1.36, { rz: rng.gauss(0, 0.03) });
    }
    for (let i = 0; i < 3; i += 1) k.bar(M.rust, 0.035, len - 1.4, 0, deckY + 0.35 + i * 0.28, s * 1.36, 'x', 5);
  }
  // 车上货物：一捆原木 + 一堆散枕木
  const logs: InstanceTransform[] = [];
  for (let i = 0; i < 8; i += 1) {
    const row = Math.floor(i / 4);
    logs.push({
      position: new THREE.Vector3(-half + 2.2 + (i % 4) * 1.1, deckY + 0.24 + row * 0.44, 0),
      rotation: new THREE.Euler(0, 0, Math.PI / 2),
      scale: new THREE.Vector3(1, 1, 1),
    });
  }
  k.inst(new THREE.CylinderGeometry(0.22, 0.22, 4.2, 8), M.wood, logs);
  const sleepers: InstanceTransform[] = [];
  for (let i = 0; i < 5; i += 1) {
    sleepers.push({
      position: new THREE.Vector3(half - 1.4 - i * 0.3, deckY + 0.16 + Math.floor(i / 3) * 0.16, rng.range(-0.6, 0.6)),
      rotation: new THREE.Euler(0, rng.range(-0.1, 0.1), 0),
      scale: _one.clone(),
    });
  }
  k.inst(G.sleeper(), M.woodDark, sleepers);
  // 拴索环与紧线器
  for (const s of [-1, 1] as const) {
    for (let i = 0; i < 4; i += 1) {
      k.ring(M.rustDark, 0.1, 0.03, -half + 1 + i * (len / 4), deckY - 0.06, s * 1.3, 'y', 8);
    }
  }
}

/** 脱轨的漏斗车：车体侧倾、轮对悬空、滑板与制动缸外露、车顶撞裂 */
function buildDerailedGondola(k: Kit, len: number): void {
  const rng = k.rng;
  underframe(k, len);
  // 轮对只画一半：另一侧的轮对已经掉在地上（在拖痕里重建）
  const half = len / 2;
  const discs: InstanceTransform[] = [];
  for (const wx of [-half + 2.1 - 0.9, -half + 2.1 + 0.9, half - 2.1 - 0.9, half - 2.1 + 0.9]) {
    discs.push({ position: new THREE.Vector3(wx, 0.5, -HALF_GAUGE), rotation: new THREE.Euler(Math.PI / 2, rng.range(-0.4, 0.4), 0), scale: _one.clone() });
  }
  k.inst(G.wheel(), M.metalDark, discs);
  for (const wx of [-half + 2.1, half - 2.1]) {
    k.box(M.rustDark, 1.9, 0.26, 0.2, wx, 0.66, HALF_GAUGE + 0.24);
    k.bar(M.metalDark, 0.09, RAIL.gauge + 0.3, wx, 0.5, 0.2, 'z', 6);
  }
  // 外露的制动缸（脱落了一半，吊在拉杆上）
  k.cyl(M.metal, 0.2, 0.2, 0.66, 0.4, 0.5, 0.5, 10, { rz: Math.PI / 2, rx: 0.4 });
  k.bar(M.rust, 0.05, 1.1, -0.2, 0.7, 0.5, 'x', 5);
  k.bar(M.metalDark, 0.045, 0.8, 0.9, 0.9, 0.5, 'z', 5);
  // 车体：漏斗侧墙（外胀、破裂）
  const floorY = 1.36;
  const wallH = 2.2;
  for (const s of [-1, 1] as const) {
    const cfg: WallCfg = {
      axis: 'z',
      at: s * 1.4,
      u0: -half,
      u1: half,
      y0: floorY,
      y1: floorY + wallH,
      t: 0.13,
      inward: s > 0 ? -1 : 1,
      breaks: s < 0 ? [[-half + 1.4, floorY + 0.5, -half + 3.4, floorY + wallH]] : [],
    };
    curtainWall(k, cfg, M.rustWarm, false);
    for (const b of cfg.breaks ?? []) breach(k, cfg, b, { rebar: 2, chips: 2, debris: 8 });
    // 外胀的侧墙（整体歪出来一点）
    k.box(M.rustDark, len - 0.4, 0.2, 0.16, 0, floorY + wallH - 0.1, s * (1.4 + 0.12 * (s > 0 ? 1 : -1)));
    for (let i = 0; i < 6; i += 1) {
      const x = -half + 0.5 + i * ((len - 1) / 5);
      k.box(M.rust, 0.12, wallH, 0.12, x, floorY + wallH / 2, s * 1.46);
    }
  }
  for (const s of [-1, 1] as const) {
    const cfg: WallCfg = { axis: 'x', at: s * half, u0: -1.4, u1: 1.4, y0: floorY, y1: floorY + wallH, t: 0.12, inward: s > 0 ? 1 : -1, breaks: [] };
    curtainWall(k, cfg, M.rust, false);
  }
  // 漏斗卸料口（半开）
  k.box(M.metalDark, 1.6, 0.12, 1.2, 0, floorY - 0.1, 0);
  k.box(M.rust, 1.6, 0.7, 0.1, 0, floorY - 0.4, 0.6, { rx: 0.9 });
  // 撞裂的车顶盖板：翘起的铁皮 + 破损的木塞
  for (let i = 0; i < 4; i += 1) {
    const x = -half + 1 + i * (len / 4.5);
    k.box(i % 2 === 0 ? M.roofRust : M.rustDark, 1.4, 0.09, 1.1, x, floorY + wallH + 0.1, rng.range(-0.5, 0.5), {
      rx: rng.range(-0.6, 0.6),
      rz: rng.range(-0.5, 0.5),
    });
  }
  // 洒落的货物（袋与箱）
  const cargo: InstanceTransform[] = [];
  for (let i = 0; i < k.n(16); i += 1) {
    cargo.push({
      position: new THREE.Vector3(rng.range(-half * 0.9, half * 0.9), floorY + rng.range(0.2, 1.6), rng.range(-1.1, 1.1)),
      rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)),
      scale: new THREE.Vector3(rng.range(0.5, 1), rng.range(0.4, 0.8), rng.range(0.5, 1)),
    });
  }
  k.inst(G.chunkA(), M.paint, cargo);
}

/** 脱轨拖痕：犁开的道砟、撕裂的枕木、切断的钢轨、掉落的轮对与木箱 */
function buildDerailTrail(sink: Sink, rng: Rng, fx: Fx): void {
  const d = HOTSPOTS.derailed;
  railGuard(rectOf(123.4, 136.4, 79.0, 90.8), 'derailTrail', { spill: true });
  const k = new Kit(sink, rng, lodAt(d.x, d.z), IDENTITY);
  // 犁开的道砟与泥土（从车体位置一直划到 derailed 锚点；z 收到 90.2 以避开南环道人行道）
  const from = { x: 130.2, z: 85.6 };
  const trailTo = { x: d.x + 0.4, z: 89.8 };
  for (let i = 0; i < 8; i += 1) {
    const t = i / 7;
    const x = from.x + (trailTo.x - from.x) * t;
    const z = from.z + (trailTo.z - from.z) * t;
    k.blob(dustMat, 0.9 + t * 0.6, x, 0.19, z, 0.6, 0.5);
  }
  const ballast: InstanceTransform[] = [];
  for (let i = 0; i < k.n(46); i += 1) {
    const t = rng.next();
    const x = from.x + (trailTo.x - from.x) * t + rng.range(-1.4, 1.4);
    const z = from.z + (trailTo.z - from.z) * t + rng.range(-1.2, 1.2);
    ballast.push({
      position: new THREE.Vector3(x, 0.2 + rng.range(0, 0.3), z),
      rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 6), rng.range(0, 3)),
      scale: new THREE.Vector3(rng.range(0.3, 0.8), rng.range(0.24, 0.5), rng.range(0.3, 0.8)),
    });
  }
  for (let i = 0; i < ballast.length; i += 3) k.inst(chunkAt(i), M.concreteDark, [ballast[i] as InstanceTransform]);
  // 被犁翻、撕裂的枕木
  const sleepers: InstanceTransform[] = [];
  for (let i = 0; i < k.n(11); i += 1) {
    const t = rng.range(0.05, 1);
    sleepers.push({
      position: new THREE.Vector3(from.x + (trailTo.x - from.x) * t + rng.range(-0.8, 0.8), 0.24 + rng.range(0, 0.5), from.z + (trailTo.z - from.z) * t + rng.range(-0.8, 0.8)),
      rotation: new THREE.Euler(rng.range(-0.7, 0.7), rng.range(1.1, 2.1), rng.range(-0.5, 0.5)),
      scale: new THREE.Vector3(rng.range(0.8, 1.1), rng.range(0.8, 1.2), 1),
    });
  }
  k.inst(G.sleeper(), M.woodDark, sleepers);
  // 切断的钢轨切片（歪倒在线路边）
  railSlice(k, 129.4, 88.4, 3.2, -0.5);
  railSlice(k, 131.2, 88.6, 2.4, -0.9);
  railSlice(k, 127.6, 84.2, 4.2, -0.34);
  k.box(M.railSteel, 0.16, 0.18, 5.4, 133.4, 0.4, 88.0, { ry: -0.42, rz: 0.14 });
  // 掉地的轮对（躺在道砟上）+ 滑板与制动缸零件
  const loose: InstanceTransform[] = [];
  for (const [x, z, ry] of [[127.9, 89.6, 0.3], [130.6, 89.9, -0.5], [126.8, 82.4, 1.1]] as Array<[number, number, number]>) {
    loose.push({ position: new THREE.Vector3(x, 0.46, z), rotation: new THREE.Euler(Math.PI / 2, 0, ry), scale: _one.clone() });
  }
  k.inst(G.wheel(), M.metalDark, loose);
  k.box(M.rustDark, 1.9, 0.26, 0.2, 128.6, 0.34, 89.4, { ry: 0.8, rz: 0.1 });
  k.cyl(M.metal, 0.2, 0.2, 0.66, 131.6, 0.36, 89.4, 10, { rx: 1.2 });
  metalLitter(k, 129.2, 87.2, 6, 5, k.n(24));
  // 散落的货物木箱（有一只摔开了）
  for (const [x, z, ry, s] of [[126.4, 88.6, 0.4, 1], [127.6, 89.2, -0.9, 0.9], [125.8, 87.4, 1.6, 1.1]] as Array<[number, number, number, number]>) {
    k.box(M.wood, 0.9 * s, 0.72 * s, 0.9 * s, x, 0.36 * s, z, { ry, outline: true });
    if (s > 1 && k.fine) {
      for (let i = 0; i < 4; i += 1) k.box(M.board, 0.7, 0.06, 0.4, x + rng.range(-0.5, 0.5), 0.7 + i * 0.04, z + rng.range(-0.5, 0.5), { ry: rng.range(0, 3) });
    }
  }
  const crates: InstanceTransform[] = [];
  for (let i = 0; i < k.n(9); i += 1) {
    crates.push({
      position: new THREE.Vector3(127.4 + rng.range(-2.4, 2.4), 0.2 + rng.range(0, 0.3), 88.2 + rng.range(-2.2, 2.0)),
      rotation: new THREE.Euler(rng.range(-0.3, 0.3), rng.range(0, 3), rng.range(-0.4, 0.4)),
      scale: new THREE.Vector3(rng.range(0.7, 1), rng.range(0.5, 0.9), rng.range(0.7, 1)),
    });
  }
  k.inst(G.crate(), M.woodDark, crates);
  // 撒漏的货与油渍
  k.blob(oilMat, 2.0, 128.4, 0.06, 88.2, 0, 0.8);
  k.blob(dustMat, 3.4, 130.2, 0.055, 86.6, 0, 0.6);
  // 撞断的电线杆与信号板（倒在道砟带上）
  k.bar(M.woodDark, 0.14, 6.2, 126.9, 0.4, 84.6, 'x', 8);
  k.plate(M.paintRed, 0.9, 0.9, 124.2, 0.5, 84.2, 1.2, 0.3);
  fx.glow.push({ x: 129.6, y: 0.7, z: 87.4, r: 0.55, color: EMBER_COLOR.clone() });
  fx.sparks.push({ x: 129.6, y: 0.8, z: 87.4 });
  fx.smoke.push({ x: 129.2, y: 0.9, z: 87.2, rise: 4.5, driftX: 0.9, driftZ: 1.6, size0: 0.5, size1: 2.4, alpha: 0.18, life: 9, color: SMOKE_BLACK.clone() });
}

/** 道口与转辙器（属于铁路的资产） */
function buildRailFurniture(sink: Sink, rng: Rng): void {
  for (const [x, z, ry] of [[136.6, -89.4, 0], [136.4, 111.2, Math.PI], [130.6, -14.6, 0]] as Array<[number, number, number]>) {
    const k = new Kit(sink, rng, lodAt(x, z), frameOf(x, z, ry));
    railGuard(rectOf(x - 1.4, x + 1.4, z - 1.4, z + 1.4), `levelCrossing-${z}`);
    // 信号机：柱 + 梯子 + 臂板（彩色板）
    k.cyl(M.rust, 0.13, 0.16, 6.4, 0, 3.2, 0, 8, { outline: true });
    k.box(M.metalDark, 0.7, 0.1, 0.7, 0, 0.06, 0);
    for (let i = 0; i < 8; i += 1) k.box(M.rustDark, 0.4, 0.05, 0.05, 0.24, 0.7 + i * 0.6, 0);
    k.bar(M.rust, 0.03, 2.4, 0, 2.1 + 2.4, 0, 'y', 5);
    k.box(M.paintRed, 1.5, 0.5, 0.08, -0.7, 5.6, 0.05);
    k.box(M.metalDark, 0.9, 0.9, 0.1, 0, 5.9, 0);
    k.ring(M.metal, 0.3, 0.05, 0, 5.3, 0.1, 'z', 10);
    // 警示牌 + 铃
    k.box(M.metalDark, 0.1, 2.4, 0.1, -1.0, 1.2, 0.6);
    k.plate(M.signGreen, 1.1, 0.7, -1.0, 2.2, 0.7, Math.PI / 2);
    k.ring(M.rust, 0.24, 0.05, -1.0, 1.9, 0.9, 'x', 10);
    // 道口栏杆（已断，斜挂在柱上）
    k.box(M.paint, 2.6, 0.12, 0.12, 1.0, 1.1, -0.6, { rz: -0.55, outline: true });
    for (let i = 0; i < 3; i += 1) k.box(M.paintRed, 0.4, 0.13, 0.13, 0.35 + i * 0.72, 1.28 - i * 0.34, -0.6, { rz: -0.55 });
  }
  // 转辙器（装卸线岔口）：扳道机 + 拉杆 + 尖轨
  const tx = RAIL.at - 2.0;
  const tz = RAIL.spur.at + 4.6;
  const kk = new Kit(sink, rng, lodAt(tx, tz), frameOf(tx, tz));
  railGuard(rectOf(tx - 2.2, tx + 2.2, tz - 2.2, tz + 2.2), 'turnout');
  kk.box(M.metalDark, 0.6, 1.1, 0.5, 0, 0.55, 0, { outline: true });
  kk.bar(M.rust, 0.05, 2.6, -1.2, 0.42, 0, 'x', 5);
  kk.bar(M.rust, 0.045, 1.6, 0, 0.9, 0.6, 'z', 5);
  kk.box(M.metal, 0.24, 0.3, 0.24, 0, 1.2, 0);
  for (const s of [-1, 1] as const) kk.box(M.railSteel, 0.14, 0.14, 3.2, s * 0.5, 0.4, -1.4, { rz: s * 0.06 });
  // 道钉要按世界坐标摆放，所以另开一个不做二次变换的 Kit
  const ksp = new Kit(sink, rng, lodAt(tx, tz), IDENTITY);
  trackSpikes(ksp, 'x', RAIL.spur.at, RAIL.spur.from + 0.6, RAIL.at - 0.4);
  trackSpikes(ksp, 'z', RAIL.at, RAIL.spur.at + 0.6, 116);
}

/* ------------------------------------------------------------------ *
 * 17. 南端装卸场（indSiding / loadingRamp）
 * ------------------------------------------------------------------ */

/** 装卸站台：混凝土台面 + 被砸烂的黄色油漆线 + 破边与外露钢筋 */
function buildLoadingPlatform(sink: Sink, rng: Rng): void {
  const zone = zoneRect('indSiding');
  const r = fitZone(rectOf(110.6, 128.9, 110.6, 116.0), zone, SIDING_MARGIN);
  guard(r, 'loadingRamp');
  const cx = (r.x0 + r.x1) / 2;
  const cz = (r.z0 + r.z1) / 2;
  const W = r.x1 - r.x0;
  const L = r.z1 - r.z0;
  const k = new Kit(sink, rng, lodAt(cx, cz), frameOf(cx, cz));
  const half = W / 2;
  const hz = L / 2;
  const top = 1.16;

  // 台面（沿线路方向分格，靠线路一边的压顶石另是一档明度）
  k.box(M.concrete, W, top - 0.1, L, 0, (top - 0.1) / 2, 0, { outline: true });
  k.box(M.concreteDark, W, 0.1, 0.3, 0, top - 0.02, -hz + 0.15);
  for (let i = 0; i < 9; i += 1) {
    const x = -half + (i + 0.5) * (W / 9);
    k.box(M.concreteDark, 0.07, 0.06, L - 0.5, x, top + 0.01, 0);
  }
  // 挡墙立面：污渍与破片
  wallGrime(k, { axis: 'z', at: -hz, u0: -half, u1: half, y0: 0, y1: top, t: 0.1, inward: -1, breaks: [] } as WallCfg, k.n(5), M.dirt);
  for (let i = 0; i < k.n(6); i += 1) {
    const geo = chippedSlab(rng.range(0.7, 1.5), rng.range(0.5, 1.1), 0.1, rng, 0.3);
    geo.rotateY(Math.PI / 2);
    geo.translate(rng.range(-half + 1, half - 1), rng.range(0.3, top - 0.2), -hz - 0.02);
    k.push(geo, M.concreteDark);
  }

  // 黄色油漆线：分段、被砸烂（缺失、错位、裂缝）
  const pitch = 1.15;
  for (let i = 0; i < Math.floor((W - 1) / pitch); i += 1) {
    const x = -half + 0.6 + i * pitch;
    const gone = rng.chance(0.32);
    if (gone) continue;
    k.slab(M.paintYellow, pitch * 0.82, 0.34, x, top + 0.035, -hz + 0.62);
    if (rng.chance(0.28)) k.slab(M.paintYellow, pitch * 0.3, 0.3, x + 0.2, top + 0.05, -hz + 0.72, rng.range(-0.4, 0.4));
    if (rng.chance(0.22)) k.slab(M.dark, 0.1, 0.36, x, top + 0.04, -hz + 0.62, rng.range(-0.5, 0.5));
  }
  // 被砸烂的一段：整块面层崩掉，露出骨料与钢筋
  const dmgX = half - 4.2;
  const dmg = chippedSlab(2.6, 1.0, 0.14, rng, 0.34);
  dmg.rotateX(-Math.PI / 2);
  dmg.translate(dmgX, top + 0.02, -hz + 0.7);
  k.push(dmg, M.concreteDark);
  k.box(M.dark, 2.4, 0.14, 0.9, dmgX, top - 0.06, -hz + 0.7);
  for (let i = 0; i < 5; i += 1) {
    k.rod(M.rust, 0.028, new THREE.Vector3(dmgX - 1.1 + i * 0.5, top - 0.02, -hz + 0.4), new THREE.Vector3(dmgX - 1.2 + i * 0.5 + rng.range(-0.2, 0.3), top + rng.range(0.2, 0.7), -hz + 0.9 + rng.range(-0.2, 0.3)), 5);
  }
  const chips: InstanceTransform[] = [];
  for (let i = 0; i < k.n(14); i += 1) {
    chips.push({
      position: new THREE.Vector3(dmgX + rng.range(-1.8, 1.8), top + 0.06, -hz + rng.range(0.1, 1.3)),
      rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)),
      scale: new THREE.Vector3(rng.range(0.3, 0.9), rng.range(0.2, 0.5), rng.range(0.3, 0.9)),
    });
  }
  k.inst(G.chunkB(), M.concrete, chips);

  // 站台边缘的系缆环与防撞木
  for (let i = 0; i < 7; i += 1) {
    const x = -half + 1.4 + i * ((W - 2.8) / 6);
    k.ring(M.rustDark, 0.12, 0.04, x, top + 0.08, -hz + 0.28, 'z', 8);
    if (k.fine) k.box(M.woodDark, 0.3, 0.2, 0.14, x, top - 0.1, -hz - 0.04);
  }
  // 台阶 + 手推车坡道
  const st = half - 9.6;
  for (let i = 0; i < 4; i += 1) {
    k.box(M.concrete, 1.5, 0.24, 0.34, st, 0.12 + i * 0.24, hz + 0.2 + i * 0.34);
  }
  k.box(M.wood, 1.1, 0.1, 2.4, st + 1.6, 0.55, hz + 0.9, { rx: -0.42 });

  // 台面上的货物：木箱、托盘、盖油布的垛
  for (let i = 0; i < 9; i += 1) {
    const x = rng.range(-half + 2, half - 3);
    const z = rng.range(-hz + 1.4, hz - 1.2);
    const s = rng.range(0.7, 1.2);
    k.box(rng.chance(0.5) ? M.wood : M.woodDark, 0.95 * s, 0.8 * s, 0.9 * s, x, top + 0.4 * s, z, { ry: rng.range(0, 1.4), outline: i === 0 });
    if (k.fine && rng.chance(0.5)) k.box(M.board, 0.95 * s, 0.06, 0.16, x, top + 0.82 * s, z, { ry: rng.range(0, 1.4) });
  }
  for (let i = 0; i < 4; i += 1) {
    const x = -half + 3 + i * 3.4;
    const z = hz - 1.6;
    for (let j = 0; j < 3; j += 1) k.box(M.wood, 0.24, 0.1, 1.2, x + (j - 1) * 0.42, top + 0.05, z);
    k.box(M.wood, 1.2, 0.09, 0.24, x, top + 0.14, z - 0.5);
  }
  const tarpGeo = new THREE.BoxGeometry(2.6, 1.2, 1.9);
  tarpGeo.rotateY(rng.range(-0.2, 0.2));
  tarpGeo.translate(half - 6.4, top + 0.6, -hz + 2.2);
  k.push(tarpGeo, toonMaterial(dim(PALETTE.tarpBlue, 0.6), { steps: 3 }), lodAt(cx, cz).tier !== 'far', false);
  // 油污与散落螺栓
  for (let i = 0; i < 4; i += 1) {
    const r = rng.range(1.4, 2.4);
    k.blob(oilMat, r, rng.range(-half + r, half - r), top + 0.03, rng.range(-hz + r * 0.6, hz - r * 0.6), 0, 0.7);
  }
  metalLitter(k, 0, -1, W * 0.8, L * 0.7, k.n(20));
}

/** 倒塌的门式吊车：立柱 + 轨道 + 歪在地上的主梁 + 吊钩（动效） */
function buildGantry(sink: Sink, rng: Rng, hookRef: { group: THREE.Group | null }): void {
  const zone = zoneRect('indSiding');
  const r = fitZone(rectOf(113.5, 128.2, 110.9, 115.6), zone, SIDING_MARGIN);
  guard(r, 'gantry');
  const cx = (r.x0 + r.x1) / 2;
  const cz = (r.z0 + r.z1) / 2;
  const k = new Kit(sink, rng, lodAt(cx, cz), frameOf(cx, cz));
  const half = (r.x1 - r.x0) / 2;
  const hz = (r.z1 - r.z0) / 2;
  const h = 7.4;
  const railX = half - 3.4;

  // 地面轨道（吊车行走梁）
  for (const s of [-1, 1] as const) {
    k.box(M.concreteDark, 0.5, 0.2, hz * 2, s * railX, 0.1, 0);
    k.bar(M.railSteel, 0.09, hz * 2, s * railX - 0.18, 0.24, 0, 'z', 6);
    k.bar(M.railSteel, 0.09, hz * 2, s * railX + 0.18, 0.24, 0, 'z', 6);
  }
  // 一根立柱还站着（含斜撑与平台），另一根已经折断
  for (const s of [-1, 1] as const) {
    const lx = s * railX;
    if (s < 0) {
      steelColumn(k, lx, -hz + 1.2, h, 0.4);
      steelColumn(k, lx, hz - 1.2, h, 0.4);
      k.beam(M.steel, 0.4, 0.4, hz * 2 - 2, lx, h, 0, 'z');
      k.box(M.metalDark, 1.6, 0.12, 2.2, lx, h + 0.14, 0);
      for (let i = 0; i < 6; i += 1) k.box(M.steel, 0.08, 1.0, 0.08, lx + rng.range(-0.6, 0.6), h + 0.7, rng.range(-1, 1));
      k.bar(M.rust, 0.04, 1.4, lx, h + 1.1, -1.0, 'x', 5);
      for (const t of [-1, 1] as const) {
        k.rod(M.steel, 0.07, new THREE.Vector3(lx, 1.4, -hz + 1.2 + (t > 0 ? 2 : 0)), new THREE.Vector3(lx, h - 0.6, t > 0 ? hz - 1.2 : -hz + 3.2), 6);
      }
      // 梯与平台栏杆
      const rungs: InstanceTransform[] = [];
      for (let y = 0.6; y < h; y += 0.44) rungs.push({ position: new THREE.Vector3(lx - 0.5, y, -hz + 1.2), rotation: new THREE.Euler(0, 0, Math.PI / 2), scale: _one.clone() });
      k.inst(G.rung(), M.rustDark, rungs);
    } else {
      // 折断的腿：只剩半截，歪着
      k.beam(M.rust, 0.4, 0.4, 3.2, lx, 1.6, hz - 2.6, 'y', { rz: 0.28, rx: -0.2 });
      k.box(M.concreteDark, 0.9, 0.24, 0.9, lx, 0.12, hz - 1.6);
      const geo = chippedSlab(1.8, 1.2, 0.16, rng, 0.3);
      geo.translate(lx + 0.6, 0.4, hz - 3.4);
      k.push(geo, M.rustWarm);
    }
  }
  // 主梁：整根倒扣在站台上，一头压在黄线破口上、一头斜插向货物线
  const beamLen = 11.5;
  k.beam(M.rust, 0.7, 0.6, beamLen, 1.2, 1.35, -0.6, 'x', { ry: 0.55, rz: 0.1 });
  k.beam(M.rustDark, 0.5, 0.45, beamLen * 0.62, 3.4, 0.5, 1.6, 'x', { ry: 0.52 });
  for (let i = 0; i < 7; i += 1) {
    const t = (i + 0.5) / 7;
    const x = 1.2 - beamLen / 2 + t * beamLen;
    k.box(M.metalDark, 0.16, 0.7, 0.5, x, 1.1, -0.6, { ry: 0.55 });
  }
  // 吊车小车（滑出轨道，卡在残梁上）
  k.box(M.metal, 1.8, 0.6, 2.2, -2.6, 1.0, 1.4, { ry: 0.6, outline: true });
  k.cyl(M.rustDark, 0.22, 0.22, 0.2, -2.6, 0.62, 1.4, 8, { rx: Math.PI / 2 });

  // 吊钩（动效：还挂在站立的腿顶，失去电力后缓慢摆动）
  const hook = new THREE.Group();
  hook.name = 'ind-gantry-hook';
  const hookMat = M.rust;
  const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 3.2, 5), hookMat);
  cable.position.set(0, -1.6, 0);
  cable.castShadow = false;
  hook.add(cable);
  const block = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.6, 0.3), M.metalDark);
  block.position.set(0, -3.4, 0);
  hook.add(block);
  const shank = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.5, 6), hookMat);
  shank.position.set(0, -3.9, 0);
  hook.add(shank);
  const eye = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.07, 5, 10, Math.PI * 1.4), hookMat);
  eye.position.set(0, -4.3, 0);
  eye.rotation.set(0, Math.PI / 2, 0.2);
  hook.add(eye);
  hook.position.set(cx - railX, h - 0.4, cz - 0.4);
  hookRef.group = hook;
}

/** 倾覆与叠放的集装箱（波纹壁 + 端框 + 门杆锁扣 + 锈色分层） */
const CW = 2.44;
const CH = 2.55;
const CL = 6.05;

function buildContainers(sink: Sink, rng: Rng): void {
  const zone = zoneRect('indSiding');
  // y 一律是**底面离地高度**；侧翻靠交换竖向/横向尺寸表达，不做 frame 翻滚
  const spots: Array<{ x: number; z: number; y: number; rotY: number; lying: boolean; mat: THREE.Material }> = [
    { x: 126.6, z: 119.9, y: 0, rotY: Math.PI / 2, lying: false, mat: M.container },
    { x: 126.6, z: 119.9, y: CH + 0.14, rotY: Math.PI / 2, lying: false, mat: M.containerAlt },
    { x: 121.2, z: 118.6, y: 0.06, rotY: 0.06, lying: true, mat: M.container },
  ];
  for (let i = 0; i < spots.length; i += 1) {
    const s = spots[i] as (typeof spots)[number];
    const hh = s.lying ? CW : CH;
    const ww = s.lying ? CH : CW;
    const c = Math.abs(Math.cos(s.rotY));
    const sn = Math.abs(Math.sin(s.rotY));
    const extX = Math.max(0.6, (c * CL + sn * ww) / 2);
    const extZ = Math.max(0.6, (sn * CL + c * ww) / 2);
    const r = fitZone(rectOf(s.x - extX - 0.4, s.x + extX + 0.4, s.z - extZ - 0.4, s.z + extZ + 0.4), zone, SIDING_MARGIN);
    guard(r, `container-${i}`);
    const k = new Kit(sink, rng, lodAt(s.x, s.z), frameOf(s.x, s.z, s.rotY, s.y));
    k.box(s.mat, CL, hh, ww, 0, hh / 2, 0, { outline: true });
    // 端框与四棱（比箱体暗一档，远看才读得出这是个箱子而不是色块）
    for (const e of [-1, 1] as const) k.box(M.metalDark, 0.18, hh * 1.01, ww * 1.01, e * (CL / 2), hh / 2, 0);
    for (const t of [-1, 1] as const) {
      for (const u of [-1, 1] as const) {
        k.box(M.metalDark, CL * 1.01, 0.15, 0.15, 0, t > 0 ? hh : 0, (u * ww) / 2);
        k.box(M.metalDark, 0.15, hh * 1.01, 0.15, (u * CL) / 2, hh / 2, (t * ww) / 2);
      }
    }
    // 波纹壁（instanced 窄条）
    const ribs: InstanceTransform[] = [];
    const ribCount = k.n(24);
    for (const t of [-1, 1] as const) {
      for (let j = 0; j < ribCount; j += 1) {
        ribs.push({
          position: new THREE.Vector3(-CL / 2 + 0.3 + (j * (CL - 0.6)) / ribCount, hh / 2, t * (ww / 2 + 0.03)),
          rotation: new THREE.Euler(0, 0, 0),
          scale: new THREE.Vector3(0.09, hh * 0.94, 0.06),
        });
      }
    }
    k.inst(UNIT_BOX, M.rustDark, ribs);
    // 门端：锁杆、铰链、把手、封志
    for (const sgn of [-1, 1] as const) {
      const px = sgn * CL * 0.18;
      for (let j = 0; j < 3; j += 1) k.box(M.rustDark, 0.12, 0.18, 0.12, px, (j + 0.5) * (hh / 3), ww / 2 + 0.07);
      k.bar(M.metal, 0.05, hh * 0.9, px, hh / 2, ww / 2 + 0.13, 'y', 6);
      if (k.fine) k.box(M.rust, 0.2, 0.16, 0.1, px, hh * 0.4, ww / 2 + 0.18);
    }
    k.box(M.paint, 1.2, 0.36, 0.05, -CL * 0.3, hh * 0.72, ww / 2 + 0.06);
    // 锈色分层
    for (let j = 0; j < k.n(8); j += 1) {
      const side = j % 2 === 0 ? 1 : -1;
      k.plate(rng.chance(0.5) ? M.rustDark : M.rustDeep, rng.range(0.5, 1.7), rng.range(0.4, 1.3), rng.range(-CL / 2, CL / 2), rng.range(0.3, hh - 0.3), side * (ww / 2 + 0.08));
    }
    if (s.lying) {
      // 侧翻的：底角压碎、门被撕开、四周散落碎料（世界坐标，不受箱体影响）
      const kw = new Kit(sink, rng, lodAt(s.x, s.z), IDENTITY);
      kw.box(M.burnt, 1.0, 0.3, ww * 0.9, s.x + CL / 2 - 0.5, s.y + 0.15, s.z);
      kw.box(M.rustWarm, 1.3, 0.12, 1.7, s.x - CL / 2 + 0.4, ww / 2 + 0.3, s.z + 0.4, { rx: 0.5 });
      rubblePile(kw, rng, s.x, s.z + ww / 2 + 1.5, 3.2, 0.8, M.rustDark, kw.n(16));
    }
  }
  // 集装箱旁散落的货物木箱
  const kc = new Kit(sink, rng, lodAt(122, 122.6), IDENTITY);
  const crates: InstanceTransform[] = [];
  for (let i = 0; i < 10; i += 1) {
    crates.push({
      position: new THREE.Vector3(rng.range(118.6, 125.6), 0.36 + (i % 3) * 0.1, rng.range(121.4, 123.1)),
      rotation: new THREE.Euler(rng.range(-0.3, 0.3), rng.range(0, 3), rng.range(-0.4, 0.4)),
      scale: new THREE.Vector3(rng.range(0.7, 1.1), rng.range(0.5, 0.95), rng.range(0.7, 1.1)),
    });
  }
  kc.inst(G.crate(), M.wood, crates);
}

/** 成排油桶（立着的一排 + 几只倒地和烧黑的） */
function buildDrums(sink: Sink, rng: Rng): void {
  const zone = zoneRect('indSiding');
  const r = fitZone(rectOf(111.2, 118.4, 116.0, 117.4), zone, SIDING_MARGIN);
  guard(r, 'drumRow');
  const k = new Kit(sink, rng, lodAt(115, 116.7), IDENTITY);
  const list: InstanceTransform[] = [];
  for (let i = 0; i < 6; i += 1) {
    list.push({
      position: new THREE.Vector3(111.8 + i * 1.04, 0.5, 116.7 + rng.gauss(0, 0.06)),
      rotation: new THREE.Euler(rng.gauss(0, 0.02), rng.range(0, 3), rng.gauss(0, 0.02)),
      scale: _one.clone(),
    });
  }
  k.inst(G.drum(), M.barrel, list);
  // 桶顶与桶底的压边环（一排 instanced 环）
  const rims: InstanceTransform[] = [];
  for (const t of list) {
    rims.push({ position: t.position.clone().setY(0.82), rotation: new THREE.Euler(Math.PI / 2, 0, 0), scale: _one.clone() });
    rims.push({ position: t.position.clone().setY(0.2), rotation: new THREE.Euler(Math.PI / 2, 0, 0), scale: _one.clone() });
  }
  const rimGeo = new THREE.TorusGeometry(0.3, 0.03, 4, 12);
  k.inst(rimGeo, M.rustDark, rims);
  // 倒地的桶（有的漏了油、有的烧黑）
  for (const [x, z, rz] of [[111.6, 122.8, 1.4], [124.6, 116.6, 1.55], [126.4, 123.0, 1.5]] as Array<[number, number, number]>) {
    const kk = new Kit(sink, rng, lodAt(x, z), IDENTITY);
    kk.cyl(rng.chance(0.4) ? M.burnt : M.barrel, 0.3, 0.3, 0.9, x, 0.3, z, 12, { rz });
    kk.ring(M.rustDark, 0.3, 0.03, x + 0.3, 0.3, z, 'x', 10);
    kk.blob(oilMat, rng.range(0.9, 1.8), x + 0.8, 0.05, z - 0.3, 0, 0.6);
  }
}

/** 煤堆 / 砂石堆：instanced 碎块 + 推土痕迹（扇形条纹） */
function buildPiles(sink: Sink, rng: Rng): void {
  const zone = zoneRect('indSiding');
  const piles = [
    { x: 115.2, z: 120.8, rx: 2.9, rz: 2.0, h: 2.5, mat: M.coal, count: 300 },
    { x: 122.8, z: 122.2, rx: 2.2, rz: 1.3, h: 1.7, mat: M.gravel, count: 220 },
  ];
  for (const p of piles) {
    const r = fitZone(rectOf(p.x - p.rx - 0.4, p.x + p.rx + 0.4, p.z - p.rz - 0.4, p.z + p.rz + 0.4), zone, SIDING_MARGIN);
    guard(r, p.mat === M.coal ? 'coalPile' : 'gravelPile');
    const k = new Kit(sink, rng, lodAt(p.x, p.z), IDENTITY);
    const list: InstanceTransform[] = [];
    for (let i = 0; i < p.count; i += 1) {
      const a = rng.range(0, TAU);
      const rad = Math.sqrt(rng.next());
      const px = p.x + Math.cos(a) * p.rx * rad;
      const pz = p.z + Math.sin(a) * p.rz * rad;
      // 锥面：越靠边越低
      const top = p.h * (1 - rad) * rng.range(0.7, 1.05);
      const s = rng.range(0.24, 0.62);
      list.push({
        position: new THREE.Vector3(px, 0.1 + top * rng.range(0.5, 1), pz),
        rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 6), rng.range(0, 3)),
        scale: new THREE.Vector3(s, s * rng.range(0.5, 0.9), s),
      });
    }
    for (let i = 0; i < list.length; i += 3) {
      k.inst(chunkAt(i), p.mat, [list[i] as InstanceTransform]);
    }
    // 堆底散开的碎料
    const spill: InstanceTransform[] = [];
    for (let i = 0; i < k.n(70); i += 1) {
      const a = rng.range(0, TAU);
      const rad = rng.range(1, 1.32);
      spill.push({
        position: new THREE.Vector3(p.x + Math.cos(a) * p.rx * rad, 0.08, p.z + Math.sin(a) * p.rz * rad),
        rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 6), rng.range(0, 3)),
        scale: new THREE.Vector3(rng.range(0.18, 0.4), rng.range(0.12, 0.3), rng.range(0.18, 0.4)),
      });
    }
    k.inst(chunkAt(1), p.mat, spill);
    // 推土痕迹：从堆边向外发散的扇形条痕（几何凸起）
    const dir = p.mat === M.coal ? -1 : 1;
    for (let i = 0; i < 7; i += 1) {
      const a = (i / 6 - 0.5) * 1.1 + (dir > 0 ? 0 : Math.PI);
      const len = rng.range(2.4, 4.4);
      const sx = p.x + Math.cos(a) * p.rx * 0.9;
      const sz = p.z + Math.sin(a) * p.rz * 0.9;
      k.box(p.mat === M.coal ? M.dirt : M.gravel, 0.34, 0.07, len, sx + Math.cos(a) * len * 0.45, 0.05, sz + Math.sin(a) * len * 0.45, { ry: -a + Math.PI / 2 });
    }
    // 履带印（两组重复的短横纹）
    for (const side of [-1, 1] as const) {
      for (let i = 0; i < 12; i += 1) {
        const t = i / 11;
        const bx = p.x + side * 1.1 + t * 2.9 * dir;
        k.box(M.mud, 0.16, 0.05, 0.5, bx, 0.05, p.z + side * 0.9 + rng.gauss(0, 0.1), { ry: 0 });
      }
    }
    k.blob(dustMat, p.rx * 1.5, p.x, 0.04, p.z, 0, 0.8, 0.35);
  }
}

/* ------------------------------------------------------------------ *
 * 18. 厂区围栏与路灯（含动画件）
 * ------------------------------------------------------------------ */

function buildFences(sink: Sink, rng: Rng): void {
  const runs: Array<[number, number, number, number]> = [
    [110.6, -88, 110.6, -33],
    [128.4, -88, 128.4, -22],
    [110.6, 17, 110.6, 88],
    [128.4, 17, 128.4, 88],
    [110.6, 110.0, 128.6, 110.0],
    [110.6, 110.0, 110.6, 123.2],
  ];
  for (let i = 0; i < runs.length; i += 1) {
    const [x0, z0, x1, z1] = runs[i] as [number, number, number, number];
    const r = rectOf(Math.min(x0, x1) - 0.3, Math.max(x0, x1) + 0.3, Math.min(z0, z1) - 0.3, Math.max(z0, z1) + 0.3);
    guard(r, `fence-${i}`, 0);
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const k = new Kit(sink, rng, lodAt(cx, cz), IDENTITY);
    wireFence(k, x0, z0, x1, z1, 2.2, {
      cut: i === 4 ? 113.6 : i === 0 ? -50 : undefined,
      gate: i === 4 ? [120.4, 124.4] : undefined,
    });
  }
  // 厂区大门（属于铁路/厂区的门柱）：两根砖柱 + 铁门扇 + 门楣牌
  const gx = 122.4;
  const gz = 110.0;
  const k = new Kit(sink, rng, lodAt(gx, gz), IDENTITY);
  for (const s of [-1, 1] as const) {
    k.box(M.brickDark, 1.0, 3.4, 1.0, gx + s * 2.1, 1.7, gz, { outline: true });
    k.box(M.concrete, 1.2, 0.16, 1.2, gx + s * 2.1, 3.48, gz);
  }
  k.beam(M.rustDark, 0.3, 0.4, 5.0, gx, 3.7, gz, 'x');
  for (const s of [-1, 1] as const) {
    for (let i = 0; i < 6; i += 1) k.box(M.metalDark, 0.07, 2.9, 0.07, gx + s * (0.3 + i * 0.32), 1.5, gz - 0.1);
    for (let i = 0; i < 3; i += 1) k.bar(M.rust, 0.04, 1.9, gx + s * 1.0, 0.5 + i * 1.1, gz - 0.1, 'x', 4);
    k.ring(M.rust, 0.12, 0.04, gx + s * 1.7, 1.4, gz - 0.2, 'z', 8);
  }
  const gateSign = new THREE.PlaneGeometry(3.2, 0.9);
  gateSign.translate(gx, 4.3, gz - 0.24);
  k.push(
    gateSign,
    new THREE.MeshBasicMaterial({ map: plateTexture('СКЛАД №2', '库 区 二 号', '#1f2620', '#c6bda1', true), fog: true, color: 0xb8bdb9 }),
    false,
    false,
  );
}

/** 厂区路灯（故障闪烁的动画件）：柱 + 臂 + 灯罩 + 发光面 */
function buildLampPost(
  sink: Sink,
  rng: Rng,
  x: number,
  z: number,
  animated: boolean,
  parts: { head?: THREE.Mesh; halo?: THREE.Mesh },
  zoneId: string,
): void {
  const r = fitZone(rectOf(x - 0.9, x + 0.9, z - 0.9, z + 0.9), zoneRect(zoneId), 1.2);
  guard(r, 'lampPost');
  const k = new Kit(sink, rng, lodAt(x, z), IDENTITY);
  k.cyl(M.concreteDark, 0.3, 0.36, 0.4, x, 0.2, z, 10);
  k.cyl(M.metalDark, 0.14, 0.18, 6.4, x, 3.4, z, 10, { outline: true });
  k.cyl(M.metalDark, 0.1, 0.12, 0.36, x, 6.7, z, 8);
  // 灯臂（弯曲：两段杆 + 斜撑）
  k.bar(M.metal, 0.07, 1.5, x + 0.75, 6.55, z, 'x', 6);
  k.rod(M.metal, 0.06, new THREE.Vector3(x, 6.4, z), new THREE.Vector3(x + 1.45, 6.2, z), 6);
  k.rod(M.metal, 0.03, new THREE.Vector3(x + 0.2, 6.5, z), new THREE.Vector3(x + 1.4, 6.15, z), 5);
  if (animated) {
    // 灯罩与发光面（单独网格，动画只改材质 opacity / 灯的 intensity）
    const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.5, 0.34, 10), M.metalDark);
    hood.position.set(x + 1.5, 6.05, z);
    hood.castShadow = false;
    parts.head = hood;
    const haloMat = new THREE.MeshBasicMaterial({ color: PALETTE.warmLight, transparent: true, opacity: 0.75, depthWrite: false, fog: true });
    const halo = new THREE.Mesh(new THREE.CircleGeometry(0.3, 10), haloMat);
    halo.rotation.x = Math.PI / 2;
    halo.position.set(x + 1.5, 5.88, z);
    halo.castShadow = false;
    parts.halo = halo;
  } else {
    k.cyl(M.metalDark, 0.34, 0.5, 0.34, x + 1.5, 6.05, z, 10);
    k.box(M.glass, 0.5, 0.06, 0.5, x + 1.5, 5.88, z, { shadow: false });
  }
  // 基座旁的碎砖
  rubblePile(k, rng, x - 0.9, z + 0.7, 1.4, 0.3, M.concreteDark, k.n(6));
}

/** 松脱的波纹铁皮（动画件：风来才颤） */
function buildLooseSheet(rng: Rng): THREE.Group {
  const x = 127.4;
  const z = -38.2;
  const g = new THREE.Group();
  g.name = 'ind-loose-sheet';
  const sheetMat = toonMaterial(dim(0x8f969c, 0.55), { steps: 3 });
  const sheet = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.9, 1.1), sheetMat);
  sheet.position.set(0, -0.95, 0);
  sheet.castShadow = false;
  g.add(sheet);
  const rust = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.28, 1.06), M.rustDark);
  rust.position.set(0, -1.75, 0);
  g.add(rust);
  for (const dz of [-0.4, 0.4]) {
    const nail = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.08, 5), M.metalDark);
    nail.rotation.z = Math.PI / 2;
    nail.position.set(0, 0.02, dz);
    g.add(nail);
  }
  g.position.set(x, 4.6 + rng.range(0, 0.3), z);
  g.rotation.y = Math.PI / 2;
  return g;
}

/* ------------------------------------------------------------------ *
 * 19. 入口
 * ------------------------------------------------------------------ */

/** 停放的车辆与脱轨车（正线 / 装卸线 / derailed 点位） */
function buildRollingStock(sink: Sink, rng: Rng, fx: Fx): void {
  // 棚车：正线上（北端、道口以北），车身顺线路（沿 z）
  const boxLen = 12.2;
  const bz = 40;
  railGuard(rectOf(RAIL.at - 1.8, RAIL.at + 1.8, bz - boxLen / 2 - 0.5, bz + boxLen / 2 + 0.5), 'boxcar-main');
  buildBoxcar(new Kit(sink, rng.fork(71), lodAt(RAIL.at, bz), frameOf(RAIL.at, bz, Math.PI / 2, RAIL_Y)), boxLen, { battered: true, doorOpen: 1.5 });

  // 罐车：正线上（更北），已放空、顶部检修口敞开
  const tankLen = 11.4;
  const tz = 66;
  railGuard(rectOf(RAIL.at - 1.8, RAIL.at + 1.8, tz - tankLen / 2 - 0.5, tz + tankLen / 2 + 0.5), 'tankcar-main');
  buildTankCar(new Kit(sink, rng.fork(72), lodAt(RAIL.at, tz), frameOf(RAIL.at, tz, Math.PI / 2, RAIL_Y)), tankLen);

  // 平车：装卸线上（靠站台一侧），装着原木与散枕木
  const flatLen = 10.8;
  const flatX = HOTSPOTS.loadingRamp.x + 4.0;
  railGuard(rectOf(flatX - flatLen / 2 - 0.5, flatX + flatLen / 2 + 0.5, RAIL.spur.at - 1.8, RAIL.spur.at + 1.8), 'flatcar-spur');
  buildFlatcar(new Kit(sink, rng.fork(73), lodAt(flatX, RAIL.spur.at), frameOf(flatX, RAIL.spur.at, 0, RAIL_Y)), flatLen);

  // 脱轨的漏斗车：车体在道砟带上、出轨的一端朝 derailed 锚点
  const goLen = 10.2;
  const gx = 130.0;
  const gz = 85.0;
  const halfX = (goLen / 2) * Math.cos(RAIL.derail.rotY) + 1.5 * Math.sin(Math.abs(RAIL.derail.rotY));
  const halfZ = (goLen / 2) * Math.sin(Math.abs(RAIL.derail.rotY)) + 1.5 * Math.cos(RAIL.derail.rotY);
  railGuard(rectOf(gx - halfX, gx + halfX, gz - halfZ, gz + halfZ), 'derailed-gondola', { spill: true });
  buildDerailedGondola(
    new Kit(sink, rng.fork(74), lodAt(gx, gz), frameOf(gx, gz, RAIL.derail.rotY, 0.14, new THREE.Euler(-0.26, 0, 0.12))),
    goLen,
  );
  fx.glow.push({ x: gx, y: 0.6, z: gz, r: 0.5, color: EMBER_COLOR.clone() });
}

export function buildIndustrial(ctx: BuildContext): THREE.Group {
  const root = new THREE.Group();
  root.name = 'industrial';
  // 本模块负责的分区（indN / indS / indSiding）；锚点见 HOTSPOTS：
  // factoryMain(119,-50) waterTank(119,52) chimney(124,-18) loadingRamp(121,116)
  // derailed(RAIL.derail) levelCrossings(RAIL.crossings) silo(119,-124，wasteNE)
  root.userData['zones'] = IND_ZONES.map((z) => z.id);
  root.userData['hotspots'] = ['factoryMain', 'waterTank', 'chimney', 'loadingRamp', 'derailed', 'levelCrossings', 'silo'];
  const rng = ctx.rng.fork(0x1d3a77);
  const sink = new Sink();
  const fx: Fx = { smoke: [], glow: [], sparks: [] };

  // —— indN：主厂房、烟囱束、锅炉间、厂部、木棚 ——
  const fire = buildFactory(sink, rng.fork(1001), fx);
  buildChimney(sink, rng.fork(1002), fx);
  buildBoilerShop(sink, rng.fork(1003), fx);
  buildAdmin(sink, rng.fork(1004));
  buildTimberYard(sink, rng.fork(1005));

  // —— indS：储水罐、管线、拱顶仓库、修理车间 ——
  buildWaterTank(sink, rng.fork(1006), fx);
  buildTankPipeline(sink, rng.fork(1007));
  buildWarehouse(sink, rng.fork(1008), fx);
  buildRepairShop(sink, rng.fork(1009), fx);

  // —— 东北角锚点：坍了半边的谷物筒仓 ——
  buildSilo(sink, rng.fork(1010), fx);

  // —— 铁路：车辆、脱轨拖痕、道口与转辙器 ——
  buildRollingStock(sink, rng.fork(1011), fx);
  buildDerailTrail(sink, rng.fork(1012), fx);
  buildRailFurniture(sink, rng.fork(1013));

  // —— indSiding：站台、吊车、集装箱、油桶、煤堆 ——
  buildLoadingPlatform(sink, rng.fork(1014));
  const hookRef: { group: THREE.Group | null } = { group: null };
  buildGantry(sink, rng.fork(1015), hookRef);
  buildContainers(sink, rng.fork(1016));
  buildDrums(sink, rng.fork(1017));
  buildPiles(sink, rng.fork(1018));

  // —— 厂区围栏与路灯 ——
  buildFences(sink, rng.fork(1019));
  const lampParts: { head?: THREE.Mesh; halo?: THREE.Mesh } = {};
  buildLampPost(sink, rng.fork(1020), 111.9, 17.4, true, lampParts, 'indS');

  sink.flush(root);

  // —— 动画件（不属于静态合批，各自单独成网格）——
  const sheet = buildLooseSheet(rng.fork(1021));
  root.add(sheet);
  if (hookRef.group) root.add(hookRef.group);
  if (lampParts.head) root.add(lampParts.head);
  if (lampParts.halo) root.add(lampParts.halo);

  // —— FX：黑烟、余烬、火星、火舌 ——
  const quality = clamp(ctx.quality, 0.5, 1);
  const map = puffTexture(0x5d1a77 ^ 0x9e3779b1);
  const fxGroup = new THREE.Group();
  fxGroup.name = 'industrial-fx';
  fxGroup.add(smokeField(fx.smoke, Math.round(14 * quality), map, 'ind-smoke'));
  fxGroup.add(glowField(fx.glow, 'ind-glow'));
  fxGroup.add(flameField(fire, 1.15, 'ind-fire'));
  if (quality > 0.6) {
    // 火星：厂房火堆给多一些，脱轨车的余烬只留一缕
    fx.sparks.forEach((s, i) => {
      fxGroup.add(sparkField(s, i === 0 ? 26 : 14, `ind-sparks-${i}`));
    });
  }
  ctx.addFx(fxGroup);

  // —— 真实点光：只申请 2 盏（厂房余烬火 + 故障路灯）——
  const fireLight = new THREE.PointLight(PALETTE.fire, 8, 15, 2);
  fireLight.position.set(fire.x, fire.y + 0.9, fire.z);
  ctx.addLight(fireLight);
  const lampLight = new THREE.PointLight(PALETTE.warmLight, 5.5, 18, 2);
  lampLight.position.set(111.9 + 1.5, 5.8, 17.4);
  ctx.addLight(lampLight);

  // —— 动效（≥3 组，循环内不 new 对象）——
  const fireSeed = rng.range(0, TAU);
  const lampSeed = rng.range(0, TAU);
  const sheetPhase = rng.range(0, TAU);
  const hookPhase = rng.range(0, TAU);
  const haloMat = lampParts.halo ? (lampParts.halo.material as THREE.MeshBasicMaterial) : null;
  ctx.ticker.add((t) => {
    // 1. FX 面片：只推时间
    for (let i = 0; i < fxGroup.children.length; i += 1) {
      const child = fxGroup.children[i] as THREE.Mesh;
      const fn = child.userData['tick'] as TickFn | undefined;
      if (fn) fn(t);
    }
    // 2. 余烬火苗：忽明忽暗（多频率叠加 + 偶发爆发）
    const breathe = 0.55 + 0.28 * Math.sin(t * 0.83 + fireSeed) + 0.17 * Math.sin(t * 2.11 + fireSeed * 1.7);
    const flare = Math.pow(Math.max(0, Math.sin(t * 0.37 + fireSeed)), 12);
    fireLight.intensity = 5.2 + Math.max(0.1, breathe) * 6 + flare * 9;
    fireLight.position.y = fire.y + 0.9 + Math.sin(t * 3.3 + fireSeed) * 0.07;
    // 3. 故障路灯：接触不良，通断与连闪
    const dropout = Math.sin(t * 0.63 + lampSeed) > 0.55;
    let level: number;
    if (dropout) {
      const noise = Math.sin(t * 15.3 + lampSeed) * Math.sin(t * 4.71 + lampSeed * 2.2);
      level = noise > 0.12 ? 0.26 : 0.94;
    } else {
      level = 0.92 + 0.08 * Math.sin(t * 23.7 + lampSeed);
    }
    lampLight.intensity = 5.6 * level;
    if (haloMat) haloMat.opacity = 0.2 + 0.62 * level;
    // 4. 松脱的波纹铁皮：平时轻颤，阵风掀起
    const gust = Math.max(0, Math.sin(t * 0.29 + sheetPhase) * Math.sin(t * 0.17 + 1.1) - 0.32);
    sheet.rotation.z = 0.04 + gust * 0.3 + Math.sin(t * 2.7 + sheetPhase) * 0.006 + Math.sin(t * 5.9) * 0.002;
    // 5. 吊车吊钩：失去电力后仍在缓慢摆
    const hook = hookRef.group;
    if (hook) {
      hook.rotation.x = Math.sin(t * 0.42 + hookPhase) * 0.055 + Math.sin(t * 1.13) * 0.014;
      hook.rotation.z = Math.cos(t * 0.37 + hookPhase) * 0.045;
    }
  });

  return root;
}
