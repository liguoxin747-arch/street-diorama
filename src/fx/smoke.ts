import * as THREE from 'three';
import type { BuildContext } from '../core/context';
import type { Rng } from '../core/rng';
import { canvasTexture } from '../core/materials';
import { PALETTE } from '../core/palette';
import { HOTSPOTS } from '../world/layout';
import { WARZONE } from '../world/warzone';

/**
 * 氛围：T-72 余烬与烟雾、远处硝烟、主妇做饭的蒸汽、局部小火苗、贴地薄雾。
 *
 * 设计要点：
 * - 烟 / 蒸汽共用一个粒子场，但按"浓烟（Normal）/ 薄烟（Normal）/ 蒸汽（Additive）"
 *   拆成 3 个 Points（3 次 draw call），这样浓烟不会被加色混合洗白成"一团棉花"。
 * - 烟柱分层：底部用小而浓的粒子（几乎不动，读成"浓"），顶部换成大而稀、横向铺开的粒子
 *   （读成"散"）。同一根柱子里两种种子交替生成，中间自然过渡。
 * - 火苗三层火舌：核心（近白）→ 外焰（橙）→ 上层（暗红），三层各自跳动，
 *   相位由多个不可约的频率叠加，所以不会是匀速正弦。
 * - 火焰、余烬高光、崩出的火星、地面薄雾各用一个实例化面片（各 1 次 draw call）。
 */

const pointScale = (): number => {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  return window.innerHeight * dpr * 1.4525;
};

/** 贴图专用的确定性随机（不污染场景随机源） */
function lcg(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

function instancedQuad(count: number): THREE.InstancedBufferGeometry {
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setAttribute('uv', base.getAttribute('uv'));
  geo.instanceCount = count;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 10, 0), 240);
  return geo;
}

// ---------------------------------------------------------------------------
// 程序化贴图
// ---------------------------------------------------------------------------
/**
 * 烟团：一个实心柔核 + 几片偏心的小瓣 + 少量细密噪点。
 * 目的是"边缘软但有结构"，叠加时不会糊成一整团棉花。
 */
function puffTexture(seed: number): THREE.CanvasTexture {
  const rnd = lcg(seed);
  return canvasTexture(128, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    // 主核（偏软，但中心留一段实）
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, w * 0.5);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.34, 'rgba(255,255,255,0.68)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.28)');
    g.addColorStop(0.84, 'rgba(255,255,255,0.05)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.beginPath();
    c.arc(cx, cy, w * 0.5, 0, Math.PI * 2);
    c.fill();
    // 偏心小瓣：让轮廓不是标准圆（烟才有"团"的感觉）
    for (let i = 0; i < 7; i += 1) {
      const a = rnd() * Math.PI * 2;
      const d = w * (0.14 + rnd() * 0.24);
      const r = w * (0.13 + rnd() * 0.19);
      const px = cx + Math.cos(a) * d;
      const py = cy + Math.sin(a) * d;
      const pg = c.createRadialGradient(px, py, 0, px, py, r);
      pg.addColorStop(0, `rgba(255,255,255,${(0.16 + rnd() * 0.2).toFixed(3)})`);
      pg.addColorStop(0.62, 'rgba(255,255,255,0.06)');
      pg.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = pg;
      c.beginPath();
      c.arc(px, py, r, 0, Math.PI * 2);
      c.fill();
    }
    // 细密噪点：边缘的颗粒感，避免"高斯球"的塑料味
    c.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 90; i += 1) {
      const a = rnd() * Math.PI * 2;
      const d = Math.sqrt(rnd()) * w * 0.46;
      const px = cx + Math.cos(a) * d;
      const py = cy + Math.sin(a) * d;
      const r = 1.2 + rnd() * 3.4;
      const pg = c.createRadialGradient(px, py, 0, px, py, r);
      pg.addColorStop(0, `rgba(255,255,255,${(0.05 + rnd() * 0.1).toFixed(3)})`);
      pg.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = pg;
      c.beginPath();
      c.arc(px, py, r, 0, Math.PI * 2);
      c.fill();
    }
    c.globalCompositeOperation = 'source-over';
  });
}

/**
 * 火焰片：干净的水滴形色块。三层火舌共用它，靠 uCore/uMid/uEdge 三个色阶
 * 在纵向切出"核心白 / 外焰橙 / 上层暗红"。
 */
function flameTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 256, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    // 整体水滴形（横向越往上越窄）
    const body = c.createLinearGradient(0, h, 0, 0);
    body.addColorStop(0, 'rgba(255,255,255,0.98)');
    body.addColorStop(0.26, 'rgba(255,255,255,0.9)');
    body.addColorStop(0.55, 'rgba(255,255,255,0.62)');
    body.addColorStop(0.8, 'rgba(255,255,255,0.24)');
    body.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = body;
    c.beginPath();
    c.moveTo(w * 0.5, h * 0.02);
    c.bezierCurveTo(w * 0.44, h * 0.2, w * 0.32, h * 0.44, w * 0.32, h * 0.7);
    c.bezierCurveTo(w * 0.33, h * 0.9, w * 0.41, h * 0.985, w * 0.5, h * 0.985);
    c.bezierCurveTo(w * 0.59, h * 0.985, w * 0.67, h * 0.9, w * 0.68, h * 0.7);
    c.bezierCurveTo(w * 0.68, h * 0.44, w * 0.56, h * 0.2, w * 0.5, h * 0.02);
    c.closePath();
    c.fill();
    // 内焰（更亮的核心）
    const core = c.createRadialGradient(w * 0.5, h * 0.78, 0, w * 0.5, h * 0.78, w * 0.3);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(0.6, 'rgba(255,255,255,0.5)');
    core.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = core;
    c.beginPath();
    c.ellipse(w * 0.5, h * 0.8, w * 0.2, h * 0.2, 0, 0, Math.PI * 2);
    c.fill();
  });
}

