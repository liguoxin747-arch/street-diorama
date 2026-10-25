import * as THREE from 'three';
import type { BuildContext } from '../core/context';
import {
  at,
  box,
  capsule,
  cyl,
  cylinderBetween,
  group,
  hashNoise,
  instanced,
  mergeMeshes,
  mesh,
  softBox,
  sphere,
  type InstanceTransform,
} from '../core/geo';
import { basicMaterial, canvasTexture, glowMaterial, toonMaterial, withOutline } from '../core/materials';
import { PALETTE } from '../core/palette';
import { CONVOY_LANE, HOTSPOTS, ROADS, carriageway, groundYAt, isOnCarriageway } from './layout';
import { PUDDLES } from './base';
import { makeBucket } from './props';

/**
 * 废墟中幸存的三位居民：
 *  A. 商铺室内做饭的主妇（炉前弯腰舀汤 + 柴/锅盖/搪瓷杯/罐头/米袋 + 跳动火光）
 *  B. 路口人行道上拉着两轮拖车的老妇人（车上挂水桶，脚边一只桶）
 *  C. 人行道上的两个小孩：抬腿轮流踢水坑（涟漪 + 几点水珠，节奏错开、偶尔落空）
 *
 * 人物在画面里通常只有 10-20 像素高，所以造型一律"大块面"：
 * 躯干一个盒子、头一个球、帽子/头巾一块、四肢各一个胶囊，不做五官与手指。
 * 靠剪影、明暗对比与克制色块取胜，只留一点点暖色（红头巾、火光）作视觉焦点。
 *
 * 水坑一律取自 base.ts 导出的 PUDDLES（挑离 HOTSPOTS.kids 最近、水漫过路缘石、
 * 且不占车队车道的一块），两个孩子就挪到那块水洼最近的人行道上；
 * 涟漪与水珠各用一个 InstancedMesh（共 2 mesh / 2 draw call），动画只在 ticker 里改 transform。
 */

// —— 地面高度 ——
/** 商铺室内地坪：与主楼 hero.ts 的底层地面 GF = 0.2 对齐 */
const SHOP_FLOOR_Y = 0.2;
/** 人行道顶面（base.ts 的路缘高 0.22） */
const WALK_Y = 0.22;

// —— 材质（模块级共享，控制 draw state 数量）——
const MAT = {
  coatGrey: toonMaterial(PALETTE.coatGrey, { steps: 2 }),
  coatBrown: toonMaterial(PALETTE.coatBrown, { steps: 2 }),
  coatOlive: toonMaterial(PALETTE.coatOlive, { steps: 2 }),
  pants: toonMaterial(0x30343a, { steps: 2 }),
  pantsBrown: toonMaterial(0x3a3029, { steps: 2 }),
  skin: toonMaterial(PALETTE.skin, { steps: 2 }),
  scarfRed: toonMaterial(PALETTE.scarfRed, { steps: 2 }),
  beanieGrey: toonMaterial(PALETTE.hairGrey, { steps: 2 }),
  beanieOlive: toonMaterial(PALETTE.oliveLight, { steps: 2 }),
  apron: toonMaterial(0x8b8880, { steps: 2 }),
  brick: toonMaterial(PALETTE.brickDark, { steps: 2 }),
  iron: toonMaterial(PALETTE.barrel, { steps: 2 }),
  ironDark: toonMaterial(0x2f353b, { steps: 2 }),
  rust: toonMaterial(PALETTE.rust, { steps: 2 }),
  wood: toonMaterial(PALETTE.woodOld, { steps: 2 }),
  woodDark: toonMaterial(PALETTE.woodDark, { steps: 2 }),
  cloth: toonMaterial(PALETTE.tarp, { steps: 2 }),
  clothLight: toonMaterial(PALETTE.sandbagDark, { steps: 2 }),
  enamel: toonMaterial(0xc6ccc6, { steps: 2 }),
  stone: toonMaterial(PALETTE.concreteDark, { steps: 2 }),
  water: basicMaterial(PALETTE.puddle, { opacity: 0.92 }),
  groundMark: basicMaterial(0x1a1d1f, { opacity: 0.6 }),
} as const;

type Headwear = 'scarf' | 'beanie' | 'hood';

interface PersonSpec {
  /** 站直后的目标身高（蹲姿时作为比例基准） */
  height: number;
  /** 髋部高度：决定腿长；蹲姿用小值 */
  hipY: number;
  shoulderW: number;
  depth: number;
  coat: THREE.Material;
  pants: THREE.Material;
  hat: THREE.Material;
  hatKind: Headwear;
  /** 手臂胶囊的圆柱段长度（总长 = armLen + 2 * armRadius） */
  armLen: number;
  armRadius: number;
  /**
   * 'stand' 双腿合并成一块；'crouch' 蹲姿折腿；
   * 'kick' = 支撑腿留在合并块里，另一侧做成可抬腿的髋+膝两级枢轴（踢水坑用）。
   */
  legs: 'stand' | 'crouch' | 'kick';
  /** 'kick' 时哪一侧是摆动腿（±1，默认 +1） */
  swingSide?: number;
}

interface PersonRig {
  root: THREE.Group;
  /** 躯干枢轴（在髋部，做前倾/呼吸） */
  torso: THREE.Group;
  head: THREE.Group;
  /** 局部 -X 侧手臂 */
  armA: THREE.Group;
  /** 局部 +X 侧手臂 */
  armB: THREE.Group;
  hipY: number;
  torsoH: number;
  depth: number;
  /** 肩到手尖的臂长（做姿势时算伸手距离用） */
  armSpan: number;
  /**
   * 摆动腿的髋枢轴（'kick' 才有）。**故意不挂到 root 上**：
   * 调用方 withOutline(root) 之后再 add，免得给新腿多配一层描边外壳（省 draw call）。
   */
  swingHip: THREE.Group | null;
  /** 摆动腿的膝枢轴（小腿 + 鞋已合并成一块） */
  swingKnee: THREE.Group | null;
}

