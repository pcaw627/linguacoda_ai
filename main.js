const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const axios = require('axios');
const { pinyin } = require('pinyin-pro');

// Zoom level persistence
const zoomFile = path.join(__dirname, '.zoom-level');
const DEFAULT_ZOOM = 2; // ~1.5x (1.2^2 ≈ 1.44x)

function loadZoomLevel() {
  try {
    if (fs.existsSync(zoomFile)) {
      const val = parseFloat(fs.readFileSync(zoomFile, 'utf8').trim());
      if (!isNaN(val)) return val;
    }
  } catch (e) { /* ignore */ }
  return DEFAULT_ZOOM;
}
function saveZoomLevel(level) {
  try { fs.writeFileSync(zoomFile, String(level)); } catch (e) { /* ignore */ }
}

let mainWindow;
let pythonBackend = null;
let transcriptionServer = null;
const config = require('./electron-config.json');

// ─────────────────────────────────────────────────────────────────────────────
// Waiting-for-audio ping-pong animation
//
// The Python audio backend signals (via a JSON message on stdout) when it
// starts/stops seeing only silent buffers. While in that state we render a
// single-line ping-pong animation in the Electron main-process console so the
// user can tell the app is alive without scrollback being flooded by repeated
// "Buffer volume too low, skipping transcription" messages.
// ─────────────────────────────────────────────────────────────────────────────
const PING_PONG_TRACK_WIDTH = 14;
const PING_PONG_FRAME_MS = 80;
const WAITING_LABEL = '[AudioBackend] Waiting for audio activity...';

let waitingAnimationInterval = null;
let waitingAnimationActive = false;
let pingPongPos = 0;
let pingPongDir = 1;
let soundcardDiscontinuityWarningShown = false;

function clearWaitingLine() {
  // \r to start of line, blank out, \r again so the next write starts at col 0.
  // Do this even when Node doesn't report a TTY; Electron-launched processes in
  // Cursor/PowerShell can still render carriage-return updates correctly.
  const width = (process.stdout.columns || 120);
  process.stdout.write('\r' + ' '.repeat(Math.max(1, width - 1)) + '\r');
}

function renderPingPongTrack(pos) {
  let track = '';
  for (let i = 0; i < PING_PONG_TRACK_WIDTH; i++) {
    track += i === pos ? 'o' : '-';
  }
  return `[${track}]`;
}

function startWaitingForAudioAnimation() {
  if (waitingAnimationActive) return;
  waitingAnimationActive = true;

  pingPongPos = 0;
  pingPongDir = 1;
  waitingAnimationInterval = setInterval(() => {
    process.stdout.write(`\r${WAITING_LABEL} ${renderPingPongTrack(pingPongPos)}`);
    pingPongPos += pingPongDir;
    if (pingPongPos >= PING_PONG_TRACK_WIDTH - 1) {
      pingPongPos = PING_PONG_TRACK_WIDTH - 1;
      pingPongDir = -1;
    } else if (pingPongPos <= 0) {
      pingPongPos = 0;
      pingPongDir = 1;
    }
  }, PING_PONG_FRAME_MS);
}

function stopWaitingForAudioAnimation() {
  if (!waitingAnimationActive) return;
  waitingAnimationActive = false;
  if (waitingAnimationInterval) {
    clearInterval(waitingAnimationInterval);
    waitingAnimationInterval = null;
  }
  clearWaitingLine();
}

// Wrap console methods so other log lines (from the transcription server,
// IPC handlers, etc.) don't get clobbered by — or clobber — the animation.
// Each wrapped call clears the animation line, prints, and lets the next
// animation tick re-render the line.
const _origConsoleLog = console.log.bind(console);
const _origConsoleError = console.error.bind(console);
const _origConsoleWarn = console.warn.bind(console);

console.log = (...args) => {
  if (waitingAnimationActive) clearWaitingLine();
  _origConsoleLog(...args);
};
console.error = (...args) => {
  if (waitingAnimationActive) clearWaitingLine();
  _origConsoleError(...args);
};
console.warn = (...args) => {
  if (waitingAnimationActive) clearWaitingLine();
  _origConsoleWarn(...args);
};

