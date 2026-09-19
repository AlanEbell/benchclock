'use strict';
/* global calc */
// The calculators window. Every field recalculates on each keystroke; values are remembered between openings.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (id) => Number($(id).value) || 0;
const inches = (mm) => `${(mm / calc.INCH).toFixed(3)} in`;
const mm = (n, places = 2) => `${Number(n).toFixed(places)} mm`;
const both = (n) => `${mm(n)} <span class="sub">${inches(n)}</span>`;
const line = (label, value, cls = '') => `<div class="line ${cls}"><span>${label}</span><span>${value}</span></div>`;
const head = (label) => `<div class="line head"><span>${label}</span><span></span></div>`;
const bad = (text) => `<div class="bad">${text}</div>`;
const ok = (n) => Number.isFinite(n) && n > 0;

// ---- tabs, and showing only the fields a shape needs ----------------------

for (const button of document.querySelectorAll('nav [data-panel]')) {
  button.onclick = () => {
    for (const b of document.querySelectorAll('nav [data-panel]')) b.setAttribute('aria-pressed', b === button);
    for (const panel of document.querySelectorAll('.panel')) panel.hidden = panel.id !== button.dataset.panel;
    remember('panel', button.dataset.panel);
    document.querySelector(`#${button.dataset.panel} input, #${button.dataset.panel} select`).focus();
  };
}
function showFieldsFor(panel, value) {
  for (const box of document.querySelectorAll(`#${panel} [data-for]`)) box.hidden = !box.dataset.for.split(' ').includes(value);
}

// ---- remembering what was typed ------------------------------------------

const remembered = (key) => { try { return localStorage.getItem(`calc:${key}`); } catch { return null; } };
const remember = (key, value) => { try { localStorage.setItem(`calc:${key}`, value); } catch { /* a nicety */ } };
function restore() {
  for (const field of document.querySelectorAll('main input, main select')) {
    const saved = remembered(field.id);
    if (saved === null) continue;
    if (field.type === 'checkbox') field.checked = saved === 'true'; else field.value = saved;
  }
  const panel = remembered('panel');
  const button = panel && document.querySelector(`nav [data-panel="${CSS.escape(panel)}"]`);
  if (button) button.click();
}

// ---- the calculators ------------------------------------------------------

function ringBlank() {
  const system = $('ringSystem').value;
  const size = $('ringSize').value.trim();
  $('ringSize').inputMode = system === 'uk' ? 'text' : 'decimal';
  $('ringSize').placeholder = { us: 'e.g. 7 or 6.5', uk: 'e.g. N or N½', eu: 'e.g. 54', jp: 'e.g. 14', mm: 'e.g. 17.3' }[system];
  const diameter = calc.ringDiameter(system, size);
  const width = num('ringWidth');
  if (!ok(diameter)) {
    $('ringOut').innerHTML = bad(system === 'uk' ? 'Type a UK size as a letter, with ½ or 1/2 for half sizes: N, N½, Z+1.' : 'Type a size.');
    return;
  }
  const sizes = calc.ringSizes(diameter);
  const blank = calc.blankLength({ diameter, thickness: num('ringThick'), knuckle: $('ringKnuckle').checked, allowance: num('ringAllow') });
  $('ringOut').innerHTML =
    line('Cut the stock to', both(blank.cut), 'big') +
    line('Length along the middle of the metal', mm(blank.neutral)) +
    line(`Inside diameter${$('ringKnuckle').checked ? ' with knuckle room' : ''}`, both(blank.inner)) +
    line('Inside circumference', mm(sizes.circumference, 1)) +
    (width > 6 && !$('ringKnuckle').checked ? bad('A band over 6 mm wide usually needs about half a size more to pass the knuckle: tick the box.') : '') +
    head('The same size elsewhere') +
    line('US and Canada', String(sizes.us)) + line('UK and Australia', sizes.uk) + line('EU, ISO', String(sizes.eu)) + line('Japan', sizes.jp >= 1 ? String(sizes.jp) : 'below 1');
  for (const row of $('ringChart').querySelectorAll('tr[data-us]')) row.classList.toggle('now', Number(row.dataset.us) === Math.round(sizes.us * 2) / 2);
}

