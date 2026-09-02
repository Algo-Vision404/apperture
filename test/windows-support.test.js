const assert = require('node:assert/strict');
const test = require('node:test');

const builder = require('../electron-builder.cjs');
const pkg = require('../package.json');

test('defines an explicit Windows x64 package target', () => {
  assert.equal(pkg.scripts['pack:win'], 'electron-builder --win --dir');
  assert.equal(pkg.scripts['dist:win'], 'electron-builder --win');
  assert.deepEqual(builder.win.target, [{ target: 'nsis', arch: ['x64'] }]);
});

test('ships every runtime directory in packaged builds', () => {
  assert.ok(builder.files.includes('main.js'));
  assert.ok(builder.files.includes('preload.js'));
  assert.ok(builder.files.includes('src/**/*'));
  assert.ok(builder.files.includes('renderer/**/*'));
});

test('Windows installer registers uninstaller for Settings > Apps', () => {
  assert.equal(builder.nsis.perMachine, true);
  assert.equal(builder.nsis.allowElevation, true);
  assert.equal(builder.nsis.createStartMenuShortcut, true);
  assert.equal(builder.nsis.menuCategory, 'apperture');
  assert.equal(builder.nsis.uninstallDisplayName, 'apperture');
  assert.equal(builder.nsis.include, 'build-resources/installer.nsh');
  assert.equal(pkg.author, 'apperture');
  const installerNsh = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../build-resources/installer.nsh'),
    'utf8'
  );
  assert.match(installerNsh, /UNINSTALL_FILENAME/);
  assert.match(installerNsh, /Uninstall \$\{PRODUCT_NAME\}/);
});
