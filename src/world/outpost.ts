import * as THREE from 'three';
import type { BuildContext } from '../core/context';
import type { Rng } from '../core/rng';
import type { InstanceTransform } from '../core/geo';
import {
  at,
  box,
  cyl,
  group,
  hashNoise,
  instanced,
  jitter,
  mesh,
  mergeMeshes,
  softBox,
  torus,
} from '../core/geo';
import {
  chippedSlab,
  debrisRing,
  mergeAll,
  tyreGeometry,
  windowFrameGeometry,
} from '../core/detail';
import {
  basicMaterial,
  canvasTexture,
  glowMaterial,
  toonMaterial,
  withOutline,
} from '../core/materials';
import { PALETTE } from '../core/palette';
import { HOTSPOTS, ZONES, canPlace, groundYAt, type Rect } from './layout';

/**
 * 前沿军事哨卡（西翼 outpostW / 东翼 outpostE，z 110..124）。
 *
 * 出城纵街（x=0）向南穿过哨卡：防线横切出城方向，但在车道缺口
 * outpostGap（x∈[-13.2,13.2]）内不留任何障碍——所有落位都过 canPlace()。
 *
 * 由北到南的纵深（两翼各自）：
 *   后区 z 114..118.5：半塌岗亭、BTR 停放位、探照灯塔、篝火、迫击炮阵地
 *   主 line z≈119.7：沙袋墙（错缝三皮 + 沉降歪斜 + 顶部压防水帆布与轮胎）
 *   中间 z≈121.5：捷克刺猬拒马线（含倾角与翻倒样本）
 *   前沿 z≈123.0：铁丝网（木/钢桩 + 三道刺网 + 斜拉十字 + 拧结刺）+ 成卷线圈、剪开的豁口、挂着的碎布
 *
 * 动效（≥4 组）：两座探照灯不同步扫动（26s/34s，灯头带动体光锥与贴地椭圆亮斑）、
 * 篝火/余烬/点光明灭、铁丝网碎布迎风飘动、岗亭半挂的波纹铁皮被风掀动。
 *
 * 该区 z≈117 已在阴影相机（±104）之外：主体一律不投影，靠 AO 分色与轮廓撑住。
 * LOD（dist=hypot(cx,cz)）：near<95 / mid<120 / far；far 不描边。
 */

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

const ZONE_W = ZONES.find((z) => z.id === 'outpostW') as Rect;
const ZONE_E = ZONES.find((z) => z.id === 'outpostE') as Rect;

/* ============================== 材质 ============================== */

const M = {
  /* 沙袋 */
  bag: toonMaterial(PALETTE.sandbag, { steps: 3 }),
  bagDark: toonMaterial(PALETTE.sandbagDark, { steps: 3 }),
  bagWear: toonMaterial(0x59503d, { steps: 2 }),
  /* 钢与锈 */
  steel: toonMaterial(0x4e5760, { steps: 3 }),
  steelBright: toonMaterial(0x77818c, { steps: 3 }),
  steelDark: toonMaterial(0x333941, { steps: 2 }),
  rust: toonMaterial(PALETTE.rust, { steps: 2 }),
  rustDark: toonMaterial(PALETTE.rustDark, { steps: 2 }),
  burnt: toonMaterial(PALETTE.burnt, { steps: 2 }),
  soot: toonMaterial(PALETTE.soot, { steps: 2 }),
  wire: toonMaterial(0x1b2026, { steps: 2 }),
  /* 木 */
  wood: toonMaterial(PALETTE.woodOld, { steps: 3 }),
  woodDark: toonMaterial(PALETTE.woodDark, { steps: 2 }),
  /* 帆布 / 布 */
  tarp: toonMaterial(PALETTE.tarp, { steps: 3 }),
  tarpBlue: toonMaterial(PALETTE.tarpBlue, { steps: 3 }),
  ragRed: toonMaterial(PALETTE.fabricRed, { steps: 2, side: THREE.DoubleSide }),
  ragGrey: toonMaterial(0x5d5b52, { steps: 2, side: THREE.DoubleSide }),
  /* 橡胶与轮胎 */
  tire: toonMaterial(PALETTE.tire, { steps: 2 }),
  /* 地面 */
  concrete: toonMaterial(PALETTE.concreteStain, { steps: 3 }),
  dirt: toonMaterial(PALETTE.dirt, { steps: 2 }),
  mud: toonMaterial(PALETTE.mud, { steps: 2 }),
  /* 装甲 */
  armor: toonMaterial(PALETTE.olive, { steps: 3, emissive: 0x0d100c }),
  armorLight: toonMaterial(PALETTE.oliveLight, { steps: 3, emissive: 0x0c0f0b }),
  armorDark: toonMaterial(PALETTE.oliveDark, { steps: 2, emissive: 0x0a0d09 }),
  gun: toonMaterial(0x3b3f45, { steps: 2 }),
  glassDark: toonMaterial(PALETTE.glassDark, { steps: 2 }),
  tin: toonMaterial(0x8d8f8a, { steps: 2 }),
  enamel: toonMaterial(0xb9b3a2, { steps: 3 }),
  brass: toonMaterial(0x8a7140, { steps: 2 }),
  /* 湿地贴花 */
  dirtDecal: basicMaterial(0x191712, { opacity: 0.4, transparent: true, fog: true }),
  ashDecal: basicMaterial(0x0d0f12, { opacity: 0.5, transparent: true, fog: true }),
} as const;

const wetArmorMat = new THREE.MeshPhongMaterial({
  color: PALETTE.olive,
  specular: 0x9db4c4,
  shininess: 46,
  emissive: 0x0b0f0d,
});

/* ============================== 落位与 LOD ============================== */

/** 一切落位先过净空契约：范围内 + 不碰车行道/人行道 + 守住 outpostGap */
function ok(cx: number, cz: number, w: number, d: number, pad = 0.04): boolean {
  const rect: Rect = { x0: cx - w / 2, x1: cx + w / 2, z0: cz - d / 2, z1: cz + d / 2 };
  if (rect.x1 > -13.2 && rect.x0 < 13.2) return false;
  const inW = rect.x0 >= ZONE_W.x0 && rect.x1 <= ZONE_W.x1 && rect.z0 >= ZONE_W.z0 && rect.z1 <= ZONE_W.z1;
  const inE = rect.x0 >= ZONE_E.x0 && rect.x1 <= ZONE_E.x1 && rect.z0 >= ZONE_E.z0 && rect.z1 <= ZONE_E.z1;
  if (!inW && !inE) return false;
  return canPlace(rect, pad);
}

/** LOD 档：0=near(<95) 1=mid(<120) 2=far。本区几乎全在 far，细节仍要撑住轮廓 */
function levelOf(cx: number, cz: number): number {
  const dist = Math.hypot(cx, cz);
  return dist < 95 ? 0 : dist < 120 ? 1 : 2;
}

/** 只给剪影重要体块描边；far 档一律不描 */
function outlineIf<T extends THREE.Object3D>(obj: T, cx: number, cz: number, thickness = 0.0042): T {
  if (levelOf(cx, cz) < 2) withOutline(obj, thickness);
  return obj;
}

/* ============================== 合批工具 ============================== */

/** 几何体批次（同 props.ts 的 Parts）：同材质静态件合并成一个网格 */
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
    scale: THREE.Vector3 = UNIT_SCALE,
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

  /** 两点之间摆一段（几何按单位长度沿 +Y 建模，用 y 缩放补长度） */
  addBetweenCylinder(geometry: THREE.BufferGeometry, a: THREE.Vector3, b: THREE.Vector3): this {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    const q = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, dir.normalize());
    return this.addQ(geometry, mid, q, new THREE.Vector3(1, Math.max(len, 0.001), 1));
  }

  take(material: THREE.Material, name?: string): THREE.Mesh | null {
    if (this.geoms.length === 0) return null;
    const merged = mergeAll(this.geoms);
    const m = mesh(merged, material);
    if (name) m.name = name;
    return m;
  }
}

function commit(parts: Parts, material: THREE.Material, target: THREE.Object3D, name: string): void {
  const m = parts.take(material, name);
  if (m) target.add(m);
}

/** 攒小网格，最后按材质合并（同 vehicles.ts 的 BitBucket） */
class Bits {
  private readonly buckets = new Map<THREE.Material, THREE.Mesh[]>();

  add(m: THREE.Mesh, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void {
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    const mat = m.material as THREE.Material;
    const list = this.buckets.get(mat);
    if (list) list.push(m);
    else this.buckets.set(mat, [m]);
  }

  flush(parent: THREE.Object3D, prefix: string): void {
    let i = 0;
    for (const [mat, list] of this.buckets) {
      const merged = mergeMeshes(list, mat);
      if (merged) {
        merged.name = `${prefix}-${i}`;
        parent.add(merged);
        i += 1;
      }
    }
    this.buckets.clear();
  }
}

/** 侧面轮廓挤出：profile 是 (z,y) 折线，沿 X 挤出 width —— BTR 船形车体一次成型 */
function extrudeSide(
  profile: ReadonlyArray<readonly [number, number]>,
  width: number,
  material: THREE.Material,
  bevel = 0.04,
): THREE.Mesh {
  const shape = new THREE.Shape();
  profile.forEach(([z, y], i) => {
    if (i === 0) shape.moveTo(z, y);
    else shape.lineTo(z, y);
  });
  shape.closePath();
  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.02, width - bevel * 2),
    bevelEnabled: bevel > 0,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelSegments: 1,
    curveSegments: 2,
  });
  geom.rotateY(-Math.PI / 2);
  geom.translate(width / 2 - bevel, 0, 0);
  return mesh(geom, material);
}

/** 贴地污渍/坐痕：抖动圆片压平 */
function decal(x: number, z: number, radius: number, material: THREE.Material, rng: Rng, squash = 1, yLift = 0.012): THREE.Mesh {
  const geom = jitter(new THREE.CircleGeometry(radius, 12), radius * 0.16, rng);
  const pos = geom.getAttribute('position');
  if (pos) {
    for (let i = 0; i < pos.count; i += 1) pos.setZ(i, 0);
    pos.needsUpdate = true;
  }
  const patch = mesh(geom, material);
  patch.rotation.x = -Math.PI / 2;
  patch.rotation.z = rng.range(0, Math.PI * 2);
  patch.scale.set(1, squash, 1);
  patch.castShadow = false;
  patch.receiveShadow = false;
  at(patch, x, groundYAt(x, z) + yLift, z);
  return patch;
}

/* ============================== Canvas 贴图 ============================== */

/** 湿地反光条贴图（同 fx/spill 的双端羽化 + 碎波纹） */
function spillTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const along = c.createLinearGradient(0, 0, 0, h);
    along.addColorStop(0, 'rgba(255,255,255,0)');
    along.addColorStop(0.2, 'rgba(255,255,255,0.8)');
    along.addColorStop(0.5, 'rgba(255,255,255,0.55)');
    along.addColorStop(0.8, 'rgba(255,255,255,0.8)');
    along.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = along;
    c.fillRect(0, 0, w, h);
    c.globalCompositeOperation = 'destination-in';
    const across = c.createLinearGradient(0, 0, w, 0);
    across.addColorStop(0, 'rgba(255,255,255,0)');
    across.addColorStop(0.5, 'rgba(255,255,255,1)');
    across.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = across;
    c.fillRect(0, 0, w, h);
    c.globalCompositeOperation = 'source-over';
  });
}

/** 灯头/车灯前向柔光斑：中心亮、四周快速衰减 */
function spotTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const g = c.createRadialGradient(64, 64, 4, 64, 64, 62);
    g.addColorStop(0, 'rgba(255,255,255,0.6)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.22)');
    g.addColorStop(0.75, 'rgba(255,255,255,0.06)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  });
}

/** 体积光锥沿长度的羽化：小端（灯口）略入、大端（远端）出 */
function beamLengthTexture(): THREE.CanvasTexture {
  return canvasTexture(8, 128, (c, w, h) => {
    const g = c.createLinearGradient(0, h, 0, 0);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.1, 'rgba(255,255,255,0.62)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.26)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  });
}

/** 火苗：上飘泪滴形柔光 */
function flameTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 96, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const g = c.createRadialGradient(32, 66, 3, 32, 58, 34);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.45, 'rgba(255,210,150,0.55)');
    g.addColorStop(1, 'rgba(255,120,40,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    // 上收的舌尖：用 destination-in 把圆斑挤成泪滴
    c.globalCompositeOperation = 'destination-in';
    const tip = c.createLinearGradient(0, h, 0, 0);
    tip.addColorStop(0, 'rgba(255,255,255,1)');
    tip.addColorStop(0.55, 'rgba(255,255,255,0.9)');
    tip.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = tip;
    c.beginPath();
    c.moveTo(32, 2);
    c.quadraticCurveTo(56, 52, 52, h);
    c.lineTo(12, h);
    c.quadraticCurveTo(8, 52, 32, 2);
    c.fill();
    c.globalCompositeOperation = 'source-over';
  });
}

