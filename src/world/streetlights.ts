import * as THREE from 'three';
import type { BuildContext } from '../core/context';
import { hashNoise, mergeMeshes } from '../core/geo';
import { canvasTexture, glowMaterial, outlineMaterial, registerNightGlow, toonMaterial } from '../core/materials';
import { GLOW, PALETTE } from '../core/palette';
import { coneAlphaTexture } from '../fx/lightCone';
import { spillTexture } from '../fx/spill';
import { PUDDLES } from './base';
import { ROAD, groundYAt } from './layout';
import { planStreetlights, type LampSpec } from './streetlightPlan';

/**
 * 全图道路路灯。
 *
 * 渲染结构（灯杆/灯罩/灯臂合成一套几何，按状态分成几组实例）：
 *  - lamp-poles：所有路灯的杆、基座、弯臂、灯罩，一个 InstancedMesh；
 *  - lamp-outline：同一批实例矩阵的反向外扩描边（三渲二轮廓）；
 *  - lamp-lens-intact / -flicker / -burnt：灯罩下的发光面，故障灯可独立闪烁，
 *    倒地灯的灯面换成熏黑材质；
 *  - lamp-cones：所有完好灯的光柱，一张 InstancedMesh + 自发光加色材质；
 *  - lamp-pools：灯下柔光池，按光束落点摊开，斜灯的光斑会顺着倒向拉长；
 *  - lamp-halos：灯头广告牌光晕，远处也能一眼看出这盏灯亮着；
 *  - lamp-halo-glow：灯头外围更大更淡的空气辉光，负责把光源"晕"进雾里；
 *  - lamp-spills：湿路面上的暖色拉长反光，一张 InstancedMesh；
 *  - lamp-rubble / lamp-spark：倒在地上的灯头周围的碎石与短路火花。
 *
 * 真实光源只开 11 盏（3 盏带阴影的 SpotLight + 5 盏补光 SpotLight + 3 盏近灯
 * 点补光），按"视线焦点"动态分配给附近的路灯；远处灯只靠自发光、光柱、光池
 * 与灯晕。这样全图 76 盏灯也不会把点光预算打满。倒地灯不参与灯池，个别灯头
 * 保留冷蓝/暗红短路闪烁。
 */

const LENS_LOCAL = new THREE.Vector3(0, 5.7, 1.58);
const DOWN_LOCAL = new THREE.Vector3(0, -1, 0);
const SIDEWALK_TOP = ROAD.curbHeight;

/**
 * 倒地灯杆的水平轴高度：杆身最低点刚好压在人行道面上（0.222 m），
 * 基座与灯罩按"半埋进地面"处理；再往下就会让杆身明显穿地。
 */
const FALLEN_AXIS_Y = SIDEWALK_TOP + 0.145;

/** 路灯真实光源：老式钠灯的暖黄，比窗光的 0xffc98a 更橙一点 */
const LAMP_LIGHT = 0xffb066;
const SHADOW_LIGHTS = 3;
const FILL_LIGHTS = 5;
const POINT_FILL_LIGHTS = 3;
/** 相机离视焦超过这个距离时，真实点光对画面已无贡献，整组关掉 */
const LIGHT_RANGE = 135;

let viewer: THREE.Camera | null = null;
let shadowDirty = false;

export function setStreetlightViewer(camera: THREE.Camera): void {
  viewer = camera;
}

/** 主循环取一次：为 true 时重新烘一次阴影贴图（灯池换位/开关） */
export function consumeStreetlightShadowDirty(): boolean {
  const value = shadowDirty;
  shadowDirty = false;
  return value;
}

interface LampRuntime {
  spec: LampSpec;
  matrix: THREE.Matrix4;
  quat: THREE.Quaternion;
  /** 灯罩下发光面的世界坐标 */
  lens: THREE.Vector3;
  /** 灯罩朝向（局部 -Y 转到世界） */
  down: THREE.Vector3;
  flickerSeed: number;
}

/* ------------------------------------------------------------------ *
 * 几何
 * ------------------------------------------------------------------ */

/**
 * 旧式工业路灯：细长锥形杆 + 向上弯的灯臂 + 向下张开的铸铁灯罩。
 * 全部零件按同一材质合并成一份几何，所有路灯共用（实例化）。
 */
