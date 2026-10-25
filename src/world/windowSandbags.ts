import * as THREE from 'three';
import type { BuildContext } from '../core/context';
import { group, instanced, softBox, type InstanceTransform } from '../core/geo';
import { PALETTE } from '../core/palette';
import { toonMaterial } from '../core/materials';
import { collectPanes } from './windowLights';

/**
 * 沙袋加固窗口（全图）。
 *
 * 这是清单里唯一 town.ts 没做的项：其它战损（剥落墙皮/错缝砖芯/破玻璃/
 * 弹孔崩裂环/坍塌阳台/裸露钢筋/封窗木板/卷帘门/歪招牌/屋顶破损/墙根瓦砾）
 * 在 town.ts 里对每个地块都已执行。
 *
 * 做法：复用 windowLights 的窗面采集（860 余扇窗，含位置/法线/尺寸），
 * 在窗台下沿外侧堆 2~3 袋沙袋，全部实例化 —— 1 个 draw call。
 * 只挑低层窗（一层为主、二层少量），高层堆沙袋不合常理。
 */

const M = {
  bag: toonMaterial(PALETTE.sandbag, { steps: 2 }),
  bagDark: toonMaterial(PALETTE.sandbagDark, { steps: 2 }),
};

export function buildWindowSandbags(ctx: BuildContext): THREE.Group {
  const root = group('window-sandbags');
  const rng = ctx.rng.fork(0x5a17);
  const panes = collectPanes(ctx.root);

  const light: InstanceTransform[] = [];
  const dark: InstanceTransform[] = [];
  const up = new THREE.Vector3(0, 1, 0);

  for (const pane of panes) {
    const y = pane.center.y;
    // 一层（离地 0.6~4.4 m）概率高，二层（<8 m）少量，高层不堆
    let chance = 0;
    if (y > 0.6 && y < 4.4) chance = 0.34;
    else if (y < 8) chance = 0.12;
    if (chance === 0 || !rng.chance(chance)) continue;

    const yaw = Math.atan2(pane.normal.x, pane.normal.z);
    const base = pane.center.clone().addScaledVector(pane.normal, 0.2);
    base.y = y - pane.h * 0.5 + 0.11;
    if (base.y < 0.25) base.y = 0.25;

    // 沿窗宽方向铺 2~3 袋，错缝两层
    const n = pane.w > 1.1 ? 3 : 2;
    for (let i = 0; i < n; i += 1) {
      const offset = (i - (n - 1) / 2) * 0.42;
      const p = base.clone().addScaledVector(new THREE.Vector3(pane.normal.z, 0, -pane.normal.x), offset);
      p.y += rng.range(-0.02, 0.03);
      (rng.chance(0.6) ? light : dark).push({
        position: p,
        rotation: new THREE.Euler(rng.range(-0.05, 0.05), yaw + rng.range(-0.12, 0.12), rng.range(-0.05, 0.05)),
        scale: new THREE.Vector3(rng.range(0.9, 1.1), rng.range(0.9, 1.15), rng.range(0.9, 1.1)),
      });
    }
    // 顶层再压一袋，形成"沙袋墙"的错缝感
    if (rng.chance(0.55)) {
      const p2 = base.clone().addScaledVector(pane.normal, -0.02);
      p2.y += 0.2;
      (rng.chance(0.5) ? light : dark).push({
        position: p2,
        rotation: new THREE.Euler(0, yaw + rng.range(-0.2, 0.2), rng.range(-0.06, 0.06)),
        scale: new THREE.Vector3(0.92, 1, 0.95),
      });
    }
  }

  const geo = softBox(0.62, 0.24, 0.36, 0.14, M.bag).geometry;
  for (const [list, mat, name] of [
    [light, M.bag, 'window-sandbags-a'],
    [dark, M.bagDark, 'window-sandbags-b'],
  ] as Array<[InstanceTransform[], THREE.Material, string]>) {
    if (list.length === 0) continue;
    const inst = instanced(geo, mat, list);
    inst.name = name;
    inst.castShadow = false;
    inst.receiveShadow = true;
    root.add(inst);
  }

  void up;
  console.info(`[window-sandbags] 窗台沙袋 ${light.length + dark.length} 袋（${panes.length} 扇窗中筛出）`);
  return root;
}
