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
  const app = await electron.launch({ executablePath: require('electron'), args: [ROOT, '--user-data-dir=' + userData, ...args], cwd: ROOT });
  apps.push(app);
  const page = await app.firstWindow();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.waitForFunction(() => window.__shotref && window.__shotref.state, null, { timeout: 30000 });
  page.setDefaultTimeout(8000);
  if (!opts.raw) { /* first launch opens the starter sets: close them so clicks reach the page */
    await page.waitForFunction(() => !document.querySelector('#mStart').classList.contains('hidden'), null, { timeout: 4000 }).catch(() => {});
    await page.evaluate(() => document.querySelector('#mStart').classList.add('hidden'));
  }
  await page.evaluate(() => { window.__edit = () => { window.__shotref.addObject('box'); window.__shotref.changed(true); }; });
  return { app, page, errors, userData };
}
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
const kill = async app => { try { app.process().kill(); } catch (e) { /* gone */ } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    await page.click('#bSave');
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
    await page.click('#bSave'); await sleep(600);
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
    await page.click('#bSave'); await sleep(700);
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
    await page.click('#bSave'); await page.waitForFunction(() => /Saved/.test(document.querySelector('#toast').textContent), null, { timeout: 8000 });
    const before = fs.readFileSync(target, 'utf8');
    fs.chmodSync(target, 0o444); /* the final rename over a read-only file fails on Windows */
    await page.evaluate(() => window.__edit());
    await page.click('#bSave'); await sleep(1200);
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
      await page.click('#bCopy');
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

  for (const a of apps) await kill(a);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* leftover temp folder is harmless */ }
  const bad = results.filter(r => !r[1]).length;
  console.log('\n' + (results.length - bad) + '/' + results.length + ' desktop checks passed');
  process.exit(bad ? 1 : 0);
})();
