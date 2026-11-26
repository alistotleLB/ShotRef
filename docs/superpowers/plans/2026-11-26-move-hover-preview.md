# Camera move hover previews: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hovering or focusing a Camera moves button shows a small looping preview of that move on the user's own shot, or on a demo scene when nothing is in frame.

**Architecture:** `applyMove` is split into a pure `planMove` and the writer. A single `#movePeek` popover holds a 2D canvas. While it's open, the end of `frame()` renders the shot with the planned camera into an offscreen render target on the main renderer, reads the pixels back into the canvas, then restores the scene to the playhead.

**Tech stack:** Plain JS in `src/main.js`, three.js, CSS in `src/index.html`, smoke tests in `test/smoke.cjs` (playwright-core).

**Spec:** `docs/superpowers/specs/2026-11-26-move-hover-preview-design.md`

## Global constraints
- It's one offline HTML file: no network, no `blob:` URLs, no `alert`/`confirm`/`prompt`, and `localStorage` stays in try/catch.
- A preview never changes `state`, `editRev`, the undo history (`hist`), the unsaved mark or autosave.
- It draws only while the popover is open. `frame()` must not keep redrawing the main view because of it.
- It's off while `exporting`, `playing`, `rec` or `pilotActive` is set, and while a tour is active.
- UI copy is plain English and sentence case. Use the existing three text sizes and colour tokens.
- `test/smoke.cjs` uses LF line endings only.

## Review focus
1. **The shot has a mount or a look-at subject:** the preview must match what clicking does (same `evalCam` path). Test: a person as look-at subject, `orbitL` preview; the camera position after clicking equals the preview's end pose.
2. **Strength at 0.25 and 2.5:** the end pose differs and nothing throws. Covered by the `planMove` test with `amt` 2.5.
3. **The panel rebuilds or the tab changes while hovering** (`propsDirty`): the popover must close, not stay orphaned. Test: hover, then `changed(true, true)`; `#movePeek` is hidden.
4. **Lost WebGL context or a zero-size render target:** the preview fails quietly (hidden, `console.error`) and never breaks the main draw.
5. **The button sits near the bottom of the window:** the popover stays fully on screen (clamped).

---

### Task 1: Pure `planMove`

**Files:**
- Modify: `src/main.js:1917-1962` (`applyMove`)
- Modify: `src/main.js` `window.__shotref` (add `planMove`)
- Test: `test/smoke.cjs` (append)

**Interfaces:**
- Produces: `planMove(kind: string, amt: number, from?: {p,tg,f,roll,fd}) -> {base: CamKey, keys: Array<CamKey & {t}>} | null`. It returns `null` for `'static'`. When `from` is given, it's used as the start pose in world space with no subject, follow or mount, and key times span `0..lastT()` as they do today. It reads `state` but never writes it.
- `applyMove(kind)` keeps its exact current behaviour: it calls `planMove(kind, moveAmt)` and then writes `c.keys`, `c.base`, `setTime(0)`, `changed(true, true)` and the toast. The `static` path is unchanged.

- [ ] **Step 1: Write the failing test** `check('planMove is pure and matches applyMove', …)`: add a person, set `lookAtId` to it, then for each of `['dollyIn','orbitL','panR','arcPush','dollyZoom']` with `moveAmt` 1 and 2.5 (set it through `S.planMove(k, amt)` directly): record `JSON.stringify(S.state)` and `S.history` length, call `planMove`, and assert both are unchanged. Then set `moveAmt` via applyMove's default (1), call `applyMove(k)`, and assert `state.camera.keys` deep-equals `planMove(k, 1)` computed **before** the apply (undo first between kinds). Also assert `planMove('static', 1) === null`.
- [ ] **Step 2: Run it and see it fail:** `npm run build && node test/smoke.cjs --only planMove`. Expected: FAIL, `planMove is not a function`.
- [ ] **Step 3: Implement** `planMove` by moving the maths out of `applyMove`, and expose it on `window.__shotref`.
- [ ] **Step 4: Run it and see it pass:** `npm run build && node test/smoke.cjs --only planMove` and `--only "camera move adds keys"`. Expected: PASS.
- [ ] **Step 5: Commit** `refactor: split planMove out of applyMove`.

### Task 2: Hover preview popover

**Files:**
- Modify: `src/main.js` (move grid buttons around line 2440, a new `movePeek` section after `applyMove`, a hook at the end of `frame()`)
- Modify: `src/index.html` (`#movePeek` element and CSS next to `.movegrid`)
- Test: `test/smoke.cjs` (append)

