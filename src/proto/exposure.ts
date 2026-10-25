import * as THREE from 'three';
import { BASE } from '../world/layout';

/**
 * 光照危险图（《过街》的核心机制）。
 *
 * 规则很简单：**站在光里 = 会被远处的巡逻看到；站在暗处 = 只有很近才会被发现。**
 * 不叠任何线框 UI —— 玩家应该从画面本身读出"哪儿危险"。
 *
 * 实现：把场上所有点光/聚光的贡献按 1/(1+(d/r)²) 累加到一张 2 m 网格上，
 * 归一化成 0~1 的"暴露度"。这张图同时供
 *   ① 巡逻的视野射程（越亮看得越远）
 *   ② 玩家 HUD 的暴露提示
 *   ③ 调试用地面热力图（G 键）
 */

export interface ExposureField {
  /** 该点的暴露度 0~1（1 = 站在最亮的灯下） */
  at(x: number, z: number): number;
  /** 参与统计的真实光源数量 */
  readonly lightCount: number;
  /** 在某点压出一块暗区（青年拉闸灭灯） */
  dim(x: number, z: number, radius: number): void;
  /** 地面热力图（调试用，默认隐藏） */
  readonly overlay: THREE.Mesh;
  setOverlayVisible(v: boolean): void;
  readonly overlayVisible: boolean;
}

const CELL = 2;

export function buildExposure(scene: THREE.Scene): ExposureField {
  // —— 收集真实光源 ——
  const lights: Array<{ x: number; y: number; z: number; i: number; r: number }> = [];
  scene.traverse((o) => {
    const l = o as THREE.Light;
    if (!l.isLight) return;
    if (l.type !== 'PointLight' && l.type !== 'SpotLight') return;
    if (!l.visible) return;
    if (l.intensity <= 0.05) return;
    const d = (l as THREE.PointLight).distance;
    lights.push({
      x: l.position.x,
      y: l.position.y,
      z: l.position.z,
      i: l.intensity,
      r: d && d > 0 ? d : 18,
    });
  });

  const n = Math.ceil((BASE.half * 2) / CELL) + 1;
  const grid = new Float32Array(n * n);
  const cx = (i: number): number => -BASE.half + i * CELL;
  let max = 0;
  for (let iz = 0; iz < n; iz += 1) {
    for (let ix = 0; ix < n; ix += 1) {
      const x = cx(ix);
      const z = cx(iz);
      let sum = 0;
      for (const l of lights) {
        const dx = x - l.x;
        const dz = z - l.z;
        const dy = l.y - 1.2; // 以人的胸口高度取参考面
        const q = (dx * dx + dz * dz + dy * dy) / (l.r * l.r);
        sum += l.i / (1 + q * 3);
      }
      grid[iz * n + ix] = sum;
      if (sum > max) max = sum;
    }
  }
  if (max > 0) {
    for (let i = 0; i < grid.length; i += 1) grid[i] = grid[i]! / max;
  }

  const at = (x: number, z: number): number => {
    const ix = Math.round((x + BASE.half) / CELL);
    const iz = Math.round((z + BASE.half) / CELL);
    if (ix < 0 || iz < 0 || ix >= n || iz >= n) return 0;
    return grid[iz * n + ix] ?? 0;
  };

  // —— 调试热力图：一张覆盖底座的地面贴图 ——
  const canvas = document.createElement('canvas');
  canvas.width = n;
  canvas.height = n;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;

  /** 把 grid 画成贴图：冷蓝（安全）→ 暖黄（暴露） */
  const paint = (): void => {
    if (!ctx) return;
    const img = ctx.createImageData(n, n);
    for (let i = 0; i < grid.length; i += 1) {
      const v = grid[i]!;
      img.data[i * 4] = Math.round(40 + 215 * Math.min(1, v * 1.6));
      img.data[i * 4 + 1] = Math.round(90 + 120 * Math.min(1, v * 1.3));
      img.data[i * 4 + 2] = Math.round(190 - 150 * Math.min(1, v * 1.4));
      // 透明度压住：这是"辅助看地形"的图层，不是要把美术盖掉
      img.data[i * 4 + 3] = Math.round(12 + 88 * Math.min(1, v * 1.4));
    }
    ctx.putImageData(img, 0, 0);
    tex.needsUpdate = true;
  };
  paint();

  const geo = new THREE.PlaneGeometry(BASE.half * 2, BASE.half * 2);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const overlay = new THREE.Mesh(geo, mat);
  overlay.name = 'proto-exposure-overlay';
  overlay.position.y = 0.08;
  overlay.renderOrder = 3;
  overlay.visible = false;
  overlay.frustumCulled = false;
  scene.add(overlay);

  const field: ExposureField = {
    at,
    lightCount: lights.length,
    dim(x: number, z: number, radius: number) {
      const r2 = radius * radius;
      for (let iz = 0; iz < n; iz += 1) {
        for (let ix = 0; ix < n; ix += 1) {
          const dx = cx(ix) - x;
          const dz = cx(iz) - z;
          if (dx * dx + dz * dz > r2) continue;
          const i = iz * n + ix;
          grid[i] = (grid[i] ?? 0) * 0.12;
        }
      }
      paint();
    },
    overlay,
    overlayVisible: false,
    setOverlayVisible(v: boolean) {
      overlay.visible = v;
      (field as { overlayVisible: boolean }).overlayVisible = v;
    },
  };
  console.info(`[proto] 光照危险图 ${n}×${n}（${lights.length} 盏灯参与）`);
  return field;
}
