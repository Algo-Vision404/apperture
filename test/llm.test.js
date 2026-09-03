const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const { OPTIONAL_API_KEY_PLACEHOLDER } = require('../src/openai-compatible');

let capturedClientOptions = null;
let capturedCompletionRequest = null;
const originalModuleLoad = Module._load;

Module._load = function loadWithOpenAIStub(request, parent, isMain) {
  if (request === 'openai') {
    return class FakeOpenAI {
      constructor(clientOptions) {
        capturedClientOptions = clientOptions;
        this.chat = {
          completions: {
            create: async (completionRequest) => {
              capturedCompletionRequest = completionRequest;
              return [{ choices: [{ delta: { content: 'ok' } }] }];
            }
          }
        };
      }
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

const { createLLM, formatProviderErrorMessage, isQuotaError, CURRENT_GEMINI_DEFAULT, OPENROUTER_DEFAULT_MODEL, OPENROUTER_SMART_MODEL, OPENROUTER_BASE_URL, resolveApiKey, GROQ_FAST_MODEL, GROQ_SMART_MODEL, migrateGroqModels } = require('../src/llm');

test.after(() => {
  Module._load = originalModuleLoad;
});

function createCustomSettings(overrides = {}) {
  return {
    provider: 'custom',
    smart: false,
    baseUrl: 'http://127.0.0.1:18789/v1',
    apiKeys: { custom: 'gateway-token' },
    models: { custom: { fast: 'openclaw/default', smart: 'openclaw/default' } },
    ...overrides
  };
}

test.beforeEach(() => {
  capturedClientOptions = null;
  capturedCompletionRequest = null;
});

test('routes the Custom provider through the configured OpenAI-compatible endpoint', async () => {
  const receivedTokens = [];
  const llm = createLLM(createCustomSettings());

  assert.equal(llm.ready, true);
  assert.equal(llm.model, 'openclaw/default');

  const response = await llm.stream({
    system: 'Be concise.',
    turns: [{ role: 'user', text: 'Hello' }],
    onToken: (token) => receivedTokens.push(token)
  });

  assert.deepEqual(capturedClientOptions, {
    apiKey: 'gateway-token',
    baseURL: 'http://127.0.0.1:18789/v1'
  });
  assert.equal(capturedCompletionRequest.model, 'openclaw/default');
  assert.equal(response, 'ok');
  assert.deepEqual(receivedTokens, ['ok']);
});

test('allows an unauthenticated local Custom endpoint', async () => {
  const llm = createLLM(createCustomSettings({ apiKeys: { custom: '' } }));
  await llm.stream({ system: '', turns: [], onToken: () => {} });

  assert.equal(capturedClientOptions.apiKey, OPTIONAL_API_KEY_PLACEHOLDER);
});

test('does not apply the Custom Base URL to official OpenAI requests', async () => {
  const llm = createLLM({
    provider: 'openai',
    smart: false,
    baseUrl: 'http://127.0.0.1:18789/v1',
    apiKeys: { openai: 'official-openai-key' },
    models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } }
  });

  await llm.stream({ system: '', turns: [], onToken: () => {} });

  assert.deepEqual(capturedClientOptions, { apiKey: 'official-openai-key' });
});

test('reports incomplete Custom endpoint settings without making a request', () => {
  const llm = createLLM(createCustomSettings({ baseUrl: '' }));

  assert.equal(llm.ready, false);
  assert.match(llm.configurationError, /Set a Base URL/);
  assert.equal(capturedClientOptions, null);
});

test('requires a model for the Custom provider', () => {
  const llm = createLLM(createCustomSettings({
    models: { custom: { fast: '', smart: '' } }
  }));

  assert.equal(llm.ready, false);
  assert.match(llm.configurationError, /Set a Fast or Smart model/);
});

// ---- MiniMax (PR #22) -----------------------------------------------------
// MiniMax is OpenAI-compatible and region-split, so these assert the regional
// gateway selection rather than any new transport.

function minimaxSettings(overrides) {
  return Object.assign({
    provider: 'minimax',
    smart: true,
    apiKeys: { minimax: 'test-key' },
    models: { minimax: { fast: 'MiniMax-M2.7', smart: 'MiniMax-M3' } }
  }, overrides || {});
}

test('selects the MiniMax model for the active tier and reports readiness', () => {
  const smart = createLLM(minimaxSettings({ smart: true }));
  assert.equal(smart.provider, 'minimax');
  assert.equal(smart.model, 'MiniMax-M3');
  assert.equal(smart.ready, true);

  const fast = createLLM(minimaxSettings({ smart: false }));
  assert.equal(fast.model, 'MiniMax-M2.7');
});

test('routes MiniMax to the global OpenAI-compatible endpoint by default', async () => {
  capturedClientOptions = null;
  const llm = createLLM(minimaxSettings({ minimaxRegion: 'global_en' }));
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(capturedClientOptions.baseURL, 'https://api.minimax.io/v1');
  assert.equal(capturedClientOptions.apiKey, 'test-key');
});

test('routes MiniMax to the China endpoint when that region is selected', async () => {
  capturedClientOptions = null;
  const llm = createLLM(minimaxSettings({ minimaxRegion: 'cn_zh' }));
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(capturedClientOptions.baseURL, 'https://api.minimaxi.com/v1');
});

test('falls back to the global endpoint for an unknown region', async () => {
  capturedClientOptions = null;
  const llm = createLLM(minimaxSettings({ minimaxRegion: 'unknown' }));
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(capturedClientOptions.baseURL, 'https://api.minimax.io/v1');
});

// ---- Gemini 404/429 error mapping ------------------------------------------
// Reproduces the exact bug-report clusters: "Error: got status: 404 Not Found.
// {"error":{"message":"exception parsing response","code":404,"status":"Not
// Found"}}" (dead/misspelled model) and 429 quota exhaustion, and asserts they
// come out as actionable in-app messages instead of the raw provider JSON.

function geminiApiError({ status, body }) {
  const err = new Error(`got status: ${status}. ${JSON.stringify(body)}`);
  err.name = 'ApiError';
  err.status = status; // matches @google/genai's ApiError shape
  return err;
}

test('formatProviderErrorMessage: OpenRouter 401 User not found becomes actionable key help', () => {
  const error = new Error('401 User not found');
  error.status = 401;
  const message = formatProviderErrorMessage(error, 'openrouter');
  assert.match(message, /OpenRouter rejected this API key/);
  assert.match(message, /sk-or-v1/);
  assert.match(message, /openrouter\.ai\/settings\/keys/);
  assert.doesNotMatch(message, /^401 User not found$/);
});

test('formatProviderErrorMessage: OpenAI 401 becomes provider-specific key help', () => {
  const error = new Error('Incorrect API key provided');
  error.status = 401;
  const message = formatProviderErrorMessage(error, 'openai');
  assert.match(message, /OpenAI rejected this API key/);
  assert.match(message, /Settings/);
});

test('createLLM: rejects an OpenAI-shaped key when Provider is OpenRouter', () => {
  const llm = createLLM({
    provider: 'openrouter',
    smart: false,
    apiKeys: { openrouter: 'sk-proj-not-an-openrouter-key' },
    models: { openrouter: { fast: 'google/gemma-4-31b-it:free', smart: 'minimax/minimax-m2.7:free' } }
  });
  assert.equal(llm.ready, false);
  assert.match(llm.configurationError, /looks like OpenAI/);
  assert.match(llm.configurationError, /OpenRouter/);
});

test('resolveApiKey: strips Bearer prefix and quotes from pasted keys', () => {
  assert.equal(
    resolveApiKey('openrouter', { openrouter: 'Bearer "sk-or-v1-abc"' }),
    'sk-or-v1-abc'
  );
});

test('formatProviderErrorMessage: maps a Gemini 404 to an actionable "model unavailable" message', () => {
  const error = geminiApiError({
    status: 404,
    body: { error: { message: 'exception parsing response', code: 404, status: 'Not Found' } }
  });
  const message = formatProviderErrorMessage(error, 'gemini', 'gemini-2.0-flash');
  assert.match(message, /Gemini/);
  assert.match(message, /model "gemini-2\.0-flash"/);
  assert.match(message, /unavailable \(404\)/);
  assert.match(message, /Settings/);
  assert.doesNotMatch(message, /exception parsing response/);
});

test('formatProviderErrorMessage: 404 message still works without a model id', () => {
  const error = geminiApiError({ status: 404, body: { error: { message: 'not found', code: 404 } } });
  const message = formatProviderErrorMessage(error, 'openai');
  assert.match(message, /OpenAI model is unavailable \(404\)/);
});

test('formatProviderErrorMessage: maps a Gemini 429 to a free-tier quota message', () => {
  const error = geminiApiError({
    status: 429,
    body: { error: { message: 'You exceeded your current quota', code: 429, status: 'RESOURCE_EXHAUSTED' } }
  });
  const message = formatProviderErrorMessage(error, 'gemini', 'gemini-2.5-flash');
  assert.match(message, /Gemini free-tier quota exhausted \(429/);
  assert.match(message, /billing/);
  assert.doesNotMatch(message, /RESOURCE_EXHAUSTED/);
});

test('formatProviderErrorMessage: surfaces retry-after when the 429 body carries a RetryInfo delay', () => {
  const error = geminiApiError({
    status: 429,
    body: {
      error: {
        message: 'Resource exhausted',
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '38s' }]
      }
    }
  });
  const message = formatProviderErrorMessage(error, 'gemini');
  assert.match(message, /Wait about 38s/);
});

