#!/usr/bin/env node
'use strict';
/* SHILA command line. Copyright 2026 Dr. Arvind Karthikeyan. Apache-2.0. */
const svc = require('../src/service.js');
const pkg = require('../package.json');

const HELP = `shila ${pkg.version} — which local LLM fits which machine, how fast, and with which engine

Usage
  shila fit <model> [--on <hardware>] [--ctx 32768] [--users 1] [--min-quality any|usable|good|excellent] [--kv8] [--json]
  shila can-run [--on <hardware>] [--ctx 32768] [--json]
  shila cheapest <model> [--min-tps 15] [--budget <INR>] [--json]
  shila probe [--json]
  shila models | shila boxes | shila engines [--json]
  shila mcp                      start the MCP server on stdio

<model>     catalogue id or name (lfm2.5-24b, qwen3.8-27b, flash-next, gemma4-26b …) or any Hugging Face repo id
<hardware>  "this" (default: detect this computer), a preset id from "shila boxes",
            or a description in quotes: "32GB DDR5 Ryzen 7 8845HS"  "RTX 3060 12GB, 32GB DDR4, windows"  "Mac mini M4 Pro 48GB"

Examples
  npx -y github:arvidkarthik2000-hue/shila fit LiquidAI/LFM2.5-24B-A2B
  npx -y github:arvidkarthik2000-hue/shila fit qwen3.8-27b --on "RTX 4090, 64GB DDR5"
  npx -y github:arvidkarthik2000-hue/shila cheapest lfm2.5-24b --min-tps 20

Estimates are ±30% (memory-bandwidth model calibrated on published measurements). Data as of ${svc.SHILA.DATA_DATE}.`;

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

