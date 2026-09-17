"""Command line entry point: opens the desktop window unless asked only to export."""

from __future__ import annotations

import argparse

from .core import TimeCard

NO_TK = """Jewelry Time Card needs Tk, which this Python was installed without.
On Debian, Ubuntu or Mint:   sudo apt install python3-tk
On Fedora:                   sudo dnf install python3-tkinter
On Windows and macOS, the installer from python.org includes it."""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="jewelry-timecard", description="Time card for jewelry artists.")
    parser.add_argument("--data-dir", help="where to keep the JSON files (default: per-user app data folder)")
    parser.add_argument("--export", metavar="FILE.csv", help="write a CSV of every piece and exit")
    args = parser.parse_args(argv)

    card = TimeCard(args.data_dir)
    if args.export:
        count = card.export_csv(args.export)
        print(f"Wrote {count} row{'' if count == 1 else 's'} to {args.export}")
        return 0
    try:
        from .tk_app import run
    except ImportError:
        print(NO_TK)
        return 1
    run(card)
    return 0
