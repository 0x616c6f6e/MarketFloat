const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('marketFloat', {
  snapshot: () => ipcRenderer.invoke('snapshot'),
  subscribe: callback => ipcRenderer.on('state', (_event, data) => callback(data)),
  add: (market, code) => ipcRenderer.invoke('add', market, code),
  quoteMenu: key => ipcRenderer.send('quote-menu', key),
  setting: (key, value) => ipcRenderer.send('setting', key, value),
  refresh: () => ipcRenderer.send('refresh'),
  collapse: () => ipcRenderer.send('collapse'),
  hide: () => ipcRenderer.send('hide'),
  orbOpen: () => ipcRenderer.send('orb-open'),
  orbMenu: () => ipcRenderer.send('orb-menu'),
  orbDown: (x, y) => ipcRenderer.send('orb-down', x, y),
  orbMove: () => ipcRenderer.send('orb-move'),
  orbUp: moved => ipcRenderer.send('orb-up', moved),
});
