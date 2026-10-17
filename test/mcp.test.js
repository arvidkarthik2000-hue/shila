'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');

function session() {
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'shila.js'), 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = ''; const waiting = new Map();
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } } });
  let id = 0;
  const call = (method, params) => new Promise(res => { const n = ++id; waiting.set(n, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  return { call, notify: (method) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'), close: () => p.kill() };
}

test('MCP handshake, tool list and a compatibility check', async () => {
  const s = session();
  try {
    const init = await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.strictEqual(init.result.serverInfo.name, 'shila');
    assert.strictEqual(init.result.protocolVersion, '2025-06-18');
    s.notify('notifications/initialized');
    const list = await s.call('tools/list', {});
    const names = list.result.tools.map(t => t.name);
    for (const n of ['check_compatibility', 'what_can_i_run', 'cheapest_hardware', 'probe_this_machine', 'list_models']) assert.ok(names.includes(n), n);
    const r = await s.call('tools/call', { name: 'check_compatibility', arguments: { model: 'lfm2.5-24b', hardware: '32GB DDR5 Ryzen 7 8845HS Radeon 780M' } });
    assert.strictEqual(r.result.isError, false);
    assert.strictEqual(r.result.structuredContent.verdict, 'Runs well');
    assert.ok(r.result.content[0].text.startsWith('LFM2.5-24B-A2B'));
    const cheap = await s.call('tools/call', { name: 'cheapest_hardware', arguments: { model: 'qwen3.8-27b', min_tokens_per_sec: 30 } });
    assert.ok(cheap.result.structuredContent.options.length > 0);
    const bad = await s.call('tools/call', { name: 'check_compatibility', arguments: { model: 'no-such-model' } });
    assert.strictEqual(bad.result.isError, true);
    const probe = await s.call('tools/call', { name: 'probe_this_machine', arguments: {} });
    assert.ok(probe.result.structuredContent.ram_gb > 0);
  } finally { s.close(); }
});
