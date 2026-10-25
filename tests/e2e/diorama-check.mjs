/**
 * 微缩景观端到端验收（npm run test:e2e）
 *
 * 前置：先启动服务 `npx vite --port 4175`（或用 DIORAMA_URL 指定）。
 * 检查项：
 *   1. 页面无 JS 异常，`__dioramaReady` 为真
 *   2. 场景确实渲染出内容（模型覆盖率、亮度层次、暖色像素）
 *   3. 动效在推进（ticker 累计时间增长、连续两帧像素不同）
 *   4. 统计 draw call / 三角面（性能预算）
 *   5. 从 4 个固定机位截图，供人工比对
 */
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const url = process.env.DIORAMA_URL || 'http://127.0.0.1:4175/';
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const outDir = resolve('tests/e2e/out');
const views = [
  ['diorama-hero', [212, 16, 44, 22, 6, -20]],
  ['diorama-corner', [196, 24, 78, 10, 4, -6]],
  ['diorama-wide', [205, 40, 132, 0, 3, -4]],
  ['diorama-street', [196, 13, 36, 6, 1.8, -6]],
];

const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

await mkdir(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  // 窗口被遮挡时 Chrome 把 rAF 降到 1fps，构建里的 yieldFrame 再也不返回 → 就绪超时
  args: ['--no-sandbox', '--hide-scrollbars', '--window-size=1600,900', '--window-position=30,30', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 30000 });
  // 就绪门：分帧生成的贴图/远景带会让前几秒的 draw call 与几何数持续变化，
  // 不等待稳定就采样，量到的是"构建中"的画面（同一份代码能测出 1051 与 1281 两种结果）。
  await page.waitForFunction(
    () => {
      const d = window.__dioramaDebug;
      const info = d.renderer.info;
      // 只用几何数与 draw call 判稳：把 ticker.time 放进比较串里永远不相等
      const now = `${info.memory.geometries}/${info.render.calls}`;
      const prev = window.__readyProbe;
      window.__readyProbe = now;
      return prev === now && d.ticker.time > 3;
    },
    { timeout: 90000, polling: 900 },
  );
  await new Promise((r) => setTimeout(r, 2500));

  check(errors.length === 0, '页面无 console/page 异常', errors.slice(0, 3).join(' | '));

  // —— 渲染统计 ——
  const info = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    const { renderer, scene, camera } = d;
    let meshes = 0;
    let triangles = 0;
    const byGroup = {};
    scene.traverse((o) => {
      if (o.isMesh) {
        meshes += 1;
        const g = o.geometry;
        triangles += (g.index ? g.index.count : g.getAttribute('position')?.count ?? 0) / 3;
        let root = o;
        while (root.parent && root.parent !== scene) root = root.parent;
        const key = root.name || root.type;
        byGroup[key] = (byGroup[key] ?? 0) + 1;
      }
    });
    return {
      meshes,
      triangles: Math.round(triangles),
      drawCalls: (() => {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
        return renderer.info.render.calls;
      })(),
      programs: renderer.info.programs?.length ?? 0,
      byGroup,
      ticker: d.ticker.time,
    };
  });
  console.log(`统计：mesh=${info.meshes} 三角面=${info.triangles} drawCall=${info.drawCalls} program=${info.programs}`);
  console.log(`分组：${JSON.stringify(info.byGroup)}`);

  check(info.meshes > 400, '场景对象数量充足（> 400 个 mesh）', `实际 ${info.meshes}`);
  check(info.triangles > 60000, '几何细节量充足（> 60k 三角面）', `实际 ${info.triangles}`);
  check(info.drawCalls > 0 && info.drawCalls < 1600, 'draw call 在预算内（< 1600）', `实际 ${info.drawCalls}`);

  // —— 画面内容检查：走"真实截图 + analyze_shot"通道（与 test:day 一致）——
  // 早先用 readPixels 直接读原始渲染，量到的是未经泛光/移轴/色调映射的画面；
  // 这条通道本身没问题，但它测的不是你看到的最终画面，且暖色在广角机位本就极低。
  const measure = (file) => {
    const out = execFileSync('python', ['tools/analyze_shot.py', file, '--cols=40', '--rows=12'], { encoding: 'utf8' });
    const num = (re) => Number((out.match(re) || [0, 'NaN'])[1]);
    return {
      mean: num(/luminance : mean=([\d.]+)/),
      p50: num(/p50=([\d.]+)/),
      p95: num(/p95=([\d.]+)/),
      bright: num(/bright frac\(>0\.45\): ([\d.]+)/),
      dark: num(/dark frac : ([\d.]+)/),
      warm: num(/warm px\s+: ([\d.]+)/),
    };
  };
  const shot = async (file, view) => {
    if (view) {
      await page.evaluate((v) => window.__setView(v[0], v[1], v[2], v[3], v[4], v[5]), view);
      await new Promise((r) => setTimeout(r, 1800));
    }
    await page.screenshot({ path: file });
    return measure(file);
  };

  // 像素门槛必须在"冻结的深夜 t=0"下测：昼夜钟在跑时，同一条断言量到的是
  // "深夜 13 秒"那种夜/拂晓混合相位，门槛怎么标都会偶发失败。
  await page.evaluate(() => {
    window.__dioramaDebug.setDayTime(0);
    window.__dioramaDebug.freezeDay();
  });
  await new Promise((r) => setTimeout(r, 900));

  const pixel = await shot('tests/e2e/out/e2e-frame.png', null);
  // 暖色焦点在主楼近景判定（广角下一扇窗只有几个像素，量的是缩放比例）
  const heroPixel = await shot('tests/e2e/out/e2e-hero.png', [205, 20, 88, 12, 6, -18]);
  // 恢复默认机位，后面的动效检查不再依赖取景
  await page.evaluate(() => window.__setView(205, 34, 300, 0, 0, 0));
  await new Promise((r) => setTimeout(r, 600));

  const coverage = +(1 - pixel.dark).toFixed(3);
  console.log(
    `画面：模型占比≈${coverage} 平均亮度=${pixel.mean} 高光=${pixel.bright} 暖色(广角)=${pixel.warm} 暖色(近景)=${heroPixel.warm}`,
  );

  // —— 门槛标定依据（2026-10-23 全局压暗后重标）——
  // 光照基调改为"环境只给轮廓、亮度全部交给局部灯"：冻结深夜 t=0 实测
  //   默认机位 mean=0.047 dark=0.765 p50=0.027 p95=0.162 bright=0.005 warm=0.0066
  //   主楼近景 mean=0.037 dark=0.756 warm=0.0054
  //   正午同机位 mean=0.136 dark=0.161（说明昼夜差是拉开的，不是整体调暗一档）
  // 因此：
  //  · "非黑像素"不能再要求 50%——夜空本来就该是黑的。这条的用处是抓"整屏画空了"：
  //    实测 0.18（黑位密度降下来之后从 0.235 掉到 0.18，是量纲变了不是画坏了），取 0.15。
  //    纯黑画布在这条上量到 ≈0.00，离门槛还差一个数量级，抓失效仍然锋利。
  //  · 同时新增"夜空确实压住了"的上限 mean<0.10，防止哪天又把全局环境光抬回去。
  //  · "高光层次"从 5% 降到 0.05%：夜里高亮只属于灯与火，且火星/余烬是瞬态的
  //    （同一机位两次实测 bright=0.005 与 0.001），所以这条只当"有没有过曝芯"的下限，
  //    真正判"扁不扁平"交给下面的 p95/p50 对比度门槛。
  //  · 新增对比度门槛 p95 > 2.5×p50（实测 6.0×），这条才是"扁平 / 发灰"的直接反证。
  check(coverage > 0.15, '模型在暗背景里仍读出主体（非黑像素 > 15%）', `实际 ${coverage}`);
  check(pixel.mean > 0.02 && pixel.mean < 0.1, '深夜整体压住且未死成一片纯黑', `实际 ${pixel.mean}`);
  check(pixel.p95 > pixel.p50 * 2.5, '夜里有高对比层次（p95 > 2.5×p50）', `p50=${pixel.p50} p95=${pixel.p95}`);
  check(pixel.bright > 0.0005, '存在灯/火的高光过曝芯（> 0.05% 亮部）', `实际 ${pixel.bright}`);
  // 门槛依据：夜里暖光只由窗光、哨卡篝火、T-72 余烬与路灯光池承担（行进军车队已删）。
  // 压暗 + 光柱淡出之后，主楼近景暖光实测 0.0053~0.0054，取 0.0035 留约 35% 余量。
  check(heroPixel.warm > 0.0035, '存在暖色火光/灯光（近景判定）', `实际 ${heroPixel.warm}`);

  // —— 动效在推进 ——
  const motion = await page.evaluate(async () => {
    const d = window.__dioramaDebug;
    const { renderer, scene, camera } = d;
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const bw = 160;
    const bh = 160;
    const x0 = Math.floor(w / 2 - bw / 2);
    const y0 = Math.floor(h * 0.42);
    const grab = () => {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      const buf = new Uint8Array(bw * bh * 4);
      gl.readPixels(x0, y0, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return buf;
    };
    d.setPaused(false);
    const t0 = d.ticker.time;
    const a = grab();
    await new Promise((r) => setTimeout(r, 700));
    const b = grab();
    const t1 = d.ticker.time;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) diff += 1;
    return { t0, t1, diff, samples: a.length };
  });
  check(motion.t1 - motion.t0 > 0.4, '时间驱动在推进', `t: ${motion.t0.toFixed(2)} → ${motion.t1.toFixed(2)}`);
  check(motion.diff > 200, '画面存在动态变化（动效生效）', `差异字节 ${motion.diff}/${motion.samples}`);

  await page.evaluate(() => window.__dioramaDebug.setPaused(false));

  // —— 多机位截图 ——
  for (const [name, view] of views) {
    await page.evaluate((v) => window.__setView(v[0], v[1], v[2], v[3], v[4], v[5]), view);
    await new Promise((r) => setTimeout(r, 1400));
    await page.screenshot({ path: resolve(outDir, `${name}.png`) });
    console.log(`saved ${name}.png`);
  }

  if (errors.length) console.log('console errors:', errors.slice(0, 5));
  console.log(failures.length === 0 ? '\n全部检查通过 ✅' : `\n${failures.length} 项失败 ❌：${failures.join(', ')}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
} finally {
  await browser.close();
}
