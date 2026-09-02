// Speech-to-text factory. Decoupled from the LLM provider because Anthropic has
// no audio API — we transcribe with whatever audio-capable key is available, and
// fall back across providers. Returns { text, provider } or { text:'', error }.
const { pcmToWav } = require('./wav');
const {
  formatProviderErrorMessage,
  isQuotaError,
  CURRENT_GEMINI_DEFAULT,
  resolveApiKey,
  OPENROUTER_HEADERS
} = require('./llm');

const BASE_VOCAB = 'CI/CD, Docker, Kubernetes, Terraform, Jenkins, AWS, Azure, GCP, ' +
  'CodeCommit, CodePipeline, CodeBuild, CodeDeploy, DevOps, SRE, microservices, deployment, ' +
  'pipeline, container, orchestration, Ansible, Prometheus, Grafana, Helm, EKS, ECS, Lambda, ' +
  'S3, EC2, IAM, GitHub Actions, GitLab, Kafka, PostgreSQL, Redis, MongoDB, REST API, gRPC';

const OPENROUTER_STT_MODEL = 'openai/whisper-large-v3-turbo';

function looksLikeHallucination(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return true;
  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(trimmed)) return true;
  const t = trimmed.replace(/[.,!?…]+$/g, '').trim().toLowerCase();
  const artifacts = new Set([
    'thank you', 'thank you very much', 'thank you for watching', 'thanks for watching',
    'please subscribe', 'like and subscribe', 'bye-bye', 'bye bye', 'bye', 'you', 'okay'
  ]);
  return artifacts.has(t);
}

function buildVocabPrompt(settings) {
  const s = settings || {};
  const text = (s.resumeText || '') + ' ' + (s.jobDescription || '');
  const proper = Array.from(new Set(text.match(/\b([A-Z][a-zA-Z0-9+.#]{2,}|[A-Z]{2,6})\b/g) || []));
  let prompt = BASE_VOCAB + (proper.length ? ', ' + proper.slice(0, 60).join(', ') : '');
  if (prompt.length > 850) prompt = prompt.slice(0, 850);
  return prompt;
}

async function transcribeOpenAI(apiKey, wav, model, baseURL, prompt) {
  const OpenAI = require('openai');
  const toFile = OpenAI.toFile || require('openai/uploads').toFile;
  const client = new OpenAI({ apiKey, baseURL });
  const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
  const res = await client.audio.transcriptions.create({
    file,
    model: model || 'whisper-1',
    language: 'en',
    temperature: 0,
    prompt: prompt || ''
  });
  return (res.text || '').trim();
}

async function transcribeGemini(apiKey, wav) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model: CURRENT_GEMINI_DEFAULT,
    contents: [{ role: 'user', parts: [
      { text: 'Transcribe this audio verbatim. Return only the spoken words with no commentary. If there is no clear speech, return an empty response.' },
      { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }
    ] }]
  });
  return ((res && res.text) || '').trim();
}

async function transcribeOpenRouter(apiKey, wav, model) {
  const res = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      ...OPENROUTER_HEADERS
    },
    body: JSON.stringify({
      model: model || OPENROUTER_STT_MODEL,
      language: 'en',
      input_audio: {
        data: wav.toString('base64'),
        format: 'wav'
      }
    })
  });
  let body = null;
  try { body = await res.json(); } catch (_) { body = null; }
  if (!res.ok) {
    const message = (body && body.error && (body.error.message || body.error)) || ('HTTP ' + res.status);
    const err = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    err.status = res.status;
    throw err;
  }
  return ((body && body.text) || '').trim();
}

function createSTT(settings) {
  const keys = settings.apiKeys || {};
  const selectedProvider = settings.sttProvider || 'auto';
  const vocabPrompt = buildVocabPrompt(settings);
  const chain = [];
  if ((selectedProvider === 'auto' || selectedProvider === 'openai') && keys.openai) {
    chain.push({ p: 'openai', fn: (wav) => transcribeOpenAI(keys.openai, wav, settings.sttModel, undefined, vocabPrompt) });
  }
  if ((selectedProvider === 'auto' || selectedProvider === 'groq') && keys.groq) {
    chain.push({ p: 'groq', fn: (wav) => transcribeOpenAI(keys.groq, wav, 'whisper-large-v3-turbo', 'https://api.groq.com/openai/v1', vocabPrompt) });
  }
  if ((selectedProvider === 'auto' || selectedProvider === 'gemini') && keys.gemini) {
    chain.push({ p: 'gemini', fn: (wav) => transcribeGemini(keys.gemini, wav) });
  }
  const openrouterKey = resolveApiKey('openrouter', keys);
  // OpenRouter STT needs account audio credits — keep it last behind direct Whisper keys.
  if ((selectedProvider === 'auto' || selectedProvider === 'openrouter') && openrouterKey) {
    chain.push({
      p: 'openrouter',
      fn: (wav) => transcribeOpenRouter(openrouterKey, wav, settings.sttModel || OPENROUTER_STT_MODEL)
    });
  }
  if (keys.openai && chain.length > 1) {
    const idx = chain.findIndex((c) => c.p === 'openai');
    if (idx > 0) chain.unshift(chain.splice(idx, 1)[0]);
  }

  let disabledUntil = 0;
  let lastProvider = null;

  return {
    available: chain.length > 0,
    providers: chain.map((c) => c.p),
    async transcribe(pcm) {
      if (!chain.length || !pcm || pcm.length < 3200) return { text: '' };
      const now = Date.now();
      if (disabledUntil && now < disabledUntil) {
        return {
          text: '',
          error: {
            provider: lastProvider,
            message: `Temporary ${lastProvider || 'provider'} quota or rate-limit; waiting 30s before retrying.`
          }
        };
      }
      const wav = pcmToWav(pcm, 16000, 1);
      let lastErr = null;
      for (const c of chain) {
        try {
          const text = await c.fn(wav);
          disabledUntil = 0;
          lastProvider = c.p;
          if (looksLikeHallucination(text)) return { text: '', provider: c.p };
          return { text, provider: c.p };
        } catch (e) {
          const quota = isQuotaError(e) || /requires at least \$|credits|402/i.test(String((e && e.message) || ''));
          const message = formatProviderErrorMessage(e, c.p);
          lastErr = { status: e && e.status, code: e && e.code, message, provider: c.p };
          if (quota) {
            lastProvider = c.p;
            disabledUntil = now + 30000;
            continue;
          }
        }
      }
      return { text: '', error: lastErr };
    }
  };
}

module.exports = { createSTT, looksLikeHallucination, buildVocabPrompt, OPENROUTER_STT_MODEL };
