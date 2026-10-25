/**
 * 战争废墟层专项验收：废墟统计 / 局部灯 / 粒子场 / 照明弹爆闪 / 短路火花频闪。
 *
 * 用法：node tools/war-audit.mjs [--day=0] [--url=http://127.0.0.1:4175/]
 *
 * 与通用 audit.mjs 的分工：audit.mjs 管全图几何越界与帧时，这里只管"新加的这套
 * 动效到底有没有真的在动"——照明弹与火花都是瞬时事件，必须靠采样时间序列才能证明。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const url = flag('url', 'http://127.0.0.1:4175/');
const dayAt = Number(flag('day', '0'));
const outDir = resolve('tests/out');
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

await mkdir(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  // 采样类 evaluate 会在页面里跑满整个事件周期，默认 180s 的协议超时会误伤
  protocolTimeout: 600000,
  args: [
    '--no-sandbox',
    '--hide-scrollbars',
    '--use-angle=default',
    '--ignore-gpu-blocklist',
    // 被遮挡的窗口会被 Chrome 降频到 1fps，构建里的 yieldFrame 就再也不返回
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--window-size=1600,900',
    '--window-position=30,30',
  ],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 120000 });

  await page.evaluate((t) => {
    window.__dioramaDebug.setDayTime(t);
    window.__dioramaDebug.freezeDay();
    window.__setView?.(45, 32, 96, 0, 4, 0);
  }, dayAt);
  await new Promise((r) => setTimeout(r, 4000));

  /* ---------------- 静态清单 ---------------- */
  console.log('[war-audit] 采集静态清单…');
  const inventory = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    const warzone = d.scene.getObjectByName('warzone');
    const lights = [];
    const fields = [];
    d.scene.traverse((o) => {
      if (o.isPointLight) {
        lights.push({
          name: o.name || '(未命名)',
          pos: [+o.position.x.toFixed(1), +o.position.y.toFixed(1), +o.position.z.toFixed(1)],
          intensity: +o.intensity.toFixed(2),
          distance: o.distance,
        });
      }
      if (o.isPoints && /fx-/.test(o.name || '')) {
        const range = o.geometry.drawRange.count;
        fields.push({ name: o.name, live: Number.isFinite(range) ? range : o.geometry.getAttribute('position').count });
      }
    });
    const byName = (n) => lights.find((l) => l.name === n) ?? null;
    // 战争层新增的六盏实体灯（剖切楼×2 / 油桶 / 照明弹 / 弹坑灯 / 防空洞）
    const WAR_POS = [
      [31.5, 4, 43.3],
      [73.1, 4, -25.3],
      [27.4, 1.2, 52.3],
      [-39.8, 0.4, -3.2],
      [-49.2, 2.6, -3.8],
      [50.5, 2.3, -9.3],
    ];
    return {
      stats: warzone?.userData?.warzone ?? null,
      pointLights: lights.length,
      maxPointLights: 39,
      flareLight: byName('fx-flare-light'),
      sparkLight: byName('fx-spark-light'),
      warzoneLights: lights.filter(
        (l) => /flare|spark/i.test(l.name) || WAR_POS.some((p) => p.every((v, i) => Math.abs(v - l.pos[i]) < 0.35)),
      ),
      fields: fields.filter((f) => /smoke|spark/.test(f.name)),
    };
  });

  /* ---------------- 火花频闪：3 秒时间序列 ---------------- */
  console.log('[war-audit] 采样火花频闪 3s…');
  const sparkSeries = await page.evaluate(() =>
    new Promise((res) => {
      const light = window.__dioramaDebug.scene.getObjectByName('fx-spark-light');
      const pts = [];
      const t0 = performance.now();
      const step = () => {
        pts.push(+light.intensity.toFixed(2));
        if (performance.now() - t0 > 3000) res(pts);
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }));

  /* ---------------- 照明弹：触发 + 峰值采样 + 出图 ---------------- */
  await page.screenshot({ path: `${outDir}/war-audit-flare-off.png` });
  console.log('[war-audit] 触发照明弹并采样 7s…');
  const flareSeries = await page.evaluate(() =>
    new Promise((res) => {
      const d = window.__dioramaDebug;
      const light = d.scene.getObjectByName('fx-flare-light');
      const pts = [];
      d.warFx.triggerFlare();
      const t0 = performance.now();
      let peak = 0;
      let peakAt = 0;
      const step = () => {
        const i = light.intensity;
        pts.push({ t: +((performance.now() - t0) / 1000).toFixed(2), i: +i.toFixed(1), y: +light.position.y.toFixed(1) });
        if (i > peak) {
          peak = i;
          peakAt = (performance.now() - t0) / 1000;
        }
        if (performance.now() - t0 > 7000) res({ pts, peak, peakAt, active: d.warFx.isFlareActive() });
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }));
  // 峰值附近再出一张图（照明弹下落 6.2s，采样已走完，这里补一颗并抓中段）
  await page.evaluate(() => window.__dioramaDebug.warFx.triggerFlare());
  await new Promise((r) => setTimeout(r, 2400));
  await page.screenshot({ path: `${outDir}/war-audit-flare-on.png` });
  const flareMid = await page.evaluate(() => {
    const light = window.__dioramaDebug.scene.getObjectByName('fx-flare-light');
    return { intensity: +light.intensity.toFixed(1), y: +light.position.y.toFixed(1) };
  });

  const sparkMin = Math.min(...sparkSeries);
  const sparkMax = Math.max(...sparkSeries);
  const verdict = {
    剖切楼: (inventory.stats?.cutaways ?? 0) === 2,
    地陷水坑: (inventory.stats?.sinkholes ?? 0) === 1,
    路面断裂: (inventory.stats?.fractures ?? 0) === 2,
    废墟堆: (inventory.stats?.rubblePiles ?? 0) === 2,
    防空洞: (inventory.stats?.bunker ?? 0) === 1,
    遗弃车辆: (inventory.stats?.abandonedCars ?? 0) === 1,
    贴花: (inventory.stats?.decals ?? 0) > 300,
    草丛: (inventory.stats?.grass ?? 0) > 400 && (inventory.stats?.weeds ?? 0) > 100,
    毒烟粒子: (inventory.fields.find((f) => f.name === 'fx-smoke-toxic')?.live ?? 0) >= 24,
     wreck白烟: (inventory.fields.find((f) => f.name === 'fx-smoke-wreck')?.live ?? 0) >= 20,
    火花粒子: (inventory.fields.find((f) => f.name === 'fx-short-sparks')?.live ?? 0) >= 96,
    火花频闪: sparkMax > sparkMin * 3,
    照明弹爆闪: flareSeries.peak > 800 && flareSeries.pts.some((p) => p.y < 60),
    灯数未超预算: inventory.pointLights <= inventory.maxPointLights,
  };

  const report = {
    day: dayAt,
    inventory,
    spark: { min: sparkMin, max: sparkMax, samples: sparkSeries.length },
    flare: { peak: +flareSeries.peak.toFixed(1), peakAt: +flareSeries.peakAt.toFixed(2), mid: flareMid, samples: flareSeries.pts.length },
    verdict,
    failed: Object.entries(verdict).filter(([, ok]) => !ok).map(([k]) => k),
    consoleErrors: errors,
  };
  await writeFile(`${outDir}/war-audit.json`, JSON.stringify(report, null, 2), 'utf8');

  console.log(`废墟统计：${JSON.stringify(inventory.stats)}`);
  console.log(`点光：${inventory.pointLights}/${inventory.maxPointLights}  照明弹=${JSON.stringify(inventory.flareLight)}  火花=${JSON.stringify(inventory.sparkLight)}`);
  console.log(`战争层灯位：${inventory.warzoneLights.map((l) => `${l.name}@${l.pos.join('/')}:${l.intensity}`).join('  ')}`);
  console.log(`粒子场：${inventory.fields.map((f) => `${f.name}=${f.live}`).join('  ')}`);
  console.log(`火花强度：min=${sparkMin} max=${sparkMax}（${sparkSeries.length} 采样）`);
  console.log(`照明弹：峰值 ${report.flare.peak} @${report.flare.peakAt}s，中段 ${JSON.stringify(flareMid)}`);
  console.log(`判定：${Object.entries(verdict).map(([k, ok]) => `${ok ? '✓' : '✗'}${k}`).join('  ')}`);
  console.log(`console 异常：${errors.length}`);
  errors.slice(0, 5).forEach((e) => console.log('  ' + e.slice(0, 200)));
  console.log(`报告：tests/out/war-audit.json`);
} finally {
  await browser.close();
}
