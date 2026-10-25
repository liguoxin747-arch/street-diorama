import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mergeAll } from '../core/detail';
import type { BuildContext } from '../core/context';
import type { Rng } from '../core/rng';
import { GLOW, PALETTE } from '../core/palette';
import {
  basicMaterial,
  canvasTexture,
  glassMaterial,
  glowMaterial,
  toonGradient,
  toonMaterial,
  withOutline,
} from '../core/materials';
import {
  at,
  box,
  group,
  hashNoise,
  instanced,
  jitter,
  mesh,
  sagPath,
  softBox,
  tubeAlong,
} from '../core/geo';
import { HOTSPOTS, ROAD } from './layout';

/**
 * 街角道具与街道设施（东欧战区夜雨街角）。
 *
 * 布局逻辑参考真实战区街景：路口的"军事性"最强（检查站掩体、拒马、轮胎路障、
 * 警戒带），越往街区里走越偏向"民用废弃物"（垃圾桶、纸箱、晒衣绳下的板车）。
 * 所有摆放都避让 HOTSPOTS 里的载具与人物，随机源全部来自 ctx.rng 派生序列。
 */

const WALK_Y = ROAD.curbHeight;
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const UNIT = new THREE.Vector3(1, 1, 1);

/** 人行道顶面 / 车行道 / 空地 的可用地面高度 */
function surfaceY(x: number, z: number): number {
  const abz = Math.abs(z);
  const abx = Math.abs(x);
  const onAvenueWalk = abz > ROAD.avenueHalf && abz <= ROAD.avenueHalf + ROAD.sidewalk;
  const onCrossWalk =
    abz > ROAD.avenueHalf && abx > ROAD.crossHalf && abx <= ROAD.crossHalf + ROAD.sidewalk;
  if (onAvenueWalk || onCrossWalk) return ROAD.curbHeight;
  if (abz <= ROAD.avenueHalf || abx <= ROAD.crossHalf) return 0.07;
  return 0.05;
}

/* ------------------------------------------------------------------ *
 * 材质
 * ------------------------------------------------------------------ */

const MAT = {
  poleSteel: toonMaterial(0x2d343b, { steps: 2 }),
  steel: toonMaterial(0x4e5760, { steps: 3 }),
  steelDark: toonMaterial(0x353b42, { steps: 2 }),
  steelBright: toonMaterial(0x77818c, { steps: 3 }),
  rust: toonMaterial(PALETTE.rustDark, { steps: 2 }),
  rustBright: toonMaterial(PALETTE.rust, { steps: 3 }),
  wood: toonMaterial(PALETTE.woodOld, { steps: 3 }),
  woodDark: toonMaterial(PALETTE.woodDark, { steps: 2 }),
  cardboard: toonMaterial(0x6f5f47, { steps: 3 }),
  concrete: toonMaterial(PALETTE.concreteStain, { steps: 3 }),
  sandbag: toonMaterial(PALETTE.sandbag, { steps: 3 }),
  sandbagDark: toonMaterial(PALETTE.sandbagDark, { steps: 3 }),
  tire: toonMaterial(PALETTE.tire, { steps: 2 }),
  burnt: toonMaterial(PALETTE.burnt, { steps: 2 }),
  barrel: toonMaterial(PALETTE.barrel, { steps: 3 }),
  barrelRust: toonMaterial(PALETTE.barrelRust, { steps: 3 }),
  wire: toonMaterial(0x171b20, { steps: 2 }),
  plastic: toonMaterial(0x33463f, { steps: 3 }),
  dirt: toonMaterial(PALETTE.dirt, { steps: 2 }),
  brass: toonMaterial(0xa8894f, { steps: 2 }),
  // —— 民用生活道具 ——
  canvasCloth: toonMaterial(0x6b6553, { steps: 3 }),
  canvasDark: toonMaterial(0x4e4a3c, { steps: 2 }),
  blanket: toonMaterial(0x54606b, { steps: 3 }),
  straw: toonMaterial(0x8a7042, { steps: 2 }),
  stoveBrick: toonMaterial(0x7d5b4c, { steps: 3 }),
  stoveBrickDark: toonMaterial(0x59402f, { steps: 2 }),
  mortar: toonMaterial(0x6a6a63, { steps: 2 }),
  stoveIron: toonMaterial(0x3a3d42, { steps: 2 }),
  stoveIronLight: toonMaterial(0x565c63, { steps: 3 }),
  potIron: toonMaterial(0x4a4d52, { steps: 3 }),
  enamel: toonMaterial(0xb9b3a2, { steps: 3 }),
  enamelChip: toonMaterial(0x4b4a45, { steps: 2 }),
  tin: toonMaterial(0x8d8f8a, { steps: 2 }),
  tinLabel: toonMaterial(0x9a6b3f, { steps: 2 }),
  water: toonMaterial(0x1d2c38, { steps: 2, emissive: PALETTE.coldLamp, emissiveIntensity: 0.1 }),
  clothWorn: toonMaterial(0x5d5b52, { steps: 3 }),
  rope: toonMaterial(0x5f5647, { steps: 2 }),
  // —— 街道设施 ——
  castIron: toonMaterial(0x3c4147, { steps: 3 }),
  castIronDark: toonMaterial(0x24282c, { steps: 2 }),
  curbStone: toonMaterial(0x5f6469, { steps: 3 }),
  curbPatch: toonMaterial(0x77736a, { steps: 2 }),
  boxPaint: toonMaterial(0x4f5a52, { steps: 3 }),
  boxPaintWarn: toonMaterial(0x8a6a2c, { steps: 2 }),
  leaf: basicMaterial(0x3b3226, { opacity: 0.95, transparent: true, side: THREE.DoubleSide }),
} as const;

/* ------------------------------------------------------------------ *
 * 批量合批工具：把小零件烘焙成单个网格，控制 draw call
 * ------------------------------------------------------------------ */

class Parts {
  private readonly geoms: THREE.BufferGeometry[] = [];
  private readonly mtx = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3();

  add(
    geometry: THREE.BufferGeometry,
    x = 0,
    y = 0,
    z = 0,
    rx = 0,
    ry = 0,
    rz = 0,
    sx = 1,
    sy = 1,
    sz = 1,
  ): this {
    this.euler.set(rx, ry, rz);
    this.quat.setFromEuler(this.euler);
    this.pos.set(x, y, z);
    this.scl.set(sx, sy, sz);
    return this.addQ(geometry, this.pos, this.quat, this.scl);
  }

  addQ(
    geometry: THREE.BufferGeometry,
    position: THREE.Vector3,
    quaternion: THREE.Quaternion,
    scale: THREE.Vector3 = UNIT,
  ): this {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    this.mtx.compose(position, quaternion, scale);
    g.applyMatrix4(this.mtx);
    for (const key of Object.keys(g.attributes)) {
      if (key !== 'position' && key !== 'normal' && key !== 'uv') g.deleteAttribute(key);
    }
    if (!g.getAttribute('uv')) {
      const count = g.getAttribute('position')?.count ?? 0;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    this.geoms.push(g);
    return this;
  }

  /** 沿两点摆一段圆柱（默认单位高度几何，长度用 Y 缩放） */
  addBetween(geometry: THREE.BufferGeometry, a: THREE.Vector3, b: THREE.Vector3): this {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    const q = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, dir.clone().normalize());
    return this.addQ(geometry, mid, q, new THREE.Vector3(1, Math.max(len, 0.001), 1));
  }

  take(material: THREE.Material, name?: string, outline = 0): THREE.Mesh | null {
    if (this.geoms.length === 0) return null;
    const merged = mergeGeometries(this.geoms, false);
    for (const g of this.geoms) g.dispose();
    this.geoms.length = 0;
    if (!merged) return null;
    const m = mesh(merged, material);
    if (name) m.name = name;
    if (outline > 0) withOutline(m, outline);
    return m;
  }
}

function commit(
  batch: Parts,
  material: THREE.Material,
  target: THREE.Object3D,
  name: string,
  outline = 0,
): THREE.Mesh | null {
  const m = batch.take(material, name, outline);
  if (m) target.add(m);
  return m;
}

/* ------------------------------------------------------------------ *
 * Canvas 贴图
 * ------------------------------------------------------------------ */

/** 褪色搪瓷街名牌 */
function streetNameTexture(rng: Rng, text: string, base: string, ink: string): THREE.CanvasTexture {
  return canvasTexture(256, 64, (c, w, h) => {
    c.fillStyle = base;
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 26; i += 1) {
      c.globalAlpha = rng.range(0.04, 0.18);
      c.fillStyle = rng.chance(0.5) ? '#18211e' : '#4b5a53';
      c.fillRect(rng.range(-4, w), rng.range(0, h), rng.range(3, 16), rng.range(2, 12));
    }
    // 锈水往下淌的竖痕
    for (let i = 0; i < 5; i += 1) {
      c.globalAlpha = rng.range(0.1, 0.24);
      c.fillStyle = '#6a4a2e';
      c.fillRect(rng.range(0, w), 0, rng.range(1, 3), h);
    }
    c.globalAlpha = 1;
    c.strokeStyle = 'rgba(214,218,206,0.5)';
    c.lineWidth = 3;
    c.strokeRect(5, 5, w - 10, h - 10);
    c.globalAlpha = 0.82;
    c.fillStyle = ink;
    c.font = 'bold 27px "Arial Narrow", Arial, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, w / 2, h / 2 + 1);
    c.globalAlpha = 1;
  });
}

