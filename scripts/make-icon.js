'use strict';
// Developer tool: renders build/icon.svg to build/icon.png (the installer and window icon).
//   npx electron scripts/make-icon.js
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, useContentSize: true, transparent: true, frame: false,
    webPreferences: { offscreen: true, zoomFactor: 1 } });
  const svg = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.svg'), 'utf8');
  await win.loadURL(`data:text/html,<body style="margin:0;background:transparent">${encodeURIComponent(svg)}</body>`);
  await new Promise((r) => setTimeout(r, 500));
  const image = (await win.webContents.capturePage()).resize({ width: 512, height: 512 });
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), image.toPNG());
  app.quit();
});
