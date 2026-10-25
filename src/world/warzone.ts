import * as THREE from 'three';
import type { BuildContext } from '../core/context';
import type { Rng } from '../core/rng';
import {
  canvasTexture,
  glowMaterial,
  toonGradient,
  toonMaterial,
  withOutline,
} from '../core/materials';
import { chippedSlab, mergeAll, trackPadGeometry, vestGeometry } from '../core/detail';
import {
  addBatch,
  batchGroupByMaterial,
  box,
  cyl,
  cylinderBetween,
  group,
  instanced,
  jitter,
  mergeOutlineHulls,
  mesh,
  softBox,
  type InstanceTransform,
} from '../core/geo';
import { PALETTE } from '../core/palette';
import { ALLEYS, groundYAt } from './layout';
import { noteRefusal, reserve } from './occupancy';

/**
 * 战争废墟扩建层。
 *
 * 这里只做"低面数、高密度"的东西：
 *  - 两栋拦腰炸断的剖切楼：真实楼板截面 + 弯钢筋 + 残楼梯 + 室内墙纸；
 *  - 主干道大地陷：断裂沥青、泥水、混凝土碎块、半沉的汽车底盘；
 *  - 街角废墟堆、半掩埋防空洞、废弃民车；
 *  - 生活遗物（婴儿车 / 餐具 / 相框 / 玩具 / 行李 / 撕碎衣物）；
 *  - 贴花层（裂缝 / 弹孔 / 青苔 / 水渍）与 Alpha 交叉面片植被。
 *
 * 所有碎件一律进 InstancedMesh；贴花一律平面 + polygonOffset；植被与布料用
 * 面片内绘深色粗边来保持三渲二轮廓，不再生成描边壳。
 */

export const WARZONE = {
  cutaways: [
    { id: 'south', cx: 34, cz: 43.5, w: 14, d: 11, floors: 4, seed: 0x51a7 },
    { id: 'east', cx: 76, cz: -25, w: 16, d: 13, floors: 5, seed: 0x2c93 },
  ],
  sinkhole: { x: -44, z: 1.2, r: 6.8 },
  fractures: [
    { x: 55, z: 2.2, r: 4.2 },
    // 必须留在纵街的北向半幅：车队车道是 x∈[1.2,5.4]，断口压上去就是堵路
    { x: -4.4, z: 59, r: 3.2 },
  ],
  bunker: { x: 50.5, z: -10.6 },
  car: { x: 58.6, z: -6.3, rotY: 0.18 },
  vignette: { x: 31.5, z: 51.6 },
  rubble: [
    { x: 70.5, z: -14.5, r: 2.2 },
    { x: 42, z: 52.8, r: 1.7 },
  ],
  laundry: { x0: 30.5, x1: 39.5, z: 50.05, y: 7.2 },
  fallenSparks: [
    { x: -29.1, z: -9.9 },
    { x: 8.9, z: -119.1 },
  ],
  toxicSmoke: [
    { x: 124, z: -18, y: 9.5 },
    { x: 118, z: 60, y: 1.0 },
  ],
  whiteSmoke: [
    { x: 59.2, z: -6.5 },
    { x: -43.2, z: 2.4 },
  ],
} as const;

/* ------------------------------------------------------------------ *
 * 贴图：全部程序化，透明通道 + 面片内深色边
 * ------------------------------------------------------------------ */

function tornEdge(c: CanvasRenderingContext2D, w: number, h: number, seed: number, count = 9): void {
  c.save();
  c.globalCompositeOperation = 'destination-out';
  c.fillStyle = '#000';
  for (let i = 0; i < count; i += 1) {
    const n = Math.sin(seed * 12.9898 + i * 7.233) * 43758.5453;
    const t = n - Math.floor(n);
    const x = t * w;
    const y = Math.abs(Math.sin(seed + i * 1.7)) * h;
    const r = 3 + t * 7;
    c.beginPath();
    c.ellipse(x, y, r, r * 0.7, t * 6, 0, Math.PI * 2);
    c.fill();
  }
  c.restore();
}

function grassTexture(seed: number, dry = false): THREE.CanvasTexture {
  return canvasTexture(128, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const base = dry ? ['#4a4130', '#6a5a3e', '#88764c'] : ['#1c2e1c', '#2f4a2c', '#4a6b3e'];
    const rng = (n: number) => {
      const v = Math.sin(seed * 76.1 + n * 34.7) * 43758.5453;
      return v - Math.floor(v);
    };
    // 先画深色粗边（比刃体宽 4px），保证三渲二轮廓
    for (let i = 0; i < 9; i += 1) {
      const rootX = w * (0.18 + rng(i) * 0.64);
      const topX = rootX + (rng(i + 9) - 0.5) * w * 0.6;
      const topY = h * (0.05 + rng(i + 18) * 0.45);
      c.strokeStyle = '#070b07';
      c.lineWidth = 6 + rng(i + 27) * 3;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(rootX, h);
      c.quadraticCurveTo(rootX + (topX - rootX) * 0.4, h * 0.55, topX, topY);
      c.stroke();
      c.strokeStyle = base[i % base.length] as string;
      c.lineWidth = 3 + rng(i + 36) * 2;
      c.beginPath();
      c.moveTo(rootX, h);
      c.quadraticCurveTo(rootX + (topX - rootX) * 0.4, h * 0.55, topX, topY);
      c.stroke();
    }
    // 几片宽叶提亮
    c.fillStyle = dry ? '#9a8556' : '#5d7d48';
    for (let i = 0; i < 4; i += 1) {
      const x = w * (0.25 + rng(i + 50) * 0.5);
      const y = h * (0.2 + rng(i + 60) * 0.4);
      c.beginPath();
      c.ellipse(x, y, 5, 12, (rng(i + 70) - 0.5) * 1.2, 0, Math.PI * 2);
      c.fill();
    }
    tornEdge(c, w, h, seed, 4);
  });
}

function vineTexture(seed: number): THREE.CanvasTexture {
  return canvasTexture(192, 256, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const rand = (n: number) => {
      const v = Math.sin(seed * 41.3 + n * 67.9) * 43758.5453;
      return v - Math.floor(v);
    };
    const stems: Array<{ x: number; curl: number }> = [];
    for (let s = 0; s < 4; s += 1) stems.push({ x: w * (0.18 + rand(s) * 0.64), curl: (rand(s + 9) - 0.5) * 1.4 });
    for (const [si, stem] of stems.entries()) {
      const pts: THREE.Vector2[] = [];
      for (let i = 0; i <= 10; i += 1) {
        const t = i / 10;
        pts.push(new THREE.Vector2(stem.x + Math.sin(t * 5 + si * 2 + seed) * 16, h * (1 - t)));
      }
      // 粗黑边 + 深褐藤芯
      for (const [color, width] of [['#060a06', 9], ['#3a2d20', 4.5]] as Array<[string, number]>) {
        c.strokeStyle = color;
        c.lineWidth = width;
        c.lineCap = 'round';
        c.beginPath();
        c.moveTo(pts[0]!.x, pts[0]!.y);
        for (let i = 1; i < pts.length; i += 1) c.lineTo(pts[i]!.x, pts[i]!.y);
        c.stroke();
      }
      for (let l = 0; l < 22; l += 1) {
        const t = 0.06 + (l / 22) * 0.92;
        const y = h * (1 - t);
        const x = stem.x + Math.sin(t * 5 + si * 2 + seed) * 16;
        const side = l % 2 === 0 ? -1 : 1;
        const lx = x + side * (8 + rand(l + si * 20) * 14);
        const ly = y - 2 - rand(l + 30) * 10;
        c.fillStyle = '#060a06';
        c.beginPath();
        c.ellipse(lx, ly, 8, 4.5, side * 0.5, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = l % 4 === 0 ? '#5a4c2e' : l % 3 === 0 ? '#46603a' : '#3d5230';
        c.beginPath();
        c.ellipse(lx, ly, 6, 3, side * 0.5, 0, Math.PI * 2);
        c.fill();
      }
    }
    tornEdge(c, w, h, seed, 8);
  });
}

function clothTexture(seed: number, sheet = false): THREE.CanvasTexture {
  return canvasTexture(160, 200, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    // 布面轮廓：底边撕成条
    c.fillStyle = sheet ? '#b9b4a4' : '#9aa2a6';
    c.beginPath();
    c.moveTo(w * 0.08, 0);
    c.lineTo(w * 0.92, 0);
    for (let i = 10; i >= 0; i -= 1) {
      const t = i / 10;
      c.lineTo(w * (0.08 + 0.84 * t), h * (0.9 + Math.sin(seed + i * 2.7) * 0.08));
    }
    c.closePath();
    c.fill();
    // 黑边
    c.strokeStyle = '#080b0c';
    c.lineWidth = 6;
    c.stroke();
    // 褶皱
    c.strokeStyle = 'rgba(40,48,52,0.5)';
    c.lineWidth = 1.5;
    for (let i = 0; i < 8; i += 1) {
      const x = w * (0.12 + i * 0.1);
      c.beginPath();
      c.moveTo(x, 2);
      c.bezierCurveTo(x + 8, h * 0.3, x - 8, h * 0.6, x + 4, h * 0.88);
      c.stroke();
    }
    // 污渍与破洞
    c.fillStyle = 'rgba(45,40,32,0.35)';
    for (let i = 0; i < 7; i += 1) {
      const x = w * (0.15 + Math.abs(Math.sin(seed + i)) * 0.7);
      const y = h * (0.15 + Math.abs(Math.cos(seed * 2 + i)) * 0.65);
      c.beginPath();
      c.ellipse(x, y, 6 + (i % 3) * 4, 4 + (i % 4) * 3, i, 0, Math.PI * 2);
      c.fill();
    }
    c.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 4; i += 1) {
      const x = w * (0.2 + Math.abs(Math.sin(seed * 3 + i * 2)) * 0.6);
      const y = h * (0.3 + Math.abs(Math.cos(seed + i)) * 0.5);
      c.beginPath();
      c.ellipse(x, y, 4 + i * 2, 7 + i * 2, i, 0, Math.PI * 2);
      c.fill();
    }
    c.globalCompositeOperation = 'source-over';
  });
}

function wallpaperTexture(seed: number): THREE.CanvasTexture {
  return canvasTexture(256, 256, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const warm = seed % 2 === 0;
    c.fillStyle = warm ? '#8f7c62' : '#7f8985';
    c.fillRect(0, 0, w, h);
    // 竖条纹
    c.fillStyle = warm ? '#a08a6c' : '#909b96';
    for (let x = 0; x < w; x += 26) c.fillRect(x, 0, 9, h);
    // 褪色花点
    c.fillStyle = warm ? 'rgba(120,88,64,0.55)' : 'rgba(92,112,102,0.55)';
    for (let i = 0; i < 40; i += 1) {
      const x = (i * 71 + seed * 13) % w;
      const y = (i * 43 + seed * 29) % h;
      c.beginPath();
      c.ellipse(x, y, 5, 9, i, 0, Math.PI * 2);
      c.fill();
    }
    // 水渍、霉斑
    c.fillStyle = 'rgba(28,32,27,0.35)';
    for (let i = 0; i < 12; i += 1) {
      const x = (i * 97) % w;
      c.fillRect(x, 0, 3 + (i % 4) * 3, h * (0.25 + (i % 5) * 0.12));
    }
    // 撕掉一大块 + 边缘破洞
    c.globalCompositeOperation = 'destination-out';
    c.beginPath();
    c.moveTo(w * 0.62, h);
    c.lineTo(w * 0.58, h * 0.55);
    c.lineTo(w * 0.75, h * 0.42);
    c.lineTo(w * 0.72, h);
    c.closePath();
    c.fill();
    for (let i = 0; i < 7; i += 1) {
      const x = Math.abs(Math.sin(seed * 7 + i * 3)) * w;
      const y = Math.abs(Math.cos(seed * 3 + i * 5)) * h;
      c.beginPath();
      c.arc(x, y, 3 + i, 0, Math.PI * 2);
      c.fill();
    }
    c.globalCompositeOperation = 'source-over';
  });
}

function crackTexture(seed: number): THREE.CanvasTexture {
  return canvasTexture(128, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const rand = (n: number) => {
      const v = Math.sin(seed + n * 91.7) * 43758.5453;
      return v - Math.floor(v);
    };
    const startX = w * (0.35 + rand(1) * 0.3);
    const branches: Array<{ x: number; y: number; a: number; len: number; w: number }> = [
      { x: startX, y: h * 0.04, a: Math.PI / 2, len: h * 0.9, w: 3.4 },
    ];
    for (let i = 0; i < 13; i += 1) {
      const b = branches[i % branches.length]!;
      const t = 0.2 + rand(i + 5) * 0.7;
      branches.push({
        x: b.x + Math.cos(b.a) * b.len * t,
        y: b.y + Math.sin(b.a) * b.len * t,
        a: b.a + (rand(i + 20) - 0.5) * 1.6,
        len: h * (0.2 + rand(i + 30) * 0.4),
        w: Math.max(0.8, b.w * 0.6),
      });
    }
    for (const b of branches) {
      c.strokeStyle = 'rgba(5,7,9,0.9)';
      c.lineWidth = b.w + 1.5;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(b.x, b.y);
      c.lineTo(b.x + Math.cos(b.a) * b.len, b.y + Math.sin(b.a) * b.len);
      c.stroke();
      c.strokeStyle = 'rgba(130,135,132,0.28)';
      c.lineWidth = Math.max(0.5, b.w - 0.8);
      c.beginPath();
      c.moveTo(b.x, b.y);
      c.lineTo(b.x + Math.cos(b.a) * b.len, b.y + Math.sin(b.a) * b.len);
      c.stroke();
    }
  });
}

function bulletTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 64, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.fillStyle = 'rgba(12,14,16,0.95)';
    c.beginPath();
    c.arc(w / 2, h / 2, 7, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = 'rgba(150,148,138,0.28)';
    c.lineWidth = 4;
    c.beginPath();
    c.arc(w / 2, h / 2, 14, 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = 'rgba(20,22,22,0.5)';
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2;
      c.beginPath();
      c.arc(w / 2 + Math.cos(a) * 18, h / 2 + Math.sin(a) * 18, 2 + (i % 3), 0, Math.PI * 2);
      c.fill();
    }
  });
}

function mossTexture(seed: number): THREE.CanvasTexture {
  return canvasTexture(128, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const rand = (n: number) => {
      const v = Math.sin(seed * 13.3 + n * 47.1) * 43758.5453;
      return v - Math.floor(v);
    };
    for (let i = 0; i < 70; i += 1) {
      const x = rand(i) * w;
      const y = rand(i + 80) * h;
      const r = 2 + rand(i + 160) * 8;
      c.fillStyle = i % 4 === 0 ? 'rgba(34,58,30,0.55)' : i % 3 === 0 ? 'rgba(50,76,38,0.5)' : 'rgba(28,48,28,0.4)';
      c.beginPath();
      c.ellipse(x, y, r, r * (0.4 + rand(i + 240) * 0.5), rand(i + 320) * 6, 0, Math.PI * 2);
      c.fill();
    }
    // 边缘淡出
    c.globalCompositeOperation = 'destination-in';
    const g = c.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w * 0.52);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    c.globalCompositeOperation = 'source-over';
  });
}

function stainTexture(seed: number): THREE.CanvasTexture {
  return canvasTexture(96, 256, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(18,24,24,0.55)');
    g.addColorStop(0.55, 'rgba(22,28,28,0.28)');
    g.addColorStop(1, 'rgba(24,30,28,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    const rand = (n: number) => {
      const v = Math.sin(seed + n * 19.7) * 43758.5453;
      return v - Math.floor(v);
    };
    c.fillStyle = 'rgba(14,20,20,0.4)';
    for (let i = 0; i < 5; i += 1) {
      const x = w * (0.2 + rand(i) * 0.6);
      c.fillRect(x, 0, 2 + rand(i + 5) * 4, h * (0.4 + rand(i + 10) * 0.5));
    }
    c.globalCompositeOperation = 'destination-in';
    const fade = c.createLinearGradient(0, 0, w, 0);
    fade.addColorStop(0, 'rgba(255,255,255,0)');
    fade.addColorStop(0.25, 'rgba(255,255,255,1)');
    fade.addColorStop(0.75, 'rgba(255,255,255,1)');
    fade.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = fade;
    c.fillRect(0, 0, w, h);
    c.globalCompositeOperation = 'source-over';
  });
}

function waterTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 256, (c, w, h) => {
    const base = c.createLinearGradient(0, 0, w, h);
    base.addColorStop(0, '#2b3d44');
    base.addColorStop(0.5, '#18272d');
    base.addColorStop(1, '#243940');
    c.fillStyle = base;
    c.fillRect(0, 0, w, h);
    // 天光反照的水膜
    c.globalAlpha = 0.35;
    const glow = c.createRadialGradient(w * 0.45, h * 0.35, 8, w * 0.45, h * 0.35, w * 0.7);
    glow.addColorStop(0, '#7e9aa8');
    glow.addColorStop(0.5, '#3d5661');
    glow.addColorStop(1, 'rgba(10,18,22,0)');
    c.fillStyle = glow;
    c.fillRect(0, 0, w, h);
    // 波光
    c.globalAlpha = 0.5;
    for (let i = 0; i < 26; i += 1) {
      const y = (i * 37 + 11) % h;
      c.strokeStyle = i % 3 === 0 ? '#8ea7b1' : '#4c6772';
      c.lineWidth = i % 3 === 0 ? 1.5 : 0.8;
      c.beginPath();
      c.moveTo(0, y);
      for (let x = 0; x <= w; x += 16) c.lineTo(x, y + Math.sin(x * 0.09 + i) * 3);
      c.stroke();
    }
    // 漂浮的油膜与泥
    c.globalAlpha = 0.35;
    for (let i = 0; i < 12; i += 1) {
      c.fillStyle = i % 3 === 0 ? '#5c5a3c' : '#26302c';
      c.beginPath();
      c.ellipse((i * 59) % w, (i * 83) % h, 8 + (i % 4) * 6, 2 + (i % 3) * 2, i, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;
  });
}

function rippleTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 64, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.strokeStyle = 'rgba(230,240,255,0.9)';
    c.lineWidth = 3;
    c.beginPath();
    c.arc(w / 2, h / 2, 24, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = 'rgba(230,240,255,0.4)';
    c.lineWidth = 6;
    c.beginPath();
    c.arc(w / 2, h / 2, 20, 0, Math.PI * 2);
    c.stroke();
  });
}

function photoTexture(seed: number): THREE.CanvasTexture {
  return canvasTexture(160, 200, (c, w, h) => {
    const sepia = seed % 2 === 0;
    c.fillStyle = sepia ? '#b3a384' : '#9aa2a0';
    c.fillRect(0, 0, w, h);
    c.fillStyle = sepia ? '#8a7a5e' : '#7b8583';
    c.fillRect(0, h * 0.58, w, h * 0.42);
    c.fillStyle = sepia ? '#4d4232' : '#3f4846';
    // 一家三口剪影
    const people = [
      { x: 0.34, s: 1.1 },
      { x: 0.52, s: 1.25 },
      { x: 0.68, s: 0.72 },
    ];
    for (const p of people) {
      const x = w * p.x;
      const base = h * 0.74;
      c.beginPath();
      c.arc(x, base - 44 * p.s, 12 * p.s, 0, Math.PI * 2);
      c.fill();
      c.beginPath();
      c.moveTo(x - 14 * p.s, h * 0.59);
      c.quadraticCurveTo(x, h * 0.4, x + 14 * p.s, h * 0.59);
      c.lineTo(x + 18 * p.s, base);
      c.lineTo(x - 18 * p.s, base);
      c.closePath();
      c.fill();
    }
    // 白边 + 裂纹
    c.strokeStyle = '#d6d0bd';
    c.lineWidth = 12;
    c.strokeRect(6, 6, w - 12, h - 12);
    c.strokeStyle = 'rgba(60,64,62,0.5)';
    c.lineWidth = 1.2;
    c.beginPath();
    c.moveTo(w * 0.72, 4);
    c.lineTo(w * 0.58, h * 0.34);
    c.lineTo(w * 0.67, h * 0.44);
    c.stroke();
    c.strokeStyle = 'rgba(245,244,238,0.5)';
    c.lineWidth = 0.8;
    c.stroke();
  });
}