/** 湿透的褪色海报 */
function posterTexture(rng: Rng, variant: number): THREE.CanvasTexture {
  return canvasTexture(192, 264, (c, w, h) => {
    c.fillStyle = variant === 0 ? '#b6a98d' : '#a4a79b';
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 14; i += 1) {
      c.globalAlpha = rng.range(0.05, 0.16);
      c.fillStyle = i % 2 === 0 ? '#6b583a' : '#38464f';
      c.beginPath();
      c.ellipse(rng.range(0, w), rng.range(0, h), rng.range(8, 46), rng.range(6, 28), rng.range(0, 3), 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;
    c.fillStyle = variant === 0 ? '#8a3230' : '#2f4a5c';
    c.fillRect(10, 14, w - 20, 32);
    c.fillStyle = 'rgba(233,226,211,0.84)';
    c.font = 'bold 21px "Arial Narrow", Arial, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(variant === 0 ? 'УВАГА' : 'ВОДА', w / 2, 31);
    c.fillStyle = 'rgba(46,42,36,0.5)';
    for (let i = 0; i < 7; i += 1) {
      c.fillRect(16, 62 + i * 15, w - 32 - rng.range(0, 46), 5);
    }
    c.fillStyle = 'rgba(46,42,36,0.34)';
    c.fillRect(16, h - 46, w - 32, 22);
    // 撕掉的角 + 破洞
    c.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 3; i += 1) {
      c.beginPath();
      const cx = i === 0 ? 0 : i === 1 ? w : rng.range(20, w - 20);
      const cy = i === 2 ? rng.range(90, h - 90) : i === 0 ? h : 0;
      c.arc(cx, cy, rng.range(10, 24), 0, Math.PI * 2);
      c.fill();
    }
    c.globalCompositeOperation = 'source-over';
  });
}

/** 红白警戒带（斜条纹） */
function tapeTexture(): THREE.CanvasTexture {
  const tex = canvasTexture(128, 32, (c, w, h) => {
    c.fillStyle = '#b02f27';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#cbc5b5';
    for (let i = -2; i < 8; i += 1) {
      c.save();
      c.translate(i * 24, 0);
      c.transform(1, 0, -0.55, 1, 0, 0);
      c.fillRect(0, 0, 11, h);
      c.restore();
    }
    // 磨损与泥点
    c.globalAlpha = 0.22;
    c.fillStyle = '#2b2622';
    for (let i = 0; i < 26; i += 1) {
      c.fillRect((i * 37) % w, (i * 13) % h, 5, 4);
    }
    c.globalAlpha = 1;
  });
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/** 玻璃裂纹 */
function crackTexture(): THREE.CanvasTexture {
  return canvasTexture(160, 160, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.strokeStyle = 'rgba(226,238,246,0.62)';
    c.lineWidth = 1.4;
    const cx = w * 0.42;
    const cy = h * 0.46;
    for (let i = 0; i < 11; i += 1) {
      const a = (i / 11) * Math.PI * 2 + 0.3;
      const r = 24 + ((i * 31) % 66);
      c.beginPath();
      c.moveTo(cx, cy);
      c.lineTo(cx + Math.cos(a) * r * 0.5, cy + Math.sin(a) * r * 0.5);
      c.lineTo(cx + Math.cos(a + 0.12) * r, cy + Math.sin(a + 0.12) * r);
      c.stroke();
    }
    c.strokeStyle = 'rgba(226,238,246,0.4)';
    for (let r = 10; r < 34; r += 9) {
      c.beginPath();
      c.arc(cx, cy, r, 0, Math.PI * 2);
      c.stroke();
    }
  });
}

function plateMaterial(tex: THREE.Texture): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ map: tex, gradientMap: toonGradient(3) });
}

/* ------------------------------------------------------------------ *
 * 1. 街角路牌
 * ------------------------------------------------------------------ */

function buildCornerSign(root: THREE.Group, rng: Rng): void {
  const g = group('prop-corner-sign');
  at(g, HOTSPOTS.cornerSign.x + 0.35, WALK_Y, HOTSPOTS.cornerSign.z - 0.4);
  g.rotation.y = -0.26;
  g.rotation.z = 0.045;

  const post = new Parts();
  post.add(new THREE.CylinderGeometry(0.05, 0.075, 3.45, 10), 0, 1.72, 0);
  post.add(new THREE.CylinderGeometry(0.15, 0.19, 0.2, 10), 0, 0.1, 0);
  post.add(new THREE.CylinderGeometry(0.085, 0.085, 0.07, 10), 0, 2.42, 0);
  post.add(new THREE.SphereGeometry(0.072, 8, 6), 0, 3.5, 0);
  // 板子的小托架
  post.add(new THREE.BoxGeometry(0.05, 0.05, 0.3), 0, 3.22, 0.14);
  post.add(new THREE.BoxGeometry(0.05, 0.05, 0.3), 0, 2.84, 0.14);
  commit(post, MAT.poleSteel, g, 'sign-post', 0.0024);

  const plates: Array<[number, number, string, string, string, number, number]> = [
    [1.46, 0.38, 'ВУЛ. СОБОРНА', '#2d4a43', 'rgba(226,229,216,0.88)', 3.24, 0.02],
    [1.46, 0.38, 'ПЛ. РИНОК', '#2d4a43', 'rgba(226,229,216,0.88)', 2.86, -Math.PI / 2],
    [0.72, 0.3, '№ 14', '#3b3d3a', 'rgba(226,229,216,0.8)', 2.46, 0.02],
  ];
  plates.forEach(([w, h, text, bg, ink, y, ry]) => {
    const mat = plateMaterial(streetNameTexture(rng, text, bg, ink));
    const plate = box(w, h, 0.045, mat);
    plate.position.set(Math.sin(ry) * 0.16, y, Math.cos(ry) * 0.16);
    plate.rotation.y = ry;
    plate.rotation.z = ry === 0 ? rng.range(-0.045, 0.01) : rng.range(-0.03, 0.03);
    g.add(plate);
  });

  root.add(g);
}

/* ------------------------------------------------------------------ *
 * 2. 电线杆与下垂/断裂电线
 * ------------------------------------------------------------------ */

interface PoleDef {
  x: number;
  z: number;
  h: number;
  wood: boolean;
}

function buildUtilityPoles(ctx: BuildContext, root: THREE.Group, anim: AnimList, rng: Rng): void {
  const g = group('prop-utility-poles');

  const poles: PoleDef[] = [
    { x: -11.4, z: -15.2, h: 7.6, wood: false },
    { x: -11.4, z: -26.8, h: 8.0, wood: true },
    { x: -11.4, z: -38.6, h: 7.4, wood: false },
    { x: 11.4, z: 16.4, h: 7.8, wood: true },
    { x: 11.4, z: 28.8, h: 7.5, wood: false },
    { x: 11.4, z: 41.2, h: 7.2, wood: true },
  ];

  const concrete = new Parts();
  const wood = new Parts();
  const hardware = new Parts();
  const insulatorGeo = new THREE.CylinderGeometry(0.055, 0.045, 0.15, 6);

  poles.forEach((p, i) => {
    const batch = p.wood ? wood : concrete;
    const y0 = surfaceY(p.x, p.z);
    const lean = rng.gauss(0, 0.012);
    const topY = y0 + p.h;
    if (p.wood) {
      batch.add(new THREE.CylinderGeometry(0.12, 0.17, p.h, 7), p.x, y0 + p.h / 2, p.z, lean, 0, lean * 0.8);
    } else {
      batch.add(new THREE.CylinderGeometry(0.1, 0.15, p.h, 8), p.x, y0 + p.h / 2, p.z, lean, 0, lean * 0.8);
    }
    // 横担（沿 X，电线走向沿 Z）
    hardware.add(new THREE.BoxGeometry(1.98, 0.09, 0.11), p.x, topY - 0.55, p.z);
    hardware.add(new THREE.BoxGeometry(1.5, 0.07, 0.08), p.x, topY - 1.05, p.z);
    for (const dx of [-0.72, 0, 0.72]) {
      hardware.add(insulatorGeo, p.x + dx, topY - 0.45, p.z);
    }
    for (const dx of [-0.55, 0.55]) {
      hardware.add(insulatorGeo, p.x + dx, topY - 0.97, p.z);
    }
    // 脚部加固与爬钉
    hardware.add(new THREE.BoxGeometry(0.34, 0.5, 0.34), p.x, y0 + 0.25, p.z);
    if (i % 2 === 0) {
      hardware.add(new THREE.BoxGeometry(0.3, 0.14, 0.06), p.x + 0.16, y0 + 2.4, p.z);
    }
    // 顶上的小挂牌（警示牌）
    if (i === 1) {
      const sign = box(0.34, 0.26, 0.03, MAT.steelBright);
      at(sign, p.x + 0.16, y0 + 2.9, p.z + 0.02, 0.2);
      g.add(sign);
    }
  });

  commit(concrete, MAT.concrete, g, 'poles-concrete');
  commit(wood, MAT.woodDark, g, 'poles-wood');
  commit(hardware, MAT.steelDark, g, 'poles-hardware');

  // —— 电线：沿横担瓷瓶拉出明显下垂的悬链线 ——
  const wire = new Parts();
  const spans: Array<[number, number]> = [
    [0, 1],
    [1, 2],
    [3, 4],
    [4, 5],
  ];
  spans.forEach(([a, b]) => {
    const pa = poles[a];
    const pb = poles[b];
    if (!pa || !pb) return;
    const ya = surfaceY(pa.x, pa.z) + pa.h - 0.4;
    const yb = surfaceY(pb.x, pb.z) + pb.h - 0.4;
    const offsets = [-0.72, 0, 0.72];
    offsets.forEach((dx, k) => {
      const from = new THREE.Vector3(pa.x + dx, ya, pa.z);
      const to = new THREE.Vector3(pb.x + dx, yb, pb.z);
      const sag = 0.62 + k * 0.16 + rng.range(0, 0.18);
      const pts = sagPath(from, to, sag, 7);
      const tube = tubeAlong(pts, 0.028, MAT.wire, 18);
      wire.add(tube.geometry, 0, 0, 0);
    });
  });

  // —— 断落的一根：从电线杆垂到路面，末端偶尔打火花 ——
  const dropPts = [
    new THREE.Vector3(-10.7, surfaceY(-11.4, -26.8) + 7.05, -26.8),
    new THREE.Vector3(-10.0, 5.2, -26.1),
    new THREE.Vector3(-9.1, 3.0, -25.6),
    new THREE.Vector3(-8.3, 1.35, -25.1),
    new THREE.Vector3(-7.7, 0.32, -24.7),
    new THREE.Vector3(-7.1, 0.11, -24.2),
    new THREE.Vector3(-6.6, 0.09, -23.8),
  ];
  const drop = tubeAlong(dropPts, 0.032, MAT.wire, 26);
  wire.add(drop.geometry, 0, 0, 0);
  commit(wire, MAT.wire, g, 'wires');

  root.add(g);

  buildBrokenWireSpark(ctx, anim, new THREE.Vector3(-6.6, 0.12, -23.8), rng.fork(3));
}

