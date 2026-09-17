'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, protocol, shell } = require('electron');

const {
  TimeCard, TimeCardError, labelItems, toIso, FINISHED, PIECE_TYPES,
} = require('../core/timecard.js');

const PHOTO_SIZE = 512; // library photos are square and small: they are icons, not an archive
const PHOTO_NAME = /^[0-9a-f]{16}\.jpg$/;

const dataDirArg = process.argv.find((arg) => arg.startsWith('--data-dir='));
let card;
let mainWindow;

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
  deletePhoto: ({ photo }) => card.deletePhoto(photo),
  importPhotoPath: ({ file }) => ({ photo: importPhoto(String(file)) }),

  async importPhoto() {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a photo', properties: ['openFile'],
      filters: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png'] }],
    });
    return picked.canceled ? { photo: null } : { photo: importPhoto(picked.filePaths[0]) };
  },

  async exportCsv({ scope }) {
    const stamp = toIso(new Date()).slice(0, 10).replace(/-/g, '');
    const picked = await dialog.showSaveDialog(mainWindow, {
      title: 'Export CSV', defaultPath: path.join(app.getPath('documents'), `timecard-${scope}-${stamp}.csv`),
      filters: [{ name: 'CSV file', extensions: ['csv'] }],
    });
    if (picked.canceled) return { file: null };
    const items = scope === 'finished' ? card.listItems().filter((i) => i.status === FINISHED) : undefined;
    return { file: picked.filePath, count: card.exportCsv(picked.filePath, items) };
  },

  openDataFolder: () => { shell.openPath(card.dataDir); },
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000, height: 860, minWidth: 640, minHeight: 520, show: false,
    title: 'BenchClock', backgroundColor: '#f5f1e8', autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  // This window only ever shows the app's own page.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
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
    // The default menu is full of browser and developer entries that would only confuse.
    if (process.platform !== 'darwin' && app.isPackaged) Menu.setApplicationMenu(null);
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  // Closing the window doesn't clock anyone out: the session lives on disk.
  app.on('window-all-closed', () => app.quit());
}
