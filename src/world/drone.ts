import * as THREE from 'three';
import type { BuildContext } from '../core/context';
import { at, box, cyl, cylinderBetween, group, mergeMeshes, mesh, sphere } from '../core/geo';
import { basicMaterial, canvasTexture, glowMaterial, toonMaterial } from '../core/materials';
import { HOTSPOTS } from './layout';

/**
 * 侦查四旋翼无人机：半径约 0.36m 的小机器，在 21m 高空缓慢盘旋。
 *
 * 保持"被看见"比"写实"更重要：
 *  - 旋翼用半透明薄盘 + 慢转的桨叶剪影表示转动
 *  - 红色/绿色航灯用 glowMaterial 短闪（1.5-3s 一次）
 *  - 机身朝飞行方向微微侧倾
 *
 * 本模块不加描边（高空小物体描边只会变成噪点）。
 */

const DRONE_BODY = 0x24272b;
const DRONE_DARK = 0x14161a;
const DRONE_LIGHT = 0x3b4046;

export function buildDrone(ctx: BuildContext): THREE.Group {
  const spot = HOTSPOTS.drone;
  const rng = ctx.rng.fork(0xd20e);

  const root = group('drone');
  root.position.set(spot.x + spot.radius, spot.y, spot.z);

  const bodyMat = toonMaterial(DRONE_BODY, { steps: 2 });
  const darkMat = toonMaterial(DRONE_DARK, { steps: 2 });
  const lightMat = toonMaterial(DRONE_LIGHT, { steps: 2 });

  // 侧倾/俯仰放在内层，避免和航向 yaw 打架
  const tilt = group('drone-tilt');
  root.add(tilt);

  // —— 机身 ——
  const fuselage = box(0.15, 0.09, 0.32, bodyMat);
  at(fuselage, 0, 0, 0);
  tilt.add(fuselage);

  const nose = box(0.10, 0.06, 0.12, darkMat);
  at(nose, 0, -0.005, 0.19);
  tilt.add(nose);

  const shell = box(0.17, 0.035, 0.24, lightMat);
  at(shell, 0, 0.055, -0.02);
  tilt.add(shell);

  const battery = box(0.11, 0.045, 0.13, darkMat);
  at(battery, 0, 0.09, -0.03);
  tilt.add(battery);

  // —— 机臂（四根斜撑，合并为一个 mesh） ——
  const armBits: THREE.Mesh[] = [];
  const armEnds: Array<[number, number]> = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const ex = sx * 0.20;
      const ez = sz * 0.20;
      armEnds.push([ex, ez]);
      const arm = cylinderBetween(
        new THREE.Vector3(sx * 0.05, 0, sz * 0.07),
        new THREE.Vector3(ex, 0.012, ez),
        0.012,
        lightMat,
        5,
      );
      armBits.push(arm);
    }
  }
  const arms = mergeMeshes(armBits, lightMat);
  if (arms) {
    arms.name = 'drone-arms';
    tilt.add(arms);
  }

  // —— 电机 + 旋翼 ——
  const motorBits: THREE.Mesh[] = [];
  const rotorPivots: THREE.Group[] = [];
  const discMat = basicMaterial(0x9fb6c6, { opacity: 0.16, side: THREE.DoubleSide, unique: true });
  const bladeMat = toonMaterial(0x2c3035, { steps: 2 });

  for (const [ex, ez] of armEnds) {
    const motor = cyl(0.035, 0.032, 0.035, 8, darkMat);
    at(motor, ex, 0.025, ez);
    motorBits.push(motor);

    const pivot = group('rotor');
    pivot.position.set(ex, 0.055, ez);
    tilt.add(pivot);
    rotorPivots.push(pivot);

    // 半透明旋翼盘（转动模糊）——略微夸张，21m 高空也能看出是四旋翼
    const disc = mesh(new THREE.CircleGeometry(0.19, 16), discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.castShadow = false;
    disc.receiveShadow = false;
    pivot.add(disc);

    // 桨叶剪影：慢慢转，能看出在转
    const blade = box(0.38, 0.004, 0.03, bladeMat);
    at(blade, 0, 0.002, 0);
    pivot.add(blade);
    const blade2 = box(0.03, 0.004, 0.38, bladeMat);
    at(blade2, 0, 0.002, 0);
    pivot.add(blade2);
  }
  const motors = mergeMeshes(motorBits, darkMat);
  if (motors) {
    motors.name = 'drone-motors';
    tilt.add(motors);
  }

  // —— 下挂光电球 ——
  const gimbalYoke = box(0.05, 0.06, 0.05, darkMat);
  at(gimbalYoke, 0, -0.07, 0.06);
  tilt.add(gimbalYoke);
  const gimbal = sphere(0.05, darkMat, 10);
  at(gimbal, 0, -0.115, 0.085);
  tilt.add(gimbal);
  const lens = cyl(0.028, 0.028, 0.02, 10, glowMaterial(0x2f6f7a, 0.85));
  at(lens, 0, -0.118, 0.128);
  lens.rotation.x = Math.PI / 2;
  tilt.add(lens);

  // —— 起落架 ——
  const skidBits: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) {
    const leg = cylinderBetween(
      new THREE.Vector3(sx * 0.055, -0.045, 0.06),
      new THREE.Vector3(sx * 0.085, -0.115, 0.09),
      0.008,
      darkMat,
      4,
    );
    skidBits.push(leg);
    const skid = cylinderBetween(
      new THREE.Vector3(sx * 0.085, -0.115, -0.09),
      new THREE.Vector3(sx * 0.085, -0.115, 0.14),
      0.008,
      darkMat,
      4,
    );
    skidBits.push(skid);
  }
  const skids = mergeMeshes(skidBits, darkMat);
  if (skids) {
    skids.name = 'drone-skids';
    tilt.add(skids);
  }

  // —— 天线 ——
  const antA = cylinderBetween(new THREE.Vector3(-0.04, 0.05, -0.14), new THREE.Vector3(-0.07, 0.20, -0.20), 0.005, darkMat, 4);
  tilt.add(antA);
  const antB = cylinderBetween(new THREE.Vector3(0.04, 0.05, -0.14), new THREE.Vector3(0.06, 0.17, -0.21), 0.005, darkMat, 4);
  tilt.add(antB);

  // —— 航灯：红（左后）/ 绿（右前），外加顶部可辨识的小灯点 ——
  const lampGeo = new THREE.SphereGeometry(0.034, 8, 6);
  const redMat = glowMaterial(0xff4a3a, 0.96);
  const greenMat = glowMaterial(0x54ff8e, 0.96);
  const redLamp = mesh(lampGeo, redMat);
  at(redLamp, -0.20, 0.045, -0.20);
  redLamp.castShadow = false;
  tilt.add(redLamp);
  const greenLamp = mesh(lampGeo, greenMat);
  at(greenLamp, 0.20, 0.045, 0.20);
  greenLamp.castShadow = false;
  tilt.add(greenLamp);
  // 白色防撞闪灯（顶部，俯视时能看到）
  const strobeMat = glowMaterial(0xe8f4ff, 0.96);
  const strobe = mesh(new THREE.SphereGeometry(0.03, 8, 6), strobeMat);
  at(strobe, 0, 0.10, 0.02);
  strobe.castShadow = false;
  tilt.add(strobe);

  /* ——— 远景可读性：机身放大到 1.2m 级，航灯外加一层柔光晕 ——— */
  // 相机默认机位离模型 ~100m，原尺寸（0.78m）只有 6-8 px；放大 + 光晕后航灯才看得见
  tilt.scale.setScalar(1.55);

  const haloTex = canvasTexture(64, 64, (c, w, h) => {
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.5)');
    g.addColorStop(0.65, 'rgba(255,255,255,0.14)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  });
  const makeHalo = (color: number): THREE.Sprite => {
    const mat = new THREE.SpriteMaterial({
      map: haloTex,
      color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.setScalar(0.62);
    return sprite;
  };
  const redHalo = makeHalo(0xff5a44);
  at(redHalo, -0.20, 0.045, -0.20);
  tilt.add(redHalo);
  const greenHalo = makeHalo(0x66ffa0);
  at(greenHalo, 0.20, 0.045, 0.20);
  tilt.add(greenHalo);

  /* ——— 动效：盘旋 / 浮动 / 侧倾 / 旋翼 / 航灯 ——— */
  // layout 里给的 speed=0.045 rad/s 约 140s 一圈，太慢看不清盘旋；
  // 这里按"60-90s 一圈"的验收要求取 78s，半径与高度仍用 layout。
  const omega = (Math.PI * 2) / 78;
  const phase = rng.range(0, Math.PI * 2);
  const bobPhase = rng.range(0, Math.PI * 2);

  ctx.ticker.add((t) => {
    const a = t * omega + phase;
    root.position.x = spot.x + Math.cos(a) * spot.radius;
    root.position.z = spot.z + Math.sin(a) * spot.radius;
    root.position.y = spot.y + Math.sin(t * 0.55 + bobPhase) * 0.4;

    // 机头朝切线方向
    root.rotation.y = -a;

    // 进弯侧倾 + 轻微俯仰
    tilt.rotation.z = -0.16;
    tilt.rotation.x = Math.sin(t * 0.8 + bobPhase) * 0.035;

    // 旋翼：相邻旋翼反转，慢慢自转（半透明盘负责"糊"）
    rotorPivots.forEach((pivot, i) => {
      pivot.rotation.y = (i % 2 === 0 ? 1 : -1) * t * 7;
    });

    // 航灯短闪
    const redOn = t % 1.9 < 0.13 ? 1 : 0.05;
    const greenOn = (t + 0.9) % 2.7 < 0.13 ? 1 : 0.05;
    const strobeOn = t % 1.1 < 0.07 ? 1 : 0.04;
    redMat.opacity = redOn;
    greenMat.opacity = greenOn;
    strobeMat.opacity = strobeOn;
    redHalo.material.opacity = redOn * 0.62;
    greenHalo.material.opacity = greenOn * 0.62;
  });

  return root;
}
