/* ShotRef performance numbers (not part of npm test).
 *   node test/perf.cjs [path-to-ShotRef.html | http://url]   (default: dist/ShotRef.html)
 * Prints, headless Edge/Chrome:
 *   - idle script time per 3 s (CDP ScriptDuration) and rendered frames per idle second,
 *     with the 3-object starter scene and with 123 objects (60 people + 60 boxes added)
 *   - MP4 export time (5 s, 1920 wide, 24 fps) for 3 and 123 objects
 *   - live DOM element count after 0 and 30 starter-set loads
 * "Rendered frames" = animation frames in which the main canvas (#c) was cleared (works on any build, no hooks).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const arg = process.argv[2] || path.join(__dirname, '..', 'dist', 'ShotRef.html');
const browserPath = [process.env.SHOTREF_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find(p => fs.existsSync(p));

function serve(file) {
  const srv = http.createServer((req, res) => {
    if (req.url.split('?')[0] !== '/app.html') { res.writeHead(404); res.end(); return; }
    fs.readFile(file, (err, buf) => { if (err) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(buf); });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

const INIT = `(() => {
  try { localStorage.setItem('shotref.seenHelp', '1'); } catch (e) { }
  window.__dl = [];
  const orig = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (!this.hasAttribute('download')) return orig.call(this);
    window.__dl.push({ name: this.getAttribute('download'), t: performance.now() });
  };
  window.__drew = 0; window.__frames = 0;
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue;
    const oc = C.prototype.clear;
    C.prototype.clear = function (m) { if (this.canvas && this.canvas.id === 'c') window.__drewThis = 1; return oc.call(this, m); };
  }
  const tick = () => { if (window.__drewThis) { window.__drew++; window.__drewThis = 0; } window.__frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
})();`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function idle(page, cdp) {
  await sleep(2500); /* let keep-alive / settling finish */
  const m = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
  const a = await m(), d0 = await page.evaluate(() => [window.__drew, window.__frames]);
  await sleep(3000);
  const b = await m(), d1 = await page.evaluate(() => [window.__drew, window.__frames]);
  return { scriptMs: Math.round((b.ScriptDuration - a.ScriptDuration) * 1000), taskMs: Math.round((b.TaskDuration - a.TaskDuration) * 1000), drawnPerSec: +((d1[0] - d0[0]) / 3).toFixed(1), rafPerSec: +((d1[1] - d0[1]) / 3).toFixed(1) };
}

async function exportMs(page) {
  await page.evaluate(() => { window.__dl.length = 0; const S = window.__shotref, s = S.state.settings; s.size = 1920; s.duration = 5; s.fps = 24; S.changed(true, true); });
  await sleep(500);
  const t0 = await page.evaluate(() => { const t = performance.now(); window.__shotref.exportVideo(); return t; });
  const end = Date.now() + 600000;
  for (;;) {
    const d = await page.evaluate(() => window.__dl.find(x => /\.(mp4|webm)$/.test(x.name)));
    if (d) return { ms: Math.round(d.t - t0), file: d.name.split('.').pop() };
    if (Date.now() > end) return { ms: null, file: 'timeout' };
    await sleep(200);
  }
}

async function main() {
  let server = null, url = arg;
  if (!/^https?:/.test(arg)) { server = await serve(path.resolve(arg)); url = 'http://127.0.0.1:' + server.address().port + '/app.html'; }
  const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__shotref && window.__shotref.state);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  const out = { build: arg };
  out.idle3 = await idle(page, cdp);
  out.export3 = await exportMs(page);
  await page.evaluate(() => {
    const S = window.__shotref;
    for (let i = 0; i < 120; i++) { const o = S.addObject(i % 2 ? 'box' : 'person'); o.base.p = [(i % 12) * 1.5 - 8, 0, Math.floor(i / 12) * 1.5 - 8]; }
    S.select(null); S.changed(true, true);
  });
  out.objects = await page.evaluate(() => window.__shotref.state.objects.length);
  out.idle123 = await idle(page, cdp);
  out.export123 = await exportMs(page);

  /* P8: live DOM elements after 0 and 30 starter loads (fresh page) */
  const p2 = await ctx.newPage();
  await p2.goto(url);
  await p2.waitForFunction(() => window.__shotref && window.__shotref.state);
  await sleep(800);
  const count = () => p2.evaluate(() => document.getElementsByTagName('*').length);
  const kinds = ['Empty stage', 'Two-person dialogue', 'Walk and talk', 'Living room', 'Café table', 'Street', 'Blocking practice'];
  out.elements = { after0: await count() };
  for (let i = 0; i < 30; i++) {
    await p2.click('#bNew');
    await p2.click('#startGrid .card:has-text("' + kinds[i % kinds.length] + '")');
    const asked = await p2.waitForSelector('#mConfirm:not(.hidden)', { timeout: 1500 }).then(() => true, () => false);
    if (asked) await p2.click('#cfOk');
    await sleep(250);
    if (i === 1) { await sleep(800); out.elements.after2 = await count(); } /* load 2 and load 30 are both the dialogue set */
  }
  await sleep(800);
  out.elements.after30 = await count();
  out.pageErrors = errs.slice(0, 3);
  console.log(JSON.stringify(out, null, 2));
  await browser.close(); if (server) server.close();
}
main().catch(e => { console.error(e); process.exit(2); });
