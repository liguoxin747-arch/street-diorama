import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BASE, HERO, TOWN_PLOTS } from '../world/layout';

/**
 * 建筑占位（用于相机避让）：低机位环绕时若钻进楼里会看到一片黑，
 * 这里把相机顶到该栋楼的屋面之上。
 */
interface Footprint {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  h: number;
}

function buildingFootprints(): Footprint[] {
  const list: Footprint[] = [
    { x0: HERO.x0 - 0.6, x1: HERO.x1 + 0.6, z0: HERO.z0 - 0.6, z1: HERO.z1 + 0.6, h: HERO.eaveY + 1.4 },
  ];
  for (const plot of TOWN_PLOTS) {
    list.push({
      x0: plot.x0 - 0.5,
      x1: plot.x1 + 0.5,
      z0: plot.z0 - 0.5,
      z1: plot.z1 + 0.5,
      h: plot.floors * 3.4 + 1.6,
    });
  }
  return list;
}

/**
 * 实心格表（顶点级）：地图扩建后，内圈带（74..90）与外圈分区里长出了大量
 * 不在 TOWN_PLOTS 里的建筑（quarters / industrial / outpost / newblocks），
 * 相机避让表没跟上 → 旋转到那些建筑群里时相机被推进楼体内部，画面整片黑。
 *
 * 修法：从场景本身惰性扫一张"实心格"表 —— 把每个网格里 y ≥ SOLID_Y 的
 * 采样顶点记一格。合批的包围盒会覆盖整城（不能用来避让），顶点级才准。
 */
const SOLID_Y = 5.5; // 高于这个高度的顶点才算"楼"
const CELL = 4; // 实心格边长（m）
/**
 * 非建筑：天空穹顶（顶点高 580 m，跟着相机走）、远景剪影、边缘雾片、
 * 云影、无人机、路灯/电线杆。相机穿过它们是可接受的；
 * 把它们算进高度图会让整张表虚高，反而制造瞬移。
 */
const IGNORED = /^(sky-dome|base-bevel|far-backdrop|skyline-|far-radar|edge-fog|cloud-shadow|drone-|rotor$|lamp-|wires$|poles-)/;
/** 相机安全半径：低于"本格最高点 + 该值"才算进入楼体 */
const CAM_RADIUS = 0.9;
/** 单帧最大避让位移（m）：把"瞬移"摊成几帧的快速滑动 */
const MAX_CORRECTION = 1.25;
/** 每个格子记录"最高顶点高度"，而不是只记有/无 —— 高空俯瞰绝不能触发避让 */
const cellTops = new Map<string, number>();
let solidScanned = false;

function cellKey(cx: number, cz: number): string {
  return `${cx}_${cz}`;
}

export function scanSolidCells(scene: THREE.Scene): void {
  if (solidScanned) return;
  solidScanned = true;
  // 构建阶段结束后 matrixWorld 未必已刷新；不刷新会按局部坐标落格，整张表是错的
  const t0 = performance.now();
  scene.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  const mark = (x: number, y: number, z: number): void => {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    const key = cellKey(cx, cz);
    const prev = cellTops.get(key) ?? 0;
    if (y > prev) cellTops.set(key, y);
  };
  const ignored = (o: THREE.Object3D): boolean => {
    let node: THREE.Object3D | null = o;
    for (let i = 0; i < 5 && node; i += 1) {
      if (node.name && IGNORED.test(node.name)) return true;
      node = node.parent;
    }
    return false;
  };
  scene.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) return;
    if (ignored(o)) return;
    // 实例化网格的顶点是局部坐标（instanceMatrix 不在 matrixWorld 里），
    // 扫进去只会在原点堆出一格假的"树高"，直接跳过
    if ((o as THREE.InstancedMesh).isInstancedMesh) return;
    const mesh = o as THREE.Mesh;
    const pos = mesh.geometry?.getAttribute?.('position');
    if (!pos) return;
    // 每个网格最多采 4000 个顶点（够密、够快）
    const step = Math.max(1, Math.floor(pos.count / 4000));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      if (v.y >= SOLID_Y) mark(v.x, v.y, v.z);
    }
  });
  console.info(`[camera] 障碍高度图 ${cellTops.size} 格 / ${Math.round(performance.now() - t0)}ms`);
}

