/**
 * 微缩景观总平面（单位＝米）。
 *
 * 底座 288×288，由内到外分层：
 *
 *   ┌── 边缘遮掩带（|x| 或 |z| > 139）——远景剪影、体雾、渐暗夜色
 *   ├── 外圈地块带（110..124 / 126..138）——密集平民区（西与北）、废弃工业区（东）、前沿哨卡（南）
 *   ├── 环道（±100，车行道 94..106，人行道至 ±109）
 *   ├── 内圈地块带（74..90）——旧边界外的第一批新街区
 *   └── 核心区（|x|,|z| ≤ 72）——原地图：十字路口 + 三层主楼 + 小镇地块，扩建不改动其内的一切
 *
 * 坐标约定：X 向东（画面右），Z 向南（画面下），Y 向上。
 *
 *   z-
 *    ┌───────────────┬───────────┐
 *    │  NW 街区       │ NE: 主楼   │
 *  x-├─────── 大道（东-西向）──────┤x+
 *    │  SW 街区       │ SE 街区    │
 *    └───────────────┴───────────┘
 *   z+
 */

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export type Facing = 'posZ' | 'negZ' | 'posX' | 'negX';

export const BASE = {
  /** 底座边长 */
  size: 288,
  half: 144,
  /** 底座（展台）厚度 */
  plinth: 6,
  /** 地面（战场路面）在 y=0 */
  groundY: 0,
  /** 核心区边长（原地图范围） */
  core: 144,
  coreHalf: 72,
} as const;

/* ------------------------------------------------------------------ *
 * 路网：一切几何、落位校验与审计都以这份表为准
 * ------------------------------------------------------------------ */

export type RoadClass = 'main' | 'ring' | 'link';

export interface Road extends Rect {
  id: string;
  /** 行车方向：'x' = 东-西向，'z' = 南-北向 */
  axis: 'x' | 'z';
  /** 道路中心线坐标（垂直于行车方向的轴） */
  at: number;
  /** 车行道半宽 */
  half: number;
  /** 人行道宽度 */
  walk: number;
  /** 沿行车方向的起止 */
  from: number;
  to: number;
  class: RoadClass;
  note: string;
}

export const ROAD = {
  /** 东-西向主大道半宽 */
  avenueHalf: 9,
  /** 南-北向纵街半宽 */
  crossHalf: 8,
  /** 人行道宽度（主干道） */
  sidewalk: 4,
  /** 路缘高度 */
  curbHeight: 0.22,
} as const;

/**
 * 路网。每条路的两端都必须接在另一条路上（十字或丁字）；
 * 唯一通向底座边缘的是 suburbLane，它消失在雾里——那是"模型之外还有城市"的读法，不是断头路。
 */
export const ROADS: Road[] = [
  // —— 原有十字主网格：随底座延长到新的四边 ——
  { id: 'avenue', axis: 'x', at: 0, half: ROAD.avenueHalf, walk: ROAD.sidewalk, from: -BASE.half, to: BASE.half, x0: -BASE.half, x1: BASE.half, z0: -ROAD.avenueHalf, z1: ROAD.avenueHalf, class: 'main', note: '东西向主大道，横贯全图' },
  { id: 'cross', axis: 'z', at: 0, half: ROAD.crossHalf, walk: ROAD.sidewalk, from: -BASE.half, to: BASE.half, x0: -ROAD.crossHalf, x1: ROAD.crossHalf, z0: -BASE.half, z1: BASE.half, class: 'main', note: '南北向纵街：车队动线，穿过哨卡出城' },

  // —— 外环四条 ——
  { id: 'ringN', axis: 'x', at: -100, half: 6, walk: 3, from: -BASE.half, to: BASE.half, x0: -BASE.half, x1: BASE.half, z0: -106, z1: -94, class: 'ring', note: '北环道' },
  { id: 'ringS', axis: 'x', at: 100, half: 6, walk: 3, from: -BASE.half, to: BASE.half, x0: -BASE.half, x1: BASE.half, z0: 94, z1: 106, class: 'ring', note: '南环道' },
  { id: 'ringW', axis: 'z', at: -100, half: 6, walk: 3, from: -BASE.half, to: BASE.half, x0: -106, x1: -94, z0: -BASE.half, z1: BASE.half, class: 'ring', note: '西环道，平民区东界' },
  { id: 'ringE', axis: 'z', at: 100, half: 6, walk: 3, from: -BASE.half, to: BASE.half, x0: 94, x1: 106, z0: -BASE.half, z1: BASE.half, class: 'ring', note: '东环道，工业区西界' },

  // —— 外缘联络道 ——
  { id: 'gate', axis: 'x', at: 132, half: 5, walk: 2.5, from: -100, to: 100, x0: -100, x1: 100, z0: 127, z1: 137, class: 'link', note: '南门干道：西接西环道、东接东环道，横切哨卡前沿' },
  { id: 'suburbLane', axis: 'z', at: -40, half: 5, walk: 2.5, from: -BASE.half, to: -100, x0: -45, x1: -35, z0: -144, z1: -100, class: 'link', note: '平民区巷道：南接北环道，北段消失在雾里' },
];

