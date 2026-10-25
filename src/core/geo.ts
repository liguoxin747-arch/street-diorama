import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Rng } from './rng';

/** 几何体与摆放工具：把"写一个微缩模型"的成本压到最低。 */

export function group(name: string, children: THREE.Object3D[] = []): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  children.forEach((c) => g.add(c));
  return g;
}

export function mesh(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function box(w: number, h: number, d: number, material: THREE.Material): THREE.Mesh {
  return mesh(new THREE.BoxGeometry(w, h, d), material);
}

/** 贴地矩形（XZ 平面，y 朝上），用于路面、人行道、水面 */
export function groundRect(w: number, d: number, material: THREE.Material): THREE.Mesh {
  const m = mesh(new THREE.PlaneGeometry(w, d), material);
  m.rotation.x = -Math.PI / 2;
  m.receiveShadow = true;
  m.castShadow = false;
  return m;
}

/** 竖直面片（面向 +Z），用于墙面贴纸、招牌面、警戒带 */
export function wallRect(w: number, h: number, material: THREE.Material): THREE.Mesh {
  const m = mesh(new THREE.PlaneGeometry(w, h), material);
  m.castShadow = false;
  return m;
}

export function cyl(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  segment: number,
  material: THREE.Material,
): THREE.Mesh {
  return mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segment), material);
}

export function sphere(radius: number, material: THREE.Material, segments = 12): THREE.Mesh {
  return mesh(new THREE.SphereGeometry(radius, segments, Math.max(6, Math.round(segments * 0.6))), material);
}

export function capsule(radius: number, length: number, material: THREE.Material): THREE.Mesh {
  return mesh(new THREE.CapsuleGeometry(radius, length, 4, 10), material);
}

export function cone(radius: number, height: number, material: THREE.Material, segment = 10): THREE.Mesh {
  return mesh(new THREE.ConeGeometry(radius, height, segment), material);
}

export function torus(radius: number, tube: number, material: THREE.Material, seg = 10): THREE.Mesh {
  return mesh(new THREE.TorusGeometry(radius, tube, 6, seg), material);
}

/** 圆角矩形轮廓（用于倒角体块：沙袋、木箱、废墟块） */
export function roundedRectShape(w: number, d: number, r: number): THREE.Shape {
  const shape = new THREE.Shape();
  const hw = w / 2;
  const hd = d / 2;
  const rr = Math.min(r, hw * 0.9, hd * 0.9);
  shape.moveTo(-hw + rr, -hd);
  shape.lineTo(hw - rr, -hd);
  shape.quadraticCurveTo(hw, -hd, hw, -hd + rr);
  shape.lineTo(hw, hd - rr);
  shape.quadraticCurveTo(hw, hd, hw - rr, hd);
  shape.lineTo(-hw + rr, hd);
  shape.quadraticCurveTo(-hw, hd, -hw, hd - rr);
  shape.lineTo(-hw, -hd + rr);
  shape.quadraticCurveTo(-hw, -hd, -hw + rr, -hd);
  return shape;
}

/** 柔软体块：带倒角的盒体，像沙袋、包裹、破布团 */
export function softBox(w: number, h: number, d: number, r: number, material: THREE.Material): THREE.Mesh {
  const shape = roundedRectShape(w, d, r);
  const bevel = Math.min(r * 0.55, h * 0.35);
  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.01, h - bevel * 2),
    bevelEnabled: true,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelSegments: 2,
    curveSegments: 3,
  });
  geom.rotateX(-Math.PI / 2);
  // ExtrudeGeometry 的挤出范围是 [-bevel, depth+bevel]，这里平移到以原点为中心
  geom.translate(0, -(h / 2 - bevel), 0);
  return mesh(geom, material);
}

/**
 * 顶点噪声扰动：让方盒变成缺角断墙、让球变成碎石。
 * 顺手转成非索引几何，得到平面着色（三渲二里碎石/断墙更"块面"）。
 */
export function jitter(geometry: THREE.BufferGeometry, amount: number, rng: Rng): THREE.BufferGeometry {
  const geom = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = geom.getAttribute('position');
  if (!pos) return geom;
  const seen = new Map<string, THREE.Vector3>();
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = `${x.toFixed(3)}_${y.toFixed(3)}_${z.toFixed(3)}`;
    let offset = seen.get(key);
    if (!offset) {
      offset = new THREE.Vector3(rng.gauss(0, amount), rng.gauss(0, amount), rng.gauss(0, amount));
      seen.set(key, offset);
    }
    pos.setXYZ(i, x + offset.x, y + offset.y, z + offset.z);
  }
  pos.needsUpdate = true;
  geom.computeVertexNormals();
  return geom;
}

