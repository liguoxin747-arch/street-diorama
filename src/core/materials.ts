import * as THREE from 'three';
import { PALETTE } from './palette';
import { DAY } from './dayState';

/**
 * 三渲二材质工厂。
 * - 卡通阶梯光照（MeshToonMaterial + 3/4 阶渐变贴图）
 * - 反向外扩描边（inverted hull），保证轮廓干净明确
 * - 所有材质默认共享缓存，控制 draw state 数量
 */


/* ------------------------------------------------------------------ *
 * 昼夜循环的着色器注入
 *
 * 注入点选在 getGradientIrradiance 内部：三渲二的"分带"就是在这里产生的，
 * 只有在这一层动手，才能让阳面色温与阴面环境色**分开**变化。
 * 灯光本身保持白色（色温由 uSunColor 承担）——这个函数的返回值之后还要乘灯光色，
 * 若灯光自带色温，阴面也会被一起染色（黄昏的阴影会变成橙色，完全错掉）。
 * ------------------------------------------------------------------ */

const DAY_UNIFORMS_DECL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uShadowTint;
uniform float uHarden;
uniform vec3 uRimColor;
uniform float uRimStrength;
`;

/*
 * 分带函数覆盖：onBeforeCompile 拿到的 shader 里 #include 还没展开，
 * 所以必须替换 **include 标记**、交回一份同名同签名的 getGradientIrradiance，
 * 而不是去改 chunk 内部的函数体（那样匹配永远落空，且会静默失效）。
 */
const GRADIENT_INCLUDE = '#include <gradientmap_pars_fragment>';

const GRADIENT_OVERRIDE = /* glsl */ `
#ifdef USE_GRADIENTMAP
	uniform sampler2D gradientMap;
#endif

vec3 getGradientIrradiance( vec3 normal, vec3 lightDirection ) {
	float dotNL = dot( normal, lightDirection );
	vec2 coord = vec2( dotNL * 0.5 + 0.5, 0.0 );

	#ifdef USE_GRADIENTMAP
		float band = texture2D( gradientMap, coord ).r;
		// 硬边锐化：正午把柔和三阶推成接近阶跃，得到几何切割感；夜里仍保留三层
		band = mix( band, smoothstep( 0.42, 0.58, band ), uHarden );
		// 阳面走光色温、阴面走环境色：分开染色才不破坏三渲二的色块关系
		return uSunColor * band + uShadowTint * ( 1.0 - band );
	#else
		vec2 fw = fwidth( coord ) * 0.5;
		return mix( vec3( 0.7 ), vec3( 1.0 ), smoothstep( 0.7 - fw.x, 0.7 + fw.x, coord.x ) );
	#endif
}
`;

const DITHER_INCLUDE = '#include <dithering_fragment>';

const RIM_BLOCK = /* glsl */ `
	// 边缘光：低角度太阳（黄昏）从背后掠过时，轮廓边缘亮起
	{
		vec3 rimN = normalize( vNormal );
		vec3 rimV = normalize( vViewPosition );
		vec3 sunView = normalize( ( viewMatrix * vec4( uSunDir, 0.0 ) ).xyz );
		float fres = pow( 1.0 - saturate( dot( rimN, rimV ) ), 2.6 );
		float side = max( 0.0, dot( rimN, sunView ) );
		gl_FragColor.rgb += uRimColor * fres * uRimStrength * ( 0.3 + 0.7 * side );
	}
