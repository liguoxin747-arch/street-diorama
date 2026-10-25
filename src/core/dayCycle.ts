import * as THREE from 'three';
import { DAY, sampleDay, snapshot, type DaySnapshot } from './dayState';
import { applyDayOutline, canvasTexture, listNightGlows } from './materials';

/**
 * 昼夜循环驱动器。
 *
 * 它不改"亮度"，改的是这套三渲二的**光影逻辑**：
 *  - 分带颜色（阳面色温 / 阴面环境色 / 硬边锐度）走 dayState 的共享 uniform
 *  - 外描边颜色与粗细随时段走（白天深灰褐，夜里深蓝黑，绝不会"白天一片纯黑"）
 *  - 人造光（窗光/路灯/火光/车灯，凡 glowMaterial 造的）统一到 uLightsOn 上
 *  - 湿沥青与积水的反射色/高光锐度跟随天色：白天映灰白云、黄昏吃夕阳、夜里拉长暖倒影
 *  - 雾的颜色与浓度连续变化（拂晓最浓，正午最薄）
 *  - 后期分级（冷调压色力度与饱和度）与渲染曝光联动，但移轴与景深**始终保留**
 *
 * 主平行光保持白色：`getGradientIrradiance` 的返回值之后还要乘灯光色，
 * 灯光一旦带色温，阴面会被一起染色（黄昏的阴影会变成橙色）。色温全部交给 uSunColor。
 */

export interface DayPost {
  setGrade(coolBias: number, saturation: number): void;
  setBloom(strength: number, threshold: number): void;
}

export interface DayRig {
  hemi: THREE.HemisphereLight;
  sun: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
  /** 一天进度 0..1：0=深夜 0.25=拂晓 0.5=正午 0.75=黄昏 */
  readonly time: number;
  setTime(t: number): void;
  /** 一天的时长（秒）；0 = 冻结在当前时刻 */
  dayLength: number;
  update(delta: number): void;
  bindPost(post: DayPost): void;
  bindRenderer(renderer: THREE.WebGLRenderer): void;
  bindCamera(camera: THREE.Camera): void;
  bindWet(assets: WetAssets): void;
  snapshot(): DaySnapshot;
  apply(): void;
}

