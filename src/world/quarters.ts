import * as THREE from 'three';
import { PALETTE } from '../core/palette';
import { basicMaterial, glowMaterial, toonMaterial, withOutline } from '../core/materials';
import { createRng, type Rng } from '../core/rng';
import type { BuildContext } from '../core/context';
import {
  brickGeometry,
  chippedSlab,
  debrisRing,
  tileGeometry,
  windowFrameGeometry,
} from '../core/detail';
import { hashNoise, jitter, sagPath, tubeAlong, type InstanceTransform } from '../core/geo';
import { HOTSPOTS, ZONES, canPlace, type Rect, type Zone } from './layout';

/**
 * 密集平民区（西境 suburbW1/W2、北带 suburbN1/N2、西南末排 suburbS）。
 *
 * 与 town.ts 相同的工程纪律：
 * - 墙体是**真开洞**的：立面按洞口切格、洞里有侧壁/窗台进深/内退窗框，不是贴片；
 * - 静态同材质件按 (材质, 是否描边) 合并成极少数网格，碎件（砖芯/瓦/碎砖/弹屑）走 instanced；
 * - 每栋的落位矩形必须通过 layout.canPlace(rect, 0.6)，且尊重 zone 的 margin；
 * - LOD：dist<95 near / <120 mid / 其余 far。本区全部在 110m 外，近景档几乎不出现：
 *   far 不描边、不做逐砖细节、窗只留洞；mid（沿街最近的板楼排）才有砖芯、弹孔与封板；
 * - 随机全部来自 ctx.rng.fork(...)，可复现。
 */

// ─────────────────────────── 材质 ───────────────────────────

/** 线性空间压暗：雨夜里被雨水和烟熏旧的墙面 */
function dim(hex: number, k: number): number {
  const c = new THREE.Color(hex);
  c.multiplyScalar(k);
  return c.getHex();
}

const M = {
  panel: toonMaterial(dim(PALETTE.plasterCold, 0.6), { steps: 3 }),
  panelWarm: toonMaterial(dim(PALETTE.plaster, 0.58), { steps: 3 }),
  panelSand: toonMaterial(dim(PALETTE.plasterWarm, 0.6), { steps: 3 }),
  peel: toonMaterial(dim(PALETTE.plasterPeel, 0.56), { steps: 3 }),
  brick: toonMaterial(dim(PALETTE.brick, 0.6), { steps: 3 }),
  brickDark: toonMaterial(dim(PALETTE.brickDark, 0.66), { steps: 3 }),
  concrete: toonMaterial(dim(PALETTE.concrete, 0.58), { steps: 3 }),
  concreteDark: toonMaterial(dim(PALETTE.concreteDark, 0.64), { steps: 3 }),
  trim: toonMaterial(dim(0xc3c1b3, 0.48), { steps: 3 }),
  trimDark: toonMaterial(dim(0x8b8a80, 0.54), { steps: 3 }),
  roof: toonMaterial(dim(PALETTE.roof, 0.62), { steps: 3 }),
  roofRust: toonMaterial(dim(PALETTE.roofRust, 0.64), { steps: 3 }),
  roofDark: toonMaterial(dim(0x4b4e55, 0.68), { steps: 3 }),
  tile: toonMaterial(dim(PALETTE.roof, 0.84), { steps: 3 }),
  tileRust: toonMaterial(dim(PALETTE.roofRust, 0.86), { steps: 3 }),
  wood: toonMaterial(dim(PALETTE.woodOld, 0.72), { steps: 3 }),
  woodDark: toonMaterial(dim(PALETTE.woodDark, 0.78), { steps: 3 }),
  board: toonMaterial(dim(0x9d8e73, 0.68), { steps: 2 }),
  metal: toonMaterial(dim(PALETTE.metalDoor, 0.7), { steps: 3 }),
  metalDark: toonMaterial(dim(0x4d565f, 0.76), { steps: 3 }),
  rust: toonMaterial(dim(PALETTE.rust, 0.74), { steps: 3 }),
  rustDark: toonMaterial(dim(PALETTE.rustDark, 0.78), { steps: 3 }),
  dark: toonMaterial(0x141619, { steps: 2 }),
  reveal: toonMaterial(dim(0x23262a, 0.95), { steps: 2 }),
  glass: toonMaterial(PALETTE.glassDark, { steps: 2 }),
  shard: toonMaterial(dim(PALETTE.glassBroken, 0.66), { steps: 2 }),
  soot: toonMaterial(PALETTE.soot, { steps: 2 }),
  burnt: toonMaterial(PALETTE.burnt, { steps: 2 }),
  dirt: toonMaterial(dim(PALETTE.dirt, 0.82), { steps: 2 }),
  soil: toonMaterial(dim(PALETTE.mud, 0.8), { steps: 3 }),
  crop: toonMaterial(dim(0x5c6b48, 0.78), { steps: 3 }),
  gravel: toonMaterial(dim(0x4a4740, 0.8), { steps: 2 }),
  barrel: toonMaterial(dim(PALETTE.barrelRust, 0.72), { steps: 3 }),
  paper: toonMaterial(dim(PALETTE.paper, 0.46), { steps: 2 }),
  brickCore: toonMaterial(dim(PALETTE.brick, 0.52), { steps: 3 }),
  brickCoreDark: toonMaterial(dim(PALETTE.brickDark, 0.58), { steps: 3 }),
  chipPeel: toonMaterial(dim(PALETTE.plasterPeel, 0.5), { steps: 3 }),
  clothA: toonMaterial(dim(PALETTE.paper, 0.66), { steps: 3, side: THREE.DoubleSide }),
  clothB: toonMaterial(dim(PALETTE.tarpBlue, 0.8), { steps: 3, side: THREE.DoubleSide }),
  clothC: toonMaterial(dim(PALETTE.fabricRed, 0.82), { steps: 3, side: THREE.DoubleSide }),
  clothD: toonMaterial(dim(PALETTE.coatGrey, 0.9), { steps: 3, side: THREE.DoubleSide }),
};

/** 暖窗与 TVs：静态灯火共用一个可合并的 basic 材质（省 draw call） */
const LIT_WARM = basicMaterial(PALETTE.warmLight);

// ─────────────────────────── 共享碎件几何（惰性单例） ───────────────────────────

const V = THREE.Vector3;

let chipCache: THREE.BufferGeometry[] | null = null;
function chips(): THREE.BufferGeometry[] {
  if (!chipCache) {
    const r = createRng('quarters-chips');
    chipCache = [
      chippedSlab(1.0, 0.85, 0.1, r, 0.24),
      chippedSlab(0.75, 1.0, 0.085, r, 0.2),
      chippedSlab(1.2, 0.66, 0.12, r, 0.27),
    ];
  }
  return chipCache;
}

let brickCache: THREE.BufferGeometry | null = null;
function bricks(): THREE.BufferGeometry {
  if (!brickCache) brickCache = brickGeometry(createRng('quarters-brick'));
  return brickCache;
}

let debrisCache: THREE.BufferGeometry | null = null;
function debrisGeo(): THREE.BufferGeometry {
  if (!debrisCache) debrisCache = new THREE.TetrahedronGeometry(0.07, 0);
  return debrisCache;
}

const tileCache: THREE.BufferGeometry[] = [];
function tiles(i: number): THREE.BufferGeometry {
  if (!tileCache[i]) tileCache[i] = tileGeometry(createRng(`quarters-tile-${i}`));
  return tileCache[i];
}

const chunkCache: THREE.BufferGeometry[] = [];
function chunks(i: number): THREE.BufferGeometry {
  // 三个抖动变体轮流用，避免碎砖看起来是同一颗的复制
  if (!chunkCache[i]) chunkCache[i] = jitter(new THREE.DodecahedronGeometry(0.4, 0), 0.09, createRng(`quarters-chunk-${i}`));
  return chunkCache[i];
}

// ─────────────────────────── 收集器（材质分桶 + instanced 分组） ───────────────────────────

interface Bucket {
  mat: THREE.Material;
  outline: boolean;
  shadow: boolean;
  geos: THREE.BufferGeometry[];
}

type Tier = 'near' | 'mid' | 'far';

const eulerScratch = new THREE.Euler();

