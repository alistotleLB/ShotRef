/* ShotRef desktop shell. Loads the same dist/ShotRef.html as the web build; the page only talks to this file through preload.cjs.
 * See the contract at the top of src/platform.js. */
const { app, BrowserWindow, Menu, dialog, ipcMain, session } = require('electron');
const fs = require('fs');
const path = require('path');

const PAGE = path.join(__dirname, '..', 'dist', 'ShotRef.html');
const ICON = path.join(__dirname, '..', 'branding', 'shotref.ico');
const PROJECT_FILTERS = [{ name: 'ShotRef project', extensions: ['shotref', 'json'] }];
const isProjectFile = p => /\.(shotref|json)$/i.test(p);

let win = null;
let closeAllowed = false;
const allowedPaths = new Set(); /* paths the page may write to: only ones that came from a dialog, argv or the recent list */

/* ---------- small settings file: last folder per kind + recent list ---------- */
const settingsFile = () => path.join(app.getPath('userData'), 'shotref-settings.json');
let settings = { folders: {}, recent: [] };
function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    settings = {
      folders: s && typeof s.folders === 'object' && s.folders ? s.folders : {},
      recent: Array.isArray(s && s.recent) ? s.recent.filter(p => typeof p === 'string').slice(0, 8) : [],
    };
  } catch (e) { /* first run or unreadable: start fresh */ }
}
function saveSettings() {
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings)); }
  catch (e) { console.error('ShotRef: could not save settings', e); }
}
function folderFor(kind) {
  const d = settings.folders[kind];
  try { if (d && fs.statSync(d).isDirectory()) return d; } catch (e) { /* folder is gone */ }
  return app.getPath('documents');
}
function rememberFolder(kind, file) { settings.folders[kind] = path.dirname(file); saveSettings(); }
function addRecent(file) {
  settings.recent = [file, ...settings.recent.filter(p => p !== file)].slice(0, 8);
  saveSettings();
  try { app.addRecentDocument(file); } catch (e) { /* not fatal */ }
  buildMenu();
}

/* ---------- helpers ---------- */
const send = (ch, ...a) => { if (win && !win.isDestroyed()) win.webContents.send(ch, ...a); };
function plainError(e) {
  const c = e && e.code;
  if (c === 'ENOSPC') return 'The disk is full.';
  if (c === 'EACCES' || c === 'EPERM' || c === 'EROFS') return 'ShotRef is not allowed to write to that folder.';
  if (c === 'ENOENT') return 'That folder or file is gone.';
  return 'Could not write the file (' + ((e && e.message) || 'unknown error') + ').';
}
const cleanName = (n, fallback) => (typeof n === 'string' && n.trim() ? n.trim() : fallback).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
const cleanFilters = f => (Array.isArray(f) ? f : [])
  .filter(x => x && typeof x.name === 'string' && Array.isArray(x.extensions)).slice(0, 6)
  .map(x => ({ name: x.name.slice(0, 60), extensions: x.extensions.filter(e => typeof e === 'string' && /^[\w.]{1,12}$/.test(e)).slice(0, 8) }));

async function readProject(file) {
  const text = await fs.promises.readFile(file, 'utf8');
  allowedPaths.add(file); rememberFolder('project', file); addRecent(file);
  return { text, name: path.basename(file), path: file };
}
async function openPath(file) { /* argv, second launch, recent menu */
  try { send('shotref:open-file', await readProject(file)); }
  catch (e) { dialog.showMessageBox(win, { type: 'error', message: 'Could not open that file.', detail: String((e && e.message) || e) }); }
}
const fileFromArgs = args => args.slice(1).find(a => typeof a === 'string' && !a.startsWith('-') && isProjectFile(a) && fs.existsSync(a));

/* ---------- IPC (every input is checked here; the page is not trusted) ---------- */
ipcMain.handle('shotref:save-blob', async (e, name, data, filters) => {
  try {
    if (typeof name !== 'string' || !(data instanceof ArrayBuffer || ArrayBuffer.isView(data))) return { ok: false, error: 'Bad request.' };
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(folderFor('export'), cleanName(name, 'shotref-export')), filters: cleanFilters(filters) });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    const buf = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    await fs.promises.writeFile(r.filePath, buf);
    rememberFolder('export', r.filePath);
    return { ok: true, name: path.basename(r.filePath) };
  } catch (err) { console.error('ShotRef: save failed', err); return { ok: false, error: plainError(err) }; }
});

