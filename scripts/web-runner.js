#!/usr/bin/env node
/**
 * Real-time browser runner for apperture.
 * Serves the renderer and a live backend: settings + OpenRouter/LLM streaming.
 * No mock LLM replies — asks hit the real provider (OPENROUTER_API_KEY or Settings).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const store = require('../src/file-store');
const { createLLM } = require('../src/llm');
const { MODES } = require('../src/prompts');
const { buildInterviewContext, detectCategory } = require('../src/interview-context');
const { parseDocumentFile } = require('../src/resume');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.APPERTURE_WEB_PORT || 43142);
const HOST = process.env.APPERTURE_WEB_HOST || '0.0.0.0';
const ROOT = path.join(__dirname, '..', 'renderer');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json'
};

let transcript = [];
let capturing = false;
let busy = false;

function injectBridge(html) {
  if (html.includes('web-bridge.js')) return html;
  const bootCss = `<style>
    /* Distinct desktop scene so ultra-clear glass is obvious in the browser runner */
    html, body {
      background:
        radial-gradient(ellipse 70% 50% at 18% 22%, rgba(90,140,220,0.35), transparent 55%),
        radial-gradient(ellipse 55% 45% at 78% 70%, rgba(212,160,23,0.28), transparent 50%),
        radial-gradient(ellipse 40% 35% at 62% 18%, rgba(60,184,138,0.22), transparent 55%),
        linear-gradient(125deg, #1a2740 0%, #0b1018 42%, #1c1630 100%) !important;
      background-attachment: fixed !important;
      overflow: hidden !important;
      min-height: 100%;
    }
    html::before {
      content: '';
      position: fixed; inset: 0; pointer-events: none; z-index: 0;
      background-image:
        linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px);
      background-size: 48px 48px;
      mask-image: radial-gradient(ellipse 80% 70% at 50% 40%, #000 20%, transparent 75%);
    }
    #app { position: relative; z-index: 2; padding-bottom: 40px; padding-top: 28px; max-height: 100vh; overflow: auto; }
  </style>`;
  return html
    .replace('</head>', bootCss + '\n</head>')
    .replace('<script src="icons.js"></script>', '<script src="web-bridge.js"></script>\n  <script src="icons.js"></script>');
}

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function writeSse(res, payload) {
  res.write('data: ' + JSON.stringify(payload) + '\n\n');
}

async function handleAsk(req, res) {
  if (busy) {
    return send(res, 409, JSON.stringify({ error: 'busy' }), MIME['.json']);
  }
  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, JSON.stringify({ error: 'invalid json' }), MIME['.json']);
  }

  const mode = body.mode || 'ask';
  const userText = body.text || '';
  const def = MODES[mode];
  if (!def) return send(res, 400, JSON.stringify({ error: 'unknown mode' }), MIME['.json']);

  if (Array.isArray(body.transcript)) {
    transcript = body.transcript.map((t) => ({
      channel: t.channel === 'them' ? 'them' : 'you',
      text: String(t.text || '')
    })).filter((t) => t.text);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive'
  });

  busy = true;
  try {
    const settings = store.getSettings();
    const llm = createLLM(settings);
    const userBubble = def.userBubble !== null
      ? def.userBubble
      : (mode === 'ask' ? userText : null);
    const category = mode !== 'leetcode' ? detectCategory(transcript, userText) : null;
    writeSse(res, { type: 'start', userBubble, small: !!def.small, category });

    if (!llm.ready) {
      const message = llm.configurationError
        || ('Complete the ' + settings.provider + ' provider settings. Model: ' + (llm.model || 'unset') + '.');
      writeSse(res, { type: 'error', message });
      return;
    }

    const contextBlock = buildInterviewContext(settings, mode, transcript, userText);
    const system = def.buildSystem
      ? def.buildSystem(contextBlock, settings.aiRules || '')
      : (def.system || '');
    const built = def.build({ transcript, userText: userText || '' });

    await llm.stream({
      system,
      turns: [{ role: 'user', text: built }],
      imageDataUrl: null,
      onToken: (t) => writeSse(res, { type: 'token', text: t })
    });
    writeSse(res, { type: 'done' });
  } catch (e) {
    writeSse(res, { type: 'error', message: e && e.message ? e.message : String(e) });
  } finally {
    busy = false;
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', 'http://' + HOST + ':' + PORT);
  const method = req.method || 'GET';
  let rel = decodeURIComponent(u.pathname);
  if (rel.includes('..')) return send(res, 400, 'bad path');

  if (rel === '/api/health') {
    const settings = store.getSettings();
    const llm = createLLM(settings);
    return send(res, 200, JSON.stringify({
      ok: true,
      provider: settings.provider,
      model: llm.model,
      ready: llm.ready,
      configurationError: llm.configurationError || null,
      hasOpenRouterEnv: !!(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.trim()),
      capturing
    }), MIME['.json']);
  }

  if (rel === '/api/settings' && method === 'GET') {
    return send(res, 200, JSON.stringify(store.getSettings()), MIME['.json']);
  }

  if (rel === '/api/settings' && method === 'POST') {
    try {
      const patch = await readJson(req);
      return send(res, 200, JSON.stringify(store.setSettings(patch)), MIME['.json']);
    } catch (e) {
      return send(res, 400, JSON.stringify({ error: e.message }), MIME['.json']);
    }
  }

  if (rel === '/api/parse-document' && method === 'POST') {
    let tmp = null;
    try {
      const body = await readJson(req);
      const fileName = String(body.fileName || 'document.bin');
      const ext = path.extname(fileName).toLowerCase();
      if (!['.pdf', '.docx', '.txt', '.md'].includes(ext)) {
        return send(res, 400, JSON.stringify({ error: 'Use a PDF, DOCX, or plain-text file.' }), MIME['.json']);
      }
      const b64 = String(body.base64 || '');
      if (!b64) return send(res, 400, JSON.stringify({ error: 'Missing file data.' }), MIME['.json']);
      const buf = Buffer.from(b64, 'base64');
      if (buf.length > 8 * 1024 * 1024) {
        return send(res, 400, JSON.stringify({ error: 'File too large (max 8 MB).' }), MIME['.json']);
      }
      tmp = path.join(os.tmpdir(), 'apperture-doc-' + crypto.randomBytes(8).toString('hex') + ext);
      fs.writeFileSync(tmp, buf);
      let text = '';
      if (ext === '.txt' || ext === '.md') text = buf.toString('utf8').trim();
      else text = await parseDocumentFile(tmp);
      if (!text) return send(res, 400, JSON.stringify({ error: 'No text found in that file.' }), MIME['.json']);
      return send(res, 200, JSON.stringify({ ok: true, text, fileName }), MIME['.json']);
    } catch (e) {
      return send(res, 400, JSON.stringify({ error: e && e.message ? e.message : String(e) }), MIME['.json']);
    } finally {
      if (tmp) try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }

  if (rel === '/api/ask' && method === 'POST') {
    return handleAsk(req, res);
  }

  if (rel === '/api/capture/toggle' && method === 'POST') {
    capturing = !capturing;
    return send(res, 200, JSON.stringify({ active: capturing, streaming: capturing }), MIME['.json']);
  }

  if (rel === '/api/capture/state' && method === 'GET') {
    return send(res, 200, JSON.stringify({ active: capturing, streaming: capturing }), MIME['.json']);
  }

  if (rel === '/api/transcript' && method === 'POST') {
    try {
      const body = await readJson(req);
      if (Array.isArray(body.turns)) {
        transcript = body.turns.map((t) => ({
          channel: t.channel === 'them' ? 'them' : 'you',
          text: String(t.text || '')
        })).filter((t) => t.text);
      } else if (body.clear) {
        transcript = [];
      } else if (body.text) {
        transcript.push({
          channel: body.channel === 'them' ? 'them' : 'you',
          text: String(body.text)
        });
        if (transcript.length > 80) transcript = transcript.slice(-80);
      }
      return send(res, 200, JSON.stringify({ ok: true, count: transcript.length }), MIME['.json']);
    } catch (e) {
      return send(res, 400, JSON.stringify({ error: e.message }), MIME['.json']);
    }
  }

  if (rel === '/api/transcript' && method === 'DELETE') {
    transcript = [];
    return send(res, 200, JSON.stringify({ ok: true }), MIME['.json']);
  }

  if (rel === '/' || rel === '') rel = '/index.html';
  // Legacy mock filename → real bridge
  if (rel === '/web-mock.js') rel = '/web-bridge.js';

  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) return send(res, 400, 'bad path');

  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found: ' + rel);
    const ext = path.extname(file).toLowerCase();
    if (rel === '/index.html') {
      return send(res, 200, injectBridge(buf.toString('utf8')), MIME['.html']);
    }
    send(res, 200, buf, MIME[ext] || 'application/octet-stream');
  });
});

server.listen(PORT, HOST, () => {
  const settings = store.getSettings();
  const llm = createLLM(settings);
  console.log('[apperture-web] http://' + HOST + ':' + PORT + '/');
  console.log('[apperture-web] provider=' + settings.provider + ' model=' + llm.model + ' ready=' + llm.ready);
  if (!llm.ready) {
    console.log('[apperture-web] ' + (llm.configurationError || 'configure a provider key'));
  }
  if (process.env.OPENROUTER_API_KEY) {
    console.log('[apperture-web] OPENROUTER_API_KEY detected');
  }
});
