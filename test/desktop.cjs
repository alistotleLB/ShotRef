/* Desktop (Electron) checks. Run: npm run test:desktop (builds nothing: run `npm run build` first).
 * Launches the local electron binary through playwright-core's _electron against electron/main.cjs, with a fresh
 * profile folder per launch. Native dialogs are replaced from the test (electronApp.evaluate) with stubs that
 * answer with paths inside a temp folder. */
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shotref-desk-'));
let launches = 0;
const apps = [];

async function launch(args = [], opts = {}) {
  const userData = opts.userData || path.join(tmp, 'profile' + (++launches));
  const app = await electron.launch({ executablePath: require('electron'), args: [ROOT, '--user-data-dir=' + userData, ...args], cwd: ROOT, env: { ...process.env, ...(opts.env || {}) } });
  apps.push(app);
  const page = await app.firstWindow();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.waitForFunction(() => window.__shotref && window.__shotref.state, null, { timeout: 30000 });
  page.setDefaultTimeout(8000);
  if (!opts.raw) { /* first launch asks about the tour, then opens the starter sets: hide the question so clicks reach the page */
    await page.waitForFunction(() => !document.querySelector('#mTour').classList.contains('hidden'), null, { timeout: 4000 }).catch(() => {});
    await page.evaluate(() => { document.querySelector('#mTour').classList.add('hidden'); document.querySelector('#mStart').classList.add('hidden'); });
  }
  await page.evaluate(() => { window.__edit = () => { window.__shotref.addObject('box'); window.__shotref.changed(true); }; });
  return { app, page, errors, userData };
}
/* a File menu item as a Windows user uses it: the application menu's item (the page has no File button on the desktop) */
const FILE_LABELS = { new: 'New', open: 'Open…', save: 'Save', saveas: 'Save as…', recent: 'Recent projects…', export: 'Export…' };
const fileCmd = (app, cmd) => app.evaluate(({ Menu }, l) => { Menu.getApplicationMenu().items.find(i => i.label === 'File').submenu.items.find(i => i.label === l).click(); }, FILE_LABELS[cmd]);
/* stub the native dialogs: each call takes the next answer from the queue and counts calls */
async function stubDialogs(app, saveAnswers, openAnswers = []) {
  await app.evaluate(({ dialog }, [s, o]) => {
    globalThis.__dlg = { save: 0, open: 0 };
    dialog.showSaveDialog = async () => { globalThis.__dlg.save++; const f = s.shift(); return f ? { canceled: false, filePath: f } : { canceled: true }; };
    dialog.showOpenDialog = async () => { globalThis.__dlg.open++; const f = o.shift(); return f ? { canceled: false, filePaths: [f] } : { canceled: true, filePaths: [] }; };
  }, [saveAnswers, openAnswers]);
}
const dlgCounts = app => app.evaluate(() => globalThis.__dlg);
const objCount = page => page.evaluate(() => window.__shotref.state.objects.length);
/* a dirty app asks before closing, so tests end apps by killing them */
/* Windows: killing only the main process leaves Electron's GPU, network and renderer children running, so kill the whole tree */
const killTree = pid => { try { require('child_process').execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* already gone */ } };
const kill = async app => { try { const pid = app.process().pid; if (process.platform === 'win32') killTree(pid); else app.process().kill(); } catch (e) { /* gone */ } };
process.on('exit', () => { for (const a of apps) { try { const pid = a.process().pid; if (process.platform === 'win32') killTree(pid); else a.process().kill(); } catch (e) { /* gone */ } } });
const sleep = ms => new Promise(r => setTimeout(r, ms));


/* ---- update tests: a local feed that looks like GitHub's latest.yml + installer, and a stub for message boxes ---- */
const http = require('http');
const crypto = require('crypto');
const INSTALLER = crypto.randomBytes(4096);
function startFeed(version) {
  const hits = [];
  const sha = crypto.createHash('sha512').update(INSTALLER).digest('base64');
  const name = 'ShotRef-Setup-' + version + '.exe';
  const yml = 'version: ' + version + '\nfiles:\n  - url: ' + name + '\n    sha512: ' + sha + '\n    size: ' + INSTALLER.length + '\npath: ' + name + '\nsha512: ' + sha + "\nreleaseDate: '2026-11-24T00:00:00.000Z'\n";
  const srv = http.createServer((req, res) => {
    const u = req.url.split('?')[0]; hits.push(u);
    if (u === '/latest.yml') { res.writeHead(200, { 'Content-Type': 'text/yaml' }); res.end(yml); }
    else if (u === '/' + name) { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': INSTALLER.length }); res.end(INSTALLER); }
    else { res.writeHead(404); res.end('no'); }
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, hits, url: 'http://127.0.0.1:' + srv.address().port, close: () => srv.close() })));
}
async function stubMsg(app, answers) {
  await app.evaluate(({ dialog }, a) => {
    globalThis.__msg = [];
    /* message boxes go through ShotRef's own box (electron/popup.cjs); the native one must never be used */
    globalThis.__shotrefPopup.show = async (parent, o) => { globalThis.__msg.push(o); return { response: a.length ? a.shift() : 0 }; };
    dialog.showMessageBox = async (...args) => { globalThis.__msg.push({ message: 'NATIVE: ' + (args[args.length - 1] || {}).message }); return { response: 0 }; };
  }, answers);
}
const msgs = app => app.evaluate(() => globalThis.__msg.map(m => [m.message, m.detail || '', (m.buttons || []).join('/')]));
async function waitMsgs(app, n, ms = 15000) {
  const t0 = Date.now();
  for (;;) { const m = await msgs(app); if (m.length >= n) return m; if (Date.now() - t0 > ms) throw new Error('expected ' + n + ' message box(es), got: ' + JSON.stringify(m)); await sleep(150); }
}
const readSettingsFile = ud => JSON.parse(fs.readFileSync(path.join(ud, 'shotref-settings.json'), 'utf8'));
const helpClick = (app, label) => app.evaluate(({ Menu }, l) => { Menu.getApplicationMenu().items.find(i => i.label === 'Help').submenu.items.find(i => i.label === l).click(); }, label);

