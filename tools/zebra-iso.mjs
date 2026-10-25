/**
 * 斑马线隔离渲染：只显示路面标线（隐藏其它所有物体），正俯视截图，
 * 用来客观判断白条方向与位置是否正确。
 * node tools/zebra-iso.mjs
 */
import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const url = process.env.DIORAMA_URL || 'http://127.0.0.1:4175/';

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--hide-scrollbars', '--window-size=1200,900', '--window-position=30,30'],
  defaultViewport: { width: 1200, height: 900, deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', String(e)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));

  // 隔离：隐藏除路面标线外的所有网格，并正俯视
  const info = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    const { THREE, scene, renderer } = d;
    d.setPaused(true); // 停掉主循环，避免 OrbitControls 把相机拉回去
    // 冻在正午：只留标线时夜景亮度太低，截图阈值量不到白条
    d.setDayTime(0.5);
    d.freezeDay();
    const hidden = [];
    scene.traverse((o) => {
      if (!o.isMesh) return;
      if (o.name === 'road-markings') return; // 保留路面标线
      hidden.push(o);
      o.userData.__isoHidden = true;
      o.visible = false;
    });
    // 真正的正交俯视：条纹方向测量不能被透视畸变污染
    const camera = new THREE.OrthographicCamera(-60, 60, 45, -45, 1, 400);
    camera.position.set(0, 150, 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    return { hiddenCount: hidden.length };
  });
  console.log('isolated meshes:', info.hiddenCount);

  await page.screenshot({ path: 'tests/e2e/out/zebra-iso.png' });
  console.log('saved tests/e2e/out/zebra-iso.png');
} finally {
  await browser.close();
}
