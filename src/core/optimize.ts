import * as THREE from 'three';
import { mergeOutlineHulls } from './geo';

/**
 * 运行时静态合批（不改变任何画面内容）。
 *
 * 起因：新增废墟扩建 / 全图路灯之后，场景到 1700 网格、1361 draw call、43 盏灯，
 * 帧时 27.8ms（36fps）。逐项 A/B 归因：
 *   - 只关掉所有灯        → 20.8ms（灯约 7ms）
 *   - 灯 + 描边壳 + 透明件全关 → 13.9ms（72fps）
 *
 * 这里做的是**零视觉损失**的那部分：描边壳本来只是同几何的 BackSide 外扩副本，
 * 逐个网格一次 draw call，合并成少数几条完全不损失轮廓。
 * 动画件必须排除，否则描边会留在原地、和本体脱开。
 */

/** 等 n 帧：动画由主循环驱动，必须让主循环真的跑起来，矩阵对比才有意义 */
function waitFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    let left = n;
    const step = (): void => {
      left -= 1;
      if (left <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function sameMatrix(a: THREE.Matrix4, b: THREE.Matrix4): boolean {
  const x = a.elements;
  const y = b.elements;
  for (let i = 0; i < 16; i += 1) {
    if (Math.abs(x[i]! - y[i]!) > 1e-6) return false;
  }
  return true;
}

export interface OptimizeStats {
  /** 带描边壳的宿主网格数 */
  hosts: number;
  /** 两帧之间发生位移（动画件）而跳过的宿主数 */
  dynamic: number;
  /** 合并前描边壳数量 */
  outlinesBefore: number;
  /** 合并后描边网格数量 */
  outlinesAfter: number;
  /** 因为挂在实例化网格上而保持原样（着色器依赖 instanceMatrix） */
  instancedHulls: number;
}

/**
 * 把所有**静态**网格的描边壳合并成少数几条 draw call。
 *
 * 动画检测用"两帧矩阵对比"：让主循环先跑一小会儿，对每个带描边壳的宿主采两次
 * matrixWorld，变了就是动画件（行走的士兵、行驶的载具、飘动的布、晃动的招牌）。
 * 这比维护"哪些模块会动"的白名单可靠 —— 白名单会随新模块加入而静默失效。
 */
export async function optimizeStaticOutlines(root: THREE.Object3D): Promise<OptimizeStats> {
  root.updateMatrixWorld(true);

  // —— 1. 采样：找出会动的宿主 ——
  const hosts: THREE.Mesh[] = [];
  let outlinesBefore = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.userData['isOutline']) {
      outlinesBefore += 1;
      return;
    }
    if (m.children.some((c) => (c as THREE.Mesh).userData['isOutline'])) hosts.push(m);
  });

  const before = hosts.map((h) => h.matrixWorld.clone());
  await waitFrames(14);
  root.updateMatrixWorld(true);

  const dynamic = new Set<THREE.Object3D>();
  hosts.forEach((h, i) => {
    if (!sameMatrix(h.matrixWorld, before[i]!)) dynamic.add(h);
  });

  // —— 2. 挑出必须留在原地的描边壳 ——
  const keep: Array<{ hull: THREE.Object3D; parent: THREE.Object3D }> = [];
  let instancedHulls = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.userData['isOutline']) return;
    const parent = m.parent;
    if (!parent) return;
    if ((parent as unknown as THREE.InstancedMesh).isInstancedMesh) {
      // 实例化描边的顶点着色器自己乘 instanceMatrix，烘平会全部塌到原点
      instancedHulls += 1;
      keep.push({ hull: m, parent });
      return;
    }
    let animated = false;
    for (let p: THREE.Object3D | null = parent; p; p = p.parent) {
      if (dynamic.has(p)) {
        animated = true;
        break;
      }
      if (p === root) break;
    }
    if (animated) keep.push({ hull: m, parent });
  });

  if (outlinesBefore <= 1) {
    const stats: OptimizeStats = { hosts: hosts.length, dynamic: dynamic.size, outlinesBefore, outlinesAfter: outlinesBefore, instancedHulls };
    console.info('[optimize] 描边壳过少，跳过合并');
    return stats;
  }

  // —— 3. 摘下需要保留的，合并剩下的，再原样挂回 ——
  const keepSet = new Set<THREE.Object3D>(keep.map((k) => k.hull));
  for (const { hull } of keep) hull.parent?.remove(hull);
  try {
    mergeOutlineHulls(root, 'static-outline');
  } finally {
    // 挂回原位：局部变换没有动过，直接 add 回同一个父节点即可
    for (const { hull, parent } of keep) parent.add(hull);
  }
  void keepSet;

  let outlinesAfter = 0;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.userData['isOutline']) outlinesAfter += 1;
  });

  const stats: OptimizeStats = {
    hosts: hosts.length,
    dynamic: dynamic.size,
    outlinesBefore,
    outlinesAfter,
    instancedHulls,
  };
  console.info(
    `[optimize] 静态描边合并：宿主 ${stats.hosts}（动画 ${stats.dynamic}）｜描边 ${stats.outlinesBefore} → ${stats.outlinesAfter}｜实例化保留 ${stats.instancedHulls}`,
  );
  return stats;
}
