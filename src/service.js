'use strict';
/*
 * High-level questions shared by the CLI and the MCP server.
 * Copyright 2026 Dr. Arvind Karthikeyan. Apache-2.0.
 */
const SHILA = require('./index.js');
const { describeBox, parseSpecString } = require('./box.js');
const { probe } = require('./probe.js');
const { fetchModel } = require('./hf.js');

const norm = (s) => String(s || '').toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9.\-/]/g, '');
const ALIASES = {
  'lfm2.5-24b': 'lfm25-24b', 'lfm2.5-24b-a2b': 'lfm25-24b', 'lfm-24b': 'lfm25-24b', 'lfm24b': 'lfm25-24b',
  'lfm2.5-8b': 'lfm25-8b', 'lfm2.5-8b-a1b': 'lfm25-8b', 'lfm2.5-2.6b': 'lfm25-2.6b', 'lfm2.5-1.2b': 'lfm25-1.2b',
  'qwen3.8-27b': 'qwen38-27b', 'qwen-27b': 'qwen38-27b', '27b': 'qwen38-27b',
  'qwen3.8-flash-next': 'flash-next', 'flash-next': 'flash-next', 'flashnext': 'flash-next', 'qwen3.8-flash': 'flash-next',
  'qwen3.6-35b': 'qwen36-35b', 'qwen3.6-35b-a3b': 'qwen36-35b', '35b-a3b': 'qwen36-35b',
  'gemma4-26b': 'gemma4-26b', 'gemma-4-26b': 'gemma4-26b', 'gemma-4-26b-a4b': 'gemma4-26b', 'gemma4-31b': 'gemma4-31b', 'gemma-4-31b': 'gemma4-31b',
  'gemma4-12b': 'gemma4-12b', 'gemma-4-12b': 'gemma4-12b', 'gemma4-e4b': 'gemma4-e4b', 'gemma-4-e4b': 'gemma4-e4b', 'gemma4-e2b': 'gemma4-e2b', 'gemma-4-e2b': 'gemma4-e2b',
  'nemotron-3.5': 'nemotron35', 'nemotron3.5': 'nemotron35', 'nemotron-3.5-lightning': 'nemotron35',
};

async function resolveModel(input) {
  if (!input) throw new Error('Name a model: a catalogue id (run list_models) or a Hugging Face repo like LiquidAI/LFM2.5-24B-A2B');
  const n = norm(input);
  let m = SHILA.MODELS.find(x => x.id === n || norm(x.name) === n || norm(x.hf) === n || norm(x.hf.split('/')[1]) === n);
  if (!m && ALIASES[n]) m = SHILA.MODELS.find(x => x.id === ALIASES[n]);
  if (!m) m = SHILA.MODELS.find(x => norm(x.name).startsWith(n) && n.length >= 5);
  if (m) return m;
  if (String(input).includes('/')) return await fetchModel(String(input).trim());
  const near = SHILA.MODELS.filter(x => norm(x.name).includes(n.split('-')[0])).map(x => x.id);
  throw new Error(`Unknown model "${input}". Use a Hugging Face repo id (org/name) or one of: ${(near.length ? near : SHILA.MODELS.map(x => x.id)).join(', ')}`);
}

function resolveHardware(h) {
  if (h == null || h === '' || h === 'this' || h === 'this_machine' || h === 'this-machine') return probe();
  if (typeof h === 'string') {
    const n = norm(h);
    const p = SHILA.HARDWARE.find(x => x.id === n);
    if (p) return p;
    const parsed = parseSpecString(h);
    if (parsed) return describeBox(parsed);
    throw new Error(`Unknown hardware "${h}". Use a preset id (run list_hardware), "this_machine", or describe it, e.g. "32GB DDR5, RTX 3060 12GB, Windows"`);
  }
  return describeBox(h);
}

const STATUS = { ok: 'Runs well', tight: 'Runs, little headroom', ssd: 'Runs slowly (streams from SSD)', no: 'Does not fit', na: 'Not for this hardware' };
const r1 = (n) => Math.round(n * 10) / 10;

