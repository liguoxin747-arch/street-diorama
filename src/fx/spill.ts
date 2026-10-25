import * as THREE from 'three';
import { canvasTexture, registerNightGlow } from '../core/materials';
import type { BuildContext } from '../core/context';

/**
 * 湿地面反光条：雨夜的灵魂。
 * 在路灯/火光/橱窗正下方的湿路面上铺一道拉长的暖色光斑（加色混合），
 * 让"街道路面积水反射灯光与火光"真正读得出来。
 * 灯光位置与 props/fx 模块保持一致的硬编码清单。
 */

interface LightSpill {
  x: number;
  z: number;
  color: number;
  /** 光斑长度（沿光源主轴） */
  len: number;
  width: number;
  strength: number;
  /** 光斑朝向（弧度，0 = 沿 +Z 拉长） */
  rot: number;
  /** 轻微闪烁幅度（0 = 恒定） */
  flicker: number;
}

/**
 * 只保留火光、橱窗、信号灯这些固定点位。
 * 路灯反光改由 world/streetlights.ts 按真实灯位生成，并合成到一张 InstancedMesh 里；
 * 旧的手写路灯反光清单在路灯改成全图程序化后必然对不上灯头，已经删掉。
 */
const SPILLS: LightSpill[] = [
  // 火光（橙）——路边小火，光斑更小更跳
  { x: 6.9, z: 11.4, color: 0xff8a3c, len: 7, width: 4.6, strength: 0.55, rot: 0, flicker: 0.4 },
  { x: -19.2, z: -4.9, color: 0xff8a3c, len: 7.5, width: 4.8, strength: 0.5, rot: 0, flicker: 0.3 },
  { x: 24.4, z: 9.6, color: 0xff8a3c, len: 6.5, width: 4.2, strength: 0.5, rot: 0, flicker: 0.45 },
  // T-72 余烬（暗橙，大而弱）
  { x: 27.5, z: 3.2, color: 0xff7a3a, len: 12, width: 8, strength: 0.28, rot: Math.PI / 2.4, flicker: 0.25 },
  // 主楼底商橱窗（大面积暖光从橱窗淌到人行道）
  { x: 16.5, z: -10.5, color: 0xffb765, len: 10, width: 4.2, strength: 0.4, rot: Math.PI / 2, flicker: 0.08 },
  { x: 20.5, z: -10.5, color: 0xffb765, len: 10, width: 4.2, strength: 0.35, rot: Math.PI / 2, flicker: 0.08 },
  // 远处路口的红绿灯微光
  { x: 10.4, z: -10.6, color: 0xff4b3e, len: 5, width: 2.2, strength: 0.18, rot: Math.PI / 2, flicker: 0 },
];

/** 一个柔和的、两端渐隐的光斑贴图（路灯实例化反光复用同一张） */
export function spillTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 256, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    // 沿长度方向的渐变（两端淡出）
    const along = c.createLinearGradient(0, 0, 0, h);
    along.addColorStop(0, 'rgba(255,255,255,0)');
    along.addColorStop(0.18, 'rgba(255,255,255,0.85)');
    along.addColorStop(0.5, 'rgba(255,255,255,0.6)');
    along.addColorStop(0.82, 'rgba(255,255,255,0.85)');
    along.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = along;
    c.fillRect(0, 0, w, h);
    // 沿宽度方向的渐变（中间亮，两侧淡）
    c.globalCompositeOperation = 'destination-in';
    const across = c.createLinearGradient(0, 0, w, 0);
    across.addColorStop(0, 'rgba(255,255,255,0)');
    across.addColorStop(0.5, 'rgba(255,255,255,1)');
    across.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = across;
    c.fillRect(0, 0, w, h);
    c.globalCompositeOperation = 'source-over';
    // 轻微的碎波纹（雨夜水面感）
    c.globalAlpha = 0.12;
    c.strokeStyle = '#ffffff';
    for (let i = 0; i < 16; i += 1) {
      const y = ((i * 37) % h) | 0;
      const x0 = ((i * 53) % (w * 0.3)) | 0;
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(x0, y);
      c.bezierCurveTo(x0 + w * 0.1, y + 3, x0 + w * 0.2, y - 3, Math.min(w, x0 + w * 0.3), y);
      c.stroke();
    }
    c.globalAlpha = 1;
  });
}

export function buildLightSpills(ctx: BuildContext): void {
  const tex = spillTexture();
  const matCache = new Map<string, THREE.MeshBasicMaterial>();
  const root = new THREE.Group();
  root.name = 'wet-light-spills';

  SPILLS.forEach((spill, index) => {
    const key = `${spill.color}|${spill.strength}|${spill.flicker}`;
    let mat = matCache.get(key);
    if (!mat) {
      mat = registerNightGlow(new THREE.MeshBasicMaterial({
        map: tex,
        color: spill.color,
        transparent: true,
        opacity: spill.strength,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }));
      matCache.set(key, mat);
    }
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(spill.width * 1.2, spill.len * 1.3), mat);
    plane.rotation.x = -Math.PI / 2;
    plane.rotation.z = spill.rot;
    plane.position.set(spill.x, 0.14, spill.z);
    plane.renderOrder = 5;
    plane.castShadow = false;
    plane.receiveShadow = false;
    root.add(plane);
    if (spill.flicker > 0) {
      const baseOpacity = spill.strength;
      ctx.ticker.add((t) => {
        const n =
          0.86 +
          0.14 * Math.sin(t * (2.3 + index * 0.7) + index * 1.7) +
          spill.flicker * 0.35 * Math.sin(t * 11.7 + index * 3.1);
        mat.opacity = baseOpacity * Math.max(0.55, n);
      });
    }
  });

  ctx.addFx(root);
}
