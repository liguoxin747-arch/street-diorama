import { DAY } from '../core/dayState';
import type { DayRig } from '../core/dayCycle';

/**
 * 时间滑条：**默认不可见**，只在鼠标靠近画面底边（或按 H 钉住）时淡入。
 *
 * 这个场景的前提是"屏幕上没有任何 UI 元素"，所以：
 *  - 收起状态必须写 `visibility:hidden`——interact.mjs 判定 UI 的条件是
 *    `display!=='none' && visibility!=='hidden' && 尺寸>2px`，只给 opacity:0 会被算成 UI 而让验收失败。
 *  - 不显示任何文字：时间用轨道底色（夜蓝→苍白→暗橙→夜蓝）与刻度线表达，
 *    进度用一个日/月图标承担（太阳高度为正给日，为负给月）。
 *  - 滑条可见期间暂停自动昼夜推进，收起后恢复，避免"边拖边被时间拉着走"。
 */

const REVEAL_ZONE = 68; // px：距底边多少像素内浮现
const HIDE_DELAY = 2200; // ms：无操作后淡出
const HOURS = [0, 6, 12, 18]; // 深夜 / 拂晓 / 正午 / 黄昏

const STYLE = `
.time-day {
  position: fixed;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%);
  width: min(560px, 58vw);
  height: 46px;
  padding: 0 18px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  border-radius: 10px;
  background: rgba(9, 13, 18, 0.58);
  border: 1px solid rgba(126, 158, 186, 0.22);
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.45);
  opacity: 0;
  visibility: hidden;
  transition: opacity 220ms ease, visibility 0s linear 220ms;
  pointer-events: none;
  cursor: default;
  z-index: 4;
}
.time-day[data-shown='1'] {
  opacity: 1;
  visibility: visible;
  transition: opacity 180ms ease, visibility 0s linear 0s;
  pointer-events: auto;
}
.time-day__track {
  position: relative;
  flex: 1;
  height: 22px;
  display: flex;
  align-items: center;
  cursor: ew-resize;
  touch-action: none;
}
.time-day__bar {
  position: absolute;
  left: 0;
  right: 0;
  height: 5px;
  border-radius: 3px;
  /* 一天的色带：夜蓝 → 拂晓苍白 → 正午冷白 → 黄昏暗橙 → 回夜蓝 */
  background: linear-gradient(
    90deg,
    #16202b 0%,
    #6f8496 25%,
    #c3ccd2 50%,
    #b06a3e 75%,
    #16202b 100%
  );
  opacity: 0.85;
}
.time-day__tick {
  position: absolute;
  top: 50%;
  width: 1px;
  height: 11px;
  margin-top: -5.5px;
  background: rgba(226, 236, 244, 0.5);
}
.time-day__thumb {
  position: absolute;
  top: 50%;
  width: 20px;
  height: 20px;
  margin: -10px 0 0 -10px;
  pointer-events: none;
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.6));
}
.time-day__thumb svg {
  display: block;
  width: 100%;
  height: 100%;
}
.time-day__freeze {
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  margin-left: 14px;
  padding: 0;
  border-radius: 7px;
  border: 1px solid rgba(126, 158, 186, 0.3);
  background: rgba(18, 26, 34, 0.75);
  color: #9fb4c6;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 160ms ease, border-color 160ms ease, color 160ms ease;
}
.time-day__freeze:hover {
  border-color: rgba(150, 190, 220, 0.55);
  color: #cfe0ee;
}
.time-day__freeze[aria-pressed='true'] {
  background: rgba(255, 180, 94, 0.16);
  border-color: rgba(255, 190, 120, 0.65);
  color: #ffc98a;
}
.time-day__freeze svg {
  display: block;
  width: 15px;
  height: 15px;
}
.time-day__thumb .sun,
.time-day__thumb .moon {
  transition: opacity 240ms ease;
}
`;

