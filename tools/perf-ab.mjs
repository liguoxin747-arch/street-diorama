/**
 * 性能归因 A/B：分别关掉「灯 / 描边壳 / 阴影 / 透明件」测真实帧时，
 * 找出 27ms 里各占多少。只用于测量，不改场景内容（测完恢复）。
 *
 * node tools/perf-ab.mjs [--url=...]
 */
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const url = flag('url', process.env.DIORAMA_URL || 'http://127.0.0.1:4186/');
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--hide-scrollbars', '--window-size=1600,900', '--window-position=30,30',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
});

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', String(e).slice(0, 200)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 120000 });
  await new Promise((r) => setTimeout(r, 3500));

  const run = async (label, mutate, restore) => {
    const stat = await page.evaluate(
      async ({ mutateSrc, restoreSrc }) => {
        const d = window.__dioramaDebug;
        const { THREE, scene, renderer } = d;
        // 收集场景清单，供 mutate/restore 使用
        const lights = [];
        const outlines = [];
        const transparents = [];
        scene.traverse((o) => {
          if (o.isLight) lights.push(o);
          if (o.isMesh) {
            if (o.userData['isOutline'] || (o.material && o.material.side === THREE.BackSide && o.material.type === 'MeshBasicMaterial')) outlines.push(o);
            const m = o.material;
            if (m && !Array.isArray(m) && m.transparent) transparents.push(o);
          }
        });
        window.__perfLights = lights;
        window.__perfOutlines = outlines;
        window.__perfTransparents = transparents;
        // eslint-disable-next-line no-new-func
        new Function('d', 'lights', 'outlines', 'transparents', mutateSrc)(d, lights, outlines, transparents);

        const frames = [];
        await new Promise((resolve) => {
          let last = performance.now();
          let n = 0;
          const step = (now) => {
            const dt = now - last;
            last = now;
            if (n++ > 10) frames.push(dt);
            if (n > 110) resolve();
            else requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });
        const sorted = [...frames].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)] ?? 0;

        // eslint-disable-next-line no-new-func
        new Function('d', 'lights', 'outlines', 'transparents', restoreSrc)(d, lights, outlines, transparents);
        await new Promise((r) => setTimeout(r, 250));

        return {
          median: +median.toFixed(2),
          count: { lights: lights.length, outlines: outlines.length, transparents: transparents.length },
        };
      },
      { mutateSrc: mutate, restoreSrc: restore },
    );
    console.log(`${label.padEnd(24)} 帧时 ${String(stat.median).padStart(6)}ms → ${String(Math.round(1000 / Math.max(stat.median, 0.01))).padStart(3)}fps   ${JSON.stringify(stat.count)}`);
    return stat.median;
  };

  const base = await run('基线（全开）', '', '');

  await run(
    '关掉所有灯',
    `for (const l of lights) { l.visible = false; }`,
    `for (const l of lights) { l.visible = true; }`,
  );

  await run(
    '关掉描边壳',
    `for (const o of outlines) { o.visible = false; }`,
    `for (const o of outlines) { o.visible = true; }`,
  );

  await run(
    '关掉透明件',
    `for (const o of transparents) { o.visible = false; }`,
    `for (const o of transparents) { o.visible = true; }`,
  );

  await run(
    '关掉阴影',
    `d.renderer.shadowMap.enabled = false;`,
    `d.renderer.shadowMap.enabled = true; d.renderer.shadowMap.needsUpdate = true;`,
  );

  await run(
    '关灯+关描边+关透明',
    `for (const l of lights) l.visible = false; for (const o of outlines) o.visible = false; for (const o of transparents) o.visible = false;`,
    `for (const l of lights) l.visible = true; for (const o of outlines) o.visible = true; for (const o of transparents) o.visible = true;`,
  );

  console.log(`\n基线 ${base}ms（${Math.round(1000 / base)}fps）`);
} finally {
  await browser.close();
}
