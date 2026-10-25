import * as THREE from 'three';
import type { Rng } from './rng';
import { jitter, type InstanceTransform } from './geo';

/**
 * 高保真建模原语库：所有模块共用，保证"细节语言"一致。
 *
 * 全部都是**几何**细节（不是贴图），遵循 docs/HIGH_FIDELITY.md 的三渲二规范：
 *  - 破坏要有厚度和参差边缘
 *  - 同面至少 3 级明度
 *  - 碎件走 instanced，静态件按材质合并
 */

/* ------------------------------------------------------------------ *
 * 通用：参差破片
 * ------------------------------------------------------------------ */

/**
 * 一片"剥落/崩裂"的破片：带厚度、边缘参差不齐。
 * 用于剥落墙皮、墙洞崩边、碎瓦。
 */
export function chippedSlab(
  w: number,
  h: number,
  thickness: number,
  rng: Rng,
  jag = 0.22,
): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const n = 7 + Math.floor(rng.next() * 4);
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2;
    // 半径在 0.72~1.0 之间抖动 → 边缘参差
    const r = 0.86 + rng.gauss(0, jag);
    pts.push(new THREE.Vector2(Math.cos(a) * w * 0.5 * r, Math.sin(a) * h * 0.5 * r));
  }
  shape.setFromPoints(pts);
  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelSize: thickness * 0.35,
    bevelThickness: thickness * 0.3,
    bevelSegments: 1,
    curveSegments: 1,
  });
  geom.center();
  return geom;
}

/**
 * 破洞边缘的崩裂碎屑环：一圈大小不一的碎块，围在洞口周边。
 * 返回可用于 instanced 的变换数组（局部坐标，原点=洞中心）。
 */
export function debrisRing(
  count: number,
  radius: number,
  rng: Rng,
  spread = 0.35,
): InstanceTransform[] {
  const out: InstanceTransform[] = [];
  for (let i = 0; i < count; i += 1) {
    const a = rng.range(0, Math.PI * 2);
    const r = radius * rng.range(0.75, 1.35);
    const s = rng.range(0.3, 1);
    out.push({
      position: new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r * spread, rng.range(-0.02, 0.03)),
      rotation: new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)),
      scale: new THREE.Vector3(s, s * rng.range(0.6, 1), s * rng.range(0.5, 1)),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 建筑：砖、瓦、窗
 * ------------------------------------------------------------------ */

/** 砖块（带轻微随机），用于外露砖芯与墙根碎砖 */
export function brickGeometry(rng: Rng): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(0.25, 0.065, 0.12);
  return jitter(g, 0.008, rng);
}

/** 一片瓦（带搭接的弧度与厚度），用于屋顶叠瓦 */
export function tileGeometry(rng: Rng): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(0.3, 0.022, 0.36);
  // 沿长边轻微上翘 → 叠瓦的层叠感
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i += 1) {
    const z = pos.getZ(i);
    pos.setY(i, pos.getY(i) + Math.max(0, z / 0.18) * 0.022);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return jitter(g, 0.004, rng);
}

/** 屋檐/檐沟：独立的高模资产（带滴水沿与支架） */
export function gutterGeometry(len: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.BoxGeometry(len, 0.16, 0.2);
  parts.push(body);
  // 托架
  const count = Math.max(2, Math.floor(len / 3));
  for (let i = 0; i < count; i += 1) {
    const br = new THREE.BoxGeometry(0.06, 0.22, 0.26);
    br.translate(-len / 2 + 0.6 + (i * (len - 1.2)) / (count - 1), -0.18, 0);
    parts.push(br);
  }
  return mergeAll(parts);
}

/** 落水管（带接口环与卡箍） */
export function downpipeGeometry(height: number, withBends: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const seg = Math.max(2, Math.round(height / 3));
  for (let i = 0; i < seg; i += 1) {
    const h = height / seg;
    const p = new THREE.CylinderGeometry(0.075, 0.075, h, 8);
    p.translate(0, h / 2 + i * h, 0);
    parts.push(p);
    // 接口环
    const collar = new THREE.TorusGeometry(0.085, 0.022, 4, 8);
    collar.rotateX(Math.PI / 2);
    collar.translate(0, i * h, 0);
    parts.push(collar);
  }
  if (withBends) {
    const elbow = new THREE.CylinderGeometry(0.075, 0.075, 0.5, 8);
    elbow.rotateX(Math.PI / 2.6);
    elbow.translate(0, height + 0.2, 0.18);
    parts.push(elbow);
  }
  return mergeAll(parts);
}

