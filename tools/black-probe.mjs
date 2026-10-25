/**
 * 旋转闪黑诊断（可信版）：绕目标点转一圈，每个方位角用**页面截图**取图，
 * 再用 analyze_shot.py 统计亮度。
 *
 * 注意：不能用 gl.readPixels 读默认帧缓冲 —— composer 渲染后缓冲区很可能已被交换，
 * 读出来恒为黑（会产生"所有角度全黑"的假阳性）。必须走 page.screenshot()。
 *
 * node tools/black-probe.mjs [--elev=18] [--dist=80] [--steps=12] [--target=8,5,-9]
 *   输出图片到 tests/out/black/<deg>.png，并统计每个角度的亮度
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const url = flag('url', process.env.DIORAMA_URL || 'http://127.0.0.1:4181/');
const elev = Number(flag('elev', '18'));
const dist = Number(flag('dist', '80'));
const steps = Number(flag('steps', '12'));
const target = flag('target', '8,5,-9').split(',').map(Number);

const OUT = 'tests/out/black';
mkdirSync(OUT, { recursive: true });

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--hide-scrollbars', '--window-size=900,650', '--window-position=20,20'],
  defaultViewport: { width: 900, height: 650 },
});

const rows = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', String(e).slice(0, 160)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 40000 });
  await new Promise((r) => setTimeout(r, 1500));

  for (let i = 0; i < steps; i += 1) {
    const az = (i / steps) * Math.PI * 2;
    const deg = Math.round((az * 180) / Math.PI);
    await page.evaluate(
      ({ az, elev, dist, t }) => {
        const d = window.__dioramaDebug;
        // 不暂停主循环：避让逻辑跑在 orbit.update() 里（main.ts 的 frame()），
        // 暂停了就测不到"相机被推出楼外"的真实行为
        d.setPaused(false);
        d.controls.autoRotate = false;
        const el = (elev * Math.PI) / 180;
        const y = Math.sin(el) * dist;
        const h = Math.cos(el) * dist;
        // 直接挪相机（OrbitControls 会以 target 为轴保持这个位置）
        d.camera.position.set(t[0] + Math.sin(az) * h, y, t[2] + Math.cos(az) * h);
        d.controls.target.set(t[0], t[1], t[2]);
        d.camera.lookAt(t[0], t[1], t[2]);
      },
      { az, elev, dist, t: target },
    );
    // 让主循环跑几帧：避让（avoidBuildings）会把相机推出楼体
    await new Promise((r) => setTimeout(r, 420));
    const file = `${OUT}/az${String(deg).padStart(3, '0')}.png`;
    await page.screenshot({ path: file });
    rows.push({ deg, file });
  }
} finally {
  await browser.close();
}

// 用 python 统计每张图的亮度
const py = 'C:\\Users\\yuukiasuna\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';
console.log(`仰角 ${elev}° 距离 ${dist}m 目标 ${target.join(',')}`);
console.log('方位角  平均亮度  暗像素占比');
const bad = [];
for (const r of rows) {
  let out = '';
  try {
    out = execFileSync(py, ['tools/analyze_shot.py', r.file, '--cols=8', '--rows=4'], { encoding: 'utf8' });
  } catch (e) {
    out = String(e.stdout ?? '');
  }
  const mean = /luminance\s*:\s*mean=([\d.]+)/.exec(out)?.[1] ?? '-';
  const dark = /dark frac\s*:\s*([\d.]+)/.exec(out)?.[1] ?? '-';
  const m = Number(mean);
  if (Number.isFinite(m) && m < 0.05) bad.push(r.deg);
  console.log(`  ${String(r.deg).padStart(4)}°  ${String(mean).padStart(8)}  ${String(dark).padStart(9)}`);
}
writeFileSync(`${OUT}/summary.txt`, rows.map((r) => r.file).join('\n'));
console.log(`\n变黑机位：${bad.length}/${rows.length}${bad.length ? ' → ' + bad.map((d) => d + '°').join(', ') : ''}`);
