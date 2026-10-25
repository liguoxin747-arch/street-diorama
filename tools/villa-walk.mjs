/**
 * 别墅步行可达性检查：用第一人称的 canStand 判定，
 * 确认"车库内部能走进去""主门能进""台阶不设空气墙"。
 *
 * node tools/villa-walk.mjs
 */
import puppeteer from 'puppeteer-core';

const url = process.env.DIORAMA_URL || 'http://127.0.0.1:4176/';
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--hide-scrollbars', '--window-size=1200,800', '--window-position=20,20'],
  defaultViewport: { width: 1200, height: 800 },
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', String(e).slice(0, 200)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 40000 });
  await new Promise((r) => setTimeout(r, 1200));

  const res = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    const can = d.view.canStand;
    // 位置从场景里读，不写死：别墅搬过位置（z 16.5 → 21），写死的探针会整体错位，
    // 于是"实体墙应被挡"会因为探针落到空地而假失败。
    const g = d.scene.getObjectByName('custom-villa');
    const CX = g.position.x;
    const CZ = g.position.z;
    // rotation = π：局部 +Z（正门 / 车库敞口）→ 世界 -Z；局部 +X → 世界 -X
    const probes = {
      '街道（别墅北侧）': { x: CX, z: CZ - 9 },
      '台阶前': { x: CX - 1.8, z: CZ - 5.2 },
      '主门洞内': { x: CX - 1.8, z: CZ - 3.2 },
      '主楼内（门后 1.5m）': { x: CX - 1.8, z: CZ - 1.5 },
      '主楼内（门后 3m）': { x: CX - 1.8, z: CZ },
      '主楼实体墙（应被挡）': { x: CX - 4.5, z: CZ - 3.2 },
      '车库敞口': { x: CX + 4.5, z: CZ - 3.0 },
      '车库内部（进深 2m）': { x: CX + 4.5, z: CZ - 1.0 },
      '车库内部（进深 4m）': { x: CX + 4.5, z: CZ + 1.0 },
      '车库后墙内侧（应被挡）': { x: CX + 6.2, z: CZ + 2.8 },
    };
    const out = {};
    for (const [k, p] of Object.entries(probes)) out[k] = can(p.x, p.z);
    return { pos: [+CX.toFixed(1), +CZ.toFixed(1)], out };
  });
  console.log(`别墅位置 (${res.pos[0]}, ${res.pos[1]})`);

  console.log('别墅步行可达性：');
  let pass = 0;
  let fail = 0;
  for (const [k, v] of Object.entries(res.out)) {
    const expect = k.includes('应被挡') ? false : true;
    const ok = v === expect;
    if (ok) pass += 1;
    else fail += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${k.padEnd(26)} 可站立=${v}（期望 ${expect}）`);
  }
  console.log(`\n${fail === 0 ? '全部通过 ✅' : `${fail} 项不符合预期 ❌`}`);
} finally {
  await browser.close();
}