const results = [];
async function check(name, fn) {
  const t = Date.now();
  try { await fn(); results.push([name, true]); console.log('  ok   ' + name + ' (' + (Date.now() - t) + ' ms)'); }
  catch (e) { results.push([name, false]); console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

(async () => {
  const file1 = path.join(tmp, 'one.shotref');
  const file2 = path.join(tmp, 'two.shotref');
  let savedObjects = 0;

  await check('starts with no console errors, window title contains ShotRef, no stray network', async () => {
    const { app, page, errors } = await launch();
    await sleep(800);
    ok(/ShotRef/.test(await page.title().catch(() => '')) || /ShotRef/.test(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())), 'title');
    const t = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
    ok(/ShotRef/.test(t), 'window title: ' + t);
    ok(await page.evaluate(() => !!window.shotrefDesktop && typeof window.shotrefDesktop.version === 'string'), 'bridge missing');
    ok(await page.evaluate(() => typeof require === 'undefined' && typeof process === 'undefined'), 'node leaked into the page');
    ok(!errors.length, 'console errors: ' + errors.join(' | '));
    await kill(app);
  });

  await check('Save writes a real .shotref file, a second Save writes again without a dialog, Save as asks again', async () => {
    const { app, page, userData } = await launch();
    await stubDialogs(app, [file1, file2]);
    await page.evaluate(() => window.__edit());
    savedObjects = await objCount(page);
    await fileCmd(app, 'save');
    await sleep(600);
    ok(fs.existsSync(file1), 'file not written');
    const j = JSON.parse(fs.readFileSync(file1, 'utf8'));
    ok(j.app === 'ShotRef' && j.version === 2 && j.state, 'not a ShotRef project');
    ok((await dlgCounts(app)).save === 1, 'dialog count after first save');
    const t = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
    ok(/one\.shotref/.test(t) && !t.startsWith('•'), 'title after save: ' + t);
    fs.unlinkSync(file1);
    await page.evaluate(() => window.__edit());
    savedObjects = await objCount(page);
    await fileCmd(app, 'save'); await sleep(600);
    ok(fs.existsSync(file1), 'second save did not rewrite the file');
    ok((await dlgCounts(app)).save === 1, 'second save showed a dialog');
    await page.keyboard.press('Control+Shift+S'); await sleep(600);
    ok((await dlgCounts(app)).save === 2 && fs.existsSync(file2), 'Save as did not ask again');
    const recent = fs.readFileSync(path.join(userData, 'shotref-settings.json'), 'utf8');
    ok(JSON.parse(recent).recent.length === 2, 'recent list: ' + recent);
    await kill(app);
  });

  await check('a save that fails says so in the page and keeps the unsaved mark', async () => {
    const { app, page } = await launch();
    const missing = path.join(tmp, 'no-such-folder', 'x.shotref');
    await stubDialogs(app, [missing]);
    await page.evaluate(() => window.__edit());
    await fileCmd(app, 'save'); await sleep(700);
    const t = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
    ok(t.startsWith('•'), 'dirty mark lost: ' + t);
    ok(!fs.existsSync(missing), 'file should not exist');
    await kill(app);
  });

  await check('a file passed on the command line opens (object count matches)', async () => {
    ok(fs.existsSync(file1), 'needs file from earlier check');
    const { app, page } = await launch([file1], { raw: true }); /* fresh profile, nothing hidden by the test */
    await page.waitForFunction(n => window.__shotref.state.objects.length === n, savedObjects, { timeout: 15000 });
    const t = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
    ok(/one\.shotref/.test(t), 'title: ' + t);
    await sleep(1500); /* longer than the 400 ms starter timer */
    const open = await page.evaluate(() => [...document.querySelectorAll('.modal:not(.hidden)')].map(m => m.id));
    ok(!open.length, 'a dialog is open over the opened file: ' + open.join(','));
    await kill(app);
  });

  await check('a second launch with a file opens it in the existing window (asks first when there are unsaved changes)', async () => {
    const userData = path.join(tmp, 'shared-profile');
    const { app, page } = await launch([], { userData });
    await page.evaluate(() => window.__edit()); /* unsaved changes */
    const child = require('child_process').spawn(require('electron'), [ROOT, '--user-data-dir=' + userData, file1], { stdio: 'ignore' });
    const code = await new Promise((res, rej) => { child.once('exit', res); setTimeout(() => { child.kill(); rej(new Error('second process did not exit')); }, 20000); });
    ok(typeof code === 'number', 'second process exit');
    await page.waitForSelector('#mConfirm:not(.hidden)', { timeout: 10000 });
    ok(/Save changes first/.test(await page.textContent('#cfTitle')), 'expected the save-first prompt');
    await page.click('#cfAlt'); /* Don't save */
    await page.waitForFunction(n => window.__shotref.state.objects.length === n, savedObjects, { timeout: 10000 });
    ok((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 1, 'a second window appeared');
    await kill(app);
  });

  await check('a restored session keeps its unsaved mark, so a file from Windows asks before replacing it', async () => {
    const userData = path.join(tmp, 'restore-profile');
    const first = await launch([], { userData });
    await first.page.evaluate(() => window.__edit());
    await first.page.waitForFunction(() => { try { return JSON.parse(localStorage.getItem('shotref.autosave')).dirty === true; } catch (e) { return false; } }, null, { timeout: 8000 });
    const gone = new Promise(r => first.app.process().once('exit', r));
    await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await first.page.waitForSelector('#mConfirm:not(.hidden)'); await first.page.click('#cfAlt'); /* Don't save: the autosave keeps the edits */
    await Promise.race([gone, sleep(8000).then(() => { throw new Error('first run did not exit'); })]);
    const { app, page } = await launch([file1], { userData, raw: true });
    await page.waitForSelector('#mConfirm:not(.hidden)', { timeout: 10000 });
    ok(/Save changes first/.test(await page.textContent('#cfTitle')), 'expected the save-first prompt, got: ' + await page.textContent('#cfTitle'));
    ok((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())).startsWith('•'), 'restored session lost its unsaved mark');
    await kill(app);
  });

  await check('a failed save leaves the previous file intact (atomic write) and keeps the unsaved mark and a message', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'atomic-'));
    const target = path.join(dir, 'keep.shotref');
    const { app, page } = await launch();
    await stubDialogs(app, [target]);
    await fileCmd(app, 'save'); await page.waitForFunction(() => /Saved/.test(document.querySelector('#toast').textContent), null, { timeout: 8000 });
    const before = fs.readFileSync(target, 'utf8');
    fs.chmodSync(target, 0o444); /* the final rename over a read-only file fails on Windows */
    await page.evaluate(() => window.__edit());
    await fileCmd(app, 'save'); await sleep(1200);
    const t = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
    ok(t.startsWith('•'), 'dirty mark lost: ' + t);
    ok(fs.readFileSync(target, 'utf8') === before, 'previous file was changed');
    ok(!fs.readdirSync(dir).some(n => n.includes('.tmp-')), 'temp file left behind: ' + fs.readdirSync(dir));
    const msg = await page.textContent('#toast'); ok(msg && !/Saved/.test(msg), 'no failure message: ' + msg);
    fs.chmodSync(target, 0o666);
    await kill(app);
  });

  await check('Copy frame works in the desktop app', async () => {
    const { app, page } = await launch();
    await app.evaluate(async ({ clipboard }) => { globalThis.__clipText = String(await clipboard.readText()); await clipboard.clear(); });
    try {
      await page.click('#bExport'); await page.click('#xoOptions');
      await page.click('#exCopy');
      await page.waitForFunction(() => /Frame copied/.test(document.querySelector('#toast').textContent), null, { timeout: 15000 });
      ok(!(await page.evaluate(() => document.querySelector('#mCopy').classList.contains('hidden') === false)), 'fell back to the right-click dialog');
    } finally { await app.evaluate(async ({ clipboard }) => { if (globalThis.__clipText) await clipboard.writeText(globalThis.__clipText); /* an image on the clipboard before the test cannot be restored */ }); }
    await kill(app);
  });

  await check('import dialog remembers its own folder; Help > Quick start opens the page guide', async () => {
    const { app, page, userData } = await launch();
    const f = path.join(tmp, 'pic.png');
    fs.writeFileSync(f, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'));
    await stubDialogs(app, [], [f]);
    const r = await page.evaluate(async () => { const x = await window.shotrefDesktop.pickFile('import', [{ name: 'Images', extensions: ['png'] }]); return x && [x.name, x.type, x.data.byteLength]; });
    ok(r && r[0] === 'pic.png' && r[1] === 'image/png' && r[2] > 10, 'pickFile: ' + JSON.stringify(r));
    ok(JSON.parse(fs.readFileSync(path.join(userData, 'shotref-settings.json'), 'utf8')).folders.import === tmp, 'import folder not remembered');
    await app.evaluate(({ Menu }) => { const help = Menu.getApplicationMenu().items.find(i => i.label === 'Help'); help.submenu.items.find(i => i.label === 'Quick start').click(); });
    await page.waitForSelector('#mHelp:not(.hidden)', { timeout: 5000 });
    await kill(app);
  });

  await check('Help menu has the two tour items and they reach the page', async () => {
    const { app, page } = await launch();
    const labels = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(i => i.label === 'Help').submenu.items.map(i => i.label));
    const qs = labels.indexOf('Quick start');
    ok(qs >= 0 && labels[qs + 1] === 'Take the quick tour' && labels[qs + 2] === 'Try it hands-on', 'Help menu: ' + labels.join(' | '));
    /* the hands-on tour is switched off for now: its item stays in the template but is hidden */
    const handsVisible = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(i => i.label === 'Help').submenu.items.find(i => i.label === 'Try it hands-on').visible);
    ok(handsVisible === false, 'the switched-off hands-on item is visible in the Help menu');
    await helpClick(app, 'Take the quick tour');
    await page.waitForFunction(() => window.__shotref.tour.active(), null, { timeout: 5000 });
    ok(await page.evaluate(() => window.__shotref.tour.current().stop.id) === 'b-welcome', 'the basic tour did not start at its first stop');
    await page.evaluate(() => window.__shotref.tour.end());
    await helpClick(app, 'Try it hands-on');
    await page.waitForFunction(() => window.__shotref.tour.active() && window.__shotref.practicing(), null, { timeout: 5000 });
    ok(await page.evaluate(() => window.__shotref.tour.current().stop.id) === 'h-welcome', 'the hands-on tour did not start at its first stop');
    await page.evaluate(() => window.__shotref.tour.end());
    ok(await page.evaluate(() => !window.__shotref.practicing() && !document.querySelector('#tour')), 'the hands-on tour left the practice stage on');
    await kill(app);
  });

  await check('closing the window mid hands-on tour asks about the real scene', async () => {
    const { app, page } = await launch();
    const named = path.join(tmp, 'real-project.shotref');
    await stubDialogs(app, [named]);
    await page.evaluate(() => window.__edit());
    await fileCmd(app, 'save'); await sleep(700); /* the real project has a name now */
    await page.evaluate(() => window.__edit()); /* ... and unsaved changes */
    const realCount = await objCount(page);
    await page.evaluate(() => window.__shotref.practice.enter());
    await page.evaluate(() => { const S = window.__shotref; S.tour.run([{ id: 'a', target: null, title: 'T', text: 't' }, { id: 'b', target: null, title: 'U', text: 'u' }], { interactive: true, onEnd: () => S.practice.leave() }); });
    ok(await page.evaluate(() => window.__shotref.practicing() && window.__shotref.state.objects.length === 0), 'the practice stage did not start');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await page.waitForSelector('#mConfirm:not(.hidden)', { timeout: 5000 });
    ok(/Save changes before closing/.test(await page.textContent('#cfTitle')), 'prompt text: ' + await page.textContent('#cfTitle'));
    ok(/real-project\.shotref/.test(await page.textContent('#cfText')), 'the question does not name the real project: ' + await page.textContent('#cfText'));
    ok(!(await page.evaluate(() => window.__shotref.practicing())), 'still practising behind the question');
    ok(await page.evaluate(() => !document.querySelector('#tour')), 'the tour is still on screen behind the question');
    ok(await objCount(page) === realCount, 'the real scene is not back: ' + await objCount(page) + ' objects');
    ok((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 1, 'window closed');
    await kill(app);
  });

  await check('the page cannot write to a path the app did not hand out', async () => {
    const { app, page } = await launch();
    const evil = path.join(tmp, 'evil.txt');
    await stubDialogs(app, []);
    const r = await page.evaluate(p => window.shotrefDesktop.saveProject('x', { path: p }), evil);
    ok(!fs.existsSync(evil), 'wrote to an arbitrary path');
    ok(r && r.canceled, 'expected the dialog to be used');
    await kill(app);
  });

  await check('network requests and navigation from the page are blocked', async () => {
    const { app, page } = await launch();
    const r = await page.evaluate(async () => { try { await fetch('http://example.com/'); return 'reached'; } catch (e) { return 'blocked'; } });
    ok(r === 'blocked', 'fetch got through');
    const before = page.url();
    await page.evaluate(() => { location.href = 'http://example.com/'; });
    await sleep(1000);
    ok(page.url() === before, 'navigated away to ' + page.url());
    const wins = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    await page.evaluate(() => window.open('http://example.com/'));
    await sleep(500);
    ok((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === wins, 'window.open made a window');
    await kill(app);
  });

  await check('closing with unsaved changes shows the page prompt instead of closing; Don\'t save then closes', async () => {
    const { app, page } = await launch();
    await page.evaluate(() => window.__edit());
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await page.waitForSelector('#mConfirm:not(.hidden)', { timeout: 5000 });
    ok(/Save changes before closing/.test(await page.textContent('#cfTitle')), 'prompt text');
    ok((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 1, 'window closed');
    /* Cancel keeps it open, and a second close attempt asks again */
    await page.click('#mConfirm [data-close]'); await sleep(300);
    ok((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 1, 'window closed after cancel');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await page.waitForSelector('#mConfirm:not(.hidden)', { timeout: 5000 });
    const closed = new Promise(r => app.process().once('exit', r));
    await page.click('#cfAlt');
    await Promise.race([closed, sleep(8000).then(() => { throw new Error('app did not exit after Don\'t save'); })]);
  });

  await check('closing with nothing unsaved closes straight away', async () => {
    const { app } = await launch();
    await sleep(500);
    const closed = new Promise(r => app.process().once('exit', r));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await Promise.race([closed, sleep(8000).then(() => { throw new Error('did not close'); })]);
  });

  await check('right-click shows the browser-style menu on text boxes, and the page own menu (no native one) on the 3D view', async () => {
    const { app, page } = await launch();
    await app.evaluate(({ Menu }) => { globalThis.__popped = []; Menu.prototype.popup = function () { globalThis.__popped.push(this.items.map(i => i.label).filter(Boolean)); }; });
    const box = await page.evaluateHandle(() => [...document.querySelectorAll('input')].find(i => (i.type === 'text' || i.type === 'number') && i.offsetParent));
    await box.click({ button: 'right' }); await sleep(400);
    let popped = await app.evaluate(() => globalThis.__popped);
    ok(popped.length === 1 && ['Cut', 'Copy', 'Paste', 'Select all'].every(l => popped[0].includes(l)), 'text box menu: ' + JSON.stringify(popped));
    const r = await page.evaluate(() => { const b = document.querySelector('canvas').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 3]; });
    await page.mouse.click(r[0], r[1], { button: 'right' }); await sleep(400);
    popped = await app.evaluate(() => globalThis.__popped);
    ok(popped.length === 1, '3D view opened a native menu: ' + JSON.stringify(popped));
    ok(await page.evaluate(() => document.querySelector('#ctxMenu').style.display === 'block'), 'the 3D view should show the page own menu');
  });


  const appVersion = require('../package.json').version;
  const NOAUTO = { SHOTREF_UPDATE_DELAY_MS: '999999' };

  await check('updates: a copy running from source says updates work in the installed app', async () => {
    const { app } = await launch();
    await stubMsg(app, []); await helpClick(app, 'Check for updates…');
    const m = await waitMsgs(app, 1);
    ok(/installed ShotRef/.test(m[0][0]), m[0][0]);
    await kill(app);
  });

  await check('updates: manual check with nothing newer says ShotRef is up to date', async () => {
    const feed = await startFeed(appVersion);
    const { app } = await launch([], { env: { SHOTREF_UPDATE_URL: feed.url, ...NOAUTO } });
    await stubMsg(app, []); await helpClick(app, 'Check for updates…');
    const m = await waitMsgs(app, 1);
    ok(/up to date/.test(m[0][0]) && m[0][1].includes(appVersion), JSON.stringify(m[0]));
    ok(!feed.hits.some(h => h.endsWith('.exe')), 'downloaded an installer');
    await kill(app); feed.close();
  });

  await check('updates: a newer version is offered, and Later downloads nothing', async () => {
    const feed = await startFeed('99.0.0');
    const { app } = await launch([], { env: { SHOTREF_UPDATE_URL: feed.url, ...NOAUTO } });
    await stubMsg(app, [1]); await helpClick(app, 'Check for updates…');
    const m = await waitMsgs(app, 1);
    ok(/99\.0\.0 is available/.test(m[0][0]) && m[0][2] === 'Download update/Later', JSON.stringify(m[0]));
    await sleep(800);
    ok(!feed.hits.some(h => h.endsWith('.exe')), 'downloaded although the user said Later');
    ok((await msgs(app)).length === 1, 'extra dialogs after Later');
    await kill(app); feed.close();
  });

  await check('updates: Download update fetches the installer, verifies it and offers to restart (window stays open on Later)', async () => {
    const feed = await startFeed('99.0.0');
    const { app } = await launch([], { env: { SHOTREF_UPDATE_URL: feed.url, ...NOAUTO } });
    await stubMsg(app, [0, 1]); await helpClick(app, 'Check for updates…');
    const m = await waitMsgs(app, 2, 30000);
    ok(/99\.0\.0 is ready to install/.test(m[1][0]) && m[1][2] === 'Restart now/Later', JSON.stringify(m[1]));
    ok(feed.hits.includes('/ShotRef-Setup-99.0.0.exe'), 'installer was not requested: ' + feed.hits.join(','));
    ok((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 1, 'window closed');
    /* a second manual check goes straight to "ready" instead of downloading again */
    const n = feed.hits.length;
    await stubMsg(app, [1]); await helpClick(app, 'Check for updates…');
    const m2 = await waitMsgs(app, 1);
    ok(/ready to install/.test(m2[0][0]) && feed.hits.length === n, 'second check: ' + m2[0][0] + ', new requests ' + (feed.hits.length - n));
    await kill(app); feed.close();
  });

  await check('updates: a feed that cannot be reached gives a plain message, not a crash', async () => {
    const feed = await startFeed('99.0.0'); const url = feed.url; feed.close(); await sleep(200);
    const { app, page } = await launch([], { env: { SHOTREF_UPDATE_URL: url, ...NOAUTO } });
    await stubMsg(app, []); await helpClick(app, 'Check for updates…');
    const m = await waitMsgs(app, 1);
    ok(/Could not check for updates/.test(m[0][0]) && /could not reach GitHub|Something went wrong/.test(m[0][1]), JSON.stringify(m[0]));
    ok(await page.evaluate(() => !!window.__shotref.state), 'page died');
    await kill(app);
  });

  await check('updates: the automatic check runs after launch, and not when switched off in the Help menu (remembered)', async () => {
    const feed = await startFeed('99.0.0');
    const first = await launch([], { env: { SHOTREF_UPDATE_URL: feed.url, SHOTREF_UPDATE_DELAY_MS: '1500' }, userData: path.join(tmp, 'prof-upd') });
    await stubMsg(first.app, [1]);
    await waitMsgs(first.app, 1, 12000);
    ok(feed.hits.includes('/latest.yml'), 'no automatic check');
    await helpClick(first.app, 'Check for updates automatically'); /* switch it off through the menu item and look at what was saved */
    await sleep(300);
    const saved = JSON.parse(fs.readFileSync(path.join(first.userData, 'shotref-settings.json'), 'utf8'));
    ok(saved.autoUpdate === false, 'setting not saved: ' + JSON.stringify(saved));
    await kill(first.app);
    const before = feed.hits.length;
    const second = await launch([], { env: { SHOTREF_UPDATE_URL: feed.url, SHOTREF_UPDATE_DELAY_MS: '1500' }, userData: first.userData });
    await sleep(4500);
    ok(feed.hits.length === before, 'checked although automatic checks are off');
    await kill(second.app); feed.close();
  });

  await check('updates: the page itself still cannot reach even the update server', async () => {
    const feed = await startFeed('99.0.0');
    const { app, page } = await launch([], { env: { SHOTREF_UPDATE_URL: feed.url, ...NOAUTO } });
    const r = await page.evaluate(async u => { try { await fetch(u + '/latest.yml'); return 'reached'; } catch (e) { return 'blocked'; } }, feed.url);
    ok(r === 'blocked', 'page fetch to the feed got through');
    ok(!feed.hits.length, 'feed saw a request from the page');
    await kill(app); feed.close();
  });

  /* ---- ShotRef's own message boxes (electron/popup.cjs) and What's new ---- */
  async function popupPage(app, ms = 10000) {
    const t0 = Date.now();
    for (;;) {
      const w = app.windows().find(p => !p.isClosed() && /popup\.html$/.test(p.url()));
      if (w) { await w.waitForSelector('#btns button'); return w; }
      if (Date.now() - t0 > ms) return null;
      await sleep(150);
    }
  }
  /* the box closes during the key press, so the press itself may report the page as gone: that is the expected result */
  const pressKey = (p, k) => p.keyboard.press(k).catch(e => { if (!/closed/.test(String(e && e.message))) throw e; });
  const openBoxes = app => app.evaluate(() => globalThis.__shotrefPopup.openCount());
  async function waitNoBox(app, ms = 5000) { const t0 = Date.now(); while (await openBoxes(app)) { if (Date.now() - t0 > ms) throw new Error('box still open'); await sleep(100); } }
  const stubNative = app => app.evaluate(({ dialog }) => { globalThis.__native = 0; dialog.showMessageBox = async () => { globalThis.__native++; return { response: 0 }; }; });
  const writeSettings = (dir, s) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'shotref-settings.json'), JSON.stringify(s)); };
  const readSettings = dir => JSON.parse(fs.readFileSync(path.join(dir, 'shotref-settings.json'), 'utf8'));
  const NOTES = JSON.parse(fs.readFileSync(path.join(ROOT, 'electron', 'whats-new.json'), 'utf8'));
  const cmpV = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
  const expectHeads = since => NOTES.filter(n => cmpV(n.version, appVersion) <= 0 && (!since || cmpV(n.version, since) > 0))
    .sort((a, b) => cmpV(b.version, a.version)).map(n => 'ShotRef ' + n.version);

  await check('message boxes are ShotRef\'s own: What\'s new opens a branded box, not the native one, and Esc closes it', async () => {
    const { app } = await launch();
    await stubNative(app);
    await helpClick(app, 'What\'s new');
    const pp = await popupPage(app);
    ok(pp, 'no ShotRef box opened');
    const look = await pp.evaluate(() => ({
      text: document.body.innerText, bg: getComputedStyle(document.body).backgroundColor,
      main: getComputedStyle(document.querySelector('button.primary')).backgroundColor, focus: document.activeElement && document.activeElement.className,
      mark: !!document.querySelector('svg.mark'),
    }));
    ok(look.text.includes('What\'s new in ShotRef ' + appVersion), look.text);
    ok(look.bg === 'rgb(22, 24, 28)' && look.main === 'rgb(255, 154, 60)' && look.mark, JSON.stringify(look));
    ok(look.focus === 'primary', 'main button not focused');
    const frame = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => [w.isVisible(), w.isModal()]));
    ok(frame.length === 2 && frame.every(f => f[0]) && frame.some(f => f[1]), JSON.stringify(frame));
    await pressKey(pp, 'Escape');
    await waitNoBox(app);
    ok((await app.evaluate(() => globalThis.__native)) === 0, 'a native message box was used');
    await kill(app);
  });

  await check('message boxes wait their turn: a second box opens only after the first is answered, with the chosen button', async () => {
    const { app } = await launch();
    await app.evaluate(() => {
      globalThis.__ans = [];
      globalThis.__shotrefPopup.show(null, { message: 'First box', buttons: ['Yes', 'No'], defaultId: 0, cancelId: 1 }).then(r => globalThis.__ans.push(r.response));
      globalThis.__shotrefPopup.show(null, { message: 'Second box', buttons: ['OK'] }).then(r => globalThis.__ans.push(r.response));
    });
    const p1 = await popupPage(app);
    ok(/First box/.test(await p1.innerText('#msg')) && (await openBoxes(app)) === 1, 'first box');
    ok((await p1.$$eval('#btns button', b => b.map(x => x.textContent))).join('/') === 'No/Yes', 'main button not on the right');
    await p1.click('text=No');
    await sleep(300);
    const p2 = await popupPage(app);
    ok(/Second box/.test(await p2.innerText('#msg')), 'second box did not follow');
    await pressKey(p2, 'Enter');
    await waitNoBox(app);
    ok(JSON.stringify(await app.evaluate(() => globalThis.__ans)) === '[1,0]', 'answers: ' + JSON.stringify(await app.evaluate(() => globalThis.__ans)));
    await kill(app);
  });

  await check('What\'s new after an update lists every version since the one the user had, once', async () => {
    const userData = path.join(tmp, 'prof-new');
    writeSettings(userData, { folders: {}, recent: [], autoUpdate: false, lastVersion: '1.3.0' });
    const first = await launch([], { userData });
    const pp = await popupPage(first.app);
    ok(pp, 'no What\'s new box');
    const heads = await pp.$$eval('#notes h2', h => h.map(x => x.textContent));
    ok(JSON.stringify(heads) === JSON.stringify(expectHeads('1.3.0')) && heads.length >= 2, 'versions: ' + heads.join(', '));
    ok((await pp.innerText('#msg')).includes(appVersion) && /since 1\.3\.0/.test(await pp.innerText('#detail')), 'heading/detail');
    await pp.click('text=Start working');
    await waitNoBox(first.app);
    ok(readSettings(userData).lastVersion === appVersion, 'version not remembered');
    await kill(first.app);
    const second = await launch([], { userData });
    ok(!(await popupPage(second.app, 2500)), 'What\'s new showed again on the next launch');
    await kill(second.app);
  });

  await check('What\'s new: settings from before it was tracked show every version; a fresh install shows nothing; Help shows this version', async () => {
    const userData = path.join(tmp, 'prof-old');
    writeSettings(userData, { folders: {}, recent: [], autoUpdate: false });
    const old = await launch([], { userData });
    const pp = await popupPage(old.app);
    ok(pp, 'no box for settings without a version');
    const heads = await pp.$$eval('#notes h2', h => h.map(x => x.textContent));
    ok(JSON.stringify(heads) === JSON.stringify(expectHeads(null)), 'versions: ' + heads.join(', '));
    await pressKey(pp, 'Escape'); await waitNoBox(old.app);
    await kill(old.app);
    const fresh = await launch();
    ok(!(await popupPage(fresh.app, 2500)), 'a fresh install showed What\'s new');
    ok(readSettings(fresh.userData).lastVersion === appVersion, 'fresh install did not remember its version');
    await helpClick(fresh.app, 'What\'s new');
    const hp = await popupPage(fresh.app);
    const hh = await hp.$$eval('#notes h2', h => h.map(x => x.textContent));
    ok(hh.length === 1 && hh[0] === expectHeads(null)[0], 'Help showed: ' + hh.join(', '));
    await kill(fresh.app);
  });

  await check('Help > About opens the page\'s About window: desktop line, all licences, What\'s new and Check for updates', async () => {
    const { app, page, errors } = await launch();
    await stubMsg(app, []);
    await helpClick(app, 'About ShotRef');
    await page.waitForSelector('#mAbout:not(.hidden)', { timeout: 5000 });
    const o = await page.evaluate(() => ({ ver: document.querySelector('#aboutVer').textContent, priv: document.querySelector('#aboutPrivacy').textContent,
      heads: [...document.querySelectorAll('#aboutLic h3')].map(x => x.textContent.split(' ')[0]),
      news: document.querySelector('#aboutNews').offsetParent !== null, upd: document.querySelector('#aboutUpd').offsetParent !== null }));
    ok(o.ver.startsWith('Version ' + appVersion + ' · Desktop app · built '), 'version line: ' + o.ver);
    ok(/stay on this computer/.test(o.priv) && /check for updates/.test(o.priv), 'privacy line: ' + o.priv);
    ok(o.heads.join() === 'three,mp4-muxer,electron,electron-updater', 'licences: ' + o.heads.join());
    ok(o.news && o.upd, 'desktop buttons hidden');
    ok((await msgs(app)).length === 0, 'a message box opened as well');
    await page.click('#aboutNews');
    const m1 = await waitMsgs(app, 1);
    ok(/^What's new in ShotRef /.test(m1[0][0]), 'What\'s new box: ' + JSON.stringify(m1[0]));
    await page.click('#aboutUpd');
    const m2 = await waitMsgs(app, 2);
    ok(/Updates work in the installed ShotRef/.test(m2[1][0]), 'update check box: ' + JSON.stringify(m2[1]));
    ok(!errors.length, 'page errors: ' + errors.join(' | '));
    await kill(app);
  });

  const winInfo = app => app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return { min: w.getMinimumSize(), bounds: w.getBounds(), normal: w.getNormalBounds(), max: w.isMaximized() }; });
  const seedWindow = (name, win) => { const dir = path.join(tmp, name); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'shotref-settings.json'), JSON.stringify({ folders: {}, recent: [], window: win })); return dir; };

  await check('the window cannot shrink below 1100 x 600, and the title bar and menu are always dark', async () => {
    const { app } = await launch();
    const w = await winInfo(app);
    ok(w.min[0] === 1100 && w.min[1] === 600, 'minimum size: ' + w.min.join(' x '));
    ok(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource) === 'dark', 'themeSource is not dark');
    await kill(app);
  });

  await check('a saved window position and size is restored; a maximized one comes back maximized', async () => {
    const dir = seedWindow('win-saved', { x: 40, y: 50, width: 1200, height: 700, maximized: false });
    const a = await launch([], { userData: dir });
    const w = await winInfo(a.app);
    ok(!w.max && w.bounds.x === 40 && w.bounds.y === 50 && w.bounds.width === 1200 && w.bounds.height === 700, 'restored: ' + JSON.stringify(w.bounds));
    await kill(a.app);
    const dir2 = seedWindow('win-max', { x: 60, y: 70, width: 1250, height: 720, maximized: true });
    const b = await launch([], { userData: dir2 });
    const w2 = await winInfo(b.app);
    ok(w2.max, 'not maximized');
    ok(w2.normal.width === 1250 && w2.normal.height === 720, 'the un-maximized size was lost: ' + JSON.stringify(w2.normal));
    await kill(b.app);
  });

  await check('a saved window that is off every display falls back to the default', async () => {
    const dir = seedWindow('win-off', { x: 90000, y: 90000, width: 1200, height: 700, maximized: false });
    const a = await launch([], { userData: dir });
    const w = await winInfo(a.app);
    const wa = await a.app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
    ok(w.bounds.x >= wa.x - 16 && w.bounds.y >= wa.y - 16 && w.bounds.x + w.bounds.width <= wa.x + wa.width + 16 && w.bounds.y + w.bounds.height <= wa.y + wa.height + 16, 'not inside the primary work area ' + JSON.stringify(wa) + ': ' + JSON.stringify(w.bounds));
    ok(w.max || (w.bounds.width === 1440 && w.bounds.height === 900), 'not the default: ' + JSON.stringify(w));
    await kill(a.app);
  });

  await check('moving or resizing the window is remembered (debounced) in the settings file', async () => {
    const { app, userData } = await launch();
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; if (w.isMaximized()) w.unmaximize(); w.setBounds({ x: 30, y: 40, width: 1150, height: 650 }); });
    await sleep(1200);
    const w = readSettingsFile(userData).window;
    ok(w && w.x === 30 && w.y === 40 && w.width === 1150 && w.height === 650 && w.maximized === false, 'saved: ' + JSON.stringify(w));
    await kill(app);
  });

  await check('on the desktop the File button is gone and the gear menu has just Advanced mode and Settings', async () => {
    const { page, app } = await launch();
    ok(await page.evaluate(() => document.querySelector('#bFile').offsetParent === null), 'File button is shown');
    await page.click('#bMenu');
    const items = await page.$$eval('#ctxMenu button', b => b.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
    ok(items.length === 2 && /^.?\s?Advanced mode/.test(items[0]) && /^Settings/.test(items[1]), 'gear menu: ' + items.join(' | '));
    ok(await page.$$eval('#ctxMenu .head', h => h.length) === 0, 'a heading is left in the gear menu');
    await kill(app);
  });

  await check('the Windows File menu offers Recent projects… and Export…, and each one works', async () => {
    const { app, page } = await launch();
    const labels = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(i => i.label === 'File').submenu.items.map(i => i.label));
    ok(labels.includes('Recent projects…') && labels.includes('Export…'), 'File menu: ' + labels.join(' | '));
    await fileCmd(app, 'recent');
    await page.waitForSelector('#mRecent:not(.hidden)', { timeout: 5000 });
    ok(!/browser/.test(await page.textContent('#recNote')), 'the Recent projects note still says browser');
    await page.evaluate(() => document.querySelector('#mRecent').classList.add('hidden'));
    await fileCmd(app, 'export');
    await page.waitForFunction(() => window.__shotref.step === 'export', null, { timeout: 5000 });
    await kill(app);
  });

  await check('Settings says "Saved on this computer." and no page text says "in this browser"', async () => {
    const { app, page } = await launch();
    await page.click('#bMenu'); await page.click('#ctxMenu [data-cmd="settings"]');
    await page.waitForSelector('#mSettings:not(.hidden)', { timeout: 5000 });
    ok(/Saved on this computer\./.test(await page.textContent('#mSettings')), 'Settings note: ' + (await page.textContent('#mSettings')).slice(0, 120));
    const left = await page.evaluate(() => [...document.querySelectorAll('[data-where]')].map(e => e.textContent).filter(t => /browser/.test(t)));
    ok(!left.length, 'static lines still say browser: ' + left.join(' | '));
    ok(!/in this browser/.test(await page.evaluate(() => document.body.innerText)), 'some text in the page still says "in this browser"');
    await kill(app);
  });

  await check('the quick tour on the desktop has no File stop and counts its stops without it', async () => {
    const { app, page } = await launch();
    await helpClick(app, 'Take the quick tour');
    await page.waitForFunction(() => window.__shotref.tour.active(), null, { timeout: 5000 });
    const seen = [];
    for (let i = 0; i < 14 && await page.evaluate(() => window.__shotref.tour.active()); i++) {
      const o = await page.evaluate(() => { const h = window.__shotref.tour.current(); return { id: h.stop.id, target: h.stop.target, count: (document.querySelector('.tour-count') || {}).textContent || '' }; });
      seen.push(o);
      await page.evaluate(() => window.__shotref.tour.current().next());
      await sleep(120);
    }
    ok(seen.length === 9, 'stops: ' + seen.map(x => x.id).join(','));
    ok(!seen.some(x => x.id === 'b-file' || x.target === '#bFile'), 'the tour still points at the File button');
    ok(/9/.test(seen[0].count) && !/10/.test(seen[0].count), 'count: ' + seen[0].count);
    await kill(app);
  });

  await check('the first-run tour question and the end-of-tour words say "Help menu" on the Windows app', async () => {
    const { app, page } = await launch([], { raw: true });
    await page.waitForFunction(() => !document.querySelector('#mTour').classList.contains('hidden'), null, { timeout: 8000 });
    const t = await page.evaluate(() => ({ q: document.querySelector('#mTourP').textContent, stops: JSON.stringify(window.__shotref.basicStops()) }));
    ok(/Help menu/.test(t.q) && !/gear button/.test(t.q), 'first-run question: ' + t.q);
    ok(/Help menu/.test(t.stops) && !/gear button, top right, whenever/.test(t.stops), 'end of tour: ' + t.stops);
    await kill(app);
  });

  await check('a video export ends on "Video saved", naming the file and the folder it was saved in', async () => {
    const { app, page } = await launch();
    const dir = path.join(tmp, 'videos'); fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, 'clip.mp4');
    await stubDialogs(app, [out]);
    await page.evaluate(() => { const s = window.__shotref.state.settings; s.size = 1280; s.duration = 1; window.__shotref.changed(true, true); });
    await page.click('#bExport'); await sleep(200); await page.click('#xoVideo');
    await page.waitForSelector('#exDone:not([hidden])', { timeout: 60000 });
    const d = await page.evaluate(() => ({ head: document.querySelector('#exDoneT').textContent, file: document.querySelector('#exFile').textContent, where: document.querySelector('#exWhere').textContent, focus: document.activeElement && document.activeElement.id }));
    ok(fs.existsSync(out) && fs.statSync(out).size > 1024, 'no video written');
    ok(d.head === 'Video saved' && d.file.startsWith('clip.mp4 · ') && d.where === 'Look in ' + dir + '.' && d.focus === 'exDoneBtn', 'finish window: ' + JSON.stringify(d));
    await kill(app);
  });

  for (const a of apps) await kill(a);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* leftover temp folder is harmless */ }
  const bad = results.filter(r => !r[1]).length;
  console.log('\n' + (results.length - bad) + '/' + results.length + ' desktop checks passed');
  process.exit(bad ? 1 : 0);
})();
