const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const axios = require('axios');

const authTokenFile = () => path.join(app.getPath('userData'), 'api-token.enc');
const authMetaFile = () => path.join(app.getPath('userData'), 'auth-meta.json');

const OAUTH_LOOPBACK_TIMEOUT_MS = 5 * 60 * 1000;
let activeOAuthServer = null;
let activeOAuthTimeout = null;

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

function stopOAuthLoopbackServer() {
  if (activeOAuthTimeout) {
    clearTimeout(activeOAuthTimeout);
    activeOAuthTimeout = null;
  }
  if (activeOAuthServer) {
    activeOAuthServer.close();
    activeOAuthServer = null;
  }
}

function startOAuthLoopbackServer() {
  stopOAuthLoopbackServer();

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
        if (requestUrl.pathname !== '/auth/callback') {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }

        const code = requestUrl.searchParams.get('code');
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Missing code');
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem">' +
          '<h1>Signed in to LinguaCoda</h1>' +
          '<p>You can close this tab and return to the desktop app.</p>' +
          '</body></html>'
        );

        if (server.oauthResolve) {
          server.oauthResolve(code);
        }
        stopOAuthLoopbackServer();
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Error');
      }
    });

    server.on('error', (err) => {
      stopOAuthLoopbackServer();
      reject(err);
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      if (!port) {
        stopOAuthLoopbackServer();
        reject(new Error('Could not start local OAuth server'));
        return;
      }

      const loopbackUrl = `http://127.0.0.1:${port}/auth/callback`;
      activeOAuthServer = server;

      const waitForCode = new Promise((resolveCode, rejectCode) => {
        server.oauthResolve = resolveCode;
        activeOAuthTimeout = setTimeout(() => {
          stopOAuthLoopbackServer();
          rejectCode(new Error('Sign-in timed out after 5 minutes'));
        }, OAUTH_LOOPBACK_TIMEOUT_MS);
      });

      console.log(`[CloudAuth] Listening for OAuth callback on ${loopbackUrl}`);
      resolve({ loopbackUrl, waitForCode });
    });
  });
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

function buildSignInUrl(config, loopbackUrl) {
  const baseUrl = getCloudApiBaseUrl(config);
  if (!baseUrl || !loopbackUrl) return null;

  const desktopCallback =
    `/auth/desktop-callback?redirect=${encodeURIComponent(loopbackUrl)}`;
  const callbackUrl = encodeURIComponent(desktopCallback);
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
  startOAuthLoopbackServer,
  stopOAuthLoopbackServer,
};