function ringChart() {
  const rows = calc.ringSizeChart().map((r) => `<tr data-us="${r.us}"><td>${r.us}</td><td>${r.diameter.toFixed(2)}</td><td>${r.circumference.toFixed(1)}</td><td>${esc(r.uk)}</td><td>${r.eu}</td><td>${r.jp >= 1 ? r.jp : ''}</td></tr>`);
  $('ringChart').innerHTML = '<tr><th>US</th><th>Inside diameter mm</th><th>Circumference mm</th><th>UK</th><th>EU / ISO</th><th>Japan</th></tr>' + rows.join('');
}

function bangle() {
  const d = num('bangleD');
  if (!ok(d)) { $('bangleOut').innerHTML = bad('Type the inside diameter.'); return; }
  const blank = calc.blankLength({ diameter: d, thickness: num('bangleT'), allowance: num('bangleAllow') });
  $('bangleOut').innerHTML = line('Cut the stock to', both(blank.cut), 'big') + line('Length along the middle of the metal', mm(blank.neutral)) +
    line('Inside circumference', mm(Math.PI * d, 1)) + line('Outside diameter', mm(d + 2 * num('bangleT')));
}

function bezel() {
  const shape = $('bezelShape').value;
  showFieldsFor('bezel', shape);
  $('bezelLLabel').textContent = shape === 'round' ? 'Diameter' : 'Length';
  const strip = calc.bezelStrip({ shape, length: num('bezelL'), width: num('bezelW'), perimeter: num('bezelP'), thickness: num('bezelT'), overlap: num('bezelOverlap') });
  if (!ok(strip.perimeter)) { $('bezelOut').innerHTML = bad('Type the stone\'s measurements.'); return; }
  $('bezelOut').innerHTML = line('Cut the strip to', both(strip.cut), 'big') + line('Around the stone', mm(strip.perimeter)) +
    line('Plus the bend in the metal', mm(strip.effective)) + line('Plus overlap for the joint', mm(strip.cut)) +
    (shape === 'rectangle' ? '<div class="bad" style="color: var(--muted)">Corners are bent, not counted: a bezel that turns sharp corners is usually made in pieces and soldered.</div>' : '');
}

function jumpGaugeList() {
  $('jumpGauge').innerHTML = '<option value="">Typed below</option>' + calc.gaugeChart(8, 30).map((r) => `<option value="${r.gauge}">${r.gauge} AWG, ${r.mm.toFixed(3)} mm</option>`).join('');
}
function jump() {
  const gauge = $('jumpGauge').value;
  if (gauge !== '' && document.activeElement !== $('jumpWire')) $('jumpWire').value = calc.awgToMm(Number(gauge)).toFixed(3);
  const wire = num('jumpWire');
  if (!ok(num('jumpMandrel')) || !ok(wire)) { $('jumpOut').innerHTML = bad('Type the mandrel and wire sizes.'); return; }
  const r = calc.jumpRings({ mandrel: num('jumpMandrel'), wire, count: num('jumpCount'), waste: num('jumpWaste') });
  $('jumpOut').innerHTML = line(`Wire for ${Math.max(num('jumpCount'), 1)} ring${num('jumpCount') === 1 ? '' : 's'}`, `${mm(r.total, 0)} <span class="sub">${r.totalInches.toFixed(1)} in, ${(r.totalInches / 12).toFixed(2)} ft</span>`, 'big') +
    line('Wire per ring', both(r.perRing)) + line('Inside diameter', mm(r.inner)) + line('Outside diameter', mm(r.outer)) +
    line('Aspect ratio (inside &divide; wire)', String(r.aspect)) + line('Rings per inch of coil', String(r.ringsPerInch)) +
    (r.aspect < 2.8 ? bad('Under about 2.8 the ring is too tight to link with another of its own size.') : '');
}

