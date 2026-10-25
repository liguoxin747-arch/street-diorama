import * as THREE from 'three';
import type { BuildContext } from '../core/context';
import type { Rng } from '../core/rng';
import type { InstanceTransform } from '../core/geo';
import {
  at,
  box,
  capsule,
  cyl,
  cylinderBetween,
  group,
  instanced,
  jitter,
  mergeMeshes,
  mesh,
  roundedRectShape,
  sphere,
  torus,
} from '../core/geo';
import { PALETTE } from '../core/palette';
import { basicMaterial, glowMaterial, toonMaterial, withOutline } from '../core/materials';
import {
  armorBlockGeometry,
  helmetGeometry,
  rifleGeometry,
  trackPadGeometry,
  tyreGeometry,
  vestGeometry,
} from '../core/detail';
import { HOTSPOTS } from './layout';

/**
 * 军用载具模块：
 *  - BMPT 火力支援车（休整中，3 名乘员在车旁休息）
 *  - 被击毁的 T-72（炮塔掀偏、履带断裂、车体烧黑 + 破口透出余烬）
 *  - 烧毁的民用轿车（烧空车厢 + 塌陷车顶）
 *
 * 坐标：本文件所有模型局部 +Z 为车头方向，y=0 为履带/轮胎触地面，
 * 摆放时整体抬到 GROUND_Y，保证"坐"在路面上。
 */

const GROUND_Y = 0.08;

/* ============================== 共享材质 ============================== */

const armorMat = toonMaterial(PALETTE.armor, { steps: 3, emissive: 0x0e1210 });
const armorLightMat = toonMaterial(PALETTE.oliveLight, { steps: 3, emissive: 0x0d110c });
const armorDarkMat = toonMaterial(PALETTE.oliveDark, { steps: 3, emissive: 0x0b0e0a });
/** 侧裙 / 挡泥板那一圈：压得比车体暗，远看车体像浮在一条暗带上，体积感更强 */
const skirtMat = toonMaterial(0x333a2c, { steps: 2, emissive: 0x080a07 });
/** 湿冷高光边：雨后积水在装甲棱线上的反光，远看就是一条浅色轮廓线 */
/** 湿冷高光边：雨后积水在装甲棱线上的反光。用"略亮的军绿"而不是浅蓝，避免像白胶带 */
const rimMat = toonMaterial(0x6f7a63, { steps: 2, emissive: 0x0e110c });
const trackMat = toonMaterial(PALETTE.trackMetal, { steps: 2 });
const rubberMat = toonMaterial(PALETTE.tire, { steps: 2 });
const gunMetalMat = toonMaterial(0x3b3f45, { steps: 2 });
/** 烧过 / 氧化过的炮钢：比车体亮，夜里才看得出"炮管还在" */
const gunBurntMat = toonMaterial(0x6b6259, { steps: 2, emissive: 0x1c1712 });
const rustMat = toonMaterial(PALETTE.rust, { steps: 2, emissive: 0x140a05 });
const rustDarkMat = toonMaterial(PALETTE.rustDark, { steps: 2 });
const burntMat = toonMaterial(PALETTE.burntVehicle, { steps: 2, emissive: 0x0d0a08 });
const burntLightMat = toonMaterial(0x665749, { steps: 2, emissive: 0x201811 });
const sootMat = toonMaterial(PALETTE.burnt, { steps: 2 });
const drumMat = toonMaterial(0x4a4438, { steps: 2 });

/** 雨湿装甲：Phong 高光让雨夜的车体有一道反光，和哑光 toon 面片拉开层次 */
const wetArmorMat = new THREE.MeshPhongMaterial({
  color: PALETTE.armor,
  specular: 0xa9c0d0,
  shininess: 54,
  emissive: 0x0c100e,
});
const wetBurntMat = new THREE.MeshPhongMaterial({
  color: 0x655748,
  specular: 0x8a929a,
  shininess: 34,
  emissive: 0x241b16,
});

// 人物
const skinMat = toonMaterial(PALETTE.skin, { steps: 2 });
const vestMat = toonMaterial(0x3c443a, { steps: 2 });
const pantsMat = toonMaterial(0x454b40, { steps: 2 });
const bootsMat = toonMaterial(0x2b2926, { steps: 2 });
const helmetMat = toonMaterial(0x4a5240, { steps: 3 });
const coatGreyMat = toonMaterial(PALETTE.coatGrey, { steps: 3 });
const coatBrownMat = toonMaterial(PALETTE.coatBrown, { steps: 3 });
const coatOliveMat = toonMaterial(PALETTE.coatOlive, { steps: 3 });
const strapMat = toonMaterial(0x2a2c28, { steps: 2 });

const dirtDecalMat = basicMaterial(0x191712, { opacity: 0.42, transparent: true, fog: true });
const scorchDecalMat = basicMaterial(0x07090b, { opacity: 0.66, transparent: true, fog: true });

/* ============================== 通用工具 ============================== */

/** 侧面轮廓挤出：profile 是 (z, y) 折线，沿 X 挤出 width —— 车体/炮塔一次成型 */
function extrudeSide(
  profile: ReadonlyArray<readonly [number, number]>,
  width: number,
  material: THREE.Material,
  bevel = 0.03,
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
  geom.rotateY(-Math.PI / 2); // 剖面 x(前后) -> z，挤出方向 -> x
  geom.translate(width / 2 - bevel, 0, 0);
  return mesh(geom, material);
}

/** 履带环：圆角矩形挖空后挤出，从侧面能看到负重轮 */
function trackBand(length: number, height: number, width: number, band: number, material: THREE.Material): THREE.Mesh {
  const r = Math.min(height * 0.45, length * 0.3);
  const outer = roundedRectShape(length, height, r);
  const hole = roundedRectShape(length - band * 2, height - band * 2, Math.max(0.02, r - band));
  outer.holes.push(hole);
  const geom = new THREE.ExtrudeGeometry(outer, { depth: width, bevelEnabled: false, curveSegments: 4 });
  geom.rotateY(-Math.PI / 2);
  geom.translate(width / 2, 0, 0);
  return mesh(geom, material);
}