test('formatProviderErrorMessage: 429 without a retry delay falls back to a generic wait hint', () => {
  const error = new Error('429 Too Many Requests');
  error.status = 429;
  const message = formatProviderErrorMessage(error, 'openai');
  assert.match(message, /Wait a moment/);
});

test('formatProviderErrorMessage: an OpenAI-style quota 429 (no numeric status) is still recognized', () => {
  // Matches the literal text one of the bug reports pasted in.
  const error = new Error('429 You exceeded your current quota, please check your plan and billing details.');
  const message = formatProviderErrorMessage(error, 'openai');
  assert.match(message, /OpenAI free-tier quota exhausted/);
});

test('formatProviderErrorMessage: an unrecognized error passes its raw message through unchanged', () => {
  const error = new Error('socket hang up');
  assert.equal(formatProviderErrorMessage(error, 'anthropic'), 'socket hang up');
});

test('isQuotaError: agrees with formatProviderErrorMessage on what counts as quota', () => {
  assert.equal(isQuotaError(geminiApiError({ status: 429, body: {} })), true);
  assert.equal(isQuotaError(geminiApiError({ status: 404, body: {} })), false);
  assert.equal(isQuotaError(new Error('insufficient_quota')), true);
});

// ---- Gemini model selection / self-healing migration -----------------------

