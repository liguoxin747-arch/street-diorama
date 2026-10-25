import * as THREE from 'three';
import { PALETTE } from '../core/palette';
import { canvasTexture, glowMaterial, toonMaterial, withOutline } from '../core/materials';
import { createRng, type Rng } from '../core/rng';
import type { BuildContext } from '../core/context';
import type { InstanceTransform } from '../core/geo';
import { jitter } from '../core/geo';
import { ALLEYS, TOWN_PLOTS, type Plot } from './layout';
import {
  acUnitGeometry,
  brickGeometry,
  chippedSlab,
  debrisRing,
  downpipeGeometry,
  gutterGeometry,
  tileGeometry,
  windowFrameGeometry,
} from '../core/detail';

/**
 * 周边小镇街区：把 TOWN_PLOTS 的 29 个地块逐块填满。
 *
 * 做法要点：
 * - 每栋建筑先在"立面局部坐标"里搭建：+Z 一律朝向街道（外），-Z 朝屋内，原点在临街立面中点。
 *   搭完后整体乘一个旋转 + 平移矩阵，落到世界坐标。
 * - 立面走**真正的墙体开洞**：`Facade` 描述一堵带洞口的墙，墙体按洞口切成体块，
 *   洞口里塞进内退窗框 + 洞口侧壁 + 外挑窗台 + 窗楣，所以窗是有进深的，不是贴片。
 * - 所有零件按材质合并成极少数网格；碎件（砖、瓦、崩裂碎屑）走 instanced。
 * - 描边只加在建筑体块那一批上。
 * - 随机数从 ctx.rng.fork(seed) 派生，保证每次运行完全一致。
 */

// ─────────────────────────── 材质 ───────────────────────────

/** 把色板颜色在**线性空间**里压暗，做出雨夜里被雨水和烟熏旧的墙面 */
function dim(hex: number, k: number): number {
  const c = new THREE.Color(hex);
  c.multiplyScalar(k);
  return c.getHex();
}

/** 内构样板楼的 plot 序号：这些楼不封玻璃面片，形成真实洞口，室内才看得见 */
const OPEN_WINDOW_PLOTS = new Set([0, 7, 8, 12]);

const M = {
  plaster: toonMaterial(dim(PALETTE.plaster, 0.6), { steps: 3 }),
  plasterPeel: toonMaterial(dim(PALETTE.plasterPeel, 0.62), { steps: 3 }),
  plasterCold: toonMaterial(dim(PALETTE.plasterCold, 0.62), { steps: 3 }),
  plasterWarm: toonMaterial(dim(PALETTE.plasterWarm, 0.7), { steps: 3 }),
  brick: toonMaterial(dim(PALETTE.brick, 0.64), { steps: 3 }),
  brickDark: toonMaterial(dim(PALETTE.brickDark, 0.7), { steps: 3 }),
  concrete: toonMaterial(dim(PALETTE.concrete, 0.6), { steps: 3 }),
  concreteDark: toonMaterial(dim(PALETTE.concreteDark, 0.66), { steps: 3 }),
  /** 窗套、线脚、檐口那一圈浅色抹灰 */
  trim: toonMaterial(dim(0xc3c1b3, 0.5), { steps: 3 }),
  trimDark: toonMaterial(dim(0x8b8a80, 0.56), { steps: 3 }),
  roof: toonMaterial(dim(PALETTE.roof, 0.62), { steps: 3 }),
  roofRust: toonMaterial(dim(PALETTE.roofRust, 0.64), { steps: 3 }),
  roofDark: toonMaterial(dim(0x4b4e55, 0.68), { steps: 3 }),
  wood: toonMaterial(dim(PALETTE.woodOld, 0.74), { steps: 3 }),
  woodDark: toonMaterial(dim(PALETTE.woodDark, 0.78), { steps: 3 }),
  metal: toonMaterial(dim(PALETTE.metalDoor, 0.72), { steps: 3 }),
  metalDark: toonMaterial(dim(0x4d565f, 0.78), { steps: 3 }),
  /** 逃生梯专用金属：冷调偏亮，与砖墙明确区分开，路灯下会反光 */
  escapeMetal: toonMaterial(dim(0x6a7681, 0.66), { steps: 3 }),
  /** 逃生梯的暗件（边梁、斜撑、栏杆） */
  escapeDark: toonMaterial(dim(0x424b54, 0.72), { steps: 3 }),
  /** 逃生梯的锈迹 */
  escapeRust: toonMaterial(dim(0x7a4a2e, 0.78), { steps: 3 }),
  rust: toonMaterial(dim(PALETTE.rust, 0.75), { steps: 3 }),
  rustDark: toonMaterial(dim(PALETTE.rustDark, 0.78), { steps: 3 }),
  /** 门窗洞里的黑 */
  dark: toonMaterial(0x16181a, { steps: 2 }),
  steelFrame: toonMaterial(dim(0x6f7a83, 0.72), { steps: 3 }),
  barrel: toonMaterial(dim(PALETTE.barrelRust, 0.72), { steps: 3 }),
  tire: toonMaterial(PALETTE.tire, { steps: 2 }),
  glass: toonMaterial(PALETTE.glassDark, { steps: 2 }),
  glassBroken: toonMaterial(dim(PALETTE.glassBroken, 0.8), { steps: 2 }),
  soot: toonMaterial(PALETTE.soot, { steps: 2 }),
  burnt: toonMaterial(PALETTE.burnt, { steps: 2 }),
  board: toonMaterial(dim(0x9d8e73, 0.7), { steps: 2 }),
  soil: toonMaterial(dim(PALETTE.mud, 0.8), { steps: 3 }),
  crop: toonMaterial(dim(0x5c6b48, 0.8), { steps: 3 }),
  cloth: toonMaterial(dim(PALETTE.paper, 0.72), { steps: 3 }),
  tarp: toonMaterial(dim(PALETTE.tarp, 0.8), { steps: 3 }),
  tarpBlue: toonMaterial(dim(PALETTE.tarpBlue, 0.8), { steps: 3 }),
  fabric: toonMaterial(dim(PALETTE.fabricRed, 0.8), { steps: 3 }),
  dirt: toonMaterial(dim(PALETTE.dirt, 0.85), { steps: 2 }),
  /** 洞口内壁 / 破口断面：整栋楼里最暗的一层 */
  reveal: toonMaterial(dim(0x23262a, 0.95), { steps: 2 }),
  /** 亮灯窗内的家具剪影 */
  furniture: toonMaterial(0x15171a, { steps: 2 }),
  /** 立体剥落墙皮（破片本身，带厚度） */
  chipPeel: toonMaterial(dim(PALETTE.plasterPeel, 0.5), { steps: 3 }),
  chipCold: toonMaterial(dim(PALETTE.plasterCold, 0.5), { steps: 3 }),
  /** 剥落区下方外露的砖芯 */
  brickCore: toonMaterial(dim(PALETTE.brick, 0.52), { steps: 3 }),
  brickCoreDark: toonMaterial(dim(PALETTE.brickDark, 0.58), { steps: 3 }),
  /** 屋瓦（比屋面亮一档，瓦垄与搭接才看得出来） */
  tile: toonMaterial(dim(PALETTE.roof, 0.82), { steps: 3 }),
  tileRust: toonMaterial(dim(PALETTE.roofRust, 0.84), { steps: 3 }),
  tileDark: toonMaterial(dim(0x4b4e55, 0.86), { steps: 3 }),
  /** 残破玻璃碴 */
  shard: toonMaterial(dim(PALETTE.glassBroken, 0.66), { steps: 2 }),
};

const WALLS: THREE.Material[] = [
  M.plaster,
  M.plasterPeel,
  M.plasterCold,
  M.plasterWarm,
  M.plaster,
  M.brick,
  M.plasterCold,
  M.brickDark,
];

const LIT_WARM = glowMaterial(PALETTE.warmLight);
const LIT_COLD = glowMaterial(PALETTE.coldLamp, 0.85);
const LIT_EMERG = glowMaterial(PALETTE.emergencyRed, 0.9);
/** 橱窗透出的暖光（比窗光暗一档，免得像灯箱） */
const LIT_SHOP = glowMaterial(dim(PALETTE.warmLight, 0.5));

const clamp = THREE.MathUtils.clamp;

// ─────────────────────────── 局部坐标系 ───────────────────────────

interface Frame {
  /** 临街立面中点的世界坐标（地面 y=0） */
  origin: THREE.Vector3;
  /** 局部 +Z（朝街外）指向世界方向的旋转角 */
  rotY: number;
}

function frameFor(plot: Plot): Frame {
  const cx = (plot.x0 + plot.x1) / 2;
  const cz = (plot.z0 + plot.z1) / 2;
  const back = 0.45; // 立面从地块边界内退一点，留伸缩缝
  switch (plot.facing) {
    case 'posZ':
      return { origin: new THREE.Vector3(cx, 0, plot.z1 - back), rotY: 0 };
    case 'negZ':
      return { origin: new THREE.Vector3(cx, 0, plot.z0 + back), rotY: Math.PI };
    case 'posX':
      return { origin: new THREE.Vector3(plot.x1 - back, 0, cz), rotY: Math.PI / 2 };
    default:
      return { origin: new THREE.Vector3(plot.x0 + back, 0, cz), rotY: -Math.PI / 2 };
  }
}

/** 沿立面方向的宽度 w、进深 d（都扣掉伸缩缝） */
function extents(plot: Plot): { w: number; d: number } {
  const alongX = plot.facing === 'posZ' || plot.facing === 'negZ';
  const spanU = alongX ? plot.x1 - plot.x0 : plot.z1 - plot.z0;
  const spanV = alongX ? plot.z1 - plot.z0 : plot.x1 - plot.x0;
  return { w: Math.max(3.4, spanU - 0.7), d: Math.max(3.4, spanV - 0.85) };
}

// ─────────────────────────── 零件收集 ───────────────────────────

interface Part {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
  outline: boolean;
}

interface Bucket {
  mat: THREE.Material;
  outline: boolean;
  geos: THREE.BufferGeometry[];
}

/** instanced 批次：碎砖、崩裂碎屑、屋瓦共用同一份几何体 */
interface InstItem {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
  m: THREE.Matrix4;
}

interface RubbleItem {
  pos: THREE.Vector3;
  rot: THREE.Euler;
  scale: number;
  mat: THREE.Material;
}

interface SignItem {
  tex: THREE.Texture;
  w: number;
  h: number;
  pos: THREE.Vector3;
  rotY: number;
  tilt: number;
}

interface LightItem {
  pos: THREE.Vector3;
  color: number;
  intensity: number;
  distance: number;
}

/** 细节档位：近景全做，中景做结构 + 弹孔，远景只做附件 */
type Tier = 'near' | 'mid' | 'far';

/** 一栋建筑的临时零件桶：全部在局部坐标里生成，最后统一变换 + 按材质合并 */
class Kit {
  readonly parts: Part[] = [];
  readonly inst: InstItem[] = [];
  detail = 1;
  tier: Tier = 'near';
  /** 本栋建筑（含紧贴的小件）的世界包围盒，仅用于调试/验收 */
  readonly bounds = new THREE.Box3();
  /** 需要独立动画的半损卷帘门：不进合批，由 buildTown 挂到外层并登记 tick */
  shutters: Array<{ plot: number; mat: THREE.Material; w: number; x: number; slats: number[]; bent: number }> = [];
  /** 本 Kit 对应的地块序号（卷帘门要能反查回它所属楼的 frame） */
  plotIndex = 0;

  constructor(
    readonly rng: Rng,
    readonly frame: Frame,
    readonly rubble: RubbleItem[],
    readonly signs: SignItem[],
    readonly lights: LightItem[],
  ) {}

  push(geo: THREE.BufferGeometry, mat: THREE.Material, outline = false): void {
    this.parts.push({ geo, mat, outline });
  }

  /** 立方体（可选绕 Y 旋转） */
  box(mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, ry = 0, outline = false): void {
    const g = new THREE.BoxGeometry(w, h, d);
    if (ry !== 0) g.rotateY(ry);
    g.translate(x, y, z);
    this.push(g, mat, outline);
  }

  /** 可绕三轴小角度倾斜的盒体：坍塌阳台、破损雨棚、翘起的石板 */
  tilt(
    mat: THREE.Material,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    rx: number,
    rz: number,
    outline = false,
  ): void {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rx !== 0) g.rotateX(rx);
    if (rz !== 0) g.rotateZ(rz);
    g.translate(x, y, z);
    this.push(g, mat, outline);
  }

  /** 竖直面片，默认朝局部 +Z（街面） */
  quad(mat: THREE.Material, w: number, h: number, x: number, y: number, z: number, ry = 0): void {
    const g = new THREE.PlaneGeometry(w, h);
    if (ry !== 0) g.rotateY(ry);
    g.translate(x, y, z);
    this.push(g, mat);
  }

  /**
   * 墙面污渍 / 剥落墙皮 / 烟熏。
   * 必须用**共面**的不规则多边形，不能用 jitter 乱推一整个平面——
   * 那样顶点被推出墙面、法线乱掉，远看会变成一块浮在墙上的实体贴板。
   */
  patch(mat: THREE.Material, w: number, h: number, x: number, y: number, z: number, rough = 0.06, ry = 0): void {
    const r = clamp(rough * 3.2, 0.14, 0.5);
    const n = 7;
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i < n; i += 1) {
      const a = (i / n) * Math.PI * 2;
      pts.push(
        new THREE.Vector2(
          Math.cos(a) * (w / 2) * this.rng.range(1 - r, 1),
          Math.sin(a) * (h / 2) * this.rng.range(1 - r, 1),
        ),
      );
    }
    const g = new THREE.ShapeGeometry(new THREE.Shape(pts), 1);
    if (ry !== 0) g.rotateY(ry);
    g.translate(x, y, z);
    this.push(g, mat);
  }

  /** 圆形小面片：弹孔、圆形窗 */
  hole(mat: THREE.Material, r: number, x: number, y: number, z: number, ry = 0): void {
    const g = new THREE.CircleGeometry(r, 6);
    if (ry !== 0) g.rotateY(ry);
    g.translate(x, y, z);
    this.push(g, mat);
  }

  /** 山墙屋顶（三棱柱，屋脊平行立面） */
  gable(mat: THREE.Material, w: number, rise: number, d: number, x: number, y: number, z: number): void {
    const shape = new THREE.Shape();
    shape.moveTo(-d / 2, 0);
    shape.lineTo(d / 2, 0);
    shape.lineTo(0, rise);
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false, steps: 1, curveSegments: 1 });
    g.rotateY(Math.PI / 2);
    g.translate(x - w / 2, y, z);
    this.push(g, mat, true);
  }

  /** 立管：雨落管、天线杆、栏杆 */
  pipe(mat: THREE.Material, r: number, h: number, x: number, y: number, z: number, seg = 6): void {
    const g = new THREE.CylinderGeometry(r, r, h, seg, 1, true);
    g.translate(x, y, z);
    this.push(g, mat);
  }

  /** 横躺 / 竖直的杆件：晾衣绳横杆、木料、露出的钢筋 */
  rod(mat: THREE.Material, r: number, len: number, x: number, y: number, z: number, along: 'x' | 'y' | 'z' = 'x', seg = 6): void {
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1, true);
    if (along === 'x') g.rotateZ(Math.PI / 2);
    else if (along === 'z') g.rotateX(Math.PI / 2);
    g.translate(x, y, z);
    this.push(g, mat);
  }

  world(lx: number, ly: number, lz: number): THREE.Vector3 {
    const c = Math.cos(this.frame.rotY);
    const s = Math.sin(this.frame.rotY);
    return new THREE.Vector3(
      this.frame.origin.x + lx * c + lz * s,
      ly,
      this.frame.origin.z - lx * s + lz * c,
    );
  }

  /** 墙根碎砖（世界坐标里实例化，统一一个 draw call） */
  rubbleAt(lx: number, ly: number, lz: number, size: number, mat: THREE.Material): void {
    const p = this.world(lx, ly, lz);
    for (const a of ALLEYS) {
      if (p.x > a.x0 - 0.4 && p.x < a.x1 + 0.4 && p.z > a.z0 - 0.4 && p.z < a.z1 + 0.4) return;
    }
    this.rubble.push({
      pos: p,
      rot: new THREE.Euler(this.rng.range(0, 3), this.rng.range(0, 6), this.rng.range(0, 3)),
      scale: size,
      mat,
    });
  }

  /** 招牌 / 门牌：平面单独成 mesh（贴图不能合并） */
  sign(tex: THREE.Texture, w: number, h: number, lx: number, ly: number, lz: number, ry = 0, tilt = 0): void {
    this.signs.push({ tex, w, h, pos: this.world(lx, ly, lz), rotY: this.frame.rotY + ry, tilt });
  }

  /** instanced 批次：局部坐标的变换 */
  instance(geo: THREE.BufferGeometry, mat: THREE.Material, transforms: InstanceTransform[]): void {
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    for (const t of transforms) {
      e.copy(t.rotation ?? new THREE.Euler());
      q.setFromEuler(e);
      s.copy(t.scale ?? new THREE.Vector3(1, 1, 1));
      const m = new THREE.Matrix4().compose(t.position, q, s);
      this.inst.push({ geo, mat, m });
    }
  }

  /** 把局部零件变换到世界并按材质归桶 */
  flush(buckets: Map<string, Bucket>, frameMatrix: THREE.Matrix4): void {
    for (const part of this.parts) {
      part.geo.applyMatrix4(frameMatrix);
      part.geo.computeBoundingBox();
      const bb = part.geo.boundingBox;
      if (bb) this.bounds.union(bb);
      const key = `${part.mat.uuid}|${part.outline ? 1 : 0}`;
      let b = buckets.get(key);
      if (!b) {
        b = { mat: part.mat, outline: part.outline, geos: [] };
        buckets.set(key, b);
      }
      b.geos.push(part.geo);
    }
    this.parts.length = 0;
    for (const it of this.inst) it.m.premultiply(frameMatrix);
  }
}

