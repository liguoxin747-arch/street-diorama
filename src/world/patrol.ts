import * as THREE from 'three';
import type { BuildContext } from '../core/context';
import type { Rng } from '../core/rng';
import {
  at,
  box,
  capsule,
  cyl,
  group,
  hashNoise,
  instanced,
  mergeMeshes,
  sphere,
  type InstanceTransform,
} from '../core/geo';
import { PALETTE } from '../core/palette';
import { canvasTexture, toonMaterial, withOutline } from '../core/materials';
import { helmetGeometry, rifleGeometry, vestGeometry } from '../core/detail';
import {
  HOTSPOTS,
  ZONES,
  canPlace,
  groundYAt,
  isOnCarriageway,
  isOnRoadCorridor,
  type Rect,
  type Zone,
} from './layout';

/**
 * 巡逻士兵：雨后夜里三名士兵在湿路面上巡视，分别守住
 *  1) 核心区大道北侧人行道（主楼门面与路口之间，保留"道路=视觉引导线"）
 *  2) 北境平民区的北环道南侧人行道（正对拆开的院墙与柴堆地块）
 *  3) 南境哨卡后区的定岗（沙袋墙与岗亭之间的通道，面朝车队缺口）
 *
 * 净空硬约束：绝不踏进任何车行道（含 0.45 m 安全边），绝不进哨卡缺口
 * HOTSPOTS.outpostGap（x∈[-13.2,13.2]），东境工业区（道砟/钢轨/吊具）不派兵。
 * 每条候选线按 0.5 m 采样：人行道带因模块被 canPlace 挡在走廊之外而天然净空；
 * 走廊外的空地（哨卡后区）逐点过 canPlace；中间有一处不通就整条弃用并报 warn。
 *
 * 走路：髋-膝两级枢轴交替摆动、落脚瞬间身体下沉、肩线反向摆、
 * 步枪随重心做阻尼滞后、2~7 秒一次的不规则转头警戒（全部走确定性哈希，无 Math.random）。
 *
 * 脚步声的视觉化：屏幕上不允许任何 UI，所以只用地面本身——
 * 靴底压下的那一瞬间，在落点生成一枚贴地软椭圆"水膜亮斑"（湿地上被踩出的浅槽
 * 反出天光），亮起后被雨冲淡。全部装在单个 InstancedMesh 里 = 1 mesh / 1 draw call。
 */

const MAT = {
  uniform: toonMaterial(0x4b5344, { steps: 3, emissive: 0x0c0f0b }),
  uniformDark: toonMaterial(0x39412f, { steps: 3, emissive: 0x090c08 }),
  vest: toonMaterial(0x3c4436, { steps: 3, emissive: 0x0a0d09 }),
  boots: toonMaterial(0x23261f, { steps: 2 }),
  skin: toonMaterial(PALETTE.skin, { steps: 2 }),
  helmet: toonMaterial(0x444c3c, { steps: 3, emissive: 0x0a0c09 }),
  gun: toonMaterial(0x33373c, { steps: 2 }),
  strap: toonMaterial(0x2a2b26, { steps: 2 }),
};

/** 靴印亮斑池容量（一次 instanced 画完） */
const PRINT_N = 26;
/** 一枚靴印从显形到淡去的基准时长（秒） */
const PRINT_LIFE = 2.9;
/** 离车行道边缘的安全距离：士兵只在路缘石内侧走 */
const CURB_SAFE = 0.45;
/** 哨卡缺口（车队唯一通道）两侧的额外退让 */
const GAP_SAFE = 1.4;
/** 一条巡逻线至少要有这么长才值得派兵 */
const MIN_RUN = 5.5;

interface SoldierParts {
  root: THREE.Group;
  /** 髋枢轴（大腿绕它前后摆） */
  hipL: THREE.Object3D;
  hipR: THREE.Object3D;
  /** 膝枢轴（小腿 + 靴，挂在髋下） */
  shinL: THREE.Object3D;
  shinR: THREE.Object3D;
  armL: THREE.Object3D;
  armR: THREE.Object3D;
  torso: THREE.Object3D;
  head: THREE.Object3D;
  /** 步枪挂点：迈步时做惯性滞后 */
  gun: THREE.Object3D;
}

