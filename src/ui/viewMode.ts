import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import type { DioramaCamera } from '../core/camera';
import type { DioramaPost } from '../core/post';
import { ALLEYS, BASE, HERO, HOTSPOTS, TOWN_PLOTS, isOnRoadCorridor, type Rect } from '../world/layout';
import { fillColliders } from '../world/fill';
import { interiorApertures } from '../world/interiors';
import { newBlockColliders } from '../world/newblocks';
import { villaColliders, villaDoors } from '../world/villa';

/**
 * 双视角：自由俯瞰（OrbitControls，已有）↔ 第一人称（PointerLockControls）。
 *
 * 三个按这个项目的现实做的取舍：
 *  1. `maxDistance` 保留 430 而不是 100：底座是 288 m 见方，100 m 看不全整块沙盘。
 *  2. 提示文字平时 `visibility:hidden`：场景的前提是"屏幕零 UI"，
 *     `test:interact` 正是按 visibility 判定的；只有"进了第一人称但指针没锁上"这一态才浮现。
 *  3. 碰撞不用 Box3 逐栋建筑：建筑全部按材质合批，批量盒覆盖整个街区会误判。
 *     改为**可行的行走域 = 路网走廊内缩 0.35 m**——建筑都在走廊之外，
 *     于是在街上走得通、且不可能穿墙。轴分离尝试让它能贴着墙滑。
 *
 * 阴影类型不在运行时切换：改 `renderer.shadowMap.type` 会触发全场景材质重编译，
 * 换来一次明显卡顿；三渲二需要的本来就是硬边 PCF，两种视角一致。
 */

const EYE = 1.7;
const WALK = 4.2;
const RUN = 7.4;
const RADIUS = 0.3;
/**
 * 核心区的实体足迹：建筑来自设计数据（精确矩形），而不是 Box3——合批后的批次盒覆盖整个街区。
 *
 * 例外：`kind === 'yard'` 的地块是**空地**（院子、菜地、晾衣绳、柴堆），
 * 整块当实体挡住就会在空地上凭空立起一堵看不见的墙（用户反馈的"各种空气墙"）。
 * 院子里的棚子、围墙、木堆由几何障碍（buildGeomIndex）按真实包围盒负责。
 */
/**
 * 地块矩形是**地皮**（含后院），楼体只有 8~12 m 深。
 * 整块当地皮挡人，就会把楼后面的院子/菜地/晾衣绳一起封死 ——
 * 这是"建筑区域各种空气墙"的第二个来源（前排楼是真的，后排空地是假的）。
 * 所以只挡住"临街面往里的楼体进深"这一条带。
 */
const BUILD_DEPTH = 12;

function plotSolid(p: (typeof TOWN_PLOTS)[number]): Rect {
  const d = BUILD_DEPTH;
  switch (p.facing) {
    case 'posZ':
      return { x0: p.x0, x1: p.x1, z0: p.z0, z1: Math.min(p.z1, p.z0 + d) };
    case 'negZ':
      return { x0: p.x0, x1: p.x1, z0: Math.max(p.z0, p.z1 - d), z1: p.z1 };
    case 'posX':
      return { x0: p.x0, x1: Math.min(p.x1, p.x0 + d), z0: p.z0, z1: p.z1 };
    default:
      return { x0: Math.max(p.x0, p.x1 - d), x1: p.x1, z0: p.z0, z1: p.z1 };
  }
}

