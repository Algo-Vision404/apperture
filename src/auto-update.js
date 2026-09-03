// GitHub release auto-update for packaged Electron builds (Windows NSIS today).
const { app } = require('electron');
const semver = require('semver');
const { formatUpdateUserMessage } = require('./update-messages');

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 12 * 1000;
const GITHUB_OWNER = 'Algo-Vision404';
const GITHUB_REPO = 'apperture';
// Raw file — 200 OK, no GitHub asset-CDN redirect. 0.1.10 still uses baked GitHub
// provider and cannot be patched; this feed is for 0.1.12+.
const GENERIC_FEED_URL = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/main/updates`;
const FEED_YML_URL = `${GENERIC_FEED_URL}/latest.yml`;
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  Pragma: 'no-cache'
};

function parseFeedVersion(ymlText) {
  const match = /^version:\s*["']?(\d+\.\d+\.\d+[^\s"']*)/m.exec(String(ymlText || ''));
  return match ? match[1] : null;
}

async function fetchRemoteFeedVersion() {
  const url = `${FEED_YML_URL}?t=${Date.now()}`;
  const res = await fetch(url, { headers: NO_CACHE_HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error(`Feed HTTP ${res.status}`);
  return parseFeedVersion(await res.text());
}

function createAutoUpdate(send) {
  const state = {
    phase: 'idle',
    version: app.getVersion(),
    availableVersion: null,
    percent: 0,
    message: '',
    lastCheckedAt: null,
    downloadUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
    remoteVersion: null
  };

  let checkEpoch = 0;

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
  autoUpdater.requestHeaders = { ...NO_CACHE_HEADERS };
  autoUpdater.logger = {
    info: () => {},
    warn: () => {},
    error: () => {}
  };

  function useGenericFeed() {
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: GENERIC_FEED_URL,
      requestHeaders: { ...NO_CACHE_HEADERS }
    });
    autoUpdater.requestHeaders = { ...NO_CACHE_HEADERS };
  }
  function useGithubFeed() {
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      requestHeaders: { ...NO_CACHE_HEADERS }
    });
    autoUpdater.requestHeaders = { ...NO_CACHE_HEADERS };
  }
  useGenericFeed();

  autoUpdater.on('checking-for-update', () => {
    emit({ phase: 'checking', message: 'Checking for updates…', lastCheckedAt: Date.now() });
  });
  autoUpdater.on('update-available', (info) => {
    emit({
      phase: 'available',
      availableVersion: info.version,
      remoteVersion: info.version,
      message: `Update ${info.version} is downloading…`
    });
  });
  autoUpdater.on('update-not-available', (info) => {
    const remote = info && info.version ? info.version : null;
    const local = app.getVersion();
    // Don't trust this event alone — a stale feed can claim "latest" while GitHub has newer.
    // check() reconciles against a no-cache feed fetch after the promise settles.
    emit({
      phase: 'none',
      availableVersion: null,
      remoteVersion: remote,
      message: remote && remote !== local
        ? `Updater reported no update (installed ${local}, feed ${remote}). Verifying…`
        : `You’re on the latest version (${local}).`,
      lastCheckedAt: Date.now()
    });
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
      remoteVersion: info.version,
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
    const out = { ...state, packaged: true, version: app.getVersion() };
    if (!out.message) out.message = formatUpdateUserMessage(out.phase, '');
    return out;
  }

  async function checkOnce() {
    try {
      useGenericFeed();
      return await autoUpdater.checkForUpdates();
    } catch (err) {
      useGithubFeed();
      return await autoUpdater.checkForUpdates();
    }
  }

  function applyAvailable(remoteVersion, downloading) {
    emit({
      phase: downloading ? 'downloading' : 'available',
      availableVersion: remoteVersion,
      remoteVersion,
      message: downloading
        ? `Update ${remoteVersion} is downloading…`
        : `Update ${remoteVersion} is available. If it doesn’t download, click Download installer.`,
      lastCheckedAt: Date.now()
    });
  }

  function applyUpToDate(remoteVersion) {
    const local = app.getVersion();
    emit({
      phase: 'none',
      availableVersion: null,
      remoteVersion: remoteVersion || local,
      message: `You’re on the latest version (${local}).`,
      lastCheckedAt: Date.now()
    });
  }

  return {
    getState: snapshot,
    async check() {
      const epoch = ++checkEpoch;
      try {
        emit({ phase: 'checking', message: 'Checking for updates…', lastCheckedAt: Date.now() });
        const local = app.getVersion();
        let result = null;
        try {
          result = await checkOnce();
        } catch (err) {
          // Fall through to direct feed fetch before surfacing the error.
          result = { error: err };
        }
        if (epoch !== checkEpoch) return { ok: true, state: snapshot() };

        const updaterRemote = result && result.updateInfo && result.updateInfo.version;
        let feedRemote = null;
        try {
          feedRemote = await fetchRemoteFeedVersion();
        } catch (_) {
          feedRemote = null;
        }
        if (epoch !== checkEpoch) return { ok: true, state: snapshot() };

        const remote = [feedRemote, updaterRemote]
          .filter(Boolean)
          .sort((a, b) => (semver.gt(a, b) ? -1 : semver.lt(a, b) ? 1 : 0))[0] || null;

        const updateAvailable = !!(
          remote &&
          semver.valid(remote) &&
          semver.valid(local) &&
          semver.gt(remote, local)
        );

        if (updateAvailable) {
          // electron-updater may have already started a download when isUpdateAvailable was true.
          const downloading = !!(result && result.isUpdateAvailable && result.downloadPromise);
          if (!downloading && result && result.isUpdateAvailable === false) {
            // Stale "not available" from updater — retry once with a fresh provider client.
            try {
              useGenericFeed();
              const retry = await autoUpdater.checkForUpdates();
              if (epoch !== checkEpoch) return { ok: true, state: snapshot() };
              if (retry && retry.isUpdateAvailable) {
                applyAvailable(remote, !!retry.downloadPromise);
                return { ok: true, state: snapshot() };
              }
            } catch (_) {
              /* manual download path below */
            }
          }
          applyAvailable(remote, downloading || state.phase === 'downloading' || state.phase === 'ready');
          if (state.phase === 'ready') {
            emit({
              phase: 'ready',
              availableVersion: remote,
              remoteVersion: remote,
              percent: 100,
              message: `Update ${remote} is ready — restart to install.`,
              lastCheckedAt: Date.now()
            });
          }
          return { ok: true, state: snapshot() };
        }

        if (result && result.error && !remote) {
          const raw = result.error.message || String(result.error);
          emit({ phase: 'error', message: raw, lastCheckedAt: Date.now() });
          return { ok: false, error: raw, state: snapshot() };
        }

        applyUpToDate(remote || local);
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

module.exports = {
  createAutoUpdate,
  GENERIC_FEED_URL,
  FEED_YML_URL,
  parseFeedVersion,
  fetchRemoteFeedVersion
};