export interface WetAssets {
  asphalt: THREE.MeshStandardMaterial;
  puddle: THREE.MeshStandardMaterial;
  dirt: THREE.MeshStandardMaterial;
}

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uGlow;
  uniform float uGlowStrength;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uMoonColor;
  uniform float uNight;
  uniform float uTime;
  uniform sampler2D uCloudMap;
  uniform float uCloudCover;
  uniform float uCloudAlpha;
  uniform float uStars;
  varying vec3 vDir;

  float hash21( vec2 p ) {
    p = fract( p * vec2( 123.34, 456.21 ) );
    p += dot( p, p + 45.32 );
    return fract( p.x * p.y );
  }

  // 月面环形山：只在圆盘内取样，二值化后当明暗斑
  float craters( vec2 q ) {
    float n = 0.0;
    n += smoothstep( 0.55, 0.95, hash21( floor( q * 9.0 ) ) );
    n += smoothstep( 0.72, 0.98, hash21( floor( q * 21.0 ) + 7.3 ) ) * 0.6;
    return clamp( n * 0.5, 0.0, 0.55 );
  }

  void main() {
    vec3 d = normalize( vDir );
    float h = d.y;

    // 天空底色：天顶到地平线
    float t = pow( smoothstep( -0.02, 0.62, h ), 0.86 );
    vec3 col = mix( uHorizon, uTop, t );

    // 地平线光晕：跟着太阳方位走，仰角越低铺得越开
    vec3 gp = normalize( vec3( uSunDir.x, max( uSunDir.y * 0.35, -0.02 ), uSunDir.z ) );
    float dd = distance( d, gp );
    col += uGlow * uGlowStrength * exp( -dd * dd * 6.5 ) * ( 1.0 - 0.55 * smoothstep( 0.0, 0.4, uSunDir.y ) );

    // 地平线 Fresnel：贴地一圈稍亮，模拟大气散射
    float fres = pow( 1.0 - clamp( h, 0.0, 1.0 ), 3.2 );
    col += uHorizon * fres * 0.28;

    // 星空：只在上半球、只在夜里，哈希点位 + 各自相位闪烁
    if ( uStars > 0.01 ) {
      vec2 sp = d.xz / max( 0.08, h + 0.25 ) * 26.0;
      vec2 cell = floor( sp );
      float r = hash21( cell );
      vec2 off = vec2( hash21( cell + 11.7 ), hash21( cell + 31.3 ) ) * 0.7 + 0.15;
      float star = smoothstep( 0.985, 1.0, r ) * smoothstep( 0.16, 0.0, length( fract( sp ) - off ) );
      float tw = 0.55 + 0.45 * sin( uTime * ( 1.2 + r * 3.0 ) + r * 40.0 );
      col += vec3( 0.85, 0.9, 1.0 ) * star * tw * uStars * smoothstep( 0.02, 0.22, h );
    }

    // 日 / 月：同一个方向（夜里它就是月光来的方向）
    float ang = acos( clamp( dot( d, normalize( uSunDir ) ), -1.0, 1.0 ) );
    float daySide = 1.0 - smoothstep( 0.35, 0.75, uNight );
    float nightSide = smoothstep( 0.35, 0.75, uNight );

    float sunR = 0.028;
    float core = smoothstep( sunR, sunR * 0.55, ang );
    float halo = exp( -ang * ang * 260.0 ) * 0.55 + exp( -ang * ang * 26.0 ) * 0.14;
    col += mix( vec3( 1.0, 0.95, 0.82 ), uSunColor, 0.35 ) * ( core * 1.6 + halo ) * daySide;

    float moonR = 0.022;
    float mdisk = smoothstep( moonR, moonR * 0.86, ang );
    vec2 mq = ( d.xy - uSunDir.xy ) * 40.0;
    float face = 1.0 - craters( mq ) * mdisk;
    col += uMoonColor * ( mdisk * face * 1.25 + exp( -ang * ang * 120.0 ) * 0.18 ) * nightSide;

    // 云层：两张不同尺度与速度的卷动贴图叠出体积感
    vec2 cuv = d.xz / max( 0.10, h + 0.16 );
    float c1 = texture2D( uCloudMap, cuv * 0.045 + vec2( uTime * 0.0035, uTime * 0.0012 ) ).r;
    float c2 = texture2D( uCloudMap, cuv * 0.105 + vec2( -uTime * 0.0062, uTime * 0.0021 ) ).r;
    float cloud = smoothstep( 1.0 - uCloudCover, 1.12 - uCloudCover, c1 * 0.62 + c2 * 0.48 );
    cloud *= mix( 0.55, 1.25, smoothstep( 0.5, 0.02, h ) );
    vec3 cloudLit = mix( col * 1.35 + uSunColor * 0.35, uGlow * 1.25, 0.35 );
    vec3 cloudShade = mix( col * 0.55, uTop * 0.8, 0.5 );
    vec3 cloudCol = mix( cloudShade, cloudLit, smoothstep( 0.15, 0.85, cloud ) );
    col = mix( col, cloudCol, cloud * uCloudAlpha * smoothstep( -0.02, 0.06, h ) );

    col *= mix( 0.42, 1.0, smoothstep( -0.34, 0.03, h ) );
    col += ( hash21( d.xy * 512.0 ) - 0.5 ) * 0.005;

    gl_FragColor = vec4( col, 1.0 );
  }