/** 用块面拼一个极简人物：脚在 y=0，面朝局部 +Z。 */
function buildPerson(spec: PersonSpec): PersonRig {
  const root = group('resident');
  const torsoH = spec.height * 0.3;
  const headR = spec.height * 0.082;
  const sw = spec.shoulderW;

  // —— 腿 / 蹲姿折腿（合并成一块，剪影更干净）；'kick' 时摆动腿单独成枢轴 ——
  const legParts: THREE.Mesh[] = [];
  let swingHip: THREE.Group | null = null;
  let swingKnee: THREE.Group | null = null;
  const swingSide = spec.swingSide ?? 1;
  for (const s of [-1, 1]) {
    if (spec.legs === 'kick' && s === swingSide) {
      const hip = group('kick-hip');
      hip.position.set(s * sw * 0.23, spec.hipY * 0.94, 0);
      const thigh = box(sw * 0.36, spec.hipY * 0.5, sw * 0.42, spec.pants);
      // 新小件一律不投影（阴影贴图只在启动时烘焙，动态投影只会浪费 pass）
      thigh.castShadow = false;
      at(thigh, 0, -spec.hipY * 0.25, 0);
      hip.add(thigh);
      const knee = group('kick-knee');
      knee.position.set(0, -spec.hipY * 0.5, 0);
      const shin = box(sw * 0.32, spec.hipY * 0.46, sw * 0.38, spec.pants);
      at(shin, 0, -spec.hipY * 0.23, 0);
      // 鞋尖踢出去时最靠前的一点
      const shoe = box(sw * 0.42, 0.06, sw * 0.68, spec.pants);
      at(shoe, 0, -spec.hipY * 0.46, sw * 0.16);
      const lower = mergeMeshes([shin, shoe], spec.pants);
      if (lower) {
        lower.castShadow = false;
        knee.add(lower);
      }
      hip.add(knee);
      swingHip = hip;
      swingKnee = knee;
      continue;
    }
    const foot = box(sw * 0.42, 0.065, sw * 0.62, spec.pants);
    at(foot, s * sw * 0.23, 0.033, sw * 0.12);
    legParts.push(foot);
    if (spec.legs !== 'crouch') {
      const leg = box(sw * 0.36, spec.hipY * 0.94, sw * 0.42, spec.pants);
      at(leg, s * sw * 0.23, spec.hipY * 0.47, 0);
      legParts.push(leg);
    } else {
      // 蹲姿：小腿竖直 + 大腿水平前伸，从远处看就是一个"折起来的方块"
      const shin = box(sw * 0.32, spec.hipY * 0.8, sw * 0.36, spec.pants);
      at(shin, s * sw * 0.25, spec.hipY * 0.4, sw * 0.06);
      legParts.push(shin);
      const thigh = box(sw * 0.34, sw * 0.3, sw * 0.7, spec.pants);
      at(thigh, s * sw * 0.25, spec.hipY * 0.88, sw * 0.42);
      legParts.push(thigh);
    }
  }
  const legs = mergeMeshes(legParts, spec.pants);
  if (legs) {
    legs.name = 'legs';
    root.add(legs);
  }

  // —— 躯干（含外套下摆）——
  const torso = group('torso');
  torso.position.y = spec.hipY;
  root.add(torso);

  const trunkParts: THREE.Mesh[] = [];
  const chest = box(sw, torsoH, spec.depth, spec.coat);
  at(chest, 0, torsoH * 0.52, 0);
  trunkParts.push(chest);
  const hem = box(sw * 1.12, torsoH * 0.4, spec.depth * 1.14, spec.coat);
  at(hem, 0, torsoH * 0.06, 0);
  trunkParts.push(hem);
  const trunk = mergeMeshes(trunkParts, spec.coat);
  if (trunk) torso.add(trunk);

  // —— 头 + 帽子/头巾 ——
  const head = group('head');
  head.position.y = torsoH;
  torso.add(head);

  const neck = cyl(headR * 0.44, headR * 0.5, headR * 0.75, 8, MAT.skin);
  at(neck, 0, headR * 0.12, 0);
  const skull = sphere(headR, MAT.skin, 10);
  at(skull, 0, headR * 0.88, 0);
  const headMesh = mergeMeshes([neck, skull], MAT.skin);
  if (headMesh) head.add(headMesh);

  const hatParts: THREE.Mesh[] = [];
  if (spec.hatKind === 'beanie') {
    const cap = sphere(headR * 1.05, spec.hat, 10);
    cap.scale.set(1, 0.8, 1);
    at(cap, 0, headR * 1.05, 0);
    hatParts.push(cap);
    const brim = cyl(headR * 1.07, headR * 1.03, headR * 0.42, 10, spec.hat);
    at(brim, 0, headR * 0.7, 0);
    hatParts.push(brim);
  } else if (spec.hatKind === 'scarf') {
    // 头巾：包住后脑与肩线，正面留出一条脸
    const cap = sphere(headR * 1.1, spec.hat, 10);
    cap.scale.set(1.02, 1, 1.02);
    at(cap, 0, headR * 0.95, -headR * 0.08);
    hatParts.push(cap);
    const drape = box(headR * 1.6, headR * 1.6, headR * 1.3, spec.hat);
    at(drape, 0, headR * 0.05, -headR * 0.8);
    hatParts.push(drape);
  } else {
    // 连帽衫：帽子整个罩住，脸只露一条缝
    const hood = sphere(headR * 1.24, spec.hat, 10);
    hood.scale.set(1, 1.02, 1.06);
    at(hood, 0, headR * 0.9, -headR * 0.14);
    hatParts.push(hood);
    const collar = box(headR * 1.9, headR * 0.85, headR * 1.7, spec.hat);
    at(collar, 0, headR * 0.3, -headR * 0.35);
    hatParts.push(collar);
  }
  const hatMesh = mergeMeshes(hatParts, spec.hat);
  if (hatMesh) head.add(hatMesh);

  // —— 手臂（枢轴在肩，便于摆动）——
  const shoulderY = torsoH * 0.9;
  const makeArm = (side: number): THREE.Group => {
    const pivot = group(side < 0 ? 'arm-a' : 'arm-b');
    pivot.position.set(side * sw * 0.52, shoulderY, 0);
    const limb = capsule(spec.armRadius, spec.armLen, spec.coat);
    at(limb, 0, -(spec.armLen / 2 + spec.armRadius * 0.7), 0);
    pivot.add(limb);
    torso.add(pivot);
    return pivot;
  };
  const armA = makeArm(-1);
  const armB = makeArm(1);

  return {
    root,
    torso,
    head,
    armA,
    armB,
    hipY: spec.hipY,
    torsoH,
    depth: spec.depth,
    armSpan: spec.armLen + spec.armRadius * 2,
    swingHip,
    swingKnee,
  };
}

