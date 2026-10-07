# 开球网数据看板 2.0（KaiqiuBoard）

把开球网全国与 35 区域的月度历史、滚动时段统计做成一个本地看板应用。**Windows 和 macOS 用同一套代码**，
双击打开，自动更新，可导出 Excel / CSV / 图片。

- 用户安装说明：[docs/安装说明.md](docs/安装说明.md)
- 与 Codex 版相比改进了什么：[docs/改进说明.md](docs/改进说明.md)

## 下载安装包

GitHub → Actions → **kaiqiu-board** → 最新一次运行 → Artifacts：

| 文件 | 用途 |
| --- | --- |
| `KaiqiuBoard-Windows-x64` | 安装程序 `KaiqiuBoard-Setup-2.0.0-x64.exe` + 免安装 zip |
| `KaiqiuBoard-macOS-AppleSilicon` | `KaiqiuBoard-2.0.0-macOS-arm64.dmg` |
| `KaiqiuBoard-macOS-Intel` | `KaiqiuBoard-2.0.0-macOS-x86_64.dmg` |
| `KaiqiuBoard-source` | 完整源码 zip |

推一个 `kaiqiu-v*` 标签（如 `kaiqiu-v2.0.0`）会自动发布到 Releases 页面。

## 从源码运行

| 系统 | 操作 |
| --- | --- |
| macOS | 双击 `start-mac.command`（需要 Python 3.9+；被拦截时右键 → 打开） |
| Windows | 双击 `start-windows.bat`（安装 Python 时勾选 “Add python.exe to PATH”） |
| 命令行 | `pip install -r requirements.txt && python run.py` |

`python run.py --browser` 用浏览器打开；`--no-refresh` 启动时不更新；`--serve-only --port 8768` 只起服务。

## 自己打包

```bash
pip install -r requirements.txt pyinstaller pillow
python packaging/build.py      # 在哪个系统上运行就打出哪个系统的包；Windows 安装程序需要 NSIS
```

## 测试

```bash
python -m unittest discover -s tests -v   # 21 项：解析、校验、刷新回滚、修订检测、Excel、HTTP 安全
node tests/model.test.js                  # 8 项：环比/同比/年度/分组等前端计算
python tests/live_check.py                # 真实访问开球网（需要网络）
```

## 结构

```
run.py                 入口
kaiqiu/
  app.py               启动：本机服务 + 原生窗口（pywebview），窗口不可用时自动改浏览器
  server.py            HTTP 服务：127.0.0.1 随机端口，Host/Origin/令牌校验，原生保存对话框
  store.py             快照：校验 → 异常检测 → 修订对比 → 原子切换 → 保留最近 12 份
  source.py            开球网 CSV 接口取数与解析（并发、重试）
  excel.py             Excel 报表（8 张表、3 张原生图表，全部是数值不依赖公式）
  paths.py             Windows / macOS / Linux 数据目录
  seed.json            附带的初始数据（2026-10-03，首次打开或离线时显示）
  web/                 页面：index.html、app.js、model.js（纯计算）、style.css、vendor/echarts
packaging/             build.py（PyInstaller + dmg / NSIS）、installer.nsi、make_icon.py
tests/                 Python 与 Node 测试
```

## 数据口径

- **参赛人次**按来源累计，同一人参加多场会重复计入，不是去重人数；**比赛场次**是来源“本月比赛场次”。
- 环比、同比按当前指标各自计算；基数为 0 时显示“新增”，没有基数显示“—”，都不当作 0。
- 当月未结束标为“进行中”，不参与默认排名；年度和区间同比只与去年**相同月份**比较。
- 全国来自独立接口，可能与 35 区域之和略有差别，两者都原样显示。
- 每次更新都重新取**全部历史**（网站会修订历史），并列出被修订的数值。

数据来源：<https://kaiqiuwang.cc/home/cityEventsMonthly.php>、<https://kaiqiuwang.cc/home/cityEvents.php>。
ECharts 使用 Apache-2.0 许可证（`kaiqiu/web/vendor/ECHARTS-LICENSE.txt`）。
