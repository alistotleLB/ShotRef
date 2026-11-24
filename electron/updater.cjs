/* ShotRef desktop updates. Checks the GitHub Releases of alistotleLB/ShotRef (set in package.json "build.publish").
 * Everything runs in the main process with native dialogs: the page never talks to the network and has no update code.
 *
 * Flow: check -> "update available" -> download (taskbar progress) -> "restart now" or "install when I close ShotRef".
 * "Restart now" closes the window the normal way, so the page still asks about unsaved work first.
 * The portable .exe cannot replace itself, so it only offers to open the download page.
 * Tests (unpackaged only): SHOTREF_UPDATE_URL points the check at a local folder that serves latest.yml. */
const { app, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');

const RELEASES_PAGE = 'https://github.com/alistotleLB/ShotRef/releases/latest';
const TEST_URL = !app.isPackaged && process.env.SHOTREF_UPDATE_URL ? process.env.SHOTREF_UPDATE_URL : null;
const PORTABLE = !!process.env.PORTABLE_EXECUTABLE_DIR;
const AUTO_DELAY_MS = TEST_URL && +process.env.SHOTREF_UPDATE_DELAY_MS > 0 ? +process.env.SHOTREF_UPDATE_DELAY_MS : 8000; /* the delay can be shortened in tests only */

let ctx = null; /* { getWin, getSettings, save, rebuildMenu } */
let busy = false; /* a check or download is running */
let installOnClose = false;
let ready = null; /* version that is downloaded and waiting */

const available = () => app.isPackaged || !!TEST_URL; /* an unpackaged dev run has nothing to update */
const box = o => { const w = ctx && ctx.getWin(); return w && !w.isDestroyed() ? dialog.showMessageBox(w, o) : dialog.showMessageBox(o); };
const setProgress = v => { const w = ctx && ctx.getWin(); if (w && !w.isDestroyed()) w.setProgressBar(v); };

/* The page session blocks all network (hardenSession in main.cjs). The updater's own requests come from the main process,
   so they have no webContentsId; let only those through, and only to GitHub (or the test server). */
function allowsRequest(d) {
  if (d.webContentsId) return false;
  if (/^https:\/\/([\w-]+\.)*(github\.com|githubusercontent\.com)\//i.test(d.url)) return true;
  return !!TEST_URL && d.url.startsWith(TEST_URL.replace(/\/+$/, '') + '/');
}

function init(c) {
  ctx = c;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false; /* turned on only when the user picks "install when I close" */
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = { info() {}, warn: console.warn, error: console.error, debug() {} };
  if (TEST_URL) { autoUpdater.forceDevUpdateConfig = true; autoUpdater.setFeedURL({ provider: 'generic', url: TEST_URL }); autoUpdater.disableDifferentialDownload = true; }
  autoUpdater.on('download-progress', p => setProgress(Math.max(0, Math.min(1, (p.percent || 0) / 100))));
}

function plainReason(e) {
  const m = String((e && e.message) || e || '');
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::ERR|ERR_INTERNET|ERR_NAME|ERR_CONNECTION/i.test(m)) return 'ShotRef could not reach GitHub. Check your internet connection and try again.';
  if (/404|latest\.yml|Cannot find/i.test(m)) return 'There is no published update file yet. Try again later.';
  return 'Something went wrong while checking (' + m.split('\n')[0].slice(0, 160) + ').';
}

/* manual: the user asked, so say the result even when there is nothing new or it failed */
async function checkNow(manual) {
  if (busy) { if (manual) await box({ type: 'info', message: 'ShotRef is already checking for updates.', buttons: ['OK'] }); return; }
  if (!available()) {
    if (manual) await box({ type: 'info', title: 'Check for updates', message: 'Updates work in the installed ShotRef.', detail: 'This copy is running from source.', buttons: ['OK'] });
    return;
  }
  if (ready) { await offerRestart(ready); return; }
  busy = true;
  let info = null;
  try {
    const r = await autoUpdater.checkForUpdates();
    info = r && r.isUpdateAvailable ? r.updateInfo : null;
  } catch (e) {
    console.error('ShotRef: update check failed', e);
    busy = false;
    if (manual) await box({ type: 'warning', title: 'Check for updates', message: 'Could not check for updates.', detail: plainReason(e), buttons: ['OK'] });
    return;
  }
  busy = false;
  if (!info) {
    if (manual) await box({ type: 'info', title: 'Check for updates', message: 'ShotRef is up to date.', detail: 'You have version ' + app.getVersion() + ', the latest.', buttons: ['OK'] });
    return;
  }
  await offerUpdate(info);
}

async function offerUpdate(info) {
  const head = 'ShotRef ' + info.version + ' is available. You have ' + app.getVersion() + '.';
  if (PORTABLE) {
    const r = await box({ type: 'info', title: 'Update available', message: head, detail: 'The portable version cannot update itself. Open the download page to get the new one.', buttons: ['Open download page', 'Later'], defaultId: 0, cancelId: 1 });
    if (r.response === 0) shell.openExternal(RELEASES_PAGE);
    return;
  }
  const r = await box({ type: 'info', title: 'Update available', message: head, detail: 'Download it now? It downloads in the background, and ShotRef asks before it restarts. Your projects are not touched.', buttons: ['Download update', 'Later'], defaultId: 0, cancelId: 1 });
  if (r.response !== 0) return;
  busy = true;
  try {
    await autoUpdater.downloadUpdate();
  } catch (e) {
    console.error('ShotRef: update download failed', e);
    busy = false; setProgress(-1);
    await box({ type: 'warning', title: 'Update', message: 'The update did not download.', detail: plainReason(e), buttons: ['OK'] });
    return;
  }
  busy = false; setProgress(-1);
  ready = info.version;
  await offerRestart(info.version);
}

async function offerRestart(version) {
  const r = await box({ type: 'info', title: 'Update ready', message: 'ShotRef ' + version + ' is ready to install.', detail: 'ShotRef asks about unsaved work before it closes. Or choose Later: it installs the next time you close ShotRef.', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1 });
  autoUpdater.autoInstallOnAppQuit = true; /* either way it installs when ShotRef closes */
  if (r.response === 0) { installOnClose = true; const w = ctx.getWin(); if (w && !w.isDestroyed()) w.close(); else install(); }
}

/* called from window-all-closed */
const installRequested = () => installOnClose && !!ready;
function install() { autoUpdater.quitAndInstall(true, true); }

function scheduleAutoCheck() {
  if (!available() || !ctx.getSettings().autoUpdate) return;
  setTimeout(() => { if (ctx.getSettings().autoUpdate) checkNow(false).catch(e => console.error('ShotRef: auto update check', e)); }, AUTO_DELAY_MS).unref();
}

module.exports = { init, checkNow, scheduleAutoCheck, allowsRequest, installRequested, install };
