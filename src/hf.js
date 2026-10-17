'use strict';
/*
 * Build a model entry for any Hugging Face repo from its config.json, the parameter count the
 * Hub reports, and the GGUF file listings of the usual quantizers.
 * Copyright 2026 Dr. Arvind Karthikeyan. Apache-2.0.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const HF = 'https://huggingface.co';
const CACHE_DIR = path.join(os.homedir(), '.shila', 'cache');
const TTL_MS = 7 * 24 * 3600 * 1000;

function headers() {
  const h = { 'user-agent': 'shila (github.com/arvidkarthik2000-hue/shila)' };
  if (process.env.HF_TOKEN) h.authorization = 'Bearer ' + process.env.HF_TOKEN;
  return h;
}
async function getJson(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: headers(), signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; } finally { clearTimeout(t); }
}

const QUANT_RE = /(UD-)?(QAD-)?(IQ[1-4]_(?:XXS|XS|S|M|NL)|Q[2-8]_K(?:_XL|_XXL|_[SML])?|Q[2-8]_[01]|Q8_0|BF16|F16|F32|MXFP4|NVFP4|TQ[12]_0)/i;
function quantTag(file) {
  const base = file.split('/').pop().replace(/-\d{5}-of-\d{5}\.gguf$/i, '').replace(/\.gguf$/i, '');
  const m = base.match(QUANT_RE);
  return m ? m[0].toUpperCase().replace('QAD-', 'QAD-') : null;
}

async function ggufListing(repo) {
  const tree = await getJson(`${HF}/api/models/${repo}/tree/main?recursive=true`);
  if (!Array.isArray(tree)) return [];
  const by = new Map();
  for (const f of tree) {
    if (f.type !== 'file' || !/\.gguf$/i.test(f.path) || /mmproj|mtp|draft|imatrix/i.test(f.path)) continue;
    const tag = quantTag(f.path); if (!tag) continue;
    const gb = (f.size || (f.lfs && f.lfs.size) || 0) / 1e9;
    by.set(tag, (by.get(tag) || 0) + gb);
  }
  return [...by.entries()].map(([tag, gb]) => ({ tag, gb: Math.round(gb * 100) / 100, fmt: tag === 'BF16' || tag === 'F16' ? 'gguf' : 'gguf', repo }));
}

function cacheGet(key) {
  try { const p = path.join(CACHE_DIR, key.replace(/[^\w.-]/g, '_') + '.json'); const st = fs.statSync(p); if (Date.now() - st.mtimeMs < TTL_MS) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { /* miss */ }
  return null;
}
function cachePut(key, val) {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(path.join(CACHE_DIR, key.replace(/[^\w.-]/g, '_') + '.json'), JSON.stringify(val)); } catch (e) { /* read-only home is fine */ }
}

// Standard llama.cpp bits per weight, used only when no GGUF repo is found.
const SYNTH = [['IQ3_XXS (computed)', 3.06], ['Q4_K_M (computed)', 4.85], ['Q6_K (computed)', 6.56], ['Q8_0 (computed)', 8.5]];