function compactEngine(x) {
  return { engine: x.engine.name, kind: x.engine.kind === 'specific' ? 'model-specific' : 'general', url: x.engine.url, license: x.engine.license, score: x.score, why: x.why, caveats: x.caveats, commands: x.cmd, api: x.engine.api };
}
function compactBox(b) {
  return { id: b.id, name: b.name, ram_gb: b.ram, ram_bandwidth_gbs: b.ramBwEff, unified_memory: !!b.unified, gpu: b.gpu ? { name: b.gpu.name, vram_gb: b.gpu.vram || null, bandwidth_gbs: b.gpu.vramBw || null } : null, os: b.os, price: SHILA.priceText(b), assumptions: b.assumptions || [] };
}

async function checkCompatibility({ model, hardware, context = 32768, users = 1, min_quality = 'any', kv_cache_8bit = false, vision = false }) {
  const m = await resolveModel(model);
  const hw = resolveHardware(hardware);
  const o = { ctx: Number(context) || 32768, users: Number(users) || 1, floor: min_quality, kv8: !!kv_cache_8bit, vision: !!vision };
  const P = SHILA.plan(m, hw, o);
  const b = P.best;
  const engines = SHILA.rankEngines(hw, m, b, o).filter(x => x.score >= 25).slice(0, 4).map(compactEngine);
  const ladder = P.rows.slice().sort((a, x) => a.q.gb - x.q.gb).map(r => ({ quant: r.q.tag, repo: r.q.repo, size_gb: r.q.gb, quality: r.tier.label, placement: SHILA.placementLabel(r.est.placement), status: STATUS[r.est.status], est_decode_tps_short: r1(r.est.decodeShort || 0), est_decode_tps_full_context: r1(r.est.decode || 0), est_prompt_tps: Math.round(r.est.prefill || 0) }));
  const measured = (m.anchors || []).map(a => ({ tokens_per_sec: a.toks, hardware: a.hw, quant: a.quant, engine: a.engine, source: a.src, same_box: a.hwId === hw.id }));
  const out = {
    model: { id: m.id, name: m.name, hf: m.hf, total_b: m.total, active_b: m.active, kind: m.kind, license: m.license, from_hub: !!m.fromHub },
    hardware: compactBox(hw),
    settings: { context: o.ctx, users: o.users, min_quality, kv_cache_8bit: o.kv8 },
    verdict: b ? STATUS[b.est.status] : STATUS.no,
    recommendation: b ? {
      quant: b.q.tag, repo: b.q.repo, size_gb: b.q.gb, quality: b.tier.label, placement: SHILA.placementLabel(b.est.placement),
      est_decode_tps_short: r1(b.est.decodeShort), est_decode_tps_full_context: r1(b.est.decode), est_prompt_tps: Math.round(b.est.prefill),
      memory_used_gb: r1(b.est.usedGB || b.est.need), memory_available_gb: b.est.capacityGB ? r1(b.est.capacityGB) : null, notes: b.est.notes,
    } : null,
    fastest_alternative: P.fastest && b && P.fastest.q !== b.q ? { quant: P.fastest.q.tag, est_decode_tps_short: r1(P.fastest.est.decodeShort) } : null,
    engines, quant_ladder: ladder, measured_elsewhere: measured,
    disclaimer: `Estimates (±30%) from a memory-bandwidth model calibrated on published measurements; speculative decoding not included. Data as of ${SHILA.DATA_DATE}.`,
  };
  return out;
}

