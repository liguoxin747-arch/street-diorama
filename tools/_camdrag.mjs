import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--use-angle=default', '--ignore-gpu-blocklist', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--window-position=60,60', '--window-size=1280,720'],
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e)));
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 60000 });

  for (const elevation of [8, 22, 45]) {
    // 设定一个固定仰角/距离的机位，然后真实拖拽鼠标水平旋转一周
    await page.evaluate((el) => {
      const dbg = window.__dioramaDebug;
      dbg.controls.autoRotate = false;
      const t = dbg.controls.target;
      const az = 0;
      const e = (el * Math.PI) / 180;
      dbg.camera.position.set(t.x + Math.sin(az) * 62 * Math.cos(e), t.y + Math.sin(e) * 62, t.z + Math.cos(az) * 62 * Math.cos(e));
      dbg.camera.lookAt(t);
      dbg.controls.update();
      window.__camSamples = [];
      const cam = dbg.camera;
      window.__camSamples = [];
      const loop = (t) => {
        window.__camSamples.push([cam.position.x, cam.position.y, cam.position.z, performance.now(), t]);
        window.__camRaf = requestAnimationFrame(loop);
      };
      loop();
    }, elevation);

    await page.mouse.move(640, 360);
    await page.mouse.down();
    for (let i = 1; i <= 360; i += 1) {
      await page.mouse.move(640 + i * 3, 360);
      await new Promise((r) => setTimeout(r, 6));
    }
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 500));

    const result = await page.evaluate(() => {
      cancelAnimationFrame(window.__camRaf);
      const s = window.__camSamples;
      const rows = [];
      for (let i = 1; i < s.length; i += 1) {
        rows.push({
          i,
          d: Math.hypot(s[i][0] - s[i - 1][0], s[i][1] - s[i - 1][1], s[i][2] - s[i - 1][2]),
          dt: s[i][3] - s[i - 1][3],
          y: s[i][1],
        });
      }
      const sorted = [...rows].sort((a, b) => b.d - a.d);
      const med = [...rows].sort((a, b) => a.d - b.d)[Math.floor(rows.length / 2)] || { d: 0 };
      return {
        frames: s.length,
        medianStep: +med.d.toFixed(3),
        p99: +sorted[Math.floor(sorted.length * 0.01)].d.toFixed(2),
        max: +sorted[0].d.toFixed(2),
        spikes: rows.filter((r) => r.d > med.d * 3 + 0.5).length,
        worst: sorted.slice(0, 8).map((r) => ({ d: +r.d.toFixed(2), dt: Math.round(r.dt), y: +r.y.toFixed(1) })),
      };
    });
    console.log(`elev=${elevation}`, JSON.stringify(result));
  }
} finally {
  await browser.close();
}
