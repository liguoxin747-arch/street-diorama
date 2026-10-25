import * as THREE from 'three';

/**
 * 昼夜循环的**唯一真相源**：一组被所有着色器共享的 uniform 引用。
 *
 * 为什么单独一个文件：materials.ts（三渲二分带 + 描边）、post.ts（分级）、
 * dayCycle.ts（灯光/雾/天空/积水）都要读写同一份时间状态。放任何一边都会造成
 * 循环依赖，所以这里只放数据与采样函数，不 import 任何场景对象。
 *
 * 注意：MeshToonMaterial 的分带颜色不能靠"改灯光颜色"实现——那会让阳面与阴面
 * 一起变色，失去三渲二的色块关系。dayState 把阴面/阳面色分开传给着色器。
 */

export interface DayUniforms {
  /** 归一化的太阳（主平行光）方向 */
  uSunDir: { value: THREE.Vector3 };
  /** 阳面色温 */
  uSunColor: { value: THREE.Color };
  /** 阴面色（不是纯黑：三渲二的暗部要保留层次与环境色） */
  uShadowTint: { value: THREE.Color };
  /** 硬边强度：0 = 柔和三阶，1 = 正午那种几何切割的锐利分带 */
  uHarden: { value: number };
  /** 边缘光（黄昏低角度那一道）强度 */
  uRimStrength: { value: number };
  uRimColor: { value: THREE.Color };
  /** 0 = 全黑无光，1 = 深夜 */
  uNightMix: { value: number };
  /** 人造光源开启程度（窗光/路灯/火光/车灯统一跟随） */
  uLightsOn: { value: number };
}

export const DAY: DayUniforms = {
  uSunDir: { value: new THREE.Vector3(-0.55, 0.42, 0.4).normalize() },
  uSunColor: { value: new THREE.Color(0xbcd2e6) },
  uShadowTint: { value: new THREE.Color(0x101922) },
  uHarden: { value: 0.15 },
  uRimStrength: { value: 0.1 },
  uRimColor: { value: new THREE.Color(0x2f4b66) },
  uNightMix: { value: 1 },
  uLightsOn: { value: 1 },
};

export type Phase = 'night' | 'dawn' | 'noon' | 'dusk';

/** 四个时段的锚点。t 以 0=深夜、0.25=拂晓、0.5=正午、0.75=黄昏 循环。 */
interface Anchor {
  phase: Phase;
  /** 太阳方位角（绕 Y，0=朝 +Z）与仰角（度） */
  azimuth: number;
  elevation: number;
  sunColor: number;
  sunIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  shadowTint: number;
  harden: number;
  rimColor: number;
  rimStrength: number;
  fogColor: number;
  fogDensity: number;
  skyTop: number;
  skyHorizon: number;
  skyGlow: number;
  skyGlowStrength: number;
  lightsOn: number;
  nightMix: number;
  outlineColor: number;
  outlineThickness: number;
  /** 积水：反射的底色 / 高光色 / 锐度（白天弱、黄昏强夕阳高光、夜里拉出长暖倒影） */
  puddleColor: number;
  /** 积水粗糙度（PBR）：夜里 0.05 才拉得出灯与火的长条倒影，白天 0.26~0.3 只映云天 */
  puddleRoughness: number;
  /** 后期：把阴影压向靛蓝的力度与整体饱和度 */
  coolBias: number;
  saturation: number;
  exposure: number;
  /** 泛光强度与阈值：白天必须几乎关掉，否则整片越过阈值→全局起雾 */
  bloomStrength: number;
  bloomThreshold: number;
}

