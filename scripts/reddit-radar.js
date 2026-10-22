#!/usr/bin/env node
'use strict';
// Scans r/LocalLLaMA for posts SHILA should look at: new models/engines not in the catalogue,
// and posts that carry tok/s measurements. It only reports; data/ is edited by a person (sources required).
//   node scripts/reddit-radar.js [--file feed.xml] [--json]
// Reddit often blocks datacenter IPs on anonymous requests; set REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET to use OAuth.
const fs = require('fs');
const path = require('path');

const FEEDS = [
  'https://www.reddit.com/r/LocalLLaMA/top/.rss?t=day&limit=100',
  'https://www.reddit.com/r/LocalLLaMA/new/.rss?limit=100',
];
const UA = 'shila-radar/0.1 (+https://github.com/arvidkarthik2000-hue/shila)';
const TOKS = /\b\d+(?:\.\d+)?\s*(?:t\/s|tok\/s|tps|tokens?\s*(?:\/|per)\s*s(?:ec(?:ond)?)?)\b/i;
const RELEASE = /\b(release[sd]?|launch(?:es|ed)?|open[- ]weights?|new model|gguf|nvfp4|mxfp4|benchmark)\b/i;
const ENGINE = /\b(llama\.cpp|vllm|sglang|mlx|ollama|exllama|ik_llama|mistral\.rs|lm studio)\b/i;
const MODEL_SIZE = /\b\d{1,3}(?:\.\d)?B(?:[- ]?A\d(?:\.\d)?B)?\b/;

const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');

function parseAtom(xml) {
  const out = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const title = (e.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1];
    const url = (e.match(/<link[^>]*href="([^"]+)"/) || [])[1];
    const updated = (e.match(/<updated>([^<]+)<\/updated>/) || [])[1];
    const body = (e.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || '';
    if (title && url) out.push({ title: decode(title).trim(), url: decode(url), updated, text: decode(body).replace(/<[^>]+>/g, ' ') });
  }
  return out;
}

function knownTerms(models, hardware) {
  const t = new Set();
  for (const m of models) {
    for (const s of [m.id, m.name, m.hf.split('/').pop(), m.family]) t.add(String(s).toLowerCase());
  }
  return t;
}

// Classify one post. Returns null when it is not interesting.
function classify(post, terms) {
  const hay = `${post.title}\n${post.text}`;
  const lower = hay.toLowerCase();
  const hasToks = TOKS.test(hay), hasRelease = RELEASE.test(post.title), hasEngine = ENGINE.test(hay);
  const sized = MODEL_SIZE.test(post.title);
  const known = [...terms].some(k => k.length > 3 && lower.includes(k));
  const tags = [];
  if (hasToks && (hasEngine || /benchmark/i.test(post.title))) tags.push(known ? 'measurement' : 'measurement-unknown-model');
  if (hasRelease && sized && !known) tags.push('possible-new-model');
  if (!tags.length) return null;
  return { ...post, text: undefined, tags, known };
}

async function fetchFeed(url) {
  const id = process.env.REDDIT_CLIENT_ID, secret = process.env.REDDIT_CLIENT_SECRET;
  let headers = { 'User-Agent': UA };
  if (id && secret) {
    const r = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: { 'User-Agent': UA, Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const j = await r.json();
    headers = { 'User-Agent': UA, Authorization: `Bearer ${j.access_token}` };
    url = url.replace('https://www.reddit.com', 'https://oauth.reddit.com');
  }
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.text();
}

async function main() {
  const args = process.argv.slice(2);
  const fi = args.indexOf('--file');
  const root = path.join(__dirname, '..');
  const models = JSON.parse(fs.readFileSync(path.join(root, 'data', 'models.json'), 'utf8'));
  const terms = knownTerms(models);
  let xmls = [], errors = [];
  if (fi >= 0) xmls = [fs.readFileSync(args[fi + 1], 'utf8')];
  else for (const f of FEEDS) { try { xmls.push(await fetchFeed(f)); } catch (e) { errors.push(e.message); } }
  const seen = new Set(), hits = [];
  for (const x of xmls) for (const p of parseAtom(x)) {
    if (seen.has(p.url)) continue; seen.add(p.url);
    const c = classify(p, terms); if (c) hits.push(c);
  }
  if (args.includes('--json')) { console.log(JSON.stringify({ hits, errors }, null, 2)); }
  else {
    const lines = [`Reddit radar: ${hits.length} post(s) worth a look (${seen.size} scanned)`, ''];
    for (const h of hits) lines.push(`- [${h.title}](${h.url}) — ${h.tags.join(', ')}`);
    for (const e of errors) lines.push('', `fetch failed: ${e}`);
    console.log(lines.join('\n'));
  }
  if (!xmls.length) process.exit(2);
}

module.exports = { parseAtom, classify, knownTerms };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