/** 空调外机（独立高模：面板、栅格、风扇、支架） */
export function acUnitGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const box = new THREE.BoxGeometry(0.78, 0.56, 0.3);
  parts.push(box);
  // 正面栅格（细条）
  for (let i = 0; i < 5; i += 1) {
    const bar = new THREE.BoxGeometry(0.66, 0.022, 0.02);
    bar.translate(0, -0.18 + i * 0.09, 0.155);
    parts.push(bar);
  }
  // 风扇圈
  const ring = new THREE.TorusGeometry(0.17, 0.02, 4, 12);
  ring.translate(0, 0.02, 0.16);
  parts.push(ring);
  // 支架
  for (const s of [-1, 1]) {
    const br = new THREE.BoxGeometry(0.05, 0.34, 0.34);
    br.translate(s * 0.3, -0.42, 0.04);
    parts.push(br);
  }
  return mergeAll(parts);
}

/** 窗框（外框 + 中挺 + 窗台），有真实厚度 */
export function windowFrameGeometry(w: number, h: number, depth: number, mullion: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const t = 0.07;
  // 外框
  const top = new THREE.BoxGeometry(w + t * 2, t, depth);
  top.translate(0, h / 2 + t / 2, 0);
  const bot = new THREE.BoxGeometry(w + t * 2, t, depth);
  bot.translate(0, -h / 2 - t / 2, 0);
  const left = new THREE.BoxGeometry(t, h, depth);
  left.translate(-w / 2 - t / 2, 0, 0);
  const right = new THREE.BoxGeometry(t, h, depth);
  right.translate(w / 2 + t / 2, 0, 0);
  parts.push(top, bot, left, right);
  if (mullion) {
    const mid = new THREE.BoxGeometry(0.045, h, depth * 0.8);
    parts.push(mid);
  }
  return mergeAll(parts);
}

/* ------------------------------------------------------------------ *
 * 军事装备
 * ------------------------------------------------------------------ */

/** 一节履带（带驱动齿与连接销），可 instanced 成履带 */
export function trackPadGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const pad = new THREE.BoxGeometry(0.6, 0.07, 0.38);
  parts.push(pad);
  // 驱动齿
  const tooth = new THREE.BoxGeometry(0.08, 0.05, 0.1);
  tooth.translate(-0.26, 0.05, 0);
  parts.push(tooth);
  // 连接销
  const pin = new THREE.CylinderGeometry(0.028, 0.028, 0.66, 6);
  pin.rotateZ(Math.PI / 2);
  parts.push(pin);
  return mergeAll(parts);
}

/** 轮胎（胎面 + 胎侧 + 人字胎纹块），胎纹用独立几何体 */
export function tyreGeometry(radius: number, width: number, treadCount: number): {
  body: THREE.BufferGeometry;
  tread: THREE.BufferGeometry;
  treadTransforms: InstanceTransform[];
} {
  const parts: THREE.BufferGeometry[] = [];
  const outer = new THREE.CylinderGeometry(radius, radius, width, 16, 1, true);
  outer.rotateZ(Math.PI / 2);
  parts.push(outer);
  // 胎侧
  for (const s of [-1, 1]) {
    const side = new THREE.RingGeometry(radius * 0.55, radius, 16);
    side.rotateY((s * Math.PI) / 2);
    side.translate((s * width) / 2, 0, 0);
    parts.push(side);
  }
  // 胎纹（人字）：左右两半错开
  const tread = new THREE.BoxGeometry(width * 0.46, 0.045, 0.1);
  const transforms: InstanceTransform[] = [];
  const step = (Math.PI * 2) / treadCount;
  for (let i = 0; i < treadCount; i += 1) {
    const a = i * step;
    for (const s of [-1, 1]) {
      transforms.push({
        position: new THREE.Vector3((s * width) / 4, Math.cos(a) * radius, Math.sin(a) * radius),
        rotation: new THREE.Euler(-a + (s > 0 ? 0.22 : -0.22), 0, 0),
        scale: new THREE.Vector3(1, 1, 1),
      });
    }
  }
  return { body: mergeAll(parts), tread, treadTransforms: transforms };
}

/** 炮管防盾/退制器（带开孔细节） */
export function muzzleGeometry(radius: number, length: number, vented: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const tube = new THREE.CylinderGeometry(radius, radius * 1.08, length, 12, 1, true);
  tube.rotateX(Math.PI / 2);
  parts.push(tube);
  // 退制器：略粗的一段
  const brake = new THREE.CylinderGeometry(radius * 1.45, radius * 1.35, length * 0.35, 12, 1, true);
  brake.rotateX(Math.PI / 2);
  brake.translate(0, 0, length * 0.6);
  parts.push(brake);
  if (vented) {
    // 防盾上的开孔（用短圆柱表达孔洞的暗面）
    for (let i = 0; i < 4; i += 1) {
      const hole = new THREE.CylinderGeometry(radius * 0.5, radius * 0.5, 0.06, 8);
      hole.rotateX(Math.PI / 2);
      hole.translate(0, 0, length * 0.18 + i * 0.16);
      parts.push(hole);
    }
  }
  return mergeAll(parts);
}

