# BenchClock

A time card for jewelry artists. Clock in, work, clock out, and say what share of the
session went to each piece on the bench. A desktop app for Linux, Windows and macOS.

## Using it

- **Clock in / Clock out** - one big button. Closing the window does not clock you out.
- **Add a piece** - a name, a tap on what it is (earrings, ring, pendant...), done.
  Making several? Choose *one batch made together* (`Hoop earrings x6`, time shared
  evenly) or *separate pieces* (`Moonstone ring (1 of 3)`..., each timed on its own).
- **Photos** - add a photo to a piece and it is shown instead of the icon. Every photo
  you add stays in your library as a choice for later pieces. JPEG and PNG; drop a
  picture onto the dialog or use *Add...*.
- **Clocking out** - type a percentage next to the pieces you worked on. Same-named
  pieces get an *All 3 x ...* row that splits one number between them. *Split evenly*
  and *Spread the rest* do the arithmetic. You can correct the clock-out time if you
  forgot to clock out.
- **TimeOverhead** - always there. Whatever part of a session you don't give to a
  piece goes to it: ordering, photographing, cleaning up, anything besides making.
- **Mark finished** - tick pieces at any time. *Finish some* finishes part of a batch.
  Finished pieces can be reopened.
- **Export** - CSV of finished pieces, or of everything including TimeOverhead.

All data is plain files on your own computer; see [DATA_FORMAT.md](DATA_FORMAT.md).

## Development

Needs [Node.js](https://nodejs.org) 22 or newer.

    npm install
    npm start                 # run the app
    npm test                  # time-keeping logic (no window needed)
    npm run smoke -- --data-dir=/tmp/benchclock-smoke    # drives the real app end to end
    npm run dist              # build installers for this operating system into dist/

- `src/core/timecard.js` - all time keeping and file handling. No interface.
- `src/main/` - the Electron main process: window, file dialogs, photo import.
- `src/renderer/` - the window itself: HTML, CSS, and the icon set in `icons.js`.
- `build/icon.svg` - the app icon; `npm run icon` renders it to PNG.

Installers have to be built on the system they are for (or by a cloud build).
They are not code-signed yet, so Windows and macOS show a warning the first time.
