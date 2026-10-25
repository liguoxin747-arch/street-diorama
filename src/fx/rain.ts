import * as THREE from 'three';
import type { BuildContext } from '../core/context';
import type { Rng } from '../core/rng';
import { canvasTexture } from '../core/materials';
import { DAY } from '../core/dayState';
import {
  BASE,
  HERO,
  HOTSPOTS,
  ZONES,
  groundYAt,
  isOnCarriageway,
  type Zone,
} from '../world/layout';

/**
 * 天气：持续降雨、落地溅射（地面 + 载具顶面）、积水涟漪、屋檐滴水、破窗水痕。
 *
 * 设计要点：
 * - 所有循环下落/扩散动画都在顶点着色器里用 uTime 计算（mod / fract），
 *   CPU 每帧只更新时间 uniform，所以几千条雨丝也只有一次 draw call、几乎零开销。
 * - 雨分两层：**近景细雨丝**（细、暗、柔和的高斯剖面，绝不是白色划痕）+ **远景雨幕**
 *   （几十片半透明噪声面片叠成的一层灰纱，不再是一根根白线）。
 * - 涟漪用高斯同心环（数学上连续可导），因此放大也不会出现星形或黑色毛刺。
 * - 破窗水痕是通用的：主楼 + 依据 ZONES/HOTSPOTS 程序化生成的平民区、工业区立面，
 *   每"组"= 主股蛇形下行 + 支股汇聚 + 末端（窗台/檐口）积珠滴落。
 * - 透明物体统一 depthWrite:false，depthTest 保留 => 被建筑正确遮挡又不互相打架。
 */

const RAIN_TINT = 0x8ba4b9; // 近景雨丝：冷灰蓝，压暗，不用亮白
const VEIL_TINT = 0x63798d; // 远景雨幕：更暗一档，融进雾里
const SPLASH_TINT = 0x8ea9bf;
const RIPPLE_TINT = 0x6d92b1;
const WATER_TINT = 0x9dbcd2; // 水膜 / 水珠 / 积水柔光

/** 一个滴水周期中"正在下落"的时间占比，其余时间在檐口积珠 */
const DRIP_FALL = 0.42;
/** 窗台积珠在周期里的脱落时刻（与落地涟漪的相位对齐） */
const BEAD_DROP = 0.86;

/** 世界尺寸 → gl_PointSize 的换算（fov=38°，H 为绘制缓冲高度） */
function pointScale(): number {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  return window.innerHeight * dpr * 1.4525;
}

/** 贴图专用的确定性随机（不污染场景随机源） */
function lcg(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

/** 一个 1×1 的实例化面片（位置/uv 复用，实例属性自行挂载） */
function instancedQuad(count: number): THREE.InstancedBufferGeometry {
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setAttribute('uv', base.getAttribute('uv'));
  geo.instanceCount = count;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 8, 0), 240);
  return geo;
}

/** 路面积水（与 world/base.ts 的 puddleSpots 一一对应；rx/rz 是半轴） */
interface WetSpot {
  x: number;
  z: number;
  rx: number;
  rz: number;
}

const PUDDLES: WetSpot[] = [
  { x: -2, z: 2.5, rx: 3.75, rz: 1.7 },
  { x: 4.5, z: -3, rx: 3.1, rz: 1.4 },
  { x: -13, z: 1.2, rx: 2.7, rz: 1.1 },
  { x: 12, z: 5.6, rx: 3.3, rz: 1.3 },
  { x: 22, z: -2.4, rx: 2.6, rz: 1.2 },
  { x: -24, z: 4.2, rx: 2.3, rz: 1.0 },
  { x: 1.5, z: -14, rx: 2.1, rz: 2.8 },
  { x: -3.5, z: 16, rx: 1.9, rz: 2.6 },
  { x: 8, z: -20, rx: 1.6, rz: 2.2 },
  { x: -8.6, z: -6.5, rx: 1.7, rz: 1.3 },
  { x: 30, z: 6.5, rx: 2.2, rz: 1.1 },
  { x: -32, z: -1.5, rx: 2.4, rz: 1.05 },
];

const shortRadius = (s: WetSpot): number => Math.min(s.rx, s.rz);

/** 檐口滴水点（主楼 + 邻街小镇） */
interface DripSpot {
  x: number;
  z: number;
  eaveY: number;
  groundY: number;
  period: number;
  phase: number;
}

function createDripSpots(rng: Rng): DripSpot[] {
  const eave = HERO.eaveY + 0.4; // ≈11.3m
  const spots: DripSpot[] = [];
  const add = (x: number, z: number, eaveY: number, groundY: number): void => {
    spots.push({ x, z, eaveY, groundY, period: rng.range(1.5, 3.6), phase: rng.next() });
  };
  // 主楼南檐（面向大道）
  [14.6, 18.3, 21.9, 25.6, 29.8].forEach((x) => add(x, HERO.z1 + 0.42, eave, 0.26));
  // 主楼西檐（面向纵街）
  [-15.6, -19.9, -24.6, -29.4].forEach((z) => add(HERO.x0 - 0.42, z, eave, 0.26));
  // 邻街小镇：NW 临街住宅 / 连排商铺
  [-19.6, -25.2, -28.8].forEach((x) => add(x, -13.2, 9.9, 0.08));
  [-37.6, -43.2].forEach((x) => add(x, -13.2, 7.4, 0.08));
  return spots;
}

/** 一次落水事件（供涟漪对齐相位） */
interface Landing {
  x: number;
  y: number;
  z: number;
  r: number;
  period: number;
  phase: number;
  alpha: number;
}

export function buildRain(ctx: BuildContext): void {
  const rng = ctx.rng.fork(7107);
  const drips = createDripSpots(rng.fork(9));
  const windows = buildWindowTrails(ctx, rng.fork(5));

  const group = new THREE.Group();
  group.name = 'fx-rain';
  group.add(buildVeil(ctx, rng.fork(10))); // 远景雨幕（先画，垫在雨丝下面）
  const curtain = buildCurtain(ctx, rng.fork(1)); // 近景雨丝
  group.add(curtain);
  group.add(buildPuddleSheen(ctx, rng.fork(6))); // 积水水面柔光
  group.add(buildSplashes(ctx, rng.fork(2)));
  group.add(buildRoofSplashes(ctx, rng.fork(8))); // 车顶/装甲顶面溅射（独立一路 Points）
  group.add(buildRipples(ctx, rng.fork(3), drips, windows.landings));
  group.add(buildDrips(ctx, rng.fork(4), drips));
  group.add(windows.mesh);
  ctx.addFx(group);

  // 雨滴质感随光线变化：白天是透明偏白的晶莹水丝，夜里靠环境光变成银丝般的冷光
  const curtainMat = curtain.material as THREE.ShaderMaterial;
  const RAIN_DAY = new THREE.Color(0xd8e3ea);
  const RAIN_NIGHT = new THREE.Color(RAIN_TINT);
  ctx.ticker.add(() => {
    const k = DAY.uNightMix.value;
    curtainMat.uniforms['uColor'].value.copy(RAIN_DAY).lerp(RAIN_NIGHT, k);
    curtainMat.uniforms['uWidth'].value = 0.024 + 0.006 * (1 - k);
  });
}

