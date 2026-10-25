/**
 * 单盏灯的成本实验：同一场景下，逐个隐藏候选点光并复测循环帧时。
 * node tools/_lightcost.mjs
 */
import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  protocolTimeout: 600000,
  args: [
    '--no-sandbox',
    '--hide-scrollbars',
    '--use-angle=default',
    '--ignore-gpu-blocklist',
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
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 120000 });

  const measure = (names) =>
    page.evaluate((hide) =>
      new Promise((res) => {
        const d = window.__dioramaDebug;
        for (const n of hide) {
          const l = d.scene.getObjectByName(n);
          if (l) l.visible = false;
        }
        const deltas = [];
        let last = performance.now();
        let count = 0;
        const step = (now) => {
          deltas.push(now - last);
          last = now;
          count += 1;
          if (count > 150) {
            const s = deltas.slice(20).sort((a, b) => a - b);
            res(+s[Math.floor(s.length / 2)].toFixed(2));
          } else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }), names);

  const all = await measure([]);
  const noSpark = await measure(['fx-spark-light']);
  const noFlare = await measure(['fx-spark-light', 'fx-flare-light']);
  console.log(`全部灯在场：${all}ms`);
  console.log(`隐藏短路火花灯：${noSpark}ms（省 ${(all - noSpark).toFixed(2)}ms）`);
  console.log(`再隐藏照明弹灯：${noFlare}ms（省 ${(noSpark - noFlare).toFixed(2)}ms）`);
} finally {
  await browser.close();
}