/** 位置 + 旋转 + 缩放 */
export function at<T extends THREE.Object3D>(obj: T, x: number, y: number, z: number, rotY = 0): T {
  obj.position.set(x, y, z);
  if (rotY !== 0) obj.rotation.y = rotY;
  return obj;
}

export function scaleTo<T extends THREE.Object3D>(obj: T, x: number, y = x, z = x): T {
  obj.scale.set(x, y, z);
  return obj;
}

/** 沿两点生成圆柱（电线杆横担、钢筋、管子、拖车把手） */
export function cylinderBetween(
  from: THREE.Vector3Like,
  to: THREE.Vector3Like,
  radius: number,
  material: THREE.Material,
  segment = 8,
): THREE.Mesh {
  const a = new THREE.Vector3(from.x, from.y, from.z);
  const b = new THREE.Vector3(to.x, to.y, to.z);
  const dir = b.clone().sub(a);
  const length = dir.length();
  const m = cyl(radius, radius, Math.max(length, 0.001), segment, material);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  if (length > 1e-5) {
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  }
  return m;
}

/** 管线/电线：沿曲线生成管体（下垂电线、电缆、管道） */
export function tubeAlong(points: THREE.Vector3[], radius: number, material: THREE.Material, tubular = 24): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(points);
  return mesh(new THREE.TubeGeometry(curve, tubular, radius, 5, false), material);
}

/** 悬链线下垂路径 */
export function sagPath(from: THREE.Vector3, to: THREE.Vector3, sag: number, segments = 6): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const p = from.clone().lerp(to, t);
    p.y -= Math.sin(Math.PI * t) * sag;
    pts.push(p);
  }
  return pts;
}

/** 合并一组已摆好的网格为单一网格（减少 draw call，用于瓦砾堆、路面标线、碎件） */
export function mergeMeshes(meshes: THREE.Mesh[], material: THREE.Material): THREE.Mesh | null {
  const geometries: THREE.BufferGeometry[] = [];
  meshes.forEach((m) => {
    m.updateMatrix();
    let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    g.applyMatrix4(m.matrix);
    // 统一属性集，避免 merge 失败
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('uv')) {
      const count = g.getAttribute('position')?.count ?? 0;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    // 只保留 position/normal/uv，属性集必须完全一致才能合并
    const kept = new THREE.BufferGeometry();
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    if (pos) kept.setAttribute('position', pos.clone());
    if (nor) kept.setAttribute('normal', nor.clone());
    if (uv) kept.setAttribute('uv', uv.clone());
    g.dispose();
    geometries.push(kept);
  });
  if (geometries.length === 0) return null;
  const merged = mergeGeometries(geometries, false);
  geometries.forEach((g) => g.dispose());
  if (!merged) return null;
  return mesh(merged, material);
}

/** 批量合并的便捷封装：直接挂到父节点上（失败时静默跳过） */
export function addBatch(
  parent: THREE.Object3D,
  meshes: THREE.Mesh[],
  material: THREE.Material,
  name = 'batch',
): THREE.Mesh | null {
  if (meshes.length === 0) return null;
  const merged = mergeMeshes(meshes, material);
  if (merged) {
    merged.name = name;
    merged.castShadow = true;
    merged.receiveShadow = true;
    parent.add(merged);
  }
  return merged;
}

export interface InstanceTransform {
  position: THREE.Vector3;
  rotation?: THREE.Euler;
  scale?: THREE.Vector3;
}

/**
 * 把一个已经摆好的静态子树按材质就地合并成少数几个网格。
 *
 * 手工搭出来的资产（废弃车辆、防空洞、剖切楼里的家具）每件网格一次 draw call，
 * 而描边壳又是逐网格挂的 —— 一辆 80 件的车会直接吃掉近百次调用。合并后描边一起减少。
 *
 * 豁免：InstancedMesh（本来就是一次）、transparent 材质（合并会打乱排序）、
 * 以及标了 `userData.noBatch` 的动画件（火苗缩放、灯芯透明度都靠逐件改 transform/material）。
 */