function signTexture(): THREE.CanvasTexture {
  return canvasTexture(192, 128, (c, w, h) => {
    c.fillStyle = '#c9a73a';
    c.fillRect(0, 0, w, h);
    c.strokeStyle = '#1b1a14';
    c.lineWidth = 8;
    c.strokeRect(4, 4, w - 8, h - 8);
    c.fillStyle = '#1b1a14';
    c.beginPath();
    c.moveTo(w / 2, 16);
    c.lineTo(w - 22, h - 26);
    c.lineTo(22, h - 26);
    c.closePath();
    c.fill();
    c.fillStyle = '#c9a73a';
    c.beginPath();
    c.arc(w / 2, h * 0.56, 18, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#1b1a14';
    c.beginPath();
    c.arc(w / 2, h * 0.56, 7, 0, Math.PI * 2);
    c.fill();
    c.font = 'bold 20px Arial';
    c.textAlign = 'center';
    c.fillStyle = '#1b1a14';
    c.fillText('УБЕЖИЩЕ', w / 2, h - 10);
  });
}

/* ------------------------------------------------------------------ *
 * 风摆：植被 / 布料共用一套 uniform
 * ------------------------------------------------------------------ */

const WIND_TIME = { value: 0 };
const CLOTH_TIME = { value: 0 };

function windPatch(mat: THREE.Material, amp: number, hang: boolean, timeKey: 'wind' | 'cloth'): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms['uWindTime'] = timeKey === 'wind' ? WIND_TIME : CLOTH_TIME;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWindTime;')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        {
          #ifdef USE_INSTANCING
            vec2 windRef = vec2( instanceMatrix[3].x, instanceMatrix[3].z );
          #else
            vec2 windRef = vec2( modelMatrix[3].x, modelMatrix[3].z );
          #endif
          float gust = sin( uWindTime * 1.35 + windRef.x * 0.61 + windRef.y * 0.37 ) * 0.62
                     + sin( uWindTime * 2.63 + windRef.y * 0.93 + 1.7 ) * 0.38;
          float weight = ${hang ? '( 1.0 - uv.y )' : 'uv.y'} * ${hang ? '( 1.0 - uv.y )' : 'uv.y'};
          transformed.x += gust * ${amp.toFixed(3)} * weight;
          transformed.z += gust * ${(amp * 0.55).toFixed(3)} * weight;
        }`,
      );
  };
  mat.customProgramCacheKey = () => `warwind-${amp}-${hang ? 'h' : 'g'}-${timeKey}`;
}

function foliageMaterial(map: THREE.CanvasTexture, amp: number): THREE.MeshToonMaterial {
  const mat = new THREE.MeshToonMaterial({
    map,
    gradientMap: toonGradient(3),
    color: 0xffffff,
    side: THREE.DoubleSide,
    alphaTest: 0.42,
    transparent: false,
    emissive: new THREE.Color(0x0a140c),
    emissiveIntensity: 0.45,
    fog: true,
  });
  windPatch(mat, amp, false, 'wind');
  return mat;
}

function clothMaterial(map: THREE.CanvasTexture): THREE.MeshToonMaterial {
  const mat = new THREE.MeshToonMaterial({
    map,
    gradientMap: toonGradient(3),
    color: 0xffffff,
    side: THREE.DoubleSide,
    alphaTest: 0.35,
    transparent: false,
    emissive: new THREE.Color(0x07090a),
    emissiveIntensity: 0.35,
  });
  windPatch(mat, 0.14, true, 'cloth');
  return mat;
}

function alphaMaterial(map: THREE.CanvasTexture, side = THREE.DoubleSide): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({
    map,
    gradientMap: toonGradient(3),
    alphaTest: 0.35,
    side,
    transparent: false,
    color: 0xffffff,
  });
}

function decalMaterial(map: THREE.CanvasTexture, color = 0xffffff, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    map,
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    side: THREE.DoubleSide,
    fog: true,
  });
}

/* ------------------------------------------------------------------ *
 * 材质与几何
 * ------------------------------------------------------------------ */

const M = {
  concrete: toonMaterial(PALETTE.concrete, { steps: 3 }),
  concreteLight: toonMaterial(0x8a8e93, { steps: 3 }),
  concreteDark: toonMaterial(PALETTE.concreteDark, { steps: 2 }),
  floorTop: toonMaterial(0x464a4f, { steps: 3 }),
  brick: toonMaterial(PALETTE.brick, { steps: 2 }),
  brickDark: toonMaterial(PALETTE.brickDark, { steps: 2 }),
  plaster: toonMaterial(PALETTE.plasterPeel, { steps: 3 }),
  dark: toonMaterial(0x17191c, { steps: 2 }),
  wood: toonMaterial(PALETTE.woodOld, { steps: 2 }),
  woodDark: toonMaterial(PALETTE.woodDark, { steps: 2 }),
  rust: toonMaterial(PALETTE.rust, { steps: 2 }),
  rustDark: toonMaterial(PALETTE.rustDark, { steps: 2 }),
  steel: toonMaterial(0x3d4349, { steps: 2 }),
  brass: toonMaterial(0x9a7a3c, { steps: 2 }),
  sandbag: toonMaterial(PALETTE.sandbag, { steps: 3 }),
  sandbagDark: toonMaterial(PALETTE.sandbagDark, { steps: 2 }),
  dirt: toonMaterial(PALETTE.dirt, { steps: 2 }),
  mud: toonMaterial(PALETTE.mud, { steps: 2 }),
  tyre: toonMaterial(PALETTE.tire, { steps: 2 }),
  cloth: toonMaterial(0xb9b4a4, { steps: 2 }),
  clothBlue: toonMaterial(0x6f838e, { steps: 2 }),
  clothRed: toonMaterial(0x8a4a43, { steps: 2 }),
  ceramic: toonMaterial(0xd8d2c4, { steps: 3 }),
  ceramicBlue: toonMaterial(0x8095a2, { steps: 3 }),
  toyRed: toonMaterial(0xa8453c, { steps: 2 }),
  toyBlue: toonMaterial(0x3d5a78, { steps: 2 }),
  toyYellow: toonMaterial(0xa78a42, { steps: 2 }),
  glass: new THREE.MeshBasicMaterial({
    color: 0x22323c,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    side: THREE.DoubleSide,
  }),
  paper: toonMaterial(PALETTE.paper, { steps: 2 }),
} as const;

/** 贴图延迟到首次建模时创建：模块在 Node 测试环境里被 import 时没有 document */
let texCache: {
  wallpaper: THREE.CanvasTexture[];
  photo: THREE.CanvasTexture[];
  cloth: THREE.CanvasTexture;
  sheet: THREE.CanvasTexture;
} | null = null;

function textures(): NonNullable<typeof texCache> {
  if (!texCache) {
    texCache = {
      wallpaper: [wallpaperTexture(11), wallpaperTexture(29)],
      photo: [photoTexture(3), photoTexture(8)],
      cloth: clothTexture(7, false),
      sheet: clothTexture(17, true),
    };
  }
  return texCache;
}

const GRASS_GEO = (() => {
  const a = new THREE.PlaneGeometry(1, 1);
  a.translate(0, 0.5, 0);
  const b = a.clone();
  b.rotateY(Math.PI / 2);
  return mergeAll([a, b]);
})();
const LAUNDRY_GEO = (() => {
  const g = new THREE.PlaneGeometry(1, 1);
  g.translate(0, -0.5, 0);
  return g;
})();
const GROUND_CLOTH_GEO = (() => {
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateX(-Math.PI / 2);
  return g;
})();
const GROUND_DECAL_GEO = (() => {
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateX(-Math.PI / 2);
  return g;
})();
const WALL_DECAL_GEO = new THREE.PlaneGeometry(1, 1);

/* ------------------------------------------------------------------ *
 * 数据收集：碎件、贴花、植被
 * ------------------------------------------------------------------ */

interface Debris {
  brickA: InstanceTransform[];
  brickB: InstanceTransform[];
  brickBurnt: InstanceTransform[];
  concreteA: InstanceTransform[];
  concreteB: InstanceTransform[];
  planks: InstanceTransform[];
  metal: InstanceTransform[];
  shells: InstanceTransform[];
  sandbags: InstanceTransform[];
  tracks: InstanceTransform[];
  rebar: InstanceTransform[];
  gasMasks: InstanceTransform[];
  backpacks: InstanceTransform[];
  vests: InstanceTransform[];
  hedgehogs: InstanceTransform[];
}

function emptyDebris(): Debris {
  return {
    brickA: [],
    brickB: [],
    brickBurnt: [],
    concreteA: [],
    concreteB: [],
    planks: [],
    metal: [],
    shells: [],
    sandbags: [],
    tracks: [],
    rebar: [],
    gasMasks: [],
    backpacks: [],
    vests: [],
    hedgehogs: [],
  };
}

function rot(rng: Rng, amount = Math.PI): THREE.Euler {
  return new THREE.Euler(rng.range(-amount, amount), rng.range(-amount, amount), rng.range(-amount, amount));
}

function addBrick(d: Debris, rng: Rng, x: number, y: number, z: number, scale = 1): void {
  const list = rng.chance(0.55) ? d.brickA : rng.chance(0.6) ? d.brickB : d.brickBurnt;
  list.push({
    position: new THREE.Vector3(x, y, z),
    rotation: rot(rng),
    scale: new THREE.Vector3(scale, scale, scale).multiplyScalar(rng.range(0.7, 1.3)),
  });
}

function addConcrete(d: Debris, rng: Rng, x: number, y: number, z: number, scale = 1): void {
  const list = rng.chance(0.34) ? d.concreteA : d.concreteB;
  list.push({
    position: new THREE.Vector3(x, y, z),
    rotation: rot(rng),
    scale: new THREE.Vector3(scale, scale, scale).multiplyScalar(rng.range(0.5, 1.4)),
  });
}

function addShells(d: Debris, rng: Rng, x: number, z: number, count: number, spread = 2): void {
  for (let i = 0; i < count; i += 1) {
    d.shells.push({
      position: new THREE.Vector3(x + rng.range(-spread, spread), 0.06, z + rng.range(-spread, spread)),
      rotation: new THREE.Euler(Math.PI / 2 + rng.range(-0.3, 0.3), rng.range(0, 6.3), rng.range(-0.3, 0.3)),
      scale: new THREE.Vector3(1, 1, 1),
    });
  }
}

function addSandbag(
  d: Debris,
  rng: Rng,
  x: number,
  y: number,
  z: number,
  yaw = rng.range(0, Math.PI),
): void {
  d.sandbags.push({
    position: new THREE.Vector3(x, y, z),
    rotation: new THREE.Euler(rng.range(-0.12, 0.12), yaw, rng.range(-0.16, 0.16)),
    scale: new THREE.Vector3(rng.range(0.85, 1.08), rng.range(0.8, 1.04), rng.range(0.86, 1.1)),
  });
}

function addRebarAt(
  d: Debris,
  rng: Rng,
  x: number,
  y: number,
  z: number,
  yaw = rng.range(0, Math.PI * 2),
): void {
  d.rebar.push({
    position: new THREE.Vector3(x, y, z),
    rotation: new THREE.Euler(rng.range(-0.8, 0.8), yaw, rng.range(-0.9, 0.9)),
    scale: new THREE.Vector3(rng.range(0.6, 1.4), rng.range(0.5, 1.3), rng.range(0.6, 1.4)),
  });
}

function bentRebarGeometry(): THREE.BufferGeometry {
  const a = new THREE.CylinderGeometry(0.022, 0.026, 0.9, 5, 1);
  a.translate(0, 0.45, 0);
  const b = new THREE.CylinderGeometry(0.019, 0.022, 0.55, 5, 1);
  b.rotateZ(0.9);
  b.translate(0.2, 1.03, 0);
  return mergeAll([a, b]);
}

/* ------------------------------------------------------------------ *
 * 剖切楼
 * ------------------------------------------------------------------ */

interface CutSpec {
  id: string;
  cx: number;
  cz: number;
  w: number;
  d: number;
  floors: number;
  seed: number;
}

function buildCutaway(
  ctx: BuildContext,
  spec: CutSpec,
  debris: Debris,
  decals: DecalSink,
): THREE.Group {
  const rng = ctx.rng.fork(spec.seed);
  const root = group(`cutaway-${spec.id}`);
  const gy = groundYAt(spec.cx, spec.cz);
  root.position.set(spec.cx, gy, spec.cz);

  const W = spec.w;
  const D = spec.d;
  const FH = 3.2;
  const topY = spec.floors * FH;
  const frontZ = D / 2;
  const backZ = -D / 2;
  const batches = new Map<THREE.Material, THREE.Mesh[]>();
  const put = (
    mat: THREE.Material,
    geo: THREE.BufferGeometry,
    x: number,
    y: number,
    z: number,
    ry = 0,
    rz = 0,
    rx = 0,
  ): void => {
    const m = mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    m.receiveShadow = true;
    const list = batches.get(mat);
    if (list) list.push(m);
    else batches.set(mat, [m]);
  };
  const b = (
    mat: THREE.Material,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    ry = 0,
    rz = 0,
    rx = 0,
  ): void => put(mat, new THREE.BoxGeometry(w, h, d), x, y, z, ry, rz, rx);

  // 基础地坪：边缘翘起，中心被掏空
  b(M.concreteDark, W + 0.8, 0.18, D + 0.6, 0, 0.07, 0, 0, 0.01);
  b(M.concrete, W + 0.2, 0.12, D + 0.2, 0, 0.16, 0);

  /* —— 后墙：完整但顶部被炸成参差 —— */
  const backSegs = 6;
  for (let i = 0; i < backSegs; i += 1) {
    const segW = W / backSegs;
    const h = Math.max(4.2, topY - rng.range(0.2, 2.4) - (i === 2 || i === 4 ? rng.range(1, 3) : 0));
    b(M.brick, segW * 1.01, h, 0.38, -W / 2 + segW * (i + 0.5), h / 2, backZ + 0.2, 0, 0.012 * rng.sign());
    // 顶部断茬
    b(M.brickDark, segW * rng.range(0.3, 0.8), rng.range(0.16, 0.5), 0.42, -W / 2 + segW * (i + 0.5), h + 0.12, backZ + 0.19, 0, rng.range(-0.25, 0.25));
  }
  // 后墙大洞：贴在内表面的暗面（不是一块悬在空中的黑板）
  b(M.dark, W * 0.18, topY * 0.34, 0.02, W * 0.16, topY * 0.72, backZ + 0.025);
  for (let i = 0; i < 9; i += 1) {
    addRebarAt(debris, rng, spec.cx + rng.range(-W * 0.5, W * 0.5), gy + topY + rng.range(-0.4, 0.2), spec.cz - D * 0.5 + 0.2);
  }

  /* —— 侧墙：左高右低，右半边基本被掀掉 —— */
  for (let i = 0; i < 4; i += 1) {
    const segD = (D - 0.4) / 4;
    const h = topY - i * rng.range(0.8, 2.0);
    b(M.plaster, 0.38, Math.max(1.2, h), segD * 1.01, -W / 2 + 0.19, Math.max(1.2, h) / 2, frontZ - 0.2 - segD * (i + 0.5), 0, rng.range(-0.01, 0.01));
  }
  for (let i = 0; i < 3; i += 1) {
    const segD = (D - 0.4) / 3;
    const h = Math.max(0.8, topY * 0.38 - i * rng.range(0.4, 1.4));
    b(M.brickDark, 0.38, h, segD * 1.01, W / 2 - 0.19, h / 2, frontZ - 0.2 - segD * (i + 0.5), 0, rng.range(-0.03, 0.03));
  }

  /* —— 临街侧墙的窗洞与塌阳台：破坏不能只剩一块光板 —— */
  for (const side of [-1, 1] as const) {
    const wallX = side * (W / 2 + 0.006);
    for (let f = 1; f < spec.floors; f += 1) {
      const wy = f * FH + 1.55;
      for (let k = 0; k < 2; k += 1) {
        const wz = -D * 0.22 + k * D * 0.42;
        if (rng.chance(0.18)) continue;
        b(M.dark, 0.05, 1.25, 0.9, wallX, wy, wz);
        b(M.concreteDark, 0.14, 0.09, 1.12, side * (W / 2 + 0.025), wy - 0.7, wz);
        if (rng.chance(0.55)) b(M.concreteDark, 0.14, 0.08, 1.12, side * (W / 2 + 0.025), wy + 0.7, wz);
        b(M.concreteDark, 0.14, 1.5, 0.09, side * (W / 2 + 0.025), wy, wz - 0.55);
        if (rng.chance(0.7)) b(M.concreteDark, 0.14, 1.5, 0.09, side * (W / 2 + 0.025), wy, wz + 0.55);
        if (rng.chance(0.35)) {
          // 钉死窗洞的木板
          b(M.woodDark, 0.06, 1.0 + rng.range(-0.2, 0.2), 0.22, side * (W / 2 + 0.055), wy - 0.1, wz + rng.range(-0.2, 0.2), 0, rng.range(-0.3, 0.3));
          b(M.wood, 0.06, 0.2, 0.95, side * (W / 2 + 0.055), wy + rng.range(-0.4, 0.4), wz, 0, rng.range(-0.1, 0.1));
        }
      }
    }
    // 大破口：混凝土边框 + 黑腔，露出墙体厚度
    const breachY = Math.min(topY - 3.2, FH * 2 + 1.2);
    b(M.dark, 0.06, 2.1, 2.2, wallX, breachY, -D * 0.02);
    b(M.concreteLight, 0.2, 0.16, 2.5, side * (W / 2 + 0.04), breachY + 1.12, -D * 0.02);
    b(M.concreteLight, 0.2, 2.4, 0.16, side * (W / 2 + 0.04), breachY, -D * 0.02 - 1.2);
    b(M.concreteLight, 0.2, 2.4, 0.16, side * (W / 2 + 0.04), breachY, -D * 0.02 + 1.2);
    // 剥落墙皮：露出砖芯的大块补丁
    for (let i = 0; i < 3; i += 1) {
      b(
        M.brick,
        0.035,
        rng.range(0.7, 1.8),
        rng.range(0.8, 2.2),
        side * (W / 2 + 0.004),
        rng.range(1.4, topY - 1.8),
        rng.range(-D * 0.4, D * 0.4),
        0,
        rng.range(-0.2, 0.2),
      );
    }
  }
  {
    const by = FH * 2 + 0.4;
    const bz = D * 0.12;
    b(M.concreteDark, 1.5, 0.16, 2.2, -W / 2 - 0.75, by, bz, 0, 0, 0.16);
    b(M.concreteDark, 0.12, 0.9, 2.1, -W / 2 - 1.45, by + 0.5, bz, 0, 0.03);
    for (let i = 0; i < 5; i += 1) {
      b(M.rustDark, 0.04, 0.9, 0.04, -W / 2 - 1.45, by + 0.5, bz - 0.85 + i * 0.42);
    }
  }
  {
    // 另一侧：一整块塌了一半的悬挑阳台
    const by = FH + 0.5;
    const bz = -D * 0.24;
    b(M.concreteDark, 1.25, 0.14, 1.9, W / 2 + 0.62, by, bz, 0, 0.05, -0.26);
    b(M.concreteDark, 0.1, 0.7, 1.3, W / 2 + 1.2, by + 0.38, bz + 0.2, 0, 0.04, -0.2);
    for (let i = 0; i < 3; i += 1) {
      b(M.rustDark, 0.035, 0.7, 0.035, W / 2 + 1.2, by + 0.38, bz - 0.2 + i * 0.4, 0, 0, -0.2);
    }
  }

  /* —— 前立面：只留两截断墙 + 一层残门洞 —— */
  const leftPierW = W * 0.28;
  b(M.plaster, leftPierW, Math.min(topY * 0.55, 6.4), 0.4, -W / 2 + leftPierW / 2, Math.min(topY * 0.55, 6.4) / 2, frontZ - 0.2, 0, 0.008);
  b(M.brick, W * 0.16, 3.0, 0.4, W / 2 - W * 0.12, 1.5, frontZ - 0.2, 0, -0.02);
  b(M.plaster, W * 0.18, 0.5, 0.44, -W * 0.06, Math.min(topY * 0.55, 6.4), frontZ - 0.2, 0, 0.03);
  // 门框残段
  b(M.concreteDark, 0.22, 2.3, 0.32, -W * 0.18, 1.15, frontZ - 0.16);
  b(M.concreteDark, 0.18, 1.5, 0.32, W * 0.02, 0.75, frontZ - 0.16);

  /* —— 楼板：保留左半边，断口参差，右上留下悬挑残板 —— */
  for (let f = 1; f < spec.floors; f += 1) {
    const y = f * FH;
    const slabD = D - 0.5;
    const keepW = W * (f % 2 === 0 ? 0.48 : 0.58);
    b(M.floorTop, keepW, 0.08, slabD, -W / 2 + keepW / 2, y, 0.02);
    b(M.concrete, keepW, 0.2, slabD, -W / 2 + keepW / 2, y - 0.12, 0.02);
    // 断口处的钢筋与崩角
    for (let i = 0; i < 3; i += 1) {
      addRebarAt(debris, rng, spec.cx - W / 2 + keepW + rng.range(-0.12, 0.16), gy + y - 0.12, spec.cz + rng.range(-slabD * 0.45, slabD * 0.45), Math.PI / 2);
    }
    if (f % 2 === 0) {
      const overW = W * rng.range(0.12, 0.22);
      b(M.concrete, overW, 0.18, slabD * rng.range(0.4, 0.7), W / 2 - overW / 2, y - rng.range(0.05, 0.3), rng.range(-1, 1), 0, rng.range(-0.18, 0.18));
    }
    // 断面：靠墙一侧的浅色混凝土条
    b(M.concreteLight, keepW, 0.05, 0.08, -W / 2 + keepW / 2, y + 0.02, slabD / 2 + 0.02);
    // 断口崩边：一排深浅不一的缺口，远看才是"被炸断"而不是切开的楼板
    for (let i = 0; i < 7; i += 1) {
      const ez = -slabD / 2 + slabD * ((i + 0.5) / 7);
      const ew = rng.range(0.16, 0.6);
      b(
        i % 2 === 0 ? M.concrete : M.concreteDark,
        ew,
        rng.range(0.08, 0.3),
        rng.range(0.3, 0.8),
        -W / 2 + keepW + ew * 0.5,
        y - rng.range(0.08, 0.24),
        ez,
        0,
        rng.range(-0.25, 0.25),
        rng.range(-0.2, 0.2),
      );
      if (i % 2 === 0) {
        addRebarAt(debris, rng, spec.cx - W / 2 + keepW + 0.06, gy + y - 0.16, spec.cz + ez, Math.PI / 2);
      }
    }
    // 板面上的破洞暗面 + 边缘碎屑
    if (f >= 2) {
      const hx = -W * 0.2 + rng.range(-1.2, 1.2);
      const hz = rng.range(-2.2, 2.2);
      b(M.dark, 1.1, 0.02, 0.9, hx, y + 0.045, hz, rng.range(0, 1));
      for (let i = 0; i < 5; i += 1) {
        addBrick(debris, rng, spec.cx + hx + rng.range(-1.1, 1.1), gy + y + 0.05, spec.cz + hz + rng.range(-1, 1), 0.8);
      }
    }
    for (let i = 0; i < 6; i += 1) {
      const bx = -W / 2 + rng.range(0.4, keepW - 0.2);
      addConcrete(debris, rng, spec.cx + bx, gy + y + 0.06, spec.cz + rng.range(-slabD * 0.45, slabD * 0.45), 0.35);
    }
    // 楼板边缘的护栏残段
    for (let i = 0; i < 3; i += 1) {
      const ex = -W / 2 + keepW - rng.range(0.2, 1.2);
      b(M.concreteDark, rng.range(0.3, 0.9), 0.3, 0.12, ex, y + 0.22, -slabD / 2 + rng.range(0.4, slabD - 0.4), 0, rng.range(-0.1, 0.1));
    }
    // 断口外侧垂下的残板：打断"每层都是整块矩形楼板"的停车场感
    for (let i = 0; i < 2; i += 1) {
      const ez = -slabD * 0.35 + rng.range(0, slabD * 0.7);
      const ew = rng.range(0.45, 1.0);
      b(
        M.concreteDark,
        ew,
        0.13,
        rng.range(0.55, 1.2),
        -W / 2 + keepW + ew * 0.28,
        y - rng.range(0.35, 0.95),
        ez,
        rng.range(-0.18, 0.18),
        rng.range(-0.62, -0.28),
        rng.range(-0.22, 0.22),
      );
      addRebarAt(debris, rng, spec.cx - W / 2 + keepW + ew * 0.3, gy + y - 0.5, spec.cz + ez, Math.PI / 2);
    }
  }

  /* —— 残柱与隔墙：有承重体系才像楼 —— */
  for (let f = 0; f < spec.floors - 1; f += 1) {
    const y = f * FH;
    for (const [cx, cz, keep] of [
      [-W * 0.3, -D * 0.16, 0.85],
      [-W * 0.02, -D * 0.16, 0.6],
      [-W * 0.22, D * 0.28, 0.7],
    ] as Array<[number, number, number]>) {
      if (rng.next() > keep) continue;
      b(M.concreteDark, 0.3, FH - 0.3, 0.3, cx, y + FH / 2, cz, 0, rng.range(-0.04, 0.04));
    }
    if (f > 0 && rng.chance(0.7)) {
      const pw = rng.range(1.4, 2.8);
      b(M.plaster, pw, 2.4, 0.14, -W * 0.24, y + 1.2, -D * 0.28, rng.range(-0.1, 0.1), 0.01);
      b(M.dark, 0.9, 1.7, 0.06, -W * 0.24 + rng.range(-0.4, 0.4), y + 1.0, -D * 0.28 + 0.09);
    }
    // 面向断口的室内隔墙 + 门洞：有房间轮廓，才不会被读成停车楼
    if (f >= 1) {
      const dx = -W * 0.06;
      const dz = D * rng.range(0.02, 0.14);
      const dw = rng.range(2.2, 3.2);
      b(M.plaster, 0.13, 2.35, dw, dx, y + 1.18, dz, rng.range(-0.03, 0.03), rng.range(-0.01, 0.01));
      const doorZ = dz + rng.range(-dw * 0.24, dw * 0.24);
      b(M.dark, 0.055, 1.85, 0.95, dx + 0.075, y + 0.96, doorZ);
      b(M.dark, 0.055, 1.85, 0.95, dx - 0.075, y + 0.96, doorZ);
    }
  }

  /* —— 楼梯：贴后墙，上段炸断 —— */
  const stairX = -W * 0.12;
  for (let i = 0; i < 11; i += 1) {
    const sy = 0.2 + i * 0.23;
    const sz = -D * 0.28 - i * 0.3;
    if (i > 7 && rng.chance(0.55)) continue;
    b(M.concreteDark, 1.15, 0.18, 0.34, stairX, sy, sz);
    b(M.concreteDark, 1.15, 0.4, 0.16, stairX, sy + 0.2, sz - 0.1);
  }
  b(M.concreteDark, 1.3, 0.2, 1.5, stairX, 2.75, -D * 0.28 - 3.1, 0, 0.02, 0.28);
  b(M.concreteDark, 1.15, 0.16, 0.34, stairX + 0.2, 3.3, -D * 0.28 - 4.4, 0, 0.18, 0.32);

  /* —— 屋顶残板 —— */
  const roofW = W * rng.range(0.3, 0.42);
  b(M.concrete, roofW, 0.24, D * 0.34, -W * 0.24, topY - 0.2, backZ + D * 0.2, 0, rng.range(-0.14, 0.14));
  addRebarAt(debris, rng, spec.cx - W * 0.1, gy + topY - 0.1, spec.cz - D * 0.1);

  /* —— 室内残留 —— */
  const secondY = FH;
  b(M.wood, 1.5, 0.06, 0.65, -W * 0.2, secondY + 0.9, -D * 0.18, rng.range(-0.2, 0.2), rng.range(-0.06, 0.06));
  b(M.woodDark, 0.08, 1.8, 0.6, -W * 0.35, secondY + 0.95, -D * 0.18, rng.range(-0.2, 0.2), rng.range(-0.1, 0.1));
  b(M.woodDark, 0.08, 1.8, 0.6, -W * 0.05, secondY + 0.95, -D * 0.18, rng.range(-0.2, 0.2), rng.range(-0.1, 0.1));
  // 窗口脱落的白框
  b(M.paper, 0.8, 0.06, 0.06, -W * 0.18, secondY + 2.1, -D * 0.18, 0, 0.35);
  // 三层床架
  const thirdY = FH * 2;
  b(M.steel, 1.8, 0.08, 0.9, -W * 0.26, thirdY + 0.3, -D * 0.2, 0, 0.06, 0.03);
  for (const px of [-0.7, 0.7]) {
    b(M.steel, 0.06, 0.5, 0.06, -W * 0.26 + px, thirdY + 0.06, -D * 0.2 + 0.35);
    b(M.steel, 0.06, 0.5, 0.06, -W * 0.26 + px, thirdY + 0.06, -D * 0.2 - 0.35);
  }
  // 底层翻倒的桌子
  b(M.wood, 1.2, 0.06, 0.75, -W * 0.12, 0.55, D * 0.2, 0.12, 0.18);
  // 断口附近的家具：床垫、翻倒的衣柜、矮柜
  b(M.paper, 1.3, 0.13, 0.66, W * 0.0, secondY + 0.29, D * 0.04, 0.2, 0, 0.02);
  b(M.woodDark, 1.1, 0.5, 0.75, W * 0.04, thirdY + 0.34, D * 0.05, 0.25, 1.4, 0.04);
  b(M.wood, 0.55, 0.62, 0.9, W * 0.02, thirdY + 0.31, -D * 0.08, -0.35, 0.06);

  /* —— 墙纸：贴在后墙内侧，每层一张，破边 —— */
  for (let f = 0; f < Math.min(3, spec.floors - 1); f += 1) {
    const mat = new THREE.MeshToonMaterial({
      map: textures().wallpaper[f % textures().wallpaper.length],
      gradientMap: toonGradient(3),
      alphaTest: 0.35,
      side: THREE.FrontSide,
      emissive: new THREE.Color(0x15120e),
      emissiveIntensity: 0.5,
    });
    const p = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.5, 2.45), mat);
    p.position.set(-W * 0.18, f * FH + 1.55, backZ + 0.42);
    p.rotation.y = rng.range(-0.01, 0.01);
    p.castShadow = false;
    p.receiveShadow = true;
    root.add(p);
  }
  // 侧墙墙纸
  {
    const mat = new THREE.MeshToonMaterial({
      map: textures().wallpaper[1],
      gradientMap: toonGradient(3),
      alphaTest: 0.35,
      side: THREE.FrontSide,
      emissive: new THREE.Color(0x11100d),
      emissiveIntensity: 0.4,
    });
    const p = new THREE.Mesh(new THREE.PlaneGeometry(D * 0.5, 2.3), mat);
    p.position.set(-W / 2 + 0.4, FH + 1.5, -D * 0.02);
    p.rotation.y = Math.PI / 2;
    p.castShadow = false;
    root.add(p);
  }

  /* —— 墙根青苔/水渍位置交给全局贴花系统 —— */
  decals.moss.push(
    { x: spec.cx - W * 0.42, y: gy + 0.42, z: spec.cz + frontZ + 0.02, yaw: 0, w: 1.8, h: 0.9 },
    { x: spec.cx - W * 0.3, y: gy + 0.36, z: spec.cz + frontZ + 0.02, yaw: 0, w: 1.2, h: 0.8 },
  );
  decals.stains.push(
    { x: spec.cx - W * 0.36, y: gy + 2.1, z: spec.cz + frontZ + 0.02, yaw: 0, w: 1.0, h: 2.7 },
    { x: spec.cx - W * 0.06, y: gy + 1.6, z: spec.cz + frontZ + 0.02, yaw: 0, w: 0.8, h: 2.0 },
  );

  /* —— 底层废墟：把断口与地面接起来 —— */
  for (let i = 0; i < 46; i += 1) {
    const a = rng.range(0, Math.PI * 2);
    const rr = Math.sqrt(rng.next()) * Math.max(W, D) * 0.55;
    addBrick(debris, rng, spec.cx + Math.cos(a) * rr, gy + rng.range(0.04, 0.35), spec.cz + Math.sin(a) * rr * 0.8);
  }
  for (let i = 0; i < 18; i += 1) {
    addConcrete(debris, rng, spec.cx + rng.range(-W * 0.62, W * 0.62), gy + rng.range(0.04, 0.4), spec.cz + rng.range(-D * 0.56, D * 0.56), 0.8);
  }
  // 外露的混凝土板与木梁
  for (let i = 0; i < 5; i += 1) {
    debris.planks.push({
      position: new THREE.Vector3(spec.cx + rng.range(-W * 0.5, W * 0.5), gy + rng.range(0.1, 0.6), spec.cz + rng.range(-D * 0.4, D * 0.5)),
      rotation: new THREE.Euler(rng.range(-0.3, 0.3), rng.range(0, 6.3), rng.range(-0.5, 0.5)),
      scale: new THREE.Vector3(rng.range(0.7, 1.4), 1, 1),
    });
  }
  for (let i = 0; i < 6; i += 1) {
    debris.metal.push({
      position: new THREE.Vector3(spec.cx + rng.range(-W * 0.55, W * 0.55), gy + rng.range(0.08, 0.5), spec.cz + rng.range(-D * 0.5, D * 0.5)),
      rotation: new THREE.Euler(rng.range(-0.6, 0.6), rng.range(0, 6.3), rng.range(-0.6, 0.6)),
      scale: new THREE.Vector3(rng.range(0.6, 1.3), rng.range(0.6, 1.1), rng.range(0.5, 1.1)),
    });
  }

  // 合并外壳（描边只挂在合并后的墙体上，实例化碎件不进描边壳）
  const shell = group(`cutaway-${spec.id}-shell`);
  let batchIndex = 0;
  for (const [mat, list] of batches) {
    const merged = addBatch(shell, list, mat, `cutaway-${spec.id}-${batchIndex}`);
    batchIndex += 1;
    if (merged) {
      merged.castShadow = true;
      merged.receiveShadow = true;
    }
  }
  withOutline(shell, 0.0036);
  root.add(shell);

  // 二楼工作灯：让剖面内部读得出空间
  const lampY = FH + 0.8;
  const bulb = mesh(new THREE.SphereGeometry(0.09, 8, 6), glowMaterial(0xffc27a, 0.9));
  bulb.position.set(-W * 0.18, lampY, -D * 0.02);
  bulb.castShadow = false;
  root.add(bulb);
  const wire = cylinderBetween(
    new THREE.Vector3(-W * 0.18, lampY + 0.09, -D * 0.02),
    new THREE.Vector3(-W * 0.18, secondY + 2.7, -D * 0.02),
    0.012,
    M.dark,
    4,
  );
  wire.castShadow = false;
  root.add(wire);
  if (ctx.lightCount < 36) {
    const light = new THREE.PointLight(0xffb36b, 5.5, 10, 2);
    // ctx.addLight 把灯挂到世界根节点：必须按世界坐标摆，不能用楼体局部坐标
    light.position.set(spec.cx - W * 0.18, gy + lampY, spec.cz - D * 0.02);
    ctx.addLight(light);
  }

  return root;
}

/* ------------------------------------------------------------------ *
 * 地陷 / 路面断裂
 * ------------------------------------------------------------------ */

interface DecalSink {
  cracks: Array<{ x: number; y: number; z: number; yaw: number; w: number; h: number }>;
  bullets: Array<{ x: number; y: number; z: number; yaw: number; w: number; h: number }>;
  moss: Array<{ x: number; y: number; z: number; yaw: number; w: number; h: number }>;
  stains: Array<{ x: number; y: number; z: number; yaw: number; w: number; h: number }>;
  wallCracks: Array<{ x: number; y: number; z: number; yaw: number; w: number; h: number }>;
}

function jaggedDisc(r: number, seg: number, rng: Rng, roughness = 0.2): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  for (let i = 0; i < seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    const rr = r * (1 - roughness * 0.5 + rng.next() * roughness);
    const x = Math.cos(a) * rr;
    const y = Math.sin(a) * rr;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

function buildSinkhole(
  ctx: BuildContext,
  spec: { x: number; z: number; r: number },
  debris: Debris,
  decals: DecalSink,
  withWater: boolean,
): THREE.Group {
  const rng = ctx.rng.fork(Math.round(spec.x * 31 + spec.z * 17) ^ 0x5a17);
  const root = group(withWater ? 'war-sinkhole' : 'war-road-break');
  const roadY = groundYAt(spec.x, spec.z);
  root.position.set(spec.x, roadY, spec.z);
  const quat = new THREE.Quaternion();
  const m4 = new THREE.Matrix4();

  const blackMat = new THREE.MeshBasicMaterial({ color: 0x04070a });
  const cavity = mesh(jaggedDisc(spec.r * 1.02, 26, rng, 0.16), blackMat);
  cavity.position.y = 0.008;
  cavity.castShadow = false;
  cavity.receiveShadow = false;
  root.add(cavity);

  if (withWater) {
    const waterMat = new THREE.MeshStandardMaterial({
      map: waterTexture(),
      color: 0xc9d9de,
      roughness: 0.12,
      metalness: 0.34,
      emissive: new THREE.Color(0x122229),
      emissiveIntensity: 1.25,
    });
    const water = mesh(jaggedDisc(spec.r * 0.82, 24, rng, 0.12), waterMat);
    water.position.y = 0.018;
    water.receiveShadow = true;
    water.castShadow = false;
    water.name = 'war-crater-water';
    root.add(water);
    // 半沉的扭曲车底盘
    const chassis = group('war-sunken-chassis');
    const body = box(2.5, 0.5, 1.15, toonMaterial(PALETTE.burnt, { steps: 2 }));
    body.position.y = 0.12;
    body.rotation.z = 0.34;
    body.rotation.y = 0.5;
    chassis.add(body);
    const cabin = box(1.25, 0.42, 0.92, M.rustDark);
    cabin.position.set(-0.35, 0.58, 0.05);
    cabin.rotation.z = 0.48;
    cabin.rotation.y = 0.5;
    chassis.add(cabin);
    // 只剩半圈的风挡框，让底盘读成"车"而不是一块铁板
    const frame = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.035, 4, 12, Math.PI), M.steel);
    frame.position.set(-0.05, 0.68, 0.36);
    frame.rotation.set(1.35, 0.45, 0.1);
    chassis.add(frame);
    const bentRoof = box(1.1, 0.06, 0.8, M.rust);
    bentRoof.position.set(-0.55, 0.84, 0.1);
    bentRoof.rotation.z = 0.72;
    chassis.add(bentRoof);
    // 露出水面的半只车轮
    const tyre = mesh(new THREE.TorusGeometry(0.3, 0.12, 5, 12), M.tyre);
    tyre.rotation.set(0.2, Math.PI / 2, 0.2);
    tyre.position.set(0.95, 0.22, 0.62);
    chassis.add(tyre);
    // 只剩轮毂的另外三只
    for (const [x, z] of [[-0.9, 0.55], [0.9, -0.6], [-0.85, -0.58]]) {
      const hub = cyl(0.15, 0.15, 0.09, 8, M.steel);
      hub.rotation.z = Math.PI / 2;
      hub.position.set(x, 0.0, z);
      chassis.add(hub);
    }
    chassis.position.set(1.1, 0.03, 0.55);
    chassis.rotation.y = -0.4;
    root.add(chassis);

    // 雨点打在水面上的扩散环（单 draw call）
    const rippleGeo = new THREE.PlaneGeometry(1, 1);
    rippleGeo.rotateX(-Math.PI / 2);
    const rippleMat = new THREE.MeshBasicMaterial({
      map: rippleTexture(),
      color: 0xbfd6e6,
      transparent: true,
      opacity: 0.38,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const N = 10;
    const rippleInst = new THREE.InstancedMesh(rippleGeo, rippleMat, N);
    rippleInst.name = 'war-crater-ripples';
    rippleInst.frustumCulled = false;
    rippleInst.renderOrder = 6;
    const phases: number[] = [];
    const pos: Array<[number, number]> = [];
    const color = new THREE.Color();
    for (let i = 0; i < N; i += 1) {
      const a = rng.range(0, Math.PI * 2);
      const rr = Math.sqrt(rng.next()) * spec.r * 0.74;
      pos.push([Math.cos(a) * rr, Math.sin(a) * rr]);
      phases.push(rng.next());
      m4.compose(new THREE.Vector3(pos[i]![0], 0.03, pos[i]![1]), quat, new THREE.Vector3(0.2, 1, 0.2));
      rippleInst.setMatrixAt(i, m4);
      color.setScalar(0.1);
      rippleInst.setColorAt(i, color);
    }
    rippleInst.instanceMatrix.needsUpdate = true;
    root.add(rippleInst);
    ctx.ticker.add((t) => {
      for (let i = 0; i < N; i += 1) {
        const k = ((t * 0.42 + phases[i]!) % 1 + 1) % 1;
        const s = 0.25 + k * 1.5;
        m4.compose(
          new THREE.Vector3(pos[i]![0], 0.03, pos[i]![1]),
          quat,
          new THREE.Vector3(s, 1, s),
        );
        rippleInst.setMatrixAt(i, m4);
        color.setScalar((1 - k) * 0.9);
        rippleInst.setColorAt(i, color);
      }
      rippleInst.instanceMatrix.needsUpdate = true;
      if (rippleInst.instanceColor) rippleInst.instanceColor.needsUpdate = true;
    });
  }

  // 断裂沥青板：围绕坑口翻起、相互错位
  const slabMatA = toonMaterial(0x2d3238, { steps: 2 });
  const slabMatB = toonMaterial(0x3b3f45, { steps: 2 });
  const slabGeo = chippedSlab(2.4, 1.3, 0.18, rng);
  const slabGeo2 = chippedSlab(1.7, 1.0, 0.14, rng);
  const slabA: InstanceTransform[] = [];
  const slabB: InstanceTransform[] = [];
  const count = withWater ? 34 : 18;
  for (let i = 0; i < count; i += 1) {
    const a = (i / count) * Math.PI * 2 + rng.range(-0.14, 0.14);
    const rr = spec.r * rng.range(0.82, 1.26);
    const lift = rng.range(0.04, withWater ? 0.44 : 0.2);
    const item: InstanceTransform = {
      position: new THREE.Vector3(Math.cos(a) * rr, lift, Math.sin(a) * rr),
      rotation: new THREE.Euler(rng.range(-0.3, 0.3), -a + rng.range(-0.3, 0.3), rng.range(-0.42, 0.42)),
      scale: new THREE.Vector3(rng.range(0.6, 1.4), rng.range(0.6, 1.4), rng.range(0.7, 1.5)),
    };
    (i % 2 === 0 ? slabA : slabB).push(item);
    addRebarAt(debris, rng, spec.x + Math.cos(a) * rr, roadY + lift + 0.04, spec.z + Math.sin(a) * rr, -a);
  }
  for (const [list, geo, mat, name] of [
    [slabA, slabGeo, slabMatA, 'war-slab-a'],
    [slabB, slabGeo2, slabMatB, 'war-slab-b'],
  ] as Array<[InstanceTransform[], THREE.BufferGeometry, THREE.Material, string]>) {
    const inst = instanced(geo, mat, list);
    inst.name = name;
    inst.castShadow = false;
    inst.receiveShadow = true;
    inst.frustumCulled = false;
    root.add(inst);
  }

  // 混凝土碎块、砖、土：多数堆在坑沿，少数落进坑里
  for (let i = 0; i < (withWater ? 54 : 26); i += 1) {
    const a = rng.range(0, Math.PI * 2);
    const rim = i % 4 !== 0;
    const rr = spec.r * (rim ? rng.range(0.98, 1.5) : rng.range(0.45, 0.85));
    addConcrete(debris, rng, spec.x + Math.cos(a) * rr, roadY + rng.range(0.04, withWater ? 0.3 : 0.16), spec.z + Math.sin(a) * rr, 0.55);
  }
  for (let i = 0; i < (withWater ? 40 : 18); i += 1) {
    const a = rng.range(0, Math.PI * 2);
    const rr = spec.r * rng.range(0.75, 1.6);
    addBrick(debris, rng, spec.x + Math.cos(a) * rr, roadY + rng.range(0.03, 0.2), spec.z + Math.sin(a) * rr);
  }
  // 崩裂裂缝
  for (let i = 0; i < (withWater ? 22 : 12); i += 1) {
    const a = rng.range(0, Math.PI * 2);
    const rr = spec.r * rng.range(0.9, 2.2);
    decals.cracks.push({
      x: spec.x + Math.cos(a) * rr,
      y: roadY + 0.028,
      z: spec.z + Math.sin(a) * rr,
      yaw: rng.range(0, Math.PI * 2),
      w: rng.range(1.2, 3.4),
      h: rng.range(1.2, 3.4),
    });
  }
  // 脏污的路标碎片
  for (let i = 0; i < 3; i += 1) {
    const a = rng.range(0, Math.PI * 2);
    const paint = box(rng.range(0.5, 0.95), 0.03, 0.14, toonMaterial(0x6f6a5e, { steps: 2 }));
    paint.position.set(Math.cos(a) * spec.r * rng.range(1.1, 1.8), 0.045, Math.sin(a) * spec.r * rng.range(1.1, 1.8));
    paint.rotation.set(rng.range(-0.15, 0.15), rng.range(0, 6.3), rng.range(-0.12, 0.12));
    root.add(paint);
  }

  batchGroupByMaterial(root, withWater ? 'sinkhole' : 'road-break');
  return root;
}

/* ------------------------------------------------------------------ *
 * 废墟堆
 * ------------------------------------------------------------------ */

function buildRubblePile(
  ctx: BuildContext,
  spec: { x: number; z: number; r: number },
  debris: Debris,
  decals: DecalSink,
): THREE.Group {
  const rng = ctx.rng.fork(Math.round(spec.x * 13 + spec.z * 7) ^ 0x71a3);
  const gy = groundYAt(spec.x, spec.z);
  const root = group('war-rubble-pile');
  root.position.set(spec.x, gy, spec.z);
  const radius = spec.r;
  // 核心大块
  for (let i = 0; i < 7; i += 1) {
    const s = rng.range(0.45, 1.0);
    const c = box(s, s * rng.range(0.4, 0.8), s * rng.range(0.7, 1.3), i % 2 === 0 ? M.concreteDark : M.brickDark);
    c.position.set(rng.range(-radius * 0.4, radius * 0.4), rng.range(0.2, radius * 0.65), rng.range(-radius * 0.4, radius * 0.4));
    c.rotation.set(rng.range(-0.6, 0.6), rng.range(0, 6.3), rng.range(-0.6, 0.6));
    root.add(c);
  }
  // 坡面：越靠外越低
  for (let i = 0; i < 150; i += 1) {
    const a = rng.range(0, Math.PI * 2);
    const rr = Math.sqrt(rng.next()) * radius;
    const h = Math.max(0.03, (1 - rr / radius) * radius * 0.8 + rng.range(-0.1, 0.12));
    if (rng.chance(0.55)) addBrick(debris, rng, spec.x + Math.cos(a) * rr, gy + h, spec.z + Math.sin(a) * rr, 0.85);
    else addConcrete(debris, rng, spec.x + Math.cos(a) * rr, gy + h, spec.z + Math.sin(a) * rr, 0.55);
  }
  // 断木与扭曲铁皮
  for (let i = 0; i < 8; i += 1) {
    debris.planks.push({
      position: new THREE.Vector3(spec.x + rng.range(-radius, radius), gy + rng.range(0.2, radius * 0.8), spec.z + rng.range(-radius, radius)),
      rotation: new THREE.Euler(rng.range(-0.8, 0.8), rng.range(0, 6.3), rng.range(-0.8, 0.8)),
      scale: new THREE.Vector3(rng.range(0.6, 1.3), 1, 1),
    });
  }
  for (let i = 0; i < 7; i += 1) {
    debris.metal.push({
      position: new THREE.Vector3(spec.x + rng.range(-radius, radius), gy + rng.range(0.15, radius * 0.9), spec.z + rng.range(-radius, radius)),
      rotation: new THREE.Euler(rng.range(-1, 1), rng.range(0, 6.3), rng.range(-1, 1)),
      scale: new THREE.Vector3(rng.range(0.7, 1.4), rng.range(0.8, 1.4), rng.range(0.6, 1.2)),
    });
  }
  // 挂在上面的破布
  const clothGeo = new THREE.PlaneGeometry(0.6, 0.8);
  const cloth = mesh(clothGeo, new THREE.MeshToonMaterial({
    map: textures().cloth,
    gradientMap: toonGradient(3),
    alphaTest: 0.35,
    side: THREE.DoubleSide,
    color: M.clothRed.color,
  }));
  cloth.position.set(rng.range(-radius * 0.5, radius * 0.5), radius * 0.5, rng.range(-radius * 0.5, radius * 0.5));
  cloth.rotation.set(rng.range(-0.5, 0.5), rng.range(0, 6.3), rng.range(-0.5, 0.5));
  cloth.castShadow = false;
  root.add(cloth);
  addShells(debris, rng, spec.x, spec.z, 14, radius * 0.8);
  for (let i = 0; i < 4; i += 1) {
    const a = rng.range(0, Math.PI * 2);
    const rr = radius * rng.range(1.15, 1.7);
    decals.cracks.push({
      x: spec.x + Math.cos(a) * rr,
      y: gy + 0.03,
      z: spec.z + Math.sin(a) * rr,
      yaw: rng.range(0, 6.3),
      w: rng.range(0.8, 1.8),
      h: rng.range(0.8, 2.0),
    });
  }
  batchGroupByMaterial(root, 'rubble-pile');
  return root;
}

/* ------------------------------------------------------------------ *
 * 防空洞入口
 * ------------------------------------------------------------------ */

function buildBunker(ctx: BuildContext, spec: { x: number; z: number }, debris: Debris, decals: DecalSink): THREE.Group {
  const rng = ctx.rng.fork(0xb00c);
  const gy = groundYAt(spec.x, spec.z);
  const root = group('war-bunker');
  root.position.set(spec.x, gy, spec.z);

  // 半掩埋的土丘：分左右两堆，中间给门洞让路
  for (const side of [-1, 1]) {
    const mound = mesh(jitter(new THREE.SphereGeometry(1, 12, 7), 0.08, rng), M.dirt);
    mound.scale.set(1.9, 0.95, 2.4);
    mound.position.set(side * 2.3, 0.05, -0.5);
    mound.castShadow = true;
    mound.receiveShadow = true;
    root.add(mound);
  }
  const backMound = mesh(jitter(new THREE.SphereGeometry(1, 10, 6), 0.06, rng), M.dirt);
  backMound.scale.set(2.4, 1.2, 1.4);
  backMound.position.set(0, 0.1, -2.0);
  backMound.castShadow = true;
  backMound.receiveShadow = true;
  root.add(backMound);

  // 混凝土门套
  const portal = group('war-bunker-portal');
  const sideA = box(0.45, 2.6, 2.2, M.concreteDark);
  sideA.position.set(-1.55, 1.3, 0.55);
  const sideB = sideA.clone();
  sideB.position.x = 1.55;
  const lintel = box(3.55, 0.5, 2.2, M.concrete);
  lintel.position.set(0, 2.65, 0.55);
  const apron = box(3.9, 0.16, 1.0, M.concrete);
  apron.position.set(0, 0.12, 1.45);
  portal.add(sideA, sideB, lintel, apron);
  batchGroupByMaterial(portal, 'bunker-portal');
  withOutline(portal, 0.003);
  root.add(portal);

  // 黑洞 + 下沉的台阶（只封后墙与两侧，前面留空）
  const darkMat = new THREE.MeshBasicMaterial({ color: 0x05080a });
  const darkBack = new THREE.Mesh(new THREE.PlaneGeometry(2.55, 2.3), darkMat);
  darkBack.position.set(0, 1.15, -1.35);
  root.add(darkBack);
  for (const side of [-1, 1]) {
    const darkSide = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 2.3), darkMat);
    darkSide.position.set(side * 1.2, 1.15, -0.1);
    darkSide.rotation.y = (side * Math.PI) / 2;
    root.add(darkSide);
  }
  for (let i = 0; i < 5; i += 1) {
    const step = box(2.0, 0.14, 0.32, M.concreteDark);
    step.position.set(0, 0.28 - i * 0.05, 0.95 - i * 0.3);
    step.rotation.x = -0.06;
    root.add(step);
  }

  // 锈铁门：半开，门轴在左侧
  const doorPivot = group('war-bunker-door');
  doorPivot.position.set(-1.0, 0.18, 1.58);
  doorPivot.rotation.y = -1.02;
  const door = box(1.85, 2.2, 0.08, M.rust);
  door.position.set(0.9, 1.1, 0);
  doorPivot.add(door);
  for (let i = 0; i < 4; i += 1) {
    const rib = box(1.8, 0.055, 0.045, M.rustDark);
    rib.position.set(0.9, 0.5 + i * 0.42, 0.06);
    doorPivot.add(rib);
  }
  const handle = cyl(0.035, 0.035, 0.22, 6, M.steel);
  handle.rotation.z = Math.PI / 2;
  handle.position.set(1.5, 1.05, 0.1);
  doorPivot.add(handle);
  root.add(doorPivot);

  // 门口沙袋：两翼各两层，压住入口
  for (let i = 0; i < 12; i += 1) {
    const side = i % 2 === 0 ? -1 : 1;
    const row = Math.floor(i / 2) % 3;
    const tier = Math.floor(i / 6);
    addSandbag(
      debris,
      rng,
      spec.x + side * (2.35 + row * 0.18),
      gy + 0.14 + tier * 0.24,
      spec.z + 1.25 + row * 0.5 + rng.range(-0.12, 0.12),
      rng.range(-0.16, 0.16),
    );
  }
  const sign = mesh(new THREE.PlaneGeometry(0.95, 0.62), new THREE.MeshBasicMaterial({ map: signTexture(), color: 0xffffff, fog: true }));
  sign.position.set(1.5, 2.0, 1.68);
  sign.castShadow = false;
  root.add(sign);

  // 门内冷光灯
  const bulb = mesh(new THREE.SphereGeometry(0.07, 8, 5), glowMaterial(0xa9d6ff, 0.75));
  bulb.position.set(0, 2.25, 1.32);
  bulb.castShadow = false;
  root.add(bulb);
  if (ctx.lightCount < 37) {
    const light = new THREE.PointLight(0x9fc8e8, 1.8, 6.5, 2);
    light.position.set(spec.x, gy + 2.1, spec.z + 1.3);
    ctx.addLight(light);
  }

  // 散落的防毒面具
  for (let i = 0; i < 4; i += 1) {
    debris.gasMasks.push({
      position: new THREE.Vector3(spec.x + rng.range(-2.8, 2.8), gy + 0.05, spec.z + rng.range(1.8, 4.2)),
      rotation: new THREE.Euler(rng.range(-1, 1), rng.range(0, 6.3), rng.range(-1, 1)),
      scale: new THREE.Vector3(1, 1, 1),
    });
  }
  decals.moss.push({ x: spec.x - 1.6, y: gy + 0.35, z: spec.z + 1.62, yaw: 0, w: 1.1, h: 0.6 });
  decals.stains.push({ x: spec.x + 1.5, y: gy + 1.4, z: spec.z + 1.62, yaw: 0, w: 0.7, h: 1.9 });
  batchGroupByMaterial(root, 'bunker');
  return root;
}

/* ------------------------------------------------------------------ *
 * 废弃民车（车门大开 / 轮胎干瘪 / 弹孔）
 * ------------------------------------------------------------------ */

function buildAbandonedCar(ctx: BuildContext, spec: { x: number; z: number; rotY: number }): THREE.Group {
  const rng = ctx.rng.fork(0xca4);
  const root = group('war-abandoned-car');
  root.position.set(spec.x, groundYAt(spec.x, spec.z), spec.z);
  root.rotation.y = spec.rotY;
  const bodyMat = toonMaterial(0x4b5044, { steps: 3 });
  const trimMat = toonMaterial(0x1c1f1e, { steps: 2 });
  const roofMat = toonMaterial(0x2b2e2b, { steps: 2 });

  // 车身：硬边体块 + 明确的机盖/后备箱/车顶轮廓
  const lower = box(1.66, 0.42, 3.9, bodyMat);
  lower.position.y = 0.6;
  lower.rotation.z = 0.012;
  root.add(lower);
  const rocker = box(1.72, 0.14, 3.5, trimMat);
  rocker.position.y = 0.4;
  root.add(rocker);
  const hood = box(1.58, 0.16, 1.05, bodyMat);
  hood.position.set(0, 0.86, 1.32);
  hood.rotation.x = 0.025;
  root.add(hood);
  const trunkLid = box(1.58, 0.18, 0.92, bodyMat);
  trunkLid.position.set(0, 0.86, -1.45);
  root.add(trunkLid);
  const cabin = box(1.48, 0.48, 1.82, bodyMat);
  cabin.position.set(0, 1.06, -0.1);
  root.add(cabin);
  const roof = box(1.38, 0.07, 1.55, roofMat);
  roof.position.set(0, 1.34, -0.18);
  roof.rotation.z = -0.05;
  root.add(roof);
  // 立柱
  for (const [sx, sz] of [[-0.72, 0.76], [0.72, 0.76], [-0.72, -1.0], [0.72, -1.0]] as Array<[number, number]>) {
    const pillar = box(0.07, 0.48, 0.07, bodyMat);
    pillar.position.set(sx, 1.08, sz);
    root.add(pillar);
  }
  // 破窗：暗色内腔，A 柱之间留空
  for (const side of [-1, 1]) {
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.34), M.glass);
    glass.position.set(side * 0.74, 1.12, -0.12);
    glass.rotation.y = (side * Math.PI) / 2;
    root.add(glass);
  }
  const windshield = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.35), M.glass);
  windshield.position.set(0, 1.12, 0.8);
  root.add(windshield);
  // 保险杠、格栅、车灯
  for (const z of [1.97, -1.97]) {
    const bumper = box(1.7, 0.14, 0.14, trimMat);
    bumper.position.set(0, 0.48, z);
    root.add(bumper);
  }
  const grille = box(1.0, 0.18, 0.06, trimMat);
  grille.position.set(0, 0.68, 1.96);
  root.add(grille);
  for (const x of [-0.58, 0.58]) {
    const lamp = box(0.24, 0.14, 0.05, toonMaterial(0x8d917d, { steps: 2 }));
    lamp.position.set(x, 0.7, 1.97);
    root.add(lamp);
  }
  // 四扇车门：前门大开、后门半开
  for (const [side, z, angle] of [
    [1, 0.58, -1.15],
    [-1, 0.58, 1.15],
    [1, -0.68, -0.62],
    [-1, -0.68, 0.62],
  ] as Array<[number, number, number]>) {
    const pivot = group('car-door');
    pivot.position.set(side * 0.84, 0.56, z);
    pivot.rotation.y = angle;
    const panel = box(0.055, 0.5, 0.95, bodyMat);
    panel.position.set(0, 0.25, -0.47);
    pivot.add(panel);
    const inner = box(0.03, 0.4, 0.78, trimMat);
    inner.position.set(-side * 0.03, 0.27, -0.47);
    pivot.add(inner);
    const window = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.26), M.glass);
    window.position.set(0, 0.42, -0.48);
    window.rotation.y = Math.PI / 2;
    pivot.add(window);
    root.add(pivot);
  }
  // 车内座椅（车门大开时看得见）
  for (const z of [0.35, -0.55]) {
    const seat = box(0.55, 0.16, 0.45, trimMat);
    seat.position.set(-0.32, 0.86, z);
    root.add(seat);
    const back = box(0.55, 0.44, 0.12, trimMat);
    back.position.set(-0.32, 1.04, z - 0.2);
    back.rotation.x = -0.12;
    root.add(back);
  }
  // 干瘪轮胎：外露、压扁
  for (const [x, z] of [[-0.86, 1.26], [0.86, 1.26], [-0.86, -1.26], [0.86, -1.26]] as Array<[number, number]>) {
    const tyre = mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.22, 12), M.tyre);
    tyre.rotation.z = Math.PI / 2;
    tyre.scale.y = 0.68;
    tyre.position.set(x, 0.3, z);
    root.add(tyre);
    const hub = cyl(0.12, 0.12, 0.24, 8, M.steel);
    hub.rotation.z = Math.PI / 2;
    hub.position.set(x, 0.3, z);
    root.add(hub);
  }
  // 弹孔（车身上的黑色小面片）
  const holes = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.09, 0.09),
    new THREE.MeshBasicMaterial({ color: 0x0a0c0e, transparent: true, opacity: 0.9, depthWrite: false }),
    6,
  );
  const hm = new THREE.Matrix4();
  for (let i = 0; i < 6; i += 1) {
    const side = i % 2 === 0 ? 1 : -1;
    hm.compose(
      new THREE.Vector3(side * 0.865, rng.range(0.5, 0.9), rng.range(-1.4, 1.4)),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, side * Math.PI * 0.5, 0)),
      new THREE.Vector3(1, 1, 1),
    );
    holes.setMatrixAt(i, hm);
  }
  root.add(holes);
  // 打开的后备箱与散落行李
  const trunkDoor = box(1.35, 0.06, 0.9, bodyMat);
  trunkDoor.position.set(0, 0.95, -2.25);
  trunkDoor.rotation.x = -0.9;
  root.add(trunkDoor);
  if (ctx.quality > 0.5) {
    const caseA = softBox(0.7, 0.28, 0.46, 0.08, M.wood);
    caseA.position.set(1.6, 0.2, -1.2);
    caseA.rotation.y = 0.7;
    root.add(caseA);
    const caseB = softBox(0.55, 0.22, 0.38, 0.06, M.clothBlue);
    caseB.position.set(-1.5, 0.18, -1.8);
    caseB.rotation.y = -0.4;
    root.add(caseB);
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.6), new THREE.MeshToonMaterial({
      map: textures().cloth,
      gradientMap: toonGradient(3),
      alphaTest: 0.35,
      side: THREE.DoubleSide,
      color: 0xd8d2c4,
    }));
    cloth.rotation.set(-Math.PI / 2, 0, 0.7);
    cloth.position.set(-0.9, 0.02, -2.4);
    root.add(cloth);
  }
  batchGroupByMaterial(root, 'car');
  withOutline(root, 0.0022);
  return root;
}

/* ------------------------------------------------------------------ *
 * 生活遗物：童车 / 餐具 / 相框 / 玩具 / 行李 / 衣物
 * ------------------------------------------------------------------ */

function buildPram(rng: Rng): THREE.Group {
  const g = group('war-pram');
  const fabric = M.clothBlue;
  // 车斗 + 车架 + 四轮 + 推把：不是一只蓝色浴盆
  const basket = softBox(0.48, 0.2, 0.7, 0.08, fabric);
  basket.position.y = 0.46;
  g.add(basket);
  const apron = box(0.5, 0.05, 0.72, fabric);
  apron.position.set(0, 0.38, 0.02);
  g.add(apron);
  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(0.27, 9, 5, 0, Math.PI, 0, Math.PI * 0.5),
    fabric,
  );
  canopy.scale.set(1, 0.82, 0.95);
  canopy.position.set(0, 0.52, -0.17);
  canopy.rotation.y = Math.PI / 2;
  g.add(canopy);
  // 车架侧梁
  for (const x of [-0.25, 0.25]) {
    g.add(cylinderBetween(new THREE.Vector3(x, 0.3, -0.34), new THREE.Vector3(x, 0.32, 0.34), 0.022, M.steel, 5));
  }
  // 推把
  g.add(cylinderBetween(new THREE.Vector3(-0.23, 0.35, 0.3), new THREE.Vector3(-0.23, 0.72, 0.5), 0.022, M.steel, 5));
  g.add(cylinderBetween(new THREE.Vector3(0.23, 0.35, 0.3), new THREE.Vector3(0.23, 0.72, 0.5), 0.022, M.steel, 5));
  g.add(cylinderBetween(new THREE.Vector3(-0.26, 0.72, 0.5), new THREE.Vector3(0.26, 0.72, 0.5), 0.02, M.steel, 5));
  // 四轮：轮轴露在车架外
  for (const [x, z] of [[-0.3, 0.27], [0.3, 0.27], [-0.3, -0.25], [0.3, -0.25]] as Array<[number, number]>) {
    const wheel = mesh(new THREE.TorusGeometry(0.115, 0.026, 4, 10), M.tyre);
    wheel.rotation.y = Math.PI / 2;
    wheel.position.set(x, 0.13, z);
    g.add(wheel);
    const hub = cyl(0.03, 0.03, 0.06, 6, M.steel);
    hub.rotation.z = Math.PI / 2;
    hub.position.set(x, 0.13, z);
    g.add(hub);
  }
  g.rotation.z = 1.0;
  g.rotation.y = rng.range(0, 6.3);
  g.position.y = 0.34;
  batchGroupByMaterial(g, 'pram');
  return g;
}

function buildDishes(ctx: BuildContext, debris: Debris, decals: DecalSink, x: number, z: number, rng: Rng): void {
  const gy = groundYAt(x, z);
  // 翻倒的餐桌
  const table = group('war-dining-table');
  table.position.set(x, gy, z);
  const topA = box(1.6, 0.07, 0.9, M.wood);
  topA.position.set(0, 0.72, 0);
  topA.rotation.z = 0.12;
  table.add(topA);
  const topB = box(1.1, 0.06, 0.8, M.woodDark);
  topB.position.set(0.7, 0.3, 0.25);
  topB.rotation.set(0.2, 0.4, 0.6);
  table.add(topB);
  for (const [lx, lz] of [[-0.7, 0.35], [0.7, 0.35], [-0.7, -0.35], [0.7, -0.35]] as Array<[number, number]>) {
    const leg = box(0.08, 0.7, 0.08, M.woodDark);
    leg.position.set(lx, 0.35, lz);
    table.add(leg);
  }
  ctx.add(table);

  const plateGeo = new THREE.CylinderGeometry(0.11, 0.12, 0.014, 12);
  const cupGeo = new THREE.CylinderGeometry(0.045, 0.038, 0.08, 8);
  const plates: InstanceTransform[] = [];
  const cups: InstanceTransform[] = [];
  for (let i = 0; i < 16; i += 1) {
    plates.push({
      position: new THREE.Vector3(x + rng.range(-2.2, 2.2), gy + 0.012, z + rng.range(-1.8, 1.8)),
      rotation: new THREE.Euler(rng.range(-0.15, 0.15), rng.range(0, 6.3), rng.range(-0.15, 0.15)),
      scale: new THREE.Vector3(1, 1, 1),
    });
  }
  for (let i = 0; i < 8; i += 1) {
    cups.push({
      position: new THREE.Vector3(x + rng.range(-1.8, 1.8), gy + 0.04, z + rng.range(-1.5, 1.5)),
      rotation: new THREE.Euler(rng.range(-0.5, 0.5), rng.range(0, 6.3), rng.range(-0.5, 0.5)),
      scale: new THREE.Vector3(1, 1, 1),
    });
  }
  const plateInst = instanced(plateGeo, M.ceramic, plates);
  plateInst.name = 'war-plates';
  plateInst.castShadow = false;
  const cupInst = instanced(cupGeo, M.ceramicBlue, cups);
  cupInst.name = 'war-cups';
  cupInst.castShadow = false;
  ctx.add(plateInst);
  ctx.add(cupInst);

  // 相框
  for (let i = 0; i < 2; i += 1) {
    const frame = box(0.32, 0.04, 0.4, M.woodDark);
    frame.position.set(x + rng.range(-1.5, 1.5), gy + 0.03, z + rng.range(-1.2, 1.2));
    frame.rotation.set(rng.range(-0.12, 0.12), rng.range(0, 6.3), rng.range(-0.12, 0.12));
    ctx.add(frame);
    const photoGeo = new THREE.PlaneGeometry(0.25, 0.33);
    photoGeo.rotateX(-Math.PI / 2);
    const photo = new THREE.Mesh(photoGeo, new THREE.MeshBasicMaterial({ map: textures().photo[i], color: 0xffffff }));
    photo.rotation.y = frame.rotation.y;
    photo.position.set(frame.position.x, gy + 0.052, frame.position.z);
    ctx.add(photo);
  }

  // 玩具：木块、玩具车、球
  const blockGeo = new THREE.BoxGeometry(0.11, 0.11, 0.11);
  const blocks: InstanceTransform[] = [];
  for (let i = 0; i < 14; i += 1) {
    blocks.push({
      position: new THREE.Vector3(x + rng.range(-2.4, 2.4), gy + 0.06, z + rng.range(-2, 2)),
      rotation: new THREE.Euler(rng.range(-0.4, 0.4), rng.range(0, 6.3), rng.range(-0.4, 0.4)),
      scale: new THREE.Vector3(1, 1, 1),
    });
  }
  const blockInst = instanced(blockGeo, M.toyRed, blocks);
  blockInst.name = 'war-toy-blocks';
  blockInst.castShadow = false;
  ctx.add(blockInst);
  const toyCar = group('war-toy-car');
  const tcBody = box(0.36, 0.12, 0.2, M.toyBlue);
  tcBody.position.y = 0.09;
  toyCar.add(tcBody);
  const tcTop = box(0.18, 0.08, 0.16, M.toyBlue);
  tcTop.position.set(-0.02, 0.18, 0);
  toyCar.add(tcTop);
  for (const [wx, wz] of [[-0.13, 0.08], [0.13, 0.08], [-0.13, -0.08], [0.13, -0.08]] as Array<[number, number]>) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.03, 8), M.tyre);
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(wx, 0.04, wz);
    toyCar.add(wheel);
  }
  toyCar.position.set(x + 1.6, gy + 0.02, z - 1.2);
  toyCar.rotation.y = 0.7;
  ctx.add(toyCar);
  const ball = mesh(new THREE.SphereGeometry(0.16, 10, 7), M.toyYellow);
  ball.position.set(x - 1.2, gy + 0.16, z + 1.4);
  ctx.add(ball);

  addShells(debris, rng, x, z, 18, 2.8);
  for (let i = 0; i < 9; i += 1) {
    addBrick(debris, rng, x + rng.range(-2.8, 2.8), gy + 0.04, z + rng.range(-2.4, 2.4), 0.7);
  }
  decals.bullets.push({ x: x + 1.1, y: gy + 0.02, z: z + 0.6, yaw: rng.range(0, 6.3), w: 0.5, h: 0.5 });
}

function buildLuggage(ctx: BuildContext, x: number, z: number, rng: Rng): void {
  const gy = groundYAt(x, z);
  const cases: Array<[number, number, number, number, THREE.Material]> = [
    [x - 0.6, z + 0.2, 0.7, 0.3, M.wood],
    [x + 0.5, z - 0.3, 0.55, 0.24, M.clothBlue],
    [x + 0.1, z + 0.9, 0.66, 0.26, M.rust],
  ];
  for (const [cx, cz, w, h, mat] of cases) {
    const c = softBox(w, h, w * 0.62, 0.07, mat);
    c.position.set(cx, gy + h / 2, cz);
    c.rotation.y = rng.range(0, 6.3);
    ctx.add(c);
    const strap = box(w * 0.14, h * 0.7, w * 0.66, M.woodDark);
    strap.position.set(cx, gy + h * 0.64, cz);
    strap.rotation.y = c.rotation.y;
    ctx.add(strap);
  }
  // 敞开的箱子 + 溢出的衣物
  const open = group('war-open-case');
  open.position.set(x, gy, z - 1.0);
  const base = softBox(0.78, 0.18, 0.5, 0.05, M.wood);
  base.position.y = 0.09;
  open.add(base);
  const lid = box(0.78, 0.06, 0.5, M.wood);
  lid.position.set(0, 0.24, -0.32);
  lid.rotation.x = -1.1;
  open.add(lid);
  ctx.add(open);
  for (let i = 0; i < 4; i += 1) {
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.35), new THREE.MeshToonMaterial({
      map: textures().cloth,
      gradientMap: toonGradient(3),
      alphaTest: 0.35,
      side: THREE.DoubleSide,
      color: i % 2 === 0 ? 0xc9c2b2 : 0x7a8a92,
    }));
    cloth.rotation.set(-Math.PI / 2, 0, rng.range(0, 6.3));
    cloth.position.set(x + rng.range(-1.2, 1.2), gy + 0.02, z + rng.range(-1.8, -0.2));
    ctx.add(cloth);
  }
}

/* ------------------------------------------------------------------ *
 * 植被 / 贴花 / 晾衣
 * ------------------------------------------------------------------ */

function scatterRects(
  rng: Rng,
  rects: Array<{ x0: number; x1: number; z0: number; z1: number }>,
  count: number,
  yAt: (x: number, z: number) => number,
  yLift = 0,
): Array<{ x: number; y: number; z: number }> {
  if (rects.length === 0) return [];
  const areas = rects.map((r) => Math.max(0.01, (r.x1 - r.x0) * (r.z1 - r.z0)));
  const total = areas.reduce((a, b) => a + b, 0);
  const out: Array<{ x: number; y: number; z: number }> = [];
  for (let i = 0; i < count; i += 1) {
    let pick = rng.next() * total;
    let rect = rects[0]!;
    for (let j = 0; j < rects.length; j += 1) {
      pick -= areas[j]!;
      if (pick <= 0) {
        rect = rects[j]!;
        break;
      }
    }
    const x = rng.range(rect.x0, rect.x1);
    const z = rng.range(rect.z0, rect.z1);
    out.push({ x, y: yAt(x, z) + yLift, z });
  }
  return out;
}

function buildVegetation(ctx: BuildContext, rng: Rng): { grass: number; weeds: number; vines: number } {
  const greenMap = grassTexture(3);
  const dryMap = grassTexture(19, true);
  const vineMap = vineTexture(5);
  const grassMat = foliageMaterial(greenMap, 0.13);
  const weedMat = foliageMaterial(dryMap, 0.16);
  const vineMat = foliageMaterial(vineMap, 0.045);
  const gy = (x: number, z: number): number => groundYAt(x, z);

  // 分布域：路缘、巷子、废墟周边、哨卡前沿、空地边缘
  const common = [
    { x0: -140, x1: 140, z0: -10.4, z1: -9.1 },
    { x0: -140, x1: 140, z0: 9.1, z1: 10.4 },
    { x0: -9.5, x1: -8.1, z0: -140, z1: 140 },
    { x0: 8.1, x1: 9.5, z0: -140, z1: 140 },
    // 沥青裂缝里的草：铺满车行道，但车队车道 x∈[1.2,5.4] 与其路口段留空
    // （条带宽度不能比原来窄太多，否则同样 520 株会挤成高密度，透明面片过绘直接吃掉 6ms）
    { x0: -140, x1: 1.0, z0: -8.6, z1: 8.6 },
    { x0: 5.6, x1: 140, z0: -8.6, z1: 8.6 },
    { x0: -8.6, x1: 1.0, z0: -140, z1: 140 },
    { x0: 5.6, x1: 8.6, z0: -140, z1: 140 },
    { x0: 24, x1: 44, z0: 35, z1: 53 },
    { x0: 64, x1: 88, z0: -36, z1: -13 },
    { x0: -50, x1: -36, z0: -8, z1: 9 },
    { x0: 48, x1: 62, z0: -8, z1: 8 },
    { x0: -88, x1: 88, z0: 121, z1: 126 },
    { x0: -139, x1: -112, z0: -139, z1: -112 },
    { x0: 112, x1: 139, z0: 112, z1: 139 },
    { x0: -139, x1: -112, z0: 112, z1: 139 },
    ...ALLEYS.map((a) => ({ x0: a.x0, x1: a.x1, z0: a.z0, z1: a.z1 })),
    { x0: 14, x1: 32, z0: 39, z1: 50 },
    { x0: 74, x1: 90, z0: -50, z1: -32 },
  ];
  const points = scatterRects(rng, common, 520, gy, 0.01);
  const dryPoints = scatterRects(rng.fork(2), common, 150, gy, 0.012);
  const grassData: InstanceTransform[] = [];
  const weedData: InstanceTransform[] = [];
  const tint = new THREE.Color();
  for (const [i, p] of points.entries()) {
    const s = rng.range(0.34, 0.78);
    grassData.push({
      position: new THREE.Vector3(p.x, p.y, p.z),
      rotation: new THREE.Euler(0, rng.range(0, Math.PI * 2), 0),
      scale: new THREE.Vector3(s * rng.range(0.7, 1.1), s * rng.range(0.42, 0.88), s),
    });
    tint.setHSL(0.26 + rng.range(-0.04, 0.04), rng.range(0.18, 0.4), rng.range(0.32, 0.52));
    // 记录色调到 userData，稍后统一 setColorAt
    (grassData[i] as InstanceTransform & { tint?: THREE.Color }).tint = tint.clone();
  }
  for (const [i, p] of dryPoints.entries()) {
    const s = rng.range(0.32, 0.72);
    weedData.push({
      position: new THREE.Vector3(p.x, p.y, p.z),
      rotation: new THREE.Euler(0, rng.range(0, Math.PI * 2), 0),
      scale: new THREE.Vector3(s * 0.8, s * rng.range(0.45, 0.9), s),
    });
    tint.setHSL(0.1 + rng.range(-0.03, 0.04), rng.range(0.12, 0.3), rng.range(0.3, 0.46));
    (weedData[i] as InstanceTransform & { tint?: THREE.Color }).tint = tint.clone();
  }

  const grass = instanced(GRASS_GEO, grassMat, grassData);
  grass.name = 'war-grass-green';
  grass.castShadow = false;
  grass.receiveShadow = false;
  grass.frustumCulled = false;
  const weeds = instanced(GRASS_GEO, weedMat, weedData);
  weeds.name = 'war-grass-dry';
  weeds.castShadow = false;
  weeds.receiveShadow = false;
  weeds.frustumCulled = false;
  for (let i = 0; i < grassData.length; i += 1) {
    const c = (grassData[i] as InstanceTransform & { tint?: THREE.Color }).tint;
    if (c) grass.setColorAt(i, c);
  }
  for (let i = 0; i < weedData.length; i += 1) {
    const c = (weedData[i] as InstanceTransform & { tint?: THREE.Color }).tint;
    if (c) weeds.setColorAt(i, c);
  }
  if (grass.instanceColor) grass.instanceColor.needsUpdate = true;
  if (weeds.instanceColor) weeds.instanceColor.needsUpdate = true;
  ctx.add(grass);
  ctx.add(weeds);

  // 攀墙枯藤：贴墙的交叉面片（贴图内自带黑边）
  const vineSpots: Array<{ x: number; y: number; z: number; yaw: number; w: number; h: number }> = [
    { x: 12.06, y: 0, z: -28.5, yaw: -Math.PI / 2, w: 1.8, h: 4.8 },
    { x: 12.06, y: 0, z: -23.8, yaw: -Math.PI / 2, w: 1.5, h: 5.6 },
    { x: 12.06, y: 0, z: -18.6, yaw: -Math.PI / 2, w: 1.7, h: 4.2 },
    { x: 15.5, y: 0, z: -12.94, yaw: 0, w: 2.2, h: 5.4 },
    { x: 27.2, y: 0, z: -12.94, yaw: 0, w: 2.6, h: 6.2 },
    { x: 48.6, y: 0, z: -13.94, yaw: 0, w: 2.0, h: 4.4 },
    { x: 63.2, y: 0, z: -13.94, yaw: 0, w: 1.6, h: 3.6 },
    { x: 70.4, y: 0, z: -17.96, yaw: 0, w: 2.4, h: 5.8 },
    { x: 81.2, y: 0, z: -17.96, yaw: 0, w: 1.8, h: 4.2 },
    { x: 27.35, y: 0, z: 48.98, yaw: 0, w: 1.6, h: 5.2 },
    { x: 39.1, y: 0, z: 48.98, yaw: 0, w: 2.2, h: 3.8 },
    { x: -45.2, y: 0, z: -13.44, yaw: 0, w: 2.0, h: 4.2 },
    { x: -22.6, y: 0, z: -13.44, yaw: 0, w: 1.7, h: 3.4 },
    { x: -41.4, y: 0, z: 31.98, yaw: 0, w: 2.4, h: 4.8 },
    { x: 27.06, y: 0, z: 45.2, yaw: -Math.PI / 2, w: 2.0, h: 4.4 },
    { x: 40.94, y: 0, z: 42.6, yaw: Math.PI / 2, w: 1.7, h: 3.6 },
    { x: 68.06, y: 0, z: -24.6, yaw: -Math.PI / 2, w: 2.2, h: 4.6 },
  ];
  const vineData = vineSpots.map((v, i) => ({
    position: new THREE.Vector3(v.x, groundYAt(v.x, v.z) + v.y, v.z),
    rotation: new THREE.Euler(0, v.yaw, 0),
    scale: new THREE.Vector3(v.w * rng.range(0.85, 1.1), v.h * rng.range(0.8, 1.05), 1),
    tint: new THREE.Color().setHSL(0.24 + (i % 5) * 0.01, 0.22, 0.34 + (i % 3) * 0.05),
  }));
  const vines = instanced(GRASS_GEO, vineMat, vineData);
  vines.name = 'war-vines';
  vines.castShadow = false;
  vines.receiveShadow = false;
  vines.frustumCulled = false;
  for (let i = 0; i < vineData.length; i += 1) vines.setColorAt(i, vineData[i]!.tint);
  if (vines.instanceColor) vines.instanceColor.needsUpdate = true;
  ctx.add(vines);

  return { grass: points.length, weeds: dryPoints.length, vines: vineData.length };
}

function addWallDecals(
  rng: Rng,
  decals: DecalSink,
  runs: Array<{ x0: number; z0: number; x1: number; z1: number; yaw: number }>,
): void {
  for (const run of runs) {
    const len = Math.hypot(run.x1 - run.x0, run.z1 - run.z0);
    const n = Math.max(2, Math.round(len / 3.2));
    for (let i = 0; i < n; i += 1) {
      const t = (i + 0.5) / n + rng.range(-0.08, 0.08);
      const x = run.x0 + (run.x1 - run.x0) * t;
      const z = run.z0 + (run.z1 - run.z0) * t;
      const nx = Math.sin(run.yaw);
      const nz = Math.cos(run.yaw);
      const out = 0.035;
      if (rng.chance(0.5)) {
        decals.moss.push({
          x: x + nx * out,
          y: groundYAt(x, z) + rng.range(0.25, 0.65),
          z: z + nz * out,
          yaw: run.yaw,
          w: rng.range(0.8, 1.8),
          h: rng.range(0.5, 1.1),
        });
      }
      if (rng.chance(0.6)) {
        decals.stains.push({
          x: x + nx * out,
          y: groundYAt(x, z) + rng.range(1.1, 2.8),
          z: z + nz * out,
          yaw: run.yaw,
          w: rng.range(0.45, 0.95),
          h: rng.range(1.4, 3.2),
        });
      }
      if (rng.chance(0.35)) {
        decals.wallCracks.push({
          x: x + nx * out,
          y: groundYAt(x, z) + rng.range(1.4, 4.6),
          z: z + nz * out,
          yaw: run.yaw,
          w: rng.range(0.6, 1.4),
          h: rng.range(1.2, 2.8),
        });
      }
    }
  }
}

function buildDecals(ctx: BuildContext, decals: DecalSink): number {
  const groups: Array<{ name: string; map: THREE.CanvasTexture; items: DecalSink['cracks']; geo: THREE.BufferGeometry; color: number; opacity: number }> = [
    { name: 'war-decal-cracks', map: crackTexture(4), items: decals.cracks, geo: GROUND_DECAL_GEO, color: 0xffffff, opacity: 0.8 },
    { name: 'war-decal-bullets', map: bulletTexture(), items: decals.bullets, geo: GROUND_DECAL_GEO, color: 0xffffff, opacity: 0.9 },
    { name: 'war-decal-moss', map: mossTexture(6), items: decals.moss, geo: WALL_DECAL_GEO, color: 0x9fae87, opacity: 0.95 },
    { name: 'war-decal-stains', map: stainTexture(9), items: decals.stains, geo: WALL_DECAL_GEO, color: 0xffffff, opacity: 0.9 },
    { name: 'war-decal-wallcracks', map: crackTexture(17), items: decals.wallCracks, geo: WALL_DECAL_GEO, color: 0xffffff, opacity: 0.75 },
  ];
  let total = 0;
  for (const g of groups) {
    if (g.items.length === 0) continue;
    const transforms: InstanceTransform[] = g.items.map((d) => ({
      position: new THREE.Vector3(d.x, d.y, d.z),
      rotation: new THREE.Euler(0, d.yaw, 0),
      // 地面贴花几何已经绕 X 轴放平：局部 Y 是厚度，局部 Z 才是深度
      scale:
        g.geo === GROUND_DECAL_GEO
          ? new THREE.Vector3(d.w, 1, d.h)
          : new THREE.Vector3(d.w, d.h, 1),
    }));
    const inst = instanced(g.geo, decalMaterial(g.map, g.color, g.opacity), transforms);
    inst.name = g.name;
    inst.castShadow = false;
    inst.receiveShadow = false;
    inst.frustumCulled = false;
    inst.renderOrder = 2;
    ctx.add(inst);
    total += g.items.length;
  }
  return total;
}

function buildLaundry(ctx: BuildContext, rng: Rng): number {
  const spec = WARZONE.laundry;
  const gy = groundYAt(spec.x0, spec.z);
  const root = group('war-laundry');
  // 两根歪斜的杆
  for (const x of [spec.x0 - 0.2, spec.x1 + 0.2]) {
    const pole = cyl(0.05, 0.065, spec.y + 0.1, 6, M.rustDark);
    pole.position.set(x, gy + (spec.y + 0.1) / 2, spec.z);
    pole.rotation.z = rng.range(-0.06, 0.06);
    root.add(pole);
  }
  const line = cylinderBetween(
    new THREE.Vector3(spec.x0 - 0.2, gy + spec.y, spec.z),
    new THREE.Vector3(spec.x1 + 0.2, gy + spec.y - 0.16, spec.z),
    0.014,
    M.dark,
    4,
  );
  root.add(line);

  const mat = clothMaterial(textures().cloth);
  const items: Array<{ x: number; z: number; w: number; h: number; color: THREE.Color }> = [
    { x: spec.x0 + 0.5, z: spec.z, w: 0.9, h: 1.45, color: new THREE.Color(0xd7d0bf) },
    { x: spec.x0 + 1.55, z: spec.z, w: 0.62, h: 0.9, color: new THREE.Color(0x8da0ab) },
    { x: spec.x0 + 2.7, z: spec.z, w: 1.05, h: 1.25, color: new THREE.Color(0xa76a60) },
    { x: spec.x0 + 4.1, z: spec.z, w: 0.55, h: 0.75, color: new THREE.Color(0xc8c0aa) },
    { x: spec.x0 + 5.3, z: spec.z, w: 1.25, h: 1.6, color: new THREE.Color(0xa9b1b1) },
    { x: spec.x0 + 6.7, z: spec.z, w: 0.72, h: 1.1, color: new THREE.Color(0x8d9a83) },
    { x: spec.x0 + 8.0, z: spec.z, w: 0.95, h: 1.35, color: new THREE.Color(0xbfb7a2) },
  ];
  const transforms: InstanceTransform[] = items.map((it, i) => ({
    position: new THREE.Vector3(it.x, gy + spec.y - (i === 4 ? 0.18 : 0), it.z),
    rotation: new THREE.Euler(0, 0, rng.range(-0.03, 0.03)),
    scale: new THREE.Vector3(it.w, it.h, 1),
  }));
  const inst = instanced(LAUNDRY_GEO, mat, transforms);
  inst.name = 'war-laundry-cloth';
  inst.castShadow = false;
  inst.receiveShadow = false;
  inst.frustumCulled = false;
  for (let i = 0; i < items.length; i += 1) inst.setColorAt(i, items[i]!.color);
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  root.add(inst);

  // 一条挂在断楼板上的床单
  const sheet = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 2.4), clothMaterial(textures().sheet));
  sheet.position.set(39.2, gy + 6.4, 49.9);
  sheet.rotation.set(0.12, 0.08, 0.16);
  sheet.castShadow = false;
  root.add(sheet);

  ctx.add(root);
  return items.length + 1;
}

/* ------------------------------------------------------------------ *
 * 现场光源：烧着的油桶（剖切楼前） + 弹坑边的红色信号火炬
 * ------------------------------------------------------------------ */

function buildBurningBarrel(ctx: BuildContext, x: number, z: number): THREE.Group {
  const gy = groundYAt(x, z);
  const root = group('war-burning-barrel');
  root.position.set(x, gy, z);
  const drum = mesh(new THREE.CylinderGeometry(0.33, 0.36, 0.92, 10), M.rust);
  drum.position.y = 0.46;
  root.add(drum);
  for (const y of [0.24, 0.7]) {
    const band = mesh(new THREE.TorusGeometry(0.35, 0.02, 4, 12), M.rustDark);
    band.rotation.x = Math.PI / 2;
    band.position.y = y;
    root.add(band);
  }
  for (let i = 0; i < 4; i += 1) {
    const hole = box(0.16, 0.1, 0.04, M.dark);
    const a = i * 1.8;
    hole.position.set(Math.cos(a) * 0.34, 0.35 + i * 0.12, Math.sin(a) * 0.34);
    hole.rotation.y = -a + Math.PI / 2;
    root.add(hole);
  }
  const ember = mesh(new THREE.ConeGeometry(0.24, 0.8, 6), glowMaterial(0xff7a2f, 0.95));
  ember.position.y = 1.0;
  ember.castShadow = false;
  const core = mesh(new THREE.ConeGeometry(0.12, 0.46, 6), glowMaterial(0xffd28a, 1));
  core.position.y = 0.95;
  core.castShadow = false;
  // 火苗靠逐件改 scale 跳动，被合进批次就再也改不动
  ember.userData['noBatch'] = true;
  core.userData['noBatch'] = true;
  root.add(ember, core);
  const light = new THREE.PointLight(0xff8a3c, 5.0, 14, 2);
  light.position.set(x, gy + 1.2, z);
  ctx.addLight(light);
  ctx.ticker.add((t) => {
    const f = 0.82 + 0.18 * Math.sin(t * 10.7) + 0.08 * Math.sin(t * 25.3 + 1.2);
    ember.scale.set(0.9 + f * 0.2, 0.8 + f * 0.35, 0.9 + f * 0.2);
    core.scale.setScalar(0.85 + f * 0.22);
    light.intensity = 4.2 + f * 1.4;
  });
  batchGroupByMaterial(root, 'barrel');
  return root;
}

function buildCraterLamp(ctx: BuildContext, x: number, z: number): THREE.Group {
  const gy = groundYAt(x, z);
  const root = group('war-crater-lamp');
  root.position.set(x, gy, z);
  // 三脚架
  for (let i = 0; i < 3; i += 1) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    const leg = cylinderBetween(
      new THREE.Vector3(Math.cos(a) * 0.55, 0, Math.sin(a) * 0.55),
      new THREE.Vector3(0, 2.6, 0),
      0.028,
      M.steel,
      5,
    );
    root.add(leg);
  }
  const head = box(0.55, 0.28, 0.36, M.steel);
  head.position.set(0, 2.7, 0);
  head.rotation.x = 0.45;
  root.add(head);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.22), glowMaterial(0xdcecff, 0.95));
  face.position.set(0, 2.55, 0.19);
  face.rotation.x = -1.1;
  face.castShadow = false;
  face.userData['noBatch'] = true;
  root.add(face);
  const light = new THREE.PointLight(0xcfe2ef, 14, 20, 1.5);
  light.position.set(x, gy + 2.55, z + 0.2);
  ctx.addLight(light);
  ctx.ticker.add((t) => {
    light.intensity = 13 + 0.9 * Math.sin(t * 1.7) + 0.4 * Math.sin(t * 9.1);
  });
  batchGroupByMaterial(root, 'crater-lamp');
  return root;
}

function buildRoadFlare(ctx: BuildContext, x: number, z: number): THREE.Group {
  const gy = groundYAt(x, z);
  const root = group('war-road-flare');
  root.position.set(x, gy, z);
  const stick = cyl(0.028, 0.034, 0.5, 6, toonMaterial(0x7a2f22, { steps: 2 }));
  stick.rotation.z = 1.1;
  stick.position.set(0, 0.08, 0);
  root.add(stick);
  const ember = mesh(new THREE.SphereGeometry(0.09, 8, 6), glowMaterial(0xff5a3a, 1));
  ember.position.set(0.2, 0.12, 0);
  ember.castShadow = false;
  ember.userData['noBatch'] = true;
  root.add(ember);
  const light = new THREE.PointLight(0xff5a3a, 4.5, 11, 2);
  light.position.set(x + 0.2, gy + 0.35, z);
  ctx.addLight(light);
  ctx.ticker.add((t) => {
    const f = 0.7 + 0.3 * Math.sin(t * 16.3) * Math.sin(t * 7.1 + 0.8);
    light.intensity = 2.2 + f * 3.0;
    (ember.material as THREE.MeshBasicMaterial).opacity = 0.65 + f * 0.35;
  });
  return root;
}

/* ------------------------------------------------------------------ *
 * 地面贴花散布
 * ------------------------------------------------------------------ */

function scatterGroundDecals(rng: Rng, decals: DecalSink): void {
  // 主大道
  for (let i = 0; i < 46; i += 1) {
    const x = rng.range(-138, 138);
    const z = rng.range(-8.4, 8.4);
    decals.cracks.push({ x, y: groundYAt(x, z) + 0.03, z, yaw: rng.range(0, 6.3), w: rng.range(0.7, 2.2), h: rng.range(0.8, 2.6) });
  }
  // 纵街
  for (let i = 0; i < 36; i += 1) {
    const x = rng.range(-7.6, 7.6);
    const z = rng.range(-138, 138);
    decals.cracks.push({ x, y: groundYAt(x, z) + 0.03, z, yaw: rng.range(0, 6.3), w: rng.range(0.7, 2.2), h: rng.range(0.8, 2.6) });
  }
  // 人行道与街角
  for (let i = 0; i < 26; i += 1) {
    const x = rng.range(-120, 120);
    const z = rng.chance(0.5) ? rng.range(-12.8, -9.2) : rng.range(9.2, 12.8);
    decals.cracks.push({ x, y: groundYAt(x, z) + 0.03, z, yaw: rng.range(0, 6.3), w: rng.range(0.8, 2.4), h: rng.range(0.8, 2.4) });
  }
  // 弹孔：战斗过的街区更密
  const hot: Array<{ x0: number; x1: number; z0: number; z1: number }> = [
    { x0: -40, x1: 40, z0: -40, z1: 40 },
    { x0: 44, x1: 90, z0: -30, z1: -8 },
    { x0: 20, x1: 46, z0: 30, z1: 60 },
    { x0: -90, x1: -60, z0: -30, z1: 30 },
  ];
  for (let i = 0; i < 120; i += 1) {
    const a = hot[i % hot.length]!;
    const x = rng.range(a.x0, a.x1);
    const z = rng.range(a.z0, a.z1);
    if (Math.abs(x) > 139 || Math.abs(z) > 139) continue;
    decals.bullets.push({ x, y: groundYAt(x, z) + 0.026, z, yaw: rng.range(0, 6.3), w: rng.range(0.35, 0.7), h: rng.range(0.35, 0.7) });
  }
}

/* ------------------------------------------------------------------ *
 * 实例化碎件提交
 * ------------------------------------------------------------------ */

function commitDebris(ctx: BuildContext, d: Debris, rng: Rng): Record<string, number> {
  const counts: Record<string, number> = {};
  const add = (name: string, list: InstanceTransform[], geo: THREE.BufferGeometry, mat: THREE.Material, shadow = false): void => {
    if (list.length === 0) return;
    const inst = instanced(geo, mat, list);
    inst.name = name;
    inst.castShadow = shadow;
    inst.receiveShadow = true;
    inst.frustumCulled = false;
    ctx.add(inst);
    counts[name] = list.length;
  };

  const brickGeo = jitter(new THREE.BoxGeometry(0.24, 0.07, 0.12), 0.008, rng);
  add('war-debris-brick', d.brickA, brickGeo, M.brick);
  add('war-debris-brick-dark', d.brickB, brickGeo, M.brickDark);
  add('war-debris-brick-burnt', d.brickBurnt, brickGeo, toonMaterial(0x3b3029, { steps: 2 }));
  const chunkGeo = jitter(new THREE.DodecahedronGeometry(0.3, 0), 0.06, rng);
  add('war-debris-concrete', d.concreteA, chunkGeo, M.concrete);
  add('war-debris-concrete-dark', d.concreteB, chunkGeo, M.concreteDark);
  add('war-debris-planks', d.planks, jitter(new THREE.BoxGeometry(1.4, 0.08, 0.18), 0.01, rng), M.wood);
  add('war-debris-metal', d.metal, jitter(new THREE.BoxGeometry(0.9, 0.035, 0.7), 0.04, rng), M.rust);
  add('war-shells', d.shells, new THREE.CylinderGeometry(0.014, 0.016, 0.11, 6), M.brass);
  add('war-sandbags', d.sandbags, softBox(0.62, 0.26, 0.4, 0.16, M.sandbag).geometry, M.sandbag, true);
  add('war-track-pads', d.tracks, trackPadGeometry(), M.steel);
  add('war-rebar', d.rebar, bentRebarGeometry(), M.rustDark);
  add('war-gasmasks', d.gasMasks, (() => {
    const a = new THREE.SphereGeometry(0.11, 8, 5);
    a.scale(0.8, 1, 0.7);
    const b = new THREE.CylinderGeometry(0.045, 0.055, 0.08, 6);
    b.rotateX(Math.PI / 2);
    b.translate(0, -0.02, 0.12);
    return mergeAll([a, b]);
  })(), M.rustDark);
  add('war-backpacks', d.backpacks, (() => {
    const body = new THREE.BoxGeometry(0.36, 0.46, 0.22);
    const flap = new THREE.BoxGeometry(0.34, 0.16, 0.24);
    flap.translate(0, 0.2, 0.01);
    const strapA = new THREE.BoxGeometry(0.05, 0.5, 0.04);
    strapA.translate(-0.11, -0.02, 0.13);
    const strapB = strapA.clone();
    strapB.translate(0.22, 0, 0);
    return mergeAll([body, flap, strapA, strapB]);
  })(), toonMaterial(PALETTE.olive, { steps: 2 }));
  add('war-vests', d.vests, (() => {
    const v = vestGeometry(0.5, 0.58, 0.24);
    return mergeAll([v.body, v.pouches]);
  })(), toonMaterial(PALETTE.oliveDark, { steps: 2 }));
  add('war-hedgehogs', d.hedgehogs, (() => {
    const beams: THREE.BufferGeometry[] = [];
    const axes: Array<[number, number, number]> = [
      [0, 0, 0],
      [0, 0, Math.PI / 2],
      [0, Math.PI / 2, 0],
    ];
    for (const [rx, ry, rz] of axes) {
      const beam = new THREE.CylinderGeometry(0.09, 0.09, 1.7, 5);
      beam.rotateX(rx);
      beam.rotateY(ry);
      beam.rotateZ(rz);
      beams.push(beam);
    }
    return mergeAll(beams);
  })(), M.rust);
  return counts;
}

/* ------------------------------------------------------------------ *
 * 空地补建：北郊院子以东的一排塌房与院落杂物
 *  - 该块地被北带联排、院子、东环道与东剖切楼围住，原本只有几个空地填充点
 *  - 四栋房子的塌法各不相同：二层残楼 / 一层铺面 / 只剩骨架构件 / 半塌农舍
 *  - 全部静态几何共用一张材质批次表，最后只描一次边，避免 4 栋 × 8 材质把 draw call 顶爆
 * ------------------------------------------------------------------ */

interface RuinHouseSpec {
  x: number;
  z: number;
  w: number;
  d: number;
  floors: number;
  seed: number;
  kind: 'rowhouse' | 'shop' | 'shell' | 'cottage';
  rotY: number;
}

const RUIN_ROW: RuinHouseSpec[] = [
  { x: 77, z: -70, w: 9, d: 7, floors: 2, seed: 0x51a1, kind: 'rowhouse', rotY: 0.02 },
  { x: 86, z: -69, w: 6, d: 7, floors: 1, seed: 0x51a2, kind: 'shop', rotY: -0.03 },
  { x: 70, z: -52.5, w: 8, d: 6.5, floors: 2, seed: 0x51a3, kind: 'shell', rotY: 0.04 },
  { x: 82, z: -51, w: 9, d: 8, floors: 2, seed: 0x51a4, kind: 'cottage', rotY: -0.02 },
  // 南沿一排：正对东剖切楼与大道，是圈内空地上最先看到的一排
  { x: 75.5, z: -40.5, w: 8, d: 6.5, floors: 2, seed: 0x51a5, kind: 'rowhouse', rotY: 0.015 },
  { x: 84.5, z: -40, w: 7, d: 6, floors: 1, seed: 0x51a6, kind: 'shop', rotY: -0.025 },
  { x: 89.5, z: -46.5, w: 3.4, d: 7, floors: 2, seed: 0x51a7, kind: 'shell', rotY: 0.03 },
  // 东北角棚屋：补上环道与北排之间的缺
  { x: 88, z: -62.6, w: 5.2, d: 4.6, floors: 1, seed: 0x51a8, kind: 'cottage', rotY: -0.02 },
];

function buildRuinRow(ctx: BuildContext, debris: Debris, decals: DecalSink): THREE.Group {
  const rng = ctx.rng.fork(0x51aa);
  const root = group('war-ruin-row');
  const batches = new Map<THREE.Material, THREE.Mesh[]>();
  const put = (
    mat: THREE.Material,
    geo: THREE.BufferGeometry,
    x: number,
    y: number,
    z: number,
    ry = 0,
    rz = 0,
    rx = 0,
  ): void => {
    const m = mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    m.receiveShadow = true;
    const list = batches.get(mat);
    if (list) list.push(m);
    else batches.set(mat, [m]);
  };
  const b = (
    mat: THREE.Material,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    ry = 0,
    rz = 0,
    rx = 0,
  ): void => put(mat, new THREE.BoxGeometry(w, h, d), x, y, z, ry, rz, rx);
  const cylAt = (
    mat: THREE.Material,
    rad: number,
    h: number,
    seg: number,
    x: number,
    y: number,
    z: number,
    ry = 0,
    rz = 0,
    rx = 0,
  ): void => {
    const m = mesh(new THREE.CylinderGeometry(rad, rad, h, seg), mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    m.receiveShadow = true;
    const list = batches.get(mat);
    if (list) list.push(m);
    else batches.set(mat, [m]);
  };
  const rod = (mat: THREE.Material, ax: number, ay: number, az: number, bx: number, by: number, bz: number, rad = 0.03): void => {
    const m = cylinderBetween(new THREE.Vector3(ax, ay, az), new THREE.Vector3(bx, by, bz), rad, mat, 5);
    m.castShadow = true;
    m.receiveShadow = true;
    const list = batches.get(mat);
    if (list) list.push(m);
    else batches.set(mat, [m]);
  };
  // 这块地的砖比镇上的更旧更黑：同一张砖色在阴影里会泛成粉白，跟周边砖楼对不上
  const burntBrick = toonMaterial(0x874634, { steps: 2 });
  const burntBrickDark = toonMaterial(0x593026, { steps: 2 });
  const burntRust = toonMaterial(0x4e3a30, { steps: 2 });
  // 旧楼板/地坪专用：共用材质在夜景里会反成一块白板
  const slabMat = toonMaterial(0x3b3e42, { steps: 2 });
  const sootMat = toonMaterial(0x1b1a19, { steps: 2 });

  /** 一栋房子的残骸：局部坐标以房子中心为原点，最后整体搬到世界坐标 */
  const house = (spec: RuinHouseSpec): void => {
    const r = rng.fork(spec.seed);
    const gy = groundYAt(spec.x, spec.z);
    const W = spec.w;
    const D = spec.d;
    const FH = 3.1;
    const topY = spec.floors * FH;
    const frontZ = D / 2;
    const backZ = -D / 2;
    // 局部→世界：房子有轻微偏转，所有构件都在这个坐标系里摆
    const cos = Math.cos(spec.rotY);
    const sin = Math.sin(spec.rotY);
    const at = (lx: number, lz: number): [number, number] => [
      spec.x + lx * cos + lz * sin,
      spec.z - lx * sin + lz * cos,
    ];
    const B = (
      mat: THREE.Material,
      w: number,
      h: number,
      d: number,
      lx: number,
      ly: number,
      lz: number,
      ry = 0,
      rz = 0,
      rx = 0,
    ): void => {
      const [wx, wz] = at(lx, lz);
      b(mat, w, h, d, wx, gy + ly, wz, spec.rotY + ry, rz, rx);
    };

    // 地坪与散水：比楼体略大，边缘被碎屑盖住；顶面压暗，避免夜景里反成一块白板
    B(M.dirt, W + 2.4, 0.06, D + 2.2, 0, 0.03, 0.15, 0.008);
    B(M.concreteDark, W + 1.1, 0.16, D + 1.0, 0, 0.06, 0.1, 0.008);
    B(slabMat, W + 0.3, 0.1, D + 0.25, 0, 0.14, 0.1);

    /* —— 墙体 —— */
    const wallT = 0.34;
    if (spec.kind === 'rowhouse') {
      // 后墙：完整但顶部参差
      const segs = 4;
      for (let i = 0; i < segs; i += 1) {
        const sw = W / segs;
        const h = topY - r.range(0.2, 1.6) - (i === 1 ? 1.4 : 0);
        B(burntBrick, sw * 1.01, h, wallT, -W / 2 + sw * (i + 0.5), h / 2, backZ);
        B(burntBrickDark, sw * r.range(0.25, 0.6), r.range(0.12, 0.4), wallT + 0.04, -W / 2 + sw * (i + 0.5), h + 0.1, backZ, r.range(-0.2, 0.2));
      }
      // 前墙：门窗都是真洞，二层窗一直敞到断口，不再贴黑片冒充
      const winW = 1.35;
      const winX = W * 0.29;
      const doorW = 1.15;
      const piers: Array<[number, number]> = [
        [-W / 2, -winX - winW / 2],
        [-winX + winW / 2, -doorW / 2],
        [doorW / 2, winX - winW / 2],
        [winX + winW / 2, W / 2],
      ];
      piers.forEach(([x0, x1], i) => {
        const pw = x1 - x0;
        const ph = topY - r.range(0.15, 1.2) - (i === 3 ? 1.3 : 0);
        B(burntBrick, pw, ph, wallT, (x0 + x1) / 2, ph / 2, frontZ);
        B(burntBrickDark, pw * r.range(0.45, 0.95), r.range(0.14, 0.4), wallT + 0.04, (x0 + x1) / 2, ph + 0.05, frontZ, r.range(-0.16, 0.16));
      });
      // 二层楼板断口：两段露头的楼板边，中间塌掉
      for (const sx of [-1, 1] as const) {
        B(M.concreteDark, W * 0.32, 0.16, wallT + 0.14, sx * W * 0.24, 3.52, frontZ, 0, r.range(-0.03, 0.03));
      }
      for (const sx of [-1, 1] as const) {
        const wx = sx * winX;
        // 窗台、过梁、窗间墙：一层窗洞 0.8..2.35，二层从 3.6 敞到断口
        B(burntBrickDark, winW + 0.26, 0.8, wallT + 0.03, wx, 0.4, frontZ);
        B(M.concreteDark, winW + 0.4, 0.16, wallT + 0.12, wx, 2.42, frontZ, 0, r.range(-0.04, 0.04));
        B(burntBrick, winW + 0.3, 1.0, wallT + 0.02, wx, 3.0, frontZ);
        B(M.concreteDark, winW + 0.34, 0.14, wallT + 0.08, wx, 3.55, frontZ);
        // 洞后压暗，保证任何角度都是黑腔而不是透到后墙
        B(M.dark, winW, 1.5, 0.06, wx, 1.56, frontZ - 0.5);
        B(M.dark, winW, 1.35, 0.06, wx, FH + 1.7, frontZ - 0.5);
        // 火烧过的黑斑：窗上沿与墙角
        B(M.dark, winW * 0.85, r.range(0.35, 0.7), 0.04, wx, 2.95, frontZ + 0.19, 0, r.range(-0.2, 0.2));
      }
      // 门洞：门框残料 + 上方塌穿
      B(M.woodDark, 0.12, 2.3, 0.12, -doorW / 2 - 0.04, 1.15, frontZ + 0.16);
      B(M.woodDark, 0.12, 1.1, 0.12, doorW / 2 + 0.04, 1.95, frontZ + 0.16, 0, 0.44);
      B(burntBrick, doorW + 0.28, 0.2, wallT + 0.04, 0, 2.52, frontZ);
      B(M.dark, doorW, 2.3, 0.06, 0, 1.2, frontZ - 0.5);
      // 墙角的烟熏与剥落
      B(sootMat, 0.55, 2.6, 0.05, W / 2 - 0.35, 1.4, frontZ + 0.18, 0, 0.04);
      B(M.plaster, 0.7, r.range(0.8, 1.3), 0.05, -W * 0.44, r.range(1.6, 2.4), frontZ + 0.18);
      // 塌落的屋架：三根烧焦木梁一端还搭在后墙上，另一端戳出前立面下方
      for (let i = 0; i < 3; i += 1) {
        B(i === 1 ? M.dark : M.woodDark, 0.24, 0.26, D * 0.95, -W * 0.3 + i * W * 0.3, topY - 0.55 - i * 0.18, -D * 0.02, 0, r.range(-0.08, 0.08), 0.92 - i * 0.08);
      }
      // 山墙上的烟囱还立着
      B(burntBrickDark, 0.62, 3.2, 0.62, W * 0.33, (topY + 1.2) / 2, -D * 0.28);
      B(M.concreteDark, 0.78, 0.14, 0.78, W * 0.33, topY + 1.27, -D * 0.28);
      // 左侧墙：保留，带窗洞与剥落
      {
        const sh = topY - 0.8;
        const holesZ = [-D * 0.26, D * 0.28];
        const holeW = 1.05;
        // 竖向切三段，中间留窗洞；窗洞上下补墙
        B(burntBrick, wallT, sh, holeW * 0.5, -W / 2, sh / 2, -D / 2 + holeW * 0.25);
        B(burntBrick, wallT, sh, D - 2 * holeW * 0.75 - holeW * 0.7, -W / 2, sh / 2, 0);
        B(burntBrick, wallT, sh, holeW * 0.5, -W / 2, sh / 2, D / 2 - holeW * 0.25);
        for (const hz of holesZ) {
          B(M.dark, 0.06, 1.4, holeW, -W / 2 - 0.16, 1.85, hz);
          B(burntBrick, wallT, 0.5, holeW + 0.12, -W / 2, 2.8, hz);
          B(burntBrick, wallT, 0.55, holeW + 0.12, -W / 2, 0.28, hz);
          if (sh > FH + 1.6) {
            B(M.dark, 0.06, 1.35, holeW, -W / 2 - 0.16, FH + 1.8, hz);
          }
        }
        B(M.plaster, 0.05, r.range(0.9, 1.6), r.range(0.7, 1.4), -W / 2 - 0.18, r.range(1.2, 2.2), r.range(-D * 0.3, D * 0.3));
        B(sootMat, 0.04, r.range(0.8, 1.4), r.range(0.6, 1.2), -W / 2 - 0.2, topY - 1.1, r.range(-D * 0.3, D * 0.3));
      }
      // 右侧墙：只到一层，断口朝外翻
      B(burntBrick, wallT, 2.1, D * 0.55, W / 2, 1.05, -D * 0.22);
      B(burntBrickDark, wallT + 0.05, 0.3, D * 0.2, W / 2 + 0.2, 2.2, -D * 0.1, r.range(-0.3, 0.3), 0.22);
    } else if (spec.kind === 'shop') {
      // 铺面：正面几乎完整，后墙塌掉
      const doorW = 1.3;
      const winW = W * 0.42;
      const sideW = (W - doorW - winW - 0.6) / 2;
      B(burntBrick, sideW, 3.0, wallT, -W / 2 + sideW / 2, 1.5, frontZ);
      B(burntBrick, sideW, 3.0, wallT, W / 2 - sideW / 2, 1.5, frontZ);
      B(burntBrick, doorW, 3.0, wallT, -W * 0.18, 1.5, frontZ);
      B(burntBrickDark, W - 2 * sideW - doorW, 0.55, wallT, 0, 2.85, frontZ);
      B(M.dark, W * 0.55, 0.9, 0.04, W * 0.1, 2.55, frontZ + 0.19);
      B(M.dark, winW, 2.1, 0.05, W * 0.17, 1.55, frontZ + 0.19);
      // 窗框断料
      B(M.woodDark, 0.09, 2.2, 0.09, W * 0.17 - winW / 2, 1.5, frontZ + 0.2, 0.04);
      B(M.woodDark, 0.09, 1.7, 0.09, W * 0.17 + winW / 2, 1.35, frontZ + 0.2, -0.12);
      B(M.woodDark, winW, 0.09, 0.09, W * 0.17, 2.2, frontZ + 0.2, 0, 0.06);
      // 侧墙与后墙残段
      B(burntBrick, wallT, 2.4, D * 0.8, -W / 2, 1.2, -D * 0.1);
      B(burntBrickDark, wallT, 1.2, D * 0.32, W / 2, 0.6, -D * 0.34);
      B(burntBrick, W * 0.42, 1.35, wallT, -W * 0.29, 0.68, backZ);
      // 店招：只剩两根斜撑
      B(M.woodDark, 0.09, 1.1, 0.09, -W * 0.3, 3.35, frontZ + 0.5, 0, 0.35);
      B(M.woodDark, 0.09, 0.9, 0.09, W * 0.3, 3.3, frontZ + 0.5, 0, -0.4);
      B(M.woodDark, W * 0.62, 0.6, 0.1, 0, 4.0, frontZ + 0.72, 0, 0.1, 0.12);
      // 柜台与货架残骸
      B(M.wood, W * 0.5, 0.9, 0.6, -W * 0.16, 0.45, -D * 0.18, 0.02);
      B(M.woodDark, W * 0.42, 0.14, 0.5, -W * 0.16, 0.98, -D * 0.18, 0.02);
      B(M.wood, 0.5, 1.7, 0.35, W * 0.3, 0.85, -D * 0.28, 0, 0.14);
    } else if (spec.kind === 'shell') {
      // 骨架：两面墙 + 楼板残片，钢筋外露
      B(M.concreteDark, wallT, topY - 0.4, D, -W / 2, (topY - 0.4) / 2, 0);
      B(M.concreteDark, W, topY - 1.2, wallT, 0, (topY - 1.2) / 2, backZ);
      // 断面露新茬：只在断口附近用浅色
      B(M.concreteLight, wallT + 0.02, 0.16, D * 0.9, -W / 2, topY - 0.4, 0);
      B(burntBrick, W * 0.42, 2.2, wallT + 0.06, W * 0.16, 1.1, backZ, 0.01);
      // 楼板：只剩两角
      for (const [sx, sz, sw, sd] of [
        [-1, 1, W * 0.42, D * 0.4],
        [1, -1, W * 0.3, D * 0.35],
      ] as Array<[number, number, number, number]>) {
        B(M.concreteDark, sw, 0.18, sd, sx * (W / 2 - sw / 2), FH - 0.12, sz * (D / 2 - sd / 2));
        B(slabMat, sw, 0.06, sd, sx * (W / 2 - sw / 2), FH - 0.01, sz * (D / 2 - sd / 2));
        // 楼板上压一层碎块：整块浅灰板从俯视看像一张白卡
        for (let i = 0; i < 4; i += 1) {
          addConcrete(debris, r, spec.x + sx * (W / 2 - sw / 2) + r.range(-sw * 0.4, sw * 0.4), gy + FH + 0.12, spec.z + sz * (D / 2 - sd / 2) + r.range(-sd * 0.4, sd * 0.4), 0.9);
        }
      }
      // 断梁：一端还搭在墙上，一端垂到地面
      B(M.concreteDark, 0.26, 0.22, D * 0.62, -W * 0.18, FH - 0.55, 0, 0, 0, 0.16);
      B(M.concreteDark, W * 0.42, 0.2, 0.26, W * 0.12, FH + 0.05, -D * 0.12, 0, -0.22);
      for (let i = 0; i < 8; i += 1) {
        addRebarAt(debris, r, spec.x + r.range(-W / 2, W / 2), gy + FH + r.range(-0.5, 0.4), spec.z + r.range(-D / 2, D / 2));
      }
    } else {
      // 农舍：一层半，屋顶整片塌进屋里
      B(burntBrick, W, 1.55, wallT, 0, 0.77, frontZ);
      B(burntBrick, wallT, 1.75, D, -W / 2, 0.87, 0);
      B(M.plaster, 0.06, 1.0, D * 0.5, -W / 2 - 0.18, 1.0, D * 0.1);
      B(burntBrick, wallT, 1.35, D * 0.7, W / 2, 0.67, -D * 0.1);
      B(burntBrick, W * 0.62, 1.25, wallT, -W * 0.19, 0.62, backZ);
      // 门洞与窗洞的黑腔
      B(M.dark, 1.0, 1.5, 0.05, -W * 0.18, 0.8, frontZ + 0.19);
      B(M.dark, 0.9, 0.8, 0.05, W * 0.22, 1.05, frontZ + 0.19);
      // 塌进屋里的屋架：三根斜梁 + 半片瓦面
      for (let i = 0; i < 3; i += 1) {
        B(M.woodDark, 0.16, 0.18, D * 0.95, -W * 0.3 + i * W * 0.28, 1.45 + i * 0.1, 0, 0, 0.12, 1.05);
      }
      B(M.rustDark, W * 0.55, 0.08, D * 0.42, W * 0.08, 0.95, 0.12, 0.06, 0.62);
      B(burntRust, W * 0.3, 0.07, D * 0.22, -W * 0.28, 0.32, -D * 0.2, -0.14, 0.38);
      // 烟囱还站着
      B(burntBrickDark, 0.55, 2.4, 0.55, W * 0.34, 1.2, -D * 0.26);
      B(M.concreteDark, 0.7, 0.12, 0.7, W * 0.34, 2.44, -D * 0.26);
    }

    /* —— 室内残留：一眼能看出这是住家 —— */
    if (spec.kind === 'rowhouse') {
      B(M.wood, 1.5, 0.08, 0.8, -W * 0.12, 0.62, -D * 0.12, 0.18, 0.04);
      B(M.woodDark, 0.08, 0.62, 0.08, -W * 0.26, 0.34, -D * 0.28);
      B(M.woodDark, 0.08, 0.62, 0.08, W * 0.02, 0.34, -D * 0.02);
      B(M.clothRed, 0.6, 0.5, 0.55, -W * 0.16, 0.9, -D * 0.14, 0.4, 0.5);
      B(M.woodDark, 0.55, 1.65, 0.5, W * 0.28, 0.83, -D * 0.3, 0.22, 0.12);
      B(M.sandbag, 0.9, 0.05, 0.55, W * 0.1, 0.2, D * 0.1, 0.5);
    } else if (spec.kind === 'cottage') {
      B(M.woodDark, 0.6, 1.4, 0.45, W * 0.2, 0.7, -D * 0.3, -0.3, 0.2);
      B(M.sandbag, 1.1, 0.12, 0.6, -W * 0.1, 0.2, -D * 0.12, 0.3);
      B(M.ceramic, 0.45, 0.3, 0.35, W * 0.06, 0.18, D * 0.14, 0.2);
    }

    /* —— 院子杂物：贴着房子散开 —— */
    const junkR = rng.fork(spec.seed ^ 0x77);
    for (let i = 0; i < 5; i += 1) {
      const jx = spec.x + junkR.range(-W / 2 - 3.5, W / 2 + 3.5);
      const jz = spec.z + junkR.range(-D / 2 - 3.5, D / 2 + 3.5);
      const kind = (i + spec.seed) % 6;
      if (kind === 0) {
        // 板条箱
        const s = junkR.range(0.5, 0.8);
        b(M.wood, s, s * 0.8, s * 0.9, jx, groundYAt(jx, jz) + s * 0.4, jz, junkR.range(0, 3), junkR.range(-0.08, 0.08));
        b(M.woodDark, s * 1.02, 0.07, s * 0.92, jx, groundYAt(jx, jz) + s * 0.62, jz, junkR.range(0, 3));
      } else if (kind === 1) {
        // 翻倒的柜子/门板
        b(M.woodDark, 0.55, 1.5, 0.08, jx, groundYAt(jx, jz) + 0.28, jz, junkR.range(0, 3), 1.32, junkR.range(-0.1, 0.1));
      } else if (kind === 2) {
        // 轮胎
        b(M.tyre, 0.62, 0.62, 0.2, jx, groundYAt(jx, jz) + 0.2, jz, junkR.range(0, 3));
        b(M.steel, 0.24, 0.24, 0.24, jx, groundYAt(jx, jz) + 0.2, jz, junkR.range(0, 3));
      } else if (kind === 3) {
        // 散落的锅碗
        b(M.steel, 0.3, 0.14, 0.3, jx, groundYAt(jx, jz) + 0.12, jz, junkR.range(0, 3), junkR.range(-0.2, 0.2));
        b(M.ceramic, 0.22, 0.06, 0.22, jx + 0.4, groundYAt(jx, jz) + 0.06, jz + 0.3, junkR.range(0, 3), 0.2);
      } else if (kind === 4) {
        // 衣箱
        b(M.clothBlue, 0.72, 0.3, 0.46, jx, groundYAt(jx, jz) + 0.16, jz, junkR.range(0, 3), junkR.range(-0.06, 0.06));
        b(M.woodDark, 0.1, 0.32, 0.48, jx + 0.2, groundYAt(jx, jz) + 0.16, jz, junkR.range(0, 3));
      } else {
        // 手推车：轮子 + 车斗
        b(M.wood, 0.9, 0.35, 0.55, jx, groundYAt(jx, jz) + 0.55, jz, junkR.range(0, 3), 0.12);
        for (const s of [-1, 1] as const) {
          b(M.tyre, 0.4, 0.4, 0.1, jx + s * 0.32, groundYAt(jx, jz) + 0.28, jz + 0.2, 0, 0, Math.PI / 2);
        }
        b(M.woodDark, 0.06, 0.06, 1.1, jx - 0.4, groundYAt(jx, jz) + 0.5, jz - 0.3, junkR.range(0, 3), -0.2);
      }
    }

    /* —— 碎屑与贴花 —— */
    for (let i = 0; i < 26; i += 1) {
      const a = r.range(0, Math.PI * 2);
      const rr = r.range(Math.max(W, D) * 0.32, Math.max(W, D) * 0.9);
      addBrick(debris, r, spec.x + Math.cos(a) * rr, gy + r.range(0.02, 0.35), spec.z + Math.sin(a) * rr);
    }
    for (let i = 0; i < 18; i += 1) {
      const a = r.range(0, Math.PI * 2);
      const rr = r.range(Math.max(W, D) * 0.25, Math.max(W, D) * 0.85);
      addConcrete(debris, r, spec.x + Math.cos(a) * rr, gy + r.range(0.02, 0.3), spec.z + Math.sin(a) * rr);
    }
    for (let i = 0; i < 8; i += 1) {
      addRebarAt(debris, r, spec.x + r.range(-W * 0.6, W * 0.6), gy + r.range(0.1, 0.5), spec.z + r.range(-D * 0.6, D * 0.6));
    }
    for (let i = 0; i < 4; i += 1) {
      debris.planks.push({
        position: new THREE.Vector3(spec.x + r.range(-W * 0.7, W * 0.7), gy + 0.08, spec.z + r.range(-D * 0.7, D * 0.7)),
        rotation: new THREE.Euler(r.range(-0.1, 0.1), r.range(0, 6.3), r.range(-0.1, 0.1)),
        scale: new THREE.Vector3(r.range(0.7, 1.5), 1, r.range(0.7, 1.4)),
      });
    }
    // 墙根苔痕 + 窗上烟熏 + 地面裂缝
    decals.moss.push({ x: spec.x - W * 0.3, y: gy + 0.28, z: spec.z + D * 0.5 + 0.05, yaw: 0, w: W * 0.4, h: 0.5 });
    decals.stains.push({ x: spec.x + W * 0.1, y: gy + 2.2, z: spec.z + D * 0.5 + 0.06, yaw: 0, w: 1.6, h: 2.0 });
    decals.wallCracks.push({ x: spec.x - W * 0.36, y: gy + 1.5, z: spec.z + D * 0.5 + 0.06, yaw: 0, w: 0.7, h: 2.2 });
    decals.cracks.push({ x: spec.x + r.range(-W * 0.5, W * 0.5), y: gy + 0.03, z: spec.z + r.range(-D * 0.5, D * 0.5), yaw: r.range(0, 6.3), w: r.range(1.0, 2.0), h: r.range(1.0, 2.0) });
  };

  for (const spec of RUIN_ROW) house(spec);

  /* —— 联排之间的共用山墙与塌口：让四栋不是一个一个孤零零的盒子 —— */
  {
    const gy = groundYAt(82.2, -69.5);
    b(burntBrickDark, 0.34, 5.6, 8.2, 82.2, gy + 2.8, -69.5, 0, 0.012);
    b(burntBrick, 0.4, 0.5, 3.4, 82.2, gy + 5.85, -70.6, 0, 0.06);
    b(M.dark, 0.36, 1.1, 0.6, 82.2, gy + 4.9, -66.3);
    // H3/H4 之间：整片塌下来的楼板与砖堆
    const gx = 75.6;
    const gz = -52.4;
    const gyy = groundYAt(gx, gz);
    b(M.concreteDark, 4.2, 0.26, 3.0, gx, gyy + 0.5, gz, 0.5, 0.16, 0.1);
    b(slabMat, 3.0, 0.06, 1.2, gx - 0.4, gyy + 0.66, gz + 0.5, 0.5, 0.03);
    for (let i = 0; i < 14; i += 1) {
      addConcrete(debris, rng, gx + rng.range(-3, 3), gyy + rng.range(0.05, 0.9), gz + rng.range(-2.2, 2.2), 1.1);
    }
    for (let i = 0; i < 20; i += 1) {
      addBrick(debris, rng, gx + rng.range(-3.4, 3.4), gyy + rng.range(0.02, 0.6), gz + rng.range(-2.4, 2.4));
    }
    for (let i = 0; i < 5; i += 1) {
      addRebarAt(debris, rng, gx + rng.range(-2, 2), gyy + rng.range(0.2, 0.8), gz + rng.range(-1.6, 1.6));
    }
  }

  /* —— 两排房子之间的院子：晾衣绳、柴堆、水槽、鸡笼架 —— */
  const yardZ = -60.5;
  // 晾衣绳：两根杆 + 一段下垂的绳与三块布
  for (const x of [70.5, 78.5]) {
    b(M.woodDark, 0.1, 2.3, 0.1, x, groundYAt(x, yardZ) + 1.15, yardZ);
  }
  {
    const sag = cylinderBetween(
      new THREE.Vector3(70.5, groundYAt(70.5, yardZ) + 2.22, yardZ),
      new THREE.Vector3(78.5, groundYAt(78.5, yardZ) + 2.22, yardZ),
      0.015,
      M.dark,
      4,
    );
    const darkList = batches.get(M.dark);
    if (darkList) darkList.push(sag);
    else batches.set(M.dark, [sag]);
    const clothPieces: Array<[number, THREE.Material, number, number]> = [
      [72.1, M.cloth, 0.9, 0.8],
      [74.4, M.clothBlue, 0.7, 1.0],
      [76.6, M.clothRed, 0.85, 0.7],
    ];
    for (const [cx, mat, cw, ch] of clothPieces) {
      b(mat, cw, ch, 0.05, cx, groundYAt(cx, yardZ) + 1.78, yardZ + 0.02, 0, 0, 0.02);
    }
  }
  // 柴堆
  for (let i = 0; i < 9; i += 1) {
    const x = 69.2 + (i % 3) * 0.42;
    const y = 0.16 + Math.floor(i / 3) * 0.26;
    b(M.wood, 1.7, 0.2, 0.22, x, groundYAt(x, -64.5) + y, -64.5, 0, 0, 0.02 * (i % 2));
  }
  // 石砌水槽
  b(M.concreteDark, 1.5, 0.55, 0.7, 79.5, groundYAt(79.5, -60) + 0.28, -60, 0.1);
  b(M.concrete, 1.3, 0.12, 0.5, 79.5, groundYAt(79.5, -60) + 0.5, -60, 0.1);
  // 鸡笼架：几根立柱 + 顶网
  for (const [x, z] of [[74.5, -63.5], [76.3, -63.5], [74.5, -62.2], [76.3, -62.2]] as Array<[number, number]>) {
    b(M.woodDark, 0.07, 1.0, 0.07, x, groundYAt(x, z) + 0.5, z);
  }
  b(M.wood, 2.0, 0.06, 1.5, 75.4, groundYAt(75.4, -62.9) + 1.0, -62.9, 0.03, 0.08);
  // 自行车残骸：两个轮圈 + 车架
  {
    const bx = 76.9;
    const bz = -58.6;
    const by = groundYAt(bx, bz);
    for (const dz of [-0.55, 0.55]) {
      b(M.tyre, 0.62, 0.62, 0.07, bx, by + 0.31, bz + dz, 0.1, 1.35);
    }
    b(M.rustDark, 0.05, 0.05, 1.15, bx, by + 0.42, bz, 0, 0.05);
    b(M.rustDark, 0.05, 0.42, 0.05, bx, by + 0.62, bz + 0.5, 0, 0.3);
    b(M.rustDark, 0.05, 0.5, 0.05, bx, by + 0.55, bz - 0.35, 0, -0.28);
    b(M.dark, 0.06, 0.06, 0.34, bx, by + 0.86, bz + 0.5, 0, 0, -0.2);
  }
  // 倒扣的浴盆与一堆锅
  b(M.ceramicBlue, 0.9, 0.4, 1.5, 80.8, groundYAt(80.8, -56.8) + 0.2, -56.8, 0.4, 0.06);
  for (let i = 0; i < 4; i += 1) {
    const px = 79.6 + rng.range(-0.5, 0.5);
    const pz = -55.4 + rng.range(-0.5, 0.5);
    b(i % 2 === 0 ? M.steel : M.brass, 0.22, 0.1, 0.22, px, groundYAt(px, pz) + 0.08 + i * 0.07, pz, rng.range(0, 3), rng.range(-0.15, 0.15));
  }
  // 歪斜的院墙残段：把这块空地和道路隔开
  const fenceSegs: Array<[number, number, number, number, number]> = [
    [67.2, -46.5, 0.16, 4.2, 0.05],
    [67.4, -58.5, 0.16, 3.2, -0.04],
    [90.7, -57.8, 0.16, 2.8, 0.02],
    [90.7, -52.1, 0.16, 1.6, -0.03],
    [71.2, -44.4, 5.5, 0.16, 0.9],
    [81.6, -35.9, 4.6, 0.16, 0.02],
  ];
  for (const [x, z, w, d, ry] of fenceSegs) {
    const h = 1.25;
    b(burntBrickDark, w, h, d, x, groundYAt(x, z) + h / 2, z, ry);
    b(burntBrick, w * 1.02, 0.12, d * 1.1, x, groundYAt(x, z) + h + 0.05, z, ry, 0.02);
  }
  // 院里的车辙
  for (let i = 0; i < 9; i += 1) {
    debris.tracks.push({
      position: new THREE.Vector3(68 + i * 2.1, 0.075, -57 + Math.sin(i * 0.5) * 1.4),
      rotation: new THREE.Euler(0, 0.12, 0.1),
      scale: new THREE.Vector3(1, 1, 1),
    });
  }

  /* —— 整块空地的第二层杂物：残车、油桶、枯树、电杆、家具、柴垛 —— */
  // 南沿烧毁的货车：车头烧空，斗帮塌了半边，轮胎只剩铁圈
  {
    const tx = 73.4;
    const tz = -34.3;
    const ty = groundYAt(tx, tz);
    const ry = Math.PI / 2 + 0.06;
    const us = Math.cos(ry);
    const vs = Math.sin(ry);
    const T = (
      mat: THREE.Material,
      w: number,
      h: number,
      d: number,
      lx: number,
      ly: number,
      lz: number,
      ryy = 0,
      rz = 0,
      rx = 0,
    ): void => {
      b(mat, w, h, d, tx + lx * us + lz * vs, ty + ly, tz - lx * vs + lz * us, ry + ryy, rz, rx);
    };
    T(M.rustDark, 1.9, 0.42, 4.3, 0, 0.56, 0);
    T(M.dark, 1.72, 1.25, 1.35, 0, 1.36, -1.4, 0, 0, -0.03);
    T(M.dark, 1.4, 0.8, 0.08, 0, 1.5, -0.72, 0, 0, 0.12);
    T(burntRust, 1.82, 0.1, 2.5, 0, 0.86, 0.85);
    T(M.rustDark, 0.1, 0.6, 2.5, -0.92, 1.12, 0.85);
    T(M.rustDark, 0.1, 0.3, 1.6, 0.92, 1.0, 0.45);
    T(burntRust, 0.08, 0.55, 2.1, 0.92, 1.12, 1.05, 0, 0.5);
    T(M.dark, 0.12, 0.12, 1.6, 0.24, 1.02, 1.0, 0, 0.2);
    // 车斗里翻出来的箱子与破布
    T(M.wood, 0.7, 0.55, 0.6, 0.1, 1.2, 1.3, 0.3, 0.1);
    T(M.cloth, 0.5, 0.16, 1.2, -0.1, 1.0, 0.2, -0.2, 0.6);
    for (const [lx, lz] of [[-0.86, -1.42], [0.86, -1.42], [-0.86, 1.05], [0.86, 1.05]] as Array<[number, number]>) {
      const wx = tx + lx * us + lz * vs;
      const wz = tz - lx * vs + lz * us;
      cylAt(M.tyre, 0.31, 0.22, 10, wx, ty + 0.31, wz, ry, Math.PI / 2);
      cylAt(M.rustDark, 0.13, 0.26, 8, wx, ty + 0.31, wz, ry, Math.PI / 2);
    }
    decals.stains.push({ x: tx + 0.3, y: ty + 0.03, z: tz + 0.5, yaw: 0.35, w: 4.2, h: 3.4 });
    for (let i = 0; i < 10; i += 1) {
      addConcrete(debris, rng, tx + rng.range(-2.6, 2.6), ty + rng.range(0.03, 0.4), tz + rng.range(-1.8, 1.8), 0.8);
    }
  }
  // 油桶：两只立着、一只倒扣
  for (const [dx, dz, mat, tipped] of [
    [84.5, -59.3, burntRust, false],
    [85.15, -59.65, M.steel, false],
    [84.85, -58.75, M.rustDark, true],
  ] as Array<[number, number, THREE.Material, boolean]>) {
    const dy = groundYAt(dx, dz);
    if (tipped) {
      cylAt(mat, 0.3, 0.86, 12, dx, dy + 0.3, dz, 0.4, Math.PI / 2);
    } else {
      cylAt(mat, 0.3, 0.86, 12, dx, dy + 0.43, dz, 0);
      cylAt(M.rustDark, 0.315, 0.06, 12, dx, dy + 0.6, dz, 0);
    }
  }
  // 枯树：主干 + 四根断枝，院子里的剪影
  {
    const tx = 68.7;
    const tz = -63.4;
    const ty = groundYAt(tx, tz);
    cylAt(M.woodDark, 0.24, 3.2, 8, tx, ty + 1.6, tz, 0, 0.09);
    rod(M.woodDark, tx, ty + 2.5, tz, tx - 1.15, ty + 3.55, tz + 0.5, 0.09);
    rod(M.woodDark, tx, ty + 2.9, tz, tx + 0.85, ty + 4.25, tz - 0.45, 0.08);
    rod(M.woodDark, tx + 0.85, ty + 4.25, tz - 0.45, tx + 1.5, ty + 4.7, tz - 0.8, 0.045);
    rod(M.woodDark, tx - 1.15, ty + 3.55, tz + 0.5, tx - 1.9, ty + 3.85, tz + 0.95, 0.045);
    rod(M.woodDark, tx, ty + 3.0, tz, tx - 0.35, ty + 4.05, tz - 0.95, 0.045);
    for (let i = 0; i < 7; i += 1) {
      debris.planks.push({
        position: new THREE.Vector3(tx + rng.range(-1.6, 1.6), ty + 0.06, tz + rng.range(-1.6, 1.6)),
        rotation: new THREE.Euler(0, rng.range(0, 6.3), rng.range(-0.06, 0.06)),
        scale: new THREE.Vector3(rng.range(0.3, 0.7), 1, rng.range(0.2, 0.5)),
      });
    }
  }
  // 南沿电杆与下垂的电线：给空地的天际线加一条横线
  {
    const poleZ = -34.55;
    for (const px of [70.5, 86.5]) {
      const py = groundYAt(px, poleZ);
      cylAt(M.woodDark, 0.16, 5.4, 7, px, py + 2.7, poleZ, 0, 0.015);
      b(M.woodDark, 1.5, 0.1, 0.1, px, py + 4.9, poleZ);
      for (const dx of [-0.6, 0, 0.6]) b(M.ceramic, 0.12, 0.16, 0.12, px + dx, py + 5.04, poleZ);
    }
    const ya = groundYAt(70.5, poleZ) + 4.88;
    const yb = groundYAt(86.5, poleZ) + 4.88;
    for (const dx of [-0.55, 0.55]) {
      const x0 = 70.5 + dx;
      const x1 = 86.5 + dx;
      rod(M.dark, x0, ya, poleZ, (x0 + x1) / 2, (ya + yb) / 2 - 0.5, poleZ + 0.08, 0.022);
      rod(M.dark, (x0 + x1) / 2, (ya + yb) / 2 - 0.5, poleZ + 0.08, x1, yb, poleZ, 0.022);
    }
    // 一根断了垂到地上的线
    rod(M.dark, 86.05, yb, poleZ, 84.6, groundYAt(84.6, -35.6) + 0.15, -35.6, 0.02);
    for (let i = 0; i < 7; i += 1) {
      debris.tracks.push({
        position: new THREE.Vector3(70 + i * 2.4, 0.075, -35.7 + Math.sin(i * 0.45) * 0.3),
        rotation: new THREE.Euler(0, 0.05, 0.1),
        scale: new THREE.Vector3(1, 1, 1),
      });
    }
  }
  // 屋后柴垛：贴着南排房子的后墙
  for (let i = 0; i < 8; i += 1) {
    const lz = -44.6 + (i % 4) * 0.34;
    const ly = 0.18 + Math.floor(i / 4) * 0.3;
    cylAt(M.wood, 0.14, 1.6, 6, 77.6, groundYAt(77.6, lz) + ly, lz, 0, Math.PI / 2);
  }
  // 翻倒的衣柜与床架
  b(M.woodDark, 1.05, 1.85, 0.5, 70.0, groundYAt(70, -41.6) + 0.9, -41.6, 0.08, 0.14);
  b(M.woodDark, 0.08, 0.5, 0.44, 70.0, groundYAt(70, -41.6) + 0.25, -41.6, 0.08, 1.25);
  {
    const bx = 89.3;
    const bz = -39.4;
    const by = groundYAt(bx, bz);
    for (const [ox, oz] of [[-0.85, -0.55], [0.85, -0.55], [-0.85, 0.55], [0.85, 0.55]] as Array<[number, number]>) {
      b(M.steel, 0.06, 0.42, 0.06, bx + ox, by + 0.21, bz + oz);
    }
    b(M.steel, 1.8, 0.07, 0.07, bx, by + 0.42, bz - 0.55, 0, 0.06);
    b(M.steel, 1.8, 0.07, 0.07, bx, by + 0.42, bz + 0.55, 0, -0.05);
    b(M.cloth, 1.7, 0.1, 1.0, bx, by + 0.36, bz, 0.03, 0.02);
  }
  // 板条箱与木桶
  for (const [cx, cz, s] of [[80.2, -44.7, 0.68], [80.9, -44.4, 0.55], [80.3, -44.6, 0.5]] as Array<[number, number, number]>) {
    b(M.wood, s, s * 0.8, s * 0.9, cx, groundYAt(cx, cz) + s * 0.4 + (cx > 80.5 ? 0 : 0.55), cz, rng.range(0, 3), rng.range(-0.06, 0.06));
  }
  b(M.wood, 0.75, 0.58, 0.65, 85.1, groundYAt(85.1, -35.6) + 0.29, -35.6, 0.4, 0.03);
  // 大块废墟堆：远看是起伏，不是一地碎渣
  const mound = (mx: number, mz: number, count: number, spread: number): void => {
    const my = groundYAt(mx, mz);
    for (let i = 0; i < count; i += 1) {
      const a = rng.range(0, Math.PI * 2);
      const rr = rng.range(0.2, spread);
      const h = rng.range(0.24, 0.95) * (1 - rr / (spread * 1.5));
      const bw = rng.range(0.34, 1.0);
      b(
        rng.chance(0.45) ? burntBrick : rng.chance(0.5) ? M.concreteDark : M.concrete,
        bw,
        Math.max(0.14, h),
        rng.range(0.34, 0.95),
        mx + Math.cos(a) * rr,
        my + Math.max(0.14, h) * 0.5 + 0.02,
        mz + Math.sin(a) * rr,
        rng.range(0, 3),
        rng.range(-0.25, 0.25),
        rng.range(-0.2, 0.2),
      );
    }
  };
  mound(87.6, -56.6, 14, 2.2);
  mound(73.4, -46.0, 10, 1.8);
  mound(90.0, -48.2, 8, 1.6);
  mound(79.0, -58.6, 12, 2.4);
  mound(75.2, -35.8, 10, 2.0);
  // 东侧棚架与塌下来的铁皮
  {
    const gy = groundYAt(90.3, -57);
    b(M.woodDark, 0.11, 2.3, 0.11, 90.3, gy + 1.15, -55.4, 0, 0.24);
    b(M.woodDark, 0.11, 2.0, 0.11, 90.3, gy + 1.0, -58.6, 0, -0.2);
    b(burntRust, 0.06, 1.35, 2.9, 89.85, gy + 1.3, -57.0, 0.02, 1.17);
  }
  // 孤零零的砖烟囱：残楼边最后一个竖向构件
  {
    const gy = groundYAt(90.0, -49.6);
    b(burntBrickDark, 0.7, 3.6, 0.7, 90.0, gy + 1.8, -49.6, 0.1, 0.05);
    b(M.concreteDark, 0.9, 0.14, 0.9, 90.0, gy + 3.68, -49.6, 0.1, 0.05);
  }
  // 三处新的碎砖堆：把两排房子之间和东侧空当填实
  for (const [rx, rz, n] of [[69.9, -45.2, 9], [88.9, -42.1, 11], [89.5, -59.2, 8]] as Array<[number, number, number]>) {
    const ry2 = groundYAt(rx, rz);
    for (let i = 0; i < n; i += 1) {
      addConcrete(debris, rng, rx + rng.range(-2.2, 2.2), ry2 + rng.range(0.03, 0.7), rz + rng.range(-1.8, 1.8), 0.9);
    }
    for (let i = 0; i < n * 2; i += 1) {
      addBrick(debris, rng, rx + rng.range(-2.6, 2.6), ry2 + rng.range(0.02, 0.45), rz + rng.range(-2.2, 2.2));
    }
    for (let i = 0; i < 3; i += 1) {
      addRebarAt(debris, rng, rx + rng.range(-1.6, 1.6), ry2 + rng.range(0.15, 0.6), rz + rng.range(-1.4, 1.4));
    }
  }
  // 院子与车辙边的污渍、苔痕、裂缝
  for (const [dx, dz, w, h] of [
    [73.6, -34.6, 3.0, 2.2],
    [84.7, -59.0, 1.8, 1.4],
    [88.8, -54.4, 2.4, 2.8],
  ] as Array<[number, number, number, number]>) {
    decals.stains.push({ x: dx, y: groundYAt(dx, dz) + 0.03, z: dz, yaw: rng.range(0, 3), w, h });
  }
  for (const [mx, mz] of [[87.2, -60.4], [85.9, -65.3], [72.2, -37.6], [69.6, -48.9]] as Array<[number, number]>) {
    decals.moss.push({ x: mx, y: groundYAt(mx, mz) + 0.12, z: mz, yaw: rng.range(0, 3), w: rng.range(1.2, 2.2), h: rng.range(0.4, 0.9) });
  }
  for (let i = 0; i < 5; i += 1) {
    const cx = rng.range(69, 90);
    const cz = rng.range(-56, -36);
    decals.cracks.push({ x: cx, y: groundYAt(cx, cz) + 0.03, z: cz, yaw: rng.range(0, 6.3), w: rng.range(1.4, 2.8), h: rng.range(1.2, 2.4) });
  }

  // 批次落地：所有材质各一个 mesh，再统一描一次边
  let bi = 0;
  for (const [mat, list] of batches) {
    addBatch(root, list, mat, `ruin-batch-${bi}`);
    bi += 1;
  }
  batches.clear();
  withOutline(root, 0.003);
  // 二十多条批次描边各占一次调用；这块地是静态的，壳可以直接烘成一条
  mergeOutlineHulls(root, 'ruin-outline');

  // 夜里两处窗火：南排铺面的黑洞与二层残窗，给空地块一点人味
  const emberA = mesh(new THREE.BoxGeometry(0.55, 0.7, 0.05), glowMaterial(0xff8a3c, 0.42));
  emberA.position.set(85.62, groundYAt(85.62, -36.76) + 1.55, -36.72);
  root.add(emberA);
  const emberB = mesh(new THREE.BoxGeometry(0.58, 0.78, 0.05), glowMaterial(0xff6a2e, 0.32));
  emberB.position.set(73.18, groundYAt(73.18, -37.7) + 4.55, -37.7);
  root.add(emberB);

  return root;
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

export function buildWarzone(ctx: BuildContext): THREE.Group {
  const root = group('warzone');
  const rng = ctx.rng.fork(0x9a71);
  const debris = emptyDebris();
  const decals: DecalSink = { cracks: [], bullets: [], moss: [], stains: [], wallCracks: [] };

  // —— 占地登记：结构层，允许压道路（地陷/断裂本来就是道路上的破坏）——
  for (const spec of WARZONE.cutaways) {
    const res = reserve(
      { x0: spec.cx - spec.w / 2, x1: spec.cx + spec.w / 2, z0: spec.cz - spec.d / 2, z1: spec.cz + spec.d / 2 },
      'structure',
      `war:cutaway-${spec.id}`,
      0,
    );
    if (!res.ok) noteRefusal(`war:cutaway-${spec.id}`, res.reason ?? 'occupancy');
  }
  {
    const s = WARZONE.sinkhole;
    const res = reserve({ x0: s.x - s.r, x1: s.x + s.r, z0: s.z - s.r, z1: s.z + s.r }, 'structure', 'war:sinkhole', 0, { allowInfra: true });
    if (!res.ok) noteRefusal('war:sinkhole', res.reason ?? 'occupancy');
  }
  for (const f of WARZONE.fractures) {
    const res = reserve({ x0: f.x - f.r, x1: f.x + f.r, z0: f.z - f.r, z1: f.z + f.r }, 'structure', `war:fracture@${f.x},${f.z}`, 0, { allowInfra: true });
    if (!res.ok) noteRefusal(`war:fracture@${f.x},${f.z}`, res.reason ?? 'occupancy');
  }
  {
    const b = WARZONE.bunker;
    const res = reserve({ x0: b.x - 2.4, x1: b.x + 2.4, z0: b.z - 2.2, z1: b.z + 2.4 }, 'structure', 'war:bunker', 0, { allowInfra: true });
    if (!res.ok) noteRefusal('war:bunker', res.reason ?? 'occupancy');
  }

  // —— 剖切楼 ——
  for (const spec of WARZONE.cutaways) {
    root.add(buildCutaway(ctx, spec, debris, decals));
  }

  // —— 空地补建：北郊院子以东的一排塌房与院落杂物 ——
  for (const spec of RUIN_ROW) {
    const res = reserve(
      {
        x0: spec.x - spec.w / 2 - 0.6,
        x1: spec.x + spec.w / 2 + 0.6,
        z0: spec.z - spec.d / 2 - 0.6,
        z1: spec.z + spec.d / 2 + 0.6,
      },
      'structure',
      `war:ruin@${spec.x},${spec.z}`,
      0,
    );
    if (!res.ok) noteRefusal(`war:ruin@${spec.x},${spec.z}`, res.reason ?? 'occupancy');
  }
  root.add(buildRuinRow(ctx, debris, decals));

  // —— 地陷与路面断裂 ——
  root.add(buildSinkhole(ctx, WARZONE.sinkhole, debris, decals, true));
  for (const f of WARZONE.fractures) root.add(buildSinkhole(ctx, f, debris, decals, false));

  // —— 现场两处实用光：烧桶照亮剖面与生活遗物，信号火炬照亮坑沿 ——
  root.add(buildBurningBarrel(ctx, 27.4, 52.3));
  root.add(buildRoadFlare(ctx, WARZONE.sinkhole.x + 4.0, WARZONE.sinkhole.z - 4.4));
  root.add(buildCraterLamp(ctx, WARZONE.sinkhole.x - 5.2, WARZONE.sinkhole.z - 5.2));

  // —— 废墟堆 ——
  for (const pile of WARZONE.rubble) root.add(buildRubblePile(ctx, pile, debris, decals));

  // —— 防空洞 ——
  root.add(buildBunker(ctx, WARZONE.bunker, debris, decals));

  // —— 废弃民车 ——
  root.add(buildAbandonedCar(ctx, WARZONE.car));
  buildLuggage(ctx, WARZONE.car.x + 2.2, WARZONE.car.z - 1.5, rng.fork(12));

  // —— 生活遗物 ——
  const vignette = WARZONE.vignette;
  const pram = buildPram(rng.fork(13));
  pram.position.x += vignette.x - 1.8;
  pram.position.z += vignette.z + 0.6;
  pram.position.y += groundYAt(vignette.x, vignette.z);
  ctx.add(pram);
  buildDishes(ctx, debris, decals, vignette.x, vignette.z, rng.fork(14));
  // 第二辆翻倒的童车：地陷旁边
  const pram2 = buildPram(rng.fork(15));
  pram2.position.set(WARZONE.sinkhole.x + 8.2, groundYAt(WARZONE.sinkhole.x + 8.2, WARZONE.sinkhole.z - 1.8) + 0.34, WARZONE.sinkhole.z - 1.8);
  pram2.rotation.z = 0.9;
  ctx.add(pram2);
  // 散落衣物（贴地 Alpha 面片）
  const clothes: InstanceTransform[] = [];
  const clothTints = [0x8b9aa1, 0x9a6f63, 0xa8a18c, 0x798573];
  for (let i = 0; i < 12; i += 1) {
    const x = vignette.x + rng.range(-3.2, 3.2);
    const z = vignette.z + rng.range(-2.2, 2.2);
    clothes.push({
      position: new THREE.Vector3(x, groundYAt(x, z) + 0.012, z),
      rotation: new THREE.Euler(0, rng.range(0, 6.3), 0),
      scale: new THREE.Vector3(rng.range(0.32, 0.65), 1, rng.range(0.42, 0.85)),
    });
  }
  const clothInst = instanced(GROUND_CLOTH_GEO, alphaMaterial(textures().cloth), clothes);
  clothInst.name = 'war-clothes-ground';
  clothInst.castShadow = false;
  clothInst.receiveShadow = false;
  clothInst.frustumCulled = false;
  for (let i = 0; i < clothes.length; i += 1) {
    clothInst.setColorAt(i, new THREE.Color(clothTints[i % clothTints.length]!));
  }
  if (clothInst.instanceColor) clothInst.instanceColor.needsUpdate = true;
  ctx.add(clothInst);
  // 履带残骸：剖切楼前与哨卡前各一段
  const trackTransforms: InstanceTransform[] = [];
  for (let i = 0; i < 10; i += 1) {
    const a = i * 0.14;
    trackTransforms.push({
      position: new THREE.Vector3(vignette.x + 4.2 + Math.cos(a) * 0.55, 0.08, vignette.z - 2.6 + Math.sin(a) * 1.4),
      rotation: new THREE.Euler(0, a, 0.12),
      scale: new THREE.Vector3(1, 1, 1),
    });
  }
  for (const t of trackTransforms) debris.tracks.push(t);
  // 反坦克拒马：弹坑边两组，街角一组
  for (const [hx, hz, fallen] of [
    [-38.2, 8.6, false],
    [-37.2, 10.2, true],
    [64.5, -7.4, false],
    [72.2, -14.6, false],
    [44.8, 49.6, true],
  ] as Array<[number, number, boolean]>) {
    debris.hedgehogs.push({
      position: new THREE.Vector3(hx, groundYAt(hx, hz) + (fallen ? 0.28 : 0.78), hz),
      rotation: new THREE.Euler(fallen ? Math.PI / 2 : rng.range(-0.12, 0.12), rng.range(0, 6.3), fallen ? 0.3 : rng.range(-0.12, 0.12)),
      scale: new THREE.Vector3(1, rng.range(0.85, 1.15), 1),
    });
  }
  // 防毒面具 + 背包
  for (let i = 0; i < 3; i += 1) {
    debris.backpacks.push({
      position: new THREE.Vector3(vignette.x - 2 + i * 0.8, groundYAt(vignette.x, vignette.z) + 0.16, vignette.z - 1.6),
      rotation: new THREE.Euler(rng.range(-0.3, 0.3), rng.range(0, 6.3), rng.range(-0.2, 0.2)),
      scale: new THREE.Vector3(1, 1, 1),
    });
  }
  // 沙袋掩体旁丢下的防弹衣
  for (let i = 0; i < 4; i += 1) {
    const x = WARZONE.bunker.x - 2.2 + i * 1.4;
    const z = WARZONE.bunker.z + 2.9 + (i % 2) * 0.5;
    debris.vests.push({
      position: new THREE.Vector3(x, groundYAt(x, z) + 0.08, z),
      rotation: new THREE.Euler(Math.PI / 2 + rng.range(-0.25, 0.25), rng.range(0, 6.3), rng.range(-0.3, 0.3)),
      scale: new THREE.Vector3(1, 1, 1),
    });
  }
  commitDebris(ctx, debris, rng.fork(16));

  // —— 植被 ——
  const veg = buildVegetation(ctx, rng.fork(17));

  // —— 墙面贴花 + 地面贴花 ——
  addWallDecals(rng.fork(18), decals, [
    { x0: 14, z0: -13.02, x1: 33, z1: -13.02, yaw: 0 },
    { x0: 12.02, z0: -33, x1: 12.02, z1: -15, yaw: -Math.PI / 2 },
    { x0: -30, z0: -13.48, x1: -16, z1: -13.48, yaw: 0 },
    { x0: -46, z0: -13.48, x1: -32, z1: -13.48, yaw: 0 },
    { x0: -48, z0: 32.02, x1: -32, z1: 32.02, yaw: 0 },
    { x0: 46, z0: -13.98, x1: 68, z1: -13.98, yaw: 0 },
    { x0: 34, z0: 36.02, x1: 43.5, z1: 36.02, yaw: 0 },
    { x0: 68.4, z0: -17.96, x1: 71, z1: -17.96, yaw: 0 },
    { x0: 81, z0: -17.96, x1: 84, z1: -17.96, yaw: 0 },
    { x0: 27.4, z0: 48.98, x1: 30.4, z1: 48.98, yaw: 0 },
    { x0: 38.3, z0: 48.98, x1: 39.6, z1: 48.98, yaw: 0 },
    { x0: 27.02, z0: 39, x1: 27.02, z1: 48.5, yaw: -Math.PI / 2 },
    { x0: 40.98, z0: 39, x1: 40.98, z1: 48.5, yaw: Math.PI / 2 },
    { x0: 68.02, z0: -31.5, x1: 68.02, z1: -18.5, yaw: -Math.PI / 2 },
    { x0: 83.98, z0: -31.5, x1: 83.98, z1: -18.5, yaw: Math.PI / 2 },
  ]);
  scatterGroundDecals(rng.fork(19), decals);
  const decalCount = buildDecals(ctx, decals);

  // —— 晾衣绳 ——
  const laundryCount = buildLaundry(ctx, rng.fork(21));

  // —— 风摆驱动 ——
  ctx.ticker.add((t) => {
    WIND_TIME.value = t;
    CLOTH_TIME.value = t;
  });

  const stats = {
    cutaways: WARZONE.cutaways.length,
    ruinRow: RUIN_ROW.length,
    sinkholes: 1,
    fractures: WARZONE.fractures.length,
    rubblePiles: WARZONE.rubble.length,
    bunker: 1,
    abandonedCars: 1,
    laundry: laundryCount,
    grass: veg.grass,
    weeds: veg.weeds,
    vines: veg.vines,
    decals: decalCount,
    debris: {
      bricks: debris.brickA.length + debris.brickB.length + debris.brickBurnt.length,
      concrete: debris.concreteA.length + debris.concreteB.length,
      shells: debris.shells.length,
      sandbags: debris.sandbags.length,
      rebar: debris.rebar.length,
    },
  };
  root.userData['warzone'] = stats;
  console.info(
    `[warzone] 剖切楼 ${stats.cutaways}｜补建塌房 ${stats.ruinRow}｜地陷 ${stats.sinkholes}｜断裂 ${stats.fractures}｜废墟堆 ${stats.rubblePiles}｜防空洞 ${stats.bunker}｜贴花 ${stats.decals}｜草 ${stats.grass}+${stats.weeds}｜藤 ${stats.vines}｜碎件 ${stats.debris.bricks + stats.debris.concrete}`,
  );
  ctx.add(root);
  return root;
}
