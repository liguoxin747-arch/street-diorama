import * as THREE from 'three';
import type { BuildContext } from '../core/context';
import { canvasTexture } from '../core/materials';
import { WARZONE } from '../world/warzone';

/**
 * 战场级光照事件：
 *  - 高空照明弹：随机时刻点火、缓慢下落，冷白点光把整盘废墟短暂点亮；
 *  - 倒杆断口的电火花：蓝白粒子弧 + 点光频闪。
 *
 * 两盏点光从建场起就常驻（空闲时 intensity=0），避免"灯数变化 → 着色器重编译"的卡顿。
 */

const FLARE_INTERVAL = 26;
const FLARE_FALL = 6.2;

let triggerHook: (() => void) | null = null;
let activeHook: (() => boolean) | null = null;

/** 供调试/验收脚本调用：立刻放一颗照明弹 */
export function triggerFlare(): void {
  triggerHook?.();
}

export function flareActive(): boolean {
  return activeHook?.() ?? false;
}

function glowTexture(seed: number): THREE.CanvasTexture {
  return canvasTexture(128, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.5);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.12, 'rgba(236,246,255,1)');
    g.addColorStop(0.3, 'rgba(176,214,255,0.7)');
    g.addColorStop(0.62, 'rgba(120,170,230,0.16)');
    g.addColorStop(1, 'rgba(80,130,200,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    // 十字芒
    c.globalCompositeOperation = 'lighter';
    c.strokeStyle = 'rgba(220,238,255,0.5)';
    c.lineWidth = 1.4;
    for (const a of [0, Math.PI / 2, Math.PI / 4, -Math.PI / 4]) {
      c.beginPath();
      c.moveTo(w / 2 - Math.cos(a) * w * 0.46, h / 2 - Math.sin(a) * h * 0.46);
      c.lineTo(w / 2 + Math.cos(a) * w * 0.46, h / 2 + Math.sin(a) * h * 0.46);
      c.stroke();
    }
    c.globalCompositeOperation = 'source-over';
    void seed;
  });
}

