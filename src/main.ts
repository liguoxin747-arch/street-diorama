import * as THREE from 'three';
import { buildDiorama } from './scene';
import { createCamera } from './core/camera';
import { createPost } from './core/post';
import { setLightConeViewer } from './fx/lightCone';
import { updateOutlineAspect } from './core/materials';
import { BASE, CONVOY_LANE, allCarriageways, allCorridors } from './world/layout';
import { DAY } from './core/dayState';
import { createDaySlider } from './ui/timeSlider';
import { optimizeStaticOutlines } from './core/optimize';
import { createViewMode } from './ui/viewMode';
import { createColliderDebug } from './ui/colliderDebug';
import { createLoading } from './ui/loading';
import { auditOccupancy, claims } from './world/occupancy';
import { consumeStreetlightShadowDirty, setStreetlightViewer } from './world/streetlights';
import { flareActive, triggerFlare } from './fx/battlefield';

/**
 * 微缩景观入口：全屏画布 + 轨道相机 + 后期，屏幕上没有任何 UI 元素。
 */

const container = document.getElementById('diorama-root');
if (!container) throw new Error('缺少 #diorama-root 容器');
const host: HTMLElement = container;

const renderer = new THREE.WebGLRenderer({
  // 抗锯齿交给后期链的 FXAA：画面最终是从 composer 的 RT 合成出来的，
  // 默认帧缓冲上的 MSAA 对那条路径基本是白付的显存与解析开销。
  antialias: false,
  powerPreference: 'high-performance',
  stencil: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
// 三渲二要的是干净利落的硬阴影：PCFSoft 会把明暗交界糊成渐变
renderer.shadowMap.type = THREE.PCFShadowMap;
// 场景大部分是静态的：阴影贴图只算一次，省掉每帧的 shadow pass（几何翻倍后这是最大开销）
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.52;
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

async function boot(): Promise<void> {
  const loading = createLoading(host);
  loading.set(0, '准备');

  // 构建阶段只占进度条的前 92%：剩下 8% 留给"渲染管线 + 着色器编译 + 首帧"。
  // 之前进度条直接按构建步数走满，而建完之后还要编译整套着色器（本机约 9 秒），
  // 那段时间遮罩已经淡出、画布还是空的 —— 表现就是"读完条之后黑屏一阵"。
  const quality = window.innerWidth * window.innerHeight > 2600000 ? 0.75 : 1;
  const { scene, ticker, day } = await buildDiorama(quality, (fraction, label) =>
    loading.set(fraction * 0.92, label),
  );

// 场景传入相机：相机避让需要从场景里扫"实心格"（扩建建筑不在登记表里）
const tBoot = performance.now();
const mark = (label: string): void => {
  console.info(`[boot] 计时 ${label} ${Math.round(performance.now() - tBoot)}ms`);
};
const orbit = createCamera(renderer.domElement, window.innerWidth, window.innerHeight, scene);
mark('相机');
const post = createPost(renderer, scene, orbit.camera, window.innerWidth, window.innerHeight);
mark('后期管线');

// 光柱按『灯到相机距离』淡出，相机建好后注入观察者
setLightConeViewer(orbit.camera);
// 路灯真实灯池按视线焦点动态分配，同样需要相机
setStreetlightViewer(orbit.camera);

// 昼夜装置接管渲染器曝光、后期分级与天空；穹顶跟随相机以始终包住生成边缘
day.bindRenderer(renderer);
day.bindPost(post);
day.bindCamera(orbit.camera);
mark('昼夜绑定');

// 时间滑条：默认不可见（visibility:hidden），鼠标靠近底边或按 H 才浮现
createDaySlider(day, host);

// 双视角：V 键在自由俯瞰与第一人称之间切换（带平滑过渡）
const view = createViewMode({ orbit, post, dom: renderer.domElement, host, scene });
mark('第一人称装置');

// 碰撞体可视化：M 键切换（橙色=建筑与停置物，青色=空地填充物）
const colliderDebug = createColliderDebug(scene, () => view.debugRects());
mark('碰撞可视化');
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM') colliderDebug.toggle();
});

const clock = new THREE.Clock();

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  orbit.setSize(w, h);
  post.setSize(w, h);
  updateOutlineAspect(w / h);
}
window.addEventListener('resize', resize);
updateOutlineAspect(window.innerWidth / window.innerHeight);

// 触屏双指缩放由 OrbitControls 处理；禁用右键菜单以便右键平移
renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());

let paused = false;

