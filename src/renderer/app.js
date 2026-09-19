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
const expanded = new Set(); // groups that are open, as '<list>:<name>'
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
const fmtDay = (iso) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
const fmtWhen = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const localInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const pieces = (n) => `${n} piece${n === 1 ? '' : 's'}`;
const round2 = (n) => Math.round(n * 100) / 100;
const photoUrl = (name) => `bench-photo://library/${encodeURIComponent(name)}`;
const findItem = (id) => (id === state.overhead.id ? state.overhead : state.items.find((i) => i.id === id));

/** Pieces added together are shown as one group; anything else stands alone. Keeps the order of first appearance. */
const groupKey = (item) => item.batch_id || item.id;
function groupItems(items) {
  const groups = new Map();
  for (const item of items) {
    const key = groupKey(item);
    if (!groups.has(key)) groups.set(key, { key, name: item.name, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
}

const chevron = (open) => `<span class="chev ${open ? 'open' : ''}">${iconSvg('chevron')}</span>`;

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

function rowHtml(item, child = false) {
  const finished = item.status === 'finished';
  const qty = item.quantity > 1 ? `<span class="qty">&times;${item.quantity}</span>` : '';
  const each = item.quantity > 1 ? `<small>${fmtDur(item.seconds_per_piece)} each</small>` : '';
  const meta = [item.sku && `SKU ${esc(item.sku)}`, finished && `finished ${fmtWhen(item.finished_at)}`, esc(item.notes)]
    .filter(Boolean).join(' &middot; ');
  const check = `<input type="checkbox" data-act="select" aria-label="Select ${esc(item.label)}" ${selected.has(item.id) ? 'checked' : ''}>`;
  const actions = finished ? '<button class="quiet" data-act="reopen">Reopen</button>' :
    `<button class="quiet go" data-act="finish">Finish</button>${
      item.quantity > 1 ? '<button class="quiet" data-act="part">Finish some</button>' : ''}`;
  return `<div class="row ${child ? 'child' : ''} ${selected.has(item.id) ? 'selected' : ''}" data-id="${esc(item.id)}">
    ${check}${child ? '' : tile(item)}
    <div class="name"><b>${esc(item.label)}</b>${qty}<div class="meta">${meta}</div></div>
    <div class="time">${fmtDur(item.total_seconds)}${each}</div>
    <div class="acts">${actions}<button class="quiet" data-act="log">Log</button><button class="quiet" data-act="edit">Edit</button></div>
  </div>`;
}

/** One line standing for every piece with the same name; opens to show them one by one. */
function groupHtml(group, list) {
  if (group.items.length === 1) return rowHtml(group.items[0]);
  const id = `${list}:${group.key}`;
  const open = expanded.has(id);
  const members = group.items;
  const total = members.reduce((n, i) => n + i.total_seconds, 0);
  const picked = members.filter((i) => selected.has(i.id)).length;
  const check = `<input type="checkbox" data-act="select-group" aria-label="Select all ${esc(group.name)}"
      ${picked === members.length ? 'checked' : ''} ${picked && picked < members.length ? 'data-some="1"' : ''}>`;
  const started = members.filter((i) => i.status === 'in_progress').length;
  const meta = [members[0].sku && `SKU ${esc(members[0].sku)}`, `added ${fmtDay(members[0].created_at)}`,
    list === 'bench' && started && started < members.length && `${started} of ${members.length} started`,
    open ? 'each one listed below' : 'open to see each one'].filter(Boolean).join(' &middot; ');
  const actions = list === 'bench' ?
    `<button class="quiet go" data-act="group-finish">Finish all</button><button class="quiet" data-act="group-part">Finish some</button>
     <button class="quiet" data-act="group-edit">Edit all</button>` : '';
  return `<div class="row group ${picked === members.length ? 'selected' : ''}" data-group="${esc(group.key)}" data-list="${list}">
    ${check}${tile(members[0])}
    <div class="name toggle" data-act="toggle" role="button" tabindex="0" aria-expanded="${open}">${chevron(open)}<b>${esc(group.name)}</b><span
      class="qty">&times;${members.length}</span><div class="meta">${meta}</div></div>
    <div class="time">${fmtDur(total)}<small>${fmtDur(total / members.length)} each</small></div>
    <div class="acts">${actions}</div>
  </div>${open ? members.map((i) => rowHtml(i, true)).join('') : ''}`;
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
  for (const id of [...selected]) if (!state.items.some((i) => i.id === id)) selected.delete(id);
  const tickedOpen = open.filter((i) => selected.has(i.id)); // ticks mark pieces to finish, and pieces to report on

  // A group counts as in progress as soon as any one of its pieces is.
  const benchGroups = groupItems(open);
  const started = (group) => group.items.some((i) => i.status === 'in_progress');
  const sections = [['In progress', benchGroups.filter(started)], ['Getting started', benchGroups.filter((g) => !started(g))]];
  $('bench').innerHTML = open.length ? sections.map(([title, groups]) => (
    groups.length ? `<div class="group-title">${title}</div>${groups.map((g) => groupHtml(g, 'bench')).join('')}` : '')).join('') :
    '<div class="empty">Nothing on the bench yet. Add a piece to get started.</div>';

  const openCount = open.reduce((n, i) => n + i.quantity, 0);
  $('benchCount').textContent = open.length ? pieces(openCount) : '';
  $('finishBtn').hidden = !tickedOpen.length;
  $('clearSel').hidden = !selected.size;
  $('benchTip').hidden = !open.length;
  $('selCount').textContent = selected.size ? `${selected.size} ticked` : '';

  const overhead = state.overhead;
  $('overhead').innerHTML = `<div class="row" data-id="${esc(overhead.id)}">
    <span class="tile grey">${iconSvg('overhead')}</span>
    <div class="name"><b>${esc(overhead.name)}</b>
      <div class="meta">Everything besides making. Gets whatever part of a session you don't give to a piece.</div></div>
    <div class="time">${fmtDur(overhead.total_seconds)}</div>
    <div class="acts"><button class="quiet" data-act="log">Log</button></div></div>`;

  $('finCount').textContent = done.length ? pieces(done.reduce((n, i) => n + i.quantity, 0)) : '';
  $('finished').hidden = !showFinished || !done.length;
  $('finished').innerHTML = groupItems(done).map((g) => groupHtml(g, 'done')).join('');
  $('toggleFin').textContent = showFinished ? 'Hide' : 'Show';
  $('toggleFin').hidden = !done.length;
  for (const box of document.querySelectorAll('input[data-some]')) box.indeterminate = true;
  $('dataDir').textContent = state.dataDir || '';
}

function groupMembers(row) {
  const pool = state.items.filter((i) => (row.dataset.list === 'done') === (i.status === 'finished'));
  return pool.filter((i) => groupKey(i) === row.dataset.group);
}

document.addEventListener('click', async (ev) => {
  const target = ev.target.closest && ev.target.closest('[data-act]');
  const row = target && target.closest('.row');
  if (!row) return;
  const act = target.dataset.act;
  if (row.dataset.group !== undefined) {
    const members = groupMembers(row);
    if (act === 'toggle') {
      const id = `${row.dataset.list}:${row.dataset.group}`;
      if (!expanded.delete(id)) expanded.add(id);
      render();
    } else if (act === 'select-group') {
      for (const m of members) if (target.checked) selected.add(m.id); else selected.delete(m.id);
      render();
    } else if (act === 'group-finish') {
      for (const m of members) selected.delete(m.id);
      await api('finishItems', { ids: members.map((m) => m.id) });
      toast(`All ${members.length} \u00d7 ${members[0].name} marked finished. They are under Finished if you need one back.`);
    } else if (act === 'group-edit') openPieceDialog(members[0], members);
    else if (act === 'group-part') openPart({ members });
    return;
  }
  const item = findItem(row.dataset.id);
  if (act === 'select') {
    if (target.checked) selected.add(item.id); else selected.delete(item.id);
    render();
  } else if (act === 'finish') {
    selected.delete(item.id);
    await api('finishItems', { ids: [item.id] });
    toast(`${item.label} marked finished. It is under Finished if you need it back.`);
  } else if (act === 'reopen') {
    await api('reopenItem', { id: item.id });
    toast(`${item.label} is back on the bench.`);
  } else if (act === 'edit') openPieceDialog(item);
  else if (act === 'log') openLog(item);
  else if (act === 'part') openPart({ batch: item });
});
document.addEventListener('keydown', (ev) => {
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('.toggle')) { ev.preventDefault(); ev.target.click(); }
});

$('finishBtn').onclick = async () => {
  const ticked = state.items.filter((i) => selected.has(i.id) && i.status !== 'finished');
  await api('finishItems', { ids: ticked.map((i) => i.id) });
  for (const item of ticked) selected.delete(item.id);
  render();
  toast(`${pieces(ticked.reduce((n, i) => n + i.quantity, 0))} marked finished.`);
};
$('clearSel').onclick = () => { selected.clear(); render(); };
$('toggleFin').onclick = () => { showFinished = !showFinished; render(); };
$('dataDir').onclick = () => api('openDataFolder');

// ---- add / edit a piece ------------------------------------------------

let draft = null; // { ids (when editing; several when editing a whole group), type, photo }

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

function openPieceDialog(item, group) {
  const ids = group ? group.map((i) => i.id) : item ? [item.id] : null;
  draft = item ? { ids, type: item.type, photo: item.photo } : { type: 'other', photo: null };
  $('pieceTitle').textContent = group ? `Edit all ${group.length} \u00d7 ${item.name}` : item ? 'Edit piece' : 'Add a piece';
  $('pieceSave').textContent = item ? 'Save' : 'Add';
  $('pieceDelete').hidden = !item || !!group;
  $('pieceAdjust').hidden = !item;
  $('qtyBlock').hidden = !!item;
  $('pName').value = item ? item.name : '';
  $('pSku').value = item ? item.sku : '';
  $('pNotes').value = item ? item.notes : '';
  $('pQty').value = 1;
  $('qtyHint').hidden = true;
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
$('pQty').addEventListener('input', () => { $('qtyHint').hidden = !(parseInt($('pQty').value, 10) > 1); });

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
  if (draft.ids) {
    for (const id of draft.ids) await api('updateItem', { id, ...piece });
  } else {
    // Several of one design are always kept as separate pieces; the lists show them as one group.
    const quantity = parseInt($('pQty').value, 10) || 1;
    await api('addItem', { ...piece, quantity, separate: true });
    toast(`Added ${piece.name.trim()}${quantity > 1 ? ` ×${quantity}` : ''}.`);
  }
  $('pieceDlg').close();
});

$('pieceAdjust').onclick = () => { const ids = draft.ids; $('pieceDlg').close(); openAdjust(ids); };
$('pieceDelete').onclick = async () => {
  const item = findItem(draft.ids[0]);
  const text = `Its ${fmtDur(item.total_seconds)} of logged time goes with it. This can't be undone.`;
  if (await ask(`Delete "${item.label}"?`, text, 'Delete')) {
    await api('deleteItem', { id: item.id });
    $('pieceDlg').close();
  }
};

// ---- finish part of a batch, time log ----------------------------------

let part = null; // { members: [...] } for a group, or { batch: item } for a single entry holding several
const partMax = () => (part ? (part.members ? part.members.length : part.batch.quantity) : 1);
wireStepper($('partCount'), $('partDown'), $('partUp'), partMax);
function openPart(target) {
  part = target;
  const name = part.members ? part.members[0].name : part.batch.label;
  $('partCount').value = 1;
  $('partHint').textContent = part.members ?
    `${partMax()} \u00d7 ${name} are on the bench. To finish particular ones, open the group and tick them instead.` :
    `${name} is a batch of ${partMax()}. The finished ones take their even share of the time logged so far; the rest stay on the bench.`;
  $('partDlg').showModal();
}
$('partCancel').onclick = () => $('partDlg').close();
$('partForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const count = Math.min(parseInt($('partCount').value, 10) || 1, partMax());
  if (part.members) {
    // the ones with the most time on them are the likeliest to be the finished ones
    const order = [...part.members].sort((a, b) => b.total_seconds - a.total_seconds || a.sequence - b.sequence);
    await api('finishItems', { ids: order.slice(0, count).map((i) => i.id) });
  } else await api('finishPart', { id: part.batch.id, count });
  $('partDlg').close();
  toast(`${pieces(count)} of ${part.members ? part.members[0].name : part.batch.name} marked finished.`);
});