export function batchGroupByMaterial(root: THREE.Object3D, namePrefix = 'batched'): void {
  root.updateMatrixWorld(true);
  const buckets = new Map<string, { mat: THREE.Material; cast: boolean; geos: THREE.BufferGeometry[] }>();
  const victims: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh) return;
    if (m.userData['noBatch'] || m.userData['isOutline'] || m.userData['hasOutline']) return;
    const mat = m.material as THREE.Material;
    if (Array.isArray(mat) || mat.transparent) return;
    // 霓虹/火光靠逐件改材质或缩放闪烁，而且 glowMaterial 每盏都是独立材质，合了也省不下
    if (mat.userData['isNightGlow']) return;
    if (!m.geometry?.getAttribute('position')) return;
    victims.push(m);
  });
  for (const m of victims) {
    const mat = m.material as THREE.Material;
    // 逐层累乘父链（挂在 pivot 上的车门这类），最后落到 root 的局部系
    const chain = new THREE.Matrix4();
    for (let p: THREE.Object3D | null = m; p && p !== root; p = p.parent) {
      p.updateMatrix();
      chain.premultiply(p.matrix);
    }
    const g = m.geometry.clone();
    g.applyMatrix4(chain);
    const key = `${mat.uuid}|${m.castShadow ? 1 : 0}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.geos.push(g);
    else buckets.set(key, { mat, cast: m.castShadow, geos: [g] });
  }
  victims.forEach((m) => m.parent?.remove(m));
  let i = 0;
  for (const { mat, cast, geos } of buckets.values()) {
    const proxies = geos.map((g) => new THREE.Mesh(g, mat));
    const merged = mergeMeshes(proxies, mat);
    geos.forEach((g) => g.dispose());
    if (!merged) continue;
    merged.name = `${namePrefix}-${i}`;
    merged.castShadow = cast;
    merged.receiveShadow = true;
    root.add(merged);
    i += 1;
  }
}
/**
 * 把一个静态子树里的描边壳按材质合并成一条。
 *
 * 描边壳是逐网格挂在宿主下的同几何 BackSide 副本。基础网格合批之后，描边仍是"每个批次一条"；
 * 把壳烘到 root 局部系再合并，能再省掉几十次调用。调用前必须确认子树不会移动，
 * 合并后壳的几何已经写死，跟随动画就失效了。
 */
export function mergeOutlineHulls(root: THREE.Object3D, name = 'merged-outline'): void {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const victims: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.userData['isOutline']) return;
    const mat = m.material as THREE.Material;
    if (Array.isArray(mat)) return;
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toRoot, m.matrixWorld));
    const list = buckets.get(mat);
    if (list) list.push(g);
    else buckets.set(mat, [g]);
    victims.push(m);
  });
  victims.forEach((m) => m.parent?.remove(m));
  let i = 0;
  for (const [mat, geos] of buckets) {
    const merged = mergeMeshes(
      geos.map((g) => new THREE.Mesh(g, mat)),
      mat,
    );
    geos.forEach((g) => g.dispose());
    if (!merged) continue;
    merged.name = `${name}-${i}`;
    merged.renderOrder = -1;
    merged.castShadow = false;
    merged.receiveShadow = false;
    merged.userData['isOutline'] = true;
    root.add(merged);
    i += 1;
  }
}

/** 实例化网格：成百上千颗瓦砾/弹壳/碎片只占一个 draw call */
export function instanced(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  transforms: InstanceTransform[],
): THREE.InstancedMesh {
  const inst = new THREE.InstancedMesh(geometry, material, Math.max(transforms.length, 1));
  inst.count = transforms.length;
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  transforms.forEach((t, i) => {
    quat.setFromEuler(t.rotation ?? new THREE.Euler());
    const scale = t.scale ?? new THREE.Vector3(1, 1, 1);
    matrix.compose(t.position, quat, scale);
    inst.setMatrixAt(i, matrix);
  });
  inst.instanceMatrix.needsUpdate = true;
  inst.castShadow = true;
  inst.receiveShadow = true;
  return inst;
}

/** 在矩形区域内均匀随机取点，可排除内边界（用于瓦砾散布） */
export function scatterInRect(
  rng: Rng,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  count: number,
  y = 0,
): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(new THREE.Vector3(rng.range(Math.min(x0, x1), Math.max(x0, x1)), y, rng.range(Math.min(z0, z1), Math.max(z0, z1))));
  }
  return out;
}

/** 在圆周上取点（沙袋环形掩体、轮胎堆） */
export function ringPoints(count: number, radius: number, y = 0, jitterAmount = 0): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < count; i += 1) {
    const a = (i / count) * Math.PI * 2;
    out.push(new THREE.Vector3(Math.cos(a) * (radius + jitterAmount), y, Math.sin(a) * (radius + jitterAmount)));
  }
  return out;
}

/** 让物体略微倾倒，制造战场失真感 */
export function tilt(obj: THREE.Object3D, rx: number, rz: number): THREE.Object3D {
  obj.rotation.x += rx;
  obj.rotation.z += rz;
  return obj;
}

/** 平滑 deterministic 噪声（1D），用于灯光闪烁与雨滴相位 */
export function hashNoise(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}