/** 程序化西里尔警示牌（虚构条文，无任何真实机构标识） */
function warningPlate(
  rng: Rng,
  w: number,
  h: number,
  opts: { text: string; sub?: string; danger?: boolean; post?: [number, number][] },
): THREE.Group {
  const tex = canvasTexture(256, 192, (c, cw, ch) => {
    c.fillStyle = '#b4ac94';
    c.fillRect(0, 0, cw, ch);
    for (let i = 0; i < 22; i += 1) {
      c.globalAlpha = rng.range(0.05, 0.16);
      c.fillStyle = rng.chance(0.5) ? '#4c4638' : '#31414b';
      c.beginPath();
      c.ellipse(rng.range(0, cw), rng.range(0, ch), rng.range(8, 40), rng.range(5, 20), rng.range(0, 3), 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 0.16;
    c.fillStyle = '#26201b';
    c.fillRect(0, ch - 46, cw, 46);
    c.globalAlpha = 1;
    c.strokeStyle = '#8f2d28';
    c.lineWidth = 9;
    c.strokeRect(10, 10, cw - 20, ch - 20);
    if (opts.danger) {
      c.fillStyle = '#8f2d28';
      c.beginPath();
      c.moveTo(cw / 2, 26);
      c.lineTo(cw / 2 + 34, 84);
      c.lineTo(cw / 2 - 34, 84);
      c.closePath();
      c.fill();
      c.fillStyle = '#b4ac94';
      c.fillRect(cw / 2 - 4, 44, 8, 24);
      c.fillRect(cw / 2 - 4, 72, 8, 8);
    }
    c.fillStyle = 'rgba(28,25,21,0.86)';
    c.font = 'bold 34px "Arial Narrow", Arial, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(opts.text, cw / 2, opts.danger ? 116 : 88);
    if (opts.sub) {
      c.font = 'bold 22px "Arial Narrow", Arial, sans-serif';
      c.globalAlpha = 0.75;
      c.fillText(opts.sub, cw / 2, opts.danger ? 150 : 128);
      c.globalAlpha = 1;
    }
  });
  const faceMat = new THREE.MeshBasicMaterial({ map: tex, color: 0xbcc4cc, fog: true });
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, 0.06),
    [M.woodDark, M.woodDark, M.woodDark, M.woodDark, faceMat, faceMat],
  );
  board.name = `warn-board-${opts.text}`;
  board.position.set(0, 0.1, 0);
  const g = group('warn-sign');
  g.add(board);
  const posts = opts.post ?? [[0, -h * 0.5 - 0.45]];
  for (const [px, py] of posts) {
    g.add(at(box(0.07, 0.9, 0.07, M.woodDark), px, py - 0.05, 0));
  }
  return g;
}

/** 弹孔 + 崩裂碎屑环：洞口是真实凹陷的短管，四周 instanced 碎块 */
function bulletHoles(
  parent: THREE.Object3D,
  rng: Rng,
  local: Array<{ p: [number, number, number]; n: [number, number, number] }>,
): void {
  if (local.length === 0) return;
  const plugs = new THREE.Group();
  const chips: InstanceTransform[] = [];
  for (const hole of local) {
    const n = new THREE.Vector3(...hole.n).normalize();
    const p = new THREE.Vector3(...hole.p);
    const plug = cyl(0.022, 0.03, 0.11, 6, M.burnt);
    plug.quaternion.setFromUnitVectors(Y_AXIS, n);
    plug.position.copy(p).addScaledVector(n, -0.01);
    plugs.add(plug);
    const ring = debrisRing(rng.int(6, 9), 0.11, rng, 0.3);
    const yaw = Math.atan2(n.x, n.z);
    const q = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, yaw);
    for (const t of ring) {
      const pos = t.position.clone().applyQuaternion(q).add(p).addScaledVector(n, 0.02);
      const rot = new THREE.Euler(
        (t.rotation?.x ?? 0) + rng.range(-0.2, 0.2),
        yaw + (t.rotation?.y ?? 0),
        t.rotation?.z ?? 0,
      );
      const s = t.scale ?? UNIT_SCALE;
      chips.push({ position: pos, rotation: rot, scale: new THREE.Vector3(s.x * 0.55, s.y * 0.5, s.z * 0.55) });
    }
  }
  commitPlugs(plugs, parent);
  const chipGeom = jitter(new THREE.BoxGeometry(0.05, 0.04, 0.045), 0.008, rng);
  const inst = instanced(chipGeom, M.concrete, chips);
  inst.name = 'bullet-chips';
  parent.add(inst);
}

function commitPlugs(plugs: THREE.Group, parent: THREE.Object3D): void {
  const list: THREE.Mesh[] = [];
  plugs.children.forEach((c) => {
    if ((c as THREE.Mesh).isMesh) list.push(c as THREE.Mesh);
  });
  const merged = mergeMeshes(list, M.burnt);
  if (merged) {
    merged.name = 'bullet-plugs';
    parent.add(merged);
  }
}

/* ============================== 沙袋墙 ============================== */

let bagVariants: THREE.BufferGeometry[] = [];

/** 高保真沙袋：softBox 柔软体 + 收腰鼓胀 + 袋口翻折 + 顶部缝线棱（一袋一袋独立几何） */
function makeSandbagGeo(variant: number): THREE.BufferGeometry {
  const base = softBox(0.74, 0.235, 0.44, 0.1, M.bag).geometry.clone();
  const pos = base.getAttribute('position');
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const t = THREE.MathUtils.clamp(x / 0.37, -1, 1);
    const pinch = 1 - 0.2 * Math.cos(t * Math.PI) - 0.05 * variant;
    const sag = 0.95 + 0.09 * Math.sin(t * 5.1 + variant * 1.9);
    pos.setY(i, y * pinch * sag);
    pos.setZ(i, z * (0.96 + 0.05 * Math.cos(t * Math.PI)));
  }
  pos.needsUpdate = true;
  base.computeVertexNormals();
  const flap = new THREE.BoxGeometry(0.15, 0.055, 0.23);
  flap.rotateZ(-0.3 + variant * 0.08);
  flap.translate(0.3, 0.095, variant % 2 === 0 ? -0.03 : 0.03);
  // 缝线棱：沿袋面中线的一道细凸条
  const seam = new THREE.BoxGeometry(0.52, 0.02, 0.022);
  seam.translate(-0.02, 0.108 - variant * 0.01, 0.02 * variant);
  const seam2 = new THREE.BoxGeometry(0.02, 0.02, 0.3);
  seam2.translate(0.2, 0.1, 0);
  return mergeAll([base, flap, seam, seam2]);
}

function bagGeoFor(rng: Rng): THREE.BufferGeometry {
  if (bagVariants.length === 0) bagVariants = [makeSandbagGeo(0), makeSandbagGeo(1), makeSandbagGeo(2)];
  return bagVariants[Math.floor(rng.next() * bagVariants.length) % bagVariants.length] as THREE.BufferGeometry;
}

interface WallOpts {
  step?: number;
  skip?: number;
  heavySkew?: boolean;
  /** 0..1，压顶帆布 + 压胎 */
  tarp?: number;
}

/**
 * 一段沙袋墙：错缝堆叠、逐层沉降、随机歪斜与缺袋，
 * 顶部可压一层防水帆布并用废旧轮胎压角。
 */
function bagWallSeg(
  rng: Rng,
  light: Parts,
  dark: Parts,
  wear: Parts,
  tarps: Parts,
  tires: Parts,
  cx: number,
  cz: number,
  yaw: number,
  length: number,
  layers: number,
  opts: WallOpts = {},
): boolean {
  const alongX = Math.abs(Math.cos(yaw)) >= Math.abs(Math.sin(yaw));
  if (!ok(cx, cz, alongX ? length + 0.8 : 1.15, alongX ? 1.15 : length + 0.8)) return false;
  const step = opts.step ?? 0.62;
  const baseY = groundYAt(cx, cz);
  const dir = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
  const bagYaw = -yaw;
  const q0 = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, bagYaw);
  const qErr = new THREE.Quaternion();
  const geo = bagGeoFor(rng);
  const wearGeo = new THREE.BoxGeometry(0.16, 0.05, 0.1);
  for (let layer = 0; layer < layers; layer += 1) {
    const count = Math.max(2, Math.round(length / step) - (layer % 2 === 0 ? 0 : 1));
    const span = (count - 1) * step;
    for (let i = 0; i < count; i += 1) {
      if (opts.skip !== undefined && rng.chance(opts.skip)) continue;
      const t = -span / 2 + i * step + (layer % 2 === 0 ? 0 : step * 0.5);
      // 沉降：越高越沉、越歪
      const settle = layer * 0.012 + rng.gauss(0, 0.01 + layer * 0.012);
      const skew = opts.heavySkew ? 0.12 : 0.05;
      const rx = rng.gauss(0, skew * 0.5);
      const rz = rng.gauss(0, skew);
      const ry = bagYaw + rng.gauss(0, skew);
      const px = cx + dir.x * t + rng.gauss(0, 0.025);
      const pz = cz + dir.z * t + rng.gauss(0, 0.025);
      const py = baseY + 0.115 + layer * (0.19 - settle * 0.3) + rng.gauss(0, 0.01);
      const batch = rng.chance(0.42) ? dark : light;
      qErr.setFromEuler(new THREE.Euler(rx, ry - bagYaw, rz));
      batch.addQ(geo, new THREE.Vector3(px, py, pz), q0.clone().multiply(qErr), rng.chance(0.2) ? new THREE.Vector3(0.94, 0.82, 0.96) : UNIT_SCALE);
      // 角落磨损：一块深色破皮贴在角上
      if (rng.chance(0.34)) {
        const corner = new THREE.Vector3(rng.sign() * 0.24, 0.06, rng.sign() * 0.14).applyQuaternion(q0.clone().multiply(qErr)).add(new THREE.Vector3(px, py, pz));
        wear.addQ(wearGeo, corner, q0.clone().multiply(qErr), new THREE.Vector3(rng.range(0.6, 1.2), 0.5, rng.range(0.6, 1.1)));
      }
    }
  }
  // 压顶：防水帆布（一层软板错搭）+ 压帆布的旧轮胎
  if (opts.tarp !== undefined && rng.chance(opts.tarp)) {
    const n = Math.max(2, Math.round(length / 1.15));
    for (let i = 0; i < n; i += 1) {
      const t = -length / 2 + ((i + 0.5) * length) / n + rng.gauss(0, 0.08);
      const px = cx + dir.x * t;
      const pz = cz + dir.z * t;
      tarps.add(
        softBox(1.15, 0.09, 0.85, 0.12, M.tarp).geometry,
        px,
        baseY + 0.62 + rng.gauss(0, 0.02),
        pz,
        rng.gauss(0, 0.05),
        -yaw + rng.gauss(0, 0.14),
        rng.gauss(0, 0.06),
      );
      if (i % 3 === 1) {
        tires.add(new THREE.TorusGeometry(0.31, 0.11, 6, 12), px, baseY + 0.71, pz, Math.PI / 2 + rng.gauss(0, 0.05), rng.range(0, 3), 0);
      }
    }
  }
  return true;
}

/* ============================== 捷克刺猬 ============================== */

/** 工字钢（腹板 + 双翼缘）与焊接结点、锈层分色 */
function buildHedgehogs(root: THREE.Group, rng: Rng): void {
  const beams = new Parts();
  const welds = new Parts();
  const scorched = new Parts();
  const railGeo = mergeAll([
    new THREE.BoxGeometry(0.1, 0.19, 1.9),
    (() => {
      const f = new THREE.BoxGeometry(0.27, 0.05, 1.9);
      f.translate(0, 0.095, 0);
      return f;
    })(),
    (() => {
      const f = new THREE.BoxGeometry(0.27, 0.05, 1.9);
      f.translate(0, -0.095, 0);
      return f;
    })(),
  ]);
  const knotGeo = new THREE.DodecahedronGeometry(0.11, 0);
  const charGeo = new THREE.BoxGeometry(0.3, 0.03, 0.14);

  // 两翼拒马线：z≈121.5，横切出城方向；避开探照塔基与线圈堆
  const spots: Array<{ x: number; z: number; yaw: number; tilt: number; fallen: boolean }> = [
    { x: -17.6, z: 121.4, yaw: 0.4, tilt: 0.12, fallen: false },
    { x: -22.8, z: 121.7, yaw: -0.9, tilt: 0.3, fallen: false },
    { x: -34.2, z: 121.5, yaw: 1.7, tilt: -0.24, fallen: false },
    { x: -39.4, z: 121.9, yaw: 0.2, tilt: 1.42, fallen: true },
    { x: -47.5, z: 121.2, yaw: -0.5, tilt: 0.16, fallen: false },
    { x: -63.2, z: 121.2, yaw: 1.1, tilt: 0.42, fallen: false },
    { x: 17.2, z: 121.5, yaw: -0.3, tilt: -0.2, fallen: false },
    { x: 22.4, z: 121.8, yaw: 0.9, tilt: 0.34, fallen: false },
    { x: 27.8, z: 121.4, yaw: 2.2, tilt: 1.5, fallen: true },
    { x: 34.5, z: 121.6, yaw: 0.1, tilt: -0.14, fallen: false },
    { x: 39.8, z: 121.9, yaw: -1.3, tilt: 0.22, fallen: false },
    { x: 46.8, z: 121.8, yaw: 0.6, tilt: 0.5, fallen: false },
    { x: 61.5, z: 121.2, yaw: -0.7, tilt: -0.3, fallen: false },
    { x: 70.5, z: 120.5, yaw: 1.9, tilt: 0.36, fallen: false },
  ];

  for (const s of spots) {
    if (!ok(s.x, s.z, 2.3, 2.3)) continue;
    const gy = groundYAt(s.x, s.z);
    const spin = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, s.yaw + rng.gauss(0, 0.18));
    const leanAxis = new THREE.Vector3(Math.cos(rng.range(0, 3)), 0.22, Math.sin(rng.range(0, 3))).normalize();
    const lean = new THREE.Quaternion().setFromAxisAngle(leanAxis, s.tilt + rng.gauss(0, 0.08));
    const q = spin.clone().multiply(lean);
    const origin = new THREE.Vector3(s.x, gy + (s.fallen ? 0.46 : 0.56 + rng.gauss(0, 0.05)), s.z);
    const qY = new THREE.Quaternion().setFromAxisAngle(X_AXIS, Math.PI / 2);
    const qZ = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, Math.PI / 2);
    beams.addQ(railGeo, origin, q);
    beams.addQ(railGeo, origin, q.clone().multiply(qY));
    beams.addQ(railGeo, origin, q.clone().multiply(qZ));
    // 焊缝小结点：中心一枚 + 两两交叉处各一枚
    welds.addQ(knotGeo, origin, q);
    for (const off of [0.55, -0.55]) {
      for (const axis of [qY, qZ]) {
        const dir = new THREE.Vector3(0, 0, off).applyQuaternion(q.clone().multiply(axis));
        welds.addQ(knotGeo, origin.clone().add(dir), q, new THREE.Vector3(0.5, 0.5, 0.7));
      }
    }
    // 锈层分色 + 焦黑段（被炸过的样本）
    if (rng.chance(0.55)) {
      const cp = new THREE.Vector3(rng.range(-0.5, 0.5), rng.range(-0.6, 0.6), rng.range(-0.8, 0.8)).applyQuaternion(q).add(origin);
      scorched.add(charGeo, cp.x, cp.y, cp.z, rng.range(0, 2), s.yaw, rng.range(0, 1));
    }
    // 翻倒的样本：一根梁脱开躺在旁边
    if (s.fallen) {
      beams.addQ(railGeo, new THREE.Vector3(s.x + rng.range(-0.8, 0.8), gy + 0.1, s.z + 0.9), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2 - 0.1, rng.range(0, 3), 0)));
    }
  }

  commit(beams, M.rust, root, 'hedgehog-beams');
  commit(welds, M.steelDark, root, 'hedgehog-welds');
  commit(scorched, M.burnt, root, 'hedgehog-char');
}

