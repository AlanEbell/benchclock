'use strict';
// The only bridge between the window and the rest of the computer. The page itself
// runs sandboxed, with no access to files or Node.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('timecard', {
  call: (method, payload) => ipcRenderer.invoke('api', method, payload),
  pathForFile: (file) => webUtils.getPathForFile(file), // for photos dropped onto the window
});
