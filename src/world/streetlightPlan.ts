import type { Rng } from '../core/rng';
import { CONVOY_LANE, HOTSPOTS, RAIL, ROAD, ROADS } from './layout';

/**
 * 全图路灯落位（纯数据，不碰 Three）。
 *
 * 规则：
 *  - 沿每条路以 18 m 间距交替两侧，灯杆压在人行道内缘（距路缘 0.85 m），
 *    灯臂伸向车行道，灯头悬在车道边缘上方；
 *  - 路口走廊内不放：把交叉道路的"车行道 + 人行道 + 1.6 m"从线路里让开，
 *    斑马线、停止线和转角补板都不会被灯杆戳穿；
 *  - 铁路道口、信号灯、路牌、人物等已知点位留出净空；
 *  - 约 20% 的灯处于损坏状态：一部分倾倒在车行道上空，一部分沿街侧倒，
 *    其余完全平躺（这些不再参与真实灯池）。
 *
 * 独立成模块是为了能在 vitest 里直接验算：落位、损坏比例、净空都不需要 WebGL。
 */

export type LampState = 'intact' | 'flicker' | 'tilted' | 'fallen';

/** 倾倒方向：向车行道 / 沿街侧倒 / 未倾倒 */
export type LampFall = 'road' | 'along' | 'none';

export interface LampSpec {
  index: number;
  roadId: string;
  axis: 'x' | 'z';
  /** 灯杆根部世界坐标（XZ） */
  x: number;
  z: number;
  /** 人行道顶面高度 */
  baseY: number;
  side: -1 | 1;
  /** 灯臂朝向：局部 +Z 转到世界后的朝向角 */
  yaw: number;
  state: LampState;
  /** 相对竖直方向的倾角（弧度） */
  tilt: number;
  fall: LampFall;
  /** 沿街侧倒的侧向（±1） */
  rollSign: -1 | 1;
  /** 是否能被真实灯池选中 */
  live: boolean;
}

export const LAMP_SPACING = 18;
/** 距底座边缘留出的距离，避免灯杆立在展台切面上 */
const EDGE_MARGIN = 6.5;
/** 交叉路口净空：对方人行道外再留 1.6 m（正好越过停止线） */
const CROSS_CLEAR = 1.6;
/** 灯杆中心到路缘的距离：底座落在人行道内缘，灯臂伸向车道 */
const CURB_INSET = 0.85;

const KEEP_OUT: Array<{ x: number; z: number; r: number }> = [
  { x: HOTSPOTS.cornerSign.x, z: HOTSPOTS.cornerSign.z, r: 2.4 },
  { x: HOTSPOTS.oldWoman.x, z: HOTSPOTS.oldWoman.z, r: 2.4 },
  { x: HOTSPOTS.kids.x, z: HOTSPOTS.kids.z, r: 2.8 },
  ...HOTSPOTS.trafficLights.map((l) => ({ x: l.x, z: l.z, r: 2.6 })),
];

function nearKeepOut(x: number, z: number): boolean {
  for (const k of KEEP_OUT) {
    const dx = x - k.x;
    const dz = z - k.z;
    if (dx * dx + dz * dz < k.r * k.r) return true;
  }
  return false;
}

/** 该位置是否在路口/铁路道口的净空里 */
function inJunctionClearance(road: (typeof ROADS)[number], along: number): boolean {
  for (const other of ROADS) {
    if (other.id === road.id || other.axis === road.axis) continue;
    // 只有真的横穿这条路（对方沿自身轴向覆盖这条路的中线）才算路口
    if (other.from > road.at + 0.01 || other.to < road.at - 0.01) continue;
    if (Math.abs(along - other.at) < other.half + other.walk + CROSS_CLEAR) return true;
  }
  // 铁路平交道口：轨面、护轨与轮缘槽占据路侧
  if (road.axis === 'x' && Math.abs(along - RAIL.at) < 6) return true;
  return false;
}

/** 灯臂朝向：局部 +Z 转向车行道中心 */
function armYaw(axis: 'x' | 'z', side: -1 | 1): number {
  if (axis === 'x') return side === -1 ? 0 : Math.PI;
  return side === -1 ? Math.PI / 2 : -Math.PI / 2;
}

/**
 * 倒地灯的落地足迹（杆身 6.2 m + 灯头朝车道 1.9 m）是否压到车队车道。
 * 压到就不许平躺——改成沿街倾斜，杆身离地，车队动线不会被一根躺着的灯杆截断。
 */