/** 攒一批小件，最后按材质合并成一个 mesh（压 draw call） */
function pushBit(list: THREE.Mesh[], m: THREE.Mesh, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void {
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  list.push(m);
}

/**
 * 分节履带：沿履带外缘铺一节一节的履带板（左右两侧一起 instanced，只占 1 个 draw call）。
 * 履带环是圆角矩形：上下两条直线段 + 前后两个半圆。
 * 位置/朝向按切线方向算，所以每一节都"咬合"在履带路径上，从侧面看是一节一节。
 */
function buildTrackLinks(
  length: number,
  height: number,
  _width: number,
  centerX: number,
  material: THREE.Material,
  rng: Rng,
  opts: { pitch?: number; skip?: (z: number, y: number) => boolean } = {},
): THREE.InstancedMesh {
  const r = Math.min(height * 0.45, length * 0.3);
  const straight = Math.max(0.3, length - 2 * r);
  const pitch = opts.pitch ?? 0.36;
  const transforms: InstanceTransform[] = [];
  const pushLink = (z: number, y: number, rx: number): void => {
    if (opts.skip && opts.skip(z, y)) return;
    for (const side of [-1, 1]) {
      transforms.push({
        position: new THREE.Vector3(side * centerX, y, z),
        rotation: new THREE.Euler(rx + rng.gauss(0, 0.004), rng.gauss(0, 0.004), rng.gauss(0, 0.003)),
        scale: new THREE.Vector3(1, 1, 1),
      });
    }
  };

  // 上下直线段（下沿接地、上沿在履带顶）
  const nStraight = Math.max(3, Math.round(straight / pitch));
  for (let i = 0; i < nStraight; i += 1) {
    const z = -straight / 2 + ((i + 0.5) * straight) / nStraight;
    pushLink(z, 0.045, 0); // 下沿：齿朝下
    pushLink(z, height - 0.045, Math.PI); // 上沿：翻过来
  }
  // 前后半圆段
  const nArc = Math.max(3, Math.round((Math.PI * r) / pitch));
  for (let i = 0; i < nArc; i += 1) {
    const th = ((i + 0.5) / nArc) * Math.PI; // 0=下  π=上
    for (const end of [1, -1] as const) {
      const cz = (end * straight) / 2;
      const z = cz + end * Math.sin(th) * r;
      const y = height / 2 - Math.cos(th) * (height / 2 - 0.045);
      // 切线朝向：+z 端 α = -θ，-z 端 α = π + θ
      const rx = end > 0 ? -th : Math.PI + th;
      pushLink(z, y, rx);
    }
  }
  const inst = instanced(trackPadGeometry(), material, transforms);
  inst.name = 'track-links';
  inst.castShadow = false;
  return inst;
}

/** 按材质分桶攒小件：同材质合并成一个 mesh，材质不同的不会被"染成一个颜色" */
class BitBucket {
  private readonly buckets = new Map<THREE.Material, THREE.Mesh[]>();

  add(m: THREE.Mesh, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void {
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    this.put(m);
  }

  /** 已经摆好位置（position/quaternion）的网格，不动它的变换直接收进来 */
  addAsIs(m: THREE.Mesh): void {
    this.put(m);
  }

  private put(m: THREE.Mesh): void {
    const mat = m.material as THREE.Material;
    const list = this.buckets.get(mat);
    if (list) list.push(m);
    else this.buckets.set(mat, [m]);
  }

  flush(parent: THREE.Object3D, prefix: string, outlineThickness = 0): void {
    let i = 0;
    for (const [mat, list] of this.buckets) {
      const merged = mergeMeshes(list, mat);
      if (!merged) continue;
      merged.name = `${prefix}-${i}`;
      if (outlineThickness > 0) withOutline(merged, outlineThickness);
      parent.add(merged);
      i += 1;
    }
    this.buckets.clear();
  }
}

function flushBits(list: THREE.Mesh[], material: THREE.Material, parent: THREE.Object3D, name: string, outlineThickness = 0): void {
  if (list.length === 0) return;
  const merged = mergeMeshes(list, material);
  if (!merged) return;
  merged.name = name;
  if (outlineThickness > 0) withOutline(merged, outlineThickness);
  parent.add(merged);
}

/** 地面污渍/焦痕：贴地的抖动圆片（抖动只作用在平面内，保证不穿地） */
function decal(
  x: number,
  z: number,
  radius: number,
  material: THREE.Material,
  rng: Rng,
  squash = 1,
): THREE.Mesh {
  const geom = jitter(new THREE.CircleGeometry(radius, 12), radius * 0.18, rng);
  const pos = geom.getAttribute('position');
  if (pos) {
    // CircleGeometry 的法线方向是局部 z，抖动会把顶点推出地面：这里压平
    for (let i = 0; i < pos.count; i += 1) pos.setZ(i, 0);
    pos.needsUpdate = true;
  }
  const patch = mesh(geom, material);
  patch.rotation.x = -Math.PI / 2;
  patch.rotation.z = rng.range(0, Math.PI * 2);
  patch.scale.set(1, squash, 1);
  patch.castShadow = false;
  patch.receiveShadow = false;
  at(patch, x, 0.004, z);
  return patch;
}

/* ============================== 乘员（休息中的步兵） ============================== */

interface CrewRig {
  torso: THREE.Group;
  head: THREE.Group;
  baseTorsoY: number;
  phase: number;
  targets: number[];
  index: number;
  nextSwitch: number;
  interval: number;
}

type CrewPose = 'stand' | 'sit' | 'crouch';

/**
 * 低多边形乘员：骨盆位于局部原点，局部 +Z 为正面。
 * 只有头/躯干/腿/手臂的块面，脸部完全留白。
 * 各部件按材质合并，一个人只占 ~8 个 mesh（含描边）。
 */
function crewFigure(
  rng: Rng,
  pose: CrewPose,
  coat: THREE.Material,
): { figure: THREE.Group; rig: CrewRig } {
  const figure = group('crew-figure');

  // —— 腿（按姿态分三种折法，最后按材质合并）——
  const legBits: THREE.Mesh[] = [];
  const bootBits: THREE.Mesh[] = [];
  const leg = (side: number): void => {
    const x = side * 0.10;
    if (pose === 'stand') {
      const thigh = box(0.15, 0.44, 0.18, pantsMat);
      at(thigh, x, -0.22, 0);
      legBits.push(thigh);
      const shin = box(0.13, 0.42, 0.16, pantsMat);
      at(shin, x, -0.63, 0.01);
      legBits.push(shin);
      const boot = box(0.16, 0.10, 0.26, bootsMat);
      at(boot, x, -0.80, 0.04);
      bootBits.push(boot);
    } else if (pose === 'sit') {
      const thigh = box(0.15, 0.17, 0.46, pantsMat);
      at(thigh, x, -0.03, 0.21);
      legBits.push(thigh);
      const shin = box(0.13, 0.40, 0.16, pantsMat);
      at(shin, x, -0.21, 0.42);
      legBits.push(shin);
      const boot = box(0.16, 0.10, 0.24, bootsMat);
      at(boot, x, -0.43, 0.45);
      bootBits.push(boot);
    } else {
      const thigh = box(0.15, 0.19, 0.42, pantsMat);
      at(thigh, x, -0.09, 0.17);
      legBits.push(thigh);
      const shin = box(0.13, 0.38, 0.16, pantsMat);
      at(shin, x, -0.28, 0.29);
      legBits.push(shin);
      const boot = box(0.16, 0.10, 0.24, bootsMat);
      at(boot, x, -0.45, 0.33);
      bootBits.push(boot);
    }
  };
  leg(-1);
  leg(1);
  // 骨盆
  const pelvis = box(0.34, 0.20, 0.26, pantsMat);
  at(pelvis, 0, 0, 0);
  legBits.push(pelvis);

  const legsMesh = mergeMeshes(legBits, pantsMat);
  if (legsMesh) {
    legsMesh.name = 'crew-legs';
    withOutline(legsMesh, 0.0022);
    figure.add(legsMesh);
  }
  const bootsMesh = mergeMeshes(bootBits, bootsMat);
  if (bootsMesh) {
    bootsMesh.name = 'crew-boots';
    figure.add(bootsMesh);
  }

  // —— 躯干（呼吸动效作用在 torso 组上）——
  const torso = group('crew-torso');
  torso.position.y = 0.12;
  figure.add(torso);

  const coatBits: THREE.Mesh[] = [];
  // 躯干（有厚度：胸廓 + 肩宽 + 腰，别做成薄板）
  const chest = box(0.46, 0.46, 0.30, coat);
  at(chest, 0, 0.28, 0);
  coatBits.push(chest);
  // 肩部（略宽，撑出军装的体积）
  const shoulders = box(0.52, 0.14, 0.30, coat);
  at(shoulders, 0, 0.46, 0);
  coatBits.push(shoulders);
  // 腰（略收）
  const waist = box(0.38, 0.14, 0.26, coat);
  at(waist, 0, 0.06, 0);
  coatBits.push(waist);
  const collar = box(0.30, 0.12, 0.24, coat);
  at(collar, 0, 0.55, 0.01);
  coatBits.push(collar);

  // 手臂
  const armAngle = pose === 'sit' ? 0.62 : pose === 'crouch' ? 0.5 : 0.12;
  const handBits: THREE.Mesh[] = [];
  for (const side of [-1, 1]) {
    const arm = capsule(0.072, 0.30, coat);
    at(arm, side * 0.25, 0.30, 0.02);
    arm.rotation.set(armAngle, 0, side * 0.13);
    coatBits.push(arm);
    const hand = sphere(0.062, skinMat, 8);
    at(hand, side * 0.25, 0.09, 0.16 + armAngle * 0.16);
    handBits.push(hand);
  }
  const coatMesh = mergeMeshes(coatBits, coat);
  if (coatMesh) {
    coatMesh.name = 'crew-coat';
    withOutline(coatMesh, 0.0022);
    torso.add(coatMesh);
  }
  const handsMesh = mergeMeshes(handBits, skinMat);
  if (handsMesh) torso.add(handsMesh);

  // 战术背心（前后护板 + 侧腰 + 3 个弹匣袋，有真实厚度）
  const vestParts = vestGeometry(0.44, 0.36, 0.30);
  const vestBody = mesh(vestParts.body, vestMat);
  at(vestBody, 0, 0.30, 0.005);
  torso.add(vestBody);
  const pouchMesh = mesh(vestParts.pouches, vestMat);
  at(pouchMesh, 0, 0.30, 0.005);
  torso.add(pouchMesh);
  // 肩带
  for (const side of [-1, 1]) {
    const strap = box(0.07, 0.16, 0.03, strapMat);
    at(strap, side * 0.14, 0.45, 0.13);
    torso.add(strap);
  }
  // 腰带 + 腿挂弹匣包
  const belt = box(0.42, 0.06, 0.28, strapMat);
  at(belt, 0, 0.09, 0);
  torso.add(belt);
  const dropPouch = box(0.10, 0.16, 0.08, vestMat);
  at(dropPouch, 0.19, -0.02, 0.05);
  torso.add(dropPouch);

  // 斜挎的步枪（完整枪械结构：机匣/枪管/弹匣/枪托/瞄具/握把）
  const rifle = mesh(rifleGeometry(), gunMetalMat);
  at(rifle, 0.17, 0.24, -0.10);
  rifle.rotation.set(0.62, 0.30, 0.46);
  torso.add(rifle);
  // 枪背带
  const sling = box(0.03, 0.03, 0.5, strapMat);
  at(sling, 0.1, 0.36, 0.08);
  sling.rotation.set(0.9, 0.2, 0.5);
  torso.add(sling);

  // —— 头（转头的动效作用在 head 组上）——
  const head = group('crew-head');
  head.position.y = 0.60;
  torso.add(head);
  const skinBits: THREE.Mesh[] = [];
  const neck = cyl(0.055, 0.055, 0.10, 8, skinMat);
  at(neck, 0, 0.03, 0);
  skinBits.push(neck);
  const skull = sphere(0.112, skinMat, 10);
  at(skull, 0, 0.155, 0);
  skinBits.push(skull);
  const skinMesh = mergeMeshes(skinBits, skinMat);
  if (skinMesh) head.add(skinMesh);

  const helmetBits: THREE.Mesh[] = [];
  // 高保真头盔：半球盔体 + 帽檐 + 护耳 + 挂带
  const helmetMesh2 = mesh(helmetGeometry(0.135), helmetMat);
  at(helmetMesh2, 0, 0.16, -0.005);
  helmetBits.push(helmetMesh2);
  // 盔顶的伪装布卷（一小段，打破完美球顶）
  const rag = box(0.16, 0.05, 0.2, coat);
  at(rag, 0.02, 0.28, -0.02);
  rag.rotation.set(0.15, 0.3, 0.1);
  helmetBits.push(rag);
  const helmetMesh = mergeMeshes(helmetBits, helmetMat);
  if (helmetMesh) {
    helmetMesh.name = 'crew-helmet';
    withOutline(helmetMesh, 0.002);
    head.add(helmetMesh);
  }
  // 挂带（深色细带，绕到下巴）
  const chinStrap = box(0.02, 0.12, 0.02, strapMat);
  at(chinStrap, 0.1, 0.09, 0.02);
  chinStrap.rotation.set(0.1, 0, 0.35);
  head.add(chinStrap);
  const chinStrap2 = chinStrap.clone();
  chinStrap2.position.x = -0.1;
  chinStrap2.rotation.z = -0.35;
  head.add(chinStrap2);

  const rig: CrewRig = {
    torso,
    head,
    baseTorsoY: torso.position.y,
    phase: rng.range(0, Math.PI * 2),
    targets: [rng.range(-0.5, 0.5), rng.range(-0.7, 0.7), rng.range(-0.3, 0.3)],
    index: 0,
    nextSwitch: rng.range(8, 18),
    interval: rng.range(10, 20),
  };
  return { figure, rig };
}

/* ============================== A. BMPT ============================== */

/** T-72/T-90 底盘侧轮廓：首上倾角、车底、尾板一次成型 */
const HULL_PROFILE: ReadonlyArray<readonly [number, number]> = [
  [-3.05, 0.52],
  [3.02, 0.52],
  [3.22, 0.86],
  [1.78, 1.32],
  [1.08, 1.48],
  [-2.28, 1.48],
  [-3.10, 1.16],
  [-3.16, 0.68],
];

const TRACK_CENTER_X = 1.40;
const TRACK_WIDTH = 0.48;
const TRACK_LENGTH = 6.5;
const TRACK_HEIGHT = 1.05;
const TRACK_BAND = 0.16;
const WHEEL_RADIUS = 0.34;
const WHEEL_Y = 0.50;

function buildBmptVehicle(ctx: BuildContext): THREE.Group {
  const rng = ctx.rng.fork(0x8b17);
  const root = group('bmpt');
  root.position.set(HOTSPOTS.bmpt.x, GROUND_Y, HOTSPOTS.bmpt.z);
  root.rotation.y = HOTSPOTS.bmpt.rotY;

  const hullBits = new BitBucket();
  const turretBits = new BitBucket();
  const antennas: Array<{ obj: THREE.Object3D; baseRx: number; baseRz: number; phase: number }> = [];
  const rigs: CrewRig[] = [];

  /* ——— 车体 ——— */
  const hull = extrudeSide(HULL_PROFILE, 2.44, wetArmorMat, 0.04);
  hull.name = 'bmpt-hull';
  root.add(withOutline(hull));

  // 首上附加装甲块（跟着倾角斜贴）
  for (let i = 0; i < 3; i += 1) {
    const z = 2.54 - i * 0.36;
    const y = 0.86 + ((3.22 - z) / 1.44) * 0.46 + 0.07;
    hullBits.add(box(0.98, 0.11, 0.30, armorDarkMat), 0, y, z, 0.31, 0, 0);
  }

  // 驾驶员舱盖 + 潜望镜
  hullBits.add(cyl(0.24, 0.26, 0.09, 10, armorLightMat), -0.38, 1.50, 1.30);
  hullBits.add(box(0.16, 0.08, 0.06, gunMetalMat), -0.38, 1.54, 1.58);

  /* ——— 反应装甲块（立体厚度 + 崩角 + 崩边的熏黑）——— */
  // 首上装甲：两排错缝的 ERA 块，角度跟随首上倾角
  const eraBits: THREE.Mesh[] = [];
  for (let row = 0; row < 2; row += 1) {
    for (let col = 0; col < 6; col += 1) {
      const ex = -1.30 + col * 0.52 + (row % 2) * 0.13;
      const ez = 2.28 - row * 0.36;
      const ey = 1.36 + row * 0.19;
      const block = mesh(armorBlockGeometry(0.46, 0.24, 0.14, rng), armorDarkMat);
      at(block, ex, ey, ez);
      block.rotation.x = -0.42; // 贴合首上倾角
      block.rotation.y = rng.gauss(0, 0.03);
      eraBits.push(block);
      // 每块边缘的熏黑（薄片，压在块面上）
      if (rng.chance(0.5)) {
        const soot = box(0.30, 0.05, 0.02, sootMat);
        at(soot, ex + rng.gauss(0, 0.06), ey + 0.10, ez + 0.075);
        soot.rotation.x = -0.42;
        eraBits.push(soot);
      }
    }
  }
  // 炮塔正面：一圈楔形 ERA（BMPT 的炮塔较小，只放正面 3 块）
  for (let i = 0; i < 3; i += 1) {
    const block = mesh(armorBlockGeometry(0.34, 0.20, 0.16, rng), armorDarkMat);
    at(block, -0.44 + i * 0.44, 1.86, 0.86);
    block.rotation.x = -0.22;
    eraBits.push(block);
  }
  const eraMesh = mergeMeshes(eraBits, armorDarkMat);
  if (eraMesh) {
    eraMesh.name = 'bmpt-era';
    withOutline(eraMesh, 0.0022);
    root.add(eraMesh);
  }

  /* ——— 履带与行动装置 ——— */
  for (const side of [-1, 1]) {
    const band = trackBand(TRACK_LENGTH, TRACK_HEIGHT, TRACK_WIDTH, TRACK_BAND, trackMat);
    at(band, side * TRACK_CENTER_X, TRACK_HEIGHT / 2, 0);
    root.add(withOutline(band, 0.003));

    // 履带板侧棱（从侧面看得出履带一节一节）
    for (let i = 0; i < 15; i += 1) {
      const z = -2.62 + i * 0.375;
      hullBits.add(
        box(0.035, 0.115, 0.20, trackMat),
        side * (TRACK_CENTER_X + TRACK_WIDTH / 2 - 0.005),
        0.10,
        z,
      );
    }
  }
  // 分节履带板（两排一起 instanced）：真正的"一节一节"，绕履带环铺满
  root.add(buildTrackLinks(TRACK_LENGTH, TRACK_HEIGHT, TRACK_WIDTH, TRACK_CENTER_X, trackMat, rng));
  for (const side of [-1, 1]) {
    hullBits.add(box(0.58, 0.07, TRACK_LENGTH - 0.2, skirtMat), side * TRACK_CENTER_X, 1.09, 0);
    hullBits.add(box(0.06, 0.26, 5.5, skirtMat), side * (TRACK_CENTER_X + 0.26), 0.99, 0.1);
    for (let i = 0; i < 3; i += 1) {
      hullBits.add(box(0.055, 0.20, 0.62, armorDarkMat), side * (TRACK_CENTER_X + 0.30), 1.02, 1.55 - i * 1.35);
    }
    // 裙板上沿的湿冷高光（一条浅色棱线，远看就是轮廓）
    hullBits.add(box(0.075, 0.035, 5.4, rimMat), side * (TRACK_CENTER_X + 0.30), 1.14, 0.1);
    // 前挡泥橡胶帘
    hullBits.add(box(0.52, 0.30, 0.04, rubberMat), side * TRACK_CENTER_X, 0.92, 3.24, 0.12, 0, 0);
  }

  // 车体上沿的湿冷高光（把车顶面从车侧暗面里"切"出来）
  for (const side of [-1, 1]) {
    hullBits.add(box(0.05, 0.035, 3.3, rimMat), side * 1.19, 1.505, -0.55, 0, 0, 0);
  }
  hullBits.add(box(2.3, 0.03, 0.08, rimMat), 0, 0.885, 3.18, 0.31, 0, 0);

  // 负重轮（12 个，实例化）
  const wheelTransforms: InstanceTransform[] = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 6; i += 1) {
      wheelTransforms.push({
        position: new THREE.Vector3(side * TRACK_CENTER_X, WHEEL_Y, -2.35 + i * 0.94),
        rotation: new THREE.Euler(0, 0, Math.PI / 2),
      });
    }
  }
  const wheelGeom = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, TRACK_WIDTH - 0.08, 12);
  root.add(instanced(wheelGeom, rubberMat, wheelTransforms));
  const hubGeom = new THREE.CylinderGeometry(0.17, 0.17, TRACK_WIDTH - 0.04, 10);
  root.add(instanced(hubGeom, armorDarkMat, wheelTransforms));

  // 主动轮 / 诱导轮 / 托带轮
  const sprocketTransforms: InstanceTransform[] = [];
  const rollerTransforms: InstanceTransform[] = [];
  for (const side of [-1, 1]) {
    for (const z of [-2.72, 2.72]) {
      sprocketTransforms.push({
        position: new THREE.Vector3(side * TRACK_CENTER_X, 0.50, z),
        rotation: new THREE.Euler(0, 0, Math.PI / 2),
      });
    }
    for (const z of [-1.25, 1.25]) {
      rollerTransforms.push({
        position: new THREE.Vector3(side * TRACK_CENTER_X, 0.80, z),
        rotation: new THREE.Euler(0, 0, Math.PI / 2),
      });
    }
  }
  root.add(instanced(new THREE.CylinderGeometry(0.29, 0.29, TRACK_WIDTH - 0.06, 12), trackMat, sprocketTransforms));
  root.add(instanced(new THREE.CylinderGeometry(0.10, 0.10, TRACK_WIDTH - 0.16, 8), trackMat, rollerTransforms));

  /* ——— 动力舱 / 后部 ——— */
  // 散热格栅
  hullBits.add(box(1.94, 0.05, 1.42, sootMat), 0, 1.495, -1.58);
  for (let i = 0; i < 9; i += 1) {
    hullBits.add(box(1.86, 0.055, 0.075, gunMetalMat), 0, 1.525, -2.22 + i * 0.16);
  }
  // 排气口
  hullBits.add(box(0.62, 0.16, 0.5, sootMat), -1.02, 1.42, -2.55);
  // 油桶挂架（两个横置油桶，合并成一个挂载体；脏橄榄金属色，不抢轮廓）
  const drumBits: THREE.Mesh[] = [];
  for (const dx of [-0.62, 0.62]) {
    pushBit(drumBits, cyl(0.19, 0.19, 0.94, 12, drumMat), dx, 1.58, -2.66, 0, 0, Math.PI / 2);
    hullBits.add(box(0.10, 0.30, 0.10, gunMetalMat), dx, 1.38, -2.66);
  }
  flushBits(drumBits, drumMat, root, 'bmpt-drums', 0.0016);
  // 拖索（沿两侧车体）与后拖钩
  for (const side of [-1, 1]) {
    hullBits.addAsIs(
      cylinderBetween(
        new THREE.Vector3(side * 1.20, 1.54, 2.0),
        new THREE.Vector3(side * 1.18, 1.54, -2.3),
        0.036,
        gunMetalMat,
        6,
      ),
    );
    hullBits.add(torus(0.11, 0.025, gunMetalMat, 8), side * 0.7, 0.78, -3.16, Math.PI / 2, 0, 0);
  }
  // 车尾工具箱
  hullBits.add(box(1.7, 0.26, 0.24, armorMat), 0, 1.30, -2.46);

  /* ——— 炮塔 ——— */
  const turret = group('bmpt-turret');
  turret.position.set(0, 0, -0.1);
  turret.rotation.y = -0.12;
  root.add(turret);

  // 座圈 + 低矮炮塔体（八边形，纵向拉长；比车体亮一档，远看是明确的"驼峰"）
  turretBits.add(cyl(0.84, 0.90, 0.20, 12, skirtMat), 0, 1.56, 0);

  const turretBody = cyl(0.95, 1.02, 0.52, 8, armorMat);
  turretBody.scale.z = 1.26;
  at(turretBody, 0, 1.88, 0.02);
  turret.add(withOutline(turretBody));

  // 炮塔顶板 + 正面楔形装甲
  turretBits.add(box(1.42, 0.07, 1.66, armorDarkMat), 0, 2.16, 0.02);
  turretBits.add(box(1.30, 0.30, 0.46, armorMat), 0, 1.90, 0.92, -0.16, 0, 0);
  // 炮塔顶沿的湿冷高光
  for (const side of [-1, 1]) {
    turretBits.add(box(0.05, 0.035, 1.6, rimMat), side * 0.82, 2.185, 0.02);
  }

  // 两侧 30mm 机炮组（每侧两管，共 4 管）：炮座 + 火炮摇篮 + 4 根外露炮管
  turretBits.add(box(1.62, 0.20, 0.62, armorDarkMat), 0, 1.84, 1.28);
  for (const side of [-1, 1]) {
    const mountX = side * 0.72;
    const mount = box(0.50, 0.42, 0.72, armorDarkMat);
    at(mount, mountX, 1.86, 0.74);
    turret.add(withOutline(mount, 0.0024));
    turretBits.add(box(0.54, 0.10, 0.40, gunMetalMat), mountX, 2.06, 0.64);
    for (const off of [-0.125, 0.125]) {
      // 炮管：加粗到 12cm 直径并伸出车头 0.5m，128m 外也能看出"四根炮管"
      turretBits.add(cyl(0.062, 0.062, 2.9, 8, gunMetalMat), mountX + off, 1.84, 2.25, Math.PI / 2, 0, 0);
      // 炮口制退器
      turretBits.add(cyl(0.10, 0.10, 0.26, 8, gunMetalMat), mountX + off, 1.84, 3.62, Math.PI / 2, 0, 0);
      // 炮管第一节的护套（让炮管根部显粗，剪影更清楚）
      turretBits.add(cyl(0.085, 0.085, 0.55, 8, armorDarkMat), mountX + off, 1.84, 1.20, Math.PI / 2, 0, 0);
    }
    // 双管之间的卡箍
    turretBits.add(box(0.38, 0.14, 0.10, gunMetalMat), mountX, 1.84, 1.98);
  }

  // 导弹发射筒（每侧两联，箱式，斜向上；同侧合并成一个网格）
  for (const side of [-1, 1]) {
    const podBits: THREE.Mesh[] = [];
    for (let i = 0; i < 2; i += 1) {
      const podY = 1.78 + i * 0.30;
      pushBit(podBits, box(0.32, 0.29, 1.45, armorDarkMat), side * 1.08, podY, -0.16, -0.13, 0, 0);
      turretBits.add(box(0.33, 0.30, 0.05, trackMat), side * 1.08, podY + 0.10, 0.55, -0.13, 0, 0);
      // 筒体与炮塔之间的支臂
      turretBits.add(box(0.22, 0.10, 0.42, skirtMat), side * 0.90, podY - 0.10, -0.20);
    }
    flushBits(podBits, armorDarkMat, turret, `bmpt-pods-${side}`, 0.0022);
    // 发射筒上沿的湿冷高光：斜向上的箱体在远处一眼能认出来
    turretBits.add(box(0.34, 0.03, 1.4, rimMat), side * 1.08, 1.78 + 0.30 + 0.155, -0.16, -0.13, 0, 0);
  }

  // 观瞄设备 / 光电球
  turretBits.add(box(0.32, 0.24, 0.38, armorDarkMat), -0.60, 2.32, 0.02);
  turretBits.add(sphere(0.115, gunMetalMat, 10), -0.60, 2.38, 0.24);
  const lens = cyl(0.075, 0.075, 0.04, 10, glowMaterial(PALETTE.glassBroken, 0.75));
  at(lens, -0.60, 2.38, 0.34);
  lens.rotation.x = Math.PI / 2;
  turret.add(lens);

  // 车长舱盖（半开）
  turretBits.add(cyl(0.26, 0.28, 0.10, 10, armorLightMat), 0.40, 2.20, -0.48);
  turretBits.add(cyl(0.26, 0.26, 0.05, 10, armorDarkMat), 0.40, 2.31, -0.62, -0.55, 0, 0);

  // 车顶机枪
  turretBits.add(cyl(0.05, 0.06, 0.16, 8, gunMetalMat), 0.40, 2.32, -0.36);
  turretBits.add(cyl(0.026, 0.026, 0.56, 6, gunMetalMat), 0.40, 2.38, -0.12, Math.PI / 2 - 0.16, 0, 0);

  // 烟幕弹发射器（每侧 3 管）
  const smokeTransforms: InstanceTransform[] = [];
  const smokeGeom = new THREE.CylinderGeometry(0.055, 0.055, 0.26, 8);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i += 1) {
      smokeTransforms.push({
        position: new THREE.Vector3(side * (0.72 + i * 0.0), 2.06, -0.86 - i * 0.02),
        rotation: new THREE.Euler(Math.PI / 2 - 0.5, 0, side * (0.3 + i * 0.22)),
      });
    }
  }
  turret.add(instanced(smokeGeom, gunMetalMat, smokeTransforms));

  // 天线（极轻摆动；底座合并进炮塔小件）
  for (const side of [-1, 1]) {
    turretBits.add(cyl(0.045, 0.05, 0.10, 6, gunMetalMat), side * 0.72, 2.22, -1.02);
    const mast = cyl(0.016, 0.022, 0.44, 5, gunMetalMat);
    at(mast, side * 0.72, 2.27, -1.06);
    mast.rotation.x = -0.08;
    mast.rotation.z = side * 0.05;
    turret.add(mast);
    antennas.push({ obj: mast, baseRx: mast.rotation.x, baseRz: mast.rotation.z, phase: rng.range(0, 6.28) });
  }

  // 炮塔后部的杂物（卷起的防雨布）
  const tarp = capsule(0.13, 0.9, toonMaterial(PALETTE.tarp, { steps: 2 }));
  at(tarp, -0.10, 2.24, -0.92);
  tarp.rotation.set(0, 0, Math.PI / 2);
  turret.add(tarp);

  /* ——— 汇总小件 ——— */
  hullBits.flush(root, 'bmpt-bits', 0.0022);
  turretBits.flush(turret, 'bmpt-turret-bits', 0.0022);

  /* ——— 车旁休息的乘员 ——— */
  const crewSeats: Array<{ pose: CrewPose; x: number; z: number; y: number; yaw: number; lean: number; coat: THREE.Material }> = [
    // 坐在左前翼子板上，双腿垂在履带外侧
    { pose: 'sit', x: -1.44, z: 1.15, y: 1.15, yaw: -Math.PI / 2 + 0.5, lean: 0.04, coat: coatOliveMat },
    // 靠在履带边
    { pose: 'stand', x: -2.02, z: -0.85, y: 0.92, yaw: -Math.PI / 2 + 0.16, lean: -0.16, coat: coatGreyMat },
    // 蹲坐在地上
    { pose: 'crouch', x: 2.06, z: -0.55, y: 0.56, yaw: -Math.PI / 2 - 0.3, lean: 0.10, coat: coatBrownMat },
  ];
  crewSeats.forEach((seat) => {
    const { figure, rig } = crewFigure(rng, seat.pose, seat.coat);
    const holder = group('crew-slot');
    holder.position.set(seat.x, seat.y, seat.z);
    holder.rotation.y = seat.yaw;
    figure.rotation.x = seat.lean;
    holder.add(figure);
    root.add(holder);
    rigs.push(rig);
  });

  /* ——— 地面痕迹 ——— */
  root.add(decal(-0.6, 0.4, 2.6, dirtDecalMat, rng, 0.55));
  root.add(decal(1.1, -2.2, 1.7, scorchDecalMat, rng, 0.4));

  /* ——— 动效：呼吸 / 转头 / 天线轻摆 ——— */
  ctx.ticker.add((t, dt) => {
    for (const rig of rigs) {
      // 呼吸：躯干极轻微起伏（约 0.5-1cm）
      const breath = Math.sin(t * 1.25 + rig.phase);
      rig.torso.scale.set(1 + breath * 0.008, 1 + breath * 0.016, 1 + breath * 0.008);
      rig.torso.position.y = rig.baseTorsoY + breath * 0.008;

      // 偶尔换个头部角度
      if (t >= rig.nextSwitch) {
        rig.index = (rig.index + 1) % rig.targets.length;
        rig.nextSwitch = t + rig.interval + (rig.index % 2 === 0 ? 3 : 0);
      }
      const target = rig.targets[rig.index] ?? 0;
      rig.head.rotation.y += (target - rig.head.rotation.y) * Math.min(1, dt * 1.6);
    }
    for (const a of antennas) {
      a.obj.rotation.z = a.baseRz + Math.sin(t * 0.8 + a.phase) * 0.05;
      a.obj.rotation.x = a.baseRx + Math.cos(t * 0.63 + a.phase * 1.3) * 0.035;
    }
  });

  return root;
}