/** 全部几何都直接建在世界坐标里（本模块一切体块都是轴对齐的） */
class Collector {
  buckets = new Map<string, Bucket>();
  insts = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.Material; mats: THREE.Matrix4[]; shadow: boolean }>();
  /** 需要动画的电视窗口：buildOpening 建到 'tv' 洞口时登记 */
  tv: Array<{ x: number; y: number; z: number; rotY: number; w: number; h: number }> = [];

  add(geo: THREE.BufferGeometry, mat: THREE.Material, opts: { outline?: boolean; shadow?: boolean } = {}): void {
    const outline = opts.outline ?? false;
    const key = `${mat.uuid}|${outline ? 1 : 0}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = { mat, outline, shadow: false, geos: [] };
      this.buckets.set(key, b);
    }
    b.geos.push(geo);
    if (opts.shadow !== false) b.shadow = true;
  }

  box(mat: THREE.Material, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, opts: { outline?: boolean; shadow?: boolean } = {}): void {
    const g = new THREE.BoxGeometry(Math.max(x1 - x0, 0.001), Math.max(y1 - y0, 0.001), Math.max(z1 - z0, 0.001));
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    this.add(g, mat, opts);
  }

  /** 竖直面片（rotY 定向），灯火/玻璃残渣面用 */
  quad(mat: THREE.Material, cx: number, cy: number, cz: number, w: number, h: number, rotY: number, opts: { shadow?: boolean } = {}): void {
    const g = new THREE.PlaneGeometry(w, h);
    if (rotY !== 0) g.rotateY(rotY);
    g.translate(cx, cy, cz);
    this.add(g, mat, { shadow: opts.shadow });
  }

  cyl(mat: THREE.Material, r: number, h: number, cx: number, cy: number, cz: number, seg = 8, opts: { outline?: boolean; shadow?: boolean; topR?: number } = {}): void {
    const g = new THREE.CylinderGeometry(opts.topR ?? r, r, h, seg, 1, false);
    g.translate(cx, cy, cz);
    this.add(g, mat, opts);
  }

  /** 卧倒的杆件（钢筋、绳杠、圆木） */
  rod(mat: THREE.Material, r: number, len: number, cx: number, cy: number, cz: number, along: 'x' | 'y' | 'z', seg = 5, opts: { shadow?: boolean } = {}): void {
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1, true);
    if (along === 'x') g.rotateZ(Math.PI / 2);
    else if (along === 'z') g.rotateX(Math.PI / 2);
    g.translate(cx, cy, cz);
    this.add(g, mat, opts);
  }

  /** 实例化碎件：几何共享、一个 (几何,材质) 对 = 一个 draw call */
  instanced(geo: THREE.BufferGeometry, mat: THREE.Material, transforms: InstanceTransform[], shadow: boolean): void {
    if (transforms.length === 0) return;
    const key = `${geo.uuid}|${mat.uuid}`;
    const q = new THREE.Quaternion();
    const e = eulerScratch;
    let entry = this.insts.get(key);
    if (!entry) {
      entry = { geo, mat, mats: [], shadow };
      this.insts.set(key, entry);
    }
    for (const t of transforms) {
      e.copy(t.rotation ?? zeroEuler);
      q.setFromEuler(e);
      const s = t.scale ?? unitScale;
      const m = new THREE.Matrix4().compose(t.position, q, s);
      entry.mats.push(m);
    }
    if (!shadow) entry.shadow = false;
  }

  flush(parent: THREE.Group): void {
    let idx = 0;
    this.buckets.forEach((b) => {
      const mesh = mergeBucket(b, `quarters-batch-${idx}`);
      idx += 1;
      if (!mesh) return;
      if (b.outline) withOutline(mesh);
      parent.add(mesh);
    });
    let ii = 0;
    this.insts.forEach((g) => {
      const inst = new THREE.InstancedMesh(g.geo, g.mat, g.mats.length);
      inst.name = `quarters-inst-${ii}`;
      ii += 1;
      g.mats.forEach((m, k) => inst.setMatrixAt(k, m));
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = g.shadow;
      inst.receiveShadow = g.shadow;
      parent.add(inst);
    });
  }
}

const zeroEuler = new THREE.Euler();
const unitScale = new V(1, 1, 1);

/** 按材质合并：统一转非索引，只保留 position/normal/uv（同 town.ts 的 mergeBucket） */
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
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, b.mat);
  mesh.name = name;
  mesh.castShadow = b.shadow;
  mesh.receiveShadow = b.shadow;
  return mesh;
}

// ─────────────────────────── 带真开洞的墙（世界坐标、轴对齐） ───────────────────────────

/** 洞口：u 沿墙横向中心，v 竖向中心；state 决定窗内内容 */
interface Opening {
  u: number;
  v: number;
  w: number;
  h: number;
  kind: 'win' | 'door';
  state: 'intact' | 'broken' | 'boarded' | 'empty' | 'lit' | 'tv';
}

interface WallSpec {
  axis: 'x' | 'z';
  /** 外墙皮所在平面（垂直于 axis 的那个坐标） */
  pos: number;
  /** 外法线方向（+1 / -1，沿另一个水平轴） */
  out: 1 | -1;
  u0: number;
  u1: number;
  y0: number;
  y1: number;
  t: number;
  mat: THREE.Material;
  opens: Opening[];
  /** 只有建筑主体才描边（far 档传 false） */
  outline: boolean;
}

/** 立面上一点 → 世界坐标：u 沿墙（相对墙面中心）、v 竖向、d 沿外法线（>0 突出墙面） */
function wp(w: WallSpec, u: number, v: number, d: number): [number, number, number] {
  const mid = (w.u0 + w.u1) / 2;
  return w.axis === 'x' ? [mid + u, v, w.pos + w.out * d] : [w.pos + w.out * d, v, mid + u];
}

/** 立面局部尺寸 → 世界尺寸（沿墙长度 lenU、高 h、法向厚度 th） */
function wsize(w: WallSpec, lenU: number, h: number, th: number): [number, number, number] {
  return w.axis === 'x' ? [lenU, h, th] : [th, h, lenU];
}

/** 面片/窗框绕 Y 的朝向角 */
function wrotY(w: WallSpec): number {
  if (w.axis === 'x') return w.out === 1 ? 0 : Math.PI;
  return w.out === 1 ? Math.PI / 2 : -Math.PI / 2;
}

/** 以 (u,v,d) 为中心放一个沿墙的盒体 */
function faceBox(C: Collector, w: WallSpec, mat: THREE.Material, u: number, v: number, d: number, lenU: number, h: number, th: number, opts: { outline?: boolean; shadow?: boolean } = {}): void {
  const [cx, cy, cz] = wp(w, u, v, d);
  const [sx, sy, sz] = wsize(w, lenU, h, th);
  C.box(mat, cx - sx / 2, cx + sx / 2, cy - sy / 2, cy + sy / 2, cz - sz / 2, cz + sz / 2, opts);
}

/**
 * 砌一堵带洞口的墙：洞口把墙面切成 u×v 网格，实心格按行横向合并。
 * 洞是穿透墙厚的真洞，far 档也保留（窗只留洞）。
 */
function buildWall(C: Collector, w: WallSpec, tier: Tier, rng: Rng): void {
  const hw = (w.u1 - w.u0) / 2;
  const xs = new Set<number>([-hw, hw]);
  const ys = new Set<number>([w.y0, w.y1]);
  for (const o of w.opens) {
    xs.add(clamp(o.u - o.w / 2, -hw, hw));
    xs.add(clamp(o.u + o.w / 2, -hw, hw));
    ys.add(clamp(o.v - o.h / 2, w.y0, w.y1));
    ys.add(clamp(o.v + o.h / 2, w.y0, w.y1));
  }
  const xc = [...xs].sort((a, b) => a - b);
  const yc = [...ys].sort((a, b) => a - b);
  const nx = xc.length - 1;
  const ny = yc.length - 1;
  const outline = w.outline && tier !== 'far';
  for (let j = 0; j < ny; j += 1) {
    let i = 0;
    while (i < nx) {
      const mu = (xc[i] + xc[i + 1]) / 2;
      const mv = (yc[j] + yc[j + 1]) / 2;
      let blocked = false;
      for (const o of w.opens) {
        if (Math.abs(mu - o.u) < o.w / 2 - 1e-4 && Math.abs(mv - o.v) < o.h / 2 - 1e-4) {
          blocked = true;
          break;
        }
      }
      if (blocked) {
        i += 1;
        continue;
      }
      let k = i;
      while (k + 1 < nx) {
        const nmu = (xc[k + 1] + xc[k + 2]) / 2;
        let nb = false;
        for (const o of w.opens) {
          if (Math.abs(nmu - o.u) < o.w / 2 - 1e-4 && Math.abs(mv - o.v) < o.h / 2 - 1e-4) {
            nb = true;
            break;
          }
        }
        if (nb) break;
        k += 1;
      }
      faceBox(C, w, w.mat, (xc[i] + xc[k + 1]) / 2, mv, -w.t / 2, xc[k + 1] - xc[i], yc[j + 1] - yc[j], w.t, { outline, shadow: tier !== 'far' });
      i = k + 1;
    }
  }
  for (const o of w.opens) buildOpening(C, w, o, tier, rng);
}

/**
 * 一个洞口：洞底黑（far 档只到这一步）+ 洞口侧壁 + 窗台进深 + 内退窗框 +
 * 玻璃/锯齿碎渣/封板/灯火面片。
 */
function buildOpening(C: Collector, w: WallSpec, o: Opening, tier: Tier, rng: Rng): void {
  // 洞底一片黑：挡住对面墙的洞，窗洞才读得出"里面有房间"
  faceBox(C, w, M.dark, o.u, o.v, -w.t + 0.05, o.w, o.h, 0.05, { shadow: false });
  if (tier === 'far') return;

  const th = 0.045;
  const dpth = w.t * 0.92;
  const d = -w.t / 2;
  // 洞口四壁（侧壁有真实进深）
  faceBox(C, w, M.reveal, o.u, o.v + o.h / 2 - th / 2, d, o.w, th, dpth, { shadow: false });
  faceBox(C, w, M.reveal, o.u, o.v - o.h / 2 + th / 2, d, o.w, th, dpth, { shadow: false });
  faceBox(C, w, M.reveal, o.u - o.w / 2 + th / 2, o.v, d, th, o.h, dpth, { shadow: false });
  faceBox(C, w, M.reveal, o.u + o.w / 2 - th / 2, o.v, d, th, o.h, dpth, { shadow: false });

  const deep = o.kind === 'door' ? w.t * 0.55 : w.t * 0.7;
  const rotY = wrotY(w);

  if (o.kind === 'door') {
    faceBox(C, w, rng.chance(0.5) ? M.woodDark : M.metal, o.u, o.v, -deep, o.w * 0.88, o.h * 0.96, 0.08, { shadow: false });
    faceBox(C, w, M.trim, o.u, o.v + o.h / 2 + 0.06, 0.04, o.w + 0.26, 0.13, 0.14, { shadow: false });
    // 门廊台阶（两级，出挑到墙面外）
    faceBox(C, w, M.concrete, o.u, 0.1, 0.3, o.w + 0.66, 0.18, 0.7, { shadow: true });
    faceBox(C, w, M.concrete, o.u, 0.25, 0.16, o.w + 0.38, 0.15, 0.42, { shadow: true });
    return;
  }

  // 内退窗框（detail.ts 原语：外框 + 中挺，有厚度）
  const frame = windowFrameGeometry(o.w * 0.95, o.h * 0.95, 0.12, true);
  frame.rotateY(rotY);
  const [fx, fy, fz] = wp(w, o.u, o.v, -deep);
  frame.translate(fx, fy, fz);
  C.add(frame, M.trimDark, { shadow: false });

  const gd = -deep + 0.03;
  if (o.state === 'lit') {
    C.quad(M.dark, ...shift(wp(w, o.u, o.v, gd)), o.w * 0.94, o.h * 0.92, rotY, { shadow: false });
    C.quad(LIT_WARM, ...shift(wp(w, o.u, o.v, gd - 0.02)), o.w * 0.86, o.h * 0.84, rotY, { shadow: false });
    // 灯下的家具剪影
    for (let i = 0; i < 2; i += 1) {
      const fu = o.u + rng.range(-o.w * 0.28, o.w * 0.28);
      const fh = rng.range(0.3, 0.62);
      faceBox(C, w, M.dark, fu, o.v - o.h / 2 + fh / 2 + 0.06, gd - 0.03, rng.range(0.22, 0.4), fh, 0.05, { shadow: false });
    }
  } else if (o.state === 'tv') {
    // 电视：静态暗底 + 一张独立闪动面片（buildQuarters 里做动画），位置登记给上层
    const p = wp(w, o.u, o.v, gd);
    C.tv.push({ x: p[0], y: p[1], z: p[2], rotY, w: o.w * 0.84, h: o.h * 0.8 });
    C.quad(M.dark, ...shift(wp(w, o.u, o.v, gd)), o.w * 0.94, o.h * 0.92, rotY, { shadow: false });
  } else if (o.state === 'intact') {
    C.quad(M.glass, ...shift(wp(w, o.u, o.v, gd)), o.w * 0.9, o.h * 0.88, rotY, { shadow: false });
  } else if (o.state === 'broken') {
    C.quad(M.glass, ...shift(wp(w, o.u, o.v, gd)), o.w * 0.9, o.h * 0.88, rotY, { shadow: false });
    // 锯齿状玻璃残渣：歪斜的小碎块留在洞缘
    for (let i = 0; i < 7; i += 1) {
      const su = o.u + rng.range(-o.w * 0.45, o.w * 0.45);
      const sv = o.v + rng.range(-o.h * 0.42, o.h * 0.42);
      faceBox(C, w, M.shard, su, sv, gd + 0.02, rng.range(0.08, 0.24), rng.range(0.07, 0.22), 0.02, { shadow: false });
    }
  } else if (o.state === 'boarded') {
    // 封板：板条有厚度、有起翘角、有钉头
    const planks = 3;
    for (let i = 0; i < planks; i += 1) {
      const pv = o.v - o.h / 2 + ((i + 0.5) * o.h) / planks + rng.range(-0.04, 0.04);
      const pd = -0.02 + rng.range(-0.02, 0.05);
      faceBox(C, w, i % 2 === 0 ? M.board : M.wood, o.u + rng.range(-0.05, 0.05), pv, pd, o.w + 0.28, 0.17, 0.05, { shadow: true });
      for (const s of [-1, 1]) {
        const [nx, ny2, nz] = wp(w, o.u + s * o.w * 0.36, pv + rng.range(-0.03, 0.03), pd + 0.035);
        // 钉头沿墙法线方向（不是沿墙方向）
        C.rod(M.metalDark, 0.016, 0.05, nx, ny2, nz, w.axis === 'x' ? 'z' : 'x', 4, { shadow: false });
      }
    }
  }

  // 外挑窗台（带滴水斜沿）+ 窗楣
  faceBox(C, w, M.trim, o.u, o.v - o.h / 2 - 0.08, 0.08, o.w + 0.4, 0.1, 0.36, { shadow: true });
  faceBox(C, w, M.trimDark, o.u, o.v + o.h / 2 + 0.08, 0.05, o.w + 0.36, 0.14, 0.15, { shadow: true });
}

/** [x,y,z] → spread 进 C.quad 的前三个参数 */
function shift(p: [number, number, number]): [number, number, number] {
  return p;
}

const clamp = THREE.MathUtils.clamp;

// ─────────────────────────── 立面风化（mid 档专属的高保真细节） ───────────────────────────

/**
 * 剥落墙皮：立体破片（chippedSlab，有厚度、边缘参差）+ 下方错缝外露的立体砖芯。
 * 砖芯比墙面稍微凸出，才看得到错缝与体积。
 */
function peelPatch(C: Collector, w: WallSpec, rng: Rng, u: number, v: number, pw: number, ph: number): void {
  const geo = chips();
  for (let i = 0; i < 2; i += 1) {
    const [px, py, pz] = wp(w, u + rng.range(-pw * 0.3, pw * 0.3), v + rng.range(-ph * 0.25, ph * 0.25), 0.015);
    C.instanced(geo[i % geo.length], rng.chance(0.5) ? M.chipPeel : M.peel, [
      {
        position: new V(px, py, pz),
        rotation: new THREE.Euler(rng.range(-0.07, 0.07), wrotY(w) + rng.range(-0.4, 0.4), rng.range(-0.5, 0.5)),
        scale: new V(pw * rng.range(0.4, 0.7), ph * rng.range(0.4, 0.7), 1),
      },
    ], false);
  }
  const rows = Math.max(2, Math.round(ph / 0.13));
  const cols = Math.max(2, Math.round(pw / 0.3));
  const tx: InstanceTransform[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const off = r % 2 === 0 ? 0 : 0.15;
      const bu = u - (cols * 0.3) / 2 + c * 0.3 + off;
      if (Math.abs(bu - u) > pw / 2) continue;
      const bv = v - ph / 2 + r * 0.095;
      const [px, py, pz] = wp(w, bu, bv, 0.014);
      tx.push({
        position: new V(px, py, pz),
        rotation: new THREE.Euler(0, wrotY(w) + rng.range(-0.04, 0.04), rng.range(-0.05, 0.05)),
        scale: unitScale,
      });
    }
  }
  C.instanced(bricks(), rng.chance(0.6) ? M.brickCore : M.brickCoreDark, tx, false);
}

/** 弹着点簇：3~5 个弹孔 + 烟熏 + 边缘崩裂碎屑环（debrisRing 原语） */
function bulletCluster(C: Collector, w: WallSpec, rng: Rng, u: number, v: number): void {
  const n = 3 + Math.floor(rng.next() * 3);
  for (let i = 0; i < n; i += 1) {
    const hu = u + rng.range(-0.26, 0.26);
    const hv = v + rng.range(-0.2, 0.2);
    const rotY = wrotY(w);
    const [px, py, pz] = wp(w, hu, hv, 0.03);
    const g = new THREE.CircleGeometry(rng.range(0.04, 0.08), 6);
    g.rotateY(rotY);
    g.translate(px, py, pz);
    C.add(g, M.soot, { shadow: false });
  }
  const ring = debrisRing(8, 0.2, rng, 0.55);
  const tx: InstanceTransform[] = ring.map((t) => {
    const [px, py, pz] = wp(w, u + t.position.x, v + t.position.y, 0.04 + t.position.z);
    return {
      position: new V(px, py, pz),
      rotation: new THREE.Euler(t.rotation?.x ?? 0, wrotY(w) + (t.rotation?.y ?? 0), t.rotation?.z ?? 0),
      scale: t.scale ?? unitScale,
    };
  });
  C.instanced(debrisGeo(), M.concreteDark, tx, false);
}

/** 墙面雨痕/积灰：竖向深色不规则条带，保证一面墙至少 3 级明度 */
function facadeGrime(C: Collector, w: WallSpec, rng: Rng, count: number): void {
  const hw = (w.u1 - w.u0) / 2;
  for (let i = 0; i < count; i += 1) {
    const u = rng.range(-hw + 0.6, hw - 0.6);
    const h = rng.range(0.9, 2.6);
    const v = clamp(rng.range(w.y0 + h / 2 + 0.3, w.y1 - h / 2), w.y0 + h / 2, w.y1 - h / 2);
    const [px, py, pz] = wp(w, u, v, 0.022);
    const pts: THREE.Vector2[] = [];
    for (let k = 0; k < 7; k += 1) {
      const a = (k / 7) * Math.PI * 2;
      pts.push(new THREE.Vector2(Math.cos(a) * rng.range(0.11, 0.3), Math.sin(a) * (h / 2) * rng.range(0.75, 1)));
    }
    const g = new THREE.ShapeGeometry(new THREE.Shape(pts), 1);
    g.rotateY(wrotY(w));
    g.translate(px, py, pz);
    C.add(g, M.concreteDark, { shadow: false });
  }
}

// ─────────────────────────── 朝向工具 ───────────────────────────

type FrontDir = 'x+' | 'x-' | 'z+' | 'z-';

interface FrontInfo {
  /** 临街立面所沿的世界轴（u 轴） */
  axis: 'x' | 'z';
  /** 外墙皮坐标 */
  pos: number;
  out: 1 | -1;
  u0: number;
  u1: number;
}

function frontInfo(f: FrontDir, rect: Rect): FrontInfo {
  switch (f) {
    case 'x+':
      return { axis: 'z', pos: rect.x1, out: 1, u0: rect.z0, u1: rect.z1 };
    case 'x-':
      return { axis: 'z', pos: rect.x0, out: -1, u0: rect.z0, u1: rect.z1 };
    case 'z+':
      return { axis: 'x', pos: rect.z1, out: 1, u0: rect.x0, u1: rect.x1 };
    default:
      return { axis: 'x', pos: rect.z0, out: -1, u0: rect.x0, u1: rect.x1 };
  }
}

/** 与临街立面垂直的两个端面 */
function endWalls(fi: FrontInfo, rect: Rect, T: number): Array<{ axis: 'x' | 'z'; pos: number; out: 1 | -1; u0: number; u1: number }> {
  if (fi.axis === 'x') {
    return [
      { axis: 'z', pos: rect.x0, out: -1, u0: rect.z0 + T, u1: rect.z1 - T },
      { axis: 'z', pos: rect.x1, out: 1, u0: rect.z0 + T, u1: rect.z1 - T },
    ];
  }
  return [
    { axis: 'x', pos: rect.z0, out: -1, u0: rect.x0 + T, u1: rect.x1 - T },
    { axis: 'x', pos: rect.z1, out: 1, u0: rect.x0 + T, u1: rect.x1 - T },
  ];
}

// ─────────────────────────── 赫鲁晓夫板楼（2~3 层预制板） ───────────────────────────

interface BlockOpts {
  front: FrontDir;
  floors: 2 | 3;
  /** 0~1：这栋楼的破败程度 */
  dilap?: number;
  tv?: boolean;
  lits?: number;
}

function panelBlock(C: Collector, rng: Rng, rect: Rect, tier: Tier, o: BlockOpts): void {
  const fi = frontInfo(o.front, rect);
  const alongX = fi.axis === 'x';
  const len = fi.u1 - fi.u0;
  const depth = alongX ? rect.x1 - rect.x0 : rect.z1 - rect.z0;
  const T = 0.34;
  const g0 = 2.95;
  const up = 2.8;
  const H = g0 + up * (o.floors - 1);
  const dilap = o.dilap ?? 0.5;
  const wallMat = rng.pick([M.panel, M.panelWarm, M.panelSand]);
  const main = tier !== 'far';

  // 核心体块：四面皮各内退 T，形成真正的板墙厚度
  C.box(wallMat, rect.x0 + T, rect.x1 - T, 0.12, H, rect.z0 + T, rect.z1 - T, { outline: main });

  // —— 临街立面：每开间一扇窗，楼梯间入口成对布置 ——
  const bays = clamp(Math.round(len / 3.1), 2, 7);
  const bay = len / bays;
  const entryBay = 1 + Math.floor(rng.next() * (bays - 2));
  let litBudget = o.lits ?? 0;
  const front: WallSpec = { axis: fi.axis, pos: fi.pos, out: fi.out, u0: fi.u0, u1: fi.u1, y0: 0, y1: H, t: T, mat: wallMat, opens: [], outline: true };
  for (let b = 0; b < bays; b += 1) {
    const cu = bay * (b + 0.5) - len / 2;
    for (let f = 0; f < o.floors; f += 1) {
      const floorY = f === 0 ? 0 : g0 + up * (f - 1);
      const fh = f === 0 ? g0 : up;
      if (f === 0 && b === entryBay) {
        front.opens.push({ u: cu, v: 1.12, w: 1.15, h: 2.24, kind: 'door', state: rng.chance(0.3) ? 'empty' : 'intact' });
        continue;
      }
      const r = rng.next();
      let state: Opening['state'];
      if (o.tv && f === 1 && b === entryBay) state = 'tv';
      else if (r > 0.9 && litBudget > 0 && tier !== 'far') {
        state = 'lit';
        litBudget -= 1;
      } else if (r > 0.9 - dilap * 0.34) state = 'broken';
      else if (r > 0.52 - dilap * 0.2) state = 'boarded';
      else if (r > 0.44 - dilap * 0.14) state = 'empty';
      else state = 'intact';
      front.opens.push({ u: cu, v: floorY + fh * 0.56, w: 1.22, h: 1.42, kind: 'win', state });
    }
  }
  buildWall(C, front, tier, rng);
  facadeGrime(C, front, rng, main ? 5 : 1);

  // 预制板缝：楼层水平通缝（滴水凸带）所有档位都保留（剪影），竖向板缝只做 mid
  for (const wall of [front]) {
    for (let f = 1; f < o.floors; f += 1) {
      const y = g0 + up * (f - 1);
      faceBox(C, wall, M.trim, 0, y + 0.02, 0.03, len - 0.02, 0.1, 0.07, { shadow: false });
      faceBox(C, wall, M.trimDark, 0, y + 0.1, 0.05, len - 0.02, 0.05, 0.09, { shadow: false });
    }
    if (main) {
      for (let b = 1; b < bays; b += 1) {
        // 竖向板缝：预制板的开间分界，稍微凸出一点点即可
        faceBox(C, wall, M.concreteDark, b * bay - len / 2, H / 2 - 0.1, 0.024, 0.06, H - 0.4, 0.03, { shadow: false });
      }
    }
  }
  // 阳台（mid 档的两三层少数开间）：混凝土板 + 女儿墙式护栏
  if (main) {
    for (let f = 1; f < o.floors; f += 1) {
      for (let b = 0; b < bays; b += 1) {
        if (!rng.chance(0.18)) continue;
        const uu = bay * (b + 0.5) - len / 2;
        const y = g0 + up * (f - 1) + 0.1;
        faceBox(C, front, M.concrete, uu, y, 0.55, 1.7, 0.14, 1.0, { shadow: true });
        faceBox(C, front, M.trim, uu, y + 0.48, 1.02, 1.7, 0.78, 0.1, { shadow: true });
      }
    }
  }

  // —— 背面立面：上层成排小窗 + 后门 ——
  const span = alongX ? [rect.z0, rect.z1] : [rect.x0, rect.x1];
  const backPos = fi.pos === span[0] ? span[1] : span[0];
  const back: WallSpec = { axis: fi.axis, pos: backPos, out: fi.out === 1 ? -1 : 1, u0: fi.u0, u1: fi.u1, y0: 0, y1: H, t: T, mat: wallMat, opens: [], outline: true };
  for (let b = 0; b < bays; b += 1) {
    const cu = bay * (b + 0.5) - len / 2;
    if (b === bays - 1) back.opens.push({ u: cu, v: 1.05, w: 1.0, h: 2.1, kind: 'door', state: 'empty' });
    for (let f = 1; f < o.floors; f += 1) {
      const r = rng.next();
      back.opens.push({ u: cu, v: g0 + up * (f - 1) + up * 0.55, w: 1.1, h: 1.32, kind: 'win', state: r > 0.75 ? 'broken' : r > 0.5 ? 'empty' : 'intact' });
    }
  }
  buildWall(C, back, tier, rng);
  facadeGrime(C, back, rng, main ? 3 : 0);
  if (main) {
    peelPatch(C, back, rng, rng.range(-len * 0.3, len * 0.3), rng.range(1.2, H - 1.2), rng.range(1.0, 1.8), rng.range(0.8, 1.5));
  }

  // —— 端面 ——
  for (const e of endWalls(fi, rect, T)) {
    const ew: WallSpec = { axis: e.axis, pos: e.pos, out: e.out, u0: e.u0, u1: e.u1, y0: 0, y1: H, t: T, mat: wallMat, opens: [], outline: true };
    for (let f = 0; f < o.floors; f += 1) {
      const floorY = f === 0 ? 0 : g0 + up * (f - 1);
      const fh = f === 0 ? g0 : up;
      const r = rng.next();
      ew.opens.push({ u: 0, v: floorY + fh * 0.55, w: 1.06, h: 1.3, kind: 'win', state: r > 0.8 ? 'broken' : r > 0.6 ? 'boarded' : 'intact' });
    }
    buildWall(C, ew, tier, rng);
  }

  // —— 平屋顶：防水板 + 女儿墙 + 压顶 + 楼梯间 + 水箱 + 通风帽 + 检修口 ——
  C.box(M.roofDark, rect.x0 - 0.06, rect.x1 + 0.06, H, H + 0.16, rect.z0 - 0.06, rect.z1 + 0.06, { outline: main });
  const parY = H + 0.16;
  const parapet = (x0: number, x1: number, z0: number, z1: number) => C.box(wallMat, x0, x1, parY, parY + 0.55, z0, z1, { outline: main });
  const coping = (x0: number, x1: number, z0: number, z1: number) => C.box(M.trim, x0 - 0.04, x1 + 0.04, parY + 0.55, parY + 0.66, z0 - 0.04, z1 + 0.04, { outline: false });
  parapet(rect.x0, rect.x1, rect.z0, rect.z0 + 0.24);
  parapet(rect.x0, rect.x1, rect.z1 - 0.24, rect.z1);
  parapet(rect.x0, rect.x0 + 0.24, rect.z0 + 0.24, rect.z1 - 0.24);
  parapet(rect.x1 - 0.24, rect.x1, rect.z0 + 0.24, rect.z1 - 0.24);
  coping(rect.x0, rect.x1, rect.z0, rect.z0 + 0.24);
  coping(rect.x0, rect.x1, rect.z1 - 0.24, rect.z1);
  coping(rect.x0, rect.x0 + 0.24, rect.z0 + 0.24, rect.z1 - 0.24);
  coping(rect.x1 - 0.24, rect.x1, rect.z0 + 0.24, rect.z1 - 0.24);
  // 楼梯间高出一截（检修门朝后院）
  const sx = rng.chance(0.5) ? rect.x0 + 1.6 : rect.x1 - 1.6;
  const bulkY = parY + 0.55;
  C.box(wallMat, sx - 1.15, sx + 1.15, bulkY, bulkY + 2.1, (rect.z0 + rect.z1) / 2 - 1.0, (rect.z0 + rect.z1) / 2 + 1.0, { outline: main });
  C.box(M.metalDark, sx - 0.55, sx + 0.55, bulkY + 0.1, bulkY + 1.7, (rect.z0 + rect.z1) / 2 - 1.06, (rect.z0 + rect.z1) / 2 - 0.96, { shadow: false });
  C.box(M.concreteDark, sx - 1.3, sx + 1.3, bulkY + 2.1, bulkY + 2.26, (rect.z0 + rect.z1) / 2 - 1.15, (rect.z0 + rect.z1) / 2 + 1.15, {});
  // 屋顶水箱（带支腿；far 档简化成墩座）
  const tx = (rect.x0 + rect.x1) / 2 + rng.range(-len * 0.18, len * 0.18);
  const tz = (rect.z0 + rect.z1) / 2 + (alongX ? rng.range(-1.4, 1.4) : rng.range(depth * 0.2, depth * 0.3) * rng.sign());
  const tankY = bulkY;
  if (main) {
    for (const [lx, lz] of [[-0.55, -0.55], [0.55, -0.55], [-0.55, 0.55], [0.55, 0.55]] as Array<[number, number]>) {
      C.box(M.rustDark, tx + lx - 0.05, tx + lx + 0.05, tankY + 0.16, tankY + 0.95, tz + lz - 0.05, tz + lz + 0.05, {});
    }
    C.cyl(M.metal, 0.72, 1.05, tx, tankY + 1.5, tz, 9, { outline: true, shadow: true });
  } else {
    C.box(M.concreteDark, tx - 0.6, tx + 0.6, tankY, tankY + 0.5, tz - 0.6, tz + 0.5, { shadow: false });
    C.cyl(M.metal, 0.72, 0.95, tx, tankY + 0.95, tz, 8, { shadow: false });
  }
  C.cyl(M.rust, 0.2, 0.12, tx, tankY + 2.1, tz, 8, { shadow: false });
  if (main) {
    // 通风帽 ×2 + 检修口（翘起的盖板）
    for (let i = 0; i < 2; i += 1) {
      const vx = (rect.x0 + rect.x1) / 2 + rng.range(-len * 0.3, len * 0.3);
      const vz = (rect.z0 + rect.z1) / 2 + rng.range(-depth * 0.25, depth * 0.25);
      C.cyl(M.metal, 0.13, 0.5, vx, bulkY + 0.4, vz, 6, { shadow: true });
      const cap = new THREE.CylinderGeometry(0.24, 0.15, 0.14, 8);
      cap.translate(vx, bulkY + 0.72, vz);
      C.add(cap, M.metalDark, { shadow: false });
    }
    const hx = (rect.x0 + rect.x1) / 2 + rng.range(-len * 0.25, len * 0.25);
    const hz = (rect.z0 + rect.z1) / 2 + rng.range(-depth * 0.2, depth * 0.2);
    const hatch = new THREE.BoxGeometry(0.85, 0.07, 0.7);
    hatch.rotateX(-0.5);
    hatch.translate(hx, bulkY + 0.2, hz);
    C.add(hatch, M.rust, { shadow: false });
  }

  // —— 战损（只有 mid 档做逐砖/弹孔级细节） ——
  if (main) {
    for (let i = 0; i < 2; i += 1) {
      peelPatch(C, front, rng, rng.range(-len * 0.36, len * 0.36), rng.range(1.1, H - 0.9), rng.range(0.9, 1.7), rng.range(0.8, 1.5));
    }
    for (let i = 0; i < 2; i += 1) {
      bulletCluster(C, front, rng, rng.range(-len * 0.4, len * 0.4), rng.range(1.3, H - 0.9));
    }
  }
  // 勒脚一圈：所有档位（接地轮廓更扎实）
  const skirt = 0.55;
  for (const wall of [front, back]) {
    faceBox(C, wall, M.concreteDark, 0, skirt / 2, 0.02, len, skirt, 0.1, { shadow: false });
  }
  // 墙根碎砖
  rubbleScatter(C, rng, rect, main ? 10 : 4, [M.dirt, M.brickDark]);
}

// ─────────────────────────── 破败平房（单层砖木） ───────────────────────────

interface HouseOpts {
  front: FrontDir;
  floors?: 1 | 2;
  /** 塌了半边：屋顶缺一大块、露椽子 */
  collapsed?: boolean;
}

function bungalow(C: Collector, rng: Rng, rect: Rect, tier: Tier, o: HouseOpts): void {
  const fi = frontInfo(o.front, rect);
  const alongX = fi.axis === 'x';
  const len = fi.u1 - fi.u0;
  const depth = alongX ? rect.x1 - rect.x0 : rect.z1 - rect.z0;
  const T = 0.36;
  const h1 = 2.62;
  const floors = o.floors ?? 1;
  const H = floors === 2 ? h1 * 2 + 0.5 : h1;
  const wallMat = rng.chance(0.5) ? M.brick : rng.pick([M.panelWarm, M.peel, M.panel]);
  const main = tier !== 'far';

  C.box(wallMat, rect.x0 + T, rect.x1 - T, 0.12, H, rect.z0 + T, rect.z1 - T, { outline: main });

  const front: WallSpec = { axis: fi.axis, pos: fi.pos, out: fi.out, u0: fi.u0, u1: fi.u1, y0: 0, y1: H, t: T, mat: wallMat, opens: [], outline: true };
  const doorU = rng.range(-len * 0.22, len * 0.22);
  front.opens.push({ u: doorU, v: 1.02, w: 1.02, h: 2.04, kind: 'door', state: 'intact' });
  const wins = len > 6.5 ? 2 : 1;
  for (let i = 0; i < wins; i += 1) {
    const u = doorU < 0 ? len * 0.16 + i * len * 0.24 : -len * 0.16 - i * len * 0.24;
    const r = rng.next();
    const state: Opening['state'] = r > 0.62 ? 'boarded' : r > 0.4 ? 'broken' : r > 0.24 ? 'empty' : 'intact';
    front.opens.push({ u, v: 1.5, w: 1.18, h: 1.34, kind: 'win', state });
    if (floors === 2) {
      front.opens.push({ u: u + rng.range(-0.2, 0.2), v: h1 + 0.5 + 1.35, w: 1.05, h: 1.25, kind: 'win', state: r > 0.5 ? 'broken' : 'intact' });
    }
  }
  buildWall(C, front, tier, rng);
  facadeGrime(C, front, rng, main ? 2 : 0);

  const span = alongX ? [rect.z0, rect.z1] : [rect.x0, rect.x1];
  const backPos = fi.pos === span[0] ? span[1] : span[0];
  const back: WallSpec = { axis: fi.axis, pos: backPos, out: fi.out === 1 ? -1 : 1, u0: fi.u0, u1: fi.u1, y0: 0, y1: H, t: T, mat: wallMat, opens: [], outline: true };
  back.opens.push({ u: rng.range(-len * 0.2, len * 0.2), v: 1.45, w: 1.05, h: 1.25, kind: 'win', state: 'empty' });
  buildWall(C, back, tier, rng);

  for (const e of endWalls(fi, rect, T)) {
    const ew: WallSpec = { axis: e.axis, pos: e.pos, out: e.out, u0: e.u0, u1: e.u1, y0: 0, y1: H, t: T, mat: wallMat, opens: [], outline: true };
    ew.opens.push({ u: 0, v: 1.5, w: 0.95, h: 1.15, kind: 'win', state: rng.chance(0.5) ? 'boarded' : 'broken' });
    buildWall(C, ew, tier, rng);
  }

  // —— 山墙双坡顶：屋脊平行临街立面 ——
  const ridge: 'x' | 'z' = alongX ? 'z' : 'x';
  const rise = clamp(depth * 0.26, 0.9, 1.5);
  const rmat = rng.chance(0.4) ? M.roofRust : M.roof;
  gableRoof(C, rng, rect, ridge, H, rise, wallMat, rmat, tier, !o.collapsed);
  if (o.collapsed) {
    // 半塌：掀掉一块顶面、露出椽子与黑窟窿
    C.box(M.dark, rect.x0 + 0.5, rect.x0 + (rect.x1 - rect.x0) * 0.55, H + 0.1, H + rise * 0.8, rect.z0 + 0.5, rect.z1 - 0.5, { shadow: false });
    for (let i = 0; i < 5; i += 1) {
      const rx = rect.x0 + 0.7 + i * ((rect.x1 - rect.x0) * 0.5) / 5;
      C.rod(M.woodDark, 0.06, depth - 0.8, rx, H + rise * 0.55, (rect.z0 + rect.z1) / 2, 'z', 4, { shadow: main });
    }
    for (let i = 0; i < 3; i += 1) {
      const g = new THREE.BoxGeometry(1.1, 0.1, 0.8);
      g.rotateX(rng.range(0.3, 0.9));
      g.rotateZ(rng.range(-0.3, 0.3));
      g.translate(rng.range(rect.x0, rect.x1), H + rng.range(0.2, 0.6), rng.range(rect.z0, rect.z1));
      C.add(g, M.wood, { shadow: main });
    }
  }
  // 烟囱
  const chimX = rng.chance(0.5) ? rect.x0 + 0.8 : rect.x1 - 0.8;
  const chimY = H + rise * 0.55;
  C.box(M.brickDark, chimX - 0.28, chimX + 0.28, chimY - 0.2, chimY + 1.15, (rect.z0 + rect.z1) / 2 - 0.28, (rect.z0 + rect.z1) / 2 + 0.28, { outline: main });
  C.box(M.concreteDark, chimX - 0.38, chimX + 0.38, chimY + 1.15, chimY + 1.27, (rect.z0 + rect.z1) / 2 - 0.38, (rect.z0 + rect.z1) / 2 + 0.38, {});
  if (main) {
    peelPatch(C, front, rng, rng.range(-len * 0.3, len * 0.3), rng.range(1.0, H - 0.6), rng.range(0.8, 1.4), rng.range(0.6, 1.1));
    if (rng.chance(0.6)) bulletCluster(C, front, rng, rng.range(-len * 0.35, len * 0.35), rng.range(1.0, H - 0.7));
  }
  rubbleScatter(C, rng, rect, main ? 6 : 3, [M.dirt, M.brickDark, M.soil]);
}

/** 山墙屋顶：实体三棱山墙 + 两坡瓦面板 + 屋脊压条（同 town 的读法） */
function gableRoof(C: Collector, rng: Rng, rect: Rect, ridge: 'x' | 'z', baseY: number, rise: number, wallMat: THREE.Material, roofMat: THREE.Material, tier: Tier, tiles: boolean): void {
  const main = tier !== 'far';
  const w = ridge === 'x' ? rect.x1 - rect.x0 : rect.z1 - rect.z0;
  const d = ridge === 'x' ? rect.z1 - rect.z0 : rect.x1 - rect.x0;
  const cx = (rect.x0 + rect.x1) / 2;
  const cz = (rect.z0 + rect.z1) / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-d / 2, 0);
  shape.lineTo(d / 2, 0);
  shape.lineTo(0, rise);
  shape.closePath();
  const prism = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false, steps: 1, curveSegments: 1 });
  if (ridge === 'x') {
    prism.rotateY(Math.PI / 2);
    prism.translate(cx - w / 2, baseY, cz);
  } else {
    prism.translate(cx, baseY, cz - w / 2);
  }
  C.add(prism, wallMat, { outline: main, shadow: main });

  const half = d / 2;
  const sl = Math.hypot(half, rise) + 0.35;
  const ang = Math.atan2(rise, half);
  for (const s of [1, -1] as const) {
    if (ridge === 'x') {
      const g = new THREE.BoxGeometry(w + 0.5, 0.13, sl);
      g.rotateX(s * ang);
      g.translate(cx, baseY + rise / 2 + 0.07, cz + (s * d) / 4);
      C.add(g, roofMat, { outline: main, shadow: main });
    } else {
      const g = new THREE.BoxGeometry(sl, 0.13, w + 0.5);
      g.rotateZ(-s * ang);
      g.translate(cx + (s * d) / 4, baseY + rise / 2 + 0.07, cz);
      C.add(g, roofMat, { outline: main, shadow: main });
    }
  }
  if (ridge === 'x') C.box(roofMat, cx - w / 2 - 0.2, cx + w / 2 + 0.2, baseY + rise + 0.02, baseY + rise + 0.14, cz - 0.22, cz + 0.22, { shadow: main });
  else C.box(roofMat, cx - 0.22, cx + 0.22, baseY + rise + 0.02, baseY + rise + 0.14, cz - w / 2 - 0.2, cz + w / 2 + 0.2, { shadow: main });
  if (tiles && main) roofTiles(C, rng, rect, ridge, baseY, rise, roofMat === M.roofRust ? M.tileRust : M.tile);
}

/** 叠瓦：沿坡面一列列搭接，全部实例化（一个 draw call） */
function roofTiles(C: Collector, rng: Rng, rect: Rect, ridge: 'x' | 'z', baseY: number, rise: number, mat: THREE.Material): void {
  const w = ridge === 'x' ? rect.x1 - rect.x0 : rect.z1 - rect.z0;
  const d = ridge === 'x' ? rect.z1 - rect.z0 : rect.x1 - rect.x0;
  const cx = (rect.x0 + rect.x1) / 2;
  const cz = (rect.z0 + rect.z1) / 2;
  const half = d / 2;
  const slopeLen = Math.hypot(half, rise);
  const ang = Math.atan2(rise, half);
  const geo = tiles(0);
  for (const s of [1, -1] as const) {
    const tx: InstanceTransform[] = [];
    for (let dist = 0.1; dist < slopeLen; dist += 0.34) {
      const t = dist / slopeLen;
      const y = baseY + rise * (1 - t) + 0.13;
      const perp = (s * half * t);
      const stagger = Math.round(dist / 0.34) % 2 === 0 ? 0 : 0.22;
      for (let a = -w / 2 + stagger + 0.2; a < w / 2; a += 0.44) {
        tx.push({
          position: ridge === 'x' ? new V(cx + a, y, cz + perp + rng.range(-0.02, 0.02)) : new V(cx + perp + rng.range(-0.02, 0.02), y, cz + a),
          rotation: ridge === 'x' ? new THREE.Euler(s * ang, rng.range(-0.03, 0.03), rng.range(-0.03, 0.03)) : new THREE.Euler(rng.range(-0.03, 0.03), 0, -s * ang),
          scale: unitScale,
        });
      }
    }
    C.instanced(geo, mat, tx, false);
  }
}

// ─────────────────────────── 倒塌围墙 / 铁皮棚 / 栅栏 / 杂物 ───────────────────────────

/** 倒塌一段段的砖墙：残段高低参差、局部露出扭曲钢筋、根部碎砖 */
function brokenWall(C: Collector, rng: Rng, x0: number, z0: number, x1: number, z1: number, h: number): void {
  const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
  const len = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
  const nx = clamp(Math.round(len / 1.7), 2, 12);
  const mat = rng.chance(0.6) ? M.brick : M.peel;
  for (let i = 0; i < nx; i += 1) {
    if (rng.chance(0.18)) continue; // 整段塌掉
    const t0 = i / nx;
    const t1 = (i + 0.85) / nx;
    const hh = h * rng.range(0.42, 1);
    const px0 = alongX ? x0 + (x1 - x0) * t0 : x0;
    const px1 = alongX ? x0 + (x1 - x0) * t1 : x1;
    const pz0 = alongX ? z0 : z0 + (z1 - z0) * t0;
    const pz1 = alongX ? z1 : z0 + (z1 - z0) * t1;
    C.box(mat, Math.min(px0, px1) - 0.05, Math.max(px0, px1) + 0.05, 0, hh, Math.min(pz0, pz1) - 0.18, Math.max(pz0, pz1) + 0.18, {});
    // 断口参差：顶上一两颗歪砖
    const g = new THREE.BoxGeometry(0.3, 0.12, 0.2);
    g.translate((Math.min(px0, px1) + Math.max(px0, px1)) / 2, hh + 0.06, (Math.min(pz0, pz1) + Math.max(pz0, pz1)) / 2);
    C.add(g, mat, { shadow: false });
    if (rng.chance(0.3)) {
      // 扭曲钢筋：竖杆 + 弯头
      const bx = (px0 + px1) / 2 + rng.range(-0.4, 0.4);
      const bz = (pz0 + pz1) / 2;
      C.rod(M.rustDark, 0.025, 0.5, bx, hh + 0.2, bz, 'y', 4, { shadow: false });
      C.rod(M.rustDark, 0.025, 0.3, bx + rng.range(-0.15, 0.15), hh + 0.42, bz, alongX ? 'x' : 'z', 4, { shadow: false });
    }
  }
  const tx: InstanceTransform[] = [];
  for (let i = 0; i < Math.round(len * 1.6); i += 1) {
    const t = rng.next();
    tx.push({
      position: new V(alongX ? x0 + (x1 - x0) * t : x0 + rng.range(-0.6, 0.6), rng.range(0.05, 0.2), alongX ? z0 + rng.range(-0.7, 0.7) : z0 + (z1 - z0) * t),
      rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 6), rng.range(0, 3)),
      scale: unitScale.clone().multiplyScalar(rng.range(0.3, 0.8)),
    });
  }
  C.instanced(chunks(0), M.brickDark, tx, false);
}

/** 铁皮棚：波纹铁皮 + 歪斜顶 + 被风掀动的那块板由调用方登记动画 */
function tinShed(C: Collector, rng: Rng, rect: Rect, h = 2.3): void {
  const cx = (rect.x0 + rect.x1) / 2;
  const cz = (rect.z0 + rect.z1) / 2;
  const w = rect.x1 - rect.x0;
  const d = rect.z1 - rect.z0;
  C.box(M.metal, rect.x0, rect.x1, 0.05, h, rect.z0, rect.z1, { outline: false });
  C.box(M.concreteDark, rect.x0 - 0.1, rect.x1 + 0.1, 0, 0.14, rect.z0 - 0.1, rect.z1 + 0.1, {});
  // 墙面波纹（竖向凸棱，明度分层）
  for (let i = 0; i < 6; i += 1) {
    const x = rect.x0 + ((i + 0.5) * w) / 6;
    C.box(M.metalDark, x - 0.04, x + 0.04, 0.2, h - 0.1, rect.z1 - 0.02, rect.z1 + 0.05, { shadow: false });
  }
  const roofG = new THREE.BoxGeometry(w + 0.5, 0.1, d + 0.6);
  roofG.rotateX(0.09);
  roofG.translate(cx, h + 0.1, cz - 0.1);
  C.add(roofG, rng.chance(0.6) ? M.roofRust : M.rust, { shadow: true });
  // 顶上一排瓦楞压条
  for (let i = 0; i < 5; i += 1) {
    const x = rect.x0 + 0.3 + (i * (w - 0.4)) / 4.4;
    C.box(M.rustDark, x - 0.05, x + 0.05, h + 0.14, h + 0.2, rect.z0 - 0.15, rect.z1 + 0.25, { shadow: false });
  }
  // 歪斜的门板（挂在南面）
  const door = new THREE.BoxGeometry(w * 0.32, h * 0.8, 0.08);
  door.rotateZ(-0.05);
  door.translate(cx - w * 0.18, h * 0.4, rect.z1 + 0.08);
  C.add(door, M.woodDark, { shadow: true });
}

// ─────────────────────────── 院子与道具 ───────────────────────────

/** 墙根/塌口碎砖：按材质分组的实例化碎块 */
function rubbleScatter(C: Collector, rng: Rng, rect: Rect, count: number, mats: THREE.Material[]): void {
  const per: InstanceTransform[][] = mats.map(() => []);
  for (let i = 0; i < count; i += 1) {
    const side = rng.int(0, 3);
    const off = rng.range(0.15, 0.95);
    let x: number;
    let z: number;
    if (side === 0) {
      x = rng.range(rect.x0, rect.x1);
      z = rect.z1 + off;
    } else if (side === 1) {
      x = rng.range(rect.x0, rect.x1);
      z = rect.z0 - off;
    } else if (side === 2) {
      x = rect.x1 + off;
      z = rng.range(rect.z0, rect.z1);
    } else {
      x = rect.x0 - off;
      z = rng.range(rect.z0, rect.z1);
    }
    const s = rng.range(0.18, 0.45);
    const tx: InstanceTransform = {
      position: new V(x, 0.03 + s * 0.3, z),
      rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 6), rng.range(0, 3)),
      scale: new V(s, s * rng.range(0.5, 0.8), s),
    };
    per[i % mats.length]!.push(tx);
  }
  mats.forEach((m, i) => C.instanced(chunks(i % 3), m, per[i]!, false));
}

/** 铺地碎砖（巷道与水龙头前的踩踏面） */
function brickFloor(C: Collector, rng: Rng, rect: Rect, count: number): void {
  const tx: InstanceTransform[] = [];
  for (let i = 0; i < count; i += 1) {
    tx.push({
      position: new V(rng.range(rect.x0, rect.x1), 0.055, rng.range(rect.z0, rect.z1)),
      rotation: new THREE.Euler(0, rng.range(-0.5, 0.5) + (rng.chance(0.5) ? Math.PI / 2 : 0), 0),
      scale: new V(rng.range(0.9, 1.3), 0.7, rng.range(0.9, 1.3)),
    });
  }
  C.instanced(bricks(), rng.chance(0.5) ? M.brickDark : M.concreteDark, tx, false);
}

function fenceLine(C: Collector, rng: Rng, x0: number, z0: number, x1: number, z1: number, h: number, broken = 0): void {
  const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
  const len = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
  const n = Math.max(2, Math.round(len / 2.1));
  for (let i = 0; i <= n; i += 1) {
    if (broken > 0 && rng.chance(broken)) continue;
    const t = i / n;
    const px = alongX ? x0 + (x1 - x0) * t : x0 + rng.range(-0.1, 0.1);
    const pz = alongX ? z0 + rng.range(-0.1, 0.1) : z0 + (z1 - z0) * t;
    const ph = h * rng.range(0.86, 1.06);
    const g = new THREE.BoxGeometry(0.13, ph, 0.13);
    if (rng.chance(0.14)) g.rotateZ(rng.range(-0.14, 0.14));
    g.translate(px, ph / 2, pz);
    C.add(g, M.woodDark, { shadow: false });
  }
  const seg = len / n;
  for (let i = 0; i < n; i += 1) {
    const t = (i + 0.5) / n;
    const px = alongX ? x0 + (x1 - x0) * t : x0;
    const pz = alongX ? z0 : z0 + (z1 - z0) * t;
    for (const ry of [0.4, 0.8]) {
      if (broken > 0 && rng.chance(broken * 0.7)) continue;
      C.box(M.wood, alongX ? px - seg / 2 : px - 0.035, alongX ? px + seg / 2 : px + 0.035, h * ry - 0.055, h * ry + 0.055, alongX ? pz - 0.035 : pz - seg / 2, alongX ? pz + 0.035 : pz + seg / 2, { shadow: false });
    }
  }
}

/** 菜地垄沟：土畦 + 起垄 + 一垄垄作物（实例化） */
function vegPlot(C: Collector, rng: Rng, rect: Rect): void {
  C.box(M.soil, rect.x0, rect.x1, 0.02, 0.16, rect.z0, rect.z1, { shadow: false });
  const rows = clamp(Math.round((rect.z1 - rect.z0) / 0.95), 2, 7);
  const ridge: InstanceTransform[] = [];
  const crop: InstanceTransform[] = [];
  for (let r = 0; r < rows; r += 1) {
    const z = rect.z0 + 0.5 + (r * (rect.z1 - rect.z0 - 1)) / Math.max(1, rows - 1);
    ridge.push({ position: new V((rect.x0 + rect.x1) / 2, 0.2, z), rotation: new THREE.Euler(0, 0, 0), scale: new V(rect.x1 - rect.x0 - 0.4, 1.2, 1) });
    for (let i = 0; i < 5; i += 1) {
      if (!rng.chance(0.72)) continue;
      const x = rect.x0 + 0.5 + ((i + rng.range(0.1, 0.9)) * (rect.x1 - rect.x0 - 1)) / 5;
      crop.push({ position: new V(x, 0.34 + rng.range(0, 0.08), z + rng.range(-0.1, 0.1)), rotation: new THREE.Euler(rng.range(-0.1, 0.1), rng.range(0, 3), rng.range(-0.1, 0.1)), scale: new V(1, rng.range(0.7, 1.4), 1) });
    }
  }
  C.instanced(ridgeGeo(), M.soil, ridge, false);
  C.instanced(cropGeo(), M.crop, crop, false);
  // 围一块歪斜的板条小栅栏
  fenceLine(C, rng, rect.x0 - 0.2, rect.z0 - 0.2, rect.x1 + 0.2, rect.z0 - 0.2, 0.8, 0.2);
}

let ridgeCache: THREE.BufferGeometry | null = null;
function ridgeGeo(): THREE.BufferGeometry {
  if (!ridgeCache) ridgeCache = new THREE.BoxGeometry(1, 0.12, 0.4);
  return ridgeCache;
}

let cropCache: THREE.BufferGeometry | null = null;
function cropGeo(): THREE.BufferGeometry {
  if (!cropCache) cropCache = new THREE.ConeGeometry(0.17, 0.42, 5);
  return cropCache;
}

/** 柴堆：三层层叠的圆木 */
function woodStack(C: Collector, rng: Rng, cx: number, cz: number, along: 'x' | 'z'): void {
  const layers = [[5, 0], [4, 0.2], [3, 0.4]];
  for (const [count, dy] of layers) {
    for (let i = 0; i < count; i += 1) {
      const off = (i - (count - 1) / 2) * 0.36 + rng.range(-0.03, 0.03);
      const x = along === 'x' ? cx : cx + off;
      const z = along === 'x' ? cz + off : cz;
      C.rod(rng.chance(0.5) ? M.wood : M.woodDark, 0.14, 2.1 + rng.range(-0.2, 0.2), x, 0.15 + dy, z, along, 6, { shadow: false });
    }
  }
}

/** 油桶（翻倒或直立） */
function barrel(C: Collector, rng: Rng, x: number, z: number, tipped: boolean): void {
  if (!tipped) {
    C.cyl(rng.chance(0.5) ? M.barrel : M.rust, 0.34, 0.92, x, 0.48, z, 8, { shadow: false });
    return;
  }
  const g = new THREE.CylinderGeometry(0.32, 0.32, 0.9, 8);
  g.rotateZ(Math.PI / 2);
  g.translate(x, 0.32, z);
  C.add(g, M.rustDark, { shadow: false });
}

let binCache: THREE.BufferGeometry | null = null;
function binGeo(): THREE.BufferGeometry {
  if (!binCache) {
    binCache = new THREE.CylinderGeometry(0.28, 0.34, 0.86, 8);
    binCache.rotateX(Math.PI / 2);
  }
  return binCache;
}

/** 巷道垃圾：倒地的垃圾桶 + 纸箱堆 */
function trashPile(C: Collector, rng: Rng, x: number, z: number): void {
  C.instanced(binGeo(), M.metalDark, [{ position: new V(x, 0.34, z), rotation: new THREE.Euler(rng.range(-0.1, 0.1), rng.range(0, 6), Math.PI / 2.6), scale: unitScale }], false);
  for (let i = 0; i < 3; i += 1) {
    const s = rng.range(0.34, 0.5);
    const g = new THREE.BoxGeometry(s, s * rng.range(0.6, 0.9), s * rng.range(0.7, 1));
    g.rotateY(rng.range(0, 1.5));
    g.translate(x + rng.range(-0.6, 0.6), s * 0.4 + i * 0.06, z + rng.range(-0.6, 0.6));
    C.add(g, M.paper, { shadow: false });
  }
  rubbleScatter(C, rng, { x0: x - 0.5, x1: x + 0.5, z0: z - 0.5, z1: z + 0.5 }, 4, [M.dirt, M.gravel]);
}

/** 公共水龙头：台座 + 立管 + 出水口 + 水槽 + 湿漉地面 + 一侧的提灯柱 */
function waterPump(C: Collector, rng: Rng, x: number, z: number): void {
  void rng;
  C.box(M.concrete, x - 1.3, x + 1.3, 0.02, 0.14, z - 1.05, z + 1.05, { shadow: false });
  C.box(M.brickDark, x - 0.42, x + 0.42, 0.14, 1.05, z - 0.42, z + 0.42, { outline: false });
  C.cyl(M.metal, 0.1, 0.8, x, 1.42, z, 6, { shadow: false });
  C.cyl(M.metalDark, 0.16, 0.14, x, 1.86, z, 6, { shadow: false });
  C.rod(M.metal, 0.05, 0.55, x, 1.62, z + 0.3, 'z', 5, { shadow: false });
  // 压杆（铨接在泵体侧）
  const lever = new THREE.BoxGeometry(0.09, 0.7, 0.09);
  lever.rotateZ(0.45);
  lever.translate(x + 0.24, 2.05, z);
  C.add(lever, M.rust, { shadow: false });
  // 水槽与水面
  C.box(M.concreteDark, x - 0.5, x + 0.5, 0.14, 0.5, z + 0.7, z + 1.5, {});
  C.box(M.dark, x - 0.42, x + 0.42, 0.4, 0.46, z + 0.78, z + 1.42, { shadow: false });
  // 旁边立柱风灯（暖光面片由 buildQuarters 补发）
  C.box(M.metalDark, x + 1.5, x + 1.62, 0.14, 1.7, z - 1.35, z - 1.23, {});
  C.box(M.rust, x + 1.36, x + 1.76, 1.7, 1.98, z - 1.49, z - 1.09, {});
  // 踩踏碎砖 + 湿痕
  brickFloor(C, rng, { x0: x - 1.7, x1: x + 2.2, z0: z + 0.4, z1: z + 2.4 }, 26);
  const wet = new THREE.CircleGeometry(1.05, 12);
  wet.rotateX(-Math.PI / 2);
  wet.translate(x, 0.145, z + 1.1);
  C.add(wet, M.dirt, { shadow: false });
  // 旁边的长凳
  C.box(M.wood, x - 2.0, x - 0.6, 0.44, 0.52, z - 1.55, z - 0.95, {});
  C.box(M.concreteDark, x - 1.9, x - 1.7, 0.14, 0.46, z - 1.5, z - 1.0, { shadow: false });
  C.box(M.concreteDark, x - 0.9, x - 0.7, 0.14, 0.46, z - 1.5, z - 1.0, { shadow: false });
}

/** 水井：石砌圆口（描边给体块）+ 立柱 + 小顶 + 吊绳水桶 */
function stoneWell(C: Collector, rng: Rng, cx: number, cz: number, outline: boolean): void {
  void rng;
  C.cyl(M.concrete, 0.62, 0.74, cx, 0.39, cz, 10, { outline, shadow: outline });
  const rim = new THREE.TorusGeometry(0.62, 0.075, 4, 12);
  rim.rotateX(Math.PI / 2);
  rim.translate(cx, 0.76, cz);
  C.add(rim, M.trim, { shadow: false });
  C.cyl(M.dark, 0.52, 0.04, cx, 0.68, cz, 8, { shadow: false });
  for (const s of [-1, 1] as const) {
    C.box(M.woodDark, cx + s * 0.6 - 0.07, cx + s * 0.6 + 0.07, 0.7, 2.15, cz - 0.07, cz + 0.07, {});
  }
  C.rod(M.metalDark, 0.05, 1.34, cx, 2.1, cz, 'x', 5, { shadow: false });
  // 小双坡顶（歪一点）
  const roof1 = new THREE.BoxGeometry(1.5, 0.07, 0.95);
  roof1.rotateX(-0.4);
  roof1.translate(cx + 0.03, 2.36, cz - 0.36);
  C.add(roof1, M.roofRust, { shadow: true });
  const roof2 = new THREE.BoxGeometry(1.5, 0.07, 0.95);
  roof2.rotateX(0.52);
  roof2.translate(cx - 0.02, 2.32, cz + 0.36);
  C.add(roof2, M.roofRust, { shadow: true });
  // 吊绳与水桶
  C.rod(M.wood, 0.012, 0.9, cx + 0.2, 1.62, cz, 'y', 4, { shadow: false });
  C.cyl(M.woodDark, 0.16, 0.26, cx + 0.2, 1.05, cz, 7, { shadow: false });
}

// ─────────────────────────── 晾衣绳（摆动动画件） ───────────────────────────

interface Sway {
  obj: THREE.Object3D;
  phase: number;
  amp: number;
  speed: number;
}

/** 带褶皱的衣物片：竖向波纹、下摆更 loose，顶边对齐挂点（pivot 绕挂点摆动） */
function clothGeo(w: number, h: number, phase: number, yaw: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h, 4, 6);
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const f = (h / 2 - y) / h; // 0 顶 → 1 底
    pos.setZ(i, Math.sin((x / w) * Math.PI * 3 + phase) * 0.045 * (0.25 + f) + Math.sin(y * 2.1 + phase) * 0.012 * f);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  g.translate(0, -h / 2, 0);
  g.rotateY(yaw);
  return g;
}

/** 楼房之间的悬垂晾衣绳：sagPath + tubeAlong，衣物挂在绳上随风摆 */
function clothesline(
  C: Collector,
  rng: Rng,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  y: number,
  sag: number,
  items: number,
  swayers: Sway[],
  laundry: THREE.Group,
): void {
  C.cyl(M.woodDark, 0.06, y + 0.06, ax, (y + 0.06) / 2, az, 6, { shadow: false });
  C.cyl(M.woodDark, 0.06, y + 0.06, bx, (y + 0.06) / 2, bz, 6, { shadow: false });
  const from = new V(ax, y, az);
  const to = new V(bx, y, bz);
  const rope = tubeAlong(sagPath(from, to, sag, 8), 0.013, M.metalDark, 14);
  C.add(rope.geometry, M.metalDark, { shadow: false });
  const dx = bx - ax;
  const dz = bz - az;
  const yaw = Math.atan2(-dz, dx);
  const mats = [M.clothA, M.clothB, M.clothC, M.clothD];
  for (let i = 0; i < items; i += 1) {
    const t = (i + 0.62) / (items + 0.7);
    const p = from.clone().lerp(to, t);
    p.y -= Math.sin(Math.PI * t) * sag;
    const phase = rng.range(0, Math.PI * 2);
    // 衫/裤/床单/毛巾混合，轮廓才有高矮错落
    const kind = rng.int(0, 3);
    const w = kind === 3 ? 0.55 : kind === 1 ? 0.46 : kind === 2 ? 1.15 : 0.8;
    const h = kind === 3 ? 0.42 : kind === 1 ? 1.08 : kind === 2 ? 0.86 : 0.92;
    const pivot = new THREE.Group();
    pivot.position.set(p.x, p.y - 0.02, p.z);
    const piece = new THREE.Mesh(clothGeo(w, h, phase, yaw), mats[i % mats.length]);
    piece.castShadow = false;
    piece.receiveShadow = false;
    pivot.add(piece);
    laundry.add(pivot);
    swayers.push({ obj: pivot, phase: rng.range(0, 6.28), amp: rng.range(0.04, 0.1), speed: rng.range(0.6, 1.3) });
  }
}

// ─────────────────────────── 落位守卫与分区总建 ───────────────────────────

/** LOD 档位（以块中心到原点的平面距离计） */
function tierOf(rect: Rect): Tier {
  const dist = Math.hypot((rect.x0 + rect.x1) / 2, (rect.z0 + rect.z1) / 2);
  return dist < 95 ? 'near' : dist < 120 ? 'mid' : 'far';
}

/** 落位总闸：zone 边界留白 + layout.canPlace（压线/越界直接拒绝并警告） */
function withRect(zone: Zone, rect: Rect, draw: (tier: Tier) => void): boolean {
  const m = zone.margin;
  const inside =
    rect.x0 >= zone.x0 + m - 0.05 &&
    rect.x1 <= zone.x1 - m + 0.05 &&
    rect.z0 >= zone.z0 + m - 0.05 &&
    rect.z1 <= zone.z1 - m + 0.05;
  if (!inside || !canPlace(rect, 0.6)) {
    console.warn('[quarters] 落位被拒:', zone.id, rect, 'inside=' + inside);
    return false;
  }
  draw(tierOf(rect));
  return true;
}

/** 西境北段：沿街连排板楼 + 后院平房 + 西侧棚屋带（沿街墙面连续） */
function buildSuburbW1(C: Collector, zone: Zone, rng: Rng, laundry: THREE.Group, swayers: Sway[]): void {
  const blocks: Array<{ z0: number; z1: number; floors: 2 | 3; dilap: number }> = [
    { z0: -88.5, z1: -72, floors: 3, dilap: 0.55 },
    { z0: -69.5, z1: -54, floors: 2, dilap: 0.45 },
    { z0: -51.5, z1: -37, floors: 3, dilap: 0.7 },
    { z0: -34.5, z1: -20, floors: 2, dilap: 0.6 },
  ];
  for (const b of blocks) {
    const rect = { x0: -118.3, x1: -111.3, z0: b.z0, z1: b.z1 };
    withRect(zone, rect, (tier) => panelBlock(C, rng, rect, tier, { front: 'x+', floors: b.floors, dilap: b.dilap }));
  }
  // 后院平房：与沿街板楼之间留 2.4 m 院落窄巷
  const backs: Array<{ z0: number; z1: number; collapsed?: boolean }> = [
    { z0: -87, z1: -78 },
    { z0: -75, z1: -66.5, collapsed: true },
    { z0: -63.5, z1: -55 },
    { z0: -52, z1: -43, collapsed: true },
    { z0: -40, z1: -31 },
    { z0: -28.5, z1: -20.5 },
  ];
  for (const h of backs) {
    const rect = { x0: -125.5, x1: -120.7, z0: h.z0, z1: h.z1 };
    withRect(zone, rect, (tier) => bungalow(C, rng, rect, tier, { front: 'x+', collapsed: h.collapsed }));
  }
  withRect(zone, { x0: -122.2, x1: -118.5, z0: -33.5, z1: -24.5 }, (tier) => {
    void tier;
    clothesline(C, rng, -121.2, -32.8, -121.2, -25.2, 2.1, 0.22, 3, swayers, laundry);
  });
  withRect(zone, { x0: -120.4, x1: -118.8, z0: -58.8, z1: -57.2 }, (tier) => {
    void tier;
    trashPile(C, rng, -119.6, -58);
  });
  // 西侧棚屋带：铁皮棚 / 菜地 / 柴堆 / 倒塌围墙
  const west: Array<Rect & { kind: 'shed' | 'veg' | 'wall' }> = [
    { x0: -136, x1: -130.6, z0: -86, z1: -80.5, kind: 'shed' },
    { x0: -135.8, z0: -76, x1: -130.4, z1: -64.5, kind: 'veg' },
    { x0: -136, x1: -130.6, z0: -50, z1: -44.5, kind: 'shed' },
    { x0: -134.6, x1: -131.4, z0: -38, z1: -24, kind: 'wall' },
  ];
  for (const s of west) {
    withRect(zone, s, (tier) => {
      void tier;
      if (s.kind === 'shed') tinShed(C, rng, s);
      else if (s.kind === 'veg') vegPlot(C, rng, s);
      else brokenWall(C, rng, -133, -38, -133, -24, 1.3);
    });
  }
  withRect(zone, { x0: -129.6, x1: -127.2, z0: -59, z1: -57 }, (tier) => {
    void tier;
    woodStack(C, rng, -128.4, -58, 'z');
  });
  barrel(C, rng, -126.5, -79, rng.chance(0.5));
  barrel(C, rng, -129.2, -49.6, true);
  fenceLine(C, rng, -130.6, -64.5, -126, -64.5, 1.2, 0.2);
}

/** 西境南段：两排板楼夹一条窄巷 + 公共水龙头小广场 */
function buildSuburbW2(C: Collector, zone: Zone, rng: Rng, laundry: THREE.Group, swayers: Sway[]): void {
  const street: Array<{ z0: number; z1: number; floors: 2 | 3; dilap: number; tv?: boolean; lits?: number }> = [
    { z0: 16, z1: 33, floors: 2, dilap: 0.5, tv: true, lits: 2 },
    { z0: 35.2, z1: 52, floors: 3, dilap: 0.7 },
    { z0: 54.2, z1: 71, floors: 2, dilap: 0.45 },
    { z0: 73.2, z1: 88.5, floors: 3, dilap: 0.6 },
  ];
  for (const b of street) {
    const rect = { x0: -118.3, x1: -111.3, z0: b.z0, z1: b.z1 };
    withRect(zone, rect, (tier) => panelBlock(C, rng, rect, tier, { front: 'x+', floors: b.floors, dilap: b.dilap, tv: b.tv, lits: b.lits ?? 0 }));
  }
  // 第二排：中段混入平房，保持"板楼与平房交错"
  const row2: Array<Rect & { kind: 'panel' | 'house'; floors?: 2 | 3; dilap?: number; collapsed?: boolean }> = [
    { x0: -127.9, x1: -120.9, z0: 38, z1: 54, kind: 'panel', floors: 2, dilap: 0.55 },
    { x0: -127.9, x1: -121.9, z0: 56.2, z1: 64, kind: 'house' },
    { x0: -127.9, x1: -120.9, z0: 66, z1: 80, kind: 'panel', floors: 3, dilap: 0.5 },
    { x0: -127.9, x1: -121.9, z0: 82, z1: 88.5, kind: 'house', collapsed: true },
  ];
  for (const b of row2) {
    withRect(zone, b, (tier) => {
      if (b.kind === 'panel') panelBlock(C, rng, b, tier, { front: 'x+', floors: (b.floors ?? 2) as 2 | 3, dilap: b.dilap ?? 0.5 });
      else bungalow(C, rng, b, tier, { front: 'x+', collapsed: b.collapsed });
    });
  }
  // —— 水龙头小广场（HOTSPOTS.suburbPump）——
  const pump = HOTSPOTS.suburbPump;
  withRect(zone, { x0: pump.x - 1.9, x1: pump.x + 1.9, z0: pump.z - 1.8, z1: pump.z + 1.8 }, (tier) => {
    void tier;
    waterPump(C, rng, pump.x, pump.z);
  });
  withRect(zone, { x0: -126.8, x1: -119, z0: 16.6, z1: 34.5 }, (tier) => {
    void tier;
    brickFloor(C, rng, { x0: -126.8, x1: -119, z0: 16.6, z1: 34.5 }, 30);
  });
  withRect(zone, { x0: -127.4, x1: -119.2, z0: 15.9, z1: 17.7 }, (tier) => {
    void tier;
    brokenWall(C, rng, -127, 16.8, -119.5, 16.8, 1.15);
  });
  withRect(zone, { x0: -126.8, x1: -119.8, z0: 19.4, z1: 24.4 }, (tier) => {
    void tier;
    clothesline(C, rng, -126.3, 20.2, -120.4, 23.6, 2.15, 0.24, 4, swayers, laundry);
  });
  withRect(zone, { x0: -126.4, x1: -125.2, z0: 32.8, z1: 34.2 }, (tier) => {
    void tier;
    trashPile(C, rng, -125.8, 33.5);
  });
  // —— 两排之间的窄巷：铺地碎砖 + 倒地垃圾桶 + 纸箱 ——
  withRect(zone, { x0: -120.6, x1: -118.6, z0: 40, z1: 78 }, (tier) => {
    void tier;
    brickFloor(C, rng, { x0: -120.6, x1: -118.6, z0: 40, z1: 78 }, 26);
    trashPile(C, rng, -119.6, 45);
    trashPile(C, rng, -119.4, 63);
    barrel(C, rng, -119.5, 55, true);
  });
  // —— 后院带 ——
  const back: Array<Rect & { kind: 'house' | 'shed' | 'veg'; collapsed?: boolean }> = [
    { x0: -135.9, x1: -130.6, z0: 40, z1: 48.2, kind: 'house' },
    { x0: -135.9, x1: -130.6, z0: 50.4, z1: 58.6, kind: 'house', collapsed: true },
    { x0: -135.9, x1: -130.6, z0: 60.8, z1: 69, kind: 'house' },
    { x0: -136, x1: -130.6, z0: 71.5, z1: 78, kind: 'shed' },
    { x0: -136, x1: -130.4, z0: 80, z1: 88, kind: 'veg' },
  ];
  for (const b of back) {
    withRect(zone, b, (tier) => {
      if (b.kind === 'house') bungalow(C, rng, b, tier, { front: 'x+', collapsed: b.collapsed });
      else if (b.kind === 'shed') tinShed(C, rng, b);
      else vegPlot(C, rng, b);
    });
  }
  withRect(zone, { x0: -136, x1: -130.6, z0: 69.4, z1: 71 }, (tier) => {
    void tier;
    clothesline(C, rng, -135.5, 70.2, -131, 70.2, 2.05, 0.2, 3, swayers, laundry);
  });
  withRect(zone, { x0: -134.6, x1: -131.4, z0: 34.6, z1: 38.6 }, (tier) => {
    void tier;
    woodStack(C, rng, -133, 36.6, 'x');
  });
}

/** 北带西段：平房排 + 倒塌围墙 + 水井 + 后院菜地 */
function buildSuburbN1(C: Collector, zone: Zone, rng: Rng, laundry: THREE.Group, swayers: Sway[]): void {
  const front: Array<Rect & { kind: 'house' | 'shed'; floors?: 1 | 2; collapsed?: boolean }> = [
    { x0: -85.5, x1: -77, z0: -116.3, z1: -111.3, kind: 'house' },
    { x0: -75, x1: -66.5, z0: -116.3, z1: -111.3, kind: 'house', collapsed: true },
    { x0: -64.5, x1: -56, z0: -116.3, z1: -111.3, kind: 'house', floors: 2 },
    { x0: -54, x1: -49.6, z0: -116.3, z1: -111.3, kind: 'shed' },
  ];
  for (const b of front) {
    withRect(zone, b, (tier) => {
      if (b.kind === 'house') bungalow(C, rng, b, tier, { front: 'z+', floors: b.floors ?? 1, collapsed: b.collapsed });
      else tinShed(C, rng, b, 2.2);
    });
  }
  // 中部院带：倒塌围墙整段横贯 + 水井 + 柴堆
  withRect(zone, { x0: -85.4, x1: -59.6, z0: -121.1, z1: -118.9 }, (tier) => {
    void tier;
    brokenWall(C, rng, -85, -120, -60, -120, 1.35);
  });
  withRect(zone, { x0: -79.7, x1: -77.3, z0: -121.1, z1: -118.7 }, (tier) => stoneWell(C, rng, -78.5, -119.9, tier !== 'far'));
  withRect(zone, { x0: -65.2, x1: -62.8, z0: -121.1, z1: -118.9 }, (tier) => {
    void tier;
    woodStack(C, rng, -64, -120, 'x');
  });
  withRect(zone, { x0: -58.3, x1: -56.7, z0: -120.3, z1: -118.7 }, (tier) => {
    void tier;
    trashPile(C, rng, -57.5, -119.5);
  });
  // 后院平房排
  const back: Array<Rect & { kind: 'house' | 'shed'; collapsed?: boolean }> = [
    { x0: -85, x1: -77.5, z0: -127.3, z1: -122.6, kind: 'house' },
    { x0: -75.5, x1: -68, z0: -127.3, z1: -122.6, kind: 'house', collapsed: true },
    { x0: -66, x1: -58.5, z0: -127.3, z1: -122.6, kind: 'house' },
    { x0: -56.5, x1: -49.8, z0: -127.3, z1: -122.6, kind: 'shed' },
  ];
  for (const b of back) {
    withRect(zone, b, (tier) => {
      if (b.kind === 'house') bungalow(C, rng, b, tier, { front: 'z+', collapsed: b.collapsed });
      else tinShed(C, rng, b, 2.15);
    });
  }
  // 远端：菜地 + 晾衣绳 + 棚屋
  withRect(zone, { x0: -84, x1: -72.5, z0: -134, z1: -129 }, (tier) => {
    void tier;
    vegPlot(C, rng, { x0: -84, x1: -72.5, z0: -134, z1: -129 });
  });
  withRect(zone, { x0: -82.6, x1: -71.4, z0: -131.8, z1: -129.6 }, (tier) => {
    void tier;
    clothesline(C, rng, -82, -130.6, -72, -131.3, 2.2, 0.26, 4, swayers, laundry);
  });
  withRect(zone, { x0: -70, x1: -59, z0: -134, z1: -129.4 }, (tier) => {
    void tier;
    vegPlot(C, rng, { x0: -70, x1: -59, z0: -134, z1: -129.4 });
  });
  withRect(zone, { x0: -56.8, x1: -54.2, z0: -132.7, z1: -130.3 }, (tier) => {
    void tier;
    woodStack(C, rng, -55.5, -131.5, 'z');
  });
  withRect(zone, { x0: -54.5, x1: -49.6, z0: -133.8, z1: -129.4 }, (tier) => {
    void tier;
    tinShed(C, rng, { x0: -54.5, x1: -49.6, z0: -133.8, z1: -129.4 }, 2.1);
  });
  fenceLine(C, rng, -86, -116.9, -85, -116.9, 1.3, 0.1);
}

/** 北带中段：夹在巷道与纵街之间的一排平房（maxFloors 2，只放平房与棚屋） */
function buildSuburbN2(C: Collector, zone: Zone, rng: Rng, laundry: THREE.Group, swayers: Sway[]): void {
  const front: Array<Rect & { kind: 'house' | 'shed'; floors?: 1 | 2; collapsed?: boolean }> = [
    { x0: -30.8, x1: -22.6, z0: -116.3, z1: -111.3, kind: 'house' },
    { x0: -20.6, x1: -12.6, z0: -116.3, z1: -111.3, kind: 'house', floors: 2, collapsed: true },
  ];
  for (const b of front) {
    withRect(zone, b, (tier) => {
      if (b.kind === 'house') bungalow(C, rng, b, tier, { front: 'z+', floors: b.floors ?? 1, collapsed: b.collapsed });
      else tinShed(C, rng, b, 2.2);
    });
  }
  // 房前碎砖便道 + 垃圾
  withRect(zone, { x0: -30.4, x1: -13, z0: -118.4, z1: -116.6 }, (tier) => {
    void tier;
    brickFloor(C, rng, { x0: -30.4, x1: -13, z0: -118.4, z1: -116.6 }, 16);
    trashPile(C, rng, -16.5, -117.5);
    barrel(C, rng, -29, -117.6, true);
  });
  // 后院排 + 远端断墙、菜地、棚屋、晾衣绳
  const back: Array<Rect & { kind: 'house' | 'shed'; collapsed?: boolean }> = [
    { x0: -30.8, x1: -23.4, z0: -124, z1: -119.2, kind: 'house', collapsed: true },
    { x0: -21.4, x1: -12.9, z0: -124, z1: -119.2, kind: 'house' },
  ];
  for (const b of back) {
    withRect(zone, b, (tier) => {
      if (b.kind === 'house') bungalow(C, rng, b, tier, { front: 'z+', collapsed: b.collapsed });
      else tinShed(C, rng, b, 2.15);
    });
  }
  withRect(zone, { x0: -30.4, x1: -13, z0: -129.9, z1: -127.7 }, (tier) => {
    void tier;
    brokenWall(C, rng, -30, -128.8, -14, -128.8, 1.3);
  });
  withRect(zone, { x0: -29.8, x1: -19, z0: -134.3, z1: -130.2 }, (tier) => {
    void tier;
    vegPlot(C, rng, { x0: -29.8, x1: -19, z0: -134.3, z1: -130.2 });
    clothesline(C, rng, -28.5, -131.2, -19.5, -132, 2.2, 0.24, 4, swayers, laundry);
  });
  withRect(zone, { x0: -17.5, x1: -12.9, z0: -134.3, z1: -130.4 }, (tier) => {
    void tier;
    tinShed(C, rng, { x0: -17.5, x1: -12.9, z0: -134.3, z1: -130.4 }, 2.1);
  });
}

/** 北带东段：三层板楼一排（南临北环道），后院窄巷 + 平房 + 菜地 */
function buildSuburbN3(C: Collector, zone: Zone, rng: Rng, laundry: THREE.Group, swayers: Sway[]): void {
  const street: Array<{ x0: number; x1: number; floors: 2 | 3; dilap: number; lits?: number }> = [
    { x0: 12.6, x1: 22, floors: 3, dilap: 0.45, lits: 1 },
    { x0: 24, x1: 43, floors: 3, dilap: 0.5 },
    { x0: 45, x1: 63.5, floors: 3, dilap: 0.65 },
    { x0: 65.5, x1: 82, floors: 3, dilap: 0.55 },
    { x0: 84, x1: 88.8, floors: 2, dilap: 0.7 },
  ];
  for (const b of street) {
    const rect = { x0: b.x0, x1: b.x1, z0: -116.5, z1: -111.3 };
    withRect(zone, rect, (tier) => panelBlock(C, rng, rect, tier, { front: 'z+', floors: b.floors, dilap: b.dilap, lits: b.lits ?? 0 }));
  }
  // 后院窄巷（2.2 m）：碎砖铺地 + 垃圾
  withRect(zone, { x0: 13, x1: 88, z0: -118.5, z1: -116.7 }, (tier) => {
    void tier;
    brickFloor(C, rng, { x0: 13, x1: 88, z0: -118.5, z1: -116.7 }, 30);
    trashPile(C, rng, 16, -117.6);
    barrel(C, rng, 30, -117.5, true);
  });
  // 巷北：平房 / 棚屋混合排
  const back: Array<Rect & { kind: 'house' | 'shed'; collapsed?: boolean }> = [
    { x0: 12.6, x1: 20.2, z0: -124.3, z1: -118.7, kind: 'house' },
    { x0: 22.4, x1: 30.4, z0: -124.3, z1: -118.7, kind: 'house', collapsed: true },
    { x0: 32.6, x1: 40.6, z0: -124.3, z1: -118.7, kind: 'house' },
    { x0: 42.8, x1: 50.8, z0: -124.3, z1: -118.7, kind: 'shed' },
    { x0: 53, x1: 60.6, z0: -124.3, z1: -118.7, kind: 'house' },
    { x0: 62.8, x1: 70.4, z0: -124.3, z1: -118.7, kind: 'house', collapsed: true },
    { x0: 72.6, x1: 80.6, z0: -124.3, z1: -118.7, kind: 'house' },
    { x0: 82.8, x1: 88.8, z0: -124.3, z1: -118.7, kind: 'shed' },
  ];
  for (const b of back) {
    withRect(zone, b, (tier) => {
      if (b.kind === 'house') bungalow(C, rng, b, tier, { front: 'z+', collapsed: b.collapsed });
      else tinShed(C, rng, b, 2.2);
    });
  }
  // 远端：菜地垄沟、柴堆、晾衣绳
  const vegs: Rect[] = [
    { x0: 14, x1: 26, z0: -134, z1: -129.2 },
    { x0: 30, x1: 44, z0: -134, z1: -129 },
    { x0: 50, x1: 64, z0: -133.5, z1: -128.6 },
    { x0: 70, x1: 86, z0: -134, z1: -129 },
  ];
  vegs.forEach((v, i) => {
    withRect(zone, v, (tier) => {
      void tier;
      vegPlot(C, rng, v);
      if (i === 1) clothesline(C, rng, v.x0 + 1, -133.2, v.x1 - 1, -132.4, 2.15, 0.24, 4, swayers, laundry);
    });
  });
  withRect(zone, { x0: 45.9, x1: 48.1, z0: -132.6, z1: -130.4 }, (tier) => {
    void tier;
    woodStack(C, rng, 47, -131.5, 'x');
  });
  withRect(zone, { x0: 13.4, x1: 24.6, z0: -127.4, z1: -125.8 }, (tier) => {
    void tier;
    clothesline(C, rng, 14, -126.3, 24, -126.9, 2.1, 0.22, 3, swayers, laundry);
  });
}

/** 西南角末排：紧邻变电站的一排平房 + 后方棚屋与断墙（全部 far 档：不描边、窗只留洞） */
function buildSuburbS(C: Collector, zone: Zone, rng: Rng, laundry: THREE.Group, swayers: Sway[]): void {
  void laundry;
  void swayers;
  const front: Array<Rect & { collapsed?: boolean }> = [
    { x0: -136.8, x1: -129.2, z0: 111.3, z1: 116.3 },
    { x0: -127, x1: -119.2, z0: 111.3, z1: 116.3, collapsed: true },
    { x0: -117, x1: -111.3, z0: 111.3, z1: 116.3 },
  ];
  for (const b of front) {
    withRect(zone, b, (tier) => bungalow(C, rng, b, tier, { front: 'z-', collapsed: b.collapsed }));
  }
  withRect(zone, { x0: -135.5, x1: -129.5, z0: 119.5, z1: 122.8 }, (tier) => {
    void tier;
    tinShed(C, rng, { x0: -135.5, x1: -129.5, z0: 119.5, z1: 122.8 }, 2.2);
  });
  withRect(zone, { x0: -127.9, x1: -113.1, z0: 120.1, z1: 122.5 }, (tier) => {
    void tier;
    brokenWall(C, rng, -127.5, 121.3, -113.5, 121.3, 1.25);
  });
  withRect(zone, { x0: -122.8, x1: -121.2, z0: 116.8, z1: 118.4 }, (tier) => {
    void tier;
    trashPile(C, rng, -122, 117.6);
  });
  barrel(C, rng, -116, 117.6, true);
}

// ─────────────────────────── 入口 ───────────────────────────

export function buildQuarters(ctx: BuildContext): THREE.Group {
  const quarters = new THREE.Group();
  quarters.name = 'quarters';
  const C = new Collector();
  const swayers: Sway[] = [];
  const laundry = new THREE.Group();
  laundry.name = 'quarters-laundry';

  const zones = ZONES.filter((z) => z.use === 'suburb');
  zones.forEach((zone, i) => {
    // 每个分区一条独立随机序列：别的模块并行建设时互不干扰，且整体可复现
    const rng = ctx.rng.fork(20261007 + i * 733);
    switch (zone.id) {
      case 'suburbW1':
        buildSuburbW1(C, zone, rng, laundry, swayers);
        break;
      case 'suburbW2':
        buildSuburbW2(C, zone, rng, laundry, swayers);
        break;
      case 'suburbN1':
        buildSuburbN1(C, zone, rng, laundry, swayers);
        break;
      case 'suburbN2':
        buildSuburbN2(C, zone, rng, laundry, swayers);
        break;
      case 'suburbN3':
        buildSuburbN3(C, zone, rng, laundry, swayers);
        break;
      default:
        buildSuburbS(C, zone, rng, laundry, swayers);
        break;
    }
  });

  C.flush(quarters);
  quarters.add(laundry);

  // —— 暖色锚点 1：老电视闪动（只有发光面片，不占真实点光） ——
  let tvMat: THREE.MeshBasicMaterial | null = null;
  const tv0 = C.tv[0];
  if (tv0) {
    tvMat = glowMaterial(PALETTE.coldLamp, 0.9);
    const tm = new THREE.Mesh(new THREE.PlaneGeometry(tv0.w, tv0.h), tvMat);
    // 往洞口里侧推 2 cm，避免与洞内静态暗底共面闪 z-fighting
    tm.position.set(tv0.x - Math.sin(tv0.rotY) * 0.02, tv0.y, tv0.z - Math.cos(tv0.rotY) * 0.02);
    tm.rotation.y = tv0.rotY;
    quarters.add(tm);
  }

  // —— 暖色锚点 2：提灯暖光面片（水龙头广场） ——
  const lampGlow = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.3), LIT_WARM);
  lampGlow.position.set(-122.43, 1.84, 24.71);
  lampGlow.rotation.y = Math.PI / 2;
  quarters.add(lampGlow);

  // —— 风掀动的铁皮与门板（铰链枢轴 + 阵风时的额外掀角） ——
  interface Flap extends Sway {
    base: number;
    axis: 'x' | 'y' | 'z';
  }
  const flappers: Flap[] = [];
  const shedDoorGeo = new THREE.BoxGeometry(0.06, 1.4, 0.85);
  shedDoorGeo.translate(0, 0, 0.425);
  const shedDoor = new THREE.Mesh(shedDoorGeo, M.woodDark);
  shedDoor.position.set(-130.55, 1.05, 73.35);
  shedDoor.castShadow = false;
  quarters.add(shedDoor);
  flappers.push({ obj: shedDoor, base: -0.5, amp: 0.3, speed: 1.35, phase: 1.1, axis: 'y' });
  const sheetGeo = new THREE.BoxGeometry(1.1, 0.05, 1.5);
  sheetGeo.translate(0.55, 0, 0);
  const sheet = new THREE.Mesh(sheetGeo, M.roofRust);
  sheet.position.set(-133.4, 2.46, 121.05);
  sheet.castShadow = false;
  quarters.add(sheet);
  flappers.push({ obj: sheet, base: 0.42, amp: 0.16, speed: 2.3, phase: 3.4, axis: 'z' });

  // —— 真实点光：本模块只申请 2 盏（暖窗光 + 水龙头提灯） ——
  const winLight = new THREE.PointLight(PALETTE.warmLight, 5.2, 9, 2);
  winLight.position.set(-114.3, 4.4, 26.5);
  ctx.addLight(winLight);
  const lampLight = new THREE.PointLight(PALETTE.warmLight, 3.4, 7, 2);
  lampLight.position.set(-123.6, 2.5, 25.2);
  ctx.addLight(lampLight);

  // —— 动画：全部只改已有对象的数值，循环内零分配 ——
  ctx.ticker.add((t) => {
    for (const s of swayers) s.obj.rotation.z = Math.sin(t * s.speed + s.phase) * s.amp;
  });
  ctx.ticker.add((t) => {
    if (!tvMat) return;
    const flick = 0.5 + 0.5 * hashNoise(Math.floor(t * 7));
    const dark = hashNoise(Math.floor(t * 0.7)) > 0.92 ? 0.12 : 1;
    tvMat.opacity = 0.3 + 0.65 * flick * dark;
  });
  ctx.ticker.add((t) => {
    for (const f of flappers) {
      const gust = hashNoise(Math.floor(t * 2.3 + f.phase * 7)) > 0.88 ? 0.16 : 0;
      f.obj.rotation[f.axis] = f.base + Math.sin(t * f.speed + f.phase) * f.amp + gust;
    }
  });

  // —— 自测数据：mesh / 三角面 / draw call（含描边外壳） ——
  let meshes = 0;
  let tris = 0;
  quarters.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    meshes += 1;
    const geo = m.geometry;
    const n = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1;
    tris += ((geo.index ? geo.index.count : geo.getAttribute('position')?.count ?? 0) / 3) * n;
  });
  quarters.userData['stats'] = { meshes, tris: Math.round(tris), drawCalls: meshes };
  return quarters;
}
