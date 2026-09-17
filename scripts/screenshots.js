'use strict';
// Developer tool, not part of the app: fills a throwaway data folder with demo pieces,
// opens the real app on it and saves screenshots.   npx electron scripts/screenshots.js --data-dir=/tmp/x --out=/tmp/shots
const fs = require('node:fs');
const path = require('node:path');
const { app, nativeImage, BrowserWindow } = require('electron');
const { TimeCard } = require('../src/core/timecard.js');

const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=');
const out = arg('out');
const HOUR = 3600e3;
const card = new TimeCard(arg('data-dir'));
if (!card.listItems().length) {
  const swatch = (r, g, b) => nativeImage.createFromBuffer(Buffer.from(Array(64 * 64).fill([b, g, r, 255]).flat()), { width: 64, height: 64 }).toJPEG(90);
  const photo = card.addPhoto(swatch(190, 140, 60));
  card.addPhoto(swatch(90, 130, 170));
  const hoops = card.addItem({ name: 'Hoop earrings', quantity: 6, sku: 'HE-01', type: 'earrings', separate: true });
  const rings = card.addItem({ name: 'Moonstone ring', quantity: 3, separate: true, type: 'ring' });
  card.addItem({ name: 'Hammered cuff', notes: 'Commission for Dana', type: 'cuff', photo });
  card.addItem({ name: 'Rope chain', type: 'chain' });
  card.addItem({ name: 'Moonstone ring', quantity: 2, separate: true, type: 'ring' }); // a later batch of the same design
  const [pendant] = card.addItem({ name: 'Opal pendant', type: 'pendant' });
  const t0 = new Date(Date.now() - 6 * HOUR);
  card.clockIn(t0);
  card.clockOut({ ...Object.fromEntries(hoops.map((h) => [h.id, 10])), [rings[0].id]: 25 }, new Date(t0.getTime() + 2.2 * HOUR));
  card.finishItems([pendant.id]);
  card.clockIn(new Date(Date.now() - 1.78 * HOUR));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (event, win) => {
  if (started) return; // only the app's own window, not the guide or the report printer
  started = true;
  win.webContents.once('did-finish-load', async () => {
    const run = (js) => win.webContents.executeJavaScript(js, true);
    const shot = async (name) => { await wait(500); fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG()); };
    await wait(800);
    await shot('main');
    await run("expanded.add('bench:' + state.items.find((i) => i.name === 'Moonstone ring').batch_id); render()");
    await shot('main-open');
    await run("openPieceDialog(null); $('pName').value = 'Garnet studs'; draft.type = 'earrings'; $('pQty').value = 4; $('pQty').dispatchEvent(new Event('input')); renderPickers();");
    await shot('add');
    await run("$('pieceDlg').close(); openClockOut()");
    await wait(300);
    await run("(() => { const g = document.querySelector('input[data-group]'); g.value = 45; g.dispatchEvent(new Event('input', {bubbles: true})); const h = itemInputs()[0]; h.value = 40; h.dispatchEvent(new Event('input', {bubbles: true})); })()");
    await shot('clockout');
    await run("document.querySelector('#allocRows [data-toggle]').click()");
    await shot('clockout-open');
    await run("$('outDlg').close(); showFinished = true; render(); openLog(state.items[0])");
    await shot('log');
    await run("$('logDlg').close(); openReport()");
    await run("document.querySelector('[data-preset=this-month]').click()");
    await shot('report');
    await run("$('reportDlg').close(); openAbout()");
    await shot('about');
    await run("$('aboutDlg').close(); api('openHelp')");
    await wait(1200);
    const guide = BrowserWindow.getAllWindows().find((w) => w !== win);
    fs.writeFileSync(path.join(out, 'help.png'), (await guide.webContents.capturePage()).toPNG());
    const { writeReportPdf } = require('../src/main/main.js');
    const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    await writeReportPdf(path.join(out, 'report-all.pdf'));
    await writeReportPdf(path.join(out, 'report-month.pdf'), { from: day(new Date(new Date().getFullYear(), new Date().getMonth(), 1)), to: day(new Date()) });
    await writeReportPdf(path.join(out, 'report-finished.pdf'), { scope: 'finished' });
    app.quit();
  });
});
require('../src/main/main.js');