/** 断裂电线末端：偶发短促爆闪 + 几个火星上飘 */
function buildBrokenWireSpark(
  ctx: BuildContext,
  anim: AnimList,
  anchor: THREE.Vector3,
  rng: Rng,
): void {
  const sparkRoot = group('prop-spark');
  const coreMat = basicMaterial(GLOW.fire, {
    opacity: 0.9,
    transparent: true,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const core = mesh(new THREE.SphereGeometry(0.11, 8, 6), coreMat);
  core.position.copy(anchor);
  core.castShadow = false;
  core.receiveShadow = false;
  sparkRoot.add(core);

  const halo = mesh(new THREE.SphereGeometry(0.3, 8, 6), coreMat);
  halo.position.copy(anchor);
  halo.castShadow = false;
  halo.receiveShadow = false;
  sparkRoot.add(halo);

  // 火星：Points，爆闪时上飘
  const count = 9;
  const posArr = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    seeds[i * 3] = rng.range(-1, 1);
    seeds[i * 3 + 1] = rng.range(0.35, 1.0);
    seeds[i * 3 + 2] = rng.range(-1, 1);
    posArr[i * 3] = anchor.x;
    posArr[i * 3 + 1] = anchor.y;
    posArr[i * 3 + 2] = anchor.z;
  }
  const pointsGeo = new THREE.BufferGeometry();
  pointsGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  const pointsMat = new THREE.PointsMaterial({
    color: GLOW.fire,
    size: 0.075,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const points = new THREE.Points(pointsGeo, pointsMat);
  points.frustumCulled = false;
  sparkRoot.add(points);

  ctx.addFx(sparkRoot);

  let flashStart = -10;
  let flashDur = 0.14;
  let nextAt = rng.range(1.2, 3.4);

  anim.push((t) => {
    if (t >= nextAt) {
      flashStart = t;
      flashDur = 0.1 + hashNoise(t * 3.71) * 0.14;
      // 2~5 秒后的下一次，偶尔连着来两下
      nextAt = t + 2.0 + hashNoise(t * 1.13) * 3.0;
      if (hashNoise(t * 7.7) > 0.7) nextAt = t + 0.32;
    }
    const k = (t - flashStart) / flashDur;
    let inten = 0;
    if (k >= 0 && k <= 1) {
      const stutter = hashNoise(Math.floor(t * 70) * 2.17) > 0.34 ? 1 : 0.22;
      inten = stutter * (1 - k * 0.55);
    } else {
      const after = t - (flashStart + flashDur);
      if (after > 0 && after < 0.4) inten = (1 - after / 0.4) * 0.16;
    }
    coreMat.opacity = 0.1 + 0.9 * inten;
    const s = 0.55 + 1.15 * inten;
    core.scale.setScalar(s);
    halo.scale.setScalar(0.7 + 2.1 * inten);
    pointsMat.opacity = Math.min(1, inten * 1.1);
    points.visible = inten > 0.03;
    if (points.visible) {
      const arr = pointsGeo.getAttribute('position') as THREE.BufferAttribute;
      const life = Math.max(0, Math.min(1, (t - flashStart) / (flashDur + 0.5)));
      for (let i = 0; i < count; i += 1) {
        const sx = seeds[i * 3];
        const sy = seeds[i * 3 + 1];
        const sz = seeds[i * 3 + 2];
        arr.setXYZ(
          i,
          anchor.x + sx * life * 0.5,
          anchor.y + 0.05 + sy * life * 0.95,
          anchor.z + sz * life * 0.5,
        );
      }
      arr.needsUpdate = true;
    }
  });
}

/* ------------------------------------------------------------------ *
 * 4. 交通信号灯
 * ------------------------------------------------------------------ */

function buildTrafficLights(root: THREE.Group, anim: AnimList, rng: Rng): void {
  const spotA = HOTSPOTS.trafficLights[0];
  const spotB = HOTSPOTS.trafficLights[1];

  const unitA = trafficUnit(
    root,
    spotA.x,
    spotA.z,
    Math.atan2(-spotA.x, -spotA.z),
    0.16,
    'alive',
    rng.fork(1),
  );
  const unitB = trafficUnit(
    root,
    spotB.x,
    spotB.z,
    Math.atan2(-spotB.x, -spotB.z),
    -0.3,
    'dead',
    rng.fork(2),
  );

  anim.push((t) => {
    // A：红灯常亮、绿灯偶发抽搐、黄灯几乎不动
    const sagA = 0.82 + 0.18 * hashNoise(Math.floor(t * 2.6) * 7.31);
    unitA.red.opacity = 0.78 * sagA;
    const burstA = hashNoise(Math.floor(t / 2.35) * 5.77) > 0.56 ? 1 : 0;
    const stutterA = 0.2 + 0.62 * hashNoise(Math.floor(t * 15) * 1.91);
    unitA.green.opacity = burstA * stutterA;
    unitA.amber.opacity = hashNoise(Math.floor(t / 3.4) * 3.17) > 0.94 ? 0.35 : 0.02;

    // B：整体断电，只余极弱的余辉与偶尔的红色抽动
    const emberB = 0.03 + 0.05 * hashNoise(Math.floor(t * 4.0) * 2.13);
    unitB.amber.opacity = emberB * 0.6;
    unitB.green.opacity = emberB * 0.5;
    const pulseB = hashNoise(Math.floor(t / 4.6) * 6.41);
    unitB.red.opacity = emberB + (pulseB > 0.74 ? 0.22 * (0.4 + 0.6 * hashNoise(Math.floor(t * 12) * 3.3)) : 0);
  });
}

interface TrafficUnit {
  red: THREE.MeshBasicMaterial;
  amber: THREE.MeshBasicMaterial;
  green: THREE.MeshBasicMaterial;
}

function trafficUnit(
  root: THREE.Group,
  x: number,
  z: number,
  yaw: number,
  tilt: number,
  state: 'alive' | 'dead',
  rng: Rng,
): TrafficUnit {
  const g = group('prop-traffic-light');
  at(g, x, surfaceY(x, z), z);
  g.rotation.y = yaw;
  g.rotation.z = tilt;

  const body = new Parts();
  body.add(new THREE.CylinderGeometry(0.17, 0.23, 0.28, 10), 0, 0.14, 0);
  body.add(new THREE.CylinderGeometry(0.072, 0.085, 3.7, 8), 0, 1.98, 0);
  // 控制箱
  body.add(new THREE.BoxGeometry(0.26, 0.38, 0.2), 0.02, 1.45, 0.04);
  // 灯箱
  body.add(new THREE.BoxGeometry(0.46, 1.16, 0.34), 0, 3.55, 0);
  body.add(new THREE.BoxGeometry(0.54, 1.24, 0.06), 0, 3.55, -0.2);
  // 灯位凹槽（深色底）
  for (const y of [3.92, 3.55, 3.18]) {
    body.add(new THREE.CylinderGeometry(0.152, 0.152, 0.05, 12), 0, y, 0.17, Math.PI / 2, 0, 0);
  }
  commit(body, MAT.poleSteel, g, 'traffic-body', 0.0024);

  // 遮光罩（坏掉的那个缺一片、另一片歪挂）
  const visors = new Parts();
  [3.92, 3.55, 3.18].forEach((y, i) => {
    const broken = state === 'dead' && i === 0;
    if (broken) {
      const bent = new THREE.BoxGeometry(0.3, 0.045, 0.2);
      visors.add(bent, 0.2, y - 0.16, 0.28, 0.9, 0, 0.7);
      return;
    }
    visors.add(new THREE.BoxGeometry(0.3, 0.045, 0.2), 0, y + 0.15, 0.26, -0.32, 0, 0);
    visors.add(new THREE.BoxGeometry(0.045, 0.14, 0.2), 0.15, y + 0.08, 0.26, -0.2, 0, 0);
    visors.add(new THREE.BoxGeometry(0.045, 0.14, 0.2), -0.15, y + 0.08, 0.26, -0.2, 0, 0);
  });
  commit(visors, MAT.steelDark, g, 'traffic-visors');

  const lens = (color: number, y: number, broken: boolean): THREE.MeshBasicMaterial => {
    const mat = glowMaterial(color, 0.9);
    if (!broken) {
      const m = mesh(new THREE.CircleGeometry(0.128, 12), mat);
      m.position.set(0, y, 0.225);
      m.castShadow = false;
      m.receiveShadow = false;
      g.add(m);
    }
    return mat;
  };

  const red = lens(PALETTE.signalRed, 3.92, false);
  const amber = lens(PALETTE.signalAmber, 3.55, false);
  const green = lens(PALETTE.signalGreen, 3.18, state === 'dead' && rng.chance(0.5));
  red.opacity = 0.8;

  root.add(g);
  return { red, amber, green };
}

/* ------------------------------------------------------------------ *
 * 5. 沙袋掩体
 * ------------------------------------------------------------------ */

let bagGeometryFlat: THREE.BufferGeometry | null = null;
let bagVariants: THREE.BufferGeometry[] = [];

/**
 * 高保真沙袋：柔软体块 + 中部收腰 + 两端鼓 + 一端袋口翻折。
 * 三个变体交替使用，避免整排沙袋"同一个模子"。
 */
function makeSandbagGeo(variant: number): THREE.BufferGeometry {
  const base = softBox(0.72, 0.24, 0.42, 0.10, MAT.sandbag).geometry.clone();
  const pos = base.getAttribute('position');
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const t = THREE.MathUtils.clamp(x / 0.36, -1, 1); // 沿袋口方向 -1..1
    // 中部收腰：cos(t·π) 在两端为 -1、中间为 +1
    const pinch = 1 - 0.20 * Math.cos(t * Math.PI) - 0.06 * variant;
    // 略不对称的压扁（沙袋不会方正）
    const asym = 0.94 + 0.10 * Math.sin(t * 5.3 + variant * 1.7);
    pos.setY(i, y * pinch * asym);
    pos.setZ(i, z * (0.96 + 0.05 * Math.cos(t * Math.PI)));
  }
  pos.needsUpdate = true;
  base.computeVertexNormals();

  // 袋口翻折（一端上方的小折片，带一点翘起）
  const flap = new THREE.BoxGeometry(0.15, 0.055, 0.24);
  flap.rotateZ(-0.32 + variant * 0.06);
  flap.rotateY(variant * 0.2);
  flap.translate(0.29, 0.10, variant === 1 ? 0.03 : -0.02);

  return mergeAll([base, flap]);
}

function sandbagGeoFlat(): THREE.BufferGeometry {
  if (!bagGeometryFlat) bagGeometryFlat = softBox(0.68, 0.14, 0.36, 0.09, MAT.sandbag).geometry;
  return bagGeometryFlat;
}

function bagGeoFor(rng: Rng): THREE.BufferGeometry {
  if (bagVariants.length === 0) {
    bagVariants = [makeSandbagGeo(0), makeSandbagGeo(1), makeSandbagGeo(2)];
  }
  return bagVariants[Math.floor(rng.next() * bagVariants.length) % bagVariants.length] as THREE.BufferGeometry;
}

function buildSandbags(root: THREE.Group, rng: Rng): void {
  const light = new Parts();
  const dark = new Parts();

  // 路口北侧检查站：横在纵街上，带一个短的折返
  sandbagWall(light, dark, rng, -5.4, -11.9, 0.06, 5.0, 3);
  sandbagWall(light, dark, rng, -7.6, -13.4, Math.PI / 2, 2.2, 2);
  // 路口东侧大道上的小型射击位
  sandbagWall(light, dark, rng, 10.6, 5.0, Math.PI / 2, 3.2, 3);
  // 东南角人行道拐角的哨位
  sandbagWall(light, dark, rng, 11.0, 11.6, 0.02, 2.4, 2);

  // 散落的破袋
  const scatters: Array<[number, number, number]> = [
    [-2.6, -11.2, 4],
    [-7.9, -9.6, 3],
    [10.9, 2.9, 3],
    [9.9, 12.9, 3],
    [13.2, 4.1, 2],
  ];
  for (const [cx, cz, n] of scatters) {
    for (let i = 0; i < n; i += 1) {
      const x = cx + rng.range(-1.6, 1.6);
      const z = cz + rng.range(-1.2, 1.2);
      const batch = rng.chance(0.5) ? light : dark;
      batch.add(
        rng.chance(0.45) ? sandbagGeoFlat() : bagGeoFor(rng),
        x,
        surfaceY(cx, cz) + 0.07,
        z,
        rng.gauss(0, 0.1),
        rng.range(0, Math.PI),
        rng.gauss(0, 0.12),
      );
    }
  }

  commit(light, MAT.sandbag, root, 'sandbags-a');
  commit(dark, MAT.sandbagDark, root, 'sandbags-b');
}

function sandbagWall(
  light: Parts,
  dark: Parts,
  rng: Rng,
  cx: number,
  cz: number,
  yaw: number,
  length: number,
  layers: number,
): void {
  const dx = Math.cos(yaw);
  const dz = Math.sin(yaw);
  const bagYaw = Math.atan2(-dz, dx);
  const baseY = surfaceY(cx, cz);
  const step = 0.63;
  for (let layer = 0; layer < layers; layer += 1) {
    const count = Math.max(2, Math.round(length / step) - layer);
    const span = (count - 1) * step;
    for (let i = 0; i < count; i += 1) {
      const t = -span / 2 + i * step + (layer % 2 === 0 ? 0 : step * 0.5);
      const px = cx + dx * t + rng.gauss(0, 0.022);
      const pz = cz + dz * t + rng.gauss(0, 0.022);
      const py = baseY + 0.115 + layer * 0.195 + rng.gauss(0, 0.012);
      const batch = rng.chance(0.5) ? light : dark;
      batch.add(
        bagGeoFor(rng),
        px,
        py,
        pz,
        rng.gauss(0, 0.03),
        bagYaw + rng.gauss(0, 0.07),
        rng.gauss(0, 0.035),
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * 6. 反坦克拒马（捷克刺猬）
 * ------------------------------------------------------------------ */

function buildHedgehogs(root: THREE.Group, rng: Rng): void {
  const batch = new Parts();
  const beam = new THREE.BoxGeometry(1.98, 0.16, 0.15);
  const yBeam = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  const zBeam = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

  const spots: Array<[number, number, number, number, boolean]> = [
    [9.6, -7.2, 0.5, 0.1, false],
    [13.9, 4.4, -0.9, 0.16, false],
    [-6.6, 7.8, 0.25, 0.12, false],
    [-2.6, 11.4, 1.1, 1.35, true],
    [-13.4, -6.4, -0.4, 0.2, false],
  ];

  for (const [x, z, yaw, tilt, fallen] of spots) {
    const q = new THREE.Quaternion()
      .setFromAxisAngle(Y_AXIS, yaw + rng.gauss(0, 0.15))
      .multiply(
        new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(Math.cos(rng.range(0, 3)), 0.25, Math.sin(rng.range(0, 3))).normalize(),
          tilt,
        ),
      );
    const groundY = surfaceY(x, z);
    const center = new THREE.Vector3(x, groundY + (fallen ? 0.52 : 0.58), z);
    const offset = new THREE.Vector3(0, 0.04, 0).applyQuaternion(q);
    const origin = center.clone().add(offset);
    batch.addQ(beam, origin, q);
    batch.addQ(beam, origin, q.clone().multiply(yBeam));
    batch.addQ(beam, origin, q.clone().multiply(zBeam));
    // 交叉处的焊接加强块
    batch.addQ(new THREE.BoxGeometry(0.3, 0.3, 0.3), origin, q);
  }

  commit(batch, MAT.rust, root, 'hedgehogs', 0.0024);
}

/* ------------------------------------------------------------------ *
 * 7. 轮胎路障
 * ------------------------------------------------------------------ */

function buildTireBarricade(root: THREE.Group, rng: Rng): void {
  const tires = new Parts();
  const burntTires = new Parts();
  const bar = new Parts();
  const torusGeo = new THREE.TorusGeometry(0.34, 0.125, 6, 10);

  // 轮胎堆：4 个，微错位 + 中间穿一根钢管
  const sx = 13.4;
  const sz = 8.4;
  const sy = surfaceY(sx, sz);
  // 胎面花纹块（沿轮胎外缘一圈，instanced 前先攒进 batch）——让轮胎有"橡胶胎纹"的读感
  const treadGeo = new THREE.BoxGeometry(0.09, 0.11, 0.05);
  for (let i = 0; i < 4; i += 1) {
    const cx = sx + rng.gauss(0, 0.05);
    const cy = sy + 0.13 + i * 0.255;
    const cz = sz + rng.gauss(0, 0.05);
    tires.add(
      torusGeo,
      cx,
      cy,
      cz,
      Math.PI / 2 + rng.gauss(0, 0.05),
      rng.range(0, Math.PI),
      rng.gauss(0, 0.04),
    );
    // 胎纹：每个轮胎 14 块，环绕胎面（用 radialBlocks 复用同一个几何体）
    radialBlocks(tires, treadGeo, cx, cy, cz, 0.455, 14, rng.range(0, 1), 1, 1, 1);
  }
  bar.add(
    new THREE.CylinderGeometry(0.05, 0.05, 2.0, 6),
    sx + 0.1,
    sy + 0.55,
    sz - 0.1,
    0.28,
    0.4,
    0.55,
  );

  // 半埋在泥里的两只，靠在路缘
  const lean: Array<[number, number, number, number]> = [
    [-9.4, 6.2, 0.66, 0.9],
    [-9.8, 5.0, 0.7, 0.6],
    [9.2, -12.6, 0.5, 0.2],
  ];
  for (const [x, z, tilt, spin] of lean) {
    tires.add(torusGeo, x, surfaceY(x, z) + 0.2, z, Math.PI / 2 - tilt, spin, rng.gauss(0, 0.05));
  }

  // 烧焦的两只：平放在路边，半埋
  burntTires.add(torusGeo, 12.6, sy + 0.06, 9.3, Math.PI / 2, 0.4, 0);
  burntTires.add(torusGeo, 12.1, sy + 0.05, 9.6, Math.PI / 2, 1.2, 0);
  burntTires.add(torusGeo, -3.4, surfaceY(-3.4, 12.7) + 0.05, 12.7, Math.PI / 2, 0.7, 0);

  commit(tires, MAT.tire, root, 'tires');
  commit(burntTires, MAT.burnt, root, 'tires-burnt');
  commit(bar, MAT.steel, root, 'tire-bar');
}

/* ------------------------------------------------------------------ *
 * 8. 街角护栏
 * ------------------------------------------------------------------ */

function buildGuardrail(root: THREE.Group, rng: Rng): void {
  const batch = new Parts();
  const post = new THREE.BoxGeometry(0.07, 1.0, 0.07);
  const rail = new THREE.BoxGeometry(1, 0.055, 0.04);
  const baluster = new THREE.BoxGeometry(0.032, 0.9, 0.03);

  const runs: Array<[number, number, number, number]> = [
    [13.8, -9.32, 22.4, -9.32],
    [8.32, 14.2, 8.32, 21.4],
    [-8.32, -16.4, -8.32, -23.2],
    [-24.4, 9.32, -17.6, 9.32],
  ];

  runs.forEach(([x0, z0, x1, z1], runIndex) => {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const ux = dx / len;
    const uz = dz / len;
    const segments = Math.max(1, Math.round(len / 1.9));
    const segLen = len / segments;
    const yaw = Math.atan2(-uz, ux);
    const yawQ = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, yaw);
    const baseY = surfaceY((x0 + x1) / 2, (z0 + z1) / 2);

    for (let i = 0; i < segments; i += 1) {
      const damaged = rng.chance(0.26);
      if (damaged && rng.chance(0.4)) continue; // 完全缺失的缺口
      const lean = damaged ? rng.range(0.16, 0.46) * (runIndex % 2 === 0 ? 1 : -1) : 0;
      const q = yawQ
        .clone()
        .multiply(
          lean === 0
            ? new THREE.Quaternion()
            : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), lean),
        );
      const origin = new THREE.Vector3(x0 + ux * i * segLen, baseY, z0 + uz * i * segLen);
      const half = segLen / 2;
      const addLocal = (
        geometry: THREE.BufferGeometry,
        lx: number,
        ly: number,
        lz: number,
        extraQ?: THREE.Quaternion,
      ): void => {
        const p = new THREE.Vector3(lx - half, ly, lz).applyQuaternion(q).add(origin);
        batch.addQ(geometry, p, extraQ ? q.clone().multiply(extraQ) : q);
      };
      addLocal(post, 0.08, 0.5, 0);
      addLocal(post, segLen - 0.08, 0.5, 0);
      addLocal(rail, half, 1.0, 0, undefined);
      addLocal(rail, half, 0.62, 0);
      for (let b = 0; b < 3; b += 1) {
        addLocal(baluster, 0.42 + b * ((segLen - 0.84) / 2), 0.55, 0);
      }
      // 立柱底脚
      addLocal(new THREE.BoxGeometry(0.16, 0.08, 0.16), 0.08, 0.04, 0);
      addLocal(new THREE.BoxGeometry(0.16, 0.08, 0.16), segLen - 0.08, 0.04, 0);
    }
  });

  // 一段被撞翻、横躺在路缘上的护栏（放在路口以东的路缘，不压车道也不堵路口）
  const fallenQ = new THREE.Quaternion()
    .setFromAxisAngle(Y_AXIS, 0.1)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.48));
  const fallenOrigin = new THREE.Vector3(13.2, surfaceY(13.2, -9.9) + 0.2, -9.9);
  for (let i = 0; i < 2; i += 1) {
    const p = new THREE.Vector3(i * 1.85 - 0.9, 0, 0).applyQuaternion(fallenQ).add(fallenOrigin);
    batch.addQ(rail, p.clone().add(new THREE.Vector3(0, 0.5, 0).applyQuaternion(fallenQ)), fallenQ);
    batch.addQ(post, p.clone().add(new THREE.Vector3(0.9, 0.2, 0).applyQuaternion(fallenQ)), fallenQ);
  }

  commit(batch, MAT.steel, root, 'guardrails', 0.0024);
}