function metalLists() {
  const options = calc.METALS.map((m) => `<option value="${m.id}">${esc(m.name)} (${m.density})</option>`).join('');
  $('wMetal').innerHTML = options;
  $('wSameIn').innerHTML = '<option value="">Nothing else</option>' + options;
  $('wMetal').value = 'sterling';
}
function weight() {
  const shape = $('wShape').value;
  showFieldsFor('weight', shape);
  $('wWidthLabel').textContent = shape === 'square-wire' ? 'Side' : 'Width';
  $('wDiamLabel').textContent = shape === 'ring' ? 'Inside diameter' : shape === 'tube' ? 'Outside diameter' : 'Diameter';
  const w = calc.metalWeight({ metal: $('wMetal').value, shape, length: num('wLength'), width: num('wWidth'), thickness: num('wThick'), diameter: num('wDiam'), wall: num('wWall'), pricePerGram: num('wPrice') });
  if (!ok(w.volume)) { $('wOut').innerHTML = bad('Type the measurements of the stock.'); return; }
  const other = $('wSameIn').value;
  $('wOut').innerHTML = line('Weight', `${w.grams.toFixed(2)} g <span class="sub">${w.dwt.toFixed(2)} dwt, ${w.ozt.toFixed(3)} ozt</span>`, 'big') +
    (num('wPrice') ? line('Cost at the price typed', `$${w.cost.toFixed(2)}`) : '') +
    line('Volume', `${w.volume.toFixed(1)} mm³`) + line('Density', `${w.density} g/cm³`) +
    (other ? line(`In ${esc(calc.metalById(other).name)}`, `${calc.sameIn(w.grams, $('wMetal').value, other).toFixed(2)} g`) : '');
}

const UNIT_SCALE = { karat: 24, fineness: 1000, percent: 100 };
function purityLists() {
  const options = (chosen) => '<option value="">Type it below</option>' + calc.PURITIES.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  $('cFromPreset').innerHTML = options();
  $('cToPreset').innerHTML = options();
  $('cFromPreset').value = 'silver-925';
  $('cToPreset').value = '';
}
/** A preset picked: its purity goes in the box in the unit chosen (switching the unit to the preset's own if it makes sense). */
function usePurityPreset(presetId, numberField) {
  const p = calc.PURITIES.find((x) => x.id === presetId);
  if (!p) return;
  if ($('cUnit').value !== 'percent' && $('cUnit').value !== p.unit) { $('cUnit').value = p.unit; remember('cUnit', p.unit); }
  const scale = UNIT_SCALE[$('cUnit').value];
  $(numberField).value = Number((p.purity * scale).toFixed(scale === 24 ? 2 : 1));
  remember(numberField, $(numberField).value);
}
function alloy() {
  const unit = $('cUnit').value; const scale = UNIT_SCALE[unit];
  const show = (p) => (unit === 'karat' ? `${Number((p * 24).toFixed(2))}k` : unit === 'fineness' ? `${Math.round(p * 1000)} fine` : `${Number((p * 100).toFixed(1))}%`);
  const nameOf = (presetField, p) => { const preset = calc.PURITIES.find((x) => x.id === $(presetField).value); return preset ? preset.name.toLowerCase() : `${show(p)} metal`; };
  const P = num('cFrom') / scale; const T = num('cTo') / scale;
  const fineName = num('cTo') > 0 && (unit === 'karat' ? 'fine gold' : unit === 'fineness' ? 'fine silver' : 'fine metal');
  let out = head(`${num('cAmount')} g of ${esc(nameOf('cFromPreset', P))} to ${show(T)}`);
  const r = calc.changePurity({ have: num('cAmount'), purity: P, target: T });
  if (num('cFrom') > scale || num('cTo') > scale) out += bad(`Purity can't be more than ${scale} here.`);
  else if (!r) out += bad(T === 1 && P < 1 ? 'Nothing added to it will make it pure: that takes refining.' : T === 0 ? 'A purity of 0 is just copper.' : 'Type the amount and both purities.');
  else if (r.amount === 0) out += line('Nothing to add', 'it is that already');
  else {
    out += line(`Add ${r.add === 'fine' ? fineName : 'copper (or alloy)'}`, `${r.amount.toFixed(3)} g`, 'big') +
      line(`Melted together you have ${show(T)} weighing`, `${r.total.toFixed(3)} g`, 'big') + line('Fine metal in it', `${r.fine.toFixed(3)} g`);
  }
  out += head('What purity is it');
  const share = num('aTotal') > 0 ? num('aGold') / num('aTotal') : NaN;
  out += num('aTotal') > 0 && share <= 1 ? line('Purity', `${Number((share * 24).toFixed(2))}k, ${Math.round(share * 1000)} fine, ${Number((share * 100).toFixed(1))}%`, 'big') :
    bad('The fine metal can\'t weigh more than the whole piece.');
  $('aOut').innerHTML = out;
}

