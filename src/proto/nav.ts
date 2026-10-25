import * as THREE from 'three';
import { ALLEYS, BASE, HERO, HOTSPOTS, TOWN_PLOTS, type Rect } from '../world/layout';
import { fillColliders } from '../world/fill';
import { newBlockColliders } from '../world/newblocks';
import { villaColliders, villaDoors } from '../world/villa';
import { interiorApertures } from '../world/interiors';

/**
 * 原型用的可行走判定。
 *
 * 正式的 `ui/viewMode.ts` 里这套逻辑和第一人称相机耦合在一起，原型要独立一份，
 * 避免为了做游戏去改动已经在跑的美术场景。规则保持一致：
 *  - 地块矩形只挡"临街面往里的楼体进深"（地皮 ≠ 楼体）
 *  - 空地类地块（yard / ruin / shed）不整块挡人
 *  - 场景几何按包围盒补障碍（跨度 ≤26 m、高度 >1.35 m、非透明、非实例化）
 *  - 设计巷道与门洞永远放行
 */

const RADIUS = 0.35;
const BUILD_DEPTH = 12;
const GEOM_CELL = 8;
const SOLID_AREA_LIMIT = 45;

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

export interface Nav {
  canStand(x: number, z: number): boolean;
  /** 线段是否被实体挡住（视线判定用） */
  blocked(x0: number, z0: number, x1: number, z1: number): boolean;
  rects(): Rect[];
}

const cellKey = (cx: number, cz: number): string => `${cx}_${cz}`;

export function createNav(scene: THREE.Scene): Nav {
  const plots: Rect[] = [
    ...TOWN_PLOTS.filter((p) => p.kind !== 'yard' && p.kind !== 'ruin' && p.kind !== 'shed').map(plotSolid),
    { x0: HERO.x0, x1: HERO.x1, z0: HERO.z0, z1: HERO.z1 },
    { x0: HOTSPOTS.bmpt.x - 1.8, x1: HOTSPOTS.bmpt.x + 1.8, z0: HOTSPOTS.bmpt.z - 3.6, z1: HOTSPOTS.bmpt.z + 3.6 },
    { x0: HOTSPOTS.t72.x - 1.8, x1: HOTSPOTS.t72.x + 1.8, z0: HOTSPOTS.t72.z - 3.6, z1: HOTSPOTS.t72.z + 3.6 },
  ];

  // —— 几何障碍（同 viewMode 的规则）——
  const index = new Map<string, Rect[]>();
  const all: Rect[] = [];
  const box = new THREE.Box3();
  const NOT_SOLID = /^(sky-dome|edge-fog|far-|cloud-shadow|skyline|fx-|lamp-cone|halo)/;
  const SELF_COLLIDED = /^(custom-villa|diorama-fx|sky-dome|skyline|edge-fog)/;
  const owned = (o: THREE.Object3D, pat: RegExp): boolean => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) {
      if (p.name && pat.test(p.name)) return true;
    }
    return false;
  };
  const push = (r: Rect): void => {
    all.push(r);
    const cx0 = Math.floor(r.x0 / GEOM_CELL);
    const cx1 = Math.floor(r.x1 / GEOM_CELL);
    const cz0 = Math.floor(r.z0 / GEOM_CELL);
    const cz1 = Math.floor(r.z1 / GEOM_CELL);
    for (let cz = cz0; cz <= cz1; cz += 1) {
      for (let cx = cx0; cx <= cx1; cx += 1) {
        const k = cellKey(cx, cz);
        const list = index.get(k);
        if (list) list.push(r);
        else index.set(k, [r]);
      }
    }
  };
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    if (m.userData['isOutline']) return;
    if ((m as unknown as THREE.InstancedMesh).isInstancedMesh) return;
    if (owned(m, NOT_SOLID) || owned(m, SELF_COLLIDED)) return;
    const mat = m.material as THREE.Material | THREE.Material[];
    if (Array.isArray(mat) ? mat.some((x) => x.transparent) : mat?.transparent) return;
    if (!m.geometry) return;
    box.setFromObject(m);
    if (!Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) return;
    const sx = box.max.x - box.min.x;
    const sz = box.max.z - box.min.z;
    if (box.max.y < 1.35) return;
    if (sx > 26 || sz > 26) return;
    if (sx * sz < 0.3) return;
    const inCore = Math.abs((box.min.x + box.max.x) / 2) <= 92 && Math.abs((box.min.z + box.max.z) / 2) <= 92;
    if (inCore && sx * sz > SOLID_AREA_LIMIT) return;
    push({ x0: box.min.x, x1: box.max.x, z0: box.min.z, z1: box.max.z });
  });

  const hit = (r: Rect, x: number, z: number, pad = RADIUS): boolean =>
    x > r.x0 - pad && x < r.x1 + pad && z > r.z0 - pad && z < r.z1 + pad;

  const canStand = (x: number, z: number): boolean => {
    if (Math.abs(x) > BASE.half - 3 || Math.abs(z) > BASE.half - 3) return false;
    if (interiorApertures().some((r) => hit(r, x, z))) return true;
    if (villaDoors().some((r) => hit(r, x, z))) return true;
    // 设计巷道永远通：它们本来就夹在两个地块矩形之间
    if (ALLEYS.some((r) => hit(r, x, z))) return true;
    const cx = Math.floor(x / GEOM_CELL);
    const cz = Math.floor(z / GEOM_CELL);
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const list = index.get(cellKey(cx + dx, cz + dz));
        if (list && list.some((r) => hit(r, x, z))) return false;
      }
    }
    if (plots.some((r) => hit(r, x, z))) return false;
    if (fillColliders().some((r) => hit(r, x, z))) return false;
    if (newBlockColliders().some((r) => hit(r, x, z))) return false;
    if (villaColliders().some((r) => hit(r, x, z))) return false;
    return true;
  };

  /** 视线：沿线段每 0.6 m 采样，命中任一实体矩形即视为被挡 */
  const blocked = (x0: number, z0: number, x1: number, z1: number): boolean => {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const dist = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(dist / 0.6));
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const x = x0 + dx * t;
      const z = z0 + dz * t;
      const cx = Math.floor(x / GEOM_CELL);
      const cz = Math.floor(z / GEOM_CELL);
      let solid = false;
      for (let gz = -1; gz <= 1 && !solid; gz += 1) {
        for (let gx = -1; gx <= 1 && !solid; gx += 1) {
          const list = index.get(cellKey(cx + gx, cz + gz));
          if (list && list.some((r) => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1)) solid = true;
        }
      }
      if (solid) return true;
      if (plots.some((r) => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1)) return true;
    }
    return false;
  };

  return { canStand, blocked, rects: () => all };
}
