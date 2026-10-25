import * as THREE from 'three';
import type { BuildContext } from '../core/context';
import type { Rng } from '../core/rng';
import { toonMaterial, canvasTexture } from '../core/materials';
import {
  addBatch,
  at,
  box,
  cone,
  cyl,
  cylinderBetween,
  group,
  instanced,
  jitter,
  mesh,
  sagPath,
  softBox,
  tubeAlong,
  type InstanceTransform,
} from '../core/geo';
import { BASE, HOTSPOTS, ZONES, canPlace, type Zone } from './layout';

/**
 * 边界遮掩与边缘废墟：远景天际线剪影 + 层片式体雾 + 三个 wasteland zone 实体。
 *
 *   ┌─ buildSkyline  最外围 |x| 或 |z| ≈ 140..172 的剪影环（三档半径 149.5/157.5/165.5，
 *   │                由内向外逐级压暗）+ 贴底座边缘内侧的软边雾墙与四角贴地薄雾
 *   └─ buildEdgeWaste wasteSW 被炸毁的变电站 / wasteNW 毁果园+散兵坑 / wasteNE 坍了半边的谷物筒仓
 *
 * 剪影纪律：全部低精度体块、单色或两色分层、不描边、castShadow=false、receiveShadow=false、
 * frustumCulled 保持默认、toonMaterial(steps:2, fog:true) 让它们被雾吃掉层次。
 * 每个剪影元素按"元素坐标系"生成：+X = 沿边的切向，+Z = 朝场景中心。
 * 边缘带不变式：径向 footprint 外沿 ≤172、内沿 ≥138（不进核心可视区）；
 * 中/远两档内沿 ≥144、天然在路网尽头之外；near 档与输电塔内沿 <144，切向只走
 * 路出口安全窗（避开 avenue/cross/rings/suburbLane 延伸到 ±144 的走廊与铁路
 * x≈129.4..138.6 带），详见 NEAR_WINDOWS 与 buildPylonLines 的 tan 表。
 *
 * wasteland 实体一律落在各自 zone 内（先对整块 zone 跑 canPlace()，内容再按 zone 的
 * margin 收进边界），远景在月光阴影相机（±88）之外，统一 castShadow=false。
 *
 * 随机一律来自 ctx.rng.fork(...)；ticker 循环内不 new 对象；真实点光申请 0 盏。
 */

const TAU = Math.PI * 2;

/* ================================================================== *
 * 剪影材质：三档由内向外的夜色
 * ================================================================== */

const SIL_NEAR = toonMaterial(0x1a2531, { steps: 2, fog: true });
const SIL_MID = toonMaterial(0x131b24, { steps: 2, fog: true });
const SIL_FAR = toonMaterial(0x0d141c, { steps: 2, fog: true });

/* ================================================================== *
 * 边缘带元素坐标系
 * ================================================================== */

interface Edge {
  /** outward 法线（远离场景中心） */
  nx: number;
  nz: number;
  /** 切向单位向量 */
  tx: number;
  tz: number;
}

const EDGES: Edge[] = [
  { nx: 0, nz: -1, tx: 1, tz: 0 }, // 北边
  { nx: 1, nz: 0, tx: 0, tz: 1 }, // 东边
  { nx: 0, nz: 1, tx: -1, tz: 0 }, // 南边
  { nx: -1, nz: 0, tx: 0, tz: -1 }, // 西边
];

/** 一个剪影元素的落位框架：世界锚点 + 朝向（+X 沿切向，+Z 朝中心） */
interface Frame {
  x: number;
  z: number;
  rotY: number;
  /** 局部轴向（世界表示）：localX 方向 / localZ 方向 */
  axX: number;
  axZ: number;
  azX: number;
  azZ: number;
}

function edgeFrame(e: Edge, perpR: number, tanOff: number): Frame {
  const x = e.nx * perpR + e.tx * tanOff;
  const z = e.nz * perpR + e.tz * tanOff;
  // 绕 Y 转 rotY 后：局部 +X → (cos, 0, -sin)，局部 +Z → (sin, 0, cos)；
  // 取 rotY 使局部 +Z 恰好指向场景中心（即 -outward）
  const rotY = Math.atan2(-e.nx, -e.nz);
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  return { x, z, rotY, axX: c, axZ: -s, azX: s, azZ: c };
}

/** 元素局部坐标 → 世界坐标（y 直接沿世界 Y） */
function framePoint(f: Frame, lx: number, ly: number, lz: number): THREE.Vector3 {
  return new THREE.Vector3(f.x + f.axX * lx + f.azX * lz, ly, f.z + f.axZ * lx + f.azZ * lz);
}

/* ================================================================== *
 * 收集器：局部坐标生成低精度体块，最终按材质 addBatch 成极少数 mesh
 * ================================================================== */

type Collector = THREE.Mesh[];

function pushBox(arr: Collector, mat: THREE.Material, f: Frame, w: number, h: number, d: number, lx: number, y: number, lz: number, extraRy = 0): void {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.copy(framePoint(f, lx, y, lz));
  m.rotation.y = f.rotY + extraRy;
  arr.push(m);
}

function pushCyl(arr: Collector, mat: THREE.Material, f: Frame, rt: number, rb: number, h: number, seg: number, lx: number, y: number, lz: number, tiltZ = 0): void {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg, 1, false), mat);
  m.position.copy(framePoint(f, lx, y, lz));
  m.rotation.y = f.rotY;
  if (tiltZ !== 0) m.rotation.z = tiltZ;
  arr.push(m);
}

/** 水平环（烟囱加固圈 / 储气柜桁架圈）。先转几何再摆放，绕 Y 的朝向对圆环无意义 */
function pushHoop(arr: Collector, mat: THREE.Material, f: Frame, r: number, tube: number, lx: number, y: number, lz: number): void {
  const geo = new THREE.TorusGeometry(r, tube, 3, 10);
  geo.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(framePoint(f, lx, y, lz));
  arr.push(m);
}

/* ================================================================== *
 * 各类剪影
 * ================================================================== */

/** 巨大烟囱（成束、环形加固圈、顶部断裂参差） */
function silhouetteChimneys(arr: Collector, e: Edge, perpR: number, tanOff: number, rng: Rng, mat: THREE.Material): void {
  const f = edgeFrame(e, perpR, tanOff);
  const n = rng.int(2, 3);
  for (let i = 0; i < n; i += 1) {
    const ox = (i - (n - 1) / 2) * rng.range(5, 8) + rng.range(-1.5, 1.5);
    const oz = rng.range(-2, 2);
    const h = rng.range(34, 62);
    const rTop = rng.range(1.1, 1.7);
    const rBot = rTop * rng.range(1.3, 1.7);
    pushCyl(arr, mat, f, rTop, rBot, h, 10, ox, h / 2, oz);
    // 环形加固圈
    const hoops = rng.int(3, 5);
    for (let k = 1; k <= hoops; k += 1) {
      const t = k / (hoops + 1);
      const rr = rTop + (rBot - rTop) * t;
      pushHoop(arr, mat, f, rr + 0.18, 0.3, ox, h * t, oz);
    }
    // 顶部断裂参差：高低不齐的破片
    const shards = rng.int(3, 5);
    for (let s = 0; s < shards; s += 1) {
      const a = (s / shards) * TAU + rng.range(-0.4, 0.4);
      const rr = rTop * rng.range(0.45, 0.9);
      const sh = rng.range(1.4, 4.2);
      pushBox(arr, mat, f, rTop * 0.9, sh, rTop * 0.9, ox + Math.cos(a) * rr, h + sh / 2 - 0.7, oz + Math.sin(a) * rr, a);
    }
  }
}

