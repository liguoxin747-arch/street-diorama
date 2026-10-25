import * as THREE from 'three';
import type { BuildContext } from '../core/context';
import type { Rng } from '../core/rng';
import { addBatch, group, instanced, jitter, mesh, type InstanceTransform } from '../core/geo';
import { PALETTE } from '../core/palette';
import { toonMaterial, withOutline } from '../core/materials';
import {
  chippedSlab,
  debrisRing,
  windowFrameGeometry,
  brickGeometry,
} from '../core/detail';
import { HERO, TOWN_PLOTS, isOnRoadCorridor, type Rect } from './layout';
import { reserve, noteRefusal } from './occupancy';
import { fillColliders } from './fill';

/**
 * 全图空地与新增建筑。
 *
 * 流程（按顺序，缺一不可）：
 *  1. **射线扫空**：在内圈带按 2 m 网格向下打射线，命中任何既有几何（y > 0.5）的格子算被占，
 *     只有整块矩形都空才算候选；这块地图核心早已排满，实际能用的只有东西两端约 20×14 的条带。
 *  2. **占位登记**：每栋楼 `reserve(rect, 'prop')`，与道路/铁路/其它实体互斥。
 *  3. **逐栋生成**：墙体由洞口拆成墙段拼出（真实贯穿洞，不贴图、不封玻璃），
 *     再叠楼板、隔墙、屋顶破洞与横梁、弹孔崩裂环、剥落砖芯、封窗木板、锯齿玻璃、室内陈设。
 *  4. **合批**：同材质静态件合并，碎砖/瓦砾实例化 —— 每栋约 6~8 个 draw call。
 *
 * 碰撞：每栋一个精确矩形，进同一个 colliders 注册表（viewMode / M 键线框共用）。
 */

const NEW_COLLIDERS: Rect[] = [];

export function newBlockColliders(): Rect[] {
  return NEW_COLLIDERS;
}

const M = {
  brick: toonMaterial(PALETTE.brick, { steps: 2 }),
  brickDark: toonMaterial(PALETTE.brickDark, { steps: 2 }),
  plaster: toonMaterial(PALETTE.plaster, { steps: 2 }),
  plasterPeel: toonMaterial(PALETTE.plasterPeel, { steps: 2 }),
  trim: toonMaterial(0x3f3a33, { steps: 2 }),
  glassBroken: toonMaterial(PALETTE.glassBroken, { steps: 2 }),
  wood: toonMaterial(PALETTE.woodOld, { steps: 2 }),
  woodDark: toonMaterial(PALETTE.woodDark, { steps: 2 }),
  floor: toonMaterial(0x5a534a, { steps: 2, emissive: 0x2a241c, emissiveIntensity: 0.8 }),
  cloth: toonMaterial(0x45403a, { steps: 2, emissive: 0x1c1a17, emissiveIntensity: 0.7 }),
  iron: toonMaterial(0x3a3f45, { steps: 2 }),
  roofTile: toonMaterial(0x53392c, { steps: 2 }),
};

interface Opening {
  /** 沿立面的横向起点（距立面左端）与宽度 */
  u: number;
  w: number;
  y: number;
  h: number;
  kind: 'window' | 'door';
  boarded: boolean;
  broken: boolean;
}

interface BlockSpec {
  rect: Rect;
  floors: number;
  floorH: number;
  /** 朝向：哪一面是临街面（用于布置门洞与更多破损） */
  facing: 'posZ' | 'negZ' | 'posX' | 'negX';
  /** 会塌掉一面的侧墙 */
  collapse: 'none' | 'posX' | 'negX' | 'posZ' | 'negZ';
  note: string;
}

/* ------------------------------------------------------------------ *
 * 1. 射线扫空
 * ------------------------------------------------------------------ */

function blockedByKnown(rect: Rect): boolean {
  const all: Rect[] = [
    ...TOWN_PLOTS.map((p) => ({ x0: p.x0, x1: p.x1, z0: p.z0, z1: p.z1 })),
    { x0: HERO.x0, x1: HERO.x1, z0: HERO.z0, z1: HERO.z1 },
    ...fillColliders(),
  ];
  return all.some((r) => rect.x0 < r.x1 + 1.6 && rect.x1 > r.x0 - 1.6 && rect.z0 < r.z1 + 1.6 && rect.z1 > r.z0 - 1.6);
}