/* ============================== 铁丝网 ============================== */

interface RagSpec {
  pos: THREE.Vector3;
  yaw: number;
  phase: number;
  mat: THREE.Material;
}

function barbKnotGeo(): THREE.BufferGeometry {
  const a = new THREE.BoxGeometry(0.06, 0.012, 0.012);
  a.rotateZ(0.6);
  const b = new THREE.BoxGeometry(0.06, 0.012, 0.012);
  b.rotateZ(-0.6);
  return mergeAll([a, b]);
}

/** 全线共用的合批桶：木桩/钢桩/网丝/桩脚土/线圈各一个网格，刺结一次 instanced */
interface WireKit {
  wood: Parts;
  steel: Parts;
  strands: Parts;
  tie: Parts;
  coils: Parts;
  knots: InstanceTransform[];
}

/**
 * 一整道刺网：木桩/钢桩交替 + 三道横网 + 每档斜拉十字 + 带刺拧结（instanced）。
 * 支持剪开的豁口（cutAt）。落件全部进 kit，由入口统一合批。
 */
function wireRun(
  kit: WireKit,
  rng: Rng,
  x0: number,
  x1: number,
  z: number,
  opts: { cutAt?: number; rags: RagSpec[] },
): void {
  const { wood: woodPosts, steel: steelPosts, strands, tie, knots } = kit;
  const postH = 1.12;
  const gap = opts.cutAt;
  const strandY = [0.34, 0.68, 1.02];

  const n = Math.max(2, Math.round(Math.abs(x1 - x0) / 2.35));
  let prev: THREE.Vector3 | null = null;
  for (let i = 0; i <= n; i += 1) {
    const x = x0 + ((x1 - x0) * i) / n;
    const gy = groundYAt(x, z);
    const inCut = gap !== undefined && Math.abs(x - gap) < 1.7;
    const steel = i % 2 === 0;
    const lean = rng.gauss(0, 0.04);
    // 桩
    if (steel) steelPosts.add(new THREE.BoxGeometry(0.07, postH, 0.07), x, gy + postH / 2, z, lean, rng.gauss(0, 0.04), rng.gauss(0, 0.05));
    else woodPosts.add(new THREE.BoxGeometry(0.09, postH, 0.09), x, gy + postH / 2, z, lean, rng.gauss(0, 0.05), rng.gauss(0, 0.04));
    // 桩前的小土堆（埋进泥里的桩脚）
    tie.add(new THREE.BoxGeometry(0.3, 0.06, 0.3), x, gy + 0.03, z, 0, rng.range(0, 2), 0);

    if (prev !== null && !inCut && Math.abs(x - prev.x) > 1) {
      // 上一档到这一档的网（斜拉十字 + 横丝 + 拧结）
      const a = prev;
      const b = new THREE.Vector3(x, gy + postH, z);
      const ab = new THREE.Vector3(a.x, gy + postH, z);
      const aa2 = new THREE.Vector3(a.x, gy + 0.12, z);
      strands.addBetweenCylinder(new THREE.CylinderGeometry(0.013, 0.013, 1, 4), ab, b);
      strands.addBetweenCylinder(new THREE.CylinderGeometry(0.013, 0.013, 1, 4), aa2, b);
      for (const sy of strandY) {
        const s0 = new THREE.Vector3(a.x, gy + sy + rng.gauss(0, 0.015), z + rng.gauss(0, 0.02));
        const s1 = new THREE.Vector3(x, gy + sy + rng.gauss(0, 0.015), z + rng.gauss(0, 0.02));
        strands.addBetweenCylinder(new THREE.CylinderGeometry(0.011, 0.011, 1, 4), s0, s1);
        const m = s0.distanceTo(s1);
        const kCount = Math.max(2, Math.round(m / 0.75));
        for (let k = 0; k < kCount; k += 1) {
          const t = (k + 0.5) / kCount;
          knots.push({
            position: new THREE.Vector3(s0.x + (s1.x - s0.x) * t, s0.y + (s1.y - s0.y) * t + Math.sin(t * Math.PI) * -0.018, s0.z),
            rotation: new THREE.Euler(rng.gauss(0, 0.2), rng.gauss(0, 0.15), rng.range(0, 3)),
          });
        }
        // 网上的碎布（迎风飘）
        if (sy === 1.02 && rng.chance(0.3) && opts.rags.length < 7) {
          const tp = rng.range(0.3, 0.7);
          opts.rags.push({
            pos: new THREE.Vector3(s0.x + (s1.x - s0.x) * tp, s0.y - 0.02, s0.z),
            yaw: rng.range(-0.6, 0.6),
            phase: rng.range(0, 6.28),
            mat: rng.chance(0.4) ? M.ragRed : M.ragGrey,
          });
        }
      }
    }
    if (!inCut) {
      prev = new THREE.Vector3(x, gy + postH, z);
    } else {
      prev = null;
    }
  }

  // 豁口两侧桩上垂着的断丝（被剪开的痕迹）
  if (gap !== undefined) {
    const gg = groundYAt(gap, z);
    for (const sgn of [-1, 1] as const) {
      const px = gap + sgn * 1.6;
      strands.addBetweenCylinder(new THREE.CylinderGeometry(0.012, 0.012, 1, 4), new THREE.Vector3(px, gg + 1.02, z), new THREE.Vector3(px - sgn * 0.22, gg + 0.34, z + 0.16));
      strands.addBetweenCylinder(new THREE.CylinderGeometry(0.012, 0.012, 1, 4), new THREE.Vector3(px, gg + 0.68, z), new THREE.Vector3(px + sgn * 0.1, gg + 0.16, z - 0.12));
      knots.push({ position: new THREE.Vector3(px - sgn * 0.22, gg + 0.3, z + 0.16), rotation: new THREE.Euler(0.4, 0, 1) });
    }
  }
}

/** 成卷未展开的刺网线圈：两三卷叠着，旁边散一段张开的螺旋 */
function wireCoil(kit: WireKit, rng: Rng, x: number, z: number): void {
  if (!ok(x, z, 1.5, 1.5)) return;
  const torusGeo = new THREE.TorusGeometry(0.52, 0.1, 6, 14);
  const gy = groundYAt(x, z);
  for (let i = 0; i < 3; i += 1) {
    kit.coils.add(torusGeo, x + rng.gauss(0, 0.07), gy + 0.12 + i * 0.19, z + rng.gauss(0, 0.07), Math.PI / 2 + rng.gauss(0, 0.06), rng.range(0, 3), rng.gauss(0, 0.05));
  }
  // 散开的一段：地上的螺旋丝
  const turns = 2.5;
  const segs = 16;
  let last: THREE.Vector3 | null = null;
  for (let i = 0; i <= segs; i += 1) {
    const t = i / segs;
    const a = t * turns * Math.PI * 2;
    const r = 0.5 + t * 0.35;
    const p = new THREE.Vector3(x + 0.9 + Math.cos(a) * r, gy + 0.05 + Math.sin(a * 3) * 0.015, z + Math.sin(a) * r * 0.6);
    if (last) kit.strands.addBetweenCylinder(new THREE.CylinderGeometry(0.012, 0.012, 1, 4), last, p);
    if (i % 3 === 0) kit.knots.push({ position: p.clone(), rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)) });
    last = p;
  }
}

/* ============================== 探照灯塔 ============================== */

interface TowerAnim {
  head: THREE.Group;
  pitch: THREE.Group;
  facing: number;
  period: number;
  phase: number;
  amp: number;
  basePitch: number;
  beamMat: THREE.MeshBasicMaterial;
  coreMat: THREE.MeshBasicMaterial;
  spotMat: THREE.MeshBasicMaterial;
}

function buildSearchlight(rng: Rng, spec: { x: number; z: number; h: number; facing: number }, beamTex: THREE.CanvasTexture, spotTex: THREE.CanvasTexture): { root: THREE.Group; anim: TowerAnim | null } {
  const { x, z, h } = spec;
  const root = group('searchlight-tower');
  const gy = groundYAt(x, z);
  root.position.set(x, gy, z);
  root.rotation.y = rng.gauss(0, 0.02);

  if (!ok(x, z, 2.2, 2.2)) return { root, anim: null };

  const legs = new Parts();
  const deck = new Parts();
  const ladder = new Parts();
  const bits = new Bits();

  // 混凝土基座 + 地脚
  root.add(at(softBox(1.8, 0.2, 1.8, 0.06, M.concrete), 0, 0.08, 0));
  for (const [bx, bz] of [[0.74, 0.74], [-0.74, 0.74], [0.74, -0.74], [-0.74, -0.74]] as Array<[number, number]>) {
    deck.add(new THREE.BoxGeometry(0.2, 0.1, 0.2), bx, 0.22, bz);
  }

  const platY = h - 0.9;
  const legGeo = new THREE.BoxGeometry(0.12, 1, 0.12); // 单位高，用 addBetweenCylinder 的 y 缩放拉长度
  const braceGeo = new THREE.CylinderGeometry(0.035, 0.035, 1, 5);
  const baseSpread = 0.66;
  const topSpread = 0.34;
  const legCorner = (t: number, sx: number, sz: number): THREE.Vector3 =>
    new THREE.Vector3(sx * (baseSpread + (topSpread - baseSpread) * t), 0.16 + (platY - 0.16) * t, sz * (baseSpread + (topSpread - baseSpread) * t));
  const corners: Array<[number, number]> = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  for (const [sx, sz] of corners) {
    legs.addBetweenCylinder(legGeo, legCorner(0, sx, sz), legCorner(1, sx, sz));
  }
  // 三层水平横撑 + 交错斜撑
  for (const [li, t] of [[0, 0.3], [1, 0.62], [2, 0.9]] as Array<[number, number]>) {
    for (let c = 0; c < 4; c += 1) {
      const a = legCorner(t, corners[c][0], corners[c][1]);
      const b = legCorner(t, corners[(c + 1) % 4][0], corners[(c + 1) % 4][1]);
      legs.addBetweenCylinder(braceGeo, a, b);
    }
    const c0 = li % 2;
    legs.addBetweenCylinder(braceGeo, legCorner(t, corners[c0][0], corners[c0][1]), legCorner(t + 0.32, corners[(c0 + 1) % 4][0], corners[(c0 + 1) % 4][1]));
    legs.addBetweenCylinder(braceGeo, legCorner(t + 0.32, corners[c0][0], corners[c0][1]), legCorner(t, corners[(c0 + 1) % 4][0], corners[(c0 + 1) % 4][1]));
  }
  // 平台：型钢框 + 花纹钢板 + 三面护栏（南面留给爬梯）
  deck.add(new THREE.BoxGeometry(1.16, 0.09, 1.16), 0, platY - 0.05, 0);
  deck.add(new THREE.BoxGeometry(1.08, 0.05, 1.08), 0, platY + 0.02, 0);
  const railPost = new THREE.BoxGeometry(0.04, 0.62, 0.04);
  const railBar = new THREE.BoxGeometry(1.1, 0.04, 0.04);
  for (const side of [-1, 1] as const) {
    deck.add(railPost, side * 0.5, platY + 0.34, -0.5);
    deck.add(railPost, side * 0.5, platY + 0.34, 0.0);
    deck.addQ(railBar, new THREE.Vector3(side * 0.5, platY + 0.62, -0.25), new THREE.Quaternion().setFromAxisAngle(Y_AXIS, Math.PI / 2));
    deck.addQ(railBar, new THREE.Vector3(side * 0.5, platY + 0.34, -0.25), new THREE.Quaternion().setFromAxisAngle(Y_AXIS, Math.PI / 2));
  }
  deck.add(railPost, -0.5, platY + 0.34, 0.5);
  deck.add(railPost, 0.5, platY + 0.34, 0.5);
  deck.add(railBar, 0, platY + 0.62, 0.5);
  deck.add(railBar, 0, platY + 0.34, 0.5);
  // 爬梯（南面）+ 护笼环
  const stileGeo = new THREE.BoxGeometry(0.05, 1, 0.05);
  ladder.addBetweenCylinder(stileGeo, new THREE.Vector3(-0.24, 0.18, 0.66), new THREE.Vector3(-0.2, platY + 0.7, 0.44));
  ladder.addBetweenCylinder(stileGeo, new THREE.Vector3(0.24, 0.18, 0.66), new THREE.Vector3(0.2, platY + 0.7, 0.44));
  const rungGeo = new THREE.CylinderGeometry(0.016, 0.016, 0.48, 5);
  rungGeo.rotateZ(Math.PI / 2);
  const rungN = Math.round((platY + 0.4) / 0.32);
  for (let r = 0; r <= rungN; r += 1) {
    const t = r / rungN;
    const y = 0.3 + t * (platY + 0.3);
    ladder.add(rungGeo, -0.22 + 0.02 * t, y, 0.66 - 0.2 * t, 0, rng.gauss(0, 0.03), 0);
  }
  for (const t of [0.45, 0.72]) {
    ladder.add(new THREE.TorusGeometry(0.36, 0.02, 4, 10), 0, 0.3 + t * (platY + 0.3), 0.66 - 0.2 * t, 1.2, 0, 0);
  }
  // 配电箱与缆线（塔腿一侧）
  bits.add(box(0.3, 0.4, 0.18, M.steelDark), -0.55, 1.6, 0.2, 0, 0.4, 0);
  bits.add(box(0.05, 0.05, 0.5, M.rustDark), -0.55, 1.3, 0.4, 0, 0.4, 0);

  commit(legs, M.steel, root, 'tower-legs');
  commit(deck, M.steelDark, root, 'tower-deck');
  commit(ladder, M.rust, root, 'tower-ladder');
  bits.flush(root, 'tower-bits');

  // —— 灯头：绕 Y 缓慢转动的盒体 + 发光面 + 体光锥 + 贴地亮斑 ——
  const headY = platY + 0.42;
  const head = group('tower-head');
  head.position.set(0, headY, 0);
  head.rotation.y = spec.facing;
  root.add(head);

  const headBits = new Parts();
  headBits.add(new THREE.CylinderGeometry(0.2, 0.26, 0.22, 10), 0, -0.16, 0); // 转台
  headBits.add(new THREE.BoxGeometry(0.06, 0.36, 0.14), -0.31, 0.02, 0); // 轭板
  headBits.add(new THREE.BoxGeometry(0.06, 0.36, 0.14), 0.31, 0.02, 0);
  headBits.add(new THREE.BoxGeometry(0.56, 0.08, 0.16), 0, 0.26, -0.1); // 灯顶散热檐
  headBits.add(new THREE.TorusGeometry(0.26, 0.04, 6, 12), 0, 0.02, 0.3); // 灯口箍
  headBits.add(new THREE.BoxGeometry(0.2, 0.18, 0.16), 0, 0.02, -0.36); // 灯后配重与电机
  commit(headBits, M.steelDark, head, 'tower-head-bits');

  const pitch = group('tower-pitch');
  const basePitch = 0.46 + (h > 8 ? 0 : 0.08);
  pitch.rotation.x = basePitch;
  head.add(pitch);

  const body = outlineIf(box(0.52, 0.44, 0.6, M.steel), x, z, 0.004);
  body.name = 'tower-lamp-body';
  at(body, 0, 0.02, 0);
  pitch.add(body);
  const lampMat = glowMaterial(0xcfe6ff, 0.92);
  const face = mesh(new THREE.CircleGeometry(0.23, 12), lampMat);
  at(face, 0, 0.02, 0.31);
  pitch.add(face);

  const beamLen = (headY + 0.4) / Math.sin(basePitch);
  const beamMat = new THREE.MeshBasicMaterial({
    map: beamTex,
    color: 0xa9cdf2,
    transparent: true,
    opacity: 0.15,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: true,
  });
  const beamGeo = new THREE.CylinderGeometry(2.6, 0.16, beamLen, 12, 1, true);
  beamGeo.rotateX(Math.PI / 2);
  beamGeo.translate(0, 0, beamLen / 2);
  const beam = mesh(beamGeo, beamMat);
  beam.name = 'tower-beam';
  beam.castShadow = false;
  beam.receiveShadow = false;
  beam.renderOrder = 4;
  pitch.add(beam);
  const coreMat = new THREE.MeshBasicMaterial({
    map: beamTex,
    color: 0xd8ecff,
    transparent: true,
    opacity: 0.2,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: true,
  });
  const coreLen = beamLen * 0.82;
  const coreGeo = new THREE.CylinderGeometry(1.0, 0.1, coreLen, 10, 1, true);
  coreGeo.rotateX(Math.PI / 2);
  coreGeo.translate(0, 0, coreLen / 2);
  const core = mesh(coreGeo, coreMat);
  core.renderOrder = 5;
  core.castShadow = false;
  pitch.add(core);

  // 光锥落地的椭圆亮斑（挂在 head 下保持水平，随扫动一起转）
  const reach = (headY - 0.06) / Math.tan(basePitch);
  const spotMat = new THREE.MeshBasicMaterial({
    map: spotTex,
    color: 0xb9d9f4,
    transparent: true,
    opacity: 0.34,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: true,
  });
  const spot = mesh(new THREE.PlaneGeometry(3.4, 5.4), spotMat);
  spot.rotation.x = -Math.PI / 2;
  at(spot, 0, -(headY - 0.1), reach);
  spot.renderOrder = 4;
  spot.castShadow = false;
  head.add(spot);

  const anim: TowerAnim = {
    head,
    pitch,
    facing: spec.facing,
    period: h > 8 ? 26 : 34,
    phase: rng.range(0, Math.PI * 2),
    amp: 0.82,
    basePitch,
    beamMat,
    coreMat,
    spotMat,
  };
  return { root, anim };
}

