// OS-level screen-capture exclusion for Electron BrowserWindows.
// Wraps setContentProtection with platform gating and lifecycle helpers.

const os = require('os');

function getWindowsBuild() {
  if (process.platform !== 'win32') return 0;
  const parts = os.release().split('.').map(Number);
  return parts[2] || 0;
}

function getMacOsVersion() {
  if (process.platform !== 'darwin') return null;
  try {
    const raw = typeof process.getSystemVersion === 'function'
      ? process.getSystemVersion()
      : os.release();
    const parts = String(raw).split('.').map(Number);
    return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
  } catch (_) {
    return null;
  }
}

function macOsSharingWeakened(mac) {
  // Apple relaxed NSWindowSharingNone enforcement in macOS 15.4+.
  if (!mac) return false;
  return mac.major > 15 || (mac.major === 15 && mac.minor >= 4);
}

function buildCaptureProtectionStatus(opts) {
  opts = opts || {};
  const platform = opts.platform || process.platform;
  const winBuild = opts.winBuild != null ? opts.winBuild : getWindowsBuild();
  const disabled = !!opts.disabledEnv;
  const mac = platform === 'darwin' ? (opts.macOs || getMacOsVersion()) : null;
  const winOk = platform !== 'win32' || winBuild >= 19041;

  if (disabled) {
    return {
      level: 'off',
      applied: false,
      platform,
      winBuild,
      macOs: mac,
      message: 'Capture protection disabled (APPERTURE_NO_PROTECT). apperture may appear in screen shares.',
      tips: ['Unset APPERTURE_NO_PROTECT and restart apperture.']
    };
  }
  if (platform === 'linux') {
    return {
      level: 'unsupported',
      applied: false,
      platform,
      winBuild,
      macOs: mac,
      message: 'Linux has no reliable screen-share hiding. Assume apperture is visible when you share your screen.',
      tips: ['Use Windows 10 (2004+) or macOS for capture exclusion.', 'Position apperture off the shared monitor.']
    };
  }
  if (platform === 'win32' && !winOk) {
    return {
      level: 'unsupported',
      applied: false,
      platform,
      winBuild,
      macOs: mac,
      message: `Windows build ${winBuild} cannot hide apperture from screen shares. Upgrade to Windows 10 version 2004+ or Windows 11.`,
      tips: ['Settings → Windows Update', 'Zoom: use Advanced capture with window filtering anyway (may still leak).']
    };
  }
  if (platform === 'darwin' && macOsSharingWeakened(mac)) {
    return {
      level: 'partial',
      applied: true,
      platform,
      winBuild,
      macOs: mac,
      message: 'macOS 15.4+ may ignore capture exclusion in some apps. Treat hiding as best-effort.',
      tips: [
        'Zoom → Share Screen → Advanced → Advanced capture with window filtering.',
        'Avoid sharing the entire display; share a single window when possible.',
        'Enable Stealth mode to hide apperture branding on screen.'
      ]
    };
  }
  return {
    level: 'protected',
    applied: true,
    platform,
    winBuild,
    macOs: mac,
    message: 'Capture exclusion is active. apperture should be omitted from most screen shares (Zoom needs window filtering).',
    tips: [
      'Zoom → Settings → Share Screen → Advanced → Advanced capture with window filtering.',
      'OBS / phone cameras / raw full-screen capture can still show apperture.'
    ]
  };
}

function applyCaptureProtection(browserWindow, opts) {
  opts = opts || {};
  const status = buildCaptureProtectionStatus(opts);
  if (!browserWindow || browserWindow.isDestroyed()) {
    return { ...status, applied: false, reason: 'no-window' };
  }
  if (status.level === 'off' || status.level === 'unsupported') {
    return { ...status, reason: status.level };
  }
  try {
    browserWindow.setContentProtection(true);
    return { ...status, applied: true, reason: 'ok' };
  } catch (e) {
    return {
      ...status,
      applied: false,
      level: 'partial',
      reason: 'error',
      error: e && e.message ? e.message : String(e),
      message: 'Capture exclusion could not be applied: ' + (e && e.message ? e.message : String(e))
    };
  }
}

function wireCaptureProtectionLifecycle(browserWindow, opts) {
  if (!browserWindow || browserWindow.isDestroyed()) return () => {};
  const reapply = () => {
    try { applyCaptureProtection(browserWindow, opts); } catch (_) {}
  };
  const events = ['show', 'restore', 'focus'];
  for (let i = 0; i < events.length; i++) {
    browserWindow.on(events[i], reapply);
  }
  const intervalMs = opts && opts.intervalMs ? opts.intervalMs : 15000;
  const timer = setInterval(reapply, intervalMs);
  browserWindow.on('closed', () => clearInterval(timer));
  reapply();
  return reapply;
}

module.exports = {
  getWindowsBuild,
  getMacOsVersion,
  macOsSharingWeakened,
  buildCaptureProtectionStatus,
  applyCaptureProtection,
  wireCaptureProtectionLifecycle
};
