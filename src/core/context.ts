import * as THREE from 'three';
import type { Rng } from './rng';
import type { Ticker } from './ticker';

/**
 * 建造上下文：所有子模块（建筑、道具、载具、天气）都通过它拿到
 * 随机源、时间驱动、以及统一的挂载点，互不直接依赖。
 */
export interface BuildContext {
  /** 场景根节点（一切可见物体都挂在这里） */
  readonly root: THREE.Group;
  /** 特效层（雨、烟、火花），稍后于实体渲染 */
  readonly fx: THREE.Group;
  /** 世界随机源 */
  readonly rng: Rng;
  /** 时间驱动 */
  readonly ticker: Ticker;
  /** 画质系数：1 为完整细节，0.6 为轻量 */
  readonly quality: number;
  /** 挂实体 */
  add(obj: THREE.Object3D): void;
  /** 挂特效 */
  addFx(obj: THREE.Object3D): void;
  /** 注册点光（内部会按数量上限裁剪，保证帧率） */
  addLight(light: THREE.Light): THREE.Light;
  /** 已注册点光数量 */
  readonly lightCount: number;
}

// 31 盏既有灯 + 剖切楼/防空洞工作灯 + 油桶/弹坑灯/照明弹 + 倒杆短路火花
// （新增灯一律常驻，空闲时 intensity=0，避免灯数变化触发着色器重编译）
export const MAX_POINT_LIGHTS = 39;

export function createContext(scene: THREE.Scene, rng: Rng, ticker: Ticker, quality = 1): BuildContext {
  const root = new THREE.Group();
  root.name = 'diorama-root';
  const fx = new THREE.Group();
  fx.name = 'diorama-fx';
  const lights: THREE.Light[] = [];
  scene.add(root);
  scene.add(fx);

  const ctx: BuildContext = {
    root,
    fx,
    rng,
    ticker,
    quality,
    add(obj) {
      root.add(obj);
    },
    addFx(obj) {
      fx.add(obj);
    },
    addLight(light) {
      // 同一位置的重复光源直接忽略（不同模块容易在同一个灶台/火堆各加一盏）
      const pos = light.position;
      const duplicated = lights.some(
        (l) => l.position.distanceToSquared(pos) < 2.25 && l.type === light.type,
      );
      if (!duplicated && lights.length < MAX_POINT_LIGHTS) {
        lights.push(light);
        root.add(light);
        return light;
      }
      return light;
    },
    get lightCount() {
      return lights.length;
    },
  };
  return ctx;
}
