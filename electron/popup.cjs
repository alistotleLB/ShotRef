/* ShotRef's own message boxes for the desktop app, in place of Windows' native ones (which look like Windows, not ShotRef,
 * and play the system sound). Each box is a small frameless window that loads popup.html; nothing here touches the page.
 *
 * show(parent, opts) takes the same options as dialog.showMessageBox, plus two of its own:
 *   { type, title, message, detail, buttons, defaultId, cancelId, notes: [{ version, items: [text] }], width }
 * and resolves to { response } (the button index). Esc, the window's close and Alt+F4 answer cancelId.
 * Boxes never overlap: a second one waits until the first is answered.
 * Tests replace global.__shotrefPopup.show (see test/desktop.cjs); callers always go through popup.show so the stub is used. */
const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ICON = path.join(__dirname, '..', 'branding', 'shotref.ico');
const open = new Map(); /* webContents id -> { opts, win, finish } */

const str = (v, n) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, n);
function clean(o) {
  o = o && typeof o === 'object' ? o : {};
  const buttons = (Array.isArray(o.buttons) && o.buttons.length ? o.buttons : ['OK']).slice(0, 4).map(b => str(b, 40));
  const idx = (v, d) => (Number.isInteger(v) && v >= 0 && v < buttons.length ? v : d);
  const notes = Array.isArray(o.notes) ? o.notes.slice(0, 40).map(n => ({
    version: str(n && n.version, 20),
    items: (Array.isArray(n && n.items) ? n.items : []).slice(0, 20).map(i => str(i, 400)),
  })) : [];
  return {
    type: ['info', 'warning', 'error', 'question', 'none'].includes(o.type) ? o.type : 'info',
    title: str(o.title || 'ShotRef', 80), message: str(o.message, 300), detail: str(o.detail, 1200),
    buttons, defaultId: idx(o.defaultId, 0), cancelId: idx(o.cancelId, buttons.length - 1), notes,
    width: Math.max(360, Math.min(620, +o.width || (notes.length ? 520 : 440))),
  };
}

function openBox(parent, raw) {
  const opts = clean(raw);
  return new Promise(resolve => {
    const owner = parent && !parent.isDestroyed() ? parent : null;
    const win = new BrowserWindow({
      parent: owner || undefined, modal: !!owner, width: opts.width, height: 200, useContentSize: true, show: false,
      frame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: !!owner,
      backgroundColor: '#1b1d21', title: opts.title, icon: ICON,
      webPreferences: { preload: path.join(__dirname, 'popup-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
    });
    const id = win.webContents.id;
    let done = false;
    const finish = n => {
      if (done) return; done = true; open.delete(id);
      if (!win.isDestroyed()) win.destroy();
      if (owner && !owner.isDestroyed()) owner.focus();
      resolve({ response: Number.isInteger(n) && n >= 0 && n < opts.buttons.length ? n : opts.cancelId });
    };
    open.set(id, { opts, win, finish });
    win.on('closed', () => finish(opts.cancelId));
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('render-process-gone', () => finish(opts.cancelId));
    win.setMenu(null);
    win.loadFile(path.join(__dirname, 'popup.html')).catch(e => { console.error('ShotRef: popup failed to load', e); finish(opts.cancelId); });
  });
}

ipcMain.on('shotref-popup:opts', e => { const b = open.get(e.sender.id); e.returnValue = b ? b.opts : null; });
/* the page measured itself: fit the window to it (capped to the screen work area), centre it on its owner, then show it */
ipcMain.on('shotref-popup:ready', (e, h) => {
  const b = open.get(e.sender.id); if (!b || b.win.isDestroyed()) return;
  const { screen } = require('electron');
  const area = screen.getDisplayMatching(b.win.getBounds()).workArea;
  b.win.setContentSize(b.opts.width, Math.max(120, Math.min(Math.round(+h) || 200, area.height - 80)));
  const p = b.win.getParentWindow();
  if (p && !p.isDestroyed()) {
    const pb = p.getBounds(), wb = b.win.getBounds();
    b.win.setPosition(Math.round(pb.x + (pb.width - wb.width) / 2), Math.round(pb.y + Math.max(40, (pb.height - wb.height) / 3)));
  } else b.win.center();
  b.win.show();
});
ipcMain.on('shotref-popup:answer', (e, n) => { const b = open.get(e.sender.id); if (b) b.finish(n); });

let chain = Promise.resolve();
const popup = {
  show(parent, opts) {
    const run = chain.then(() => openBox(parent, opts));
    chain = run.catch(() => {});
    return run;
  },
  openCount: () => open.size, /* for tests */
};
global.__shotrefPopup = popup;
module.exports = popup;
