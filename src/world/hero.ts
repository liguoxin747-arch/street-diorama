import * as THREE from 'three';
import { PALETTE } from '../core/palette';
import {
  basicMaterial,
  canvasTexture,
  glowMaterial,
  toonGradient,
  toonMaterial,
  withOutline,
} from '../core/materials';
import {
  at,
  box,
  cylinderBetween,
  cyl,
  group,
  instanced,
  jitter,
  mergeMeshes,
  mesh,
  softBox,
  type InstanceTransform,
} from '../core/geo';
import {
  acUnitGeometry,
  brickGeometry,
  chippedSlab,
  debrisRing,
  downpipeGeometry,
  gutterGeometry,
  mergeAll,
  tileGeometry,
  windowFrameGeometry,
} from '../core/detail';
import type { BuildContext } from '../core/context';
import type { Rng } from '../core/rng';
import { HERO, HOTSPOTS } from './layout';

/**
 * 主楼：路口东北角的东欧/苏联式街角三层住宅 + 底商。
 *
 * 平面：占地 x[12,34] z[-34,-13]，西南街角切角 3.6m（商铺门面正对十字路口）。
 * 竖向：底层 4.3m（商铺 + 后厨 + 楼梯间 + 储藏），二层 3.3m（住宅），
 *       三层 3.3m（残破住宅 + 避难角），檐口 10.9m，女儿墙约 11.3m。
 *
 * 建模原则：
 * - 外墙按"开洞"生成墙板（真洞，能看到墙厚与室内），而不是贴片伪装；
 * - 楼板是真楼板（有洞口、有断面边缘），室内从任何破洞看进去都成立；
 * - 所有静态碎件最终按材质 merge 成极少数网格，瓦砾/纸张/书籍走 instanced，
 *   控制 mesh 数与 draw call。
 */

/* ------------------------------------------------------------------ *
 * 尺寸常量（全部来自 layout.ts 的 HERO，避免各处写魔法数）
 * ------------------------------------------------------------------ */

const X0 = HERO.x0; // 12
const X1 = HERO.x1; // 34
const Z0 = HERO.z0; // -34
const Z1 = HERO.z1; // -13
const CUT = HERO.cornerCut; // 3.6
const WALL = HERO.wall; // 0.55
const F1 = HERO.groundHeight; // 4.3 一层楼面
const F2 = F1 + HERO.upperHeight; // 7.6 二层楼面
const EAVE = HERO.eaveY; // 10.9 檐口
const SLAB = 0.3; // 楼板厚
const GF = 0.2; // 底层室内地坪（比人行道高一步）
const F1Y = F1 + 0.02;
const F2Y = F2 + 0.02;
const PARA = 0.26; // 女儿墙高（屋面顶 11.06 → 女儿墙顶 11.32）
const SILL = 0.9;
const WH = 1.5;
const W1A = F1 + SILL; // 5.2
const W1B = W1A + WH; // 6.7
const W2A = F2 + SILL; // 8.5
const W2B = W2A + WH; // 10.0

/** 建筑平面轮廓（顺时针，XZ） */
const FOOTPRINT: Array<[number, number]> = [
  [X0, Z1 - CUT],
  [X0, Z0],
  [X1, Z0],
  [X1, Z1],
  [X0 + CUT, Z1],
];

/* ------------------------------------------------------------------ *
 * 墙面坐标系：局部 u 沿墙、y 向上、z 沿外法线
 * ------------------------------------------------------------------ */

interface Wall {
  sx: number;
  sz: number;
  dx: number;
  dz: number;
  nx: number;
  nz: number;
  len: number;
  theta: number;
}

function makeWall(nx: number, nz: number, sx: number, sz: number, len: number): Wall {
  return { sx, sz, dx: nz, dz: -nx, nx, nz, len, theta: Math.atan2(nx, nz) };
}

function wallPoint(w: Wall, u: number, y: number, zl: number): THREE.Vector3 {
  return new THREE.Vector3(w.sx + w.dx * u + w.nx * zl, y, w.sz + w.dz * u + w.nz * zl);
}

function wallBox(
  w: Wall,
  cu: number,
  cy: number,
  zl: number,
  sw: number,
  sh: number,
  sd: number,
  mat: THREE.Material,
): THREE.Mesh {
  const m = box(sw, sh, sd, mat);
  m.position.copy(wallPoint(w, cu, cy, zl));
  m.rotation.y = w.theta;
  return m;
}

/**
 * 在墙面上放置一个几何体。
 * 局部坐标约定：x = 沿墙 u，y = 向上，z = 沿外法线（墙外表面在 z=0，墙内表面在 z=-WALL）。
 */
function wallGeom(
  k: Kit,
  w: Wall,
  u: number,
  y: number,
  zl: number,
  geom: THREE.BufferGeometry,
  mat: THREE.Material,
): THREE.Mesh {
  const m = mesh(geom, mat);
  m.position.copy(wallPoint(w, u, y, zl));
  m.rotation.y = w.theta;
  k.put(m);
  return m;
}

/**
 * 沿墙 u 方向挤出一个"侧视轮廓"。
 * 轮廓平面是 (x = 外法线方向, y = 向上)，挤出方向是 u。
 * 用来做腰线、窗台、压顶这类有斜面/滴水的构件——轮廓是几何，不是贴图。
 */
function profileBand(build: (s: THREE.Shape) => void, length: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  build(s);
  const g = new THREE.ExtrudeGeometry(s, { depth: length, bevelEnabled: false, curveSegments: 4 });
  // 挤出方向 z → -x，轮廓 x（外法线）→ +z
  g.rotateY(-Math.PI / 2);
  g.translate(length / 2, 0, 0);
  return g;
}

/** 外挑窗台：内端贴墙、外端带斜面滴水 */
function sillProfile(s: THREE.Shape): void {
  s.moveTo(0, 0);
  s.lineTo(0.17, -0.035);
  s.lineTo(0.17, -0.125);
  s.lineTo(0, -0.09);
  s.closePath();
}

/** 窗台下的墙裙起拱：底部外鼓的弧形线脚（真实体积） */
function apronProfile(s: THREE.Shape): void {
  s.moveTo(0, 0);
  s.lineTo(0.075, -0.02);
  s.lineTo(0.075, -0.15);
  s.quadraticCurveTo(0.07, -0.235, 0, -0.19);
  s.closePath();
}

/** 楼层腰线：上缘平直、外挑、下缘带斜面与一道滴水凹槽 */
function bandProfile(s: THREE.Shape): void {
  s.moveTo(0, 0.09);
  s.lineTo(0.13, 0.06);
  s.lineTo(0.13, -0.06);
  s.lineTo(0.09, -0.1);
  s.lineTo(0.09, -0.14);
  s.lineTo(0, -0.14);
  s.closePath();
}

/** 女儿墙压顶：上表面带勾缝分块（x 为外法线方向，中心略偏内） */
function copingProfile(s: THREE.Shape): void {
  s.moveTo(-0.16, -0.07);
  s.lineTo(0.18, -0.07);
  s.lineTo(0.18, 0.0);
  s.lineTo(0.14, 0.055);
  s.lineTo(-0.16, 0.055);
  s.closePath();
}

/** 勒脚线脚：底部外撇的斜面 */
function plinthProfile(s: THREE.Shape): void {
  s.moveTo(0, 0.3);
  s.lineTo(0.1, 0.27);
  s.lineTo(0.1, -0.3);
  s.lineTo(0, -0.3);
  s.closePath();
}

/** 参差玻璃残片：锯齿状多边形 + 厚度（不是完整矩形面片） */
function jaggedPaneGeometry(width: number, height: number, rng: Rng): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const pts: THREE.Vector2[] = [];
  const n = 9;
  const hw = width / 2;
  const hh = height / 2;
  for (let i = 0; i < n; i += 1) {
    const ang = (i / n) * Math.PI * 2;
    const r = 0.62 + rng.next() * 0.38;
    pts.push(new THREE.Vector2(Math.cos(ang) * hw * r, Math.sin(ang) * hh * r));
  }
  s.setFromPoints(pts);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.014, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -0.007);
  return fixSlabNormals(g);
}

/** 弹孔周围被崩开的浅色墙皮环（明度分层：暗孔 < 环 < 墙） */
function craterRingGeometry(): THREE.BufferGeometry {
  const g = new THREE.RingGeometry(0.026, 0.062, 9);
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y) || 1;
    const j = (((i * 37) % 11) / 11 - 0.5) * 0.012;
    pos.setXY(i, x + (x / r) * j, y + (y / r) * j);
  }
  pos.needsUpdate = true;
  return g;
}

/** 外露钢筋：带弯折的细圆柱（两段折线） */
function rebarGeometry(len: number, bend: number): THREE.BufferGeometry {
  const a = new THREE.CylinderGeometry(0.014, 0.014, len, 5);
  a.translate(0, len / 2, 0);
  const b = new THREE.CylinderGeometry(0.014, 0.012, bend, 5);
  b.rotateX(Math.PI / 2.6);
  b.translate(0, len, bend * 0.35);
  return mergeAll([a, b]);
}

/** 楼板断面：三层可见的板层（面层 / 钢筋网 / 底面） */
function slabSectionGeometry(w: number, d: number, t: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const top = new THREE.BoxGeometry(w, t * 0.4, d);
  top.translate(0, t * 0.3, 0);
  parts.push(top);
  const mid = new THREE.BoxGeometry(w * 0.97, t * 0.28, d * 0.94);
  mid.translate(0, -t * 0.08, 0);
  parts.push(mid);
  const bot = new THREE.BoxGeometry(w * 0.92, t * 0.32, d * 0.86);
  bot.translate(0, -t * 0.36, 0);
  parts.push(bot);
  // 钢筋：断面里露出的一排小圆头
  const n = Math.max(2, Math.round(w / 0.5));
  for (let i = 0; i < n; i += 1) {
    const r = new THREE.CylinderGeometry(0.016, 0.016, 0.12, 5);
    r.rotateX(Math.PI / 2);
    r.translate(-w / 2 + ((i + 0.5) * w) / n, -t * 0.08, d / 2);
    parts.push(r);
  }
  return mergeAll(parts);
}

/**
 * 修正挤出体的法线朝向。
 * ExtrudeGeometry 在点序为顺时针时会把端面法线翻向内部，
 * 三渲二下会渲染成一块"发白"的贴纸 —— 这里统一翻回朝外。
 */
function fixSlabNormals(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.computeVertexNormals();
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  if (!pos || !nor) return g;
  g.computeBoundingBox();
  const c = new THREE.Vector3();
  (g.boundingBox as THREE.Box3).getCenter(c);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  let dot = 0;
  for (let i = 0; i < pos.count; i += 1) {
    p.fromBufferAttribute(pos, i).sub(c);
    n.fromBufferAttribute(nor, i);
    dot += p.dot(n);
  }
  if (dot < 0) {
    for (let i = 0; i < nor.count; i += 1) {
      nor.setXYZ(i, -nor.getX(i), -nor.getY(i), -nor.getZ(i));
    }
    nor.needsUpdate = true;
  }
  return g;
}

const WEST = makeWall(-1, 0, X0, Z0, Z1 - Z0 - CUT); // u = z + 34
const CHAMFER = makeWall(-Math.SQRT1_2, Math.SQRT1_2, X0, Z1 - CUT, CUT * Math.SQRT2); // 商铺门面
const SOUTH = makeWall(0, 1, X0 + CUT, Z1, X1 - X0 - CUT); // u = x - 15.6
const EAST = makeWall(1, 0, X1, Z1, Z1 - Z0); // u = -13 - z
const NORTH = makeWall(0, -1, X1, Z0, X1 - X0); // u = 34 - x
const WALLS: Wall[] = [WEST, CHAMFER, SOUTH, EAST, NORTH];

/**
 * 窗洞内景表：哪个窗亮着、里面有什么家具。
 * 只有约三分之一的窗亮着（warm/ember/cold），其余是幽暗房间 + 家具剪影。
 * 放在模块级，好让 buildHole 知道"这扇亮着的窗不要加玻璃碎片"。
 */
const BAYS: BaySpec[] = [
  // —— 西立面（正对纵街，斜视也能看到）——
  { wall: WEST, u0: 3.4, u1: 5.6, y0: W1A, y1: W1B, floorY: F1Y, mood: 'cold', form: 'shelf' },
  { wall: WEST, u0: 8.4, u1: 10.6, y0: W1A, y1: W1B, floorY: F1Y, mood: 'dark', form: 'chairs' },
  { wall: WEST, u0: 4.2, u1: 6.4, y0: W2A, y1: W2B, floorY: F2Y, mood: 'dark', form: 'wardrobe' },
  { wall: WEST, u0: 9.0, u1: 11.2, y0: W2A, y1: W2B, floorY: F2Y, mood: 'warm', form: 'table' },
  { wall: WEST, u0: 13.0, u1: 15.2, y0: W2A, y1: W2B, floorY: F2Y, mood: 'dark', form: 'bed' },

  // —— 切角（正对路口，最醒目）——
  { wall: CHAMFER, u0: 1.5, u1: 3.5, y0: W1A, y1: W1B, floorY: F1Y, mood: 'dark', form: 'wardrobe' },
  { wall: CHAMFER, u0: 1.5, u1: 3.5, y0: W2A, y1: W2B, floorY: F2Y, mood: 'warm', form: 'bed' },

  // —— 南立面（正对大道）——
  { wall: SOUTH, u0: 1.7, u1: 3.9, y0: W1A, y1: W1B, floorY: F1Y, mood: 'warm', form: 'table' },
  { wall: SOUTH, u0: 5.2, u1: 7.4, y0: W1A, y1: W1B, floorY: F1Y, mood: 'dark', form: 'chairs' },
  { wall: SOUTH, u0: 2.0, u1: 4.2, y0: W2A, y1: W2B, floorY: F2Y, mood: 'dark', form: 'shelf' },
  { wall: SOUTH, u0: 6.2, u1: 8.4, y0: W2A, y1: W2B, floorY: F2Y, mood: 'ember', form: 'counter' },
  { wall: SOUTH, u0: 15.4, u1: 17.4, y0: W2A, y1: W2B, floorY: F2Y, mood: 'dark', form: 'rubble' },

  // —— 东立面（小巷）——
  { wall: EAST, u0: 3.0, u1: 5.0, y0: W1A, y1: W1B, floorY: F1Y, mood: 'dark', form: 'shelf' },
  { wall: EAST, u0: 9.0, u1: 11.0, y0: W1A, y1: W1B, floorY: F1Y, mood: 'dark', form: 'chairs' },
  { wall: EAST, u0: 2.4, u1: 4.4, y0: W2A, y1: W2B, floorY: F2Y, mood: 'dark', form: 'bed' },
  { wall: EAST, u0: 8.4, u1: 10.4, y0: W2A, y1: W2B, floorY: F2Y, mood: 'dark', form: 'table' },
  { wall: EAST, u0: 14.4, u1: 16.4, y0: W2A, y1: W2B, floorY: F2Y, mood: 'dark', form: 'wardrobe' },

  // —— 北立面（多数机位被后排楼挡住，仍补上，换个角度能读到）——
  { wall: NORTH, u0: 4.4, u1: 6.4, y0: W1A, y1: W1B, floorY: F1Y, mood: 'dark', form: 'chairs' },
  { wall: NORTH, u0: 10.0, u1: 12.0, y0: W1A, y1: W1B, floorY: F1Y, mood: 'dark', form: 'shelf' },
  { wall: NORTH, u0: 15.4, u1: 17.0, y0: W2A, y1: W2B, floorY: F2Y, mood: 'dark', form: 'table' },
];

/** 找到某个洞口对应的内景（用于判断"亮窗不要加玻璃"） */
function bayFor(w: Wall, u0: number, u1: number): BaySpec | undefined {
  return BAYS.find((b) => b.wall === w && Math.abs(b.u0 - u0) < 0.01 && Math.abs(b.u1 - u1) < 0.01);
}

/* ------------------------------------------------------------------ *
 * 材质
 * ------------------------------------------------------------------ */

