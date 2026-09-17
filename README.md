# Jewelry Time Card

A time card for jewelry artists. Clock in, work, clock out, and say what share of
the session went to each piece. A desktop app for Linux, Windows and macOS.

## Running it

Needs Python 3.9 or newer with Tk — nothing else to install.

| System  | How to start                                | Tk                                   |
|---------|---------------------------------------------|--------------------------------------|
| Windows | double-click `Start Time Card.bat`          | included with Python from python.org |
| macOS   | double-click `Start Time Card.command`      | included with Python from python.org |
| Linux   | `./start-timecard.sh` (or `python3 run.py`) | `sudo apt install python3-tk`        |

Closing the window does not clock you out — the session is kept on disk, so it
survives a restart.

To make a standalone app that doesn't need Python: `pip install pyinstaller`,
then `python build_app.py` on each operating system you want an app for.

## How it works

- **Add a piece** with a name and how many. For more than one, choose:
  - *One batch made together* — a single entry (`Hoop earrings ×6`) whose time is
    shared evenly, giving a per-piece time.
  - *Separate pieces* — individual entries (`Moonstone ring (1 of 3)` …), each
    timed on its own.
- **Clock out** asks what percent of the session went to each piece. Pieces with
  the same name get an "All 3 × …" row that splits one number evenly across them.
  *Split evenly* and *Spread the rest* fill in the arithmetic. The clock-out time
  can be changed if you forgot to clock out.
- **TimeOverhead** is always there. The percentages don't have to reach 100%:
  whatever isn't given to a piece goes to TimeOverhead, the catch-all for
  everything besides making (ordering, photos, cleaning up). It can't be finished,
  renamed or deleted, and it has its own time log like any piece.
- **Mark finished** at any time by selecting pieces, clocked in or not. A piece
  finished mid-session still appears at clock-out so its last stretch is counted.
  *Finish some of a batch* marks part of a batch finished; those pieces take their
  even share of the time logged so far. Finished pieces can be reopened.

## Where the data lives

| System  | Folder                                              |
|---------|-----------------------------------------------------|
| Linux   | `~/.local/share/JewelryTimeCard`                    |
| macOS   | `~/Library/Application Support/JewelryTimeCard`     |
| Windows | `%APPDATA%\JewelryTimeCard`                         |

Use `--data-dir` (or the `JTC_DATA_DIR` environment variable) to put it elsewhere,
such as a synced folder.

- `items/<id>.json` — one file per piece or batch: name, SKU, quantity, status,
  `total_seconds`, `seconds_per_piece`, and a `time_entries` list with one record
  per work session (clock in/out, percent, seconds).
- `items/time-overhead.json` — the same, for TimeOverhead.
- `sessions/*.json` — one file per clock-in/clock-out with how it was split.

CSV export is on the Finished tab (finished pieces, or everything including
TimeOverhead), or from the command line: `python3 run.py --export pieces.csv`.
The item JSON files are the intended hand-off point for Superfy; that export is
not built yet.

## Code

- `jewelry_timecard/core.py` — all the time keeping and the JSON files. No interface.
- `jewelry_timecard/tk_app.py` — the window.
- `tests/` — `python3 -m unittest discover -s tests` (the window tests need a display).