// =====================================================================================
// A. 商铺室内：主妇做饭
// =====================================================================================

/**
 * 商铺里的铁炉、锅与烟囱由 hero.ts 在 HOTSPOTS.shopInterior 建好
 * （炉体 0.7×0.62、顶面 GF+0.68、锅口 GF+0.87、炉门朝 +Z），这里不再重复建模，只补：
 *   - 主妇本人（站在炉前弯腰舀汤）
 *   - 生活痕迹：柴、锅盖、搪瓷杯、罐头、米袋、散落砖
 *   - 跳动的暖橙火光（炉门两片 + 锅底一圈）与一盏炉火点光
 * 场景局部原点 = 炉灶中心；局部 +Z 朝炉门（朝屋外）。
 */
function buildCookScene(ctx: BuildContext): THREE.Group {
  const scene = group('resident-cook');
  at(scene, HOTSPOTS.shopInterior.x, SHOP_FLOOR_Y, HOTSPOTS.shopInterior.z);

  // —— 火光：贴在主楼炉门前方（比它那片面片再前 1-2cm，避免共面抖动）——
  const fireGlow = glowMaterial(PALETTE.fire, 0.9);
  const coreGlow = glowMaterial(PALETTE.fireCore, 0.92);

  const mouth = mesh(new THREE.PlaneGeometry(0.2, 0.13), fireGlow);
  at(mouth, 0.0, 0.25, 0.356);
  mouth.castShadow = false;
  scene.add(mouth);
  const mouthCore = mesh(new THREE.PlaneGeometry(0.11, 0.08), coreGlow);
  at(mouthCore, 0.0, 0.235, 0.364);
  mouthCore.castShadow = false;
  scene.add(mouthCore);

  // 锅底一圈火光：炉顶铁板与锅之间漏出的暖橙（任何角度都能看到）
  const underPot = mesh(new THREE.CircleGeometry(0.19, 12), fireGlow);
  underPot.rotation.x = -Math.PI / 2;
  at(underPot, 0.0, 0.716, 0);
  underPot.castShadow = false;
  scene.add(underPot);
  const underCore = mesh(new THREE.CircleGeometry(0.115, 12), coreGlow);
  underCore.rotation.x = -Math.PI / 2;
  at(underCore, 0.0, 0.722, 0);
  underCore.castShadow = false;
  scene.add(underCore);

  // 炉火点光：压得较低、贴着炉门，给妇人外套正面与地面打暖光
  // （锅口上方留空——蒸汽由其它模块在该点位生成）
  const fireLight = ctx.addLight(new THREE.PointLight(0xff9a4a, 6, 7, 2));
  at(fireLight, HOTSPOTS.shopInterior.x + 0.02, SHOP_FLOOR_Y + 0.42, HOTSPOTS.shopInterior.z + 0.46);

  // —— 炉前散落的柴 + 两块备用砖（合并）——
  const sticks: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i += 1) {
    const log = cyl(0.032, 0.028, 0.3 + i * 0.05, 6, MAT.wood);
    log.rotation.set(Math.PI / 2, 0, 0.5 + i * 0.45);
    at(log, 0.24 + i * 0.05, 0.058 + (i % 2) * 0.045, 0.62 - i * 0.05);
    sticks.push(log);
  }
  for (let i = 0; i < 2; i += 1) {
    const b = box(0.2, 0.075, 0.1, MAT.brick);
    at(b, 0.62 + i * 0.03, 0.045, 0.12 - i * 0.16, 0.4 + i * 0.6);
    sticks.push(b);
  }
  const stickPile = mergeMeshes(sticks, MAT.wood);
  if (stickPile) scene.add(stickPile);

  // —— 炊具杂物（不加描边：小碎件描边会成噪点）——
  const lid = cyl(0.16, 0.16, 0.022, 12, MAT.ironDark);
  at(lid, -0.6, 0.02, 0.36);
  lid.rotation.set(0.06, 0.4, 0.05);
  scene.add(lid);

  const cup = cyl(0.046, 0.04, 0.1, 8, MAT.enamel);
  at(cup, 0.44, 0.06, 0.5);
  cup.rotation.z = 0.06;
  scene.add(cup);

  const can = cyl(0.05, 0.05, 0.11, 8, MAT.rust);
  at(can, 0.5, 0.065, 0.28);
  can.rotation.z = -0.05;
  scene.add(can);

  const sack = softBox(0.26, 0.2, 0.2, 0.06, MAT.clothLight);
  at(sack, -0.84, 0.11, -0.1, 0.5);
  scene.add(sack);

  // —— 主妇：深色外套 + 围裙 + 红头巾，站在炉前弯腰往锅里舀汤 ——
  // 髋部距炉灶中心 0.62m；躯干前倾 0.42；持勺手落在锅口上方一点点
  const cook = buildPerson({
    height: 1.6,
    hipY: 0.78,
    shoulderW: 0.34,
    depth: 0.24,
    coat: MAT.coatGrey,
    pants: MAT.pants,
    hat: MAT.scarfRed,
    hatKind: 'scarf',
    armLen: 0.36,
    armRadius: 0.048,
    legs: 'stand',
  });
  withOutline(cook.root);
  cook.root.position.set(-0.25, 0, 0.57);
  cook.root.rotation.y = 2.73; // 面向炉灶（局部 -Z 偏 +X 方向）
  cook.torso.rotation.x = 0.42; // 前倾弯腰
  cook.head.rotation.x = 0.05; // 低头看锅
  cook.armB.rotation.x = -1.38; // 持勺手伸到锅口上方
  cook.armB.rotation.z = -0.16;
  cook.armA.rotation.x = -1.05; // 另一只手扶在炉沿
  cook.armA.rotation.z = 0.22;
  scene.add(cook.root);

  // 围裙面片（挂在躯干上，跟着弯腰）
  const apron = box(0.23, cook.torsoH * 0.78, 0.03, MAT.apron);
  at(apron, 0, cook.torsoH * 0.3, cook.depth * 0.52);
  cook.torso.add(apron);

  // 长柄勺：从手里斜插进锅口，跟着手臂一起搅
  const ladle = cylinderBetween(
    new THREE.Vector3(0, -0.4, 0.02),
    new THREE.Vector3(0, -0.2, 0.3),
    0.013,
    MAT.woodDark,
    6,
  );
  cook.armB.add(ladle);

  // —— 动效：极轻的舀汤/搅拌 + 呼吸般的晃动 + 不规则火光 ——
  const rest = { x: cook.armB.rotation.x, z: cook.armB.rotation.z };
  const flick = (t: number): number => {
    const stepped = hashNoise(Math.floor(t * 15) + 3.1) * 2 - 1;
    return stepped * 0.55 + Math.sin(t * 9.3) * 0.3 + Math.sin(t * 17.9 + 1.7) * 0.2;
  };

  ctx.ticker.add((t) => {
    // 搅拌：主周期 5.4s、副周期 2.7s（舀起—倾倒）
    const stir = Math.sin((t * Math.PI * 2) / 5.4);
    const pour = Math.sin((t * Math.PI * 2) / 2.7 + 0.8);
    cook.armB.rotation.x = rest.x + stir * 0.14;
    cook.armB.rotation.z = rest.z + pour * 0.1;
    cook.armA.rotation.z = 0.22 + stir * 0.04;
    // 身体极轻微前后晃动（约 1s 呼吸 + 1.4s 重心）
    cook.torso.rotation.x = 0.42 + Math.sin(t * 1.05) * 0.022;
    cook.torso.rotation.z = Math.sin(t * 0.71) * 0.015;
    cook.head.rotation.y = Math.sin(t * 0.43) * 0.1;

    // 火光跳动：光强 + 面片亮度/大小
    const f = Math.max(-1, Math.min(1, flick(t)));
    fireLight.intensity = 6 + f * 2.4;
    fireGlow.opacity = 0.72 + Math.max(0, f) * 0.24;
    coreGlow.opacity = 0.62 + Math.max(0, -f) * 0.3;
    const k = 1 + f * 0.12;
    mouth.scale.set(k, 1 + f * 0.08, 1);
    mouthCore.scale.set(k, 1 - f * 0.06, 1);
    underPot.scale.setScalar(1 + f * 0.09);
    underCore.scale.setScalar(1.02 - f * 0.08);
  });

  return scene;
}