// ---------------------------------------------------------------------------
// 柔边粒子场（烟 / 蒸汽）
// ---------------------------------------------------------------------------
interface PuffSeed {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  buoyancy: number;
  /** 横向铺开速度（烟柱越往上越明显） */
  spread: number;
  size0: number;
  size1: number;
  alpha: number;
  life: number;
  wobble: number;
  phase: number;
  /** 自身缓慢旋转，让"瓣"朝向不同方向 */
  spin: number;
  color: THREE.Color;
}

type PuffSpawner = () => PuffSeed;

interface PuffSlot {
  spawner: PuffSpawner;
  seed: PuffSeed;
  age: number;
  rot: number;
}

class PuffField {
  readonly points: THREE.Points;
  private readonly capacity: number;
  private readonly slots: PuffSlot[] = [];
  private readonly posArr: Float32Array;
  private readonly sizeArr: Float32Array;
  private readonly alphaArr: Float32Array;
  private readonly rotArr: Float32Array;
  private readonly colorArr: Float32Array;
  private readonly geo: THREE.BufferGeometry;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly sizeAttr: THREE.BufferAttribute;
  private readonly alphaAttr: THREE.BufferAttribute;
  private readonly rotAttr: THREE.BufferAttribute;
  private readonly colorAttr: THREE.BufferAttribute;
  private readonly mat: THREE.ShaderMaterial;

  constructor(capacity: number, blending: THREE.Blending, name: string, map: THREE.CanvasTexture) {
    this.capacity = capacity;
    this.posArr = new Float32Array(capacity * 3);
    this.sizeArr = new Float32Array(capacity);
    this.alphaArr = new Float32Array(capacity);
    this.rotArr = new Float32Array(capacity);
    this.colorArr = new Float32Array(capacity * 3);

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.posArr, 3).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(this.sizeArr, 1).setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.BufferAttribute(this.alphaArr, 1).setUsage(THREE.DynamicDrawUsage);
    this.rotAttr = new THREE.BufferAttribute(this.rotArr, 1).setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.BufferAttribute(this.colorArr, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('aSize', this.sizeAttr);
    geo.setAttribute('aAlpha', this.alphaAttr);
    geo.setAttribute('aRot', this.rotAttr);
    geo.setAttribute('aColor', this.colorAttr);
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 12, 0), 220);
    this.geo = geo;

    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending,
      uniforms: {
        uMap: { value: map },
        uPixelScale: { value: pointScale() },
      },
      vertexShader: /* glsl */ `
        uniform float uPixelScale;
        attribute float aSize;
        attribute float aAlpha;
        attribute float aRot;
        attribute vec3 aColor;
        varying float vAlpha;
        varying vec3 vColor;
        varying float vRot;

        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(aSize * uPixelScale / max(0.8, -mv.z), 1.0, 1400.0);
          vAlpha = aAlpha;
          vColor = aColor;
          vRot = aRot;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        varying float vAlpha;
        varying vec3 vColor;
        varying float vRot;

        void main() {
          // 旋转必须在片元里做：gl_PointCoord 只有片元着色器才有
          float s = sin(vRot);
          float c = cos(vRot);
          vec2 uv = vec2(0.5) + mat2(c, -s, s, c) * (gl_PointCoord - vec2(0.5));
          float mask = texture2D(uMap, uv).a;
          float a = mask * vAlpha;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vColor, a);
        }
      `,
    });

    this.points = new THREE.Points(geo, this.mat);
    this.points.name = name;
    this.points.frustumCulled = false;
    this.points.renderOrder = 9;

    window.addEventListener('resize', () => {
      this.mat.uniforms['uPixelScale'].value = pointScale();
    });
  }

  get used(): number {
    return this.slots.length;
  }

  /** stagger: 0-1，让同一个发射器的粒子在开场就均匀铺开（避免一起出生） */
  add(spawner: PuffSpawner, stagger = 0): void {
    if (this.slots.length >= this.capacity) return;
    const seed = spawner();
    this.slots.push({ spawner, seed, age: stagger * seed.life, rot: seed.spin * stagger * 6.28 });
  }

  update(t: number, dt: number): void {
    const n = this.slots.length;
    for (let i = 0; i < n; i += 1) {
      const slot = this.slots[i];
      slot.age += dt;
      if (slot.age >= slot.seed.life) {
        slot.seed = slot.spawner();
        slot.age = 0;
        slot.rot = slot.seed.spin * 6.28;
      }
      const s = slot.seed;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      s.vy += s.buoyancy * dt;
      // 越往上横向铺开越明显（烟柱自然发散）
      s.vx += s.spread * Math.sin(t * 0.31 + s.phase) * dt;
      s.vz += s.spread * Math.cos(t * 0.27 + s.phase * 1.6) * dt;
      slot.rot += s.spin * dt;

      const k = Math.min(1, slot.age / s.life);
      const grow = 1 - (1 - k) * (1 - k) * (1 - k);
      const fadeIn = Math.min(1, k / 0.14);
      const fade = fadeIn * Math.pow(1 - k, 1.25);
      const o = i * 3;
      this.posArr[o] = s.x + Math.sin(t * 0.55 + s.phase) * s.wobble * k;
      this.posArr[o + 1] = s.y;
      this.posArr[o + 2] = s.z + Math.cos(t * 0.43 + s.phase) * s.wobble * k * 0.75;
      this.sizeArr[i] = s.size0 + (s.size1 - s.size0) * grow;
      this.alphaArr[i] = s.alpha * fade;
      this.rotArr[i] = slot.rot;
      this.colorArr[o] = s.color.r;
      this.colorArr[o + 1] = s.color.g;
      this.colorArr[o + 2] = s.color.b;
    }
    this.geo.setDrawRange(0, n);
    this.posAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
    this.rotAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
  }
}