// ---------------------------------------------------------------------------
// 1. 远景雨幕：几十片半透明噪声面片叠成的一层灰纱
// ---------------------------------------------------------------------------
/** 细密、长短不一的竖向雨丝噪声（不是一根根清晰的白线） */
function veilTexture(): THREE.CanvasTexture {
  const rnd = lcg(0x5e_ed_12_34);
  const tex = canvasTexture(256, 256, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.lineCap = 'round';
    for (let i = 0; i < 360; i += 1) {
      const x = rnd() * w;
      const y = rnd() * h;
      const len = h * (0.08 + rnd() * 0.5);
      const dx = (rnd() - 0.5) * 4.5;
      const a = 0.05 + rnd() * 0.17;
      const g = c.createLinearGradient(x, y, x + dx, y + len);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.28, `rgba(255,255,255,${a.toFixed(3)})`);
      g.addColorStop(0.72, `rgba(255,255,255,${(a * 0.72).toFixed(3)})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.strokeStyle = g;
      c.lineWidth = 0.8 + rnd() * 1.9;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + dx, y + len);
      c.stroke();
      // 竖向重复时衔接：把超出下边界的一段补到顶部
      if (y + len > h) {
        c.beginPath();
        c.moveTo(x, y - h);
        c.lineTo(x + dx, y - h + len);
        c.stroke();
      }
    }
  });
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function buildVeil(ctx: BuildContext, rng: Rng): THREE.Mesh {
  const count = Math.round(64 * Math.max(0.62, ctx.quality));
  const centers = new Float32Array(count * 3);
  const params = new Float32Array(count * 4); // 半宽、半高、相位、透明度
  for (let i = 0; i < count; i += 1) {
    // 环形分布在中远景（相机近处淡出，避免糊住主体建筑）
    const ang = rng.range(0, Math.PI * 2);
    const rad = rng.range(26, 68);
    const o = i * 3;
    centers[o] = Math.cos(ang) * rad;
    centers[o + 1] = rng.range(3.5, 16);
    centers[o + 2] = Math.sin(ang) * rad;
    const q = i * 4;
    params[q] = rng.range(6, 14);
    params[q + 1] = rng.range(7, 13);
    params[q + 2] = rng.next();
    params[q + 3] = rng.range(0.022, 0.038);
  }

  const geo = instancedQuad(count);
  geo.setAttribute('aCenter', new THREE.InstancedBufferAttribute(centers, 3));
  geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(params, 4));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uMap: { value: veilTexture() },
      uColor: { value: new THREE.Color(VEIL_TINT) },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute vec3 aCenter;
      attribute vec4 aParam;
      varying vec2 vUv;
      varying float vAlpha;

      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(aCenter, 1.0);
        // 只在离相机一段距离之外淡入：远景化成雨幕，近景保持干净
        float far = smoothstep(13.0, 40.0, -mv.z);
        mv.xy += position.xy * vec2(aParam.x, aParam.y) * 2.0;
        gl_Position = projectionMatrix * mv;
        float breathe = 0.74 + 0.26 * sin(uTime * 0.21 + aParam.z * 6.2831853);
        vAlpha = aParam.w * far * breathe;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec3 uColor;
      uniform float uTime;
      varying vec2 vUv;
      varying float vAlpha;

      void main() {
        vec2 st = vec2(vUv.x * 1.7 + uTime * 0.031, vUv.y * 0.9 - uTime * 0.62);
        float m = texture2D(uMap, st).a;
        // 径向收边，确保片与片之间没有方形接缝
        float d = length(vUv - 0.5) * 2.0;
        float edge = 1.0 - smoothstep(0.26, 1.0, d);
        float a = m * edge * vAlpha;
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });

  ctx.ticker.add((elapsed) => {
    mat.uniforms['uTime'].value = elapsed;
  });

  const m = new THREE.Mesh(geo, mat);
  m.name = 'fx-rain-veil';
  m.frustumCulled = false;
  m.renderOrder = 9;
  return m;
}

// ---------------------------------------------------------------------------
// 2. 近景雨丝：细、暗、柔 —— 横向高斯衰减，头部略亮，尾部拖淡
// ---------------------------------------------------------------------------
function buildCurtain(ctx: BuildContext, rng: Rng): THREE.Mesh {
  const count = Math.round(6400 * Math.max(0.62, ctx.quality));
  const height = 42;
  const area = 220;

  const offsets = new Float32Array(count * 3);
  const params = new Float32Array(count * 3); // 落速、长度、alpha
  for (let i = 0; i < count; i += 1) {
    const o = i * 3;
    offsets[o] = rng.range(-area / 2, area / 2);
    offsets[o + 1] = rng.range(0, height);
    offsets[o + 2] = rng.range(-area / 2, area / 2);
    params[o] = rng.range(15, 26);
    params[o + 1] = rng.range(0.45, 1.15);
    params[o + 2] = rng.range(0.14, 0.34);
  }

  const geo = instancedQuad(count);
  geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 3));
  geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(params, 3));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uHeight: { value: height },
      uWidth: { value: 0.024 },
      uSlant: { value: new THREE.Vector2(0.085, 0.05) },
      uColor: { value: new THREE.Color(RAIN_TINT) },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uHeight;
      uniform float uWidth;
      uniform vec2 uSlant;
      attribute vec3 aOffset;
      attribute vec3 aParam;
      varying float vAlpha;
      varying float vSeed;
      varying vec2 vUv;

      void main() {
        vUv = uv;
        // 循环下落：y 在 [0,uHeight) 内反复取值，完全在 GPU 里完成
        float y = mod(aOffset.y - uTime * aParam.x, uHeight);
        float drift = uHeight - y;
        vec3 world = vec3(aOffset.x + drift * uSlant.x, y, aOffset.z + drift * uSlant.y);

        vec4 mv = modelViewMatrix * vec4(world, 1.0);
        float dist = -mv.z;
        // 近浓远淡：远处让位给"雨幕"，避免远景出现一片白线
        float near = 1.0 - smoothstep(15.0, 44.0, dist);

        // 雨丝方向转到视图空间，做成"沿落雨方向拉长的广告牌"
        vec3 dirView = (modelViewMatrix * vec4(normalize(vec3(uSlant.x, -1.0, uSlant.y)), 0.0)).xyz;
        vec2 dir = dirView.xy;
        float len = length(dir);
        dir = len > 1e-4 ? dir / len : vec2(0.0, -1.0);
        vec2 perp = vec2(-dir.y, dir.x);
        // 远处略微加宽 + 变得更糊，读起来是"纱"而不是"线"
        float w = uWidth * (1.0 + 1.1 * (1.0 - near));
        mv.xy += dir * (position.y * aParam.y) + perp * (position.x * w);
        gl_Position = projectionMatrix * mv;

        float fade = smoothstep(0.0, 2.5, y) * (1.0 - smoothstep(uHeight - 6.0, uHeight, y));
        vAlpha = aParam.z * fade * mix(0.34, 1.0, near);
        vSeed = fract(aParam.x * 0.137 + aParam.y * 0.71 + aOffset.x * 0.013);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vAlpha;
      varying float vSeed;
      varying vec2 vUv;

      void main() {
        // 横向高斯衰减：边缘没有硬切线，放大也不是"划痕"
        float across = abs(vUv.x * 2.0 - 1.0);
        float core = exp(-across * across * 3.4);
        // 沿雨丝：上端（尾）拖淡，下端（水珠头）略亮
        float tail = smoothstep(0.0, 0.34, vUv.y);
        float head = 1.0 - smoothstep(0.86, 1.0, vUv.y);
        float along = tail * head;
        float ripple = 0.86 + 0.14 * sin(vUv.y * 17.0 + vSeed * 62.0);
        float a = vAlpha * core * along * ripple * 0.72;
        if (a < 0.004) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });

  ctx.ticker.add((elapsed) => {
    mat.uniforms['uTime'].value = elapsed;
  });

  const m = new THREE.Mesh(geo, mat);
  m.name = 'fx-rain-curtain';
  m.frustumCulled = false;
  m.renderOrder = 12;
  return m;
}

// ---------------------------------------------------------------------------
// 3. 落地溅射（Points + 柔环贴图，更小更少）
// ---------------------------------------------------------------------------
function splashTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 64, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    // 中心一点点水花（很淡）
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, w * 0.17);
    g.addColorStop(0, 'rgba(255,255,255,0.34)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.10)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    // 外圈是高斯剖面的柔环（不是描边，也不是十字 —— 那会变成刺眼的"星星"）
    const ring = c.createRadialGradient(cx, cy, 0, cx, cy, w * 0.5);
    ring.addColorStop(0.0, 'rgba(255,255,255,0)');
    ring.addColorStop(0.26, 'rgba(255,255,255,0)');
    ring.addColorStop(0.42, 'rgba(255,255,255,0.46)');
    ring.addColorStop(0.58, 'rgba(255,255,255,0.12)');
    ring.addColorStop(1.0, 'rgba(255,255,255,0)');
    c.fillStyle = ring;
    c.fillRect(0, 0, w, h);
  });
}

/**
 * 溅射共享材质：地面溅射与车顶溅射用同一段着色器与贴图，
 * 只有 Points 几何不同 => CPU 每帧依旧只写一个 uTime uniform。
 */
function splashMaterial(ctx: BuildContext): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uMap: { value: splashTexture() },
      uPixelScale: { value: pointScale() },
      uColor: { value: new THREE.Color(SPLASH_TINT) },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uPixelScale;
      attribute vec3 aParam;
      varying float vLife;

      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float life = fract(uTime * aParam.x + aParam.y);
        vLife = life;
        float size = aParam.z * (0.45 + life * 1.15) * uPixelScale / max(1.0, -mv.z);
        gl_PointSize = clamp(size, 1.0, 96.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec3 uColor;
      varying float vLife;

      void main() {
        float mask = texture2D(uMap, gl_PointCoord).a;
        float a = mask * (1.0 - vLife) * (1.0 - vLife) * 0.8;
        if (a < 0.006) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });
  window.addEventListener('resize', () => {
    mat.uniforms['uPixelScale'].value = pointScale();
  });
  ctx.ticker.add((elapsed) => {
    mat.uniforms['uTime'].value = elapsed;
  });
  return mat;
}

function buildSplashes(ctx: BuildContext, rng: Rng): THREE.Points {
  const count = Math.round(190 * Math.max(0.62, ctx.quality));
  const positions = new Float32Array(count * 3);
  const params = new Float32Array(count * 3); // 频率、相位、尺寸

  for (let i = 0; i < count; i += 1) {
    const o = i * 3;
    let x: number;
    let z: number;
    let y = 0.11;
    const roll = rng.next();
    if (roll < 0.6) {
      // 积水上：溅点主要在湿路面（base.ts 的 reflective 区）
      const spot = rng.pick(PUDDLES);
      const a = rng.range(0, Math.PI * 2);
      const rad = Math.sqrt(rng.next());
      x = spot.x + Math.cos(a) * rad * spot.rx * 0.9;
      z = spot.z + Math.sin(a) * rad * spot.rz * 0.9;
    } else if (roll < 0.82) {
      // 车行道
      if (rng.chance(0.5)) {
        x = rng.range(-49, 49);
        z = rng.range(-8.4, 8.4);
      } else {
        x = rng.range(-7.4, 7.4);
        z = rng.range(-49, 49);
      }
    } else {
      // 人行道
      x = rng.range(-49, 49);
      z = rng.chance(0.5) ? rng.range(-12.6, -9.4) : rng.range(9.4, 12.6);
      y = 0.245;
    }
    positions[o] = x;
    positions[o + 1] = y;
    positions[o + 2] = z;
    params[o] = rng.range(1.15, 2.3); // 1/寿命
    params[o + 1] = rng.next();
    params[o + 2] = rng.range(0.085, 0.175);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aParam', new THREE.BufferAttribute(params, 3));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 80);

  const points = new THREE.Points(geo, splashMaterial(ctx));
  points.name = 'fx-rain-splash';
  points.frustumCulled = false;
  points.renderOrder = 11;
  return points;
}

/* ------------------------------------------------------------------ *
 * 3b. 载具顶面溅射：雨打在装甲/车顶上弹起的更小更密的溅点
 *     （复用 splash 贴图与着色器，独立一路 Points，只多 1 个 draw call）
 * ------------------------------------------------------------------ */

/** 顶面薄板：局部坐标（随车辆 rotY 旋转）下的离散布点范围 */
interface RoofPlate {
  /** 局部横偏中心（沿车辆 x） */
  cx: number;
  /** 局部纵偏中心（沿车辆 z，车辆局部 +Z 为车头） */
  cz: number;
  /** 局部半宽 / 半长 */
  hx: number;
  /** 局部半深 */
  hz: number;
  /** 顶面世界高度（已含车辆摆放抬升） */
  y: number;
}

interface RoofTarget {
  x: number;
  z: number;
  rotY: number;
  plates: RoofPlate[];
  base: number;
  /** 模型整体缩放（车辆默认为 1；别墅 1.4） */
  scale?: number;
}

/** 车辆摆放抬升（对齐 vehicles.ts 的 GROUND_Y） */
const VEHICLE_BASE_Y = 0.08;

/**
 * 休息中的 BMPT / 被击毁的 T-72 / 烧毁民用轿车（vehicles.ts）
 * 与哨卡停放的 BTR-80（outpost.ts，静态停放体）。
 * 顶板取自各自的 HULL/炮塔/车顶几何尺寸；BTR 复现 outpost.ts 的停车钳制
 * z = min(z, 124.4 - hz)，避免车头越进南门干道人行道。
 */
function roofTargets(): RoofTarget[] {
  const { bmpt, t72, burntCar, armoredParked } = HOTSPOTS;
  const out: RoofTarget[] = [
    {
      // BMPT：车体顶 y≈1.48+抬升；小炮塔顶板 y≈2.16+0.07
      x: bmpt.x, z: bmpt.z, rotY: bmpt.rotY, base: 12,
      plates: [
        { cx: 0, cz: 0.75, hx: 1.05, hz: 0.3, y: VEHICLE_BASE_Y + 1.48 },
        { cx: 0, cz: -1.3, hx: 1.05, hz: 0.9, y: VEHICLE_BASE_Y + 1.48 },
        { cx: 0, cz: -0.08, hx: 0.6, hz: 0.75, y: VEHICLE_BASE_Y + 2.23 },
      ],
    },
    {
      // T-72 残骸：车体顶 + 被掀偏的炮塔穹顶
      x: t72.x, z: t72.z, rotY: t72.rotY, base: 12,
      plates: [
        { cx: 0, cz: -1.4, hx: 1.05, hz: 0.8, y: VEHICLE_BASE_Y + 1.48 },
        { cx: 0.36, cz: -0.22, hx: 0.4, hz: 0.45, y: VEHICLE_BASE_Y + 2.44 },
      ],
    },
    {
      // 烧毁轿车：塌陷车顶 + 翘起引擎盖 + 后尾箱台
      x: burntCar.x, z: burntCar.z, rotY: burntCar.rotY, base: 9,
      plates: [
        { cx: 0.02, cz: -0.25, hx: 0.58, hz: 0.62, y: VEHICLE_BASE_Y + 1.32 },
        { cx: 0, cz: 1.42, hx: 0.68, hz: 0.58, y: VEHICLE_BASE_Y + 1.12 },
        { cx: 0, cz: -1.62, hx: 0.7, hz: 0.35, y: VEHICLE_BASE_Y + 1.06 },
      ],
    },
  ];
  armoredParked.forEach((p) => {
    const hz = 3.9 * Math.abs(Math.cos(p.rotY)) + 1.5 * Math.abs(Math.sin(p.rotY));
    const z = Math.min(p.z, 124.4 - hz);
    out.push({
      // BTR-80：船形车体顶 y≈1.98（局部），顶面长方形
      x: p.x, z, rotY: p.rotY, base: 8,
      plates: [{ cx: 0, cz: -0.35, hx: 1.05, hz: 2.55, y: groundYAt(p.x, z) + 1.98 }],
    });
  });
  // 定制乡村别墅（villa.ts）：双四坡顶 + 车库平顶
  {
    const v = HOTSPOTS.villa;
    const g = groundYAt(v.x, v.z);
    // 别墅根节点整体缩放 1.4：所有局部高度/偏移都要乘回去
    out.push({
      // rotY = π：局部 +Z 指向世界 -Z（北，朝大道）
      x: v.x, z: v.z, rotY: v.rotation, base: 14,
      plates: [
        // 右块四坡顶（高）
        { cx: 3.9, cz: -2.0, hx: 2.2, hz: 1.2, y: g + 7.2 },
        { cx: 3.9, cz: 2.0, hx: 2.2, hz: 1.2, y: g + 7.2 },
        // 左翼四坡顶（低）
        { cx: -0.6, cz: -2.0, hx: 1.5, hz: 1.2, y: g + 6.25 },
        // 车库平顶
        { cx: -4.3, cz: 0.2, hx: 2.1, hz: 2.6, y: g + 3.22 },
      ],
    });
  }
  return out;
}

/** 点在底座范围内且不新增侵占车行道（顶板按车辆实际占位过滤） */
function roofPointAllowed(x: number, z: number): boolean {
  const lim = BASE.half - 2;
  return x > -lim && x < lim && z > -lim && z < lim;
}

function buildRoofSplashes(ctx: BuildContext, rng: Rng): THREE.Points {
  const qf = Math.max(0.62, ctx.quality);
  const entries: Array<{ x: number; y: number; z: number; freq: number; phase: number; size: number }> = [];
  roofTargets().forEach((t) => {
    const n = Math.max(6, Math.min(12, Math.round(t.base * qf)));
    const plates = [...t.plates];
    const cosR = Math.cos(t.rotY);
    const sinR = Math.sin(t.rotY);
    for (let k = 0; k < n; k += 1) {
      // 逐块顶板轮转分点，保证车顶轮廓各面被均匀覆盖
      const plate = plates[k % plates.length] ?? plates[0]!;
      const kScale = t.scale ?? 1;
      const lx = plate.cx + rng.range(-plate.hx, plate.hx);
      const lz = plate.cz + rng.range(-plate.hz, plate.hz);
      const x = t.x + (lx * cosR + lz * sinR) * kScale;
      const z = t.z + (-lx * sinR + lz * cosR) * kScale;
      if (!roofPointAllowed(x, z)) continue;
      entries.push({
        x,
        y: plate.y + rng.range(0.04, 0.11),
        z,
        // 金属顶面上的溅射：更快、更小、相位错开
        freq: rng.range(1.5, 2.9),
        phase: rng.next(),
        size: rng.range(0.05, 0.115),
      });
    }
  });

  const count = entries.length;
  const positions = new Float32Array(count * 3);
  const params = new Float32Array(count * 3);
  entries.forEach((e, i) => {
    const o = i * 3;
    positions[o] = e.x;
    positions[o + 1] = e.y;
    positions[o + 2] = e.z;
    params[o] = e.freq;
    params[o + 1] = e.phase;
    params[o + 2] = e.size;
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aParam', new THREE.BufferAttribute(params, 3));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.5, 0), 240);

  const points = new THREE.Points(geo, splashMaterial(ctx));
  points.name = 'fx-roof-splash';
  points.frustumCulled = false;
  points.renderOrder = 11;
  return points;
}

// ---------------------------------------------------------------------------
// 4. 积水涟漪：细而柔的同心环（高斯剖面，数学上不会出现星形 / 毛刺）
// ---------------------------------------------------------------------------
function buildRipples(
  ctx: BuildContext,
  rng: Rng,
  drips: DripSpot[],
  landings: Landing[],
): THREE.Mesh {
  const seeds: Landing[] = [];
  // 积水上的涟漪（26 个）
  for (let i = 0; i < 26; i += 1) {
    const puddle = rng.pick(PUDDLES);
    const a = rng.range(0, Math.PI * 2);
    const off = rng.range(0, shortRadius(puddle) * 0.42);
    seeds.push({
      x: puddle.x + Math.cos(a) * off,
      y: 0.118,
      z: puddle.z + Math.sin(a) * off,
      r: Math.min(rng.range(0.36, 0.95), shortRadius(puddle) * 0.8),
      period: rng.range(0.85, 1.25),
      phase: rng.next(),
      alpha: rng.range(0.55, 0.95),
    });
  }
  // 屋檐滴水落点的小涟漪（与滴水同步）
  rng
    .shuffle(drips)
    .slice(0, 10)
    .forEach((d) => {
      seeds.push({
        x: d.x,
        y: d.groundY + 0.022,
        z: d.z,
        r: rng.range(0.14, 0.3),
        period: d.period,
        phase: (d.phase + DRIP_FALL) % 1,
        alpha: rng.range(0.5, 0.8),
      });
    });
  // 窗台水珠落地的小涟漪
  landings.forEach((l) => seeds.push(l));

  const count = seeds.length;
  const centers = new Float32Array(count * 3);
  const shapes = new Float32Array(count * 4); // 最大半径、周期、相位、alpha
  seeds.forEach((s, i) => {
    const o = i * 3;
    centers[o] = s.x;
    centers[o + 1] = s.y;
    centers[o + 2] = s.z;
    const q = i * 4;
    shapes[q] = s.r;
    shapes[q + 1] = s.period;
    shapes[q + 2] = s.phase;
    shapes[q + 3] = s.alpha;
  });

  const geo = instancedQuad(count);
  geo.setAttribute('aCenter', new THREE.InstancedBufferAttribute(centers, 3));
  geo.setAttribute('aShape', new THREE.InstancedBufferAttribute(shapes, 4));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(RIPPLE_TINT) },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute vec3 aCenter;
      attribute vec4 aShape;
      varying vec2 vUv;
      varying float vAlpha;

      void main() {
        vUv = uv;
        float p = fract(uTime / aShape.y + aShape.z);   // 0 → 1 生命周期
        float r = aShape.x * (0.12 + p * 0.95);
        // 平面局部 x/y 直接映射到世界 x/z（涟漪贴地）
        vec3 world = vec3(aCenter.x + position.x * r * 2.0, aCenter.y, aCenter.z + position.y * r * 2.0);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
        vAlpha = aShape.w * smoothstep(0.0, 0.10, p) * pow(1.0 - p, 1.6);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying vec2 vUv;
      varying float vAlpha;

      /** 高斯环：连续可导，无论怎么放大都不会退化成星形或黑色毛刺 */
      float gRing(float d, float c, float w) {
        float t = (d - c) / w;
        return exp(-t * t);
      }

      void main() {
        float d = length(vUv - 0.5) * 2.0;
        // 两道细而柔的同心环 + 中心极淡的一点
        float ring = gRing(d, 0.80, 0.085);
        float inner = gRing(d, 0.50, 0.100) * 0.45;
        float core = gRing(d, 0.0, 0.30) * 0.10;
        float a = (ring + inner + core) * vAlpha * 0.42;
        if (a < 0.005) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });

  ctx.ticker.add((elapsed) => {
    mat.uniforms['uTime'].value = elapsed;
  });

  const m = new THREE.Mesh(geo, mat);
  m.name = 'fx-ripples';
  m.frustumCulled = false;
  m.renderOrder = 10;
  return m;
}

// ---------------------------------------------------------------------------
// 5. 积水水面柔光：把天光/灯光在水面上揉开，反光不再是一块死色
// ---------------------------------------------------------------------------
function sheenTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.save();
    c.translate(w / 2, h / 2);
    c.scale(1, 0.44); // 横向拉长的柔光带
    const g = c.createRadialGradient(0, 0, 0, 0, 0, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.42, 'rgba(255,255,255,0.42)');
    g.addColorStop(0.74, 'rgba(255,255,255,0.11)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.beginPath();
    c.arc(0, 0, w / 2, 0, Math.PI * 2);
    c.fill();
    c.restore();
  });
}

function buildPuddleSheen(ctx: BuildContext, rng: Rng): THREE.Mesh {
  const count = PUDDLES.length;
  const centers = new Float32Array(count * 3);
  const params = new Float32Array(count * 4); // rx、rz、相位、透明度
  PUDDLES.forEach((p, i) => {
    const o = i * 3;
    centers[o] = p.x;
    centers[o + 1] = 0.112; // 水面之上、湿痕环之下
    centers[o + 2] = p.z;
    const q = i * 4;
    params[q] = p.rx * 0.72;
    params[q + 1] = p.rz * 0.72;
    params[q + 2] = rng.next();
    params[q + 3] = rng.range(0.05, 0.085);
  });

  const geo = instancedQuad(count);
  geo.setAttribute('aCenter', new THREE.InstancedBufferAttribute(centers, 3));
  geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(params, 4));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uMap: { value: sheenTexture() },
      uColor: { value: new THREE.Color(WATER_TINT) },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute vec3 aCenter;
      attribute vec4 aParam;
      varying vec2 vUv;
      varying float vAlpha;

      void main() {
        vUv = uv;
        float ph = aParam.z * 6.2831853;
        // 极缓慢地漂移与呼吸，像水面被雨点推着晃
        vec2 drift = vec2(sin(uTime * 0.07 + ph), cos(uTime * 0.053 + ph * 1.7)) * 0.18;
        vec2 ext = vec2(aParam.x, aParam.y) * (1.0 + 0.07 * sin(uTime * 0.17 + ph));
        vec3 world = vec3(
          aCenter.x + (position.x + drift.x) * ext.x * 2.0,
          aCenter.y,
          aCenter.z + (position.y + drift.y) * ext.y * 2.0
        );
        gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
        vAlpha = aParam.w * (0.72 + 0.28 * sin(uTime * 0.29 + ph));
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec3 uColor;
      varying vec2 vUv;
      varying float vAlpha;

      void main() {
        float m = texture2D(uMap, vUv).a;
        float a = m * vAlpha;
        if (a < 0.004) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });

  ctx.ticker.add((elapsed) => {
    mat.uniforms['uTime'].value = elapsed;
  });

  const m = new THREE.Mesh(geo, mat);
  m.name = 'fx-puddle-sheen';
  m.frustumCulled = false;
  m.renderOrder = 10;
  return m;
}

// ---------------------------------------------------------------------------
// 6. 屋檐滴水：檐口积珠 → 小而快地坠落 → 落地交给涟漪
// ---------------------------------------------------------------------------
function buildDrips(ctx: BuildContext, rng: Rng, drips: DripSpot[]): THREE.Mesh {
  const count = drips.length * 2; // 每个檐口两股，节奏错开
  const starts = new Float32Array(count * 3);
  const params = new Float32Array(count * 4); // 落差、周期、相位、水珠尺寸
  drips.forEach((d, i) => {
    for (let k = 0; k < 2; k += 1) {
      const idx = i * 2 + k;
      const o = idx * 3;
      starts[o] = d.x + rng.range(-0.16, 0.16);
      starts[o + 1] = d.eaveY;
      starts[o + 2] = d.z + rng.range(-0.16, 0.16);
      const q = idx * 4;
      params[q] = Math.max(0.6, d.eaveY - d.groundY);
      params[q + 1] = d.period * (k === 0 ? 1 : 1.37);
      params[q + 2] = (d.phase + k * 0.41) % 1;
      params[q + 3] = rng.range(0.05, 0.085);
    }
  });

  const geo = instancedQuad(count);
  geo.setAttribute('aStart', new THREE.InstancedBufferAttribute(starts, 3));
  geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(params, 4));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(WATER_TINT) },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute vec3 aStart;
      attribute vec4 aParam;
      varying vec2 vUv;
      varying float vAlpha;
      varying float vStretch;

      void main() {
        vUv = uv;
        float c = fract(uTime / aParam.y + aParam.z);
        float falling = 1.0 - step(0.42, c);
        float kFall = clamp(c / 0.42, 0.0, 1.0);
        // 越掉越快（抛物线），所以水珠"小而快"
        float drop = kFall * kFall;
        // 不下落时在檐口慢慢胀大
        float grow = clamp((c - 0.42) / 0.58, 0.0, 1.0);

        float y = aStart.y - falling * drop * aParam.x;
        float size = aParam.w * mix(0.30 + 0.70 * grow, 1.0, falling);
        vStretch = mix(1.0, 2.3, falling);

        vec4 mv = modelViewMatrix * vec4(aStart.x, y, aStart.z, 1.0);
        mv.xy += vec2(position.x * size, position.y * size * vStretch);
        gl_Position = projectionMatrix * mv;

        float air = mix(0.05 + 0.95 * grow * grow, 1.0 - smoothstep(0.90, 1.0, kFall), falling);
        vAlpha = air * mix(0.85, 1.0, falling);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying vec2 vUv;
      varying float vAlpha;
      varying float vStretch;

      void main() {
        // 一颗柔边的小水珠（下落时被拉伸成带拖尾的短条）
        vec2 p = (vUv - vec2(0.5, 0.5)) * vec2(1.0, 1.0 / max(0.35, vStretch) * 0.55 + 0.45);
        float d = length(p) * 2.0;
        float body = exp(-d * d * 2.7);
        vec2 h = (vUv - vec2(0.38, 0.34)) * 4.2;
        float shine = exp(-dot(h, h)) * 0.5;
        float a = body * (1.0 + shine) * vAlpha * 0.9;
        if (a < 0.005) discard;
        gl_FragColor = vec4(uColor + vec3(0.22) * shine, min(a, 0.95));
      }
    `,
  });

  ctx.ticker.add((elapsed) => {
    mat.uniforms['uTime'].value = elapsed;
  });

  const m = new THREE.Mesh(geo, mat);
  m.name = 'fx-eave-drips';
  m.frustumCulled = false;
  m.renderOrder = 11;
  return m;
}

