/**
 * 自由机位截图：直接用世界坐标放相机，避免猜方位角/仰角。
 * node tools/shot-at.mjs --out=x.png --cam=camX,camY,camZ --look=lx,ly,lz [--url=...]
 */
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const out = flag('out', 'tests/out/shot.png');
const cam = flag('cam', '0,20,40').split(',').map(Number);
const look = flag('look', '0,0,0').split(',').map(Number);
const url = flag('url', 'http://127.0.0.1:4175/');
const wait = Number(flag('wait', '4500'));
const dayAt = flag('day', '');
const w = Number(flag('w', '1600'));
const h = Number(flag('h', '900'));

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: [
    '--no-sandbox',
    '--hide-scrollbars',
    // 被遮挡的窗口会被 Chrome 降频到 1fps，构建里的 yieldFrame 就再也不返回
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    `--window-size=${w},${h}`,
    '--window-position=20,20',
  ],
  defaultViewport: { width: w, height: h, deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', String(e).slice(0, 200)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 120000 });
  if (dayAt !== '') {
    await page.evaluate((t) => {
      window.__dioramaDebug.setDayTime(t);
      window.__dioramaDebug.freezeDay();
    }, Number(dayAt));
  }
  await new Promise((r) => setTimeout(r, 600));
  await page.evaluate(
    (c, l) => {
      const d = window.__dioramaDebug;
      d.setPaused(true);
      d.camera.position.set(c[0], c[1], c[2]);
      d.camera.lookAt(l[0], l[1], l[2]);
      d.camera.updateProjectionMatrix();
      d.renderer.setRenderTarget(null);
      d.renderer.render(d.scene, d.camera);
    },
    cam,
    look,
  );
  await new Promise((r) => setTimeout(r, wait));
  await page.evaluate(
    (c, l) => {
      const d = window.__dioramaDebug;
      d.camera.position.set(c[0], c[1], c[2]);
      d.camera.lookAt(l[0], l[1], l[2]);
      d.renderer.setRenderTarget(null);
      d.renderer.render(d.scene, d.camera);
    },
    cam,
    look,
  );
  await page.screenshot({ path: out });
  console.log('saved', out);
} finally {
  await browser.close();
}
