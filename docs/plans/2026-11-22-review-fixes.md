# ShotRef review fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every item from the 2026-11-22 review (all approved by Ali: "Approve all"), each bug proven by a failing smoke test first.

**Architecture:** Keep the single-file app and the single JSON `state`. Add one headless smoke test (`test/smoke.cjs`, playwright-core + system Edge, its own tiny static server), one pure module `src/project.js` (load/normalise/migrate), one pure module `src/keys.js` (keyframe maths). Everything else is targeted edits in `src/main.js` and `src/index.html`.

**Tech Stack:** three 0.187, mp4-muxer 5.2.2, esbuild 0.28 (bundles `src/*.js` into `dist/ShotRef.html`), playwright-core 1.65.1 (dev only), Node 24.

**Spec:** Review report https://claude.ai/artifact/TJioX5TrTD7WdSdGpriewz and the "Review 2026-11-22" section of `PROJECT.md`. Finding IDs (A1…, U1…, P1…, S1…) refer to that report.

## Global Constraints

- Output must stay ONE offline HTML file `dist/ShotRef.html`: no network requests, CDNs or fonts.
- Must keep working in BOTH environments in CLAUDE.md: file:// in Chrome/Edge, and the claude.ai sandbox (no `blob:` image URLs, no network, `localStorage`/IndexedDB may throw — wrap every access in try/catch, no alert/confirm/prompt, downloads via `saveFile()`).
- UI text: plain English, sentence case, for a non-coder TV producer. Errors say what happened and what to do next; technical detail goes to `console.error` only.
- Units metres/degrees, +Y up. Do not change the `.shotref.json` shape in a way older ShotRef builds cannot read, except adding fields.
- No new runtime dependencies. Dev-only: `playwright-core@1.65.1`. Move `esbuild` to devDependencies.
- After every task: `npm run build && npm test` must pass (except tests explicitly marked as known-failing for a LATER task — none should remain at the end).
- The folder is not a git repo: there are no commits. "Checkpoint" = build + test green. Backup lives at `..\Shotref-backup-2026-11-22`.
- Browser for tests: `SHOTREF_BROWSER` env var, else `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`, else `C:/Program Files/Google/Chrome/Application/chrome.exe`.

## Review Focus

1. A user's EXISTING autosave and saved `.shotref.json` files (version 1, assets inline) must still load after the update — test `legacy autosave with inline assets restores` (Task 3) and `old v1 file opens` (Task 2).
2. The claude.ai sandbox where IndexedDB throws (opaque origin) — autosave must fall back without errors: test `autosave works when IndexedDB is unavailable` (Task 3).
3. Undo right after Open / starter set / delete of an imported model must bring the old scene back WITH its photo/model — test `undo after open restores scene and assets` (Task 2).
4. Render-on-demand must not leave a stale view after async loads (GLB, photo), orbit damping, window resize, or playback — test `view updates after async model load and after resize` (Task 7).
5. Export still produces a correct, full-size file after the new locks — test `mp4 export dimensions match the dialog` (Task 4).

---

### Task 1: Smoke test harness (S1, part of S5)

**Files:**
- Create: `test/smoke.cjs`
- Modify: `package.json` (scripts `test`, `build:debug`; move esbuild to devDependencies; add `playwright-core@1.65.1` devDependency), `build.mjs` (optional `--debug` flag: no minify, inline sourcemap, output `dist/ShotRef.debug.html`), `.gitignore` unchanged.

**Interfaces:**
- Produces: `test/smoke.cjs` exporting nothing; run with `node test/smoke.cjs [--only <substring>]`. Inside: `check(name, fn)` registry; `fn({ page, ctx, server, open(path) , fixtures })`. `open(path)` = new page at `http://127.0.0.1:<port>/<path>` waiting for `window.__shotref`, collects `pageerror` + console errors into `page.__errors`. Server serves `dist/` at `/` and `test/fixtures/` at `/fixtures/`; `/app.html` = `dist/ShotRef.html` with the CSP header from `sandbox/serve.py`. Helper `downloads(page)` patches `HTMLAnchorElement.prototype.click` to capture `{name, size, bytes(base64 optional)}` into `window.__dl`. Helper `freshContext()` gives an isolated profile (new browser context) per check. Prints `PASS name` / `FAIL name: reason`, summary line `N passed, M failed`, exit code 1 on any failure.

