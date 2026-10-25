/**
 * 落位复核：统计各分区模块在构建期被 canPlace() 拒绝的落位（console.warn）。
 * 被拒绝 = 该资产没被放下（不会互压）；数量过大 = 该区会显得空。
 * node tools/place-audit.mjs
 */
import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const url = process.env.DIORAMA_URL || 'http://127.0.0.1:4175/';
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800 },
});
try {
  const page = await browser.newPage();
  const rejects = [];
  const errors = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/canPlace|压车行道|铁路资产/.test(t)) rejects.push(`${m.type()}: ${t}`);
    if (m.type() === 'error') errors.push(t);
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));

  const byModule = new Map();
  for (const line of rejects) {
    const m = /\[(\w+)\]/.exec(line);
    const key = m ? m[1] : 'other';
    byModule.set(key, (byModule.get(key) ?? 0) + 1);
  }
  console.log(`构建期被拒绝的落位（按模块）：`);
  for (const [k, v] of [...byModule].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(12)} ${v}`);
  if (rejects.length === 0) console.log('  （无：全部落位都通过了 canPlace 契约）');
  console.log('\n样本（最多 8 条）：');
  for (const line of rejects.slice(0, 8)) console.log('  ' + line.slice(0, 190));
  console.log(`\n页面 console 错误：${errors.length}${errors.length ? ' -> ' + errors.slice(0, 2).join(' | ') : ''}`);
} finally {
  await browser.close();
}
