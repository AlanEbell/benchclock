'use strict';
/*
 * BenchClock: storage and time-allocation logic for a jewelry artist's time card. No interface here.
 *
 * Everything is kept as plain JSON on disk so the data is easy to inspect, back
 * up, and hand to other tools (see DATA_FORMAT.md):
 *
 *   <data dir>/
 *     items/<item-id>.json      one file per piece (or batch of pieces)
 *     items/time-overhead.json  the catch-all for time not spent making
 *     sessions/<session>.json   one file per completed clock-in/clock-out
 *     photos/<hash>.jpg         the photo library: pictures that can stand in for a piece's icon
 *     current_session.json      present only while clocked in
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_NAME = 'BenchClock';
const SCHEMA_VERSION = 1;

const NOT_STARTED = 'not_started';
const IN_PROGRESS = 'in_progress';
const FINISHED = 'finished';
const OVERHEAD = 'overhead';

const OVERHEAD_ID = 'time-overhead';
const OVERHEAD_NAME = 'TimeOverhead';

// What a piece is. The id is what gets stored; the interface draws an icon for each.
const PIECE_TYPES = [
  { id: 'earrings', label: 'Earrings' },
  { id: 'ring', label: 'Ring' },
  { id: 'pendant', label: 'Pendant' },
  { id: 'chain', label: 'Chain' },
  { id: 'bracelet', label: 'Bracelet' },
  { id: 'cuff', label: 'Cuff / bangle' },
  { id: 'brooch', label: 'Brooch' },
  { id: 'custom', label: 'Custom' },
  { id: 'other', label: 'Other' },
];
const DEFAULT_TYPE = 'other';

const PERCENT_TOLERANCE = 0.01;

/** A user-facing problem (bad input, wrong state). Its message is shown as is. */
class TimeCardError extends Error {}

function defaultDataDir() {
  if (process.env.BENCHCLOCK_DATA_DIR) return process.env.BENCHCLOCK_DATA_DIR.replace(/^~(?=$|[\\/])/, os.homedir());
  let base;
  if (process.platform === 'win32') base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  else if (process.platform === 'darwin') base = path.join(os.homedir(), 'Library', 'Application Support');
  else base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, APP_NAME);
}

/** Local time with its UTC offset, to the second: 2026-09-17T14:05:00-04:00 */
function toIso(date) {
  const p = (n) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}` +
    `${offset < 0 ? '-' : '+'}${p(offset / 60)}:${p(offset % 60)}`;
}

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

function formatDuration(seconds) {
  const minutes = Math.round(seconds / 60);
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'piece';
}

const newId = (name) => `${slug(name)}-${crypto.randomBytes(4).toString('hex')}`;

function writeJson(file, data) {
  // Write to a temp file then rename so a crash never leaves half a file.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function refreshTotals(item) {
  const total = item.time_entries.reduce((sum, entry) => sum + entry.seconds, 0);
  item.total_seconds = round1(total);
  item.seconds_per_piece = item.quantity ? round1(total / item.quantity) : 0;
}

function asDate(when) {
  if (when === undefined || when === null || when === '') return new Date();
  const date = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(date.getTime())) throw new TimeCardError(`Couldn't understand the time '${when}'.`);
  return date;
}

/**
 * Give every item a display `label`. Pieces added together as one batch get
 * "(1 of 3)" style labels so they can be told apart in the queue and at clock-out.
 */
function labelItems(items) {
  const byBatch = new Map();
  for (const item of items) {
    const key = item.batch_id || item.id;
    byBatch.set(key, [...(byBatch.get(key) || []), item]);
  }
  for (const group of byBatch.values()) {
    group.sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
    group.forEach((item, index) => {
      item.label = group.length === 1 ? item.name : `${item.name} (${index + 1} of ${group.length})`;
    });
  }
  return items;
}

const CSV_FIELDS = [
  'item_id', 'name', 'sku', 'type', 'photo', 'batch_id', 'quantity', 'status', 'created_at', 'started_at',
  'finished_at', 'total_hours', 'total_minutes', 'minutes_per_piece', 'work_sessions', 'notes',
];

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

