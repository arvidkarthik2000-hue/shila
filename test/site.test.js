'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');

test('docs/index.html is rebuilt from the current sources', () => {
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-site.js'), '--check'], { stdio: 'pipe' });
  assert.ok(true);
});
