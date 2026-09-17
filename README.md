# BenchClock

A time card for jewelry artists. Clock in, work, clock out, and say what share of the
session went to each piece on the bench. A desktop app for Linux, Windows and macOS.

## Using it

- **Clock in / Clock out** - one big button. Closing the window does not clock you out.
- **Add a piece** - a name, a tap on what it is (earrings, ring, pendant...), done.
- **Making several?** Set *How many*. They are listed as one line (`Moonstone ring x3`)
  with a `>` mark. Closed, it works as a batch: one number at clock-out is divided
  evenly among them. Open it to time, finish or edit one on its own. The same design
  added again later is a new group of its own.
- **Photos** - add a photo to a piece and it is shown instead of the icon. Every photo
  you add stays in your library as a choice for later pieces. JPEG and PNG; drop a
  picture onto the dialog or use *Add...*.
- **Clocking out** - type a percentage next to the pieces you worked on. *Split evenly*
  and *Spread the rest* do the arithmetic. You can correct the clock-out time if you
  forgot to clock out.
- **TimeOverhead** - always there. Whatever part of a session you don't give to a
  piece goes to it: ordering, photographing, cleaning up, anything besides making.
- **Finishing** - press *Finish* on a line (*Finish all* / *Finish some* on a group), or tick
  several and press *Mark finished*.
  Finished pieces can be reopened.
- **Report or export** - one box, three choices. *Which pieces*: everything, the ones you
  ticked, those on the bench, or those finished. *Which days*: this or last week, this or
  last month, this year, all time, or any From and To dates from a date picker; only time
  clocked on those days is counted. Then *Save as PDF* for a report to read and print
  (batches totalled with each piece listed beneath, the split between making and
  TimeOverhead, and for a range of days each piece's time to date alongside), or
  *Save as CSV* for a spreadsheet.
- **Menu bar** - *Help* has a detailed guide (F1) and *About BenchClock*, which shows the
  version that is running.

All data is plain files on your own computer; see [DATA_FORMAT.md](DATA_FORMAT.md).

## Development

Needs [Node.js](https://nodejs.org) 22 or newer.

    npm install
    npm start                 # run the app
    npm test                  # time-keeping logic (no window needed)
    npm run smoke -- --data-dir=/tmp/benchclock-smoke    # drives the real app end to end
    npm run dist              # build installers for this operating system into dist/

- `src/core/timecard.js` - all time keeping and file handling. No interface.
- `src/main/` - the Electron main process: window, menu bar, file dialogs, photo import, and
  the PDF report (`report.js` lays it out).
- `src/renderer/` - the window itself: HTML, CSS, and the icon set in `icons.js`.
  `help.html` is the guide behind *Help*; keep it in step with the app.
- `build/icon.svg` - the app icon; `npm run icon` renders it to PNG.

Installers have to be built on the system they are for (or by a cloud build).
They are not code-signed yet, so Windows and macOS show a warning the first time.
