'use strict';
/* global iconSvg */
// The window. It keeps no data of its own: every action goes to the main process,
// which answers with the whole current state, and the page is redrawn from that.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let state = { items: [], overhead: null, session: null, clockOutIds: [], photos: [], types: [] };
let clockSkew = 0; // main process clock minus page clock, ms
const selected = new Set();
let showFinished = false;

// ---- helpers -----------------------------------------------------------

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 4500);
}

async function api(method, payload) {
  const reply = await window.timecard.call(method, payload);
  if (!reply.ok) {
    toast(reply.error);
    throw new Error(reply.error);
  }
  state = reply.state;
  clockSkew = new Date(state.now) - Date.now();
  render();
  return reply.result;
}

const pad = (n) => String(n).padStart(2, '0');
const fmtDur = (secs) => { const m = Math.round(secs / 60); return `${Math.floor(m / 60)}h ${pad(m % 60)}m`; };
const fmtClock = (secs) => {
  secs = Math.max(0, Math.floor(secs));
  return `${Math.floor(secs / 3600)}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}`;
};
const fmtWhen = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const localInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const pieces = (n) => `${n} piece${n === 1 ? '' : 's'}`;
const round2 = (n) => Math.round(n * 100) / 100;
const photoUrl = (name) => `bench-photo://library/${encodeURIComponent(name)}`;
const findItem = (id) => (id === state.overhead.id ? state.overhead : state.items.find((i) => i.id === id));

function tile(item, extra = '') {
  if (item.photo) return `<span class="tile photo ${extra}"><img src="${photoUrl(item.photo)}" alt=""></span>`;
  return `<span class="tile ${extra}">${iconSvg(item.type)}</span>`;
}

/** A yes/no question in the app's own style. Resolves true for yes. */
function ask(title, text, yesLabel) {
  $('askTitle').textContent = title;
  $('askText').textContent = text;
  $('askYes').textContent = yesLabel;
  $('askDlg').showModal();
  $('askNo').focus();
  return new Promise((resolve) => {
    const done = (answer) => { $('askDlg').close(); resolve(answer); };
    $('askYes').onclick = () => done(true);
    $('askNo').onclick = () => done(false);
    $('askDlg').oncancel = () => resolve(false);
  });
}

function wireStepper(input, down, up, max = () => 999) {
  const clamp = (n) => Math.min(Math.max(Number.isFinite(n) ? n : 1, 1), max());
  const step = (change) => {
    input.value = clamp((parseInt(input.value, 10) || 0) + change);
    input.dispatchEvent(new Event('input'));
  };
  down.onclick = () => step(-1);
  up.onclick = () => step(1);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowUp') { ev.preventDefault(); step(1); }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); step(-1); }
  });
  input.addEventListener('blur', () => { input.value = clamp(parseInt(input.value, 10)); });
}

// ---- main page ---------------------------------------------------------

function tick() {
  if (!state.session) return;
  $('timer').textContent = fmtClock((Date.now() + clockSkew - new Date(state.session.clock_in)) / 1000);
}
setInterval(tick, 1000);

function rowHtml(item) {
  const finished = item.status === 'finished';
  const qty = item.quantity > 1 ? `<span class="qty">&times;${item.quantity}</span>` : '';
  const each = item.quantity > 1 ? `<small>${fmtDur(item.seconds_per_piece)} each</small>` : '';
  const meta = [item.sku && `SKU ${esc(item.sku)}`, finished && `finished ${fmtWhen(item.finished_at)}`, esc(item.notes)]
    .filter(Boolean).join(' &middot; ');
  const check = finished ? '' :
    `<input type="checkbox" data-act="select" aria-label="Select ${esc(item.label)}" ${selected.has(item.id) ? 'checked' : ''}>`;
  const actions = finished ? '<button class="quiet" data-act="reopen">Reopen</button>' :
    (item.quantity > 1 ? '<button class="quiet" data-act="part">Finish some</button>' : '');
  return `<div class="row ${selected.has(item.id) ? 'selected' : ''}" data-id="${esc(item.id)}">
    ${check}${tile(item)}
    <div class="name"><b>${esc(item.label)}</b>${qty}<div class="meta">${meta}</div></div>
    <div class="time">${fmtDur(item.total_seconds)}${each}</div>
    <div class="acts">${actions}<button class="quiet" data-act="log">Log</button><button class="quiet" data-act="edit">Edit</button></div>
  </div>`;
}

