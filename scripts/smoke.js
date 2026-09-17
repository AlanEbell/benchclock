'use strict';
// Developer tool: drives the real app through its real window-to-main bridge on a throwaway
// data folder and checks what lands on disk.   npx electron scripts/smoke.js --data-dir=/tmp/x
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, nativeImage } = require('electron');

const dataDir = (process.argv.find((a) => a.startsWith('--data-dir=')) || '').slice(11);
assert.ok(dataDir, 'pass --data-dir=<empty folder>');
fs.mkdirSync(dataDir, { recursive: true });
const picture = path.join(dataDir, 'wide-photo.png'); // 300x120: must come out square
fs.writeFileSync(picture, nativeImage.createFromBuffer(
  Buffer.from(Array(300 * 120).fill([40, 90, 200, 255]).flat()), { width: 300, height: 120 }).toPNG());
const notPicture = path.join(dataDir, 'notes.txt');
fs.writeFileSync(notPicture, 'hello');

app.on('browser-window-created', (event, win) => {
  win.webContents.once('did-finish-load', async () => {
    const run = (js) => win.webContents.executeJavaScript(`(async () => { ${js} })()`, true);
    try {
      await new Promise((r) => setTimeout(r, 600));
      const photo = await run(`return (await api('importPhotoPath', { file: ${JSON.stringify(picture)} })).photo`);
      const size = nativeImage.createFromPath(path.join(dataDir, 'photos', photo)).getSize();
      assert.deepEqual(size, { width: 120, height: 120 });
      const refused = await run(`try { await api('importPhotoPath', { file: ${JSON.stringify(notPicture)} }); return 'accepted' } catch (e) { return e.message }`);
      assert.match(refused, /Couldn't read that picture/);

      await run(`await api('addItem', { name: 'Signet ring', type: 'ring', photo: ${JSON.stringify(photo)}, quantity: 2, separate: true });
                 await api('addItem', { name: 'Hoops', type: 'earrings', quantity: 6 });`);
      const rows = await run("return [...document.querySelectorAll('#bench .row b')].map((b) => b.textContent)");
      assert.deepEqual(rows, ['Hoops', 'Signet ring'], 'same-named pieces are one closed line');
      await run("document.querySelector('#bench .row.group .toggle').click()");
      const opened = await run("return [...document.querySelectorAll('#bench .row b')].map((b) => b.textContent)");
      assert.deepEqual(opened, ['Hoops', 'Signet ring', 'Signet ring (1 of 2)', 'Signet ring (2 of 2)']);
      await run("document.querySelector('#bench .row.group input[type=checkbox]').click()");
      assert.equal(await run("return selected.size"), 2, 'ticking the group ticks every piece in it');
      await run("document.querySelector('#bench .row.group input[type=checkbox]').click()");
      const loaded = await run("const i = document.querySelector('#bench .tile.photo img'); await i.decode(); return i.naturalWidth");
      assert.equal(loaded, 120, 'photo is served to the page');

      // the same design added again later is its own group, and Finish works from the line
      await run("await api('addItem', { name: 'Signet ring', type: 'ring', quantity: 2, separate: true })");
      assert.equal(await run("return document.querySelectorAll('#bench .row.group').length"), 2, 'a later batch is a separate group');
      await run("document.querySelectorAll('#bench .row.group')[1].querySelector('[data-act=group-finish]').click(); await new Promise((r) => setTimeout(r, 300));");
      assert.equal(await run("return document.querySelectorAll('#bench .row.group').length"), 1);
      assert.equal(await run("return state.items.filter((i) => i.status === 'finished').length"), 2);
      assert.equal(await run("return !!document.querySelector('#bench .row:not(.group) [data-act=finish]')"), true, 'single lines have a Finish button');

      await run("await api('clockIn'); await openClockOut();");
      assert.equal(await run("return document.querySelectorAll('#allocRows [data-child-of]:not([hidden])').length"), 0, 'group starts closed');
      await run(`const g = document.querySelector('input[data-group]'); g.value = 50; g.dispatchEvent(new Event('input', { bubbles: true }));
                 $('outWhen').value = localInput(new Date(Date.now() + 2 * 3600e3)); $('outWhen').oninput();`);
      assert.match(await run("return $('allocTotal').textContent"), /Pieces 50%\s+\+\s+TimeOverhead 50%/);
      // opened, one piece can be changed on its own and the group's box follows
      await run(`document.querySelector('#allocRows [data-toggle]').click();
                 const one = itemInputs()[1]; one.value = 35; one.dispatchEvent(new Event('input', { bubbles: true }));`);
      assert.equal(await run("return document.querySelector('input[data-group]').value"), '60');
      await run("const one = itemInputs()[1]; one.value = 25; one.dispatchEvent(new Event('input', { bubbles: true }));");
      await run("$('outConfirm').click(); await new Promise((r) => setTimeout(r, 400));");

      const items = fs.readdirSync(path.join(dataDir, 'items')).map((f) => JSON.parse(fs.readFileSync(path.join(dataDir, 'items', f))));
      const byName = (n) => items.filter((i) => i.name === n);
      const near = (a, b) => assert.ok(Math.abs(a - b) <= 90, `${a} is not about ${b}`); // the time field only holds minutes
      const firstBatch = byName('Signet ring').filter((ring) => ring.photo === photo);
      assert.equal(firstBatch.length, 2);
      firstBatch.forEach((ring) => near(ring.total_seconds, 1800));
      byName('Signet ring').filter((ring) => !ring.photo).forEach((ring) => assert.equal(ring.total_seconds, 0)); // the later batch
      near(byName('TimeOverhead')[0].total_seconds, 3600);
      assert.equal(byName('Hoops')[0].total_seconds, 0);
      assert.equal(fs.existsSync(path.join(dataDir, 'current_session.json')), false);
      assert.equal(await run("return $('clockBtn').textContent"), 'Clock in');
      const pdf = path.join(dataDir, 'report.pdf');
      await writeReportPdf(pdf);
      const bytes = fs.readFileSync(pdf);
      assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
      assert.ok(bytes.length > 5000, 'the PDF has content');
      assert.equal(await run("return !!document.getElementById('reportBtn')"), true);
      console.log('SMOKE OK');
    } catch (error) {
      console.error('SMOKE FAILED\n', error);
      process.exitCode = 1;
    }
    app.quit();
  });
});
const { writeReportPdf } = require('../src/main/main.js');