/** 车行道矩形（不含人行道）：任何资产都不能立在这里 */
export function carriageway(r: Road): Rect {
  return r.axis === 'x'
    ? { x0: r.from, x1: r.to, z0: r.at - r.half, z1: r.at + r.half }
    : { x0: r.at - r.half, x1: r.at + r.half, z0: r.from, z1: r.to };
}

/** 车行道 + 人行道矩形（建筑退线外的不可建造带） */
export function roadCorridor(r: Road): Rect {
  return r.axis === 'x'
    ? { x0: r.from, x1: r.to, z0: r.at - r.half - r.walk, z1: r.at + r.half + r.walk }
    : { x0: r.at - r.half - r.walk, x1: r.at + r.half + r.walk, z0: r.from, z1: r.to };
}

/** 路口中心（斑马线、信号灯、弹坑、积水都按此定位） */
export const JUNCTIONS: Array<{ x: number; z: number; kind: 'cross' | 'tee' }> = [
  { x: 0, z: 0, kind: 'cross' },
  { x: -100, z: 0, kind: 'cross' },
  { x: 100, z: 0, kind: 'cross' },
  { x: 0, z: -100, kind: 'cross' },
  { x: 0, z: 100, kind: 'cross' },
  { x: 0, z: 132, kind: 'cross' },
  { x: -100, z: -100, kind: 'cross' },
  { x: 100, z: -100, kind: 'cross' },
  { x: -100, z: 100, kind: 'cross' },
  { x: 100, z: 100, kind: 'cross' },
  { x: -100, z: 132, kind: 'tee' },
  { x: 100, z: 132, kind: 'tee' },
  { x: -40, z: -100, kind: 'tee' },
];

/* ------------------------------------------------------------------ *
 * 铁路专用线：东境单线 + 装卸线，三处平交道口，南端尽端有车挡
 * ------------------------------------------------------------------ */

export const RAIL = {
  axis: 'z' as const,
  /** 线路中心 x */
  at: 134,
  /** 轨距 */
  gauge: 1.52,
  from: -140,
  to: 118,
  /** 与路网的平交道口（z 坐标） */
  crossings: [-100, 0, 100],
  /** 尽端车挡 */
  buffer: { x: 134, z: 118 },
  /** 装卸线：从正线向西岔进货场 */
  spur: { axis: 'x' as const, at: 108, from: 118, to: 134 },
  /** 脱轨段：货车斜出轨距，车头栽进道砟带外的空渣地 */
  derail: { x: 129, z: 92, rotY: -0.42 },
} as const;

/* ------------------------------------------------------------------ *
 * 核心区道路边界 / 建筑退线（保持原有含义不变）
 * ------------------------------------------------------------------ */

export const EDGE = {
  avenueNorth: -ROAD.avenueHalf,
  avenueSouth: ROAD.avenueHalf,
  crossWest: -ROAD.crossHalf,
  crossEast: ROAD.crossHalf,
} as const;

