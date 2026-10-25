/**
 * 加载进度条。
 *
 * 场景是一次性同步构建的（5 秒量级），主线程一堵，CSS 动画也会停。
 * 所以真正的进度必须由**构建过程主动让帧**来驱动：`buildDiorama` 每完成一个阶段
 * 就 `await` 一帧，这里才得以重绘。
 *
 * 这个覆盖层在构建完成后会从 DOM 里移除 —— 不影响"屏幕上没有任何 UI 元素"的验收
 * （test:interact 在 __dioramaReady 之后才检查）。
 */

const CSS = `
.boot-veil {
  position: fixed;
  inset: 0;
  background: #05070a;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
  transition: opacity 420ms ease;
}
.boot-veil[data-done='1'] { opacity: 0; pointer-events: none; }
.boot-box { width: min(320px, 56vw); }
.boot-label {
  display: flex;
  justify-content: space-between;
  margin-bottom: 9px;
  color: #8fa3b5;
  font: 12px/1.4 "Segoe UI", "Microsoft YaHei", sans-serif;
  letter-spacing: 0.5px;
}
.boot-label b { color: #ffc98a; font-weight: 500; }
.boot-track {
  height: 2px;
  background: rgba(126, 158, 186, 0.22);
  overflow: hidden;
}
.boot-fill {
  height: 100%;
  width: 0%;
  background: linear-gradient(90deg, #7f5a35, #ffb765);
  transition: width 180ms ease;
}
/* 收尾阶段（编译着色器 / 首帧）：主线程会被整段占住，宽度过渡动不了。
   改用 transform 关键帧 —— 它由合成器线程驱动，主线程卡死时依然流畅。 */
.boot-track[data-indet='1'] .boot-fill {
  width: 40% !important;
  transition: none;
  animation: boot-flow 1.1s linear infinite;
}
@keyframes boot-flow {
  0% { transform: translateX(-120%); }
  100% { transform: translateX(260%); }
}
`;

export interface LoadingScreen {
  set(fraction: number, label: string): void;
  /**
   * 收尾阶段（编译着色器 / 首帧）：主线程会被整段占住，进度百分比没法更新。
   * 切到合成器线程驱动的流动动画，用户看到的是"还在动"，而不是卡死的条。
   */
  busy(label: string): void;
  done(): void;
}

export function createLoading(host: HTMLElement): LoadingScreen {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const veil = document.createElement('div');
  veil.className = 'boot-veil';
  veil.dataset['done'] = '0';
  veil.innerHTML = `
    <div class="boot-box">
      <div class="boot-label"><span class="boot-step">初始化</span><b class="boot-pct">0%</b></div>
      <div class="boot-track"><div class="boot-fill"></div></div>
    </div>`;
  host.appendChild(veil);

  const step = veil.querySelector('.boot-step') as HTMLElement;
  const pct = veil.querySelector('.boot-pct') as HTMLElement;
  const fill = veil.querySelector('.boot-fill') as HTMLElement;
  const track = veil.querySelector('.boot-track') as HTMLElement;

  // 供验收脚本确认"确实分阶段推进过"
  const history: string[] = [];
  (window as unknown as { __buildProgress?: string[] }).__buildProgress = history;

  return {
    set(fraction: number, label: string) {
      const f = Math.max(0, Math.min(1, fraction));
      // 回到确定性进度：宽度百分比 + 去掉流动动画（预热阶段要真的推进）
      track.dataset['indet'] = '0';
      fill.style.width = `${(f * 100).toFixed(1)}%`;
      pct.textContent = `${Math.round(f * 100)}%`;
      step.textContent = label;
      history.push(`${Math.round(f * 100)}% ${label}`);
    },
    busy(label: string) {
      track.dataset['indet'] = '1';
      pct.textContent = '···';
      step.textContent = label;
      history.push(`busy ${label}`);
    },
    done() {
      track.dataset['indet'] = '0';
      fill.style.width = '100%';
      pct.textContent = '100%';
      veil.dataset['done'] = '1';
      window.setTimeout(() => veil.remove(), 460);
    },
  };
}
