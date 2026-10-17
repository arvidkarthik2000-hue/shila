#!/usr/bin/env node
'use strict';
// Bundles site/page.html + data/*.json + src/box.js + src/core.js + site/ui.js into one static page.
//   node scripts/build-site.js           → docs/index.html (GitHub Pages)
//   node scripts/build-site.js --check   → exit 1 if docs/index.html is stale
//   node scripts/build-site.js --fragment <out>  → body-only page (for hosts that add their own <head>)
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const data = {
  models: JSON.parse(read('data/models.json')),
  hardware: JSON.parse(read('data/hardware.json')),
  meta: JSON.parse(read('data/meta.json')),
};
const strip = (src) => src.replace(/^if \(typeof module[^\n]*\n/gm, '').replace(/^'use strict';\n/, '');
const scripts = [
  `window.SHILA_DATA = ${JSON.stringify(data)};`,
  strip(read('src/box.js')),
  strip(read('src/core.js')),
  read('site/ui.js'),
].map(s => `<script>\n${s.replace(/<\/script/gi, '<\\/script')}\n</script>`).join('\n');
const body = read('site/page.html') + '\n' + scripts + '\n';

const desc = 'Which open-weight LLM fits which machine, how fast it runs, and which inference engine to use — from a Raspberry Pi to a DGX Spark. Free, open source, with an MCP server.';
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="${desc}">
<meta property="og:title" content="SHILA — local AI fitment planner">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="website">
<meta name="author" content="Dr. Arvind Karthikeyan">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect x="4" y="30" width="40" height="8" rx="2" fill="#7b8690"/><rect x="8" y="21" width="32" height="8" rx="2" fill="#4a535b"/><rect x="13" y="12" width="22" height="8" rx="2" fill="#9a4f1e"/><rect x="19" y="5" width="10" height="6" rx="2" fill="#1a1e21"/></svg>')}">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
${body}</body>
</html>
`;

const args = process.argv.slice(2);
if (args[0] === '--fragment') { fs.writeFileSync(args[1], body); console.log('wrote ' + args[1]); process.exit(0); }
const out = path.join(root, 'docs', 'index.html');
if (args[0] === '--check') {
  const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (cur !== page) { console.error('docs/index.html is out of date: run npm run build'); process.exit(1); }
  console.log('docs/index.html is up to date'); process.exit(0);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, page);
console.log(`wrote docs/index.html (${(page.length / 1024).toFixed(0)} KB)`);
