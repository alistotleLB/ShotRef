/* ShotRef desktop shell. Loads the same dist/ShotRef.html as the web build; the page only talks to this file through preload.cjs.
 * See the contract at the top of src/platform.js. */
const { app, BrowserWindow, Menu, dialog, ipcMain, session } = require('electron');
const fs = require('fs');
const path = require('path');
const updater = require('./updater.cjs');
const popup = require('./popup.cjs'); /* ShotRef's own message boxes, in place of dialog.showMessageBox (no Windows look, no alert sound) */

const PAGE = path.join(__dirname, '..', 'dist', 'ShotRef.html');
const ICON = path.join(__dirname, '..', 'branding', 'shotref.ico');
const PROJECT_FILTERS = [{ name: 'ShotRef project', extensions: ['shotref', 'json'] }];
const isProjectFile = p => /\.(shotref|json)$/i.test(p);

let win = null;
const WHATS_NEW_DELAY_MS = 700; /* let the window paint first */
let closeAllowed = false;
let pageReady = false; /* the page registered its menu callback, so it can answer a close request */
let pendingFile = null; /* a file that arrived before the window existed */
const allowedPaths = new Set(); /* paths the page may write to: only ones that came from a dialog, argv or the recent list */

/* ---------- small settings file: last folder per kind + recent list ---------- */
const settingsFile = () => path.join(app.getPath('userData'), 'shotref-settings.json');
let settings = { folders: {}, recent: [], autoUpdate: true, lastVersion: null };
let hadSettings = false; /* a settings file existed before this launch: ShotRef ran here before (so this may be an update) */
function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    settings = {
      folders: s && typeof s.folders === 'object' && s.folders ? s.folders : {},
      recent: Array.isArray(s && s.recent) ? s.recent.filter(p => typeof p === 'string').slice(0, 8) : [],
      autoUpdate: !(s && s.autoUpdate === false), /* on unless the user turned it off in Help */
      lastVersion: s && typeof s.lastVersion === 'string' ? s.lastVersion : null, /* the version that last ran: drives What's new */
    };
    hadSettings = true;
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
  .map(x => ({ name: x.name.slice(0, 60), extensions: x.extensions.filter(e => typeof e === 'string' && /^[\w.]{1,12}$/.test(e)).slice(0, 8) }))
  .filter(x => x.extensions.length);

/* I2: write to a temp file next to the target, then rename over it, so a failed write never damages the existing file */
async function writeAtomic(file, data, enc) {
  const tmp = file + '.tmp-' + process.pid;
  try {
    await fs.promises.writeFile(tmp, data, enc);
    for (let i = 0; ; i++) { /* sync tools and antivirus can hold the target for a moment */
      try { await fs.promises.rename(tmp, file); break; }
      catch (e) { if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e && e.code)) throw e; await new Promise(r => setTimeout(r, 100)); }
    }
  }
  catch (e) { await fs.promises.unlink(tmp).catch(() => {}); throw e; }
}

async function readProject(file) {
  const text = await fs.promises.readFile(file, 'utf8');
  allowedPaths.add(file); rememberFolder('project', file); addRecent(file);
  return { text, name: path.basename(file), path: file };
}
async function openPath(file) { /* argv, second launch, recent menu */
  if (win && !pageReady) { pendingFile = file; return; } /* the page is not listening yet: open it once it is */
  try { send('shotref:open-file', await readProject(file)); }
  catch (e) {
    if (e && e.code === 'ENOENT') { settings.recent = settings.recent.filter(p => p !== file); saveSettings(); buildMenu(); }
    popup.show(win, { type: 'error', title: 'Open', message: 'Could not open that file.', detail: String((e && e.message) || e) });
  }
}
const fileFromArgs = args => args.slice(1).find(a => typeof a === 'string' && !a.startsWith('-') && isProjectFile(a) && fs.existsSync(a));

/* ---------- IPC (every input is checked here; the page is not trusted) ---------- */
ipcMain.handle('shotref:save-blob', async (e, name, data, filters) => {
  try {
    if (typeof name !== 'string' || !(data instanceof ArrayBuffer || ArrayBuffer.isView(data))) return { ok: false, error: 'Bad request.' };
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(folderFor('export'), cleanName(name, 'shotref-export')), filters: cleanFilters(filters) });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    const buf = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    await writeAtomic(r.filePath, buf);
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
    await writeAtomic(file, text, 'utf8');
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
    popup.show(win, { type: 'error', title: 'Open', message: 'Could not open that file.', detail: String((err && err.message) || err) });
    return null;
  }
});