/* ============================== BTR-80 ============================== */

const BTR_PROFILE: ReadonlyArray<readonly [number, number]> = [
  [-3.7, 0.7],
  [3.28, 0.7],
  [3.86, 1.08],
  [3.6, 1.64],
  [2.62, 1.98],
  [-3.34, 1.98],
  [-3.86, 1.32],
];

interface BtrCfg {
  x: number;
  z: number;
  rotY: number;
  openHatch?: boolean;
  plank?: boolean;
  tarpRoll?: boolean;
  mudHeavy?: boolean;
  holes?: number;
  seed: number;
}

function buildBTR(rng: Rng, cfg: BtrCfg): THREE.Group {
  const vrng = rng.fork(cfg.seed);
  const root = group('btr-80');
  const gy = groundYAt(cfg.x, cfg.z);
  root.position.set(cfg.x, gy, cfg.z);
  root.rotation.set(-0.006, cfg.rotY + vrng.gauss(0, 0.02), vrng.gauss(0, 0.012));

  if (!ok(cfg.x, cfg.z, 8.4, 3.6)) return root;

  /* ——— 车体（船形首上，一次挤出成型） ——— */
  const hull = extrudeSide(BTR_PROFILE, 2.9, wetArmorMat, 0.05);
  hull.name = 'btr-hull';
  outlineIf(hull, cfg.x, cfg.z, 0.0044);
  root.add(hull);

  const bits = new Bits();
  const darkBits = new Bits();

  // 首上牌与防浪板（折叠在首上，真实厚度）
  bits.add(box(2.5, 0.06, 0.92, M.armorLight), 0, 1.36, 3.7, 0.4, 0, 0);
  bits.add(box(2.54, 0.1, 0.14, M.armorDark), 0, 0.94, 3.9, 0.4, 0, 0);
  for (const bx of [-0.9, 0.9]) {
    bits.add(cyl(0.03, 0.03, 0.5, 6, M.gun), bx, 0.95, 3.92, 0.4, 0, Math.PI / 2); // 折叠铰链杆
  }

  // 挡风镜（凹陷玻璃 + 装甲护罩，一辆左罩掀起）
  for (const side of [-1, 1]) {
    bits.add(box(0.86, 0.06, 0.5, M.glassDark), side * 0.62, 1.86, 3.02, -0.42, 0, 0);
    if (cfg.openHatch && side < 0) {
      const hinge = group('shutter-hinge');
      hinge.position.set(side * 0.62, 1.98, 2.86);
      hinge.rotation.x = -2.5;
      const shutter = box(0.9, 0.54, 0.07, M.armorDark);
      at(shutter, 0, 0, 0.26);
      hinge.add(shutter);
      root.add(hinge);
      for (const hx of [-0.3, 0.3]) {
        bits.add(cyl(0.035, 0.035, 0.12, 6, M.gun), side * 0.62 + hx, 1.98, 2.86, 0, 0, Math.PI / 2);
      }
    } else {
      bits.add(box(0.9, 0.54, 0.07, M.armorDark), side * 0.62, 1.9, 3.16, -0.42, 0, 0);
    }
  }

  // 前灯：遮光罩（灯体 + 罩格 + 格后透出的一点灯芯；两枚灯芯合批）
  const bulbParts = new Parts();
  const bulbMat = glowMaterial(0xffdfae, 0.4);
  for (const side of [-1, 1]) {
    const px = side * 1.12;
    bits.add(box(0.24, 0.28, 0.16, M.gun), px, 1.22, 3.86, 0.36, 0, 0);
    darkBits.add(box(0.26, 0.3, 0.06, M.steelDark), px, 1.24, 3.97, 0.36, 0, 0);
    for (const gx of [-0.07, 0, 0.07]) {
      darkBits.add(box(0.022, 0.26, 0.03, M.burnt), px + gx, 1.24, 4.0, 0.36, 0, 0);
    }
    darkBits.add(box(0.2, 0.022, 0.03, M.burnt), px, 1.28, 4.0, 0.36, 0, 0);
    bulbParts.add(new THREE.CircleGeometry(0.05, 8), px, 1.24, 3.985, 0.36, 0, 0);
  }
  commit(bulbParts, bulbMat, root, 'btr-bulbs');

  // 侧舷射击孔：真实凹陷 + 外开孔盖（一枚半开）+ 铰链与把手
  const portZ = [1.2, -0.25, -1.7];
  for (const side of [-1, 1]) {
    portZ.forEach((pz, pi) => {
      const ajar = cfg.openHatch === undefined && side > 0 && pi === 1;
      bits.add(box(0.09, 0.44, 0.3, M.burnt), side * 1.43, 1.44, pz); // 凹腔
      if (ajar) {
        const hg = group('port-hinge');
        hg.position.set(side * 1.47, 1.44, pz - 0.17);
        hg.rotation.y = side * 0.85;
        hg.add(at(box(0.05, 0.46, 0.34, M.armorDark), side * 0.05, 0, 0.17));
        root.add(hg);
      } else {
        bits.add(box(0.06, 0.48, 0.36, M.armorDark), side * 1.47, 1.44, pz);
      }
      bits.add(cyl(0.02, 0.02, 0.4, 5, M.gun), side * 1.49, 1.44, pz - 0.19);
      bits.add(box(0.03, 0.05, 0.12, M.gun), side * 1.5, 1.26, pz + 0.1); // 把手
    });
  }

  // 车顶：乘员舱盖 ×2（一处掀开带铰链与提手）+ 进水口/排气/储物箱
  const hatchAt = (hx: number, hz: number, open: boolean): void => {
    darkBits.add(cyl(0.37, 0.39, 0.07, 10, M.armorDark), hx, 1.99, hz);
    if (open) {
      const hinge = group('hatch-hinge');
      hinge.position.set(hx, 2.02, hz - 0.36);
      hinge.rotation.x = -1.18;
      const disc = cyl(0.33, 0.33, 0.06, 10, M.armorLight);
      at(disc, 0, 0.03, 0.33);
      hinge.add(disc);
      hinge.add(at(torus(0.08, 0.02, M.gun, 8), 0, 0.07, 0.56, Math.PI / 2));
      root.add(hinge);
      for (const kx of [-0.12, 0.12]) {
        darkBits.add(cyl(0.035, 0.035, 0.12, 6, M.gun), hx + kx, 2.01, hz - 0.36, 0, 0, Math.PI / 2);
      }
    } else {
      bits.add(cyl(0.33, 0.33, 0.07, 10, M.armorLight), hx, 2.04, hz);
      bits.add(box(0.14, 0.03, 0.05, M.gun), hx + 0.2, 2.09, hz);
    }
  };
  hatchAt(-0.72, 2.42, cfg.openHatch === true);
  hatchAt(0.56, 1.55, cfg.openHatch === true ? false : rng.chance(0.2));
  bits.add(box(0.5, 0.1, 0.36, M.armorLight), 0.1, 2.02, 0.2); // 通风格盖
  darkBits.add(box(1.9, 0.2, 0.6, M.armorDark), 0, 2.0, -2.9); // 后甲板框

  // 后部散热格栅（一排斜条）+ 排气 + 拖钩
  for (let i = 0; i < 7; i += 1) {
    darkBits.add(box(1.8, 0.05, 0.07, M.gun), 0, 2.06, -2.66 - i * 0.14);
  }
  bits.add(cyl(0.065, 0.07, 0.5, 8, M.rustDark), -1.0, 1.5, -3.86, Math.PI / 2 - 0.25, 0, 0);
  bits.add(torus(0.1, 0.03, M.gun, 8), 0.7, 0.86, -3.9, 0, 0, Math.PI / 2);
  // 侧裙板/踏条与捆扎扣
  for (const side of [-1, 1]) {
    bits.add(box(0.14, 0.05, 5.9, M.armorDark), side * 1.44, 1.98, -0.2);
    for (let i = 0; i < 5; i += 1) {
      darkBits.add(box(0.06, 0.07, 0.08, M.gun), side * 1.49, 1.98, 2.1 - i * 1.05);
    }
    bits.add(box(0.4, 0.06, 1.3, M.armorDark), side * 1.5, 0.98, -2.95); // 轮后挡泥板
  }
  // 千斤顶与随车工具
  bits.add(box(0.08, 0.08, 1.0, M.rust), -1.32, 1.66, 0.45, 0, 0, 0);
  bits.add(cyl(0.05, 0.05, 0.36, 6, M.rustDark), -1.32, 1.4, 0.45, 0, 0, Math.PI / 2);
  // 天线
  const ant = cyl(0.014, 0.02, 1.35, 5, M.gun);
  at(ant, 1.12, 2.62, -2.5);
  ant.rotation.set(0.1, 0, 0.05);
  root.add(ant);

  // 烟幕发射器组：每侧 5 管（instanced）
  const smokeTransforms: InstanceTransform[] = [];
  const smokeGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.26, 8);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 5; i += 1) {
      smokeTransforms.push({
        position: new THREE.Vector3(side * 1.3, 1.8 + i * 0.0, 2.98 - i * 0.17),
        rotation: new THREE.Euler(-0.5, 0, side * (0.14 + i * 0.05)),
      });
    }
  }
  root.add(instanced(smokeGeo, M.gun, smokeTransforms));

  /* ——— 车轮：8 个大直径轮胎 + 人字胎纹 ——— */
  const treadCount = levelOf(cfg.x, cfg.z) === 2 ? 12 : 16;
  const tyre = tyreGeometry(0.56, 0.34, treadCount);
  const wheelZ = [2.44, 0.88, -0.68, -2.24];
  const bodyT: InstanceTransform[] = [];
  const treadT: InstanceTransform[] = [];
  const hubT: InstanceTransform[] = [];
  wheelZ.forEach((wz, wi) => {
    const steer = wi === 0 ? vrng.range(0.1, 0.22) * vrng.sign() : 0;
    for (const side of [-1, 1]) {
      const cx = side * 1.3;
      bodyT.push({ position: new THREE.Vector3(cx, 0.56, wz), rotation: new THREE.Euler(0, steer, 0) });
      hubT.push({ position: new THREE.Vector3(cx, 0.56, wz), rotation: new THREE.Euler(0, steer, 0) });
      const step = (Math.PI * 2) / treadCount;
      for (let k = 0; k < treadCount; k += 1) {
        const a = k * step;
        for (const s of [-1, 1]) {
          const local = new THREE.Vector3((s * 0.34) / 4, Math.cos(a) * 0.56, Math.sin(a) * 0.56).applyAxisAngle(Y_AXIS, steer);
          treadT.push({
            position: new THREE.Vector3(cx + local.x, 0.56 + local.y, wz + local.z),
            rotation: new THREE.Euler(-a + (s > 0 ? 0.22 : -0.22), steer, 0),
          });
        }
      }
    }
  });
  const bodyInst = instanced(tyre.body, M.tire, bodyT);
  bodyInst.name = 'btr-tyres';
  root.add(bodyInst);
  const treadInst = instanced(tyre.tread, M.tire, treadT);
  treadInst.name = 'btr-tread';
  root.add(treadInst);
  const hubGeo = new THREE.CylinderGeometry(0.26, 0.26, 0.36, 10);
  hubGeo.rotateZ(Math.PI / 2);
  root.add(instanced(hubGeo, M.armorLight, hubT));

  /* ——— 履带泥污：湿泥甩在侧下缘与轮拱 ——— */
  const mudParts = new Parts();
  const mudSpots: Array<[number, number, number]> = [];
  for (const side of [-1, 1]) {
    for (const wz of wheelZ) {
      mudSpots.push([side * 1.47, 0.92 + vrng.range(0, 0.16), wz + vrng.range(-0.3, 0.3)]);
      if (cfg.mudHeavy) mudSpots.push([side * 1.45, 1.3 + vrng.range(0, 0.3), wz + vrng.range(-0.5, 0.5)]);
    }
    mudSpots.push([side * 1.2, 1.05, 3.55]);
  }
  for (const [mx, my, mz] of mudSpots) {
    mudParts.add(new THREE.BoxGeometry(0.05, 0.24, 0.7), mx, my, mz, vrng.gauss(0, 0.1), 0, vrng.gauss(0, 0.3), 1, vrng.range(0.6, 1.2), vrng.range(0.5, 1.1));
  }

  /* ——— 生活感：登车板 / 顶甲板帆布卷 ——— */
  if (cfg.plank) {
    const foot = new THREE.Vector3(1.62, 0.05, 2.3);
    const top = new THREE.Vector3(1.5, 1.12, 0.95);
    const d = new THREE.Vector3().subVectors(top, foot);
    const q = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, d.clone().normalize());
    const plank = box(0.36, d.length(), 0.07, M.wood);
    plank.quaternion.copy(q);
    plank.position.copy(foot).add(d.clone().multiplyScalar(0.5));
    root.add(plank);
    for (const t of [0.25, 0.5, 0.75]) {
      const cleat = box(0.38, 0.05, 0.06, M.woodDark);
      cleat.quaternion.copy(q);
      cleat.position.copy(foot).add(d.clone().multiplyScalar(t));
      cleat.position.y += 0.05;
      root.add(cleat);
    }
    mudParts.add(new THREE.BoxGeometry(0.3, 0.06, 0.3), 1.62, 0.04, 2.3);
  }
  if (cfg.tarpRoll) {
    const roll = cyl(0.14, 0.14, 0.94, 10, M.tarp);
    at(roll, -0.25, 2.12, -2.86);
    roll.rotation.set(0, 0.2, Math.PI / 2);
    root.add(roll);
    for (const sx of [-0.5, 0.1]) {
      darkBits.add(box(0.05, 0.3, 0.32, M.ragGrey), sx - 0.25, 2.12, -2.86, 0, 0.2, Math.PI / 2);
    }
  }

  /* ——— 战损：侧舷弹孔 + 崩裂碎屑 ——— */
  if (cfg.holes && cfg.holes > 0) {
    const list: Array<{ p: [number, number, number]; n: [number, number, number] }> = [];
    for (let i = 0; i < cfg.holes; i += 1) {
      const side = vrng.chance(0.5) ? -1 : 1;
      list.push({
        p: [side * 1.47, vrng.range(1.1, 1.7), vrng.range(-2.4, 1.8)],
        n: [side, vrng.range(-0.2, 0.2), vrng.range(-0.2, 0.2)],
      });
    }
    bulletHoles(root, vrng, list);
  }

  commit(mudParts, M.mud, root, 'btr-mud');
  bits.flush(root, 'btr-bits');
  darkBits.flush(root, 'btr-dark');

  // 车底湿泥与浅积水（局部坐标：贴在本车地面系，不走 groundYAt）
  const mud1 = decal(0, 0.2, 2.6, M.dirtDecal, vrng, 0.5, 0.008);
  mud1.position.y = 0.012;
  root.add(mud1);
  const mud2 = decal(cfg.mudHeavy ? -1.2 : 1.4, -2.4, 1.4, M.dirtDecal, vrng, 0.7, 0.008);
  mud2.position.y = 0.012;
  root.add(mud2);

  return root;
}

