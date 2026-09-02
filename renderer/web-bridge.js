/* apperture web bridge — real backend client (no mock LLM replies).
   Talks to scripts/web-runner.js: live settings + streamed OpenRouter/LLM asks.
   Mic captions: browser Web Speech API (You) — do NOT also open getUserMedia for PCM,
   or Chromium steals the mic and SpeechRecognition never hears anything.
   Meeting/system audio: getDisplayMedia loopback → /api/stt (Them).
   Fallback: if SpeechRecognition is missing, mic PCM → /api/stt (needs Whisper-capable key). */
(function () {
  const listeners = {};
  let capturing = false;
  let recognition = null;
  let speechActive = false;
  let transcriptTurns = [];
  let busyAsk = false;
  let sysChunks = [];
  let sysBytes = 0;
  let sysFlushTimer = null;
  let sysBusy = false;
  let sysWarnedNoKey = false;
  let micChunks = [];
  let micBytes = 0;
  let micBusy = false;
  let micWarnedNoKey = false;
  const SYS_FLUSH_MS = 2800;
  const SYS_MIN_BYTES = 16000 * 2 * 1.4; // ~1.4s @ 16 kHz mono int16
  const SYS_MAX_BYTES = 16000 * 2 * 10;
  const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
  const usesBrowserSpeech = typeof SpeechRecognitionAPI === 'function';

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
    emit('transcript', { turns: transcriptTurns.slice(), channel: channel, text: clean });
    emit('stt:final', { channel: channel, text: clean });
    syncTranscript({ channel: channel, text: clean });
  }

  function abToBase64(ab) {
    const bytes = new Uint8Array(ab);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function concatChunks(chunks) {
    let total = 0;
    for (let i = 0; i < chunks.length; i++) total += chunks[i].byteLength;
    const out = new Uint8Array(total);
    let off = 0;
    for (let i = 0; i < chunks.length; i++) {
      out.set(new Uint8Array(chunks[i]), off);
      off += chunks[i].byteLength;
    }
    return out.buffer;
  }

  async function flushPcmChannel(channel, getChunks, setChunks, getBytes, setBytes, busyFlag, setBusy, warnedFlag, setWarned) {
    if (busyFlag || !getChunks().length) return;
    if (getBytes() < SYS_MIN_BYTES) return;
    const chunks = getChunks();
    setChunks([]);
    setBytes(0);
    setBusy(true);
    emit('stt:status', { channel: channel, status: 'transcribing', provider: 'cloud' });
    try {
      const pcm = concatChunks(chunks);
      const result = await api('/api/stt', {
        method: 'POST',
        body: JSON.stringify({ channel: channel, pcmBase64: abToBase64(pcm) })
      });
      if (result && result.available === false) {
        if (!warnedFlag) {
          setWarned(true);
          emit('status', {
            message: result.error || (
              channel === 'them'
                ? 'Add OpenAI, Groq, or Gemini in Settings to transcribe meeting audio (Them).'
                : 'Browser speech is unavailable here. Add OpenAI, Groq, or Gemini in Settings → Audio to transcribe the mic.'
            )
          });
        }
        emit('stt:status', { channel: channel, status: 'error' });
        return;
      }
      if (result && result.error) {
        emit('status', {
          message: (channel === 'them' ? 'Meeting audio STT: ' : 'Mic STT: ') + result.error
        });
        emit('stt:status', { channel: channel, status: 'error' });
        return;
      }
      if (result && result.text) {
        pushFinal(channel, result.text);
        emit('stt:status', { channel: channel, status: 'streaming', provider: result.provider || 'cloud' });
      } else {
        emit('stt:status', { channel: channel, status: 'connected' });
      }
    } catch (e) {
      emit('status', {
        message: (channel === 'them' ? 'Meeting audio' : 'Mic') +
          ' transcription failed: ' + (e && e.message ? e.message : String(e))
      });
      emit('stt:status', { channel: channel, status: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function flushSystemPcm() {
    await flushPcmChannel(
      'them',
      function () { return sysChunks; },
      function (v) { sysChunks = v; },
      function () { return sysBytes; },
      function (v) { sysBytes = v; },
      sysBusy,
      function (v) { sysBusy = v; },
      sysWarnedNoKey,
      function (v) { sysWarnedNoKey = v; }
    );
  }

  async function flushMicPcm() {
    await flushPcmChannel(
      'you',
      function () { return micChunks; },
      function (v) { micChunks = v; },
      function () { return micBytes; },
      function (v) { micBytes = v; },
      micBusy,
      function (v) { micBusy = v; },
      micWarnedNoKey,
      function (v) { micWarnedNoKey = v; }
    );
  }

  function resetSystemPcm() {
    sysChunks = [];
    sysBytes = 0;
    if (sysFlushTimer) {
      clearInterval(sysFlushTimer);
      sysFlushTimer = null;
    }
    sysBusy = false;
  }

  function resetMicPcm() {
    micChunks = [];
    micBytes = 0;
    micBusy = false;
  }

  function ensureFlushTimer() {
    if (!sysFlushTimer) {
      sysFlushTimer = setInterval(function () {
        flushSystemPcm();
        if (!usesBrowserSpeech || !speechActive) flushMicPcm();
      }, SYS_FLUSH_MS);
    }
  }

  function startSpeechRecognition() {
    if (!usesBrowserSpeech) {
      emit('status', {
        message: 'This browser has no Speech Recognition API for the mic. Meeting audio can still use cloud STT if you share system audio and add an OpenAI/Groq/Gemini key. Mic captions need Chrome/Edge, or a Whisper-capable key with renderer mic capture.'
      });
      emit('stt:status', { channel: 'you', status: 'connected' });
      return;
    }
    if (recognition) {
      try { recognition.stop(); } catch (_) {}
      recognition = null;
    }
    speechActive = false;
    const rec = new SpeechRecognitionAPI();
    recognition = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';
    rec.maxAlternatives = 1;
    rec.onstart = function () {
      speechActive = true;
      emit('stt:status', { channel: 'you', status: 'connected' });
      emit('status', { message: 'Mic captions live — speak and you’ll see text in the ask box.' });
    };
    rec.onerror = function (ev) {
      const err = (ev && ev.error) || 'speech error';
      if (err === 'not-allowed') {
        speechActive = false;
        emit('status', { message: 'Microphone permission denied — allow mic access to listen.' });
        emit('stt:status', { channel: 'you', status: 'error' });
      } else if (err === 'audio-capture') {
        speechActive = false;
        emit('status', {
          message: 'Mic captions could not hear the microphone (audio-capture). Close other apps using the mic and try again.'
        });
        emit('stt:status', { channel: 'you', status: 'error' });
      } else if (err === 'network' || err === 'service-not-allowed') {
        speechActive = false;
        emit('status', {
          message: 'Browser speech service unavailable on this origin. Use Chrome/Edge on localhost/HTTPS, or add OpenAI/Groq/Gemini for cloud mic STT.'
        });
        emit('stt:status', { channel: 'you', status: 'error' });
      } else if (err !== 'aborted' && err !== 'no-speech') {
        emit('status', { message: 'Speech recognition: ' + err });
      }
    };
    rec.onend = function () {
      speechActive = false;
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
    speechActive = false;
    if (!recognition) return;
    const rec = recognition;
    recognition = null;
    try { rec.onend = null; rec.stop(); } catch (_) {}
    emit('stt:status', { channel: 'you', status: 'disconnected' });
  }

  function beginListening() {
    if (usesBrowserSpeech) startSpeechRecognition();
    ensureFlushTimer();
  }

  function endListening() {
    stopSpeechRecognition();
    return Promise.all([flushSystemPcm(), flushMicPcm()]).then(function () {
      resetSystemPcm();
      resetMicPcm();
    });
  }

  async function streamAsk(payload) {
    if (busyAsk) return;
    busyAsk = true;
    try {
      // Don't block the ask on transcript sync — the request body already includes turns.
      void syncTranscript({ turns: transcriptTurns });
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: payload && payload.mode,
          text: payload && payload.text,
          transcript: transcriptTurns
        })
      });
      if (!res.ok) {
        let msg = res.statusText;
        try {
          const j = await res.json();
          if (j && j.error) msg = j.error;
        } catch (_) {}
        emit('llm:error', { message: msg || ('HTTP ' + res.status) });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (let i = 0; i < parts.length; i++) {
          const line = parts[i].trim();
          if (!line.startsWith('data:')) continue;
          let evt;
          try { evt = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
          if (evt.type === 'start') emit('llm:start', evt);
          else if (evt.type === 'token') emit('llm:token', { text: evt.text || '' });
          else if (evt.type === 'done') emit('llm:done', {});
          else if (evt.type === 'error') emit('llm:error', { message: evt.message || 'error' });
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
    isWeb: true,
    // When true, renderer must NOT open getUserMedia for mic PCM — it starves SpeechRecognition.
    usesBrowserSpeech: usesBrowserSpeech,
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
          message: 'Local Whisper needs the Electron app. Browser listening uses live Speech Recognition for the mic, and cloud STT for meeting audio.'
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
      emit('capture:state', {
        active: capturing,
        streaming: capturing,
        mode: usesBrowserSpeech ? 'browser-speech' : 'cloud-mic'
      });
      if (capturing) {
        beginListening();
        api('/api/stt/status').then(function (info) {
          if (usesBrowserSpeech) {
            emit('status', {
              message: info && info.available
                ? 'Listening: mic captions (You) via browser speech. Share a tab/window with audio for Them (' + (info.providers || []).join('/') + ').'
                : 'Mic captions on (browser speech). For meeting audio (Them), share a tab with audio and add OpenAI/Groq/Gemini in Settings → Audio.'
            });
          } else if (!info || !info.available) {
            emit('status', {
              message: 'This browser cannot do live mic captions. Add OpenAI, Groq, or Gemini in Settings → Audio for cloud mic STT, and share system audio for Them.'
            });
          } else {
            emit('status', {
              message: 'Listening with cloud STT (' + (info.providers || []).join('/') + ').'
            });
          }
        }).catch(function () {});
      } else {
        await endListening();
      }
      return capturing;
    },
    captureState: async function () {
      const st = await api('/api/capture/state');
      capturing = !!st.active;
      // Page reload can leave the server "listening" while SpeechRecognition is dead — resume.
      if (capturing) beginListening();
      return { active: capturing, streaming: capturing };
    },
    micPcm: function (arrayBuffer) {
      // Only used when browser SpeechRecognition is unavailable (renderer opens getUserMedia).
      if (usesBrowserSpeech || !capturing || !arrayBuffer) return;
      const copy = arrayBuffer.slice ? arrayBuffer.slice(0) : arrayBuffer;
      micChunks.push(copy);
      micBytes += copy.byteLength || 0;
      ensureFlushTimer();
      if (micBytes >= SYS_MAX_BYTES) flushMicPcm();
    },
    systemPcm: function (arrayBuffer) {
      if (!capturing || !arrayBuffer) return;
      const copy = arrayBuffer.slice ? arrayBuffer.slice(0) : arrayBuffer;
      sysChunks.push(copy);
      sysBytes += copy.byteLength || 0;
      ensureFlushTimer();
      if (sysBytes >= SYS_MAX_BYTES) flushSystemPcm();
    },
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
    pickProfileDocument: async function () {
      return new Promise(function (resolve) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.addEventListener('change', async function () {
          const file = input.files && input.files[0];
          input.remove();
          if (!file) return resolve({ canceled: true });
          try {
            const buf = await file.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let binary = '';
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk) {
              binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
            }
            const base64 = btoa(binary);
            const parsed = await api('/api/parse-document', {
              method: 'POST',
              body: JSON.stringify({ fileName: file.name, base64: base64 })
            });
            resolve({ ok: true, text: parsed.text || '', fileName: parsed.fileName || file.name });
          } catch (e) {
            resolve({ error: e && e.message ? e.message : String(e) });
          }
        });
        input.addEventListener('cancel', function () {
          input.remove();
          resolve({ canceled: true });
        });
        input.click();
      });
    },
    quit: function () {
      stopSpeechRecognition();
      resetSystemPcm();
      resetMicPcm();
      document.body.innerHTML = '<div style="font:600 18px Outfit,sans-serif;padding:40px;color:#F0D78A;background:#0c0e12;min-height:100vh">apperture web session ended. Refresh to reopen.</div>';
    },
    permissionsCheck: async function () { return { mic: 'granted', screen: 'granted' }; },
    permissionsRequest: async function () { return true; },
    permissionsContinue: function () {},
    log: function (msg) { try { console.log('[apperture]', msg); } catch (_) {} },
    on: function (channel, cb) {
      if (!listeners[channel]) listeners[channel] = [];
      listeners[channel].push(cb);
    }
  };
})();
