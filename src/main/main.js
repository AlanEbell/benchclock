'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, protocol, shell } = require('electron');

const {
  TimeCard, TimeCardError, labelItems, toIso, checkPeriod, narrowItem, narrowItems, sessionIds, FINISHED, OVERHEAD, PIECE_TYPES,
} = require('../core/timecard.js');
const { buildReportHtml, periodLabel } = require('./report.js');
const { version, homepage } = require('../../package.json');

const PHOTO_SIZE = 512; // library photos are square and small: they are icons, not an archive
const PHOTO_NAME = /^[0-9a-f]{16}\.jpg$/;

const dataDirArg = process.argv.find((arg) => arg.startsWith('--data-dir='));
let card;
let mainWindow;
let helpWindow;
let calcWindow;

protocol.registerSchemesAsPrivileged([{ scheme: 'bench-photo', privileges: { secure: true } }]);

function buildState() {
  const items = labelItems(card.listItems());
  return {
    now: toIso(new Date()),
    session: card.currentSession(),
    items,
    overhead: card.overheadItem(),
    clockOutIds: card.clockOutCandidates().map((item) => item.id),
    photos: card.listPhotos(),
    types: PIECE_TYPES,
    dataDir: card.dataDir,
    app: { version, electron: process.versions.electron },
  };
}

/** Square-crop from the middle, shrink, and keep the JPEG in the photo library. */
function importPhoto(file) {
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) {
    throw new TimeCardError("Couldn't read that picture. JPEG and PNG files work; " +
      'iPhone HEIC photos need to be saved as JPEG first.');
  }
  const { width, height } = image.getSize();
  const side = Math.min(width, height);
  const square = image.crop({
    x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side,
  });
  const small = side > PHOTO_SIZE ? square.resize({ width: PHOTO_SIZE, height: PHOTO_SIZE, quality: 'best' }) : square;
  return card.addPhoto(small.toJPEG(88));
}

// What a report or an export can be about.
const SCOPES = { all: 'Every piece', ticked: 'Ticked pieces', bench: 'Pieces on the bench', finished: 'Finished pieces' };

/**
 * Work out what a report or export covers. `scope` picks the pieces (`ids` are the ticked ones) and
 * `from`/`to` the days. TimeOverhead only comes along when every piece does.
 */
function choose({ scope = 'all', ids = [], from, to } = {}) {
  if (!Object.hasOwn(SCOPES, scope)) throw new TimeCardError(`Unknown choice of pieces: ${scope}`);
  const period = checkPeriod({ from, to });
  if (!Array.isArray(ids)) ids = [];
  const wanted = {
    all: () => true, ticked: (i) => ids.includes(i.id), bench: (i) => i.status !== FINISHED, finished: (i) => i.status === FINISHED,
  }[scope];
  // labelled first, so "(2 of 3)" still means what it does on screen
  return { scope, period, items: labelItems(card.listItems()).filter(wanted), overhead: scope === 'all' ? card.overheadItem() : null };
}

/** For the names of saved files: "finished from 2026-09-07 to 2026-09-13", or today's date when there is nothing to say. */
function fileWords({ scope, period }) {
  const words = [scope !== 'all' && scope, period.from && `from ${period.from}`, period.to && `to ${period.to}`].filter(Boolean);
  return words.length ? words.join(' ') : toIso(new Date()).slice(0, 10);
}

/** Lay the report out in a hidden window and print that to a PDF file. `choice` is what choose() takes; leave it out for everything. */
async function writeReportPdf(file, choice = {}) {
  const { scope, period, items, overhead } = choose(choice);
  const pieces = scope === 'all' ? '' : SCOPES[scope];
  const html = buildReportHtml({
    items, overhead, types: PIECE_TYPES, photosDir: card.photosDir, period, pieces, handPicked: scope === 'ticked',
  });
  const covers = [pieces, periodLabel(period)].filter(Boolean).join(' \u00b7 ');
  const page = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'benchclock-report-')), 'report.html');
  fs.writeFileSync(page, html, 'utf8');
  const printer = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await printer.loadFile(page);
    const letter = ['US', 'CA', 'MX'].includes(app.getLocaleCountryCode());
    const small = 'font-size:8px; color:#776d62; width:100%; padding:0 14mm;';
    fs.writeFileSync(file, await printer.webContents.printToPDF({
      pageSize: letter ? 'Letter' : 'A4', printBackground: true,
      margins: { top: 0.6, bottom: 0.7, left: 0.55, right: 0.55 }, // inches
      displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: `<div style="${small} display:flex; justify-content:space-between;"><span>BenchClock time report${covers ? ` \u00b7 ${covers}` : ''}</span>` +
        '<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>',
    }));
  } finally {
    printer.destroy();
    fs.rmSync(path.dirname(page), { recursive: true, force: true });
  }
}