/* ============================== 半塌岗亭 ============================== */

interface LooseSheet {
  pivot: THREE.Group;
  baseRx: number;
  phase: number;
}

function buildGuardBooth(root: THREE.Group, rng: Rng, sheets: LooseSheet[]): void {
  const bx = 17.4;
  const bz = 116.3;
  if (!ok(bx, bz, 3.6, 3.4)) return;
  const gy = groundYAt(bx, bz);
  const g = group('guard-booth');
  g.position.set(bx, gy, bz);
  g.rotation.y = -0.12;
  root.add(g);

  const walls = new Parts();
  const interior = new Parts();
  const metalParts = new Parts();
  const chips: InstanceTransform[] = [];
  const wallGeo = new THREE.BoxGeometry(1, 1, 1); // 单位盒，缩放成型

  // 地坪 + 门槛
  g.add(at(softBox(2.95, 0.16, 2.75, 0.05, M.concrete), 0, 0.06, 0));

  // 北墙：留真洞的窗（4 块实体拼出洞口，窗框有厚度）
  const t = 0.26;
  const H = 2.3;
  walls.addQ(wallGeo, new THREE.Vector3(-0.95, H / 2, -1.25), new THREE.Quaternion(), new THREE.Vector3(1.05, H, t));
  walls.addQ(wallGeo, new THREE.Vector3(1.15, H / 2, -1.25), new THREE.Quaternion(), new THREE.Vector3(0.65, H, t));
  walls.addQ(wallGeo, new THREE.Vector3(0.1, H - 0.18, -1.25), new THREE.Quaternion(), new THREE.Vector3(1.45, 0.36, t));
  walls.addQ(wallGeo, new THREE.Vector3(0.1, 0.55, -1.25), new THREE.Quaternion(), new THREE.Vector3(1.45, 1.1, t));
  const frame = mesh(windowFrameGeometry(1.0, 0.62, 0.3, true), M.woodDark);
  at(frame, 0.1, 1.2, -1.25);
  g.add(frame);
  // 洞内凹陷处：碎玻璃还挂在框上（参差破片，凹进 0.1）
  const glass = mesh(chippedSlab(0.9, 0.55, 0.014, rng, 0.42), M.glassDark);
  glass.rotation.z = 0.08;
  at(glass, 0.06, 1.14, -1.19);
  g.add(glass);

  // 东墙：半截（整面被掀掉一块，参差断口用错位体块 + 崩块）
  walls.addQ(wallGeo, new THREE.Vector3(1.3, 0.75, 0), new THREE.Quaternion(), new THREE.Vector3(t, 1.5, 2.6));
  walls.addQ(wallGeo, new THREE.Vector3(1.3, 1.72, -0.75), new THREE.Quaternion(), new THREE.Vector3(t, 0.5, 1.0));
  for (let i = 0; i < 5; i += 1) {
    walls.add(
      new THREE.BoxGeometry(0.3 + rng.range(0, 0.2), 0.24 + rng.range(0, 0.2), 0.24),
      1.3 + rng.range(-0.1, 0.1),
      1.5 + rng.range(-0.1, 0.25),
      0.2 + i * 0.42,
      rng.range(-0.3, 0.3),
      rng.range(-0.3, 0.3),
      rng.range(-0.4, 0.4),
    );
    walls.addQ(wallGeo, new THREE.Vector3(1.3, 1.5 + rng.range(-0.1, 0.2), 0.25 + i * 0.44), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, rng.gauss(0, 0.12))), new THREE.Vector3(t * 1.1, 0.35, 0.5));
  }

  // 西墙残根 + 南门框立柱（被炸飞，只剩铰链一侧）
  walls.addQ(wallGeo, new THREE.Vector3(-1.3, 0.4, -0.4), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.06, 0.03, -0.1)), new THREE.Vector3(t, 0.8, 1.9));
  walls.addQ(wallGeo, new THREE.Vector3(-0.2, H / 2, 1.3), new THREE.Quaternion(), new THREE.Vector3(0.3, H, t));
  metalParts.add(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 6), -0.2, 1.9, 1.32, 0, 0, Math.PI / 2); // 门铰链残杆

  // 顶板：塌下来斜搭在北墙与残根上（真实厚度 + 破边）
  const roof = jitter(new THREE.BoxGeometry(3.05, 0.14, 2.8), 0.03, rng);
  const roofMesh = outlineIf(mesh(roof, M.concrete), bx, bz, 0.004);
  roofMesh.name = 'booth-roof';
  at(roofMesh, -0.15, 2.05, -0.25);
  roofMesh.rotation.set(0.16, 0.1, -0.34);
  g.add(roofMesh);
  // 支撑顶板的弯折角柱
  metalParts.add(new THREE.BoxGeometry(0.14, 1.5, 0.14), -1.1, 1.1, -1.15, 0.06, 0, 0.14);

  // 半挂在外墙上的波纹铁皮（被风掀动的那件金属件）
  const sheetPivot = group('booth-sheet-pivot');
  sheetPivot.position.set(1.36, 1.5, 0.55);
  const sheetParts = new Parts();
  for (let i = 0; i < 6; i += 1) {
    sheetParts.add(new THREE.BoxGeometry(0.19, 0.92, 0.035), -0.5 + i * 0.19, -0.46, i % 2 === 0 ? 0.02 : -0.02);
  }
  sheetParts.add(new THREE.BoxGeometry(1.1, 0.05, 0.09), 0, -0.02, 0);
  const sheetMesh = sheetParts.take(M.steelBright, 'booth-sheet');
  if (sheetMesh) sheetPivot.add(sheetMesh);
  for (const hx of [-0.4, 0.4]) {
    metalParts.add(new THREE.BoxGeometry(0.05, 0.05, 0.08), hx, 0, 0.02);
  }
  sheetPivot.rotation.x = -0.16;
  g.add(sheetPivot);
  sheets.push({ pivot: sheetPivot, baseRx: -0.16, phase: rng.range(0, 6.28) });

  // 室内：倒凳、木箱、暗角（凳件按材质合批成一个网格）
  const stoolParts = new Parts();
  stoolParts.add(new THREE.BoxGeometry(0.4, 0.05, 0.4), 0, 0, 0);
  for (const [lx, lz] of [[0.16, 0.16], [-0.16, 0.16], [0.16, -0.16], [-0.16, -0.16]] as Array<[number, number]>) {
    stoolParts.add(new THREE.BoxGeometry(0.05, 0.36, 0.05), lx, -0.2, lz);
  }
  const stool = stoolParts.take(M.wood, 'stool');
  if (stool) {
    at(stool, -0.5, 0.3, 0.7);
    stool.rotation.set(Math.PI / 2 - 0.2, 0.7, 0.1);
    g.add(stool);
  }
  interior.add(new THREE.BoxGeometry(0.62, 0.34, 0.42), 0.7, 0.3, 0.85, 0, 0.4, 0);

  // 弹孔 + 崩屑（北墙与东墙）
  bulletHoles(g, rng, [
    { p: [-0.7, 1.5, -1.36], n: [0, 0.1, -1] },
    { p: [0.85, 1.0, -1.36], n: [0.1, 0, -1] },
    { p: [1.44, 1.1, -0.2], n: [1, 0.1, 0] },
    { p: [1.44, 0.7, 0.6], n: [1, 0, 0.1] },
  ]);

  // 塌下来的混凝土崩块（instanced）
  for (let i = 0; i < 16; i += 1) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(1.6, 3.0);
    chips.push({
      position: new THREE.Vector3(Math.cos(a) * r, rng.range(0.05, 0.16), Math.sin(a) * r),
      rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)),
      scale: new THREE.Vector3(rng.range(0.16, 0.5), rng.range(0.12, 0.32), rng.range(0.16, 0.5)),
    });
  }

  commit(walls, M.concrete, g, 'booth-walls');
  commit(interior, M.woodDark, g, 'booth-interior');
  commit(metalParts, M.steelDark, g, 'booth-metal');
  if (chips.length > 0) {
    const chipMesh = instanced(jitter(new THREE.BoxGeometry(0.4, 0.3, 0.35), 0.05, rng), M.concrete, chips);
    chipMesh.name = 'booth-chips';
    g.add(chipMesh);
  }
  const boothScorch = decal(0, 1.2, 1.9, M.ashDecal, rng, 0.7, 0.01);
  boothScorch.position.y = 0.012;
  g.add(boothScorch);
}

/* ============================== 哨兵篝火 ============================== */

interface FireAnim {
  flames: Array<{ obj: THREE.Object3D; base: number; phase: number }>;
  flameMats: THREE.MeshBasicMaterial[];
  coreMat: THREE.MeshBasicMaterial;
  ember: { inst: THREE.InstancedMesh; mat: THREE.MeshBasicMaterial; phases: number[] } | null;
  light: THREE.PointLight | null;
  lightBase: number;
  spills: THREE.MeshBasicMaterial[];
}

