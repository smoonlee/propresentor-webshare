const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Live capture control
  startCapture: (webContentsId) => ipcRenderer.send('start-capture', webContentsId),
  stopCapture: () => ipcRenderer.send('stop-capture'),

  // Viewer count
  getViewerCount: () => ipcRenderer.invoke('get-viewer-count'),

  // Server port & LAN IP
  getPort: () => ipcRenderer.invoke('get-port'),
  getLanIp: () => ipcRenderer.invoke('get-lan-ip'),

  // Get webview preload path
  getWebviewPreload: () => ipcRenderer.invoke('get-webview-preload'),

  // Open in default browser
  openExternal: (url) => ipcRenderer.send('open-external', url),

  // Always-on-top
  toggleAlwaysOnTop: () => ipcRenderer.send('toggle-always-on-top'),
  getAlwaysOnTop: () => ipcRenderer.invoke('get-always-on-top'),
  onAlwaysOnTopChanged: (cb) => {
    ipcRenderer.on('always-on-top-changed', (_e, val) => cb(val));
  },

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  getDefaults: () => ipcRenderer.invoke('get-defaults'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  applySettings: (s) => ipcRenderer.send('apply-settings', s),
  onToggleSettings: (cb) => {
    ipcRenderer.on('toggle-settings', () => cb());
  },
  onSettingsChanged: (cb) => {
    ipcRenderer.on('settings-changed', (_e, val) => cb(val));
  },

  // Diagnostics
  getDiagnostics: () => ipcRenderer.invoke('get-diagnostics'),
});