export const BUILD_LINE = {
  avenueNorth: EDGE.avenueNorth - ROAD.sidewalk, // -13
  avenueSouth: EDGE.avenueSouth + ROAD.sidewalk, // 13
  crossWest: -ROAD.crossHalf - ROAD.sidewalk, // -12
  crossEast: ROAD.crossHalf + ROAD.sidewalk, // 12
} as const;

/** 主角建筑：街角三层小楼（位置随扩建完全不变） */
export const HERO = {
  x0: BUILD_LINE.crossEast, // 12
  x1: 34,
  z0: -34,
  z1: BUILD_LINE.avenueNorth, // -13
  floors: 3,
  groundHeight: 4.3,
  upperHeight: 3.3,
  wall: 0.55,
  /** 街角切角（商铺门面朝路口） */
  cornerCut: 3.6,
  /** 屋顶檐口高度 */
  get eaveY(): number {
    return this.groundHeight + this.upperHeight * (this.floors - 1);
  },
} as const;

/** 核心区的四个街区 */
export const QUADRANTS: Record<'nw' | 'ne' | 'sw' | 'se', Rect> = {
  nw: { x0: -BASE.coreHalf + 2, x1: BUILD_LINE.crossWest, z0: -BASE.coreHalf + 2, z1: BUILD_LINE.avenueNorth },
  ne: { x0: BUILD_LINE.crossEast, x1: BASE.coreHalf - 2, z0: -BASE.coreHalf + 2, z1: BUILD_LINE.avenueNorth },
  sw: { x0: -BASE.coreHalf + 2, x1: BUILD_LINE.crossWest, z0: BUILD_LINE.avenueSouth, z1: BASE.coreHalf - 2 },
  se: { x0: BUILD_LINE.crossEast, x1: BASE.coreHalf - 2, z0: BUILD_LINE.avenueSouth, z1: BASE.coreHalf - 2 },
};

export interface Plot extends Rect {
  facing: Facing;
  kind: 'rowhouse' | 'apartment' | 'shopRow' | 'shed' | 'ruin' | 'yard';
  /** 建议层数 */
  floors: number;
  /** 备注（给建模模块的语义提示） */
  note?: string;
}

/**
 * 小镇地块：核心区一块未动，外圈另补了 8 块（内圈地块带 76..90）。
 * 主楼占地 x[12,34] z[-34,-13]，已从 NE 街区中排除。
 */
