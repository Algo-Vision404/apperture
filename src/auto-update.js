// GitHub release auto-update for packaged Electron builds (Windows NSIS today).
const { app } = require('electron');

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 12 * 1000;

function createAutoUpdate(send) {
  const state = {
    phase: 'idle',
    version: app.getVersion(),
    availableVersion: null,
    percent: 0,
    message: '',
    lastCheckedAt: null
  };

  function emit(patch) {
    Object.assign(state, patch);
    send('update:status', { ...state });
  }

  if (!app.isPackaged) {
    return {
      getState: () => ({ ...state, packaged: false }),
      check: async () => ({ ok: false, reason: 'dev' }),
      install: () => ({ ok: false, reason: 'dev' }),
      start: () => {}
    };
  }

  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  // Full installers only — differential NSIS patches can corrupt the uninstaller.
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.logger = {
    info: () => {},
    warn: () => {},
    error: () => {}
  };

  autoUpdater.on('checking-for-update', () => {
    emit({ phase: 'checking', message: 'Checking for updates…', lastCheckedAt: Date.now() });
  });
  autoUpdater.on('update-available', (info) => {
    emit({
      phase: 'available',
      availableVersion: info.version,
      message: `Update ${info.version} is downloading…`
    });
  });
  autoUpdater.on('update-not-available', () => {
    emit({ phase: 'none', availableVersion: null, message: 'You’re on the latest version.', lastCheckedAt: Date.now() });
  });
  autoUpdater.on('download-progress', (progress) => {
    emit({
      phase: 'downloading',
      percent: Math.round(progress.percent || 0),
      message: `Downloading update… ${Math.round(progress.percent || 0)}%`
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    emit({
      phase: 'ready',
      availableVersion: info.version,
      percent: 100,
      message: `Update ${info.version} is ready — restart to install.`
    });
  });
  autoUpdater.on('error', (err) => {
    const message = err && err.message ? err.message : String(err);
    emit({ phase: 'error', message, lastCheckedAt: Date.now() });
  });

  let timer = null;

  return {
    getState: () => ({ ...state, packaged: true }),
    async check() {
      try {
        await autoUpdater.checkForUpdates();
        return { ok: true };
      } catch (err) {
        emit({ phase: 'error', message: err.message || String(err), lastCheckedAt: Date.now() });
        return { ok: false, error: err.message || String(err) };
      }
    },
    install() {
      if (state.phase !== 'ready') return { ok: false, reason: 'not-ready' };
      autoUpdater.quitAndInstall(false, true);
      return { ok: true };
    },
    start() {
      setTimeout(() => { void this.check(); }, STARTUP_DELAY_MS);
      if (timer) clearInterval(timer);
      timer = setInterval(() => { void this.check(); }, CHECK_INTERVAL_MS);
    }
  };
}

module.exports = { createAutoUpdate };
