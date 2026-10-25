/**
 * 《过街》原型验机（M3a：小队三人）
 * node tools/proto-test.mjs [--url=http://127.0.0.1:4190/proto.html]
 */
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const url = flag('url', process.env.PROTO_URL || 'http://127.0.0.1:4190/proto.html');
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  protocolTimeout: 900000,
  args: ['--no-sandbox', '--window-size=1280,720', '--window-position=30,30'],
  defaultViewport: { width: 1280, height: 720 },
});

let pass = 0;
let fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) pass += 1;
  else fail += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 240)));
  await page.goto(`${url}?v=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__protoReady === true', { timeout: 240000 });
  await new Promise((r) => setTimeout(r, 2500));

  // 1) 光照危险图
  const sample = await page.evaluate(() => {
    const d = window.__protoDebug;
    const pts = [[104, 0], [0, 0], [24, 8], [-40, 20], [-100, 0], [50, -14]];
    return {
      lights: d.exposure.lightCount,
      values: pts.map(([x, z]) => +d.exposure.at(x, z).toFixed(2)),
    };
  });
  const spread = Math.max(...sample.values) - Math.min(...sample.values);
  ok(spread > 0.15, `光照有明暗层次（${sample.lights} 盏灯，极差 ${spread.toFixed(2)}）`, JSON.stringify(sample.values));

  // 2) 小队：三人、各有预算、可切换
  const squad = await page.evaluate(() => {
    const d = window.__protoDebug;
    d.reset();
    const names = d.members.map((m) => m.short);
    const budgets = d.members.map((m) => m.budget);
    d.select(2);
    const after = d.state().active;
    d.select(0);
    return { names, budgets, after, back: d.state().active };
  });
  ok(squad.names.length === 3, '小队三人', JSON.stringify(squad.names));
  ok(new Set(squad.budgets).size === 3, '三人预算各不相同', JSON.stringify(squad.budgets));
  ok(squad.after === 2 && squad.back === 0, '可以切换当前角色', `${squad.after} → ${squad.back}`);

  // 2b) 按住方向键必须真的能走（曾经因为首帧太慢 + dt 钳制，按着不动）
  const before = await page.evaluate(() => {
    const d = window.__protoDebug;
    d.reset();
    return { probe: d.probe(), pos: [+d.members[0].group.position.x.toFixed(2), +d.members[0].group.position.z.toFixed(2)], turn: d.state().turn };
  });
  await page.keyboard.down('KeyW');
  await new Promise((r) => setTimeout(r, 3200));
  await page.keyboard.up('KeyW');
  await new Promise((r) => setTimeout(r, 3600));
  const after = await page.evaluate(() => {
    const d = window.__protoDebug;
    return { probe: d.probe(), pos: [+d.members[0].group.position.x.toFixed(2), +d.members[0].group.position.z.toFixed(2)], turn: d.state().turn };
  });
  const walked = Math.hypot(after.pos[0] - before.pos[0], after.pos[1] - before.pos[1]);
  ok(before.probe.frames > 5, '预热后主循环已稳定运行', `首次采样已 ${before.probe.frames} 帧`);
  ok(walked > 4, '按住方向键能连续行走', `位移 ${walked.toFixed(1)} m`);
  ok(after.turn > before.turn, '走完预算后自动推进回合', `${before.turn} → ${after.turn}`);

  // 3) 回合制
  const turnTest = await page.evaluate(async () => {
    const d = window.__protoDebug;
    d.reset();
    const p0 = d.patrols[0].mesh.position.clone();
    const before = d.state();
    await new Promise((r) => setTimeout(r, 600));
    const frozen = d.patrols[0].mesh.position.distanceTo(p0);
    d.endTurn();
    await new Promise((r) => setTimeout(r, 3300));
    return { before, frozen: +frozen.toFixed(2), moved: +d.patrols[0].mesh.position.distanceTo(p0).toFixed(2), after: d.state() };
  });
  ok(turnTest.frozen < 0.05, '规划阶段世界冻结', `位移 ${turnTest.frozen} m`);
  ok(turnTest.after.turn === turnTest.before.turn + 1, '结束回合后回合 +1', `${turnTest.before.turn} → ${turnTest.after.turn}`);
  ok(turnTest.moved > 1.5, '推进阶段巡逻移动', `位移 ${turnTest.moved} m`);

  // 4) 声源
  const noiseTest = await page.evaluate(async () => {
    const d = window.__protoDebug;
    d.reset();
    const p = d.patrols[0];
    const a0 = p.alert;
    d.emitNoise(p.mesh.position.x + 3, p.mesh.position.z + 1, 12);
    await new Promise((r) => setTimeout(r, 150));
    return { a0: +a0.toFixed(2), a1: +p.alert.toFixed(2), heard: !!p.investigate };
  });
  ok(noiseTest.a1 > noiseTest.a0, '噪声让巡逻升警觉', `${noiseTest.a0} → ${noiseTest.a1}`);
  ok(noiseTest.heard, '巡逻会前往查看');

  // 5) 青年拉闸灭灯：暗区真的变暗
  const sab = await page.evaluate(async () => {
    const d = window.__protoDebug;
    d.reset();
    d.select(2);
    d.teleport(24, 8, 2);
    const before = +d.exposure.at(24, 8).toFixed(2);
    const okSab = d.sabotage();
    await new Promise((r) => setTimeout(r, 120));
    return { before, after: +d.exposure.at(24, 8).toFixed(2), okSab, spent: +d.members[2].spent.toFixed(1) };
  });
  ok(sab.okSab && sab.after < sab.before * 0.5, '拉闸制造暗区', `${sab.before} → ${sab.after}`);
  ok(sab.spent >= 4.9, '拉闸耗掉本回合预算', `已用 ${sab.spent} m`);

  // 6) 视野：正前方有人会被抓（任一人出局即可，全员出局才失败）
  const trial = async (x, z) => {
    const res = await page.evaluate(
      async ({ x, z }) => {
        const d = window.__protoDebug;
        d.reset();
        d.teleport(x, z, 0);
        let maxAlert = 0;
        for (let t = 0; t < 3; t += 1) {
          d.endTurn();
          await new Promise((r) => setTimeout(r, 3300));
          maxAlert = Math.max(maxAlert, ...d.patrols.map((p) => p.alert));
          const s = d.state();
          if (s.out.some(Boolean)) return { caughtOne: true, turns: t + 1, lost: s.lost };
        }
        return { caughtOne: false, maxAlert: +maxAlert.toFixed(2) };
      },
      { x, z },
    );
    return res;
  };
  const front = await trial(50, 0);
  ok(front.caughtOne === true, '大道上正对巡逻会被抓', JSON.stringify(front));
  const back = await trial(27, 0);
  ok(back.caughtOne === false, '巡逻背后不被发现', JSON.stringify(back));

  // 7) 抵达终点即成功（哪怕只有一个人）
  const win = await page.evaluate(async () => {
    const d = window.__protoDebug;
    d.reset();
    d.teleport(-104, 0, 1);
    await new Promise((r) => setTimeout(r, 700));
    return d.state();
  });
  ok(win.won, '任一人抵达终点即成功', JSON.stringify({ won: win.won }));

  // 8) 出图
  await page.evaluate(() => {
    const d = window.__protoDebug;
    d.reset();
    d.select(0);
    d.teleport(64, 0, 0);
    d.teleport(63, 3.2, 1);
    d.teleport(65, -3.0, 2);
  });
  await new Promise((r) => setTimeout(r, 1600));
  await page.screenshot({ path: 'tests/out/proto-view.png' });
  await page.keyboard.press('KeyG');
  await new Promise((r) => setTimeout(r, 900));
  await page.screenshot({ path: 'tests/out/proto-exposure.png' });
  console.log('截图：tests/out/proto-view.png / proto-exposure.png');
} finally {
  await browser.close();
  console.log(`\n${fail === 0 ? '全部通过 ✅' : `${fail} 项不符合预期 ❌`}（${pass} 通过 / ${fail} 失败）`);
}
