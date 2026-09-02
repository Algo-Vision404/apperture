/* cue web mock — Electron IPC stand-in for browser runner */
(function () {
  const KEY = 'cue-web-settings';
  const defaults = {
    onboarded: true,
    provider: 'openai',
    sttProvider: 'auto',
    smart: false,
    apiKeys: { openai: '', anthropic: '', gemini: '', deepgram: '', custom: '', ollama: '', groq: '', minimax: '', azure: '' },
    models: {
      openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
      anthropic: { fast: 'claude-3-5-haiku-latest', smart: 'claude-3-5-sonnet-latest' },
      gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-flash' },
      custom: { fast: '', smart: '' },
      ollama: { fast: 'llama3.2', smart: 'llama3.3' },
      groq: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' },
      minimax: { fast: 'MiniMax-M2.7', smart: 'MiniMax-M3' },
      azure: { fast: 'gpt-4o-mini', smart: 'gpt-4o' }
    },
    resumeText: '',
    jobDescription: '',
    starStories: '',
    whyCompany: '',
    whyLeaving: '',
    workStyle: '',
    salaryTarget: '',
    questionsToAsk: '',
    aiRules: '',
    localWhisper: { modelId: 'base.en', language: 'auto', threads: 0 },
    baseUrl: '',
    azureEndpoint: '',
    minimaxRegion: 'global_en'
  };

  function load() {
    try { return Object.assign({}, defaults, JSON.parse(localStorage.getItem(KEY) || '{}')); }
    catch (e) { return Object.assign({}, defaults); }
  }
  function save(s) { localStorage.setItem(KEY, JSON.stringify(s)); return s; }

  let settings = load();
  let capturing = false;
  const listeners = {};
  function emit(ch, data) {
    (listeners[ch] || []).forEach(function (cb) { try { cb(data); } catch (e) {} });
  }

  async function demoAsk(payload) {
    const mode = (payload && payload.mode) || 'ask';
    const q = (payload && payload.text) || '';
    emit('llm:start', { mode: mode, small: mode === 'followup' || mode === 'recap' });
    const replies = {
      say: 'I’d start with the concrete outcome, then the constraint we hit, then the two decisions that unlocked it. Keep it under 45 seconds and land on a metric.',
      assist: 'Lead with the result, then one specific action you owned. Skip the preamble — interviewers already have your resume open.',
      followup: '• What does success look like in the first 90 days?\n• Where does this team feel the most leverage right now?\n• How do you decide what not to build?',
      recap: 'You covered ownership, tradeoffs, and impact. Still open: team process and how decisions get made under ambiguity.',
      ask: q
        ? ('Here’s a tight take on that: ' + q.replace(/\?$/, '') + ' — answer in first person, one example, one metric.')
        : 'Ask anything about your screen or conversation.'
    };
    const text = replies[mode] || replies.ask;
    const parts = text.split(/(\s+)/);
    for (let i = 0; i < parts.length; i++) {
      emit('llm:token', { text: parts[i] });
      await new Promise(function (r) { setTimeout(r, 12); });
    }
    emit('llm:done', {});
  }

  const uaPlat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  const isWin = /win/i.test(uaPlat) || /Windows/i.test(navigator.userAgent || '');
  const isMacHost = /mac/i.test(uaPlat) && !isWin;
  const mockPlatform = isWin ? 'win32' : (isMacHost ? 'darwin' : 'linux');

  window.cue = {
    platform: mockPlatform,
    settingsGet: async function () { return settings; },
    settingsSet: async function (patch) {
      settings = Object.assign({}, settings, patch || {});
      return save(settings);
    },
    whisperModels: async function () {
      return {
        runtime: {
          available: false,
          version: '',
          target: 'web',
          message: 'Web runner — local Whisper needs the Electron app.'
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
      return { platform: mockPlatform, winBuild: isWin ? 22621 : 0 };
    },
    ask: function (payload) { demoAsk(payload); },
    captureToggle: async function () {
      capturing = !capturing;
      emit('capture:state', { active: capturing, streaming: capturing });
      emit('stt:status', { status: capturing ? 'connected' : 'disconnected', label: capturing ? 'live' : 'off' });
      return capturing;
    },
    captureState: async function () { return { active: capturing, streaming: capturing }; },
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
        app.dataset.dragReady = '1';
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
    clearTranscript: async function () { emit('transcript', { turns: [] }); return true; },
    openPane: function (url) { try { window.open(url, '_blank'); } catch (e) {} },
    appLinkState: async function () { return { callers: [] }; },
    appLinkRevoke: async function () { return true; },
    appLinkConsentRespond: function () {},
    pickProfileDocument: async function () { return { ok: false, error: 'File pick needs Electron' }; },
    quit: function () {
      document.body.innerHTML = '<div style="font:600 18px Outfit,sans-serif;padding:40px;color:#F0D78A;background:#0c0e12;min-height:100vh">cue web session ended. Refresh to reopen.</div>';
    },
    permissionsCheck: async function () { return { mic: 'granted', screen: 'granted' }; },
    permissionsRequest: async function () { return true; },
    permissionsContinue: function () {},
    log: function (msg) { console.log('[cue]', msg); },
    on: function (channel, cb) {
      (listeners[channel] = listeners[channel] || []).push(cb);
    }
  };
})();
