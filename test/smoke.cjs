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
  await p.click('#exVideo');
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
  await p.click('#bExport');
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
  await p.click('#bExport');
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
  ok(h2 <= 183 && h2 > h1, 'timeline is ' + h2 + ' px tall with 9 tracks');
});

check('outliner and timeline rows work from the keyboard', async ({ open }) => {
  const p = await open();
  await p.waitForTimeout(200);
  const id = await p.evaluate(() => window.__shotref.state.objects[1].id);
  await p.click('#leftTabs [data-lt=scene]'); await p.click('#bTracks'); /* the list is on the Scene tab; tracks start closed */
  await p.waitForTimeout(200);
  const rows = await p.evaluate(() => [...document.querySelectorAll('#outliner .ol, #tlRows .lab')].every(r => r.tabIndex === 0));
  ok(rows, 'outliner rows or timeline labels are not focusable');
  await p.focus('#outliner .ol:nth-child(3)');
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
  ok(await focusPropSelect(p, 'Guides') !== null, 'setup: no Guides dropdown in the camera panel');
  await p.keyboard.press('c');
  await p.waitForTimeout(200);
  const s = await p.evaluate(() => ({ g: window.__shotref.state.settings.guides, view: window.__shotref.view }));
  ok(s.view === 'camera', 'C did not switch to camera view (view ' + s.view + ')');
  ok(s.g === g0, 'pressing C changed Guides from ' + g0 + ' to ' + s.g);
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
  await p.click('#bExport');
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

check('start + end frames stops after a failed start frame', async ({ open }) => {
  const p = await open();
  await p.evaluate(TOAST_LOG);
  await p.evaluate(() => { HTMLCanvasElement.prototype.toBlob = function (cb) { cb(null); }; });
  await p.click('#bExport');
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
  await p.click('#bExport');
  await p.click('#exFrame');
  await p.waitForFunction(() => window.__dsk.calls.some(x => x.k === 'blob'), null, { timeout: 30000 });
  const b = await p.evaluate(() => window.__dsk.calls.find(x => x.k === 'blob'));
  ok(/\.png$/.test(b.n) && b.size > 1000 && JSON.stringify(b.f).includes('png'), 'png via bridge ' + JSON.stringify(b));
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
  ok(s.camera.mount === null && s.camera.dof.strength === 3, 'camera mount/blur strength: ' + JSON.stringify([s.camera.mount, s.camera.dof]));
  ok(s.shots.length === 1 && s.shots[0].camera.lookAtId === null && s.shotId === 's1', 'shots not repaired');
  ok(s.takes.length === 2 && s.takes[1].snap === null && s.takeId === 't1', 'takes not repaired');
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
  for (const l of ['Add a person here', 'Add floor mark here', 'Aim the camera here']) ok(labels.some(x => x.startsWith(l)), 'missing "' + l + '"');
  ok(!labels.some(x => x.startsWith('Move the camera here')), '"Move the camera here" belongs to Top view only');
  const n0 = await p.evaluate(() => window.__shotref.state.objects.length);
  await clickItem(p, 'Add a person here'); await p.waitForTimeout(200);
  const s = await stateOf(p), np = s.objects[s.objects.length - 1];
  ok(s.objects.length === n0 + 1 && np.type === 'person' && Math.abs(np.base.p[0] - pt[0]) < 0.6 && Math.abs(np.base.p[2] - pt[2]) < 0.6, 'person not added at the clicked spot: ' + JSON.stringify(np.base.p));
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
  ok(await p.evaluate(() => !document.querySelector('#mExport').classList.contains('hidden')), 'File > Export did not open the Export window');
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
  ok(await p.evaluate(() => !document.querySelector('#mExport').classList.contains('hidden')), 'key 3 did not open Export');
  ok(await on() === 'export', 'Export should be active, got ' + await on());
  await p.keyboard.press('Escape');
  await p.waitForTimeout(150);
  ok(await on() === 'build', 'closing Export should return to Build, got ' + await on());
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

main().catch(e => { console.error(e && e.stack || e); process.exit(2); });