/* ============================== B. 被击毁的 T-72 ============================== */

interface EmberLight {
  mat: THREE.MeshBasicMaterial;
  base: number;
  rate: number;
  phase: number;
}

function buildT72Wreck(ctx: BuildContext): THREE.Group {
  const rng = ctx.rng.fork(0x7a72);
  const root = group('t72');
  root.position.set(HOTSPOTS.t72.x, GROUND_Y, HOTSPOTS.t72.z);
  root.rotation.y = HOTSPOTS.t72.rotY;
  root.rotation.z = 0.02;
  root.rotation.x = -0.01;

  const burntBits: THREE.Mesh[] = [];
  const rustBits: THREE.Mesh[] = [];
  const rustDarkBits: THREE.Mesh[] = [];
  const oliveBits: THREE.Mesh[] = [];
  const darkBits: THREE.Mesh[] = [];
  const embers: EmberLight[] = [];

  /* ——— 车体 ——— */
  const hull = extrudeSide(HULL_PROFILE, 2.44, wetBurntMat, 0.04);
  hull.name = 't72-hull';
  root.add(withOutline(hull));

  // 剥落的漆面：残余的橄榄绿 + 大片锈红（锈红是烧黑车体上唯一有饱和度的东西）
  for (let i = 0; i < 4; i += 1) {
    const z = 1.7 - i * 1.1;
    const patch = box(0.03, 0.30 + rng.range(0, 0.22), 0.42 + rng.range(0, 0.2), rustMat);
    pushBit(i % 2 === 0 ? rustBits : rustDarkBits, patch, 1.225, 1.20 + rng.range(-0.12, 0.12), z, rng.range(-0.1, 0.1), 0, 0);
    if (i < 2) {
      const keep = box(0.028, 0.22, 0.36, armorDarkMat);
      pushBit(oliveBits, keep, -1.225, 1.24, z - 0.5, 0, 0, rng.range(-0.12, 0.12));
    }
  }
  // 首上被烧穿 / 剥落的一大片锈红（远看就是"这车烧过"的识别点）
  pushBit(rustBits, box(1.5, 0.03, 0.9, rustMat), 0, 1.12, 2.25, 0.31, 0, 0);
  pushBit(rustDarkBits, box(0.9, 0.02, 0.55, rustDarkMat), -0.35, 1.28, 1.72, 0.31, 0, 0);
  // 顶板烧穿后的锈斑
  pushBit(rustDarkBits, box(0.9, 0.02, 0.7, rustDarkMat), 0.35, 1.50, 0.5, 0, 0.2, 0);
  pushBit(rustBits, box(0.6, 0.02, 0.5, rustMat), -0.55, 1.50, -1.6, 0, -0.1, 0);

  /* ——— 右侧履带完好，左侧断裂脱落 ——— */
  for (const side of [-1, 1]) {
    const broken = side === -1;
    const band = trackBand(TRACK_LENGTH, TRACK_HEIGHT, TRACK_WIDTH, TRACK_BAND, trackMat);
    at(band, side * TRACK_CENTER_X, TRACK_HEIGHT / 2, 0);
    if (broken) {
      // 残段：只剩前半截，后半截断落在地
      band.scale.z = 0.42;
      band.position.z = 1.85;
      band.rotation.z = 0.05;
    }
    root.add(withOutline(band, 0.003));
    if (!broken) {
      pushBit(burntBits, box(0.58, 0.07, TRACK_LENGTH - 0.3, burntLightMat), side * TRACK_CENTER_X, 1.09, 0);
    }
  }
  // 完好侧：绕履带环铺满分节履带板
  root.add(
    buildTrackLinks(TRACK_LENGTH, TRACK_HEIGHT, TRACK_WIDTH, TRACK_CENTER_X, trackMat, rng, {
      // 只保留右侧（x>0），左侧是断的
      skip: () => false,
    }),
  );
  // 断落在地的后半截履带板：散落 + 扭曲（继承断裂的叙事）
  const looseLinks: InstanceTransform[] = [];
  for (let i = 0; i < 9; i += 1) {
    looseLinks.push({
      position: new THREE.Vector3(
        -TRACK_CENTER_X + rng.range(-0.5, 0.5),
        0.06 + i * 0.012,
        -1.0 - i * 0.34 + rng.range(-0.1, 0.1),
      ),
      rotation: new THREE.Euler(rng.range(-0.2, 0.25), rng.range(0, 3.1), rng.range(-0.5, 0.5)),
    });
  }
  const loose = instanced(trackPadGeometry(), trackMat, looseLinks);
  loose.name = 't72-loose-links';
  loose.castShadow = false;
  root.add(loose);

  // 完好的负重轮（右）
  const wheelGeom = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, TRACK_WIDTH - 0.08, 12);
  const hubGeom = new THREE.CylinderGeometry(0.17, 0.17, TRACK_WIDTH - 0.04, 10);
  const goodWheels: InstanceTransform[] = [];
  const deadWheels: InstanceTransform[] = [];
  for (let i = 0; i < 6; i += 1) {
    goodWheels.push({
      position: new THREE.Vector3(TRACK_CENTER_X, WHEEL_Y, -2.35 + i * 0.94),
      rotation: new THREE.Euler(0, 0, Math.PI / 2),
    });
  }
  // 左侧只剩三个歪倒的负重轮
  for (const [idx, wobble] of [[0, 0.22], [2, -0.34], [4, 0.15]] as Array<[number, number]>) {
    deadWheels.push({
      position: new THREE.Vector3(-TRACK_CENTER_X + rng.range(-0.08, 0.08), WHEEL_Y, -2.35 + idx * 0.94),
      rotation: new THREE.Euler(wobble, rng.range(-0.2, 0.2), Math.PI / 2 + wobble * 0.5),
    });
  }
  root.add(instanced(wheelGeom, rubberMat, goodWheels.concat(deadWheels)));
  root.add(instanced(hubGeom, burntLightMat, goodWheels));

  // 断落的履带段躺在地上（用浅一点的烧过金属色，夜里能看出是"一条履带"）
  const droppedBand = trackBand(2.4, TRACK_HEIGHT, TRACK_WIDTH, TRACK_BAND, trackMat);
  at(droppedBand, -2.15, 0.30, 1.4);
  droppedBand.rotation.set(0, 0.24, Math.PI / 2 - 0.08);
  root.add(withOutline(droppedBand, 0.0028));

  // 断裂处散落的履带板（像被扯断的一串）
  for (let i = 0; i < 5; i += 1) {
    const link = box(0.44, 0.10, 0.26, burntLightMat);
    at(link, -1.75 - i * 0.12 + rng.range(-0.1, 0.1), 0.08 + i * 0.02, 2.6 + i * 0.42);
    link.rotation.set(rng.range(-0.2, 0.2), rng.range(-0.5, 0.5), rng.range(-0.15, 0.15));
    root.add(withOutline(link, 0.002));
  }
  // 左前诱/主动轮歪在一边（掉出来的大轮子比履带更"毁"）
  const spillWheel = cyl(WHEEL_RADIUS, WHEEL_RADIUS, TRACK_WIDTH - 0.08, 12, rubberMat);
  at(spillWheel, -2.35, 0.36, 3.05);
  spillWheel.rotation.set(0.25, 0.7, 0.15);
  root.add(withOutline(spillWheel, 0.0022));

  // 主动轮残留（合并）
  const trackBits: THREE.Mesh[] = [];
  for (const z of [-2.72, 2.72]) {
    pushBit(trackBits, cyl(0.29, 0.29, TRACK_WIDTH - 0.06, 10, trackMat), TRACK_CENTER_X, 0.50, z, 0, 0, Math.PI / 2);
  }

  /* ——— 炮塔：被掀偏、歪斜，露出座圈破口 ——— */
  // 座圈上的破口（黑洞 + 内部余烬）
  const ringHole = cyl(0.86, 0.92, 0.16, 12, burntMat);
  at(ringHole, 0, 1.50, -0.05);
  root.add(ringHole);
  const ringEmberMat = glowMaterial(PALETTE.ember, 0.9);
  const ringEmber = mesh(new THREE.CircleGeometry(0.76, 14), ringEmberMat);
  ringEmber.rotation.x = -Math.PI / 2;
  at(ringEmber, 0, 1.58, -0.05);
  ringEmber.castShadow = false;
  root.add(ringEmber);
  embers.push({ mat: ringEmberMat, base: 0.8, rate: 0.9, phase: 0.0 });

  const turret = group('t72-turret');
  turret.position.set(0.36, 1.80, -0.22);
  turret.rotation.set(0.16, 0.55, -0.24);
  root.add(turret);

  // 铸造炮塔（扁半球：别太像飞碟，压扁一点、抬高一点，明显"掀起来歪着"）
  const dome = sphere(0.80, wetBurntMat, 12);
  dome.scale.set(0.95, 0.66, 1.06);
  at(dome, 0, 0.10, 0);
  turret.add(withOutline(dome));
  // 炮塔尾舱
  const bustle = box(1.0, 0.28, 0.52, burntLightMat);
  at(bustle, 0, 0.06, -0.78);
  turret.add(bustle);
  // 炮塔正面炮盾
  const mantlet = box(0.92, 0.44, 0.48, burntLightMat);
  at(mantlet, 0, 0.16, 0.72);
  turret.add(withOutline(mantlet, 0.0026));
  // 舱盖（掀开，歪着）
  const hatch = cyl(0.30, 0.30, 0.06, 10, burntLightMat);
  at(hatch, -0.38, 0.44, -0.32);
  hatch.rotation.set(-0.35, 0.4, 0.5);
  turret.add(hatch);
  // 炮塔上的锈斑
  const turretRustA = box(0.36, 0.02, 0.3, rustMat);
  at(turretRustA, 0.30, 0.42, 0.10);
  turretRustA.rotation.set(0, 0.3, 0.2);
  turret.add(turretRustA);
  const turretRustB = box(0.28, 0.02, 0.34, rustDarkMat);
  at(turretRustB, -0.42, 0.36, -0.05);
  turretRustB.rotation.set(0.2, -0.4, 0);
  turret.add(turretRustB);

  // 下垂的炮管（断口处断掉）——用氧化过的亮炮钢，否则夜里完全看不见
  const gunBase = new THREE.Vector3(0, 0.16, 0.72);
  const gunEnd = new THREE.Vector3(0, -0.34, 3.05);
  turret.add(withOutline(cylinderBetween(gunBase, gunEnd, 0.082, gunBurntMat, 10), 0.0022));
  turret.add(cylinderBetween(
    new THREE.Vector3(0, 0.12, 0.70),
    new THREE.Vector3(0, -0.10, 1.6),
    0.115,
    burntLightMat,
    10,
  ));
  // 断口（锯齿状小铁片）
  for (let i = 0; i < 4; i += 1) {
    const shard = mesh(jitter(new THREE.BoxGeometry(0.16, 0.14, 0.1), 0.03, rng), burntLightMat);
    at(shard, rng.range(-0.1, 0.1), -0.34 + rng.range(-0.05, 0.05), 3.05);
    shard.rotation.set(rng.range(-0.4, 0.4), rng.range(0, 3), rng.range(-0.4, 0.4));
    turret.add(shard);
  }
  // 断掉的前半截炮管，落在车体前方地上
  const barrelPiece = group('t72-barrel-piece');
  const tube = cyl(0.075, 0.078, 2.0, 10, gunMetalMat);
  tube.rotation.z = Math.PI / 2;
  at(tube, 0, 0, 0);
  barrelPiece.add(tube);
  const muzzle = cyl(0.11, 0.10, 0.26, 10, trackMat);
  muzzle.rotation.z = Math.PI / 2;
  at(muzzle, 1.06, 0, 0);
  barrelPiece.add(muzzle);
  barrelPiece.position.set(2.35, 0.16, 3.4);
  barrelPiece.rotation.set(0.03, 0.55, 0.05);
  root.add(barrelPiece);

  /* ——— 车体侧面的破口 + 透出的余烬暖光 ——— */
  const breach = (x: number, y: number, z: number, side: number): void => {
    // 破口内部（黑洞）
    pushBit(darkBits, box(0.20, 0.34, 0.58, sootMat), x - side * 0.08, y, z);
    // 外翻的铁皮
    for (let i = 0; i < 3; i += 1) {
      const plate = mesh(jitter(new THREE.BoxGeometry(0.05, 0.26, 0.2), 0.03, rng), burntLightMat);
      at(plate, x + side * 0.04, y + rng.range(-0.14, 0.14), z + rng.range(-0.28, 0.28));
      plate.rotation.set(rng.range(-0.4, 0.4), rng.range(-0.5, 0.5), rng.range(-0.4, 0.4));
      root.add(plate);
    }
    // 余烬：贴在破口里的发光面片
    const emberMat = glowMaterial(PALETTE.ember, 0.65);
    const pane = mesh(new THREE.PlaneGeometry(0.42, 0.26), emberMat);
    pane.rotation.y = (side * Math.PI) / 2;
    at(pane, x + side * 0.03, y, z);
    pane.castShadow = false;
    root.add(pane);
    embers.push({ mat: emberMat, base: 0.6, rate: rng.range(1.1, 2.2), phase: rng.range(0, 6.28) });
  };
  breach(1.24, 1.14, -0.55, 1);
  breach(-1.24, 1.30, 0.75, -1);

  /* ——— 地上散落的零件 ——— */
  const scrapGeom = new THREE.DodecahedronGeometry(0.16, 0);
  const scrap: InstanceTransform[] = [];
  const scrapCount = Math.round(14 * ctx.quality) + 6;
  for (let i = 0; i < scrapCount; i += 1) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(1.8, 4.4);
    scrap.push({
      position: new THREE.Vector3(Math.cos(a) * r, rng.range(0.26, 0.34), Math.sin(a) * r * 0.8),
      rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)),
      scale: new THREE.Vector3(rng.range(0.4, 0.9), rng.range(0.25, 0.55), rng.range(0.4, 0.9)),
    });
  }
  root.add(instanced(scrapGeom, burntLightMat, scrap));

  // 掉落的负重轮与弹药箱
  const lostWheel = cyl(WHEEL_RADIUS * 0.9, WHEEL_RADIUS * 0.9, 0.34, 12, rubberMat);
  at(lostWheel, -2.6, 0.28, -1.1);
  lostWheel.rotation.set(0.14, 0.4, 0.08);
  root.add(lostWheel);
  const ammoBox = box(0.5, 0.24, 0.3, armorDarkMat);
  at(ammoBox, 1.9, 0.13, -1.9);
  ammoBox.rotation.y = 0.7;
  root.add(ammoBox);

  /* ——— 地面焦黑（刻意挂在未倾斜的 root 上，避免被车体倾斜带进地里）——— */
  const marks = group('t72-ground-marks');
  // 这组必须保持水平：4.2 m 的圆片哪怕只倾 0.02 rad，远端也会沉到路面以下，
  // 与沥青面相交后沿交线闪成一条亮边。
  root.add(marks);
  marks.add(decal(0.2, 0.2, 4.2, scorchDecalMat, rng, 0.62));
  marks.add(decal(-1.4, 1.6, 2.2, scorchDecalMat, rng, 0.6));
  marks.add(decal(2.2, -1.2, 1.5, dirtDecalMat, rng, 0.7));

  /* ——— 汇总小件 ——— */
  flushBits(burntBits, burntLightMat, root, 't72-burnt', 0.0016);
  flushBits(rustBits, rustMat, root, 't72-rust', 0);
  flushBits(rustDarkBits, rustDarkMat, root, 't72-rust-dark', 0);
  flushBits(oliveBits, armorDarkMat, root, 't72-paint', 0);
  flushBits(darkBits, sootMat, root, 't72-dark', 0);
  flushBits(trackBits, trackMat, root, 't72-track-bits', 0);

  /* ——— 余烬明灭 ——— */
  ctx.ticker.add((t) => {
    for (const e of embers) {
      const flicker = 0.55 + 0.45 * Math.sin(t * e.rate + e.phase);
      const pulse = 0.75 + 0.25 * Math.sin(t * e.rate * 2.7 + e.phase * 1.7);
      e.mat.opacity = e.base * flicker * pulse;
    }
  });

  return root;
}