async function fetchModel(repo) {
  repo = repo.replace(/^https?:\/\/huggingface\.co\//, '').replace(/\/$/, '');
  const cached = cacheGet(repo); if (cached) return cached;
  const info = await getJson(`${HF}/api/models/${repo}`);
  if (!info) throw new Error(`Hugging Face has no public model "${repo}" (or it is gated: set HF_TOKEN)`);
  let cfg = await getJson(`${HF}/${repo}/raw/main/config.json`);
  if (!cfg) throw new Error(`"${repo}" has no config.json; give the original (non-GGUF) repo id`);
  const tc = cfg.text_config || cfg.llm_config || cfg.language_config || cfg;
  const total = (info.safetensors && info.safetensors.total) || 0;
  const layers = tc.num_hidden_layers || tc.n_layer || tc.num_layers || 32;
  const hidden = tc.hidden_size || tc.d_model || 4096;
  const heads = tc.num_attention_heads || 32;
  const kvHeads = tc.num_key_value_heads || heads;
  const headDim = tc.head_dim || Math.round(hidden / heads);
  // KV cache: full-attention layers grow with context; sliding-window layers are a fixed block.
  let attnLayers = layers, kvBytes, constStateGB = 0.05;
  const kvH = tc.num_global_key_value_heads || kvHeads, kvD = tc.global_head_dim || headDim;
  const kvMul = tc.attention_k_eq_v ? 1 : 2;
  if (Array.isArray(tc.layer_types)) {
    const full = tc.layer_types.filter(t => /full|global|^attention$/i.test(t)).length;
    const slide = tc.layer_types.filter(t => /slid|local/i.test(t)).length;
    attnLayers = full || layers;
    kvBytes = full * kvH * kvD * kvMul * 2;
    if (slide) constStateGB += slide * kvHeads * headDim * 2 * 2 * (tc.sliding_window || 4096) / 1e9;
  } else if (tc.full_attention_interval) {
    attnLayers = Math.ceil(layers / tc.full_attention_interval);
  }
  if (kvBytes == null) kvBytes = 2 * attnLayers * kvHeads * headDim * 2;
  const nExp = tc.num_experts || tc.num_local_experts || tc.n_routed_experts || 0;
  const k = tc.num_experts_per_tok || tc.top_k_experts || tc.moe_topk || tc.top_k || 0;
  const moeInter = tc.moe_intermediate_size || tc.expert_intermediate_size || tc.intermediate_size || 0;
  const denseLayers = tc.num_dense_layers || tc.first_k_dense_replace || 0;
  // the input-embedding table is looked up, not read in full, so it does not count as active
  const embed = (tc.vocab_size || 0) * hidden * (tc.tie_word_embeddings ? 0 : 1);
  let active = (total - embed) / 1e9, kind = 'dense', expertWeightFrac, expertActiveFrac;
  if (nExp > 1 && k) {
    kind = 'moe';
    const expertParams = (layers - denseLayers) * nExp * 3 * hidden * moeInter;
    const totalB = total || expertParams * 1.1;
    const activeParams = totalB - embed - expertParams * (1 - k / nExp);
    active = activeParams / 1e9;
    expertWeightFrac = Math.min(0.97, expertParams / totalB);
    expertActiveFrac = Math.min(0.9, (expertParams * k / nExp) / activeParams);
  }
  const totalB = (total || active * 1e9) / 1e9;
  const name = repo.split('/')[1];
  const org = repo.split('/')[0];
  const candidates = [`${repo}-GGUF`, `unsloth/${name}-GGUF`, `bartowski/${org}_${name}-GGUF`, `ggml-org/${name}-GGUF`, `lmstudio-community/${name}-GGUF`];
  let quants = [];
  for (const c of candidates) { const l = await ggufListing(c); if (l.length) { quants = quants.concat(l.filter(q => !quants.some(x => x.tag === q.tag))); } if (quants.length >= 6) break; }
  if (!quants.length) quants = SYNTH.map(([tag, b]) => ({ tag, gb: Math.round(totalB * b / 8 * 100) / 100, fmt: 'gguf', repo: '(no GGUF repo found; size computed)' }));
  quants.sort((a, b) => a.gb - b.gb);
  const model = {
    id: repo.toLowerCase(), name, vendor: org, hf: repo, family: 'Hugging Face',
    total: Math.round(totalB * 100) / 100, active: Math.round(active * 100) / 100, kind, layers, attnLayers,
    kvBytes, constStateGB: Math.round(constStateGB * 100) / 100,
    expertWeightFrac, expertActiveFrac,
    ctxMax: tc.max_position_embeddings || 32768,
    released: (info.createdAt || '').slice(0, 10), license: (info.cardData && (info.cardData.license_name || info.cardData.license)) || 'see model card',
    reasoning: 'see model card', vision: !!(cfg.vision_config || /vl|vision/i.test(cfg.model_type || '')), mmprojGB: cfg.vision_config ? 0.9 : 0,
    arch: `${cfg.model_type || 'unknown'}: ${layers} layers, ${attnLayers} with a growing KV cache, ${kvH} KV heads × ${kvD}` + (kind === 'moe' ? `, ${nExp} experts top-${k}` : ''),
    why: 'Read live from Hugging Face; estimates use the same formulas as the curated models.',
    quants, anchors: [], support: {}, fromHub: true,
  };
  if (!total) model.arch += ' (parameter count estimated: the Hub did not report one)';
  cachePut(repo, model);
  return model;
}

module.exports = { fetchModel, ggufListing, quantTag };
