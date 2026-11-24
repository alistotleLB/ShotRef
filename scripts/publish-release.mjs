/* Publishes the Windows build in release/ as a GitHub release, so installed copies of ShotRef offer the update.
 *   1. raise "version" in package.json
 *   2. npm run dist:win          (builds the installer and latest.yml in release/)
 *   3. npm run publish:win       (this script)
 * Optional: write docs/RELEASE-NOTES-<version>.md first; otherwise GitHub writes notes from the commits since the last release.
 * Needs the GitHub CLI (gh), logged in. Add --draft to review the release on GitHub before it goes out. */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const tag = 'v' + version;
const draft = process.argv.includes('--draft');
const fail = m => { console.error('\n' + m + '\n'); process.exit(1); };
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts }).trim();

const files = [
  'release/latest.yml',
  `release/ShotRef-Setup-${version}.exe`,
  `release/ShotRef-Setup-${version}.exe.blockmap`,
  `release/ShotRef-${version}-portable.exe`,
  'dist/ShotRef.html',
];
const missing = files.filter(f => !existsSync(path.join(root, f)));
if (missing.length) fail('Missing: ' + missing.join(', ') + '\nRun "npm run dist:win" first (and check that package.json says version ' + version + ').');
if (!readFileSync(path.join(root, 'release/latest.yml'), 'utf8').includes('version: ' + version + '\n')) fail('release/latest.yml is not for version ' + version + '. Run "npm run dist:win" again.');

try { run('gh', ['--version']); } catch { fail('The GitHub CLI (gh) is not available. Install it from https://cli.github.com and run "gh auth login".'); }
let exists = true;
try { run('gh', ['release', 'view', tag, '--json', 'tagName']); } catch { exists = false; }
if (exists) fail('Release ' + tag + ' already exists. Raise the version in package.json, then run "npm run dist:win" again.');

const status = run('git', ['status', '--porcelain']);
if (status) fail('There are uncommitted changes:\n' + status + '\nCommit and push them first, so the release matches the code.');
run('git', ['fetch', 'origin', 'main']);
if (run('git', ['rev-list', '--count', 'origin/main..HEAD']) !== '0') fail('There are commits that are not on GitHub yet. Run "git push" first.');

const notes = path.join(root, `docs/RELEASE-NOTES-${version}.md`);
const args = ['release', 'create', tag, '--target', 'main', '--title', 'ShotRef ' + version, ...(existsSync(notes) ? ['--notes-file', notes] : ['--generate-notes']), ...(draft ? ['--draft'] : []), ...files.map(f => path.join(root, f))];
console.log('Publishing ' + tag + (draft ? ' as a draft' : '') + ' with ' + files.length + ' files (about 230 MB, this takes a few minutes)…');
console.log(run('gh', args, { stdio: ['ignore', 'pipe', 'inherit'] }));
console.log(draft ? 'Draft created. Publish it on GitHub when you are happy with it.' : 'Done. Installed copies of ShotRef will offer this update the next time they check.');