function makeMats() {
  const signTex = canvasTexture(256, 96, (c, w, h) => {
    c.fillStyle = '#3a3029';
    c.fillRect(0, 0, w, h);
    c.strokeStyle = '#8f7a5e';
    c.lineWidth = 6;
    c.strokeRect(6, 6, w - 12, h - 12);
    c.fillStyle = '#d6c6a6';
    c.font = 'bold 42px "Segoe UI", Arial, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('ПРОДУКТЫ', w / 2, h / 2 + 2);
    // 磨损刮痕
    c.fillStyle = 'rgba(18,15,13,0.6)';
    for (let i = 0; i < 34; i += 1) {
      c.fillRect((i * 37) % w, (i * 53) % h, 10 + ((i * 7) % 26), 3 + ((i * 5) % 5));
    }
  });

  const posterTex = canvasTexture(128, 180, (c, w, h) => {
    c.fillStyle = '#b7aa90';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#8e3b38';
    c.fillRect(9, 11, w - 18, 54);
    c.fillStyle = '#d9cdb2';
    c.beginPath();
    c.arc(w / 2, 38, 14, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#5d5145';
    for (let i = 0; i < 8; i += 1) {
      c.fillRect(15, 80 + i * 11, (w - 30) * (0.55 + ((i * 37) % 40) / 90), 4);
    }
    c.fillStyle = 'rgba(38,32,26,0.45)';
    for (let i = 0; i < 20; i += 1) {
      c.fillRect((i * 43) % w, (i * 59) % h, 8 + ((i * 3) % 7) * 4, 4 + ((i * 5) % 3) * 5);
    }
  });

  const wallpaperTex = canvasTexture(128, 128, (c, w, h) => {
    c.fillStyle = '#8b8474';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#7b8578';
    for (let i = 0; i < w; i += 18) c.fillRect(i, 0, 7, h);
    c.fillStyle = 'rgba(74,66,56,0.32)';
    for (let i = 0; i < 9; i += 1) {
      c.beginPath();
      c.arc((i * 31) % w, (i * 47) % h, 9 + ((i * 11) % 14), 0, Math.PI * 2);
      c.fill();
    }
  });

  return {
    plaster: toonMaterial(PALETTE.plasterCold, { steps: 3 }),
    plasterWarm: toonMaterial(PALETTE.plasterWarm, { steps: 3 }),
    /** 剥落墙皮：比墙体暗一档（不要比墙亮，否则像贴纸） */
    peel: toonMaterial(0x6f7681, { steps: 2 }),
    peelDeep: toonMaterial(0x5d646e, { steps: 2 }),
    /** 外露砖芯：去饱和锈褐，比墙面暗，比墙皮亮 */
    brick: toonMaterial(0x6b5a4e, { steps: 2 }),
    brickDark: toonMaterial(0x574a42, { steps: 2 }),
    concrete: toonMaterial(PALETTE.concrete, { steps: 3 }),
    concreteDark: toonMaterial(PALETTE.concreteDark, { steps: 2 }),
    stain: toonMaterial(PALETTE.concreteStain, { steps: 2 }),
    /** 腰线/檐口/窗台：水平面会被天光照亮，特意压暗到接近墙体 */
    band: toonMaterial(0x686e77, { steps: 2 }),
    bandWarm: toonMaterial(0x8d7f6a, { steps: 2 }),
    soot: toonMaterial(PALETTE.soot, { steps: 2 }),
    burnt: toonMaterial(PALETTE.burnt, { steps: 2 }),
    woodOld: toonMaterial(PALETTE.woodOld, { steps: 2 }),
    woodDark: toonMaterial(PALETTE.woodDark, { steps: 2 }),
    timber: toonMaterial(PALETTE.timber, { steps: 2 }),
    /** 风化的封窗木板：低饱和灰褐，比原来的木色暗 40% */
    board: toonMaterial(0x554b40, { steps: 2 }),
    boardAlt: toonMaterial(0x453d34, { steps: 2 }),
    metal: toonMaterial(PALETTE.metalDoor, { steps: 3 }),
    rust: toonMaterial(PALETTE.rust, { steps: 2 }),
    steel: toonMaterial(PALETTE.trackMetal, { steps: 2 }),
    glass: toonMaterial(PALETTE.glassBroken, { steps: 2, transparent: true, opacity: 0.5 }),
    paper: toonMaterial(PALETTE.paper, { steps: 2 }),
    fabric: toonMaterial(PALETTE.fabricRed, { steps: 2 }),
    tarp: toonMaterial(PALETTE.tarp, { steps: 2 }),
    sandbag: toonMaterial(PALETTE.sandbag, { steps: 2 }),
    sandbagDark: toonMaterial(PALETTE.sandbagDark, { steps: 2 }),
    roof: toonMaterial(PALETTE.roof, { steps: 2 }),
    roofRust: toonMaterial(PALETTE.roofRust, { steps: 2 }),
    /** 屋面碎块：低饱和水泥灰，只比屋面亮一点点 */
    roofDebris: toonMaterial(0x474c52, { steps: 2 }),
    /** 翘起的油毡/屋面板：深灰褐，有厚度 */
    roofPatch: toonMaterial(0x4b4640, { steps: 2 }),
    /** 女儿墙压顶 / 楼层腰线：压到中灰，比墙略亮 */
    coping: toonMaterial(0x434a52, { steps: 2 }),
    rustDark: toonMaterial(PALETTE.rustDark, { steps: 2 }),
    dirt: toonMaterial(PALETTE.dirt, { steps: 2 }),
    paint: toonMaterial(PALETTE.paint, { steps: 2 }),
    sign: new THREE.MeshToonMaterial({ map: signTex, gradientMap: toonGradient(3) }),
    poster: new THREE.MeshToonMaterial({ map: posterTex, gradientMap: toonGradient(3) }),
    wallpaper: new THREE.MeshToonMaterial({ map: wallpaperTex, gradientMap: toonGradient(3) }),
    glowWarm: glowMaterial(PALETTE.warmLight, 1),
    glowFire: glowMaterial(PALETTE.fire, 0.92),
    glowEmber: glowMaterial(PALETTE.fireCore, 1),
    glowCold: glowMaterial(PALETTE.coldLamp, 0.55),
    /** 窗口内的暖光背景（有人住的房间） */
    roomLit: glowMaterial(PALETTE.warmLight, 0.92),
    /** 窗口内的暖光背景（更深一档，蜡烛/炉火） */
    roomLitDeep: glowMaterial(0xff9d4d, 0.78),
    /** 窗口内的冷色应急灯 */
    roomCold: glowMaterial(0x8fbde0, 0.6),
    /** 黑洞房间的背墙（比纯黑亮一点点，读得出"有进深"） */
    roomDark: basicMaterial(0x1d232b, { fog: true }),
    /** 暗房里的家具剪影（比背墙略亮，读得出体积） */
    roomForm: basicMaterial(0x343c46, { fog: true }),
    /** 室内地面反光片 */
    roomFloor: basicMaterial(0x323a44, { fog: true }),
    /** 亮窗在洞口平面的暖光（斜视也能看到"窗里有光"） */
    winWarm: basicMaterial(PALETTE.warmLight, { opacity: 0.78, transparent: true, fog: false }),
    winEmber: basicMaterial(0xff9d4d, { opacity: 0.74, transparent: true, fog: false }),
    winCold: basicMaterial(0x86b6dc, { opacity: 0.6, transparent: true, fog: false }),
    /** 暗窗在洞口平面的幽暗面（不是纯黑洞，读得出"里面有进深"） */
    winDark: basicMaterial(0x1a2027, { opacity: 0.9, transparent: true, fog: false }),
    /** 塌口里房间深处的一点微光 */
    roomDim: glowMaterial(0x6a4a2c, 0.92),
    /** 商铺地面被火光烤暖的一片 */
    shopPool: basicMaterial(0x4a3323, { fog: true }),
    /** 屋面积水 */
    roofPool: basicMaterial(0x101820, { opacity: 0.82, transparent: true, fog: true }),
    hole: basicMaterial(0x090c10, { opacity: 0.92, transparent: true }),
    pitch: basicMaterial(0x05070a, { opacity: 1 }),
    /** 雨水冲刷的竖向污渍（半透明叠在墙上，压低立面平均亮度） */
    streak: basicMaterial(0x11171d, { opacity: 0.44, transparent: true, fog: true }),
    /** 窗下的浓黑熏痕 */
    sootBand: basicMaterial(0x0b0f13, { opacity: 0.55, transparent: true, fog: true }),
  };
}

type Mats = ReturnType<typeof makeMats>;

interface Kit {
  mats: Mats;
  rng: Rng;
  bins: Map<THREE.Material, THREE.Mesh[]>;
  extras: THREE.Object3D[];
  /** 外露砖芯（instanced，全楼合并成一个 draw call） */
  brickInst: InstanceTransform[];
  /** 崩裂碎屑（instanced） */
  chipInst: InstanceTransform[];
  /** 收集一个静态网格（最终按材质合并） */
  put<T extends THREE.Mesh>(m: T): T;
  /** 收集一个需要独立存在的对象（instanced 等） */
  hold(o: THREE.Object3D): void;
}

/* ------------------------------------------------------------------ *
 * 通用几何工具
 * ------------------------------------------------------------------ */

function boxAt(
  k: Kit,
  mat: THREE.Material,
  cx: number,
  cy: number,
  cz: number,
  w: number,
  h: number,
  d: number,
  rotY = 0,
): THREE.Mesh {
  const m = box(w, h, d, mat);
  m.position.set(cx, cy, cz);
  m.rotation.y = rotY;
  k.put(m);
  return m;
}

/** 一块粗糙的碎石/破块（顶点扰动，平面着色） */
function chunk(k: Kit, mat: THREE.Material, size: number, seedShift = 0): THREE.Mesh {
  const rng = k.rng.fork(9001 + seedShift);
  const g = jitter(new THREE.BoxGeometry(size, size * 0.78, size * 1.15), size * 0.2, rng);
  const m = mesh(g, mat);
  m.rotation.set(rng.range(0, 3), rng.range(0, 6), rng.range(0, 3));
  return k.put(m);
}

interface Hole {
  u0: number;
  u1: number;
  y0: number;
  y1: number;
}

/** 生成一面墙的墙板（扣掉洞口），返回墙板网格 */
function wallPanels(
  w: Wall,
  u0: number,
  u1: number,
  yb: number,
  yt: number,
  holes: Hole[],
  depth: number,
  zc: number,
  mat: THREE.Material,
): THREE.Mesh[] {
  const cuts: number[] = [u0, u1];
  for (const h of holes) {
    if (h.u1 <= u0 + 1e-3 || h.u0 >= u1 - 1e-3) continue;
    cuts.push(Math.max(u0, h.u0), Math.min(u1, h.u1));
  }
  const xs = [...new Set(cuts.map((v) => Math.round(v * 1000) / 1000))].sort((a, b) => a - b);
  const out: THREE.Mesh[] = [];
  for (let i = 0; i < xs.length - 1; i += 1) {
    const a = xs[i] as number;
    const b = xs[i + 1] as number;
    if (b - a < 0.02) continue;
    const mid = (a + b) / 2;
    const spans: Array<[number, number]> = [];
    for (const h of holes) {
      if (h.u0 - 1e-3 <= mid && h.u1 + 1e-3 >= mid && h.y1 > yb + 1e-3 && h.y0 < yt - 1e-3) {
        spans.push([Math.max(yb, h.y0), Math.min(yt, h.y1)]);
      }
    }
    spans.sort((p, q) => p[0] - q[0]);
    let cur = yb;
    for (const [s0, s1] of spans) {
      if (s0 > cur + 0.02) {
        out.push(wallBox(w, mid, (cur + s0) / 2, zc, b - a, s0 - cur, depth, mat));
      }
      cur = Math.max(cur, s1);
    }
    if (yt > cur + 0.02) {
      out.push(wallBox(w, mid, (cur + yt) / 2, zc, b - a, yt - cur, depth, mat));
    }
  }
  return out;
}

/** 内隔墙（薄，直接从墙板里开洞） */
function innerWall(k: Kit, w: Wall, y0: number, y1: number, holes: Hole[], mat: THREE.Material): void {
  wallPanels(w, 0, w.len, y0, y1, holes, 0.16, -0.08, mat).forEach((p) => k.put(p));
}

/** 楼板（带洞，带断面边缘）；yTop 为楼板顶面 */
function plate(
  k: Kit,
  yTop: number,
  thick: number,
  holes: Array<Array<[number, number]>>,
  mat: THREE.Material,
  expand = 0,
): THREE.Mesh {
  const shape = new THREE.Shape();
  FOOTPRINT.forEach(([x, z], i) => {
    const px = x + (x < (X0 + X1) / 2 ? -expand : expand);
    const pz = z + (z < (Z0 + Z1) / 2 ? -expand : expand);
    if (i === 0) shape.moveTo(px, -pz);
    else shape.lineTo(px, -pz);
  });
  shape.closePath();
  for (const poly of holes) {
    const path = new THREE.Path();
    poly.forEach(([x, z], i) => {
      if (i === 0) path.moveTo(x, -z);
      else path.lineTo(x, -z);
    });
    path.closePath();
    shape.holes.push(path);
  }
  const geom = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false, curveSegments: 1 });
  geom.rotateX(-Math.PI / 2);
  const m = mesh(geom, mat);
  m.position.y = yTop - thick;
  k.put(m);
  return m;
}

/** 不规则崩塌洞口轮廓（屋顶/楼板） */
function jaggedRect(x0: number, x1: number, z0: number, z1: number, rng: Rng, bite = 0.4): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const edge = (ax: number, az: number, bx: number, bz: number, steps: number) => {
    for (let i = 0; i < steps; i += 1) {
      const t = (i + 0.5) / steps;
      const px = ax + (bx - ax) * t;
      const pz = az + (bz - az) * t;
      const d = rng.range(0, bite);
      const vx = cx - px;
      const vz = cz - pz;
      const len = Math.hypot(vx, vz) || 1;
      out.push([px + (vx / len) * d, pz + (vz / len) * d]);
    }
  };
  edge(x0, z0, x1, z0, 4);
  edge(x1, z0, x1, z1, 3);
  edge(x1, z1, x0, z1, 4);
  edge(x0, z1, x0, z0, 3);
  return out;
}

/** 贴在墙面上的室内面片（朝室内） */
function innerPanel(
  k: Kit,
  w: Wall,
  u0: number,
  u1: number,
  y0: number,
  y1: number,
  mat: THREE.Material,
  zl = -WALL - 0.015,
): THREE.Mesh {
  const p = mesh(new THREE.PlaneGeometry(u1 - u0, y1 - y0), mat);
  p.position.copy(wallPoint(w, (u0 + u1) / 2, (y0 + y1) / 2, zl));
  p.rotation.y = w.theta + Math.PI;
  p.castShadow = false;
  k.put(p);
  return p;
}

/* ------------------------------------------------------------------ *
 * 洞口描述（外墙全部门窗 / 破洞）
 * ------------------------------------------------------------------ */

type Fill = 'glass' | 'broken' | 'shattered' | 'board' | 'open' | 'sandbag' | 'shutter';
type FrameKind = 'window' | 'door' | 'blast' | 'none';

interface HoleSpec extends Hole {
  wall: Wall;
  frame: FrameKind;
  fill: Fill;
  mullion?: boolean;
}

const HOLES: HoleSpec[] = [
  // ——— 西立面（正对纵街人行道）———————————————————————
  { wall: WEST, u0: 3.0, u1: 4.4, y0: 1.2, y1: 2.5, frame: 'window', fill: 'board' },
  { wall: WEST, u0: 6.2, u1: 7.4, y0: GF, y1: 2.3, frame: 'door', fill: 'board' },
  { wall: WEST, u0: 9.4, u1: 11.4, y0: 0.55, y1: 3.05, frame: 'window', fill: 'sandbag', mullion: true },
  { wall: WEST, u0: 13.2, u1: 16.2, y0: 0.75, y1: 3.05, frame: 'window', fill: 'broken', mullion: true },
  { wall: WEST, u0: 3.4, u1: 5.6, y0: W1A, y1: W1B, frame: 'window', fill: 'glass' },
  { wall: WEST, u0: 8.4, u1: 10.6, y0: W1A, y1: W1B, frame: 'window', fill: 'broken' },
  { wall: WEST, u0: 13.1, u1: 16.4, y0: F1 + 0.15, y1: F2 - 0.5, frame: 'blast', fill: 'open' },
  { wall: WEST, u0: 4.2, u1: 6.4, y0: W2A, y1: W2B, frame: 'window', fill: 'board' },
  { wall: WEST, u0: 9.0, u1: 11.2, y0: W2A, y1: W2B, frame: 'window', fill: 'broken' },
  { wall: WEST, u0: 13.0, u1: 15.2, y0: W2A, y1: W2B, frame: 'window', fill: 'glass' },

  // ——— 切角商铺立面 ———————————————————————————————
  { wall: CHAMFER, u0: 0.75, u1: 3.05, y0: GF, y1: 2.75, frame: 'door', fill: 'shutter' },
  { wall: CHAMFER, u0: 3.3, u1: 4.75, y0: 0.5, y1: 2.9, frame: 'window', fill: 'shattered' },
  { wall: CHAMFER, u0: 1.5, u1: 3.5, y0: W1A, y1: W1B, frame: 'window', fill: 'broken' },
  { wall: CHAMFER, u0: 1.5, u1: 3.5, y0: W2A, y1: W2B, frame: 'window', fill: 'glass' },

  // ——— 南立面（正对东西向大道）—————————————————————
  { wall: SOUTH, u0: 1.6, u1: 3.0, y0: 1.3, y1: 2.7, frame: 'window', fill: 'board' },
  { wall: SOUTH, u0: 4.6, u1: 8.4, y0: 0.55, y1: 3.05, frame: 'window', fill: 'shattered', mullion: true },
  { wall: SOUTH, u0: 11.0, u1: 13.6, y0: GF, y1: 3.55, frame: 'blast', fill: 'open' },
  { wall: SOUTH, u0: 15.4, u1: 16.6, y0: GF, y1: 2.3, frame: 'door', fill: 'open' },
  { wall: SOUTH, u0: 1.7, u1: 3.9, y0: W1A, y1: W1B, frame: 'window', fill: 'broken' },
  { wall: SOUTH, u0: 5.2, u1: 7.4, y0: W1A, y1: W1B, frame: 'window', fill: 'broken' },
  { wall: SOUTH, u0: 9.0, u1: 12.6, y0: F1 + 0.15, y1: F2 - 0.15, frame: 'blast', fill: 'open' },
  { wall: SOUTH, u0: 14.6, u1: 16.8, y0: W1A, y1: W1B, frame: 'window', fill: 'glass' },
  { wall: SOUTH, u0: 2.0, u1: 4.2, y0: W2A, y1: W2B, frame: 'window', fill: 'glass' },
  { wall: SOUTH, u0: 6.2, u1: 8.4, y0: W2A, y1: W2B, frame: 'window', fill: 'broken' },
  { wall: SOUTH, u0: 10.8, u1: 13.4, y0: F2 + 0.15, y1: EAVE - 0.3, frame: 'blast', fill: 'open' },
  { wall: SOUTH, u0: 15.4, u1: 17.4, y0: W2A, y1: W2B, frame: 'window', fill: 'board' },

  // ——— 东立面（临小巷）———————————————————————————
  { wall: EAST, u0: 4.2, u1: 5.8, y0: 1.1, y1: 2.8, frame: 'window', fill: 'board' },
  { wall: EAST, u0: 13.4, u1: 14.6, y0: GF, y1: 2.3, frame: 'door', fill: 'open' },
  { wall: EAST, u0: 3.0, u1: 5.0, y0: W1A, y1: W1B, frame: 'window', fill: 'glass' },
  { wall: EAST, u0: 9.0, u1: 11.0, y0: W1A, y1: W1B, frame: 'window', fill: 'broken' },
  { wall: EAST, u0: 15.0, u1: 17.0, y0: W1A, y1: W1B, frame: 'window', fill: 'board' },
  { wall: EAST, u0: 2.4, u1: 4.4, y0: W2A, y1: W2B, frame: 'window', fill: 'glass' },
  { wall: EAST, u0: 8.4, u1: 10.4, y0: W2A, y1: W2B, frame: 'window', fill: 'broken' },
  { wall: EAST, u0: 14.4, u1: 16.4, y0: W2A, y1: W2B, frame: 'window', fill: 'open' },

  // ——— 北立面（背街，破坏最重）———————————————————
  { wall: NORTH, u0: 6.0, u1: 7.4, y0: 1.0, y1: 2.8, frame: 'window', fill: 'board' },
  { wall: NORTH, u0: 14.0, u1: 15.4, y0: GF, y1: 2.3, frame: 'door', fill: 'board' },
  { wall: NORTH, u0: 4.4, u1: 6.4, y0: W1A, y1: W1B, frame: 'window', fill: 'glass' },
  { wall: NORTH, u0: 10.0, u1: 12.0, y0: W1A, y1: W1B, frame: 'window', fill: 'broken' },
  { wall: NORTH, u0: 5.0, u1: 10.0, y0: F1 + 0.45, y1: EAVE - 0.15, frame: 'blast', fill: 'open' },
  { wall: NORTH, u0: 15.4, u1: 17.0, y0: W2A, y1: W2B, frame: 'window', fill: 'broken' },
];

/* ------------------------------------------------------------------ *
 * 外墙（含开洞、窗框、填充、熏黑）
 * ------------------------------------------------------------------ */

