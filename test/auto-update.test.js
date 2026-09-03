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

test('NSIS builds use full installers to keep uninstaller intact', () => {
  assert.equal(builder.nsis.differentialPackage, false);
  assert.equal(builder.nsis.uninstallDisplayName, 'apperture');
});

test('Windows signing is opt-in so unsigned NSIS installers are not mutated', () => {
  const original = { ...process.env };
  try {
    delete require.cache[require.resolve('../electron-builder.cjs')];
    delete process.env.WIN_SIGN;
    delete process.env.CSC_LINK;
    const unsigned = require('../electron-builder.cjs');
    assert.equal(unsigned.win.signAndEditExecutable, true);
    assert.equal(unsigned.win.signExecutable, false);
    assert.equal(unsigned.win.verifyUpdateCodeSignature, false);

    delete require.cache[require.resolve('../electron-builder.cjs')];
    process.env.WIN_SIGN = '1';
    process.env.CSC_LINK = '/tmp/cert.pfx';
    const signed = require('../electron-builder.cjs');
    assert.equal(signed.win.signAndEditExecutable, true);
    assert.equal(signed.win.signExecutable, true);
    assert.equal(signed.win.verifyUpdateCodeSignature, true);
  } finally {
    process.env = original;
    delete require.cache[require.resolve('../electron-builder.cjs')];
  }
});

test('auto-update module exists and only runs when packaged', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/auto-update.js'), 'utf8');
  assert.match(src, /electron-updater/);
  assert.match(src, /app\.isPackaged/);
  assert.match(src, /disableDifferentialDownload = true/);
  assert.match(src, /setFeedURL/);
  assert.match(src, /raw\.githubusercontent\.com/);
});

test('main, preload, and renderer expose update IPC', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  assert.match(main, /createAutoUpdate/);
  assert.match(main, /update:check/);
  assert.match(preload, /updateCheck/);
  assert.match(preload, /update:status/);
  assert.match(renderer, /initAutoUpdateUi/);
  assert.match(renderer, /applyUpdateState/);
  assert.match(renderer, /result\.state/);
  assert.match(html, /id="update-last-checked"/);
  assert.match(html, /id="update-download-btn"/);
});

test('auto-update check reconciles against the public feed version', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/auto-update.js'), 'utf8');
  assert.match(src, /return \{ ok: true, state: snapshot\(\) \}/);
  assert.match(src, /function snapshot\(\)/);
  assert.match(src, /fetchRemoteFeedVersion/);
  assert.match(src, /semver\.gt/);
  assert.match(src, /isUpdateAvailable/);
});

test('parseFeedVersion reads latest.yml version lines', () => {
  const { parseFeedVersion } = require('../src/auto-update');
  assert.equal(parseFeedVersion('version: 0.1.14\npath: x'), '0.1.14');
  assert.equal(parseFeedVersion('version: "0.2.0"\n'), '0.2.0');
  assert.equal(parseFeedVersion('nope'), null);
});

test('release script uploads latest.yml with the installer', () => {
  const script = fs.readFileSync(path.join(__dirname, '../scripts/release-win.js'), 'utf8');
  assert.match(script, /latest\.yml/);
  assert.match(script, /apperture-win-x64\.exe\.blockmap/);
  assert.match(script, /verifyWinInstaller/);
});
