import * as THREE from 'three';
import type { Rect } from '../world/layout';

/**
 * 碰撞体可视化（按 M 切换）。
 *
 * 目的：让"空气墙"变成可肉眼排查的东西。当前工程的碰撞体**不是** Box3().setFromObject()
 * 生成的（合批后的批次盒会覆盖整个街区），而是设计数据里的精确矩形：
 *  - 建筑足迹（TOWN_PLOTS / 主楼）
 *  - 街心大型停置物（BMPT / 被毁 T-72 / 烧毁轿车）
 *  - 空地填充物的中央主体（fill.ts）
 * 这里把它们画成线框，橙色 = 建筑/停置物，青色 = 填充物。
 */

export interface ColliderDebug {
  readonly visible: boolean;
  toggle(): void;
  setVisible(v: boolean): void;
  readonly count: number;
}

export function createColliderDebug(scene: THREE.Scene, rects: () => Rect[]): ColliderDebug {
  const group = new THREE.Group();
  group.name = 'collider-debug';
  group.visible = false;
  scene.add(group);

  const building = new THREE.Color(0xff9a3c);
  const fillColor = new THREE.Color(0x54e0d0);

  let built = false;
  let count = 0;

  const build = (): void => {
    if (built) return;
    built = true;
    const all = rects();
    // 前 N 个是建筑/停置物，其后是填充物：按数量无法区分，所以用位置判一次
    // 更稳妥的做法是两次取数：这里直接按"是否在地块网格里"着色
    all.forEach((r) => {
      const box = new THREE.Box3(
        new THREE.Vector3(r.x0, 0, r.z0),
        new THREE.Vector3(r.x1, 3.2, r.z1),
      );
      const isFill = !inPlots(r);
      const helper = new THREE.Box3Helper(box, isFill ? fillColor : building);
      helper.renderOrder = 20;
      (helper as unknown as { material: THREE.LineBasicMaterial }).material.depthTest = false;
      (helper as unknown as { material: THREE.LineBasicMaterial }).material.transparent = true;
      (helper as unknown as { material: THREE.LineBasicMaterial }).material.opacity = 0.85;
      group.add(helper);
    });
    count = group.children.length;
  };

  const api: ColliderDebug = {
    get visible() {
      return group.visible;
    },
    get count() {
      return count;
    },
    setVisible(v: boolean) {
      if (v) build();
      group.visible = v;
    },
    toggle() {
      api.setVisible(!group.visible);
    },
  };
  return api;
}

/** 粗略判断一个矩形是否落在核心地块网格上（只用于调试着色） */
function inPlots(r: Rect): boolean {
  return Math.abs((r.x0 + r.x1) / 2) <= 72 && Math.abs((r.z0 + r.z1) / 2) <= 72;
}