/** 按材质合并：统一转非索引，只保留 position/normal/uv */
function mergeBucket(b: Bucket, name: string): THREE.Mesh | null {
  let total = 0;
  const list: THREE.BufferGeometry[] = [];
  for (const g of b.geos) {
    if (g.index) {
      const ng = g.toNonIndexed();
      g.dispose();
      list.push(ng);
    } else {
      list.push(g);
    }
  }
  for (const g of list) total += g.getAttribute('position')?.count ?? 0;
  if (total === 0) return null;

  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let o3 = 0;
  let o2 = 0;
  for (const g of list) {
    const p = g.getAttribute('position');
    if (!p) continue;
    const n = g.getAttribute('normal');
    const t = g.getAttribute('uv');
    for (let i = 0; i < p.count; i += 1) {
      position[o3] = p.getX(i);
      position[o3 + 1] = p.getY(i);
      position[o3 + 2] = p.getZ(i);
      if (n) {
        normal[o3] = n.getX(i);
        normal[o3 + 1] = n.getY(i);
        normal[o3 + 2] = n.getZ(i);
      }
      if (t) {
        uv[o2] = t.getX(i);
        uv[o2 + 1] = t.getY(i);
      }
      o3 += 3;
      o2 += 2;
    }
    g.dispose();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, b.mat);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ─────────────────────────── 立面系统（带真开洞的墙） ───────────────────────────

/** 一个洞口：u 沿墙横向中心，v 竖向中心，w/h 洞口尺寸 */
interface Opening {
  u: number;
  v: number;
  w: number;
  h: number;
  /** 洞口类型 */
  kind: 'window' | 'door' | 'shop';
  /** 窗内是否有暖光 */
  lit?: boolean;
  /** 是否封木板 */
  boarded?: boolean;
  /** 是否破玻璃 */
  broken?: boolean;
  /** 冷色应急灯 */
  cold?: boolean;
  /** 红色应急灯 */
  emerg?: boolean;
}

/**
 * 一堵立面墙。
 *  - a：外法线方位角（0=朝局部 +Z，π/2=朝局部 +X，π=朝局部 -Z，-π/2=朝局部 -X）
 *  - (cx,cz)：墙面外表面中心在地面的局部坐标
 *  - w：沿墙宽度，t：墙厚（向内），y0/y1：墙的上下边界
 */
interface Facade {
  mat: THREE.Material;
  cx: number;
  cz: number;
  a: number;
  w: number;
  y0: number;
  y1: number;
  t: number;
  openings: Opening[];
}

/** 立面上的一点：u 沿墙、v 竖向、d 沿外法线（>0 表示突出墙面） */
function facePoint(f: Facade, u: number, v: number, d: number): THREE.Vector3 {
  const c = Math.cos(f.a);
  const s = Math.sin(f.a);
  return new THREE.Vector3(f.cx + u * c + d * s, v, f.cz - u * s + d * c);
}

/**
 * 在立面上放一个盒体。
 * 几何先在"墙面局部空间"里造（X 沿墙、Y 向上、Z 朝外），再整体绕 Y 转到世界。
 * rz = 墙面内旋转（斜面 / 歪斜），rx = 绕墙切线倾斜（滴水斜面）。
 */
function faceBox(
  kit: Kit,
  f: Facade,
  mat: THREE.Material,
  u: number,
  v: number,
  d: number,
  len: number,
  h: number,
  th: number,
  opt: { rx?: number; rz?: number; outline?: boolean } = {},
): void {
  const g = new THREE.BoxGeometry(len, h, th);
  if (opt.rz) g.rotateZ(opt.rz);
  if (opt.rx) g.rotateX(opt.rx);
  g.rotateY(f.a);
  const p = facePoint(f, u, v, d);
  g.translate(p.x, p.y, p.z);
  kit.push(g, mat, opt.outline ?? false);
}

/** 在立面上放一片面片（朝外） */
function faceQuad(kit: Kit, f: Facade, mat: THREE.Material, u: number, v: number, d: number, w: number, h: number, rz = 0): void {
  const g = new THREE.PlaneGeometry(w, h);
  if (rz) g.rotateZ(rz);
  g.rotateY(f.a);
  const p = facePoint(f, u, v, d);
  g.translate(p.x, p.y, p.z);
  kit.push(g, mat);
}

/**
 * 砌一堵带洞口的墙：把墙切成 u×v 网格，洞口覆盖的格子留空，
 * 其余格子按行合并成整块体。这样窗是真的洞，深度真实存在。
 */
function buildFacadeWall(kit: Kit, f: Facade): void {
  const ops = f.openings;
  const xs = new Set<number>([-f.w / 2, f.w / 2]);
  const ys = new Set<number>([f.y0, f.y1]);
  for (const o of ops) {
    xs.add(clamp(o.u - o.w / 2, -f.w / 2, f.w / 2));
    xs.add(clamp(o.u + o.w / 2, -f.w / 2, f.w / 2));
    ys.add(clamp(o.v - o.h / 2, f.y0, f.y1));
    ys.add(clamp(o.v + o.h / 2, f.y0, f.y1));
  }
  const xc = [...xs].sort((a, b) => a - b);
  const yc = [...ys].sort((a, b) => a - b);
  const nx = xc.length - 1;
  const ny = yc.length - 1;
  const solid: boolean[][] = [];
  for (let j = 0; j < ny; j += 1) {
    solid.push([]);
    for (let i = 0; i < nx; i += 1) {
      const mu = (xc[i] + xc[i + 1]) / 2;
      const mv = (yc[j] + yc[j + 1]) / 2;
      let blocked = false;
      for (const o of ops) {
        if (Math.abs(mu - o.u) < o.w / 2 - 1e-4 && Math.abs(mv - o.v) < o.h / 2 - 1e-4) {
          blocked = true;
          break;
        }
      }
      solid[j].push(!blocked);
    }
  }
  // 按行合并连续的实心格
  for (let j = 0; j < ny; j += 1) {
    let i = 0;
    while (i < nx) {
      if (!solid[j][i]) {
        i += 1;
        continue;
      }
      let k = i;
      while (k + 1 < nx && solid[j][k + 1]) k += 1;
      const u = (xc[i] + xc[k + 1]) / 2;
      const len = xc[k + 1] - xc[i];
      const v = (yc[j] + yc[j + 1]) / 2;
      const h = yc[j + 1] - yc[j];
      faceBox(kit, f, f.mat, u, v, -f.t / 2, len, h, f.t, { outline: true });
      i = k + 1;
    }
  }
}

/** 洞口内壁：把洞口的上下左右四壁压暗，窗洞才不会顶着一条白边 */
function buildReveal(kit: Kit, f: Facade, o: Opening): void {
  const d = -f.t / 2;
  const th = 0.04;
  const dpth = f.t * 0.94;
  faceBox(kit, f, M.reveal, o.u, o.v + o.h / 2 - th / 2, d, o.w, th, dpth);
  faceBox(kit, f, M.reveal, o.u, o.v - o.h / 2 + th / 2, d, o.w, th, dpth);
  faceBox(kit, f, M.reveal, o.u - o.w / 2 + th / 2, o.v, d, th, o.h, dpth);
  faceBox(kit, f, M.reveal, o.u + o.w / 2 - th / 2, o.v, d, th, o.h, dpth);
  // 洞内一片黑：挡住后面的实体墙，窗洞才读得出"里面有房间"
  faceBox(kit, f, M.dark, o.u, o.v, -f.t + 0.06, o.w, o.h, 0.05);
}

/**
 * 一扇有进深的窗：内退窗框 + 洞口侧壁 + 外挑窗台（带斜面）+ 窗楣 + 窗内内容。
 */
function windowUnit(kit: Kit, f: Facade, o: Opening): void {
  const deep = f.t * 0.7; // 窗框退进去的深度
  const glassD = -deep + 0.02;

  if (kit.tier === 'near') buildReveal(kit, f, o);
  else faceBox(kit, f, M.dark, o.u, o.v, -f.t + 0.06, o.w, o.h, 0.05);

  // 内退窗框（真实厚度）
  const frame = windowFrameGeometry(o.w * 0.96, o.h * 0.96, 0.12, o.kind === 'window');
  frame.rotateY(f.a);
  const fp = facePoint(f, o.u, o.v, -deep);
  frame.translate(fp.x, fp.y, fp.z);
  kit.push(frame, o.kind === 'shop' ? M.steelFrame : M.trimDark);

  // 玻璃 / 灯光
  if (o.lit) {
    faceQuad(kit, f, o.emerg ? LIT_EMERG : o.cold ? LIT_COLD : LIT_WARM, o.u, o.v, glassD - 0.03, o.w * 0.9, o.h * 0.88);
    // 窗内家具剪影：几块深色体块
    if (kit.tier === 'near') {
      for (let i = 0; i < 3; i += 1) {
        const fw = kit.rng.range(0.22, 0.42);
        const fh = kit.rng.range(0.28, 0.62);
        const fu = o.u + kit.rng.range(-o.w * 0.3, o.w * 0.3);
        const fv = o.v - o.h / 2 + fh / 2 + kit.rng.range(0.02, 0.16);
        faceBox(kit, f, M.furniture, fu, fv, glassD - 0.01, fw, fh, 0.06);
      }
    }
  } else if (o.kind === 'shop') {
    if (!OPEN_WINDOW_PLOTS.has(kit.plotIndex)) faceQuad(kit, f, M.glassBroken, o.u, o.v, glassD - 0.02, o.w * 0.94, o.h * 0.9);
  } else {
    if (!OPEN_WINDOW_PLOTS.has(kit.plotIndex)) faceQuad(kit, f, M.glass, o.u, o.v, glassD - 0.02, o.w * 0.92, o.h * 0.9);
    if (o.broken && kit.tier !== 'far') {
      // 参差玻璃残渣：几片歪着的小碎块，不是完整矩形
      const shards = kit.tier === 'near' ? 6 : 3;
      for (let i = 0; i < shards; i += 1) {
        const sw = kit.rng.range(0.08, 0.26);
        const sh = kit.rng.range(0.06, 0.2);
        const su = o.u + kit.rng.range(-o.w * 0.42, o.w * 0.42);
        const sv = o.v + kit.rng.range(-o.h * 0.4, o.h * 0.4);
        faceBox(kit, f, M.shard, su, sv, glassD + 0.01, sw, sh, 0.02, {
          rz: kit.rng.range(-0.9, 0.9),
          rx: kit.rng.range(-0.5, 0.5),
        });
      }
    }
  }

  // 外挑窗台（带斜面）
  if (o.kind !== 'shop') {
    faceBox(kit, f, M.trim, o.u, o.v - o.h / 2 - 0.08, 0.08, o.w + 0.44, 0.11, 0.38);
    faceBox(kit, f, M.trim, o.u, o.v - o.h / 2 - 0.02, 0.11, o.w + 0.5, 0.06, 0.42, { rx: 0.2 });
  }

  // 窗楣
  faceBox(kit, f, M.trim, o.u, o.v + o.h / 2 + 0.09, 0.05, o.w + 0.42, 0.16, 0.16);

  // 半损毁的木质百叶 / 遮阳板：一扇歪斜挂着的木百叶，投出细密的条状影子
  if (o.kind === 'window' && kit.tier !== 'far' && kit.rng.chance(0.12)) {
    const lu = o.u + kit.rng.range(-0.08, 0.08);
    const lv = o.v + kit.rng.range(-0.08, 0.08);
    // 歪斜角：一半脱轴的百叶会向外翻
    const tilt = kit.rng.range(0.16, 0.36) * (kit.rng.chance(0.5) ? 1 : -1);
    const lant = kit.rng.range(0.1, 0.2);
    // 百叶片（4~6 根窄条，中间空隙透光）——尺寸严格不超过窗洞
    const slats = kit.tier === 'near' ? 5 : 3;
    const lw = Math.min(o.w * 0.9, 1.0);
    const lh = Math.min(o.h * 0.8, 1.1);
    for (let i = 0; i < slats; i += 1) {
      const t = (i + 0.5) / slats;
      faceBox(
        kit,
        f,
        kit.rng.chance(0.4) ? M.woodDark : M.wood,
        lu,
        lv - lh / 2 + t * lh,
        0.08 + lant,
        lw,
        0.06,
        0.024,
        { rz: tilt },
      );
    }
    // 百叶框（歪着）
    faceBox(kit, f, M.woodDark, lu, lv + lh / 2, 0.08 + lant, lw, 0.05, 0.045, { rz: tilt });
    faceBox(kit, f, M.woodDark, lu, lv - lh / 2, 0.08 + lant, lw, 0.05, 0.045, { rz: tilt });
    // 固定百叶的两只挂耳
    for (const s of [-1, 1]) {
      faceBox(kit, f, M.metalDark, lu + (s * lw) / 2, lv + lh * 0.4, 0.07, 0.05, 0.1, 0.06);
    }
  }

  // 封板窗：木板有厚度、有钉子、歪斜角度不一
  if (o.boarded && kit.tier !== 'far') {
    const planks = kit.tier === 'near' ? 3 : 2;
    for (let i = 0; i < planks; i += 1) {
      const pv = o.v - o.h / 2 + ((i + 0.5) * o.h) / planks + kit.rng.range(-0.05, 0.05);
      const pd = -0.02 + kit.rng.range(-0.03, 0.05);
      faceBox(kit, f, i % 2 === 0 ? M.wood : M.woodDark, o.u + kit.rng.range(-0.06, 0.06), pv, pd, o.w + 0.3, 0.16, 0.05, {
        rz: kit.rng.range(-0.16, 0.16),
      });
      // 钉子
      if (kit.tier === 'near') {
        for (const s of [-1, 1]) {
          const p = facePoint(f, o.u + s * (o.w * 0.34), pv + kit.rng.range(-0.03, 0.03), pd + 0.035);
          const nail = new THREE.CylinderGeometry(0.016, 0.016, 0.03, 5);
          nail.rotateX(Math.PI / 2);
          nail.rotateY(f.a);
          nail.translate(p.x, p.y, p.z);
          kit.push(nail, M.metalDark);
        }
      }
    }
  }
}

/** 门：内退门扇 + 门套 + 台阶 */
function doorUnit(kit: Kit, f: Facade, o: Opening, mat: THREE.Material): void {
  const deep = f.t * 0.55;
  faceBox(kit, f, M.dark, o.u, o.v, -f.t + 0.06, o.w, o.h, 0.05);
  faceBox(kit, f, mat, o.u, o.v, -deep, o.w * 0.86, o.h * 0.96, 0.08);
  faceBox(kit, f, M.trim, o.u, o.v + o.h / 2 + 0.07, 0.04, o.w + 0.3, 0.14, 0.16);
  // 台阶
  faceBox(kit, f, M.concrete, o.u, 0.09, 0.28, o.w + 0.7, 0.18, 0.72);
  faceBox(kit, f, M.concrete, o.u, 0.26, 0.16, o.w + 0.4, 0.16, 0.42);
}

/** 商铺橱窗：钢框 + 破玻璃 + 暖光 */
function shopWindow(kit: Kit, f: Facade, o: Opening): void {
  const deep = f.t * 0.68;
  faceBox(kit, f, M.dark, o.u, o.v, -f.t + 0.06, o.w, o.h, 0.05);
  faceBox(kit, f, M.steelFrame, o.u, o.v, -deep, o.w + 0.2, o.h + 0.2, 0.1);
  faceQuad(kit, f, M.glassBroken, o.u, o.v, -deep + 0.05, o.w * 0.94, o.h * 0.92);
  faceQuad(kit, f, LIT_SHOP, o.u, o.v - o.h * 0.32, -deep + 0.07, o.w * 0.8, o.h * 0.2);
  // 竖梃
  faceBox(kit, f, M.trim, o.u, o.v, -deep + 0.08, 0.08, o.h, 0.1);
  faceBox(kit, f, M.trim, o.u, o.v + o.h * 0.1, -deep + 0.08, o.w, 0.09, 0.1);
}

/** 把一整面立面建出来：墙 + 所有洞口 */
function buildFacade(kit: Kit, f: Facade): void {
  buildFacadeWall(kit, f);
  for (const o of f.openings) {
    if (o.kind === 'door') doorUnit(kit, f, o, kit.rng.chance(0.5) ? M.woodDark : M.metal);
    else if (o.kind === 'shop') shopWindow(kit, f, o);
    else windowUnit(kit, f, o);
  }
}

// ─────────────────────────── 立面附件 ───────────────────────────

/** 勒脚 + 楼层腰线（带滴水斜面） */
function facadeBands(kit: Kit, f: Facade, levels: number[], baseH: number): void {
  faceBox(kit, f, M.concreteDark, 0, baseH / 2, 0.05, f.w, baseH, 0.12);
  faceBox(kit, f, M.trimDark, 0, baseH + 0.03, 0.09, f.w, 0.09, 0.16, { rx: 0.18 });
  for (const y of levels) {
    faceBox(kit, f, M.trim, 0, y + 0.06, 0.05, f.w, 0.12, 0.13);
    faceBox(kit, f, M.trimDark, 0, y + 0.14, 0.08, f.w, 0.05, 0.15, { rx: 0.2 });
  }
}

/** 檐口 + 檐沟（独立高模件） */
function facadeEave(kit: Kit, f: Facade, y: number): void {
  faceBox(kit, f, M.trim, 0, y - 0.1, 0.07, f.w + 0.08, 0.2, 0.28);
  if (kit.tier !== 'far') {
    const g = gutterGeometry(f.w);
    g.rotateY(f.a);
    const p = facePoint(f, 0, y - 0.3, 0.22);
    g.translate(p.x, p.y, p.z);
    kit.push(g, M.rustDark);
  }
}

/** 落水管：管身 + 接口环 + 墙脚滴水石 */
function facadeDownpipe(kit: Kit, f: Facade, u: number, top: number): void {
  const h = top - 0.3;
  if (kit.tier === 'far') {
    faceBox(kit, f, M.rust, u, h / 2 + 0.15, 0.1, 0.16, h, 0.16);
    return;
  }
  const g = downpipeGeometry(h, true);
  g.rotateY(f.a);
  const p = facePoint(f, u, 0.15, 0.14);
  g.translate(p.x, p.y, p.z);
  kit.push(g, M.rust);
  faceBox(kit, f, M.concreteDark, u, 0.07, 0.3, 0.6, 0.14, 0.5);
}

/** 空调外机：挂在墙上的独立高模 */
function facadeAC(kit: Kit, f: Facade, u: number, v: number): void {
  const g = acUnitGeometry();
  g.rotateY(f.a);
  const p = facePoint(f, u, v, 0.22);
  g.translate(p.x, p.y, p.z);
  kit.push(g, M.metalDark);
  faceBox(kit, f, M.rust, u, v - 0.52, 0.14, 0.08, 0.3, 0.26);
}

/**
 * 外墙逃生梯（Z 字形金属梯）。
 *
 * 几何规则（决定了它读起来像不像逃生梯）：
 *  - 有一条**竖向中线**（贴墙的爬梯井），每层平台**左右交替**挂在中线两侧 → Z 字；
 *  - 平台高 = 各层窗台高，平台正对窗户（人能跨进去）；
 *  - 斜梯从本层平台外沿斜向上一层平台内沿，踏板是**镂空格栅**；
 *  - 扶手：主扶手粗（0.07）、中间横杆细（0.04）、立柱更细（0.05）；
 *  - 与墙的支架有立体厚度；金属冷调，与砖墙明确区分；
 *  - 战损：某几层踏板缺失/下垂、立柱弯折、栏杆断口、锈斑。
 *
 * 局部坐标：X 沿墙（u 方向），Y 向上，Z 朝外（离墙距离 d）。
 */
function facadeFireEscape(kit: Kit, f: Facade, u0: number, floors: number, floorH: number, baseY: number, seed: number): void {
  const rng = kit.rng;
  const metal = M.escapeMetal;
  const metalRust = M.escapeRust;
  const metalDark = M.escapeDark;

  const PLAT_W = 1.5; // 平台宽（沿墙）
  const PLAT_D = 1.15; // 平台深（离墙）
  const RAIL_H = 1.05;
  const STEP_N = 6;
  // 中景降档：踏步与格栅的根数减半（远看读不出镂空细节，但能保住剪影）
  const lite = kit.tier === 'mid';
  const platSlats = lite ? 4 : 7;
  const stepBars = lite ? 2 : 3;

  // 中线在 u0；平台中心在 u0 ± PLAT_W/2，左右交替
  for (let fl = 0; fl < floors; fl += 1) {
    const y0 = baseY + fl * floorH; // 平台面（对齐各层窗台）
    const side = fl % 2 === 0 ? 1 : -1; // Z 字：左右交替
    const pcx = u0 + (side * PLAT_W) / 2; // 平台中心
    const broken = fl === 1 || (fl === 2 && seed % 3 === 0);
    const p0 = pcx - PLAT_W / 2;

    // —— 平台格栅踏板：沿 X 排若干根细条（沿 Z 满铺）——
    const slats = platSlats;
    for (let i = 0; i < slats; i += 1) {
      const t = (i + 0.5) / slats;
      const sx = p0 + t * PLAT_W;
      // 战损：靠外侧的几根缺失 / 下垂
      const gone = broken && i > 4 && rng.chance(0.5);
      if (gone) continue;
      const sag = broken && i > 3 ? rng.range(0.06, 0.26) : 0;
      faceBox(kit, f, metal, sx, y0 - 0.035 - sag, PLAT_D / 2, 0.05, 0.045, PLAT_D, { rx: sag * 0.8 });
    }
    // 横向联系条（构成镂空网格）
    for (let i = 0; i < (lite ? 2 : 3); i += 1) {
      const d = ((i + 0.5) / 3) * PLAT_D;
      faceBox(kit, f, metalDark, pcx, y0 - 0.068, d, PLAT_W, 0.042, 0.04);
    }
    // 承重边梁（贴墙那侧最粗）
    faceBox(kit, f, metalDark, pcx, y0 - 0.085, 0.05, PLAT_W, 0.1, 0.1);
    // 外沿边梁
    faceBox(kit, f, metalDark, pcx, y0 - 0.08, PLAT_D - 0.04, PLAT_W, 0.075, 0.07);

    // —— 栏杆 ——
    const railZ = PLAT_D - 0.06;
    // 外沿主扶手（粗）
    faceBox(kit, f, metal, pcx, y0 + RAIL_H, railZ, PLAT_W, 0.07, 0.07);
    // 外沿中间横杆（细）
    faceBox(kit, f, metalDark, pcx, y0 + RAIL_H * 0.52, railZ, PLAT_W, 0.038, 0.038);
    // 两端立柱（细）
    for (const s of [-1, 1]) {
      const px = pcx + (s * PLAT_W) / 2;
      const postH = broken && s === side ? RAIL_H * rng.range(0.4, 0.7) : RAIL_H;
      const bend = broken && s === side ? rng.range(0.14, 0.36) : 0;
      faceBox(kit, f, metal, px, y0 + postH / 2, railZ, 0.05, postH, 0.05, { rz: bend });
    }
    // 靠墙侧的扶手（沿 Z 方向围出爬梯井）
    faceBox(kit, f, metal, u0, y0 + RAIL_H, PLAT_D / 2, 0.055, 0.055, PLAT_D);
    // 平台两端（靠中线那侧）短栏杆
    const innerX = u0 + (side * PLAT_W) / 2 - side * 0.04;
    faceBox(kit, f, metal, innerX, y0 + RAIL_H, PLAT_D / 2, 0.05, 0.05, PLAT_D);

    // —— 与墙连接的支架（两根斜撑 + 底托，有厚度）——
    for (const s of [-1, 1]) {
      const bx = pcx + (s * PLAT_W) / 2 - s * 0.14;
      faceBox(kit, f, metalDark, bx, y0 - 0.22, 0.14, 0.085, 0.46, 0.14, { rx: 0.46 });
      faceBox(kit, f, metalDark, bx, y0 - 0.32, 0.05, 0.15, 0.085, 0.22);
    }

    // —— 锈斑 ——
    if (rng.chance(0.8)) {
      for (let i = 0; i < 3; i += 1) {
        faceBox(
          kit,
          f,
          metalRust,
          pcx + rng.range(-PLAT_W * 0.36, PLAT_W * 0.36),
          y0 + rng.range(0.02, 0.28),
          PLAT_D * rng.range(0.25, 0.85),
          rng.range(0.1, 0.26),
          rng.range(0.09, 0.2),
          0.028,
        );
      }
    }

    // —— 斜梯：本层平台 → 上一层平台（Z 字：从本层外沿斜到上层外沿）——
    if (fl < floors - 1) {
      const nextSide = -side;
      // 本层平台外沿 = 中心 + 外侧半个平台宽；上层平台外沿同理（在另一侧）
      const fromX = pcx + (side * PLAT_W) / 2;
      const toX = u0 + (nextSide * PLAT_W); // 上层平台的外沿
      const run = Math.abs(toX - fromX);
      const dirSign = Math.sign(toX - fromX) || 1;
      const ang = Math.atan2(floorH, run) * dirSign; // 斜梁倾角（墙面局部空间）
      const midX = (fromX + toX) / 2;
      const midY = y0 + floorH / 2;

      // 踏步：每级 3 根细条（镂空），沿 Z 方向铺在平台深度内
      for (let s = 0; s < STEP_N; s += 1) {
        const t = (s + 0.5) / STEP_N;
        const sy = y0 + floorH * t;
        const sx = fromX + (toX - fromX) * t;
        const missing = broken && s > 3 && rng.chance(0.55);
        if (missing) continue;
        const droop = broken && s > 3 ? rng.range(0.04, 0.14) : 0;
        for (let k = 0; k < stepBars; k += 1) {
          const kt = (k + 0.5) / stepBars;
          faceBox(kit, f, metal, sx, sy - droop, 0.2 + kt * 0.42, 0.3, 0.038, 0.04);
        }
      }
      // 斜梁（两根侧梁）：贴墙侧一根 + 外侧一根
      const strutLen = Math.hypot(floorH, run);
      for (const s of [-1, 1]) {
        faceBox(kit, f, metalDark, midX, midY, 0.16 + s * 0.2, strutLen, 0.065, 0.065, { rz: ang });
      }
      // 斜扶手（沿斜梁上方）
      const bend = broken ? rng.range(0.08, 0.22) : 0;
      for (const s of [-1, 1]) {
        faceBox(kit, f, metal, midX, midY + 0.82, 0.16 + s * 0.2, strutLen, 0.048, 0.048, { rz: ang + bend * 0.25 });
      }
    }
  }
}

// ─────────────────────────── 立体剥落 / 砖芯 ───────────────────────────

let chipVariants: THREE.BufferGeometry[] | null = null;
function chips(): THREE.BufferGeometry[] {
  if (chipVariants) return chipVariants;
  const r = createRng('chip-variants');
  chipVariants = [
    chippedSlab(1.1, 0.9, 0.11, r, 0.24),
    chippedSlab(0.8, 1.1, 0.09, r, 0.2),
    chippedSlab(1.3, 0.7, 0.13, r, 0.28),
  ];
  return chipVariants;
}

let brickGeo: THREE.BufferGeometry | null = null;
function bricks(): THREE.BufferGeometry {
  if (!brickGeo) brickGeo = brickGeometry(createRng('brick-core'));
  return brickGeo;
}

let debrisGeo: THREE.BufferGeometry | null = null;
function debris(): THREE.BufferGeometry {
  if (!debrisGeo) debrisGeo = new THREE.TetrahedronGeometry(0.07, 0);
  return debrisGeo;
}

let tileGeo: THREE.BufferGeometry | null = null;
function tiles(): THREE.BufferGeometry {
  if (!tileGeo) tileGeo = tileGeometry(createRng('tile'));
  return tileGeo;
}

/**
 * 立面风化：墙面的明度分层（雨痕 / 积灰）+ 立体剥落 + 弹着点。
 * 每个可见立面都要过一遍，否则背立面会是一整块平色。
 */
function weatherFacade(kit: Kit, f: Facade, opts: { grime: number; peels: number; clusters: number }): void {
  facadeGrime(kit, f, opts.grime);
  for (let i = 0; i < opts.peels; i += 1) {
    peelPatch(
      kit,
      f,
      kit.rng.range(-f.w * 0.42, f.w * 0.42),
      kit.rng.range(f.y0 + 1.0, f.y1 - 0.7),
      kit.rng.range(0.8, 1.7),
      kit.rng.range(0.7, 1.4),
    );
  }
  for (let i = 0; i < opts.clusters; i += 1) {
    bulletCluster(
      kit,
      f,
      kit.rng.range(-f.w * 0.4, f.w * 0.4),
      kit.rng.range(f.y0 + 1.2, f.y1 - 0.8),
    );
  }
}

/**
 * 剥落墙皮：成组的立体破片（略微内凹、边缘露出砖芯），
 * 剥落区下方用错缝外露砖填充。
 */
function peelPatch(kit: Kit, f: Facade, u: number, v: number, w: number, h: number): void {
  const rng = kit.rng;
  const geo = chips();
  const count = kit.tier === 'near' ? 3 : kit.tier === 'mid' ? 2 : 1;
  for (let i = 0; i < count; i += 1) {
    const g = geo[i % geo.length];
    const su = u + rng.range(-w * 0.35, w * 0.35);
    const sv = v + rng.range(-h * 0.3, h * 0.3);
    // 破片略微内凹，但仍在墙面之外，边缘才咬得进砖芯
    const p = facePoint(f, su, sv, 0.012);
    kit.instance(g, rng.chance(0.5) ? M.chipPeel : M.chipCold, [
      {
        position: p,
        rotation: new THREE.Euler(rng.range(-0.08, 0.08), f.a + rng.range(-0.5, 0.5), rng.range(-0.6, 0.6)),
        scale: new THREE.Vector3(w * rng.range(0.4, 0.75), h * rng.range(0.4, 0.75), 1),
      },
    ]);
  }
  // 砖芯（错缝外露砖）—— 远景不用砖芯，只留少量破片
  if (kit.tier === 'far') return;
  const rows = Math.max(2, Math.round(h / 0.13));
  const cols = Math.max(2, Math.round(w / 0.3));
  const tx: InstanceTransform[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const off = r % 2 === 0 ? 0 : 0.15;
      const bu = u - (cols * 0.3) / 2 + c * 0.3 + off;
      const bv = v - h / 2 + r * 0.095;
      if (Math.abs(bu - u) > w / 2) continue;
      // 砖芯比墙面**稍微凸出**，才看得到错缝与体积
      const p = facePoint(f, bu, bv, 0.012);
      tx.push({
        position: p,
        rotation: new THREE.Euler(0, f.a + rng.range(-0.04, 0.04), rng.range(-0.06, 0.06)),
        scale: new THREE.Vector3(1, 1, 1),
      });
    }
  }
  if (tx.length) kit.instance(bricks(), rng.chance(0.6) ? M.brickCore : M.brickCoreDark, tx);
}

