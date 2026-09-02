const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');

test('stealth and résumé use role=switch buttons, not native checkboxes', () => {
  assert.equal((html.match(/type="checkbox"/g) || []).length, 0);
  assert.match(html, /id="stealth-mode"[^>]*role="switch"/);
  assert.match(html, /id="stealth-auto-collapse"[^>]*role="switch"/);
  assert.match(html, /id="use-resume-settings"[^>]*role="switch"/);
});

test('settings has Cancel that discards and Done that saves', () => {
  assert.match(html, /id="s-cancel"/);
  assert.match(html, /id="s-close"/);
  assert.match(js, /function dismissSettings/);
  assert.match(js, /function commitSettings/);
  assert.match(js, /void dismissSettings\(\)/);
  assert.match(js, /void commitSettings\(\)/);
});

test('toolbar Hide/Listen/Smart expose pressed state', () => {
  assert.match(html, /id="hide-btn-label"/);
  assert.match(html, /id="smart-toggle-label"/);
  assert.match(js, /function syncListenButton/);
  assert.match(js, /function syncHideChrome/);
  assert.match(js, /function syncSmartToggleUi/);
  assert.match(js, /listenToggleBusy/);
});

test('stealth switches persist immediately instead of waiting for Done', () => {
  assert.match(js, /function applyStealthMode/);
  assert.match(js, /function applyStealthAutoCollapse/);
  assert.match(js, /settingsSet\(\{ stealthMode:/);
  assert.match(js, /settingsSet\(\{ stealthAutoCollapse:/);
});
