import * as THREE from 'three';
import type { BuildContext } from '../core/context';
import type { Rng } from '../core/rng';
import { addBatch, box, group, instanced, jitter, mesh, type InstanceTransform } from '../core/geo';
import { basicMaterial, outlineMaterial, toonMaterial } from '../core/materials';
import { BASE, RAIL, ROADS, isOnRoadCorridor } from './layout';
import { noteRefusal, reserve } from './occupancy';

/**
 * 边缘伪装：把"方形底座"读不出来，而不是把它删掉。
 *
 * 这个项目的身份是可收藏的微缩模型，地台就是它的展台；直接删底座会同时丢掉
 * 微缩感和全部既有验收。这里用的是 PUBG 那套"无缝错觉"里真正起作用的部分：
 *  1. 自然物挤压边缘——针叶林带 + 岩壁 + 焦土废墟，让直边被遮挡
 *  2. 道路不再断头——八条路的尽头都被塌桥 / 隧道口 / 废墟堵死，路延伸进雾里
 *  3. 远景双层剪影——已在 skyline.ts 的近环之外，再补一圈 520~600 的极低精度 imposters
 *     （fog:false + 手动调到雾色附近，避免被 FogExp2 直接吃掉）
 *  4. 云影——一张缓慢滚动的大贴图以乘法混合压在地面上，打破地形重复感
 *
 * 物理边界不新增系统：第一人称本来就只能在路网走廊内行走，路尽头又被实体堵死。
 */

const EDGE = BASE.half;

/** 铁路走廊（正线 + 装卸线）：树与岩体都不能压上来 */
const RAIL_BANDS = [
  { x0: RAIL.at - 5.4, x1: RAIL.at + 5.4, z0: RAIL.from, z1: RAIL.to + 6 },
  { x0: RAIL.spur.from - 4, x1: RAIL.spur.to + 4, z0: RAIL.spur.at - 4, z1: RAIL.spur.at + 4 },
];
function onRail(x: number, z: number, pad = 0): boolean {
  return RAIL_BANDS.some((b) => x > b.x0 - pad && x < b.x1 + pad && z > b.z0 - pad && z < b.z1 + pad);
}
const TERMINAL_AT = EDGE - 0.5;

/* ------------------------------------------------------------------ *
 * 1. 针叶林带：低多边形锥形树，两种明度，实例化
 * ------------------------------------------------------------------ */