function openLog(item) {
  const each = item.quantity > 1 ? ` (${fmtDur(item.seconds_per_piece)} each)` : '';
  $('logTitle').textContent = `${item.label || item.name}: ${fmtDur(item.total_seconds)}${each}`;
  const rows = item.time_entries.map((e) => (e.kind === 'adjustment' ?
    `<tr class="adj"><td>${fmtDay(e.clock_in)}</td><td colspan="2">Adjustment${e.note ? `: ${esc(e.note)}` : ''}</td>
    <td>${e.seconds < 0 ? '\u2212' : '+'}${fmtDur(Math.abs(e.seconds))}</td></tr>` :
    `<tr><td>${fmtWhen(e.clock_in)}</td><td>${fmtWhen(e.clock_out)}</td><td>${e.percent}%</td><td>${fmtDur(e.seconds)}</td></tr>`)).join('');
  $('logBody').innerHTML = (rows ? `<table class="log"><tr><th>Clocked in</th><th>Clocked out</th><th>Share of session</th>
    <th>Time</th></tr>${rows}</table>` : '<p class="hint">No time logged yet.</p>') +
    `<div class="file">File: ${esc(state.dataDir)}/items/${esc(item.id)}.json</div>`;
  $('logDlg').dataset.id = item.id;
  $('logDlg').showModal();
}
$('logClose').onclick = () => $('logDlg').close();
$('logAdjust').onclick = () => { const id = $('logDlg').dataset.id; $('logDlg').close(); openAdjust([id]); };