function buildShell(k: Kit): void {
  const bands: Array<[number, number, THREE.Material]> = [
    [0, F1, k.mats.plasterWarm],
    [F1, F2, k.mats.plaster],
    [F2, EAVE, k.mats.plaster],
  ];

  for (const w of WALLS) {
    const holes = HOLES.filter((h) => h.wall === w);
    for (const [yb, yt, mat] of bands) {
      for (const p of wallPanels(w, 0, w.len, yb, yt, holes, WALL, -WALL / 2, mat)) k.put(p);
    }
  }

  // 勒脚 / 腰线 / 檐口（独立高模线脚：带斜面、滴水凹槽，不是贴在墙上的薄板）
  for (const w of WALLS) {
    // 勒脚线脚（底部外撇）
    wallGeom(k, w, w.len / 2, 0.3, 0, profileBand(plinthProfile, w.len), k.mats.concreteDark);
    // 楼层腰线（两道，带下缘滴水）
    for (const fy of [F1, F2]) {
      wallGeom(k, w, w.len / 2, fy - 0.08, 0, profileBand(bandProfile, w.len), k.mats.coping);
    }
    // 檐口：外挑的挑檐板 + 上面的压顶线脚
    wallGeom(
      k,
      w,
      w.len / 2,
      EAVE - 0.15,
      0,
      profileBand((s) => {
        s.moveTo(0, 0.13);
        s.lineTo(0.22, 0.1);
        s.lineTo(0.22, -0.13);
        s.lineTo(0.16, -0.19);
        s.lineTo(0, -0.19);
        s.closePath();
      }, w.len),
      k.mats.coping,
    );
    // 腰线下方的一道阴影，让楼层之间有层次
    k.put(wallBox(w, w.len / 2, F1 - 0.28, 0.02, w.len, 0.22, 0.01, k.mats.streak));
    k.put(wallBox(w, w.len / 2, F2 - 0.28, 0.02, w.len, 0.22, 0.01, k.mats.streak));
    k.put(wallBox(w, w.len / 2, EAVE - 0.4, 0.02, w.len, 0.26, 0.01, k.mats.streak));
  }

  // —— 檐沟（gutterGeometry：带托架的真实构件），贴在挑檐板外沿 ——
  for (const [w, u, len] of [
    [WEST, 8.5, 16.0],
    [SOUTH, 8.6, 16.4],
  ] as Array<[Wall, number, number]>) {
    const g = gutterGeometry(len);
    // gutterGeometry 的长度轴是 x；墙的 u 轴也是 x（经 wall.theta 旋转后）
    const m = wallGeom(k, w, u, EAVE - 0.02, 0.2, g, k.mats.steel);
    m.rotation.z = 0;
  }
  // 檐沟落水口（铸铁水斗）
  for (const [w, u] of [
    [SOUTH, 2.2],
    [SOUTH, 9.4],
  ] as Array<[Wall, number]>) {
    k.put(wallBox(w, u, EAVE - 0.22, 0.14, 0.26, 0.34, 0.26, k.mats.rustDark));
    k.put(wallBox(w, u, EAVE - 0.4, 0.2, 0.34, 0.06, 0.34, k.mats.rustDark));
  }

  // —— 落水管（downpipeGeometry：带接口环与弯头）——
  // 西立面：一根通高，一根断了半截
  {
    const dp = downpipeGeometry(8.4, true);
    const m = mesh(dp, k.mats.steel);
    m.position.copy(wallPoint(WEST, 17.0, 0.15, 0.14));
    m.rotation.y = WEST.theta;
    k.put(m);
  }
  {
    const dp = downpipeGeometry(5.0, false);
    const m = mesh(dp, k.mats.rust);
    m.position.copy(wallPoint(SOUTH, 18.1, 0.15, 0.14));
    m.rotation.y = SOUTH.theta;
    k.put(m);
  }
  // 落水管卡箍
  for (let i = 0; i < 5; i += 1) {
    k.put(wallBox(WEST, 17.0, 1.2 + i * 1.9, 0.06, 0.26, 0.1, 0.2, k.mats.steel));
  }
  for (let i = 0; i < 3; i += 1) {
    k.put(wallBox(SOUTH, 18.1, 1.1 + i * 1.7, 0.06, 0.24, 0.1, 0.18, k.mats.rustDark));
  }

  // 商铺立柱（切角两侧的浅壁柱，读起来像底商门面）
  for (const u of [0.36, 2.55]) {
    k.put(wallBox(CHAMFER, u, 2.1, 0.1, 0.42, 3.9, 0.3, k.mats.plasterWarm));
  }
  for (const u of [4.9]) {
    k.put(wallBox(CHAMFER, u, 2.1, 0.1, 0.36, 3.9, 0.24, k.mats.plasterWarm));
  }

  // 洞口：窗框 / 窗台 / 填充物
  for (const h of HOLES) buildHole(k, h);
}

function buildHole(k: Kit, h: HoleSpec): void {
  const w = h.wall;
  const M = k.mats;
  const u = (h.u0 + h.u1) / 2;
  const width = h.u1 - h.u0;
  const height = h.y1 - h.y0;
  const zc = -WALL / 2;

  if (h.frame === 'window' || h.frame === 'door') {
    const fr = h.frame === 'door' ? 0.1 : 0.11;
    const fd = WALL * 0.72;

    /* ---- 1. 洞口侧壁（reveal）：真实进深 = 墙厚 0.55，四条衬板 ---- */
    // 侧壁比墙面暗一档，让窗口读出"洞有深度"而不是贴片
    const revealMat = M.coping;
    const rw = 0.045;
    // 左右侧壁
    for (const s of [-1, 1]) {
      k.put(wallBox(w, u + s * (width / 2 - rw / 2), (h.y0 + h.y1) / 2, -WALL / 2, rw, height, WALL * 0.99, revealMat));
    }
    // 窗顶侧壁 + 窗底侧壁
    k.put(wallBox(w, u, h.y1 - 0.035, -WALL / 2, width, 0.07, WALL * 0.99, revealMat));
    k.put(wallBox(w, u, h.y0 + 0.035, -WALL / 2, width, 0.07, WALL * 0.99, revealMat));

    /* ---- 2. 内退的窗框（独立几何体，框宽 0.07，藏在洞口里侧）---- */
    if (h.frame === 'window') {
      const fw = Math.max(0.3, width - 0.14);
      const fh = Math.max(0.3, height - 0.14);
      const frameGeom = windowFrameGeometry(fw, fh, 0.09, !!h.mullion);
      // 退进墙面 0.15 —— 侧壁在它前面，读出真实的进深
      wallGeom(k, w, u, (h.y0 + h.y1) / 2, -0.15, frameGeom, M.soot);
    } else {
      // 门：厚门套 + 内退门板
      k.put(wallBox(w, h.u0 - fr / 2, (h.y0 + h.y1) / 2, zc, fr, height, fd, M.soot));
      k.put(wallBox(w, h.u1 + fr / 2, (h.y0 + h.y1) / 2, zc, fr, height, fd, M.soot));
      k.put(wallBox(w, u, h.y1 + fr / 2, zc, width + fr * 2, fr, fd, M.soot));
      const leaf = wallBox(w, u, (h.y0 + h.y1) / 2, -WALL + 0.1, width - 0.08, height - 0.1, 0.07, M.board);
      leaf.rotation.y = w.theta + k.rng.range(-0.05, 0.05);
      k.put(leaf);
    }

    /* ---- 3. 过梁（洞口上方的承重梁，独立几何体）---- */
    k.put(wallBox(w, u, h.y1 + 0.13, -WALL * 0.42, width + 0.34, 0.16, WALL * 0.84, M.concreteDark));

    /* ---- 4. 外挑窗台（斜面滴水）+ 窗台下的墙裙起拱 ---- */
    const sillW = width + 0.26;
    wallGeom(k, w, u, h.y0 + 0.01, 0, profileBand(sillProfile, sillW), M.band);
    // 窗台下的起拱墙裙
    wallGeom(k, w, u, h.y0 - 0.115, 0, profileBand(apronProfile, sillW * 0.92), M.band);

    // 窗上方的烟熏痕
    const smudge = jitter(new THREE.BoxGeometry(width * 0.9, h.frame === 'door' ? 0.3 : 0.6, 0.04), 0.035, k.rng.fork(h.u0 * 31));
    const sm = mesh(smudge, k.rng.chance(0.55) ? M.burnt : M.soot);
    sm.position.copy(wallPoint(w, u, h.y1 + 0.42, 0.012));
    sm.rotation.y = w.theta;
    k.put(sm);
    // 窗下的浓黑熏痕（窗台往下淌的黑带，让窗洞周遭有"被烧过"的重量）
    const below = wallBox(w, u + k.rng.range(-0.1, 0.1), h.y0 - 0.42, 0.03, width * 0.86, 0.7, 0.012, M.sootBand);
    below.rotation.z = k.rng.range(-0.04, 0.04);
    k.put(below);
    // 窗台两侧的滴水痕
    for (const s of [-1, 1]) {
      k.put(wallBox(w, u + s * width * 0.46, h.y0 - 0.55, 0.026, 0.16, 1.0, 0.01, M.streak));
    }
  }

  if (h.frame === 'blast') {
    // 炸弹破洞：边缘挂上崩掉的砌块
    const edges: Array<[number, number]> = [
      [h.u0, (h.y0 + h.y1) / 2],
      [h.u1, (h.y0 + h.y1) / 2],
      [u, h.y0],
      [u, h.y1],
      [h.u0 + width * 0.2, h.y1],
      [h.u1 - width * 0.25, h.y0],
    ];
    edges.forEach(([eu, ey], i) => {
      if (k.rng.chance(0.7)) {
        const c = chunk(k, k.rng.chance(0.5) ? M.plaster : M.brick, k.rng.range(0.3, 0.52), i * 7 + Math.round(eu * 3));
        c.position.copy(wallPoint(w, eu + k.rng.range(-0.18, 0.18), ey + k.rng.range(-0.18, 0.18), k.rng.range(-0.34, -0.1)));
      }
    });

    /* ---- 破洞内部可见结构：砖石断面（instanced）+ 外露钢筋 ---- */
    // 断面砖：沿洞口左右两侧与上下边排布，形成"墙被炸开、露出砌体"的读感
    const rowH = 0.075;
    const rows = Math.max(2, Math.min(7, Math.round(height / rowH)));
    for (let r = 0; r < rows; r += 1) {
      const by = h.y0 + ((r + 0.5) * height) / rows;
      // 错缝：偶数行从洞口左缘开始，奇数行右移半块
      const off = r % 2 === 0 ? 0 : 0.125;
      for (const side of [-1, 1]) {
        const n = 2 + (r % 2);
        for (let i = 0; i < n; i += 1) {
          const bu = side < 0 ? h.u0 - off - 0.13 - i * 0.25 : h.u1 + off + 0.13 + i * 0.25;
          if (bu < -0.2 || bu > w.len + 0.2) continue;
          k.brickInst.push({
            position: wallPoint(w, bu, by, -WALL * 0.5),
            rotation: new THREE.Euler(0, w.theta + k.rng.range(-0.12, 0.12), k.rng.range(-0.06, 0.06)),
            scale: new THREE.Vector3(1, 1, 1),
          });
        }
      }
    }
    // 洞口上下缘的断面砖（被炸断的楼板层与墙顶接缝）
    for (let i = 0; i < 4; i += 1) {
      k.brickInst.push({
        position: wallPoint(w, h.u0 + 0.25 + i * 0.3, h.y1 - 0.06, -WALL * 0.5),
        rotation: new THREE.Euler(k.rng.range(-0.1, 0.1), w.theta + k.rng.range(-0.2, 0.2), k.rng.range(-0.08, 0.08)),
        scale: new THREE.Vector3(1, 1, 1),
      });
      k.brickInst.push({
        position: wallPoint(w, h.u0 + 0.25 + i * 0.3, h.y0 + 0.06, -WALL * 0.5),
        rotation: new THREE.Euler(k.rng.range(-0.1, 0.1), w.theta + k.rng.range(-0.2, 0.2), k.rng.range(-0.08, 0.08)),
        scale: new THREE.Vector3(1, 1, 1),
      });
    }

    // 外露钢筋（贴着破口边缘弯折，不伸到街面上）
    for (let i = 0; i < 5; i += 1) {
      const side = i % 2 === 0 ? h.u0 : h.u1;
      const y = h.y0 + 0.3 + k.rng.range(0, Math.max(0.4, height - 0.6));
      const rg = rebarGeometry(k.rng.range(0.3, 0.7), k.rng.range(0.1, 0.28));
      const m = mesh(rg, M.rust);
      m.position.copy(wallPoint(w, side + (i % 2 === 0 ? -0.12 : 0.12), y, -WALL * 0.42));
      m.rotation.set(k.rng.range(-0.5, 0.5), w.theta + (i % 2 === 0 ? -1.4 : 1.4), k.rng.range(-0.6, 0.6));
      k.put(m);
    }

    // 楼板断面（多层板结构可见）：只在洞口跨到楼板标高时才加
    for (const fy of [F1, F2]) {
      if (h.y0 > fy + 0.1 || h.y1 < fy - 0.1) continue;
      const sg = slabSectionGeometry(width * 0.72, WALL * 0.9, 0.3);
      const m = mesh(sg, M.concreteDark);
      m.position.copy(wallPoint(w, u, fy - 0.1, -WALL * 0.45));
      m.rotation.y = w.theta;
      k.put(m);
      // 断面里的外露钢筋头
      for (let i = 0; i < 3; i += 1) {
        k.put(cylinderBetween(
          wallPoint(w, u - width * 0.28 + i * width * 0.28, fy - 0.16, -WALL * 0.4),
          wallPoint(w, u - width * 0.28 + i * width * 0.28, fy - 0.02, -WALL * 0.05),
          0.016,
          M.rust,
          4,
        ));
      }
    }
  }

  // 亮着的窗里不需要玻璃/碎片挡在发光面之前（否则暖光被冲淡成灰）
  const bay = bayFor(w, h.u0, h.u1);
  const litBay = !!bay && bay.mood !== 'dark';

  switch (h.fill) {
    case 'glass': {
      if (!litBay) {
        // 残存玻璃：参差不齐的锯齿状多边形（带厚度），不是完整矩形面片
        const pane = jaggedPaneGeometry(width * 0.72, height * 0.66, k.rng.fork(Math.round(h.u0 * 17)));
        const g = mesh(pane, M.glass);
        g.position.copy(wallPoint(w, u + k.rng.range(-0.1, 0.1), (h.y0 + h.y1) / 2 + k.rng.range(-0.1, 0.1), -WALL * 0.32));
        g.rotation.y = w.theta;
        g.castShadow = false;
        k.put(g);
        // 玻璃上的裂纹
        for (let i = 0; i < 2; i += 1) {
          const c = wallBox(w, u + k.rng.range(-width * 0.3, width * 0.3), (h.y0 + h.y1) / 2 + k.rng.range(-0.4, 0.4), -WALL * 0.3 - 0.01, k.rng.range(0.3, 0.7), 0.02, 0.01, M.soot);
          c.rotation.z = k.rng.range(-0.9, 0.9);
          k.put(c);
        }
      }
      break;
    }
    case 'broken': {
      // 残留玻璃 + 参差碎片
      if (!litBay) {
        const pane = jaggedPaneGeometry(width * 0.38, height * 0.46, k.rng.fork(Math.round(h.u1 * 23)));
        const gp = mesh(pane, M.glass);
        gp.position.copy(wallPoint(w, u - width * 0.22, h.y0 + height * 0.3, -WALL * 0.32));
        gp.rotation.y = w.theta;
        gp.castShadow = false;
        k.put(gp);
        shards(k, h, 5);
      }
      break;
    }
    case 'shattered': {
      if (!litBay) shards(k, h, 7);
      break;
    }
    case 'board': {
      // 风化木板封窗：位置/宽度/歪斜都随机，留缝，钉子露头
      const planks = 3 + (k.rng.chance(0.5) ? 1 : 0);
      for (let i = 0; i < planks; i += 1) {
        const y = h.y0 + 0.28 + ((i + k.rng.range(-0.12, 0.12)) * (height - 0.5)) / planks;
        const pw = width * k.rng.range(0.9, 1.12) + 0.16;
        const p = wallBox(w, u + k.rng.range(-0.12, 0.12), y, 0.02 + WALL * 0.1, pw, 0.19, 0.05, i % 2 === 0 ? M.board : M.boardAlt);
        p.rotation.z = k.rng.range(-0.13, 0.13);
        k.put(p);
        // 钉子
        for (const s of [-1, 1]) {
          k.put(wallBox(w, u + s * pw * 0.34, y + k.rng.range(-0.03, 0.03), 0.075, 0.03, 0.03, 0.02, M.steel));
        }
      }
      // 从洞口缝里看进去的暗面
      const d = mesh(new THREE.PlaneGeometry(width - 0.1, height - 0.1), k.mats.pitch);
      d.position.copy(wallPoint(w, u, (h.y0 + h.y1) / 2, -WALL * 0.62));
      d.rotation.y = w.theta;
      d.castShadow = false;
      k.put(d);
      break;
    }
    case 'sandbag': {
      sandbagStack(k, w, u, h.y0, width, 2);
      break;
    }
    case 'shutter': {
      // 半损卷帘：上段留着，下段被炸开、翘起
      for (let i = 0; i < 6; i += 1) {
        const y = h.y1 - 0.1 - i * 0.19;
        if (y < h.y0 + 1.15) break;
        const s = wallBox(w, u, y, 0.07, width * 0.97, 0.14, 0.05, i % 3 === 0 ? M.rust : M.metal);
        if (i === 0) s.rotation.x = -0.32;
        if (i === 1) s.rotation.x = -0.12;
        k.put(s);
      }
      // 卷帘盒
      const roller = cyl(0.13, 0.13, width * 1.02, 8, M.metal);
      roller.rotation.z = Math.PI / 2;
      roller.rotation.y = w.theta;
      roller.rotation.x = 0;
      roller.position.copy(wallPoint(w, u, h.y1 - 0.02, 0.1));
      k.put(roller);
      // 门洞内的暗部（室内）
      const d = mesh(new THREE.PlaneGeometry(width - 0.1, 0.9), k.mats.pitch);
      d.position.copy(wallPoint(w, u, h.y0 + 0.45, -WALL * 0.95));
      d.rotation.y = w.theta + Math.PI;
      d.castShadow = false;
      k.put(d);
      break;
    }
    case 'open':
    default:
      break;
  }
}

