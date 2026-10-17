'use strict';
/*
 * Turn a plain description of a machine into the hardware shape the estimator uses.
 * Copyright 2026 Dr. Arvind Karthikeyan. Apache-2.0.
 *
 * describeBox({ ram_gb, cpu, gpu, vram_gb, os, ram_type, ram_channels, ram_bandwidth_gbs, vram_bandwidth_gbs })
 * Everything except ram_gb is optional; unknown values fall back to conservative defaults and are
 * listed in box.assumptions so callers can show them.
 */

// Discrete GPUs: [regex, vendor, gen, defaultVramGB, vramBwGBs, effective TFLOPS for prefill, blackwell?]
const DGPU = [
  [/rtx\s*pro\s*6000/i, 'nvidia', 'blackwell', 96, 1792, 110, true],
  [/5090/, 'nvidia', 'blackwell', 32, 1792, 90, true],
  [/5080/, 'nvidia', 'blackwell', 16, 960, 45, true],
  [/5070\s*ti/i, 'nvidia', 'blackwell', 16, 896, 35, true],
  [/5070/, 'nvidia', 'blackwell', 12, 672, 25, true],
  [/5060\s*ti/i, 'nvidia', 'blackwell', 16, 448, 18, true],
  [/5060/, 'nvidia', 'blackwell', 8, 448, 15, true],
  [/5050/, 'nvidia', 'blackwell', 8, 320, 10, true],
  [/4090/, 'nvidia', 'ada', 24, 1008, 55, false],
  [/4080/, 'nvidia', 'ada', 16, 717, 40, false],
  [/4070\s*ti\s*super/i, 'nvidia', 'ada', 16, 672, 33, false],
  [/4070\s*ti/i, 'nvidia', 'ada', 12, 504, 30, false],
  [/4070\s*super/i, 'nvidia', 'ada', 12, 504, 28, false],
  [/4070/, 'nvidia', 'ada', 12, 504, 22, false],
  [/4060\s*ti/i, 'nvidia', 'ada', 16, 288, 15, false],
  [/4060/, 'nvidia', 'ada', 8, 272, 12, false],
  [/3090/, 'nvidia', 'ampere', 24, 936, 25, false],
  [/3080\s*ti/i, 'nvidia', 'ampere', 12, 912, 22, false],
  [/3080/, 'nvidia', 'ampere', 10, 760, 20, false],
  [/3070/, 'nvidia', 'ampere', 8, 448, 14, false],
  [/3060\s*ti/i, 'nvidia', 'ampere', 8, 448, 11, false],
  [/3060/, 'nvidia', 'ampere', 12, 360, 9, false],
  [/2080/, 'nvidia', 'turing', 8, 448, 8, false],
  [/2070/, 'nvidia', 'turing', 8, 448, 7, false],
  [/2060/, 'nvidia', 'turing', 6, 336, 5, false],
  [/a100/i, 'nvidia', 'ampere', 80, 2039, 150, false],
  [/h100/i, 'nvidia', 'hopper', 80, 3350, 400, false],
  [/l40s?/i, 'nvidia', 'ada', 48, 864, 90, false],
  [/a6000/i, 'nvidia', 'ampere', 48, 768, 38, false],
  [/9070\s*xt/i, 'amd', 'rdna4', 16, 640, 18, false],
  [/9070/, 'amd', 'rdna4', 16, 640, 15, false],
  [/9060\s*xt/i, 'amd', 'rdna4', 16, 320, 10, false],
  [/r9700/i, 'amd', 'rdna4', 32, 640, 20, false],
  [/7900\s*xtx/i, 'amd', 'rdna3', 24, 960, 25, false],
  [/7900\s*xt/i, 'amd', 'rdna3', 20, 800, 20, false],
  [/7800\s*xt/i, 'amd', 'rdna3', 16, 624, 14, false],
  [/7700\s*xt/i, 'amd', 'rdna3', 12, 432, 11, false],
  [/6900|6950/, 'amd', 'rdna2', 16, 512, 10, false],
  [/6800/, 'amd', 'rdna2', 16, 512, 9, false],
  [/b580/i, 'intel', 'xe2', 12, 456, 12, false],
  [/b570/i, 'intel', 'xe2', 10, 380, 10, false],
  [/a770/i, 'intel', 'xe1', 16, 560, 10, false],
];

