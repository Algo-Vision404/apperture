const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pkg = require('../package.json');
const builder = require('../electron-builder.cjs');

test('electron-builder publishes to GitHub for in-app updates', () => {
  assert.equal(builder.publish.provider, 'github');
  assert.equal(builder.publish.owner, 'Algo-Vision404');
  assert.equal(builder.publish.repo, 'apperture');
});

test('dist scripts never pass --publish (prevents accidental GH overwrites)', () => {
  for (const [name, script] of Object.entries(pkg.scripts)) {
    if (!/electron-builder/.test(script)) continue;
    assert.ok(!/--publish/.test(script), `${name} must not auto-publish: ${script}`);
  }
});

test('NSIS builds ship differential updates for electron-updater', () => {
  assert.equal(builder.nsis.differentialPackage, true);
});

test('auto-update module exists and only runs when packaged', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/auto-update.js'), 'utf8');
  assert.match(src, /electron-updater/);
  assert.match(src, /app\.isPackaged/);
});

test('main, preload, and renderer expose update IPC', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  assert.match(main, /createAutoUpdate/);
  assert.match(main, /update:check/);
  assert.match(preload, /updateCheck/);
  assert.match(preload, /update:status/);
  assert.match(renderer, /initAutoUpdateUi/);
});

test('release script uploads latest.yml with the installer', () => {
  const script = fs.readFileSync(path.join(__dirname, '../scripts/release-win.js'), 'utf8');
  assert.match(script, /latest\.yml/);
  assert.match(script, /apperture-win-x64\.exe\.blockmap/);
});
