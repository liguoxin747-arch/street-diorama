/**
 * 三渲二战争废墟雨夜调色板。
 * 色彩克制：整体冷灰蓝 + 局部暖橙火光，避免高饱和导致"塑料感"。
 */

export const PALETTE = {
  // —— 环境 ——
  skyTop: 0x0b1118,
  skyHorizon: 0x1a2531,
  fog: 0x101922,
  ambient: 0x2b3b4c,
  moon: 0xbcd2e6,
  coolFill: 0x4e6d8c,

  // —— 地面 ——
  asphalt: 0x33383f,
  asphaltWet: 0x3f4852,
  asphaltLight: 0x454a52,
  sidewalk: 0x51565c,
  sidewalkAlt: 0x484d53,
  curb: 0x5c6167,
  curbPaint: 0x9a978d,
  puddle: 0x232f3a,
  paint: 0x8f8a7d,
  dirt: 0x453e33,
  mud: 0x38332c,

  // —— 建筑 ——
  plaster: 0x8b887f,
  plasterWarm: 0x9c8a6f,
  plasterCold: 0x87919c,
  plasterPeel: 0x968f81,
  brick: 0x8c6151,
  brickDark: 0x60412f,
  concrete: 0x767a81,
  concreteDark: 0x4c5057,
  concreteStain: 0x5b5e63,
  roof: 0x34383d,
  roofRust: 0x6f4d37,
  woodOld: 0x6a5942,
  woodDark: 0x43372b,
  metalDoor: 0x5c666f,
  rust: 0x6e4a38,
  rustDark: 0x4e3628,
  burnt: 0x231f1d,
  soot: 0x322e2a,

  // —— 玻璃 / 灯光 ——
  glassDark: 0x25323c,
  glassBroken: 0x3b4c58,
  warmLight: 0xffb765,
  warmLightDeep: 0xff8a3d,
  fire: 0xff7a2f,
  fireCore: 0xffd28a,
  ember: 0xff5722,
  emergencyRed: 0xff4b3e,
  coldLamp: 0xa9d6ff,
  neonSign: 0xff6f52,
  signGreen: 0x3f7a63,
  signBlue: 0x2f5e86,
  signalRed: 0xd93a34,
  signalAmber: 0xe8a13a,
  signalGreen: 0x35b06a,

  // —— 道具 / 材质 ——
  sandbag: 0x9a8a67,
  sandbagDark: 0x6f6349,
  tire: 0x1f1f22,
  timber: 0x6a4f36,
  tarp: 0x4d5a4b,
  tarpBlue: 0x3d5566,
  paper: 0xcfc7b6,
  fabricRed: 0x8e3b38,
  barrel: 0x55606a,
  barrelRust: 0x6d4a36,

  // —— 军用 ——
  olive: 0x5c6552,
  oliveLight: 0x6e7861,
  oliveDark: 0x474f3f,
  armor: 0x646b56,
  trackMetal: 0x3f4348,
  burntVehicle: 0x2f2a26,
  burntVehicleLight: 0x443c34,

  // —— 人物 ——
  coatGrey: 0x4a4f57,
  coatBrown: 0x5c4a3c,
  coatOlive: 0x4d5343,
  skin: 0xa88163,
  skinShade: 0x8a674e,
  hairGrey: 0x5e5a52,
  scarfRed: 0x8a3a34,

  // —— 描边 ——
  outline: 0x05080c,
  outlineSoft: 0x0a1017,
} as const;

/** 带 alpha 的霓虹/发光色 */
export const GLOW = {
  shop: 0xffb765,
  lamp: 0xffc98a,
  fire: 0xff8a3c,
  emergency: 0xff5a44,
  cold: 0x9fd0ff,
  drone: 0xff4a3a,
} as const;