// Apple chips: [regex, gen tag, appleGen, bandwidth GB/s, TFLOPS]
const APPLE = [
  [/m5\s*ultra/i, 'm5ultra', 5, 1229, 30], [/m5\s*max/i, 'm5max', 5, 614, 15], [/m5\s*pro/i, 'm5pro', 5, 307, 9], [/m5/i, 'm5', 5, 153, 4.5],
  [/m6\s*max/i, 'm6max', 6, 614, 16], [/m6\s*pro/i, 'm6pro', 6, 307, 10], [/m6/i, 'm6', 6, 170, 4],
  [/m4\s*max/i, 'm4max', 4, 546, 12], [/m4\s*pro/i, 'm4pro', 4, 273, 5], [/m4/i, 'm4', 4, 120, 2.5],
  [/m3\s*ultra/i, 'm3ultra', 3, 819, 20], [/m3\s*max/i, 'm3max', 3, 400, 10], [/m3\s*pro/i, 'm3pro', 3, 150, 4], [/m3/i, 'm3', 3, 100, 2.5],
  [/m2\s*ultra/i, 'm2ultra', 2, 800, 18], [/m2\s*max/i, 'm2max', 2, 400, 9], [/m2\s*pro/i, 'm2pro', 2, 200, 4], [/m2/i, 'm2', 2, 100, 2],
  [/m1\s*ultra/i, 'm1ultra', 1, 800, 15], [/m1\s*max/i, 'm1max', 1, 400, 8], [/m1\s*pro/i, 'm1pro', 1, 200, 3.5], [/m1/i, 'm1', 1, 68, 1.8],
];

// Integrated GPUs that share system RAM: [regex, vendor, gen, name, TFLOPS]
const IGPU = [
  [/890m/i, 'amd', 'rdna3.5', 'Radeon 890M', 3], [/880m/i, 'amd', 'rdna3.5', 'Radeon 880M', 2.6],
  [/780m/i, 'amd', 'rdna3', 'Radeon 780M', 2.2], [/760m/i, 'amd', 'rdna3', 'Radeon 760M', 1.6], [/680m/i, 'amd', 'rdna2', 'Radeon 680M', 1.4],
  [/arc\s*b390|b390/i, 'intel', 'xe3', 'Arc B390', 4], [/arc\s*140v|140v/i, 'intel', 'xe2', 'Arc 140V', 3], [/arc\s*graphics|meteor|core\s*ultra/i, 'intel', 'xe', 'Intel Arc iGPU', 2],
];

function num(x) { const n = Number(x); return Number.isFinite(n) && n > 0 ? n : null; }