function fallenHitsLane(axis: 'x' | 'z', x: number, z: number, side: -1 | 1): boolean {
  const towardRoad = -side;
  let x0: number;
  let x1: number;
  let z0: number;
  let z1: number;
  if (axis === 'x') {
    x0 = x - 6.2;
    x1 = x + 6.2;
    z0 = Math.min(z, z + towardRoad * 1.9);
    z1 = Math.max(z, z + towardRoad * 1.9);
  } else {
    z0 = z - 6.2;
    z1 = z + 6.2;
    x0 = Math.min(x, x + towardRoad * 1.9);
    x1 = Math.max(x, x + towardRoad * 1.9);
  }
  return (
    x0 < CONVOY_LANE.x1 &&
    x1 > CONVOY_LANE.x0 &&
    z0 < CONVOY_LANE.z1 &&
    z1 > CONVOY_LANE.z0
  );
}

export function planStreetlights(rng: Rng): LampSpec[] {
  const out: LampSpec[] = [];
  let index = 0;

  for (const road of ROADS) {
    const startSide = rng.sign() as -1 | 1;
    let step = 0;
    for (let t = road.from + EDGE_MARGIN; t <= road.to - EDGE_MARGIN; t += LAMP_SPACING) {
      const along = t + rng.range(-0.6, 0.6);
      const side: -1 | 1 = step % 2 === 0 ? startSide : ((-startSide) as -1 | 1);
      step += 1;

      if (inJunctionClearance(road, along)) continue;

      const offset = road.half + CURB_INSET;
      const x = road.axis === 'x' ? along : road.at + side * offset;
      const z = road.axis === 'x' ? road.at + side * offset : along;
      if (nearKeepOut(x, z)) continue;

      const yaw = armYaw(road.axis, side) + rng.range(-0.03, 0.03);

      out.push({
        index,
        roadId: road.id,
        axis: road.axis,
        x,
        z,
        baseY: ROAD.curbHeight,
        side,
        yaw,
        state: 'intact',
        tilt: rng.range(-0.022, 0.022),
        fall: 'none',
        rollSign: 1,
        live: true,
      });
      index += 1;
    }
  }

  /**
   * 损坏比例用配额而不是逐盏 Bernoulli：
   * 70 盏灯按 20% 独立抽样时，30% 这种偏离并不罕见，画面会显得"倒得太多"。
   * 先洗牌再取固定比例，既保留随机位置，又保证全图观感稳定。
   */
  const order = rng.shuffle(out.map((_, i) => i));
  const damageCount = Math.round(out.length * 0.2);
  const flickerCount = Math.max(1, Math.round(out.length * 0.05));

  for (let k = 0; k < damageCount; k += 1) {
    const lamp = out[order[k]!]!;
    const rollSign: -1 | 1 = rng.chance(0.5) ? 1 : -1;
    let state: LampState;
    let tilt: number;
    let fall: LampFall;
    let live = true;

    if (rng.chance(0.42)) {
      // 完全平躺：沿街方向侧倒，灯头落进车行道边缘
      state = 'fallen';
      tilt = Math.PI / 2;
      fall = 'none';
      live = false;
    } else if (rng.chance(0.55)) {
      // 向车行道倾倒 46–66°：灯头悬在道路上方，真实聚光会斜打地面
      state = 'tilted';
      fall = 'road';
      tilt = rng.range(0.8, 1.15);
    } else {
      // 沿街侧倒 56–78°：不撞临街立面，灯臂仍朝向车行道
      state = 'tilted';
      fall = 'along';
      tilt = rng.range(0.98, 1.36);
    }

    // 躺在车队车道上的灯杆必须改成侧倾：地面的通路优先级高于戏剧性
    if (state === 'fallen' && fallenHitsLane(lamp.axis, lamp.x, lamp.z, lamp.side)) {
      state = 'tilted';
      fall = 'along';
      tilt = rng.range(0.98, 1.36);
      live = true;
    }

    Object.assign(lamp, { state, tilt, fall, rollSign, live });
  }

  for (let k = damageCount; k < damageCount + flickerCount && k < order.length; k += 1) {
    Object.assign(out[order[k]!]!, {
      state: 'flicker' as LampState,
      fall: 'none' as LampFall,
      tilt: rng.range(-0.018, 0.018),
      rollSign: 1 as -1 | 1,
      live: true,
    });
  }

  return out;
}