/** 窗口残存玻璃碎片（三角形片）+ 垂挂的玻璃碴 */
function shards(k: Kit, h: HoleSpec, count: number): void {
  for (let i = 0; i < count; i += 1) {
    const r = k.rng.range(0.09, 0.22);
    const g = new THREE.CircleGeometry(r, 3);
    const sh = mesh(g, k.mats.glass);
    const edge = i % 4;
    const uu = edge === 0 ? h.u0 + r : edge === 1 ? h.u1 - r : k.rng.range(h.u0 + 0.1, h.u1 - 0.1);
    const yy = edge === 2 ? h.y0 + r : edge === 3 ? h.y1 - r : k.rng.range(h.y0 + 0.1, h.y1 - 0.1);
    sh.position.copy(wallPoint(h.wall, uu, yy, -WALL * (0.34 + k.rng.range(0, 0.1))));
    sh.rotation.set(k.rng.range(-0.2, 0.2), h.wall.theta, k.rng.range(0, Math.PI * 2));
    sh.castShadow = false;
    k.put(sh);
  }
  // 垂挂的玻璃碴：从窗框上沿垂下来的三角形，带一点厚度
  const hang = 1 + (k.rng.chance(0.5) ? 1 : 0);
  for (let i = 0; i < hang; i += 1) {
    const hw = k.rng.range(0.14, 0.3);
    const hh2 = k.rng.range(0.16, 0.42);
    const s = new THREE.Shape();
    s.moveTo(-hw / 2, 0);
    s.lineTo(hw / 2, 0);
    s.lineTo(k.rng.range(-hw * 0.2, hw * 0.2), -hh2);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.012, bevelEnabled: false, curveSegments: 1 });
    const m = mesh(g, k.mats.glass);
    const hu = k.rng.range(h.u0 + 0.12, h.u1 - 0.12);
    m.position.copy(wallPoint(h.wall, hu, h.y1 - 0.03, -WALL * 0.36));
    m.rotation.y = h.wall.theta;
    m.castShadow = false;
    k.put(m);
  }
}

