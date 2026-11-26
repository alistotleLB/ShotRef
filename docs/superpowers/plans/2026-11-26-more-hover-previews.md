# More hover previews: implementation plan

**Goal:** Hover previews for motion feel, poses and lens chips, sharing the `#movePeek` box.
**Spec:** `docs/superpowers/specs/2026-11-26-more-hover-previews-design.md` (read it, plus CLAUDE.md).
**Tech:** `src/main.js` (peek section after `applyMove`, about lines 1977–2090), `src/index.html`, `test/smoke.cjs` (append only, LF only), `test/visual.cjs`.

## Global constraints
- Single offline file, claude.ai CSP (no blob: URLs, no network). Nothing written to state, history, the unsaved mark or autosave. No main redraws caused by the preview.
- Don't commit. Run `npm run build` then `node test/smoke.cjs --only "<name>"` for your checks plus `--only "move preview"` and `--only planMove` (regression).

### Task 1: Preview sources + motion feel
- Refactor the peek code so a hover names a **source**: `peekSoon(src, arg, btn)` / `peekShow(src, arg, btn)`, where `src` is in `'move' | 'feel' | 'lens' | 'pose'`. Each source supplies `setup(arg) -> {label, note|null, demo:boolean, ...}` and `draw(t, rt)` (or equivalent). `'move'` keeps its exact current behaviour, and the existing 5 move preview checks must still pass unchanged. `peek()` on `window.__shotref` gains `src` and `arg` (keep `kind` = arg for moves).
- Add a small helper that wires hover/focus/leave/blur/click on a button (reuse it for the move grid).
- Bottom-bar placement: when the button is inside `#feelBar` (or any control below the viewport), place the box above it, centred, clamped.
- Motion feel source, per spec §1. Swap in a feel without writing state: the cleanest is `withFeel(feel, fn)`, which temporarily sets `state.camera.feel` inside try/finally (same pattern as `withPlan`).
- Tests (append): `'feel preview: hover replays the shot move with that feel'`. Apply orbitL, hover "Strong ease" in the Move tab, wait for open and more than 10 frames, `src === 'feel'`, `demo === false`, the state JSON and `state.camera.feel` are unchanged, and the picture changes over 500 ms. `'feel preview: static camera falls back to a dolly in, bottom bar opens above'`. Static camera with a person in frame: hover the `#feelBar` "Strong" button, the note is visible with its exact text, and the box's bottom edge is ≤ the button's top edge.
- **Model: Opus, high.**

### Task 2: Lens chip preview
- Lens source, per spec §3, using the Task 1 source API. Remove the chips' `title`. Render at the playhead `T` with `renderCam` focal length overridden (after `prepRenderCam(T)`, set the focal length on a copy, or set it and restore). Objects stay at `T`, so no `applyAll(t)` is needed.
- Tests: `'lens preview: hover a chip zooms the shot to that focal length'`. Hover "85mm", open, `src === 'lens'`, the label contains "→ 85mm", the state is unchanged, and `evalCam(T).f` is unchanged. Hovering the current focal length shows a label without "→".
- **Model: Sonnet, medium.**

### Task 3: Pose preview
- Pose source, per spec §2. Build the preview person with `makeObject('person', …)` using the selected person's `opts` (body, height, colours) and `color`, then `buildPerson`. Animate with `posePerson(P, o, t, info, null)`, passing a pose override at preview time without writing `state`: check how `poseAt`/`actLayer` read the pose. The simplest is a throwaway object `{...clone of person, keys: [], acts: null, opts: {...opts, pose: hovered}}` that isn't in `state.objects`. Walk/run stay on the spot: pass `info` with `moving: true` and the speed or phase the stride needs, but keep the root at the origin. Check `personMotion` and `POSES.walk.f` for what drives the phase. Sit: a stool box, and seat the figure on it (check `sitPerson`/`SEATS` for the hip height maths, or position the root by eye). Dispose geometry and materials of a replaced preview person.
- Separate scene from the move demo or shared (your call), with a fixed three-quarter front camera framed to the person's height.
- Tests: `'pose preview: hover a pose shows the selected person doing it'`. Add a person and select it, hover "Wave", open, `src === 'pose'`, frames > 10, the picture changes over 500 ms, the state is unchanged. Hover "Sit", open, no errors. `'pose preview: walk stays on the spot'`: expose `peek().poseRoot` (the root's world position), which stays within 0.01 m of where it started over 1 s.
- Add a `10-pose-preview` screen to `test/visual.cjs` (hovering "Wave" for a selected person).
- **Model: Opus, high.**