/* ------------------------------------------------------------------ *
 * 9. 残破公告栏 / 海报栏
 * ------------------------------------------------------------------ */

function buildNoticeBoard(root: THREE.Group, rng: Rng): void {
  const bx = -15.4;
  const bz = 12.2;
  const g = group('prop-notice-board');
  at(g, bx, surfaceY(bx, bz), bz);
  g.rotation.y = Math.PI + 0.06;
  g.rotation.z = 0.018;

  const frame = new Parts();
  frame.add(new THREE.BoxGeometry(0.1, 2.2, 0.1), -0.98, 1.1, 0);
  frame.add(new THREE.BoxGeometry(0.1, 2.2, 0.1), 0.98, 1.1, 0);
  frame.add(new THREE.BoxGeometry(2.14, 1.26, 0.08), 0, 1.62, -0.03);
  // 木框四条
  frame.add(new THREE.BoxGeometry(2.3, 0.11, 0.13), 0, 2.3, 0.03);
  frame.add(new THREE.BoxGeometry(2.3, 0.11, 0.13), 0, 0.96, 0.03);
  frame.add(new THREE.BoxGeometry(0.11, 1.4, 0.13), -1.1, 1.63, 0.03);
  frame.add(new THREE.BoxGeometry(0.11, 1.4, 0.13), 1.1, 1.63, 0.03);
  // 小披檐（歪的）
  frame.add(new THREE.BoxGeometry(2.44, 0.06, 0.34), 0.02, 2.42, 0.1, -0.14, 0, 0.03);
  commit(frame, MAT.wood, g, 'board-frame', 0.0022);

  // 背板（深色软木）
  const panel = mesh(new THREE.BoxGeometry(2.06, 1.18, 0.04), MAT.woodDark);
  panel.position.set(0, 1.62, 0.02);
  g.add(panel);

  // 玻璃：两片完好、一片碎了
  const glassMat = glassMaterial(PALETTE.glassDark, 0.5);
  const paneA = mesh(new THREE.PlaneGeometry(1.0, 1.14), glassMat);
  paneA.position.set(-0.51, 1.62, 0.1);
  g.add(paneA);
  const paneBroken = mesh(new THREE.PlaneGeometry(0.98, 1.14), glassMat);
  paneBroken.position.set(0.53, 1.62, 0.1);
  paneBroken.rotation.z = -0.02;
  g.add(paneBroken);
  const crack = mesh(
    new THREE.PlaneGeometry(0.96, 1.12),
    new THREE.MeshBasicMaterial({
      map: crackTexture(),
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  crack.castShadow = false;
  crack.position.set(0.53, 1.62, 0.115);
  g.add(crack);

  // 海报
  const posterDefs: Array<[number, number, number, number, number, boolean]> = [
    [-0.62, 1.78, 0.56, 0.78, 0.04, false],
    [-0.06, 1.5, 0.5, 0.7, -0.05, false],
    [0.62, 1.72, 0.44, 0.62, 0.12, true],
  ];
  posterDefs.forEach(([px, py, w, h, rot, peeling], i) => {
    const mat = new THREE.MeshToonMaterial({
      map: posterTexture(rng, i % 2),
      gradientMap: toonGradient(3),
      transparent: true,
      side: THREE.DoubleSide,
    });
    const geo = new THREE.PlaneGeometry(w, h, 1, 4);
    if (peeling) {
      // 被雨水打湿卷起的下缘
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      for (let v = 0; v < pos.count; v += 1) {
        const yy = pos.getY(v);
        const t = Math.max(0, -yy / (h / 2));
        pos.setZ(v, t * t * 0.16);
        pos.setY(v, yy + t * t * 0.05);
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();
    }
    const poster = mesh(geo, mat);
    poster.position.set(px, py, 0.115 + i * 0.004);
    poster.rotation.z = rot;
    g.add(poster);
  });

  // 落在地上的一块碎玻璃
  const shard = mesh(new THREE.PlaneGeometry(0.26, 0.18), glassMat);
  shard.rotation.x = -Math.PI / 2;
  shard.rotation.z = 0.7;
  shard.position.set(0.9, 0.012, 0.42);
  g.add(shard);

  root.add(g);
}

/* ------------------------------------------------------------------ *
 * 10. 临时路障与警戒带
 * ------------------------------------------------------------------ */

interface TapeState {
  mesh: THREE.Mesh;
  base: Float32Array;
  phase: number;
}

function buildTapeBarrier(root: THREE.Group, anim: AnimList, rng: Rng): void {
  // —— A 形木马架 ——
  const trestle = new Parts();
  const trestleLegs: Array<[number, number, number]> = [
    [-3.6, -14.2, 0.12],
    [-0.4, -14.7, -0.1],
  ];
  trestleLegs.forEach(([tx, tz, yaw]) => {
    const base = surfaceY(tx, tz);
    const q = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, yaw);
    const addLocal = (geo: THREE.BufferGeometry, lx: number, ly: number, lz: number): void => {
      const p = new THREE.Vector3(lx, ly, lz).applyQuaternion(q).add(new THREE.Vector3(tx, base, tz));
      trestle.addQ(geo, p, q);
    };
    // 四条 A 形腿
    addLocal(new THREE.BoxGeometry(0.055, 1.12, 0.055), -0.42, 0.55, 0.24);
    addLocal(new THREE.BoxGeometry(0.055, 1.12, 0.055), -0.42, 0.55, -0.24);
    addLocal(new THREE.BoxGeometry(0.055, 1.12, 0.055), 0.42, 0.55, 0.24);
    addLocal(new THREE.BoxGeometry(0.055, 1.12, 0.055), 0.42, 0.55, -0.24);
    // 横撑
    addLocal(new THREE.BoxGeometry(0.05, 0.05, 0.62), -0.42, 0.42, 0);
    addLocal(new THREE.BoxGeometry(0.05, 0.05, 0.62), 0.42, 0.42, 0);
    // 顶部横梁（木板本体在下面单独贴条纹贴图）
    addLocal(new THREE.BoxGeometry(1.02, 0.07, 0.09), 0, 1.1, 0);
  });
  commit(trestle, MAT.woodDark, root, 'trestle');

  const stripeMat = new THREE.MeshBasicMaterial({
    map: tapeTexture(),
    color: 0x9d9a90,
    side: THREE.DoubleSide,
  });
  trestleLegs.forEach(([tx, tz, yaw]) => {
    const base = surfaceY(tx, tz);
    const plank = mesh(new THREE.BoxGeometry(1.28, 0.24, 0.04), stripeMat);
    at(plank, tx, base + 1.02, tz, yaw);
    plank.rotation.z = 0.03;
    root.add(plank);
  });

  // —— 警戒带 ——
  const tapeMat = new THREE.MeshBasicMaterial({
    map: tapeTexture(),
    color: 0xb0aca2,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.96,
  });
  const tapes: TapeState[] = [];

  const posts = new Parts();
  const postGeo = new THREE.CylinderGeometry(0.035, 0.045, 1.2, 6);
  const anchors: Array<[number, number, number, number]> = [
    [-7.7, -13.2, -1.3, -13.9],
    [8.7, 12.6, 12.3, 10.4],
  ];
  anchors.forEach(([ax, az, bx2, bz2], i) => {
    const ay = surfaceY(ax, az);
    const by = surfaceY(bx2, bz2);
    posts.add(postGeo, ax, ay + 0.6, az, 0, 0, rng.gauss(0, 0.03));
    posts.add(postGeo, bx2, by + 0.6, bz2, 0, 0, rng.gauss(0, 0.03));
    const from = new THREE.Vector3(ax, ay + 1.08, az);
    const to = new THREE.Vector3(bx2, by + 1.02, bz2);
    tapes.push(makeTape(from, to, i === 0 ? 0.32 : 0.2, 0.075, 16, tapeMat, i));
  });
  commit(posts, MAT.steel, root, 'tape-posts');
  tapes.forEach((t) => root.add(t.mesh));

  anim.push((t) => {
    for (const tape of tapes) {
      const geo = tape.mesh.geometry;
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      for (let v = 0; v < pos.count; v += 1) {
        const baseX = tape.base[v * 3];
        const baseY = tape.base[v * 3 + 1];
        const baseZ = tape.base[v * 3 + 2];
        const wave = Math.sin(t * 1.35 + baseX * 1.7 + tape.phase) * 0.022;
        const wave2 = Math.sin(t * 2.6 + baseX * 3.1 + tape.phase * 2.0) * 0.009;
        pos.setXYZ(v, baseX, baseY + wave + wave2, baseZ + wave * 0.55);
      }
      pos.needsUpdate = true;
    }
  });
}

function makeTape(
  from: THREE.Vector3,
  to: THREE.Vector3,
  sag: number,
  height: number,
  segments: number,
  material: THREE.Material,
  index: number,
): TapeState {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const p = from.clone().lerp(to, t);
    p.y -= Math.sin(Math.PI * t) * sag;
    positions.push(p.x, p.y + height / 2, p.z);
    positions.push(p.x, p.y - height / 2, p.z);
    uvs.push(t * 7, 1, t * 7, 0);
  }
  for (let i = 0; i < segments; i += 1) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const m = mesh(geo, material);
  m.castShadow = false;
  const base = Float32Array.from(positions);
  return { mesh: m, base, phase: index * 1.7 + 0.4 };
}

/* ------------------------------------------------------------------ *
 * 11. 杂物：垃圾桶、木箱、油桶、手推板车
 * ------------------------------------------------------------------ */

function buildClutter(root: THREE.Group, anim: AnimList, rng: Rng): void {
  const wood = new Parts();
  const rust = new Parts();
  const paint = new Parts();
  const cardboard = new Parts();

  // 翻倒的垃圾桶（单独一个网格，好做被雨滴打到的微抖）
  const binPivots: Array<{ mesh: THREE.Mesh; base: THREE.Euler; phase: number }> = [];
  const makeBin = (x: number, z: number, tipped: boolean, rotY: number): void => {
    const b = new Parts();
    b.add(new THREE.CylinderGeometry(0.3, 0.25, 0.72, 10), 0, 0.36, 0);
    b.add(new THREE.TorusGeometry(0.3, 0.025, 4, 10), 0, 0.7, 0, Math.PI / 2, 0, 0);
    b.add(new THREE.CylinderGeometry(0.31, 0.31, 0.05, 10), 0, 0.745, 0.03, 0.16, 0, 0.1);
    const m = b.take(MAT.plastic, 'trash-bin');
    if (!m) return;
    const g = group('prop-bin');
    at(g, x, surfaceY(x, z) + (tipped ? 0.29 : 0), z);
    g.rotation.y = rotY;
    if (tipped) {
      g.rotation.z = 1.42;
      g.rotation.y = rotY + 0.5;
    }
    g.add(m);
    root.add(g);
    binPivots.push({ mesh: m, base: m.rotation.clone(), phase: rng.range(0, 6.28) });
  };
  makeBin(9.7, 12.3, true, 0.4);
  makeBin(-9.3, -12.4, false, -0.6);

  // 木箱
  const crateDefs: Array<[number, number, number, number]> = [
    [-8.9, 8.6, 0.6, 0.3],
    [-9.6, 9.0, 0.52, -0.7],
    [-8.7, 8.1, 0.46, 1.1],
    [13.0, -8.5, 0.56, 0.2],
    [-13.2, -14.6, 0.5, -0.3],
  ];
  for (const [x, z, size, rot] of crateDefs) {
    const y = surfaceY(x, z);
    wood.add(new THREE.BoxGeometry(size, size, size), x, y + size / 2, z, 0, rot, rng.gauss(0, 0.03));
    // 箱板条
    for (let i = 0; i < 2; i += 1) {
      wood.add(
        new THREE.BoxGeometry(size * 1.02, 0.05, 0.04),
        x,
        y + size * (0.28 + i * 0.44),
        z + size / 2,
        0,
        rot,
        0,
      );
    }
  }
  // 叠起来的那一箱
  wood.add(new THREE.BoxGeometry(0.48, 0.48, 0.48), -9.2, surfaceY(-9.2, 8.75) + 0.62, 8.75, 0, 0.15, 0.05);

  // 油桶：两只立着、一只翻倒、一只烧黑（桶盖带铆钉圈，桶身有凹痕）
  const barrel = (x: number, z: number, tipped: boolean, batch: Parts): void => {
    const y = surfaceY(x, z);
    if (tipped) {
      batch.add(new THREE.CylinderGeometry(0.29, 0.29, 0.88, 10), x, y + 0.28, z, 0, 0.6, Math.PI / 2 - 0.08);
    } else {
      batch.add(new THREE.CylinderGeometry(0.29, 0.29, 0.88, 10), x, y + 0.44, z, 0, rng.range(0, 3), 0);
      batch.add(new THREE.TorusGeometry(0.295, 0.022, 4, 10), x, y + 0.3, z, Math.PI / 2, 0, 0);
      batch.add(new THREE.TorusGeometry(0.295, 0.022, 4, 10), x, y + 0.62, z, Math.PI / 2, 0, 0);
      // 桶盖铆钉圈 + 顶盖加厚
      batch.add(new THREE.CylinderGeometry(0.30, 0.30, 0.045, 10), x, y + 0.88, z, 0, 0, 0);
      boltRing(batch, x, y + 0.905, z, 0.21, 8, 0.028);
    }
  };
  barrel(13.3, -8.1, false, paint);
  barrel(14.1, -8.7, false, rust);
  barrel(13.6, -7.3, true, rust);
  barrel(-12.9, 9.6, true, paint);
  // 烧黑的那只（倒在路缘）
  const burntBarrel = new Parts();
  burntBarrel.add(new THREE.CylinderGeometry(0.29, 0.29, 0.88, 10), 14.6, surfaceY(14.6, -7.9) + 0.27, -7.9, 0, 1.1, Math.PI / 2 - 0.1);
  burntBarrel.add(new THREE.CylinderGeometry(0.24, 0.24, 0.05, 10), 15.02, surfaceY(14.6, -7.9) + 0.3, -7.95, 0, 1.1, Math.PI / 2);
  commit(burntBarrel, MAT.burnt, root, 'clutter-burnt-barrel');

  // 手推板车
  const cartX = -11.2;
  const cartZ = 10.0;
  const cartY = surfaceY(cartX, cartZ);
  const cartYaw = 0.7;
  const cartQ = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, cartYaw);
  const addCart = (geo: THREE.BufferGeometry, lx: number, ly: number, lz: number, extraQ?: THREE.Quaternion): void => {
    const p = new THREE.Vector3(lx, ly, lz).applyQuaternion(cartQ).add(new THREE.Vector3(cartX, cartY, cartZ));
    wood.addQ(geo, p, extraQ ? cartQ.clone().multiply(extraQ) : cartQ);
  };
  addCart(new THREE.BoxGeometry(1.32, 0.06, 0.72), 0, 0.42, 0);
  addCart(new THREE.BoxGeometry(1.32, 0.05, 0.05), 0, 0.72, 0.33);
  addCart(new THREE.BoxGeometry(1.32, 0.05, 0.05), 0, 0.72, -0.33);
  addCart(new THREE.BoxGeometry(0.05, 0.34, 0.05), -0.6, 0.56, 0.33);
  addCart(new THREE.BoxGeometry(0.05, 0.34, 0.05), -0.6, 0.56, -0.33);
  // 把手
  const wheelQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  const wheelGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.07, 10);
  addCart(wheelGeo, 0.48, 0.24, 0.3, wheelQ);
  addCart(wheelGeo, 0.48, 0.24, -0.3, wheelQ);
  addCart(new THREE.CylinderGeometry(0.03, 0.03, 1.3, 5), 1.42, 0.78, 0.3, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2.6));
  // 车上的一包东西
  cardboard.add(new THREE.BoxGeometry(0.5, 0.32, 0.42), cartX + 0.2, cartY + 0.6, cartZ, 0, cartYaw + 0.2, 0);

  // 翻倒的购物推车
  const trolley = new Parts();
  const tX = -10.2;
  const tZ = 7.4;
  const tY = surfaceY(tX, tZ);
  const tQ = new THREE.Quaternion()
    .setFromAxisAngle(Y_AXIS, -0.6)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.34));
  const addTrolley = (geo: THREE.BufferGeometry, lx: number, ly: number, lz: number): void => {
    const p = new THREE.Vector3(lx, ly, lz).applyQuaternion(tQ).add(new THREE.Vector3(tX, tY + 0.34, tZ));
    trolley.addQ(geo, p, tQ);
  };
  addTrolley(new THREE.BoxGeometry(0.86, 0.03, 0.52), 0, 0.26, 0);
  addTrolley(new THREE.BoxGeometry(0.86, 0.34, 0.03), 0, 0.43, 0.26);
  addTrolley(new THREE.BoxGeometry(0.86, 0.34, 0.03), 0, 0.43, -0.26);
  addTrolley(new THREE.BoxGeometry(0.03, 0.34, 0.52), -0.43, 0.43, 0);
  addTrolley(new THREE.BoxGeometry(0.03, 0.34, 0.52), 0.43, 0.43, 0);
  addTrolley(new THREE.BoxGeometry(0.62, 0.035, 0.035), -0.5, 0.73, 0);
  for (const [wx, wz] of [
    [-0.36, 0.2],
    [-0.36, -0.2],
    [0.36, 0.2],
    [0.36, -0.2],
  ] as Array<[number, number]>) {
    addTrolley(new THREE.CylinderGeometry(0.062, 0.062, 0.04, 8), wx, 0.06, wz);
  }
  commit(trolley, MAT.steelBright, root, 'clutter-trolley');

  // 破板子靠在路缘
  for (let i = 0; i < 3; i += 1) {
    wood.add(
      new THREE.BoxGeometry(1.1, 0.05, 0.22),
      -15.0 + i * 0.14,
      surfaceY(-15.0, 11.0) + 0.55,
      11.0 + i * 0.3,
      0.2,
      rng.range(-0.3, 0.3),
      1.24,
    );
  }

  commit(wood, MAT.wood, root, 'clutter-wood');
  commit(rust, MAT.barrelRust, root, 'clutter-rust');
  commit(paint, MAT.barrel, root, 'clutter-barrels');
  commit(cardboard, MAT.cardboard, root, 'clutter-cardboard');

  // 雨滴打到的微抖（极小幅度）
  const triggered: number[] = binPivots.map(() => rng.range(0.5, 4));
  anim.push((t) => {
    binPivots.forEach((bin, i) => {
      if (t < triggered[i]) return;
      const k = (t - triggered[i]) / 0.34;
      if (k > 1) {
        triggered[i] = t + 1.6 + hashNoise(t * 2.7 + i) * 3.6;
        bin.mesh.rotation.z = bin.base.z;
        bin.mesh.rotation.x = bin.base.x;
        return;
      }
      const amp = (1 - k) * 0.035;
      bin.mesh.rotation.z = bin.base.z + Math.sin(k * 26) * amp;
      bin.mesh.rotation.x = bin.base.x + Math.cos(k * 31) * amp * 0.6;
    });
  });
}