function cellTop(cx: number, cz: number): number {
  return cellTops.get(cellKey(cx, cz)) ?? -Infinity;
}

/** 相机在该点是否真的处在楼体内：XZ 落在有楼的格子里，且高度低于该格最高点 */
function insideSolid(x: number, z: number, y: number): boolean {
  const top = cellTop(Math.floor(x / CELL), Math.floor(z / CELL));
  return y < top + CAM_RADIUS;
}

/**
 * 把相机沿"最小位移"推出楼体。
 * 旧版把相机吸到最近空格的中心：一圈转下来每跨一格就瞬移 8~56 m，
 * 而且完全不看高度——在 50 m 高空俯瞰也会被横向甩出去（用户看到的"抽搐/卡位"）。
 * 现在只取最近空格内离相机最近的一点；低空切进楼顶时优先抬高掠过屋顶；
 * 所有修正单帧最多 1.25 m，把瞬时弹开摊成几帧的快速滑动。
 */
function pushOutOfSolid(p: THREE.Vector3): boolean {
  const cx0 = Math.floor(p.x / CELL);
  const cz0 = Math.floor(p.z / CELL);
  if (!insideSolid(p.x, p.z, p.y)) return false;
  const pad = CAM_RADIUS + 0.3;
  // 低空切进楼顶时，"抬高 2~3 m 掠过屋顶"通常比横向弹开十几米自然得多
  const lift = cellTop(cx0, cz0) + CAM_RADIUS - p.y;
  for (let ring = 1; ring <= 3; ring += 1) {
    let best: { x: number; z: number; d: number } | null = null;
    for (let dz = -ring; dz <= ring; dz += 1) {
      for (let dx = -ring; dx <= ring; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        const cx = cx0 + dx;
        const cz = cz0 + dz;
        // 该格在相机高度上必须是空的（楼顶低于相机）
        if (p.y < cellTop(cx, cz) + CAM_RADIUS) continue;
        const x = THREE.MathUtils.clamp(p.x, cx * CELL + pad, (cx + 1) * CELL - pad);
        const z = THREE.MathUtils.clamp(p.z, cz * CELL + pad, (cz + 1) * CELL - pad);
        const d = Math.hypot(x - p.x, z - p.z);
        if (!best || d < best.d) best = { x, z, d };
      }
    }
    if (best) {
      // 每帧最多挪 1.25 m：低空掠过屋顶时是"滑出去"，不是瞬移
      if (lift > 0 && lift <= best.d * 0.8) {
        p.y = Math.min(cellTop(cx0, cz0) + CAM_RADIUS, p.y + MAX_CORRECTION);
      } else {
        const k = best.d > MAX_CORRECTION ? MAX_CORRECTION / best.d : 1;
        p.x += (best.x - p.x) * k;
        p.z += (best.z - p.z) * k;
      }
      return true;
    }
  }
  if (lift > 0) {
    p.y = Math.min(cellTop(cx0, cz0) + CAM_RADIUS, p.y + MAX_CORRECTION);
    return true;
  }
  return false;
}

/**
 * 第三人称观察：自由拖拽旋转、滚轮缩放、右键平移。
 * 全部为输入控制，屏幕上不出现任何 UI 元素。
 */
export interface DioramaCamera {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  update(delta: number): void;
  setSize(width: number, height: number): void;
}