const CORE_BLOCKERS: Rect[] = [
  ...TOWN_PLOTS.filter((p) => p.kind !== 'yard' && p.kind !== 'ruin' && p.kind !== 'shed').map(plotSolid),
  { x0: HERO.x0, x1: HERO.x1, z0: HERO.z0, z1: HERO.z1 },
  // 街上几件大型停置物也要挡人（BMPT / 被毁 T-72 / 烧毁轿车），约 3×7 m
  { x0: HOTSPOTS.bmpt.x - 1.8, x1: HOTSPOTS.bmpt.x + 1.8, z0: HOTSPOTS.bmpt.z - 3.6, z1: HOTSPOTS.bmpt.z + 3.6 },
  { x0: HOTSPOTS.t72.x - 1.8, x1: HOTSPOTS.t72.x + 1.8, z0: HOTSPOTS.t72.z - 3.6, z1: HOTSPOTS.t72.z + 3.6 },
  { x0: HOTSPOTS.burntCar.x - 1.2, x1: HOTSPOTS.burntCar.x + 1.2, z0: HOTSPOTS.burntCar.z - 2.4, z1: HOTSPOTS.burntCar.z + 2.4 },
];

/**
 * 只有"确实有楼"的地块才挡人。
 *
 * 地块表是**设计意图**，不等于实际几何：会有的地块因为放不下、被占位拒绝、
 * 或本身就是空地而根本没生成建筑。整块拦下来，就是一块 20×20 m 的空地上凭空一堵墙
 * ——用户反馈的"建筑区域小巷各种空气墙"里最大的一块就是这个。
 *
 * 用一次性向下射线验证：在地块里取 5 个采样点从 y=32 往下打，命中高度 > 1.35 m
 * 才算真有楼。只在地块数（30 出头）× 5 条射线，开销可以忽略。
 */
let coreBlocked: Rect[] | null = null;

function coreBlockers(scene?: THREE.Scene): Rect[] {
  if (coreBlocked) return coreBlocked;
  if (!scene) return CORE_BLOCKERS;
  const ray = new THREE.Raycaster();
  ray.far = 42;
  const down = new THREE.Vector3(0, -1, 0);
  const origin = new THREE.Vector3();
  const meshes: THREE.Mesh[] = [];
  // 只拿"实体"网格：雾片、背景板、光晕、贴花这类半透明/超大的东西会被射线打到，
  // 但它们不是墙 —— 不过滤的话每块空地都会被判成"有楼"，射线验证等于白做。
  const NOT_SOLID = /^(sky-dome|edge-fog|far-|cloud-shadow|skyline|fx-|lamp-cone|halo)/;
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    if (m.userData['isOutline'] || m.name === 'sky-dome') return;
    if (NOT_SOLID.test(m.name || '')) return;
    const mat = m.material as THREE.Material | THREE.Material[];
    if (Array.isArray(mat) ? mat.some((x) => x.transparent) : mat?.transparent) return;
    let p: THREE.Object3D | null = m.parent;
    let skip = false;
    while (p) {
      if (p.name && NOT_SOLID.test(p.name)) {
        skip = true;
        break;
      }
      p = p.parent;
    }
    if (!skip) meshes.push(m);
  });
  const hasBuilding = (r: Rect): boolean => {
    const xs = [0.5, 0.22, 0.78, 0.22, 0.78];
    const zs = [0.5, 0.22, 0.78, 0.78, 0.22];
    for (let i = 0; i < xs.length; i += 1) {
      origin.set(r.x0 + (r.x1 - r.x0) * xs[i]!, 32, r.z0 + (r.z1 - r.z0) * zs[i]!);
      ray.set(origin, down);
      const hits = ray.intersectObjects(meshes, false);
      if (hits.some((h) => h.point.y > 1.35)) return true;
    }
    return false;
  };
  const kept: Rect[] = [];
  let dropped = 0;
  for (const r of CORE_BLOCKERS) {
    if (hasBuilding(r)) kept.push(r);
    else dropped += 1;
  }
  coreBlocked = kept;
  console.info(`[walk] 地块碰撞 ${CORE_BLOCKERS.length} → ${kept.length}（${dropped} 块是空地，不再挡人）`);
  return coreBlocked;
}
const TRANSITION_MS = 820;
/** 出生点：纵街上、主楼北侧，正对着街角 —— 一定在走廊内 */
const SPAWN = new THREE.Vector3(3.4, EYE, -22);
const SPAWN_LOOK = new THREE.Vector3(16, 6, -18);

type Mode = 'orbit' | 'fps' | 'transition';

