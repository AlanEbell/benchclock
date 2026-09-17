'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { TimeCard, labelItems, PIECE_TYPES } = require('../src/core/timecard.js');
const { buildReportHtml } = require('../src/main/report.js');

test('the report lists current and past pieces with their time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchclock-'));
  try {
    const card = new TimeCard(dir);
    const start = new Date(Date.now() - 4 * 3600e3);
    const rings = card.addItem({ name: 'Moonstone ring', quantity: 2, separate: true, type: 'ring' });
    const [cuff] = card.addItem({ name: 'Cuff <b>& "co"', type: 'cuff', sku: 'C-1' });
    const photo = card.addPhoto(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]));
    const [pendant] = card.addItem({ name: 'Opal pendant', type: 'pendant', photo });
    card.clockIn(start);
    card.clockOut({ [rings[0].id]: 25, [rings[1].id]: 25, [pendant.id]: 25 }, new Date(start.getTime() + 2 * 3600e3));
    card.finishItems([pendant.id]);

    const html = buildReportHtml({
      items: labelItems(card.listItems()), overhead: card.overheadItem(), types: PIECE_TYPES, photosDir: card.photosDir,
    });
    const text = html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ')
      .replace(/&middot;/g, '\u00b7').replace(/&times;/g, '\u00d7').replace(/\s+/g, ' ');
    assert.match(text, /All time clocked 2h 00m/);
    assert.match(text, /Making 1h 30m.*75% of clocked time/);
    assert.match(text, /TimeOverhead 0h 30m.*25% of clocked time/);
    assert.match(text, /On the bench 3 pieces · 1h 00m/);
    assert.match(text, /Moonstone ring ×2/);           // the batch is one line ...
    assert.match(text, /Moonstone ring \(1 of 2\) In progress/); // ... with each ring beneath it
    assert.match(text, /Finished 1 piece · 0h 30m/);
    assert.match(text, /Opal pendant Pendant/);
    assert.ok(html.includes('Cuff &lt;b&gt;&amp; &quot;co&quot;'), 'names are escaped');
    assert.ok(!html.includes('Cuff <b>'), 'no raw markup from a name');
    assert.ok(html.includes(`photos/${photo}`), 'photo is shown');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
