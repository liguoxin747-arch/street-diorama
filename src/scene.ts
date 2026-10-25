import * as THREE from 'three';
import { createContext } from './core/context';
import { globalRng } from './core/rng';
import { Ticker } from './core/ticker';
import { createDayRig, type DayRig } from './core/dayCycle';
import { HOTSPOTS } from './world/layout';
import { createCustomVilla } from './world/villa';
import { buildBase, wetMaterials } from './world/base';
import { buildHeroBuilding } from './world/hero';
import { buildTown } from './world/town';
import { buildStreetProps } from './world/props';
import { buildVehicles } from './world/vehicles';
import { buildPeople } from './world/people';
import { buildPatrol } from './world/patrol';
import { buildDrone } from './world/drone';
import { buildExtras } from './world/extras';
import { buildQuarters } from './world/quarters';
import { buildIndustrial } from './world/industrial';
import { buildOutpost } from './world/outpost';
import { buildEdgeWaste, buildSkyline } from './world/skyline';
import { buildBorder } from './world/border';
import { buildFills } from './world/fill';
import { initInfrastructure } from './world/occupancy';
import { buildWindowSandbags } from './world/windowSandbags';
import { buildInteriorCards } from './world/interiorCards';
import { buildWindowLights } from './world/windowLights';
import { buildStreetlights } from './world/streetlights';
import { buildWarzone } from './world/warzone';
import { buildRain } from './fx/rain';
import { buildAtmosphere } from './fx/smoke';
import { buildLightSpills } from './fx/spill';
import { buildBattlefieldFx } from './fx/battlefield';

export interface DioramaScene {
  scene: THREE.Scene;
  ticker: Ticker;
  day: DayRig;
}

/** 把一帧让给浏览器：进度条、CSS 动画都靠它才能动 */
const yieldFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/**
 * 构建场景。
 *
 * **分阶段构建**：每个阶段结束后让出一帧。这样加载进度条是真进度，而不是
 * "先画一个 0% 然后卡住"——同步一次性构建时主线程被占满，任何 DOM 更新都不会重绘。
 * 代价是总耗时略增（每阶段一帧），换来用户始终能看到进度。
 */
export async function buildDiorama(
  quality = 1,
  onProgress?: (fraction: number, label: string) => void,
): Promise<DioramaScene> {
  const scene = new THREE.Scene();
  const ticker = new Ticker();
  const ctx = createContext(scene, globalRng, ticker, quality);

  // 昼夜装置：天空穹顶、半球光、主平行光（含阴影相机）、雾
  // 主光保持白色，色温交给着色器的 uSunColor，阴面环境色才能独立变化
  initInfrastructure();
  const day = createDayRig(scene, quality);
  day.bindWet(wetMaterials());

  const steps: Array<[string, () => void]> = [
    ['底座与路网', () => ctx.add(buildBase(ctx))],
    ['主楼（街角三层）', () => ctx.add(buildHeroBuilding(ctx))],
    ['街区建筑（战损立面）', () => ctx.add(buildTown(ctx))],
    ['街道道具', () => ctx.add(buildStreetProps(ctx))],
    ['载具', () => ctx.add(buildVehicles(ctx))],
    ['居民', () => ctx.add(buildPeople(ctx))],
    ['巡逻与无人机', () => {
      ctx.add(buildPatrol(ctx));
      ctx.add(buildDrone(ctx));
      ctx.add(buildExtras(ctx));
    }],
    ['密集平民区', () => ctx.add(buildQuarters(ctx))],
    ['废弃工业区', () => ctx.add(buildIndustrial(ctx))],
    ['前沿军事哨卡', () => ctx.add(buildOutpost(ctx))],
    ['边缘废墟与远景剪影', () => {
      ctx.add(buildEdgeWaste(ctx));
      ctx.add(buildSkyline(ctx));
    }],
    ['边缘伪装（林带 / 路尽头 / 体雾）', () => ctx.add(buildBorder(ctx))],
    ['空地填充（营地 / 残骸 / 路障）', () => ctx.add(buildFills(ctx))],
    // 定制乡村别墅：临大道南侧，正面朝北面向主干道（位置读 layout 的 HOTSPOTS.villa）
    ['定制乡村别墅（临大道）', () => ctx.add(createCustomVilla(ctx, HOTSPOTS.villa))],
    ['窗台沙袋', () => ctx.add(buildWindowSandbags(ctx))],
    ['暗窗（一栋样板）', () => ctx.add(buildInteriorCards(ctx))],
    ['窗光（生活暖光 / 战火）', () => ctx.add(buildWindowLights(ctx))],
    ['全图路灯（含倒塌与短路）', () => ctx.add(buildStreetlights(ctx))],
    ['战争废墟扩建（剖切楼 / 地陷 / 遗物 / 植被 / 贴花）', () => buildWarzone(ctx)],
    ['雨幕与积水', () => {
      buildRain(ctx);
      buildLightSpills(ctx);
    }],
    ['硝烟与火光', () => buildAtmosphere(ctx)],
    ['照明弹与短路火花', () => ctx.addFx(buildBattlefieldFx(ctx))],
  ];

  const tBuild = performance.now();
  for (let i = 0; i < steps.length; i += 1) {
    const [label, run] = steps[i]!;
    const t0 = performance.now();
    run();
    console.info(`[build] ${label} ${Math.round(performance.now() - t0)}ms`);
    onProgress?.(i / steps.length, label);
    await yieldFrame();
  }
  onProgress?.(1, '就绪');
  console.info(`[build] total ${Math.round(performance.now() - tBuild)}ms`);
  return { scene, ticker, day };
}