/** 残破水塔 / 煤气罐（圆形储气柜的桁架圈）。gasometer=true 为落地扁大储气柜 */
function silhouetteTank(arr: Collector, e: Edge, perpR: number, tanOff: number, rng: Rng, mat: THREE.Material, gasometer: boolean, maxR: number): void {
  const f = edgeFrame(e, perpR, tanOff);
  const r = rng.range(gasometer ? maxR * 0.62 : 5.5, maxR);
  const wallH = gasometer ? rng.range(9, 15) : rng.range(8, 12);
  const legH = gasometer ? rng.range(0.6, 1.4) : rng.range(5, 9);
  const yBody = legH + wallH / 2;
  pushCyl(arr, mat, f, gasometer ? r : r * 0.9, r, wallH, 12, 0, yBody, 0);
  // 顶：浅锥（储气柜）/ 歪斜残锥（水塔）
  const cap = new THREE.Mesh(new THREE.ConeGeometry(r * 1.03, gasometer ? r * 0.5 : r * 0.95, 10), mat);
  cap.position.copy(framePoint(f, rng.range(-0.4, 0.4), legH + wallH + (gasometer ? r * 0.22 : r * 0.45), 0));
  cap.rotation.y = f.rotY;
  cap.rotation.z = gasometer ? 0 : rng.range(-0.16, 0.16);
  arr.push(cap);
  // 桁架圈：煤气罐多圈、水塔少圈
  const rings = gasometer ? rng.int(3, 4) : rng.int(1, 2);
  for (let k = 1; k <= rings; k += 1) {
    pushHoop(arr, mat, f, r + 0.22, 0.3, 0, legH + (wallH * k) / (rings + 1), 0);
  }
  // 支腿
  const legs = 6;
  for (let l = 0; l < legs; l += 1) {
    const a = (l / legs) * TAU;
    pushBox(arr, mat, f, 0.24, legH, 0.24, Math.cos(a) * r * 0.88, legH / 2, Math.sin(a) * r * 0.88);
  }
  // 撕裂的罐壁豁口（深色破片，两色分层）
  if (rng.chance(0.7)) {
    const a = rng.range(0, TAU);
    pushBox(arr, SIL_FAR, f, r * 0.55, wallH * rng.range(0.3, 0.5), 0.4, Math.cos(a) * r, yBody + rng.range(-wallH * 0.1, wallH * 0.16), Math.sin(a) * r, a);
  }
}

/** 锯齿厂房屋脊：长条厂房 + 顶部锯齿天窗，屋脊线沿切向 */
function silhouetteFactory(arr: Collector, e: Edge, perpR: number, tanOff: number, rng: Rng, mat: THREE.Material): void {
  const f = edgeFrame(e, perpR, tanOff);
  const len = rng.range(16, 26);
  const depth = rng.range(8, 13);
  const wallH = rng.range(6, 10);
  const oz = rng.range(-3, 3);
  pushBox(arr, mat, f, len, wallH, depth, 0, wallH / 2, oz);
  const teeth = rng.int(4, 8);
  const pitch = len / teeth;
  for (let t = 0; t < teeth; t += 1) {
    const lx = (t - (teeth - 1) / 2) * pitch;
    const rise = rng.range(1.6, 2.8);
    // 每齿 = 斜板 + 竖直玻璃面（更暗一档，构成两色分层）
    const slant = new THREE.Mesh(new THREE.BoxGeometry(pitch * 0.85, 0.22, rise * 1.4), mat);
    slant.position.copy(framePoint(f, lx, wallH + rise * 0.42, oz + depth * 0.14));
    slant.rotation.y = f.rotY;
    slant.rotation.x = -Math.atan2(rise, pitch * 0.8);
    arr.push(slant);
    pushBox(arr, SIL_FAR, f, 0.5, rise, pitch * 0.8, lx, wallH + rise / 2, oz - depth * 0.3 + depth * 0.28);
  }
}

/** 倒塌冷却塔：收腰盆体 + 塌口参差破片 + 倒伏筒体 */
function silhouetteCoolingTower(arr: Collector, e: Edge, perpR: number, tanOff: number, rng: Rng, mat: THREE.Material): void {
  const f = edgeFrame(e, perpR, tanOff);
  const r = rng.range(6.5, 7.8);
  const hh = r * 0.95;
  pushCyl(arr, mat, f, r * 0.72, r, hh, 12, 0, hh / 2, 0);
  pushCyl(arr, mat, f, r * 1.05, r * 0.7, hh, 12, 0, hh * 1.95, 0);
  pushHoop(arr, mat, f, r * 1.06, 0.3, 0, hh * 2.86, 0);
  // 塌了半边：环上一段破片高矮不一
  const n = rng.int(5, 8);
  for (let s = 0; s < n; s += 1) {
    const a = rng.range(-1.1, 1.1);
    pushBox(arr, mat, f, r * 0.42, rng.range(1.6, 4.4), 0.4, Math.cos(a) * r * 0.85, hh * 2.6 + rng.range(-0.6, 1.6), Math.sin(a) * r * 0.85, a);
  }
  // 倒伏的筒体（整体朝切向躺倒）
  const fall = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.6, r * 1.5, 10, 1, false), mat);
  fall.position.copy(framePoint(f, r * 1.1, r * 0.55, rng.range(-1.5, 1.5)));
  fall.rotation.z = Math.PI / 2;
  fall.rotation.y = rng.range(-0.3, 0.3);
  arr.push(fall);
}

/** 只剩外壳的板式住宅群：两栋紧贴的薄板残楼 + 朝中心立面的黑洞（紧凑 footprint） */
function silhouetteHousing(arr: Collector, e: Edge, perpR: number, tanOff: number, rng: Rng, mat: THREE.Material): void {
  const f = edgeFrame(e, perpR, tanOff);
  const blocks = 2;
  for (let b = 0; b < blocks; b += 1) {
    const ox = (b - (blocks - 1) / 2) * rng.range(9.5, 11.5);
    const len = rng.range(8, 12);
    const h = rng.range(15, 23);
    const depth = rng.range(5.5, 7.5);
    const oz = rng.range(-1.5, 1.5);
    pushBox(arr, mat, f, len, h, depth, ox, h / 2, oz);
    // 顶部被剥掉的参差边
    const nubs = rng.int(4, 7);
    for (let k = 0; k < nubs; k += 1) {
      const lx = ox + (k - (nubs - 1) / 2) * (len / nubs);
      pushBox(arr, mat, f, (len / nubs) * 0.8, rng.range(0.8, 2.6), depth * 0.8, lx, h + 0.4, oz);
    }
    // 朝中心一侧的立面黑洞（只剩外壳的窗阵）
    const cols = rng.int(5, 8);
    const floors = Math.max(3, Math.round(h / 3.4));
    const win = new THREE.BoxGeometry((len / cols) * 0.55, 1.25, 0.3);
    for (let fy = 0; fy < floors; fy += 1) {
      for (let cxi = 0; cxi < cols; cxi += 1) {
        if (!rng.chance(0.5)) continue;
        const m = new THREE.Mesh(win, SIL_FAR);
        const lx = ox + (cxi - (cols - 1) / 2) * (len / cols);
        m.position.copy(framePoint(f, lx, 2.2 + fy * (h - 3) / floors, oz + depth / 2 + 0.08));
        m.rotation.y = f.rotY;
        arr.push(m);
      }
    }
  }
}

/** 输电铁塔：收分格构（斜杆近似）+ 两层横担；返回横担挂线点（世界坐标） */
function silhouettePylon(e: Edge, perpR: number, tanOff: number, rng: Rng, mat: THREE.Material): { meshes: THREE.Mesh[]; attach: THREE.Vector3[] } {
  const f = edgeFrame(e, perpR, tanOff);
  const meshes: THREE.Mesh[] = [];
  const h = rng.range(20, 30);
  const baseHalf = rng.range(2.4, 3.4);
  const topHalf = baseHalf * 0.3;
  // 四条主腿：外撇到腰部，再收到顶
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const knee = framePoint(f, sx * baseHalf, h * 0.55, sz * baseHalf);
      const foot = framePoint(f, sx * (baseHalf + 0.8), 0, sz * (baseHalf + 0.8));
      const apex = framePoint(f, sx * topHalf, h * 0.92, sz * topHalf);
      meshes.push(cylinderBetween(foot, knee, 0.16, mat, 4));
      meshes.push(cylinderBetween(knee, apex, 0.13, mat, 4));
    }
  }
  // 两层横担（沿切向）+ 挂线点
  const arms: Array<{ y: number; half: number }> = [
    { y: h * 0.66, half: rng.range(4.5, 6.2) },
    { y: h * 0.86, half: rng.range(2.8, 3.8) },
  ];
  const attach: THREE.Vector3[] = [];
  for (const arm of arms) {
    meshes.push(cylinderBetween(framePoint(f, -arm.half, arm.y, 0), framePoint(f, arm.half, arm.y, 0), 0.18, mat, 4));
    attach.push(framePoint(f, -arm.half, arm.y - 0.4, 0));
    attach.push(framePoint(f, arm.half, arm.y - 0.4, 0));
  }
  // 塔顶避雷针
  meshes.push(cylinderBetween(framePoint(f, 0, h * 0.92, 0), framePoint(f, 0, h + 2.2, 0), 0.1, mat, 4));
  return { meshes, attach };
}

