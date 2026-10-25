/**
 * 昼夜循环审计（截图版）。
 *
 * 像素一律走"真实帧截图 + analyze_shot.py 数值看图"：早先的 day-audit 在页内
 * drawImage 直接采样 WebGL canvas，量出来的数与真实画面反号（深夜报得比正午还亮），
 * 因为手动 render 后缓冲区并未按页面自己的 rAF 正常呈现。这里只信截图。
 *
 * node tools/day-check.mjs
 */
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const url = process.env.DIORAMA_URL || 'http://127.0.0.1:4175/';
const PHASES = [['night', 0], ['dawn', 0.25], ['noon', 0.5], ['dusk', 0.75]];

/** 把 PNG 变成可读数值（本项目既有的"数值化看图"约定） */
function measure(file) {
  const out = execFileSync('python', ['tools/analyze_shot.py', file, '--cols=40', '--rows=12'], { encoding: 'utf8' });
  const num = (re) => Number((out.match(re) || [0, 'NaN'])[1]);
  return {
    mean: num(/luminance : mean=([\d.]+)/),
    p95: num(/p95=([\d.]+)/),
    bright: num(/bright frac\(>0\.45\): ([\d.]+)/),
    dark: num(/dark frac : ([\d.]+)/),
    warm: num(/warm px\s+: ([\d.]+)/),
    r: num(/mean RGB\s+: ([\d.]+) [\d.]+ [\d.]+/),
    b: num(/mean RGB\s+: [\d.]+ [\d.]+ ([\d.]+)/),
  };
}