// ---- adjusting time ----------------------------------------------------

/** The box for putting time on pieces by hand. `ids` are ticked to start with; else whatever is ticked on the lists. */
function openAdjust(ids) {
  const ticked = new Set(ids || selected);
  const line = (item, extra = '') => `<label class="choice ${extra}"><input type="checkbox" data-id="${esc(item.id)}" ${ticked.has(item.id) ? 'checked' : ''}>
    ${tile(item, 'small')}<span class="who">${esc(item.label || item.name)}</span><span class="have">${fmtDur(item.total_seconds)}</span></label>`;
  const bench = state.items.filter((i) => i.status !== 'finished');
  const done = state.items.filter((i) => i.status === 'finished');
  $('adjustRows').innerHTML = [
    bench.length && `<div class="group-title">On the bench</div>${bench.map((i) => line(i)).join('')}`,
    done.length && `<div class="group-title">Finished</div>${done.map((i) => line(i, 'finished')).join('')}`,
    `<div class="group-title">Everything else</div>${line(state.overhead)}`,
  ].filter(Boolean).join('');
  $('adjustRows').querySelector('.choice:last-child .tile').classList.add('grey');
  $('adjHours').value = 0;
  $('adjMins').value = 30;
  $('adjNote').value = '';
  $('adjWhen').value = dayStr(new Date(Date.now() + clockSkew));
  $('adjWhen').max = $('adjWhen').value;
  document.querySelector('input[name=adjDir][value=add]').checked = true;
  document.querySelector('input[name=adjShare][value=each]').checked = true;
  updateAdjust();
  $('adjustDlg').showModal();
  (ticked.size ? $('adjMins') : $('adjustRows').querySelector('input')).focus();
  if (ticked.size) $('adjMins').select();
}