export interface ViewMode {
  readonly mode: Mode;
  /** 每帧调用：第一人称下处理移动与碰撞，过渡中推进插值 */
  update(delta: number): void;
  toggle(): void;
  /** 外部（验收脚本）强制回到俯瞰 */
  toOrbit(): void;
  /** 某点是否可站立（碰撞判定的对外只读口，验收用） */
  canStand(x: number, z: number): boolean;
  /** 当前生效的全部碰撞矩形（M 键可视化用） */
  debugRects(): Rect[];
  readonly player: THREE.Vector3;
}

interface Options {
  orbit: DioramaCamera;
  post: DioramaPost;
  dom: HTMLElement;
  host: HTMLElement;
  /** 场景：用于从几何自动生成"挡住人的实体"矩形（新增建筑不必再手工登记） */
  scene?: THREE.Scene;
}

/* ------------------------------------------------------------------ *
 * 几何障碍：从网格的世界包围盒自动生成可挡人的矩形
 *
 * 只靠数据矩形（TOWN_PLOTS / 新建筑注册表）的问题：三个扩建分区的建筑从来没有集中登记，
 * 新加的建筑更不会有 —— 于是可行走域只能在 ±90 收边，那片空地上就出现"看不见的墙"，
 * 而分区里的巷子、院子全部进不去。
 *
 * 这里改成从场景本身取障碍：任何"高度超过 1.35 m、跨度不超过 26 m"的实体网格都算墙。
 * 上限 26 m 是为了剔除整城级合批（城镇批次动辄上百米，包围盒会盖住整个街区）。
 * 同时跳过：描边壳、实例化网格（瓦砾/草/弹壳）、透明件（贴花/光晕/光柱）。
 * ------------------------------------------------------------------ */
const GEOM_CELL = 8;
let geomIndex: Map<string, Rect[]> | null = null;

function geomCellKey(cx: number, cz: number): string {
  return `${cx}_${cz}`;
}

function buildGeomIndex(scene: THREE.Scene): Map<string, Rect[]> {
  const index = new Map<string, Rect[]>();
  const box = new THREE.Box3();
  const push = (r: Rect): void => {
    const cx0 = Math.floor(r.x0 / GEOM_CELL);
    const cx1 = Math.floor(r.x1 / GEOM_CELL);
    const cz0 = Math.floor(r.z0 / GEOM_CELL);
    const cz1 = Math.floor(r.z1 / GEOM_CELL);
    for (let cz = cz0; cz <= cz1; cz += 1) {
      for (let cx = cx0; cx <= cx1; cx += 1) {
        const key = geomCellKey(cx, cz);
        const list = index.get(key);
        if (list) list.push(r);
        else index.set(key, [r]);
      }
    }
  };
  /** 自带精确碰撞的模块：跳过它们的包围盒，否则整栋楼的盒子会把室内也封死 */
  const SELF_COLLIDED = /^(custom-villa|diorama-fx|sky-dome|skyline|edge-fog)/;
  const owned = (o: THREE.Object3D): boolean => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) {
      if (p.name && SELF_COLLIDED.test(p.name)) return true;
    }
    return false;
  };
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.userData['isOutline']) return;
    if ((m as unknown as THREE.InstancedMesh).isInstancedMesh) return;
    if (owned(m)) return;
    const mat = m.material as THREE.Material | THREE.Material[];
    if (Array.isArray(mat) ? mat.some((x) => x.transparent) : mat?.transparent) return;
    if (!m.geometry) return;
    box.setFromObject(m);
    if (!Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) return;
    const sx = box.max.x - box.min.x;
    const sz = box.max.z - box.min.z;
    // 贴地薄片（路面/人行道/水洼）与整城合批都不算墙
    if (box.max.y < 1.35) return;
    if (sx > 26 || sz > 26) return;
    // 指甲盖大小的碎件不挡人（否则满地都是看不见的钉子）
    if (sx * sz < 0.3) return;
    // 核心区里有精确的地块/填充数据，几何只负责"零碎件"：
    // 面积超过 45 m² 的合组件（整片废墟、成排栅栏）包围盒会跨过大片空地，
    // 拿它挡人就是一块空地中央的空气墙。核心区外没有地块数据，仍按 26 m 上限接受。
    const inCore = Math.abs((box.min.x + box.max.x) / 2) <= 92 && Math.abs((box.min.z + box.max.z) / 2) <= 92;
    if (inCore && sx * sz > 45) return;
    push({ x0: box.min.x, x1: box.max.x, z0: box.min.z, z1: box.max.z });
  });
  console.info(`[walk] 几何障碍格 ${index.size} 个（由场景网格自动生成）`);
  return index;
}

