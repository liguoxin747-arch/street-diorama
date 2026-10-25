import * as THREE from 'three';
import type { BuildContext } from '../core/context';
import type { Rng } from '../core/rng';
import { addBatch, group, instanced, jitter, mesh, tubeAlong } from '../core/geo';
import type { InstanceTransform } from '../core/geo';
import { glowMaterial, toonMaterial, withOutline } from '../core/materials';
import { chippedSlab, windowFrameGeometry } from '../core/detail';
import type { Rect } from './layout';
import { reserve } from './occupancy';

/**
 * 定制乡村住宅（参考照片：两层不对称主楼 + 左侧单层开放车库）。
 *
 * 与上一版的关键差别：
 *  - 两段式外墙：**一层整层裸露红砖**，二层灰白抹灰（斑驳、剥落、污渍）；
 *  - **完整四坡顶**：左右两个不等高的四坡屋面，红褐色陶土瓦，檐口风化缺瓦；
 *  - 车库真正敞开：没有半闭卷帘门，保留承重柱与过梁，内部做深阴影；
 *  - 立面按参考图重排：方形窗、深色窗框、白色窗台、深色木门 + 落水管；
 *  - 整栋后移到地块退线之后，门前留出院子和步道（原来正立面压进了人行道）。
 *
 * 建模约定：全部按局部坐标拼装，最后统一 setPosition/rotation/scale；
 * 墙按洞口切格（水密、真穿透）；旋转只支持 90° 的整数倍（轴对齐碰撞盒）。
 */

const BRICK_H = 3.0; // 一层砖墙顶：以下全砖，以上抹灰
const G_H = 3.0; // 车库净高

export interface VillaOptions {
  /** 地图坐标（别墅中心） */
  x: number;
  z: number;
  /** 旋转，必须是 Math.PI/2 的整数倍 */
  rotation?: number;
  /** 整体缩放（默认 1.4：参考图那栋比相邻三层住宅更"体面"） */
  scale?: number;
}

const COLLIDERS: Rect[] = [];
const APERTURES: Rect[] = [];

export function villaColliders(): Rect[] {
  return COLLIDERS;
}
export function villaDoors(): Rect[] {
  return APERTURES;
}

const M = {
  /** 一楼的红砖：偏暖的老砖色，夜里被路灯照到时能读出砖红 */
  brick: toonMaterial(0x7c4a3a, { steps: 2 }),
  /** 砖墙的暗部/湿痕 */
  brickGrime: toonMaterial(0x4a3328, { steps: 2 }),
  /** 灰白抹灰：压暗一档，避免在路灯下变成一片惨白 */
  plaster: toonMaterial(0x8a867b, { steps: 2 }),
  plasterPeel: toonMaterial(0x6f6a5e, { steps: 2 }),
  /** 雨水冲刷留下的污渍（比墙面暗一档） */
  plasterStain: toonMaterial(0x5a5952, { steps: 2 }),
  /** 深色窗框 / 木构件 */
  frame: toonMaterial(0x2f2a24, { steps: 2 }),
  trim: toonMaterial(0x4a453d, { steps: 2 }),
  wood: toonMaterial(0x46352a, { steps: 2 }),
  burntWood: toonMaterial(0x2b241f, { steps: 2 }),
  /** 白色窗台 / 石质压顶 */
  sill: toonMaterial(0xc6c0b1, { steps: 2 }),
  roofTile: toonMaterial(0x8c4c31, { steps: 2 }),
  /** 瓦片暗色变体（受潮/熏黑的那一批） */
  roofTileDark: toonMaterial(0x653121, { steps: 2 }),
  roofDark: toonMaterial(0x4a281a, { steps: 2 }),
  concrete: toonMaterial(0x77736c, { steps: 2 }),
  /** 承重柱的剥落混凝土（比主混凝土暗、粗糙） */
  concretePeel: toonMaterial(0x605c55, { steps: 2 }),
  /** 门前台阶/步道：比墙基暗，避免在夜里白成一片 */
  path: toonMaterial(0x5d5a53, { steps: 2 }),
  steel: toonMaterial(0x4a5057, { steps: 2 }),
  shutterRust: toonMaterial(0x6a4630, { steps: 3 }),
  glass: toonMaterial(0x39444c, { steps: 2 }),
  /** 完整深色窗玻璃：不透明，读作"里面是黑的" */
  glassDark: toonMaterial(0x151c22, { steps: 2 }),
  interior: toonMaterial(0x2c2a26, { steps: 2, emissive: 0x191714, emissiveIntensity: 0.6 }),
  /** 屋顶缝隙里长的杂草 / 墙根杂草 */
  weed: toonMaterial(0x3d4430, { steps: 2 }),
  soot: toonMaterial(0x231f1c, { steps: 2 }),
  void: new THREE.MeshBasicMaterial({ color: 0x05070a }),
};

type Batch = Map<THREE.Material, THREE.BufferGeometry[]>;
const push = (b: Batch, mat: THREE.Material, geo: THREE.BufferGeometry): void => {
  const l = b.get(mat);
  if (l) l.push(geo);
  else b.set(mat, [geo]);
};