// ---------------------------------------------------------------------------
// 7. 破窗水痕（通用）：沿墙面蛇形下行的水膜 + 支股汇聚 + 窗台/檐口积珠滴落
//    数据源：主楼 HERO + 依据 ZONES/HOTSPOTS 程序化生成的平民区、工业区临街立面。
//    全部是面片+着色器（建筑同材质合批，不动任何材质贴图通道），一次 draw call。
// ---------------------------------------------------------------------------

interface TrailInstance {
  origin: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  meander: THREE.Vector3;
  param: THREE.Vector4; // 周期、相位、积珠落差、亮度/宽度抖动
  kind: number; // 0 = 水膜，1 = 窗台积珠
}

interface WindowTrails {
  mesh: THREE.Mesh;
  landings: Landing[];
}

/** 一条沿墙下行的水痕：origin + up(完整下行向量，终点=origin+up) + 横向蛇形摆动 */
interface TrailSpec {
  origin: THREE.Vector3;
  up: THREE.Vector3;
  tangent: THREE.Vector3;
  width: number;
  period: number;
  phase: number;
  amp: number;
  freq: number;
  mphase: number;
  jitter: number;
  bead: boolean;
}

const trailDown = (): THREE.Vector3 => new THREE.Vector3(0, -1, 0);

