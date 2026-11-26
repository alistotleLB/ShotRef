# ShotRef: notes for Claude Code

ShotRef is a "very dumbed-down Blender" for **blocking and camera moves only**. It makes reference animations for AI video generation (Kling, Runway, Veo, Higgsfield…). The owner is a TV producer and videographer, not a 3D artist. Keep the UI simple, plain-spoken and visual. When a feature sits between "powerful" and "easy", choose easy. Put power-user detail behind the **Advanced** mode switch (`simple` flag, in the gear menu as "Advanced mode").

## Build and run

- `npm install` once (`npm ci` for a clean install that matches `package-lock.json` exactly), then `npm run build`. The output is `dist/ShotRef.html`, one self-contained file.
- `npm run build:debug` writes `dist/ShotRef.debug.html`: not minified, with readable names in errors. Use it when a stack trace is unreadable.
- The app must stay a **single offline HTML file**: no external requests, CDNs or fonts.
- Check changes in Chrome or Edge.
- Desktop app (Windows, Electron, `electron/main.cjs` + `preload.cjs`, loads the same `dist/ShotRef.html`): `npm run desktop` builds the page and starts it; `npm run dist:win` writes `release/ShotRef-Setup-<ver>.exe` and `ShotRef-<ver>-portable.exe` (unsigned). If `electron` has no `dist` folder after `npm install`, run `node node_modules/electron/install.js`.
- **Desktop updates** (`electron/updater.cjs`, electron-updater, GitHub Releases of alistotleLB/ShotRef): main process only, nothing in the page or preload. Ship with: raise `version`, add the version's lines to `electron/whats-new.json`, `npm run dist:win`, `npm run publish:win` (needs the release's `latest.yml`; the script attaches it). `hardenSession` still blocks all page network; `updater.allowsRequest` lets through main-process requests to GitHub only. `three` and `mp4-muxer` are devDependencies (bundled into the page); only `electron-updater` is a runtime dependency, so keep `files` in package.json free of a `node_modules` exclusion. The install step (`quitAndInstall`) can't run under test; the check, download and verify can (`SHOTREF_UPDATE_URL`, see `test/desktop.cjs`).
- **Desktop window and menus**: `settings.window` in `shotref-settings.json` remembers the window (`{x, y, width, height, maximized}`, saved 500 ms after a move or resize and on close, used only if still on a connected display; a work area under 1440 x 900 opens maximized; minimum 1100 x 600). `nativeTheme.themeSource` is always `dark`. On the desktop the page hides `#bFile` and the gear menu has only Advanced mode and Settings: the Windows File menu (with Recent projects… and Export…, sent as the `recent` and `export` menu commands) and Help menu do the rest, and the quick tour skips its File stop. User-facing "in this browser" goes through `whereSaved()` ("on this computer" on the desktop); static lines in `index.html` carry `data-where`.
- **Desktop message boxes** (`electron/popup.cjs` + `popup.html`, `popup-page.js`, `popup-preload.cjs`): ShotRef's own branded box in a small frameless window, in place of `dialog.showMessageBox` (which looked like Windows and played the alert sound). `popup.show(parent, opts)` takes the showMessageBox options plus `notes` and `width`, queues boxes so they never overlap, and resolves `{response}`. Never call `dialog.showMessageBox`; the native Save and Open file pickers stay. Tests stub `global.__shotrefPopup.show`.
- **What's new** (desktop): `settings.lastVersion` in `shotref-settings.json`. On a launch where the version went up, a box lists every `electron/whats-new.json` entry after the old version up to this one (all of them, newest first). Fresh install: nothing. Settings from 1.4.0 or older (no `lastVersion`): every entry. Help, What's new shows this version's entry.
- **mp4-muxer** is deprecated: it's superseded by Mediabunny upstream. It works and is bundled; don't upgrade or swap it without testing exports.

## Testing

