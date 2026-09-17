'use strict';
// Developer tool: renders build/icon.svg into every PNG the installers and the window need.
//   npx electron scripts/make-icon.js
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512]; // Linux menus and panels pick the closest of these

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, useContentSize: true, transparent: true, frame: false,
    webPreferences: { offscreen: true, zoomFactor: 1 } });
  const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8').replace('<svg ', '<svg width="1024" height="1024" ');
  await win.loadURL(`data:text/html,<body style="margin:0;background:transparent">${encodeURIComponent(svg)}</body>`);
  await new Promise((r) => setTimeout(r, 500));
  const full = (await win.webContents.capturePage()).resize({ width: 1024, height: 1024 });
  const png = (size) => full.resize({ width: size, height: size, quality: 'best' }).toPNG();
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), png(1024)); // Windows .ico and macOS .icns are made from this
  fs.mkdirSync(path.join(root, 'build', 'icons'), { recursive: true });
  for (const size of SIZES) fs.writeFileSync(path.join(root, 'build', 'icons', `${size}x${size}.png`), png(size));
  fs.writeFileSync(path.join(root, 'src', 'renderer', 'icon.png'), png(256)); // the window's own icon
  app.quit();
});
