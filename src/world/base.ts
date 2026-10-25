import * as THREE from 'three';
import { PALETTE } from '../core/palette';
import { basicMaterial, toonMaterial, canvasTexture } from '../core/materials';
import {
  addBatch,
  at,
  box,
  cyl,
  groundRect,
  group,
  instanced,
  jitter,
  mesh,
  softBox,
  torus,
  type InstanceTransform,
} from '../core/geo';
import type { BuildContext } from '../core/context';
import type { Rng } from '../core/rng';
import {
  BASE,
  JUNCTIONS,
  RAIL,
  ROADS,
  ROAD,
  carriageway,
  groundYAt,
  isOnCarriageway,
  isOnRoadCorridor,
  type Road,
} from './layout';

/**
 * 底座与地面：展示台般的方形底座 + 湿冷街区路网。
 *
 * 一切几何都从 layout 的 ROADS / RAIL 推导：
 *  - 路面按车道矩形铺设，路口由主管压住支管，不出现接缝
 *  - 路缘与人行道在每个路口**自动断开**（把交叉道路的走廊区间从线段里减掉）
 *  - 斑马线、中心虚线、停止线同样按路口区间避让
 * 这样再加一条路只会多一行数据，不会漏掉某处的路缘。
 *
 * 性能策略：所有标线、分缝、排水格栅、井盖、污渍、积水按材质合并成单一网格，
 * 枕木与瓦砾走实例化。
 */

/**
 * 真实沥青 PBR 贴图（Poly Haven · asphalt_02 · CC0）。
 *
 * 原先是程序化噪声当 roughnessMap：只能表达"哪一块更湿"，表达不了骨料、裂缝、
 * 车辙这些让湿路面读起来像沥青的细节。现在 albedo / normal / roughness 三张
 * 1K 贴图都放在 public/textures/asphalt/，运行时不再依赖外网。
 *
 * 贴图 URL 走 BASE_URL：vite 的 base 是 './'，写死 '/textures/...' 在子路径部署时会 404。
 */
const TEX_BASE = `${import.meta.env.BASE_URL}textures/asphalt/`;

function loadAsphaltTex(file: string, srgb: boolean): THREE.Texture {
  const tex = new THREE.TextureLoader().load(`${TEX_BASE}${file}`);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/**
 * 一张贴图对应的世界尺寸（米）。
 * 注意：路面不是 repeat.set(10,10) —— PlaneGeometry 的 UV 恒为 0..1，
 * 直接设 repeat=10 会让 288 m 长的路段每张贴图拉到 28.8 m、而横向只有 1.5 m。
 * 所以建面时按世界尺寸展开 UV（见 buildRoads），材质里的 repeat 保持 1：
 * 同样是"约 10 次"的密度（40 m 街段铺 10 次），但横纵一致、所有路段物理密度相同。
 */
const ASPHALT_TILE = 4;

const wetAsphalt = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  map: loadAsphaltTex('asphalt_02_diff_1k.jpg', true),
  normalMap: loadAsphaltTex('asphalt_02_nor_gl_1k.jpg', false),
  normalScale: new THREE.Vector2(0.6, 0.6),
  roughnessMap: loadAsphaltTex('asphalt_02_rough_1k.jpg', false),
  // 与 roughnessMap（均值 0.77）相乘：夜里 0.55 → 等效约 0.42，白天 0.95 → 约 0.73
  roughness: 0.55,
  metalness: 0,
});

/** 街区之间的泥地/碎砖地：不是沥青，避免整个底座像一张停车坪 */
const dirtGround = new THREE.MeshStandardMaterial({
  color: PALETTE.dirt,
  roughness: 0.96,
  metalness: 0,
  map: groundNoiseTexture(),
});

// 积水：与马路刻意拉开——粗糙度 0.06 的镜面级水面，只留给灯与火做倒影
const puddleMaterial = new THREE.MeshStandardMaterial({
  color: 0x0b1016,
  roughness: 0.06,
  metalness: 0,
  transparent: true,
  opacity: 0.92,
});

/** 8 m 一格的泥地噪声贴图（重复铺设，边缘由压暗片负责） */
function groundNoiseTexture(): THREE.Texture {
  const tex = canvasTexture(256, 256, (c, w, h) => {
    c.fillStyle = '#4a4437';
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i += 1) {
      const x = (i * 977) % w;
      const y = (i * 613) % h;
      const r = 2 + ((i * 31) % 14);
      const dark = i % 3 === 0;
      c.globalAlpha = dark ? 0.16 : 0.09;
      c.fillStyle = dark ? '#2b2a22' : '#5d5647';
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;
  });
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(BASE.size / 8, BASE.size / 8);
  return tex;
}

/* ------------------------------------------------------------------ *
 * 线段代数：把路口的走廊区间从一条路里减掉
 * ------------------------------------------------------------------ */

type Span = [number, number];

/** 与这条路相交的其它路，在自身轴向上占用的区间（路缘/人行道必须在这里断开） */
function crossingSpans(r: Road, extra = 0.25): Span[] {
  const out: Span[] = [];
  for (const other of ROADS) {
    if (other.id === r.id || other.axis === r.axis) continue;
    if (other.from <= r.at + 0.01 && other.to >= r.at - 0.01) {
      const half = other.half + other.walk + extra;
      out.push([other.at - half, other.at + half]);
    }
  }
  return out;
}

/** 某一条人行道要断开的区间：支路只在它实际存在的那一侧断，丁字路口对侧不断 */
function crossingSpansForSide(r: Road, side: -1 | 1, extra = 0.25): Span[] {
  const out: Span[] = [];
  const sideCenter = r.at + side * (r.half + r.walk / 2);
  for (const other of ROADS) {
    if (other.id === r.id || other.axis === r.axis) continue;
    if (other.from > r.at + 0.01 || other.to < r.at - 0.01) continue;
    if (sideCenter < other.from - 0.01 || sideCenter > other.to + 0.01) continue;
    const half = other.half + other.walk + extra;
    out.push([other.at - half, other.at + half]);
  }
  return out;
}

/** 同级路口谁压谁：等级 > 路幅宽 > 东西向；保证同一位置只有一层路面 */
function roadLayer(r: Road): number {
  const rank = r.class === 'main' ? 2 : r.class === 'ring' ? 1 : 0;
  return rank * 100 + r.half + (r.axis === 'x' ? 0.5 : 0);
}

