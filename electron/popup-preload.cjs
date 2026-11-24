/* Bridge for popup.html (see popup.cjs): the box's options in, one answer (and the measured height) out. Plain data only. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shotrefPopup', {
  opts: ipcRenderer.sendSync('shotref-popup:opts'),
  ready: h => ipcRenderer.send('shotref-popup:ready', Number(h) || 0),
  answer: n => ipcRenderer.send('shotref-popup:answer', Number(n)),
});
