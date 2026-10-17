/*
 * SHILA core — fitment estimator and engine ranking.
 * Copyright 2026 Dr. Arvind Karthikeyan. Licensed under the Apache License, Version 2.0.
 * Pure functions, no I/O, no DOM. Data comes in through createShila({ models, hardware, meta }).
 */
function createShila({ models, hardware, meta }) {
  const MODELS = models;
  const HARDWARE = hardware;
  const DATA_DATE = (meta && meta.dataDate) || 'unknown';

  /* ---------------------------------------------------------- ESTIMATION */
  const CLASS = {
    dgpu_nvidia: { eff: 0.88, ovh: 0.05, moeOvh: 0.06, label: 'CUDA' },
    dgpu_amd: { eff: 0.78, ovh: 0.06, moeOvh: 0.07, label: 'ROCm/Vulkan' },
    dgpu_intel: { eff: 0.70, ovh: 0.08, moeOvh: 0.08, label: 'Vulkan/SYCL' },
    apple: { eff: 0.88, ovh: 0.06, moeOvh: 0.02, label: 'Metal' },
    apu: { eff: 0.88, ovh: 0.04, moeOvh: 0.05, label: 'ROCm/Vulkan/CUDA' },
    igpu: { eff: 0.65, ovh: 0.09, moeOvh: 0.05, label: 'Vulkan' },
    desktop: { effMoe: 0.45, effDense: 0.60, ovh: 0.15, label: 'CPU' },
    small: { effMoe: 0.45, effDense: 0.55, ovh: 0.40, label: 'CPU (4 cores)' },
    sbc: { effMoe: 0.55, effDense: 0.70, ovh: 0.40, label: 'CPU (Arm)' },
  };
  const OS_RESERVE = { linux: 3, windows: 4, macos: 4 };
  const SPLIT_RAM_EFF = 0.50;      // CPU computing offloaded experts while the GPU does the rest
  const SSD_EFF_GBPS = 3.0;        // NVMe reads for streamed experts, effective

  function gpuClass(hw) {
    if (!hw.gpu) return null;
    if (hw.gpu.kind === 'apple') return CLASS.apple;
    if (hw.gpu.kind === 'apu') return CLASS.apu;
    if (hw.gpu.kind === 'igpu') return CLASS.igpu;
    return hw.gpu.vendor === 'nvidia' ? CLASS.dgpu_nvidia : hw.gpu.vendor === 'amd' ? CLASS.dgpu_amd : CLASS.dgpu_intel;
  }
  function unifiedUsable(hw, wired) {
    if (hw.gpu && hw.gpu.kind === 'apple') return wired ? hw.ram - 3.5 : (hw.ram <= 24 ? hw.ram * 0.70 : hw.ram * 0.78);
    if (hw.gpu && hw.gpu.vendor === 'nvidia') return hw.ram - 14;               // DGX Spark
    return hw.ram >= 128 ? hw.ram - 16 : hw.ram - 12;                             // Strix Halo
  }
  function bpw(model, q) {
    const main = q.gb - (q.tableGB || (q.fmt === 'gguf' ? (model.tableGB || 0) : 0));
    return main * 8 / model.total;
  }
  function qualityTier(model, q) {
    const b = bpw(model, q);
    if (q.qat) return { rank: 4, label: 'QAT 4-bit', desc: 'quant-aware trained: close to 8-bit quality at 4-bit size' };
    if (b >= 7.5) return { rank: 5, label: 'Reference', desc: '8-bit or better; indistinguishable from the original' };
    if (b >= 5.5) return { rank: 4, label: 'Excellent', desc: '5–6-bit; no practical loss' };
    if (b >= 4.2) return { rank: 3, label: 'Good', desc: 'standard 4-bit' };
    if (b >= 3.3) return { rank: 2, label: 'Usable', desc: '3-bit; noticeable on hard reasoning and code' };
    if (b >= 2.5) return { rank: 1, label: 'Degraded', desc: '2-bit; only for models too big to run otherwise' };
    return { rank: 0, label: 'Experimental', desc: 'sub-2.5-bit' };
  }

  // Which weight formats this box can execute at all
  function formatOk(hw, model, q) {
    const nv = hw.gpu && hw.gpu.vendor === 'nvidia';
    switch (q.fmt) {
      case 'gguf': case 'bf16': case 'onnx': return true;
      case 'mlx': return !!(hw.gpu && hw.gpu.kind === 'apple');
      case 'nvfp4': return (nv && !!hw.gpu.blackwell) || (!!(hw.gpu && hw.gpu.kind === 'apple') && ['qwen38-27b', 'qwen36-35b'].includes(model.id));
      case 'fp8': return nv && ['ada', 'blackwell', 'gb10'].includes(hw.gpu.gen);
      default: return false;
    }
  }

  // opts: {ctx, users, kv8, vision, tableLazy, wired, speedCtx}
  function estimate(model, q, hw, opts) {
    const o = Object.assign({ ctx: 32768, users: 1, kv8: false, vision: false, tableLazy: true, wired: true }, opts || {});
    const notes = [];
    if (!formatOk(hw, model, q)) {
      return { model, quant: q, hw, need: q.gb, placement: 'na', status: 'na', decode: 0, prefill: 0, notes: [q.fmt === 'mlx' ? 'MLX files run on Apple Silicon only' : q.fmt === 'nvfp4' ? 'NVFP4 needs a Blackwell GPU (RTX 50 / GB10) — or a Mac through lithos-metal for the Qwen models' : q.fmt === 'fp8' ? 'FP8 needs an Ada or Blackwell NVIDIA GPU (vLLM / SGLang)' : 'format not usable here'], vramGB: 0, ramGB: 0, ssdGB: 0, capacityGB: 0, mainGB: q.gb, kvGB: 0, ovhGB: 0, tableGB: 0 };
    }
    const tableGB = q.tableGB || (q.fmt === 'gguf' ? (model.tableGB || 0) : 0);
    const mainGB = q.gb - tableGB + (o.vision && model.vision ? model.mmprojGB : 0);
    const kvGB = (model.kvBytes * o.ctx * o.users * (o.kv8 ? 0.5 : 1)) / 1e9 + model.constStateGB * o.users;
    const ovhGB = 0.8 + 0.6 * (o.ctx / 32768) + (model.tableGB ? 1.0 : 0);
    const tableResidentGB = tableGB && !o.tableLazy ? tableGB : 0;
    const need = mainGB + kvGB + ovhGB;
    const bytesPerParam = (q.gb - tableGB) / model.total;              // GB per billion params
    const activeBytes = model.active * bytesPerParam;                   // GB read per token for weights
    const sctx = o.speedCtx || o.ctx;                                    // context in play when measuring speed
    const kvRead = (model.kvBytes * sctx * (o.kv8 ? 0.5 : 1)) / 1e9;    // GB of KV read per token
    const osRes = OS_RESERVE[hw.os] || 4;
    const gcls = gpuClass(hw);
    const ccls = CLASS[hw.cpuClass] || CLASS.desktop;
    const isMoe = model.kind === 'moe';
    const moeOvh = isMoe ? 1 : 0;
    const r = { model, quant: q, hw, mainGB, kvGB, ovhGB, tableGB, need, notes, decode: 0, prefill: 0, placement: 'no', status: 'no', vramGB: 0, ramGB: 0, ssdGB: 0, capacityGB: 0 };

    // attention compute per token at the chosen context (Flash-Next's sparse attention only touches ~2K tokens, so its attnFlops is tiny)
    const attnMs = (pf, eff) => pf ? ((model.attnLayers || 0) * (model.id === 'flash-next' ? Math.min(sctx, 2048) : sctx) * (model.attnFlops || 16384)) / (pf * 1e12 * eff) * 1000 : 0;
    const finish = (placement, usedA, capA, decodeMs, pflops, extra) => {
      r.placement = placement;
      const ms = (decodeMs + attnMs(pflops, (extra && extra.attnEff) || 0.08)) / (model.archMul || 1);
      r.decode = ms > 0 ? 1000 / ms : 0;
      r.prefill = pflops ? (pflops * 1e12) / (2 * model.active * 1e9) * (extra && extra.prefillMul || 1) : 0;
      const head = (capA - usedA) / capA;
      r.status = head >= 0.12 ? 'ok' : 'tight';
      r.capacityGB = capA; r.usedGB = usedA;
      if (extra && extra.ssd) r.status = 'ssd';
      return r;
    };

    // 1) everything in discrete VRAM
    if (hw.gpu && hw.gpu.kind === 'dgpu') {
      const vAvail = hw.gpu.vram - 0.6;
      if (need + tableResidentGB <= vAvail || (need <= vAvail && tableGB && o.tableLazy)) {
        if (tableGB) { r.ssdGB = tableGB; notes.push('n-gram table streams from NVMe (lazy mmap); prompt reading roughly halves'); }
        const t = (activeBytes + kvRead) / (hw.gpu.vramBw * gcls.eff) * 1000 + model.layers * (gcls.ovh + moeOvh * gcls.moeOvh);
        r.vramGB = need;
        return finish('gpu', need, vAvail, t, hw.pflopsGpu, { prefillMul: tableGB ? 0.5 : 1, attnEff: 0.08 });
      }
    }
    // 2) unified memory (Apple / Strix Halo / DGX Spark)
    if (hw.unified) {
      const usable = unifiedUsable(hw, o.wired);
      const resident = need + tableResidentGB;
      if (resident <= usable) {
        if (tableGB && o.tableLazy) { r.ssdGB = tableGB; notes.push('n-gram table streams from the SSD (lazy mmap); prompt reading roughly halves'); }
        const t = (activeBytes + kvRead) / (hw.ramBwEff * gcls.eff) * 1000 + model.layers * (gcls.ovh + moeOvh * gcls.moeOvh);
        r.vramGB = need;
        if (hw.gpu.kind === 'apple' && (o.wired ? resident > hw.ram * 0.70 : resident > usable * 0.9)) notes.push(o.wired ? `needs the macOS GPU memory limit raised: sudo sysctl iogpu.wired_limit_mb=${Math.round((hw.ram - 3) * 1024)}` : 'close to the default macOS GPU memory limit; raise iogpu.wired_limit_mb for headroom');
        return finish('unified', resident, usable, t, hw.pflopsGpu, { prefillMul: tableGB ? 0.5 : 1, attnEff: hw.gpu.kind === 'apple' ? 0.12 : 0.1 });
      }
      // unified box that is too small: MoE can still stream experts from SSD (ds4 / llama.cpp mmap)
      if (isMoe && mainGB * 0.55 <= usable) {
        const ramFrac = Math.max(0, Math.min(1, (usable - kvGB - ovhGB) / mainGB));
        const ssdBytes = activeBytes * model.expertActiveFrac * (1 - ramFrac);
        const t = (activeBytes + kvRead) / (hw.ramBwEff * gcls.eff) * 1000 + ssdBytes / SSD_EFF_GBPS * 1000 + model.layers * (gcls.ovh + gcls.moeOvh + 0.15);
        r.ssdGB = mainGB * (1 - ramFrac) + tableGB; r.vramGB = usable;
        notes.push(`only ~${Math.round(ramFrac * 100)}% of the experts stay in memory; the rest stream from the SSD each token`);
        return finish('ssd', usable, usable, t, hw.pflopsGpu, { ssd: true, prefillMul: 0.3, attnEff: 0.1 });
      }
      r.notes.push('does not fit in unified memory'); r.capacityGB = usable; r.usedGB = resident;
      return r;
    }
    // 3) discrete GPU + system RAM (MoE experts offloaded / dense layers split)
    const ramAvail = hw.ram - osRes - 0.5;
    if (hw.gpu && hw.gpu.kind === 'dgpu') {
      const vAvail = hw.gpu.vram - 0.6;
      if (isMoe) {
        const expertsGB = mainGB * model.expertWeightFrac;
        const denseGB = mainGB - expertsGB;
        const vramFixed = denseGB + kvGB + ovhGB;
        if (vramFixed <= vAvail) {
          const room = vAvail - vramFixed;
          const f = Math.max(0, Math.min(1, (expertsGB - room) / expertsGB));   // share of experts living in RAM
          const ramPart = expertsGB * f + tableResidentGB;
          if (ramPart <= ramAvail) {
            const vramBytes = activeBytes * (1 - model.expertActiveFrac * f) + kvRead;
            const ramBytes = activeBytes * model.expertActiveFrac * f;
            const t = vramBytes / (hw.gpu.vramBw * gcls.eff) * 1000 + ramBytes / (hw.ramBwEff * SPLIT_RAM_EFF) * 1000
              + model.layers * (gcls.ovh + gcls.moeOvh) + f * model.layers * 0.1;
            r.vramGB = vramFixed + expertsGB * (1 - f); r.ramGB = expertsGB * f; r.splitFrac = f;
            if (tableGB && o.tableLazy) { r.ssdGB = tableGB; notes.push('n-gram table streams from NVMe (lazy mmap)'); }
            notes.push(`${Math.round(f * 100)}% of the expert weights live in system RAM (llama.cpp --n-cpu-moe / --cpu-moe); an expert cache on the GPU typically adds 30–60%`);
            return finish('split', ramPart, ramAvail, t, hw.pflopsGpu, { prefillMul: 0.6 * (tableGB ? 0.5 : 1), attnEff: 0.08 });
          }
          // not even RAM: stream the rest from SSD
          if (expertsGB * 0.55 <= ramAvail + room) {
            const ramFrac = Math.max(0, Math.min(1, (ramAvail + room) / expertsGB));
            const ssdBytes = activeBytes * model.expertActiveFrac * (1 - ramFrac);
            const t = (activeBytes + kvRead) / (hw.gpu.vramBw * gcls.eff) * 1000 + activeBytes * model.expertActiveFrac * ramFrac / (hw.ramBwEff * SPLIT_RAM_EFF) * 1000
              + ssdBytes / SSD_EFF_GBPS * 1000 + model.layers * (gcls.ovh + gcls.moeOvh + 0.2);
            r.vramGB = vAvail; r.ramGB = ramAvail; r.ssdGB = expertsGB * (1 - ramFrac) + tableGB;
            notes.push(`~${Math.round((1 - ramFrac) * 100)}% of the experts stream from the SSD each token (Strata / Infernix / llama.cpp mmap do this); slow but it runs`);
            return finish('ssd', ramAvail, ramAvail, t, hw.pflopsGpu, { ssd: true, prefillMul: 0.25, attnEff: 0.08 });
          }
        }
      } else {
        // dense: split layers; the RAM share runs at RAM speed on the CPU
        const f = Math.max(0, Math.min(1, (need - vAvail) / mainGB));
        if (mainGB * f <= ramAvail) {
          const t = activeBytes * (1 - f) / (hw.gpu.vramBw * gcls.eff) * 1000 + activeBytes * f / (hw.ramBwEff * ccls.effDense) * 1000
            + kvRead / (hw.gpu.vramBw * gcls.eff) * 1000 + model.layers * (gcls.ovh + f * ccls.ovh);
          r.vramGB = vAvail; r.ramGB = mainGB * f; r.splitFrac = f;
          notes.push(`${Math.round(f * 100)}% of the layers run on the CPU from system RAM; dense models pay for every byte in RAM`);
          return finish('split', mainGB * f, ramAvail, t, hw.pflopsGpu * (1 - f) + hw.pflopsCpu * f, { prefillMul: 1, attnEff: 0.08 });
        }
      }
    }
    // 4) CPU-only (or iGPU over system RAM)
    if (!hw.unified) {
      const resident = need + tableResidentGB;
      if (resident <= ramAvail) {
        const cls = hw.gpu && hw.gpu.kind === 'igpu' ? CLASS.igpu : ccls;
        const eff = cls === CLASS.igpu ? cls.eff : (isMoe ? cls.effMoe : cls.effDense);
        const t = (activeBytes + kvRead) / (hw.ramBwEff * eff) * 1000 + model.layers * (cls.ovh + (cls === CLASS.igpu ? moeOvh * cls.moeOvh : 0));
        r.ramGB = resident; if (tableGB && o.tableLazy) r.ssdGB = tableGB;
        const pl = cls === CLASS.igpu ? 'igpu' : 'cpu';
        return finish(pl, resident, ramAvail, t, cls === CLASS.igpu ? hw.pflopsGpu : hw.pflopsCpu, { prefillMul: tableGB ? 0.5 : 1, attnEff: cls === CLASS.igpu ? 0.1 : 0.25 });
      }
      if (isMoe && mainGB * 0.55 <= ramAvail) {
        const ramFrac = Math.max(0, Math.min(1, (ramAvail - kvGB - ovhGB) / mainGB));
        const ssdBytes = activeBytes * model.expertActiveFrac * (1 - ramFrac);
        const cls = hw.gpu && hw.gpu.kind === 'igpu' ? CLASS.igpu : ccls;
        const eff = cls === CLASS.igpu ? cls.eff : cls.effMoe;
        const t = (activeBytes + kvRead) / (hw.ramBwEff * eff) * 1000 + ssdBytes / SSD_EFF_GBPS * 1000 + model.layers * (cls.ovh + 0.2);
        r.ramGB = ramAvail; r.ssdGB = mainGB * (1 - ramFrac) + tableGB;
        notes.push(`~${Math.round((1 - ramFrac) * 100)}% of the experts stream from the SSD each token; slow but it runs`);
        return finish('ssd', ramAvail, ramAvail, t, hw.pflopsCpu, { ssd: true, prefillMul: 0.3, attnEff: 0.25 });
      }
      r.capacityGB = ramAvail; r.usedGB = resident;
    }
    r.notes.push('does not fit');
    return r;
  }

  function placementLabel(p) {
    return { gpu: 'all in VRAM', unified: 'unified memory', split: 'GPU + RAM split', igpu: 'RAM, iGPU compute', cpu: 'RAM, CPU only', ssd: 'streams from SSD', no: 'does not fit', na: 'not for this hardware' }[p] || p;
  }

  const FLOORS = { any: 0, usable: 2, good: 3, excellent: 4 };
  // Best quant for a model on a box: highest quality that fits comfortably and is still usable in speed.
  function plan(model, hw, opts) {
    const rows = model.quants.map(q => {
      const est = estimate(model, q, hw, opts);
      const short = estimate(model, q, hw, Object.assign({}, opts, { speedCtx: 2048 }));
      est.decodeShort = short.decode;
      return { q, tier: qualityTier(model, q), est };
    });
    const floor = FLOORS[(opts && opts.floor) || 'any'] || 0;
    const fits = rows.filter(x => x.est.status !== 'no' && x.est.status !== 'na' && x.tier.rank >= floor);
    // Score each file: quality tier, minus a penalty for speeds below a comfortable 25 tok/s,
    // minus penalties for little headroom, SSD streaming and 2-bit files.
    const score = (x) => {
      const d = Math.max(0.1, x.est.decodeShort || 0);
      return x.tier.rank + 4 * Math.log2(Math.min(d, 25) / 25)
        - (x.est.status === 'tight' ? 0.3 : 0) - (x.est.status === 'ssd' ? 3 : 0) - (x.tier.rank <= 1 ? 1 : 0);
    };
    const best = fits.slice().sort((a, b) => (score(b) - score(a)) || (b.est.decodeShort - a.est.decodeShort))[0] || null;
    const fastest = fits.filter(x => x.est.status !== 'ssd').slice().sort((a, b) => b.est.decodeShort - a.est.decodeShort)[0] || null;
    return { rows, best, fastest };
  }

  /* -------------------------------------------------------------- ENGINES */
  const hasFmt = (model, fmt) => model.quants.some(q => q.fmt === fmt);
  const isNvidia = hw => hw.gpu && hw.gpu.vendor === 'nvidia';
  const isBlackwell = hw => isNvidia(hw) && !!hw.gpu.blackwell;
  const isApple = hw => hw.gpu && hw.gpu.kind === 'apple';
  const isAmd = hw => hw.gpu && hw.gpu.vendor === 'amd';
  const vram = hw => (hw.gpu && hw.gpu.kind === 'dgpu') ? hw.gpu.vram : (hw.unified ? unifiedUsable(hw, true) : 0);
  const ggufTag = (pick) => pick && pick.q.fmt === 'gguf' ? pick.q : null;
  const findQ = (model, fmt) => model.quants.find(q => q.fmt === fmt);

  function llamaCmd(hw, model, pick, o) {
    const q = ggufTag(pick) || findQ(model, 'gguf');
    const lines = [];
    const inst = hw.os === 'macos' ? 'brew install llama.cpp' : hw.os === 'windows' ? 'winget install llama.cpp   # or a CUDA/Vulkan build from github.com/ggml-org/llama.cpp/releases' : 'brew install llama.cpp   # or build: cmake -B build -DGGML_CUDA=ON (NVIDIA) / -DGGML_VULKAN=ON (AMD, Intel) && cmake --build build -j';
    lines.push(inst);
    let run = `llama-server -hf ${q.repo}:${q.tag} -c ${o.ctx} -fa on --jinja --port 8080`;
    const p = pick ? pick.est.placement : 'cpu';
    if (hw.gpu && hw.gpu.kind !== 'igpu' || hw.unified) run += ' -ngl 99';
    if (p === 'split' && model.kind === 'moe') {
      const n = Math.max(1, Math.round((pick.est.splitFrac || 0) * model.layers));
      run += ` --n-cpu-moe ${n}   # ${n} of ${model.layers} layers' experts in RAM; try --moe-cache-mib <MiB> (v0.6, LRU expert cache on the GPU)`;
    } else if (p === 'split') {
      run += '   # --fit (default on) splits layers between GPU and CPU automatically';
    }
    if (o.kv8) run += ' -ctk q8_0 -ctv q8_0';
    if (model.id === 'flash-next') run += ' --tensor-read-lazy auto   # keeps the 28.8 GB n-gram table on NVMe';
    if (o.vision && model.vision) run += '   # add --mmproj <mmproj.gguf> from the same repo for images';
    lines.push(run);
    if (model.id === 'qwen38-27b' || model.id === 'flash-next' || model.id === 'qwen36-35b' || model.family === 'Gemma 4' || model.id === 'nemotron35') {
      lines.push('# optional drafting (≈1.5–2× decode on dense models): --spec-type draft-mtp   (MTP head built in; DFlash/DSpark via --spec-type draft-dflash / draft-dspark — check llama-server --help for your build)');
    }
    return lines.join('\n');
  }

  const ENGINES = [
    {
      id: 'llamacpp', name: 'llama.cpp', kind: 'general', url: 'https://github.com/ggml-org/llama.cpp', license: 'MIT',
      blurb: 'The generalist. Thousands of models, every backend (CUDA, HIP, Vulkan, Metal, SYCL, CPU), GGUF everywhere. v0.6.0 (5 Oct 2026) added NVFP4 kernels, an LRU expert cache (--moe-cache-mib) and MTP/DFlash/DSpark drafting.',
      api: 'OpenAI + Anthropic Messages APIs (llama-server)', users: 'multi-user (slots)',
      check(hw, model, pick, o) {
        if (!hasFmt(model, 'gguf')) return null;
        const p = pick ? pick.est.placement : 'no';
        let score = 72; const why = []; const caveats = [];
        if (['cpu', 'igpu', 'split', 'ssd'].includes(p)) { score += 14; why.push('the only engine that runs this placement on this box well'); }
        if (hw.unified && !isApple(hw)) { score += 6; why.push('Strix Halo / Spark: ROCm/Vulkan/CUDA builds all work'); }
        if (isApple(hw)) { why.push('Metal backend; MLX engines are usually 1.3–2× faster on dense models'); score -= 4; }
        if (model.id === 'flash-next') { why.push('qwen4exp support since b10660; n-gram table lazily mmap’d from NVMe'); }
        if (model.id === 'lfm25-24b') why.push('day-one lfm2moe support; the quant Liquid benchmarked is Q4_K_M');
        caveats.push('flag names change between builds; confirm with llama-server --help');
        return { score, why, caveats, cmd: llamaCmd(hw, model, pick, o) };
      },
    },
    {
      id: 'lmstudio', name: 'LM Studio', kind: 'general', url: 'https://lmstudio.ai', license: 'proprietary, free',
      blurb: 'GUI on top of llama.cpp and MLX. v0.4.26 (13 Oct 2026): MTP/DFlash/DSpark assistant drafters, “Force expert weights onto CPU”, the experimental Splash backend, Anthropic + OpenAI APIs, MCP.',
      api: 'OpenAI + Anthropic + Responses APIs', users: 'parallel requests',
      check(hw, model, pick, o) {
        if (!hasFmt(model, 'gguf') && !hasFmt(model, 'mlx')) return null;
        const p = pick ? pick.est.placement : 'no';
        let score = 64; const why = ['easiest install on Windows, macOS and Linux']; const caveats = [];
        if (p === 'split' && model.kind === 'moe') why.push('turn on “Force Model Expert Weights onto CPU” (same as --n-cpu-moe)');
        if (isApple(hw)) why.push('uses its MLX engine on Apple Silicon');
        if (model.id === 'lfm25-24b') caveats.push('model is one day old; search the hf.co GGUF repo if the catalog lags');
        const fmt = isApple(hw) && hasFmt(model, 'mlx') ? 'MLX' : 'GGUF';
        return { score, why, caveats, cmd: `1. Install LM Studio → Discover → search "${model.name}" → download the ${fmt} ${pick ? pick.q.tag : ''} build\n2. Load → context ${o.ctx}${p === 'split' ? ' → enable “Force Model Expert Weights onto CPU”' : ''}\n3. Developer → Local Server (OpenAI /v1 and Anthropic /v1/messages on :1234)` };
      },
    },
    {
      id: 'ollama', name: 'Ollama', kind: 'general', url: 'https://ollama.com', license: 'MIT',
      blurb: 'One-line installs; llama.cpp inside, and since 0.30 an MLX runner by default on Apple Silicon. Anthropic-compatible /v1/messages works with Claude Code.',
      api: 'native + OpenAI + Anthropic', users: 'parallel',
      check(hw, model, pick, o) {
        if (!hasFmt(model, 'gguf')) return null;
        const p = pick ? pick.est.placement : 'no';
        let score = 58; const why = ['simplest path to “it answers”']; const caveats = [];
        if (p === 'split' && model.kind === 'moe') { score -= 18; caveats.push('no expert-offload knob: Ollama only splits by layers, so RAM-resident MoE experts run slower than llama.cpp with --n-cpu-moe'); }
        if (model.id === 'flash-next' && !isApple(hw)) { caveats.push('Flash-Next is in the library as an MLX (Mac-only) tag'); score -= 20; }
        if (model.id === 'lfm25-24b') caveats.push('not in the Ollama library yet (released 13 Oct); pull the GGUF straight from hf.co');
        const q = ggufTag(pick) || findQ(model, 'gguf');
        const lib = { 'qwen38-27b': 'qwen3.8:27b', 'lfm25-8b': 'lfm2.5:8b', 'gemma4-26b': 'gemma4:26b', 'gemma4-12b': 'gemma4:12b', 'gemma4-e4b': 'gemma4:e4b', 'gemma4-e2b': 'gemma4:e2b', 'gemma4-31b': 'gemma4:31b', 'qwen36-35b': 'qwen3.6:35b-a3b' }[model.id];
        const cmd = `curl -fsSL https://ollama.com/install.sh | sh   # Windows/macOS: installer from ollama.com\n` + (lib ? `ollama run ${lib}   # library tag (verify at ollama.com/library)\n` : '') + `ollama run hf.co/${q.repo}:${q.tag}   # any GGUF repo on Hugging Face\n# context: set OLLAMA_CONTEXT_LENGTH=${o.ctx}${o.kv8 ? '; KV cache: OLLAMA_KV_CACHE_TYPE=q8_0' : ''}`;
        return { score, why, caveats, cmd };
      },
    },
    {
      id: 'mlx', name: 'mlx-lm (+ mlx-dspark / oMLX)', kind: 'general', url: 'https://github.com/ml-explore/mlx-lm', license: 'MIT',
      blurb: 'Apple’s MLX runtime. mlx-lm 0.32 serves any MLX quant; mlx-dspark adds DSpark/DFlash drafters (Qwen3.8-27B 8-bit: 8 → 31 tok/s on an M4 Pro); oMLX adds continuous batching, MTP and an SSD prefix cache.',
      api: 'OpenAI (mlx_lm.server); mlx-dspark adds Anthropic + Responses', users: 'single (mlx-lm) · multi (oMLX)',
      check(hw, model, pick, o) {
        if (!isApple(hw) || !hasFmt(model, 'mlx')) return null;
        let score = 80; const why = ['native Metal/MLX path; usually the fastest general engine on a Mac']; const caveats = [];
        if (model.kind === 'dense') why.push('dense model: add mlx-dspark for a 2–3× drafting gain');
        else why.push('MoE: drafting gains are small (~1.1–1.3×); plain mlx-lm or oMLX is enough');
        if (hw.ram <= 16) caveats.push('16 GB: use a 3-bit MLX quant or raise iogpu.wired_limit_mb');
        const q = findQ(model, 'mlx');
        return { score, why, caveats, cmd: `pip install -U mlx-lm\nmlx_lm.server --model ${q.repo} --port 8080   # OpenAI-compatible on :8080\n# drafting: pip install mlx-dspark  (github.com/ARahim3/mlx-dspark) · batching/MTP: github.com/jundot/omlx` };
      },
    },
    {
      id: 'lithos', name: 'lithos-metal', kind: 'specific', url: 'https://github.com/lithos-ai/lithos-metal', license: 'Apache-2.0',
      blurb: 'LithosAI’s open-source engine (8 Oct 2026): generates Metal megakernels per layer and runs DSpark drafting on the GPU. Projects 168 tok/s for Qwen3.8-27B-NVFP4 on a 40-core M5 Max, ~1.8–2× MLX and Ollama.',
      api: 'OpenAI Chat + Responses, Anthropic Messages, Ollama /api/chat; launchers for opencode / claude / codex / hermes', users: 'one generation at a time',
      models: ['qwen38-27b', 'qwen36-35b'],
      check(hw, model, pick, o) {
        if (!isApple(hw) || !this.models.includes(model.id)) return null;
        const why = ['purpose-built for exactly this model on exactly this chip family']; const caveats = ['needs macOS 26+ and an M3 or newer chip; measured recipes exist for M5 Max/Pro, M4 Pro, M3 Pro/Ultra, other chips fall back to unmeasured kernels'];
        let score = 88;
        if ((hw.appleGen || 0) < 3) return null;
        if (hw.ram < 36) { score -= 30; caveats.push('27B NVFP4 (≈22 GB) + DSpark head + context wants 36 GB of unified memory or more; this box is too small'); }
        else if (hw.ram < 48) caveats.push('36 GB: fits with a ~20K context per its README');
        if (model.id === 'qwen36-35b') { score -= 15; caveats.push('35B-A3B integration is marked experimental'); }
        if (['m5max', 'm5pro', 'm4pro', 'm3pro', 'm3ultra'].includes(hw.gpu.gen)) { score += 8; why.push('this chip has measured kernel recipes (M5 Max is the reference configuration)'); }
        return { score, why, caveats, cmd: `brew install lithos-ai/tap/lithos-metal\nlithos-metal serve --model ${model.id === 'qwen38-27b' ? 'nvidia/Qwen3.8-27B-NVFP4' : 'nvidia/Qwen3.6-35B-A3B-NVFP4'} --max-context ${o.ctx}\n# then: lithos-metal claude   (or opencode / codex / hermes)` };
      },
    },
    {
      id: 'splash', name: 'Splash (Inco AI)', kind: 'specific', url: 'https://github.com/incoai/splash', license: 'Apache-2.0',
      blurb: 'Per-model fused Metal kernels with a bundled DFlash2 drafter for Qwen3.8-27B and Qwen3.6-35B-A3B. Self-reported M5 Pro 48 GB: 74 tok/s (27B) and 210 tok/s (35B-A3B). Also ships as LM Studio’s experimental backend.',
      api: 'OpenAI + Responses + Anthropic', users: 'batched (170 aggregate at ×4 reported)',
      models: ['qwen38-27b', 'qwen36-35b'],
      check(hw, model, pick, o) {
        if (!isApple(hw) || !this.models.includes(model.id) || (hw.appleGen || 0) < 3) return null;
        let score = 84; const why = ['fastest self-reported numbers for these two models on a Mac']; const caveats = ['macOS 26.4+ and 36 GB minimum per its README; young project (one public commit)'];
        if (hw.ram < 36) { score -= 30; caveats.push('this box is under the 36 GB floor'); }
        return { score, why, caveats, cmd: `brew install incoai/tap/splash\n# then follow the README: splash serves an OpenAI/Anthropic endpoint for ${model.name}` };
      },
    },
    {
      id: 'strata', name: 'Strata', kind: 'specific', url: 'https://github.com/Niko1221/Strata', license: 'MIT',
      blurb: 'The one-click engine for Qwen3.8-Flash-Next on gaming PCs: hot experts in VRAM, all experts in RAM, n-gram table on the SSD, MTP drafting, OpenAI/Anthropic APIs and an MCP server. Measured 53–94 tok/s on an RTX 5070 12 GB + 64 GB RAM.',
      api: 'OpenAI + Anthropic + Responses; MCP server', users: 'one request at a time by default ("parallel": 2 possible)',
      models: ['flash-next'],
      check(hw, model, pick, o) {
        if (model.id !== 'flash-next') return null;
        const dg = hw.gpu && hw.gpu.kind === 'dgpu';
        const nv = dg && isNvidia(hw) && ['turing', 'ampere', 'ada', 'blackwell'].includes(hw.gpu.gen);
        const amd = dg && isAmd(hw) && ['rdna2', 'rdna3', 'rdna4'].includes(hw.gpu.gen);
        let score = 90; const why = ['installer picks the pack that fits your RAM and starts the server']; const caveats = [];
        if (nv || amd) {
          if (hw.gpu.vram < 12) { score -= 40; caveats.push('needs 12 GB of VRAM or more'); }
        } else if (hw.unified && isAmd(hw)) { score -= 25; caveats.push('Strix Halo: community build from source on Linux (experimental)'); }
        else if (isApple(hw)) { score -= 25; caveats.push('Mac: builds its Metal engine from source via ./setup.sh (experimental)'); }
        else if (dg && hw.gpu.vendor === 'intel') { score -= 30; caveats.push('Intel Arc: build from source on Linux (experimental)'); }
        else return null;
        if (hw.ram < 32) { score -= 40; caveats.push('needs 32 GB RAM (Coder pack), 48 GB for IQ2_XS, 64 GB for every size'); }
        else if (hw.ram < 48) why.push('32 GB: the “Coder” pack (half the experts removed) is the one that fits');
        else if (hw.ram < 64) why.push('48 GB: IQ2_XS or Q2_0');
        else if (hw.ram < 96) why.push('64 GB: everything up to IQ3_S fits in RAM; UD-IQ4_XS partly streams from SSD');
        else why.push('96 GB+: UD-IQ4_XS / UD-Q4_K_XL stay in RAM');
        caveats.push('70 GB download; the first start locks 35–55 GB of RAM for 1–3 minutes');
        return { score, why, caveats, cmd: `# Paste into Claude Code / Cursor / Codex:\nSet up Strata on this PC for me: https://github.com/Niko1221/Strata - follow docs/AI_SETUP.md in that repository.\n# or by hand: download the repo → Windows: START-HERE.bat · Linux/Mac: ./setup.sh → app at http://127.0.0.1:8080 (OpenAI /v1, Anthropic /v1/messages)` };
      },
    },
    {
      id: 'infernix', name: 'Infernix', kind: 'specific', url: 'https://github.com/Wallawalla47/Infernix', license: 'Apache-2.0 (from NInfer)',
      blurb: 'C++/CUDA engine grown from NInfer for RTX 50-series: Qwen3.8-27B NVFP4 with a hybrid prefix cache and DFlash2 (209 tok/s), and Flash-Next with experts pinned in RAM and the 52 GB n-gram volume on NVMe (140 tok/s). Its README says it was built mostly with Claude Opus 5.5.',
      api: 'OpenAI Chat + Responses, Anthropic Messages, /v1/decide', users: '1–8 concurrent',
      models: ['qwen38-27b', 'flash-next'],
      check(hw, model, pick, o) {
        if (!this.models.includes(model.id) || !isBlackwell(hw) || hw.unified) return null;
        let score = 86; const why = ['fastest published single-GPU numbers for this model class']; const caveats = ['RTX 50-series only (CUDA 13, driver 580+); Windows build or Linux/WSL2 from source'];
        if (model.id === 'qwen38-27b' && hw.gpu.vram < 30) { score -= 35; caveats.push('27B NVFP4 + KV wants a 32 GB card (RTX 5090)'); }
        if (model.id === 'flash-next') {
          if (hw.ram < 64) { score -= 35; caveats.push('keeps the routed experts in pinned RAM: the reference machine has 96 GB'); }
          if (hw.gpu.vram < 24) { score -= 20; caveats.push('tuned on a 5090; a 16 GB Blackwell card leaves a small VRAM expert cache (not measured by the author)'); }
          caveats.push('needs a fast NVMe for the 52 GB n-gram volume');
        }
        const cmd = model.id === 'qwen38-27b'
          ? `infernix-serve.exe qwen3_8_27b_nvfp4-nvidia.ninfer --max-context ${Math.min(o.ctx * 4, 240000)} --max-concurrency 2 --spec dflash2 --draft-tokens 7 --lm-head-draft --ngram-draft-tokens 15 --ngram-min-match 12 --kv-dtype int8 --preserve-thinking --host-context-mib 52000 --prefill-chunk 4096 --kv-capacity auto --tolerant-tool-calls\n# model: Wallawalla47/Qwen3.8-27B-NVIDIA-NVFP4-NInferV3 (from the README)`
          : `infernix-serve.exe Qwen3.8-Flash-Next-NVIDIA-NVFP4-Dense8-Infernix-00001-of-00003.infernix --ngram-volume Qwen3.8-Flash-Next-NVIDIA-NVFP4-Infernix.ngram --kv-dtype int8 --max-context 262144 --prefill-chunk 4096 --spec mtp --draft-tokens 4 --lm-head-draft --max-concurrency 2\n# model: Wallawalla47/Qwen3.8-Flash-Next-NVIDIA-NVFP4-Dense8-Infernix (from the README)`;
        return { score, why, caveats, cmd };
      },
    },
    {
      id: 'ninfer', name: 'NInfer', kind: 'specific', url: 'https://github.com/Neroued/ninfer', license: 'Apache-2.0',
      blurb: 'From-scratch C++/CUDA engine for one GPU: the RTX 5090. Official .ninfer artifacts for Qwen3.6-27B, Qwen3.8-27B (groupwise-int and NVFP4) and Qwen3.6-35B-A3B; MTP3 decode at 148–200 tok/s single stream, 920+ aggregate at 8 lanes.',
      api: 'OpenAI Chat + Responses, Anthropic Messages', users: '1–8 lanes',
      models: ['qwen38-27b', 'qwen36-35b'],
      check(hw, model, pick, o) {
        if (!this.models.includes(model.id) || !isBlackwell(hw) || hw.unified || hw.gpu.vram < 32) return null;
        return { score: 82, why: ['the original of the Infernix line; Linux only; builds for sm_120a only'], caveats: ['no install target: run from the source build; 5090 only (the build rejects other GPUs)'], cmd: `hf download neroued/${model.id === 'qwen38-27b' ? 'Qwen3.8-27B-nvfp4-NInfer qwen3_8_27b_nvfp4.ninfer' : 'Qwen3.6-35B-A3B-NInfer qwen3_6_35b_a3b.ninfer'} --local-dir models\n./build/apps/ninfer-serve models/${model.id === 'qwen38-27b' ? 'qwen3_8_27b_nvfp4.ninfer' : 'qwen3_6_35b_a3b.ninfer'} --max-context 240000 --kv-capacity 240000 --max-concurrency 2 --kv-dtype fp8 --device-state-slots 2 --spec mtp --draft-tokens 3 --lm-head-draft --preserve-thinking` };
      },
    },
    {
      id: 'basalt', name: 'Basalt', kind: 'specific', url: 'https://github.com/jesdga95/basalt', license: 'MIT',
      blurb: 'A fork of Strata stripped to one target: Linux + NVIDIA Blackwell (sm_120). One binary, .basalt packs on Hugging Face, experts that don’t fit VRAM live in RAM (or on a second GPU), web UI with live draft-accept rate.',
      api: 'OpenAI + Anthropic (Python server)', users: '--parallel 1..8',
      models: ['flash-next'],
      check(hw, model, pick, o) {
        if (model.id !== 'flash-next' || !isBlackwell(hw) || hw.unified) return null;
        let score = 76; const caveats = ['Linux x86-64 + CUDA 13 + Blackwell only; build from source']; const why = ['cleaner, faster-evolving Strata derivative for Blackwell owners'];
        if (hw.ram < 48) { score -= 30; caveats.push('needs enough RAM for the experts that miss VRAM (64 GB+ realistic)'); }
        if (hw.gpu.vram < 24) { score -= 15; caveats.push('small VRAM leaves little room for the expert cache'); }
        return { score, why, caveats, cmd: `cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j\npip install -r requirements.txt\nbin/basalt serve --config basalt_config.json   # packs: huggingface.co/jesdga/Qwen3.8-Flash-Next-Basalt` };
      },
    },
    {
      id: 'vllm', name: 'vLLM', kind: 'general', url: 'https://github.com/vllm-project/vllm', license: 'Apache-2.0',
      blurb: 'The production server (v0.30, Sept 2026). Day-0 Qwen3.8, LFM2.5, Gemma 4 (MTP), NVFP4 on Blackwell, EAGLE/DFlash/DSpark drafting, high concurrency. Wants the whole model in VRAM; expert offload to RAM is still an open PR (#37190).',
      api: 'OpenAI', users: 'high concurrency',
      check(hw, model, pick, o) {
        if (!isNvidia(hw)) return null;
        if (!(hasFmt(model, 'fp8') || hasFmt(model, 'nvfp4') || hasFmt(model, 'bf16'))) return null;
        const cap = vram(hw);
        const cands = model.quants.filter(q => ['nvfp4', 'fp8', 'bf16'].includes(q.fmt) && (q.fmt !== 'nvfp4' || isBlackwell(hw)) && (q.fmt !== 'fp8' || ['ada', 'blackwell', 'gb10'].includes(hw.gpu.gen)));
        const fit = cands.filter(q => q.gb - (q.tableGB || 0) + 3 <= cap).sort((a, b) => b.gb - a.gb)[0];
        let score = 60; const why = []; const caveats = [];
        if (!fit) { score -= 30; caveats.push(`none of its FP8/NVFP4/BF16 checkpoints fit ${cap.toFixed(0)} GB of GPU memory; vLLM does not offload experts to RAM yet`); }
        else why.push(`${fit.tag} checkpoint (${fit.gb} GB) fits in GPU memory`);
        if ((o.users || 1) > 1) { score += 18; why.push('continuous batching for many users'); }
        if (model.id === 'flash-next') { score -= 25; caveats.push('needs ~130 GB of VRAM (NVFP4); datacenter only'); }
        if (model.id === 'qwen38-27b' && hw.gpu.vram === 32) why.push('NVFP4 fits one 32 GB Blackwell card (use --enforce-eager and 32K ctx per the vLLM recipe)');
        const q = fit || cands[0] || findQ(model, 'bf16');
        return { score, why, caveats, cmd: `pip install -U vllm\nvllm serve ${q ? q.repo : model.hf} --max-model-len ${o.ctx}${model.id === 'qwen38-27b' && hw.gpu.vram <= 32 ? ' --enforce-eager' : ''}` };
      },
    },
    {
      id: 'sglang', name: 'SGLang', kind: 'general', url: 'https://github.com/sgl-project/sglang', license: 'Apache-2.0',
      blurb: 'The other production server (0.5.21, 2 Oct 2026). DSpark drafting (LFM2.5 drafter “coming”), DFlash2, NVFP4 W4A16, SM120 fixes for RTX 50. Qwen3.8-27B NVFP4 + DFlash2 on one RTX 5090: 206 tok/s.',
      api: 'OpenAI', users: 'high concurrency',
      check(hw, model, pick, o) {
        if (!isNvidia(hw)) return null;
        if (!(hasFmt(model, 'fp8') || hasFmt(model, 'nvfp4') || hasFmt(model, 'bf16'))) return null;
        const cap = vram(hw);
        const cands = model.quants.filter(q => ['nvfp4', 'fp8', 'bf16'].includes(q.fmt) && (q.fmt !== 'nvfp4' || isBlackwell(hw)) && (q.fmt !== 'fp8' || ['ada', 'blackwell', 'gb10'].includes(hw.gpu.gen)));
        const fit = cands.filter(q => q.gb - (q.tableGB || 0) + 3 <= cap).sort((a, b) => b.gb - a.gb)[0];
        let score = 58; const why = []; const caveats = [];
        if (!fit) { score -= 30; caveats.push(`no FP8/NVFP4/BF16 checkpoint fits ${cap.toFixed(0)} GB of GPU memory`); }
        else why.push(`${fit.tag} (${fit.gb} GB) fits`);
        if (model.id === 'qwen38-27b' && isBlackwell(hw) && hw.gpu.vram >= 32) { score += 24; why.push('206 tok/s reported with NVFP4 + DFlash2 on an RTX 5090'); }
        if (model.id === 'lfm25-24b') why.push('Liquid’s 21K tok/s B300 number was measured with SGLang; DSpark drafter for it is announced');
        if ((o.users || 1) > 1) score += 12;
        if (model.id === 'flash-next') { score -= 25; caveats.push('datacenter-class VRAM needed'); }
        const q = fit || cands[0] || findQ(model, 'bf16');
        return { score, why, caveats, cmd: `pip install -U "sglang[all]"\npython -m sglang.launch_server --model-path ${q ? q.repo : model.hf} --context-length ${o.ctx} --port 30000\n# drafting: --speculative-algorithm DFLASH / DSPARK with the matching drafter repo (see release notes)` };
      },
    },
    {
      id: 'exl3', name: 'ExLlamaV3', kind: 'general', url: 'https://github.com/turboderp-org/exllamav3', license: 'MIT',
      blurb: 'NVIDIA consumer-card specialist (v1.6.1, Oct 2026): EXL3 trellis quants at any bpw, 2–8-bit KV, Lfm2Moe + Gemma 4 + Flash-Next + Qwen3.8-27B (community EXL3), early ROCm. Gemma-4-26B at 3.1 bpw: 199.6 tok/s on a 5090.',
      api: 'OpenAI via TabbyAPI', users: 'batched',
      models: ['lfm25-24b', 'gemma4-26b', 'gemma4-31b', 'gemma4-12b', 'flash-next', 'qwen38-27b', 'lfm25-8b'],
      check(hw, model, pick, o) {
        if (!this.models.includes(model.id) || !isNvidia(hw) || hw.unified) return null;
        const bits = 4.0; const gb = model.total * bits / 8;
        let score = 62; const why = [`EXL3 at ~4 bpw ≈ ${gb.toFixed(1)} GB; pick any bpw to fit`]; const caveats = ['find a community EXL3 quant on Hugging Face (e.g. billmccartney/Qwen3.8-27B-exl3) or quantize yourself'];
        if (gb + 2 > hw.gpu.vram) { if (model.kind === 'moe') caveats.push('experimental CPU offload (Linux) for experts; slower than llama.cpp’s offload'); else { score -= 20; caveats.push('dense model larger than VRAM at 4 bpw: drop to ~3 bpw'); } }
        if (model.id === 'gemma4-26b' && isBlackwell(hw)) { score += 10; why.push('199.6 tok/s measured on an RTX 5090 at 3.10 bpw'); }
        return { score, why, caveats, cmd: `pip install exllamav3   # + TabbyAPI for the OpenAI server\n# tabbyapi: model_name: <EXL3 quant dir>, draft_mode: mtp (Qwen3.8-27B)` };
      },
    },
    {
      id: 'ikllama', name: 'ik_llama.cpp', kind: 'general', url: 'https://github.com/ikawrakow/ik_llama.cpp', license: 'MIT',
      blurb: 'llama.cpp fork tuned for CPU (AVX2/AVX-512/NEON) and CUDA MoE serving: IQ*_K quants, repacked rows, fused MoE/DeltaNet ops, smart expert reduction. Lists Flash-Next, Qwen3.6, Gemma 4 and LFM2.5.',
      api: 'OpenAI (llama-server)', users: 'multi',
      check(hw, model, pick, o) {
        if (!hasFmt(model, 'gguf')) return null;
        if (isApple(hw) || (hw.gpu && hw.gpu.vendor !== 'nvidia' && hw.gpu.kind !== 'igpu')) return null;
        const p = pick ? pick.est.placement : 'no';
        let score = 50; const why = []; const caveats = ['build from source only; Vulkan/Metal/ROCm unsupported'];
        if (['cpu', 'split'].includes(p) && model.kind === 'moe') { score += 16; why.push('best-in-class CPU expert kernels when experts live in RAM'); }
        return { score, why, caveats, cmd: `git clone https://github.com/ikawrakow/ik_llama.cpp && cd ik_llama.cpp && cmake -B build -DGGML_CUDA=${isNvidia(hw) ? 'ON' : 'OFF'} && cmake --build build -j\n./build/bin/llama-server -m <model.gguf> -c ${o.ctx} -fa${p === 'split' ? ' --n-cpu-moe <N>' : ''} -rtr` };
      },
    },
    {
      id: 'dmr', name: 'Docker Model Runner', kind: 'general', url: 'https://docs.docker.com/ai/model-runner/', license: 'Apache-2.0',
      blurb: 'llama.cpp (vLLM on NVIDIA, vLLM-Metal on Mac) behind docker model run; GGUFs packaged as OCI artifacts. Liquid’s model card shows it as the one-liner for LFM2.5-24B-A2B.',
      api: 'OpenAI', users: 'multi',
      check(hw, model, pick, o) {
        if (!hasFmt(model, 'gguf')) return null;
        const q = ggufTag(pick) || findQ(model, 'gguf');
        return { score: 46, why: ['fine for teams already on Docker Desktop'], caveats: ['no expert-offload tuning exposed'], cmd: `docker model run hf.co/${model.id === 'lfm25-24b' ? 'LiquidAI/LFM2.5-24B-A2B' : q.repo + ':' + q.tag}` };
      },
    },
    {
      id: 'q27', name: 'q27 / Quasar', kind: 'specific', url: 'https://github.com/signalnine/q27', license: 'MIT',
      blurb: 'Hobby CUDA C++ (+Metal) engine for Qwen3.8-27B with its own 4-bit format, FP8 KV, MTP/DFlash2, prefix cache. Reports ~220 tok/s on a 5090 (DFlash2) and 102 tok/s on a 3090 at 131K context.',
      api: 'OpenAI + Responses + Anthropic', users: 'continuous batching',
      models: ['qwen38-27b'],
      check(hw, model, pick, o) {
        if (model.id !== 'qwen38-27b' || !((isNvidia(hw) && !hw.unified && hw.gpu.vram >= 20) || isApple(hw))) return null;
        return { score: 56, why: ['long-context 27B on a 24 GB Ampere/Ada card (3090: 102 tok/s at 131K)'], caveats: ['alpha-quality hobby project (46 stars); build from source'], cmd: `git clone https://github.com/signalnine/q27 && cd q27 && make   # see README for the model download and server flags` };
      },
    },
    {
      id: 'q36', name: 'q36 / QuarkStar', kind: 'specific', url: 'https://github.com/rjohny55/q36', license: 'MIT',
      blurb: 'Vulkan + Metal engine for Qwen3.6-35B-A3B (and Qwen3.8-27B) with SSD expert streaming for 16 GB machines: AMD BC-250 16 GB at 81.9 tok/s (q2), M2 Pro 16 GB at 37.8.',
      api: 'OpenAI + Anthropic', users: 'single',
      models: ['qwen36-35b', 'qwen38-27b'],
      check(hw, model, pick, o) {
        if (!this.models.includes(model.id)) return null;
        if (!(hw.gpu)) return null;
        let score = 44; const why = ['runs on Vulkan (AMD/Intel/NVIDIA) and Metal; streams experts from SSD when RAM is short']; const caveats = ['alpha; 2-bit packs for the speed numbers; weak MTP'];
        if (hw.ram <= 16) { score += 14; why.push('one of the few engines aimed at 16 GB boxes'); }
        return { score, why, caveats, cmd: `git clone https://github.com/rjohny55/q36   # see README (C, Vulkan/Metal)` };
      },
    },
    {
      id: 'ds4', name: 'ds4 / DwarfStar (antirez)', kind: 'specific', url: 'https://github.com/antirez/ds4', license: 'MIT',
      blurb: 'Salvatore Sanfilippo’s C engine for DeepSeek V4, GLM 5.x and Qwen3.8-Flash-Next: Metal, CUDA (Spark) and ROCm (Strix Halo); SSD streaming of experts, Q2/IQ2 experts, MTP and DSpark; 23.8k stars.',
      api: 'server + native agent', users: 'single',
      models: ['flash-next'],
      check(hw, model, pick, o) {
        if (model.id !== 'flash-next' || !hw.unified) return null;
        let score = 60; const why = ['built for big unified-memory machines (Mac Studio, Spark, Strix Halo)']; const caveats = ['no single-GPU consumer numbers published for Flash-Next'];
        if (hw.ram < 96) { score -= 20; caveats.push('under 96 GB it leans on SSD streaming'); }
        return { score, why, caveats, cmd: `git clone https://github.com/antirez/ds4 && cd ds4 && make   # see README for Flash-Next weights and the server` };
      },
    },
    {
      id: 'tensorfold', name: 'TensorFold', kind: 'general', url: 'https://github.com/ashhart/TensorFold', license: 'Apache-2.0',
      blurb: 'MLX + CUDA (cc ≥ 8.9) engine for Qwen3.8-27B, Flash-Next (NVFP4/EXL3), Gemma-4-26B-A4B, GLM-5.3-Flash and DeepSeek-V4-Flash with MTP/DFlash2/DSpark drafts and up to 8 streams.',
      api: 'OpenAI + Responses + Anthropic', users: 'up to 8 streams',
      models: ['qwen38-27b', 'flash-next', 'gemma4-26b'],
      check(hw, model, pick, o) {
        if (!this.models.includes(model.id)) return null;
        if (!(isApple(hw) || (isNvidia(hw) && ['ada', 'blackwell', 'gb10'].includes(hw.gpu.gen)))) return null;
        return { score: 52, why: ['one engine for both Macs and Ada/Blackwell GPUs'], caveats: ['no throughput numbers on its README yet (~1k stars)'], cmd: `git clone https://github.com/ashhart/TensorFold   # see README` };
      },
    },
    {
      id: 'lemonade', name: 'AMD Lemonade', kind: 'general', url: 'https://github.com/lemonade-sdk/lemonade', license: 'Apache-2.0',
      blurb: 'AMD’s wrapper for Ryzen AI / Strix Halo: llama.cpp (Vulkan/ROCm) plus the XDNA2 NPU through FastFlowLM, OpenAI + Anthropic + Ollama-style APIs.',
      api: 'OpenAI + Anthropic + Ollama', users: 'multi',
      check(hw, model, pick, o) {
        if (!hasFmt(model, 'gguf') || !isAmd(hw) || hw.gpu.kind === 'dgpu') return null;
        return { score: 52, why: ['the vendor-blessed path on Ryzen AI boxes; uses the NPU for small models'], caveats: ['the heavy lifting is still llama.cpp underneath'], cmd: `# Windows installer / pip: github.com/lemonade-sdk/lemonade → pull ${model.name} (GGUF) → OpenAI server on :8000` };
      },
    },
    {
      id: 'openvino', name: 'OpenVINO GenAI (Intel)', kind: 'general', url: 'https://github.com/openvinotoolkit/openvino.genai', license: 'Apache-2.0',
      blurb: 'Intel’s runtime for Core Ultra iGPU/NPU; OpenVINO 2026.1 added a preview llama.cpp backend and showed LFM2-24B-A2B INT4 on an Arc iGPU. IPEX-LLM was archived in Jan 2026.',
      api: 'OpenAI (model server)', users: 'multi',
      check(hw, model, pick, o) {
        if (!(hw.gpu && hw.gpu.vendor === 'intel')) return null;
        return { score: 40, why: ['uses the Intel iGPU/NPU natively'], caveats: ['model coverage lags llama.cpp Vulkan; LFM2.5 unverified (LFM2-24B INT4 preview exists)'], cmd: `pip install openvino-genai   # see openvinotoolkit.org for the ${model.name} INT4 export` };
      },
    },
  ];

  function rankEngines(hw, model, pick, o) {
    const out = [];
    for (const e of ENGINES) {
      let res = null;
      try { res = e.check(hw, model, pick, o); } catch (err) { res = null; }
      if (!res) continue;
      const anchors = model.anchors.filter(a => a.engine.toLowerCase().includes(e.name.split(' ')[0].toLowerCase().replace('/', '')) || (e.id === 'llamacpp' && a.engine.toLowerCase().includes('llama.cpp')) || (e.id === 'mlx' && /mlx|omlx/.test(a.engine.toLowerCase())));
      out.push(Object.assign({ engine: e, anchors }, res));
    }
    return out.sort((a, b) => b.score - a.score);
  }

  function fmtInr(n) { return '₹' + Math.round(n).toLocaleString('en-IN'); }
  function priceText(hw) {
    if (hw.priceInr) return (hw.priceInr[0] === hw.priceInr[1] ? fmtInr(hw.priceInr[0]) : fmtInr(hw.priceInr[0]) + '–' + fmtInr(hw.priceInr[1])) + (hw.estimate ? ' (est.)' : '');
    if (hw.priceUsd) return (hw.priceUsd[0] === hw.priceUsd[1] ? '$' + hw.priceUsd[0].toLocaleString('en-US') : '$' + hw.priceUsd[0].toLocaleString('en-US') + '–' + hw.priceUsd[1].toLocaleString('en-US')) + ' (US)';
    return hw.priceNote || '—';
  }
  function priceSort(hw) {
    if (hw.priceInr) return (hw.priceInr[0] + hw.priceInr[1]) / 2;
    if (hw.priceUsd) return ((hw.priceUsd[0] + hw.priceUsd[1]) / 2) * 92;
    return 0;
  }

  return { DATA_DATE, MODELS, HARDWARE, ENGINES, CLASS, estimate, plan, qualityTier, bpw, rankEngines, placementLabel, priceText, priceSort, unifiedUsable, fmtInr, formatOk };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { createShila };
if (typeof window !== 'undefined') window.createShila = createShila;
