/**
 * 空间占位审计（npm run test:space）。
 *
 * 断言两件必须为空的事：
 *  1. prop 与 infra 相交 —— 任何实体物件压到车行道或铁路走廊
 *  2. prop 与 prop 相交 —— 两个实体物件互相插进去
 * 另输出被 reserve() 拒绝的申请（拒绝本身是系统正常工作，不是错误）。
 *
 * node tools/occupancy-check.mjs
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: false,
  // 窗口被遮挡时 Chrome 把 rAF 降到 1fps，构建里的 yieldFrame 再也不返回 → 就绪超时
  args: ['--no-sandbox', '--window-size=1280,800', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
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
  await new Promise((r) => setTimeout(r, 5000));

  const rep = await page.evaluate(() => window.__dioramaDebug.occupancy.audit());
  const list = await page.evaluate(() => window.__dioramaDebug.occupancy.claims());

  console.log(
    `占位登记 ${rep.total} 条｜infra ${rep.byTier.infra}｜zone ${rep.byTier.zone}｜prop ${rep.byTier.prop}`,
  );
  const byTag = new Map();
  for (const c of list) {
    const key = c.tag.split(':')[0];
    byTag.set(key, (byTag.get(key) ?? 0) + 1);
  }
  console.log('分类:', [...byTag].map(([k, v]) => `${k}×${v}`).join(' · '));

  check(rep.infraHits.length === 0, '没有 prop 压在道路/铁路上', rep.infraHits.slice(0, 3).map((h) => `${h.a}↔${h.b}`).join(' | '));
  check(rep.violations.length === 0, '没有 prop 与 prop 互相插进去', rep.violations.slice(0, 3).map((v) => `${v.a}↔${v.b}`).join(' | '));
  check(rep.byTier.infra >= 7, '基础设施已登记（8 条车行道 + 主正线 + 装卸线）', `infra=${rep.byTier.infra}`);
  check(rep.byTier.prop > 0, '实体物件已进入占位系统', `prop=${rep.byTier.prop}`);

  if (rep.refusals.length > 0) {
    console.log(`\n被拒绝的申请 ${rep.refusals.length} 条（这是系统在正常工作）：`);
    for (const r of rep.refusals.slice(0, 8)) console.log('  ' + r.tag + ' — ' + r.reason);
  } else {
    console.log('\n没有申请被拒绝：所有物件都落在合法空位上。');
  }
  check(errs.length === 0, '全程无 JS 异常', errs.slice(0, 2).join(' | '));
} finally {
  await browser.close();
}

console.log(fails.length === 0 ? '\n空间占位全部检查通过 ✅' : `\n${fails.length} 项失败 ❌：${fails.join(', ')}`);
process.exit(fails.length === 0 ? 0 : 1);
