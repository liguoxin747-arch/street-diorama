import * as THREE from 'three';
import type { BuildContext } from '../core/context';
import { canvasTexture } from '../core/materials';
import { group, instanced, type InstanceTransform } from '../core/geo';
import { collectPanes } from './windowLights';
import type { Rect } from './layout';

/**
 * 选项 A：外观完整 + 内构只做"深色凹洞"。
 *
 * 不做真楼板/真家具，因此不存在"楼板穿墙"这类事故。
 * 利用现成事实：town.ts 的窗玻璃嵌在窗洞**深处**（墙里退 2 cm 的玻璃面片，
 * 前面还有约 0.5 m 的洞口进深）。在玻璃前 1.2 cm 放一张暗色卡片，
 * 它稳稳在凹洞里（离墙面仍有 0.8 cm），从街上看到的是"有进深的暗窗"。
 *
 * 三张程序化贴图轮换：顶部一线冷天光、下半沉黑、角落一小团暖光、几件家具剪影。
 * 全部实例化，三个 draw call 封顶。
 */

/** 只做这一栋：大道北侧三层住宅（正面朝大道，用标准玻璃材质，可被窗面采集识别） */
const TARGET: Rect[] = [{ x0: 14, x1: 30, z0: -50, z1: -37 }];

function cardTexture(variant: number): THREE.Texture {
  return canvasTexture(64, 96, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    // 上方是窗外漏进来的冷天光，越往里越黑
    g.addColorStop(0, variant === 0 ? '#2c3033' : variant === 1 ? '#272a2c' : '#31302b');
    g.addColorStop(0.42, '#15171a');
    g.addColorStop(1, '#07080a');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    // 家具剪影：一只柜子 + 一把椅子
    c.fillStyle = 'rgba(8,9,11,0.85)';
    c.fillRect(w * (variant === 1 ? 0.08 : 0.5), h * 0.46, w * 0.34, h * 0.5);
    c.fillRect(w * 0.62, h * 0.62, w * 0.22, h * 0.3);
    // 一小团暖光（残留灯火），成对出现：地面一小块 + 墙上一点
    c.fillStyle = 'rgba(196,128,64,0.30)';
    c.beginPath();
    c.arc(w * (variant === 2 ? 0.24 : 0.72), h * 0.74, w * 0.16, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = 'rgba(224,160,92,0.18)';
    c.beginPath();
    c.arc(w * (variant === 2 ? 0.24 : 0.72), h * 0.7, w * 0.07, 0, Math.PI * 2);
    c.fill();
    // 窗框投影：四周一圈更暗，强化"洞"的感觉
    c.strokeStyle = 'rgba(0,0,0,0.55)';
    c.lineWidth = 5;
    c.strokeRect(0, 0, w, h);
  });
}

export function buildInteriorCards(ctx: BuildContext): THREE.Group {
  const root = group('interior-cards');
  const panes = collectPanes(ctx.root).filter((p) =>
    TARGET.some((r) => p.center.x > r.x0 && p.center.x < r.x1 && p.center.z > r.z0 && p.center.z < r.z1),
  );

  const buckets: InstanceTransform[][] = [[], [], []];
  const up = new THREE.Vector3(0, 0, 1);
  panes.forEach((pane, i) => {
    const q = new THREE.Quaternion().setFromUnitVectors(up, pane.normal);
    // 玻璃在墙里退 2 cm；卡片放在它前面 1.2 cm（离墙面还有 0.8 cm，仍在窗洞里）
    const pos = pane.center.clone().addScaledVector(pane.normal, 0.012);
    const bucket = buckets[i % 3]!;
    bucket.push({
      position: pos,
      rotation: new THREE.Euler().setFromQuaternion(q),
      scale: new THREE.Vector3(pane.w * 0.98, pane.h * 0.98, 1),
    });
  });

  buckets.forEach((list, v) => {
    if (list.length === 0) return;
    const mat = new THREE.MeshBasicMaterial({ map: cardTexture(v), fog: true, color: 0xffffff });
    const inst = instanced(new THREE.PlaneGeometry(1, 1), mat, list);
    inst.name = `interior-cards-${v}`;
    inst.castShadow = false;
    inst.receiveShadow = false;
    root.add(inst);
  });

  console.info(`[interior-cards] 暗窗卡片 ${panes.length} 片（目标 1 栋 / ${TARGET[0]!.x0}..${TARGET[0]!.x1}）`);
  void ctx;
  return root;
}