function frame(): void {
  const delta = Math.min(clock.getDelta(), 0.06);
  if (!paused) {
    ticker.update(delta);
    // 灯池换位后阴影贴图必须重烘一次；renderer.shadowMap.autoUpdate 是关的
    if (consumeStreetlightShadowDirty()) renderer.shadowMap.needsUpdate = true;
    if (view.mode === 'orbit') orbit.update(delta);
    else view.update(delta);
    day.update(delta);
    post.render(delta);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// 就绪标志延后到进度条淡出之后再置（见文件末尾）

// 调试探针（只读，用于自动化验收统计 draw call / 三角面 / 相机位置）
(window as unknown as { __dioramaDebug?: unknown }).__dioramaDebug = {
  THREE,
  renderer,
  scene,
  camera: orbit.camera,
  controls: orbit.controls,
  view,
  colliderDebug,
  /** 空间占位系统：只读快照 + 全量自检 */
  occupancy: { claims, audit: auditOccupancy },
  ticker,
  post,
  day,
  /** 战场光照事件：照明弹可手动触发，验收脚本用它校准爆闪帧 */
  warFx: { triggerFlare, isFlareActive: flareActive },
  /** 底座尺寸：审计脚本据此判断越界，不再硬编码坐标 */
  base: BASE,
  /** 昼夜共享 uniform 引用：审计脚本据此做功能性验证 */
  dayUniforms: DAY,
  /** 路网净空契约：审计工具据此检查，不再各处硬编码坐标 */
  layout: { carriageways: allCarriageways(), corridors: allCorridors(), convoyLane: CONVOY_LANE },
  setPaused(value: boolean) {
    paused = value;
  },
  /** 昼夜调试：t∈[0,1)，0=深夜 0.25=拂晓 0.5=正午 0.75=黄昏 */
  setDayTime(t: number) {
    day.setTime(t);
  },
  freezeDay() {
    day.dayLength = 0;
  },
  renderDirect() {
    renderer.setRenderTarget(null);
    renderer.render(scene, orbit.camera);
  },
};

/**
 * 自动化截图用的相机机位接口（不影响正常交互，也不产生任何 UI）。
 * 仅调试/验收脚本调用。
 */
(window as unknown as {
  __setView?: (azimuthDeg: number, elevationDeg: number, distance: number, tx?: number, ty?: number, tz?: number) => void;
}).__setView = (azimuthDeg, elevationDeg, distance, tx = 7, ty = 5, tz = -9) => {
  view.toOrbit();
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  orbit.controls.autoRotate = false;
  orbit.controls.target.set(tx, ty, tz);
  orbit.camera.position.set(
    tx + Math.cos(el) * Math.sin(az) * distance,
    ty + Math.sin(el) * distance,
    tz + Math.cos(el) * Math.cos(az) * distance,
  );
  orbit.camera.lookAt(orbit.controls.target);
  orbit.controls.update();
};

  // —— 编译 + 首帧上屏，全程保持遮罩 ——
  // 读条结束后那段黑屏的来源：条的进度只代表**场景建完**，之后还要
  //   ① 首次把 WebGL 画布交给合成器（本机十几秒）
  //   ② 首帧一次性上传贴图/几何、链接程序
  //   ③ 首帧把阴影贴图烘一遍（太阳 2048² + 路灯池 4×512²，与视口无关）
  // 这几段都发生在遮罩淡出之后，所以看起来就是"条走完了、屏幕黑着"。
  // 现在的顺序：遮罩不撤 → 编译 → 首帧（先不烘阴影）→ 等它真正上屏 → 才撤遮罩 → 再补阴影。
  loading.busy('编译着色器');
  mark('设进度条');
  // 这里**不能**用 requestAnimationFrame 让步：首次把画布交给合成器的那一帧要十几秒，
  // 等 rAF 等于白等一场。用宏任务让出即可。
  await new Promise((resolve) => setTimeout(resolve, 0));
  mark('让出一帧');

  const tCompile = performance.now();
  renderer.compile(scene, orbit.camera);
  console.info(`[boot] 着色器编译 ${Math.round(performance.now() - tCompile)}ms`);

  // —— 首帧 ——
  // 首帧要一次性上传全部贴图/几何并链接程序，本机（软件渲染）约十几秒，整段占住主线程，
  // 任何百分比都刷不出来 —— 所以进度条在这段切到合成器线程驱动的流动动画（看起来"还在动"）。
  // 不再做"先小分辨率预热"：上传成本与视口无关，省不下时间，反而要反复改尺寸。
  // 首帧先不烘阴影（阴影 pass 与视口无关，84 万面要重画五六遍）。
  renderer.shadowMap.needsUpdate = false;
  loading.busy('首帧');
  const tFirst = performance.now();
  post.render(0);
  console.info(`[boot] 首帧 ${Math.round(performance.now() - tFirst)}ms`);

  // 等这一帧真正被合成上屏：一次 rAF 是绘制，再一次是提交给合成器。
  // 不等的话，撤遮罩的一瞬间画面还是空的 —— 那就是"闪黑"。
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
  mark('首帧上屏');

  // 进度条淡出并从 DOM 移除之后再置"已就绪"：
  // 验收脚本看到 ready 时，屏幕上确实没有任何 UI 元素。
  loading.done();
  window.setTimeout(() => {
    (window as unknown as { __dioramaReady?: boolean }).__dioramaReady = true;
  }, 520);

  // 遮罩淡出（420ms）之后再把阴影补上：这时画面已经可见，阴影晚到一帧不会闪黑，
  // 但能省掉"等阴影烘完才出画面"的那段等待。
  window.setTimeout(() => {
    renderer.shadowMap.needsUpdate = true;
  }, 700);

  // 静态描边壳合批：等动画跑几帧后再判定"哪些会动"，只合并真正静止的。
  // 放在 ready 之后，避免拖慢首屏；合并本身一次性、几毫秒。
  window.setTimeout(() => {
    void optimizeStaticOutlines(scene)
      .then((stats) => {
        (window as unknown as { __optimizeStats?: unknown }).__optimizeStats = stats;
      })
      .catch((err) => console.warn('[optimize] 跳过静态合并：', err));
  }, 2200);
}

void boot();
