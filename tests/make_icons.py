# -*- coding: utf-8 -*-
"""生成 PWA 图标：蓝底 + 白色表盘 + 指针。"""
import math
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'icons')
os.makedirs(OUT, exist_ok=True)

S = 1024
BLUE = (11, 100, 196, 255)
FACE = (244, 247, 251, 255)
TICK = (11, 100, 196, 255)
NEEDLE = (230, 120, 20, 255)
DARK = (18, 35, 55, 255)


def make(size, maskable=False):
    img = Image.new('RGBA', (S, S), BLUE)
    d = ImageDraw.Draw(img)
    cx = cy = S // 2
    r = 330 if not maskable else 300
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=FACE, outline=(255, 255, 255, 255), width=14)
    # 表盘刻度：150° 起，顺时针 240°
    for i in range(13):
        ang = math.radians(150 + i * 20)
        r1 = r - 44
        r2 = r - 12
        x1, y1 = cx + r1 * math.cos(ang), cy + r1 * math.sin(ang)
        x2, y2 = cx + r2 * math.cos(ang), cy + r2 * math.sin(ang)
        width = 10 if i % 3 else 16
        d.line([x1, y1, x2, y2], fill=TICK, width=width)
    # 指针：大约 0.32 MPa 的位置
    ang = math.radians(300)
    nx = cx + (r - 70) * math.cos(ang)
    ny = cy + (r - 70) * math.sin(ang)
    d.line([cx, cy, nx, ny], fill=NEEDLE, width=18)
    d.ellipse([cx - 26, cy - 26, cx + 26, cy + 26], fill=DARK)
    d.ellipse([cx - 12, cy - 12, cx + 12, cy + 12], fill=(255, 255, 255, 255))
    return img.resize((size, size), Image.Resampling.LANCZOS)


make(512).save(os.path.join(OUT, 'icon-512.png'))
make(192).save(os.path.join(OUT, 'icon-192.png'))
make(512, maskable=True).save(os.path.join(OUT, 'icon-maskable-512.png'))
make(180).save(os.path.join(OUT, 'apple-touch-icon.png'))
print('icons written')
