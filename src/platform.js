/* Platform layer: the only place that knows where ShotRef is running.
 *   kind 'desktop'  inside the Windows app (Electron). The preload exposes window.shotrefDesktop.
 *   kind 'claude'   published artifact on claude.ai (downloads capability, no blob: URLs)
 *   kind 'web'      plain HTML file opened from disk or a website
 *
 * window.shotrefDesktop contract (the Electron preload must provide exactly this; data crosses as string / ArrayBuffer):
 *   version                                  app version string
 *   saveBlob(name, arrayBuffer, filters)     native Save dialog for exports. filters: [{ name, extensions }]
 *                                            -> Promise<{ ok, name?, canceled?, error? }>
 *   saveProject(text, { saveAs, path, name })  writes the project text. With a path and no saveAs it writes straight to that
 *                                            file, else it shows the Save dialog (name = suggested file name)
 *                                            -> Promise<{ ok, name, path, canceled?, error? }>
 *   openProject()                            native Open dialog -> Promise<{ text, name, path } | null>
 *   setTitle(str)                            window title
 *   onMenu(cb)                               cb(cmd) for menu clicks: 'new' | 'open' | 'save' | 'save-as' | 'close-request'
 *   onOpenFile(cb)                           cb({ text, name, path }): a file passed on launch, double-clicked or picked from Recent
 *   Notes for the main process: do not give menu items the page's own shortcuts (Ctrl+S, Ctrl+Shift+S, Ctrl+O), or they fire twice
 *   (registerAccelerator:false keeps the label). Send 'close-request' on every close attempt; do not latch a "closing" flag.
 *   Queue onOpenFile / menu events that arrive before the page registers its callbacks. Cancel the window's page-title-updated
 *   event so document.title does not overwrite setTitle.
 *   closeOk()                                the page calls this once closing is allowed. After 'close-request' the main
 *                                            process waits for it (Cancel in the page simply never calls it)
 */
const desk = typeof window !== 'undefined' && window.shotrefDesktop && typeof window.shotrefDesktop === 'object' ? window.shotrefDesktop : null;
const kind = desk ? 'desktop' : (typeof window !== 'undefined' && window.claude && typeof window.claude.use === 'function') ? 'claude' : 'web';

/* downloads capability on claude.ai; plain <a download> elsewhere */
let dlApi;
const dlReady = (async () => {
  try { if (kind === 'claude') dlApi = await window.claude.use('downloads'); } catch (e) { dlApi = null; }
})();

/* where the open project lives (desktop only knows a path) and whether it has unsaved changes */
/* history steps carry a document id; docs maps it to its file. Save / Save as update the current document's entry. */
const docs = { 1: { name: null, path: null } };
let docSeq = 1;
const cur = { doc: 1, name: null, path: null, dirty: false, rev: 0 };
const setFile = (name, path) => { cur.name = name || null; cur.path = path || null; docs[cur.doc] = { name: cur.name, path: cur.path }; }; /* rev counts edits, so a save only clears the mark if nothing changed while it ran */
function updateTitle() {
  if (!desk) return; /* the page title stays "ShotRef" on the web */
  try { desk.setTitle((cur.dirty ? '• ' : '') + (cur.name ? cur.name + ' - ' : '') + 'ShotRef'); } catch (e) { console.error('ShotRef: could not set the window title', e); }
}
const errText = e => (e && (e.message || e.error)) || String(e || 'unknown error');

/* Save a file. Returns { ok, name } | { ok:false, canceled } | { ok:false, error } */
async function saveBlob(filename, blob, opts = {}) {
  try {
    if (desk) return (await desk.saveBlob(filename, await blob.arrayBuffer(), opts.filters || [])) || { ok: false, error: 'no answer' };
    await Promise.race([dlReady, new Promise(r => setTimeout(r, 300))]);
    if (dlApi) {
      try { await dlApi.save({ filename, data: blob }); return { ok: true, name: filename }; }
      catch (e) { if (e && e.code === 'declined') return { ok: false, canceled: true }; throw e; }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return { ok: true, name: filename };
  } catch (e) { console.error('ShotRef: could not save', e); return { ok: false, error: errText(e) }; }
}

/* Save the project text. opts: { saveAs, name (suggested file name) }. On desktop a known path is written to directly. */
async function saveProject(text, opts = {}) {
  const name = opts.name || 'shotref.shotref', rev = cur.rev;
  if (!desk) {
    const r = await saveBlob(name, new Blob([text], { type: 'application/json' }), { filters: [{ name: 'ShotRef project', extensions: ['shotref'] }] });
    if (r.ok && cur.rev === rev) cur.dirty = false;
    return r;
  }
  try {
    const r = await desk.saveProject(text, { saveAs: !!opts.saveAs, path: opts.saveAs ? null : cur.path, name });
    if (r && r.ok) { setFile(r.name || cur.name, r.path || cur.path); if (cur.rev === rev) cur.dirty = false; updateTitle(); }
    return r || { ok: false, error: 'no answer' };
  } catch (e) { console.error('ShotRef: could not save the project', e); return { ok: false, error: errText(e) }; }
}

/* Desktop: the native Open dialog. Web: opens the page's file picker (its change handler loads the file), so it answers null. */
async function openProject(webInput) {
  if (!desk) { if (webInput) webInput.click(); return null; }
  try { return (await desk.openProject()) || null; }
  catch (e) { console.error('ShotRef: could not open', e); return null; }
}

export const platform = {
  kind, version: desk ? desk.version : null,
  saveBlob, saveProject, openProject,
  currentName: () => cur.name,
  currentPath: () => cur.path,
  getDoc: () => cur.doc,
  /* Open / New / starters: a new document with no file yet */
  startDoc() { cur.doc = ++docSeq; setFile(null, null); },
  /* undo/redo moved to a step that belongs to another file (or none) */
  restoreDoc(id) { const d = docs[id]; if (!d) return; cur.doc = id; cur.name = d.name; cur.path = d.path; updateTitle(); },
  isDirty: () => cur.dirty,
  setDirty(d) { d = !!d; if (d) cur.rev++; if (cur.dirty !== d) { cur.dirty = d; updateTitle(); } },
  /* a project was opened from a file (name/path may be missing, e.g. drag-drop has no path) */
  setCurrent(name, path) { setFile(name, path); cur.dirty = false; updateTitle(); },
  /* a new, unsaved project: forget the file */
  newProject() { cur.dirty = true; updateTitle(); },
  onMenu(cb) { if (desk && typeof desk.onMenu === 'function') desk.onMenu(cb); },
  onOpenFile(cb) { if (desk && typeof desk.onOpenFile === 'function') desk.onOpenFile(cb); },
  closeOk() { if (desk && typeof desk.closeOk === 'function') desk.closeOk(); },
};
