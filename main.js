const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');

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
    mainWindow.show();
    console.log('Language Learning Assistant - Starting');
    console.log('='.repeat(60));
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
    console.error('Translation error:', error);
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