function recipeList() {
  $('rRecipe').innerHTML = calc.RECIPES.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  $('rRecipe').value = 'gold-18k-yellow';
}
function fillRecipe(id) {
  const r = calc.recipeById(id);
  if (!r || id === 'custom') return;
  $('rGold').value = r.gold; $('rSilver').value = r.silver; $('rCopper').value = r.copper;
  for (const f of ['rGold', 'rSilver', 'rCopper']) remember(f, $(f).value);
}
const PURITY = { karat: 24, fineness: 1000, percent: 100 };
function recipe() {
  const made = calc.alloyRecipe({ total: num('rTotal'), gold: num('rGold'), silver: num('rSilver'), copper: num('rCopper') });
  const name = calc.recipeById($('rRecipe').value);
  let out = head(`To melt ${num('rTotal')} g of ${esc(name ? name.name.toLowerCase() : 'alloy')}`);
  if (!made) out += bad('Type a weight and at least one percentage.');
  else {
    out += (made.gold ? line('Fine gold', `${made.gold.toFixed(3)} g`, 'big') : '') + (made.silver ? line('Fine silver', `${made.silver.toFixed(3)} g`, 'big') : '') +
      (made.copper ? line('Copper', `${made.copper.toFixed(3)} g`, 'big') : '') +
      line('Comes out as', made.gold ? `${made.karat}k, ${made.goldFineness} fine gold` : `${made.fineness} fine silver`);
  }
  const unit = $('rUnit').value; const scale = PURITY[unit];
  const label = (p) => (unit === 'karat' ? `${(p * 24).toFixed(2).replace(/\.?0+$/, '')}k` : unit === 'fineness' ? `${Math.round(p * 1000)} fine` : `${(p * 100).toFixed(1)}%`);
  const mix = calc.mixLots({ weightA: num('rWa'), purityA: num('rPa') / scale, weightB: num('rWb'), purityB: num('rPb') / scale, target: $('rTarget').value === '' ? null : num('rTarget') / scale });
  out += head('Two lots melted together');
  if (num('rPa') > scale || num('rPb') > scale || num('rTarget') > scale) out += bad(`Purity can't be more than ${scale} here.`);
  else if (!(mix.total > 0)) out += bad('Type the weights of the lots.');
  else {
    out += line(`${mix.total} g comes out as`, label(mix.purity), 'big') + line('Fine metal in it', `${mix.fine.toFixed(3)} g`);
    if ($('rTarget').value !== '') {
      out += mix.needB !== null ? line(`To bring lot A to ${label(num('rTarget') / scale)}, add of lot B`, `${mix.needB.toFixed(3)} g`, 'big') + line('Making', `${(num('rWa') + mix.needB).toFixed(3)} g`) :
        bad('That purity can\'t be reached: it has to lie between the two lots\' purities.');
    }
  }
  $('rOut').innerHTML = out;
}