**Interfaces:**
- Consumes: `planMove` (Task 1), `applyAll`, `prepRenderCam`, `placeSun`, `withShotStyle`, `renderer`, `scene`, `renderCam`, `FEEL`, `sampleField`, `arOf`, `lastT`, `views`.
- Produces: `peekShow(kind: string, btn: HTMLElement)`, `peekHide()`, `peekTick(now: number)`, and `window.__shotref.peek() -> {open: boolean, kind: string|null, demo: boolean, frames: number}` for tests.

Behaviour (values pinned by the spec):
- Each move button gets `pointerenter` and `focus` handlers that call `peekShow` after **150 ms**, and `pointerleave`, `blur` and `click` handlers that call `peekHide`. Remove the button's `title` so the native tooltip doesn't cover the popover. `renderProps()` and `setView` call `peekHide()`.
- Popover: a fixed-position `#movePeek`, **220 px** wide canvas at the shot aspect (`arOf(state.settings.aspect)`), device-pixel sized. The move name is a label under it. When the demo is used, a note says *"Example. Add people or props to preview it on your shot."* It sits to the left of the right-hand panel, its vertical centre level with the button, clamped to the window with an 8 px margin. Use `pointer-events:none`, the panel surface colour, a border and a radius matching existing popovers. It's hidden with `display:none`.
- Loop: **2.5 s** move plus **0.4 s** hold at each end (3.3 s total). Shot time `t = u * lastT()`, where `u` comes from the loop phase. Throttle to about 30 fps.
- Own shot: in `peekTick`, save `state.camera.keys/base`, swap in the plan, then `applyAll(t)`, `prepRenderCam(t)` and `placeSun()`. Render `withShotStyle(state.settings.style, …)` into a reusable `WebGLRenderTarget` sized to the canvas (no depth-of-field pass), then use `readRenderTargetPixels` and `putImageData` flipped vertically. In `finally`: restore the keys and base, `setRenderTarget(null)`, `applyAll(T)`, `prepRenderCam(T)`. Don't touch `editRev`.
- Demo fallback when the scene has no non-mark visible objects, or when no such object's bounding box (`Box3.setFromObject(views.get(id).group)`) projects inside the frame at the plan's start **and** at its end (a move that ends looking away from the subject still uses the real shot). Demo: a separate `THREE.Scene` built once: a floor grid, `buildPerson(makeObject('person', [0,0,0]))` posed standing, two boxes at (-1.5,0.5,-1.5) and (1.6,0.4,-2.5), a hemisphere light and a directional light. It has its own `PerspectiveCamera` evaluated from `planMove(kind, moveAmt, {p:[0,1.6,5], tg:[0,1.1,0], f:35, roll:0, fd:5})`, using `sampleField` plus `FEEL[state.camera.feel]`, and is rendered with `renderer.render(demoScene, demoCam)` into the same target.
- No preview while `exporting`, `playing`, `rec`, `pilotActive` or `tourActive()`: `peekShow` does nothing and `peekTick` hides it.
- Errors: wrap the tick in try/catch. On failure, `console.error` once and hide.

- [ ] **Step 1: Write the failing tests:**
  - `check('move preview: hover shows a moving picture and leaves the scene untouched', …)`: add a person and select the camera Move tab. Hover the "Orbit left" button with the real mouse (`page.hover`). Wait for `peek().open && peek().frames > 10`. Assert `peek().demo === false`. Sample two canvas data URLs 500 ms apart and assert they differ. Assert `JSON.stringify(state)`, `history.length` and `docInfo().dirty` are unchanged. Move the mouse away and assert `peek().open === false`, then that `peek().frames` stops growing within 300 ms.
  - `check('move preview: empty scene shows the example', …)`: with an empty scene, hover "Dolly in", wait until open, assert `peek().demo === true` and the note text is visible.
  - `check('move preview: closes on panel rebuild and stays on screen', …)`: hover the last move button and assert `#movePeek`'s bounding box is inside the viewport. Call `changed(true, true)` and assert it's hidden.
  - `check('move preview: matches the click with a look-at subject', …)`: person as `lookAtId`, hover `orbitL`, read the preview's end pose through `peek().endPose` (add `endPose` to the hook: the `evalCam(lastT())` with the plan swapped in), click, and assert `evalCam(lastT()).p` is within 1e-3.
- [ ] **Step 2: Run them and see them fail:** `npm run build && node test/smoke.cjs --only "move preview"`. Expected: FAIL, `peek is not a function`.
- [ ] **Step 3: Implement** the popover, the tick and the demo as described above.
- [ ] **Step 4: Run them and see them pass:** `npm run build && node test/smoke.cjs --only "move preview"` and `--only planMove`. Expected: PASS. Also open `dist/ShotRef.html` under the CSP (`--only` checks already cover `app.html` when it's used, or add the hover check to run on `app.html`).
- [ ] **Step 5: Commit** `feat: animated preview when hovering a camera move`.