/** 水痕末端（含蛇形摆动在底端的横向偏移），积珠与落点涟漪都以此为准 */
function trailEnd(s: TrailSpec): THREE.Vector3 {
  const e = s.origin.clone().add(s.up);
  return e.addScaledVector(s.tangent, s.amp * Math.sin(s.freq * Math.PI * 2 + s.mphase));
}

/** 主股 + 从上方汇入的支股（支股末端落在主股起点 = "汇聚成股"） */
function trailGroup(
  rng: Rng,
  out: TrailSpec[],
  o: {
    origin: THREE.Vector3;
    tangent: THREE.Vector3;
    length: number;
    width: number;
    amp: number;
    period: number;
    bead: boolean;
    feeders: number;
  },
): void {
  const main: TrailSpec = {
    origin: o.origin.clone(),
    up: trailDown().multiplyScalar(o.length),
    tangent: o.tangent,
    width: o.width,
    period: o.period,
    phase: rng.next(),
    amp: o.amp,
    freq: rng.range(1.4, 2.6),
    mphase: rng.range(0, Math.PI * 2),
    jitter: rng.next(),
    bead: o.bead,
  };
  out.push(main);
  for (let i = 0; i < o.feeders; i += 1) {
    const dy = rng.range(0.55, 1.35);
    const dx = rng.sign() * rng.range(0.3, 0.85);
    out.push({
      origin: main.origin.clone().addScaledVector(o.tangent, dx).add(new THREE.Vector3(0, dy, 0)),
      up: trailDown().multiplyScalar(dy).addScaledVector(o.tangent, -dx),
      tangent: o.tangent,
      width: main.width * rng.range(0.55, 0.8),
      period: main.period,
      phase: (main.phase + rng.range(-0.12, 0.12) + 1) % 1,
      amp: rng.range(0.04, 0.12),
      freq: rng.range(1.8, 3.2),
      mphase: rng.range(0, Math.PI * 2),
      jitter: rng.next(),
      bead: false,
    });
  }
}

