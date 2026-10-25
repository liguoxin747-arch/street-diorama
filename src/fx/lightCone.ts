import * as THREE from 'three';
import { canvasTexture, registerNightGlow } from '../core/materials';
import type { Ticker } from '../core/ticker';

/**
 * 假体积光锥（丁达尔柱）。
 *
 * 雨夜里有雾有雨，灯头下方本该出现一段可见光柱。真做体积渲染要射线步进，
 * 代价与这里的收益不成比例，所以用**倒置圆锥 + 沿高度渐隐的加色面片**：
 *  - 锥尖在灯头，开口朝地面，半径按灯的实际照射角给；
 *  - FrontSide + AdditiveBlending：只叠一层，中心不会亮成实心块；密度感交给贴图自身的渐隐曲线；
 *  - 只走自发光注册（registerNightGlow），白天被昼夜装置压到待机，不会在正午发光。
 */

export interface LightConeSpec {
  /** 灯头世界坐标 */
  x: number;
  y: number;
  z: number;
  /** 光柱落到地面的高度 */
  height: number;
  /** 地面光斑半径 */
  radius: number;
  color: number;
  opacity: number;
  /** 传了 ticker 就启用『靠近淡出』：贴着灯站时光柱会糊满整屏 */
  ticker?: Ticker;
}

/**
 * 观察者相机由 main.ts 在建好相机后注入：光柱的淡出要按『灯到相机的距离』算，
 * 而光源是建场景时注册的，那时相机还不存在。
 */
let viewer: THREE.Camera | null = null;

export function setLightConeViewer(cam: THREE.Camera): void {
  viewer = cam;
}

let alphaTex: THREE.CanvasTexture | null = null;

export function coneAlphaTexture(): THREE.CanvasTexture {
  if (alphaTex) return alphaTex;
  alphaTex = canvasTexture(16, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    // canvas 顶行对应 v=1（锥尖/灯头），底行对应 v=0（地面）
    const g = c.createLinearGradient(0, 0, 0, h);
    // 锥尖那一圈要淡：站得近时相机几乎贴着灯头，若顶点最亮就会糊成一块实心色块
    g.addColorStop(0, 'rgba(255,255,255,0.12)');
    g.addColorStop(0.18, 'rgba(255,255,255,0.42)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.16)');
    g.addColorStop(0.8, 'rgba(255,255,255,0.03)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  });
  return alphaTex;
}

/**
 * 轮廓渐隐：把 alpha 乘上 |法线·视线| 的幂。
 * 圆锥侧面正对镜头处最实，转到掠射（屏幕上那两条直边）时归零。
 * 没有这一项，光柱在远处就是几个亮三角；有了它才读成"一段散开的光"。
 */
function softenSilhouette(mat: THREE.MeshBasicMaterial, power: number): void {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vConeSil;')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        {
          vec4 mv = modelViewMatrix * vec4( transformed, 1.0 );
          vec3 n = normalize( normalMatrix * normal );
          vec3 v = normalize( -mv.xyz );
          vConeSil = abs( dot( n, v ) );
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vConeSil;')
      .replace(
        '#include <dithering_fragment>',
        /* glsl */ `#include <dithering_fragment>
        gl_FragColor.a *= pow( clamp( vConeSil, 0.0, 1.0 ), ${power.toFixed(2)} );`,
      );
  };
}

export function lightCone(spec: LightConeSpec): THREE.Mesh {
  const geo = new THREE.ConeGeometry(spec.radius, spec.height, 18, 1, true);
  // 锥尖移到原点，锥体向下张开
  geo.translate(0, -spec.height / 2, 0);
  const mat = new THREE.MeshBasicMaterial({
    color: spec.color,
    alphaMap: coneAlphaTexture(),
    transparent: true,
    opacity: spec.opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    // 单面：双面会把正反面两层加色叠在一起，中心亮成一块实心三角
    side: THREE.FrontSide,
    fog: false,
    toneMapped: false,
  });
  softenSilhouette(mat, 1.6);
  registerNightGlow(mat);
  const m = new THREE.Mesh(geo, mat);
  m.name = 'light-cone';
  m.position.set(spec.x, spec.y, spec.z);
  m.renderOrder = 3;
  m.castShadow = false;
  m.receiveShadow = false;
  m.frustumCulled = true;
  if (spec.ticker) {
    const baseColor = new THREE.Color(spec.color);
    const anchor = new THREE.Vector3(spec.x, spec.y - spec.height / 2, spec.z);
    spec.ticker.add(() => {
      if (!viewer) return;
      const d = viewer.position.distanceTo(anchor);
      // 7 m 内基本收干净，16 m 外满强度；加色混合下压颜色就是压亮度，不碰 opacity
      const k = THREE.MathUtils.clamp((d - 7) / 9, 0, 1);
      mat.color.copy(baseColor).multiplyScalar(0.1 + 0.9 * k * k);
    });
  }
  return m;
}
