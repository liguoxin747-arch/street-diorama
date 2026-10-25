import * as THREE from 'three';
import type { BuildContext } from '../core/context';
import { PALETTE } from '../core/palette';
import { toonMaterial } from '../core/materials';
import { DAY } from '../core/dayState';

/**
 * 窗光层：生活暖光 30% / 战火燃烧 10% / 其余保持黑暗。
 *
 * 为什么不是"每个窗一个 Mesh + PointLight"：
 *  - 建筑窗户已被合批进共享材质，场景 1281 个 mesh、约 1000 draw call 就是靠合批换来的；
 *    逐窗独立 Mesh 会加几千个 draw call，逐窗点光更是直接爆掉（全工程点光上限 16 盏）。
 *  - 这里只加 **1 个 InstancedMesh**：每扇亮窗一个实例，闪烁完全在着色器里按
 *    uTime + 每实例种子计算，CPU 每帧只更新一个 uniform。
 *
 * 窗户从哪来：`toonMaterial` 是带缓存的工厂，town / quarters 的 M.glass 是同一个材质实例。
 * 遍历场景里用该材质的合并网格，把每 6 个顶点（一个四边形）还原成一扇窗，
 * 免去在四个建筑模块里逐扇登记。碎玻璃（glassBroken）不在其中，不会被点亮。
 *
 * 颜色与强度走加色混合，亮度受昼夜的 uLightsOn 控制（白天自动熄灭，黄昏渐起），
 * 再由既有的 UnrealBloomPass 产生光晕——这就是"灯有体积感"的来源。
 */

/** 与 town/quarters 里的 M.glass 完全一致（缓存会返回同一个实例） */
function glassMaterial(): THREE.Material {
  return toonMaterial(PALETTE.glassDark, { steps: 2 });
}

export interface Pane {
  center: THREE.Vector3;
  normal: THREE.Vector3;
  w: number;
  h: number;
}

/** 从合并后的玻璃网格里还原每一扇窗 */
export function collectPanes(root: THREE.Object3D): Pane[] {
  const glass = glassMaterial();
  const panes: Pane[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const d = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();

  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || mesh.material !== glass) return;
    const geo = mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position');
    const nor = geo.getAttribute('normal');
    if (!pos || pos.count < 6) return;

    for (let i = 0; i + 5 < pos.count; i += 6) {
      a.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos, i + 1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos, i + 2).applyMatrix4(mesh.matrixWorld);
      d.fromBufferAttribute(pos, i + 5).applyMatrix4(mesh.matrixWorld);
      edge1.subVectors(b, a);
      edge2.subVectors(d, a);
      const w = edge1.length();
      const h = edge2.length();
      // 门窗都很小；挡住极个别被当作玻璃用的大面片
      if (w < 0.12 || h < 0.12 || w > 6 || h > 6) continue;
      if (nor) normal.fromBufferAttribute(nor, i).transformDirection(mesh.matrixWorld);
      else normal.set(0, 0, 1);
      panes.push({
        center: new THREE.Vector3().addVectors(a, c).multiplyScalar(0.5),
        normal: normal.clone(),
        w,
        h,
      });
    }
  });
  return panes;
}

const VERT = /* glsl */ `
  attribute vec2 aSize;
  attribute float aSeed;
  attribute float aKind;     // 0 = 生活暖光，1 = 战火
  attribute vec3 aTint;
  varying vec2 vUv;
  varying float vSeed;
  varying float vKind;
  varying vec3 vTint;
  varying float vFade;
  void main() {
    vUv = uv;
    vSeed = aSeed;
    vKind = aKind;
    vTint = aTint;
    vec4 mv = modelViewMatrix * instanceMatrix * vec4( position * vec3( aSize, 1.0 ), 1.0 );
    gl_Position = projectionMatrix * mv;
    // 加色发光件不能套标准雾（fog_fragment 会把颜色 mix 向雾色 = 越远越亮），
    // 改为按视深淡出，远处窗光自然沉进夜色
    vFade = 1.0 - smoothstep( 120.0, 300.0, -mv.z );
  }
`;

const FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uLightsOn;
  uniform float uNight;
  varying vec2 vUv;
  varying float vSeed;
  varying float vKind;
  varying vec3 vTint;
  varying float vFade;

  float h11( float n ) { return fract( sin( n * 127.1 ) * 43758.5453 ); }

  void main() {
    // 实例画的是 1.55 倍窗面：中间 1.0 是窗，外面 0.55 是洒在墙上的光溢
    vec2 p = ( vUv - 0.5 ) * 2.0 * 1.55;
    float ax = abs( p.x );
    float ay = abs( p.y );
    float outside = max( max( ax, ay ) - 1.0, 0.0 );

    // 窗框与窗棂（只在窗内生效）
    float frame = smoothstep( 0.90, 1.0, max( ax, ay ) );
    float mullion = smoothstep( 0.05, 0.0, min( ax, ay ) );
    float pane = ( 1.0 - frame ) * ( 1.0 - mullion * 0.9 );

    // 室内是"离窗越深越暗"：中心亮、靠窗框一圈压暗，像真正有进深的房间
    float depthFall = 1.0 - smoothstep( 0.25, 1.0, max( ax, ay ) ) * 0.72;

    // 墙上的光溢：贴着窗边最亮，两个窗宽内衰减干净
    float spill = exp( -outside * 2.4 ) * ( 1.0 - pane );

    float flick = 1.0;
    vec3 tint = vTint;
    float power = 1.0;
    if ( vKind < 0.5 ) {
      // 生活暖光：老灯管/电压不稳——慢速起伏 + 偶发一次短促压暗
      float slow = 0.88 + 0.12 * sin( uTime * ( 0.5 + vSeed * 1.3 ) + vSeed * 31.0 );
      float dip = h11( floor( uTime * 0.33 + vSeed * 57.0 ) * 13.7 + vSeed );
      slow *= mix( 1.0, 0.45, step( 0.94, dip ) );
      flick = slow;
      power = 0.34;
    } else if ( vKind < 1.5 ) {
      // 战火：高频大幅跳动 + 橙红插值 + 低频热浪
      float f = 0.6
        + 0.3 * sin( uTime * ( 8.0 + vSeed * 6.0 ) + vSeed * 19.0 )
        + 0.2 * sin( uTime * ( 21.0 + vSeed * 9.0 ) + vSeed * 5.0 );
      flick = max( 0.15, f ) * ( 0.78 + 0.22 * sin( uTime * 1.6 + vSeed * 3.0 ) );
      tint = mix( vec3( 0.8, 0.15, 0.05 ), vec3( 1.0, 0.58, 0.16 ), 0.5 + 0.5 * sin( uTime * 5.0 + vSeed * 12.0 ) );
      power = 0.5;
    } else {
      // 电视：冷蓝，快而细的亮度抖动（屏幕内容在跳）
      flick = 0.72 + 0.28 * h11( floor( uTime * 7.0 + vSeed * 40.0 ) );
      power = 0.22;
    }

    // 白天只剩极弱待机光；窗外的光溢比窗内更弱，才不像贴纸
    float day = mix( 0.05, 1.0, uLightsOn );
    float a = ( pane * depthFall * 1.0 + spill * 0.22 ) * flick * day * vFade;
    if ( a < 0.004 ) discard;
    gl_FragColor = vec4( tint * power * ( 0.75 + 0.45 * depthFall ), a );
  }