function describeBox(spec) {
  const s = spec || {};
  const a = [];   // assumptions shown to the user
  const cpu = String(s.cpu || '');
  const gpuStr = String(s.gpu || '');
  const both = cpu + ' ' + gpuStr;
  let ram = num(s.ram_gb);
  if (!ram) { ram = 16; a.push('RAM not given: assumed 16 GB'); }
  let os = (s.os || '').toLowerCase();
  if (!['linux', 'windows', 'macos'].includes(os)) {
    os = /apple|m[1-6]\b/i.test(both) ? 'macos' : 'linux';
    if (!s.os) a.push(`OS not given: assumed ${os}`);
  }
  const box = { id: 'custom', group: 'Custom', name: s.name || 'Your machine', cpu: cpu || 'unknown CPU', ram, os, gpu: null, unified: false, cpuClass: 'desktop', pflopsCpu: 0.6, notes: '', assumptions: a };

  // Apple Silicon
  const ap = APPLE.find(([re]) => re.test(both) && /apple|m[1-6]/i.test(both));
  if (ap || os === 'macos') {
    const [, gen, appleGen, bw, tf] = ap || [null, 'm4', 4, 120, 2.5];
    if (!ap) a.push('Apple chip not recognised: assumed base M4 (120 GB/s)');
    const bwv = num(s.ram_bandwidth_gbs) || bw;
    Object.assign(box, { os: 'macos', unified: true, cpuClass: 'apple', appleGen, ramBw: bwv, ramBwEff: bwv, pflopsGpu: tf, gpu: { kind: 'apple', vendor: 'apple', gen, name: (ap ? cpu || gpuStr : 'Apple GPU') + ' (Metal/MLX)', vram: 0, vramBw: 0 } });
    return box;
  }
  // DGX Spark / GB10
  if (/gb10|dgx\s*spark|ascent\s*gx10/i.test(both)) {
    const bwv = num(s.ram_bandwidth_gbs) || 240;
    Object.assign(box, { os: 'linux', unified: true, cpuClass: 'apu', ramBw: 273, ramBwEff: bwv, pflopsGpu: 20, pflopsCpu: 1, gpu: { kind: 'apu', vendor: 'nvidia', gen: 'gb10', blackwell: true, name: 'GB10 Blackwell', vram: 0, vramBw: 0 } });
    return box;
  }
  // Strix Halo
  if (/ai\s*max|8060s|8050s|strix\s*halo/i.test(both)) {
    const bwv = num(s.ram_bandwidth_gbs) || 215;
    Object.assign(box, { unified: true, cpuClass: 'apu', ramBw: 256, ramBwEff: bwv, pflopsGpu: 7, pflopsCpu: 1.2, gpu: { kind: 'apu', vendor: 'amd', gen: 'rdna3.5', name: 'Radeon 8060S (Strix Halo)', vram: 0, vramBw: 0 } });
    return box;
  }

  // CPU class and system-RAM bandwidth
  if (/raspberry|bcm27|cortex|rk3588|arm/i.test(cpu)) box.cpuClass = 'sbc', box.pflopsCpu = 0.07;
  else if (/\bn(50|95|97|100|150|200|250|300|305|350|355)\b|celeron|pentium|atom/i.test(cpu)) box.cpuClass = 'small', box.pflopsCpu = 0.15;
  let bw = num(s.ram_bandwidth_gbs);
  if (!bw) {
    const type = String(s.ram_type || '').toLowerCase();
    const ch = num(s.ram_channels) || (box.cpuClass === 'small' || box.cpuClass === 'sbc' ? 1 : 2);
    let per;
    if (box.cpuClass === 'sbc') per = 17;
    else if (/lpddr5x/.test(type)) per = 60;
    else if (/ddr5/.test(type)) per = 44.8;
    else if (/ddr4/.test(type)) per = 25.6;
    else { per = box.cpuClass === 'small' ? 25.6 : 44.8; a.push(`RAM type not given: assumed ${box.cpuClass === 'small' ? 'DDR4' : 'DDR5-5600'}, ${ch}-channel`); }
    bw = box.cpuClass === 'sbc' ? per : per * ch * 0.92;
  }
  box.ramBw = bw; box.ramBwEff = Math.round(bw * 10) / 10;

  // GPU
  const dg = DGPU.find(([re]) => re.test(gpuStr));
  if (dg) {
    const [, vendor, gen, vram, vbw, tf, bl] = dg;
    const v = num(s.vram_gb) || vram;
    const laptop = /laptop|mobile|max-q/i.test(gpuStr);
    box.gpu = { kind: 'dgpu', vendor, gen, blackwell: bl, name: gpuStr, vram: v, vramBw: num(s.vram_bandwidth_gbs) || (laptop ? Math.round(vbw * 0.85) : vbw) };
    box.pflopsGpu = laptop ? tf * 0.7 : tf;
    if (laptop && !num(s.vram_gb)) a.push('laptop GPU: check VRAM, laptop parts often have less than the desktop card');
  } else if (num(s.vram_gb) && gpuStr) {
    const vendor = /radeon|rx|amd/i.test(gpuStr) ? 'amd' : /arc|intel/i.test(gpuStr) ? 'intel' : 'nvidia';
    box.gpu = { kind: 'dgpu', vendor, gen: vendor === 'nvidia' ? 'ampere' : vendor === 'amd' ? 'rdna3' : 'xe2', name: gpuStr, vram: num(s.vram_gb), vramBw: num(s.vram_bandwidth_gbs) || 400 };
    box.pflopsGpu = 10;
    a.push(`GPU "${gpuStr}" not in the lookup table: assumed ${box.gpu.vramBw} GB/s, ${box.gpu.gen}`);
  } else {
    const ig = IGPU.find(([re]) => re.test(both));
    if (ig) {
      const [, vendor, gen, name, tf] = ig;
      box.gpu = { kind: 'igpu', vendor, gen, name: name + ' (Vulkan)', vram: 0, vramBw: 0 };
      box.pflopsGpu = tf;
    }
  }
  if (box.cpuClass === 'sbc' || box.cpuClass === 'small') box.os = s.os ? os : 'linux';
  return box;
}

