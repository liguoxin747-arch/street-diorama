/**
 * 时间滑条功能验收：证明它"平时不可见、能浮现、能改时间、收起后交还自动推进"。
 *
 * node tools/slider-check.mjs
 */
import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const url = process.env.DIORAMA_URL || 'http://127.0.0.1:4175/';

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900 },
});

const fails = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) fails.push(label);
};

const state = () =>
  /** @returns {Promise<any>} */
  Promise.resolve();

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2200));

  const read = () =>
    page.evaluate(() => {
      const el = document.querySelector('.time-day');
      const cs = getComputedStyle(el);
      const track = el.querySelector('.time-day__track').getBoundingClientRect();
      const thumb = el.querySelector('.time-day__thumb').getBoundingClientRect();
      const d = window.__dioramaDebug;
      const px = (() => {
        // 必须先重绘：canvas 没开 preserveDrawingBuffer，合成后缓冲区已被清空
        for (let i = 0; i < 2; i += 1) d.renderer.render(d.scene, d.camera);
        d.post.render(0.016);
        const src = d.renderer.domElement;
        const c = document.createElement('canvas');
        c.width = 120;
        c.height = 80;
        const cx = c.getContext('2d');
        cx.drawImage(src, 0, 0, 120, 80);
        const data = cx.getImageData(0, 0, 120, 80).data;
        let luma = 0;
        let warm = 0;
        let n = 0;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i] / 255;
          const b = data[i + 2] / 255;
          luma += 0.299 * r + 0.587 * (data[i + 1] / 255) + 0.114 * b;
          if (r > b + 0.05 && r > 0.08) warm += 1;
          n += 1;
        }
        return { luma: luma / n, warm: warm / n };
      })();
      return {
        shown: el.dataset.shown,
        visibility: cs.visibility,
        opacity: cs.opacity,
        pointerEvents: cs.pointerEvents,
        time: d.day.time,
        dayLength: d.day.dayLength,
        sunOp: Number(el.querySelector('.sun').style.opacity || 1),
        moonOp: Number(el.querySelector('.moon').style.opacity || 0),
        thumbCenter: (thumb.left + thumb.width / 2 - track.left) / track.width,
        ui: px,
      };
    });

  // —— 1. 默认必须不可见（这是"零 UI"前提的硬条件）——
  const hidden0 = await read();
  check(hidden0.visibility === 'hidden' && hidden0.shown === '0', '默认不可见（visibility:hidden）', `${hidden0.visibility} / shown=${hidden0.shown}`);

  // —— 2. 鼠标靠近底边 → 浮现 ——
  await page.mouse.move(720, 895);
  await new Promise((r) => setTimeout(r, 420));
  const shown = await read();
  check(shown.visibility === 'visible' && shown.shown === '1', '鼠标靠近底边后浮现', `${shown.visibility} opacity=${shown.opacity} pe=${shown.pointerEvents}`);
  check(shown.dayLength === 0, '可见期间暂停自动昼夜推进', `dayLength=${shown.dayLength}`);

  // —— 3. 拖到 75% → 时间真的变成黄昏，画面跟着变 ——
  const box = await page.evaluate(() => {
    const r = document.querySelector('.time-day__track').getBoundingClientRect();
    return { x: r.left, y: r.top + r.height / 2, w: r.width };
  });
  const before = shown.ui;
  await page.mouse.move(box.x + box.w * 0.1, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.75, box.y, { steps: 12 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 700));
  const dusk = await read();
  check(Math.abs(dusk.time - 0.75) < 0.04, '拖动把时间设到黄昏（t≈0.75）', `time=${dusk.time.toFixed(3)}`);
  check(Math.abs(dusk.thumbCenter - dusk.time) < 0.02, '日月图标跟随时间', `thumb=${dusk.thumbCenter.toFixed(3)} time=${dusk.time.toFixed(3)}`);
  check(dusk.ui.warm > before.warm + 0.01, '黄昏比深夜更暖（画面确实响应滑条）', `${before.warm.toFixed(4)} → ${dusk.ui.warm.toFixed(4)}`);

  // —— 4. 拖到 50% → 正午：亮、冷、太阳图标压过月亮 ——
  await page.mouse.move(box.x + box.w * 0.2, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.5, box.y, { steps: 10 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 700));
  const noon = await read();
  check(Math.abs(noon.time - 0.5) < 0.04, '可拖到正午', `time=${noon.time.toFixed(3)}`);
  check(noon.ui.luma > dusk.ui.luma * 1.5, '正午显著亮于黄昏', `${dusk.ui.luma.toFixed(4)} → ${noon.ui.luma.toFixed(4)}`);
  check(noon.sunOp > 0.9 && noon.moonOp < 0.1, '太阳高度为正时显示日、隐去月', `sun=${noon.sunOp} moon=${noon.moonOp}`);

  // —— 5. 拖回 0 → 深夜：月亮图标回来 ——
  await page.mouse.move(box.x + box.w * 0.4, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.02, box.y, { steps: 10 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 700));
  const night = await read();
  check(night.moonOp > 0.9 && night.sunOp < 0.1, '深夜显示月、隐去日', `sun=${night.sunOp} moon=${night.moonOp}`);

  // —— 6. H 钉住后再按 H 取消 → 超时自动收起，并交还自动推进 ——
  await page.keyboard.press('h');
  await new Promise((r) => setTimeout(r, 300));
  const pinned = await read();
  await page.keyboard.press('h');
  await new Promise((r) => setTimeout(r, 2800));
  const faded = await read();
  check(pinned.shown === '1', 'H 可钉住滑条');
  check(faded.visibility === 'hidden', '取消钉住后无操作自动收起', faded.visibility);
  check(faded.dayLength > 0, '收起后恢复自动昼夜推进', `dayLength=${faded.dayLength}`);

  // —— 6b. 昼夜固定按钮：冻结后收起滑条也不恢复推进 ——
  await page.mouse.move(720, 895);
  await new Promise((r) => setTimeout(r, 450));
  const freezeBox = await page.evaluate(() => {
    const b = document.querySelector('.time-day__freeze');
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(freezeBox.x, freezeBox.y);
  await new Promise((r) => setTimeout(r, 300));
  const frozenState = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    return {
      pressed: document.querySelector('.time-day__freeze').getAttribute('aria-pressed'),
      dayLength: d.day.dayLength,
      time: d.day.time,
    };
  });
  check(frozenState.pressed === 'true' && frozenState.dayLength === 0, '固定按钮生效（dayLength=0，按钮高亮）', JSON.stringify(frozenState));
  // 移开鼠标 → 滑条收起 → 时间仍然不动
  await page.mouse.move(720, 400);
  await new Promise((r) => setTimeout(r, 3000));
  const afterHide = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    return {
      shown: document.querySelector('.time-day').dataset.shown,
      dayLength: d.day.dayLength,
      time: d.day.time,
    };
  });
  await new Promise((r) => setTimeout(r, 1500));
  const stillFrozen = await page.evaluate(() => window.__dioramaDebug.day.time);
  check(afterHide.shown === '0', '固定后滑条可正常收起', afterHide.shown);
  check(afterHide.dayLength === 0 && Math.abs(stillFrozen - afterHide.time) < 0.002, '收起后时间保持冻结（不再自动推进）', `${afterHide.time.toFixed(3)} → ${stillFrozen.toFixed(3)}`);
  // 再点一次 → 解冻并恢复推进
  await page.mouse.move(720, 895);
  await new Promise((r) => setTimeout(r, 450));
  await page.mouse.click(freezeBox.x, freezeBox.y);
  await new Promise((r) => setTimeout(r, 400));
  const thaw = await page.evaluate(() => ({
    pressed: document.querySelector('.time-day__freeze').getAttribute('aria-pressed'),
    dayLength: window.__dioramaDebug.day.dayLength,
  }));
  check(thaw.pressed === 'false' && thaw.dayLength > 0, '再次点击解冻并恢复自动推进', JSON.stringify(thaw));
  // 点完按钮后滑条会保留 2.2 s 作为反馈；等它收起再做零 UI 判定
  await page.mouse.move(720, 400);
  await new Promise((r) => setTimeout(r, 2800));


  // —— 7. 收起状态下仍然"不算 UI"——
  const ui = await page.evaluate(() => {
    const visible = [];
    const walk = (el) => {
      for (const child of el.children) {
        if (['CANVAS', 'SCRIPT', 'STYLE'].includes(child.tagName)) continue;
        if (child.querySelectorAll('canvas').length === 1 && child.innerText.trim() === '') {
          walk(child);
          continue;
        }
        const st = getComputedStyle(child);
        const rect = child.getBoundingClientRect();
        if (st.display !== 'none' && st.visibility !== 'hidden' && rect.width > 2 && rect.height > 2) {
          visible.push(`${child.tagName}.${child.className}`);
        }
        walk(child);
      }
    };
    walk(document.body);
    return visible;
  });
  check(ui.length === 0, '收起后页面回到零 UI', ui.join(' | '));
  check(errors.length === 0, '全程无 JS 异常', errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
}

console.log(fails.length === 0 ? '\n滑条全部检查通过 ✅' : `\n${fails.length} 项失败 ❌：${fails.join(', ')}`);
process.exit(fails.length === 0 ? 0 : 1);