/** What the box would do: { ids, minutes (signed), split }, and whether it can be done. */
function adjustChoice() {
  const ids = [...document.querySelectorAll('#adjustRows input:checked')].map((box) => box.dataset.id);
  const hours = Math.max(0, Math.floor(Number($('adjHours').value) || 0));
  const mins = Math.max(0, Math.floor(Number($('adjMins').value) || 0));
  const off = document.querySelector('input[name=adjDir]:checked').value === 'off';
  const split = ids.length > 1 && document.querySelector('input[name=adjShare]:checked').value === 'split';
  return { ids, minutes: (off ? -1 : 1) * (hours * 60 + mins), split };
}

function updateAdjust() {
  const { ids, minutes, split } = adjustChoice();
  $('adjShare').hidden = ids.length < 2;
  const each = split ? minutes / ids.length : minutes;
  const items = ids.map(findItem);
  const short = items.filter((i) => i.total_seconds + each * 60 < -0.05);
  const amount = fmtDur(Math.abs(each) * 60);
  let text;
  if (!ids.length) text = 'Tick the pieces to adjust.';
  else if (!minutes) text = 'How much time? Hours, minutes or both.';
  else if (short.length) {
    text = short.length === 1 ?
      `${short[0].label || short[0].name} only has ${fmtDur(short[0].total_seconds)} on it, so ${amount} can't come off.` :
      `${amount} can't come off ${short.map((i) => `${i.label || i.name} (${fmtDur(i.total_seconds)})`).join(', ')}: not enough time on them.`;
  } else if (ids.length === 1) {
    const [item] = items;
    text = `${item.label || item.name}: ${fmtDur(item.total_seconds)} \u2192 ${fmtDur(item.total_seconds + minutes * 60)}.`;
  } else {
    text = minutes > 0 ?
      (split ? `Shares ${fmtDur(minutes * 60)} between ${pieces(ids.length)}: ${amount} each.` : `Adds ${amount} to each of ${pieces(ids.length)}.`) :
      (split ? `Takes ${fmtDur(-minutes * 60)} off ${pieces(ids.length)} between them: ${amount} each.` : `Takes ${amount} off each of ${pieces(ids.length)}.`);
  }
  $('adjustSummary').textContent = text;
  $('adjustSummary').classList.toggle('bad', short.length > 0);
  $('adjustSave').disabled = !ids.length || !minutes || short.length > 0;
}