const ANCHORS: Anchor[] = [
  {
    // 深夜：全局只留"轮廓级"冷光，亮度全部交给局部光源
    // 环境/月光压到 0.4~0.5 档，曝光 0.72，泛光阈值 0.85 —— 只有灯、火、窗会过阈值起辉光，
    // 远处靠更深的雾色与更高的密度直接沉进黑里。
    phase: 'night', azimuth: 2.4, elevation: 38,
    sunColor: 0x9db6cf, sunIntensity: 0.82,
    hemiSky: 0x22303f, hemiGround: 0x0b1017, hemiIntensity: 0.8,
    shadowTint: 0x02040a, harden: 0.15,
    rimColor: 0x3d5f80, rimStrength: 0.34,
    fogColor: 0x04060b, fogDensity: 0.0028,
    skyTop: 0x04070d, skyHorizon: 0x0b1119, skyGlow: 0x16222f, skyGlowStrength: 0.16,
    lightsOn: 1, nightMix: 1,
    outlineColor: 0x03050a, outlineThickness: 0.0044,
    puddleColor: 0x0a1017, puddleRoughness: 0.14,
    coolBias: 0.62, saturation: 1.18, exposure: 0.96,
    bloomStrength: 0.8, bloomThreshold: 0.85,
  },
  {
    // 拂晓：阴冷灰蓝，地平线泛苍白微光，雾最浓，宁静凄冷
    phase: 'dawn', azimuth: 1.35, elevation: 5,
    sunColor: 0x9fb2c4, sunIntensity: 1.15,
    hemiSky: 0x5d7183, hemiGround: 0x232a32, hemiIntensity: 1.7,
    shadowTint: 0x080d14, harden: 0.42,
    rimColor: 0xbfd2de, rimStrength: 0.24,
    fogColor: 0x35414e, fogDensity: 0.004,
    skyTop: 0x222d38, skyHorizon: 0x6f808c, skyGlow: 0xc3d0d8, skyGlowStrength: 0.5,
    lightsOn: 0.42, nightMix: 0.45,
    outlineColor: 0x212a30, outlineThickness: 0.0034,
    puddleColor: 0x223039, puddleRoughness: 0.3,
    coolBias: 0.36, saturation: 1.0, exposure: 1.14,
    bloomStrength: 0.5, bloomThreshold: 0.8,
  },
  {
    // 正午（阴雨天）：厚云漫射的苍白冷光，无暖色，固有色凸显，硬阴影锐利有切割感
    phase: 'noon', azimuth: 0.1, elevation: 62,
    sunColor: 0xdfe6ec, sunIntensity: 2.15,
    hemiSky: 0x93a0ab, hemiGround: 0x3d4246, hemiIntensity: 2.5,
    shadowTint: 0x0a0c0f, harden: 1.0,
    rimColor: 0xe8eef2, rimStrength: 0.12,
    fogColor: 0x79868f, fogDensity: 0.0012,
    skyTop: 0x74838e, skyHorizon: 0xa8b3b8, skyGlow: 0xc9d2d6, skyGlowStrength: 0.22,
    lightsOn: 0.05, nightMix: 0,
    outlineColor: 0x25241f, outlineThickness: 0.0062,
    puddleColor: 0x3d4850, puddleRoughness: 0.26,
    coolBias: 0.14, saturation: 1.1, exposure: 1.05,
    bloomStrength: 0.2, bloomThreshold: 0.92,
  },
  {
    // 黄昏：极低角度 + 强边缘光，低饱和暗紫与暗橙，废墟被拉出极长的黑色剪影，灯开始亮
    phase: 'dusk', azimuth: 4.35, elevation: 6,
    sunColor: 0xc78a5e, sunIntensity: 1.55,
    hemiSky: 0x4a3f55, hemiGround: 0x221e28, hemiIntensity: 1.5,
    shadowTint: 0x0b0813, harden: 0.6,
    rimColor: 0xffb271, rimStrength: 0.8,
    fogColor: 0x3a2f3f, fogDensity: 0.0024,
    skyTop: 0x2e2436, skyHorizon: 0x8a5a45, skyGlow: 0xff9a52, skyGlowStrength: 0.85,
    lightsOn: 0.55, nightMix: 0.55,
    outlineColor: 0x0d0b12, outlineThickness: 0.0055,
    puddleColor: 0x241c26, puddleRoughness: 0.1,
    coolBias: 0.26, saturation: 1.16, exposure: 1.34,
    bloomStrength: 0.8, bloomThreshold: 0.58,
  },
];

/** 锚点间插值用的可写字段（颜色用 Color 避免 hue 空间跳变） */
export interface DaySnapshot extends Omit<Anchor,
  | 'phase' | 'sunColor' | 'hemiSky' | 'hemiGround' | 'rimColor' | 'fogColor' | 'skyTop'
  | 'skyHorizon' | 'skyGlow' | 'outlineColor' | 'puddleColor' | 'shadowTint'
  | 'azimuth' | 'elevation'
> {
  phase: Phase;
  nextPhase: Phase;
  sunColor: THREE.Color;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  rimColor: THREE.Color;
  fogColor: THREE.Color;
  skyTop: THREE.Color;
  skyHorizon: THREE.Color;
  skyGlow: THREE.Color;
  outlineColor: THREE.Color;
  puddleColor: THREE.Color;
}

const scratchA = new THREE.Color();
const scratchB = new THREE.Color();