function render() {
  const session = state.session;
  $('clock').classList.toggle('on', !!session);
  $('clockState').textContent = session ? 'Clocked in' : 'Clocked out';
  $('clockBtn').textContent = session ? 'Clock out' : 'Clock in';
  $('cancelBtn').hidden = !session;
  $('since').textContent = session ? `Since ${fmtWhen(session.clock_in)}` : 'Clock in when you sit down at the bench.';
  if (session) tick(); else $('timer').textContent = '0:00:00';

  const open = state.items.filter((i) => i.status !== 'finished');
  const done = state.items.filter((i) => i.status === 'finished');
  for (const id of [...selected]) if (!open.some((i) => i.id === id)) selected.delete(id);

  const groups = [['in_progress', 'In progress'], ['not_started', 'Getting started']];
  $('bench').innerHTML = open.length ? groups.map(([status, title]) => {
    const rows = open.filter((i) => i.status === status);
    return rows.length ? `<div class="group-title">${title}</div>${rows.map(rowHtml).join('')}` : '';
  }).join('') : '<div class="empty">Nothing on the bench yet. Add a piece to get started.</div>';
  const openCount = open.reduce((n, i) => n + i.quantity, 0);
  $('benchCount').textContent = open.length ? pieces(openCount) : '';
  $('finishBtn').hidden = !selected.size;
  $('selCount').textContent = selected.size ? `${selected.size} selected` : '';

  const overhead = state.overhead;
  $('overhead').innerHTML = `<div class="row" data-id="${esc(overhead.id)}">
    <span class="tile grey">${iconSvg('overhead')}</span>
    <div class="name"><b>${esc(overhead.name)}</b>
      <div class="meta">Everything besides making. Gets whatever part of a session you don't give to a piece.</div></div>
    <div class="time">${fmtDur(overhead.total_seconds)}</div>
    <div class="acts"><button class="quiet" data-act="log">Log</button></div></div>`;

  $('finCount').textContent = done.length ? pieces(done.reduce((n, i) => n + i.quantity, 0)) : '';
  $('finished').hidden = !showFinished || !done.length;
  $('finished').innerHTML = done.map(rowHtml).join('');
  $('toggleFin').textContent = showFinished ? 'Hide' : 'Show';
  $('toggleFin').hidden = !done.length;
  $('expFin').hidden = !done.length;
  $('dataDir').textContent = state.dataDir || '';
}

document.addEventListener('click', async (ev) => {
  const act = ev.target.dataset && ev.target.dataset.act;
  const row = ev.target.closest && ev.target.closest('.row');
  if (!act || !row) return;
  const item = findItem(row.dataset.id);
  if (act === 'select') {
    if (ev.target.checked) selected.add(item.id); else selected.delete(item.id);
    render();
  } else if (act === 'reopen') {
    await api('reopenItem', { id: item.id });
    toast(`${item.label} is back on the bench.`);
  } else if (act === 'edit') openPieceDialog(item);
  else if (act === 'log') openLog(item);
  else if (act === 'part') openPart(item);
});

$('finishBtn').onclick = async () => {
  const count = [...selected].reduce((n, id) => n + findItem(id).quantity, 0);
  await api('finishItems', { ids: [...selected] });
  selected.clear();
  render();
  toast(`${pieces(count)} marked finished.`);
};
$('toggleFin').onclick = () => { showFinished = !showFinished; render(); };
$('dataDir').onclick = () => api('openDataFolder');
for (const [button, scope] of [['expFin', 'finished'], ['expAll', 'all']]) {
  $(button).onclick = async () => {
    const result = await api('exportCsv', { scope });
    if (result.file) toast(`Wrote ${result.count} row${result.count === 1 ? '' : 's'} to ${result.file}`);
  };
}

// ---- add / edit a piece ------------------------------------------------

let draft = null; // { id (when editing), type, photo }

function renderPickers() {
  $('typeTiles').innerHTML = state.types.map((t) => `<button type="button" class="pick" role="radio" data-type="${esc(t.id)}"
      aria-checked="${draft.type === t.id}"><span class="art">${iconSvg(t.id)}</span>${esc(t.label)}</button>`).join('');
  const none = `<button type="button" class="pick photo" role="radio" data-photo="" aria-checked="${!draft.photo}"
      title="No photo - use the icon"><span class="art">${iconSvg('none')}</span>None</button>`;
  const photos = state.photos.map((name) => `<div class="pick photo" role="radio" tabindex="0" data-photo="${esc(name)}"
      aria-checked="${draft.photo === name}"><img src="${photoUrl(name)}" alt="Photo from your library">
      <button type="button" class="remove" data-remove="${esc(name)}" title="Remove from your library" aria-label="Remove photo">&times;</button></div>`);
  const add = `<button type="button" class="pick photo" id="photoAdd" title="Add a photo from this computer">
      <span class="art">${iconSvg('camera')}</span>Add&hellip;</button>`;
  $('photoTiles').innerHTML = none + photos.join('') + add;
}