function buildCampfire(root: THREE.Group, ctx: BuildContext, rng: Rng, anim: FireAnim): void {
  const fx = HOTSPOTS.outpostFire.x;
  const fz = HOTSPOTS.outpostFire.z;
  if (!ok(fx, fz, 4.2, 4.2)) return;
  const gy = groundYAt(fx, fz);
  const g = group('outpost-fire');
  g.position.set(fx, gy, fz);
  root.add(g);

  // 坐痕圈：烧黑的地面 + 四个坐位土包
  const fireScorch = decal(0, 0, 1.9, M.ashDecal, rng, 0.92, 0.01);
  fireScorch.position.y = 0.012;
  g.add(fireScorch);
  const seats = new Parts();
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * Math.PI * 2 + 0.5;
    seats.add(new THREE.BoxGeometry(0.9, 0.05, 0.7), Math.cos(a) * 1.5, 0.0, Math.sin(a) * 1.5, 0, -a, 0);
  }
  commit(seats, M.mud, g, 'fire-seat-wear');

  // 石圈
  const stoneT: InstanceTransform[] = [];
  for (let i = 0; i < 10; i += 1) {
    const a = (i / 10) * Math.PI * 2;
    stoneT.push({
      position: new THREE.Vector3(Math.cos(a) * 0.62, 0.07 + rng.range(-0.02, 0.03), Math.sin(a) * 0.62),
      rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)),
      scale: new THREE.Vector3(rng.range(0.5, 0.9), rng.range(0.4, 0.7), rng.range(0.5, 0.9)),
    });
  }
  g.add(instanced(new THREE.DodecahedronGeometry(0.14, 0), M.concrete, stoneT));

  // 焦木：斜搭向内 + 两根滚落在外
  const logs = new Parts();
  const logGeo = new THREE.CylinderGeometry(0.055, 0.075, 0.85, 6);
  for (let i = 0; i < 7; i += 1) {
    const a = (i / 7) * Math.PI * 2 + rng.gauss(0, 0.2);
    logs.add(logGeo, Math.cos(a) * 0.36, 0.24, Math.sin(a) * 0.36, Math.PI / 2 - 0.85, a, 0);
  }
  logs.add(logGeo, 0.8, 0.07, -0.5, Math.PI / 2, 0.9, 0);
  logs.add(new THREE.CylinderGeometry(0.045, 0.06, 0.66, 6), -0.9, 0.06, 0.4, Math.PI / 2, -0.5, 0);
  commit(logs, M.burnt, g, 'fire-logs');

  // 火苗：三面交叉加色面片
  const fTex = flameTexture();
  const flameA = new THREE.MeshBasicMaterial({ map: fTex, color: PALETTE.fire, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: true, side: THREE.DoubleSide });
  const flameB = new THREE.MeshBasicMaterial({ map: fTex, color: PALETTE.warmLightDeep, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, fog: true, side: THREE.DoubleSide });
  const coreM = new THREE.MeshBasicMaterial({ map: fTex, color: PALETTE.fireCore, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: true, side: THREE.DoubleSide });
  anim.flameMats.push(flameA, flameB);
  anim.coreMat = coreM;
  const flameDefs: Array<[number, THREE.MeshBasicMaterial, number]> = [
    [0.0, flameA, 0.85],
    [Math.PI / 2.4, flameB, 0.6],
    [Math.PI / 1.2, flameA, 0.45],
  ];
  for (const [ry, mat, base] of flameDefs) {
    const fm = mesh(new THREE.PlaneGeometry(0.62, 0.8), mat);
    fm.rotation.x = -0.08;
    fm.rotation.y = ry;
    at(fm, rng.gauss(0, 0.06), 0.46, rng.gauss(0, 0.06));
    fm.renderOrder = 6;
    fm.castShadow = false;
    g.add(fm);
    anim.flames.push({ obj: fm, base, phase: rng.range(0, 6.28) });
  }
  const core = mesh(new THREE.PlaneGeometry(0.28, 0.34), coreM);
  at(core, 0, 0.3, 0.02);
  core.rotation.y = Math.PI / 3;
  core.renderOrder = 7;
  g.add(core);
  anim.flames.push({ obj: core, base: 1, phase: rng.range(0, 6.28) });
  const bed = mesh(new THREE.CircleGeometry(0.34, 10), coreM);
  bed.rotation.x = -Math.PI / 2;
  at(bed, 0, 0.09, 0);
  bed.renderOrder = 6;
  g.add(bed);

  // 余烬：一圈贴地小面片，一次 instanced，逐颗变色呼吸（余烬忽明忽暗）
  const emberMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: true });
  const emberT: InstanceTransform[] = [];
  const emberPhases: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    emberT.push({
      position: new THREE.Vector3(Math.cos(a) * 0.5, 0.075, Math.sin(a) * 0.5),
      rotation: new THREE.Euler(-Math.PI / 2 + rng.gauss(0, 0.3), a, 0),
    });
    emberPhases.push(rng.range(0, Math.PI * 2));
  }
  const emberInst = instanced(new THREE.PlaneGeometry(0.11, 0.07), emberMat, emberT);
  emberInst.name = 'fire-embers';
  emberInst.renderOrder = 6;
  const baseEmber = new THREE.Color(PALETTE.ember);
  for (let i = 0; i < emberT.length; i += 1) emberInst.setColorAt(i, baseEmber);
  g.add(emberInst);
  anim.ember = { inst: emberInst, mat: emberMat, phases: emberPhases };

  // 三脚架吊锅
  const tripod = new Parts();
  for (let i = 0; i < 3; i += 1) {
    const a = (i / 3) * Math.PI * 2 - 0.4;
    tripod.addBetweenCylinder(
      new THREE.CylinderGeometry(0.03, 0.035, 1, 5),
      new THREE.Vector3(Math.cos(a) * 0.95, 0.02, Math.sin(a) * 0.95),
      new THREE.Vector3(0, 1.72, 0),
    );
  }
  tripod.add(new THREE.CylinderGeometry(0.018, 0.018, 1, 4), 0, 1.32, 0, 0, 0, 0, 1, 0.74, 1); // 吊链
  commit(tripod, M.woodDark, g, 'fire-tripod');
  const pot = new Bits();
  pot.add(cyl(0.19, 0.16, 0.26, 12, M.burnt), 0, 0.9, 0);
  pot.add(torus(0.19, 0.022, M.soot, 12), 0, 1.03, 0, Math.PI / 2);
  pot.add(torus(0.15, 0.015, M.gun, 10), 0, 1.14, 0, 0.2);
  pot.add(cyl(0.12, 0.12, 0.03, 10, M.steelDark), 0.02, 1.16, 0, 0.2, 0.3, 0.1); // 歪着的锅盖
  pot.flush(g, 'fire-pot');

  // 一圈坐痕旁的罐头盒与搪瓷盆（instanced 罐 + 两件盆）
  const canT: InstanceTransform[] = [];
  for (let i = 0; i < 13; i += 1) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(0.9, 1.9);
    const fallen = rng.chance(0.4);
    canT.push({
      position: new THREE.Vector3(Math.cos(a) * r, fallen ? 0.045 : 0.075, Math.sin(a) * r),
      rotation: new THREE.Euler(fallen ? Math.PI / 2 + rng.gauss(0, 0.15) : rng.gauss(0, 0.05), rng.range(0, 3), 0),
      scale: new THREE.Vector3(1, rng.range(0.85, 1.15), 1),
    });
  }
  const canInst = instanced(new THREE.CylinderGeometry(0.047, 0.047, 0.115, 8), M.tin, canT);
  canInst.name = 'fire-cans';
  g.add(canInst);
  const bowlParts = new Parts();
  for (let i = 0; i < 2; i += 1) {
    bowlParts.add(new THREE.CylinderGeometry(0.1, 0.075, 0.055, 10), rng.range(-1.4, 1.4), 0.045, rng.range(-1.4, 1.4), rng.gauss(0, 0.12), rng.range(0, 3), rng.gauss(0, 0.12));
  }
  commit(bowlParts, M.enamel, g, 'fire-bowls');

  // 一圈坐痕旁的罐头盒与搪瓷盆（instanced 罐 + 两件盆）
  const fireCrate = at(box(0.62, 0.34, 0.42, M.armorDark), -1.5, 0.2, 0.9);
  fireCrate.rotation.y = 0.7;
  g.add(fireCrate);
  const shovel = new Parts();
  shovel.add(new THREE.BoxGeometry(0.035, 1.0, 0.035), -1.2, 0.4, 1.5, 0.18, 0, -0.1);
  shovel.add(new THREE.BoxGeometry(0.2, 0.26, 0.02), -1.31, -0.02, 1.53, 0.18, 0, -0.1);
  shovel.add(new THREE.BoxGeometry(0.035, 0.9, 0.035), 1.3, 0.35, 1.4, -0.14, 0, 0.12);
  commit(shovel, M.rust, g, 'fire-tools');

  // 真点光（全工程申请 ≤1 盏）+ 湿地拉长反光
  let light: THREE.PointLight | null = null;
  if (ctx.lightCount < 16) {
    light = new THREE.PointLight(PALETTE.warmLightDeep, 5.2, 9.5, 2);
    at(light, 0, 0.78, 0);
    ctx.addLight(light);
  }
  anim.light = light;
  anim.lightBase = 5.2;

  const spillTex = spillTexture();
  for (const [rot, len, wd, base] of [[0.35, 8.5, 3.4, 0.4], [Math.PI - 0.5, 6.2, 2.8, 0.3]] as Array<[number, number, number, number]>) {
    const mat = new THREE.MeshBasicMaterial({ map: spillTex, color: PALETTE.fire, transparent: true, opacity: base, blending: THREE.AdditiveBlending, depthWrite: false, fog: true });
    const pl = mesh(new THREE.PlaneGeometry(wd, len), mat);
    pl.rotation.x = -Math.PI / 2;
    pl.rotation.z = rot;
    pl.position.set(fx, 0.13, fz);
    pl.renderOrder = 5;
    pl.castShadow = false;
    root.add(pl);
    anim.spills.push(mat);
  }
}

/* ============================== 迫击炮阵地 ============================== */

function buildMortar(
  root: THREE.Group,
  rng: Rng,
  bagLight: Parts,
  bagDark: Parts,
  bagWear: Parts,
  tarpParts: Parts,
  tireParts: Parts,
): void {
  const mx = HOTSPOTS.mortarPit.x;
  const mz = HOTSPOTS.mortarPit.z;
  if (!ok(mx, mz, 7.5, 7.5)) return;
  const gy = groundYAt(mx, mz);
  const g = group('mortar-pit');
  g.position.set(mx, gy, mz);
  root.add(g);

  // 挖开的土围（半环）+ 压平的坑底
  const pitFloor = decal(0, 0, 2.6, M.dirtDecal, rng, 0.9, 0.006);
  pitFloor.position.y = 0.01;
  g.add(pitFloor);
  const berm = new Parts();
  for (let i = 0; i < 9; i += 1) {
    const a = -Math.PI * 0.15 + (i / 8) * Math.PI * 1.3 + 0.4;
    berm.add(
      softBox(1.15, 0.3, 0.7, 0.12, M.dirt).geometry,
      Math.cos(a) * 2.1,
      0.12 + rng.gauss(0, 0.03),
      Math.sin(a) * 2.1,
      rng.gauss(0, 0.06),
      -a + Math.PI / 2 + rng.gauss(0, 0.2),
      rng.gauss(0, 0.06),
    );
  }
  commit(berm, M.dirt, g, 'mortar-berm');

  // 炮：座板 + 炮身（射界朝北）+ 两脚架 + 瞄具 + 驻锄
  const plate = cyl(0.44, 0.48, 0.09, 12, M.steelDark);
  at(plate, 0, 0.1, 0);
  g.add(plate);
  const plateRim = torus(0.44, 0.03, M.steel, 14);
  plateRim.rotation.x = Math.PI / 2;
  at(plateRim, 0, 0.14, 0);
  g.add(plateRim);

  const aim = group('mortar-aim');
  aim.rotation.y = Math.PI - 0.12; // 朝北（略偏东），出城方向以北为主射界
  g.add(aim);
  const pitchG = group('mortar-tube-pitch');
  pitchG.rotation.x = 0.22;
  aim.add(pitchG);

  const tube = cyl(0.062, 0.08, 1.9, 12, M.gun);
  at(tube, 0, 1.05, 0);
  pitchG.add(tube);
  const barrelBits = new Bits();
  barrelBits.add(torus(0.082, 0.02, M.rust, 10), 0, 0.25, 0, Math.PI / 2);
  barrelBits.add(cyl(0.095, 0.095, 0.18, 10, M.steelDark), 0, 0.12, 0);
  barrelBits.add(box(0.26, 0.1, 0.1, M.steelDark), 0, 0.05, -0.02); // 尾座
  // 瞄具：支臂 + 圆盘
  barrelBits.add(box(0.05, 0.05, 0.24, M.steel), 0.12, 1.35, 0.06);
  barrelBits.add(cyl(0.09, 0.09, 0.03, 10, M.brass), 0.26, 1.38, 0.1, Math.PI / 2, 0, 0);
  barrelBits.flush(pitchG, 'mortar-bits');

  // 两脚架：架腿落在平地上（挂在 aim 上、不随炮身俯仰）
  const bipod = new Parts();
  for (const side of [-1, 1]) {
    bipod.addBetweenCylinder(
      new THREE.CylinderGeometry(0.022, 0.022, 1, 5),
      new THREE.Vector3(side * 0.06, 1.42, 0.18),
      new THREE.Vector3(side * 0.5, 0.06, 0.52),
    );
    bipod.addBetweenCylinder(
      new THREE.CylinderGeometry(0.048, 0.048, 1, 6),
      new THREE.Vector3(side * 0.28, 1.2, 0.3),
      new THREE.Vector3(side * 0.36, 0.75, 0.42),
    );
    bipod.add(new THREE.BoxGeometry(0.1, 0.05, 0.2), side * 0.5, 0.06, 0.52, 0, side * 0.3, 0);
  }
  commit(bipod, M.steel, aim, 'mortar-bipod');

  // 后方驻锄桩与拉索桩
  const stakes = new Parts();
  stakes.add(new THREE.CylinderGeometry(0.028, 0.028, 0.6, 5), 0.5, 0.2, -1.1, 0.3, 0, 0.2);
  stakes.add(new THREE.CylinderGeometry(0.028, 0.028, 0.6, 5), -0.5, 0.2, -1.15, -0.3, 0, -0.2);
  stakes.addBetweenCylinder(new THREE.CylinderGeometry(0.006, 0.006, 1, 4), new THREE.Vector3(0.5, 0.42, -1.1), new THREE.Vector3(0, 0.9, -0.2));
  commit(stakes, M.woodDark, g, 'mortar-stakes');

  // 弹药堆：沙袋围住 + 木箱 + 散放的 82 迫炮弹（弹体 + 铜头）
  bagWallSeg(rng.fork(0x21), bagLight, bagDark, bagWear, tarpParts, tireParts, mx - 1.55, mz - 0.85, Math.PI / 2, 2.1, 2, { step: 0.6, skip: 0.08 });
  bagWallSeg(rng.fork(0x22), bagLight, bagDark, bagWear, tarpParts, tireParts, mx - 0.2, mz + 0.55, 0.15, 2.6, 2, { step: 0.6, skip: 0.06 });

  const crateBits = new Bits();
  crateBits.add(box(0.8, 0.4, 0.5, M.wood), 1.2, 0.22, 0.75, 0, 0.25, 0);
  crateBits.add(box(0.82, 0.06, 0.52, M.woodDark), 1.2, 0.45, 0.75, -0.9, 0.25, 0); // 掀开的盖
  crateBits.add(box(0.62, 0.3, 0.42, M.armorDark), 1.55, 0.17, -0.45, 0, -0.4, 0); // 弹链箱混放
  crateBits.flush(g, 'mortar-crates');

  const roundT: InstanceTransform[] = [];
  const standing: Array<[number, number, number]> = [[-1.3, 0.35, 0.9], [-1.05, 0.32, 1.2], [-1.6, 0.34, 0.5]];
  for (const [rx, ry, rz] of standing) {
    roundT.push({ position: new THREE.Vector3(rx, ry, rz), rotation: new THREE.Euler(rng.gauss(0.15, 0.05), rng.range(0, 3), rng.gauss(0, 0.12)) });
  }
  for (let i = 0; i < 8; i += 1) {
    roundT.push({
      position: new THREE.Vector3(1.2 + rng.gauss(0, 0.08), 0.42, 0.75 + ((i % 4) - 1.5) * 0.11 + Math.floor(i / 4) * 0.12),
      rotation: new THREE.Euler(0, 0.25, Math.PI / 2),
    });
  }
  const roundBody = mergeAll([
    (() => {
      const b = new THREE.CylinderGeometry(0.052, 0.055, 0.4, 8);
      return b;
    })(),
    (() => {
      const n = new THREE.ConeGeometry(0.05, 0.16, 8);
      n.translate(0, 0.27, 0);
      return n;
    })(),
    (() => {
      const f = new THREE.CylinderGeometry(0.062, 0.062, 0.06, 8);
      f.translate(0, -0.22, 0);
      return f;
    })(),
  ]);
  const rounds = instanced(roundBody, M.armorDark, roundT);
  rounds.name = 'mortar-rounds';
  g.add(rounds);
  // 铜弹头点缀：给两枚立着的加一圈铜色弹带
  const bandT: InstanceTransform[] = standing.map(([rx, ry, rz]) => ({
    position: new THREE.Vector3(rx, ry + 0.06, rz),
    rotation: new THREE.Euler(rng.gauss(0.15, 0.05), 0, rng.gauss(0, 0.12)),
  }));
  g.add(instanced(new THREE.CylinderGeometry(0.058, 0.058, 0.06, 8), M.brass, bandT));

  // 射界前的脚印与拖痕（炮位 → 弹药堆，世界坐标直接挂在 root）
  footprints(root, rng, [
    [mx - 0.4, mz + 1.6], [mx + 0.2, mz + 1.0], [mx + 0.9, mz + 0.9], [mx + 1.4, mz + 1.2],
  ], 0.5, 'mortar-steps');
}