- `npm test` runs `test/smoke.cjs`: headless Edge or Chrome (playwright-core) against the built `dist/ShotRef.html`: about 260 checks, about 8 to 9 minutes. It also serves the page as `app.html` under a strict claude.ai-like content security policy.
- While working, run `npm run build` and only the checks that cover what you changed (`node test/smoke.cjs --only <name>`). Before finishing a task, run the full `npm run build && npm test` once, and `npm run test:desktop` too when you touched `src/platform.js`, `electron/` or anything that differs on the desktop. Never finish with a failing test.
- `node test/smoke.cjs --only <part of a check name>` runs single checks. To add one, append a `check('what it proves', async ({ open }) => …)` at the end; the header of the file explains the helpers.
- Browser: `SHOTREF_BROWSER`, else the system Edge, else Chrome. The test file uses LF line endings only.
- `npm run visual` (`test/visual.cjs`, about 30 s) saves 8 fixed screenshots of the built page to `dist/visual/`. After a visible change, look at them with the `visual-check` skill before calling it done.
- `node test/perf.cjs` prints performance numbers by hand. It isn't part of `npm test`.
- `npm run test:desktop` (`test/desktop.cjs`, playwright-core `_electron`, about 20 s) checks the Electron shell against the built page with stubbed native dialogs. Run `npm run build` first. Dirty apps ask before closing, so tests end them by killing the whole Electron process tree. After a run, `tasklist | grep -ci electron` should print 0.
- Ask the owner before adding another test framework.

## Where it runs: two environments, keep both working

1. **Offline file**, opened from disk in Chrome or Edge.
2. **Published artifact on claude.ai**, inside a sandboxed iframe with a strict content security policy:
   - **No `blob:` URLs** for images or fetch. Images use `data:` URLs or decode from bytes with `createImageBitmap`. See `decodeToCanvas()` and the GLB `embeddedTexturePlugin`. This rule caused a real bug before: location photos showed nothing on claude.ai.
   - **No network** of any kind.
   - **Downloads** go through `window.claude.use('downloads')` when it exists, otherwise a plain `<a download>`. See `saveFile()`, which hands over to `platform.saveBlob` in `src/platform.js`. The artifact declares the `downloads` capability.
   - **Clipboard image writes** may be refused. `copyFrame()` falls back to a dialog where the user right-clicks the image to copy it.
   - **`localStorage`** may throw. Always wrap it in try/catch.
   - **No `alert`, `confirm` or `prompt`.** Use the in-page modals (`confirmBox()`).

   To imitate this locally: run `npm run build`, copy `dist/ShotRef.html` to `sandbox/app.html`, run `python3 sandbox/serve.py sandbox`, and open http://127.0.0.1:8765/index.html.

## Architecture

- `src/main.js`: the app. The comment block at the top lists every shared module-level `let` and what changes it.
- `src/project.js`: pure. `normalizeProject(raw, defaults)` is the **only loader** for project files and autosaves: it checks, repairs and fills in missing fields. `describeChange()` names an undo step. `FORMAT_VERSION` is 2.
- `src/platform.js`: where the app runs (`web`, `claude` or `desktop`) and the file and unsaved state behind Save and Save as: `platform.kind`, `setCurrent`, `setDirty`, `saveBlob`, `pickFile`.
- `src/tour.js`: the tour engine (dimmed screen, corners, bubble). `runTour({stops, ui, interactive, onEnd, canKey, paused})` returns a handle (`end(reason)`, `next`, `back`), `tourActive()`, and `tourTick()` runs from `frame()`. Stop fields: `id`, `target`, `title`, `text`, `before`, `keep`, `corner`, `waitFor(snap)`, `snap`, `done`, `interactive`. `paused()` (main.js passes "a dialog is open"): the tour hides, ignores every key and does not measure or advance, then shows again on the same stop; opening a dialog never ends a tour.
- `src/tour-copy.js`: `TOUR_COPY`, every tour word, keyed by stop id (`basic`, `hands`, plus `ui`, `welcome`, `menu`, `helpPage`). Change wording here only.
- `src/sky.js`: import-free. Cloud constants (`COVER`, `LOOKS`, `DRIFTS`, `CLOUDS_NEW`), `cleanClouds`, `nearestCover`, `cloudLight` (the light layer clouds put over the saved light, never written back), `skyWording` and `skyPhrase` (panel line and prompt), and `makeSkyDome(THREE subset)`, the one-shader sky dome.
- `src/keys.js`: pure keyframe maths (`sampleField`, `tangent`, `setKey`, `keyIndexAt`, `neighborKey`). The frame rate is passed in; `main.js` has small wrappers.

