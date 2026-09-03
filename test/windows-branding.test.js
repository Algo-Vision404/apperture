const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('packaged app uses honest apperture process branding', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.match(main, /APP_WIN_NAME\s*=\s*['"]apperture['"]/);
  assert.doesNotMatch(main, /Microsoft Edge Update/);
  assert.doesNotMatch(main, /MicrosoftEdgeUpdate/);
});

test('postinstall does not spoof Microsoft Edge Update', () => {
  const script = fs.readFileSync(path.join(__dirname, '../scripts/rename-electron.js'), 'utf8');
  assert.doesNotMatch(script, /MicrosoftEdgeUpdate/);
  assert.doesNotMatch(script, /Microsoft Corporation/);
});
