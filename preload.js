const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Zoom
  zoomIn: () => ipcRenderer.invoke('zoom-in'),
  zoomOut: () => ipcRenderer.invoke('zoom-out'),
  zoomReset: () => ipcRenderer.invoke('zoom-reset'),

  getConfig: () => ipcRenderer.invoke('get-config'),
  startCapture: (deviceId, deviceType) => ipcRenderer.invoke('start-capture', deviceId, deviceType),
  stopCapture: () => ipcRenderer.invoke('stop-capture'),
  getAudioDevices: (forceRefresh = false) => ipcRenderer.invoke('get-audio-devices', forceRefresh),
  saveDeviceSelection: (deviceId, deviceType) => ipcRenderer.invoke('save-device-selection', deviceId, deviceType),
  translateText: (text) => ipcRenderer.invoke('translate-text', text),
  extractSemanticUnits: (transcription, translation) => ipcRenderer.invoke('extract-semantic-units', transcription, translation),
  setVolumeThreshold: (threshold) => ipcRenderer.invoke('set-volume-threshold', threshold),
  getHskDictionary: () => ipcRenderer.invoke('get-hsk-dictionary'),
  getTranscriptionStatus: () => ipcRenderer.invoke('get-transcription-status'),
  getPinyin: (text) => ipcRenderer.invoke('get-pinyin', text),
  getPinyinBatch: (words) => ipcRenderer.invoke('get-pinyin-batch', words),
  generateVocabContext: (word) => ipcRenderer.invoke('generate-vocab-context', word),
  getFlashcardEntry: (word) => ipcRenderer.invoke('get-flashcard-entry', word),
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),
  
  // Listeners
  onTranscriptionResult: (callback) => {
    ipcRenderer.on('transcription-result', (event, data) => callback(data));
  },
  onError: (callback) => {
    ipcRenderer.on('error', (event, error) => callback(error));
  },
  onAudioDevices: (callback) => {
    ipcRenderer.on('audio-devices', (event, devices) => callback(devices));
  },
  
  // Remove listeners
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  }
});
