/**
 * 占位查询：列出与给定矩形相交的已登记占位（owner / kind / rect），用于选新建筑落位。
 * node tools/_claimquery.mjs --rect=62,-78,98,-34
 */
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const rect = flag('rect', '62,-78,98,-34').split(',').map(Number);
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  protocolTimeout: 600000,
  args: [
    '--no-sandbox',
    '--hide-scrollbars',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--window-size=1200,800',
    '--window-position=30,30',
  ],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 120000 });
  const data = await page.evaluate((r) => {
    const d = window.__dioramaDebug;
    const [x0, z0, x1, z1] = r;
    const hits = d.occupancy.claims().filter(
      (c) => c.x1 > x0 && c.x0 < x1 && c.z1 > z0 && c.z0 < z1,
    );
    return {
      lane: d.layout.convoyLane,
      claims: hits.map((c) => ({ tag: c.tag, tier: c.tier, rect: { x0: c.x0, x1: c.x1, z0: c.z0, z1: c.z1 } })),
    };
  }, rect);
  console.log('车队车道:', JSON.stringify(data.lane));
  console.log(`相交占位 ${data.claims.length} 条：`);
  for (const c of data.claims) {
    const r = c.rect;
    console.log(`  ${c.tier.padEnd(9)} ${c.tag.padEnd(32)} [${r.x0},${r.x1}]x[${r.z0},${r.z1}]`);
  }
} finally {
  await browser.close();
}