export const TOWN_PLOTS: Plot[] = [
  // —— NW 街区（沿大道北侧一排临街住宅）——
  { x0: -30, x1: -16, z0: -26, z1: -13.5, facing: 'posZ', kind: 'rowhouse', floors: 3, note: '临街三层住宅，底层小杂货铺，二层一扇窗亮着应急灯' },
  { x0: -46, x1: -32, z0: -25, z1: -13.5, facing: 'posZ', kind: 'shopRow', floors: 2, note: '两层连排商铺，招牌半脱落，雨棚破损' },
  { x0: -45, x1: -38, z0: -44, z1: -28, facing: 'posZ', kind: 'apartment', floors: 4 },
  { x0: -34, x1: -20, z0: -46, z1: -30, facing: 'posZ', kind: 'rowhouse', floors: 3 },
  { x0: -18, x1: -13, z0: -40, z1: -28, facing: 'posZ', kind: 'ruin', floors: 2, note: '半塌的窄楼，只剩楼梯间与外墙' },

  // —— NE 街区（主楼后排与东侧）——
  { x0: 14, x1: 30, z0: -50, z1: -37, facing: 'posZ', kind: 'rowhouse', floors: 3 },
  { x0: 32, x1: 46, z0: -50, z1: -38, facing: 'posZ', kind: 'shed', floors: 1, note: '车库与棚屋，波纹铁皮顶' },
  { x0: 36, x1: 45.5, z0: -32, z1: -14.5, facing: 'posZ', kind: 'rowhouse', floors: 3, note: '与主楼隔一条小巷' },

  // —— SW 街区（大道南侧）——
  { x0: -30, x1: -14, z0: 14, z1: 30, facing: 'negZ', kind: 'shopRow', floors: 2, note: '临街商铺，门前有遮雨棚与临时摊位' },
  { x0: -48, x1: -32, z0: 14, z1: 32, facing: 'negZ', kind: 'apartment', floors: 4, note: '四层公寓，多个阳台被炸塌' },
  { x0: -47, x1: -22, z0: 36, z1: 50, facing: 'negZ', kind: 'rowhouse', floors: 3 },
  { x0: -20, x1: -13, z0: 34, z1: 48, facing: 'negZ', kind: 'shed', floors: 1 },

  // —— SE 街区（路口东南）——
  // 定制乡村别墅的专属地块：紧贴大道南侧退线（z=13），正面朝北面向大道，独立院子。
  // 后排公寓往里推到 z≥28，给别墅留出完整的临街街区与呼吸空间。
  { x0: 14, x1: 32, z0: 28, z1: 38, facing: 'negZ', kind: 'apartment', floors: 4, note: '四层公寓（往里推，给路边别墅让出临街面）' },
  { x0: 34, x1: 43.5, z0: 22, z1: 36, facing: 'negZ', kind: 'rowhouse', floors: 3, note: '平顶联排：拆除坡顶改平顶，女儿墙残破，外墙有金属逃生梯' },
  { x0: 14, x1: 25, z0: 42, z1: 54, facing: 'posZ', kind: 'yard', floors: 1, note: '院子、柴堆与菜地，晾衣绳（东半是定制乡村别墅的地）' },

  // —— 外圈远街 ——
  { x0: -66, x1: -40, z0: -60, z1: -46, facing: 'posZ', kind: 'rowhouse', floors: 3, note: '北郊联排，墙面斑驳，多数窗被木板封死；平顶联排：拆除坡顶改平顶，女儿墙残破，外墙有金属逃生梯' },
  { x0: -38, x1: -20, z0: -64, z1: -50, facing: 'posZ', kind: 'ruin', floors: 2, note: '被炮火掀掉一半的楼，只剩立面与楼梯间' },
  { x0: -19, x1: -13, z0: -66, z1: -52, facing: 'posZ', kind: 'ruin', floors: 2, note: '北郊纵街西侧窄条危楼（贴线补位，不压车道）' },
  { x0: 12, x1: 34, z0: -66, z1: -54, facing: 'posZ', kind: 'rowhouse', floors: 2, note: '平顶联排：拆除坡顶改平顶，女儿墙残破，外墙有金属逃生梯' },
  { x0: 38, x1: 64, z0: -64, z1: -50, facing: 'posZ', kind: 'yard', floors: 1, note: '北郊院子：铁皮棚、柴堆、废弃拖车' },
  { x0: -68, x1: -46, z0: -34, z1: -18, facing: 'posX', kind: 'rowhouse', floors: 3, note: '西郊联排（面朝纵街延长线）' },
  { x0: -68, x1: -52, z0: 20, z1: 44, facing: 'posX', kind: 'shopRow', floors: 2, note: '西郊废弃作坊与车库' },
  { x0: -66, x1: -48, z0: 48, z1: 64, facing: 'negZ', kind: 'rowhouse', floors: 3 },
  { x0: -42, x1: -20, z0: 56, z1: 68, facing: 'negZ', kind: 'apartment', floors: 4, note: '南郊公寓，屋顶有高射机枪掩体沙袋圈' },
  { x0: 44, x1: 66, z0: 50, z1: 66, facing: 'negZ', kind: 'rowhouse', floors: 2, note: '南郊东段联排（移到纵街以东，避开车道）' },
  { x0: 16, x1: 40, z0: 54, z1: 68, facing: 'negZ', kind: 'ruin', floors: 3, note: '南郊半塌楼，顶部被掀，露出房间剖面' },
  { x0: 44, x1: 68, z0: 16, z1: 36, facing: 'negX', kind: 'rowhouse', floors: 3, note: '东郊联排，底层有被木板封死的店面' },
  { x0: 46, x1: 68, z0: -30, z1: -14, facing: 'negX', kind: 'apartment', floors: 4, note: '东郊公寓' },

  // —— 补位地块：把外圈的空地填成紧凑街区（沿街墙面连续，后院放低矮房屋）——
  { x0: -70, x1: -46, z0: -46, z1: -36, facing: 'posX', kind: 'rowhouse', floors: 2, note: '西侧补位联排，与大院围合出后院' },
  { x0: -70, x1: -48, z0: -72, z1: -62, facing: 'posZ', kind: 'shed', floors: 1, note: '西北角棚屋与堆料场' },
  { x0: 48, x1: 68, z0: -48, z1: -34, facing: 'negX', kind: 'apartment', floors: 3, note: '东侧补位公寓，靠街一排' },
  { x0: 46, x1: 68, z0: 38, z1: 48, facing: 'negX', kind: 'rowhouse', floors: 2, note: '东侧补位联排' },
  { x0: 14, x1: 34, z0: -72, z1: -67, facing: 'posZ', kind: 'yard', floors: 1, note: '北缘后院：柴堆、晾衣绳、围墙' },
  { x0: -34, x1: -14, z0: 68, z1: 72, facing: 'negZ', kind: 'shed', floors: 1, note: '南缘棚屋' },
  { x0: 16, x1: 40, z0: 69, z1: 72, facing: 'negZ', kind: 'yard', floors: 1, note: '南缘小院' },
  { x0: -70, x1: -50, z0: 64, z1: 72, facing: 'negZ', kind: 'yard', floors: 1, note: '西南角院子' },

  // —— 内圈地块带（74..90，紧贴旧边界之外）——
  { x0: -70, x1: -48, z0: 76, z1: 90, facing: 'negZ', kind: 'rowhouse', floors: 2, note: '内圈南带联排，屋顶晒衣架' },
  { x0: -44, x1: -16, z0: 76, z1: 90, facing: 'negZ', kind: 'yard', floors: 1, note: '内圈南带院子与菜地，正对哨卡' },
  { x0: 16, x1: 44, z0: 76, z1: 90, facing: 'negZ', kind: 'apartment', floors: 4, note: '内圈南带公寓，底层被沙袋封住半个门洞' },
  { x0: 48, x1: 68, z0: 76, z1: 90, facing: 'negZ', kind: 'ruin', floors: 2, note: '内圈南带残楼，山墙整面被掀掉' },
  { x0: 48, x1: 68, z0: -90, z1: -76, facing: 'posZ', kind: 'shed', floors: 1, note: '内圈北带堆料场与车库' },
  { x0: 16, x1: 44, z0: -90, z1: -76, facing: 'posZ', kind: 'rowhouse', floors: 3, note: '内圈北带联排' },
  { x0: -18, x1: -13, z0: -90, z1: -76, facing: 'posZ', kind: 'ruin', floors: 2, note: '内圈北带窄条危楼' },
  { x0: -44, x1: -20, z0: -90, z1: -76, facing: 'posZ', kind: 'yard', floors: 1, note: '内圈北带拆开的院墙与柴堆' },
];

