/**
 * 遮挡定位：在某个"变黑"的机位下，逐个隐藏顶层组，找出是哪个组糊住了镜头。
 * 隐藏后亮度恢复 → 那个组就是遮挡源。
 *
 * node tools/occlusion-hunt.mjs [--az=90] [--h=45] [--dist=80] [--target=8,5,-9]
 */
import puppeteer from 'puppeteer-core';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const url = flag('url', process.env.DIORAMA_URL || 'http://127.0.0.1:4181/');
const az = Number(flag('az', '90')) * Math.PI / 180;
const h = Number(flag('h', '45'));
const dist = Number(flag('dist', '80'));
const target = flag('target', '8,5,-9').split(',').map(Number);
const py = 'C:\\Users\\yuukiasuna\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--hide-scrollbars', '--window-size=900,650', '--window-position=20,20'],
  defaultViewport: { width: 900, height: 650 },
});

const shot = async (page, file) => {
  await new Promise((r) => setTimeout(r, 420));
  await page.screenshot({ path: file });
  let out = '';
  try {
    out = execFileSync(py, ['tools/analyze_shot.py', file, '--cols=8', '--rows=4'], { encoding: 'utf8' });
  } catch (e) {
    out = String(e.stdout ?? '');
  }
  return Number(/luminance\s*:\s*mean=([\d.]+)/.exec(out)?.[1] ?? 0);
};

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', String(e).slice(0, 160)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 40000 });
  await new Promise((r) => setTimeout(r, 1800));

  // 列出"被怀疑的那组"的子组：从上一次结果看嫌疑在 diorama-root，这里深挖一层
  const groups = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    const parentName = window.__huntParent ?? 'diorama-root';
    const parent = d.scene.children.find((c) => (c.name || c.type) === parentName) ?? d.scene;
    return parent.children
      .map((c) => c.name || c.type)
      .filter((n) => !/Light$|Helper$/.test(n));
  });

  // 先测基准
  const setCam = () => page.evaluate(
    ({ az, h, dist, t }) => {
      const d = window.__dioramaDebug;
      d.setPaused(false);
      d.controls.autoRotate = false;
      const horiz = Math.cos(0.31) * dist;
      d.camera.position.set(t[0] + Math.sin(az) * horiz, h, t[2] + Math.cos(az) * horiz);
      d.controls.target.set(t[0], t[1], t[2]);
      d.camera.lookAt(t[0], t[1], t[2]);
    },
    { az, h, dist, t: target },
  );

  await setCam();
  const base = await shot(page, 'tests/out/black/hunt-base.png');
  console.log(`基准亮度 ${base}（方位 ${Math.round((az * 180) / Math.PI)}° 高度 ${h}m）`);

  const toggle = (name, vis) =>
    page.evaluate(
      ({ name, vis, parentName }) => {
        const d = window.__dioramaDebug;
        const pn = parentName ?? 'diorama-root';
        const parent = d.scene.children.find((c) => (c.name || c.type) === pn) ?? d.scene;
        const o = parent.children.find((c) => (c.name || c.type) === name);
        if (o) o.visible = vis;
      },
      { name, vis, parentName: flag('parent', 'diorama-root') },
    );

  for (const g of groups) {
    await setCam();
    await toggle(g, false);
    const v = await shot(page, `tests/out/black/hunt-${g.replace(/[^\w]/g, '_')}.png`);
    await toggle(g, true);
    const delta = v - base;
    const tag = delta > 0.03 ? '  <== 隐藏它画面就变亮，它是遮挡源' : '';
    console.log(`  隐藏 ${g.padEnd(22)} → 亮度 ${v.toFixed(4)}  (Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(4)})${tag}`);
  }
} finally {
  await browser.close();
}