/**
 * 墙面雨痕 / 积灰：竖向的深色条带 + 窗上烟熏。
 * 让同一面墙至少有 3 级明度，而不是一整块平色。
 */
function facadeGrime(kit: Kit, f: Facade, count: number): void {
  const rng = kit.rng;
  for (let i = 0; i < count; i += 1) {
    const u = rng.range(-f.w * 0.46, f.w * 0.46);
    const h = rng.range(0.8, 2.4);
    const v = rng.range(f.y0 + h / 2 + 0.3, f.y1 - h / 2);
    const p = facePoint(f, u, v, 0.02);
    kit.patch(M.concreteDark, rng.range(0.22, 0.6), h, p.x, p.y, p.z, 0.09, f.a);
  }
}

/** 弹着点：3~5 个弹孔 + 一圈崩裂碎屑 */
function bulletCluster(kit: Kit, f: Facade, u: number, v: number): void {
  const rng = kit.rng;
  const n = 3 + Math.floor(rng.next() * 3);
  for (let i = 0; i < n; i += 1) {
    const hu = u + rng.range(-0.26, 0.26);
    const hv = v + rng.range(-0.22, 0.22);
    const p = facePoint(f, hu, hv, 0.03);
    kit.hole(M.soot, rng.range(0.04, 0.08), p.x, p.y, p.z, f.a);
    const sp = facePoint(f, hu, hv, 0.024);
    kit.patch(M.soot, rng.range(0.2, 0.42), rng.range(0.18, 0.4), sp.x, sp.y, sp.z, 0.1, f.a);
  }
  // 崩裂碎屑环
  const ring = debrisRing(kit.tier === 'near' ? 9 : 5, 0.19, rng, 0.55);
  const tx = ring.map((t) => {
    const p = facePoint(f, u + t.position.x, v + t.position.y, 0.035 + t.position.z);
    return {
      position: p,
      rotation: new THREE.Euler(t.rotation?.x ?? 0, f.a + (t.rotation?.y ?? 0), t.rotation?.z ?? 0),
      scale: t.scale ?? new THREE.Vector3(1, 1, 1),
    };
  });
  kit.instance(debris(), M.concreteDark, tx);
}

