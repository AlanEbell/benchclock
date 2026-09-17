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

test('a report for a period counts only the time and the pieces of those days', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchclock-'));
  try {
    const card = new TimeCard(dir);
    const [ring] = card.addItem({ name: 'Signet ring', type: 'ring' });
    const [cuff] = card.addItem({ name: 'Hammered cuff', type: 'cuff' });
    const [chain] = card.addItem({ name: 'Rope chain', type: 'chain' });
    const [studs] = card.addItem({ name: 'Garnet studs', type: 'earrings' });
    const session = (y, m, d, hours, shares) => {
      card.clockIn(new Date(y, m - 1, d, 9, 0));
      card.clockOut(shares, new Date(y, m - 1, d, 9 + hours, 0));
    };
    session(2026, 8, 31, 4, { [ring.id]: 50, [chain.id]: 50 }); // the day before the week
    session(2026, 9, 7, 2, { [ring.id]: 50, [cuff.id]: 25 });   // first day of the week
    session(2026, 9, 13, 1, { [cuff.id]: 100 });                // last day of the week
    session(2026, 9, 14, 3, { [ring.id]: 100 });                // the day after
    card.finishItems([cuff.id], new Date(2026, 8, 13, 17, 0));
    card.finishItems([studs.id], new Date(2026, 8, 10, 12, 0)); // finished in the week with no time on it
    card.finishItems([chain.id], new Date(2026, 7, 31, 18, 0)); // finished before the week

    const build = (period) => buildReportHtml({
      items: labelItems(card.listItems()), overhead: card.overheadItem(), types: PIECE_TYPES, photosDir: card.photosDir, period,
    }).replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ')
      .replace(/&middot;/g, '·').replace(/&times;/g, '×').replace(/\s+/g, ' ');

    const week = build({ from: '2026-09-07', to: '2026-09-13' });
    assert.match(week, /Sep 7, 2026 – Sep 13, 2026/);
    assert.match(week, /Time clocked 3h 00m/);
    assert.match(week, /Making 2h 30m/);
    assert.match(week, /TimeOverhead 0h 30m/);
    assert.match(week, /Worked on 1 piece · 1h 00m/);
    assert.match(week, /Signet ring Ring In progress Aug 31, 2026 1 1h 00m 1\.00 6h 00m/); // this week, then to date
    assert.match(week, /Finished in this period 2 pieces · 1h 30m/);
    assert.match(week, /Hammered cuff Cuff \/ bangle Finished Sep 13, 2026 2 1h 30m/);
    assert.match(week, /Garnet studs/);
    assert.ok(!week.includes('Rope chain'), 'a piece with nothing in the period is left out');

    assert.match(build({ from: '2026-09-14' }), /From Sep 14, 2026 .*Time clocked 3h 00m/);
    assert.match(build({ to: '2026-08-31' }), /Up to Aug 31, 2026 .*Time clocked 4h 00m.*Finished in this period 1 piece · 2h 00m/);
    assert.match(build({ from: '2026-09-10', to: '2026-09-10' }), /Sep 10, 2026 Made/);
    assert.match(build({}), /All time clocked 10h 00m/);
    assert.match(build({ from: '', to: null }), /All time clocked 10h 00m/);
    assert.throws(() => build({ from: '2026-09-13', to: '2026-09-07' }), /on or before/);
    assert.throws(() => build({ from: 'last tuesday' }), /Couldn't understand the date/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a report on some of the pieces leaves TimeOverhead out and keeps hand-picked pieces', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchclock-'));
  try {
    const card = new TimeCard(dir);
    const [ring] = card.addItem({ name: 'Signet ring', type: 'ring' });
    const [cuff] = card.addItem({ name: 'Hammered cuff', type: 'cuff' });
    card.clockIn(new Date(2026, 8, 7, 9, 0));
    card.clockOut({ [ring.id]: 50 }, new Date(2026, 8, 7, 11, 0));
    const build = (options) => buildReportHtml({ types: PIECE_TYPES, photosDir: card.photosDir, ...options })
      .replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '·').replace(/\s+/g, ' ');
    const items = () => labelItems(card.listItems());

    const bench = build({ items: items(), pieces: 'Pieces on the bench' });
    assert.match(bench, /Pieces on the bench Made/);
    assert.match(bench, /Time on these pieces 1h 00m 1\.00 hours .*Sessions 1 .*Pieces 2 2 on the bench/);
    assert.ok(!/TimeOverhead|Not making|clocked time/.test(bench), 'no split of clocked time from part of the bench');
    assert.ok(!/Finished/.test(bench.replace(/Status Finished/g, '')), 'no empty Finished section');

    const week = { from: '2026-09-07', to: '2026-09-13' };
    assert.ok(!build({ items: items(), pieces: 'Pieces on the bench', period: week }).includes('Hammered cuff'));
    const picked = build({ items: items(), pieces: 'Ticked pieces', period: week, handPicked: true });
    assert.match(picked, /Ticked pieces · Sep 7, 2026 – Sep 13, 2026/);
    assert.match(picked, /Hammered cuff .* 0h 00m/, 'ticked by hand, so listed with no time');
    assert.match(build({ items: [], pieces: 'Finished pieces' }), /No pieces to report on/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