async function whatCanRun({ hardware, context = 32768, users = 1, min_quality = 'any' }) {
  const hw = resolveHardware(hardware);
  const o = { ctx: Number(context) || 32768, users: Number(users) || 1, floor: min_quality };
  const rows = SHILA.MODELS.map(m => {
    const P = SHILA.plan(m, hw, o); const b = P.best;
    const top = b ? SHILA.rankEngines(hw, m, b, o)[0] : null;
    return { model: m.name, id: m.id, kind: m.kind === 'moe' ? `MoE ${m.total}B / ${m.active}B active` : `dense ${m.total}B`, verdict: b ? STATUS[b.est.status] : STATUS.no, quant: b ? b.q.tag : null, size_gb: b ? b.q.gb : null, est_decode_tps_short: b ? r1(b.est.decodeShort) : 0, est_decode_tps_full_context: b ? r1(b.est.decode) : 0, best_engine: top ? top.engine.name : null, _s: b ? b.est.status : 'no' };
  });
  const order = { ok: 0, tight: 1, ssd: 2, no: 3 };
  rows.sort((a, b) => (order[a._s] - order[b._s]) || (b.est_decode_tps_short - a.est_decode_tps_short));
  rows.forEach(r => delete r._s);
  return { hardware: compactBox(hw), settings: { context: o.ctx, users: o.users, min_quality }, models: rows, disclaimer: `Estimates ±30%. Data as of ${SHILA.DATA_DATE}. Any other Hugging Face model: call check_compatibility with its repo id.` };
}

async function cheapestHardware({ model, min_tokens_per_sec = 15, max_budget_usd = null, context = 32768, users = 1, min_quality = 'usable' }) {
  const m = await resolveModel(model);
  const o = { ctx: Number(context) || 32768, users: Number(users) || 1, floor: min_quality };
  const rows = SHILA.HARDWARE.map(hw => ({ hw, P: SHILA.plan(m, hw, o), price: SHILA.priceSort(hw) }))
    .filter(r => r.P.best && r.P.best.est.status !== 'ssd' && r.P.best.est.decodeShort >= Number(min_tokens_per_sec))
    .filter(r => !max_budget_usd || (r.price && r.price <= Number(max_budget_usd)))
    .sort((a, b) => (a.price || 1e12) - (b.price || 1e12))
    .map(r => ({ hardware: r.hw.name, id: r.hw.id, price: SHILA.priceText(r.hw), price_note: r.hw.priceNote, quant: r.P.best.q.tag, verdict: STATUS[r.P.best.est.status], est_decode_tps_short: r1(r.P.best.est.decodeShort), est_decode_tps_full_context: r1(r.P.best.est.decode), best_engine: (SHILA.rankEngines(r.hw, m, r.P.best, o)[0] || { engine: { name: null } }).engine.name }));
  return { model: m.name, requirement: { min_tokens_per_sec: Number(min_tokens_per_sec), max_budget_usd, context: o.ctx, users: o.users }, options: rows, note: rows.length ? 'Cheapest first. Prices are in USD: Indian listings from October 2026 (DRAM-shortage pricing) converted at ₹92/$ and marked ~, or US listings, unless marked estimated.' : 'No catalogued box meets this. Lower min_tokens_per_sec, the context, or the quality floor.' };
}

function listModels() {
  return SHILA.MODELS.map(m => ({ id: m.id, name: m.name, hf: m.hf, kind: m.kind, total_b: m.total, active_b: m.active, context_max: m.ctxMax, license: m.license, released: m.released, smallest_file_gb: Math.min(...m.quants.map(q => q.gb)), vision: m.vision }));
}
function listHardware() {
  return SHILA.HARDWARE.map(h => ({ id: h.id, group: h.group, name: h.name, ram_gb: h.ram, bandwidth_gbs: h.ramBwEff, gpu: h.gpu ? h.gpu.name + (h.gpu.vram ? ` ${h.gpu.vram} GB` : '') : null, unified: !!h.unified, price: SHILA.priceText(h) }));
}
function listEngines() {
  return SHILA.ENGINES.map(e => ({ name: e.name, kind: e.kind === 'specific' ? 'model-specific' : 'general', models: e.models || 'any supported architecture', license: e.license, url: e.url, api: e.api, concurrency: e.users, summary: e.blurb }));
}

module.exports = { checkCompatibility, whatCanRun, cheapestHardware, listModels, listHardware, listEngines, resolveModel, resolveHardware, parseSpecString, probe, SHILA, STATUS };