// ─────────────────────────── 屋面 ───────────────────────────

/**
 * 坡屋顶的叠瓦：一列列瓦片沿坡面搭接（长边搭接），看得出瓦垄顺序；
 * 全部实例化，一个 draw call。
 */
function roofTiles(kit: Kit, cx: number, cz: number, w: number, rise: number, rd: number, baseY: number, mat: THREE.Material): void {
  const rng = kit.rng;
  const geo = tiles();
  const half = rd / 2;
  const slopeLen = Math.hypot(half, rise);
  const ang = Math.atan2(rise, half);
  const alongStep = kit.tier === 'near' ? 0.26 : 0.4;
  const acrossStep = kit.tier === 'near' ? 0.32 : 0.5;
  for (const s of [1, -1] as const) {
    const tx: InstanceTransform[] = [];
    for (let d = 0.12; d < slopeLen; d += alongStep) {
      const t = d / slopeLen;
      const y = baseY + rise * (1 - t) + 0.07;
      const z = cz + s * half * t;
      const stagger = Math.round(d / alongStep) % 2 === 0 ? 0 : acrossStep * 0.5;
      for (let x = -w / 2 + stagger + acrossStep * 0.5; x < w / 2; x += acrossStep) {
        tx.push({
          position: new THREE.Vector3(cx + x + rng.range(-0.02, 0.02), y + rng.range(-0.01, 0.01), z),
          rotation: new THREE.Euler(s * ang, rng.range(-0.03, 0.03), rng.range(-0.03, 0.03)),
          scale: new THREE.Vector3(1, 1, 1),
        });
      }
    }
    if (tx.length) kit.instance(geo, mat, tx);
  }
}

/** 平屋顶的屋面杂物：水箱、通风帽、天线 */
function roofClutter(kit: Kit, area: { x: number; z: number; w: number; d: number }, y: number): void {
  const rng = kit.rng;
  const cx = area.x;
  const cz = area.z;
  // 水箱（带支架）
  const tx = cx + rng.range(-area.w * 0.22, area.w * 0.22);
  const tz = cz - area.d * 0.18;
  for (const [lx, lz] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]] as Array<[number, number]>) {
    kit.box(M.rustDark, 0.11, 0.85, 0.11, tx + lx, y + 0.42, tz + lz);
  }
  const tank = new THREE.CylinderGeometry(0.8, 0.8, 1.15, 9, 1, false);
  tank.translate(tx, y + 1.42, tz);
  kit.push(tank, M.metalDark, true);
  kit.box(M.rust, 0.42, 0.12, 0.42, tx, y + 2.05, tz);
  // 通风帽
  const vx = cx + rng.range(-area.w * 0.28, area.w * 0.28);
  kit.pipe(M.metal, 0.12, 0.62, vx, y + 0.31, cz + area.d * 0.2, 6);
  const cap = new THREE.CylinderGeometry(0.22, 0.16, 0.14, 8);
  cap.translate(vx, y + 0.68, cz + area.d * 0.2);
  kit.push(cap, M.metalDark);
  // 天线
  const ax = cx + rng.range(-area.w * 0.18, area.w * 0.18);
  kit.pipe(M.metalDark, 0.045, 2.2, ax, y + 1.1, cz - area.d * 0.3);
  for (let i = 0; i < 3; i += 1) {
    kit.rod(M.metalDark, 0.028, 0.85 - i * 0.17, ax, y + 1.7 + i * 0.28, cz - area.d * 0.3, 'x');
  }
}

/**
 * 战损平屋顶：替代坡屋顶。
 *
 *  - 屋面是**平**的，但有排水找坡、积水痕与补丁；
 *  - 女儿墙**破损**：有缺口（能看见内部砖芯）、断口、露出的钢筋、歪斜的压顶；
 *  - 屋面不空荡：水塔、通风管、天线、**废弃卫星锅**、散落杂物与瓦砾。
 *
 * 局部坐标：ux = 单元中心 x，zF = 临街面，zB = 背面，bodyH = 墙顶高度。
 */
function flatRoofDamaged(
  kit: Kit,
  ux: number,
  zF: number,
  zB: number,
  width: number,
  bodyH: number,
  wallMat: THREE.Material,
  seed: number,
): void {
  const rng = kit.rng;
  const depth = zF - zB;
  const cz = (zF + zB) / 2;
  const bd = depth;
  const PARAPET_H = 0.62;

  // —— 屋面板（比墙体略出挑，压出檐口阴影）——
  kit.box(M.roofDark, width + 0.14, 0.22, bd + 0.1, ux, bodyH + 0.05, cz, 0, true);

  // —— 屋面细节：找坡、补丁、积水痕 ——
  // 泛水卷边（女儿墙根部的暗色带）
  kit.box(M.concreteDark, width - 0.1, 0.06, bd - 0.1, ux, bodyH + 0.17, cz);
  // 防水补丁（几块略微翘起的不规则板）
  for (let i = 0; i < 3; i += 1) {
    const px = ux + rng.range(-width * 0.35, width * 0.35);
    const pz = cz + rng.range(-bd * 0.3, bd * 0.3);
    kit.tilt(M.roofRust, rng.range(0.7, 1.6), 0.05, rng.range(0.6, 1.3), px, bodyH + 0.18, pz, rng.range(-0.06, 0.06), rng.range(-0.05, 0.05));
  }

  // —— 女儿墙：分段砌，段与段之间留缺口 ——
  // 四边：临街面（zF）、背面（zB）、左右端
  const buildParapet = (axis: 'x' | 'z', fixed: number, from: number, to: number): void => {
    // 沿这一边切成若干段，缺口处只剩残根
    const segLen = 1.5;
    const n = Math.max(2, Math.round((to - from) / segLen));
    const step = (to - from) / n;
    for (let i = 0; i < n; i += 1) {
      const a = from + i * step;
      const mid = a + step / 2;
      // 缺口：临街面与背面各留 1~2 个（更符合"被炸开"的读法）
      const gapChance = 0.46;
      const isGap = rng.chance(gapChance);
      if (isGap) {
        // 残根：只剩 0.06~0.2 m 高的墙脚，露出断口
        const stubH = rng.range(0.06, 0.2);
        const g = new THREE.BoxGeometry(axis === 'x' ? step * 0.92 : 0.24, stubH, axis === 'x' ? 0.24 : step * 0.92);
        g.translate(axis === 'x' ? mid : fixed, bodyH + 0.16 + stubH / 2, axis === 'x' ? fixed : mid);
        kit.push(g, M.brick, true);
        // 断口处露出的钢筋（歪的、伸出残根）
        for (let k = 0; k < 3; k += 1) {
          const bx = axis === 'x' ? mid + rng.range(-0.3, 0.3) : fixed + rng.range(-0.06, 0.06);
          const bz = axis === 'x' ? fixed + rng.range(-0.06, 0.06) : mid + rng.range(-0.3, 0.3);
          const len = rng.range(0.28, 0.7);
          kit.rod(M.rustDark, 0.024, len, bx, bodyH + 0.16 + stubH + len * 0.35, bz, axis === 'x' ? 'z' : 'x', 4);
        }
        continue;
      }
      // 完整段
      const g = new THREE.BoxGeometry(axis === 'x' ? step * 0.96 : 0.24, PARAPET_H, axis === 'x' ? 0.24 : step * 0.96);
      g.translate(axis === 'x' ? mid : fixed, bodyH + 0.16 + PARAPET_H / 2, axis === 'x' ? fixed : mid);
      kit.push(g, wallMat, true);
      // 压顶（略挑出，投影出细影）
      const cap = new THREE.BoxGeometry(axis === 'x' ? step * 0.99 : 0.32, 0.1, axis === 'x' ? 0.32 : step * 0.99);
      cap.translate(axis === 'x' ? mid : fixed, bodyH + 0.16 + PARAPET_H + 0.05, axis === 'x' ? fixed : mid);
      kit.push(cap, M.trimDark);
    }
  };
  buildParapet('x', zF + 0.12, ux - width / 2, ux + width / 2); // 临街
  buildParapet('x', zB - 0.12, ux - width / 2, ux + width / 2); // 背面
  buildParapet('z', ux - width / 2 + 0.12, zB, zF); // 左端
  buildParapet('z', ux + width / 2 - 0.12, zB, zF); // 右端

  // —— 屋面杂物：水塔 / 通风管 / 天线 / 卫星锅 / 瓦砾 ——
  const area = { x: ux, z: cz, w: width - 0.6, d: bd - 0.6 };
  const y = bodyH + 0.18;

  // 卫星锅（抛物面 + 支臂 + 底座）—— 俯视时最有辨识度
  if (rng.chance(0.72)) {
    const dx = ux + rng.range(-area.w * 0.3, area.w * 0.3);
    const dz = cz + rng.range(-area.d * 0.3, area.d * 0.3);
    const dishR = rng.range(0.42, 0.62);
    const dish = new THREE.SphereGeometry(dishR, 12, 5, 0, Math.PI * 2, 0, Math.PI * 0.42);
    dish.rotateX(Math.PI * 0.82);
    dish.rotateY(rng.range(0, Math.PI * 2));
    dish.rotateZ(rng.range(-0.3, 0.3));
    dish.translate(dx, y + 0.52, dz);
    kit.push(dish, M.metalDark, true);
    // 支臂
    kit.rod(M.metalDark, 0.035, 0.5, dx, y + 0.26, dz, 'y', 5);
    // 底座
    kit.box(M.rustDark, 0.28, 0.1, 0.28, dx, y + 0.05, dz);
    // 接收头
    const arm = new THREE.CylinderGeometry(0.028, 0.028, dishR * 0.9, 5);
    arm.rotateZ(0.9);
    arm.translate(dx + dishR * 0.2, y + 0.72, dz);
    kit.push(arm, M.metal);
  }

  // 水塔（铁皮罐 + 支腿 + 顶盖）
  if (rng.chance(0.85)) {
    const tx = ux + rng.range(-area.w * 0.25, area.w * 0.25);
    const tz = cz - area.d * 0.22;
    for (const [lx, lz] of [[-0.55, -0.55], [0.55, -0.55], [-0.55, 0.55], [0.55, 0.55]] as Array<[number, number]>) {
      kit.box(M.rustDark, 0.11, 1.0, 0.11, tx + lx, y + 0.5, tz + lz);
    }
    // 斜撑
    for (const s of [-1, 1]) {
      kit.tilt(M.rustDark, 0.08, 1.25, 0.08, tx + s * 0.5, y + 0.62, tz, 0, s * 0.18);
    }
    const tank = new THREE.CylinderGeometry(0.78, 0.78, 1.3, 10, 1, false);
    tank.translate(tx, y + 1.65, tz);
    kit.push(tank, rng.chance(0.5) ? M.metalDark : M.rust, true);
    // 顶盖（略微歪）
    kit.tilt(M.rust, 0.92, 0.1, 0.92, tx, y + 2.34, tz, rng.range(-0.08, 0.08), rng.range(-0.08, 0.08));
    // 罐身箍
    for (const hy of [1.2, 2.0]) {
      const hoop = new THREE.TorusGeometry(0.8, 0.035, 4, 12);
      hoop.rotateX(Math.PI / 2);
      hoop.translate(tx, y + hy, tz);
      kit.push(hoop, M.rustDark);
    }
  }

  // 烟囱群（2~3 个高低不一的短烟囱）
  const chimN = rng.int(2, 3);
  for (let i = 0; i < chimN; i += 1) {
    const cxx = ux + rng.range(-area.w * 0.34, area.w * 0.34);
    const czz = cz + rng.range(-area.d * 0.28, area.d * 0.24);
    const ch = rng.range(0.6, 1.25);
    kit.box(M.brickDark, 0.44, ch, 0.44, cxx, y + ch / 2, czz, 0, true);
    kit.box(M.concreteDark, 0.56, 0.1, 0.56, cxx, y + ch + 0.05, czz);
    kit.box(M.burnt, 0.2, 0.08, 0.2, cxx, y + ch + 0.11, czz);
  }

  // 通风管（带弯头）
  for (let i = 0; i < 2; i += 1) {
    const vx = ux + rng.range(-area.w * 0.34, area.w * 0.34);
    const vz = cz + rng.range(-area.d * 0.1, area.d * 0.3);
    const h = rng.range(0.5, 0.95);
    kit.pipe(M.metal, 0.1, h, vx, y + h / 2, vz, 6);
    const cap = new THREE.CylinderGeometry(0.19, 0.13, 0.13, 8);
    cap.translate(vx, y + h + 0.06, vz);
    kit.push(cap, M.metalDark);
  }

  // 天线（带横杆）
  const ax = ux + rng.range(-area.w * 0.3, area.w * 0.3);
  const az = cz + rng.range(-area.d * 0.3, area.d * 0.1);
  kit.pipe(M.metalDark, 0.04, rng.range(1.6, 2.4), ax, y + 1.1, az);
  for (let i = 0; i < 3; i += 1) {
    kit.rod(M.metalDark, 0.026, 0.8 - i * 0.16, ax, y + 1.5 + i * 0.26, az, 'x');
  }

  // 屋面瓦砾（instanced）
  const rubbleGeo = jitter(new THREE.DodecahedronGeometry(0.16, 0), 0.05, rng);
  const rubble: InstanceTransform[] = [];
  for (let i = 0; i < 16; i += 1) {
    rubble.push({
      position: new THREE.Vector3(
        ux + rng.range(-width * 0.46, width * 0.46),
        y + 0.08,
        cz + rng.range(-bd * 0.42, bd * 0.42),
      ),
      rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)),
      scale: new THREE.Vector3(1, 1, 1).multiplyScalar(rng.range(0.5, 1.3)),
    });
  }
  kit.instance(rubbleGeo, M.concreteDark, rubble);

  // 散落的杂物：木箱、旧桶、破布
  if (rng.chance(0.7)) {
    kit.tilt(M.woodDark, 0.55, 0.36, 0.42, ux + rng.range(-width * 0.35, width * 0.35), y + 0.18, cz + rng.range(-bd * 0.3, bd * 0.3), rng.range(-0.1, 0.1), rng.range(-0.1, 0.1));
  }
  if (rng.chance(0.6)) {
    const drum = new THREE.CylinderGeometry(0.28, 0.28, 0.72, 9);
    drum.rotateZ(rng.range(-0.1, 0.1));
    drum.translate(ux + rng.range(-width * 0.3, width * 0.3), y + 0.36, cz + rng.range(-bd * 0.3, bd * 0.3));
    kit.push(drum, M.rust, true);
  }
  void seed;
}