class TimeCard {
  constructor(dataDir) {
    this.dataDir = dataDir || defaultDataDir();
    this.itemsDir = path.join(this.dataDir, 'items');
    this.sessionsDir = path.join(this.dataDir, 'sessions');
    this.sessionFile = path.join(this.dataDir, 'current_session.json');
    fs.mkdirSync(this.itemsDir, { recursive: true });
    this.photosDir = path.join(this.dataDir, 'photos');
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    fs.mkdirSync(this.photosDir, { recursive: true });
    this.overheadItem();
  }

  // ----- items ---------------------------------------------------------

  itemPath(itemId) {
    if (!/^[\w-]+$/.test(String(itemId))) throw new TimeCardError(`No piece with id ${itemId}`);
    return path.join(this.itemsDir, `${itemId}.json`);
  }

  saveItem(item) {
    refreshTotals(item);
    writeJson(this.itemPath(item.id), item);
  }

  getItem(itemId) {
    const file = this.itemPath(itemId);
    if (!fs.existsSync(file)) throw new TimeCardError(`No piece with id ${itemId}`);
    const item = readJson(file);
    if (!item.type) item.type = DEFAULT_TYPE; // files written before pieces had these fields
    if (item.photo === undefined) item.photo = null;
    if (item.batch_id === undefined) item.batch_id = null;
    return item;
  }

  getPiece(itemId) {
    if (itemId === OVERHEAD_ID) {
      throw new TimeCardError(`${OVERHEAD_NAME} is always there - it can't be finished, renamed or deleted.`);
    }
    return this.getItem(itemId);
  }

  /** The catch-all for time not spent making. Created the first time it is needed. */
  overheadItem() {
    if (!fs.existsSync(this.itemPath(OVERHEAD_ID))) {
      this.saveItem({
        schema_version: SCHEMA_VERSION, id: OVERHEAD_ID, sequence: 0, name: OVERHEAD_NAME, sku: '',
        type: OVERHEAD, photo: null, batch_id: null, quantity: 1, status: OVERHEAD, notes: 'Time clocked in but not spent on a piece.',
        created_at: toIso(new Date()), started_at: null, finished_at: null, split_from: null,
        time_entries: [],
      });
    }
    return this.getItem(OVERHEAD_ID);
  }