/** 沙袋：在洞口前堆两三层 */
function sandbagStack(k: Kit, w: Wall, u: number, y0: number, width: number, courses: number): void {
  const bagW = 0.52;
  const cols = Math.max(2, Math.round(width / bagW));
  for (let c = 0; c < courses; c += 1) {
    for (let i = 0; i < cols; i += 1) {
      const bx = u - width / 2 + (width / cols) * (i + 0.5) + (c % 2 === 0 ? 0 : width / cols * 0.35);
      if ((c + i) % 5 === 4 && k.rng.chance(0.5)) continue; // 缺口
      const bag = softBox(bagW, 0.22, 0.34, 0.07, (c + i) % 2 === 0 ? k.mats.sandbag : k.mats.sandbagDark);
      bag.position.copy(wallPoint(w, bx, y0 + 0.12 + c * 0.2, -WALL * 0.4 + k.rng.range(-0.05, 0.05)));
      bag.rotation.y = w.theta + k.rng.range(-0.12, 0.12);
      k.put(bag);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 外立面装饰：剥落墙皮、裂缝、弹孔、外挑构件、招牌
 * ------------------------------------------------------------------ */

function buildFacadeDressing(k: Kit): void {
  const M = k.mats;
  const rng = k.rng.fork(77);

  // —— 雨水冲刷的竖向污渍（窗台下、墙角、女儿墙下方）——
  const streak = M.streak;
  for (const h of HOLES) {
    if (h.frame === 'blast') continue;
    const len = rng.range(0.9, 2.8);
    const yb = Math.max(0.3, h.y0 - 0.12 - len);
    k.put(wallBox(h.wall, (h.u0 + h.u1) / 2 + rng.range(-0.2, 0.2), yb + len / 2, 0.02, rng.range(0.22, h.u1 - h.u0 + 0.2), len, 0.01, streak));
  }
  for (const w of WALLS) {
    for (let i = 0; i < 18; i += 1) {
      const sw = rng.range(0.1, 0.34);
      const sh = rng.range(1.0, 4.2);
      const yTop = rng.range(1.8, EAVE - 0.2);
      k.put(wallBox(w, rng.range(0.2, w.len - 0.2), yTop - sh / 2, 0.016, sw, sh, 0.01, streak));
    }
    // 勒脚处的溅泥（两层叠出深浅）
    k.put(wallBox(w, w.len / 2, 0.66, 0.02, w.len, 0.62, 0.01, streak));
    k.put(wallBox(w, w.len / 2, 0.42, 0.022, w.len, 0.3, 0.01, M.sootBand));
  }

  // —— 剥落墙皮：**立体破坏**（有厚度的参差破片，嵌进墙面，边缘露出砖芯）——
  // 成组分布：墙角、窗角、弹着点附近，不是均匀撒。
  for (const w of WALLS) {
    const anchors: Array<[number, number]> = [];
    for (const h of HOLES) {
      if (h.wall !== w || h.frame === 'blast') continue;
      if (rng.chance(0.55)) anchors.push([h.u0 - 0.26, h.y0 - 0.32]);
      if (rng.chance(0.55)) anchors.push([h.u1 + 0.26, h.y1 + 0.3]);
    }
    // 墙根与女儿墙下也容易整片剥落
    anchors.push([rng.range(1.2, w.len - 1.2), rng.range(0.5, 1.1)]);
    anchors.push([rng.range(1.2, w.len - 1.2), rng.range(EAVE - 1.5, EAVE - 0.7)]);
    // 墙角（起拱的棱线最容易崩）
    anchors.push([0.5, rng.range(1.2, EAVE - 1.5)]);
    anchors.push([w.len - 0.5, rng.range(1.2, EAVE - 1.5)]);

    for (const [au, ay] of anchors) {
      const cluster = 2 + (rng.chance(0.55) ? 1 : 0);
      // 取代表破片的位置，用来在下方生成"露砖"
      let repCu = au;
      let repCy = ay;
      let repPw = 0.5;
      let repPh = 0.4;
      for (let i = 0; i < cluster; i += 1) {
        const pw = rng.range(0.26, 0.68);
        const ph = rng.range(0.2, 0.52);
        const cu = Math.min(Math.max(au + rng.range(-0.4, 0.4), pw / 2 + 0.15), w.len - pw / 2 - 0.15);
        const cy = Math.min(Math.max(ay + rng.range(-0.4, 0.4), 0.3), EAVE - 0.4);
        if (i === 0) {
          repCu = cu;
          repCy = cy;
          repPw = pw;
          repPh = ph;
        }
        // 破片有真实厚度（0.05~0.09），边缘参差
        const slab = fixSlabNormals(chippedSlab(pw, ph, rng.range(0.05, 0.09), rng, 0.26));
        const pick = rng.next();
        const p = mesh(slab, pick < 0.55 ? M.peel : pick < 0.85 ? M.peelDeep : M.brickDark);
        // **内凹嵌进墙面**：破片中心在墙皮面之后，只让翘起的边缘露出来
        p.position.copy(wallPoint(w, cu, cy, -0.042));
        p.rotation.y = w.theta;
        p.rotation.z = rng.range(-0.2, 0.2);
        // 上缘翘离墙面：绕墙切向轴微微掀起
        p.rotation.x = rng.range(0.08, 0.24);
        k.put(p);
      }

      /* ---- 剥落区下方：露砖（instanced 的错缝砖，3~5 行）---- */
      const rows = 3 + rng.int(0, 2);
      const bw = 0.25;
      const rowH = 0.075;
      for (let r = 0; r < rows; r += 1) {
        const by = repCy - repPh / 2 - 0.05 - r * rowH;
        if (by < 0.25) break;
        const off = r % 2 === 0 ? 0 : bw / 2;
        const cols = Math.max(2, Math.round(repPw / bw));
        for (let c = 0; c < cols; c += 1) {
          const bu = repCu - (cols * bw) / 2 + off + c * bw + bw / 2;
          if (bu < 0.05 || bu > w.len - 0.05) continue;
          // 砖芯稍微内凹在墙里（比墙皮面深），带错缝
          k.brickInst.push({
            position: wallPoint(w, bu, by, -0.03 + rng.range(-0.005, 0.005)),
            rotation: new THREE.Euler(rng.range(-0.03, 0.03), w.theta + rng.range(-0.04, 0.04), rng.range(-0.02, 0.02)),
            scale: new THREE.Vector3(1, 1, 1),
          });
        }
      }
    }
  }

  // —— 裂纹：少而长，带分叉 ——
  for (const w of WALLS) {
    for (let i = 0; i < 5; i += 1) {
      const len = rng.range(1.4, 3.4);
      const u0 = rng.range(1.6, w.len - 1.6);
      const y0 = rng.range(1.0, EAVE - 1.2);
      const a = rng.range(-0.7, 0.7);
      const c = wallBox(w, u0, y0, 0.012, len, 0.07, 0.02, M.burnt);
      c.rotation.z = a;
      k.put(c);
      if (i % 2 === 0) {
        const b = wallBox(w, u0 + Math.cos(a) * len * 0.32, y0 + Math.sin(a) * len * 0.32, 0.012, len * 0.45, 0.05, 0.02, M.burnt);
        b.rotation.z = a + rng.range(0.5, 1.2) * rng.sign();
        k.put(b);
      }
    }
  }

  // —— 弹孔：成组（每个"弹着点"3~5 发），每个弹孔 = 内凹暗面 + 崩裂碎屑环 + 局部剥落 ——
  const hits: Array<{ position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }> = [];
  const rings: Array<{ position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }> = [];
  for (const w of WALLS) {
    const groups = w === CHAMFER ? 2 : 3;
    for (let g = 0; g < groups; g += 1) {
      const cu = rng.range(0.9, w.len - 0.9);
      const cy = rng.range(1.3, EAVE - 0.9);
      const n = 3 + rng.int(0, 2);
      for (let i = 0; i < n; i += 1) {
        const du = rng.gauss(0, 0.34);
        const dy = rng.gauss(0, 0.3);
        const hu = Math.min(Math.max(cu + du, 0.3), w.len - 0.3);
        const hy = Math.min(Math.max(cy + dy, 0.5), EAVE - 0.3);
        const sc = rng.range(0.65, 1.45);
        hits.push({
          position: wallPoint(w, hu, hy, 0.006),
          rotation: new THREE.Euler(0, w.theta, rng.range(0, Math.PI)),
          scale: new THREE.Vector3(1, 1, 1).multiplyScalar(sc),
        });
        // 崩裂碎屑环（instanced）：围着弹孔的一圈碎渣
        const ringT = debrisRing(5, 0.09 * sc, rng, 0.85);
        ringT.forEach((t) => {
          const p = wallPoint(w, hu + t.position.x, hy + t.position.y, 0.012 + t.position.z);
          rings.push({
            position: p,
            rotation: new THREE.Euler(t.rotation?.x ?? 0, w.theta + (t.rotation?.y ?? 0), t.rotation?.z ?? 0),
            scale: t.scale ?? new THREE.Vector3(1, 1, 1),
          });
        });
        // 弹孔周围的崩裂浅环（明度分层）
        rings.push({
          position: wallPoint(w, hu, hy, 0.004),
          rotation: new THREE.Euler(0, w.theta, rng.range(0, Math.PI)),
          scale: new THREE.Vector3(1, 1, 1).multiplyScalar(sc),
        });
        // 局部剥落：弹着点附近的小破片
        if (rng.chance(0.7)) {
          const slab = fixSlabNormals(chippedSlab(rng.range(0.16, 0.34), rng.range(0.14, 0.3), rng.range(0.04, 0.07), rng, 0.3));
          const sp = mesh(slab, rng.chance(0.5) ? M.peelDeep : M.brickDark);
          sp.position.copy(wallPoint(w, hu + rng.range(-0.3, 0.3), hy + rng.range(-0.3, 0.3), -0.008));
          sp.rotation.y = w.theta;
          sp.rotation.z = rng.range(-0.5, 0.5);
          k.put(sp);
        }
      }
      // 弹着点：从中心放射出几道细裂缝（比散落的"铅笔道"更像真实弹着）
      for (let i = 0; i < 3; i += 1) {
        const ang = rng.range(0, Math.PI * 2);
        const len = rng.range(0.35, 0.9);
        const crack = wallBox(
          w,
          cu + Math.cos(ang) * len * 0.5,
          cy + Math.sin(ang) * len * 0.5,
          0.011,
          len,
          0.035,
          0.016,
          M.burnt,
        );
        crack.rotation.z = ang;
        k.put(crack);
      }
    }
  }
  k.hold(instanced(new THREE.CircleGeometry(0.032, 6), M.hole, hits));
  // 崩裂环用带参差的环面几何（不描边，靠明度分层表达）
  k.hold(instanced(craterRingGeometry(), M.peelDeep, rings));

  // —— 落水管已移入 buildShell（带接口环与弯头的独立高模）——

  // —— 切角商铺招牌（歪斜）——
  const sign = wallBox(CHAMFER, 1.9, 3.5, 0.16, 2.6, 0.68, 0.1, M.sign);
  sign.rotation.z = -0.055;
  sign.rotation.x = 0.03;
  k.put(sign);
  // 招牌掉了一角，挂在一边
  const signBroken = wallBox(CHAMFER, 3.55, 3.2, 0.2, 0.9, 0.5, 0.06, M.sign);
  signBroken.rotation.z = 0.5;
  k.put(signBroken);
  // 招牌支架
  for (const su of [0.8, 3.0]) {
    k.put(wallBox(CHAMFER, su, 3.85, 0.1, 0.07, 0.5, 0.5, M.rust));
  }
  // 门口雨棚（扭曲、局部塌陷）
  for (let i = 0; i < 4; i += 1) {
    const a = wallBox(CHAMFER, 1.0 + i * 0.62, 3.02, 0.42, 0.66, 0.07, 0.76, M.metal);
    a.rotation.x = -0.16 - i * 0.05;
    a.rotation.z = k.rng.range(-0.05, 0.05);
    k.put(a);
  }
  // 雨棚斜撑
  k.put(cylinderBetween(wallPoint(CHAMFER, 0.95, 2.6, 0.02), wallPoint(CHAMFER, 0.95, 3.0, 0.8), 0.035, M.rust, 5));

  // —— 南立面二楼半塌的阳台（出挑克制，不越过建筑红线）——
  const balconyA = boxAt(k, M.concrete, 19.0, F1 + 0.03, Z1 + 0.05, 3.0, 0.16, 0.48);
  balconyA.rotation.z = 0.06;
  boxAt(k, M.concreteDark, 18.4, F1 + 0.08, Z1 + 0.22, 1.1, 0.14, 0.3).rotation.x = 0.5;
  // 栏杆（断掉一半）
  for (let i = 0; i < 7; i += 1) {
    const u = 0.9 + i * 0.42;
    if (i === 4 || i === 5) continue;
    k.put(wallBox(SOUTH, u + 1.6, F1 + 0.55, 0.28, 0.05, 1.0, 0.05, M.rust));
  }
  k.put(wallBox(SOUTH, 2.6, F1 + 1.05, 0.28, 2.0, 0.06, 0.06, M.rust));

  // —— 西立面三层的阳台残骸 ——
  boxAt(k, M.concreteDark, X0 + 0.18, F2 + 0.02, -19.6, 0.5, 0.16, 2.4).rotation.z = -0.04;

  // —— 空调外机 / 电表箱 / 墙上杂件 ——
  // 空调外机用 acUnitGeometry（面板 + 栅格 + 风扇圈 + 支架，独立高模）
  {
    const ac = acUnitGeometry();
    const m = mesh(ac, M.metal);
    m.position.copy(wallPoint(WEST, 5.0, W1A - 0.62, 0.2));
    m.rotation.y = WEST.theta;
    k.put(m);
    const ac2 = acUnitGeometry();
    const m2 = mesh(ac2, M.rust);
    m2.position.copy(wallPoint(EAST, 12.4, W2A - 0.55, 0.2));
    m2.rotation.y = EAST.theta;
    k.put(m2);
  }
  boxAt(k, M.steel, X0 + 0.04, 2.6, -24.4, 0.2, 0.55, 0.42);
  boxAt(k, M.metal, X0 + CUT + 3.0, W1A - 0.5, Z1 + 0.1, 0.6, 0.45, 0.2);
  // 东侧小巷的电线
  k.put(
    cylinderBetween(
      new THREE.Vector3(X1 + 0.05, 6.4, -19.0),
      new THREE.Vector3(X1 + 0.05, 5.6, -26.0),
      0.025,
      M.steel,
      4,
    ),
  );

  // —— 南立面墙上的旧海报（褪色宣传画）——
  const poster = mesh(new THREE.PlaneGeometry(0.62, 0.86), M.poster);
  poster.position.copy(wallPoint(SOUTH, 12.9, 2.35, 0.045));
  poster.rotation.y = SOUTH.theta + 0.3;
  poster.rotation.z = -0.05;
  k.put(poster);
  const poster2 = mesh(new THREE.PlaneGeometry(0.5, 0.7), M.poster);
  poster2.position.copy(wallPoint(WEST, 6.9, 3.3, 0.045));
  poster2.rotation.y = WEST.theta - 0.2;
  k.put(poster2);
}

/* ------------------------------------------------------------------ *
 * 窗内"可见的室内"：亮着的房间给暖光背景 + 家具剪影，暗房间给一点点层次
 * ------------------------------------------------------------------ */

type BayMood = 'warm' | 'ember' | 'cold' | 'dark';
type BayForm = 'table' | 'chairs' | 'wardrobe' | 'bed' | 'shelf' | 'counter' | 'stove' | 'rubble' | 'none';

interface BaySpec {
  wall: Wall;
  u0: number;
  u1: number;
  y0: number;
  y1: number;
  floorY: number;
  mood: BayMood;
  form: BayForm;
  /** 背景面离开墙内表的距离（越大越深，越容易被真实家具挡住） */
  depth?: number;
}

/**
 * 在一个窗洞内侧做"能看进去的房间"：
 * 1) 一块背光面（暖光 / 冷光 / 幽暗）——透过窗洞看到的是一片被照亮的墙；
 * 2) 一片被照亮的地板；
 * 3) 1~3 件深色家具剪影，卡在窗洞下沿附近，形成进深与生活痕迹。
 */
function interiorBay(k: Kit, b: BaySpec): void {
  const M = k.mats;
  const w = b.wall;
  const uc = (b.u0 + b.u1) / 2;
  const W = b.u1 - b.u0;
  const H = b.y1 - b.y0;
  const midY = (b.y0 + b.y1) / 2;
  const lit = b.mood !== 'dark';
  // 靠在洞口内侧很近的位置：这个微缩景观多为斜视，进深太深的背景会被窗洞侧壁挡住
  const backZ = -WALL - (b.depth ?? (lit ? 0.42 : 0.5));

  // 洞口平面上的一层"窗光"：
  // 这个机位多以 20° 掠射看立面，洞里 0.4m 之后的背景会被窗洞侧壁吃掉，
  // 所以把光/暗落在洞口平面稍后一点的位置，任何角度都能读到"窗里有人/窗里是黑的"。
  // 退到 -0.2 是为了让内退的窗框（-0.10）挡在它前面，读得出真实进深。
  const surfaceMat = lit
    ? b.mood === 'warm'
      ? M.winWarm
      : b.mood === 'ember'
        ? M.winEmber
        : M.winCold
    : M.winDark;
  const spill = mesh(new THREE.PlaneGeometry(W * 0.99, H * 0.97), surfaceMat);
  spill.position.copy(wallPoint(w, uc, midY, -0.2));
  spill.rotation.y = w.theta;
  spill.castShadow = false;
  k.put(spill);

  // 窗棂：贴在窗光前面，让窗不是一个发光的纯色块（与内退窗框配合读出层次）
  k.put(wallBox(w, uc, b.y1 - H * 0.34, -0.185, W * 0.99, 0.055, 0.02, M.soot));
  k.put(wallBox(w, uc, midY, -0.185, 0.05, H * 0.9, 0.02, M.soot));

  const backMat =
    b.mood === 'warm' ? M.roomLit : b.mood === 'ember' ? M.roomLitDeep : b.mood === 'cold' ? M.roomCold : M.roomDark;
  const back = mesh(new THREE.PlaneGeometry(W * 1.6, H * 1.9 + 0.5), backMat);
  back.position.copy(wallPoint(w, uc, midY + 0.08, backZ));
  back.rotation.y = w.theta;
  back.castShadow = false;
  k.put(back);

  // 被照亮的地板（平躺：先转几何再转 Y，避免欧拉顺序问题）
  const fgeo = new THREE.PlaneGeometry(W * 1.5, 0.95);
  fgeo.rotateX(-Math.PI / 2);
  const fl = mesh(fgeo, lit ? M.roomFloor : M.roomDark);
  fl.position.copy(wallPoint(w, uc, b.floorY + 0.02, -WALL - 0.42));
  fl.rotation.y = w.theta;
  fl.castShadow = false;
  k.put(fl);

  // 家具剪影：亮房里用近黑的实色，暗房里用比背景略亮的灰，读得出体积
  const dark = lit ? M.burnt : M.roomForm;
  const dark2 = lit ? M.soot : M.roomForm;
  const zf = -WALL - 0.34;
  const put = (cu: number, cy: number, cz: number, bw: number, bh: number, bd: number, mat: THREE.Material): void => {
    k.put(wallBox(w, cu, cy, cz, bw, bh, bd, mat));
  };

  // —— 窗后的"生活剪影"层次：近景剪影 + 中景剪影 + 远景剪影 ——
  // 让窗口读得出"里面有人住"，而不是一块发光面片
  if (b.mood === 'warm' || b.mood === 'cold') {
    // 远景：一个人形轮廓（头 + 肩），站在房间深处
    const farZ = -WALL - 0.78;
    const farMat = lit ? M.soot : M.roomForm;
    put(uc + W * 0.22, b.floorY + 1.02, farZ, 0.2, 0.24, 0.18, farMat);
    put(uc + W * 0.22, b.floorY + 1.42, farZ, 0.36, 0.56, 0.22, farMat);
    // 中景：一把椅子的靠背剪影
    put(uc - W * 0.3, b.floorY + 0.72, farZ + 0.28, 0.4, 0.62, 0.06, farMat);
  }

  switch (b.form) {
    case 'counter': {
      put(uc, b.floorY + 0.6, zf, W * 0.92, 0.92, 0.5, dark);
      put(uc, b.floorY + 1.09, zf, W * 0.98, 0.08, 0.58, dark2);
      break;
    }
    case 'table': {
      put(uc, b.floorY + 0.74, zf, W * 0.85, 0.07, 0.62, dark2);
      put(uc - W * 0.32, b.floorY + 0.37, zf, 0.07, 0.72, 0.07, dark);
      put(uc + W * 0.32, b.floorY + 0.37, zf, 0.07, 0.72, 0.07, dark);
      put(uc + W * 0.18, b.floorY + 1.02, zf - 0.1, 0.4, 0.5, 0.06, dark);
      break;
    }
    case 'chairs': {
      put(uc - 0.42, b.floorY + 0.44, zf, 0.44, 0.07, 0.44, dark2);
      put(uc - 0.42, b.floorY + 0.72, zf - 0.16, 0.44, 0.5, 0.06, dark);
      put(uc + 0.46, b.floorY + 0.16, zf, 0.46, 0.1, 0.46, dark);
      put(uc + 0.46, b.floorY + 0.4, zf + 0.2, 0.44, 0.5, 0.06, dark2);
      break;
    }
    case 'wardrobe': {
      put(uc + W * 0.26, b.floorY + 1.0, zf - 0.1, 0.9, 2.0, 0.52, dark);
      put(uc - W * 0.2, b.floorY + 0.5, zf, 0.5, 0.9, 0.5, dark2);
      break;
    }
    case 'bed': {
      put(uc, b.floorY + 0.26, zf - 0.3, W * 0.95, 0.44, 1.0, dark);
      put(uc, b.floorY + 0.62, zf - 0.85, W * 0.95, 0.72, 0.1, dark2);
      break;
    }
    case 'shelf': {
      for (let i = 0; i < 3; i += 1) {
        put(uc + W * 0.2, b.floorY + 0.42 + i * 0.52, zf - 0.1, 0.72, 0.06, 0.4, dark2);
      }
      put(uc - W * 0.3, b.floorY + 0.5, zf, 0.5, 0.95, 0.45, dark);
      break;
    }
    case 'stove': {
      put(uc, b.floorY + 0.36, zf, 0.7, 0.66, 0.6, dark);
      k.put(
        cylinderBetween(
          wallPoint(w, uc, b.floorY + 0.6, zf),
          wallPoint(w, uc, b.floorY + 2.2, zf),
          0.06,
          M.steel,
          6,
        ),
      );
      break;
    }
    case 'rubble': {
      for (let i = 0; i < 3; i += 1) {
        const c = chunk(k, dark, 0.3 + i * 0.08, 200 + i + Math.round(uc * 10));
        c.position.copy(wallPoint(w, uc + (i - 1) * 0.35, b.floorY + 0.12, zf));
      }
      break;
    }
    default:
      break;
  }
}

/** 所有"窗内实景"：只让约三分之一的窗亮着 */
function buildWindowInteriors(k: Kit): void {
  const M = k.mats;
  for (const b of BAYS) interiorBay(k, b);

  // —— 底商：不放假背景（真家具要在窗里），改成"火光打在墙上 + 地面反光"——
  const glowSouth = mesh(new THREE.PlaneGeometry(3.2, 3.0), M.roomLitDeep);
  glowSouth.position.set(19.0, 2.0, -19.6);
  glowSouth.rotation.y = 0; // 面朝南（十字路口）
  glowSouth.castShadow = false;
  k.put(glowSouth);

  const glowWest = mesh(new THREE.PlaneGeometry(2.6, 2.6), M.roomLitDeep);
  glowWest.position.set(17.2, 1.9, -21.6);
  glowWest.rotation.y = Math.PI / 2;
  glowWest.castShadow = false;
  k.put(glowWest);

  // 商铺地面的暖光池（贴在破窗内侧，让窗洞下半截是暖的）
  const poolS = new THREE.PlaneGeometry(3.6, 1.8);
  poolS.rotateX(-Math.PI / 2);
  const ps = mesh(poolS, M.shopPool);
  ps.position.set(19.8, GF + 0.03, -14.9);
  k.put(ps);

  const poolW = new THREE.PlaneGeometry(1.8, 3.4);
  poolW.rotateX(-Math.PI / 2);
  const pw = mesh(poolW, M.shopPool);
  pw.position.set(13.7, GF + 0.03, -19.3);
  k.put(pw);

  // 柜台上方吊着的灯泡（真的发光体，比假背景更有说服力）
  k.put(
    cylinderBetween(
      new THREE.Vector3(20.9, GF + 3.0, -18.0),
      new THREE.Vector3(20.9, F1 - 0.08, -18.0),
      0.02,
      M.steel,
      4,
    ),
  );
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), M.glowWarm);
  bulb.position.set(20.9, GF + 2.9, -18.0);
  bulb.castShadow = false;
  k.put(bulb);

  // —— 三个大楼板的"内景底光"：透过塌口望进去的房间里有一点微光 ——
  const roomGlow: Array<[number, number, number, number, number, number]> = [
    // [x, y, z, w, h, rotY]
    [26.5, 6.2, -22.35, 3.6, 2.0, 0], // 二层后室（南立面塌口望进去）
    [27.6, 9.3, -23.05, 3.4, 2.0, 0], // 三层后室（南立面上部塌口）
    [22.35, 6.0, -19.2, 2.6, 2.0, -Math.PI / 2], // 二层前室（西立面破洞望进去）
  ];
  for (const [gx, gy, gz, gw, gh, gr] of roomGlow) {
    const panel = mesh(new THREE.PlaneGeometry(gw, gh), M.roomDim);
    panel.position.set(gx, gy, gz);
    panel.rotation.y = gr;
    panel.castShadow = false;
    k.put(panel);
  }
}

/* ------------------------------------------------------------------ *
 * 室内：底层（商铺 / 后厨 / 楼梯间 / 储藏）
 * ------------------------------------------------------------------ */

function buildGroundFloor(k: Kit): void {
  const M = k.mats;
  const rng = k.rng.fork(101);

  // 楼板
  plate(k, GF, 0.9, [], M.stain);
  // 商铺地砖的碎块感：几块深色补丁
  for (let i = 0; i < 10; i += 1) {
    boxAt(k, M.soot, rng.range(14, 22), GF + 0.012, rng.range(-22, -14.5), rng.range(0.6, 1.6), 0.02, rng.range(0.6, 1.6), rng.range(0, 3));
  }

  // —— 商铺内隔墙：x = 22.4（通往厨房/楼梯间）——
  const p1 = makeWall(1, 0, 22.4, Z1 - WALL - 0.05, 10.2);
  innerWall(k, p1, GF, F1 - 0.02, [
    { u0: 2.2, u1: 3.3, y0: GF, y1: 2.3 },
    { u0: 6.4, u1: 7.8, y0: GF, y1: 3.4 },
  ], M.stain);

  // —— 后厨与楼梯间之间：x = 28.7 ——
  const p2 = makeWall(1, 0, 28.7, Z1 - WALL - 0.05, 7.9);
  innerWall(k, p2, GF, F1 - 0.02, [{ u0: 4.6, u1: 5.9, y0: GF, y1: 2.25 }], M.stain);

  // —— 横墙：z = -23.9（商铺/后厨 与 北侧储藏之间）——
  const p3 = makeWall(0, -1, 33.4, -23.9, 21.0);
  innerWall(k, p3, GF, F1 - 0.02, [
    { u0: 3.0, u1: 5.4, y0: GF, y1: 3.3 },
    { u0: 9.2, u1: 10.4, y0: GF, y1: 2.3 },
  ], M.stain);

  // —— 商铺：柜台（HOTSPOTS.shopInterior 周边留 1.2m 空）——
  boxAt(k, M.woodDark, 20.9, GF + 0.44, -18.5, 0.68, 0.88, 3.2);
  boxAt(k, M.woodOld, 20.9, GF + 0.92, -18.5, 0.92, 0.08, 3.34);
  boxAt(k, M.metal, 20.9, GF + 0.99, -17.6, 0.34, 0.1, 0.42); // 秤
  boxAt(k, M.woodOld, 21.3, GF + 1.02, -19.4, 0.4, 0.22, 0.5); // 纸箱
  // 柜台后的货架（倒塌一半）
  for (let i = 0; i < 3; i += 1) {
    boxAt(k, M.woodDark, 21.9, GF + 0.5 + i * 0.62, -16.4, 0.44, 0.06, 1.6);
  }
  const fallenShelf = boxAt(k, M.woodDark, 21.4, GF + 0.28, -14.9, 0.5, 0.06, 1.5);
  fallenShelf.rotation.z = 0.9;

  // 灶台（HOTSPOTS.shopInterior）：铁炉 + 火 + 烟囱
  const sx = HOTSPOTS.shopInterior.x;
  const sz = HOTSPOTS.shopInterior.z;
  boxAt(k, M.burnt, sx, GF + 0.34, sz, 0.7, 0.64, 0.62);
  boxAt(k, M.steel, sx, GF + 0.68, sz, 0.78, 0.06, 0.7);
  boxAt(k, M.rust, sx, GF + 0.3, sz + 0.32, 0.4, 0.34, 0.04); // 炉门
  const fireQ = mesh(new THREE.PlaneGeometry(0.24, 0.16), M.glowFire);
  fireQ.position.set(sx, GF + 0.26, sz + 0.345);
  fireQ.castShadow = false;
  k.put(fireQ);
  k.put(cyl(0.16, 0.13, 0.16, 8, M.steel).translateX(sx).translateY(GF + 0.79).translateZ(sz));
  // 烟囱管一直通到楼板
  k.put(cylinderBetween(new THREE.Vector3(sx, GF + 0.7, sz), new THREE.Vector3(sx, F1 - 0.05, sz), 0.075, M.steel, 7));
  // 炉边的锅碗与柴火（离灶台中心 ≥1.2m，给蒸汽/火光留出空场）
  boxAt(k, M.timber, sx - 1.55, GF + 0.09, sz - 0.5, 0.6, 0.18, 0.26, 0.4);
  boxAt(k, M.timber, sx - 1.5, GF + 0.26, sz - 0.48, 0.5, 0.16, 0.22, 0.5);
  k.put(cyl(0.15, 0.12, 0.2, 8, M.metal).translateX(sx + 1.35).translateY(GF + 0.1).translateZ(sz - 0.4));

  // 商铺角落：木箱堆、倒下的椅子、毯子
  boxAt(k, M.woodOld, 14.2, GF + 0.3, -15.6, 0.62, 0.6, 0.62, 0.3);
  boxAt(k, M.woodOld, 14.4, GF + 0.86, -15.5, 0.5, 0.5, 0.5, -0.2);
  boxAt(k, M.woodDark, 13.4, GF + 0.24, -16.9, 0.55, 0.48, 0.5, 0.9);
  chair(k, 16.3, GF, -16.0, 2.1, true);
  chair(k, 19.4, GF, -16.6, 0.4, false);
  mattress(k, 15.6, GF, -21.2, 0.2, M.tarp);
  // 地毯（一角卷起）
  boxAt(k, M.fabric, 19.4, GF + 0.02, -16.2, 1.7, 0.03, 1.2, 0.15);
  const corner = boxAt(k, M.fabric, 20.2, GF + 0.12, -15.8, 0.5, 0.28, 0.22, 0.4);
  corner.rotation.z = 0.6;

  // 商铺室内墙面：剥落壁纸 + 熏黑（只贴在实墙上，避开窗洞）
  innerPanel(k, WEST, 7.4, 9.4, GF + 0.1, 2.7, M.wallpaper);
  innerPanel(k, WEST, 11.4, 13.2, GF + 0.1, 2.7, M.wallpaper);
  innerPanel(k, SOUTH, 8.4, 11.0, GF + 0.1, 2.6, M.wallpaper);
  innerPanel(k, SOUTH, 3.0, 4.6, GF + 0.1, 2.6, M.peel);
  innerPanel(k, CHAMFER, 0.2, 4.9, 2.85, 3.95, M.soot);
  // 剥落的壁纸条
  for (let i = 0; i < 6; i += 1) {
    const s = mesh(new THREE.PlaneGeometry(rng.range(0.4, 1.2), rng.range(0.3, 0.9)), M.peel);
    s.position.copy(wallPoint(WEST, rng.range(13.0, 16.2), rng.range(0.6, 2.6), -WALL - 0.03));
    s.rotation.y = WEST.theta + Math.PI;
    s.rotation.z = rng.range(-0.3, 0.3);
    k.put(s);
  }
  // 卷边下垂的壁纸条（真实厚度 + 底部卷起）
  wallpaperStrips(k, WEST, 13.0, 16.2, 0.5, 2.7, 7);
  wallpaperStrips(k, SOUTH, 3.0, 8.4, 0.4, 2.6, 6);

  // —— 后厨残骸（x 22.6..28.6）——
  boxAt(k, M.concreteDark, 25.4, GF + 0.42, -14.1, 3.2, 0.84, 0.6); // 台面
  boxAt(k, M.metal, 24.4, GF + 0.86, -14.1, 0.7, 0.06, 0.44); // 水槽沿
  boxAt(k, M.pitch, 24.4, GF + 0.8, -14.1, 0.5, 0.06, 0.3); // 水槽洞
  for (let i = 0; i < 3; i += 1) {
    boxAt(k, M.woodDark, 24.1 + i * 1.1, GF + 0.22, -14.35, 0.9, 0.44, 0.1); // 柜门
    boxAt(k, M.steel, 24.1 + i * 1.1 + 0.36, GF + 0.24, -14.3, 0.05, 0.14, 0.05); // 把手
  }
  const upperCab = boxAt(k, M.woodDark, 25.0, GF + 2.0, -13.95, 2.4, 0.7, 0.42);
  upperCab.rotation.x = 0.08;
  const cabDoor = boxAt(k, M.woodOld, 25.6, GF + 1.9, -14.25, 1.0, 0.66, 0.06);
  cabDoor.rotation.y = 1.1;
  // 翻倒的冰箱
  const fridge = boxAt(k, M.metal, 27.4, GF + 0.36, -15.4, 0.72, 1.7, 0.66, 0.3);
  fridge.rotation.z = Math.PI / 2 - 0.06;
  // 锅碗散落（带锅沿与双把手的锅）
  pot(k, 24.0, GF, -15.0, 0.19, 0.2);
  k.put(cyl(0.14, 0.14, 0.07, 9, M.metal).translateX(26.4).translateY(GF + 0.04).translateZ(-14.6));
  bottles(k, 23.3, GF + 0.86, -14.1, 4);
  boxAt(k, M.woodDark, 26.9, GF + 0.68, -13.9, 1.1, 0.06, 0.72, 0.1).rotation.x = Math.PI / 2 - 0.1; // 翻倒小桌
  tableUpright(k, 25.2, GF, -18.4, true);
  chair(k, 24.2, GF, -18.4, 1.4, true);
  chair(k, 26.2, GF, -17.6, 4.2, false);
  // 挂在墙上的相框
  pictureFrame(k, 26.0, GF + 1.75, -14.35, 0, 0.06);
  pictureFrame(k, 22.6, GF + 1.6, -14.35, 0, -0.09);

  // —— 楼梯间（x 28.9..33.4）：一层→二层，向北爬升 ——
  flight(k, 29.2, 30.6, -14.8, GF, 10, 0.41, 0.62, M.woodOld, [4, 7]);
  // 楼梯栏杆（弯折）
  k.put(cylinderBetween(new THREE.Vector3(30.6, GF + 1.0, -14.8), new THREE.Vector3(30.6, F1 + 0.9, -20.0), 0.035, M.rust, 5));
  k.put(cylinderBetween(new THREE.Vector3(30.6, F1 + 0.9, -20.0), new THREE.Vector3(30.6, F1 + 0.5, -19.2), 0.03, M.rust, 5));
  // 楼梯间的暗色墙面
  innerPanel(k, EAST, 9.0, 12.0, GF + 0.2, F1 - 0.1, M.soot);

  // —— 北侧储藏（z < -23.9）：储物柜、沙袋、坍塌 ——
  for (let i = 0; i < 3; i += 1) {
    const lx = 14.0 + i * 0.62;
    boxAt(k, M.steel, lx, GF + 0.95, -25.0, 0.56, 1.9, 0.5);
    if (i === 1) {
      const door = boxAt(k, M.metal, lx, GF + 0.95, -24.7, 0.5, 1.8, 0.05);
      door.rotation.y = 0.8;
    }
  }
  sandbagRow(k, 20.0, -25.6, 5, M.sandbag);
  sandbagRow(k, 20.2, -25.6, 4, M.sandbagDark);
  // 坍塌的顶板与椽木
  const slabChunk = chunk(k, M.concreteDark, 1.6, 3);
  slabChunk.position.set(17.0, 1.5, -28.6);
  slabChunk.rotation.set(0.5, 0.4, 0.2);
  for (let i = 0; i < 4; i += 1) {
    k.put(cylinderBetween(
      new THREE.Vector3(13.4 + i * 2.4, 3.1, -31.6),
      new THREE.Vector3(14.6 + i * 2.4, 2.4, -25.2),
      0.07,
      M.timber,
      6,
    ));
  }
  // 后门通道（东墙门洞前的通道墙）
  const backWall = makeWall(0, 1, 31.0, -27.0, 2.3);
  innerWall(k, backWall, GF, F1 - 0.02, [{ u0: 0.9, u1: 2.0, y0: GF, y1: 2.2 }], M.soot);

  // —— 地下室入口暗示：掀开的盖板 + 漆黑的梯口 ——
  const hatch = mesh(new THREE.PlaneGeometry(1.3, 1.3), M.pitch);
  hatch.rotation.x = -Math.PI / 2;
  hatch.position.set(23.6, GF + 0.015, -26.4);
  hatch.castShadow = false;
  k.put(hatch);
  const lid = boxAt(k, M.rust, 24.5, GF + 0.55, -26.4, 1.2, 0.06, 1.2);
  lid.rotation.z = 1.15;
  k.put(cylinderBetween(new THREE.Vector3(23.6, GF, -25.9), new THREE.Vector3(23.6, GF + 1.5, -26.6), 0.05, M.metal, 6)); // 梯子扶手
  for (let i = 0; i < 3; i += 1) {
    k.put(boxAt(k, M.steel, 23.6, GF - 0.1 - i * 0.16, -26.0 - i * 0.1, 0.5, 0.05, 0.16));
  }

  // 底层后窗：加一条木板封堵
  k.put(wallBox(NORTH, 12.6, 1.9, 0.05, 1.6, 0.22, 0.07, M.woodOld));
}

/** 一段楼梯（踏步 + 踢面 + 斜梁） */
function flight(
  k: Kit,
  x0: number,
  x1: number,
  zStart: number,
  yStart: number,
  steps: number,
  rise: number,
  run: number,
  mat: THREE.Material,
  broken: number[],
): void {
  const cx = (x0 + x1) / 2;
  const w = x1 - x0;
  for (let i = 0; i < steps; i += 1) {
    if (broken.indexOf(i) >= 0) continue;
    const y = yStart + (i + 1) * rise;
    const z = zStart - i * run - run / 2;
    boxAt(k, mat, cx, y - 0.055, z, w, 0.09, run * 1.02);
    boxAt(k, k.mats.woodDark, cx, y - rise / 2, z + run / 2 - 0.03, w, rise, 0.055);
  }
  const zTop = zStart - steps * run;
  const yTop = yStart + steps * rise;
  k.put(cylinderBetween(new THREE.Vector3(x0 + 0.06, yStart + 0.12, zStart), new THREE.Vector3(x0 + 0.06, yTop - 0.08, zTop), 0.055, k.mats.woodDark, 5));
}

/** 一排沙袋（含缺口） */
function sandbagRow(k: Kit, x: number, z: number, count: number, mat: THREE.Material): void {
  for (let i = 0; i < count; i += 1) {
    if (i === count - 2 && k.rng.chance(0.6)) continue;
    const bag = softBox(0.5, 0.22, 0.34, 0.07, mat);
    bag.position.set(x + i * 0.5, GF + 0.12, z + k.rng.range(-0.04, 0.04));
    bag.rotation.y = k.rng.range(-0.16, 0.16);
    k.put(bag);
  }
}

/* ------------------------------------------------------------------ *
 * 室内家具构件
 * ------------------------------------------------------------------ */

function chair(k: Kit, x: number, y: number, z: number, rotY: number, tipped: boolean): void {
  const M = k.mats;
  const seat = boxAt(k, M.woodDark, x, y + (tipped ? 0.14 : 0.45), z, 0.44, 0.07, 0.44, rotY);
  const back = boxAt(k, M.woodDark, x, y + (tipped ? 0.32 : 0.72), z + (tipped ? 0.3 : 0.2), 0.44, 0.5, 0.06, rotY);
  if (tipped) {
    seat.rotation.x = 1.25;
    back.rotation.x = 0.35;
    // 翻倒的椅子腿（散在地上）
    for (const s of [-1, 1]) {
      const leg = box(0.055, 0.44, 0.055, M.woodDark);
      leg.position.set(x + Math.sin(rotY) * s * 0.17, y + 0.06, z + Math.cos(rotY) * s * 0.17);
      leg.rotation.set(1.35, rotY, 0);
      k.put(leg);
    }
  } else {
    seat.rotation.x = 0.02;
    // 四条腿（椅背侧两根连着靠背）
    for (const s of [-1, 1]) {
      for (const t of [-1, 1]) {
        const lx = x + Math.sin(rotY) * s * 0.17 + Math.cos(rotY) * t * 0.17;
        const lz = z + Math.cos(rotY) * s * 0.17 - Math.sin(rotY) * t * 0.17;
        boxAt(k, M.woodDark, lx, y + 0.21, lz, 0.055, 0.42, 0.055);
      }
    }
    // 靠背竖档
    for (const s of [-1, 1]) {
      const p = box(0.045, 0.5, 0.045, M.woodDark);
      p.position.set(x + Math.sin(rotY) * s * 0.18, y + 0.7, z + Math.cos(rotY) * s * 0.18 + 0.2);
      p.rotation.y = rotY;
      k.put(p);
    }
  }
}

function tableUpright(k: Kit, x: number, y: number, z: number, alongX: boolean): void {
  const M = k.mats;
  const L = alongX ? 1.3 : 0.84;
  const D = alongX ? 0.84 : 1.3;
  boxAt(k, M.woodOld, x, y + 0.72, z, L, 0.07, D);
  // 桌面下的横撑
  boxAt(k, M.woodDark, x, y + 0.62, z, L * 0.9, 0.05, 0.05);
  for (const s of [-1, 1]) {
    boxAt(k, M.woodDark, x + s * (L / 2 - 0.09), y + 0.35, z - (D / 2 - 0.09), 0.07, 0.7, 0.07);
    boxAt(k, M.woodDark, x + s * (L / 2 - 0.09), y + 0.35, z + (D / 2 - 0.09), 0.07, 0.7, 0.07);
  }
}

/** 带柜门与把手的柜子（细节：门缝、把手、腿） */
function cabinet(k: Kit, x: number, y: number, z: number, w: number, h: number, d: number, rotY: number, open: boolean): void {
  const M = k.mats;
  boxAt(k, M.woodDark, x, y + h / 2 + 0.06, z, w, h, d, rotY);
  // 柜门（略凹进柜体，形成门缝）
  const dw = (w - 0.1) / 2;
  for (const s of [-1, 1]) {
    const door = boxAt(k, M.woodOld, x + Math.cos(rotY) * s * (dw / 2 + 0.02), y + h / 2 + 0.06, z - Math.sin(rotY) * s * (dw / 2 + 0.02), dw - 0.02, h - 0.08, 0.04, rotY);
    if (open && s > 0) door.rotation.y = rotY + 0.85;
    // 把手
    const hx = x + Math.cos(rotY) * s * 0.06;
    const hz = z - Math.sin(rotY) * s * 0.06;
    boxAt(k, M.steel, hx, y + h / 2 + 0.06, hz, 0.04, 0.16, 0.04, rotY);
  }
  // 柜腿
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const lx = x + Math.cos(rotY) * sx * (w / 2 - 0.07) + Math.sin(rotY) * sz * (d / 2 - 0.07);
      const lz = z - Math.sin(rotY) * sx * (w / 2 - 0.07) + Math.cos(rotY) * sz * (d / 2 - 0.07);
      boxAt(k, M.woodDark, lx, y + 0.03, lz, 0.06, 0.06, 0.06);
    }
  }
}