/* ============================== 车辙与脚印（轻微隆起的几何条） ============================== */

const RUT_GEO = new THREE.BoxGeometry(0.16, 0.035, 0.68);
const PRINT_GEO = new THREE.BoxGeometry(0.11, 0.03, 0.26);

function rutPath(parent: THREE.Object3D, rng: Rng, pts: Array<[number, number]>, halfGauge: number, name: string): void {
  const ruts = new Parts();
  for (const side of [-1, 1] as const) {
    for (let i = 0; i < pts.length - 1; i += 1) {
      const [ax, az] = pts[i] as [number, number];
      const [bx, bz] = pts[i + 1] as [number, number];
      const dx = bx - ax;
      const dz = bz - az;
      const len = Math.hypot(dx, dz);
      const yaw = Math.atan2(dx, dz);
      const nx = -Math.cos(yaw) * side * halfGauge; // 垂直于行进方向的横向偏移
      const nz = Math.sin(yaw) * side * halfGauge;
      const steps = Math.max(2, Math.round(len / 0.62));
      for (let s = 0; s < steps; s += 1) {
        const t = (s + 0.5) / steps;
        const px = ax + dx * t + nx + rng.gauss(0, 0.03);
        const pz = az + dz * t + nz + rng.gauss(0, 0.03);
        if (px > -13.4 && px < 13.4) continue; // 绝不进车道缺口
        const gy = groundYAt(px, pz);
        ruts.add(RUT_GEO, px, gy + 0.012, pz, rng.gauss(0, 0.02), yaw, rng.gauss(0, 0.03), 1, 1, rng.range(0.85, 1.1));
      }
    }
  }
  commit(ruts, M.mud, parent, name);
}

function footprints(parent: THREE.Object3D, rng: Rng, pts: Array<[number, number]>, stride: number, name: string): void {
  const transforms: InstanceTransform[] = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const [ax, az] = pts[i] as [number, number];
    const [bx, bz] = pts[i + 1] as [number, number];
    const len = Math.hypot(bx - ax, bz - az);
    const yaw = Math.atan2(bx - ax, bz - az);
    const n = Math.max(2, Math.round(len / stride));
    for (let s = 0; s < n; s += 1) {
      const t = (s + 0.5) / n;
      const side = s % 2 === 0 ? 1 : -1;
      const px = ax + (bx - ax) * t + Math.cos(yaw) * side * 0.11 + rng.gauss(0, 0.05);
      const pz = az + (bz - az) * t - Math.sin(yaw) * side * 0.11 + rng.gauss(0, 0.05);
      const gy = groundYAt(px, pz);
      transforms.push({
        position: new THREE.Vector3(px, gy + 0.012, pz),
        rotation: new THREE.Euler(rng.gauss(0, 0.05), yaw + side * rng.gauss(0, 0.1), rng.gauss(0, 0.05)),
        scale: new THREE.Vector3(rng.range(0.85, 1.1), 1, rng.range(0.8, 1.05)),
      });
    }
  }
  if (transforms.length === 0) return;
  const inst = instanced(PRINT_GEO, M.mud, transforms);
  inst.name = name;
  parent.add(inst);
}

/* ============================== 弹药箱散落与警示牌 ============================== */

function buildAmmoCaches(root: THREE.Group, rng: Rng): void {
  const olive = new Parts();
  const wood = new Parts();
  const steel = new Parts();
  const links: InstanceTransform[] = [];

  const caches: Array<{ x: number; z: number; yaw: number; kind: 'mg' | 'mortar' | 'open'; fallen?: boolean }> = [
    { x: -20.5, z: 118.3, yaw: 0.6, kind: 'mg' },
    { x: -21.6, z: 118.9, yaw: -0.2, kind: 'mg', fallen: true },
    { x: 20.8, z: 118.2, yaw: 1.1, kind: 'mortar' },
    { x: 21.6, z: 118.8, yaw: 0.4, kind: 'open' },
    { x: -45.8, z: 117.2, yaw: -0.7, kind: 'mortar' },
    { x: -43.2, z: 117.8, yaw: 0.2, kind: 'mg' },
    { x: 40.5, z: 118.4, yaw: 1.4, kind: 'mortar', fallen: true },
    { x: -55.5, z: 118.6, yaw: 0.3, kind: 'open' },
    { x: 52.2, z: 118.2, yaw: -1.2, kind: 'mg' },
  ];

  for (const c of caches) {
    if (!ok(c.x, c.z, 1.2, 1.0)) continue;
    const gy = groundYAt(c.x, c.z);
    const q = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(c.fallen ? 1.35 : rng.gauss(0, 0.05), c.yaw, c.fallen ? rng.gauss(0, 0.3) : rng.gauss(0, 0.06)),
    );
    if (c.kind === 'mortar') {
      wood.addQ(new THREE.BoxGeometry(0.92, 0.44, 0.52), new THREE.Vector3(c.x, gy + (c.fallen ? 0.25 : 0.24), c.z), q);
      steel.addQ(new THREE.BoxGeometry(0.94, 0.05, 0.54), new THREE.Vector3(c.x, gy + (c.fallen ? 0.48 : 0.47), c.z), q);
      // 漆色识别带
      olive.addQ(new THREE.BoxGeometry(0.06, 0.3, 0.55), new THREE.Vector3(c.x, gy + (c.fallen ? 0.25 : 0.24), c.z).add(new THREE.Vector3(0.24, 0, 0).applyQuaternion(q)), q);
    } else {
      olive.addQ(new THREE.BoxGeometry(0.64, 0.3, 0.44), new THREE.Vector3(c.x, gy + (c.fallen ? 0.18 : 0.17), c.z), q);
      steel.addQ(new THREE.BoxGeometry(0.1, 0.06, 0.5), new THREE.Vector3(c.x, gy + (c.fallen ? 0.32 : 0.32), c.z), q); // 提手
      steel.addQ(new THREE.BoxGeometry(0.66, 0.05, 0.46), new THREE.Vector3(c.x, gy + (c.fallen ? 0.3 : 0.33), c.z).add(new THREE.Vector3(0, 0.0, 0).applyQuaternion(q)), q); // 盖缝
      if (c.kind === 'open' && !c.fallen) {
        const lidQ = q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(X_AXIS, -1.8));
        wood.addQ(new THREE.BoxGeometry(0.66, 0.05, 0.46), new THREE.Vector3(c.x, gy + 0.5, c.z - 0.2), lidQ);
        // 泼出来的弹链：一串小节沿地面前进方向
        for (let i = 0; i < 14; i += 1) {
          const a = c.yaw + rng.gauss(0, 0.3);
          links.push({
            position: new THREE.Vector3(c.x + Math.sin(a) * (0.35 + i * 0.1) + rng.gauss(0, 0.06), gy + 0.045, c.z + Math.cos(a) * (0.35 + i * 0.1) + rng.gauss(0, 0.06)),
            rotation: new THREE.Euler(rng.gauss(0, 0.1), a + rng.gauss(0, 0.3), rng.gauss(0, 0.1)),
          });
        }
      }
    }
  }

  commit(olive, M.armorDark, root, 'ammo-boxes-olive');
  commit(wood, M.wood, root, 'ammo-crates-wood');
  commit(steel, M.steelDark, root, 'ammo-hardware');
  if (links.length > 0) {
    const linkGeo = mergeAll([
      new THREE.BoxGeometry(0.055, 0.035, 0.12),
      (() => {
        const r = new THREE.CylinderGeometry(0.02, 0.02, 0.05, 6);
        r.rotateX(Math.PI / 2);
        r.translate(0, 0.01, 0.05);
        return r;
      })(),
    ]);
    const inst = instanced(linkGeo, M.brass, links);
    inst.name = 'ammo-belt';
    root.add(inst);
  }
}

function buildSigns(root: THREE.Group, rng: Rng): void {
  // 检查牌：立在西侧折返沙袋墙头上，面朝北（出城司机先看到）
  const stopSign = warningPlate(rng, 1.15, 0.7, { text: 'СТІЙ! ПЕРЕВІРКА', sub: 'ВИХІД З МІСТА', post: [[-0.42, -0.55], [0.42, -0.55]] });
  stopSign.position.set(-15.6, groundYAt(-15.6, 118.2) + 0.62, 118.2);
  stopSign.rotation.set(0, Math.PI, 0.05);
  if (ok(-15.6, 118.2, 1.6, 0.8)) root.add(stopSign);

  // 雷区警示牌：立在豁口旁的桩上，锈斜
  const mineSign = warningPlate(rng, 0.9, 0.72, { text: 'УВАГА! МІНИ', sub: 'НЕ ВХОДИТИ', danger: true });
  mineSign.position.set(-46.8, groundYAt(-46.8, 123.0) + 0.7, 123.0);
  mineSign.rotation.set(0.05, 0.25, -0.1);
  if (ok(-46.8, 123.0, 1.4, 0.8)) root.add(mineSign);

  // 半埋在泥里的小告示：只剩半截桩，板面歪斜贴地
  const buried = warningPlate(rng, 0.62, 0.46, { text: 'ПРОХІД ЗАБОРОНЕНО', post: [[0, -0.18]] });
  buried.position.set(50.8, groundYAt(50.8, 122.6) + 0.16, 122.6);
  buried.rotation.set(0.9, 2.4, 0.42);
  if (ok(50.8, 122.6, 1.2, 1.0)) root.add(buried);

  // 岗亭残墙上的小牌（贴北墙外侧右段）
  const boothSign = warningPlate(rng, 0.75, 0.5, { text: 'КАРАНТИН', sub: 'САПЕРИ 3-Й Р-Н', post: [] });
  boothSign.position.set(18.42, groundYAt(18.42, 115.16) + 1.5, 115.16);
  boothSign.rotation.set(0.06, -0.12 + Math.PI, -0.08);
  root.add(boothSign);
  bulletHoles(boothSign, rng, [{ p: [0.2, 0.1, 0.05], n: [0, 0, 1] }]);
}

/* ============================== 入口 ============================== */