`state` is the single source of truth: plain JSON, saved as `.shotref`, and snapshotted for undo. Three.js objects are rebuilt from it.

- **`state.settings`**: duration, fps, aspect, export size, environment and lighting, render `style`, guides, depth range; also `tod` (time of day, 5 to 20 h, drives the sun), `shadows` and `shadowSoft`.
  - `clouds {cover, look, drift, dir, soft, seed}` (`cover` 0 to 1, chips Clear/Few/Scattered/Mostly/Overcast via `nearestCover`). A file without `clouds` opens clear (cover 0); new scenes start Few. Presets set cover and look only. `cloudLight()` weakens the sun and softens shadows from the cover on the way to the renderer (`applyEnv`), so a clear sky gives back the stored light.
- **`state.camera`**:
  - `base` pose `{p, tg, f, roll, fd}` (position, aim target, focal length in mm, dutch roll, focus distance).
  - `keys[]` with the same fields plus `t`.
  - `feel` (`constant | gentle | strong`), `shake`, `lookAtId` and `follow`.
  - `mount` (an object id): the camera rides on that object, and `base` and `keys` are stored in the object's space (`setMount()` converts without moving the camera; `evalCam()` returns world space). Deleting an item frees every shot's camera that rode on it or looked at it, keeping it where it was (`keepCamerasPut()`).
  - `dof {on, fstop, auto, strength}` (strength 1 to 4.5, default 3; a file without it reads as 1, the old look, if depth of field was on in that file, otherwise 3).
- **Selection**: `selected` is the main item (an object id, `'camera'`, `'target'`, `'sun'` or `'export'` for the Export panel); `selIds` holds every selected object, and a whole group is selected at once. Always go through `select(id, mode)` (`'single'` / `'toggle'`) and `sanitizeSel()`. `obj.locked` and `obj.grp` + `state.groups[gid] = {name}` are saved fields. Drags and the turn ring move every unlocked selected item through `writeObj`, so keys land at the playhead for keyed items.
- **`state.objects[]`**: `{id, type, name, color, opts, base:{p, r(deg), s}, keys[], visible}`, plus `parent` (rides with another object; `base` and `keys` are then relative to it, `evalObj()` returns world space and `writeObj()` converts back), `opts.free` (can float above the floor), `opts.convertible` and the `cactus` type. People are `type:'person'`, with `opts.pose`, height and colours. Floor marks are `type:'mark'`; they're hidden in every shot render.
- **`state.takes[]` / `takeId`**: alternative versions of the whole scene (Take button). The take on screen is the live state (its `snap` is null); the others hold a JSON copy in `snap`. Undo steps keep those copies by reference (`snapshot()`, `snapPool`), so a step stays small and undo/redo restore exactly the right copies. Switching, new, rename and delete are undo steps. Photos or models used only by an inactive take still count as used.
- **`state.meta`** `{id, name}`: the project name and the id of its Recent projects entry.
- **`state.shots[]` / `shotId`**: several camera setups on the same scene. `state.camera` and `settings.duration` are always the active shot's; `syncShot()` copies them into `shots[]` before a save, a snapshot or a switch (`stateForSave()`). With two or more shots, a length change re-times only the camera. A project that never made a second shot has no `shots`.
- **`state.plate`**: the location photo `{asset, overlay, export, ground}`.
- **`assets`**: imported images, models and photos, stored as base64. They're saved with the project but kept out of undo snapshots.

Files and autosave:

- **Project file** (format 2): `{app:'ShotRef', version:2, state, assets}`, with only the assets the scene uses. Version 1 files still open. Only add fields, so older builds can still read new files.
- **Swapping scenes** (Open, starter sets) goes through `replaceProject()`. It keeps undo working and merges the new assets in memory, so undo brings the old photo or model back.
- **Autosave**: `localStorage` key `shotref.autosave` holds `{state, assets:{}, assetIds, v:2}`. Photos and models go to IndexedDB (database `shotref`, store `assets`, key = asset id). If IndexedDB can't be used (the claude.ai sandbox, private windows), they go inline in the autosave, with a toast when it gets too big. The record also has `dirty`. Under `window.__SHOTREF_EMBED__` the key gets a `.<embedKey>` suffix and the database is `shotref-<key>`. IndexedDB is version 2 and has a second store, `projects`, for the Recent projects list (index `updated`, the newest `keepRecent` kept; written on Save, on replacing a project, on hide and every 3 minutes, never on the edit path). Per-browser settings live in `shotref.prefs` (Settings window, folded panel sections) and My sets in `shotref.library`. An autosave that fails to load is moved to `shotref.autosave.broken`. A second open tab gets a warning. On first launch only (nothing restored, `shotref.seenHelp` unset), the `#mTour` window asks about the tours before the starter sets; the prefs `tourBasicDone` and `tourHandsDone` tick the Help menu items.

Data flow:

- **Edits:** edit `state` → `changed(commit, propsDirty)` (bumps `editRev`, the edit counter) → `syncScene()` rebuilds changed visuals → `applyAll(T)` evaluates keys at playhead `T` on the next drawn frame.
- **Playhead:** move it with `setTime(t)`, never by assigning `T`. `setTime(t, false)` skips the panel refresh, for moves made many times a second (playback, scrubbing).
- **Drawing:** ShotRef draws only when something changes. Code that changes what's on screen outside `changed()`/an input event must call `requestRender()` (async loads, timers, context restore). `frame()` compares a signature (`editRev`, `T`, view, selection, cameras, size…) and keeps drawing for 20 frames after any input.
- **Writing transforms:** `writeObj()` and `writeCam()` auto-key. If the item already has keys, a key is set at the playhead; otherwise its base pose changes. `writeObj()` takes a world pose and stores it relative to the parent, `writeCam()` relative to the mount. After an edit the ground rule settles items (`groundDirty`, `settleGround`, `migrateGround`).
- **Undo:** `pushHistory()` snapshots `state` (`commit === true`).

Main sections of `main.js`, in file order:

- **Keyframes:** `evalObj()` and `evalCam()` sample keys with `sampleField()` from `keys.js` (Hermite interpolation). Camera time passes through `camTime()` for the motion feel.
- **Rendering:**
  - Three views: `editor` (perspective orbit), `top` (orthographic plan view) and `camera` (the shot).
  - The sky is a world-anchored dome (`skyDome`, drawn at the far plane, rotation only), shown in the editor and in shaded shot renders. `withShotStyle()` and `draw` hide it in the top view, in clay, depth and normal styles and under the location photo (those keep the flat `skyTex` gradient, which is also the fog colour). Drift follows shot time (`applyAll` calls `skyDome.setTime`), so a frame always shows the same clouds. The depth of field pass tone-maps the dome like the old gradient. Studio has no sun glow (`glow` 0).
  - Shot renders always go through `withShotStyle()`. It hides helpers and marks, and applies the clay, depth or normal override, the location photo and the ground mode. `shotPass()` adds the depth-of-field post pass.
- **People:**
  - `buildPerson()` makes a primitive mannequin.
  - `POSES` holds the pose functions.
  - `posePerson()` applies a pose and keeps the feet on the ground.
  - `personMotion()` handles facing the travel direction and stride sync, so feet don't slide.
  - Body types: `opts.body` (`man|woman|child`, `BODIES`/`BODY_SHAPE`). Eyeline: `opts.lookAt` (`'camera'` or an object id), applied last in `posePerson()` so it never moves the feet. Seats: `SEATS` for chair, sofa and bed; `opts.seated` is the seat owner's id; `sitPerson()`/`standPerson()`. Pose changes over time: `obj.acts[] = {t, pose, at?}` read through `actLayer()` (blends over `ACT_BLEND`); `setPoseAt()` adds one, blue tags on the timeline retime or remove them.