// =====================================================================================
// B. 人行道：老妇人 + 两轮拖车 + 水桶
// =====================================================================================

function buildOldWomanScene(ctx: BuildContext): THREE.Group {
  const scene = group('resident-old-woman');
  at(scene, HOTSPOTS.oldWoman.x, WALK_Y, HOTSPOTS.oldWoman.z);
  scene.rotation.y = HOTSPOTS.oldWoman.rotY; // 沿人行道向东走，拖车跟在身后

  // —— 老妇人：微驼背 + 毛线帽 + 深色长外套 ——
  const woman = buildPerson({
    height: 1.6,
    hipY: 0.78,
    shoulderW: 0.36,
    depth: 0.26,
    coat: MAT.coatBrown,
    pants: MAT.pantsBrown,
    hat: MAT.beanieGrey,
    hatKind: 'beanie',
    armLen: 0.36,
    armRadius: 0.05,
    legs: 'stand',
  });
  withOutline(woman.root);
  woman.root.position.set(0.0, 0, 0.1);
  woman.torso.rotation.x = 0.24; // 微驼背
  woman.head.rotation.x = -0.08;
  woman.head.position.z = 0.04;
  woman.armB.rotation.x = 0.71; // 右手向后抓着车把
  woman.armB.rotation.z = -0.1;
  woman.armA.rotation.x = -0.26;
  woman.armA.rotation.z = 0.16;
  scene.add(woman.root);

  // —— 两轮手推车（长 1.2m，车板中心在身后 0.78m）——
  const cart = group('handcart');
  at(cart, 0.02, 0, -0.78);
  scene.add(cart);

  const woodParts: THREE.Mesh[] = [];
  const bed = box(0.6, 0.045, 1.15, MAT.wood);
  at(bed, 0, 0.4, 0);
  woodParts.push(bed);
  for (const s of [-1, 1]) {
    const rail = box(0.04, 0.13, 1.12, MAT.woodDark);
    at(rail, s * 0.3, 0.48, 0);
    woodParts.push(rail);
    // 车把：从车板前沿斜向上，把手尖正好落进老妇人手里
    const handle = cylinderBetween(
      new THREE.Vector3(s * 0.26, 0.42, 0.44),
      new THREE.Vector3(s * 0.13, 0.9, 0.58),
      0.022,
      MAT.woodDark,
      6,
    );
    woodParts.push(handle);
    const leg = box(0.05, 0.4, 0.05, MAT.woodDark);
    at(leg, s * 0.24, 0.2, -0.5);
    woodParts.push(leg);
  }
  const frame = mergeMeshes(woodParts, MAT.wood);
  if (frame) cart.add(frame);

  // 车轮 + 车轴（深色铁件）
  const metalParts: THREE.Mesh[] = [];
  for (const s of [-1, 1]) {
    const wheel = cyl(0.24, 0.24, 0.07, 12, MAT.woodDark);
    wheel.rotation.z = Math.PI / 2;
    at(wheel, s * 0.34, 0.25, -0.02);
    metalParts.push(wheel);
    const hub = cyl(0.05, 0.05, 0.1, 8, MAT.rust);
    hub.rotation.z = Math.PI / 2;
    at(hub, s * 0.34, 0.25, -0.02);
    metalParts.push(hub);
  }
  const axle = cyl(0.026, 0.026, 0.68, 6, MAT.rust);
  axle.rotation.z = Math.PI / 2;
  at(axle, 0, 0.25, -0.02);
  metalParts.push(axle);
  const wheels = mergeMeshes(metalParts, MAT.ironDark);
  if (wheels) cart.add(wheels);

  // 车上的家当：铺盖卷 + 布袋 + 盖布
  const bedroll = cyl(0.105, 0.105, 0.5, 8, MAT.clothLight);
  bedroll.rotation.set(Math.PI / 2, 0, 0.06);
  at(bedroll, 0, 0.5, -0.28);
  cart.add(bedroll);
  const bundle = softBox(0.44, 0.24, 0.4, 0.07, MAT.cloth);
  at(bundle, 0.02, 0.55, 0.16, 0.22);
  cart.add(bundle);
  const tarp = softBox(0.52, 0.08, 0.44, 0.05, MAT.clothLight);
  at(tarp, 0, 0.44, -0.02, -0.12);
  tarp.rotation.z = 0.03;
  cart.add(tarp);

  // 挂在车帮上的水桶：凹痕桶身 + 桶箍 + 卷边 + 提手弯梁 + 桶内水面
  const bucketPivot = group('bucket-pivot');
  at(bucketPivot, -0.33, 0.44, -0.3);
  cart.add(bucketPivot);
  const bucket = makeBucket(ctx.rng.fork(0xb17c), 0.11, 0.09, 0.27, 0.62);
  bucketPivot.add(bucket);
  const waterHang = bucket.getObjectByName('bucket-water') as THREE.Mesh;

  // 脚边的另一只桶
  const bucket2 = makeBucket(ctx.rng.fork(0xb2f4), 0.13, 0.105, 0.31, 0.5);
  at(bucket2, 0.34, 0.31, 0.3);
  scene.add(bucket2);
  const water2 = bucket2.getObjectByName('bucket-water') as THREE.Mesh;

  // "人物 + 载具"整体描边（水桶与水面不加）
  withOutline(cart);

  // —— 动效：呼吸轻晃 + 拖车钟摆 + 水面起伏 ——
  const waterHangY = waterHang.position.y;
  const water2Y = water2.position.y;

  ctx.ticker.add((t) => {
    woman.torso.rotation.z = Math.sin(t * 0.62) * 0.02;
    woman.torso.rotation.x = 0.24 + Math.sin(t * 0.93) * 0.012;
    woman.head.rotation.y = Math.sin(t * 0.31) * 0.16;

    // 拖车缓慢钟摆（5.8s / 7.2s，桶沿位移 1-2cm）
    const sway = Math.sin((t * Math.PI * 2) / 5.8);
    cart.rotation.z = sway * 0.013;
    cart.rotation.x = Math.sin((t * Math.PI * 2) / 7.2 + 1.1) * 0.008;

    // 大桶跟着晃
    bucketPivot.rotation.z = Math.sin((t * Math.PI * 2) / 4.4 + 0.6) * 0.07;
    bucketPivot.rotation.x = Math.sin((t * Math.PI * 2) / 5.1) * 0.04;

    // 水面微微起伏
    waterHang.position.y = waterHangY + Math.sin(t * 1.9) * 0.005;
    waterHang.scale.set(1 + Math.sin(t * 1.35) * 0.05, 1 + Math.cos(t * 1.15) * 0.05, 1);
    water2.position.y = water2Y + Math.sin(t * 1.6 + 2.0) * 0.005;
    water2.scale.set(1 + Math.cos(t * 1.25) * 0.045, 1 + Math.sin(t * 1.05) * 0.045, 1);
  });

  return scene;
}