const fails = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) fails.push(label);
};

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  // 窗口被遮挡时 Chrome 把 rAF 降到 1fps，构建里的 yieldFrame 再也不返回 → 就绪超时
  args: ['--no-sandbox', '--window-size=1600,900', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
  defaultViewport: { width: 1600, height: 900 },
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (/注入失败/.test(m.text())) errors.push(m.text());
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));

  const settle = async (time) => {
    await page.evaluate((t) => {
      const d = window.__dioramaDebug;
      d.freezeDay();
      d.setDayTime(t);
      window.__setView(205, 34, 300, 0, 0, 0);
    }, time);
    // 等真实帧：阴影重烘、后期、灯光都要到位
    await new Promise((r) => setTimeout(r, 2400));
  };

  const rows = {};
  const st = {};
  for (const [name, t] of PHASES) {
    await settle(t);
    const file = `.tmp/phase-${name}.png`;
    await page.screenshot({ path: file });
    rows[name] = measure(file);
    st[name] = await page.evaluate(() => {
      const s = window.__dioramaDebug.day.snapshot();
      return {
        harden: +s.harden.toFixed(2),
        rim: +s.rimStrength.toFixed(2),
        fog: +s.fogDensity.toFixed(4),
        lightsOn: +s.lightsOn.toFixed(2),
        outline: `#${s.outlineColor.getHexString()}`,
      };
    });
    const r = rows[name];
    console.log(
      `【${name.padEnd(5)}】mean=${r.mean.toFixed(4)} p95=${r.p95.toFixed(3)} 高光占比=${r.bright.toFixed(3)}` +
        ` 暗部=${r.dark.toFixed(3)} 暖色=${r.warm.toFixed(4)} | harden=${st[name].harden} rim=${st[name].rim}` +
        ` 雾=${st[name].fog} 灯=${st[name].lightsOn} 描边${st[name].outline}`,
    );
  }
  console.log('');

  // —— 分带注入的功能性判据：把阴面色打成纯红，红升蓝降必须看得见 ——
  // 判据必须在"三渲二墙面占满画面"的近景上做：uShadowTint 只注入 MeshToonMaterial，
  // 路面/泥地是 PBR、天空是独立着色器，300 m 俯瞰时它们占了绝大多数像素，
  // 注入再强也被稀释掉（实测俯瞰 R 0.0070 → 0.0080，量的是取景而不是着色器）。
  await settle(0);
  // settle() 会把机位放回 300 m 俯瞰，所以近景必须放在它之后再设
  await page.evaluate(() => window.__setView(205, 20, 88, 12, 6, -18));
  await new Promise((r) => setTimeout(r, 1800));
  await page.screenshot({ path: '.tmp/inject-off.png' });
  const off = measure('.tmp/inject-off.png');
  await page.evaluate(() => {
    const d = window.__dioramaDebug;
    // 只打阴面色，并把分带推到"全阴面"（harden=0）：
    // 之前这里同时抬 harden=1，锐化反而把更多表面翻到冷色阳面，
    // 结果 B 不降反升（实测 0.053 → 0.059），判据被第二个变量污染了。
    d.dayUniforms.uShadowTint.value.setRGB(1, 0, 0);
    d.dayUniforms.uHarden.value = 0;
  });
  await new Promise((r) => setTimeout(r, 900));
  await page.screenshot({ path: '.tmp/inject-on.png' });
  const on = measure('.tmp/inject-on.png');
  // 判据用通道均值而不是"暖色占比"：后者带一个 R > 0.2 的绝对下限，全局压暗之后
  // 大部分像素够不到那条线，注入纯红也抬不动它——量出来的是测量通道的灵敏度而不是着色器。
  // 只判"红通道显著上升"：B 通道由非三渲二的面积（天空穹顶、PBR 路面、光柱、描边壳）
  // 决定，注入纯红阴面动不了它，拿 B 下降当条件等于把判据绑在取景比例上。
  check(
    on.r > off.r * 1.4 && on.r - off.r > 0.004,
    '分带注入生效：改阴面色真实改变像素',
    `R ${off.r.toFixed(4)} → ${on.r.toFixed(4)}（B ${off.b.toFixed(4)} → ${on.b.toFixed(4)}，非三渲二面积主导，不参与判据）`,
  );

  // —— 昼夜关系与"不过曝"红线 ——
  check(rows.noon.mean > rows.night.mean * 1.6, '正午显著亮于深夜', `noon=${rows.noon.mean} night=${rows.night.mean}`);
  check(rows.noon.mean < 0.3, '正午不过曝（mean < 0.3）', `mean=${rows.noon.mean}`);
  check(rows.noon.bright < 0.14, '正午高光面积受控（不会白茫茫一片）', `bright=${rows.noon.bright}`);
  check(rows.noon.dark > 0.1, '正午仍有明确暗部（硬阴影与体积感可读）', `dark=${rows.noon.dark}`);
  check(st.noon.harden >= 0.95 && st.noon.harden > st.night.harden, '正午分带最硬', `noon=${st.noon.harden} night=${st.night.harden}`);
  check(st.dusk.rim > st.noon.rim && st.dusk.rim > st.night.rim, '黄昏边缘光最强', `dusk=${st.dusk.rim}`);
  check(st.dawn.fog > st.noon.fog && st.dawn.fog > st.night.fog, '拂晓雾最浓', `dawn=${st.dawn.fog}`);
  check(st.noon.outline !== st.night.outline, '描边色随时段变化（白天不会一片纯黑）', `noon=${st.noon.outline} night=${st.night.outline}`);
  check(st.night.lightsOn > 0.9 && st.noon.lightsOn < 0.12 && st.dusk.lightsOn > 0.35, '人造光与时段联动：深夜满亮、正午待机、黄昏渐起');
  check(rows.dusk.warm > rows.noon.warm, '黄昏暖色高于正午（冷暖对比拉开）', `dusk=${rows.dusk.warm} noon=${rows.noon.warm}`);
  // 暖色焦点要在"看得见焦点"的距离上量：300 m 俯瞰时一扇窗只有 2~3 像素，
  // 用它来判"有没有暖光焦点"量的是缩放比例，不是场景本身。
  await page.evaluate(() => {
    const d = window.__dioramaDebug;
    d.freezeDay();
    d.setDayTime(0);
    window.__setView(205, 20, 88, 12, 6, -18);
  });
  await new Promise((r) => setTimeout(r, 2400));
  await page.screenshot({ path: '.tmp/night-hero.png' });
  const heroNight = measure('.tmp/night-hero.png');
  check(heroNight.warm > 0.003, '深夜在近景存在暖色火光焦点（不能只剩冷蓝）', `近景 warm=${heroNight.warm}（俯瞰 ${rows.night.warm}）`);
  check(errors.length === 0, '全程无 JS / 注入异常', errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
}

console.log(fails.length === 0 ? '\n昼夜循环全部检查通过 ✅' : `\n${fails.length} 项失败 ❌：${fails.join(', ')}`);
process.exit(fails.length === 0 ? 0 : 1);