/** The chosen pieces with only the chosen days' time on them, TimeOverhead last: the rows of a CSV. */
function exportRows({ scope, period, items, overhead }) {
  const ranged = period.from || period.to;
  return [...narrowItems(items, period, scope === 'ticked'), ...(overhead ? [ranged ? narrowItem(overhead, period) : overhead] : [])];
}

const api = {
  state: () => null,
  clockIn: () => card.clockIn(),
  clockOut: ({ allocations, when }) => card.clockOut(allocations, when),
  cancelSession: () => card.cancelClockIn(),
  addItem: (piece) => card.addItem(piece),
  updateItem: ({ id, ...changes }) => card.updateItem(id, changes),
  deleteItem: ({ id }) => card.deleteItem(id),
  finishItems: ({ ids }) => card.finishItems(ids),
  finishPart: ({ id, count }) => card.finishPartOfBatch(id, count),
  reopenItem: ({ id }) => card.reopenItem(id),
  adjustTime: (change) => card.adjustTime(change),
  deletePhoto: ({ photo }) => card.deletePhoto(photo),
  importPhotoPath: ({ file }) => ({ photo: importPhoto(String(file)) }),

  async importPhoto() {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a photo', properties: ['openFile'],
      filters: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png'] }],
    });
    return picked.canceled ? { photo: null } : { photo: importPhoto(picked.filePaths[0]) };
  },

  /** What the choices in the report box come to, before anything is saved. */
  exportPreview(choice) {
    const rows = exportRows(choose(choice));
    const pieces = rows.filter((i) => i.status !== OVERHEAD);
    return {
      pieces: pieces.reduce((n, i) => n + i.quantity, 0),
      making: pieces.reduce((n, i) => n + i.total_seconds, 0),
      overhead: rows.filter((i) => i.status === OVERHEAD).reduce((n, i) => n + i.total_seconds, 0),
      sessions: sessionIds(rows).size,
    };
  },

  async exportCsv(choice) {
    const chosen = choose(choice);
    const picked = await dialog.showSaveDialog(mainWindow, {
      title: 'Export CSV', defaultPath: path.join(app.getPath('documents'), `BenchClock ${fileWords(chosen)}.csv`),
      filters: [{ name: 'CSV file', extensions: ['csv'] }],
    });
    if (picked.canceled) return { file: null };
    return { file: picked.filePath, count: card.exportCsv(picked.filePath, exportRows(chosen)) };
  },

  async exportReport(choice) {
    const picked = await dialog.showSaveDialog(mainWindow, {
      title: 'Save time report', defaultPath: path.join(app.getPath('documents'), `BenchClock report ${fileWords(choose(choice))}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (picked.canceled) return { file: null };
    await writeReportPdf(picked.filePath, choice);
    shell.openPath(picked.filePath); // show it straight away in the computer's PDF viewer
    return { file: picked.filePath };
  },

  openDataFolder: () => { shell.openPath(card.dataDir); },
  openHelp: () => { openHelp(); },
  openCalculators: () => { openCalculators(); },
  openHomepage: () => { shell.openExternal(homepage); },
};

ipcMain.handle('api', async (event, method, payload) => {
  try {
    if (!Object.hasOwn(api, method)) throw new TimeCardError(`Unknown request: ${method}`);
    const result = await api[method](payload || {});
    return { ok: true, result: result ?? null, state: buildState() };
  } catch (error) {
    if (error instanceof TimeCardError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: `Something went wrong: ${error.message}` };
  }
});

// read through fs so it also works from inside the packaged app archive
const windowIcon = () => nativeImage.createFromBuffer(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'icon.png')));

/** A window's own page and nothing else: no pop-ups, no following links away. */
function stayOnPage(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
}

/** The guide, in a window of its own so it can sit beside the app while it is read. */
function openHelp() {
  if (helpWindow) {
    if (helpWindow.isMinimized()) helpWindow.restore();
    helpWindow.show();
    helpWindow.focus();
    return;
  }
  helpWindow = new BrowserWindow({
    width: 780, height: 820, minWidth: 420, minHeight: 360, show: false,
    title: 'BenchClock Help', backgroundColor: '#f5f1e8', icon: windowIcon(),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  if (process.platform !== 'darwin') helpWindow.removeMenu();
  helpWindow.once('ready-to-show', () => helpWindow.show());
  helpWindow.on('closed', () => { helpWindow = null; });
  stayOnPage(helpWindow);
  helpWindow.loadFile(path.join(__dirname, '..', 'renderer', 'help.html'));
}

/** The bench calculators (ring blanks, bezels, jump rings, metal weight...), in a window of their own. Plain page, no access to the time card. */
function openCalculators() {
  if (calcWindow) {
    if (calcWindow.isMinimized()) calcWindow.restore();
    calcWindow.show();
    calcWindow.focus();
    return;
  }
  calcWindow = new BrowserWindow({
    width: 980, height: 800, minWidth: 560, minHeight: 420, show: false,
    title: 'BenchClock Calculators', backgroundColor: '#f5f1e8', icon: windowIcon(),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  if (process.platform !== 'darwin') calcWindow.removeMenu();
  calcWindow.once('ready-to-show', () => calcWindow.show());
  calcWindow.on('closed', () => { calcWindow = null; });
  stayOnPage(calcWindow);
  calcWindow.loadFile(path.join(__dirname, '..', 'renderer', 'calculators.html'));
}

/** The menu bar. Entries that belong to the page are passed on to it (see app.js, menuActions). */
function buildMenu() {
  const mac = process.platform === 'darwin';
  const toPage = (action) => () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.send('menu', action);
  };
  const line = { type: 'separator' };
  const about = { label: 'About BenchClock', click: toPage('about') };
  return Menu.buildFromTemplate([
    ...(mac ? [{
      label: app.name,
      submenu: [about, line, { role: 'services' }, line, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, line, { role: 'quit' }],
    }] : []),
    {
      label: '&File',
      submenu: [
        { label: 'Add a piece\u2026', accelerator: 'CmdOrCtrl+N', click: toPage('add') },
        line,
        { label: 'Report or export\u2026', accelerator: 'CmdOrCtrl+P', click: toPage('report') },
        line,
        { label: 'Open the data folder', click: () => { shell.openPath(card.dataDir); } },
        ...(mac ? [] : [line, { role: 'quit' }]),
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, line, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        line, { label: 'Adjust time\u2026', accelerator: 'CmdOrCtrl+T', click: toPage('adjust') },
      ],
    },
    {
      label: '&View',
      submenu: [
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, line, { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [line, { role: 'reload' }, { role: 'toggleDevTools' }]), // only when run from the source
      ],
    },
    {
      label: '&Tools',
      submenu: [{ label: 'Calculators\u2026', accelerator: 'CmdOrCtrl+K', click: openCalculators }],
    },
    {
      label: '&Help', role: 'help',
      submenu: [{ label: 'BenchClock Help', accelerator: 'F1', click: openHelp }, ...(mac ? [] : [line, about])],
    },
  ]);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000, height: 860, minWidth: 640, minHeight: 520, show: false,
    title: 'BenchClock', backgroundColor: '#f5f1e8', icon: windowIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (helpWindow) helpWindow.destroy(); // the guide and the calculators don't outlive the app
    if (calcWindow) calcWindow.destroy();
  });
  stayOnPage(mainWindow);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit(); // already open: the first copy brings its window forward instead
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    card = new TimeCard(dataDirArg ? dataDirArg.slice('--data-dir='.length) : undefined);
    protocol.handle('bench-photo', (request) => {
      const name = new URL(request.url).pathname.replace(/^\//, '');
      const file = path.join(card.photosDir, name);
      if (!PHOTO_NAME.test(name) || !fs.existsSync(file)) return new Response('', { status: 404 });
      return new Response(fs.readFileSync(file), { headers: { 'content-type': 'image/jpeg' } });
    });
    // In place of the default menu, which is full of browser and developer entries that would only confuse.
    Menu.setApplicationMenu(buildMenu());
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  // Closing the window doesn't clock anyone out: the session lives on disk.
  app.on('window-all-closed', () => app.quit());
}

module.exports = { writeReportPdf }; // for scripts/smoke.js