function openPieceDialog(item) {
  draft = item ? { id: item.id, type: item.type, photo: item.photo } : { type: 'other', photo: null };
  $('pieceTitle').textContent = item ? 'Edit piece' : 'Add a piece';
  $('pieceSave').textContent = item ? 'Save' : 'Add';
  $('pieceDelete').hidden = !item;
  $('qtyBlock').hidden = !!item;
  $('pName').value = item ? item.name : '';
  $('pSku').value = item ? item.sku : '';
  $('pNotes').value = item ? item.notes : '';
  $('pQty').value = 1;
  $('modeRow').hidden = true;
  document.querySelector('input[name=mode][value=batch]').checked = true;
  $('moreDetails').open = !!(item && (item.sku || item.notes));
  renderPickers();
  $('pieceDlg').showModal();
  $('pName').focus();
}

async function usePhoto(result) {
  if (result && result.photo) {
    draft.photo = result.photo;
    renderPickers();
  }
}

$('addBtn').onclick = () => openPieceDialog(null);
$('pieceCancel').onclick = () => $('pieceDlg').close();
wireStepper($('pQty'), $('qtyDown'), $('qtyUp'));
$('pQty').addEventListener('input', () => { $('modeRow').hidden = !(parseInt($('pQty').value, 10) > 1); });

$('pieceDlg').addEventListener('click', async (ev) => {
  const remove = ev.target.closest('[data-remove]');
  const pick = ev.target.closest('.pick');
  if (remove) {
    const name = remove.dataset.remove;
    const users = state.items.filter((i) => i.photo === name).length;
    const text = users ? `${pieces(users)} on your lists use${users === 1 ? 's' : ''} this photo and will go back to the icon.` :
      'No piece is using it.';
    if (await ask('Remove this photo from your library?', text, 'Remove')) {
      await api('deletePhoto', { photo: name });
      if (draft.photo === name) draft.photo = null;
      renderPickers();
    }
  } else if (pick && pick.id === 'photoAdd') usePhoto(await api('importPhoto'));
  else if (pick && pick.dataset.type !== undefined) { draft.type = pick.dataset.type; renderPickers(); }
  else if (pick && pick.dataset.photo !== undefined) { draft.photo = pick.dataset.photo || null; renderPickers(); }
});
$('photoTiles').addEventListener('keydown', (ev) => {
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.dataset.photo) { ev.preventDefault(); ev.target.click(); }
});

// A picture dropped anywhere on the dialog goes into the library and is selected.
for (const name of ['dragenter', 'dragover']) {
  $('pieceDlg').addEventListener(name, (ev) => { ev.preventDefault(); $('pieceDlg').classList.add('dropping'); });
}
$('pieceDlg').addEventListener('dragleave', () => $('pieceDlg').classList.remove('dropping'));
$('pieceDlg').addEventListener('drop', async (ev) => {
  ev.preventDefault();
  $('pieceDlg').classList.remove('dropping');
  const file = ev.dataTransfer.files[0];
  if (file) usePhoto(await api('importPhotoPath', { file: window.timecard.pathForFile(file) }));
});

$('pieceForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const piece = { name: $('pName').value, sku: $('pSku').value, notes: $('pNotes').value, type: draft.type, photo: draft.photo };
  if (draft.id) {
    await api('updateItem', { id: draft.id, ...piece });
  } else {
    const quantity = parseInt($('pQty').value, 10) || 1;
    const separate = document.querySelector('input[name=mode]:checked').value === 'separate';
    await api('addItem', { ...piece, quantity, separate });
    toast(`Added ${piece.name.trim()}${quantity > 1 ? ` ×${quantity}` : ''}.`);
  }
  $('pieceDlg').close();
});

$('pieceDelete').onclick = async () => {
  const item = findItem(draft.id);
  const text = `Its ${fmtDur(item.total_seconds)} of logged time goes with it. This can't be undone.`;
  if (await ask(`Delete "${item.label}"?`, text, 'Delete')) {
    await api('deleteItem', { id: item.id });
    $('pieceDlg').close();
  }
};

// ---- finish part of a batch, time log ----------------------------------

