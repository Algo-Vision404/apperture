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
run('node', ['scripts/generate-app-icon.js']);
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
      `New Open Iris app icon for taskbar, Start menu, and installer.`,
      '',
      '- Redesigned gold squircle icon matching the in-app logo',
      '- Crisp multi-size Windows icon (16–256px)',
      '',
      '**If you are still on 0.1.10:** Check for updates will not work — download `apperture-win-x64.exe` once and run it.',
      '',
      'On 0.1.12+: open Settings → Updates → Check for updates, then restart to apply.'
    ].join('\n')
  ]);
}

run('gh', [
  'release', 'upload', tag,
  '--repo', 'Algo-Vision404/apperture',
  '--clobber',
  ...assets
]);

const releaseBase = `https://github.com/Algo-Vision404/apperture/releases/download/${tag}/`;
const latestRaw = fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8');
const feed = latestRaw
  .replace(/url:\s*apperture-win-x64\.exe/g, `url: ${releaseBase}apperture-win-x64.exe`)
  .replace(/^path:\s*apperture-win-x64\.exe/m, `path: ${releaseBase}apperture-win-x64.exe`);
const feedDir = path.join(root, 'updates');
fs.mkdirSync(feedDir, { recursive: true });
fs.writeFileSync(path.join(feedDir, 'latest.yml'), feed);
try {
  run('git', ['add', 'updates/latest.yml']);
  run('git', ['commit', '-m', `Publish update feed for ${tag}`]);
  try { run('git', ['push', 'github', 'HEAD:main']); } catch (_) {}
  try { run('git', ['push', 'origin', 'HEAD:main']); } catch (_) {}
} catch (err) {
  console.warn('Could not push updates/latest.yml (commit may already exist):', err.message || err);
}

console.log(`Published ${tag} with auto-update metadata (latest.yml).`);
