'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/index.js');
const C = require('./calibration.json');

const M = (id) => S.MODELS.find(m => m.id === id);
const H = (id) => JSON.parse(JSON.stringify(S.HARDWARE.find(h => h.id === id)));

test('estimates stay within 30% of published measurements', () => {
  for (const c of C) {
    const m = M(c.model); const q = m.quants.find(x => x.tag === c.quant); const h = H(c.hw);
    if (c.ramBw) { h.ramBw = h.ramBwEff = c.ramBw; }
    const e = S.estimate(m, q, h, { ctx: c.ctx });
    const err = e.decode / c.measured - 1;
    assert.ok(Math.abs(err) <= 0.30, `${c.model} ${c.quant} on ${c.hw}: estimated ${e.decode.toFixed(1)} vs measured ${c.measured} (${(err * 100).toFixed(0)}%) — ${c.src}`);
  }
});

test('LFM2.5-24B-A2B on a 32 GB Ryzen mini PC: 4-bit, runs well, 25–45 tok/s', () => {
  const P = S.plan(M('lfm25-24b'), H('ser8-32'), { ctx: 32768 });
  assert.ok(P.best, 'should fit');
  assert.strictEqual(P.best.est.status, 'ok');
  assert.ok(/4/.test(P.best.q.tag), P.best.q.tag);
  assert.ok(P.best.est.decodeShort > 25 && P.best.est.decodeShort < 45, String(P.best.est.decodeShort));
});

test('formats a box cannot execute are marked, not estimated', () => {
  const lfm = M('lfm25-24b');
  assert.strictEqual(S.estimate(lfm, lfm.quants.find(q => q.tag === 'MLX-4bit'), H('ser8-32'), {}).status, 'na');
  const q27 = M('qwen38-27b');
  assert.notStrictEqual(S.estimate(q27, q27.quants.find(q => q.tag === 'NVFP4'), H('m5max-36'), {}).status, 'na');
  assert.strictEqual(S.estimate(q27, q27.quants.find(q => q.tag === 'NVFP4'), H('rtx3090'), {}).status, 'na');
});

test('Flash-Next keeps its n-gram table on the SSD when lazy loading is on', () => {
  const fn = M('flash-next');
  const e = S.estimate(fn, fn.quants.find(q => q.tag === 'UD-IQ4_XS'), H('strix-128'), { ctx: 8192 });
  assert.strictEqual(e.placement, 'unified');
  assert.strictEqual(e.ssdGB, 28.8);
});

test('engine ranking picks the specialist where it belongs', () => {
  const top = (model, hw, ctx = 32768) => { const P = S.plan(M(model), H(hw), { ctx }); return S.rankEngines(H(hw), M(model), P.best, { ctx }).map(x => x.engine.id); };
  assert.strictEqual(top('qwen38-27b', 'm5max-36')[0], 'lithos');
  assert.strictEqual(top('flash-next', 'rtx5060ti')[0], 'strata');
  assert.ok(top('qwen38-27b', 'rtx5090').slice(0, 3).includes('infernix'));
  assert.strictEqual(top('lfm25-2.6b', 'pi5-16')[0], 'llamacpp');
});

test('every model × box combination plans without throwing', () => {
  for (const m of S.MODELS) for (const h of S.HARDWARE) {
    const P = S.plan(m, h, { ctx: 32768, users: 2 });
    for (const r of S.rankEngines(h, m, P.best, { ctx: 32768, users: 2 })) assert.strictEqual(typeof r.cmd, 'string');
  }
});