/** 巷道（建筑之间的窄缝小巷，可穿行） */
export const ALLEYS: Rect[] = [
  { x0: 34, x1: 36, z0: -34, z1: -13 }, // 主楼东侧小巷（主楼东墙 x=34 起算，宽 2m）
  { x0: -16, x1: -12, z0: -28, z1: -13 }, // NW 街区侧巷
  { x0: 32, x1: 34, z0: 14, z1: 34 }, // SE 街区窄巷
];

/* ------------------------------------------------------------------ *
 * 扩建分区：模块只在自己的 rect 里活动，且每一栋都必须过 canPlace()
 * ------------------------------------------------------------------ */

export interface Zone extends Rect {
  id: string;
  use: 'suburb' | 'industrial' | 'outpost' | 'wasteland';
  /** 该区内建筑最大层数（体量与 LOD 约束） */
  maxFloors: number;
  /** 建筑到边界必须留出的间距 */
  margin: number;
  note: string;
}

export const ZONES: Zone[] = [
  // —— 密集平民区：低矮赫鲁晓夫楼与破败平房交错，窄巷、晾衣绳 ——
  { id: 'suburbW1', x0: -138, x1: -110, z0: -90, z1: -14, use: 'suburb', maxFloors: 3, margin: 1.2, note: '西境平民区北段：沿街连排 + 后院平房' },
  { id: 'suburbW2', x0: -138, x1: -110, z0: 14, z1: 90, use: 'suburb', maxFloors: 3, margin: 1.2, note: '西境平民区南段：两排板楼夹一条窄巷' },
  { id: 'suburbN1', x0: -88, x1: -48, z0: -136, z1: -110, use: 'suburb', maxFloors: 2, margin: 1.2, note: '北带平民区西段：平房、倒塌围墙、公共水龙头' },
  { id: 'suburbN2', x0: -32, x1: -10, z0: -136, z1: -110, use: 'suburb', maxFloors: 2, margin: 1.2, note: '北带平民区中段：夹在巷道与纵街之间的一排平房' },
  { id: 'suburbN3', x0: 10, x1: 90, z0: -136, z1: -110, use: 'suburb', maxFloors: 3, margin: 1.2, note: '北带平民区东段：三层板楼一排' },
  { id: 'suburbS', x0: -138, x1: -110, z0: 110, z1: 124, use: 'suburb', maxFloors: 2, margin: 1.2, note: '西南角平民区末排（紧邻变电站）' },

  // —— 废弃工业区：半塌红砖厂房、锈蚀储水罐、长草铁轨、脱轨货车 ——
  { id: 'indN', x0: 110, x1: 128, z0: -90, z1: -14, use: 'industrial', maxFloors: 3, margin: 1.2, note: '厂区北带：大跨度红砖厂房与锯齿天窗' },
  { id: 'indS', x0: 110, x1: 128, z0: 14, z1: 90, use: 'industrial', maxFloors: 3, margin: 1.2, note: '厂区南带：仓库、车间、巨型储水罐' },
  { id: 'indSiding', x0: 110, x1: 140, z0: 110, z1: 124, use: 'industrial', maxFloors: 1, margin: 0.6, note: '南端装卸场：站台、吊车、集装箱、煤堆、尽端车挡' },

  // —— 前沿军事哨卡：沙袋、捷克刺猬、铁丝网、装甲车、探照灯 ——
  { id: 'outpostW', x0: -88, x1: -14, z0: 110, z1: 124, use: 'outpost', maxFloors: 1, margin: 0.6, note: '哨卡西翼：沙袋墙、拒马、铁丝网、迫击炮阵地' },
  { id: 'outpostE', x0: 14, x1: 88, z0: 110, z1: 124, use: 'outpost', maxFloors: 1, margin: 0.6, note: '哨卡东翼：岗楼、探照灯塔、BTR 停放区、篝火' },

  // —— 废墟与边缘 ——
  { id: 'wasteSW', x0: -138, x1: -110, z0: 127, z1: 138, use: 'wasteland', maxFloors: 1, margin: 0.8, note: '西南角：被炸毁的变电站与倒伏电塔' },
  { id: 'wasteNW', x0: -138, x1: -110, z0: -136, z1: -110, use: 'wasteland', maxFloors: 1, margin: 0.8, note: '西北角：毁果园、散兵坑与翻倒的农具' },
  { id: 'wasteNE', x0: 110, x1: 128, z0: -136, z1: -110, use: 'wasteland', maxFloors: 2, margin: 0.8, note: '东北角：坍了半边的谷物筒仓' },
];