const IMPORT_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', glb: 'model/gltf-binary', gltf: 'model/gltf+json' };
ipcMain.handle('shotref:pick-file', async (e, kind, filters) => {
  try {
    const r = await dialog.showOpenDialog(win, { defaultPath: folderFor('import'), properties: ['openFile'], filters: cleanFilters(filters) });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = r.filePaths[0];
    const data = await fs.promises.readFile(file);
    rememberFolder('import', file);
    return { name: path.basename(file), type: IMPORT_TYPES[path.extname(file).slice(1).toLowerCase()] || '', data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
  } catch (err) { console.error('ShotRef: pick failed', err); return null; }
});

ipcMain.on('shotref:page-ready', () => { pageReady = true; if (pendingFile) { const f = pendingFile; pendingFile = null; openPath(f); } });
ipcMain.on('shotref:set-title', (e, t) => { if (typeof t === 'string' && win && !win.isDestroyed()) win.setTitle(t.slice(0, 200)); });
ipcMain.on('shotref:close-ok', () => { closeAllowed = true; if (win && !win.isDestroyed()) win.close(); });
ipcMain.on('shotref:version-sync', e => { e.returnValue = app.getVersion(); });
/* buttons in the page's About window */
ipcMain.on('shotref:whats-new', () => { showWhatsNew(null, false).catch(e => console.error("ShotRef: What's new", e)); });
ipcMain.on('shotref:check-updates', () => { updater.checkNow(true).catch(e => console.error('ShotRef: update check', e)); });

/* ---------- What's new ----------
   After an update, list every change between the version that last ran here and this one: all of them, newest first.
   The notes are in whats-new.json, shipped with the app, so this works offline.
   A fresh install shows nothing (the page welcomes the user). A settings file without lastVersion comes from 1.4.0 or older,
   before the version was remembered: there is no way to know which one, so every listed version up to this one is shown. */
const verParts = v => String(v || '').split(/[.+-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
function verCmp(a, b) { const x = verParts(a), y = verParts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; }
function readNotes() {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'whats-new.json'), 'utf8'));
    return (Array.isArray(list) ? list : []).filter(n => n && typeof n.version === 'string' && Array.isArray(n.items) && n.items.length)
      .sort((a, b) => verCmp(b.version, a.version));
  } catch (e) { console.error("ShotRef: could not read What's new", e); return []; }
}
/* fromUpdate: every version after `since` (null = unknown: all) up to this one. From the Help menu: this version's notes only. */
function showWhatsNew(since, fromUpdate) {
  const cur = app.getVersion();
  const upTo = readNotes().filter(n => verCmp(n.version, cur) <= 0);
  const notes = fromUpdate ? upTo.filter(n => since === null || verCmp(n.version, since) > 0) : upTo.slice(0, 1);
  if (!notes.length) return Promise.resolve(null);
  return popup.show(win, {
    type: 'info', title: "What's new", width: 520,
    message: fromUpdate ? 'ShotRef is updated to ' + cur + '.' : "What's new in ShotRef " + notes[0].version,
    detail: !fromUpdate ? '' : since ? 'Everything that changed since ' + since + ':' : 'Here is what changed in recent versions:',
    notes, buttons: ['Start working'], defaultId: 0, cancelId: 0,
  });
}
/* once per launch, after the window is up: remember this version, and show the notes if it went up */
function whatsNewOnLaunch() {
  const cur = app.getVersion(), prev = settings.lastVersion;
  if (prev === cur) return;
  settings.lastVersion = cur; saveSettings();
  if (!hadSettings) return; /* first run on this computer */
  if (prev && verCmp(prev, cur) >= 0) return; /* same or an older build: nothing new to say */
  showWhatsNew(prev, true).catch(e => console.error("ShotRef: What's new", e));
}

/* ---------- menu ---------- */
const HANDS_TOUR = false; /* mirrors HANDS_TOUR_DEFAULT in src/main.js: the hands-on tour is switched off for now */
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
      { label: 'Quick start', click: () => send('shotref:menu', 'help') },
      /* the same two labels as TOUR_COPY.menu in src/tour-copy.js (this file cannot import the page's ES module) */
      { label: 'Take the quick tour', click: () => send('shotref:menu', 'tour-basic') },
      /* the hands-on tour is switched off for now (see handsTourOn in src/main.js): set HANDS_TOUR to true here as well to bring it back */
      { label: 'Try it hands-on', visible: HANDS_TOUR, click: () => send('shotref:menu', 'tour-hands') },
      { type: 'separator' },
      { label: 'Check for updates…', click: () => updater.checkNow(true) },
      { label: 'Check for updates automatically', type: 'checkbox', checked: settings.autoUpdate, click: i => { settings.autoUpdate = i.checked; saveSettings(); } },
      { type: 'separator' },
      { label: "What's new", click: () => showWhatsNew(null, false) },
      { label: 'About ShotRef', click: () => send('shotref:menu', 'about') }, /* the page's About window: version, privacy, copyright, licences */
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

