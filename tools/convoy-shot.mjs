/**
 * 车队跟拍：等头车开到指定路段时自动截图（验收用）。
 * node tools/convoy-shot.mjs <输出> <机位az,elev,dist,tx,ty,tz> [目标z范围min,max]
 */
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--')) ?? 'tests/e2e/out/convoy.png';
const view = (args.find((a) => a.startsWith('--view=')) ?? '--view=205,24,52,3,1.5,-4').slice(7);
const [zMin, zMax] = (args.find((a) => a.startsWith('--z=')) ?? '--z=-14,4').slice(4).split(',').map(Number);
const laneArg = Number((args.find((a) => a.startsWith('--lane=')) ?? '--lane=0').slice(7));
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--hide-scrollbars', '--window-size=1600,900', '--window-position=30,30'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', String(e)));
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 30000 });

  const nums = view.split(',').map(Number);
  await page.evaluate((v) => window.__setView(v[0], v[1], v[2], v[3], v[4], v[5]), nums);
  await new Promise((r) => setTimeout(r, 1500));

  // 等头车进入目标路段
  const ok = await page.waitForFunction(
    (lane, lo, hi) => {
      let found = null;
      window.__dioramaDebug.scene.traverse((o) => {
        if (o.name === 'convoy-tank' && o.parent?.name === `convoy-${lane}`) found = o;
      });
      return !!found && found.position.z >= lo && found.position.z <= hi;
    },
    { timeout: 90000 },
    laneArg,
    Math.min(zMin, zMax),
    Math.max(zMin, zMax),
  );
  console.log('convoy in position:', ok);

  await new Promise((r) => setTimeout(r, 900));
  await page.screenshot({ path: out });
  console.log('saved', out);
} finally {
  await browser.close();
}