$('adjustDlg').addEventListener('input', updateAdjust);
$('adjustDlg').addEventListener('change', updateAdjust);
$('adjustCancel').onclick = () => $('adjustDlg').close();
$('adjustForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const { ids, minutes, split } = adjustChoice();
  if (!ids.length || !minutes) return;
  // The day is what matters; the work is dated noon, or now if it was today.
  const day = $('adjWhen').value || dayStr(new Date(Date.now() + clockSkew));
  const today = day === dayStr(new Date(Date.now() + clockSkew));
  const when = today ? localInput(new Date(Date.now() + clockSkew)) : `${day}T12:00`;
  const done = await api('adjustTime', { ids, minutes, split, when, note: $('adjNote').value });
  $('adjustDlg').close();
  const amount = fmtDur(Math.abs(done.seconds));
  const who = done.items.length === 1 ? (findItem(done.items[0].id) || done.items[0]).label || done.items[0].name : pieces(done.items.length);
  toast(done.seconds > 0 ? `Added ${amount} to ${who}${done.items.length > 1 ? ' each' : ''}.` : `Took ${amount} off ${who}${done.items.length > 1 ? ' each' : ''}.`);
});

// ---- time report -------------------------------------------------------

const REPORT_PRESETS = [['this-week', 'This week'], ['last-week', 'Last week'], ['this-month', 'This month'],
  ['last-month', 'Last month'], ['this-year', 'This year'], ['all-time', 'All time']];
