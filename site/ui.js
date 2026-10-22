/* SHILA UI */
(() => {
  const $ = (id) => document.getElementById(id);
  const S = window.createShila(window.SHILA_DATA);
  const B = window.ShilaBox;
  const CTX = [4096, 8192, 16384, 32768, 65536, 131072, 262144];
  const USERS = [1, 2, 4, 8];
  const FLOORS = [['any', 'Any'], ['usable', '3-bit+'], ['good', '4-bit+'], ['excellent', '5-bit+']];

  const state = { customSpec: 'RTX 3060 12GB, 32GB DDR4, Windows', hwId: 'ser8-32', modelId: 'lfm25-24b', ctx: 32768, users: 1, floor: 'any', kv8: false, vision: false, wired: true, lazy: true, tab: 'fit', ov: {} };
  try { const saved = JSON.parse(localStorage.getItem('shila.state') || 'null'); if (saved && typeof saved === 'object') Object.assign(state, saved); } catch (e) { /* storage unavailable */ }
  const save = () => { try { localStorage.setItem('shila.state', JSON.stringify(state)); } catch (e) { /* ignore */ } };

  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const f1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
  const fgb = (n) => (n >= 100 ? Math.round(n) : f1(n)) + ' GB';
  const tok = (n) => n <= 0 ? '—' : (n < 10 ? f1(n) : Math.round(n).toLocaleString('en-IN'));
  const opts = () => ({ ctx: state.ctx, users: state.users, kv8: state.kv8, vision: state.vision, wired: state.wired, tableLazy: state.lazy, floor: state.floor });
  const STATUS_TXT = { ok: 'Runs well', tight: 'Runs, little headroom', ssd: 'Runs slowly from SSD', no: 'Does not fit', na: 'Not for this hardware' };

  function currentHw() {
    let base = S.HARDWARE.find(h => h.id === state.hwId) || S.HARDWARE[0];
    if (state.hwId === 'custom') {
      const spec = B.parseSpecString(state.customSpec || '') || { ram_gb: 16 };
      base = B.describeBox(spec); base.name = 'Your machine: ' + (state.customSpec || '16 GB'); base.group = 'Custom';
    }
    const hw = JSON.parse(JSON.stringify(base));
    const ov = state.ov[state.hwId] || {};
    if (ov.ram) hw.ram = ov.ram;
    if (ov.ramBw) { hw.ramBw = ov.ramBw; hw.ramBwEff = ov.ramBw; }
    if (hw.gpu && hw.gpu.kind === 'dgpu') { if (ov.vram != null) hw.gpu.vram = ov.vram; if (ov.vramBw) hw.gpu.vramBw = ov.vramBw; }
    if (ov.os) hw.os = ov.os;
    if (ov.price) { hw.priceUsd = [ov.price, ov.price]; hw.priceInr = null; hw.priceNote = 'your price'; hw.estimate = false; }
    hw.edited = Object.keys(ov).length > 0;
    return hw;
  }
  const currentModel = () => S.MODELS.find(m => m.id === state.modelId) || S.MODELS[0];

  /* ---------- rail ---------- */
  function buildSelects() {
    const groups = [...new Set(S.HARDWARE.map(h => h.group))];
    $('hwSel').innerHTML = '<optgroup label="Your machine"><option value="custom">Describe your machine…</option></optgroup>' + groups.map(g => `<optgroup label="${esc(g)}">` + S.HARDWARE.filter(h => h.group === g).map(h => `<option value="${h.id}">${esc(h.name)}</option>`).join('') + '</optgroup>').join('');
    const fams = [...new Set(S.MODELS.map(m => m.family))];
    $('mSel').innerHTML = fams.map(g => `<optgroup label="${esc(g)}">` + S.MODELS.filter(m => m.family === g).map(m => `<option value="${m.id}">${esc(m.name)} · ${m.kind === 'moe' ? `${m.total}B / ${m.active}B active` : `${m.total}B dense`}</option>`).join('') + '</optgroup>').join('');
    $('ctxSeg').innerHTML = CTX.map(c => `<button type="button" data-v="${c}">${c >= 1024 ? (c / 1024) + 'K' : c}</button>`).join('');
    $('usersSeg').innerHTML = USERS.map(u => `<button type="button" data-v="${u}">${u}</button>`).join('');
    $('floorSeg').innerHTML = FLOORS.map(([v, l]) => `<button type="button" data-v="${v}">${l}</button>`).join('');
  }
  function syncRail() {
    $('hwSel').value = state.hwId; $('mSel').value = state.modelId;
    $('customWrap').hidden = state.hwId !== 'custom';
    if (document.activeElement !== $('customSpec')) $('customSpec').value = state.customSpec || '';
    for (const b of $('ctxSeg').children) b.setAttribute('aria-pressed', String(+b.dataset.v === state.ctx));
    for (const b of $('usersSeg').children) b.setAttribute('aria-pressed', String(+b.dataset.v === state.users));
    for (const b of $('floorSeg').children) b.setAttribute('aria-pressed', String(b.dataset.v === state.floor));
    $('optKv8').checked = state.kv8; $('optVision').checked = state.vision; $('optWired').checked = state.wired; $('optLazy').checked = state.lazy;
    const hw = currentHw(), m = currentModel();
    $('optLazyWrap').hidden = m.id !== 'flash-next';
    $('optWired').parentElement.hidden = !(hw.gpu && hw.gpu.kind === 'apple');
    $('optVision').parentElement.hidden = !m.vision;
    const ov = state.ov[state.hwId] || {};
    $('eRam').value = ov.ram || hw.ram; $('eRamBw').value = ov.ramBw || hw.ramBwEff;
    $('eVram').value = hw.gpu && hw.gpu.kind === 'dgpu' ? hw.gpu.vram : ''; $('eVramBw').value = hw.gpu && hw.gpu.kind === 'dgpu' ? hw.gpu.vramBw : '';
    $('eVram').disabled = $('eVramBw').disabled = !(hw.gpu && hw.gpu.kind === 'dgpu');
    $('eOs').value = hw.os; $('ePrice').value = ov.price || '';
    $('boxPrice').textContent = hw.priceInr || hw.priceUsd ? S.priceText(hw) : (hw.priceNote || '');
    const gpuTxt = hw.gpu ? (hw.gpu.kind === 'dgpu' ? `${hw.gpu.name} · ${hw.gpu.vram} GB · ${hw.gpu.vramBw} GB/s` : hw.gpu.name) : 'no GPU';
    $('hwChips').innerHTML = [`${hw.ram} GB ${hw.unified ? 'unified' : 'RAM'}`, `${hw.ramBwEff} GB/s${hw.ramBwEff !== hw.ramBw ? ' (measured; ' + hw.ramBw + ' spec)' : ''}`, gpuTxt, hw.os, hw.edited ? 'edited' : ''].filter(Boolean).map(t => `<span class="chip">${esc(t)}</span>`).join('');
    $('hwNote').textContent = (hw.notes || '') + (hw.priceNote && (hw.priceInr || hw.priceUsd) ? ` Price: ${hw.priceNote}.` : '') + (hw.assumptions && hw.assumptions.length ? ' Assumed: ' + hw.assumptions.join('; ') + '.' : '');
    $('mChips').innerHTML = [m.kind === 'moe' ? `${m.total}B total · ${m.active}B active` : `${m.total}B dense`, `${m.layers} layers`, `KV ${(m.kvBytes / 1024).toFixed(0)} KB/token`, `${(m.ctxMax / 1024).toFixed(0)}K context`, m.vision ? 'vision' : 'text only', m.license, m.released].map(t => `<span class="chip">${esc(t)}</span>`).join('');
    $('mWhy').innerHTML = `${esc(m.why)} <span class="muted">${esc(m.arch)}</span> <a href="https://huggingface.co/${esc(m.hf)}" target="_blank" rel="noopener">model card ↗</a>`;
  }

  /* ---------- fit report ---------- */
  function memBar(est, cap) {
    const w = est.mainGB || 0, k = est.kvGB || 0, o = est.ovhGB || 0, total = Math.max(cap || 0, w + k + o, 0.001);
    const pct = (x) => (100 * x / total).toFixed(1) + '%';
    return `<div class="memline"><div class="bar"><i class="w" style="width:${pct(w)}"></i><i class="k" style="width:${pct(k)}"></i><i class="o" style="width:${pct(o)}"></i></div>
      <div class="legend"><span><i style="background:var(--accent)"></i>weights ${fgb(w)}</span><span><i style="background:var(--info)"></i>KV cache ${fgb(k)}</span><span><i style="background:var(--ink-3)"></i>runtime ${fgb(o)}</span><span class="muted">${cap ? 'of ' + fgb(cap) + ' available' : ''}${est.ssdGB ? ' · ' + fgb(est.ssdGB) + ' on SSD' : ''}</span></div></div>`;
  }
  function anchorsHtml(m, hw, limit) {
    const list = m.anchors.slice(0, limit || 99);
    if (!list.length) return '<div class="muted">No published measurements collected for this model yet.</div>';
    return `<div class="anchors">${list.map(a => `<div class="a${a.hwId === hw.id ? ' hit' : ''}"><b>${tok(a.toks)} tok/s</b><span>${esc(a.hw)}</span><span class="muted">${esc(a.quant)} · ${esc(a.engine)}</span><a href="${esc(a.src)}" target="_blank" rel="noopener">${esc(a.by)} ↗</a></div>`).join('')}</div>`;
  }
  function renderFit() {
    const hw = currentHw(), m = currentModel(), o = opts();
    const P = S.plan(m, hw, o);
    const best = P.best;
    const R = best ? S.rankEngines(hw, m, best, o) : S.rankEngines(hw, m, null, o);
    const topEngine = R[0];
    const v = $('verdict');
    if (!best) {
      const smallest = P.rows.filter(r => r.est.status !== 'na').sort((a, b) => a.q.gb - b.q.gb)[0];
      const capTxt = smallest && smallest.est.capacityGB ? `${fgb(smallest.est.usedGB || smallest.est.need)} needed vs ${fgb(smallest.est.capacityGB)} available` : '';
      v.className = 'verdict no';
      v.innerHTML = `<span class="status no">${STATUS_TXT.no}</span><h2>${esc(m.name)} does not fit ${esc(hw.name)}</h2>
        <p style="margin:0;color:var(--ink-2)">Even the smallest usable file (${smallest ? esc(smallest.q.tag) + ', ' + fgb(smallest.q.gb) : '—'}) needs more memory than this box has${capTxt ? ' (' + capTxt + ')' : ''}. Lower the quality floor, reserve less context, pick a smaller model from the <a href="#" data-goto="box">What this box runs</a> tab, or a bigger box from <a href="#" data-goto="cheapest">Cheapest box</a>.</p>
        <div class="eyebrow">Published measurements for this model</div>${anchorsHtml(m, hw, 6)}`;
    } else {
      const e = best.est, q = best.q;
      v.className = 'verdict ' + e.status;
      const promptSec = e.prefill > 0 ? state.ctx / e.prefill : 0;
      const engineLine = topEngine ? `<a href="#engines-list">${esc(topEngine.engine.name)}</a>` : '—';
      const headline = e.status === 'ok' ? `${m.name} runs well on this box` : e.status === 'tight' ? `${m.name} fits, with little headroom` : `${m.name} runs here, but streams from the SSD`;
      const measuredHere = m.anchors.filter(a => a.hwId === hw.id);
      v.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center"><span class="status ${e.status}">${STATUS_TXT[e.status]}</span><span class="chip">${esc(S.placementLabel(e.placement))}</span>${hw.priceInr || hw.priceUsd ? `<span class="chip">${esc(S.priceText(hw))}</span>` : ''}</div>
        <h2>${esc(headline)}</h2>
        <p style="margin:0;color:var(--ink-2)">Recommended file: <b>${esc(q.tag)}</b> (${fgb(q.gb)}, ${esc(best.tier.label)}${q.note ? ' — ' + esc(q.note) : ''}) from <span class="mono">${esc(q.repo)}</span>. Best engine here: ${engineLine}.${P.fastest && P.fastest.q !== q ? ` Fastest that still fits: ${esc(P.fastest.q.tag)} at ~${tok(P.fastest.est.decodeShort)} tok/s.` : ''}</p>
        <div class="stats">
          <div class="stat"><div class="v">~${tok(e.decodeShort)} <small>tok/s</small></div><div class="k">decode, short chats (estimate)</div></div>
          <div class="stat"><div class="v">~${tok(e.decode)} <small>tok/s</small></div><div class="k">decode with ${(state.ctx / 1024).toFixed(0)}K of context in play</div></div>
          <div class="stat"><div class="v">~${tok(e.prefill)} <small>tok/s</small></div><div class="k">prompt reading · a ${(state.ctx / 1024).toFixed(0)}K prompt ≈ ${promptSec >= 60 ? (promptSec / 60).toFixed(1) + ' min' : Math.round(promptSec) + ' s'}</div></div>
          <div class="stat"><div class="v">${fgb(e.usedGB || e.need)}</div><div class="k">memory used${e.capacityGB ? ' of ' + fgb(e.capacityGB) : ''}</div></div>
        </div>
        ${memBar(e, e.capacityGB)}
        ${e.notes.length ? `<ul class="tight">${e.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
        <div class="eyebrow">Published measurements${measuredHere.length ? ' — this box is highlighted' : ''}</div>${anchorsHtml(m, hw, 7)}
        <div class="note">Estimates come from a bandwidth model calibrated on the cited numbers (±30%). Drafting (MTP/DFlash/DSpark) is extra: 1.5–2.5× on dense models, ~1.2× on MoEs.</div>`;
    }
    v.querySelectorAll('[data-goto]').forEach(a => a.addEventListener('click', (ev) => { ev.preventDefault(); setTab(a.dataset.goto); }));

    // ladder
    const rows = P.rows.slice().sort((a, b) => a.q.gb - b.q.gb);
    $('ladder').innerHTML = `<thead><tr><th>Quant</th><th>Repo</th><th class="num">Size</th><th>Quality</th><th>Placement</th><th class="num">Short</th><th class="num">Full ctx</th><th class="num">Prompt</th><th class="num">Memory</th><th>Status</th></tr></thead><tbody>` +
      rows.map(r => {
        const e = r.est, isPick = best && r.q === best.q, dim = e.status === 'no' || e.status === 'na';
        const maxTok = Math.max(...rows.map(x => x.est.decodeShort || 0), 1);
        return `<tr class="${isPick ? 'pick' : ''}${dim ? ' dim' : ''}"><td><b>${esc(r.q.tag)}</b>${r.q.qat ? ' <span class="tier t4">QAT</span>' : ''}${r.q.note ? `<div class="note">${esc(r.q.note)}</div>` : ''}</td><td class="mono" style="font-size:12px">${esc(r.q.repo)}</td><td class="num">${fgb(r.q.gb)}</td><td><span class="tier t${r.tier.rank}">${esc(r.tier.label)}</span> <span class="muted num">${S.bpw(m, r.q).toFixed(1)} bpw</span></td><td>${esc(S.placementLabel(e.placement))}${e.notes && e.notes.length && !dim ? `<div class="note">${esc(e.notes[0])}</div>` : ''}${dim && e.notes && e.notes.length ? `<div class="note">${esc(e.notes[0])}</div>` : ''}</td><td class="num">${dim ? '—' : `<span class="spark" style="width:${Math.max(4, 60 * (e.decodeShort || 0) / maxTok)}px"></span>${tok(e.decodeShort)}`}</td><td class="num">${dim ? '—' : tok(e.decode)}</td><td class="num">${dim ? '—' : tok(e.prefill)}</td><td class="num">${dim ? fgb(e.need || r.q.gb) : fgb(e.usedGB || e.need)}</td><td><span class="status ${e.status}">${STATUS_TXT[e.status]}</span></td></tr>`;
      }).join('') + '</tbody>';

    // engines
    const good = R.filter(x => x.score >= 25), poor = R.filter(x => x.score < 25);
    $('engines').id = 'engines';
    $('engines').innerHTML = `<div id="engines-list"></div>` + good.map((x, i) => {
      const e = x.engine;
      return `<article class="engine${i === 0 ? ' top' : ''}">
        <header><span class="rank">${i === 0 ? 'BEST MATCH' : '#' + (i + 1)}</span><h3>${esc(e.name)}</h3><span class="kind ${e.kind}">${e.kind === 'specific' ? 'model-specific' : 'general'}</span><span class="muted" style="font-size:12px">${esc(e.license)}</span><a href="${esc(e.url)}" target="_blank" rel="noopener" style="font-size:12.5px">repo ↗</a></header>
        <p>${esc(e.blurb)}</p>
        <div class="two">
          <div>${x.why.length ? `<div class="eyebrow">Why here</div><ul class="tight">${x.why.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}</div>
          <div>${x.caveats.length ? `<div class="eyebrow">Mind</div><ul class="tight">${x.caveats.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}</div>
        </div>
        ${x.anchors.length ? `<div class="eyebrow">Measured with this engine</div>${anchorsHtml({ anchors: x.anchors }, hw, 4)}` : ''}
        <div class="eyebrow">Install & run</div>
        <div class="cmd"><button class="btn small" type="button" data-copy>Copy</button><pre>${esc(x.cmd)}</pre></div>
        <div class="note">API: ${esc(e.api)} · ${esc(e.users)}</div>
      </article>`;
    }).join('') + (poor.length ? `<div class="note">Not practical for this combination: ${poor.map(x => `<b>${esc(x.engine.name)}</b> (${esc(x.caveats[0] || 'does not apply')})`).join(' · ')}</div>` : '');
    $('engines').querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => copyText(b.nextElementSibling.textContent)));
  }

  /* ---------- box report ---------- */
  function renderBox() {
    const hw = currentHw(), o = opts();
    $('boxReportH').textContent = `What ${hw.name} can run`;
    const rows = S.MODELS.map(m => { const P = S.plan(m, hw, o); const R = P.best ? S.rankEngines(hw, m, P.best, o) : []; return { m, P, top: R[0] }; });
    const order = { ok: 0, tight: 1, ssd: 2, no: 3 };
    rows.sort((a, b) => { const sa = a.P.best ? a.P.best.est.status : 'no', sb = b.P.best ? b.P.best.est.status : 'no'; return (order[sa] - order[sb]) || ((b.P.best ? b.P.best.est.decodeShort : 0) - (a.P.best ? a.P.best.est.decodeShort : 0)); });
    $('boxTable').innerHTML = `<thead><tr><th>Model</th><th>Pick</th><th class="num">Size</th><th>Placement</th><th class="num">Short</th><th class="num">Full ctx</th><th class="num">Prompt</th><th>Status</th><th>Best engine</th></tr></thead><tbody>` + rows.map(({ m, P, top }) => {
      const b = P.best;
      if (!b) return `<tr class="dim"><td><b>${esc(m.name)}</b></td><td colspan="6">no quant fits (${fgb(Math.min(...m.quants.map(q => q.gb)))} smallest)</td><td><span class="status no">Does not fit</span></td><td></td></tr>`;
      const e = b.est;
      return `<tr><td><b>${esc(m.name)}</b><div class="note">${m.kind === 'moe' ? m.active + 'B active' : 'dense'}</div></td><td>${esc(b.q.tag)} <span class="tier t${b.tier.rank}">${esc(b.tier.label)}</span></td><td class="num">${fgb(b.q.gb)}</td><td>${esc(S.placementLabel(e.placement))}</td><td class="num">${tok(e.decodeShort)}</td><td class="num">${tok(e.decode)}</td><td class="num">${tok(e.prefill)}</td><td><span class="status ${e.status}">${STATUS_TXT[e.status]}</span></td><td>${top ? esc(top.engine.name) : ''}</td></tr>`;
    }).join('') + '</tbody>';
  }

  /* ---------- cheapest box ---------- */
  function renderCheapest() {
    const m = currentModel(), o = opts();
    $('cheapH').textContent = `Cheapest box for ${m.name}`;
    const rows = S.HARDWARE.map(hw => ({ hw, P: S.plan(m, hw, o), price: S.priceSort(hw) }));
    rows.sort((a, b) => (a.price || 1e12) - (b.price || 1e12));
    let flagged = false;
    $('cheapTable').innerHTML = `<thead><tr><th>Box</th><th class="num">Price</th><th>Pick</th><th>Placement</th><th class="num">Short</th><th class="num">Full ctx</th><th class="num">Prompt</th><th>Status</th></tr></thead><tbody>` + rows.map(({ hw, P }) => {
      const b = P.best;
      const price = S.priceText(hw);
      if (!b) return `<tr class="dim"><td>${esc(hw.name)}</td><td class="num">${esc(price)}</td><td colspan="5">no quant fits</td><td><span class="status no">Does not fit</span></td></tr>`;
      const e = b.est; let cls = '';
      if (!flagged && e.status === 'ok' && e.decodeShort >= 20 && S.priceSort(hw)) { cls = 'pick'; flagged = true; }
      return `<tr class="${cls}"><td><b>${esc(hw.name)}</b>${cls ? '<div class="note">cheapest comfortable pick (≥20 tok/s, headroom, priced)</div>' : ''}</td><td class="num">${esc(price)}</td><td>${esc(b.q.tag)} <span class="tier t${b.tier.rank}">${esc(b.tier.label)}</span></td><td>${esc(S.placementLabel(e.placement))}</td><td class="num">${tok(e.decodeShort)}</td><td class="num">${tok(e.decode)}</td><td class="num">${tok(e.prefill)}</td><td><span class="status ${e.status}">${STATUS_TXT[e.status]}</span></td></tr>`;
    }).join('') + '</tbody>';
  }

  /* ---------- atlas ---------- */
  const ATLAS = [
    ['llama.cpp', 'general', 'thousands incl. all 13 here', 'NVIDIA · AMD · Intel · Apple · CPU', 'GGUF (incl. NVFP4 type)', 'brew / winget / releases', 'https://github.com/ggml-org/llama.cpp'],
    ['Ollama', 'general', 'library + any hf.co GGUF', 'NVIDIA · AMD · Apple (MLX) · CPU · Vulkan', 'GGUF · MLX', 'installer', 'https://ollama.com'],
    ['LM Studio', 'general', 'GGUF + MLX catalogs', 'NVIDIA · AMD · Intel · Apple', 'GGUF · MLX (+ Splash backend)', 'installer', 'https://lmstudio.ai'],
    ['Docker Model Runner', 'general', 'any GGUF (OCI)', 'as llama.cpp / vLLM', 'GGUF', 'Docker Desktop', 'https://docs.docker.com/ai/model-runner/'],
    ['ik_llama.cpp', 'general', 'llama.cpp set + IQ*_K quants', 'CPU · CUDA', 'GGUF', 'source', 'https://github.com/ikawrakow/ik_llama.cpp'],
    ['vLLM', 'general', 'day-0 Qwen3.8, LFM2.5, Gemma 4, Nemotron', 'NVIDIA (consumer needs whole model in VRAM) · AMD Instinct', 'safetensors BF16/FP8/NVFP4/AWQ', 'pip / Docker', 'https://github.com/vllm-project/vllm'],
    ['vLLM-Metal', 'general', 'MLX-format models', 'Apple', 'MLX safetensors', 'brew', 'https://docs.vllm.ai/projects/vllm-metal'],
    ['SGLang', 'general', 'Qwen3.8, LFM2.5 (+DSpark), Gemma 4, Nemotron', 'NVIDIA (SM120 ok) · Intel Xeon CPU', 'BF16/FP8/NVFP4', 'pip / Docker', 'https://github.com/sgl-project/sglang'],
    ['TensorRT-LLM / Dynamo', 'general', 'datacenter catalog', 'NVIDIA Linux, datacenter-first', 'TRT engines, NVFP4', 'pip', 'https://github.com/NVIDIA/TensorRT-LLM'],
    ['mlx-lm', 'general', 'any MLX quant', 'Apple', 'MLX', 'pip', 'https://github.com/ml-explore/mlx-lm'],
    ['mlx-dspark', 'general', 'MLX + DSpark/DFlash drafters', 'Apple', 'MLX', 'pip', 'https://github.com/ARahim3/mlx-dspark'],
    ['oMLX', 'general', 'MLX incl. Flash-Next + MTP', 'Apple', 'MLX', 'source', 'https://github.com/jundot/omlx'],
    ['ExLlamaV3', 'general', 'Lfm2Moe, Gemma 4, Flash-Next, Qwen3.8-27B (community)', 'NVIDIA (early ROCm)', 'EXL3', 'pip', 'https://github.com/turboderp-org/exllamav3'],
    ['KTransformers', 'general', 'DeepSeek V3/V4, Kimi K2, Qwen3-MoE, GLM-5 (not Qwen3.6/3.8, Gemma 4, LFM)', 'GPU + big-RAM CPU (AMX/AVX-512/AVX2)', 'safetensors', 'pip', 'https://github.com/kvcache-ai/ktransformers'],
    ['mistral.rs', 'general', 'Gemma 4 and others (Qwen3.8/LFM not listed)', 'CUDA · Metal · CPU', 'safetensors · GGUF · UQFF', 'cargo', 'https://github.com/EricLBuehler/mistral.rs'],
    ['AMD Lemonade', 'general', 'llama.cpp set + NPU models', 'AMD Ryzen AI / Strix Halo', 'GGUF', 'installer / pip', 'https://github.com/lemonade-sdk/lemonade'],
    ['FastFlowLM (ROCm)', 'general', 'NPU builds incl. Gemma 4', 'AMD XDNA2 NPUs', 'own', 'MSI', 'https://github.com/FastFlowLM/FastFlowLM'],
    ['OpenVINO GenAI', 'general', 'Intel exports (LFM2-24B INT4 preview)', 'Intel CPU / iGPU / NPU', 'OpenVINO IR', 'pip', 'https://github.com/openvinotoolkit/openvino.genai'],
    ['Qualcomm GenieX (ex-Nexa)', 'general', 'GGUF via llama.cpp + QAIRT', 'Snapdragon NPU', 'GGUF · QAIRT', 'SDK', 'https://github.com/NexaAI/nexa-sdk'],
    ['WebLLM', 'general', 'Qwen3.5 ≤9B class', 'any browser with WebGPU', 'MLC', 'npm', 'https://github.com/mlc-ai/web-llm'],
    ['TensorFold', 'general', 'Qwen3.8-27B, Flash-Next, Gemma-4-26B, GLM-5.3, DeepSeek-V4-Flash', 'Apple · NVIDIA cc≥8.9', 'MLX · NVFP4 · EXL3', 'source', 'https://github.com/ashhart/TensorFold'],
    ['Strata', 'specific', 'Qwen3.8-Flash-Next', 'NVIDIA RTX 20–50 ≥12 GB · AMD RX 6800+/7700+/9060+ · 32–64 GB RAM', 'GGUF (ISTA GSQ-RCO, Unsloth)', 'one-click', 'https://github.com/Niko1221/Strata'],
    ['Basalt', 'specific', 'Qwen3.8-Flash-Next', 'Linux + Blackwell (sm_120)', '.basalt packs', 'source', 'https://github.com/jesdga95/basalt'],
    ['NInfer', 'specific', 'Qwen3.6-27B, Qwen3.8-27B, Qwen3.6-35B-A3B', 'RTX 5090 only, Linux', '.ninfer (NVFP4 / groupwise-int)', 'source', 'https://github.com/Neroued/ninfer'],
    ['Infernix', 'specific', 'Qwen3.8-27B, Flash-Next (+uncensored, Swift)', 'RTX 50-series, Windows/Linux', '.infernix / .ninfer (NVFP4)', 'release zip / source', 'https://github.com/Wallawalla47/Infernix'],
    ['lithos-metal', 'specific', 'Qwen3.8-27B (NVFP4, 4-bit), Qwen3.6-35B-A3B (experimental)', 'Apple M3+ · macOS 26+', 'NVFP4 safetensors · MLX 4-bit', 'brew', 'https://github.com/lithos-ai/lithos-metal'],
    ['Splash', 'specific', 'Qwen3.8-27B, Qwen3.6-35B-A3B', 'Apple M3+ · macOS 26.4+ · 36 GB+', 'own packs', 'brew', 'https://github.com/incoai/splash'],
    ['ds4 / DwarfStar', 'specific', 'DeepSeek V4/V4.1, GLM 5.2/5.3, Flash-Next', 'Metal · CUDA (Spark) · ROCm (Strix Halo)', 'own (SSD-streamed experts)', 'make', 'https://github.com/antirez/ds4'],
    ['q27 / Quasar', 'specific', 'Qwen3.8-27B, Qwen3.6-27B, Bonsai-2 27B', 'NVIDIA · Metal', 'own 4-bit', 'make', 'https://github.com/signalnine/q27'],
    ['q36 / QuarkStar', 'specific', 'Qwen3.6-35B-A3B, Qwen3.8-27B', 'Vulkan · Metal, 16 GB class', 'own 2/4-bit', 'source', 'https://github.com/rjohny55/q36'],
    ['qwen27-engine', 'specific', 'Qwen3.8-27B', '2× RTX 5060 Ti, Windows', 'GGUF IQ3_S + MTP', 'source', 'https://github.com/avallavall/qwen27-engine'],
    ['QwFNfer', 'specific', 'Flash-Next', 'RTX 4080 SUPER 16 GB + 30 GB RAM + NVMe', 'GGUF', 'source', 'https://github.com/Apolog1ze-Dev/QwFNfer'],
    ['qwen-flash-next-8gb', 'specific', 'Flash-Next NVFP4', 'RTX 5060 8 GB + Gen5 NVMe', 'NVFP4', 'source', 'https://github.com/helgard-orlm/qwen-flash-next-8gb'],
    ['gewell', 'specific', 'Gemma 4 31B', 'Blackwell sm_120', 'own', 'source', 'https://github.com/leDissolution/gewell'],
    ['AIMA-AMD395', 'specific', 'Qwen3.6-35B-A3B BF16', 'Strix Halo, Windows HIP', 'BF16', 'source', 'https://github.com/Approaching-AI/AIMA-AMD395-Qwen36-35B-Windows-Engine'],
    ['TokenSpeed (LightSeek)', 'general', 'Qwen3.8 / Flash-Next day-0', 'datacenter', '—', 'enterprise', 'https://github.com/lightseekorg/tokenspeed'],
  ];
  function renderAtlas() {
    $('atlas').innerHTML = `<thead><tr><th>Engine</th><th>Scope</th><th>Runs</th><th>Hardware</th><th>Formats</th><th>Install</th></tr></thead><tbody>` + ATLAS.map(r => `<tr><td><a href="${esc(r[6])}" target="_blank" rel="noopener"><b>${esc(r[0])}</b></a></td><td><span class="kind ${r[1]}">${r[1] === 'specific' ? 'model-specific' : 'general'}</span></td><td>${esc(r[2])}</td><td>${esc(r[3])}</td><td>${esc(r[4])}</td><td>${esc(r[5])}</td></tr>`).join('') + '</tbody>';
  }

  /* ---------- sources ---------- */
  function renderSources() {
    const urls = new Map();
    const add = (u, label) => { if (u && !urls.has(u)) urls.set(u, label); };
    for (const m of S.MODELS) { add('https://huggingface.co/' + m.hf, m.name + ' model card'); for (const a of m.anchors) add(a.src, `${m.name}: ${a.by} (${a.hw})`); }
    for (const e of S.ENGINES) add(e.url, e.name + ' repository');
    [['https://www.lithosai.com/blog/lithos-metal', 'LithosAI: Open-sourcing lithos-metal (8 Oct 2026)'], ['https://huggingface.co/blog/LiquidAI/lfm25-24b-a2b', 'Liquid AI: LFM2.5-24B-A2B release post (13 Oct 2026)'], ['https://huggingface.co/LiquidAI/LFM2.5-24B-A2B-GGUF', 'LFM2.5-24B-A2B GGUF sizes'], ['https://huggingface.co/unsloth/Qwen3.8-Flash-Next-GGUF', 'Flash-Next GGUF sizes and n-gram table discussions'], ['https://github.com/ggml-org/llama.cpp/releases/tag/v0.6.0', 'llama.cpp v0.6.0 release'], ['https://github.com/ggml-org/llama.cpp/pull/29887', 'llama.cpp expert cache PR'], ['https://www.hardware-corner.net/qwen3-8-27b-hardware-tests/', 'hardware-corner Qwen3.8-27B tests'], ['https://github.com/geerlingguy/ai-benchmarks', 'Jeff Geerling ai-benchmarks (Pi, N150, Jetson)'], ['https://byteshape.com/blogs/Qwen3-30B-A3B-Instruct-2507/', 'ByteShape: Qwen3-30B-A3B on a Pi 5 16 GB'], ['https://kofler.info/gpt-oss-20b-auf-einer-igpu-780m-ausfuehren/', 'kofler.info: gpt-oss-20b on a Radeon 780M'], ['https://github.com/ggml-org/llama.cpp/discussions/27519', 'llama.cpp discussion: Qwen3.6-35B-A3B on UM790 Pro'], ['https://grigio.org/benchmarking-llama-cpp-backends-on-intel-panther-lake-vulkan-vs-sycl-vs-openvino-vs-cpu/', 'grigio.org: Panther Lake backends'], ['https://github.com/visorcraft/strix-halo-llm-perf', 'visorcraft: Strix Halo LLM performance'], ['https://raw.githubusercontent.com/ggml-org/llama.cpp/master/benches/dgx-spark/dgx-spark.md', 'llama.cpp DGX Spark benchmarks'], ['https://www.macrumors.com/2026/08/25/apple-announces-2026-mac-mini/', 'MacRumors: 2026 Mac mini (M6 / M5 Pro)'], ['https://www.tomshardware.com/raspberry-pi/component-shortages-drive-raspberry-pi-prices-up-by-up-to-23-percent-escalating-lpddr4-lpddr5-costs-trigger-the-third-price-hike-of-the-year', "Tom's Hardware: 2026 memory-shortage price hikes"], ['https://pricehistory.app/p/gmktec-evo-x2-ai-mini-pc-ryzen-whO3Vxmb', 'GMKtec EVO-X2 Amazon.in price history'], ['https://price-history.in/product/nvidia-dgx-spark-20-core-arm-DdCsTGSj', 'DGX Spark Amazon.in price history'], ['https://arxiv.org/pdf/2605.19537', 'The Silent Hyperparameter: a survey of 200 inference engines (Jan 2026)']].forEach(([u, l]) => add(u, l));
    $('sources').innerHTML = [...urls.entries()].map(([u, l]) => `<div>${esc(l)} — <a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a></div>`).join('');
  }

  /* ---------- copy plan ---------- */
  function planMarkdown() {
    const hw = currentHw(), m = currentModel(), o = opts();
    const P = S.plan(m, hw, o); const b = P.best;
    const lines = [`# SHILA plan — ${m.name} on ${hw.name}`, `Data as of ${S.DATA_DATE}. Context ${state.ctx} · users ${state.users} · KV ${state.kv8 ? 'q8_0' : 'f16'}${state.vision ? ' · vision' : ''}.`, ''];
    if (!b) { lines.push(`**Does not fit.** Smallest file ${fgb(Math.min(...m.quants.map(q => q.gb)))}.`); return lines.join('\n'); }
    const e = b.est;
    lines.push(`**Verdict:** ${STATUS_TXT[e.status]} — ${S.placementLabel(e.placement)}.`);
    lines.push(`**Pick:** ${b.q.tag} (${fgb(b.q.gb)}, ${b.tier.label}) from \`${b.q.repo}\`.`);
    lines.push(`**Estimated decode:** ~${tok(e.decodeShort)} tok/s short chats, ~${tok(e.decode)} tok/s at ${state.ctx} context. **Prompt:** ~${tok(e.prefill)} tok/s. **Memory:** ${fgb(e.usedGB || e.need)}${e.capacityGB ? ' of ' + fgb(e.capacityGB) : ''}.`);
    if (e.notes.length) lines.push(e.notes.map(n => `- ${n}`).join('\n'));
    const R = S.rankEngines(hw, m, b, o).filter(x => x.score >= 25).slice(0, 3);
    lines.push('', '## Engines');
    for (const x of R) lines.push(`### ${x.engine.name} (${x.engine.kind === 'specific' ? 'model-specific' : 'general'}) — ${x.engine.url}`, x.why.map(w => `- ${w}`).join('\n'), x.caveats.length ? x.caveats.map(w => `- ⚠ ${w}`).join('\n') : '', '```', x.cmd, '```', '');
    if (m.anchors.length) { lines.push('## Published measurements'); for (const a of m.anchors.slice(0, 8)) lines.push(`- ${a.toks} tok/s — ${a.hw} — ${a.quant} — ${a.engine} — ${a.src}`); }
    lines.push('', '_Estimates ±30% from a bandwidth model calibrated on the cited measurements; drafting not included._');
    return lines.join('\n');
  }
  function copyText(text) {
    const done = () => toast('Copied');
    const fallback = () => { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) { toast('Select and copy manually'); } document.body.removeChild(ta); };
    try { navigator.clipboard.writeText(text).then(done, fallback); } catch (e) { fallback(); }
  }
  let toastT; function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1600); }

  /* ---------- tabs & events ---------- */
  function setTab(id) {
    state.tab = id; save();
    document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
    ['fit', 'box', 'cheapest', 'engines', 'mcp'].forEach(t => { $('tab-' + t).hidden = t !== id; });
    render();
  }
  function render() {
    syncRail();
    if (state.tab === 'fit') renderFit(); else if (state.tab === 'box') renderBox(); else if (state.tab === 'cheapest') renderCheapest(); else if (state.tab === 'engines') renderAtlas();
  }
  function wire() {
    $('hwSel').addEventListener('change', e => { state.hwId = e.target.value; save(); render(); });
    $('mSel').addEventListener('change', e => { state.modelId = e.target.value; save(); render(); });
    $('ctxSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.ctx = +b.dataset.v; save(); render(); });
    $('usersSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.users = +b.dataset.v; save(); render(); });
    $('floorSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.floor = b.dataset.v; save(); render(); });
    $('optKv8').addEventListener('change', e => { state.kv8 = e.target.checked; save(); render(); });
    $('optVision').addEventListener('change', e => { state.vision = e.target.checked; save(); render(); });
    $('optWired').addEventListener('change', e => { state.wired = e.target.checked; save(); render(); });
    $('optLazy').addEventListener('change', e => { state.lazy = e.target.checked; save(); render(); });
    const ovSet = (k, v) => { state.ov[state.hwId] = state.ov[state.hwId] || {}; if (v === '' || v == null || Number.isNaN(v)) delete state.ov[state.hwId][k]; else state.ov[state.hwId][k] = v; if (!Object.keys(state.ov[state.hwId]).length) delete state.ov[state.hwId]; save(); render(); };
    $('eRam').addEventListener('change', e => ovSet('ram', +e.target.value));
    $('eRamBw').addEventListener('change', e => ovSet('ramBw', +e.target.value));
    $('eVram').addEventListener('change', e => ovSet('vram', e.target.value === '' ? '' : +e.target.value));
    $('eVramBw').addEventListener('change', e => ovSet('vramBw', +e.target.value));
    $('eOs').addEventListener('change', e => ovSet('os', e.target.value));
    $('ePrice').addEventListener('change', e => ovSet('price', e.target.value === '' ? '' : +e.target.value));
    document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
    $('copyPlan').addEventListener('click', () => copyText(planMarkdown()));
    let typing; $('customSpec').addEventListener('input', e => { state.customSpec = e.target.value; clearTimeout(typing); typing = setTimeout(() => { save(); render(); }, 250); });
    document.querySelectorAll('[data-goto-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.gotoTab)));
    document.querySelectorAll('#tab-mcp [data-copy]').forEach(b => b.addEventListener('click', () => copyText(b.nextElementSibling.textContent)));
    if (/^#(fit|box|cheapest|engines|mcp)$/.test(location.hash)) state.tab = location.hash.slice(1);
  }

  $('dataDate').textContent = 'data as of ' + S.DATA_DATE;
  $('counts').textContent = `${S.MODELS.length} models · ${S.HARDWARE.length} boxes · ${S.ENGINES.length} engines ranked`;
  buildSelects(); wire(); renderSources(); setTab(state.tab || 'fit');
})();