/** 带锅沿与双把手的铁锅 */
function pot(k: Kit, x: number, y: number, z: number, r: number, h: number): void {
  const M = k.mats;
  const body = cyl(r, r * 0.88, h, 10, M.steel);
  at(body, x, y + h / 2, z);
  k.put(body);
  // 锅沿（翻边）
  const rim = cyl(r * 1.08, r * 1.08, 0.03, 10, M.rustDark);
  at(rim, x, y + h, z);
  k.put(rim);
  // 锅底
  const base = cyl(r * 0.88, r * 0.88, 0.03, 10, M.burnt);
  at(base, x, y + 0.015, z);
  k.put(base);
  // 两侧把手
  for (const s of [-1, 1]) {
    const handle = box(0.14, 0.035, 0.05, M.rust);
    at(handle, x + s * (r + 0.07), y + h * 0.82, z);
    k.put(handle);
  }
}

/** 书架上的一排书（instanced 小体块，有厚度） */
function bookRow(k: Kit, x: number, y: number, z: number, count: number, rotY: number): void {
  const rng = k.rng.fork(Math.round(x * 31 + y * 7));
  const list: InstanceTransform[] = [];
  for (let i = 0; i < count; i += 1) {
    list.push({
      position: new THREE.Vector3(
        x + Math.cos(rotY) * (i * 0.055 - (count * 0.055) / 2),
        y + 0.11,
        z - Math.sin(rotY) * (i * 0.055 - (count * 0.055) / 2),
      ),
      rotation: new THREE.Euler(rng.range(-0.06, 0.06), rotY + rng.range(-0.12, 0.12), rng.range(-0.1, 0.1)),
      scale: new THREE.Vector3(1, rng.range(0.85, 1.2), 1),
    });
  }
  k.hold(instanced(new THREE.BoxGeometry(0.042, 0.22, 0.16), k.mats.fabric, list));
}

/** 相框（斜靠在墙上的小画框，带边框厚度） */
function pictureFrame(k: Kit, x: number, y: number, z: number, rotY: number, tilt: number): void {
  const M = k.mats;
  const fw = 0.3;
  const fh = 0.38;
  const outer = boxAt(k, M.woodOld, x, y, z, fw, fh, 0.03, rotY);
  outer.rotation.x = tilt;
  const inner = boxAt(k, M.paper, x, y, z, fw - 0.07, fh - 0.07, 0.035, rotY);
  inner.rotation.x = tilt;
  inner.position.add(new THREE.Vector3(Math.sin(rotY) * 0.012, 0, Math.cos(rotY) * 0.012));
}

/** 瓶罐（instanced：细颈 + 鼓腹的剪影） */
function bottles(k: Kit, x: number, y: number, z: number, count: number): void {
  const rng = k.rng.fork(Math.round(x * 17 + z * 5));
  const list: InstanceTransform[] = [];
  for (let i = 0; i < count; i += 1) {
    list.push({
      position: new THREE.Vector3(x + rng.range(-0.24, 0.24), y + 0.11, z + rng.range(-0.14, 0.14)),
      rotation: new THREE.Euler(rng.range(-0.1, 0.1), rng.range(0, 6), rng.range(-0.1, 0.1)),
      scale: new THREE.Vector3(1, rng.range(0.8, 1.25), 1),
    });
  }
  k.hold(instanced(new THREE.CylinderGeometry(0.045, 0.055, 0.22, 7), k.mats.metal, list));
}

function wardrobe(k: Kit, x: number, y: number, z: number, rotY: number, open: boolean): void {
  const M = k.mats;
  boxAt(k, M.woodDark, x, y + 1.0, z, 1.15, 2.0, 0.6, rotY);
  const doorA = boxAt(k, M.woodOld, x - 0.02, y + 1.05, z + 0.32, 0.55, 1.9, 0.05, rotY);
  if (open) doorA.rotation.y = rotY + 0.9;
  boxAt(k, M.woodOld, x + 0.3, y + 1.05, z + 0.32, 0.55, 1.9, 0.05, rotY);
  // 把手
  boxAt(k, M.steel, x - 0.3, y + 1.05, z + 0.36, 0.05, 0.2, 0.05, rotY);
  boxAt(k, M.steel, x + 0.24, y + 1.05, z + 0.36, 0.05, 0.2, 0.05, rotY);
  // 柜内暗腔
  const inner = mesh(new THREE.PlaneGeometry(1.0, 1.7), M.pitch);
  inner.position.set(x, y + 1.0, z + 0.24);
  inner.rotation.y = rotY;
  k.put(inner);
  // 柜顶的行李/盒子
  boxAt(k, M.woodOld, x + 0.1, y + 2.08, z, 0.6, 0.16, 0.4, rotY + 0.3);
}

function mattress(k: Kit, x: number, y: number, z: number, rotY: number, mat: THREE.Material): void {
  const m = softBox(1.5, 0.24, 0.9, 0.14, mat);
  m.position.set(x, y + 0.13, z);
  m.rotation.y = rotY;
  k.put(m);
  // 床架（床腿 + 侧板）
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const lx = x + Math.cos(rotY) * sx * 0.66 - Math.sin(rotY) * sz * 0.38;
      const lz = z - Math.sin(rotY) * sx * 0.66 - Math.cos(rotY) * sz * 0.38;
      boxAt(k, k.mats.woodDark, lx, y + 0.06, lz, 0.07, 0.12, 0.07);
    }
  }
}

function bookShelf(k: Kit, x: number, y: number, z: number, rotY: number, fallen: boolean): void {
  const M = k.mats;
  const body = boxAt(k, M.woodDark, x, y + (fallen ? 0.2 : 0.85), z, 0.9, 1.7, 0.34, rotY);
  if (fallen) {
    body.rotation.z = Math.PI / 2 - 0.08;
    body.position.y = y + 0.16;
  } else {
    for (let i = 0; i < 4; i += 1) {
      boxAt(k, M.woodOld, x, y + 0.28 + i * 0.42, z + 0.02, 0.84, 0.05, 0.3, rotY);
      // 隔板上的书
      if (i < 3) bookRow(k, x, y + 0.3 + i * 0.42, z + 0.02, 7, rotY);
    }
  }
}

/**
 * 墙上剥落的壁纸条：垂下来的卷边片（真实厚度 + 底部卷曲）
 */
function wallpaperStrips(
  k: Kit,
  w: Wall,
  u0: number,
  u1: number,
  y0: number,
  y1: number,
  count: number,
): void {
  const rng = k.rng.fork(Math.round(u0 * 13 + y0 * 7));
  for (let i = 0; i < count; i += 1) {
    const sw = rng.range(0.18, 0.44);
    const sh = rng.range(0.3, 0.95);
    const su = rng.range(u0, u1 - sw);
    const sy = rng.range(y0, Math.max(y0 + 0.2, y1 - sh));
    // 卷边：顶端平贴，下端向外卷起
    const s = new THREE.Shape();
    s.moveTo(-sw / 2, 0);
    s.lineTo(sw / 2, 0);
    s.lineTo(sw / 2 - 0.03, -sh * 0.7);
    s.quadraticCurveTo(sw / 2 - 0.02, -sh, sw / 2 - 0.14, -sh * 0.92);
    s.lineTo(-sw / 2 + 0.02, -sh * 0.55);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.014, bevelEnabled: false, curveSegments: 5 });
    g.rotateY(Math.PI / 2);
    const m = mesh(g, rng.chance(0.5) ? k.mats.peel : k.mats.wallpaper);
    m.position.copy(wallPoint(w, su + sw / 2, sy, -WALL - 0.02));
    m.rotation.y = w.theta;
    m.rotation.z = rng.range(-0.08, 0.08);
    k.put(m);
  }
}

/* ------------------------------------------------------------------ *
 * 室内：二层住宅
 * ------------------------------------------------------------------ */

