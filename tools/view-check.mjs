/**
 * 双视角 + 第一人称碰撞验收（可重复跑的版本）。
 * node tools/view-check.mjs
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: false,
  args: ['--no-sandbox', '--window-size=1280,800'],
  defaultViewport: { width: 1280, height: 800 },
});

const fails = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) fails.push(label);
};

try {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  await page.goto(process.env.DIORAMA_URL || 'http://127.0.0.1:4175/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 4000));

  const read = () =>
    page.evaluate(() => {
      const d = window.__dioramaDebug;
      const v = d.view;
      const hint = document.querySelector('.view-hint');
      const cs = getComputedStyle(hint);
      return {
        mode: v.mode,
        y: +d.camera.position.y.toFixed(3),
        near: d.camera.near,
        player: [+v.player.x.toFixed(2), +v.player.z.toFixed(2)],
        hintVisible: cs.visibility === 'visible' && Number(cs.opacity) > 0.5,
        locked: document.pointerLockElement != null,
      };
    });

  // —— 碰撞谓词：小巷可进、建筑内不可进 ——
  const spots = await page.evaluate(() => {
    const v = window.__dioramaDebug.view;
    return {
      alleyNW: v.canStand(-14, -20), // NW 街区侧巷（ALLEYS[1]）
      alleyHero: v.canStand(35, -24), // 主楼东侧小巷
      yard: v.canStand(-39, -55), // 两栋楼之间的 2 m 间隙
      crossStreet: v.canStand(3, -22),
      insideHero: v.canStand(20, -20), // 主楼内
      insidePlot: v.canStand(-25, -20), // NW 地块内
      bmpt: v.canStand(-4.2, -23.5), // 街心 BMPT 位置
      industrialInterior: v.canStand(120, -50), // 新区非走廊：仍禁止
      outOfBase: v.canStand(150, 0),
    };
  });
  check(spots.alleyNW === true, '侧巷可站立（小巷可探索）', String(spots.alleyNW));
  check(spots.alleyHero === true, '主楼东侧小巷可站立', String(spots.alleyHero));
  check(spots.yard === true, '地块间隙/后院可站立', String(spots.yard));
  check(spots.crossStreet === true, '街面可站立', String(spots.crossStreet));
  check(spots.insideHero === false, '主楼内部禁止站立（不穿楼）', String(spots.insideHero));
  check(spots.insidePlot === false, '地块建筑内禁止站立', String(spots.insidePlot));
  check(spots.bmpt === false, '街心 BMPT 会挡人', String(spots.bmpt));
  check(spots.industrialInterior === false, '新区建筑内仍不可站立', String(spots.industrialInterior));
  check(spots.outOfBase === false, '底座外不可站立', String(spots.outOfBase));

  // —— 样板楼内构：门洞可入、LOD 有室内层级 ——
  const interior = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    const lods = [];
    let meshes = 0;
    d.scene.traverse((o) => {
      if (!o.isLOD || !/^interior-lod-/.test(o.name)) return;
      lods.push(o.levels.length);
      o.traverse((c) => {
        if (c.isMesh) meshes += 1;
      });
    });
    return {
      hasLod: lods.length > 0,
      levels: lods.length > 0 ? Math.min(...lods) : 0,
      lods: lods.length,
      meshes,
      doorInside: d.view.canStand(-21.2, -15.2),
      doorAisleDeep: d.view.canStand(-21.2, -16.6),
      wallSide: d.view.canStand(-19.2, -14.5),
    };
  });
  check(interior.hasLod && interior.levels >= 2, '每栋内构都带 LOD（近景室内 / 远景隐藏）', `LOD=${interior.lods} mesh=${interior.meshes}`);
  check(interior.lods >= 4 && interior.meshes > 200, '首批 4 栋都有实际内构几何', `LOD=${interior.lods} mesh=${interior.meshes}`);
  check(interior.doorInside === true, '半开门洞可走入（门内 1.7 m 处可站）');
  check(interior.doorAisleDeep === true, '入口过道可深入（3.2 m 内可探索）');
  check(interior.wallSide === false, '门洞两侧墙面仍然阻挡（不会整面墙都能进）', String(interior.wallSide));

  // —— 视角切换 ——
  const a = await read();
  check(a.mode === 'orbit' && a.hintVisible === false, '初始俯瞰、提示隐藏');
  await page.mouse.click(640, 400);
  await page.keyboard.press('v');
  await new Promise((r) => setTimeout(r, 1500));
  const b = await read();
  check(b.mode === 'fps' && Math.abs(b.y - 1.7) < 0.02 && b.near === 0.1, '第一人称：高度 1.7 / 近裁剪 0.1', JSON.stringify([b.mode, b.y, b.near]));
  check(b.locked === true, '指针已锁定', String(b.locked));

  // —— 贴墙：把人放到主楼西侧、朝向 +X 强行走，必须被墙挡住且能沿墙滑动 ——
  const wall = await page.evaluate(async () => {
    const d = window.__dioramaDebug;
    d.view.player.set(10.5, 1.7, -20);
    d.camera.position.set(10.5, 1.7, -20);
    d.camera.lookAt(30, 1.7, -20);
    // 直接推进若干帧：等价于一直按 W
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await sleep(60);
    return { start: [d.view.player.x, d.view.player.z] };
  });
  await page.keyboard.down('w');
  await new Promise((r) => setTimeout(r, 2200));
  await page.keyboard.up('w');
  const wallEnd = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    return { x: +d.view.player.x.toFixed(2), z: +d.view.player.z.toFixed(2), y: +d.camera.position.y.toFixed(2) };
  });
  check(wallEnd.x < 11.8, '迎面撞主楼西墙被挡住（x 未越过 12 - 0.3）', `x=${wallEnd.x} 起点 ${wall.start[0].toFixed(2)}`);
  check(Math.abs(wallEnd.y - 1.7) < 0.02, '撞墙后高度仍为 1.7');

  await page.keyboard.press('v');
  await new Promise((r) => setTimeout(r, 1500));
  const c = await read();
  check(c.mode === 'orbit' && c.near === 0.8 && c.locked === false && c.hintVisible === false, '切回俯瞰：近裁剪/指针/提示都复原');
  check(errs.length === 0, '全程无 JS 异常', errs.slice(0, 2).join(' | '));
} finally {
  await browser.close();
}

console.log(fails.length === 0 ? '\n双视角与碰撞全部检查通过 ✅' : `\n${fails.length} 项失败 ❌：${fails.join(', ')}`);
process.exit(fails.length === 0 ? 0 : 1);
