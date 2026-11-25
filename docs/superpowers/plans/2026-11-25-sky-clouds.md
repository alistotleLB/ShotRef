# Sky and clouds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ShotRef's screen-fixed gradient with a world-anchored sky dome that draws clouds, a sun glow and drift, couples cloud cover to the light, and names the sky in the prompt.

**Architecture:** A new module `src/sky.js` owns the dome (a `ShaderMaterial` sphere drawn at the far plane) and the pure helpers (cover presets, light modifiers, wording). `main.js` creates the dome once, feeds it uniforms from `applyEnv()` and `applyAll(t)`, hides it where the gradient never belonged, and builds the "Sky" panel section. `project.js` repairs `settings.clouds` on load.

**Tech Stack:** three.js (bundled), plain ES modules, esbuild via `build.mjs`, playwright-core smoke tests in `test/smoke.cjs`.

**Spec:** `docs/superpowers/specs/2026-11-25-sky-clouds-design.md`

## Global Constraints

- One offline HTML file: no network, no image files, no `blob:` URLs, no CDN. Shader and swatches are code and CSS only.
- No `alert`/`confirm`/`prompt`; `localStorage` wrapped in try/catch (not expected to be touched here).
- UI copy: plain English, sentence case, operator terms. Simple mode stays short; fine controls go behind `!simple` (Advanced mode).
- Project files: only add fields. A file without `settings.clouds` opens with `cover: 0` and an unchanged prompt.
- Light coupling formulas, verbatim: sun = `sunInt × (1 − 0.8c²)`, ambient = `ambInt + 0.6c²`, softness = `min(1, shadowSoft + 0.7c)`. Stored settings are never rewritten by the coupling.
- Cover chip values: Clear 0 · Few 0.2 · Scattered 0.42 · Mostly cloudy 0.68 · Overcast 1.
- Determinism: shader output depends only on uniforms (seed, time, settings, camera). `Math.random` only when the user presses Shuffle.
- `test/smoke.cjs` uses LF line endings. New checks are appended at the end of the file.
- After each task: `npm run build` then `node test/smoke.cjs --only sky`. Full `npm test` (≈9 min) after Task 2 and Task 6. Never finish with a failing test.
- Commit only on the feature branch the executor creates (see "Before you start").

## Review Focus

1. **Old projects and starter sets:** a file without `clouds` must look and prompt as before (cover 0); existing pixel-based smoke checks must still pass. → Task 1 test `sky: old file opens clear` and Task 5 test `sky: clear keeps the old prompt`.
2. **Depth of field:** the dome must read as "far background" in the DOF pass, not as a near surface that blurs wrong. → Task 2 test `sky: dof render has no NaN or black sky`.
3. **Location photo and render styles:** clouds must never appear over the photo or in clay/depth/normal. → Task 2 test `sky: hidden in depth, clay and over the photo`.
4. **Scrubbing and export agree:** the same `t` gives the same pixels whether reached by playback or by an export. → Task 2 test `sky: same frame, same clouds`.
5. **Undo:** a cloud change is one undo step with a readable name, and undo restores the light exactly. → Task 1 test `sky: undo names and restores clouds`.

## Before you start

The working tree has uncommitted 1.5.x changes in 10 files. The owner must commit or set them aside before work begins; then create branch `feature/sky-clouds` from `main` (use superpowers:using-git-worktrees if working in a worktree).

## Orchestration (who does what)

The controller is the main session on **Opus**, running superpowers:subagent-driven-development. Each task goes to a fresh implementer subagent; after each task a reviewer subagent checks it against this plan before the next one starts.

| Task | Implementer | Effort | Why | Reviewer |
|---|---|---|---|---|
| 1 State, loader, undo name | Sonnet | medium | Mechanical, fully pinned by tests | Sonnet, low |
| 2 Sky dome and shader | **Opus** | high | Shader maths, render-pass integration, DOF and style edge cases | **Opus**, medium |
| 3 Light coupling and presets | Sonnet | medium | Formulas pinned verbatim | Sonnet, low |
| 4 Sky panel (UI/UX) | **Opus** | medium | UX judgement; loads `frontend-design:frontend-design` first | **Opus**, medium |
| 5 Prompt wording | Sonnet | low | Small, string-level | Sonnet, low |
| 6 Docs and visual QA | Controller (Opus) + `run` skill | medium | Needs eyes on real renders in the built-in browser | — |
| Final | `code-review` skill on the branch | high | One independent look at the whole change | Opus |