interface Hole {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/**
 * 沿 X 方向的墙（固定 z）：按洞口切格，只补实体格。
 * u 为墙内横坐标（0..len，从 x0 起算），v 为高度。
 */
function wallAlongX(
  b: Batch,
  matBrick: THREE.Material,
  matPlaster: THREE.Material,
  x0: number,
  len: number,
  z: number,
  y0: number,
  y1: number,
  depth: number,
  holes: Hole[],
): void {
  const us = new Set<number>([0, len]);
  const vs = new Set<number>([y0, y1]);
  if (y0 < BRICK_H && y1 > BRICK_H) vs.add(BRICK_H);
  for (const h of holes) {
    us.add(Math.max(0, h.u0));
    us.add(Math.min(len, h.u1));
    vs.add(h.v0);
    vs.add(h.v1);
  }
  const uArr = [...us].sort((a, c) => a - c);
  const vArr = [...vs].sort((a, c) => a - c);
  for (let i = 0; i < uArr.length - 1; i += 1) {
    for (let j = 0; j < vArr.length - 1; j += 1) {
      const u0 = uArr[i]!;
      const u1 = uArr[i + 1]!;
      const v0 = vArr[j]!;
      const v1 = vArr[j + 1]!;
      if (u1 - u0 < 0.02 || v1 - v0 < 0.02) continue;
      const midU = (u0 + u1) / 2;
      const midV = (v0 + v1) / 2;
      if (holes.some((h) => midU > h.u0 && midU < h.u1 && midV > h.v0 && midV < h.v1)) continue;
      const g = new THREE.BoxGeometry(u1 - u0, v1 - v0, depth);
      g.translate(x0 + (u0 + u1) / 2, (v0 + v1) / 2, z);
      push(b, v1 <= BRICK_H + 0.01 ? matBrick : matPlaster, g);
    }
  }
}

/** 沿 Z 方向的墙（固定 x） */
function wallAlongZ(
  b: Batch,
  matBrick: THREE.Material,
  matPlaster: THREE.Material,
  z0: number,
  len: number,
  x: number,
  y0: number,
  y1: number,
  depth: number,
  holes: Hole[],
): void {
  const us = new Set<number>([0, len]);
  const vs = new Set<number>([y0, y1]);
  if (y0 < BRICK_H && y1 > BRICK_H) vs.add(BRICK_H);
  for (const h of holes) {
    us.add(Math.max(0, h.u0));
    us.add(Math.min(len, h.u1));
    vs.add(h.v0);
    vs.add(h.v1);
  }
  const uArr = [...us].sort((a, c) => a - c);
  const vArr = [...vs].sort((a, c) => a - c);
  for (let i = 0; i < uArr.length - 1; i += 1) {
    for (let j = 0; j < vArr.length - 1; j += 1) {
      const u0 = uArr[i]!;
      const u1 = uArr[i + 1]!;
      const v0 = vArr[j]!;
      const v1 = vArr[j + 1]!;
      if (u1 - u0 < 0.02 || v1 - v0 < 0.02) continue;
      const midU = (u0 + u1) / 2;
      const midV = (v0 + v1) / 2;
      if (holes.some((h) => midU > h.u0 && midU < h.u1 && midV > h.v0 && midV < h.v1)) continue;
      const g = new THREE.BoxGeometry(depth, v1 - v0, u1 - u0);
      g.translate(x, (v0 + v1) / 2, z0 + (u0 + u1) / 2);
      push(b, v1 <= BRICK_H + 0.01 ? matBrick : matPlaster, g);
    }
  }
}

/**
 * 窗/门洞的附加件：深色窗框 + 白色窗台 + 内部暗卡 / 木板 / 碎玻璃。
 * 大多数窗是完整深色玻璃（参考图里"窗户内部深邃"），少数才钉木板或破玻璃。
 */
function dressHole(
  b: Batch,
  rng: Rng,
  hole: Hole,
  center: THREE.Vector3,
  outward: THREE.Vector3,
  kind: 'window' | 'door',
): void {
  const w = hole.u1 - hole.u0;
  const h = hole.v1 - hole.v0;
  const dir = Math.atan2(outward.x, outward.z);
  if (kind === 'window') {
    const frame = windowFrameGeometry(w * 0.96, h * 0.96, 0.12, true);
    // 侧墙的窗框要转向：windowFrameGeometry 默认沿 Z 向布深度
    if (Math.abs(outward.x) > Math.abs(outward.z)) frame.rotateY(Math.PI / 2);
    frame.translate(center.x, center.y, center.z);
    push(b, M.frame, frame);

    const roll = rng.next();
    if (roll < 0.16) {
      // 交叉钉死的木板
      for (let k = 0; k < 3; k += 1) {
        const plank = new THREE.BoxGeometry(w * 1.04, 0.16, 0.05);
        plank.rotateZ(rng.range(-0.14, 0.14));
        plank.translate(
          center.x + outward.x * 0.06,
          center.y - h * 0.5 + 0.3 + k * (h / 3.4),
          center.z + outward.z * 0.06,
        );
        push(b, M.wood, plank);
      }
    } else if (roll < 0.34) {
      // 碎玻璃：只保留边框一圈参差的尖角
      const teeth = 9;
      for (let k = 0; k < teeth; k += 1) {
        const t = (k + 0.5) / teeth;
        const ang = t * Math.PI * 2;
        const jx = Math.cos(ang) * w * 0.46;
        const jy = Math.sin(ang) * h * 0.46;
        const len = rng.range(0.05, 0.16);
        const tooth = new THREE.ConeGeometry(len * 0.55, len, 3);
        tooth.scale(1, 1, 0.1);
        tooth.rotateX(Math.PI / 2);
        tooth.rotateZ(-ang);
        tooth.translate(
          center.x + outward.x * 0.01 + jx,
          center.y + jy,
          center.z + outward.z * 0.01,
        );
        tooth.translate(-outward.x * 0.02, 0, -outward.z * 0.02);
        push(b, M.glass, tooth);
      }
      for (let k = 0; k < 2; k += 1) {
        const shard = new THREE.ConeGeometry(rng.range(0.07, 0.18), rng.range(0.14, 0.3), 3);
        shard.scale(1, 1, 0.09);
        shard.rotateY(rng.range(0, 3));
        shard.translate(
          center.x + outward.x * 0.02 + rng.range(-w * 0.3, w * 0.3),
          center.y + rng.range(-h * 0.3, h * 0.3),
          center.z + outward.z * 0.02,
        );
        push(b, M.glass, shard);
      }
    } else {
      // 完整但很暗的玻璃：给一个不透明暗面，隔着窗能看出"有进深"
      const pane = new THREE.PlaneGeometry(w * 0.88, h * 0.88);
      pane.rotateY(dir);
      pane.translate(
        center.x + outward.x * 0.035,
        center.y,
        center.z + outward.z * 0.035,
      );
      push(b, M.glassDark, pane);
    }

    // 白色窗台：向外挑出的薄石板，参考图里最醒目的水平线之一
    const sill = new THREE.BoxGeometry(w * 1.14, 0.11, 0.34);
    if (Math.abs(outward.x) > Math.abs(outward.z)) sill.rotateY(Math.PI / 2);
    sill.translate(
      center.x + outward.x * 0.13,
      center.y - h * 0.5 - 0.06,
      center.z + outward.z * 0.13,
    );
    push(b, M.sill, sill);
  }
  // 暗室内卡片：放在洞口内侧 0.5 m，读作"有进深的暗空间"
  const card = new THREE.PlaneGeometry(w * 0.9, h * 0.9);
  card.rotateY(dir + Math.PI);
  card.translate(center.x - outward.x * 0.5, center.y, center.z - outward.z * 0.5);
  push(b, M.interior, card);
}

/** 主入口：深色双开木门（右扇微开），带门框与门槛 */
function mainDoor(b: Batch, rng: Rng, x: number, z: number, w: number, h: number): void {
  // 门框
  for (const s of [-1, 1] as const) {
    const jamb = new THREE.BoxGeometry(0.1, h + 0.08, 0.16);
    jamb.translate(x + s * (w * 0.5 + 0.05), (h + 0.08) / 2, z + 0.05);
    push(b, M.frame, jamb);
  }
  const head = new THREE.BoxGeometry(w + 0.2, 0.1, 0.16);
  head.translate(x, h + 0.04, z + 0.05);
  push(b, M.frame, head);
  // 两扇深色木门
  for (const s of [-1, 1] as const) {
    const leaf = new THREE.BoxGeometry(w * 0.47, h * 0.96, 0.07);
    if (s === 1) leaf.rotateY(-0.16);
    leaf.translate(x + s * w * 0.235, h * 0.48, z + 0.02);
    push(b, M.wood, leaf);
    // 门板凹槽（上下两块），读得出是木门而不是一块黑板
    for (const py of [0.32, 0.7]) {
      const panel = new THREE.BoxGeometry(w * 0.3, h * 0.24, 0.02);
      panel.translate(x + s * w * 0.235, h * py, z + (s === 1 ? 0.06 : 0.06));
      push(b, M.burntWood, panel);
    }
  }
  const knob = new THREE.SphereGeometry(0.045, 6, 5);
  knob.translate(x - 0.16, h * 0.46, z + 0.11);
  push(b, M.steel, knob);
  void rng;
}

/** 局部坐标 → 世界坐标（供碰撞与内部道具使用） */
function toWorld(px: number, pz: number, opts: VillaOptions): { x: number; z: number } {
  const rot = opts.rotation ?? 0;
  const k = opts.scale ?? 1;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const x = px * k;
  const z = pz * k;
  return { x: opts.x + x * c + z * s, z: opts.z - x * s + z * c };
}

export function createCustomVilla(ctx: BuildContext, opts: VillaOptions): THREE.Group {
  const rotation = ((opts.rotation ?? 0) * 2) / Math.PI;
  const snapped = Math.round(rotation) * (Math.PI / 2);
  const opt: VillaOptions = { ...opts, rotation: snapped };
  const rng = ctx.rng.fork(0x71a1);
  const root = group('custom-villa');
  const b: Batch = new Map();
  const debris: InstanceTransform[] = [];
  const bricks: InstanceTransform[] = [];

  /* ================= 体量（局部坐标） =================
   * 车库：x ∈ [-6.6, -2.0]，z ∈ [-2.6, 3.0]，平顶 3.0
   * 主楼：x ∈ [-2.0, 6.2]，z ∈ [-3.6, 3.6]
   *   ├ 左翼 x ∈ [-2.0, 1.2]，两层高 5.5，四坡顶
   *   └ 右块 x ∈ [ 1.2, 6.2]，两层高 6.2，四坡顶（更高）
   */
  const gx0 = -6.6;
  const gx1 = -2.0;
  const gz0 = -2.6;
  const gz1 = 3.0;
  const hx0 = -2.0;
  const hx1 = 6.2;
  const hz0 = -3.6;
  const hz1 = 3.6;
  const WALL = 0.3;
  const LEFT_X = 1.2;
  const LEFT_TOP = 5.5;
  const RIGHT_TOP = 6.2;
  const SLAB_TOP = G_H + 0.22;
  const frontZ = hz1;

  /* ---------------- 车库 ---------------- */
  const gFloor = new THREE.BoxGeometry(gx1 - gx0, 0.16, gz1 - gz0);
  gFloor.translate((gx0 + gx1) / 2, 0.08, (gz0 + gz1) / 2);
  push(b, M.concrete, gFloor);
  // 后墙（红砖，开一扇小高窗）
  wallAlongX(b, M.brick, M.plaster, gx0, gx1 - gx0, gz0 + WALL / 2, 0, G_H, WALL, [
    { u0: 1.7, u1: 2.6, v0: 1.55, v1: 2.45 },
  ]);
  // 左墙（红砖，完整；只开一扇小窗）
  wallAlongZ(b, M.brick, M.plaster, gz0, gz1 - gz0, gx0 + WALL / 2, 0, G_H, WALL, [
    { u0: 1.7, u1: 2.6, v0: 1.55, v1: 2.45 },
  ]);
  // 墙脚的风化散砖：只贴墙堆一小排，不撒出门
  for (let i = 0; i < 18; i += 1) {
    bricks.push({
      position: new THREE.Vector3(
        gx0 - rng.range(0.05, 0.45),
        rng.range(0.03, 0.14),
        gz0 + rng.range(0.4, gz1 - gz0 - 0.4),
      ),
      rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)),
      scale: new THREE.Vector3(1, 1, 1),
    });
  }
  // 门廊承重柱（砖柱 + 剥落混凝土柱头）
  const porchZ = gz1 + 0.1;
  for (const px of [gx0 + 0.26, gx1 - 0.26]) {
    const col = new THREE.BoxGeometry(0.46, G_H - 0.24, 0.42);
    col.translate(px, (G_H - 0.24) / 2, porchZ);
    push(b, M.brick, col);
    const base = new THREE.BoxGeometry(0.58, 0.22, 0.54);
    base.translate(px, 0.11, porchZ);
    push(b, M.concrete, base);
    const brace = new THREE.BoxGeometry(0.18, 0.42, 0.18);
    brace.rotateX(0.7);
    brace.translate(px, G_H - 0.36, porchZ - 0.18);
    push(b, M.concretePeel, brace);
    for (let i = 0; i < 2; i += 1) {
      const peel = chippedSlab(rng.range(0.16, 0.3), rng.range(0.3, 0.6), 0.03, rng);
      peel.rotateY(rng.range(-0.2, 0.2));
      peel.translate(px + rng.range(-0.17, 0.17), rng.range(0.4, G_H - 0.6), porchZ + 0.19);
      push(b, M.plasterPeel, peel);
    }
  }
  // 混凝土过梁 + 卷起的门轴（门是开着的）
  const lintel = new THREE.BoxGeometry(gx1 - gx0 + 0.2, 0.24, 0.3);
  lintel.translate((gx0 + gx1) / 2, G_H - 0.14, porchZ);
  push(b, M.concrete, lintel);
  const drum = new THREE.CylinderGeometry(0.15, 0.15, gx1 - gx0 - 0.5, 10);
  drum.rotateZ(Math.PI / 2);
  drum.translate((gx0 + gx1) / 2, G_H - 0.35, porchZ - 0.02);
  push(b, M.shutterRust, drum);
  for (const side of [-1, 1]) {
    const cap = new THREE.CylinderGeometry(0.17, 0.17, 0.06, 10);
    cap.rotateZ(Math.PI / 2);
    cap.translate((gx0 + gx1) / 2 + (side * (gx1 - gx0 - 0.5)) / 2, G_H - 0.35, porchZ - 0.02);
    push(b, M.steel, cap);
  }
  // 车库内部衬板 + 暗天花板：让开口真正"深下去"
  const backLining = new THREE.BoxGeometry(gx1 - gx0 - 0.1, G_H - 0.1, 0.04);
  backLining.translate((gx0 + gx1) / 2, (G_H - 0.1) / 2, gz0 + WALL + 0.04);
  push(b, M.interior, backLining);
  const leftLining = new THREE.BoxGeometry(0.04, G_H - 0.1, gz1 - gz0 - 0.1);
  leftLining.translate(gx0 + WALL + 0.04, (G_H - 0.1) / 2, (gz0 + gz1) / 2);
  push(b, M.interior, leftLining);
  const ceiling = new THREE.BoxGeometry(gx1 - gx0 - 0.1, 0.04, gz1 - gz0 - 0.2);
  ceiling.translate((gx0 + gx1) / 2, G_H - 0.16, (gz0 + gz1) / 2);
  push(b, M.interior, ceiling);
  // 车库内部：翻倒的椅子 + 柜子 + 木箱
  const seat = new THREE.BoxGeometry(0.44, 0.06, 0.44);
  seat.rotateX(rng.range(1.2, 1.6));
  seat.rotateY(rng.range(0, 3));
  seat.translate(gx0 + 2.2, 0.3, gz0 + 1.2);
  push(b, M.wood, seat);
  const backrest = new THREE.BoxGeometry(0.44, 0.5, 0.06);
  backrest.rotateX(rng.range(1.2, 1.7));
  backrest.translate(gx0 + 2.2, 0.32, gz0 + 1.55);
  push(b, M.wood, backrest);
  const gCab = new THREE.BoxGeometry(0.9, 1.5, 0.45);
  gCab.rotateZ(rng.range(-0.25, 0.25));
  gCab.translate(gx0 + 1.4, 0.75, gz0 + 2.6);
  push(b, M.wood, gCab);
  for (let i = 0; i < 3; i += 1) {
    const bw = rng.range(0.45, 0.66);
    const bh = rng.range(0.34, 0.52);
    const crate = new THREE.BoxGeometry(bw, bh, bw * 0.8);
    crate.rotateY(rng.range(-0.4, 0.4));
    crate.translate(
      gx0 + 2.0 + i * 0.6 + rng.range(-0.08, 0.08),
      bh / 2 + (i === 2 ? 0.42 : 0),
      gz0 + 3.6 + rng.range(-0.2, 0.2),
    );
    push(b, M.wood, crate);
  }
  // 车库平顶 + 女儿墙 + 积水
  const gRoof = new THREE.BoxGeometry(gx1 - gx0 + 0.5, 0.22, gz1 - gz0 + 0.5);
  gRoof.translate((gx0 + gx1) / 2, G_H + 0.11, (gz0 + gz1) / 2);
  push(b, M.concretePeel, gRoof);
  for (const [px, pz, sx, sz] of [
    [(gx0 + gx1) / 2, gz0 - 0.1, gx1 - gx0 + 0.5, 0.22],
    [gx0 - 0.1, (gz0 + gz1) / 2, 0.22, gz1 - gz0 + 0.5],
    [gx1 + 0.1, (gz0 + gz1) / 2, 0.2, gz1 - gz0 + 0.5],
    [(gx0 + gx1) / 2, gz1 + 0.1, gx1 - gx0 + 0.5, 0.2],
  ] as Array<[number, number, number, number]>) {
    const p = new THREE.BoxGeometry(sx, 0.34, sz);
    p.translate(px, G_H + 0.36, pz);
    push(b, M.concrete, p);
  }
  // 顶面积水只留一小片，避免夜里像一块黑色补丁
  {
    const pool = new THREE.CircleGeometry(0.42, 9);
    pool.scale(1.4, 0.7, 1);
    pool.rotateX(-Math.PI / 2);
    pool.translate((gx0 + gx1) / 2 + rng.range(-0.6, 0.6), G_H + 0.225, (gz0 + gz1) / 2);
    push(b, M.soot, pool);
  }
  for (let i = 0; i < 16; i += 1) {
    debris.push({
      position: new THREE.Vector3(
        gx0 + rng.range(0.6, gx1 - gx0 - 0.6),
        rng.range(0.03, 0.14),
        gz0 + rng.range(0.5, gz1 - gz0 - 0.5),
      ),
      rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)),
      scale: new THREE.Vector3(1, 1, 1).multiplyScalar(rng.range(0.5, 1.2)),
    });
  }

  /* ---------------- 主楼：一层整层红砖 ---------------- */
  const hFloor = new THREE.BoxGeometry(hx1 - hx0, 0.16, hz1 - hz0);
  hFloor.translate((hx0 + hx1) / 2, 0.08, (hz0 + hz1) / 2);
  push(b, M.concrete, hFloor);
  // 正立面：左窗 / 门 / 右窗
  wallAlongX(b, M.brick, M.plaster, hx0, hx1 - hx0, hz1 - WALL / 2, 0, G_H, WALL, [
    { u0: 1.2, u1: 2.4, v0: 1.15, v1: 2.45 },
    { u0: 3.2, u1: 4.4, v0: 0, v1: 2.3 },
    { u0: 5.3, u1: 6.4, v0: 1.15, v1: 2.45 },
  ]);
  // 背面
  wallAlongX(b, M.brick, M.plaster, hx0, hx1 - hx0, hz0 + WALL / 2, 0, G_H, WALL, [
    { u0: 1.4, u1: 2.7, v0: 1.15, v1: 2.45 },
    { u0: 5.2, u1: 6.5, v0: 1.15, v1: 2.45 },
  ]);
  // 两侧
  wallAlongZ(b, M.brick, M.plaster, hz0, hz1 - hz0, hx0 + WALL / 2, 0, G_H, WALL, [
    { u0: 2.0, u1: 3.2, v0: 1.15, v1: 2.45 },
  ]);
  wallAlongZ(b, M.brick, M.plaster, hz0, hz1 - hz0, hx1 - WALL / 2, 0, G_H, WALL, [
    { u0: 1.4, u1: 2.6, v0: 1.15, v1: 2.45 },
  ]);
  // 一层顶板（二层地板）
  // 楼板比墙体缩进 0.06 m：楼层缝读成一道浅浅的阴影线，而不是一条黑带
  const slab = new THREE.BoxGeometry(hx1 - hx0 - 0.12, 0.22, hz1 - hz0 - 0.12);
  slab.translate((hx0 + hx1) / 2, G_H + 0.11, (hz0 + hz1) / 2);
  push(b, M.concrete, slab);

  /* ---------------- 主楼：二层灰白抹灰（左右不等高） ---------------- */
  // 左翼：一层窗顶到 5.5
  wallAlongX(b, M.brick, M.plaster, hx0, LEFT_X - hx0, hz1 - WALL / 2, SLAB_TOP, LEFT_TOP, WALL, [
    { u0: 1.0, u1: 2.4, v0: SLAB_TOP + 0.85, v1: SLAB_TOP + 1.85 },
  ]);
  wallAlongX(b, M.brick, M.plaster, hx0, LEFT_X - hx0, hz0 + WALL / 2, SLAB_TOP, LEFT_TOP, WALL, [
    { u0: 1.2, u1: 2.4, v0: SLAB_TOP + 0.85, v1: SLAB_TOP + 1.85 },
  ]);
  wallAlongZ(b, M.brick, M.plaster, hz0, hz1 - hz0, hx0 + WALL / 2, SLAB_TOP, LEFT_TOP, WALL, [
    { u0: 2.1, u1: 3.3, v0: SLAB_TOP + 0.85, v1: SLAB_TOP + 1.85 },
  ]);
  // 右块：一层窗顶到 6.2
  wallAlongX(b, M.brick, M.plaster, LEFT_X, hx1 - LEFT_X, hz1 - WALL / 2, SLAB_TOP, RIGHT_TOP, WALL, [
    { u0: 1.2, u1: 2.6, v0: SLAB_TOP + 0.93, v1: SLAB_TOP + 2.08 },
    { u0: 3.5, u1: 4.7, v0: SLAB_TOP + 0.93, v1: SLAB_TOP + 2.08 },
  ]);
  wallAlongX(b, M.brick, M.plaster, LEFT_X, hx1 - LEFT_X, hz0 + WALL / 2, SLAB_TOP, RIGHT_TOP, WALL, [
    { u0: 1.0, u1: 2.4, v0: SLAB_TOP + 0.93, v1: SLAB_TOP + 2.08 },
    { u0: 3.3, u1: 4.5, v0: SLAB_TOP + 0.93, v1: SLAB_TOP + 2.08 },
  ]);
  wallAlongZ(b, M.brick, M.plaster, hz0, hz1 - hz0, hx1 - WALL / 2, SLAB_TOP, RIGHT_TOP, WALL, [
    { u0: 2.2, u1: 3.5, v0: SLAB_TOP + 0.93, v1: SLAB_TOP + 2.0 },
  ]);
  // 两个体量之间的分界墙（左翼屋顶以上露出的那一截，参考图里的竖向接缝）
  wallAlongZ(b, M.brick, M.plaster, hz0, hz1 - hz0, LEFT_X + WALL / 2, SLAB_TOP, RIGHT_TOP, WALL, []);
  // 二层室内：暗地板 + 柜子剪影
  const upFloor = new THREE.BoxGeometry(hx1 - hx0, 0.14, hz1 - hz0);
  upFloor.translate((hx0 + hx1) / 2, SLAB_TOP + 0.3, (hz0 + hz1) / 2);
  push(b, M.interior, upFloor);
  const upCab = new THREE.BoxGeometry(1.0, 1.6, 0.45);
  upCab.rotateY(rng.range(0, 3));
  upCab.translate(hx1 - 1.6, SLAB_TOP + 1.1, hz0 + 1.6);
  push(b, M.wood, upCab);

  /* ---------------- 屋顶：两个不等高的四坡顶 ---------------- */
  const tiles: InstanceTransform[] = [];
  const darkTiles: InstanceTransform[] = [];

  /** 由檐口方向和坡向构造瓦片姿态：局部 X=檐口方向，Y=法线，Z=上坡方向 */
  const tilePose = (eaveDir: THREE.Vector3, upDir: THREE.Vector3): THREE.Euler => {
    const n = new THREE.Vector3().crossVectors(eaveDir, upDir).normalize();
    if (n.y < 0) n.negate();
    const m = new THREE.Matrix4().makeBasis(eaveDir, n, upDir);
    return new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromRotationMatrix(m));
  };

  const addUnderlay = (a: THREE.Vector3, bb: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): void => {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([
          a.x, a.y, a.z, bb.x, bb.y, bb.z, c.x, c.y, c.z,
          a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z,
        ]),
        3,
      ),
    );
    g.computeVertexNormals();
    push(b, M.roofDark, g);
  };

  /**
   * 四坡顶。ridge 沿 X：屋脊端点为 (rx0,ridgeY,rz) → (rx1,ridgeY,rz)。
   * 瓦片按瓦垄逐行铺，檐口一排故意多缺几片（风化）。
   */
  const hipRoof = (
    x0: number,
    x1: number,
    z0: number,
    z1: number,
    eaveY: number,
    ridgeY: number,
    rx0: number,
    rx1: number,
    rz: number,
  ): void => {
    const rise = ridgeY - eaveY;
    const slopeQuad = (zEave: number, side: 1 | -1): void => {
      const up = new THREE.Vector3(0, rise, rz - zEave).normalize();
      const eaveDir = new THREE.Vector3(1, 0, 0);
      const rot = tilePose(eaveDir, up);
      const n = new THREE.Vector3().crossVectors(eaveDir, up).normalize();
      if (n.y < 0) n.negate();
      const rows = 6;
      const slopeLen = Math.hypot(rise, rz - zEave);
      const rowDepth = slopeLen / rows;
      for (let r = 0; r < rows; r += 1) {
        const tm = (r + 0.5) / rows;
        const y = eaveY + rise * tm;
        const z = zEave + (rz - zEave) * tm;
        const xl = x0 + (rx0 - x0) * tm;
        const xr = x1 + (rx1 - x1) * tm;
        const w = xr - xl;
        const cols = Math.max(3, Math.round(w / 0.34));
        const tileW = w / cols;
        for (let c = 0; c < cols; c += 1) {
          const x = xl + (c + 0.5) * tileW;
          const missing = rng.chance(r === 0 ? 0.09 : 0.015);
          const dark = missing || rng.chance(0.12);
          const pos = new THREE.Vector3(x, y, z).addScaledVector(n, 0.03);
          const target = missing || dark ? darkTiles : tiles;
          target.push({
            position: pos,
            rotation: rot,
            scale: new THREE.Vector3(tileW * 1.04, missing ? 0.35 : 1, rowDepth * 1.14),
          });
        }
      }
      void side;
    };

    const hipEnd = (xEave: number, rx: number): void => {
      const horiz = rx - xEave;
      const up = new THREE.Vector3(horiz, rise, 0).normalize();
      const eaveDir = new THREE.Vector3(0, 0, 1);
      const rot = tilePose(eaveDir, up);
      const n = new THREE.Vector3().crossVectors(eaveDir, up).normalize();
      if (n.y < 0) n.negate();
      const rows = 5;
      const slopeLen = Math.hypot(rise, horiz);
      const rowDepth = slopeLen / rows;
      for (let r = 0; r < rows; r += 1) {
        const tm = (r + 0.5) / rows;
        const x = xEave + horiz * tm;
        const y = eaveY + rise * tm;
        const zl = z0 + (rz - z0) * tm;
        const zr = z1 + (rz - z1) * tm;
        const w = zr - zl;
        const cols = Math.max(3, Math.round(w / 0.34));
        const tileW = w / cols;
        for (let c = 0; c < cols; c += 1) {
          const z = zl + (c + 0.5) * tileW;
          const missing = rng.chance(r === 0 ? 0.08 : 0.012);
          const dark = missing || rng.chance(0.1);
          const pos = new THREE.Vector3(x, y, z).addScaledVector(n, 0.03);
          const target = missing || dark ? darkTiles : tiles;
          target.push({
            position: pos,
            rotation: rot,
            scale: new THREE.Vector3(tileW * 1.04, missing ? 0.35 : 1, rowDepth * 1.14),
          });
        }
      }
    };

    // 屋面板（缺瓦处露出的深色基层）
    const t = 0.03;
    addUnderlay(
      new THREE.Vector3(x0, eaveY - t, z1),
      new THREE.Vector3(x1, eaveY - t, z1),
      new THREE.Vector3(rx1, ridgeY - t, rz),
      new THREE.Vector3(rx0, ridgeY - t, rz),
    );
    addUnderlay(
      new THREE.Vector3(x1, eaveY - t, z0),
      new THREE.Vector3(x0, eaveY - t, z0),
      new THREE.Vector3(rx0, ridgeY - t, rz),
      new THREE.Vector3(rx1, ridgeY - t, rz),
    );
    addUnderlay(
      new THREE.Vector3(x1, eaveY - t, z1),
      new THREE.Vector3(x1, eaveY - t, z0),
      new THREE.Vector3(rx1, ridgeY - t, rz),
      new THREE.Vector3(rx1, ridgeY - t, rz),
    );
    addUnderlay(
      new THREE.Vector3(x0, eaveY - t, z0),
      new THREE.Vector3(x0, eaveY - t, z1),
      new THREE.Vector3(rx0, ridgeY - t, rz),
      new THREE.Vector3(rx0, ridgeY - t, rz),
    );

    slopeQuad(z1, 1);
    slopeQuad(z0, -1);
    hipEnd(x1, rx1);
    hipEnd(x0, rx0);

    // 屋脊瓦（深色压顶）
    const cap = new THREE.BoxGeometry(rx1 - rx0 + 0.24, 0.13, 0.4);
    cap.rotateX(Math.PI / 4);
    cap.translate((rx0 + rx1) / 2, ridgeY + 0.02, rz);
    push(b, M.roofTileDark, cap);
    for (const x of [rx0, rx1]) {
      const end = new THREE.BoxGeometry(0.3, 0.2, 0.3);
      end.rotateX(Math.PI / 4);
      end.translate(x, ridgeY, rz);
      push(b, M.roofTileDark, end);
    }

    // 封檐板（四边，允许缺一小段）
    const fasciaY = eaveY - 0.08;
    for (const [px, pz, sx, sz] of [
      [(x0 + x1) / 2, z1 + 0.03, x1 - x0, 0.16],
      [(x0 + x1) / 2, z0 - 0.03, x1 - x0, 0.16],
      [x0 - 0.03, (z0 + z1) / 2, 0.16, z1 - z0],
      [x1 + 0.03, (z0 + z1) / 2, 0.16, z1 - z0],
    ] as Array<[number, number, number, number]>) {
      const board = new THREE.BoxGeometry(sx, 0.18, sz);
      board.translate(px, fasciaY, pz);
      push(b, M.trim, board);
    }
  };

  // 左翼四坡顶（低） / 右块四坡顶（高）
  hipRoof(hx0 - 0.45, LEFT_X, hz0 - 0.5, hz1 + 0.5, LEFT_TOP, LEFT_TOP + 1.4, hx0 + 0.15, LEFT_X - 0.55, 0);
  hipRoof(LEFT_X, hx1 + 0.45, hz0 - 0.5, hz1 + 0.5, RIGHT_TOP, RIGHT_TOP + 1.85, LEFT_X + 1.45, hx1 - 1.15, 0);

  const tileGeo = new THREE.BoxGeometry(1, 0.045, 1);
  if (tiles.length) {
    const t = instanced(tileGeo, M.roofTile, tiles);
    t.name = 'villa-roof-tiles';
    t.castShadow = false;
    root.add(t);
  }
  if (darkTiles.length) {
    const t = instanced(tileGeo, M.roofTileDark, darkTiles);
    t.name = 'villa-roof-tiles-dark';
    t.castShadow = false;
    root.add(t);
  }

  // 屋顶边缘的杂草：檐口与屋脊各几簇
  for (let i = 0; i < 10; i += 1) {
    const onLeft = i < 4;
    const x = onLeft
      ? hx0 + rng.range(-0.2, LEFT_X - hx0)
      : LEFT_X + rng.range(0, hx1 - LEFT_X);
    const eave = onLeft ? LEFT_TOP : RIGHT_TOP;
    const z = rng.chance(0.5) ? hz1 + 0.4 : hz0 - 0.4;
    for (let k = 0; k < 3; k += 1) {
      const blade = new THREE.BoxGeometry(0.035, rng.range(0.14, 0.3), 0.02);
      blade.rotateZ(rng.range(-0.5, 0.5));
      blade.translate(x + rng.range(-0.12, 0.12), eave + 0.12, z + rng.range(-0.08, 0.08));
      push(b, M.weed, blade);
    }
  }

  /* ---------------- 门窗附加件 ---------------- */
  // 一层正立面
  dressHole(b, rng, { u0: 1.2, u1: 2.4, v0: 1.15, v1: 2.45 }, new THREE.Vector3(hx0 + 1.8, 1.8, frontZ), new THREE.Vector3(0, 0, 1), 'window');
  dressHole(b, rng, { u0: 3.2, u1: 4.4, v0: 0, v1: 2.3 }, new THREE.Vector3(hx0 + 3.8, 1.15, frontZ), new THREE.Vector3(0, 0, 1), 'door');
  dressHole(b, rng, { u0: 5.3, u1: 6.4, v0: 1.15, v1: 2.45 }, new THREE.Vector3(hx0 + 5.85, 1.8, frontZ), new THREE.Vector3(0, 0, 1), 'window');
  mainDoor(b, rng, hx0 + 3.8, frontZ, 1.2, 2.3);
  // 二层正立面：左翼 1 扇 / 右块 2 扇
  dressHole(b, rng, { u0: 1.0, u1: 2.4, v0: SLAB_TOP + 0.85, v1: SLAB_TOP + 1.85 }, new THREE.Vector3(hx0 + 1.7, SLAB_TOP + 1.35, frontZ), new THREE.Vector3(0, 0, 1), 'window');
  dressHole(b, rng, { u0: LEFT_X + 1.2 - hx0, u1: LEFT_X + 2.6 - hx0, v0: SLAB_TOP + 0.93, v1: SLAB_TOP + 2.08 }, new THREE.Vector3(LEFT_X + 1.9, SLAB_TOP + 1.5, frontZ), new THREE.Vector3(0, 0, 1), 'window');
  dressHole(b, rng, { u0: LEFT_X + 3.5 - hx0, u1: LEFT_X + 4.7 - hx0, v0: SLAB_TOP + 0.93, v1: SLAB_TOP + 2.08 }, new THREE.Vector3(LEFT_X + 4.1, SLAB_TOP + 1.5, frontZ), new THREE.Vector3(0, 0, 1), 'window');
  // 背面 / 侧面
  dressHole(b, rng, { u0: 1.4, u1: 2.7, v0: 1.15, v1: 2.45 }, new THREE.Vector3(hx0 + 2.05, 1.8, hz0), new THREE.Vector3(0, 0, -1), 'window');
  dressHole(b, rng, { u0: 5.2, u1: 6.5, v0: 1.15, v1: 2.45 }, new THREE.Vector3(hx0 + 5.85, 1.8, hz0), new THREE.Vector3(0, 0, -1), 'window');
  dressHole(b, rng, { u0: 1.2, u1: 2.4, v0: SLAB_TOP + 0.85, v1: SLAB_TOP + 1.85 }, new THREE.Vector3(hx0 + 1.8, SLAB_TOP + 1.35, hz0), new THREE.Vector3(0, 0, -1), 'window');
  dressHole(b, rng, { u0: 2.0, u1: 3.2, v0: 1.15, v1: 2.45 }, new THREE.Vector3(hx0, 1.8, hz0 + 2.6), new THREE.Vector3(-1, 0, 0), 'window');
  dressHole(b, rng, { u0: 2.1, u1: 3.3, v0: SLAB_TOP + 0.85, v1: SLAB_TOP + 1.85 }, new THREE.Vector3(hx0, SLAB_TOP + 1.35, hz0 + 2.7), new THREE.Vector3(-1, 0, 0), 'window');
  dressHole(b, rng, { u0: 1.4, u1: 2.6, v0: 1.15, v1: 2.45 }, new THREE.Vector3(hx1, 1.8, hz0 + 2.0), new THREE.Vector3(1, 0, 0), 'window');
  dressHole(b, rng, { u0: 2.2, u1: 3.5, v0: SLAB_TOP + 0.93, v1: SLAB_TOP + 2.0 }, new THREE.Vector3(hx1, SLAB_TOP + 1.47, hz0 + 2.85), new THREE.Vector3(1, 0, 0), 'window');

  /* ---------------- 台阶、步道、落水管 ---------------- */
  for (let i = 0; i < 3; i += 1) {
    const s = new THREE.BoxGeometry(1.9, 0.15, 0.34);
    s.translate(hx0 + 3.8, 0.075 + i * 0.15, frontZ + 0.3 + (2 - i) * 0.32);
    push(b, M.path, s);
  }
  // 门前小步道：三块磨损的混凝土板，板缝里长草
  for (let i = 0; i < 3; i += 1) {
    const slabPath = new THREE.BoxGeometry(1.7, 0.07, 0.72);
    slabPath.rotateY(rng.range(-0.03, 0.03));
    slabPath.translate(
      hx0 + 3.85 + rng.range(-0.06, 0.06),
      0.035,
      frontZ + 1.7 + i * 0.82,
    );
    push(b, M.path, slabPath);
  }
  // 落水管：门左侧、两个体量接缝处，从檐口到地面（深色锌皮）
  const pipeX = hx0 + 2.95;
  const pipeTop = RIGHT_TOP - 0.1;
  const pipe = new THREE.CylinderGeometry(0.055, 0.055, pipeTop, 8);
  pipe.translate(pipeX, pipeTop / 2, frontZ + 0.14);
  push(b, M.steel, pipe);
  for (const t of [0.25, 0.62, 0.9]) {
    const clamp = new THREE.CylinderGeometry(0.068, 0.068, 0.05, 8);
    clamp.translate(pipeX, pipeTop * t, frontZ + 0.14);
    push(b, M.frame, clamp);
  }
  const elbow = new THREE.CylinderGeometry(0.055, 0.055, 0.45, 8);
  elbow.rotateX(0.7);
  elbow.translate(pipeX, 0.24, frontZ + 0.32);
  push(b, M.steel, elbow);

  /* ---------------- 风化：砖墙湿痕、抹灰剥落、水渍、弹孔 ---------------- */
  // 砖墙的暗色湿痕（贴地 0.2~0.9 m）
  for (let i = 0; i < 7; i += 1) {
    const patch = chippedSlab(rng.range(0.18, 0.46), rng.range(0.12, 0.28), 0.016, rng);
    patch.rotateY(0);
    patch.translate(
      hx0 + rng.range(0.2, hx1 - hx0 - 0.2),
      rng.range(0.18, 0.85),
      frontZ - 0.012,
    );
    push(b, M.brickGrime, patch);
  }
  // 抹灰层剥落，露出下面的砖（小块、低饱和，避免像橙色涂鸦）
  for (let i = 0; i < 7; i += 1) {
    const peel = chippedSlab(rng.range(0.28, 0.72), rng.range(0.24, 0.5), 0.028, rng);
    const front = rng.chance(0.78);
    if (front) {
      peel.rotateY(0);
      peel.translate(
        hx0 + rng.range(0.6, hx1 - hx0 - 0.6),
        rng.range(SLAB_TOP + 0.6, RIGHT_TOP - 0.9),
        frontZ - 0.018,
      );
    } else {
      peel.rotateY(-Math.PI / 2);
      peel.translate(hx0 - 0.018, rng.range(SLAB_TOP + 0.6, LEFT_TOP - 0.7), hz0 + rng.range(1.2, hz1 - hz0 - 1));
    }
    push(b, rng.chance(0.55) ? M.brickGrime : M.plasterPeel, peel);
  }
  // 从窗台/檐口往下淌的深色水渍
  for (let i = 0; i < 10; i += 1) {
    const front = rng.chance(0.8);
    const w = rng.range(0.14, 0.36);
    const h = rng.range(0.8, 2.2);
    const pts: THREE.Vector2[] = [];
    const n = 7;
    for (let k = 0; k < n; k += 1) {
      const t = k / n;
      const a = t * Math.PI * 2;
      const wide = Math.max(0.18, Math.sin((1 - t) * Math.PI * 0.9));
      pts.push(new THREE.Vector2(Math.cos(a) * w * 0.5 * wide, Math.sin(a) * h * 0.5));
    }
    const stain = new THREE.ShapeGeometry(new THREE.Shape(pts), 2);
    stain.computeVertexNormals();
    const yTop = rng.range(SLAB_TOP + 0.8, RIGHT_TOP - 0.5);
    if (front) {
      stain.translate(hx0 + rng.range(0.6, hx1 - hx0 - 0.6), yTop, frontZ - 0.012);
    } else {
      stain.rotateY(-Math.PI / 2);
      stain.translate(hx0 - 0.012, yTop, hz0 + rng.range(1.0, hz1 - hz0 - 1.0));
    }
    push(b, M.plasterStain, stain);
  }
  // 少量弹孔：战争背景，但不把立面打成筛子
  for (let i = 0; i < 6; i += 1) {
    const front = rng.chance(0.7);
    const x = front ? hx0 + rng.range(0.5, hx1 - hx0 - 0.5) : hx0 + 0.012;
    const z = front ? frontZ - 0.008 : hz0 + rng.range(0.8, hz1 - hz0 - 0.8);
    const y = rng.range(1.3, RIGHT_TOP - 0.9);
    const hole = new THREE.CircleGeometry(rng.range(0.07, 0.12), 8);
    hole.rotateY(front ? 0 : -Math.PI / 2);
    hole.translate(x, y, z);
    push(b, M.void, hole);
    for (let k = 0; k < 4; k += 1) {
      const chip = new THREE.DodecahedronGeometry(0.045, 0);
      chip.translate(x + rng.range(-0.17, 0.17), y + rng.range(-0.17, 0.17), z + (front ? 0.03 : 0.03));
      push(b, M.brick, chip);
    }
  }
  // 墙根的杂草（参考图的荒废感）
  for (let i = 0; i < 26; i += 1) {
    const onGarage = i < 8;
    const x = onGarage ? gx0 + rng.range(0.3, gx1 - gx0 - 0.3) : hx0 + rng.range(0, hx1 - hx0);
    const z = onGarage ? gz1 + rng.range(0.3, 1.0) : frontZ + rng.range(0.25, 1.1);
    for (let k = 0; k < 3; k += 1) {
      const blade = new THREE.BoxGeometry(0.03, rng.range(0.16, 0.42), 0.02);
      blade.rotateZ(rng.range(-0.55, 0.55));
      blade.rotateY(rng.range(-0.6, 0.6));
      blade.translate(x + rng.range(-0.08, 0.08), 0.12, z + rng.range(-0.08, 0.08));
      push(b, M.weed, blade);
    }
  }
  // 院子里的碎砖与混凝土块
  for (let i = 0; i < 22; i += 1) {
    debris.push({
      position: new THREE.Vector3(
        hx0 + rng.range(-0.5, hx1 - hx0 + 0.6),
        rng.range(0.03, 0.12),
        frontZ + rng.range(0.4, 2.2),
      ),
      rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)),
      scale: new THREE.Vector3(1, 1, 1).multiplyScalar(rng.range(0.35, 0.9)),
    });
  }

  /* ---------------- 烟囱 ---------------- */
  const chimX = hx1 - 1.2;
  const chimZ = hz0 + 1.9;
  const chimBase = RIGHT_TOP + 1.1;
  const chimH = 2.0;
  const courses = 5;
  for (let c = 0; c < courses; c += 1) {
    const ch = chimH / courses;
    const cy = chimBase + ch * (c + 0.5);
    const body = new THREE.BoxGeometry(0.62, ch - 0.03, 0.62);
    body.rotateY(c % 2 === 0 ? 0 : 0.04);
    body.translate(chimX, cy, chimZ);
    push(b, M.brick, body);
    const seam = new THREE.BoxGeometry(0.66, 0.02, 0.66);
    seam.translate(chimX, chimBase + ch * (c + 1), chimZ);
    push(b, M.soot, seam);
  }
  const sootTop = new THREE.BoxGeometry(0.64, 0.28, 0.64);
  sootTop.translate(chimX, chimBase + chimH - 0.14, chimZ);
  push(b, M.soot, sootTop);
  const cap = new THREE.BoxGeometry(0.82, 0.1, 0.82);
  cap.translate(chimX, chimBase + chimH + 0.04, chimZ);
  push(b, M.concrete, cap);

  /* ---------------- 暖光：车库深处 + 二层窗内 ---------------- */
  const warmA = mesh(new THREE.SphereGeometry(0.1, 8, 6), glowMaterial(0xffb765, 0.9));
  warmA.position.set(gx0 + 3.6, 2.2, gz0 + 1.5);
  warmA.castShadow = false;
  root.add(warmA);
  const shade = new THREE.CylinderGeometry(0.18, 0.24, 0.15, 8, 1, true);
  shade.translate(gx0 + 3.6, 2.36, gz0 + 1.5);
  push(b, M.steel, shade);
  const lightA = new THREE.PointLight(0xffa050, 4.2, 10, 2);
  lightA.position.copy(warmA.position);
  ctx.addLight(lightA);
  const warmB = mesh(new THREE.SphereGeometry(0.08, 8, 6), glowMaterial(0xff7a2f, 0.85));
  warmB.position.set(hx1 - 1.2, SLAB_TOP + 1.5, hz0 + 1.0);
  warmB.castShadow = false;
  root.add(warmB);
  const lightB = new THREE.PointLight(0xff7a2f, 2.4, 7, 2);
  lightB.position.copy(warmB.position);
  ctx.addLight(lightB);

  /* ---------------- 门前路灯：灯臂朝街道 ---------------- */
  // 立在人行道内侧（世界 z≈12.4），灯头越过路缘照向车道；不再把灯头压在立面上。
  const lampX = 7.0;
  const lampZ = frontZ + 5.0;
  const lampH = 6.4;
  const lampBase = new THREE.CylinderGeometry(0.24, 0.3, 0.34, 8);
  lampBase.translate(lampX, 0.17, lampZ);
  push(b, M.concrete, lampBase);
  const pole = new THREE.CylinderGeometry(0.075, 0.11, lampH, 8);
  pole.translate(lampX, lampH / 2 + 0.3, lampZ);
  push(b, M.steel, pole);
  // 弯臂朝 +Z（世界 -Z，朝大道）
  const armPts = [
    new THREE.Vector3(lampX, lampH + 0.25, lampZ),
    new THREE.Vector3(lampX + 0.06, lampH + 0.7, lampZ + 0.55),
    new THREE.Vector3(lampX + 0.12, lampH + 0.78, lampZ + 1.22),
  ];
  const arm = tubeAlong(armPts, 0.055, M.steel, 10);
  push(b, M.steel, arm.geometry);
  const head = new THREE.CylinderGeometry(0.3, 0.16, 0.22, 10);
  head.translate(lampX + 0.14, lampH + 0.72, lampZ + 1.38);
  push(b, M.steel, head);
  const bulb = mesh(new THREE.CircleGeometry(0.26, 12), glowMaterial(0xffd9a0, 0.55));
  bulb.rotation.x = Math.PI / 2;
  bulb.position.set(lampX + 0.14, lampH + 0.6, lampZ + 1.38);
  bulb.castShadow = false;
  root.add(bulb);
  const lampLight = new THREE.SpotLight(0xbcd2e6, 2.2, 13, Math.PI * 0.36, 0.75, 1.9);
  lampLight.position.set(lampX + 0.14, lampH + 0.58, lampZ + 1.38);
  lampLight.target.position.set(lampX + 0.14, 0.4, lampZ + 3.4);
  lampLight.castShadow = true;
  lampLight.shadow.mapSize.set(1024, 1024);
  lampLight.shadow.camera.near = 0.5;
  lampLight.shadow.camera.far = 24;
  lampLight.shadow.bias = -0.0012;
  lampLight.shadow.normalBias = 0.03;
  root.add(lampLight);
  root.add(lampLight.target);
  ctx.addLight(lampLight);

  // 灯光/火苗微动
  ctx.ticker.add((t) => {
    const f = 0.74 + 0.18 * Math.sin(t * 7.3) + 0.08 * Math.sin(t * 19.1);
    (warmA.material as THREE.MeshBasicMaterial).opacity = Math.max(0.25, f);
    lightA.intensity = 3.2 + f * 2.0;
    const g = 0.72 + 0.2 * Math.sin(t * 5.1 + 1.7) + 0.08 * Math.sin(t * 13.3);
    (warmB.material as THREE.MeshBasicMaterial).opacity = Math.max(0.22, g);
    lightB.intensity = 1.8 + g * 1.2;
  });

  /* ---------------- 合批 + 实例化 + 轮廓 ---------------- */
  for (const [mat, geos] of b) {
    addBatch(root, geos.map((g) => mesh(g, mat)), mat, `villa-${mat.type}`);
  }
  if (bricks.length > 0) {
    const inst = instanced(new THREE.BoxGeometry(0.24, 0.07, 0.12), M.brick, bricks);
    inst.name = 'villa-bricks';
    root.add(inst);
  }
  if (debris.length > 0) {
    const inst = instanced(jitter(new THREE.DodecahedronGeometry(0.12, 0), 0.04, rng.fork(5)), M.concrete, debris);
    inst.name = 'villa-debris';
    inst.castShadow = false;
    root.add(inst);
  }

  root.position.set(opts.x, 0, opts.z);
  root.rotation.y = snapped;
  root.scale.setScalar(opts.scale ?? 1);
  withOutline(root, 0.0044);

  /* ---------------- 碰撞：分块注册 ---------------- */
  const addRect = (x0: number, x1: number, z0: number, z1: number): void => {
    const a = toWorld(x0, z0, opt);
    const c = toWorld(x1, z1, opt);
    COLLIDERS.push({
      x0: Math.min(a.x, c.x),
      x1: Math.max(a.x, c.x),
      z0: Math.min(a.z, c.z),
      z1: Math.max(a.z, c.z),
    });
  };
  // 主楼整块；车库后墙、左墙；车库正面两根承重柱
  addRect(hx0, hx1, hz0, hz1);
  addRect(gx0, gx1, gz0, gz0 + WALL);
  addRect(gx0, gx0 + WALL, gz0, gz1);
  addRect(gx0 + 0.18, gx0 + 0.54, gz1 - 0.08, gz1 + 0.32);
  addRect(gx1 - 0.54, gx1 - 0.18, gz1 - 0.08, gz1 + 0.32);
  // 主门入口：门洞 + 门后进深（可走进去）
  const d0 = toWorld(hx0 + 3.0, hz1 - 4.2, opt);
  const d1 = toWorld(hx0 + 4.6, hz1 + 0.6, opt);
  APERTURES.push({
    x0: Math.min(d0.x, d1.x),
    x1: Math.max(d0.x, d1.x),
    z0: Math.min(d0.z, d1.z),
    z1: Math.max(d0.z, d1.z),
  });
  // 车库敞口：从门前一直通到车库内部（可走进去避雨）
  const g0 = toWorld(gx0 + 0.4, gz0 + 0.8, opt);
  const g1 = toWorld(gx0 + 4.6, gz1 + 2.6, opt);
  APERTURES.push({
    x0: Math.min(g0.x, g1.x),
    x1: Math.max(g0.x, g1.x),
    z0: Math.min(g0.z, g1.z),
    z1: Math.max(g0.z, g1.z),
  });

  // 占位登记：让后续模块与审计知道这块地已被别墅占用
  {
    const a = toWorld(gx0, hz0, opt);
    const c = toWorld(hx1, hz1, opt);
    reserve(
      {
        x0: Math.min(a.x, c.x),
        x1: Math.max(a.x, c.x),
        z0: Math.min(a.z, c.z),
        z1: Math.max(a.z, c.z),
      },
      'structure',
      'villa',
      0.3,
    );
  }

  console.info(
    `[villa] 已生成：红砖一层 + 抹灰二层 + 双四坡顶 + 开放车库，位置 (${opts.x}, ${opts.z})，碰撞 ${COLLIDERS.length} 块，瓦片 ${tiles.length + darkTiles.length} 片`,
  );
  return root;
}