function sparkTexture(): THREE.CanvasTexture {
  return canvasTexture(32, 32, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(205,235,255,0.95)');
    g.addColorStop(0.6, 'rgba(120,190,255,0.3)');
    g.addColorStop(1, 'rgba(80,150,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  });
}

export function buildBattlefieldFx(ctx: BuildContext): THREE.Group {
  const root = new THREE.Group();
  root.name = 'fx-battlefield';
  const rng = ctx.rng.fork(0x51a1);

  /* ------------------------------------------------------------------ *
   * 1. 照明弹
   * ------------------------------------------------------------------ */
  const flare = new THREE.Group();
  flare.name = 'fx-flare';
  flare.visible = false;
  const flareMap = glowTexture(3);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: flareMap,
    color: new THREE.Color(1.8, 2.1, 2.4),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  }));
  halo.scale.setScalar(10);
  const core = new THREE.Sprite(new THREE.SpriteMaterial({
    map: flareMap,
    color: new THREE.Color(4.5, 5.0, 5.4),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  }));
  core.scale.setScalar(3.6);
  flare.add(halo, core);
  root.add(flare);

  const flareLight = new THREE.PointLight(0xdfeaff, 0, 260, 1.1);
  flareLight.name = 'fx-flare-light';
  flareLight.castShadow = false;
  flareLight.visible = true;
  // 先放到高空再登记：addLight 会忽略 1.5 m 内的同型重复灯
  flareLight.position.set(0, 200, 0);
  ctx.addLight(flareLight);

  let active = false;
  let forced = false;
  let started = 0;
  let nextAt = 9;
  let fx = 0;
  let fz = 20;
  let fy = 62;

  const startFlare = (t: number): void => {
    active = true;
    started = t;
    // 从场景外侧斜落，避免每颗都在画面正中
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(22, 52);
    fx = Math.cos(a) * r + 2;
    fz = Math.sin(a) * r + 6;
    fy = 66;
    flare.visible = true;
  };

  triggerHook = () => {
    forced = true;
  };
  activeHook = () => active;

  /* ------------------------------------------------------------------ *
   * 2. 倒杆电火花
   * ------------------------------------------------------------------ */
  const sparkSites = WARZONE.fallenSparks;
  const NEAR = sparkSites[0]!;
  const sparkCount = 96;
  const origins = new Float32Array(sparkCount * 3);
  const params = new Float32Array(sparkCount * 4);
  for (let i = 0; i < sparkCount; i += 1) {
    const site = sparkSites[i % sparkSites.length]!;
    const o = i * 3;
    origins[o] = site.x + rng.range(-0.26, 0.26);
    origins[o + 1] = 0.52 + rng.range(-0.08, 0.16);
    origins[o + 2] = site.z + rng.range(-0.26, 0.26);
    const q = i * 4;
    params[q] = rng.range(1.1, 3.2);
    params[q + 1] = rng.next();
    params[q + 2] = rng.range(1.2, 3.0);
    params[q + 3] = rng.range(0.1, 0.21);
  }
  // Points 不支持 InstancedBufferGeometry：把每个粒子展开成独立顶点
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sparkCount * 3), 3));
  sparkGeo.setAttribute('aOrigin', new THREE.BufferAttribute(origins, 3));
  sparkGeo.setAttribute('aParam', new THREE.BufferAttribute(params, 4));
  sparkGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(NEAR.x, 1, NEAR.z), 180);
  const sparkMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uMap: { value: sparkTexture() },
      uPixelScale: { value: 1 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uPixelScale;
      attribute vec3 aOrigin;
      attribute vec4 aParam;
      varying float vAlpha;
      varying float vSeed;
      void main() {
        float cycle = fract(uTime / aParam.x + aParam.y);
        float live = 1.0 - step(0.28, cycle);
        float k = clamp(cycle / 0.28, 0.0, 1.0);
        float ang = aParam.y * 62.83;
        float speed = aParam.z;
        vec3 vel = vec3(cos(ang) * speed * 0.9, 1.7 + aParam.z * 0.4, sin(ang) * speed * 0.7);
        vec3 world = aOrigin + vel * k + vec3(0.0, -4.6, 0.0) * k * k;
        vAlpha = live * smoothstep(0.0, 0.06, cycle) * pow(1.0 - k, 1.3);
        vSeed = aParam.y;
        vec4 mv = modelViewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(aParam.w * uPixelScale / max(2.0, -mv.z), 2.0, 42.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      varying float vAlpha;
      varying float vSeed;
      void main() {
        float a = texture2D(uMap, gl_PointCoord).a * vAlpha;
        if (a < 0.01) discard;
        vec3 cool = vec3(0.72, 0.9, 1.0);
        vec3 hot = vec3(1.0, 1.0, 1.0);
        vec3 col = mix(cool, hot, smoothstep(0.15, 0.55, vSeed));
        gl_FragColor = vec4(col, a);
      }
    `,
  });
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  sparks.name = 'fx-short-sparks';
  sparks.frustumCulled = false;
  sparks.renderOrder = 15;
  root.add(sparks);

  const sparkLight = new THREE.PointLight(0xbfe6ff, 0, 22, 2);
  sparkLight.name = 'fx-spark-light';
  sparkLight.position.set(NEAR.x, 40, NEAR.z);
  sparkLight.castShadow = false;
  sparkLight.visible = true;
  ctx.addLight(sparkLight);
  sparkLight.position.set(NEAR.x, 0.7, NEAR.z);

  const stub = new THREE.Sprite(new THREE.SpriteMaterial({
    map: sparkTexture(),
    color: new THREE.Color(1.4, 1.9, 2.4),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  }));
  stub.scale.setScalar(0.85);
  stub.position.set(NEAR.x, 0.58, NEAR.z);
  root.add(stub);

  const baseSparkScale = (): number => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return window.innerHeight * dpr * 1.4525;
  };
  sparkMat.uniforms['uPixelScale'].value = baseSparkScale();
  window.addEventListener('resize', () => {
    sparkMat.uniforms['uPixelScale'].value = baseSparkScale();
  });

  ctx.ticker.add((t) => {
    // —— 照明弹 ——
    if (forced) {
      forced = false;
      if (!active) startFlare(t);
    }
    if (!active && t >= nextAt) startFlare(t);
    if (active) {
      const k = (t - started) / FLARE_FALL;
      if (k >= 1) {
        active = false;
        flare.visible = false;
        flareLight.intensity = 0;
        nextAt = t + FLARE_INTERVAL + rng.range(-4, 6);
      } else {
        const kk = Math.min(1, Math.max(0, k));
        fy = 66 - 42 * (kk * (2 - kk) * 0.5 + kk * 0.5);
        flare.position.set(fx, fy, fz);
        const ignite = Math.min(1, kk / 0.06);
        const decay = Math.pow(1 - kk, 1.35);
        const flicker = 0.86 + 0.14 * Math.sin(t * 33.1) * Math.sin(t * 17.3 + 1.2);
        flareLight.position.set(fx + Math.sin(t * 3.1) * 0.4, fy, fz + Math.cos(t * 2.7) * 0.4);
        flareLight.intensity = 2400 * ignite * decay * flicker;
        const swell = 0.8 + 0.55 * ignite + 0.2 * Math.sin(t * 7.3);
        halo.scale.setScalar(10 * swell);
        core.scale.setScalar(3.6 * swell);
        (halo.material as THREE.SpriteMaterial).opacity = 0.95;
        (core.material as THREE.SpriteMaterial).opacity = 1;
        flare.visible = true;
      }
    }

    // —— 电火花 ——
    sparkMat.uniforms['uTime'].value = t;
    const burst = Math.pow(Math.max(0, Math.sin(t * 1.73 + 0.7)), 22) + 0.35 * Math.pow(Math.max(0, Math.sin(t * 4.31 + 2.2)), 14);
    sparkLight.intensity = 2 + burst * 24;
    (stub.material as THREE.SpriteMaterial).opacity = 0.24 + burst * 0.76;
  });

  return root;
}
