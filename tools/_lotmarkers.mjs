/**
 * 临时定位探针：在候选空地中心放彩色圆盘，用于对照用户截图定位。
 * node tools/_lotmarkers.mjs --out=xxx.png --view=0,78,210,20,0,10
 */
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const out = flag('out', 'tests/out/lot-markers.png');
const view = flag('view', '0,78,210,20,0,10').split(',').map(Number);
const size = flag('size', '2000x900').split('x').map(Number);

const SPOTS = [
  { name: 'A-east-of-cutaway', x: 56, z: 44, color: 0xff00ff },
  { name: 'B-industrial-gap', x: 106, z: 34, color: 0x00ffff },
  { name: 'C-north-yard', x: 50, z: -57, color: 0xffff00 },
  { name: 'D-southwest', x: -56, z: 40, color: 0x00ff44 },
  { name: 'E-south-belt-yard', x: -30, z: 83, color: 0xff8800 },
  { name: 'F-south-yard-small', x: 28, z: 70, color: 0x2244ff },
  { name: 'G-north-belt-yard', x: 32, z: -69, color: 0xff2244 },
  { name: 'H-east-gap-south', x: 56, z: 6, color: 0xffffff },
];

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
    `--window-size=${size[0]},${size[1]}`,
    '--window-position=30,30',
  ],
  defaultViewport: { width: size[0], height: size[1], deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', String(e).slice(0, 300)));
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 120000 });

  await page.evaluate((spots) => {
    const d = window.__dioramaDebug;
    const { THREE, scene } = d;
    for (const s of spots) {
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(3.4, 24),
        new THREE.MeshBasicMaterial({ color: s.color, fog: false, toneMapped: false }),
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(s.x, 0.35, s.z);
      disc.renderOrder = 20;
      scene.add(disc);
    }
    d.setDayTime(0.42);
    d.freezeDay();
  }, SPOTS);

  await page.evaluate((v) => {
    window.__setView?.(v[0], v[1], v[2], v[3], v[4], v[5]);
  }, view);
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: out });
  console.log('saved', out);
} finally {
  await browser.close();
}