function lerpAngle(a: number, b: number, k: number): number {
  // 方位角走最短弧，否则黄昏到深夜会"倒着转回去"
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

export function snapshot(): DaySnapshot {
  const a = ANCHORS[0];
  return {
    phase: a.phase,
    nextPhase: a.phase,
    sunIntensity: a.sunIntensity,
    hemiIntensity: a.hemiIntensity,
    harden: a.harden,
    rimStrength: a.rimStrength,
    fogDensity: a.fogDensity,
    skyGlowStrength: a.skyGlowStrength,
    lightsOn: a.lightsOn,
    nightMix: a.nightMix,
    outlineThickness: a.outlineThickness,
    puddleRoughness: a.puddleRoughness,
    coolBias: a.coolBias,
    saturation: a.saturation,
    exposure: a.exposure,
    bloomStrength: a.bloomStrength,
    bloomThreshold: a.bloomThreshold,
    sunColor: new THREE.Color(a.sunColor),
    hemiSky: new THREE.Color(a.hemiSky),
    hemiGround: new THREE.Color(a.hemiGround),
    rimColor: new THREE.Color(a.rimColor),
    fogColor: new THREE.Color(a.fogColor),
    skyTop: new THREE.Color(a.skyTop),
    skyHorizon: new THREE.Color(a.skyHorizon),
    skyGlow: new THREE.Color(a.skyGlow),
    outlineColor: new THREE.Color(a.outlineColor),
    puddleColor: new THREE.Color(a.puddleColor),
  };
}

const OUT = snapshot();

/**
 * 采样 t∈[0,1) 时刻的昼夜状态，写回 OUT 并同步 DAY 的共享 uniform。
 * 0=深夜 · 0.25=拂晓 · 0.5=正午 · 0.75=黄昏
 */
export function sampleDay(t: number): DaySnapshot {
  const tt = ((t % 1) + 1) % 1;
  const seg = tt * 4;
  const i = Math.floor(seg) % 4;
  const j = (i + 1) % 4;
  // smoothstep：时段交界处不出现线性"穿过"的机械感
  const raw = seg - Math.floor(seg);
  const k = raw * raw * (3 - 2 * raw);
  const a = ANCHORS[i]!;
  const b = ANCHORS[j]!;

  OUT.phase = a.phase;
  OUT.nextPhase = b.phase;
  const azimuth = lerpAngle(a.azimuth, b.azimuth, k);
  const elevation = a.elevation + (b.elevation - a.elevation) * k;
  OUT.sunIntensity = a.sunIntensity + (b.sunIntensity - a.sunIntensity) * k;
  OUT.hemiIntensity = a.hemiIntensity + (b.hemiIntensity - a.hemiIntensity) * k;
  OUT.harden = a.harden + (b.harden - a.harden) * k;
  OUT.rimStrength = a.rimStrength + (b.rimStrength - a.rimStrength) * k;
  OUT.fogDensity = a.fogDensity + (b.fogDensity - a.fogDensity) * k;
  OUT.skyGlowStrength = a.skyGlowStrength + (b.skyGlowStrength - a.skyGlowStrength) * k;
  OUT.lightsOn = a.lightsOn + (b.lightsOn - a.lightsOn) * k;
  OUT.nightMix = a.nightMix + (b.nightMix - a.nightMix) * k;
  OUT.outlineThickness = a.outlineThickness + (b.outlineThickness - a.outlineThickness) * k;
  OUT.puddleRoughness = a.puddleRoughness + (b.puddleRoughness - a.puddleRoughness) * k;
  OUT.coolBias = a.coolBias + (b.coolBias - a.coolBias) * k;
  OUT.saturation = a.saturation + (b.saturation - a.saturation) * k;
  OUT.exposure = a.exposure + (b.exposure - a.exposure) * k;
  OUT.bloomStrength = a.bloomStrength + (b.bloomStrength - a.bloomStrength) * k;
  OUT.bloomThreshold = a.bloomThreshold + (b.bloomThreshold - a.bloomThreshold) * k;

  OUT.sunColor.setHex(a.sunColor).lerp(scratchB.setHex(b.sunColor), k);
  OUT.hemiSky.setHex(a.hemiSky).lerp(scratchB.setHex(b.hemiSky), k);
  OUT.hemiGround.setHex(a.hemiGround).lerp(scratchB.setHex(b.hemiGround), k);
  OUT.rimColor.setHex(a.rimColor).lerp(scratchB.setHex(b.rimColor), k);
  OUT.fogColor.setHex(a.fogColor).lerp(scratchB.setHex(b.fogColor), k);
  OUT.skyTop.setHex(a.skyTop).lerp(scratchB.setHex(b.skyTop), k);
  OUT.skyHorizon.setHex(a.skyHorizon).lerp(scratchB.setHex(b.skyHorizon), k);
  OUT.skyGlow.setHex(a.skyGlow).lerp(scratchB.setHex(b.skyGlow), k);
  OUT.outlineColor.setHex(a.outlineColor).lerp(scratchB.setHex(b.outlineColor), k);
  OUT.puddleColor.setHex(a.puddleColor).lerp(scratchB.setHex(b.puddleColor), k);
  scratchA.setHex(a.shadowTint);

  // 共享 uniform：着色器直接引用这些引用对象，无需每帧重建材质
  DAY.uSunColor.value.copy(OUT.sunColor);
  DAY.uShadowTint.value.copy(scratchA.lerp(scratchB.setHex(b.shadowTint), k));
  DAY.uHarden.value = OUT.harden;
  DAY.uRimColor.value.copy(OUT.rimColor);
  DAY.uRimStrength.value = OUT.rimStrength;
  DAY.uNightMix.value = OUT.nightMix;
  DAY.uLightsOn.value = OUT.lightsOn;
  DAY.uSunDir.value.setFromSphericalCoords(
    1,
    Math.PI / 2 - THREE.MathUtils.degToRad(elevation),
    azimuth,
  ).normalize();

  return OUT;
}