`;


/** 窗光最密的一层：单个 InstancedMesh，一次 draw call */
export function buildWindowLights(ctx: BuildContext): THREE.Group {
  const root = new THREE.Group();
  root.name = 'window-lights';
  const rng = ctx.rng.fork(0x51d3);

  const glass = glassMaterial();
  let glassMeshes = 0;
  ctx.root.traverse((o) => {
    const mm = (o as THREE.Mesh).material;
    if ((o as THREE.Mesh).isMesh && mm === glass) glassMeshes += 1;
  });
  console.info(`[windowLights] 玻璃合并网格 ${glassMeshes} 个`);
  const panes = collectPanes(ctx.root);
  console.info(`[windowLights] 找到窗面 ${panes.length} 扇`);
  if (panes.length === 0) return root;

  // 按比例分配：每 10 扇里 3 扇生活暖光、1 扇战火（用确定性 RNG，场景可复现）
  const lit: Array<{ pane: Pane; kind: 0 | 1 | 2; seed: number }> = [];
  for (const pane of panes) {
    const roll = rng.next();
    if (roll < 0.28) lit.push({ pane, kind: 0, seed: rng.range(0, 97) });
    else if (roll < 0.36) lit.push({ pane, kind: 1, seed: rng.range(0, 97) });
    else if (roll < 0.4) lit.push({ pane, kind: 2, seed: rng.range(0, 97) });
  }
  console.info(`[windowLights] 点亮 ${lit.length} 扇`);
  if (lit.length === 0) return root;

  const quad = new THREE.PlaneGeometry(1, 1);
  const sizes = new Float32Array(lit.length * 2);
  const seeds = new Float32Array(lit.length);
  const kinds = new Float32Array(lit.length);
  const tints = new Float32Array(lit.length * 3);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uLightsOn: DAY.uLightsOn,
      uNight: DAY.uNightMix,
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  // 每扇亮窗一个实例，全部共用这一个材质（一次 draw call）
  const mesh = new THREE.InstancedMesh(quad, mat, lit.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 0, 1);
  const tmp = new THREE.Vector3();

  lit.forEach((item, i) => {
    const { pane } = item;
    q.setFromUnitVectors(up, pane.normal);
    // 窗玻璃在墙里凹进约 2 cm（town 里是 glassD - 0.02），发光面必须外移到墙面之外，
    // 否则整片被自己的墙做深度测试挡掉（418 个实例一个都看不见，就是这么来的）
    tmp.copy(pane.center).addScaledVector(pane.normal, 0.022);
    m.compose(tmp, q, new THREE.Vector3(1, 1, 1));
    mesh.setMatrixAt(i, m);
    sizes[i * 2] = pane.w * 1.55;
    sizes[i * 2 + 1] = pane.h * 1.55;
    seeds[i] = item.seed;
    kinds[i] = item.kind;
    // 暖光偏琥珀、战火偏深橙（具体色在着色器里再做亮度与抖动）
    const warmTones = [0xffb45e, 0xffa348, 0xffc98a, 0xe8c373, 0xd9b06a];
    const c =
      item.kind === 0
        ? new THREE.Color(warmTones[Math.floor(rng.next() * warmTones.length)]!)
        : item.kind === 1
          ? new THREE.Color(0xff5a1e)
          : new THREE.Color(0xa9c4e0);
    tints[i * 3] = c.r;
    tints[i * 3 + 1] = c.g;
    tints[i * 3 + 2] = c.b;
  });
  quad.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizes, 2));
  quad.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  quad.setAttribute('aKind', new THREE.InstancedBufferAttribute(kinds, 1));
  quad.setAttribute('aTint', new THREE.InstancedBufferAttribute(tints, 3));

  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  mesh.name = `window-lights-inst(${lit.length})`;
  mesh.castShadow = false;
  root.add(mesh);

  // 着火窗的浓烟：一个 Points，全部在顶点着色器里随 uTime 循环上升
  const fire = lit.filter((l) => l.kind === 1).slice(0, 64);
  if (fire.length > 0) {
    const per = 5;
    const n = fire.length * per;
    const pos = new Float32Array(n * 3);
    const seedA = new Float32Array(n);
    const sizeA = new Float32Array(n);
    let k = 0;
    for (const f of fire) {
      const drift = rng.range(-0.25, 0.25);
      for (let j = 0; j < per; j += 1) {
        pos[k * 3] = f.pane.center.x + drift * j;
        pos[k * 3 + 1] = f.pane.center.y + f.pane.h * 0.5;
        pos[k * 3 + 2] = f.pane.center.z + drift * j * 0.6;
        seedA[k] = (k % per) / per;
        sizeA[k] = rng.range(0.5, 1.15);
        k += 1;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seedA, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizeA, 1));
    const smokeMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uLightsOn: DAY.uLightsOn, uPixelScale: { value: 300 } },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uLightsOn;
        uniform float uPixelScale;
        attribute float aSeed;
        attribute float aSize;
        varying float vAlpha;
        void main() {
          float life = fract( uTime * 0.22 + aSeed );
          vec3 p = position;
          p.y += life * 3.4;
          p.x += sin( life * 3.0 + aSeed * 20.0 ) * 0.5 * life;
          p.z += cos( life * 2.4 + aSeed * 13.0 ) * 0.4 * life;
          vec4 mv = modelViewMatrix * vec4( p, 1.0 );
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp( ( 0.55 + life * 1.9 ) * uPixelScale / max( 1.0, -mv.z ), 1.0, 90.0 );
          vAlpha = sin( life * 3.14159 ) * 0.5 * mix( 0.15, 1.0, uLightsOn );
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        void main() {
          vec2 d = gl_PointCoord - vec2( 0.5 );
          float m = smoothstep( 0.5, 0.05, length( d ) );
          if ( m * vAlpha < 0.004 ) discard;
          gl_FragColor = vec4( vec3( 0.13, 0.12, 0.12 ), m * vAlpha );
        }
      `,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const smoke = new THREE.Points(geo, smokeMat);
    smoke.name = 'window-fire-smoke';
    smoke.frustumCulled = false;
    smoke.renderOrder = 5;
    root.add(smoke);
    ctx.ticker.add((t) => {
      smokeMat.uniforms['uTime'].value = t;
    });
  }

  ctx.ticker.add((t) => {
    mat.uniforms['uTime'].value = t;
  });
  return root;
}
