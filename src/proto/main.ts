import * as THREE from 'three';
import { buildDiorama } from '../scene';
import { createCamera } from '../core/camera';
import { createPost } from '../core/post';
import { updateOutlineAspect } from '../core/materials';
import { createNav } from './nav';
import { buildExposure } from './exposure';

/**
 * 《过街》M3a 原型：小队三人
 *
 * 三个平民，三种能力，各自有一份每回合的移动预算。
 *  - 母亲：脚步轻（噪声 ×0.7），预算 4.5 m
 *  - 老人：能"识路"——规划阶段显示巡逻下一段路线；体力差，预算 3.6 m
 *  - 青年：能拉闸灭灯（自己制造暗区），动作最响（噪声 ×1.35），预算 5.0 m
 *
 * 结算规则：任意一人抵达终点即成功；全员出局才失败——所以"牺牲"是可选策略。
 */

const START: Array<[number, number]> = [
  [104, -2.5],
  [104, 0],
  [104, 2.5],
];
const GOAL = new THREE.Vector3(-104, 0, 0);
const DAWN_TURNS = 40;
const TURN_SECONDS = 3;
const PLAYER_R = 0.35;

type Phase = 'plan' | 'run';

interface PatrolState {
  mesh: THREE.Group;
  cone: THREE.Mesh;
  waypoints: THREE.Vector3[];
  leg: number;
  dir: number;
  alert: number;
  seen: boolean;
  speed: number;
  range: number;
  fov: number;
  investigate: THREE.Vector3 | null;
  wait: number;
}

interface Member {
  group: THREE.Group;
  ring: THREE.Mesh;
  body: THREE.Mesh;
  name: string;
  short: string;
  color: number;
  speed: number;
  budget: number;
  spent: number;
  noiseMul: number;
  out: boolean;
  seen: boolean;
}

interface NoiseEvent {
  pos: THREE.Vector3;
  radius: number;
  age: number;
  ring: THREE.Mesh;
}

const container = document.getElementById('proto-root');
if (!container) throw new Error('缺少 #proto-root');

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.52;
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const hud = document.getElementById('proto-hud') as HTMLElement | null;
const banner = document.getElementById('proto-banner') as HTMLElement | null;

function showBanner(text: string, sub: string): void {
  if (!banner) return;
  banner.innerHTML = `<b>${text}</b><span>${sub}</span>`;
  banner.dataset['shown'] = '1';
}
function hideBanner(): void {
  if (banner) banner.dataset['shown'] = '0';
}