/** 分区临街立面：取"朝向核心区、且更长"的那条边，墙线在边界内向区内收 1.0m */
function trailWalls(zone: Zone): { plane: number; along0: number; along1: number; normalSign: 1 | -1; axis: 'x' | 'z' } | null {
  const edges: Array<{ plane: number; from: number; to: number; normalSign: 1 | -1; axis: 'x' | 'z' }> = [
    { plane: zone.x1, from: zone.z0, to: zone.z1, normalSign: 1, axis: 'x' },
    { plane: zone.x0, from: zone.z0, to: zone.z1, normalSign: -1, axis: 'x' },
    { plane: zone.z1, from: zone.x0, to: zone.x1, normalSign: 1, axis: 'z' },
    { plane: zone.z0, from: zone.x0, to: zone.x1, normalSign: -1, axis: 'z' },
  ];
  let best: (typeof edges)[number] | null = null;
  for (const e of edges) {
    // 只留朝核心区那一侧的边：外法线必须指向原点方向（plane 与 normalSign 反号）
    if (e.normalSign * e.plane >= 0) continue;
    if (!best || e.to - e.from > best.to - best.from) best = e;
  }
  if (!best) return null;
  const span = best.to - best.from;
  const inset = Math.min(11, span * 0.18);
  return {
    plane: best.plane - best.normalSign * 1.0,
    along0: best.from + inset,
    along1: best.to - inset,
    normalSign: best.normalSign,
    axis: best.axis,
  };
}