/* ============================== C. 烧毁的民用轿车 ============================== */

function buildBurntCar(ctx: BuildContext): THREE.Group {
  const rng = ctx.rng.fork(0xca12);
  const root = group('burnt-car');
  root.position.set(HOTSPOTS.burntCar.x, GROUND_Y, HOTSPOTS.burntCar.z);
  root.rotation.y = HOTSPOTS.burntCar.rotY;

  const burntBits: THREE.Mesh[] = [];
  const rustBits: THREE.Mesh[] = [];
  const rustDarkBits: THREE.Mesh[] = [];
  const darkBits: THREE.Mesh[] = [];

  // 车身（下半部塌陷的箱体）
  const body = box(1.76, 0.56, 4.2, wetBurntMat);
  at(body, 0, 0.72, 0);
  root.add(withOutline(body, 0.0022));

  // 车轮：只剩三个 + 一个抱死的轮轴（带胎纹：胎面 + 胎侧 + 人字胎纹块）
  const wheelTransforms: InstanceTransform[] = [];
  for (const [wx, wz] of [[0.85, 1.32], [-0.85, 1.32], [0.85, -1.32]] as Array<[number, number]>) {
    wheelTransforms.push({
      position: new THREE.Vector3(wx, 0.30, wz),
      rotation: new THREE.Euler(0, 0, Math.PI / 2),
    });
  }
  const carTyre = tyreGeometry(0.30, 0.22, 16);
  root.add(instanced(carTyre.body, rubberMat, wheelTransforms));
  // 胎纹块跟在每个轮位周围（把轮子绕 Z 的 90° 旋转折算进位置）
  const carTread: InstanceTransform[] = [];
  for (const t of wheelTransforms) {
    for (const tt of carTyre.treadTransforms) {
      carTread.push({
        position: new THREE.Vector3(t.position.x + tt.position.x, 0.30 + tt.position.y, t.position.z + tt.position.z),
        rotation: new THREE.Euler(tt.rotation?.x ?? 0, tt.rotation?.y ?? 0, tt.rotation?.z ?? 0),
      });
    }
  }
  const carTreadMesh = instanced(carTyre.tread, rubberMat, carTread);
  carTreadMesh.name = 'car-tyre-tread';
  carTreadMesh.castShadow = false;
  root.add(carTreadMesh);
  // 缺失的左前轮：只剩轮毂
  const axle = cyl(0.14, 0.14, 0.2, 8, rustDarkMat);
  at(axle, -0.86, 0.30, 1.32);
  axle.rotation.z = Math.PI / 2;
  root.add(axle);

  // 烧空的车厢：暗色内腔 + 塌陷车顶
  pushBit(darkBits, box(1.5, 0.34, 1.7, sootMat), 0, 1.06, -0.1);
  const roof = box(1.5, 0.09, 1.6, wetBurntMat);
  at(roof, 0.02, 1.22, -0.25);
  roof.rotation.set(0.20, 0, -0.12);
  root.add(withOutline(roof, 0.0018));

  // 残余的 A/C 柱
  for (const [px, pz, tiltZ] of [[0.82, 0.72, -0.1], [-0.82, 0.72, 0.1], [0.82, -0.9, -0.14], [-0.82, -0.9, 0.08]] as Array<[number, number, number]>) {
    pushBit(burntBits, box(0.09, 0.46, 0.09, burntLightMat), px, 1.18, pz, 0.06, 0, tiltZ);
  }

  // 引擎盖（翘起、烧穿）
  const hood = box(1.68, 0.12, 1.5, wetBurntMat);
  at(hood, 0, 1.06, 1.42);
  hood.rotation.x = -0.13;
  root.add(withOutline(hood, 0.0018));
  pushBit(darkBits, box(0.8, 0.06, 0.7, sootMat), 0.1, 1.14, 1.4, -0.13, 0, 0);

  // 车窗：黑洞（贴片）
  for (const side of [-1, 1]) {
    pushBit(darkBits, box(0.03, 0.3, 1.3, sootMat), side * 0.79, 1.14, -0.1);
  }
  pushBit(darkBits, box(1.35, 0.28, 0.03, sootMat), 0, 1.14, 0.66);

  // 锈红的斑块（烧黑车身里唯一有饱和度的东西）
  pushBit(rustBits, box(0.03, 0.30, 0.9, rustMat), 0.885, 0.74, 0.7);
  pushBit(rustDarkBits, box(0.03, 0.22, 0.6, rustDarkMat), -0.885, 0.68, -1.2);
  pushBit(rustBits, box(0.9, 0.02, 0.6, rustMat), 0, 1.13, 1.5, -0.13, 0, 0);
  pushBit(rustDarkBits, box(0.6, 0.02, 0.45, rustDarkMat), -0.2, 1.28, -0.5, 0.2, 0, -0.12);
  pushBit(rustBits, box(0.02, 0.24, 0.5, rustMat), 0.885, 0.80, -1.55);
  pushBit(rustBits, box(0.45, 0.02, 0.35, rustMat), 0.42, 0.995, 0.35);

  // 保险杠残片 + 掉落的车门
  pushBit(burntBits, box(1.8, 0.14, 0.16, burntLightMat), 0, 0.56, 2.1);
  const door = box(0.9, 0.06, 0.5, wetBurntMat);
  at(door, 1.72, 0.07, -0.9);
  door.rotation.set(0.05, 0.7, 0.03);
  root.add(withOutline(door, 0.0016));

  flushBits(burntBits, burntLightMat, root, 'car-burnt', 0.0016);
  flushBits(rustBits, rustMat, root, 'car-rust', 0);
  flushBits(rustDarkBits, rustDarkMat, root, 'car-rust-dark', 0);
  flushBits(darkBits, sootMat, root, 'car-dark', 0);

  root.add(decal(0.2, 0.3, 2.4, scorchDecalMat, rng, 0.62));
  root.add(decal(-0.9, -1.4, 1.1, dirtDecalMat, rng, 0.8));

  return root;
}

/* ============================== 入口 ============================== */

export function buildVehicles(ctx: BuildContext): THREE.Group {
  const root = group('vehicles');
  root.add(buildBmptVehicle(ctx));
  root.add(buildT72Wreck(ctx));
  root.add(buildBurntCar(ctx));
  return root;
}