/* ------------------------------------------------------------------ *
 * 12. 小巷入口的废物堆
 * ------------------------------------------------------------------ */

function buildAlleyJunk(root: THREE.Group, rng: Rng): void {
  const wood = new Parts();
  const metal = new Parts();
  const boxes = new Parts();
  const steel = new Parts();

  const ax = -14.6;
  const az = -15.6;
  const ay = surfaceY(ax, az);

  // 靠墙斜放的木板堆
  for (let i = 0; i < 5; i += 1) {
    wood.add(
      new THREE.BoxGeometry(1.9, 0.07, 0.24),
      ax + 0.1 + i * 0.06,
      ay + 0.9,
      az + i * 0.34,
      0.95,
      0.06 * i,
      -0.14 + i * 0.02,
    );
  }
  // 铁皮（弯的）
  metal.add(new THREE.BoxGeometry(1.5, 0.03, 0.86), ax + 0.2, ay + 0.32, az + 1.35, 0.16, 0.5, 0.22);
  metal.add(new THREE.BoxGeometry(1.1, 0.03, 0.6), ax - 0.15, ay + 0.62, az + 1.1, -0.5, 1.1, 0.1);
  // 捆扎的废纸箱
  const boxDefs: Array<[number, number, number, number]> = [
    [ax + 0.9, ay + 0.26, az + 2.1, 0.5],
    [ax + 0.95, ay + 0.72, az + 2.15, 0.42],
    [ax + 0.2, ay + 0.24, az + 2.5, 0.46],
  ];
  for (const [x, y, z, s] of boxDefs) {
    boxes.add(new THREE.BoxGeometry(s, s * 0.8, s * 0.7), x, y, z, rng.gauss(0, 0.05), rng.range(0, 1.5), rng.gauss(0, 0.06));
  }
  // 捆绳
  metal.add(new THREE.TorusGeometry(0.42, 0.014, 4, 10), ax + 0.9, ay + 0.42, az + 2.12, Math.PI / 2, 0, 0);
  // 散落的瓶子/铁罐
  for (let i = 0; i < 5; i += 1) {
    steel.add(
      new THREE.CylinderGeometry(0.045, 0.045, 0.12, 6),
      ax + rng.range(-0.6, 1.6),
      ay + 0.06,
      az + rng.range(1.0, 2.8),
      Math.PI / 2,
      rng.range(0, 3),
      0,
    );
  }

  // 钉在墙上的信箱
  const mailbox = (x: number, z: number, y: number, yaw: number): void => {
    const q = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, yaw);
    const addLocal = (geo: THREE.BufferGeometry, lx: number, ly: number, lz: number): void => {
      const p = new THREE.Vector3(lx, ly, lz).applyQuaternion(q).add(new THREE.Vector3(x, y, z));
      steel.addQ(geo, p, q);
    };
    addLocal(new THREE.BoxGeometry(0.3, 0.38, 0.16), 0, 0, 0);
    addLocal(new THREE.BoxGeometry(0.26, 0.03, 0.02), 0, 0.06, 0.09);
    addLocal(new THREE.BoxGeometry(0.06, 0.12, 0.02), 0.1, -0.09, 0.09);
  };
  mailbox(-15.85, -14.4, 1.52, Math.PI / 2);
  mailbox(-15.85, -14.05, 1.16, Math.PI / 2);

  commit(wood, MAT.wood, root, 'alley-planks');
  commit(metal, MAT.rustBright, root, 'alley-sheet');
  commit(boxes, MAT.cardboard, root, 'alley-boxes');
  commit(steel, MAT.steelDark, root, 'alley-mailboxes');
}

