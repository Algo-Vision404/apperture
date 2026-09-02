const assert = require('node:assert/strict');
const test = require('node:test');
const {
  getWindowsBuild,
  macOsSharingWeakened,
  buildCaptureProtectionStatus,
  applyCaptureProtection
} = require('../src/capture-protection');

test('buildCaptureProtectionStatus marks Linux as unsupported', () => {
  const s = buildCaptureProtectionStatus({ platform: 'linux', winBuild: 0 });
  assert.equal(s.level, 'unsupported');
  assert.equal(s.applied, false);
});

test('buildCaptureProtectionStatus marks old Windows as unsupported', () => {
  const s = buildCaptureProtectionStatus({ platform: 'win32', winBuild: 18363 });
  assert.equal(s.level, 'unsupported');
});

test('buildCaptureProtectionStatus marks modern Windows as protected', () => {
  const s = buildCaptureProtectionStatus({ platform: 'win32', winBuild: 22621 });
  assert.equal(s.level, 'protected');
  assert.equal(s.applied, true);
});

test('buildCaptureProtectionStatus marks macOS 15.4+ as partial', () => {
  const s = buildCaptureProtectionStatus({
    platform: 'darwin',
    macOs: { major: 15, minor: 4, patch: 0 }
  });
  assert.equal(s.level, 'partial');
});

test('macOsSharingWeakened detects 15.4+', () => {
  assert.equal(macOsSharingWeakened({ major: 15, minor: 3 }), false);
  assert.equal(macOsSharingWeakened({ major: 15, minor: 4 }), true);
});

test('applyCaptureProtection no-ops without a window', () => {
  const r = applyCaptureProtection(null, { platform: 'win32', winBuild: 22621 });
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'no-window');
});

test('getWindowsBuild returns numeric build on win32', () => {
  const b = getWindowsBuild();
  assert.equal(typeof b, 'number');
});