function buildFloorOne(k: Kit): void {
  const M = k.mats;

  // 楼板（楼梯井开洞）
  plate(k, F1, SLAB, [[[29.0, -20.8], [31.0, -20.8], [31.0, -17.0], [29.0, -17.0]]], M.soot);

  // 隔墙
  const cross = makeWall(0, -1, 33.4, Z1 - WALL - 0.05, 20.4);
  innerWall(k, cross, F1Y, F2 - 0.02, [
    { u0: 2.0, u1: 4.4, y0: F1Y, y1: F2 - 0.2 },
    { u0: 12.0, u1: 13.4, y0: F1Y, y1: F1Y + 2.1 },
  ], M.stain);
  const partX = makeWall(1, 0, 22.6, Z1 - WALL - 0.05, 10.6);
  innerWall(k, partX, F1Y, F2 - 0.02, [
    { u0: 3.0, u1: 4.2, y0: F1Y, y1: F1Y + 2.1 },
    { u0: 7.2, u1: 8.0, y0: F1Y, y1: F1Y + 1.2 },
  ], M.stain);
  // 楼梯间墙
  const stairWall = makeWall(1, 0, 30.9, Z1 - WALL - 0.05, 7.6);
  innerWall(k, stairWall, F1Y, F2 - 0.02, [{ u0: 2.4, u1: 3.6, y0: F1Y, y1: F1Y + 2.1 }], M.stain);

  // —— 前室（西/南破洞都看得到）——
  // 翻倒的餐桌
  const top = boxAt(k, M.woodOld, 16.4, F1Y + 0.42, -17.4, 1.3, 0.08, 0.88, 0.5);
  top.rotation.x = 1.35;
  boxAt(k, M.woodDark, 15.9, F1Y + 0.2, -17.9, 0.07, 0.5, 0.07).rotation.z = 1.1;
  boxAt(k, M.woodDark, 17.0, F1Y + 0.2, -17.1, 0.07, 0.5, 0.07).rotation.z = -1.2;
  chair(k, 16.2, F1Y, -19.0, 2.4, true);
  chair(k, 18.2, F1Y, -16.4, 0.6, false);
  chair(k, 14.6, F1Y, -16.2, 3.6, true);

  // 破衣柜（靠内隔墙）
  wardrobe(k, 18.8, F1Y, -21.9, 0.02, true);
  // 倒塌书架 + 散落书
  bookShelf(k, 14.4, F1Y, -20.4, Math.PI / 2, true);
  bookShelf(k, 12.9, F1Y, -18.6, Math.PI / 2, false);
  // 床垫 + 毯子（临时睡处）
  mattress(k, 14.2, F1Y, -15.4, 0.1, M.fabric);
  const blanket = softBox(1.1, 0.12, 0.8, 0.08, M.tarp);
  blanket.position.set(14.0, F1Y + 0.28, -15.2);
  blanket.rotation.y = 0.2;
  k.put(blanket);
  // 窗下沙袋（加固）
  for (let i = 0; i < 4; i += 1) {
    const bag = softBox(0.5, 0.22, 0.34, 0.07, i % 2 === 0 ? M.sandbag : M.sandbagDark);
    at(bag, 17.6 + i * 0.48, F1Y + 0.12, -14.0);
    k.put(bag);
    if (i < 3) {
      const bag2 = softBox(0.5, 0.22, 0.34, 0.07, M.sandbag);
      at(bag2, 17.8 + i * 0.48, F1Y + 0.32, -14.0);
      k.put(bag2);
    }
  }
  // 散落纸张与书（instanced）
  scatter(k, 'paper', 22, { x0: 13.2, x1: 21.6, z0: -21.6, z1: -14.2, y: F1Y + 0.03 });
  scatter(k, 'book', 16, { x0: 13.0, x1: 21.4, z0: -21.4, z1: -14.4, y: F1Y + 0.05 });
  // 应急灯（门口上方）+ 蜡烛
  emergencyLamp(k, 22.3, F1Y + 2.05, -20.9, -Math.PI / 2);
  candle(k, 20.2, F1Y, -19.4);

  // 壁纸（贴在室内墙面，避开窗洞）+ 剥落
  innerPanel(k, WEST, 5.6, 8.4, F1Y + 0.05, F2 - 0.3, M.wallpaper);
  innerPanel(k, WEST, 10.6, 12.9, F1Y + 0.05, F2 - 0.3, M.peel);
  innerPanel(k, SOUTH, 12.6, 14.6, F1Y + 0.05, F2 - 0.3, M.wallpaper);
  innerPanel(k, SOUTH, 3.9, 5.2, F1Y + 0.05, F2 - 0.3, M.peel);
  wallpaperStrips(k, WEST, 5.6, 8.4, F1Y + 0.3, F2 - 0.5, 6);
  wallpaperStrips(k, WEST, 10.6, 12.9, F1Y + 0.3, F2 - 0.5, 4);
  wallpaperStrips(k, SOUTH, 12.6, 14.6, F1Y + 0.3, F2 - 0.5, 4);

  // —— 后室（床 / 斗柜 / 倒塌的顶）——
  boxAt(k, M.woodDark, 25.6, F1Y + 0.2, -19.2, 1.9, 0.26, 0.95);
  boxAt(k, M.woodDark, 25.6, F1Y + 0.45, -19.65, 1.9, 0.5, 0.08); // 床头
  mattress(k, 25.6, F1Y + 0.28, -19.1, 0, M.paper);
  boxAt(k, M.woodOld, 27.9, F1Y + 0.55, -15.4, 1.0, 0.9, 0.44, 0.2);
  boxAt(k, M.woodDark, 27.4, F1Y + 0.09, -14.6, 0.5, 0.18, 0.4, 0.5); // 抽屉
  boxAt(k, M.woodDark, 27.9, F1Y + 0.09, -14.2, 0.5, 0.18, 0.4, 1.1);
  chair(k, 23.4, F1Y, -15.0, 0.2, true);
  // 后室屋顶塌下来的一角
  const debris = chunk(k, M.concreteDark, 1.3, 11);
  debris.position.set(24.9, F1Y + 1.4, -16.6);
  debris.rotation.set(0.6, 0.3, 0.4);

  // 二层通三层楼梯
  flight(k, 31.5, 32.9, -15.2, F1Y, 8, 0.4125, 0.62, M.woodOld, [2, 5]);
}

/* ------------------------------------------------------------------ *
 * 室内：三层（残破住宅 + 避难角）
 * ------------------------------------------------------------------ */

function buildFloorTwo(k: Kit): void {
  const M = k.mats;
  const rng = k.rng.fork(303);

  // 楼板：楼梯井洞 + 局部塌落洞
  plate(k, F2, SLAB, [
    [[31.2, -20.8], [33.2, -20.8], [33.2, -16.8], [31.2, -16.8]],
    jaggedRect(26.2, 29.4, -28.2, -24.6, rng, 0.45),
  ], M.soot);

  // 隔墙（残破：只剩半截）
  const cross = makeWall(0, -1, 33.4, -23.6, 14.0);
  innerWall(k, cross, F2Y, EAVE - 0.15, [
    { u0: 2.2, u1: 4.6, y0: F2Y, y1: F2Y + 2.2 },
    { u0: 7.4, u1: 9.2, y0: F2Y, y1: EAVE - 0.15 },
  ], M.stain);
  const partX = makeWall(1, 0, 22.8, Z1 - WALL - 0.05, 10.2);
  innerWall(k, partX, F2Y, EAVE - 0.15, [{ u0: 2.6, u1: 4.0, y0: F2Y, y1: F2Y + 2.1 }], M.stain);

  // —— 避难角（西侧，沙袋 + 毯子 + 应急灯 + 行李箱）——
  for (let i = 0; i < 5; i += 1) {
    const bag = softBox(0.5, 0.22, 0.34, 0.07, i % 2 === 0 ? M.sandbag : M.sandbagDark);
    at(bag, 13.6 + i * 0.46, F2Y + 0.12, -17.2);
    bag.rotation.y = 0.2;
    k.put(bag);
    if (i < 4) {
      const bag2 = softBox(0.5, 0.22, 0.34, 0.07, M.sandbag);
      at(bag2, 13.75 + i * 0.46, F2Y + 0.31, -17.2);
      bag2.rotation.y = -0.15;
      k.put(bag2);
    }
  }
  const bnk = softBox(1.6, 0.2, 1.1, 0.12, M.tarp);
  at(bnk, 15.2, F2Y + 0.11, -18.6);
  bnk.rotation.y = 0.1;
  k.put(bnk);
  const bnk2 = softBox(0.9, 0.14, 0.7, 0.08, M.fabric);
  at(bnk2, 14.4, F2Y + 0.22, -19.2);
  k.put(bnk2);
  boxAt(k, M.woodDark, 16.9, F2Y + 0.22, -19.6, 0.66, 0.44, 0.4, 0.3); // 行李箱
  boxAt(k, M.metal, 17.2, F2Y + 0.5, -19.5, 0.3, 0.3, 0.28, 0.6);
  emergencyLamp(k, 13.2, F2Y + 1.85, -16.4, Math.PI / 2);
  candle(k, 15.8, F2Y, -20.0);
  // 挂着的破布帘
  const curtain = mesh(new THREE.PlaneGeometry(1.6, 1.9), M.fabric);
  curtain.position.set(18.6, F2Y + 1.0, -20.6);
  curtain.rotation.y = 0.12;
  curtain.castShadow = false;
  k.put(curtain);

  // —— 前室其他家具 ——
  wardrobe(k, 12.9, F2Y, -14.4, -Math.PI / 2, true);
  bookShelf(k, 16.4, F2Y, -21.9, 0, false);
  chair(k, 19.6, F2Y, -16.6, 1.2, true);
  chair(k, 20.4, F2Y, -18.8, 4.0, true);
  const top = boxAt(k, M.woodOld, 19.0, F2Y + 0.4, -19.6, 1.2, 0.08, 0.8, 0.9);
  top.rotation.x = -1.4;
  scatter(k, 'paper', 16, { x0: 13.4, x1: 21.8, z0: -22.2, z1: -14.2, y: F2Y + 0.03 });
  scatter(k, 'book', 12, { x0: 13.2, x1: 21.6, z0: -22.0, z1: -14.4, y: F2Y + 0.05 });
  innerPanel(k, WEST, 6.4, 9.0, F2Y + 0.05, EAVE - 0.4, M.wallpaper);
  innerPanel(k, WEST, 11.2, 13.0, F2Y + 0.05, EAVE - 0.4, M.peel);
  innerPanel(k, SOUTH, 4.2, 6.2, F2Y + 0.05, EAVE - 0.4, M.peel);
  innerPanel(k, SOUTH, 13.4, 15.4, F2Y + 0.05, EAVE - 0.4, M.wallpaper);
  wallpaperStrips(k, WEST, 6.4, 9.0, F2Y + 0.3, EAVE - 0.6, 5);
  wallpaperStrips(k, SOUTH, 13.4, 15.4, F2Y + 0.3, EAVE - 0.6, 4);
  // 三层的柜子、相框与瓶罐
  cabinet(k, 14.2, F2Y, -21.9, 0.9, 1.1, 2.0, 0.05, true);
  pictureFrame(k, 12.7, F2Y + 1.65, -18.5, Math.PI / 2, 0.05);
  bottles(k, 16.4, F2Y + 0.42, -21.9, 3);

  // —— 东北角：屋顶塌落砸穿楼板，椽木插下来 ——
  const pile: Array<{ position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }> = [];
  for (let i = 0; i < 22; i += 1) {
    pile.push({
      position: new THREE.Vector3(rng.range(25.2, 30.2), F2Y + rng.range(0.1, 0.8), rng.range(-28.6, -23.8)),
      rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 6), rng.range(0, 3)),
      scale: new THREE.Vector3(1, 1, 1).multiplyScalar(rng.range(0.4, 1.2)),
    });
  }
  k.hold(instanced(jitter(new THREE.DodecahedronGeometry(0.3, 0), 0.06, rng), M.concreteDark, pile));
  for (let i = 0; i < 5; i += 1) {
    k.put(cylinderBetween(
      new THREE.Vector3(25.0 + i * 1.1, EAVE - 0.1, -28.4),
      new THREE.Vector3(25.6 + i * 1.1, F2Y + 0.6, -24.6),
      0.065,
      M.timber,
      5,
    ));
  }
  // 塌落口的边缘钢筋
  for (let i = 0; i < 4; i += 1) {
    k.put(cylinderBetween(
      new THREE.Vector3(26.4 + i * 0.8, F2Y + 0.05, -24.8),
      new THREE.Vector3(26.6 + i * 0.8, F2Y + 0.5, -24.2 - i * 0.2),
      0.02,
      M.rust,
      4,
    ));
  }

  // 三层到屋顶的破洞与残梯
  boxAt(k, M.steel, 32.0, F2Y + 0.9, -18.4, 0.5, 1.8, 0.06).rotation.z = 0.12;
}

/* ------------------------------------------------------------------ *
 * 屋顶：破损屋面、外露椽木、女儿墙缺口、瓦砾
 * ------------------------------------------------------------------ */

function buildRoof(k: Kit): void {
  const M = k.mats;
  const rng = k.rng.fork(505);

  // 屋面（带崩塌洞）
  plate(k, EAVE + 0.16, 0.16, [jaggedRect(25.0, 30.4, -28.8, -23.4, rng, 0.5)], M.roof);

  // 女儿墙（分三段，留缺口）
  const segs: Array<[Wall, number, number]> = [
    [WEST, 0.0, 16.4],
    [WEST, 17.2, 17.4],
    [CHAMFER, 0.0, 5.09],
    [SOUTH, 0.0, 9.6],
    [SOUTH, 13.2, 18.4],
    [EAST, 0.0, 21.0],
    [NORTH, 0.0, 4.4],
    [NORTH, 10.6, 22.0],
  ];
  for (const [w, a, b] of segs) {
    const len = b - a;
    if (len < 0.1) continue;
    k.put(wallBox(w, (a + b) / 2, EAVE + 0.16 + PARA / 2, -0.16, len, PARA, 0.3, M.plaster));
    // 压顶：独立的线脚几何（带外挑斜面 + 顶面高光），不与女儿墙体重叠
    wallGeom(k, w, (a + b) / 2, EAVE + 0.16 + PARA + 0.055, 0, profileBand(copingProfile, len), M.coping);
    // 压顶勾缝：沿长度方向分块的凹槽（几何，不是贴图）
    const joints = Math.max(1, Math.round(len / 1.3));
    for (let j = 1; j < joints; j += 1) {
      const ju = a + (len * j) / joints;
      k.put(wallBox(w, ju, EAVE + 0.16 + PARA + 0.06, -0.16, 0.05, 0.13, 0.35, M.concreteDark));
    }
  }
  for (let i = 0; i < 9; i += 1) {
    const c = chunk(k, i % 2 === 0 ? M.brickDark : M.plaster, rng.range(0.26, 0.46), 40 + i);
    const w = rng.pick([WEST, SOUTH, EAST, NORTH]);
    const uu = rng.range(0.2, w.len - 0.2);
    c.position.copy(wallPoint(w, uu, EAVE + 0.2 + rng.range(0, 0.12), -0.16));
  }

  // 崩塌处的椽木（部分断裂）
  for (let i = 0; i < 8; i += 1) {
    const z = -28.4 + i * 0.72;
    if (i === 3 || i === 6) {
      k.put(cylinderBetween(
        new THREE.Vector3(24.8, EAVE + 0.02, z),
        new THREE.Vector3(27.0, EAVE - 0.42, z + 0.2),
        0.07,
        M.timber,
        5,
      ));
      continue;
    }
    k.put(cylinderBetween(
      new THREE.Vector3(24.8, EAVE + 0.05, z),
      new THREE.Vector3(30.6, EAVE + 0.05, z),
      0.07,
      M.timber,
      5,
    ));
  }
  // 断裂屋面板翘起（压暗成深灰褐，做出厚度与翘角，不再是平色块）
  for (let i = 0; i < 4; i += 1) {
    const flap = boxAt(k, M.roofPatch, 25.4 + i * 1.4, EAVE + 0.26, -24.0 - i * 0.3, 1.1, 0.09, 0.9);
    flap.rotation.set(0.3 + i * 0.12, rng.range(-0.5, 0.5), rng.range(-0.35, 0.35));
    // 底下压着的水泥碎块，让翘起的板有支撑
    boxAt(k, M.concreteDark, 25.3 + i * 1.4, EAVE + 0.2, -24.1 - i * 0.3, 0.3, 0.14, 0.26);
  }
  // 屋面瓦砾（低饱和水泥灰，只比屋面亮一点点）
  const rubble: Array<{ position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }> = [];
  for (let i = 0; i < 40; i += 1) {
    const nearHole = i < 26;
    rubble.push({
      position: new THREE.Vector3(
        nearHole ? rng.range(24.6, 30.8) : rng.range(14.0, 33.0),
        EAVE + 0.2,
        nearHole ? rng.range(-29.2, -22.8) : rng.range(-33.0, -14.0),
      ),
      rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 6), rng.range(0, 3)),
      scale: new THREE.Vector3(1, 1, 1).multiplyScalar(rng.range(0.3, 0.9)),
    });
  }
  k.hold(instanced(jitter(new THREE.DodecahedronGeometry(0.28, 0), 0.05, rng), M.roofDebris, rubble));

  // —— 屋面层次：卷材搭接缝（深色细缝）+ 沥青补丁 + 积水 ——
  for (let i = 0; i < 4; i += 1) {
    const zz = -31.4 + i * 4.6;
    const seam = boxAt(k, M.soot, 22.0, EAVE + 0.168, zz, 18.4, 0.02, 0.07);
    seam.rotation.y = rng.range(-0.02, 0.02);
  }
  for (let i = 0; i < 4; i += 1) {
    const patch = boxAt(k, i % 2 === 0 ? M.roofPatch : M.stain, rng.range(14.5, 32.5), EAVE + 0.19, rng.range(-33.0, -14.2), rng.range(1.2, 2.6), 0.07, rng.range(0.9, 2.0));
    patch.rotation.set(rng.range(-0.03, 0.03), rng.range(-0.4, 0.4), rng.range(-0.03, 0.03));
  }
  for (const [px, pz, pr] of [[16.8, -18.4, 1.5], [21.6, -30.2, 1.2], [31.4, -22.6, 1.1]] as Array<[number, number, number]>) {
    const puddle = mesh(jitter(new THREE.CircleGeometry(pr, 12), pr * 0.16, rng), M.roofPool);
    puddle.rotation.x = -Math.PI / 2;
    puddle.position.set(px, EAVE + 0.18, pz);
    k.put(puddle);
  }

  // —— 通风管 / 排气帽 ——
  const vent = (vx: number, vz: number, r: number, h: number): void => {
    boxAt(k, M.concreteDark, vx, EAVE + 0.2, vz, r * 4.2, 0.14, r * 4.2);
    k.put(cyl(r, r, h, 8, M.steel).translateX(vx).translateY(EAVE + 0.16 + h / 2).translateZ(vz));
    k.put(cyl(r * 1.85, r * 1.85, 0.06, 10, M.rustDark).translateX(vx).translateY(EAVE + 0.16 + h).translateZ(vz));
    k.put(cyl(r * 1.4, r * 1.4, 0.15, 8, M.metal).translateX(vx).translateY(EAVE + 0.16 + h + 0.1).translateZ(vz));
  };
  vent(15.4, -25.8, 0.13, 0.74);
  vent(18.6, -31.4, 0.11, 0.62);
  vent(32.3, -16.6, 0.12, 0.68);
  vent(20.8, -24.6, 0.1, 0.55);
  // 大排气帽（砖砌烟道 + 铁帽）
  boxAt(k, M.brickDark, 22.0, EAVE + 0.16 + 0.42, -19.2, 0.62, 0.84, 0.62);
  k.put(cyl(0.46, 0.38, 0.14, 8, M.rustDark).translateX(22.0).translateY(EAVE + 0.16 + 0.9).translateZ(-19.2));
  boxAt(k, M.concreteDark, 22.0, EAVE + 0.2, -19.2, 0.84, 0.1, 0.84);

  // —— 检修上人孔（掀开的盖板 + 黑洞）——
  boxAt(k, M.concreteDark, 19.4, EAVE + 0.28, -28.6, 1.15, 0.26, 1.15);
  const hatchHole = mesh(new THREE.PlaneGeometry(0.92, 0.92), M.pitch);
  hatchHole.rotation.x = -Math.PI / 2;
  hatchHole.position.set(19.4, EAVE + 0.42, -28.6);
  k.put(hatchHole);
  const hatchLid = boxAt(k, M.rustDark, 20.1, EAVE + 0.66, -28.6, 1.0, 0.07, 1.0);
  hatchLid.rotation.z = 1.15;
  k.put(cyl(0.03, 0.03, 0.5, 5, M.steel).translateX(19.9).translateY(EAVE + 0.5).translateZ(-28.6));

  // —— 空调室外机 ×2 ——
  const ac = (ax: number, az: number): void => {
    boxAt(k, M.concreteDark, ax, EAVE + 0.22, az, 1.0, 0.14, 0.62);
    boxAt(k, M.metal, ax, EAVE + 0.56, az, 0.92, 0.6, 0.52);
    const fan = cyl(0.2, 0.2, 0.05, 10, M.steel);
    fan.rotation.x = Math.PI / 2;
    fan.position.set(ax, EAVE + 0.56, az + 0.27);
    k.put(fan);
    boxAt(k, M.rustDark, ax + 0.36, EAVE + 0.5, az - 0.32, 0.1, 0.3, 0.1);
  };
  ac(17.0, -21.6);
  ac(23.4, -16.0);
  ac(29.2, -31.2);

  // —— 檐沟 + 落水口（贴着女儿墙内侧）——
  k.put(wallBox(WEST, 8.5, EAVE + 0.18, -0.52, 16.0, 0.14, 0.22, M.steel));
  k.put(wallBox(SOUTH, 8.6, EAVE + 0.18, -0.52, 16.4, 0.14, 0.22, M.steel));
  for (const u of [2.2, 9.4]) {
    k.put(wallBox(SOUTH, u, EAVE + 0.02, -0.3, 0.3, 0.36, 0.3, M.rustDark));
  }

  // —— 屋面残存瓦垛：tileGeometry 叠出搭接层次（长边搭接 0.12）——
  // 只在屋面完好的一角铺一小片，读得出"这是瓦屋顶"的层次，而不是全平屋顶。
  {
    const tileGeo = tileGeometry(rng);
    const tiles: InstanceTransform[] = [];
    const x0 = 14.4;
    const x1 = 19.6;
    const z0 = -21.6;
    const z1 = -17.4;
    const step = 0.28;
    const along = 0.3;
    let row = 0;
    for (let z = z1; z > z0; z -= along) {
      const off = row % 2 === 0 ? 0 : along / 2;
      for (let x = x0 + off; x < x1; x += step) {
        // 靠近屋檐破口的一排直接跳过（瓦被炸飞了）
        if (x > 18.6 && z < -19.4) continue;
        if (rng.chance(0.12)) continue;
        tiles.push({
          position: new THREE.Vector3(x + rng.range(-0.01, 0.01), EAVE + 0.19 + rng.range(-0.005, 0.005), z + rng.range(-0.01, 0.01)),
          rotation: new THREE.Euler(rng.range(-0.02, 0.02), rng.range(-0.03, 0.03), rng.range(-0.02, 0.02)),
          scale: new THREE.Vector3(1, 1, 1),
        });
      }
      row += 1;
    }
    k.hold(instanced(tileGeo, M.roofRust, tiles));
    // 瓦下的暗色基层（让瓦缝有深度）
    k.put(boxAt(k, M.roofPatch, (x0 + x1) / 2, EAVE + 0.175, (z0 + z1) / 2, x1 - x0, 0.02, z1 - z0));
  }

  // —— 屋面杂物：木板堆、油布、油桶、第二根天线 ——
  for (let i = 0; i < 4; i += 1) {
    const beam = boxAt(k, M.timber, 18.3, EAVE + 0.24 + i * 0.12, -17.3 + i * 0.04, 1.7, 0.1, 0.22);
    beam.rotation.y = rng.range(-0.12, 0.12);
  }
  boxAt(k, M.tarp, 20.6, EAVE + 0.24, -18.6, 1.3, 0.14, 1.0).rotation.y = 0.4;
  k.put(cyl(0.24, 0.24, 0.7, 9, M.rustDark).translateX(17.4).translateY(EAVE + 0.55).translateZ(-19.9));
  k.put(cylinderBetween(new THREE.Vector3(21.6, EAVE + 0.16, -22.4), new THREE.Vector3(21.7, EAVE + 0.9, -22.5), 0.03, M.steel, 4));
  for (let i = 0; i < 3; i += 1) {
    k.put(cylinderBetween(
      new THREE.Vector3(21.6, EAVE + 0.55 + i * 0.14, -22.5),
      new THREE.Vector3(22.1, EAVE + 0.56 + i * 0.14, -22.4),
      0.012,
      M.steel,
      3,
    ));
  }

  // —— 晒衣绳 + 破布（战场里的生活气）——
  const p1 = new THREE.Vector3(14.0, EAVE + 0.16, -17.4);
  const p2 = new THREE.Vector3(14.0, EAVE + 0.16, -22.6);
  k.put(cylinderBetween(p1, new THREE.Vector3(p1.x, EAVE + 1.5, p1.z), 0.04, M.steel, 5));
  k.put(cylinderBetween(p2, new THREE.Vector3(p2.x, EAVE + 1.5, p2.z), 0.04, M.steel, 5));
  const a = new THREE.Vector3(p1.x, EAVE + 1.45, p1.z);
  const b = new THREE.Vector3(p2.x, EAVE + 1.45, p2.z);
  const mid = a.clone().lerp(b, 0.5);
  mid.y -= 0.28;
  k.put(cylinderBetween(a, mid, 0.012, M.steel, 3));
  k.put(cylinderBetween(mid, b, 0.012, M.steel, 3));
  for (const [tz, tw, th] of [[-18.5, 0.6, 0.7], [-20.2, 0.5, 0.55], [-21.4, 0.42, 0.5]] as Array<[number, number, number]>) {
    const rag = mesh(new THREE.PlaneGeometry(tw, th), rng.chance(0.5) ? M.tarp : M.fabric);
    rag.position.set(14.0, EAVE + 1.34, tz);
    rag.rotation.y = Math.PI / 2 + rng.range(-0.2, 0.2);
    rag.rotation.z = rng.range(-0.1, 0.1);
    rag.castShadow = false;
    k.put(rag);
  }

  // —— 靠女儿墙的旧铁梯 ——
  k.put(cylinderBetween(new THREE.Vector3(32.6, EAVE + 0.16, -27.8), new THREE.Vector3(32.1, EAVE + 1.5, -28.9), 0.03, M.rust, 4));
  k.put(cylinderBetween(new THREE.Vector3(32.9, EAVE + 0.16, -28.2), new THREE.Vector3(32.4, EAVE + 1.5, -29.3), 0.03, M.rust, 4));
  for (let i = 0; i < 4; i += 1) {
    const t = i / 4;
    k.put(cylinderBetween(
      new THREE.Vector3(32.6 - t * 0.5, EAVE + 0.4 + t * 1.2, -27.8 - t * 1.1),
      new THREE.Vector3(32.9 - t * 0.5, EAVE + 0.4 + t * 1.2, -28.2 - t * 1.1),
      0.018,
      M.steel,
      3,
    ));
  }

  // —— 第二、三处瓦砾堆 ——
  const rubble2: Array<{ position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }> = [];
  for (const [cx, cz, n] of [[16.2, -29.6, 16], [31.2, -24.4, 14], [20.6, -15.6, 10]] as Array<[number, number, number]>) {
    for (let i = 0; i < n; i += 1) {
      const ang = rng.range(0, Math.PI * 2);
      const rad = Math.sqrt(rng.next()) * 1.3;
      rubble2.push({
        position: new THREE.Vector3(cx + Math.cos(ang) * rad, EAVE + 0.2 + (1 - rad / 1.3) * 0.16, cz + Math.sin(ang) * rad),
        rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 6), rng.range(0, 3)),
        scale: new THREE.Vector3(1, 1, 1).multiplyScalar(rng.range(0.25, 0.8)),
      });
    }
  }
  k.hold(instanced(jitter(new THREE.DodecahedronGeometry(0.26, 0), 0.05, rng), M.roofDebris, rubble2));

  // 弯曲的电视天线（压低，不破坏檐口轮廓）
  const base = new THREE.Vector3(15.8, EAVE + 0.16, -30.4);
  k.put(cylinderBetween(base, new THREE.Vector3(15.9, EAVE + 0.66, -30.6), 0.032, M.steel, 5));
  k.put(cylinderBetween(new THREE.Vector3(15.6, EAVE + 0.56, -30.6), new THREE.Vector3(16.3, EAVE + 0.42, -30.4), 0.018, M.steel, 4));
  for (let i = 0; i < 3; i += 1) {
    k.put(cylinderBetween(
      new THREE.Vector3(15.9, EAVE + 0.3 + i * 0.14, -30.6),
      new THREE.Vector3(16.4, EAVE + 0.32 + i * 0.14, -30.6),
      0.012,
      M.steel,
      3,
    ));
  }
  // 屋顶水箱（生锈，压在女儿墙以下，不破坏檐口轮廓）
  const tank = cyl(0.5, 0.5, 0.36, 10, M.rustDark);
  at(tank, 31.6, EAVE + 0.16 + 0.18, -30.6);
  k.put(tank);
  k.put(cyl(0.53, 0.53, 0.06, 10, M.steel).translateX(31.6).translateY(EAVE + 0.16 + 0.36).translateZ(-30.6));
  for (const [dx, dz] of [[-0.33, -0.33], [0.33, -0.33], [-0.33, 0.33], [0.33, 0.33]] as Array<[number, number]>) {
    boxAt(k, M.steel, 31.6 + dx, EAVE + 0.22, -30.6 + dz, 0.07, 0.1, 0.07);
  }
}