export function createCamera(dom: HTMLElement, width: number, height: number, scene?: THREE.Scene): DioramaCamera {
  const camera = new THREE.PerspectiveCamera(38, width / height, 0.8, 620);
  // 默认机位：从西南方约 32° 俯视，整块正方形底座都在画面内（可自由缩放靠近看细节）
  // 起始机位拉近到能读出窗洞/砖/沙袋的距离（原来 220 m 外，细节全是亚像素）
  camera.position.set(-64, 82, 100);

  const controls = new OrbitControls(camera, dom);
  controls.target.set(8, 5, -9);
  controls.enableDamping = true;
  controls.dampingFactor = 0.055;
  controls.rotateSpeed = 0.72;
  controls.zoomSpeed = 0.85;
  controls.panSpeed = 0.7;
  controls.screenSpacePanning = false;
  controls.minDistance = 20;
  controls.maxDistance = 430;
  controls.minPolarAngle = 0.12;
  controls.maxPolarAngle = Math.PI * 0.46;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.28;
  controls.update();

  // 空闲一段时间后自动缓慢环绕，交互时立即停止
  let idleTimer = 0;
  let interacting = false;
  const stop = (): void => {
    interacting = true;
    idleTimer = 0;
    controls.autoRotate = false;
  };
  const release = (): void => {
    interacting = false;
    idleTimer = 0;
  };
  dom.addEventListener('pointerdown', stop);
  dom.addEventListener('wheel', stop, { passive: true });
  dom.addEventListener('pointerup', release);
  dom.addEventListener('pointerleave', release);

  const clampTarget = (): void => {
    const limit = BASE.half - 6;
    controls.target.x = THREE.MathUtils.clamp(controls.target.x, -limit, limit);
    controls.target.z = THREE.MathUtils.clamp(controls.target.z, -limit, limit);
    controls.target.y = THREE.MathUtils.clamp(controls.target.y, 0.5, 26);
  };

  const footprints = buildingFootprints();

  // 在首帧之前扫完（此时仍在加载遮罩后），避免第一次拖动视角时卡一下
  if (scene) scanSolidCells(scene);

  /** 相机不要钻进建筑内部：只在真的落在楼体里时，沿"离开楼体中心"的方向顶出 */
  const avoidBuildings = (): void => {
    const p = camera.position;
    if (p.y < 1.6) p.y = 1.6;
    // 楼内 → 先按高度格推出（处理"扩建建筑不在登记表里"的情况）
    pushOutOfSolid(p);
    for (let pass = 0; pass < 3; pass += 1) {
      let hit = false;
      for (const f of footprints) {
        // 只有真的"在楼里"（XZ 落在楼板范围内、且高度低于屋顶）才处理
        if (p.x <= f.x0 || p.x >= f.x1 || p.z <= f.z0 || p.z >= f.z1 || p.y >= f.h) continue;
        const cx = (f.x0 + f.x1) / 2;
        const cz = (f.z0 + f.z1) / 2;
        let dx = p.x - cx;
        let dz = p.z - cz;
        const len = Math.hypot(dx, dz);
        if (len < 0.001) {
          dx = 1;
          dz = 0;
        } else {
          dx /= len;
          dz /= len;
        }
        const margin = 1.8;
        const tx = dx !== 0 ? Math.max((f.x1 + margin - p.x) / dx, (f.x0 - margin - p.x) / dx, 0) : Infinity;
        const tz = dz !== 0 ? Math.max((f.z1 + margin - p.z) / dz, (f.z0 - margin - p.z) / dz, 0) : Infinity;
        const step = Math.min(tx, tz, MAX_CORRECTION);
        if (Number.isFinite(step) && step > 0) {
          p.x += dx * step;
          p.z += dz * step;
          hit = true;
        }
      }
      if (!hit) break;
    }
    camera.lookAt(controls.target);
  };

  return {
    camera,
    controls,
    update(delta: number) {
      if (!interacting) {
        idleTimer += delta;
        if (idleTimer > 12) controls.autoRotate = true;
      }
      controls.update(delta);
      clampTarget();
      avoidBuildings();
    },
    setSize(w: number, h: number) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },
  };
}
