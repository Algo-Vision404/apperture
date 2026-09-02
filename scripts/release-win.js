#!/usr/bin/env node
// Build Windows installer + upload exe, latest.yml, and blockmap for auto-update.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { verifyWinInstaller } = require('./verify-win-installer');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const version = pkg.version;
const tag = `v${version}`;
const dist = path.join(root, 'dist');
const hasWinCert = process.env.WIN_SIGN === '1' && !!process.env.CSC_LINK;
const assets = [
  path.join(dist, 'apperture-win-x64.exe'),
  path.join(dist, 'latest.yml'),
  path.join(dist, 'apperture-win-x64.exe.blockmap')
];

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
}

console.log(`Building apperture ${version} for Windows…`);
run('npm', ['run', 'dist:win'], {
  env: {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    CSC_LINK: hasWinCert ? process.env.CSC_LINK : '',
    WIN_CSC_LINK: hasWinCert ? (process.env.WIN_CSC_LINK || process.env.CSC_LINK || '') : '',
    CSC_KEY_PASSWORD: hasWinCert ? (process.env.CSC_KEY_PASSWORD || '') : ''
  }
});

const installerInfo = verifyWinInstaller(dist);
console.log(`Verified installer integrity (${installerInfo.bytes} bytes).`);

for (const filePath of assets) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing release asset: ${filePath}`);
  }
}

let releaseExists = false;
try {
  execFileSync('gh', ['release', 'view', tag, '--repo', 'Algo-Vision404/apperture'], { stdio: 'pipe' });
  releaseExists = true;
} catch (_) {
  releaseExists = false;
}

if (!releaseExists) {
  run('gh', [
    'release', 'create', tag,
    '--repo', 'Algo-Vision404/apperture',
    '--title', `apperture ${tag}`,
    '--notes', [
      `Desktop build with GitHub auto-update.`,
      '',
      'Installed apps check for updates automatically and restart to apply.',
      '',
      '**Windows:** download `apperture-win-x64.exe` (first install only).'
    ].join('\n')
  ]);
}

run('gh', [
  'release', 'upload', tag,
  '--repo', 'Algo-Vision404/apperture',
  '--clobber',
  ...assets
]);

console.log(`Published ${tag} with auto-update metadata (latest.yml).`);
