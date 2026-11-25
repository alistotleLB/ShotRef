/* ShotRef smoke tests.
 *   node test/smoke.cjs [--only <substring>]
 * Needs: npm run build first (serves dist/ShotRef.html), Edge or Chrome installed.
 * Browser: env SHOTREF_BROWSER, else Edge, else Chrome.
 *
 * To add a check, append to the CHECKS section below:
 *   check('what it proves', async ({ page, open, freshContext, downloads, fixtures }) => {
 *     const p = await open();            // new page, window.__shotref ready, errors in p.__errors
 *     ... throw new Error('reason') to fail ...
 *   });
 * Known bugs: check('name', fn, { known: 'A2' }) reports KNOWN-FAIL (does not fail the run);
 * when it starts passing it reports UNEXPECTED-PASS (which fails the run: delete the flag).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const FIX = path.join(__dirname, 'fixtures');
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'; frame-src 'self'";
const MIME = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.glb': 'model/gltf-binary', '.json': 'application/json' };

/* ---------------- static server (random free port) ---------------- */
function startServer() {
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    let file = null, headers = {};
    if (u === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (u === '/app.html') { file = path.join(DIST, 'ShotRef.html'); headers['Content-Security-Policy'] = CSP; }
    else if (u.startsWith('/fixtures/')) file = path.join(FIX, path.basename(u));
    else file = path.join(DIST, path.basename(u));
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ...headers });
      res.end(buf);
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

function browserPath() {
  const list = [process.env.SHOTREF_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean);
  const found = list.find(p => fs.existsSync(p));
  if (!found) throw new Error('No browser found. Set SHOTREF_BROWSER to msedge.exe or chrome.exe');
  return found;
}

/* ---------------- registry ---------------- */
const CHECKS = [];
function check(name, fn, opts = {}) { CHECKS.push({ name, fn, known: opts.known || null, timeout: opts.timeout || 60000 }); }

/* ---------------- in-page helpers (init scripts) ---------------- */
const DL_SCRIPT = `(() => {
  window.__dl = [];
  const orig = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (!this.hasAttribute('download')) return orig.call(this);
    const name = this.getAttribute('download');
    fetch(this.href).then(r => r.blob()).then(b => new Promise(res => { const fr = new FileReader(); fr.onload = () => res({ name, size: b.size, b64: String(fr.result).split(',')[1] || '' }); fr.readAsDataURL(b); })).then(d => window.__dl.push(d));
  };
})();`;

async function main() {
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
  if (!fs.existsSync(path.join(DIST, 'ShotRef.html'))) { console.error('dist/ShotRef.html is missing. Run: npm run build'); process.exit(2); }
  const server = await startServer();
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await chromium.launch({ executablePath: browserPath(), headless: true, args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });

  const todo = CHECKS.filter(c => !only || c.name.includes(only));
  let passed = 0, failed = 0, knownFail = 0;
  const t0 = Date.now();

  for (const c of todo) {
    const contexts = [];
    const newContext = async (viewport, firstLaunch) => {
      const ctx = await browser.newContext({ viewport: viewport || { width: 1440, height: 900 }, acceptDownloads: false });
      await ctx.addInitScript(DL_SCRIPT);
      if (!firstLaunch) await ctx.addInitScript(() => { try { localStorage.setItem('shotref.seenHelp', '1'); } catch (e) { } });
      contexts.push(ctx);
      return ctx;
    };
    const ctx = await newContext(c.viewport);
    const pageOf = async (cx, p, firstLaunch) => {
      const page = await cx.newPage();
      page.setDefaultTimeout(15000);
      page.__errors = [];
      page.on('pageerror', e => page.__errors.push('pageerror: ' + e.message));
      page.on('console', m => { if (m.type() === 'error') page.__errors.push('console: ' + m.text()); });
      await page.goto(base + (p || 'ShotRef.html'));
      await page.waitForFunction(() => window.__shotref && window.__shotref.state);
      return page;
    };
    const env = {
      ctx, fixtures: FIX, base,
      open: (p, o = {}) => pageOf(o.ctx || ctx, p, o.firstLaunch),
      /* isolated profile; opts {viewport, firstLaunch} */
      freshContext: async (o = {}) => { const cx = await newContext(o.viewport, o.firstLaunch); return { ctx: cx, open: p => pageOf(cx, p, o.firstLaunch) }; },
      /* captured downloads on a page: .wait('.png') resolves {name,size,bytes,text()} */
      downloads: page => ({
        async wait(ext, ms = 45000) {
          const end = Date.now() + ms;
          for (;;) {
            const list = await page.evaluate(() => window.__dl);
            const d = list.find(x => x.name.endsWith(ext));
            if (d) { const bytes = Buffer.from(d.b64, 'base64'); return { name: d.name, size: d.size, bytes, text: () => bytes.toString('utf8') }; }
            if (Date.now() > end) throw new Error('no ' + ext + ' download within ' + ms + ' ms (saw: ' + list.map(x => x.name).join(', ') + ')');
            await page.waitForTimeout(150);
          }
        },
      }),
    };
    env.page = null;
    let err = null, timer;
    try {
      await Promise.race([c.fn(env), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out after ' + c.timeout / 1000 + ' s')), c.timeout); })]);
    } catch (e) { err = e; }
    clearTimeout(timer);
    for (const cx of contexts) { try { await cx.close(); } catch (e) { } }

    if (!err && !c.known) { console.log('PASS ' + c.name); passed++; }
    else if (!err && c.known) { console.log('UNEXPECTED-PASS ' + c.name + ' (' + c.known + '): remove the known flag'); failed++; }
    else if (c.known) { console.log('KNOWN-FAIL ' + c.name + ' (' + c.known + '): ' + String(err.message).split('\n')[0]); knownFail++; }
    else { console.log('FAIL ' + c.name + ': ' + String(err.message).split('\n')[0]); failed++; }
  }

  await browser.close(); server.close();
  console.log(`${passed} passed, ${failed} failed` + (knownFail ? `, ${knownFail} known-fail` : '') + ` (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  process.exit(failed ? 1 : 0);
}

/* ---------------- small assertion helpers ---------------- */
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const sortKeys = v => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v;
const canon = v => JSON.stringify(sortKeys(v));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const noErrors = (page, what) => ok(page.__errors.length === 0, (what || 'page') + ' reported errors: ' + page.__errors.slice(0, 2).join(' | '));
/* uncaught exceptions only (a deliberate console.error is allowed) */
const noPageErrors = (page, what) => { const e = page.__errors.filter(x => x.startsWith('pageerror:')); ok(e.length === 0, (what || 'page') + ' threw ' + e.length + ' uncaught error(s): ' + (e[0] || '').slice(0, 100)); };
const stateOf = page => page.evaluate(() => JSON.parse(JSON.stringify(window.__shotref.state)));
/* menu helpers: open a dropdown button, then pick an item by its data-cmd (File menu #bFile, gear menu #bMenu) */
const menuCmd = async (p, opener, cmd) => { await p.click(opener); await p.click('#ctxMenu [data-cmd="' + cmd + '"]'); };
const fileCmd = (p, cmd) => menuCmd(p, '#bFile', cmd);
const gearCmd = (p, cmd) => menuCmd(p, '#bMenu', cmd);
/* Advanced mode on (the gear menu checkbox) */
const goAdvanced = async p => { if (await p.evaluate(() => document.body.classList.contains('simple'))) await gearCmd(p, 'advanced'); };

/* =================================================================== */
/*                               CHECKS                                */
/* =================================================================== */

check('loads with no errors', async ({ open }) => {
  const p = await open();
  await p.waitForTimeout(800);
  const n = await p.evaluate(() => window.__shotref.state.objects.length);
  ok(n === 3, 'expected 3 starter objects, got ' + n);
  noErrors(p);
});

check('strict CSP page loads', async ({ open }) => {
  const p = await open('app.html');
  await p.waitForTimeout(800);
  const n = await p.evaluate(() => window.__shotref.state.objects.length);
  ok(n === 3, 'expected 3 starter objects, got ' + n);
  noErrors(p, 'CSP page');
});

check('person moves between keys', async ({ open }) => {
  const p = await open();
  const x = await p.evaluate(() => {
    const S = window.__shotref, o = S.addObject('person');
    const tr = x => ({ p: [x, 0, 0], r: [0, 0, 0], s: [1, 1, 1] });
    S.setKey(o.keys, 0, tr(0)); S.setKey(o.keys, 2, tr(4));
    S.changed(true);
    return S.evalObj(o, 1).p[0];
  });
  ok(x > 0 && x < 4, 'x at t=1 should be between 0 and 4, got ' + x);
});

check('camera move adds keys', async ({ open }) => {
  const p = await open();
  const n = await p.evaluate(() => { window.__shotref.applyMove('dollyIn'); return window.__shotref.state.camera.keys.length; });
  ok(n >= 2, 'expected at least 2 camera keys, got ' + n);
});

check('save then open round-trips', async ({ open, freshContext, downloads }) => {
  const a = await open();
  await a.evaluate(() => { const S = window.__shotref; S.addObject('person'); S.applyMove('orbitL'); S.changed(true); });
  const before = await stateOf(a);
  await fileCmd(a, 'save');
  const file = await downloads(a).wait('.shotref');
  const fc = await freshContext();
  const b = await fc.open();
  await openFile(b, file.name, file.text()); /* the fresh page has a scene, so Open asks first */
  await b.waitForFunction(n => window.__shotref.state.objects.length === n, before.objects.length);
  await b.waitForTimeout(300);
  const after = await stateOf(b);
  ok(canon(after) === canon(before), 'state after open differs from state before save');
  noErrors(b, 'reopened page');
});

check('photo frame exports', async ({ open, downloads, fixtures }) => {
  const p = await open();
  await p.setInputFiles('#fPlate', path.join(fixtures, 'location.jpg'));
  await p.waitForFunction(() => window.__shotref.state.plate && window.__shotref.state.plate.asset);
  await p.waitForFunction(() => { const i = document.querySelector('.plateImg'); return i && i.getAttribute('src'); });
  await p.evaluate(() => window.__shotref.exportPNG(0));
  const f = await downloads(p).wait('.png');
  ok(f.size > 10240, 'PNG too small: ' + f.size + ' bytes');
  ok(f.bytes.slice(1, 4).toString() === 'PNG', 'download is not a PNG');
});

check('mp4 export works', async ({ open, downloads }) => {
  const p = await open();
  await p.evaluate(() => { const s = window.__shotref.state.settings; s.size = 1280; s.duration = 1; window.__shotref.changed(true); });
  await p.evaluate(() => { window.__shotref.exportVideo(); });
  const f = await downloads(p).wait('.mp4', 50000);
  ok(f.size > 10240, 'MP4 too small: ' + f.size + ' bytes');
  ok(f.bytes.slice(4, 8).toString() === 'ftyp', 'download is not an MP4 container');
}, { timeout: 80000 });

/* open a project file through #fOpen; accept the "Open file?" box if it appears */
async function openFile(p, name, text) {
  await p.setInputFiles('#fOpen', { name, mimeType: 'application/json', buffer: Buffer.from(text) });
  await p.waitForTimeout(400);
  const asked = await p.evaluate(() => { const m = document.querySelector('#mConfirm'); return !!m && !m.classList.contains('hidden'); });
  if (asked) await p.click('#cfOk');
  await p.waitForTimeout(600);
  return asked;
}
const CAM_BASE = '{"p":[3,1.6,6],"tg":[0,1,0],"f":35,"roll":0,"fd":7}';

check('damaged file keeps current scene', async ({ open }) => {
  const files = {
    'no objects': '{"app":"ShotRef","version":1,"state":{"camera":{"base":' + CAM_BASE + ',"keys":[]}}}',
    'objects without keys or opts': '{"app":"ShotRef","version":1,"state":{"camera":{"base":' + CAM_BASE + ',"keys":[]},"objects":[{"id":"a1","type":"box","base":{"p":[1,0,0],"r":[0,0,0],"s":[1,1,1]}},{"type":"person","base":{"p":[0,0,0],"r":[0,0,0],"s":[1,1,1]}}]}}',
    'camera without keys': '{"app":"ShotRef","version":1,"state":{"camera":{"base":' + CAM_BASE + '},"objects":[]}}',
    'object with empty base': '{"app":"ShotRef","version":1,"state":{"camera":{"base":' + CAM_BASE + ',"keys":[]},"objects":[{"id":"b1","type":"box","base":{},"keys":[{"t":"x"},{"t":1,"p":[0,0,0]}]}]}}',
  };
  for (const [what, text] of Object.entries(files)) {
    const p = await open();
    await openFile(p, 'damaged.shotref.json', text);
    /* either outcome is fine: (a) the 3-object scene is kept, or (b) the file loads normalised */
    const info = await p.evaluate(() => { const st = window.__shotref.state; return { isArr: Array.isArray(st.objects), n: Array.isArray(st.objects) ? st.objects.length : -1, cam: !!(st.camera && st.camera.base && Array.isArray(st.camera.keys)) }; });
    const kept = info.isArr && info.n === 3 && info.cam, normalised = info.isArr && info.cam;
    ok(kept || normalised, what + ': scene is broken: state.objects is ' + (info.isArr ? 'an array of ' + info.n : 'not an array') + ', camera ' + (info.cam ? 'ok' : 'broken') + (p.__errors[0] ? ' (' + p.__errors[0].slice(0, 90) + ')' : ''));
    noErrors(p, what + ': after opening');
    await p.reload();
    await p.waitForFunction(() => window.__shotref && window.__shotref.state, null, { timeout: 5000 }).catch(() => { throw new Error(what + ': __shotref missing after reload'); });
    await p.waitForTimeout(1000);
    noErrors(p, what + ': after reload');
    await p.close();
  }
}, { timeout: 90000 });

check('old v1 file opens', async ({ open }) => {
  const p = await open();
  const v1 = '{"app":"ShotRef","version":1,"state":{"settings":{"duration":4,"fps":24},"camera":{"base":' + CAM_BASE + ',"keys":[{"t":0,"p":[3,1.6,6],"tg":[0,1,0],"f":35,"roll":0,"fd":7}],"shake":0,"lookAtId":null,"follow":false},"objects":[{"id":"p1","type":"person","name":"Person 1","color":"#3d6fd8","opts":{"pose":"walk","height":1.75},"base":{"p":[0,0,0],"r":[0,0,0],"s":[1,1,1]},"keys":[],"visible":true}]},"assets":{}}';
  await openFile(p, 'old.shotref.json', v1);
  const st = await stateOf(p);
  ok(st.objects.length === 1 && st.objects[0].id === 'p1', 'v1 file did not load (objects: ' + st.objects.length + ')');
  ok(st.camera.dof && st.camera.feel === 'gentle', 'dof/feel were not filled in');
  ok(st.v === 2, 'state.v should be 2, is ' + st.v);
  ok(st.settings.duration === 4 && st.settings.style === 'shaded', 'settings were not merged');
  noErrors(p, 'after opening v1 file');
});

check('not a project file shows a friendly message', async ({ open }) => {
  const p = await open();
  await p.setInputFiles('#fOpen', { name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
  await p.waitForTimeout(600);
  const msg = await p.textContent('#toast');
  ok(/isn't a ShotRef project/i.test(msg), 'toast says "' + msg + '"');
  ok(await p.evaluate(() => window.__shotref.state.objects.length) === 3, 'scene changed');
  noPageErrors(p);
});

check('undo after open restores scene and assets', async ({ open, fixtures }) => {
  const p = await open();
  await p.setInputFiles('#fPlate', path.join(fixtures, 'location.jpg'));
  await p.waitForFunction(() => { const i = document.querySelector('.plateImg'); return i && i.getAttribute('src'); });
  const other = '{"app":"ShotRef","version":1,"state":{"camera":{"base":' + CAM_BASE + ',"keys":[]},"objects":[]},"assets":{}}';
  const asked = await openFile(p, 'other.shotref.json', other);
  ok(asked, 'no confirm box before replacing a scene with a photo');
  await p.waitForFunction(() => window.__shotref.state.objects.length === 0 && !window.__shotref.state.plate);
  await p.evaluate(() => document.activeElement && document.activeElement.blur());
  await p.keyboard.press('Control+z');
  await p.waitForFunction(() => window.__shotref.state.objects.length === 3 && window.__shotref.state.plate, null, { timeout: 3000 }).catch(() => { throw new Error('Ctrl+Z did not bring the scene back'); });
  const shown = await p.waitForFunction(() => { const i = document.querySelector('.plateImg'); return i && i.getAttribute('src'); }, null, { timeout: 4000 }).then(() => true, () => false);
  ok(shown, 'scene came back but its location photo did not');
  noErrors(p);
});

check('starter set can be undone', async ({ open }) => {
  const p = await open();
  const ids = await p.evaluate(() => window.__shotref.state.objects.map(o => o.id).join());
  await fileCmd(p, 'new');
  await p.click('#startGrid .card:has-text("Street")');
  await p.waitForSelector('#mConfirm:not(.hidden)');
  await p.click('#cfOk');
  await p.waitForFunction(() => window.__shotref.state.objects.length > 3);
  await p.evaluate(() => document.activeElement && document.activeElement.blur());
  await p.keyboard.press('Control+z');
  await p.waitForFunction(i => window.__shotref.state.objects.map(o => o.id).join() === i, ids, { timeout: 3000 }).catch(() => { throw new Error('Ctrl+Z did not bring back the original 3 objects'); });
  noErrors(p);
});

check('broken autosave starts a fresh scene', async ({ freshContext }) => {
  const fc = await freshContext();
  await fc.ctx.addInitScript(() => { try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('shotref.autosave', '{"state":{"camera":'); } } catch (e) { } });
  const p = await fc.open();
  await p.waitForTimeout(500);
  ok(await p.evaluate(() => window.__shotref.state.objects.length) === 3, 'expected the 3-object starter scene');
  const kept = await p.evaluate(() => localStorage.getItem('shotref.autosave.broken'));
  ok(kept === '{"state":{"camera":', 'the broken autosave was not kept in shotref.autosave.broken');
  const msg = await p.textContent('#toast');
  ok(/couldn't be restored/i.test(msg), 'toast says "' + msg + '"');
  noPageErrors(p);
});

check('large broken autosave is kept', async ({ freshContext }) => {
  /* ~3 M characters: the original plus a copy would not both fit in localStorage */
  const raw = '{"state":{"camera":{},"junk":"' + 'x'.repeat(3000000);
  const fc = await freshContext();
  await fc.ctx.addInitScript(r => { try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('shotref.autosave', r); } } catch (e) { } }, raw);
  const p = await fc.open();
  await p.waitForTimeout(1200); /* let the app's own autosave run */
  const kept = await p.evaluate(() => localStorage.getItem('shotref.autosave.broken'));
  ok(kept === raw, 'the broken autosave was lost (shotref.autosave.broken is ' + (kept == null ? 'missing' : kept.length + ' chars') + ')');
  noPageErrors(p);
});

check('open asks first and can be undone', async ({ open }) => {
  const p = await open();
  await p.evaluate(() => { for (let i = 0; i < 5; i++) window.__shotref.addObject('box'); });
  const total = await p.evaluate(() => window.__shotref.state.objects.length);
  ok(total === 8, 'setup: expected 8 objects, got ' + total);
  const file = await p.evaluate(() => { const s = JSON.parse(JSON.stringify(window.__shotref.state)); s.objects = []; return JSON.stringify({ app: 'ShotRef', version: 1, state: s }); });
  await p.setInputFiles('#fOpen', { name: 'empty.shotref.json', mimeType: 'application/json', buffer: Buffer.from(file) });
  await p.waitForTimeout(600);
  const shown = await p.evaluate(() => { const m = document.querySelector('#mConfirm'); return m && !m.classList.contains('hidden'); });
  const left = await p.evaluate(() => window.__shotref.state.objects.length);
  ok(shown, 'no confirm box appeared; the scene was replaced straight away (objects now ' + left + ')');
  const label = await p.textContent('#cfOk');
  ok(/open file/i.test(label), 'confirm button should say "Open file", says "' + label + '"');
  await p.click('#cfOk');
  await p.waitForFunction(() => window.__shotref.state.objects.length === 0);
  await p.evaluate(() => document.activeElement && document.activeElement.blur());
  await p.keyboard.press('Control+z');
  await p.waitForFunction(() => window.__shotref.state.objects.length === 8, null, { timeout: 3000 }).catch(() => { throw new Error('Ctrl+Z did not bring back the 8 objects'); });
});

/* ---- autosave (Task 3) ---- */

/* big noise JPEG made in the page (4000x3000, several MB); returns base64 */
const bigJpeg = (p, seed, q = 0.95) => p.evaluate(async ([seed, q]) => {
  const c = document.createElement('canvas'); c.width = 4000; c.height = 3000;
  const g = c.getContext('2d'), img = g.createImageData(4000, 3000), d = img.data;
  let s = seed; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < d.length; i += 4) { const v = 73 + rnd() * 110; d[i] = v; d[i + 1] = v + rnd() * 30; d[i + 2] = v; d[i + 3] = 255; }
  g.putImageData(img, 0, 0);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
  const fr = new FileReader();
  return await new Promise(r => { fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
}, [seed, q]);
/* how many photos/models the autosave holds (inline in localStorage + IndexedDB records) */
const storedAssetCount = p => p.evaluate(async () => {
  let n = 0;
  try { const a = JSON.parse(localStorage.getItem('shotref.autosave')); n += Object.keys(a.assets || {}).length; } catch (e) { }
  const idb = await new Promise(res => {
    try {
      const r = indexedDB.open('shotref');
      r.onsuccess = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('assets')) { db.close(); return res(0); }
        const q = db.transaction('assets').objectStore('assets').count();
        q.onsuccess = () => { db.close(); res(q.result); }; q.onerror = () => { db.close(); res(0); };
      };
      r.onerror = () => res(0);
    } catch (e) { res(0); }
  });
  return n + idb;
});

check('autosave keeps photo after replace and reload', async ({ open, fixtures }) => {
  const p = await open();
  const big = await bigJpeg(p, 1, 0.9);
  ok(big.length > 4e6, 'setup: test JPEG is only ' + big.length + ' base64 chars');
  await p.setInputFiles('#fPlate', { name: 'big.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(big, 'base64') });
  await p.waitForFunction(() => window.__shotref.state.plate && window.__shotref.state.plate.asset, null, { timeout: 30000 });
  const first = await p.evaluate(() => window.__shotref.state.plate.asset);
  await p.setInputFiles('#fPlate', path.join(fixtures, 'location.jpg'));
  await p.waitForFunction(a => window.__shotref.state.plate && window.__shotref.state.plate.asset !== a, first, { timeout: 30000 });
  await p.waitForTimeout(1000);
  await p.reload();
  await p.waitForFunction(() => window.__shotref && window.__shotref.state);
  ok(await p.evaluate(() => !!window.__shotref.state.plate), 'state.plate is gone after reload');
  const got = await p.waitForFunction(() => { const S = window.__shotref; return S.assets && S.assets[S.state.plate.asset]; }, null, { timeout: 4000 }).then(() => true, () => false);
  const msg = await p.textContent('#toast');
  ok(got, 'location photo data is missing after reload (toast: "' + msg + '")');
  const shown = await p.waitForFunction(() => { const i = document.querySelector('.plateImg'); return i && i.getAttribute('src'); }, null, { timeout: 4000 }).then(() => true, () => false);
  ok(shown, 'location photo is not shown after reload');
  noPageErrors(p);
}, { timeout: 90000 });

check('restore toast waits for the photo', async ({ freshContext }) => {
  /* autosave names a photo that is in neither localStorage nor IndexedDB: no "Restored" toast, a "couldn't be restored" one instead */
  const st = JSON.stringify({ v: 2, assetIds: ['gone1'], assets: {}, state: { camera: { base: JSON.parse(CAM_BASE), keys: [] }, objects: [], plate: { asset: 'gone1', overlay: 0, export: true, ground: 'shadow' } } });
  const fc = await freshContext();
  await fc.ctx.addInitScript(r => { try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('shotref.autosave', r); } } catch (e) { } }, st);
  const p = await fc.open();
  await p.waitForFunction(() => /couldn't be restored/i.test(document.querySelector('#toast').textContent), null, { timeout: 4000 })
    .catch(async () => { throw new Error('toast says "' + await p.textContent('#toast') + '"'); });
  ok(/1 photo or model/i.test(await p.textContent('#toast')), 'toast does not say how many: "' + await p.textContent('#toast') + '"');
  noPageErrors(p);
});

check('deleted imports are not autosaved', async ({ open, fixtures }) => {
  const p = await open();
  await p.setInputFiles('#fModel', path.join(fixtures, 'texcube.glb'));
  await p.waitForFunction(() => window.__shotref.state.objects.some(o => o.type === 'model'));
  await p.waitForTimeout(1200);
  const n1 = await storedAssetCount(p);
  ok(n1 === 1, 'the imported model was not autosaved (stored: ' + n1 + ')');
  const box = await p.locator('#c').boundingBox();
  await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2); /* place it */
  await p.evaluate(() => { const S = window.__shotref; S.select(S.state.objects.find(o => o.type === 'model').id); document.activeElement && document.activeElement.blur(); });
  await p.keyboard.press('Delete');
  await p.waitForFunction(() => !window.__shotref.state.objects.some(o => o.type === 'model'));
  await p.waitForTimeout(1200);
  const n = await storedAssetCount(p);
  ok(n === 0, 'deleted model is still autosaved (' + n + ' stored)');
  noPageErrors(p);
});

check('legacy autosave with inline assets restores', async ({ freshContext, fixtures }) => {
  const b64 = fs.readFileSync(path.join(fixtures, 'location.jpg')).toString('base64');
  const old = JSON.stringify({
    state: { settings: { duration: 4, fps: 24 }, camera: { base: JSON.parse(CAM_BASE), keys: [] }, objects: [], plate: { asset: 'ph1', overlay: 0, export: true, ground: 'shadow' } },
    assets: { ph1: { kind: 'plate', name: 'location.jpg', b64, mime: 'image/jpeg', aspect: 1.5 } },
  });
  const fc = await freshContext();
  await fc.ctx.addInitScript(r => { try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('shotref.autosave', r); } } catch (e) { } }, old);
  const p = await fc.open();
  await p.waitForFunction(() => { const S = window.__shotref; return S.state.plate && S.assets && S.assets.ph1; }, null, { timeout: 4000 }).catch(() => { throw new Error('legacy autosave photo did not restore'); });
  await p.waitForTimeout(1200); /* let it re-save in the new layout */
  await p.reload();
  await p.waitForFunction(() => { const S = window.__shotref; return S && S.state.plate && S.assets && S.assets.ph1; }, null, { timeout: 4000 }).catch(() => { throw new Error('photo lost after the first re-save'); });
  noPageErrors(p);
});

check('autosave works when IndexedDB is unavailable', async ({ freshContext }) => {
  const fc = await freshContext();
  await fc.ctx.addInitScript(() => { IDBFactory.prototype.open = function () { throw new DOMException('blocked', 'SecurityError'); }; });
  const p = await fc.open();
  await p.evaluate(() => { const S = window.__shotref; S.addObject('box'); S.changed(true); });
  await p.waitForTimeout(1000);
  const n = await p.evaluate(() => { try { return JSON.parse(localStorage.getItem('shotref.autosave')).state.objects.length; } catch (e) { return -1; } });
  ok(n === 4, 'edit was not autosaved (objects in autosave: ' + n + ')');
  noPageErrors(p, 'after edit');
  const big = await bigJpeg(p, 3, 0.95);
  ok(big.length > 6e6, 'setup: test image is only ' + big.length + ' base64 chars');
  await p.setInputFiles('#fImage', { name: 'big.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(big, 'base64') });
  await p.waitForFunction(() => /too big to autosave/i.test(document.querySelector('#toast').textContent), null, { timeout: 8000 })
    .catch(async () => { throw new Error('no size warning (toast: "' + await p.textContent('#toast') + '")'); });
  const n2 = await p.evaluate(() => { try { return JSON.parse(localStorage.getItem('shotref.autosave')).state.objects.length; } catch (e) { return -1; } });
  ok(n2 === 5, 'scene was not autosaved without the image (objects in autosave: ' + n2 + ')');
  noPageErrors(p, 'after big image');
}, { timeout: 90000 });

check('two tabs warn', async ({ open }) => {
  const a = await open();
  const b = await open();
  await b.waitForTimeout(800);
  await a.evaluate(() => { const S = window.__shotref; S.addObject('box'); S.changed(true); });
  await b.waitForFunction(() => /another tab/i.test(document.querySelector('#toast').textContent), null, { timeout: 4000 })
    .catch(async () => { throw new Error('tab B shows no warning (toast: "' + await b.textContent('#toast') + '")'); });
  noPageErrors(b);
});

check('broken autosave keeps its stored photos', async ({ freshContext }) => {
  /* v2 autosave (photo lives only in IndexedDB) whose state is damaged: the photo record must survive the fresh scene */
  const fc = await freshContext();
  await fc.ctx.addInitScript(() => {
    try {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('shotref.autosave', '{"v":2,"assetIds":["keep1"],"assets":{},"state":{"camera":');
      const rq = indexedDB.open('shotref', 1);
      rq.onupgradeneeded = () => { rq.result.createObjectStore('assets').put({ kind: 'plate', name: 'x.jpg', b64: 'AAAA', mime: 'image/jpeg', aspect: 1.5 }, 'keep1'); };
      rq.onsuccess = () => rq.result.close();
    } catch (e) { }
  });
  const p = await fc.open();
  ok(await p.evaluate(() => window.__shotref.state.objects.length) === 3, 'expected the fresh starter scene');
  await p.waitForTimeout(1500);
  const n = await storedAssetCount(p);
  ok(n === 1, 'the broken session\'s photo record was deleted (' + n + ' stored)');
  noPageErrors(p);
});

check('last tab to write keeps its photo', async ({ open, fixtures }) => {
  const a = await open();
  await a.setInputFiles('#fPlate', path.join(fixtures, 'location.jpg'));
  await a.waitForFunction(() => window.__shotref.state.plate && window.__shotref.state.plate.asset);
  const P = await a.evaluate(() => window.__shotref.state.plate.asset);
  await a.waitForTimeout(1000);
  const b = await open(); /* B restores A's scene, using photo P */
  await b.waitForFunction(a => { const S = window.__shotref; return S.state.plate && S.state.plate.asset === a && S.assets[a]; }, P, { timeout: 4000 });
  await a.setInputFiles('#fPlate', path.join(fixtures, 'location.jpg')); /* A: P -> Q */
  await a.waitForFunction(p => window.__shotref.state.plate.asset !== p, P);
  await a.waitForTimeout(1000);
  await b.evaluate(() => { const S = window.__shotref; S.addObject('box'); S.changed(true); }); /* B writes last, still using P */
  await b.waitForTimeout(1000);
  await a.close();
  await b.reload();
  await b.waitForFunction(() => window.__shotref && window.__shotref.state);
  const got = await b.waitForFunction(p => { const S = window.__shotref; return S.state.plate && S.state.plate.asset === p && S.assets[p]; }, P, { timeout: 4000 }).then(() => true, () => false);
  ok(got, 'the last tab\'s photo is missing after reload (toast: "' + await b.textContent('#toast') + '")');
  noPageErrors(b);
});

check('save file name has a date', async ({ open, downloads }) => {
  const p = await open();
  await fileCmd(p, 'save');
  const f = await downloads(p).wait('.shotref');
  ok(/^shotref-\d{8}-\d{4}\.shotref$/.test(f.name), 'file is called ' + f.name);
});


/* ---- Task 4: export safety ---- */
function mp4Dims(buf) {
  const i = buf.indexOf('tkhd'); if (i < 0) return null;
  const ver = buf[i + 4], end = i + 4 + (ver === 1 ? 88 : 76); /* width/height 16.16 are the last 8 bytes of tkhd */
  return { w: buf.readUInt32BE(end) / 65536, h: buf.readUInt32BE(end + 4) / 65536 };
}
const startExport = async (p, size, dur) => {
  await p.evaluate(({ size, dur }) => { const s = window.__shotref.state.settings; s.size = size; s.duration = dur; window.__shotref.changed(true, true); }, { size, dur });
  await p.click('#bExport');
  await p.click('#xoVideo');
};

check('export settings are locked while exporting', async ({ open, downloads }) => {
  const p = await open();
  await startExport(p, 1280, 4);
  const info = await p.evaluate(() => [...document.querySelectorAll('#mExport input, #mExport select, #mExport button')].filter(e => e.id !== 'exCancel' && !e.disabled).map(e => e.id || e.className || e.textContent.trim().slice(0, 20)));
  ok(info.length === 0, 'controls still enabled during export: ' + info.join(', '));
  await p.click('#mExport [data-close]', { force: true });
  await p.keyboard.press('Escape');
  await p.mouse.click(5, 450);
  const open1 = await p.evaluate(() => !document.querySelector('#mExport').classList.contains('hidden'));
  ok(open1, 'export dialog closed during export');
  await p.evaluate(() => { window.__shotref.exportPNG(0); });
  await p.keyboard.press('p');
  const f = await downloads(p).wait('.mp4', 60000);
  await p.waitForTimeout(800);
  const names = await p.evaluate(() => window.__dl.map(d => d.name));
  ok(names.length === 1 && names[0].endsWith('.mp4'), 'expected a single MP4 download, saw: ' + names.join(', '));
  ok(f.size > 10240, 'MP4 too small');
  const en = await p.evaluate(() => [...document.querySelectorAll('#mExport input, #mExport select, #mExport button')].filter(e => e.disabled).length);
  ok(en === 0, 'controls stay disabled after export (' + en + ')');
  noPageErrors(p, 'export lock');
}, { timeout: 90000 });

check('keyboard cannot change the scene while exporting', async ({ open, downloads }) => {
  const p = await open();
  await startExport(p, 1280, 4);
  const before = await p.evaluate(() => JSON.stringify(window.__shotref.state));
  for (let i = 0; i < 14; i++) { await p.keyboard.press('Tab'); await p.keyboard.press('Enter'); await p.keyboard.press('Space'); }
  await p.keyboard.press('Control+z');
  const after = await p.evaluate(() => ({ s: JSON.stringify(window.__shotref.state), conf: !document.querySelector('#mConfirm').classList.contains('hidden'), exp: !document.querySelector('#mExport').classList.contains('hidden') }));
  ok(after.s === before, 'scene state changed during export');
  ok(!after.conf, 'a confirm box opened during export');
  ok(after.exp, 'export dialog closed');
  /* Enter/Space on Cancel may legitimately cancel the export, so just wait for it to end */
  await p.waitForFunction(() => document.querySelector('#exCancel').hidden, null, { timeout: 60000 });
  noPageErrors(p, 'keyboard during export');
}, { timeout: 90000 });

check('mp4 export dimensions match the dialog', async ({ open, downloads }) => {
  const p = await open();
  await startExport(p, 1280, 1);
  const f = await downloads(p).wait('.mp4', 50000);
  const d = mp4Dims(f.bytes);
  ok(d && d.w === 1280 && d.h === 720, 'tkhd size is ' + (d ? d.w + 'x' + d.h : 'missing') + ', expected 1280x720');
}, { timeout: 80000 });

check('frame png failure shows a message', async ({ open }) => {
  const p = await open();
  await p.evaluate(() => { HTMLCanvasElement.prototype.toBlob = function (cb) { cb(null); }; });
  await p.evaluate(() => window.__shotref.exportPNG(0));
  const t = await p.evaluate(() => document.querySelector('#toast').textContent);
  ok(t.includes('Could not make that frame'), 'toast was: "' + t + '"');
  const n = await p.evaluate(() => window.__dl.length);
  ok(n === 0, 'a download happened');
  noPageErrors(p, 'png failure');
});

check('lost graphics context does not save an empty video', async ({ open, downloads }) => {
  const p = await open();
  await startExport(p, 1280, 1);
  await downloads(p).wait('.mp4', 50000);
  await p.evaluate(() => { window.__dl.length = 0; const c = window.__shotref._exportCanvas(); const gl = c.getContext('webgl2') || c.getContext('webgl'); gl.getExtension('WEBGL_lose_context').loseContext(); });
  await p.waitForTimeout(300);
  await p.evaluate(() => { window.__shotref.exportVideo(); });
  const end = Date.now() + 40000; let res = null;
  while (Date.now() < end) {
    const s = await p.evaluate(() => ({ dl: window.__dl.map(d => ({ n: d.name, s: d.size })), toast: document.querySelector('#toast').textContent, txt: document.querySelector('#exTxt').textContent, show: document.querySelector('#toast').classList.contains('show') }));
    if (s.dl.length) { res = s; break; }
    if (/stopped because|couldn.t make an MP4/.test(s.toast)) { res = s; break; }
    await p.waitForTimeout(300);
  }
  ok(res, 'neither a video nor an error message appeared');
  ok(res.dl.length || !/Done/.test(res.txt), 'showed Done without saving a video');
  if (res.dl.length) ok(res.dl[0].s > 10240, 'saved video is only ' + res.dl[0].s + ' bytes');
  noPageErrors(p, 'context loss');
}, { timeout: 120000 });

check('cancel clears the progress text', async ({ open }) => {
  const p = await open();
  await startExport(p, 1920, 6);
  await p.waitForFunction(() => /Rendering frame/.test(document.querySelector('#exTxt').textContent), null, { timeout: 20000 });
  await p.click('#exCancel');
  await p.waitForFunction(() => document.querySelector('#exCancel').hidden, null, { timeout: 20000 });
  const s = await p.evaluate(() => ({ txt: document.querySelector('#exTxt').textContent, w: document.querySelector('#exBar').style.width }));
  ok(s.txt === '' && (s.w === '0%' || s.w === '0.0%' || s.w === ''), 'progress left behind: "' + s.txt + '" ' + s.w);
}, { timeout: 60000 });

check('duration 0 becomes the minimum', async ({ open }) => {
  const p = await open();
  await p.fill('#inDur', '0');
  await p.press('#inDur', 'Enter');
  await p.waitForTimeout(300);
  const s = await p.evaluate(() => ({ d: window.__shotref.state.settings.duration, t: document.querySelector('#toast').textContent }));
  ok(s.d === 1, 'duration is ' + s.d + ', expected 1');
  ok(/1 s/.test(s.t) && /minimum/i.test(s.t), 'toast was: "' + s.t + '"');
});

/* ---- Task 5: small bug fixes ---- */

/* number of distinct frames used by a track, and its key count */
const trackInfo = (p, which) => p.evaluate(w => {
  const S = window.__shotref, fps = S.state.settings.fps;
  const keys = w === 'camera' ? S.state.camera.keys : S.state.objects.find(o => o.name === 'Keyed').keys;
  return { n: keys.length, frames: new Set(keys.map(k => Math.round(k.t * fps))).size, last: Math.max(...keys.map(k => Math.round(k.t * fps))), end: Math.round(S.state.settings.duration * fps) - 1 };
}, which);
const setDur = async (p, v) => { await p.fill('#inDur', String(v)); await p.press('#inDur', 'Enter'); await p.waitForTimeout(200); };

check('shrinking the shot keeps keys apart', async ({ open }) => {
  const p = await open();
  await setDur(p, 10);
  ok(await p.evaluate(() => window.__shotref.state.settings.duration) === 10, 'setup: duration is not 10 s');
  await p.evaluate(() => {
    const S = window.__shotref;
    const o = S.addObject('box'); o.name = 'Keyed';
    for (let i = 0; i < 72; i++) S.setKey(o.keys, i / 24, { p: [i * 0.1, 0, 0], r: [0, 0, 0], s: [1, 1, 1] });
    for (let i = 0; i < 40; i++) S.setKey(S.state.camera.keys, i / 24, { p: [3 + i * 0.05, 1.6, 6], tg: [0, 1, 0], f: 35, roll: 0, fd: 7 });
    S.changed(true, true);
  });
  await setDur(p, 5);
  ok(await p.evaluate(() => window.__shotref.state.settings.duration) === 5, 'setup: duration did not change to 5 s');
  let o = await trackInfo(p, 'object'), c = await trackInfo(p, 'camera');
  ok(o.n === 72 && o.frames === 72, '10 s -> 5 s: object has ' + o.n + ' keys on ' + o.frames + ' distinct frames, expected 72 on 72');
  ok(c.n === 40 && c.frames === 40, '10 s -> 5 s: camera has ' + c.n + ' keys on ' + c.frames + ' distinct frames');
  await setDur(p, 10);
  o = await trackInfo(p, 'object');
  ok(o.n === 72 && o.frames === 72, '5 s -> 10 s: object has ' + o.n + ' keys on ' + o.frames + ' frames');
  /* 2 s at 24 fps = 48 frames: 72 keys cannot all fit, so some merge */
  await setDur(p, 2);
  o = await trackInfo(p, 'object');
  ok(o.n === o.frames && o.n > 1 && o.n <= 48 && o.last <= o.end, '10 s -> 2 s: ' + o.n + ' keys on ' + o.frames + ' frames, last frame ' + o.last + ' of ' + o.end);
  noPageErrors(p);
});

check('changing fps keeps keys apart', async ({ open }) => {
  const p = await open();
  await goAdvanced(p); /* the FPS box is an Advanced control */
  await setDur(p, 4);
  await p.selectOption('#inFps', '30');
  await p.waitForTimeout(200);
  ok(await p.evaluate(() => window.__shotref.state.settings.fps) === 30, 'setup: fps is not 30');
  await p.evaluate(() => {
    const S = window.__shotref;
    const o = S.addObject('box'); o.name = 'Keyed';
    for (let i = 0; i < 119; i++) S.setKey(o.keys, i / 30, { p: [i * 0.1, 0, 0], r: [0, 0, 0], s: [1, 1, 1] });
    S.changed(true, true);
  });
  await p.selectOption('#inFps', '24');
  await p.waitForTimeout(200);
  ok(await p.evaluate(() => window.__shotref.state.settings.fps) === 24, 'setup: fps did not change to 24');
  const o = await trackInfo(p, 'object');
  ok(o.n === o.frames, '30 -> 24 fps: ' + o.n + ' keys share ' + o.frames + ' frames');
  /* 119 keys do not fit in 96 frames, so keys on the same frame merge */
  ok(o.n >= 90 && o.n <= 96 && o.last <= o.end, '30 -> 24 fps: expected about 95 keys up to frame ' + o.end + ', got ' + o.n + ' up to ' + o.last);
  noPageErrors(p);
});

/* a one-triangle GLB whose texture image is an outside file */
function glbWithOutsideTexture(url) {
  const bin = Buffer.alloc(36); [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => bin.writeFloatLE(v, i * 4));
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }], materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }], textures: [{ source: 0 }], images: [{ uri: url }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }], buffers: [{ byteLength: 36 }] };
  let js = Buffer.from(JSON.stringify(json)); js = Buffer.concat([js, Buffer.alloc((4 - js.length % 4) % 4, 0x20)]);
  const head = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
  head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  jh.writeUInt32LE(js.length, 0); jh.writeUInt32LE(0x4E4F534A, 4); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004E4942, 4);
  return Buffer.concat([head, jh, js, bh, bin]);
}

check('glb with outside textures stays offline', async ({ open, base }) => {
  const p = await open();
  const url = base + 'fixtures/location.jpg', hits = [];
  p.on('request', r => { if (r.url().includes('/fixtures/')) hits.push(r.url()); });
  await p.setInputFiles('#fModel', { name: 'outside.glb', mimeType: 'model/gltf-binary', buffer: glbWithOutsideTexture(url) });
  await p.waitForFunction(() => window.__shotref.state.objects.some(o => o.type === 'model'));
  const said = await p.waitForFunction(() => /textures/i.test(document.querySelector('#toast').textContent), null, { timeout: 4000 }).then(() => true, () => false);
  await p.waitForTimeout(800);
  ok(hits.length === 0, 'the app fetched ' + hits[0]);
  ok(said, 'no toast about the textures (toast: "' + await p.textContent('#toast') + '")');
  ok(!/could not read/i.test(await p.textContent('#toast')), 'model failed to load');
  noPageErrors(p);
});

check('non-image file is refused as image card', async ({ open }) => {
  const p = await open();
  await p.setInputFiles('#fImage', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello, not a picture') });
  await p.waitForTimeout(700);
  const n = await p.evaluate(() => window.__shotref.state.objects.length);
  ok(n === 3, 'an object was added (' + n + ' objects)');
  const msg = await p.textContent('#toast');
  ok(/isn't an image/i.test(msg), 'toast says "' + msg + '"');
  noPageErrors(p);
});

check('deleting the look-at person keeps the framing', async ({ open }) => {
  const p = await open();
  const aim = await p.evaluate(() => {
    const S = window.__shotref, o = S.state.objects.find(x => x.type === 'person');
    o.base.p = [2, 0, 1]; S.state.camera.lookAtId = o.id; S.changed(true, true);
    S.select(o.id); document.activeElement && document.activeElement.blur();
    return S.evalCam(S.T).tg;
  });
  await p.keyboard.press('Delete');
  await p.waitForFunction(() => !window.__shotref.state.objects.some(x => x.type === 'person'));
  const c = await p.evaluate(() => window.__shotref.state.camera);
  ok(c.lookAtId === null, 'camera still looks at the deleted person');
  const d = Math.max(...aim.map((v, i) => Math.abs(v - c.base.tg[i])));
  ok(d < 1e-6, 'camera aim moved by ' + d.toFixed(3) + ' m: ' + JSON.stringify(c.base.tg) + ' vs ' + JSON.stringify(aim));
  noPageErrors(p);
});

check('unknown object type does not crash', async ({ open }) => {
  const p = await open();
  const f = '{"app":"ShotRef","version":2,"state":{"camera":{"base":' + CAM_BASE + ',"keys":[]},"objects":[{"id":"x1","type":"spaceship","name":"Ship","color":"#ffffff","opts":{},"base":{"p":[0,0,0],"r":[0,0,0],"s":[1,1,1]},"keys":[],"visible":true}]},"assets":{}}';
  await openFile(p, 'ship.shotref.json', f);
  await p.evaluate(() => { window.__shotref.select('x1'); document.activeElement && document.activeElement.blur(); });
  await p.waitForTimeout(300);
  await p.keyboard.press('Control+d');
  await p.waitForTimeout(300);
  const n = await p.evaluate(() => window.__shotref.state.objects.length);
  ok(n === 2, 'duplicate did not work (' + n + ' objects)');
  noPageErrors(p);
});

check('undo after deleting a model keeps it in the autosave', async ({ open, fixtures }) => {
  const p = await open();
  await p.setInputFiles('#fModel', path.join(fixtures, 'texcube.glb'));
  await p.waitForFunction(() => window.__shotref.state.objects.some(o => o.type === 'model'));
  const box = await p.locator('#c').boundingBox();
  await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await p.evaluate(() => { const S = window.__shotref; S.select(S.state.objects.find(o => o.type === 'model').id); document.activeElement && document.activeElement.blur(); });
  await p.keyboard.press('Delete');
  await p.waitForTimeout(1200);
  await p.keyboard.press('Control+z');
  await p.waitForFunction(() => window.__shotref.state.objects.some(o => o.type === 'model'));
  await p.waitForTimeout(1000);
  await p.reload();
  await p.waitForFunction(() => window.__shotref && window.__shotref.state);
  const got = await p.waitForFunction(() => { const S = window.__shotref, o = S.state.objects.find(x => x.type === 'model'); return o && S.assets[o.asset || (o.opts && o.opts.asset)]; }, null, { timeout: 4000 }).then(() => true, () => false);
  ok(got, 'the model is missing after reload');
  noPageErrors(p);
});

check('broken autosave photos survive the next boot', async ({ freshContext }) => {
  const fc = await freshContext();
  await fc.ctx.addInitScript(() => {
    try {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('shotref.autosave', '{"v":2,"assetIds":["keep1"],"assets":{},"state":{"camera":');
      const rq = indexedDB.open('shotref', 1);
      rq.onupgradeneeded = () => { rq.result.createObjectStore('assets').put({ kind: 'plate', name: 'x.jpg', b64: 'AAAA', mime: 'image/jpeg', aspect: 1.5 }, 'keep1'); };
      rq.onsuccess = () => rq.result.close();
    } catch (e) { }
  });
  const p = await fc.open();
  await p.waitForTimeout(1500);
  await p.reload(); /* a normal boot: the autosave is fine now, the broken one is still kept aside */
  await p.waitForFunction(() => window.__shotref && window.__shotref.state);
  await p.evaluate(() => { const S = window.__shotref; S.addObject('box'); S.changed(true); });
  await p.waitForTimeout(1500);
  const n = await storedAssetCount(p);
  ok(n === 1, 'the broken session\'s photo record was deleted on the next boot (' + n + ' stored)');
  noPageErrors(p);
});

check('a photo that failed to load is not pruned', async ({ freshContext, fixtures }) => {
  const b64 = fs.readFileSync(path.join(fixtures, 'location.jpg')).toString('base64');
  const st = JSON.stringify({ v: 2, assetIds: ['ph1'], assets: {}, state: { camera: { base: JSON.parse(CAM_BASE), keys: [] }, objects: [], plate: { asset: 'ph1', overlay: 0, export: true, ground: 'shadow' } } });
  const fc = await freshContext();
  await fc.ctx.addInitScript(([st, b64]) => {
    try {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('shotref.autosave', st);
      const rq = indexedDB.open('shotref', 1);
      rq.onupgradeneeded = () => { rq.result.createObjectStore('assets').put({ kind: 'plate', name: 'l.jpg', b64, mime: 'image/jpeg', aspect: 1.5 }, 'ph1'); };
      rq.onsuccess = () => rq.result.close();
      /* the app's first read fails (a transient error) */
      const og = IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get = function (k) { if (k === 'ph1' && !window.__failed) { window.__failed = 1; return og.call(this, '__nothing__'); } return og.call(this, k); };
    } catch (e) { }
  }, [st, b64]);
  const p = await fc.open();
  await p.waitForTimeout(800);
  await p.evaluate(() => { const S = window.__shotref; S.addObject('box'); S.changed(true); });
  await p.waitForTimeout(1500);
  const n = await storedAssetCount(p);
  ok(n === 1, 'the photo record was pruned after a failed read (' + n + ' stored)');
  await p.reload();
  const got = await p.waitForFunction(() => { const S = window.__shotref; return S && S.state.plate && S.assets.ph1; }, null, { timeout: 4000 }).then(() => true, () => false);
  ok(got, 'the photo did not come back on the next boot');
  noPageErrors(p);
});

check('dropping a file outside the view does not leave the page', async ({ open }) => {
  const p = await open();
  const r = await p.evaluate(() => {
    const out = [];
    for (const el of [document.body, document.querySelector('#mHelp') || document.body]) {
      for (const type of ['dragover', 'drop']) {
        const dt = new DataTransfer(); dt.items.add(new File(['x'], 'a.txt', { type: 'text/plain' }));
        const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
        el.dispatchEvent(ev); out.push(type + '@' + (el.id || el.tagName) + ':' + ev.defaultPrevented);
      }
    }
    return out;
  });
  const bad = r.filter(x => x.endsWith(':false'));
  ok(bad.length === 0, 'browser would open the file (not prevented): ' + bad.join(', '));
  ok(await p.evaluate(() => !!window.__shotref), '__shotref is gone');
  noPageErrors(p);
});

/* ---- Task 6: UI/UX ---- */

const blurAll = p => p.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
const toastText = p => p.evaluate(() => document.querySelector('#toast').textContent);
/* first launch asks about the tour before the starter picker: say Not now */
const skipTour = async p => { await p.waitForFunction(() => !document.querySelector('#mTour').classList.contains('hidden'), null, { timeout: 3000 }).catch(() => { throw new Error('the first-run tour question did not open'); }); await p.click('#tourNo'); };
const isOpen = (p, id) => p.evaluate(id => { const m = document.getElementById(id); return !!m && !m.classList.contains('hidden'); }, id);

check('path cancel is clickable at 1366', async ({ freshContext }) => {
  for (const vp of [{ width: 1280, height: 720 }, { width: 1366, height: 768 }, { width: 1536, height: 864 }]) {
    const fc = await freshContext({ viewport: vp });
    const p = await fc.open();
    await p.evaluate(() => { const S = window.__shotref; S.select(S.state.objects.find(o => o.type === 'person').id); });
    await p.locator('#props').getByRole('button', { name: /Draw .*path/ }).click();
    await p.waitForFunction(() => getComputedStyle(document.querySelector('#modeBar')).display !== 'none');
    const hit = await p.evaluate(() => {
      const b = [...document.querySelectorAll('#modeBar button')].find(x => x.textContent.trim() === 'Cancel');
      if (!b) return 'no Cancel button';
      const r = b.getBoundingClientRect();
      for (const fx of [0.5, 0.75]) {
        const e = document.elementFromPoint(r.left + r.width * fx, r.top + r.height / 2);
        if (!(b === e || b.contains(e))) return 'Cancel is covered at ' + fx * 100 + '% by ' + (e ? (e.id ? '#' + e.id : e.tagName.toLowerCase() + (e.className ? '.' + e.className : '')) : 'nothing');
      }
      return 'ok';
    });
    ok(hit === 'ok', vp.width + 'x' + vp.height + ': ' + hit);
    await p.locator('#modeBar button', { hasText: /^Cancel$/ }).click();
    const after = await p.evaluate(() => ({ bar: getComputedStyle(document.querySelector('#modeBar')).display, view: window.__shotref.view }));
    ok(after.bar === 'none', vp.width + ': mode bar still showing after Cancel');
    ok(after.view === 'editor', vp.width + ': view changed to ' + after.view);
  }
});

check('camera view shows camera tools', async ({ open }) => {
  const p = await open();
  await p.evaluate(() => window.__shotref.select(null));
  await blurAll(p);
  await p.keyboard.press('c');
  await p.waitForTimeout(300);
  const s = await p.evaluate(() => ({ view: window.__shotref.view, sel: window.__shotref.selected, txt: document.querySelector('#props').textContent, hint: document.querySelector('#hint').textContent }));
  ok(s.view === 'camera', 'not in camera view');
  ok(/Lens/.test(s.txt), 'props panel has no Lens section: "' + s.txt.slice(0, 80) + '"');
  ok(s.sel === null, 'selection changed to ' + s.sel);
});

check('delete with slider focused keeps object', async ({ open }) => {
  const p = await open();
  const id = await p.evaluate(() => { const S = window.__shotref, o = S.state.objects.find(x => x.type === 'person'); S.select(o.id); return o.id; });
  await p.waitForTimeout(300);
  for (const sel of ['#props input[type=range]', '#props select']) {
    const focused = await p.evaluate(s => { const r = document.querySelector(s); if (!r) return null; r.focus(); return r.tagName + ':' + r.type; }, sel);
    ok(focused, 'setup: no ' + sel + ' in the person panel');
    await p.keyboard.press('Delete');
    await p.keyboard.press('Backspace');
    await p.waitForTimeout(200);
    ok(await p.evaluate(id => !!window.__shotref.state.objects.find(o => o.id === id), id), 'the person was deleted while ' + focused + ' had focus');
  }
});

check('space works after changing fps dropdown', async ({ open }) => {
  const p = await open();
  await goAdvanced(p);
  await p.selectOption('#inFps', '30');
  await p.focus('#inFps');
  await p.keyboard.press('Space');
  await p.waitForTimeout(200);
  const playing = await p.evaluate(() => document.querySelector('#bPlay').classList.contains('on'));
  ok(playing, 'Space did not start playback with the FPS dropdown focused');
  ok(await p.evaluate(() => window.__shotref.state.settings.fps) === 30, 'fps changed');
});

check('dialogs trap focus', async ({ open }) => {
  const p = await open();
  await exportDialog(p);
  await p.waitForTimeout(100);
  const inside = () => p.evaluate(() => { const a = document.activeElement; return a && document.querySelector('#mExport').contains(a) ? 'ok' : (a ? a.tagName + '#' + a.id : 'none'); });
  ok(await inside() === 'ok', 'focus did not move into the Export dialog: ' + await inside());
  for (let i = 0; i < 10; i++) { await p.keyboard.press('Tab'); const w = await inside(); ok(w === 'ok', 'Tab ' + (i + 1) + ' left the dialog: ' + w); }
  for (let i = 0; i < 6; i++) { await p.keyboard.press('Shift+Tab'); const w = await inside(); ok(w === 'ok', 'Shift+Tab ' + (i + 1) + ' left the dialog: ' + w); }
  const aria = await p.evaluate(() => [...document.querySelectorAll('.modal')].every(m => m.getAttribute('role') === 'dialog' && m.getAttribute('aria-modal') === 'true') && [...document.querySelectorAll('.dlg .x')].every(x => x.getAttribute('aria-label') === 'Close'));
  ok(aria, 'dialogs are missing role="dialog" aria-modal or the × has no aria-label');
  await p.keyboard.press('Escape');
  ok(!(await isOpen(p, 'mExport')), 'Esc did not close the dialog');
});

check('confirm accepts Enter', async ({ open }) => {
  const p = await open();
  await fileCmd(p, 'new');
  await p.click('#startGrid .card:has-text("Street")');
  await p.waitForSelector('#mConfirm:not(.hidden)');
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => window.__shotref.state.objects.length > 3, null, { timeout: 3000 }).catch(() => { throw new Error('Enter did not accept the confirm box'); });
  ok(!(await isOpen(p, 'mConfirm')), 'confirm box still open');
});

check('undo names the change', async ({ open }) => {
  const p = await open();
  const name = await p.evaluate(() => { const S = window.__shotref, o = S.state.objects.find(x => x.type === 'person'); o.base.p = [o.base.p[0] + 1, 0, o.base.p[2]]; S.changed(true, true); return o.name; });
  await blurAll(p);
  await p.keyboard.press('Control+z');
  const t = await toastText(p);
  ok(t.startsWith('Undo: move'), 'toast says "' + t + '"');
  ok(t.includes(name), 'toast does not name ' + name + ': "' + t + '"');
  await p.keyboard.press('Control+y');
  ok((await toastText(p)).startsWith('Redo: move'), 'redo toast says "' + await toastText(p) + '"');
  await p.evaluate(() => { window.__shotref.addObject('box'); window.__shotref.changed(true, true); });
  await p.keyboard.press('Control+z');
  ok(/^Undo: add /.test(await toastText(p)), 'add: toast says "' + await toastText(p) + '"');
  await p.evaluate(() => { const S = window.__shotref; S.state.settings.sky = '#123456'; S.changed(true); });
  await p.keyboard.press('Control+z');
  ok(await toastText(p) === 'Undo: settings change', 'settings: toast says "' + await toastText(p) + '"');
  await p.evaluate(() => { const S = window.__shotref; S.state.camera.base.f = 85; S.changed(true); });
  await p.keyboard.press('Control+z');
  ok(await toastText(p) === 'Undo: camera change', 'camera: toast says "' + await toastText(p) + '"');
});

check('section headings have readable contrast', async ({ open }) => {
  const p = await open();
  const r = await p.evaluate(() => {
    const rgb = s => s.match(/[\d.]+/g).slice(0, 3).map(Number);
    const lum = c => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const el = document.querySelector('.addcat');
    const a = lum(rgb(getComputedStyle(el).color)), b = lum(rgb(getComputedStyle(document.querySelector('#left')).backgroundColor));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  ok(r >= 4.5, 'contrast is ' + r.toFixed(2) + ':1');
});

check('first launch shows starter sets', async ({ freshContext }) => {
  const fc = await freshContext({ firstLaunch: true });
  const p = await fc.open();
  await skipTour(p);
  await p.waitForFunction(() => !document.querySelector('#mStart').classList.contains('hidden'), null, { timeout: 3000 }).catch(() => { throw new Error('starter sets did not open on first launch'); });
  await p.click('#startGrid .card:has-text("Street")');
  await p.waitForTimeout(200);
  ok(!(await isOpen(p, 'mConfirm')), 'asked to replace the scene on first launch');
  await p.waitForFunction(() => window.__shotref.state.objects.length > 3, null, { timeout: 3000 }).catch(() => { throw new Error('starter set did not load'); });
  await fileCmd(p, 'new');
  await p.locator('#mStart button', { hasText: 'Quick start guide' }).click();
  ok(await isOpen(p, 'mHelp'), 'Quick start guide button did not open the guide');
  ok(!(await isOpen(p, 'mStart')), 'starter sets still open behind the guide');
  await p.reload();
  await p.waitForFunction(() => window.__shotref && window.__shotref.state);
  await p.waitForTimeout(800);
  ok(!(await isOpen(p, 'mStart')), 'starter sets opened again on the second launch');
  noPageErrors(p);
});

check('friendly error on bad file', async ({ open }) => {
  const p = await open();
  await p.setInputFiles('#fOpen', { name: 'bad.shotref.json', mimeType: 'application/json', buffer: Buffer.from('{"app":"ShotRef", "state": {') });
  await p.waitForTimeout(600);
  const t = await toastText(p);
  ok(t.length > 0, 'no message');
  ok(!/JSON|position|token|undefined/i.test(t), 'toast shows technical text: "' + t + '"');
});

check('toast shows above an open dialog', async ({ open }) => {
  const p = await open();
  await exportDialog(p);
  await p.evaluate(() => window.__shotref.exportPNG(0));
  await p.waitForTimeout(300);
  const top = await p.evaluate(() => document.querySelector('#toast').getBoundingClientRect().top);
  ok(top < 40, 'toast top is at ' + top + ' px, expected near the top while a dialog is open');
});

check('quick start fits a 720 px window', async ({ freshContext }) => {
  const fc = await freshContext({ viewport: { width: 1280, height: 720 } });
  const p = await fc.open();
  await gearCmd(p, 'help');
  const r = await p.evaluate(() => { const d = document.querySelector('#mHelp .dlg').getBoundingClientRect(); return { top: d.top, bottom: d.bottom, sh: document.scrollingElement.scrollHeight }; });
  ok(r.top >= 0 && r.bottom <= 720, 'dialog spans ' + r.top + ' to ' + r.bottom + ' px');
  ok(r.sh <= 720, 'page scrolls (' + r.sh + ' px)');
});

check('timeline fits its tracks', async ({ open }) => {
  const p = await open();
  await p.click('#bTracks'); /* tracks start closed while nothing is keyed (batch B) */
  await p.waitForTimeout(200);
  const h1 = await p.evaluate(() => document.querySelector('#tl').getBoundingClientRect().height);
  ok(h1 >= 90 && h1 < 150, 'timeline is ' + h1 + ' px tall with 1 track');
  await p.evaluate(() => { const S = window.__shotref; for (let i = 0; i < 8; i++) { const o = S.addObject('box'); S.setKey(o.keys, 0, { p: [i, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }); } S.changed(true, true); });
  await p.waitForTimeout(300);
  const h2 = await p.evaluate(() => document.querySelector('#tl').getBoundingClientRect().height);
  ok(h2 <= 217 && h2 > h1, 'timeline is ' + h2 + ' px tall with 9 tracks');
});

check('outliner and timeline rows work from the keyboard', async ({ open }) => {
  const p = await open();
  await p.waitForTimeout(200);
  const id = await p.evaluate(() => window.__shotref.state.objects[1].id);
  await p.click('#leftTabs [data-lt=scene]'); await p.click('#bTracks'); /* the list is on the Scene tab; tracks start closed */
  await p.waitForTimeout(200);
  const rows = await p.evaluate(() => [...document.querySelectorAll('#outliner .ol, #tlRows .lab')].every(r => r.tabIndex === 0));
  ok(rows, 'outliner rows or timeline labels are not focusable');
  await p.focus('#outliner .ol:nth-child(4)'); /* camera, sun, then the objects */
  await p.keyboard.press('Enter');
  ok(await p.evaluate(() => window.__shotref.selected) === id, 'Enter on an outliner row did not select it');
  await p.waitForTimeout(100);
  await p.focus('#tlRows .lab');
  await p.keyboard.press('Space');
  ok(await p.evaluate(() => window.__shotref.selected) === 'camera', 'Space on the camera track label did not select the camera');
  ok(await p.evaluate(() => !document.querySelector('#bPlay').classList.contains('on')), 'Space on a label also started playback');
});

/* the select in the props panel whose row label is `label` */
const focusPropSelect = (p, label) => p.evaluate(l => {
  const row = [...document.querySelectorAll('#props .row')].find(r => r.querySelector('label') && r.querySelector('label').textContent.trim() === l);
  const s = row && row.querySelector('select'); if (!s) return null; s.focus(); return s.value;
}, label);

check('shortcut letters do not change a focused dropdown', async ({ open }) => {
  const p = await open();
  await p.evaluate(() => { window.__shotref.select('camera'); });
  await p.waitForTimeout(300);
  await goAdvanced(p);
  await p.waitForTimeout(300);
  const g0 = await p.evaluate(() => window.__shotref.state.settings.guides);
  await p.evaluate(() => { window.__shotref.setPref('camTab', 'output'); window.__shotref.select(null); window.__shotref.select('camera'); }); await p.waitForTimeout(300); /* the camera panel is tabbed (batch F): Guides is on the Output tab */
  ok(await focusPropSelect(p, 'Guides') !== null, 'setup: no Guides dropdown in the camera panel');
  await p.keyboard.press('c');
  await p.waitForTimeout(200);
  const s = await p.evaluate(() => ({ g: window.__shotref.state.settings.guides, view: window.__shotref.view }));
  ok(s.view === 'camera', 'C did not switch to camera view (view ' + s.view + ')');
  ok(s.g === g0, 'pressing C changed Guides from ' + g0 + ' to ' + s.g);
  await p.evaluate(() => { window.__shotref.setPref('camTab', 'shot'); window.__shotref.select(null); window.__shotref.select('camera'); }); await p.waitForTimeout(300); /* Look at is on the Shot tab */
  const v0 = await focusPropSelect(p, 'Look at');
  ok(v0 !== null, 'setup: no Look at dropdown in the camera panel');
  await p.keyboard.press('p');
  await p.waitForTimeout(300);
  const v1 = await p.evaluate(() => { const row = [...document.querySelectorAll('#props .row')].find(r => r.querySelector('label') && r.querySelector('label').textContent.trim() === 'Look at'); return { sel: row.querySelector('select').value, id: window.__shotref.state.camera.lookAtId }; });
  ok(v1.sel === v0 && (v1.id || '') === v0, 'pressing P changed Look at from "' + v0 + '" to "' + v1.sel + '" (lookAtId ' + v1.id + ')');
});

/* ---- Task 7: performance ---- */
const stats = p => p.evaluate(() => window.__shotref.renderStats());
const loadEmptyStarter = async p => {
  await fileCmd(p, 'new');
  await p.click('#startGrid .card:has-text("Empty stage")');
  const asked = await p.waitForSelector('#mConfirm:not(.hidden)', { timeout: 1500 }).then(() => true, () => false);
  if (asked) await p.click('#cfOk');
  await p.waitForFunction(() => window.__shotref.state.objects.length === 0);
};

check('idle scene stops redrawing', async ({ open }) => {
  const p = await open();
  await p.waitForTimeout(2000);
  const a = await stats(p);
  await p.waitForTimeout(1000);
  const b = await stats(p);
  ok(b.frame - a.frame <= 2, 'renderer drew ' + (b.frame - a.frame) + ' times in 1 s of idle');
  noPageErrors(p);
});

check('view updates after async model load and after resize', async ({ open, fixtures }) => {
  const p = await open();
  await p.waitForTimeout(1500);
  const t0 = await p.evaluate(() => performance.now());
  await p.setInputFiles('#fModel', path.join(fixtures, 'texcube.glb'));
  await p.waitForFunction(t => window.__shotref.renderStats().lastAsync > t, t0, { timeout: 5000 }).catch(() => { throw new Error('the model load never asked for a redraw'); });
  await p.waitForTimeout(2000);
  let s = await stats(p);
  ok(s.lastDraw >= s.lastAsync, 'no frame was drawn after the model finished loading');
  /* location photo decodes async too */
  const t1 = await p.evaluate(() => performance.now());
  await p.setInputFiles('#fPlate', path.join(fixtures, 'location.jpg'));
  await p.waitForFunction(() => { const i = document.querySelector('.plateImg'); return i && i.getAttribute('src'); });
  await p.waitForFunction(t => window.__shotref.renderStats().lastAsync > t, t1, { timeout: 5000 }).catch(() => { throw new Error('the photo decode never asked for a redraw'); });
  await p.waitForTimeout(2000);
  s = await stats(p);
  ok(s.lastDraw >= s.lastAsync, 'no frame was drawn after the photo was decoded');
  /* window resize with no input events */
  await p.waitForTimeout(500);
  const a = await stats(p);
  await p.setViewportSize({ width: 1200, height: 760 });
  await p.waitForTimeout(700);
  const b = await stats(p);
  ok(b.draws > a.draws, 'no frame drawn after the window was resized');
  const sz = await p.evaluate(() => { const c = document.querySelector('#c'); return { w: c.width, cw: Math.round(c.clientWidth * Math.min(devicePixelRatio || 1, 2)) }; });
  ok(Math.abs(sz.w - sz.cw) <= 1, 'canvas is ' + sz.w + ' px wide but shows ' + sz.cw + ' px');
  noPageErrors(p);
});

check('playback still renders every frame', async ({ open }) => {
  const p = await open();
  await p.waitForTimeout(2000);
  const a = await stats(p);
  await p.evaluate(() => document.querySelector('#bPlay').click());
  await p.waitForTimeout(1000);
  const b = await stats(p);
  await p.evaluate(() => document.querySelector('#bPlay').click());
  ok(b.draws - a.draws >= 30, 'only ' + (b.draws - a.draws) + ' frames drawn in 1 s of playback');
  noPageErrors(p);
});

check('dragging does not rebuild lists', async ({ open }) => {
  const p = await open();
  await p.waitForTimeout(500);
  const o = await p.evaluate(() => { const S = window.__shotref, o = S.state.objects.find(x => x.type === 'person'); S.select(o.id); return { id: o.id, p: o.base.p.slice(), xy: S.project(o.base.p[0], 0.9, o.base.p[2]) }; });
  await p.waitForTimeout(400); /* selecting rebuilds the lists (and may resize the timeline); that is not the drag */
  o.xy = await p.evaluate(p => window.__shotref.project(p[0], 0.9, p[2]), o.p); /* the view may have resized */
  const r0 =await p.evaluate(() => window.__shotref.rebuilds);
  await p.mouse.move(o.xy[0], o.xy[1]);
  await p.mouse.down();
  for (let i = 1; i <= 20; i++) { await p.mouse.move(o.xy[0] + i * 6, o.xy[1] + i * 2); await p.waitForTimeout(20); }
  await p.mouse.up();
  await p.waitForTimeout(300);
  const r1 = await p.evaluate(() => window.__shotref.rebuilds);
  const moved = await p.evaluate(id => window.__shotref.state.objects.find(x => x.id === id).base.p, o.id);
  ok(Math.abs(moved[0] - o.p[0]) > 0.2, 'setup: the person did not move (' + JSON.stringify(moved) + ')');
  ok(r1 - r0 <= 2, 'outliner and timeline were rebuilt ' + (r1 - r0) + ' times during one drag');
  noPageErrors(p);
});

check('models are freed on new project', async ({ open, fixtures }) => {
  const p = await open();
  const box = await p.locator('#c').boundingBox();
  const importAndPlace = async (n, i) => {
    await p.setInputFiles('#fModel', path.join(fixtures, 'texcube.glb'));
    await p.waitForFunction(n => window.__shotref.state.objects.filter(o => o.type === 'model').length === n, n);
    await p.waitForTimeout(500);
    await p.mouse.click(box.x + box.width * (0.3 + i * 0.1), box.y + box.height / 2);
    await p.waitForTimeout(300);
  };
  /* warm-up: the first selection uploads the helper shapes (turn ring etc.) once; they stay and are not a leak */
  await importAndPlace(1, 0);
  await loadEmptyStarter(p);
  await p.waitForTimeout(800);
  const g0 = (await stats(p)).geometries;
  for (let i = 1; i <= 3; i++) await importAndPlace(i, i);
  await p.waitForTimeout(500);
  const g1 = (await stats(p)).geometries;
  ok(g1 > g0, 'setup: geometry count did not rise after importing models (' + g0 + ' -> ' + g1 + ')');
  await loadEmptyStarter(p);
  await p.waitForTimeout(1000);
  const g2 = (await stats(p)).geometries;
  ok(g2 <= g0 + 2, 'geometries: ' + g0 + ' before, ' + g1 + ' with 3 models, ' + g2 + ' after a new scene');
  noPageErrors(p);
});

check('hud is not rewritten when idle', async ({ open }) => {
  const p = await open();
  await blurAll(p);
  await p.keyboard.press('c');
  await p.waitForTimeout(2000);
  const watch = () => p.evaluate(() => new Promise(res => {
    let n = 0; const mo = new MutationObserver(l => { n += l.length; });
    for (const id of ['hud', 'hint']) mo.observe(document.getElementById(id), { childList: true, subtree: true, characterData: true, attributes: true });
    setTimeout(() => { mo.disconnect(); res(n); }, 1000);
  }));
  const idleN = await watch();
  ok(idleN <= 2, idleN + ' changes to the HUD and hint in 1 s of idle');
  await p.evaluate(() => document.querySelector('#bPlay').click());
  await p.waitForTimeout(200);
  const playN = await watch();
  await p.evaluate(() => document.querySelector('#bPlay').click());
  ok(playN <= 2, playN + ' changes to the HUD and hint in 1 s of playback with a still camera');
  noPageErrors(p);
});

/* S4: keyframe maths moved to src/keys.js. Expected values were captured once from the
   original build (Shotref-backup-2026-11-22) with the same in-page script; behaviour must not change. */
const KEYS_EVAL = `(() => {
  const S = window.__shotref, st = S.state, out = { keys: null, rows: [] };
  const fps0 = st.settings.fps, m0 = st.settings.interp;
  st.settings.fps = 24;
  const keys = [];
  S.setKey(keys, 0, { p: [0, 0, 0], r: [0, 10, 0], s: [1, 1, 1] });
  S.setKey(keys, 1.013, { p: [2, 0.5, -1], r: [0, 90, 5], s: [1, 1.2, 1] });
  S.setKey(keys, 2.5, { p: [3, 0, 4], r: [0, -30, 0], s: [0.8, 1, 1] });
  S.setKey(keys, 0.99, { p: [2.2, 0.5, -1] });
  S.setKey(keys, 4.02, { p: [-1, 0, 2], r: [10, 200, 0], s: [1, 1, 1] });
  S.setKey(keys, 3.1, { p: [0.5, 1, 3], r: [0, 120, -8], s: [1.1, 0.9, 1] });
  out.keys = JSON.parse(JSON.stringify(keys));
  const o = { keys, base: null };
  for (const mode of ['linear', 'smooth', 'natural', 'ease']) {
    st.settings.interp = mode;
    for (let i = 0; i < 50; i++) { const t = -0.2 + i * 4.6 / 49, v = S.evalObj(o, t); out.rows.push([...v.p, ...v.r, ...v.s]); }
  }
  st.settings.fps = fps0; st.settings.interp = m0;
  return out;
})()`;
const KEYS_EXPECTED_KEYS = [{"t":0,"p":[0,0,0],"r":[0,10,0],"s":[1,1,1]},{"t":1,"p":[2.2,0.5,-1],"r":[0,90,5],"s":[1,1.2,1]},{"t":2.5,"p":[3,0,4],"r":[0,-30,0],"s":[0.8,1,1]},{"t":3.0833333333333335,"p":[0.5,1,3],"r":[0,120,-8],"s":[1.1,0.9,1]},{"t":4,"p":[-1,0,2],"r":[10,200,0],"s":[1,1,1]}];
/* 50 times x [p, r, s] for each interp mode: linear, smooth, natural, ease */
const KEYS_EXPECTED_ROWS = [].concat(
  [[0,0,0,0,10,0,1,1,1],[0,0,0,0,10,0,1,1,1],[0,0,0,0,10,0,1,1,1],[0.17959183673469384,0.040816326530612235,-0.08163265306122447,0,16.53061224489796,0.40816326530612235,1,1.0163265306122449,1],[0.38612244897959175,0.0877551020408163,-0.1755102040816326,0,24.040816326530607,0.8775510204081629,1,1.0351020408163265,1],[0.5926530612244899,0.1346938775510204,-0.2693877551020408,0,31.551020408163268,1.3469387755102042,1,1.0538775510204081,1],[0.7991836734693878,0.18163265306122447,-0.36326530612244895,0,39.06122448979592,1.8163265306122447,1,1.0726530612244898,1],[1.0057142857142856,0.2285714285714285,-0.457142857142857,0,46.57142857142856,2.285714285714285,1,1.0914285714285714,1],[1.2122448979591836,0.2755102040816326,-0.5510204081632653,0,54.08163265306122,2.7551020408163263,1,1.110204081632653,1],[1.4187755102040818,0.3224489795918367,-0.6448979591836734,0,61.59183673469387,3.224489795918367,1,1.1289795918367347,1],[1.6253061224489798,0.3693877551020408,-0.7387755102040816,0,69.10204081632654,3.693877551020408,1,1.1477551020408163,1],[1.8318367346938778,0.4163265306122449,-0.8326530612244898,0,76.61224489795919,4.163265306122449,1,1.166530612244898,1],[2.0383673469387755,0.463265306122449,-0.926530612244898,0,84.12244897959184,4.63265306122449,1,1.1853061224489796,1],[2.2108843537414966,0.4931972789115646,-0.9319727891156462,0,88.36734693877551,4.931972789115646,0.9972789115646259,1.1972789115646258,1],[2.260952380952381,0.461904761904762,-0.6190476190476196,0,80.85714285714288,4.6190476190476195,0.9847619047619048,1.1847619047619047,1],[2.3110204081632655,0.4306122448979592,-0.30612244897959173,0,73.3469387755102,4.3061224489795915,0.9722448979591837,1.1722448979591835,1],[2.3610884353741497,0.3993197278911565,0.006802721088434938,0,65.83673469387756,3.9931972789115653,0.9597278911564626,1.1597278911564626,1],[2.411156462585034,0.36802721088435375,0.3197278911564623,0,58.32653061224491,3.6802721088435377,0.9472108843537416,1.1472108843537414,1],[2.4612244897959186,0.33673469387755106,0.6326530612244894,0,50.81632653061226,3.3673469387755106,0.9346938775510204,1.1346938775510205,1],[2.511292517006803,0.30544217687074837,0.9455782312925165,0,43.3061224489796,3.0544217687074835,0.9221768707482993,1.1221768707482993,1],[2.5613605442176874,0.27414965986394557,1.2585034013605445,0,35.79591836734693,2.7414965986394555,0.9096598639455782,1.1096598639455781,1],[2.6114285714285717,0.24285714285714288,1.5714285714285712,0,28.285714285714292,2.428571428571429,0.8971428571428571,1.0971428571428572,1],[2.661496598639456,0.21156462585034014,1.8843537414965987,0,20.775510204081627,2.1156462585034013,0.8846258503401361,1.084625850340136,1],[2.7115646258503405,0.18027210884353734,2.1972789115646267,0,13.265306122448962,1.8027210884353733,0.8721088435374149,1.0721088435374149,1],[2.7616326530612243,0.14897959183673476,2.5102040816326525,0,5.75510204081634,1.4897959183673475,0.859591836734694,1.059591836734694,1],[2.8117006802721085,0.11768707482993213,2.8231292517006787,0,-1.755102040816297,1.1768707482993213,0.8470748299319729,1.0470748299319728,1],[2.861768707482993,0.08639455782312933,3.1360544217687067,0,-9.265306122448962,0.8639455782312933,0.8345578231292518,1.0345578231292518,1],[2.9118367346938774,0.05510204081632669,3.448979591836733,0,-16.7755102040816,0.551020408163267,0.8220408163265307,1.0220408163265307,1],[2.9619047619047616,0.023809523809524002,3.76190476190476,0,-24.285714285714235,0.23809523809523991,0.8095238095238096,1.0095238095238095,1],[2.9037900874635607,0.03848396501457581,3.9615160349854244,0,-24.22740524781363,-0.30787172011660646,0.8115451895043728,0.9961516034985424,1],[2.501457725947523,0.19941690962099093,3.800583090379009,0,-0.08746355685136109,-1.5953352769679274,0.8598250728862973,0.9800583090379009,1],[2.0991253644314884,0.3603498542274045,3.6396501457725954,0,24.05247813411068,-2.882798833819236,0.9081049562682214,0.9639650145772596,1],[1.6967930029154548,0.5212827988338181,3.478717201166182,0,48.19241982507272,-4.170262390670545,0.9563848396501455,0.9478717201166182,1],[1.2944606413994189,0.6822157434402325,3.3177842565597677,0,72.33236151603488,-5.45772594752186,1.0046647230320698,0.9317784256559768,1],[0.8921282798833845,0.8431486880466461,3.156851311953354,0,96.47230320699691,-6.745189504373169,1.0529446064139938,0.9156851311953355,1],[0.4961038961038968,0.9974025974025978,2.9974025974025977,0.025974025974021042,120.20779220779217,-7.979220779220783,1.09974025974026,0.9002597402597402,1],[0.3424860853432293,0.8949907235621528,2.894990723562153,1.0500927643784717,128.40074211502778,-7.1599257884972225,1.0894990723562155,0.9105009276437848,1],[0.18886827458256095,0.7925788497217072,2.7925788497217074,2.0742115027829273,136.5936920222634,-6.340630797773658,1.0792578849721708,0.9207421150278293,1],[0.03525046382189334,0.6901669758812623,2.690166975881262,3.0983302411873774,144.786641929499,-5.521335807050098,1.0690166975881263,0.9309833024118738,1],[-0.11836734693877426,0.5877551020408172,2.587755102040817,4.122448979591828,152.97959183673464,-4.702040816326537,1.0587755102040817,0.9412244897959183,1],[-0.2719851576994433,0.4853432282003711,2.485343228200371,5.146567717996289,161.17254174397033,-3.882745825602969,1.0485343228200372,0.9514656771799629,1],[-0.4256029684601108,0.3829313543599261,2.382931354359926,6.170686456400739,169.3654916512059,-3.0634508348794087,1.0382931354359926,0.9617068645640074,1],[-0.5792207792207784,0.28051948051948106,2.280519480519481,7.194805194805189,177.55844155844153,-2.2441558441558485,1.028051948051948,0.9719480519480519,1],[-0.7328385899814469,0.17810760667903547,2.1781076066790357,8.218923933209645,185.75139146567716,-1.4248608534322837,1.0178107606679037,0.9821892393320965,1],[-0.8864564007421143,0.07569573283859043,2.0756957328385903,9.243042671614095,193.94434137291276,-0.6055658627087235,1.007569573283859,0.992430426716141,1],[-1,0,2,10,200,0,1,1,1],[-1,0,2,10,200,0,1,1,1],[-1,0,2,10,200,0,1,1,1],[-1,0,2,10,200,0,1,1,1],[-1,0,2,10,200,0,1,1,1]],
  [[0,0,0,0,10,0,1,1,1],[0,0,0,0,10,0,1,1,1],[0,0,0,0,10,0,1,1,1],[0.03424423497012298,0.009451844044573261,-0.028695526523812347,0,11.610213431478378,0.09451844044573261,1.0004895919217334,1.0037807376178294,1],[0.1490402536358149,0.040799360810546595,-0.12223463352854669,0,16.93425684876199,0.4079936081054659,1.0020317955953726,1.0163197443242187,1],[0.3293186206427595,0.08930523846356536,-0.2634430483897016,0,25.137163868796165,0.8930523846356536,1.0042416285731286,1.035722095385426,1],[0.5591943628930123,0.15000542291052196,-0.4344501763720898,0,35.34526097119397,1.5000542291052197,1.0067219665275522,1.0600021691642088,1],[0.8227825072886297,0.21793586005830898,-0.6173854227405247,0,46.6848746355685,2.1793586005830896,1.0090756851311953,1.0871743440233235,1],[1.104198080731668,0.28813249581381906,-0.7943781927598195,0,58.28233134153287,2.8813249581381903,1.010905660056609,1.1152529983255275,1],[1.3875561101241827,0.35563127608394457,-0.947557891694787,0,69.2639575687001,3.556312760839446,1.0118147669763449,1.1422525104335777,1],[1.656971622368231,0.4154681467755782,-1.0590539248102406,0,78.75607979668337,4.154681467755782,1.0114058815629543,1.1661872587102313,1],[1.896559644365868,0.46267905379561236,-1.1109956973709934,0,85.88502450509566,4.626790537956124,1.0092818794889884,1.1850716215182449,1],[2.09043520301915,0.4922999430509396,-1.0855126146418583,0,89.77711817355012,4.922999430509396,1.0050456364269988,1.1969199772203758,1],[2.224491659591321,0.49965912414297015,-0.9660038350107963,0,89.61231573012378,4.998957602384746,0.9982882667621169,1.1999293819059391,1],[2.3368292771838894,0.48980422848504485,-0.77673792463017,0,86.33997123420798,4.967542926249865,0.98850507202246,1.197852264766224,1],[2.4475213548096457,0.46781369939396,-0.5385803180647517,0,80.87972109580191,4.893091739666295,0.9759679703524892,1.1930964449166588,1],[2.5550617616859697,0.4356878668153828,-0.25847333689068247,0,73.58103472306043,4.776545374373176,0.9611946942087308,1.1859325552322462,1],[2.6579443670302405,0.3954270606949801,0.056640697315901295,0,64.79338152413821,4.618845162109641,0.9447029760477101,1.1766312285879876,1],[2.754663040059839,0.3490316109784189,0.3998194629788604,0,54.86623090719004,4.420932434614829,0.9270105483259526,1.1654630978588854,1],[2.8437116499921453,0.29850184761136633,0.7641206385220563,0,44.149052280370725,4.183748523627879,0.9086351434999842,1.1526987959199415,1],[2.92358406604454,0.24583810053948918,1.142601902369352,0,32.991315051834974,3.908234760887926,0.89009449402633,1.1386089556461576,1],[2.9927741574344027,0.19304069970845483,1.5283209329446064,0,21.74248862973761,3.595332478134111,0.871906332361516,1.1234642099125365,1],[3.049775793379113,0.14210997506392994,1.9143354086716828,0,10.752042422233362,3.2459830071055675,0.8545883909620676,1.1075351915940794,1],[3.0930828430960524,0.09504625655158165,2.293703007974443,0,0.3694458374770009,2.8611276795414353,0.8386584022845105,1.0910925335657888,1],[3.1211891758025985,0.05384987411707719,2.659481409276746,0,-9.05583171637665,2.4417078271808528,0.8246340987853701,1.0744068687026664,1],[3.1325886607161353,0.020521157706083065,3.004728291002457,0,-17.174320831172935,1.9886647817629544,0.813033212921172,1.0577488298797144,1],[3.12577516705404,-0.0029395627357333975,3.3225013315754364,0,-23.636552098757033,1.5029398750268779,0.8043734771484419,1.0413890499719347,1],[3.099242564033694,-0.014531957262704946,3.6058582094195417,0,-28.09305611097411,0.9854744387117652,0.7991726239237054,1.0255981618543297,1],[3.0514847208724762,-0.012255695929165351,3.847856602958642,0,-30.19436345966957,0.4372098045567473,0.7979483857034878,1.0106467984019005,1],[2.97445693226561,0.009310106080975118,4.036626916036526,-0.005537856380471355,-29.17914929301864,-0.16413975033061395,0.8021841696873342,0.9965784643451577,1],[2.7300829503210458,0.12133465650691368,4.064471652144504,-0.12381005346064822,-16.257875733150737,-1.2927658479738846,0.8321348147944245,0.9789196289071259,1],[2.3190944005155245,0.3166130576986577,3.93376090547544,-0.3230105739989976,8.204996969078739,-2.9044481583378574,0.8864595741810141,0.9580180359871178,1],[1.815727365872601,0.5486296624854362,3.7030699354295655,-0.5058844806611703,39.153879299780826,-4.690082703449026,0.9527987346681545,0.9367746614301915,1],[1.2942179294158287,0.7708688236964781,3.4309740014071117,-0.5751768361128168,71.53318174506666,-6.3405655053338785,1.018792583076898,0.9180904810814062,1],[0.8288021741687708,0.9368148941610093,3.176048362808313,-0.4336327030195859,100.28731479104685,-7.546792586018883,1.0720814062282955,0.904866470785821,1],[0.4936534270249917,0.9999797955459956,2.9968216623989945,0.01599271027504825,120.36480166822545,-7.999838364367965,1.1003137928692996,0.9000020204454005,1],[0.24824221067520102,0.9692350192765775,2.866429860156745,0.821675602833388,134.28379175665455,-7.75388015421262,1.107204017839641,0.9030764980723422,1],[0.014659668393458988,0.8887773809012396,2.7295241794220395,1.9084921983836054,147.21192769800888,-7.110219047209917,1.1048030582380441,0.9111222619098761,1],[-0.20351381520010942,0.7714962650524239,2.5911171586630513,3.1869328814226243,159.02389603058396,-6.171970120419391,1.0951875371441797,0.9228503734947576,1],[-0.4026978554853829,0.6302810563625713,2.4562213363479515,4.567488036447387,169.5943832926756,-5.04224845090057,1.0804340776377193,0.9369718943637428,1],[-0.5793120678422402,0.4780211394641216,2.3298492509449105,5.960648047954841,178.79807602257955,-3.824169115712973,1.0626193027983333,0.9521978860535878,1],[-0.7297760676505556,0.3276058989895192,2.217013440922102,7.2769033004418935,186.50966075859145,-2.6208471919161536,1.0438198357056936,0.9672394101010481,1],[-0.8505094702902086,0.1919247195712036,2.1227264447476966,8.4267441784055,192.603824039007,-1.5353977565696288,1.0261122994394711,0.9808075280428796,1],[-0.9379318911410762,0.08386698584161567,2.052000800889866,9.320661066342593,196.955252402122,-0.6709358867329254,1.0115733170793366,0.9916133014158385,1],[-0.9884629455830358,0.016322082433198215,2.0098490478167816,9.8691443487501,199.43863238623203,-0.13057665946558572,1.0022795117049614,0.9983677917566802,1],[-1,0,2,10,200,0,1,1,1],[-1,0,2,10,200,0,1,1,1],[-1,0,2,10,200,0,1,1,1],[-1,0,2,10,200,0,1,1,1],[-1,0,2,10,200,0,1,1,1]],
  [[0,0,0,0,10,0,1,1,1],[0,0,0,0,10,0,1,1,1],[0,0,0,0,10,0,1,1,1],[0.18571173575635996,0.043876276041445304,-0.09754439051755644,0,17.118122550977905,0.438762760414453,1.0004895919217334,1.017550510416578,1],[0.41151989392175015,0.10045382451189551,-0.24154356093124452,0,26.478971040977815,1.004538245118955,1.0020317955953726,1.040181529804758,1],[0.6456734183885967,0.16120405613307381,-0.4072406837287185,0,36.640974695917514,1.6120405613307383,1.0042416285731286,1.0644816224532296,1],[0.8832082550637915,0.22364494385842631,-0.5817292182678986,0,47.127584322858674,2.2364494385842635,1.0067219665275522,1.0894579775433704,1],[1.1191603498542273,0.28529446064139935,-0.7521026239067053,0,57.46225072886296,2.8529446064139936,1.0090756851311953,1.1141177842565595,1],[1.3485656486667972,0.3436705794354393,-0.90545436000306,0,67.1684247209921,3.436705794354393,1.010905660056609,1.1374682317741758,1],[1.5664600974083922,0.3962912731939922,-1.0288778859148824,0,75.76955710630773,3.962912731939922,1.0118147669763449,1.1585165092775969,1],[1.7678796419859073,0.44067451487050463,-1.1094666610000936,0,82.78909869187159,4.406745148705046,1.0114058815629543,1.1762698059482017,1],[1.947860228306233,0.47433827741842255,-1.1343141446166138,0,87.75050028474529,4.743382774184226,1.0092818794889884,1.189735310967369,1],[2.1014378022762625,0.4948005337911924,-1.0905137961223639,0,90.17721269199056,4.9480053379119235,1.0050456364269988,1.1979202135164768,1],[2.224491659591321,0.49965912414297015,-0.9660038350107963,0,89.61231573012378,4.998957602384746,0.9982882667621169,1.1999293819059391,1],[2.3368292771838894,0.48980422848504485,-0.77673792463017,0,86.33997123420798,4.967542926249865,0.98850507202246,1.197852264766224,1],[2.4475213548096457,0.46781369939396,-0.5385803180647517,0,80.87972109580191,4.893091739666295,0.9759679703524892,1.1930964449166588,1],[2.5550617616859697,0.4356878668153828,-0.25847333689068247,0,73.58103472306043,4.776545374373176,0.9611946942087308,1.1859325552322462,1],[2.6579443670302405,0.3954270606949801,0.056640697315901295,0,64.79338152413821,4.618845162109641,0.9447029760477101,1.1766312285879876,1],[2.754663040059839,0.3490316109784189,0.3998194629788604,0,54.86623090719004,4.420932434614829,0.9270105483259526,1.1654630978588854,1],[2.8437116499921453,0.29850184761136633,0.7641206385220563,0,44.149052280370725,4.183748523627879,0.9086351434999842,1.1526987959199415,1],[2.92358406604454,0.24583810053948918,1.142601902369352,0,32.991315051834974,3.908234760887926,0.89009449402633,1.1386089556461576,1],[2.9927741574344027,0.19304069970845483,1.5283209329446064,0,21.74248862973761,3.595332478134111,0.871906332361516,1.1234642099125365,1],[3.049775793379113,0.14210997506392994,1.9143354086716828,0,10.752042422233362,3.2459830071055675,0.8545883909620676,1.1075351915940794,1],[3.0930828430960524,0.09504625655158165,2.293703007974443,0,0.3694458374770009,2.8611276795414353,0.8386584022845105,1.0910925335657888,1],[3.1211891758025985,0.05384987411707719,2.659481409276746,0,-9.05583171637665,2.4417078271808528,0.8246340987853701,1.0744068687026664,1],[3.1325886607161353,0.020521157706083065,3.004728291002457,0,-17.174320831172935,1.9886647817629544,0.813033212921172,1.0577488298797144,1],[3.12577516705404,-0.0029395627357333975,3.3225013315754364,0,-23.636552098757033,1.5029398750268779,0.8043734771484419,1.0413890499719347,1],[3.099242564033694,-0.014531957262704946,3.6058582094195417,0,-28.09305611097411,0.9854744387117652,0.7991726239237054,1.0255981618543297,1],[3.0514847208724762,-0.012255695929165351,3.847856602958642,0,-30.19436345966957,0.4372098045567473,0.7979483857034878,1.0106467984019005,1],[2.97445693226561,0.009310106080975118,4.036626916036526,-0.005537856380471355,-29.17914929301864,-0.16413975033061395,0.8021841696873342,0.9965784643451577,1],[2.7300829503210458,0.12133465650691368,4.064471652144504,-0.12381005346064822,-16.257875733150737,-1.2927658479738846,0.8321348147944245,0.9789196289071259,1],[2.3190944005155245,0.3166130576986577,3.93376090547544,-0.3230105739989976,8.204996969078739,-2.9044481583378574,0.8864595741810141,0.9580180359871178,1],[1.815727365872601,0.5486296624854362,3.7030699354295655,-0.5058844806611703,39.153879299780826,-4.690082703449026,0.9527987346681545,0.9367746614301915,1],[1.2942179294158287,0.7708688236964781,3.4309740014071117,-0.5751768361128168,71.53318174506666,-6.3405655053338785,1.018792583076898,0.9180904810814062,1],[0.8288021741687708,0.9368148941610093,3.176048362808313,-0.4336327030195859,100.28731479104685,-7.546792586018883,1.0720814062282955,0.904866470785821,1],[0.49366352049030526,0.9999865245228713,2.99682839137587,0.01592542050629114,120.36426335007539,-7.99989219618297,1.1003144657669872,0.9000013475477129,1],[0.2630457351142677,0.9791040355692886,2.8762988764494564,0.7229854399062767,133.49427045323765,-7.832832284554309,1.1081909194689121,0.9020895964430712,1],[0.06580898253045173,0.9228769236592348,2.763623722180035,1.5674967708036538,144.48396427736927,-7.383015389273878,1.1082130125138436,0.9077123076340766,1],[-0.10413339111534907,0.8377498811089308,2.657370774719558,2.5243967208575553,153.7236067460634,-6.701999048871446,1.1018128987498303,0.916225011889107,1],[-0.2528680396773441,0.7301676002345971,2.5561078802199773,3.5686225977271286,161.60345978291352,-5.841340801876777,1.0904227320249218,0.9269832399765403,1],[-0.3864816170097428,0.6065747733524532,2.458402884833242,4.675111709071525,168.51378531151303,-4.852598186819626,1.0754746661871664,0.9393425226647546,1],[-0.5110607769667512,0.4734160927787221,2.362823634711305,5.8188013625498645,174.84484525545523,-3.787328742229777,1.0584008550846138,0.9526583907221278,1],[-0.6326921734025793,0.3371362508296231,2.2679379760061162,6.9746288658213045,180.98690153833346,-2.697090006636985,1.0406334525653131,0.9662863749170377,1],[-0.7574624601714353,0.20417993982137628,2.1723137548696267,8.117531526544987,187.33021608374116,-1.6334395185710102,1.0236046124773126,0.9795820060178624,1],[-0.8914582911275273,0.08099185207020387,2.074518817453787,9.222446652380043,194.26505081527156,-0.647934816561631,1.008746488668662,0.9919008147929796,1],[-1,0,2,10,200,0,1,1,1],[-1,0,2,10,200,0,1,1,1],[-1,0,2,10,200,0,1,1,1],[-1,0,2,10,200,0,1,1,1],[-1,0,2,10,200,0,1,1,1]],
  [[0,0,0,0,10,0,1,1,1],[0,0,0,0,10,0,1,1,1],[0,0,0,0,10,0,1,1,1],[0.04158811379612235,0.009451844044573261,-0.018903688089146522,0,11.51229504713172,0.09451844044573261,1,1.0037807376178294,1],[0.17951718756640503,0.040799360810546595,-0.08159872162109319,0,16.527897729687457,0.4079936081054659,1,1.0163197443242187,1],[0.39294304923968765,0.08930523846356536,-0.17861047692713072,0,24.288838154170456,0.8930523846356536,1,1.035722095385426,1],[0.6600238608062967,0.15000542291052196,-0.3000108458210439,0,34.000867665683515,1.5000542291052197,1,1.0600021691642088,1],[0.9589177842565596,0.21793586005830898,-0.43587172011661796,0,44.869737609329434,2.1793586005830896,1,1.0871743440233235,1],[1.267782981580804,0.28813249581381906,-0.5762649916276381,0,56.10119933021105,2.8813249581381903,1,1.1152529983255275,1],[1.5647776147693562,0.35563127608394457,-0.7112625521678891,0,66.90100417343113,3.556312760839446,1,1.1422525104335777,1],[1.828059845812544,0.4154681467755782,-0.8309362935511564,0,76.47490348409252,4.154681467755782,1,1.1661872587102313,1],[2.0357878367006945,0.46267905379561236,-0.9253581075912247,0,84.02864860729797,4.626790537956124,1,1.1850716215182449,1],[2.1661197494241344,0.4922999430509396,-0.9845998861018792,0,88.76799088815034,4.922999430509396,1,1.1969199772203758,1],[2.200440229773246,0.4997248563917214,-0.9972485639172138,0,89.93396553401313,4.997248563917214,0.9998899425566885,1.1998899425566885,1],[2.213224317028399,0.4917348018572509,-0.9173480185725087,0,88.01635244574021,4.9173480185725085,0.9966939207429004,1.1966939207429004,1],[2.2419445367151445,0.47378466455303486,-0.7378466455303486,0,83.70831949272836,4.7378466455303485,0.9895138658212139,1.1895138658212139,1],[2.284247559485639,0.4473452753214758,-0.47345275321475766,0,77.3628660771542,4.473452753214758,0.9789381101285903,1.1789381101285903,1],[2.3377800559920394,0.41388746500497564,-0.1388746500497562,0,69.33299160119415,4.138874650049757,0.9655549860019903,1.1655549860019903,1],[2.4001886968865014,0.3748820644459367,0.2511793555406331,0,59.9716954670248,3.748820644459367,0.9499528257783747,1.1499528257783747,1],[2.469120152821182,0.3317999044867612,0.6820009551323878,0,49.63197707682269,3.317999044867612,0.9327199617947045,1.1327199617947046,1],[2.542221094448238,0.28611181596985125,1.1388818403014873,0,38.666835832764306,2.8611181596985125,0.9144447263879405,1.1144447263879405,1],[2.617138192419825,0.23928862973760934,1.6071137026239066,0,27.42927113702624,2.3928862973760934,0.8957154518950438,1.0957154518950438,1],[2.6915181173881,0.1928011766324374,2.071988233675626,0,16.272282391784973,1.9280117663243739,0.8771204706529749,1.077120470652975,1],[2.7630075400052196,0.14812028749673772,2.5187971250326227,0,5.548868999217053,1.4812028749673773,0.8592481149986951,1.0592481149986952,1],[2.8292531309233393,0.10671679317291277,2.9328320682708724,0,-4.387969638500934,1.0671679317291276,0.8426867172691651,1.0426867172691652,1],[2.8879015607946172,0.07006152450336428,3.2993847549663573,0,-13.185234119192572,0.7006152450336428,0.8280246098013457,1.0280246098013457,1],[2.9365995002712086,0.03962531233049471,3.6037468766950527,0,-20.48992504068127,0.3962531233049471,0.8158501249321979,1.0158501249321978,1],[2.9729936200052696,0.016878987496706577,3.8312101250329342,0,-25.94904300079042,0.16878987496706577,0.8067515949986827,1.0067515949986827,1],[2.994730590648958,0.003293380844401339,3.9670661915559866,0,-29.20958859734368,0.03293380844401339,0.8013173523377606,1.0013173523377605,1],[2.9891773600312863,0.004329055987485505,3.995670944012515,0,-29.350641601877175,-0.03463244789988404,0.8012987167962458,0.9995670944012515,1],[2.7413978859436288,0.10344084562254838,3.8965591543774516,0,-14.483873156617744,-0.827526764980387,0.8310322536867645,0.9896559154377451,1],[2.260070646968438,0.29597174121262465,3.7040282587873756,0,14.395761181893697,-2.367773929700997,0.8887915223637874,0.9704028258787376,1],[1.6702377053927342,0.5319049178429064,3.4680950821570935,0,49.78573767643596,-4.255239342743251,0.959571475352872,0.9468095082157093,1],[1.0969411235035342,0.7612235505985863,3.2387764494014135,0,84.18353258978794,-6.08978840478869,1.028367065179576,0.9238776449401414,1],[0.6652229635878671,0.9339108145648531,3.066089185435147,0,110.08662218472797,-7.471286516518825,1.080173244369456,0.9066089185435147,1],[0.4999696933189934,0.9999797955459956,2.9999797955459955,0.00020204454004412608,120.00161635632035,-7.999838364367965,1.0999979795545995,0.9000020204454005,1],[0.45385252891486627,0.9692350192765775,2.9692350192765775,0.30764980723422475,122.46119845787379,-7.75388015421262,1.0969235019276578,0.9030764980723422,1],[0.3331660713518594,0.8887773809012396,2.8887773809012396,1.1122261909876043,128.89780952790085,-7.110219047209917,1.088877738090124,0.9111222619098761,1],[0.1572443975786358,0.7714962650524239,2.7714962650524235,2.285037349475761,138.2802987958061,-6.171970120419391,1.0771496265052425,0.9228503734947576,1],[-0.054578415456143115,0.6302810563625713,2.6302810563625716,3.6971894363742877,149.5775154909943,-5.04224845090057,1.0630281056362572,0.9369718943637428,1],[-0.2829682908038176,0.4780211394641216,2.4780211394641216,5.219788605358784,161.75830884287026,-3.824169115712973,1.0478021139464122,0.9521978860535878,1],[-0.5085911515157212,0.3276058989895192,2.3276058989895194,6.723941010104808,173.79152808083848,-2.6208471919161536,1.032760589898952,0.9672394101010481,1],[-0.7121129206431946,0.1919247195712036,2.1919247195712037,8.080752804287965,184.64602243430372,-1.5353977565696288,1.0191924719571204,0.9808075280428796,1],[-0.8741995212375765,0.08386698584161567,2.083866985841616,9.161330141583843,193.29064113267074,-0.6709358867329254,1.0083866985841616,0.9916133014158385,1],[-0.9755168763502027,0.016322082433198215,2.016322082433198,9.836779175668017,198.69423340534414,-0.13057665946558572,1.0016322082433198,0.9983677917566802,1],[-1,0,2,10,200,0,1,1,1],[-1,0,2,10,200,0,1,1,1],[-1,0,2,10,200,0,1,1,1],[-1,0,2,10,200,0,1,1,1],[-1,0,2,10,200,0,1,1,1]]);
check('keyframe maths unchanged', async ({ open }) => {
  const p = await open();
  const got = await p.evaluate(KEYS_EVAL);
  ok(canon(got.keys) === canon(KEYS_EXPECTED_KEYS), 'setKey made different keys: ' + JSON.stringify(got.keys.map(k => k.t)));
  ok(got.rows.length === KEYS_EXPECTED_ROWS.length, 'expected ' + KEYS_EXPECTED_ROWS.length + ' samples, got ' + got.rows.length);
  got.rows.forEach((row, i) => row.forEach((v, j) => {
    const e = KEYS_EXPECTED_ROWS[i][j];
    ok(Math.abs(v - e) <= 1e-9, 'sample ' + i + ' value ' + j + ' is ' + v + ', expected ' + e);
  }));
  noErrors(p);
});

check('view redraws after the graphics card resets', async ({ open }) => {
  const p = await open();
  await p.waitForTimeout(1500);
  const lost = await p.evaluate(() => new Promise(res => {
    const c = document.querySelector('#c'), gl = c.getContext('webgl2') || c.getContext('webgl'), ext = gl && gl.getExtension('WEBGL_lose_context');
    if (!ext) { res('no WEBGL_lose_context'); return; }
    window.__loseExt = ext;
    c.addEventListener('webglcontextlost', () => res('ok'), { once: true });
    ext.loseContext();
  }));
  ok(lost === 'ok', 'setup: ' + lost);
  await p.waitForTimeout(1500); /* let the keep-alive run out */
  const a = await stats(p);
  const t0 = await p.evaluate(() => new Promise(res => {
    const c = document.querySelector('#c');
    c.addEventListener('webglcontextrestored', () => res(performance.now()), { once: true });
    window.__loseExt.restoreContext();
  }));
  await p.waitForTimeout(1000);
  const b = await stats(p);
  ok(b.draws > a.draws && b.lastDraw >= t0, 'no frame drawn within 1 s of the context coming back (' + (b.draws - a.draws) + ' draws)');
  noPageErrors(p);
});

check('a drag cut off by the browser still saves the move', async ({ open }) => {
  const p = await open();
  await p.waitForTimeout(500);
  const o = await p.evaluate(() => { const S = window.__shotref, o = S.state.objects.find(x => x.type === 'person'); S.select(o.id); return { id: o.id, p: o.base.p.slice() }; });
  await p.waitForTimeout(400);
  const xy = await p.evaluate(p => window.__shotref.project(p[0], 0.9, p[2]), o.p);
  const h0 = await p.evaluate(() => window.__shotref.history.length);
  await p.mouse.move(xy[0], xy[1]);
  await p.mouse.down();
  for (let i = 1; i <= 10; i++) { await p.mouse.move(xy[0] + i * 8, xy[1]); await p.waitForTimeout(20); }
  await p.evaluate(() => document.querySelector('#c').dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })));
  await p.waitForTimeout(300);
  const h1 = await p.evaluate(() => window.__shotref.history.length);
  const at = await p.evaluate(id => window.__shotref.state.objects.find(x => x.id === id).base.p[0], o.id);
  for (let i = 1; i <= 5; i++) { await p.mouse.move(xy[0] + 80 + i * 8, xy[1]); await p.waitForTimeout(20); }
  const after = await p.evaluate(id => window.__shotref.state.objects.find(x => x.id === id).base.p[0], o.id);
  ok(after === at, 'the drag kept going after the browser cancelled it (x ' + at + ' -> ' + after + ')');
  await p.mouse.up();
  await p.waitForTimeout(300);
  const h2 = await p.evaluate(() => window.__shotref.history.length);
  const moved = await p.evaluate(id => window.__shotref.state.objects.find(x => x.id === id).base.p, o.id);
  ok(Math.abs(moved[0] - o.p[0]) > 0.2, 'setup: the person did not move (' + JSON.stringify(moved) + ')');
  ok(h1 === h0 + 1, 'history went from ' + h0 + ' to ' + h1 + ' after the cancelled drag');
  ok(h2 === h1, 'the mouse-up after the cancel added another step (' + h1 + ' to ' + h2 + ')');
  await blurAll(p);
  await p.keyboard.press('Control+z');
  const back = await p.evaluate(id => window.__shotref.state.objects.find(x => x.id === id).base.p[0], o.id);
  ok(Math.abs(back - o.p[0]) < 1e-6, 'undo did not put the person back (x ' + back + ', was ' + o.p[0] + ')');
  noPageErrors(p);
});

check('clicking outside a dialog returns focus', async ({ open }) => {
  const p = await open();
  await gearCmd(p, 'help');
  ok(await isOpen(p, 'mHelp'), 'setup: Help did not open');
  await p.mouse.click(4, 450);
  ok(!(await isOpen(p, 'mHelp')), 'clicking the dark backdrop did not close Help');
  const a = await p.evaluate(() => document.activeElement && document.activeElement.id);
  ok(a === 'bMenu', 'focus went to "' + a + '", not back to the gear button the guide was opened from');
});

check('selecting an object does not resize the view', async ({ open }) => {
  const p = await open();
  await p.evaluate(() => window.__shotref.select(null));
  await p.waitForTimeout(300);
  const h0 = await p.evaluate(() => document.querySelector('#c').clientHeight);
  await p.evaluate(() => { const S = window.__shotref; S.select(S.state.objects.find(x => x.type === 'person').id); });
  await p.waitForTimeout(300);
  const h1 = await p.evaluate(() => document.querySelector('#c').clientHeight);
  await p.evaluate(() => window.__shotref.select(null));
  await p.waitForTimeout(300);
  const h2 = await p.evaluate(() => document.querySelector('#c').clientHeight);
  ok(h1 === h0 && h2 === h0, 'view height went ' + h0 + ' -> ' + h1 + ' -> ' + h2 + ' px');
});

check('first launch focuses a starter set, not the close button', async ({ freshContext }) => {
  const fc = await freshContext({ firstLaunch: true });
  const p = await fc.open();
  await skipTour(p);
  await p.waitForFunction(() => !document.querySelector('#mStart').classList.contains('hidden'), null, { timeout: 3000 });
  const a = await p.evaluate(() => { const e = document.activeElement; return e ? e.className + ':' + e.textContent.slice(0, 20) : 'none'; });
  ok(/^card:/.test(a), 'focus is on "' + a + '"');
});

/* ---- final review fixes ---- */
/* records the text of every toast shown (one entry per toast() call) in window.__toasts */
const TOAST_LOG = () => {
  window.__toasts = [];
  /* watches the whole document so toasts shown during boot (before #toast is parsed into reach) are caught */
  new MutationObserver(recs => { for (const r of recs) if (r.target.id === 'toast' && r.target.textContent) window.__toasts.push(r.target.textContent); })
    .observe(document, { childList: true, subtree: true });
};
const projectText = st => JSON.stringify({ app: 'ShotRef', version: 2, state: { camera: { base: JSON.parse(CAM_BASE), keys: [] }, objects: [], ...st }, assets: {} });

check('wrong setting and focus values fall back to defaults', async ({ open }) => {
  const cam = extra => ({ base: JSON.parse(CAM_BASE), keys: [], ...extra });
  const files = {
    'unknown style': { settings: { style: 'bogus' } },
    'text f-stop': { camera: cam({ dof: { on: true, fstop: 'x', auto: 'yes' } }) },
    'wrong types': { settings: { aspect: 'nope', guides: 3, env: 5, interp: 'zz', loop: 'yes', fogDensity: 'thick', sky: 7, duration: '4' }, camera: cam({ feel: 'wobbly', dof: 'on' }) },
  };
  for (const [what, st] of Object.entries(files)) {
    const p = await open();
    await openFile(p, 'bad.shotref.json', projectText(st));
    await p.evaluate(() => window.__shotref.setView('camera'));
    await p.waitForTimeout(1000);
    noPageErrors(p, what + ': camera view');
    const s = await stateOf(p), set = s.settings, dof = s.camera.dof;
    ok(set.style === 'shaded' && set.aspect === '16:9' && set.guides === 'thirds' && set.env === 'day' && set.interp === 'smooth', what + ': list settings not reset: ' + [set.style, set.aspect, set.guides, set.env, set.interp].join(','));
    ok(set.loop === true && set.fogDensity === 0.018 && set.sky === '#9cc2ea' && set.duration === 5, what + ': typed settings not reset: ' + [set.loop, set.fogDensity, set.sky, set.duration].join(','));
    ok(dof && typeof dof.fstop === 'number' && dof.fstop > 0 && typeof dof.on === 'boolean' && typeof dof.auto === 'boolean', what + ': dof not cleaned: ' + JSON.stringify(dof));
    ok(s.camera.feel === 'gentle', what + ': feel is ' + s.camera.feel);
    await p.close();
  }
}, { timeout: 90000 });

check('no storage: one clear toast, no size warning, no console spam', async ({ freshContext, fixtures }) => {
  const fc = await freshContext();
  await fc.ctx.addInitScript(() => {
    const thr = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
    for (const k of ['localStorage', 'sessionStorage', 'indexedDB']) Object.defineProperty(window, k, { get: thr, configurable: true });
  });
  await fc.ctx.addInitScript(TOAST_LOG);
  const p = await fc.open();
  await p.waitForTimeout(800);
  ok(await isOpen(p, 'mTour'), 'the tour question did not open on this first visit');
  await p.click('#tourNo');
  ok(await isOpen(p, 'mStart'), 'starter sets did not open on this first visit');
  await p.evaluate(() => { const S = window.__shotref; S.addObject('box'); S.changed(true); });
  await p.waitForTimeout(700);
  await p.setInputFiles('#fPlate', path.join(fixtures, 'location.jpg'));
  await p.waitForFunction(() => window.__shotref.state.plate && window.__shotref.state.plate.asset);
  await p.waitForTimeout(1500);
  const toasts = await p.evaluate(() => window.__toasts);
  ok(toasts.includes("Autosave isn't available here. Use Save to keep your work."), 'no boot toast about autosave (toasts: ' + JSON.stringify(toasts) + ')');
  ok(!toasts.some(t => /too big to autosave/i.test(t)), 'showed a size warning: ' + JSON.stringify(toasts));
  const spam = p.__errors.filter(e => /autosave/i.test(e));
  ok(spam.length === 0, spam.length + ' autosave console error(s): ' + (spam[0] || '').slice(0, 100));
  noPageErrors(p, 'no storage');
});

check('build escapes </script inside the app code', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'build.mjs'), 'utf8');
  const m = /\.replace\(\/<\\\/script\/gi,\s*('[^']*')\)/.exec(src);
  ok(m, 'setup: could not find the </script replace in build.mjs');
  const out = 'x</script>y'.replace(/<\/script/gi, eval(m[1]));
  ok(out === 'x<\\/script>y', 'replacement gives ' + JSON.stringify(out));
});

check('Tab from the depth range fields stays in the export dialog', async ({ open }) => {
  const p = await open();
  await p.evaluate(() => { const s = window.__shotref.state.settings; s.style = 'depth'; s.depthAuto = false; window.__shotref.changed(true, true); });
  await exportDialog(p);
  const n = await p.evaluate(() => document.querySelectorAll('#exDepthRow .nf input').length);
  ok(n === 2, 'setup: expected Near and Far fields, found ' + n);
  for (const i of [0, 1]) {
    await p.evaluate(i => document.querySelectorAll('#exDepthRow .nf input')[i].focus(), i);
    await p.keyboard.press('Tab');
    const w = await p.evaluate(() => { const a = document.activeElement; return a && document.querySelector('#mExport').contains(a) ? 'ok' : (a ? a.tagName + '#' + a.id : 'none'); });
    ok(w === 'ok', 'Tab from field ' + (i + 1) + ' left the dialog: ' + w);
  }
});

check('depth range labels cannot be dragged while exporting', async ({ open }) => {
  const p = await open();
  await p.evaluate(() => { const s = window.__shotref.state.settings; s.style = 'depth'; s.depthAuto = false; s.depthNear = 1; s.depthFar = 20; window.__shotref.changed(true, true); });
  await startExport(p, 1280, 4);
  await p.waitForFunction(() => /Rendering frame/.test(document.querySelector('#exTxt').textContent), null, { timeout: 20000 });
  const b = await p.locator('#exDepthRow .nf-l').first().boundingBox();
  ok(b, 'setup: no Near label');
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await p.mouse.down();
  for (let i = 1; i <= 8; i++) await p.mouse.move(b.x + b.width / 2 + i * 20, b.y + b.height / 2);
  await p.mouse.up();
  const near = await p.evaluate(() => window.__shotref.state.settings.depthNear);
  ok(near === 1, 'depthNear changed during export: ' + near);
  await p.click('#exCancel');
  await p.waitForFunction(() => document.querySelector('#exCancel').hidden, null, { timeout: 20000 });
}, { timeout: 60000 });

check('small mp4 shows its size in KB', async ({ open, downloads }) => {
  const p = await open();
  await startExport(p, 320, 0.5);
  const f = await downloads(p).wait('.mp4', 50000);
  ok(f.size < 0.1 * 1048576, 'setup: test video is ' + f.size + ' bytes, not under 0.1 MB');
  const t = await p.textContent('#exTxt');
  ok(/^Done: \d+ KB$/.test(t), 'progress says "' + t + '"');
}, { timeout: 80000 });

check('repeated object ids are made unique', async ({ open }) => {
  const p = await open();
  const objs = [{ id: 'a', type: 'box', base: { p: [0, 0, 0] } }, { id: 'a', type: 'sphere', base: { p: [1, 0, 0] } }, { id: 'a', type: 'cone', base: { p: [2, 0, 0] } }];
  await openFile(p, 'dup.shotref.json', projectText({ objects: objs, camera: { base: JSON.parse(CAM_BASE), keys: [], lookAtId: 'a' } }));
  const s = await stateOf(p);
  const ids = s.objects.map(o => o.id);
  ok(ids.length === 3 && new Set(ids).size === 3, 'ids: ' + ids.join(','));
  ok(s.objects[0].id === 'a' && s.objects[0].type === 'box', 'first object lost its id');
  ok(s.camera.lookAtId === 'a', 'lookAtId is ' + s.camera.lookAtId);
  noPageErrors(p);
});

check('data URL cache forgets removed files', async ({ open, fixtures }) => {
  const p = await open();
  await p.setInputFiles('#fPlate', path.join(fixtures, 'location.jpg'));
  await p.waitForFunction(() => { const i = document.querySelector('.plateImg'); return i && i.getAttribute('src'); });
  const id = await p.evaluate(() => window.__shotref.state.plate.asset);
  const before = await p.evaluate(() => typeof window.__shotref.urlCacheIds === 'function' ? window.__shotref.urlCacheIds() : null);
  ok(Array.isArray(before) && before.includes(id), 'setup: photo not in the cache: ' + JSON.stringify(before));
  await p.evaluate(id => { const S = window.__shotref; S.state.plate = null; delete S.assets[id]; S.addObject('box'); /* rebuilds the scene */ }, id);
  await p.waitForTimeout(300);
  const after = await p.evaluate(() => window.__shotref.urlCacheIds());
  ok(!after.includes(id), 'removed photo still cached');
});

check('frame pack (from the Video options window) stops after a failed frame', async ({ open }) => {
  const p = await open();
  await p.evaluate(TOAST_LOG);
  await p.evaluate(() => { HTMLCanvasElement.prototype.toBlob = function (cb) { cb(null); }; });
  await exportDialog(p);
  await p.click('#exEnds');
  await p.waitForTimeout(1500);
  const n = await p.evaluate(() => window.__toasts.filter(t => /Could not make that frame/.test(t)).length);
  ok(n === 1, 'error toast shown ' + n + ' times');
  noPageErrors(p);
});

check('focus returns to Export video when an export ends', async ({ open, downloads }) => {
  const p = await open();
  await startExport(p, 1280, 1);
  await downloads(p).wait('.mp4', 50000);
  await p.waitForFunction(() => document.querySelector('#exCancel').hidden, null, { timeout: 20000 });
  const a = await p.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.tagName));
  ok(a === 'exVideo', 'focus is on ' + a);
}, { timeout: 80000 });

check('branding: tab icon, top-bar mark and welcome header', async ({ open, freshContext }) => {
  const p = await open();
  const r = await p.evaluate(() => ({
    title: document.title,
    icon: (document.querySelector('link[rel=icon]') || {}).href || '',
    mark: !!document.querySelector('.brand svg.mark'),
    dot: !!document.querySelector('.brand .dot'),
    tag: (document.querySelector('.brand small') || {}).textContent }));
  ok(r.title === 'ShotRef', 'title ' + r.title);
  ok(r.icon.startsWith('data:image/svg+xml'), 'icon is a data: URL');
  ok(r.mark && !r.dot, 'top bar shows the mark, not the old dot');
  ok(r.tag === 'Camera moves for AI video', 'tagline ' + r.tag);
  const fc = await freshContext({ firstLaunch: true });
  const q = await fc.open();
  await skipTour(q);
  await q.waitForFunction(() => !document.querySelector('#mStart').classList.contains('hidden'), null, { timeout: 3000 });
  const w = await q.evaluate(() => ({ head: getComputedStyle(document.querySelector('#startHead')).display, h: document.querySelector('#mStartT').textContent }));
  ok(w.head !== 'none' && w.h === 'Start a shot', 'welcome header ' + JSON.stringify(w));
});

/* ---------------- platform layer: web save/open and the desktop bridge ---------------- */
/* a stand-in for the Electron preload: records every call, so the page's side can be checked */
const FAKE_DESKTOP = `(() => {
  const d = window.__dsk = { calls: [], titles: [], menu: null, openCb: null, nextOpen: null, fail: false, cancel: false, closed: 0 };
  window.shotrefDesktop = { version: '0.0-test',
    saveBlob: async (n, buf, f) => { d.calls.push({ k: 'blob', n, size: buf.byteLength, f }); return { ok: true, name: n }; },
    saveProject: async (text, o) => {
      d.calls.push({ k: 'proj', o: JSON.parse(JSON.stringify(o || {})), len: text.length });
      if (d.fail) return { ok: false, error: 'disk full' };
      if (d.cancel) return { ok: false, canceled: true };
      const path = (o && !o.saveAs && o.path) || 'C:/shots/' + ((o && o.name) || 'new.shotref');
      return { ok: true, name: path.split('/').pop(), path };
    },
    openProject: async () => d.nextOpen, setTitle: t => d.titles.push(t),
    onMenu: cb => { d.menu = cb; }, onOpenFile: cb => { d.openCb = cb; }, closeOk: () => { d.closed++; } };
})();`;
const desktopPage = async (freshContext) => {
  const fc = await freshContext();
  await fc.ctx.addInitScript(FAKE_DESKTOP);
  return fc.open();
};
const dirtyEdit = p => p.evaluate(() => { const S = window.__shotref; S.addObject('box'); S.changed(true); });

check('web: Open accepts .shotref and .json files', async ({ open }) => {
  const p = await open();
  const acc = await p.evaluate(() => document.querySelector('#fOpen').accept);
  ok(/\.shotref/.test(acc) && /\.json/.test(acc), 'accept is ' + acc);
  const before = await p.evaluate(() => window.__shotref.state.objects.length);
  const st = await stateOf(p);
  st.objects = st.objects.slice(0, 1);
  await openFile(p, 'one.shotref', JSON.stringify({ app: 'ShotRef', version: 2, state: st, assets: {} }));
  const n = await p.evaluate(() => window.__shotref.state.objects.length);
  ok(before > 1 && n === 1, 'a .shotref file should open: ' + before + ' -> ' + n);
});

check('web: Ctrl+Shift+S saves like Save', async ({ open, downloads }) => {
  const p = await open();
  await p.keyboard.press('Control+Shift+S');
  const f = await downloads(p).wait('.shotref');
  ok(/^shotref-\d{8}-\d{4}\.shotref$/.test(f.name), 'file is called ' + f.name);
  ok((await p.title()) === 'ShotRef', 'web title must stay ShotRef, got ' + (await p.title()));
});

check('desktop: Save reuses the file, Save as asks again, title shows name and unsaved dot', async ({ freshContext }) => {
  const p = await desktopPage(freshContext);
  ok((await p.title()) === 'ShotRef', 'start title ' + (await p.title()));
  await fileCmd(p, 'save');
  await p.waitForFunction(() => window.__dsk.calls.length === 1);
  let c = await p.evaluate(() => window.__dsk.calls.slice());
  ok(c[0].k === 'proj' && !c[0].o.saveAs && !c[0].o.path && /^shotref-\d{8}-\d{4}\.shotref$/.test(c[0].o.name), 'first save ' + JSON.stringify(c[0]));
  await p.waitForFunction(() => window.__dsk.titles.length > 0);
  const t = await p.evaluate(() => window.__dsk.titles.slice(-1)[0]);
  ok(t.includes('.shotref') && t.endsWith('ShotRef') && !t.includes('•'), 'saved title ' + t);
  await dirtyEdit(p);
  await p.waitForFunction(() => window.__dsk.titles.slice(-1)[0].includes('•'));
  await p.keyboard.press('Control+S');
  await p.waitForFunction(() => window.__dsk.calls.length === 2);
  c = await p.evaluate(() => window.__dsk.calls.slice());
  ok(c[1].o.path === 'C:/shots/' + c[0].o.name && !c[1].o.saveAs, 'second save should reuse the path ' + JSON.stringify(c[1]));
  await p.waitForFunction(() => !window.__dsk.titles.slice(-1)[0].includes('•'));
  await p.keyboard.press('Control+Shift+S');
  await p.waitForFunction(() => window.__dsk.calls.length === 3);
  c = await p.evaluate(() => window.__dsk.calls.slice());
  ok(c[2].o.saveAs === true, 'Ctrl+Shift+S should ask again ' + JSON.stringify(c[2]));
  noErrors(p, 'desktop page');
});

check('desktop: a failed save says so and keeps the unsaved dot', async ({ freshContext }) => {
  const p = await desktopPage(freshContext);
  await dirtyEdit(p);
  await p.evaluate(() => { window.__dsk.fail = true; });
  await fileCmd(p, 'save');
  await p.waitForFunction(() => window.__dsk.calls.length === 1);
  await p.waitForTimeout(300);
  const r = await p.evaluate(() => ({ toast: document.querySelector('#toast').textContent, t: window.__dsk.titles.slice(-1)[0] }));
  ok(/couldn't save/i.test(r.toast), 'toast: ' + r.toast);
  ok(r.t && r.t.includes('•'), 'still unsaved: ' + r.t);
});

check('desktop: Open uses the native dialog and later Save writes back to that file', async ({ freshContext }) => {
  const p = await desktopPage(freshContext);
  const st = await stateOf(p);
  st.objects = st.objects.slice(0, 1);
  const text = JSON.stringify({ app: 'ShotRef', version: 2, state: st, assets: {} });
  await p.evaluate(t => { window.__dsk.nextOpen = { text: t, name: 'scene.shotref', path: 'D:/work/scene.shotref' }; }, text);
  await p.keyboard.press('Control+O');
  await p.waitForSelector('#mConfirm:not(.hidden)');
  await p.click('#cfOk');
  await p.waitForFunction(() => window.__shotref.state.objects.length === 1);
  const t = await p.evaluate(() => window.__dsk.titles.slice(-1)[0]);
  ok(t.includes('scene.shotref') && !t.includes('•'), 'title ' + t);
  await dirtyEdit(p);
  await fileCmd(p, 'save');
  await p.waitForFunction(() => window.__dsk.calls.length === 1);
  const c = await p.evaluate(() => window.__dsk.calls[0]);
  ok(c.o.path === 'D:/work/scene.shotref', 'Save should write back to the opened file ' + JSON.stringify(c));
});

check('desktop: menu commands, opened-file events and exports go through the bridge', async ({ freshContext }) => {
  const p = await desktopPage(freshContext);
  const st = await stateOf(p);
  st.objects = st.objects.slice(0, 2);
  const text = JSON.stringify({ app: 'ShotRef', version: 2, state: st, assets: {} });
  await p.evaluate(t => window.__dsk.openCb({ text: t, name: 'dbl.shotref', path: 'E:/dbl.shotref' }), text);
  /* a file from the shell (launch, double-click, Recent) opens without a replace prompt when nothing is unsaved */
  await p.waitForFunction(() => window.__shotref.state.objects.length === 2);
  ok(!(await isOpen(p, 'mConfirm')), 'replace prompt shown for a shell-opened file');
  await p.evaluate(() => window.__dsk.menu('save-as'));
  await p.waitForFunction(() => window.__dsk.calls.length === 1);
  const c = await p.evaluate(() => window.__dsk.calls[0]);
  ok(c.o.saveAs === true, 'menu save-as ' + JSON.stringify(c));
  await p.evaluate(() => window.__dsk.menu('save'));
  await p.waitForFunction(() => window.__dsk.calls.length === 2);
  await exportDialog(p);
  await p.click('#exFrame');
  await p.waitForFunction(() => window.__dsk.calls.some(x => x.k === 'blob'), null, { timeout: 30000 });
  const b = await p.evaluate(() => window.__dsk.calls.find(x => x.k === 'blob'));
  ok(/\.png$/.test(b.n) && b.size > 1000 && JSON.stringify(b.f).includes('png'), 'png via bridge ' + JSON.stringify(b));
});

check('desktop: the frame pack goes through the Save dialog as a zip', async ({ freshContext }) => {
  const p = await desktopPage(freshContext);
  await p.evaluate(() => { window.__shotref.state.settings.size = 1280; window.__shotref.changed(true, true); });
  await p.click('#bExport'); await p.click('#xoPack');
  await p.waitForFunction(() => window.__dsk.calls.some(x => x.k === 'blob'), null, { timeout: 30000 });
  const b = await p.evaluate(() => window.__dsk.calls.find(x => x.k === 'blob'));
  ok(/-frames.zip$/.test(b.n) && b.size > 3000 && JSON.stringify(b.f).includes('zip'), 'zip via bridge ' + JSON.stringify(b));
});

check('desktop: closing asks about unsaved changes (Save / Dont save / Cancel)', async ({ freshContext }) => {
  const p = await desktopPage(freshContext);
  const closed = () => p.evaluate(() => window.__dsk.closed);
  await p.evaluate(() => window.__dsk.menu('close-request'));
  await p.waitForFunction(() => window.__dsk.closed === 1); /* nothing unsaved: closes straight away */
  await dirtyEdit(p);
  await p.evaluate(() => window.__dsk.menu('close-request'));
  await p.waitForSelector('#mConfirm:not(.hidden)');
  const lab = await p.evaluate(() => ({ t: document.querySelector('#cfTitle').textContent, b: [...document.querySelectorAll('#mConfirm .btns button')].filter(x => x.offsetParent).map(x => x.textContent) }));
  ok(/save changes/i.test(lab.t) && lab.b.join('|') === "Cancel|Don't save|Save", 'dialog ' + JSON.stringify(lab));
  await p.click('#mConfirm [data-close]');
  await p.waitForTimeout(200);
  ok((await closed()) === 1, 'Cancel must not close');
  await p.evaluate(() => window.__dsk.menu('close-request'));
  await p.waitForSelector('#mConfirm:not(.hidden)');
  await p.click('#cfAlt');
  await p.waitForFunction(() => window.__dsk.closed === 2);
  ok((await p.evaluate(() => window.__dsk.calls.length)) === 0, "Don't save must not write a file");
  await p.evaluate(() => window.__dsk.menu('close-request'));
  await p.waitForSelector('#mConfirm:not(.hidden)');
  await p.click('#cfOk');
  await p.waitForFunction(() => window.__dsk.closed === 3);
  ok((await p.evaluate(() => window.__dsk.calls.length)) === 1, 'Save must write once');
  /* a failed save keeps the window open */
  await dirtyEdit(p);
  await p.evaluate(() => { window.__dsk.fail = true; window.__dsk.menu('close-request'); });
  await p.waitForSelector('#mConfirm:not(.hidden)');
  await p.click('#cfOk');
  await p.waitForFunction(() => window.__dsk.calls.length === 2);
  await p.waitForTimeout(300);
  ok((await closed()) === 3, 'failed save must not close');
});

check('desktop: opening a file or starter over unsaved changes offers to save first', async ({ freshContext }) => {
  const p = await desktopPage(freshContext);
  const st = await stateOf(p);
  st.objects = st.objects.slice(0, 1);
  const text = JSON.stringify({ app: 'ShotRef', version: 2, state: st, assets: {} });
  const labels = () => p.evaluate(() => ({ t: document.querySelector('#cfTitle').textContent, b: [...document.querySelectorAll('#mConfirm .btns button')].filter(x => x.offsetParent).map(x => x.textContent) }));
  await dirtyEdit(p);
  const n0 = await p.evaluate(() => window.__shotref.state.objects.length);
  await p.evaluate(t => window.__dsk.openCb({ text: t, name: 'b.shotref', path: 'D:/b.shotref' }), text);
  await p.waitForSelector('#mConfirm:not(.hidden)');
  let l = await labels();
  ok(/save changes/i.test(l.t) && l.b.join('|') === "Cancel|Don't save|Save", 'open dialog ' + JSON.stringify(l));
  await p.click('#mConfirm [data-close]');
  ok((await p.evaluate(() => window.__shotref.state.objects.length)) === n0, 'Cancel must keep the scene');
  await p.evaluate(t => window.__dsk.openCb({ text: t, name: 'b.shotref', path: 'D:/b.shotref' }), text);
  await p.waitForSelector('#mConfirm:not(.hidden)');
  await p.click('#cfOk'); /* Save first, then open */
  await p.waitForFunction(() => window.__shotref.state.objects.length === 1);
  ok((await p.evaluate(() => window.__dsk.calls.filter(c => c.k === 'proj').length)) === 1, 'Save first must write once');
  await dirtyEdit(p);
  await p.evaluate(() => window.__dsk.menu('new'));
  await p.waitForSelector('#mStart:not(.hidden)');
  await p.click('#mStart .card');
  await p.waitForSelector('#mConfirm:not(.hidden)');
  l = await labels();
  ok(/save changes/i.test(l.t) && l.b.includes("Don't save"), 'starter dialog ' + JSON.stringify(l));
});

check('desktop: undo back past an Open does not let Save overwrite the opened file', async ({ freshContext }) => {
  const p = await desktopPage(freshContext);
  const st = await stateOf(p);
  st.objects = st.objects.slice(0, 1);
  const text = JSON.stringify({ app: 'ShotRef', version: 2, state: st, assets: {} });
  await p.evaluate(t => { window.__dsk.nextOpen = { text: t, name: 'b.shotref', path: 'D:/b.shotref' }; }, text);
  await p.keyboard.press('Control+O');
  await p.waitForSelector('#mConfirm:not(.hidden)');
  await p.click('#cfOk');
  await p.waitForFunction(() => window.__shotref.state.objects.length === 1);
  await p.keyboard.press('Control+Z');
  await p.waitForFunction(() => window.__shotref.state.objects.length === 3);
  await fileCmd(p, 'save');
  await p.waitForFunction(() => window.__dsk.calls.length === 1);
  let c = await p.evaluate(() => window.__dsk.calls[0]);
  ok(!c.o.path, 'Save after undoing the Open must ask for a file, got path ' + c.o.path);
  await p.keyboard.press('Control+Y'); /* redo: B again, and Save writes to B */
  await p.waitForFunction(() => window.__shotref.state.objects.length === 1);
  await fileCmd(p, 'save');
  await p.waitForFunction(() => window.__dsk.calls.length === 2);
  c = await p.evaluate(() => window.__dsk.calls[1]);
  ok(c.o.path === 'D:/b.shotref', 'redo should bring B back with its path, got ' + c.o.path);
});

check('desktop: after Save as, undoing an edit still saves to that file', async ({ freshContext }) => {
  const p = await desktopPage(freshContext);
  await dirtyEdit(p);
  await p.keyboard.press('Control+Shift+S');
  await p.waitForFunction(() => window.__dsk.calls.length === 1);
  const path = await p.evaluate(() => 'C:/shots/' + window.__dsk.calls[0].o.name);
  await p.waitForTimeout(100);
  await p.keyboard.press('Control+Z');
  await p.waitForFunction(() => window.__shotref.state.objects.length === 3);
  await fileCmd(p, 'save');
  await p.waitForFunction(() => window.__dsk.calls.length === 2);
  const c = await p.evaluate(() => window.__dsk.calls[1]);
  ok(c.o.path === path && !c.o.saveAs, 'Save after undo should write to ' + path + ', got ' + JSON.stringify(c.o));
});

/* =================== batch A: format fields, prefs, menus, lens focus =================== */
check('artifact-format fields survive opening; dangling references are dropped', async ({ open }) => {
  const cam = { base: JSON.parse(CAM_BASE), keys: [] };
  const O = (id, type, extra) => ({ id, type, name: id, base: { p: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }, keys: [], opts: {}, ...extra });
  const file = { app: 'ShotRef', version: 1, state: {
    v: 1, meta: { id: 'm1', name: 'Desert overlook' },
    settings: { shadows: 'yes', shadowSoft: 5, tod: 3, interp: 'natural' },
    camera: { ...cam, mount: 'ghost', dof: { on: true, fstop: 2.8, auto: false, strength: -2 } },
    groups: { g1: { name: 'Pair' } },
    shots: [{ id: 's1', name: 'Wide', camera: { ...cam, lookAtId: 'ghost' }, duration: 4 }],
    shotId: 'nope',
    takes: [{ id: 't1', name: 'Take 1', snap: null }, { id: 't2', name: 'Take 2', snap: 'not json' }],
    takeId: 'gone',
    objects: [
      O('c1', 'car', { grp: 'g1', locked: true }),
      O('p1', 'person', { parent: 'c1', grp: 'gone', opts: { body: 'woman', seated: 'c1', lookAt: 'camera', free: true }, acts: [{ t: 2, pose: 'walk' }, { t: 1, pose: 'sit', at: { p: [0, 0, 0], yaw: 90 } }, { t: 'x', pose: 'run' }] }),
      O('b1', 'box', { parent: 'zzz', opts: { body: 'robot', seated: 'zzz', lookAt: 'zzz', convertible: 'yes' }, acts: [] }),
      O('x1', 'box', { parent: 'x2' }), O('x2', 'box', { parent: 'x1' }),
    ] }, assets: {} };
  const p = await open();
  await openFile(p, 'artifact.shotref.json', JSON.stringify(file));
  await p.waitForFunction(() => window.__shotref.state.objects.length === 5);
  const s = await stateOf(p), by = id => s.objects.find(o => o.id === id);
  ok(s.meta.name === 'Desert overlook', 'project name lost');
  ok(s.groups.g1.name === 'Pair' && by('c1').grp === 'g1' && by('c1').locked === true, 'group or lock lost');
  ok(by('p1').grp === null, 'dangling group should be null, got ' + by('p1').grp);
  ok(by('p1').parent === 'c1' && by('p1').opts.seated === 'c1' && by('p1').opts.lookAt === 'camera' && by('p1').opts.body === 'woman' && by('p1').opts.free === true, 'valid person fields lost');
  ok(by('p1').acts.length === 2 && by('p1').acts[0].t === 1 && by('p1').acts[0].at.yaw === 90, 'acts not sorted/cleaned: ' + JSON.stringify(by('p1').acts));
  ok(by('b1').parent === null && by('b1').opts.seated === null && !('lookAt' in by('b1').opts) && !('body' in by('b1').opts) && !('convertible' in by('b1').opts) && !('acts' in by('b1')), 'dangling/bad box fields kept: ' + JSON.stringify(by('b1')));
  ok(!(by('x1').parent && by('x2').parent), 'a parent loop was kept');
  ok(s.camera.mount === null && s.camera.dof.strength === 1, 'camera mount/blur strength (junk strength in a file with depth of field reads as 1, the old look): ' + JSON.stringify([s.camera.mount, s.camera.dof]));
  ok(s.shots.length === 1 && s.shots[0].camera.lookAtId === null && s.shotId === 's1', 'shots not repaired');
  /* batch H fix 1: a take that is not on screen keeps its copy exactly as it was, even when it can't be read (it shows as can't be opened) */
  ok(s.takes.length === 2 && s.takes[1].snap === 'not json' && s.takeId === 't1', 'takes not repaired: ' + JSON.stringify(s.takes));
  ok(!('shadows' in s.settings) && s.settings.shadowSoft === 1 && s.settings.tod === 5 && s.settings.interp === 'natural', 'sun settings: ' + JSON.stringify(s.settings));
  noErrors(p);
});

check('prefs store survives broken storage and remembers values', async ({ open }) => {
  const p = await open();
  await p.evaluate(() => localStorage.setItem('shotref.prefs', '{broken'));
  await p.reload(); await p.waitForFunction(() => window.__shotref && window.__shotref.state);
  await p.evaluate(() => window.__shotref.setPref('leftTab', 'scene'));
  ok(await p.evaluate(() => JSON.parse(localStorage.getItem('shotref.prefs')).leftTab) === 'scene', 'pref not written');
  await p.reload(); await p.waitForFunction(() => window.__shotref && window.__shotref.state);
  ok(await p.evaluate(() => window.__shotref.getPref('leftTab')) === 'scene', 'pref not read back');
  await p.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('full'); }; });
  await p.evaluate(() => window.__shotref.setPref('x', 1)); /* must not throw */
  ok(await p.evaluate(() => window.__shotref.getPref('x')) === 1, 'pref kept in memory when storage throws');
  noPageErrors(p);
});

check('undo and redo buttons name the step', async ({ open }) => {
  const p = await open();
  await p.waitForTimeout(400);
  ok(/nothing to undo/i.test(await p.getAttribute('#bUndo', 'title')), 'idle undo title: ' + await p.getAttribute('#bUndo', 'title'));
  await p.evaluate(() => { window.__shotref.addObject('box'); });
  await p.waitForFunction(() => /Undo: add Box/i.test(document.querySelector('#bUndo').title));
  await p.keyboard.press('Control+Z');
  await p.waitForFunction(() => /Redo: add Box/i.test(document.querySelector('#bRedo').title));
});

/* right-click on the 3D view */
const rightClick = (p, x, y, opts = {}) => p.mouse.click(x, y, { button: 'right', ...opts });
const menuLabels = p => p.evaluate(() => { const m = document.querySelector('#ctxMenu'); return m.style.display === 'block' ? [...m.querySelectorAll('button')].map(b => b.firstElementChild.textContent.replace(/^✓/, '')) : null; });
const menuHead = p => p.evaluate(() => { const h = document.querySelector('#ctxMenu .head'); return h ? h.textContent : null; });
const clickItem = (p, label) => p.evaluate(l => { const b = [...document.querySelectorAll('#ctxMenu button')].find(x => x.firstElementChild.textContent.replace(/^✓/, '').startsWith(l)); if (!b) throw new Error('no menu item ' + l); b.click(); }, label);
async function personXY(p) {
  const o = await p.evaluate(() => { const S = window.__shotref, o = S.state.objects.find(x => x.type === 'person'); return { id: o.id, p: o.base.p.slice() }; });
  o.xy = await p.evaluate(q => window.__shotref.project(q[0], 0.9, q[2]), o.p);
  return o;
}

check('right-click on a person opens the page menu; Duplicate works; Esc closes', async ({ open }) => {
  const p = await open();
  await p.waitForTimeout(500);
  const o = await personXY(p);
  await p.evaluate(() => { window.__prevented = null; document.querySelector('#c').addEventListener('contextmenu', e => setTimeout(() => { window.__prevented = e.defaultPrevented; }, 0)); });
  await rightClick(p, o.xy[0], o.xy[1]);
  await p.waitForTimeout(200);
  ok(await p.evaluate(() => window.__prevented) === true, 'the page must preventDefault the contextmenu event (so Electron shows no native menu)');
  const labels = await menuLabels(p);
  ok(labels, 'no menu opened');
  for (const l of ['Draw walk path', 'Frame: Medium shot', 'Frame: Close-up', 'Face the camera', 'Keep camera on this', 'Focus the lens here', 'Duplicate', 'Hide', 'Delete'])
    ok(labels.some(x => x.startsWith(l)), 'missing "' + l + '" in ' + JSON.stringify(labels));
  ok(await p.evaluate(() => window.__shotref.selected) === o.id, 'right-click should select the item');
  await p.keyboard.press('Escape');
  ok(!(await menuLabels(p)), 'Esc should close the menu');
  await rightClick(p, o.xy[0], o.xy[1]); await p.waitForTimeout(150);
  await clickItem(p, 'Duplicate');
  await p.waitForTimeout(200);
  ok(await p.evaluate(() => window.__shotref.state.objects.length) === 4, 'Duplicate did not add an object');
  ok(!(await menuLabels(p)), 'menu should close after choosing');
  /* clicking outside closes it */
  await rightClick(p, o.xy[0], o.xy[1]); await p.waitForTimeout(150);
  await p.mouse.click(5, 450);
  ok(!(await menuLabels(p)), 'click outside should close the menu');
  noErrors(p);
});

check('right-click on the floor offers add / aim / move here; right-drag opens no menu', async ({ open }) => {
  const p = await open();
  await p.waitForTimeout(500);
  const pt = [-6, 0, -2];
  const xy = await p.evaluate(q => window.__shotref.project(q[0], q[1], q[2]), pt);
  await p.mouse.move(xy[0], xy[1]); await p.mouse.down({ button: 'right' });
  for (let i = 1; i <= 8; i++) { await p.mouse.move(xy[0] + i * 6, xy[1] + i * 3); await p.waitForTimeout(15); }
  await p.mouse.up({ button: 'right' }); await p.waitForTimeout(200);
  ok(!(await menuLabels(p)), 'a right-drag (pan) must not open the menu');
  const xy2 = await p.evaluate(q => window.__shotref.project(q[0], q[1], q[2]), pt);
  await rightClick(p, xy2[0], xy2[1]); await p.waitForTimeout(200);
  const labels = await menuLabels(p);
  ok(labels && (await menuHead(p)) === 'On the floor here', 'floor menu head: ' + (await menuHead(p)));
  for (const l of ['Add a man here', 'Add a woman here', 'Add a child here', 'Add floor mark here', 'Aim the camera here']) ok(labels.some(x => x.startsWith(l)), 'missing "' + l + '"');
  ok(!labels.some(x => x.startsWith('Move the camera here')), '"Move the camera here" belongs to Top view only');
  const n0 = await p.evaluate(() => window.__shotref.state.objects.length);
  await clickItem(p, 'Add a woman here'); await p.waitForTimeout(200);
  const s = await stateOf(p), np = s.objects[s.objects.length - 1];
  ok(s.objects.length === n0 + 1 && np.type === 'person' && np.opts.body === 'woman' && Math.abs(np.base.p[0] - pt[0]) < 0.6 && Math.abs(np.base.p[2] - pt[2]) < 0.6, 'person not added at the clicked spot: ' + JSON.stringify(np.base.p));
  await rightClick(p, xy2[0], xy2[1]); await p.waitForTimeout(150);
  /* the new person stands there, so the menu is now theirs; click the floor a bit further for the floor menu */
  await p.keyboard.press('Escape');
  const xy3 = await p.evaluate(q => window.__shotref.project(q[0], q[1], q[2]), [-6, 0, 1]);
  await rightClick(p, xy3[0], xy3[1]); await p.waitForTimeout(150);
  const lb = await menuLabels(p);
  ok(lb && lb.some(x => /^Move .* here/.test(x)) && lb.some(x => /^Walk .* here/.test(x)), 'selected person: move/walk here missing in ' + JSON.stringify(lb));
  await clickItem(p, 'Aim the camera here'); await p.waitForTimeout(200);
  const tg = await p.evaluate(() => window.__shotref.state.camera.base.tg);
  ok(Math.abs(tg[0] + 6) < 0.6 && Math.abs(tg[2] - 1) < 0.6, 'camera not aimed at the spot: ' + JSON.stringify(tg));
  await p.evaluate(() => window.__shotref.setView('top')); await p.waitForTimeout(300);
  const t2 = await p.evaluate(q => window.__shotref.project(q[0], q[1], q[2]), [-3, 0, 2]);
  await rightClick(p, t2[0], t2[1]); await p.waitForTimeout(150);
  ok((await menuLabels(p) || []).some(x => x.startsWith('Move the camera here')), 'Top view should offer "Move the camera here"');
  noErrors(p);
});

check('right-click on a mark and on a diamond', async ({ open }) => {
  const p = await open();
  await p.waitForTimeout(400);
  await p.evaluate(() => { const S = window.__shotref; const o = S.addObject('mark'); o.base.p = [-3, 0, 3]; S.changed(true); S.select(null); });
  await p.waitForTimeout(300);
  const xy = await p.evaluate(() => window.__shotref.project(-3, 0.02, 3));
  await rightClick(p, xy[0], xy[1]); await p.waitForTimeout(200);
  ok((await menuLabels(p) || []).some(x => /^Walk .* here \(arrive/.test(x)), 'mark menu lacks Walk here: ' + JSON.stringify(await menuLabels(p)));
  await p.keyboard.press('Escape');
  /* keyframe diamond: right-click still deletes it, and no menu opens */
  const pid = await p.evaluate(() => { const S = window.__shotref, o = S.state.objects.find(x => x.type === 'person'); S.select(o.id); S.setKey(o.keys, 0, { p: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }); S.setKey(o.keys, 2, { p: [1, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }); S.changed(true, true); return o.id; });
  await p.waitForSelector('.dia');
  await p.locator('.dia').first().click({ button: 'right' }); await p.waitForTimeout(250);
  ok(await p.evaluate(id => window.__shotref.state.objects.find(o => o.id === id).keys.length, pid) === 1, 'right-click on a diamond should delete the key');
  ok(!(await menuLabels(p)), 'no page menu on a diamond');
});

check('camera menu: look through, set start, make static', async ({ open }) => {
  const p = await open();
  await p.waitForTimeout(500);
  const cp = await p.evaluate(() => window.__shotref.state.camera.base.p);
  const xy = await p.evaluate(q => window.__shotref.project(q[0], q[1], q[2]), cp);
  await rightClick(p, xy[0], xy[1]); await p.waitForTimeout(200);
  const labels = await menuLabels(p);
  ok(labels && labels.some(x => x.startsWith('Look through camera')) && labels.some(x => x.startsWith('Set start frame')) && labels.some(x => x.startsWith('Set end frame')), 'camera menu: ' + JSON.stringify(labels));
  await clickItem(p, 'Set start frame'); await p.waitForTimeout(400);
  ok(await p.evaluate(() => window.__shotref.state.camera.keys.length) === 1, 'Set start frame should key the camera');
  /* the tracks opened, so the view is shorter: find the camera again */
  const xy2 = await p.evaluate(q => window.__shotref.project(q[0], q[1], q[2]), cp);
  await rightClick(p, xy2[0], xy2[1]); await p.waitForTimeout(150);
  await clickItem(p, 'Make static'); await p.waitForTimeout(400);
  ok(await p.evaluate(() => window.__shotref.state.camera.keys.length) === 0, 'Make static should clear the keys');
  const xy3 = await p.evaluate(q => window.__shotref.project(q[0], q[1], q[2]), cp);
  await rightClick(p, xy3[0], xy3[1]); await p.waitForTimeout(150);
  await clickItem(p, 'Look through camera'); await p.waitForTimeout(200);
  ok(await p.evaluate(() => window.__shotref.view) === 'camera', 'should be in camera view');
});

check('double-click focuses the lens on what you clicked (DOF on)', async ({ open }) => {
  const p = await open();
  await p.waitForTimeout(500);
  await p.evaluate(() => window.__shotref.setView('camera')); await p.waitForTimeout(300);
  const o = await personXY(p);
  ok(!(await p.evaluate(() => window.__shotref.state.camera.dof && window.__shotref.state.camera.dof.on)), 'setup: DOF should start off');
  const fd0 = await p.evaluate(() => window.__shotref.state.camera.base.fd);
  await p.mouse.dblclick(o.xy[0], o.xy[1]); await p.waitForTimeout(300);
  const c = await p.evaluate(() => window.__shotref.state.camera);
  ok(c.dof.on === true && c.dof.auto === false && c.base.fd !== fd0 && c.base.fd > 0.3, 'dof/fd after double-click: ' + JSON.stringify([c.dof, c.base.fd, fd0]));
  ok(/Focus on/i.test(await p.textContent('#toast')), 'toast: ' + await p.textContent('#toast'));
  /* keyed camera: double-click keys the focus at the playhead */
  await p.evaluate(() => { window.__shotref.applyMove('dollyIn'); });
  await p.waitForTimeout(300);
  const o2 = await personXY(p);
  await p.mouse.dblclick(o2.xy[0], o2.xy[1]); await p.waitForTimeout(300);
  ok(await p.evaluate(() => window.__shotref.state.camera.keys.length > 0 && window.__shotref.state.camera.keys.every(k => typeof k.fd === 'number')), 'keyed camera: fd should be keyed');
});

check('quick start and hint talk about right-click and double-click lens focus', async ({ open }) => {
  const p = await open();
  await p.waitForTimeout(600);
  const t = await p.evaluate(() => document.querySelector('#mHelp').textContent);
  ok(/right-click/i.test(t) && /double-click/i.test(t) && /focus the lens/i.test(t), 'help text lacks right-click / double-click focus');
  ok(/right-click/i.test(await p.evaluate(() => document.querySelector('#hint').textContent)), 'hint should mention right-click');
});

check('dropdown menu component: button opens it, items run, click again closes, arrows move', async ({ open }) => {
  const p = await open();
  await p.evaluate(() => { const b = document.createElement('button'); b.id = 'tmpMenuBtn'; b.textContent = 'File'; b.style.cssText = 'position:fixed;left:300px;top:60px;z-index:80'; document.body.append(b); window.__hit = 0; window.__shotref.menuButton(b, () => [{ head: 'Test' }, { label: 'One', fn: () => { window.__hit++; }, key: 'Ctrl 1' }, '-', { label: 'Two', check: true, fn: () => { } }]); });
  await p.click('#tmpMenuBtn');
  ok((await menuLabels(p) || []).join() === 'One,Two', 'menu items: ' + JSON.stringify(await menuLabels(p)));
  await p.keyboard.press('ArrowDown'); ok(await p.evaluate(() => document.activeElement.textContent.startsWith('One')), 'ArrowDown should focus the first item');
  await p.click('#tmpMenuBtn'); ok(!(await menuLabels(p)), 'a second click on the button should close the menu');
  await p.click('#tmpMenuBtn'); await clickItem(p, 'One');
  ok(await p.evaluate(() => window.__hit) === 1 && !(await menuLabels(p)), 'item should run once and close the menu');
});

/* ---- fix round 1 ---- */
check('floor menu "Walk X here" makes the walk at once: keys, no path mode, no view switch', async ({ open }) => {
  const p = await open();
  await p.waitForTimeout(500);
  const o = await personXY(p);
  await p.evaluate(id => window.__shotref.select(id), o.id);
  const xy = await p.evaluate(q => window.__shotref.project(q[0], q[1], q[2]), [-6, 0, -2]);
  await rightClick(p, xy[0], xy[1]); await p.waitForTimeout(200);
  await clickItem(p, 'Walk '); await p.waitForTimeout(300);
  const r = await p.evaluate(id => { const S = window.__shotref, a = S.state.objects.find(x => x.id === id); return { keys: a.keys.map(k => k.p.slice()), view: S.view, bar: getComputedStyle(document.querySelector('#modeBar')).display }; }, o.id);
  ok(r.keys.length === 2 && Math.abs(r.keys[1][0] + 6) < 0.6 && Math.abs(r.keys[1][2] + 2) < 0.6, 'walk keys: ' + JSON.stringify(r.keys));
  ok(r.view === 'editor' && r.bar === 'none', 'should stay in the editor with no path bar: ' + JSON.stringify([r.view, r.bar]));
  noErrors(p);
});

check('menu "Focus the lens here" aims at the body like double-click does', async ({ open }) => {
  const p = await open();
  await p.waitForTimeout(500);
  await p.evaluate(() => window.__shotref.setView('camera')); await p.waitForTimeout(300);
  const o = await personXY(p);
  await rightClick(p, o.xy[0], o.xy[1]); await p.waitForTimeout(150);
  await clickItem(p, 'Focus the lens here'); await p.waitForTimeout(250);
  const fdMenu = await p.evaluate(() => window.__shotref.state.camera.base.fd);
  const body = await p.evaluate(id => { const S = window.__shotref, a = S.state.objects.find(x => x.id === id), c = S.state.camera.base.p; return Math.hypot(a.base.p[0] - c[0], a.base.p[1] + 1 - c[1], a.base.p[2] - c[2]); }, o.id);
  const feet = await p.evaluate(id => { const S = window.__shotref, a = S.state.objects.find(x => x.id === id), c = S.state.camera.base.p; return Math.hypot(a.base.p[0] - c[0], a.base.p[1] - c[1], a.base.p[2] - c[2]); }, o.id);
  ok(Math.abs(fdMenu - body) < Math.abs(fdMenu - feet) || Math.abs(feet - body) < 0.05, 'menu focus ' + fdMenu + ' is nearer the feet (' + feet + ') than the body (' + body + ')');
});

check('right-click that cancels placing opens no menu; a menu owns the keyboard', async ({ open }) => {
  const p = await open();
  await p.waitForTimeout(500);
  await p.evaluate(() => { window.__shotref.addObject('box', null, true); });
  await p.waitForTimeout(200);
  await rightClick(p, 700, 500); await p.waitForTimeout(250);
  ok(!(await menuLabels(p)), 'cancelling placing with a right-click must not open a menu');
  const o = await personXY(p);
  await rightClick(p, o.xy[0], o.xy[1]); await p.waitForTimeout(150);
  const n = await p.evaluate(() => window.__shotref.state.objects.length);
  await p.keyboard.press('Delete'); await p.waitForTimeout(150);
  ok(await p.evaluate(() => window.__shotref.state.objects.length) === n, 'Delete must not run while the menu is open');
  ok(!!(await menuLabels(p)), 'the menu should stay open on other keys');
  await p.keyboard.press('Escape');
  ok(await p.evaluate(() => document.activeElement.id) === 'c', 'focus should return to the 3D view after Esc');
});

check('numeric ids and parent loops are repaired without dropping valid links', async ({ open }) => {
  const O = (id, extra) => ({ id, type: 'box', name: 'b' + id, base: { p: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }, keys: [], opts: {}, ...extra });
  const file = { app: 'ShotRef', version: 1, state: { camera: { base: JSON.parse(CAM_BASE), keys: [], mount: 5 }, objects: [O(5), O(6, { parent: 5 }), O('a', { parent: 'b' }), O('b', { parent: 'c' }), O('c', { parent: 'b' })] }, assets: {} };
  const p = await open();
  await openFile(p, 'n.shotref.json', JSON.stringify(file));
  await p.waitForFunction(() => window.__shotref.state.objects.length === 5);
  const s = await stateOf(p), by = id => s.objects.find(o => o.id === id);
  ok(by('6').parent === '5' && s.camera.mount === '5', 'numeric references were dropped');
  ok(by('a').parent === 'b', 'a valid link into a loop was cut');
  ok(!(by('b').parent && by('c').parent), 'the loop b/c was kept');
});

check('artifact-format file survives save then reopen', async ({ open, freshContext, downloads }) => {
  const cam = { base: JSON.parse(CAM_BASE), keys: [] };
  const O = (id, type, extra) => ({ id, type, name: id, base: { p: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }, keys: [], opts: {}, ...extra });
  const file = { app: 'ShotRef', version: 1, state: { v: 1, meta: { id: 'm1', name: 'Desert' }, settings: { shadows: true, shadowSoft: 0.5, tod: 9 }, camera: { ...cam, mount: 'c1', dof: { on: true, fstop: 2, auto: false, strength: 4 } }, groups: { g1: { name: 'Pair' } },
    shots: [{ id: 's1', name: 'Wide', camera: { ...cam }, duration: 4 }], shotId: 's1', takes: [{ id: 't1', name: 'Take 1', snap: null }], takeId: 't1',
    objects: [O('c1', 'car', { grp: 'g1', locked: true, opts: { convertible: true } }), O('p1', 'person', { parent: 'c1', opts: { body: 'child', seated: 'c1', lookAt: 'camera', free: true }, acts: [{ t: 1, pose: 'sit', at: { p: [0, 0, 0], yaw: 90 } }] })] }, assets: {} };
  const a = await open();
  await openFile(a, 'art.shotref.json', JSON.stringify(file));
  await a.waitForFunction(() => window.__shotref.state.objects.length === 2);
  const before = await stateOf(a);
  /* batch 9: saving brings the active shot's own copy in line with the live camera and length (this file's copy was a plain camera) */
  before.shots[0].camera = before.camera; before.shots[0].duration = before.settings.duration;
  await fileCmd(a, 'save');
  const f = await downloads(a).wait('.shotref');
  const fc = await freshContext(); const b = await fc.open();
  await openFile(b, f.name, f.text());
  await b.waitForFunction(() => window.__shotref.state.objects.length === 2);
  ok(canon(await stateOf(b)) === canon(before), 'state differs after save and reopen');
  const st = await stateOf(b);
  ok(st.meta.name === 'Desert' && st.shots.length === 1 && st.takes.length === 1 && st.objects[1].acts.length === 1 && st.camera.dof.strength === 4 && st.settings.tod === 9, 'new fields lost');
});

/* ---------------- Batch B: shell (top bar, step bar, left tabs, viewport icons, timeline) ---------------- */
check('top bar: project name lives in the project, is undoable and names the file', async ({ open, downloads }) => {
  const p = await open();
  ok(await p.evaluate(() => document.title) === 'ShotRef', 'setup: page title');
  await p.fill('#projName', 'Desert chase');
  await p.press('#projName', 'Enter');
  ok(await p.evaluate(() => window.__shotref.state.meta && window.__shotref.state.meta.name) === 'Desert chase', 'state.meta.name was not set');
  ok(await p.evaluate(() => document.title) === 'ShotRef', 'the page title changed with the project name');
  await fileCmd(p, 'save');
  const f = await downloads(p).wait('.shotref');
  ok(/^desert-chase-\d{8}-\d{4}\.shotref$/.test(f.name), 'file is called ' + f.name);
  ok(JSON.parse(f.text()).state.meta.name === 'Desert chase', 'the saved file has no project name');
  await p.click('#bUndo');
  ok(await p.evaluate(() => document.querySelector('#projName').value) === '', 'undo did not clear the name field');
  await p.click('#bRedo');
  ok(await p.evaluate(() => document.querySelector('#projName').value) === 'Desert chase', 'redo did not bring the name back');
  noPageErrors(p);
});

check('top bar: brand mark and wordmark stay, the artifact dot does not come back', async ({ freshContext }) => {
  const fc = await freshContext({ viewport: { width: 1280, height: 800 } });
  const p = await fc.open();
  const r = await p.evaluate(() => { const b = document.querySelector('#top .brand'); const m = b.querySelector('.mark'); return { dot: !!b.querySelector('.dot'), mark: m && m.getBoundingClientRect().width, text: b.textContent.replace(/\s+/g, ' ').trim() }; });
  ok(!r.dot && r.mark > 10, 'brand mark missing or a dot is back: ' + JSON.stringify(r));
  ok(/ShotRef/.test(r.text), 'no wordmark: ' + r.text);
});

check('File menu has New, Open, Save, Save as and Export, and the old top bar buttons are gone', async ({ open }) => {
  const p = await open();
  for (const id of ['bNew', 'bOpen', 'bSave', 'bHelp', 'bCopy', 'bSnap', 'modeSeg', 'vpTools']) ok(await p.$('#' + id) === null, '#' + id + ' is still in the page');
  await p.click('#bFile');
  const items = await p.evaluate(() => [...document.querySelectorAll('#ctxMenu button')].map(b => b.dataset.cmd + '=' + b.firstElementChild.textContent));
  for (const w of ['new=New', 'open=Open', 'save=Save', 'saveas=Save as', 'export=Export']) ok(items.some(i => i.startsWith(w)), 'File menu lacks ' + w + ' (has ' + items.join(', ') + ')');
  await p.keyboard.press('Escape');
  await fileCmd(p, 'export');
  ok(await p.evaluate(() => window.__shotref.selected) === 'export' && await p.evaluate(() => document.querySelector('#mExport').classList.contains('hidden')), 'File > Export did not open the Export panel');
  await p.keyboard.press('Escape');
  await fileCmd(p, 'new');
  ok(await p.evaluate(() => !document.querySelector('#mStart').classList.contains('hidden')), 'File > New did not open the starter sets');
});

check('gear menu: Advanced toggle, Settings, Quick start and About', async ({ open }) => {
  const p = await open();
  await p.click('#bMenu');
  ok(await p.getAttribute('#ctxMenu [data-cmd="advanced"]', 'aria-checked') === 'false', 'Advanced should start off');
  await p.click('#ctxMenu [data-cmd="advanced"]');
  ok(await p.evaluate(() => !document.body.classList.contains('simple')), 'Advanced did not switch Simple mode off');
  await p.click('#bMenu');
  ok(await p.getAttribute('#ctxMenu [data-cmd="advanced"]', 'aria-checked') === 'true', 'Advanced should now be checked');
  await p.keyboard.press('Escape');
  await gearCmd(p, 'settings');
  ok(await p.evaluate(() => !document.querySelector('#mSettings').classList.contains('hidden')), 'Settings did not open');
  await p.keyboard.press('Escape');
  await gearCmd(p, 'help');
  ok(await p.evaluate(() => !document.querySelector('#mHelp').classList.contains('hidden')), 'Quick start did not open');
  await p.keyboard.press('Escape');
  await gearCmd(p, 'about');
  const t = await p.evaluate(() => { const m = document.querySelector('#mAbout'); return m.classList.contains('hidden') ? null : m.textContent; });
  ok(t && /ShotRef/.test(t) && /\d+\.\d+\.\d+/.test(t), 'About box missing or has no version: ' + t);
  await p.keyboard.press('Escape');
  await p.click('#bMenu');
  await p.keyboard.press('Escape');
  ok(await p.evaluate(() => document.activeElement.id) === 'bMenu', 'focus did not return to the gear button');
});

check('step bar: 1 Build, 2 Frame, 3 Export, with keys 1 2 3', async ({ open }) => {
  const p = await open();
  const on = () => p.evaluate(() => [...document.querySelectorAll('#stepSeg button.on')].map(b => b.dataset.step).join());
  const labels = await p.evaluate(() => [...document.querySelectorAll('#stepSeg button')].map(b => b.textContent.trim()).join('|'));
  ok(labels === '1Build|2Frame|3Export', 'step labels: ' + labels);
  ok(await on() === 'build', 'Build should start active, got ' + await on());
  await p.focus('#c');
  await p.keyboard.press('2');
  await p.waitForTimeout(150);
  ok(await p.evaluate(() => window.__shotref.view) === 'camera' && await p.evaluate(() => window.__shotref.selected) === 'camera', 'key 2 did not go to Frame');
  ok(await on() === 'frame', 'Frame should be active, got ' + await on());
  await p.keyboard.press('1');
  await p.waitForTimeout(150);
  ok(await p.evaluate(() => window.__shotref.view) === 'editor', 'key 1 did not go back to the editor');
  ok(await on() === 'build', 'Build should be active again, got ' + await on());
  await p.keyboard.press('3');
  await p.waitForTimeout(150);
  ok(await p.evaluate(() => window.__shotref.selected) === 'export', 'key 3 did not open the Export panel');
  ok(await on() === 'export', 'Export should be active, got ' + await on());
  await p.keyboard.press('Escape');
  await p.waitForTimeout(150);
  ok(await on() === 'frame', 'leaving Export (Esc) should land on Frame (the camera view stays), got ' + await on());
  await p.click('#stepSeg [data-step=frame]');
  ok(await p.evaluate(() => window.__shotref.view) === 'camera', 'the Frame pill did not open the camera view');
  await p.click('#stepSeg [data-step=build]');
  ok(await p.evaluate(() => window.__shotref.view) === 'editor', 'the Build pill did not leave the camera view');
  const v = await p.evaluate(() => window.__shotref.view);
  await p.click('#projName'); await p.keyboard.type('123'); await p.keyboard.press('Enter');
  ok(await p.evaluate(() => window.__shotref.view) === v, 'typing 1 2 3 in the name field changed the step');
});

check('left panel: Add and Scene tabs with a count, remembered; Props before Shapes; fewer shapes in Simple', async ({ open }) => {
  const p = await open();
  const vis = sel => p.evaluate(s => { const e = document.querySelector(s); return !!e && e.getClientRects().length > 0; }, sel);
  ok(await vis('#addArea') && !(await vis('#outliner')), 'Add tab should show first');
  ok(await p.evaluate(() => document.querySelector('#sceneCnt').textContent) === '3', 'scene count is ' + await p.evaluate(() => document.querySelector('#sceneCnt').textContent));
  const cats = await p.evaluate(() => [...document.querySelectorAll('#addArea .addcat')].map(e => e.textContent));
  ok(cats.indexOf('Props') >= 0 && cats.indexOf('Props') < cats.indexOf('Shapes'), 'Props should come before Shapes: ' + cats.join());
  const shapes = () => p.evaluate(() => { const c = [...document.querySelectorAll('#addArea .addcat')].find(e => e.textContent === 'Shapes'); return [...c.nextElementSibling.querySelectorAll('button')].map(b => b.textContent.trim()); });
  const s1 = await shapes();
  ok(s1.length === 6 && s1.includes('More shapes') && !s1.includes('Sphere'), 'Simple shapes: ' + s1.join());
  await p.click('#addArea .tile.more');
  const s2 = await shapes();
  ok(s2.includes('Sphere') && s2.includes('Fewer'), 'More shapes did not show every shape: ' + s2.join());
  await p.click('#leftTabs [data-lt=scene]');
  ok(await vis('#outliner') && !(await vis('#addArea')), 'Scene tab did not show the list');
  await p.reload();
  await p.waitForFunction(() => window.__shotref && window.__shotref.state);
  ok(await vis('#outliner'), 'the Scene tab was not remembered');
  await p.click('#leftTabs [data-lt=add]');
  await goAdvanced(p);
  const s3 = await shapes();
  ok(s3.includes('Sphere') && !s3.includes('More shapes'), 'Advanced should list every shape: ' + s3.join());
});

check('viewport has one icon toolbar with tooltips; Simple hides the arrows', async ({ open }) => {
  const p = await open();
  ok(await p.$('#vpTools') === null, 'the old tool group is still there');
  const info = await p.evaluate(() => [...document.querySelectorAll('#vpRight .ib')].map(b => ({ id: b.id || b.dataset.g, tip: b.dataset.tip, shown: b.getClientRects().length > 0 })));
  ok(info.length === 8 && info.every(i => i.tip), 'expected 8 icon buttons with tooltips: ' + JSON.stringify(info));
  ok(info.filter(i => i.shown).map(i => i.id).join() === 'bSnapGrid,bFocus,bGrid,bPip,bCamHere', 'Simple should show Snap, Zoom to, Grid, Preview, Camera here: ' + info.filter(i => i.shown).map(i => i.id));
  await p.hover('#bFocus');
  const tip = await p.evaluate(() => getComputedStyle(document.querySelector('#bFocus'), '::after').content);
  ok(/Zoom to the selection/.test(tip), 'no tooltip on hover: ' + tip);
  await goAdvanced(p);
  ok(await p.evaluate(() => [...document.querySelectorAll('#vpRight [data-g]')].every(b => b.getClientRects().length > 0)), 'Advanced should show Move, Rotate, Scale');
  await p.click('#vpRight [data-g=rotate]');
  ok(await p.evaluate(() => document.querySelector('#vpRight [data-g=rotate]').classList.contains('on')), 'Rotate button did not light up');
  await p.keyboard.press('c');
  ok(await p.evaluate(() => [...document.querySelectorAll('#vpRight [data-g], #bSnapGrid, #bFocus, #bPip, #bCamHere')].every(b => b.getClientRects().length === 0)), 'Camera view should hide the editor tools');
});

check('timeline: Simple hides frame count, Remove key and FPS; Tracks collapse', async ({ open }) => {
  const p = await open();
  const shown = sel => p.evaluate(s => document.querySelector(s).getClientRects().length > 0, sel);
  ok(!(await shown('#tframe')) && !(await shown('#bUnkey')) && !(await shown('#inFps')), 'Simple mode should hide the frame counter, Remove key and FPS');
  ok(await p.evaluate(() => document.querySelector('#bKey').textContent.trim()) === '◆ Key', 'key button text');
  ok(await p.evaluate(() => document.querySelector('#tl').classList.contains('closed')) && !(await shown('#tlBody')), 'tracks should be closed while nothing is keyed');
  ok(await p.evaluate(() => document.querySelector('#bTracks').textContent) === 'Tracks ▴', 'closed label');
  await p.click('#bTracks');
  ok(await shown('#tlBody') && await p.evaluate(() => document.querySelector('#bTracks').textContent) === 'Tracks ▾', 'Tracks did not open by hand');
  await p.click('#bTracks');
  ok(!(await shown('#tlBody')), 'Tracks did not close by hand');
  await goAdvanced(p);
  ok(await shown('#tframe') && await shown('#bUnkey') && await shown('#inFps'), 'Advanced should show them');
});

check('timeline: tracks open by themselves once something is keyed', async ({ open }) => {
  const p = await open();
  await p.evaluate(() => window.__shotref.applyMove('dollyIn'));
  await p.waitForTimeout(300);
  ok(await p.evaluate(() => document.querySelector('#tlBody').getClientRects().length > 0), 'tracks stayed closed after a camera move was keyed');
});

for (const W of [1100, 1280, 1440]) {
  check('top bar fits without overlap at ' + W + ' px', async ({ freshContext }) => {
    const fc = await freshContext({ viewport: { width: W, height: 800 } });
    const p = await fc.open();
    await p.waitForTimeout(200);
    const r = await p.evaluate(() => {
      const top = document.querySelector('#top'), out = [];
      for (const e of top.children) { const b = e.getBoundingClientRect(); if (b.width > 0 && e.getClientRects().length && !e.classList.contains('spacer')) out.push({ id: e.id || e.className, l: b.left, r: b.right }); }
      return { items: out, sw: top.scrollWidth, cw: top.clientWidth, vw: innerWidth };
    });
    r.items.sort((a, b) => a.l - b.l);
    for (let i = 1; i < r.items.length; i++) ok(r.items[i].l >= r.items[i - 1].r - 0.5, 'overlap: ' + JSON.stringify(r.items[i - 1]) + ' and ' + JSON.stringify(r.items[i]));
    ok(r.items[r.items.length - 1].r <= r.vw + 0.5 && r.items[0].l >= 0 && r.sw <= r.cw + 1, 'the top bar overflows: ' + JSON.stringify(r));
    const st = await p.evaluate(() => { const s = document.querySelector('#stepSeg').getBoundingClientRect(); return { sc: (s.left + s.right) / 2, w: innerWidth }; });
    ok(Math.abs(st.sc - st.w / 2) < 120, 'step bar is not near the centre: ' + JSON.stringify(st));
  });
}

check('camera view: toolbar and camera buttons do not overlap at 1100 px', async ({ freshContext }) => {
  const fc = await freshContext({ viewport: { width: 1100, height: 800 } });
  const p = await fc.open();
  await p.keyboard.press('c');
  await p.waitForTimeout(200);
  const r = await p.evaluate(() => { const a = document.querySelector('#camBar').getBoundingClientRect(), b = document.querySelector('#vpRight').getBoundingClientRect(); return { camR: a.right, vpL: b.left, camT: a.top, vpB: b.bottom, vpT: b.top, camB: a.bottom }; });
  ok(r.camR <= r.vpL || r.camB <= r.vpT || r.vpB <= r.camT, 'camera bar and icon toolbar overlap: ' + JSON.stringify(r));
});

/* ---- batch C: selection model (multi-select, box select, lock, groups, selection bar, ring release) ---- */
const proj3 = (p, x, y, z) => p.evaluate(q => window.__shotref.project(q[0], q[1], q[2]), [x, y, z]);
const selIdsOf = p => p.evaluate(() => window.__shotref.selection.slice());
const idOfType = (p, type) => p.evaluate(t => window.__shotref.state.objects.find(o => o.type === t).id, type);
const objOf = (p, id) => p.evaluate(i => JSON.parse(JSON.stringify(window.__shotref.state.objects.find(o => o.id === i) || null)), id);
const shiftClick = async (p, x, y) => { await p.keyboard.down('Shift'); await p.mouse.click(x, y); await p.keyboard.up('Shift'); };
const undoTitle = p => p.evaluate(() => document.querySelector('#bUndo').title);
/* the three starter objects on screen: person (0,0,0), box (2.2,0,-1.5), tree (-3.5,0,-4) */
async function starterXY(p) {
  const [pe, bo, tr] = await Promise.all([proj3(p, 0, 0.9, 0), proj3(p, 2.2, 0.4, -1.5), proj3(p, -3.5, 1.5, -4)]);
  return { person: pe, box: bo, tree: tr };
}

check('multi-select: Shift-click adds and removes, Ctrl+A selects all, Esc clears, the panel says how many', async ({ open }) => {
  const p = await open(); await p.waitForTimeout(500);
  const xy = await starterXY(p), person = await idOfType(p, 'person'), box = await idOfType(p, 'box');
  await p.mouse.click(...xy.person);
  ok(JSON.stringify(await selIdsOf(p)) === JSON.stringify([person]), 'plain click selects one');
  await shiftClick(p, ...xy.box);
  const two = await selIdsOf(p);
  ok(two.length === 2 && two.includes(person) && two.includes(box), 'Shift-click should add the box, got ' + JSON.stringify(two));
  ok(await p.evaluate(() => window.__shotref.selected) === box, 'the last one clicked is the main one');
  await p.waitForTimeout(250); /* the panel is rebuilt on the next drawn frame */
  ok(/2 items selected/.test(await p.textContent('#props')), 'the panel should say 2 items selected');
  await shiftClick(p, ...xy.person);
  ok(JSON.stringify(await selIdsOf(p)) === JSON.stringify([box]), 'Shift-click on a selected one removes it');
  await p.keyboard.press('Control+a');
  ok((await selIdsOf(p)).length === 3, 'Ctrl+A should select all 3, got ' + (await selIdsOf(p)).length);
  await p.keyboard.press('Escape');
  ok((await selIdsOf(p)).length === 0 && await p.evaluate(() => window.__shotref.selected) === null, 'Esc clears the selection');
  noErrors(p);
});

check('Shift-drag on empty space draws a selection box and selects what it covers', async ({ open }) => {
  const p = await open(); await p.waitForTimeout(500);
  const xy = await starterXY(p), person = await idOfType(p, 'person'), box = await idOfType(p, 'box'), tree = await idOfType(p, 'tree');
  const x0 = Math.min(xy.person[0], xy.box[0]) - 50, y0 = Math.min(xy.person[1], xy.box[1]) - 90, x1 = Math.max(xy.person[0], xy.box[0]) + 50, y1 = Math.max(xy.person[1], xy.box[1]) + 90;
  ok(xy.tree[0] < x0 || xy.tree[0] > x1 || xy.tree[1] < y0 || xy.tree[1] > y1, 'test set-up: the tree must be outside the box ' + JSON.stringify({ x0, y0, x1, y1, tree: xy.tree }));
  await p.keyboard.down('Shift');
  await p.mouse.move(x0, y0); await p.mouse.down(); await p.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 4 }); await p.mouse.move(x1, y1, { steps: 4 });
  const shown = await p.evaluate(() => { const b = document.querySelector('#boxSel'); return b && getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().width > 50; });
  ok(shown, 'the dashed selection box should show while dragging');
  await p.mouse.up(); await p.keyboard.up('Shift');
  const s = await selIdsOf(p);
  ok(s.includes(person) && s.includes(box) && !s.includes(tree), 'box should select person and box only, got ' + JSON.stringify(s));
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('#boxSel')).display) === 'none', 'the box hides on release');
  /* Shift+click on empty space changes nothing */
  const cr = await p.evaluate(() => { const r = document.querySelector('#c').getBoundingClientRect(); return [r.left + 30, r.bottom - 30]; });
  await shiftClick(p, cr[0], cr[1]);
  ok((await selIdsOf(p)).length === 2, 'Shift+click on empty space must keep the selection, got ' + JSON.stringify(await selIdsOf(p)));
  noErrors(p);
});

check('dragging one of several moves them all; keyed items get a key at the playhead; undo names it', async ({ open }) => {
  const p = await open(); await p.waitForTimeout(400);
  const person = await idOfType(p, 'person'), box = await idOfType(p, 'box');
  await p.evaluate(id => { const S = window.__shotref, o = S.state.objects.find(x => x.id === id); const tr = x => ({ p: [x, 0, 0], r: [0, 20, 0], s: [1, 1, 1] }); S.setKey(o.keys, 0, tr(0)); S.setKey(o.keys, 2, tr(1)); S.changed(true); S.setT(1); }, person);
  await p.waitForTimeout(150);
  const xy = await starterXY(p);
  const before = await p.evaluate(([a, b]) => { const S = window.__shotref; return { a: S.evalObj(S.state.objects.find(o => o.id === a), 1).p, b: S.state.objects.find(o => o.id === b).base.p.slice() }; }, [person, box]);
  const pxy = await proj3(p, before.a[0], 0.9, before.a[2]);
  await p.mouse.click(...pxy); await shiftClick(p, ...xy.box);
  await p.mouse.move(...xy.box); await p.mouse.down(); await p.mouse.move(xy.box[0] + 40, xy.box[1] + 30, { steps: 6 }); await p.mouse.move(xy.box[0] + 90, xy.box[1] + 50, { steps: 6 }); await p.mouse.up();
  const after = await p.evaluate(([a, b]) => { const S = window.__shotref, o = S.state.objects.find(x => x.id === a); return { a: S.evalObj(o, 1).p, b: S.state.objects.find(x => x.id === b).base.p.slice(), keysT: o.keys.map(k => k.t) }; }, [person, box]);
  const da = [after.a[0] - before.a[0], after.a[2] - before.a[2]], db = [after.b[0] - before.b[0], after.b[2] - before.b[2]];
  ok(Math.hypot(da[0], da[1]) > 0.3, 'the person should have moved: ' + JSON.stringify(da));
  ok(Math.abs(da[0] - db[0]) < 0.03 && Math.abs(da[1] - db[1]) < 0.03, 'both should move by the same amount: ' + JSON.stringify({ da, db }));
  ok(after.keysT.some(t => Math.abs(t - 1) < 0.02), 'the keyed person needs a key at the playhead (1 s), keys at ' + JSON.stringify(after.keysT));
  const bo = await objOf(p, box); ok(bo.keys.length === 0, 'the unkeyed box should change its base pose, not get keys');
  await p.waitForTimeout(250);
  ok(/move 2 items/.test(await undoTitle(p)), 'undo should say "move 2 items": ' + await undoTitle(p));
  noErrors(p);
});

check('lock: Ctrl+L, outliner button and panel line; locked items select but do not drag or delete', async ({ open }) => {
  const p = await open(); await p.waitForTimeout(400);
  const box = await idOfType(p, 'box'), xy = await starterXY(p);
  await p.mouse.click(...xy.box);
  await p.keyboard.press('Control+l');
  ok((await objOf(p, box)).locked === true, 'Ctrl+L should lock the box');
  await p.waitForTimeout(250);
  ok(/lock/i.test(await undoTitle(p)), 'undo should name the lock: ' + await undoTitle(p));
  ok(await p.isVisible('#props .lockline'), 'the panel should show the Locked line');
  await p.waitForTimeout(250);
  ok(await p.evaluate(() => window.__shotref.ringKnob()) === null, 'a locked item has no turn ring');
  const b0 = (await objOf(p, box)).base.p.slice();
  await p.mouse.move(...xy.box); await p.mouse.down(); await p.mouse.move(xy.box[0] + 60, xy.box[1] + 40, { steps: 6 }); await p.mouse.up();
  ok(JSON.stringify((await objOf(p, box)).base.p) === JSON.stringify(b0), 'a locked box must not move when dragged');
  ok(JSON.stringify(await selIdsOf(p)) === JSON.stringify([box]), 'a locked item can still be selected');
  await p.keyboard.press('Delete');
  ok(!!(await objOf(p, box)), 'a locked item must not be deleted by the Delete key');
  await p.click('#props .lockline button');
  ok((await objOf(p, box)).locked !== true, 'the Unlock button in the panel unlocks');
  /* outliner lock button */
  await p.click('#leftTabs [data-lt="scene"]');
  await p.click('#outliner .ol[data-id="' + box + '"] .lockb');
  ok((await objOf(p, box)).locked === true, 'the outliner lock button locks');
  await p.waitForTimeout(250);
  ok(await p.evaluate(i => document.querySelector('#outliner .ol[data-id="' + i + '"] .lockb').classList.contains('on'), box), 'the lock button shows it is on');
  await p.click('#outliner .ol[data-id="' + box + '"] .lockb');
  ok((await objOf(p, box)).locked !== true, 'the outliner lock button unlocks again');
  /* mixed selection: Delete removes only the unlocked */
  const person = await idOfType(p, 'person');
  await p.evaluate(i => { const S = window.__shotref; S.state.objects.find(o => o.id === i).locked = true; S.changed(true, true); }, person);
  await p.keyboard.press('Control+a'); await p.keyboard.press('Delete');
  const left = await p.evaluate(() => window.__shotref.state.objects.map(o => o.type));
  ok(left.length === 1 && left[0] === 'person', 'only the locked person should survive Delete-all, got ' + JSON.stringify(left));
  noErrors(p);
});

check('groups: Ctrl+G, click selects all, Alt-click one, group moves together, Ctrl+Shift+G, tag in the Scene list', async ({ open }) => {
  const p = await open(); await p.waitForTimeout(400);
  const person = await idOfType(p, 'person'), box = await idOfType(p, 'box'), xy = await starterXY(p);
  await p.mouse.click(...xy.person); await shiftClick(p, ...xy.box);
  await p.keyboard.press('Control+g');
  let st = await stateOf(p);
  const gp = st.objects.find(o => o.id === person).grp;
  ok(gp && st.objects.find(o => o.id === box).grp === gp && st.groups[gp] && /^Group/.test(st.groups[gp].name), 'Ctrl+G should group them: ' + JSON.stringify(st.groups));
  await p.waitForTimeout(250);
  ok(/group/i.test(await undoTitle(p)), 'undo should name the grouping: ' + await undoTitle(p));
  await p.keyboard.press('Escape');
  await p.mouse.click(...xy.person);
  ok((await selIdsOf(p)).length === 2, 'clicking a group member should select the whole group');
  ok(await p.isVisible('#props input[value^="Group"]'), 'the panel should offer the group name');
  await p.keyboard.press('Escape');
  await p.keyboard.down('Alt'); await p.mouse.click(...xy.person); await p.keyboard.up('Alt');
  ok(JSON.stringify(await selIdsOf(p)) === JSON.stringify([person]), 'Alt-click picks one inside the group, got ' + JSON.stringify(await selIdsOf(p)));
  /* dragging a grouped item moves the group */
  await p.keyboard.press('Escape');
  const b0 = (await objOf(p, box)).base.p.slice();
  await p.mouse.move(...xy.person); await p.mouse.down(); await p.mouse.move(xy.person[0] - 50, xy.person[1] + 20, { steps: 6 }); await p.mouse.move(xy.person[0] - 90, xy.person[1] + 30, { steps: 6 }); await p.mouse.up();
  const b1 = (await objOf(p, box)).base.p;
  ok(Math.hypot(b1[0] - b0[0], b1[2] - b0[2]) > 0.3, 'dragging one group member should move the other too');
  /* Scene list tag */
  await p.click('#leftTabs [data-lt="scene"]');
  ok(await p.evaluate(i => !!document.querySelector('#outliner .ol[data-id="' + i + '"] .gtag'), box), 'the Scene list should tag grouped items');
  /* ungroup */
  await p.keyboard.press('Control+Shift+g');
  st = await stateOf(p);
  ok(!st.objects.find(o => o.id === person).grp && !st.objects.find(o => o.id === box).grp && !Object.keys(st.groups || {}).length, 'Ctrl+Shift+G ungroups and drops the group: ' + JSON.stringify(st.groups));
  noErrors(p);
});

check('groups tidy themselves: deleting down to one member dissolves the group; duplicating a group makes a new one', async ({ open }) => {
  const p = await open(); await p.waitForTimeout(400);
  const person = await idOfType(p, 'person'), box = await idOfType(p, 'box'), xy = await starterXY(p);
  await p.mouse.click(...xy.person); await shiftClick(p, ...xy.box); await p.keyboard.press('Control+g');
  await p.keyboard.press('Control+d');
  let st = await stateOf(p);
  ok(st.objects.length === 5 && Object.keys(st.groups).length === 2, 'duplicate of a group should be a second group: ' + JSON.stringify(st.groups));
  const copies = st.objects.slice(3); ok(copies[0].grp && copies[0].grp === copies[1].grp && copies[0].grp !== st.objects.find(o => o.id === person).grp, 'the copies share a new group');
  ok((await selIdsOf(p)).length === 2, 'the copies end up selected');
  await p.evaluate(i => { const S = window.__shotref; S.select(i, 'single'); }, person);
  await p.keyboard.press('Delete');
  st = await stateOf(p);
  ok(!st.objects.find(o => o.id === box).grp && Object.keys(st.groups).length === 1, 'a group left with one member dissolves: ' + JSON.stringify(st.groups));
  noErrors(p);
});

check('selection toolbar floats over the selection, follows its kind, hides in camera view and while playing', async ({ open }) => {
  const p = await open(); await p.waitForTimeout(400);
  const xy = await starterXY(p), person = await idOfType(p, 'person'), box = await idOfType(p, 'box');
  ok(!(await p.isVisible('#selBar')), 'no toolbar with nothing selected');
  await p.mouse.click(...xy.person); await p.waitForTimeout(250);
  ok(await p.isVisible('#selBar'), 'the toolbar shows over a selected person');
  const r = await p.evaluate(() => { const b = document.querySelector('#selBar').getBoundingClientRect(), v = document.querySelector('#vp').getBoundingClientRect(); return { cx: (b.left + b.right) / 2, bottom: b.bottom, top: b.top, vt: v.top }; });
  ok(Math.abs(r.cx - xy.person[0]) < 90 && r.bottom < xy.person[1] && r.top >= r.vt, 'the toolbar should sit above the person: ' + JSON.stringify({ r, person: xy.person }));
  const tips = await p.evaluate(() => [...document.querySelectorAll('#selBar button')].map(b => b.dataset.tip));
  for (const t of ['Draw walk path', 'Duplicate', 'Lock', 'Delete']) ok(tips.some(x => x && x.startsWith(t)), 'person toolbar misses ' + t + ': ' + JSON.stringify(tips));
  await p.click('#selBar [data-tip^="Lock"]');
  ok((await objOf(p, person)).locked === true, 'the toolbar Lock button locks');
  await p.click('#selBar [data-tip^="Unlock"]');
  ok((await objOf(p, person)).locked !== true, 'and the same button unlocks');
  await shiftClick(p, ...xy.box); await p.waitForTimeout(250);
  const tips2 = await p.evaluate(() => [...document.querySelectorAll('#selBar button')].map(b => b.dataset.tip));
  ok(tips2.some(x => x && x.startsWith('Group')), 'a multi-selection toolbar offers Group: ' + JSON.stringify(tips2));
  await p.click('#selBar [data-tip^="Group"]');
  ok(!!(await objOf(p, box)).grp, 'the toolbar Group button groups');
  await p.click('#selBar [data-tip^="Duplicate"]');
  ok((await p.evaluate(() => window.__shotref.state.objects.length)) === 5, 'the toolbar Duplicate copies the group');
  await p.keyboard.press('c'); await p.waitForTimeout(250);
  ok(!(await p.isVisible('#selBar')), 'hidden in camera view');
  await p.keyboard.press('c'); await p.waitForTimeout(250);
  ok(await p.isVisible('#selBar'), 'back in the editor');
  await p.keyboard.press(' '); await p.waitForTimeout(300);
  ok(!(await p.isVisible('#selBar')), 'hidden while playing');
  await p.keyboard.press(' ');
  await p.evaluate(() => window.__shotref.setPref('selBar', false)); await p.keyboard.press('ArrowRight'); await p.waitForTimeout(250);
  ok(!(await p.isVisible('#selBar')), 'the selBar preference turns it off');
  noErrors(p);
});

check('the turn ring turns a whole selection together and releasing over a person or the camera faces it', async ({ open }) => {
  const p = await open(); await p.waitForTimeout(400);
  const person = await idOfType(p, 'person'), box = await idOfType(p, 'box');
  await p.keyboard.press('t'); await p.waitForTimeout(400);
  await p.evaluate(() => { const S = window.__shotref, o = S.addObject('person'); o.base.p = [4, 0, 0]; S.changed(true, true); });
  await p.waitForTimeout(200);
  await p.evaluate(id => window.__shotref.select(id), person); await p.waitForTimeout(200);
  const knob = () => p.evaluate(() => { const k = window.__shotref.ringKnob(); return k ? window.__shotref.project(k[0], k[1], k[2]) : null; });
  let k = await knob(); ok(k, 'the ring knob should show for the selected person');
  /* release over the other person: faces +x, yaw 90 */
  const oxy = await proj3(p, 4, 0.9, 0);
  await p.mouse.move(...k); await p.mouse.down(); await p.mouse.move((k[0] + oxy[0]) / 2, (k[1] + oxy[1]) / 2, { steps: 5 }); await p.mouse.move(...oxy, { steps: 5 });
  ok(/Release to face/.test(await p.evaluate(() => document.querySelector('#modeBar').textContent)), 'the bar should say "Release to face ..."');
  await p.mouse.up();
  let yaw = (await objOf(p, person)).base.r[1]; yaw = ((yaw % 360) + 360) % 360;
  ok(Math.abs(yaw - 90) < 1.5, 'releasing over the other person should face them (90), got ' + yaw);
  await p.waitForTimeout(250);
  ok(/turn|face/.test(await undoTitle(p)), 'undo names the step: ' + await undoTitle(p));
  /* release over the camera */
  k = await knob();
  const cxy = await p.evaluate(() => { const c = window.__shotref.state.camera.base.p; return window.__shotref.project(c[0], c[1], c[2]); });
  await p.mouse.move(...k); await p.mouse.down(); await p.mouse.move((k[0] + cxy[0]) / 2, (k[1] + cxy[1]) / 2, { steps: 5 }); await p.mouse.move(...cxy, { steps: 5 }); await p.mouse.up();
  yaw = (await objOf(p, person)).base.r[1]; yaw = ((yaw % 360) + 360) % 360;
  const want = Math.atan2(3.4, 6.2) * 180 / Math.PI;
  ok(Math.abs(yaw - want) < 1.5, 'releasing over the camera should face it (' + want.toFixed(1) + '), got ' + yaw);
  /* a selection turns together around the middle */
  await p.evaluate(([a, b]) => { const S = window.__shotref; S.select(a); S.select(b, 'toggle'); }, [person, box]); await p.waitForTimeout(200);
  const baseOf = ids => p.evaluate(l => l.map(i => JSON.parse(JSON.stringify(window.__shotref.state.objects.find(o => o.id === i).base))), ids);
  const before = await baseOf([person, box]);
  k = await knob(); await p.mouse.move(...k); await p.mouse.down(); await p.mouse.move(k[0] + 5, k[1] + 30, { steps: 5 }); await p.mouse.move(k[0] - 70, k[1] + 70, { steps: 8 }); await p.mouse.up();
  const after = await baseOf([person, box]);
  const dyaw = [0, 1].map(i => { const d = after[i].r[1] - before[i].r[1]; return ((d % 360) + 540) % 360 - 180; });
  ok(Math.abs(dyaw[0]) > 5 && Math.abs(dyaw[0] - dyaw[1]) < 0.5, 'both should turn by the same angle, got ' + JSON.stringify(dyaw));
  const d0 = Math.hypot(before[0].p[0] - before[1].p[0], before[0].p[2] - before[1].p[2]), d1 = Math.hypot(after[0].p[0] - after[1].p[0], after[0].p[2] - after[1].p[2]);
  ok(Math.abs(d0 - d1) < 0.02, 'turning keeps their spacing: ' + d0 + ' vs ' + d1);
  await p.waitForTimeout(250);
  ok(/turn 2 items/.test(await undoTitle(p)), 'undo should say "turn 2 items": ' + await undoTitle(p));
  noErrors(p);
});

check('Scene list right-click menu works like the 3D one; menus offer group and lock', async ({ open }) => {
  const p = await open(); await p.waitForTimeout(400);
  const box = await idOfType(p, 'box'), person = await idOfType(p, 'person');
  await p.click('#leftTabs [data-lt="scene"]');
  await p.click('#outliner .ol[data-id="camera"]', { button: 'right' });
  let labels = await menuLabels(p); ok(labels && labels.some(x => x.startsWith('Look through camera')), 'camera row menu: ' + JSON.stringify(labels));
  await p.keyboard.press('Escape');
  await p.click('#outliner .ol[data-id="' + box + '"]', { button: 'right' });
  labels = await menuLabels(p);
  for (const l of ['Lock', 'Duplicate', 'Hide', 'Delete']) ok(labels && labels.some(x => x.startsWith(l)), 'Scene list menu misses ' + l + ': ' + JSON.stringify(labels));
  ok((await selIdsOf(p))[0] === box, 'right-click in the list selects that row');
  await clickItem(p, 'Lock');
  ok((await objOf(p, box)).locked === true, 'menu Lock locks');
  await p.click('#outliner .ol[data-id="' + box + '"]', { button: 'right' });
  labels = await menuLabels(p); ok(labels.some(x => x.startsWith('Unlock')), 'a locked item offers Unlock: ' + JSON.stringify(labels));
  await p.keyboard.press('Escape');
  /* several rows: Shift-click in the list, then the menu */
  await p.click('#outliner .ol[data-id="' + person + '"]');
  await p.click('#outliner .ol[data-id="' + box + '"]', { modifiers: ['Shift'] });
  ok((await selIdsOf(p)).length === 2, 'Shift-click in the Scene list adds to the selection');
  await p.click('#outliner .ol[data-id="' + box + '"]', { button: 'right' });
  labels = await menuLabels(p);
  ok(labels.some(x => x.startsWith('Group 2 items')) && labels.some(x => /^(Un)?[Ll]ock 2 items/.test(x)), 'multi menu: ' + JSON.stringify(labels));
  await clickItem(p, 'Group 2 items');
  ok(!!(await objOf(p, person)).grp, 'menu Group groups');
  /* the 3D menu */
  await p.keyboard.press('Escape');
  const xy = await starterXY(p);
  await rightClick(p, ...xy.person); await p.waitForTimeout(150);
  labels = await menuLabels(p);
  ok(labels.some(x => x.startsWith('Ungroup')) && labels.some(x => /ock/.test(x)), '3D menu on a group member: ' + JSON.stringify(labels));
  noErrors(p);
});

check('selection toolbar and menus act on the current objects after undo and redo', async ({ open }) => {
  const p = await open(); await p.waitForTimeout(400);
  const box = await idOfType(p, 'box'), xy = await starterXY(p);
  await p.mouse.click(...xy.box);
  await p.mouse.move(...xy.box); await p.mouse.down(); await p.mouse.move(xy.box[0] + 40, xy.box[1] + 20, { steps: 5 }); await p.mouse.move(xy.box[0] + 80, xy.box[1] + 30, { steps: 5 }); await p.mouse.up();
  await p.keyboard.press('Control+z'); await p.waitForTimeout(300);
  await p.click('#selBar [data-tip^="Lock"]');
  ok((await objOf(p, box)).locked === true, 'the toolbar Lock after undo must lock the box that is in the scene now');
  await p.keyboard.press('Control+z'); await p.keyboard.press('Control+y'); await p.waitForTimeout(300);
  await p.click('#selBar [data-tip^="Unlock"]');
  ok((await objOf(p, box)).locked !== true, 'the toolbar Unlock after undo and redo must unlock it');
  noErrors(p);
});

check('a plain click on an item inside a multi-selection selects only it; dragging still moves all', async ({ open }) => {
  const p = await open(); await p.waitForTimeout(400);
  const person = await idOfType(p, 'person'), box = await idOfType(p, 'box'), xy = await starterXY(p);
  await p.mouse.click(...xy.person); await shiftClick(p, ...xy.box);
  ok((await selIdsOf(p)).length === 2, 'set-up');
  await p.mouse.click(...xy.person);
  ok(JSON.stringify(await selIdsOf(p)) === JSON.stringify([person]), 'a click should leave only the clicked item, got ' + JSON.stringify(await selIdsOf(p)));
  await shiftClick(p, ...xy.box);
  const b0 = (await objOf(p, box)).base.p.slice();
  await p.mouse.move(...xy.person); await p.mouse.down(); await p.mouse.move(xy.person[0] - 40, xy.person[1] + 20, { steps: 5 }); await p.mouse.move(xy.person[0] - 80, xy.person[1] + 30, { steps: 5 }); await p.mouse.up();
  const b1 = (await objOf(p, box)).base.p;
  ok(Math.hypot(b1[0] - b0[0], b1[2] - b0[2]) > 0.3, 'dragging a selected item must still move the whole selection');
  ok((await selIdsOf(p)).length === 2, 'and a drag keeps the selection');
  /* locked members and face-camera / drop-to-floor skip locked items */
  await p.evaluate(i => { const S = window.__shotref; S.state.objects.find(o => o.id === i).locked = true; S.changed(true, true); }, person);
  await p.waitForTimeout(250);
  ok(await p.locator('#props button:has-text("People face camera")').count() === 0, 'People face camera is not offered when every person is locked');
  noErrors(p);
});

/* ---------------- Batch D: people (body types, eyeline, seats, pose changes over time, face the camera) ---------------- */
const rigOf = (p, id) => p.evaluate(i => { const S = window.__shotref; S.applyAll(S.T); return S.rig(i); }, id);
const rigAt = (p, id, t) => p.evaluate(a => { const S = window.__shotref; S.setT(a[1]); S.applyAll(a[1]); return S.rig(a[0]); }, [id, t]);
const placeAt = (p, x, z) => p.evaluate(q => { const S = window.__shotref; const o = S.state.objects.find(i => i.type === 'person'); o.base.p = [q[0], 0, q[1]]; o.base.r = [0, 0, 0]; S.changed(true, true); return o.id; }, [x, z]);
const setCamPos = (p, pos) => p.evaluate(q => { const S = window.__shotref; S.state.camera.base.p = q; S.changed(true, true); }, pos);
const addChair = (p, x, z, type = 'chair') => p.evaluate(q => window.__shotref.addObject(q[2], null, false, [q[0], 0, q[1]]).id, [x, z, type]);

check('people: Add tab has Man, Woman and Child tiles that add that body with its own height, colours and name', async ({ open }) => {
  const p = await open(); await p.waitForTimeout(400);
  const tiles = await p.evaluate(() => [...document.querySelectorAll('#addArea .tile[data-body]')].map(b => b.textContent.trim()));
  ok(JSON.stringify(tiles) === JSON.stringify(['Man', 'Woman', 'Child']), 'tiles: ' + JSON.stringify(tiles));
  ok(await p.evaluate(() => ![...document.querySelectorAll('#addArea .tile')].some(b => b.textContent.trim() === 'Add person')), 'the single Add person tile is gone');
  const want = { woman: { name: /^Woman \d/, h: 1.66, color: '#c4566c' }, child: { name: /^Child \d/, h: 1.2, color: '#e0a030' }, man: { name: /^Man \d/, h: 1.78, color: '#3d6fd8' } };
  for (const k of ['woman', 'child', 'man']) {
    await p.click('#addArea .tile[data-body="' + k + '"]');
    const xy = await p.evaluate(() => window.__shotref.project(1.2, 0, 3));
    await p.mouse.click(...xy); await p.waitForTimeout(250);
    const o = await p.evaluate(() => { const S = window.__shotref; return JSON.parse(JSON.stringify(S.state.objects[S.state.objects.length - 1])); });
    ok(o.type === 'person' && o.opts.body === k && want[k].name.test(o.name) && Math.abs(o.opts.height - want[k].h) < 1e-6 && (k !== 'woman' || o.color === want[k].color), k + ' came out as ' + JSON.stringify({ n: o.name, b: o.opts.body, h: o.opts.height, c: o.color }));
  }
  /* the panel names the body and has the Man / Woman / Child buttons; switching rebuilds the mannequin */
  const title = await p.evaluate(() => document.querySelector('#props .sec h3').textContent);
  ok(title === 'Man', 'the panel title is the body: ' + title);
  await p.click('#props .seg [data-body="woman"]'); await p.waitForTimeout(200);
  const o2 = await p.evaluate(() => { const S = window.__shotref; return S.state.objects[S.state.objects.length - 1]; });
  ok(o2.opts.body === 'woman' && Math.abs(o2.opts.height - 1.66) < 1e-6, 'the body button changes body and height');
  ok(await p.evaluate(() => document.querySelector('#props .sec h3').textContent) === 'Woman', 'the title follows');
  noErrors(p);
});

check('people: bodies have different proportions (shoulders, hips, head, long hair) and old people look as before', async ({ open }) => {
  const p = await open(); await p.waitForTimeout(300);
  const ids = await p.evaluate(() => { const S = window.__shotref; return ['man', 'woman', 'child'].map(b => S.addPerson(b, false, [4, 0, 0]).id); });
  await p.waitForTimeout(200);
  const [m, w, c] = [await rigOf(p, ids[0]), await rigOf(p, ids[1]), await rigOf(p, ids[2])];
  ok(Math.abs(m.shoulderX / m.H - 0.118) < 1e-3 && Math.abs(w.shoulderX / w.H - 0.106) < 1e-3 && Math.abs(c.shoulderX / c.H - 0.112) < 1e-3, 'shoulders: ' + [m, w, c].map(r => (r.shoulderX / r.H).toFixed(3)));
  ok(Math.abs(w.hipX / w.H - 0.066) < 1e-3 && Math.abs(m.hipX / m.H - 0.062) < 1e-3, 'hips differ');
  ok(c.headScale > 1.3 && m.headScale === 1, 'a child has the bigger head: ' + [m.headScale, c.headScale]);
  ok(w.headParts === m.headParts + 1, 'a woman has long hair: ' + [m.headParts, w.headParts]);
  /* the starter person has no body field and must look like a man */
  const old = await rigOf(p, await idOfType(p, 'person'));
  ok(Math.abs(old.shoulderX / old.H - 0.118) < 1e-3 && old.headScale === 1, 'a person without opts.body is built as a man');
  noErrors(p);
});

check('people: an artifact-made file with body, eyeline, seat and pose changes shows them all', async ({ open }) => {
  const O = (id, type, extra) => ({ id, type, name: id, color: '#c4566c', base: { p: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }, keys: [], opts: {}, visible: true, ...extra });
  const file = { app: 'ShotRef', version: 1, state: { v: 1, settings: { duration: 6, fps: 24 }, camera: { base: JSON.parse(CAM_BASE), keys: [] },
    objects: [
      O('ch1', 'chair', { base: { p: [2, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } }),
      O('w1', 'person', { opts: { body: 'woman', height: 1.66, pose: 'stand', lookAt: 'camera', skin: '#d2a07c', pants: '#3e5f8f', hair: '#3a2418' }, acts: [{ t: 2, pose: 'wave' }, { t: 4, pose: 'sit', at: { p: [2, 0, 0.02], yaw: 0 } }] }),
      O('k1', 'person', { color: '#e0a030', base: { p: [-2, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }, opts: { body: 'child', height: 1.2, pose: 'sit', seated: 'ch1', lookAt: 'w1' } })] }, assets: {} };
  const p = await open(); await openFile(p, 'art.shotref.json', JSON.stringify(file));
  await p.waitForFunction(() => window.__shotref.state.objects.length === 3);
  const st = await stateOf(p), w = st.objects[1], k = st.objects[2];
  ok(w.opts.body === 'woman' && w.opts.lookAt === 'camera' && w.acts.length === 2 && w.acts[1].at.yaw === 0 && k.opts.body === 'child' && k.opts.seated === 'ch1' && k.opts.lookAt === 'w1', 'fields kept: ' + JSON.stringify([w, k]));
  const r0 = await rigAt(p, 'w1', 1), r3 = await rigAt(p, 'w1', 3.2), r5 = await rigAt(p, 'w1', 5);
  ok(Math.abs(r0.shoulderX / r0.H - 0.106) < 1e-3, 'the woman is built as a woman');
  ok(Math.abs(r3.rSh[0] - r0.rSh[0]) + Math.abs(r3.rSh[1] - r0.rSh[1]) + Math.abs(r3.rSh[2] - r0.rSh[2]) > 0.3, 'she waves at 3.2 s: ' + JSON.stringify([r0.rSh, r3.rSh]));
  ok(Math.abs(r5.group.p[0] - 2) < 0.2, 'after the sit action she is on the chair, x=' + r5.group.p[0]);
  ok(r5.lHip[0] < -1.2, 'and sitting (hips bent): ' + r5.lHip[0]);
  ok(Math.abs(r0.neck[1]) > 0.2, 'she looks at the camera (neck turned ' + r0.neck[1].toFixed(2) + ')');
  const rk = await rigAt(p, 'k1', 0);
  ok(Math.abs(rk.neck[1]) > 0.3, 'the child on the chair looks toward the woman: ' + rk.neck[1].toFixed(2));
  noErrors(p);
});

check('people: look at the camera, at a person or ahead turns the head and upper body toward it', async ({ open }) => {
  const p = await open(); await p.waitForTimeout(300);
  const id = await placeAt(p, 0, 0);
  const other = await p.evaluate(() => { const S = window.__shotref; return S.addPerson('woman', false, [-3, 0, 0]).id; });
  await setCamPos(p, [4, 1.6, 0]);
  let r = await rigOf(p, id);
  ok(Math.abs(r.neck[1]) < 0.02, 'no eyeline: head straight ahead');
  await p.evaluate(i => window.__shotref.setLookAt({ id: i }, 'camera'), id);
  r = await rigOf(p, id);
  const s1 = Math.sign(r.neck[1]);
  ok(Math.abs(r.neck[1]) > 0.5 && Math.abs(r.spine[1]) > 0.2, 'looking at the camera to the side: neck ' + r.neck[1].toFixed(2) + ' spine ' + r.spine[1].toFixed(2));
  await setCamPos(p, [-4, 1.6, 0]);
  r = await rigOf(p, id);
  ok(Math.sign(r.neck[1]) === -s1 && Math.abs(r.neck[1]) > 0.5, 'the camera moved to the other side, the head follows: ' + r.neck[1].toFixed(2));
  await p.evaluate(a => window.__shotref.setLookAt({ id: a[0] }, a[1]), [id, other]);
  await setCamPos(p, [4, 1.6, 0]);
  r = await rigOf(p, id);
  ok(Math.sign(r.neck[1]) === -s1 && Math.abs(r.neck[1]) > 0.5, 'looking at the woman at -x turns the same way as the camera at -x: ' + r.neck[1].toFixed(2));
  /* the target moves: the head keeps following */
  await p.evaluate(o => { const S = window.__shotref, q = S.state.objects.find(x => x.id === o); q.keys = [{ t: 0, p: [-3, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }, { t: 2, p: [3, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }]; S.changed(true, true); }, other);
  const a = await rigAt(p, id, 0), b = await rigAt(p, id, 2);
  ok(Math.sign(a.neck[1]) === -Math.sign(b.neck[1]) && Math.abs(a.neck[1]) > 0.5 && Math.abs(b.neck[1]) > 0.5, 'follows a moving target: ' + [a.neck[1], b.neck[1]].map(v => v.toFixed(2)));
  /* a person behind them: eases back toward straight ahead instead of twisting the neck round */
  await p.evaluate(o => { const q = window.__shotref.state.objects.find(x => x.id === o); q.keys = []; q.base.p = [0, 0, -4]; window.__shotref.changed(true, true); }, other);
  r = await rigAt(p, id, 0);
  ok(Math.abs(r.neck[1]) < 0.2, 'a target straight behind does not twist the neck: ' + r.neck[1].toFixed(2));
  await p.evaluate(i => window.__shotref.setLookAt({ id: i }, null), id);
  r = await rigAt(p, id, 0);
  ok(Math.abs(r.neck[1]) < 0.02 && !(await objOf(p, id)).opts.lookAt, 'ahead again');
  noErrors(p);
});

check('people: Eyeline panel, selection toolbar and right-click menu set where they look; undo names it', async ({ open }) => {
  const p = await open(); await p.waitForTimeout(400);
  const id = await idOfType(p, 'person'), xy = await starterXY(p);
  await p.mouse.click(...xy.person); await p.waitForTimeout(250);
  const opts = await p.evaluate(() => { const s = [...document.querySelectorAll('#props .sec')].find(x => x.querySelector('h3').textContent.replace(/\?$/, '') === 'Eyeline'); return s ? [...s.querySelectorAll('option')].map(o => o.textContent) : null; });
  ok(opts && opts[0].startsWith('Ahead') && opts[1] === 'The camera' && opts.length >= 3, 'Eyeline options: ' + JSON.stringify(opts));
  await p.selectOption('#props .sec:has(h3:text-matches("^Eyeline[?]?$")) select', 'camera');
  ok((await objOf(p, id)).opts.lookAt === 'camera', 'the panel sets look-at the camera');
  await p.waitForTimeout(200);
  ok(/eyeline/.test(await undoTitle(p)), 'undo names it: ' + await undoTitle(p));
  ok((await p.getAttribute('#selBar [data-tip="Stop looking at the camera"]', 'class') || '').includes('on'), 'the toolbar eye is lit while looking at the camera');
  await p.click('#selBar [data-tip="Stop looking at the camera"]');
  ok(!(await objOf(p, id)).opts.lookAt, 'the toolbar toggles it off');
  await p.click('#selBar [data-tip="Look at the camera"]');
  ok((await objOf(p, id)).opts.lookAt === 'camera', 'and on');
  await p.click('#selBar [data-tip="Stop looking at the camera"]');
  await p.mouse.click(...xy.person, { button: 'right' }); await p.waitForTimeout(200);
  let labels = await menuLabels(p);
  ok(labels && labels.includes('Look at the camera'), 'menu: ' + JSON.stringify(labels));
  await clickItem(p, 'Look at the camera');
  ok((await objOf(p, id)).opts.lookAt === 'camera', 'the menu sets it');
  await p.mouse.click(...xy.person, { button: 'right' }); await p.waitForTimeout(200);
  ok((await menuLabels(p)).includes('Stop looking at the camera'), 'the menu then offers Stop');
  await p.keyboard.press('Escape');
  /* "<this> looks at <selected person>" */
  await p.evaluate(() => window.__shotref.addPerson('woman', false, [-1.5, 0, 0]));
  await p.waitForTimeout(250);
  await p.evaluate(i => window.__shotref.select(i), id); await p.waitForTimeout(150);
  const wxy = await p.evaluate(() => window.__shotref.project(-1.5, 0.9, 0));
  await p.mouse.click(...wxy, { button: 'right' }); await p.waitForTimeout(200);
  labels = await menuLabels(p);
  ok(labels.some(l => /looks at/.test(l)), 'menu offers "looks at" the selected person: ' + JSON.stringify(labels));
  noErrors(p);
});

check('people: dragging a person onto a chair sits them; dragging away stands them; undo works', async ({ open }) => {
  const p = await open(); await p.waitForTimeout(300);
  const id = await placeAt(p, 0, 0), chair = await addChair(p, 2, 2);
  await p.waitForTimeout(300);
  const from = await p.evaluate(() => window.__shotref.project(0, 0.9, 0)), to = await p.evaluate(() => window.__shotref.project(2, 0.9, 2.05));
  await p.mouse.move(...from); await p.mouse.down();
  await p.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { steps: 6 }); await p.mouse.move(...to, { steps: 8 });
  ok(/Release to sit on Chair/.test(await p.textContent('#modeBar')), 'the bar says Release to sit: ' + await p.textContent('#modeBar'));
  await p.mouse.up(); await p.waitForTimeout(300);
  let o = await objOf(p, id);
  ok(o.opts.seated === chair && o.opts.pose === 'sit' && o.opts.faceTravel === false, 'seated: ' + JSON.stringify(o.opts));
  ok(Math.abs(o.base.p[0] - 2) < 0.01 && Math.abs(o.base.p[2] - 2.02) < 0.01 && o.base.p[1] === 0, 'sits on the seat spot: ' + o.base.p);
  const sat = await rigOf(p, id);
  ok(sat.lHip[0] < -1.2, 'hips are bent');
  ok(/sit/.test(await undoTitle(p)), 'undo names it: ' + await undoTitle(p));
  /* drag away: stands */
  const from2 = await p.evaluate(() => window.__shotref.project(2, 0.7, 2.02)), away = await p.evaluate(() => window.__shotref.project(-1, 0.7, 3));
  await p.mouse.move(...from2); await p.mouse.down(); await p.mouse.move((from2[0] + away[0]) / 2, (from2[1] + away[1]) / 2, { steps: 6 }); await p.mouse.move(...away, { steps: 8 }); await p.mouse.up(); await p.waitForTimeout(300);
  o = await objOf(p, id);
  ok(!o.opts.seated && o.opts.pose === 'stand' && o.base.p[1] === 0 && o.base.p[0] < 0.5, 'dragged away: stands up: ' + JSON.stringify([o.opts.seated, o.opts.pose, o.base.p]));
  await p.keyboard.press('Control+z'); await p.waitForTimeout(250);
  ok((await objOf(p, id)).opts.seated === chair, 'undo puts them back on the chair');
  noErrors(p);
});

check('people: menu and toolbar Sit / Stand up; a sofa has three seats and the next person takes the next one', async ({ open }) => {
  const p = await open(); await p.waitForTimeout(300);
  const a = await placeAt(p, -1.5, 2), sofa = await addChair(p, 1, 0, 'sofa'); /* within the toolbar's 3 m reach */
  const b = await p.evaluate(() => window.__shotref.addPerson('woman', false, [-3, 0, 3]).id);
  await p.waitForTimeout(300);
  await p.evaluate(i => window.__shotref.select(i), a); await p.waitForTimeout(200);
  ok(await p.isVisible('#selBar [data-tip="Sit on the nearest seat"]'), 'toolbar Sit offered');
  await p.click('#selBar [data-tip="Sit on the nearest seat"]'); await p.waitForTimeout(300);
  let oa = await objOf(p, a);
  ok(oa.opts.seated === sofa && oa.opts.pose === 'sit', 'the toolbar sat them on the sofa');
  ok(await p.isVisible('#selBar [data-tip="Stand up"]'), 'now it offers Stand up');
  /* the menu on the sofa sits the selected person (the woman) in the next free seat */
  await p.evaluate(i => window.__shotref.select(i), b); await p.waitForTimeout(150);
  const sxy = await p.evaluate(() => window.__shotref.project(1, 0.3, -0.2));
  await p.mouse.click(...sxy, { button: 'right' }); await p.waitForTimeout(200);
  const labels = await menuLabels(p);
  ok(labels.some(l => l.startsWith('Sit Woman')), 'menu has Sit <person> here: ' + JSON.stringify(labels));
  await clickItem(p, 'Sit Woman'); await p.waitForTimeout(300);
  const ob = await objOf(p, b); oa = await objOf(p, a);
  ok(ob.opts.seated === sofa && Math.abs(ob.base.p[0] - oa.base.p[0]) > 0.4, 'a different seat on the sofa: ' + [oa.base.p[0], ob.base.p[0]]);
  /* Stand up from the menu */
  const bxy = await p.evaluate(q => window.__shotref.project(q[0], 0.7, q[1]), [ob.base.p[0], ob.base.p[2]]);
  await p.mouse.click(...bxy, { button: 'right' }); await p.waitForTimeout(200);
  ok((await menuLabels(p)).includes('Stand up'), 'a seated person has Stand up in the menu');
  await clickItem(p, 'Stand up'); await p.waitForTimeout(250);
  ok(!(await objOf(p, b)).opts.seated && (await objOf(p, b)).opts.pose === 'stand', 'stood up');
  /* deleting the sofa clears the seat link */
  await p.evaluate(i => { window.__shotref.select(i); }, sofa); await p.keyboard.press('Delete'); await p.waitForTimeout(250);
  ok(!(await objOf(p, a)).opts.seated, 'deleting the sofa leaves nobody "seated" on it');
  noErrors(p);
});

check('people: picking a pose at the playhead adds a blue action tag; drag retimes, right-click removes; blends over half a second', async ({ open }) => {
  const p = await open(); await p.waitForTimeout(400);
  const id = await idOfType(p, 'person'), xy = await starterXY(p);
  await p.mouse.click(...xy.person); await p.waitForTimeout(250);
  ok(await p.evaluate(() => /Pose for the whole shot/.test(document.querySelector('#props').textContent)), 'at 0 s the panel says Pose for the whole shot');
  await p.evaluate(() => window.__shotref.setT(2)); await p.keyboard.press('ArrowRight'); await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(250);
  ok(/Pose from 2\.00 s/.test(await p.textContent('#props')), 'at 2 s the panel says Pose from 2.00 s: ' + (await p.textContent('#props')).slice(0, 200));
  await p.click('#props .posegrid button:has-text("Wave")'); await p.waitForTimeout(300);
  let o = await objOf(p, id);
  ok(o.acts && o.acts.length === 1 && o.acts[0].pose === 'wave' && Math.abs(o.acts[0].t - 2) < 0.05 && o.opts.pose === 'stand', 'an action, not a new start pose: ' + JSON.stringify([o.acts, o.opts.pose]));
  ok(/Actions over time/.test(await p.textContent('#props')), 'the Actions over time list shows');
  const last = await p.evaluate(() => (window.__shotref.state.settings.duration * window.__shotref.state.settings.fps - 1) / window.__shotref.state.settings.fps);
  const tag = await p.evaluate(() => { const t = document.querySelector('#tlRows .lane .act'); return t ? { text: t.textContent, left: parseFloat(t.style.left) } : null; });
  ok(tag && tag.text === 'Wave' && Math.abs(tag.left - o.acts[0].t / last * 100) < 1, 'blue tag on the timeline: ' + JSON.stringify(tag));
  /* the pose follows time, with a blend */
  const before = await rigAt(p, id, 1.9), mid = await rigAt(p, id, o.acts[0].t + 0.2), full = await rigAt(p, id, 3);
  const d = r => Math.abs(r.rSh[1] - before.rSh[1]) + Math.abs(r.rSh[2] - before.rSh[2]) + Math.abs(r.rSh[0] - before.rSh[0]);
  ok(d(full) > 1 && d(mid) > 0.1 && d(mid) < d(full), 'blends: ' + [d(mid), d(full)].map(v => v.toFixed(2)));
  /* drag the tag to 4 s */
  const box = await p.evaluate(() => { const t = document.querySelector('#tlRows .lane .act').getBoundingClientRect(), l = document.querySelector('#tlRows .lane').getBoundingClientRect(); return { x: (t.left + t.right) / 2, y: (t.top + t.bottom) / 2, lx: l.left, w: l.width }; });
  await p.mouse.move(box.x, box.y); await p.mouse.down(); await p.mouse.move(box.x + 30, box.y, { steps: 4 }); await p.mouse.move(box.lx + box.w * (4 / last), box.y, { steps: 6 }); await p.mouse.up(); await p.waitForTimeout(300);
  o = await objOf(p, id);
  ok(Math.abs(o.acts[0].t - 4) < 0.1, 'retimed to about 4 s: ' + o.acts[0].t);
  ok(/pose change/.test(await undoTitle(p)), 'undo names it: ' + await undoTitle(p));
  /* right-click removes */
  await p.click('#tlRows .lane .act', { button: 'right' }); await p.waitForTimeout(250);
  o = await objOf(p, id);
  ok(!o.acts, 'right-click removed the tag, and acts is gone when empty');
  ok(await p.evaluate(() => !document.querySelector('#tlRows .lane .act')), 'tag gone');
  noErrors(p);
});

check('people: sitting as an action goes to the nearest seat; list edits, One pose for the whole shot, frame-rate change re-snaps', async ({ open }) => {
  const p = await open(); await p.waitForTimeout(300);
  await goAdvanced(p); /* the FPS box is an Advanced control */
  const id = await placeAt(p, 0.4, 0.2); await addChair(p, 1, 0.2);
  await p.evaluate(i => window.__shotref.select(i), id); await p.waitForTimeout(250);
  await p.evaluate(() => { window.__shotref.setT(2); }); await p.keyboard.press('ArrowRight'); await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(200);
  await p.click('#props .posegrid button:has-text("Sit")'); await p.waitForTimeout(250);
  let o = await objOf(p, id);
  ok(o.acts && o.acts[0].pose === 'sit' && o.acts[0].at && Math.abs(o.acts[0].at.p[0] - 1) < 0.01, 'sit action has the seat: ' + JSON.stringify(o.acts));
  const r1 = await rigAt(p, id, 1), r4 = await rigAt(p, id, 4);
  ok(Math.abs(r1.group.p[0] - 0.4) < 0.01 && Math.abs(r4.group.p[0] - 1) < 0.01, 'moves onto the chair by the action: ' + [r1.group.p[0], r4.group.p[0]]);
  /* edit from the list */
  await p.selectOption('#props .actrow select', 'wave'); await p.waitForTimeout(200);
  o = await objOf(p, id);
  ok(o.acts[0].pose === 'wave' && !o.acts[0].at, 'changing the action drops the seat');
  await p.click('#props button:has-text("One pose for the whole shot")'); await p.waitForTimeout(200);
  o = await objOf(p, id);
  ok(!o.acts && o.opts.pose === 'wave', 'collapsed into one pose: ' + JSON.stringify([o.acts, o.opts.pose]));
  /* frame rate change keeps the tag on a whole frame */
  await p.evaluate(() => { const S = window.__shotref; S.state.objects.find(x => x.type === 'person').acts = [{ t: 1.0, pose: 'point' }]; S.changed(true, true); });
  await p.selectOption('#inFps', '30'); await p.waitForTimeout(250);
  const t = (await objOf(p, id)).acts[0].t;
  ok(Math.abs(t * 30 - Math.round(t * 30)) < 1e-6 && Math.abs(t - 1) < 0.05, 'act time sits on a 30 fps frame: ' + t);
  noErrors(p);
});

check('people: Face the camera turns them and stops the path steering them (menu)', async ({ open }) => {
  const p = await open(); await p.waitForTimeout(400);
  const id = await placeAt(p, 0, 0); await setCamPos(p, [5, 1.6, 0]);
  ok((await objOf(p, id)).opts.faceTravel === true, 'starts with face-the-travel on');
  await p.waitForTimeout(300);
  const xy = await starterXY(p);
  await p.mouse.click(...xy.person, { button: 'right' }); await p.waitForTimeout(200);
  await clickItem(p, 'Face the camera'); await p.waitForTimeout(200);
  const o = await objOf(p, id);
  ok(Math.abs(o.base.r[1] - 90) < 1 && o.opts.faceTravel === false, 'faces +x, travel-steering off: ' + JSON.stringify([o.base.r, o.opts.faceTravel]));
  const r = await rigOf(p, id);
  ok(Math.abs(r.group.yaw - Math.PI / 2) < 0.02, 'and it shows');
  noErrors(p);
});

check('people: feet stay on the floor while walking, looking and changing pose (looking never moves the soles)', async ({ open }) => {
  const p = await open(); await p.waitForTimeout(300);
  const id = await placeAt(p, 0, 0);
  await p.evaluate(i => { const S = window.__shotref, o = S.state.objects.find(x => x.id === i); o.opts.pose = 'walk'; o.keys = [{ t: 0, p: [-2, 0, 0], r: [0, 90, 0], s: [1, 1, 1] }, { t: 3, p: [3, 0, 0], r: [0, 90, 0], s: [1, 1, 1] }]; o.acts = [{ t: 3.2, pose: 'wave' }]; S.changed(true, true); }, id);
  const soles = async t => p.evaluate(a => { const S = window.__shotref; S.setT(a[1]); S.applyAll(a[1]); return S.soles(a[0]); }, [id, t]);
  const times = [0, 0.4, 0.8, 1.2, 1.6, 2.0, 2.4, 2.8, 3.4];
  const off = []; for (const t of times) off.push(await soles(t));
  await p.evaluate(i => window.__shotref.setLookAt({ id: i }, 'camera'), id);
  for (let k = 0; k < times.length; k++) {
    const on = await soles(times[k]);
    on.forEach((s, j) => ok(Math.hypot(s[0] - off[k][j][0], s[1] - off[k][j][1], s[2] - off[k][j][2]) < 1e-4, 'looking moved a foot at ' + times[k] + ' s'));
    const low = Math.min(...on.map(s => s[1]));
    ok(low > -0.005 && low < 0.005, 'the lowest foot is on the floor at ' + times[k] + ' s: ' + low);
  }
  /* the stride still follows the distance walked: one cycle of the walk pose per 1.45 m, so the front foot lands again every cycle */
  const land = async t0 => { let best = 1e9, at = t0; for (let t = t0; t < t0 + 1.2; t += 0.01) { const s = await soles(t); const y = Math.min(s[0][1], s[1][1]); if (y < best) { best = y; at = t; } } return at; };
  const a1 = await land(0.5), a2 = await land(a1 + 0.3);
  ok(a2 > a1, 'a foot lands again later');
  noErrors(p);
});

check('people: exports and PNG frames show the changed poses and the eyeline', async ({ open, downloads }) => {
  const p = await open(); await p.waitForTimeout(300);
  const id = await placeAt(p, 0, 0); await setCamPos(p, [4, 1.6, 0]);
  await p.evaluate(i => { const S = window.__shotref, o = S.state.objects.find(x => x.id === i); o.acts = [{ t: 2, pose: 'wave' }]; o.opts.lookAt = 'camera'; S.state.settings.size = 640; S.changed(true, true); }, id);
  await p.evaluate(() => {
    window.__cap = []; const orig = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (cb, ...r) { const S = window.__shotref, o = S.state.objects.find(x => x.type === 'person'); window.__cap.push(S.rig(o.id)); return orig.call(this, cb, ...r); };
  });
  await p.evaluate(() => window.__shotref.exportPNG(0.5)); await downloads(p).wait('.png');
  await p.evaluate(() => window.__shotref.exportPNG(3.5)); await p.waitForTimeout(800);
  const cap = await p.evaluate(() => window.__cap);
  ok(cap.length >= 2, 'captured two frames: ' + cap.length);
  const d = Math.abs(cap[1].rSh[0] - cap[0].rSh[0]) + Math.abs(cap[1].rSh[1] - cap[0].rSh[1]) + Math.abs(cap[1].rSh[2] - cap[0].rSh[2]);
  ok(d > 1, 'the exported frame at 3.5 s has the wave pose: ' + d.toFixed(2));
  ok(Math.abs(cap[0].neck[1]) > 0.5 && Math.abs(cap[1].neck[1]) > 0.5, 'and the eyeline: ' + [cap[0].neck[1], cap[1].neck[1]].map(v => v.toFixed(2)));
  noErrors(p);
});

/* ---------------- Batch E: parenting, ground stacking, camera mount, car wheels and convertible, cactus ---------------- */
const SHOTS_DIR = process.env.SHOTREF_SHOTS || '';
const shotPng = (p, name) => SHOTS_DIR ? p.screenshot({ path: path.join(SHOTS_DIR, name) }) : null;
const near = (a, b, tol = 0.02) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
/* adds an object on the floor; extra fields are merged in (base, opts, parent, name...) */
const mkObj = (p, type, at, extra = {}) => p.evaluate(a => { const S = window.__shotref, o = S.addObject(a[0], null, false, a[1]); const e = a[2] || {}; for (const k of Object.keys(e)) { if (k === 'opts') Object.assign(o.opts, e.opts); else if (k === 'base') Object.assign(o.base, e.base); else o[k] = e[k]; } S.changed(true, true); return o.id; }, [type, at, extra]);
const worldP = (p, id, t = 0) => p.evaluate(a => window.__shotref.evalObj(window.__shotref.state.objects.find(o => o.id === a[0]), a[1]).p, [id, t]);
const viewOf = (p, id, t) => p.evaluate(a => { const S = window.__shotref; if (a[1] != null) S.setT(a[1]); S.applyAll(S.T); return S.viewOf(a[0]); }, [id, t == null ? null : t]);
const settle = (p, ms = 500) => p.waitForTimeout(ms);

check('parenting: a child rides on its parent: position, turn and the parent\'s own keys, in the data and in the view', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const car = await mkObj(p, 'box', [0, 0, 0], { base: { p: [2, 0, 0], r: [0, 90, 0], s: [1, 1, 1] } });
  const cup = await mkObj(p, 'ball', [0, 0, 0], { parent: car, base: { p: [0, 1, 1], r: [0, 0, 0], s: [1, 1, 1] }, opts: { free: true } });
  ok(near(await worldP(p, cup), [3, 1, 0]), 'a yaw of 90 degrees turns local +z into world +x: ' + await worldP(p, cup));
  let v = await viewOf(p, cup, 0);
  ok(near(v.p, [3, 1, 0]) && Math.abs(v.yaw - 90) < 0.5, 'the view shows it there and turned with the parent: ' + JSON.stringify([v.p, v.yaw]));
  await p.evaluate(i => { const S = window.__shotref, o = S.state.objects.find(x => x.id === i); o.keys = [{ t: 0, p: [2, 0, 0], r: [0, 90, 0], s: [1, 1, 1] }, { t: 2, p: [6, 0, 0], r: [0, 90, 0], s: [1, 1, 1] }]; S.changed(true, true); }, car);
  ok(near(await worldP(p, cup, 2), [7, 1, 0]) && near(await worldP(p, cup, 1), [5, 1, 0]), 'rides along the parent\'s move: ' + await worldP(p, cup, 1) + ' / ' + await worldP(p, cup, 2));
  v = await viewOf(p, cup, 2);
  ok(near(v.p, [7, 1, 0]), 'and the view follows at 2 s: ' + v.p);
  noErrors(p);
});

check('parenting: a child with its own keys moves relative to the parent; a parent that turns swings the child round', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const par = await mkObj(p, 'box', [0, 0, 0]);
  const kid = await mkObj(p, 'ball', [0, 0, 0], { parent: par, opts: { free: true } });
  await p.evaluate(a => { const S = window.__shotref, g = i => S.state.objects.find(x => x.id === i);
    g(a[0]).keys = [{ t: 0, p: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }, { t: 2, p: [0, 0, 0], r: [0, 180, 0], s: [1, 1, 1] }];
    g(a[1]).keys = [{ t: 0, p: [0, 1, 2], r: [0, 0, 0], s: [1, 1, 1] }, { t: 2, p: [0, 1, 2], r: [0, 0, 0], s: [1, 1, 1] }]; S.changed(true, true); }, [par, kid]);
  ok(near(await worldP(p, kid, 0), [0, 1, 2]), 'at 0 s the child is 2 m in front');
  ok(near(await worldP(p, kid, 2), [0, 1, -2], 0.05), 'the parent turned half way round, so the child is behind: ' + await worldP(p, kid, 2));
  noErrors(p);
});

check('parenting: Attach keeps the world pose, Detach keeps it too, and a parent loop is impossible', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const car = await mkObj(p, 'box', [0, 0, 0], { base: { p: [2, 0, 0], r: [0, 90, 0], s: [1, 1, 1] } });
  const cup = await mkObj(p, 'ball', [5, 0, 0], { opts: { free: true }, base: { p: [5, 0.5, 0], r: [0, 0, 0], s: [1, 1, 1] } });
  const before = await worldP(p, cup);
  ok(await p.evaluate(a => window.__shotref.attachTo(a[0], a[1]), [cup, car]) === true, 'attach says yes');
  let o = await objOf(p, cup);
  ok(o.parent === car && near(o.base.p, [0, 0.5, 3]) && Math.abs(o.base.r[1] + 90) < 0.5, 'stored relative to the parent: ' + JSON.stringify(o.base));
  ok(near(await worldP(p, cup), before), 'it did not jump');
  ok(await p.evaluate(a => window.__shotref.attachTo(a[0], a[1]), [car, cup]) === false && (await objOf(p, car)).parent == null, 'the parent cannot ride on its own child');
  ok(await p.evaluate(a => window.__shotref.attachTo(a[0], a[0]), [car]) === false, 'nor on itself');
  await p.evaluate(i => window.__shotref.attachTo(i, null), cup);
  o = await objOf(p, cup);
  ok(!o.parent && near(o.base.p, before) && Math.abs(o.base.r[1]) < 0.5, 'detached where it stood: ' + JSON.stringify(o.base));
  /* a moving parent: attaching converts every one of the child's keys against the parent at that key's time */
  await p.evaluate(a => { const S = window.__shotref, g = i => S.state.objects.find(x => x.id === i);
    g(a[1]).keys = [{ t: 0, p: [5, 0.5, 0], r: [0, 0, 0], s: [1, 1, 1] }, { t: 2, p: [5, 0.5, 0], r: [0, 0, 0], s: [1, 1, 1] }];
    g(a[0]).keys = [{ t: 0, p: [2, 0, 0], r: [0, 90, 0], s: [1, 1, 1] }, { t: 2, p: [4, 0, 0], r: [0, 90, 0], s: [1, 1, 1] }]; S.changed(true, true); S.attachTo(a[1], a[0]); }, [car, cup]);
  ok(near(await worldP(p, cup, 0), [5, 0.5, 0]) && near(await worldP(p, cup, 2), [5, 0.5, 0]), 'a child that stood still in the world still does, whatever the parent does: ' + await worldP(p, cup, 2));
  noErrors(p);
});

check('parenting: dragging and writes on a child are stored relative to the parent', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const car = await mkObj(p, 'box', [0, 0, 0], { base: { p: [2, 0, 0], r: [0, 90, 0], s: [1, 1, 1] } });
  const cup = await mkObj(p, 'ball', [0, 0, 0], { parent: car, opts: { free: true }, base: { p: [0, 1, 1], r: [0, 0, 0], s: [1, 1, 1] } });
  await p.evaluate(i => { const S = window.__shotref, o = S.state.objects.find(x => x.id === i); S.writeObj(o, { p: [5, 1, 0], r: [0, 0, 0], s: [1, 1, 1] }, true); }, cup);
  const o = await objOf(p, cup);
  ok(near(o.base.p, [0, 1, 3]) && Math.abs(o.base.r[1] + 90) < 0.5, 'a world pose written to a child is stored relative: ' + JSON.stringify(o.base));
  await p.evaluate(i => { const S = window.__shotref; S.select(i); S.setView('top'); }, cup); await settle(p, 300);
  const a = await proj3(p, 5, 1, 0), b = await proj3(p, 5, 1, 2);
  await p.mouse.move(...a); await p.mouse.down(); await p.mouse.move((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, { steps: 4 }); await p.mouse.move(...b, { steps: 4 }); await p.mouse.up(); await settle(p, 300);
  const w = await worldP(p, cup);
  ok(Math.abs(w[0] - 5) < 0.2 && Math.abs(w[2] - 2) < 0.2, 'dragged on to (5, 2) in the world: ' + w);
  ok((await objOf(p, cup)).parent === car, 'still riding on the parent');
  noErrors(p);
});

check('parenting: selecting a parent and its child moves them once, not twice', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const car = await mkObj(p, 'box', [0, 0, 0], { base: { p: [-1, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } });
  const cup = await mkObj(p, 'box', [0, 0, 0], { parent: car, opts: { free: true }, base: { p: [3, 0, 0], r: [0, 0, 0], s: [0.5, 0.5, 0.5] } });
  await p.evaluate(a => { const S = window.__shotref; S.setView('top'); S.select(a[0]); S.select(a[1], 'toggle'); }, [car, cup]); await settle(p, 300);
  const c0 = await worldP(p, car), k0 = await worldP(p, cup);
  const a = await proj3(p, -1, 0.5, 0), b = await proj3(p, -1, 0.5, 2);
  await p.mouse.move(...a); await p.mouse.down(); await p.mouse.move(...b, { steps: 6 }); await p.mouse.up(); await settle(p, 300);
  const c1 = await worldP(p, car), k1 = await worldP(p, cup);
  const dc = c1[2] - c0[2], dk = k1[2] - k0[2];
  ok(Math.abs(dc - 2) < 0.3 && Math.abs(dk - dc) < 0.05 && Math.abs(k1[0] - k0[0]) < 0.05, 'both moved the same amount: ' + JSON.stringify([dc, dk, k1[0] - k0[0]]));
  noErrors(p);
});

check('parenting: duplicating a parent and its child keeps the child on the copy; deleting a parent keeps the child where it stood', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const car = await mkObj(p, 'box', [0, 0, 0], { base: { p: [2, 0, 0], r: [0, 90, 0], s: [1, 1, 1] } });
  const cup = await mkObj(p, 'ball', [0, 0, 0], { parent: car, opts: { free: true }, base: { p: [0, 1, 1], r: [0, 0, 0], s: [1, 1, 1] } });
  await p.evaluate(a => { const S = window.__shotref; S.select(a[0]); S.select(a[1], 'toggle'); }, [car, cup]);
  await p.keyboard.press('Control+d'); await settle(p, 300);
  const st = await stateOf(p);
  const cc = st.objects.find(o => o.type === 'ball' && o.id !== cup), cb = cc && st.objects.find(o => o.id === cc.parent);
  ok(cc && cb && cb.id !== car && cb.type === 'box', 'the copied cup rides on the copied parent');
  ok(near(cc.base.p, [0, 1, 1]), 'its place in the parent did not get nudged: ' + cc.base.p);
  await p.evaluate(i => window.__shotref.select(i), car); await p.keyboard.press('Delete'); await settle(p, 300);
  const o = await objOf(p, cup);
  ok(!o.parent && near(o.base.p, [3, 1, 0]) && Math.abs(o.base.r[1] - 90) < 0.5, 'the child stayed where it was in the world: ' + JSON.stringify([o.parent, o.base]));
  noErrors(p);
});

check('parenting: the panel has Ride with (no loops offered), the scene list shows the parent tag, undo takes it back', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const car = await mkObj(p, 'box', [0, 0, 0], { name: 'Truck' });
  const cup = await mkObj(p, 'ball', [0, 0, 0], { name: 'Mug', opts: { free: true } });
  await p.evaluate(i => window.__shotref.select(i), cup); await settle(p, 300);
  ok(/Attach/.test(await p.textContent('#props')), 'the object panel has an Attach section');
  await p.selectOption('#props select[data-role="ride"]', car); await settle(p, 300);
  ok((await objOf(p, cup)).parent === car, 'Ride with Truck sets the parent');
  await p.click('#leftTabs [data-lt="scene"]'); await settle(p, 200);
  const tag = await p.evaluate(i => { const r = document.querySelector('.ol[data-id="' + i + '"] .ptag'); return r ? r.textContent : null; }, cup);
  ok(tag && /Truck/.test(tag), 'the scene row says it rides with the truck: ' + tag);
  await p.evaluate(i => window.__shotref.select(i), car); await settle(p, 300);
  const opts = await p.evaluate(() => [...document.querySelectorAll('#props select[data-role="ride"] option')].map(o => o.textContent));
  ok(opts.length > 1 && !opts.includes('Mug'), 'the truck cannot ride with its own passenger: ' + JSON.stringify(opts));
  await p.click('#bUndo'); await settle(p, 300);
  ok(!(await objOf(p, cup)).parent, 'undo detached the mug');
  noErrors(p);
});

check('parenting: right-click Attach to what is underneath, then Detach', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const table = await mkObj(p, 'table', [0, 0, 0]);
  const cup = await mkObj(p, 'ball', [0, 0, 0], { base: { p: [0.2, 0.77, 0.1], r: [0, 0, 0], s: [1, 1, 1] } });
  await p.evaluate(i => { const S = window.__shotref; S.select(i); }, cup); await settle(p, 300);
  const xy = await proj3(p, 0.2, 0.88, 0.1);
  await rightClick(p, ...xy); await settle(p, 200);
  let labels = await menuLabels(p);
  ok(labels && labels.some(l => /^Attach to Table 1/.test(l)), 'menu offers Attach to the table: ' + JSON.stringify(labels));
  await clickItem(p, 'Attach to Table 1'); await settle(p, 200);
  ok((await objOf(p, cup)).parent === table, 'attached to the table');
  await rightClick(p, ...xy); await settle(p, 200);
  labels = await menuLabels(p);
  ok(labels && labels.some(l => /^Detach from Table 1/.test(l)), 'menu offers Detach: ' + JSON.stringify(labels));
  await clickItem(p, 'Detach from'); await settle(p, 200);
  ok(!(await objOf(p, cup)).parent, 'detached');
  noErrors(p);
});

check('ground: dragging a cup onto a table puts it on top; it drops again when the table goes; Can float keeps it in the air', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const table = await mkObj(p, 'table', [0, 0, 0]);
  const cup = await mkObj(p, 'ball', [2, 0, 2]);
  await p.evaluate(i => { const S = window.__shotref; S.select(i); }, cup); await settle(p, 300);
  const a = await proj3(p, 2, 0.11, 2), b = await proj3(p, 0.1, 0.77, 0);
  await p.mouse.move(...a); await p.mouse.down(); await p.mouse.move(a[0] + (b[0] - a[0]) / 2, a[1] + (b[1] - a[1]) / 2, { steps: 4 }); await p.mouse.move(...b, { steps: 6 });
  await settle(p, 200);
  ok(/On top of something/.test(await p.textContent('#modeBar')), 'the hint says it is on top: ' + await p.textContent('#modeBar'));
  await p.mouse.up(); await settle(p, 500);
  let o = await objOf(p, cup);
  ok(Math.abs(o.base.p[1] - 0.77) < 0.03, 'resting on the table top (0.77 m): ' + o.base.p);
  await shotPng(p, 'e-ground-cup-on-table.png');
  /* nothing under it any more: it falls to the floor on the next change */
  await p.evaluate(i => { const S = window.__shotref, t = S.state.objects.find(x => x.id === i); t.base.p = [8, 0, 8]; S.changed(true, true); }, table); await settle(p, 500);
  o = await objOf(p, cup);
  ok(Math.abs(o.base.p[1]) < 0.02, 'back on the floor: ' + o.base.p);
  await p.evaluate(i => { const S = window.__shotref; S.select(i); }, cup); await settle(p, 300);
  await p.click('#props label:has-text("Can float")'); await settle(p, 300);
  ok((await objOf(p, cup)).opts.free === true, 'Can float ticked');
  await p.evaluate(i => { const S = window.__shotref, c = S.state.objects.find(x => x.id === i); c.base.p = [2, 3, 2]; S.changed(true, true); }, cup); await settle(p, 500);
  ok(Math.abs((await objOf(p, cup)).base.p[1] - 3) < 0.01, 'a floating item stays up');
  await p.click('#props label:has-text("Can float")'); await settle(p, 600);
  ok(Math.abs((await objOf(p, cup)).base.p[1]) < 0.02, 'switching it off drops it to the floor');
  noErrors(p);
});

check('ground: people ignore tables but stand on stairs; the preference "ground" switches the whole rule off', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await mkObj(p, 'table', [4, 0, 4]);
  const man = await p.evaluate(() => window.__shotref.addPerson('man', false, [4, 0, 4]).id);
  await mkObj(p, 'stairs', [-4, 0, 4]);
  const man2 = await p.evaluate(() => window.__shotref.addPerson('man', false, [-4, 0, 4]).id);
  await settle(p, 600);
  ok(Math.abs((await objOf(p, man)).base.p[1]) < 0.02, 'a person at a table is not lifted onto it');
  const y2 = (await objOf(p, man2)).base.p[1];
  ok(Math.abs(y2 - 0.18) < 0.04, 'a person on the first stair stands on it: ' + y2);
  await p.evaluate(() => { const S = window.__shotref; S.setPref('ground', false); const o = S.state.objects.find(x => x.type === 'box'); o.base.p = [o.base.p[0], 2, o.base.p[2]]; S.changed(true, true); }); await settle(p, 500);
  ok(await p.evaluate(() => Math.abs(window.__shotref.state.objects.find(x => x.type === 'box').base.p[1] - 2) < 0.01), 'with the rule off nothing is moved');
  noErrors(p);
});

check('ground: the green lift arrow raises a floating item; a grounded item has none; Drop to floor is in the menu', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const cup = await mkObj(p, 'box', [2, 0, 2], { opts: { free: true }, base: { p: [2, 1, 2], r: [0, 0, 0], s: [1, 1, 1] } });
  await p.evaluate(i => window.__shotref.select(i), cup); await settle(p, 400);
  const k = await p.evaluate(() => window.__shotref.liftKnob());
  ok(k && k.length === 2, 'a floating item shows the lift arrow');
  await shotPng(p, 'e-lift-arrow.png');
  await p.mouse.move(...k); await p.mouse.down(); await p.mouse.move(k[0], k[1] - 25, { steps: 4 }); await p.mouse.move(k[0], k[1] - 60, { steps: 4 }); await p.mouse.up(); await settle(p, 300);
  const y = (await objOf(p, cup)).base.p[1];
  ok(y > 1.3, 'raised by the arrow: ' + y);
  const xy = await proj3(p, 2, y + 0.5, 2);
  await rightClick(p, ...xy); await settle(p, 200);
  const labels = await menuLabels(p);
  ok(labels && labels.includes('Drop to floor'), 'a floating item has Drop to floor in the menu: ' + JSON.stringify(labels));
  await clickItem(p, 'Drop to floor'); await settle(p, 400);
  ok(Math.abs((await objOf(p, cup)).base.p[1]) < 0.02, 'dropped');
  await p.evaluate(i => { const o = window.__shotref.state.objects.find(x => x.id === i); o.opts.free = false; window.__shotref.select(i); window.__shotref.changed(true, true); }, cup); await settle(p, 500);
  ok(await p.evaluate(() => window.__shotref.liftKnob()) === null, 'a grounded item has no lift arrow');
  noErrors(p);
});

check('mount: the camera rides on an object; its own moves apply on top; unmounting keeps the framing; deleting the object frees it', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const car = await mkObj(p, 'car', [0, 0, 0]);
  await p.evaluate(i => { const S = window.__shotref, o = S.state.objects.find(x => x.id === i); o.keys = [{ t: 0, p: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }, { t: 4, p: [6, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }]; S.state.camera.base = { p: [3, 1.6, 6], tg: [0, 1, 0], f: 35, roll: 0, fd: 7 }; S.state.camera.keys = []; S.changed(true, true); S.setT(0); }, car);
  const c0 = await p.evaluate(() => window.__shotref.evalCam(0));
  await p.evaluate(i => window.__shotref.setMount(i), car);
  ok((await stateOf(p)).camera.mount === car, 'camera.mount is saved');
  ok(near(await p.evaluate(() => window.__shotref.evalCam(0).p), c0.p), 'mounting does not move the camera');
  const c4 = await p.evaluate(() => window.__shotref.evalCam(4));
  ok(near(c4.p, [c0.p[0] + 6, c0.p[1], c0.p[2]]) && near(c4.tg, [c0.tg[0] + 6, c0.tg[1], c0.tg[2]]), 'the camera and its aim ride 6 m along with the car: ' + JSON.stringify(c4));
  await p.evaluate(() => { const S = window.__shotref; S.setT(2); S.writeCam({ p: [5, 3, 6] }, true); });
  const st = await stateOf(p);
  ok(near(st.camera.base.p, [2, 3, 6], 0.05), 'a world position written to the camera is stored relative to the car: ' + JSON.stringify(st.camera.base.p));
  { const w = await p.evaluate(() => ({ p: window.__shotref.evalCam(2).p, T: window.__shotref.T, base: window.__shotref.state.camera.base.p })); ok(near(w.p, [5, 3, 6], 0.05), 'and it shows where it was put: ' + JSON.stringify(w)); }
  const here = await p.evaluate(() => window.__shotref.evalCam(window.__shotref.T));
  await p.evaluate(() => window.__shotref.setMount(null));
  ok((await stateOf(p)).camera.mount === null && near(await p.evaluate(() => window.__shotref.evalCam(window.__shotref.T).p), here.p), 'unmounting leaves the camera where it is');
  await p.evaluate(i => window.__shotref.setMount(i), car);
  await p.evaluate(i => { window.__shotref.select(i); }, car); await p.keyboard.press('Delete'); await settle(p, 300);
  ok((await stateOf(p)).camera.mount === null, 'deleting the object frees the camera');
  noErrors(p);
});

check('mount: the Camera panel has Mount on; the object menu can mount the camera too', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const car = await mkObj(p, 'car', [0, 0, 0], { name: 'Taxi' });
  await p.evaluate(() => { window.__shotref.setPref('camTab', 'shot'); window.__shotref.select('camera'); }); await settle(p, 300); /* Mount is on the Shot tab (batch F) */
  ok(/Mount/.test(await p.textContent('#props')), 'the camera panel has a Mount section');
  await p.selectOption('#props select[data-role="mount"]', car); await settle(p, 300);
  ok((await stateOf(p)).camera.mount === car, 'Mount on Taxi');
  await p.evaluate(i => { const S = window.__shotref; S.setMount(null); S.select(i); S.setView('editor'); }, car); await settle(p, 300);
  const xy = await proj3(p, 0, 0.9, 0);
  await rightClick(p, ...xy); await settle(p, 200);
  const labels = await menuLabels(p);
  ok(labels && labels.some(l => /^Mount the camera on this/.test(l)), 'menu: ' + JSON.stringify(labels));
  await clickItem(p, 'Mount the camera on this'); await settle(p, 200);
  ok((await stateOf(p)).camera.mount === car, 'mounted from the menu');
  noErrors(p);
});

check('cars: a convertible has two seats and an open top; sitting in it makes the person ride along; standing up detaches', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const man = await p.evaluate(() => window.__shotref.state.objects.find(o => o.type === 'person').id);
  const car = await mkObj(p, 'car', [3, 0, 3], { name: 'Roadster' });
  await p.evaluate(i => { const S = window.__shotref; S.select(i); }, car); await settle(p, 300);
  ok(/Convertible \(open top\)/.test(await p.textContent('#props')), 'the car panel offers Convertible (open top)');
  ok(await p.evaluate(() => window.__shotref.nearestSeat(3.4, 2.72, null, 1)) === null, 'a closed car has no seats');
  await p.click('#props label:has-text("Convertible")'); await settle(p, 300);
  ok((await objOf(p, car)).opts.convertible === true, 'convertible on');
  const seat = await p.evaluate(() => window.__shotref.nearestSeat(3.4, 2.72, null, 1));
  ok(seat && Math.abs(seat.w.x - 3.4) < 0.05 && Math.abs(seat.w.z - 2.72) < 0.05 && Math.abs(seat.w.top - 1.1) < 0.01, 'front-left seat: ' + JSON.stringify(seat && seat.w));
  await shotPng(p, 'e-convertible.png');
  await p.evaluate(a => { const S = window.__shotref, c = S.state.objects.find(x => x.id === a[1]), m = S.state.objects.find(x => x.id === a[0]); m.keys = []; S.sitPerson(m, S.freeSeat(c, m)); }, [man, car]);
  let o = await objOf(p, man);
  ok(o.parent === car && o.opts.seated === car && o.opts.pose === 'sit', 'sitting in a car attaches: ' + JSON.stringify([o.parent, o.opts.seated, o.opts.pose]));
  const w0 = await worldP(p, man);
  await p.evaluate(i => { const S = window.__shotref, c = S.state.objects.find(x => x.id === i); c.keys = [{ t: 0, p: [3, 0, 3], r: [0, 0, 0], s: [1, 1, 1] }, { t: 3, p: [9, 0, 3], r: [0, 0, 0], s: [1, 1, 1] }]; S.changed(true, true); }, car);
  const w3 = await worldP(p, man, 3);
  ok(near(w3, [w0[0] + 6, w0[1], w0[2]], 0.05), 'the driver rides 6 m with the car: ' + w0 + ' -> ' + w3);
  await p.evaluate(i => { const S = window.__shotref; S.setT(3); S.standPerson(S.state.objects.find(x => x.id === i)); }, man);
  o = await objOf(p, man);
  ok(!o.parent && !o.opts.seated && o.opts.pose === 'stand', 'stood up and left the car');
  ok(near(await worldP(p, man, 3), [w3[0], 0, w3[2]], 0.05), 'on the spot where the car was: ' + await worldP(p, man, 3));
  noErrors(p);
});

check('cars: the right-click menu offers "Sit <person> here" on a convertible but not on a closed car', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const car = await mkObj(p, 'car', [3, 0, 3]);
  await p.evaluate(i => window.__shotref.select(i), car); await settle(p, 300);
  const xy = await proj3(p, 3, 0.6, 3);
  await rightClick(p, ...xy); await settle(p, 200);
  ok(!(await menuLabels(p)).some(l => /^Sit /.test(l)), 'a closed car has no Sit item');
  await p.keyboard.press('Escape');
  await p.evaluate(i => { const S = window.__shotref; S.state.objects.find(x => x.id === i).opts.convertible = true; S.changed(true, true); }, car); await settle(p, 300);
  await rightClick(p, ...xy); await settle(p, 200);
  ok((await menuLabels(p)).some(l => /^Sit /.test(l)), 'a convertible has Sit here');
  noErrors(p);
});

check('cars: wheels roll with the distance driven and the front wheels steer into a curve', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const car = await mkObj(p, 'car', [0, 0, 0]);
  await p.evaluate(i => { const S = window.__shotref, c = S.state.objects.find(x => x.id === i); c.opts.faceTravel = true;
    c.keys = [{ t: 0, p: [0, 0, 0], r: [0, 90, 0], s: [1, 1, 1] }, { t: 1.5, p: [4, 0, 0], r: [0, 90, 0], s: [1, 1, 1] }, { t: 3, p: [8, 0, 0], r: [0, 90, 0], s: [1, 1, 1] }, { t: 4.5, p: [11, 0, 3], r: [0, 90, 0], s: [1, 1, 1] }]; S.changed(true, true); }, car);
  const v0 = await viewOf(p, car, 0), v1 = await viewOf(p, car, 1.5), v2 = await viewOf(p, car, 0.8);
  ok(v0.wheels && v0.wheels.length === 4 && v0.wheels.filter(w => w.front).length === 2, 'four wheels, two of them front');
  ok(Math.abs(v0.wheels[0].spin) < 1e-6, 'not turned at the start');
  ok(Math.abs(v1.wheels[0].spin - 4 / 0.36) < 0.5, 'rolled 4 m / 0.36 m radius = 11.1 rad: ' + v1.wheels[0].spin);
  ok(v2.wheels.every(w => Math.abs(w.steer) < 0.05) && Math.abs(v1.wheels[0].steer) < 0.05, 'straight on, the wheels point ahead');
  const v3 = await viewOf(p, car, 3.6);
  ok(v3.wheels.filter(w => w.front).every(w => Math.abs(w.steer) > 0.05) && v3.wheels.filter(w => !w.front).every(w => Math.abs(w.steer) < 1e-6), 'in the bend only the front wheels steer: ' + JSON.stringify(v3.wheels.map(w => [w.front, +w.steer.toFixed(3)])));
  noErrors(p);
});

check('cactus: a Cactus tile in Props adds a cactus that renders', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const tile = await p.evaluate(() => [...document.querySelectorAll('#addArea .tile')].map(b => b.textContent.trim()));
  ok(tile.includes('Cactus'), 'Props has Cactus: ' + JSON.stringify(tile));
  const id = await p.evaluate(() => window.__shotref.addObject('cactus', null, false, [0, 0, -3]).id);
  await settle(p, 300);
  const v = await p.evaluate(i => { const S = window.__shotref; S.applyAll(0); return S.viewOf(i); }, id);
  ok(v && v.size && v.size[1] > 1.5 && v.size[0] > 0.3, 'a tall shape: ' + JSON.stringify(v && v.size));
  ok((await objOf(p, id)).color === '#6f8a52', 'cactus green');
  noErrors(p);
});

check('sitting: the toolbar Sit reaches seats within 3 m, otherwise a plain message; a sit action is stored relative to a parent', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const man = await placeAt(p, -6, 2); const sofa = await addChair(p, 1, 0, 'sofa');
  await p.evaluate(i => window.__shotref.select(i), man); await settle(p, 300);
  ok(await p.isVisible('#selBar [data-tip="Sit on the nearest seat"]'), 'the Sit button is there');
  await p.click('#selBar [data-tip="Sit on the nearest seat"]'); await settle(p, 300);
  ok(!(await objOf(p, man)).opts.seated, 'a seat 7 m away is not used');
  ok(/3 m/.test(await p.textContent('#toast')), 'a plain message says why: ' + await p.textContent('#toast'));
  await placeAt(p, -2.5, 0); await p.evaluate(i => { window.__shotref.select(null); window.__shotref.select(i); }, man); await settle(p, 300);
  await p.click('#selBar [data-tip="Sit on the nearest seat"]'); await settle(p, 300);
  ok((await objOf(p, man)).opts.seated === sofa, 'a seat 2 m away is used');
  const plat = await mkObj(p, 'box', [0, 0, 0], { base: { p: [10, 0, 0], r: [0, 90, 0], s: [1, 1, 1] } });
  await mkObj(p, 'sofa', [0, 0, 0], { parent: plat, base: { p: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } });
  const girl = await p.evaluate(a => { const S = window.__shotref, g = S.addPerson('woman', false, [0, 0, 0]); g.parent = a; g.base = { p: [0.2, 0, 0.8], r: [0, 0, 0], s: [1, 1, 1] }; S.changed(true, true); return g.id; }, plat);
  await settle(p, 400);
  await p.evaluate(i => { window.__shotref.setPoseAt(window.__shotref.state.objects.find(x => x.id === i), 'sit', 1); }, girl);
  const og = await objOf(p, girl);
  ok(og.acts && og.acts[0].at && Math.abs(og.acts[0].at.p[0]) < 2 && Math.abs(og.acts[0].at.p[2]) < 2, 'the stored seat is in the platform\'s frame (near 0,0), not the world (near 10): ' + JSON.stringify(og.acts && og.acts[0].at));
  const sh = await p.evaluate(i => window.__shotref.shownObj(i, 2).p, girl);
  ok(Math.abs(sh[0] - 10.06) < 0.3 && Math.abs(sh[2]) < 0.3, 'and she sits on the sofa in the world: ' + sh);
  noErrors(p);
});

check('eyeline and seats read the world pose of things that ride on a parent', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const man = await placeAt(p, 0, 0);
  const plat = await mkObj(p, 'box', [0, 0, 0], { base: { p: [10, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } });
  const ball = await mkObj(p, 'ball', [0, 0, 0], { parent: plat, opts: { free: true }, base: { p: [0, 1, 0], r: [0, 0, 0], s: [1, 1, 1] } });
  await p.evaluate(a => { const S = window.__shotref; S.setLookAt(S.state.objects.find(x => x.id === a[0]), a[1]); }, [man, ball]);
  const r = await rigOf(p, man);
  ok(r.neck[1] > 0.5, 'the head turned toward the ball 10 m to the right (world), not toward the local origin: ' + r.neck[1]);
  await mkObj(p, 'sofa', [0, 0, 0], { parent: plat, base: { p: [0, 0, 0], r: [0, 90, 0], s: [1, 1, 1] } });
  const seat = await p.evaluate(() => window.__shotref.nearestSeat(10.06, 0.55, null, 0.4));
  ok(seat && Math.abs(seat.w.yaw - 90) < 1, 'a seat on a parented, turned sofa is found in the world: ' + JSON.stringify(seat && seat.w));
  noErrors(p);
});

check('artifact files: parent, free, mount and convertible shapes open and render like the artifact', async ({ open, fixtures }) => {
  const p = await open(); await settle(p, 300);
  const txt = fs.readFileSync(path.join(fixtures, 'artifact-ride.shotref.json'), 'utf8');
  await openFile(p, 'artifact-ride.shotref.json', txt);
  await p.waitForFunction(() => window.__shotref.state.objects.length >= 7); await settle(p, 800);
  const st = await stateOf(p), by = n => st.objects.find(o => o.name === n);
  ok(st.camera.mount === by('Roadster').id, 'camera mount kept');
  ok(by('Driver').parent === by('Roadster').id && by('Driver').opts.seated === by('Roadster').id, 'the driver rides in the roadster');
  ok(by('Drone').opts.free === true && Math.abs(by('Drone').base.p[1] - 4) < 0.01, 'a floating drone stays up (Can float): ' + by('Drone').base.p);
  ok(Math.abs(by('Cup').base.p[1] - 0.77) < 0.03, 'the cup rests on the table: ' + by('Cup').base.p);
  ok(Math.abs(by('Crate').base.p[1] - 2) < 0.01 && by('Crate').opts.free === true, 'a crate saved in the air stays there and becomes Can float (opening never moves things): ' + by('Crate').base.p);
  const dw = await p.evaluate(i => { const S = window.__shotref; S.setT(2); S.applyAll(2); return S.viewOf(i).p; }, by('Driver').id);
  ok(near(dw, [5.72, 0.726, -0.4], 0.05), 'the driver is in the seat of the moving car at 2 s (car at 6,0,0 turned 90): ' + dw);
  const cam = await p.evaluate(() => window.__shotref.evalCam(2));
  ok(near(cam.p, [10, 1.5, 3], 0.05), 'the mounted camera is with the car: ' + cam.p);
  ok(await p.evaluate(i => window.__shotref.viewOf(i).wheels.length, by('Roadster').id) === 4, 'the wheels are built');
  await p.evaluate(() => { window.__shotref.setT(2); window.__shotref.setView('editor'); }); await settle(p, 500);
  await shotPng(p, 'e-fixture-editor.png');
  await p.evaluate(() => { window.__shotref.setView('camera'); }); await settle(p, 500);
  await shotPng(p, 'e-fixture-camera.png');
  noErrors(p);
});

check('artifact files: the Desert overlook cast (woman, convertible, cacti) opens and renders', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const file = { app: 'ShotRef', version: 1, state: { v: 1, settings: { env: 'custom', sky: '#c9c2a2', groundColor: '#bf9168' }, camera: { base: { p: [-0.97, 6.55, 32.7], tg: [-0.97, 4.3, -0.24], f: 60, roll: 0, fd: 33.2 }, keys: [] }, objects: [
    { id: 'w', type: 'person', name: 'Woman', color: '#c4566c', opts: { pose: 'stand', height: 1.65, body: 'woman', faceTravel: true }, base: { p: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }, keys: [], visible: true },
    { id: 'c', type: 'car', name: 'Convertible', color: '#b3262b', opts: { convertible: true }, base: { p: [-2.7, 0, 0.276], r: [0, 0, 0], s: [1, 1, 1] }, keys: [], visible: true },
    { id: 'k1', type: 'cactus', name: 'Saguaro', color: '#6f8a52', opts: {}, base: { p: [-4.978, 0, -6.058], r: [0, 0, 0], s: [1, 1, 1] }, keys: [], visible: true },
    { id: 'k2', type: 'cactus', name: 'Small cactus', color: '#6f8a52', opts: {}, base: { p: [8.367, 0, -0.857], r: [0, 0, 0], s: [0.5, 0.5, 0.5] }, keys: [], visible: true }] }, assets: {} };
  await openFile(p, 'desert.shotref.json', JSON.stringify(file));
  await p.waitForFunction(() => window.__shotref.state.objects.length === 4); await settle(p, 600);
  const k = await p.evaluate(() => { const S = window.__shotref; S.applyAll(0); return [S.viewOf('k1').size, S.viewOf('k2').size]; });
  ok(k[0][1] > 5 && Math.abs(k[1][1] / k[0][1] - 0.5) < 0.05, 'cacti are tall and the small one is half: ' + JSON.stringify(k));
  await p.evaluate(() => window.__shotref.setView('camera')); await settle(p, 500);
  await shotPng(p, 'e-desert-cast.png');
  noErrors(p);
});

/* ---------------- Batch E fix round 1: opening never moves anything; ground switch; late models; timing ---------------- */
const OLD_RAISED = () => {
  const O = (id, type, p, extra = {}) => ({ id, type, name: id, color: '#cccccc', base: { p, r: [0, 0, 0], s: [1, 1, 1] }, keys: [], opts: {}, visible: true, ...extra });
  const ball = O('ball1', 'ball', [1, 3, 1], { keys: [{ t: 0, p: [1, 3, 1], r: [0, 0, 0], s: [1, 1, 1] }, { t: 2, p: [4, 2.5, 1], r: [0, 0, 0], s: [1, 1, 1] }] });
  return { app: 'ShotRef', version: 2, state: { v: 2, settings: { duration: 5, fps: 24 }, camera: { base: JSON.parse(CAM_BASE), keys: [] }, objects: [O('crate1', 'box', [-2, 2, 0]), ball, O('rest1', 'box', [5, 0, 5])] }, assets: {} };
};
const keysOf = st => st.objects.map(o => JSON.stringify([o.id, o.base.p, o.keys.map(k => [k.t, k.p])]));

check('opening an old file never moves anything: a raised crate and a y-keyed ball stay where they were (Can float), and Undo still reaches the old scene', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const file = OLD_RAISED();
  const before = keysOf(file.state);
  await openFile(p, 'old.shotref', JSON.stringify(file));
  await p.waitForFunction(() => window.__shotref.state.objects.some(o => o.id === 'crate1')); await settle(p, 900);
  const st = await stateOf(p);
  ok(JSON.stringify(keysOf(st)) === JSON.stringify(before), 'positions and keys identical: ' + JSON.stringify(keysOf(st)));
  ok(st.objects.find(o => o.id === 'crate1').opts.free === true && st.objects.find(o => o.id === 'ball1').opts.free === true, 'the raised ones are Can float');
  ok(!st.objects.find(o => o.id === 'rest1').opts.free, 'one resting on the floor is left alone');
  await p.click('#bUndo'); await settle(p, 300);
  ok((await p.evaluate(() => window.__shotref.state.objects.length)) === 3 && !(await p.evaluate(() => window.__shotref.state.objects.some(o => o.id === 'crate1'))), 'Undo goes back to the scene before Open');
  await p.click('#bRedo'); await settle(p, 300);
  ok(JSON.stringify(keysOf(await stateOf(p))) === JSON.stringify(before), 'Redo brings the opened file back unchanged');
  noErrors(p);
});

check('restoring an autosave at start never moves anything either', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const file = OLD_RAISED(), before = keysOf(file.state);
  await p.evaluate(s => localStorage.setItem('shotref.autosave', JSON.stringify({ state: s, assets: {}, assetIds: [], v: 2 })), file.state);
  await p.reload(); await p.waitForFunction(() => window.__shotref && window.__shotref.state); await settle(p, 1000);
  const st = await stateOf(p);
  ok(st.objects.some(o => o.id === 'crate1'), 'the autosave was restored');
  ok(JSON.stringify(keysOf(st)) === JSON.stringify(before), 'positions and keys identical: ' + JSON.stringify(keysOf(st)));
  ok(st.objects.find(o => o.id === 'crate1').opts.free === true, 'raised items came up as Can float');
  noErrors(p);
});

check('gear menu: "Keep things on the ground" switches the rule; switching on moves nothing', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.click('#bMenu');
  ok(await p.evaluate(() => { const b = document.querySelector('#ctxMenu [data-cmd="ground"]'); return !!b && b.getAttribute('aria-checked') === 'true'; }), 'on by default, with a tick');
  await p.click('#ctxMenu [data-cmd="ground"]'); await settle(p, 200);
  ok(await p.evaluate(() => window.__shotref.getPref('ground', true)) === false, 'switched off');
  const id = await mkObj(p, 'box', [3, 0, 3], { base: { p: [3, 2, 3], r: [0, 0, 0], s: [1, 1, 1] } }); await settle(p, 400);
  ok(Math.abs((await objOf(p, id)).base.p[1] - 2) < 0.001, 'off: nothing is dropped');
  await gearCmd(p, 'ground'); await settle(p, 700);
  const o = await objOf(p, id);
  ok(Math.abs(o.base.p[1] - 2) < 0.001 && o.opts.free === true, 'switching on leaves the raised box where it is, as Can float: ' + JSON.stringify([o.base.p, o.opts]));
  noErrors(p);
});

check('models: a raised model in an opened file stays put (Can float) once it has loaded, and every item gets checked', async ({ open, fixtures }) => {
  const p = await open(); await settle(p, 300);
  const b64 = fs.readFileSync(path.join(fixtures, 'cube.glb')).toString('base64');
  const file = { app: 'ShotRef', version: 2, state: { v: 2, settings: { duration: 5, fps: 24 }, camera: { base: JSON.parse(CAM_BASE), keys: [] }, objects: [
    { id: 'mod1', type: 'model', name: 'Cube', color: '#ffffff', asset: 'a1', base: { p: [0, 3, 0], r: [0, 0, 0], s: [1, 1, 1] }, keys: [], opts: {}, visible: true },
    { id: 'lo1', type: 'ball', name: 'Lo', color: '#ffffff', base: { p: [6, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }, keys: [], opts: {}, visible: true }] }, assets: { a1: { kind: 'model', name: 'cube.glb', b64, mime: 'model/gltf-binary' } } };
  await openFile(p, 'm.shotref', JSON.stringify(file));
  await p.waitForFunction(() => window.__shotref.state.objects.some(o => o.id === 'mod1')); await settle(p, 1500);
  const st = await stateOf(p), m = st.objects.find(o => o.id === 'mod1');
  ok(Math.abs(m.base.p[1] - 3) < 1e-6 && m.opts.free === true, 'the raised model keeps its height and becomes Can float: ' + JSON.stringify([m.base.p, m.opts]));
  ok(await p.evaluate(() => window.__shotref.groundMigrate()) === 0, 'every item was checked once the model had loaded');
  noErrors(p);
});

check('models: a model imported after the first frame is rested on its real bounds, not on the placeholder', async ({ open, fixtures }) => {
  const p = await open(); await settle(p, 400);
  await p.setInputFiles('#fModel', path.join(fixtures, 'cube.glb')); await settle(p, 1200);
  await p.mouse.click(700, 500); await settle(p, 300); /* click to place it */
  const id = await p.evaluate(() => window.__shotref.state.objects.find(o => o.type === 'model').id);
  await p.evaluate(i => { const S = window.__shotref; S.state.objects.find(o => o.id === i).base.p = [0, 0.4, 0]; S.changed(true, true); }, id); await settle(p, 600);
  ok(Math.abs((await objOf(p, id)).base.p[1]) < 0.02, 'a loaded model rests on the floor: ' + (await objOf(p, id)).base.p);
  noErrors(p);
});

check('timing: settling 123 objects after an edit takes under 20 ms', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => { const S = window.__shotref; for (let i = 0; i < 120; i++) { const o = S.addObject(i % 3 === 0 ? 'table' : i % 3 === 1 ? 'chair' : 'box', null, false, [(i % 12) * 2 - 12, 0, Math.floor(i / 12) * 2 - 10]); if (i % 4 === 0) o.keys = [0, 1, 2, 3].map(t => ({ t, p: [o.base.p[0] + t * 0.1, 0, o.base.p[2]], r: [0, 0, 0], s: [1, 1, 1] })); } S.changed(true, true); });
  await settle(p, 800);
  const ts = []; for (let i = 0; i < 5; i++) ts.push(await p.evaluate(() => window.__shotref.settleTime()));
  console.log('   settle time for ' + (await p.evaluate(() => window.__shotref.state.objects.length)) + ' objects (ms): ' + ts.map(t => t.toFixed(1)).join(', '));
  ok(Math.min(...ts) < 20, 'settle took ' + Math.min(...ts).toFixed(1) + ' ms');
  noErrors(p);
});

/* ---------------- Batch F: camera UX (shot description, move detection, tabs and move card, blur strength, path points) and light (time of day, shadows, sun) ---------------- */
const camSet = (p, cam) => p.evaluate(c => { const S = window.__shotref; Object.assign(S.state.camera, c); S.changed(true, true); }, cam);
const KEY = (t, p, tg, f = 35) => ({ t, p, tg, f, roll: 0, fd: 6 });
const detect = p => p.evaluate(() => window.__shotref.detectMove());
const hudText = p => p.evaluate(() => document.querySelector('#hud').textContent);
const clearScene = p => p.evaluate(() => { const S = window.__shotref; S.state.objects.length = 0; S.changed(true, true); });
const camTab = async (p, name) => { await p.evaluate(() => window.__shotref.select('camera')); await settle(p, 200); await p.click('#props .tabs button:has-text("' + name + '")'); await settle(p, 250); };
const setRange = (p, label, v, commit = true) => p.evaluate(a => {
  const row = [...document.querySelectorAll('#props .row')].find(r => r.querySelector('label') && r.querySelector('label').textContent.trim() === a[0]);
  if (!row) throw new Error('no slider ' + a[0]); const r = row.querySelector('input[type=range]'); r.value = a[1];
  r.dispatchEvent(new Event('input', { bubbles: true })); if (a[2]) r.dispatchEvent(new Event('change', { bubbles: true }));
}, [label, v, commit]);
const rowText = (p, label) => p.evaluate(l => { const row = [...document.querySelectorAll('#props .row')].find(r => r.querySelector('label') && r.querySelector('label').textContent.trim() === l); return row ? row.textContent : null; }, label);
const pixDiff = (a, b) => { let d = 0; for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return d; };
const shot = (p, n) => process.env.SHOTREF_SHOTS ? p.screenshot({ path: path.join(process.env.SHOTREF_SHOTS, n) }) : null;
const personShot = async (p, cam = {}) => {
  await clearScene(p);
  await p.evaluate(() => { window.__shotref.addPerson('man', false, [0, 0, 0]); });
  await camSet(p, { base: { p: [0, 1.4, 3], tg: [0, 1.2, 0], f: 50, roll: 0, fd: 3 }, keys: [], lookAtId: null, follow: false, ...cam });
  await p.evaluate(() => window.__shotref.setView('camera')); await settle(p, 400);
};

check('move detection: names static, dolly, orbit, pan, truck, crane, zoom, dolly zoom and a free move', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const A = [0, 1.6, 8], G = [0, 1, 0];
  await camSet(p, { keys: [] });
  ok((await detect(p)).title === 'Static camera', 'no keys: ' + (await detect(p)).title);
  const cases = [
    ['Dolly in', [KEY(0, A, G), KEY(5, [0, 1.6, 5], G)]],
    ['Dolly out', [KEY(0, [0, 1.6, 5], G), KEY(5, A, G)]],
    ['Orbit', [KEY(0, A, G), KEY(5, [6.5, 1.6, 4.6], G)]],
    ['Pan', [KEY(0, A, G), KEY(5, A, [3, 1, 0])]],
    ['Tilt up', [KEY(0, A, [0, 0.5, 0]), KEY(5, A, [0, 2.2, 0])]],
    ['Truck', [KEY(0, A, G), KEY(5, [3, 1.6, 8], [3, 1, 0])]],
    ['Crane up', [KEY(0, A, G), KEY(5, [0, 4, 8], G)]],
    ['Zoom in', [KEY(0, A, G, 35), KEY(5, A, G, 70)]],
    ['Dolly zoom', [KEY(0, A, G, 50), KEY(5, [0, 1.6, 5], G, 28)]],
    ['Subtle move', [KEY(0, A, G), KEY(5, [0, 1.62, 8], G)]],
  ];
  for (const [want, keys] of cases) {
    await camSet(p, { keys, base: keys[0] });
    const t = (await detect(p)).title; ok(t.includes(want), want + ' expected, got "' + t + '"');
  }
  const many = Array.from({ length: 12 }, (_, i) => KEY(i * 0.4, [i * 0.3, 1.6, 8 - i * 0.2], G));
  await camSet(p, { keys: many, base: many[0] });
  ok((await detect(p)).title.includes('Free / recorded move'), 'more than 8 keys: ' + (await detect(p)).title);
  await camSet(p, { keys: [KEY(0, A, G), KEY(5, [0, 1.6, 5], G)], feel: 'strong' });
  ok(/strong ease/.test((await detect(p)).sub) && /2 keys/.test((await detect(p)).sub), 'the sub line names the feel and the keys: ' + (await detect(p)).sub);
  noErrors(p);
});

check('shot description: the camera view says shot size, lens, angle and the move', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await personShot(p);
  let t = await hudText(p);
  ok(/Medium shot/.test(t) && /50 mm/.test(t) && /eye level/.test(t), 'medium shot at 50 mm, eye level: "' + t + '"');
  ok(!/dolly|static/i.test(t), 'a static camera adds no move to the line: "' + t + '"');
  await camSet(p, { base: { p: [0, 0.4, 3], tg: [0, 1.4, 0], f: 50, roll: 0, fd: 3 } }); await settle(p, 300);
  ok(/low angle/.test(await hudText(p)), 'a camera below looking up says low angle: ' + await hudText(p));
  await camSet(p, { base: { p: [0, 1.3, 0.8], tg: [0, 1.2, 0], f: 85, roll: 0, fd: 1 } }); await settle(p, 300);
  ok(/Close-up|Extreme close-up|Medium close-up/.test(await hudText(p)), 'close in: ' + await hudText(p));
  await camSet(p, { base: { p: [0, 1.4, 14], tg: [0, 1.2, 0], f: 24, roll: 0, fd: 14 } }); await settle(p, 300);
  ok(/Wide shot|Extreme wide/.test(await hudText(p)), 'far away: ' + await hudText(p));
  await camSet(p, { base: { p: [0, 1.4, 3], tg: [0, 1.2, 0], f: 50, roll: 8, fd: 3 } }); await settle(p, 300);
  ok(/dutch angle/.test(await hudText(p)), 'a tilted horizon says dutch angle: ' + await hudText(p));
  await camSet(p, { base: { p: [0, 1.4, 3], tg: [0, 1.2, 0], f: 50, roll: 0, fd: 3 }, keys: [KEY(0, [0, 1.4, 5], [0, 1.2, 0], 50), KEY(5, [0, 1.4, 3], [0, 1.2, 0], 50)] }); await settle(p, 300);
  ok(/dolly in/.test(await hudText(p)), 'the move is named in lower case: ' + await hudText(p));
  ok(await p.evaluate(() => /Medium shot|Full shot|Wide shot/.test(window.__shotref.describeShot())), 'the hook gives the same line');
  await shot(p, 'f-hud-shot-description.png');
  noErrors(p);
});

check('camera panel: tabs Shot, Move, Lens, Photo, Output; the choice is remembered; a dot marks tabs in use', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => window.__shotref.select('camera')); await settle(p, 300);
  const names = await p.evaluate(() => [...document.querySelectorAll('#props .tabs button')].map(b => b.textContent.trim()));
  ok(names.join() === 'Shot,Move,Lens,Photo,Output', 'tabs: ' + names);
  ok(await p.evaluate(() => document.querySelector('#props .tabs button.on').textContent.trim()) === 'Move', 'Move is the first tab to show');
  ok(await p.evaluate(() => !!document.querySelector('#props .movecard')), 'the Move tab has the Camera move card');
  await camTab(p, 'Lens');
  ok(/Focal length/.test(await p.textContent('#props')) && /Depth of field/.test(await p.textContent('#props')) && !/Camera move/.test(await p.textContent('#props')), 'the Lens tab has lens and depth of field only');
  ok(await p.evaluate(() => window.__shotref.getPref('camTab')) === 'lens', 'the tab is a remembered preference');
  await p.evaluate(() => { window.__shotref.select(null); window.__shotref.select('camera'); }); await settle(p, 300);
  ok(await p.evaluate(() => document.querySelector('#props .tabs button.on').textContent.trim()) === 'Lens', 'it comes back on Lens');
  await camTab(p, 'Shot');
  ok(/Subject/.test(await p.textContent('#props')) && /Mount on/.test(await p.textContent('#props')), 'the Shot tab has Subject and Mount');
  await camTab(p, 'Photo'); ok(/Location photo/.test(await p.textContent('#props')), 'the Photo tab has the location photo');
  await camTab(p, 'Output'); ok(/Aspect/.test(await p.textContent('#props')) && /Guides/.test(await p.textContent('#props')), 'the Output tab has aspect and guides');
  ok(await p.evaluate(() => !document.querySelector('#props .tabs .tdot')), 'no dot while nothing is in use');
  await p.evaluate(() => { const S = window.__shotref; S.state.camera.dof.on = true; S.state.camera.keys = [{ t: 0, p: [0, 1.6, 8], tg: [0, 1, 0], f: 35, roll: 0, fd: 6 }, { t: 5, p: [0, 1.6, 5], tg: [0, 1, 0], f: 35, roll: 0, fd: 6 }]; S.changed(true, true); }); await settle(p, 300);
  const dots = await p.evaluate(() => [...document.querySelectorAll('#props .tabs button')].filter(b => b.querySelector('.tdot')).map(b => b.textContent.trim()));
  ok(dots.join() === 'Move,Lens', 'dots on Move (keys) and Lens (blur on): ' + dots);
  noErrors(p);
});

check('move card: names the move, shows Start and End thumbnails as data: URLs, jump to each frame, Set start / Set end, Play, Make static', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await personShot(p, { keys: [KEY(0, [0, 1.4, 6], [0, 1.2, 0], 50), KEY(5, [0, 1.4, 3], [0, 1.2, 0], 50)] });
  await p.evaluate(() => { const S = window.__shotref; S.setView('editor'); S.select('camera'); }); await settle(p, 500);
  ok(await p.textContent('#props .mc-title') === 'Dolly in', 'title: ' + await p.textContent('#props .mc-title'));
  ok(/5\.0 s/.test(await p.textContent('#props .mc-sub')), 'sub line: ' + await p.textContent('#props .mc-sub'));
  const src = await p.evaluate(() => [...document.querySelectorAll('#props .mthumb img')].map(i => i.src));
  ok(src.length === 2 && src.every(s => /^data:image\/jpeg;base64,/.test(s) && s.length > 800), 'two thumbnails as data: URLs: ' + src.map(s => s.slice(0, 30)));
  ok(src[0] !== src[1], 'start and end frames look different');
  await p.click('#props .mthumb:nth-child(3)'); await settle(p, 200);
  ok(Math.abs(await p.evaluate(() => window.__shotref.T) - 5) < 0.05, 'clicking End goes to the last frame: ' + await p.evaluate(() => window.__shotref.T));
  await p.click('#props .mthumb:nth-child(1)'); await settle(p, 200);
  ok(await p.evaluate(() => window.__shotref.T) === 0, 'clicking Start goes to 0');
  ok(await p.evaluate(() => /Set start/.test(document.querySelector('#props .movecard').textContent) && /Set end/.test(document.querySelector('#props .movecard').textContent)), 'Set start and Set end are on the card');
  const before = await p.evaluate(() => document.querySelector('#props .mthumb img').src);
  await p.evaluate(() => { const S = window.__shotref; S.state.camera.keys[0].p = [3, 2.5, 7]; S.changed(true, true); }); await settle(p, 500);
  ok(await p.evaluate(() => document.querySelector('#props .mthumb img').src) !== before, 'the Start thumbnail follows an edit to the first key');
  await shot(p, 'f-move-card.png');
  await p.click('#props .movecard button:has-text("Play the move")'); await settle(p, 300);
  ok(await p.evaluate(() => document.querySelector('#bPlay').classList.contains('on')), 'Play the move plays');
  await p.keyboard.press('Space'); await settle(p, 200);
  await p.click('#props .movecard button:has-text("Make static")'); await settle(p, 300);
  ok(await p.evaluate(() => window.__shotref.state.camera.keys.length) === 0, 'Make static clears the keys');
  ok(await p.textContent('#props .mc-title') === 'Static camera', 'and the card says Static camera');
  noErrors(p);
});

check('blur strength: Lens tab slider and presets, default 3, saved in camera.dof.strength', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => { const S = window.__shotref; S.state.camera.dof.on = true; S.changed(true, true); });
  await camTab(p, 'Lens');
  ok(/3\.0×/.test(await rowText(p, 'Strength')), 'default 3.0×: ' + await rowText(p, 'Strength'));
  await setRange(p, 'Strength', 4.5); await settle(p, 200);
  ok(await p.evaluate(() => window.__shotref.state.camera.dof.strength) === 4.5, 'slider writes dof.strength');
  await p.click('#props .chips button:has-text("Soft")'); await settle(p, 200);
  ok(await p.evaluate(() => window.__shotref.state.camera.dof.strength) === 2, 'preset Soft = 2');
  await p.click('#props .chips button:has-text("Real lens")'); await settle(p, 200);
  ok(await p.evaluate(() => window.__shotref.state.camera.dof.strength) === 1, 'preset Real lens = 1');
  await p.keyboard.press('Control+z'); await settle(p, 200);
  ok(await p.evaluate(() => window.__shotref.state.camera.dof.strength) === 2, 'one undo step per change');
  noErrors(p);
});

check('blur strength: a stronger setting blurs more in the exported frame', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await personShot(p, { base: { p: [0.6, 1.5, 2.2], tg: [0, 1.4, 0], f: 85, roll: 0, fd: 2.2 } });
  await p.evaluate(() => { const S = window.__shotref; S.state.camera.dof = { on: true, fstop: 2, auto: false, strength: 3 }; S.addObject('box', null, false, [-1.5, 0, -3]); S.addObject('box', null, false, [1.8, 0, -4]); S.changed(true, true); }); await settle(p, 500);
  const r = await p.evaluate(() => {
    const S = window.__shotref, c = S.state.camera, grab = () => Array.from(S.shotPixels(0, 240));
    c.dof.on = false; S.changed(true); const sharp = grab();
    c.dof.on = true; c.dof.strength = 1; S.changed(true); const s1 = grab();
    c.dof.strength = 4.5; S.changed(true); const s45 = grab();
    return { sharp, s1, s45 };
  });
  const d1 = pixDiff(r.sharp, r.s1), d45 = pixDiff(r.sharp, r.s45);
  ok(d45 > d1 * 1.15 && d1 > 0, 'blur at 4.5 (' + d45 + ') is clearly stronger than at 1 (' + d1 + ') compared with the sharp frame');
  noErrors(p);
});

check('blur strength: an artifact-made file keeps its strength; a file without one reads as 1 (the old look)', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const mk = dof => JSON.stringify({ app: 'ShotRef', version: 1, state: { v: 1, settings: { duration: 5, fps: 24 }, camera: { base: JSON.parse(CAM_BASE), keys: [], dof }, objects: [] }, assets: {} });
  await openFile(p, 'a.shotref.json', mk({ on: true, fstop: 2, auto: true, strength: 4.2 }));
  await camTab(p, 'Lens');
  ok(/4\.2×/.test(await rowText(p, 'Strength')), 'file strength shows: ' + await rowText(p, 'Strength'));
  await openFile(p, 'b.shotref.json', mk({ on: true, fstop: 2, auto: true }));
  await camTab(p, 'Lens');
  ok(/1\.0×/.test(await rowText(p, 'Strength')), 'missing strength shows 1 (the look before blur strength existed): ' + await rowText(p, 'Strength'));
  await openFile(p, 'c.shotref.json', mk({ on: true, fstop: 2, auto: true, strength: 'lots' }));
  ok(await p.evaluate(() => window.__shotref.state.camera.dof.strength) === 1, 'junk strength in a file that has depth of field reads as 1');
  noErrors(p);
});

/* camera path points: three keys so the path bends in the editor */
const PATH3 = [KEY(0, [-4, 1.6, 6], [0, 1, 0]), KEY(2.5, [0, 2.2, 5], [0, 1, 0]), KEY(5, [4, 1.6, 6], [0, 1, 0])];
const pathSetup = async p => {
  await p.evaluate(() => { const S = window.__shotref; S.state.camera.keys = []; S.setView('editor'); });
  await camSet(p, { keys: PATH3, base: PATH3[0] }); await p.evaluate(() => window.__shotref.select(null)); await settle(p, 500);
};
const keyScreen = (p, i) => p.evaluate(i => { const S = window.__shotref; const w = S.camToWorld(S.state.camera.keys[i].p, S.state.camera.keys[i].t); return S.project(w[0], w[1], w[2]); }, i);
const dragMouse = async (p, [x0, y0], [x1, y1], mods = []) => {
  for (const m of mods) await p.keyboard.down(m);
  await p.mouse.move(x0, y0); await p.mouse.down(); await p.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 3 }); await p.mouse.move(x1, y1, { steps: 4 }); await p.mouse.up();
  for (const m of mods) await p.keyboard.up(m);
  await settle(p, 250);
};
const pickScr = (p, [x, y]) => p.evaluate(a => window.__shotref.pickAtScreen(a[0], a[1]), [x, y]);

check('camera path points: drag one along the floor to reshape the move; one undo step', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await pathSetup(p);
  const [x, y] = await keyScreen(p, 1);
  ok(await pickScr(p, [x, y]) === 'ck:1', 'the middle point can be picked: ' + await pickScr(p, [x, y]));
  const h0 = await p.evaluate(() => window.__shotref.history.length), k0 = await p.evaluate(() => JSON.parse(JSON.stringify(window.__shotref.state.camera.keys)));
  await dragMouse(p, [x, y], [x + 90, y + 30]);
  const k1 = await p.evaluate(() => JSON.parse(JSON.stringify(window.__shotref.state.camera.keys)));
  ok(Math.hypot(k1[1].p[0] - k0[1].p[0], k1[1].p[2] - k0[1].p[2]) > 0.3, 'the point moved on the floor: ' + k0[1].p + ' to ' + k1[1].p);
  ok(Math.abs(k1[1].p[1] - k0[1].p[1]) < 1e-6, 'its height stayed');
  ok(k1[0].p.join() === k0[0].p.join() && k1[2].p.join() === k0[2].p.join() && k1[1].t === k0[1].t, 'the other points and the time stayed');
  ok(await p.evaluate(() => window.__shotref.selected) === 'camera', 'the camera is selected');
  ok(await p.evaluate(() => window.__shotref.history.length) === h0 + 1, 'one undo step');
  await p.keyboard.press('Control+z'); await settle(p, 250);
  ok(canon(await p.evaluate(() => window.__shotref.state.camera.keys)) === canon(k0), 'undo puts the point back');
  noErrors(p);
});

check('camera path points: Alt-drag raises or lowers a point, keeping its place on the floor', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await pathSetup(p);
  const [x, y] = await keyScreen(p, 1), k0 = await p.evaluate(() => JSON.parse(JSON.stringify(window.__shotref.state.camera.keys[1])));
  await dragMouse(p, [x, y], [x, y - 70], ['Alt']);
  const k1 = await p.evaluate(() => JSON.parse(JSON.stringify(window.__shotref.state.camera.keys[1])));
  ok(k1.p[1] > k0.p[1] + 0.3, 'dragging up with Alt raised it: ' + k0.p[1] + ' to ' + k1.p[1]);
  ok(Math.abs(k1.p[0] - k0.p[0]) < 1e-6 && Math.abs(k1.p[2] - k0.p[2]) < 1e-6, 'x and z stayed');
  noErrors(p);
});

check('camera path points: with the camera mounted the point is dragged in world space', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const car = await mkObj(p, 'car', [0, 0, 0], { base: { p: [1, 0, 0], r: [0, 90, 0], s: [1, 1, 1] } });
  await p.evaluate(() => { const S = window.__shotref; S.state.camera.keys = []; S.setView('editor'); });
  await camSet(p, { keys: PATH3, base: PATH3[0] });
  await p.evaluate(i => window.__shotref.setMount(i), car); await p.evaluate(() => window.__shotref.select(null)); await settle(p, 500);
  const [x, y] = await keyScreen(p, 1);
  const w0 = await p.evaluate(() => { const S = window.__shotref, k = S.state.camera.keys[1]; return S.camToWorld(k.p, k.t); });
  await dragMouse(p, [x, y], [x + 70, y + 20]);
  const w1 = await p.evaluate(() => { const S = window.__shotref, k = S.state.camera.keys[1]; return S.camToWorld(k.p, k.t); });
  ok(Math.hypot(w1[0] - w0[0], w1[2] - w0[2]) > 0.3 && Math.abs(w1[1] - w0[1]) < 1e-3, 'it moved in world space and kept its height: ' + w0 + ' to ' + w1);
  noErrors(p);
});

check('camera path points: right-click the path to add a point, right-click a point to go there or delete it', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await pathSetup(p);
  const mid = await p.evaluate(() => { const S = window.__shotref, c = S.evalCam(1.25).p; return S.project(c[0], c[1], c[2]); });
  ok(['cpath', 'ck:0', 'ck:1'].includes(await pickScr(p, mid)), 'the path line can be picked: ' + await pickScr(p, mid));
  await rightClick(p, ...mid); await settle(p, 200);
  let labels = await menuLabels(p);
  ok(labels && labels.some(l => /^Add a camera point here \(\d\.\d\d s\)/.test(l)) && labels.some(l => l.startsWith('Go to this moment')), 'path menu: ' + JSON.stringify(labels));
  await clickItem(p, 'Add a camera point here'); await settle(p, 300);
  const keys = await p.evaluate(() => window.__shotref.state.camera.keys.map(k => k.t));
  ok(keys.length === 4 && keys.some(t => t > 0.9 && t < 1.6), 'a point was added near 1.25 s: ' + keys);
  const [x, y] = await keyScreen(p, 1);
  await rightClick(p, x, y); await settle(p, 200);
  labels = await menuLabels(p);
  ok(labels && labels.some(l => l.startsWith('Go to this moment')) && labels.some(l => l.startsWith('Look through the camera here')) && labels.some(l => l.startsWith('Delete this point')), 'point menu: ' + JSON.stringify(labels));
  await clickItem(p, 'Go to this moment'); await settle(p, 200);
  ok(Math.abs(await p.evaluate(() => window.__shotref.T) - keys[1]) < 0.05, 'Go to this moment moves the playhead to the point');
  await rightClick(p, x, y); await settle(p, 200); await clickItem(p, 'Delete this point'); await settle(p, 300);
  ok(await p.evaluate(() => window.__shotref.state.camera.keys.length) === 3, 'the point was deleted');
  const [x2, y2] = await keyScreen(p, 1); /* the points moved up one place */
  await rightClick(p, x2, y2); await settle(p, 200); await clickItem(p, 'Look through the camera here'); await settle(p, 300);
  ok(await p.evaluate(() => window.__shotref.view) === 'camera', 'Look through the camera here opens the camera view');
  noErrors(p);
});

check('camera path points: hidden in the camera view, and when the preference is off', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await pathSetup(p);
  const [x, y] = await keyScreen(p, 1);
  await p.evaluate(() => { window.__shotref.setPref('camPoints', false); window.__shotref.changed(false); }); await settle(p, 300);
  ok(await pickScr(p, [x, y]) !== 'ck:1', 'the pref off hides the handles');
  await p.evaluate(() => { window.__shotref.setPref('camPoints', true); window.__shotref.changed(false); }); await settle(p, 300);
  ok(await pickScr(p, [x, y]) === 'ck:1', 'and back on');
  await p.evaluate(() => window.__shotref.setView('camera')); await settle(p, 300);
  ok(!(await p.evaluate(() => window.__shotref.pointsVisible())), 'no handles in the camera view');
  noErrors(p);
});

check('camera path: screenshot of the path points', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await pathSetup(p); await p.evaluate(() => window.__shotref.select('camera')); await settle(p, 400);
  await shot(p, 'f-camera-path-points.png');
  noErrors(p);
});

/* ---- light ---- */
const sunInfo = p => p.evaluate(() => window.__shotref.sunInfo());
const hasRow = (p, label) => p.evaluate(l => !![...document.querySelectorAll('#props .row')].find(r => r.querySelector('label') && r.querySelector('label').textContent.trim() === l), label);

check('time of day: the slider sets sun height, colour and strength, saved as settings.tod; default 14:00', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => { window.__shotref.select(null); }); await settle(p, 200);
  ok(/14:00/.test(await rowText(p, 'Time of day')), 'default 14:00: ' + await rowText(p, 'Time of day'));
  await setRange(p, 'Time of day', 12); await settle(p, 250);
  let s = await p.evaluate(() => JSON.parse(JSON.stringify(window.__shotref.state.settings)));
  ok(s.tod === 12 && s.sunEl === 72 && Math.abs(s.sunInt - 2.7) < 0.01 && s.sunColor === '#fff4e2', 'noon: ' + JSON.stringify([s.tod, s.sunEl, s.sunInt, s.sunColor]));
  ok((await sunInfo(p)).intensity > 2.6 && (await sunInfo(p)).color === '#fff4e2', 'the light in the scene follows');
  await setRange(p, 'Time of day', 6); await settle(p, 250);
  s = await p.evaluate(() => JSON.parse(JSON.stringify(window.__shotref.state.settings)));
  ok(s.sunEl === 2 && s.sunColor === '#ff8a3c' && Math.abs(s.sunInt - 0.9) < 0.01, 'sunrise: ' + JSON.stringify([s.sunEl, s.sunInt, s.sunColor]));
  ok(/06:00/.test(await rowText(p, 'Time of day')) && /horizon/.test(await p.textContent('#props')), 'shows 06:00 and the description: ' + await p.textContent('#props'));
  await setRange(p, 'Time of day', 17.5); await settle(p, 250);
  ok(/Golden hour|Low sun/.test(await p.textContent('#props')) && /17:30/.test(await rowText(p, 'Time of day')), 'late afternoon wording');
  await blurAll(p); await p.keyboard.press('Control+z'); await settle(p, 250);
  ok(await p.evaluate(() => window.__shotref.state.settings.tod) === 6, 'one undo step per change');
  noErrors(p);
});

check('time of day: renders differently in the exported frame', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => window.__shotref.select(null)); await settle(p, 200);
  await setRange(p, 'Time of day', 12); await settle(p, 250);
  const a = await p.evaluate(() => Array.from(window.__shotref.shotPixels(0, 240)));
  await setRange(p, 'Time of day', 7); await settle(p, 250);
  const b = await p.evaluate(() => Array.from(window.__shotref.shotPixels(0, 240)));
  ok(pixDiff(a, b) > 20000, 'noon and early morning exports differ: ' + pixDiff(a, b));
  noErrors(p);
});

check('light the shot from: Front, Side left, Side right, Backlight, Top place the sun relative to the camera', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => window.__shotref.select(null)); await settle(p, 200);
  const az = await p.evaluate(() => { const c = window.__shotref.evalCam(window.__shotref.T); return Math.atan2(c.p[0] - c.tg[0], c.p[2] - c.tg[2]) * 180 / Math.PI; });
  const wrap = d => ((d % 360) + 360) % 360, near360 = (a, b) => Math.abs(((a - b + 540) % 360) - 180) < 1.01;
  for (const [label, d, el] of [['Front', 25, 35], ['Side left', -90, 22], ['Side right', 90, 22], ['Backlight', 180, 16], ['Top', 0, 82]]) {
    await p.click('#props .chips button:text-is("' + label + '")'); await settle(p, 200);
    const s = await p.evaluate(() => JSON.parse(JSON.stringify(window.__shotref.state.settings)));
    ok(near360(s.sunAz, wrap(az + d)) && s.sunEl === el, label + ': ' + s.sunAz + ' / ' + s.sunEl + ' expected ' + wrap(az + d) + ' / ' + el);
  }
  noErrors(p);
});

check('shadows: Cast shadows and Softness change the sun in the scene and in the exported frame; Shadow depth maps to the fill light', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => { const S = window.__shotref; S.select(null); S.state.settings.sunEl = 40; S.state.settings.sunAz = 60; S.changed(true, true); }); await settle(p, 300);
  ok(await p.evaluate(() => document.querySelector('#props').textContent.includes('Cast shadows')), 'Cast shadows is in the Scene panel');
  ok((await sunInfo(p)).castShadow === true && Math.abs((await sunInfo(p)).radius - 3.64) < 0.01, 'default: shadows on, radius 1 + (0.3 + 0.7 x 0.2 few clouds) x 6');
  await setRange(p, 'Softness', 1); await settle(p, 250);
  ok(Math.abs((await sunInfo(p)).radius - 7) < 0.01 && await p.evaluate(() => window.__shotref.state.settings.shadowSoft) === 1, 'softness 1 gives radius 7');
  const soft = await p.evaluate(() => Array.from(window.__shotref.shotPixels(0, 240)));
  await setRange(p, 'Softness', 0); await settle(p, 250);
  const hard = await p.evaluate(() => Array.from(window.__shotref.shotPixels(0, 240)));
  ok(pixDiff(soft, hard) > 500, 'hard and soft shadows export differently: ' + pixDiff(soft, hard));
  await p.click('#props label:has-text("Cast shadows")'); await settle(p, 300);
  ok(await p.evaluate(() => window.__shotref.state.settings.shadows) === false && (await sunInfo(p)).castShadow === false, 'switched off: the setting and the light');
  ok(!(await hasRow(p, 'Softness')), 'Softness hides while shadows are off');
  const off = await p.evaluate(() => Array.from(window.__shotref.shotPixels(0, 240)));
  ok(pixDiff(off, hard) > 3000, 'shadows off exports differently from shadows on: ' + pixDiff(off, hard));
  await setRange(p, 'Shadow depth', 0); await settle(p, 250);
  const e0 = await p.evaluate(() => window.__shotref.state.settings.ambInt);
  await setRange(p, 'Shadow depth', 1); await settle(p, 250);
  const e1 = await p.evaluate(() => window.__shotref.state.settings.ambInt);
  ok(Math.abs(e0 - 2.5) < 0.02 && Math.abs(e1 - 0.2) < 0.02, 'depth 0 = fill 2.5, depth 1 = fill 0.2: ' + e0 + ' / ' + e1);
  noErrors(p);
});

check('sun: the Scene list has a Sun row; selecting it opens the Sun panel; the Delete key leaves it alone', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.click('#leftTabs [data-lt="scene"]'); await settle(p, 200);
  ok(await p.evaluate(() => !!document.querySelector('#outliner .ol[data-id="sun"]')), 'a Sun row is in the Scene list');
  const n0 = await p.evaluate(() => window.__shotref.state.objects.length);
  await p.click('#outliner .ol[data-id="sun"]'); await settle(p, 300);
  ok(await p.evaluate(() => window.__shotref.selected) === 'sun', 'the Sun row selects the sun');
  ok(await p.evaluate(() => document.querySelector('#props .sec h3').textContent) === 'Sun' && /Light the shot from/.test(await p.textContent('#props')), 'the Sun panel opens');
  await blurAll(p); await p.keyboard.press('Delete'); await settle(p, 200);
  ok(await p.evaluate(() => window.__shotref.state.objects.length) === n0 && await p.evaluate(() => window.__shotref.selected) === 'sun', 'nothing was deleted');
  await p.click('#outliner .ol[data-id="camera"]'); await settle(p, 200);
  ok(await p.evaluate(() => window.__shotref.selected) === 'camera', 'other rows still select');
  await p.click('#outliner .ol[data-id="sun"]'); await settle(p, 300);
  await shot(p, 'f-sun-panel.png');
  noErrors(p);
});

check('sun: right-click the Sun row for the light-from presets and the shadows switch', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.click('#leftTabs [data-lt="scene"]'); await settle(p, 200);
  await p.click('#outliner .ol[data-id="sun"]', { button: 'right' }); await settle(p, 200);
  const labels = await menuLabels(p);
  ok(labels && ['Front light', 'Side light from the left', 'Side light from the right', 'Backlight', 'Top light', 'Turn shadows off'].every(l => labels.some(x => x.startsWith(l))), 'sun menu: ' + JSON.stringify(labels));
  const az = await p.evaluate(() => { const c = window.__shotref.evalCam(window.__shotref.T); return Math.atan2(c.p[0] - c.tg[0], c.p[2] - c.tg[2]) * 180 / Math.PI; });
  await clickItem(p, 'Backlight'); await settle(p, 250);
  const s = await p.evaluate(() => JSON.parse(JSON.stringify(window.__shotref.state.settings)));
  ok(Math.abs(((s.sunAz - az - 180 + 540) % 360) - 180) < 1.01 && s.sunEl === 16, 'Backlight: ' + s.sunAz + ' / ' + s.sunEl);
  await p.click('#outliner .ol[data-id="sun"]', { button: 'right' }); await settle(p, 200); await clickItem(p, 'Turn shadows off'); await settle(p, 250);
  ok(await p.evaluate(() => window.__shotref.state.settings.shadows) === false, 'shadows are off');
  await p.click('#outliner .ol[data-id="sun"]', { button: 'right' }); await settle(p, 200);
  ok((await menuLabels(p)).some(l => l.startsWith('Turn shadows on')), 'and the menu now offers to turn them on');
  noErrors(p);
});

check('sun gizmo: drag the sun in the editor to turn the light; one undo step; redraws; hidden in the camera view and by the preference', async ({ open }) => {
  const p = await open(); await settle(p, 400);
  await p.evaluate(() => { const S = window.__shotref; S.select(null); S.setView('editor'); }); await settle(p, 400);
  const g0 = await p.evaluate(() => window.__shotref.sunInfo().gizmo);
  ok(g0 && g0.visible, 'the sun gizmo is visible in the editor');
  const [x, y] = await p.evaluate(g => window.__shotref.project(g.pos[0], g.pos[1], g.pos[2]), g0);
  ok(await pickScr(p, [x, y]) === 'sun', 'the gizmo can be picked: ' + await pickScr(p, [x, y]));
  const s0 = await p.evaluate(() => JSON.parse(JSON.stringify(window.__shotref.state.settings))), h0 = await p.evaluate(() => window.__shotref.history.length);
  const d0 = await p.evaluate(() => window.__shotref.renderStats().draws);
  await dragMouse(p, [x, y], [x + 140, y + 60]);
  const s1 = await p.evaluate(() => JSON.parse(JSON.stringify(window.__shotref.state.settings)));
  ok(s1.sunAz !== s0.sunAz || s1.sunEl !== s0.sunEl, 'the sun moved: ' + [s0.sunAz, s0.sunEl] + ' to ' + [s1.sunAz, s1.sunEl]);
  ok(s1.sunEl >= 2 && s1.sunEl <= 89 && s1.sunAz >= 0 && s1.sunAz < 360, 'direction stays in range');
  ok(await p.evaluate(() => window.__shotref.selected) === 'sun', 'the sun is selected');
  ok(await p.evaluate(() => window.__shotref.history.length) === h0 + 1, 'one undo step');
  ok(await p.evaluate(() => window.__shotref.renderStats().draws) > d0, 'the view was redrawn');
  await p.keyboard.press('Control+z'); await settle(p, 300);
  const s2 = await p.evaluate(() => JSON.parse(JSON.stringify(window.__shotref.state.settings)));
  ok(s2.sunAz === s0.sunAz && s2.sunEl === s0.sunEl, 'undo puts the sun back');
  await shot(p, 'f-sun-gizmo.png');
  await p.evaluate(() => { window.__shotref.setPref('showSun', false); window.__shotref.changed(false); }); await settle(p, 300);
  ok(!(await p.evaluate(() => window.__shotref.sunInfo().gizmo.visible)), 'the preference hides it');
  await p.evaluate(() => { window.__shotref.setPref('showSun', true); window.__shotref.setView('camera'); }); await settle(p, 300);
  ok(!(await p.evaluate(() => window.__shotref.sunInfo().gizmo.visible)), 'hidden in the camera view');
  noErrors(p);
});

check('sun gizmo: in the top view dragging turns the direction only', async ({ open }) => {
  const p = await open(); await settle(p, 400);
  await p.evaluate(() => { const S = window.__shotref; S.select(null); S.setView('top'); }); await settle(p, 500);
  const g0 = await p.evaluate(() => window.__shotref.sunInfo().gizmo);
  ok(g0 && g0.visible, 'visible in the top view');
  const [x, y] = await p.evaluate(g => window.__shotref.project(g.pos[0], g.pos[1], g.pos[2]), g0);
  const s0 = await p.evaluate(() => JSON.parse(JSON.stringify(window.__shotref.state.settings)));
  await dragMouse(p, [x, y], [x + 80, y + 120]);
  const s1 = await p.evaluate(() => JSON.parse(JSON.stringify(window.__shotref.state.settings)));
  ok(s1.sunAz !== s0.sunAz && s1.sunEl === s0.sunEl, 'direction changed, height did not: ' + [s0.sunAz, s0.sunEl] + ' to ' + [s1.sunAz, s1.sunEl]);
  noErrors(p);
});

check('light: an artifact-made file with time of day and shadow settings opens and renders with them', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const file = { app: 'ShotRef', version: 1, state: { v: 1, settings: { duration: 5, fps: 24, tod: 8, shadows: false, shadowSoft: 0.9, sunEl: 20, sunAz: 100, sunInt: 1.6, sunColor: '#ffcc99' }, camera: { base: JSON.parse(CAM_BASE), keys: [] }, objects: [] }, assets: {} };
  await openFile(p, 'l.shotref.json', JSON.stringify(file));
  const s = await sunInfo(p);
  ok(s.castShadow === false && Math.abs(s.radius - 6.4) < 0.01 && Math.abs(s.intensity - 1.6) < 0.01, 'the sun in the scene uses the file: ' + JSON.stringify(s));
  await p.evaluate(() => window.__shotref.select(null)); await settle(p, 300);
  ok(/08:00/.test(await rowText(p, 'Time of day')), 'the panel shows 08:00: ' + await rowText(p, 'Time of day'));
  const st = await stateOf(p);
  ok(st.settings.tod === 8 && st.settings.shadows === false && st.settings.shadowSoft === 0.9, 'the fields are kept');
  const bad = JSON.parse(JSON.stringify(file)); bad.state.settings.tod = 99; bad.state.settings.shadows = 'maybe'; bad.state.settings.shadowSoft = -3;
  await openFile(p, 'l2.shotref.json', JSON.stringify(bad));
  const sb = (await stateOf(p)).settings;
  ok(sb.tod === 20 && !('shadows' in sb && typeof sb.shadows !== 'boolean') && sb.shadowSoft === 0, 'junk values are repaired: ' + JSON.stringify([sb.tod, sb.shadows, sb.shadowSoft]));
  noErrors(p);
});

check('light: selecting the sun and undo/redo never move the sun or the camera', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const snap = () => p.evaluate(() => JSON.stringify([window.__shotref.state.settings.sunAz, window.__shotref.state.settings.sunEl, window.__shotref.state.camera]));
  const before = await snap();
  await p.evaluate(() => { window.__shotref.select('sun'); }); await settle(p, 300);
  await blurAll(p); await p.keyboard.press('Control+z'); await p.keyboard.press('Control+y'); await settle(p, 300);
  ok(await snap() === before, 'selecting the sun and undo/redo changed nothing');
  noErrors(p);
});

check('screenshots: the Scene panel with the sun section and the Lens tab with blur strength', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => window.__shotref.select(null)); await settle(p, 400);
  await shot(p, 'f-scene-sun-shadows.png');
  await p.evaluate(() => { const S = window.__shotref; S.state.camera.dof.on = true; S.changed(true, true); });
  await camTab(p, 'Lens'); await shot(p, 'f-lens-blur-strength.png');
  noErrors(p);
});


/* ---- Batch F fix round 1 ---- */
const fileWith = (camera, settings, extra = {}) => JSON.stringify({ app: 'ShotRef', version: 2, state: { v: 2, settings: { duration: 5, fps: 24, ...settings }, camera: { base: JSON.parse(CAM_BASE), keys: [], ...camera }, objects: [], ...extra }, assets: {} });

check('old files: no dof.strength opens at 1, in the file, in shots and in an autosave; a new scene gets 3; no dof at all reads as the default', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  ok(await p.evaluate(() => window.__shotref.state.camera.dof.strength) === 3, 'a new scene has strength 3');
  await openFile(p, 'o.shotref', fileWith({ dof: { on: true, fstop: 2, auto: true } }, {}));
  ok(await p.evaluate(() => window.__shotref.state.camera.dof.strength) === 1, 'a file with depth of field but no strength: 1');
  await openFile(p, 'o2.shotref', fileWith({ dof: { on: true, fstop: 2, auto: true, strength: 2.5 } }, {}));
  ok(await p.evaluate(() => window.__shotref.state.camera.dof.strength) === 2.5, 'a stored strength is kept');
  await openFile(p, 'o3.shotref', fileWith({}, {}));
  ok(await p.evaluate(() => window.__shotref.state.camera.dof.strength) === 3, 'a file with no depth of field at all reads as the default 3');
  const shots = [{ id: 's1', name: 'A', duration: 5, camera: { base: JSON.parse(CAM_BASE), keys: [], dof: { on: true, fstop: 2, auto: true } } }];
  await openFile(p, 'o4.shotref', fileWith({}, {}, { shots, shotId: 's1' }));
  ok(await p.evaluate(() => window.__shotref.state.shots[0].camera.dof.strength) === 1, 'a shot camera without strength: 1');
  const old = JSON.parse(fileWith({ dof: { on: true, fstop: 2, auto: true } }, {})).state;
  await p.evaluate(s => localStorage.setItem('shotref.autosave', JSON.stringify({ state: s, assets: {}, assetIds: [], v: 2 })), old);
  await p.reload(); await p.waitForFunction(() => window.__shotref && window.__shotref.state); await settle(p, 800);
  ok(await p.evaluate(() => window.__shotref.state.camera.dof.strength) === 1, 'an autosave without strength: 1');
  noErrors(p);
});

check('old files: no shadowSoft keeps the old shadow radius (2); a new scene uses the new default', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  ok(Math.abs((await sunInfo(p)).radius - 3.64) < 0.01, 'a new scene: 3.64 (0.3 softness, softened by few clouds)');
  await openFile(p, 'o5.shotref', fileWith({}, {}));
  ok(Math.abs((await sunInfo(p)).radius - 2) < 0.01, 'a file without shadowSoft: radius 2, was ' + (await sunInfo(p)).radius);
  await openFile(p, 'o6.shotref', fileWith({}, { shadowSoft: 0.5 }));
  ok(Math.abs((await sunInfo(p)).radius - 4) < 0.01, 'a stored softness is kept');
  noErrors(p);
});

check('ground: settling a keyed car writes the same heights at any playhead (wheels do not change the rest height)', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => { const S = window.__shotref; S.state.objects.length = 0; S.changed(true, true); });
  const run = async t => {
    const id = await mkObj(p, 'car', [0, 0, 0]);
    await p.evaluate(a => { const S = window.__shotref, o = S.state.objects.find(x => x.id === a[0]); o.keys = [{ t: 0, p: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }, { t: 4, p: [12, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }]; S.setT(a[1]); S.changed(true, true); }, [id, t]);
    await settle(p, 700);
    const ys = (await objOf(p, id)).keys.map(k => k.p[1]);
    await p.evaluate(a => { const S = window.__shotref; S.state.objects = S.state.objects.filter(x => x.id !== a); S.changed(true, true); }, id); await settle(p, 200);
    return ys;
  };
  const a = await run(0.3), b = await run(2.7), c = await run(1.4);
  ok(a.every((y, i) => Math.abs(y - b[i]) < 1e-4 && Math.abs(y - c[i]) < 1e-4), 'heights differ by playhead: ' + JSON.stringify([a, b, c]));
  noErrors(p);
});

check('sun gizmo: an object in front of the sun is picked first; the sun still picks where nothing is in front', async ({ open }) => {
  const p = await open(); await settle(p, 400);
  await p.evaluate(() => { const S = window.__shotref; S.state.objects.length = 0; S.select(null); S.setView('editor'); S.changed(true, true); }); await settle(p, 400);
  const g = await p.evaluate(() => window.__shotref.sunInfo().gizmo), [x, y] = await p.evaluate(g => window.__shotref.project(g.pos[0], g.pos[1], g.pos[2]), g);
  ok(await pickScr(p, [x, y]) === 'sun', 'nothing in front: the sun');
  /* a big wall right in front of the sun, between it and the editor camera */
  const id = await p.evaluate(g => { const S = window.__shotref, c = S.evalCam(0), cam = S.editCamPos(); const o = S.addObject('box', null, false, [0, 0, 0]); const m = [cam[0] + (g.pos[0] - cam[0]) * 0.5, cam[1] + (g.pos[1] - cam[1]) * 0.5, cam[2] + (g.pos[2] - cam[2]) * 0.5]; o.base = { p: [m[0], m[1] - 0.5, m[2]], r: [0, 0, 0], s: [6, 6, 6] }; o.opts.free = true; S.changed(true, true); return o.id; }, g);
  await settle(p, 500);
  ok(await pickScr(p, [x, y]) === id, 'an object in front wins: ' + await pickScr(p, [x, y]));
  noErrors(p);
});

/* ======================= batch 9: shots, Export panel, prompt, frame pack, contact sheet ======================= */
/* opens the old Export window through the panel's "Video options…" button */
const exportDialog = async p => { await p.click('#bExport'); await p.click('#xoOptions'); };
const chipNames = p => p.evaluate(() => [...document.querySelectorAll('#shotBar .shotchip:not(.add)')].map(c => c.firstChild.textContent + '|' + c.querySelector('small').textContent));
/* the store-only zip: parse the central directory and check every CRC. Returns [{name, data, crc}] */
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function readZip(buf) {
  let e = -1; for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  ok(e >= 0, 'no end-of-central-directory record');
  const n = buf.readUInt16LE(e + 10), cdSize = buf.readUInt32LE(e + 12), cdOff = buf.readUInt32LE(e + 16);
  ok(cdOff + cdSize === e, 'central directory does not end where the end record starts');
  const out = []; let q = cdOff;
  for (let i = 0; i < n; i++) {
    ok(buf.readUInt32LE(q) === 0x02014b50, 'bad central directory entry ' + i);
    const method = buf.readUInt16LE(q + 10), crc = buf.readUInt32LE(q + 16), csize = buf.readUInt32LE(q + 20), usize = buf.readUInt32LE(q + 24), nl = buf.readUInt16LE(q + 28), xl = buf.readUInt16LE(q + 30), cl = buf.readUInt16LE(q + 32), lo = buf.readUInt32LE(q + 42);
    const name = buf.toString('utf8', q + 46, q + 46 + nl);
    ok(method === 0 && csize === usize, name + ' is not stored');
    ok(buf.readUInt32LE(lo) === 0x04034b50, 'bad local header for ' + name);
    const lnl = buf.readUInt16LE(lo + 26), lxl = buf.readUInt16LE(lo + 28), data = buf.subarray(lo + 30 + lnl + lxl, lo + 30 + lnl + lxl + usize);
    ok(crc32(data) === crc, 'CRC mismatch for ' + name);
    out.push({ name, data, crc }); q += 46 + nl + xl + cl;
  }
  return out;
}
const pngSize = b => ({ sig: b.subarray(0, 4).toString('hex'), w: b.readUInt32BE(16), h: b.readUInt32BE(20) });
/* a scene with a known framing: one man in the middle, camera 4.5 m away */
const promptScene = async p => {
  await p.evaluate(() => {
    const S = window.__shotref; S.state.objects.length = 0;
    const c = S.state.camera; c.keys = []; c.base = { p: [0, 1.5, 4.5], tg: [0, 1.2, 0], f: 50, roll: 0, fd: 4.5 }; c.shake = 0; c.lookAtId = null; c.follow = false;
    const o = S.addObject('person', null, false, [0, 0, 0]); c.lookAtId = o.id; S.changed(true, true);
  });
  await settle(p, 300);
};

check('shots: a plain project shows one Shot 1 chip, and saving it adds no shots', async ({ open, downloads }) => {
  const p = await open(); await settle(p, 300);
  const n = await chipNames(p);
  ok(n.length === 1 && n[0] === 'Shot 1|5 s', 'chips: ' + JSON.stringify(n));
  ok(await p.evaluate(() => !window.__shotref.state.shots), 'looking at the bar must not add shots to the project');
  await fileCmd(p, 'save');
  const f = JSON.parse((await downloads(p).wait('.shotref')).text());
  ok(!f.state.shots && !f.state.shotId, 'saved file gained shots');
  noErrors(p);
});

check('shots: + New shot starts from the framing with no keys; each shot keeps its own camera and length', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => { const S = window.__shotref; S.applyMove('dollyIn'); S.changed(true, true); });
  await p.click('#shotBar .shotchip.add');
  await settle(p, 200);
  let s = await stateOf(p);
  ok(s.shots.length === 2 && s.shotId === s.shots[1].id && s.shots[1].name === 'Shot 2', 'shots: ' + JSON.stringify(s.shots.map(x => x.name)));
  ok(s.camera.keys.length === 0, 'the new shot should have no keys, has ' + s.camera.keys.length);
  ok(s.shots[0].camera.keys.length >= 2, 'the first shot lost its move');
  await p.fill('#inDur', '8'); await p.press('#inDur', 'Enter'); await settle(p, 200);
  ok((await chipNames(p)).join() === 'Shot 1|5 s,Shot 2|8 s', 'chips after 8 s: ' + (await chipNames(p)).join());
  await p.click('#shotBar .shotchip:not(.add) >> nth=0'); await settle(p, 200);
  s = await stateOf(p);
  ok(s.shotId === s.shots[0].id && s.settings.duration === 5 && s.camera.keys.length >= 2, 'back on shot 1: ' + JSON.stringify([s.settings.duration, s.camera.keys.length]));
  ok(s.shots[1].duration === 8 && s.shots[1].camera.keys.length === 0, 'shot 2 lost its own length or camera');
  ok(await p.evaluate(() => document.querySelector('#inDur').value) === '5', 'the length box did not follow the shot');
  noErrors(p);
});

check('shots: rename by double-click, and Duplicate, Move, Delete from the chip menu', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => { const S = window.__shotref; S.applyMove('orbitL'); S.changed(true, true); });
  await p.dblclick('#shotBar .shotchip:not(.add)');
  await p.fill('#shotBar input', 'Opening wide'); await p.press('#shotBar input', 'Enter'); await settle(p, 150);
  ok((await chipNames(p))[0] === 'Opening wide|5 s', 'rename: ' + (await chipNames(p)).join());
  await p.click('#shotBar .shotchip:not(.add)', { button: 'right' });
  const items = await p.evaluate(() => [...document.querySelectorAll('#ctxMenu button')].map(b => b.dataset.cmd + (b.disabled ? '!' : '')));
  ok(['rename', 'dup', 'left!', 'right!', 'del!'].every(c => items.includes(c)), 'menu: ' + items.join());
  await p.click('#ctxMenu [data-cmd="dup"]'); await settle(p, 200);
  let s = await stateOf(p);
  ok(s.shots.length === 2 && s.shots[1].name === 'Opening wide copy' && s.shotId === s.shots[1].id, 'duplicate: ' + JSON.stringify(s.shots.map(x => x.name)));
  ok(s.camera.keys.length === s.shots[0].camera.keys.length && s.camera.keys.length >= 2, 'a duplicate keeps the same move');
  await p.click('#shotBar .shotchip:not(.add) >> nth=1', { button: 'right' });
  await p.click('#ctxMenu [data-cmd="left"]'); await settle(p, 150);
  s = await stateOf(p);
  ok(s.shots[0].name === 'Opening wide copy' && s.shots[1].name === 'Opening wide', 'move left: ' + JSON.stringify(s.shots.map(x => x.name)));
  await p.click('#shotBar .shotchip:not(.add) >> nth=0', { button: 'right' });
  await p.click('#ctxMenu [data-cmd="del"]'); await settle(p, 200);
  s = await stateOf(p);
  ok(s.shots.length === 1 && s.shotId === s.shots[0].id && s.shots[0].name === 'Opening wide', 'delete: ' + JSON.stringify(s.shots.map(x => x.name)));
  await p.click('#shotBar .shotchip:not(.add)', { button: 'right' });
  ok(await p.evaluate(() => document.querySelector('#ctxMenu [data-cmd="del"]').disabled), 'the last shot can be deleted');
  await p.keyboard.press('Escape');
  noErrors(p);
});

check('shots: undo and redo step through a new shot and a switch, and say what they undid', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(TOAST_LOG);
  const cam0 = await p.evaluate(() => JSON.stringify(window.__shotref.state.camera));
  await p.click('#shotBar .shotchip.add'); await settle(p, 150);
  await p.evaluate(() => { const S = window.__shotref; S.applyMove('craneUp'); S.changed(true, true); });
  await p.click('#shotBar .shotchip:not(.add) >> nth=0'); await settle(p, 150);
  ok(await p.evaluate(() => window.__shotref.state.shotId === window.__shotref.state.shots[0].id), 'did not switch');
  await p.click('#bUndo'); await settle(p, 150);
  ok(await p.evaluate(() => window.__shotref.state.shotId === window.__shotref.state.shots[1].id && window.__shotref.state.camera.keys.length >= 2), 'undo did not bring back shot 2 with its move');
  ok(await p.evaluate(() => window.__toasts.some(t => /Undo: switch to Shot 1/.test(t))), 'toast: ' + await p.evaluate(() => window.__toasts.join(' / ')));
  await p.click('#bUndo'); await p.click('#bUndo'); await settle(p, 150);
  ok(await p.evaluate(() => (window.__shotref.state.shots || []).length < 2), 'two undos should remove the new shot');
  ok(await p.evaluate(c => JSON.stringify(window.__shotref.state.camera) === c, cam0), 'camera not restored');
  ok(await p.evaluate(() => window.__toasts.some(t => /Undo: new shot/.test(t))), 'no "new shot" toast: ' + await p.evaluate(() => window.__toasts.join(' / ')));
  await p.click('#bRedo'); await settle(p, 150);
  ok(await p.evaluate(() => window.__shotref.state.shots.length === 2), 'redo did not bring the shot back');
  noErrors(p);
});

check('shots: an artifact-made file with three shots opens with all of them, each with its own move and length', async ({ open, downloads, freshContext }) => {
  const cam = (f, keys) => ({ base: { p: [3, 1.6, 6], tg: [0, 1, 0], f, roll: 0, fd: 7 }, keys: keys || [], shake: 0, lookAtId: null, follow: false, feel: 'gentle', dof: { on: false, fstop: 2.8, auto: true } });
  const k = (t, x, f) => ({ t, p: [x, 1.6, 6], tg: [0, 1, 0], f, roll: 0, fd: 7 });
  const c1 = cam(35), c2 = cam(50, [k(0, 0, 50), k(3, 2, 50)]), c3 = cam(24, [k(0, -1, 24), k(2, 1, 40)]);
  const file = { app: 'ShotRef', version: 1, state: { v: 1, meta: { id: 'm1', name: 'Trio' }, settings: { duration: 3 }, camera: c2,
    shots: [{ id: 'a', name: 'Wide', camera: c1, duration: 5 }, { id: 'b', name: 'Push in', camera: c2, duration: 3 }, { id: 'c', name: 'Reveal', camera: c3, duration: 2 }], shotId: 'b',
    objects: [{ id: 'p1', type: 'person', name: 'Person 1', color: '#3d6fd8', base: { p: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }, keys: [], opts: {} }] }, assets: {} };
  const p = await open();
  await openFile(p, 'trio.shotref.json', JSON.stringify(file)); await settle(p, 400);
  ok((await chipNames(p)).join() === 'Wide|5 s,Push in|3 s,Reveal|2 s', 'chips: ' + (await chipNames(p)).join());
  ok(await p.evaluate(() => document.querySelector('#shotBar .shotchip.on').firstChild.textContent) === 'Push in', 'active chip');
  let s = await stateOf(p);
  ok(s.settings.duration === 3 && s.camera.keys.length === 2 && s.camera.keys[0].f === 50, 'the live camera is not the active shot');
  await p.click('#shotBar .shotchip:not(.add) >> nth=2'); await settle(p, 200);
  s = await stateOf(p);
  ok(s.settings.duration === 2 && s.camera.keys[1].f === 40 && s.shotId === 'c', 'Reveal: ' + JSON.stringify([s.settings.duration, s.camera.keys.map(x => x.f)]));
  await p.click('#shotBar .shotchip:not(.add) >> nth=0'); await settle(p, 200);
  s = await stateOf(p);
  ok(s.settings.duration === 5 && s.camera.keys.length === 0 && s.camera.base.f === 35, 'Wide');
  await fileCmd(p, 'save');
  const saved = JSON.parse((await downloads(p).wait('.shotref')).text());
  ok(saved.state.shots.length === 3 && saved.state.shotId === 'a' && saved.state.shots[2].camera.keys.length === 2 && saved.state.shots[1].duration === 3, 'saved file lost shot data');
  const fc = await freshContext(); const q = await fc.open();
  await openFile(q, 'saved.shotref.json', JSON.stringify(saved)); await settle(q, 400);
  ok((await chipNames(q)).join() === 'Wide|5 s,Push in|3 s,Reveal|2 s', 'reopened chips: ' + (await chipNames(q)).join());
  noErrors(p);
});

check('shots: a shot stays after the page reloads (autosave)', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.click('#shotBar .shotchip.add'); await settle(p, 300);
  await p.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await p.reload(); await p.waitForFunction(() => window.__shotref && window.__shotref.state); await settle(p, 500);
  ok(await p.evaluate(() => (window.__shotref.state.shots || []).length) === 2, 'shots after reload: ' + await p.evaluate(() => JSON.stringify((window.__shotref.state.shots || []).map(s => s.name))));
});

check('Export step opens the Export panel (not a window) with output, this shot, all shots and the prompt', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.click('#bExport'); await settle(p, 200);
  ok(await p.evaluate(() => document.querySelector('#mExport').classList.contains('hidden')), 'the Export window opened');
  ok(await p.evaluate(() => window.__shotref.selected) === 'export', 'selected is ' + await p.evaluate(() => window.__shotref.selected));
  ok(await p.evaluate(() => window.__shotref.view) === 'camera', 'the Export step shows the camera view');
  ok(await p.evaluate(() => document.querySelector('#stepSeg .on').dataset.step) === 'export', 'step pill');
  const heads = await p.evaluate(() => [...document.querySelectorAll('#props .sec > h3')].map(x => x.textContent.replace(/\?$/, '')));
  for (const w of ['Export', 'This shot', 'All shots', 'Prompt for the AI model']) ok(heads.includes(w), 'no "' + w + '" section: ' + heads.join());
  const btns = await p.evaluate(() => [...document.querySelectorAll('#props button')].map(b => b.textContent.trim()));
  for (const w of ['Render video (MP4)', 'Frame pack (zip)', 'Current frame (PNG)', 'Copy frame', 'Video options…', 'Copy prompt', 'Rewrite from scene']) ok(btns.includes(w), 'no "' + w + '" button: ' + btns.join(' | '));
  ok(!btns.some(b => /^Every shot/.test(b)), 'Every shot offered with one shot');
  ok((await p.evaluate(() => document.querySelectorAll('#props .stylechips button').length)) === 4, 'four render style chips');
  await p.click('#props .stylechips button >> nth=1'); await settle(p, 150);
  ok(await p.evaluate(() => window.__shotref.state.settings.style) === 'clay', 'Clay chip did not set the style');
  ok(await p.evaluate(() => document.querySelector('#props .stylechips button.on').textContent.includes('Clay')), 'chip not marked');
  const sel = await p.evaluate(() => [...document.querySelectorAll('#props select')].map(s => s.options.length));
  ok(sel.length === 2 && sel[0] === 7 && sel[1] === 4, 'aspect and size dropdowns: ' + sel);
  await p.selectOption('#props select >> nth=0', '9:16'); await settle(p, 150);
  ok(await p.evaluate(() => window.__shotref.state.settings.aspect) === '9:16', 'aspect');
  const sum = await p.evaluate(() => document.querySelector('#props .sec .note').textContent);
  ok(/1080×1920/.test(sum), 'summary line: ' + sum);
  await p.click('#xoOptions'); await settle(p, 150);
  ok(await p.evaluate(() => !document.querySelector('#mExport').classList.contains('hidden')), 'Video options did not open the window');
  await p.keyboard.press('Escape');
  await p.keyboard.press('Escape'); await settle(p, 150);
  ok(await p.evaluate(() => document.querySelector('#stepSeg .on').dataset.step) !== 'export', 'Esc should leave the Export step');
  await p.keyboard.press('3'); await settle(p, 150);
  ok(await p.evaluate(() => window.__shotref.selected) === 'export', 'key 3');
  await p.click('#stepSeg [data-step="build"]'); await settle(p, 150);
  ok(await p.evaluate(() => window.__shotref.selected) === null && await p.evaluate(() => window.__shotref.view) === 'editor', 'Build leaves the panel');
  noErrors(p);
});

check('Export panel offers Every shot and Contact sheet once there are two shots', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.click('#shotBar .shotchip.add'); await settle(p, 150);
  await p.click('#bExport'); await settle(p, 200);
  const btns = await p.evaluate(() => [...document.querySelectorAll('#props button')].map(b => b.textContent.trim()));
  ok(btns.includes('Every shot (2 videos)') && btns.includes('Contact sheet'), btns.join(' | '));
  ok((await p.evaluate(() => document.querySelector('#props .sec .note').textContent)).includes('Shot 2'), 'summary names the shot');
  noErrors(p);
});

check('prompt: written from the scene (size, lens, angle, move, who does what, light, aspect and length)', async ({ open }) => {
  const p = await open(); await promptScene(p);
  let t = await p.evaluate(() => window.__shotref.promptText());
  ok(/^[A-Z][A-Za-z -]* of the man in a blue top, 50mm normal lens, eye level\./.test(t), 'opening: ' + t);
  ok(/The camera stays locked off \(static camera\)\./.test(t), 'static: ' + t);
  ok(/A man in a blue top stands in the centre of frame\./.test(t), 'person: ' + t);
  ok(/Daylight, high sun|Low sun|Golden hour/i.test(t) && /16:9, 5 seconds\.$/.test(t), 'light/aspect: ' + t);
  await p.evaluate(() => { const S = window.__shotref; S.addObject('car', null, false, [0, 0, -3]); S.changed(true, true); });
  t = await p.evaluate(() => window.__shotref.promptText());
  ok(/A red car is parked in the (centre|left|right) of frame./.test(t), 'car: ' + t);
  await p.evaluate(() => { const S = window.__shotref; S.applyMove('dollyIn'); S.state.camera.shake = 1; S.ensureDof().on = true; S.ensureDof().fstop = 1.8; S.setLookAt(S.state.objects[0], 'camera'); S.state.settings.sunEl = 6; S.state.settings.env = 'sunset'; S.changed(true, true); });
  t = await p.evaluate(() => window.__shotref.promptText());
  ok(/The camera dollies in/.test(t) && /handheld with a slight shake/.test(t), 'move/shake: ' + t);
  ok(/Shallow depth of field, strong background blur\./.test(t), 'dof: ' + t);
  ok(/looking into the camera/.test(t), 'eyeline: ' + t);
  ok(/[Ss]un on the horizon, (front light|backlight|side light from the (left|right)), long shadows\./.test(t), 'light: ' + t);
  /* a walking man and a car */
  await p.evaluate(() => { const S = window.__shotref; const o = S.state.objects[0]; o.keys = [{ t: 0, p: [-2, 0, 0], r: [0, 90, 0], s: [1, 1, 1] }, { t: 4, p: [2, 0, 0], r: [0, 90, 0], s: [1, 1, 1] }]; o.opts.pose = 'walk'; o.opts.lookAt = null;
    S.changed(true, true); });
  t = await p.evaluate(() => window.__shotref.promptText());
  ok(/walks (from the left of frame to the right of frame|from left to right)/.test(t), 'walk: ' + t);
  noErrors(p);
});

check('prompt: your edits stay until you press Rewrite from scene', async ({ open }) => {
  const p = await open(); await promptScene(p);
  await p.click('#bExport'); await settle(p, 200);
  const orig = await p.inputValue('#props textarea.promptbox');
  ok(orig.length > 60 && orig === await p.evaluate(() => window.__shotref.promptText()), 'box holds the written prompt');
  await p.fill('#props textarea.promptbox', 'My own words.');
  await p.selectOption('#props select >> nth=0', '1:1'); await settle(p, 200);
  ok(await p.inputValue('#props textarea.promptbox') === 'My own words.', 'the edit was lost when the panel rebuilt');
  await p.keyboard.press('Escape'); await p.keyboard.press('3'); await settle(p, 200);
  ok(await p.inputValue('#props textarea.promptbox') === 'My own words.', 'the edit was lost when the panel reopened');
  await p.click('#xoRewrite'); await settle(p, 150);
  const v = await p.inputValue('#props textarea.promptbox');
  ok(v !== 'My own words.' && /1:1, 5 seconds\.$/.test(v), 'rewrite: ' + v);
  await p.evaluate(TOAST_LOG);
  await p.click('#xoCopyPrompt'); await settle(p, 300);
  ok(await p.evaluate(() => window.__toasts.some(t => /Prompt copied|Ctrl\+C/.test(t))), 'no copy toast: ' + await p.evaluate(() => window.__toasts.join(' / ')));
  noErrors(p);
});

check('frame pack: a zip with the start, middle and end frames and the prompt opens and every file is intact', async ({ open, downloads }) => {
  const p = await open(); await promptScene(p);
  await p.evaluate(() => { const S = window.__shotref; S.applyMove('orbitL'); S.state.settings.size = 1280; S.changed(true, true); });
  await p.click('#bExport'); await p.click('#xoPack');
  const z = await downloads(p).wait('.zip', 30000);
  ok(/^shotref-shaded-\d{8}-\d{4}-frames\.zip$/.test(z.name), 'zip name ' + z.name);
  const files = readZip(z.bytes), names = files.map(f => f.name);
  ok(files.length === 4, 'files: ' + names.join());
  for (const w of ['-1-start.png', '-2-middle.png', '-3-end.png', '-prompt.txt']) ok(names.some(n => n.endsWith(w) && n.startsWith('shotref-shaded-')), 'missing ' + w + ' in ' + names.join());
  const png = n => files.find(f => f.name.endsWith(n)).data;
  for (const n of ['-1-start.png', '-2-middle.png', '-3-end.png']) { const s = pngSize(png(n)); ok(s.sig === '89504e47' && s.w === 1280 && s.h === 720, n + ' ' + JSON.stringify(s)); }
  ok(!png('-1-start.png').equals(png('-3-end.png')) && !png('-1-start.png').equals(png('-2-middle.png')), 'the three frames are identical: the camera did not move between them');
  const txt = files.find(f => f.name.endsWith('-prompt.txt')).data.toString('utf8');
  ok(txt === (await p.evaluate(() => window.__shotref.promptText())) + '\n', 'prompt.txt differs from the prompt: ' + txt);
  noErrors(p);
});

check('frame pack: your edited prompt goes into the zip, and the shot name into the file names', async ({ open, downloads }) => {
  const p = await open(); await promptScene(p);
  await p.click('#shotBar .shotchip.add'); await settle(p, 150);
  await p.evaluate(() => { window.__shotref.state.settings.size = 1280; window.__shotref.changed(true, true); });
  await p.click('#bExport'); await p.fill('#props textarea.promptbox', 'Hand written prompt for Kling.');
  await p.click('#xoPack');
  const z = await downloads(p).wait('.zip', 30000);
  ok(/^shotref-Shot_2-shaded-/.test(z.name), 'zip name ' + z.name);
  const files = readZip(z.bytes);
  ok(files.every(f => f.name.startsWith('shotref-Shot_2-shaded-')), files.map(f => f.name).join());
  ok(files.find(f => f.name.endsWith('-prompt.txt')).data.toString('utf8') === 'Hand written prompt for Kling.\n', 'prompt not the edited one');
  noErrors(p);
});

check('frame pack: stops with one message after a failed frame', async ({ open }) => {
  const p = await open();
  await p.evaluate(TOAST_LOG);
  await p.evaluate(() => { HTMLCanvasElement.prototype.toBlob = function (cb) { cb(null); }; });
  await p.click('#bExport'); await p.click('#xoPack');
  await p.waitForTimeout(1500);
  const n = await p.evaluate(() => window.__toasts.filter(t => /Could not make that frame/.test(t)).length);
  ok(n === 1, 'error toast shown ' + n + ' times');
  ok(await p.evaluate(() => (window.__dl || []).length) === 0, 'a zip was saved anyway');
  noPageErrors(p);
});

check('current frame (PNG) names the shot when there are several', async ({ open, downloads }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => { window.__shotref.state.settings.size = 1280; window.__shotref.changed(true, true); });
  await p.click('#bExport'); await p.click('#xoPng');
  const a = await downloads(p).wait('.png', 30000);
  ok(!/Shot/.test(a.name), 'one shot: no shot name: ' + a.name);
  await p.keyboard.press('Escape');
  await p.click('#shotBar .shotchip.add'); await settle(p, 150);
  await p.evaluate(() => { window.__dl.length = 0; });
  await p.click('#bExport'); await p.click('#xoPng');
  const b = await downloads(p).wait('.png', 30000);
  ok(/^shotref-Shot_2-frame0001-shaded-/.test(b.name), 'name ' + b.name);
  noErrors(p);
});

check('contact sheet: first and last frame of every shot on one PNG, and the shots are left as they were', async ({ open, downloads }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => { const S = window.__shotref; S.applyMove('dollyIn'); S.changed(true, true); });
  await p.click('#shotBar .shotchip.add'); await settle(p, 150);
  await p.evaluate(() => { const S = window.__shotref; S.applyMove('craneUp'); S.state.meta = { id: 'm', name: 'Alley' }; S.changed(true, true); });
  await p.click('#shotBar .shotchip:not(.add) >> nth=0'); await settle(p, 150);
  await p.evaluate(() => window.__shotref.setT(1.5));
  const before = await p.evaluate(() => JSON.stringify([window.__shotref.state.shotId, window.__shotref.state.camera, window.__shotref.state.settings.duration]));
  await p.click('#bExport'); await p.click('#xoSheet');
  await p.waitForFunction(() => !document.querySelector('#mSheet').classList.contains('hidden'), null, { timeout: 20000 });
  await p.waitForFunction(() => { const i = document.querySelector('#sheetImg'); return i.complete && i.naturalWidth > 0; });
  const d = await p.evaluate(() => { const i = document.querySelector('#sheetImg'); return { src: i.src.slice(0, 22), w: i.naturalWidth, h: i.naturalHeight }; });
  ok(d.src === 'data:image/png;base64,' && d.w === 1028 && d.h === 544, 'sheet image ' + JSON.stringify(d));
  ok(await p.evaluate(() => window.__shotref.T) === 1.5, 'the playhead moved');
  ok(await p.evaluate(b => JSON.stringify([window.__shotref.state.shotId, window.__shotref.state.camera, window.__shotref.state.settings.duration]) === b, before), 'the active shot changed');
  const diff = await p.evaluate(() => { const i = document.querySelector('#sheetImg'), c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight; const g = c.getContext('2d'); g.drawImage(i, 0, 0); const px = (x, y, w, h) => g.getImageData(x, y, w, h).data; const a = px(16 + 376, 50, 360, 203), b = px(16 + 376, 50 + 247, 360, 203); let n = 0; for (let k = 0; k < a.length; k += 4) if (Math.abs(a[k] - b[k]) + Math.abs(a[k + 1] - b[k + 1]) > 12) n++; return n; });
  ok(diff > 500, 'the last frames of the two shots look the same on the sheet (' + diff + ' px differ)');
  await p.screenshot({ path: process.env.G_SHOTS ? path.join(process.env.G_SHOTS, 'g-sheet.png') : undefined });
  await p.click('#sheetSave');
  const png = await downloads(p).wait('.png', 20000);
  ok(/contact-sheet/.test(png.name) && pngSize(png.bytes).w === 1028, 'saved ' + png.name);
  noErrors(p);
});

check('every shot renders one video per shot, named after the shot, with each shot\'s own length', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => { const S = window.__shotref; S.state.settings.size = 1280; S.state.settings.duration = 1; S.changed(true, true); });
  await p.click('#shotBar .shotchip.add'); await settle(p, 150);
  await p.evaluate(() => { const S = window.__shotref; S.state.settings.duration = 2; S.changed(true, true); });
  await p.click('#shotBar .shotchip:not(.add) >> nth=0'); await settle(p, 150);
  await p.click('#bExport'); await p.click('#xoAll');
  await p.waitForFunction(() => (window.__dl || []).filter(d => /\.(mp4|webm)$/.test(d.name)).length === 2, null, { timeout: 90000 });
  const dl = await p.evaluate(() => window.__dl.map(d => ({ name: d.name, size: d.size })));
  ok(/Shot_1/.test(dl[0].name) && /Shot_2/.test(dl[1].name) && dl.every(d => d.size > 1000), JSON.stringify(dl));
  await p.waitForFunction(() => document.querySelector('#exCancel').hidden, null, { timeout: 10000 });
  const s = await stateOf(p);
  ok(s.shotId === s.shots[0].id && s.settings.duration === 1, 'the first shot is not active again: ' + JSON.stringify([s.shotId, s.settings.duration]));
  ok(await p.evaluate(() => [...document.body.children].every(e => !e.inert)), 'page still locked');
  noErrors(p);
}, { timeout: 120000 });

/* ---- batch G fix round 1 ---- */
const keyedBox = p => p.evaluate(() => { const S = window.__shotref, o = S.addObject('box'); S.setKey(o.keys, 0, { p: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }); S.setKey(o.keys, 4, { p: [4, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }); S.changed(true, true); return o.id; });
check('shot length: with one shot the whole animation still stretches', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const id = await keyedBox(p);
  await p.fill('#inDur', '10'); await p.press('#inDur', 'Enter'); await settle(p, 200);
  const o = await objOf(p, id);
  ok(Math.abs(o.keys[1].t - 8) < 0.1, 'object key at ' + o.keys[1].t + ', expected about 8');
  ok(await p.evaluate(() => !document.querySelector('#lenNote')), 'the note shows with one shot');
});
check('shot length: with two shots only this shot camera is re-timed; the action stays the same', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const id = await keyedBox(p);
  await p.evaluate(() => { const S = window.__shotref; S.applyMove('dollyIn'); S.changed(true, true); });
  await p.click('#shotBar .shotchip.add'); await settle(p, 150);
  await p.evaluate(() => { const S = window.__shotref; S.applyMove('craneUp'); S.changed(true, true); });
  await p.fill('#inDur', '10'); await p.press('#inDur', 'Enter'); await settle(p, 200);
  let s = await stateOf(p);
  ok(s.settings.duration === 10 && Math.max(...s.camera.keys.map(k => k.t)) > 8, 'shot 2 camera should stretch to about 10 s: ' + JSON.stringify(s.camera.keys.map(k => k.t)));
  const o = await objOf(p, id);
  ok(o.keys[1].t === 4, 'the shared action was re-timed: ' + o.keys[1].t);
  ok(s.shots[0].duration === 5 && Math.max(...s.shots[0].camera.keys.map(k => k.t)) <= 5, 'shot 1 changed: ' + s.shots[0].duration);
  ok(/Changes this shot's camera move only. The action stays the same in every shot./.test(await p.evaluate(() => (document.querySelector('#lenNote') || {}).textContent || '')), 'no note under the length control');
  noErrors(p);
});
check('contact sheet and frame pack lock the page while they build, and unlock afterwards (also on failure)', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.click('#shotBar .shotchip.add'); await settle(p, 150);
  await p.evaluate(() => { window.__locked = []; const orig = HTMLCanvasElement.prototype.toDataURL; HTMLCanvasElement.prototype.toDataURL = function () { window.__locked.push([...document.body.children].some(e => e.inert)); return orig.apply(this, arguments); }; });
  await p.click('#bExport'); await p.click('#xoSheet');
  await p.waitForFunction(() => !document.querySelector('#mSheet').classList.contains('hidden'), null, { timeout: 20000 });
  const l = await p.evaluate(() => window.__locked);
  ok(l.length >= 2 && l.slice(0, 2).every(Boolean), 'page not locked while rendering: ' + JSON.stringify(l));
  ok(await p.evaluate(() => [...document.body.children].every(e => !e.inert)), 'still locked after the sheet');
  await p.keyboard.press('Escape');
  await p.evaluate(() => { window.__lk = []; HTMLCanvasElement.prototype.toBlob = function (cb) { window.__lk.push([...document.body.children].some(e => e.inert)); cb(null); }; });
  await p.click('#xoPack'); await settle(p, 800);
  ok(await p.evaluate(() => window.__lk[0]) === true, 'frame pack not locked while rendering');
  ok(await p.evaluate(() => [...document.body.children].every(e => !e.inert)), 'still locked after a failed pack');
  noPageErrors(p);
});

/* ---- batch H: takes ---- */
const takeCmd = (p, cmd) => menuCmd(p, '#bTake', cmd);
const nObj = p => p.evaluate(() => window.__shotref.state.objects.length);
const addBoxes = (p, n) => p.evaluate(n => { const S = window.__shotref; for (let i = 0; i < n; i++) S.addObject('box'); S.changed(true, true); }, n);
const undoN = async (p, n) => { for (let i = 0; i < n; i++) { await p.click('#bUndo'); await p.waitForTimeout(60); } };
const takeNames = p => p.evaluate(() => (window.__shotref.state.takes || []).map(t => t.name));
const takeBtnText = p => p.evaluate(() => document.querySelector('#bTake').textContent.trim());
const snapObjs = (p, name) => p.evaluate(n => { const t = window.__shotref.state.takes.find(x => x.name === n); return t && t.snap ? JSON.parse(t.snap).objects.length : -1; }, name);
check('takes: a Take button sits between the project name and File, and says Take 1 on a plain project', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const order = await p.evaluate(() => [...document.querySelector('#top').querySelectorAll('#projName, #bTake, #bFile')].map(e => e.id).join());
  ok(order === 'projName,bTake,bFile', 'top bar order: ' + order);
  ok(await takeBtnText(p) === 'Take 1', 'label: ' + await takeBtnText(p));
  await p.click('#bTake');
  const items = await p.evaluate(() => [...document.querySelectorAll('#ctxMenu button')].map(b => ({ c: b.dataset.cmd || '', t: b.textContent.trim(), d: b.disabled })));
  ok(items.some(i => /^New take/.test(i.t)) && items.some(i => /^Rename this take/.test(i.t)) && items.some(i => /^Compare takes/.test(i.t) && i.d) && items.some(i => /^Delete this take/.test(i.t) && i.d) && items.some(i => /^Duplicate this take/.test(i.t)), JSON.stringify(items));
  ok(await p.evaluate(() => !window.__shotref.state.takes), 'just opening the menu changed the project');
  noErrors(p);
});
check('takes: New take is a copy that becomes the active take; the first take stays as it was', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const n0 = await nObj(p);
  await takeCmd(p, 'newtake'); await settle(p, 200);
  ok(await takeBtnText(p) === 'Take 2', 'label ' + await takeBtnText(p));
  const s = await stateOf(p);
  ok(s.takes.length === 2 && s.takeId === s.takes[1].id && s.takes[1].snap === null && typeof s.takes[0].snap === 'string', 'shape ' + JSON.stringify(s.takes.map(t => [t.name, typeof t.snap])));
  ok(await nObj(p) === n0, 'the copy has different content');
  await addBoxes(p, 2); await settle(p, 100);
  await takeCmd(p, 'take:' + s.takes[0].id); await settle(p, 300);
  ok(await takeBtnText(p) === 'Take 1' && await nObj(p) === n0, 'Take 1 changed: ' + await nObj(p));
  ok(await snapObjs(p, 'Take 2') === n0 + 2, 'Take 2 not kept');
  ok(await p.evaluate(() => window.__shotref.state.takes.find(t => t.id === window.__shotref.state.takeId).snap === null), 'active take keeps a stale copy');
  noErrors(p);
});
check('takes: switching, new, rename and delete are undo steps; undo and redo never lose or mix up a take', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const n0 = await nObj(p);                       /* Take 1: n0 objects */
  await takeCmd(p, 'newtake'); await addBoxes(p, 2);        /* Take 2: n0+2 */
  const ids = (await stateOf(p)).takes.map(t => t.id);
  await takeCmd(p, 'take:' + ids[0]); await settle(p, 150);
  await addBoxes(p, 1);                           /* Take 1 edited: n0+1 */
  ok(await nObj(p) === n0 + 1, 'edit lost');
  await undoN(p, 1);                              /* edit undone */
  ok(await nObj(p) === n0, 'undo of the edit: ' + await nObj(p));
  await undoN(p, 1);                              /* switch undone: back in Take 2 */
  let s = await stateOf(p);
  ok(s.takeId === ids[1] && await takeBtnText(p) === 'Take 2' && await nObj(p) === n0 + 2, 'undo of a switch: ' + s.takeId + ' ' + await nObj(p));
  ok(await snapObjs(p, 'Take 1') === n0, 'Take 1 mixed up after undo: ' + await snapObjs(p, 'Take 1'));
  await takeCmd(p, 'take:' + ids[0]); await settle(p, 150);   /* switch again (history after undo is cut) */
  ok(await nObj(p) === n0, 'Take 1 shows the undone edit: ' + await nObj(p));
  await undoN(p, 1); await p.click('#bRedo'); await settle(p, 100);
  ok(await nObj(p) === n0 && (await stateOf(p)).takeId === ids[0], 'redo of a switch');
  /* rename and delete */
  await takeCmd(p, 'renametake'); await p.fill('#nmInput', 'Wide version'); await p.click('#nmOk'); await settle(p, 100);
  ok((await takeNames(p)).includes('Wide version') && await takeBtnText(p) === 'Wide version', 'rename: ' + await takeBtnText(p));
  await undoN(p, 1);
  ok((await takeNames(p)).join() === 'Take 1,Take 2', 'undo rename: ' + (await takeNames(p)).join());
  await takeCmd(p, 'take:' + ids[1]); await settle(p, 150);
  await takeCmd(p, 'deltake'); await settle(p, 200);
  s = await stateOf(p);
  ok(s.takes.length === 1 && s.takeId === ids[0] && await nObj(p) === n0, 'delete: ' + JSON.stringify([s.takes.length, await nObj(p)]));
  await undoN(p, 1); await settle(p, 100);
  s = await stateOf(p);
  ok(s.takes.length === 2 && s.takeId === ids[1] && await nObj(p) === n0 + 2, 'undo delete: ' + JSON.stringify([s.takes.length, await nObj(p)]));
  ok(await snapObjs(p, 'Take 1') === n0, 'Take 1 after undo delete');
  noErrors(p);
});
check('takes: many switches and edits, then undo part of the way back, keep every take exact', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const n0 = await nObj(p);
  await takeCmd(p, 'newtake'); await takeCmd(p, 'newtake');
  const ids = (await stateOf(p)).takes.map(t => t.id);
  const expect = [n0, n0, n0];
  for (let i = 0; i < 30; i++) {
    const k = i % 3;
    await p.evaluate(id => window.__shotref.switchTake(id), ids[k]);
    await addBoxes(p, 1); expect[k]++;
  }
  ok(await p.evaluate(() => window.__shotref.snapPoolSize()) <= 40, 'copies pile up in the undo pool: ' + await p.evaluate(() => window.__shotref.snapPoolSize()));
  await undoN(p, 12);
  /* undone 12 steps = the last 6 loop passes (a switch and an edit each) */
  const want = [...expect]; for (let i = 24; i < 30; i++) want[i % 3]--;
  for (let k = 0; k < 3; k++) {
    await p.evaluate(id => window.__shotref.switchTake(id), ids[k]);
    ok(await nObj(p) === want[k], 'take ' + k + ' has ' + await nObj(p) + ', expected ' + want[k]);
  }
  noErrors(p);
}, { timeout: 90000 });
check('takes: undo snapshots leave the inactive takes out (3 takes of a 50-object scene stay small)', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await addBoxes(p, 50);
  await p.evaluate(() => { const S = window.__shotref; S.state.objects.forEach((o, i) => { o.base.p = [i * 0.5, 0, i * 0.3]; }); S.changed(true, true); });
  await takeCmd(p, 'newtake'); await takeCmd(p, 'newtake'); await settle(p, 200);
  await addBoxes(p, 1);
  const m = await p.evaluate(() => { const S = window.__shotref; return { step: S.history.bytes, full: JSON.stringify(S.state).length, live: JSON.stringify({ ...S.state, takes: undefined }).length, takes: S.state.takes.length }; });
  ok(m.takes === 3 && m.full > 2.5 * m.live, 'setup: ' + JSON.stringify(m));
  ok(m.step < 1.25 * m.live, 'an undo step holds the inactive takes: ' + JSON.stringify(m));
  noErrors(p);
});
check('takes: save then open keeps every take exactly (and the active scene)', async ({ open, freshContext, downloads }) => {
  const a = await open(); await settle(a, 300);
  await addBoxes(a, 3);
  await takeCmd(a, 'newtake'); await addBoxes(a, 2); await a.evaluate(() => window.__shotref.applyMove('dollyIn'));
  await takeCmd(a, 'newtake'); await a.evaluate(() => { const S = window.__shotref; S.state.objects.pop(); S.state.settings.style = 'clay'; S.changed(true, true); });
  const ids = (await stateOf(a)).takes.map(t => t.id);
  await takeCmd(a, 'take:' + ids[1]); await settle(a, 200);
  const before = await stateOf(a);
  await fileCmd(a, 'save');
  const file = await downloads(a).wait('.shotref');
  const fc = await freshContext(); const b = await fc.open();
  await openFile(b, file.name, file.text());
  await b.waitForFunction(n => window.__shotref.state.takes && window.__shotref.state.takes.length === n, 3);
  const after = await stateOf(b);
  ok(canon(after) === canon(before), 'saved and reopened project differs');
  for (const t of before.takes) { const u = after.takes.find(x => x.id === t.id); ok(u && u.name === t.name && u.snap === t.snap, 'take ' + t.name + ' changed'); }
  await takeCmd(b, 'take:' + ids[2]); await settle(b, 200);
  ok((await stateOf(b)).settings.style === 'clay', 'Take 3 content lost');
  noErrors(b);
});
check('takes: the autosave keeps all takes', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await takeCmd(p, 'newtake'); await addBoxes(p, 2); await settle(p, 900);
  const n = await nObj(p);
  await p.reload(); await p.waitForFunction(() => window.__shotref && window.__shotref.state); await settle(p, 500);
  const s = await stateOf(p);
  ok(s.takes && s.takes.length === 2 && s.takeId === s.takes[1].id && s.objects.length === n && typeof s.takes[0].snap === 'string', 'after reload: ' + JSON.stringify(s.takes && s.takes.map(t => [t.name, typeof t.snap])));
  noErrors(p);
});
check('takes: an artifact-made file with takes opens with all of them; the stale copy of the active take is dropped', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const cam = { base: JSON.parse(CAM_BASE), keys: [], feel: 'gentle', shake: 0, lookAtId: null, follow: false, dof: { on: false, fstop: 2.8, auto: true } };
  const scene = n => ({ settings: {}, camera: cam, objects: Array.from({ length: n }, (_, i) => ({ id: 'o' + n + i, type: 'box', name: 'Box ' + i, color: '#888888', opts: {}, base: { p: [i, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }, keys: [], visible: true })), plate: null });
  const file = { app: 'ShotRef', version: 1, state: { ...scene(2), v: 1, takes: [{ id: 'ta', name: 'Hero', snap: JSON.stringify(scene(9)) }, { id: 'tb', name: 'Alt', snap: JSON.stringify(scene(4)) }, { id: 'tc', name: 'Wide', snap: JSON.stringify(scene(1)) }], takeId: 'ta' }, assets: {} };
  await openFile(p, 'art.shotref', JSON.stringify(file));
  const s = await stateOf(p);
  ok(s.takes.length === 3 && s.takeId === 'ta' && s.takes[0].snap === null && s.objects.length === 2, 'opened: ' + JSON.stringify([s.takes.map(t => t.name), s.objects.length]));
  ok(await takeBtnText(p) === 'Hero', 'label ' + await takeBtnText(p));
  await takeCmd(p, 'take:tb'); await settle(p, 200);
  ok(await nObj(p) === 4 && await takeBtnText(p) === 'Alt', 'Alt not loaded');
  await takeCmd(p, 'take:ta'); await settle(p, 200);
  ok(await nObj(p) === 2, 'switching back gives ' + await nObj(p));
  const lab = await p.evaluate(() => document.querySelector('#bUndo').title);
  ok(/switch to Hero/i.test(lab), 'undo title: ' + lab);
  noErrors(p);
});
check('takes: a photo used only by an inactive take is kept in the saved file', async ({ open, downloads }) => {
  const p = await open(); await settle(p, 300);
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const id = await p.evaluate(png => { const S = window.__shotref; S.assets.photo1 = { kind: 'image', name: 'a.png', b64: png, mime: 'image/png' }; const o = S.addObject('image', { asset: 'photo1' }); S.changed(true, true); return o.id; }, PNG);
  await takeCmd(p, 'newtake');
  await p.evaluate(i => { const S = window.__shotref; S.state.objects = S.state.objects.filter(o => o.id !== i); S.changed(true, true); }, id);
  await fileCmd(p, 'save');
  const f = JSON.parse((await downloads(p).wait('.shotref')).text());
  ok(f.assets.photo1, 'asset of the inactive take dropped from the file: ' + Object.keys(f.assets));
});
check('compare takes: needs two takes; renders both without blob: URLs, locks the page, plays side by side, and Use right take switches', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => { window.__locked = []; const orig = HTMLCanvasElement.prototype.toDataURL; HTMLCanvasElement.prototype.toDataURL = function () { window.__locked.push([...document.body.children].some(e => e.inert)); return orig.apply(this, arguments); }; });
  await p.click('#bTake');
  ok(await p.evaluate(() => document.querySelector('#ctxMenu [data-cmd="compare"]').disabled), 'compare offered with one take');
  await p.keyboard.press('Escape');
  const n0 = await nObj(p);
  await takeCmd(p, 'newtake'); await addBoxes(p, 3); await p.evaluate(() => window.__shotref.applyMove('dollyIn')); await settle(p, 200);
  const before = await stateOf(p);
  await takeCmd(p, 'compare');
  await p.waitForFunction(() => !document.querySelector('#mCompare').classList.contains('hidden'));
  await p.waitForFunction(() => !document.querySelector('#cmpView').hidden, null, { timeout: 30000 });
  const info = await p.evaluate(() => ({ a: document.querySelector('#cmpImgA').src.slice(0, 22), b: document.querySelector('#cmpImgB').src.slice(0, 22), la: document.querySelector('#cmpLA').textContent, lb: document.querySelector('#cmpLB').textContent, opts: [...document.querySelectorAll('#cmpA option')].map(o => o.textContent), locked: window.__locked.slice(), inert: [...document.body.children].some(e => e.inert), cmpInert: document.querySelector('#mCompare').inert }));
  ok(/^data:image\//.test(info.a) && /^data:image\//.test(info.b), 'not data: URLs ' + info.a + ' ' + info.b);
  ok(info.opts.join() === 'Take 1,Take 2' && /^Take 2/.test(info.la) && /^Take 1/.test(info.lb), 'labels ' + JSON.stringify(info));
  ok(info.locked.length >= 4 && info.locked.every(Boolean), 'page not locked while rendering: ' + JSON.stringify(info.locked));
  ok(!info.inert && !info.cmpInert, 'still locked afterwards');
  ok(canon(await stateOf(p)) === canon(before), 'rendering changed the live scene');
  const a1 = await p.evaluate(() => { const l = document.querySelector('#cmpPlay'); if (l.textContent.trim() !== '▶') l.click(); return document.querySelector('#cmpImgA').src; });
  await p.evaluate(() => { const r = document.querySelector('#cmpScrub'); r.value = 1; r.dispatchEvent(new Event('input', { bubbles: true })); });
  await settle(p, 200);
  const a2 = await p.evaluate(() => document.querySelector('#cmpImgA').src);
  ok(a1 !== a2, 'scrub bar did not change the frame');
  ok(await p.evaluate(() => document.querySelector('#cmpImgA').src !== document.querySelector('#cmpImgB').src), 'both takes look the same');
  await p.click('#cmpUseB'); await settle(p, 300);
  ok(await takeBtnText(p) === 'Take 1' && await nObj(p) === n0, 'Use right take: ' + await takeBtnText(p));
  ok(await p.evaluate(() => document.querySelector('#mCompare').classList.contains('hidden')), 'dialog stays open');
  noErrors(p);
}, { timeout: 90000 });
check('compare takes: a failure while rendering puts the scene back and unlocks the page', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await takeCmd(p, 'newtake'); await addBoxes(p, 2); await settle(p, 100);
  const before = await stateOf(p);
  await p.evaluate(() => { HTMLCanvasElement.prototype.toDataURL = function () { throw new Error('boom'); }; });
  await takeCmd(p, 'compare'); await settle(p, 1500);
  ok(await p.evaluate(() => [...document.body.children].every(e => !e.inert)), 'page stays locked after a failed render');
  ok(canon(await stateOf(p)) === canon(before), 'scene changed after a failed render');
  ok(await p.evaluate(() => /Could not/.test(document.querySelector('#cmpMsg').textContent)), 'no plain message: ' + await p.evaluate(() => document.querySelector('#cmpMsg').textContent));
});

/* ---- batch H fix round 1 ---- */
check('takes: 16 rounds of switch + edit, undo into the middle, 16 more rounds (the pool prunes); undo to the start and redo to the end keep every take exact (also after an autosave restore)', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await takeCmd(p, 'newtake'); await takeCmd(p, 'newtake');
  const ids = (await stateOf(p)).takes.map(t => t.id);
  const counts = () => p.evaluate(() => { const S = window.__shotref, st = S.state, r = {}; for (const t of st.takes) r[t.id] = t.id === st.takeId ? st.objects.length : JSON.parse(t.snap).objects.length; return { r, active: st.takeId, names: st.takes.map(t => t.name).join() }; });
  const at = () => p.evaluate(() => window.__shotref.history.at);
  const rounds = async k => { for (let i = 0; i < 16; i++) { await p.evaluate(id => window.__shotref.switchTake(id), ids[(i + k) % 3]); await addBoxes(p, 1 + (i % 2)); } };
  const start = await counts(), at0 = await at();
  await rounds(0);
  await undoN(p, 20);
  const mid = await counts(), atMid = await at();
  await rounds(1);
  const end = await counts(), atEnd = await at();
  ok(await p.evaluate(() => window.__shotref.snapPruned()) > 0, 'the pool never pruned, so this does not test pruning');
  ok(end.names === start.names, 'a take went missing: ' + end.names);
  await undoN(p, atEnd - atMid);
  ok(canon(await counts()) === canon(mid), 'back in the middle: ' + JSON.stringify(await counts()) + ' vs ' + JSON.stringify(mid));
  await undoN(p, atMid - at0);
  ok(canon(await counts()) === canon(start), 'after undo to the start: ' + JSON.stringify(await counts()) + ' vs ' + JSON.stringify(start));
  for (let i = 0; i < atEnd - at0; i++) { await p.click('#bRedo'); await p.waitForTimeout(40); }
  ok(canon(await counts()) === canon(end), 'after redo to the end: ' + JSON.stringify(await counts()) + ' vs ' + JSON.stringify(end));
  await settle(p, 900);
  await p.reload(); await p.waitForFunction(() => window.__shotref && window.__shotref.state); await settle(p, 500);
  ok(canon(await counts()) === canon(end), 'after the autosave restore: ' + JSON.stringify(await counts()));
  noErrors(p);
}, { timeout: 120000 });
check('takes: a take whose copy cannot be read is kept as it is, shown disabled, and is saved back byte for byte', async ({ open, freshContext, downloads }) => {
  const p = await open(); await settle(p, 300);
  const cam = { base: JSON.parse(CAM_BASE), keys: [], feel: 'gentle', shake: 0, lookAtId: null, follow: false, dof: { on: false, fstop: 2.8, auto: true } };
  const bad = '{"objects": [broken  é ';
  const file = { app: 'ShotRef', version: 1, state: { settings: {}, camera: cam, objects: [], plate: null, v: 1, takes: [{ id: 't1', name: 'Good', snap: null }, { id: 't2', name: 'Damaged', snap: bad }], takeId: 't1' }, assets: {} };
  await openFile(p, 'bad.shotref', JSON.stringify(file));
  const s = await stateOf(p);
  ok(s.takes.length === 2 && s.takes[1].snap === bad, 'damaged take lost or changed: ' + JSON.stringify(s.takes));
  await p.click('#bTake');
  const it = await p.evaluate(() => { const b = document.querySelector('#ctxMenu [data-cmd="take:t2"]'); return b && { t: b.textContent.trim(), d: b.disabled }; });
  ok(it && /can't be opened/.test(it.t) && it.d, 'menu item: ' + JSON.stringify(it));
  ok(await p.evaluate(() => document.querySelector('#ctxMenu [data-cmd="compare"]').disabled), 'compare offered with one readable take');
  await p.keyboard.press('Escape');
  await takeCmd(p, 'newtake');
  await p.click('#bTake');
  ok(await p.evaluate(() => !document.querySelector('#ctxMenu [data-cmd="compare"]').disabled), 'compare should be offered (two readable takes)');
  await p.keyboard.press('Escape');
  await fileCmd(p, 'save');
  const f = JSON.parse((await downloads(p).wait('.shotref')).text());
  ok(f.state.takes.find(t => t.id === 't2').snap === bad, 'damaged copy not saved back exactly');
  const fc = await freshContext(); const b = await fc.open();
  await openFile(b, 'again.shotref', JSON.stringify(f));
  ok((await stateOf(b)).takes.find(t => t.id === 't2').snap === bad, 'damaged copy lost on reopen');
  noErrors(b);
});
check('takes: a take whose copy cannot be read can still be deleted from the menu', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await takeCmd(p, 'newtake');
  const id = await p.evaluate(() => { const S = window.__shotref; S.state.takes[0].snap = '{nope'; S.changed(true, true); return S.state.takes[0].id; });
  await takeCmd(p, 'deltake:' + id); await settle(p, 200);
  ok((await stateOf(p)).takes.length === 1, 'not deleted: ' + (await stateOf(p)).takes.length);
  await undoN(p, 1);
  ok((await stateOf(p)).takes.length === 2 && (await stateOf(p)).takes[0].snap === '{nope', 'undo did not bring it back as it was');
});
check('compare takes: Cancel stops the render, puts the scene back and unlocks the page', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await takeCmd(p, 'newtake'); await addBoxes(p, 2);
  await p.evaluate(() => { window.__shotref.state.settings.duration = 30; window.__shotref.changed(true, true); });
  const before = await stateOf(p);
  await takeCmd(p, 'compare');
  await p.waitForFunction(() => !document.querySelector('#cmpCancel').hidden, null, { timeout: 5000 });
  await p.click('#cmpCancel');
  await p.waitForFunction(() => document.querySelector('#cmpCancel').hidden, null, { timeout: 15000 });
  ok(await p.evaluate(() => [...document.body.children].every(e => !e.inert)), 'still locked');
  ok(canon(await stateOf(p)) === canon(before), 'scene changed');
  ok(await p.evaluate(() => document.querySelector('#cmpView').hidden), 'a half result is shown');
  noErrors(p);
});
check('compare takes: an autosave that is due is written before the scenes are swapped, and none is written while they are', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await takeCmd(p, 'newtake'); await settle(p, 700);
  await p.evaluate(() => { window.__sv = []; const o = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === 'shotref.autosave') { const s = JSON.parse(v).state; window.__sv.push([s.takeId, s.objects.length]); } return o.apply(this, arguments); }; });
  await addBoxes(p, 3);
  const n = await nObj(p), id = (await stateOf(p)).takeId;
  await takeCmd(p, 'compare');
  await p.waitForFunction(() => !document.querySelector('#cmpView').hidden, null, { timeout: 30000 });
  await settle(p, 900);
  const sv = await p.evaluate(() => window.__sv);
  ok(sv.length >= 1 && sv.every(x => x[0] === id && x[1] === n), 'autosave wrote another scene: ' + JSON.stringify(sv) + ' expected ' + id + '/' + n);
  noErrors(p);
});

/* ======================= batch I: Settings, split view, My sets, Recent projects, embed ======================= */
const prefsOf = p => p.evaluate(() => { try { return JSON.parse(localStorage.getItem('shotref.prefs') || '{}'); } catch (e) { return null; } });
const openSettings = async p => { await gearCmd(p, 'settings'); await p.waitForSelector('#mSettings:not(.hidden)'); };
/* set one Settings control by its data-pref name (select, checkbox, range or text) */
const setPrefUI = async (p, key, val) => {
  const sel = '#setBody [data-pref="' + key + '"]';
  const kind = await p.evaluate(s => { const e = document.querySelector(s); return e ? (e.tagName === 'SELECT' ? 'select' : e.type) : null; }, sel);
  if (!kind) throw new Error('no Settings control for ' + key);
  if (kind === 'select') await p.selectOption(sel, String(val));
  else if (kind === 'checkbox') { if ((await p.isChecked(sel)) !== !!val) await p.click(sel); }
  else if (kind === 'range') await p.evaluate(([s, v]) => { const e = document.querySelector(s); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, [sel, val]);
  else { await p.fill(sel, String(val)); await p.dispatchEvent(sel, 'change'); }
};
const PREF_KEYS = ['recentOn', 'newDuration', 'newFps', 'newAspect', 'newSize', 'walkSpeed', 'autoSit', 'ground', 'videoQuality', 'filePrefix', 'dateStamp', 'quality', 'layout', 'liveShadows', 'pipDefault', 'showLabels', 'showArrows', 'showHints', 'showSun', 'selBar', 'camPoints', 'orbitSpeed', 'zoomSpeed', 'flySpeed', 'snapStep', 'rotSnap', 'autosave', 'keepRecent'];

check('settings: every preference has a control, and the old placeholder text is gone', async ({ open }) => {
  const p = await open(); await openSettings(p);
  const have = await p.evaluate(() => [...document.querySelectorAll('#setBody [data-pref]')].map(e => e.dataset.pref));
  const miss = PREF_KEYS.filter(k => !have.includes(k));
  ok(!miss.length, 'no control for: ' + miss.join(', '));
  const heads = await p.evaluate(() => [...document.querySelectorAll('#setBody h3')].map(e => e.textContent.trim()));
  for (const h of ['New scenes', 'Blocking', 'Export', 'Viewport', 'Mouse & keys', 'Saving']) ok(heads.includes(h), 'missing section ' + h + ': ' + heads.join('|'));
  ok(!/nothing to set yet/i.test(await p.textContent('#mSettings')), 'placeholder text still shown');
  ok(await p.isVisible('#setBody button:has-text("Reset all settings")') && await p.isVisible('#setBody button:has-text("Clear recent projects")') && await p.isVisible('#setBody button:has-text("Show quick start")'), 'buttons missing');
  noErrors(p);
});
check('settings: "Keep things on the ground" in Settings and in the gear menu always agree', async ({ open }) => {
  const p = await open(); await openSettings(p);
  ok(await p.isChecked('#setBody [data-pref="ground"]'), 'should start on');
  await p.click('#setBody [data-pref="ground"]');
  ok((await prefsOf(p)).ground === false, 'pref not saved: ' + JSON.stringify(await prefsOf(p)));
  await p.keyboard.press('Escape');
  await p.click('#bMenu');
  ok(await p.getAttribute('#ctxMenu [data-cmd="ground"]', 'aria-checked') === 'false', 'gear menu should now be off');
  await p.click('#ctxMenu [data-cmd="ground"]');
  await openSettings(p);
  ok(await p.isChecked('#setBody [data-pref="ground"]'), 'Settings should be on again after the gear menu switched it on');
  noErrors(p);
});
check('settings: new-scene defaults apply to New and starter sets, never to opened files', async ({ open }) => {
  const p = await open(); await openSettings(p);
  await setPrefUI(p, 'newDuration', 8); await setPrefUI(p, 'newFps', 30); await setPrefUI(p, 'newAspect', '9:16'); await setPrefUI(p, 'newSize', 1280);
  await p.keyboard.press('Escape');
  await loadEmptyStarter(p);
  const s = (await stateOf(p)).settings;
  ok(s.duration === 8 && s.fps === 30 && s.aspect === '9:16' && s.size === 1280, 'new scene settings: ' + JSON.stringify([s.duration, s.fps, s.aspect, s.size]));
  const file = { app: 'ShotRef', version: 1, state: { camera: { base: JSON.parse(CAM_BASE), keys: [] }, objects: [], settings: {} } };
  await openFile(p, 'old.shotref', JSON.stringify(file));
  const o = (await stateOf(p)).settings;
  ok(o.duration === 5 && o.fps === 24 && o.aspect === '16:9' && o.size === 1920, 'an opened file picked up the new-scene defaults: ' + JSON.stringify([o.duration, o.fps, o.aspect, o.size]));
  noErrors(p);
});
check('settings: viewport options (labels, arrows, hints, shadows, preview quality, corner preview)', async ({ open }) => {
  const p = await open(); await settle(p, 400);
  ok(await p.evaluate(() => document.querySelectorAll('#labels .lbl3d').length > 0 && getComputedStyle(document.querySelector('#hint')).display !== 'none'), 'labels and hint should show by default');
  await openSettings(p);
  await setPrefUI(p, 'showLabels', false); await setPrefUI(p, 'showHints', false); await setPrefUI(p, 'liveShadows', false); await setPrefUI(p, 'quality', 'low'); await setPrefUI(p, 'showArrows', false); await setPrefUI(p, 'pipDefault', false);
  await p.keyboard.press('Escape'); await settle(p, 400);
  ok(await p.evaluate(() => [...document.querySelectorAll('#labels .lbl3d')].every(e => e.offsetParent === null)), 'labels still shown');
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('#hint')).display === 'none'), 'hint still shown');
  const st = await stats(p);
  ok(st.shadows === false && Math.abs(st.pixelRatio - 0.75) < 1e-6, 'shadows/pixel ratio: ' + st.shadows + ' ' + st.pixelRatio);
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('#pipFrame')).display === 'none'), 'corner preview still shown');
  ok(await p.evaluate(() => window.__shotref.arrowsVisible() === false), 'facing arrows still shown');
  await openSettings(p);
  await setPrefUI(p, 'liveShadows', true); await setPrefUI(p, 'quality', 'high'); await setPrefUI(p, 'showArrows', true);
  await p.keyboard.press('Escape'); await settle(p, 300);
  const st2 = await stats(p);
  ok(st2.shadows === true && st2.pixelRatio >= 1, 'not restored: ' + st2.shadows + ' ' + st2.pixelRatio);
  noErrors(p);
});
check('settings: file name prefix, date stamp and video quality reach the exports', async ({ open, downloads }) => {
  const p = await open(); await openSettings(p);
  await setPrefUI(p, 'filePrefix', 'my:film'); await setPrefUI(p, 'dateStamp', false);
  await setPrefUI(p, 'videoQuality', 'standard');
  const bStd = await p.evaluate(() => window.__shotref.videoBitrate(1920, 1080, 24));
  await setPrefUI(p, 'videoQuality', 'max');
  const bMax = await p.evaluate(() => window.__shotref.videoBitrate(1920, 1080, 24));
  await setPrefUI(p, 'videoQuality', 'high');
  const bHigh = await p.evaluate(() => window.__shotref.videoBitrate(1920, 1080, 24));
  ok(bStd < bHigh && bHigh < bMax, 'bitrates ' + [bStd, bHigh, bMax]);
  await p.keyboard.press('Escape');
  await p.keyboard.press('p');
  const d = await downloads(p).wait('.png');
  ok(/^myfilm-frame0001-shaded\.png$/.test(d.name), 'file name: ' + d.name);
  noErrors(p);
});
check('settings: snap step, turn snap, orbit, zoom, fly and walking speed are used', async ({ open }) => {
  const p = await open(); await openSettings(p);
  await setPrefUI(p, 'snapStep', 0.5); await setPrefUI(p, 'rotSnap', 45); await setPrefUI(p, 'orbitSpeed', 2); await setPrefUI(p, 'zoomSpeed', 1.5); await setPrefUI(p, 'flySpeed', 4); await setPrefUI(p, 'walkSpeed', 2);
  await p.keyboard.press('Escape');
  const r = await p.evaluate(() => { const S = window.__shotref; return { snap: S.snapValue(1.3, true), off: S.snapValue(1.3, false), rot: S.rotSnapDeg(), c: S.controlSpeeds(), fly: S.flySpeedNow(false), flyShift: S.flySpeedNow(true), walk: S.walkSpeedNow() }; });
  ok(r.snap === 1.5 && r.off === 1.3, 'snap: ' + JSON.stringify(r));
  ok(r.rot === 45, 'turn snap ' + r.rot);
  ok(r.c.orbit === 2 && r.c.zoom === 1.5 && Math.abs(r.c.cam - 1.2) < 1e-9, 'controls ' + JSON.stringify(r.c));
  ok(r.fly === 4 && r.flyShift === 12, 'fly ' + r.fly + ' ' + r.flyShift);
  ok(r.walk === 2, 'walk speed ' + r.walk);
  noErrors(p);
});
check('settings: Reset all settings brings back every default, and a blocked localStorage still applies the change', async ({ open }) => {
  const p = await open(); await openSettings(p);
  await setPrefUI(p, 'newDuration', 15); await setPrefUI(p, 'orbitSpeed', 2); await setPrefUI(p, 'showHints', false); await setPrefUI(p, 'filePrefix', 'zzz');
  ok((await prefsOf(p)).newDuration === 15, 'not saved');
  await p.click('#setBody button:has-text("Reset all settings")');
  await settle(p, 200);
  const pr = await prefsOf(p);
  ok(!['newDuration', 'orbitSpeed', 'showHints', 'filePrefix'].some(k => k in pr), 'prefs not cleared: ' + JSON.stringify(pr));
  ok(await p.inputValue('#setBody [data-pref="newDuration"]') === '5' && await p.isChecked('#setBody [data-pref="showHints"]') && await p.inputValue('#setBody [data-pref="filePrefix"]') === 'shotref', 'controls not reset');
  /* a browser that refuses to store: the change still works for this visit */
  await p.evaluate(() => { Storage.prototype.setItem = function () { throw new DOMException('no', 'QuotaExceededError'); }; });
  await setPrefUI(p, 'showHints', false); await settle(p, 300);
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('#hint')).display === 'none'), 'change not applied when storage is blocked');
  noPageErrors(p);
});

/* ---- split view ---- */
const canvasBox = p => p.evaluate(() => { const r = document.querySelector('#c').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
const splitOn = async p => { if (!(await p.evaluate(() => window.__shotref.layout() === 'split'))) await p.click('#bSplit'); await settle(p, 300); };
check('split view: the editor sits left and the shot right, with a divider; Camera goes full screen and back', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.click('#bSplit'); await settle(p, 300);
  ok(await p.evaluate(() => window.__shotref.layout() === 'split' && document.querySelector('#bSplit').classList.contains('on')), 'not split');
  const cb = await canvasBox(p);
  const cf = await p.evaluate(() => { const r = document.querySelector('#camFrame').getBoundingClientRect(); return { x: r.left, w: r.width, shown: getComputedStyle(document.querySelector('#camFrame')).display !== 'none' }; });
  ok(cf.shown && cf.x >= cb.x + cb.w / 2 - 2 && cf.x + cf.w <= cb.x + cb.w + 1, 'camera frame not in the right half: ' + JSON.stringify(cf) + ' ' + JSON.stringify(cb));
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('#splitLine')).display !== 'none'), 'no divider');
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('#pipFrame')).display === 'none'), 'corner preview should be hidden in split view');
  ok((await prefsOf(p)).layout === 'split', 'layout not remembered');
  await p.click('#viewSeg [data-v="camera"]'); await settle(p, 300);
  ok(await p.evaluate(() => { const r = document.querySelector('#camFrame').getBoundingClientRect(); return r.width > document.querySelector('#c').getBoundingClientRect().width * 0.6 && getComputedStyle(document.querySelector('#splitLine')).display === 'none'; }), 'Camera view should be full width');
  await p.click('#viewSeg [data-v="editor"]'); await settle(p, 300);
  ok(await p.evaluate(() => window.__shotref.layout() === 'split' && getComputedStyle(document.querySelector('#splitLine')).display !== 'none'), 'split should come back with the editor');
  await p.click('#bSplit'); await settle(p, 300);
  ok(await p.evaluate(() => window.__shotref.layout() === 'single' && getComputedStyle(document.querySelector('#pipFrame')).display !== 'none'), 'single view should bring the corner preview back');
  noErrors(p);
});
check('split view: dragging in each half steers only that half, and Settings agrees with the button', async ({ open }) => {
  const p = await open(); await settle(p, 300); await splitOn(p);
  const cb = await canvasBox(p);
  const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 0.02); /* the editor's glide after a drag never quite stops */
  const snap = () => p.evaluate(() => { const S = window.__shotref; return { ed: S.editCamPos(), cam: JSON.stringify(S.state.camera), f: S.state.camera.base.f }; });
  const a = await snap();
  /* right half: orbit the shot camera */
  await p.mouse.move(cb.x + cb.w * 0.75, cb.y + cb.h * 0.5); await p.mouse.down(); await p.mouse.move(cb.x + cb.w * 0.8, cb.y + cb.h * 0.55, { steps: 6 }); await p.mouse.up(); await settle(p, 300);
  const b = await snap();
  ok(b.cam !== a.cam, 'the shot camera did not move when dragging the right half');
  ok(same(b.ed, a.ed), 'the editor view moved too: ' + JSON.stringify([a.ed, b.ed]));
  /* left half, empty corner: orbit the editor */
  await p.mouse.move(cb.x + cb.w * 0.06, cb.y + cb.h * 0.12); await p.mouse.down(); await p.mouse.move(cb.x + cb.w * 0.12, cb.y + cb.h * 0.2, { steps: 6 }); await p.mouse.up(); await settle(p, 2500); /* the orbit glides to a stop */
  const c = await snap();
  ok(!same(c.ed, b.ed), 'the editor view did not orbit');
  ok(c.cam === b.cam, 'the shot camera moved when dragging the left half');
  /* Alt + wheel in the right half changes the lens; plain wheel in the left half zooms the editor */
  await p.mouse.move(cb.x + cb.w * 0.75, cb.y + cb.h * 0.5); await p.keyboard.down('Alt'); await p.mouse.wheel(0, -300); await p.keyboard.up('Alt'); await settle(p, 400);
  const d = await snap();
  ok(d.f !== c.f && same(d.ed, c.ed), 'lens wheel: ' + c.f + ' -> ' + d.f);
  await p.mouse.move(cb.x + cb.w * 0.25, cb.y + cb.h * 0.5); await p.mouse.wheel(0, -300); await settle(p, 500);
  const e = await snap();
  ok(!same(e.ed, d.ed) && e.f === d.f, 'editor wheel zoom');
  /* Settings agrees */
  await openSettings(p);
  ok(await p.inputValue('#setBody [data-pref="layout"]') === 'split', 'Settings layout should say split');
  await p.selectOption('#setBody [data-pref="layout"]', 'single'); await p.keyboard.press('Escape'); await settle(p, 200);
  ok(await p.evaluate(() => !document.querySelector('#bSplit').classList.contains('on') && window.__shotref.layout() === 'single'), 'Settings did not switch to one view');
  noErrors(p);
});
check('split view: fly keys follow the pointer, and picking works in the left half', async ({ open }) => {
  const p = await open(); await settle(p, 300); await splitOn(p);
  const cb = await canvasBox(p);
  const cam = () => p.evaluate(() => JSON.stringify(window.__shotref.state.camera));
  const c0 = await cam();
  await p.mouse.move(cb.x + cb.w * 0.25, cb.y + cb.h * 0.5); await p.keyboard.down('d'); await settle(p, 300); await p.keyboard.up('d');
  ok(await cam() === c0, 'D flew the camera while the pointer was over the left half');
  await p.mouse.move(cb.x + cb.w * 0.75, cb.y + cb.h * 0.5); await p.keyboard.down('d'); await settle(p, 400); await p.keyboard.up('d'); await settle(p, 300);
  ok(await cam() !== c0, 'D did not fly the camera over the right half');
  /* a click on the person in the left half selects it */
  await p.mouse.move(cb.x + cb.w * 0.25, cb.y + cb.h * 0.5);
  const pos = await p.evaluate(() => { const S = window.__shotref, o = S.state.objects.find(q => q.type === 'person'); const t = S.evalObj(o, 0).p; const pt = S.project(t[0], t[1] + 0.9, t[2]); return { id: o.id, x: pt[0], y: pt[1] }; });
  ok(pos.x < cb.x + cb.w / 2, 'person is not in the left half: ' + pos.x + ' / ' + cb.w);
  ok(await p.evaluate(([x, y]) => window.__shotref.pickAtScreen(x, y), [pos.x, pos.y]) === pos.id, 'pickAtScreen did not find the person in the left half');
  await p.mouse.click(pos.x, pos.y); await settle(p, 200);
  ok(await p.evaluate(() => window.__shotref.selected) === pos.id, 'the click did not select the person');
  noErrors(p);
});
check('split view: the arrows gizmo maths uses the left half only', async ({ open }) => {
  const p = await open(); await settle(p, 300); await splitOn(p);
  const r = await p.evaluate(() => { const S = window.__shotref; const c = document.querySelector('#c').getBoundingClientRect(); return S.gizmoNdc(c.left + c.width * 0.25, c.top + c.height * 0.5); });
  ok(Math.abs(r.x) < 0.02 && Math.abs(r.y) < 0.02, 'the middle of the left half should be the middle of its view: ' + JSON.stringify(r));
  noErrors(p);
});
check('split view: draws only when something changes (idle redraws 0), and both halves update', async ({ open }) => {
  const p = await open(); await settle(p, 300); await splitOn(p); await settle(p, 1500);
  const a = await stats(p); await settle(p, 1000); const b = await stats(p);
  ok(b.draws === a.draws, 'redrew ' + (b.draws - a.draws) + ' times while idle in split view');
  const cb = await canvasBox(p);
  const half = async side => (await p.screenshot({ clip: { x: cb.x + (side ? cb.w / 2 + 4 : 4), y: cb.y + 4, width: cb.w / 2 - 8, height: cb.h - 8 } })).toString('base64');
  const L0 = await half(0), R0 = await half(1);
  await p.evaluate(() => { const S = window.__shotref, o = S.state.objects.find(q => q.type === 'person'); o.base.p = [o.base.p[0] + 0.8, 0, o.base.p[2]]; S.changed(true); });
  await settle(p, 400);
  const L1 = await half(0), R1 = await half(1);
  ok(L1 !== L0, 'left half did not redraw'); ok(R1 !== R0, 'camera half did not redraw');
  await p.evaluate(() => { const S = window.__shotref; S.writeCam({ p: [S.state.camera.base.p[0] + 1.5, S.state.camera.base.p[1], S.state.camera.base.p[2]] }, true); });
  await settle(p, 400);
  ok((await half(1)) !== R1, 'camera half did not follow the camera');
  await settle(p, 1200);
  const c = await stats(p); await settle(p, 1000); const d = await stats(p);
  ok(d.draws === c.draws, 'redrew ' + (d.draws - c.draws) + ' times while idle after edits');
  noErrors(p);
});
check('split view: placing works from the left half and the camera frame stays inside the right half', async ({ open }) => {
  const p = await open(); await settle(p, 300); await splitOn(p);
  const cb = await canvasBox(p);
  await p.click('#addArea .tile:has-text("Man")'); await settle(p, 100);
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('#modeBar')).display !== 'none'), 'no placing bar');
  await p.mouse.click(cb.x + cb.w * 0.3, cb.y + cb.h * 0.7); await settle(p, 300);
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('#modeBar')).display === 'none'), 'placing did not finish after a click in the left half');
  const fr = await p.evaluate(() => { const r = document.querySelector('#camFrame').getBoundingClientRect(), c = document.querySelector('#c').getBoundingClientRect(); return [r.left - c.left, r.top - c.top, r.right - c.left, r.bottom - c.top, c.width, c.height]; });
  ok(fr[0] >= fr[4] / 2 && fr[2] <= fr[4] + 1 && fr[1] >= 0 && fr[3] <= fr[5], 'frame outside the right half: ' + fr.join(','));
  noErrors(p);
});

/* ---- My sets ---- */
const libOf = p => p.evaluate(() => { try { return JSON.parse(localStorage.getItem('shotref.library') || '[]'); } catch (e) { return null; } });
const saveSetFrom = async (p, name) => { await p.fill('.setsave input', name); await p.click('.setsave button'); await settle(p, 250); };
check('my sets: save the selection, see it in the Add tab, place it as a group, delete it', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => { const S = window.__shotref; S.selectMany(S.state.objects.slice(0, 2).map(o => o.id)); });
  await settle(p, 200);
  ok(await p.isVisible('.setsave'), 'no "Save as a reusable set" section for a selection');
  const before = await p.evaluate(() => JSON.stringify(window.__shotref.state)), hist0 = await p.evaluate(() => window.__shotref.history.length);
  await saveSetFrom(p, 'Corner');
  const lib = await libOf(p);
  ok(lib.length === 1 && lib[0].name === 'Corner' && lib[0].items.length === 2 && lib[0].id, 'library: ' + JSON.stringify(lib));
  ok(lib[0].items.every(i => i.type && i.base && i.base.p && i.opts), 'items incomplete');
  ok(await p.evaluate(() => JSON.stringify(window.__shotref.state)) === before && await p.evaluate(() => window.__shotref.history.length) === hist0, 'saving a set changed the scene or the undo list');
  await p.evaluate(() => window.__shotref.select(null)); await settle(p, 200);
  await p.click('#leftTabs [data-lt="add"]');
  ok(await p.isVisible('#addArea .setile:has-text("Corner")'), 'no tile in My sets');
  const n0 = await nObj(p);
  await p.click('#addArea .setile:has-text("Corner")'); await settle(p, 150);
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('#modeBar')).display !== 'none'), 'no placing bar');
  await p.keyboard.press('Escape'); await settle(p, 200);
  ok(await nObj(p) === n0 && await p.evaluate(() => window.__shotref.history.length) === hist0, 'Esc should remove the half-placed set without an undo step');
  ok(!(await stateOf(p)).groups || !Object.keys((await stateOf(p)).groups).length, 'Esc left an empty group behind');
  await p.click('#addArea .setile:has-text("Corner")');
  const cb = await canvasBox(p);
  await p.mouse.click(cb.x + cb.w * 0.3, cb.y + cb.h * 0.75); await settle(p, 400);
  const s = await stateOf(p);
  ok(s.objects.length === n0 + 2, 'set not placed: ' + s.objects.length);
  const added = s.objects.slice(-2);
  ok(added[0].grp && added[0].grp === added[1].grp && s.groups[added[0].grp] && s.groups[added[0].grp].name === 'Corner', 'not a group named Corner');
  ok(await p.evaluate(() => window.__shotref.history.length) === hist0 + 1, 'placing should be one undo step');
  await undoN(p, 1);
  ok(await nObj(p) === n0, 'undo did not remove the set');
  await p.hover('#addArea .setile:has-text("Corner")'); await p.click('#addArea .setile:has-text("Corner") .setdel');
  await p.waitForSelector('#mConfirm:not(.hidden)'); await p.click('#cfOk'); await settle(p, 200);
  ok((await libOf(p)).length === 0 && !(await p.isVisible('#addArea .setile')), 'set not deleted');
  ok(await nObj(p) === n0, 'deleting a set changed the scene');
  noErrors(p);
});
check('my sets: one item or the whole scene can be saved, photos and models are left out', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => { const S = window.__shotref; S.assets.m1 = { kind: 'model', name: 'x.glb', b64: 'AAAA', mime: 'model/gltf-binary' }; S.addObject('model', { asset: 'm1' }, false); S.changed(true); S.select(null); });
  await settle(p, 300);
  ok(await p.isVisible('.setsave'), 'nothing selected: the panel should offer to save the scene as a set');
  await saveSetFrom(p, 'Whole');
  let lib = await libOf(p);
  ok(lib[0].items.length === 3 && !lib[0].items.some(i => i.type === 'model' || i.type === 'image'), 'whole scene: ' + lib[0].items.map(i => i.type));
  ok(/left out/.test(await p.textContent('#toast')), 'no note about the left-out model: ' + await p.textContent('#toast'));
  await p.evaluate(() => { const S = window.__shotref; S.select(S.state.objects[0].id); }); await settle(p, 200);
  await saveSetFrom(p, 'One');
  lib = await libOf(p);
  ok(lib.length === 2 && lib[1].items.length === 1 && lib[1].name === 'One', 'single item set: ' + JSON.stringify(lib.map(s => s.items.length)));
  noPageErrors(p);
});
check('my sets: entries this version cannot read are kept exactly, and a blocked browser keeps sets for this visit', async ({ freshContext }) => {
  const fc = await freshContext();
  await fc.ctx.addInitScript(() => { try { if (!localStorage.getItem('shotref.library') && !sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('shotref.library', '[{"id":"zz","name":"Future","items":"strange","extra":{"a":[1,2]}}, 5, {"id":"ok1","name":"Fine","items":[{"type":"box","name":"Box 1","color":"#fff","opts":{},"base":{"p":[0,0,0],"r":[0,0,0],"s":[1,1,1]}}]}]'); } } catch (e) { } });
  const p = await fc.open(); await settle(p, 300);
  ok(await p.isVisible('#addArea .setile:has-text("Fine")') && !(await p.isVisible('#addArea .setile:has-text("Future")')), 'only the readable set should show');
  const raw0 = await p.evaluate(() => localStorage.getItem('shotref.library'));
  await p.evaluate(() => { const S = window.__shotref; S.select(S.state.objects[0].id); }); await settle(p, 200);
  await saveSetFrom(p, 'New one');
  const lib = await libOf(p);
  ok(lib.length === 4 && JSON.stringify(lib[0]) === '{"id":"zz","name":"Future","items":"strange","extra":{"a":[1,2]}}' && lib[1] === 5 && lib[3].name === 'New one', 'library after saving: ' + JSON.stringify(lib));
  /* deleting one set leaves the rest as they were */
  await p.hover('#addArea .setile:has-text("Fine")'); await p.click('#addArea .setile:has-text("Fine") .setdel'); await p.click('#cfOk'); await settle(p, 200);
  const lib2 = await libOf(p);
  ok(lib2.length === 3 && JSON.stringify(lib2[0]).includes('"extra"') && lib2[1] === 5 && lib2[2].name === 'New one', 'after delete: ' + JSON.stringify(lib2));
  /* storage that is not JSON at all is moved aside, not thrown away */
  await p.evaluate(() => localStorage.setItem('shotref.library', 'not json {'));
  await p.evaluate(() => window.__shotref.buildAddPanel());
  await saveSetFrom(p, 'After junk');
  ok(await p.evaluate(() => localStorage.getItem('shotref.library.broken')) === 'not json {', 'unreadable library not kept aside');
  ok((await libOf(p)).length === 1, 'new library not started');
  /* a blocked browser: the set lives for this visit, with a plain note */
  await p.evaluate(() => { Storage.prototype.setItem = function () { throw new DOMException('no', 'QuotaExceededError'); }; });
  await saveSetFrom(p, 'Session only');
  ok(await p.isVisible('#addArea .setile:has-text("Session only")'), 'set missing from this visit');
  ok(/this visit|closed|not be kept|won't be kept/i.test(await p.textContent('#toast')), 'no plain note: ' + await p.textContent('#toast'));
  noPageErrors(p);
});

/* ---- Recent projects ---- */
const idbRows = p => p.evaluate(() => new Promise(res => {
  const rq = indexedDB.open('shotref');
  rq.onerror = () => res(null);
  rq.onsuccess = () => {
    const db = rq.result; const out = { version: db.version, stores: [...db.objectStoreNames], rows: [], assets: [] };
    if (!out.stores.includes('projects')) { db.close(); return res(out); }
    const tx = db.transaction(['projects', 'assets'].filter(n => out.stores.includes(n)), 'readonly');
    tx.objectStore('projects').getAll().onsuccess = e => { out.rows = e.target.result; };
    if (out.stores.includes('assets')) tx.objectStore('assets').getAllKeys().onsuccess = e => { out.assets = e.target.result; };
    tx.oncomplete = () => { db.close(); res(out); };
  };
}));
const recentNow = p => p.evaluate(() => window.__shotref.saveRecentNow());
const waitRecent = async (p, n = 1, ms = 9000) => { if (n >= 1) await recentNow(p); const end = Date.now() + ms; for (;;) { const r = await idbRows(p); if (r && r.rows.length >= n) return r; if (Date.now() > end) throw new Error('no recent project saved: ' + JSON.stringify(r && { v: r.version, s: r.stores, n: r.rows.length })); await settle(p, 250); } };
const renameProject = async (p, name) => { await p.fill('#projName', name); await p.dispatchEvent('#projName', 'change'); };
check('recent projects: an old database (version 1, assets only) is upgraded to version 2 and keeps its photos', async ({ freshContext, base }) => {
  const fc = await freshContext();
  const raw = await fc.ctx.newPage();
  /* plant the old database from a page of the same origin that is not the app */
  await raw.route('**/blank.html', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>x</body></html>' }));
  await raw.goto(base + 'blank.html');
  const id = 'plate1';
  await raw.evaluate(async id => {
    await new Promise((res, rej) => { const rq = indexedDB.open('shotref', 1); rq.onupgradeneeded = () => rq.result.createObjectStore('assets'); rq.onsuccess = () => { const tx = rq.result.transaction('assets', 'readwrite'); tx.objectStore('assets').put({ kind: 'image', name: 'a.png', b64: 'iVBORw0KGgo=', mime: 'image/png', aspect: 1 }, id); tx.oncomplete = () => { rq.result.close(); res(); }; tx.onerror = () => rej(tx.error); }; rq.onerror = () => rej(rq.error); });
    localStorage.setItem('shotref.seenHelp', '1');
    const st = { v: 2, settings: {}, camera: { base: { p: [3, 1.6, 6], tg: [0, 1, 0], f: 35, roll: 0, fd: 7 }, keys: [] }, objects: [{ id: 'im', type: 'image', name: 'Photo', color: '#fff', opts: { aspect: 1 }, asset: id, base: { p: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }, keys: [], visible: true }] };
    localStorage.setItem('shotref.autosave', JSON.stringify({ state: st, assets: {}, assetIds: [id], v: 2 }));
  }, id);
  await raw.close();
  const p = await fc.open(); await settle(p, 800);
  const r = await idbRows(p);
  ok(r && r.version === 2 && r.stores.includes('assets') && r.stores.includes('projects'), 'database after boot: ' + JSON.stringify(r && { v: r.version, s: r.stores }));
  ok(r.assets.includes(id), 'the stored photo was lost in the upgrade: ' + JSON.stringify(r.assets));
  ok(await p.evaluate(id => !!window.__shotref.assets[id], id), 'the photo did not load from the upgraded database');
  noPageErrors(p);
});
check('recent projects: an edit saves a recent entry with a small picture and the project text', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await renameProject(p, 'Alpha scene');
  await p.evaluate(() => { const S = window.__shotref; S.addObject('box'); S.changed(true); });
  const r = await waitRecent(p);
  const row = r.rows.find(x => x.name === 'Alpha scene') || r.rows[0];
  ok(row && row.id && row.name === 'Alpha scene' && typeof row.updated === 'number', 'row: ' + JSON.stringify(row && Object.keys(row)));
  ok(/^data:image\/jpeg;base64,/.test(row.thumb), 'thumbnail is not a data: URL: ' + String(row.thumb).slice(0, 30));
  const f = JSON.parse(row.data);
  ok(f.app === 'ShotRef' && f.state.objects.length === (await nObj(p)), 'stored project: ' + Object.keys(f));
  noErrors(p);
});
check('recent projects: File > Open shows the recent grid; Open a file and starter sets are there too', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await renameProject(p, 'Grid test');
  await p.evaluate(() => { const S = window.__shotref; S.addObject('box'); S.changed(true); });
  await waitRecent(p);
  await fileCmd(p, 'open');
  await p.waitForSelector('#mRecent:not(.hidden)');
  await p.waitForSelector('#recentGrid .rcard');
  const cards = await p.evaluate(() => [...document.querySelectorAll('#recentGrid .rcard')].map(c => ({ t: c.textContent, cur: c.classList.contains('cur'), img: !!c.querySelector('img[src^="data:image/jpeg"]') })));
  ok(cards.some(c => /Grid test/.test(c.t) && c.cur && /Open now/.test(c.t) && c.img), 'cards: ' + JSON.stringify(cards));
  ok(await p.isVisible('#recFile') && await p.isVisible('#recNew'), 'buttons missing');
  const fcP = p.waitForEvent('filechooser');
  await p.click('#recFile'); await fcP;
  ok(await p.evaluate(() => document.querySelector('#mRecent').classList.contains('hidden')), 'dialog should close');
  await p.keyboard.press('Control+O');
  await p.waitForSelector('#mRecent:not(.hidden)');
  await p.click('#recNew');
  await p.waitForSelector('#mStart:not(.hidden)');
  noErrors(p);
});
check('recent projects: open another recent project exactly as it was saved, delete one, and nothing changes the scene by looking', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await renameProject(p, 'Alpha');
  await p.evaluate(() => { const S = window.__shotref; S.addObject('box'); S.addObject('box'); S.changed(true); });
  await waitRecent(p);
  const alpha = await stateOf(p);
  await loadEmptyStarter(p);
  await renameProject(p, 'Beta'); await p.evaluate(() => { const S = window.__shotref; S.addObject('ball'); S.changed(true); });
  await waitRecent(p, 2);
  await fileCmd(p, 'open'); await p.waitForSelector('#recentGrid .rcard');
  const hist = await p.evaluate(() => window.__shotref.history.length), cur = await stateOf(p);
  await settle(p, 300);
  ok(canon(await stateOf(p)) === canon(cur) && await p.evaluate(() => window.__shotref.history.length) === hist, 'opening the dialog changed the scene');
  await p.click('#recentGrid .rcard:has-text("Alpha")');
  await p.waitForSelector('#mConfirm:not(.hidden)'); await p.click('#cfOk');
  await p.waitForFunction(() => window.__shotref.state.meta && window.__shotref.state.meta.name === 'Alpha');
  const now = await stateOf(p);
  ok(canon(now.objects) === canon(alpha.objects) && now.meta.id === alpha.meta.id, 'the opened project differs from the saved one');
  await p.keyboard.press('Control+z'); await settle(p, 300);
  ok((await stateOf(p)).meta.name === 'Beta', 'undo should bring the previous scene back');
  /* delete one */
  await fileCmd(p, 'open'); await p.waitForSelector('#recentGrid .rcard');
  await p.hover('#recentGrid .rcard:has-text("Alpha")'); await p.click('#recentGrid .rcard:has-text("Alpha") .del'); await settle(p, 400);
  ok(!(await p.isVisible('#recentGrid .rcard:has-text("Alpha")')), 'card still shown');
  ok(!(await idbRows(p)).rows.some(x => x.name === 'Alpha'), 'row still stored');
  noErrors(p);
});
check('recent projects: older entries are pruned to the number to keep, and an entry this version cannot read is shown, kept and removable', async ({ open }) => {
  const p = await open(); await settle(p, 300); await openSettings(p); await setPrefUI(p, 'keepRecent', 5); await p.keyboard.press('Escape');
  /* an unreadable entry and an artifact-made one (version 1 file text), written straight to the store */
  await p.evaluate(() => new Promise(res => { const rq = indexedDB.open('shotref', 2); rq.onsuccess = () => { const tx = rq.result.transaction('projects', 'readwrite'), st = tx.objectStore('projects');
    st.put({ id: 'bad1', name: 'Damaged one', updated: Date.now() - 1e7, thumb: '', data: '{"app":"ShotRef", "state": {' });
    st.put({ id: 'art1', name: 'From the artifact', updated: Date.now() - 5e6, thumb: '', data: JSON.stringify({ app: 'ShotRef', version: 1, state: { v: 1, meta: { id: 'art1', name: 'From the artifact' }, camera: { base: { p: [3, 1.6, 6], tg: [0, 1, 0], f: 35, roll: 0, fd: 7 }, keys: [] }, objects: [{ id: 'q1', type: 'box', name: 'Box 1', base: { p: [1, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } }], settings: {} }, assets: {} }) });
    tx.oncomplete = () => { rq.result.close(); res(); }; }; }));
  for (let i = 0; i < 6; i++) { await p.evaluate(async i => { const S = window.__shotref; S.state.meta = { id: 'proj' + i, name: 'Proj ' + i }; S.changed(true); await S.saveRecentNow(); }, i); }
  const rows = (await idbRows(p)).rows;
  ok(rows.length === 5, 'kept ' + rows.length + ' entries: ' + rows.map(r => r.name).join(', '));
  ok(rows.some(r => r.id === 'proj5') && !rows.some(r => r.id === 'bad1' || r.id === 'art1'), 'the oldest should have been pruned: ' + rows.map(r => r.id));
  /* write them again so the two special entries are inside the limit */
  await openSettings(p); await setPrefUI(p, 'keepRecent', 50); await p.keyboard.press('Escape');
  await p.evaluate(() => new Promise(res => { const rq = indexedDB.open('shotref', 2); rq.onsuccess = () => { const tx = rq.result.transaction('projects', 'readwrite'), st = tx.objectStore('projects');
    st.put({ id: 'bad1', name: 'Damaged one', updated: Date.now() - 1e7, thumb: '', data: '{"app":"ShotRef", "state": {' });
    st.put({ id: 'art1', name: 'From the artifact', updated: Date.now() - 5e6, thumb: '', data: JSON.stringify({ app: 'ShotRef', version: 1, state: { v: 1, meta: { id: 'art1', name: 'From the artifact' }, camera: { base: { p: [3, 1.6, 6], tg: [0, 1, 0], f: 35, roll: 0, fd: 7 }, keys: [] }, objects: [{ id: 'q1', type: 'box', name: 'Box 1', base: { p: [1, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } }], settings: {} }, assets: {} }) });
    tx.oncomplete = () => { rq.result.close(); res(); }; }; }));
  await fileCmd(p, 'open'); await p.waitForSelector('#recentGrid .rcard');
  const cards = await p.evaluate(() => [...document.querySelectorAll('#recentGrid .rcard')].map(c => c.textContent));
  ok(cards.some(t => /Damaged one/.test(t) && /can.t be opened/i.test(t)), 'damaged entry card: ' + cards.join(' | '));
  await p.click('#recentGrid .rcard:has-text("Damaged one")'); await settle(p, 300);
  ok(/can.t be opened|damaged/i.test(await p.textContent('#toast')), 'no plain message: ' + await p.textContent('#toast'));
  ok((await idbRows(p)).rows.some(r => r.id === 'bad1'), 'the damaged entry was dropped by clicking it');
  ok(await p.isVisible('#mRecent:not(.hidden)'), 'dialog should stay open after a failed open');
  await p.click('#recentGrid .rcard:has-text("From the artifact")'); await p.waitForSelector('#mConfirm:not(.hidden)'); await p.click('#cfOk');
  await p.waitForFunction(() => window.__shotref.state.objects.length === 1 && window.__shotref.state.objects[0].id === 'q1');
  await fileCmd(p, 'open'); await p.waitForSelector('#recentGrid .rcard');
  await p.hover('#recentGrid .rcard:has-text("Damaged one")'); await p.click('#recentGrid .rcard:has-text("Damaged one") .del'); await settle(p, 400);
  ok(!(await idbRows(p)).rows.some(r => r.id === 'bad1'), 'damaged entry not removable');
  noErrors(p);
});
check('recent projects: autosave off writes nothing; Clear recent projects empties the list', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => { const S = window.__shotref; S.addObject('box'); S.changed(true); });
  await waitRecent(p);
  await openSettings(p);
  await p.click('#setBody button:has-text("Clear recent projects")');
  await p.waitForSelector('#mConfirm:not(.hidden)'); await p.click('#cfOk'); await settle(p, 400);
  ok((await idbRows(p)).rows.length === 0, 'not cleared');
  await openSettings(p); await setPrefUI(p, 'autosave', false); await p.keyboard.press('Escape');
  await p.evaluate(() => { const S = window.__shotref; S.addObject('box'); S.changed(true); });
  await settle(p, 300);
  ok((await idbRows(p)).rows.length === 0 && await recentNow(p) === true, 'recents should be written while only Autosave is off');
  await openSettings(p); await setPrefUI(p, 'recentOn', false); await p.keyboard.press('Escape');
  await p.evaluate(async () => { await window.__shotref.saveRecentNow(); });
  await p.evaluate(() => new Promise(res => { const rq = indexedDB.open('shotref'); rq.onsuccess = () => { const tx = rq.result.transaction('projects', 'readwrite'); tx.objectStore('projects').clear(); tx.oncomplete = () => { rq.result.close(); res(); }; }; }));
  await p.evaluate(async () => { await window.__shotref.saveRecentNow(); });
  ok((await idbRows(p)).rows.length === 0, 'an entry was written with Keep recent projects off');
  noErrors(p);
});
check('recent projects: without IndexedDB (claude.ai window) the list says so, and nothing else breaks', async ({ freshContext }) => {
  const fc = await freshContext();
  await fc.ctx.addInitScript(() => { try { Object.defineProperty(window, 'indexedDB', { get() { throw new DOMException('denied', 'SecurityError'); } }); } catch (e) { } });
  const p = await fc.open(); await settle(p, 400);
  await p.evaluate(() => { const S = window.__shotref; S.addObject('box'); S.changed(true); });
  await settle(p, 3500);
  await fileCmd(p, 'open'); await p.waitForSelector('#mRecent:not(.hidden)');
  ok(/not available|isn.t available|can.t be used/i.test(await p.textContent('#recNote')), 'no plain note: ' + await p.textContent('#recNote'));
  ok(await p.isVisible('#recFile') && await p.isVisible('#recNew'), 'Open a file and starter sets should still be offered');
  noPageErrors(p);
});
check('recent projects: on the desktop Ctrl+O keeps the native dialog, and File > Recent projects shows the grid', async ({ freshContext }) => {
  const p = await desktopPage(freshContext); await settle(p, 300);
  await p.evaluate(() => { window.__dsk.nextOpen = null; });
  await p.keyboard.press('Control+O'); await settle(p, 400);
  ok(await p.evaluate(() => document.querySelector('#mRecent').classList.contains('hidden')), 'Ctrl+O should use the native dialog on the desktop');
  await fileCmd(p, 'recent');
  await p.waitForSelector('#mRecent:not(.hidden)');
  noErrors(p);
});

/* ---- embed hook ---- */
check('embed hook: a published page can start with its own project and message, with its own autosave', async ({ freshContext }) => {
  const fc = await freshContext({ firstLaunch: true });
  const proj = { app: 'ShotRef', version: 1, state: { v: 1, meta: { id: 'emb', name: 'Desert overlook' }, camera: { base: { p: [3, 1.6, 6], tg: [0, 1, 0], f: 35, roll: 0, fd: 7 }, keys: [] }, objects: [{ id: 'c1', type: 'cactus', name: 'Cactus 1', base: { p: [1, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } }, { id: 'c2', type: 'cactus', name: 'Cactus 2', base: { p: [2, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } }], settings: {} }, assets: {} };
  await fc.ctx.addInitScript(pr => { window.__SHOTREF_EMBED__ = { key: 'demo1', project: pr, message: 'Welcome to the demo' }; }, proj);
  const p = await fc.open(); await settle(p, 900);
  ok(await nObj(p) === 2 && (await stateOf(p)).meta.name === 'Desert overlook', 'the embedded project did not load');
  ok(/Welcome to the demo/.test(await p.textContent('#toast')), 'no message: ' + await p.textContent('#toast'));
  ok(await p.evaluate(() => document.querySelector('#mStart').classList.contains('hidden')), 'the starter sets opened over the demo');
  await p.evaluate(() => { const S = window.__shotref; S.addObject('box'); S.changed(true); });
  await settle(p, 800);
  ok(await p.evaluate(() => localStorage.getItem('shotref.autosave.demo1') !== null && localStorage.getItem('shotref.autosave') === null), 'autosave should use the key shotref.autosave.demo1');
  await p.reload(); await p.waitForFunction(() => window.__shotref && window.__shotref.state); await settle(p, 600);
  ok(await nObj(p) === 3, 'a reload should bring back the visitor\'s own edit, not the demo: ' + await nObj(p));
  noPageErrors(p);
});
check('embed hook: a broken embed is ignored and the app starts normally', async ({ freshContext }) => {
  const fc = await freshContext({ firstLaunch: true });
  await fc.ctx.addInitScript(() => { window.__SHOTREF_EMBED__ = { key: '../x y', project: 'nope', message: 5 }; });
  const p = await fc.open(); await settle(p, 900);
  ok(await nObj(p) === 3, 'normal start expected: ' + await nObj(p));
  noPageErrors(p);
});

/* ---- fix round 1: recents never run on the edit path ---- */
check('recent projects: rapid edits cause no recent write and no thumbnail; Save causes exactly one of each', async ({ open }) => {
  const p = await open(); await settle(p, 400);
  await p.evaluate(() => { const S = window.__shotref; for (let i = 0; i < 25; i++) { S.addObject('box'); S.changed(true); } });
  await settle(p, 3500);
  let st = await p.evaluate(() => window.__shotref.recentStats);
  ok(st.writes === 0 && st.thumbs === 0, 'edits triggered recents: ' + JSON.stringify(st));
  ok((await idbRows(p)).rows.length === 0, 'a row was written by edits');
  await p.evaluate(() => { window.__getAll = 0; const o = IDBObjectStore.prototype.getAll; IDBObjectStore.prototype.getAll = function () { if (this.name === 'projects') window.__getAll++; return o.apply(this, arguments); }; });
  await p.keyboard.press('Control+s');
  await p.waitForFunction(() => window.__shotref.recentStats.writes >= 1, null, { timeout: 10000 }); await settle(p, 800);
  st = await p.evaluate(() => window.__shotref.recentStats);
  ok(st.writes >= 1 && st.thumbs >= 1, 'Save did not write: ' + JSON.stringify(st));
  const w = st.writes;
  ok(await p.evaluate(() => window.__getAll) === 0, 'pruning read whole projects');
  await settle(p, 500);
  ok((await p.evaluate(() => window.__shotref.recentStats.writes)) === w, 'more than one write for one Save');
  noErrors(p);
});
check('recent projects: leaving a project with unsaved edits writes it once; an untouched one writes nothing', async ({ open }) => {
  const p = await open(); await settle(p, 400);
  await loadEmptyStarter(p); await settle(p, 300);
  ok((await p.evaluate(() => window.__shotref.recentStats.writes)) === 0, 'an untouched project wrote a recent');
  await p.evaluate(() => { const S = window.__shotref; S.addObject('box'); S.changed(true); });
  await loadEmptyStarter(p); await settle(p, 800);
  ok((await p.evaluate(() => window.__shotref.recentStats.writes)) === 1 && (await idbRows(p)).rows.length === 1, 'the outgoing project was not written once');
  noErrors(p);
});
check('recent projects: out of space drops the oldest copies and retries once, and the photo autosave still succeeds', async ({ open, fixtures }) => {
  const p = await open(); await settle(p, 300);
  await p.setInputFiles('#fPlate', path.join(fixtures, 'location.jpg'));
  await p.waitForFunction(() => window.__shotref.state.plate && window.__shotref.state.plate.asset);
  const P = await p.evaluate(() => window.__shotref.state.plate.asset);
  await p.evaluate(() => new Promise(res => { const rq = indexedDB.open('shotref'); rq.onsuccess = () => { const tx = rq.result.transaction('projects', 'readwrite'), st = tx.objectStore('projects'); for (let i = 0; i < 6; i++) st.put({ id: 'old' + i, name: 'Old ' + i, updated: 1000 + i, thumb: '', data: '{}' }); tx.oncomplete = () => { rq.result.close(); res(); }; }; }));
  await p.evaluate(() => { window.__full = 1; const o = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function () { if (this.name === 'projects' && window.__full) { window.__full = 0; throw new DOMException('full', 'QuotaExceededError'); } return o.apply(this, arguments); }; });
  const ok1 = await p.evaluate(() => window.__shotref.saveRecentNow());
  ok(ok1 === true, 'the retry after freeing space did not store');
  const r = await idbRows(p);
  ok(r.rows.length < 7 && r.rows.some(x => x.id !== 'old0' && x.name !== 'Old 5') && !r.rows.some(x => x.id === 'old0'), 'oldest not dropped: ' + r.rows.map(x => x.id));
  ok(r.assets.includes(P), 'the photo is missing from the autosave store');
  ok(await p.evaluate(() => !!localStorage.getItem('shotref.autosave')), 'no autosave');
  noPageErrors(p);
});
check('settings: the title is visible at 1440 x 900, and the embed hook falls back to a fixed key', async ({ open, freshContext }) => {
  const p = await open(); await openSettings(p);
  const t = await p.evaluate(() => { const r = document.querySelector('#mSettingsT').getBoundingClientRect(); return [r.top, r.bottom, innerHeight]; });
  ok(t[0] >= 0 && t[1] <= t[2], 'title off screen: ' + t);
  const fc = await freshContext({ firstLaunch: true });
  await fc.ctx.addInitScript(() => { window.__SHOTREF_EMBED__ = { key: '!!!', project: { app: 'ShotRef', version: 1, state: { camera: { base: { p: [3, 1.6, 6], tg: [0, 1, 0], f: 35, roll: 0, fd: 7 }, keys: [] }, objects: [], settings: {} } } }; });
  const q = await fc.open(); await q.evaluate(() => { const S = window.__shotref; S.addObject('box'); S.changed(true); }); await settle(q, 800);
  ok(await q.evaluate(() => localStorage.getItem('shotref.autosave') === null && localStorage.getItem('shotref.autosave.embed') !== null), 'fallback key not used');
  noPageErrors(q);
});

check('deleting an object keeps the camera of every other shot where it was (mount and aim)', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const car = await mkObj(p, 'car', [10, 0, 0]);
  await p.evaluate(i => {
    const S = window.__shotref, st = S.state, cam = (o) => ({ base: { p: [3, 1.6, 6], tg: [0, 1, 0], f: 35, roll: 0, fd: 7 }, keys: [], feel: 'gentle', dof: { on: false, fstop: 2.8, auto: true, strength: 3 }, shake: 0, lookAtId: null, follow: false, ...o });
    st.camera = cam({ mount: i });
    st.shots = [{ id: 'a', name: 'Shot 1', camera: JSON.parse(JSON.stringify(st.camera)), duration: st.settings.duration }, { id: 'b', name: 'Shot 2', camera: cam({ mount: i }), duration: st.settings.duration }, { id: 'c', name: 'Shot 3', camera: cam({ lookAtId: i }), duration: st.settings.duration }];
    st.shotId = 'a'; S.changed(true, true); S.select(i);
  }, car);
  await p.keyboard.press('Delete'); await settle(p, 300);
  const st = await stateOf(p), b = st.shots[1].camera, c = st.shots[2].camera;
  ok(b.mount === null && near(b.base.p, [13, 1.6, 6], 0.05), 'the other shot rode on the car and moved: ' + JSON.stringify(b.base.p) + ' mount ' + b.mount);
  ok(st.camera.mount === null && near(st.camera.base.p, [13, 1.6, 6], 0.05), 'the live camera moved: ' + JSON.stringify(st.camera.base.p));
  ok(c.lookAtId === null && Math.abs(c.base.tg[0] - 10) < 0.05, 'the shot that looked at the car lost its aim: ' + JSON.stringify(c.base.tg));
  noErrors(p);
});

check('blur strength: a file with depth of field off and no strength gets 3 like the artifact, one with it on keeps 1', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const mk = dof => JSON.stringify({ app: 'ShotRef', version: 1, state: { v: 1, settings: { duration: 5, fps: 24 }, camera: { base: JSON.parse(CAM_BASE), keys: [], dof }, objects: [] }, assets: {} });
  await openFile(p, 'off.shotref.json', mk({ on: false, fstop: 2.8, auto: true }));
  ok(await p.evaluate(() => window.__shotref.state.camera.dof.strength) === 3, 'DOF off, no strength should read 3');
  await openFile(p, 'on.shotref.json', mk({ on: true, fstop: 2.8, auto: true }));
  ok(await p.evaluate(() => window.__shotref.state.camera.dof.strength) === 1, 'DOF on, no strength should keep 1');
  noErrors(p);
});

check('File menu on the web: Open shows the Recent grid with Open a file, and there is no second Recent projects item', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.click('#bFile');
  const cmds = await p.evaluate(() => [...document.querySelectorAll('#ctxMenu button')].map(b => b.dataset.cmd));
  ok(!cmds.includes('recent'), 'the web File menu still has Recent projects: ' + cmds);
  await p.click('#ctxMenu [data-cmd="open"]');
  await p.waitForSelector('#mRecent:not(.hidden)');
  ok(await p.$('#recFile') !== null, 'no Open a file button in the Recent dialog');
  noErrors(p);
});

check('right panel: notes fold into a ? on the heading, clicking a heading folds the section, and it is remembered', async ({ open, freshContext }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => window.__shotref.select(null)); await settle(p, 300);
  ok(await p.$('#props .sec > h3 > .qtip') !== null, 'no ? bubble on a section heading');
  ok(await p.$('#props .sec > p.note') === null && await p.$('#props .sec > div > p.note') === null, 'notes are still shown inline');
  const q = await p.evaluate(() => document.querySelector('#props .sec > h3 > .qtip').dataset.q);
  ok(q && q.length > 10, 'the ? has no text');
  const head = '#props .sec:has(> h3 > .qtip) > h3';
  await p.click(head); await settle(p, 200);
  ok(await p.evaluate(() => !!document.querySelector('#props .sec.closed')), 'clicking the heading did not fold the section');
  const saved = await p.evaluate(() => Object.keys(window.__shotref.getPref('closedSecs', {})));
  ok(saved.length === 1, 'folded state not saved in prefs: ' + saved);
  await p.evaluate(() => { window.__shotref.select('camera'); window.__shotref.select(null); }); await settle(p, 300);
  ok(await p.evaluate(() => !!document.querySelector('#props .sec.closed')), 'the section opened again after the panel was rebuilt');
  await p.click('#props .sec.closed > h3'); await settle(p, 200);
  ok(await p.evaluate(() => !document.querySelector('#props .sec.closed') && Object.keys(window.__shotref.getPref('closedSecs', {})).length === 0), 'opening it did not forget it');
  noErrors(p);
});

check('view buttons: Editor, Top, Camera and split live in the Shots row under the picture with a View label, centred, and still switch the view', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  ok(await p.evaluate(() => !document.querySelector('#top #viewSeg') && !document.querySelector('#top #bSplit')), 'still in the top bar');
  ok(await p.evaluate(() => !!document.querySelector('#shotRow #viewGrp #viewSeg') && !!document.querySelector('#shotRow #viewGrp #bSplit')), 'not in the Shots row');
  ok(await p.evaluate(() => document.querySelector('#shotSide').textContent === ''), 'stray text in the Shots row with one shot: ' + await p.evaluate(() => document.querySelector('#shotSide').textContent));
  ok(await p.evaluate(() => document.querySelector('#viewGrp .lbl').textContent.trim() === 'View'), 'no View label');
  const g = await p.evaluate(() => { const a = document.querySelector('#viewGrp').getBoundingClientRect(), r = document.querySelector('#shotRow').getBoundingClientRect(); return { dx: Math.abs((a.left + a.right) / 2 - (r.left + r.right) / 2), top: a.top, rtop: r.top, bottom: a.bottom, rbottom: r.bottom }; });
  ok(g.dx < 12, 'View group is not centred in the row (off by ' + Math.round(g.dx) + ' px)');
  ok(g.top >= g.rtop - 1 && g.bottom <= g.rbottom + 1, 'View group sticks out of its row');
  for (const v of ['camera', 'top', 'editor']) {
    await p.click('#viewSeg [data-v="' + v + '"]'); await settle(p, 250);
    ok(await p.evaluate(x => (document.querySelector('#viewSeg .on') || {}).dataset.v === x, v), 'view did not switch to ' + v);
  }
  await p.click('#bSplit'); await settle(p, 250);
  ok(await p.evaluate(() => window.__shotref.layout() === 'split'), 'split button did not work from the Shots row');
  /* with many shots the chips scroll and never run under the View group */
  for (let i = 0; i < 7; i++) { await p.click('#shotBar .shotchip.add'); await settle(p, 120); }
  const o = await p.evaluate(() => { const s = document.querySelector('#shotBar').getBoundingClientRect(), v = document.querySelector('#viewGrp').getBoundingClientRect(), c = document.querySelector('#bSheet').getBoundingClientRect(); return { chipsEnd: s.right, viewStart: v.left, viewEnd: v.right, sheetStart: c.left }; });
  ok(o.chipsEnd <= o.viewStart + 1, 'Shots chips overlap the View group');
  ok(o.viewEnd <= o.sheetStart + 1, 'View group overlaps the Contact sheet button');
  noErrors(p);
});

/* ---------------- tour engine ---------------- */
const TOUR3 = [{ id: 'a', target: '#bFile', title: 'File menu', text: 'Save and open projects here.' }, { id: 'b', target: '#bMenu', title: 'Settings', text: 'Advanced controls live here.' }, { id: 'c', target: null, title: 'Done', text: 'That is the tour.' }];
const startTour3 = (p, opts) => p.evaluate(([stops, o]) => { const t = window.__shotref.tour.run(stops, o || {}); window.__t = t; return !!t; }, [TOUR3, opts]);
const tourIdx = p => p.evaluate(() => window.__t ? window.__t.index : null);
const centre = (p, sel) => p.evaluate(s => { const b = document.querySelector(s).getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }, sel);

check('tour engine: shows corners around the target and a bubble that stays on screen', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  for (const [w, h] of [[1600, 900], [1280, 720]]) {
    await p.setViewportSize({ width: w, height: h }); await settle(p, 200);
    if (!await startTour3(p)) throw new Error('the tour did not start at ' + w);
    await settle(p, 600);
    const g = await p.evaluate(() => {
      const r = s => { const b = document.querySelector(s).getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
      const bub = document.querySelector('.tour-bubble');
      return { c: r('.tour-corners'), t: r('#bFile'), b: r('.tour-bubble'), vw: innerWidth, vh: innerHeight, role: bub.getAttribute('role'), lab: bub.getAttribute('aria-labelledby'), live: bub.getAttribute('aria-live'), z: getComputedStyle(document.querySelector('#tour')).zIndex, focus: document.activeElement === bub };
    });
    ok(g.c.l <= g.t.l - 5.5 && g.c.t <= g.t.t - 5.5 && g.c.r >= g.t.r + 5.5 && g.c.b >= g.t.b + 5.5, w + ': corners do not hold the target plus 6 px ' + JSON.stringify([g.c, g.t]));
    ok(g.b.l >= 0 && g.b.t >= 0 && g.b.r <= g.vw && g.b.b <= g.vh, w + ': the bubble leaves the window ' + JSON.stringify(g.b));
    ok(g.b.r <= g.t.l || g.b.l >= g.t.r || g.b.b <= g.t.t || g.b.t >= g.t.b, w + ': the bubble covers the target');
    ok(g.b.r - g.b.l <= 340.5, w + ': the bubble is wider than 340 px');
    ok(g.role === 'dialog' && g.lab === 'tourTitle' && g.live === 'polite' && g.z === '55', 'bubble attributes: ' + JSON.stringify(g));
    ok(g.focus, 'the bubble does not take focus');
    await p.evaluate(() => window.__t.end());
  }
  /* a narrow window: the bubble pins to the bottom at full width minus 16 px */
  await p.setViewportSize({ width: 800, height: 700 }); await settle(p, 200);
  await startTour3(p); await settle(p, 500);
  const n = await p.evaluate(() => { const b = document.querySelector('.tour-bubble').getBoundingClientRect(); return { w: b.width, bottom: innerHeight - b.bottom, cx: (b.left + b.right) / 2, vw: innerWidth }; });
  ok(Math.abs(n.w - (n.vw - 16)) < 1.5 && n.bottom < 20 && Math.abs(n.cx - n.vw / 2) < 1.5, 'the narrow bubble is not pinned to the bottom: ' + JSON.stringify(n));
  noErrors(p);
});

check('tour engine: Next, Back, Finish; Enter and arrows work', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await startTour3(p);
  ok(await tourIdx(p) === 0, 'did not start at stop 0');
  ok(await p.evaluate(() => document.querySelector('#tourNext').textContent === 'Next' && document.querySelector('#tourBack').disabled), 'first stop: Next label or Back not disabled');
  await p.click('#tourNext'); ok(await tourIdx(p) === 1, 'Next did not advance');
  await p.click('#tourBack'); ok(await tourIdx(p) === 0, 'Back did not go back');
  await p.keyboard.press('ArrowRight'); ok(await tourIdx(p) === 1, 'the right arrow did not advance');
  await p.keyboard.press('ArrowLeft'); ok(await tourIdx(p) === 0, 'the left arrow did not go back');
  await p.keyboard.press('Enter'); ok(await tourIdx(p) === 1, 'Enter did not advance');
  await p.keyboard.press('Enter'); ok(await tourIdx(p) === 2, 'Enter did not reach the last stop');
  await settle(p, 100);
  ok(await p.evaluate(() => document.querySelector('#tourNext').textContent === 'Finish'), 'the last stop does not say Finish');
  ok(await p.evaluate(() => document.querySelector('.tour-corners').classList.contains('off')), 'a stop with no target still shows corners');
  const c = await p.evaluate(() => { const b = document.querySelector('.tour-bubble').getBoundingClientRect(); return [Math.abs((b.left + b.right) / 2 - innerWidth / 2), Math.abs((b.top + b.bottom) / 2 - innerHeight / 2)]; });
  ok(c[0] < 2 && c[1] < 2, 'a stop with no target is not centred: ' + c);
  await p.click('#tourNext'); await settle(p, 100);
  ok(await p.evaluate(() => !document.querySelector('#tour') && !window.__shotref.tour.active()), 'Finish did not remove the tour');
  noErrors(p);
});

check('tour engine: Esc, End tour leave nothing behind', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  const state = () => p.evaluate(() => ({ gone: !document.querySelector('#tour'), active: window.__shotref.tour.active(), ae: document.activeElement && document.activeElement.id }));
  for (const how of ['esc', 'end']) {
    await p.focus('#bSplit');
    await p.evaluate(() => { window.__reason = null; window.__shotref.tour.run([{ id: 'a', target: '#bFile', title: 'T', text: 't' }, { id: 'b', target: null, title: 'U', text: 'u' }], { onEnd: r => { window.__reason = r; } }); });
    ok(!(await state()).gone, 'the tour did not start');
    if (how === 'esc') await p.keyboard.press('Escape'); else await p.click('#tourEnd');
    await settle(p, 100);
    const s = await state();
    ok(s.gone && !s.active, how + ': the tour is still there');
    ok(s.ae === 'bSplit', how + ': focus did not return, it is on ' + s.ae);
    ok(await p.evaluate(h => window.__reason === h, how), how + ': onEnd got the wrong reason');
    /* no leftover key handler: Space plays again */
    await p.evaluate(() => document.activeElement.blur());
    const before = await p.evaluate(() => document.querySelector('#bPlay').textContent);
    await p.keyboard.press(' '); await settle(p, 150);
    const after = await p.evaluate(() => document.querySelector('#bPlay').textContent);
    ok(before !== after, how + ': Space no longer toggles playback');
    await p.keyboard.press(' '); await settle(p, 100);
  }
  /* Esc goes to the app first when it has something to cancel */
  await p.evaluate(() => window.__shotref.tour.run([{ id: 'a', target: '#bFile', title: 'T', text: 't' }], {}));
  await p.evaluate(() => { const r = document.querySelector('#bUndo').getBoundingClientRect(); window.__shotref.showMenu(r.left, r.bottom, [{ label: 'x', id: 'x' }]); });
  await p.keyboard.press('Escape');
  ok(await p.evaluate(() => window.__shotref.tour.active()), 'Esc ended the tour although a menu was open');
  await p.keyboard.press('Escape');
  ok(await p.evaluate(() => !window.__shotref.tour.active()), 'a second Esc did not end the tour');
  noErrors(p);
});

check('tour engine: basic mode blocks app shortcuts and clicks', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => window.__shotref.addObject('person'));
  await settle(p, 200);
  const snap = () => p.evaluate(() => ({ view: window.__shotref.view, n: window.__shotref.state.objects.length, hi: window.__shotref.history.at }));
  const before = await snap();
  await startTour3(p); await settle(p, 500);
  await p.keyboard.press('t'); await settle(p, 100);
  ok((await snap()).view === before.view, 'pressing T changed the view during the tour');
  const r = await centre(p, '#bUndo');
  await p.mouse.click(r[0], r[1]); await settle(p, 150);
  const a = await snap();
  ok(a.n === before.n && a.hi === before.hi, 'a click on Undo got through the tour');
  /* the spotlit target is blocked too in a basic tour */
  const f = await centre(p, '#bFile');
  await p.mouse.click(f[0], f[1]); await settle(p, 150);
  ok(await p.evaluate(() => document.querySelector('#ctxMenu').style.display !== 'block'), 'a click on the spotlit File button opened its menu in a basic tour');
  await p.evaluate(() => window.__t.end());
  await p.keyboard.press('t'); await settle(p, 100);
  ok((await snap()).view === 'top', 'T does not work again after the tour');
  noErrors(p);
});

check('tour engine: an interactive tour lets clicks reach the target only', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => { window.__shotref.tour.run([{ id: 'a', target: '#bFile', title: 'T', text: 't' }, { id: 'b', target: null, title: 'U', text: 'u' }], { interactive: true }); });
  await settle(p, 500);
  const f = await centre(p, '#bFile');
  await p.mouse.click(f[0], f[1]); await settle(p, 150);
  ok(await p.evaluate(() => document.querySelector('#ctxMenu').style.display === 'block'), 'the click did not reach the spotlit button');
  await p.evaluate(() => window.__shotref.hideMenu());
  const r = await centre(p, '#bUndo');
  ok(await p.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return !!(e && e.closest('#tour')); }, r), 'a click outside the spotlight is not blocked');
  await p.focus('#bPlay'); await p.evaluate(() => document.activeElement.blur());
  await p.keyboard.press('t'); await settle(p, 100);
  ok(await p.evaluate(() => window.__shotref.view === 'top'), 'app shortcuts should stay on in an interactive tour');
  await p.evaluate(() => window.__shotref.tour.end());
  noErrors(p);
});

check('tour engine: a hands-on stop waits for a change, shows the tick, then moves on', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => {
    window.__shotref.tour.run([
      { id: 'a', target: '#bFile', title: 'T', text: 't', snap: () => window.__shotref.view, waitFor: s => window.__shotref.view !== s, done: 'Moved' },
      { id: 'b', target: null, title: 'U', text: 'u' }], { interactive: true });
  });
  await settle(p, 300);
  ok(await p.evaluate(() => document.querySelector('#tourNext').textContent === 'Skip this step'), 'a hands-on stop does not offer Skip this step');
  ok(await p.evaluate(() => document.querySelector('.tour-bubble .tour-title').textContent === 'T'), 'not on stop 1');
  await p.keyboard.press('t'); await settle(p, 200);
  ok(await p.evaluate(() => /Moved/.test(document.querySelector('.tour-done').textContent) && !document.querySelector('.tour-done').hidden), 'no tick and confirmation word after the change');
  await settle(p, 1000);
  ok(await p.evaluate(() => document.querySelector('.tour-bubble .tour-title').textContent === 'U'), 'the tour did not move on by itself');
  await p.evaluate(() => window.__shotref.tour.end());
  noErrors(p);
});

check('tour engine: refuses to start over a dialog', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => document.querySelector('#mHelp').classList.remove('hidden'));
  const res = await p.evaluate(() => { const r = window.__shotref.tour.run([{ id: 'a', target: null, title: 'T', text: 't' }], {}); const t = document.querySelector('#toast'); return { r, tour: !!document.querySelector('#tour'), shown: t.classList.contains('show'), text: t.textContent }; });
  ok(res.r === null && !res.tour, 'a tour started over a dialog');
  ok(res.shown && res.text.length > 5, 'no toast explained why');
  await p.evaluate(() => document.querySelector('#mHelp').classList.add('hidden'));
  ok(await p.evaluate(() => !!window.__shotref.tour.run([{ id: 'a', target: null, title: 'T', text: 't' }], {})), 'the tour does not start once the dialog is closed');
  await p.evaluate(() => window.__shotref.tour.end());
  noErrors(p);
});

check('tour engine: refuses to start during an export, and an empty stop list does nothing', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  ok(await p.evaluate(() => window.__shotref.tour.run([], {}) === null && !document.querySelector('#tour')), 'an empty stop list added a tour');
  await p.evaluate(() => { window.__ex = window.__shotref.exportVideo(); });
  const res = await p.evaluate(() => { const r = window.__shotref.tour.run([{ id: 'a', target: null, title: 'T', text: 't' }], {}); const t = document.querySelector('#toast'); return { r, tour: !!document.querySelector('#tour'), shown: t.classList.contains('show'), text: t.textContent }; });
  ok(res.r === null && !res.tour, 'a tour started during an export');
  ok(res.shown && /export/i.test(res.text), 'no toast about the export: ' + res.text);
  await p.evaluate(() => window.__ex).catch(() => { });
  noErrors(p);
});

check('tour engine: runs under the claude.ai CSP with no console errors', async ({ open }) => {
  const p = await open('app.html'); await settle(p, 400);
  await startTour3(p); await settle(p, 500);
  ok(await p.evaluate(() => !!document.querySelector('.tour-bubble') && document.querySelector('.tour-bubble').getBoundingClientRect().width > 0), 'the bubble is not shown under the CSP');
  await p.click('#tourNext'); await p.click('#tourNext'); await p.click('#tourNext'); await settle(p, 200);
  ok(await p.evaluate(() => !document.querySelector('#tour')), 'the tour did not finish under the CSP');
  ok(p.__errors.length === 0, 'errors under the CSP: ' + p.__errors.join(' | '));
});

check('tour engine: reduced motion jumps the corners, otherwise they travel in 350 ms', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await startTour3(p); await settle(p, 400);
  const d = await p.evaluate(() => getComputedStyle(document.querySelector('.tour-corners')).transitionDuration);
  ok(/^0\.35s/.test(d), 'the corners should travel in 0.35 s, got ' + d);
  await p.evaluate(() => window.__t.end());
  await p.emulateMedia({ reducedMotion: 'reduce' });
  await startTour3(p); await settle(p, 200);
  const d2 = await p.evaluate(() => getComputedStyle(document.querySelector('.tour-corners')).transitionDuration);
  ok(/^0s/.test(d2), 'reduced motion should not travel, got ' + d2);
  await p.evaluate(() => window.__t.end());
  noErrors(p);
});

/* ---------------- basic tour, first-run question, Help menu items ---------------- */
const TOUR_TARGET = `(() => { const t = window.__shotref.tour.current(); if (!t) return null; const s = t.stop; let e = null; try { e = typeof s.target === 'function' ? s.target() : s.target ? document.querySelector(s.target) : null; } catch (x) { } return { id: s.id, hasTarget: !!s.target, rect: e && e.getClientRects().length ? (r => ({ l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }))(e.getBoundingClientRect()) : null, vw: innerWidth, vh: innerHeight }; })()`;
const tourWarns = p => { p.__warns = []; p.on('console', m => { if (m.type() === 'warning' && /tour/i.test(m.text())) p.__warns.push(m.text()); }); };
const waitOpen = (p, id, ms = 3000) => p.waitForFunction(id => { const m = document.getElementById(id); return !!m && !m.classList.contains('hidden'); }, id, { timeout: ms });

for (const vp of [{ width: 1600, height: 900 }, { width: 1280, height: 720 }]) {
  check('basic tour: every stop finds a visible target at ' + vp.width + 'x' + vp.height, async ({ freshContext }) => {
    const fc = await freshContext({ viewport: vp });
    const p = await fc.open(); tourWarns(p); await settle(p, 300);
    ok(await p.evaluate(() => !!window.__shotref.startTour('basic')), 'the basic tour did not start');
    const seen = [];
    for (let n = 0; n < 12; n++) {
      await settle(p, 550); /* longer than the engine's missing-target delay, so a missing target would warn */
      const g = await p.evaluate(TOUR_TARGET);
      if (!g) break;
      seen.push(g.id);
      if (g.hasTarget) {
        ok(g.rect, 'stop ' + g.id + ' has no visible target');
        ok(g.rect.w > 0 && g.rect.h > 0 && g.rect.l >= 0 && g.rect.t >= 0 && g.rect.r <= g.vw && g.rect.b <= g.vh, 'stop ' + g.id + ' is outside the window: ' + JSON.stringify(g.rect));
      }
      await p.click('#tourNext');
    }
    ok(seen.join() === 'b-welcome,b-steps,b-add,b-picture,b-view,b-panel,b-timeline,b-file,b-gear,b-bye', 'stops were ' + seen.join());
    ok(await p.evaluate(() => !window.__shotref.tour.active()), 'the tour did not finish');
    ok(p.__warns.length === 0, 'tour warnings: ' + p.__warns.join(' | '));
    noErrors(p);
  });
}

check('basic tour: Advanced controls switched and window resized mid-tour', async ({ freshContext }) => {
  const fc = await freshContext({ viewport: { width: 1600, height: 900 } });
  const p = await fc.open(); await settle(p, 300);
  await p.evaluate(() => window.__shotref.startTour('basic'));
  for (let n = 0; n < 5; n++) { await p.click('#tourNext'); await settle(p, 60); }
  ok(await p.evaluate(() => window.__shotref.tour.current().stop.id) === 'b-panel', 'not at b-panel');
  const corners = () => p.evaluate(() => { const c = document.querySelector('.tour-corners').style, t = document.querySelector('#right').getBoundingClientRect(); return { c: [parseFloat(c.left), parseFloat(c.top), parseFloat(c.width), parseFloat(c.height)], t: [t.left, t.top, t.width, t.height] }; });
  await p.evaluate(() => { const S = window.__shotref; S.setSimple(!document.body.classList.contains('simple')); });
  await p.setViewportSize({ width: 1100, height: 700 });
  await p.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const g = await corners();
  const near = (a, b) => Math.abs(a - b) <= 14;
  ok(near(g.c[0], Math.max(0, g.t[0] - 6)) && near(g.c[1], Math.max(0, g.t[1] - 6)) && near(g.c[2], g.t[2] + 12) && near(g.c[3], g.t[3] + 12), 'corners ' + JSON.stringify(g.c) + ' do not frame the panel ' + JSON.stringify(g.t));
  ok(await p.evaluate(() => window.__shotref.tour.active()), 'the tour ended');
  await p.evaluate(() => window.__shotref.tour.end());
  noErrors(p);
});

check('first run asks about the tour, once', async ({ freshContext }) => {
  const fc = await freshContext({ firstLaunch: true });
  const p = await fc.open();
  await waitOpen(p, 'mTour');
  ok(!(await isOpen(p, 'mStart')), 'the starter picker opened before the tour question');
  const t = await p.evaluate(() => ({ title: document.querySelector('#mTourT').textContent, body: document.querySelector('#mTourP').textContent, q: document.querySelector('#tourQuick').textContent, hHidden: document.querySelector('#tourHands').hidden, n: document.querySelector('#tourNo').textContent }));
  /* the hands-on tour is switched off for now: only the quick tour is offered, with the one-tour wording */
  ok(t.title && t.q === 'Take the quick tour' && t.hHidden && /one-minute tour/.test(t.body) && t.n === 'Not now', 'welcome text: ' + JSON.stringify(t));
  await p.click('#tourNo');
  ok(!(await isOpen(p, 'mTour')), 'Not now left the question open');
  await waitOpen(p, 'mStart');
  await p.reload(); await p.waitForFunction(() => window.__shotref && window.__shotref.state); await settle(p, 900);
  ok(!(await isOpen(p, 'mTour')) && !(await isOpen(p, 'mStart')), 'the first-run windows came back after a reload');
  noPageErrors(p);
});

check('first run: Take the quick tour runs the basic tour, then the starter picker', async ({ freshContext }) => {
  const fc = await freshContext({ firstLaunch: true });
  const p = await fc.open();
  await waitOpen(p, 'mTour');
  await p.click('#tourQuick');
  ok(!(await isOpen(p, 'mTour')), 'the question stayed open');
  ok(await p.evaluate(() => window.__shotref.tour.active()), 'the tour did not start');
  ok(!(await isOpen(p, 'mStart')), 'the starter picker opened during the tour');
  for (let n = 0; n < 12 && await p.evaluate(() => window.__shotref.tour.active()); n++) { await p.click('#tourNext'); await settle(p, 40); }
  await waitOpen(p, 'mStart', 1500);
  ok(await p.evaluate(() => window.__shotref.getPref('tourBasicDone', false)) === true, 'tourBasicDone was not remembered');
  noPageErrors(p);
});

check('first run: ending the tour early still opens the starter picker', async ({ freshContext }) => {
  const fc = await freshContext({ firstLaunch: true });
  const p = await fc.open();
  await waitOpen(p, 'mTour');
  await p.click('#tourQuick'); await settle(p, 200);
  await p.keyboard.press('Escape');
  await waitOpen(p, 'mStart', 1500);
  ok(await p.evaluate(() => !window.__shotref.tour.active()), 'the tour is still running');
  /* a tour started later from the gear menu does not open the picker */
  await p.click('#mStart .x'); await gearCmd(p, 'tour-basic');
  ok(await p.evaluate(() => window.__shotref.tour.active()), 'the gear menu did not start the tour');
  await p.click('#tourEnd'); await settle(p, 300);
  ok(!(await isOpen(p, 'mStart')), 'a later tour opened the starter picker');
});

check('first run question is skipped for restored, opened and embedded sessions', async ({ freshContext }) => {
  const fc = await freshContext({ firstLaunch: true });
  const p = await fc.open();
  await waitOpen(p, 'mTour');
  await p.click('#tourNo'); await p.click('#mStart .x');
  await p.evaluate(() => { const S = window.__shotref; S.addObject('box'); S.changed(true); });
  await settle(p, 900);
  await p.evaluate(() => { try { localStorage.removeItem('shotref.seenHelp'); } catch (e) { } });
  await p.reload(); await p.waitForFunction(() => window.__shotref && window.__shotref.state); await settle(p, 900);
  ok(!(await isOpen(p, 'mTour')) && !(await isOpen(p, 'mStart')), 'a restored session asked about the tour');
  const fe = await freshContext({ firstLaunch: true });
  await fe.ctx.addInitScript(() => { window.__SHOTREF_EMBED__ = { key: 'tourdemo', project: { app: 'ShotRef', version: 1, state: { camera: { base: { p: [3, 1.6, 6], tg: [0, 1, 0], f: 35, roll: 0, fd: 7 }, keys: [] }, objects: [], settings: {} } } }; });
  const q = await fe.open(); await settle(q, 900);
  ok(!(await isOpen(q, 'mTour')) && !(await isOpen(q, 'mStart')), 'an embedded session asked about the tour');
});

check('Help heading in the gear menu starts both tours; Quick start page has both buttons', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.click('#bMenu');
  const m = await p.evaluate(() => ({ head: [...document.querySelectorAll('#ctxMenu .head')].map(e => e.textContent), cmds: [...document.querySelectorAll('#ctxMenu [data-cmd]')].map(e => e.dataset.cmd), role: document.querySelector('#ctxMenu [data-cmd="tour-basic"]').getAttribute('role') }));
  ok(m.head.includes('Help'), 'no Help heading: ' + m.head);
  ok(m.cmds.join() === 'advanced,ground,settings,tour-basic,help,about', 'items (hands-on tour switched off): ' + m.cmds.join());
  ok(m.role === 'menuitemcheckbox', 'the tour item has no tick slot');
  await p.click('#ctxMenu [data-cmd="tour-basic"]');
  ok(await p.evaluate(() => window.__shotref.tour.active()), 'the gear menu item did not start the basic tour');
  await p.evaluate(() => window.__shotref.tour.end());
  ok(await p.evaluate(() => window.__shotref.getPref('tourBasicDone', false)) === true, 'ending the tour did not set tourBasicDone');
  await p.click('#bMenu');
  ok(await p.evaluate(() => document.querySelector('#ctxMenu [data-cmd="tour-basic"]').getAttribute('aria-checked')) === 'true', 'no tick after the tour');
  await p.keyboard.press('Escape');
  /* switched off: no hands-on item, no hands-on button on the Quick start page */
  await gearCmd(p, 'help');
  ok(await p.evaluate(() => document.querySelector('#helpTourHands').hidden), 'the Quick start page offers the switched-off hands-on tour');
  await p.keyboard.press('Escape'); await settle(p, 150);
  /* switched back on (the hidden handsTour pref): the practice stage tour is reachable again */
  await p.evaluate(() => window.__shotref.setHandsTour(true));
  await gearCmd(p, 'tour-hands');
  ok(await p.evaluate(() => window.__shotref.tour.active() && window.__shotref.practicing() && window.__shotref.tour.current().stop.id === 'h-welcome'), 'the gear menu item did not start the hands-on tour on the practice stage');
  await p.click('#tourEnd'); await settle(p, 200);
  ok(await p.evaluate(() => !window.__shotref.tour.active() && !window.__shotref.practicing()), 'the hands-on tour did not end');
  await gearCmd(p, 'help');
  ok(await isOpen(p, 'mHelp'), 'Quick start did not open');
  const b = await p.evaluate(() => ({ q: document.querySelector('#helpTourQuick').textContent, h: document.querySelector('#helpTourHands').textContent, lead: document.querySelector('#helpTourLead').textContent }));
  ok(b.q === 'Take the quick tour' && b.h === 'Try it hands-on' && /guided walk/.test(b.lead), 'help page: ' + JSON.stringify(b));
  ok(await p.evaluate(() => !document.querySelector('#helpTourHands').hidden), 'switched on, the Quick start page still hides the hands-on button');
  await p.click('#helpTourQuick');
  ok(!(await isOpen(p, 'mHelp')), 'the Quick start page stayed open');
  ok(await p.evaluate(() => window.__shotref.tour.active()), 'the Quick start button did not start the tour');
  await p.evaluate(() => window.__shotref.tour.end());
  noErrors(p);
});

check('tour dimming is the charcoal at about 62 percent', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => window.__shotref.startTour('basic')); await settle(p, 500);
  const c = await p.evaluate(() => getComputedStyle(document.querySelector('.tour-dim')).boxShadow);
  /* the browser reports color-mix() as rgba(...) or as color(srgb r g b / a) with 0..1 channels */
  let m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(c), rgb, a;
  if (m) { rgb = [+m[1], +m[2], +m[3]]; a = m[4] === undefined ? 1 : parseFloat(m[4]); }
  else { m = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/.exec(c); ok(m, 'no colour in the dim shadow: ' + c); rgb = [m[1], m[2], m[3]].map(v => Math.round(parseFloat(v) * 255)); a = m[4] === undefined ? 1 : parseFloat(m[4]); }
  ok(rgb.join() === '14,15,18' && Math.abs(a - 0.62) < 0.03, 'dim colour is ' + c);
  await p.evaluate(() => window.__shotref.tour.end());
});

check('first run: Esc on the tour question counts as Not now and opens the starter picker', async ({ freshContext }) => {
  const fc = await freshContext({ firstLaunch: true });
  const p = await fc.open();
  await waitOpen(p, 'mTour');
  await p.keyboard.press('Escape');
  ok(!(await isOpen(p, 'mTour')), 'Esc left the question open');
  await waitOpen(p, 'mStart', 1500);
  ok(await p.evaluate(() => !window.__shotref.tour.active()), 'a tour started');
});

check('first run: a file opened while the tour question is up closes it and keeps the file', async ({ freshContext }) => {
  const fc = await freshContext({ firstLaunch: true });
  await fc.ctx.addInitScript(FAKE_DESKTOP);
  const p = await fc.open();
  await waitOpen(p, 'mTour');
  const st = await stateOf(p); st.objects = st.objects.slice(0, 2);
  const text = JSON.stringify({ app: 'ShotRef', version: 2, state: st, assets: {} });
  await p.evaluate(t => window.__dsk.openCb({ text: t, name: 'late.shotref', path: 'E:/late.shotref' }), text);
  await p.waitForFunction(() => window.__shotref.state.objects.length === 2, null, { timeout: 4000 }).catch(() => { throw new Error('the opened project did not load'); });
  await settle(p, 500);
  ok(!(await isOpen(p, 'mTour')), 'the tour question stayed open over the opened project');
  ok(!(await isOpen(p, 'mStart')), 'the starter picker opened over the opened project');
  noPageErrors(p);
});

check('first run: a refused tour start still opens the starter picker', async ({ freshContext }) => {
  const fc = await freshContext({ firstLaunch: true });
  const p = await fc.open();
  await waitOpen(p, 'mTour'); await p.click('#tourNo'); await waitOpen(p, 'mStart');
  await p.click('#mStart .x'); await gearCmd(p, 'help'); ok(await isOpen(p, 'mHelp'), 'Quick start did not open');
  const r = await p.evaluate(() => { const h = window.__shotref.startTour('basic', { firstRun: true }); return h === null; });
  ok(r, 'the tour started over a dialog');
  ok(await isOpen(p, 'mStart'), 'a refused first-run tour did not open the starter picker');
});

check('basic tour: the picture stop puts the bubble in the top-left corner of the picture', async ({ freshContext }) => {
  for (const vp of [{ width: 1600, height: 900 }, { width: 1280, height: 720 }]) {
    const fc = await freshContext({ viewport: vp });
    const p = await fc.open(); await settle(p, 300);
    await p.evaluate(() => window.__shotref.startTour('basic'));
    for (let n = 0; n < 3; n++) { await p.click('#tourNext'); await settle(p, 60); }
    await settle(p, 500);
    const g = await p.evaluate(() => { const t = document.querySelector('#vp').getBoundingClientRect(), b = document.querySelector('.tour-bubble').getBoundingClientRect(); return { id: window.__shotref.tour.current().stop.id, t: [t.left, t.top, t.width, t.height], b: [b.left, b.top, b.right, b.bottom] }; });
    ok(g.id === 'b-picture', 'not at b-picture');
    ok(g.b[0] >= g.t[0] && g.b[1] >= g.t[1] && g.b[2] <= g.t[0] + g.t[2] / 2 && g.b[3] <= g.t[1] + g.t[3] / 2, vp.width + ': the bubble ' + JSON.stringify(g.b) + ' is not inside the top-left quadrant of ' + JSON.stringify(g.t));
  }
});

/* ---- practice stage (the hands-on tour's empty stage; the user's scene is set aside in memory and must come back exactly) ---- */
const practiceReal = async (p, fixtures) => { /* a scene with 3 objects, a location photo and several undo steps, marked unsaved */
  await p.setInputFiles('#fPlate', path.join(fixtures, 'location.jpg'));
  await p.waitForFunction(() => window.__shotref.state.plate && window.__shotref.state.plate.asset);
  await p.evaluate(() => { const S = window.__shotref; for (let i = 1; i <= 3; i++) { S.state.objects[0].base.p = [i, 0, 0]; S.changed(true); } });
  await settle(p, 300);
};
const practiceSnap = p => p.evaluate(() => { const S = window.__shotref; return { st: JSON.stringify(S.stateForSave()), n: S.state.objects.length, plate: !!S.state.plate, assets: Object.keys(S.assets).sort().join(), hist: S.history.length, at: S.history.at, doc: S.docInfo(), sel: S.selection.join(), T: S.T, view: S.view, ed: S.editCamPos().join() }; });
const practiceSame = (a, b, what) => { for (const k of Object.keys(a)) ok(JSON.stringify(a[k]) === JSON.stringify(b[k]), what + ': ' + k + ' differs: ' + JSON.stringify(a[k]).slice(0, 120) + ' vs ' + JSON.stringify(b[k]).slice(0, 120)); };
/* sets the scene aside and runs a two-stop interactive tour that leaves the practice stage when it ends, as the real hands-on tour does */
const practiceStart = p => p.evaluate(() => { const S = window.__shotref; if (!S.practice.enter()) return false; return !!S.tour.run([{ id: 'a', target: '#bFile', title: 'T', text: 't' }, { id: 'b', target: null, title: 'U', text: 'u' }], { interactive: true, onEnd: () => S.practice.leave() }); });
const practiceEdit = p => p.evaluate(() => { const S = window.__shotref; S.addObject('person'); S.changed(true); S.addObject('box'); S.changed(true); });
const noTour = p => p.evaluate(() => !document.querySelector('#tour'));

check('practice: Finish, End tour and Esc each bring the scene back exactly', async ({ open, fixtures }) => {
  for (const how of ['finish', 'end', 'esc']) {
    const p = await open(); await settle(p, 300);
    await practiceReal(p, fixtures);
    const before = await practiceSnap(p);
    ok(before.n === 3 && before.plate && before.hist >= 4 && before.doc.dirty === true, how + ': set-up is not the scene the test needs: ' + JSON.stringify({ n: before.n, plate: before.plate, hist: before.hist, dirty: before.doc.dirty }));
    ok(await practiceStart(p), how + ': the practice tour did not start');
    ok(await p.evaluate(() => window.__shotref.practicing() && window.__shotref.state.objects.length === 0 && !window.__shotref.state.plate), how + ': the stage is not empty');
    await practiceEdit(p); await settle(p, 200);
    if (how === 'finish') { await p.click('#tourNext'); await p.click('#tourNext'); }
    else if (how === 'end') await p.click('#tourEnd');
    else await p.keyboard.press('Escape');
    await settle(p, 300);
    ok(await noTour(p), how + ': the tour is still on screen');
    ok(!(await p.evaluate(() => window.__shotref.practicing())), how + ': still practising');
    practiceSame(before, await practiceSnap(p), how);
    ok(await p.evaluate(() => window.__shotref.practice.leave()) === false, how + ': a second leave() restored something again');
    practiceSame(before, await practiceSnap(p), how + ' after a second leave');
    noErrors(p, how);
    await p.close();
  }
}, { timeout: 120000 });

check('practice: nothing is written while practising', async ({ open }) => {
  const p = await open(); await settle(p, 800);
  await p.evaluate(() => {
    window.__w = { auto: 0, idb: 0 };
    const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (String(k).startsWith('shotref.autosave')) window.__w.auto++; return set.call(this, k, v); };
    for (const m of ['put', 'add', 'delete', 'clear']) { const o = IDBObjectStore.prototype[m]; IDBObjectStore.prototype[m] = function () { window.__w.idb++; return o.apply(this, arguments); }; }
  });
  const raw0 = await p.evaluate(() => localStorage.getItem('shotref.autosave'));
  const before = await practiceSnap(p), rw = await p.evaluate(() => window.__shotref.recentStats.writes);
  ok(await practiceStart(p), 'the practice tour did not start');
  await practiceEdit(p);
  await p.evaluate(() => { const S = window.__shotref; S.state.objects[0].base.p = [2, 0, 1]; S.changed(true); });
  await p.evaluate(async () => { const S = window.__shotref; await S.saveRecentNow(); S.recentFlush(); window.dispatchEvent(new Event('pagehide')); document.dispatchEvent(new Event('visibilitychange')); });
  await settle(p, 1500); /* longer than the 400 ms autosave timer */
  const w = await p.evaluate(() => ({ ...window.__w, rw: window.__shotref.recentStats.writes, info: window.__shotref.docInfo() }));
  ok(w.auto === 0, 'the autosave was written ' + w.auto + ' time(s) during practice');
  ok(w.idb === 0, 'IndexedDB was written ' + w.idb + ' time(s) during practice (photos or the Recent list)');
  ok(w.rw === rw, 'a Recent projects entry was written during practice');
  ok(JSON.stringify(w.info) === JSON.stringify(before.doc), 'the unsaved mark or file name changed during practice: ' + JSON.stringify(w.info));
  await p.keyboard.press('Escape'); await settle(p, 1000);
  ok(await p.evaluate(() => localStorage.getItem('shotref.autosave')) === raw0, 'the autosave record changed');
  practiceSame(before, await practiceSnap(p), 'after');
  noErrors(p);
});

check('practice: reload mid-tour reopens the real scene', async ({ open, fixtures }) => {
  const p = await open(); await settle(p, 300);
  await practiceReal(p, fixtures);
  await settle(p, 1000); /* the autosave of the real scene */
  const loaded = async () => { await p.waitForFunction(() => window.__shotref && window.__shotref.state); await p.waitForFunction(() => { const S = window.__shotref; return !S.state.plate || S.assets[S.state.plate.asset]; }, null, { timeout: 8000 }); await settle(p, 500); return p.evaluate(() => { const S = window.__shotref; return { st: JSON.stringify(S.state), assets: Object.keys(S.assets).sort().join(), dirty: S.docInfo().dirty }; }); };
  await p.reload(); const control = await loaded(); /* what a plain reload gives */
  ok(control.st.length > 100 && control.dirty === true, 'the control reload did not restore the unsaved scene');
  ok(await practiceStart(p), 'the practice tour did not start');
  await practiceEdit(p); await settle(p, 1200);
  await p.reload();
  const after = await loaded();
  ok(after.st === control.st, 'the reloaded scene differs from the real one');
  ok(after.assets === control.assets && after.dirty === control.dirty, 'assets or the unsaved mark differ after reload');
  ok(await noTour(p) && !(await p.evaluate(() => window.__shotref.practicing())), 'the tour or the practice stage survived a reload');
});

check('practice: undo stops at the practice stage', async ({ open, fixtures }) => {
  const p = await open(); await settle(p, 300);
  await practiceReal(p, fixtures);
  const before = await practiceSnap(p);
  ok(await practiceStart(p), 'the practice tour did not start');
  await practiceEdit(p);
  await p.evaluate(() => document.activeElement && document.activeElement.blur());
  for (let i = 0; i < 10; i++) { await p.keyboard.press('Control+z'); await p.waitForTimeout(40); }
  const mid = await p.evaluate(() => ({ n: window.__shotref.state.objects.length, plate: !!window.__shotref.state.plate, at: window.__shotref.history.at }));
  ok(mid.n === 0 && !mid.plate && mid.at === 0, 'undo went past the practice stage: ' + JSON.stringify(mid));
  await p.click('#tourEnd'); await settle(p, 300);
  practiceSame(before, await practiceSnap(p), 'after');
  noErrors(p);
}, { timeout: 90000 });

check('practice: Open, New, Save, Save as, Recent and dropping a file end the tour first', async ({ open, fixtures }) => {
  const modalOpen = (p, id) => p.waitForFunction(id => { const m = document.getElementById(id); return !!m && !m.classList.contains('hidden'); }, id, { timeout: 5000 }).catch(() => { throw new Error(id + ' did not open'); });
  const backAtOnce = async (p, before, what) => { /* the scene is back by the time the action's own window shows */
    ok(await noTour(p) && !(await p.evaluate(() => window.__shotref.practicing())), what + ': the tour or practice is still on');
    const now = await practiceSnap(p);
    if (/^save/.test(what)) { ok(now.doc.dirty === false, what + ': Save of the real scene did not clear the unsaved mark'); delete before.doc; delete now.doc; } /* a web Save downloads the file and clears the mark */
    practiceSame(before, now, what);
  };
  for (const how of ['new', 'open', 'save', 'saveas', 'drop']) {
    const p = await open(); await settle(p, 300);
    await practiceReal(p, fixtures);
    const before = await practiceSnap(p);
    ok(await practiceStart(p), how + ': the practice tour did not start');
    await practiceEdit(p);
    if (how === 'drop') {
      await p.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(['{"app":"ShotRef","version":2,"state":{"camera":{"base":{"p":[3,1.6,6],"tg":[0,1,0],"f":35,"roll":0,"fd":7},"keys":[]},"objects":[]},"assets":{}}'], 'other.shotref', { type: 'application/json' })); document.querySelector('#vp').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); });
      await modalOpen(p, 'mConfirm'); await backAtOnce(p, before, how);
      await p.click('#mConfirm [data-close]');
    } else if (how === 'new') { await fileCmd(p, 'new'); await modalOpen(p, 'mStart'); await backAtOnce(p, before, how); }
    else if (how === 'open') { await fileCmd(p, 'open'); await modalOpen(p, 'mRecent'); await backAtOnce(p, before, how); }
    else { await p.click('#bFile'); await p.click('#ctxMenu [data-cmd="' + how + '"]'); await settle(p, 400); await backAtOnce(p, before, how); }
    noErrors(p, how);
    await p.close();
  }
}, { timeout: 150000 });

check('practice: a Save-changes box over the tour is clickable and nothing is left behind', async ({ open, fixtures }) => {
  const p = await open(); await settle(p, 300);
  await practiceReal(p, fixtures);
  const before = await practiceSnap(p);
  ok(await practiceStart(p), 'the practice tour did not start');
  await fileCmd(p, 'new'); await p.waitForSelector('#mStart:not(.hidden)');
  await p.click('#startGrid .card:has-text("Street")');
  await p.waitForSelector('#mConfirm:not(.hidden)');
  ok(await noTour(p), 'the tour is still on screen over the question');
  const hit = await p.evaluate(() => { const b = document.querySelector('#cfOk').getBoundingClientRect(), e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!e && !!e.closest('#mConfirm'); });
  ok(hit, 'the question box is covered by something');
  ok(await p.evaluate(() => Number(getComputedStyle(document.querySelector('#mConfirm')).zIndex) >= 50), 'the question box sits below the tour layer');
  practiceSame(before, await practiceSnap(p), 'while asking');
  await p.click('#mConfirm [data-close]'); await settle(p, 200);
  ok(await noTour(p), 'a tour element is left behind');
  practiceSame(before, await practiceSnap(p), 'after closing the question');
  noErrors(p);
});

check('practice: exporting a video or a frame pack ends the tour first', async ({ open, fixtures }) => {
  for (const how of ['video', 'pack']) {
    const p = await open(); await settle(p, 300);
    await practiceReal(p, fixtures);
    await p.evaluate(() => { const s = window.__shotref.state.settings; s.size = 1280; s.duration = 1; window.__shotref.changed(true); });
    ok(await practiceStart(p), how + ': the practice tour did not start');
    await practiceEdit(p);
    if (how === 'video') { await p.evaluate(() => { window.__ex = window.__shotref.exportVideo(); }); }
    else { await p.evaluate(() => window.__shotref.select('export')); await settle(p, 400); await p.evaluate(() => document.querySelector('#xoPack').click()); }
    const during = await p.evaluate(() => ({ practicing: window.__shotref.practicing(), tour: !!document.querySelector('#tour'), n: window.__shotref.state.objects.length }));
    ok(!during.practicing && !during.tour && during.n === 3, how + ': export started on the practice stage: ' + JSON.stringify(during));
    if (how === 'video') await p.evaluate(() => window.__ex).catch(() => { });
    await settle(p, 1500);
    ok(await p.evaluate(() => window.__shotref.state.objects.length) === 3, how + ': the real scene is not back');
    noErrors(p, how);
    await p.close();
  }
}, { timeout: 120000 });

check('practice: the undo steps of the real scene keep their takes after many practice edits with takes', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await takeCmd(p, 'newtake');
  const ids = (await stateOf(p)).takes.map(t => t.id);
  for (let i = 0; i < 4; i++) { await p.evaluate(id => window.__shotref.switchTake(id), ids[i % 2]); await addBoxes(p, 1); }
  const takesNow = () => p.evaluate(() => window.__shotref.state.takes.map(t => t.name).join());
  const before = await practiceSnap(p), pr0 = await p.evaluate(() => window.__shotref.snapPruned());
  ok(await practiceStart(p), 'the practice tour did not start');
  await p.evaluate(() => { const S = window.__shotref; S.newTake(); const t = S.state.takes.map(x => x.id); for (let i = 0; i < 40; i++) { S.switchTake(t[i % t.length]); S.addObject('box'); S.changed(true); } });
  ok(await p.evaluate(() => window.__shotref.snapPruned()) === pr0, 'the undo pool was pruned while the real scene was set aside');
  await p.click('#tourEnd'); await settle(p, 300);
  practiceSame(before, await practiceSnap(p), 'after');
  await p.evaluate(() => document.activeElement && document.activeElement.blur());
  const names = await takesNow();
  for (let i = 0; i < 8; i++) { await p.keyboard.press('Control+z'); await p.waitForTimeout(60); }
  ok(await takesNow() === names, 'an older step lost a take: ' + await takesNow() + ' vs ' + names);
  noErrors(p);
}, { timeout: 90000 });

check('practice: a photo imported just before the tour is stored, so a reload mid-practice still has it', async ({ open, fixtures }) => {
  const p = await open(); await settle(p, 300);
  await p.setInputFiles('#fPlate', path.join(fixtures, 'location.jpg'));
  await p.waitForFunction(() => window.__shotref.state.plate && window.__shotref.state.plate.asset);
  const id = await p.evaluate(() => window.__shotref.state.plate.asset);
  ok(await practiceStart(p), 'the practice tour did not start'); /* inside the 400 ms autosave delay */
  await settle(p, 1200);
  await p.reload(); await p.waitForFunction(() => window.__shotref && window.__shotref.state);
  await p.waitForFunction(i => window.__shotref.assets[i], id, { timeout: 8000 }).catch(() => { throw new Error('the photo is gone after a reload mid-practice'); });
  ok(await p.evaluate(i => window.__shotref.state.plate && window.__shotref.state.plate.asset === i, id), 'the plate is not back');
  noErrors(p);
});

check('practice: dropping a photo mid-practice ends the tour and the photo goes into the real scene', async ({ open, fixtures }) => {
  const p = await open(); await settle(p, 300);
  ok(await practiceStart(p), 'the practice tour did not start');
  const b64 = fs.readFileSync(path.join(fixtures, 'location.jpg')).toString('base64');
  await p.evaluate(b => { const u = Uint8Array.from(atob(b), c => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([u], 'pic.jpg', { type: 'image/jpeg' })); document.querySelector('#vp').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); }, b64);
  await settle(p, 1200);
  ok(await noTour(p) && !(await p.evaluate(() => window.__shotref.practicing())), 'the tour or practice is still on');
  const r = await p.evaluate(() => { const S = window.__shotref; return { n: S.state.objects.length, img: S.state.objects.some(o => o.type === 'image'), plate: !!S.state.plate }; });
  ok(r.n >= 4 || r.plate, 'the real scene did not get the photo: ' + JSON.stringify(r));
  noErrors(p);
});

/* ---------------- hands-on tour (the real UI, on the practice stage) ---------------- */
const HANDS_IDS = ['h-welcome', 'h-build', 'h-place', 'h-drag', 'h-rightclick', 'h-scenetab', 'h-top', 'h-camera', 'h-cambar', 'h-focus', 'h-play', 'h-key', 'h-shots', 'h-take', 'h-gear', 'h-export'];
const handsId = p => p.evaluate(() => { const t = window.__shotref.tour.current(); return t ? t.stop.id : null; });
const handsTick = p => p.evaluate(() => { const d = document.querySelector('.tour-done'); return !!d && !d.hidden; });
const handsAt = async (p, id) => { /* waits for a stop, then for the corners and the bubble to settle */
  await p.waitForFunction(i => { const t = window.__shotref.tour.current(); return !!t && t.stop.id === i; }, id, { timeout: 4000 }).catch(() => { throw new Error('never reached ' + id); });
  await settle(p, 450);
  ok(await p.evaluate(() => document.querySelector('.tour-done').offsetHeight === 0), id + ': an old tick is still drawn on a new stop');
};
/* the stop is shown and waits; `act` is what a person does; then the tick shows and the tour moves on within 1 s */
const handsTry = async (p, id, act) => {
  await handsAt(p, id);
  ok(await handsId(p) === id && !(await handsTick(p)), id + ': it moved on before the action');
  await act();
  await p.waitForFunction(() => { const d = document.querySelector('.tour-done'); return !!d && !d.hidden && d.textContent.length > 2; }, null, { timeout: 2000 }).catch(() => { throw new Error(id + ': no tick and confirmation word after the action'); });
  await p.waitForFunction(i => { const t = window.__shotref.tour.current(); return !t || t.stop.id !== i; }, id, { timeout: 1200 }).catch(() => { throw new Error(id + ': did not move on within 1 s of the tick'); });
};
const handsNext = async (p, id) => { await handsAt(p, id); await p.click('#tourNext'); };
/* the screen point of the newest person (chest height, so a medium shot and the editor view both hit them) */
const personPt = p => p.evaluate(() => { const S = window.__shotref, o = S.state.objects.filter(q => q.type === 'person').pop(); const q = S.evalObj(o, S.T).p; return S.project(q[0], q[1] + 0.9, q[2]); });
/* the bubble must not sit on the thing the person is asked to click */
const bubbleClear = async (p, sel, what) => {
  const hit = await p.evaluate(s => { const b = document.querySelector('.tour-bubble').getBoundingClientRect(), t = document.querySelector(s); if (!t) return 'missing'; const r = t.getBoundingClientRect(); return !(b.right <= r.left || b.left >= r.right || b.bottom <= r.top || b.top >= r.bottom); }, sel);
  ok(hit !== 'missing', what + ': ' + sel + ' is not on screen');
  ok(hit === false, what + ': the bubble covers ' + sel);
};
const handsStart = async p => { ok(await p.evaluate(() => !!window.__shotref.startTour('hands')), 'the hands-on tour did not start'); await settle(p, 300); };
/* skip a stop with its main button, as a person who does not want to do the action would */
const handsSkipTo = async (p, id) => { for (let n = 0; n < 20 && await handsId(p) !== id; n++) { await p.click('#tourNext'); await settle(p, 120); } ok(await handsId(p) === id, 'could not skip to ' + id); await settle(p, 450); };
const bigCentre = p => p.evaluate(() => { const b = document.querySelector('#c').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; });

check('hands-on tour: each try-stop advances only after its action, through the real UI', async ({ open, fixtures }) => {
  const p = await open(); await settle(p, 300);
  await practiceReal(p, fixtures);
  const before = await practiceSnap(p);
  await handsStart(p);
  ok(await p.evaluate(() => window.__shotref.practicing() && window.__shotref.state.objects.length === 0), 'the practice stage is not on');
  ok(await p.evaluate(() => window.__shotref.tour.current().stop.id) === 'h-welcome', 'does not open on the welcome');
  await handsNext(p, 'h-welcome');
  await handsTry(p, 'h-build', async () => { await bubbleClear(p, '#stepSeg [data-step=build]', 'h-build'); await p.click('#stepSeg [data-step=build]'); });
  await handsTry(p, 'h-place', async () => {
    await bubbleClear(p, '#addArea .tile[data-body=man]', 'h-place'); await settle(p, 100);
    await p.click('#addArea .tile[data-body=man]'); await settle(p, 150);
    ok(await p.evaluate(() => !!window.__shotref.placing) && !(await handsTick(p)), 'h-place: clicking Person alone finished the stop');
    const [x, y] = await bigCentre(p); await bubbleClear(p, '#modeBar', 'h-place'); await p.mouse.move(x, y); await p.mouse.click(x, y);
  });
  ok(await p.evaluate(() => window.__shotref.state.objects.filter(o => o.type === 'person').length) === 1, 'h-place: no person was placed');
  await handsTry(p, 'h-drag', async () => {
    const [x, y] = await personPt(p), p0 = await p.evaluate(() => window.__shotref.state.objects[0].base.p.join());
    await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.move(x + 60, y + 20, { steps: 6 }); await p.mouse.move(x + 150, y + 10, { steps: 8 }); await p.mouse.up();
    ok(await p.evaluate(() => window.__shotref.state.objects[0].base.p.join()) !== p0, 'h-drag: the drag did not move the person');
  });
  await handsTry(p, 'h-rightclick', async () => {
    const [x, y] = await personPt(p); await p.mouse.click(x, y, { button: 'right' });
  });
  await handsTry(p, 'h-scenetab', async () => { await bubbleClear(p, '#leftTabs [data-lt=scene]', 'h-scenetab'); await p.click('#leftTabs [data-lt=scene]'); });
  await handsTry(p, 'h-top', async () => { await bubbleClear(p, '#viewSeg [data-v=top]', 'h-top'); await p.keyboard.press('t'); });
  ok(await p.evaluate(() => window.__shotref.view) === 'top', 'T did not show the Top view');
  await handsTry(p, 'h-camera', async () => { await bubbleClear(p, '#viewSeg [data-v=camera]', 'h-camera'); await p.keyboard.press('c'); });
  ok(await p.evaluate(() => window.__shotref.view) === 'camera', 'C did not show the Camera view');
  await handsNext(p, 'h-cambar');
  await handsTry(p, 'h-focus', async () => {
    ok(await p.evaluate(() => window.__shotref.view) === 'camera', 'h-focus: not in the Camera view');
    const [x, y] = await personPt(p);
    const vp = await p.evaluate(() => { const b = document.querySelector('#c').getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; });
    ok(x > vp[0] && x < vp[2] && y > vp[1] && y < vp[3], 'h-focus: the person is not in the picture after the tour framed them');
    await p.mouse.dblclick(x, y);
  });
  ok(await p.evaluate(() => { const d = window.__shotref.state.camera.dof; return !!d && d.on && !d.auto; }), 'h-focus: depth of field is not on with a pick');
  await handsTry(p, 'h-play', async () => { await bubbleClear(p, '#bPlay', 'h-play'); await p.keyboard.press('Space'); });
  await handsNext(p, 'h-key'); await handsNext(p, 'h-shots'); await handsNext(p, 'h-take'); await handsNext(p, 'h-gear');
  await handsTry(p, 'h-export', async () => { await bubbleClear(p, '#bExport', 'h-export'); await p.click('#bExport'); });
  await settle(p, 300);
  ok(await noTour(p), 'the tour is still on screen after the last stop');
  ok(!(await p.evaluate(() => window.__shotref.practicing())), 'still practising after the last stop');
  practiceSame(before, await practiceSnap(p), 'after the hands-on tour');
  ok(await p.evaluate(() => window.__shotref.getPref('tourHandsDone')) === true, 'tourHandsDone was not set');
  noErrors(p);
}, { timeout: 120000 });

check('hands-on tour: a condition already true never skips a stop', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await handsStart(p);
  await handsSkipTo(p, 'h-drag'); /* the practice scene now has a person */
  ok(await p.evaluate(() => window.__shotref.state.objects.filter(o => o.type === 'person').length) === 1, 'no person to start from');
  await p.click('#tourBack'); await handsAt(p, 'h-place');
  await settle(p, 1200);
  ok(await handsId(p) === 'h-place' && !(await handsTick(p)), 'h-place was skipped because a person was already there');
  await p.click('#addArea .tile[data-body=man]'); const [x, y] = await bigCentre(p); await p.mouse.move(x, y); await p.mouse.click(x, y);
  await p.waitForFunction(() => !!document.querySelector('.tour-done') && !document.querySelector('.tour-done').hidden, null, { timeout: 2000 }).catch(() => { throw new Error('placing one more person did not finish the stop'); });
  ok(await p.evaluate(() => window.__shotref.state.objects.filter(o => o.type === 'person').length) === 2, 'not two people');
  await p.click('#tourEnd'); await settle(p, 200);
  noErrors(p);
});

check('hands-on tour: deleting the person at h-drag does not complete the stop', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await handsStart(p);
  await handsSkipTo(p, 'h-drag');
  await p.keyboard.press('Delete'); await settle(p, 300);
  ok(await p.evaluate(() => window.__shotref.state.objects.filter(o => o.type === 'person').length) === 0, 'the person was not deleted');
  await settle(p, 1200);
  ok(await handsId(p) === 'h-drag' && !(await handsTick(p)), 'h-drag completed after the person was deleted');
  await p.click('#tourNext'); await handsAt(p, 'h-rightclick');
  await p.click('#tourEnd'); await settle(p, 200);
  noErrors(p);
});

check('hands-on tour: starting a tour while one runs leaves it alone', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await handsStart(p);
  await handsSkipTo(p, 'h-gear');
  await p.evaluate(() => window.__shotref.setHandsTour(true)); /* so the gear menu has the item */
  await gearCmd(p, 'tour-hands'); await settle(p, 300);
  ok(await handsId(p) === 'h-gear' && await p.evaluate(() => window.__shotref.practicing()), 'the running tour was disturbed');
  ok(await p.evaluate(() => /Finish what you/.test(document.querySelector('#toast').textContent)), 'no toast said why');
  await p.evaluate(() => window.__shotref.startTour('basic')); await settle(p, 200);
  ok(await handsId(p) === 'h-gear' && await p.evaluate(() => window.__shotref.practicing()), 'a quick tour replaced the hands-on tour');
  await p.click('#tourEnd'); await settle(p, 200);
  ok(await p.evaluate(() => !window.__shotref.practicing() && !document.querySelector('#tour')), 'not clean after End tour');
  noErrors(p);
});

check('tour engine: a list target with some members hidden frames the visible ones', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => window.__shotref.tour.run([{ id: 'a', target: ['#bFile', '#nothingHere'], title: 'T', text: 't' }], { interactive: true }));
  await settle(p, 500);
  const g = await p.evaluate(() => { const a = document.querySelector('#bFile').getBoundingClientRect(), c = document.querySelector('.tour-corners').style; return { l: a.left - 6, cl: parseFloat(c.left) }; });
  ok(Math.abs(g.l - g.cl) < 2, 'the corners do not frame the visible member: ' + JSON.stringify(g));
  await p.evaluate(() => window.__shotref.tour.end());
  noErrors(p);
});

check('hands-on tour: Skip this step moves on without the action', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await handsStart(p);
  await handsAt(p, 'h-welcome');
  const seen = [];
  for (let n = 0; n < 16; n++) {
    const id = await handsId(p); if (!id) break;
    seen.push(id); await settle(p, 120);
    const lab = await p.evaluate(() => document.querySelector('#tourNext').textContent);
    if (['h-build', 'h-place', 'h-drag', 'h-rightclick', 'h-scenetab', 'h-top', 'h-camera', 'h-focus', 'h-play', 'h-export'].includes(id)) ok(lab === 'Skip this step', id + ': main button reads ' + lab);
    if (id === 'h-drag') ok(await p.evaluate(() => window.__shotref.state.objects.filter(o => o.type === 'person').length) >= 1, 'h-drag has no person to move after skipping h-place');
    if (id === 'h-focus') { ok(await p.evaluate(() => window.__shotref.view) === 'camera', 'h-focus: not in Camera view'); ok(await p.evaluate(() => !!window.__shotref.selected && window.__shotref.selected !== 'camera'), 'h-focus: the person is not selected'); }
    ok(!(await handsTick(p)), id + ': skipping showed the tick');
    await p.click('#tourNext'); await settle(p, 100);
  }
  ok(seen.join() === HANDS_IDS.join(), 'stops were ' + seen.join());
  ok(await noTour(p) && !(await p.evaluate(() => window.__shotref.practicing())), 'the tour or practice is still on');
  noErrors(p);
});

check('hands-on tour: Esc while placing cancels placing, not the tour', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await handsStart(p);
  await handsSkipTo(p, 'h-place');
  await p.click('#addArea .tile[data-body=man]'); await settle(p, 150);
  ok(await p.evaluate(() => !!window.__shotref.placing), 'clicking Person did not start placing');
  await p.keyboard.press('Escape'); await settle(p, 200);
  ok(await p.evaluate(() => window.__shotref.placing === null && window.__shotref.tour.active()), 'Esc did not cancel placing and keep the tour');
  ok(await p.evaluate(() => window.__shotref.state.objects.length) === 0, 'the cancelled person is still in the scene');
  await p.keyboard.press('Escape'); await settle(p, 250);
  ok(await p.evaluate(() => !window.__shotref.tour.active() && !window.__shotref.practicing()), 'a second Esc did not end the tour');
  noErrors(p);
});

check('hands-on tour: right-click menu shows above the dim', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await handsStart(p);
  await handsSkipTo(p, 'h-rightclick');
  const [x, y] = await personPt(p);
  await p.mouse.click(x, y, { button: 'right' }); await settle(p, 150);
  const g = await p.evaluate(([x, y]) => { const m = document.querySelector('#ctxMenu'), e = document.elementFromPoint(x + 8, y + 8); return { z: Number(getComputedStyle(m).zIndex), shown: m.style.display === 'block', top: !!e && !!e.closest('#ctxMenu'), tickShown: !document.querySelector('.tour-done').hidden }; }, [x, y]);
  ok(g.shown && g.z > 50, 'the menu is not open above the tour layer: ' + JSON.stringify(g));
  ok(g.top, 'the menu is covered at its click point');
  ok(g.tickShown, 'opening the menu did not finish the stop');
  await p.keyboard.press('Escape'); await settle(p, 150);
  ok(await p.evaluate(() => window.__shotref.tour.active() && document.querySelector('#ctxMenu').style.display !== 'block'), 'Esc closed the tour instead of just the menu');
  await p.click('#tourEnd'); await settle(p, 200);
  noErrors(p);
});

check('hands-on tour: pressing T on the camera-bar stop brings the Camera view back', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await handsStart(p);
  await handsSkipTo(p, 'h-cambar');
  ok(await p.evaluate(() => window.__shotref.view) === 'camera', 'the camera bar stop is not in Camera view');
  await p.keyboard.press('t');
  await p.waitForFunction(() => window.__shotref.view === 'camera', null, { timeout: 1000 }).catch(() => { throw new Error('the Camera view did not come back after T'); });
  ok(await handsId(p) === 'h-cambar', 'the stop changed');
  ok(await p.evaluate(() => { const b = document.querySelector('#camBar').getBoundingClientRect(); return b.width > 0; }), 'the camera bar is not visible');
  await p.click('#tourEnd'); await settle(p, 200);
  noErrors(p);
});

check('hands-on tour: the practice stage path checks, through the real tour', async ({ open, fixtures }) => {
  for (const how of ['finish', 'end', 'esc']) {
    const p = await open(); await settle(p, 300);
    await practiceReal(p, fixtures);
    const before = await practiceSnap(p);
    await handsStart(p);
    await handsSkipTo(p, 'h-focus'); /* skipping adds a person and frames the shot: real practice edits */
    ok(await p.evaluate(() => window.__shotref.state.objects.length) >= 1, how + ': no practice edit was made');
    if (how === 'finish') { for (let n = 0; n < 8 && await handsId(p); n++) { await p.click('#tourNext'); await settle(p, 80); } }
    else if (how === 'end') await p.click('#tourEnd');
    else await p.keyboard.press('Escape');
    await settle(p, 300);
    ok(await noTour(p), how + ': the tour is still on screen');
    ok(!(await p.evaluate(() => window.__shotref.practicing())), how + ': still practising');
    practiceSame(before, await practiceSnap(p), how);
    noErrors(p, how);
    await p.close();
  }
}, { timeout: 120000 });

check('hands-on tour: refused while placing, and a first run still gets its picker', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.click('#addArea .tile[data-body=man]'); await settle(p, 150);
  const r = await p.evaluate(() => { const S = window.__shotref; const h = S.startTour('hands', { firstRun: true }); const t = document.querySelector('#toast'); return { h, practicing: S.practicing(), tour: !!document.querySelector('#tour'), shown: t.classList.contains('show'), picker: !document.querySelector('#mStart').classList.contains('hidden') }; });
  ok(r.h === null && !r.practicing && !r.tour, 'the tour started while placing: ' + JSON.stringify(r));
  ok(r.shown, 'no toast said why');
  ok(r.picker, 'the first-run picker did not open');
  noErrors(p);
});

check('tour engine: keep() re-runs before, and an array target frames the union', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.evaluate(() => {
    window.__n = 0;
    window.__shotref.tour.run([{ id: 'a', target: ['#bFile', '#bMenu'], title: 'T', text: 't', before: () => { window.__n++; }, keep: () => window.__n > 1 }], { interactive: true });
  });
  await settle(p, 500);
  const g = await p.evaluate(() => { const a = document.querySelector('#bFile').getBoundingClientRect(), b = document.querySelector('#bMenu').getBoundingClientRect(), c = document.querySelector('.tour-corners').style; return { l: Math.min(a.left, b.left), r: Math.max(a.right, b.right), cl: parseFloat(c.left), cw: parseFloat(c.width), n: window.__n }; });
  ok(Math.abs(g.cl - (g.l - 6)) < 2 && Math.abs(g.cl + g.cw - (g.r + 6)) < 2, 'the corners do not frame both targets: ' + JSON.stringify(g));
  ok(g.n >= 2, 'before() was not re-run when keep() said no: ' + g.n);
  await settle(p, 300);
  ok(await p.evaluate(() => window.__n) === g.n, 'before() keeps running although keep() is true');
  await p.evaluate(() => window.__shotref.tour.end());
  noErrors(p);
});

check('first run: Try it hands-on runs the practice tour, then the starter picker', async ({ freshContext }) => {
  const fc = await freshContext({ firstLaunch: true });
  const p = await fc.open();
  await waitOpen(p, 'mTour');
  await p.evaluate(() => window.__shotref.setHandsTour(true)); /* switched off by default for now */
  await p.click('#tourHands');
  ok(!(await isOpen(p, 'mTour')), 'the question stayed open');
  ok(await p.evaluate(() => window.__shotref.tour.active() && window.__shotref.practicing()), 'the hands-on tour did not start on the practice stage');
  ok(!(await isOpen(p, 'mStart')), 'the starter picker opened during the tour');
  await p.click('#tourEnd');
  await waitOpen(p, 'mStart', 1500);
  ok(!(await p.evaluate(() => window.__shotref.practicing())), 'still practising when the picker opened');
  ok(await p.evaluate(() => window.__shotref.getPref('tourHandsDone', false)) === true, 'tourHandsDone was not remembered');
  noPageErrors(p);
});

/* ---------------- final review: dialogs over a tour, boot asset load vs practice, non-file drops ---------------- */
const aboveTour = (p, sel) => p.evaluate(s => { const b = document.querySelector(s).getBoundingClientRect(), e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!e && !!e.closest(s.split(' ')[0]); }, sel);
const tourShown = p => p.evaluate(() => { const t = document.querySelector('#tour'); return !!t && getComputedStyle(t).visibility !== 'hidden' && document.querySelector('.tour-bubble').offsetWidth > 0; });

check('tours: a dialog opened during the hands-on tour is clickable, Esc closes only it, and the tour carries on', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await handsStart(p); await handsSkipTo(p, 'h-drag');
  await p.keyboard.press('?'); await settle(p, 200);
  ok(await isOpen(p, 'mHelp'), '? did not open Quick start');
  ok(!(await tourShown(p)), 'the tour is still drawn over the dialog');
  ok(await aboveTour(p, '#mHelp .x'), 'the dialog close button is covered');
  await p.click('#mHelp .x'); await settle(p, 300);
  ok(!(await isOpen(p, 'mHelp')), 'clicking x did not close the dialog');
  ok(await p.evaluate(() => window.__shotref.tour.active() && window.__shotref.practicing()), 'the tour or practice ended with the dialog');
  ok(await handsId(p) === 'h-drag' && await tourShown(p), 'the tour did not come back on the same stop');
  await p.keyboard.press('?'); await settle(p, 200);
  ok(await isOpen(p, 'mHelp'), '? did not open Quick start the second time');
  await p.keyboard.press('Escape'); await settle(p, 300);
  ok(!(await isOpen(p, 'mHelp')), 'Esc did not close the dialog');
  ok(await p.evaluate(() => window.__shotref.tour.active() && window.__shotref.practicing()) && await handsId(p) === 'h-drag' && await tourShown(p), 'Esc ended the tour as well');
  await p.click('#tourEnd'); await settle(p, 200);
  noErrors(p);
});

check('tours: a dialog opened during the basic tour is clickable, Esc closes only it; a file from Windows ends the tour and loads', async ({ freshContext }) => {
  const p = await desktopPage(freshContext); await settle(p, 300);
  await p.evaluate(() => window.__shotref.startTour('basic')); await settle(p, 300);
  const id0 = await handsId(p);
  await p.evaluate(() => window.__dsk.menu('help')); await settle(p, 200);
  ok(await isOpen(p, 'mHelp'), 'the native Help command did not open Quick start');
  ok(!(await tourShown(p)), 'the tour is still drawn over the dialog');
  ok(await aboveTour(p, '#mHelp .x'), 'the dialog close button is covered');
  await p.click('#mHelp .x'); await settle(p, 300);
  ok(!(await isOpen(p, 'mHelp')) && await p.evaluate(() => window.__shotref.tour.active()) && await handsId(p) === id0 && await tourShown(p), 'the tour did not come back on the same stop');
  await p.evaluate(() => window.__dsk.menu('help')); await settle(p, 200);
  await p.keyboard.press('Escape'); await settle(p, 300);
  ok(!(await isOpen(p, 'mHelp')), 'Esc did not close the dialog');
  ok(await p.evaluate(() => window.__shotref.tour.active()) && await handsId(p) === id0, 'Esc ended the basic tour as well');
  const st = await stateOf(p); st.objects = st.objects.slice(0, 2);
  const text = JSON.stringify({ app: 'ShotRef', version: 2, state: st, assets: {} });
  await p.evaluate(t => window.__dsk.openCb({ text: t, name: 'late.shotref', path: 'E:/late.shotref' }), text);
  await p.waitForFunction(() => window.__shotref.state.objects.length === 2, null, { timeout: 4000 }).catch(() => { throw new Error('the opened file did not load'); });
  await settle(p, 300);
  ok(await noTour(p) && !(await p.evaluate(() => window.__shotref.tour.active())), 'the basic tour kept running over the opened file');
  ok(await p.evaluate(() => window.__shotref.getPref('tourBasicDone', false)) === true, 'tourBasicDone was not set when the tour ended externally');
  noPageErrors(p);
});

const idbKeys = p => p.evaluate(() => new Promise(res => { const r = indexedDB.open('shotref'); r.onsuccess = () => { const q = r.result.transaction('assets').objectStore('assets').getAllKeys(); q.onsuccess = () => { r.result.close(); res(q.result.map(String)); }; }; r.onerror = () => res(null); }));
/* a session with a stored photo, reloaded with the IndexedDB open held back for 1.1 s (idbOpen gives up at 1.5 s) */
const slowRestore = async (freshContext, fixtures) => {
  const fc = await freshContext();
  await fc.ctx.addInitScript(`(() => { let d = 0; try { d = Number(sessionStorage.getItem('idbDelay') || 0); } catch (e) { }
    if (!d) return; const o = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...a) { const rq = o.apply(this, a); let cb = null;
      Object.defineProperty(rq, 'onsuccess', { configurable: true, set(f) { cb = f; }, get() { return cb; } });
      rq.addEventListener('success', ev => setTimeout(() => cb && cb.call(rq, ev), d)); return rq; }; })();`);
  const p = await fc.open(); await settle(p, 300);
  await p.setInputFiles('#fPlate', path.join(fixtures, 'location.jpg'));
  await p.waitForFunction(() => window.__shotref.state.plate && window.__shotref.state.plate.asset);
  const id = await p.evaluate(() => window.__shotref.state.plate.asset);
  await settle(p, 1500);
  ok((await idbKeys(p)).includes(id), 'set-up: the photo is not stored');
  await p.evaluate(() => sessionStorage.setItem('idbDelay', '1100'));
  await p.reload(); await p.waitForFunction(() => window.__shotref && window.__shotref.state);
  return { p, id };
};

check('practice: the hands-on tour will not start while boot is still loading the stored photos', async ({ freshContext, fixtures }) => {
  const { p, id } = await slowRestore(freshContext, fixtures);
  ok(await p.evaluate(() => !window.__shotref.assets[window.__shotref.state.plate.asset]), 'set-up: the photo was already loaded');
  const r = await p.evaluate(() => { const h = window.__shotref.startTour('hands'); return { h: h === null, practicing: window.__shotref.practicing(), toast: document.querySelector('#toast').textContent }; });
  ok(r.h && !r.practicing, 'the hands-on tour started before the stored photos were loaded');
  ok(r.toast.length > 3, 'no toast said why');
  await p.waitForFunction(i => window.__shotref.assets[i], id, { timeout: 8000 }).catch(() => { throw new Error('the photo never loaded'); });
  await settle(p, 300);
  ok(await p.evaluate(() => !!window.__shotref.startTour('hands')), 'the hands-on tour did not start once boot had loaded');
  await p.click('#tourEnd'); await settle(p, 300);
  noErrors(p);
});

check('practice: photos that finish loading mid-practice belong to the real scene and stay stored', async ({ freshContext, fixtures }) => {
  const { p, id } = await slowRestore(freshContext, fixtures);
  ok(await p.evaluate(() => window.__shotref.practice.enterEarly()), 'practice did not start (test hook)');
  await p.evaluate(() => window.__shotref.tour.run([{ id: 'a', target: null, title: 'T', text: 't' }], { interactive: true, onEnd: () => window.__shotref.practice.leave() }));
  await settle(p, 2200); /* the load lands while the stage is up */
  ok(await p.evaluate(i => !window.__shotref.assets[i], id), 'the stored photo went into the practice stage');
  await p.click('#tourEnd'); await settle(p, 1500);
  ok(await p.evaluate(i => !!window.__shotref.assets[i] && window.__shotref.state.plate.asset === i, id), 'the real scene lost its photo');
  ok((await idbKeys(p)).includes(id), 'the photo was deleted from IndexedDB');
  noErrors(p);
});

check('practice: dropping text or a link on the picture does not end the tour', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await handsStart(p);
  await p.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'hello'); document.querySelector('#vp').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); });
  await settle(p, 400);
  ok(await p.evaluate(() => window.__shotref.tour.active() && window.__shotref.practicing()), 'a text drop ended the tour');
  await p.click('#tourEnd'); await settle(p, 200);
  noErrors(p);
});

main().catch(e => { console.error(e && e.stack || e); process.exit(2); });

check('the hands-on tour is switched off: the quick tour ends with one-tour wording', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  ok(await p.evaluate(() => window.__shotref.handsTourOn() === false), 'the hands-on tour is switched on by default');
  await p.evaluate(() => window.__shotref.startTour('basic'));
  let id = '';
  for (let i = 0; i < 12 && id !== 'b-bye'; i++) { await p.click('#tourNext'); await settle(p, 120); id = await p.evaluate(() => (window.__shotref.tour.current() || { stop: {} }).stop.id); }
  ok(id === 'b-bye', 'never reached the last stop');
  const txt = await p.evaluate(() => document.querySelector('#tour .tour-bubble').textContent);
  ok(!/hands-on/i.test(txt) && /Help menu/.test(txt), 'last stop text: ' + txt);
  await p.click('#tourNext'); await settle(p, 200);
  noErrors(p);
});

check('About: version, where it runs, build date, privacy, copyright and licences (no desktop buttons on the web)', async ({ open }) => {
  const p = await open();
  await gearCmd(p, 'about');
  const o = await p.evaluate(() => ({
    ver: document.querySelector('#aboutVer').textContent, priv: document.querySelector('#aboutPrivacy').textContent,
    copy: document.querySelector('#aboutCopy').textContent, lic: document.querySelector('#aboutLic').hidden,
    news: document.querySelector('#aboutNews').offsetParent !== null, upd: document.querySelector('#aboutUpd').offsetParent !== null }));
  ok(/^Version \d+\.\d+\.\d+ \u00b7 (Web page|On claude\.ai) \u00b7 built \d{1,2} [A-Z][a-z]{2} \d{4}$/.test(o.ver), 'version line: ' + o.ver);
  ok(/Works offline/.test(o.priv) && /never uploads/.test(o.priv), 'privacy line: ' + o.priv);
  ok(o.copy === '\u00a9 2026 Ali Chehade Farhat', 'copyright: ' + o.copy);
  ok(o.lic && !o.news && !o.upd, 'licences should start folded and the desktop buttons hidden: ' + JSON.stringify(o));
  await p.click('#aboutLicBtn');
  const l = await p.evaluate(() => ({ shown: !document.querySelector('#aboutLic').hidden, heads: [...document.querySelectorAll('#aboutLic h3')].map(x => x.textContent),
    text: document.querySelector('#aboutLic').textContent, exp: document.querySelector('#aboutLicBtn').getAttribute('aria-expanded') }));
  ok(l.shown && l.exp === 'true', 'Licences did not open');
  ok(l.heads.length === 2 && /^three \d/.test(l.heads[0]) && /^mp4-muxer \d/.test(l.heads[1]), 'licence list: ' + l.heads.join(', '));
  ok(/Permission is hereby granted/.test(l.text) && /three\.js authors/.test(l.text), 'licence text missing');
  await p.keyboard.press('Escape');
  noErrors(p);
});

/* ---- drag a tile from the Add panel onto the view ---- */
const tileBox = async (p, sel) => { const b = await p.locator(sel).first().boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
/* press on a tile, move in steps to (x, y), then let go (or not, with up = false) */
const dragTile = async (p, sel, x, y, up = true) => {
  const t = await tileBox(p, sel);
  await p.mouse.move(t.x, t.y); await p.mouse.down();
  for (let i = 1; i <= 12; i++) { await p.mouse.move(t.x + (x - t.x) * i / 12, t.y + (y - t.y) * i / 12); await p.waitForTimeout(16); }
  if (up) { await p.mouse.up(); await settle(p, 400); }
};
const dropNear = async (p, x, y) => p.evaluate(([x, y]) => { const S = window.__shotref, o = S.state.objects[S.state.objects.length - 1], w = S.evalObj(o, S.T).p, q = S.project(w[0], 0, w[2]); return Math.hypot(q[0] - x, q[1] - y); }, [x, y]);
check('drag and drop: a tile dragged onto the view lands under the pointer, selected, as one undo step', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.click('#leftTabs [data-lt="add"]');
  const cb = await canvasBox(p), n0 = await nObj(p), h0 = await p.evaluate(() => window.__shotref.history.length);
  const x = cb.x + cb.w * 0.35, y = cb.y + cb.h * 0.7;
  await dragTile(p, '#addArea .tile[data-body="man"]', x, y, false);
  ok(await p.evaluate(() => !!window.__shotref.placing), 'the item does not follow the pointer during the drag');
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('#modeBar')).display !== 'none'), 'the bar is not shown during the drag');
  await p.mouse.up(); await settle(p, 400);
  const s = await stateOf(p), o = s.objects[s.objects.length - 1];
  ok(s.objects.length === n0 + 1 && o.type === 'person', 'not one person added: ' + (s.objects.length - n0));
  ok(await p.evaluate(id => window.__shotref.selected === id && window.__shotref.placing === null, o.id), 'not selected, or still placing');
  ok(await p.evaluate(() => window.__shotref.history.length) === h0 + 1, 'not one undo step');
  const d = await dropNear(p, x, y); ok(d < 30, 'landed ' + Math.round(d) + ' px from the drop point');
  ok(await nObj(p) === n0 + 1, 'the release click added a second item');
  await undoN(p, 1); ok(await nObj(p) === n0, 'undo did not remove it');
  noErrors(p);
});
check('drag and drop: Esc mid-drag and a release outside the view both cancel with nothing left behind', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.click('#leftTabs [data-lt="add"]');
  const cb = await canvasBox(p), n0 = await nObj(p), h0 = await p.evaluate(() => window.__shotref.history.length);
  await dragTile(p, '#addArea .tile:text-is("Box")', cb.x + cb.w * 0.5, cb.y + cb.h * 0.6, false);
  await p.keyboard.press('Escape'); await p.mouse.up(); await settle(p, 300);
  ok(await nObj(p) === n0 && await p.evaluate(() => window.__shotref.placing === null), 'Esc left an item or placing on');
  /* over the view, then back to the panel and let go there */
  const t = await tileBox(p, '#addArea .tile:text-is("Box")');
  await dragTile(p, '#addArea .tile:text-is("Box")', cb.x + cb.w * 0.5, cb.y + cb.h * 0.6, false);
  for (let i = 1; i <= 6; i++) { await p.mouse.move(cb.x + cb.w * 0.5 + (t.x - cb.x - cb.w * 0.5) * i / 6, cb.y + cb.h * 0.6 + (t.y - cb.y - cb.h * 0.6) * i / 6); await p.waitForTimeout(16); }
  await p.mouse.up(); await settle(p, 300);
  ok(await nObj(p) === n0 && await p.evaluate(() => window.__shotref.placing === null), 'a release outside the view left an item or placing on');
  ok(await p.evaluate(() => window.__shotref.history.length) === h0, 'cancelling made an undo step');
  ok(await p.evaluate(() => !document.querySelector('#dragChip') || getComputedStyle(document.querySelector('#dragChip')).display === 'none'), 'the drag chip stayed up');
  /* a plain click still starts click-to-place */
  await p.click('#addArea .tile:text-is("Box")'); await settle(p, 150);
  ok(await p.evaluate(() => !!window.__shotref.placing), 'a click no longer starts placing');
  await p.mouse.click(cb.x + cb.w * 0.4, cb.y + cb.h * 0.7); await settle(p, 300);
  ok(await nObj(p) === n0 + 1, 'click to place did not place');
  noErrors(p);
});
check('drag and drop: works in the top view, the camera view and both halves of split view', async ({ open }) => {
  const p = await open(); await settle(p, 300);
  await p.click('#leftTabs [data-lt="add"]');
  await p.evaluate(() => window.__shotref.setView('top')); await settle(p, 300);
  let cb = await canvasBox(p), n0 = await nObj(p);
  let x = cb.x + cb.w * 0.4, y = cb.y + cb.h * 0.4;
  await dragTile(p, '#addArea .tile:text-is("Chair")', x, y);
  ok(await nObj(p) === n0 + 1, 'top view: nothing added');
  let d = await dropNear(p, x, y); ok(d < 30, 'top view: landed ' + Math.round(d) + ' px away');
  await p.evaluate(() => window.__shotref.setView('camera')); await settle(p, 300);
  const fr = await p.evaluate(() => { const r = document.querySelector('#camFrame').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  x = fr.x + fr.w * 0.5; y = fr.y + fr.h * 0.85;
  await dragTile(p, '#addArea .tile:text-is("Box")', x, y);
  ok(await nObj(p) === n0 + 2, 'camera view: nothing added');
  d = await dropNear(p, x, y); ok(d < 30, 'camera view: landed ' + Math.round(d) + ' px away');
  await p.evaluate(() => window.__shotref.setView('editor')); await settle(p, 200); await splitOn(p);
  cb = await canvasBox(p);
  x = cb.x + cb.w * 0.25; y = cb.y + cb.h * 0.7;
  await dragTile(p, '#addArea .tile[data-body="woman"]', x, y);
  ok(await nObj(p) === n0 + 3, 'split, left half: nothing added');
  d = await dropNear(p, x, y); ok(d < 30, 'split, left half: landed ' + Math.round(d) + ' px away');
  const f2 = await p.evaluate(() => { const r = document.querySelector('#camFrame').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  x = f2.x + f2.w * 0.5; y = f2.y + f2.h * 0.85;
  await dragTile(p, '#addArea .tile:text-is("Box")', x, y);
  ok(await nObj(p) === n0 + 4, 'split, shot half: nothing added');
  d = await dropNear(p, x, y); ok(d < 30, 'split, shot half: landed ' + Math.round(d) + ' px away');
  noErrors(p);
});
check('sky: old file opens clear', async ({ open }) => {
  const p = await open();
  const c = await p.evaluate(() => { const st = JSON.parse(JSON.stringify(__shotref.state)); delete st.settings.clouds; return __shotref.normalize({ app: 'ShotRef', version: 2, state: st }).state.settings.clouds; });
  if (c.cover !== 0) throw new Error('old file should open with cover 0, got ' + c.cover);
});
check('sky: new scene has few clouds', async ({ open }) => {
  const p = await open();
  const c = await p.evaluate(() => __shotref.state.settings.clouds);
  if (c.cover !== 0.2 || c.look !== 'fluffy' || c.drift !== 'slow') throw new Error(JSON.stringify(c));
});
check('sky: bad clouds are repaired', async ({ open }) => {
  const p = await open();
  const c = await p.evaluate(() => { const st = JSON.parse(JSON.stringify(__shotref.state)); st.settings.clouds = { cover: 7, look: 'x', drift: null, dir: -30, seed: 2.5 }; return __shotref.normalize({ app: 'ShotRef', version: 2, state: st }).state.settings.clouds; });
  if (c.cover !== 1 || c.look !== 'fluffy' || c.drift !== 'slow' || c.dir !== 330 || !Number.isInteger(c.seed)) throw new Error(JSON.stringify(c));
});
check('sky: undo names and restores clouds', async ({ open }) => {
  const p = await open();
  const r0 = await p.evaluate(() => { const a = JSON.stringify(__shotref.state), before = __shotref.state.settings.clouds.cover, lit0 = __shotref.lights(), h = __shotref.history.length; __shotref.setClouds({ cover: 0.68 }); return { name: __shotref.describeChange(a, JSON.stringify(__shotref.state)), before, lit0, litMid: __shotref.lights(), steps: __shotref.history.length - h }; });
  await p.keyboard.press('Control+z');
  const after = await p.evaluate(() => ({ cover: __shotref.state.settings.clouds.cover, lit: __shotref.lights() }));
  if (r0.name !== 'clouds' || r0.steps !== 1 || after.cover !== r0.before) throw new Error(JSON.stringify({ ...r0, after }));
  if (!(r0.litMid.sun < r0.lit0.sun)) throw new Error('setup: cover did not soften the sun: ' + JSON.stringify(r0));
  if (JSON.stringify(after.lit) !== JSON.stringify(r0.lit0)) throw new Error('undo did not restore the live light: ' + JSON.stringify({ before: r0.lit0, after: after.lit }));
});
check('sky: same frame, same clouds', async ({ open }) => {
  const p = await open();
  const same = await p.evaluate(() => { __shotref.setClouds({ cover: 0.68, drift: 'fast' }); const a = __shotref.shotPixels(2.0); __shotref.setT(0); __shotref.setT(4); const b = __shotref.shotPixels(2.0); return a.every((v, i) => v === b[i]); });
  if (!same) throw new Error('two renders of t=2 differ');
});
check('sky: clouds drift over time', async ({ open }) => {
  const p = await open();
  const diff = await p.evaluate(() => { __shotref.setClouds({ cover: 0.68, drift: 'fast' }); const a = __shotref.shotPixels(0), b = __shotref.shotPixels(4); let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 8) n++; return n; });
  if (diff < 50) throw new Error('clouds did not move, changed pixels: ' + diff);
});
check('sky: still clouds do not move', async ({ open }) => {
  const p = await open();
  const same = await p.evaluate(() => { __shotref.setClouds({ cover: 0.68, drift: 'still' }); const a = __shotref.shotPixels(0), b = __shotref.shotPixels(4); return a.every((v, i) => v === b[i]); });
  if (!same) throw new Error('still clouds changed between t=0 and t=4');
});
check('sky: hidden in depth, clay and over the photo', async ({ open }) => {
  const p = await open();
  /* the pixels that are plain background (equal to the corner) must not change with cover; lit surfaces do, by design (light coupling) */
  const r = await p.evaluate(() => { const s = __shotref.state.settings, out = {}; for (const st of ['depth', 'clay', 'normal']) { s.style = st; __shotref.setClouds({ cover: 0 }); const a = __shotref.shotPixels(1); __shotref.setClouds({ cover: 1 }); const b = __shotref.shotPixels(1); let bg = 0, bad = 0; for (let i = 0; i < a.length; i += 4) if (a[i] === a[0] && a[i + 1] === a[1] && a[i + 2] === a[2]) { bg++; if (b[i] !== a[i] || b[i + 1] !== a[i + 1] || b[i + 2] !== a[i + 2]) bad++; } out[st] = bg > 500 && bad === 0; } s.style = 'shaded'; return out; });
  if (!r.depth || !r.clay || !r.normal) throw new Error('cover changed a style background: ' + JSON.stringify(r));
});
check('sky: dof render has no NaN or black sky', async ({ open }) => {
  const p = await open();
  const dark = await p.evaluate(() => { __shotref.setClouds({ cover: 0.42 }); __shotref.state.camera.dof = { on: true, fstop: 1.4, auto: true, strength: 3 }; const d = __shotref.shotPixels(1); let n = 0; const w = 240; for (let x = 0; x < w; x++) { const i = x * 4; if (d[i] + d[i + 1] + d[i + 2] < 30) n++; } return n; });
  if (dark > 24) throw new Error('top row of the DOF render is black in ' + dark + ' pixels');
});
check('sky: top view hides the dome', async ({ open }) => {
  const p = await open();
  const v = await p.evaluate(async () => { __shotref.setView('top'); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return __shotref.sky().visible; });
  if (v) throw new Error('dome visible in the top view');
});
check('sky: hidden behind the location photo', async ({ open, fixtures }) => {
  const p = await open();
  await p.setInputFiles('#fPlate', path.join(fixtures, 'location.jpg'));
  await p.waitForFunction(() => window.__shotref.state.plate && window.__shotref.state.plate.asset);
  await p.waitForFunction(() => { const i = document.querySelector('.plateImg'); return i && i.getAttribute('src'); });
  /* same cover, so the same light: only the cloud look (and seed) differ, and the frame must not notice */
  const same = await p.evaluate(() => { __shotref.setClouds({ cover: 1, look: 'fluffy', seed: 1 }); const a = Array.from(__shotref.shotPixels(1)); __shotref.setClouds({ look: 'wispy', seed: 2 }); const b = Array.from(__shotref.shotPixels(1)); return a.every((v, i) => v === b[i]); });
  if (!same) throw new Error('clouds showed over the location photo');
});
check('sky: clear gives back the stored light', async ({ open }) => {
  const p = await open();
  const r = await p.evaluate(() => { const s = __shotref.state.settings; __shotref.setClouds({ cover: 1 }); __shotref.setClouds({ cover: 0 }); const L = __shotref.lights(); return { sun: L.sun, amb: L.amb, sSun: s.sunInt, sAmb: s.ambInt }; });
  if (Math.abs(r.sun - r.sSun) > 1e-6 || Math.abs(r.amb - r.sAmb) > 1e-6) throw new Error(JSON.stringify(r));
});
check('sky: overcast preset matches the old overcast light', async ({ open }) => {
  const p = await open();
  const L = await p.evaluate(() => { __shotref.pickEnv('overcast'); return __shotref.lights(); });
  if (Math.abs(L.sun - 0.55) > 0.01 || Math.abs(L.amb - 1.7) > 0.01) throw new Error(JSON.stringify(L));
});
check('sky: cover softens without saving', async ({ open }) => {
  const p = await open();
  const r = await p.evaluate(() => { const s = __shotref.state.settings, before = s.sunInt; __shotref.setClouds({ cover: 0.68 }); return { before, after: s.sunInt, live: __shotref.lights().sun }; });
  if (r.before !== r.after || !(r.live < r.before)) throw new Error(JSON.stringify(r));
});
check('sky: a preset sets cover and look but keeps drift, direction and seed', async ({ open }) => {
  const p = await open();
  const r = await p.evaluate(() => { __shotref.setClouds({ drift: 'fast', dir: 200, seed: 77, soft: 0.9 }); __shotref.pickEnv('overcast'); return __shotref.state.settings.clouds; });
  if (r.cover !== 1 || r.look !== 'flat' || r.drift !== 'fast' || r.dir !== 200 || r.seed !== 77 || r.soft !== 0.9) throw new Error(JSON.stringify(r));
});
check('sky: panel shows cloud chips and hides extras on clear', async ({ open }) => {
  const p = await open();
  const sky = p.locator('#props .sec').filter({ has: p.locator('h3', { hasText: /^Sky[?]?$/ }) });
  await sky.getByRole('button', { name: 'Clear', exact: true }).click();
  if (await sky.getByText('Shuffle clouds').count()) throw new Error('shuffle shown with clear sky');
  await sky.getByRole('button', { name: 'Scattered', exact: true }).click();
  const c = await p.evaluate(() => __shotref.state.settings.clouds.cover);
  if (c !== 0.42) throw new Error('Scattered chip set cover ' + c);
  if (!(await sky.getByText('Shuffle clouds').count())) throw new Error('shuffle missing');
});
check('sky: shuffle changes the seed and is undoable', async ({ open }) => {
  const p = await open();
  const before = await p.evaluate(() => __shotref.state.settings.clouds.seed);
  await p.locator('#props').getByText('Shuffle clouds').click();
  const shuffled = await p.evaluate(() => __shotref.state.settings.clouds.seed);
  await p.keyboard.press('Control+z');
  const undone = await p.evaluate(() => __shotref.state.settings.clouds.seed);
  if (shuffled === before || undone !== before) throw new Error(JSON.stringify({ before, shuffled, undone }));
});
check('sky: simple mode has no cloud sliders', async ({ open }) => {
  const p = await open();
  const settle = () => p.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await p.evaluate(() => { __shotref.setSimple(false); __shotref.setClouds({ cover: 0.5, drift: 'slow' }); });
  await settle();
  await p.evaluate(() => __shotref.setSimple(true));
  await settle();
  if (!(await p.locator('#props').getByText('Shuffle clouds').count())) throw new Error('setup: the Sky panel is not showing the cloud rows');
  for (const t of ['Wind', 'Amount', 'Edges']) if (await p.locator('#props').getByText(t, { exact: true }).count()) throw new Error(t + ' slider in simple mode');
  await p.evaluate(() => __shotref.setSimple(false));
  await settle();
  if (!(await p.locator('#props').getByText('Amount', { exact: true }).count())) throw new Error('Advanced mode should show the Amount slider');
});
check('sky: the note names the sky and the shadows, and look and drift chips set the clouds', async ({ open }) => {
  const p = await open();
  const sky = p.locator('#props .sec').filter({ has: p.locator('h3', { hasText: /^Sky[?]?$/ }) });
  await sky.getByRole('button', { name: 'Clear', exact: true }).click();
  const clear = await sky.innerText();
  if (!/Clear sky/.test(clear) || /Look|Drift/.test(clear)) throw new Error('clear sky panel: ' + clear);
  await sky.getByRole('button', { name: 'Overcast', exact: true }).click();
  if (!/Overcast/.test(await sky.innerText())) throw new Error('overcast note missing');
  await sky.getByRole('button', { name: 'Wispy', exact: true }).click();
  await sky.getByRole('button', { name: 'Breezy', exact: true }).click();
  const c = await p.evaluate(() => __shotref.state.settings.clouds);
  if (c.look !== 'wispy' || c.drift !== 'breezy' || c.cover !== 1) throw new Error(JSON.stringify(c));
  const on = await sky.locator('button.on').allInnerTexts();
  if (!['Overcast', 'Wispy', 'Breezy'].every(t => on.some(o => o.trim() === t))) throw new Error('active chips: ' + on);
});
check('sky: advanced adds amount, edges and direction, and one sky section holds the colours', async ({ open }) => {
  const p = await open();
  await p.evaluate(() => { __shotref.setSimple(false); __shotref.setClouds({ cover: 0.5, drift: 'slow' }); });
  await p.waitForTimeout(300);
  const sky = p.locator('#props .sec').filter({ has: p.locator('h3', { hasText: /^Sky[?]?$/ }) });
  for (const t of ['Amount', 'Edges', 'Wind', 'Fog / haze', 'Show ground'])
    if (!(await sky.getByText(t).count())) throw new Error('missing in Advanced: ' + t);
  if (await p.locator('#props h3', { hasText: /^Sky & ground$/ }).count()) throw new Error('old Sky & ground section still there');
  /* the chip for 50% is the nearest one, Scattered */
  const on = await sky.locator('button.on').allInnerTexts();
  if (!on.some(o => o.trim() === 'Scattered')) throw new Error('nearest chip not active: ' + on);
  await p.evaluate(() => __shotref.setClouds({ drift: 'still' }));
  await p.waitForTimeout(300);
  if (await sky.getByText('Wind', { exact: true }).count()) throw new Error('wind shown with Still');
});
check('sky: the Sun panel has the same Sky section', async ({ open }) => {
  const p = await open();
  await p.evaluate(() => __shotref.select('sun'));
  const sky = p.locator('#props .sec').filter({ has: p.locator('h3', { hasText: /^Sky[?]?$/ }) });
  if (!(await sky.getByRole('button', { name: 'Scattered', exact: true }).count())) throw new Error('no Sky section in the Sun panel');
});
check('sky: clear keeps the old prompt', async ({ open }) => {
  const p = await open();
  const t = await p.evaluate(() => { __shotref.setClouds({ cover: 0 }); return __shotref.promptText(); });
  if (/cloud|sky/i.test(t)) throw new Error(t);
});
check('sky: prompt names the clouds', async ({ open }) => {
  const p = await open();
  const t = await p.evaluate(() => { __shotref.setClouds({ cover: 0.42, drift: 'fast' }); return __shotref.promptText(); });
  if (!/Partly cloudy sky/.test(t) || !/clouds drifting/.test(t)) throw new Error(t);
});
check('sky: prompt wording for looks and overcast', async ({ open }) => {
  const p = await open();
  const r = await p.evaluate(() => {
    const g = (c) => { __shotref.setClouds(c); return __shotref.promptText(); };
    return { few: g({ cover: 0.2, look: 'fluffy', drift: 'slow' }), wispy: g({ cover: 0.42, look: 'wispy' }), flat: g({ cover: 0.42, look: 'flat' }),
      over: g({ cover: 1, look: 'fluffy' }), overW: g({ cover: 1, look: 'wispy' }) };
  });
  if (!/A few clouds, /.test(r.few) || /drifting/.test(r.few)) throw new Error(r.few);
  if (!/Wispy high clouds/.test(r.wispy) || !/A thin grey cloud layer/.test(r.flat)) throw new Error(r.wispy + r.flat);
  if (!/Overcast grey sky/.test(r.over) || !/Overcast grey sky/.test(r.overW) || /Wispy/.test(r.overW)) throw new Error(r.over + r.overW);
  const n = await p.evaluate(() => { __shotref.setClouds({ cover: 1 }); __shotref.state.settings.env = 'overcast'; __shotref.setClouds({ cover: 1 }); return __shotref.promptText(); });
  if (/Overcast, soft light/.test(n) || (n.match(/overcast/gi) || []).length !== 1) throw new Error(n);
});

/* ---- sky and clouds: look fixes, rows, prompt wording, autosave ---- */
/* in the page: the average luminance of one pixel row, over the left strip only (no scenery there), and the row where the sky ends */
const SKY_ROWS = `(d, w, h) => {
  const lum = y => { let s = 0; for (let x = 0; x < 40; x++) { const i = (y * w + x) * 4; s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; } return s / 40; };
  const blue = y => { let s = 0; for (let x = 0; x < 40; x++) s += d[(y * w + x) * 4 + 2]; return s / 40; };
  let hy = 0, best = 0; for (let y = Math.round(h * 0.2); y < Math.round(h * 0.8); y++) { const j = Math.abs(lum(y + 1) - lum(y)); if (j > best) { best = j; hy = y; } }
  return { lum, blue, hy };
}`;
check('sky: night sky is dark at eye level', async ({ open }) => {
  const p = await open();
  const r = await p.evaluate(`(() => { __shotref.pickEnv('night'); __shotref.setClouds({ cover: 0 }); const w = 240, h = 135, d = __shotref.shotPixels(0, w), R = (${SKY_ROWS})(d, w, h); return { top: R.lum(0), above: R.lum(R.hy - 1), hy: R.hy }; })()`);
  if (!(r.hy > 30 && r.hy < 105)) throw new Error('setup: no horizon found in the night frame: ' + JSON.stringify(r));
  if (!(r.top < 80) || !(r.top < r.above)) throw new Error('night sky is not dark at the top of an eye-level frame: ' + JSON.stringify(r));
});
check('sky: day sky darkens upward', async ({ open }) => {
  const p = await open();
  const r = await p.evaluate(`(() => { __shotref.pickEnv('day'); __shotref.setClouds({ cover: 0 }); const w = 240, h = 135, d = __shotref.shotPixels(0, w), R = (${SKY_ROWS})(d, w, h); return { top: R.blue(0), above: R.blue(R.hy - 1), hy: R.hy }; })()`);
  if (!(r.hy > 30 && r.hy < 105)) throw new Error('setup: no horizon found in the day frame: ' + JSON.stringify(r));
  if (!(r.top < r.above)) throw new Error('top of the frame is not darker than the horizon: ' + JSON.stringify(r));
});
check('sky: clouds show low in an eye-level frame', async ({ open }) => {
  const p = await open();
  /* flat cloud over the whole sky: about 3 degrees above the horizon (12 rows up) it must already change the pixels (the old fade left that row almost clear) */
  const r = await p.evaluate(`(() => { __shotref.pickEnv('day'); __shotref.setClouds({ cover: 0 }); const w = 240, h = 135, a = __shotref.shotPixels(0, w), R0 = (${SKY_ROWS})(a, w, h);
    __shotref.setClouds({ cover: 1, look: 'flat' }); const b = __shotref.shotPixels(0, w); const y = R0.hy - 12; let diff = 0;
    for (let x = 0; x < 40; x++) { const i = (y * w + x) * 4; diff += Math.abs(a[i] - b[i]) + Math.abs(a[i + 2] - b[i + 2]); } return { diff: diff / 40, hy: R0.hy }; })()`);
  if (!(r.diff >= 12)) throw new Error('flat cloud is barely visible 12 rows above the horizon: ' + JSON.stringify(r));
});
check('sky: studio has no sun glow', async ({ open }) => {
  const p = await open();
  /* aim straight at the sun: the day sky shows the white disc (control), the studio backdrop must not */
  const r = await p.evaluate(`(() => { const S = __shotref, out = {};
    for (const env of ['day', 'studio']) { S.pickEnv(env); const st = S.state.settings, az = st.sunAz * Math.PI / 180, el = st.sunEl * Math.PI / 180, c = S.state.camera.base;
      c.tg = [c.p[0] + 10 * Math.cos(el) * Math.sin(az), c.p[1] + 10 * Math.sin(el), c.p[2] + 10 * Math.cos(el) * Math.cos(az)]; S.state.camera.keys = [];
      const d = S.shotPixels(0, 240); let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) n++; out[env] = n; }
    return out; })()`);
  if (!(r.day > 0)) throw new Error('setup: the day sky shows no sun disc when aimed at the sun: ' + JSON.stringify(r));
  if (r.studio !== 0) throw new Error('the studio backdrop shows a sun disc or halo: ' + JSON.stringify(r));
});
check('sky: 3% cloud reads Clear in the panel, rows and prompt', async ({ open }) => {
  const p = await open();
  await p.evaluate(() => { __shotref.setSimple(false); __shotref.setClouds({ cover: 0.03 }); });
  await p.waitForTimeout(300);
  const sky = p.locator('#props .sec').filter({ has: p.locator('h3', { hasText: /^Sky[?]?$/ }) });
  const t = await sky.innerText();
  if (!/Clear sky/.test(t)) throw new Error('3% is not worded as clear: ' + t);
  for (const x of ['Shuffle clouds', 'Look', 'Drift', 'Edges', 'Wind']) if (await sky.getByText(x, { exact: true }).count()) throw new Error(x + ' shown at 3%');
  if (!(await sky.locator('button.on').allInnerTexts()).some(o => o.trim() === 'Clear')) throw new Error('Clear chip is not active at 3%');
  if (/cloud|sky/i.test(await p.evaluate(() => __shotref.promptText()))) throw new Error('prompt mentions clouds at 3%');
});
check('sky: prompt keeps the light words after a sky phrase', async ({ open }) => {
  const p = await open();
  const r = await p.evaluate(() => {
    const g = (env, c) => { __shotref.pickEnv(env); __shotref.setClouds(c); return __shotref.promptText(); };
    return { night: g('night', { cover: 0.42, drift: 'slow' }), studio: g('studio', { cover: 0.42, drift: 'slow' }), breezy: g('day', { cover: 0.42, drift: 'breezy' }), fast: g('day', { cover: 0.42, drift: 'fast' }) };
  });
  if (!/Partly cloudy sky, night,/.test(r.night)) throw new Error(r.night);
  if (!/Partly cloudy sky, studio lighting,/.test(r.studio)) throw new Error(r.studio);
  if (!/Partly cloudy sky, clouds drifting,/.test(r.breezy) || !/Partly cloudy sky, clouds drifting,/.test(r.fast)) throw new Error(r.breezy + ' | ' + r.fast);
});
check('sky: clouds survive an autosave reload', async ({ open }) => {
  const p = await open();
  const want = { cover: 0.68, look: 'wispy', drift: 'fast', seed: 42 };
  await p.evaluate(w => __shotref.setClouds(w), want);
  await p.waitForTimeout(1000);
  await p.reload();
  await p.waitForFunction(() => window.__shotref && window.__shotref.state);
  const c = await p.evaluate(() => __shotref.state.settings.clouds);
  for (const k of Object.keys(want)) if (c[k] !== want[k]) throw new Error('clouds not restored: ' + JSON.stringify(c));
});