// ─────────────────────────── 招牌贴图 ───────────────────────────

const signCache = new Map<string, THREE.CanvasTexture>();

function signTexture(text: string, sub: string, bg: string, fg: string, font: string): THREE.CanvasTexture {
  const key = `${text}|${sub}|${bg}|${fg}`;
  const hit = signCache.get(key);
  if (hit) return hit;
  const tex = canvasTexture(320, 128, (c, w, h) => {
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);
    // 风化斑驳
    const r = createRng(key);
    c.globalAlpha = 0.22;
    for (let i = 0; i < 48; i += 1) {
      c.fillStyle = r.chance(0.55) ? '#101010' : '#e8e2d4';
      c.fillRect(r.range(0, w), r.range(0, h), r.range(3, 34), r.range(2, 9));
    }
    c.globalAlpha = 1;
    c.fillStyle = fg;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = font;
    c.fillText(text, w / 2, sub ? h * 0.4 : h * 0.52);
    if (sub) {
      c.font = '26px "Segoe UI",Arial,sans-serif';
      c.globalAlpha = 0.72;
      c.fillText(sub, w / 2, h * 0.76);
      c.globalAlpha = 1;
    }
    c.strokeStyle = fg;
    c.globalAlpha = 0.5;
    c.lineWidth = 4;
    c.strokeRect(6, 6, w - 12, h - 12);
  });
  signCache.set(key, tex);
  return tex;
}