function poleGeometry(): THREE.BufferGeometry {
  const parts: THREE.Mesh[] = [];
  const mat = new THREE.MeshBasicMaterial();
  const add = (
    geometry: THREE.BufferGeometry,
    x = 0,
    y = 0,
    z = 0,
    rx = 0,
    ry = 0,
    rz = 0,
  ): void => {
    const part = new THREE.Mesh(geometry, mat);
    part.position.set(x, y, z);
    part.rotation.set(rx, ry, rz);
    parts.push(part);
  };

  // 基座：两级铸铁裙边，底座半径 0.30 —— 立在人行道内缘不会压到路缘石
  add(new THREE.CylinderGeometry(0.2, 0.3, 0.34, 10), 0, 0.17, 0);
  add(new THREE.CylinderGeometry(0.15, 0.22, 0.09, 10), 0, 0.365, 0);
  // 锥形立杆：下粗上细
  add(new THREE.CylinderGeometry(0.055, 0.12, 5.23, 8), 0, 2.9, 0);
  // 杆身箍环与检修门
  add(new THREE.CylinderGeometry(0.1, 0.125, 0.07, 8), 0, 1.18, 0);
  add(new THREE.CylinderGeometry(0.075, 0.082, 0.06, 8), 0, 4.55, 0);
  add(new THREE.BoxGeometry(0.17, 0.46, 0.06), 0, 0.8, 0.09);
  // 弯臂：先向上拱起再向车道方向探出
  const arm = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 5.43, 0),
    new THREE.Vector3(0, 5.95, 0.34),
    new THREE.Vector3(0, 6.06, 0.95),
    new THREE.Vector3(0, 5.96, 1.43),
  ]);
  add(new THREE.TubeGeometry(arm, 12, 0.052, 5, false));
  // 灯罩：上小下大的开口锥筒，微微向车道方向低头
  add(new THREE.CylinderGeometry(0.13, 0.4, 0.27, 10, 1, true), 0, 5.88, 1.52, -0.12);
  add(new THREE.CylinderGeometry(0.4, 0.43, 0.05, 10, 1, true), 0, 5.75, 1.54, -0.12);
  add(new THREE.CylinderGeometry(0.14, 0.14, 0.055, 10), 0, 6.01, 1.52, -0.12);
  add(new THREE.SphereGeometry(0.055, 8, 6), 0, 6.09, 1.5);

  const merged = mergeMeshes(parts, mat);
  for (const part of parts) part.geometry.dispose();
  mat.dispose();
  if (!merged) throw new Error('streetlights: 路灯几何合并失败');
  return merged.geometry;
}

/** 灯罩发光面：灯泡 + 磨砂底盘 */
function lensGeometry(): THREE.BufferGeometry {
  const parts: THREE.Mesh[] = [];
  const mat = new THREE.MeshBasicMaterial();
  const globe = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), mat);
  globe.position.copy(LENS_LOCAL);
  parts.push(globe);
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.018, 12), mat);
  disc.position.set(0, 5.735, 1.58);
  parts.push(disc);
  const merged = mergeMeshes(parts, mat);
  for (const part of parts) part.geometry.dispose();
  mat.dispose();
  if (!merged) throw new Error('streetlights: 灯面几何合并失败');
  return merged.geometry;
}

/* ------------------------------------------------------------------ *
 * 实例化工具
 * ------------------------------------------------------------------ */

/** 贴地光池的柔光斑：中心暖、边缘干净地退到 0，叠在湿路面上读作灯下亮区 */
function poolTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.82)');
    g.addColorStop(0.34, 'rgba(255,255,255,0.46)');
    g.addColorStop(0.68, 'rgba(255,255,255,0.14)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  });
}

/** 灯头光晕：中心实、边缘迅速散开的柔光斑，叠在灯罩位置当"这一盏真的亮着"的锚点 */
function haloTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 64, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.16, 'rgba(255,255,255,0.78)');
    g.addColorStop(0.42, 'rgba(255,255,255,0.22)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  });
}

/** 灯头外围的大范围空气辉光：给光源一层很淡的"照亮了雾"的外晕 */
function haloWideTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 64, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.42)');
    g.addColorStop(0.28, 'rgba(255,255,255,0.24)');
    g.addColorStop(0.58, 'rgba(255,255,255,0.08)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  });
}

/** 屏幕对齐广告牌：只取实例矩阵的平移与缩放，扔掉旋转，四边始终正对相机 */
function applyHaloBillboard(mat: THREE.MeshBasicMaterial, lift: number): void {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      /* glsl */ `
      vec4 haloCenter = modelViewMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
      // 往相机方向抬一小段：灯罩球体会挡住正中心的广告牌，抬出来才是"光晕"而不是一圈边
      haloCenter.xyz += normalize( -haloCenter.xyz ) * ${lift.toFixed(2)};
      float haloScale = length( instanceMatrix[ 0 ].xyz );
      vec4 mvPosition = haloCenter;
      mvPosition.xy += position.xy * haloScale;
      gl_Position = projectionMatrix * mvPosition;
      `,
    );
  };
  mat.customProgramCacheKey = () => `lamp-halo-instanced-${lift}`;
}

/** 灯罩朝向与地面的交点：倾斜灯的地面光斑必须落在光束落点，而不是杆脚 */
function lampGroundHit(lamp: LampRuntime): THREE.Vector3 {
  const denom = Math.max(0.2, -lamp.down.y);
  const base = groundYAt(lamp.lens.x, lamp.lens.z);
  // 80° 侧倒时解析交点会跑到几十米外；限长和光锥采用同一尺度，避免光斑飞进楼里
  const t = Math.min((lamp.lens.y - base) / denom, 12);
  const hit = lamp.lens.clone().addScaledVector(lamp.down, t);
  hit.y = groundYAt(hit.x, hit.z);
  return hit;
}

/** 聚光按"灯头沿光束到地面"的距离平方归一：斜灯的光程和立灯差不多，不该被压得太狠 */
function lampSpotScale(lamp: LampRuntime): number {
  const ground = groundYAt(lamp.lens.x, lamp.lens.z);
  const rayLength = Math.min(
    (lamp.lens.y - ground) / Math.max(0.2, -lamp.down.y),
    12,
  );
  return THREE.MathUtils.clamp((rayLength / 5.9) ** 2, 0.3, 1);
}