/* ================================================================== *
 * 体雾贴图（软边雾墙 / 贴地薄雾）
 * ================================================================== */

function fogSoftTexture(seed: number): THREE.CanvasTexture {
  const tex = canvasTexture(256, 256, (c, w, h) => {
    let a = seed >>> 0;
    const rnd = (): number => {
      a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
      return a / 4294967296;
    };
    c.clearRect(0, 0, w, h);
    // 底色：竖向渐变，中段最浓、上下透出夜色
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.3, 'rgba(148,166,188,0.12)');
    g.addColorStop(0.66, 'rgba(126,146,170,0.18)');
    g.addColorStop(1, 'rgba(104,124,148,0.05)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    // 径向柔核：把左右边缘彻底羽化，避免"扫过的墙"
    const rg = c.createRadialGradient(w / 2, h * 0.55, 0, w / 2, h * 0.55, w * 0.52);
    rg.addColorStop(0, 'rgba(186,202,220,0.26)');
    rg.addColorStop(0.55, 'rgba(150,170,194,0.10)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = rg;
    c.fillRect(0, 0, w, h);
    // 条状羽化：竖向丝缕，读成浓雾的流动结构
    for (let i = 0; i < 24; i += 1) {
      const x = rnd() * w;
      const cw = 10 + rnd() * 40;
      const al = 0.05 + rnd() * 0.12;
      const lg = c.createLinearGradient(0, 0, 0, h);
      lg.addColorStop(0, 'rgba(0,0,0,0)');
      lg.addColorStop(0.45, `rgba(172,190,210,${al.toFixed(3)})`);
      lg.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = lg;
      c.fillRect(x - cw / 2, 0, cw, h);
    }
  });
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function groundMistTexture(seed: number): THREE.CanvasTexture {
  return canvasTexture(256, 256, (c, w, h) => {
    let a = seed >>> 0;
    const rnd = (): number => {
      a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
      return a / 4294967296;
    };
    c.clearRect(0, 0, w, h);
    for (let i = 0; i < 10; i += 1) {
      const x = (0.12 + rnd() * 0.76) * w;
      const y = (0.12 + rnd() * 0.76) * h;
      const r = (0.14 + rnd() * 0.26) * w;
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(190,206,224,0.20)');
      g.addColorStop(0.55, 'rgba(150,172,196,0.07)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(x, y, r, 0, TAU);
      c.fill();
    }
  });
}

/**
 * 雾墙 + 四角贴地薄雾。
 * 雾墙贴在底座边缘内侧（半径 132..138），只待在边缘带；
 * 核心区视线 |x|,|z| < 76 完全不被触及。ticker 只做厘米~米级的缓慢漂移与呼吸。
 */
interface FogWall {
  obj: THREE.Object3D;
  mat: THREE.MeshBasicMaterial;
  baseX: number;
  baseZ: number;
  driftX: number;
  driftZ: number;
  period: number;
  phase: number;
  breathe: number;
  baseOpacity: number;
}

function buildVolumetricFog(skyline: THREE.Group, ctx: BuildContext, rng: Rng): void {
  const fog = group('edge-fog');
  const texA = fogSoftTexture(0x9e3779b1);
  const texB = fogSoftTexture(0x85ebca6b);
  const walls: FogWall[] = [];

  // 每边两片、内外两档半径、高度错落 → 共 8 片，围成一圈
  const radii = [132, 137.5];
  for (let s = 0; s < EDGES.length; s += 1) {
    const e = EDGES[s]!;
    for (let i = 0; i < 2; i += 1) {
      const tan = (i === 0 ? 0 : rng.sign() * 0.52) * (BASE.half - 4) + rng.range(-10, 10);
      const r = radii[(s + i) % 2] + rng.range(-2, 2);
      const w = rng.range(104, 132);
      const h = rng.range(26, 50);
      const f = edgeFrame(e, r, tan);
      const mat = new THREE.MeshBasicMaterial({
        map: i % 2 === 0 ? texA : texB,
        color: 0x9db2c6,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        fog: true,
        side: THREE.DoubleSide,
      });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      plane.position.set(f.x, h / 2 + 1.2, f.z);
      plane.rotation.y = f.rotY; // 面朝场景中心
      plane.castShadow = false;
      plane.receiveShadow = false;
      plane.renderOrder = 18;
      fog.add(plane);
      const driftMag = rng.range(2.2, 5.5);
      walls.push({
        obj: plane,
        mat,
        baseX: f.x,
        baseZ: f.z,
        driftX: e.tx * driftMag,
        driftZ: e.tz * driftMag,
        period: rng.range(32, 65), // 周期 30~70 秒
        phase: rng.range(0, TAU),
        breathe: rng.range(0.1, 0.2),
        baseOpacity: 0.44 + rng.range(-0.06, 0.1),
      });
    }
  }

  // 底座四角：贴地薄雾片
  const mistTex = groundMistTexture(0x2b4a6c);
  const mist: FogWall[] = [];
  const inset = BASE.half - 9;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const mat = new THREE.MeshBasicMaterial({
        map: mistTex,
        color: 0x8fa6ba,
        transparent: true,
        opacity: 0.38,
        depthWrite: false,
        fog: true,
        side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(rng.range(56, 76), rng.range(48, 66)), mat);
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = rng.range(0, TAU);
      m.position.set(sx * inset, 0.6, sz * inset);
      m.castShadow = false;
      m.receiveShadow = false;
      m.renderOrder = 17;
      fog.add(m);
      mist.push({
        obj: m,
        mat,
        baseX: sx * inset,
        baseZ: sz * inset,
        driftX: rng.range(2.5, 5),
        driftZ: rng.range(2, 4.5),
        period: rng.range(36, 60),
        phase: rng.range(0, TAU),
        breathe: rng.range(0.08, 0.16),
        baseOpacity: 0.34,
      });
    }
  }

  skyline.add(fog);

  // 动画：只改既有对象，循环内零分配
  ctx.ticker.add((t) => {
    for (let i = 0; i < walls.length; i += 1) {
      const w = walls[i]!;
      const k = Math.sin((t / w.period) * TAU + w.phase);
      w.obj.position.x = w.baseX + w.driftX * k;
      w.obj.position.z = w.baseZ + w.driftZ * k;
      w.mat.opacity = w.baseOpacity + w.breathe * Math.sin((t / (w.period * 0.73)) * TAU + w.phase * 1.37);
    }
    for (let i = 0; i < mist.length; i += 1) {
      const m = mist[i]!;
      m.obj.position.x = m.baseX + Math.sin((t / m.period) * TAU + m.phase) * m.driftX;
      m.obj.position.z = m.baseZ + Math.cos((t / (m.period * 1.13)) * TAU + m.phase) * m.driftZ;
      m.mat.opacity = m.baseOpacity + m.breathe * Math.sin((t / (m.period * 0.8)) * TAU + m.phase * 1.7);
    }
  });
}

/* ================================================================== *
 * 主入口 1：远景剪影环 + 边缘体雾
 * ================================================================== */

export function buildSkyline(ctx: BuildContext): THREE.Group {
  const skyline = group('skyline');
  const rng = ctx.rng.fork(3307);

  const nearParts: Collector = [];
  const midParts: Collector = [];
  const farParts: Collector = [];

  // 三档半径。near 档楼体进深大（实测内伸可达 28 m），若 R_NEAR 只比底座(144)大一点，
  // 楼体朝内那一侧会伸进底座 —— 旋转相机时这些黑色剪影会糊在镜头前，画面整片黑。
  // 实测反推：内缘需 ≥ 147 → R_NEAR ≥ 147 + 28 = 175，取 180 留余量；mid/far 同步外推保持层次。
  const R_NEAR = 180;
  const R_MID = 196;
  const R_FAR = 212;
  const TAN_LIMIT = BASE.half - 8; // 中/远圈切向可用半程（内沿 ≥144，不受路出口约束）

  /* 内圈安全窗：路网走廊矩形都延伸到 ±144，near 档 footprint 内沿 <144，
   * 切向必须绕开各路的出城口——
   *   north: cross(±12) + suburbLane(-47.5..-32.5) + ringW/E(±100±9)
   *   south/east/west: 各自的中轴出口与 ±100 环道出口
   * 取 |tan|∈43..59（北边西侧借 suburbLane 与 ringW 之间 67 上下的窄窗）。 */
  const NEAR_WINDOWS: Array<Array<[number, number]>> = [
    [[-70.5, -67.5], [43, 59]], // 北
    [[-59, -43], [43, 59]], // 东
    [[-59, -43], [43, 59]], // 南
    [[-59, -43], [43, 59]], // 西
  ];

  const mixOf = (r: number): number => ((r * 2654435761) >>> 0) / 4294967296;

  for (let s = 0; s < EDGES.length; s += 1) {
    const e = EDGES[s]!;
    // —— 内圈剪影（结构读得清的一档）：每边 2 座，只落在安全窗内 ——
    for (const [lo, hi] of NEAR_WINDOWS[s]!) {
      const tan = rng.range(lo, hi);
      const pick = rng.next();
      if (pick < 0.24) silhouetteChimneys(nearParts, e, R_NEAR, tan, rng, SIL_NEAR);
      else if (pick < 0.42) silhouetteTank(nearParts, e, R_NEAR, tan, rng, SIL_NEAR, rng.chance(0.5), 10);
      else if (pick < 0.56) silhouetteFactory(nearParts, e, R_NEAR, tan, rng, SIL_NEAR);
      else if (pick < 0.7) silhouetteHousing(nearParts, e, R_NEAR, tan, rng, SIL_NEAR);
      else if (pick < 0.86) silhouetteCoolingTower(nearParts, e, R_NEAR, tan, rng, SIL_NEAR);
      else {
        const py = silhouettePylon(e, R_NEAR, tan, rng, SIL_NEAR);
        for (const m of py.meshes) nearParts.push(m);
      }
    }
    // —— 中圈（更黑更稀，可铺满整边）——
    const slots = 6;
    for (let k = 0; k < slots; k += 1) {
      const tan = (k - (slots - 1) / 2) * ((TAN_LIMIT * 2) / slots) + rng.range(-9, 9);
      if (rng.chance(0.6)) {
        const q = mixOf(k * 31 + s * 7 + 5);
        if (q < 0.4) silhouetteChimneys(midParts, e, R_MID, tan + rng.range(-13, 13), rng, SIL_MID);
        else if (q < 0.66) silhouetteHousing(midParts, e, R_MID, tan, rng, SIL_MID);
        else silhouetteTank(midParts, e, R_MID, tan, rng, SIL_MID, rng.chance(0.5), 8.5);
      }
      // —— 远圈（几乎被雾吃干净，只留高瘦轮廓）——
      if (rng.chance(0.45)) {
        const q = mixOf(k * 57 + s * 13 + 11);
        if (q < 0.6) silhouetteChimneys(farParts, e, R_FAR, tan + rng.range(-15, 15), rng, SIL_FAR);
        else silhouetteTank(farParts, e, R_FAR, tan, rng, SIL_FAR, rng.chance(0.7), 5.5);
      }
    }
  }

  // —— 输电铁塔与垂落的电线（东边一串 + 西边一串，塔间拉三相下垂线）——
  buildPylonLines(skyline, rng, nearParts);

  for (const [parts, mat, name] of [
    [nearParts, SIL_NEAR, 'skyline-near'],
    [midParts, SIL_MID, 'skyline-mid'],
    [farParts, SIL_FAR, 'skyline-far'],
  ] as Array<[Collector, THREE.Material, string]>) {
    const merged = addBatch(skyline, parts, mat, name);
    if (merged) {
      merged.castShadow = false;
      merged.receiveShadow = false;
    }
  }

  buildVolumetricFog(skyline, ctx, rng);
  return skyline;
}

/** 几段输电铁塔 + 垂落的电线：断了几档、有几根耷拉到地上 */
function buildPylonLines(skyline: THREE.Group, rng: Rng, nearParts: Collector): void {
  const wires: Collector = [];
  const runs: Array<{ edge: Edge; tans: number[] }> = [
    { edge: EDGES[1]!, tans: [-120, -70, -24, 30, 72] }, // 东边：绕开大道口(±19)与环道口(±(84..116))
    { edge: EDGES[3]!, tans: [-68, 26, 66] }, // 西边
  ];
  for (const run of runs) {
    const attaches: Array<{ list: THREE.Vector3[]; h: number }> = [];
    for (const tan of run.tans) {
      // 铁塔半径原本硬编码 146.5，塔基有宽度 → 内缘 142 会伸进底座(144)里，
      // 旋转相机时这些黑色剪影糊在镜头前导致画面整片黑。外推到与 near 档一致的安全半径。
      const py = silhouettePylon(run.edge, 182, tan + rng.range(-6, 6), rng, SIL_NEAR);
      for (const m of py.meshes) nearParts.push(m);
      attaches.push({ list: py.attach, h: 0 });
    }
    // 相邻塔间拉线；两塔间距离过大或随机"断档"就不拉
    for (let i = 0; i < attaches.length - 1; i += 1) {
      const a = attaches[i]!.list;
      const b = attaches[i + 1]!.list;
      const brokenSpan = rng.chance(0.22);
      for (let c = 0; c < a.length; c += 1) {
        if (brokenSpan && c % 2 === 0) {
          // 断线：只从前塔垂落一截，耷拉到近地
          const pa = a[c]!;
          const hang = new THREE.Vector3(pa.x + rng.range(-1.5, 1.5), 0.35, pa.z + rng.range(-1.5, 1.5));
          const pts = sagPath(pa.clone().setY(pa.y - 1), hang, 0.8, 6);
          wires.push(tubeAlong(pts, 0.09, SIL_FAR, 8));
          continue;
        }
        const pa = a[c]!;
        const pb = b[c]!;
        const sag = pa.distanceTo(pb) * 0.09 + 1.6;
        const wire = tubeAlong(sagPath(pa, pb, sag, 8), 0.1, SIL_NEAR, 10);
        wires.push(wire);
      }
    }
  }
  const merged = addBatch(skyline, wires, SIL_NEAR, 'skyline-wires');
  if (merged) {
    merged.castShadow = false;
    merged.receiveShadow = false;
  }
}

/* ================================================================== *
 * wasteland 公用：按材质分桶合并（保住两色分层，mesh 数压到最少）
 * ================================================================== */

/** 把 parts 按各自材质分桶，每桶 addBatch 成一个 mesh；远景统一不投影 */
function bakeBuckets(parent: THREE.Object3D, parts: Collector, prefix: string): void {
  const buckets = new Map<THREE.Material, Collector>();
  for (const m of parts) {
    const mat = m.material as THREE.Material;
    const list = buckets.get(mat);
    if (list) list.push(m);
    else buckets.set(mat, [m]);
  }
  let i = 0;
  buckets.forEach((list, mat) => {
    const merged = addBatch(parent, list, mat, `${prefix}-${i}`);
    i += 1;
    if (merged) {
      merged.castShadow = false;
      merged.receiveShadow = false;
    }
  });
}

/** 边缘废墟调色：雨夜里的锈、瓷、混凝土 */
const W = {
  metal: toonMaterial(0x5d666f, { steps: 3, fog: true }),
  metalDark: toonMaterial(0x414951, { steps: 3, fog: true }),
  ceramic: toonMaterial(0x8b7d69, { steps: 3, fog: true }),
  ceramicDark: toonMaterial(0x645749, { steps: 2, fog: true }),
  concrete: toonMaterial(0x5f646b, { steps: 3, fog: true }),
  rust: toonMaterial(0x59392a, { steps: 3, fog: true }),
  rubble: toonMaterial(0x494d53, { steps: 2, fog: true }),
  dirt: toonMaterial(0x3d382e, { steps: 2, fog: true }),
  soil: toonMaterial(0x33302a, { steps: 3, fog: true }),
  bark: toonMaterial(0x453628, { steps: 3, fog: true }),
  wood: toonMaterial(0x5a4a34, { steps: 3, fog: true }),
  woodDark: toonMaterial(0x3b2f22, { steps: 3, fog: true }),
  wire: toonMaterial(0x333c44, { steps: 2, fog: true }),
  grain: toonMaterial(0x7a6a3e, { steps: 3, fog: true }),
  dark: toonMaterial(0x181d22, { steps: 2, fog: true }),
  siloSheet: toonMaterial(0x6a6862, { steps: 3, fog: true }),
  siloCorrug: toonMaterial(0x57544d, { steps: 2, fog: true }),
  oil: new THREE.MeshPhongMaterial({ color: 0x10151b, specular: 0x2c3c4a, shininess: 70 }),
};

/** zone 内容边界（世界坐标半程，含 margin） */
function zoneLimits(zone: Zone, anchorX: number, anchorZ: number): { x0: number; x1: number; z0: number; z1: number } {
  const m = zone.margin;
  return {
    x0: Math.max(zone.x0 + m - anchorX, -40),
    x1: Math.min(zone.x1 - m - anchorX, 40),
    z0: Math.max(zone.z0 + m - anchorZ, -40),
    z1: Math.min(zone.z1 - m - anchorZ, 40),
  };
}

/* ================================================================== *
 * wasteSW：被炸毁的变电站（锚点 HOTSPOTS.substation）
 * ================================================================== */

function buildSubstation(root: THREE.Group, ctx: BuildContext, zone: Zone): void {
  const rng = ctx.rng.fork(4411);
  const anchor = HOTSPOTS.substation;
  const g = group('waste-substation');
  g.position.set(anchor.x, 0, anchor.z);
  const lim = zoneLimits(zone, anchor.x, anchor.z);

  const parts: Collector = [];

  // —— 倒塌的门型构架：整榀砸在场地南侧，柱横躺、梁断成两截 ——
  {
    const fallY = 0.36;
    const fy = lim.z1 - 2.6;
    for (const s of [-1, 1]) {
      const post = cyl(0.3, 0.36, 8.6, 8, W.metal);
      post.rotation.z = Math.PI / 2;
      post.rotation.y = s * rng.range(0.1, 0.35);
      at(post, s * 3.4, fallY, fy + s * 1.4);
      parts.push(post);
      // 柱头砸裂：断口参差
      pushBoxParts(parts, W.metalDark, s * 7.6, fallY + 0.1, fy + s * 1.6, 0.6, 0.5, 0.55, rng.range(0, TAU));
    }
    for (const [bx, bz, br] of [[-4.6, fy + 0.4, 0.22], [4.4, fy - 0.2, -0.38]] as Array<[number, number, number]>) {
      const fb = box(7.8, 0.42, 0.42, W.metalDark);
      at(fb, bx, 0.26, bz);
      fb.rotation.y = br;
      fb.rotation.z = rng.range(-0.12, 0.12);
      parts.push(fb);
    }
  }

  // —— 立着的门架（场地北侧）：横梁歪斜、柱顶崩裂 ——
  const gantryZ = lim.z0 + 2.2;
  const gantryY = 8.2;
  for (const gx of [-9.5, 9.5]) {
    pushBoxParts(parts, W.metalDark, gx, gantryY / 2, gantryZ, 0.62, gantryY, 0.62);
    // 柱脚混凝土基础
    pushBoxParts(parts, W.concrete, gx, 0.3, gantryZ, 1.4, 0.6, 1.4);
    // 柱顶断裂参差
    pushBoxParts(parts, W.metal, gx + rng.range(-0.3, 0.3), gantryY + 0.5, gantryZ + rng.range(-0.2, 0.2), 0.5, 1.1, 0.5, rng.range(-0.3, 0.3));
  }
  // 歪斜横梁
  const beam = box(19.4, 0.5, 0.5, W.metal);
  at(beam, 0, gantryY + 0.1, gantryZ);
  beam.rotation.z = 0.06;
  beam.rotation.y = rng.range(-0.04, 0.04);
  parts.push(beam);

  // —— 陶瓷绝缘子串（叠盘）：挂在横梁下 + 掉了一串摔散 ——
  for (let i = 0; i < 5; i += 1) {
    const ix = -8 + i * 4;
    const discs = rng.int(5, 8);
    for (let d = 0; d < discs; d += 1) {
      const bell = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.11, 3, 10), d % 2 === 0 ? W.ceramic : W.ceramicDark);
      bell.rotation.x = -Math.PI / 2;
      bell.position.set(ix, gantryY - 0.7 - d * 0.4, gantryZ);
      parts.push(bell);
    }
    pushRod(parts, W.metalDark, ix, gantryY - 0.5, gantryZ, ix, gantryY - 0.5 - discs * 0.4, gantryZ);
  }
  // 摔散的绝缘子盘（实例化）
  const discTr: InstanceTransform[] = [];
  for (let i = 0; i < 14; i += 1) {
    discTr.push({
      position: new THREE.Vector3(rng.range(-6, 7), rng.range(0.12, 0.4), rng.range(0, 4)),
      rotation: new THREE.Euler(Math.PI / 2 + rng.range(-0.3, 0.3), rng.range(0, TAU), rng.range(-0.3, 0.3)),
      scale: new THREE.Vector3(1, 1, 1),
    });
  }
  const discInst = instanced(new THREE.CylinderGeometry(0.3, 0.34, 0.14, 8), W.ceramic, discTr);
  discInst.castShadow = false;
  discInst.receiveShadow = false;
  g.add(discInst);

  // —— 变压器：壳体被掀开、露出散热片墙，一只整台侧翻 ——
  const trafo = (tx: number, tz: number, rotY: number, down: boolean): void => {
    // 壳体在 holder 局部坐标里建模，散热片/顶盖/套管随同一 holder 变换
    const holder = group('trafo');
    holder.position.set(tx, down ? 1.7 : 0, tz);
    holder.rotation.y = rotY;
    if (down) holder.rotation.x = rng.range(1.25, 1.45); // 侧翻：沿长轴棱滚倒、微斜靠
    const shell = softBox(5.4, 3.2, 3.8, 0.3, W.metalDark);
    shell.position.set(0, 1.62, 0);
    holder.add(shell);
    // 散热片墙：壳体一侧成排竖薄板（instanced 在 holder 局部）
    const finTr: InstanceTransform[] = [];
    const fins = 10;
    for (let i = 0; i < fins; i += 1) {
      finTr.push({
        position: new THREE.Vector3(-2.2 + (i / (fins - 1)) * 4.4, 1.62, 2.05),
        rotation: new THREE.Euler(0, 0, 0),
        scale: new THREE.Vector3(1, 1, 1),
      });
    }
    const finInst = instanced(new THREE.BoxGeometry(0.1, 2.3, 0.05), W.metal, finTr);
    finInst.castShadow = false;
    finInst.receiveShadow = false;
    holder.add(finInst);
    // 被掀开的顶盖斜搭在壳顶
    const lid = box(5.6, 0.2, 4, W.rust);
    at(lid, rng.range(-1, 1), 3.55, rng.range(-0.6, 0.6));
    lid.rotation.x = rng.range(0.15, 0.4);
    holder.add(lid);
    // 高压套管（瓷瓶）还插着
    for (const s of [-1.6, 0, 1.6]) {
      const bush = cyl(0.12, 0.16, 1.5, 6, W.ceramic);
      at(bush, s, 4.15, 0);
      bush.rotation.z = rng.range(-0.3, 0.3);
      holder.add(bush);
    }
    // 立着的那台补混凝土基础
    if (!down) {
      const pad = box(6.4, 0.5, 4.6, W.concrete);
      at(pad, 0, 0.25, 0);
      holder.add(pad);
    }
    g.add(holder);
  };
  trafo(-6.2, lim.z0 + 5.2, rng.range(-0.3, 0.3), true);
  trafo(5.8, lim.z0 + 5.4, rng.range(2.8, 3.4), false);

  // —— 扭曲母线：从歪梁垂到变压器顶上，扭成麻花 ——
  for (let i = 0; i < 4; i += 1) {
    const a = new THREE.Vector3(rng.range(-8, 8), gantryY - 0.6, gantryZ);
    const mid = new THREE.Vector3(rng.range(-6, 6), rng.range(4.2, 5.6), gantryZ + rng.range(-1.5, 2));
    const b = new THREE.Vector3(rng.range(-7, 7), rng.range(3.6, 4.6), rng.range(2.6, 4.4));
    const bus = tubeAlong([a, mid, b], 0.13, W.metal, 10);
    parts.push(bus);
  }

  // —— 围栏被压弯（南侧一道，柱头东倒西歪、网片塌落）——
  const fenceZ = lim.z1 - 1;
  for (let i = 0; i <= 10; i += 1) {
    const fx = lim.x0 + 1 + (i / 10) * (lim.x1 - lim.x0 - 2);
    const ph = rng.range(1.5, 1.9);
    const post = box(0.14, ph, 0.14, W.metalDark);
    at(post, fx, ph / 2 * 0.7, fenceZ);
    post.rotation.z = rng.range(-0.5, 0.5);
    post.rotation.x = rng.range(-0.25, 0.25);
    parts.push(post);
    if (i < 10) {
      const meshRail = box((lim.x1 - lim.x0) / 10 * 1.04, 0.06, 0.06, W.wire);
      at(meshRail, (fx * 2 + (lim.x1 - lim.x0) / 10) / 2, rng.chance(0.4) ? 0.9 : rng.range(0.3, 0.7), fenceZ);
      meshRail.rotation.z = rng.range(-0.18, 0.18);
      parts.push(meshRail);
    }
  }

  // —— 油渍：灯油淌出，把碎石染黑 ——
  for (let i = 0; i < 2; i += 1) {
    const oil = mesh(jitter(new THREE.CircleGeometry(1, 12), 0.1, rng), W.oil);
    oil.rotation.x = -Math.PI / 2;
    oil.scale.set(rng.range(2.6, 4.2), rng.range(1.6, 2.6), 1);
    at(oil, i === 0 ? -6.2 : 6, 0.07, 1.6 + rng.range(-0.5, 0.5));
    oil.castShadow = false;
    g.add(oil);
  }

  // —— 碎石瓦砾 ——
  addRubbleField(g, rng, lim, 30, 0.5);

  bakeBuckets(g, parts, 'sub');
  root.add(g);
}