// Create the main window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    titleBarStyle: 'hidden',
    frame: false,
    show: false
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    // Restore saved zoom level (default is 1.5x)
    const savedZoom = loadZoomLevel();
    mainWindow.webContents.setZoomLevel(savedZoom);
    mainWindow.show();
    console.log('Language Learning Assistant - Starting');
    console.log('='.repeat(60));
  });

  // Save zoom level whenever it changes
  mainWindow.webContents.on('zoom-changed', (event, direction) => {
    const currentZoom = mainWindow.webContents.getZoomLevel();
    saveZoomLevel(currentZoom);
  });

  mainWindow.on('close', () => {
    // Save zoom level before window closes
    if (mainWindow && mainWindow.webContents) {
      saveZoomLevel(mainWindow.webContents.getZoomLevel());
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Check if transcription server is running
async function checkTranscriptionServer() {
  try {
    const response = await axios.get('http://127.0.0.1:8765/health', {
      timeout: 1000
    });
    return response.status === 200;
  } catch (error) {
    return false;
  }
}

// Start transcription server
async function startTranscriptionServer() {
  // Always check if server is actually running via health check (most reliable)
  // This handles cases where:
  // - Another app instance started the server
  // - Server was started manually
  // - Server is running but we lost the process handle
  const serverRunning = await checkTranscriptionServer();
  if (serverRunning) {
    console.log('[TranscriptionServer] Server is already running, reusing existing instance');
    // Clear any stale process handle since we're using an existing server
    if (transcriptionServer) {
      transcriptionServer = null;
    }
    return true;
  }

  // If we have a process handle, check if it's still alive
  if (transcriptionServer) {
    // On Windows, we can't easily check if process is alive with kill(0)
    // So we'll just try to spawn and let the server handle port conflicts
    console.log('[TranscriptionServer] Stale process handle found, clearing it');
    transcriptionServer = null;
  }

  const serverScript = path.join(__dirname, 'transcription_server.py');
  console.log('[TranscriptionServer] Starting new server instance...');
  
  try {
    transcriptionServer = spawn('python', [serverScript], {
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (error) {
    console.error(`[TranscriptionServer] Failed to spawn server: ${error.message}`);
    transcriptionServer = null;
    return false;
  }

  // Forward stdout to console
  transcriptionServer.stdout.on('data', (data) => {
    const output = data.toString();
    const lines = output.split('\n');
    lines.forEach(line => {
      const trimmed = line.trim();
      if (trimmed) {
        // Check for token output
        if (trimmed.includes('TRANSCRIPTION_SERVER_TOKEN=')) {
          const token = trimmed.match(/TRANSCRIPTION_SERVER_TOKEN=(.+)/)?.[1];
          if (token) {
            console.log(`[TranscriptionServer] Token: ${token.substring(0, 20)}...`);
          }
        } else {
          console.log(`[TranscriptionServer] ${trimmed}`);
        }
      }
    });
  });

  // Forward stderr to console
  transcriptionServer.stderr.on('data', (data) => {
    const output = data.toString();
    const lines = output.split('\n');
    lines.forEach(line => {
      const trimmed = line.trim();
      if (trimmed) {
        console.log(`[TranscriptionServer] ${trimmed}`);
      }
    });
  });

  transcriptionServer.on('close', async (code) => {
    console.log(`[TranscriptionServer] Process exited with code ${code}`);
    const wasOurProcess = transcriptionServer !== null;
    transcriptionServer = null;
    
    // Exit code 0 usually means:
    // - Normal shutdown (app closing)
    // - Port already in use (another server running)
    if (code === 0) {
      // Verify if server is actually running (port conflict case)
      const isRunning = await checkTranscriptionServer();
      if (isRunning) {
        console.log('[TranscriptionServer] Server is running in another instance, will reuse it');
      } else {
        console.log('[TranscriptionServer] Server exited normally');
      }
      return;
    }
    
    // If server crashed unexpectedly (non-zero exit), try to restart it
    // But only if we were managing this process
    if (code !== 0 && code !== null && wasOurProcess) {
      console.log('[TranscriptionServer] Server crashed unexpectedly, attempting to restart in 2 seconds...');
      setTimeout(async () => {
        // Check if server is running (maybe another instance started it)
        const isRunning = await checkTranscriptionServer();
        if (!isRunning) {
          console.log('[TranscriptionServer] Restarting server...');
          await startTranscriptionServer();
        } else {
          console.log('[TranscriptionServer] Server is now running (possibly started by another instance)');
        }
      }, 2000);
    }
  });

  transcriptionServer.on('error', (error) => {
    console.error(`[TranscriptionServer] Failed to start: ${error.message}`);
    transcriptionServer = null;
  });
  
  return true;
}

// Start Python backend
function startPythonBackend() {
  const pythonScript = path.join(__dirname, 'electron_backend.py');
  pythonBackend = spawn('python', [pythonScript], {
    cwd: __dirname,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  pythonBackend.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach(line => {
      const message = line.trim();
      if (message) {
        try {
          const json = JSON.parse(message);
          if (json.type === 'transcription') {
            mainWindow.webContents.send('transcription-result', json.data);
          } else if (json.type === 'error') {
            mainWindow.webContents.send('error', json.data);
          } else if (json.type === 'audio-devices') {
            mainWindow.webContents.send('audio-devices', json.data);
          } else if (json.type === 'status') {
            // Status updates
          } else if (json.type === 'log') {
            // Routine audio-backend log lines — label them so they're
            // visually distinct from the generic stderr 'Python Error:'
            // stream and from the transcription server's own logs.
            console.log(`[AudioBackend] ${json.data}`);
          } else if (json.type === 'waiting-for-audio') {
            if (json.data === true) {
              startWaitingForAudioAnimation();
            } else {
              stopWaitingForAudioAnimation();
            }
          }
        } catch (e) {
          // Not JSON, might be regular print output
          if (message && !message.startsWith('{')) {
            console.log('Python:', message);
          }
        }
      }
    });
  });

  pythonBackend.stderr.on('data', (data) => {
    const message = data.toString();
    if (message.includes('SoundcardRuntimeWarning: data discontinuity in recording')) {
      if (!soundcardDiscontinuityWarningShown) {
        soundcardDiscontinuityWarningShown = true;
        console.warn('[AudioBackend] Soundcard warning: audio capture reported a brief data discontinuity; continuing capture.');
      }
      return;
    }
    console.error('Python Error:', message);
  });

  pythonBackend.on('close', (code) => {
    stopWaitingForAudioAnimation();
    console.log(`Python backend exited with code ${code}`);
  });
}

// IPC Handlers
ipcMain.handle('get-config', () => {
  return config;
});

ipcMain.handle('start-capture', async (event, deviceId, deviceType) => {
  if (pythonBackend && pythonBackend.stdin.writable) {
    pythonBackend.stdin.write(JSON.stringify({ action: 'start', deviceId, deviceType }) + '\n');
    return { success: true };
  }
  return { success: false, error: 'Backend not ready' };
});

ipcMain.handle('stop-capture', async () => {
  if (pythonBackend && pythonBackend.stdin.writable) {
    pythonBackend.stdin.write(JSON.stringify({ action: 'stop' }) + '\n');
    return { success: true };
  }
  return { success: false, error: 'Backend not ready' };
});

ipcMain.handle('get-audio-devices', async (event, forceRefresh = false) => {
  if (pythonBackend && pythonBackend.stdin.writable) {
    pythonBackend.stdin.write(JSON.stringify({ action: 'get-devices', forceRefresh }) + '\n');
    return { success: true };
  }
  return { success: false, error: 'Backend not ready' };
});

ipcMain.handle('save-device-selection', async (event, deviceId, deviceType) => {
  if (pythonBackend && pythonBackend.stdin.writable) {
    pythonBackend.stdin.write(JSON.stringify({ action: 'save-device-selection', deviceId, deviceType }) + '\n');
    return { success: true };
  }
  return { success: false, error: 'Backend not ready' };
});

function formatOllamaError(error) {
  if (error.code === 'ECONNREFUSED') {
    return `Ollama is not running at ${config.ollamaEndpoint}. Start Ollama and try again.`;
  }
  if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
    return `Timed out connecting to Ollama at ${config.ollamaEndpoint}.`;
  }
  if (error.response) {
    return `Ollama returned HTTP ${error.response.status}: ${error.response.statusText || 'request failed'}`;
  }
  return error.message || 'Ollama request failed';
}

// Best-effort extraction of a JSON object from arbitrary model output. We do not
// trust the model to return clean JSON, so if a direct parse fails we grab the
// substring between the first '{' and the last '}' and try parsing that.
function extractJsonObject(text) {
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch (_) { /* fall through to brace slicing */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch (_) { return null; }
}

// Trim an English definition to at most `max` words.
function capWords(str, max) {
  const words = String(str).split(/\s+/).filter(Boolean);
  return words.slice(0, max).join(' ');
}

// Normalize a pinyin string for the flashcards: drop any parenthetical notes
// (both ASCII and full-width parentheses) and the literal "with tone marks"
// placeholder the model sometimes echoes from the prompt.
function cleanPinyin(str) {
  return String(str)
    .replace(/[\(（][^\)）]*[\)）]/g, ' ') // remove (...) and （...）
    .replace(/with tone marks/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

ipcMain.handle('translate-text', async (event, text) => {
  try {
    const response = await axios.post(`${config.ollamaEndpoint}/api/generate`, {
      model: config.ollamaModel,
      prompt: `Translate the following text to English. Only provide the translation, no explanations:\n\n${text}`,
      stream: false
    });
    
    if (response.data && response.data.response) {
      return { success: true, translation: response.data.response.trim() };
    }
    return { success: false, error: 'No translation received' };
  } catch (error) {
    const message = formatOllamaError(error);
    console.error(`Translation error: ${message}`);
    return { success: false, error: message };
  }
});

// --- Semantic unit alignment (SimAlign via transcription server) ---

const TRANSCRIPTION_SERVER_URL = 'http://127.0.0.1:8765';
const TRANSCRIPTION_SERVER_TOKEN_FILE = path.join(__dirname, '.transcription_server.token');
// First /align after a cold start can block on XLM-R load; allow plenty of time.
const ALIGN_REQUEST_TIMEOUT_MS = 120000;

function loadTranscriptionServerToken() {
  try {
    if (fs.existsSync(TRANSCRIPTION_SERVER_TOKEN_FILE)) {
      const token = fs.readFileSync(TRANSCRIPTION_SERVER_TOKEN_FILE, 'utf8').trim();
      if (token) return token;
    }
  } catch (e) { /* ignore */ }
  return null;
}

function formatAlignError(error) {
  if (error.code === 'ECONNREFUSED') {
    return 'Transcription/alignment server is not running. Restart the app and try again.';
  }
  if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
    return 'Alignment request timed out (the SimAlign model may still be loading). Try again in a moment.';
  }
  if (error.response) {
    const body = error.response.data;
    const detail = (body && (body.error || body.message)) || error.response.statusText;
    return `Alignment server returned HTTP ${error.response.status}: ${detail || 'request failed'}`;
  }
  return error.message || 'Alignment request failed';
}

ipcMain.handle('extract-semantic-units', async (event, transcription, translation) => {
  try {
    const token = loadTranscriptionServerToken();
    if (!token) {
      return {
        success: false,
        error: 'Alignment server token not found. Wait for the transcription server to finish starting, then try again.'
      };
    }

    console.log('[SemanticUnits] Aligning via SimAlign (pkuseg + XLM-R)…');
    const response = await axios.post(
      `${TRANSCRIPTION_SERVER_URL}/align`,
      { transcription, translation },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: ALIGN_REQUEST_TIMEOUT_MS
      }
    );

    const data = response.data;
    if (!data || !Array.isArray(data.transcriptionChunks) || !Array.isArray(data.translationChunks)) {
      throw new Error('Alignment server returned an invalid response');
    }

    const correlations = Array.isArray(data.correlations) ? data.correlations : [];
    console.log(
      `[SemanticUnits] Aligned: ${data.transcriptionChunks.length} transcription chunks, ` +
      `${data.translationChunks.length} translation chunks, ` +
      `${correlations.filter(c => c.matches && c.matches.length > 0).length} with matches`
    );

    return {
      success: true,
      transcriptionChunks: data.transcriptionChunks,
      translationChunks: data.translationChunks,
      correlations
    };
  } catch (error) {
    const message = formatAlignError(error);
    console.error('Semantic unit alignment error:', message);
    return { success: false, error: message };
  }
});

// Report transcription service readiness so the renderer can show a
// "Loading..." badge until the SenseVoice model has finished initializing
// (i.e. until the server logs "Transcription service ready").
ipcMain.handle('get-transcription-status', async () => {
  try {
    const response = await axios.get('http://127.0.0.1:8765/health', { timeout: 1500 });
    if (response.status === 200 && response.data) {
      return {
        success: true,
        ready: !!response.data.ready,
        alignerReady: !!response.data.alignerReady
      };
    }
    return { success: false, ready: false };
  } catch (error) {
    return { success: false, ready: false };
  }
});

// Load HSK dictionary from local JSON file
ipcMain.handle('get-hsk-dictionary', async () => {
  try {
    const dictPath = path.join(__dirname, 'hsk_dictionary.json');
    const raw = fs.readFileSync(dictPath, 'utf8');
    const dict = JSON.parse(raw);
    return { success: true, words: dict.words || {} };
  } catch (error) {
    console.error('Failed to load HSK dictionary:', error);
    return { success: false, error: error.message };
  }
});

// Convert a Chinese word/text to pinyin (with tone marks)
ipcMain.handle('get-pinyin', async (event, text) => {
  try {
    if (!text || typeof text !== 'string') {
      return { success: false, error: 'invalid text' };
    }
    const result = pinyin(text, { toneType: 'symbol', type: 'string', nonZh: 'consecutive' });
    return { success: true, pinyin: result };
  } catch (error) {
    console.error('Pinyin conversion error:', error);
    return { success: false, error: error.message };
  }
});

// Generate vocab context via Ollama
ipcMain.handle('generate-vocab-context', async (event, word) => {
  try {
    const response = await axios.post(`${config.ollamaEndpoint}/api/generate`, {
      model: config.ollamaModel,
      prompt: `Give a brief example (under 100 words) of how the Chinese word "${word}" is used in context. Include one or two short example sentences in Chinese with English translations. Be concise.`,
      stream: false
    });

    if (response.data && response.data.response) {
      return { success: true, context: response.data.response.trim() };
    }
    return { success: false, error: 'No response received' };
  } catch (error) {
    console.error('Vocab context generation error:', error);
    return { success: false, error: error.message };
  }
});

// Generate a structured flashcard dictionary entry via Ollama. Returns the
// many-to-many (pinyin, meaning) entries for a single Chinese word so the
// flashcards matching game can pair characters/pinyin/meanings unambiguously.
ipcMain.handle('get-flashcard-entry', async (event, word) => {
  try {
    if (!word || typeof word !== 'string') {
      return { success: false, error: 'invalid word' };
    }

    const prompt = `You are a Chinese-English dictionary. For the Chinese word "${word}", list every distinct pronunciation together with its meaning. Respond with ONLY a single JSON object and nothing else: no greeting, no explanation, no markdown, no text before or after it. Use exactly this shape: {"entries":[{"pinyin":"pin yin with tone marks","meaning":"very brief English definition"}]}. Each meaning must be at most 5 words. Include one array item per distinct pronunciation/meaning.`;

    const response = await axios.post(`${config.ollamaEndpoint}/api/generate`, {
      model: config.ollamaModel,
      prompt,
      stream: false,
      format: 'json'
    });

    const raw = response.data && response.data.response;
    if (!raw) return { success: false, error: 'No response received' };

    const parsed = extractJsonObject(raw);
    if (!parsed) return { success: false, error: 'Could not parse JSON from model output' };

    const rawEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
    const entries = rawEntries
      .map(e => ({
        pinyin: e && typeof e.pinyin === 'string' ? cleanPinyin(e.pinyin) : '',
        meaning: e && typeof e.meaning === 'string' ? capWords(e.meaning.trim(), 5) : ''
      }))
      .filter(e => e.pinyin || e.meaning);

    if (entries.length === 0) return { success: false, error: 'No entries returned' };
    return { success: true, entries };
  } catch (error) {
    console.error('Flashcard entry generation error:', error);
    return { success: false, error: formatOllamaError(error) };
  }
});

ipcMain.handle('set-volume-threshold', async (event, threshold) => {
  if (pythonBackend && pythonBackend.stdin.writable) {
    pythonBackend.stdin.write(JSON.stringify({ action: 'set-threshold', threshold }) + '\n');
    return { success: true };
  }
  return { success: false };
});

ipcMain.handle('zoom-in', () => {
  if (mainWindow) {
    const current = mainWindow.webContents.getZoomLevel();
    const next = Math.min(current + 0.5, 9);
    mainWindow.webContents.setZoomLevel(next);
    saveZoomLevel(next);
  }
});

ipcMain.handle('zoom-out', () => {
  if (mainWindow) {
    const current = mainWindow.webContents.getZoomLevel();
    const next = Math.max(current - 0.5, -4);
    mainWindow.webContents.setZoomLevel(next);
    saveZoomLevel(next);
  }
});

ipcMain.handle('zoom-reset', () => {
  if (mainWindow) {
    mainWindow.webContents.setZoomLevel(DEFAULT_ZOOM);
    saveZoomLevel(DEFAULT_ZOOM);
  }
});

ipcMain.handle('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.handle('window-close', () => {
  if (mainWindow) mainWindow.close();
});

// App lifecycle
app.whenReady().then(async () => {
  createWindow();

  // Set up application menu with zoom accelerators (works even with frame:false)
  const menuTemplate = [
    {
      label: 'View',
      submenu: [
        {
          label: 'Zoom In',
          accelerator: 'CommandOrControl+=',
          click: () => {
            if (mainWindow) {
              const current = mainWindow.webContents.getZoomLevel();
              const next = Math.min(current + 0.5, 9);
              mainWindow.webContents.setZoomLevel(next);
              saveZoomLevel(next);
            }
          }
        },
        {
          label: 'Zoom In',
          accelerator: 'CommandOrControl+Plus',
          visible: false,
          click: () => {
            if (mainWindow) {
              const current = mainWindow.webContents.getZoomLevel();
              const next = Math.min(current + 0.5, 9);
              mainWindow.webContents.setZoomLevel(next);
              saveZoomLevel(next);
            }
          }
        },
        {
          label: 'Zoom Out',
          accelerator: 'CommandOrControl+-',
          click: () => {
            if (mainWindow) {
              const current = mainWindow.webContents.getZoomLevel();
              const next = Math.max(current - 0.5, -4);
              mainWindow.webContents.setZoomLevel(next);
              saveZoomLevel(next);
            }
          }
        },
        {
          label: 'Reset Zoom',
          accelerator: 'CommandOrControl+0',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.setZoomLevel(DEFAULT_ZOOM);
              saveZoomLevel(DEFAULT_ZOOM);
            }
          }
        },
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  // Start the audio backend right away (it loads the cached device list and
  // connects to the transcription server lazily, retrying until it's up). This
  // runs concurrently with bringing the transcription server online below so
  // device enumeration isn't blocked behind the server's health check.
  startPythonBackend();

  // Bring up the transcription server in parallel. The server binds its HTTP
  // port immediately and loads the SenseVoice model + pkuseg/SimAlign aligner
  // on background threads, so /health responds well before the models finish.
  (async () => {
    const serverRunning = await checkTranscriptionServer();
    if (!serverRunning) {
      console.log('[TranscriptionServer] Server not running, starting it...');
      await startTranscriptionServer();
      // Wait a moment for server to start and verify it's running
      let attempts = 0;
      while (attempts < 10) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const isRunning = await checkTranscriptionServer();
        if (isRunning) {
          console.log('[TranscriptionServer] Server started successfully');
          break;
        }
        attempts++;
      }
      if (attempts >= 10) {
        console.warn('[TranscriptionServer] Server may not have started properly, but continuing...');
      }
    } else {
      console.log('[TranscriptionServer] Server already running, connecting to existing instance...');
    }
  })();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (pythonBackend) {
    pythonBackend.kill();
  }
  // Only kill transcription server if we started it (have process handle)
  // If server was started by another instance, leave it running
  if (transcriptionServer && !transcriptionServer.killed) {
    console.log('[TranscriptionServer] Stopping server (app closing)');
    transcriptionServer.kill();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (pythonBackend) {
    pythonBackend.kill();
  }
  // Only kill transcription server if we started it (have process handle)
  if (transcriptionServer && !transcriptionServer.killed) {
    console.log('[TranscriptionServer] Stopping server (app quitting)');
    transcriptionServer.kill();
  }
});