/** 近灯点补光挂在灯头下方，斜灯会离地很近，单独按它的离地高度压强度 */
function lampPointScale(lamp: LampRuntime): number {
  const ground = groundYAt(lamp.lens.x, lamp.lens.z);
  const headHeight = Math.max(1.2, lamp.lens.y - ground);
  return THREE.MathUtils.clamp((headHeight / 5.9) ** 2, 0.08, 1);
}

interface InstanceEntry {
  matrix: THREE.Matrix4;
  color?: THREE.Color;
}

function makeInstanced(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  entries: InstanceEntry[],
  name: string,
  castShadow = false,
  receiveShadow = false,
): THREE.InstancedMesh {
  const meshInst = new THREE.InstancedMesh(geometry, material, Math.max(1, entries.length));
  meshInst.count = entries.length;
  entries.forEach((entry, i) => {
    meshInst.setMatrixAt(i, entry.matrix);
    if (entry.color) meshInst.setColorAt(i, entry.color);
  });
  meshInst.instanceMatrix.needsUpdate = true;
  if (meshInst.instanceColor) meshInst.instanceColor.needsUpdate = true;
  meshInst.castShadow = castShadow;
  meshInst.receiveShadow = receiveShadow;
  meshInst.name = name;
  meshInst.computeBoundingSphere();
  return meshInst;
}

/* ------------------------------------------------------------------ *
 * 组装
 * ------------------------------------------------------------------ */