/** 低层路面要让开的区间：高层道路的车行道。两层都在同级高度时，共面 = 深度闪烁 */
function coveredSpans(r: Road): Span[] {
  return ROADS.filter(
    (o) =>
      o.id !== r.id &&
      o.axis !== r.axis &&
      roadLayer(o) > roadLayer(r) &&
      o.from <= r.at + 0.01 &&
      o.to >= r.at - 0.01,
  ).map((o) => [o.at - o.half, o.at + o.half] as Span);
}

/**
 * 斑马线带宽：取被横穿道路的人行道净宽（再收 0.6 m）。
 * 两条平行路之间的一条斑马线，宽度就应该是"人走的那条人行道"的宽度，
 * 而不是拍脑袋的一小段。
 */
function crosswalkWidth(r: Road): number {
  return THREE.MathUtils.clamp(r.walk - 0.6, 2.6, 4.2);
}

/** 与该路口相交的所有道路：包含在此终止的支路（T 字路口的三条腿都要有斑马线） */
function roadsAtJunction(j: { x: number; z: number }): Road[] {
  return ROADS.filter((r) => {
    if (r.axis === 'x') {
      return Math.abs(j.z - r.at) < 0.01 && j.x >= r.from - 0.5 && j.x <= r.to + 0.5;
    }
    return Math.abs(j.x - r.at) < 0.01 && j.z >= r.from - 0.5 && j.z <= r.to + 0.5;
  });
}

/** 中心虚线要避开的范围：路口 + 两侧斑马线整段（虚线不能穿斑马线） */
function junctionBoxes(r: Road): Span[] {
  const out: Span[] = [];
  for (const other of ROADS) {
    if (other.id === r.id || other.axis === r.axis) continue;
    if (other.from <= r.at + 0.01 && other.to >= r.at - 0.01) {
      // 斑马线已对齐到人行道中线，断口只需要让出对方人行道再加一点余量
      const half = other.half + other.walk + 0.4;
      out.push([other.at - half, other.at + half]);
    }
  }
  return out;
}

function subtract(src: Span[], cuts: Span[]): Span[] {
  let list = src;
  for (const [c0, c1] of cuts) {
    list = list.flatMap(([a, b]) => {
      if (c1 <= a + 0.8 || c0 >= b - 0.8) return [[a, b]];
      const out: Span[] = [];
      if (c0 - a > 1.2) out.push([a, c0]);
      if (b - c1 > 1.2) out.push([c1, b]);
      return out;
    });
  }
  return list.filter(([a, b]) => b - a > 1.2);
}

/** 沿路方向把 [from,to] 切成若干段（去掉路口区间），返回中点与长度 */
function roadSegments(r: Road, extra = 0.25): Array<{ mid: number; len: number }> {
  return subtract([[r.from, r.to]], crossingSpans(r, extra)).map(([a, b]) => ({
    mid: (a + b) / 2,
    len: b - a,
  }));
}

/** 该点属于哪条路的路面高度（由 layout.groundYAt 统一给出） */

/* ------------------------------------------------------------------ *
 * 主体
 * ------------------------------------------------------------------ */

/** 交给昼夜循环调色的湿地材质 */
export function wetMaterials(): {
  asphalt: THREE.MeshStandardMaterial;
  puddle: THREE.MeshStandardMaterial;
  dirt: THREE.MeshStandardMaterial;
} {
  return { asphalt: wetAsphalt, puddle: puddleMaterial, dirt: dirtGround };
}

/**
 * 全图积水位置（buildGroundLitter 填充，车队与湿反光据此碾压水面）。
 * 顺序：x, z, 宽, 长。
 */
export const PUDDLES: Array<[number, number, number, number]> = [];

export function buildBase(ctx: BuildContext): THREE.Group {
  const { rng } = ctx;
  const base = group('base');

  buildPlinth(base);
  buildGround(base);
  buildRoads(base);
  buildRailway(base, rng);
  buildEdgeMask(base);
  buildGroundLitter(base, rng);

  return base;
}

/* ---------------------------- 展台底座 ---------------------------- */

