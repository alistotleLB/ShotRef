# ShotRef

A simple 3D blocking tool for building reference animations for AI video models. You lay out people and props, animate the camera, then export an MP4, PNG frames, or start + end frames.

It's a browser app with no server. The build produces **one self-contained file**, `dist/ShotRef.html`, which runs offline in Chrome or Edge.

## Setup

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install          # or npm ci for a clean install from package-lock.json
npm run build        # writes dist/ShotRef.html
npm test             # smoke tests in headless Edge or Chrome (about 100 s)
npm run build:debug  # writes dist/ShotRef.debug.html: not minified, readable errors
```

Open `dist/ShotRef.html` in Chrome or Edge by double-clicking it. Rebuild and run `npm test` after every change. `node test/smoke.cjs --only <name>` runs one check; set `SHOTREF_BROWSER` to use a different browser.

## Project layout

| Path | What it is |
|---|---|
| `src/main.js` | App logic: scene, people, camera, timeline, UI, export (about 3,000 lines) |
| `src/project.js` | Loads project files and autosaves: checks, repairs and fills in missing fields (`normalizeProject`) |
| `src/keys.js` | Keyframe maths: interpolation and setting keys |
| `src/index.html` | Page layout and all CSS. The bundled script is injected at `<script>/*APP*/</script>` |
| `build.mjs` | Bundles `src/main.js` with esbuild and inlines it into `src/index.html` (`--debug`: unminified) |
| `dist/ShotRef.html` | The built app (the build creates it) |
| `test/smoke.cjs` | Smoke tests (`npm test`): opens the built app in headless Edge or Chrome and checks it |
| `test/perf.cjs` | Prints performance numbers, run by hand (`node test/perf.cjs`) |
| `test/fixtures/` | Sample location photo and .glb models for testing |
| `docs/plans/` | Implementation plans |
| `sandbox/` | A local server that runs the app under strict, claude.ai-like browser rules (see CLAUDE.md) |

## Libraries

- [three.js](https://threejs.org) 0.187: 3D rendering, orbit and transform controls, the GLB loader
- [mp4-muxer](https://github.com/Vanilagy/mp4-muxer): writes MP4 files from WebCodecs H.264 frames. Deprecated upstream (superseded by Mediabunny); it works, so don't upgrade or swap it without testing exports
- [playwright-core](https://playwright.dev) (dev only): drives the browser for the smoke tests
- [esbuild](https://esbuild.github.io): bundling
