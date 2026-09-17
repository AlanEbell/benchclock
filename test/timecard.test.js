'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach, afterEach } = require('node:test');

const {
  TimeCard, TimeCardError, labelItems, FINISHED, IN_PROGRESS, NOT_STARTED, OVERHEAD_ID,
} = require('../src/core/timecard.js');

const HOUR = 3600 * 1000;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
let dir, card, start;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchclock-'));
  card = new TimeCard(dir);
  start = new Date(Math.floor(Date.now() / 1000) * 1000 - 2 * HOUR);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const after = (hours) => new Date(start.getTime() + hours * HOUR);
const itemFiles = () => fs.readdirSync(path.join(dir, 'items'));

test('batch versus separate pieces', () => {
  const [batch] = card.addItem({ name: 'Hoop earrings', quantity: 6, type: 'earrings' });
  const singles = card.addItem({ name: 'Moonstone ring', quantity: 3, separate: true, type: 'ring' });
  assert.equal(batch.quantity, 6);
  assert.deepEqual(singles.map((s) => s.quantity), [1, 1, 1]);
  assert.equal(new Set(singles.map((s) => s.id)).size, 3);
  assert.equal(itemFiles().length, 5); // 4 + TimeOverhead
  assert.deepEqual(labelItems(card.listItems()).map((i) => i.label), [
    'Hoop earrings', 'Moonstone ring (1 of 3)', 'Moonstone ring (2 of 3)', 'Moonstone ring (3 of 3)']);
  assert.equal(batch.batch_id, null);
  assert.equal(new Set(singles.map((s) => s.batch_id)).size, 1);
});

test('pieces added later are a different batch, even with the same name', () => {
  const first = card.addItem({ name: 'Moonstone ring', quantity: 3, separate: true });
  const later = card.addItem({ name: 'Moonstone ring', quantity: 2, separate: true });
  const [single] = card.addItem({ name: 'Moonstone ring' });
  assert.notEqual(first[0].batch_id, later[0].batch_id);
  assert.equal(single.batch_id, null);
  const labels = Object.fromEntries(labelItems(card.listItems()).map((i) => [i.id, i.label]));
  assert.deepEqual(first.map((i) => labels[i.id]), ['Moonstone ring (1 of 3)', 'Moonstone ring (2 of 3)', 'Moonstone ring (3 of 3)']);
  assert.deepEqual(later.map((i) => labels[i.id]), ['Moonstone ring (1 of 2)', 'Moonstone ring (2 of 2)']);
  assert.equal(labels[single.id], 'Moonstone ring');
  card.finishItems([first[0].id]); // numbering doesn't shift when one is finished
  const after = Object.fromEntries(labelItems(card.listItems()).map((i) => [i.id, i.label]));
  assert.equal(after[first[1].id], 'Moonstone ring (2 of 3)');
});

test('names sort the way people count', () => {
  for (const name of ['Piece 10', 'Piece 2', 'piece 1']) card.addItem({ name });
  assert.deepEqual(card.listItems().map((i) => i.name), ['piece 1', 'Piece 2', 'Piece 10']);
});

test('bad pieces are refused', () => {
  for (const bad of [{ name: '  ' }, { name: 'Ring', quantity: 0 }, { name: 'Ring', quantity: 2.5 },
    { name: 'Ring', type: 'spaceship' }, { name: 'Ring', photo: '../../etc/passwd' }]) {
    assert.throws(() => card.addItem(bad), TimeCardError);
  }
  assert.throws(() => card.getItem('../current_session'), TimeCardError);
});

test('clock out splits time by percent', () => {
  const [ring] = card.addItem({ name: 'Ring' });
  const [hoops] = card.addItem({ name: 'Hoops', quantity: 4 });
  const [idle] = card.addItem({ name: 'Untouched' });
  card.clockIn(start);
  card.clockOut({ [ring.id]: 25, [hoops.id]: 75 }, after(2));
  assert.equal(card.getItem(ring.id).total_seconds, 1800);
  assert.equal(card.getItem(hoops.id).total_seconds, 5400);
  assert.equal(card.getItem(hoops.id).seconds_per_piece, 1350);
  assert.equal(card.getItem(ring.id).status, IN_PROGRESS);
  assert.equal(card.getItem(idle.id).status, NOT_STARTED);
  assert.equal(card.currentSession(), null);
  assert.equal(fs.readdirSync(path.join(dir, 'sessions')).length, 1);
});

