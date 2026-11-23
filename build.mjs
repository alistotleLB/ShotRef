import { build } from 'esbuild';
import fs from 'fs';
const debug = process.argv.includes('--debug');
const r = await build({ entryPoints: ['src/main.js'], bundle: true, minify: !debug, sourcemap: debug ? 'inline' : false, format: 'iife', write: false, target: 'es2020', legalComments: 'none' });
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script'); /* the JS string '<\\/script' is the 8 characters <\/script */
const html = fs.readFileSync('src/index.html', 'utf8').replace('<script>/*APP*/</script>', () => '<script>' + js + '</script>');
fs.mkdirSync('dist', { recursive: true });
const out = debug ? 'dist/ShotRef.debug.html' : 'dist/ShotRef.html';
fs.writeFileSync(out, html);
console.log('ok', (html.length/1024).toFixed(0) + ' KB' + (debug ? ' (debug: ' + out + ')' : ''));
