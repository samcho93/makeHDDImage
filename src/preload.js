'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const fn = (_e, data) => cb(data);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('api', {
  envInfo: () => ipcRenderer.invoke('env:info'),
  relaunchAdmin: () => ipcRenderer.invoke('env:relaunchAdmin'),
  listDisks: () => ipcRenderer.invoke('disks:list'),
  chooseOutput: (args) => ipcRenderer.invoke('out:choose', args),
  inspectOutput: (args) => ipcRenderer.invoke('out:inspect', args),
  start: (opts) => ipcRenderer.invoke('image:start', opts),
  cancel: () => ipcRenderer.invoke('image:cancel'),
  showInFolder: (p) => ipcRenderer.invoke('shell:show', p),
  onLog: on('image:log'),
  onProgress: on('image:progress'),
  onDone: on('image:done'),
  onError: on('image:error'),
  onCancelled: on('image:cancelled'),
});
