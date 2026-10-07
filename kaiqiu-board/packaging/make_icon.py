"""用 Pillow 画应用图标，输出 icon.png / icon.ico / icon.icns 到 build/icon/。"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "build" / "icon"


def draw(size: int = 1024) -> Image.Image:
    s = size / 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = 4 * s  # macOS 图标留边
    d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=13 * s, fill="#17365d")
    d.ellipse([39 * s, 11 * s, 53 * s, 25 * s], fill="#f5a524")
    for x0, top in ((13, 36), (26, 26), (39, 32)):
        d.rounded_rectangle([x0 * s, top * s, (x0 + 9) * s, 51 * s], radius=1.5 * s, fill="#ffffff")
    return img


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    img = draw()
    img.save(OUT / "icon.png")
    img.save(OUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    img.save(OUT / "icon.icns")
    return OUT


if __name__ == "__main__":
    print(main())