/** 竖杆小件（盒体直接进桶） */
function pushBoxParts(arr: Collector, mat: THREE.Material, x: number, y: number, z: number, w: number, h: number, d: number, ry = 0): void {
  const m = box(w, h, d, mat);
  at(m, x, y, z, ry);
  arr.push(m);
}

function pushRod(arr: Collector, mat: THREE.Material, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
  arr.push(cylinderBetween({ x: x0, y: y0, z: z0 }, { x: x1, y: y1, z: z1 }, 0.08, mat, 4));
}

/** 一片实例化碎石（zone 局部坐标） */
function addRubbleField(g: THREE.Group, rng: Rng, lim: { x0: number; x1: number; z0: number; z1: number }, count: number, size: number): void {
  const tr: InstanceTransform[] = [];
  for (let i = 0; i < count; i += 1) {
    const s = rng.range(0.4, 1.1);
    tr.push({
      position: new THREE.Vector3(rng.range(lim.x0, lim.x1), rng.range(0.08, 0.4) * s, rng.range(lim.z0, lim.z1)),
      rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 6), rng.range(0, 3)),
      scale: new THREE.Vector3(s, s * 0.7, s),
    });
  }
  const inst = instanced(new THREE.DodecahedronGeometry(size, 0), W.rubble, tr);
  inst.name = 'waste-rubble';
  inst.castShadow = false;
  inst.receiveShadow = false;
  g.add(inst);
}