// =====================================================================================
// C. 人行道：两个小孩踢水坑
// =====================================================================================

/** 落脚点取水洼在路缘石内侧 0.35 m 处：看得见水面，又绝不占行车线 */
const KICK_EDGE = 0.35;
/** 站位在路缘石外侧 0.62 m（一定站在人行道上） */
const STAND_EDGE = 0.62;
/** 一次踢腿的动作时长（秒）：抬腿 0.33 s 到最高点是碰水瞬间，再 0.77 s 落回 */
const KICK_MOVE = 1.1;
const KICK_CONTACT = 0.33;
/** 一轮节奏：先手踢完等 5.0~5.9 s，后手在其后约 1.4 s 接踢（错开靠起手时间） */
const KICK_WAIT = 5.0;
const KICK_WAIT_JITTER = 0.9;
/** 约 38% 概率加踢一脚（1.5 s 后再来一次） */
const KICK_DOUBLE_P = 0.38;
const KICK_DOUBLE_WAIT = 1.5;
/** 约 24% 概率落空：抬腿够了但没碰到水，不出涟漪 */
const KICK_MISS_P = 0.24;
/** 涟漪 / 水珠池容量（各一个 InstancedMesh） */
const RING_N = 6;
const DROP_N = 16;

interface KickSpot {
  /** 落脚点（水面上，世界坐标） */
  kx: number;
  kz: number;
  /** 水面高度（与 base.ts 铺水洼的 groundYAt + 0.03 一致） */
  waterY: number;
  /** 人行道上的站位与面朝水的朝向 */
  sx: number;
  sz: number;
  groundY: number;
  yaw: number;
  /** 水洼沿路方向的宽度（定涟漪尺度） */
  w: number;
  /** 离原 kids 热点的距离：只沿人行道挪，不越界 */
  moved: number;
}

function makeSpot(axis: 'x' | 'z', edge: number, along: number, side: number, w: number): KickSpot {
  const perpK = edge - side * KICK_EDGE;
  const perpS = edge + side * STAND_EDGE;
  const kx = axis === 'x' ? along : perpK;
  const kz = axis === 'x' ? perpK : along;
  const sx = axis === 'x' ? along : perpS;
  const sz = axis === 'x' ? perpS : along;
  const groundY = groundYAt(sx, sz);
  return {
    kx,
    kz,
    waterY: groundYAt(kx, kz) + 0.03,
    sx,
    sz,
    groundY,
    // 模型面朝局部 +Z：面朝水洼方向
    yaw: Math.atan2(axis === 'z' ? -side : 0, axis === 'x' ? -side : 0),
    w,
    moved: Math.hypot(sx - HOTSPOTS.kids.x, sz - HOTSPOTS.kids.z),
  };
}

/**
 * 从 base.ts 的 PUDDLES 里挑离 HOTSPOTS.kids 最近的**合法**一块：
 *  - 水必须漫过车行道边界（贴人行道边缘，站在路上的孩子才够得着）
 *  - 不许压车队车道 CONVOY_LANE（含 0.8 m 余量），不许落到哨卡缺口带
 * 找不到就退回大道南侧自家路缘（仍然在人行道上，只是水薄一点）。
 */
