# Developing ShotRef

ShotRef builds to **one self-contained HTML file** with no external requests. Keep it that way: no CDNs, no web fonts, no network calls.

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install          # or npm ci for a clean install that matches package-lock.json
npm run build        # writes dist/ShotRef.html
npm run build:debug  # writes dist/ShotRef.debug.html: not minified, readable names in errors
```

Open `dist/ShotRef.html` in Chrome or Edge.

## Windows app

The Windows app is [Electron](https://www.electronjs.org) loading the same `dist/ShotRef.html`.

```bash
npm run desktop     # builds the page and starts the app
npm run dist:win    # writes release/ShotRef-Setup-<version>.exe and ShotRef-<version>-portable.exe (unsigned)
```

If Electron has no `dist` folder after `npm install`, run `node node_modules/electron/install.js`.

### Shipping an update

The installed Windows app checks this repository's GitHub Releases ([electron-updater](https://www.electron.build/auto-update), code in `electron/updater.cjs`). To ship a change to everyone:

```bash
# 1. raise "version" in package.json (for example 1.3.0 -> 1.3.1), then commit and push
npm run build && npm test && npm run test:desktop
npm run dist:win       # builds release/ShotRef-Setup-<version>.exe, the blockmap, the portable exe and latest.yml
npm run publish:win    # makes the GitHub release with those files (add --draft to look at it first)
```

`latest.yml` is what installed copies read, so it must be attached to the release: the script does that. Optionally write `docs/RELEASE-NOTES-<version>.md` first; otherwise GitHub writes the notes from the commits.

Installed copies check about 8 seconds after launch (switch off in **Help, Check for updates automatically**) and offer the update. **Help, Check for updates…** checks on demand. "Restart now" closes the window the normal way, so the page still asks about unsaved work. The portable `.exe` cannot replace itself, so it only offers to open the download page.

The updater only runs in the installed app. From source, `SHOTREF_UPDATE_URL=http://127.0.0.1:<port>` points the check at a local folder that serves `latest.yml` (the desktop tests do this). The first build with the updater was 1.3.0, so people on 1.2.0 or older install 1.3.0 by hand once.

Updates are unsigned like the installer. electron-updater checks the file's SHA-512 against `latest.yml`, but the app does not check a publisher signature until a code-signing certificate is set up.

## Tests

```bash
npm run build && npm test   # about 260 checks in headless Edge or Chrome, about 9 minutes
npm run test:desktop        # the Electron shell, about 20 seconds (build first)
```

`node test/smoke.cjs --only <part of a check name>` runs single checks. Set `SHOTREF_BROWSER` to use a specific browser. `node test/perf.cjs` prints performance numbers by hand.

## Where things are

| Path | What it is |
|---|---|
| `src/main.js` | The app: scene, people, camera, timeline, UI, export |
| `src/project.js` | Loads and repairs project files and autosaves (`normalizeProject`) |
| `src/keys.js` | Keyframe maths |
| `src/platform.js` | Where the app runs (web, claude.ai or desktop) and the file and unsaved state |
| `src/index.html` | Page layout and all CSS |
| `build.mjs` | Bundles the app with esbuild into one HTML file |
| `electron/` | The Windows app shell |
| `test/` | Smoke tests, desktop tests, fixtures |
| `branding/`, `Logos/` | Icons, logo and brand notes |
| `docs/` | This documentation, screenshots (`docs/img`) and past plans (`docs/plans`) |

`CLAUDE.md` has the longer architecture notes: how the scene state, undo, autosave and export work, and the rules for running inside a sandboxed page.

## Libraries

- [three.js](https://threejs.org): 3D rendering, controls, the GLB loader
- [mp4-muxer](https://github.com/Vanilagy/mp4-muxer): writes MP4 files from WebCodecs frames. Deprecated upstream (superseded by Mediabunny). It works, so test exports before changing it
- [esbuild](https://esbuild.github.io): bundling
- [playwright-core](https://playwright.dev): drives the browser for tests (dev only)