export function buildStreetlights(ctx: BuildContext): THREE.Group {
  const root = new THREE.Group();
  root.name = 'lamp-network';
  const rng = ctx.rng.fork(9107);
  const plan = planStreetlights(rng.fork(1));
  const visualRng = rng.fork(2);

  const poleGeo = poleGeometry();
  const lensGeo = lensGeometry();

  const poleMat = new THREE.MeshStandardMaterial({
    color: 0x565d64,
    roughness: 0.58,
    metalness: 0.38,
    emissive: 0x04060a,
    emissiveIntensity: 0.7,
  });
  // 灯面走项目统一的 glowMaterial（自发光 + 夜间登记表），而不是 MeshStandard.emissive：
  // 这样灯面、光柱、反光条会被昼夜装置一起压到白天待机，夜里一起起辉光。
  const intactLensMat = glowMaterial(GLOW.lamp, 0.95);
  const flickerLensMat = glowMaterial(GLOW.lamp, 0.95);
  const burntLensMat = new THREE.MeshStandardMaterial({
    color: 0x17140f,
    roughness: 0.96,
    metalness: 0.12,
    emissive: 0x060300,
    emissiveIntensity: 0.6,
  });

  const runtime: LampRuntime[] = [];
  const poleEntries: InstanceEntry[] = [];
  const quatX = new THREE.Quaternion();
  const quatZ = new THREE.Quaternion();
  const quatYaw = new THREE.Quaternion();
  const axisX = new THREE.Vector3(1, 0, 0);
  const axisZ = new THREE.Vector3(0, 0, 1);
  const axisY = new THREE.Vector3(0, 1, 0);
  const unit = new THREE.Vector3(1, 1, 1);
  const poleColor = new THREE.Color();

  for (const spec of plan) {
    const nearPuddle =
      spec.state === 'fallen' &&
      PUDDLES.some(
        ([px, pz, w, d]) =>
          Math.abs(spec.x - px) < w * 0.5 + 1.4 && Math.abs(spec.z - pz) < d * 0.5 + 1,
      );

    // 姿态：先按灯臂朝向转，再按损坏类型绕局部轴倒
    quatYaw.setFromAxisAngle(axisY, spec.yaw);
    const quat = quatYaw.clone();
    if (spec.state === 'fallen') {
      // 绕灯臂方向转 90°：杆身沿街平躺，灯头落进车行道边缘
      quatZ.setFromAxisAngle(axisZ, spec.rollSign * (Math.PI / 2));
      quat.multiply(quatZ);
    } else if (spec.fall === 'along') {
      // 沿街侧倒：杆身压在 sidewalk 上，不朝临街立面倒
      quatZ.setFromAxisAngle(axisZ, spec.rollSign * spec.tilt);
      quat.multiply(quatZ);
    } else {
      // 向车行道倾倒（或完好灯的微小歪斜）
      quatX.setFromAxisAngle(axisX, spec.tilt);
      quat.multiply(quatX);
    }

    const y = spec.state === 'fallen' ? FALLEN_AXIS_Y - (nearPuddle ? 0.045 : 0) : spec.baseY;
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(spec.x, y, spec.z),
      quat,
      unit,
    );

    const lens = LENS_LOCAL.clone().applyMatrix4(matrix);
    const down = DOWN_LOCAL.clone().applyQuaternion(quat);
    const item: LampRuntime = {
      spec,
      matrix,
      quat,
      lens,
      down,
      flickerSeed: visualRng.range(0, 12),
    };
    runtime.push(item);

    // 杆身颜色：倒地灯熏黑，其余做旧程度略有差异
    if (spec.state === 'fallen') {
      poleColor.setRGB(0.52, 0.49, 0.45);
    } else {
      const v = visualRng.range(0.82, 1.02);
      poleColor.setRGB(v, v, v);
    }
    poleEntries.push({ matrix, color: poleColor.clone() });
  }

  const poleMesh = makeInstanced(poleGeo, poleMat, poleEntries, 'lamp-poles', true, true);
  root.add(poleMesh);

  // 描边外壳：同一实例矩阵，反向外扩，跟随后期外描边颜色
  const outlineMesh = makeInstanced(
    poleGeo,
    outlineMaterial(0.0032),
    poleEntries.map((entry) => ({ matrix: entry.matrix })),
    'lamp-outline',
    false,
    false,
  );
  outlineMesh.renderOrder = -1;
  root.add(outlineMesh);

  const intact: LampRuntime[] = [];
  const flickers: LampRuntime[] = [];
  const fallen: LampRuntime[] = [];
  for (const lamp of runtime) {
    if (lamp.spec.state === 'fallen') fallen.push(lamp);
    else if (lamp.spec.state === 'flicker') flickers.push(lamp);
    else intact.push(lamp);
  }

  const white = new THREE.Color(1, 1, 1);
  const lensEntry = (lamp: LampRuntime, color?: THREE.Color): InstanceEntry => ({
    matrix: lamp.matrix,
    color,
  });

  const intactLens = makeInstanced(
    lensGeo,
    intactLensMat,
    intact.map((lamp) => lensEntry(lamp, white)),
    'lamp-lens-intact',
  );
  root.add(intactLens);

  const flickerLens = makeInstanced(
    lensGeo,
    flickerLensMat,
    flickers.map((lamp) => lensEntry(lamp, new THREE.Color(0.75, 0.75, 0.75))),
    'lamp-lens-flicker',
  );
  root.add(flickerLens);

  const burntLens = makeInstanced(
    lensGeo,
    burntLensMat,
    fallen.map((lamp) => lensEntry(lamp)),
    'lamp-lens-burnt',
  );
  root.add(burntLens);

  /* ---------- 光柱：一张实例化圆锥 ---------- */

  const coneMat = instancedConeMaterial();
  const coneGeo = new THREE.ConeGeometry(1, 1, 14, 1, true);
  coneGeo.translate(0, -0.5, 0);
  const coneEntries: InstanceEntry[] = [];
  for (const lamp of runtime) {
    if (lamp.spec.state === 'fallen' || lamp.spec.state === 'flicker') continue;
    const ground = groundYAt(lamp.lens.x, lamp.lens.z);
    const len = THREE.MathUtils.clamp(
      (lamp.lens.y - ground + 0.12) / Math.max(0.18, -lamp.down.y),
      2.4,
      9,
    );
    const radius = THREE.MathUtils.clamp(len * 0.55, 1.4, 3.4);
    const pos = lamp.lens.clone().addScaledVector(lamp.down, 0.08);
    const matrix = new THREE.Matrix4().compose(
      pos,
      lamp.quat,
      new THREE.Vector3(radius, len, radius),
    );
    // 斜灯的锥体几乎横躺，贴近看会变成一张硬边光片；让真实聚光灯去交代光池，锥体只留一丝
    const beam = Math.hypot(lamp.down.x, lamp.down.z);
    const v = (0.62 + visualRng.next() * 0.38) * (1 - Math.min(1, beam) * 0.78);
    coneEntries.push({ matrix, color: new THREE.Color(v, v, v) });
  }
  const cones = makeInstanced(
    coneGeo,
    coneMat,
    coneEntries,
    'lamp-cones',
    false,
    false,
  );
  cones.renderOrder = 3;
  root.add(cones);

  /* ---------- 灯下光池：所有完好灯都有，补足远处路网的“被照亮”读数 ---------- */

  const poolMat = new THREE.MeshBasicMaterial({
    map: poolTexture(),
    color: LAMP_LIGHT,
    transparent: true,
    opacity: 0.16,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  registerNightGlow(poolMat);
  const poolGeo = new THREE.PlaneGeometry(1, 1);
  poolGeo.rotateX(-Math.PI / 2);
  const poolEntries: InstanceEntry[] = [];
  const poolIndex = new Map<number, number>();
  for (const lamp of runtime) {
    if (lamp.spec.state === 'fallen') continue;
    const hit = lampGroundHit(lamp);
    const along = lamp.spec.axis === 'x' ? Math.PI / 2 : 0;
    const beam = Math.hypot(lamp.down.x, lamp.down.z);
    // 立灯的椭圆顺着街走；斜灯顺着光打出去的方向摊开
    const yaw = beam > 0.18 ? Math.atan2(lamp.down.x, lamp.down.z) : along;
    const q = new THREE.Quaternion().setFromAxisAngle(axisY, yaw);
    const width = 6.2 + visualRng.range(0, 1.8);
    const stretch = 1 + Math.min(1, beam) * 0.45;
    const len = (10.5 + visualRng.range(0, 3)) * stretch;
    const y = Math.max(0.155, hit.y + 0.035);
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(hit.x, y, hit.z),
      q,
      new THREE.Vector3(width, 1, len),
    );
    const v = 0.62 + visualRng.next() * 0.38;
    poolIndex.set(lamp.spec.index, poolEntries.length);
    poolEntries.push({ matrix, color: new THREE.Color(v, v, v) });
  }
  const pools = makeInstanced(
    poolGeo,
    poolMat,
    poolEntries,
    'lamp-pools',
    false,
    false,
  );
  pools.renderOrder = 4;
  root.add(pools);

  /* ---------- 灯头光晕：每盏亮着的灯都有一个可见的暖色光点 ---------- */

  const haloMat = new THREE.MeshBasicMaterial({
    map: haloTexture(),
    // 灯芯是 HDR：亮度越过泛光阈值，灯头才会真的把光晕开进空气里
    color: new THREE.Color(LAMP_LIGHT).multiplyScalar(2.6),
    transparent: true,
    opacity: 0.44,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  applyHaloBillboard(haloMat, 0.32);
  registerNightGlow(haloMat);
  const haloGeo = new THREE.PlaneGeometry(1, 1);
  const haloEntries: InstanceEntry[] = [];
  const haloIndex = new Map<number, number>();
  for (const lamp of runtime) {
    if (lamp.spec.state === 'fallen') continue;
    const size = 0.86 + visualRng.range(0, 0.42);
    const matrix = new THREE.Matrix4().compose(
      lamp.lens,
      new THREE.Quaternion(),
      new THREE.Vector3(size, size, size),
    );
    haloIndex.set(lamp.spec.index, haloEntries.length);
    haloEntries.push({
      matrix,
      color: lamp.spec.state === 'flicker' ? new THREE.Color(0.72, 0.72, 0.72) : undefined,
    });
  }
  const halos = makeInstanced(haloGeo, haloMat, haloEntries, 'lamp-halos', false, false);
  halos.renderOrder = 6;
  root.add(halos);

  const wideHaloMat = new THREE.MeshBasicMaterial({
    map: haloWideTexture(),
    color: new THREE.Color(LAMP_LIGHT).multiplyScalar(1.35),
    transparent: true,
    opacity: 0.22,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  applyHaloBillboard(wideHaloMat, 0.5);
  registerNightGlow(wideHaloMat);
  const wideHaloEntries: InstanceEntry[] = [];
  for (const lamp of runtime) {
    if (lamp.spec.state === 'fallen') continue;
    const size = 2.4 + visualRng.range(0, 1);
    wideHaloEntries.push({
      matrix: new THREE.Matrix4().compose(
        lamp.lens,
        new THREE.Quaternion(),
        new THREE.Vector3(size, size, size),
      ),
      color: lamp.spec.state === 'flicker' ? new THREE.Color(0.6, 0.6, 0.6) : undefined,
    });
  }
  const wideHalos = makeInstanced(
    haloGeo,
    wideHaloMat,
    wideHaloEntries,
    'lamp-halo-glow',
    false,
    false,
  );
  wideHalos.renderOrder = 5;
  root.add(wideHalos);

  /* ---------- 湿地反光：一张实例化贴地光斑 ---------- */

  const spillMat = new THREE.MeshBasicMaterial({
    map: spillTexture(),
    color: LAMP_LIGHT,
    transparent: true,
    opacity: 0.28,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  registerNightGlow(spillMat);
  const spillGeo = new THREE.PlaneGeometry(1, 1);
  spillGeo.rotateX(-Math.PI / 2);
  const spillEntries: InstanceEntry[] = [];
  const spillIndex = new Map<number, number>();
  for (const lamp of runtime) {
    if (lamp.spec.state === 'fallen') continue;
    const hit = lampGroundHit(lamp);
    const along = lamp.spec.axis === 'x' ? Math.PI / 2 : 0;
    const beam = Math.hypot(lamp.down.x, lamp.down.z);
    const yaw = beam > 0.18 ? Math.atan2(lamp.down.x, lamp.down.z) : along;
    const q = new THREE.Quaternion().setFromAxisAngle(axisY, yaw);
    const width = 2.8 + visualRng.range(0, 1.1);
    const len = (12 + visualRng.range(0, 4)) * (1 + beam * 0.25);
    const y = Math.max(0.145, hit.y + 0.025);
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(hit.x, y, hit.z),
      q,
      new THREE.Vector3(width, 1, len),
    );
    const v = 0.62 + visualRng.next() * 0.38;
    spillIndex.set(lamp.spec.index, spillEntries.length);
    spillEntries.push({ matrix, color: new THREE.Color(v, v, v) });
  }
  const spills = makeInstanced(
    spillGeo,
    spillMat,
    spillEntries,
    'lamp-spills',
    false,
    false,
  );
  spills.renderOrder = 5;
  root.add(spills);

  /* ---------- 倒地灯的碎石与短路火花 ---------- */

  const rubbleMat = toonMaterial(PALETTE.dirt, { steps: 2 });
  const rubbleGeo = new THREE.DodecahedronGeometry(0.18, 0);
  const rubbleEntries: InstanceEntry[] = [];
  const quatRubble = new THREE.Quaternion();
  const eulerRubble = new THREE.Euler();
  for (const lamp of fallen) {
    const count = 3 + Math.floor(visualRng.next() * 3);
    for (let i = 0; i < count; i += 1) {
      const angle = visualRng.range(0, Math.PI * 2);
      const radius = visualRng.range(0.35, 1.5);
      const px = lamp.lens.x + Math.cos(angle) * radius;
      const pz = lamp.lens.z + Math.sin(angle) * radius * 0.55;
      eulerRubble.set(visualRng.range(0, 3), visualRng.range(0, 6), visualRng.range(0, 3));
      quatRubble.setFromEuler(eulerRubble);
      const s = visualRng.range(0.5, 1.25);
      rubbleEntries.push({
        matrix: new THREE.Matrix4().compose(
          new THREE.Vector3(px, groundYAt(px, pz) + 0.06, pz),
          quatRubble,
          new THREE.Vector3(s, s * 0.7, s),
        ),
      });
    }
  }
  const rubble = makeInstanced(
    rubbleGeo,
    rubbleMat,
    rubbleEntries,
    'lamp-rubble',
    false,
    false,
  );
  root.add(rubble);

  const sparkMat: THREE.MeshBasicMaterial[] = [];
  const sparkBase: THREE.Color[] = [];
  const sparkSeed: number[] = [];
  const sparkLamps = fallen.filter((_, i) => i % 2 === 0).slice(0, 4);
  const sparkGeo = new THREE.SphereGeometry(0.075, 8, 6);
  sparkLamps.forEach((lamp, i) => {
    const cold = i % 3 !== 0;
    const mat = glowMaterial(cold ? GLOW.cold : GLOW.emergency, 0.95);
    const spark = new THREE.Mesh(sparkGeo, mat);
    // 倒地灯头半埋进路面，火花必须抬到灯罩上方才看得见，否则被灯罩壳体完全遮住
    spark.position.copy(lamp.lens).add(new THREE.Vector3(0.04, 0.34, 0));
    spark.castShadow = false;
    spark.receiveShadow = false;
    spark.name = `lamp-spark-${i}`;
    sparkBase.push(new THREE.Color(cold ? GLOW.cold : GLOW.emergency));
    sparkSeed.push(visualRng.range(0, 20));
    sparkMat.push(mat);
    root.add(spark);
  });

  /* ---------- 真实灯池：3 盏投影 + 5 盏补光 + 3 盏近灯点光 ---------- */

  const shadowLights: THREE.SpotLight[] = [];
  const fillLights: THREE.SpotLight[] = [];
  const pointFillLights: THREE.PointLight[] = [];
  const createSpot = (shadow: boolean, slot: number): THREE.SpotLight | null => {
    const spot = new THREE.SpotLight(
      LAMP_LIGHT,
      shadow ? 55 : 26,
      shadow ? 18 : 15,
      // 灯池要摊开、边缘要软：灯下不再是一块手电筒光斑，而是一片化进路面的暖光
      shadow ? 0.78 : 0.9,
      shadow ? 0.92 : 0.97,
      2,
    );
    spot.name = shadow ? `lamp-pool-shadow-${slot}` : `lamp-pool-fill-${slot}`;
    spot.userData['baseIntensity'] = spot.intensity;
    spot.userData['nominalIntensity'] = spot.intensity;
    spot.userData['flickerGain'] = 1;
    spot.visible = false;
    // 初始位置必须彼此错开：ctx.addLight 会拒绝 1.5 m 内的同型光源，
    // 这些灯如果都从 (0,8,0) 起步，后面的会被当成重复直接丢掉。
    spot.position.set(slot * 4, 9, 0);
    if (shadow) {
      spot.castShadow = true;
      // 灯池只照 18 m，512² 已到 ~3.5 cm/texel —— 三渲二要的是硬边，
      // 1024² 在这个范围里没有可见收益，却要多付四倍阴影贴图带宽与采样代价。
      spot.shadow.mapSize.set(512, 512);
      spot.shadow.camera.near = 0.6;
      spot.shadow.camera.far = 30;
      spot.shadow.bias = -0.0015;
      spot.shadow.normalBias = 0.04;
      spot.shadow.radius = 1;
    } else {
      spot.castShadow = false;
    }
    ctx.addLight(spot);
    // 预算打满时 ctx.addLight 只返回对象、不挂进场景；不要把它算进灯池
    if (spot.parent !== ctx.root) return null;
    const target = new THREE.Object3D();
    target.name = shadow ? 'lamp-spot-target' : 'lamp-fill-target';
    spot.target = target;
    ctx.root.add(target);
    return spot;
  };

  for (let i = 0; i < SHADOW_LIGHTS; i += 1) {
    const light = createSpot(true, i);
    if (light) shadowLights.push(light);
  }
  for (let i = 0; i < FILL_LIGHTS; i += 1) {
    const light = createSpot(false, SHADOW_LIGHTS + i);
    if (light) fillLights.push(light);
  }
  for (let i = 0; i < POINT_FILL_LIGHTS; i += 1) {
    // 近距离 Omni 补光：挂在前三盏最近的灯头上，补照亮灯罩、灯杆和身后墙面。
    const light = new THREE.PointLight(LAMP_LIGHT, 20, 14, 2);
    light.name = `lamp-pool-point-${i}`;
    light.userData['baseIntensity'] = light.intensity;
    light.userData['nominalIntensity'] = light.intensity;
    light.userData['flickerGain'] = 1;
    light.visible = false;
    light.position.set((SHADOW_LIGHTS + FILL_LIGHTS + i) * 4, 9, 0);
    ctx.addLight(light);
    if (light.parent === ctx.root) pointFillLights.push(light);
  }

  const live = runtime.filter((lamp) => lamp.spec.live);
  const assignPoint = (
    light: THREE.PointLight,
    lamp: LampRuntime | undefined,
  ): boolean => {
    const prev = light.userData['lampIndex'] as number | undefined;
    const next = lamp?.spec.index ?? -1;
    const changed = prev !== next || light.visible !== !!lamp;
    light.visible = !!lamp;
    light.userData['lampIndex'] = next;
    if (lamp) {
      light.position.copy(lamp.lens).addScaledVector(lamp.down, 0.12);
      const prevBase = (light.userData['baseIntensity'] as number) ?? light.intensity;
      const nextBase =
        (light.userData['nominalIntensity'] as number) * lampPointScale(lamp);
      // 昼夜装置的增益是乘在 baseIntensity 上的；这里按比例同步当前强度，
      // 否则冻结时间时灯池换位后还会沿用上一盏灯的高强度，把地面打爆
      if (prevBase > 0) light.intensity *= nextBase / prevBase;
      light.userData['baseIntensity'] = nextBase;
    }
    return changed;
  };

  const assignLight = (
    light: THREE.SpotLight,
    lamp: LampRuntime | undefined,
  ): boolean => {
    const prev = light.userData['lampIndex'] as number | undefined;
    const next = lamp?.spec.index ?? -1;
    if (!lamp) {
      const changed = light.visible || prev !== next;
      light.visible = false;
      light.userData['lampIndex'] = next;
      if (changed && light.castShadow) light.shadow.needsUpdate = true;
      return changed;
    }
    const changed = prev !== next || !light.visible;
    light.position.copy(lamp.lens);
    light.target.position.copy(lamp.lens).addScaledVector(lamp.down, 10);
    light.target.updateMatrixWorld();
    light.userData['lampIndex'] = next;
    const prevBase = (light.userData['baseIntensity'] as number) ?? light.intensity;
    const nextBase =
      (light.userData['nominalIntensity'] as number) * lampSpotScale(lamp);
    if (prevBase > 0) light.intensity *= nextBase / prevBase;
    light.userData['baseIntensity'] = nextBase;
    light.visible = true;
    // 只重烘这盏灯自己的阴影；太阳/别墅灯的阴影由昼夜装置每 2 s 统一刷新
    if (changed && light.castShadow) light.shadow.needsUpdate = true;
    return changed;
  };

  // 初始灯池：先给路口附近几盏，等相机绑定后第一帧会按视线焦点重排
  const hero = new THREE.Vector3(16, 6, -8);
  const initial = live
    .slice()
    .sort((a, b) => a.lens.distanceToSquared(hero) - b.lens.distanceToSquared(hero));
  shadowLights.forEach((light, i) => assignLight(light, initial[i]));
  fillLights.forEach((light, i) => assignLight(light, initial[SHADOW_LIGHTS + i]));
  pointFillLights.forEach((light, i) => assignPoint(light, initial[i]));

  const focus = new THREE.Vector3();
  const lastFocus = new THREE.Vector3(Number.POSITIVE_INFINITY, 0, Number.POSITIVE_INFINITY);
  const viewDir = new THREE.Vector3();
  const scratchColor = new THREE.Color();
  let assignTimer = 0;
  let poolActive = true;

  const updatePool = (delta: number): void => {
    if (!viewer) return;
    assignTimer += delta;
    viewer.getWorldDirection(viewDir);
    if (viewDir.y < -0.03) {
      const t = Math.min((0 - viewer.position.y) / viewDir.y, 220);
      focus.copy(viewer.position).addScaledVector(viewDir, t);
    } else {
      focus.copy(viewer.position).addScaledVector(viewDir, 60);
    }
    focus.y = 0;

    const camDistance = viewer.position.distanceTo(focus);
    const active =
      camDistance < LIGHT_RANGE &&
      Math.abs(focus.x) < 150 &&
      Math.abs(focus.z) < 150;

    if (!active) {
      if (poolActive) {
        poolActive = false;
        for (const light of shadowLights) {
          light.visible = false;
          shadowDirty = true;
        }
        for (const light of fillLights) light.visible = false;
        for (const light of pointFillLights) light.visible = false;
      }
      return;
    }

    const wasActive = poolActive;
    poolActive = true;
    if (assignTimer < 0.9) return;
    if (!wasActive || focus.distanceToSquared(lastFocus) > 20) {
      assignTimer = 0;
      lastFocus.copy(focus);
      const nearest = live
        .map((lamp) => ({
          lamp,
          d: (lamp.lens.x - focus.x) ** 2 + (lamp.lens.z - focus.z) ** 2,
        }))
        .sort((a, b) => a.d - b.d);

      let changed = false;
      shadowLights.forEach((light, i) => {
        if (assignLight(light, nearest[i]?.lamp)) changed = true;
      });
      fillLights.forEach((light, i) => {
        assignLight(light, nearest[shadowLights.length + i]?.lamp);
      });
      pointFillLights.forEach((light, i) => assignPoint(light, nearest[i]?.lamp));
      if (changed) shadowDirty = true;
    }
  };

  const flickerLevel = (t: number, seed: number): number => {
    const moodSeg = Math.floor(t / 1.45);
    const mood = hashNoise(moodSeg * 17.13 + seed);
    if (mood > 0.74) {
      const fast = hashNoise(Math.floor(t * 23) * 3.71 + seed);
      return fast > 0.44 ? 0.82 + 0.18 * fast : 0.08 + 0.16 * fast;
    }
    if (mood < 0.17) {
      return 0.05 + 0.06 * hashNoise(Math.floor(t * 9) * 1.37 + seed);
    }
    let level = 0.6 + 0.36 * hashNoise(Math.floor(t * 5) * 2.93 + seed);
    if (hashNoise(Math.floor(t * 11) * 5.19 + seed) > 0.93) level *= 0.25;
    return level;
  };

  const lampByIndex = new Map<number, LampRuntime>();
  for (const lamp of runtime) lampByIndex.set(lamp.spec.index, lamp);

  ctx.ticker.add((t, delta) => {
    updatePool(delta);

    // 故障灯：灯面与地面反光同步闪烁（颜色倍率，opacity 交给昼夜装置）
    for (let i = 0; i < flickers.length; i += 1) {
      const lamp = flickers[i]!;
      const level = flickerLevel(t, lamp.flickerSeed);
      const glow = 0.28 + 0.92 * level;
      scratchColor.setRGB(glow, glow, glow);
      flickerLens.setColorAt(i, scratchColor);

      const spill = spillIndex.get(lamp.spec.index);
      if (spill !== undefined) {
        const s = 0.3 + 0.7 * level;
        scratchColor.setRGB(s, s, s);
        spills.setColorAt(spill, scratchColor);
      }
      const pool = poolIndex.get(lamp.spec.index);
      if (pool !== undefined) {
        const s = 0.3 + 0.7 * level;
        scratchColor.setRGB(s, s, s);
        pools.setColorAt(pool, scratchColor);
      }
      const halo = haloIndex.get(lamp.spec.index);
      if (halo !== undefined) {
        const s = 0.22 + 0.78 * level;
        scratchColor.setRGB(s, s, s);
        halos.setColorAt(halo, scratchColor);
      }
    }
    if (flickers.length > 0) {
      flickerLens.instanceColor!.needsUpdate = true;
      spills.instanceColor!.needsUpdate = true;
      pools.instanceColor!.needsUpdate = true;
      halos.instanceColor!.needsUpdate = true;
    }

    // 真实灯池里如果正好分配到故障灯，让 SpotLight 跟着通断
    for (const light of [...shadowLights, ...fillLights, ...pointFillLights]) {
      const index = light.userData['lampIndex'] as number | undefined;
      const lamp = index === undefined ? undefined : lampByIndex.get(index);
      light.userData['flickerGain'] =
        lamp?.spec.state === 'flicker' && light.visible
          ? flickerLevel(t, lamp.flickerSeed)
          : 1;
    }

    // 倒地灯头的短路火花：冷蓝为主，偶发暗红，亮度独立抽搐
    for (let i = 0; i < sparkMat.length; i += 1) {
      const n = hashNoise(Math.floor(t * 19) * 7.31 + sparkSeed[i]!);
      const alive = hashNoise(Math.floor(t * 6.7) * 3.17 + sparkSeed[i]!) > 0.42;
      const k = alive ? 0.12 + 0.88 * n : 0.03;
      sparkMat[i]!.color.copy(sparkBase[i]!).multiplyScalar(k);
    }
  });

  // 让构建日志能核对灯数/损坏比例
  const damaged = plan.filter((l) => l.state === 'tilted' || l.state === 'fallen').length;
  console.info(
    `[streetlights] ${plan.length} 盏 · 倾倒/倒地 ${damaged} (${Math.round((damaged / Math.max(1, plan.length)) * 100)}%) · 真实灯 ${shadowLights.length + fillLights.length + pointFillLights.length}`,
  );

  return root;
}

/* ------------------------------------------------------------------ *
 * 实例化光柱材质
 * ------------------------------------------------------------------ */

/**
 * 与 fx/lightCone 同一个思路（锥尖在灯头、加色渐隐、掠射轮廓淡出），
 * 但整体是一张 InstancedMesh：
 *  - 用 instanceMatrix 还原每个实例的法线与世界位置，倾斜灯的轮廓也正确；
 *  - 按灯头到相机的距离逐实例淡出，贴近灯头时不会糊满整屏。
 */
function instancedConeMaterial(): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    color: LAMP_LIGHT,
    alphaMap: coneAlphaTexture(),
    transparent: true,
    opacity: 0.15,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.FrontSide,
    fog: false,
    toneMapped: false,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vConeSil;\nvarying float vConeFade;\nvarying float vConeFar;',
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        {
          vec4 coneOrigin = modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
          float camDist = distance( coneOrigin.xyz, cameraPosition );
          vConeFade = smoothstep( 8.0, 18.0, camDist );
          // 远处几十根锥体叠在一起会变成一片黄三角，压掉一半让灯晕接管读数
          vConeFar = 1.0 - 0.55 * smoothstep( 55.0, 130.0, camDist );
          vec4 mv = modelViewMatrix * instanceMatrix * vec4( transformed, 1.0 );
          vec3 n = normalize( normalMatrix * ( mat3( instanceMatrix ) * normal ) );
          vec3 v = normalize( -mv.xyz );
          vConeSil = abs( dot( n, v ) );
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vConeSil;\nvarying float vConeFade;\nvarying float vConeFar;',
      )
      .replace(
        '#include <dithering_fragment>',
        /* glsl */ `#include <dithering_fragment>
        gl_FragColor.a *= pow( clamp( vConeSil, 0.0, 1.0 ), 1.6 ) * ( 0.06 + 0.94 * vConeFade ) * vConeFar;`,
      );
  };
  mat.customProgramCacheKey = () => 'lamp-cone-instanced';
  registerNightGlow(mat);
  return mat;
}
