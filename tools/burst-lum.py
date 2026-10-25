"""批量统计 PNG 平均亮度：python tools/burst-lum.py <glob 模式>"""
import glob
import sys

import numpy as np
from PIL import Image

pattern = sys.argv[1] if len(sys.argv) > 1 else "tests/out/black/*.png"
for f in sorted(glob.glob(pattern)):
    im = np.asarray(Image.open(f).convert("RGB"), dtype=np.float32) / 255.0
    l = float((im * [0.299, 0.587, 0.114]).sum(axis=2).mean())
    print(f"{f}  mean={l:.4f}")
