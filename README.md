# Jewelry Time Card

A time card for jewelry artists. Clock in, work, clock out, and say what share of
the session went to each piece. Runs on Linux, Windows and macOS.

## Running it

Needs Python 3.9 or newer — nothing else to install.

| System  | How to start                                   |
|---------|------------------------------------------------|
| Windows | double-click `Start Time Card.bat`             |
| macOS   | double-click `Start Time Card.command`         |
| Linux   | `./start-timecard.sh` (or `python3 run.py`)    |

It opens in your web browser at `http://127.0.0.1:8765`. It only listens on your
own computer; nothing goes over the network. Leave the launcher window open while
you work. Closing the browser tab does not clock you out — the session is kept on
disk, so it survives a restart.

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
  *Split evenly* and *Spread the rest* fill in the arithmetic. The total must be 100%.
  The clock-out time can be changed if you forgot to clock out.
- **Mark finished** at any time by ticking pieces, clocked in or not. A piece
  finished mid-session still appears at clock-out so its last stretch is counted.
  *Finish some* marks part of a batch finished; those pieces take their even share
  of the time logged so far.

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
- `sessions/*.json` — one file per clock-in/clock-out with how it was split.
- `exports/` — a copy of every CSV exported from the app.

CSV export is in the app (finished pieces or everything), or from the command line:
`python3 run.py --export pieces.csv`. The item JSON files are the intended hand-off
point for Superfy; that export is not built yet.

## Tests

    python3 -m unittest discover -s tests
