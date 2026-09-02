#!/usr/bin/env node
/**
 * Browser runner for cue's renderer — open the UI without Electron.
 * Serves renderer/ and injects web-mock.js ahead of renderer.js.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.CUE_WEB_PORT || 43142);
const HOST = process.env.CUE_WEB_HOST || '0.0.0.0';
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

function injectMock(html) {
  if (html.includes('web-mock.js')) return html;
  // Transparent Electron chrome → solid stage so the overlay is visible in a browser.
  const bootCss = `<style>
    html, body {
      background:
        radial-gradient(900px 480px at 12% 0%, rgba(212,160,23,0.16), transparent 55%),
        radial-gradient(700px 420px at 88% 100%, rgba(60,184,138,0.10), transparent 50%),
        linear-gradient(165deg, #151922 0%, #07080b 48%, #0d1218 100%) !important;
      overflow: hidden !important;
      min-height: 100%;
    }
    #app { padding-bottom: 40px; padding-top: 28px; max-height: 100vh; overflow: auto; }
  </style>`;
  return html
    .replace('</head>', bootCss + '\n</head>')
    .replace('<script src="icons.js"></script>', '<script src="web-mock.js"></script>\n  <script src="icons.js"></script>');
}

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://' + HOST + ':' + PORT);
  let rel = decodeURIComponent(u.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.includes('..')) return send(res, 400, 'bad path');

  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) return send(res, 400, 'bad path');

  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found: ' + rel);
    const ext = path.extname(file).toLowerCase();
    if (rel === '/index.html') {
      return send(res, 200, injectMock(buf.toString('utf8')), MIME['.html']);
    }
    send(res, 200, buf, MIME[ext] || 'application/octet-stream');
  });
});

server.listen(PORT, HOST, () => {
  console.log('[cue-web] http://' + HOST + ':' + PORT + '/');
});