- **Interaction:** pointer handling lives in `wire()`. Right-click menus use the same `#ctxMenu` as the dropdowns (`showMenu()`). Also: double-click on the picture sets the lens focus, multi-select and box select, groups and lock with the selection toolbar, the turn ring releasing to face, draggable camera path points, the sun and the lift arrow, and split view routing by pane. It covers click to place (`placing`), drawing paths (`pathMode`), dragging on the floor, the turn ring, focus picking, and live camera recording (`rec`).
- **Panels:** `propsScene()`, `propsCamera()` (with its tabs Shot, Move, Lens, Photo, Output), `propsObject()`, `propsMulti()`, `propsSun()` and `propsExport()` rebuild the right-hand panel when `propsDirty` is set. Use the small builders `numField`, `slider`, `selectRow`, `check` and `sec`. `decorateSections()` then folds every `p.note` into a "?" on the section heading and makes headings collapse (remembered in `prefs.closedSecs`), so write notes as `p.note` inside the section.
- **Tours:** the hands-on tour is switched off for now (`handsTourOn()`, hidden pref `handsTour`, `HANDS_TOUR_DEFAULT`; `HANDS_TOUR` in electron/main.cjs): its entry points are hidden and copy uses `bodySolo`/`textSolo`; tests turn it on with `__shotref.setHandsTour(true)`. `startTour(kind, opts)` (`'basic'` or `'hands'`) is the only entry point (first-run `#mTour` window, Help menu items, desktop `tour-basic`/`tour-hands`, Quick start page). `BASIC_STOPS` (10, look only) and `handsStops()` (16 stops, built per run, each "try" stop waits for a real UI change). The hands-on tour runs on an empty practice stage:
  - `enterPractice()` sets the user's scene aside in `practicing`; `leavePractice()` brings it back exactly (safe to call twice).
  - `enterPractice()` refuses until boot has loaded the stored photos and models (`autosaveReady`); a load that lands during practice goes into the set-aside real assets.
  - While `practicing` is set nothing is written: autosave, Recent projects, the unsaved mark and window title (`platform.hold`). A reload reopens the real scene's last autosave.
  - Every action that touches the real scene (Open, New, Save, a dropped file, an export, closing the desktop window...) must go through `endPracticeFirst(go)`, which ends the tour and practice, then runs `go`.
- **Export:**
  - MP4 goes through WebCodecs and mp4-muxer, rendered offline frame by frame. It falls back to real-time WebM.
  - The page is locked (`inert`) while an export runs. Errors show a plain message; detail goes to `console.error`. A lost graphics context is recovered.
  - The Export panel (step 3), the frame pack zip (start, middle and end frames plus the prompt), the contact sheet, every shot, PNG frames, and the prompt writer (`currentPrompt()`). Frame pack and contact sheet run under `whileLocked()`.
  - Copy frame to the clipboard.

`window.__shotref` exposes hooks for the smoke test: state, setT, project, evalObj, evalCam, history, rebuilds, renderStats(), _exportCanvas()…

## Conventions

- Units are metres and degrees. +Y is up, and characters face +Z.
- Camera lens maths uses a 36 mm (full-frame) sensor across the frame's long side, via `filmGauge = 36`.
- UI text: plain English and sentence case. Use the real terms an operator knows (dolly, truck, rack focus) with short notes.
- After a change, rebuild and run the matching checks; run the full `npm test` (and `npm run test:desktop` for desktop changes) before finishing. For visible changes, also check the page in Chrome: the camera view and an export too.

## Design rules

- Subtract first: if removing a control breaks nothing, remove it or move it behind Advanced mode. A new panel should make sense to a first-time user in about 3 seconds.
- Design every state: empty (no objects, keys or shots), loading, error and over-long text, not just the full panel.
- The scene and camera view are the star: secondary controls stay quiet and come forward on hover, selection or when relevant.
- One cue, one meaning: a colour or icon always means the same thing, and nothing that can't be clicked gets a hover effect.
- About three text sizes (heading, label, note); don't add in-between sizes. Choosing the right word is part of the design.
- Motion or flourish only when it tells the user something (a key was set, an export finished), never just for decoration.

## Ideas discussed but not built yet

- Photo to scene: send a photo to Claude, using the artifact's `sample` capability with images, to recreate the people, props and camera match.
- OpenPose-style skeleton and line-art render styles.
- An audio track for timing.
- Wardrobe presets (body types are done).
