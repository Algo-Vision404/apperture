#!/usr/bin/env node
// Fail the release if the NSIS installer or latest.yml metadata is inconsistent.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function verifyWinInstaller(distDir) {
  const installerPath = path.join(distDir, 'apperture-win-x64.exe');
  const latestPath = path.join(distDir, 'latest.yml');
  const blockmapPath = path.join(distDir, 'apperture-win-x64.exe.blockmap');

  for (const filePath of [installerPath, latestPath, blockmapPath]) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing release asset: ${filePath}`);
    }
  }

  const installer = fs.readFileSync(installerPath);
  if (installer.length < 1024) {
    throw new Error('Installer is unexpectedly small — build likely failed.');
  }
  if (installer[0] !== 0x4d || installer[1] !== 0x5a) {
    throw new Error('Installer is not a valid Windows executable (missing MZ header).');
  }
  if (!installer.includes(Buffer.from('Nullsoft'))) {
    throw new Error('Installer is missing the NSIS Nullsoft marker.');
  }

  const sha512 = crypto.createHash('sha512').update(installer).digest('base64');
  const latest = fs.readFileSync(latestPath, 'utf8');
  const match = latest.match(/^sha512:\s*(\S+)/m);
  if (!match) {
    throw new Error('latest.yml is missing sha512 metadata.');
  }
  if (match[1] !== sha512) {
    throw new Error('latest.yml sha512 does not match the built installer.');
  }

  const sizeMatch = latest.match(/^size:\s*(\d+)/m);
  if (sizeMatch && Number(sizeMatch[1]) !== installer.length) {
    throw new Error('latest.yml size does not match the built installer.');
  }

  return {
    bytes: installer.length,
    sha512
  };
}

module.exports = { verifyWinInstaller };

if (require.main === module) {
  const distDir = path.join(__dirname, '..', 'dist');
  const info = verifyWinInstaller(distDir);
  console.log(`Installer OK (${info.bytes} bytes, sha512 verified).`);
}