/** 主楼（保留原破窗位置）+ 依据 ZONES/HOTSPOTS 程序化生成的新区立面水痕 */
function createTrails(ctx: BuildContext, rng: Rng): { specs: TrailSpec[]; groundAt: (p: THREE.Vector3) => number } {
  const specs: TrailSpec[] = [];
  const southZ = HERO.z1 + 0.06; // 南立面外侧（朝 +Z），墙面横向沿 X
  const westX = HERO.x0 - 0.06; // 西立面外侧（朝 -X），墙面横向沿 Z
  const heroTanX = new THREE.Vector3(1, 0, 0);
  const heroTanZ = new THREE.Vector3(0, 0, 1);

  // —— 主楼南立面（面向大道）3 处破窗下缘 ——
  [
    { x: 15.9, y: 6.1, len: 2.2 },
    { x: 23.6, y: 9.4, len: 3.4 },
    { x: 29.2, y: 6.1, len: 2.2 },
  ].forEach((w, i) => {
    trailGroup(rng, specs, {
      origin: new THREE.Vector3(w.x, w.y, southZ),
      tangent: heroTanX,
      length: w.len,
      width: rng.range(0.3, 0.44),
      amp: rng.range(0.08, 0.16),
      period: rng.range(3.6, 6.0),
      bead: true,
      feeders: i === 1 ? 1 : 0,
    });
  });
  // —— 主楼西立面（面向纵街）2 处 ——
  [
    { z: -17.2, y: 6.4, len: 2.4 },
    { z: -26.4, y: 9.5, len: 3.2 },
  ].forEach((w, i) => {
    trailGroup(rng, specs, {
      origin: new THREE.Vector3(westX, w.y, w.z),
      tangent: heroTanZ,
      length: w.len,
      width: rng.range(0.3, 0.42),
      amp: rng.range(0.08, 0.14),
      period: rng.range(4.0, 6.4),
      bead: true,
      feeders: i === 1 ? 1 : 0,
    });
  });
  const heroGroundAt = (p: THREE.Vector3): number => (p.z > -13.1 ? 0.26 : 0.245);

  // —— 新区立面：平民区 + 工业区，临街联排与厂房破窗 ——
  const qf = Math.max(0.62, ctx.quality);
  ZONES.forEach((zone, zi) => {
    if (zone.use !== 'suburb' && zone.use !== 'industrial') return;
    if (zone.maxFloors < 2) return; // 单层堆场/哨卡没有"破窗高痕"的立面
    const wall = trailWalls(zone);
    if (!wall) return;
    const tangent =
      wall.axis === 'x' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const span = wall.along1 - wall.along0;
    const groups = Math.max(1, Math.min(3, Math.round(span / 45)));
    const zr = rng.fork(2000 + zi);
    // 低端画质确定性抽稀组数，保留的组仍均匀覆盖整条街面
    const keep = Math.max(1, Math.min(groups, Math.ceil(groups * qf)));
    for (let g = 0; g < keep; g += 1) {
      const along =
        groups === 1
          ? (wall.along0 + wall.along1) / 2
          : wall.along0 + ((g + 0.5) / groups) * span + zr.range(-span / (groups * 5), span / (groups * 5));
      const pos =
        wall.axis === 'x'
          ? new THREE.Vector3(wall.plane, 0, along)
          : new THREE.Vector3(along, 0, wall.plane);
      const gy = groundYAt(pos.x, pos.z);
      pos.y = gy;
      const tall = zone.use === 'industrial' && zone.maxFloors >= 3; // 大跨度厂房：高位破天窗流下
      const yTop = tall
        ? gy + zr.range(6.2, 8.8)
        : gy + (zone.maxFloors >= 3 ? zr.range(5.8, 7.3) : zr.range(4.3, 5.5));
      const length = Math.min(yTop - gy - 3.2, tall ? zr.range(2.4, 3.8) : zr.range(1.7, 2.9));
      trailGroup(zr, specs, {
        origin: pos,
        tangent,
        length,
        width: zr.range(0.34, 0.56),
        amp: zr.range(0.18, 0.5),
        period: zr.range(4.0, 7.2),
        bead: true,
        feeders: qf > 0.85 ? 2 : 1,
      });
    }
  });
  return {
    specs,
    groundAt: (p) =>
      p.x > 11.5 && p.x < 34.5 && p.z > -35 && p.z < -12 ? heroGroundAt(p) : groundYAt(p.x, p.z),
  };
}

