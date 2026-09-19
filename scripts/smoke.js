'use strict';
// Developer tool: drives the real app through its real window-to-main bridge on a throwaway
// data folder and checks what lands on disk.   npx electron scripts/smoke.js --data-dir=/tmp/x
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, nativeImage, BrowserWindow, Menu } = require('electron');

const dataDir = (process.argv.find((a) => a.startsWith('--data-dir=')) || '').slice(11);
assert.ok(dataDir, 'pass --data-dir=<empty folder>');
fs.mkdirSync(dataDir, { recursive: true });
const picture = path.join(dataDir, 'wide-photo.png'); // 300x120: must come out square
fs.writeFileSync(picture, nativeImage.createFromBuffer(
  Buffer.from(Array(300 * 120).fill([40, 90, 200, 255]).flat()), { width: 300, height: 120 }).toPNG());
const notPicture = path.join(dataDir, 'notes.txt');
fs.writeFileSync(notPicture, 'hello');

let started = false;
app.on('browser-window-created', (event, win) => {
  if (started) return; // only the app's own window; the report printer and the guide come later
  started = true;
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
      // time put on by hand: from the Edit menu, on whatever is ticked
      const ringId = firstBatch[0].id;
      await run(`selected.add(${JSON.stringify(ringId)}); render();`);
      win.webContents.send('menu', 'adjust');
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(await run("return $('adjustDlg').open && document.querySelectorAll('#adjustRows input:checked').length"), 1, 'the ticked piece is chosen');
      assert.equal(await run("return $('adjShare').hidden"), true, 'one piece: nothing to share');
      await run("$('adjHours').value = 1; $('adjMins').value = 0; $('adjNote').value = 'before BenchClock'; $('adjWhen').value = '2000-06-15'; updateAdjust();");
      assert.match(await run("return $('adjustSummary').textContent"), /Signet ring \(\d of 2\): 0h 30m \u2192 1h 30m/);
      await run("$('adjustSave').click(); await new Promise((r) => setTimeout(r, 400));");
      const ring = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'items', `${ringId}.json`)));
      near(ring().total_seconds, 5400);
      const entry = ring().time_entries.at(-1);
      assert.deepEqual([entry.kind, entry.seconds, entry.note, entry.clock_in.slice(0, 10)], ['adjustment', 3600, 'before BenchClock', '2000-06-15']);
      assert.equal(await run("return $('adjustDlg').open"), false);
      // taking off more than there is waits; the log shows the adjustment; TimeOverhead can be adjusted too
      await run("document.querySelector(`#bench [data-id=${JSON.stringify(" + JSON.stringify(ringId) + ")}] [data-act=log]`).click();");
      assert.match(await run("return $('logBody').textContent"), /Adjustment: before BenchClock/);
      await run("$('logAdjust').click(); await new Promise((r) => setTimeout(r, 200));");
      assert.equal(await run("return $('adjustDlg').open && !$('logDlg').open"), true, 'the log hands over to the adjust box');
      await run("document.querySelector('input[name=adjDir][value=off]').checked = true; $('adjHours').value = 2; $('adjMins').value = 0; $('adjWhen').value = '2000-06-16'; updateAdjust();");
      assert.equal(await run("return $('adjustSave').disabled"), true, 'more than the piece has');
      assert.match(await run("return $('adjustSummary').textContent"), /can't come off/);
      await run("$('adjHours').value = 1; updateAdjust(); $('adjustSave').click(); await new Promise((r) => setTimeout(r, 400));");
      near(ring().total_seconds, 1800);
      await run("selected.clear(); render(); await api('adjustTime', { ids: [state.overhead.id], minutes: 5, when: '2000-06-15T12:00' });");
      assert.equal(ring().time_entries.length, 3);
      near(byName('TimeOverhead')[0].total_seconds + 300, JSON.parse(fs.readFileSync(path.join(dataDir, 'items', 'time-overhead.json'))).total_seconds);
      await run("await api('adjustTime', { ids: [state.overhead.id], minutes: -5, when: '2000-06-15T12:00' });");
      const editMenu = Menu.getApplicationMenu().items.find((item) => item.label === '&Edit').submenu.items.map((item) => item.label);
      assert.ok(editMenu.includes('Adjust time\u2026'), 'Edit menu has Adjust time');

      const pdf = path.join(dataDir, 'report.pdf');
      await writeReportPdf(pdf);
      const bytes = fs.readFileSync(pdf);
      assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
      assert.ok(bytes.length > 5000, 'the PDF has content');

      // the report box: which pieces, which days
      const today = new Date();
      const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      await run("$('reportBtn').click(); await new Promise((r) => setTimeout(r, 300));");
      assert.equal(await run("return $('reportDlg').open && document.querySelector('#reportScopes [data-scope=ticked]').disabled"), true, 'nothing ticked yet');
      await run("document.querySelector('[data-preset=this-month]').click(); await new Promise((r) => setTimeout(r, 300));");
      assert.equal(await run("return $('repFrom').value"), ymd(new Date(today.getFullYear(), today.getMonth(), 1)));
      assert.equal(await run("return $('repTo').value"), ymd(new Date(today.getFullYear(), today.getMonth() + 1, 0)));
      assert.match(await run("return $('reportSummary').textContent"), /4 pieces, 1h 00m on them and 1h 00m of TimeOverhead, in 1 session/); // two rings with time, two finished today
      await run("document.querySelector('[data-scope=finished]').click(); await new Promise((r) => setTimeout(r, 300));");
      assert.match(await run("return $('reportSummary').textContent"), /2 pieces, 0h 00m on them, in 0 sessions/); // finished today, no time
      await run("$('repFrom').value = '2001-01-01'; $('repTo').value = '2001-01-31'; $('repFrom').oninput(); await new Promise((r) => setTimeout(r, 300));");
      assert.match(await run("return $('reportSummary').textContent"), /nothing to report/);
      assert.equal(await run("return $('reportSave').disabled && $('reportCsv').disabled"), true);
      await run("$('repTo').value = '2000-01-01'; $('repTo').oninput(); await new Promise((r) => setTimeout(r, 100));");
      assert.match(await run("return $('reportSummary').textContent"), /on or before/);
      await run("$('reportDlg').close()");
      // ticks work on finished pieces too, and the box opens on them
      await run("showFinished = true; render(); document.querySelector('#finished input[type=checkbox]').click();");
      assert.equal(await run("return selected.size"), 2);
      assert.equal(await run("return $('finishBtn').hidden"), true, 'nothing ticked is on the bench');
      await run("$('reportBtn').click(); await new Promise((r) => setTimeout(r, 300));");
      assert.equal(await run("return document.querySelector('[data-scope=ticked]').getAttribute('aria-pressed')"), 'true');
      const tickedIds = await run("return [...selected]");
      await run("$('reportDlg').close(); $('clearSel').click();");
      assert.equal(await run("return selected.size"), 0);

      const month = { from: ymd(new Date(today.getFullYear(), today.getMonth(), 1)), to: ymd(today) };
      for (const [name, choice] of [['month', month], ['ticked', { scope: 'ticked', ids: tickedIds, ...month }], ['bench', { scope: 'bench' }]]) {
        const file = path.join(dataDir, `report-${name}.pdf`);
        await writeReportPdf(file, choice);
        assert.equal(fs.readFileSync(file).subarray(0, 5).toString(), '%PDF-', `${name} report`);
      }
      const preview = await run(`return await api('exportPreview', ${JSON.stringify({ scope: 'bench', ...month })})`);
      assert.deepEqual([preview.pieces, preview.sessions, preview.overhead], [2, 1, 0], 'only pieces with time in the month, no TimeOverhead');
      assert.match(await run("try { await api('exportPreview', { from: 'soon' }); return 'accepted' } catch (e) { return e.message }"), /Couldn't understand the date/);

      // the menu bar, the about box and the guide
      const menus = Menu.getApplicationMenu().items.map((item) => item.label.replace('&', ''));
      for (const label of ['File', 'Edit', 'View', 'Help']) assert.ok(menus.includes(label), `${label} menu`);
      const helpMenu = Menu.getApplicationMenu().items.find((item) => item.label === '&Help').submenu.items.map((item) => item.label);
      assert.deepEqual(helpMenu.filter(Boolean), process.platform === 'darwin' ? ['BenchClock Help'] : ['BenchClock Help', 'About BenchClock']);
      win.webContents.send('menu', 'about');
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(await run("return $('aboutDlg').open && $('aboutVersion').textContent"), `Version ${require('../package.json').version}`);
      win.webContents.send('menu', 'report'); // ignored while a box is open
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(await run("return $('reportDlg').open"), false);
      await run("$('aboutHelp').click(); await new Promise((r) => setTimeout(r, 1200));");
      const guide = BrowserWindow.getAllWindows().find((w) => w !== win);
      assert.ok(guide, 'the guide opens in its own window');
      assert.equal(guide.getTitle(), 'BenchClock Help');
      assert.match(guide.webContents.getURL(), /help\.html$/);
      await run("await api('openHelp'); await new Promise((r) => setTimeout(r, 300));");
      assert.equal(BrowserWindow.getAllWindows().length, 2, 'asking again reuses the window');

      // the calculators: their own window, arithmetic loaded, a ring blank worked out
      const toolsMenu = Menu.getApplicationMenu().items.find((item) => item.label === '&Tools').submenu.items.map((item) => item.label);
      assert.deepEqual(toolsMenu, ['Calculators\u2026']);
      await run("await api('openCalculators'); await new Promise((r) => setTimeout(r, 1200));");
      const calcWin = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'BenchClock Calculators');
      assert.ok(calcWin, 'the calculators open in their own window');
      const inCalc = (js) => calcWin.webContents.executeJavaScript(`(async () => { ${js} })()`, true);
      assert.equal(await inCalc('return typeof calc.blankLength'), 'function');
      await inCalc("$('ringSize').value = '7'; $('ringThick').value = '1.5'; $('ringAllow').value = '1.5'; recalc();");
      assert.match(await inCalc("return $('ringOut').textContent"), /Cut the stock to60\.49 mm/); // π × (17.28 + 1.5) + 1.5
      fs.writeFileSync(path.join(dataDir, 'calculators.png'), (await calcWin.webContents.capturePage()).toPNG());
      assert.match(await inCalc("return $('ringOut').textContent"), /UK and AustraliaN½/);
      assert.equal(await inCalc("return $('ringChart').querySelectorAll('tr.now').length"), 1, 'the chart marks the size');
      await inCalc("document.querySelector('nav [data-panel=gauge]').click(); $('gGauge').value = '18'; recalc();");
      assert.match(await inCalc("return $('gOut').textContent"), /18 gauge is1\.024 mm/);
      assert.equal(await inCalc("return $('gaugeChart').querySelectorAll('tr[data-g]').length"), 37);
      assert.equal(await inCalc("return $('ring').hidden && !$('gauge').hidden"), true);
      await inCalc("document.querySelector('nav [data-panel=weight]').click(); $('wShape').value = 'sheet'; $('wLength').value = 50; $('wWidth').value = 20; $('wThick').value = 1; $('wMetal').value = 'sterling'; recalc();");
      assert.match(await inCalc("return $('wOut').textContent"), /Weight10\.36 g/);
      await new Promise((r) => setTimeout(r, 200));
      fs.writeFileSync(path.join(dataDir, 'calculators-weight.png'), (await calcWin.webContents.capturePage()).toPNG());
      await run("await api('openCalculators'); await new Promise((r) => setTimeout(r, 300));");
      assert.equal(BrowserWindow.getAllWindows().length, 3, 'asking again reuses the calculators window');
      console.log('SMOKE OK');
    } catch (error) {
      console.error('SMOKE FAILED\n', error);
      process.exitCode = 1;
    }
    app.quit();
  });
});
const { writeReportPdf } = require('../src/main/main.js');