export function createDaySlider(day: DayRig, host: HTMLElement): void {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'time-day';
  root.dataset['shown'] = '0';
  root.setAttribute('role', 'slider');
  root.setAttribute('aria-label', 'time of day');
  root.setAttribute('aria-valuemin', '0');
  root.setAttribute('aria-valuemax', '24');
  root.innerHTML = `
    <div class="time-day__track">
      <div class="time-day__bar"></div>
      <div class="time-day__thumb">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <g class="sun" fill="none" stroke="#ffe0ac" stroke-width="1.7" stroke-linecap="round">
            <circle cx="12" cy="12" r="4.4" fill="#ffd48a" stroke="none"></circle>
            <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"></path>
          </g>
          <g class="moon" opacity="0">
            <path d="M14.6 3.4a8.6 8.6 0 1 0 6 14.7A9.2 9.2 0 0 1 14.6 3.4Z" fill="#d5e3f0"></path>
          </g>
        </svg>
      </div>
    </div>
    <button class="time-day__freeze" type="button" aria-pressed="false" aria-label="freeze time">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
        <path d="M12 3.2v17.6M4.4 7.6l15.2 8.8M19.6 7.6L4.4 16.4"></path>
        <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"></circle>
      </svg>
    </button>`;
  host.appendChild(root);

  const track = root.querySelector('.time-day__track') as HTMLElement;
  const thumb = root.querySelector('.time-day__thumb') as HTMLElement;
  const sun = root.querySelector('.sun') as SVGElement;
  const moon = root.querySelector('.moon') as SVGElement;
  const freezeBtn = root.querySelector('.time-day__freeze') as HTMLButtonElement;

  // 四个时段锚点刻度（只有线，没有文字）
  for (const h of HOURS) {
    const tick = document.createElement('div');
    tick.className = 'time-day__tick';
    tick.style.left = `calc(${(h / 24) * 100}% - 0.5px)`;
    track.appendChild(tick);
  }

  let shown = false;
  let pinned = false;
  let dragging = false;
  let hideTimer = 0;
  let savedDayLength = day.dayLength;
  /** 钉住当前时刻：即使滑条收起、自动推进也不恢复（区别于"滑条可见时临时暂停"） */
  let frozen = false;
  let resumeLength = day.dayLength;

  const applyFreeze = (next: boolean): void => {
    if (next === frozen) return;
    frozen = next;
    freezeBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
    if (next) {
      if (day.dayLength > 0) resumeLength = day.dayLength;
      day.dayLength = 0;
    } else {
      day.dayLength = resumeLength > 0 ? resumeLength : 300;
    }
  };

  freezeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    applyFreeze(!frozen);
    // 点完按钮不要把滑条立刻收走，给一次视觉反馈
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (!dragging && !pinned) setShown(false);
    }, HIDE_DELAY);
  });
  // 按钮在收起态不可见，但可见后鼠标停上去时不应触发"从底边浮现"的重复调用
  freezeBtn.addEventListener('pointerenter', () => window.clearTimeout(hideTimer));

  const setShown = (next: boolean): void => {
    if (next === shown) return;
    shown = next;
    root.dataset['shown'] = next ? '1' : '0';
    if (next) {
      savedDayLength = day.dayLength;
      day.dayLength = 0; // 可见期间冻结自动推进，避免与拖动打架
      window.addEventListener('pointerdown', onPointerDown, true);
      startSync();
    } else if (!pinned) {
      // 冻结时保持 dayLength=0；否则恢复进入可见状态前的推进速度
      day.dayLength = frozen ? 0 : savedDayLength;
      window.removeEventListener('pointerdown', onPointerDown, true);
      stopSync();
    }
  };

  const scheduleHide = (): void => {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (!dragging) setShown(false);
    }, HIDE_DELAY);
  };

  const nudge = (clientX: number): void => {
    const r = track.getBoundingClientRect();
    const k = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
    day.setTime(k);
    paint();
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (!track.contains(e.target as Node)) return;
    dragging = true;
    track.setPointerCapture?.(e.pointerId);
    nudge(e.clientX);
    e.preventDefault();
    e.stopPropagation();
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (dragging) nudge(e.clientX);
  };
  const onPointerUp = (): void => {
    dragging = false;
    scheduleHide();
  };
  track.addEventListener('pointerdown', onPointerDown);
  track.addEventListener('pointermove', onPointerMove);
  track.addEventListener('pointerup', onPointerUp);
  track.addEventListener('pointercancel', onPointerUp);
  track.addEventListener('lostpointercapture', onPointerUp);
  root.addEventListener('pointerenter', () => {
    window.clearTimeout(hideTimer);
    setShown(true);
  });
  root.addEventListener('pointerleave', scheduleHide);

  // 鼠标靠近底边即浮现；离开底边带且无操作后淡出
  window.addEventListener(
    'pointermove',
    (e: PointerEvent) => {
      const near = window.innerHeight - e.clientY <= REVEAL_ZONE;
      if (near) {
        setShown(true);
        scheduleHide();
      }
    },
    { passive: true },
  );

  // H 钉住/取消（键盘是唯一能主动留住它的方式）
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'h' && e.key !== 'H') return;
    pinned = !pinned;
    if (pinned) {
      setShown(true);
      window.clearTimeout(hideTimer);
    } else {
      scheduleHide();
    }
  });

  function paint(): void {
    const t = day.time;
    thumb.style.left = `${t * 100}%`;
    // 日/月不能按太阳高度分：uSunDir 承载的是主平行光方向，深夜锚点把它当高悬的月亮
    // （仰角 38°，也是"正"）。真正的时间量是 nightMix。
    const nightMix = DAY.uNightMix.value;
    const raw = 1 - nightMix;
    const k = Math.min(1, Math.max(0, (raw - 0.25) / 0.4)); // 深夜→月，正午→日，黄昏偏月
    sun.style.opacity = String(k);
    moon.style.opacity = String(1 - k);
    root.setAttribute('aria-valuenow', String(Math.round(t * 24)));
    freezeBtn.setAttribute('aria-pressed', frozen ? 'true' : 'false');
  }

  let raf = 0;
  const sync = (): void => {
    paint();
    raf = requestAnimationFrame(sync);
  };
  const startSync = (): void => {
    if (!raf) sync();
  };
  const stopSync = (): void => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  paint();
}
