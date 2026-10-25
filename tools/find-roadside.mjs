/**
 * 找"临主干道"的空地：沿大道（z=0）两侧，z 从 13 起（人行道外沿）往里，
 * 找一块没有地块、没有建筑、够放别墅（13×7 + 院子）的位置。
 *
 * node tools/find-roadside.mjs
 */
import { TOWN_PLOTS, HERO, ALLEYS, ROAD, BASE, ZONES } from '../src/world/layout.ts';

const AX = ROAD.avenueHalf + ROAD.sidewalk; // 13：大道北侧退线
const CX = ROAD.crossHalf + ROAD.sidewalk; // 12：纵街退线

// 已有占位（建筑足迹）
const taken = [
  ...TOWN_PLOTS.map((p) => ({ x0: p.x0, x1: p.x1, z0: p.z0, z1: p.z1, tag: 'plot' })),
  { x0: HERO.x0, x1: HERO.x1, z0: HERO.z0, z1: HERO.z1, tag: 'hero' },
  ...ALLEYS.map((a) => ({ x0: a.x0, x1: a.x1, z0: a.z0, z1: a.z1, tag: 'alley' })),
  ...ZONES.map((z) => ({ x0: z.x0, x1: z.x1, z0: z.z0, z1: z.z1, tag: `zone:${z.id}` })),
];

const ov = (a, b, pad = 0) => a.x0 < b.x1 + pad && a.x1 > b.x0 - pad && a.z0 < b.z1 + pad && a.z1 > b.z0 - pad;

// 别墅足迹（rotation=0, scale=1）：x 宽 13、z 深 7
const W = 13;
const D = 7;

// 候选道路带：中央大道（z=0）与南环道（z=100）两侧
const BANDS = [
  { name: '中央大道·南', at: 13, dir: +1 },
  { name: '中央大道·北', at: -13, dir: -1 },
  { name: '南环道·北', at: 109, dir: -1 },
  { name: '南环道·南', at: 91, dir: +1 },
  { name: '东环道·西', at: 91, dir: +1, axis: 'x' },
  { name: '东环道·东', at: 109, dir: -1, axis: 'x' },
];

const cands = [];
for (const band of BANDS) {
  const vertical = band.axis !== 'x';
  const along = vertical ? 'x' : 'z';
  const across = vertical ? 'z' : 'x';
  const lim = vertical ? BASE.coreHalf : BASE.half;
  for (let a = -lim + 20; a <= lim - 20; a += 2) {
    for (let d = 0; d <= 30; d += 2) {
      const off = band.at + band.dir * d;
      const r = vertical
        ? { x0: a - W / 2, x1: a + W / 2, z0: off, z1: off + D }
        : { x0: off, x1: off + D, z0: a - W / 2, z1: a + W / 2 };
      // 不压纵街/环道走廊
      if (r.x0 < CX + 2 && r.x1 > -(CX + 2)) continue;
      if (r.x0 < 106 && r.x1 > 94) continue;
      if (r.z0 < 106 && r.z1 > 94) continue;
      const hit = taken.find((t) => ov(r, t, 1.5));
      if (hit) continue;
      const cx = (r.x0 + r.x1) / 2;
      const cz = (r.z0 + r.z1) / 2;
      cands.push({
        x: cx,
        z: cz,
        band: band.name,
        frontZ: vertical ? (band.dir > 0 ? r.z0 : r.z1) : cz,
        frontX: vertical ? cx : (band.dir > 0 ? r.x0 : r.x1),
        axis: vertical ? 'z' : 'x',
        d,
      });
    }
  }
}

// 优先：离中心近 + 离路近
cands.sort((a, b) => Math.hypot(a.x, a.z) * 0.6 + a.d * 2 - (Math.hypot(b.x, b.z) * 0.6 + b.d * 2));
console.log(`临主干道空地候选：${cands.length} 个`);
for (const c of cands.slice(0, 18)) {
  const facing = c.axis === 'z' ? (c.frontZ < c.z ? '北' : '南') : c.frontX < c.x ? '西' : '东';
  console.log(
    `  x=${c.x.toFixed(0)}  z=${c.z.toFixed(0)}  ${c.band}  正面朝${facing}  距中心 ${Math.hypot(c.x, c.z).toFixed(0)}m  离路 ${c.d}m`,
  );
}

