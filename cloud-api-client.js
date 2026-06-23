const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const authTokenFile = () => path.join(app.getPath('userData'), 'api-token.enc');
const authMetaFile = () => path.join(app.getPath('userData'), 'auth-meta.json');

function isEncryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function saveApiToken(token, email) {
  const meta = {
    email: email || null,
    signedInAt: new Date().toISOString(),
  };

  if (isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(token);
    fs.writeFileSync(authTokenFile(), encrypted);
  } else {
    console.warn('[CloudAuth] safeStorage unavailable; storing token in plain file');
    fs.writeFileSync(authTokenFile(), token, 'utf8');
  }

  fs.writeFileSync(authMetaFile(), JSON.stringify(meta), 'utf8');
}

function loadApiToken() {
  try {
    const tokenPath = authTokenFile();
    if (!fs.existsSync(tokenPath)) return null;

    const data = fs.readFileSync(tokenPath);
    if (isEncryptionAvailable()) {
      return safeStorage.decryptString(data);
    }
    return data.toString('utf8');
  } catch (err) {
    console.error('[CloudAuth] Failed to load API token:', err.message);
    return null;
  }
}

function loadAuthMeta() {
  try {
    if (!fs.existsSync(authMetaFile())) return null;
    return JSON.parse(fs.readFileSync(authMetaFile(), 'utf8'));
  } catch {
    return null;
  }
}

function clearAuth() {
  try {
    if (fs.existsSync(authTokenFile())) fs.unlinkSync(authTokenFile());
    if (fs.existsSync(authMetaFile())) fs.unlinkSync(authMetaFile());
  } catch (err) {
    console.error('[CloudAuth] Failed to clear auth:', err.message);
  }
}

function getCloudApiBaseUrl(config) {
  const base = config?.cloudApiBaseUrl;
  if (!base || typeof base !== 'string') return null;
  return base.replace(/\/$/, '');
}

async function cloudApiFetch(config, apiPath, options = {}) {
  const baseUrl = getCloudApiBaseUrl(config);
  if (!baseUrl) {
    throw new Error('cloudApiBaseUrl is not configured');
  }

  const token = loadApiToken();
  if (!token) {
    throw new Error('Not authenticated');
  }

  const url = `${baseUrl}${apiPath.startsWith('/') ? apiPath : `/${apiPath}`}`;
  const response = await axios({
    method: options.method || 'GET',
    url,
    data: options.body,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    timeout: options.timeout || 30000,
    validateStatus: () => true,
  });

  return response;
}

async function exchangeDesktopCode(config, code) {
  const baseUrl = getCloudApiBaseUrl(config);
  if (!baseUrl) {
    throw new Error('cloudApiBaseUrl is not configured');
  }

  const response = await axios.post(
    `${baseUrl}/api/auth/desktop-token`,
    { code },
    { timeout: 15000, validateStatus: () => true }
  );

  if (response.status !== 200 || !response.data?.token) {
    const message = response.data?.error || `Token exchange failed (${response.status})`;
    throw new Error(message);
  }

  return {
    token: response.data.token,
    email: response.data.email || null,
  };
}

async function pingCloudHealth(config) {
  const baseUrl = getCloudApiBaseUrl(config);
  if (!baseUrl) {
    return { ok: false, db: 'unconfigured' };
  }

  try {
    const response = await axios.get(`${baseUrl}/api/health`, { timeout: 8000 });
    return {
      ok: response.status === 200 && response.data?.ok === true,
      db: response.data?.db || 'unknown',
      status: response.status,
    };
  } catch {
    return { ok: false, db: 'unreachable' };
  }
}

function buildSignInUrl(config) {
  const baseUrl = getCloudApiBaseUrl(config);
  if (!baseUrl) return null;
  const callbackUrl = encodeURIComponent('/auth/desktop-callback');
  return `${baseUrl}/api/auth/signin/google?callbackUrl=${callbackUrl}`;
}

module.exports = {
  saveApiToken,
  loadApiToken,
  loadAuthMeta,
  clearAuth,
  getCloudApiBaseUrl,
  cloudApiFetch,
  exchangeDesktopCode,
  pingCloudHealth,
  buildSignInUrl,
};