/* ================================================================== *
 * wasteNW：毁果园 + 散兵坑
 * ================================================================== */

function buildOrchard(root: THREE.Group, ctx: BuildContext, zone: Zone): void {
  const rng = ctx.rng.fork(4723);
  const cx = (zone.x0 + zone.x1) / 2;
  const cz = (zone.z0 + zone.z1) / 2;
  const g = group('waste-orchard');
  g.position.set(cx, 0, cz);
  const lim = zoneLimits(zone, cx, cz);

  const parts: Collector = [];

  // —— 成排断掉的果树桩：桩身实例化，断口参差用错位破片 ——
  const stumps: InstanceTransform[] = [];
  const splinters: InstanceTransform[] = [];
  const rows = 4;
  const cols = 6;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x = lim.x0 + 2 + (c / (cols - 1)) * (lim.x1 - lim.x0 - 4) + rng.range(-0.7, 0.7);
      const z = lim.z0 + 2 + (r / (rows - 1)) * (lim.z1 - lim.z0 - 4) + rng.range(-0.7, 0.7);
      if (!rng.chance(0.88)) continue; // 行间有空缺
      const sc = rng.range(0.7, 1.4);
      stumps.push({
        position: new THREE.Vector3(x, 0.55 * sc, z),
        rotation: new THREE.Euler(rng.range(-0.12, 0.12), rng.range(0, TAU), rng.range(-0.12, 0.12)),
        scale: new THREE.Vector3(sc, sc, sc),
      });
      const ns = rng.int(2, 4);
      for (let s = 0; s < ns; s += 1) {
        const a = (s / ns) * TAU + rng.range(-0.5, 0.5);
        splinters.push({
          position: new THREE.Vector3(x + Math.cos(a) * 0.16 * sc, (1.05 + rng.range(0, 0.3)) * sc, z + Math.sin(a) * 0.16 * sc),
          rotation: new THREE.Euler(rng.range(-0.7, 0.7), a, rng.range(-0.7, 0.7)),
          scale: new THREE.Vector3(sc, sc * rng.range(0.7, 1.5), sc),
        });
      }
    }
  }
  const stumpInst = instanced(new THREE.CylinderGeometry(0.16, 0.3, 1.1, 7), W.bark, stumps);
  stumpInst.castShadow = false;
  stumpInst.receiveShadow = false;
  g.add(stumpInst);
  const splInst = instanced(new THREE.BoxGeometry(0.13, 0.45, 0.05), W.bark, splinters);
  splInst.castShadow = false;
  splInst.receiveShadow = false;
  g.add(splInst);

  // —— 倒伏的树：树干横躺 + 带土块的掀翻根部 + 参差断枝 ——
  for (let i = 0; i < 3; i += 1) {
    const tx = rng.range(lim.x0 + 3, lim.x1 - 3);
    const tz = rng.range(lim.z0 + 3, lim.z1 - 3);
    const len = rng.range(4.5, 7);
    const ang = rng.range(0, TAU);
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);
    const trunk = cyl(0.14, 0.34, len, 8, W.bark);
    trunk.rotation.z = Math.PI / 2;
    trunk.rotation.y = -ang;
    at(trunk, tx, 0.36, tz);
    parts.push(trunk);
    // 根部土块（掀翻的泥团）
    const rootBall = mesh(jitter(new THREE.SphereGeometry(0.85, 8, 6), 0.14, rng), W.soil);
    at(rootBall, tx - dx * (len / 2 - 0.3), 0.62, tz - dz * (len / 2 - 0.3));
    parts.push(rootBall);
    // 折断的树冠端：参差斜口
    const broken = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.8, 6), W.bark);
    broken.position.set(tx + dx * (len / 2), 0.5, tz + dz * (len / 2));
    broken.rotation.z = Math.PI / 2 + rng.range(-0.5, 0.5);
    broken.rotation.y = -ang;
    parts.push(broken);
    // 散落的断枝
    for (let b = 0; b < 3; b += 1) {
      const branch = cyl(0.05, 0.09, rng.range(1, 2.2), 5, W.woodDark);
      const bx = tx + rng.range(-2, 2);
      const bz = tz + rng.range(-2, 2);
      at(branch, bx, 0.16, bz, rng.range(0, TAU));
      branch.rotation.z = Math.PI / 2 + rng.range(-0.2, 0.2);
      parts.push(branch);
    }
  }

  // —— 铁丝围的园地：围栏柱 + 下垂铁丝，几处塌口 ——
  const fx = lim.x1 - 1.2;
  const fz = lim.z1 - 1.2;
  const cornerPts: Array<[number, number]> = [
    [-fx, -fz],
    [fx, -fz],
    [fx, fz],
    [-fx, fz],
  ];
  for (const [px, pz] of cornerPts) {
    pushBoxParts(parts, W.woodDark, px, 0.8, pz, 0.16, 1.6, 0.16);
  }
  for (let i = 0; i < cornerPts.length; i += 1) {
    const [ax, az] = cornerPts[i]!;
    const [bx, bz] = cornerPts[(i + 1) % cornerPts.length]!;
    const segs = 4;
    for (let s = 0; s < segs; s += 1) {
      if (rng.chance(0.18)) continue; // 塌口：缺一段
      const t0 = s / segs;
      const t1 = (s + 1) / segs;
      const p0 = new THREE.Vector3(ax + (bx - ax) * t0, 1.45, az + (bz - az) * t0);
      const p1 = new THREE.Vector3(ax + (bx - ax) * t1, 1.45, az + (bz - az) * t1);
      parts.push(tubeAlong(sagPath(p0, p1, rng.range(0.3, 0.9), 5), 0.04, W.wire, 8));
      for (const yy of [1.05, 0.65]) {
        const q0 = p0.clone().setY(yy);
        const q1 = p1.clone().setY(yy);
        parts.push(tubeAlong(sagPath(q0, q1, 0.25, 5), 0.04, W.wire, 8));
      }
    }
    // 每段中间的围栏柱
    for (let s = 1; s < segs; s += 1) {
      const t = s / segs;
      pushBoxParts(parts, W.woodDark, ax + (bx - ax) * t, 0.75, az + (bz - az) * t, 0.1, 1.5, 0.1, rng.range(0, TAU));
    }
  }

  // —— 散兵坑：不规则（椭圆+抖动）、土沿隆起、坑内压黑 ——
  for (let i = 0; i < 5; i += 1) {
    const px = rng.range(lim.x0 + 3, lim.x1 - 3);
    const pz = rng.range(lim.z0 + 3, lim.z1 - 3);
    const rw = rng.range(1.5, 2.6);
    const rd = rw * rng.range(0.6, 0.9);
    const ang = rng.range(0, TAU);
    // 坑底（深色椭圆贴片）
    const pit = mesh(jitter(new THREE.CircleGeometry(1, 11), 0.08, rng), W.dark);
    pit.rotation.x = -Math.PI / 2;
    pit.scale.set(rw, rd, 1);
    pit.rotation.z = ang;
    at(pit, px, 0.075, pz);
    parts.push(pit);
    // 隆起的土沿（压扁的抖动环）
    const lip = mesh(jitter(new THREE.TorusGeometry(1, 0.3, 5, 12), 0.1, rng), W.soil);
    lip.rotation.x = -Math.PI / 2;
    lip.scale.set(rw * 1.04, rd * 1.04, 0.6);
    lip.rotation.z = ang;
    at(lip, px, 0.2, pz);
    parts.push(lip);
    // 坑壁暗示：一圈下收的深色锥裙
    const skirt = cyl(rw * 0.94, rw * 0.6, 0.5, 10, W.dark);
    skirt.scale.set(1, 1, rd / rw);
    at(skirt, px, 0.18, pz, ang);
    parts.push(skirt);
    // 翻出来的土堆在坑一侧
    const spoil = mesh(jitter(new THREE.SphereGeometry(0.9, 7, 5), 0.16, rng), W.dirt);
    spoil.scale.set(rng.range(1.2, 1.8), 0.5, rng.range(0.9, 1.2));
    at(spoil, px + Math.cos(ang) * (rw + 0.8), 0.16, pz + Math.sin(ang) * (rd + 0.8));
    parts.push(spoil);
  }

  // —— 翻倒的手推车与木箱 ——
  wheelbarrow(parts, rng, rng.range(lim.x0 + 2, lim.x0 + 6), rng.range(lim.z0 + 2, lim.z1 - 2), rng.range(0, TAU));
  for (let i = 0; i < 5; i += 1) {
    const bx = rng.range(lim.x0 + 2, lim.x1 - 2);
    const bz = rng.range(lim.z0 + 2, lim.z1 - 2);
    const w = rng.range(0.8, 1.4);
    const cr = box(w, w * 0.62, w * 0.9, W.wood);
    at(cr, bx, w * 0.31, bz, rng.range(0, TAU));
    if (rng.chance(0.4)) cr.rotation.z = rng.range(1.1, 1.6);
    parts.push(cr);
    // 板缝深色条
    pushBoxParts(parts, W.woodDark, bx, w * 0.5, bz, w * 0.92, 0.05, 0.02, rng.range(0, TAU));
  }

  addRubbleField(g, rng, lim, 18, 0.36);
  bakeBuckets(g, parts, 'orch');
  root.add(g);
}