  /** Every piece and batch. TimeOverhead isn't a piece; see overheadItem(). */
  listItems() {
    const items = fs.readdirSync(this.itemsDir)
      .filter((name) => name.endsWith('.json') && name !== `${OVERHEAD_ID}.json`)
      .map((name) => this.getItem(name.slice(0, -5)));
    const rank = (item) => (item.status === FINISHED ? 1 : 0);
    items.sort((a, b) => rank(a) - rank(b) ||
      a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'en', { numeric: true }) ||
      (a.sequence || 0) - (b.sequence || 0));
    return items;
  }

  /**
   * Add a piece. With quantity > 1 either one entry standing for them all is created, or
   * (separate: true) that many individual pieces sharing a `batch_id`. Every call is its
   * own batch: three rings added next month do not join the three added today.
   */
  addItem({ name, quantity = 1, sku = '', notes = '', type = DEFAULT_TYPE, photo = null, separate = false }) {
    name = String(name ?? '').trim();
    quantity = Number(quantity);
    if (!name) throw new TimeCardError('A piece needs a name.');
    if (!Number.isInteger(quantity) || quantity < 1) throw new TimeCardError('Quantity must be at least 1.');
    if (quantity > 999) throw new TimeCardError('That is more pieces than one entry can hold (999).');
    if (!PIECE_TYPES.some((t) => t.id === type)) throw new TimeCardError(`Unknown kind of piece: ${type}`);
    photo = this.checkPhoto(photo);
    const counts = separate ? Array(quantity).fill(1) : [quantity];
    const batchId = counts.length > 1 ? `batch-${crypto.randomBytes(4).toString('hex')}` : null;
    // A running number keeps same-named pieces in the order they were added.
    let sequence = Math.max(0, ...this.listItems().map((i) => i.sequence || 0));
    return counts.map((count) => {
      sequence += 1;
      const item = {
        schema_version: SCHEMA_VERSION, id: newId(name), sequence, name, sku: String(sku).trim(), type, photo,
        batch_id: batchId, quantity: count, status: NOT_STARTED, notes: String(notes).trim(), created_at: toIso(new Date()),
        started_at: null, finished_at: null, split_from: null, time_entries: [],
      };
      this.saveItem(item);
      return item;
    });
  }

  updateItem(itemId, { name, sku, notes, type, photo } = {}) {
    const item = this.getPiece(itemId);
    if (name !== undefined) {
      if (!String(name).trim()) throw new TimeCardError('A piece needs a name.');
      item.name = String(name).trim();
    }
    if (sku !== undefined) item.sku = String(sku).trim();
    if (notes !== undefined) item.notes = String(notes).trim();
    if (type !== undefined) {
      if (!PIECE_TYPES.some((t) => t.id === type)) throw new TimeCardError(`Unknown kind of piece: ${type}`);
      item.type = type;
    }
    if (photo !== undefined) item.photo = this.checkPhoto(photo);
    this.saveItem(item);
    return item;
  }

  deleteItem(itemId) {
    this.getPiece(itemId);
    fs.rmSync(this.itemPath(itemId), { force: true });
  }

  finishItems(itemIds, when) {
    const stamp = toIso(asDate(when));
    for (const itemId of itemIds) {
      const item = this.getPiece(itemId);
      if (item.status !== FINISHED) {
        item.status = FINISHED;
        item.finished_at = stamp;
        this.saveItem(item);
      }
    }
  }

  /**
   * Mark `count` pieces of a batch finished. They are split into their own
   * finished item carrying their share of the time logged so far.
   */
  finishPartOfBatch(itemId, count, when) {
    const item = this.getPiece(itemId);
    count = Number(count);
    if (item.status === FINISHED) throw new TimeCardError('That batch is already finished.');
    if (!Number.isInteger(count) || count < 1 || count > item.quantity) {
      throw new TimeCardError(`Choose between 1 and ${item.quantity} pieces.`);
    }
    if (count === item.quantity) {
      this.finishItems([itemId], when);
      return this.getItem(itemId);
    }
    const share = count / item.quantity;
    const scaled = (factor) => item.time_entries.map((e) => ({ ...e, seconds: round1(e.seconds * factor) }));
    const finished = {
      ...item, id: newId(item.name), quantity: count, status: FINISHED, finished_at: toIso(asDate(when)),
      split_from: item.id, time_entries: scaled(share),
    };
    const rest = { ...item, quantity: item.quantity - count, time_entries: scaled(1 - share) };
    this.saveItem(finished);
    this.saveItem(rest);
    return finished;
  }

  reopenItem(itemId) {
    const item = this.getPiece(itemId);
    item.status = item.time_entries.length ? IN_PROGRESS : NOT_STARTED;
    item.finished_at = null;
    this.saveItem(item);
  }

  // ----- photo library ------------------------------------------------

  /** A photo file name from the library, or null. Anything else is refused. */
  checkPhoto(photo) {
    if (photo === null || photo === undefined || photo === '') return null;
    if (!/^[0-9a-f]{16}\.jpg$/.test(photo) || !fs.existsSync(path.join(this.photosDir, photo))) {
      throw new TimeCardError("That photo isn't in the library any more.");
    }
    return photo;
  }

  /**
   * Keep a JPEG in the library and return its file name. The name comes from the
   * picture itself, so importing the same photo twice doesn't store it twice.
   */
  addPhoto(jpeg) {
    if (!Buffer.isBuffer(jpeg) || jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
      throw new TimeCardError("That file doesn't look like a picture this app can read.");
    }
    const name = `${crypto.createHash('sha256').update(jpeg).digest('hex').slice(0, 16)}.jpg`;
    const file = path.join(this.photosDir, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, jpeg);
    return name;
  }

  /** File names in the library, newest first. */
  listPhotos() {
    return fs.readdirSync(this.photosDir)
      .filter((name) => /^[0-9a-f]{16}\.jpg$/.test(name))
      .map((name) => ({ name, added: fs.statSync(path.join(this.photosDir, name)).mtimeMs }))
      .sort((a, b) => b.added - a.added)
      .map((entry) => entry.name);
  }

  /** Remove a photo from the library. Pieces that used it go back to their type's icon. */
  deletePhoto(photo) {
    photo = this.checkPhoto(photo);
    if (!photo) return;
    for (const item of this.listItems()) {
      if (item.photo === photo) {
        item.photo = null;
        this.saveItem(item);
      }
    }
    fs.rmSync(path.join(this.photosDir, photo), { force: true });
  }

  // ----- clocking in and out -------------------------------------------

  currentSession() {
    return fs.existsSync(this.sessionFile) ? readJson(this.sessionFile) : null;
  }

  clockIn(when) {
    if (this.currentSession()) throw new TimeCardError('You are already clocked in.');
    const session = { id: crypto.randomBytes(6).toString('hex'), clock_in: toIso(asDate(when)) };
    writeJson(this.sessionFile, session);
    return session;
  }

  /** Pieces time can be assigned to: everything still open, plus anything finished during this session. */
  clockOutCandidates() {
    const session = this.currentSession();
    if (!session) return [];
    const start = new Date(session.clock_in);
    return this.listItems().filter((i) => i.status !== FINISHED || new Date(i.finished_at) >= start);
  }

  cancelClockIn() {
    fs.rmSync(this.sessionFile, { force: true });
  }

  /**
   * Close the session, splitting its length across pieces. `allocations` maps
   * item id -> percent of the session. Whatever is left over, up to the full
   * 100%, goes to TimeOverhead.
   */
  clockOut(allocations = {}, when) {
    const session = this.currentSession();
    if (!session) throw new TimeCardError('You are not clocked in.');
    const start = new Date(session.clock_in);
    const end = asDate(when);
    if (end <= start) throw new TimeCardError('Clock-out time must be after clock-in time.');

    const shares = new Map();
    for (const [itemId, value] of Object.entries(allocations)) {
      const percent = Number(value);
      if (!Number.isFinite(percent)) throw new TimeCardError('Percentages need to be numbers.');
      if (percent < 0) throw new TimeCardError("Percentages can't be negative.");
      if (percent !== 0) shares.set(itemId, percent);
    }
    const total = [...shares.values()].reduce((a, b) => a + b, 0);
    if (total > 100 + PERCENT_TOLERANCE) {
      throw new TimeCardError(`Percentages add up to ${round2(total)}%, which is more than the whole session.`);
    }
    const overhead = round2((shares.get(OVERHEAD_ID) || 0) + Math.max(100 - total, 0));
    shares.delete(OVERHEAD_ID);
    if (overhead >= PERCENT_TOLERANCE) shares.set(OVERHEAD_ID, overhead);

    const items = new Map([...shares.keys()].map((id) => [id, this.getItem(id)])); // fails before anything is saved
    const duration = (end - start) / 1000;
    for (const [itemId, percent] of shares) {
      const item = items.get(itemId);
      item.time_entries.push({
        session_id: session.id, clock_in: session.clock_in, clock_out: toIso(end),
        percent: round2(percent), seconds: round1(duration * percent / 100),
      });
      if (item.status === NOT_STARTED) item.status = IN_PROGRESS;
      if (!item.started_at) item.started_at = session.clock_in;
      this.saveItem(item);
    }

    const record = {
      ...session, clock_out: toIso(end), seconds: round1(duration),
      allocations: [...shares].map(([itemId, percent]) => ({
        item_id: itemId, name: items.get(itemId).name, quantity: items.get(itemId).quantity, percent: round2(percent),
      })),
    };
    const stamp = toIso(start).slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    writeJson(path.join(this.sessionsDir, `${stamp}-${session.id}.json`), record);
    fs.rmSync(this.sessionFile);
    return record;
  }

  // ----- export --------------------------------------------------------

  /** Write `items` as CSV; by default every piece followed by TimeOverhead. Returns the row count. */
  exportCsv(file, items) {
    items = items || [...this.listItems(), this.overheadItem()];
    const rows = items.map((item) => [
      item.id, item.name, item.sku, item.type, item.photo || '', item.batch_id || '', item.quantity, item.status, item.created_at,
      item.started_at || '', item.finished_at || '', round2(item.total_seconds / 3600),
      round1(item.total_seconds / 60), round1(item.seconds_per_piece / 60),
      new Set(item.time_entries.map((e) => e.session_id)).size, item.notes,
    ]);
    const text = [CSV_FIELDS, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
    fs.writeFileSync(file, text, 'utf8');
    return rows.length;
  }
}

module.exports = {
  TimeCard, TimeCardError, labelItems, formatDuration, toIso, defaultDataDir,
  NOT_STARTED, IN_PROGRESS, FINISHED, OVERHEAD, OVERHEAD_ID, OVERHEAD_NAME,
  PIECE_TYPES, DEFAULT_TYPE, CSV_FIELDS, SCHEMA_VERSION,
};