/* ------------------------------------------------------------------ *
 * 13. 成簇的瓦砾、弹壳、落叶（instanced）
 * ------------------------------------------------------------------ */

interface Cluster {
  x: number;
  z: number;
  r: number;
  n: number;
}

function buildDebris(ctx: BuildContext, root: THREE.Group, rng: Rng): void {
  const q = ctx.quality;

  // 沿路缘、墙根、弹坑成簇分布（不是均匀撒）
  const rubbleClusters: Cluster[] = [
    { x: -20.0, z: -9.2, r: 2.4, n: 16 },
    { x: -4.0, z: 9.3, r: 2.2, n: 14 },
    { x: 22.0, z: 9.2, r: 2.6, n: 16 },
    { x: 34.0, z: -9.1, r: 2.2, n: 12 },
    { x: 8.3, z: 18.0, r: 2.2, n: 14 },
    { x: -8.3, z: -18.0, r: 2.4, n: 14 },
    { x: 16.2, z: -12.4, r: 1.8, n: 12 },
    { x: -13.2, z: -12.5, r: 1.6, n: 10 },
    { x: 6.5, z: 12.5, r: 2.6, n: 18 },
    { x: -6.5, z: -15.5, r: 2.4, n: 16 },
    { x: 24.0, z: 8.5, r: 2.2, n: 14 },
    { x: -5.4, z: -12.6, r: 1.8, n: 12 },
    { x: 9.4, z: -6.9, r: 1.6, n: 10 },
    { x: 18.6, z: -12.6, r: 1.7, n: 10 },
  ];

  const rubbleTransforms = [];
  for (const c of rubbleClusters) {
    const count = Math.round(c.n * (0.6 + 0.4 * q));
    const groundY = surfaceY(c.x, c.z);
    for (let i = 0; i < count; i += 1) {
      const a = rng.range(0, Math.PI * 2);
      const rad = Math.sqrt(rng.next()) * c.r;
      const scale = rng.range(0.28, 0.95) * (rng.chance(0.15) ? 1.7 : 1);
      rubbleTransforms.push({
        position: new THREE.Vector3(
          c.x + Math.cos(a) * rad,
          groundY + scale * 0.06,
          c.z + Math.sin(a) * rad,
        ),
        rotation: new THREE.Euler(rng.range(0, 3.14), rng.range(0, 6.28), rng.range(0, 3.14)),
        scale: new THREE.Vector3(scale, scale * rng.range(0.5, 0.9), scale),
      });
    }
  }
  const rubbleGeo = jitter(new THREE.DodecahedronGeometry(0.19, 0), 0.045, rng);
  const rubble = instanced(rubbleGeo, MAT.dirt, rubbleTransforms);
  rubble.name = 'rubble-instanced';
  root.add(rubble);

  // 弹壳：成堆落在掩体/拒马/路缘边
  const casingClusters: Cluster[] = [
    { x: -5.2, z: -11.0, r: 1.3, n: 46 },
    { x: -2.2, z: -12.4, r: 1.1, n: 34 },
    { x: 9.8, z: 4.1, r: 1.2, n: 40 },
    { x: 12.2, z: 5.4, r: 1.0, n: 28 },
    { x: 8.2, z: -6.6, r: 1.1, n: 30 },
    { x: 10.4, z: 11.2, r: 1.0, n: 26 },
    { x: -8.9, z: -9.6, r: 1.2, n: 30 },
    { x: 4.6, z: 11.0, r: 1.4, n: 34 },
    { x: -13.2, z: -6.0, r: 1.2, n: 24 },
    { x: 26.0, z: 1.8, r: 1.5, n: 30 },
  ];
  const casingTransforms = [];
  for (const c of casingClusters) {
    const count = Math.round(c.n * (0.55 + 0.45 * q));
    const groundY = surfaceY(c.x, c.z);
    for (let i = 0; i < count; i += 1) {
      const a = rng.range(0, Math.PI * 2);
      const rad = Math.sqrt(rng.next()) * c.r;
      casingTransforms.push({
        position: new THREE.Vector3(
          c.x + Math.cos(a) * rad,
          groundY + 0.022 + rng.range(0, 0.02),
          c.z + Math.sin(a) * rad,
        ),
        rotation: new THREE.Euler(Math.PI / 2 + rng.gauss(0, 0.12), rng.range(0, 6.28), rng.gauss(0, 0.12)),
        scale: new THREE.Vector3(1, 1, 1),
      });
    }
  }
  const casing = instanced(
    new THREE.CylinderGeometry(0.018, 0.018, 0.075, 5, 1),
    MAT.brass,
    casingTransforms,
  );
  casing.name = 'casings-instanced';
  root.add(casing);

  // 积水边的落叶与垃圾
  const leafClusters: Array<[number, number, number]> = [
    [-8.6, -6.5, 1.6],
    [12.0, 5.6, 1.4],
    [4.5, -3.0, 1.5],
    [-2.0, 2.5, 1.3],
    [-24.0, 4.2, 1.2],
  ];
  const leafTransforms = [];
  for (const [lx, lz, lr] of leafClusters) {
    for (let i = 0; i < 26; i += 1) {
      const a = rng.range(0, Math.PI * 2);
      const rad = Math.sqrt(rng.next()) * lr;
      leafTransforms.push({
        position: new THREE.Vector3(lx + Math.cos(a) * rad, 0.105, lz + Math.sin(a) * rad),
        rotation: new THREE.Euler(-Math.PI / 2 + rng.gauss(0, 0.12), rng.range(0, 6.28), 0),
        scale: new THREE.Vector3(rng.range(0.6, 1.5), rng.range(0.6, 1.5), 1),
      });
    }
  }
  const leaves = instanced(new THREE.PlaneGeometry(0.17, 0.1), MAT.leaf, leafTransforms);
  leaves.name = 'leaves-instanced';
  leaves.castShadow = false;
  root.add(leaves);
}