/** 冷灰烟色（略高于夜色才看得见，不要纯黑） */
function smokeColor(rng: Rng, light = 0.42): THREE.Color {
  const c = new THREE.Color(0x353b42);
  return c.lerp(new THREE.Color(0x8b929b), rng.next() * light);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
type Updater = (t: number, dt: number) => void;

export function buildAtmosphere(ctx: BuildContext): void {
  const rng = ctx.rng.fork(2201);
  const group = new THREE.Group();
  group.name = 'fx-atmosphere';
  const updaters: Updater[] = [];

  // 三张不同的烟团贴图（不同的"瓣"布局），叠加时不会看出是同一个圆
  const mapA = puffTexture(0x9e3779b1);
  const mapB = puffTexture(0x85ebca6b);
  const mapC = puffTexture(0xc2b2ae35);

  // 浓烟（NormalBlending，读得出体积与暗部）
  const dense = new PuffField(120, THREE.NormalBlending, 'fx-smoke-dense', mapA);
  // 薄烟（远处硝烟 / 门洞轻烟）：同样的混合，但更淡更大
  const thin = new PuffField(64, THREE.NormalBlending, 'fx-smoke-thin', mapB);
  // 蒸汽（Additive，被炉火照到，颜色偏暖）
  const steam = new PuffField(48, THREE.AdditiveBlending, 'fx-steam', mapC);
  // 战争烟雾：工厂的黄绿毒烟、被击毁车辆的冷白烟
  const toxic = new PuffField(40, THREE.NormalBlending, 'fx-smoke-toxic', mapB);
  const wreck = new PuffField(34, THREE.NormalBlending, 'fx-smoke-wreck', mapA);
  group.add(thin.points, dense.points, steam.points, toxic.points, wreck.points);
  updaters.push((t, dt) => {
    thin.update(t, dt);
    dense.update(t, dt);
    steam.update(t, dt);
    toxic.update(t, dt);
    wreck.update(t, dt);
  });

  addTankEmbers(ctx, rng.fork(1), dense, group, updaters);
  addTankPlume(rng.fork(2), dense, thin);
  addDistantSmoke(rng.fork(3), thin);
  addSteam(rng.fork(4), steam, thin);
  addFires(ctx, rng.fork(5), group, updaters);
  addWarSmoke(rng.fork(7), toxic, wreck);
  group.add(buildMist(rng.fork(6), updaters));

  ctx.ticker.add((t, dt) => {
    for (let i = 0; i < updaters.length; i += 1) updaters[i](t, dt);
  });
  ctx.addFx(group);
}

// ---------------------------------------------------------------------------
// 1. T-72 余烬明灭（1 个点光 + 若干发光小面片）+ 崩出的火星
// ---------------------------------------------------------------------------
/** 4-9 秒级的呼吸式明灭，偶尔一次较亮的爆发 */
function emberPulse(t: number): number {
  const breathe = 0.5 + 0.3 * Math.sin(t * 0.83 + 1.1) + 0.22 * Math.sin(t * 2.03 + 0.4) + 0.12 * Math.sin(t * 3.31 + 2.2);
  const flare = Math.pow(Math.max(0, Math.sin(t * 0.41 + 2.6)), 16);
  return Math.max(0.12, breathe) + flare * 1.5;
}

/**
 * 火星：GPU 循环的一次性抛射。每颗火星在自己的周期里
 * 突然从余烬里崩出、走一段抛物线下落、尾部拖淡消失。
 * CPU 每帧只写 uTime。
 */
function buildEmberSparks(ctx: BuildContext, rng: Rng, origin: THREE.Vector3): THREE.Mesh {
  const count = Math.round(34 * Math.max(0.62, ctx.quality));
  const origins = new Float32Array(count * 3);
  const params = new Float32Array(count * 4); // 周期、相位、初速、尺寸
  for (let i = 0; i < count; i += 1) {
    const o = i * 3;
    origins[o] = origin.x + rng.range(-0.55, 0.55);
    origins[o + 1] = origin.y + rng.range(-0.1, 0.35);
    origins[o + 2] = origin.z + rng.range(-0.5, 0.5);
    const q = i * 4;
    params[q] = rng.range(1.1, 2.6); // 周期：隔一两秒崩出一颗
    params[q + 1] = rng.next();
    params[q + 2] = rng.range(0.9, 2.0); // 初速
    params[q + 3] = rng.range(0.05, 0.115);
  }

  const geo = instancedQuad(count);
  geo.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(origins, 3));
  geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(params, 4));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(PALETTE.fireCore) },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute vec3 aOrigin;
      attribute vec4 aParam;
      varying vec2 vUv;
      varying float vAlpha;
      varying float vStretch;

      void main() {
        vUv = uv;
        float c = fract(uTime / aParam.x + aParam.y);   // 0 → 1 的一次性抛射
        float ph = aParam.y * 62.83;
        // 只在周期的前 45% 里存在，之后熄灭等待下一次
        float live = 1.0 - step(0.45, c);
        float k = clamp(c / 0.45, 0.0, 1.0);

        float ang = ph + aParam.z * 3.1;
        float speed = aParam.z * (0.45 + aParam.y * 0.9);
        vec3 off = vec3(cos(ang) * speed, 1.0, sin(ang) * speed * 0.8);
        // 抛物线：上升减速、下落加速
        vec3 world = aOrigin + off * k * 1.15 + vec3(0.0, -1.0, 0.0) * (3.6 * k * k);

        vStretch = 1.0 + 2.4 * k;
        vec4 mv = modelViewMatrix * vec4(world, 1.0);
        mv.xy += vec2(position.x * aParam.w, position.y * aParam.w * vStretch);
        gl_Position = projectionMatrix * mv;

        float fade = smoothstep(0.0, 0.12, c) * pow(1.0 - clamp(c / 0.45, 0.0, 1.0), 1.5);
        vAlpha = live * fade;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying vec2 vUv;
      varying float vAlpha;
      varying float vStretch;

      void main() {
        vec2 p = (vUv - vec2(0.5, 0.5)) * vec2(1.0, 1.0 / max(0.35, vStretch) * 0.6 + 0.4);
        float d = length(p) * 2.0;
        float body = exp(-d * d * 2.2);
        float a = body * vAlpha * 0.9;
        if (a < 0.005) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });

  ctx.ticker.add((elapsed) => {
    mat.uniforms['uTime'].value = elapsed;
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'fx-ember-sparks';
  mesh.frustumCulled = false;
  mesh.renderOrder = 14;
  return mesh;
}

function addTankEmbers(
  ctx: BuildContext,
  rng: Rng,
  puffs: PuffField,
  group: THREE.Group,
  updaters: Updater[],
): void {
  const t72 = HOTSPOTS.t72;

  // 车体局部坐标 -> 世界坐标（T-72 模型绕 Y 轴旋转过）
  const cosR = Math.cos(t72.rotY);
  const sinR = Math.sin(t72.rotY);
  const toWorld = (lx: number, ly: number, lz: number): [number, number, number] => [
    t72.x + lx * cosR + lz * sinR,
    ly,
    t72.z - lx * sinR + lz * cosR,
  ];

  // 余烬光斑：座圈破口、两处车体破口、炮塔顶、发动机舱、首上装甲
  // y 必须高于车体顶板（约 1.5m），否则会被车体挡住
  const spots: Array<{ p: [number, number, number]; r: number }> = [
    { p: toWorld(0.0, 1.76, -0.05), r: 0.52 },
    { p: toWorld(1.36, 1.3, -0.55), r: 0.32 },
    { p: toWorld(-1.36, 1.44, 0.75), r: 0.32 },
    { p: toWorld(0.62, 2.5, -0.16), r: 0.3 },
    { p: toWorld(0.0, 1.66, -2.15), r: 0.38 },
    { p: toWorld(0.0, 1.62, 2.05), r: 0.26 },
  ];
  // 三处小火的底部暖光晕：让远处也能读出这里在烧
  const halos: Array<{ p: [number, number, number]; r: number }> = [
    { p: [6.9, 0.55, 11.4], r: 1.35 },
    { p: [-19.2, 0.5, -4.9], r: 1.1 },
    { p: [24.4, 0.55, 9.6], r: 0.95 },
  ];

  const count = spots.length + halos.length;
  const origins = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const params = new Float32Array(count * 4); // 半径、相位、强度、频率
  const emberCold = new THREE.Color(PALETTE.ember);
  const emberHot = new THREE.Color(PALETTE.fireCore);

  spots.forEach((s, i) => {
    const o = i * 3;
    origins[o] = s.p[0];
    origins[o + 1] = s.p[1];
    origins[o + 2] = s.p[2];
    const tint = emberCold.clone().lerp(emberHot, rng.range(0.2, 0.75));
    colors[o] = tint.r;
    colors[o + 1] = tint.g;
    colors[o + 2] = tint.b;
    const q = i * 4;
    params[q] = s.r;
    params[q + 1] = rng.next();
    params[q + 2] = rng.range(0.7, 1.1);
    params[q + 3] = rng.range(0.55, 1.35); // 呼吸频率，周期约 4.7-11 秒
  });

  const haloColor = new THREE.Color(PALETTE.fire);
  const haloCore = new THREE.Color(PALETTE.fireCore);
  halos.forEach((s, k) => {
    const i = spots.length + k;
    const o = i * 3;
    origins[o] = s.p[0];
    origins[o + 1] = s.p[1];
    origins[o + 2] = s.p[2];
    const tint = haloColor.clone().lerp(haloCore, 0.35);
    colors[o] = tint.r;
    colors[o + 1] = tint.g;
    colors[o + 2] = tint.b;
    const q = i * 4;
    params[q] = s.r;
    params[q + 1] = rng.next();
    params[q + 2] = rng.range(0.22, 0.34);
    params[q + 3] = rng.range(4.5, 7.5); // 火光高频轻微跳动
  });

  const geo = instancedQuad(count);
  geo.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(origins, 3));
  geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 3));
  geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(params, 4));

  // 余烬光晕用纯数学柔光（柔核 + 更软的外扩），不需要额外贴图
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute vec3 aOrigin;
      attribute vec3 aColor;
      attribute vec4 aParam;
      varying float vAlpha;
      varying vec3 vColor;
      varying vec2 vUv;

      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(aOrigin, 1.0);
        mv.xy += position.xy * aParam.x * 2.0;
        gl_Position = projectionMatrix * mv;

        float ph = aParam.y * 6.2831853;
        float breathe = 0.5 + 0.3 * sin(uTime * aParam.w + ph) + 0.22 * sin(uTime * aParam.w * 2.45 + ph * 1.7);
        float flare = pow(max(0.0, sin(uTime * 0.41 + ph)), 16.0);
        vAlpha = aParam.z * max(0.12, breathe) + flare * 0.55;
        vColor = aColor;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      varying vec3 vColor;
      varying vec2 vUv;

      void main() {
        float d = length(vUv - 0.5) * 2.0;
        float coreV = exp(-d * d * 3.2);
        float halo = exp(-d * d * 0.9) * 0.34;
        float a = (coreV + halo) * vAlpha;
        if (a < 0.004) discard;
        gl_FragColor = vec4(vColor, a);
      }
    `,
  });

  updaters.push((t) => {
    mat.uniforms['uTime'].value = t;
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'fx-ember-glow';
  mesh.frustumCulled = false;
  mesh.renderOrder = 13;
  group.add(mesh);

  // 偶尔崩出的火星（顶点着色器里的抛物线抛射，一次 draw call）
  group.add(buildEmberSparks(ctx, rng.fork(11), new THREE.Vector3(t72.x, 1.72, t72.z)));

  // 余烬的照明（呼吸式明灭的主体）
  const light = new THREE.PointLight(PALETTE.ember, 6, 11, 2);
  light.position.set(t72.x, 1.5, t72.z);
  ctx.addLight(light);
  updaters.push((t) => {
    light.intensity = 3.2 + emberPulse(t) * 7.5;
  });

  // 余烬上方极淡的一缕热烟（挂在浓烟场里，跟着烟柱一起升）
  for (let i = 0; i < 3; i += 1) {
    const spawner: PuffSpawner = () => ({
      x: t72.x + rng.range(-0.5, 0.5),
      y: rng.range(1.6, 2.3),
      z: t72.z + rng.range(-0.4, 0.4),
      vx: rng.range(0.15, 0.4),
      vy: rng.range(0.75, 1.2),
      vz: rng.range(-0.15, 0.15),
      buoyancy: -0.035,
      spread: rng.range(0.05, 0.14),
      size0: rng.range(0.5, 0.85),
      size1: rng.range(2.0, 3.0),
      alpha: rng.range(0.18, 0.27),
      life: rng.range(4.5, 7),
      wobble: rng.range(0.25, 0.6),
      phase: rng.range(0, 6.28),
      spin: rng.range(-0.1, 0.1),
      color: smokeColor(rng, 0.2),
    });
    puffs.add(spawner, rng.next());
  }
}

// ---------------------------------------------------------------------------
// 2. T-72 烟柱：底浓顶散的分层烟柱
// ---------------------------------------------------------------------------
/**
 * 一根烟柱由两种种子交替组成：
 * - base：出生小、浓、几乎不铺开 → 柱子下段读起来是"浓"
 * - top ：出生就大、稀、横向铺开快 → 上段读起来是"散"
 * 两者在同一处生成、同一速度上升，中间自然过渡，不会出现"棉花团"。
 */
function addTankPlume(rng: Rng, dense: PuffField, thin: PuffField): void {
  const t72 = HOTSPOTS.t72;
  const baseCount = 14;
  for (let i = 0; i < baseCount; i += 1) {
    const spawner: PuffSpawner = () => ({
      x: t72.x + rng.range(-0.55, 0.55),
      y: rng.range(1.6, 2.1),
      z: t72.z + rng.range(-0.55, 0.55),
      vx: rng.range(0.06, 0.22),
      vy: rng.range(0.85, 1.25),
      vz: rng.range(-0.12, 0.14),
      buoyancy: -0.02,
      // 下段几乎不铺开：浓
      spread: rng.range(0.02, 0.07),
      size0: rng.range(0.55, 0.95),
      size1: rng.range(2.3, 3.4),
      // 单个粒子更淡，靠数量叠出浓度（不会糊成一坨实心白）
      alpha: rng.range(0.2, 0.3),
      life: rng.range(3.4, 5.4),
      wobble: rng.range(0.18, 0.45),
      phase: rng.range(0, 6.28),
      spin: rng.range(-0.14, 0.14),
      color: smokeColor(rng, 0.34),
    });
    dense.add(spawner, (i / baseCount) * 0.9);
  }

  // 上段：更大、更稀、铺开更快（同一根柱子的"散开"部分）
  const topCount = 12;
  for (let i = 0; i < topCount; i += 1) {
    const spawner: PuffSpawner = () => ({
      x: t72.x + rng.range(-0.7, 0.7),
      y: rng.range(3.6, 4.8),
      z: t72.z + rng.range(-0.7, 0.7),
      vx: rng.range(0.3, 0.85),
      vy: rng.range(0.55, 0.95),
      vz: rng.range(-0.35, 0.35),
      buoyancy: 0.055,
      spread: rng.range(0.3, 0.7),
      size0: rng.range(1.6, 2.6),
      size1: rng.range(5.4, 7.6),
      alpha: rng.range(0.08, 0.14),
      life: rng.range(6.5, 10),
      wobble: rng.range(0.6, 1.3),
      phase: rng.range(0, 6.28),
      spin: rng.range(-0.16, 0.16),
      color: smokeColor(rng, 0.5),
    });
    thin.add(spawner, (i / topCount) * 0.9);
  }
}

// ---------------------------------------------------------------------------
// 3. 远处硝烟（更薄、更远、更慢）—— 挂在薄烟场里
// ---------------------------------------------------------------------------
function addDistantSmoke(rng: Rng, puffs: PuffField): void {
  const plumes = [
    { x: -52, z: -52 },
    { x: 54, z: 44 },
    { x: -47, z: 53 },
    { x: 55, z: -49 },
  ];
  plumes.forEach((p) => {
    for (let i = 0; i < 5; i += 1) {
      const spawner: PuffSpawner = () => ({
        x: p.x + rng.range(-2.4, 2.4),
        y: rng.range(0.4, 2.5),
        z: p.z + rng.range(-2.4, 2.4),
        vx: rng.range(-0.1, 0.18),
        vy: rng.range(0.28, 0.55),
        vz: rng.range(-0.1, 0.12),
        buoyancy: -0.008,
        spread: rng.range(0.05, 0.16),
        size0: rng.range(3.4, 5),
        size1: rng.range(12, 18),
        // 更薄：只有一层雾感的浓度
        alpha: rng.range(0.055, 0.1),
        life: rng.range(20, 30),
        wobble: rng.range(0.5, 1.4),
        phase: rng.range(0, 6.28),
        spin: rng.range(-0.05, 0.05),
        color: smokeColor(rng, 0.2),
      });
      puffs.add(spawner, (i / 5) * 0.9);
    }
  });
}

// ---------------------------------------------------------------------------
// 3.5 战争残留：工厂毒烟（黄绿）与击毁车辆白烟
// ---------------------------------------------------------------------------
function addWarSmoke(rng: Rng, toxic: PuffField, wreck: PuffField): void {
  const greenA = new THREE.Color(0xa3b33e);
  const greenB = new THREE.Color(0x65742a);
  for (const site of WARZONE.toxicSmoke) {
    for (let i = 0; i < 12; i += 1) {
      const spawner: PuffSpawner = () => ({
        x: site.x + rng.range(-1.8, 1.8),
        y: site.y + rng.range(0.2, 3.4),
        z: site.z + rng.range(-1.8, 1.8),
        vx: rng.range(-0.2, 0.3),
        vy: rng.range(0.7, 1.45),
        vz: rng.range(-0.18, 0.24),
        buoyancy: 0.035,
        spread: rng.range(0.16, 0.42),
        size0: rng.range(2.8, 4.4),
        size1: rng.range(11, 18),
        alpha: rng.range(0.17, 0.28),
        life: rng.range(13, 21),
        wobble: rng.range(0.9, 2.0),
        phase: rng.range(0, 6.28),
        spin: rng.range(-0.075, 0.075),
        color: greenA.clone().lerp(greenB, rng.next()),
      });
      toxic.add(spawner, (i / 12) * 0.9);
    }
  }

  const whiteA = new THREE.Color(0xa8b1b4);
  const whiteB = new THREE.Color(0x5d676b);
  for (const site of WARZONE.whiteSmoke) {
    for (let i = 0; i < 10; i += 1) {
      const spawner: PuffSpawner = () => ({
        x: site.x + rng.range(-0.85, 0.85),
        y: rng.range(1.15, 1.85),
        z: site.z + rng.range(-0.85, 0.85),
        vx: rng.range(-0.1, 0.42),
        vy: rng.range(0.65, 1.35),
        vz: rng.range(-0.1, 0.2),
        buoyancy: 0.025,
        spread: rng.range(0.08, 0.2),
        size0: rng.range(0.45, 0.8),
        size1: rng.range(1.6, 3.2),
        alpha: rng.range(0.18, 0.28),
        life: rng.range(2.4, 4.6),
        wobble: rng.range(0.5, 1.2),
        phase: rng.range(0, 6.28),
        spin: rng.range(-0.12, 0.12),
        color: whiteA.clone().lerp(whiteB, rng.next()),
      });
      wreck.add(spawner, (i / 10) * 0.9);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. 主妇做饭的蒸汽：从锅口升起 → 遇冷散开（颜色被炉火照暖）
// ---------------------------------------------------------------------------
function addSteam(rng: Rng, steam: PuffField, thin: PuffField): void {
  const shop = HOTSPOTS.shopInterior;
  // 锅口位置（灶台面高约 0.9m，锅沿 1.05m）
  const potY = 1.08;
  const warm = new THREE.Color(0xffd9ac);

  /* 阶段一：锅口上方 0.35~1.4m，小而密、快速上升（还没散开） */
  for (let i = 0; i < 18; i += 1) {
    const spawner: PuffSpawner = () => ({
      x: shop.x + rng.gauss(0, 0.11),
      y: potY + rng.range(0, 0.12),
      z: shop.z + rng.gauss(0, 0.11),
      vx: rng.gauss(0, 0.05),
      vy: rng.range(0.95, 1.5),
      vz: rng.gauss(0, 0.05),
      // 越往上越慢（遇冷）—— 用负浮力把它"刹住"
      buoyancy: -0.34,
      spread: rng.range(0.02, 0.06),
      size0: rng.range(0.1, 0.2),
      size1: rng.range(0.5, 0.85),
      alpha: rng.range(0.3, 0.5),
      life: rng.range(1.1, 1.9),
      wobble: rng.range(0.05, 0.16),
      phase: rng.range(0, 6.28),
      spin: rng.range(-0.2, 0.2),
      color: warm.clone().lerp(new THREE.Color(0xfff4e4), rng.range(0, 0.4)),
    });
    steam.add(spawner, rng.next());
  }

  /* 阶段二：1.4m 以上开始散开、变淡、变宽 */
  for (let i = 0; i < 14; i += 1) {
    const spawner: PuffSpawner = () => ({
      x: shop.x + rng.gauss(0, 0.3),
      y: potY + rng.range(1.5, 2.4),
      z: shop.z + rng.gauss(0, 0.3),
      vx: rng.gauss(0, 0.22),
      vy: rng.range(0.35, 0.7),
      vz: rng.gauss(0, 0.22),
      buoyancy: -0.08,
      spread: rng.range(0.16, 0.4),
      size0: rng.range(0.55, 0.95),
      size1: rng.range(1.9, 3.1),
      alpha: rng.range(0.1, 0.18),
      life: rng.range(2.6, 4.2),
      wobble: rng.range(0.18, 0.42),
      phase: rng.range(0, 6.28),
      spin: rng.range(-0.18, 0.18),
      color: warm.clone().lerp(new THREE.Color(0xdfe6ea), rng.range(0.35, 0.75)),
    });
    steam.add(spawner, rng.next());
  }

  // 门洞飘出的轻烟：慢慢向街口方向散
  for (let i = 0; i < 8; i += 1) {
    const spawner: PuffSpawner = () => ({
      x: shop.x - 1.15 + rng.range(-0.4, 0.4),
      y: rng.range(2.0, 2.8),
      z: shop.z + 0.9 + rng.range(-0.4, 0.4),
      vx: rng.range(-0.32, -0.1),
      vy: rng.range(0.12, 0.28),
      vz: rng.range(0.18, 0.45),
      buoyancy: 0.02,
      spread: rng.range(0.06, 0.18),
      size0: rng.range(0.4, 0.7),
      size1: rng.range(1.8, 3),
      alpha: rng.range(0.09, 0.16),
      life: rng.range(5, 8),
      wobble: rng.range(0.2, 0.5),
      phase: rng.range(0, 6.28),
      spin: rng.range(-0.12, 0.12),
      color: smokeColor(rng, 0.45),
    });
    thin.add(spawner, rng.next());
  }
}

// ---------------------------------------------------------------------------
// 5. 局部小火苗：三层火舌（核心白 / 外焰橙 / 上层暗红）
// ---------------------------------------------------------------------------
interface FireSpot {
  x: number;
  y: number;
  z: number;
  scale: number;
}

/** 层序号 → 比例宽度 / 高度 / 亮度 / 纵向色标起点 */
const FLAME_TIER = [
  { w: 0.42, h: 1.0, bright: 1.0, y0: 0.02 }, // 0：外焰（最宽最高，橙）
  { w: 0.62, h: 0.62, bright: 1.15, y0: 0.05 }, // 1：外焰内层（更亮）
  { w: 0.3, h: 0.36, bright: 1.45, y0: 0.08 }, // 2：核心（近白，最矮最窄）
] as const;

function addFires(ctx: BuildContext, rng: Rng, group: THREE.Group, updaters: Updater[]): void {
  // 路口瓦砾堆、烧毁轿车旁、路缘垃圾桶
  const fires: FireSpot[] = [
    { x: 6.9, y: 0.22, z: 11.4, scale: 1.15 },
    { x: -19.2, y: 0.08, z: -4.9, scale: 0.95 },
    { x: 24.4, y: 0.2, z: 9.6, scale: 0.8 },
  ];

  // 每层 3 片（朝向错开）→ 3 处火 × 3 层 × 3 片 = 27 个实例
  const perTier = 3;
  const tiers = FLAME_TIER.length;
  const count = fires.length * tiers * perTier;
  const origins = new Float32Array(count * 3);
  const params = new Float32Array(count * 3); // 朝向、宽、高
  const seeds = new Float32Array(count * 3); // 相位、层序号、种子

  let n = 0;
  fires.forEach((f) => {
    for (let t = 0; t < tiers; t += 1) {
      const tier = FLAME_TIER[t] as (typeof FLAME_TIER)[number];
      for (let i = 0; i < perTier; i += 1) {
        const o = n * 3;
        origins[o] = f.x + rng.range(-0.05, 0.05);
        origins[o + 1] = f.y;
        origins[o + 2] = f.z + rng.range(-0.05, 0.05);
        params[o] = (i / perTier) * Math.PI + rng.range(-0.1, 0.1);
        params[o + 1] = rng.range(0.36, 0.52) * f.scale * tier.w;
        params[o + 2] = rng.range(0.8, 1.15) * f.scale * tier.h;
        seeds[o] = rng.next();
        seeds[o + 1] = t;
        seeds[o + 2] = rng.range(0, 100);
        n += 1;
      }
    }
  });

  const geo = instancedQuad(count);
  geo.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(origins, 3));
  geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(params, 3));
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uMap: { value: flameTexture() },
      uCore: { value: new THREE.Color(0xfff1cf) }, // 核心：近白
      uMid: { value: new THREE.Color(PALETTE.fireCore) }, // 中层：亮橙
      uFire: { value: new THREE.Color(PALETTE.fire) }, // 外焰：橙
      uEdge: { value: new THREE.Color(0x8f2c10) }, // 上层：暗红
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute vec3 aOrigin;
      attribute vec3 aParam;
      attribute vec3 aSeed;
      varying vec2 vUv;
      varying float vFlick;
      varying float vTier;
      varying float vSeed;

      /** 多层不可约频率叠加 + 低频门控 => 不规则跳动，不是匀速正弦 */
      float flicker(float t, float seed) {
        float a = sin(t * 9.1 + seed) * 0.16;
        float b = sin(t * 21.7 + seed * 2.7) * 0.10;
        float c = sin(t * 3.3 + seed * 1.3) * 0.13;
        float gate = 0.5 + 0.5 * sin(t * 1.27 + seed * 0.9);
        float burst = pow(gate, 3.0) * 0.22;
        return 0.80 + a + b + c + burst;
      }

      void main() {
        vUv = uv;
        float seed = aSeed.x * 6.2831853 + aSeed.z;
        vFlick = flicker(uTime, seed);
        vTier = aSeed.y;
        vSeed = aSeed.z;

        float h = aParam.z * vFlick;
        vec3 right = vec3(cos(aParam.x), 0.0, sin(aParam.x)) * aParam.y;
        vec3 world = aOrigin + right * position.x + vec3(0.0, 1.0, 0.0) * ((position.y + 0.5) * h);
        // 火苗左右摇摆（每层不同步，读起来是"几股火舌在打架"）
        world.x += sin(uTime * 4.7 + seed) * 0.035 * (position.y + 0.5);
        world.z += cos(uTime * 4.1 + seed * 1.4) * 0.035 * (position.y + 0.5);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec3 uCore;
      uniform vec3 uMid;
      uniform vec3 uFire;
      uniform vec3 uEdge;
      varying vec2 vUv;
      varying float vFlick;
      varying float vTier;
      varying float vSeed;

      void main() {
        float a = texture2D(uMap, vUv).a;
        if (a < 0.01) discard;

        // 三层火舌的色阶：核心（近白）→ 外焰（橙）→ 上层（暗红）
        float y = vUv.y;
        vec3 col;
        float bright;
        if (vTier < 0.5) {
          // 外层火舌：底部橙 → 中段亮橙 → 上部暗红（火苗"变冷"的部分）
          col = mix(uMid, uFire, smoothstep(0.02, 0.42, y));
          col = mix(col, uEdge, smoothstep(0.62, 0.98, y));
          bright = 0.82;
        } else if (vTier < 1.5) {
          col = mix(uMid, uFire, smoothstep(0.05, 0.55, y));
          bright = 1.0;
        } else {
          // 核心：近白，只在火苗下半部分
          col = mix(uCore, uMid, smoothstep(0.05, 0.45, y));
          bright = 1.25;
        }
        gl_FragColor = vec4(col * bright * (0.82 + 0.38 * vFlick), a * 0.88);
      }
    `,
  });
  updaters.push((t) => {
    mat.uniforms['uTime'].value = t;
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'fx-flames';
  mesh.frustumCulled = false;
  mesh.renderOrder = 14;
  group.add(mesh);

  // 火光：轻微跳动（位置/亮度高频小幅随机）
  fires.forEach((f, i) => {
    const light = new THREE.PointLight(PALETTE.fire, 12, 16, 2);
    light.position.set(f.x, f.y + 0.8, f.z);
    ctx.addLight(light);
    const seed = rng.range(0, 6.28);
    updaters.push((t) => {
      const flick = 0.72 + 0.2 * Math.sin(t * 7.3 + seed) + 0.12 * Math.sin(t * 17.1 + seed * 2.3);
      light.intensity = (9 + i * 1.5) * flick;
      light.position.y = f.y + 0.75 + Math.sin(t * 3.1 + seed) * 0.06;
    });
  });
}

// ---------------------------------------------------------------------------
// 6. 贴地薄雾（缓慢流动的极淡雾片）
// ---------------------------------------------------------------------------
function buildMist(rng: Rng, updaters: Updater[]): THREE.Mesh {
  const count = 10;
  const centers = new Float32Array(count * 3);
  const params = new Float32Array(count * 4); // 半宽、半深、相位、透明度
  for (let i = 0; i < count; i += 1) {
    const o = i * 3;
    centers[o] = rng.range(-46, 46);
    centers[o + 1] = rng.range(0.35, 0.95);
    centers[o + 2] = rng.range(-46, 46);
    const q = i * 4;
    params[q] = rng.range(4, 8);
    params[q + 1] = rng.range(3, 6.5);
    params[q + 2] = rng.next();
    params[q + 3] = rng.range(0.09, 0.15);
  }

  const geo = instancedQuad(count);
  geo.setAttribute('aCenter', new THREE.InstancedBufferAttribute(centers, 3));
  geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(params, 4));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(0x7d95ab) },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute vec3 aCenter;
      attribute vec4 aParam;
      varying vec2 vUv;
      varying float vAlpha;

      void main() {
        vUv = uv;
        vec3 c = aCenter;
        c.x += sin(uTime * 0.05 + aParam.z * 6.2831853) * 2.6;
        c.z += cos(uTime * 0.037 + aParam.z * 4.1) * 2.1;
        vec3 world = vec3(c.x + position.x * aParam.x * 2.0, c.y, c.z + position.y * aParam.y * 2.0);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
        vAlpha = aParam.w * (0.7 + 0.3 * sin(uTime * 0.19 + aParam.z * 6.2831853));
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying vec2 vUv;
      varying float vAlpha;

      void main() {
        // 纯数学柔边：椭圆高斯，横向拉长，没有方形接缝
        vec2 p = (vUv - 0.5) * vec2(2.6, 2.0);
        float d = dot(p, p);
        float mask = exp(-d * 1.35);
        float a = mask * vAlpha;
        if (a < 0.004) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });

  updaters.push((t) => {
    mat.uniforms['uTime'].value = t;
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'fx-mist';
  mesh.frustumCulled = false;
  mesh.renderOrder = 8;
  return mesh;
}