`;

function injectDay(mat: THREE.MeshToonMaterial): void {
  mat.onBeforeCompile = (shader) => {
    const u = shader.uniforms as Record<string, unknown>;
    u['uSunDir'] = DAY.uSunDir;
    u['uSunColor'] = DAY.uSunColor;
    u['uShadowTint'] = DAY.uShadowTint;
    u['uHarden'] = DAY.uHarden;
    u['uRimColor'] = DAY.uRimColor;
    u['uRimStrength'] = DAY.uRimStrength;
    let frag = DAY_UNIFORMS_DECL + shader.fragmentShader;
    // 两处替换都必须命中；命中不了就显式报警，绝不允许"静默不注入"
    if (frag.includes(GRADIENT_INCLUDE)) {
      frag = frag.replace(GRADIENT_INCLUDE, GRADIENT_OVERRIDE);
    } else {
      console.warn('[materials] 昼夜分带注入失败：找不到 gradientmap include 标记');
    }
    if (frag.includes(DITHER_INCLUDE)) {
      frag = frag.replace(DITHER_INCLUDE, `${RIM_BLOCK}${DITHER_INCLUDE}`);
    } else {
      console.warn('[materials] 边缘光注入失败：找不到 dithering include 标记');
    }
    shader.fragmentShader = frag;
  };
  // 注入内容对所有卡通材质一致，共用一个 program cache key，避免每种材质各自重编译
  mat.customProgramCacheKey = () => 'ironfront-daytoon';
}

const gradientCache = new Map<number, THREE.DataTexture>();

/** 生成 N 阶卡通渐变贴图 */
export function toonGradient(steps = 3): THREE.DataTexture {
  const cached = gradientCache.get(steps);
  if (cached) return cached;
  const data = new Uint8Array(steps * 4);
  for (let i = 0; i < steps; i += 1) {
    // 暗部不过暗，保留雨夜层次；亮部留一点余量给火光
    const v = Math.round((0.3 + (0.56 * (i + 0.5)) / steps) * 255);
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, steps, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  gradientCache.set(steps, tex);
  return tex;
}

export interface ToonOptions {
  emissive?: number;
  emissiveIntensity?: number;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
  /** 关闭材质共享缓存（需要对单个对象独立动画时使用） */
  unique?: boolean;
  /** 卡通色阶数量：2 硬边，3 标准，4 柔和 */
  steps?: 2 | 3 | 4;
  /** 是否参与雾效，默认 true */
  fog?: boolean;
  depthWrite?: boolean;
}

const toonCache = new Map<string, THREE.MeshToonMaterial>();

export function toonMaterial(color: number, options: ToonOptions = {}): THREE.MeshToonMaterial {
  const key = [
    color,
    options.emissive ?? 0,
    options.emissiveIntensity ?? 1,
    options.transparent ? 1 : 0,
    options.opacity ?? 1,
    options.side ?? THREE.FrontSide,
    options.steps ?? 3,
    options.fog === false ? 0 : 1,
    options.depthWrite === false ? 0 : 1,
  ].join('|');

  if (!options.unique) {
    const cached = toonCache.get(key);
    if (cached) return cached;
  }

  const mat = new THREE.MeshToonMaterial({
    color,
    gradientMap: toonGradient(options.steps ?? 3),
    transparent: options.transparent ?? false,
    opacity: options.opacity ?? 1,
    side: options.side ?? THREE.FrontSide,
    fog: options.fog !== false,
    depthWrite: options.depthWrite !== false,
  });
  if (options.emissive !== undefined) {
    mat.emissive = new THREE.Color(options.emissive);
    mat.emissiveIntensity = options.emissiveIntensity ?? 1;
  }
  injectDay(mat);
  if (!options.unique) toonCache.set(key, mat);
  return mat;
}

const basicCache = new Map<string, THREE.MeshBasicMaterial>();

export function basicMaterial(
  color: number,
  options: { opacity?: number; transparent?: boolean; side?: THREE.Side; fog?: boolean; unique?: boolean; blending?: THREE.Blending } = {},
): THREE.MeshBasicMaterial {
  const key = [color, options.opacity ?? 1, options.side ?? THREE.FrontSide, options.fog === false ? 0 : 1, options.blending ?? THREE.NormalBlending].join('|');
  if (!options.unique) {
    const cached = basicCache.get(key);
    if (cached) return cached;
  }
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: options.transparent ?? (options.opacity !== undefined && options.opacity < 1),
    opacity: options.opacity ?? 1,
    side: options.side ?? THREE.FrontSide,
    fog: options.fog !== false,
    blending: options.blending ?? THREE.NormalBlending,
    depthWrite: (options.opacity ?? 1) >= 1,
  });
  if (!options.unique) basicCache.set(key, mat);
  return mat;
}

/** 发光体（灯光、火光核心、灯箱）——不受光照影响 */
const nightGlows: THREE.MeshBasicMaterial[] = [];

/** 所有 glowMaterial 造出来的都是"人造光"：登记后由昼夜循环统一调亮度 */
export function glowMaterial(color: number, opacity = 1): THREE.MeshBasicMaterial {
  const mat = basicMaterial(color, { transparent: opacity < 1, opacity, fog: false, unique: true });
  if (!mat.userData['isNightGlow']) {
    mat.userData['isNightGlow'] = true;
    mat.userData['baseOpacity'] = mat.opacity;
    nightGlows.push(mat);
  }
  return mat;
}

export function listNightGlows(): THREE.MeshBasicMaterial[] {
  return nightGlows;
}

/** 手工构造的加色光条（湿反光、灯晕）也登记进来，才能跟着时段一起亮暗 */
export function registerNightGlow(mat: THREE.MeshBasicMaterial): THREE.MeshBasicMaterial {
  if (!mat.userData['isNightGlow']) {
    mat.userData['isNightGlow'] = true;
    mat.userData['baseOpacity'] = mat.opacity;
    nightGlows.push(mat);
  }
  return mat;
}

/** 窗玻璃：湿润反光的深色面片 */
export function glassMaterial(color = PALETTE.glassDark, opacity = 0.72): THREE.MeshToonMaterial {
  return toonMaterial(color, {
    transparent: true,
    opacity,
    emissive: PALETTE.coldLamp,
    emissiveIntensity: 0.06,
  });
}

/** 程序化 Canvas 贴图（招牌、海报、路面标线等） */
export function canvasTexture(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) draw(ctx, width, height);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

const OUTLINE_COLOR = PALETTE.outline;

const outlineMatCache = new Map<string, THREE.ShaderMaterial>();

/** 反向外扩描边材质：恒定屏幕宽度，跟随后期色调 */
export function outlineMaterial(thickness = 0.0052, color: number = OUTLINE_COLOR): THREE.ShaderMaterial {
  const key = `${thickness}|${color}`;
  const cached = outlineMatCache.get(key);
  if (cached) return cached;

  const mat = new THREE.ShaderMaterial({
    userData: { baseThickness: thickness },
    uniforms: {
      uThickness: { value: thickness },
      uColor: { value: new THREE.Color(color) },
      uAspect: { value: 1 },
    },
    vertexShader: /* glsl */ `
      uniform float uThickness;
      uniform float uAspect;
      void main() {
        vec4 objPos = vec4(position, 1.0);
        vec3 objNormal = normal;
        // 实例化网格（路灯）必须自己套 instanceMatrix，否则描边壳会全部堆在原点
        #ifdef USE_INSTANCING
          objPos = instanceMatrix * objPos;
          objNormal = mat3(instanceMatrix) * objNormal;
        #endif
        vec4 mvPosition = modelViewMatrix * objPos;
        vec3 n = normalize(normalMatrix * objNormal);
        vec2 dir = n.xy;
        float len = length(dir);
        dir = len > 1e-5 ? dir / len : vec2(0.0);
        vec4 clip = projectionMatrix * mvPosition;
        // 带一点粗细变化：水平向的面（檐口、车顶、屋脊）比垂直面更粗，接近手绘笔触
        float vary = 0.74 + 0.62 * abs(n.y);
        clip.xy += vec2(dir.x / uAspect, dir.y) * uThickness * clip.w * vary;
        gl_Position = clip;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      void main() {
        gl_FragColor = vec4(uColor, 1.0);
      }
    `,
    side: THREE.BackSide,
  });
  outlineMatCache.set(key, mat);
  return mat;
}

/** 所有描边材质共享，便于随窗口比例统一更新 */
export function updateOutlineAspect(aspect: number): void {
  outlineMatCache.forEach((mat) => {
    const uniform = mat.uniforms.uAspect;
    if (uniform) uniform.value = aspect;
  });
}

/** 昼夜驱动：把全部缓存的描边材质统一到当前时段的外描边色与粗细 */
export function applyDayOutline(color: THREE.Color, thicknessScale: number): void {
  outlineMatCache.forEach((mat) => {
    const base = (mat.userData['baseThickness'] as number) ?? 0.0044;
    mat.uniforms['uColor'].value.copy(color);
    mat.uniforms['uThickness'].value = base * thicknessScale;
  });
}

/**
 * 给网格（或整组网格）加描边外壳。
 * 只对"轮廓重要"的体块使用，避免小碎件描边噪点与额外 draw call。
 */
export function withOutline<T extends THREE.Object3D>(obj: T, thickness = 0.0052, color: number = OUTLINE_COLOR): T {
  const targets: THREE.Mesh[] = [];
  obj.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      const mat = mesh.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat) ? mat.some((m) => m.transparent) : mat.transparent) return;
      targets.push(mesh);
    }
  });
  targets.forEach((mesh) => {
    if (mesh.userData['hasOutline']) return;
    mesh.userData['hasOutline'] = true;
    const hull = new THREE.Mesh(mesh.geometry, outlineMaterial(thickness, color));
    hull.renderOrder = -1;
    hull.castShadow = false;
    hull.receiveShadow = false;
    hull.userData['isOutline'] = true;
    mesh.add(hull);
  });
  return obj;
}