const pad = (s, n) => { s = String(s == null ? '' : s); return s.length >= n ? s.slice(0, n - 1) + '…' : s + ' '.repeat(n - s.length); };
const lpad = (s, n) => { s = String(s == null ? '' : s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; };
function table(rows, cols) {
  const head = cols.map(c => c.r ? lpad(c.h, c.w) : pad(c.h, c.w)).join(' ');
  return [head, '-'.repeat(head.length), ...rows.map(r => cols.map(c => c.r ? lpad(c.f(r), c.w) : pad(c.f(r), c.w)).join(' '))].join('\n');
}
const hwLine = (h) => `${h.name} · ${h.ram_gb} GB${h.unified_memory ? ' unified' : ' RAM'} @ ${h.ram_bandwidth_gbs} GB/s` + (h.gpu ? ` · ${h.gpu.name}${h.gpu.vram_gb && !/GB/.test(h.gpu.name) ? ' ' + h.gpu.vram_gb + ' GB' : ''}` : '') + ` · ${h.os}`;

async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  const json = !!a.json;
  const out = (obj, text) => process.stdout.write((json ? JSON.stringify(obj, null, 2) : text) + '\n');
  const common = { context: Number(a.ctx) || 32768, users: Number(a.users) || 1, min_quality: a['min-quality'] || 'any' };
  if (!cmd || cmd === 'help' || a.help || a.h) return console.log(HELP);
  if (cmd === '--version' || a.version) return console.log(pkg.version);

  if (cmd === 'mcp') return require('../src/mcp.js').startServer();

  if (cmd === 'fit') {
    const r = await svc.checkCompatibility(Object.assign({ model: a._.slice(1).join(' '), hardware: a.on || 'this', kv_cache_8bit: !!a.kv8 }, common));
    if (json) return out(r);
    const lines = [`${r.model.name}  →  ${hwLine(r.hardware)}`];
    if (r.hardware.assumptions.length) lines.push('assumed: ' + r.hardware.assumptions.join('; '));
    lines.push('', `VERDICT  ${r.verdict}`);
    if (r.recommendation) {
      const x = r.recommendation;
      lines.push(`use      ${x.quant}  (${x.size_gb} GB, ${x.quality})  from ${x.repo}`,
        `where    ${x.placement}  ·  ${x.memory_used_gb} GB${x.memory_available_gb ? ' of ' + x.memory_available_gb + ' GB' : ''}`,
        `speed    ~${x.est_decode_tps_short} tok/s short chats  ·  ~${x.est_decode_tps_full_context} tok/s at ${r.settings.context} ctx  ·  prompt ~${x.est_prompt_tps} tok/s`);
      for (const n of x.notes) lines.push('note     ' + n);
      if (r.fastest_alternative) lines.push(`faster   ${r.fastest_alternative.quant} at ~${r.fastest_alternative.est_decode_tps_short} tok/s (lower quality)`);
    }
    lines.push('', 'QUANTS');
    lines.push(table(r.quant_ladder, [{ h: 'quant', w: 22, f: q => q.quant }, { h: 'GB', w: 7, r: 1, f: q => q.size_gb }, { h: 'quality', w: 12, f: q => q.quality }, { h: 'placement', w: 18, f: q => q.placement }, { h: 'tok/s', w: 7, r: 1, f: q => q.est_decode_tps_short || '—' }, { h: 'status', w: 22, f: q => q.status }]));
    if (r.engines.length) {
      lines.push('', 'ENGINES');
      r.engines.forEach((e, i) => {
        lines.push(`${i + 1}. ${e.engine} (${e.kind}) ${e.url}`);
        e.why.forEach(w => lines.push('   + ' + w));
        e.caveats.forEach(w => lines.push('   ! ' + w));
        if (i === 0) lines.push(e.commands.split('\n').map(l => '   $ ' + l).join('\n'));
      });
    }
    const m = r.measured_elsewhere.slice(0, 5);
    if (m.length) { lines.push('', 'MEASURED (published)'); m.forEach(x => lines.push(`   ${lpad(x.tokens_per_sec, 6)} tok/s  ${x.hardware} · ${x.quant} · ${x.engine}`)); }
    lines.push('', r.disclaimer);
    return out(r, lines.join('\n'));
  }

  if (cmd === 'can-run') {
    const r = await svc.whatCanRun(Object.assign({ hardware: a.on || a._[1] || 'this' }, common));
    return out(r, hwLine(r.hardware) + '\n\n' + table(r.models, [{ h: 'model', w: 32, f: x => x.model }, { h: 'quant', w: 16, f: x => x.quant || '—' }, { h: 'GB', w: 7, r: 1, f: x => x.size_gb || '' }, { h: 'tok/s', w: 7, r: 1, f: x => x.est_decode_tps_short || '—' }, { h: 'verdict', w: 30, f: x => x.verdict }, { h: 'engine', w: 26, f: x => x.best_engine || '' }]) + '\n\n' + r.disclaimer);
  }

  if (cmd === 'cheapest') {
    const r = await svc.cheapestHardware(Object.assign({ model: a._.slice(1).join(' '), min_tokens_per_sec: Number(a['min-tps']) || 15, max_budget_inr: a.budget ? Number(a.budget) : null }, common, { min_quality: a['min-quality'] || 'usable' }));
    return out(r, `${r.model}, at least ${r.requirement.min_tokens_per_sec} tok/s\n\n` + (r.options.length ? table(r.options, [{ h: 'box', w: 50, f: x => x.hardware }, { h: 'price', w: 26, f: x => x.price }, { h: 'quant', w: 14, f: x => x.quant }, { h: 'tok/s', w: 7, r: 1, f: x => x.est_decode_tps_short }]) + '\n\n' : '') + r.note);
  }

  if (cmd === 'probe') {
    const b = svc.probe();
    return out(b, `${b.name}\n  CPU   ${b.cpu}\n  RAM   ${b.ram} GB${b.unified ? ' unified' : ''} @ ~${b.ramBwEff} GB/s\n  GPU   ${b.gpu ? b.gpu.name + (b.gpu.vram ? ` · ${b.gpu.vram} GB · ${b.gpu.vramBw} GB/s` : '') : 'none detected'}\n  OS    ${b.os}\n  via   ${(b.detectedWith || []).join(', ') || 'Node os module'}` + (b.assumptions.length ? `\n  assumed: ${b.assumptions.join('; ')}` : '') + `\n\nWrong? Describe it instead: shila fit <model> --on "RTX 3060 12GB, 32GB DDR4"`);
  }
  if (cmd === 'models') { const r = svc.listModels(); return out(r, table(r, [{ h: 'id', w: 13, f: x => x.id }, { h: 'name', w: 32, f: x => x.name }, { h: 'kind', w: 6, f: x => x.kind }, { h: 'total B', w: 8, r: 1, f: x => x.total_b }, { h: 'active B', w: 9, r: 1, f: x => x.active_b }, { h: 'min GB', w: 7, r: 1, f: x => x.smallest_file_gb }, { h: 'licence', w: 26, f: x => x.license }]) + '\nAny Hugging Face repo id also works.'); }
  if (cmd === 'boxes') { const r = svc.listHardware(); return out(r, table(r, [{ h: 'id', w: 15, f: x => x.id }, { h: 'name', w: 56, f: x => x.name }, { h: 'GB', w: 4, r: 1, f: x => x.ram_gb }, { h: 'GB/s', w: 6, r: 1, f: x => x.bandwidth_gbs }, { h: 'price', w: 28, f: x => x.price }])); }
  if (cmd === 'engines') { const r = svc.listEngines(); return out(r, table(r, [{ h: 'engine', w: 30, f: x => x.name }, { h: 'kind', w: 15, f: x => x.kind }, { h: 'runs', w: 40, f: x => Array.isArray(x.models) ? x.models.join(', ') : x.models }, { h: 'url', w: 48, f: x => x.url }])); }
  console.error(`Unknown command "${cmd}".\n\n` + HELP); process.exitCode = 2;
}

main().catch(e => { console.error('shila: ' + e.message); process.exitCode = 1; });
