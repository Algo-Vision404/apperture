const assert = require('node:assert/strict');
const test = require('node:test');
const { createSTT } = require('../src/stt');
const { createStreamingSTT } = require('../src/stt-streaming');

const callbacks = {
  onTranscript() {},
  onInterim() {},
  onError() {},
  onStatusChange() {}
};

test('explicit local mode never constructs a cloud fallback', () => {
  const settings = {
    sttProvider: 'local',
    apiKeys: { openai: 'openai-key', gemini: 'gemini-key', deepgram: 'deepgram-key' }
  };
  assert.equal(createSTT(settings).available, false);
  assert.deepEqual(createStreamingSTT(settings, 'you', callbacks), {
    type: 'batch',
    provider: 'local',
    instance: null
  });
});

test('explicit cloud selection does not cross-fallback to another provider', () => {
  const openai = createSTT({
    sttProvider: 'openai',
    apiKeys: { openai: 'openai-key', gemini: 'gemini-key' }
  });
  const gemini = createSTT({
    sttProvider: 'gemini',
    apiKeys: { openai: 'openai-key', gemini: 'gemini-key' }
  });
  assert.deepEqual(openai.providers, ['openai']);
  assert.deepEqual(gemini.providers, ['gemini']);
});

test('OpenRouter key enables cloud STT as a last-resort provider', () => {
  const stt = createSTT({
    sttProvider: 'auto',
    apiKeys: { openrouter: 'or-key', openai: 'openai-key' }
  });
  assert.equal(stt.available, true);
  assert.deepEqual(stt.providers, ['openai', 'openrouter']);
});

test('OpenRouter-only settings still report STT available', () => {
  const stt = createSTT({
    sttProvider: 'auto',
    apiKeys: { openrouter: 'or-key' }
  });
  assert.equal(stt.available, true);
  assert.deepEqual(stt.providers, ['openrouter']);
});

test('OpenRouter STT defaults to Nemotron ASR model id', () => {
  const { OPENROUTER_STT_MODEL } = require('../src/stt');
  assert.equal(
    OPENROUTER_STT_MODEL,
    'nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b'
  );
});
