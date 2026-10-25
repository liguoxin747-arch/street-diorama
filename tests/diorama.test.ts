import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import { BASE, BUILD_LINE, CONVOY_LANE, EDGE, HERO, HOTSPOTS, QUADRANTS, ROADS, ROAD, TOWN_PLOTS, ZONES,
  canPlace, groundYAt, hitsCarriageway } from '../src/world/layout';
import { LAMP_SPACING, planStreetlights } from '../src/world/streetlightPlan';

/**
 * 微缩景观的"布景规则"测试：
 * 随机源必须可复现，地块不能互相压盖、不能越出底座、不能压住主楼。
 */

describe('微缩景观随机源', () => {
  it('相同种子产生完全相同的序列', () => {
    const a = createRng(12345);
    const b = createRng(12345);
    const seqA = Array.from({ length: 16 }, () => a.next());
    const seqB = Array.from({ length: 16 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('不同种子产生不同序列', () => {
    const a = createRng('alpha');
    const b = createRng('beta');
    expect(a.next()).not.toBe(b.next());
  });

  it('取值始终落在指定区间内', () => {
    const rng = createRng(7);
    for (let i = 0; i < 500; i += 1) {
      const v = rng.range(-3, 5);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThan(5);
      const n = rng.int(2, 6);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(6);
    }
  });

  it('fork 派生的子序列互相独立且可复现', () => {
    const base = createRng('module');
    const first = base.fork(11);
    const second = base.fork(11);
    const other = base.fork(12);
    expect(first.next()).toBe(second.next());
    expect(first.next()).not.toBe(other.next());
  });

  it('shuffle 不改变元素集合', () => {
    const rng = createRng(99);
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const shuffled = rng.shuffle(items);
    expect(shuffled.slice().sort((x, y) => x - y)).toEqual(items);
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;
}

function insideBase(r: Rect): boolean {
  return r.x0 >= -BASE.half && r.x1 <= BASE.half && r.z0 >= -BASE.half && r.z1 <= BASE.half;
}

describe('总平面布局', () => {
  it('地块矩形方向正确且不越界', () => {
    for (const plot of TOWN_PLOTS) {
      expect(plot.x1).toBeGreaterThan(plot.x0);
      expect(plot.z1).toBeGreaterThan(plot.z0);
      expect(insideBase(plot)).toBe(true);
      expect(plot.floors).toBeGreaterThanOrEqual(1);
    }
  });

  it('地块之间互不重叠', () => {
    for (let i = 0; i < TOWN_PLOTS.length; i += 1) {
      for (let j = i + 1; j < TOWN_PLOTS.length; j += 1) {
        const a = TOWN_PLOTS[i];
        const b = TOWN_PLOTS[j];
        if (!a || !b) continue;
        expect(overlaps(a, b), `地块 ${i} 与 ${j} 重叠`).toBe(false);
      }
    }
  });

  it('除主楼外没有地块占用主楼占地', () => {
    const hero: Rect = { x0: HERO.x0, x1: HERO.x1, z0: HERO.z0, z1: HERO.z1 };
    for (const plot of TOWN_PLOTS) {
      expect(overlaps(plot, hero), `地块 ${plot.kind} 与主楼重叠`).toBe(false);
    }
  });

  it('地块不侵入人行道与车行道', () => {
    for (const plot of TOWN_PLOTS) {
      const clearOfAvenue =
        plot.z1 <= BUILD_LINE.avenueNorth + 0.001 || plot.z0 >= BUILD_LINE.avenueSouth - 0.001;
      const clearOfCross =
        plot.x1 <= BUILD_LINE.crossWest + 0.001 || plot.x0 >= BUILD_LINE.crossEast - 0.001;
      expect(clearOfAvenue || clearOfCross, `地块 ${plot.kind} 落在道路/人行道上`).toBe(true);
    }
  });

  it('道路与人行道尺寸自洽', () => {
    expect(EDGE.avenueNorth).toBe(-ROAD.avenueHalf);
    expect(EDGE.avenueSouth).toBe(ROAD.avenueHalf);
    expect(BUILD_LINE.avenueNorth).toBeLessThan(EDGE.avenueNorth);
    expect(BUILD_LINE.crossEast).toBeGreaterThan(EDGE.crossEast);
    expect(QUADRANTS.nw.x1).toBe(BUILD_LINE.crossWest);
    expect(QUADRANTS.se.x0).toBe(BUILD_LINE.crossEast);
  });

  it('主楼层高与檐口高度自洽', () => {
    const expected = HERO.groundHeight + HERO.upperHeight * (HERO.floors - 1);
    expect(HERO.eaveY).toBeCloseTo(expected, 6);
    expect(HERO.eaveY).toBeGreaterThan(9);
    expect(HERO.eaveY).toBeLessThan(14);
  });

  it('主楼街角正对路口', () => {
    expect(HERO.x0).toBe(ROAD.crossHalf + ROAD.sidewalk);
    expect(HERO.z1).toBe(-(ROAD.avenueHalf + ROAD.sidewalk));
  });
});

/* ------------------------------------------------------------------ *
 * 扩建后的路网与分区：净空契约必须在浏览器之前就成立
 * ------------------------------------------------------------------ */

describe('路网与分区净空契约', () => {
  const roads = ROADS;

  it('底座扩到 288，核心区仍是原来的 144', () => {
    expect(BASE.size).toBe(288);
    expect(BASE.half).toBe(144);
    expect(BASE.coreHalf).toBe(72);
  });

  it('每条路的两端都接在别的路上或底座边缘（禁止断头路）', () => {
    for (const r of roads) {
      for (const end of [r.from, r.to]) {
        const atEdge = Math.abs(Math.abs(end) - BASE.half) < 0.01;
        // 该端点上是否有另一条路与它相交（垂路覆盖这个坐标）
        const joined = roads.some(
          (o) =>
            o.id !== r.id &&
            o.axis !== r.axis &&
            o.at > end - 0.01 &&
            o.at < end + 0.01,
        );
        // 或者端点正好落在另一条贯穿路的走廊里（丁字）
        const tee = roads.some(
          (o) =>
            o.id !== r.id &&
            o.axis !== r.axis &&
            r.at >= o.from - 0.01 &&
            r.at <= o.to + 0.01 &&
            Math.abs(o.at - end) <= o.half + o.walk + 0.01,
        );
        expect(atEdge || joined || tee, `${r.id} 的端点 ${end} 是断头路`).toBe(true);
      }
    }
  });

  it('小镇地块一个都不压车行道', () => {
    for (const p of TOWN_PLOTS) {
      expect(hitsCarriageway(p, 0), `${p.kind} ${p.x0},${p.z0} 压了车道`).toBe(false);
    }
  });

  it('分区矩形不压车行道', () => {
    for (const z of ZONES) {
      expect(hitsCarriageway(z, 0), `${z.id} 压了车道`).toBe(false);
    }
  });

  it('车队车道完全走在纵街车行道里，并穿过哨卡缺口', () => {
    const cross = ROADS.find((r) => r.id === 'cross')!;
    expect(CONVOY_LANE.x0).toBeGreaterThan(cross.at - cross.half);
    expect(CONVOY_LANE.x1).toBeLessThan(cross.at + cross.half);
    expect(CONVOY_LANE.z1).toBeGreaterThan(BASE.half - 10); // 一直通到新边界
    // 哨卡缺口必须比车道宽
    expect(HOTSPOTS.outpostGap.x0).toBeLessThan(CONVOY_LANE.x0 - 6);
    expect(HOTSPOTS.outpostGap.x1).toBeGreaterThan(CONVOY_LANE.x1 + 6);
  });

  it('canPlace 拒绝压车道 / 压人行道 / 压既有建筑，放行合法空地', () => {
    expect(canPlace({ x0: -2, x1: 4, z0: -4, z1: 4 })).toBe(false); // 纵街车行道
    expect(canPlace({ x0: 12.5, x1: 20, z0: -12, z1: -6 })).toBe(false); // 压人行道与主楼
    expect(canPlace({ x0: -40, x1: -30, z0: 80, z1: 88 })).toBe(false); // 压既有地块
    expect(canPlace({ x0: -130, x1: -118, z0: 40, z1: 60 })).toBe(true); // 西境平民区空地
  });

  it('groundYAt：人行道高于车道，车道高于空地', () => {
    expect(groundYAt(10.5, 0)).toBeGreaterThan(groundYAt(3, 0)); // 人行道 vs 大道
    expect(groundYAt(3, 0)).toBeGreaterThan(groundYAt(-124, 40)); // 车道 vs 街区空地
  });
});

/* ------------------------------------------------------------------ *
 * 全图路灯：落位、损坏比例、车道净空都必须在浏览器之前成立
 * ------------------------------------------------------------------ */

describe('全图路灯规划', () => {
  const rng = createRng('streetlights-test');
  const plan = planStreetlights(rng.fork(1));

  it('沿全图路网生成足量路灯，且间距按 18 m 档位', () => {
    expect(LAMP_SPACING).toBe(18);
    expect(plan.length).toBeGreaterThan(60);
    for (const lamp of plan) {
      expect(Math.abs(lamp.tilt)).toBeLessThanOrEqual(Math.PI / 2 + 0.001);
    }
  });

  it('每盏灯都站在对应道路的人行道内缘，灯臂朝向车行道', () => {
    for (const lamp of plan) {
      const road = ROADS.find((r) => r.id === lamp.roadId);
      expect(road, `未知道路 ${lamp.roadId}`).toBeTruthy();
      const across = road!.axis === 'x' ? Math.abs(lamp.z - road!.at) : Math.abs(lamp.x - road!.at);
      expect(across).toBeGreaterThan(road!.half + 0.3);
      expect(across).toBeLessThan(road!.half + road!.walk - 0.1);
      // 灯臂局部 +Z 应指向道路中心：侧向取反与 yaw 的余弦同号
      const dir = road!.axis === 'x' ? Math.cos(lamp.yaw) : Math.sin(lamp.yaw);
      expect(Math.sign(dir)).toBe(-lamp.side);
    }
  });

  it('路口走廊、斑马线与铁路道口内没有灯杆', () => {
    for (const lamp of plan) {
      const road = ROADS.find((r) => r.id === lamp.roadId)!;
      const along = road.axis === 'x' ? lamp.x : lamp.z;
      for (const other of ROADS) {
        if (other.id === road.id || other.axis === road.axis) continue;
        if (other.from > road.at + 0.01 || other.to < road.at - 0.01) continue;
        expect(
          Math.abs(along - other.at),
          `${lamp.roadId} 的灯立在 ${other.id} 路口里`,
        ).toBeGreaterThanOrEqual(other.half + other.walk + 1.6 - 0.001);
      }
    }
  });

  it('约 20% 的路灯处于倾倒/倒地状态，倒地灯不参与真实灯池', () => {
    const damaged = plan.filter((l) => l.state === 'tilted' || l.state === 'fallen').length;
    const ratio = damaged / plan.length;
    expect(Math.abs(ratio - 0.2)).toBeLessThan(0.02);
    for (const lamp of plan) {
      if (lamp.state === 'fallen') {
        expect(lamp.live).toBe(false);
        expect(lamp.tilt).toBeCloseTo(Math.PI / 2, 5);
      } else {
        expect(lamp.live).toBe(true);
      }
    }
  });

  it('倒地灯杆的落地足迹不会截断车队车道', () => {
    for (const lamp of plan) {
      if (lamp.state !== 'fallen') continue;
      const towardRoad = -lamp.side;
      let x0: number;
      let x1: number;
      let z0: number;
      let z1: number;
      if (lamp.axis === 'x') {
        x0 = lamp.x - 6.2;
        x1 = lamp.x + 6.2;
        z0 = Math.min(lamp.z, lamp.z + towardRoad * 1.9);
        z1 = Math.max(lamp.z, lamp.z + towardRoad * 1.9);
      } else {
        z0 = lamp.z - 6.2;
        z1 = lamp.z + 6.2;
        x0 = Math.min(lamp.x, lamp.x + towardRoad * 1.9);
        x1 = Math.max(lamp.x, lamp.x + towardRoad * 1.9);
      }
      const hit =
        x0 < CONVOY_LANE.x1 &&
        x1 > CONVOY_LANE.x0 &&
        z0 < CONVOY_LANE.z1 &&
        z1 > CONVOY_LANE.z0;
      expect(hit, `倒地灯 ${lamp.roadId}(${lamp.x.toFixed(1)},${lamp.z.toFixed(1)}) 压住车队车道`).toBe(false);
    }
  });

  it('同一随机种子生成完全一致的路灯布置', () => {
    const again = planStreetlights(createRng('streetlights-test').fork(1));
    expect(again).toEqual(plan);
  });
});