function buildSoldier(rng: Rng): SoldierParts {
  const root = group('patrol-soldier');

  // —— 腿：髋枢轴 + 膝枢轴（走路时两级交替摆动）——
  const hipPivots: THREE.Object3D[] = [];
  const shinPivots: THREE.Object3D[] = [];
  for (const side of [-1, 1]) {
    const pivot = group('leg-pivot');
    pivot.position.set(side * 0.10, 0.86, 0);
    const thigh = box(0.16, 0.44, 0.18, MAT.uniform);
    at(thigh, 0, -0.22, 0);
    pivot.add(thigh);
    const shinPivot = group('shin-pivot');
    shinPivot.position.set(0, -0.44, 0);
    const shin = box(0.14, 0.40, 0.16, MAT.uniform);
    at(shin, 0, -0.20, 0);
    shinPivot.add(shin);
    const boot = box(0.16, 0.10, 0.27, MAT.boots);
    at(boot, 0, -0.42, 0.045);
    shinPivot.add(boot);
    // 护膝
    const knee = box(0.15, 0.10, 0.06, MAT.uniformDark);
    at(knee, 0, -0.03, 0.085);
    shinPivot.add(knee);
    pivot.add(shinPivot);
    root.add(withOutline(pivot, 0.0018));
    hipPivots.push(pivot);
    shinPivots.push(shinPivot);
  }

  // —— 躯干 ——
  const torso = group('torso');
  torso.position.y = 0.86;
  root.add(torso);

  const torsoBits: THREE.Mesh[] = [];
  torsoBits.push(box(0.44, 0.44, 0.26, MAT.uniform));
  // 腰
  const waist = box(0.38, 0.12, 0.24, MAT.uniformDark);
  at(waist, 0, 0.28, 0);
  torsoBits.push(waist);
  // 肩
  const shoulders = box(0.50, 0.12, 0.27, MAT.uniform);
  at(shoulders, 0, -0.16, 0);
  torsoBits.push(shoulders);
  const torsoMesh = mergeMeshes(torsoBits, MAT.uniform);
  if (torsoMesh) {
    torsoMesh.name = 'patrol-torso';
    withOutline(torsoMesh, 0.002);
    torso.add(torsoMesh);
  }
  // 防弹背心（有厚度 + 弹匣袋）
  const vest = vestGeometry(0.42, 0.34, 0.28);
  const vestBody = new THREE.Mesh(vest.body, MAT.vest);
  at(vestBody, 0, 0.02, 0.01);
  torso.add(vestBody);
  const pouches = new THREE.Mesh(vest.pouches, MAT.vest);
  at(pouches, 0, 0.02, 0.01);
  torso.add(pouches);
  // 腰带 + 水壶
  const belt = box(0.40, 0.06, 0.26, MAT.strap);
  at(belt, 0, 0.16, 0);
  torso.add(belt);
  const canteen = cyl(0.055, 0.055, 0.14, 8, MAT.uniformDark);
  at(canteen, -0.20, 0.14, -0.10);
  torso.add(canteen);

  // —— 手臂（用枢轴，端枪姿势下只做反向微摆）——
  const armPivots: THREE.Object3D[] = [];
  for (const side of [-1, 1]) {
    const pivot = group('arm-pivot');
    pivot.position.set(side * 0.26, 0.30, 0);
    const upper = capsule(0.068, 0.26, MAT.uniform);
    at(upper, 0, -0.14, 0);
    pivot.add(upper);
    const fore = capsule(0.058, 0.24, MAT.uniform);
    at(fore, 0, -0.38, 0.02);
    pivot.add(fore);
    const hand = sphere(0.055, MAT.skin, 8);
    at(hand, 0, -0.52, 0.03);
    pivot.add(hand);
    torso.add(withOutline(pivot, 0.0016));
    armPivots.push(pivot);
  }

  // —— 头 ——
  const head = group('head');
  head.position.y = 0.30;
  torso.add(head);
  const neck = cyl(0.05, 0.05, 0.08, 8, MAT.skin);
  at(neck, 0, 0.02, 0);
  head.add(neck);
  const skull = sphere(0.108, MAT.skin, 10);
  at(skull, 0, 0.13, 0);
  head.add(skull);
  const helmet = new THREE.Mesh(helmetGeometry(0.125), MAT.helmet);
  at(helmet, 0, 0.15, -0.004);
  head.add(withOutline(helmet, 0.0018));

  // —— 步枪：挂在躯干前的枢轴上，迈步时整组带惯性滞后地晃 ——
  const gun = group('gun-pivot');
  gun.position.set(0.16, 0.10, 0.16);
  torso.add(gun);
  const rifle = new THREE.Mesh(rifleGeometry(), MAT.gun);
  rifle.rotation.set(0.42, 0.34, 0.30);
  gun.add(rifle);
  const sling = box(0.025, 0.02, 0.44, MAT.strap);
  at(sling, -0.06, 0.12, -0.14);
  sling.rotation.set(0.9, 0.1, 0.42);
  gun.add(sling);

  // 轻微体型差异
  root.scale.setScalar(0.97 + rng.gauss(0, 0.02));

  return {
    root,
    hipL: hipPivots[0] as THREE.Object3D,
    hipR: hipPivots[1] as THREE.Object3D,
    shinL: shinPivots[0] as THREE.Object3D,
    shinR: shinPivots[1] as THREE.Object3D,
    armL: armPivots[0] as THREE.Object3D,
    armR: armPivots[1] as THREE.Object3D,
    torso,
    head,
    gun,
  };
}