function pickKickSpot(): KickSpot {
  let best: KickSpot | null = null;
  for (const [px, pz, pw, pd] of PUDDLES) {
    const rx = pw / 2;
    const rz = pd / 2;
    if (px - rx < CONVOY_LANE.x1 + 0.8 && px + rx > CONVOY_LANE.x0 - 0.8) continue;
    for (const r of ROADS) {
      const c = carriageway(r);
      if (px < c.x0 || px > c.x1 || pz < c.z0 || pz > c.z1) continue;
      // 四条边界里挑"水漫出去"最多的那一条
      let past = 0;
      let side = 0;
      let edge = 0;
      for (const sd of [-1, 1] as const) {
        const b = r.axis === 'x' ? (sd < 0 ? c.z0 : c.z1) : sd < 0 ? c.x0 : c.x1;
        const far = r.axis === 'x' ? (sd < 0 ? pz - rz : pz + rz) : sd < 0 ? px - rx : px + rx;
        const over = sd < 0 ? b - far : far - b;
        if (over > past) {
          past = over;
          side = sd;
          edge = b;
        }
      }
      if (past <= 0.2) continue;
      const along = r.axis === 'x' ? px : pz;
      const spot = makeSpot(r.axis, edge, along, side, pw);
      if (isOnCarriageway(spot.sx, spot.sz)) continue; // 站位必须在路缘石里侧
      const g = HOTSPOTS.outpostGap;
      if (spot.sz > g.z - 9 && spot.sz < g.z + 9 && spot.sx > g.x0 && spot.sx < g.x1) continue;
      if (!best || spot.moved < best.moved) best = spot;
    }
  }
  if (best) return best;
  console.warn('people: PUDDLES 里没有够得着的贴路缘积水，小孩退回大道南侧路缘踢水膜');
  const avenue = ROADS.find((r) => r.id === 'avenue');
  const c = avenue ? carriageway(avenue) : null;
  const side = HOTSPOTS.kids.z > 0 ? 1 : -1;
  return makeSpot('x', c ? (side < 0 ? c.z0 : c.z1) : HOTSPOTS.kids.z - side * 1.2, HOTSPOTS.kids.x, side, 3.2);
}

/** 踢水坑的涟漪贴图：两圈软环 + 一圈碎滴，没有任何标识 */
function ringTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 64, (c) => {
    c.clearRect(0, 0, 64, 64);
    c.strokeStyle = 'rgba(255,255,255,0.92)';
    c.lineWidth = 3.2;
    c.beginPath();
    c.arc(32, 32, 23, 0, Math.PI * 2);
    c.stroke();
    c.globalAlpha = 0.45;
    c.lineWidth = 2;
    c.beginPath();
    c.arc(32, 32, 15, 0, Math.PI * 2);
    c.stroke();
    c.globalAlpha = 1;
    c.fillStyle = 'rgba(255,255,255,0.55)';
    for (let i = 0; i < 7; i += 1) {
      const a = (i / 7) * Math.PI * 2 + 0.4;
      c.beginPath();
      c.arc(32 + Math.cos(a) * 28, 32 + Math.sin(a) * 28, 1.5, 0, Math.PI * 2);
      c.fill();
    }
  });
}

interface Ring {
  active: boolean;
  x: number;
  y: number;
  z: number;
  birth: number;
  life: number;
  r0: number;
  gain: number;
}

interface Drop {
  active: boolean;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  birth: number;
  life: number;
  size: number;
}

interface Kicker {
  rig: PersonRig;
  hip: THREE.Group;
  knee: THREE.Group;
  /** 本次踢腿的开始时间（<0 = 不在踢） */
  startAt: number;
  nextAt: number;
  seq: number;
  miss: boolean;
  emitted: boolean;
  /** 静立姿势基准与相位 */
  lean: number;
  armA0: number;
  armB0: number;
  phase: number;
  idleRate: number;
  seed: number;
}

