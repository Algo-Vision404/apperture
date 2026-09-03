// GitHub release auto-update for packaged Electron builds (Windows NSIS today).
const { app } = require('electron');
const { formatUpdateUserMessage } = require('./update-messages');

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
    if (patch && patch.message != null) {
      patch.message = formatUpdateUserMessage(patch.phase || state.phase, patch.message);
    } else if (patch && patch.phase && !patch.message) {
      patch.message = formatUpdateUserMessage(patch.phase, '');
    }
    Object.assign(state, patch);
    send('update:status', { ...state });
  }

  if (!app.isPackaged) {
    const devMessage = 'Auto-update only works in the installed desktop app. Download apperture-win-x64.exe from GitHub Releases.';
    function devState() {
      return {
        ...state,
        packaged: false,
        message: state.message || devMessage
      };
    }
    return {
      getState: devState,
      check: async () => {
        emit({ phase: 'none', message: devMessage, lastCheckedAt: Date.now() });
        return { ok: false, reason: 'dev', state: devState() };
      },
      install: () => ({ ok: false, reason: 'dev', state: devState() }),
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
    const raw = err && err.message ? err.message : String(err);
    emit({ phase: 'error', message: raw, lastCheckedAt: Date.now() });
  });

  let timer = null;

  function snapshot() {
    const out = { ...state, packaged: true };
    if (!out.message) out.message = formatUpdateUserMessage(out.phase, '');
    return out;
  }

  return {
    getState: snapshot,
    async check() {
      try {
        emit({ phase: 'checking', message: 'Checking for updates…', lastCheckedAt: Date.now() });
        const result = await autoUpdater.checkForUpdates();
        if (state.phase === 'checking') {
          const nextVersion = result && result.updateInfo && result.updateInfo.version;
          if (nextVersion) {
            emit({
              phase: 'available',
              availableVersion: nextVersion,
              message: `Update ${nextVersion} is downloading…`,
              lastCheckedAt: Date.now()
            });
          } else {
            emit({
              phase: 'none',
              availableVersion: null,
              message: 'You’re on the latest version.',
              lastCheckedAt: Date.now()
            });
          }
        }
        return { ok: true, state: snapshot() };
      } catch (err) {
        const raw = err.message || String(err);
        emit({ phase: 'error', message: raw, lastCheckedAt: Date.now() });
        return { ok: false, error: raw, state: snapshot() };
      }
    },
    install() {
      if (state.phase !== 'ready') return { ok: false, reason: 'not-ready', state: snapshot() };
      autoUpdater.quitAndInstall(false, true);
      return { ok: true, state: snapshot() };
    },
    start() {
      setTimeout(() => { void this.check(); }, STARTUP_DELAY_MS);
      if (timer) clearInterval(timer);
      timer = setInterval(() => { void this.check(); }, CHECK_INTERVAL_MS);
    }
  };
}

module.exports = { createAutoUpdate };