/* ------------------------------------------------------------------ *
 * 路线
 * ------------------------------------------------------------------ */

interface Route {
  /** 'x' = 沿东西向折返，'z' = 沿南北向折返 */
  axis: 'x' | 'z';
  /** 行进线在垂直轴上的坐标 */
  at: number;
  from: number;
  to: number;
}

interface Sentry {
  parts: SoldierParts;
  x: number;
  z: number;
  groundY: number;
  phase: number;
  glanceIndex: number;
  nextGlanceAt: number;
  glanceUntil: number;
  glanceTo: number;
  headY: number;
  shiftIndex: number;
  nextShiftAt: number;
  seed: number;
}

interface Walker {
  parts: SoldierParts;
  route: Route;
  along: number;
  dir: number;
  speed: number;
  /** 步态角速度（rad/s）：与速度绑定，步幅约 0.6 m */
  cadence: number;
  phase: number;
  baseY: number;
  yaw: number;
  lastStrike: number;
  pauseUntil: number;
  glanceIndex: number;
  nextGlanceAt: number;
  glanceUntil: number;
  glanceTo: number;
  headY: number;
  /** 步枪惯性：位移与速度 */
  gunA: number;
  gunV: number;
  seed: number;
}

function zoneAt(x: number, z: number): Zone | null {
  for (const zone of ZONES) {
    if (x >= zone.x0 && x <= zone.x1 && z >= zone.z0 && z <= zone.z1) return zone;
  }
  return null;
}

/** 哨卡缺口与前沿：车队要从这里穿出去，一个兵都不许站 */
function inOutpostGap(x: number, z: number): boolean {
  const g = HOTSPOTS.outpostGap;
  return z > g.z - 9 && z < g.z + 9 && x > g.x0 - GAP_SAFE && x < g.x1 + GAP_SAFE;
}

/**
 * 这个点能不能落兵（见文件头的净空说明）。
 * 返回 false 的情形：车行道、缺口、工业区、被既有建筑/铁路占住的空地。
 */
function canStand(x: number, z: number): boolean {
  if (isOnCarriageway(x, z, CURB_SAFE)) return false;
  if (inOutpostGap(x, z)) return false;
  const zone = zoneAt(x, z);
  if (zone && zone.use === 'industrial') return false;
  if (isOnRoadCorridor(x, z, CURB_SAFE)) return true;
  const rect: Rect = { x0: x - 0.55, x1: x + 0.55, z0: z - 0.55, z1: z + 0.55 };
  return canPlace(rect, 0.1);
}

function pointOf(r: Route, along: number): { x: number; z: number } {
  return r.axis === 'x' ? { x: along, z: r.at } : { x: r.at, z: along };
}

/** 沿线坐标是否可站 */
function canStandAlong(r: Route, along: number): boolean {
  const p = pointOf(r, along);
  return canStand(p.x, p.z);
}

