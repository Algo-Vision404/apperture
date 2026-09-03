/* apperture web bridge — real backend client (no mock LLM replies).
   Talks to scripts/web-runner.js: live settings + streamed OpenRouter/LLM asks.

   Mic captions (You):
   - Prefer browser SpeechRecognition when available (free). MUST start on the
     click gesture — awaiting fetch first often means Chromium never attaches the mic.
   - Prefer cloud mic PCM when OpenAI/Groq/Gemini Whisper keys exist.
   - Do NOT hold getUserMedia open while SpeechRecognition is running.

   Meeting audio (Them): getDisplayMedia loopback → /api/stt. */
(function () {
  const listeners = {};
  let capturing = false;
  let recognition = null;
  let speechActive = false;
  let heardSpeech = false;
  let speechWatchdog = null;
  let speechRestartTimer = null;
  let speechRestartAttempts = 0;
  let speechFatal = false;
  let micMode = 'browser-speech'; // browser-speech | cloud-mic | none | off
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
  const SYS_FLUSH_MS = 2200;
  const SYS_MIN_BYTES = 16000 * 2 * 1.0; // ~1.0s @ 16 kHz mono int16
  const MIC_MIN_BYTES = 16000 * 2 * 1.8; // ~1.8s @ 16 kHz — longer chunks help Whisper accuracy
  const SYS_MAX_BYTES = 16000 * 2 * 10;
  const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
  const hasSpeechApi = typeof SpeechRecognitionAPI === 'function';

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

  async function flushPcmChannel(channel, getChunks, setChunks, getBytes, setBytes, busyRef, setBusy, warnedRef, setWarned) {
    if (busyRef() || !getChunks().length) return;
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
        if (!warnedRef()) {
          setWarned(true);
          emit('status', {
            message: result.error || (
              channel === 'them'
                ? 'Add OpenAI, Groq, or Gemini in Settings to transcribe meeting audio (Them).'
                : 'Add OpenAI, Groq, or Gemini in Settings → Audio to transcribe the mic.'
            )
          });
        }
        emit('stt:status', { channel: channel, status: 'error' });
        return;
      }
      if (result && result.error) {
        const errText = String(result.error || '');
        const needsCredits = /credit|402|balance|requires at least \$/i.test(errText);
        emit('status', {
          message: (channel === 'them' ? 'Meeting audio STT: ' : 'Mic STT: ') + errText +
            (needsCredits
              ? ' OpenRouter audio needs ~$0.50 in credits for Nemotron ASR — or add a free Groq/OpenAI key in Settings → Keys.'
              : '')
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
      function () { return sysBusy; },
      function (v) { sysBusy = v; },
      function () { return sysWarnedNoKey; },
      function (v) { sysWarnedNoKey = v; }
    );
  }

  async function flushMicPcm() {
    if (micBusy || !micChunks.length) return;
    if (micBytes < MIC_MIN_BYTES) return;
    await flushPcmChannel(
      'you',
      function () { return micChunks; },
      function (v) { micChunks = v; },
      function () { return micBytes; },
      function (v) { micBytes = v; },
      function () { return micBusy; },
      function (v) { micBusy = v; },
      function () { return micWarnedNoKey; },
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
        if (micMode === 'cloud-mic') flushMicPcm();
      }, SYS_FLUSH_MS);
    }
  }

  function syncMicFlags() {
    window.apperture.micMode = micMode;
    window.apperture.usesBrowserSpeech = micMode === 'browser-speech';
  }

  function armSpeechWatchdog() {
    if (speechWatchdog) clearTimeout(speechWatchdog);
    speechWatchdog = setTimeout(function () {
      if (!capturing || micMode !== 'browser-speech' || heardSpeech) return;
      // Browser speech often starts but never attaches real mic audio — fall over to PCM/cloud.
      emit('status', {
        message: 'Browser speech heard no words. Switching to mic capture + cloud STT…'
      });
      void fallbackToCloudMic();
    }, 6000);
  }

  async function fallbackToCloudMic() {
    if (!capturing || heardSpeech || micMode === 'cloud-mic') return;
    let info = { available: false, providers: [] };
    try { info = await api('/api/stt/status'); } catch (_) {}
    if (!info || !info.available) {
      emit('status', {
        message: 'Mic is on, but browser speech isn’t hearing you. Add a free Groq or OpenAI key in Settings → Audio (Whisper), then click listen again.'
      });
      return;
    }
    stopSpeechRecognition();
    micMode = 'cloud-mic';
    syncMicFlags();
    emit('capture:state', { active: true, streaming: true, mode: 'cloud-mic' });
    emit('status', {
      message: 'Using cloud mic STT (' + ((info.providers || []).join('/') || 'cloud') + '). Keep speaking.'
    });
    ensureFlushTimer();
  }

  // MUST be called synchronously from the listen click (user gesture).
  function startSpeechRecognition() {
    if (speechFatal) return false;
    if (!hasSpeechApi) {
      emit('status', {
        message: 'This browser has no Speech Recognition API. Add OpenAI, Groq, or Gemini in Settings → Audio for cloud mic STT.'
      });
      emit('stt:status', { channel: 'you', status: 'error' });
      return false;
    }
    if (window.isSecureContext === false) {
      emit('status', {
        message: 'Mic captions need a secure origin. Open http://127.0.0.1:43142/ in Chrome or Edge.'
      });
      emit('stt:status', { channel: 'you', status: 'error' });
      return false;
    }
    if (recognition) {
      try { recognition.onend = null; recognition.stop(); } catch (_) {}
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
      speechRestartAttempts = 0;
      emit('stt:status', { channel: 'you', status: 'connected' });
      armSpeechWatchdog();
    };
    rec.onerror = function (ev) {
      const err = (ev && ev.error) || 'speech error';
      if (err === 'not-allowed') {
        speechFatal = true;
        speechActive = false;
        emit('status', { message: 'Microphone permission denied — allow mic access, then click listen again.' });
        emit('stt:status', { channel: 'you', status: 'error' });
      } else if (err === 'audio-capture') {
        speechFatal = true;
        speechActive = false;
        emit('status', { message: 'Could not capture the microphone. Close other apps using the mic and try again.' });
        emit('stt:status', { channel: 'you', status: 'error' });
      } else if (err === 'network' || err === 'service-not-allowed') {
        speechFatal = true;
        speechActive = false;
        emit('status', {
          message: 'Browser speech is blocked here. Ask still works. Use Chrome/Edge on localhost, or add OpenAI/Groq/Gemini for cloud mic STT.'
        });
        emit('stt:status', { channel: 'you', status: 'error' });
      } else if (err !== 'aborted' && err !== 'no-speech') {
        emit('status', { message: 'Speech recognition: ' + err });
      }
    };
    rec.onend = function () {
      speechActive = false;
      // Debounced restart — immediate restart loops freeze Chromium.
      if (capturing && recognition === rec && micMode === 'browser-speech' && !speechFatal) {
        recognition = null;
        scheduleSpeechRestart();
      }
    };
    rec.onresult = function (event) {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0] && result[0].transcript ? result[0].transcript : '';
        if (!text) continue;
        heardSpeech = true;
        speechRestartAttempts = 0;
        if (result.isFinal) pushFinal('you', text);
        else interim += text;
      }
      if (interim) emit('stt:interim', { channel: 'you', text: interim });
    };
    try {
      rec.start();
      return true;
    } catch (e) {
      emit('status', { message: 'Could not start speech recognition: ' + e.message });
      return false;
    }
  }

  function scheduleSpeechRestart() {
    if (!capturing || micMode !== 'browser-speech' || speechFatal) return;
    if (speechRestartTimer) return;
    if (speechRestartAttempts >= 6) {
      speechFatal = true;
      emit('status', {
        message: 'Mic captions kept stopping. Ask still works — add OpenAI/Groq/Gemini in Settings → Audio, or click listen again later.'
      });
      return;
    }
    speechRestartAttempts += 1;
    speechRestartTimer = setTimeout(function () {
      speechRestartTimer = null;
      if (!capturing || micMode !== 'browser-speech' || speechFatal) return;
      startSpeechRecognition();
    }, 1200);
  }

  function stopSpeechRecognition() {
    speechActive = false;
    if (speechWatchdog) {
      clearTimeout(speechWatchdog);
      speechWatchdog = null;
    }
    if (speechRestartTimer) {
      clearTimeout(speechRestartTimer);
      speechRestartTimer = null;
    }
    if (!recognition) return;
    const rec = recognition;
    recognition = null;
    try { rec.onend = null; rec.onerror = null; rec.onresult = null; rec.stop(); } catch (_) {}
    emit('stt:status', { channel: 'you', status: 'disconnected' });
  }

  async function resolveMicMode() {
    let info = { available: false, providers: [] };
    try { info = await api('/api/stt/status'); } catch (_) {}
    const providers = (info && info.providers) || [];
    const hasDirectWhisper = providers.some(function (p) {
      return p === 'openai' || p === 'groq' || p === 'gemini';
    });
    const hasOpenRouter = providers.indexOf('openrouter') !== -1;
    // Prefer direct Whisper keys. Otherwise use OpenRouter Nemotron ASR when the
    // chat key is present (needs ~$0.50 OpenRouter audio credits). Browser speech
    // is last because it often starts without attaching mic audio.
    if (hasDirectWhisper) return { mode: 'cloud-mic', info: info };
    if (hasOpenRouter) return { mode: 'cloud-mic', info: info };
    if (hasSpeechApi && window.isSecureContext !== false) return { mode: 'browser-speech', info: info };
    if (info && info.available) return { mode: 'cloud-mic', info: info };
    return { mode: 'none', info: info };
  }

  function beginListening(mode) {
    micMode = mode || micMode || 'browser-speech';
    syncMicFlags();
    if (micMode === 'browser-speech') {
      if (!recognition) startSpeechRecognition();
    } else {
      stopSpeechRecognition();
    }
    ensureFlushTimer();
  }

  function endListening() {
    stopSpeechRecognition();
    speechFatal = false;
    speechRestartAttempts = 0;
    micMode = 'off';
    syncMicFlags();
    return Promise.all([flushSystemPcm(), flushMicPcm()]).then(function () {
      resetSystemPcm();
      resetMicPcm();
    });
  }

  async function streamAsk(payload) {
    if (busyAsk) return;
    busyAsk = true;
    try {
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
    micMode: micMode,
    // When true, renderer must NOT open getUserMedia for mic PCM.
    usesBrowserSpeech: hasSpeechApi,
    // Call after mic permission priming (getUserMedia then release) so SpeechRecognition
    // can actually attach to the microphone.
    startBrowserSpeechNow: function () {
      speechFatal = false;
      speechRestartAttempts = 0;
      heardSpeech = false;
      micMode = 'browser-speech';
      syncMicFlags();
      return startSpeechRecognition();
    },
    // Release a primed MediaStream before starting browser speech (must not hold the mic).
    releasePrimedMic: function (stream) {
      try {
        if (stream && stream.getTracks) stream.getTracks().forEach(function (t) { t.stop(); });
      } catch (_) {}
    },
    takePrimedMic: function () {
      const s = window.__apperturePrimedMic || null;
      window.__apperturePrimedMic = null;
      return s;
    },
    stashPrimedMic: function (stream) {
      if (window.__apperturePrimedMic && window.__apperturePrimedMic !== stream) {
        try { window.__apperturePrimedMic.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {}
      }
      window.__apperturePrimedMic = stream || null;
    },
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
      return {
        platform: platform,
        winBuild: isWin ? 22621 : 0,
        winSupportsContentProtection: false,
        isElectron: false,
        version: 'web',
        captureProtection: {
          level: 'unsupported',
          applied: false,
          platform: platform,
          message: 'Browser mode cannot hide from screen share. Use the Electron desktop app (npm start) for OS-level capture exclusion.',
          tips: [
            'Run apperture as Electron for WDA_EXCLUDEFROMCAPTURE / NSWindowSharingNone.',
            'Keep this browser tab off the monitor you share.',
            'Enable Stealth mode in Settings → Style to hide branding on screen.'
          ]
        }
      };
    },
    updateInfo: async function () {
      return { phase: 'idle', version: 'web', packaged: false, message: 'Auto-update is only available in the installed desktop app.' };
    },
    updateCheck: async function () { return { ok: false, reason: 'web' }; },
    updateInstall: async function () { return { ok: false, reason: 'web' }; },
    ask: function (payload) { streamAsk(payload); },
    captureToggle: async function (opts) {
      opts = opts || {};
      const speechAlreadyStarted = !!opts.speechAlreadyStarted;
      const deferSpeech = !!opts.deferSpeech;
      const resolved = await resolveMicMode();
      const st = await api('/api/capture/toggle', { method: 'POST', body: '{}' });
      capturing = !!st.active;
      micMode = capturing ? resolved.mode : 'off';
      syncMicFlags();
      emit('capture:state', {
        active: capturing,
        streaming: capturing,
        mode: micMode
      });
      if (capturing) {
        if (micMode === 'browser-speech') {
          // Renderer releases the primed getUserMedia stream first, then starts speech.
          if (!deferSpeech && (!speechAlreadyStarted || !recognition)) startSpeechRecognition();
          ensureFlushTimer();
        } else if (micMode === 'cloud-mic') {
          stopSpeechRecognition();
          ensureFlushTimer();
        } else {
          emit('status', {
            message: 'No mic transcription path available. Use Chrome/Edge on localhost, or add OpenAI/Groq/Gemini in Settings → Audio.'
          });
        }
        const info = resolved.info || {};
        if (micMode === 'browser-speech') {
          emit('status', {
            message: 'Mic captions on (browser speech). Speak into your mic — text appears in the ask box.'
          });
        } else if (micMode === 'cloud-mic') {
          emit('status', {
            message: 'Listening with cloud STT (' + ((info.providers || []).join('/') || 'cloud') +
              (info.providers && info.providers.indexOf('openrouter') !== -1
                ? ' · Nemotron ASR'
                : '') +
              '). Keep speaking.'
          });
        }
      } else {
        await endListening();
      }
      return capturing;
    },
    captureState: async function () {
      const st = await api('/api/capture/state');
      capturing = !!st.active;
      if (capturing) {
        const resolved = await resolveMicMode();
        beginListening(resolved.mode);
      }
      return { active: capturing, streaming: capturing, mode: micMode };
    },
    micPcm: function (arrayBuffer) {
      if (micMode !== 'cloud-mic' || !capturing || !arrayBuffer) return;
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
    // Web runner is a normal page — dragging the toolbar into position:fixed
    // pulls #app out of flow and makes the UI jump/unusable. No-op on web.
    dragStart: function () {},
    dragMove: function () {},
    dragEnd: function () {},
    ensureSettingsSpace: async function () { return { ok: true, resized: false }; },
    restoreAfterSettings: async function () { return { ok: true }; },
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
