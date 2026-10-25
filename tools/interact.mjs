/**
 * 交互验收：模拟真实鼠标拖拽 / 滚轮 / 右键平移，确认相机确实响应，
 * 并检查页面里除了 canvas 之外没有其它可见 UI 元素。
 * node tools/interact.mjs
 */
import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const url = process.env.DIORAMA_URL || 'http://127.0.0.1:4175/';

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--hide-scrollbars', '--window-size=1280,760', '--window-position=30,30'],
  defaultViewport: { width: 1280, height: 760, deviceScaleFactor: 1 },
});
const fails = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) fails.push(label);
};

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', String(e)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // 首帧要一次性上传全场景，软件渲染的机器上会到 30 s 以上，超时给足
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 180000 });
  await new Promise((r) => setTimeout(r, 1500));

  const view = () => page.evaluate(() => {
    const d = window.__dioramaDebug;
    return {
      pos: d.camera.position.toArray().map((v) => +v.toFixed(2)),
      dist: +d.camera.position.distanceTo(d.controls.target).toFixed(2),
    };
  });

  const before = await view();

  // 左键拖拽旋转
  await page.mouse.move(640, 380);
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(760, 350, { steps: 12 });
  await page.mouse.up({ button: 'left' });
  await new Promise((r) => setTimeout(r, 500));
  const afterDrag = await view();
  check(
    Math.abs(afterDrag.pos[0] - before.pos[0]) > 1 || Math.abs(afterDrag.pos[2] - before.pos[2]) > 1,
    '左键拖拽可旋转',
    `${JSON.stringify(before.pos)} → ${JSON.stringify(afterDrag.pos)}`,
  );

  // 滚轮缩放
  await page.mouse.move(640, 380);
  await page.mouse.wheel({ deltaY: -420 });
  await new Promise((r) => setTimeout(r, 500));
  const afterZoom = await view();
  check(afterZoom.dist < afterDrag.dist - 2, '滚轮可缩放', `距离 ${afterDrag.dist} → ${afterZoom.dist}`);

  // 右键平移
  const targetBefore = await page.evaluate(() => window.__dioramaDebug.controls.target.toArray().map((v) => +v.toFixed(2)));
  await page.mouse.move(640, 380);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(560, 430, { steps: 10 });
  await page.mouse.up({ button: 'right' });
  await new Promise((r) => setTimeout(r, 500));
  const targetAfter = await page.evaluate(() => window.__dioramaDebug.controls.target.toArray().map((v) => +v.toFixed(2)));
  check(
    Math.abs(targetAfter[0] - targetBefore[0]) > 0.5 || Math.abs(targetAfter[2] - targetBefore[2]) > 0.5,
    '右键可平移视点',
    `${JSON.stringify(targetBefore)} → ${JSON.stringify(targetAfter)}`,
  );

  // UI 检查：页面里只应有一个 canvas，没有按钮/文字/面板
  const ui = await page.evaluate(() => {
    const visible = [];
    const walk = (el) => {
      for (const child of el.children) {
        if (child.tagName === 'CANVAS' || child.tagName === 'SCRIPT' || child.tagName === 'STYLE') continue;
        // 只作为 canvas 容器存在的 div 不算 UI
        const isCanvasHost = child.querySelectorAll('canvas').length === 1 && child.innerText.trim() === '';
        if (isCanvasHost) {
          walk(child);
          continue;
        }
        const style = getComputedStyle(child);
        const rect = child.getBoundingClientRect();
        if (style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 2 && rect.height > 2) {
          visible.push(`${child.tagName}${child.id ? '#' + child.id : ''} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
        }
        walk(child);
      }
    };
    walk(document.body);
    return {
      canvases: document.querySelectorAll('canvas').length,
      visible,
      text: document.body.innerText.trim().slice(0, 80),
    };
  });
  check(ui.canvases === 1, '页面只有一个全屏 canvas', `canvas=${ui.canvases}`);
  check(ui.visible.length === 0, '没有任何附加 UI 元素', ui.visible.join(' | '));
  check(ui.text.length === 0, '页面上没有可见文字', JSON.stringify(ui.text));

  console.log(fails.length === 0 ? '\n交互与无 UI 检查全部通过 ✅' : `\n失败 ${fails.length} 项 ❌`);
  process.exitCode = fails.length === 0 ? 0 : 1;
} finally {
  await browser.close();
}
