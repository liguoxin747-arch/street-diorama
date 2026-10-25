import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--use-angle=default', '--ignore-gpu-blocklist', '--window-size=800,450'],
  defaultViewport: { width: 800, height: 450, deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 60000 });
  const out = await page.evaluate(() => {
    const { THREE, scene } = window.__dioramaDebug;
    scene.updateMatrixWorld(true);
    const CELL = 4, SOLID_Y = 5.5;
    const cells = new Map();
    const v = new THREE.Vector3();
    const parentName = (o) => {
      let p = o;
      for (let i = 0; i < 4 && p; i += 1) {
        if (p.name) return p.name;
        p = p.parent;
      }
      return '(unnamed)';
    };
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const pos = o.geometry?.getAttribute?.('position');
      if (!pos) return;
      const step = Math.max(1, Math.floor(pos.count / 4000));
      for (let i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        if (v.y < SOLID_Y) continue;
        const key = `${Math.floor(v.x / CELL)}_${Math.floor(v.z / CELL)}`;
        const prev = cells.get(key);
        if (!prev || v.y > prev.y) cells.set(key, { y: Math.round(v.y), name: parentName(o) || o.type });
      }
    });
    const tall = [...cells.entries()].sort((a, b) => b[1].y - a[1].y).slice(0, 25);
    const byName = new Map();
    for (const [, info] of cells) {
      const prev = byName.get(info.name) ?? { name: info.name, max: 0, cells: 0 };
      prev.max = Math.max(prev.max, info.y);
      prev.cells += 1;
      byName.set(info.name, prev);
    }
    const names = [...byName.values()].sort((a, b) => b.max - a.max).slice(0, 120);
    const near = [];
    for (const [key, info] of cells) {
      if (info.y > 30) near.push({ key, ...info });
    }
    return { cellCount: cells.size, names, over30: near.length, samples: near.slice(0, 12) };
  });
  console.log(JSON.stringify(out, null, 1));
} finally {
  await browser.close();
}
