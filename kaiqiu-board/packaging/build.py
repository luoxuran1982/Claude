"""在哪个系统上运行就打出哪个系统的安装包。

    pip install -r requirements.txt pyinstaller
    python packaging/build.py

Windows → dist/KaiqiuBoard-Setup-<版本>-x64.exe（需要 NSIS）和 dist/KaiqiuBoard-<版本>-windows-x64.zip
macOS   → dist/开球网数据看板.app 和 dist/KaiqiuBoard-<版本>-macOS-<arm64|x86_64>.dmg
"""
from __future__ import annotations

import os
import platform
import plistlib
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "packaging"))
from kaiqiu import APP_NAME, __version__  # noqa: E402
import make_icon  # noqa: E402

for _stream in (sys.stdout, sys.stderr):  # Windows CI 控制台默认不是 UTF-8
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

NAME = "KaiqiuBoard"
DIST = ROOT / "dist"


def pyinstaller(icon_dir: Path) -> Path:
    import PyInstaller.__main__
    sep = os.pathsep
    icon = icon_dir / ("icon.icns" if sys.platform == "darwin" else "icon.ico")
    args = [
        str(ROOT / "run.py"), "--name", NAME, "--noconfirm", "--clean", "--onedir", "--windowed",
        "--icon", str(icon),
        "--distpath", str(DIST), "--workpath", str(ROOT / "build" / "pyinstaller"), "--specpath", str(ROOT / "build"),
        "--add-data", f"{ROOT / 'kaiqiu' / 'web'}{sep}kaiqiu/web",
        "--add-data", f"{ROOT / 'kaiqiu' / 'seed.json'}{sep}kaiqiu",
        "--collect-data", "certifi",
        "--collect-all", "webview",
        "--exclude-module", "tkinter",
    ]
    if sys.platform == "darwin":
        args += ["--osx-bundle-identifier", "app.kaiqiuboard"]
    PyInstaller.__main__.run(args)
    return DIST / (f"{NAME}.app" if sys.platform == "darwin" else NAME)


def finish_mac(app: Path) -> None:
    plist_path = app / "Contents" / "Info.plist"
    info = plistlib.loads(plist_path.read_bytes())
    info.update({
        "CFBundleDisplayName": APP_NAME, "CFBundleName": APP_NAME,
        "CFBundleShortVersionString": __version__, "CFBundleVersion": __version__,
        "LSMinimumSystemVersion": "11.0", "NSHighResolutionCapable": True,
        "LSApplicationCategoryType": "public.app-category.sports",
        "NSHumanReadableCopyright": "数据来源：开球网公开统计",
    })
    plist_path.write_bytes(plistlib.dumps(info))
    # 改了 Info.plist 必须重新签名（无开发者证书时用临时签名）
    subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(app)], check=True)
    final = DIST / f"{APP_NAME}.app"
    if final.exists():
        shutil.rmtree(final)
    app.rename(final)
    arch = platform.machine()
    staging = ROOT / "build" / "dmg"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    subprocess.run(["ditto", str(final), str(staging / final.name)], check=True)
    (staging / "Applications").symlink_to("/Applications")
    shutil.copy(ROOT / "docs" / "安装说明.md", staging / "安装说明（先看这里）.md")
    dmg = DIST / f"{NAME}-{__version__}-macOS-{arch}.dmg"
    dmg.unlink(missing_ok=True)
    subprocess.run(["hdiutil", "create", "-volname", APP_NAME, "-srcfolder", str(staging),
                    "-ov", "-format", "UDZO", str(dmg)], check=True)
    print("完成：", final, dmg)


def find_makensis() -> str | None:
    for c in (shutil.which("makensis"), r"C:\Program Files (x86)\NSIS\makensis.exe", r"C:\Program Files\NSIS\makensis.exe"):
        if c and Path(c).exists():
            return c
    return None


def finish_windows(folder: Path, icon_dir: Path) -> None:
    shutil.copy(ROOT / "docs" / "安装说明.md", folder / "安装说明.md")
    portable = DIST / f"{NAME}-{__version__}-windows-x64"
    shutil.make_archive(str(portable), "zip", DIST, NAME)
    print("便携版：", portable.with_suffix(".zip"))
    makensis = find_makensis()
    if not makensis:
        print("没有找到 NSIS（makensis），跳过安装程序。安装：choco install nsis")
        return
    out = DIST / f"{NAME}-Setup-{__version__}-x64.exe"
    subprocess.run([makensis, "/INPUTCHARSET", "UTF8", f"/DVERSION={__version__}", f"/DSRC={folder}",
                    f"/DOUT={out}", f"/DICON={icon_dir / 'icon.ico'}", str(ROOT / "packaging" / "installer.nsi")], check=True)
    print("安装程序：", out)


def main():
    icon_dir = make_icon.main()
    built = pyinstaller(icon_dir)
    if sys.platform == "darwin":
        finish_mac(built)
    elif sys.platform == "win32":
        finish_windows(built, icon_dir)
    else:
        print("完成：", built)


if __name__ == "__main__":
    main()
