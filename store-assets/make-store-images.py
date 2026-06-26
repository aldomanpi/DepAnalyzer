#!/usr/bin/env python3
"""Canvas raw popup/options screenshots to Chrome Web Store size (1280x800).

Drop source PNG/JPG files in store-assets/raw/ and run:
    pip install Pillow
    python3 store-assets/make-store-images.py
Output goes to store-assets/store/<name>-1280x800.png — centered on the dark
theme background with a soft drop shadow. Sources larger than the canvas are
scaled down to fit (with margin); smaller ones keep their native resolution.
"""
import glob
import os

from PIL import Image, ImageFilter

W, H = 1280, 800
BG = (15, 23, 42)        # #0f172a — matches the extension's dark theme
MARGIN = 60              # min gap between screenshot and canvas edge

HERE = os.path.dirname(os.path.abspath(__file__))
IN = os.path.join(HERE, "raw")
OUT = os.path.join(HERE, "store")
os.makedirs(OUT, exist_ok=True)

sources = sorted(
    p for p in glob.glob(os.path.join(IN, "*"))
    if p.lower().rsplit(".", 1)[-1] in ("png", "jpg", "jpeg", "webp")
)
if not sources:
    print("No images found in store-assets/raw/ — add your screenshots there.")
    raise SystemExit(0)

for path in sources:
    img = Image.open(path).convert("RGBA")

    # Scale down only if it doesn't fit within the canvas minus the margin.
    maxw, maxh = W - 2 * MARGIN, H - 2 * MARGIN
    if img.width > maxw or img.height > maxh:
        img.thumbnail((maxw, maxh), Image.LANCZOS)

    x = (W - img.width) // 2
    y = (H - img.height) // 2

    # Soft drop shadow for a polished look.
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    block = Image.new("RGBA", (img.width + 36, img.height + 36), (0, 0, 0, 150))
    shadow.paste(block, (x - 18, y - 14))
    shadow = shadow.filter(ImageFilter.GaussianBlur(20))

    canvas = Image.alpha_composite(Image.new("RGBA", (W, H), BG + (255,)), shadow)
    canvas.paste(img, (x, y), img)

    name = os.path.splitext(os.path.basename(path))[0]
    out_path = os.path.join(OUT, f"{name}-1280x800.png")
    canvas.convert("RGB").save(out_path)
    print(f"wrote {out_path}  (source {img.width}x{img.height})")