/** 翻倒的手推车：侧躺车斗 + 轮子 + 两根把手 */
function wheelbarrow(parts: Collector, rng: Rng, x: number, z: number, rotY: number): void {
  const bed = softBox(1.7, 0.75, 1.1, 0.1, W.wood);
  bed.position.set(x, 0.62, z);
  bed.rotation.set(0, rotY, Math.PI / 2 + rng.range(-0.2, 0.2));
  parts.push(bed);
  const dxw = Math.cos(rotY);
  const dzw = Math.sin(rotY);
  const wheel = cyl(0.46, 0.46, 0.2, 12, W.woodDark);
  wheel.rotation.z = Math.PI / 2;
  wheel.rotation.y = -rotY;
  at(wheel, x + dxw * 1.15, 0.46, z + dzw * 1.15);
  parts.push(wheel);
  for (const s of [-1, 1]) {
    const hx = x - dxw * 1.7 - dzw * s * 0.32;
    const hz = z - dzw * 1.7 + dxw * s * 0.32;
    parts.push(cylinderBetween({ x: hx, y: 0.2, z: hz }, { x: x - dxw * 0.4, y: 0.7, z: z - dzw * 0.4 }, 0.06, W.woodDark, 4));
  }
}

/* ================================================================== *
 * wasteNE：坍了半边的谷物筒仓（锚点 HOTSPOTS.silo）
 * ================================================================== */

