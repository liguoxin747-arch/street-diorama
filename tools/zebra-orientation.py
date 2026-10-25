"""
俯视正交投影下测量斑马线的条纹方向：逐条白色斑马线求长边方向，再取轴向均值。
0° = 长边沿 X（东西向，横穿南北向道路时应该是这个）
90° = 长边沿 Z（南北向，横穿东西向道路时应该是这个）

旧版是把裁剪里所有白像素做一次 PCA，量到的是"整条斑马线的排列方向"，
不是单根白条的长边；排列方向与长边恰好垂直，读数会正好反过来。
现在用连通域把每根白条分开，只统计足够细长的条。

用法：python tools/zebra-orientation.py <截图> <裁剪x0 y0 w h>
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

args = [a for a in sys.argv[1:] if not a.startswith("--")]
img = Image.open(Path(args[0])).convert("RGB")
x0, y0, w, h = (int(v) for v in args[1:5])
crop = np.asarray(img.crop((x0, y0, x0 + w, y0 + h)), dtype=np.float32)

# 亮白像素（斑马漆）
bright = (crop[..., 0] > 90) & (crop[..., 1] > 85) & (crop[..., 2] > 80) & (crop.mean(axis=2) > 70)
print(f"亮像素 {int(bright.sum())} / {bright.size} ({bright.mean() * 100:.1f}%)")

labels, n = ndimage.label(bright)
angles = []
weights = []
for i in range(1, n + 1):
    ys, xs = np.nonzero(labels == i)
    if len(xs) < 25:
        continue
    pts = np.stack([xs, ys], axis=1).astype(np.float64)
    pts -= pts.mean(axis=0)
    vals, vecs = np.linalg.eigh(np.cov(pts.T))
    # 只收"细长条"：斑马线单条的长宽比远大于 1；杂点、停止线端点不参与
    if vals.max() < 6 * max(vals.min(), 1e-9):
        continue
    main = vecs[:, int(np.argmax(vals))]
    angle = float(np.degrees(np.arctan2(main[1], main[0])))
    angles.append(((angle + 90) % 180) - 90)
    weights.append(len(xs))

if not angles:
    print("没有找到足够细长的白条，无法判断")
    sys.exit(0)

w = np.asarray(weights, dtype=np.float64)
a = np.deg2rad(np.asarray(angles) * 2)  # 轴向数据：0° 与 180° 等价，用倍角平均
mean = 0.5 * np.rad2deg(np.arctan2(np.sum(w * np.sin(a)), np.sum(w * np.cos(a))))
mean = ((mean + 90) % 180) - 90
if abs(mean) < 20:
    axis = "接近水平（长边沿 X）"
elif abs(abs(mean) - 90) < 20:
    axis = "接近垂直（长边沿 Z）"
else:
    axis = "斜向/无法归类"
print(f"检测到 {len(angles)} 根细长白条")
print(f"白条长边轴向均值: {mean:.1f}°  →  {axis}")
print(f"逐条角度: {', '.join(f'{v:.1f}' for v in angles)}")
