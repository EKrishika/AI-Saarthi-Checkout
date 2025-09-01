'use strict';

const { toolsToOpenAI, messagesToOpenAI, responseFromOpenAI } = require('./providers/translate');

/**
 * Provider-agnostic LLM boundary.
 *
 * The agent needs one capability — a model that can be handed tool schemas and
 * will ask to call them. Several providers offer that on a genuinely free tier,
 * so nothing here is hard-wired to one vendor: `LLM_PROVIDER` picks the backend
 * and everything above this file stays identical.
 *
 * Anthropic speaks its own dialect; everyone else here speaks OpenAI's
 * `/chat/completions`, translated in providers/translate.js.
 */

const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    dialect: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.0-flash',
    keyEnv: 'GEMINI_API_KEY',
    signupUrl: 'https://aistudio.google.com/apikey',
    free: true,
  },
  groq: {
    label: 'Groq',
    dialect: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    // Groq retires models fairly often (llama-3.3-70b-versatile is already
    // gone). If this 404s, `GET /v1/models` lists what the key can actually
    // reach and LLM_MODEL overrides it without a code change.
    defaultModel: 'openai/gpt-oss-120b',
    keyEnv: 'GROQ_API_KEY',
    signupUrl: 'https://console.groq.com/keys',
    free: true,
  },
  openrouter: {
    label: 'OpenRouter',
    dialect: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct',
    keyEnv: 'OPENROUTER_API_KEY',
    signupUrl: 'https://openrouter.ai/keys',
    free: true,
  },
  cerebras: {
    label: 'Cerebras',
    dialect: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1',
    defaultModel: 'llama-3.3-70b',
    keyEnv: 'CEREBRAS_API_KEY',
    signupUrl: 'https://cloud.cerebras.ai',
    free: true,
  },
  ollama: {
    label: 'Ollama (local)',
    dialect: 'openai',
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
    defaultModel: 'llama3.1',
    keyEnv: null, // runs locally, no key
    signupUrl: 'https://ollama.com',
    free: true,
  },
  anthropic: {
    label: 'Anthropic Claude',
    dialect: 'anthropic',
    defaultModel: 'claude-opus-5',
    keyEnv: 'ANTHROPIC_API_KEY',
    signupUrl: 'https://console.anthropic.com',
    free: false,
  },
};

const DEFAULT_PROVIDER = 'gemini';

class NotConfiguredError extends Error {}

function providerName() {
  const name = (process.env.LLM_PROVIDER || DEFAULT_PROVIDER).toLowerCase().trim();
  return PROVIDERS[name] ? name : DEFAULT_PROVIDER;
}

function providerConfig() {
  return PROVIDERS[providerName()];
}

function getModel() {
  return process.env.LLM_MODEL || process.env.ANTHROPIC_MODEL || providerConfig().defaultModel;
}

/**
 * Whether this provider has everything it needs to run.
 *
 * An untouched placeholder from .env.example counts as *not* configured. A
 * non-empty placeholder would otherwise satisfy a truthiness check, hide the
 * setup banner, and leave the first real message failing with an opaque 401 —
 * the exact confusion the banner exists to prevent.
 */
function isKeyPresent(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return !/^(paste|your|<|xxx|sk-ant-xxx|changeme|change-me)/i.test(trimmed);
}

function isConfigured() {
  const config = providerConfig();
  if (!config.keyEnv) return true; // local provider, no key needed
  return isKeyPresent(process.env[config.keyEnv]);
}

function describe() {
  const name = providerName();
  const config = providerConfig();
  return {
    provider: name,
    label: config.label,
    model: getModel(),
    free: config.free,
    configured: isConfigured(),
    keyEnv: config.keyEnv,
    signupUrl: config.signupUrl,
  };
}

function assertConfigured() {
  const config = providerConfig();
  if (isConfigured()) return;
  throw new NotConfiguredError(
    `I'm not configured yet — ${config.keyEnv} is missing for the ${config.label} provider. ` +
      `Get a free key at ${config.signupUrl}, put it in backend/.env, and restart the server ` +
      `(see docs/SETUP.md).`
  );
}

/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long a 429 says to wait. Providers express this differently — a
 * `retry-after` in seconds, or a reset window like "33.75s" / "1m12s" — so
 * parse what's there and fall back to exponential backoff.
 */
function retryDelayMs(response, attempt) {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;

  const reset = response.headers.get('x-ratelimit-reset-tokens') ||
                response.headers.get('x-ratelimit-reset-requests');
  if (reset) {
    const match = String(reset).match(/(?:(\d+(?:\.\d+)?)m)?(\d+(?:\.\d+)?)s/);
    if (match) {
      const seconds = (Number(match[1] || 0) * 60) + Number(match[2] || 0);
      if (seconds > 0) return Math.ceil(seconds * 1000);
    }
  }
  return Math.min(1000 * 2 ** attempt, 8000);
}

const MAX_RETRIES = 2;
const MAX_TOTAL_WAIT_MS = 25000;

/**
 * Free tiers are tight — Groq allows 8k tokens/minute, and a couple of quick
 * messages can exhaust it mid-demo. A 429 is a "wait", not a failure, so retry
 * it rather than surfacing an error to the buyer. Capped so a request can never
 * hang the UI indefinitely.
 */
async function createViaOpenAI(config, { model, system, tools, messages, maxTokens }) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.keyEnv) headers.Authorization = 'Bearer ' + process.env[config.keyEnv];

  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    messages: messagesToOpenAI(messages, system),
    tools: toolsToOpenAI(tools),
    tool_choice: 'auto',
  });

  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(config.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers,
      body,
    });

    if (response.ok) return responseFromOpenAI(await response.json());

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < MAX_RETRIES) {
      const delay = retryDelayMs(response, attempt);
      if (waited + delay <= MAX_TOTAL_WAIT_MS) {
        waited += delay;
        await sleep(delay);
        continue;
      }
    }

    const text = await response.text().catch(() => '');
    const err = new Error(`${config.label} returned ${response.status}. ${text.slice(0, 300)}`);
    err.status = response.status;
    throw err;
  }
}

async function createViaAnthropic({ model, system, tools, messages, maxTokens, effort }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client.messages.create({
    model,
    max_tokens: maxTokens,
    output_config: { effort },
    system,
    tools,
    messages,
  });
}

/**
 * One model turn. Takes and returns the internal Anthropic-shaped format
 * regardless of which provider actually served it.
 */
async function createMessage(options) {
  assertConfigured();
  const config = providerConfig();
  // Chat replies are short. A large max_tokens reserves budget against the
  // provider's tokens-per-minute limit for output that never arrives, which on
  // a free tier is the difference between a smooth demo and a 429.
  const request = Object.assign({ model: getModel(), maxTokens: 900, effort: 'low' }, options);

  return config.dialect === 'anthropic'
    ? createViaAnthropic(request)
    : createViaOpenAI(config, request);
}

module.exports = {
  createMessage,
  describe,
  getModel,
  isConfigured,
  providerName,
  providerConfig,
  NotConfiguredError,
  isKeyPresent,
  PROVIDERS,
  DEFAULT_PROVIDER,
};