function buildSilos(root: THREE.Group, ctx: BuildContext, zone: Zone): void {
  const rng = ctx.rng.fork(5107);
  const anchor = HOTSPOTS.silo;
  const g = group('waste-silos');
  g.position.set(anchor.x, 0, anchor.z);
  const lim = zoneLimits(zone, anchor.x, anchor.z);

  const parts: Collector = [];
  const seams: InstanceTransform[] = []; // 波纹板竖缝
  const bands: InstanceTransform[] = []; // 环形焊缝
  const rungs: InstanceTransform[] = []; // 爬梯横档

  const R = 3.35;
  // 六角布位：两排错位，2 座从顶部撕裂（行距收紧以让出撕裂破片的翻卷余量）
  const layout: Array<{ x: number; z: number; h: number; torn: boolean; tilt: number }> = [
    { x: -R - 0.95, z: -8.2, h: 24, torn: false, tilt: 0 },
    { x: R + 0.95, z: -8.2, h: 21, torn: false, tilt: 0 },
    { x: -R - 0.95, z: 0, h: 27, torn: false, tilt: 0 },
    { x: R + 0.95, z: 0.4, h: 23, torn: true, tilt: 0 },
    { x: -R - 0.95, z: 8.2, h: 18, torn: false, tilt: 0 },
    { x: R + 0.95, z: 8.2, h: 25, torn: true, tilt: 0.05 },
  ];

  for (const sl of layout) {
    const { x, z, h, torn, tilt } = sl;
    const body = cyl(R, R * 1.01, h, 14, W.siloSheet);
    body.rotation.z = tilt;
    at(body, x, h / 2, z);
    parts.push(body);
    // 波纹板竖缝：一圈薄竖条（实例化）
    const seamN = 18;
    for (let i = 0; i < seamN; i += 1) {
      const a = (i / seamN) * TAU;
      rungsSeam(seams, x + Math.cos(a) * (R + 0.04), z + Math.sin(a) * (R + 0.04), h, a);
    }
    // 环形焊缝
    const bandN = Math.floor(h / 3.4);
    for (let i = 1; i <= bandN; i += 1) {
      const y = (h * i) / (bandN + 1);
      bands.push({ position: new THREE.Vector3(x, y, z), rotation: new THREE.Euler(-Math.PI / 2, 0, 0), scale: new THREE.Vector3(1, 1, 1) });
    }
    // 锥顶 + 检修帽（撕裂的没有顶）
    if (!torn) {
      const cap = cone(R * 1.02, R * 0.75, W.rust, 12);
      at(cap, x, h + R * 0.36, z);
      parts.push(cap);
      const hatch = cyl(0.45, 0.45, 0.28, 6, W.dark);
      at(hatch, x, h + R * 0.72 + 0.1, z);
      parts.push(hatch);
    } else {
      // 从顶部撕裂：金属板向外翻卷、参差破口
      const n = rng.int(7, 10);
      for (let i = 0; i < n; i += 1) {
        const a = (i / n) * TAU + rng.range(-0.25, 0.25);
        const flapLen = rng.range(1.8, 4.6);
        const flap = box(0.14, flapLen, R * 0.4, W.rust);
        const fx = x + Math.cos(a) * (R - 0.05);
        const fz = z + Math.sin(a) * (R - 0.05);
        flap.position.set(fx, h - flapLen * 0.35, fz);
        flap.rotation.y = -a;
        flap.rotation.x = Math.sin(a) * rng.range(-0.5, 0.5);
        flap.rotation.z = Math.cos(a) * rng.range(0.2, 0.6); // 向外翻卷
        parts.push(flap);
      }
      // 撕裂口内的暗腔 + 筒内粮食面
      const cavity = cyl(R * 0.88, R * 0.88, 5, 12, W.dark);
      at(cavity, x, h - 2.7, z);
      parts.push(cavity);
      const gface = cyl(R * 0.84, R * 0.84, 0.3, 12, W.grain);
      at(gface, x, h - 4.5, z);
      parts.push(gface);
      // 外流的谷堆：从破口向场地中心一侧倾泻（贴地锥 + 摊开的谷面）
      const plen = Math.hypot(x, z) || 1;
      const ux = -x / plen;
      const uz = -z / plen;
      const pileR = rng.range(1.9, 2.7);
      const pile = mesh(jitter(new THREE.ConeGeometry(pileR, rng.range(2.6, 3.6), 11), 0.22, rng), W.grain);
      pile.position.set(x + ux * (R + 1.9), 1.35, z + uz * (R + 1.9));
      pile.scale.set(1, rng.range(0.8, 1.1), 0.85);
      pile.castShadow = false;
      parts.push(pile);
      const spread = mesh(jitter(new THREE.CircleGeometry(1, 11), 0.08, rng), W.grain);
      spread.rotation.x = -Math.PI / 2;
      spread.scale.set(pileR * 0.95, pileR * 0.7, 1);
      at(spread, pile.position.x + ux * 0.4, 0.08, pile.position.z + uz * 0.4);
      spread.castShadow = false;
      parts.push(spread);
    }
    // 爬梯：横档实例化 + 两条立杆（朝场地中心一侧）
    const lx = x + (x >= 0 ? -(R + 0.12) : R + 0.12);
    const stepsN = Math.floor(h / 0.55);
    for (let i = 1; i < stepsN; i += 1) {
      rungs.push({ position: new THREE.Vector3(lx, i * 0.55, z), rotation: new THREE.Euler(0, 0, Math.PI / 2), scale: new THREE.Vector3(1, 1, 1) });
    }
    for (const dzs of [-0.22, 0.22]) {
      pushRod(parts, W.metalDark, lx, 0.3, z + dzs, lx, h * 0.96, z + dzs);
    }
    // 检修门（朝中心一面的深色方门）
    const doorIn = x >= 0 ? -1 : 1;
    pushBoxParts(parts, W.dark, x + doorIn * (R + 0.02), h * 0.22, z, 0.16, 1.5, 1.05);
  }

  // 倒塌时压弯的输送廊：从撕裂筒顶斜插出去、中段折断砸向相邻筒
  const gallery = (from: { x: number; z: number; y: number }, to: { x: number; z: number; y: number }, drop: number): void => {
    const a = new THREE.Vector3(from.x, from.y, from.z);
    const mid = new THREE.Vector3((from.x + to.x) / 2, (from.y + to.y) / 2 - drop * 0.55, (from.z + to.z) / 2);
    const b = new THREE.Vector3(to.x, to.y, to.z);
    const tube = tubeAlong([a, mid, b], 1.15, W.rust, 14);
    parts.push(tube);
    // 廊身加强箍（随弯垂走）
    const hoops = 5;
    const dir = b.clone().sub(a).normalize();
    for (let i = 1; i < hoops; i += 1) {
      const t = i / hoops;
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(1.28, 0.09, 3, 10), W.metalDark);
      hoop.position.copy(a.clone().lerp(b, t).setY(a.clone().lerp(b, t).y - Math.sin(Math.PI * t) * drop * 0.3));
      hoop.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      parts.push(hoop);
    }
  };
  gallery({ x: R + 0.95, z: 0.4, y: 22 }, { x: -R - 0.95, z: 8.2, y: 7.5 }, 4.5);
  // 输送廊支架：两根被压弯的立柱
  for (const [sx, sz, sh] of [[0, 4.6, 9.5], [-2.2, 7, 6.2]] as Array<[number, number, number]>) {
    const leg = cyl(0.3, 0.36, sh, 6, W.metalDark);
    leg.rotation.z = rng.range(-0.3, 0.3);
    at(leg, sx, sh / 2, sz);
    parts.push(leg);
  }

  // 筒仓群共用的混凝土设备平台（边缘破损）
  const deck = box(lim.x1 - lim.x0 - 2, 0.5, lim.z1 - lim.z0 - 2, W.concrete);
  at(deck, 0, 0.24, 0);
  parts.push(deck);
  for (let i = 0; i < 6; i += 1) {
    const chip = mesh(jitter(new THREE.BoxGeometry(rng.range(1.2, 2.6), 0.3, rng.range(1, 2)), 0.2, rng), W.rubble);
    chip.position.set(rng.range(lim.x0 + 1, lim.x1 - 1), 0.52, i % 2 === 0 ? lim.z1 - 1.5 : lim.z0 + 1.5);
    chip.rotation.y = rng.range(0, TAU);
    parts.push(chip);
  }

  // 实例化批次：波纹竖缝 / 环形焊缝 / 爬梯横档（各一个 draw call）
  bakeBuckets(g, parts, 'silo');

  const corrugInst = instanced(new THREE.BoxGeometry(0.07, 1, 0.045), W.siloCorrug, seams);
  corrugInst.castShadow = false;
  corrugInst.receiveShadow = false;
  corrugInst.name = 'silo-corrug';
  g.add(corrugInst);
  const bandInst = instanced(new THREE.TorusGeometry(R + 0.05, 0.06, 3, 14), W.siloCorrug, bands);
  bandInst.castShadow = false;
  bandInst.receiveShadow = false;
  bandInst.name = 'silo-bands';
  g.add(bandInst);
  const rungInst = instanced(new THREE.BoxGeometry(0.45, 0.05, 0.05), W.metalDark, rungs);
  rungInst.castShadow = false;
  rungInst.receiveShadow = false;
  rungInst.name = 'silo-rungs';
  g.add(rungInst);

  addRubbleField(g, rng, lim, 24, 0.5);
  root.add(g);
}

/** 波纹竖缝变换：每根缝是一段按筒高切分的竖条 */
function rungsSeam(list: InstanceTransform[], x: number, z: number, h: number, a: number): void {
  const per = Math.max(3, Math.round(h / 7));
  for (let i = 0; i < per; i += 1) {
    const segH = h / per;
    list.push({
      position: new THREE.Vector3(x, segH * (i + 0.5), z),
      rotation: new THREE.Euler(0, -a, 0),
      scale: new THREE.Vector3(1, segH, 1),
    });
  }
}

/* ================================================================== *
 * 主入口 2：三个 wasteland zone 实体
 * ================================================================== */

export function buildEdgeWaste(ctx: BuildContext): THREE.Group {
  const root = group('edge-waste');
  const waste = ZONES.filter((z) => z.use === 'wasteland');
  for (const zone of waste) {
    // 净空契约：整块 zone 必须可建造（不在车道/人行道走廊、不压既有足迹、在底座内）
    if (!canPlace(zone)) continue;
    if (zone.id === 'wasteSW') buildSubstation(root, ctx, zone);
    else if (zone.id === 'wasteNW') buildOrchard(root, ctx, zone);
    else if (zone.id === 'wasteNE') buildSilos(root, ctx, zone);
  }
  return root;
}
