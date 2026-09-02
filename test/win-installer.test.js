const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { verifyWinInstaller } = require('../scripts/verify-win-installer');

test('verifyWinInstaller rejects missing or inconsistent release assets', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apperture-installer-'));
  const installerPath = path.join(tmp, 'apperture-win-x64.exe');
  const latestPath = path.join(tmp, 'latest.yml');
  const blockmapPath = path.join(tmp, 'apperture-win-x64.exe.blockmap');

  const installer = Buffer.concat([
    Buffer.from('MZ'),
    Buffer.alloc(1200, 0),
    Buffer.from('NullsoftInst')
  ]);
  fs.writeFileSync(installerPath, installer);
  fs.writeFileSync(blockmapPath, '{}');

  const sha512 = crypto.createHash('sha512').update(installer).digest('base64');
  fs.writeFileSync(latestPath, `version: 0.0.0\npath: apperture-win-x64.exe\nsha512: ${sha512}\nsize: ${installer.length}\n`);

  assert.doesNotThrow(() => verifyWinInstaller(tmp));

  fs.writeFileSync(latestPath, `version: 0.0.0\npath: apperture-win-x64.exe\nsha512: broken\nsize: ${installer.length}\n`);
  assert.throws(() => verifyWinInstaller(tmp), /sha512 does not match/);
});
