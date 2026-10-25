import * as THREE from 'three';
import { PALETTE } from '../core/palette';
import { canvasTexture, glowMaterial, toonMaterial, withOutline } from '../core/materials';
import { at, box, cyl, group } from '../core/geo';
import type { BuildContext } from '../core/context';
import { HERO } from './layout';

/**
 * 收尾的小动效件——主楼上"会动的一点点"：
 *  - 巷子里从墙上松脱的镀锌铁皮：平时轻颤，阵风来时掀起再落回
 *  - 西立面挑出的旧药房灯箱：缓慢摆动 + 老式灯管接触不良的闪烁
 * 两件都不大，但正是让静止的微缩世界"活一口气"的地方。
 */

/** 铁皮：挂在主楼东侧小巷的墙上（巷子在 x 34~36） */
function metalSheet(): THREE.Group {
  const pivot = group('alley-sheet-pivot');
  const sheetMat = toonMaterial(0x8b9299, { steps: 3 });
  const sheet = box(0.035, 1.15, 0.62, sheetMat);
  at(sheet, 0.02, -0.575, 0);
  sheet.castShadow = true;
  pivot.add(sheet);

  // 两颗钉子：掀起时能看出是"铰在顶上"
  const nailMat = toonMaterial(PALETTE.rustDark, { steps: 2 });
  for (const z of [-0.22, 0.22]) {
    const nail = cyl(0.022, 0.022, 0.07, 6, nailMat);
    nail.rotation.z = Math.PI / 2;
    at(nail, 0.0, 0.0, z);
    pivot.add(nail);
  }

  // 铁皮下缘的锈迹
  const rustBand = box(0.045, 0.17, 0.6, toonMaterial(PALETTE.rust, { steps: 2 }));
  at(rustBand, 0.02, -1.06, 0);
  pivot.add(rustBand);
  return pivot;
}

/** 旧药房灯箱：从西立面挑出到人行道上空，正反两面都能看 */
function pharmacySign(): { pivot: THREE.Group; faceMat: THREE.MeshBasicMaterial; lampMat: THREE.MeshBasicMaterial } {
  const pivot = group('pharmacy-sign-pivot');

  const boardTex = canvasTexture(256, 384, (c, w, h) => {
    // 老式墨绿搪瓷底
    c.fillStyle = '#12321f';
    c.fillRect(0, 0, w, h);
    c.strokeStyle = '#c9c2a8';
    c.lineWidth = 10;
    c.strokeRect(12, 12, w - 24, h - 24);
    // 药房十字
    c.fillStyle = '#d9d2b8';
    c.fillRect(w / 2 - 16, 44, 32, 96);
    c.fillRect(w / 2 - 48, 76, 96, 32);
    // 竖排西里尔字母
    c.fillStyle = '#e6dfc4';
    c.font = 'bold 44px Georgia, serif';
    c.textAlign = 'center';
    const text = 'АПТЕКА';
    for (let i = 0; i < text.length; i += 1) {
      c.fillText(text[i] as string, w / 2, 200 + i * 30);
    }
    // 污渍与掉漆
    c.globalAlpha = 0.5;
    for (let i = 0; i < 26; i += 1) {
      const x = (i * 97) % w;
      const y = (i * 149) % h;
      c.fillStyle = i % 3 === 0 ? '#3a3a33' : '#0b1b12';
      c.fillRect(x, y, 8 + (i % 5) * 6, 4 + (i % 4) * 5);
    }
    // 一块破损（露出底板）
    c.globalAlpha = 1;
    c.fillStyle = '#2a2723';
    c.beginPath();
    c.moveTo(w - 78, h - 92);
    c.lineTo(w - 18, h - 118);
    c.lineTo(w - 24, h - 40);
    c.lineTo(w - 86, h - 30);
    c.closePath();
    c.fill();
  });

  const edgeMat = toonMaterial(0x1d2b23, { steps: 2 });
  const faceMat = new THREE.MeshBasicMaterial({ map: boardTex, color: 0xffffff, fog: true });
  const board = new THREE.Mesh(new THREE.BoxGeometry(0.72, 1.05, 0.12), [
    edgeMat,
    edgeMat,
    edgeMat,
    edgeMat,
    faceMat,
    faceMat,
  ]);
  board.castShadow = true;
  at(board, 0, -0.72, 0);
  pivot.add(board);

  // 吊挂横杆 + 两根吊钩
  const barMat = toonMaterial(0x33383d, { steps: 2 });
  const bar = box(0.62, 0.05, 0.05, barMat);
  at(bar, 0, -0.14, 0);
  pivot.add(bar);
  for (const x of [-0.28, 0.28]) {
    const hook = cyl(0.014, 0.014, 0.22, 6, barMat);
    at(hook, x, -0.26, 0);
    pivot.add(hook);
  }

  // 灯管发光面（贴在招牌前后外侧，负责泛光）
  const lampMat = glowMaterial(0xffc98a, 0.22);
  for (const z of [0.075, -0.075]) {
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.92), lampMat);
    at(halo, 0, -0.72, z);
    if (z < 0) halo.rotation.y = Math.PI;
    halo.castShadow = false;
    pivot.add(halo);
  }

  return { pivot, faceMat, lampMat };
}

export function buildExtras(ctx: BuildContext): THREE.Group {
  const extras = group('extras');

  // —— 巷子里的松脱铁皮（贴在主楼东墙外侧）——
  const sheet = metalSheet();
  at(sheet, HERO.x1 + 0.035, 6.15, -18.4);
  extras.add(sheet);

  // —— 药房灯箱（从西立面挑出到纵街东侧人行道上空）——
  const sign = pharmacySign();
  at(sign.pivot, HERO.x0 - 0.62, 4.85, -21.4);
  extras.add(sign.pivot);

  if (ctx.lightCount < 15) {
    const signLight = new THREE.PointLight(0xffc98a, 2.6, 7, 2);
    signLight.position.set(HERO.x0 - 0.62, 4.15, -21.4);
    ctx.addLight(signLight);
  }

  withOutline(sheet, 0.0018);
  withOutline(sign.pivot, 0.0018);

  ctx.ticker.add((t) => {
    // 铁皮：平时小幅轻颤，阵风来时掀起再落回
    const gust = Math.max(0, Math.sin(t * 0.31) * Math.sin(t * 0.17 + 1.2) - 0.35);
    const micro = Math.sin(t * 2.3) * 0.006 + Math.sin(t * 5.1 + 0.7) * 0.002;
    sheet.rotation.z = 0.05 + gust * 0.34 + micro;

    // 灯箱：缓慢摆动（6~9 秒一个来回）
    sign.pivot.rotation.x = Math.sin(t * 0.78) * 0.028 + Math.sin(t * 1.93 + 0.4) * 0.009;
    sign.pivot.rotation.z = Math.sin(t * 0.61 + 1.1) * 0.012;

    // 老灯管：以"通断"为主，偶尔连闪
    const dropout = Math.sin(t * 0.9) > 0.72; // 周期性进入接触不良期
    let level: number;
    if (dropout) {
      const n = Math.sin(t * 13.7) * Math.sin(t * 5.07 + 2.1);
      level = n > 0.15 ? 0.3 : 0.92;
    } else {
      level = 0.94 + 0.06 * Math.sin(t * 27.3);
    }
    sign.faceMat.color.setScalar(0.34 + 0.4 * level);
    sign.lampMat.opacity = 0.12 + 0.3 * level;
  });

  return extras;
}
