/**
 * 微缩景观截图工具（验收用，不属于交付内容的一部分）。
 *
 * 用法：
 *   node tools/shot.mjs <输出文件> [--view=az,elev,dist,tx,ty,tz] [--wait=4000] [--size=1600x900]
 *                        [--url=http://127.0.0.1:4175/]
 *
 * 会等待 window.__dioramaReady 为真后截图，便于人工/自动比对画面。
 */
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const out = resolve(args.find((a) => !a.startsWith('--')) ?? 'tests/e2e/out/diorama.png');
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const url = flag('url', 'http://127.0.0.1:4175/');
const waitMs = Number(flag('wait', '4500'));
const [vw, vh] = flag('size', '1600x900').split('x').map(Number);
const view = flag('view', '');
/** --day=0 把昼夜冻在指定时刻：光照测量必须有确定基准，否则量到的是"夜里 13 秒"那种混合相位 */
const dayAt = flag('day', '');
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

await mkdir(dirname(out), { recursive: true });

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--use-angle=default',
    '--ignore-gpu-blocklist',
    // 被遮挡的窗口会被 Chrome 降频到 1fps，构建里的 yieldFrame 就再也不返回
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    `--window-size=${vw},${vh}`,
    '--window-position=40,40',
  ],
  defaultViewport: { width: vw, height: vh, deviceScaleFactor: 1 },
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // 改过 core/ 会让 vite 重新变换整棵依赖树，冷启动可以远超 30s
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 120000 });

  if (dayAt !== '') {
    await page.evaluate((t) => {
      window.__dioramaDebug.setDayTime(t);
      window.__dioramaDebug.freezeDay();
    }, Number(dayAt));
  }

  if (view) {
    const nums = view.split(',').map(Number);
    await page.evaluate((v) => {
      window.__setView?.(v[0], v[1], v[2], v[3], v[4], v[5]);
    }, nums);
  }

  await new Promise((r) => setTimeout(r, waitMs));
  await page.screenshot({ path: out });
  console.log(`saved ${out}`);
  if (errors.length) {
    console.log('--- console errors ---');
    errors.slice(0, 20).forEach((e) => console.log(e));
  }
} finally {
  await browser.close();
}