/* ------------------------------------------------------------------ *
 * 共用高保真零件
 * ------------------------------------------------------------------ */

/** 单位球（半径 1）：用 scale 复用，省顶点也省 draw call */
const UNIT_SPHERE = new THREE.SphereGeometry(1, 8, 6);
/** 单位圆柱（半径 1、高 1，Y 轴）：桶箍、销轴、辐条共用 */
const UNIT_CYL = new THREE.CylinderGeometry(1, 1, 1, 8);

/** 铆钉/螺栓圈：给法兰、桶箍、检修门加一圈小凸点 */
function boltRing(
  batch: Parts,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  count: number,
  size: number,
): void {
  for (let i = 0; i < count; i += 1) {
    const a = (i / count) * Math.PI * 2;
    batch.add(
      UNIT_SPHERE,
      cx + Math.cos(a) * radius,
      cy,
      cz + Math.sin(a) * radius,
      0,
      0,
      0,
      size,
      size * 0.7,
      size,
    );
  }
}

/** 一圈径向排列的小块（井盖齿圈、胎纹、拒马焊接块） */
function radialBlocks(
  batch: Parts,
  geom: THREE.BufferGeometry,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  count: number,
  yaw: number,
  scaleX = 1,
  scaleY = 1,
  scaleZ = 1,
): void {
  for (let i = 0; i < count; i += 1) {
    const a = yaw + (i / count) * Math.PI * 2;
    batch.add(
      geom,
      cx + Math.cos(a) * radius,
      cy,
      cz + Math.sin(a) * radius,
      0,
      -a,
      0,
      scaleX,
      scaleY,
      scaleZ,
    );
  }
}

