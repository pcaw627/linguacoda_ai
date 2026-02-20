const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  startCapture: (deviceId, deviceType) => ipcRenderer.invoke('start-capture', deviceId, deviceType),
  stopCapture: () => ipcRenderer.invoke('stop-capture'),
  getAudioDevices: (forceRefresh = false) => ipcRenderer.invoke('get-audio-devices', forceRefresh),
  saveDeviceSelection: (deviceId, deviceType) => ipcRenderer.invoke('save-device-selection', deviceId, deviceType),
  translateText: (text) => ipcRenderer.invoke('translate-text', text),
  setVolumeThreshold: (threshold) => ipcRenderer.invoke('set-volume-threshold', threshold),
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
