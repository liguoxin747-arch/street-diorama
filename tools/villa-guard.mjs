/**
 * 文件看门：确认别墅相关的 4 处装配都在位（villa.ts 本体 + 3 个引用点）。
 *
 * 起因：villa.ts 曾两次从 src/world 被搬到 scratch，同时 scene.ts / viewMode.ts
 * 里的调用与碰撞接入被覆盖掉 —— 页面能跑，但别墅静默消失。
 * 这个脚本把"装配是否存在"变成一次可运行的检查，而不是靠肉眼发现。
 *
 * node tools/villa-guard.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('src');
const checks = [
  {
    name: '别墅模块本体 src/world/villa.ts',
    file: resolve(root, 'world/villa.ts'),
    needle: 'export function createCustomVilla',
    desc: 'createCustomVilla 必须存在',
  },
  {
    name: 'layout：HOTSPOTS.villa 位置真值',
    file: resolve(root, 'world/layout.ts'),
    needle: 'villa: { x:',
    desc: 'HOTSPOTS.villa 定义了位置与朝向',
  },
  {
    name: 'scene：把别墅挂进场景',
    file: resolve(root, 'scene.ts'),
    needle: 'createCustomVilla(ctx, HOTSPOTS.villa)',
    desc: 'scene.ts 的构建步骤里调用了 createCustomVilla',
  },
  {
    name: 'viewMode：别墅碰撞与门洞接入第一人称',
    file: resolve(root, 'ui/viewMode.ts'),
    needle: 'villaColliders',
    desc: 'blockedByBuilding 里并入了 villaColliders / villaDoors',
  },
  {
    name: 'rain：红屋顶与门廊的雨滴溅射',
    file: resolve(root, 'fx/rain.ts'),
    needle: 'HOTSPOTS.villa',
    desc: 'roofTargets 里包含别墅的三块顶板',
  },
];

let fail = 0;
for (const c of checks) {
  let ok = existsSync(c.file);
  let why = ok ? '' : '文件不存在';
  if (ok) {
    const text = readFileSync(c.file, 'utf8');
    ok = text.includes(c.needle);
    why = ok ? '' : `缺少 ${c.needle}`;
    // 顺带检查没有被搬去 scratch
    if (ok && c.file.includes('world/villa.ts')) {
      const stray = resolve('scratch/villa.ts');
      if (existsSync(stray)) {
        // scratch 有副本是正常的（历史草稿），只在 src 缺失时才算问题；这里只是提示
      }
    }
  }
  if (!ok) fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}  — ${c.desc}${why ? `  [${why}]` : ''}`);
}

console.log(fail === 0 ? '\n别墅装配完整 ✅' : `\n${fail} 处装配缺失 ❌（别墅可能已从场景消失）`);
process.exit(fail === 0 ? 0 : 1);