function buildWindowTrails(ctx: BuildContext, rng: Rng): WindowTrails {
  const { specs, groundAt } = createTrails(ctx, rng);
  const qf = Math.max(0.62, ctx.quality);
  const instances: TrailInstance[] = [];
  const landings: Landing[] = [];

  specs.forEach((s) => {
    const end = trailEnd(s);
    const gy = groundAt(end);
    // 落点自查：不越出底座、不新增侵占车行道
    const lim = BASE.half - 2;
    if (Math.abs(end.x) > lim || Math.abs(end.z) > lim || isOnCarriageway(end.x, end.z, 0.25)) {
      return;
    }
    instances.push({
      origin: s.origin,
      right: s.tangent.clone().multiplyScalar(s.width),
      up: s.up,
      meander: new THREE.Vector3(s.amp, s.freq, s.mphase),
      param: new THREE.Vector4(s.period, s.phase, 0, s.jitter),
      kind: 0,
    });
    if (s.bead && qf > 0.7) {
      const dropH = Math.max(0.3, end.y - gy);
      instances.push({
        origin: end,
        right: s.tangent.clone().multiplyScalar(s.width),
        up: trailDown(),
        meander: new THREE.Vector3(0, 1, 0),
        param: new THREE.Vector4(s.period, s.phase, dropH, s.jitter),
        kind: 1,
      });
      landings.push({
        x: end.x,
        y: gy + 0.022,
        z: end.z,
        r: rng.range(0.11, 0.24),
        period: s.period,
        phase: (s.phase + BEAD_DROP) % 1,
        alpha: rng.range(0.4, 0.7),
      });
    }
  });

  const count = instances.length;
  const origins = new Float32Array(count * 3);
  const rights = new Float32Array(count * 3);
  const ups = new Float32Array(count * 3);
  const meanders = new Float32Array(count * 3);
  const params = new Float32Array(count * 4);
  const kinds = new Float32Array(count);
  instances.forEach((it, i) => {
    const o = i * 3;
    origins[o] = it.origin.x;
    origins[o + 1] = it.origin.y;
    origins[o + 2] = it.origin.z;
    rights[o] = it.right.x;
    rights[o + 1] = it.right.y;
    rights[o + 2] = it.right.z;
    ups[o] = it.up.x;
    ups[o + 1] = it.up.y;
    ups[o + 2] = it.up.z;
    meanders[o] = it.meander.x;
    meanders[o + 1] = it.meander.y;
    meanders[o + 2] = it.meander.z;
    const q = i * 4;
    params[q] = it.param.x;
    params[q + 1] = it.param.y;
    params[q + 2] = it.param.z;
    params[q + 3] = it.param.w;
    kinds[i] = it.kind;
  });

  const geo = instancedQuad(count);
  geo.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(origins, 3));
  geo.setAttribute('aRight', new THREE.InstancedBufferAttribute(rights, 3));
  geo.setAttribute('aUp', new THREE.InstancedBufferAttribute(ups, 3));
  geo.setAttribute('aMeander', new THREE.InstancedBufferAttribute(meanders, 3));
  geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(params, 4));
  geo.setAttribute('aKind', new THREE.InstancedBufferAttribute(kinds, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(WATER_TINT) },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute vec3 aOrigin;
      attribute vec3 aRight;
      attribute vec3 aUp;
      attribute vec3 aMeander;
      attribute vec4 aParam;
      attribute float aKind;
      varying vec2 vUv;
      varying float vAlpha;
      varying float vFlow;
      varying float vKind;
      varying float vStretch;

      void main() {
        vUv = uv;
        vKind = aKind;
        float c = fract(uTime / aParam.x + aParam.y);
        vec3 tanU = aRight / max(0.05, length(aRight));

        /* —— 水膜：静止的蛇形湿痕，下行的水带在片元里流动 —— */
        float t = position.y + 0.5;                 // 顶端 0 → 底端 1
        float sway = aMeander.x * (0.22 + 0.78 * t) * sin(aMeander.y * 6.2831853 * t + aMeander.z);
        vec3 filmWorld = aOrigin + aUp * t + tanU * sway + aRight * position.x;
        vec4 mvFilm = modelViewMatrix * vec4(filmWorld, 1.0);
        float aFilm = 0.8 + 0.2 * sin(uTime * 0.5 + aParam.w * 6.2831853);
        vFlow = 1.0 - c;                            // 水带中心在 uv.y 上的位置（顶→底）

        /* —— 窗台/檐口积珠：先胀大，再脱落坠落（相位与流带同步）—— */
        float grow = clamp(c / 0.62, 0.0, 1.0);
        float fallK = clamp((c - 0.62) / 0.24, 0.0, 1.0);
        float falling = step(0.62, c) * (1.0 - step(0.86, c));
        float beadY = aOrigin.y - falling * fallK * fallK * aParam.z;
        float beadSize = 0.05 + 0.05 * grow + 0.018 * aParam.w;
        vStretch = 1.0 + falling * 1.7;
        vec4 mvBead = modelViewMatrix * vec4(aOrigin.x, beadY, aOrigin.z, 1.0);
        mvBead.xy += vec2(position.x * beadSize, position.y * beadSize * vStretch);
        float aBead = (0.05 + 0.95 * grow * grow) * (1.0 - smoothstep(0.855, 0.885, c));

        vec4 mv = mix(mvFilm, mvBead, aKind);
        gl_Position = projectionMatrix * mv;
        vAlpha = mix(aFilm, aBead * 0.95, aKind);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying vec2 vUv;
      varying float vAlpha;
      varying float vFlow;
      varying float vKind;
      varying float vStretch;

      void main() {
        /* 水膜：常驻湿痕越往下越宽越亮（汇聚成股）+ 一道持续下行的亮水带 */
        float across = abs(vUv.x * 2.0 - 1.0);
        float film = exp(-across * across * (2.6 + 1.8 * vUv.y));
        float wet = film * (0.12 + 0.30 * (1.0 - vUv.y));
        float dBand = vUv.y - vFlow;
        float band = exp(-dBand * dBand * 22.0) * film;
        vec2 sp = (vUv - vec2(0.36, 0.58)) * vec2(4.6, 0.9);
        float spec = exp(-dot(sp, sp)) * 0.42;
        float aFilm = (wet + band * 0.8 + wet * spec) * vAlpha;

        /* 积珠：柔边小水滴 + 左上一点高光 */
        vec2 q = (vUv - vec2(0.5, 0.44)) * vec2(1.0, 1.30 / max(0.4, vStretch) * 0.6 + 0.4);
        float d = length(q) * 2.0;
        float body = exp(-d * d * 2.5);
        vec2 hl = (vUv - vec2(0.38, 0.34)) * 4.2;
        float shine = exp(-dot(hl, hl)) * 0.5;
        float aBead = body * (1.0 + shine) * vAlpha * 0.92;

        float a = mix(aFilm, aBead, vKind);
        if (a < 0.005) discard;
        gl_FragColor = vec4(uColor + vec3(0.20) * shine * vKind, min(a, 0.95));
      }
    `,
  });

  ctx.ticker.add((elapsed) => {
    mat.uniforms['uTime'].value = elapsed;
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'fx-window-trails';
  mesh.frustumCulled = false;
  mesh.renderOrder = 11;
  return { mesh, landings };
}
