'use strict';
/*
 * SHILA MCP server (stdio, JSON-RPC 2.0, newline-delimited). No dependencies.
 * Copyright 2026 Dr. Arvind Karthikeyan. Apache-2.0.
 */
const svc = require('./service.js');
const pkg = require('../package.json');

const HW_SCHEMA = {
  description: 'Which machine. Either "this_machine" (detect the computer this server runs on), a preset id from list_hardware, a plain description such as "32GB DDR5, Ryzen 7 8845HS" or "RTX 3060 12GB + 32GB DDR4, Windows" or "Mac mini M4 Pro 48GB", or an object.',
  anyOf: [
    { type: 'string' },
    {
      type: 'object',
      properties: {
        ram_gb: { type: 'number', description: 'System RAM (or unified memory) in GB' },
        cpu: { type: 'string', description: 'CPU or chip name, e.g. "Ryzen 7 8845HS", "Apple M4 Pro", "Intel N150"' },
        gpu: { type: 'string', description: 'GPU name, e.g. "RTX 4090", "RX 9070 XT", "Radeon 780M"' },
        vram_gb: { type: 'number', description: 'Dedicated GPU memory in GB' },
        os: { type: 'string', enum: ['linux', 'windows', 'macos'] },
        ram_type: { type: 'string', description: 'ddr4, ddr5, lpddr5x' },
        ram_channels: { type: 'number' },
        ram_bandwidth_gbs: { type: 'number', description: 'Measured memory bandwidth, if known' },
        vram_bandwidth_gbs: { type: 'number' },
      },
    },
  ],
};
const COMMON = {
  context: { type: 'number', description: 'Context window to reserve, in tokens (default 32768)' },
  users: { type: 'number', description: 'Simultaneous users (default 1)' },
  min_quality: { type: 'string', enum: ['any', 'usable', 'good', 'excellent'], description: 'Lowest quantization quality to accept: usable = 3-bit+, good = 4-bit+, excellent = 5-bit+ (default any)' },
};

const TOOLS = [
  {
    name: 'check_compatibility',
    title: 'Will this model run on this machine?',
    description: 'Checks whether an open-weight LLM fits a machine and how fast it will run. Returns the verdict, the recommended quantized file, estimated tokens/sec, memory use, the best inference engines with install and run commands, the full quantization ladder, and published measurements. Works for the curated catalogue (list_models) and for any Hugging Face repo id.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Catalogue id or name (e.g. "lfm2.5-24b", "qwen3.8-27b", "flash-next") or any Hugging Face repo id (e.g. "LiquidAI/LFM2.5-24B-A2B")' },
        hardware: HW_SCHEMA,
        ...COMMON,
        kv_cache_8bit: { type: 'boolean', description: 'Use an 8-bit KV cache (halves context memory)' },
        vision: { type: 'boolean', description: 'Include the vision projector' },
      },
      required: ['model'],
    },
    run: (a) => svc.checkCompatibility(a),
  },
  {
    name: 'what_can_i_run',
    title: 'Which models run on this machine?',
    description: 'Lists every catalogue model with the best quant that fits the given machine, the verdict, estimated tokens/sec and the best engine, fastest first. Use hardware "this_machine" to check the computer the server runs on.',
    inputSchema: { type: 'object', properties: { hardware: HW_SCHEMA, ...COMMON } },
    run: (a) => svc.whatCanRun(a),
  },
  {
    name: 'cheapest_hardware',
    title: 'Cheapest box for a model',
    description: 'Ranks the catalogued machines (Raspberry Pi to DGX Spark, with October 2026 Indian prices) that run a model at or above a speed, cheapest first.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Catalogue id/name or Hugging Face repo id' },
        min_tokens_per_sec: { type: 'number', description: 'Minimum estimated decode speed in short chats (default 15)' },
        max_budget_inr: { type: 'number', description: 'Optional price ceiling in Indian rupees' },
        ...COMMON,
      },
      required: ['model'],
    },
    run: (a) => svc.cheapestHardware(a),
  },
  {
    name: 'probe_this_machine',
    title: 'Detect this computer',
    description: 'Detects the RAM, memory bandwidth, CPU, GPU and VRAM of the computer this MCP server runs on (read-only: nvidia-smi, rocm-smi, sysctl, PowerShell CIM, lspci). Shows the assumptions it had to make.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => { const b = svc.probe(); return { name: b.name, ram_gb: b.ram, ram_bandwidth_gbs: b.ramBwEff, unified_memory: !!b.unified, cpu: b.cpu, gpu: b.gpu, os: b.os, detected_with: b.detectedWith, assumptions: b.assumptions, raw: b.rawSpec }; },
  },
  { name: 'list_models', title: 'Catalogue models', description: 'Lists the curated models with sizes, active parameters, licence and release date. Any other Hugging Face model also works by repo id.', inputSchema: { type: 'object', properties: {} }, run: async () => ({ models: svc.listModels() }) },
  { name: 'list_hardware', title: 'Catalogue machines', description: 'Lists the hardware presets (id, memory, bandwidth, GPU, price).', inputSchema: { type: 'object', properties: {} }, run: async () => ({ hardware: svc.listHardware() }) },
  { name: 'list_engines', title: 'Inference engines', description: 'Lists the inference engines SHILA knows (general vs model-specific), what they run, their licences and APIs.', inputSchema: { type: 'object', properties: {} }, run: async () => ({ engines: svc.listEngines() }) },
];