const HINT_CSS = `
.view-hint {
  position: fixed;
  left: 50%;
  bottom: 96px;
  transform: translateX(-50%);
  padding: 9px 16px;
  border-radius: 8px;
  background: rgba(8, 12, 17, 0.72);
  border: 1px solid rgba(126, 158, 186, 0.24);
  color: #cfdae4;
  font: 12.5px/1.6 "Segoe UI", "Microsoft YaHei", sans-serif;
  letter-spacing: 0.4px;
  text-align: center;
  white-space: pre-line;
  opacity: 0;
  visibility: hidden;
  transition: opacity 200ms ease, visibility 0s linear 200ms;
  pointer-events: none;
  z-index: 5;
}
.view-hint[data-shown='1'] {
  opacity: 1;
  visibility: visible;
  transition: opacity 180ms ease, visibility 0s linear 0s;
}
`;

export function createViewMode({ orbit, post, dom, host, scene }: Options): ViewMode {
  const style = document.createElement('style');
  style.textContent = HINT_CSS;
  document.head.appendChild(style);

  const hint = document.createElement('div');
  hint.className = 'view-hint';
  hint.dataset['shown'] = '0';
  hint.textContent = '点击画面进入第一人称漫游\nWASD 移动 · Shift 快走 · V 返回俯瞰';
  host.appendChild(hint);

  const camera = orbit.camera;
  const fps = new PointerLockControls(camera, dom);
  const keys = new Set<string>();
  const player = SPAWN.clone();
  let mode: Mode = 'orbit';
  let yawPitchReady = false;

  // —— 平滑过渡 ——
  let transT = 0;
  let fromPos = new THREE.Vector3();
  let fromLook = new THREE.Vector3();
  let toPos = new THREE.Vector3();
  let toLook = new THREE.Vector3();
  let after: Mode = 'orbit';

  const ease = (k: number): number => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

  const setHint = (shown: boolean): void => {
    hint.dataset['shown'] = shown ? '1' : '0';
  };

  const setModeFlags = (next: Mode): void => {
    mode = next;
    orbit.controls.enabled = next === 'orbit';
    if (next === 'orbit') {
      orbit.controls.autoRotate = false;
      document.exitPointerLock?.();
      setHint(false);
      camera.near = 0.8;
      post.setTiltShift(1);
    } else {
      camera.near = 0.1;
      post.setTiltShift(0);
    }
    camera.updateProjectionMatrix();
  };

  // 填充物（帐篷/残骸/路障）的碰撞体在场景建完后才有内容，所以每次判定时惰性取一次
  let fills: Rect[] | null = null;
  /** 别墅的墙也是挡人的：主楼整块 + 车库后墙 + 车库左墙残根（车库内部留空，可走进去） */
  let villaWalls: Rect[] | null = null;
  const blockedByBuilding = (x: number, z: number): boolean => {
    if (fills === null) fills = fillColliders();
    if (villaWalls === null) villaWalls = villaColliders();
    if (scene && geomIndex === null) geomIndex = buildGeomIndex(scene);
    const hit = (r: Rect): boolean =>
      x > r.x0 - RADIUS && x < r.x1 + RADIUS && z > r.z0 - RADIUS && z < r.z1 + RADIUS;
    // 半开门洞：允许穿过足迹进入室内（门洞本身有侧壁，不需要再判）
    if (interiorApertures().some(hit)) return false;
    // 别墅的门洞（主门 / 车库敞口）同样可进
    if (villaDoors().some(hit)) return false;
    // 设计好的巷道永远通：它们本来就夹在两个地块矩形之间，不这样放行会被地块矩形吃掉
    if (ALLEYS.some(hit)) return false;
    // 几何障碍：只查点所在的 8 m 格及其邻格，避免每次遍历上千条矩形
    if (geomIndex) {
      const cx = Math.floor(x / GEOM_CELL);
      const cz = Math.floor(z / GEOM_CELL);
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const list = geomIndex.get(geomCellKey(cx + dx, cz + dz));
          if (list && list.some(hit)) return true;
        }
      }
    }
    return (
      coreBlockers(scene).some(hit) || fills.some(hit) || newBlockColliders().some(hit) || villaWalls.some(hit)
    );
  };

  /**
   * 可行走判定：
   *  - 街道：路网走廊内缩 0.3 m（保证人整个在路面上）
   *  - 核心区（|x|,|z| ≤ 72）：除建筑足迹外全部可走 —— 小巷、后院、地块间隙都能钻
   *  - 三个新分区：仍只允许走廊（那里的建筑足迹没有集中登记，避免穿楼）
   */
  /**
   * 可行走判定：
   *  - 全域按底座收边（|x|,|z| ≤ base.half - 3），不再在 ±90 处切一刀
   *  - 唯一的限制是"真的撞到东西"：地块矩形 / 新建筑 / 别墅 / 空地填充 / 几何障碍
   *  - 设计巷道（ALLEYS）与门洞永远放行
   * 之前这里是"核心区 + 内圈带"，更外圈只能走马路 —— 于是扩建分区里的巷子、院子
   * 一进去就撞墙，表现就是满地空气墙。
   */
  const walkable = (x: number, z: number): boolean => {
    if (Math.abs(x) > BASE.half - 3 || Math.abs(z) > BASE.half - 3) return false;
    // 障碍必须先判：街心停着的 BMPT / 残骸也在走廊里，不能因为"是马路"就放行
    if (blockedByBuilding(x, z)) return false;
    void isOnRoadCorridor;
    return true;
  };

  const startTransition = (targetPos: THREE.Vector3, targetLook: THREE.Vector3, next: Mode): void => {
    fromPos.copy(camera.position);
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    fromLook.copy(camera.position).addScaledVector(dir, 24);
    if (orbit.controls.enabled) fromLook.copy(orbit.controls.target);
    toPos.copy(targetPos);
    toLook.copy(targetLook);
    after = next;
    transT = 0;
    setModeFlags('transition');
  };

  const enterFps = (): void => {
    // 从当前俯瞰点找一个最近的合法出生点，避免落在楼里
    let spawn = SPAWN.clone();
    const tx = orbit.controls.target.x;
    const tz = orbit.controls.target.z;
    if (walkable(tx, tz)) spawn.set(tx, EYE, tz);
    else {
      const gx = Math.round(tx);
      const gz = Math.round(tz);
      let best = Infinity;
      for (let r = 1; r <= 26 && best === Infinity; r += 1) {
        for (let a = 0; a < 16; a += 1) {
          const ang = (a / 16) * Math.PI * 2;
          const cx = gx + Math.cos(ang) * r;
          const cz = gz + Math.sin(ang) * r;
          if (!walkable(cx, cz)) continue;
          const d = (cx - tx) * (cx - tx) + (cz - tz) * (cz - tz);
          if (d < best) {
            best = d;
            spawn.set(cx, EYE, cz);
          }
        }
      }
    }
    player.copy(spawn);
    startTransition(spawn, SPAWN_LOOK, 'fps');
  };

  const enterOrbit = (): void => {
    // 回到俯瞰：把镜头拉到玩家上方偏后的位置，便于"看清自己刚才站的地方"
    const back = new THREE.Vector3();
    camera.getWorldDirection(back);
    back.y = 0;
    if (back.lengthSq() < 1e-4) back.set(0, 0, 1);
    back.normalize();
    const targetPos = player.clone().addScaledVector(back, -46);
    targetPos.y = 34;
    startTransition(targetPos, player.clone().setY(2), 'orbit');
  };

  const toggle = (): void => {
    if (mode === 'transition') return;
    if (mode === 'orbit') enterFps();
    else enterOrbit();
  };

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyV') {
      e.preventDefault();
      toggle();
      return;
    }
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));

  // 第一人称下点击画面即锁指针（鼠标锁是唯一能真正"看向四周"的方式）
  dom.addEventListener('click', () => {
    if (mode === 'fps' && !fps.isLocked) fps.lock();
  });
  fps.addEventListener('lock', () => setHint(false));
  fps.addEventListener('unlock', () => {
    if (mode === 'fps') setHint(true);
  });

  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  const moveFps = (dt: number): void => {
    if (!fps.isLocked) {
      setHint(true);
      camera.position.set(player.x, EYE, player.z);
      return;
    }
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-5) forward.set(0, 0, -1);
    forward.normalize();
    right.crossVectors(forward, up).normalize();

    let mx = 0;
    let mz = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) mz += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) mz -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) mx += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) mx -= 1;
    if (mx !== 0 || mz !== 0) {
      const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? RUN : WALK;
      const len = Math.hypot(mx, mz);
      const dx = ((forward.x * mz + right.x * mx) / len) * speed * dt;
      const dz = ((forward.z * mz + right.z * mx) / len) * speed * dt;
      // 轴分离：正面被挡时尝试只走一个轴，贴着墙滑而不是被粘住
      if (walkable(player.x + dx, player.z + dz)) {
        player.x += dx;
        player.z += dz;
      } else if (walkable(player.x + dx, player.z)) {
        player.x += dx;
      } else if (walkable(player.x, player.z + dz)) {
        player.z += dz;
      }
    }
    // 身高锁死在 1.7 m（不飞天、不遁地）
    camera.position.set(player.x, EYE, player.z);
  };

  const api: ViewMode = {
    get mode() {
      return mode;
    },
    get player() {
      return player;
    },
    toggle,
    toOrbit() {
      if (mode === 'fps') enterOrbit();
    },
    canStand(x: number, z: number) {
      return walkable(x, z);
    },
    debugRects() {
      if (fills === null) fills = fillColliders();
      if (villaWalls === null) villaWalls = villaColliders();
      if (scene && geomIndex === null) geomIndex = buildGeomIndex(scene);
      const geom: Rect[] = [];
      if (geomIndex) {
        const seen = new Set<Rect>();
        geomIndex.forEach((list) => {
          for (const r of list) {
            if (seen.has(r)) continue;
            seen.add(r);
            geom.push(r);
          }
        });
      }
      return [...coreBlockers(scene), ...fills, ...newBlockColliders(), ...villaWalls, ...geom];
    },
    update(delta: number) {
      if (mode === 'transition') {
        transT += (delta * 1000) / TRANSITION_MS;
        const k = ease(Math.min(1, transT));
        camera.position.lerpVectors(fromPos, toPos, k);
        const look = new THREE.Vector3().lerpVectors(fromLook, toLook, k);
        camera.lookAt(look);
        if (transT >= 1) {
          if (after === 'fps') {
            setModeFlags('fps');
            player.set(toPos.x, EYE, toPos.z);
            camera.position.set(player.x, EYE, player.z);
            camera.lookAt(toLook);
            setHint(true);
            fps.lock();
          } else {
            setModeFlags('orbit');
            orbit.controls.target.copy(toLook);
            orbit.controls.update();
          }
        }
        return;
      }
      if (mode === 'fps') {
        moveFps(delta);
        // 指针锁可能没拿到（自动化/被浏览器拒绝），此时相机仍需停在出生点
        yawPitchReady = fps.isLocked;
        void yawPitchReady;
      }
    },
  };

  return api;
}
