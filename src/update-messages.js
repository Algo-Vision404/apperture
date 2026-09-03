// Map electron-updater errors to user-facing copy for Settings → Updates.

function formatUpdateUserMessage(phase, rawMessage) {
  const defaults = {
    idle: 'apperture checks GitHub for updates automatically.',
    checking: 'Checking for updates…',
    none: 'You’re on the latest version.',
    error: 'Couldn’t check for updates. Check your internet connection and try again.'
  };

  const msg = String(rawMessage || '').trim();
  if (!msg) return defaults[phase] || defaults.idle;

  if (/^(Checking for updates|You.re on the latest|Update .* is (downloading|ready)|Downloading update)/i.test(msg)) {
    return msg;
  }

  if (/sha512|checksum mismatch/i.test(msg)) {
    return 'The update download failed its integrity check. Try “Check for updates” again, or download the latest installer from GitHub.';
  }
  if (/404|not found|latest\.yml|ENOENT|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|ERR_UPDATER_LATEST_VERSION_NOT_FOUND/i.test(msg)) {
    return 'Couldn’t reach the update list. Use “Download installer” below, or try Check again.';
  }
  if (/ENOTFOUND|ERR_INTERNET|network|timed out|ETIMEDOUT|ECONNRESET|getaddrinfo/i.test(msg)) {
    return 'Couldn’t reach GitHub to check for updates. Check your internet connection and try again.';
  }
  if (/signed|signature|certificate|publisher/i.test(msg)) {
    return 'Auto-update isn’t signed on this build yet. Download the latest installer from GitHub if updating fails.';
  }
  if (/HttpError|ERR_UPDATER|Cannot download|Cannot find channel|differentially/i.test(msg)) {
    return 'Couldn’t check for updates right now. Try again in a few minutes.';
  }
  if (/[A-Za-z0-9+/]{40,}={0,2}/.test(msg) || msg.length > 140) {
    return defaults.error;
  }

  return msg;
}

module.exports = { formatUpdateUserMessage };