async function boot(): Promise<void> {
  const { scene, ticker, day } = await buildDiorama(1);

  const orbit = createCamera(renderer.domElement, window.innerWidth, window.innerHeight, scene);
  const post = createPost(renderer, scene, orbit.camera, window.innerWidth, window.innerHeight);
  day.bindRenderer(renderer);
  day.bindPost(post);
  day.bindCamera(orbit.camera);

  const nav = createNav(scene);
  const exposure = buildExposure(scene);

  // 昼夜装置改成由回合推进的计时器
  const NIGHT_T = 0.03;
  const DAWN_T = 0.34;
  day.dayLength = 0;
  day.setTime(NIGHT_T);
  const setDawnProgress = (turns: number): void => {
    day.setTime(NIGHT_T + (DAWN_T - NIGHT_T) * Math.min(1, (turns - 1) / DAWN_TURNS));
  };

  // —— 小队 ——
  const members: Member[] = [];
  const makeMember = (
    i: number,
    name: string,
    short: string,
    color: number,
    speed: number,
    budget: number,
    noiseMul: number,
  ): Member => {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(PLAYER_R, 1.0, 4, 10),
      new THREE.MeshToonMaterial({ color, emissive: 0x22303c, emissiveIntensity: 0.6 }),
    );
    body.position.y = 0.9;
    group.add(body);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.8, 1.1, 28),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.06;
    group.add(ring);
    group.position.set(START[i]![0], 0, START[i]![1]);
    scene.add(group);
    const m: Member = {
      group,
      ring,
      body,
      name,
      short,
      color,
      speed,
      budget,
      spent: 0,
      noiseMul,
      out: false,
      seen: false,
    };
    members.push(m);
    return m;
  };

  // 每回合预算：3 秒推进对应"能走多远"。
  // 原来给 4.5 m（约 1.3 秒就走完），玩家会以为人物卡住了 —— 现在给到 2 秒半左右的路程，
  // 一回合能真正跨过一段空地或贴过一栋楼。
  makeMember(0, '母亲', '母', 0xdfe9f2, 3.4, 6.0, 0.7);
  makeMember(1, '老人', '老', 0xd7c9a8, 3.0, 4.8, 1.0);
  makeMember(2, '青年', '青', 0xa8d8e8, 4.1, 7.0, 1.35);

  let active = 0;

  // —— 终点 ——
  const goal = new THREE.Group();
  const goalRing = new THREE.Mesh(
    new THREE.RingGeometry(3.4, 4.2, 32),
    new THREE.MeshBasicMaterial({ color: 0x7ef0c0, transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
  );
  goalRing.rotation.x = -Math.PI / 2;
  goalRing.position.y = 0.07;
  goal.add(goalRing);
  const goalPillar = new THREE.Mesh(
    new THREE.CylinderGeometry(3.4, 3.4, 9, 20, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x7ef0c0, transparent: true, opacity: 0.07, side: THREE.DoubleSide }),
  );
  goalPillar.position.y = 4.5;
  goal.add(goalPillar);
  goal.position.set(GOAL.x, 0, GOAL.z);
  scene.add(goal);

  // —— 巡逻 ——
  const patrolMat = new THREE.MeshToonMaterial({ color: 0x8a4a3a, emissive: 0x2a0f0a, emissiveIntensity: 0.7 });
  const coneMat = new THREE.MeshBasicMaterial({
    color: 0xffb765,
    transparent: true,
    opacity: 0.07,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  const makePatrol = (
    waypoints: Array<[number, number]>,
    speed: number,
    range: number,
    fovDeg: number,
  ): PatrolState => {
    const g = new THREE.Group();
    const b = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 1.0, 4, 10), patrolMat);
    b.position.y = 0.9;
    g.add(b);
    const half = THREE.MathUtils.degToRad(fovDeg) / 2;
    const coneGeo = new THREE.RingGeometry(0.6, range, 28, 1, Math.PI / 2 - half, half * 2);
    coneGeo.rotateX(-Math.PI / 2);
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.position.y = 0.12;
    cone.renderOrder = 2;
    g.add(cone);
    const wp = waypoints.map(([x, z]) => new THREE.Vector3(x, 0, z));
    g.position.copy(wp[0]!);
    scene.add(g);
    return {
      mesh: g,
      cone,
      waypoints: wp,
      leg: 0,
      dir: 1,
      alert: 0,
      seen: false,
      speed,
      range,
      fov: half,
      investigate: null,
      wait: 0,
    };
  };

  const patrols: PatrolState[] = [
    makePatrol([[34, 0], [62, 0]], 1.5, 15, 62),
    makePatrol([[52, -9], [70, -14], [70, -4]], 1.3, 13, 70),
    makePatrol([[0, -22], [0, 22]], 1.4, 14, 66),
  ];
  for (const p of patrols) {
    const next = p.waypoints[1] ?? p.waypoints[0]!;
    p.mesh.rotation.y = Math.atan2(next.x - p.mesh.position.x, next.z - p.mesh.position.z);
  }

  // —— 老人能力：巡逻下一段路线（规划阶段可见）——
  const revealLines: THREE.Line[] = patrols.map(() => {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const line = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color: 0xffb765, transparent: true, opacity: 0.5 }),
    );
    line.visible = false;
    line.frustumCulled = false;
    scene.add(line);
    return line;
  });

  // —— 噪声环 ——
  const noiseGeo = new THREE.RingGeometry(0.86, 1, 40);
  noiseGeo.rotateX(-Math.PI / 2);
  const noises: NoiseEvent[] = [];
  const pool: THREE.Mesh[] = [];
  for (let i = 0; i < 12; i += 1) {
    const m = new THREE.Mesh(
      noiseGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffd9a0,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    m.visible = false;
    m.position.y = 0.1;
    m.renderOrder = 4;
    scene.add(m);
    pool.push(m);
  }
  const emitNoise = (x: number, z: number, radius: number): void => {
    const ring = pool.find((m) => !m.visible);
    if (!ring) return;
    ring.visible = true;
    ring.position.set(x, 0.1, z);
    ring.scale.setScalar(0.3);
    noises.push({ pos: new THREE.Vector3(x, 0, z), radius, age: 0, ring });
    for (const p of patrols) {
      const d = Math.hypot(p.mesh.position.x - x, p.mesh.position.z - z);
      if (d > radius) continue;
      if (nav.blocked(p.mesh.position.x, p.mesh.position.z, x, z)) continue;
      p.alert = Math.min(1, p.alert + 0.26 * (1 - d / radius));
      p.investigate = new THREE.Vector3(x, 0, z);
      p.wait = 0;
    }
  };

  // —— 状态 ——
  const keys = new Set<string>();
  let phase: Phase = 'plan';
  let runLeft = 0;
  let turn = 1;
  let crouch = false;
  let won = false;
  let lost = false;
  let rainHeavy = false;
  const noiseAccum = { dist: 0 };
  const activeMember = (): Member => members[active]!;

  const reset = (): void => {
    members.forEach((m, i) => {
      m.out = false;
      m.seen = false;
      m.spent = 0;
      m.group.position.set(START[i]![0], 0, START[i]![1]);
    });
    active = 0;
    won = false;
    lost = false;
    turn = 1;
    phase = 'plan';
    runLeft = 0;
    noiseAccum.dist = 0;
    for (const p of patrols) {
      p.alert = 0;
      p.investigate = null;
      p.wait = 0;
      p.mesh.position.copy(p.waypoints[0]!);
      p.leg = 0;
      p.dir = 1;
    }
    for (const n of noises) n.ring.visible = false;
    noises.length = 0;
    setDawnProgress(1);
    hideBanner();
  };

  const endTurn = (): void => {
    if (won || lost || phase === 'run') return;
    phase = 'run';
    runLeft = TURN_SECONDS;
  };

  /** 青年：拉闸灭灯 —— 在光照图上压出一个暗区 */
  const sabotage = (): boolean => {
    const m = activeMember();
    if (m.short !== '青' || m.out) return false;
    if (m.spent > 0.01) return false;
    const p = m.group.position;
    if (exposure.at(p.x, p.z) < 0.25) return false;
    exposure.dim(p.x, p.z, 5.5);
    // 拉闸很响：自己这一格立刻招人
    emitNoise(p.x, p.z, 14);
    m.spent = m.budget;
    return true;
  };

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyG') {
      exposure.setOverlayVisible(!exposure.overlayVisible);
      return;
    }
    if (e.code === 'KeyR') {
      reset();
      return;
    }
    if (e.code === 'Space' || e.code === 'Enter') {
      e.preventDefault();
      endTurn();
      return;
    }
    if (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3') {
      const i = Number(e.code.slice(5)) - 1;
      if (members[i] && !members[i]!.out) active = i;
      return;
    }
    if (e.code === 'KeyF') {
      sabotage();
      return;
    }
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));

  function resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);
    orbit.setSize(w, h);
    post.setSize(w, h);
    updateOutlineAspect(w / h);
  }
  window.addEventListener('resize', resize);
  updateOutlineAspect(window.innerWidth / window.innerHeight);

  orbit.controls.autoRotate = false;
  orbit.controls.minDistance = 12;
  orbit.controls.maxDistance = 90;
  orbit.controls.target.set(START[1]![0], 1, START[1]![1]);
  orbit.camera.position.set(START[1]![0] - 20, 34, START[1]![1] + 30);

  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const tmp = new THREE.Vector3();
  const clock = new THREE.Clock();
  let frames = 0;

  function moveActive(dt: number): void {
    const m = activeMember();
    if (m.out) return;
    crouch = keys.has('ControlLeft') || keys.has('KeyC');
    const cap = crouch ? m.budget * 0.6 : m.budget;
    let mx = 0;
    let mz = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) mz += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) mz -= 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) mx -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) mx += 1;
    // 本回合走完了还按方向键：直接推进回合，而不是让玩家以为卡住了
    if (m.spent >= cap && (mx !== 0 || mz !== 0)) {
      endTurn();
      return;
    }
    if (m.spent >= cap) return;
    if (mx === 0 && mz === 0) return;
    const speed = m.speed * (crouch ? 0.62 : keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1.5 : 1);

    orbit.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-5) forward.set(0, 0, -1);
    forward.normalize();
    right.crossVectors(forward, up).normalize();
    const len = Math.hypot(mx, mz);
    let dx = ((forward.x * mz + right.x * mx) / len) * speed * dt;
    let dz = ((forward.z * mz + right.z * mx) / len) * speed * dt;
    const step = Math.hypot(dx, dz);
    const left = cap - m.spent;
    if (step > left) {
      const k = left / step;
      dx *= k;
      dz *= k;
    }
    const p = m.group.position;
    let moved = 0;
    if (nav.canStand(p.x + dx, p.z + dz)) {
      p.x += dx;
      p.z += dz;
      moved = Math.hypot(dx, dz);
    } else if (nav.canStand(p.x + dx, p.z)) {
      p.x += dx;
      moved = Math.abs(dx);
    } else if (nav.canStand(p.x, p.z + dz)) {
      p.z += dz;
      moved = Math.abs(dz);
    }
    m.spent += moved;
    noiseAccum.dist += moved;
    if (noiseAccum.dist > 1.2) {
      noiseAccum.dist = 0;
      const base = crouch ? 3.2 : keys.has('ShiftLeft') || keys.has('ShiftRight') ? 16 : 8;
      emitNoise(p.x, p.z, base * m.noiseMul * (rainHeavy ? 0.55 : 1));
    }
  }

  function advancePatrols(dt: number): void {
    for (const p of patrols) {
      let target: THREE.Vector3;
      if (p.investigate) {
        target = p.investigate;
        if (p.mesh.position.distanceTo(target) < 1.2) {
          p.wait += dt;
          if (p.wait > 2.5) {
            p.investigate = null;
            p.wait = 0;
          }
          continue;
        }
      } else {
        target = p.waypoints[p.leg]!;
        if (p.mesh.position.distanceTo(target) < 0.4) {
          p.leg += p.dir;
          if (p.leg >= p.waypoints.length) {
            p.leg = p.waypoints.length - 2;
            p.dir = -1;
          } else if (p.leg < 0) {
            p.leg = 1;
            p.dir = 1;
          }
          target = p.waypoints[p.leg]!;
        }
      }
      tmp.subVectors(target, p.mesh.position);
      tmp.y = 0;
      if (tmp.length() > 0.05) {
        tmp.normalize();
        const next = p.mesh.position.clone().addScaledVector(tmp, p.speed * dt);
        if (nav.canStand(next.x, next.z)) p.mesh.position.copy(next);
        const want = Math.atan2(tmp.x, tmp.z);
        let diff = want - p.mesh.rotation.y;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        p.mesh.rotation.y += diff * Math.min(1, dt * 6);
      }
    }
  }

  function updateDetection(dt: number): number {
    let worst = 0;
    for (const p of patrols) {
      let bestGain = 0;
      let anySeen = false;
      for (const m of members) {
        m.seen = false;
        if (m.out) continue;
        const ex = exposure.at(m.group.position.x, m.group.position.z);
        const effRange = p.range * (0.55 + 0.8 * ex) * (crouch ? 0.72 : 1) * (rainHeavy ? 0.85 : 1);
        tmp.subVectors(m.group.position, p.mesh.position);
        tmp.y = 0;
        const dd = tmp.length();
        if (dd >= effRange || dd <= 0.01) continue;
        const fwd = new THREE.Vector3(Math.sin(p.mesh.rotation.y), 0, Math.cos(p.mesh.rotation.y));
        if (fwd.dot(tmp.clone().normalize()) <= Math.cos(p.fov)) continue;
        if (nav.blocked(p.mesh.position.x, p.mesh.position.z, m.group.position.x, m.group.position.z)) continue;
        m.seen = true;
        anySeen = true;
        bestGain = Math.max(bestGain, (1 - dd / effRange) * (0.75 + 0.75 * ex));
      }
      p.seen = anySeen;
      if (dt > 0) {
        p.alert = THREE.MathUtils.clamp(p.alert + (anySeen ? bestGain * dt * 1.9 : -dt * 0.35), 0, 1);
        // 警觉满：抓走最近的一个可见成员
        if (p.alert >= 1) {
          const target = members
            .filter((m) => !m.out)
            .sort(
              (a, b) =>
                a.group.position.distanceTo(p.mesh.position) - b.group.position.distanceTo(p.mesh.position),
            )[0];
          if (target && target.group.position.distanceTo(p.mesh.position) < 18) {
            target.out = true;
            target.group.visible = false;
            p.alert = 0.35;
            if (members.every((m) => m.out)) {
              lost = true;
              showBanner('全员被抓', '按 R 重新开始');
            } else {
              showBanner(`${target.name}被抓了`, `还剩 ${members.filter((m) => !m.out).length} 人 · 按 R 重来`);
              if (members[active]!.out) {
                const nextIdx = members.findIndex((m) => !m.out);
                if (nextIdx >= 0) active = nextIdx;
              }
              window.setTimeout(() => {
                if (!lost && !won) hideBanner();
              }, 1600);
            }
          }
          p.alert = 0.35;
        }
      }
      const cm = p.cone.material as THREE.MeshBasicMaterial;
      cm.opacity = 0.05 + 0.22 * p.alert;
      cm.color.setHex(anySeen ? 0xff7a4a : p.investigate ? 0xffd27a : 0xffb765);
      worst = Math.max(worst, p.alert);
    }
    return worst;
  }

  function ageNoises(dt: number): void {
    for (let i = noises.length - 1; i >= 0; i -= 1) {
      const n = noises[i]!;
      n.age += dt;
      const k = n.age / 0.85;
      if (k >= 1) {
        n.ring.visible = false;
        noises.splice(i, 1);
        continue;
      }
      n.ring.scale.setScalar(0.3 + n.radius * k);
      (n.ring.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - k);
    }
  }

  function updateReveal(): void {
    const show = activeMember().short === '老' && !activeMember().out && phase === 'plan';
    patrols.forEach((p, i) => {
      const line = revealLines[i]!;
      line.visible = show;
      if (!show) return;
      const target = p.investigate ?? p.waypoints[p.leg]!;
      const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      pos.setXYZ(0, p.mesh.position.x, 0.25, p.mesh.position.z);
      pos.setXYZ(1, target.x, 0.25, target.z);
      pos.needsUpdate = true;
      line.geometry.computeBoundingSphere();
    });
  }

  function updateHud(worst: number): void {
    if (!hud) return;
    const m = activeMember();
    const ex = exposure.at(m.group.position.x, m.group.position.z);
    const left = Math.max(0, (crouch ? m.budget * 0.6 : m.budget) - m.spent);
    const rows = members
      .map((mm, i) => {
        const cls = mm.out ? 'dead' : i === active ? 'on' : '';
        const st = mm.out ? '出局' : mm.seen ? '暴露中' : `${(mm.budget - mm.spent).toFixed(1)}m`;
        return `<span class="m ${cls}">${i + 1} ${mm.short}</span><b class="${mm.seen ? 'hot' : mm.out ? 'dead' : ''}">${st}</b>`;
      })
      .join('');
    const drained = left <= 0.01;
    // 脚下光圈：预算用完变琥珀色，不用读文字也知道该推进了
    (m.ring.material as THREE.MeshBasicMaterial).color.setHex(drained ? 0xffb765 : m.color);
    hud.innerHTML = [
      `<span class="k">回合</span><b>${turn} / ${DAWN_TURNS}</b>`,
      `<span class="k">雨</span><b class="${rainHeavy ? 'cool' : 'warm'}">${rainHeavy ? '大（掩护）' : '小'}</b>`,
      rows,
      `<span class="k">当前</span><b class="${drained ? 'hot' : ''}">${m.name} · 剩 ${left.toFixed(1)} m</b>`,
      `<span class="k">暴露度</span><b class="${ex > 0.5 ? 'hot' : ex > 0.25 ? 'warm' : 'cool'}">${Math.round(ex * 100)}%</b>`,
      `<span class="k">巡逻警觉</span><b class="${worst > 0.6 ? 'hot' : worst > 0.25 ? 'warm' : 'cool'}">${Math.round(worst * 100)}%</b>`,
      `<i class="${drained && phase === 'plan' ? 'warm' : ''}">${
        phase === 'run'
          ? '推进中…'
          : drained
            ? '本回合走完了 · 空格 推进（或直接按方向键）'
            : m.short === '青' && ex > 0.25
              ? '空格 结束回合 · F 拉闸灭灯 · 1/2/3 切人'
              : '空格 结束回合 · 1/2/3 切人'
      }</i>`,
    ].join('');
  }

  function frame(): void {
    frames += 1;
    const dt = Math.min(clock.getDelta(), 0.05);
    ticker.update(dt);

    if (!won && !lost) {
      rainHeavy = Math.sin(performance.now() * 0.00035) > 0;
      if (phase === 'plan') {
        moveActive(dt);
        ageNoises(dt);
        updateDetection(0);
      } else {
        runLeft -= dt;
        advancePatrols(dt);
        ageNoises(dt);
        updateDetection(dt);
        if (runLeft <= 0) {
          phase = 'plan';
          turn += 1;
          for (const m of members) m.spent = 0;
          noiseAccum.dist = 0;
          setDawnProgress(turn);
          if (turn > DAWN_TURNS) {
            lost = true;
            showBanner('天亮了', '按 R 重新开始');
          }
        }
      }
      updateReveal();
      const anyone = members.find((m) => !m.out && m.group.position.distanceTo(GOAL) < 4.5);
      if (anyone) {
        won = true;
        showBanner('穿过去了', `${anyone.name} 到了 · 用了 ${turn} 回合 · 按 R 再来`);
      }
      updateHud(Math.max(...patrols.map((p) => p.alert)));
    } else {
      updateReveal();
      updateDetection(0);
    }

    const m = activeMember();
    orbit.controls.target.lerp(
      new THREE.Vector3(m.group.position.x, 1.1, m.group.position.z),
      1 - Math.pow(0.001, dt),
    );
    orbit.update(dt);
    day.update(dt);
    post.render(dt);
    requestAnimationFrame(frame);
  }

  // —— 预热 ——
  // 不预热的话前几帧只有 1~3 fps（着色器编译 + 贴图/几何上传），
  // 而 dt 被钳在 0.05 s，玩家按住方向键几乎不动 —— 表现就是"人物走不动"。
  // 先把编译和首帧吃掉，再开放操作。
  renderer.compile(scene, orbit.camera);
  renderer.shadowMap.needsUpdate = false;
  post.render(0);
  renderer.shadowMap.needsUpdate = true;

  (window as unknown as { __protoDebug?: unknown }).__protoDebug = {
    THREE,
    scene,
    members,
    patrols,
    nav,
    exposure,
    state: () => ({
      won,
      lost,
      turn,
      phase,
      active,
      crouched: crouch,
      rainHeavy,
      out: members.map((m) => m.out),
    }),
    select: (i: number) => {
      if (members[i] && !members[i]!.out) active = i;
    },
    teleport: (x: number, z: number, i = active) => members[i]!.group.position.set(x, 0, z),
    endTurn,
    reset,
    emitNoise,
    sabotage,
    probe: () => ({ frames, keys: [...keys], crouch, phase, active }),
  };
  (window as unknown as { __protoReady?: boolean }).__protoReady = true;
  requestAnimationFrame(frame);
}

void boot();
