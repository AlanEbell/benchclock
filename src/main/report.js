'use strict';
// Builds the printable time report as one self-contained HTML page. No Electron in here,
// so it can be tested on its own; main.js turns the page into a PDF.

const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { iconSvg } = require('../renderer/icons.js');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const duration = (secs) => { const m = Math.round(secs / 60); return `${Math.floor(m / 60)}h ${pad(m % 60)}m`; };
const hours = (secs) => (secs / 3600).toFixed(2);
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function groupItems(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.batch_id || item.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()];
}

const STATUS = { not_started: 'Getting started', in_progress: 'In progress', finished: 'Finished' };

/**
 * `items` must already carry their display `label` (labelItems). `types` is PIECE_TYPES.
 * `photosDir` is where item.photo file names live.
 */
function buildReportHtml({ items, overhead, types, photosDir, generatedAt = new Date() }) {
  const typeLabel = (id) => (types.find((t) => t.id === id) || { label: 'Other' }).label;
  const picture = (item) => (item.photo ?
    `<span class="tile"><img src="${esc(pathToFileURL(path.join(photosDir, item.photo)).href)}" alt=""></span>` :
    `<span class="tile">${iconSvg(item.type)}</span>`);
  const sessions = (item) => new Set(item.time_entries.map((e) => e.session_id)).size;

  function table(list, finished) {
    if (!list.length) return '<p class="none">Nothing here yet.</p>';
    const rows = groupItems(list).map((members) => {
      const pieces = members.reduce((n, i) => n + i.quantity, 0);
      const total = members.reduce((n, i) => n + i.total_seconds, 0);
      const first = members[0];
      const dateOf = (i) => day(finished ? i.finished_at : i.started_at);
      const dates = [...new Set(members.map(dateOf).filter(Boolean))];
      const head = `<tr class="piece">
        <td class="pic">${picture(first)}</td>
        <td><b>${esc(members.length > 1 ? first.name : first.label)}</b>${pieces > 1 ? ` <span class="qty">&times;${pieces}</span>` : ''}
          <div class="sub">${[typeLabel(first.type), first.sku && `SKU ${esc(first.sku)}`, esc(first.notes)].filter(Boolean).join(' &middot; ')}</div></td>
        <td>${members.length > 1 ? '' : esc(STATUS[first.status] || first.status)}</td>
        <td>${dates.length > 1 ? `from ${dates[0]}` : (dates[0] || '&mdash;')}</td>
        <td class="num">${members.length > 1 ? '' : sessions(first)}</td>
        <td class="num"><b>${duration(total)}</b></td>
        <td class="num">${hours(total)}</td>
        <td class="num">${pieces > 1 ? duration(total / pieces) : ''}</td></tr>`;
      const each = members.length > 1 ? members.map((i) => `<tr class="member">
        <td></td><td>${esc(i.label)}</td><td>${esc(STATUS[i.status] || i.status)}</td><td>${dateOf(i) || '&mdash;'}</td>
        <td class="num">${sessions(i)}</td><td class="num">${duration(i.total_seconds)}</td><td class="num">${hours(i.total_seconds)}</td><td></td></tr>`).join('') : '';
      return `<tbody>${head}${each}</tbody>`;
    }).join('');
    return `<table><colgroup><col class="pic"><col><col class="status"><col class="date"><col class="sessions">
      <col class="time"><col class="hours"><col class="each"></colgroup><thead><tr><th></th><th>Piece</th><th>Status</th><th>${finished ? 'Finished' : 'Started'}</th>
      <th class="num">Sessions</th><th class="num">Time</th><th class="num">Hours</th><th class="num">Per piece</th></tr></thead>${rows}</table>`;
  }

  const open = items.filter((i) => i.status !== 'finished');
  const done = items.filter((i) => i.status === 'finished');
  const count = (list) => list.reduce((n, i) => n + i.quantity, 0);
  const sum = (list) => list.reduce((n, i) => n + i.total_seconds, 0);
  const making = sum(items);
  const all = making + overhead.total_seconds;
  const share = (secs) => (all ? `${Math.round(secs / all * 100)}%` : '');
  const stat = (label, value, note = '') => `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div><div class="note">${note}</div></div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>BenchClock time report</title><style>
    * { box-sizing: border-box; }
    body { font: 10.5pt/1.45 "Helvetica Neue", Helvetica, Arial, "Noto Sans", sans-serif; color: #2b2621; margin: 0; }
    h1 { font: 600 20pt Georgia, "Times New Roman", serif; margin: 0; }
    h2 { font: 600 13pt Georgia, "Times New Roman", serif; margin: 22pt 0 6pt; break-after: avoid; }
    h2 small { font: 9.5pt Helvetica, Arial, sans-serif; color: #776d62; margin-left: 6pt; }
    .made { color: #776d62; font-size: 9.5pt; margin-top: 2pt; }
    .stats { display: flex; gap: 8pt; margin-top: 14pt; }
    .stat { flex: 1; border: 1px solid #e4dccd; border-radius: 6pt; padding: 8pt 10pt; }
    .stat .label { font-size: 8pt; text-transform: uppercase; letter-spacing: .08em; color: #776d62; }
    .stat .value { font: 600 15pt Georgia, serif; }
    .stat .note { font-size: 8.5pt; color: #776d62; min-height: 10pt; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    col.pic { width: 32pt; } col.status { width: 80pt; } col.date { width: 74pt; } col.sessions { width: 54pt; }
    col.time { width: 58pt; } col.hours { width: 46pt; } col.each { width: 60pt; }
    td:nth-child(3), td:nth-child(4) { white-space: nowrap; }
    thead { display: table-header-group; }
    th { font-size: 8pt; text-transform: uppercase; letter-spacing: .06em; color: #776d62; text-align: left; font-weight: 600;
         padding: 4pt 6pt; border-bottom: 1.5px solid #2b2621; }
    td { padding: 5pt 6pt; vertical-align: middle; }
    tbody { break-inside: avoid; border-bottom: 1px solid #e4dccd; }
    .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .pic { width: 30pt; padding-right: 0; }
    .tile { display: inline-flex; width: 24pt; height: 24pt; border-radius: 5pt; background: #dcebe7; color: #1f6b62; padding: 5pt; overflow: hidden; }
    .tile:has(img) { padding: 0; }
    .tile img, .tile svg { width: 100%; height: 100%; display: block; object-fit: cover; }
    .sub { font-size: 8.5pt; color: #776d62; }
    .qty { font-size: 8.5pt; font-weight: 600; color: #a87a2a; border: 1px solid #a87a2a; border-radius: 99px; padding: 0 5pt; }
    tr.member td { font-size: 9.5pt; color: #4a433b; padding-top: 1pt; padding-bottom: 3pt; }
    tr.member td:nth-child(2) { padding-left: 14pt; }
    .none { color: #776d62; }
    .overhead { display: flex; align-items: center; gap: 10pt; border: 1px solid #e4dccd; border-radius: 6pt; padding: 8pt 10pt; break-inside: avoid; }
    .overhead .tile { background: #efe8da; color: #776d62; flex: none; }
    .overhead .grow { flex: 1; }
  </style></head><body>
  <h1>BenchClock time report</h1>
  <div class="made">Made ${esc(generatedAt.toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }))}</div>
  <div class="stats">
    ${stat('All time clocked', duration(all), `${hours(all)} hours`)}
    ${stat('Making', duration(making), share(making) && `${share(making)} of clocked time`)}
    ${stat('TimeOverhead', duration(overhead.total_seconds), share(overhead.total_seconds) && `${share(overhead.total_seconds)} of clocked time`)}
    ${stat('Pieces', `${count(open)} + ${count(done)}`, 'on the bench + finished')}
  </div>

  <h2>On the bench <small>${plural(count(open), 'piece')} &middot; ${duration(sum(open))}</small></h2>
  ${table(open, false)}

  <h2>Finished <small>${plural(count(done), 'piece')} &middot; ${duration(sum(done))}</small></h2>
  ${table(done, true)}

  <h2>Not making</h2>
  <div class="overhead"><span class="tile">${iconSvg('overhead')}</span>
    <div class="grow"><b>${esc(overhead.name)}</b><div class="sub">Clocked time that wasn't given to a piece &middot; ${plural(overhead.time_entries.length, 'session')}</div></div>
    <div class="num"><b>${duration(overhead.total_seconds)}</b><div class="sub">${hours(overhead.total_seconds)} hours</div></div></div>
  </body></html>`;
}

module.exports = { buildReportHtml };