function buildKidsScene(ctx: BuildContext): THREE.Group {
  const rng = ctx.rng.fork(0x51d3);
  const spot = pickKickSpot();
  const scene = group('resident-kids');
  at(scene, spot.sx, spot.groundY, spot.sz);
  scene.rotation.y = spot.yaw; // 面朝水洼

  // 落脚点换算到 scene 局部（局部 +Z 朝水）
  const ddx = spot.kx - spot.sx;
  const ddz = spot.kz - spot.sz;
  const cy = Math.cos(spot.yaw);
  const sy = Math.sin(spot.yaw);
  const kick = { x: ddx * cy - ddz * sy, z: ddx * sy + ddz * cy, y: spot.waterY + 0.02 - spot.groundY };
  const ringMax = Math.min(1.05, Math.max(0.5, spot.w * 0.15));

  /* —— 小一点的孩子（1.2m）：厚外套 + 红围巾，抬腿前踢 —— */
  const small = buildPerson({
    height: 1.2,
    hipY: 0.62,
    shoulderW: 0.29,
    depth: 0.21,
    coat: MAT.coatGrey,
    pants: MAT.pants,
    hat: MAT.scarfRed,
    hatKind: 'scarf',
    armLen: 0.26,
    armRadius: 0.04,
    legs: 'kick',
    swingSide: 1,
  });
  withOutline(small.root);
  small.root.position.set(0.34, 0, 0.02);
  small.root.rotation.y = 0.16;
  small.torso.rotation.x = 0.12;
  small.head.rotation.x = 0.16;
  small.armA.rotation.x = -0.24;
  small.armA.rotation.z = 0.2;
  small.armB.rotation.x = -0.16;
  small.armB.rotation.z = -0.14;
  scene.add(small.root);
  if (small.swingHip) small.root.add(small.swingHip);

  /* —— 高一点的孩子（1.35m）：橄榄色外套 + 毛线帽，手里还攥着那根小棍 —— */
  const tall = buildPerson({
    height: 1.35,
    hipY: 0.67,
    shoulderW: 0.3,
    depth: 0.21,
    coat: MAT.coatOlive,
    pants: MAT.pants,
    hat: MAT.beanieOlive,
    hatKind: 'beanie',
    armLen: 0.28,
    armRadius: 0.042,
    legs: 'kick',
    swingSide: -1,
  });
  withOutline(tall.root);
  tall.root.position.set(-0.36, 0, -0.06);
  tall.root.rotation.y = -0.2;
  tall.torso.rotation.x = 0.1;
  tall.head.rotation.x = 0.14;
  tall.armA.rotation.x = -0.2;
  tall.armA.rotation.z = 0.16;
  tall.armB.rotation.x = -0.3;
  tall.armB.rotation.z = -0.12;
  scene.add(tall.root);
  if (tall.swingHip) tall.root.add(tall.swingHip);

  // 小棍跟着手臂抬起来（棍尖不再点地，免得踢腿时插进路面）
  const stick = cyl(0.013, 0.011, 0.68, 6, MAT.woodDark);
  at(stick, 0, -0.71, 0.03);
  stick.rotation.x = 0.18;
  tall.armB.add(stick);

  /* —— 地面的沙土划痕与石子（玩石子留下的痕迹，保留） —— */
  const marks: THREE.Mesh[] = [];
  for (let i = 0; i < 6; i += 1) {
    const line = box(0.04, 0.006, 0.16 + (i % 3) * 0.06, MAT.groundMark);
    at(line, -0.12 + i * 0.05, 0.004, -0.18 + (i % 2) * 0.07, 0.6 + i * 0.4);
    line.castShadow = false;
    marks.push(line);
  }
  const scribble = mergeMeshes(marks, MAT.groundMark);
  if (scribble) scene.add(scribble);

  const pebbles: THREE.Mesh[] = [];
  for (let i = 0; i < 7; i += 1) {
    const pebble = sphere(0.038, MAT.stone, 6);
    pebble.scale.set(1, 0.72, 1.1);
    at(pebble, -0.16 + i * 0.045, 0.028 + (i > 4 ? 0.05 : 0), -0.22 + (i % 3) * 0.05, i * 0.7);
    pebbles.push(pebble);
  }
  const stones = mergeMeshes(pebbles, MAT.stone);
  if (stones) scene.add(stones);

  /* —— 涟漪 + 水珠：两个实例化池，各 1 mesh / 1 draw call —— */
  const ringMat = new THREE.MeshBasicMaterial({
    map: ringTexture(),
    color: 0x9fc2da,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: true,
  });
  const ringGeo = new THREE.PlaneGeometry(1, 1);
  ringGeo.rotateX(-Math.PI / 2);
  const hiddenOf = (n: number): InstanceTransform[] => {
    const list: InstanceTransform[] = [];
    for (let i = 0; i < n; i += 1) {
      list.push({
        position: new THREE.Vector3(0, -40, 0),
        rotation: new THREE.Euler(),
        scale: new THREE.Vector3(0.0001, 0.0001, 0.0001),
      });
    }
    return list;
  };
  const ringInst = instanced(ringGeo, ringMat, hiddenOf(RING_N));
  ringInst.name = 'kids-puddle-ripple';
  ringInst.castShadow = false;
  ringInst.receiveShadow = false;
  ringInst.frustumCulled = false;
  scene.add(ringInst);

  const dropMat = new THREE.MeshBasicMaterial({
    color: 0xbdd6e8,
    transparent: true,
    opacity: 0.62,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: true,
  });
  // 水珠用真正的小球：不受朝向影响，侧看也不会消失
  const dropGeo = new THREE.SphereGeometry(0.5, 6, 4);
  const dropInst = instanced(dropGeo, dropMat, hiddenOf(DROP_N));
  dropInst.name = 'kids-water-beads';
  dropInst.castShadow = false;
  dropInst.receiveShadow = false;
  dropInst.frustumCulled = false;
  scene.add(dropInst);

  const black = new THREE.Color(0, 0, 0);
  for (let i = 0; i < RING_N; i += 1) ringInst.setColorAt(i, black);
  for (let i = 0; i < DROP_N; i += 1) dropInst.setColorAt(i, black);

  const rings: Ring[] = [];
  for (let i = 0; i < RING_N; i += 1) {
    rings.push({ active: false, x: 0, y: 0, z: 0, birth: 0, life: 0.5, r0: 0.2, gain: 1 });
  }
  const drops: Drop[] = [];
  for (let i = 0; i < DROP_N; i += 1) {
    drops.push({ active: false, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, birth: 0, life: 0.4, size: 0.04 });
  }
  let ringCursor = 0;
  let dropCursor = 0;

  const kickers: Kicker[] = [];
  const addKicker = (rig: PersonRig, first: number, seed: number): void => {
    const hip = rig.swingHip;
    const knee = rig.swingKnee;
    if (!hip || !knee) return;
    kickers.push({
      rig,
      hip,
      knee,
      startAt: -1,
      nextAt: first,
      seq: 0,
      miss: false,
      emitted: false,
      lean: rig.torso.rotation.x,
      armA0: rig.armA.rotation.z,
      armB0: rig.armB.rotation.x,
      phase: rng.range(0, 6.28),
      idleRate: rng.range(0.5, 0.8),
      seed,
    });
  };
  // 先手 A 在 1.1 s 起脚，后手 B 在 2.5 s 接踢（错开 1.4 s）
  addKicker(small, 1.1, rng.range(0, 400));
  addKicker(tall, 2.5, rng.range(0, 400));

  const splash = (seq: number, t: number): void => {
    for (let i = 0; i < 2; i += 1) {
      const r = rings[ringCursor] as Ring;
      ringCursor = (ringCursor + 1) % RING_N;
      r.active = true;
      r.x = kick.x + (hashNoise(seq * 2.31 + i * 5.13) - 0.5) * 0.32;
      r.z = kick.z + (hashNoise(seq * 3.77 + i * 7.31) - 0.5) * 0.18;
      r.y = kick.y + i * 0.006;
      r.birth = t + i * 0.12;
      r.life = 0.5 + i * 0.34 + hashNoise(seq * 1.7 + i) * 0.16;
      r.r0 = i === 0 ? 0.18 : 0.42;
      r.gain = i === 0 ? 1 : 0.68;
    }
    const n = 5 + Math.round(hashNoise(seq * 5.71) * 3);
    for (let i = 0; i < n; i += 1) {
      const d = drops[dropCursor] as Drop;
      dropCursor = (dropCursor + 1) % DROP_N;
      const a = hashNoise(seq * 9.13 + i * 2.71) * Math.PI * 2;
      const sp = 0.3 + hashNoise(seq * 4.19 + i * 6.77) * 0.5;
      d.active = true;
      d.px = kick.x;
      d.py = kick.y + 0.03;
      d.pz = kick.z;
      d.vx = Math.cos(a) * sp;
      d.vz = Math.sin(a) * sp * 0.7 + 0.25;
      d.vy = 1.9 + hashNoise(seq * 7.31 + i * 3.11) * 1.25;
      d.birth = t + hashNoise(seq * 2.17 + i * 8.77) * 0.05;
      d.life = 0.4 + hashNoise(seq * 6.11 + i * 1.7) * 0.22;
      d.size = 0.03 + hashNoise(seq + i * 4.13) * 0.045;
    }
  };

  const scratchM = new THREE.Matrix4();
  const scratchQ = new THREE.Quaternion();
  const scratchE = new THREE.Euler();
  const scratchP = new THREE.Vector3();
  const scratchS = new THREE.Vector3();
  const scratchC = new THREE.Color();

  ctx.ticker.add((t) => {
    let ringDirty = false;
    let dropDirty = false;

    /* —— 踢腿：抬腿 0.33 s（碰水）→ 落回 0.77 s，节奏错开、偶尔落空 —— */
    for (const k of kickers) {
      if (k.startAt < 0 && t >= k.nextAt) {
        k.startAt = t;
        k.seq += 1;
        k.emitted = false;
        k.miss = hashNoise(k.seed + k.seq * 3.77) < KICK_MISS_P;
      }
      let e = 0;
      if (k.startAt >= 0) {
        const since = t - k.startAt;
        if (since >= KICK_MOVE) {
          k.startAt = -1;
          const dbl = hashNoise(k.seed + k.seq * 1.31) < KICK_DOUBLE_P;
          k.nextAt = t + (dbl ? KICK_DOUBLE_WAIT : KICK_WAIT + hashNoise(k.seed + k.seq * 7.19) * KICK_WAIT_JITTER);
        } else {
          const q = since / KICK_MOVE;
          const u = q / 0.3;
          e = q < 0.3 ? u * u * (3 - 2 * u) : Math.max(0, 1 - (q - 0.3) / 0.7);
          if (!k.emitted && since >= KICK_CONTACT) {
            k.emitted = true;
            if (!k.miss) splash(k.seq, t);
          }
        }
      }
      const reach = k.miss ? 0.55 : 1;
      const amp = e * reach;
      k.hip.rotation.x = -1.38 * amp;
      // 膝：起手时先屈、踢出时蹬直（摆动腿只能往后弯）
      k.knee.rotation.x = 0.05 + 0.62 * (1 - amp);
      k.rig.torso.rotation.x = k.lean - 0.34 * amp;
      k.rig.torso.rotation.z = 0.1 * amp;
      k.rig.armA.rotation.z = k.armA0 + 0.72 * amp;
      k.rig.armB.rotation.x = k.armB0 - 0.6 * amp;
      k.rig.head.rotation.x = 0.16 + 0.24 * amp;
      k.rig.root.position.y = 0.014 * amp;
      k.rig.root.rotation.z = -0.085 * amp;
      // 不踢的时候缓慢回头看同伴
      const idle = 1 - Math.min(1, amp * 2.2);
      k.rig.head.rotation.y = Math.sin(t * k.idleRate + k.phase) * 0.5 * idle;
      k.rig.torso.rotation.y = Math.sin(t * 0.34 + k.phase) * 0.07 * idle;
    }

    /* —— 涟漪：一圈扩出去的软环，加色斑淡去 —— */
    for (let i = 0; i < RING_N; i += 1) {
      const r = rings[i] as Ring;
      if (!r.active) continue;
      const k = (t - r.birth) / r.life;
      if (k < 0) continue;
      if (k >= 1) {
        r.active = false;
        scratchM.makeScale(0.0001, 0.0001, 0.0001);
        ringInst.setMatrixAt(i, scratchM);
        ringInst.setColorAt(i, scratchC.setRGB(0, 0, 0));
        ringDirty = true;
        continue;
      }
      const sc = r.r0 + k * ringMax;
      scratchE.set(0, 0, 0);
      scratchQ.setFromEuler(scratchE);
      scratchP.set(r.x, r.y, r.z);
      scratchS.set(sc, 1, sc * 0.9);
      scratchM.compose(scratchP, scratchQ, scratchS);
      ringInst.setMatrixAt(i, scratchM);
      const g = Math.pow(1 - k, 1.5) * r.gain;
      ringInst.setColorAt(i, scratchC.setRGB(0.5 * g, 0.68 * g, 0.86 * g));
      ringDirty = true;
    }

    /* —— 水珠：抛物线（解析式，不吃 dt）+ 越升越暗 —— */
    for (let i = 0; i < DROP_N; i += 1) {
      const d = drops[i] as Drop;
      if (!d.active) continue;
      const k = (t - d.birth) / d.life;
      if (k < 0) continue;
      if (k >= 1) {
        d.active = false;
        scratchM.makeScale(0.0001, 0.0001, 0.0001);
        dropInst.setMatrixAt(i, scratchM);
        dropInst.setColorAt(i, scratchC.setRGB(0, 0, 0));
        dropDirty = true;
        continue;
      }
      const s = k * d.life;
      scratchP.set(
        d.px + d.vx * s,
        d.py + d.vy * s - 4.6 * s * s,
        d.pz + d.vz * s,
      );
      const sc = d.size * (1 - k * 0.35);
      scratchS.set(sc, sc, sc);
      scratchM.compose(scratchP, scratchQ, scratchS);
      dropInst.setMatrixAt(i, scratchM);
      const g = Math.pow(1 - k, 1.15);
      dropInst.setColorAt(i, scratchC.setRGB(0.42 * g, 0.58 * g, 0.76 * g));
      dropDirty = true;
    }

    if (ringDirty) {
      ringInst.instanceMatrix.needsUpdate = true;
      if (ringInst.instanceColor) ringInst.instanceColor.needsUpdate = true;
    }
    if (dropDirty) {
      dropInst.instanceMatrix.needsUpdate = true;
      if (dropInst.instanceColor) dropInst.instanceColor.needsUpdate = true;
    }
  });

  return scene;
}

/** 幸存居民：三人 + 生活痕迹道具。 */
export function buildPeople(ctx: BuildContext): THREE.Group {
  const root = group('people');
  root.add(buildCookScene(ctx));
  root.add(buildOldWomanScene(ctx));
  root.add(buildKidsScene(ctx));
  return root;
}
