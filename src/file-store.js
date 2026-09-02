// File-backed settings store for the browser runner (no Electron dependency).
const fs = require('fs');
const path = require('path');
const { normalizeBaseUrl } = require('./openai-compatible');

const MAX_AI_RULES_CHARS = 2000;
const OPENROUTER_DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const DATA_PATH = process.env.CUE_DATA_PATH
  || path.join(process.env.HOME || '/tmp', '.cue-web', 'cue-data.json');

const DEFAULTS = {
  provider: 'openrouter',
  sttProvider: 'auto',
  onboarded: true,
  localWhisper: {
    modelId: 'base.en',
    language: 'auto',
    threads: 0
  },
  smart: false,
  baseUrl: '',
  minimaxRegion: 'global_en',
  apiKeys: {
    openai: '', anthropic: '', gemini: '', deepgram: '', custom: '',
    ollama: '', groq: '', minimax: '', azure: '', openrouter: ''
  },
  azureEndpoint: '',
  resumeText: '',
  jobDescription: '',
  starStories: '',
  whyCompany: '',
  whyLeaving: '',
  workStyle: '',
  salaryTarget: '',
  questionsToAsk: '',
  aiRules: '',
  windowX: null,
  windowY: null,
  models: {
    openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
    anthropic: { fast: 'claude-3-5-haiku-latest', smart: 'claude-3-5-sonnet-latest' },
    gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-flash' },
    custom: { fast: '', smart: '' },
    ollama: { fast: 'llama3.2', smart: 'llama3.3' },
    groq: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' },
    minimax: { fast: 'MiniMax-M2.7', smart: 'MiniMax-M3' },
    azure: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
    openrouter: {
      fast: OPENROUTER_DEFAULT_MODEL,
      smart: OPENROUTER_DEFAULT_MODEL
    }
  }
};

let data = null;

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], over[k]);
    } else if (k === 'aiRules' && typeof over[k] === 'string') {
      out[k] = over[k].slice(0, MAX_AI_RULES_CHARS);
    } else {
      out[k] = over[k];
    }
  }
  return out;
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function load() {
  if (data) return data;
  try {
    data = deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')));
  } catch {
    data = deepMerge(DEFAULTS, {});
  }
  return data;
}

function save() {
  try {
    ensureDir(DATA_PATH);
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[cue-web] failed to save settings:', e.message);
  }
}

module.exports = {
  MAX_AI_RULES_CHARS,
  DATA_PATH,
  getSettings() { return load(); },
  setSettings(patch) {
    load();
    const next = deepMerge(data, patch || {});
    next.baseUrl = normalizeBaseUrl(next.baseUrl);
    data = next;
    save();
    return data;
  }
};