function coniferGeometry(): THREE.BufferGeometry {
  const geoms: THREE.BufferGeometry[] = [];
  const trunk = new THREE.BoxGeometry(0.28, 2.2, 0.28);
  trunk.translate(0, 1.1, 0);
  geoms.push(trunk);
  // 三层锥体，越上越小：远看是清晰的针叶剪影
  const tiers: Array<[number, number, number]> = [
    [1.5, 2.6, 2.1],
    [1.1, 2.1, 3.6],
    [0.7, 1.7, 5.0],
  ];
  for (const [r, h, y] of tiers) {
    const cone = new THREE.ConeGeometry(r, h, 6);
    cone.translate(0, y, 0);
    geoms.push(cone);
  }
  // 手动合并（避免依赖）
  let total = 0;
  const flat = geoms.map((g) => {
    const ng = g.index ? g.toNonIndexed() : g;
    if (!ng.getAttribute('normal')) ng.computeVertexNormals();
    if (!ng.getAttribute('uv')) {
      const n = ng.getAttribute('position')?.count ?? 0;
      ng.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    total += ng.getAttribute('position').count;
    return ng;
  });
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let off = 0;
  for (const g of flat) {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const u = g.getAttribute('uv');
    for (let i = 0; i < p.count; i += 1) {
      pos[(off + i) * 3] = p.getX(i);
      pos[(off + i) * 3 + 1] = p.getY(i);
      pos[(off + i) * 3 + 2] = p.getZ(i);
      nor[(off + i) * 3] = n.getX(i);
      nor[(off + i) * 3 + 1] = n.getY(i);
      nor[(off + i) * 3 + 2] = n.getZ(i);
      uv[(off + i) * 2] = u.getX(i);
      uv[(off + i) * 2 + 1] = u.getY(i);
    }
    off += p.count;
    g.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  merged.computeBoundingSphere();
  return merged;
}

function buildForest(ctx: BuildContext, rng: Rng): THREE.Object3D {
  const root = group('edge-forest');
  const geo = coniferGeometry();
  const matA = toonMaterial(0x26301f, { steps: 2 });
  const matB = toonMaterial(0x1c2419, { steps: 2 });
  const listA: InstanceTransform[] = [];
  const listB: InstanceTransform[] = [];
  const belt: Array<[number, number]> = [];
  // 沿四条边内侧 3~11 m 排一条林带；靠边的更密，制造"林子还在往外长"的错觉
  for (let i = 0; i < 1500; i += 1) {
    const side = rng.int(0, 3);
    const along = rng.range(-(EDGE - 2), EDGE - 2);
    const depth = rng.range(2.5, 13);
    const inset = EDGE - depth;
    const x = side === 0 ? along : side === 1 ? -inset : side === 2 ? along : inset;
    const z = side === 0 ? -inset : side === 1 ? along : side === 2 ? inset : along;
    if (isOnRoadCorridor(x, z, 2.8)) continue; // 别把树种到马路上（路尽头由跌桥/隧道收尾）
    if (onRail(x, z, 2.2)) continue; // 也别种到铁轨上
    belt.push([x, z]);
  }
  for (const [x, z] of belt) {
    const s = rng.range(0.55, 1.5);
    const item: InstanceTransform = {
      position: new THREE.Vector3(x, 0, z),
      rotation: new THREE.Euler(rng.range(-0.05, 0.05), rng.range(0, 6.28), rng.range(-0.05, 0.05)),
      scale: new THREE.Vector3(s, s * rng.range(0.85, 1.35), s),
    };
    (rng.chance(0.55) ? listA : listB).push(item);
  }
  for (const [list, mat, name] of [
    [listA, matA, 'edge-forest-a'],
    [listB, matB, 'edge-forest-b'],
  ] as Array<[InstanceTransform[], THREE.Material, string]>) {
    if (list.length === 0) continue;
    const inst = instanced(geo, mat, list);
    inst.name = name;
    inst.castShadow = false;
    inst.receiveShadow = false;
    root.add(inst);
  }
  void ctx;
  return root;
}

/* ------------------------------------------------------------------ *
 * 2. 岩壁：几处陡峭岩体，把直边压出不规则的轮廓
 * ------------------------------------------------------------------ */

function buildCliffs(rng: Rng): THREE.Object3D {
  const root = group('edge-cliffs');
  // 两条岩带整体登记（岩体量大，逐个登记没有意义，反而互相拒光）
  for (const [axis, sign] of [
    ['x', -1],
    ['z', -1],
  ] as Array<['x' | 'z', number]>) {
    const band =
      axis === 'x'
        ? { x0: sign > 0 ? EDGE - 10 : -EDGE, x1: sign > 0 ? EDGE : -EDGE + 10, z0: -EDGE, z1: EDGE }
        : { x0: -EDGE, x1: EDGE, z0: sign > 0 ? EDGE - 10 : -EDGE, z1: sign > 0 ? EDGE : -EDGE + 10 };
    // 岩带是横跨整条边的宽带，内部还要给道路/铁路留口，所以只作信息登记
    const res = reserve(band, 'zone', `cliff-band:${axis}${sign}`, 0, { allowInfra: true });
    if (!res.ok) noteRefusal(`cliff-band:${axis}${sign}`, res.reason ?? '');
  }
  const mat = toonMaterial(0x3b3a36, { steps: 2 });
  const matDark = toonMaterial(0x2a2926, { steps: 2 });
  const list: InstanceTransform[] = [];
  const dark: InstanceTransform[] = [];
  // 只在两侧集中：西、北用岩壁，其余两向留给林子与废墟
  for (const [axis, sign] of [
    ['x', -1],
    ['z', -1],
  ] as Array<['x' | 'z', number]>) {
    for (let i = 0; i < 26; i += 1) {
      const along = rng.range(-(EDGE - 4), EDGE - 4);
      const inset = EDGE - rng.range(1.5, 9);
      const x = axis === 'x' ? sign * inset : along;
      const z = axis === 'x' ? along : sign * inset;
      if (isOnRoadCorridor(x, z, 2)) continue;
      if (onRail(x, z, 2.5)) continue;
      const s = rng.range(2.4, 7.5);
      const item: InstanceTransform = {
        position: new THREE.Vector3(x, -0.6, z),
        rotation: new THREE.Euler(rng.range(-0.35, 0.35), rng.range(0, 6.28), rng.range(-0.35, 0.35)),
        scale: new THREE.Vector3(s, s * rng.range(0.8, 1.7), s),
      };
      (rng.chance(0.6) ? list : dark).push(item);
    }
  }
  const rock = jitter(new THREE.DodecahedronGeometry(1, 1), 0.22, rng.fork(3));
  for (const [items, m, name] of [
    [list, mat, 'edge-cliff-a'],
    [dark, matDark, 'edge-cliff-b'],
  ] as Array<[InstanceTransform[], THREE.Material, string]>) {
    if (items.length === 0) continue;
    const inst = instanced(rock, m, items);
    inst.name = name;
    inst.castShadow = false;
    root.add(inst);
  }
  return root;
}

/* ------------------------------------------------------------------ *
 * 3. 道路尽头：塌桥 / 隧道口 / 废墟堵死 —— 让路"还有远方"
 * ------------------------------------------------------------------ */

function buildRoadTerminals(ctx: BuildContext, rng: Rng): THREE.Object3D {
  const root = group('road-terminals');
  const concrete = toonMaterial(0x5a5f66, { steps: 2 });
  const concreteDark = toonMaterial(0x3d4248, { steps: 2 });
  const rebar = toonMaterial(0x6b4a36, { steps: 2 });
  const rubbleMat = toonMaterial(0x4a453c, { steps: 2 });
  const voidMat = basicMaterial(0x05080c);

  for (const road of ROADS) {
    for (const dir of [-1, 1] as const) {
      const end = dir > 0 ? road.to : road.from;
      // 只处理通向底座边缘的端点
      if (Math.abs(Math.abs(end) - EDGE) > 0.5) continue;
      const g = group(`terminal-${road.id}-${dir}`);
      const tHalfW = road.half + 3.2;
      const tHalfD = 4.6;
      const tr =
        road.axis === 'z'
          ? { x0: road.at - tHalfW, x1: road.at + tHalfW, z0: dir * TERMINAL_AT - tHalfD, z1: dir * TERMINAL_AT + tHalfD }
          : { x0: dir * TERMINAL_AT - tHalfD, x1: dir * TERMINAL_AT + tHalfD, z0: road.at - tHalfW, z1: road.at + tHalfW };
      const claim = reserve(tr, 'structure', `terminal:${road.id}${dir}`, 0, { allowInfra: true });
      if (!claim.ok) {
        noteRefusal(`terminal:${road.id}${dir}`, claim.reason ?? '');
        continue;
      }
      const at = dir * TERMINAL_AT;
      if (road.axis === 'z') g.position.set(road.at, 0, at);
      else g.position.set(at, 0, road.at);
      const yaw = road.axis === 'z' ? 0 : Math.PI / 2;
      g.rotation.y = yaw;

      if (road.id === 'cross') {
        // 主路：塌掉半跨的立交桥压在路口，只留一个黑洞洞的桥下
        const deck = box(road.half * 2 + 6, 1.5, 6.0, concrete);
        deck.position.set(0, 6.2, 0);
        deck.rotation.x = rng.range(0.05, 0.12) * dir;
        g.add(deck);
        for (const s of [-1, 1] as const) {
          const pier = box(1.6, 6.2, 2.4, concreteDark);
          pier.position.set(s * (road.half + 1.2), 3.1, 0);
          g.add(pier);
        }
        // 塌落的桥面板 + 外露钢筋
        const slab = box(road.half * 1.5, 0.7, 6.0, concrete);
        slab.position.set(-road.half * 0.4, 1.1, -2.2);
        slab.rotation.z = 0.22;
        slab.rotation.x = -0.1;
        g.add(slab);
        for (let i = 0; i < 7; i += 1) {
          const bar = box(0.12, 0.12, rng.range(2.2, 4.4), rebar);
          bar.position.set(rng.range(-road.half, road.half), 1.5 + rng.range(0, 0.5), -2.2 + rng.range(-1, 1));
          bar.rotation.set(rng.range(-0.4, 0.4), rng.range(0, 3), rng.range(-0.5, 0.5));
          g.add(bar);
        }
        const holeFloor = mesh(new THREE.PlaneGeometry(road.half * 2, 6.4), voidMat);
        holeFloor.rotation.x = -Math.PI / 2;
        holeFloor.position.y = 0.03;
        holeFloor.castShadow = false;
        g.add(holeFloor);
      } else if (road.class === 'main') {
        // 主大道尽头：塌掉半跨的立交桥压在路口，只留一个黑洞洞的桥下
        const arch = box(road.half * 2 + 5, 9.5, 3.2, concreteDark);
        arch.position.set(0, 4.75, 0);
        g.add(arch);
        const mouth = box(road.half * 2 - 1.2, 6.4, 1.0, voidMat);
        mouth.position.set(0, 3.2, -0.9);
        g.add(mouth);
        for (const s of [-1, 1] as const) {
          const wing = box(2.4, 7.4, 5.5, concrete);
          wing.position.set(s * (road.half + 3.4), 3.7, 1.4);
          g.add(wing);
        }
      } else {
        // 环路与支路：成堆的废墟与倒塌围墙把口子堵死
        const chunks: THREE.Mesh[] = [];
        for (let i = 0; i < 12; i += 1) {
          const sc = rng.range(1.2, 3.6);
          const chunk = mesh(jitter(new THREE.DodecahedronGeometry(1, 0), 0.24, rng), rubbleMat);
          chunk.position.set(
            rng.range(-road.half - 1, road.half + 1),
            rng.range(0.2, 2.6),
            rng.range(-1.6, 1.6),
          );
          chunk.scale.set(sc, sc * rng.range(0.5, 0.9), sc);
          chunk.rotation.set(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3));
          chunks.push(chunk);
        }
        addBatch(g, chunks, rubbleMat, 'terminal-rubble');
        const wall = box(road.half * 2 + 4, 2.8, 1.1, concreteDark);
        wall.position.set(0, 1.4, 1.2);
        wall.rotation.z = rng.range(-0.06, 0.06);
        g.add(wall);
      }
      root.add(g);
    }
  }
  void ctx;
  return root;
}

/* ------------------------------------------------------------------ *
 * 4. 远景 imposters：520~600 的第二圈极低精度剪影
 * ------------------------------------------------------------------ */

function buildFarBackdrop(rng: Rng): THREE.Object3D {
  const root = group('far-backdrop');
  // 不受雾影响：FogExp2 在 560 m 处会吃掉 ~78%，靠手动调色模拟大气透视
  const farMat = toonMaterial(0x3d4a57, { steps: 2, fog: false });
  const farMatDark = toonMaterial(0x2b353f, { steps: 2, fog: false });
  const outline = outlineMaterial(0.0026, 0x0a1016);

  const place = (obj: THREE.Object3D, angle: number): void => {
    const r = rng.range(520, 600);
    obj.position.set(Math.cos(angle) * r, 0, Math.sin(angle) * r);
    obj.rotation.y = rng.range(0, Math.PI);
    root.add(obj);
  };

  // 山脊：不规则三棱柱，宽底、顶部参差
  for (let i = 0; i < 14; i += 1) {
    const w = rng.range(120, 240);
    const h = rng.range(42, 115);
    const ridge = mesh(new THREE.ConeGeometry(w / 2, h, 5), rng.chance(0.5) ? farMat : farMatDark);
    ridge.position.y = h / 2 - 4;
    place(ridge, (i / 14) * Math.PI * 2 + rng.range(-0.12, 0.12));
    ridge.castShadow = false;
    ridge.receiveShadow = false;
  }
  // 烟囱束
  for (let i = 0; i < 4; i += 1) {
    const h = rng.range(90, 150);
    const chimney = mesh(new THREE.CylinderGeometry(4.5, 6.5, h, 8), farMatDark);
    chimney.position.y = h / 2;
    place(chimney, rng.range(0, Math.PI * 2));
    chimney.castShadow = false;
  }
  // 巨型雷达站：球罩 + 支架，作为地平线的记忆点
  const radar = group('far-radar');
  const dome = mesh(new THREE.SphereGeometry(16, 12, 8), farMat);
  dome.position.y = 46;
  radar.add(dome);
  for (const s of [-1, 1] as const) {
    const leg = box(3, 34, 3, farMatDark);
    leg.position.set(s * 9, 17, 0);
    radar.add(leg);
  }
  place(radar, 2.2);

  // 极细的描边只给最近的一层，防止远景糊成一团色块
  root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) return;
    const m = (o as THREE.Mesh).material as THREE.Material;
    if (m === farMat) (o as THREE.Mesh).add(new THREE.Mesh((o as THREE.Mesh).geometry, outline));
  });
  return root;
}