// "32GB DDR5 Ryzen 7 8845HS, RTX 3060 12GB, windows" → spec
function parseSpecString(s) {
  const t = String(s);
  const norm = (x) => String(x || '');
  const gbs = [...t.matchAll(/(\d+(?:\.\d+)?)\s*gb/gi)].map(m => ({ v: Number(m[1]), at: m.index }));
  if (!gbs.length && !/m[1-6]|rtx|gtx|radeon|rx\s*\d|arc|pi\s*5|n1[05]0/i.test(t)) return null;
  const spec = { cpu: t, gpu: '' };
  const gpuM = t.match(/(rtx\s*(?:pro\s*)?\d{4}(?:\s*(?:ti|super))*(?:\s*laptop)?|gtx\s*\d{3,4}|rx\s*\d{4}\s*(?:xtx|xt)?|arc\s*[ab]\d{3}|radeon\s*\d{3}m|r9700|a100|h100|l40s?)/i);
  if (gpuM) spec.gpu = gpuM[0];
  if (/apple|\bm[1-6](\s*(pro|max|ultra))?\b|mac/i.test(t)) { spec.gpu = (t.match(/m[1-6](\s*(pro|max|ultra))?/i) || ['m4'])[0]; spec.cpu = 'Apple ' + spec.gpu; spec.os = 'macos'; }
  if (gbs.length) {
    // the GB figure right after a GPU name is VRAM; the largest other one is RAM
    if (gpuM) {
      const after = gbs.find(g => g.at > gpuM.index && g.at - (gpuM.index + gpuM[0].length) < 8);
      if (after) spec.vram_gb = after.v;
    }
    const rest = gbs.filter(g => g.v !== spec.vram_gb);
    if (rest.length) spec.ram_gb = Math.max(...rest.map(g => g.v));
  }
  const ty = t.match(/lpddr5x|lpddr5|ddr5|ddr4/i); if (ty) spec.ram_type = ty[0];
  if (/windows|win1[01]/i.test(t)) spec.os = 'windows'; else if (/linux|ubuntu/i.test(t)) spec.os = 'linux'; else if (/mac/i.test(t)) spec.os = 'macos';
  if (/single[-\s]?channel/i.test(t)) spec.ram_channels = 1;
  return spec;
}


const api = { describeBox, parseSpecString, DGPU, APPLE, IGPU };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.ShilaBox = api;