/* ---------- window ---------- */
function hardenSession(ses) {
  /* no network for the page; the updater's own requests (main process, GitHub only) are let through by updater.allowsRequest */
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(file|data|devtools|chrome-extension):/i.test(d.url) && !updater.allowsRequest(d) }));
  /* the only thing the page may ask for is writing a copied frame to the clipboard */
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'clipboard-sanitized-write'));
  ses.setPermissionCheckHandler((wc, perm) => perm === 'clipboard-sanitized-write');
}
function contextMenuTemplate(params, wc) {
  const f = params.editFlags || {}, tpl = [];
  const sep = () => { if (tpl.length && tpl[tpl.length - 1].type !== 'separator') tpl.push({ type: 'separator' }); };
  if (params.isEditable) {
    tpl.push({ label: 'Undo', role: 'undo', enabled: !!f.canUndo }, { label: 'Redo', role: 'redo', enabled: !!f.canRedo });
    sep();
    tpl.push({ label: 'Cut', role: 'cut', enabled: !!f.canCut }, { label: 'Copy', role: 'copy', enabled: !!f.canCopy },
      { label: 'Paste', role: 'paste', enabled: !!f.canPaste }, { label: 'Delete', role: 'delete', enabled: !!f.canDelete });
    sep();
    tpl.push({ label: 'Select all', role: 'selectAll', enabled: !!f.canSelectAll });
  } else if (params.selectionText && params.selectionText.trim()) {
    tpl.push({ label: 'Copy', role: 'copy' });
  }
  if (params.mediaType === 'image') {
    sep();
    tpl.push({ label: 'Copy image', click: () => wc && wc.copyImageAt(params.x, params.y) });
  }
  if (tpl.length && tpl[tpl.length - 1].type === 'separator') tpl.pop();
  return tpl;
}
global.__shotrefContextMenu = p => contextMenuTemplate(p, null).map(i => i.type === 'separator' ? '-' : i.label + (i.enabled === false ? ' (off)' : '')); /* for test/desktop.cjs */
function createWindow(startFile) {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 700, backgroundColor: '#141518', icon: ICON, title: 'ShotRef', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  const wc = win.webContents;
  win.once('ready-to-show', () => { win.show(); setTimeout(whatsNewOnLaunch, WHATS_NEW_DELAY_MS); });
  win.on('page-title-updated', e => e.preventDefault()); /* the page's setTitle decides */
  wc.on('will-navigate', e => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  /* Electron has no right-click menu of its own: give the same one a browser shows (text boxes, selected text, images).
     The page still blocks it where it uses right-click itself (3D view, keyframes), as in the browser. */
  wc.on('context-menu', (e, params) => {
    const tpl = contextMenuTemplate(params, wc);
    if (tpl.length) Menu.buildFromTemplate(tpl).popup({ window: win });
  });
  win.on('close', e => {
    if (closeAllowed || !pageReady || wc.isCrashed()) return; /* a page that never started cannot ask, so do not trap the window */
    e.preventDefault(); send('shotref:menu', 'close-request'); /* the page asks about unsaved work and calls closeOk() */
  });
  win.on('closed', () => { win = null; pageReady = false; });
  startFile = startFile || pendingFile; pendingFile = null;
  if (startFile) wc.once('did-finish-load', () => openPath(startFile)); /* the preload queues it until the page listens */
  win.loadFile(PAGE);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (e, argv, cwd) => {
    const f = fileFromArgs(argv.map((a, i) => i && typeof a === 'string' && !path.isAbsolute(a) && !a.startsWith('-') ? path.resolve(cwd, a) : a));
    if (!win) { pendingFile = f || pendingFile; return; }
    if (win.isMinimized()) win.restore();
    win.focus();
    if (f) openPath(f);
  });
  app.whenReady().then(() => {
    app.setAppUserModelId('app.shotref.desktop');
    loadSettings(); hardenSession(session.defaultSession);
    updater.init({ getWin: () => win, getSettings: () => settings });
    buildMenu();
    createWindow(fileFromArgs(process.argv));
    updater.scheduleAutoCheck();
  });
  app.on('window-all-closed', () => { if (updater.installRequested()) updater.install(); else app.quit(); });
}
