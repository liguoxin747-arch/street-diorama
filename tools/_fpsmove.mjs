import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--use-angle=default',
    '--ignore-gpu-blocklist',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--window-position=60,60',
    '--window-size=1280,720',
  ],
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e)));
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 60000 });

  await page.keyboard.press('KeyV');
  await new Promise((r) => setTimeout(r, 2200));
  const mode = await page.evaluate(() => window.__dioramaDebug.view.mode);
  console.log('mode after V:', mode);

  await page.evaluate(() => {
    window.__fpsSamples = [];
    const cam = window.__dioramaDebug.camera;
    const loop = () => {
      window.__fpsSamples.push([cam.position.x, cam.position.y, cam.position.z, performance.now()]);
      window.__fpsRaf = requestAnimationFrame(loop);
    };
    loop();
  });

  await page.keyboard.down('KeyW');
  for (let i = 0; i < 60; i += 1) {
    await page.mouse.move(640 + Math.sin(i * 0.3) * 180, 360);
    await new Promise((r) => setTimeout(r, 25));
  }
  await page.keyboard.up('KeyW');
  await new Promise((r) => setTimeout(r, 300));

  const result = await page.evaluate(() => {
    cancelAnimationFrame(window.__fpsRaf);
    const s = window.__fpsSamples;
    const rows = [];
    for (let i = 1; i < s.length; i += 1) {
      const dx = s[i][0] - s[i - 1][0];
      const dz = s[i][2] - s[i - 1][2];
      rows.push({ d: Math.hypot(dx, dz), dy: Math.abs(s[i][1] - s[i - 1][1]), dt: s[i][3] - s[i - 1][3] });
    }
    const sorted = [...rows].sort((a, b) => b.d - a.d);
    const med = [...rows].sort((a, b) => a.d - b.d)[Math.floor(rows.length / 2)] || { d: 0 };
    return {
      frames: s.length,
      medianMove: +med.d.toFixed(3),
      maxMove: +sorted[0].d.toFixed(3),
      maxHeightDrift: +Math.max(0, ...rows.map((r) => r.dy)).toFixed(4),
      spikes: rows.filter((r) => r.d > med.d * 4 + 0.15).length,
      totalDist: +rows.reduce((a, r) => a + r.d, 0).toFixed(1),
    };
  });
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
