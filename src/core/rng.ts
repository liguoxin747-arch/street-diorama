/**
 * 确定性随机数工具。
 * 微缩景观中所有摆放（瓦砾、弹孔、破损、路砖）都必须可复现，
 * 因此全部使用带种子的 mulberry32 伪随机序列。
 */

export interface Rng {
  /** [0,1) */
  next(): number;
  /** [min,max) */
  range(min: number, max: number): number;
  /** [min,max] 整数 */
  int(min: number, max: number): number;
  /** 数组随机取值 */
  pick<T>(items: readonly T[]): T;
  /** 以 p 概率返回 true */
  chance(p: number): boolean;
  /** -1 或 1 */
  sign(): number;
  /** 近似正态分布 */
  gauss(mean?: number, sd?: number): number;
  /** 打乱（返回新数组） */
  shuffle<T>(items: readonly T[]): T[];
  /** 派生一个子序列（用于分模块隔离，避免互相影响） */
  fork(salt: number): Rng;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function createRng(seed: number | string): Rng {
  const base = typeof seed === 'number' ? seed : hashSeed(seed);
  const gen = mulberry32(base);

  const rng: Rng = {
    next: gen,
    range(min, max) {
      return min + gen() * (max - min);
    },
    int(min, max) {
      return Math.floor(min + gen() * (max - min + 1));
    },
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(gen() * items.length) % items.length] as T;
    },
    chance(p) {
      return gen() < p;
    },
    sign() {
      return gen() < 0.5 ? -1 : 1;
    },
    gauss(mean = 0, sd = 1) {
      const u = Math.max(1e-6, gen());
      const v = gen();
      return mean + Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sd;
    },
    shuffle<T>(items: readonly T[]): T[] {
      const out = items.slice() as T[];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(gen() * (i + 1));
        const tmp = out[i] as T;
        out[i] = out[j] as T;
        out[j] = tmp;
      }
      return out;
    },
    fork(salt) {
      return createRng((base ^ Math.imul(salt | 0, 2654435761)) >>> 0);
    },
  };

  return rng;
}

/** 全局统一随机源：种子固定 => 每次运行画面完全一致 */
export const globalRng = createRng('iron-front-diorama-2024');