let partItem = null;
wireStepper($('partCount'), $('partDown'), $('partUp'), () => (partItem ? partItem.quantity : 1));
function openPart(item) {
  partItem = item;
  $('partCount').value = 1;
  $('partHint').textContent = `${item.label} is a batch of ${item.quantity}. The finished ones take their even share ` +
    'of the time logged so far; the rest stay on the bench.';
  $('partDlg').showModal();
}
$('partCancel').onclick = () => $('partDlg').close();
$('partForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const count = parseInt($('partCount').value, 10) || 1;
  await api('finishPart', { id: partItem.id, count });
  $('partDlg').close();
  toast(`${pieces(count)} of ${partItem.name} marked finished.`);
});

function openLog(item) {
  const each = item.quantity > 1 ? ` (${fmtDur(item.seconds_per_piece)} each)` : '';
  $('logTitle').textContent = `${item.label || item.name}: ${fmtDur(item.total_seconds)}${each}`;
  const rows = item.time_entries.map((e) => `<tr><td>${fmtWhen(e.clock_in)}</td><td>${fmtWhen(e.clock_out)}</td>
    <td>${e.percent}%</td><td>${fmtDur(e.seconds)}</td></tr>`).join('');
  $('logBody').innerHTML = (rows ? `<table class="log"><tr><th>Clocked in</th><th>Clocked out</th><th>Share of session</th>
    <th>Time</th></tr>${rows}</table>` : '<p class="hint">No time logged yet.</p>') +
    `<div class="file">File: ${esc(state.dataDir)}/items/${esc(item.id)}.json</div>`;
  $('logDlg').showModal();
}
$('logClose').onclick = () => $('logDlg').close();

// ---- clocking in and out -----------------------------------------------

$('clockBtn').onclick = async () => {
  if (state.session) openClockOut();
  else { await api('clockIn'); toast('Clocked in.'); }
};
$('cancelBtn').onclick = async () => {
  if (await ask('Discard this session?', 'No time will be logged for it.', 'Discard')) await api('cancelSession');
};

let candidates = [];
let whenEdited = false;

function sessionSeconds() {
  // Only trust the field once it has been changed: it only holds minutes.
  const end = whenEdited && $('outWhen').value ? new Date($('outWhen').value) : new Date(Date.now() + clockSkew);
  return (end - new Date(state.session.clock_in)) / 1000;
}

async function openClockOut() {
  await api('state');
  if (!state.session) return;
  candidates = state.items.filter((i) => state.clockOutIds.includes(i.id));
  whenEdited = false;
  $('outWhen').value = localInput(new Date(Date.now() + clockSkew));
  $('outOverheadTile').innerHTML = iconSvg('overhead');
  $('outOverheadTile').className = 'tile small grey';
  $('outHint').textContent = candidates.length ?
    "What share of this session went to each piece? Leave blank for pieces you didn't touch. Whatever you don't assign goes to TimeOverhead." :
    'No pieces on the bench, so this whole session goes to TimeOverhead.';

  // Separate pieces that share a name get a row that splits one number evenly between them.
  const groups = new Map();
  for (const c of candidates) groups.set(c.name.toLowerCase(), [...(groups.get(c.name.toLowerCase()) || []), c]);
  let html = '';
  for (const [key, group] of groups) {
    const many = group.length > 1;
    if (many) {
      html += `<div class="alloc">${tile(group[0], 'small')}
        <div><b>All ${group.length} &times; ${esc(group[0].name)}</b><div class="muted">worked on together &mdash; splits evenly</div></div>
        <div class="pct"><input type="number" min="0" max="100" step="any" data-group="${esc(key)}" aria-label="Percent for all ${esc(group[0].name)}"></div>
        <div></div></div>`;
    }
    for (const c of group) {
      const qty = c.quantity > 1 ? `<span class="qty">&times;${c.quantity}</span>` : '';
      html += `<div class="alloc ${many ? 'child' : ''}">${many ? '<span></span>' : tile(c, 'small')}
        <div>${esc(c.label)}${qty}${c.status === 'finished' ? ' <span class="muted">finished</span>' : ''}</div>
        <div class="pct"><input type="number" min="0" max="100" step="any" data-item="${esc(c.id)}" data-name="${esc(key)}" aria-label="Percent for ${esc(c.label)}"></div>
        <div class="mins" data-mins="${esc(c.id)}"></div></div>`;
    }
  }
  $('allocRows').innerHTML = html;
  $('evenBtn').hidden = $('fillBtn').hidden = !candidates.length;
  $('outDlg').showModal();
  updateTotals();
  const first = $('allocRows').querySelector('input');
  (first || $('outConfirm')).focus();
}

const itemInputs = () => [...document.querySelectorAll('#allocRows input[data-item]')];

