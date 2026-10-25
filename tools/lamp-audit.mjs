/**
 * 路灯系统几何/光源审计：
 *  - 实例数量、损坏分组
 *  - 倒地灯的杆身最低点与所在地面：不悬空、不过度穿地
 *  - 倾斜灯灯头高度
 *  - 真实灯池的数量、阴影开关、跟随姿态
 *  - 从近景机位出图
 */
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
await mkdir('tests/out', { recursive: true });
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--window-size=1600,900'],
  defaultViewport: { width: 1600, height: 900 },
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__dioramaReady === true', { timeout: 30000 });
  await page.evaluate(() => {
    window.__dioramaDebug.setDayTime(0);
    window.__dioramaDebug.freezeDay();
    // 近景：让灯池真正分配到倾斜灯，否则默认远景下 4 盏 SpotLight 全部隐藏
    window.__setView(0, 22, 34, -60, 4, -9);
  });
  await new Promise((r) => setTimeout(r, 2200));

  const report = await page.evaluate(() => {
    const d = window.__dioramaDebug;
    const { THREE, scene } = d;
    const get = (name) => scene.getObjectByName(name);
    const poles = get('lamp-poles');
    const burnt = get('lamp-lens-burnt');
    const intactLens = get('lamp-lens-intact');
    const flickerLens = get('lamp-lens-flicker');
    const cones = get('lamp-cones');
    const pools = get('lamp-pools');
    const halos = get('lamp-halos');
    const haloGlow = get('lamp-halo-glow');
    const spills = get('lamp-spills');
    const rubble = get('lamp-rubble');

    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const v = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const dirUp = new THREE.Vector3();
    const positions = (mesh, local = null) => {
      const out = [];
      const lp = local ? new THREE.Vector3() : null;
      for (let i = 0; i < mesh.count; i += 1) {
        mesh.getMatrixAt(i, m);
        m.decompose(p, q, s);
        if (lp) lp.copy(local).applyMatrix4(m);
        dirUp.copy(up).applyQuaternion(q);
        out.push({
          i,
          x: +((lp ? lp.x : p.x)).toFixed(2),
          y: +((lp ? lp.y : p.y)).toFixed(2),
          z: +((lp ? lp.z : p.z)).toFixed(2),
          tiltDeg: +(Math.acos(Math.max(-1, Math.min(1, dirUp.dot(up)))) * 180 / Math.PI).toFixed(1),
        });
      }
      return out;
    };
    // 灯面实例矩阵带的是灯杆根部变换，灯面几何自带局部偏移；匹配聚光位置时必须把
    // 几何包围盒中心再乘一次实例矩阵，否则拿根部坐标去配灯头会永远差 1.5 m 以上。
    const lensGeoBox = intactLens.geometry.boundingBox ?? (intactLens.geometry.computeBoundingBox(), intactLens.geometry.boundingBox);
    const lensLocal = lensGeoBox.getCenter(new THREE.Vector3());

    // 倒地灯杆身（局部 z 小、y < 5.4 的顶点）最低点
    const pos = poles.geometry.getAttribute('position');
    const fallenChecks = [];
    for (let i = 0; i < burnt.count; i += 1) {
      burnt.getMatrixAt(i, m);
      m.decompose(p, q, s);
      let minY = Infinity;
      let maxY = -Infinity;
      let baseMinY = Infinity;
      for (let k = 0; k < pos.count; k += 1) {
        const lx = pos.getX(k);
        const ly = pos.getY(k);
        const lz = pos.getZ(k);
        if (ly > 5.4 || lz > 0.3) continue; // 排除弯臂/灯罩
        v.set(lx, ly, lz).applyMatrix4(m);
        if (ly < 0.4) {
          if (v.y < baseMinY) baseMinY = v.y;
          continue;
        }
        if (v.y < minY) minY = v.y;
        if (v.y > maxY) maxY = v.y;
      }
      fallenChecks.push({
        i,
        x: +p.x.toFixed(1),
        z: +p.z.toFixed(1),
        shaftMinY: +minY.toFixed(3),
        shaftMaxY: +maxY.toFixed(3),
        baseMinY: +baseMinY.toFixed(3),
        tiltDeg: +(Math.acos(Math.max(-1, Math.min(1, up.clone().applyQuaternion(q).dot(up)))) * 180 / Math.PI).toFixed(1),
      });
    }

    const spots = [];
    const pointFills = [];
    let sceneLightCount = 0;
    let sceneLampLightCount = 0;
    scene.traverse((o) => {
      if (!o.isLight || (o.type !== 'PointLight' && o.type !== 'SpotLight')) return;
      sceneLightCount += 1;
      if (!/^lamp-pool-/.test(o.name)) return;
      sceneLampLightCount += 1;
      if (o.isPointLight) {
        pointFills.push({
          type: 'PointLight',
          base: o.userData.baseIntensity,
          intensity: +o.intensity.toFixed(2),
          distance: o.distance,
          visible: o.visible,
          lamp: o.userData.lampIndex,
          pos: o.position.toArray().map((n) => +n.toFixed(1)),
        });
        return;
      }
      spotPush(o);
    });
    function spotPush(o) {
      spots.push({
        base: o.userData.baseIntensity,
        intensity: +o.intensity.toFixed(2),
        castShadow: o.castShadow,
        shadowMap: o.shadow?.mapSize?.x ?? 0,
        visible: o.visible,
        lamp: o.userData.lampIndex,
        pos: o.position.toArray().map((n) => +n.toFixed(1)),
        target: o.target.position.toArray().map((n) => +n.toFixed(1)),
      });
    }

    d.renderer.setRenderTarget(null);
    d.renderer.render(scene, d.camera);
    return {
      counts: {
        poles: poles.count,
        intactLens: intactLens.count,
        flickerLens: flickerLens.count,
        burntLens: burnt.count,
        cones: cones.count,
        pools: pools.count,
        halos: halos.count,
        haloGlow: haloGlow.count,
        spills: spills.count,
        rubble: rubble.count,
      },
      castShadow: { poles: poles.castShadow, instanced: poles.isInstancedMesh },
      instanceMatrixNeedsUpdate: poles.instanceMatrix.needsUpdate,
      fallenChecks,
      intact: positions(intactLens),
      flicker: positions(flickerLens),
      spots,
      pointFills,
      sceneLightCount,
      sceneLampLightCount,
      tiltedSpots: (() => {
        const lenses = [...positions(intactLens, lensLocal), ...positions(flickerLens, lensLocal)];
        return spots
          .filter((s) => s.visible && s.lamp !== undefined)
          .map((s) => {
            let best = null;
            for (const l of lenses) {
              const d = Math.hypot(l.x - s.pos[0], l.z - s.pos[2]);
              if (!best || d < best.d) best = { l, d };
            }
            if (!best || best.d > 1.2) return null;
            return {
              lamp: s.lamp,
              x: best.l.x,
              z: best.l.z,
              tiltDeg: best.l.tiltDeg,
              horizOffset: +Math.hypot(s.target[0] - s.pos[0], s.target[2] - s.pos[2]).toFixed(2),
            };
          })
          .filter(Boolean);
      })(),
      drawCalls: d.renderer.info.render.calls,
      camera: d.camera.position.toArray().map((n) => +n.toFixed(1)),
    };
  });
  console.log(JSON.stringify(report, null, 1));
  if (report.fallenChecks.some((f) => f.shaftMinY > 0.28 || f.shaftMinY < 0.1)) {
    console.log('FAIL 倒地灯杆身贴地检查');
  } else {
    console.log('PASS 倒地灯杆身最低点都在 0.10~0.28 m（人行道 0.22；基座略埋属预期）');
  }
  const activeSpots = report.spots.filter((s) => s.visible).length;
  const activePointFills = report.pointFills.filter((s) => s.visible).length;
  console.log(`${activeSpots >= 7 && activePointFills >= 3 ? 'PASS' : 'FAIL'} 灯池激活 ${activeSpots} 盏聚光 + ${activePointFills} 盏近灯点补光（近景应至少 7 + 3）`);
  console.log(
    `${report.sceneLampLightCount === 11 ? 'PASS' : 'FAIL'} 路灯真实光源 ${report.sceneLampLightCount}/11；全场景点/聚光 ${report.sceneLightCount} 盏`,
  );
  const pools = report.counts.pools;
  const halos = report.counts.halos;
  const haloGlow = report.counts.haloGlow;
  const litLamps = report.counts.intactLens + report.counts.flickerLens;
  console.log(
    `${pools === litLamps && halos === litLamps && haloGlow === litLamps ? 'PASS' : 'FAIL'} 光池 ${pools} / 灯晕 ${halos} / 外晕 ${haloGlow} 覆盖全部 ${litLamps} 盏亮灯`,
  );
  const tiltedSpots = report.tiltedSpots.filter((s) => s.tiltDeg > 25);
  if (tiltedSpots.length === 0) {
    console.log('WARN 当前机位的灯池没有覆盖倾斜灯');
  } else {
    const ok = tiltedSpots.every((s) => s.horizOffset > 2);
    console.log(
      `${ok ? 'PASS' : 'FAIL'} 倾斜灯聚光跟随灯罩：${tiltedSpots.map((s) => `lamp${s.lamp} ${s.tiltDeg}°/偏移${s.horizOffset}m`).join('；')}`,
    );
  }
  console.log(errors.length ? `errors: ${errors.join(' | ')}` : 'PASS 无 console/page 异常');

  // 近景出图：选一盏街面开阔、真正立着的完好灯，再加一盏倾斜灯与倒地灯
  const hero = { x: 42.56, z: -9.85 };
  const upright = report.intact.filter((l) => l.tiltDeg < 10);
  const intact = upright.reduce((a, b) =>
    ((a.x - hero.x) ** 2 + (a.z - hero.z) ** 2 < (b.x - hero.x) ** 2 + (b.z - hero.z) ** 2 ? a : b));
  const fallen = report.fallenChecks.reduce((a, b) => (a.x * a.x + a.z * a.z < b.x * b.x + b.z * b.z ? a : b));
  const tilted = report.tiltedSpots.find((s) => s.tiltDeg > 25);
  await page.evaluate(() => {
    window.__dioramaDebug.setDayTime(0);
    window.__dioramaDebug.freezeDay();
  });
  const shots = [
    // 目标点压到地面，视线焦点的落点才会在那盏灯附近，真实灯池才会分配给它
    ['lamp-audit-intact.png', [20, 14, 16, intact.x, 0.3, intact.z]],
  ];
  if (tilted) shots.push(['lamp-audit-tilted-night.png', [30, 14, 16, tilted.x, 0.35, tilted.z]]);
  const top = ['lamp-audit-map.png', [0, 55, 150, 0, 0, 0]];
  const shoot = async ([name, view]) => {
    await page.evaluate((v) => window.__setView(...v), view);
    await new Promise((r) => setTimeout(r, 3400));
    await page.screenshot({ path: `tests/out/${name}` });
    const out = execFileSync('python', ['tools/analyze_shot.py', `tests/out/${name}`, '--cols=40', '--rows=12'], { encoding: 'utf8' });
    const mean = (out.match(/luminance : mean=([\d.]+)/) || [])[1];
    const warm = (out.match(/warm px\s+: ([\d.]+)/) || [])[1];
    console.log(`saved ${name} mean=${mean} warm=${warm}`);
  };
  for (const shot of shots) await shoot(shot);
  await shoot(top);
  await page.evaluate(() => {
    window.__dioramaDebug.setDayTime(0.73);
    window.__dioramaDebug.freezeDay();
  });
  await shoot(['lamp-audit-fallen-dusk.png', [20, 10, 16, fallen.x, 1.2, fallen.z]]);
} finally {
  await browser.close();
}