/** 两端往里缩到可站点；中间只要有一处不通就整条弃用 */
function trimRoute(r: Route, name: string): Route | null {
  const step = 0.5;
  let lo = r.from;
  let hi = r.to;
  while (lo < hi && !canStandAlong(r, lo)) lo += step;
  while (hi > lo && !canStandAlong(r, hi)) hi -= step;
  if (hi - lo < MIN_RUN) {
    console.warn(`patrol: 巡逻线 ${name} 净空长度只有 ${(hi - lo).toFixed(1)} m，弃用`);
    return null;
  }
  for (let p = lo; p <= hi; p += step) {
    if (!canStandAlong(r, p)) {
      console.warn(`patrol: 巡逻线 ${name} 在沿线 ${p.toFixed(1)} m 处被挡住，弃用`);
      return null;
    }
  }
  return { axis: r.axis, at: r.at, from: lo, to: hi };
}

/** 沿线行进的朝向（模型面朝局部 +Z） */
function facingYaw(r: Route, dir: number): number {
  return Math.atan2(r.axis === 'x' ? dir : 0, r.axis === 'z' ? dir : 0);
}

/** 两角差（折到 [-π,π]） */
function angDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/* ------------------------------------------------------------------ *
 * 靴印水膜
 * ------------------------------------------------------------------ */