`;

/** 夜里的主光色乘到这里 = 原方案的整体亮度关系，保证既有画面不退让 */
const MOON_BASE = new THREE.Color(0xffffff);
const WHITE = new THREE.Color(0xffffff);
/**
 * 半球光（环境基底）的保底强度。
 * 相机绕场景旋转时，主光的照射方向不变 → 转到背光面时建筑只剩阴面，
 * 若环境光也很暗，画面会整片变黑（用户反馈的"旋转闪黑"）。
 * 这个下限保证任何方位角都有最低可见度。
 */
const HEMI_MIN = 1.35;

export function createDayRig(scene: THREE.Scene, quality = 1): DayRig {
  scene.background = null;

  // —— 天空穹顶（取代原来的一张贴图背景，才能连续变色）——
  const skyUniforms = {
    uTop: { value: new THREE.Color(0x0b1118) },
    uHorizon: { value: new THREE.Color(0x1a2531) },
    uGlow: { value: new THREE.Color(0x2b4258) },
    uGlowStrength: { value: 0.25 },
    uSunDir: DAY.uSunDir,
    uSunColor: DAY.uSunColor,
    uMoonColor: { value: new THREE.Color(0xbfd0e0) },
    uNight: DAY.uNightMix,
    uTime: { value: 0 },
    uCloudMap: { value: cloudNoiseTexture() },
    uCloudCover: { value: 0.62 },
    uCloudAlpha: { value: 0.85 },
    uStars: DAY.uNightMix,
  };
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(500, 48, 28),
    new THREE.ShaderMaterial({
      uniforms: skyUniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    }),
  );
  dome.name = 'sky-dome';
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  scene.add(dome);

  // —— 灯光：全部由时段驱动 ——
  const hemi = new THREE.HemisphereLight(0x47596c, 0x171e26, 2.55);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(MOON_BASE, 2.35);
  sun.position.set(-58, 46, 40);
  sun.castShadow = true;
  sun.shadow.mapSize.set(quality > 0.8 ? 2048 : 1024, quality > 0.8 ? 2048 : 1024);
  sun.shadow.camera.left = -104;

  /**
   * 跟随相机的补光：主光固定在某个方向，相机绕场景转时总会转到"背光面"，
   * 那时建筑只剩阴面 → 整片黑。这盏补光始终从相机的侧后方打过去，
   * 保证任何方位角都有一层侧光勾出轮廓（强度很低，不破坏夜景）。
   */
  const rim = new THREE.DirectionalLight(0x9fb6cc, 0.55);
  rim.castShadow = false;
  scene.add(rim);
  scene.add(rim.target);
  sun.shadow.camera.right = 104;
  sun.shadow.camera.top = 104;
  sun.shadow.camera.bottom = -104;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 300;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.045;
  sun.shadow.radius = 2.4;
  scene.add(sun);
  scene.add(sun.target);
  sun.target.position.set(4, 0, -4);

  const fill = new THREE.DirectionalLight(0x4e6d8c, 0.8);
  fill.position.set(52, 20, -46);
  scene.add(fill);

  scene.fog = new THREE.FogExp2(0x0e1721, 0.0021);

  let time = 0; // 从深夜开始：既有验收数字全部成立
  let shadowTimer = 0;
  let shadowsConfigured = false;
  let post: DayPost | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  let camera: THREE.Camera | null = null;
  /** 复用的临时向量：每帧算补光方向，避免每帧 new Vector3 */
  const tmpDir = new THREE.Vector3();
  let wet: WetAssets | null = null;
  let lamps: THREE.Light[] | null = null;
  const snap: DaySnapshot = snapshot();
  const tmpColor = new THREE.Color();
  const wetBase = {
    asphalt: new THREE.Color(),
    dirt: new THREE.Color(),
  };
  let wetBaseSaved = false;

  function apply(): void {
    Object.assign(snap, sampleDay(time));

    // 天空
    skyUniforms['uTop'].value.copy(snap.skyTop);
    skyUniforms['uHorizon'].value.copy(skyHorizonMix);
    skyUniforms['uGlow'].value.copy(snap.skyGlow);
    skyUniforms['uGlowStrength'].value = snap.skyGlowStrength;
    // 阴雨天云量本来就高：拂晓最厚、正午稍薄、夜里更暗
    skyUniforms['uCloudCover'].value = 0.58 + 0.22 * (1 - snap.nightMix) + (snap.fogDensity > 0.003 ? 0.08 : 0);
    skyUniforms['uCloudAlpha'].value = 0.82 + 0.1 * snap.nightMix;
    skyUniforms['uMoonColor'].value.copy(snap.hemiSky).lerp(WHITE, 0.55);

    // 灯光：色温交给 uSunColor，平行光本身保持白色（见文件头注释）
    hemi.color.copy(snap.hemiSky);
    hemi.groundColor.copy(snap.hemiGround);
    // 保底环境光：主光方向固定、相机绕圈时，转到"背光面"会整片黑（只有阴面 + 极暗环境色）。
    // 给半球光一个下限，任何方位角都保留最低可见度，夜景氛围不受影响。
    hemi.intensity = Math.max(snap.hemiIntensity, HEMI_MIN);
    sun.intensity = snap.sunIntensity;
    sun.position.copy(DAY.uSunDir.value).multiplyScalar(96).add(sun.target.position);
    fill.intensity = 0.35 + 0.55 * snap.nightMix;
    // 月光同样投影：夜里建筑与车辆要压出死黑的背光面，局部灯才对比得出来
    sun.castShadow = true;

    // 雾
    const fog = scene.fog as THREE.FogExp2;
    fog.color.copy(snap.fogColor);
    fog.density = snap.fogDensity;

    // 描边：白天深灰褐、夜里深蓝黑；正午略粗以强化几何切割
    applyDayOutline(snap.outlineColor, 0.86 + 0.34 * (1 - snap.nightMix));

    // 人造光：白天压到 8% 的待机亮度，黄昏渐起，深夜满值
    const on = 0.08 + 0.92 * snap.lightsOn;
    for (const mat of listNightGlows()) {
      const base = (mat.userData['baseOpacity'] as number) ?? 1;
      mat.opacity = base * on;
    }

    // 湿地与积水
    if (wet) {
      if (!wetBaseSaved) {
        wetBase.asphalt.copy(wet.asphalt.color);
        wetBase.dirt.copy(wet.dirt.color);
        wetBaseSaved = true;
      }
      // 干湿只走 roughness（metalness 恒为 0）：夜里整体更"吃光"，白天回到哑光水泥。
      // 路面绝不往"太阳色"插值再乘 >1——那正是白天白茫茫过曝的成因。
      const dayMix = 1 - snap.nightMix;
      tmpColor.copy(snap.fogColor);
      wet.asphalt.color.copy(wetBase.asphalt).lerp(tmpColor, dayMix * 0.26);
      // 与真实 roughnessMap（均值 0.77）相乘：夜里 0.55（等效≈0.42，灯能拉出反光），
      // 白天 0.95（等效≈0.73，接近哑光）
      wet.asphalt.roughness = 0.55 + 0.4 * dayMix;
      wet.dirt.color.copy(wetBase.dirt).lerp(tmpColor, dayMix * 0.14);
      wet.dirt.roughness = 0.9 + 0.08 * dayMix;
      // 积水：夜里 roughness 0.14，只把灯与火拉成一条锐利倒影
      wet.puddle.color.copy(snap.puddleColor);
      wet.puddle.roughness = snap.puddleRoughness;
    }

    if (post) {
      post.setGrade(snap.coolBias, snap.saturation);
      post.setBloom(snap.bloomStrength, snap.bloomThreshold);
    }
    // 局部光源（路灯/火光/车灯/探照灯）：深夜明显加力，白天压到待机
    if (lamps) {
      // 全局压暗后，局部灯必须接管画面：深夜约 2.4 倍，白天压到 0.5 倍待机
      const gain = 0.5 + 1.9 * snap.lightsOn;
      for (const lamp of lamps) {
        const base = (lamp.userData['baseIntensity'] as number) ?? lamp.intensity;
        // 故障路灯在 ticker 里写 flickerGain；昼夜装置只负责整体增益，不能把它抹平
        const flicker = (lamp.userData['flickerGain'] as number) ?? 1;
        lamp.intensity = base * gain * flicker;
      }
    }
    if (renderer) renderer.toneMappingExposure = snap.exposure;
  }

  const skyHorizonMix = new THREE.Color();

  const rig: DayRig = {
    hemi,
    sun,
    fill,
    dayLength: 300,
    get time() {
      return time;
    },
    setTime(t: number) {
      time = ((t % 1) + 1) % 1;
      apply();
    },
    update(delta: number) {
      if (!lamps) {
        // 场景已构建完毕（main 在帧循环前建好），这里只收集一次
        lamps = [];
        scene.traverse((o) => {
          const light = o as THREE.Light;
          if (!light.isLight || (o.type !== 'PointLight' && o.type !== 'SpotLight')) return;
          if (light.userData['baseIntensity'] === undefined) light.userData['baseIntensity'] = light.intensity;
          lamps!.push(light);
        });
      }
      if (!shadowsConfigured) {
        // 阴影贴图改为"按灯按需重烘"：全局 autoUpdate 仍关闭，但每盏投影灯
        // 自己记录 needsUpdate。路灯灯池换位时只需要重烘那几盏 SpotLight，
        // 不必把 2048 的太阳阴影图连同整座城再画一遍。
        shadowsConfigured = true;
        scene.traverse((o) => {
          const light = o as THREE.Light & { shadow?: THREE.LightShadow };
          if (!light.isLight || !light.castShadow || !light.shadow) return;
          light.shadow.autoUpdate = false;
          light.shadow.needsUpdate = true;
        });
      }
      if (rig.dayLength > 0) {
        time = (time + delta / rig.dayLength) % 1;
        apply();
        // 太阳在动，而 renderer.shadowMap.autoUpdate 是关的（静态烘一次省一大截帧时）。
        // 所以这里按节拍重新烘一次阴影贴图，把"影子随时间转"补回来；
        // 间隔取 2 秒——影子转向本身很慢，肉眼看不出步进。
        shadowTimer += delta;
        if (shadowTimer >= 2) {
          shadowTimer = 0;
          if (renderer) {
            // 太阳在动：每 2 s 把所有投影灯标脏（含路灯），再整体烘一次
            scene.traverse((o) => {
              const light = o as THREE.Light & { shadow?: THREE.LightShadow };
              if (light.isLight && light.castShadow && light.shadow) light.shadow.needsUpdate = true;
            });
            renderer.shadowMap.needsUpdate = true;
          }
        }
      }
      // 穹顶跟着相机走，永远把边缘包住（配合远景剪影与体雾遮生成边界）
      skyUniforms['uTime'].value += delta;
      if (camera) {
        dome.position.copy(camera.position);
        // 补光始终架在相机的左后上方，朝相机看的方向打 ——
        // 于是任何方位角都有一层侧光把建筑轮廓勾出来，不会转到背光面就全黑。
        const dir = camera.getWorldDirection(tmpDir);
        const az2 = Math.atan2(dir.x, dir.z);
        rim.position.set(
          camera.position.x - Math.sin(az2) * 60 + Math.cos(az2) * 40,
          camera.position.y + 52,
          camera.position.z - Math.cos(az2) * 60 - Math.sin(az2) * 40,
        );
        rim.target.position.set(camera.position.x + dir.x * 30, camera.position.y - 6, camera.position.z + dir.z * 30);
        rim.target.updateMatrixWorld();
      }
    },
    bindPost(p: DayPost) {
      post = p;
      apply();
    },
    bindRenderer(r: THREE.WebGLRenderer) {
      renderer = r;
      apply();
    },
    bindCamera(c: THREE.Camera) {
      camera = c;
    },
    bindWet(a: WetAssets) {
      wet = a;
      wetBaseSaved = false;
    },
    snapshot() {
      return snap;
    },
    apply,
  };

  // 天空的地平线色要稍微"抬高"一点亮度：直接贴 horizon 会让天与地糊在一起
  const prevApply = apply;
  rig.apply = () => {
    skyHorizonMix.copy(snap.skyHorizon).multiplyScalar(1.06);
    prevApply();
  };
  rig.apply();
  return rig;
}

/** 可平铺的云噪声：周期性格点值噪声叠加，一次生成、之后在穹顶上做两次卷动采样 */
function cloudNoiseTexture(): THREE.Texture {
  const N = 256;
  const tex = canvasTexture(N, N, (c, w, h) => {
    const img = c.createImageData(w, h);
    const octaves = [
      { freq: 4, amp: 0.55 },
      { freq: 8, amp: 0.28 },
      { freq: 16, amp: 0.12 },
      { freq: 32, amp: 0.05 },
    ];
    const lattice = (freq: number, seed: number): number => {
      const gx = ((seed * 73) % freq + freq) % freq;
      const gy = ((seed * 151) % freq + freq) % freq;
      return hash2(gx, gy);
    };
    const smooth = (t: number): number => t * t * (3 - 2 * t);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let v = 0;
        for (const { freq, amp } of octaves) {
          const fx = (x / w) * freq;
          const fy = (y / h) * freq;
          const x0 = Math.floor(fx);
          const y0 = Math.floor(fy);
          const tx = smooth(fx - x0);
          const ty = smooth(fy - y0);
          const n00 = lattice(freq, x0 + y0 * freq);
          const n10 = lattice(freq, x0 + 1 + y0 * freq);
          const n01 = lattice(freq, x0 + (y0 + 1) * freq);
          const n11 = lattice(freq, x0 + 1 + (y0 + 1) * freq);
          v += amp * (n00 * (1 - tx) * (1 - ty) + n10 * tx * (1 - ty) + n01 * (1 - tx) * ty + n11 * tx * ty);
        }
        const g = Math.round(Math.min(1, Math.max(0, v)) * 255);
        const i = (y * w + x) * 4;
        img.data[i] = g;
        img.data[i + 1] = g;
        img.data[i + 2] = g;
        img.data[i + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
  });
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

/** 无状态的确定性哈希（云噪声用，不参与场景随机源） */
function hash2(x: number, y: number): number {
  const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return v - Math.floor(v);
}

/** 程序化的极淡云带（贴在天穹上，不参与光照）——保留接口位，当前由 canvasTexture 生成 */
export function cloudTexture(): THREE.Texture {
  return canvasTexture(256, 256, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    for (let i = 0; i < 40; i += 1) {
      const x = ((i * 137) % w);
      const y = ((i * 61) % (h * 0.5));
      const r = 26 + ((i * 53) % 70);
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.06)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });
}
