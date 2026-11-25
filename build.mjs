import { build } from 'esbuild';
import fs from 'fs';
const debug = process.argv.includes('--debug');
/* the About window's Licences list: the libraries bundled into the page, plus the desktop app's own (shown only there) */
/* licence files are hard-wrapped at ~80 columns: join each paragraph into one line so the window wraps it to its own width */
const reflow = t => t.replace(/\r/g, '').trim().split(/\n\s*\n/).map(p => p.replace(/\s*\n\s*/g, ' ')).join('\n\n');
const lic = (name, desktop) => {
  const dir = 'node_modules/' + name;
  return { name, version: JSON.parse(fs.readFileSync(dir + '/package.json', 'utf8')).version, desktop, text: reflow(fs.readFileSync(dir + '/LICENSE', 'utf8')) };
};
const LICENSES = [lic('three', false), lic('mp4-muxer', false), lic('electron', true), lic('electron-updater', true)];
const BUILD_DATE = new Date().toISOString().slice(0, 10);
const r = await build({ entryPoints: ['src/main.js'], bundle: true, minify: !debug, sourcemap: debug ? 'inline' : false, format: 'iife', write: false, target: 'es2020', legalComments: 'none', define: { __APP_VERSION__: JSON.stringify(JSON.parse(fs.readFileSync('package.json', 'utf8')).version), __BUILD_DATE__: JSON.stringify(BUILD_DATE), __LICENSES__: JSON.stringify(LICENSES) } });
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script'); /* the JS string '<\\/script' is the 8 characters <\/script */
const html = fs.readFileSync('src/index.html', 'utf8').replace('<script>/*APP*/</script>', () => '<script>' + js + '</script>');
fs.mkdirSync('dist', { recursive: true });
const out = debug ? 'dist/ShotRef.debug.html' : 'dist/ShotRef.html';
fs.writeFileSync(out, html);
console.log('ok', (html.length/1024).toFixed(0) + ' KB' + (debug ? ' (debug: ' + out + ')' : ''));