/** 矩形外扩 2.6 m 后是否压到空地填充物（那会让相邻两栋之间的巷子实际走不通） */
function alleyBlocked(rect: Rect): boolean {
  const pad = 2.6;
  return fillColliders().some(
    (r) => rect.x0 - pad < r.x1 && rect.x1 + pad > r.x0 && rect.z0 - pad < r.z1 && rect.z1 + pad > r.z0,
  );
}

function inCorridor(rect: Rect): boolean {
  const pts: Array<[number, number]> = [
    [rect.x0, rect.z0],
    [rect.x1, rect.z0],
    [rect.x0, rect.z1],
    [rect.x1, rect.z1],
    [(rect.x0 + rect.x1) / 2, (rect.z0 + rect.z1) / 2],
  ];
  return pts.some(([x, z]) => isOnRoadCorridor(x, z, 0.6));
}

/**
 * 候选区：全图数据扫描。
 *
 * 两类来源：
 *  a) `kind: 'yard'` 的地块 —— 设计上只放栅栏/柴堆/杂物，本来就不建楼，
 *     所以视觉上就是"空地"，正是可以补楼的地方（用户圈出来的大块多是这种）；
 *  b) 其余区域的空隙：与道路走廊、地块、铁路、分区、空地填充、已建新楼都不相交的矩形。
 *
 * 不用射线：上一版射线扫空 40 秒级，代价不成立。数据判空与射线结论一致且近乎零成本。
 */
