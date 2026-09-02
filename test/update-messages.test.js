const assert = require('node:assert/strict');
const test = require('node:test');

const { formatUpdateUserMessage } = require('../src/update-messages');

test('formatUpdateUserMessage hides raw updater codes and checksums', () => {
  const raw = 'sha512 checksum mismatch, expected abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ==, got ZYXWVUTSRQPONMLKJIHGFEDCBA987654321zyxwv==';
  const friendly = formatUpdateUserMessage('error', raw);
  assert.match(friendly, /integrity check/i);
  assert.doesNotMatch(friendly, /sha512/);
  assert.doesNotMatch(friendly, /expected/);
});

test('formatUpdateUserMessage maps network and GitHub errors to plain English', () => {
  assert.match(
    formatUpdateUserMessage('error', 'HttpError: 404 Not Found "https://github.com/Algo-Vision404/apperture/releases/download/v0.1.8/latest.yml"'),
    /wasn.t found on GitHub/i
  );
  assert.match(
    formatUpdateUserMessage('error', 'getaddrinfo ENOTFOUND github.com'),
    /Couldn.t reach GitHub/i
  );
});

test('formatUpdateUserMessage keeps friendly messages unchanged', () => {
  assert.equal(formatUpdateUserMessage('none', 'You’re on the latest version.'), 'You’re on the latest version.');
  assert.equal(formatUpdateUserMessage('checking', 'Checking for updates…'), 'Checking for updates…');
});
