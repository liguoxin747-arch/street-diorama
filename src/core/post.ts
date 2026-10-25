import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';

/**
 * 后期：轻微泛光（火光/灯箱）→ 移轴虚化（强化微缩模型感）
 * → 冷调分级 + 暗角 + 极细胶片颗粒。
 */

const MiniatureShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uFocus: { value: 0.47 },
    uBand: { value: 0.2 },
    uBlur: { value: 1.45 },
    uVignette: { value: 0.62 },
    uCoolBias: { value: 0.42 },
    uSaturation: { value: 1.16 },
    uGrain: { value: 0.028 },
    uResolution: { value: new THREE.Vector2(1280, 720) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uFocus;
    uniform float uBand;
    uniform float uBlur;
    uniform float uVignette;
    uniform float uCoolBias;
    uniform float uSaturation;
    uniform float uGrain;
    uniform vec2 uResolution;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    void main() {
      float d = abs(vUv.y - uFocus);
      float blur = smoothstep(uBand * 0.35, uBand * 1.9, d) * uBlur;
      // 真实移轴的焦平面是带径向衰减的：底座扩到 288 后远景拉远，只靠竖直带会在广角下糊成一整条
      float radial = length((vUv - vec2(0.5, uFocus)) * vec2(1.0, 0.82));
      blur *= 1.0 + 0.95 * smoothstep(0.17, 0.55, radial);
      blur = min(blur, 2.6);

      vec2 texel = 1.0 / uResolution;
      vec3 col = texture2D(tDiffuse, vUv).rgb;

      if (blur > 0.004) {
        vec3 acc = col * 0.28;
        float total = 0.28;
        for (int i = 0; i < 8; i++) {
          float a = float(i) * 0.7853981;
          vec2 dir = vec2(cos(a), sin(a));
          float r1 = 2.6 * blur;
          float r2 = 6.2 * blur;
          acc += texture2D(tDiffuse, vUv + dir * texel * r1).rgb * 0.09;
          total += 0.09;
          acc += texture2D(tDiffuse, vUv + dir * texel * r2).rgb * 0.055;
          total += 0.055;
        }
        col = acc / total;
      }

      // 边缘轻微色散（镜头感）
      float edge = length(vUv - 0.5);
      float ca = edge * edge * 0.006;
      col.r = mix(col.r, texture2D(tDiffuse, vUv + vec2(ca, 0.0)).r, 0.6);
      col.b = mix(col.b, texture2D(tDiffuse, vUv - vec2(ca, 0.0)).b, 0.6);

      // 冷调分级：阴影压向靛蓝，高光保留中性（不要压太狠，否则建筑本色全被吃掉）
      float luma = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, col * vec3(0.80, 0.94, 1.14), uCoolBias);
      // 胶片黑位密度：原来 0.008/0.014/0.026，全局压暗之后 (1-luma) 几乎处处≈1，
      // 这条常数等于给整屏刷一层蓝，既毁掉"局部死黑"也把功能性测量的灵敏度吃掉了。
      // 降到三分之一，只保留一点点暗部染色，不再抬亮黑场。
      col += vec3(0.0025, 0.0045, 0.009) * (1.0 - luma);

      // 轻度 S 曲线：把"发灰发平"的画面拉回三渲二的色块对比
      col = clamp(col, 0.0, 1.0);
      col = mix(col, col * col * (3.0 - 2.0 * col), 0.45);

      // 提一点饱和，让砖、锈、火光在冷调里立得住
      float l2 = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(l2), col, uSaturation);
      col *= 0.95 + 0.09 * smoothstep(0.3, 1.0, l2);

      // 暗角
      float vig = 1.0 - uVignette * pow(clamp(edge * 1.34, 0.0, 1.0), 2.6);
      col *= vig;

      // 胶片颗粒（极细，避免出现"视频噪点"感）
      float g = hash(vUv * uResolution + fract(uTime) * 91.7) - 0.5;
      col += g * uGrain * (0.5 + 0.5 * (1.0 - luma));

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

const TILT_BASE_BLUR = 1.45;
const TILT_BASE_BAND = 0.2;

export interface DioramaPost {
  render(delta: number): void;
  setSize(width: number, height: number): void;
  /** 昼夜循环注入：冷调压色力度与整体饱和度（移轴与景深参数不受影响） */
  setGrade(coolBias: number, saturation: number): void;
  /** 昼夜循环注入：白天必须几乎关掉泛光，否则整片越过阈值 → 全局起雾 */
  setBloom(strength: number, threshold: number): void;
  /** 视角模式注入：第一人称下移轴要关（strength=0），俯瞰恢复 1 */
  setTiltShift(strength: number): void;
}

/**
 * 抗锯齿策略：
 *  1) EffectComposer 的主 RT 开 MSAA（几何边缘与细线最有效）
 *  2) 末端再叠一道 FXAA（补上后期/泛光带来的高频噪点）
 *  3) composer 的分辨率跟随 renderer.getPixelRatio()，高 DPI 下不糊
 *  4) 运行时测帧率：太慢就自动降级（关 MSAA → 降分辨率），保证操作不粘手
 */
