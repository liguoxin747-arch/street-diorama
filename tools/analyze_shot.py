"""
截图数值分析（验收辅助）：把一张 PNG 变成可读的数值 + 亮度字符图。

用法：
  python tools/analyze_shot.py tests/e2e/out/diorama.png [--cols=78] [--rows=38]
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image


def load(path: Path) -> np.ndarray:
    img = Image.open(path).convert("RGB")
    return np.asarray(img, dtype=np.float32) / 255.0


def ascii_map(arr: np.ndarray, cols: int, rows: int) -> str:
    h, w, _ = arr.shape
    cell_h = max(1, h // rows)
    cell_w = max(1, w // cols)
    ramp = " .:-=+*#%@"
    cells = np.zeros((rows, cols), dtype=np.float32)
    for r in range(rows):
        for c in range(cols):
            block = arr[r * cell_h : (r + 1) * cell_h, c * cell_w : (c + 1) * cell_w]
            cells[r, c] = float(block.mean()) if block.size else 0.0
    lo, hi = np.percentile(cells, 2), np.percentile(cells, 99.5)
    span = max(hi - lo, 1e-4)
    lines = []
    for r in range(rows):
        line = []
        for c in range(cols):
            t = (cells[r, c] - lo) / span
            idx = int(np.clip(t, 0, 1) * (len(ramp) - 1))
            line.append(ramp[idx])
        lines.append("".join(line))
    return "\n".join(lines)


def hue_map(arr: np.ndarray, cols: int, rows: int) -> str:
    """R=暖色(火光/灯)  B=冷色(夜)  G=中性绿/植被  .=暗"""
    h, w, _ = arr.shape
    cell_h = max(1, h // rows)
    cell_w = max(1, w // cols)
    out = []
    for r in range(rows):
        line = []
        for c in range(cols):
            block = arr[r * cell_h : (r + 1) * cell_h, c * cell_w : (c + 1) * cell_w]
            if block.size == 0:
                line.append(" ")
                continue
            rr, gg, bb = block[..., 0].mean(), block[..., 1].mean(), block[..., 2].mean()
            lum = (rr + gg + bb) / 3
            if lum < 0.045:
                line.append(".")
            elif rr > bb * 1.22 and rr > 0.16:
                line.append("R")
            elif bb > rr * 1.12:
                line.append("B")
            else:
                line.append("g")
        out.append("".join(line))
    return "\n".join(out)


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    path = Path(args[0] if args else "tests/e2e/out/diorama.png")
    cols = next((int(a.split("=")[1]) for a in sys.argv if a.startswith("--cols=")), 78)
    rows = next((int(a.split("=")[1]) for a in sys.argv if a.startswith("--rows=")), 38)

    arr = load(path)
    h, w, _ = arr.shape
    lum = arr.mean(axis=2)

    print(f"file      : {path.name}  {w}x{h}")
    print(f"mean RGB  : {arr[...,0].mean():.3f} {arr[...,1].mean():.3f} {arr[...,2].mean():.3f}")
    print(f"luminance : mean={lum.mean():.3f} p50={np.percentile(lum,50):.3f} "
          f"p95={np.percentile(lum,95):.3f} max={lum.max():.3f}")
    print(f"dark frac : {(lum<0.05).mean():.3f}   bright frac(>0.45): {(lum>0.45).mean():.3f}")

    warm = (arr[..., 0] > arr[..., 2] * 1.25) & (arr[..., 0] > 0.2)
    cool = arr[..., 2] > arr[..., 0] * 1.1
    print(f"warm px   : {warm.mean():.4f}   cool px: {cool.mean():.4f}")

    # 边缘密度（结构丰富度的粗略指标）
    gx = np.abs(np.diff(lum, axis=1)).mean()
    gy = np.abs(np.diff(lum, axis=0)).mean()
    print(f"edge      : gx={gx:.4f} gy={gy:.4f}")

    # 量化主色
    q = (arr * 7).astype(np.int32)
    keys = q[..., 0] * 64 + q[..., 1] * 8 + q[..., 2]
    vals, counts = np.unique(keys, return_counts=True)
    order = np.argsort(-counts)[:10]
    print("dominant  :")
    for i in order:
        k = vals[i]
        r, g, b = k // 64, (k % 64) // 8, k % 8
        print(f"  #{r*36:02x}{g*36:02x}{b*36:02x}  {counts[i]/keys.size*100:5.1f}%")

    print("\n--- luminance (percentile-normalized) ---")
    print(ascii_map(arr, cols, rows))
    print("\n--- hue (R warm / B cool / g neutral / . dark) ---")
    print(hue_map(arr, cols, rows))


if __name__ == "__main__":
    main()
