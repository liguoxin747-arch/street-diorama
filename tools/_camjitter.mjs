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
    const result = await page.evaluate(async (el) => {
      const dbg = window.__dioramaDebug;
      const { THREE, camera, controls } = dbg;
      controls.autoRotate = false;
      controls.enableDamping = false;
      const target = new THREE.Vector3(7, 5, -9);
      controls.target.copy(target);
      const dist = 62;
      const samples = [];
      const setAz = (azDeg) => {
        const az = THREE.MathUtils.degToRad(azDeg);
        const e = THREE.MathUtils.degToRad(el);
        camera.position.set(
          target.x + Math.cos(e) * Math.sin(az) * dist,
          target.y + Math.sin(e) * dist,
          target.z + Math.cos(e) * Math.cos(az) * dist,
        );
        camera.lookAt(target);
        controls.update();
      };
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      for (let az = 0; az <= 360; az += 1) {
        controls.autoRotate = false;
        setAz(az);
        await frame();
        await frame();
        samples.push({
          az,
          x: +camera.position.x.toFixed(3),
          y: +camera.position.y.toFixed(3),
          z: +camera.position.z.toFixed(3),
        });
      }
      const expected = (2 * Math.PI * 62 * Math.cos((el * Math.PI) / 180)) / 360;
      const jumps = [];
      for (let i = 1; i < samples.length; i += 1) {
        const a = samples[i - 1], b = samples[i];
        const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
        if (d > expected * 1.8 + 0.4) jumps.push({ az: b.az, d: +d.toFixed(2), from: [a.x, a.y, a.z], to: [b.x, b.y, b.z] });
      }
      jumps.sort((a, b) => b.d - a.d);
      return { elevation: el, expected: +expected.toFixed(2), count: jumps.length, max: Math.max(0, ...jumps.map((j) => j.d)), worst: jumps.slice(0, 6) };
    }, elevation);
    console.log(JSON.stringify(result));
  }
} finally {
  await browser.close();
}
