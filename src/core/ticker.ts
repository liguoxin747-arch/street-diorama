/** 统一时间驱动：所有动效模块注册更新函数，由主循环按固定顺序驱动。 */

export type UpdateFn = (elapsed: number, delta: number) => void;

export class Ticker {
  private readonly fns: UpdateFn[] = [];
  private elapsed = 0;

  add(fn: UpdateFn): void {
    this.fns.push(fn);
  }

  get time(): number {
    return this.elapsed;
  }

  update(delta: number): void {
    const dt = Math.min(delta, 0.1);
    this.elapsed += dt;
    for (let i = 0; i < this.fns.length; i += 1) {
      this.fns[i]?.(this.elapsed, dt);
    }
  }

  clear(): void {
    this.fns.length = 0;
    this.elapsed = 0;
  }
}