/* ------------------------------------------------------------------ *
 * 净空契约：任何新资产落位前都必须通过
 * ------------------------------------------------------------------ */

const CARRIAGE: Rect[] = ROADS.map(carriageway);
const CORRIDORS: Rect[] = ROADS.map(roadCorridor);

/** 既有足迹（建筑、主楼、铁路走廊）：新建筑不得压盖 */
const OCCUPIED: Rect[] = [
  ...TOWN_PLOTS.map((p) => ({ x0: p.x0, x1: p.x1, z0: p.z0, z1: p.z1 })),
  { x0: HERO.x0, x1: HERO.x1, z0: HERO.z0, z1: HERO.z1 },
  { x0: RAIL.at - 4.6, x1: RAIL.at + 4.6, z0: RAIL.from, z1: RAIL.to + 6 },
];

export function overlaps(a: Rect, b: Rect, pad = 0): boolean {
  return a.x0 < b.x1 + pad && a.x1 > b.x0 - pad && a.z0 < b.z1 + pad && a.z1 > b.z0 - pad;
}

/** 该矩形是否与车行道相交（绝对禁止） */
export function hitsCarriageway(rect: Rect, pad = 0): boolean {
  return CARRIAGE.some((c) => overlaps(rect, c, pad));
}

/** 该点是否落在车行道上 */
export function isOnCarriageway(x: number, z: number, pad = 0): boolean {
  return CARRIAGE.some((c) => x > c.x0 - pad && x < c.x1 + pad && z > c.z0 - pad && z < c.z1 + pad);
}

