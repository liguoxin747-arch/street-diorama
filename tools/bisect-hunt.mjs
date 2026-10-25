/**
 * 二分定位：在"变黑"的机位下，用二分法隐藏网格，一次排除一半，
 * 定位到导致画面黑的**具体 mesh**。
 *
 * 用法：node tools/bisect-hunt.mjs [--az=90] [--h=45] [--dist=80] [--url=...]
 */
import puppeteer from 'puppeteer-core';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const url = flag('url', process.env.DIORAMA_URL || 'http://127.0.0.1:4183/');
const az = (Number(flag('az', '90')) * Math.PI) / 180;
const h = Number(flag('h', '45'));
const dist = Number(flag('dist', '80'));
const target = flag('target', '8,5,-9').split(',').map(Number);
const py = 'C:\\Users\\yuukiasuna\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';
const lum = (f) => {
  const o = execFileSync(py, ['tools/burst-lum.py', f], { encoding: 'utf8' });
  return Number(/mean=([\d.]+)/.exec(o)?.[1] ?? 0);
};

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--hide-scrollbars', '--window-size=900,650', '--window-position=20,20'],
  defaultViewport: { width: 900, height: 650 },
});

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', String(e).slice(0, 160)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 40000 });
  await new Promise((r) => setTimeout(r, 1800));

  // 收集所有 mesh 的索引（稳定顺序）
  const total = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    const list = [];
    d.scene.traverse((o) => {
      if (o.isMesh) list.push(o);
    });
    window.__allMeshes = list;
    return list.length;
  });
  console.log(`场景 mesh 总数 ${total}`);

  const setCam = () =>
    page.evaluate(
      ({ az, h, dist, t }) => {
        const d = window.__dioramaDebug;
        d.setPaused(false);
        d.controls.autoRotate = false;
        const horiz = Math.cos(0.31) * dist;
        d.camera.position.set(t[0] + Math.sin(az) * horiz, h, t[2] + Math.cos(az) * horiz);
        d.controls.target.set(t[0], t[1], t[2]);
        d.camera.lookAt(t[0], t[1], t[2]);
      },
      { az, h, dist, t: target },
    );

  const showAll = () =>
    page.evaluate(() => {
      for (const m of window.__allMeshes) m.visible = true;
    });

  await setCam();
  await new Promise((r) => setTimeout(r, 700));
  await page.screenshot({ path: 'tests/out/black/bi-base.png' });
  const base = lum('tests/out/black/bi-base.png');
  console.log(`基准亮度 ${base}`);

  // 二分：每次隐藏候选集的一半，若亮度恢复 → 真凶在这一半
  let suspects = await page.evaluate(() => window.__allMeshes.map((_, i) => i));
  // 先排除 sky-dome（跟随相机，必然命中）
  suspects = await page.evaluate((idx) => {
    return idx.filter((i) => window.__allMeshes[i].name !== 'sky-dome');
  }, suspects);

  let round = 0;
  while (suspects.length > 1 && round < 14) {
    const half = Math.floor(suspects.length / 2);
    const partA = suspects.slice(0, half);
    const partB = suspects.slice(half);
    // 试隐藏 A：都显示 → 隐藏 A
    await showAll();
    await setCam();
    await page.evaluate((idx) => {
      for (const i of idx) window.__allMeshes[i].visible = false;
    }, partA);
    await new Promise((r) => setTimeout(r, 620));
    await page.screenshot({ path: 'tests/out/black/bi-a.png' });
    const la = lum('tests/out/black/bi-a.png');
    if (la > base + 0.02) {
      suspects = partA;
      console.log(`  第${round + 1}轮：隐藏 A 后变亮 (${la}) → 真凶在 A，剩 ${suspects.length}`);
    } else {
      suspects = partB;
      console.log(`  第${round + 1}轮：隐藏 A 无变化 (${la}) → 真凶在 B，剩 ${suspects.length}`);
    }
    round += 1;
  }

  await showAll();
  const info = await page.evaluate((idx) => {
    const d = window.__dioramaDebug;
    const T = d.THREE;
    const m = window.__allMeshes[idx];
    let par = m.parent;
    const chain = [];
    while (par) {
      chain.unshift(par.name || par.type);
      par = par.parent;
    }
    const bb = new T.Box3().setFromObject(m);
    const mm = Array.isArray(m.material) ? m.material[0] : m.material;
    return {
      name: m.name || m.geometry?.type,
      owner: chain.join('>'),
      bbox: Number.isFinite(bb.min.x)
        ? [bb.min.x.toFixed(0), bb.max.x.toFixed(0), bb.min.y.toFixed(0), bb.max.y.toFixed(0), bb.min.z.toFixed(0), bb.max.z.toFixed(0)]
        : null,
      matType: mm?.type,
      color: mm?.color ? '#' + mm.color.getHexString() : '-',
      side: mm?.side,
    };
  }, suspects[0]);

  console.log('\n定位到导致画面黑的 mesh:');
  console.log('  名称:', info.name);
  console.log('  归属:', info.owner);
  console.log('  材质:', info.matType, '颜色', info.color, 'side', info.side);
  console.log('  包围盒(x0,x1,y0,y1,z0,z1):', info.bbox?.join(', '));
} finally {
  await browser.close();
}
