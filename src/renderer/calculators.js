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

function alloy() {
  const gold = calc.alloyGold({ weight: num('aWeight'), karat: num('aKarat'), target: num('aTarget') });
  const k = calc.karatOf(num('aGold'), num('aTotal'));
  const silver = calc.alloySilver({ fineSilver: num('aSilver'), fineness: num('aFineness') || 925 });
  $('aOut').innerHTML = head('Change the karat') +
    (Number.isFinite(gold.amount) && num('aKarat') <= 24 && num('aTarget') <= 24 && num('aTarget') > 0 ?
      line(`Add ${gold.add}`, `${gold.amount.toFixed(3)} g`, 'big') + line(`Makes ${num('aTarget')}k weighing`, `${gold.total.toFixed(3)} g`) + line('Fine gold in it', `${gold.gold.toFixed(3)} g`) :
      bad('Karats run from 1 to 24.')) +
    head('What karat is it') +
    (num('aTotal') > 0 && num('aGold') <= num('aTotal') ? line('Karat', `${k}k`, 'big') + line('Gold content', `${(100 * num('aGold') / num('aTotal')).toFixed(1)}%, ${Math.round(1000 * num('aGold') / num('aTotal'))} fine`) :
      bad('The gold can\'t weigh more than the whole piece.')) +
    head('Sterling from fine silver') +
    line('Add copper (or alloy)', `${silver.alloy.toFixed(3)} g`, 'big') + line(`Makes ${num('aFineness') || 925} fine silver weighing`, `${silver.total.toFixed(3)} g`);
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

const ALL = [ringBlank, bangle, bezel, jump, weight, alloy, gauge, units];
function recalc() { for (const fn of ALL) fn(); }

ringChart();
gaugeChart();
jumpGaugeList();
metalLists();
restore();
document.addEventListener('input', (ev) => {
  if (ev.target.id) remember(ev.target.id, ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value);
  recalc();
});
document.addEventListener('change', (ev) => {
  if (ev.target.id === 'jumpGauge' && ev.target.value !== '') { $('jumpWire').value = calc.awgToMm(Number(ev.target.value)).toFixed(3); remember('jumpWire', $('jumpWire').value); }
  if (ev.target.id === 'jumpWire') { $('jumpGauge').value = ''; remember('jumpGauge', ''); }
  recalc();
});
recalc();