// Short human summary placed before the JSON, so clients that only show text stay readable.
function summary(name, r) {
  try {
    if (name === 'check_compatibility') {
      if (!r.recommendation) return `${r.model.name} on ${r.hardware.name}: ${r.verdict}.`;
      const x = r.recommendation;
      return `${r.model.name} on ${r.hardware.name}: ${r.verdict}. Use ${x.quant} (${x.size_gb} GB, ${x.quality}) from ${x.repo}, ${x.placement}. ~${x.est_decode_tps_short} tok/s in short chats, ~${x.est_decode_tps_full_context} tok/s with ${r.settings.context} tokens of context. Best engine: ${r.engines[0] ? r.engines[0].engine : 'none'}.`;
    }
    if (name === 'what_can_i_run') return `${r.hardware.name}: ` + r.models.filter(m => m.quant).slice(0, 6).map(m => `${m.model} ${m.quant} ~${m.est_decode_tps_short} tok/s`).join('; ') + '.';
    if (name === 'cheapest_hardware') return r.options.length ? `Cheapest for ${r.model}: ${r.options[0].hardware} (${r.options[0].price}) at ~${r.options[0].est_decode_tps_short} tok/s.` : r.note;
  } catch (e) { /* fall through */ }
  return '';
}

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function startServer(input = process.stdin, output = process.stdout) {
  const send = (msg) => output.write(JSON.stringify(msg) + '\n');
  let buf = '';
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line) handle(line).catch(e => process.stderr.write('shila mcp: ' + e.message + '\n'));
    }
  });

  async function handle(line) {
    let msg;
    try { msg = JSON.parse(line); } catch (e) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    const { id, method, params } = msg;
    if (id === undefined) return; // notification
    const ok = (result) => send({ jsonrpc: '2.0', id, result });
    const err = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize': {
        const v = params && params.protocolVersion;
        return ok({
          protocolVersion: SUPPORTED.includes(v) ? v : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'shila', title: 'SHILA local-AI fitment', version: pkg.version },
          instructions: 'Use check_compatibility to answer "can I run model X on my machine". Pass hardware "this_machine" to inspect the computer the server runs on, or describe a machine in plain words. Speeds are estimates (±30%); measured numbers are listed separately with sources.',
        });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS.map(({ run, ...t }) => t) });
      case 'tools/call': {
        const t = TOOLS.find(x => x.name === (params && params.name));
        if (!t) return err(-32602, `Unknown tool: ${params && params.name}`);
        try {
          const result = await t.run((params && params.arguments) || {});
          const text = summary(t.name, result);
          return ok({ content: [{ type: 'text', text: (text ? text + '\n\n' : '') + JSON.stringify(result, null, 2) }], structuredContent: result, isError: false });
        } catch (e) {
          return ok({ content: [{ type: 'text', text: e.message }], isError: true });
        }
      }
      case 'resources/list': return ok({ resources: [] });
      case 'prompts/list': return ok({ prompts: [] });
      default: return err(-32601, `Method not found: ${method}`);
    }
  }
}

module.exports = { startServer, TOOLS };
