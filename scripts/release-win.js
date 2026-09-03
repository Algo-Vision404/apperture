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
      `Clearer fix for “401 User not found” and mic transcription failures.`,
      '',
      '- OpenRouter 401 now explains invalid/expired/wrong key types (needs sk-or-v1-…)',
      '- Warns when an OpenAI key is pasted while Provider is OpenRouter (and vice versa)',
      '- Mic captions: clearer guidance to add a free Groq key under Settings → Audio',
      '- Strips Bearer/quotes from pasted API keys',
      '',
      '**If Check for updates still fails on 0.1.10:** download `apperture-win-x64.exe` once and run it.',
      '',
      'On 0.1.12+: Settings → Updates → Check for updates, then restart.'
    ].join('\n')
  ]);
}

run('gh', [
  'release', 'upload', tag,
  '--repo', 'Algo-Vision404/apperture',
  '--clobber',
  ...assets
]);

// Re-upload once more after a short wait so a racing CI job cannot leave a
// mismatched exe next to our latest.yml (integrity failures in the app).
const installerPath = path.join(dist, 'apperture-win-x64.exe');
const expectedSha = installerInfo.sha512;
const expectedBytes = installerInfo.bytes;
function releaseExeMeta() {
  const json = execFileSync(
    'gh',
    ['api', `repos/Algo-Vision404/apperture/releases/tags/${tag}`, '--jq',
      '.assets[] | select(.name=="apperture-win-x64.exe") | {size}'],
    { encoding: 'utf8', cwd: root }
  ).trim();
  return JSON.parse(json);
}
let remote = releaseExeMeta();
if (remote.size !== expectedBytes) {
  console.warn(`Release exe size ${remote.size} != local ${expectedBytes}; re-clobbering…`);
  run('gh', [
    'release', 'upload', tag,
    '--repo', 'Algo-Vision404/apperture',
    '--clobber',
    installerPath,
    path.join(dist, 'latest.yml'),
    path.join(dist, 'apperture-win-x64.exe.blockmap')
  ]);
  remote = releaseExeMeta();
  if (remote.size !== expectedBytes) {
    throw new Error(
      `Published apperture-win-x64.exe is still ${remote.size} bytes (expected ${expectedBytes}). ` +
      'A CI job may be overwriting the release — disable Windows uploads in release.yml.'
    );
  }
}
console.log(`Release exe matches build (${expectedBytes} bytes, sha512 ${expectedSha.slice(0, 12)}…).`);

const releaseBase = `https://github.com/Algo-Vision404/apperture/releases/download/${tag}/`;
const latestRaw = fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8');
let feed = latestRaw
  .replace(/url:\s*apperture-win-x64\.exe/g, `url: ${releaseBase}apperture-win-x64.exe`)
  .replace(/^path:\s*apperture-win-x64\.exe/m, `path: ${releaseBase}apperture-win-x64.exe`);
if (!/^size:/m.test(feed)) {
  feed = feed.replace(/^(sha512:.*)$/m, `$1\nsize: ${expectedBytes}`);
}
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