/** 靴印贴图：前掌软椭圆 + 鞋跟软圆 + 靴尖一层溅水；只有形状，不含任何标识 */
function printTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 64, (c) => {
    c.clearRect(0, 0, 64, 64);
    const blob = (cx: number, cy: number, r: number, squash: number, a: number): void => {
      const g = c.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, `rgba(255,255,255,${a})`);
      g.addColorStop(0.5, `rgba(255,255,255,${a * 0.5})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.save();
      c.translate(cx, cy);
      c.scale(1, squash);
      c.translate(-cx, -cy);
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, r, 0, Math.PI * 2);
      c.fill();
      c.restore();
    };
    blob(32, 22, 15, 0.76, 0.95);
    blob(32, 47, 11, 1, 0.78);
    blob(32, 9, 8, 0.5, 0.34);
  });
}

interface Print {
  active: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  birth: number;
  life: number;
  gain: number;
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

export function buildPatrol(ctx: BuildContext): THREE.Group {
  const root = group('patrol');
  const rng = ctx.rng.fork(0x9a71);

  const walkers: Walker[] = [];
  const sentries: Sentry[] = [];

  /** 候选巡逻线：全部贴人行道/路缘，避开缺口与车行道 */
  const candidates: Array<{ name: string; route: Route; role: 'walk' | 'watch' }> = [
    { name: 'avenue-north(核心大道北侧人行道)', route: { axis: 'x', at: -10.5, from: 14, to: 30.5 }, role: 'walk' },
    { name: 'ring-north(北境平民区南人行道)', route: { axis: 'x', at: -92.6, from: 14.5, to: 44 }, role: 'walk' },
    { name: 'outpost-rear(哨卡后区通道)', route: { axis: 'x', at: 116.2, from: -37, to: -23 }, role: 'watch' },
  ];

  const addWalker = (route: Route, phase: number, dirSign: number): void => {
    const parts = buildSoldier(rng);
    const start = dirSign > 0 ? route.from + 1.2 : route.to - 1.2;
    const p = pointOf(route, start);
    const baseY = groundYAt(p.x, p.z) + 0.005;
    const speed = rng.range(0.64, 0.8);
    parts.root.position.set(p.x, baseY, p.z);
    parts.root.rotation.y = facingYaw(route, dirSign);
    root.add(parts.root);
    walkers.push({
      parts,
      route,
      along: start,
      dir: dirSign,
      speed,
      cadence: speed * 5.1,
      phase,
      baseY,
      yaw: facingYaw(route, dirSign),
      lastStrike: Math.floor((phase - Math.PI / 2) / Math.PI),
      pauseUntil: 0,
      glanceIndex: 0,
      nextGlanceAt: rng.range(1.4, 4.2),
      glanceUntil: 0,
      glanceTo: 0,
      headY: 0,
      gunA: 0,
      gunV: 0,
      seed: rng.range(0, 500),
    });
  };

  const addSentry = (route: Route, along: number): void => {
    const parts = buildSoldier(rng);
    const p = pointOf(route, along);
    const groundY = groundYAt(p.x, p.z) + 0.005;
    // 面朝缺口方向（车队唯一通道）警戒
    const yaw = Math.atan2(HOTSPOTS.outpostGap.x0 - 1.5 - p.x, HOTSPOTS.outpostGap.z - 2.5 - p.z);
    parts.root.position.set(p.x, groundY, p.z);
    parts.root.rotation.y = yaw;
    parts.root.scale.setScalar(0.99);
    root.add(parts.root);
    sentries.push({
      parts,
      x: p.x,
      z: p.z,
      groundY,
      phase: rng.range(0, 6.28),
      glanceIndex: 0,
      nextGlanceAt: rng.range(1.2, 3.6),
      glanceUntil: 0,
      glanceTo: 0,
      headY: 0,
      shiftIndex: -1,
      nextShiftAt: rng.range(3, 7),
      seed: rng.range(0, 500),
    });
  };

  let index = 0;
  for (const c of candidates) {
    const trimmed = trimRoute(c.route, c.name);
    if (!trimmed) continue;
    if (c.role === 'watch') addSentry(trimmed, trimmed.to - 1.6);
    else addWalker(trimmed, index * Math.PI * 0.77, index % 2 === 0 ? 1 : -1);
    index += 1;
  }

  /* —— 靴印池：单个 InstancedMesh，1 mesh / 1 draw call —— */
  const printMat = new THREE.MeshBasicMaterial({
    map: printTexture(),
    color: 0x8fb0c9,
    transparent: true,
    opacity: 0.3,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: true,
  });
  const printGeo = new THREE.PlaneGeometry(0.19, 0.32);
  printGeo.rotateX(-Math.PI / 2);
  const seedTransforms: InstanceTransform[] = [];
  for (let i = 0; i < PRINT_N; i += 1) {
    seedTransforms.push({
      position: new THREE.Vector3(0, -60, 0),
      rotation: new THREE.Euler(),
      scale: new THREE.Vector3(0.0001, 0.0001, 0.0001),
    });
  }
  const printInst = instanced(printGeo, printMat, seedTransforms);
  printInst.name = 'patrol-foot-gleam';
  printInst.castShadow = false;
  printInst.receiveShadow = false;
  printInst.frustumCulled = false;
  const black = new THREE.Color(0, 0, 0);
  for (let i = 0; i < PRINT_N; i += 1) printInst.setColorAt(i, black);
  root.add(printInst);

  const prints: Print[] = [];
  for (let i = 0; i < PRINT_N; i += 1) {
    prints.push({ active: false, x: 0, y: -60, z: 0, yaw: 0, birth: 0, life: PRINT_LIFE, gain: 1 });
  }
  let printCursor = 0;
  const stomp = (x: number, z: number, yaw: number, gain: number, t: number): void => {
    const slot = prints[printCursor] as Print;
    printCursor = (printCursor + 1) % PRINT_N;
    slot.active = true;
    slot.x = x;
    slot.z = z;
    slot.y = groundYAt(x, z) + 0.018;
    slot.yaw = yaw;
    slot.birth = t;
    slot.life = PRINT_LIFE * (0.82 + 0.36 * gain);
    slot.gain = gain;
  };

  // 循环用的临时对象：全部在回调外建好
  const scratchM = new THREE.Matrix4();
  const scratchQ = new THREE.Quaternion();
  const scratchE = new THREE.Euler();
  const scratchV = new THREE.Vector3();
  const scratchS = new THREE.Vector3();
  const scratchC = new THREE.Color();

  ctx.ticker.add((t, dt) => {
    const damp = Math.min(1, dt * 3.4);
    const gunDamp = Math.min(1, dt * 5.2);
    let dirty = false;

    /* —— 巡逻兵 —— */
    for (const w of walkers) {
      const paused = t < w.pauseUntil;
      if (!paused) {
        let along = w.along + w.dir * w.speed * dt;
        if (along >= w.route.to) {
          along = w.route.to;
          w.dir = -1;
          // 折返处略停：转身、听一眼
          w.pauseUntil = t + 1.1 + hashNoise(w.seed + along * 0.31) * 1.8;
        } else if (along <= w.route.from) {
          along = w.route.from;
          w.dir = 1;
          w.pauseUntil = t + 1.1 + hashNoise(w.seed - along * 0.27) * 1.8;
        } else if (hashNoise(w.seed + Math.floor(along * 0.5) * 3.19) > 0.9955) {
          // 路上偶尔停半步
          w.pauseUntil = t + 1.4 + hashNoise(w.seed + along) * 1.6;
        }
        w.along = along;
      }

      const p = pointOf(w.route, w.along);
      w.yaw += angDiff(facingYaw(w.route, w.dir), w.yaw) * Math.min(1, dt * 2.6);
      w.parts.root.rotation.y = w.yaw;

      /* 步态：u 每推进 π = 一次落脚 */
      const u = w.phase + t * w.cadence;
      const amp = paused ? 0.18 : 1;
      const s = Math.sin(u);
      const c = Math.cos(u);
      w.parts.hipL.rotation.x = 0.4 * s * amp;
      w.parts.hipR.rotation.x = -0.4 * s * amp;
      // 膝：摆动相位弯、支撑相位蹬直（略滞后于髋）
      w.parts.shinL.rotation.x = -(0.08 + 0.5 * Math.max(0, Math.sin(u + 1.25))) * amp;
      w.parts.shinR.rotation.x = -(0.08 + 0.5 * Math.max(0, Math.sin(u + 1.25 + Math.PI))) * amp;

      /* 落脚瞬间身体下沉（2× 步频起伏）+ 肩线反向摆 */
      w.parts.root.position.set(p.x, w.baseY + 0.026 * (1 - Math.abs(s)) * amp, p.z);
      w.parts.torso.rotation.y = 0.062 * s * amp;
      w.parts.torso.rotation.z = -0.022 * c * amp;
      w.parts.torso.rotation.x = 0.05 + 0.012 * Math.abs(s) * amp;

      /* 端枪的手臂：反向微摆；步枪做阻尼滞后（跟不上重心的那半拍） */
      const armSwing = 0.11 * s * amp;
      w.parts.armL.rotation.x = -0.62 + armSwing;
      w.parts.armR.rotation.x = -0.88 - armSwing;
      w.parts.armL.rotation.z = 0.28 - armSwing * 0.3;
      w.parts.armR.rotation.z = -0.2 + armSwing * 0.3;
      const gunAcc = (gunDamp * 2.2 * (-0.12 * s * amp - w.gunA)) - w.gunV * 3.1;
      w.gunV += gunAcc * dt;
      w.gunA += w.gunV * dt;
      w.parts.gun.rotation.x = w.gunA * 0.9;
      w.parts.gun.rotation.z = w.gunA * 0.55;
      w.parts.gun.position.y = 0.1 - w.gunA * 0.16;

      /* 转头警戒：2~7 秒一次不规则甩头，其余时间缓慢扫视 */
      if (t >= w.nextGlanceAt) {
        w.glanceIndex += 1;
        const a = hashNoise(w.seed + w.glanceIndex * 3.71);
        const b = hashNoise(w.seed + w.glanceIndex * 7.13 + 11.7);
        const e = hashNoise(w.seed + w.glanceIndex * 5.19 + 23.1);
        w.glanceTo = (0.34 + a * 1.05) * (b > 0.5 ? 1 : -1);
        w.glanceUntil = t + 0.9 + e * 1.9;
        w.nextGlanceAt = t + 2 + hashNoise(w.seed + w.glanceIndex * 11.37 + 5.3) * 5;
      }
      const lookTarget = t < w.glanceUntil ? w.glanceTo : Math.sin(t * 0.42 + w.seed) * 0.14;
      w.headY += (lookTarget - w.headY) * damp;
      w.parts.head.rotation.y = w.headY + 0.03 * s;
      w.parts.head.rotation.x = -0.06 + Math.sin(t * 0.9 + w.seed) * 0.03;

      /* 落脚瞬间：靴底压在湿地上，压出一枚水膜亮斑 */
      const strike = Math.floor((u - Math.PI / 2) / Math.PI);
      if (!paused && strike !== w.lastStrike) {
        w.lastStrike = strike;
        const side = strike % 2 === 0 ? 1 : -1;
        const fx = Math.sin(w.yaw);
        const fz = Math.cos(w.yaw);
        const spread = 0.12 + hashNoise(w.seed + strike * 1.63) * 0.05;
        const px = p.x + fx * 0.24 + Math.cos(w.yaw) * spread * side;
        const pz = p.z + fz * 0.24 - Math.sin(w.yaw) * spread * side;
        stomp(px, pz, w.yaw + side * 0.09, 0.7 + hashNoise(w.seed - strike * 2.11) * 0.5, t);
      }
    }

    /* —— 岗哨：原地重心转移 + 呼吸 + 转头，换脚时压出一枚靴印 —— */
    for (const st of sentries) {
      const breathe = Math.sin(t * 1.1 + st.phase);
      st.parts.root.position.y = st.groundY + Math.abs(breathe) * 0.004;
      st.parts.torso.position.y = 0.86 + breathe * 0.006;
      st.parts.torso.rotation.z = Math.sin(t * 0.47 + st.phase) * 0.024;
      st.parts.torso.rotation.y = Math.sin(t * 0.29 + st.phase) * 0.05;
      st.parts.hipL.rotation.x = 0.03 + breathe * 0.012;
      st.parts.hipR.rotation.x = -0.02 - breathe * 0.012;
      st.parts.shinL.rotation.x = -0.06;
      st.parts.shinR.rotation.x = -0.04;
      st.parts.armL.rotation.x = -0.6 + breathe * 0.014;
      st.parts.armR.rotation.x = -0.86 - breathe * 0.014;
      st.parts.gun.rotation.x = breathe * 0.014;
      st.parts.gun.rotation.z = breathe * 0.006;

      if (t >= st.nextGlanceAt) {
        st.glanceIndex += 1;
        const a = hashNoise(st.seed + st.glanceIndex * 2.93);
        const b = hashNoise(st.seed + st.glanceIndex * 6.71 + 17.3);
        st.glanceTo = (0.5 + a * 1.1) * (b > 0.5 ? 1 : -1);
        st.glanceUntil = st.nextGlanceAt + 1.3 + b * 2.2;
        st.nextGlanceAt = st.nextGlanceAt + 2 + hashNoise(st.seed + st.glanceIndex * 9.77 + 3.1) * 5;
      }
      const lookTarget = t < st.glanceUntil ? st.glanceTo : Math.sin(t * 0.33 + st.phase) * 0.2;
      st.headY += (lookTarget - st.headY) * damp;
      st.parts.head.rotation.y = st.headY;
      st.parts.head.rotation.x = -0.04 + Math.sin(t * 0.8 + st.phase) * 0.03;

      // 每 7.4 s 一次重心转移：换脚压出一枚很淡的靴印
      const shift = Math.floor((t + st.phase) / 7.4);
      if (shift !== st.shiftIndex) {
        st.shiftIndex = shift;
        if (t >= st.nextShiftAt) {
          st.nextShiftAt = t + 6 + hashNoise(st.seed + shift * 4.77) * 8;
          const yaw = st.parts.root.rotation.y;
          const side = hashNoise(st.seed - shift * 1.3) > 0.5 ? 1 : -1;
          stomp(
            st.x + Math.sin(yaw) * 0.16 + Math.cos(yaw) * 0.14 * side,
            st.z + Math.cos(yaw) * 0.16 - Math.sin(yaw) * 0.14 * side,
            yaw + side * 0.16,
            0.5,
            t,
          );
        }
      }
    }

    /* —— 靴印：亮起 → 淡去（加色斑，被雨冲淡即消失） —— */
    for (let i = 0; i < PRINT_N; i += 1) {
      const pr = prints[i] as Print;
      if (!pr.active) continue;
      const k = (t - pr.birth) / pr.life;
      if (k >= 1) {
        pr.active = false;
        scratchM.makeScale(0.0001, 0.0001, 0.0001);
        printInst.setMatrixAt(i, scratchM);
        printInst.setColorAt(i, scratchC.setRGB(0, 0, 0));
        dirty = true;
        continue;
      }
      const rise = k < 0.14 ? k / 0.14 : 1;
      const fade = k < 0.14 ? 1 : Math.pow(1 - (k - 0.14) / 0.86, 1.7);
      const glow = rise * fade * pr.gain;
      const sc = 0.86 + k * 0.22;
      scratchE.set(0, pr.yaw, 0);
      scratchQ.setFromEuler(scratchE);
      scratchV.set(pr.x, pr.y, pr.z);
      scratchS.set(sc, 1, sc);
      scratchM.compose(scratchV, scratchQ, scratchS);
      printInst.setMatrixAt(i, scratchM);
      printInst.setColorAt(i, scratchC.setRGB(0.3 * glow, 0.42 * glow, 0.58 * glow));
      dirty = true;
    }
    if (dirty) {
      printInst.instanceMatrix.needsUpdate = true;
      if (printInst.instanceColor) printInst.instanceColor.needsUpdate = true;
    }
  });

  return root;
}