/* ------------------------------------------------------------------ *
 * 5. 云影：一张缓慢滚动的大贴图，乘法压在地面上
 * ------------------------------------------------------------------ */

function buildCloudShadow(rng: Rng): { obj: THREE.Object3D; tick: (dt: number) => void } {
  const N = 128;
  const canvas = document.createElement('canvas');
  canvas.width = N;
  canvas.height = N;
  const c = canvas.getContext('2d');
  if (c) {
    const img = c.createImageData(N, N);
    // 低频值噪声（周期格点），只用来做"大片阴影"，不做细节
    const lat = (x: number, y: number, f: number): number => {
      const gx = ((x * 7 + 3) % f + f) % f;
      const gy = ((y * 5 + 11) % f + f) % f;
      const s = Math.sin(gx * 37.1 + gy * 91.7) * 43758.5453;
      return s - Math.floor(s);
    };
    for (let y = 0; y < N; y += 1) {
      for (let x = 0; x < N; x += 1) {
        let v = 0;
        for (const [f, a] of [[4, 0.6], [8, 0.3], [16, 0.1]] as Array<[number, number]>) {
          v += a * lat(x, y, f);
        }
        const g = Math.round(Math.min(1, Math.max(0, v)) * 255);
        const i = (y * N + x) * 4;
        img.data[i] = g;
        img.data[i + 1] = g;
        img.data[i + 2] = g;
        img.data[i + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);

  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    color: 0x2a3542,
    transparent: true,
    opacity: 0.15,
    blending: THREE.MultiplyBlending,
    premultipliedAlpha: true,
    depthWrite: false,
    fog: false,
  });
  const plane = mesh(new THREE.PlaneGeometry(BASE.size * 1.15, BASE.size * 1.15), mat);
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = 30;
  plane.castShadow = false;
  plane.receiveShadow = false;
  plane.renderOrder = 3;
  plane.frustumCulled = false;
  plane.name = 'cloud-shadow';

  // 缓慢漂移：两轴不同速，避免看出是同一张图在平移
  let t = 0;
  const speed = 0.004 + rng.range(0, 0.002);
  const root = group('cloud-shadow');
  root.add(plane);
  const tick = (dt: number): void => {
    t += dt;
    tex.offset.set(t * speed, t * speed * 0.62);
  };
  return { obj: root, tick };
}

/* ------------------------------------------------------------------ *
 * 组装
 * ------------------------------------------------------------------ */

export function buildBorder(ctx: BuildContext): THREE.Group {
  const root = group('border');
  const rng = ctx.rng.fork(0xb0d3e);
  root.add(buildForest(ctx, rng.fork(1)));
  root.add(buildCliffs(rng.fork(2)));
  root.add(buildRoadTerminals(ctx, rng.fork(3)));
  root.add(buildFarBackdrop(rng.fork(4)));
  const shadow = buildCloudShadow(rng.fork(5));
  root.add(shadow.obj);
  ctx.ticker.add((_t, dt) => shadow.tick(dt));
  // 边缘整体压暗一点：与 skyline 的雾墙叠起来，让"边界在哪"更难读
  const haze = mesh(
    new THREE.PlaneGeometry(BASE.size * 1.2, BASE.size * 1.2),
    new THREE.MeshBasicMaterial({
      map: radialHaze(),
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      fog: false,
      color: 0x0a0f16,
    }),
  );
  haze.rotation.x = -Math.PI / 2;
  haze.position.y = 0.05;
  haze.renderOrder = 2;
  haze.castShadow = false;
  haze.receiveShadow = false;
  root.add(haze);
  return root;
}

/** 只压边缘的径向渐变（中心全透明），让底座中央不受影响 */
function radialHaze(): THREE.Texture {
  const N = 256;
  const canvas = document.createElement('canvas');
  canvas.width = N;
  canvas.height = N;
  const c = canvas.getContext('2d');
  if (c) {
    const g = c.createRadialGradient(N / 2, N / 2, N * 0.3, N / 2, N / 2, N * 0.52);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,1)');
    c.fillStyle = g;
    c.fillRect(0, 0, N, N);
  }
  const tex = new THREE.CanvasTexture(canvas);
  return tex;
}
