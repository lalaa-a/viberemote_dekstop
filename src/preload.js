const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('relay', {
  getMachineConfig: () => ipcRenderer.invoke('relay:getMachineConfig'),
  writeMachineConfig: (vars) => ipcRenderer.invoke('relay:writeMachineConfig', vars),
  getHookStatus: () => ipcRenderer.invoke('relay:getHookStatus'),
  setHookEnabled: (enable) => ipcRenderer.invoke('relay:setHookEnabled', enable),
  getHostname: () => ipcRenderer.invoke('system:getHostname'),
});

contextBridge.exposeInMainWorld('windowControls', {
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onMaximizeChange: (cb) => {
    ipcRenderer.on('window:maximizeChange', (_, val) => cb(val));
  },
});