test('TimeOverhead exists from the start and is not a piece', () => {
  const overhead = card.overheadItem();
  assert.deepEqual([overhead.name, overhead.total_seconds], ['TimeOverhead', 0]);
  assert.ok(itemFiles().includes('time-overhead.json'));
  assert.deepEqual(card.listItems(), []);
  for (const change of [(i) => card.deleteItem(i), (i) => card.reopenItem(i), (i) => card.finishItems([i]),
    (i) => card.updateItem(i, { name: 'x' }), (i) => card.finishPartOfBatch(i, 1)]) {
    assert.throws(() => change(OVERHEAD_ID), TimeCardError);
  }
});

test('unassigned percent goes to TimeOverhead', () => {
  const [ring] = card.addItem({ name: 'Ring' });
  card.clockIn(start);
  const record = card.clockOut({ [ring.id]: 80 }, after(2));
  assert.equal(card.getItem(ring.id).total_seconds, 5760);
  assert.equal(card.overheadItem().total_seconds, 1440);
  assert.deepEqual(record.allocations.map((a) => [a.name, a.percent]), [['Ring', 80], ['TimeOverhead', 20]]);
});

test('a whole session can be overhead, and a full one adds none', () => {
  const [ring] = card.addItem({ name: 'Ring' });
  card.clockIn(start);
  card.clockOut({}, after(1));
  assert.equal(card.overheadItem().total_seconds, 3600);
  card.clockIn(after(1));
  card.clockOut({ [ring.id]: 100 }, after(2));
  assert.equal(card.overheadItem().time_entries.length, 1);
});

test('impossible clock-outs are refused and leave the session running', () => {
  const [ring] = card.addItem({ name: 'Ring' });
  card.clockIn(start);
  for (const bad of [{ [ring.id]: 120 }, { [ring.id]: -5 }, { [ring.id]: 'lots' }, { 'no-such-piece': 50 }]) {
    assert.throws(() => card.clockOut(bad), TimeCardError);
  }
  assert.throws(() => card.clockOut({}, new Date(start.getTime() - HOUR)), TimeCardError);
  assert.throws(() => card.clockIn(), TimeCardError); // already clocked in
  assert.notEqual(card.currentSession(), null);
  assert.equal(card.getItem(ring.id).time_entries.length, 0);
  assert.equal(card.overheadItem().time_entries.length, 0);
});

test('thirds add up', () => {
  const ids = card.addItem({ name: 'Ring', quantity: 3, separate: true }).map((i) => i.id);
  card.clockIn(start);
  card.clockOut({ [ids[0]]: 33.33, [ids[1]]: 33.33, [ids[2]]: 33.34 }, after(1));
  const total = ids.reduce((sum, id) => sum + card.getItem(id).total_seconds, 0);
  assert.ok(Math.abs(total - 3600) < 0.5);
  assert.equal(card.overheadItem().time_entries.length, 0);
});

test('a piece finished mid-session can still get time', () => {
  const [ring] = card.addItem({ name: 'Ring' });
  const [old] = card.addItem({ name: 'Old pendant' });
  card.finishItems([old.id], new Date(start.getTime() - 24 * HOUR));
  card.clockIn(start);
  card.finishItems([ring.id]);
  assert.deepEqual(card.clockOutCandidates().map((c) => c.id), [ring.id]);
  card.clockOut({ [ring.id]: 100 });
  assert.equal(card.getItem(ring.id).status, FINISHED); // logging time doesn't reopen it
  assert.ok(card.getItem(ring.id).total_seconds > 0);
});

test('finishing part of a batch carries its share of the time', () => {
  const [hoops] = card.addItem({ name: 'Hoops', quantity: 4, type: 'earrings' });
  card.clockIn(start);
  card.clockOut({ [hoops.id]: 100 }, after(2));
  const done = card.finishPartOfBatch(hoops.id, 1);
  const rest = card.getItem(hoops.id);
  assert.deepEqual([done.quantity, done.status, done.total_seconds, done.type], [1, FINISHED, 1800, 'earrings']);
  assert.deepEqual([rest.quantity, rest.status, rest.total_seconds], [3, IN_PROGRESS, 5400]);
  assert.equal(done.split_from, hoops.id);
  assert.throws(() => card.finishPartOfBatch(hoops.id, 9), TimeCardError);
});

test('reopen, edit and delete', () => {
  const [ring] = card.addItem({ name: 'Ring' });
  card.finishItems([ring.id]);
  card.reopenItem(ring.id);
  assert.equal(card.getItem(ring.id).status, NOT_STARTED);
  card.updateItem(ring.id, { name: ' Signet ring ', type: 'ring', notes: 'Commission' });
  assert.deepEqual([card.getItem(ring.id).name, card.getItem(ring.id).type], ['Signet ring', 'ring']);
  card.deleteItem(ring.id);
  assert.deepEqual(card.listItems(), []);
});

