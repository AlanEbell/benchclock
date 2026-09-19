'use strict';
/*
 * Bench arithmetic: ring blanks, bezels, jump rings, metal weights, alloys, gauges and units.
 * Pure functions with no Node in them, so the calculators window loads this file as it is
 * and the tests run it in Node. Lengths are millimetres, weights grams, unless a name says otherwise.
 */

const INCH = 25.4;
const TROY_OUNCE = 31.1034768; // grams
const PENNYWEIGHT = TROY_OUNCE / 20;
const CARAT = 0.2;

// ----- ring sizes ---------------------------------------------------------
// US sizes step 0.818 mm of inside diameter; size 1 is 12.37 mm. UK letters step about 1.23 mm of
// circumference from A at 37.8 mm. EU (ISO 8653) sizes are the circumference in mm. Japanese sizes
// step a third of a millimetre of diameter from 13 mm at size 1.

const US_STEP = 0.818;
const US_ONE = 12.37;
const UK_STEP = 1.228;
const UK_A = 37.8;
const UK_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const round = (n, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

const usToDiameter = (size) => US_ONE + (size - 1) * US_STEP;
const diameterToUs = (mm) => (mm - US_ONE) / US_STEP + 1;
const jpToDiameter = (size) => 13 + (size - 1) / 3;
const diameterToJp = (mm) => (mm - 13) * 3 + 1;
const circumference = (diameter) => Math.PI * diameter;
const diameterOf = (circ) => circ / Math.PI;

/** UK size as a number: A = 0, A½ = 0.5, B = 1 ... Z = 25, then Z+1, Z+2 as 26, 27. */
function ukToIndex(text) {
  const m = /^\s*([A-Za-z])\s*(½|1\/2|\.5)?\s*(?:\+\s*(\d+))?\s*$/.exec(String(text));
  if (!m) return null;
  return UK_LETTERS.indexOf(m[1].toUpperCase()) + (m[2] ? 0.5 : 0) + (m[3] ? Number(m[3]) : 0);
}
function indexToUk(index) {
  const half = Math.round(index * 2) / 2;
  const whole = Math.floor(half);
  const letter = whole < UK_LETTERS.length ? UK_LETTERS[whole] : `Z+${whole - UK_LETTERS.length + 1}`;
  return `${letter}${half > whole ? '½' : ''}`;
}
const ukToCircumference = (index) => UK_A + index * UK_STEP;
const circumferenceToUk = (circ) => (circ - UK_A) / UK_STEP;

/** The inside diameter in mm of a ring size in any system. */
function ringDiameter(system, size) {
  if (system === 'us') return usToDiameter(Number(size));
  if (system === 'jp') return jpToDiameter(Number(size));
  if (system === 'eu') return diameterOf(Number(size));
  if (system === 'uk') { const i = ukToIndex(size); return i === null ? NaN : diameterOf(ukToCircumference(i)); }
  if (system === 'mm') return Number(size);
  return NaN;
}

/** The same inside diameter in every system, as people write them. */
function ringSizes(diameter) {
  const circ = circumference(diameter);
  return {
    diameter: round(diameter), circumference: round(circ, 1),
    us: round(diameterToUs(diameter) * 4) / 4, // to the quarter size
    uk: indexToUk(circumferenceToUk(circ)),
    eu: Math.round(circ), jp: Math.round(diameterToJp(diameter)),
  };
}

/** The conversion chart: US 1 to 16 in half sizes. */
function ringSizeChart() {
  const rows = [];
  for (let size = 1; size <= 16; size += 0.5) rows.push({ ...ringSizes(usToDiameter(size)), us: size });
  return rows;
}

// ----- bending stock into a circle ---------------------------------------
// Bent metal keeps its length along the middle of its thickness (the neutral axis), so a band
// with inside diameter D and thickness t needs π × (D + t) of stock, plus a little to file the
// ends true for a tight solder joint.

const SOLDER_ALLOWANCE = 1.5;
const KNUCKLE_ALLOWANCE = 0.4; // about half a size, for bands over 6 mm wide

/** Cut length of stock for a ring or bangle. `knuckle` adds room for a wide band to pass the knuckle. */
function blankLength({ diameter, thickness = 0, knuckle = false, allowance = SOLDER_ALLOWANCE }) {
  const inner = Number(diameter) + (knuckle ? KNUCKLE_ALLOWANCE : 0);
  const neutral = Math.PI * (inner + Number(thickness));
  return { inner: round(inner), neutral: round(neutral), cut: round(neutral + Number(allowance)) };
}

// ----- bezel strips -------------------------------------------------------

/** Ramanujan's approximation of an ellipse's perimeter from its full length and width. */
function ellipsePerimeter(length, width) {
  const a = length / 2;
  const b = width / 2;
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

/** Length of bezel strip: the stone's perimeter, plus π × thickness for the bend, plus overlap for the joint. */
function bezelStrip({ shape, length, width, perimeter, thickness = 0, overlap = 1 }) {
  let around;
  if (shape === 'round') around = Math.PI * Number(length);
  else if (shape === 'oval') around = ellipsePerimeter(Number(length), Number(width));
  else if (shape === 'rectangle') around = 2 * (Number(length) + Number(width));
  else around = Number(perimeter);
  const effective = around + Math.PI * Number(thickness);
  return { perimeter: round(around), effective: round(effective), cut: round(effective + Number(overlap)) };
}

// ----- wire gauge (American, also Brown & Sharpe for sheet) ---------------

const awgToMm = (gauge) => 0.005 * 92 ** ((36 - gauge) / 39) * INCH;
function mmToAwg(mm) {
  return 36 - 39 * Math.log(mm / INCH / 0.005) / Math.log(92);
}
function gaugeChart(from = 0, to = 36) {
  const rows = [];
  for (let g = from; g <= to; g += 1) rows.push({ gauge: g, mm: round(awgToMm(g), 3), inches: round(awgToMm(g) / INCH, 4) });
  return rows;
}

// ----- jump rings ---------------------------------------------------------

/** Wire for jump rings wound on a mandrel of `mandrel` mm with wire `wire` mm thick. */
function jumpRings({ mandrel, wire, count = 1, waste = 0 }) {
  const inner = Number(mandrel);
  const outer = inner + 2 * Number(wire);
  const perRing = Math.PI * (inner + Number(wire));
  const total = perRing * Math.max(Number(count) || 1, 1) * (1 + Number(waste) / 100);
  return {
    inner: round(inner), outer: round(outer), aspect: round(inner / Number(wire)), perRing: round(perRing),
    total: round(total), totalInches: round(total / INCH), ringsPerInch: round(INCH / Number(wire), 1),
  };
}

// ----- metal weight -------------------------------------------------------

/** Densities in g/cm³. Alloys vary a little by maker; these are the usual figures. */
const METALS = [
  { id: 'fine-silver', name: 'Fine silver (.999)', density: 10.49 },
  { id: 'sterling', name: 'Sterling silver (.925)', density: 10.36 },
  { id: 'argentium', name: 'Argentium silver', density: 10.3 },
  { id: 'gold-24k', name: '24k gold', density: 19.32 },
  { id: 'gold-22k', name: '22k yellow gold', density: 17.7 },
  { id: 'gold-18k', name: '18k yellow gold', density: 15.5 },
  { id: 'gold-18kw', name: '18k white gold', density: 15.9 },
  { id: 'gold-14k', name: '14k yellow gold', density: 13.1 },
  { id: 'gold-14kw', name: '14k white gold', density: 12.7 },
  { id: 'gold-10k', name: '10k yellow gold', density: 11.6 },
  { id: 'gold-9k', name: '9k gold', density: 11.2 },
  { id: 'platinum', name: 'Platinum (950)', density: 20.7 },
  { id: 'palladium', name: 'Palladium (950)', density: 12.0 },
  { id: 'gold-filled', name: 'Gold-filled (brass core)', density: 8.9 },
  { id: 'copper', name: 'Copper', density: 8.96 },
  { id: 'brass', name: 'Brass', density: 8.5 },
  { id: 'bronze', name: 'Bronze', density: 8.8 },
  { id: 'nickel-silver', name: 'Nickel silver', density: 8.75 },
  { id: 'stainless', name: 'Stainless steel', density: 8.0 },
  { id: 'titanium', name: 'Titanium', density: 4.5 },
  { id: 'aluminum', name: 'Aluminium', density: 2.7 },
];
const metalById = (id) => METALS.find((m) => m.id === id) || null;

/** Volume in mm³ of a piece of stock. Dimensions in mm. */
function stockVolume({ shape, length = 0, width = 0, thickness = 0, diameter = 0, wall = 0 }) {
  const L = Number(length); const W = Number(width); const T = Number(thickness); const D = Number(diameter); const wallT = Number(wall);
  if (shape === 'sheet') return L * W * T;
  if (shape === 'round-wire') return Math.PI * (D / 2) ** 2 * L;
  if (shape === 'square-wire') return W * W * L;
  if (shape === 'rect-wire') return W * T * L;
  if (shape === 'half-round') return Math.PI * (D / 2) ** 2 / 2 * L;
  if (shape === 'tube') return Math.PI * ((D / 2) ** 2 - (D / 2 - wallT) ** 2) * L;
  if (shape === 'disc') return Math.PI * (D / 2) ** 2 * T;
  if (shape === 'ring') return Math.PI * ((D / 2 + T) ** 2 - (D / 2) ** 2) * W; // a band: inside diameter D, thickness T, width W
  return 0;
}

/** Weight of a volume of metal, every way jewellers weigh. */
function weightOf(volumeMm3, density) {
  const grams = volumeMm3 / 1000 * density;
  return { grams: round(grams, 3), dwt: round(grams / PENNYWEIGHT, 3), ozt: round(grams / TROY_OUNCE, 4), carats: round(grams / CARAT, 2) };
}

function metalWeight({ metal, pricePerGram = 0, ...stock }) {
  const m = metalById(metal);
  const volume = stockVolume(stock);
  const weight = weightOf(volume, m ? m.density : 0);
  return { volume: round(volume, 2), density: m ? m.density : 0, ...weight, cost: round(weight.grams * Number(pricePerGram)) };
}

/** The same piece made in another metal weighs in proportion to the densities. */
function sameIn(grams, fromMetal, toMetal) {
  const from = metalById(fromMetal); const to = metalById(toMetal);
  if (!from || !to) return NaN;
  return round(Number(grams) * to.density / from.density, 3);
}

// ----- alloying -----------------------------------------------------------

/** Gold: what to add to `weight` grams of `karat` gold to reach `target` karat. Alloy lowers, fine gold raises. */
function alloyGold({ weight, karat, target }) {
  const W = Number(weight); const K = Number(karat); const T = Number(target);
  const gold = W * K / 24;
  if (T <= K) {
    const total = T > 0 ? gold * 24 / T : Infinity;
    return { add: 'alloy', amount: round(total - W, 3), total: round(total, 3), gold: round(gold, 3) };
  }
  const fine = T < 24 ? W * (T - K) / (24 - T) : Infinity;
  return { add: 'fine gold', amount: round(fine, 3), total: round(W + fine, 3), gold: round(gold + fine, 3) };
}

/** Fine silver to sterling: 7.5% copper. `fineness` is per mille, 925 for sterling. */
function alloySilver({ fineSilver, fineness = 925 }) {
  const total = Number(fineSilver) * 1000 / Number(fineness);
  return { alloy: round(total - Number(fineSilver), 3), total: round(total, 3) };
}

/** What karat a piece is from its gold content: 5 g of gold in 8 g of metal is 15k. */
const karatOf = (goldGrams, totalGrams) => round(24 * Number(goldGrams) / Number(totalGrams), 1);

// ----- units --------------------------------------------------------------

const LENGTH_UNITS = { mm: 1, cm: 10, in: INCH };
const WEIGHT_UNITS = { g: 1, dwt: PENNYWEIGHT, ozt: TROY_OUNCE, oz: 28.349523125, ct: CARAT };
function convert(value, from, to, units) {
  return Number(value) * units[from] / units[to];
}

const api = {
  INCH, TROY_OUNCE, PENNYWEIGHT, CARAT, SOLDER_ALLOWANCE, KNUCKLE_ALLOWANCE, METALS, LENGTH_UNITS, WEIGHT_UNITS, UK_LETTERS,
  round, ringDiameter, ringSizes, ringSizeChart, ukToIndex, indexToUk, blankLength, ellipsePerimeter, bezelStrip,
  awgToMm, mmToAwg, gaugeChart, jumpRings, stockVolume, weightOf, metalWeight, metalById, sameIn, alloyGold, alloySilver, karatOf, convert,
};
if (typeof module !== 'undefined') module.exports = api;
else window.calc = api; // the calculators window