/** Give `total` percent to `inputs` by weight; the last one absorbs the rounding so the sum is exact. */
function spread(inputs, total, weights) {
  const whole = weights.reduce((a, b) => a + b, 0);
  let used = 0;
  inputs.forEach((input, i) => {
    const share = i < inputs.length - 1 ? Math.floor(total * weights[i] / whole * 100) / 100 : round2(total - used);
    used += share;
    input.value = share;
  });
}
const evenly = (inputs, total) => spread(inputs, total, inputs.map(() => 1));

function updateTotals() {
  const secs = sessionSeconds();
  const timeOk = secs > 0;
  $('outSummary').textContent = timeOk ? `Clocked in ${fmtWhen(state.session.clock_in)} — ${fmtDur(secs)} this session.` :
    `Clock-out time has to be after you clocked in (${fmtWhen(state.session.clock_in)}).`;
  let sum = 0;
  let valid = true;
  for (const input of itemInputs()) {
    const value = input.value === '' ? 0 : Number(input.value);
    if (!Number.isFinite(value) || value < 0 || !input.validity.valid) valid = false;
    else sum += value;
    document.querySelector(`[data-mins="${CSS.escape(input.dataset.item)}"]`).textContent =
      value > 0 && timeOk ? fmtDur(secs * value / 100) : '';
  }
  sum = round2(sum);
  const fits = valid && sum <= 100.01;
  const left = fits ? round2(Math.max(100 - sum, 0)) : 0;
  $('overheadPct').textContent = fits ? `${left}%` : '';
  $('overheadMins').textContent = fits && timeOk && left ? fmtDur(secs * left / 100) : '';
  $('allocTotal').className = `total ${fits ? '' : 'bad'}`;
  $('allocTotal').textContent = !valid ? 'Percentages need to be numbers from 0 to 100.' :
    !fits ? `Pieces add up to ${sum}% — ${round2(sum - 100)}% too much` :
      `Pieces ${sum}%  +  TimeOverhead ${left}%  =  100%`;
  $('outConfirm').disabled = !fits || !timeOk;
}

$('allocRows').addEventListener('input', (ev) => {
  const group = ev.target.dataset.group;
  if (group !== undefined) {
    const members = itemInputs().filter((i) => i.dataset.name === group);
    const value = Number(ev.target.value);
    if (ev.target.value !== '' && value > 0) evenly(members, value);
    else members.forEach((input) => { input.value = ''; });
  } else {
    // typing in one piece makes the "all of them" figure stale
    const head = document.querySelector(`#allocRows input[data-group="${CSS.escape(ev.target.dataset.name)}"]`);
    if (head) head.value = '';
  }
  updateTotals();
});
$('outWhen').oninput = () => { whenEdited = true; updateTotals(); };
$('evenBtn').onclick = () => {
  // Weighted by quantity, so a batch of 6 gets six shares.
  const inputs = itemInputs();
  spread(inputs, 100, inputs.map((i) => findItem(i.dataset.item).quantity));
  document.querySelectorAll('#allocRows input[data-group]').forEach((head) => { head.value = ''; });
  updateTotals();
};
$('fillBtn').onclick = () => {
  const inputs = itemInputs();
  const blank = inputs.filter((i) => i.value === '');
  const left = round2(100 - inputs.reduce((n, i) => n + (Number(i.value) || 0), 0));
  if (!blank.length) toast('Every row already has a number.');
  else if (left <= 0) toast("There's nothing left to spread.");
  else { evenly(blank, left); updateTotals(); }
};
$('outCancel').onclick = () => $('outDlg').close();
$('outConfirm').onclick = async () => {
  const allocations = {};
  for (const input of itemInputs()) if (Number(input.value) > 0) allocations[input.dataset.item] = Number(input.value);
  const record = await api('clockOut', { allocations, when: whenEdited ? $('outWhen').value : null });
  $('outDlg').close();
  const overhead = record.allocations.filter((a) => a.item_id === state.overhead.id).reduce((n, a) => n + a.percent, 0);
  toast(`Clocked out. ${fmtDur(record.seconds)} logged` +
    (overhead ? `, ${fmtDur(record.seconds * overhead / 100)} of it to TimeOverhead.` : '.'));
};
// Keeps the session length current while the dialog sits open.
setInterval(() => { if ($('outDlg').open) updateTotals(); }, 5000);

// ---- start -------------------------------------------------------------

$('addGlyph').innerHTML = iconSvg('plus');
api('state');
// Pick up anything changed on disk (a synced folder, another program) when the window is returned to.
window.addEventListener('focus', () => { if (!document.querySelector('dialog[open]')) api('state'); });
