#!/usr/bin/env python3
"""开球网数据看板：python run.py（独立窗口），python run.py --browser（浏览器）。"""
import os
import sys

if sys.version_info < (3, 9):
    sys.exit("需要 Python 3.9 或更高版本")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from kaiqiu.app import main  # noqa: E402

if __name__ == "__main__":
    main()
