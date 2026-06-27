const axios = require('axios');
const cloudApi = require('./cloud-api-client');

const ALIGN_TIMEOUT_MS = 120000;
const TRANSCRIBE_TIMEOUT_MS = 120000;
const OLLAMA_TIMEOUT_MS = 120000;
const JWT_REFRESH_BUFFER_MS = 60_000;

let cachedComputeJwt = null;
let cachedExpiresAtMs = 0;
let onJwtRefreshed = null;

function getGatewayUrl(config) {
  const url = config?.computeGatewayUrl;
  if (!url || typeof url !== 'string') return null;
  return url.replace(/\/$/, '');
}

function isRemoteCompute(config) {
  return config?.computeMode === 'remote' && !!getGatewayUrl(config);
}

function setOnJwtRefreshed(callback) {
  onJwtRefreshed = typeof callback === 'function' ? callback : null;
}

function clearComputeTokenCache() {
  cachedComputeJwt = null;
  cachedExpiresAtMs = 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getComputeToken(config, forceRefresh = false) {
  const now = Date.now();
  if (
    !forceRefresh &&
    cachedComputeJwt &&
    cachedExpiresAtMs - now > JWT_REFRESH_BUFFER_MS
  ) {
    return cachedComputeJwt;
  }

  const apiToken = cloudApi.loadApiToken();
  if (!apiToken) {
    throw new Error('Sign in required for remote compute');
  }

  const base = cloudApi.getCloudApiBaseUrl(config);
  if (!base) {
    throw new Error('cloudApiBaseUrl is not configured');
  }

  const response = await axios.post(
    `${base}/api/compute/token`,
    {},
    {
      headers: { Authorization: `Bearer ${apiToken}` },
      timeout: 15000,
      validateStatus: () => true,
    }
  );

  if (response.status === 401) {
    throw new Error('Session expired — sign in again');
  }
  if (response.status === 429) {
    const retryAfter = parseInt(response.headers['retry-after'] || '60', 10);
    throw new Error(`Compute token rate limited — retry in ${retryAfter}s`);
  }
  if (response.status !== 200 || !response.data?.token) {
    const detail = response.data?.error || `HTTP ${response.status}`;
    throw new Error(`Failed to get compute token: ${detail}`);
  }

  cachedComputeJwt = response.data.token;
  cachedExpiresAtMs = new Date(response.data.expiresAt).getTime();
  if (onJwtRefreshed) {
    onJwtRefreshed(cachedComputeJwt);
  }
  return cachedComputeJwt;
}

async function buildAuthHeaders(config, forceRefresh = false) {
  if (!isRemoteCompute(config)) {
    return {};
  }
  const token = await getComputeToken(config, forceRefresh);
  return { Authorization: `Bearer ${token}` };
}

async function gatewayRequest(config, method, path, body, timeoutMs, retryCount = 0) {
  const base = getGatewayUrl(config);
  if (!base) {
    throw new Error('computeGatewayUrl not configured');
  }

  const headers = await buildAuthHeaders(config, retryCount > 0);
  try {
    const response = await axios({
      method,
      url: `${base}${path}`,
      data: body,
      headers,
      timeout: timeoutMs,
      validateStatus: () => true,
    });

    if (response.status === 401 && retryCount < 1 && isRemoteCompute(config)) {
      clearComputeTokenCache();
      return gatewayRequest(config, method, path, body, timeoutMs, retryCount + 1);
    }

    if (response.status === 429 && retryCount < 3) {
      const retryAfter = parseInt(response.headers['retry-after'] || '5', 10);
      await sleep(Math.max(1, retryAfter) * 1000);
      return gatewayRequest(config, method, path, body, timeoutMs, retryCount + 1);
    }

    if (response.status === 503) {
      const err = new Error('Compute server warming up');
      err.code = 'COMPUTE_WARMING';
      err.response = response;
      throw err;
    }

    if (response.status < 200 || response.status >= 300) {
      const err = new Error(response.data?.error || response.statusText || 'Request failed');
      err.response = response;
      throw err;
    }

    return response;
  } catch (error) {
    if (error.response) {
      throw error;
    }
    throw error;
  }
}

async function health(config) {
  const base = getGatewayUrl(config);
  if (!base) {
    return { success: false, ready: false, error: 'computeGatewayUrl not configured' };
  }

  try {
    const response = await axios.get(`${base}/health`, { timeout: 5000 });
    const ts = response.data?.transcription || {};
    return {
      success: response.status === 200,
      ready: !!ts.ready,
      alignerReady: !!ts.alignerReady,
      ollamaOk: !!response.data?.ollama?.ok,
      remoteMode: !!response.data?.remoteMode,
      transcribeActive: response.data?.transcribeActive ?? 0,
      ollamaActive: response.data?.ollamaActive ?? 0,
    };
  } catch (error) {
    return {
      success: false,
      ready: false,
      error: error.message || 'Gateway unreachable',
    };
  }
}

async function translate(config, text) {
  const response = await gatewayRequest(
    config,
    'post',
    '/translate',
    { text },
    OLLAMA_TIMEOUT_MS
  );
  if (response.data?.translation) {
    return { success: true, translation: response.data.translation };
  }
  return { success: false, error: 'No translation received' };
}

async function align(config, transcription, translation) {
  const response = await gatewayRequest(
    config,
    'post',
    '/align',
    { transcription, translation },
    ALIGN_TIMEOUT_MS
  );
  const data = response.data;
  if (!data || !Array.isArray(data.transcriptionChunks) || !Array.isArray(data.translationChunks)) {
    throw new Error('Alignment server returned an invalid response');
  }
  return {
    success: true,
    transcriptionChunks: data.transcriptionChunks,
    translationChunks: data.translationChunks,
    correlations: Array.isArray(data.correlations) ? data.correlations : [],
  };
}

async function vocabContext(config, word) {
  const response = await gatewayRequest(
    config,
    'post',
    '/vocab-context',
    { word },
    OLLAMA_TIMEOUT_MS
  );
  if (response.data?.context) {
    return { success: true, context: response.data.context };
  }
  return { success: false, error: 'No response received' };
}

async function flashcardEntry(config, word) {
  const response = await gatewayRequest(
    config,
    'post',
    '/flashcard-entry',
    { word },
    OLLAMA_TIMEOUT_MS
  );
  if (response.data?.raw) {
    return { success: true, raw: response.data.raw };
  }
  return { success: false, error: 'No response received' };
}

function formatGatewayError(error, fallbackConfig) {
  if (error.code === 'COMPUTE_WARMING') {
    return 'Compute server is warming up — try again shortly.';
  }
  if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
    return `Compute server unreachable at ${getGatewayUrl(fallbackConfig) || 'gateway'}. Is the server running?`;
  }
  if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
    return 'Compute server request timed out.';
  }
  if (error.response) {
    const detail = error.response.data?.error || error.response.statusText;
    return `Compute server HTTP ${error.response.status}: ${detail || 'request failed'}`;
  }
  return error.message || 'Compute server request failed';
}

module.exports = {
  isRemoteCompute,
  getGatewayUrl,
  getComputeToken,
  clearComputeTokenCache,
  setOnJwtRefreshed,
  health,
  translate,
  align,
  vocabContext,
  flashcardEntry,
  formatGatewayError,
};