/** 反应装甲块（立体厚度 + 崩角） */
export function armorBlockGeometry(w: number, h: number, d: number, rng: Rng): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  // 崩角：削掉几个角
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (Math.abs(x) > w * 0.3 && Math.abs(y) > h * 0.3 && z > 0) {
      pos.setXYZ(i, x - Math.sign(x) * rng.range(0, 0.1), y - Math.sign(y) * rng.range(0, 0.08), z);
    }
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/* ------------------------------------------------------------------ *
 * 士兵
 * ------------------------------------------------------------------ */

/** 头盔（半球 + 帽檐 + 护耳 + 挂带） */
export function helmetGeometry(r: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const dome = new THREE.SphereGeometry(r, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55);
  parts.push(dome);
  const brim = new THREE.TorusGeometry(r * 0.98, r * 0.09, 4, 12);
  brim.rotateX(Math.PI / 2);
  brim.translate(0, r * 0.05, 0);
  parts.push(brim);
  // 护耳
  for (const s of [-1, 1]) {
    const ear = new THREE.CylinderGeometry(r * 0.42, r * 0.42, r * 0.16, 8);
    ear.rotateZ(Math.PI / 2);
    ear.translate(s * r * 0.85, -r * 0.2, 0);
    parts.push(ear);
  }
  // 挂带
  const strap = new THREE.TorusGeometry(r * 0.9, r * 0.06, 4, 10, Math.PI);
  strap.rotateY(Math.PI / 2);
  parts.push(strap);
  return mergeAll(parts);
}

/** 防弹背心（前后护板 + 侧腰 + 弹匣袋） */
export function vestGeometry(w: number, h: number, d: number): {
  body: THREE.BufferGeometry;
  pouches: THREE.BufferGeometry;
} {
  const parts: THREE.BufferGeometry[] = [];
  const front = new THREE.BoxGeometry(w, h, d * 0.55);
  front.translate(0, 0, d * 0.2);
  const back = new THREE.BoxGeometry(w, h, d * 0.45);
  back.translate(0, 0, -d * 0.22);
  parts.push(front, back);
  for (const s of [-1, 1]) {
    const side = new THREE.BoxGeometry(w * 0.16, h * 0.9, d * 0.85);
    side.translate((s * w) / 2, 0, 0);
    parts.push(side);
  }
  // 弹匣袋
  const pouches: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i += 1) {
    const p = new THREE.BoxGeometry(w * 0.26, h * 0.3, d * 0.36);
    p.translate(-w * 0.3 + i * w * 0.3, -h * 0.22, d * 0.45);
    pouches.push(p);
  }
  return { body: mergeAll(parts), pouches: mergeAll(pouches) };
}

/** 步枪（机匣 + 枪管 + 弹匣 + 枪托 + 瞄具） */
export function rifleGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const receiver = new THREE.BoxGeometry(0.07, 0.11, 0.52);
  parts.push(receiver);
  const barrel = new THREE.CylinderGeometry(0.018, 0.02, 0.62, 6);
  barrel.rotateX(Math.PI / 2);
  barrel.translate(0, 0.02, 0.5);
  parts.push(barrel);
  const mag = new THREE.BoxGeometry(0.05, 0.22, 0.09);
  mag.rotateX(0.18);
  mag.translate(0, -0.14, 0.04);
  parts.push(mag);
  const stock = new THREE.BoxGeometry(0.06, 0.1, 0.3);
  stock.translate(0, -0.03, -0.36);
  parts.push(stock);
  const sight = new THREE.BoxGeometry(0.04, 0.05, 0.16);
  sight.translate(0, 0.08, 0.16);
  parts.push(sight);
  const grip = new THREE.BoxGeometry(0.05, 0.16, 0.06);
  grip.rotateX(-0.3);
  grip.translate(0, -0.12, -0.14);
  parts.push(grip);
  return mergeAll(parts);
}

/* ------------------------------------------------------------------ *
 * 合并工具（局部版，避免跨文件循环依赖）
 * ------------------------------------------------------------------ */

function mergeAll(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const normalized = geoms.map((g) => {
    const ng = g.index ? g.toNonIndexed() : g;
    if (!ng.getAttribute('normal')) ng.computeVertexNormals();
    if (!ng.getAttribute('uv')) {
      const count = ng.getAttribute('position')?.count ?? 0;
      ng.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    const kept = new THREE.BufferGeometry();
    kept.setAttribute('position', ng.getAttribute('position').clone());
    kept.setAttribute('normal', ng.getAttribute('normal').clone());
    kept.setAttribute('uv', ng.getAttribute('uv').clone());
    return kept;
  });
  // 简单拼接（避免依赖 BufferGeometryUtils 的类型约束）
  let total = 0;
  for (const g of normalized) total += g.getAttribute('position').count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let off = 0;
  for (const g of normalized) {
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

export { mergeAll };