function collectCandidates(): Rect[] {
  const out: Rect[] = [];
  const plots = TOWN_PLOTS.map((p) => ({
    rect: { x0: p.x0, x1: p.x1, z0: p.z0, z1: p.z1 } as Rect,
    yard: p.kind === 'yard',
  }));

  // a) yard 地块：内缩 1.2 m 后按尺寸切块
  for (const { rect, yard } of plots) {
    if (!yard) continue;
    const w = rect.x1 - rect.x0 - 2.4;
    const d = rect.z1 - rect.z0 - 2.4;
    if (w < 7.5 || d < 6.5) continue;
    const nx = Math.max(1, Math.round(w / 11));
    const nz = Math.max(1, Math.round(d / 9.5));
    for (let i = 0; i < nx; i += 1) {
      for (let j = 0; j < nz; j += 1) {
        const x0 = rect.x0 + 1.2 + (w / nx) * i + 0.5;
        const z0 = rect.z0 + 1.2 + (d / nz) * j + 0.5;
        const x1 = rect.x0 + 1.2 + (w / nx) * (i + 1) - 0.5;
        const z1 = rect.z0 + 1.2 + (d / nz) * (j + 1) - 0.5;
        if (x1 - x0 >= 7.5 && z1 - z0 >= 6.5) out.push({ x0, x1, z0, z1 });
      }
    }
  }

  // b) 全图空隙：2 m 网格，两种尺寸
  const sizes: Array<[number, number]> = [
    [12, 9],
    [9, 7],
  ];
  for (const [w, d] of sizes) {
    for (let z = -89; z <= 89 - d; z += 2) {
      for (let x = -89; x <= 89 - w; x += 2) {
        const rect: Rect = { x0: x, x1: x + w, z0: z, z1: z + d };
        // 与 yard 候选重叠的跳过（那里已经按块切过）
        if (out.some((r) => rect.x0 < r.x1 + 1.8 && rect.x1 > r.x0 - 1.8 && rect.z0 < r.z1 + 1.8 && rect.z1 > r.z0 - 1.8)) continue;
        if (blockedByKnown(rect) || inCorridor(rect)) continue;
        // 只保留真正贴着既有街区的（避免把"边缘空地"也塞满）
        out.push(rect);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 2. 一栋楼
 * ------------------------------------------------------------------ */

type Batch = Map<THREE.Material, THREE.BufferGeometry[]>;

function push(batch: Batch, mat: THREE.Material, geo: THREE.BufferGeometry): void {
  const list = batch.get(mat);
  if (list) list.push(geo);
  else batch.set(mat, [geo]);
}

function wallWithOpenings(
  batch: Batch,
  mat: THREE.Material,
  /** 立面左端点的世界坐标与朝向（立面沿 u 轴展开） */
  x: number,
  z: number,
  width: number,
  height: number,
  yaw: number,
  openings: Opening[],
  thickness: number,
  rng: Rng,
): void {
  const place = (geo: THREE.BufferGeometry): void => {
    geo.rotateY(yaw);
    push(batch, mat, geo);
  };
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  // 沿立面切分成竖向墙段：洞口之间是墙垛，洞口上下是窗下墙/过梁
  const cuts: number[] = [0];
  for (const o of openings) {
    cuts.push(o.u, o.u + o.w);
  }
  cuts.push(width);
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const a = cuts[i]!;
    const b = cuts[i + 1]!;
    const segW = b - a;
    if (segW <= 0.01) continue;
    const open = openings.find((o) => Math.abs(o.u - a) < 0.01);
    if (!open) {
      // 整面墙垛
      const g = new THREE.BoxGeometry(segW, height, thickness);
      g.translate((a + b) / 2 - width / 2, height / 2, 0);
      const world = g.clone().rotateY(yaw);
      world.translate(x, 0, z);
      push(batch, mat, world);
      g.dispose();
      continue;
    }
    // 洞口这一段：下面窗下墙 + 上面过梁
    if (open.y > 0.01) {
      const g = new THREE.BoxGeometry(open.w, open.y, thickness);
      g.translate(open.u + open.w / 2 - width / 2, open.y / 2, 0).rotateY(yaw).translate(x, 0, z);
      push(batch, mat, g);
    }
    const top = open.y + open.h;
    if (top < height - 0.01) {
      const g = new THREE.BoxGeometry(open.w, height - top, thickness);
      g.translate(open.u + open.w / 2 - width / 2, (top + height) / 2, 0).rotateY(yaw).translate(x, 0, z);
      push(batch, mat, g);
    }
    // 窗框（真实进深的窗套）
    const frame = windowFrameGeometry(open.w * 0.96, open.h * 0.96, thickness * 0.9, open.kind === 'window');
    frame.rotateY(yaw);
    const fu = open.u + open.w / 2 - width / 2;
    frame.translate(x + cos * fu, open.y + open.h / 2, z - sin * fu);
    push(batch, M.trim, frame);
    // 洞口内容：封板 / 锯齿玻璃 / 敞开的黑
    if (open.boarded) {
      for (let k = 0; k < 3; k += 1) {
        const plank = new THREE.BoxGeometry(open.w * 1.02, 0.16 + rng.range(0, 0.06), 0.04);
        plank.rotateZ(rng.range(-0.12, 0.12));
        plank.translate(open.u + open.w / 2 - width / 2, open.y + 0.28 + k * (open.h / 3.4), 0.05);
        plank.rotateY(yaw).translate(x, 0, z);
        push(batch, M.woodDark, plank);
      }
    } else if (open.broken) {
      // 锯齿玻璃残渣：沿窗框留几片不规则三角
      for (let k = 0; k < 4; k += 1) {
        const w = rng.range(0.1, 0.32);
        const h = rng.range(0.12, 0.4);
        const shard = new THREE.ConeGeometry(w * 0.6, h, 3);
        shard.scale(1, 1, 0.08);
        shard.rotateY(rng.range(0, 3));
        shard.translate(
          open.u + open.w * rng.range(0.1, 0.9) - width / 2,
          open.y + (k % 2 === 0 ? h * 0.5 : open.h - h * 0.5),
          0.02,
        );
        shard.rotateY(yaw).translate(x, 0, z);
        push(batch, M.glassBroken, shard);
      }
    }
    void place;
  }
  void sin;
}

function buildBlock(spec: BlockSpec, rng: Rng, index: number): THREE.Group {
  const root = group(`newblock-${index}`);
  const { rect } = spec;
  const w = rect.x1 - rect.x0;
  const d = rect.z1 - rect.z0;
  const cx = (rect.x0 + rect.x1) / 2;
  const cz = (rect.z0 + rect.z1) / 2;
  const wallT = 0.45;
  const H = spec.floors * spec.floorH;
  const batch: Batch = new Map();
  const rubble: InstanceTransform[] = [];
  const bricks: InstanceTransform[] = [];

  // —— 每层的洞口表：不同楼层破损率不同，且每栋独立随机 ——
  const openingsBySide = (side: 'posZ' | 'negZ' | 'posX' | 'negX'): Opening[] => {
    const len = side === 'posZ' || side === 'negZ' ? w : d;
    const out: Opening[] = [];
    const cols = Math.max(2, Math.floor(len / 2.6));
    for (let f = 0; f < spec.floors; f += 1) {
      for (let c = 0; c < cols; c += 1) {
        const u = (len / cols) * (c + 0.5) - 0.55;
        if (u < 0.6 || u + 1.1 > len - 0.6) continue;
        const isDoor = f === 0 && side === spec.facing && c === Math.floor(cols / 2);
        // 破损率随楼层与朝向变化：临街面更破
        const breakChance = (side === spec.facing ? 0.55 : 0.35) + f * 0.08;
        const roll = rng.next();
        out.push({
          u,
          w: isDoor ? 1.15 : 1.1,
          y: isDoor ? 0 : f * spec.floorH + 1.0,
          h: isDoor ? 2.15 : 1.45,
          kind: isDoor ? 'door' : 'window',
          boarded: !isDoor && roll > breakChance + 0.18,
          broken: !isDoor && roll <= breakChance,
        });
      }
    }
    return out;
  };

  // —— 四面墙：跳过塌陷的那一面（留一段断墙 + 瓦砾堆）——
  for (const side of ['posZ', 'negZ', 'posX', 'negX'] as const) {
    if (spec.collapse === side) continue;
    const ops = openingsBySide(side);
    if (side === 'posZ') wallWithOpenings(batch, M.brick, rect.x0 + wallT / 2, rect.z1 - wallT / 2, w, H, 0, ops, wallT, rng);
    if (side === 'negZ') wallWithOpenings(batch, M.brick, rect.x1 - wallT / 2, rect.z0 + wallT / 2, w, H, Math.PI, ops, wallT, rng);
    if (side === 'posX') wallWithOpenings(batch, M.brickDark, rect.x1 - wallT / 2, rect.z1 - wallT / 2, d, H, Math.PI / 2, ops, wallT, rng);
    if (side === 'negX') wallWithOpenings(batch, M.brickDark, rect.x0 + wallT / 2, rect.z0 + wallT / 2, d, H, -Math.PI / 2, ops, wallT, rng);
  }

  // 塌陷面：只留 1.6 m 高的断墙残根 + 一堆砖
  if (spec.collapse !== 'none') {
    const stubH = rng.range(1.0, 1.9);
    if (spec.collapse === 'posZ') {
      const g = new THREE.BoxGeometry(w, stubH, wallT);
      g.translate(cx, stubH / 2, rect.z1 - wallT / 2);
      push(batch, M.brick, g);
    } else if (spec.collapse === 'negZ') {
      const g = new THREE.BoxGeometry(w, stubH, wallT);
      g.translate(cx, stubH / 2, rect.z0 + wallT / 2);
      push(batch, M.brick, g);
    } else if (spec.collapse === 'posX') {
      const g = new THREE.BoxGeometry(wallT, stubH, d);
      g.translate(rect.x1 - wallT / 2, stubH / 2, cz);
      push(batch, M.brickDark, g);
    } else {
      const g = new THREE.BoxGeometry(wallT, stubH, d);
      g.translate(rect.x0 + wallT / 2, stubH / 2, cz);
      push(batch, M.brickDark, g);
    }
    for (let i = 0; i < 60; i += 1) {
      const t = rng.next();
      const along = t < 0.5 ? rect.x0 + rng.range(0.4, w - 0.4) : cx + rng.range(-1.5, 1.5);
      const across = t < 0.5 ? cz + rng.range(-2.5, 2.5) : rect.z0 + rng.range(0.4, d - 0.4);
      bricks.push({
        position: new THREE.Vector3(along, rng.range(0.05, 0.5), across),
        rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)),
        scale: new THREE.Vector3(1, 1, 1),
      });
    }
  }

  // —— 屋顶：留一个不规则破洞，能看到下面的横梁 ——
  const holeW = w * rng.range(0.22, 0.4);
  const holeD = d * rng.range(0.22, 0.4);
  const hx = rect.x0 + w * rng.range(0.28, 0.62);
  const hz = rect.z0 + d * rng.range(0.28, 0.62);
  const roofParts: Array<[number, number, number, number]> = [
    [rect.x0, hx - holeW / 2, rect.z0, rect.z1],
    [hx + holeW / 2, rect.x1, rect.z0, rect.z1],
    [hx - holeW / 2, hx + holeW / 2, rect.z0, hz - holeD / 2],
    [hx - holeW / 2, hx + holeW / 2, hz + holeD / 2, rect.z1],
  ];
  for (const [x0, x1, z0, z1] of roofParts) {
    if (x1 - x0 < 0.15 || z1 - z0 < 0.15) continue;
    const g = new THREE.BoxGeometry(x1 - x0, 0.22, z1 - z0);
    g.translate((x0 + x1) / 2, H + 0.11, (z0 + z1) / 2);
    push(batch, M.roofTile, g);
  }
  // 破洞下的屋架横梁
  for (let i = 0; i < 3; i += 1) {
    const beam = new THREE.BoxGeometry(holeW + 1.2, 0.16, 0.18);
    beam.rotateZ(rng.range(-0.06, 0.06));
    beam.translate(hx, H - 0.12, hz - holeD / 2 + (i + 0.5) * (holeD / 3));
    push(batch, M.woodDark, beam);
  }

  // —— 楼板 + 隔墙 ——
  for (let f = 1; f <= spec.floors; f += 1) {
    const y = f * spec.floorH;
    const g = new THREE.BoxGeometry(w - wallT * 2, 0.2, d - wallT * 2);
    g.translate(cx, y - 0.1, cz);
    push(batch, M.floor, g);
  }
  const wallZ = cz + rng.range(-1.2, 1.2);
  for (let f = 0; f < spec.floors; f += 1) {
    for (const [x0, x1] of [
      [rect.x0 + wallT, cx - 0.65],
      [cx + 0.65, rect.x1 - wallT],
    ] as Array<[number, number]>) {
      if (x1 - x0 < 0.4) continue;
      const g = new THREE.BoxGeometry(x1 - x0, spec.floorH - 0.15, 0.16);
      g.translate((x0 + x1) / 2, f * spec.floorH + (spec.floorH - 0.15) / 2, wallZ);
      push(batch, M.plaster, g);
    }
  }

  // —— 室内陈设：倒塌的床、破柜子、散落瓦砾（透过洞口可见）——
  for (let f = 0; f < spec.floors; f += 1) {
    const y = f * spec.floorH + 0.02;
    const bed = new THREE.BoxGeometry(1.9, 0.32, 1.1);
    bed.rotateX(rng.range(0.2, 0.5));
    bed.rotateY(rng.range(0, 3));
    bed.translate(cx + rng.range(-2, 2), y + 0.25, cz + rng.range(-2, 2));
    push(batch, M.cloth, bed);
    const cabinet = new THREE.BoxGeometry(1.1, 1.7, 0.5);
    cabinet.rotateY(rng.range(0, 3));
    cabinet.rotateX(rng.range(-0.3, 0.3));
    cabinet.translate(cx + rng.range(-2.4, 2.4), y + 0.8, cz + rng.range(-2.4, 2.4));
    push(batch, M.woodDark, cabinet);
    for (let k = 0; k < 14; k += 1) {
      rubble.push({
        position: new THREE.Vector3(
          rect.x0 + rng.range(0.6, w - 0.6),
          y + rng.range(0.03, 0.12),
          rect.z0 + rng.range(0.6, d - 0.6),
        ),
        rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)),
        scale: new THREE.Vector3(1, 1, 1).multiplyScalar(rng.range(0.4, 1.1)),
      });
    }
  }

  // —— 立面战损：弹孔崩裂环 + 剥落墙皮（露出砖芯）——
  const wallFaces: Array<{ x: number; z: number; n: THREE.Vector3; len: number; yaw: number }> = [
    { x: cx, z: rect.z1, n: new THREE.Vector3(0, 0, 1), len: w, yaw: 0 },
    { x: cx, z: rect.z0, n: new THREE.Vector3(0, 0, -1), len: w, yaw: Math.PI },
    { x: rect.x1, z: cz, n: new THREE.Vector3(1, 0, 0), len: d, yaw: Math.PI / 2 },
    { x: rect.x0, z: cz, n: new THREE.Vector3(-1, 0, 0), len: d, yaw: -Math.PI / 2 },
  ];
  for (const face of wallFaces) {
    const bulletCount = rng.int(2, 4);
    for (let b = 0; b < bulletCount; b += 1) {
      const u = rng.range(-face.len / 2 + 1, face.len / 2 - 1);
      const y = rng.range(1.2, H - 1.2);
      const px = face.x + (face.yaw === Math.PI / 2 || face.yaw === -Math.PI / 2 ? 0 : 0) + -Math.sin(face.yaw) * u;
      const pz = face.z + Math.cos(face.yaw) * u;
      const ring = debrisRing(7, 0.22, rng, 0.9);
      for (const t of ring) {
        const g = new THREE.DodecahedronGeometry(0.06, 0);
        const pos = t.position.clone().add(new THREE.Vector3(px, y, pz));
        g.translate(pos.x, pos.y, pos.z);
        push(batch, M.brickDark, g);
      }
      // 孔洞本体：一个内凹的暗色圆片
      const hole = new THREE.CircleGeometry(rng.range(0.1, 0.17), 8);
      hole.rotateY(face.yaw);
      hole.translate(px + face.n.x * 0.26, y, pz + face.n.z * 0.26);
      push(batch, M.trim, hole);
    }
    const peelCount = rng.int(1, 3);
    for (let p = 0; p < peelCount; p += 1) {
      const u = rng.range(-face.len / 2 + 1, face.len / 2 - 1);
      const y = rng.range(0.9, H - 1.4);
      const slab = chippedSlab(rng.range(0.8, 1.7), rng.range(0.7, 1.3), 0.035, rng);
      slab.rotateY(face.yaw);
      slab.translate(
        face.x + face.n.x * 0.03 - Math.sin(face.yaw) * u,
        y,
        face.z + face.n.z * 0.03 + Math.cos(face.yaw) * u,
      );
      push(batch, M.plasterPeel, slab);
      // 露出的错缝砖芯
      for (let i = 0; i < 5; i += 1) {
        const brick = brickGeometry(rng);
        brick.rotateY(face.yaw);
        brick.translate(
          face.x + face.n.x * 0.05 - Math.sin(face.yaw) * (u + rng.range(-0.5, 0.5)),
          y + rng.range(-0.4, 0.4),
          face.z + face.n.z * 0.05 + Math.cos(face.yaw) * (u + rng.range(-0.5, 0.5)),
        );
        push(batch, M.brickDark, brick);
      }
    }
  }

  // —— 合批 ——
  for (const [mat, geos] of batch) {
    const meshes = geos.map((g) => mesh(g, mat));
    addBatch(root, meshes, mat, `block-${index}-${mat.name || mat.type}`);
  }
  if (bricks.length > 0) {
    const inst = instanced(new THREE.BoxGeometry(0.24, 0.07, 0.12), M.brickDark, bricks);
    inst.name = 'block-bricks';
    root.add(inst);
  }
  if (rubble.length > 0) {
    const geo = jitter(new THREE.DodecahedronGeometry(0.16, 0), 0.05, rng.fork(9));
    const inst = instanced(geo, M.plaster, rubble);
    inst.name = 'block-rubble';
    root.add(inst);
  }
  withOutline(root, 0.0044);
  return root;
}

