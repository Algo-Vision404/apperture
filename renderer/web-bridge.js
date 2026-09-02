/* apperture web bridge — real backend client (no mock LLM replies).
   Talks to scripts/web-runner.js: live settings + streamed OpenRouter/LLM asks.
   Listening uses the browser Web Speech API for real-time mic transcription. */
(function () {
  const listeners = {};
  let capturing = false;
  let recognition = null;
  let transcriptTurns = [];
  let busyAsk = false;

  function emit(ch, data) {
    (listeners[ch] || []).forEach(function (cb) {
      try { cb(data); } catch (e) { console.error('[apperture]', e); }
    });
  }

  async function api(path, opts) {
    const res = await fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json' }
    }, opts || {}));
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const j = await res.json();
        if (j && j.error) msg = j.error;
      } catch (_) {}
      throw new Error(msg || ('HTTP ' + res.status));
    }
    const type = res.headers.get('content-type') || '';
    if (type.includes('application/json')) return res.json();
    return res;
  }

  function syncTranscript(extra) {
    const body = extra || { turns: transcriptTurns };
    return api('/api/transcript', { method: 'POST', body: JSON.stringify(body) }).catch(function (e) {
      console.warn('[apperture] transcript sync failed', e.message);
    });
  }

  function pushFinal(channel, text) {
    const clean = String(text || '').trim();
    if (!clean) return;
    transcriptTurns.push({ channel: channel, text: clean });
    if (transcriptTurns.length > 80) transcriptTurns = transcriptTurns.slice(-80);
    emit('transcript', { turns: transcriptTurns.slice() });
    emit('stt:final', { channel: channel, text: clean });
    syncTranscript({ channel: channel, text: clean });
  }

  function startSpeechRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      emit('status', {
        message: 'This browser has no Speech Recognition API. Listening still captures mic PCM, but live captions need Chrome/Edge — or run Electron for full STT.'
      });
      emit('stt:status', { status: 'connected' });
      return;
    }
    if (recognition) {
      try { recognition.stop(); } catch (_) {}
      recognition = null;
    }
    const rec = new SR();
    recognition = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';
    rec.onstart = function () {
      emit('stt:status', { status: 'connected' });
    };
    rec.onerror = function (ev) {
      const err = (ev && ev.error) || 'speech error';
      if (err === 'not-allowed') {
        emit('status', { message: 'Microphone permission denied — allow mic access to listen.' });
        emit('stt:status', { status: 'error' });
      } else if (err !== 'aborted' && err !== 'no-speech') {
        emit('status', { message: 'Speech recognition: ' + err });
      }
    };
    rec.onend = function () {
      if (capturing && recognition === rec) {
        try { rec.start(); } catch (_) {}
      }
    };
    rec.onresult = function (event) {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0] && result[0].transcript ? result[0].transcript : '';
        if (!text) continue;
        if (result.isFinal) {
          pushFinal('you', text);
        } else {
          interim += text;
        }
      }
      if (interim) emit('stt:interim', { channel: 'you', text: interim });
    };
    try {
      rec.start();
    } catch (e) {
      emit('status', { message: 'Could not start speech recognition: ' + e.message });
    }
  }

  function stopSpeechRecognition() {
    if (!recognition) return;
    const rec = recognition;
    recognition = null;
    try { rec.onend = null; rec.stop(); } catch (_) {}
    emit('stt:status', { status: 'disconnected' });
  }

  async function streamAsk(payload) {
    if (busyAsk) return;
    busyAsk = true;
    try {
      await syncTranscript({ turns: transcriptTurns });
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: (payload && payload.mode) || 'ask',
          text: (payload && payload.text) || '',
          transcript: transcriptTurns
        })
      });
      if (!res.ok) {
        let message = 'Ask failed (' + res.status + ')';
        try {
          const j = await res.json();
          if (j && j.error) message = j.error;
        } catch (_) {}
        emit('llm:error', { message: message });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (let i = 0; i < parts.length; i++) {
          const block = parts[i].trim();
          if (!block.startsWith('data:')) continue;
          const json = block.replace(/^data:\s*/, '');
          let msg;
          try { msg = JSON.parse(json); } catch (_) { continue; }
          if (msg.type === 'start') {
            emit('llm:start', {
              userBubble: msg.userBubble,
              small: !!msg.small,
              category: msg.category || null
            });
          } else if (msg.type === 'token') {
            emit('llm:token', { text: msg.text || '' });
          } else if (msg.type === 'done') {
            emit('llm:done', {});
          } else if (msg.type === 'error') {
            emit('llm:error', { message: msg.message || 'LLM error' });
          }
        }
      }
    } catch (e) {
      emit('llm:error', { message: e && e.message ? e.message : String(e) });
    } finally {
      busyAsk = false;
    }
  }

  const uaPlat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  const isWin = /win/i.test(uaPlat) || /Windows/i.test(navigator.userAgent || '');
  const isMacHost = /mac/i.test(uaPlat) && !isWin;
  const platform = isWin ? 'win32' : (isMacHost ? 'darwin' : 'linux');

  window.apperture = {
    platform: platform,
    settingsGet: async function () { return api('/api/settings'); },
    settingsSet: async function (patch) {
      return api('/api/settings', { method: 'POST', body: JSON.stringify(patch || {}) });
    },
    whisperModels: async function () {
      return {
        runtime: {
          available: false,
          version: '',
          target: 'web',
          message: 'Local Whisper needs the Electron app. Browser listening uses live Speech Recognition + your cloud LLM.'
        },
        models: [],
        selectedModelId: 'base.en',
        language: 'auto',
        threads: 0
      };
    },
    whisperModelDownload: async function () { return { ok: false, error: 'Use Electron for local models' }; },
    whisperModelCancel: async function () { return { ok: true }; },
    whisperModelDelete: async function () { return { ok: true }; },
    whisperModelImport: async function () { return { ok: false, error: 'Use Electron for imports' }; },
    platformInfo: async function () {
      return { platform: platform, winBuild: isWin ? 22621 : 0 };
    },
    ask: function (payload) { streamAsk(payload); },
    captureToggle: async function () {
      const st = await api('/api/capture/toggle', { method: 'POST', body: '{}' });
      capturing = !!st.active;
      emit('capture:state', { active: capturing, streaming: capturing });
      if (capturing) startSpeechRecognition();
      else stopSpeechRecognition();
      return capturing;
    },
    captureState: async function () {
      const st = await api('/api/capture/state');
      capturing = !!st.active;
      return { active: capturing, streaming: capturing };
    },
    micPcm: function () {},
    systemPcm: function () {},
    setIgnoreMouse: function () {},
    dragStart: function (screenX, screenY) {
      const app = document.getElementById('app');
      if (!app) return;
      if (!app.style.position || app.style.position === 'static') {
        const rect = app.getBoundingClientRect();
        app.style.position = 'fixed';
        app.style.left = rect.left + 'px';
        app.style.top = rect.top + 'px';
        app.style.right = 'auto';
        app.style.margin = '0';
        app.style.width = rect.width + 'px';
      }
      const left = parseFloat(app.style.left) || 0;
      const top = parseFloat(app.style.top) || 0;
      app.dataset.dragOx = String(screenX - left);
      app.dataset.dragOy = String(screenY - top);
    },
    dragMove: function (screenX, screenY) {
      const app = document.getElementById('app');
      if (!app || !app.dataset.dragOx) return;
      app.style.left = (screenX - Number(app.dataset.dragOx)) + 'px';
      app.style.top = (screenY - Number(app.dataset.dragOy)) + 'px';
    },
    dragEnd: function () {
      const app = document.getElementById('app');
      if (!app) return;
      delete app.dataset.dragOx;
      delete app.dataset.dragOy;
    },
    clearTranscript: async function () {
      transcriptTurns = [];
      await api('/api/transcript', { method: 'DELETE' }).catch(function () {});
      emit('transcript', { turns: [] });
      return true;
    },
    openPane: function (url) { try { window.open(url, '_blank'); } catch (e) {} },
    appLinkState: async function () { return { callers: [] }; },
    appLinkRevoke: async function () { return true; },
    appLinkConsentRespond: function () {},
    pickProfileDocument: async function () { return { ok: false, error: 'File pick needs Electron' }; },
    quit: function () {
      stopSpeechRecognition();
      document.body.innerHTML = '<div style="font:600 18px Outfit,sans-serif;padding:40px;color:#F0D78A;background:#0c0e12;min-height:100vh">apperture web session ended. Refresh to reopen.</div>';
    },
    permissionsCheck: async function () { return { mic: 'granted', screen: 'granted' }; },
    permissionsRequest: async function () { return true; },
    permissionsContinue: function () {},
    log: function (msg) { console.log('[apperture]', msg); },
    on: function (channel, cb) {
      (listeners[channel] = listeners[channel] || []).push(cb);
    }
  };

  // Surface readiness early for the empty state.
  api('/api/health').then(function (h) {
    if (h && !h.ready) {
      emit('status', {
        message: h.configurationError
          || 'Add an OpenRouter key in Settings, or set OPENROUTER_API_KEY, then try Assist.'
      });
    }
  }).catch(function () {});
})();