const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtDate = (day) => new Date(`${day}T12:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

/** The day weeks start on where this computer is set up for: 0 is Sunday, 1 Monday. */
function weekStartsOn() {
  try {
    const locale = new Intl.Locale(navigator.language);
    return (locale.getWeekInfo ? locale.getWeekInfo() : locale.weekInfo).firstDay % 7;
  } catch { return 0; }
}

function presetDates(id) {
  const today = new Date(Date.now() + clockSkew);
  const [y, m, d] = [today.getFullYear(), today.getMonth(), today.getDate()];
  const week = d - (today.getDay() - weekStartsOn() + 7) % 7; // day of the month this week began; Date copes with 0 and below
  const span = (from, to) => ({ from: dayStr(from), to: dayStr(to) });
  if (id === 'this-week') return span(new Date(y, m, week), new Date(y, m, week + 6));
  if (id === 'last-week') return span(new Date(y, m, week - 7), new Date(y, m, week - 1));
  if (id === 'this-month') return span(new Date(y, m, 1), new Date(y, m + 1, 0));
  if (id === 'last-month') return span(new Date(y, m - 1, 1), new Date(y, m, 0));
  if (id === 'this-year') return span(new Date(y, 0, 1), new Date(y, 11, 31));
  return { from: '', to: '' };
}

// The days are remembered as "last week", not as dates, so next week it means next week's last week.
const remembered = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
const remember = (key, value) => { try { localStorage.setItem(key, value); } catch { /* a nicety, not a need */ } };
let reportPreset = remembered('reportPreset', 'all-time'); // null while the dates are the user's own
let reportScope = remembered('reportScope', 'all');
const REPORT_SCOPES = [['all', 'Everything'], ['ticked', 'Ticked'], ['bench', 'On the bench'], ['finished', 'Finished']];

const reportChoice = () => ({ scope: reportScope, ids: [...selected], from: $('repFrom').value, to: $('repTo').value });

async function updateReport() {
  const { from, to } = reportChoice();
  const match = REPORT_PRESETS.find(([id]) => presetDates(id).from === from && presetDates(id).to === to);
  reportPreset = match ? match[0] : null;
  for (const button of $('reportPresets').children) button.setAttribute('aria-pressed', button.dataset.preset === reportPreset);
  for (const button of $('reportScopes').children) {
    const id = button.dataset.scope;
    button.setAttribute('aria-pressed', id === reportScope);
    if (id === 'ticked') {
      button.disabled = !selected.size;
      button.textContent = selected.size ? `Ticked (${selected.size})` : 'Ticked';
      button.title = selected.size ? '' : 'Tick pieces on the lists first, then come back here';
    }
  }
  const days = from && to ? (from === to ? `On ${fmtDate(from)}` : `${fmtDate(from)} to ${fmtDate(to)}`) :
    from ? `Since ${fmtDate(from)}` : to ? `Up to ${fmtDate(to)}` : 'All time';
  const backwards = !!from && !!to && from > to;
  let text = '"From" has to be on or before "To".';
  let empty = false;
  if (!backwards) {
    const found = await api('exportPreview', reportChoice());
    empty = !found.pieces && !found.overhead;
    text = empty ? `${days}: nothing to report. Pieces are left out when they have no time on these days and weren't finished on them.` :
      `${days}: ${pieces(found.pieces)}, ${fmtDur(found.making)} on them${found.overhead ? ` and ${fmtDur(found.overhead)} of TimeOverhead` : ''},
       in ${found.sessions} session${found.sessions === 1 ? '' : 's'}. Time counts on the day its session was clocked in.`;
  }
  $('reportSummary').textContent = text.replace(/\s+/g, ' ');
  $('reportSave').disabled = $('reportCsv').disabled = backwards || empty;
}

function openReport() {
  if (reportPreset) ({ from: $('repFrom').value, to: $('repTo').value } = presetDates(reportPreset)); // else: the dates typed last time
  // Pieces ticked on the lists are most likely what the report is wanted for.
  if (selected.size) reportScope = 'ticked';
  else if (reportScope === 'ticked') reportScope = 'all';
  $('reportDlg').showModal();
  updateReport();
}

$('reportScopes').innerHTML = REPORT_SCOPES.map(([id, label]) => `<button type="button" data-scope="${id}" aria-pressed="false">${label}</button>`).join('');
$('reportPresets').innerHTML = REPORT_PRESETS.map(([id, label]) => `<button type="button" data-preset="${id}" aria-pressed="false">${label}</button>`).join('');
$('reportScopes').onclick = (ev) => {
  if (!ev.target.dataset.scope) return;
  reportScope = ev.target.dataset.scope;
  updateReport();
};
$('reportPresets').onclick = (ev) => {
  if (!ev.target.dataset.preset) return;
  ({ from: $('repFrom').value, to: $('repTo').value } = presetDates(ev.target.dataset.preset));
  updateReport();
};
$('repFrom').oninput = $('repTo').oninput = updateReport;
$('reportBtn').onclick = openReport;
$('calcBtn').onclick = () => api('openCalculators');
$('reportCancel').onclick = () => $('reportDlg').close();

async function saveReport(method) {
  $('reportSave').disabled = $('reportCsv').disabled = true;
  try {
    const result = await api(method, reportChoice());
    if (!result.file) return; // backed out of choosing where to save: the choices are still there to change
    remember('reportPreset', reportPreset || '');
    if (reportScope !== 'ticked') remember('reportScope', reportScope);
    $('reportDlg').close();
    toast(method === 'exportCsv' ? `Wrote ${result.count} row${result.count === 1 ? '' : 's'} to ${result.file}` : `Saved the report to ${result.file}`);
  } finally { if ($('reportDlg').open) updateReport(); }
}
$('reportForm').addEventListener('submit', (ev) => { ev.preventDefault(); saveReport('exportReport'); });
$('reportCsv').onclick = () => saveReport('exportCsv');

