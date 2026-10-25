import { RAIL, ROADS, ZONES, carriageway, type Rect } from './layout';

/**
 * 统一空间占位系统。
 *
 * 解决的问题：此前每个模块各自判断"能不能放"，判据不一（border 只避道路、fill 只避地块、
 * 建筑模块只避地块与道路），于是会出现"树长在铁轨上"这类同层相交，而且没有地方能一次性回答
 * "这块地到底被谁占了"。
 *
 * 分层与优先级（低层不可被高层挤掉）：
 *  0 infra  道路车行道 + 铁路走廊：预先注册，永不被拒
 *  1 zone   三个扩建分区 + 核心地块：只需避让 infra
 *  2 prop   空地填充 / 路尽头阻挡 / 林带岩带：必须避让 infra 与其它 prop
 *
 * 注意：zone 不参与 prop 的拒绝。分区是"带状地块"，边缘的林带与它共存是设计意图
 * （树林压在地块外沿是剧本要的），真正要防的是"两个实体物件互相插进去"。
 */

export type Tier = 'infra' | 'structure' | 'zone' | 'prop';

export interface Claim extends Rect {
  tier: Tier;
  tag: string;
}

const CLAIMS: Claim[] = [];

const TIER_RANK: Record<Tier, number> = { infra: 0, structure: 1, zone: 2, prop: 3 };

function overlap(a: Rect, b: Rect, pad = 0): boolean {
  return a.x0 < b.x1 + pad && a.x1 > b.x0 - pad && a.z0 < b.z1 + pad && a.z1 > b.z0 - pad;
}

let infraReady = false;

/** 基础设施先铺：路网车行道 + 铁路走廊（只注册一次） */
export function initInfrastructure(): void {
  if (infraReady) return;
  infraReady = true;
  for (const r of ROADS) {
    CLAIMS.push({ ...carriageway(r), tier: 'infra', tag: `road:${r.id}` });
  }
  CLAIMS.push({
    x0: RAIL.at - 5.4,
    x1: RAIL.at + 5.4,
    z0: RAIL.from - 4,
    z1: RAIL.to + 8,
    tier: 'infra',
    tag: 'rail:main',
  });
  CLAIMS.push({
    x0: RAIL.spur.from - 4,
    x1: RAIL.spur.to + 4,
    z0: RAIL.spur.at - 4,
    z1: RAIL.spur.at + 4,
    tier: 'infra',
    tag: 'rail:spur',
  });
  for (const z of ZONES) {
    CLAIMS.push({ x0: z.x0, x1: z.x1, z0: z.z0, z1: z.z1, tier: 'zone', tag: `zone:${z.id}` });
  }
}

export interface ReserveResult {
  ok: boolean;
  reason?: string;
  conflict?: Claim;
}

export interface ReserveOptions {
  /**
   * 允许压基础设施。只有"路尽头阻挡物"这类构筑物该用：
   * 塌桥/隧道口的作用就是堵住路，压在车行道上是它的设计，不是 bug。
   */
  allowInfra?: boolean;
}

/**
 * 申请一块地。成功则登记，失败返回冲突方（便于报错时直接指出"撞了谁"）。
 * pad 是要求的安全边距。
 */
export function reserve(rect: Rect, tier: Tier, tag: string, pad = 0, opts: ReserveOptions = {}): ReserveResult {
  initInfrastructure();
  const me: Claim = { ...rect, tier, tag };
  const myRank = TIER_RANK[tier];
  for (const c of CLAIMS) {
    // 只检查同级与"我该避让"的更高层（rank 更小）
    if (TIER_RANK[c.tier] > myRank) continue;
    if (!overlap(me, c, pad)) continue;
    // infra 之间允许相交（道路天然在路口交叉）
    if (tier === 'infra' && c.tier === 'infra') continue;
    // 路尽头阻挡物：允许压 infra，但仍要避让其它实体
    if (opts.allowInfra && c.tier === 'infra') continue;
    // 带状地块之间允许相交（岩带横跨整条边，必然与分区带重叠）——与 auditOccupancy 的判据保持一致
    if (tier === 'zone' && c.tier === 'zone') continue;
    return { ok: false, reason: `${tag}(${tier}) 与 ${c.tag}(${c.tier}) 相交`, conflict: c };
  }
  CLAIMS.push(me);
  return { ok: true };
}

/** 只读快照（审计与调试用） */
export function claims(): Claim[] {
  initInfrastructure();
  return CLAIMS.map((c) => ({ ...c }));
}

export interface OccupancyReport {
  total: number;
  byTier: Record<Tier, number>;
  /** 同层/低层被高层压到的组合（应当为空） */
  violations: Array<{ a: string; b: string; reason: string }>;
  /** prop 压在 infra 上的组合（应当为空） */
  infraHits: Array<{ a: string; b: string }>;
  refusals: Array<{ tag: string; reason: string }>;
}

const REFUSALS: Array<{ tag: string; reason: string }> = [];

export function noteRefusal(tag: string, reason: string): void {
  REFUSALS.push({ tag, reason });
}

/** 全量自检：把已登记的占位两两比对 */
export function auditOccupancy(): OccupancyReport {
  initInfrastructure();
  const byTier: Record<Tier, number> = { infra: 0, structure: 0, zone: 0, prop: 0 };
  for (const c of CLAIMS) byTier[c.tier] += 1;
  const violations: OccupancyReport['violations'] = [];
  const infraHits: OccupancyReport['infraHits'] = [];
  for (let i = 0; i < CLAIMS.length; i += 1) {
    for (let j = i + 1; j < CLAIMS.length; j += 1) {
      const a = CLAIMS[i]!;
      const b = CLAIMS[j]!;
      if (!overlap(a, b)) continue;
      if (a.tier === 'infra' && b.tier === 'infra') continue;
      const nonInfra = [a, b].filter((c) => c.tier !== 'infra');
      const infraOne = [a, b].find((c) => c.tier === 'infra');
      if (infraOne && nonInfra.some((c) => c.tier === 'prop')) {
        infraHits.push({ a: a.tag, b: b.tag });
        continue;
      }
      // structure 压 infra 是设计意图（路尽头堵路），不算违规
      if (infraOne) continue;
      // zone 与 zone 之间、zone 与 prop 之间允许（带状地块与边缘林带共存是设计意图）
      const pair = a.tier === 'zone' || b.tier === 'zone' ? 'zone' : 'prop';
      if (pair === 'zone') continue;
      violations.push({ a: a.tag, b: b.tag, reason: `${a.tier} ∩ ${b.tier}` });
    }
  }
  return { total: CLAIMS.length, byTier, violations, infraHits, refusals: REFUSALS.slice() };
}

/** 给某个点找属地，用于报错信息与调试 */
export function ownerAt(x: number, z: number): Claim | undefined {
  initInfrastructure();
  return CLAIMS.find((c) => x > c.x0 && x < c.x1 && z > c.z0 && z < c.z1);
}
