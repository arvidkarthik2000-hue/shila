'use strict';
/*
 * Detect the machine this process runs on. Read-only: runs vendor query tools when present
 * (nvidia-smi, rocm-smi, sysctl, PowerShell CIM queries, lspci) and never installs anything.
 * Copyright 2026 Dr. Arvind Karthikeyan. Apache-2.0.
 */
const os = require('os');
const { execFileSync } = require('child_process');
const { describeBox } = require('./box.js');

function run(cmd, args, timeout = 6000) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); }
  catch (e) { return ''; }
}

function probe() {
  const plat = os.platform();
  const spec = { os: plat === 'darwin' ? 'macos' : plat === 'win32' ? 'windows' : 'linux' };
  const found = [];
  spec.ram_gb = Math.round(os.totalmem() / 1024 ** 3);
  spec.cpu = (os.cpus()[0] && os.cpus()[0].model || '').replace(/\s+/g, ' ').trim();

  if (spec.os === 'macos') {
    const chip = run('sysctl', ['-n', 'machdep.cpu.brand_string']);
    if (chip) { spec.cpu = chip; found.push('sysctl'); }
    spec.ram_gb = Math.round(Number(run('sysctl', ['-n', 'hw.memsize'])) / 1024 ** 3) || spec.ram_gb;
    spec.gpu = chip;
    if (/m[1-6]\s*max/i.test(chip)) {
      const cores = Number((run('system_profiler', ['SPDisplaysDataType'], 15000).match(/Total Number of Cores:\s*(\d+)/) || [])[1]);
      // the binned Max chips have less bandwidth
      if (/m5\s*max/i.test(chip) && cores && cores < 40) spec.ram_bandwidth_gbs = 460;
      if (/m4\s*max/i.test(chip) && cores && cores < 40) spec.ram_bandwidth_gbs = 410;
    }
  }

  // NVIDIA
  const nv = run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  if (nv) {
    const first = nv.split('\n')[0].split(',').map(x => x.trim());
    spec.gpu = first[0]; spec.vram_gb = Math.round(Number(first[1]) / 1024);
    const count = nv.split('\n').length;
    if (count > 1) spec.note = `${count} NVIDIA GPUs found; sizing uses the first one`;
    found.push('nvidia-smi');
  }
  // AMD (Linux)
  if (!spec.gpu || spec.os === 'linux') {
    const amd = run('rocm-smi', ['--showproductname']);
    if (!spec.gpu && amd) {
      const m = amd.match(/Card series:\s*(.+)/i) || amd.match(/Card model:\s*(.+)/i);
      if (m) { spec.gpu = m[1].trim(); found.push('rocm-smi'); }
      const mem = run('rocm-smi', ['--showmeminfo', 'vram']).match(/Total Memory \(B\):\s*(\d+)/);
      if (mem) spec.vram_gb = Math.round(Number(mem[1]) / 1024 ** 3);
    }
  }
  // Windows: GPU name and RAM speed / slot count
  if (spec.os === 'windows') {
    const ps = (q) => run('powershell', ['-NoProfile', '-Command', q], 12000);
    if (!spec.gpu) {
      const g = ps('(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join "|"');
      if (g) { spec.gpu = g.split('|').find(n => !/microsoft basic|remote/i.test(n)) || g.split('|')[0]; found.push('Win32_VideoController'); }
    }
    const mem = ps('Get-CimInstance Win32_PhysicalMemory | ForEach-Object { "$($_.Speed);$($_.SMBIOSMemoryType)" }');
    if (mem) {
      const sticks = mem.split(/\r?\n/).filter(Boolean);
      const speed = Number((sticks[0] || '').split(';')[0]);
      const type = Number((sticks[0] || '').split(';')[1]);
      spec.ram_type = type === 34 ? 'ddr5' : type === 26 ? 'ddr4' : type === 35 ? 'lpddr5' : '';
      spec.ram_channels = Math.min(2, sticks.length);
      if (speed) spec.ram_bandwidth_gbs = Math.round(speed * 8 * spec.ram_channels / 1000 * 0.92);
      found.push('Win32_PhysicalMemory');
    }
  }
  // Linux: integrated GPU / RAM type
  if (spec.os === 'linux') {
    if (!spec.gpu) {
      const pci = run('lspci', []);
      const line = pci.split('\n').find(l => /VGA|3D controller|Display/i.test(l));
      if (line) { spec.gpu = line.replace(/^.*?:\s*/, '').replace(/^.*?:\s*/, ''); found.push('lspci'); }
    }
    const dmi = run('dmidecode', ['-t', 'memory']);
    if (dmi) {
      const t = dmi.match(/Type:\s*(DDR\d|LPDDR\d\w?)/i);
      const sp = dmi.match(/Configured Memory Speed:\s*(\d+)/i);
      const sticks = (dmi.match(/Size:\s*\d+\s*[GM]B/g) || []).length;
      if (t) spec.ram_type = t[1].toLowerCase();
      if (sp && sticks) spec.ram_bandwidth_gbs = Math.round(Number(sp[1]) * 8 * Math.min(2, sticks) / 1000 * 0.92);
      found.push('dmidecode');
    }
    if (/raspberry/i.test(run('cat', ['/proc/device-tree/model']))) spec.cpu = 'Raspberry Pi ' + spec.cpu;
  }
  if (spec.gpu && !nv && !/nvidia|geforce|rtx|gtx/i.test(spec.gpu) && !spec.vram_gb && !/radeon rx|rx \d{4}|arc b|arc a/i.test(spec.gpu)) {
    // integrated graphics: no separate VRAM
    delete spec.vram_gb;
  }
  const box = describeBox(Object.assign({ name: `This machine (${os.hostname()})` }, spec));
  box.id = 'this-machine';
  box.detectedWith = found;
  box.rawSpec = spec;
  return box;
}

module.exports = { probe };