// ---- about, and the menu bar -------------------------------------------

function openAbout() {
  $('aboutVersion').textContent = `Version ${state.app.version}`;
  $('aboutDetail').textContent = `Free software under the MIT license. Built on Electron ${state.app.electron}. Your time card is kept in ${state.dataDir}`;
  $('aboutDlg').showModal();
  $('aboutClose').focus();
}
$('aboutClose').onclick = () => $('aboutDlg').close();
$('aboutHelp').onclick = () => { $('aboutDlg').close(); api('openHelp'); };
$('aboutSite').onclick = () => api('openHomepage');

const menuActions = { add: () => openPieceDialog(null), report: openReport, adjust: () => openAdjust(), about: openAbout };
window.timecard.onMenu((action) => {
  if (document.querySelector('dialog[open]')) return; // one thing at a time
  menuActions[action]();
});

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

  // Pieces that share a name are one closed line: one number, divided evenly. Opened, each has its own box.
  let html = '';
  for (const group of groupItems(candidates)) {
    const many = group.items.length > 1;
    const open = expanded.has(`out:${group.key}`);
    if (many) {
      html += `<div class="alloc">${tile(group.items[0], 'small')}
        <div class="toggle" data-toggle="${esc(group.key)}" role="button" tabindex="0" aria-expanded="${open}">${chevron(open)}<b>${esc(group.name)}</b><span
          class="qty">&times;${group.items.length}</span><div class="muted">divided evenly &mdash; open to enter each one</div></div>
        <div class="pct"><input type="number" min="0" max="100" step="any" data-group="${esc(group.key)}" aria-label="Percent for all ${esc(group.name)}"></div>
        <div class="mins" data-gmins="${esc(group.key)}"></div></div>`;
    }
    for (const c of group.items) {
      const qty = c.quantity > 1 ? `<span class="qty">&times;${c.quantity}</span>` : '';
      html += `<div class="alloc ${many ? 'child' : ''}" ${many ? `data-child-of="${esc(group.key)}"` : ''} ${many && !open ? 'hidden' : ''}>
        ${many ? '<span></span>' : tile(c, 'small')}
        <div>${esc(c.label)}${qty}${c.status === 'finished' ? ' <span class="muted">finished</span>' : ''}</div>
        <div class="pct"><input type="number" min="0" max="100" step="any" data-item="${esc(c.id)}" data-name="${esc(group.key)}" aria-label="Percent for ${esc(c.label)}"></div>
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
  // A group's box always shows what its pieces add up to (left alone while it is being typed in).
  for (const head of document.querySelectorAll('#allocRows input[data-group]')) {
    const share = round2(itemInputs().filter((i) => i.dataset.name === head.dataset.group).reduce((n, i) => n + (Number(i.value) || 0), 0));
    if (head !== document.activeElement) head.value = share || '';
    document.querySelector(`[data-gmins="${CSS.escape(head.dataset.group)}"]`).textContent =
      share > 0 && timeOk ? fmtDur(secs * share / 100) : '';
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
  }
  updateTotals();
});
$('allocRows').addEventListener('click', (ev) => {
  const toggle = ev.target.closest('[data-toggle]');
  if (!toggle) return;
  const key = toggle.dataset.toggle;
  const open = !expanded.delete(`out:${key}`);
  if (open) expanded.add(`out:${key}`);
  toggle.setAttribute('aria-expanded', open);
  toggle.querySelector('.chev').classList.toggle('open', open);
  for (const child of document.querySelectorAll(`#allocRows [data-child-of="${CSS.escape(key)}"]`)) child.hidden = !open;
});
$('allocRows').addEventListener('keydown', (ev) => {
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('.toggle')) { ev.preventDefault(); ev.target.click(); }
});
$('outWhen').oninput = () => { whenEdited = true; updateTotals(); };
$('evenBtn').onclick = () => {
  // Weighted by quantity, so a batch of 6 gets six shares.
  const inputs = itemInputs();
  spread(inputs, 100, inputs.map((i) => findItem(i.dataset.item).quantity));
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
