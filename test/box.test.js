'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { describeBox, parseSpecString } = require('../src/box.js');

test('plain-English machine descriptions', () => {
  const mac = describeBox(parseSpecString('Mac mini M4 Pro 48GB'));
  assert.strictEqual(mac.unified, true); assert.strictEqual(mac.ram, 48); assert.strictEqual(mac.ramBwEff, 273);
  const pc = describeBox(parseSpecString('RTX 3060 12GB, 32GB DDR4, Windows'));
  assert.strictEqual(pc.gpu.vram, 12); assert.strictEqual(pc.ram, 32); assert.strictEqual(pc.os, 'windows');
  const mini = describeBox(parseSpecString('32GB DDR5 Ryzen 7 8845HS Radeon 780M'));
  assert.strictEqual(mini.gpu.kind, 'igpu'); assert.ok(mini.ramBwEff > 70 && mini.ramBwEff < 90);
  const strix = describeBox(parseSpecString('Ryzen AI Max+ 395 128GB'));
  assert.strictEqual(strix.unified, true); assert.strictEqual(strix.ram, 128);
  const pi = describeBox(parseSpecString('Raspberry Pi 5 16GB'));
  assert.strictEqual(pi.cpuClass, 'sbc');
});

test('object specs and assumptions', () => {
  const b = describeBox({ ram_gb: 64, gpu: 'RTX 4090' });
  assert.strictEqual(b.gpu.vram, 24); assert.ok(b.assumptions.length > 0);
});