export function buildOutpost(ctx: BuildContext): THREE.Group {
  const rng = ctx.rng.fork(0x0f73a1);
  const root = group('outpost');

  /* ——— 沙袋墙（防线主段，横切出城方向，止于车道缺口退线之外） ——— */
  const bagLight = new Parts();
  const bagDark = new Parts();
  const bagWear = new Parts();
  const tarpParts = new Parts();
  const tireParts = new Parts();

  // 西翼：主段 + 朝街口折返的"钳口"，篝火前留出豁口
  bagWallSeg(rng.fork(0x11), bagLight, bagDark, bagWear, tarpParts, tireParts, -26.8, 119.7, 0.02, 23, 3, { tarp: 0.85, heavySkew: true });
  bagWallSeg(rng.fork(0x12), bagLight, bagDark, bagWear, tarpParts, tireParts, -14.9, 118.5, Math.PI / 2, 2.6, 3, {});
  bagWallSeg(rng.fork(0x13), bagLight, bagDark, bagWear, tarpParts, tireParts, -50.5, 119.85, -0.01, 5, 2, { skip: 0.12, tarp: 0.5 });
  // 东翼：主段 + 折返钳口 + 岗亭前短段
  bagWallSeg(rng.fork(0x14), bagLight, bagDark, bagWear, tarpParts, tireParts, 26.8, 119.8, -0.02, 23, 3, { tarp: 0.8, heavySkew: true });
  bagWallSeg(rng.fork(0x15), bagLight, bagDark, bagWear, tarpParts, tireParts, 14.9, 118.5, Math.PI / 2, 2.6, 3, {});
  bagWallSeg(rng.fork(0x16), bagLight, bagDark, bagWear, tarpParts, tireParts, 44.5, 120.1, 0.03, 6, 2, { skip: 0.1, tarp: 0.6 });

  // 钳口内侧的残破沙袋台阶（车过检查时的落脚处，全部在退线之外）
  bagWallSeg(rng.fork(0x17), bagLight, bagDark, bagWear, tarpParts, tireParts, -18.2, 118.3, 0.5, 2.2, 1, {});

  /* ——— 拒马与铁丝网 ——— */
  buildHedgehogs(root, rng.fork(0x21));
  const rags: RagSpec[] = [];
  const wireKit: WireKit = { wood: new Parts(), steel: new Parts(), strands: new Parts(), tie: new Parts(), coils: new Parts(), knots: [] };
  // 西翼：主线在 -44/-51.5 之间留断档（成卷线圈未展开 + 雷区牌），-57.5/-62.5 之间让出 BTR 车头
  wireRun(wireKit, rng.fork(0x31), -15.2, -44, 123.0, { rags });
  wireRun(wireKit, rng.fork(0x32), -51.5, -57.5, 123.0, { rags });
  wireRun(wireKit, rng.fork(0x325), -62.5, -84, 123.0, { rags });
  // 东翼：剪开的豁口在 +30.5；+45.5..+60 之间被 3 号车位的前出部分穿过，网绕着车停
  wireRun(wireKit, rng.fork(0x33), 15.2, 45.5, 123.15, { cutAt: 30.5, rags });
  wireRun(wireKit, rng.fork(0x34), 50, 54.6, 122.85, { rags });
  wireRun(wireKit, rng.fork(0x345), 60.2, 84, 122.8, { rags });
  wireCoil(wireKit, rng.fork(0x35), -49.5, 123.2);
  wireCoil(wireKit, rng.fork(0x36), 49, 123.1);
  commit(wireKit.wood, M.wood, root, 'wire-posts-wood');
  commit(wireKit.steel, M.steelDark, root, 'wire-posts-steel');
  commit(wireKit.strands, M.wire, root, 'wire-strands');
  commit(wireKit.coils, M.wire, root, 'wire-coils');
  commit(wireKit.tie, M.mud, root, 'wire-mound');
  if (wireKit.knots.length > 0) {
    const barbs = instanced(barbKnotGeo(), M.wire, wireKit.knots);
    barbs.name = 'wire-barbs';
    root.add(barbs);
  }

  /* ——— 探照灯塔（核心动效：缓慢不同步扫动） ——— */
  const beamTex = beamLengthTexture();
  const spotTex = spotTexture();
  const towers: TowerAnim[] = [];
  for (const spec of HOTSPOTS.searchlights) {
    const { root: tower, anim } = buildSearchlight(rng.fork(spec.x * 131 + spec.z), spec, beamTex, spotTex);
    root.add(tower);
    if (anim) towers.push(anim);
  }
  ctx.ticker.add((t) => {
    for (const a of towers) {
      // 周期 26s / 34s：两座不同步的往复扫视
      const w = (t * Math.PI * 2) / a.period + a.phase;
      a.head.rotation.y = a.facing + Math.sin(w) * a.amp;
      a.pitch.rotation.x = a.basePitch + Math.sin(w * 0.5 + 1.3) * 0.05;
      const f = 0.9 + 0.06 * Math.sin(t * 6.1 + a.phase * 2) + 0.04 * Math.sin(t * 13.7 + a.phase);
      a.beamMat.opacity = 0.15 * f;
      a.coreMat.opacity = 0.2 * f;
      a.spotMat.opacity = 0.34 * f;
    }
  });

  /* ——— 停放的 BTR-80 ×3 ——— */
  // 车长 7.8m：朝南停的两辆按旋转后的包围盒钳制 z，车头绝不越进南门干道人行道（z≥124.5）
  const parks = HOTSPOTS.armoredParked.map((p) => {
    const hz = 3.9 * Math.abs(Math.cos(p.rotY)) + 1.5 * Math.abs(Math.sin(p.rotY));
    return { x: p.x, z: Math.min(p.z, 124.4 - hz), rotY: p.rotY };
  });
  const lampSpillTex = spillTexture();
  parks.forEach((p, i) => {
    root.add(
      buildBTR(rng.fork(0x41 + i), {
        x: p.x,
        z: p.z,
        rotY: p.rotY,
        seed: 0x41 + i * 7,
        openHatch: i === 0,
        plank: i === 1,
        tarpRoll: i === 2,
        mudHeavy: i === 1 || i === 2,
        holes: i === 2 ? 3 : i === 1 ? 1 : 0,
      }),
    );
    // 遮光罩前灯在湿地面上的短促反光（停驶状态：很弱）
    const fx0 = p.x + Math.sin(p.rotY) * 2.4;
    const fz0 = p.z + Math.cos(p.rotY) * 2.4;
    const mat = new THREE.MeshBasicMaterial({
      map: lampSpillTex,
      color: 0xffdfae,
      transparent: true,
      opacity: 0.1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: true,
    });
    const plane = mesh(new THREE.PlaneGeometry(2.3, 6.2), mat);
    plane.rotation.x = -Math.PI / 2;
    plane.rotation.z = p.rotY + Math.PI;
    plane.position.set(fx0, 0.13, fz0);
    plane.renderOrder = 5;
    root.add(plane);
  });

  /* ——— 岗亭 / 篝火 / 迫击炮 / 弹药 / 标识 ——— */
  const sheets: LooseSheet[] = [];
  buildGuardBooth(root, rng.fork(0x51), sheets);
  const fireAnim: FireAnim = {
    flames: [],
    flameMats: [],
    coreMat: null as unknown as THREE.MeshBasicMaterial,
    ember: null,
    light: null,
    lightBase: 5.2,
    spills: [],
  };
  buildCampfire(root, ctx, rng.fork(0x61), fireAnim);
  buildMortar(root, rng.fork(0x71), bagLight, bagDark, bagWear, tarpParts, tireParts);
  buildAmmoCaches(root, rng.fork(0x81));
  buildSigns(root, rng.fork(0x91));

  // 防线与炮位的沙袋共用同一批 Parts（迫击炮围袋在最后加入，故统一在此合批）
  commit(bagLight, M.bag, root, 'outpost-bags');
  commit(bagDark, M.bagDark, root, 'outpost-bags-dark');
  commit(bagWear, M.bagWear, root, 'outpost-bag-wear');
  commit(tarpParts, M.tarp, root, 'outpost-tarps');
  commit(tireParts, M.tire, root, 'outpost-tarp-tires');

  /* ——— 湿泥车辙与脚印 ——— */
  const trackRng = rng.fork(0xa1);
  rutPath(root, trackRng, [[-15.6, 115.4], [-30, 115.0], [-45, 115.9], [-50.5, 116.4]], 0.92, 'ruts-west');
  rutPath(root, trackRng, [[-56.5, 117.4], [-60, 119.0], [-60.6, 120.2]], 0.92, 'ruts-west2');
  rutPath(root, trackRng, [[15.8, 115.0], [30, 115.7], [44, 116.6], [52, 119.1]], 0.92, 'ruts-east');
  footprints(root, trackRng, [[16.4, 117.8], [17.2, 116.6], [17.5, 115.4], [18.6, 114.9]], 0.56, 'prints-booth');
  footprints(root, trackRng, [[-40.8, 119.2], [-41.6, 117.9], [-41.2, 116.6], [-40.2, 115.8]], 0.56, 'prints-fire');
  footprints(root, trackRng, [[-15.4, 119.6], [-16.2, 118.6], [-17.4, 118.2], [-18.4, 118.5]], 0.56, 'prints-jaw');
  root.add(decal(-19.6, 116.6, 1.6, M.dirtDecal, trackRng, 0.6, 0.008));
  root.add(decal(49.5, 117.2, 1.4, M.dirtDecal, trackRng, 0.65, 0.008));

  /* ——— 动效：篝火/余烬明灭（第 2 组） ——— */
  const flick = (t: number): number => {
    const stepped = hashNoise(Math.floor(t * 13) + 7.7) * 2 - 1;
    return stepped * 0.5 + Math.sin(t * 8.7) * 0.3 + Math.sin(t * 16.3 + 1.1) * 0.2;
  };
  const emScratchColor = new THREE.Color(PALETTE.ember);
  ctx.ticker.add((t) => {
    const f = Math.max(-1, Math.min(1, flick(t)));
    if (fireAnim.light) fireAnim.light.intensity = fireAnim.lightBase + f * 2.2;
    for (let i = 0; i < fireAnim.flameMats.length; i += 1) {
      const mat = fireAnim.flameMats[i] as THREE.MeshBasicMaterial;
      mat.opacity = (i === 0 ? 0.8 : 0.62) + f * (i === 0 ? 0.16 : 0.22);
    }
    fireAnim.coreMat.opacity = 0.8 + Math.max(0, -f) * 0.18;
    for (let i = 0; i < fireAnim.flames.length; i += 1) {
      const fl = fireAnim.flames[i] as { obj: THREE.Object3D; base: number; phase: number };
      const k = 1 + f * 0.14 + Math.sin(t * 5.9 + fl.phase) * 0.06;
      fl.obj.scale.set(k * (0.94 + 0.06 * Math.sin(t * 3.1 + fl.phase)), 1 + f * 0.2, 1);
      fl.obj.rotation.z = Math.sin(t * 2.7 + fl.phase) * 0.07;
    }
    if (fireAnim.ember) {
      const em = fireAnim.ember;
      for (let i = 0; i < em.phases.length; i += 1) {
        const pulse = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * (0.7 + i * 0.23) + (em.phases[i] as number)));
        const snap = hashNoise(Math.floor(t * 5) + i * 13.7) > 0.9 ? 0.35 : 1;
        emScratchColor.setRGB(1 * pulse * snap, 0.34 * pulse * snap, 0.13 * pulse * snap);
        em.inst.setColorAt(i, emScratchColor);
      }
      if (em.inst.instanceColor) em.inst.instanceColor.needsUpdate = true;
    }
    for (let i = 0; i < fireAnim.spills.length; i += 1) {
      const mat = fireAnim.spills[i] as THREE.MeshBasicMaterial;
      mat.opacity = (i === 0 ? 0.4 : 0.3) * (0.8 + 0.2 * f);
    }
  });

  /* ——— 动效：碎布飘动 + 铁皮被风掀动（第 3、4 组） ——— */
  const ragGeo = chippedSlab(0.26, 0.4, 0.01, rng.fork(0xb1), 0.55);
  ragGeo.translate(0, -0.16, 0); // 上缘为挂载点
  const ragSets: Array<{ inst: THREE.InstancedMesh; specs: RagSpec[] }> = [];
  for (const mat of [M.ragRed, M.ragGrey] as const) {
    const specs = rags.filter((r) => r.mat === mat);
    if (specs.length === 0) continue;
    const inst = instanced(ragGeo, mat, specs.map((s) => ({ position: s.pos, rotation: new THREE.Euler(-0.15, s.yaw, 0) })));
    inst.name = `wire-rags-${mat === M.ragRed ? 'red' : 'grey'}`;
    root.add(inst);
    ragSets.push({ inst, specs });
  }
  const rq = new THREE.Quaternion();
  const re = new THREE.Euler();
  const rm = new THREE.Matrix4();
  const rs = new THREE.Vector3();
  ctx.ticker.add((t) => {
    for (const set of ragSets) {
      for (let i = 0; i < set.specs.length; i += 1) {
        const s = set.specs[i] as RagSpec;
        const gust = Math.max(0, Math.sin(t * 0.33 + s.phase) * Math.sin(t * 0.19 + s.phase * 1.4) - 0.25);
        re.set(
          -0.12 + Math.sin(t * 2.1 + s.phase) * 0.28 + gust * 0.95,
          s.yaw + Math.sin(t * 1.3 + s.phase) * 0.2,
          Math.sin(t * 3.3 + s.phase * 2) * 0.12,
        );
        rq.setFromEuler(re);
        rs.set(1, 1 + gust * 0.22, 1);
        rm.compose(s.pos, rq, rs);
        set.inst.setMatrixAt(i, rm);
      }
      set.inst.instanceMatrix.needsUpdate = true;
    }
    for (const sh of sheets) {
      // 阵风掀动：平时贴着墙抖，阵风掀起再拍回
      const gust = Math.max(0, Math.sin(t * 0.29 + sh.phase) * Math.sin(t * 0.17 + 1.4) - 0.3);
      const snap = gust > 0.1 ? Math.abs(Math.sin(t * 9.2 + sh.phase)) * 0.12 : 0;
      sh.pivot.rotation.x = sh.baseRx - gust * 0.85 - snap + Math.sin(t * 4.7 + sh.phase) * 0.012;
    }
  });

  /* ——— 本区在阴影相机之外：主体一律不投影，接影保留 ——— */
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = false;
      const mat = m.material as THREE.Material | THREE.Material[];
      const transparent = Array.isArray(mat) ? mat.some((x) => x.transparent) : mat.transparent;
      if (transparent) m.receiveShadow = false;
    }
  });

  return root;
}