/** 桶箍：一圈略粗于桶身的环 */
function hoop(
  batch: Parts,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  thickness: number,
): void {
  batch.add(UNIT_CYL, cx, cy, cz, 0, 0, 0, radius + thickness, thickness, radius + thickness);
}

/**
 * 带凹痕的桶身：在圆柱侧面压出几处"被撞扁"的凹陷。
 * 顶点位移实现（不是贴图），任何角度都能看到体积变化。
 */
function dentedCylinder(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  dents: Array<{ a: number; y: number; depth: number; r: number }>,
): THREE.BufferGeometry {
  const geom = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, 14, 6);
  const pos = geom.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 1e-4) continue;
    const a = Math.atan2(z, x);
    let dx = 0;
    let dz = 0;
    for (const d of dents) {
      const da = Math.atan2(Math.sin(a - d.a), Math.cos(a - d.a));
      const dy = y - d.y;
      const dist = Math.hypot(da * r, dy);
      const k = Math.max(0, 1 - dist / d.r);
      const push = k * k * d.depth;
      dx -= (x / r) * push;
      dz -= (z / r) * push;
    }
    pos.setX(i, x + dx);
    pos.setZ(i, z + dz);
  }
  pos.needsUpdate = true;
  geom.computeVertexNormals();
  return geom;
}

/**
 * 铁桶：提手弯梁 + 凹痕桶身 + 桶箍 + 桶底 + 桶内水面。
 * Group 原点在"提手中点"，便于挂在车帮上做钟摆。
 * 由 people.ts 的老妇人拖车使用。
 */
export function makeBucket(rng: Rng, rTop: number, rBottom: number, height: number, waterLevel: number): THREE.Group {
  const g = group('bucket');

  // 桶身（带凹痕）
  const bodyGeo = dentedCylinder(rTop, rBottom, height, [
    { a: rng.range(0, 6.28), y: -height * 0.2, depth: rTop * 0.3, r: height * 0.34 },
    { a: rng.range(0, 6.28), y: height * 0.1, depth: rTop * 0.2, r: height * 0.26 },
  ]);
  const body = mesh(bodyGeo, MAT.stoveIronLight);
  body.position.y = -height / 2;
  g.add(body);

  // 桶口卷边
  const lip = mesh(new THREE.TorusGeometry(rTop, 0.018, 4, 12), MAT.stoveIron);
  lip.rotation.x = Math.PI / 2;
  g.add(lip);

  // 桶箍两道 + 桶底
  const iron = new Parts();
  hoop(iron, 0, -height * 0.14, 0, rTop * 0.97, 0.016);
  hoop(iron, 0, -height * 0.8, 0, rBottom * 1.03, 0.016);
  iron.add(UNIT_CYL, 0, -height + 0.018, 0, 0, 0, 0, rBottom * 0.97, 0.036, rBottom * 0.97);
  const ironMesh = iron.take(MAT.stoveIron, 'bucket-iron');
  if (ironMesh) g.add(ironMesh);

  // 提手弯梁：桶口两侧斜上 + 跨过桶口的横梁
  const handle = new Parts();
  handle.addBetween(UNIT_CYL, new THREE.Vector3(-rTop * 0.96, 0.01, 0), new THREE.Vector3(-rTop * 0.72, height * 0.14, 0));
  handle.addBetween(UNIT_CYL, new THREE.Vector3(rTop * 0.96, 0.01, 0), new THREE.Vector3(rTop * 0.72, height * 0.14, 0));
  handle.addBetween(
    UNIT_CYL,
    new THREE.Vector3(-rTop * 0.72, height * 0.14, 0),
    new THREE.Vector3(rTop * 0.72, height * 0.14, 0),
  );
  const handleMesh = handle.take(MAT.rustBright, 'bucket-handle');
  if (handleMesh) g.add(handleMesh);

  // 桶内水面
  const rWater = rBottom + (rTop - rBottom) * waterLevel;
  const water = mesh(new THREE.CircleGeometry(Math.max(0.02, rWater * 0.92), 12), MAT.water);
  water.rotation.x = -Math.PI / 2;
  water.name = 'bucket-water';
  water.position.y = -height + height * waterLevel;
  water.castShadow = false;
  g.add(water);

  return g;
}

/* ------------------------------------------------------------------ *
 * 组装
 * ------------------------------------------------------------------ */

type AnimList = Array<(t: number) => void>;

export function buildStreetProps(ctx: BuildContext): THREE.Group {
  const root = group('street-props');
  const anim: AnimList = [];
  const rng = ctx.rng.fork(7331);

  buildCornerSign(root, rng.fork(1));
  buildUtilityPoles(ctx, root, anim, rng.fork(3));
  buildTrafficLights(root, anim, rng.fork(4));
  buildSandbags(root, rng.fork(5));
  buildHedgehogs(root, rng.fork(6));
  buildTireBarricade(root, rng.fork(7));
  buildGuardrail(root, rng.fork(8));
  buildNoticeBoard(root, rng.fork(9));
  buildTapeBarrier(root, anim, rng.fork(10));
  buildClutter(root, anim, rng.fork(11));
  buildAlleyJunk(root, rng.fork(12));
  buildDebris(ctx, root, rng.fork(13));

  if (anim.length > 0) {
    ctx.ticker.add((t, _dt) => {
      for (let i = 0; i < anim.length; i += 1) anim[i]?.(t);
    });
  }

  return root;
}