function buildPlinth(base: THREE.Group): void {
  // 主台：仍是一整块方台
  const plinth = softBox(BASE.size + 3, BASE.plinth, BASE.size + 3, 1.4, toonMaterial(0x252c35, { steps: 2 }));
  plinth.position.y = -BASE.plinth / 2;
  plinth.name = 'base-plinth';
  base.add(plinth);

  // 第二级切面：底座外面再垫一层更大的薄台，形成"地台边缘"的两级台阶
  const skirt = softBox(BASE.size + 16, 1.7, BASE.size + 16, 1.1, toonMaterial(0x1b222a, { steps: 2 }));
  skirt.position.y = -BASE.plinth - 0.85;
  skirt.name = 'base-skirt';
  skirt.castShadow = false;
  base.add(skirt);

  // 上沿浅色压边：让正方形轮廓在暗背景里读得出来
  const edgeMat = toonMaterial(0x5a626b, { steps: 2 });
  const frameInset = BASE.size / 2 + 1.5;
  for (const [rx, rz, rw, rd] of [
    [0, -frameInset, BASE.size + 3.2, 3.0],
    [0, frameInset, BASE.size + 3.2, 3.0],
    [-frameInset, 0, 3.0, BASE.size + 3.2],
    [frameInset, 0, 3.0, BASE.size + 3.2],
  ] as Array<[number, number, number, number]>) {
    const strip = box(rw, 0.12, rd, edgeMat);
    at(strip, rx, 0.06, rz);
    strip.castShadow = false;
    base.add(strip);
  }

  // 切面斜边：四圈朝外倾斜的窄带，强化"模型放在台子上"的读法
  const bevelMat = toonMaterial(0x2f3842, { steps: 2 });
  const bevel = BASE.size / 2 + 1.5;
  for (const [dx, dz, rot] of [
    [0, -bevel, 0],
    [0, bevel, Math.PI],
    [-bevel, 0, Math.PI / 2],
    [bevel, 0, -Math.PI / 2],
  ] as Array<[number, number, number]>) {
    const panel = mesh(new THREE.PlaneGeometry(BASE.size + 3, 2.6), bevelMat);
    panel.rotation.x = -Math.PI / 4;
    panel.rotation.z = rot;
    panel.position.set(dx, -1.1, dz);
    panel.castShadow = false;
    panel.receiveShadow = false;
    panel.name = 'base-bevel';
    base.add(panel);
  }

  // 底座下方的柔光台面：把模型从纯黑里"托"起来
  const poolTex = canvasTexture(256, 256, (c, w, h) => {
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(120,150,180,0.55)');
    g.addColorStop(0.42, 'rgba(70,92,116,0.28)');
    g.addColorStop(0.75, 'rgba(30,42,56,0.10)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  });
  const pool = mesh(
    new THREE.PlaneGeometry(420, 420),
    new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, depthWrite: false, fog: false, toneMapped: false }),
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(0, -BASE.plinth - 1.9, 0);
  pool.renderOrder = -2;
  pool.castShadow = false;
  pool.receiveShadow = false;
  base.add(pool);

  // 台沿压条
  const rimMat = toonMaterial(0x232b33, { steps: 2 });
  const rimInset = BASE.size / 2 + 0.6;
  const rimGroup: THREE.Mesh[] = [];
  for (const [rx, rz, rw, rd] of [
    [0, -rimInset, BASE.size + 1.6, 1.2],
    [0, rimInset, BASE.size + 1.6, 1.2],
    [-rimInset, 0, 1.2, BASE.size + 1.6],
    [rimInset, 0, 1.2, BASE.size + 1.6],
  ] as Array<[number, number, number, number]>) {
    const bar = box(rw, 0.5, rd, rimMat);
    at(bar, rx, -0.05, rz);
    rimGroup.push(bar);
  }
  addBatch(base, rimGroup, rimMat, 'base-rim');
}

/* ---------------------------- 地面 ---------------------------- */

function buildGround(base: THREE.Group): void {
  const ground = groundRect(BASE.size, BASE.size, dirtGround);
  ground.position.y = 0.02;
  ground.name = 'base-ground';
  base.add(ground);
}

/* ---------------------------- 路网 ---------------------------- */

function buildRoads(base: THREE.Group): void {
  const walkMat = toonMaterial(PALETTE.sidewalk, { steps: 3 });
  const walkAltMat = toonMaterial(PALETTE.sidewalkAlt, { steps: 3 });
  const curbMat = toonMaterial(PALETTE.curb, { steps: 3 });
  // 路面标线：做旧的暖白。旧值 0x63605a 在换过浅色沥青贴图后比路面还暗，
  // 斑马线看起来像一排黑色缺口，完全读不出"白色人行横道"。
  const paintMat = toonMaterial(0xb8b3a6, { steps: 2, emissive: 0x07090b });
  const dashMat = toonMaterial(0xa9a48f, { steps: 2 });
  const seamMat = basicMaterial(0x3a3d42, { opacity: 0.55, fog: true });
  const curbH = ROAD.curbHeight;

  const walkMain: THREE.Mesh[] = [];
  const walkAlt: THREE.Mesh[] = [];
  const curbMeshes: THREE.Mesh[] = [];
  const seams: THREE.Mesh[] = [];
  const paint: THREE.Mesh[] = [];
  const dashes: THREE.Mesh[] = [];

  for (const r of ROADS) {
    // —— 车行道 ——
    // 低等级/窄路在路口处让开高层道路的车行道，路口只有一层路面。
    // 以前两条同级路（如大道 × 纵街、四条环道相交处）各铺一块共面长方形，
    // 深度值相等 → 整块中心区随镜头闪烁。
    const y = r.class === 'main' ? 0.07 : r.class === 'ring' ? 0.062 : 0.056;
    const cw = carriageway(r);
    const across = r.axis === 'x' ? cw.z1 - cw.z0 : cw.x1 - cw.x0;
    for (const [a, b] of subtract([[r.from, r.to]], coveredSpans(r))) {
      const len = b - a;
      if (len < 0.6) continue;
      const slab =
        r.axis === 'x'
          ? groundRect(len, across, wetAsphalt)
          : groundRect(across, len, wetAsphalt);
      // 按世界尺寸展开 UV（4 m 一块），并按段起点偏移，让断开后的花纹仍然连续
      {
        const uv = slab.geometry.getAttribute('uv') as THREE.BufferAttribute;
        const su = (r.axis === 'x' ? len : across) / ASPHALT_TILE;
        const sv = (r.axis === 'x' ? across : len) / ASPHALT_TILE;
        const uOff = r.axis === 'x' ? (a - r.from) / ASPHALT_TILE : 0;
        const vOff = r.axis === 'z' ? (r.to - b) / ASPHALT_TILE : 0;
        for (let i = 0; i < uv.count; i += 1) {
          uv.setXY(i, uv.getX(i) * su + uOff, uv.getY(i) * sv + vOff);
        }
        uv.needsUpdate = true;
      }
      if (r.axis === 'x') at(slab, (a + b) / 2, y, r.at);
      else at(slab, r.at, y, (a + b) / 2);
      slab.name = `road-${r.id}`;
      base.add(slab);
    }

    // —— 人行道 + 路缘：按路口断开（丁字路口只断支路真正存在的那一侧）——
    const mat = r.axis === 'x' ? walkMat : walkAltMat;
    for (const side of [-1, 1] as const) {
      const walkCenter = side * (r.half + r.walk / 2);
      const curbAt = side * (r.half + 0.15);
      const segs = subtract([[r.from, r.to]], crossingSpansForSide(r, side)).map(([a, b]) => ({
        mid: (a + b) / 2,
        len: b - a,
      }));
      for (const { mid, len } of segs) {
        // 人行道板
        const slabBox =
          r.axis === 'x'
            ? box(len, curbH, r.walk, mat)
            : box(r.walk, curbH, len, mat);
        const wx = r.axis === 'x' ? mid : curbSign(r, walkCenter);
        const wz = r.axis === 'x' ? curbSign(r, walkCenter) : mid;
        at(slabBox, wx, curbH / 2, wz);
        slabBox.receiveShadow = true;
        slabBox.castShadow = false;
        (mat === walkMat ? walkMain : walkAlt).push(slabBox);

        // 路缘石
        const curb = r.axis === 'x' ? box(len, curbH + 0.04, 0.35, curbMat) : box(0.35, curbH + 0.04, len, curbMat);
        at(curb, r.axis === 'x' ? mid : curbSign(r, curbAt), (curbH + 0.04) / 2, r.axis === 'x' ? curbSign(r, curbAt) : mid);
        curb.castShadow = false;
        curbMeshes.push(curb);

        // 人行道分缝（4.6 m 一道，让尺度可读；远景段省略）
        if (Math.abs(mid) > 100) continue;
        const pitch = 4.6;
        const n = Math.floor(len / pitch);
        for (let i = 0; i <= n; i += 1) {
          const t = mid - len / 2 + i * pitch;
          const s = mesh(new THREE.PlaneGeometry(0.06, 1), seamMat);
          s.rotation.x = -Math.PI / 2;
          s.scale.set(1, r.walk, 1);
          if (r.axis === 'x') at(s, t, curbH + 0.006, curbSign(r, walkCenter));
          else {
            at(s, curbSign(r, walkCenter), curbH + 0.006, t);
            s.rotation.z = Math.PI / 2;
            s.scale.set(1, r.walk, 1);
          }
          s.castShadow = false;
          seams.push(s);
        }
      }
    }

    // —— 路口四角：两条人行道本来就是 L 形相接，之前两边都在对方走廊处断开，
  // 四个角各留一块方形黑洞。这里把角块和两段路缘补回来。 ——
  for (const j of JUNCTIONS) {
    const legs = roadsAtJunction(j);
    const xr = legs.find((r) => r.axis === 'x');
    const zr = legs.find((r) => r.axis === 'z');
    if (!xr || !zr) continue;
    for (const s of [-1, 1] as const) {
      for (const t of [-1, 1] as const) {
        // 角块的 z 取 x 向道路的人行道带，x 取 z 向道路的人行道带
        const cz = xr.at + s * (xr.half + xr.walk / 2);
        const cx = zr.at + t * (zr.half + zr.walk / 2);
        // 支路只伸到路口一侧时，只补它实际存在的那侧
        if (cz < zr.from || cz > zr.to) continue;
        if (cx < xr.from || cx > xr.to) continue;

        const wx = zr.walk + 0.25;
        const wz = xr.walk + 0.25;
        const px = cx + t * 0.125;
        const pz = cz + s * 0.125;

        const corner = box(wx, curbH, wz, walkMat);
        at(corner, px, curbH / 2, pz);
        corner.receiveShadow = true;
        corner.castShadow = false;
        walkMain.push(corner);

        // x 向路缘：盖住角块靠车行道的一边，同时形成转角处的那段横缘
        const curbX = box(wx, curbH + 0.04, 0.35, curbMat);
        at(curbX, px, (curbH + 0.04) / 2, xr.at + s * (xr.half + 0.15));
        curbX.castShadow = false;
        curbMeshes.push(curbX);

        // z 向路缘：从 x 向路缘的外侧接着铺，避免两块石顶面重叠闪烁
        const zInner = xr.at + s * (xr.half + 0.325);
        const zOuter = xr.at + s * (xr.half + xr.walk + 0.25);
        if (Math.abs(zOuter - zInner) > 0.05) {
          const curbZ = box(0.35, curbH + 0.04, Math.abs(zOuter - zInner), curbMat);
          at(curbZ, zr.at + t * (zr.half + 0.15), (curbH + 0.04) / 2, (zInner + zOuter) / 2);
          curbZ.castShadow = false;
          curbMeshes.push(curbZ);
        }
      }
    }
  }

  // —— 中心虚线：跳过每个路口 ——
    const dashCuts = junctionBoxes(r);
    for (const [a, b] of subtract([[r.from, r.to]], dashCuts)) {
      const n = Math.floor((b - a) / 6);
      for (let i = 0; i < n; i += 1) {
        const t = a + 3 + i * 6;
        const dash = r.axis === 'x' ? groundRect(2.6, 0.24, dashMat) : groundRect(0.22, 2.6, dashMat);
        if (r.axis === 'x') at(dash, t, y + 0.026, r.at);
        else at(dash, r.at, y + 0.026, t);
        dashes.push(dash);
      }
    }
  }

  // —— 斑马线与停止线：每条路在每个路口的两侧各一道 ——
  // 斑马条的长边必须平行于行车方向：横穿一条东西向的路时，
  // 人踩着的是一根根东西向的横条（像梯子的横档），而不是顺着走路方向的长条。
  for (const j of JUNCTIONS) {
    const here = roadsAtJunction(j);
    if (here.length < 2) continue;

    for (const r of here) {
      const other = here.find((o) => o.id !== r.id);
      if (!other) continue;
      const band = crosswalkWidth(other);
      const y = roadSurfaceY(r) + 0.03;
      // 条宽 0.5、缝 0.7（GB 5768 的粗实线间距量级）；两侧各留 0.8 m 不糊到路缘
      const stripeW = 0.5;
      const pitch = 1.2;
      const count = Math.max(3, Math.floor((r.half * 2 - 1.6 - stripeW) / pitch) + 1);
      const start = r.at - ((count - 1) * pitch + stripeW) / 2 + stripeW / 2;

      for (const dir of [-1, 1] as const) {
        // 对齐被横穿道路的人行道中线：转角补平以后，人从人行道直着走上斑马线
        const center = (r.axis === 'x' ? j.x : j.z) + dir * (other.half + other.walk / 2);
        if (center - band / 2 < r.from + 0.4 || center + band / 2 > r.to - 0.4) continue;

        for (let i = 0; i < count; i += 1) {
          const across = start + i * pitch;
          const stripe =
            r.axis === 'x'
              ? groundRect(band, stripeW, paintMat)
              : groundRect(stripeW, band, paintMat);
          if (r.axis === 'x') at(stripe, center, y, across);
          else at(stripe, across, y, center);
          paint.push(stripe);
        }

        // 停止线只画在斑马线的"来车侧"：另一侧的车流是刚驶出路口，不需要停。
        // 线长铺满来车方向那半幅车道（靠右行驶：东行占南半、南行占西半）。
        const approach = -dir;
        const right = r.axis === 'x' ? approach : -approach;
        const stopCenter = center + dir * (band / 2 + 1.6);
        if (stopCenter < r.from + 0.4 || stopCenter > r.to - 0.4) continue;
        const len = r.half - 0.8;
        const lateral = right * (0.2 + len / 2);
        const stop =
          r.axis === 'x'
            ? groundRect(0.4, len, paintMat)
            : groundRect(len, 0.4, paintMat);
        if (r.axis === 'x') at(stop, stopCenter, y - 0.004, r.at + lateral);
        else at(stop, r.at + lateral, y - 0.004, stopCenter);
        paint.push(stop);
      }
    }
  }

  addBatch(base, walkMain, walkMat, 'sidewalk-main');
  addBatch(base, walkAlt, walkAltMat, 'sidewalk-cross');
  addBatch(base, curbMeshes, curbMat, 'curbs');
  const seamBatch = addBatch(base, seams, seamMat, 'sidewalk-seams');
  if (seamBatch) seamBatch.castShadow = false;
  addBatch(base, paint, paintMat, 'road-markings');
  addBatch(base, dashes, dashMat, 'road-dashes');
}

/** 路中心线在垂直方向上的坐标（side 为 ±横向偏移） */
function curbSign(r: Road, offset: number): number {
  return r.at + offset;
}

function roadSurfaceY(r: Road): number {
  return r.class === 'main' ? 0.07 : r.class === 'ring' ? 0.062 : 0.056;
}

/* ---------------------------- 铁路 ---------------------------- */

function buildRailway(base: THREE.Group, rng: Rng): void {
  const rail = group('railway');
  const ballastMat = toonMaterial(0x3b3a3a, { steps: 2 });
  const sleeperMat = toonMaterial(0x33302a, { steps: 2 });
  const steelMat = new THREE.MeshPhongMaterial({ color: 0x4a4f57, specular: 0x6f7f8c, shininess: 48 });
  const rustSteel = new THREE.MeshPhongMaterial({ color: 0x5a3f2e, specular: 0x6a4a34, shininess: 30 });
  const weedMat = toonMaterial(0x2c3428, { steps: 2 });

  const x = RAIL.at;
  const z0 = RAIL.from;
  const z1 = RAIL.to;
  const len = z1 - z0;

  // 道砟带：微微隆起的两条 shoulder（不是贴片）
  const ballast = box(7.2, 0.16, len, ballastMat);
  at(ballast, x, 0.06, (z0 + z1) / 2);
  ballast.receiveShadow = true;
  ballast.castShadow = false;
  ballast.name = 'rail-ballast';
  rail.add(ballast);

  // 枕木：每 0.62 m 一根，实例化
  const sleeperGeo = new THREE.BoxGeometry(2.9, 0.12, 0.24);
  const sleepers: InstanceTransform[] = [];
  for (let z = z0 + 0.4; z < z1; z += 0.62) {
    sleepers.push({
      position: new THREE.Vector3(x, 0.16, z + rng.range(-0.03, 0.03)),
      rotation: new THREE.Euler(0, rng.range(-0.012, 0.012), 0),
      scale: new THREE.Vector3(1, 1, 1),
    });
  }
  const sleeperInst = instanced(sleeperGeo, sleeperMat, sleepers);
  sleeperInst.name = 'rail-sleepers';
  sleeperInst.castShadow = false;
  rail.add(sleeperInst);

  // 钢轨：两条 + 锈蚀的轨头
  for (const s of [-1, 1] as const) {
    const web = box(0.1, 0.14, len, steelMat);
    at(web, x + (s * RAIL.gauge) / 2, 0.27, (z0 + z1) / 2);
    web.castShadow = false;
    rail.add(web);
    const head = box(0.16, 0.05, len, rustSteel);
    at(head, x + (s * RAIL.gauge) / 2, 0.35, (z0 + z1) / 2);
    head.castShadow = false;
    rail.add(head);
  }

  // 道砟间的杂草：废弃线路长草的证据（实例化，一次 draw call）
  const tuft = new THREE.ConeGeometry(0.14, 0.5, 4);
  const weeds: InstanceTransform[] = [];
  for (let z = z0 + 1; z < z1; z += 1.1) {
    if (!rng.chance(0.62)) continue;
    weeds.push({
      position: new THREE.Vector3(x + rng.range(-3.1, 3.1), 0.3, z + rng.range(-0.4, 0.4)),
      rotation: new THREE.Euler(rng.range(-0.2, 0.2), rng.range(0, 3), rng.range(-0.2, 0.2)),
      scale: new THREE.Vector3(1, rng.range(0.7, 1.7), 1),
    });
  }
  const weedInst = instanced(tuft, weedMat, weeds);
  weedInst.name = 'rail-weeds';
  weedInst.castShadow = false;
  rail.add(weedInst);

  // —— 三处平交道口：路面抬高成与轨道齐平的铺装机，轨两侧留护轨与轮缘槽 ——
  for (const cz of RAIL.crossings) {
    const roadHere = ROADS.find((r) => r.axis === 'x' && Math.abs(r.at - cz) < 0.01);
    if (!roadHere) continue;
    const rw = roadHere.half + roadHere.walk;
    const pave = box(8.6, 0.1, rw * 2, toonMaterial(0x4d5158, { steps: 2 }));
    at(pave, x, 0.12, cz);
    pave.receiveShadow = true;
    pave.castShadow = false;
    pave.name = `rail-crossing-${cz}`;
    rail.add(pave);
    // 护轨 + 轮缘槽（槽是暗的，看得见深度）
    for (const s of [-1, 1] as const) {
      const guard = box(0.18, 0.16, rw * 2, rustSteel);
      at(guard, x + s * (RAIL.gauge / 2 + 0.3), 0.2, cz);
      rail.add(guard);
      const groove = box(0.3, 0.06, rw * 2, basicMaterial(0x0d1116, { opacity: 0.8, transparent: true }));
      at(groove, x + s * (RAIL.gauge / 2 + 0.05), 0.14, cz);
      groove.castShadow = false;
      rail.add(groove);
    }
  }

  // 尽端车挡 + 装卸线
  const buffer = box(3.2, 0.7, 0.35, rustSteel);
  at(buffer, RAIL.buffer.x, 0.42, RAIL.buffer.z);
  rail.add(buffer);
  for (const s of [-1, 1] as const) {
    rail.add(at(box(0.16, 0.9, 0.16, steelMat), RAIL.buffer.x + s * 1.4, 0.5, RAIL.buffer.z));
  }

  base.add(rail);
  buildRailSpur(base);
}

/** 装卸线（从正线向西岔出的一条短轨） */
function buildRailSpur(base: THREE.Group): void {
  const steelMat = new THREE.MeshPhongMaterial({ color: 0x4a4f57, specular: 0x6f7f8c, shininess: 48 });
  const { at: az, from, to } = RAIL.spur;
  const len = to - from;
  for (const s of [-1, 1] as const) {
    const railMesh = box(len, 0.12, 0.14, steelMat);
    at(railMesh, (from + to) / 2, 0.3, az + (s * RAIL.gauge) / 2);
    railMesh.castShadow = false;
    railMesh.name = 'rail-spur';
    base.add(railMesh);
  }
  const sleeperGeo = new THREE.BoxGeometry(0.24, 0.12, 2.9);
  const list: InstanceTransform[] = [];
  for (let xx = from + 0.4; xx < to; xx += 0.66) {
    list.push({ position: new THREE.Vector3(xx, 0.16, az), rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1) });
  }
  const inst = instanced(sleeperGeo, toonMaterial(0x33302a, { steps: 2 }), list);
  inst.name = 'rail-spur-sleepers';
  inst.castShadow = false;
  base.add(inst);
}

/* ---------------------------- 边缘遮掩 ---------------------------- */

function buildEdgeMask(base: THREE.Group): void {
  // 越靠底座边缘越暗：一张径向压暗片，零运行时开销
  const tex = canvasTexture(512, 512, (c, w, h) => {
    const g = c.createRadialGradient(w / 2, h / 2, w * 0.24, w / 2, h / 2, w * 0.5);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.62, 'rgba(4,7,11,0.16)');
    g.addColorStop(0.82, 'rgba(4,7,11,0.5)');
    g.addColorStop(1, 'rgba(3,5,8,0.92)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  });
  const dark = mesh(
    new THREE.PlaneGeometry(BASE.size + 2, BASE.size + 2),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, color: 0x05080c }),
  );
  dark.rotation.x = -Math.PI / 2;
  dark.position.y = 0.035;
  dark.renderOrder = -1;
  dark.castShadow = false;
  dark.name = 'edge-darken';
  base.add(dark);
}

/* ---------------------------- 地面碎屑 ---------------------------- */

function buildGroundLitter(base: THREE.Group, rng: Rng): void {
  const stainMat = basicMaterial(0x1b222b, { opacity: 0.34, transparent: true, fog: true });
  const mudMat = basicMaterial(0x272420, { opacity: 0.38, transparent: true, fog: true });
  const weedMat = toonMaterial(0x2f3527, { steps: 2 });
  const weedDarkMat = toonMaterial(0x242a20, { steps: 2 });
  const dirtPatchMat = toonMaterial(0x3a3428, { steps: 2 });

  const stains: THREE.Mesh[] = [];
  const muds: THREE.Mesh[] = [];
  const weeds: THREE.Mesh[] = [];
  const weedsDark: THREE.Mesh[] = [];
  const dirtPatches: THREE.Mesh[] = [];

  // —— 路面上的油污与泥，以及街区空地上的草与土 ——
  for (let i = 0; i < 190; i += 1) {
    const w = rng.range(2.0, 5.2);
    const d = rng.range(1.6, 4.2);
    const x = rng.range(-(BASE.half - 5), BASE.half - 5);
    const z = rng.range(-(BASE.half - 5), BASE.half - 5);
    const pad = Math.max(w, d) * 0.5;
    const onRoad = isOnCarriageway(x, z);
    const near = isOnRoadCorridor(x, z, pad * 0.2);
    if (onRoad && Math.abs(x) < 6 && Math.abs(z) < 6) continue; // 核心路口保持干净
    const kind = rng.next();
    let mat: THREE.Material;
    if (onRoad) mat = kind < 0.5 ? stainMat : mudMat;
    else if (near) mat = kind < 0.4 ? weedMat : kind < 0.75 ? weedDarkMat : dirtPatchMat;
    else mat = kind < 0.3 ? weedMat : kind < 0.6 ? weedDarkMat : dirtPatchMat;

    const patch = mesh(jitter(new THREE.CircleGeometry(1, onRoad ? 12 : 11), 0.12, rng), mat);
    patch.rotation.x = -Math.PI / 2;
    patch.rotation.z = rng.range(0, Math.PI);
    patch.scale.set(w / 2, d / 2, 1);
    patch.castShadow = false;
    patch.receiveShadow = !onRoad;
    at(patch, x, onRoad ? groundYAt(x, z) + 0.02 : 0.045, z);
    if (mat === stainMat) stains.push(patch);
    else if (mat === mudMat) muds.push(patch);
    else if (mat === weedMat) weeds.push(patch);
    else if (mat === weedDarkMat) weedsDark.push(patch);
    else dirtPatches.push(patch);
  }
  addBatch(base, stains, stainMat, 'ground-stains');
  addBatch(base, muds, mudMat, 'ground-mud');
  addBatch(base, weeds, weedMat, 'outer-weed');
  addBatch(base, weedsDark, weedDarkMat, 'outer-weed-dark');
  addBatch(base, dirtPatches, dirtPatchMat, 'outer-dirt');

  // —— 积水：优先落在路面上（雨夜反光的主角）——
  const puddleSpots: Array<[number, number, number, number]> = [];
  for (const r of ROADS) {
    for (const { mid, len } of roadSegments(r, 0.25)) {
      const n = Math.max(1, Math.round(len / 23));
      for (let i = 0; i < n; i += 1) {
        const t = mid - len / 2 + rng.range(4, len - 4);
        // 靠车道一侧的低洼处
        const off = (rng.chance(0.5) ? -1 : 1) * rng.range(1.5, r.half - 1.4);
        const px = r.axis === 'x' ? t : r.at + off;
        const pz = r.axis === 'x' ? r.at + off : t;
        const pw = rng.range(4.2, 9.4);
        puddleSpots.push([px, pz, pw, pw * rng.range(0.34, 0.55)]);
      }
    }
  }
  const puddles: THREE.Mesh[] = [];
  const puddleRims: THREE.Mesh[] = [];
  PUDDLES.length = 0;
  for (const p of puddleSpots) PUDDLES.push(p);
  const puddleRimMat = toonMaterial(0x1a222b, { steps: 2 });
  const siltTransforms: InstanceTransform[] = [];
  for (const [x, z, w, d] of puddleSpots) {
    const y = groundYAt(x, z) + 0.03;
    const puddle = mesh(jitter(new THREE.CircleGeometry(1, 16), 0.09, rng), puddleMaterial);
    puddle.rotation.x = -Math.PI / 2;
    puddle.rotation.z = rng.range(0, Math.PI);
    puddle.scale.set(w / 2, d / 2, 1);
    puddle.receiveShadow = false;
    puddle.castShadow = false;
    at(puddle, x, y, z);
    puddles.push(puddle);

    // 边缘：微微隆起的湿痕（体积感，不是贴图）
    const rim = mesh(jitter(new THREE.RingGeometry(0.94, 1.1, 18), 0.06, rng), puddleRimMat);
    rim.rotation.x = -Math.PI / 2;
    rim.rotation.z = rng.range(0, Math.PI);
    rim.scale.set(w / 2, d / 2, 1);
    rim.receiveShadow = false;
    rim.castShadow = false;
    at(rim, x, y + 0.014, z);
    puddleRims.push(rim);

    // 水底的泥与碎石：透过水看得到，避免水洼是纯色块
    const n = Math.round(10 + w * 1.5);
    for (let i = 0; i < n; i += 1) {
      const a = rng.range(0, Math.PI * 2);
      const rad = Math.sqrt(rng.next());
      siltTransforms.push({
        position: new THREE.Vector3(x + Math.cos(a) * rad * (w / 2) * 0.86, y - 0.006, z + Math.sin(a) * rad * (d / 2) * 0.86),
        rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)),
        scale: new THREE.Vector3(1, 0.5, 1).multiplyScalar(rng.range(0.5, 1.4)),
      });
    }
  }
  addBatch(base, puddles, puddleMaterial, 'puddles');
  addBatch(base, puddleRims, puddleRimMat, 'puddle-rims');
  const silt = instanced(new THREE.DodecahedronGeometry(0.07, 0), toonMaterial(0x2b2a22, { steps: 2 }), siltTransforms);
  silt.name = 'puddle-silt';
  silt.castShadow = false;
  base.add(silt);

  // —— 排水沟：边框 + 栅条（有厚度与边框，不是贴片）——
  const grateMat = toonMaterial(0x2b2f34, { steps: 2 });
  const grateFrameMat = basicMaterial(0x14171b);
  const grates: THREE.Mesh[] = [];
  const grateBars: THREE.Mesh[] = [];
  for (const r of ROADS) {
    for (const { mid, len } of roadSegments(r, 6)) {
      const n = Math.max(1, Math.round(len / 46));
      for (let i = 0; i < n; i += 1) {
        const t = mid - len / 2 + (i + 0.5) * (len / n);
        const side = i % 2 === 0 ? 1 : -1;
        const gx = r.axis === 'x' ? t : r.at + side * (r.half + 0.6);
        const gz = r.axis === 'x' ? r.at + side * (r.half + 0.6) : t;
        const y = roadSurfaceY(r) + 0.02;
        const frame = box(1.62, 0.1, 0.62, grateFrameMat);
        at(frame, gx, y, gz);
        grates.push(frame);
        const pit = box(1.5, 0.06, 0.5, grateFrameMat);
        at(pit, gx, y + 0.025, gz);
        grates.push(pit);
        for (let k = -3; k <= 3; k += 1) {
          const bar = box(0.07, 0.09, 0.42, grateMat);
          at(bar, gx + k * 0.2, y + 0.055, gz);
          grateBars.push(bar);
        }
      }
    }
  }
  addBatch(base, grates, grateFrameMat, 'grates');
  addBatch(base, grateBars, grateMat, 'grate-bars');

  // —— 沥青裂缝：真实几何的细槽（凹进路面），不是贴图 ——
  const crackMat = basicMaterial(0x0d1116, { opacity: 0.75, transparent: true, fog: true });
  const cracks: THREE.Mesh[] = [];
  for (let i = 0; i < 60; i += 1) {
    const r = ROADS[Math.floor(rng.next() * ROADS.length)]!;
    const t = rng.range(r.from + 6, r.to - 6);
    const off = rng.range(-r.half + 0.8, r.half - 0.8);
    let px = r.axis === 'x' ? t : r.at + off;
    let pz = r.axis === 'x' ? r.at + off : t;
    if (Math.abs(px) < 13 && Math.abs(pz) < 13) continue; // 核心路口保持干净
    const y = groundYAt(px, pz) + 0.01;
    let a = rng.range(0, Math.PI * 2);
    const segs = rng.int(3, 5);
    for (let s = 0; s < segs; s += 1) {
      const len = rng.range(0.8, 2.4);
      const nx = px + Math.cos(a) * len;
      const nz = pz + Math.sin(a) * len;
      const seg = box(0.06, 0.02, len, crackMat);
      seg.position.set((px + nx) / 2, y, (pz + nz) / 2);
      seg.rotation.y = -a;
      seg.castShadow = false;
      seg.receiveShadow = false;
      cracks.push(seg);
      px = nx;
      pz = nz;
      a += rng.gauss(0, 0.7);
    }
  }
  const crackBatch = addBatch(base, cracks, crackMat, 'asphalt-cracks');
  if (crackBatch) {
    crackBatch.castShadow = false;
    crackBatch.receiveShadow = false;
  }

  // —— 井盖 ——
  const manholeMat = toonMaterial(0x3a3e43, { steps: 3 });
  const manholeDarkMat = toonMaterial(0x22262a, { steps: 2 });
  const covers: THREE.Mesh[] = [];
  const rings: THREE.Mesh[] = [];
  const coverDetail: THREE.Mesh[] = [];
  for (const r of ROADS) {
    for (const { mid, len } of roadSegments(r, 10)) {
      const n = Math.max(1, Math.round(len / 60));
      for (let i = 0; i < n; i += 1) {
        const t = mid - len / 2 + (i + 0.5) * (len / n) + rng.range(-3, 3);
        const off = (i % 2 === 0 ? -1 : 1) * rng.range(2, Math.max(2.2, r.half - 2));
        const mx = r.axis === 'x' ? t : r.at + off;
        const mz = r.axis === 'x' ? r.at + off : t;
        const y = groundYAt(mx, mz);
        coverDetail.push(at(cyl(0.72, 0.72, 0.06, 16, manholeDarkMat), mx, y + 0.01, mz));
        covers.push(at(cyl(0.62, 0.62, 0.09, 16, manholeMat), mx, y + 0.06, mz));
        for (let k = 0; k < 16; k += 1) {
          const a = (k / 16) * Math.PI * 2;
          coverDetail.push(at(box(0.07, 0.05, 0.11, manholeMat), mx + Math.cos(a) * 0.6, y + 0.1, mz + Math.sin(a) * 0.6, -a));
        }
        for (let k = 0; k < 8; k += 1) {
          const a = (k / 8) * Math.PI * 2;
          coverDetail.push(at(box(0.5, 0.02, 0.05, manholeDarkMat), mx + Math.cos(a) * 0.22, y + 0.115, mz + Math.sin(a) * 0.22, -a));
        }
        for (const rr of [0.2, 0.4]) {
          const ring = torus(rr, 0.018, manholeDarkMat, 16);
          ring.rotation.x = -Math.PI / 2;
          at(ring, mx, y + 0.116, mz);
          coverDetail.push(ring);
        }
        const outer = torus(0.6, 0.05, manholeMat, 16);
        outer.rotation.x = -Math.PI / 2;
        at(outer, mx, y + 0.08, mz);
        rings.push(outer);
      }
    }
  }
  addBatch(base, covers, manholeMat, 'manhole-covers');
  addBatch(base, rings, manholeMat, 'manhole-rings');
  addBatch(base, coverDetail, manholeDarkMat, 'manhole-detail');

  // —— 弹坑：路口与新增干线各几处 ——
  const craterMat = basicMaterial(0x161d25, { opacity: 0.5, transparent: true });
  const craterRubble = toonMaterial(PALETTE.dirt, { steps: 2 });
  const craterHoles: THREE.Mesh[] = [];
  const rubbleTransforms: InstanceTransform[] = [];
  const craters: Array<[number, number, number]> = [
    [6.5, 12.5, 1.9],
    [-6.5, -15.5, 1.5],
    [24, 8.5, 1.3],
    [-96, -6, 2.2],
    [92, 4, 1.8],
    [-14, 104, 2.4],
    [58, -101, 1.7],
    [-64, 132, 1.5],
  ];
  for (const [cx, cz, r] of craters) {
    const y = groundYAt(cx, cz) + 0.02;
    const hole = mesh(jitter(new THREE.CircleGeometry(r, 12), r * 0.12, rng), craterMat);
    hole.rotation.x = -Math.PI / 2;
    at(hole, cx, y, cz);
    craterHoles.push(hole);
    for (let i = 0; i < 12; i += 1) {
      const a = rng.range(0, Math.PI * 2);
      const rad = r * rng.range(0.7, 1.5);
      rubbleTransforms.push({
        position: new THREE.Vector3(cx + Math.cos(a) * rad, y + 0.04, cz + Math.sin(a) * rad),
        rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)),
        scale: new THREE.Vector3(1, 1, 1).multiplyScalar(rng.range(0.5, 1.1)),
      });
    }
  }
  addBatch(base, craterHoles, craterMat, 'crater-holes');

  // —— 路面颗粒：沥青的油子与小碎石（几何表达，不是贴图）——
  // 没有它，哑光路面会显得像塑料水泥板；有它，高光才会被"打碎"成不规则的碎点。
  const gritMat = toonMaterial(0x51565d, { steps: 2 });
  const gritDark = toonMaterial(0x2b2f34, { steps: 2 });
  const gritA: InstanceTransform[] = [];
  const gritB: InstanceTransform[] = [];
  for (const r of ROADS) {
    const cw = carriageway(r);
    const along = r.axis === 'x' ? cw.x1 - cw.x0 : cw.z1 - cw.z0;
    const n = Math.round(along * 0.9); // 每米约 1 颗，全图约 1700 颗：够打碎高光又不翻倍三角面
    for (let i = 0; i < n; i += 1) {
      const t = rng.range(r.from + 1, r.to - 1);
      const off = rng.range(-r.half + 0.4, r.half - 0.4);
      const gx = r.axis === 'x' ? t : r.at + off;
      const gz = r.axis === 'x' ? r.at + off : t;
      const s = rng.range(0.05, 0.15);
      const item: InstanceTransform = {
        position: new THREE.Vector3(gx, groundYAt(gx, gz) + s * 0.35, gz),
        rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)),
        scale: new THREE.Vector3(s, s * 0.55, s),
      };
      (rng.chance(0.55) ? gritA : gritB).push(item);
    }
  }
  const gritGeo = jitter(new THREE.DodecahedronGeometry(1, 0), 0.16, rng.fork(77));
  for (const [list, mat, name] of [
    [gritA, gritMat, 'road-grit'],
    [gritB, gritDark, 'road-grit-dark'],
  ] as Array<[InstanceTransform[], THREE.Material, string]>) {
    const inst = instanced(gritGeo, mat, list);
    inst.name = name;
    inst.castShadow = false;
    inst.receiveShadow = false;
    base.add(inst);
  }

  // —— 底座四周的收边瓦砾 ——
  for (let i = 0; i < 260; i += 1) {
    const side = rng.int(0, 3);
    const t = rng.range(-(BASE.half - 1), BASE.half - 1);
    const inset = BASE.half - rng.range(0.4, 2.6);
    const ex = side === 0 ? t : side === 1 ? -inset : side === 2 ? t : inset;
    const ez = side === 0 ? -inset : side === 1 ? t : side === 2 ? inset : t;
    rubbleTransforms.push({
      position: new THREE.Vector3(ex, rng.range(0.06, 0.24), ez),
      rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 6), rng.range(0, 3)),
      scale: new THREE.Vector3(1, 1, 1).multiplyScalar(rng.range(0.35, 1.1)),
    });
  }
  const variants = 3;
  const perVariant = Math.ceil(rubbleTransforms.length / variants);
  for (let v = 0; v < variants; v += 1) {
    const chunkGeom = jitter(new THREE.DodecahedronGeometry(0.4, 0), 0.06, rng.fork(v + 1));
    const slice = rubbleTransforms.slice(v * perVariant, (v + 1) * perVariant);
    if (slice.length === 0) continue;
    const inst = instanced(chunkGeom, craterRubble, slice);
    inst.name = `rubble-${v}`;
    inst.castShadow = false;
    base.add(inst);
  }
}
