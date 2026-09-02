/* apperture renderer — UI state, mic capture, IPC, streaming render. */
(function () {
  const { icon } = window.ICONS;
  const apperture = window.apperture; // exposed by preload
  const $ = (s) => document.querySelector(s);
  const isWindows = apperture.platform === 'win32';
  const isMac = apperture.platform === 'darwin';

  function isSwitchOn(el) {
    return !!(el && el.getAttribute('aria-checked') === 'true');
  }
  function setSwitchOn(el, on, disabled) {
    if (!el) return;
    el.setAttribute('aria-checked', on ? 'true' : 'false');
    if (disabled != null) {
      el.disabled = !!disabled;
      el.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    }
  }
  function markPressed(el, on) {
    if (!el) return;
    el.classList.toggle('on', !!on);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  function syncSegGroup(selector, dataKey, value) {
    document.querySelectorAll(selector).forEach((button) => {
      const on = button.dataset[dataKey] === value;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  // ---- paint icons -------------------------------------------------------
  function syncListenButton(active) {
    const btn = $('#stop-btn');
    if (!btn) return;
    btn.classList.toggle('active', !!active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    const label = active ? 'Stop listening' : 'Start listening';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = icon(active ? 'listen-active' : 'mic', { size: 15 });
  }
  $('#logo-btn').innerHTML = icon('logo', { size: 18 });
  $('.tb-hide .chev').innerHTML = icon('chevron-down', { size: 14, stroke: 2 });
  const guideBtn = document.getElementById('guide-btn');
  if (guideBtn) guideBtn.innerHTML = icon('book', { size: 15 });
  syncListenButton(false);
  $('#quit-btn').innerHTML = icon('x', { size: 15, stroke: 2 });
  $('#quit-btn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void apperture.quit();
  });
  document.querySelector('.act[data-mode="assist"] .ic').innerHTML = icon('sparkles', { size: 15 });
  document.querySelector('.act[data-mode="say"] .ic').innerHTML = icon('wand-sparkles', { size: 15 });
  document.querySelector('.act[data-mode="followup"] .ic').innerHTML = icon('message-circle', { size: 15 });
  document.querySelector('.act[data-mode="recap"] .ic').innerHTML = icon('refresh-cw', { size: 15 });
  $('#smart-toggle .ic').innerHTML = icon('zap', { size: 13 });
  const resumeToggleIc = document.querySelector('#resume-toggle .ic');
  if (resumeToggleIc) resumeToggleIc.innerHTML = icon('file-text', { size: 13 });
  $('#more-btn').innerHTML = icon('settings', { size: 15 });
  $('#send-btn').innerHTML = icon('send', { size: 14 });
  document.querySelectorAll('.s-tab-ic[data-icon]').forEach(function (el) {
    el.innerHTML = icon(el.dataset.icon, { size: 12 });
  });
  const clearIC = document.querySelector('#clear-transcript-btn .ic');
  if (clearIC) clearIC.innerHTML = icon('trash-2', { size: 13 });
  const closeSidebarIcon = document.getElementById('close-sidebar-btn');
  if (closeSidebarIcon) closeSidebarIcon.innerHTML = icon('x', { size: 14, stroke: 2 });

  // ---- state -------------------------------------------------------------
  let settings = null;
  let whisperOverview = null;
  let busy = false;
  let aiEl = null;       // current streaming <div class="ai-text">
  let caretEl = null;
  let thinkingEl = null;
  let responseCount = 0;
  const MAX_RESPONSES = 20;

  const messages = $('#messages');

  function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // minimal, safe markdown: fenced code, bullets, inline code, bold, paragraphs
  function renderMarkdown(text) {
    const lines = text.split('\n');
    let html = '', inCode = false, inList = false, buf = [];
    const flushP = () => { if (buf.length) { html += '<p>' + inline(buf.join(' ')) + '</p>'; buf = []; } };
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    for (const raw of lines) {
      const line = raw;
      if (/^```/.test(line.trim())) {
        if (!inCode) { flushP(); if (inList) { html += '</ul>'; inList = false; } html += '<pre><code>'; inCode = true; }
        else { html += '</code></pre>'; inCode = false; }
        continue;
      }
      if (inCode) { html += esc(line) + '\n'; continue; }
      if (/^\s*[-*]\s+/.test(line)) { flushP(); if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>'; continue; }
      if (line.trim() === '') { flushP(); if (inList) { html += '</ul>'; inList = false; } continue; }
      buf.push(line.trim());
    }
    flushP(); if (inList) html += '</ul>'; if (inCode) html += '</code></pre>';
    return html;
  }

  function clearMessages() {
    messages.innerHTML = '';
    aiEl = null;
    caretEl = null;
    responseCount = 0;
    showEmptyState();
  }

  function wireEmptyActions(root) {
    if (!root) return;
    root.querySelectorAll('[data-empty-action]').forEach(function (btn) {
      if (btn.dataset.wired === '1') return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', function () {
        const action = btn.getAttribute('data-empty-action');
        if (action === 'listen') $('#stop-btn').click();
        else if (action === 'assist') runMode('assist', '');
        else if (action === 'settings') openSettings();
      });
    });
  }

  function showEmptyState() {
    const existing = messages.querySelector('.messages-empty');
    if (existing && existing.querySelector('.me-quick')) {
      wireEmptyActions(existing);
      return;
    }
    if (existing) existing.remove();
    const empty = document.createElement('div');
    empty.className = 'messages-empty';
    empty.id = 'messages-empty';
    const assistHint = (isWindows || !isMac) ? 'Ctrl+↵' : '⌘↵';
    empty.innerHTML =
      '<div class="me-kicker">apperture</div>' +
      '<div class="me-title">Ready when you are</div>' +
      '<div class="me-body">Listen live, ask a question, or let Assist read the room.</div>' +
      '<div class="me-quick">' +
        '<button type="button" class="me-card" data-empty-action="listen">' +
          '<strong>Listen</strong><span>Mic + live captions</span>' +
        '</button>' +
        '<button type="button" class="me-card" data-empty-action="assist">' +
          '<strong>Assist</strong><span>' + esc(assistHint) + ' — scan screen</span>' +
        '</button>' +
        '<button type="button" class="me-card" data-empty-action="settings">' +
          '<strong>Settings</strong><span>Gear icon · keys &amp; stealth</span>' +
        '</button>' +
      '</div>';
    messages.appendChild(empty);
    wireEmptyActions(empty);
  }

  function hideEmptyState() {
    const empty = messages.querySelector('.messages-empty');
    if (empty) empty.remove();
  }

  function addUserBubble(text) {
    hideEmptyState();
    const b = document.createElement('div');
    b.className = 'user-bubble';
    b.textContent = text;
    messages.appendChild(b);
  }

  function clearThinking() {
    if (thinkingEl && thinkingEl.parentNode) thinkingEl.remove();
    thinkingEl = null;
  }

  function startAi(small) {
    hideEmptyState();
    clearThinking();
    thinkingEl = document.createElement('div');
    thinkingEl.className = 'ai-thinking';
    thinkingEl.textContent = 'Thinking';
    messages.appendChild(thinkingEl);
    aiEl = document.createElement('div');
    aiEl.className = 'ai-text' + (small ? ' small' : '');
    aiEl.dataset.raw = '';
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    aiEl.appendChild(caretEl);
    messages.appendChild(aiEl);
  }

  function appendToken(t) {
    if (!aiEl) startAi(false);
    clearThinking();
    aiEl.dataset.raw += t;
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = t;
    // Guard: caretEl must be a child of aiEl
    if (caretEl && caretEl.parentNode === aiEl) {
      aiEl.insertBefore(span, caretEl);
    } else {
      aiEl.appendChild(span);
    }
  }

  function finalizeAi() {
    clearThinking();
    if (!aiEl) return;
    const raw = aiEl.dataset.raw || '';
    const wrap = document.createElement('div');
    wrap.className = 'ai-block';
    const body = document.createElement('div');
    body.className = aiEl.className;
    body.innerHTML = renderMarkdown(raw);
    const actions = document.createElement('div');
    actions.className = 'ai-actions';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'ai-action-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.title = 'Copy response';
    copyBtn.addEventListener('click', async function () {
      try {
        await navigator.clipboard.writeText(raw);
        copyBtn.textContent = 'Copied';
        showToast('Copied to clipboard', 1600);
        setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1600);
      } catch (_) {
        showToast('Could not copy', 1800);
      }
    });
    actions.appendChild(copyBtn);
    wrap.appendChild(body);
    wrap.appendChild(actions);
    if (aiEl.parentNode) aiEl.parentNode.replaceChild(wrap, aiEl);
    else messages.appendChild(wrap);
    aiEl = null; caretEl = null;
    messages.scrollTop = messages.scrollHeight;
  }

  let busyFailsafe = null;
  function setBusy(v) {
    busy = v;
    $('#send-btn').classList.toggle('busy', v);
    const app = document.getElementById('app');
    if (app) app.classList.toggle('is-busy', v);
    clearTimeout(busyFailsafe);
    // Failsafe: main has a 25s stream watchdog that always sends llm:done/llm:error, but if a
    // terminal event is ever lost the whole UI stays frozen — self-clear after a generous window.
    if (v) busyFailsafe = setTimeout(() => {
      busy = false;
      $('#send-btn').classList.toggle('busy', false);
      const app = document.getElementById('app');
      if (app) app.classList.remove('is-busy');
    }, 40000);
  }

  // ---- transcript helpers ------------------------------------------------
  // NOTE: The old transcript-list element was renamed to ts-list.
  // These helpers are now deprecated but kept for compatibility.
  // The main sidebar uses appendTranscriptHistoryTurn() instead.
  let transcriptInterimEl = null;

  // FIX #1: Updated to use ts-list instead of non-existent transcript-list

  function clearTranscriptInterim() {
    if (transcriptInterimEl) {
      transcriptInterimEl.remove();
      transcriptInterimEl = null;
    }
  }

  // ---- toast helper ------------------------------------------------------
  // FIX #7: Toast queue system — ensures latest toast wins cleanly without stacking
  let toastTimer = null;
  let toastFadeTimer = null;
  function showToast(message, ms) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.getElementById('app').appendChild(el);
    }
    // Clear any pending timers to prevent overlap
    clearTimeout(toastTimer);
    clearTimeout(toastFadeTimer);
    // Immediately update content (no stacking)
    el.textContent = message;
    el.classList.add('show');
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
    }, ms);
  }

  // ---- actions -----------------------------------------------------------
  function runMode(mode, text) {
    if (busy) return;
    setBusy(true);
    apperture.ask({ mode, text: text || '' });
  }

  document.querySelectorAll('.act').forEach((btn) => {
    btn.addEventListener('click', () => runMode(btn.dataset.mode, ''));
  });

  const input = $('#input');
  const placeholder = $('#placeholder');
  const composer = $('#composer');

  // ========== SMART AUTO-FILL SYSTEM ==========
  // Track whether the current input text came from STT auto-fill.
  // sttSourceChannel: which speaker last filled the ask box ('them' | 'you' | null).
  let inputFromSTT = false;
  let sttSourceChannel = null;
  let sttFillTimer = null;
  let questionFinalizeTimer = null;
  let softClearTimer = null;
  let userSpeechStart = null;

  // Question history for undo (Ctrl+Z)
  const questionHistory = [];
  const MAX_QUESTION_HISTORY = 10;

  // ---- Question completeness detection ----
  function isLikelyCompleteQuestion(text) {
    const trimmed = (text || '').trim();
    
    // Must be substantial (not just filler words)
    if (trimmed.length < 12) return false;
    
    // High confidence: ends with question mark
    if (/\?$/.test(trimmed)) return true;
    
    // High confidence: behavioral interview patterns (these are complete even without ?)
    const behavioralPatterns = [
      /tell me about a time/i,
      /give me an example/i,
      /describe a (situation|time|project|challenge)/i,
      /walk me through/i,
      /can you (tell|describe|explain|share)/i,
      /what (was|were|is|are) your/i,
      /how (did|do|would) you/i,
      /why (did|do|are|should)/i,
      /what (did|do|would) you/i,
      /tell me about yourself/i,
      /tell me about your/i,
      /what.{1,30}(biggest|greatest|most|hardest|proudest)/i,
      /have you ever/i
    ];
    if (behavioralPatterns.some(p => p.test(trimmed))) return true;
    
    // Medium confidence: question starters with substantial content
    const questionStarters = /^(what|how|why|when|where|who|which|tell|describe|explain|can|could|would|should|have|did|do|is|are|was|were)/i;
    if (questionStarters.test(trimmed) && trimmed.length > 25) return true;
    
    // Medium confidence: ends with common question endings
    if (/(about that|for us|to us|with you|for you|about it|to share|you handle|you approach|your experience|your background)\s*$/i.test(trimmed)) return true;
    
    return false;
  }

  // ---- Get question confidence level ----
  function getQuestionConfidence(text) {
    const trimmed = (text || '').trim();
    if (trimmed.length < 8) return 'low';
    if (/\?$/.test(trimmed)) return 'high';
    if (isLikelyCompleteQuestion(trimmed)) return 'medium';
    if (trimmed.length > 20) return 'accumulating';
    return 'low';
  }

  // ---- Update visual state based on question readiness ----
  // FIX #8: Batch class updates to avoid flicker
  function updateQuestionReadyState() {
    const text = input.value;
    const confidence = getQuestionConfidence(text);
    
    // Batch the class changes to minimize repaints
    const shouldBeReady = confidence === 'high' || confidence === 'medium';
    const shouldBeAccumulating = confidence === 'accumulating';
    
    // Only update if state actually changed
    const isReady = composer.classList.contains('stt-ready');
    const isAccumulating = composer.classList.contains('stt-accumulating');
    
    if (shouldBeReady !== isReady || shouldBeAccumulating !== isAccumulating) {
      composer.classList.remove('stt-ready', 'stt-accumulating');
      if (shouldBeReady) {
        composer.classList.add('stt-ready');
      } else if (shouldBeAccumulating) {
        composer.classList.add('stt-accumulating');
      }
    }
    
    updateSendButtonState(); // FIX #9: Keep send button in sync
  }
  
  // FIX #9: Send button visual "ready" state
  function updateSendButtonState() {
    const sendBtn = document.getElementById('send-btn');
    if (!sendBtn) return;
    
    const hasText = input.value.trim().length > 0;
    const isReady = composer.classList.contains('stt-ready');
    
    sendBtn.classList.toggle('ready', hasText && isReady);
    sendBtn.classList.toggle('has-text', hasText);
  }

  // ---- Save question to history for undo ----
  function saveToQuestionHistory(text) {
    if (!text || text.trim().length < 5) return;
    
    // Don't save duplicates
    const last = questionHistory[questionHistory.length - 1];
    if (last && last.text === text.trim()) return;
    
    questionHistory.push({
      text: text.trim(),
      timestamp: Date.now()
    });
    
    // Keep only recent history
    while (questionHistory.length > MAX_QUESTION_HISTORY) {
      questionHistory.shift();
    }
    
    updateQuestionReadyState();
    // Badge tracks transcript turns — undo stack no longer drives it
  }
  
  // FIX #14: History button badge = transcript turns (not undo stack)
  function updateHistoryBadge() {
    const historyBtn = document.getElementById('history-btn');
    if (!historyBtn) return;

    let badge = historyBtn.querySelector('.history-badge');
    const list = document.getElementById('ts-list');
    const count = list
      ? list.querySelectorAll('.ts-turn:not(.ts-interim-row)').length
      : 0;

    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'history-badge';
        historyBtn.appendChild(badge);
      }
      badge.textContent = count > 9 ? '9+' : String(count);
      badge.style.display = '';
    } else if (badge) {
      badge.style.display = 'none';
    }
  }

  // ---- Restore last question from history (Ctrl+Z) ----
  function restoreLastQuestion() {
    const last = questionHistory.pop();
    if (last) {
      input.value = last.text;
      inputFromSTT = true;
      lastSTTValue = last.text; // FIX #8: Track restored value for edit detection
      composer.classList.add('stt-filling');
      updateQuestionReadyState();
      syncPlaceholder();
      showToast('Question restored', 1500);
      return true;
    }
    showToast('No question to restore', 1500);
    return false;
  }

  // ---- Auto-fill the input box with transcribed speech from interviewer ----
  function autoFillInputFromSTT(text) {
    // If user has manually typed something different, don't overwrite
    if (!inputFromSTT && input.value.trim().length > 0) return;

    // Cancel any pending soft-clear (interviewer is still talking)
    clearTimeout(softClearTimer);
    composer.classList.remove('stt-dimmed');

    const current = input.value.trim();
    const newText = current ? current + ' ' + text : text;
    input.value = newText;
    inputFromSTT = true;
    lastSTTValue = newText; // FIX #6: Track the STT value for edit detection
    syncPlaceholder();

    // Show filling state
    composer.classList.add('stt-filling');
    updateQuestionReadyState();
    updateSendButtonState(); // FIX #9: Update send button state

    // Reset the idle timer — after 2s of silence, check if question is complete
    clearTimeout(questionFinalizeTimer);
    questionFinalizeTimer = setTimeout(() => {
      if (isLikelyCompleteQuestion(input.value)) {
        composer.classList.add('stt-ready');
        updateSendButtonState(); // FIX #9: Update send button when ready
        // Subtle notification that question is ready
        showToast('Press Enter to answer', 2500);
      }
    }, 1800);

    // After 8s of no new words, save to history and keep stable
    clearTimeout(sttFillTimer);
    sttFillTimer = setTimeout(() => {
      saveToQuestionHistory(input.value);
      composer.classList.remove('stt-filling');
      // Keep stt-ready if applicable
      updateQuestionReadyState();
      updateSendButtonState(); // FIX #9
    }, 8000);
  }

  // ---- Soft clear: don't immediately wipe question when user speaks ----
  function softClearSTTFill() {
    // When the user speaks (You channel), don't immediately clear
    // Instead, dim the input and wait — they might just be acknowledging
    if (!inputFromSTT) return;
    
    // FIX #3: Reset userSpeechStart at the beginning before setting new timestamp
    // This ensures we always track from fresh when a new soft-clear cycle begins
    const now = Date.now();
    if (!userSpeechStart) {
      userSpeechStart = now;
    }

    // Dim the input to show it's in "pending clear" state
    composer.classList.add('stt-dimmed');
    
    // Clear the finalization timer (user is responding)
    clearTimeout(questionFinalizeTimer);

    // Re-armed on every 'you' final, so this fires ~800ms after the user stops.
    // The 2s test below is measured from the FIRST final of this cycle, so a brief
    // acknowledgement ("mm-hm") leaves the question on screen while a sustained
    // answer clears it. Firing at 2.5s instead would make that test always true.
    clearTimeout(softClearTimer);
    softClearTimer = setTimeout(() => {
      const speechDuration = userSpeechStart ? Date.now() - userSpeechStart : 0;
      if (speechDuration > 2000) {
        // User has been speaking for a while — they're answering, clear the box
        saveToQuestionHistory(input.value);
        input.value = '';
        inputFromSTT = false;
        composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
        syncPlaceholder();
        updateSendButtonState(); // FIX #9: Update send button state
        userSpeechStart = null;
      }
    }, 800);
  }

  // ---- Hard clear (called when user explicitly clears or types) ----
  // FIX #10: Add option to show toast when clearing
  function hardClearSTTFill(showUndoHint = false) {
    const hadContent = input.value.trim().length > 0;
    saveToQuestionHistory(input.value);
    input.value = '';
    inputFromSTT = false;
    sttSourceChannel = null;
    lastSTTValue = ''; // FIX #6: Clear the tracked STT value
    userSpeechStart = null;
    composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
    clearTimeout(softClearTimer);
    clearTimeout(questionFinalizeTimer);
    clearTimeout(sttFillTimer);
    clearInputInterim(); // FIX #5: Clear interim when clearing input
    syncPlaceholder();
    updateSendButtonState(); // FIX #9

    if (showUndoHint && hadContent) {
      const undoHint = isWindows ? 'Ctrl+Z to undo' : '⌘Z to undo';
      showToast(`Cleared · ${undoHint}`, 2000);
    }
  }

  // ---- Reset soft-clear state (interviewer spoke again) ----
  // FIX #16: Reset userSpeechStart properly when cancelSoftClear is called
  function cancelSoftClear() {
    userSpeechStart = null; // Reset timestamp so next soft-clear starts fresh
    clearTimeout(softClearTimer);
    composer.classList.remove('stt-dimmed');
  }

  function syncPlaceholder() {
    placeholder.classList.toggle('hidden', input.value.length > 0 || document.activeElement === input);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }
  
  // FIX #6: Track last STT value to detect substantial edits vs minor corrections
  let lastSTTValue = '';
  
  input.addEventListener('input', () => {
    const currentValue = input.value;
    
    // FIX #5: Clear interim text when user starts typing
    clearInputInterim();
    
    // FIX #6: Only detach from STT mode if edit is substantial
    // Minor corrections (typo fixes, small additions) should keep STT mode
    if (inputFromSTT && lastSTTValue) {
      const lengthDiff = Math.abs(currentValue.length - lastSTTValue.length);
      const isCleared = currentValue.trim().length === 0;
      const isSubstantialChange = lengthDiff > lastSTTValue.length * 0.3 || isCleared;
      
      if (isSubstantialChange) {
        // User made a major change — detach from STT mode
        saveToQuestionHistory(lastSTTValue);
        inputFromSTT = false;
        lastSTTValue = '';
        composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
        clearTimeout(softClearTimer);
        clearTimeout(questionFinalizeTimer);
      }
      // Minor edits: keep inputFromSTT = true, just update visual state
    } else if (!inputFromSTT) {
      // User typing from scratch — standard behavior
      composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
    }
    
    syncPlaceholder();
    updateSendButtonState(); // FIX #9: Update send button on input change
  });
  input.addEventListener('focus', () => { composer.classList.add('focused'); placeholder.classList.add('hidden'); });
  input.addEventListener('blur', () => { composer.classList.remove('focused'); syncPlaceholder(); });
  $('#input-area').addEventListener('click', () => input.focus());

  function send() {
    const text = input.value.trim();
    if (!text) { runMode('assist', ''); return; }
    const wasFromSTT = inputFromSTT;
    const sendMode = sttSourceChannel === 'them' ? 'answerThis' : 'ask';
    
    // Save to history before clearing (in case user wants to redo)
    saveToQuestionHistory(text);
    
    input.value = '';
    inputFromSTT = false;
    sttSourceChannel = null;
    lastSTTValue = ''; // FIX #6: Clear tracked STT value
    userSpeechStart = null;
    composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
    clearTimeout(softClearTimer);
    clearTimeout(questionFinalizeTimer);
    clearTimeout(sttFillTimer);
    syncPlaceholder();
    updateSendButtonState(); // FIX #9
    
    // Interviewer question in the box → answer it; mic dictation or typed text → ask.
    runMode(sendMode, text);
  }
  $('#send-btn').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    // Ctrl+Z / Cmd+Z: restore last question if input is empty
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !input.value.trim()) {
      e.preventDefault();
      restoreLastQuestion();
      return;
    }
    // Escape: clear the input (with undo hint)
    if (e.key === 'Escape' && input.value.trim()) {
      e.preventDefault();
      hardClearSTTFill(true); // FIX #10: Show undo hint
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); send(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runMode('assist', ''); }
  });
  
  // FIX #13: Global keyboard shortcut for force-answer (Ctrl+Shift+A / Cmd+Shift+A)
  document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+A / Cmd+Shift+A: Force answer current question immediately
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      if (input.value.trim()) {
        send();
      } else if (inputFromSTT || composer.classList.contains('stt-filling')) {
        // Even if question seems incomplete, force send
        send();
      } else {
        showToast('No question to answer', 1500);
      }
    }
  });
  
  // FIX #4: Add tooltip with keyboard shortcuts to send button
  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) {
    const forceKey = isWindows ? 'Ctrl+Shift+A' : '⌘⇧A';
    sendBtn.title = `Send · ${forceKey} to force answer`;
  }

  // Smart toggle — switches Fast ↔ Smart model tier
  const smartBtn = $('#smart-toggle');
  const smartBtnLabel = document.getElementById('smart-toggle-label');
  function syncSmartToggleUi() {
    if (!smartBtn || !settings) return;
    markPressed(smartBtn, !!settings.smart);
    if (smartBtnLabel) smartBtnLabel.textContent = settings.smart ? 'Smart' : 'Fast';
    updateSmartTooltip();
  }
  let smartToggleBusy = false;
  smartBtn.addEventListener('click', async () => {
    if (!settings || smartToggleBusy) return;
    smartToggleBusy = true;
    settings.smart = !settings.smart;
    syncSmartToggleUi();
    try {
      await apperture.settingsSet({ smart: settings.smart });
    } finally {
      smartToggleBusy = false;
    }
    const m = (settings.models && settings.models[settings.provider]) || {};
    const llmPreview = settings.smart
      ? (m.smart && m.smart !== m.fast ? m.smart : 'smarter model')
      : (m.fast || 'fast model');
    let label = llmPreview;
    if (settings.provider === 'openrouter' && settings.smart && (!m.smart || m.smart === m.fast || m.smart === 'google/gemma-4-31b-it:free' || m.smart === 'nvidia/nemotron-3-super-120b-a12b:free')) {
      label = 'minimax/minimax-m2.7:free';
    }
    showStatus(settings.smart
      ? 'Smart on — using ' + label
      : 'Fast mode — using ' + (m.fast || 'fast model'));
  });

  // Resume grounding toggle — when on, answers pull facts from the saved résumé
  const resumeBtn = document.getElementById('resume-toggle');
  function hasResumeText() {
    const live = $('#resume-text');
    if (live && String(live.value || '').trim()) return true;
    return !!(settings && settings.resumeText && String(settings.resumeText).trim());
  }
  function updateResumeToggleUi() {
    if (!settings) return;
    const loaded = hasResumeText();
    const on = settings.useResume !== false && loaded;
    if (resumeBtn) {
      markPressed(resumeBtn, on);
      resumeBtn.classList.toggle('needs-resume', !loaded);
      resumeBtn.title = !loaded
        ? 'Add a résumé in Settings → Profile, then turn this on'
        : (on
          ? 'Résumé grounding ON — answers use your résumé. Click to turn off.'
          : 'Résumé grounding OFF — click to answer from your résumé.');
    }
    setSwitchOn(document.getElementById('use-resume-settings'), on, !loaded);
    updateResumeMeta();
  }
  function updateResumeMeta() {
    const meta = document.getElementById('resume-meta');
    if (!meta) return;
    const text = ($('#resume-text') && $('#resume-text').value) || (settings && settings.resumeText) || '';
    const trimmed = String(text).trim();
    if (!trimmed) {
      meta.textContent = 'No résumé loaded';
      return;
    }
    const words = trimmed.split(/\s+/).filter(Boolean).length;
    const chars = trimmed.length;
    meta.textContent = words + ' words · ' + chars.toLocaleString() + ' characters ready';
  }
  async function setUseResume(next) {
    if (!settings) return;
    if (next && !hasResumeText()) {
      setSwitchOn(document.getElementById('use-resume-settings'), false, true);
      openSettingsTab('profile');
      showStatus('Import or paste your résumé first, then turn Resume on.');
      return;
    }
    settings.useResume = !!next;
    updateResumeToggleUi();
    updatePrepStatus();
    await apperture.settingsSet({ useResume: settings.useResume });
    showStatus(settings.useResume
      ? 'Résumé grounding on — answers will cite your résumé.'
      : 'Résumé grounding off.');
  }
  if (resumeBtn) {
    resumeBtn.addEventListener('click', () => {
      if (!hasResumeText()) {
        void setUseResume(true);
        return;
      }
      void setUseResume(!(settings.useResume !== false));
    });
  }

  // Hide / collapse
  let stealthAutoCollapsed = false;
  let panelWasExpandedBeforeStealth = true;

  function syncStealthUi() {
    const app = document.getElementById('app');
    const on = settings && settings.stealthMode !== false;
    if (app) app.classList.toggle('stealth-on', on);
  }

  function updateCaptureProtectionUi(info) {
    const cap = info && info.captureProtection;
    const pill = document.getElementById('stealth-level-pill');
    const text = document.getElementById('stealth-status-text');
    const tips = document.getElementById('stealth-tips');
    const shield = document.getElementById('stealth-shield');
    if (!cap) {
      if (pill) {
        pill.textContent = apperture.isWeb ? 'Web only' : 'Unknown';
        pill.className = 'stealth-pill stealth-pill-unknown';
      }
      if (text) {
        text.textContent = apperture.isWeb
          ? 'The browser runner cannot hide from screen share. Use the Electron desktop app for capture exclusion.'
          : 'Capture protection status unavailable.';
      }
      if (shield) {
        shield.classList.remove('hidden', 'warn', 'off');
        shield.classList.add('warn');
        shield.title = 'Screen-share hiding unavailable in web mode';
      }
      return;
    }
    const labels = {
      protected: 'Protected',
      partial: 'Best effort',
      unsupported: 'Unavailable',
      off: 'Disabled'
    };
    if (pill) {
      pill.textContent = labels[cap.level] || cap.level;
      pill.className = 'stealth-pill stealth-pill-' + (cap.level || 'unknown');
    }
    if (text) text.textContent = cap.message || '';
    if (tips) {
      tips.innerHTML = '';
      (cap.tips || []).forEach(function (tip) {
        const li = document.createElement('li');
        li.textContent = tip;
        tips.appendChild(li);
      });
    }
    if (shield) {
      shield.classList.remove('hidden', 'warn', 'off');
      if (cap.level === 'protected') {
        shield.title = 'Hidden from most screen shares';
      } else if (cap.level === 'partial') {
        shield.classList.add('warn');
        shield.title = 'Screen-share hiding is best-effort on this OS';
      } else {
        shield.classList.add('off');
        shield.title = 'Screen-share hiding unavailable';
      }
    }
  }

  function syncHideChrome(collapsed) {
    const btn = $('#hide-btn');
    const label = document.getElementById('hide-btn-label');
    if (btn) {
      btn.classList.toggle('collapsed', !!collapsed);
      btn.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
      const text = collapsed ? 'Show panel' : 'Hide panel';
      btn.title = text;
      btn.setAttribute('aria-label', text);
    }
    if (label) label.textContent = collapsed ? 'Show' : 'Hide';
  }

  function setPanelCollapsed(collapsed, fromStealth) {
    const panel = $('#panel');
    if (!panel) return;
    const isCollapsed = panel.classList.contains('collapsed');
    if (collapsed !== isCollapsed) {
      panel.classList.toggle('collapsed', collapsed);
      $('#panel-wrap').classList.toggle('panel-collapsed', collapsed);
      $('#app').classList.toggle('panel-collapsed', collapsed);
      $('#live-dot').style.display = collapsed ? 'none' : '';
      const stt = $('#stt-status');
      if (stt) stt.style.display = collapsed ? 'none' : '';
    }
    syncHideChrome(collapsed);
    if (!collapsed) stealthAutoCollapsed = false;
    if (fromStealth && !collapsed) stealthAutoCollapsed = false;
  }

  function maybeStealthCollapse(active) {
    if (!settings || settings.stealthMode === false || settings.stealthAutoCollapse !== true) return;
    if (active) {
      const panel = $('#panel');
      panelWasExpandedBeforeStealth = panel && !panel.classList.contains('collapsed');
      if (panelWasExpandedBeforeStealth) {
        setPanelCollapsed(true, true);
        stealthAutoCollapsed = true;
      }
    } else if (stealthAutoCollapsed && panelWasExpandedBeforeStealth) {
      setPanelCollapsed(false, true);
      stealthAutoCollapsed = false;
    }
  }

  function toggleHide() {
    const panel = $('#panel');
    if (!panel) return;
    setPanelCollapsed(!panel.classList.contains('collapsed'), false);
  }
  $('#hide-btn').addEventListener('click', toggleHide);
  apperture.on('hide:toggle', toggleHide);

  async function applyStealthMode(on) {
    if (!settings) return;
    settings.stealthMode = !!on;
    setSwitchOn(document.getElementById('stealth-mode'), settings.stealthMode);
    syncStealthUi();
    if (!on && stealthAutoCollapsed) setPanelCollapsed(false, true);
    await apperture.settingsSet({ stealthMode: settings.stealthMode });
    showStatus(settings.stealthMode ? 'Stealth on — branding hidden.' : 'Stealth off — branding visible.');
  }
  async function applyStealthAutoCollapse(on) {
    if (!settings) return;
    settings.stealthAutoCollapse = !!on;
    setSwitchOn(document.getElementById('stealth-auto-collapse'), settings.stealthAutoCollapse);
    if (!on && stealthAutoCollapsed) setPanelCollapsed(false, true);
    await apperture.settingsSet({ stealthAutoCollapse: settings.stealthAutoCollapse });
    showStatus(settings.stealthAutoCollapse
      ? 'Panel will collapse while listening.'
      : 'Panel stays open while listening.');
  }

  // Listen toggle. Kick off system-audio capture straight from the click so
  // the user-gesture is fresh for getDisplayMedia (loopback capture needs it).
  let listenToggleBusy = false;
  $('#stop-btn').addEventListener('click', async () => {
    if (listenToggleBusy) return;
    listenToggleBusy = true;
    const turningOn = !$('#stop-btn').classList.contains('active');
    try {
    let speechAlreadyStarted = false;
    if (turningOn && apperture.isWeb) {
      // Unlock mic permission on the click gesture, measure that audio exists, then
      // either keep the stream for cloud STT or release it for browser speech.
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1
          }
        });
        if (typeof apperture.stashPrimedMic === 'function') apperture.stashPrimedMic(stream);
        else stream.getTracks().forEach((t) => t.stop());
      } catch (err) {
        showMicPermissionBanner('prompt');
        showStatus('Microphone permission is required to listen. Allow access when the browser prompts you, then click listen again.');
      }
    } else if (turningOn && !(apperture.isWeb && apperture.usesBrowserSpeech)) {
      try { await startSystemAudio(); } catch (_) { /* handled inside startSystemAudio */ }
    }

    const active = await apperture.captureToggle({ deferSpeech: true, speechAlreadyStarted: false });

    if (turningOn && active && apperture.isWeb && apperture.usesBrowserSpeech) {
      // Release primed getUserMedia so SpeechRecognition can own the mic, then start it
      // while we are still in the click's async user-activation chain.
      const primed = typeof apperture.takePrimedMic === 'function' ? apperture.takePrimedMic() : null;
      if (primed) {
        primed.getTracks().forEach((t) => t.stop());
        await new Promise((r) => setTimeout(r, 120));
      }
      try {
        speechAlreadyStarted = !!apperture.startBrowserSpeechNow();
      } catch (_) {
        speechAlreadyStarted = false;
      }
      if (!speechAlreadyStarted) {
        showStatus('Could not start browser speech. Add a Groq or OpenAI key in Settings → Audio for cloud mic STT.');
      }
    } else if (turningOn && active && apperture.isWeb && !apperture.usesBrowserSpeech) {
      // Cloud mic path: startMic() takes the primed stream via capture:state.
    } else if (!active) {
      const primed = typeof apperture.takePrimedMic === 'function' ? apperture.takePrimedMic() : null;
      if (primed) primed.getTracks().forEach((t) => t.stop());
      stopSystemAudio();
    }
    } finally {
      listenToggleBusy = false;
    }
  });

  // Transcript toggle removed — sidebar now auto-opens with listening

  // Clear transcript
  const clearTranscriptBtn = document.getElementById('clear-transcript-btn');
  if (clearTranscriptBtn) {
    clearTranscriptBtn.addEventListener('click', async () => {
      await apperture.clearTranscript();
      clearTranscriptSidebar();
      updateHistoryBadge();
      showToast('Conversation history cleared', 2500);
    });
  }

  // ---- capture: mic (renderer side) — uses AudioWorklet (modern, off-main-thread) ----
  let audioCtx = null, micStream = null, micWorklet = null;
  async function startMic() {
    if (micStream) return;
    try {
      if (typeof apperture.takePrimedMic === 'function') {
        micStream = apperture.takePrimedMic();
      }
      if (!micStream) {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
            sampleRate: 16000
          }
        });
      }
      // getUserMedia can resolve with a stream that has no usable audio track
      // (e.g. a virtual/placeholder device, or a device that was unplugged
      // between permission grant and capture start). Fail loudly here instead
      // of silently wiring up an AudioWorklet to nothing — that produces the
      // "apperture never hears me, no error shown" symptom with no diagnostic at all.
      const [track] = micStream.getAudioTracks();
      if (!track) {
        micStream.getTracks().forEach((t) => t.stop());
        micStream = null;
        showStatus('No microphone audio track was available. Check Windows Sound settings for a working default input device, then try again.');
        return;
      }
      // Make sure the track is live — primed streams can arrive muted/ended.
      if (track.readyState !== 'live') {
        micStream.getTracks().forEach((t) => t.stop());
        micStream = null;
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
            sampleRate: 16000
          }
        });
      }
      apperture.log('mic stream started: track=' + (track.label || '(no label — permission may be stale)') + ' muted=' + (micStream.getAudioTracks()[0] && micStream.getAudioTracks()[0].muted));
      audioCtx = new AudioContext({ sampleRate: 16000 });
      if (audioCtx.state === 'suspended') {
        try { await audioCtx.resume(); } catch (_) {}
      }

      // Use AudioWorklet for low-latency, off-main-thread processing
      try {
        await audioCtx.audioWorklet.addModule('audio-worklet-processor.js');
        const source = audioCtx.createMediaStreamSource(micStream);
        micWorklet = new AudioWorkletNode(audioCtx, 'apperture-audio-processor');
        micWorklet.port.onmessage = (e) => {
          apperture.micPcm(e.data);
        };
        source.connect(micWorklet);
        // Don't connect to destination — we just capture, don't play
        apperture.log('mic AudioWorklet processor attached');
      } catch (workletErr) {
        // Fallback to ScriptProcessor if AudioWorklet fails (shouldn't happen in Electron 33+)
        apperture.log('AudioWorklet failed, falling back to ScriptProcessor: ' + workletErr.message);
        const micNode = audioCtx.createMediaStreamSource(micStream);
        const micProc = audioCtx.createScriptProcessor(4096, 1, 1);
        const sink = audioCtx.createGain(); sink.gain.value = 0;
        micNode.connect(micProc); micProc.connect(sink); sink.connect(audioCtx.destination);
        micProc.onaudioprocess = (e) => {
          const f = e.inputBuffer.getChannelData(0);
          const out = new Int16Array(f.length);
          for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
          apperture.micPcm(out.buffer);
        };
        micWorklet = { _legacy: true, proc: micProc, node: micNode, sink };
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      const name = err && err.name;
      apperture.log('mic error: ' + name + ' — ' + message);
      // getUserMedia's DOMException.name is the reliable signal here — the
      // .message text varies by Chromium version and isn't meant for users.
      // Distinguishing "no device" from "denied" from "in use elsewhere"
      // turns one generic dead end into three different next actions.
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        showMicPermissionBanner('missing');
        showStatus('No microphone was found. Plug one in, or pick a default input device in your OS sound settings, then try again.');
      } else if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
        showMicPermissionBanner('denied');
        showStatus(isWindows
          ? 'Microphone permission was denied. Settings → Privacy & security → Microphone → allow apperture, then try again.'
          : 'Microphone permission was denied. System Settings → Privacy & Security → Microphone → allow apperture, then try again.');
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        showStatus('The microphone could not be started — another application may be using it exclusively. Close other apps using the mic and try again.');
      } else {
        showStatus('Microphone capture could not be started. Check your mic permissions and try again.');
      }
    }
  }
  function stopMic() {
    if (micWorklet) {
      if (micWorklet._legacy) {
        micWorklet.proc.disconnect(); micWorklet.proc.onaudioprocess = null;
        micWorklet.node.disconnect(); micWorklet.sink.disconnect();
      } else {
        micWorklet.disconnect();
      }
      micWorklet = null;
    }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  }

  // ---- capture: system/meeting audio (getDisplayMedia loopback, in apperture's process) ----
  let sysStream = null, sysCtx = null, sysWorklet = null, sysStarting = false;
  async function startSystemAudio() {
    // Called both from the stop-btn click (fresh user gesture for getDisplayMedia) and from the
    // capture:state handler. getDisplayMedia is async, so `if (sysStream) return` alone loses the
    // race and can open a second loopback stream that is then orphaned.
    if (sysStream || sysStarting) return;
    sysStarting = true;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      apperture.log('system audio unavailable: getDisplayMedia not supported');
      showStatus('Meeting audio capture is not available on this device build.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });

      stream.getVideoTracks().forEach((t) => t.stop()); // we only want the audio
      const tracks = stream.getAudioTracks();
      if (!tracks.length) {
        apperture.log('system audio: no loopback track on this platform');
        stream.getTracks().forEach((t) => t.stop());
        showStatus(apperture.platform === 'win32'
          ? 'No system-audio loopback track detected. Make sure "Share audio" is checked in the screen share dialog, and that your audio device is not in exclusive mode.'
          : 'No system-audio loopback track detected. Meeting audio needs macOS 14.4+ — your screen and microphone still work.');
        return;
      }
      sysStream = stream;
      sysCtx = new AudioContext({ sampleRate: 16000 });

      // Use AudioWorklet for system audio too
      try {
        await sysCtx.audioWorklet.addModule('audio-worklet-processor.js');
        const source = sysCtx.createMediaStreamSource(new MediaStream(tracks));
        sysWorklet = new AudioWorkletNode(sysCtx, 'apperture-audio-processor');
        sysWorklet.port.onmessage = (e) => {
          apperture.systemPcm(e.data);
        };
        source.connect(sysWorklet);
        apperture.log('system audio: AudioWorklet capturing loopback');
      } catch (workletErr) {
        // Fallback to ScriptProcessor
        apperture.log('system audio AudioWorklet failed, using ScriptProcessor: ' + workletErr.message);
        const sysNode = sysCtx.createMediaStreamSource(new MediaStream(tracks));
        const sysProc = sysCtx.createScriptProcessor(4096, 1, 1);
        const sink = sysCtx.createGain(); sink.gain.value = 0;
        sysNode.connect(sysProc); sysProc.connect(sink); sink.connect(sysCtx.destination);
        sysProc.onaudioprocess = (e) => {
          const f = e.inputBuffer.getChannelData(0);
          const out = new Int16Array(f.length);
          for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
          apperture.systemPcm(out.buffer);
        };
        sysWorklet = { _legacy: true, proc: sysProc, node: sysNode, sink };
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      apperture.log('system audio error: ' + message);
      showStatus('Meeting audio could not be started. Grant screen/audio access to apperture and try again.');
    } finally {
      sysStarting = false;
    }
  }
  function stopSystemAudio() {
    if (sysWorklet) {
      if (sysWorklet._legacy) {
        sysWorklet.proc.disconnect(); sysWorklet.proc.onaudioprocess = null;
        sysWorklet.node.disconnect(); sysWorklet.sink.disconnect();
      } else {
        sysWorklet.disconnect();
      }
      sysWorklet = null;
    }
    if (sysCtx) { sysCtx.close(); sysCtx = null; }
    if (sysStream) { sysStream.getTracks().forEach((t) => t.stop()); sysStream = null; }
  }

  // ---- STT / VAD status helpers ------------------------------------------
  // Live dot states: 'off' | 'idle' | 'speaking' | 'transcribing'
  function setLiveDotState(dotState) {
    const dot = document.getElementById('live-dot');
    if (!dot) return;
    dot.classList.remove('off', 'idle', 'speaking', 'transcribing');
    dot.classList.add(dotState);
    const labels = {
      off:          'Not listening',
      idle:         'Listening — silence detected',
      speaking:     'Speech detected',
      transcribing: 'Transcribing…'
    };
    dot.title = labels[dotState] || '';
  }

  let sttState = 'disconnected';

  function updateSttStatus({ active, streaming } = {}) {
    const label = document.getElementById('stt-status');
    if (!label) return;
    if (active === false) {
      sttState = 'disconnected';
      label.textContent = 'off';
    } else if (active === true) {
      sttState = streaming ? 'live' : 'batch';
      label.textContent = sttState;
    }
    label.className = 'stt-status stt-' + (sttState === 'live' ? 'streaming' : sttState);
    label.hidden = sttState === 'disconnected';
  }

  // ---- transcript history sidebar (hidden by default, manual toggle) ----
  let tsSidebarInterimEl = null;
  let sidebarOpen = false;
  let sidebarAutoOpened = false;
  // Track last committed row per channel — all chunks from same speaker go in one row
  const tsLastRow = { you: null, them: null };
  const tsRowTimer = { you: null, them: null };
  const TS_SENTENCE_GAP_MS = 10000; // 10s silence = new row

  function showSidebar() {
    const sidebar = document.getElementById('transcript-sidebar');
    const historyBtn = document.getElementById('history-btn');
    const app = document.getElementById('app');
    if (sidebar) sidebar.classList.remove('hidden');
    if (historyBtn) {
      historyBtn.classList.add('active');
      historyBtn.setAttribute('aria-pressed', 'true');
    }
    const panelWrap = document.getElementById('panel-wrap');
    if (panelWrap) panelWrap.classList.add('sidebar-open');
    if (app) app.classList.add('sidebar-open');
    sidebarOpen = true;
  }

  function hideSidebar() {
    const sidebar = document.getElementById('transcript-sidebar');
    const historyBtn = document.getElementById('history-btn');
    const app = document.getElementById('app');
    if (sidebar) sidebar.classList.add('hidden');
    if (historyBtn) {
      historyBtn.classList.remove('active');
      historyBtn.setAttribute('aria-pressed', 'false');
    }
    const panelWrap = document.getElementById('panel-wrap');
    if (panelWrap) panelWrap.classList.remove('sidebar-open');
    if (app) app.classList.remove('sidebar-open');
    sidebarOpen = false;
  }

  const listenRail = document.getElementById('listen-rail');
  const listenRailProvider = listenRail ? listenRail.querySelector('.lr-provider') : null;
  function setListenRail(active, opts) {
    opts = opts || {};
    if (!listenRail) return;
    listenRail.classList.toggle('hidden', !active);
    listenRail.classList.toggle('transcribing', !!opts.transcribing);
    if (listenRailProvider) {
      listenRailProvider.textContent = active && opts.provider ? String(opts.provider) : '';
    }
    const liveDot = document.getElementById('live-dot');
    if (liveDot) liveDot.style.display = active ? 'none' : '';
  }

  function toggleSidebar() {
    if (sidebarOpen) {
      hideSidebar();
    } else {
      showSidebar();
      // FIX #7: Scroll to bottom when opening sidebar
      const list = document.getElementById('ts-list');
      if (list) {
        requestAnimationFrame(() => {
          list.scrollTop = list.scrollHeight;
        });
      }
    }
  }

  // History button toggle
  const historyBtn = document.getElementById('history-btn');
  if (historyBtn) {
    historyBtn.innerHTML = icon('message-square-text', { size: 15 });
    historyBtn.addEventListener('click', toggleSidebar);
  }

  // Close sidebar button
  const closeSidebarBtn = document.getElementById('close-sidebar-btn');
  if (closeSidebarBtn) {
    closeSidebarBtn.addEventListener('click', hideSidebar);
  }

  function appendTranscriptHistoryTurn(channel, text, isInterim) {
    const list = document.getElementById('ts-list');
    if (!list) return;

    // Remove placeholder on first real turn
    const ph = list.querySelector('.ts-placeholder');
    if (ph) ph.remove();

    if (isInterim) {
      // Update the single floating interim row — refresh channel if speaker switches
      if (!tsSidebarInterimEl) {
        tsSidebarInterimEl = document.createElement('div');
        tsSidebarInterimEl.className = 'ts-turn ts-' + channel + ' ts-interim-row';
        const chLabel = document.createElement('span');
        chLabel.className = 'ts-channel';
        chLabel.textContent = channel === 'them' ? 'Them' : 'You';
        const txt = document.createElement('span');
        txt.className = 'ts-text ts-interim';
        tsSidebarInterimEl.appendChild(chLabel);
        tsSidebarInterimEl.appendChild(txt);
        list.appendChild(tsSidebarInterimEl);
      } else {
        tsSidebarInterimEl.className = 'ts-turn ts-' + channel + ' ts-interim-row';
        const chLabel = tsSidebarInterimEl.querySelector('.ts-channel');
        if (chLabel) chLabel.textContent = channel === 'them' ? 'Them' : 'You';
      }
      tsSidebarInterimEl.querySelector('.ts-text').textContent = text;
    } else {
      // Remove interim row
      if (tsSidebarInterimEl) { tsSidebarInterimEl.remove(); tsSidebarInterimEl = null; }

      const existingRow = tsLastRow[channel];
      const useExisting = existingRow && existingRow.isConnected;

      if (useExisting) {
        // Append to existing row — accumulates sentence fragments
        const txt = existingRow.querySelector('.ts-text');
        if (txt) {
          txt.textContent = txt.textContent ? txt.textContent + ' ' + text : text;
        }
      } else {
        // Start a new row (no buttons — just clean history view)
        const row = document.createElement('div');
        row.className = 'ts-turn ts-' + channel;

        const chLabel = document.createElement('span');
        chLabel.className = 'ts-channel';
        chLabel.textContent = channel === 'them' ? 'Them' : 'You';

        const txt = document.createElement('span');
        txt.className = 'ts-text';
        txt.textContent = text;

        row.appendChild(chLabel);
        row.appendChild(txt);
        list.appendChild(row);
        tsLastRow[channel] = row;
      }

      // Reset silence timer
      clearTimeout(tsRowTimer[channel]);
      tsRowTimer[channel] = setTimeout(() => { tsLastRow[channel] = null; }, TS_SENTENCE_GAP_MS);

      // When THIS channel speaks, reset the OTHER channel's row
      const other = channel === 'you' ? 'them' : 'you';
      clearTimeout(tsRowTimer[other]);
      tsLastRow[other] = null;

      list.scrollTop = list.scrollHeight;
      updateHistoryBadge();
    }
  }

  function clearTranscriptSidebar() {
    const list = document.getElementById('ts-list');
    if (list) list.innerHTML = '<div class="ts-placeholder">Speech appears here while you listen.</div>';
    tsSidebarInterimEl = null;
    tsLastRow.you = null; tsLastRow.them = null;
    clearTimeout(tsRowTimer.you); clearTimeout(tsRowTimer.them);
    updateHistoryBadge();
  }

  // ---- events from main --------------------------------------------------
  function shouldStartRendererMic(mode) {
    // Electron always needs renderer PCM.
    if (!apperture.isWeb) return true;
    const m = mode || apperture.micMode || (apperture.usesBrowserSpeech ? 'browser-speech' : 'cloud-mic');
    // Browser speech owns the mic — opening getUserMedia steals it and captions stay empty.
    return m === 'cloud-mic' || m === 'none';
  }

  apperture.on('capture:state', ({ active, streaming, mode }) => {
    setLiveDotState(active ? 'idle' : 'off');
    syncListenButton(active);
    composer.classList.toggle('listening', active);
    const historyBtn = document.getElementById('history-btn');
    if (historyBtn) {
      historyBtn.classList.toggle('listening', active);
    }
    if (!active) {
      sidebarAutoOpened = false;
      setListenRail(false);
      maybeStealthCollapse(false);
    } else {
      const provider = (mode === 'cloud-mic' && apperture.micMode === 'cloud-mic')
        ? 'cloud'
        : (mode === 'browser-speech' ? 'browser' : (mode || 'mic'));
      setListenRail(true, { provider: provider });
      maybeStealthCollapse(true);
    }
    if (active) {
      if (shouldStartRendererMic(mode)) startMic();
      else stopMic();
    } else {
      stopMic();
      stopSystemAudio();
      clearInputInterim();
    }
    updateSttStatus({ active, streaming });
    if (active && mode === 'local') {
      sttState = 'local';
      const label = document.getElementById('stt-status');
      if (label) { label.textContent = 'local'; label.className = 'stt-status stt-local'; }
    } else {
      updateSttStatus({ active, streaming });
    }
  });

  // ---- composer interim captions (inside ask box) ----
  let inputInterimEl = null;
  function showInterimInInput(text) {
    if (!inputInterimEl) {
      inputInterimEl = document.createElement('span');
      inputInterimEl.className = 'input-interim';
      composer.appendChild(inputInterimEl);
    }
    inputInterimEl.textContent = text;
    const on = !!text;
    inputInterimEl.style.display = on ? 'block' : 'none';
    composer.classList.toggle('has-interim', on);
  }
  function clearInputInterim() {
    if (inputInterimEl) {
      inputInterimEl.textContent = '';
      inputInterimEl.style.display = 'none';
    }
    composer.classList.remove('has-interim');
  }
  
  apperture.on('stt:interim', ({ channel, text }) => {
    setLiveDotState('transcribing');
    setListenRail(true, { transcribing: true, provider: listenRailProvider && listenRailProvider.textContent });
    appendTranscriptHistoryTurn(channel, text, true);

    if (channel === 'them' && !input.value.trim()) {
      showInterimInInput(text);
    } else if (channel === 'you') {
      showInterimInInput(text);
    }
  });
  apperture.on('stt:final', ({ channel, text }) => {
    setLiveDotState('idle');
    setListenRail($('#stop-btn').classList.contains('active'), {
      transcribing: false,
      provider: listenRailProvider && listenRailProvider.textContent
    });
    clearTranscriptInterim();
    clearInputInterim();
  });
  apperture.on('stt:status', ({ channel, status, provider }) => {
    apperture.log(`[stt] ${provider || channel || 'unknown'} ${status}`);
    const label = document.getElementById('stt-status');
    const listening = $('#stop-btn').classList.contains('active');
    if (listening && provider && provider !== 'local' && provider !== 'cloud') {
      setListenRail(true, { provider: provider, transcribing: status === 'transcribing' });
    } else if (listening && status === 'transcribing') {
      setListenRail(true, { transcribing: true, provider: listenRailProvider && listenRailProvider.textContent });
    }
    if (provider === 'local') {
      const localLabels = {
        loading: 'loading local',
        ready: 'local',
        transcribing: 'local',
        stopping: 'stopping',
        off: 'off',
        error: 'error'
      };
      sttState = status === 'ready' || status === 'transcribing' ? 'local' : status;
      if (label) {
        label.textContent = localLabels[status] || status;
        label.className = 'stt-status stt-' + sttState;
        label.hidden = status === 'off';
      }
      if (status === 'loading') syncListenButton(true);
      if (status === 'off' || status === 'error') syncListenButton(false);
      if (status === 'loading' || status === 'transcribing' || status === 'stopping') setLiveDotState('transcribing');
      if (status === 'ready') setLiveDotState('idle');
      if (status === 'off') setLiveDotState('off');
      return;
    }
    if (status === 'connected' || status === 'streaming') {
      sttState = 'streaming';
      if (listening && provider) {
        setListenRail(true, { provider: provider, transcribing: status === 'transcribing' });
      }
      if (label) {
        label.textContent = 'live';
        label.className = 'stt-status stt-streaming';
        label.hidden = false;
      }
    } else if (status === 'disconnected' || status === 'off') {
      sttState = 'disconnected';
      if (label) {
        label.textContent = 'off';
        label.className = 'stt-status stt-disconnected';
        label.hidden = true;
      }
    } else if (status === 'error' && label) {
      sttState = 'error';
      label.textContent = 'error';
      label.className = 'stt-status stt-error';
      label.hidden = false;
    }
  });
  apperture.on('vad:state', ({ channel, speaking }) => {
    setLiveDotState(speaking ? 'speaking' : 'idle');
  });
  apperture.on('llm:start', ({ userBubble, small, category }) => {
    hideEmptyState();
    responseCount++;
    if (responseCount > MAX_RESPONSES) {
      const oldest = messages.querySelector('.response-group');
      if (oldest) oldest.remove();
      responseCount = MAX_RESPONSES;
    }
    const group = document.createElement('div');
    group.className = 'response-group';
    const sep = document.createElement('div');
    sep.className = 'response-sep';
    sep.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    group.appendChild(sep);
    if (userBubble) {
      const b = document.createElement('div');
      b.className = 'user-bubble';
      b.textContent = userBubble;
      group.appendChild(b);
    }
    if (category) {
      const pill = document.createElement('div');
      pill.className = 'category-pill';
      pill.textContent = category.charAt(0).toUpperCase() + category.slice(1);
      group.appendChild(pill);
    }
    aiEl = document.createElement('div');
    aiEl.className = 'ai-text' + (small ? ' small' : '');
    aiEl.dataset.raw = '';
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    aiEl.appendChild(caretEl);
    group.appendChild(aiEl);
    messages.appendChild(group);
    // Use requestAnimationFrame so the DOM is fully updated before scrolling
    requestAnimationFrame(() => {
      if (sep && sep.isConnected) sep.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    setBusy(true);
  });
  apperture.on('llm:token', ({ text }) => appendToken(text));
  apperture.on('llm:done', () => { finalizeAi(); setBusy(false); });
  apperture.on('llm:error', ({ message }) => {
    clearThinking();
    if (!aiEl) startAi(true);
    aiEl.dataset.raw = message; finalizeAi(); setBusy(false);
  });
  function shouldSoftClearForYouSpeech() {
    // When the ask box holds an interviewer question, mic speech is the user answering —
    // dim/clear instead of overwriting. Otherwise treat mic as dictation into the ask box.
    return sttSourceChannel === 'them' && input.value.trim().length > 0;
  }

  apperture.on('transcript', ({ channel, text }) => {
    if (!text || text.trim().length < 2 || /^[?!.,;:\-…]+$/.test(text.trim())) return;
    appendTranscriptHistoryTurn(channel, text, false);
    if ($('#stop-btn').classList.contains('active') && !sidebarAutoOpened) {
      showSidebar();
      sidebarAutoOpened = true;
    }
    if (channel === 'them') {
      cancelSoftClear();
      sttSourceChannel = 'them';
      autoFillInputFromSTT(text);
    } else if (shouldSoftClearForYouSpeech()) {
      softClearSTTFill();
    } else {
      cancelSoftClear();
      sttSourceChannel = 'you';
      autoFillInputFromSTT(text);
    }
  });
  let statusTimer = null;
  function showStatus(message) {
    let el = document.getElementById('apperture-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'apperture-status';
      // Insert into panel-main before the action row
      const panelMain = document.getElementById('panel-main');
      const actionRow = document.getElementById('action-row');
      if (panelMain && actionRow && actionRow.parentNode === panelMain) {
        panelMain.insertBefore(el, actionRow);
      } else if (panelMain) {
        panelMain.appendChild(el);
      } else {
        document.getElementById('panel').appendChild(el);
      }
    }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => el.classList.remove('show'), 11000);
  }
  apperture.on('status', ({ message }) => {
    apperture.log('[status] ' + message);
    showStatus(message);
    const listening = $('#stop-btn').classList.contains('active');
    if (listening && message && /cloud STT/i.test(message)) {
      const m = message.match(/cloud STT \(([^)]+)\)/i);
      if (m) setListenRail(true, { provider: m[1] });
    }
    if (sttState !== 'disconnected') {
      const lower = message.toLowerCase();
      if (lower.includes('error') || lower.includes(' off')) {
        sttState = 'error';
        const label = document.getElementById('stt-status');
        if (label) { label.textContent = sttState; label.className = 'stt-status stt-error'; }
      }
    }
  });

  // ---- prep status & smart tooltip helpers -------------------------------


  // ---- AI rules: live char counter + soft cap ---------------------------
  function updateAiRulesCounter() {
    const el = document.getElementById('ai-rules');
    const counter = document.getElementById('ai-rules-count');
    if (!el || !counter) return;
    const n = el.value.length;
    const cap = 2000;
    counter.textContent = String(n);
    counter.classList.toggle('over', n >= cap);
    counter.parentElement.classList.toggle('s-counter-warn', n >= cap - 100);
    const hint = document.querySelector('#settings .s-hint-block');
    if (hint) hint.classList.toggle('s-hint-warn', n >= cap - 100);
  }
  const aiRulesEl = document.getElementById('ai-rules');
  if (aiRulesEl) aiRulesEl.addEventListener('input', updateAiRulesCounter);
  function updatePrepStatus() {
    if (!settings) return;
    const fields = {
      resume:  !!(settings.resumeText && settings.resumeText.trim()),
      jd:      !!(settings.jobDescription && settings.jobDescription.trim()),
      stories: !!(settings.starStories && settings.starStories.trim()),
      salary:  !!(settings.salaryTarget && settings.salaryTarget.trim())
    };
    document.querySelectorAll('#prep-status .prep-item').forEach((el) => {
      const field = el.dataset.field;
      const loaded = fields[field];
      el.classList.toggle('loaded', loaded);
      el.classList.toggle('missing', !loaded);
      const resumeActive = field === 'resume' && loaded && settings.useResume !== false;
      el.classList.toggle('active', resumeActive);
      if (field === 'resume') {
        el.title = !loaded
          ? 'No résumé — click to open Profile and import one'
          : (resumeActive
            ? 'Résumé grounding ON — click to turn off'
            : 'Résumé loaded — click to ground answers in it');
      } else {
        el.title = loaded
          ? el.textContent.trim() + ' loaded — open Settings to edit'
          : el.textContent.trim() + ' not set — click to add in Settings';
      }
    });
    updateResumeToggleUi();
  }

  function openSettingsTab(tabName) {
    openSettings();
    const tab = document.querySelector(`.s-tab[data-tab="${tabName}"]`);
    if (tab && !tab.classList.contains('on')) tab.click();
  }

  document.querySelectorAll('#prep-status .prep-item').forEach((el) => {
    el.addEventListener('click', () => {
      const field = el.dataset.field;
      if (field === 'resume') {
        if (!hasResumeText()) {
          openSettingsTab('profile');
          return;
        }
        void setUseResume(!(settings.useResume !== false));
        return;
      }
      const tab = field === 'jd' ? 'profile' : (field === 'stories' ? 'prep' : 'qa');
      openSettingsTab(tab);
    });
  });

  function updateSmartTooltip() {
    if (!settings) return;
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    const fast = m.fast || 'fast model';
    const smart = m.smart || 'smart model';
    const btn = document.getElementById('smart-toggle');
    if (btn) {
      const mode = settings.smart ? 'Smart' : 'Fast';
      btn.title = mode + ' · Fast: ' + fast + ' · Smart: ' + smart + ' — click to switch';
    }
  }

  // ---- microphone permission banner --------------------------------------
  function showMicPermissionBanner(reason) {
    let banner = document.getElementById('mic-perm-banner');
    if (banner) { banner.classList.add('show'); return; }
    banner = document.createElement('div');
    banner.id = 'mic-perm-banner';
    banner.className = 'show';
    const web = !!(apperture.isWeb);
    const denied = reason === 'denied';
    const missing = reason === 'missing';
    const body = web
      ? (denied
        ? '<strong>Microphone blocked</strong><br>Click the lock icon in your browser address bar → allow Microphone for this site, then click listen again.'
        : (missing
          ? '<strong>No microphone found</strong><br>Plug in a mic or choose a default input in your system sound settings, then try again.'
          : '<strong>Microphone access needed</strong><br>Allow microphone access when the browser prompts you, then click listen again.'))
      : '<strong>Microphone access required</strong><br>apperture needs microphone permission to hear you during calls. Grant access in System Settings, then try again.';
    banner.innerHTML =
      '<div class="mic-perm-text">' + body + '</div>' +
      '<div class="mic-perm-actions"></div>';
    const actions = banner.querySelector('.mic-perm-actions');
    if (!web && apperture.platform === 'darwin') {
      const openBtn = document.createElement('button');
      openBtn.textContent = 'Open Microphone Settings';
      openBtn.addEventListener('click', () => apperture.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'));
      actions.appendChild(openBtn);
    }
    if (web && denied) {
      const audioBtn = document.createElement('button');
      audioBtn.textContent = 'Open Audio settings';
      audioBtn.addEventListener('click', () => openSettingsTab('transcription'));
      actions.appendChild(audioBtn);
    }
    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.className = 'dismiss';
    dismissBtn.addEventListener('click', () => banner.classList.remove('show'));
    actions.appendChild(dismissBtn);
    const panelMain = document.getElementById('panel-main') || document.getElementById('panel');
    const actionRow = document.getElementById('action-row');
    if (actionRow && actionRow.parentNode === panelMain) panelMain.insertBefore(banner, actionRow);
    else panelMain.appendChild(banner);
  }

  function initWebNotice() {
    const notice = document.getElementById('web-notice');
    const dismiss = document.getElementById('web-notice-dismiss');
    if (!notice || !apperture.isWeb) return;
    if (sessionStorage.getItem('apperture-web-notice-dismissed') === '1') return;
    notice.classList.remove('hidden');
    if (dismiss) {
      dismiss.addEventListener('click', function () {
        notice.classList.add('hidden');
        try { sessionStorage.setItem('apperture-web-notice-dismissed', '1'); } catch (_) {}
      });
    }
  }

  let updateUiState = { phase: 'idle', version: '', availableVersion: null, percent: 0, message: '' };
  let updateBannerDismissedVersion = null;

  function renderUpdateUi() {
    const statusText = document.getElementById('update-status-text');
    const currentVersion = document.getElementById('update-current-version');
    const progressWrap = document.getElementById('update-progress-wrap');
    const progress = document.getElementById('update-progress');
    const progressLabel = document.getElementById('update-progress-label');
    const installBtn = document.getElementById('update-install-btn');
    const checkBtn = document.getElementById('update-check-btn');
    const banner = document.getElementById('update-banner');
    const bannerText = document.getElementById('update-banner-text');
    const bannerAction = document.getElementById('update-banner-action');

    if (currentVersion) currentVersion.textContent = updateUiState.version || '—';
    const statusMessage = updateUiState.message || 'apperture checks GitHub for updates automatically.';
    if (statusText) {
      statusText.textContent = statusMessage;
      statusText.classList.toggle('update-status-error', updateUiState.phase === 'error');
    }
    if (progressWrap) progressWrap.classList.toggle('hidden', updateUiState.phase !== 'downloading');
    if (progress) progress.value = updateUiState.percent || 0;
    if (progressLabel) progressLabel.textContent = `${updateUiState.percent || 0}%`;
    if (installBtn) installBtn.classList.toggle('hidden', updateUiState.phase !== 'ready');
    if (checkBtn) checkBtn.disabled = updateUiState.phase === 'checking' || updateUiState.phase === 'downloading';

    if (!banner || !bannerText || apperture.isWeb) return;
    const showBanner = (updateUiState.phase === 'available' || updateUiState.phase === 'downloading' || updateUiState.phase === 'ready')
      && updateUiState.availableVersion
      && updateBannerDismissedVersion !== updateUiState.availableVersion;
    banner.classList.toggle('hidden', !showBanner);
    if (!showBanner) return;

    if (updateUiState.phase === 'ready') {
      bannerText.textContent = `Update ${updateUiState.availableVersion} is ready.`;
      if (bannerAction) {
        bannerAction.textContent = 'Restart now';
        bannerAction.classList.remove('hidden');
      }
    } else if (updateUiState.phase === 'downloading') {
      bannerText.textContent = `Downloading ${updateUiState.availableVersion}… ${updateUiState.percent || 0}%`;
      if (bannerAction) bannerAction.classList.add('hidden');
    } else {
      bannerText.textContent = `Update ${updateUiState.availableVersion} found — downloading in background.`;
      if (bannerAction) bannerAction.classList.add('hidden');
    }
  }

  async function refreshUpdateInfo() {
    if (!apperture.updateInfo) return;
    try {
      updateUiState = await apperture.updateInfo();
      renderUpdateUi();
    } catch (_) {}
  }

  function initAutoUpdateUi() {
    if (apperture.isWeb || !apperture.updateInfo) return;

    const checkBtn = document.getElementById('update-check-btn');
    const installBtn = document.getElementById('update-install-btn');
    const bannerAction = document.getElementById('update-banner-action');
    const bannerDismiss = document.getElementById('update-banner-dismiss');

    if (checkBtn && !checkBtn.dataset.wired) {
      checkBtn.dataset.wired = '1';
      checkBtn.addEventListener('click', async () => {
        updateUiState.message = 'Checking for updates…';
        renderUpdateUi();
        await apperture.updateCheck();
        await refreshUpdateInfo();
      });
    }
    if (installBtn && !installBtn.dataset.wired) {
      installBtn.dataset.wired = '1';
      installBtn.addEventListener('click', () => { void apperture.updateInstall(); });
    }
    if (bannerAction && !bannerAction.dataset.wired) {
      bannerAction.dataset.wired = '1';
      bannerAction.addEventListener('click', () => { void apperture.updateInstall(); });
    }
    if (bannerDismiss && !bannerDismiss.dataset.wired) {
      bannerDismiss.dataset.wired = '1';
      bannerDismiss.addEventListener('click', () => {
        updateBannerDismissedVersion = updateUiState.availableVersion;
        renderUpdateUi();
      });
    }

    apperture.on('update:status', (payload) => {
      updateUiState = { ...updateUiState, ...(payload || {}) };
      renderUpdateUi();
      if (payload && payload.phase === 'ready') {
        showToast(`Update ${payload.availableVersion || ''} ready — restart to install`, 5000);
      }
    });

    void refreshUpdateInfo();
  }

  function initKeysAdvancedToggle() {
    const toggle = document.getElementById('keys-advanced-toggle');
    const panel = document.getElementById('keys-advanced');
    if (!toggle || !panel) return;
    function setOpen(open) {
      panel.classList.toggle('hidden', !open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    if (!toggle.dataset.wired) {
      toggle.dataset.wired = '1';
      toggle.addEventListener('click', function () {
        setOpen(panel.classList.contains('hidden'));
      });
    }
    const advancedProviders = ['custom', 'ollama', 'minimax', 'azure', 'deepgram'];
    if (settings && advancedProviders.indexOf(settings.provider) !== -1) setOpen(true);
    else if (settings && settings.apiKeys) {
      const k = settings.apiKeys;
      if (k.deepgram || k.custom || k.minimax || k.azure || (k.ollama && k.ollama !== 'http://localhost:11434')) {
        setOpen(true);
      }
    }
  }

  // ---- settings ----------------------------------------------------------
  const scrim = $('#settings-scrim');
  function openSettings() {
    if (!scrim.classList.contains('hidden')) return;
    fillSettings();
    initKeysAdvancedToggle();
    scrim.classList.remove('hidden');
    refreshWhisperModels();
  }
  async function commitSettings() {
    if (await saveSettings()) scrim.classList.add('hidden');
  }
  async function dismissSettings() {
    try {
      settings = await apperture.settingsGet();
    } catch (_) { /* keep in-memory settings */ }
    fillSettings();
    updatePrepStatus();
    syncSmartToggleUi();
    syncStealthUi();
    updateResumeToggleUi();
    scrim.classList.add('hidden');
  }
  $('#more-btn').addEventListener('click', openSettings);
  $('#s-close').addEventListener('click', () => { void commitSettings(); });
  const sCancel = document.getElementById('s-cancel');
  if (sCancel) sCancel.addEventListener('click', () => { void dismissSettings(); });
  scrim.addEventListener('click', (e) => { if (e.target === scrim) void dismissSettings(); });

  document.querySelectorAll('#settings button').forEach((btn) => {
    if (!btn.getAttribute('type')) btn.type = 'button';
  });

  // Tab switching
  document.querySelectorAll('.s-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      if (tab.classList.contains('on')) return;
      document.querySelectorAll('.s-tab').forEach(t => t.classList.remove('on'));
      document.querySelectorAll('.s-tab-pane').forEach(p => p.classList.add('hidden'));
      tab.classList.add('on');
      const pane = document.querySelector(`.s-tab-pane[data-pane="${tab.dataset.tab}"]`);
      if (pane) pane.classList.remove('hidden');
    });
  });

  function updateCustomProviderFields() {
    $('#custom-endpoint-settings').classList.toggle('hidden', settings.provider !== 'custom');
  }

  function fillSettings() {
    // Keys tab
    syncSegGroup('#provider-seg button', 'provider', settings.provider);
    $('#key-openai').value = settings.apiKeys.openai || '';
    $('#key-anthropic').value = settings.apiKeys.anthropic || '';
    $('#key-gemini').value = settings.apiKeys.gemini || '';
    $('#key-openrouter').value = settings.apiKeys.openrouter || '';
    $('#key-deepgram').value = settings.apiKeys.deepgram || '';
    $('#key-custom').value = settings.apiKeys.custom || '';
    $('#base-url').value = settings.baseUrl || '';
    updateCustomProviderFields();
    $('#key-ollama').value = settings.apiKeys.ollama || '';
    $('#key-groq').value = settings.apiKeys.groq || '';
    $('#key-minimax').value = settings.apiKeys.minimax || '';
    syncSegGroup('#minimax-region-seg button', 'region', settings.minimaxRegion || 'global_en');
    $('#key-azure').value = settings.apiKeys.azure || '';
    $('#azure-endpoint').value = settings.azureEndpoint || '';
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    fillAppLinkCallers();
    $('#s-status').textContent = statusText();
    // Transcription tab
    syncSegGroup('#stt-provider-seg button', 'sttProvider', settings.sttProvider || 'auto');
    syncSttKeyFieldsFromKeys();
    updateSttKeyVisibility(settings.sttProvider || 'auto');
    const orStt = document.getElementById('openrouter-stt-model');
    if (orStt) {
      orStt.value = settings.openrouterSttModel
        || settings.sttModel
        || 'nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b';
    }
    const localWhisper = settings.localWhisper || { modelId: 'base.en', language: 'auto', threads: 0 };
    $('#whisper-language').value = localWhisper.language || 'auto';
    $('#whisper-threads').value = Number(localWhisper.threads) || 0;
    // Profile tab
    $('#resume-text').value = settings.resumeText || '';
    $('#job-description').value = settings.jobDescription || '';
    updateResumeToggleUi();
    const resumeName = document.getElementById('resume-filename');
    if (resumeName && !(resumeName.textContent || '').trim()) {
      resumeName.textContent = settings.resumeText ? 'Pasted résumé' : 'No file imported yet';
    }
    // Interview Prep tab
    $('#star-stories').value = settings.starStories || '';
    $('#why-company').value = settings.whyCompany || '';
    $('#why-leaving').value = settings.whyLeaving || '';
    $('#work-style').value = settings.workStyle || '';
    // Style tab
    setSwitchOn(document.getElementById('stealth-mode'), settings.stealthMode !== false);
    setSwitchOn(document.getElementById('stealth-auto-collapse'), settings.stealthAutoCollapse === true);
    $('#ai-rules').value = settings.aiRules || '';
    updateAiRulesCounter();
    // Q&A tab
    $('#salary-target').value = settings.salaryTarget || '';
    $('#questions-to-ask').value = settings.questionsToAsk || '';
  }

  // Whoever apperture has been told it may answer questions for. Empty is the normal
  // state — nothing appears here until something has asked and been allowed.
  async function fillAppLinkCallers() {
    const host = $('#applink-callers');
    if (!host || !apperture.appLinkState) return;
    let state;
    try { state = await apperture.appLinkState(); } catch (_) { return; }
    const callers = Object.entries((state && state.callers) || {});
    if (!callers.length) {
      host.innerHTML = '<div class="s-caller-empty">Nothing has asked yet.</div>';
      return;
    }
    host.innerHTML = '';
    for (const [id, scopes] of callers) {
      const allowed = Object.entries(scopes)
        .filter(([, record]) => record && record.decision === 'granted')
        .map(([scope]) => (scope === 'action' ? 'control' : 'read'));
      const name = (scopes.read && scopes.read.callerName) || (scopes.action && scopes.action.callerName) || id;

      const row = document.createElement('div');
      row.className = 's-caller';
      const label = document.createElement('span');
      label.textContent = name + ' — ' + (allowed.length ? allowed.join(' + ') : 'denied');
      label.title = id;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Forget';
      button.addEventListener('click', async () => {
        await apperture.appLinkRevoke(id);
        fillAppLinkCallers();
      });
      row.append(label, button);
      host.append(row);
    }
  }

  const uploadResumeBtn = document.getElementById('upload-resume-btn');
  if (uploadResumeBtn) uploadResumeBtn.addEventListener('click', async () => {
    const res = await apperture.pickProfileDocument();
    if (!res || res.canceled) return;
    if (res.error) { showStatus('Resume import failed: ' + res.error); return; }
    $('#resume-text').value = res.text || '';
    const resumeName = document.getElementById('resume-filename');
    if (resumeName) resumeName.textContent = res.fileName || 'Imported résumé';
    settings.resumeText = res.text || '';
    updateResumeMeta();
    updateResumeToggleUi();
    await apperture.settingsSet({ resumeText: settings.resumeText, useResume: true });
    settings.useResume = true;
    updateResumeToggleUi();
    updatePrepStatus();
    showStatus('Imported ' + (res.fileName || 'résumé') + ' — Resume is on.');
  });
  const clearResumeBtn = document.getElementById('clear-resume-btn');
  if (clearResumeBtn) clearResumeBtn.addEventListener('click', () => {
    $('#resume-text').value = '';
    const resumeName = document.getElementById('resume-filename');
    if (resumeName) resumeName.textContent = 'No file imported yet';
    settings.resumeText = '';
    updateResumeMeta();
    void setUseResume(false);
    void apperture.settingsSet({ resumeText: '' });
  });
  const resumeTextEl = document.getElementById('resume-text');
  if (resumeTextEl) {
    resumeTextEl.addEventListener('input', updateResumeMeta);
    resumeTextEl.addEventListener('blur', async () => {
      const text = resumeTextEl.value.trim();
      if (text === String(settings.resumeText || '').trim()) {
        updateResumeToggleUi();
        return;
      }
      settings.resumeText = text;
      await apperture.settingsSet({ resumeText: text });
      if (!text && settings.useResume) await setUseResume(false);
      else updateResumeToggleUi();
    });
  }
  const useResumeSettings = document.getElementById('use-resume-settings');
  if (useResumeSettings && !useResumeSettings.dataset.wired) {
    useResumeSettings.dataset.wired = '1';
    useResumeSettings.addEventListener('click', () => {
      void setUseResume(!isSwitchOn(useResumeSettings));
    });
  }
  const stealthModeBtn = document.getElementById('stealth-mode');
  if (stealthModeBtn && !stealthModeBtn.dataset.wired) {
    stealthModeBtn.dataset.wired = '1';
    stealthModeBtn.addEventListener('click', () => {
      void applyStealthMode(!isSwitchOn(stealthModeBtn));
    });
  }
  const stealthCollapseBtn = document.getElementById('stealth-auto-collapse');
  if (stealthCollapseBtn && !stealthCollapseBtn.dataset.wired) {
    stealthCollapseBtn.dataset.wired = '1';
    stealthCollapseBtn.addEventListener('click', () => {
      void applyStealthAutoCollapse(!isSwitchOn(stealthCollapseBtn));
    });
  }
  const uploadJdBtn = document.getElementById('upload-jd-btn');
  if (uploadJdBtn) uploadJdBtn.addEventListener('click', async () => {
    const res = await apperture.pickProfileDocument();
    if (!res || res.canceled) return;
    if (res.error) { showStatus('Job description import failed: ' + res.error); return; }
    $('#job-description').value = res.text || '';
    const jdName = document.getElementById('jd-filename');
    if (jdName) jdName.textContent = res.fileName || '';
    showStatus('Imported ' + res.fileName + ' — click Done to keep it.');
  });

  function statusText() {
    const k = settings.apiKeys;
    const labels = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', openrouter: 'OpenRouter', deepgram: 'Deepgram', custom: 'Custom', ollama: 'Ollama', groq: 'Groq', minimax: 'MiniMax', azure: 'Azure AI Foundry' };
    const has = Object.keys(labels).filter((p) => k[p]).map((p) => labels[p]);
    // 'auto' walks the same fallback chain src/stt.js builds; an explicit choice
    // is reported as-is so the status line matches what will actually be used.
    const selectedSttProvider = settings.sttProvider || 'auto';
    const automaticStt = k.deepgram ? 'Deepgram (streaming)' : (k.openai ? 'OpenAI Realtime' : (k.groq ? 'Groq Whisper' : (k.gemini ? 'Gemini (batch)' : 'none')));
    const stt = selectedSttProvider === 'auto' ? automaticStt : selectedSttProvider;
    const ready = [
      settings.resumeText ? '✓ resume' : null,
      settings.jobDescription ? '✓ JD' : null,
      settings.starStories ? '✓ stories' : null,
      settings.salaryTarget ? '✓ salary' : null
    ].filter(Boolean);
    return `${labels[settings.provider] || settings.provider} · STT: ${stt}` + (ready.length ? ' · ' + ready.join(' · ') : '');
  }

  document.querySelectorAll('#provider-seg button').forEach((b) => b.addEventListener('click', () => {
    settings.provider = b.dataset.provider;
    syncSegGroup('#provider-seg button', 'provider', settings.provider);
    updateCustomProviderFields();
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    $('#s-status').textContent = statusText();
    syncSmartToggleUi();
  }));
  document.querySelectorAll('#minimax-region-seg button').forEach((b) => b.addEventListener('click', () => {
    settings.minimaxRegion = b.dataset.region;
    syncSegGroup('#minimax-region-seg button', 'region', settings.minimaxRegion);
  }));

  document.querySelectorAll('#stt-provider-seg button').forEach((button) => button.addEventListener('click', () => {
    settings.sttProvider = button.dataset.sttProvider;
    syncSegGroup('#stt-provider-seg button', 'sttProvider', settings.sttProvider || 'auto');
    updateSttKeyVisibility(settings.sttProvider || 'auto');
    $('#s-status').textContent = statusText();
  }));

  const STT_KEY_PROVIDERS = ['groq', 'openai', 'gemini', 'deepgram', 'openrouter'];

  function syncSttKeyFieldsFromKeys() {
    STT_KEY_PROVIDERS.forEach((provider) => {
      const main = document.getElementById('key-' + provider);
      const stt = document.getElementById('stt-key-' + provider);
      if (main && stt) stt.value = main.value || '';
    });
  }

  function syncKeysFromSttKeyFields() {
    STT_KEY_PROVIDERS.forEach((provider) => {
      const main = document.getElementById('key-' + provider);
      const stt = document.getElementById('stt-key-' + provider);
      if (main && stt && stt.value.trim()) main.value = stt.value.trim();
      else if (main && stt && !stt.value.trim() && main.value.trim()) stt.value = main.value.trim();
    });
  }

  function updateSttKeyVisibility(provider) {
    const selected = provider || 'auto';
    STT_KEY_PROVIDERS.forEach((name) => {
      const wrap = document.getElementById('stt-key-' + name + '-wrap');
      if (!wrap) return;
      const show = selected === 'auto' || selected === name;
      wrap.classList.toggle('hidden', !show);
    });
    const orModel = document.getElementById('openrouter-stt-model');
    const orModelWrap = orModel && orModel.closest('.s-field');
    if (orModelWrap) orModelWrap.classList.toggle('hidden', selected !== 'auto' && selected !== 'openrouter');
    const hint = document.getElementById('stt-key-hint');
    if (hint) {
      if (selected === 'groq') {
        hint.innerHTML = 'Paste your Groq key here (<code>gsk_...</code>), then click <strong>Done</strong>. Get one free at console.groq.com.';
      } else if (selected === 'openai') {
        hint.innerHTML = 'Paste your OpenAI key here (<code>sk-...</code>), then click <strong>Done</strong>.';
      } else if (selected === 'gemini') {
        hint.innerHTML = 'Paste your Gemini key here, then click <strong>Done</strong>.';
      } else if (selected === 'deepgram') {
        hint.innerHTML = 'Paste your Deepgram key here for streaming STT, then click <strong>Done</strong>.';
      } else if (selected === 'openrouter') {
        hint.innerHTML = 'Paste your OpenRouter key here. Audio needs ~$0.50 in OpenRouter credits, or switch to <strong>Groq</strong> for free Whisper.';
      } else if (selected === 'local') {
        hint.innerHTML = 'Local Whisper runs in the Electron app only — no cloud key needed here.';
      } else {
        hint.innerHTML = 'Auto uses the first available speech key (Groq / OpenAI / Gemini / OpenRouter). Paste a <strong>Groq</strong> <code>gsk_...</code> key below for free mic captions.';
      }
    }
  }

  // Keep Audio-tab and Keys-tab fields in sync while typing.
  STT_KEY_PROVIDERS.forEach((provider) => {
    const main = document.getElementById('key-' + provider);
    const stt = document.getElementById('stt-key-' + provider);
    if (main && stt) {
      main.addEventListener('input', () => { stt.value = main.value; });
      stt.addEventListener('input', () => { main.value = stt.value; });
    }
  });

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
    const units = ['B', 'KB', 'MB', 'GB'];
    const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / (1024 ** unitIndex);
    return `${value >= 10 || unitIndex < 2 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
  }

  function getSelectedWhisperModel() {
    if (!whisperOverview) return null;
    return whisperOverview.models.find((model) => model.id === $('#whisper-model').value) || null;
  }

  function renderWhisperModelState() {
    const model = getSelectedWhisperModel();
    if (!model) {
      $('#whisper-model-detail').textContent = 'Local Whisper is only available in the Electron app.';
      $('#whisper-progress-wrap').classList.add('hidden');
      $('#whisper-download').disabled = true;
      $('#whisper-download').textContent = 'Unavailable';
      $('#whisper-cancel').classList.add('hidden');
      $('#whisper-import').disabled = true;
      $('#whisper-delete').disabled = true;
      return;
    }
    const language = model.englishOnly ? 'English only' : 'Multilingual';
    const recommendation = model.recommended ? ' · recommended default' : '';
    const partial = model.partialBytes > 0 && !model.installed
      ? ` · ${formatBytes(model.partialBytes)} ready to resume`
      : '';
    $('#whisper-model-detail').textContent = `${formatBytes(model.bytes)} · ${language} · ${model.quantization} · ${model.hardwareTier}${recommendation}${partial}`;

    const progressWrap = $('#whisper-progress-wrap');
    const progressPercent = model.bytes > 0 ? Math.floor((model.partialBytes / model.bytes) * 100) : 0;
    progressWrap.classList.toggle('hidden', !model.downloading);
    $('#whisper-progress').value = progressPercent;
    $('#whisper-progress-label').textContent = `${progressPercent}%`;
    $('#whisper-download').disabled = model.installed || model.downloading;
    $('#whisper-download').textContent = model.installed ? 'Installed' : (model.partialBytes ? 'Resume' : 'Download');
    $('#whisper-cancel').classList.toggle('hidden', !model.downloading);
    $('#whisper-import').disabled = model.downloading;
    $('#whisper-delete').disabled = (model.installedBytes === 0 && model.partialBytes === 0) || model.downloading;
  }

  async function refreshWhisperModels() {
    const status = $('#whisper-status');
    try {
      const previousSelection = $('#whisper-model').value || settings.localWhisper?.modelId || 'base.en';
      whisperOverview = await apperture.whisperModels();
      const runtime = whisperOverview.runtime || {
        available: !!whisperOverview.runtimeReady,
        version: '',
        target: '',
        message: whisperOverview.runtimeError || whisperOverview.runtimeMessage || ''
      };
      whisperOverview.runtime = runtime;
      whisperOverview.models = whisperOverview.models || [];

      const runtimeBadge = $('#whisper-runtime-status');
      runtimeBadge.classList.toggle('ready', !!runtime.available);
      runtimeBadge.classList.toggle('error', !runtime.available);
      runtimeBadge.textContent = runtime.available
        ? `Ready · v${runtime.version} · ${runtime.target}`
        : 'Not prepared';
      runtimeBadge.title = runtime.message || '';

      const select = $('#whisper-model');
      select.innerHTML = '';
      if (!whisperOverview.models.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No local models available';
        select.appendChild(option);
      }
      for (const model of whisperOverview.models) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = `${model.label} — ${formatBytes(model.bytes)}${model.recommended ? ' (recommended)' : ''}${model.installed ? ' ✓' : ''}`;
        select.appendChild(option);
      }
      const selectionExists = whisperOverview.models.some((model) => model.id === previousSelection);
      select.value = selectionExists ? previousSelection : (whisperOverview.models[0]?.id || '');
      if (!settings.localWhisper) settings.localWhisper = {};
      settings.localWhisper.modelId = select.value;
      status.textContent = runtime.available
        ? 'Model files are verified before they can be loaded.'
        : (runtime.message || 'Local transcription is unavailable in this environment.');
      renderWhisperModelState();
    } catch (error) {
      status.textContent = `Could not load local model information: ${error.message}`;
      const runtimeBadge = $('#whisper-runtime-status');
      if (runtimeBadge) {
        runtimeBadge.classList.add('error');
        runtimeBadge.classList.remove('ready');
        runtimeBadge.textContent = 'Unavailable';
      }
    }
  }

  $('#whisper-model').addEventListener('change', () => {
    if (!settings.localWhisper) settings.localWhisper = {};
    settings.localWhisper.modelId = $('#whisper-model').value;
    renderWhisperModelState();
  });

  $('#whisper-download').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (!model) return;
    model.downloading = true;
    renderWhisperModelState();
    $('#whisper-status').textContent = `Downloading ${model.id}. You can cancel and resume later.`;
    try {
      await apperture.whisperModelDownload(model.id);
      $('#whisper-status').textContent = `${model.id} downloaded and verified.`;
    } catch (error) {
      $('#whisper-status').textContent = error.message.includes('cancelled')
        ? `${model.id} download paused. Progress was kept.`
        : `Download failed: ${error.message}`;
    } finally {
      await refreshWhisperModels();
    }
  });

  $('#whisper-cancel').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (model) await apperture.whisperModelCancel(model.id);
  });

  $('#whisper-import').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (!model) return;
    $('#whisper-status').textContent = `Verifying imported ${model.id}…`;
    try {
      const result = await apperture.whisperModelImport(model.id);
      $('#whisper-status').textContent = result.cancelled ? 'Import cancelled.' : `${model.id} imported and verified.`;
    } catch (error) {
      $('#whisper-status').textContent = `Import failed: ${error.message}`;
    } finally {
      await refreshWhisperModels();
    }
  });

  $('#whisper-delete').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (!model || !window.confirm(`Delete the ${model.id} model (${formatBytes(model.bytes)}) from this computer?`)) return;
    try {
      await apperture.whisperModelDelete(model.id);
      $('#whisper-status').textContent = `${model.id} deleted.`;
    } catch (error) {
      $('#whisper-status').textContent = `Delete failed: ${error.message}`;
    } finally {
      await refreshWhisperModels();
    }
  });

  apperture.on('whisper:download-progress', (progress) => {
    if (!whisperOverview) return;
    const model = whisperOverview.models.find((candidate) => candidate.id === progress.modelId);
    if (!model) return;
    model.partialBytes = progress.receivedBytes;
    model.downloading = true;
    if ($('#whisper-model').value === progress.modelId) {
      $('#whisper-progress-wrap').classList.remove('hidden');
      $('#whisper-progress').value = progress.percent;
      $('#whisper-progress-label').textContent = `${progress.percent}%`;
      $('#whisper-model-detail').textContent = `${formatBytes(progress.receivedBytes)} of ${formatBytes(progress.totalBytes)}`;
    }
  });
  apperture.on('whisper:models-changed', () => refreshWhisperModels());

  async function saveSettings() {
    // Keys
    settings.apiKeys.openai = $('#key-openai').value.trim();
    settings.apiKeys.anthropic = $('#key-anthropic').value.trim();
    settings.apiKeys.gemini = $('#key-gemini').value.trim();
    settings.apiKeys.openrouter = $('#key-openrouter').value.trim();
    settings.apiKeys.deepgram = $('#key-deepgram').value.trim();
    settings.apiKeys.custom = $('#key-custom').value.trim();
    settings.baseUrl = $('#base-url').value.trim();
    settings.apiKeys.ollama = $('#key-ollama').value.trim();
    syncKeysFromSttKeyFields();
    settings.apiKeys.groq = $('#key-groq').value.trim();
    settings.apiKeys.minimax = $('#key-minimax').value.trim();
    settings.apiKeys.azure = $('#key-azure').value.trim();
    // Prefer Audio-tab values when present (same keys, easier to find).
    const sttGroq = document.getElementById('stt-key-groq');
    const sttOpenAI = document.getElementById('stt-key-openai');
    const sttGemini = document.getElementById('stt-key-gemini');
    const sttDeepgram = document.getElementById('stt-key-deepgram');
    const sttOpenRouter = document.getElementById('stt-key-openrouter');
    if (sttGroq && sttGroq.value.trim()) settings.apiKeys.groq = sttGroq.value.trim();
    if (sttOpenAI && sttOpenAI.value.trim()) settings.apiKeys.openai = sttOpenAI.value.trim();
    if (sttGemini && sttGemini.value.trim()) settings.apiKeys.gemini = sttGemini.value.trim();
    if (sttDeepgram && sttDeepgram.value.trim()) settings.apiKeys.deepgram = sttDeepgram.value.trim();
    if (sttOpenRouter && sttOpenRouter.value.trim()) settings.apiKeys.openrouter = sttOpenRouter.value.trim();
    settings.azureEndpoint = $('#azure-endpoint').value.trim();
    if (!settings.models[settings.provider]) settings.models[settings.provider] = {};
    settings.models[settings.provider].fast = $('#model-fast').value.trim();
    settings.models[settings.provider].smart = $('#model-smart').value.trim();
    // Transcription
    if (!settings.localWhisper) settings.localWhisper = {};
    settings.localWhisper.modelId = $('#whisper-model').value || settings.localWhisper.modelId || 'base.en';
    settings.localWhisper.language = $('#whisper-language').value || 'auto';
    settings.localWhisper.threads = Math.max(0, Math.min(64, Number.parseInt($('#whisper-threads').value, 10) || 0));
    const orSttSave = document.getElementById('openrouter-stt-model');
    if (orSttSave) {
      settings.openrouterSttModel = orSttSave.value.trim()
        || 'nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b';
    }
    // Profile
    settings.resumeText = $('#resume-text').value.trim();
    settings.jobDescription = $('#job-description').value.trim();
    const useResumeChkSave = document.getElementById('use-resume-settings');
    if (useResumeChkSave) settings.useResume = isSwitchOn(useResumeChkSave) && !!settings.resumeText;
    else if (typeof settings.useResume !== 'boolean') settings.useResume = true;
    // Interview Prep
    settings.starStories = $('#star-stories').value.trim();
    settings.whyCompany = $('#why-company').value.trim();
    settings.whyLeaving = $('#why-leaving').value.trim();
    settings.workStyle = $('#work-style').value.trim();
    // Style tab — switches already persist on click; keep Done in sync
    const stealthModeChkSave = document.getElementById('stealth-mode');
    const stealthCollapseChkSave = document.getElementById('stealth-auto-collapse');
    if (stealthModeChkSave) settings.stealthMode = isSwitchOn(stealthModeChkSave);
    if (stealthCollapseChkSave) settings.stealthAutoCollapse = isSwitchOn(stealthCollapseChkSave);
    settings.aiRules = $('#ai-rules').value.trim();
    // Q&A
    settings.salaryTarget = $('#salary-target').value.trim();
    settings.questionsToAsk = $('#questions-to-ask').value.trim();
    try {
      settings = await apperture.settingsSet(settings);
      $('#s-status').textContent = statusText();
      updatePrepStatus();
      syncSmartToggleUi();
      syncStealthUi();
      updateResumeToggleUi();
      return true;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      $('#s-status').textContent = message;
      $('#base-url').focus();
      return false;
    }
  }

  // demo conversation helper removed — boot always starts from the live empty state

  // ---- global keys -------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !scrim.classList.contains('hidden')) {
      e.preventDefault();
      void dismissSettings();
    }
  });

  // ---- click-through: only the UI blocks the mouse; empty gaps pass to your screen ----
  let ignoring = null;
  let isDragging = false;
  function setIgnore(v) {
    if (isDragging) return; // never flip click-through mid-drag
    if (v !== ignoring) { ignoring = v; apperture.setIgnoreMouse(v); }
  }
  document.addEventListener('mousemove', (e) => {
    if (isDragging) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const overUI = !!(el && el.closest && el.closest('#toolbar, #web-notice, #update-banner, #panel-wrap, #transcript-sidebar, #settings-scrim, #onboard-scrim, #consent-scrim'));
    setIgnore(!overUI);
  });
  setIgnore(true); // start fully click-through; hovering the panel re-enables it

  // ---- window drag (manual — reliable on Linux + with click-through) ----
  function dragTarget(el) {
    if (!el || !el.closest) return null;
    if (el.closest('button, a, input, textarea, select, .tb-hide, .tb-stop, .tb-quit, .tb-logo, .tb-guide')) return null;
    return el.closest('#toolbar, .drag-pill, .drag-handle');
  }
  function onDragMove(e) {
    if (!isDragging) return;
    apperture.dragMove(e.screenX, e.screenY);
  }
  function onDragEnd() {
    if (!isDragging) return;
    isDragging = false;
    document.body.classList.remove('is-dragging');
    apperture.dragEnd();
    window.removeEventListener('mousemove', onDragMove, true);
    window.removeEventListener('mouseup', onDragEnd, true);
    window.removeEventListener('blur', onDragEnd, true);
  }
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    // Web page layout breaks if #app is switched to position:fixed for dragging.
    if (apperture.isWeb) return;
    if (!dragTarget(e.target)) return;
    // Keep mouse events on the window so drag survives click-through.
    setIgnore(false);
    ignoring = false;
    apperture.setIgnoreMouse(false);
    isDragging = true;
    document.body.classList.add('is-dragging');
    apperture.dragStart(e.screenX, e.screenY);
    window.addEventListener('mousemove', onDragMove, true);
    window.addEventListener('mouseup', onDragEnd, true);
    window.addEventListener('blur', onDragEnd, true);
    e.preventDefault();
  }, true);

  // ---- assistant access request ------------------------------------------
  // Shown here rather than as a native dialog because apperture hides its dock icon:
  // an OS panel from an accessory app never comes forward and cannot be
  // clicked. Note the scrim is registered in the click-through selector above
  // and in styles.css — without both, this window stays transparent to the
  // mouse and the buttons do nothing.
  const consentScrim = $('#consent-scrim');
  let pendingConsentId = null;

  function answerConsent(allowed) {
    if (!pendingConsentId) return;
    apperture.appLinkConsentRespond(pendingConsentId, allowed);
    pendingConsentId = null;
    consentScrim.classList.add('hidden');
  }

  apperture.on('applink:consent-request', (request) => {
    pendingConsentId = request.id;
    $('#cs-title').textContent = request.message;
    $('#cs-body').textContent = request.detail;
    $('#cs-allow').textContent = request.allowLabel;
    consentScrim.classList.remove('hidden');
    // Do not wait for a mousemove to turn the mouse back on: the pointer may
    // already be still, and the sheet would be unclickable until it moved.
    setIgnore(false);
    $('#cs-deny').focus();
  });

  $('#cs-allow').addEventListener('click', () => answerConsent(true));
  $('#cs-deny').addEventListener('click', () => answerConsent(false));
  // Anything other than a deliberate Allow is a no, including Escape and
  // clicking away.
  consentScrim.addEventListener('click', (e) => { if (e.target === consentScrim) answerConsent(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pendingConsentId) { e.preventDefault(); answerConsent(false); }
  });

  // ---- topic guide (pick one tip; close anytime) --------------------------
  const obScrim = $('#onboard-scrim');
  const obHub = document.getElementById('ob-hub');
  const obDetail = document.getElementById('ob-detail');
  const permissionHelp = isWindows
    ? 'apperture needs permission to see and hear. Open Windows Privacy & security settings, allow <strong>Microphone</strong> and <strong>Screen recording</strong> for apperture, then come back here.'
    : isMac
      ? 'apperture needs two macOS permissions. Click each button, turn <strong>apperture</strong> ON in the window that opens, then come back here.'
      : 'apperture needs microphone and screen-capture access. Allow them when your desktop prompts you, then come back here.';
  const permissionButtons = isWindows
    ? [
        { label: 'Open Microphone settings', action: () => apperture.openPane('ms-settings:privacy-microphone') },
        { label: 'Open Screen recording settings', action: () => apperture.openPane('ms-settings:privacy-screenrecorder') }
      ]
    : isMac
      ? [
          { label: 'Open Microphone settings', action: () => apperture.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone') },
          { label: 'Open Screen Recording settings', action: () => apperture.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture') }
        ]
      : [];
  const assistShortcut = isWindows ? '<span class="kbd">Ctrl</span> <span class="kbd">↵</span>' : (isMac ? '<span class="kbd">⌘</span> <span class="kbd">↵</span>' : '<span class="kbd">Ctrl</span> <span class="kbd">↵</span>');
  const solveShortcut = isWindows ? '<span class="kbd">Ctrl</span> <span class="kbd">H</span>' : (isMac ? '<span class="kbd">⌘</span> <span class="kbd">H</span>' : '<span class="kbd">Ctrl</span> <span class="kbd">H</span>');
  const quitShortcut = isWindows ? '<span class="kbd">Ctrl</span><span class="kbd">⇧</span><span class="kbd">X</span>' : (isMac ? '<span class="kbd">⌘</span><span class="kbd">⇧</span><span class="kbd">X</span>' : '<span class="kbd">Ctrl</span><span class="kbd">⇧</span><span class="kbd">X</span>');
  const GUIDE_TOPICS = [
    {
      id: 'welcome',
      icon: 'logo',
      label: 'What is apperture',
      blurb: 'Private AI over your screen',
      title: 'Welcome to apperture',
      body: 'apperture is a private AI copilot that floats over your screen. It can <strong>see your screen</strong>, <strong>hear your meetings</strong>, and help you answer questions or solve coding problems — while staying hidden from most screen shares.'
    },
    {
      id: 'permissions',
      icon: 'shield',
      label: 'Permissions',
      blurb: 'Mic + screen access',
      title: 'Allow apperture to see & hear',
      body: permissionHelp + '<ul><li><strong>Microphone</strong> — to hear you</li><li><strong>Screen recording</strong> — to see your screen and hear meeting audio</li></ul>',
      buttons: permissionButtons
    },
    {
      id: 'keys',
      icon: 'key',
      label: 'Keys & listening',
      blurb: 'AI replies + mic captions',
      title: 'Connect a provider',
      body: 'apperture uses <strong>your own</strong> API key — pick <span class="hl">OpenAI</span>, <span class="hl">Anthropic</span>, <span class="hl">Gemini</span>, <span class="hl">OpenRouter</span>, <span class="hl">Groq</span>, or <span class="hl">Azure</span>. Paste keys in Settings → <span class="hl">AI</span>.<br><br><strong>Tip:</strong> For free live mic captions, add a <span class="hl">Groq</span> key under Settings → <span class="hl">Audio</span>.',
      buttons: [
        { label: 'Open Settings → AI', action: () => { closeGuide(); openSettingsTab('keys'); } },
        { label: 'Open Settings → Audio', action: () => { closeGuide(); openSettingsTab('transcription'); } }
      ]
    },
    {
      id: 'stealth',
      icon: 'eye-off',
      label: 'Stay hidden',
      blurb: 'Zoom + screen share',
      title: 'Stay hidden in Zoom',
      body: 'apperture is hidden from most screen shares automatically (Google Meet, Teams, QuickTime). <strong>Zoom needs one setting:</strong><br><br>Zoom → <span class="hl">Settings</span> → <span class="hl">Share Screen</span> → <span class="hl">Advanced</span> → <strong>Screen capture mode</strong> → <strong>“Advanced capture with window filtering.”</strong><br><br>Also check Settings → <span class="hl">Stealth</span> for branding and auto-collapse.',
      buttons: [{ label: 'Open Stealth settings', action: () => { closeGuide(); openSettingsTab('style'); } }]
    },
    {
      id: 'shortcuts',
      icon: 'zap',
      label: 'Shortcuts',
      blurb: 'Listen, ask, quit',
      title: 'How to use apperture',
      body: '<ul><li>' + assistShortcut + ' — <strong>Assist</strong> with what’s on screen</li><li>' + solveShortcut + ' — solve a coding problem on screen</li><li>Toolbar <strong>mic</strong> — start / stop listening</li><li>Type a question and press <span class="kbd">↵</span></li><li>Toolbar <strong>Guide</strong> — reopen these tips anytime</li><li>Quit with ' + quitShortcut + '</li></ul>'
    }
  ];

  function setGuideOpen(open) {
    const btn = document.getElementById('guide-btn');
    if (btn) {
      btn.classList.toggle('active', open);
      btn.setAttribute('aria-pressed', open ? 'true' : 'false');
    }
    if (open) {
      obScrim.classList.remove('hidden');
      setIgnore(false);
    } else {
      obScrim.classList.add('hidden');
    }
  }

  function showGuideHub() {
    if (obHub) obHub.classList.remove('hidden');
    if (obDetail) obDetail.classList.add('hidden');
    const list = document.getElementById('ob-topics');
    if (!list) return;
    list.innerHTML = '';
    GUIDE_TOPICS.forEach(function (topic) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ob-topic';
      btn.innerHTML =
        '<span class="ob-topic-ic">' + icon(topic.icon, { size: 16 }) + '</span>' +
        '<span class="ob-topic-copy"><strong>' + topic.label + '</strong><span>' + topic.blurb + '</span></span>' +
        '<span class="ob-topic-chev">' + icon('chevron-down', { size: 14, stroke: 2 }) + '</span>';
      btn.addEventListener('click', function () { openGuideTopic(topic.id); });
      list.appendChild(btn);
    });
  }

  function openGuideTopic(id) {
    const topic = GUIDE_TOPICS.find(function (t) { return t.id === id; });
    if (!topic) return;
    if (obHub) obHub.classList.add('hidden');
    if (obDetail) obDetail.classList.remove('hidden');
    $('#ob-icon').innerHTML = icon(topic.icon, { size: 22 });
    $('#ob-title').textContent = topic.title;
    $('#ob-body').innerHTML = topic.body;
    const btns = $('#ob-buttons');
    btns.innerHTML = '';
    (topic.buttons || []).forEach(function (b) {
      const el = document.createElement('button');
      el.textContent = b.label;
      el.addEventListener('click', b.action);
      btns.appendChild(el);
    });
  }

  function openGuide(topicId) {
    showGuideHub();
    setGuideOpen(true);
    if (topicId) openGuideTopic(topicId);
  }

  async function closeGuide() {
    setGuideOpen(false);
    if (obHub) obHub.classList.remove('hidden');
    if (obDetail) obDetail.classList.add('hidden');
    if (settings && !settings.onboarded) {
      settings.onboarded = true;
      await apperture.settingsSet({ onboarded: true });
    }
  }

  function toggleGuide() {
    if (obScrim.classList.contains('hidden')) openGuide();
    else void closeGuide();
  }

  // Keep old names used by Windows onboarding patch below
  const OB_STEPS = GUIDE_TOPICS;
  function showOnboard() { openGuide(); }
  async function finishOnboard() { await closeGuide(); }

  const obClose = document.getElementById('ob-close');
  const obDone = document.getElementById('ob-done');
  const obBack = document.getElementById('ob-back');
  if (obClose) obClose.addEventListener('click', () => { void closeGuide(); });
  if (obDone) obDone.addEventListener('click', () => { void closeGuide(); });
  if (obBack) obBack.addEventListener('click', showGuideHub);
  if (guideBtn) guideBtn.addEventListener('click', toggleGuide);
  obScrim.addEventListener('click', (e) => { if (e.target === obScrim) void closeGuide(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !obScrim.classList.contains('hidden') && scrim.classList.contains('hidden')) {
      e.preventDefault();
      void closeGuide();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); openSettings(); }
  });

  // ---- boot --------------------------------------------------------------
  (async function boot() {
    settings = await apperture.settingsGet();
    // Heal sticky OpenRouter Fast===Smart Gemma so Smart actually switches models
    if (settings.provider === 'openrouter' && settings.models && settings.models.openrouter) {
      const o = settings.models.openrouter;
      if (!o.smart || o.smart === o.fast || o.smart === 'google/gemma-4-31b-it:free' || o.smart === 'nvidia/nemotron-3-super-120b-a12b:free') {
        o.smart = 'minimax/minimax-m2.7:free';
        settings = await apperture.settingsSet({ models: settings.models });
      }
    }
    const platformInfo = await apperture.platformInfo();
    updateCaptureProtectionUi(platformInfo);
    syncStealthUi();
    initWebNotice();
    initAutoUpdateUi();

    // R4: shortcut hints
    const sayHintEl = document.getElementById('say-shortcut-hint');
    const assistHintEl = document.getElementById('assist-shortcut-hint');
    const useCtrl = isWindows || !isMac;
    if (sayHintEl) sayHintEl.textContent = useCtrl ? 'Ctrl+Shift+↵' : '⌘⇧↵';
    if (assistHintEl) assistHintEl.textContent = useCtrl ? 'Ctrl+↵' : '⌘↵';

    // R5: prep status
    updatePrepStatus();
    // R6: smart tooltip
    updateSmartTooltip();
    // Fix 3: Adjust permission buttons based on actual Windows version.
    // ms-settings:privacy-screenrecorder only exists on Windows 11.
    // On Windows 10, screen capture needs no permission — so replace the button
    // with a more helpful note instead of an invalid settings link.
    if (isWindows && platformInfo.winBuild > 0 && platformInfo.winBuild < 22000) {
      // Windows 10: update the onboarding screen recording button to be more helpful
      const ob = OB_STEPS[1];
      ob.buttons = ob.buttons.filter((b) => !b.label.toLowerCase().includes('screen'));
      ob.body = 'apperture needs microphone permission to hear you. Click the button below to open Windows microphone settings and allow apperture.<br><br><strong>Screen capture works automatically on Windows 10</strong> — no additional permission needed.<ul><li><strong>Microphone</strong> — to hear you</li><li><strong>Screen recording</strong> — works automatically on Windows 10</li></ul>';
    }

    syncSmartToggleUi();
    if (typeof settings.useResume !== 'boolean') settings.useResume = true;
    updateResumeToggleUi();
    wireEmptyActions(document.getElementById('messages-empty'));
    showEmptyState();
    syncPlaceholder();
    updateHistoryBadge();
    updateSendButtonState();

    // Platform-correct Assist hint (avoid ⌘ flash on Windows/Linux)
    const assistKeys = isWindows || !isMac
      ? '<span class="keycap">Ctrl</span><span class="keycap">⏎</span>'
      : '<span class="keycap">⌘</span><span class="keycap">⏎</span>';
    placeholder.innerHTML = 'Ask about your screen or conversation, or ' + assistKeys + ' for Assist';

    const st = await apperture.captureState();
    $('#live-dot').classList.toggle('off', !st.active);
    syncListenButton(!!st.active);
    syncHideChrome($('#panel') && $('#panel').classList.contains('collapsed'));
    composer.classList.toggle('listening', !!st.active);
    updateSttStatus({ active: !!st.active, streaming: !!st.active });
    if (st.active && shouldStartRendererMic(st.mode)) startMic();
    if (!settings.onboarded) showOnboard();
  })();
})();