- [ ] Step 1: Write baseline checks that SHOULD pass today: `loads with no errors` (3 objects, 0 errors), `strict CSP page loads` (/app.html, 0 errors), `person moves between keys` (addObject('person'), writeObj/setKey at t=0 and t=2 with x=0 and x=4 → evalObj at t=1 has 0<x<4), `camera move adds keys` (applyMove of first available preset → state.camera.keys.length ≥ 2), `save then open round-trips` (click #bSave, capture JSON, reload fresh context, setInputFiles #fOpen → JSON.stringify(state) equal ignoring ids order), `photo frame exports` (#fPlate ← fixtures/location.jpg, exportPNG(0) → a .png download > 10 KB), `mp4 export works` (settings.size=1280, exportVideo() → .mp4 download > 10 KB).
- [ ] Step 2: Write the KNOWN-BUG checks now, marked `{ known: 'A2' }` etc. (reported as `KNOWN-FAIL`, not failing the run, and reported as `UNEXPECTED-PASS` when they pass): `damaged file keeps current scene` (A2), `open asks first and can be undone` (A3), `autosave keeps photo after replace and reload` (A1), `path cancel is clickable at 1366` (U1). Later tasks remove the `known` flag.
- [ ] Step 3: `npm i -D playwright-core@1.65.1`, move esbuild to devDependencies, add scripts `"test": "node test/smoke.cjs"`, `"build:debug": "node build.mjs --debug"`.
- [ ] Step 4: Run `npm run build && npm test`. Expected: all baseline PASS, 4 KNOWN-FAIL, exit 0. Total runtime < 90 s.

### Task 2: Safe open, project normaliser, keep undo (A2, A3, S2, starter/new undo)

**Files:**
- Create: `src/project.js`
- Modify: `src/main.js` loadProjectText (~2138), boot (~2563), loadStarter (~2054), newProject (~2123), confirmBox (~2350), file input/drop handlers (~2397, ~2410); `src/index.html` (#cfOk label set by code).
- Test: `test/smoke.cjs`

**Interfaces:**
- Produces: `src/project.js` exports `FORMAT_VERSION = 2`, `normalizeProject(raw, defaults) -> { state, assets }` (pure, no DOM/three; throws `Error('NOT_SHOTREF')` when `raw` is not an object with `state.camera`, or `raw.app` exists and ≠ 'ShotRef'). `defaults = { settings: DEFAULT_SETTINGS, camera: defaultState().camera }` passed in by main.js. Fills: `settings` (merge), `camera.base` fields, `camera.keys ?? []`, `feel`, `dof`, `shake ?? 0`, `lookAtId ?? null` (null if the id is not in objects), `follow ?? false`; `objects` must be an array (else `[]`); each object: drop if no `type`; `id ?? uid`, `name ?? type`, `opts ?? {}`, `base {p,r,s}` with numeric 3-arrays (defaults [0,0,0],[0,0,0],[1,1,1]), `keys` array of objects with numeric `t` (sorted, non-finite removed), `visible ?? true`; `plate` null unless `plate.asset` is a string. Sets `state.v = FORMAT_VERSION`. `assets` object or `{}`.
- Produces: `confirmBox(title, text, cb, okLabel = 'OK')`.
- Produces (main.js): `replaceProject(newState, newAssets, label)` — the one way to swap scenes: merges assets into memory (`assets = {...assets, ...newAssets}` so undo keeps old files), keeps history (pushes a new step instead of clearing), rebuilds; on any exception restores the previous `state`/`assets`/view and rethrows.

- [ ] Step 1: Tests: `damaged file keeps current scene` (remove `known`): for each of 4 files — `{state:{camera:{base:…,keys:[]}}}` (no objects), objects without keys/opts, camera without keys, object with `base:{}` — after #fOpen: either the scene is unchanged or it loaded normalised; `page.__errors.length===0` after 1 s; reload same context → `__shotref` exists and 0 errors. Plus `old v1 file opens` (a v1 file without dof/feel/v loads, 0 errors), `open asks first and can be undone` (8 objects → #fOpen → #mConfirm visible with #cfOk text "Open file"; click it → loaded; Ctrl+Z → 8 objects back), `undo after open restores scene and assets` (scene with plate photo → open other file → Ctrl+Z → plate image visible / assets[plate.asset] exists), `starter set can be undone` (load a starter over 3 objects → Ctrl+Z → original 3).
- [ ] Step 2: Run `npm test --only open` → new tests FAIL.
- [ ] Step 3: Implement `src/project.js`, `replaceProject`, use them in loadProjectText (confirm when `state.objects.length || state.plate`; friendly toast "This isn't a ShotRef project, or the file is damaged." on failure; console.error the detail), drop handler, loadStarter, newProject. Boot: normalise the autosave; wrap the whole restore+first syncScene in try/catch; on failure copy raw to `shotref.autosave.broken`, start a seeded scene, toast "Your last session couldn't be restored, so ShotRef started a fresh scene." Remove the duplicated patch-up code.
- [ ] Step 4: `npm run build && npm test` → all PASS (except remaining known A1/U1).

### Task 3: Autosave that keeps photos and models (A1, A5, A12 save name + flush)

**Files:** Modify `src/main.js` autosave (~271), boot, saveProject (~2134), importModel/importImage/importPlate (call `changed(true…)` so the import is autosaved); Test `test/smoke.cjs`.

**Interfaces:**
- Consumes: `normalizeProject` (Task 2).
- Produces: `usedAssetIds(state) -> Set<string>` (objects' `opts.asset` + `state.plate.asset`). Storage layout: localStorage `shotref.autosave` = `{ state, assets: {}, assetIds: [...], v: 2 }` (small); IndexedDB db `shotref`, store `assets`, key = asset id, value = asset record. Fallback when IDB unavailable/throws: old layout with inline used assets; if that throws too: save state only and toast once per session "Photos and models are too big to autosave in this browser. Use Save to keep them." Reading: legacy autosave with inline `assets` still works.

- [ ] Step 1: Tests (remove `known` from A1): `autosave keeps photo after replace and reload` (generate a ~4.5 MB 4000×3000 JPEG in-page via canvas, load as plate, replace with fixtures/location.jpg, wait 1 s, reload same context → `state.plate` and `assets[state.plate.asset]` exist; no "Restored" toast without the photo), `deleted imports are not autosaved` (import texcube.glb, delete it, wait → stored asset count 0), `legacy autosave with inline assets restores` (seed localStorage with old-format object incl. plate asset → reload → plate asset present), `autosave works when IndexedDB is unavailable` (addInitScript that makes `indexedDB.open` throw → edits autosave, no page errors; with a 6 MB asset the one-time warning toast shows), `two tabs warn` (two pages same context; edit in A → B shows a toast containing "another tab"), `save file name has a date` (download name matches `/^shotref-\d{8}-\d{4}\.shotref\.json$/`).
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Implement. Boot becomes: restore state synchronously, then load IDB assets (await with 1.5 s timeout) before the first syncScene of model/plate visuals (fine to `syncScene()` again after assets arrive). If some used assets are missing: toast "N photos or models couldn't be restored. Open your saved project file to get them back." Add `storage` listener (A5) and `pagehide` flush of the localStorage part (A12). Save name `shotref-${stamp()}.shotref.json`; saveProject writes only used assets.
- [ ] Step 4: build + test → PASS.

### Task 4: Export safety (A4, A8, A9, P3, A12 cancel text / zero duration)

**Files:** Modify `src/main.js` exportVideo (~2276), exportPNG (~2227), copyFrame, getExportRenderer (~2210), frame (~1151), keydown (~2517), `[data-close]` handler (~2415), setDuration (~1951), `#inDur` handler (~2393), renderExportDialog; Test `test/smoke.cjs`.

- [ ] Step 1: Tests: `export settings are locked while exporting` (start 2560 px 6 s export, immediately: all `#mExport` inputs/selects/buttons except `#exCancel` are disabled, `[data-close]` click leaves dialog open, `exportPNG` / key P during export make no download; result single MP4), `mp4 export dimensions match the dialog` (parse the MP4 `tkhd` width/height from the captured bytes = 1280×720 for size 1280 16:9), `frame png failure shows a message` (stub `HTMLCanvasElement.prototype.toBlob` to call back null → toast text contains "Could not make that frame"), `lost graphics context does not save an empty video` (lose the export renderer context via `WEBGL_lose_context` after a first export, export again → a valid >10 KB MP4 or an error toast; never "Done: 0.0 MB"), `cancel clears the progress text`, `duration 0 becomes the minimum` (type 0 → duration 1, toast mentions the 1 s minimum).
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Implement: `setExportLock(on)` disables every control in `#mExport` except Cancel; close/Esc/backdrop/P/Copy/Frame PNG all check `exporting`; `frame()` while exporting only schedules the next frame (no applyAll/draw/DOM). Export renderer: listen for `webglcontextlost` → `exRenderer = null`; check `isContextLost()` before use; MP4 under 1 KB → treat as failure. Null blob → toast "Could not make that frame. Try a smaller export size." Errors use plain text (see Task 6 U2 messages). Expose `exportVideo` already on hooks.
- [ ] Step 4: build + test → PASS.

### Task 5: Small bug fixes (A6, A7, A10, A11)

**Files:** Modify `src/main.js` setDuration/#inFps re-snap, embeddedTexturePlugin (~576), importImage (~2191), deleteSel (~2008); Test `test/smoke.cjs`.

- [ ] Step 1: Tests: `shrinking the shot keeps keys apart` (72 keys at 1/24 s spacing on an object, duration 10→5→10 → distinct key times count = 72 after 10→5 (spread one frame apart, may extend past the end only if the old code allowed it; otherwise count ≥ min(72, frames)) — decide by reading setDuration: keys must never share a frame), `glb with outside textures stays offline` (build a GLB in-test whose image has `uri:"http://127.0.0.1:<port>/fixtures/location.jpg"` → no request to that URL (page.on('request')), a toast mentions "textures", model still added), `non-image file is refused as image card` (#fImage ← a .txt buffer → no new object, toast "isn't an image"), `deleting the look-at person keeps the framing` (camera lookAtId = person, record evalCam aim, delete person → base.tg equals the previous aim within 1e-6).
- [ ] Step 2: Run → FAIL. Step 3: implement. Step 4: build + test → PASS.

### Task 6: UI/UX fixes (U1–U8, U2 messages)

**Files:** Modify `src/index.html` CSS/markup, `src/main.js` (setView, renderProps, tickUI hint text, isTyping, keydown, toast, openModal/closeModal, renderOutliner, renderTimeline label, undo/redo toasts, boot first-launch); Test `test/smoke.cjs`.

Decisions:
- U1: `#modeBar` `z-index` above `#pipFrame`; `#modeBar button{flex:none}`; mode bar text may wrap.
- U2: message table — open failure "This isn't a ShotRef project, or the file is damaged."; MP4 encoder failure "Your PC couldn't make an MP4 at this size. Try 1280 px, or use Start + end frames."; generic export "The export stopped because of an error. Try again, or try a smaller size."; path tip refers to "Fit the path to the end of the shot".
- U3: in Camera view with `selected == null`, renderProps shows the camera panel (propsCamera) — selection itself stays null; hint text says "click Shot camera in the timeline".
- U4: modals get `role="dialog" aria-modal="true"`, × gets `aria-label="Close"`; openModal focuses `.primary` (or first button); Tab/Shift+Tab cycle inside the open modal; Enter in #mConfirm = OK. Outliner rows and timeline labels `tabIndex=0`, Enter/Space selects.
- U5: `isTyping()` returns false for SELECT; Delete/Backspace ignored when focus is any INPUT/SELECT/TEXTAREA (any type).
- U6: timeline height = tracks content, min 90 px, max 182 px; hide brand subtitle below 1400 px; Quick start dialog fits a 720 px-tall window (scroll inside dialog body, not page).
- U7: when any modal is open the toast sits at the top centre of the viewport (top: 16px) instead of bottom 200px; mode tips (path/record) shown for 6.5 s.
- U8: `.addcat` uses `var(--mute)` (≥4.5:1); outliner/timeline names in a span with `text-overflow:ellipsis`; undo/redo toast names the change via `describeChange(beforeJSON, afterJSON) -> string` (e.g. "Undo: move Person 1", "Undo: delete Box 1", "Undo: add Car 1", "Undo: camera change", "Undo: settings change"; fallback "Undo"); first launch opens the starter-set picker (no confirm on first launch), with a "Quick start guide" button inside it that opens #mHelp.

- [ ] Step 1: Tests (remove `known` from U1): `path cancel is clickable at 1366` (viewports 1280×720, 1366×768, 1536×864: start path on person, elementFromPoint at Cancel centre and 75% is inside Cancel; click → mode bar hidden, view still editor), `camera view shows camera tools` (fresh, press C → props panel contains "Lens"), `delete with slider focused keeps object`, `space works after changing fps dropdown`, `dialogs trap focus` (open Export, Tab ×10 → activeElement always inside #mExport), `confirm accepts Enter`, `undo names the change` (move person, Ctrl+Z → toast starts "Undo: move"), `section headings have readable contrast` (computed .addcat colour vs panel bg ≥ 4.5), `first launch shows starter sets` (fresh context → #mStart visible), `friendly error on bad file` (toast has no "JSON"/"position").
- [ ] Step 2: Run → FAIL. Step 3: implement. Step 4: build + test → PASS; also screenshots at 1280×649 (dsf 1.5), 1366×768, 1920×1080 saved to the scratchpad for the lead to look at.

### Task 7: Performance (P1, P2, P4, P5, P6, P7, P8)

**Files:** Modify `src/main.js` frame/draw (~1097-1170), writeObj/writeCam/changed, disposeTree/modelCache (~597-612, ~748), tickUI (~1685), updateHelpers aim line (~893), plateSection (~2174); Test `test/smoke.cjs` + a perf script `test/perf.cjs` (not part of `npm test`; prints numbers).

Decisions:
- P1: render on demand. `needsRender` is set when a cheap frame signature changes: `[version, T, view, selected, playing, rec phase, pipOn, canvas size, hover id, gizmo dragging/axis, edCam/topCam matrixWorld elements]`, plus a 20-frame keep-alive after any pointer/wheel/key event, and `requestRender()` called by every async completion (model load, plate decode, image load). `renderer.shadowMap.autoUpdate=false` with `needsUpdate=true` once per rendered frame. Do not share materials (skip; risk).
- P2: non-commit writes (drag) do not set `uiDirty`; commit at drag end does.
- P4: when a model asset stops being used (New/Open/starter/delete+history no longer referencing it is hard — so: dispose on `modelCache` clear and when replacing the cache), traverse cached scene → dispose geometry, materials, textures.
- P5: tickUI assigns innerHTML only when the string changed. P6: computeLineDistances only when camState p/tg changed. P7: cache `data:` URL per asset id. P8: measure live element count over 30 starter loads; fix only if live count grows.

- [ ] Step 1: Tests: `idle scene stops redrawing` (after 2 s idle, count `renderer.info.render.frame` delta over 1 s ≤ 2 — expose `__shotref.renderStats()` returning `{frame, calls}` of the main renderer), `view updates after async model load and after resize` (import texcube.glb; within 2 s a frame was rendered after the load resolved; resize viewport → frame rendered), `playback still renders every frame` (play 1 s → ≥ 30 rendered frames), `dragging does not rebuild lists` (hook counter `__shotref.rebuilds` of outliner/timeline: drag 20 moves → ≤ 2 rebuilds), `models are freed on new project` (import texcube.glb ×3 + New → main renderer.info.memory.geometries back to within +2 of baseline), `hud is not rewritten when idle` (MutationObserver on #hud and #hint over 1 s idle ≤ 2 mutations).
- [ ] Step 2: Run → FAIL. Step 3: implement. Step 4: build + test → PASS; run `node test/perf.cjs` before (on backup build) and after, report idle script ms (3 and 123 objects), export ms (5 s 1080p, 3 and 123 objects).

### Task 8: Code tidy-ups and docs (S3, S4, S5)

**Files:** Create `src/keys.js`; modify `src/main.js` (import keys maths, `setTime(t)` used by every playhead move, a "shared values" comment block at the top listing each module-level `let` and who changes it, rename global `version` → `editRev`), `CLAUDE.md` (testing rule, `npm ci`, mp4-muxer deprecated—do not upgrade blindly, new modules, autosave layout), `README.md` (test + debug build).

**Interfaces:** `src/keys.js` exports `tangent(keys,i,f,natural)`, `sampleField(keys,t,f,mode)`, `keyIndexAt(keys,t,fps)`, `setKey(keys,t,vals,fps)` (snaps with `Math.round(t*fps)/fps`), `neighborKey(keys,t,fps)`. Behaviour identical.

- [ ] Step 1: Test `keyframe maths unchanged`: in-page, evaluate a fixed set of keys at 50 times through `__shotref.evalObj` → equals values captured from the backup build (store expected array in the test file — generate it once by running the same script against `..\Shotref-backup-2026-11-22\dist\ShotRef.html`).
- [ ] Step 2: Refactor. Step 3: build + test → all PASS, `npm run build:debug` produces `dist/ShotRef.debug.html` that loads with 0 errors.