function geminiSettings(overrides) {
  return Object.assign({
    provider: 'gemini',
    smart: false,
    apiKeys: { gemini: 'test-key' }
  }, overrides || {});
}

test('createLLM: falls back to CURRENT_GEMINI_DEFAULT when no model is configured', () => {
  const llm = createLLM(geminiSettings({ models: {} }));
  assert.equal(llm.model, CURRENT_GEMINI_DEFAULT);
  assert.equal(llm.ready, true);
});

test('createLLM: a fresh install (store.js DEFAULTS shape) resolves to the current default', () => {
  const llm = createLLM(geminiSettings({
    models: { gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-flash' } }
  }));
  assert.equal(llm.model, CURRENT_GEMINI_DEFAULT);
});

test('createLLM: self-heals a settings file saved with the retired gemini-2.0-flash default', () => {
  const llm = createLLM(geminiSettings({
    models: { gemini: { fast: 'gemini-2.0-flash', smart: 'gemini-2.0-flash' } }
  }));
  assert.equal(llm.model, CURRENT_GEMINI_DEFAULT);
});

test('createLLM: self-heals a legacy gemini-1.5-* model saved before the 2.0-flash migration existed', () => {
  const llm = createLLM(geminiSettings({
    models: { gemini: { fast: 'gemini-1.5-flash', smart: 'gemini-1.5-pro' } },
    smart: true
  }));
  assert.equal(llm.model, CURRENT_GEMINI_DEFAULT);
});

test('createLLM: leaves a user-chosen current Gemini model alone', () => {
  const llm = createLLM(geminiSettings({
    models: { gemini: { fast: 'gemini-3.5-flash', smart: 'gemini-3.5-flash' } }
  }));
  assert.equal(llm.model, 'gemini-3.5-flash');
});

// ---- OpenRouter -----------------------------------------------------------
function openrouterSettings(overrides) {
  return Object.assign({
    provider: 'openrouter',
    smart: false,
    apiKeys: { openrouter: 'sk-or-v1-test' },
    models: {
      openrouter: {
        fast: OPENROUTER_DEFAULT_MODEL,
        smart: OPENROUTER_SMART_MODEL
      }
    }
  }, overrides || {});
}

test('routes OpenRouter through openrouter.ai with free-router fallbacks', async () => {
  const llm = createLLM(openrouterSettings());
  assert.equal(llm.ready, true);
  assert.equal(llm.model, OPENROUTER_DEFAULT_MODEL);

  await llm.stream({ system: '', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });

  assert.equal(capturedClientOptions.apiKey, 'sk-or-v1-test');
  assert.equal(capturedClientOptions.baseURL, OPENROUTER_BASE_URL);
  assert.equal(capturedClientOptions.defaultHeaders['X-Title'], 'apperture');
  assert.equal(capturedClientOptions.defaultHeaders['HTTP-Referer'], 'https://github.com/Algo-Vision404/apperture');
  assert.equal(capturedCompletionRequest.model, OPENROUTER_DEFAULT_MODEL);
  assert.equal(capturedCompletionRequest.stream, true);
  assert.equal(capturedCompletionRequest.tool_choice, 'none');
  assert.ok(Array.isArray(capturedCompletionRequest.models));
  assert.ok(capturedCompletionRequest.models.includes('minimax/minimax-m2.7:free'));
  assert.equal(capturedCompletionRequest.reasoning, undefined);
});

test('OpenRouter Smart toggle upgrades identical Fast/Smart Gemma to MiniMax', async () => {
  const stuck = createLLM(openrouterSettings({
    smart: true,
    models: {
      openrouter: {
        fast: OPENROUTER_DEFAULT_MODEL,
        smart: OPENROUTER_DEFAULT_MODEL
      }
    }
  }));
  assert.equal(stuck.model, OPENROUTER_SMART_MODEL);
  assert.equal(stuck.smart, true);

  await stuck.stream({ system: '', turns: [], onToken: () => {} });
  assert.equal(capturedCompletionRequest.model, OPENROUTER_SMART_MODEL);
  assert.equal(capturedCompletionRequest.reasoning, undefined);
  assert.equal(capturedCompletionRequest.provider.sort, 'latency');
  assert.ok(capturedCompletionRequest.models.includes('google/gemma-4-31b-it:free'));
});

test('OpenRouter migrates legacy free-router / Nvidia Ultra / Nemotron Super Smart defaults', async () => {
  const llm = createLLM(openrouterSettings({
    models: {
      openrouter: {
        fast: 'openrouter/free',
        smart: 'openrouter/free'
      }
    }
  }));
  assert.equal(llm.model, OPENROUTER_DEFAULT_MODEL);

  const ultra = createLLM(openrouterSettings({
    models: {
      openrouter: {
        fast: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        smart: 'nvidia/nemotron-3-ultra-550b-a55b:free'
      }
    }
  }));
  assert.equal(ultra.model, OPENROUTER_DEFAULT_MODEL);

  const nemo = createLLM(openrouterSettings({
    smart: true,
    models: {
      openrouter: {
        fast: OPENROUTER_DEFAULT_MODEL,
        smart: 'nvidia/nemotron-3-super-120b-a12b:free'
      }
    }
  }));
  // Previous Smart default is migrated to the faster MiniMax smart model
  assert.equal(nemo.model, OPENROUTER_SMART_MODEL);
  await nemo.stream({ system: '', turns: [], onToken: () => {} });
  assert.equal(capturedCompletionRequest.reasoning, undefined);
});

test('Groq migrates retired Llama 3.1/3.3 chat models to GPT-OSS replacements', () => {
  const fast = createLLM({
    provider: 'groq',
    smart: false,
    apiKeys: { groq: 'gsk_test' },
    models: { groq: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' } }
  });
  assert.equal(fast.model, GROQ_FAST_MODEL);

  const smart = createLLM({
    provider: 'groq',
    smart: true,
    apiKeys: { groq: 'gsk_test' },
    models: { groq: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' } }
  });
  assert.equal(smart.model, GROQ_SMART_MODEL);

  const healed = migrateGroqModels({
    models: { groq: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' } }
  });
  assert.equal(healed.models.groq.fast, GROQ_FAST_MODEL);
  assert.equal(healed.models.groq.smart, GROQ_SMART_MODEL);
});

test('OpenRouter falls back to OPENROUTER_API_KEY from the environment', () => {
  const prev = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-from-env';
  try {
    const llm = createLLM(openrouterSettings({ apiKeys: { openrouter: '' } }));
    assert.equal(llm.ready, true);
    assert.equal(llm.apiKey, 'sk-or-v1-from-env');
    assert.equal(resolveApiKey('openrouter', { openrouter: '' }), 'sk-or-v1-from-env');
  } finally {
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prev;
  }
});

test('OpenRouter reports a clear error when no key is configured', () => {
  const prev = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const llm = createLLM(openrouterSettings({ apiKeys: { openrouter: '' } }));
    assert.equal(llm.ready, false);
    assert.match(llm.configurationError, /OPENROUTER_API_KEY/);
  } finally {
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prev;
  }
});

test('formats Nvidia overload errors into an actionable OpenRouter message', () => {
  const { formatProviderErrorMessage } = require('../src/llm');
  const msg = formatProviderErrorMessage(
    new Error('Upstream error from Nvidia: Service temporarily overloaded'),
    'openrouter',
    'nvidia/nemotron-3-ultra-550b-a55b:free'
  );
  assert.match(msg, /temporarily overloaded/i);
  assert.match(msg, /fallbacks|another free model/i);
});