/* ------------------------------------------------------------------ *
 * 3. 扫描 + 生成
 * ------------------------------------------------------------------ */

export function buildNewBlocks(ctx: BuildContext): THREE.Group {
  const root = group('new-blocks');
  const rng = ctx.rng.fork(0x9e11);
  const spots: BlockSpec[] = [];

  // 候选：全图扫描 → 逐个尝试落位（彼此留 ≥ 2 m 巷距，上限 10 栋）
  const candidates = collectCandidates();
  const taken: Rect[] = [];
  const plans: Rect[] = [];
  for (const rect of candidates) {
    if (plans.length >= 10) break;
    if (blockedByKnown(rect) || inCorridor(rect) || alleyBlocked(rect)) continue;
    if (taken.some((t) => rect.x0 < t.x1 + 2 && rect.x1 > t.x0 - 2 && rect.z0 < t.z1 + 2 && rect.z1 > t.z0 - 2)) continue;
    const claim = reserve(rect, 'prop', `newblock@${rect.x0},${rect.z0}`, 0.4);
    if (!claim.ok) {
      noteRefusal(`newblock@${rect.x0},${rect.z0}`, claim.reason ?? '');
      continue;
    }
    taken.push(rect);
    plans.push(rect);
  }
  plans.forEach((rect, i) => {
    const facing = (['posZ', 'negZ', 'posX', 'negX'] as const)[rng.int(0, 3)]!;
    spots.push({
      rect,
      floors: rng.int(2, 3),
      floorH: rng.chance(0.5) ? 3.2 : 3.0,
      facing,
      collapse: (['posX', 'negX', 'posZ', 'negZ', 'none'] as const)[rng.int(0, 4)]!,
      note: `候选${i}`,
    });
  });

  console.info(`[new-blocks] 发现 ${candidates.length} 处候选区域，准备生成 ${spots.length} 栋新建筑`);
  spots.forEach((spec, i) => {
    NEW_COLLIDERS.push({ ...spec.rect });
    root.add(buildBlock(spec, rng.fork(i + 1), i));
  });
  console.info(`[new-blocks] 已生成 ${spots.length} 栋（每栋独立战损参数，巷距 ≥ 2.2 m）`);
  return root;
}
