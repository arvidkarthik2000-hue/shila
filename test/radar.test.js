'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseAtom, classify, knownTerms } = require('../scripts/reddit-radar.js');
const models = require('../data/models.json');

const feed = `<feed><entry><title>[Benchmark] Recursive&#39;s Flint 40B-A2.5B Q4 achieves 130 tok/s with llama.cpp</title>
<link href="https://www.reddit.com/r/LocalLLaMA/comments/abc/x/"/><updated>2026-10-22T10:00:00Z</updated><content type="html">&lt;p&gt;M4 Pro&lt;/p&gt;</content></entry>
<entry><title>Acme releases Zeta 70B-A5B open weights</title><link href="https://www.reddit.com/r/LocalLLaMA/comments/def/y/"/></entry>
<entry><title>What GPU should I buy?</title><link href="https://www.reddit.com/r/LocalLLaMA/comments/ghi/z/"/></entry></feed>`;

test('radar flags measurements of catalogued models and unknown new models, ignores chatter', () => {
  const terms = knownTerms(models);
  const posts = parseAtom(feed);
  assert.strictEqual(posts.length, 3);
  const hits = posts.map(p => classify(p, terms)).filter(Boolean);
  assert.strictEqual(hits.length, 2);
  assert.ok(hits[0].tags.includes('measurement') && hits[0].known);
  assert.ok(hits[1].tags.includes('possible-new-model'));
});
