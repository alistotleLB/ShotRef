/* Exposes window.shotrefDesktop (contract: top of src/platform.js). Only plain data crosses: strings and ArrayBuffers. */
const { contextBridge, ipcRenderer } = require('electron');

/* events can arrive before the page has registered its callback: queue them, then replay in order */
function channel(name) {
  let cb = null; const queue = [];
  ipcRenderer.on(name, (e, v) => { if (cb) cb(v); else queue.push(v); });
  return fn => { if (typeof fn !== 'function') return; cb = fn; while (queue.length) fn(queue.shift()); };
}
const onMenu = channel('shotref:menu');
const onOpenFile = channel('shotref:open-file');

contextBridge.exposeInMainWorld('shotrefDesktop', {
  version: String(ipcRenderer.sendSync('shotref:version-sync')),
  saveBlob: (name, data, filters) => ipcRenderer.invoke('shotref:save-blob', String(name), data, filters),
  saveProject: (text, opts) => ipcRenderer.invoke('shotref:save-project', String(text), {
    saveAs: !!(opts && opts.saveAs),
    path: opts && typeof opts.path === 'string' ? opts.path : null,
    name: opts && typeof opts.name === 'string' ? opts.name : null,
  }),
  openProject: () => ipcRenderer.invoke('shotref:open-project'),
  setTitle: t => ipcRenderer.send('shotref:set-title', String(t)),
  onMenu, onOpenFile,
  closeOk: () => ipcRenderer.send('shotref:close-ok'),
});
