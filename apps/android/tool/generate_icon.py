#!/usr/bin/env python3
"""Generate Android launcher assets from the supplied artwork (requires Pillow).

The source is retained unchanged. Adaptive layers remove the outer white
corners/background and fit the existing mark within the 66dp safe circle.
"""
from collections import Counter
from math import hypot
from pathlib import Path
import re

from PIL import Image, ImageChops, ImageDraw

APP = Path(__file__).resolve().parents[1]
RES = APP / "android/app/src/main/res"
source = Image.open(APP / "tool/icon/source.png").convert("RGB")
pixels = getattr(source, "get_flattened_data", source.getdata)()
background = Counter(pixels).most_common(1)[0][0]

# Flood out the four exterior corners; retain both original mark components.
difference = ImageChops.difference(source, Image.new("RGB", source.size, background))
r, g, b = difference.split()
contrast = ImageChops.lighter(ImageChops.lighter(r, g), b)
mask = contrast.point(lambda value: 255 if value else 0)
for xy in [(0, 0), (source.width - 1, 0), (0, source.height - 1),
           (source.width - 1, source.height - 1)]:
    ImageDraw.floodfill(mask, xy, 0)
mark = source.convert("RGBA")
mark.putalpha(mask)
center = (source.width / 2, source.height / 2)
radius = max(
    hypot(x - center[0], y - center[1])
    for y in range(source.height)
    for x in range(source.width)
    if mask.getpixel((x, y))
)
# 32dp radius leaves one dp inside Android's 33dp safe radius.
scale = 32 / radius
alpha = ImageChops.multiply(
    contrast.point(lambda value: min(255, round(value * 255 / 217))), mask
)
mono = Image.new("RGBA", source.size, (255, 255, 255, 0))
mono.putalpha(alpha)

for density, factor in [("mdpi", 1), ("hdpi", 1.5), ("xhdpi", 2),
                        ("xxhdpi", 3), ("xxxhdpi", 4)]:
    size = round(108 * factor)
    dims = (round(source.width * scale * factor), round(source.height * scale * factor))
    position = ((size - dims[0]) // 2, (size - dims[1]) // 2)
    folder = RES / f"drawable-{density}"
    folder.mkdir(exist_ok=True)
    for name, artwork in [("foreground", mark), ("monochrome", mono)]:
        layer = Image.new("RGBA", (size, size))
        layer.alpha_composite(artwork.resize(dims, Image.Resampling.LANCZOS), position)
        layer.save(folder / f"ic_launcher_{name}.png", optimize=True)
    legacy = Image.new("RGB", (round(48 * factor),) * 2, background)
    fitted = source.resize(
        (legacy.width, round(legacy.width * source.height / source.width)),
        Image.Resampling.LANCZOS,
    )
    legacy.paste(fitted, (0, (legacy.height - fitted.height) // 2))
    legacy.save(RES / f"mipmap-{density}/ic_pirc.png", optimize=True)
    (RES / f"mipmap-{density}/ic_launcher.png").unlink(missing_ok=True)

(RES / "drawable/ic_launcher_foreground.xml").unlink(missing_ok=True)
versioned = RES / "mipmap-anydpi-v26"
versioned.mkdir(exist_ok=True)
(versioned / "ic_pirc.xml").write_text('''<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />
</adaptive-icon>
''')
(RES / "mipmap-anydpi/ic_pirc.xml").unlink(missing_ok=True)
color = "#%02X%02X%02X" % background
for path in [RES / "values/pirc_colors.xml", RES / "values-night/pirc_colors.xml"]:
    path.write_text(re.sub(
        r'(<color name="ic_launcher_background">)[^<]+',
        lambda match: match[1] + color,
        path.read_text(),
    ))
print("Generated launcher icon from original artwork; background:", color)