/* ------------------------------------------------------------------ *
 * 瓦砾 / 纸张 / 书 / 罐头：instanced 散布
 * ------------------------------------------------------------------ */

interface Rect2 {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  y: number;
}

function scatter(k: Kit, kind: 'paper' | 'book' | 'can', count: number, r: Rect2): void {
  const M = k.mats;
  const rng = k.rng.fork(kind.length * 13 + count);
  const geo: THREE.BufferGeometry =
    kind === 'paper'
      ? new THREE.PlaneGeometry(0.21, 0.29)
      : kind === 'book'
        ? new THREE.BoxGeometry(0.17, 0.045, 0.23)
        : new THREE.CylinderGeometry(0.045, 0.045, 0.13, 7);
  const mat = kind === 'paper' ? M.paper : kind === 'book' ? M.fabric : M.metal;
  const list: Array<{ position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }> = [];
  for (let i = 0; i < count; i += 1) {
    list.push({
      position: new THREE.Vector3(rng.range(r.x0, r.x1), r.y + rng.range(0, 0.04), rng.range(r.z0, r.z1)),
      rotation:
        kind === 'can'
          ? new THREE.Euler(Math.PI / 2, rng.range(0, 6), 0)
          : new THREE.Euler(-Math.PI / 2 + rng.range(-0.1, 0.1), rng.range(0, 6), rng.range(-0.2, 0.2)),
      scale: new THREE.Vector3(1, 1, 1).multiplyScalar(rng.range(0.75, 1.25)),
    });
  }
  k.hold(instanced(geo, mat, list));
}

/** 地面与楼梯间的瓦砾堆 */
function buildDebris(k: Kit): void {
  const M = k.mats;
  const rng = k.rng.fork(909);
  const spots: Rect2[] = [
    { x0: 22.5, x1: 25.9, z0: -16.4, z1: -14.2, y: GF + 0.05 }, // 南窗破口内外
    { x0: 26.6, x1: 29.4, z0: -16.2, z1: -13.6, y: GF + 0.05 }, // 南立面炸弹破洞
    { x0: 13.2, x1: 20.0, z0: -24.2, z1: -24.0, y: 0.12 }, // 门外碎渣
    { x0: 16.0, x1: 22.0, z0: -32.8, z1: -25.4, y: GF + 0.05 }, // 北侧储藏塌落
    { x0: 29.2, x1: 33.2, z0: -22.6, z1: -14.2, y: GF + 0.05 }, // 楼梯间
  ];
  const concrete: Array<{ position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }> = [];
  const brick: Array<{ position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }> = [];
  spots.forEach((s, si) => {
    const n = 12 + si * 3;
    for (let i = 0; i < n; i += 1) {
      const t = {
        position: new THREE.Vector3(rng.range(s.x0, s.x1), s.y + rng.range(0, 0.12), rng.range(s.z0, s.z1)),
        rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 6), rng.range(0, 3)),
        scale: new THREE.Vector3(1, 1, 1).multiplyScalar(rng.range(0.25, 0.85)),
      };
      if (i % 3 === 0) brick.push(t);
      else concrete.push(t);
    }
  });
  // 商铺内零散的砖屑（在南窗破口附近更密，呼应 HOTSPOTS.southWindowBreak）
  for (let i = 0; i < 26; i += 1) {
    brick.push({
      position: new THREE.Vector3(
        HOTSPOTS.southWindowBreak.x + rng.range(-1.8, 1.8),
        GF + 0.06,
        HOTSPOTS.southWindowBreak.z + rng.range(-1.4, 1.4),
      ),
      rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 6), rng.range(0, 3)),
      scale: new THREE.Vector3(1, 1, 1).multiplyScalar(rng.range(0.25, 0.7)),
    });
  }
  k.hold(instanced(jitter(new THREE.DodecahedronGeometry(0.26, 0), 0.05, rng), M.concreteDark, concrete));
  k.hold(instanced(jitter(new THREE.BoxGeometry(0.3, 0.16, 0.2), 0.04, rng), M.brick, brick));

  // 商铺地面杂物：罐头、瓶子（instanced）
  scatter(k, 'can', 24, { x0: 13.2, x1: 21.6, z0: -22.4, z1: -14.2, y: GF + 0.05 });
}

/** 应急灯（墙上的小灯罩 + 微光） */
function emergencyLamp(k: Kit, x: number, y: number, z: number, rotY: number): void {
  const M = k.mats;
  boxAt(k, M.steel, x, y, z, 0.3, 0.2, 0.12, rotY);
  const glass = mesh(new THREE.PlaneGeometry(0.22, 0.13), M.glowWarm);
  glass.position.set(x + Math.sin(rotY + Math.PI / 2) * 0.07, y, z + Math.cos(rotY + Math.PI / 2) * 0.07);
  glass.rotation.y = rotY + Math.PI / 2;
  glass.castShadow = false;
  k.put(glass);
  boxAt(k, M.rust, x, y + 0.16, z, 0.1, 0.12, 0.1, rotY);
}

/** 蜡烛（小暖光源的视觉来源） */
function candle(k: Kit, x: number, y: number, z: number): void {
  const M = k.mats;
  k.put(cyl(0.28, 0.24, 0.05, 9, M.metal).translateX(x).translateY(y + 0.03).translateZ(z));
  k.put(cyl(0.035, 0.045, 0.18, 6, M.paper).translateX(x).translateY(y + 0.14).translateZ(z));
  const flame = mesh(new THREE.PlaneGeometry(0.07, 0.13), M.glowEmber);
  flame.position.set(x, y + 0.3, z);
  flame.castShadow = false;
  k.put(flame);
  // 十字形的另一片，保证从任意角度看都是亮的
  const flame2 = mesh(new THREE.PlaneGeometry(0.07, 0.13), M.glowEmber);
  flame2.position.set(x, y + 0.3, z);
  flame2.rotation.y = Math.PI / 2;
  flame2.castShadow = false;
  k.put(flame2);
}

/* ------------------------------------------------------------------ *
 * 室内暖光（3 盏，带呼吸/闪烁）
 * ------------------------------------------------------------------ */

interface LampSpec {
  x: number;
  y: number;
  z: number;
  color: number;
  intensity: number;
  distance: number;
  phase: number;
}

function buildLights(ctx: BuildContext): void {
  const specs: LampSpec[] = [
    // 商铺灶台（HOTSPOTS.shopInterior）——主妇做饭的火光
    { x: HOTSPOTS.shopInterior.x + 0.15, y: GF + 0.75, z: HOTSPOTS.shopInterior.z + 0.15, color: 0xffb765, intensity: 13, distance: 9.5, phase: 0.0 },
    // 二层前室：桌上的蜡烛
    { x: 19.4, y: F1Y + 1.35, z: -18.9, color: 0xffa860, intensity: 7, distance: 7.5, phase: 1.9 },
    // 三层避难角：应急灯
    { x: 15.2, y: F2Y + 1.1, z: -19.4, color: 0xffc07a, intensity: 6, distance: 7.0, phase: 3.4 },
  ];
  const lights: THREE.PointLight[] = [];
  for (const s of specs) {
    const l = new THREE.PointLight(s.color, s.intensity, s.distance, 2);
    l.position.set(s.x, s.y, s.z);
    ctx.addLight(l);
    lights.push(l);
  }
  ctx.ticker.add((t) => {
    for (let i = 0; i < lights.length; i += 1) {
      const s = specs[i] as LampSpec;
      const l = lights[i] as THREE.PointLight;
      // 双频呼吸 + 少量抖动，避免死板
      const n =
        0.86 +
        0.14 * Math.sin(t * (1.7 + i * 0.45) + s.phase) +
        0.05 * Math.sin(t * (9.3 + i * 2.1) + s.phase * 2.7);
      l.intensity = s.intensity * n;
    }
  });
}

/* ------------------------------------------------------------------ *
 * 组装
 * ------------------------------------------------------------------ */

/** 按材质合并所有静态网格，得到极少 draw call */
function flush(k: Kit, root: THREE.Group): Map<THREE.Material, THREE.Mesh> {
  const out = new Map<THREE.Material, THREE.Mesh>();
  let n = 0;
  k.bins.forEach((meshes, mat) => {
    const hasIndexed = meshes.some((m) => !!m.geometry.index);
    const hasPlain = meshes.some((m) => !m.geometry.index);
    const list =
      hasIndexed && hasPlain
        ? meshes.map((m) => {
            if (!m.geometry.index) return m;
            const c = new THREE.Mesh(m.geometry.toNonIndexed(), mat);
            c.position.copy(m.position);
            c.quaternion.copy(m.quaternion);
            c.scale.copy(m.scale);
            return c;
          })
        : meshes;
    const merged = mergeMeshes(list, mat);
    if (!merged) return;
    n += 1;
    merged.name = `hero-part-${n}`;
    if (mat.transparent) merged.castShadow = false;
    out.set(mat, merged);
    root.add(merged);
  });
  return out;
}

function applyOutlines(k: Kit, merged: Map<THREE.Material, THREE.Mesh>): void {
  const targets: THREE.Material[] = [k.mats.plaster, k.mats.plasterWarm, k.mats.concrete, k.mats.roof, k.mats.woodDark];
  for (const mat of targets) {
    const m = merged.get(mat);
    if (m) withOutline(m, 0.0018);
  }
}

export function buildHeroBuilding(ctx: BuildContext): THREE.Group {
  const root = group('hero-building');
  const rng = ctx.rng.fork(0x4a1c);
  const mats = makeMats();

  const bins = new Map<THREE.Material, THREE.Mesh[]>();
  const extras: THREE.Object3D[] = [];
  const k: Kit = {
    mats,
    rng,
    bins,
    extras,
    brickInst: [],
    chipInst: [],
    put(m) {
      const mat = m.material as THREE.Material;
      const list = bins.get(mat);
      if (list) list.push(m);
      else bins.set(mat, [m]);
      return m;
    },
    hold(o) {
      extras.push(o);
    },
  };

  buildShell(k);
  buildFacadeDressing(k);
  buildWindowInteriors(k);
  buildGroundFloor(k);
  buildFloorOne(k);
  buildFloorTwo(k);
  buildRoof(k);
  buildDebris(k);

  // 外露砖芯：全楼合并成 1 个 instanced draw call（不描边，靠明度分层）
  if (k.brickInst.length > 0) {
    const bg = brickGeometry(rng.fork(4242));
    k.hold(instanced(bg, mats.brickDark, k.brickInst));
  }

  const merged = flush(k, root);
  applyOutlines(k, merged);
  for (const o of extras) root.add(o);

  // 室内暖光（总数 3，含呼吸闪烁）
  buildLights(ctx);

  return root;
}