function gauge() {
  const g = num('gGauge');
  const mmIn = num('gMm');
  const nearest = Math.round(calc.mmToAwg(mmIn));
  $('gOut').innerHTML = line(`${g} gauge is`, `${mm(calc.awgToMm(g), 3)} <span class="sub">${(calc.awgToMm(g) / calc.INCH).toFixed(4)} in</span>`, 'big') +
    (ok(mmIn) ? line(`${mmIn} mm is nearest to`, `${nearest} gauge <span class="sub">${calc.awgToMm(nearest).toFixed(3)} mm exactly; ${calc.mmToAwg(mmIn).toFixed(1)} on the scale</span>`, 'big') : '');
  for (const row of $('gaugeChart').querySelectorAll('tr[data-g]')) row.classList.toggle('now', Number(row.dataset.g) === g);
}
function gaugeChart() {
  $('gaugeChart').innerHTML = '<tr><th>Gauge (AWG, B&amp;S)</th><th>mm</th><th>Inches</th><th>Used for</th></tr>' + calc.gaugeChart(0, 36).map((r) => {
    const use = r.gauge <= 6 ? 'Heavy bangle and cuff stock' : r.gauge <= 12 ? 'Ring shanks, bangles, heavy chain' : r.gauge <= 16 ? 'Ring bands, jump rings, sheet for rings' :
      r.gauge <= 20 ? 'Ear wires, jump rings, bezel backs, general sheet' : r.gauge <= 24 ? 'Bezel strip, fine chain, wire wrapping' : r.gauge <= 28 ? 'Bezel strip for small stones, filigree, fine wrapping' : 'Very fine: weaving, coiling, cloisonné';
    return `<tr data-g="${r.gauge}"><td>${r.gauge}</td><td>${r.mm.toFixed(3)}</td><td>${r.inches.toFixed(4)}</td><td class="muted">${use}</td></tr>`;
  }).join('');
}

function units() {
  const len = calc.convert(num('uLenValue'), $('uLenFrom').value, $('uLenTo').value, calc.LENGTH_UNITS);
  const wt = calc.convert(num('uWtValue'), $('uWtFrom').value, $('uWtTo').value, calc.WEIGHT_UNITS);
  const name = (select) => select.options[select.selectedIndex].textContent;
  $('uOut').innerHTML = line(`${num('uLenValue')} ${name($('uLenFrom'))}`, `${Number(len.toFixed(4))} ${name($('uLenTo'))}`, 'big') +
    line(`${num('uWtValue')} ${name($('uWtFrom'))}`, `${Number(wt.toFixed(4))} ${name($('uWtTo'))}`, 'big');
}

// ---- wiring ---------------------------------------------------------------

const ALL = [ringBlank, bangle, bezel, jump, weight, alloy, recipe, gauge, units];
function recalc() { for (const fn of ALL) fn(); }

ringChart();
gaugeChart();
jumpGaugeList();
metalLists();
recipeList();
purityLists();
restore();
if (remembered('rGold') === null) fillRecipe($('rRecipe').value);
document.addEventListener('input', (ev) => {
  if (ev.target.id) remember(ev.target.id, ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value);
  recalc();
});
document.addEventListener('change', (ev) => {
  if (ev.target.id === 'jumpGauge' && ev.target.value !== '') { $('jumpWire').value = calc.awgToMm(Number(ev.target.value)).toFixed(3); remember('jumpWire', $('jumpWire').value); }
  if (ev.target.id === 'jumpWire') { $('jumpGauge').value = ''; remember('jumpGauge', ''); }
  if (ev.target.id === 'rRecipe') fillRecipe(ev.target.value);
  if (ev.target.id === 'cFromPreset') usePurityPreset(ev.target.value, 'cFrom');
  if (ev.target.id === 'cToPreset') usePurityPreset(ev.target.value, 'cTo');
  if (ev.target.id === 'cFrom') { $('cFromPreset').value = ''; remember('cFromPreset', ''); }
  if (ev.target.id === 'cTo') { $('cToPreset').value = ''; remember('cToPreset', ''); }
  if (ev.target.id === 'cUnit') { for (const [preset, field] of [['cFromPreset', 'cFrom'], ['cToPreset', 'cTo']]) if ($(preset).value) usePurityPreset($(preset).value, field); }
  if (['rGold', 'rSilver', 'rCopper'].includes(ev.target.id)) { $('rRecipe').value = 'custom'; remember('rRecipe', 'custom'); }
  recalc();
});
recalc();