test('the photo library', () => {
  const photo = card.addPhoto(JPEG);
  assert.equal(card.addPhoto(JPEG), photo); // the same picture is only kept once
  assert.deepEqual(card.listPhotos(), [photo]);
  assert.throws(() => card.addPhoto(Buffer.from('not a picture')), TimeCardError);
  const [ring] = card.addItem({ name: 'Ring', type: 'ring', photo });
  assert.equal(card.getItem(ring.id).photo, photo);
  card.deletePhoto(photo);
  assert.equal(card.getItem(ring.id).photo, null); // falls back to the ring icon
  assert.deepEqual(card.listPhotos(), []);
});

test('files written by the earlier Python version still load', () => {
  const old = { schema_version: 1, id: 'cuff-0a1b2c3d', sequence: 1, name: 'Cuff', sku: '', quantity: 1,
    status: 'not_started', notes: '', created_at: '2026-09-17T13:59:49-04:00', started_at: null,
    finished_at: null, split_from: null, time_entries: [], total_seconds: 0, seconds_per_piece: 0 };
  fs.writeFileSync(path.join(dir, 'items', 'cuff-0a1b2c3d.json'), JSON.stringify(old));
  const [cuff] = card.listItems();
  assert.deepEqual([cuff.name, cuff.type, cuff.photo, cuff.batch_id], ['Cuff', 'other', null, null]);
});

test('CSV export', () => {
  const [hoops] = card.addItem({ name: 'Hoops, "large"', quantity: 2, sku: 'H-1', type: 'earrings' });
  card.clockIn(start);
  card.clockOut({ [hoops.id]: 100 }, after(1.5));
  const out = path.join(dir, 'out.csv');
  assert.equal(card.exportCsv(out), 2);
  const [header, row, overhead] = fs.readFileSync(out, 'utf8').trim().split('\r\n');
  assert.ok(header.startsWith('item_id,name,sku,type,photo,batch_id,quantity,status'));
  assert.ok(row.includes('"Hoops, ""large""",H-1,earrings,,,2,in_progress'));
  assert.ok(row.includes(',1.5,90,45,1,'));
  assert.ok(overhead.startsWith('time-overhead,TimeOverhead,,overhead,,,1,overhead'));
});

test('timestamps carry the local UTC offset', () => {
  card.clockIn(start);
  assert.match(card.currentSession().clock_in, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  assert.equal(new Date(card.currentSession().clock_in).getTime(), start.getTime());
});

test('narrowing to a period keeps whole-life totals and leaves all time alone', () => {
  const { checkPeriod, narrowItems } = require('../src/core/timecard.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchclock-'));
  try {
    const card = new TimeCard(dir);
    const [hoops] = card.addItem({ name: 'Hoops', quantity: 4 });
    card.addItem({ name: 'Untouched' });
    card.clockIn(new Date(2026, 8, 1, 23, 0));
    card.clockOut({ [hoops.id]: 100 }, new Date(2026, 8, 2, 1, 0)); // past midnight: counts on the 1st
    card.clockIn(new Date(2026, 8, 5, 9, 0));
    card.clockOut({ [hoops.id]: 100 }, new Date(2026, 8, 5, 10, 0));

    assert.equal(narrowItems(card.listItems(), checkPeriod({})).length, 2, 'all time drops nothing');
    const [first, ...rest] = narrowItems(card.listItems(), checkPeriod({ from: '2026-09-01', to: '2026-09-01' }));
    assert.equal(rest.length, 0);
    assert.deepEqual([first.total_seconds, first.seconds_per_piece, first.all_seconds], [7200, 1800, 10800]);
    assert.equal(narrowItems(card.listItems(), checkPeriod({ from: '2026-09-02', to: '2026-09-04' })).length, 0);
    assert.equal(narrowItems(card.listItems(), checkPeriod({ from: '2026-09-02', to: '2026-09-04' }), true).length, 2, 'hand-picked pieces stay');

    const out = path.join(dir, 'week.csv');
    card.exportCsv(out, narrowItems(card.listItems(), checkPeriod({ from: '2026-09-05' })));
    const [header, row] = fs.readFileSync(out, 'utf8').trim().split('\r\n').map((line) => line.split(','));
    assert.equal(row[header.indexOf('total_hours')], '1');
    assert.equal(row[header.indexOf('work_sessions')], '1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