/** 该点是否落在"车行道 + 人行道"里（道具与瓦砾的落位禁区） */
export function isOnRoadCorridor(x: number, z: number, pad = 0): boolean {
  return CORRIDORS.some((c) => x > c.x0 - pad && x < c.x1 + pad && z > c.z0 - pad && z < c.z1 + pad);
}

/** 某个坐标的地面高度：人行道最高（有路缘），其次是各等级车行道，最后是空地。 */
export function groundYAt(x: number, z: number): number {
  let y = 0.045;
  for (const r of ROADS) {
    const d = r.axis === 'x' ? Math.abs(z - r.at) : Math.abs(x - r.at);
    if (d > r.half + r.walk) continue;
    const along = r.axis === 'x' ? x : z;
    if (along < r.from || along > r.to) continue;
    const cand = d <= r.half ? (r.class === 'main' ? 0.07 : r.class === 'ring' ? 0.062 : 0.056) : ROAD.curbHeight;
    if (cand > y) y = cand;
  }
  return y;
}

/** 该矩形是否落在"车行道 + 人行道"的不可建造带里 */
export function hitsRoadCorridor(rect: Rect, pad = 0): boolean {
  return CORRIDORS.some((c) => overlaps(rect, c, pad));
}

/** 该矩形是否压到既有建筑 / 主楼 / 铁路 */
export function hitsOccupied(rect: Rect, pad = 0): boolean {
  return OCCUPIED.some((o) => overlaps(rect, o, pad));
}

/** 是否仍在底座可建造范围内（边缘留出地台切面与剪影带） */
export function insideBase(rect: Rect): boolean {
  const lim = BASE.half - 4;
  return rect.x0 >= -lim && rect.x1 <= lim && rect.z0 >= -lim && rect.z1 <= lim;
}

/** 落位总校验：范围内 + 不碰车道 + 不碰人行道 + 不压既有建筑 */
export function canPlace(rect: Rect, pad = 0): boolean {
  return (
    insideBase(rect) &&
    !hitsCarriageway(rect, 0.6) &&
    !hitsRoadCorridor(rect, pad) &&
    !hitsOccupied(rect, 0.4)
  );
}

/** 车队主车道（纵街南向车道）：审计、车灯、水花都以此为准 */
// 可用车道止于路尽头阻挡物之前（尽头由塌桥 / 隧道口封住，是有意为之）
export const CONVOY_LANE = { x0: 1.2, x1: 5.4, z0: -139, z1: 139 } as const;

/** 全图车行道 / 不可建造带矩形表（审计工具直接读取，避免各处硬编码） */
export function allCarriageways(): Rect[] {
  return CARRIAGE.map((c) => ({ ...c }));
}

export function allCorridors(): Rect[] {
  return CORRIDORS.map((c) => ({ ...c }));
}

/* ------------------------------------------------------------------ *
 * 关键场景点位（供载具/人物/道具模块对齐）
 * ------------------------------------------------------------------ */