ipcMain.handle('shotref:save-project', async (e, text, opts) => {
  try {
    if (typeof text !== 'string') return { ok: false, error: 'Bad request.' };
    opts = opts && typeof opts === 'object' ? opts : {};
    /* write straight to a path only if we handed it out ourselves; anything else gets the Save dialog */
    let file = !opts.saveAs && typeof opts.path === 'string' && allowedPaths.has(opts.path) ? opts.path : null;
    if (!file) {
      const r = await dialog.showSaveDialog(win, {
        defaultPath: path.join(folderFor('project'), cleanName(opts.name, 'shotref.shotref')),
        filters: [{ name: 'ShotRef project', extensions: ['shotref'] }],
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      file = r.filePath;
    }
    await fs.promises.writeFile(file, text, 'utf8');
    allowedPaths.add(file); rememberFolder('project', file); addRecent(file);
    return { ok: true, name: path.basename(file), path: file };
  } catch (err) { console.error('ShotRef: project save failed', err); return { ok: false, error: plainError(err) }; }
});

ipcMain.handle('shotref:open-project', async () => {
  try {
    const r = await dialog.showOpenDialog(win, { defaultPath: folderFor('project'), properties: ['openFile'], filters: PROJECT_FILTERS });
    if (r.canceled || !r.filePaths[0]) return null;
    return await readProject(r.filePaths[0]);
  } catch (err) {
    console.error('ShotRef: open failed', err);
    dialog.showMessageBox(win, { type: 'error', message: 'Could not open that file.', detail: String((err && err.message) || err) });
    return null;
  }
});

ipcMain.on('shotref:set-title', (e, t) => { if (typeof t === 'string' && win && !win.isDestroyed()) win.setTitle(t.slice(0, 200)); });
ipcMain.on('shotref:close-ok', () => { closeAllowed = true; if (win && !win.isDestroyed()) win.close(); });
ipcMain.on('shotref:version-sync', e => { e.returnValue = app.getVersion(); });

/* ---------- menu ---------- */
function buildMenu() {
  const recent = settings.recent.map(p => ({ label: path.basename(p), sublabel: p, click: () => openPath(p) }));
  /* Ctrl+S, Ctrl+Shift+S and Ctrl+O are handled by the page itself; registerAccelerator:false only shows the label */
  const tpl = [
    { label: 'File', submenu: [
      { label: 'New', click: () => send('shotref:menu', 'new') },
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', registerAccelerator: false, click: () => send('shotref:menu', 'open') },
      { label: 'Open recent', submenu: recent.length ? recent : [{ label: 'No recent projects', enabled: false }] },
      { type: 'separator' },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', registerAccelerator: false, click: () => send('shotref:menu', 'save') },
      { label: 'Save as…', accelerator: 'CmdOrCtrl+Shift+S', registerAccelerator: false, click: () => send('shotref:menu', 'save-as') },
      { type: 'separator' },
      { label: 'Exit', click: () => { if (win && !win.isDestroyed()) win.close(); else app.quit(); } },
    ] },
    { label: 'Help', submenu: [
      { label: 'Quick start', click: () => dialog.showMessageBox(win, {
        type: 'info', title: 'Quick start', message: 'Quick start',
        detail: 'Pick a starter scene, place people and props, then set camera keyframes. Press Play to preview, then export a video or frames for your AI model.\n\nSave with Ctrl+S. Open with Ctrl+O, or double-click a .shotref file.' }) },
      { label: 'About ShotRef', click: () => dialog.showMessageBox(win, {
        type: 'info', title: 'About ShotRef', message: 'ShotRef', detail: 'Version ' + app.getVersion() + '\nBlocking and camera moves for AI video reference.' }) },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

/* ---------- window ---------- */
function hardenSession(ses) {
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(file|data|devtools|chrome-extension):/i.test(d.url) })); /* no network of any kind */
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(false));
}
function createWindow(startFile) {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 700, backgroundColor: '#141518', icon: ICON, title: 'ShotRef', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  const wc = win.webContents;
  win.once('ready-to-show', () => win.show());
  win.on('page-title-updated', e => e.preventDefault()); /* the page's setTitle decides */
  wc.on('will-navigate', e => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('close', e => {
    if (closeAllowed || wc.isCrashed()) return;
    e.preventDefault(); send('shotref:menu', 'close-request'); /* the page asks about unsaved work and calls closeOk() */
  });
  win.on('closed', () => { win = null; });
  if (startFile) wc.once('did-finish-load', () => openPath(startFile)); /* the preload queues it until the page listens */
  win.loadFile(PAGE);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const f = fileFromArgs(argv); if (f) openPath(f);
  });
  app.whenReady().then(() => {
    loadSettings(); hardenSession(session.defaultSession); buildMenu();
    createWindow(fileFromArgs(process.argv));
  });
  app.on('window-all-closed', () => app.quit());
}
