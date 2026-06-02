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
    console.error('Python Error:', data.toString());
  });

  pythonBackend.on('close', (code) => {
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

// --- Helpers for semantic unit extraction ---

async function callOllama(prompt) {
  const response = await axios.post(`${config.ollamaEndpoint}/api/generate`, {
    model: config.ollamaModel,
    prompt: prompt,
    stream: false
  });
  if (response.data && response.data.response) {
    return response.data.response.trim();
  }
  throw new Error('No response from Ollama');
}

function extractJsonFromLLM(text) {
  let jsonText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[0]);
  }
  throw new Error('No valid JSON found in LLM response');
}

// --- Semantic unit extraction: tokenize → correlate with retry ---

ipcMain.handle('extract-semantic-units', async (event, transcription, translation) => {
  try {
    // ── Phase 1: Tokenize both sentences into meaningful chunks with unique IDs ──
    const tokenizePrompt = `Tokenize these two sentences into meaningful chunks. Each chunk should represent a single distinct meaning that could be individually translated as a word or short phrase (e.g., "book", "on time", "have been").

Rules:
- Assign unique IDs: "t1", "t2", ... for Sentence 1 and "e1", "e2", ... for Sentence 2
- Each occurrence of a repeated word must be a SEPARATE chunk with its own unique ID
- Do NOT include parenthetical clarifiers or tags like "(referring to X)" as part of any chunk — strip them out entirely
- Chunks must be in sentence order and should cover all meaningful content
- Output ONLY valid JSON, no other text

Sentence 1: ${transcription}
Sentence 2: ${translation}

Required JSON format:
{"sentence1": [{"id": "t1", "text": "..."}, {"id": "t2", "text": "..."}], "sentence2": [{"id": "e1", "text": "..."}, {"id": "e2", "text": "..."}]}`;

    console.log('[SemanticUnits] Phase 1 — tokenizing…');
    const tokenResponse = await callOllama(tokenizePrompt);
    const tokenData = extractJsonFromLLM(tokenResponse);

    const transcriptionChunks = tokenData.sentence1 || [];
    const translationChunks  = tokenData.sentence2 || [];

    if (transcriptionChunks.length === 0 || translationChunks.length === 0) {
      throw new Error('Tokenization returned empty chunks');
    }

    console.log(`[SemanticUnits] Tokenized: ${transcriptionChunks.length} transcription chunks, ${translationChunks.length} translation chunks`);

    // ── Phase 2: Correlate chunks (with retry for uncovered IDs) ──
    const allTranscriptionIds = transcriptionChunks.map(c => c.id);
    let correlations = [];
    let attemptedIds = new Set();
    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const uncorrelatedIds = allTranscriptionIds.filter(id => !attemptedIds.has(id));
      if (uncorrelatedIds.length === 0) break;

      const isRetry = attempt > 0;
      const focusClause = isRetry
        ? `\nIMPORTANT: The following Sentence 1 chunk IDs were NOT included in your previous response. You MUST provide a correlation entry (with a match or null) for each of these IDs: ${uncorrelatedIds.join(', ')}`
        : '';

      const correlatePrompt = `Given these tokenized chunks from two sentences that are translations of each other, find the meaning correlation between chunks.

Sentence 1 chunks: ${JSON.stringify(transcriptionChunks)}
Sentence 2 chunks: ${JSON.stringify(translationChunks)}${focusClause}

Rules:
- For EVERY Sentence 1 chunk, provide the ID of the best-matching Sentence 2 chunk, or null if there is no equivalent
- Every Sentence 1 chunk ID must appear exactly once in your response
- If a word appears multiple times, each occurrence (with its own unique ID) may map to a different Sentence 2 chunk
- Output ONLY valid JSON, no other text

Required JSON format:
{"correlations": [{"id": "t1", "match": "e1"}, {"id": "t2", "match": null}]}`;

      console.log(`[SemanticUnits] Phase 2 — correlation attempt ${attempt + 1}, ${uncorrelatedIds.length} IDs remaining…`);
      const correlateResponse = await callOllama(correlatePrompt);
      const correlateData = extractJsonFromLLM(correlateResponse);
      const newCorrelations = correlateData.correlations || [];

      for (const corr of newCorrelations) {
        if (corr && corr.id && !attemptedIds.has(corr.id)) {
          attemptedIds.add(corr.id);
          correlations.push(corr);
        }
      }

      console.log(`[SemanticUnits] After attempt ${attempt + 1}: ${attemptedIds.size}/${allTranscriptionIds.length} IDs covered`);

      if (allTranscriptionIds.every(id => attemptedIds.has(id))) {
        break;
      }
    }

    return {
      success: true,
      transcriptionChunks,
      translationChunks,
      correlations
    };
  } catch (error) {
    console.error('Semantic unit extraction error:', error);
    return { success: false, error: error.message };
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
  
  // Check if transcription server is already running
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
  
  startPythonBackend();

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