/** 老钟表店/理发店的挂钟表盘 */
let clockTex: THREE.CanvasTexture | null = null;
function clockTexture(): THREE.CanvasTexture {
  if (clockTex) return clockTex;
  clockTex = canvasTexture(128, 128, (c, w, h) => {
    c.fillStyle = '#cfc6ae';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#2a251f';
    c.fillRect(0, 0, w, 6);
    c.fillRect(0, h - 6, w, 6);
    c.strokeStyle = '#2a251f';
    c.lineWidth = 5;
    c.beginPath();
    c.arc(w / 2, h / 2, 46, 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = '#2a251f';
    for (let i = 0; i < 12; i += 1) {
      const a = (i / 12) * Math.PI * 2;
      c.fillRect(w / 2 + Math.cos(a) * 38 - 1.5, h / 2 + Math.sin(a) * 38 - 1.5, 4, 4);
    }
    c.lineWidth = 4;
    c.beginPath();
    c.moveTo(w / 2, h / 2);
    c.lineTo(w / 2 + 22, h / 2 - 12);
    c.moveTo(w / 2, h / 2);
    c.lineTo(w / 2 - 8, h / 2 - 30);
    c.stroke();
    const r = createRng('clock-face');
    c.strokeStyle = 'rgba(30,26,22,0.55)';
    c.lineWidth = 2;
    for (let i = 0; i < 5; i += 1) {
      c.beginPath();
      c.moveTo(r.range(0, w), 0);
      let y = 0;
      let x = r.range(0, w);
      while (y < h) {
        x += r.range(-10, 10);
        y += r.range(8, 20);
        c.lineTo(x, y);
      }
      c.stroke();
    }
    c.globalAlpha = 0.3;
    c.fillStyle = '#12100d';
    c.fillRect(0, h * 0.72, w, h * 0.1);
    c.globalAlpha = 1;
  });
  return clockTex;
}

/** 挑出街面的招牌：一根铁臂 + 一块垂直于立面的双面牌子 */
function hangSign(kit: Kit, tex: THREE.Texture, x: number, y: number, w: number, h: number): void {
  kit.box(M.metalDark, 0.09, 0.09, 0.82, x, y + h / 2 + 0.16, 0.45);
  kit.box(M.metalDark, 0.06, 0.55, 0.06, x, y + h / 2 - 0.1, 0.08);
  kit.sign(tex, w, h, x, y, 0.58, Math.PI / 2);
}

// ─────────────────────────── 阳台 ───────────────────────────

/** 阳台：楼板 + 前挡板 + 两侧挡板；collapsed 时整体歪斜、栏杆吊着 */
function balcony(kit: Kit, x: number, y: number, w: number, collapsed: boolean): void {
  const depth = 0.95;
  const zc = depth / 2 + 0.05;
  if (!collapsed) {
    kit.box(M.concrete, w, 0.14, depth, x, y, zc);
    kit.box(M.trim, w, 0.78, 0.09, x, y + 0.46, depth + 0.02);
    kit.box(M.trim, 0.09, 0.78, depth, x - w / 2 + 0.04, y + 0.46, zc);
    kit.box(M.trim, 0.09, 0.78, depth, x + w / 2 - 0.04, y + 0.46, zc);
  } else {
    // 坍塌的阳台：楼板翘起，栏杆木板断成几截（暗色木料，不再是亮白抹灰）
    kit.tilt(M.concrete, w, 0.14, depth, x, y - 0.12, zc, -0.42, 0.05);
    // 断掉的木质栏板：几段长度不一的木板，歪斜垂下
    const plankCount = 3;
    for (let i = 0; i < plankCount; i += 1) {
      const pw = w * kit.rng.range(0.16, 0.34);
      kit.tilt(
        kit.rng.chance(0.5) ? M.wood : M.woodDark,
        pw,
        0.62,
        0.07,
        x + w * kit.rng.range(-0.34, 0.34),
        y - 0.48 - i * 0.12,
        depth - 0.12 - i * 0.1,
        kit.rng.range(0.28, 0.72),
        kit.rng.range(-0.5, 0.5),
      );
    }
    // 拉断的钢筋
    kit.box(M.rust, 0.05, 0.5, 0.05, x - w * 0.3, y + 0.2, depth - 0.05);
  }
}

// ─────────────────────────── 联排住宅 ───────────────────────────

/** 建筑背后的窄院 */
function backYard(kit: Kit, w: number, zFront: number, zBack: number): void {
  const rng = kit.rng;
  if (zFront - zBack < 2.4) return;
  fenceLine(kit, -w / 2, zBack, w / 2, zBack, 1.45, w * 0.3);
  const sx = -w * 0.26;
  const sw = Math.min(w * 0.42, 3.6);
  const sh = 2.1;
  for (const px of [sx - sw / 2, sx + sw / 2]) {
    kit.box(M.woodDark, 0.12, sh, 0.12, px, sh / 2, zFront - 1.7);
  }
  kit.tilt(M.roofRust, sw + 0.5, 0.12, 2.0, sx, sh + 0.08, zFront - 0.95, 0.16, 0);
  for (let r = 0; r < 3; r += 1) {
    kit.rod(M.wood, 0.1, sw * 0.9, sx + rng.range(-0.06, 0.06), 0.12 + r * 0.21, zFront - 2.3, 'x', 5);
  }
  kit.box(M.wood, 0.7, 0.6, 0.7, w * 0.3, 0.3, zBack + 1.1, rng.range(0, 0.5), true);
  for (let i = 0; i < 4; i += 1) {
    kit.rubbleAt(rng.range(-w * 0.45, w * 0.45), rng.range(0.05, 0.16), rng.range(zFront, zBack), rng.range(0.2, 0.45), rng.chance(0.6) ? M.dirt : M.brickDark);
  }
}

interface RowOpts {
  shopGround?: boolean;
  emergency?: boolean;
  /** 整栋改为战损平屋顶（拆除坡顶），并加外墙逃生梯 */
  flatRoof?: boolean;
  fireEscape?: boolean;
}

/**
 * 联排住宅：每个单元 = 核心体块 + 四面带洞口的立面皮。
 * 窗是真开洞 + 内退窗框 + 外挑窗台，所以远看也有立体层次。
 */
function buildRowhouse(kit: Kit, w: number, depth: number, floors: number, opts: RowOpts = {}): void {
  const rng = kit.rng;
  const unitCount = clamp(Math.round(w / 6.3), 1, 4);
  const unitW = w / unitCount;
  const g0 = 3.75;
  const up = 3.0;
  const bodyH = g0 + up * (floors - 1);
  const bd0 = Math.min(depth - 1.1, 10.8);
  const balconyU = rng.chance(0.75) ? rng.int(0, unitCount - 1) : -1;
  const chimneyU = rng.int(0, unitCount - 1);
  const dormerU = rng.chance(0.6) ? rng.int(0, unitCount - 1) : -1;
  const flatU = unitCount > 1 && rng.chance(0.4) ? rng.int(0, unitCount - 1) : -1;
  const emergencyU = opts.emergency ? rng.int(0, unitCount - 1) : -1;
  const T = 0.4; // 墙厚

  for (let u = 0; u < unitCount; u += 1) {
    const ux = -w / 2 + unitW * (u + 0.5);
    const wall = rng.pick(WALLS);
    const fz = unitCount > 1 ? rng.range(-0.28, 0.04) : 0;
    const bd = bd0 - rng.range(0, 1.1);
    const x0 = ux - unitW / 2 + 0.03;
    const x1 = ux + unitW / 2 - 0.03;
    const zF = fz; // 临街面
    const zB = fz - bd; // 背面
    const leftSkin = u === 0;
    const rightSkin = u === unitCount - 1;
    const width = x1 - x0;

    // —— 核心体块（比四面皮薄一圈，形成真正的墙厚）——
    const cx0 = x0 + (leftSkin ? T : 0);
    const cx1 = x1 - (rightSkin ? T : 0);
    kit.box(wall, cx1 - cx0, bodyH, bd - 2 * T, (cx0 + cx1) / 2, bodyH / 2, (zF + zB) / 2, 0, true);

    // —— 正面立面 ——
    const front: Facade = { mat: wall, cx: ux, cz: zF, a: 0, w: width, y0: 0, y1: bodyH, t: T, openings: [] };
    const cols = unitW > 5.6 ? 2 : 1;
    for (let f = 0; f < floors; f += 1) {
      const fy = f === 0 ? 0 : g0 + up * (f - 1);
      const fh = f === 0 ? g0 : up;
      for (let c = 0; c < cols; c += 1) {
        const ox = ux + (cols === 1 ? 0 : (c - 0.5) * unitW * 0.44);
        if (f === 0 && opts.shopGround && u === 0) {
          if (c === 0) {
            front.openings.push({ u: ox - ux, v: 1.62, w: unitW * 0.5, h: 2.26, kind: 'shop' });
          } else {
            front.openings.push({ u: ox - ux, v: 1.15, w: 1.16, h: 2.24, kind: 'door' });
          }
          continue;
        }
        if (f === 0 && c === 0) {
          front.openings.push({ u: ox - ux, v: 1.15, w: 1.16, h: 2.24, kind: 'door' });
          continue;
        }
        const ww = f === 0 ? 1.3 : 1.08;
        const wh = f === 0 ? 1.55 : 1.38;
        const variant = rng.next();
        const emerg = u === emergencyU && f === 1 && c === 0;
        front.openings.push({
          u: ox - ux,
          v: fy + fh * 0.56 + (f === 0 ? 0.12 : 0),
          w: ww,
          h: wh,
          kind: 'window',
          lit: emerg || variant > 0.955,
          cold: !emerg && variant > 0.955,
          emerg,
          broken: variant > 0.9 && variant <= 0.955,
          boarded: f > 0 && rng.chance(0.12),
        });
      }
    }
    buildFacade(kit, front);
    facadeGrime(kit, front, kit.tier === 'near' ? 6 : kit.tier === 'mid' ? 3 : 1);
    facadeBands(kit, front, [g0, g0 + up].filter((y) => y < bodyH - 0.4), g0 * 0.42);
    facadeEave(kit, front, bodyH);
    if (kit.tier !== 'far') {
      facadeDownpipe(kit, front, width / 2 - 0.14, bodyH - 0.3);
      if (rng.chance(0.55)) facadeAC(kit, front, rng.range(-width * 0.3, width * 0.3), g0 + up * (floors - 1) + 0.6);
    }

    // 底层小杂货铺的招牌与遮雨棚
    if (opts.shopGround && u === 0) {
      const shopOp = front.openings.find((o) => o.kind === 'shop');
      if (shopOp) {
        kit.box(M.woodDark, shopOp.w + 0.5, 0.6, 0.18, shopOp.u + ux, 3.28, zF + 0.12);
        kit.sign(
          signTexture('ЛАВКА', '杂货 · 24ч', '#241f1a', '#d3c8aa', 'bold 50px "Segoe UI",Arial,sans-serif'),
          shopOp.w + 0.34,
          0.5,
          shopOp.u + ux,
          3.28,
          zF + 0.22,
          0,
          0.05,
        );
        kit.tilt(M.metalDark, shopOp.w + 0.6, 0.1, 0.9, shopOp.u + ux, 2.68, zF + 0.45, 0.12, 0);
      }
      if (kit.detail > 0.6) {
        kit.lights.push({ pos: kit.world(front.openings[0]?.u ?? 0, 2.4, 1.1), color: PALETTE.warmLight, intensity: 5, distance: 6.5 });
      }
    }

    // —— 背面立面 ——
    const back: Facade = { mat: wall, cx: ux, cz: zB, a: Math.PI, w: width, y0: 0, y1: bodyH, t: T, openings: [] };
    for (let f = 1; f < floors; f += 1) {
      const by = g0 + up * (f - 1) + up * 0.57;
      for (const off of [-0.22, 0.22]) {
        back.openings.push({
          u: unitW * off,
          v: by,
          w: 0.96,
          h: 1.28,
          kind: 'window',
          lit: rng.chance(0.05),
          broken: rng.chance(0.2),
        });
      }
    }
    buildFacade(kit, back);
    if (kit.tier === 'near') {
      facadeGrime(kit, back, 3);
      weatherFacade(kit, back, { grime: 0, peels: 1, clusters: 0 });
    }

    // —— 侧立面 ——
    const side = (skin: boolean, a: number, sx: number): void => {
      if (!skin) return;
      const sf: Facade = { mat: wall, cx: sx, cz: (zF + zB) / 2, a, w: bd - T, y0: 0, y1: bodyH, t: T, openings: [] };
      for (let f = 0; f < floors; f += 1) {
        const fy = f === 0 ? 0 : g0 + up * (f - 1);
        const fh = f === 0 ? g0 : up;
        for (const off of [-0.24, 0.24]) {
          sf.openings.push({
            u: (bd - T) * off,
            v: fy + fh * 0.57,
            w: f === 0 ? 1.16 : 1.02,
            h: f === 0 ? 1.44 : 1.3,
            kind: 'window',
            lit: rng.chance(0.04),
            broken: rng.chance(0.18),
            boarded: rng.chance(0.08),
          });
        }
      }
      buildFacade(kit, sf);
      facadeGrime(kit, sf, kit.tier === 'near' ? 3 : 1);
      facadeBands(kit, sf, [g0], g0 * 0.42);
      facadeEave(kit, sf, bodyH);
    };
    side(leftSkin, -Math.PI / 2, x0);
    side(rightSkin, Math.PI / 2, x1);

    // —— 屋顶 ——
    const rise = clamp(bd * 0.2, 1.25, 2.3) + rng.range(-0.15, 0.25);
    const rd = bd + 0.9;
    const a = Math.atan2(rise, rd / 2);
    const rmat = rng.chance(0.42) ? M.roofRust : rng.chance(0.35) ? M.roofDark : M.roof;
    const tmat = rmat === M.roofRust ? M.tileRust : rmat === M.roofDark ? M.tileDark : M.tile;
    if (opts.flatRoof) {
      // —— 战损平屋顶：拆掉坡顶，改平顶 + 破损女儿墙 + 屋顶杂物 ——
      flatRoofDamaged(kit, ux, zF, zB, width, bodyH, wall, u);
    } else if (u !== flatU) {
      kit.gable(wall, width - 0.04, rise, rd, ux, bodyH, (zF + zB) / 2);
      for (const s of [1, -1] as const) {
        const g = new THREE.BoxGeometry(width + 0.5, 0.16, Math.hypot(rd / 2, rise) + 0.3);
        g.rotateX(s * a);
        g.translate(ux, bodyH + rise / 2 + 0.06, (zF + zB) / 2 + (s * rd) / 4);
        kit.push(g, rmat, true);
      }
      if (kit.tier !== 'far') {
        roofTiles(kit, ux, (zF + zB) / 2, width + 0.34, rise + 0.1, rd, bodyH, tmat);
      } else {
        for (const s of [1, -1] as const) {
          for (let k = 0; k < 4; k += 1) {
            const t = (k + 0.5) / 4;
            const g2 = new THREE.BoxGeometry(width + 0.42, 0.09, 0.22);
            g2.rotateX(s * a);
            g2.translate(ux, bodyH + rise * t + Math.cos(a) * 0.1, (zF + zB) / 2 + s * (rd / 2) * (1 - t));
            kit.push(g2, rmat);
          }
        }
      }
      kit.box(rmat, width + 0.56, 0.16, 0.44, ux, bodyH + rise + 0.05, (zF + zB) / 2, 0, true);
      // 屋瓦缺失
      if (rng.chance(0.65)) {
        const gx = ux + rng.range(-width * 0.3, width * 0.3);
        kit.tilt(M.burnt, 0.9, 0.1, 0.7, gx, bodyH + rise * 0.45 + 0.16, (zF + zB) / 2 + rd * 0.22, a, 0, false);
      }
      // 老虎窗
      if (u === dormerU) {
        const t = 0.4;
        const py = bodyH + rise * t;
        const pz = (zF + zB) / 2 + (rd / 2) * (1 - t);
        const dh = 1.05;
        kit.box(wall, 1.2, dh, 1.15, ux, py + dh * 0.42, pz + 0.1, 0, true);
        kit.tilt(rmat, 1.5, 0.12, 1.45, ux, py + dh * 0.42 + dh / 2 + 0.06, pz + 0.1, 0.2, 0);
        const dg: Facade = { mat: wall, cx: ux, cz: pz + 0.68, a: 0, w: 0.72, y0: py + 0.15, y1: py + 0.9, t: 0.3, openings: [] };
        dg.openings.push({ u: 0, v: py + 0.52, w: 0.62, h: 0.66, kind: 'window', broken: true });
        buildFacade(kit, dg);
      }
    } else {
      // 平屋顶：女儿墙 + 压顶 + 楼顶杂物
      kit.box(M.roofDark, width, 0.2, bd, ux, bodyH + 0.05, (zF + zB) / 2, 0, true);
      kit.box(wall, width, 0.62, 0.26, ux, bodyH + 0.36, zF - 0.13);
      kit.box(M.trim, width + 0.08, 0.12, 0.34, ux, bodyH + 0.72, zF - 0.13);
      kit.box(wall, 0.24, 0.62, bd, x0 + 0.12, bodyH + 0.36, (zF + zB) / 2);
      kit.box(wall, 0.24, 0.62, bd, x1 - 0.12, bodyH + 0.36, (zF + zB) / 2);
      kit.box(M.trim, 0.32, 0.12, bd, x0 + 0.12, bodyH + 0.72, (zF + zB) / 2);
      kit.box(M.trim, 0.32, 0.12, bd, x1 - 0.12, bodyH + 0.72, (zF + zB) / 2);
      if (kit.tier !== 'far') {
        roofClutter(kit, { x: ux, z: (zF + zB) / 2, w: width, d: bd }, bodyH + 0.16);
      }
    }

    // 阳台
    if (u === balconyU && floors >= 3) {
      const bx = ux + unitW * 0.16;
      balcony(kit, bx, g0 + up * 0.06, Math.min(2.2, unitW * 0.72), rng.chance(0.5) || kit.detail < 0.6);
    }

    // 烟囱
    if (u === chimneyU) {
      const cx2 = ux + rng.range(-unitW * 0.25, unitW * 0.25);
      const ch = 1.5 + rng.range(0, 0.5);
      // 平顶时烟囱直接从屋面立起；坡顶时立在山墙中段
      const cy = u === flatU || opts.flatRoof ? bodyH : bodyH + rise * 0.5;
      kit.box(M.brickDark, 0.6, ch, 0.6, cx2, cy + ch / 2, (zF + zB) / 2, 0, true);
      kit.box(M.concreteDark, 0.78, 0.12, 0.78, cx2, cy + ch + 0.06, (zF + zB) / 2);
      kit.box(M.burnt, 0.3, 0.1, 0.3, cx2, cy + ch + 0.13, (zF + zB) / 2);
    }

    // —— 外墙逃生梯（Z 字形金属梯）——
    if (opts.fireEscape && kit.tier !== 'far') {
      // 装在**临街面**偏一侧：站在街上就能看见完整的 Z 字金属梯
      const escU = -width * 0.22;
      const escFacade: Facade = { mat: wall, cx: ux, cz: zF, a: 0, w: width, y0: 0, y1: bodyH, t: T, openings: [] };
      // 平台高度对齐各层窗台（层高 up，首层窗台在 g0）
      facadeFireEscape(kit, escFacade, escU, floors - 1, up, g0 + 0.45, u + 1);
    }

    // —— 战损 ——
    const peels = kit.tier === 'near' ? 2 : kit.tier === 'mid' ? 1 : 1;
    for (let i = 0; i < peels; i += 1) {
      peelPatch(kit, front, rng.range(-width * 0.42, width * 0.42), rng.range(1.0, bodyH - 0.7), rng.range(0.8, 1.7), rng.range(0.7, 1.4));
    }
    if (kit.tier === 'near') {
      peelPatch(kit, back, rng.range(-width * 0.4, width * 0.4), rng.range(1.0, bodyH - 0.7), rng.range(0.7, 1.4), rng.range(0.6, 1.2));
    }
    const clusters = kit.tier === 'far' ? 0 : kit.tier === 'near' ? 2 : 1;
    for (let i = 0; i < clusters; i += 1) {
      bulletCluster(kit, front, rng.range(-width * 0.4, width * 0.4), rng.range(1.2, bodyH - 0.8));
    }
    const rubble = Math.round(4 + kit.detail * 8);
    for (let i = 0; i < rubble; i += 1) {
      kit.rubbleAt(rng.range(-w * 0.5, w * 0.5), rng.range(0.05, 0.2), rng.range(0.2, 1.2), rng.range(0.22, 0.55), rng.chance(0.6) ? M.dirt : M.brickDark);
    }
    if (kit.detail > 0.75 && rng.chance(0.8)) {
      kit.lights.push({
        pos: kit.world(rng.range(-w * 0.3, w * 0.3), g0 + up * 0.6, 0.9),
        color: PALETTE.warmLight,
        intensity: 5.5,
        distance: 7.5,
      });
    }
  }

  if (depth - bd0 > 3.2) {
    backYard(kit, w, -bd0 - 0.35, -depth + 0.4);
  }
}

// ─────────────────────────── 板式公寓 ───────────────────────────

function buildApartment(kit: Kit, w: number, depth: number, floors: number, clock = false): void {
  const rng = kit.rng;
  const base = 0.62;
  const fh = 2.9;
  const H = base + fh * floors;
  const bw = w;
  const bd = Math.min(depth - 1.0, 12.6);
  const wall = rng.chance(0.45) ? M.brick : M.plasterCold;
  const zc = -bd / 2;
  const T = 0.45;

  // 核心体块
  kit.box(wall, bw - T * 2, H, bd - T * 2, 0, H / 2, zc, 0, true);

  const cols = clamp(Math.round(bw / 2.85), 3, 6);
  const step = bw / cols;

  // —— 正面 ——
  const front: Facade = { mat: wall, cx: 0, cz: 0, a: 0, w: bw, y0: 0, y1: H, t: T, openings: [] };
  for (let f = 0; f < floors; f += 1) {
    const wy = base + fh * f + fh * 0.6;
    for (let c = 0; c < cols; c += 1) {
      const x = -bw / 2 + step * (c + 0.5);
      if (clock && f === 0 && c === 0) continue;
      if (f === 0 && (c === 1 || c === cols - 2)) {
        front.openings.push({ u: x, v: 1.12, w: 1.3, h: 2.2, kind: 'door' });
        continue;
      }
      const r = rng.next();
      front.openings.push({
        u: x,
        v: wy,
        w: 1.22,
        h: 1.46,
        kind: 'window',
        lit: r > 0.965,
        cold: r > 0.985,
        broken: r > 0.9 && r <= 0.965,
        boarded: r > 0.8 && r <= 0.9,
      });
    }
  }
  buildFacade(kit, front);
  facadeGrime(kit, front, kit.tier === 'near' ? 7 : kit.tier === 'mid' ? 4 : 2);
  // 竖向壁柱，打破大平墙
  for (let c = 0; c <= cols; c += 1) {
    const x = clamp(-bw / 2 + c * step, -bw / 2 + 0.14, bw / 2 - 0.14);
    faceBox(kit, front, M.concrete, x, base + (H - base) / 2, 0.08, 0.26, H - base, 0.16);
  }
  facadeBands(kit, front, [base + fh, base + fh * 2, base + fh * 3].filter((y) => y < H - 0.5), base * 0.9);
  facadeEave(kit, front, H);
  if (kit.tier !== 'far') {
    facadeDownpipe(kit, front, -bw / 2 + 0.3, H - 0.3);
    facadeDownpipe(kit, front, bw / 2 - 0.3, H - 0.3);
  }

  // —— 侧面 ——
  for (const s of [-1, 1] as const) {
    const side: Facade = { mat: wall, cx: (s * bw) / 2, cz: zc, a: (s * Math.PI) / 2, w: bd - T, y0: 0, y1: H, t: T, openings: [] };
    for (let f = 0; f < floors; f += 1) {
      const wy = base + fh * f + fh * 0.6;
      for (const off of [-0.26, 0.26]) {
        const r = rng.next();
        side.openings.push({
          u: (bd - T) * off,
          v: wy,
          w: 1.1,
          h: 1.4,
          kind: 'window',
          lit: r > 0.97,
          broken: r > 0.9,
          boarded: r > 0.86 && r <= 0.9,
        });
      }
    }
    buildFacade(kit, side);
    facadeBands(kit, side, [base + fh, base + fh * 2, base + fh * 3].filter((y) => y < H - 0.5), base * 0.9);
    facadeEave(kit, side, H);
    if (kit.tier !== 'far' && rng.chance(0.6)) facadeAC(kit, side, rng.range(-bd * 0.25, bd * 0.25), base + fh * (floors - 1) + 0.7);
  }

  // —— 背面 ——
  const rear: Facade = { mat: wall, cx: 0, cz: -bd, a: Math.PI, w: bw - T * 2, y0: 0, y1: H, t: T, openings: [] };
  for (let f = 0; f < floors; f += 1) {
    const wy = base + fh * f + fh * 0.6;
    for (let c = 0; c < cols; c += 1) {
      const r = rng.next();
      rear.openings.push({
        u: -bw / 2 + step * (c + 0.5),
        v: wy,
        w: 1.1,
        h: 1.38,
        kind: 'window',
        lit: r > 0.98,
        broken: r > 0.88,
      });
    }
  }
  buildFacade(kit, rear);

  // 阳台列
  for (let c = 1; c < cols; c += 2) {
    const x = -bw / 2 + step * (c + 0.5);
    for (let f = 1; f < floors; f += 1) {
      const wy = base + fh * f + fh * 0.06;
      balcony(kit, x, wy, Math.min(2.4, step * 0.86), rng.chance(0.22));
    }
  }

  // 街头挂钟
  if (clock) {
    hangSign(kit, clockTexture(), -bw / 2 + 1.35, 3.5, 1.0, 1.15);
    kit.box(M.brickDark, 2.35, 2.6, 0.24, -bw / 2 + 1.1, 1.3, 0.06, 0, true);
    kit.quad(M.glassBroken, 1.6, 1.55, -bw / 2 + 1.1, 1.52, 0.2);
    kit.box(M.trimDark, 1.75, 0.08, 0.1, -bw / 2 + 1.1, 1.52, 0.21);
  }

  // 屋顶：女儿墙 + 压顶 + 楼梯间 + 水箱 + 天线 + 通风管
  kit.box(M.roofDark, bw - T, 0.22, bd - T, 0, H + 0.06, zc, 0, true);
  const pt = 0.72;
  kit.box(M.concrete, bw, pt, 0.28, 0, H + pt / 2, -0.14);
  kit.box(M.concrete, bw, pt, 0.28, 0, H + pt / 2, -bd + 0.14);
  kit.box(M.concrete, 0.28, pt, bd, -bw / 2 + 0.14, H + pt / 2, zc);
  kit.box(M.concrete, 0.28, pt, bd, bw / 2 - 0.14, H + pt / 2, zc);
  kit.box(M.trim, bw + 0.06, 0.11, 0.36, 0, H + pt + 0.05, -0.14);
  kit.box(M.trim, bw + 0.06, 0.11, 0.36, 0, H + pt + 0.05, -bd + 0.14);
  kit.box(M.trim, 0.36, 0.11, bd + 0.06, -bw / 2 + 0.14, H + pt + 0.05, zc);
  kit.box(M.trim, 0.36, 0.11, bd + 0.06, bw / 2 - 0.14, H + pt + 0.05, zc);

  const bulkX = -bw * 0.22;
  kit.box(wall, 2.9, 2.25, 3.1, bulkX, H + 1.14, zc - 1.2, 0, true);
  kit.box(M.metalDark, 1.0, 1.85, 0.1, bulkX, H + 0.95, zc + 0.4);
  kit.box(M.concreteDark, 3.2, 0.16, 3.4, bulkX, H + 2.36, zc - 1.2);
  if (kit.tier !== 'far') {
    roofClutter(kit, { x: 0, z: zc, w: bw - 1, d: bd - 1 }, H + 0.2);
  }

  // 战损
  const peels = kit.tier === 'near' ? 3 : kit.tier === 'mid' ? 2 : 1;
  for (let i = 0; i < peels; i += 1) {
    peelPatch(kit, front, rng.range(-bw * 0.42, bw * 0.42), rng.range(1.5, H - 1), rng.range(1.0, 2.0), rng.range(0.8, 1.6));
  }
  const clusters = kit.tier === 'far' ? 0 : kit.tier === 'near' ? 2 : 1;
  for (let i = 0; i < clusters; i += 1) {
    bulletCluster(kit, front, rng.range(-bw * 0.44, bw * 0.44), rng.range(1.4, H - 1));
  }
  for (let i = 0; i < 8; i += 1) {
    kit.rubbleAt(rng.range(-bw * 0.5, bw * 0.5), rng.range(0.05, 0.2), rng.range(0.2, 1.4), rng.range(0.24, 0.6), rng.chance(0.55) ? M.dirt : M.concreteDark);
  }
}

// ─────────────────────────── 两层商铺 ───────────────────────────

function buildShopRow(kit: Kit, w: number, depth: number, floors: number): void {
  const rng = kit.rng;
  const unitCount = clamp(Math.round(w / 5.6), 1, 3);
  const unitW = w / unitCount;
  const g0 = 4.15;
  const up = 3.2;
  const bodyH = g0 + up * (floors - 1);
  const bd = Math.min(depth - 1.0, 9.6);
  const T = 0.42;
  const signTexts: Array<[string, string, string, string, string]> = [
    ['ХЛЕБ', 'БУЛОЧНАЯ · 面包', '#2f2a24', '#d8cfb6', 'bold 54px "Segoe UI",Arial,sans-serif'],
    ['ПРОДУКТЫ', 'ПРОДУКТЫ 24ч', '#1f2a24', '#c9c2a8', 'bold 46px "Segoe UI",Arial,sans-serif'],
    ['五金杂货', 'ПЯТАК · 五金', '#2a2320', '#cdbf9c', 'bold 58px "Microsoft YaHei","Segoe UI",sans-serif'],
  ];

  for (let u = 0; u < unitCount; u += 1) {
    const ux = -w / 2 + unitW * (u + 0.5);
    const wall = rng.chance(0.35) ? M.plasterWarm : rng.pick(WALLS);
    const fz = rng.range(-0.12, 0.05);
    const zF = fz;
    const zB = zF - bd;
    const x0 = ux - unitW / 2 + 0.04;
    const x1 = ux + unitW / 2 - 0.04;
    const width = x1 - x0;
    const leftSkin = u === 0;
    const rightSkin = u === unitCount - 1;

    // 核心
    kit.box(
      wall,
      width - (leftSkin ? T : 0) - (rightSkin ? T : 0),
      bodyH,
      bd - 2 * T,
      ux,
      bodyH / 2,
      (zF + zB) / 2,
      0,
      true,
    );

    // —— 正面立面 ——
    const front: Facade = { mat: wall, cx: ux, cz: zF, a: 0, w: width, y0: 0, y1: bodyH, t: T, openings: [] };
    const winW = unitW * 0.56;
    const winX = ux - unitW * 0.1;
    front.openings.push({ u: winX - ux, v: 1.66, w: winW, h: 2.34, kind: 'shop' });
    front.openings.push({ u: unitW * 0.33, v: 1.15, w: 1.0, h: 2.2, kind: 'door' });
    if (floors >= 2) {
      const wcols = unitW > 5.4 ? 3 : 2;
      for (let c = 0; c < wcols; c += 1) {
        const x = ux + (c - (wcols - 1) / 2) * unitW * 0.32;
        const r = rng.next();
        front.openings.push({
          u: x - ux,
          v: g0 + up * 0.55,
          w: 1.04,
          h: 1.36,
          kind: 'window',
          lit: r > 0.965,
          broken: r > 0.9,
          boarded: r > 0.8 && r <= 0.9,
        });
      }
    }
    buildFacade(kit, front);
    facadeBands(kit, front, [g0].filter((y) => y < bodyH - 0.4), g0 * 0.3);
    facadeEave(kit, front, bodyH);

    // 平屋顶 + 女儿墙 + 压顶
    kit.box(M.roofDark, width, 0.2, bd, ux, bodyH + 0.05, (zF + zB) / 2, 0, true);
    kit.box(wall, width + 0.1, 0.66, 0.26, ux, bodyH + 0.33, zF - 0.13);
    kit.box(M.trim, width + 0.16, 0.12, 0.34, ux, bodyH + 0.68, zF - 0.13);
    if (kit.tier !== 'far') {
      roofClutter(kit, { x: ux, z: (zF + zB) / 2, w: width, d: bd }, bodyH + 0.16);
    }

    // 雨棚
    const torn = rng.chance(0.5) || kit.detail < 0.55;
    const ap = facePoint(front, winX - ux, 3.02, 0.55);
    kit.tilt(torn ? M.tarp : M.fabric, winW + 0.5, 0.1, 1.15, ap.x, ap.y, ap.z, 0.32, 0);
    if (torn) {
      const tp = facePoint(front, winX - ux + winW * 0.42, 2.66, 0.62);
      kit.tilt(M.tarp, winW * 0.4, 0.09, 0.9, tp.x, tp.y, tp.z, 0.95, 0.2);
    }

    // 招牌
    const signW = unitW * 0.78;
    const signY = bodyH - 0.86;
    kit.box(M.woodDark, signW + 0.24, 0.92, 0.16, ux, signY, zF + 0.14);
    if (u < signTexts.length) {
      const [t1, t2, bg, fg, font] = signTexts[u] as [string, string, string, string, string];
      const tex = signTexture(t1, t2, bg, fg, font);
      const hung = rng.chance(0.35);
      kit.sign(tex, signW, 0.8, ux, signY + (hung ? -0.15 : 0), zF + 0.23, 0, hung ? 0.16 : 0);
    }
    if (u === 0) {
      hangSign(kit, signTexture('ПИВО', '', '#1d2420', '#cfc3a2', 'bold 54px "Segoe UI",Arial,sans-serif'), ux - unitW * 0.44, 3.55, 0.8, 0.95);
    }

    // 侧立面
    const side = (skin: boolean, a: number, sx: number): void => {
      if (!skin) return;
      const sf: Facade = { mat: wall, cx: sx, cz: (zF + zB) / 2, a, w: bd - T, y0: 0, y1: bodyH, t: T, openings: [] };
      for (let f = 0; f < floors; f += 1) {
        for (const off of [-0.24, 0.24]) {
          sf.openings.push({
            u: (bd - T) * off,
            v: f === 0 ? g0 * 0.55 : g0 + up * 0.55,
            w: 1.02,
            h: 1.32,
            kind: 'window',
            lit: rng.chance(0.05),
            broken: rng.chance(0.2),
            boarded: rng.chance(0.08),
          });
        }
      }
      buildFacade(kit, sf);
      facadeGrime(kit, sf, kit.tier === 'near' ? 3 : 1);
      facadeEave(kit, sf, bodyH);
    };
    side(leftSkin, -Math.PI / 2, x0);
    side(rightSkin, Math.PI / 2, x1);

    if (u === 0) facadeDownpipe(kit, front, -width / 2 + 0.14, bodyH - 0.4);
  }

  // 卷帘门
  if (unitCount >= 2) {
    const ux = -w / 2 + unitW * 0.5;
    const winW = unitW * 0.56;
    const winX = ux - unitW * 0.1;
    // 少数门体只拉下一半、导轨变形：这类被抽成独立件，才能在风里晃（合批后无法单独动）
    const swayable = kit.tier !== 'far' && kit.shutters.length < 14 && rng.chance(0.34);
    if (swayable) {
      const slats: number[] = [];
      for (let i = 0; i < 6; i += 1) slats.push(0.6 + i * 0.31);
      kit.shutters.push({ plot: kit.plotIndex, mat: M.metal, w: winW + 0.1, x: winX, slats, bent: rng.range(-0.05, 0.05) });
    } else {
      for (let i = 0; i < 6; i += 1) {
        kit.box(M.metal, winW + 0.1, 0.28, 0.09, winX, 0.6 + i * 0.31, 0.12);
      }
    }
    kit.box(M.metalDark, winW + 0.18, 0.16, 0.16, winX, 2.44, 0.13);
    kit.box(M.rust, winW * 0.3, 0.3, 0.11, winX + winW * 0.2, 1.1, 0.16);
  }

  // 战损
  const damage: Facade = { mat: M.plaster, cx: 0, cz: 0, a: 0, w, y0: 0, y1: bodyH, t: T, openings: [] };
  const peels = kit.tier === 'near' ? 3 : kit.tier === 'mid' ? 2 : 1;
  for (let i = 0; i < peels; i += 1) {
    peelPatch(kit, damage, rng.range(-w * 0.42, w * 0.42), rng.range(1.4, bodyH - 0.6), rng.range(1.0, 2.0), rng.range(0.8, 1.4));
  }
  const clusters = kit.tier === 'far' ? 0 : kit.tier === 'near' ? 2 : 1;
  for (let i = 0; i < clusters; i += 1) {
    bulletCluster(kit, damage, rng.range(-w * 0.42, w * 0.42), rng.range(1.4, bodyH - 0.6));
  }
  for (let i = 0; i < 7; i += 1) {
    kit.rubbleAt(rng.range(-w * 0.5, w * 0.5), rng.range(0.05, 0.2), rng.range(0.25, 1.3), rng.range(0.2, 0.5), rng.chance(0.5) ? M.dirt : M.brickDark);
  }
  if (kit.detail > 0.7) {
    kit.lights.push({ pos: kit.world(0, 2.1, 1.5), color: PALETTE.warmLight, intensity: 6.5, distance: 8 });
  }
}

// ─────────────────────────── 铁皮车库 / 棚屋 ───────────────────────────

function buildShed(kit: Kit, w: number, depth: number): void {
  const rng = kit.rng;
  const gw = Math.min(w * 0.55, 6.4);
  const gd = Math.min(depth * 0.62, 5.2);
  const gh = 2.9;
  const gx = -w / 2 + gw / 2 + 0.2;

  kit.box(M.metal, gw, gh, gd, gx, gh / 2, -gd / 2, 0, true);
  kit.box(M.concreteDark, gw + 0.2, 0.22, gd + 0.2, gx, 0.11, -gd / 2);
  kit.tilt(M.roofRust, gw + 0.7, 0.14, gd + 0.7, gx, gh + 0.16, -gd / 2, 0.06, 0);
  for (let i = 0; i < 6; i += 1) {
    kit.box(M.rustDark, 0.1, 0.06, gd + 0.66, gx - gw / 2 + (i + 0.5) * ((gw + 0.4) / 6), gh + 0.24, -gd / 2, 0, false);
  }
  kit.box(M.metalDark, gw * 0.78, 2.3, 0.12, gx, 1.15, 0.06);
  kit.tilt(M.rust, gw * 0.38, 2.15, 0.1, gx - gw * 0.18, 1.1, 0.4, 0, -0.22);
  kit.box(M.metalDark, 0.16, 2.3, 0.18, gx + gw * 0.4, 1.15, 0.1);
  kit.box(M.board, 0.7, 0.34, 0.07, gx + gw * 0.2, 2.62, 0.1);

  const lx = gx + gw / 2 + 1.55;
  const lw = Math.min(w - gw - 0.9, 3.6);
  if (lw > 1.6) {
    const lz = -1.2;
    const lh = 2.45;
    for (const [px, pz] of [[lx - lw / 2, lz - 0.1], [lx + lw / 2, lz - 0.1], [lx - lw / 2, lz - 2.6], [lx + lw / 2, lz - 2.6]] as Array<[number, number]>) {
      kit.box(M.woodDark, 0.13, lh, 0.13, px, lh / 2, pz);
    }
    kit.tilt(M.roofRust, lw + 0.4, 0.12, 2.9, lx, lh + 0.06, lz - 1.35, 0.12, 0);
    for (let r = 0; r < 3; r += 1) {
      for (let i = 0; i < 4; i += 1) {
        kit.rod(r % 2 === 0 ? M.wood : M.woodDark, 0.1, lw * 0.86, lx + rng.range(-0.06, 0.06), 0.13 + r * 0.22, lz - 1.05 - i * 0.33, 'x', 5);
      }
    }
  }

  fenceLine(kit, gx + gw / 2 + 0.35, 0.05, w / 2, 0.05, 1.5, 0);
  fenceLine(kit, w / 2, 0.05, w / 2, -depth + 0.4, 1.5, 0);

  const drumX = -w / 2 + 0.9;
  const drum = new THREE.CylinderGeometry(0.36, 0.36, 0.92, 8, 1, false);
  drum.translate(drumX, 0.46, -2.4);
  kit.push(drum, M.barrel, true);
  kit.box(M.wood, 0.8, 0.7, 0.8, w / 2 - 1.1, 0.35, -1.6, rng.range(0, 0.5), true);
  kit.tilt(M.woodDark, 0.6, 0.5, 0.6, w / 2 - 1.9, 0.25, -2.6, 0, 0.14, true);

  if (kit.detail > 0.5) {
    for (let i = 0; i < 2; i += 1) {
      const t = new THREE.TorusGeometry(0.34, 0.13, 5, 8);
      t.rotateX(Math.PI / 2);
      t.translate(-w / 2 + 1.7, 0.14 + i * 0.26, -3.6);
      kit.push(t, M.tire);
    }
  }

  for (let i = 0; i < 4; i += 1) {
    kit.hole(M.soot, rng.range(0.06, 0.13), gx + rng.range(-gw * 0.4, gw * 0.4), rng.range(0.8, gh - 0.3), 0.09);
    kit.rubbleAt(rng.range(-w * 0.5, w * 0.5), rng.range(0.05, 0.18), rng.range(0.3, 1.6), rng.range(0.2, 0.6), rng.chance(0.5) ? M.dirt : M.rustDark);
  }
  kit.patch(M.soot, 1.6, 1.4, gx, 1.5, 0.07, 0.08);
}

// ─────────────────────────── 半塌窄楼 ───────────────────────────

function buildRuin(kit: Kit, w: number, depth: number): void {
  const rng = kit.rng;
  const wall = rng.chance(0.5) ? M.brickDark : M.plasterPeel;
  const th = 0.4;
  const fh = 3.3;
  const topY = fh * 2 + 0.6;

  kit.box(M.soot, w - 0.5, topY - 0.8, 1.6, 0, (topY - 0.8) / 2, -1.3);

  const piers = [-w / 2 + th / 2, 0, w / 2 - th / 2];
  const pW = th;
  const bands: Array<[number, number]> = [
    [0, 1.05],
    [fh - 0.5, fh + 0.35],
    [fh * 2 - 0.4, topY],
  ];
  for (const bx of piers) {
    for (const [y0, y1] of bands) {
      const hh = y1 - y0;
      kit.box(wall, pW, hh, th, bx, y0 + hh / 2, -th / 2, 0, true);
    }
  }
  for (const s of [-1, 1] as const) {
    const bx = s * (w / 4);
    kit.box(wall, pW * 0.8, fh - 1.2, th, bx, 1.05 + (fh - 1.2) / 2, -th / 2, 0, true);
    kit.box(wall, pW * 0.7, fh - 1.9, th, bx, fh + 0.35 + (fh - 1.9) / 2, -th / 2, 0, true);
  }
  for (let i = 0; i < 5; i += 1) {
    const segW = w / 5;
    const sx = -w / 2 + segW * (i + 0.5);
    const sh = rng.range(0.4, 1.1);
    kit.box(wall, segW * 1.02, sh, th, sx, topY + sh / 2 - 0.1, -th / 2, 0, true);
  }
  for (const s of [-1, 1] as const) {
    const sx = s * (w / 2 - th / 2);
    for (let i = 0; i < 4; i += 1) {
      const segD = (depth - 1) / 4;
      const sz = -0.2 - segD * (i + 0.5);
      const hh = fh * 2 * (1 - i * 0.19) + rng.range(-0.3, 0.4);
      kit.box(wall, th, hh, segD * 1.02, sx, hh / 2, sz, 0, true);
    }
  }
  kit.box(wall, w * 0.55, 2.2, th, -w * 0.18, 1.1, -depth + 0.6, 0, true);
  kit.box(wall, w * 0.3, 3.4, th, w * 0.3, 1.7, -depth + 0.6, 0, true);

  const stairX = 0;
  for (let i = 0; i < 9; i += 1) {
    const sy = 0.22 + i * 0.36;
    const sz = -2.3 - i * 0.36;
    kit.box(M.concreteDark, 1.15, 0.2, 0.42, stairX, sy, sz, 0, i === 0);
    kit.box(M.concreteDark, 1.15, 0.36, 0.2, stairX, sy + 0.18, sz - 0.11);
  }
  kit.tilt(M.concreteDark, 1.5, 0.16, 1.3, stairX, 3.5, -5.6, 0.22, 0.04);
  kit.pipe(M.rust, 0.04, 1.0, stairX - 0.62, 4.0, -5.4);
  kit.pipe(M.rust, 0.04, 1.0, stairX + 0.62, 4.0, -5.4);
  kit.rod(M.rust, 0.04, 1.3, stairX, 4.45, -5.4, 'x');

  kit.tilt(M.concreteDark, w * 0.42, 0.18, 1.1, -w * 0.24, fh - 0.15, -1.9, 0.16, 0.06);
  for (let i = 0; i < 5; i += 1) {
    const a = rng.range(-w * 0.42, w * 0.42);
    kit.rod(M.rustDark, 0.025, rng.range(0.5, 1.2), a, topY + rng.range(0.1, 0.5), -th / 2, 'y', 4);
  }
  for (let i = 0; i < 4; i += 1) {
    const by = fh + rng.range(0.4, 1.5);
    const bz = -rng.range(1.6, depth - 1.4);
    const bl = w * rng.range(0.42, 0.8);
    const bx = rng.range(-w * 0.22, w * 0.22);
    kit.tilt(M.concreteDark, bl, 0.26, 0.34, bx, by, bz, rng.range(-0.08, 0.08), rng.range(0.05, 0.22));
    if (rng.chance(0.6)) {
      kit.box(M.concrete, rng.range(0.7, 1.3), 0.1, rng.range(0.5, 0.9), bx + rng.range(-bl * 0.3, bl * 0.3), by + 0.16, bz + 0.1);
    }
  }
  for (let i = 0; i < 3; i += 1) {
    kit.quad(rng.chance(0.5) ? M.glassBroken : M.burnt, rng.range(0.6, 1.2), rng.range(0.7, 1.3), rng.range(-w * 0.35, w * 0.35), rng.range(1.6, fh * 2 - 0.6), -th - 0.06);
  }
  for (let i = 0; i < 22; i += 1) {
    kit.rubbleAt(rng.range(-w * 0.5, w * 0.5), rng.range(0.05, 0.55), rng.range(0.2, 2.4), rng.range(0.22, 0.62), rng.chance(0.5) ? M.brickDark : M.dirt);
  }
  for (let i = 0; i < 6; i += 1) {
    kit.hole(M.soot, rng.range(0.05, 0.12), rng.range(-w * 0.46, w * 0.46), rng.range(0.8, topY), 0.05);
  }
  // 残墙上的立体剥落
  const rf: Facade = { mat: wall, cx: 0, cz: 0, a: 0, w, y0: 0, y1: topY, t: th, openings: [] };
  for (let i = 0; i < (kit.tier === 'near' ? 3 : 1); i += 1) {
    peelPatch(kit, rf, rng.range(-w * 0.4, w * 0.4), rng.range(1.0, topY - 0.8), rng.range(0.8, 1.6), rng.range(0.7, 1.3));
  }
}

// ─────────────────────────── 院子 / 菜地 ───────────────────────────

function buildYard(kit: Kit, w: number, depth: number): void {
  const rng = kit.rng;
  fenceLine(kit, -w / 2, 0.1, w / 2, 0.1, 1.55, w * 0.28);
  fenceLine(kit, -w / 2, 0.1, -w / 2, -depth + 0.3, 1.55, 0);
  fenceLine(kit, w / 2, 0.1, w / 2, -depth + 0.3, 1.55, 0);
  fenceLine(kit, -w / 2, -depth + 0.3, w / 2, -depth + 0.3, 1.4, 0);

  kit.box(M.woodDark, 0.16, 1.75, 0.16, w * 0.28, 0.88, 0.1);
  kit.tilt(M.wood, 1.15, 1.45, 0.09, w * 0.28 - 0.62, 0.78, 0.22, 0, -0.16);
  kit.tilt(M.wood, 1.35, 0.09, 0.42, w * 0.28 + 1.15, 0.06, 0.55, 0, 0.4);

  const sx = -w * 0.24;
  const sz = -depth + 1.5;
  const lw = Math.min(4.6, w * 0.34);
  for (const [px, pz] of [[sx - lw / 2, sz - 1.0], [sx + lw / 2, sz - 1.0], [sx - lw / 2, sz + 0.9], [sx + lw / 2, sz + 0.9]] as Array<[number, number]>) {
    kit.box(M.woodDark, 0.14, 2.35, 0.14, px, 1.17, pz);
  }
  kit.tilt(M.roofRust, lw + 0.5, 0.12, 2.6, sx, 2.42, sz, 0.1, 0);
  for (let r = 0; r < 4; r += 1) {
    for (let i = 0; i < 3; i += 1) {
      kit.rod(r % 2 === 0 ? M.wood : M.woodDark, 0.12, lw * 0.92, sx + rng.range(-0.1, 0.1), 0.14 + r * 0.24, sz - 0.75 + i * 0.3, 'x', 5);
    }
  }

  const bedW = Math.min(7.5, w * 0.42);
  const bedD = Math.min(5.2, depth * 0.55);
  const bx = w * 0.2;
  const bz = -depth * 0.55;
  kit.box(M.soil, bedW, 0.14, bedD, bx, 0.07, bz);
  kit.box(M.woodDark, bedW + 0.2, 0.22, 0.16, bx, 0.12, bz + bedD / 2);
  kit.box(M.woodDark, bedW + 0.2, 0.22, 0.16, bx, 0.12, bz - bedD / 2);
  const rows = 4;
  const perRow = Math.max(4, Math.round(bedW / 0.85));
  for (let r = 0; r < rows; r += 1) {
    for (let i = 0; i < perRow; i += 1) {
      const px = bx - bedW / 2 + 0.45 + i * ((bedW - 0.9) / Math.max(1, perRow - 1));
      const pz = bz - bedD / 2 + 0.7 + r * ((bedD - 1.4) / Math.max(1, rows - 1));
      kit.box(M.crop, 0.34, rng.range(0.14, 0.28), 0.34, px, 0.2, pz, rng.range(0, 1.5));
    }
  }

  const lx0 = -w * 0.36;
  const lx1 = w * 0.06;
  const ly = 2.15;
  const lzz = -depth * 0.34;
  kit.pipe(M.woodDark, 0.07, 2.3, lx0, 1.15, lzz);
  kit.pipe(M.woodDark, 0.07, 2.3, lx1, 1.15, lzz);
  kit.rod(M.metalDark, 0.02, lx1 - lx0, (lx0 + lx1) / 2, ly, lzz, 'x', 4);
  const cloths: Array<[number, THREE.Material, number]> = [
    [0.22, M.cloth, 0.9],
    [0.5, M.tarpBlue, 1.05],
    [0.76, M.fabric, 0.8],
  ];
  for (const [t, mat, cw] of cloths) {
    const cx = lx0 + (lx1 - lx0) * t;
    kit.tilt(mat, cw, 0.86, 0.06, cx, ly - 0.46, lzz, 0.02, rng.range(-0.05, 0.05));
    kit.box(M.metalDark, 0.05, 0.1, 0.05, cx - cw * 0.4, ly - 0.02, lzz);
    kit.box(M.metalDark, 0.05, 0.1, 0.05, cx + cw * 0.4, ly - 0.02, lzz);
  }

  const ox = -w * 0.4;
  const oz = -depth + 3.4;
  kit.box(M.wood, 2.1, 2.1, 2.0, ox, 1.05, oz, 0, true);
  kit.tilt(M.roofRust, 2.5, 0.12, 2.4, ox, 2.16, oz, 0.06, 0);
  kit.box(M.woodDark, 0.7, 1.5, 0.08, ox, 0.75, oz + 1.02);
  kit.box(M.dark, 0.5, 1.2, 0.06, ox, 0.6, oz + 1.05);

  kit.box(M.wood, 0.62, 0.5, 0.62, w * 0.36, 0.25, -depth + 1.4, rng.range(0, 0.6), true);
  for (let i = 0; i < 10; i += 1) {
    kit.rubbleAt(rng.range(-w * 0.46, w * 0.46), rng.range(0.05, 0.18), -rng.range(0.3, depth - 0.5), rng.range(0.18, 0.42), rng.chance(0.6) ? M.dirt : M.woodDark);
  }
}

/** 板条栅栏（沿局部 x 或 z 轴），gap>0 时在该坐标附近留出门洞 */
function fenceLine(kit: Kit, x0: number, z0: number, x1: number, z1: number, h: number, gap: number): void {
  const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
  const len = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
  const count = Math.max(2, Math.round(len / 2.1));
  const rng = kit.rng;
  for (let i = 0; i <= count; i += 1) {
    const t = i / count;
    const px = alongX ? x0 + (x1 - x0) * t : x0;
    const pz = alongX ? z0 : z0 + (z1 - z0) * t;
    if (gap > 0 && Math.abs((alongX ? px : pz) - gap) < 1.2) continue;
    const ph = h * rng.range(0.9, 1.04);
    kit.box(M.woodDark, 0.15, ph, 0.15, px, ph / 2, pz, 0, false);
  }
  const segLen = len / count;
  for (let i = 0; i < count; i += 1) {
    const t = (i + 0.5) / count;
    const px = alongX ? x0 + (x1 - x0) * t : x0;
    const pz = alongX ? z0 : z0 + (z1 - z0) * t;
    if (gap > 0 && Math.abs((alongX ? px : pz) - gap) < 1.7) continue;
    for (const ry of [0.42, 0.86]) {
      kit.box(M.wood, alongX ? segLen * 1.02 : 0.07, 0.11, alongX ? 0.07 : segLen * 1.02, px, h * ry, pz);
    }
  }
}

// ─────────────────────────── 入口 ───────────────────────────

export function buildTown(ctx: BuildContext): THREE.Group {
  const town = new THREE.Group();
  town.name = 'town';

  const buckets = new Map<string, Bucket>();
  const rubble: RubbleItem[] = [];
  const signs: SignItem[] = [];
  const lights: LightItem[] = [];
  /** 每个元素对应一栋楼的独立卷帘门（局部坐标，flush 时由 frameMatrix 变换） */
  const shutterParts: Kit['shutters'] = [];
  const plotBounds: Array<{ kind: string; min: number[]; max: number[] }> = [];
  const instancedGroups = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.Material; matrices: THREE.Matrix4[] }>();

  TOWN_PLOTS.forEach((plot, i) => {
    const rng = ctx.rng.fork(7907 + i * 131);
    const frame = frameFor(plot);
    const { w, d } = extents(plot);
    const kit = new Kit(rng, frame, rubble, signs, lights);
    kit.plotIndex = i;
    kit.shutters = shutterParts;
    const cx = (plot.x0 + plot.x1) / 2;
    const cz = (plot.z0 + plot.z1) / 2;
    const dist = Math.hypot(cx, cz);
    // 档位边界按"默认可视范围"定，而不是按地图中心：底座 288 m 时若仍用 52/78，
    // 默认机位看到的整个核心街区都会掉进 far 档（无弹孔簇、无窗洞侧壁、只 1 处剥落），
    // 于是"做了满墙细节却看不出来"。现在核心区（dist ≤ 102）落在 near/mid。
    kit.detail = clamp(1.55 - dist / 150, 0.4, 1);
    kit.tier = dist < 84 ? 'near' : dist < 126 ? 'mid' : 'far';
    switch (plot.kind) {
      case 'rowhouse':
        buildRowhouse(kit, w, d, plot.floors, {
          shopGround: /杂货铺/.test(plot.note ?? ''),
          emergency: /应急灯/.test(plot.note ?? ''),
          flatRoof: /平顶联排/.test(plot.note ?? ''),
          fireEscape: /平顶联排/.test(plot.note ?? ''),
        });
        break;
      case 'apartment':
        buildApartment(kit, w, d, plot.floors, /钟表店/.test(plot.note ?? ''));
        break;
      case 'shopRow':
        buildShopRow(kit, w, d, plot.floors);
        break;
      case 'shed':
        buildShed(kit, w, d);
        break;
      case 'ruin':
        buildRuin(kit, w, d);
        break;
      default:
        buildYard(kit, w, d);
        break;
    }
    const frameMatrix = new THREE.Matrix4().makeRotationY(frame.rotY);
    frameMatrix.setPosition(frame.origin.x, 0, frame.origin.z);
    kit.flush(buckets, frameMatrix);
    for (const it of kit.inst) {
      const key = `${it.geo.uuid}|${it.mat.uuid}`;
      const g = instancedGroups.get(key);
      if (g) g.matrices.push(it.m);
      else instancedGroups.set(key, { geo: it.geo, mat: it.mat, matrices: [it.m] });
    }
    plotBounds.push({ kind: plot.kind, min: kit.bounds.min.toArray(), max: kit.bounds.max.toArray() });
  });
  town.userData['plotBounds'] = plotBounds;

  // —— 独立卷帘门：套上本栋的 frame 变换，再登记风晃 ——
  const swaying: Array<{ g: THREE.Group; baseY: number; amp: number; phase: number }> = [];
  for (const spec of shutterParts) {
    const plot = TOWN_PLOTS[spec.plot];
    if (!plot) continue;
    const i = spec.plot;
    const frame = frameFor(plot);
    const outer = new THREE.Group();
    outer.name = `shop-shutter-${i}`;
    outer.position.set(frame.origin.x, 0, frame.origin.z);
    outer.rotation.y = frame.rotY;
    const door = new THREE.Group();
    for (const y of spec.slats) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(spec.w, 0.28, 0.09), spec.mat);
      slat.position.set(spec.x, y, 0.12);
      slat.receiveShadow = true;
      // 导轨变形：越往下歪得越多，门才会"卡在半开"
      slat.rotation.x = spec.bent * (1 - (y - 0.6) / 1.9);
      slat.castShadow = false;
      door.add(slat);
    }
    outer.add(door);
    town.add(outer);
    swaying.push({ g: door, baseY: 0, amp: 0.012 + Math.abs(spec.bent) * 0.1, phase: i * 1.37 });
  }
  if (swaying.length > 0) {
    ctx.ticker.add((t) => {
      for (const s of swaying) {
        // 阵风：两个不同周期相乘，出现"偶尔抖一下、大部分时间静止"的节奏
        const gust = Math.max(0, Math.sin(t * 0.21 + s.phase) * Math.sin(t * 0.83 + s.phase * 2.1));
        s.g.position.y = s.baseY - gust * s.amp * 3.1;
        s.g.rotation.x = gust * s.amp;
      }
    });
  }

  // —— 合并后的建筑体块 ——
  let idx = 0;
  buckets.forEach((b) => {
    const mesh = mergeBucket(b, `town-batch-${idx}`);
    idx += 1;
    if (!mesh) return;
    if (b.outline) withOutline(mesh);
    town.add(mesh);
  });

  // —— instanced 批次：碎砖、崩裂碎屑、屋瓦 ——
  let instIdx = 0;
  instancedGroups.forEach((g) => {
    if (g.matrices.length === 0) return;
    const inst = new THREE.InstancedMesh(g.geo, g.mat, g.matrices.length);
    inst.name = `town-inst-${instIdx}`;
    instIdx += 1;
    g.matrices.forEach((m, k) => inst.setMatrixAt(k, m));
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = true;
    inst.receiveShadow = true;
    town.add(inst);
  });

  // —— 墙根瓦砾：统一实例化 ——
  const rubbleGeo = new THREE.DodecahedronGeometry(0.5, 0);
  const byMat = new Map<THREE.Material, RubbleItem[]>();
  for (const item of rubble) {
    const list = byMat.get(item.mat);
    if (list) list.push(item);
    else byMat.set(item.mat, [item]);
  }
  byMat.forEach((list, mat) => {
    const inst = new THREE.InstancedMesh(rubbleGeo, mat, list.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    list.forEach((it, k) => {
      q.setFromEuler(it.rot);
      m.compose(it.pos, q, new THREE.Vector3(it.scale, it.scale * 0.72, it.scale));
      inst.setMatrixAt(k, m);
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = true;
    inst.receiveShadow = true;
    inst.name = 'town-rubble';
    town.add(inst);
  });

  // —— 招牌面片（贴图各自独立）——
  for (const s of signs) {
    const mat = new THREE.MeshBasicMaterial({ map: s.tex, color: 0xc9ccc6, fog: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(s.w, s.h), mat);
    mesh.position.copy(s.pos);
    mesh.rotation.set(0, s.rotY, s.tilt);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    town.add(mesh);
  }

  // —— 极少量暖光 ——
  lights
    .slice()
    .sort((a, b) => Math.hypot(a.pos.x, a.pos.z) - Math.hypot(b.pos.x, b.pos.z))
    .slice(0, 3)
    .forEach((l) => {
      const light = new THREE.PointLight(l.color, l.intensity, l.distance, 2);
      light.position.copy(l.pos);
      ctx.addLight(light);
    });

  return town;
}
