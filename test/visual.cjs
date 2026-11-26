/* ShotRef visual check: saves the same fixed screens every run, so a UI change can be looked at, not just tested.
 *   node test/visual.cjs [outDir] [--only <name part>]
 * Needs: npm run build first. Writes PNGs to outDir (default dist/visual/), prints one line per screen
 * and any page errors. Exit 1 if a screen failed or the page logged an error.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'dist', 'ShotRef.html');
const args = process.argv.slice(2);
const onlyAt = args.indexOf('--only');
const only = onlyAt >= 0 ? args[onlyAt + 1] : null;
const OUT = path.resolve(args.find((a, i) => !a.startsWith('--') && i !== onlyAt + 1) || path.join(ROOT, 'dist', 'visual'));

function browserPath() {
  const list = [process.env.SHOTREF_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean);
  const found = list.find(p => fs.existsSync(p));
  if (!found) throw new Error('No browser found. Set SHOTREF_BROWSER to msedge.exe or chrome.exe');
  return found;
}

/* Each screen: name, viewport, and what to do on a fresh starter scene before the picture. */
const S = fn => p => p.evaluate(fn);
const SCREENS = [
  { name: '01-scene', note: 'starter scene, nothing selected', run: S(() => { window.__shotref.select(null); }) },
  { name: '02-object', note: 'first object selected (object panel)', run: S(() => { const o = window.__shotref.state.objects[0]; window.__shotref.select(o.id, 'single'); }) },
  { name: '03-camera-view', note: 'camera selected, camera view', run: S(() => { window.__shotref.select('camera', 'single'); window.__shotref.setView('camera'); }) },
  { name: '04-top-view', note: 'top view', run: S(() => { window.__shotref.select(null); window.__shotref.setView('top'); }) },
  { name: '05-export', note: 'Export panel', run: S(() => { window.__shotref.select('export', 'single'); }) },
  { name: '06-advanced', note: 'Advanced mode, camera selected', run: S(() => { window.__shotref.setSimple(false); window.__shotref.select('camera', 'single'); }) },
  { name: '07-empty', note: 'empty scene (no objects)', run: async p => { /* the real way: select everything, press Delete */
    await p.evaluate(() => { const s = window.__shotref; s.selectMany(s.state.objects.map(o => o.id)); });
    await p.mouse.move(640, 300); await p.keyboard.press('Delete');
    await p.evaluate(() => { if (window.__shotref.state.objects.length) throw new Error('objects left after Delete'); });
  } },
  { name: '08-narrow', note: 'small window 1100 x 700, object selected', viewport: { width: 1100, height: 700 }, run: S(() => { const o = window.__shotref.state.objects[0]; window.__shotref.select(o.id, 'single'); }) },
  { name: '09-move-preview', note: 'camera Move tab, hovering Orbit left (move preview)', run: async p => {
    await p.evaluate(() => { window.__shotref.select('camera', 'single'); }); await p.waitForTimeout(400);
    await p.locator('#props button', { hasText: /^Move$/ }).first().click(); await p.waitForTimeout(400);
    await p.hover('#props .movegrid button:has-text("Orbit left")');
    await p.waitForFunction(() => { const k = window.__shotref.peek(); return k.open && k.frames > 20; }, null, { timeout: 10000 });
  } },
  { name: '10-pose-preview', note: 'person selected, hovering Wave (pose preview)', run: async p => {
    await p.evaluate(() => { const S = window.__shotref, o = S.state.objects.find(q => q.type === 'person') || S.addObject('person'); S.select(o.id, 'single'); }); await p.waitForTimeout(400);
    await p.hover('#props .posegrid button:has-text("Wave")');
    await p.waitForFunction(() => { const k = window.__shotref.peek(); return k.open && k.src === 'pose' && k.frames > 20; }, null, { timeout: 10000 });
  } },
  { name: '11-shot-preview', note: 'camera Shot tab, hovering Close-up (shot size preview, held)', run: async p => {
    await p.evaluate(() => { window.__shotref.select('camera', 'single'); }); await p.waitForTimeout(400);
    await p.locator('#props button', { hasText: /^Shot$/ }).first().click(); await p.waitForTimeout(400);
    await p.hover('#props .posegrid button:has-text("Close-up")');
    await p.waitForFunction(() => { const k = window.__shotref.peek(); return k.open && k.src === 'shot' && k.frames > 40; }, null, { timeout: 10000 });
  } },
  { name: '12-items', note: 'Items tab grouped by category, Buildings folded, a car selected', run: async p => {
    await p.evaluate(() => { const S = window.__shotref; for (let i = 0; i < 3; i++) S.addObject('building'); S.addObject('lamp'); S.addObject('sofa'); S.addObject('tree'); const c = S.addObject('car'); c.keys.push({ t: 0, p: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }); S.setPref('olClosed', { Buildings: true }); S.select(c.id, 'single'); S.changed(true, true); });
    await p.click('#leftTabs [data-lt=scene]'); await p.waitForTimeout(400);
  } },
];

async function main() {
  if (!fs.existsSync(HTML)) { console.error('dist/ShotRef.html is missing. Run: npm run build'); process.exit(2); }
  fs.mkdirSync(OUT, { recursive: true });
  const srv = http.createServer((req, res) => {
    if (req.url.split('?')[0] !== '/ShotRef.html') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); fs.createReadStream(HTML).pipe(res);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port + '/ShotRef.html';
  const browser = await chromium.launch({ executablePath: browserPath(), headless: true, args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  const built = fs.statSync(HTML).mtime;
  console.log('Build: dist/ShotRef.html, ' + built.toLocaleString());
  let bad = 0;
  for (const s of SCREENS.filter(x => !only || x.name.includes(only))) {
    const ctx = await browser.newContext({ viewport: s.viewport || { width: 1440, height: 900 } });
    await ctx.addInitScript(() => { try { localStorage.setItem('shotref.seenHelp', '1'); } catch (e) { } });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', e => errors.push(e.message));
    p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    try {
      await p.goto(url);
      await p.waitForFunction(() => window.__shotref && window.__shotref.state);
      await p.waitForTimeout(600);
      await s.run(p);
      await p.waitForTimeout(700); /* panels rebuild and the scene redraws on the next frames */
      const file = path.join(OUT, s.name + '.png');
      await p.screenshot({ path: file });
      console.log((errors.length ? 'ERRORS ' : 'OK     ') + s.name + '  (' + s.note + ')');
      for (const e of errors) console.log('         ' + e.split('\n')[0]);
      if (errors.length) bad++;
    } catch (e) { console.log('FAIL   ' + s.name + ': ' + e.message.split('\n')[0]); bad++; }
    await ctx.close();
  }
  await browser.close(); srv.close();
  console.log('Pictures in ' + OUT);
  process.exit(bad ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