export const HOTSPOTS = {
  /**
   * 定制乡村别墅（world/villa.ts）：临大道南侧，正面朝北面向主干道。
   * rotation = π 让局部 +Z 的正门/车库大豁口转向世界 -Z（北）。
   * 唯一真值来源 —— 场景装配、雨溅射、碰撞都读它。
   */
  villa: { x: 22, z: 21, rotation: Math.PI },
  /** 商铺内部（底层残余门面），主妇做饭处 */
  shopInterior: { x: 17.6, z: -18.6 },
  /** 主楼南墙破窗内侧（室内）的碎砖与杂物密集处 */
  southWindowBreak: { x: 22, z: -14.6 },
  /** 老妇人与拖车：路口西北角人行道 */
  oldWoman: { x: 9.6, z: -10.8, rotY: Math.PI * 0.62 },
  /** 两个小孩：大道南侧人行道 */
  kids: { x: 15.5, z: 10.8, rotY: -0.5 },
  /** 休息中的 BMPT：纵街西侧车道（避开南向车队车道 x≈3.2，不阻挡动线） */
  bmpt: { x: -4.2, z: -23.5, rotY: 0.16 },
  /** 被击毁的 T-72：主楼门前大道上 */
  t72: { x: 27.5, z: 3.2, rotY: -0.55 },
  /** 烧毁的民用轿车：大道西段 */
  burntCar: { x: -19.5, z: -3.6, rotY: 0.42 },
  /** 无人机巡航中心与半径、高度（扩建后绕全图，半径加大、速度放慢） */
  drone: { x: 6, y: 21, z: -10, radius: 46, speed: 0.05 },
  /** 街角路牌 */
  cornerSign: { x: 10.6, z: -11.2 },
  /** 交通信号灯（路口四角） */
  trafficLights: [
    { x: 10.4, z: -10.6 },
    { x: -10.4, z: 10.6 },
  ],
  /** 主楼屋顶崩塌处 */
  roofCollapse: { x: 27.5, z: -26 },

  // —— 扩建区新增 ——
  /** 哨卡：车队通过的唯一缺口（纵街两侧各一道沙袋墙，缺口内不许有任何障碍） */
  outpostGap: { x0: -13.2, x1: 13.2, z: 118 },
  /** 探照灯塔（东西各一座，光束缓慢扫过前沿与铁丝网） */
  searchlights: [
    { x: -30, z: 121, h: 8.5, facing: -0.5 },
    { x: 32, z: 114, h: 7.5, facing: Math.PI + 0.42 },
  ],
  /** 哨卡装甲车（BTR-80）停放位：全部在车道与人行道之外 */
  armoredParked: [
    { x: -52, z: 116.5, rotY: 0.22 },
    { x: -60, z: 121, rotY: -0.12 },
    { x: 56, z: 120.5, rotY: Math.PI + 0.3 },
  ],
  /** 哨卡篝火（用暖色撕裂冷蓝雨夜的主要锚点之一） */
  outpostFire: { x: -42, z: 120.5 },
  /** 哨卡迫击炮阵地 */
  mortarPit: { x: 66, z: 116 },
  /** 工业区：巨型储水罐（锈蚀、爬梯、环形焊缝） */
  waterTank: { x: 119, z: 52 },
  /** 工业区：主厂房（大跨度、半坍塌、锯齿天窗） */
  factoryMain: { x: 119, z: -50 },
  /** 工业区：烟囱（远景天际线的近端锚点） */
  chimney: { x: 124, z: -18 },
  /** 工业区：装卸线与脱轨车厢 */
  loadingRamp: { x: 121, z: 116 },
  derailed: { x: RAIL.derail.x, z: RAIL.derail.z, rotY: RAIL.derail.rotY },
  /** 铁路道口（三处平交，栏杆与警示牌按此定位） */
  levelCrossings: RAIL.crossings.map((z) => ({ x: RAIL.at, z })),
  /** 西境平民区：公共水龙头与倒塌的门面 */
  suburbPump: { x: -124, z: 26 },
  /** 西南角变电站 */
  substation: { x: -124, z: 132 },
  /** 东北角谷物筒仓 */
  silo: { x: 119, z: -124 },
} as const;

/** 车辆/人物使用的通行高度（略高于路面，避免 z-fighting） */
export const SURFACE_Y = 0.02;
