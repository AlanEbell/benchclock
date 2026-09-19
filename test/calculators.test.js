'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const c = require('../src/core/calculators.js');

const near = (actual, expected, within = 0.05) => assert.ok(Math.abs(actual - expected) <= within, `${actual} is not within ${within} of ${expected}`);

test('ring sizes agree across systems', () => {
  near(c.ringDiameter('us', 7), 17.28);
  near(c.ringDiameter('us', 1), 12.37);
  near(c.ringDiameter('jp', 13), 17);
  near(c.ringDiameter('eu', 54), 17.19);
  near(c.ringDiameter('uk', 'N'), 17.13, 0.1);
  near(c.ringDiameter('uk', 'N½'), 17.33, 0.1);
  near(c.ringDiameter('uk', 'Z+2'), 22.7, 0.2);
  assert.ok(Number.isNaN(c.ringDiameter('uk', '7')));
  const seven = c.ringSizes(c.ringDiameter('us', 7));
  assert.deepEqual([seven.us, seven.eu, seven.jp, seven.uk], [7, 54, 14, 'N½']);
  assert.equal(c.indexToUk(c.ukToIndex('Q½')), 'Q½');
  assert.equal(c.indexToUk(27), 'Z+2');
  const chart = c.ringSizeChart();
  assert.equal(chart.length, 31);
  assert.deepEqual([chart[0].us, chart.at(-1).us, chart[12].us], [1, 16, 7]);
});

test('a ring blank is measured along the middle of the metal, with room to file', () => {
  const blank = c.blankLength({ diameter: 17.28, thickness: 1.5 });
  near(blank.neutral, Math.PI * 18.78);
  near(blank.cut, blank.neutral + 1.5);
  assert.equal(c.blankLength({ diameter: 17.28, thickness: 1.5, knuckle: true }).inner, 17.68);
  assert.equal(c.blankLength({ diameter: 65, thickness: 2, allowance: 0 }).cut, c.blankLength({ diameter: 65, thickness: 2, allowance: 0 }).neutral);
});

test('bezel strip by shape', () => {
  near(c.bezelStrip({ shape: 'round', length: 10, thickness: 0.3, overlap: 1 }).cut, Math.PI * 10 + Math.PI * 0.3 + 1);
  near(c.ellipsePerimeter(10, 10), Math.PI * 10, 0.001); // a circle is an ellipse
  near(c.ellipsePerimeter(14, 10), 37.97, 0.05);
  near(c.bezelStrip({ shape: 'oval', length: 14, width: 10, thickness: 0, overlap: 0 }).cut, 37.97, 0.05);
  assert.equal(c.bezelStrip({ shape: 'rectangle', length: 12, width: 8, thickness: 0, overlap: 0 }).cut, 40);
  assert.equal(c.bezelStrip({ shape: 'freeform', perimeter: 33.3, thickness: 0, overlap: 1.5 }).cut, 34.8);
});

test('wire gauge is the AWG formula', () => {
  near(c.awgToMm(18), 1.024, 0.002);
  near(c.awgToMm(20), 0.812, 0.002);
  near(c.awgToMm(12), 2.053, 0.002);
  near(c.mmToAwg(1.024), 18, 0.02);
  const chart = c.gaugeChart(8, 30);
  assert.deepEqual([chart[0].gauge, chart.at(-1).gauge, chart.length], [8, 30, 23]);
  assert.equal(chart.find((r) => r.gauge === 18).inches, 0.0403);
});

test('jump rings', () => {
  const rings = c.jumpRings({ mandrel: 4, wire: 1.024, count: 100, waste: 10 });
  assert.deepEqual([rings.inner, rings.outer, rings.aspect], [4, 6.05, 3.91]);
  near(rings.perRing, Math.PI * 5.024, 0.01);
  near(rings.total, rings.perRing * 100 * 1.1, 0.5);
  near(rings.totalInches, rings.total / 25.4, 0.02);
  assert.equal(rings.ringsPerInch, 24.8);
  assert.equal(c.jumpRings({ mandrel: 4, wire: 1 }).total, c.jumpRings({ mandrel: 4, wire: 1, count: 0 }).total, 'no count means one ring');
});

test('metal weight from volume and density, and the same piece in another metal', () => {
  // a 50 x 20 x 1 mm sheet of sterling: 1000 mm³ = 1 cm³ = 10.36 g
  const sheet = c.metalWeight({ metal: 'sterling', shape: 'sheet', length: 50, width: 20, thickness: 1, pricePerGram: 1.1 });
  assert.deepEqual([sheet.volume, sheet.grams, sheet.cost], [1000, 10.36, 11.4]);
  near(sheet.dwt, 6.66, 0.01);
  near(sheet.ozt, 0.333, 0.001);
  near(c.metalWeight({ metal: 'gold-14k', shape: 'round-wire', diameter: 1, length: 100 }).grams, Math.PI * 0.25 * 100 / 1000 * 13.1, 0.001);
  near(c.stockVolume({ shape: 'tube', diameter: 4, wall: 0.5, length: 10 }), Math.PI * (4 - 2.25) * 10, 0.001);
  near(c.stockVolume({ shape: 'ring', diameter: 17.3, thickness: 1.5, width: 4 }), Math.PI * ((8.65 + 1.5) ** 2 - 8.65 ** 2) * 4, 0.001);
  assert.equal(c.stockVolume({ shape: 'half-round', diameter: 2, length: 10 }), c.stockVolume({ shape: 'round-wire', diameter: 2, length: 10 }) / 2);
  assert.equal(c.metalWeight({ metal: 'nope', shape: 'disc', diameter: 10, thickness: 1 }).grams, 0);
  near(c.sameIn(10, 'sterling', 'gold-18k'), 10 * 15.5 / 10.36, 0.001);
  assert.ok(Number.isNaN(c.sameIn(10, 'sterling', 'kryptonite')));
});

test('alloying gold and silver', () => {
  // 10 g of 24k to 18k: total 13.333, add 3.333 of alloy
  assert.deepEqual(c.alloyGold({ weight: 10, karat: 24, target: 18 }), { add: 'alloy', amount: 3.333, total: 13.333, gold: 10 });
  // 10 g of 14k up to 18k: add fine gold (10 x 4) / 6 = 6.667
  const up = c.alloyGold({ weight: 10, karat: 14, target: 18 });
  assert.deepEqual([up.add, up.amount, up.total], ['fine gold', 6.667, 16.667]);
  near(c.karatOf(up.gold, up.total), 18, 0.05);
  assert.deepEqual(c.alloyGold({ weight: 10, karat: 18, target: 18 }), { add: 'alloy', amount: 0, total: 10, gold: 7.5 });
  assert.deepEqual(c.alloySilver({ fineSilver: 92.5 }), { alloy: 7.5, total: 100 });
  assert.equal(c.karatOf(5, 8), 15);
});

test('units', () => {
  near(c.convert(1, 'in', 'mm', c.LENGTH_UNITS), 25.4, 0.0001);
  near(c.convert(31.1035, 'g', 'ozt', c.WEIGHT_UNITS), 1, 0.0001);
  near(c.convert(1, 'dwt', 'g', c.WEIGHT_UNITS), 1.5552, 0.0001);
  near(c.convert(1, 'ct', 'g', c.WEIGHT_UNITS), 0.2, 0.0001);
});