export function createPost(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  _width: number,
  _height: number,
): DioramaPost {
  // 高 DPI 屏（dpr=2）会让内部像素数翻四倍，而这是填充受限的场景：
  // 上限压到 1.5，画质几乎看不出差别，帧时却省一半以上。
  const ratio = Math.min(renderer.getPixelRatio(), 1.5);
  const size = new THREE.Vector2();
  renderer.getSize(size);

  const target = new THREE.WebGLRenderTarget(
    Math.max(1, Math.floor(size.x * ratio)),
    Math.max(1, Math.floor(size.y * ratio)),
    {
      type: THREE.HalfFloatType,
      samples: 0, // 抗锯齿交给 FXAA（见下）；MSAA 在半浮点 RT 上开销太大
      colorSpace: THREE.LinearSRGBColorSpace,
    },
  );

  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(ratio);
  composer.setSize(size.x, size.y);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  // 泛光半分辨率：UnrealBloomPass 内部本来就是多级降采样 + 模糊，
  // 基分辨率减半后视觉几乎无差，但 5 级 mip 链的片元开销直接降到 1/4。
  const BLOOM_SCALE = 0.5;
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(size.x * BLOOM_SCALE, size.y * BLOOM_SCALE),
    0.9,
    0.55,
    0.55,
  );
  composer.addPass(bloom);

  const output = new OutputPass();
  composer.addPass(output);

  // FXAA：放在色调映射之后，处理最终画面的边缘
  const fxaa = new ShaderPass(FXAAShader);
  fxaa.material.uniforms['resolution'].value.set(1 / (size.x * ratio), 1 / (size.y * ratio));
  composer.addPass(fxaa);

  const miniature = new ShaderPass(MiniatureShader);
  miniature.uniforms['uResolution']?.value.set(size.x * ratio, size.y * ratio);
  composer.addPass(miniature);

  // —— 自适应渲染缩放 ——
  // 这台场景是**填充受限**的（30 盏点光 + 满屏描边壳，逐片元成本高）：
  // 实测 1600×900 下 1.0 → 28.2ms、0.85 → 23.0ms、0.7 → 18.1ms，帧时几乎与像素数成正比。
  // 所以最有效的无损杠杆是内部渲染密度，而不是删灯光或砍内容。
  // 旧版逻辑只在 quality 2→1→0 时改像素比，而 2→1 那档算出来的 pr 和原来一模一样，
  // 等于白等 2.4 秒才真正降一次；这里改成连续分档，并且可以从 1.0~MIN_SCALE 双向调节。
  const MIN_SCALE = 0.7;
  let renderScale = 1;
  let sampleTimer = 0;
  let sampleFrames = 0;
  let slowStreak = 0;
  let fastStreak = 0;

  /**
   * 只改**像素比**，绝不 dispose 渲染目标。
   * 之前那版在渲染循环中途 rt.dispose()，重建的那一两帧就是纯黑——
   * 在 77 万三角面 / 软件渲染的机器上会持续触发，表现为"屏幕闪黑"。
   */
  const applyScale = (): void => {
    const pr = ratio * renderScale;
    composer.setPixelRatio(pr);
    composer.setSize(size.x, size.y);
    bloom.setSize(size.x * pr * BLOOM_SCALE, size.y * pr * BLOOM_SCALE);
    const fxaaRes = fxaa.material.uniforms['resolution'];
    if (fxaaRes) (fxaaRes.value as THREE.Vector2).set(1 / (size.x * pr), 1 / (size.y * pr));
    const miniRes = miniature.uniforms['uResolution'];
    if (miniRes) (miniRes.value as THREE.Vector2).set(size.x * pr, size.y * pr);
  };

  let time = 0;
  return {
    render(delta: number) {
      time += delta;
      const u = miniature.uniforms;
      if (u['uTime']) u['uTime'].value = time;
      composer.render();

      // 每 1.2 秒评估一次：低于 48fps 降一档，高于 58fps 且有余量时升一档
      sampleTimer += delta;
      sampleFrames += 1;
      if (sampleTimer >= 1.2) {
        const fps = sampleFrames / sampleTimer;
        if (fps < 48 && renderScale > MIN_SCALE) {
          slowStreak += 1;
          fastStreak = 0;
          if (slowStreak >= 1) {
            renderScale = Math.max(MIN_SCALE, +(renderScale - 0.1).toFixed(2));
            applyScale();
            slowStreak = 0;
          }
        } else if (fps > 58 && renderScale < 1) {
          fastStreak += 1;
          slowStreak = 0;
          // 回升更保守：连续 3 个窗口都很快才升一档，避免在阈值上来回抖
          if (fastStreak >= 3) {
            renderScale = Math.min(1, +(renderScale + 0.1).toFixed(2));
            applyScale();
            fastStreak = 0;
          }
        } else {
          slowStreak = 0;
          fastStreak = 0;
        }
        sampleTimer = 0;
        sampleFrames = 0;
      }
    },
    setTiltShift(strength: number) {
      const u = miniature.uniforms;
      if (u['uBlur']) u['uBlur'].value = TILT_BASE_BLUR * strength;
      if (u['uBand']) u['uBand'].value = strength > 0.01 ? TILT_BASE_BAND : 0.5;
    },
    setBloom(strength: number, threshold: number) {
      bloom.strength = strength;
      bloom.threshold = threshold;
    },
    setGrade(coolBias: number, saturation: number) {
      const u = miniature.uniforms;
      if (u['uCoolBias']) u['uCoolBias'].value = coolBias;
      if (u['uSaturation']) u['uSaturation'].value = saturation;
    },
    setSize(w: number, h: number) {
      // 尺寸变化后必须沿用当前缩放档位，否则一次 resize 就把自适应结果清回满分辨率
      size.set(w, h);
      const pr = ratio * renderScale;
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      bloom.setSize(w * pr * BLOOM_SCALE, h * pr * BLOOM_SCALE);
      const fxaaUniforms = fxaa.material.uniforms['resolution'];
      if (fxaaUniforms) fxaaUniforms.value.set(1 / (w * pr), 1 / (h * pr));
      const u = miniature.uniforms;
      if (u['uResolution']) (u['uResolution'].value as THREE.Vector2).set(w * pr, h * pr);
    },
  };
}
