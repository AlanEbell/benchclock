"""Build a standalone app that doesn't need Python installed.

    pip install pyinstaller
    python build_app.py

Run it on each operating system you want an app for; the result lands in dist/.
"""
import os

import PyInstaller.__main__

PyInstaller.__main__.run([
    "run.py",
    "--name", "JewelryTimeCard",
    "--onefile",
    "--add-data", f"jewelry_timecard/ui.html{os.pathsep}jewelry_timecard",
])