Tasks 1 → 2 → 3 → 4 → 5 run in order (each consumes the previous Interfaces). Task 5 may run in parallel with Task 4 (different functions, both in `main.js`, non-overlapping regions) only if the controller is confident the edits won't collide; default is sequential. Finish with superpowers:verification-before-completion and superpowers:finishing-a-development-branch.

---

### Task 1: Cloud settings, loader and undo name

**Files:**
- Create: `src/sky.js` (constants only in this task)
- Modify: `src/main.js:146-150` (`DEFAULT_SETTINGS`), `src/main.js:3897-3900` (`SETTING_ENUMS` unchanged unless needed), `__shotref` hooks (~line 5825)
- Modify: `src/project.js:169-175` (sun and shadows block), `src/project.js:243-249` (`describeChange`)
- Test: `test/smoke.cjs` (append)

**Interfaces:**
- Produces (in `src/sky.js`):
  - `export const COVER = [['clear', 0, 'Clear'], ['few', 0.2, 'Few'], ['scattered', 0.42, 'Scattered'], ['mostly', 0.68, 'Mostly cloudy'], ['overcast', 1, 'Overcast']]`
  - `export const LOOKS = [['fluffy', 'Fluffy'], ['wispy', 'Wispy'], ['flat', 'Flat layer']]`
  - `export const DRIFTS = [['still', 'Still'], ['slow', 'Slow'], ['breezy', 'Breezy'], ['fast', 'Fast']]`
  - `export const CLOUDS_NEW = { cover: 0.2, look: 'fluffy', drift: 'slow', dir: 90, soft: 0.5, seed: 1 }` (new scenes)
  - `export const CLOUDS_NONE = { ...CLOUDS_NEW, cover: 0 }` (files without clouds)
  - `export function nearestCover(cover: number): 'clear'|'few'|'scattered'|'mostly'|'overcast'` — the `COVER` key closest to a stored value (used by the panel's active chip and the prompt).
  - `export function cleanClouds(raw: any): Clouds` — returns a repaired copy: `cover` clamped 0..1, `soft` 0..1, `dir` wrapped 0..360, `seed` integer 1..9999, `look`/`drift` in their lists; missing or bad input → `CLOUDS_NONE` values field by field.
- `src/sky.js` imports nothing (no three at the top level), so the pure `project.js` can import `cleanClouds` from it. The dome factory in Task 2 receives `THREE` as a parameter.
- `describeChange` returns `'clouds'` when only `settings.clouds` differs.
- New test hooks on `window.__shotref` (`src/main.js:5825`): `normalize: raw => normalizeProject(raw, projectDefaults())`, `describeChange` (imported from `project.js`), `setClouds(patch)`.
- Existing hooks the tests use: `__shotref.state` is a **getter** (no parentheses); `__shotref.history.length`; undo is `p.keyboard.press('Control+z')` as existing checks do (`test/smoke.cjs:289`).

- [ ] **Step 1: Write the failing tests** (append to `test/smoke.cjs`)

```js
check('sky: old file opens clear', async ({ open }) => {
  const p = await open();
  const c = await p.evaluate(() => { const st = JSON.parse(JSON.stringify(__shotref.state)); delete st.settings.clouds; return __shotref.normalize({ app: 'ShotRef', version: 2, state: st }).state.settings.clouds; });
  if (c.cover !== 0) throw new Error('old file should open with cover 0, got ' + c.cover);
});
check('sky: new scene has few clouds', async ({ open }) => {
  const p = await open();
  const c = await p.evaluate(() => __shotref.state.settings.clouds);
  if (c.cover !== 0.2 || c.look !== 'fluffy' || c.drift !== 'slow') throw new Error(JSON.stringify(c));
});
check('sky: bad clouds are repaired', async ({ open }) => {
  const p = await open();
  const c = await p.evaluate(() => { const st = JSON.parse(JSON.stringify(__shotref.state)); st.settings.clouds = { cover: 7, look: 'x', drift: null, dir: -30, seed: 2.5 }; return __shotref.normalize({ app: 'ShotRef', version: 2, state: st }).state.settings.clouds; });
  if (c.cover !== 1 || c.look !== 'fluffy' || c.drift !== 'slow' || c.dir !== 330 || !Number.isInteger(c.seed)) throw new Error(JSON.stringify(c));
});
check('sky: undo names and restores clouds', async ({ open }) => {
  const p = await open();
  const r0 = await p.evaluate(() => { const a = JSON.stringify(__shotref.state), before = __shotref.state.settings.clouds.cover, h = __shotref.history.length; __shotref.setClouds({ cover: 0.68 }); return { name: __shotref.describeChange(a, JSON.stringify(__shotref.state)), before, steps: __shotref.history.length - h }; });
  await p.keyboard.press('Control+z');
  const after = await p.evaluate(() => __shotref.state.settings.clouds.cover);
  if (r0.name !== 'clouds' || r0.steps !== 1 || after !== r0.before) throw new Error(JSON.stringify({ ...r0, after }));
});
```

- [ ] **Step 2:** `npm run build && node test/smoke.cjs --only "sky:"` → the four checks FAIL.
- [ ] **Step 3:** Implement `src/sky.js` constants and `cleanClouds`; add `clouds: { ...CLOUDS_NEW }` to `DEFAULT_SETTINGS`; in `normalizeProject` set `ss.clouds = cleanClouds(isObj(src.settings) ? src.settings.clouds : undefined)` (read from the raw file, like `shadowSoft`, so the defaults don't fill in Few); add the `'clouds'` branch to `describeChange` before the `sun` test and add `'clouds'` to its excluded-keys list; add the three hooks. `setClouds(patch)` writes `state.settings.clouds = cleanClouds({ ...state.settings.clouds, ...patch })`, then `applyEnv()` and `changed(true, true)`.
- [ ] **Step 4:** Rebuild, rerun → PASS.
- [ ] **Step 5:** Commit `feat(sky): cloud settings, loader and undo name`.

---

### Task 2: Sky dome and cloud shader

**Files:**
- Modify: `src/sky.js` (add the dome factory)
- Modify: `src/main.js:649-672` (`skyTexture`, `applyEnv`), `src/main.js:1284` (`applyAll`), `src/main.js:1735-1754` (`withShotStyle`), `src/main.js:1780-1789` (`draw`, top view), `__shotref` hooks
- Test: `test/smoke.cjs` (append)

**Interfaces:**
- Consumes: `cleanClouds`, `COVER`, `LOOKS`, `DRIFTS` from Task 1.
- Produces:
  - `export function makeSkyDome(THREE): { mesh: THREE.Mesh, update(opts: SkyOpts): void, setTime(t: number): void }`
  - `SkyOpts = { sky: string /* hex */, clouds: Clouds, sunDir: THREE.Vector3 /* unit, world */, sunColor: string, night: boolean }`
  - In `main.js`: `const skyDome = makeSkyDome(THREE)`, added to `scene`; `skyDome.mesh.visible` is the single switch for "sky shows".
  - Hook `__shotref.sky()` → `{ visible: boolean, cover: number, time: number }` reading the live uniforms.

- [ ] **Step 1: Write the failing tests**

```js
check('sky: same frame, same clouds', async ({ open }) => {
  const p = await open();
  const same = await p.evaluate(() => { __shotref.setClouds({ cover: 0.68, drift: 'fast' }); const a = __shotref.shotPixels(2.0); __shotref.setT(0); __shotref.setT(4); const b = __shotref.shotPixels(2.0); return a.every((v, i) => v === b[i]); });
  if (!same) throw new Error('two renders of t=2 differ');
});
check('sky: clouds drift over time', async ({ open }) => {
  const p = await open();
  const diff = await p.evaluate(() => { __shotref.setClouds({ cover: 0.68, drift: 'fast' }); const a = __shotref.shotPixels(0), b = __shotref.shotPixels(4); let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 8) n++; return n; });
  if (diff < 50) throw new Error('clouds did not move, changed pixels: ' + diff);
});
check('sky: still clouds do not move', async ({ open }) => {
  const p = await open();
  const same = await p.evaluate(() => { __shotref.setClouds({ cover: 0.68, drift: 'still' }); const a = __shotref.shotPixels(0), b = __shotref.shotPixels(4); return a.every((v, i) => v === b[i]); });
  if (!same) throw new Error('still clouds changed between t=0 and t=4');
});
check('sky: hidden in depth, clay and over the photo', async ({ open }) => {
  const p = await open();
  /* compare the top row only: it is pure background in these styles (clay's lit surfaces change with the light coupling of Task 3, by design) */
  const r = await p.evaluate(() => { const s = __shotref.state.settings, row = d => Array.from(d.slice(0, 240 * 4)); const out = {}; for (const st of ['depth', 'clay', 'normal']) { s.style = st; __shotref.setClouds({ cover: 0 }); const a = row(__shotref.shotPixels(1)); __shotref.setClouds({ cover: 1 }); const b = row(__shotref.shotPixels(1)); out[st] = a.every((v, i) => v === b[i]); } s.style = 'shaded'; return out; });
  if (!r.depth || !r.clay || !r.normal) throw new Error('cover changed a style background: ' + JSON.stringify(r));
});
check('sky: dof render has no NaN or black sky', async ({ open }) => {
  const p = await open();
  const dark = await p.evaluate(() => { __shotref.setClouds({ cover: 0.42 }); __shotref.state.camera.dof = { on: true, fstop: 1.4, auto: true, strength: 3 }; const d = __shotref.shotPixels(1); let n = 0; const w = 240; for (let x = 0; x < w; x++) { const i = x * 4; if (d[i] + d[i + 1] + d[i + 2] < 30) n++; } return n; });
  if (dark > 24) throw new Error('top row of the DOF render is black in ' + dark + ' pixels');
});
check('sky: top view hides the dome', async ({ open }) => {
  const p = await open();
  const v = await p.evaluate(async () => { __shotref.setView('top'); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return __shotref.sky().visible; });
  if (v) throw new Error('dome visible in the top view');
});
```

```js
check('sky: hidden behind the location photo', async ({ open, fixtures }) => {
  const p = await open();
  await p.setInputFiles('#fPlate', path.join(fixtures, 'location.jpg'));
  await p.waitForFunction(() => window.__shotref.state.plate && window.__shotref.state.plate.asset);
  await p.waitForFunction(() => { const i = document.querySelector('.plateImg'); return i && i.getAttribute('src'); });
  /* top third only: pure photo there; lower down the shadow catcher reacts to the light coupling of Task 3 */
  const same = await p.evaluate(() => { const top = d => Array.from(d.slice(0, Math.floor(d.length / 3))); __shotref.setClouds({ cover: 0 }); const a = top(__shotref.shotPixels(1)); __shotref.setClouds({ cover: 1 }); const b = top(__shotref.shotPixels(1)); return a.every((v, i) => v === b[i]); });
  if (!same) throw new Error('clouds showed over the location photo');
});
```

- [ ] **Step 2:** Build and run `--only "sky:"` → the new checks FAIL.
- [ ] **Step 3: Implement `makeSkyDome(THREE)`** in `src/sky.js`.
  - Geometry: `SphereGeometry(1, 32, 16)`. Vertex shader: `vDir = position; vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0); gl_Position = p.xyww;` (rotation only, then forced to the far plane), so the dome ignores camera position, never clips, and reads as background depth in the DOF pass. `side: BackSide`, `depthWrite: false`, `depthTest: true`, `fog: false`, `frustumCulled: false`, `renderOrder: -1`.
  - Gradient: top = sky × 0.72, middle (elevation ≈ 0.38 of the way up) = sky, horizon = sky lerped 0.32 to white. Below the horizon: horizon colour.
  - Clouds: for view direction `d` with `d.y > 0`, plane coords `uv = d.xz / (d.y + 0.08) * scale + driftOffset + seedOffset`; density = fbm (value noise, 5 octaves); coverage `smoothstep(1 − cover − soft·0.25, 1 − cover + soft·0.25, density)`; `wispy` stretches `uv` 4× along the drift direction and thins density; `flat` uses `mix(0.85, 1.0, fbm)` × `smoothstep(0, 0.15, cover)` as a near-continuous sheet. Fade clouds by `smoothstep(0.0, 0.18, d.y)` toward the horizon.
  - Cloud colour: lit = mix(white, sunColor, 0.35); shade = sky × 0.75 (night: `#2a3142`); blend by a cheap lighting term from density gradient toward `sunDir`.
  - Sun glow: `disc = smoothstep(0.9995, 0.9999, dot(d, sunDir))`, `halo = pow(max(dot(d, sunDir), 0), 12) × 0.35`, both × (1 − cloudAlpha × 0.9); disc off when `sunDir.y < −0.02`.
  - `setTime(t)`: `uTime = t`; drift offset = `dirVec × DRIFT_SPEED[drift] × t` with `DRIFT_SPEED = { still: 0, slow: s1, breezy: s2, fast: s3 }` tuned so Slow is barely visible over 5 s at 35 mm and Fast is obvious. Seed → constant offset `vec2(seed × 17.13, seed × 9.71)`.
- [ ] **Step 4: Wire it in `main.js`.**
  - `applyEnv()`: keep `skyTexture()` for the fog colour only; set `scene.background = null` in shaded style (the dome covers the frame) and call `skyDome.update({...})` with the sun direction from `sunAz`/`sunEl`.
  - `applyAll(t)`: call `skyDome.setTime(t)` (export frames already pass through `applyAll(t)` in `renderExportFrame`).
  - `withShotStyle()`: save `skyDome.mesh.visible`; set false for clay/depth/normal and when `usePlate`; restore in `finally`.
  - `draw()`: hide the dome while rendering `topCam`, restore after.
  - Hook `__shotref.sky()`.
- [ ] **Step 5:** Build, `--only "sky:"` → PASS. Then full `npm test` → all pass (existing pixel checks may need their expected sky tolerance adjusted only if they test the gradient; never loosen unrelated checks).
- [ ] **Step 6:** `node test/perf.cjs` before/after; note frame times in the commit message. A drop over 15% on the default scene means reduce octaves to 4.
- [ ] **Step 7:** Commit `feat(sky): world-anchored sky dome with clouds and sun glow`.

---

### Task 3: Light coupling and environment presets

**Files:**
- Modify: `src/sky.js` (add `cloudLight`), `src/main.js:140-144` (`ENV`), `src/main.js:661-672` (`applyEnv`), the two preset-click handlers at `src/main.js:2207` and `:2336`
- Test: `test/smoke.cjs`

**Interfaces:**
- Produces: `export function cloudLight(s: Settings): { sunInt: number, ambInt: number, shadowSoft: number }` — the effective values from the Global Constraints formulas, `c = s.clouds.cover`.
- `ENV` entries gain `clouds: { cover, look }`: studio `{0,'fluffy'}`, day `{0.2,'fluffy'}`, overcast `{1,'flat'}` with `sunInt: 2.75, ambInt: 1.1`, sunset `{0.42,'fluffy'}`, night `{0.2,'fluffy'}`. The preset click merges `clouds` into `s.clouds` (keeping drift, dir, seed) instead of replacing it.

- [ ] **Step 1: Tests**

```js
check('sky: clear gives back the stored light', async ({ open }) => {
  const p = await open();
  const r = await p.evaluate(() => { const s = __shotref.state.settings; __shotref.setClouds({ cover: 1 }); __shotref.setClouds({ cover: 0 }); const L = __shotref.lights(); return { sun: L.sun, amb: L.amb, sSun: s.sunInt, sAmb: s.ambInt }; });
  if (Math.abs(r.sun - r.sSun) > 1e-6 || Math.abs(r.amb - r.sAmb) > 1e-6) throw new Error(JSON.stringify(r));
});
check('sky: overcast preset matches the old overcast light', async ({ open }) => {
  const p = await open();
  const L = await p.evaluate(() => { __shotref.pickEnv('overcast'); return __shotref.lights(); });
  if (Math.abs(L.sun - 0.55) > 0.01 || Math.abs(L.amb - 1.7) > 0.01) throw new Error(JSON.stringify(L));
});
check('sky: cover softens without saving', async ({ open }) => {
  const p = await open();
  const r = await p.evaluate(() => { const s = __shotref.state.settings, before = s.sunInt; __shotref.setClouds({ cover: 0.68 }); return { before, after: s.sunInt, live: __shotref.lights().sun }; });
  if (r.before !== r.after || !(r.live < r.before)) throw new Error(JSON.stringify(r));
});
```

Add hooks `lights()` → `{ sun: sun.intensity, amb: hemi.intensity, radius: sun.shadow.radius }` and `pickEnv(key)` (the same function the chips call; extract it as `pickEnv(k)` in `main.js` so both chip rows use it).

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `cloudLight`; `applyEnv()` uses it for `sun.intensity`, `hemi.intensity` and the shadow radius; update `ENV` and extract `pickEnv(k)`.
- [ ] **Step 4:** Run → PASS. Commit `feat(sky): clouds soften the light; presets set clouds`.

---

### Task 4: The Sky panel section (UI/UX)

Load `frontend-design:frontend-design` before starting; follow the existing panel look (`sec`, `chips`, `stylechips` with `.sw` swatches, `slider`, `p.note`), not a new style.

**Files:**
- Modify: `src/main.js` (`propsScene` ~2203, `propsSun` ~2332, new `skySection(adv)` next to `sunSection`), `src/index.html` (CSS for the cover swatches only)
- Test: `test/smoke.cjs`

**Interfaces:**
- Consumes: `COVER`, `LOOKS`, `DRIFTS`, `cleanClouds` (Task 1), `pickEnv` (Task 3).
- Produces: `function skySection(adv: boolean): HTMLElement`, and `export function skyWording(clouds: Clouds, settings): string` in `src/sky.js` (e.g. "Partly cloudy · soft shadows", "Overcast · no hard shadows", "Clear sky"), shown live under the chips.

**UX rules (decided):**
- Section title "Sky", placed directly under the Environment chips in both the Scene panel and the Sun panel. In Advanced mode the existing "Sky & ground" colour/fog controls move inside this section, below the cloud controls, so there is one sky section, not two.
- Row 1, always shown: **Clouds** chips Clear · Few · Scattered · Mostly cloudy · Overcast, each with a 28×18 CSS swatch (gradient plus 0–4 white radial blobs) so the choice is visual. The active chip is the nearest `COVER` value to the stored cover.
- Rows shown only when cover > 0 (progressive disclosure): **Look** chips; **Drift** chips; a "Shuffle clouds" button (title: "Try a different arrangement of clouds") that sets a new `seed` from `Math.random`; a live one-line note from `skyWording()`.
- Advanced only: **Amount** slider (0–100%), **Edges** slider (crisp ↔ soft, maps to `soft`), **Drift direction** slider (0–360°, hidden when drift is Still).
- Sliders preview live while dragging and make one undo step on release (`slider` already does this via the `c` flag).
- A `p.note` (folded into the "?" by `decorateSections`): "Clouds also soften the sun. Drift moves them during the shot; set Still for a frozen sky."
- No more than 4 visible rows in Simple mode.

- [ ] **Step 1: Tests**

```js
check('sky: panel shows cloud chips and hides extras on clear', async ({ open }) => {
  const p = await open();
  const sky = p.locator('#props .sec').filter({ has: p.locator('h3', { hasText: /^Sky$/ }) });
  await sky.getByRole('button', { name: 'Clear', exact: true }).click();
  if (await sky.getByText('Shuffle clouds').count()) throw new Error('shuffle shown with clear sky');
  await sky.getByRole('button', { name: 'Scattered', exact: true }).click();
  const c = await p.evaluate(() => __shotref.state.settings.clouds.cover);
  if (c !== 0.42) throw new Error('Scattered chip set cover ' + c);
  if (!(await sky.getByText('Shuffle clouds').count())) throw new Error('shuffle missing');
});
check('sky: shuffle changes the seed and is undoable', async ({ open }) => {
  const p = await open();
  const before = await p.evaluate(() => __shotref.state.settings.clouds.seed);
  await p.locator('#props').getByText('Shuffle clouds').click();
  const shuffled = await p.evaluate(() => __shotref.state.settings.clouds.seed);
  await p.keyboard.press('Control+z');
  const undone = await p.evaluate(() => __shotref.state.settings.clouds.seed);
  if (shuffled === before || undone !== before) throw new Error(JSON.stringify({ before, shuffled, undone }));
});
check('sky: simple mode has no cloud sliders', async ({ open }) => {
  const p = await open();
  await p.evaluate(() => __shotref.setSimple(true));
  if (await p.locator('#props').getByText('Drift direction').count()) throw new Error('advanced slider in simple mode');
});
```

`sec()` (`src/main.js:2149`) renders `div.sec > h3`. In Simple mode the Ground section's note mentions "Sky colours", so always match the `h3` exactly as above. Shuffle must never return the current seed (re-roll on a collision).

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Controller screenshot check in the built-in browser (desktop width and 1024 px): chips wrap cleanly, swatches readable in the dark panel, no layout jump when cover goes Clear ↔ Few.
- [ ] **Step 6:** Commit `feat(sky): Sky panel with cloud chips, look, drift and shuffle`.

---

### Task 5: Prompt wording

**Files:** Modify `src/main.js:4197-4200` (`writePrompt` light line). Test: `test/smoke.cjs`.

**Interfaces:** Consumes `nearestCover` (Task 1). Produces `export function skyPhrase(clouds: Clouds): string` in `src/sky.js` ('' for clear).

Wording, decided: `nearestCover` = clear → light line unchanged. Otherwise the line starts with the sky phrase, then a comma, then the existing light words:
- `fluffy`: Few → "A few clouds", Scattered → "Partly cloudy sky", Mostly cloudy → "Mostly cloudy sky".
- `wispy` (any cover below overcast): "Wispy high clouds".
- `flat` (any cover below overcast): "A thin grey cloud layer".
- Overcast (any look): "Overcast grey sky", and the existing "Overcast, soft light" phrase is dropped so it is not said twice.
- Append ", clouds drifting" when drift is `breezy` or `fast`.

- [ ] **Step 1: Tests**

```js
check('sky: clear keeps the old prompt', async ({ open }) => {
  const p = await open();
  const t = await p.evaluate(() => { __shotref.setClouds({ cover: 0 }); return __shotref.promptText(); });
  if (/cloud|sky/i.test(t)) throw new Error(t);
});
check('sky: prompt names the clouds', async ({ open }) => {
  const p = await open();
  const t = await p.evaluate(() => { __shotref.setClouds({ cover: 0.42, drift: 'fast' }); return __shotref.promptText(); });
  if (!/Partly cloudy sky/.test(t) || !/clouds drifting/.test(t)) throw new Error(t);
});
```


- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat(sky): prompt names the sky`.

---

### Task 6: Docs, visual QA and full verification (controller)

- [ ] Update `CLAUDE.md`: in **Architecture**, add `src/sky.js` (dome, cloud helpers, `cloudLight`, `skyWording`); under `state.settings` add `clouds {cover, look, drift, dir, soft, seed}` and the "old files open clear" rule; under Rendering note the dome is hidden by `withShotStyle` and in the top view.
- [ ] Update `docs/GUIDE.md` with a short "Sky and clouds" paragraph in the owner's plain style; update `PROJECT.md` via the `project-keeper` skill.
- [ ] Visual QA with the `run` skill in the built-in browser: a pan and an orbit at Few/Scattered/Overcast, sunset and night presets, DOF on, a 1080p MP4 export and a frame pack. Look for banding, a visible seam, clouds below the horizon, and a sun glow that disagrees with the shadows.
- [ ] Copy the build to `sandbox/app.html`, serve with `python3 sandbox/serve.py sandbox`, confirm clouds render under the claude.ai-like CSP.
- [ ] `npm run build && npm test` → all checks pass (report the count). Desktop tests are not required (no `electron/` or `platform.js` change).
- [ ] Run `/code-review high` on the branch (Opus); fix confirmed findings; rerun the tests.
- [ ] superpowers:finishing-a-development-branch; the release (version bump, `electron/whats-new.json`) is a separate owner decision.
