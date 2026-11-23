# ShotRef: artifact vs local feature-gap inventory

Sources: `port/artifact.html` (published build) vs local `src/` (built to `dist/ShotRef.html`).
The minified bundle was pretty-printed with esbuild to `port/app.pretty.js` (21,502 lines; app code starts at about line 17380; three.js and mp4-muxer come before it). Line numbers below refer to that file. Minified names (like `T` = state, `ye` = prefs, `ae` = selected id, `W` = playhead) are given only to help find code.

Screenshots at 1440x900, first load: `port/artifact.png` (opens the embedded "Desert overlook" demo in Camera view) and `port/local.png` (opens the Starter sets dialog in Editor view).

## 0. Saved-format summary (what the artifact adds to `state`)

All of these are additive. Local `normalizeProject` already passes unknown fields through (`...o`, `...src`), so artifact files open in local today. The new fields are simply ignored until they're ported. Each field needs validation added to `project.js` when it's ported.

| Field | Shape | Feature |
|---|---|---|
| `state.meta` | `{id, name}` | Project name, recent projects |
| `state.shots[]`, `state.shotId` | `{id, name, camera:<full camera obj>, duration}` | Shots |
| `state.takes[]`, `state.takeId` | `{id, name, snap:<JSON string of state minus takes/takeId/meta>}` (the active take's `snap` is null or stale) | Takes |
| `state.groups` | `{ [gid]: {name} }` (gid = `"g"+uid`) | Groups |
| `obj.grp` | group id or null | Groups |
| `obj.locked` | bool | Lock |
| `obj.parent` | object id or null; base and keys are stored **relative to the parent** | Attach / ride with |
| `obj.acts[]` | `{t, pose, at?:{p:[3], yaw}}`, sorted; deleted when empty | Pose changes over time |
| `obj.opts.body` | `'man' \| 'woman' \| 'child'` | Body types |
| `obj.opts.seated` | seat-owner object id or null | Sit on seats |
| `obj.opts.lookAt` | `'camera'` or object id | Eyeline |
| `obj.opts.free` | bool ("Can float") | Ground rule |
| `obj.opts.convertible` | bool (car) | Convertible car seats |
| `obj.asset` (top level) | asset id for model/image (local reads `o.asset \|\| o.opts.asset`, so it's compatible) | n/a |
| `camera.mount` | object id or null; camera base and keys stored relative to the mount | Camera mount |
| `camera.dof.strength` | number (default 3) | Blur strength |
| `settings.shadows` (bool), `shadowSoft` (0–1, default 0.3), `tod` (hours 5–20, default 14) | | Sun and shadows |
| `settings.interp` | can also be `"natural"` (camera always samples with natural tangents) | Keys |

Artifact saves `{app:'ShotRef', version:1, state, assets}` with all assets and `state.v:1`. Local writes format 2 and should keep doing so; just add the fields.

Per-browser prefs: `localStorage['shotref.prefs']` (Settings modal) and `localStorage['shotref.library']` (My sets). Recent projects: IndexedDB `shotref` (or `shotref-<embedKey>`), store **`projects`**, version 1. **Clash:** local already uses IndexedDB `shotref`, store `assets`. Porting needs a new database name or a version bump that creates both stores.

---

## 1. Feature inventory

Sizes: S < half a day, M about 1 day, L 2+ days. "Format" means the feature changes the saved project.

### A. Shell and navigation

**A1. Step bar 1 Build · 2 Frame · 3 Export** (`#stepSeg`, `data-step`; `sy()` at 20855, `TP()` works out the active step)
- What the user sees: three numbered pills in the middle of the top bar. Build switches to the editor and the Add tab. Frame switches to Camera view and selects the shot camera. Export selects a pseudo-item `"export"`, so the right panel shows the Export panel (A5). The active pill follows what you're doing: Frame when the camera view is open or the camera is selected, Export when `selected==='export'`, otherwise Build. Keys 1, 2 and 3.
- Depends on: A5 (Export panel). Size M. Format: no.

**A2. Top bar re-layout** (`#top`)
- Artifact top bar: brand, `#projName` (editable project name), `#bTake` "Take 1 ▾" menu, `#bFile` "File ▾" menu, icon-only undo and redo, spacer, step bar, spacer, view seg (Editor / Top / Camera), `#bSplit` (split view), `#bMenu` gear menu.
- Removed from the top bar: New / Open / Save (now in the File menu), the Simple/Advanced seg (now a gear-menu checkbox, "Advanced controls"), "? Help" (in the gear menu, key `?`), Copy frame, Frame PNG and Export… (moved to the Export step and panel, and the camera bar).
- Uses a generic dropdown menu `A0(button, itemsFn)`, rendered in the shared `#ctxMenu` (items `{label, fn, key, check, danger, disabled, head}` or `"-"`). The same component serves the right-click menu (B1).
- Depends on: B1 menu component, A3 (project name), D1 (takes). Size M. Format: no (meta is A3).

**A3. Project name + `state.meta`** (`#projName` input, `wp()` makes sure `meta {id,name}` exists)
- Rename in the top bar. The name is used for the save file name, the recent list and the contact sheet title. Size S. Format: yes (`meta`).

**A4. Left panel tabs Add | Scene (count)** (`#leftTabs`, `#sceneCnt`, `Ap()`; the last tab is remembered in `prefs.leftTab`)
- Add tab: Man / Woman / Child tiles (B5), a big "Add floor mark" tile, "My sets" (D4), then **Props before Shapes**. In Simple mode Shapes shows only box, wall, plane, stairs and cylinder, plus a "More shapes" tile (`prefs.moreShapes`). Import: Image, Model .glb.
- Scene tab: outliner with SVG icons (`Fv` icon set, `Ji()`), a **Sun** row, a lock button per row, a group tag (`.gtag`), a "↳ parent" ride tag, a keyframe count, and double-click to rename inline (`b2()`).
- Local today: a single column, "Add to scene" over "In the scene", one "Add person" button, Shapes first.
- Depends on: B5, D3, D4, E1 for the tags. Size M. Format: no.

**A5. Export panel (step 3) + prompt** (right panel when `selected==='export'`, at about 19030–19046)
- Sections: Output (aspect, size, render style chips, floor grid in exports). "This shot": Render video (MP4), Frame pack (zip), Current frame (PNG), Copy frame, Video options… (opens the old `#mExport` modal). "All shots": "Every shot (N videos)" and "Contact sheet". "Prompt for the AI model": an editable textarea `.promptbox` with **Copy prompt** and **Rewrite from scene**.
- The prompt `ey()` (20560) is written from the scene: shot size, lens and angle (`Jf()`), the detected move (`qh()`), the motion feel, handheld shake, DOF, each person's action, path, poses and eyeline, the cars, the light (time-of-day wording, 20606). User edits are kept in the module variable `Rh` (not saved) until you press Rewrite.
- Depends on: C3 (shot description and move detection), D2 (frame pack), D1 shots for "All shots". Size L (the prompt writer is the bulk). Format: no.

**A6. Split view** (`#bSplit`, `#splitLine`, `ES()`, `prefs.layout`)
- Editor (or Top) on the left and the live camera on the right, with a divider. Pointer input routes by side (`If('work'|'cam')`). Fly keys work when the camera half is active. Size M–L (two viewports in one canvas, plus input routing and the render-on-demand signature). Format: no.

**A7. Settings modal** (`#mSettings`, `#setBody`; prefs `ye` in `localStorage['shotref.prefs']`, defaults `Pb` at 17430)
- New scenes: length, fps, aspect, size. Blocking: walking speed, auto-sit on drop, keep objects on the ground. Export: video quality (standard / high / max bitrate), file-name prefix, date stamp in file names. Viewport: preview quality (pixel ratio), layout single/split, live shadows, PiP default, name labels, facing arrows, hint bar, draggable sun, selection toolbar, draggable camera path points. Mouse and keys: orbit, zoom and fly speed, snap step, turn snap. Saving: autosave + keep N recent, clear recent, show quick start. "Reset all settings".
- Depends on: whichever features it toggles. Each toggle can be ported along with its feature. Size M for the shell. Format: no (per browser).

**A8. Icon viewport toolbar + tooltips** (`#vpRight` `.ib` buttons with `data-tip`)
- One vertical icon strip (Move, Rotate, Scale, Snap, Focus, Grid, PiP, Camera here) replaces local's two text groups (`#vpTools` and `#vpRight`). Move/Rotate/Scale are hidden in Camera view. Size S. Format: no.

**A9. Timeline extras** (`#shotBar` above `#tlBar`; `#bTracks` "Tracks ▴/▾"; `.adv` class)
- Tracks collapse: closed automatically when nothing is keyed (`FS()`), toggled by hand otherwise. In Simple mode the frame counter, "Remove key" and the FPS selector are hidden (`.adv`). "◆ Add key" becomes "◆ Key".
- Timeline: blue **action tags** per person (E2). Drag one to retime it, right-click to delete it.
- Size S (plus E2 and D1 parts). Format: no.

**A10. Undo/redo tooltips name the step** (`#bUndo.title = "Undo: <label> (Ctrl+Z)"`, at 19485; every edit labels itself via `Ie("…")`)
- Local already has `describeChange()` and toasts. Only the button title needs adding. Size S. Format: no.

**A11. Embedded demo project** (`window.__SHOTREF_EMBED__` = `{key, project, message}`; the autosave key becomes `shotref.autosave.<key>`)
- First open loads "Desert overlook" (23 objects, a location photo, a woman, a convertible, cacti) and shows a message toast. This is a mechanism for publishing a scene inside an artifact. Optional. Size S. Format: no.

### B. Direct manipulation (owner priorities first)

**B1. Right-click context menu** (`#ctxMenu`, `cb(hit, floorPoint)` at about 19758, `Kf(x,y,items)`; canvas `contextmenu` at 21368; a small right-drag doesn't open it)
- Shot camera or aim target: Look through camera (C), Set start / Set end, Make static.
- Camera path point (`ck:i`): Go to this moment, Look through the camera here, Delete this point.
- Camera path line (`cpath`): Add a camera point here (t s), Go to this moment.
- Sun: Front / Side left / Side right / Backlight / Top light, Turn shadows on/off.
- Floor mark: "Walk <person> here (arrive N s)".
- Person: Draw walk path, Stand up (when sitting), Frame: Medium shot, Frame: Close-up, Look at the camera / Stop, "<this> looks at <selected person>".
- Any object: Draw path, Face the camera, "Sit <person> here" (if it has seats), Keep camera on this.
- Then for everything: Focus the lens here (double-click), Attach to / Detach from, Group N items / Ungroup, Lock / Unlock, Duplicate (Ctrl D), Drop to floor, Hide, Delete.
- Floor: Add a man / woman / child here, Add floor mark here, Walk <selected person> here, Aim the camera here, Move the camera here (Top view only).
- Depends on: the menu component (shared with A2). Items light up as the matching features land (B2, B4–B7, C1, E1–E4). Ship it first with the items local already supports. Size M. Format: no.

**B2. Double-click = focus the lens** (canvas `dblclick` at 21355 → `bS(point, name)` at 19714)
- Double-clicking an object (not a mark) sets `fd` to the hit point's distance along the camera's view axis. It turns DOF on, sets auto off, and keys `fd` if the camera has keys, so double-clicking something else later in the shot pulls focus. Toast: "Focus on X (2.40 m). Depth of field is now on". Points behind the camera are refused.
- **Changes local behaviour:** local double-click today = zoom the view to the selection (`focusSel`). F still does that. Double-click while drawing a path still finishes the path.
- Size S. Format: no.

**B3. Multi-select + box select + Ctrl+A** (`Bn` Set of ids; `Ri()`, `Bi()`; `#boxSel` drawn with Shift-drag on empty floor, at about 21271)
- Shift/Ctrl-click toggles an item, Alt-click picks one item inside a group, Ctrl+A selects all visible. Dragging any selected item moves the whole set, and the turn ring turns them together. The right panel shows a multi-select panel `P2()`: group name, Arrange (Group/Ungroup, Lock all/Unlock all, Drop to floor, People face camera, Duplicate, Delete), and "Save as a reusable set" (D4).
- Size L (touches drag, ring, gizmo, delete, duplicate and the panels). Format: no.

**B4. Lock** (`obj.locked`; `Wr(list, bool)`; Ctrl+L; outliner lock button; Scene panel "Lock the set" = lock walls, props and buildings with "Unlock all")
- A locked item can't be dragged. Dragging it orbits the view instead, and the panel shows a "Locked" line. Size S–M. Format: yes.

**B5. Groups** (`state.groups`, `obj.grp`; Ctrl+G group, Ctrl+Shift+G ungroup; `_p()` and `xp()` at 18755)
- Clicking any member selects the whole group, Alt-click picks one. The outliner shows a tag, and the group can be renamed in its panel. Depends on: B3. Size M. Format: yes.

**B6. Selection toolbar over the object** (`#selBar`, `PP()` positions it above the selection's bounding box, `CP()` builds it, `prefs.selBar`)
- Person: Draw walk path, Look at the camera (toggle), Frame medium. Object: Draw path / drive path, Keep camera on this. Always: Duplicate, Lock, Delete. Multi-select: Group/Ungroup. Hidden in Camera view, while playing, and while dragging, placing or drawing paths.
- Depends on: B4, B5, E4. Size M. Format: no.

**B7. Ground rule: everything rests on what's under it** (`prefs.ground` default on; `Mo(o)` = grounded unless it has a parent, is seated, or has `opts.free`; `zh` dirty flag; at about 19577)
- Objects snap down onto the floor or onto the top of whatever is under them (a cup on a table). The drag hint reads "On top of something: X". Height is then read-only ("Height is set by the floor…"). "Can float (not kept on the ground)" checkbox (`opts.free`). A green **lift arrow** gizmo (`Vs`) raises floating items. "Drop to floor" action.
- Size L (raycast stacking during drag + evaluation). Format: yes (`opts.free`).

**B8. Ring release targets** (21230: "Release to face X")
- Dragging the orange turn ring and releasing over another person or the camera makes the item face that target. Size S. Format: no.

### C. Camera

**C1. Draggable camera path + points** (yellow path in editor/top; `ck:<i>` handles, `cpath` line; `prefs.camPoints`)
- Drag a key's point to reshape the move, Alt-drag moves it up and down. Right-click the path to add a point at that time (`Z2()`). Right-click a point to delete it. Size M. Format: no.

**C2. Camera mount** (`camera.mount`; camera panel "Mount" → "Mount on"; `kb(id)` converts base and keys to the mount's local space; `ua()` and `yo()` convert to and from world space)
- The camera rides on an object (car mount, dolly cart). Your camera moves still apply on top. It turns `follow` off. Depends on: the parenting maths in E1 (shared `jl()` world transform). Size M. Format: yes.

**C3. Shot description + move detection** (`Jf()` → "Extreme wide · 60 mm · eye level" in the camera HUD `.shotdesc`; `qh()` at about 20000 names the move from start/end keys: "Static camera", "Dolly in", "Orbit left", "Dolly zoom", "Free / recorded move", "Subtle move"…)
- Used by the HUD, the "Camera move" card (C4), the prompt (A5), the contact sheet and the take compare. Size M. Format: no.

**C4. Camera panel tabs + move card** (camera panel `T2()`: tabs **Shot | Move | Lens | Photo | Output** with a dot when a tab is active; `prefs.camTab`)
- Shot tab: Frame a person, Subject (look at / follow), Mount. Move tab: a "Camera move" card with the detected move title, a description and **Start / End thumbnails** (`Q2()` renders 240 px JPEGs, cached by `editRev|aspect|style`), Set start / Set end, "▶ Play the move". Below it: one-click moves with a Strength slider, Motion feel, Record a move live, Handheld. Lens tab: focal length, DOF (with **Blur strength**, `dof.strength`). Photo tab: location photo. Output tab: aspect, size, style, guides.
- Local today: one long camera panel.
- Depends on: C3. Size M. Format: `dof.strength` only.

**C5. Blur strength** (`camera.dof.strength`, default 3, feeds the DOF pass). Size S. Format: yes.

### D. Project-level features

**D1. Shots (several camera setups on one scene)** (`state.shots`, `shotId`; `#shotBar` chips under the viewport; `Ds()`, `Xr()` saves the current camera into its shot, `ql()` loads one, `xb()` new/duplicate, `uP()` delete, `vb()` reorder, `bb()` rename; at 20335–20390)
- Each shot = its own `camera` + `duration`. Objects and actions are shared. "+ New shot" starts from the current framing with no keys. Chip right-click: Rename, Duplicate (same move), Move left/right, Delete. Double-click a chip to rename. Export names include the shot name. "Every shot (N videos)" (`gP()`) renders each one in turn.
- Implementation note: `state.camera` stays the live camera, so all existing code keeps working, and it's mirrored into the active shot on save and switch.
- Size M–L. Format: yes.

**D2. Frame pack (zip)** (`LS()` at 20652; its own store-only zip writer `SP()` at 20641)
- First, middle and last frames as PNG plus `prompt.txt`, in one zip, saved via `saveFile`. Replaces local "Start + end frames (PNG)". Depends on: A5 prompt (can ship with a simpler prompt first). Size M. Format: no.

**D3. Contact sheet** (`#mSheet`, `IS()` at about 20490)
- One PNG: the first and last frame of every shot, with name, duration, move and shot size. Title "<scene> · <take> · contact sheet". Save as PNG. Depends on: D1, C3. Size M. Format: no.

**D4. My sets (reusable set library)** (`localStorage['shotref.library']` = `[{id, name, items:[{type,name,color,opts,base}]}]`; `ib()` save, `I2()` place)
- Select items → "Save as a reusable set". They appear under "My sets" in the Add tab. Click one, then click the floor to place it (as a new group). × deletes a set. Imported images and models are left out. Depends on: B3, B5. Size M. Format: no (per browser).

**D5. Takes (alternative versions + compare)** (`state.takes`, `takeId`; `#bTake` menu; `Z0()` switch, `dP()` new, `fP()` delete, `pP()` rename; `#mCompare` side-by-side compare `mP()`/`CS()` at 20440)
- "New take (copy of this one)", switch between takes, rename, delete. Compare renders about 10 fps JPEG frame strips of two takes and plays them in sync with a scrub bar; "Use right take" switches to it.
- Implementation note: each non-active take stores the **whole state as a JSON string**, which bloats undo snapshots and autosave. When porting, keep take snapshots out of undo, like assets.
- Depends on: B1 menu (A2), C3 for labels. Size L. Format: yes.

**D6. Recent projects / Open dialog** (`#mRecent`, `q0()`; IndexedDB store `projects` `{id, name, updated, thumb(320 px jpeg), data}`; autosave `iP()` every 2.5 s keeps `prefs.keepRecent`)
- Ctrl+O opens a grid of thumbnails, plus "Open a file…" and "New scene from a starter set…". The current project is marked "Open now". × removes one.
- **Conflicts with local IndexedDB asset store and autosave design.** Must be merged with the local IndexedDB autosave, not copied. Unavailable in the claude.ai sandbox (it shows a note). Desktop app: decide whether recent = OS recent files.
- Depends on: A3. Size M–L. Format: no.

### E. People and objects

**E1. Attach / ride with (parenting)** (`obj.parent`; panel "Attach → Ride with"; `cp(o, parentId)` converts base and keys to parent space, at 17560; `jl()`/`ht()` world eval; `ya()` back to local; cycle guard)
- A person rides in a car, a cup rides on a tray. Outliner "↳ parent" tag. Context menu Attach to <thing underneath> / Detach. Sitting in a car attaches automatically.
- **Core change:** every `evalObj` call site must use world eval. Size L. Format: yes.

**E2. Pose changes over time (actions)** (`obj.acts`; panel "Pose" shows "Pose for the whole shot" or "Pose from N s"; picking a pose at playhead > 0 adds `{t,pose}` (`N2()` at 19125); "Actions over time" list; `ly()` blends over about 0.5 s (`t2`))
- A person can walk in, stop, sit, then wave. Sitting as an action snaps to the nearest seat (`at`). Blue tags on the person's timeline row: drag to retime, right-click to remove. FPS changes re-snap `acts[].t`.
- Depends on: E3 for sitting. Size L. Format: yes.

**E3. Sit on seats** (seat tables `X2` for chair, sofa (3) and bed (2), convertible car seats via `Sp()`; `xS()` sit, `vS()` stand; `opts.seated`; `prefs.autoSit`)
- Drag a person onto a seat → "Release to sit on X". They sit at the seat height and facing. Drag away and they stand. Context menu "Sit <person> here" / "Stand up". Sitting in a car also attaches (E1). Size M. Format: yes.

**E4. Eyeline / look at** (`opts.lookAt` = `'camera'` or id; panel "Eyeline"; `i2()` gives the target point; head and upper body turn while either one moves)
- Toggle with "Look at the camera" in the selection bar and the context menu. Size M. Format: yes.

**E5. Body types Man / Woman / Child** (`opts.body`; `Ps` presets with height and colours; mannequin proportions per body at 17992, e.g. a woman's narrower shoulders, wider pelvis and long hair)
- Three Add tiles replace "Add person". Panel title shows the body label, with a body selector. Size M. Format: yes.

**E6. Car upgrades** (wheels roll with distance and front wheels steer into curves; `opts.convertible` "Convertible (open top)" with 2 seats; "Draw drive path")
- Size M. Format: yes (`convertible`).

**E7. Cactus prop** (`fa.cactus`, Props). Size S. Format: new type value (older builds would need a fallback mesh).

**E8. Face the camera / People face camera** (sets yaw toward the camera and `faceTravel=false`). Size S. Format: no.

### F. Light

**F1. Sun & shadows panel** (`cS()`; `settings.tod`, `shadows`, `shadowSoft`)
- "Light the shot from": Front / Side left / Side right / Backlight / Top, worked out from the camera azimuth (`lS()`). **Time of day** slider (05:00–20:00) drives sun height, colour and strength (`M2()`), with a description ("Golden hour, long shadows"). Direction, Height, Cast shadows, Softness, **Shadow depth** (maps to ambInt), Sun strength, Sun colour (Advanced).
- Local today: "Sun & light" with plain sliders. Size M. Format: yes.

**F2. Draggable sun gizmo + Sun item** (yellow sun in editor/top; selectable `"sun"` row in the outliner opens the Sun panel `w2()`; right-click menu; `prefs.showSun`)
- Depends on: F1. Size M. Format: no.

---

## 2. Things the local app has that the artifact lacks or does differently (keep them)

- **Foundations the artifact lacks:** the `normalizeProject` loader (the artifact loader `Qf()` only merges settings), format 2 with only used assets, IndexedDB asset autosave + broken-autosave recovery + second-tab warning, export lock (`inert`) and lost-context recovery, render-on-demand (`requestRender`/signature), branding (logo, tagline, branded start dialog with a "Quick start guide" button), the platform layer (desktop New/Open/Save/**Save as** Ctrl+Shift+S, dirty flag, `.shotref` extension in Open), and ARIA on dialogs. The `mConfirm` third button (`cfAlt`) is local-only.
- **Top bar:** local has visible New/Open/Save, a Simple/Advanced seg, "? Help", Copy frame, Frame PNG and Export… buttons. The artifact moves all of these into menus and the Export step. Decision needed: adopt the artifact layout (the owner asked for its features) but keep Save as.
- **Double-click:** local = zoom to selection. Artifact = lens focus (B2). F still zooms in both.
- **Start-up:** local shows the Starter sets dialog on first run. The artifact opens the embedded demo (A11).
- **Export modal:** local "Start + end frames (PNG)" becomes "Frame pack (zip)" in the artifact.
- **Timeline:** local always shows the frame counter, Remove key and FPS. The artifact hides them in Simple mode and can collapse the tracks.
- **Left panel:** local shows every shape up front and a single "Add person". The artifact uses tabs and fewer shapes in Simple mode.
- The artifact's Quick start text references Build/Frame/Export, shots, right-click, sit, groups and lens focus. The help modal text must be updated as each batch lands. (Artifact help grid lines 330–563 of artifact.html give the final wording.)

---

## 3. Suggested batches (each one builds and tests on its own, in order)

1. **Format + foundations.** `project.js` validation for all the new fields in section 0 (meta, shots/shotId, takes/takeId, groups, grp, locked, parent with a cycle check, acts, opts.body/seated/lookAt/free/convertible, camera.mount, dof.strength, settings.shadows/shadowSoft/tod). Prefs store `shotref.prefs` (try/catch). A generic dropdown/context-menu component (`#ctxMenu`). Undo button titles (A10). Smoke checks: round-trip an artifact-format file and drop dangling references.
2. **Shell: top bar + step bar + left tabs.** A2, A3, A1 (Export step initially opens a minimal Export panel with the existing buttons), A4 (tabs + Man/Woman/Child tiles needing E5; or keep "Add person" until batch 5), A8, A9 Simple-mode `.adv` hiding and Tracks collapse, gear menu (Advanced, Settings placeholder, Help). Keep Save as.
3. **Owner asks: right-click menu + double-click lens focus.** B1 with the items local already supports (camera, floor add/aim/move, marks walk-here, person path/frame/face camera, focus lens, duplicate, hide, delete). B2. Grow the menu in later batches.
4. **Selection model: multi-select, box select, lock, groups, selection toolbar.** B3, B4, B5, B6, B8. Ctrl+A/G/L.
5. **People: body types, eyeline, sit, actions.** E5, E4, E3, E2 (with timeline action tags), E8.
6. **Parenting + ground + mount.** E1 (world eval everywhere), B7 (ground stacking, lift arrow, Can float), C2 (camera mount), E6 car wheels and convertible, E7 cactus.
7. **Camera UX.** C3 (shot description, move detection), C4 (camera tabs + move card with thumbnails), C5 blur strength, C1 (draggable path points).
8. **Light.** F1 time of day, shadows and light-from presets. F2 sun gizmo and Sun outliner row (+ its context menu).
9. **Shots + export panel + prompt.** D1 shots and shot bar, A5 export panel and prompt writer, D2 frame-pack zip, D3 contact sheet, "Every shot" export, shot name in file names.
10. **Takes + compare.** D5 (keep take snapshots out of undo).
11. **Library + recent + settings + split view.** D4 My sets, D6 recent projects (resolve the IndexedDB clash; sandbox fallback), A7 full Settings modal (wire each pref), A6 split view, A11 embed hook (optional).

---

## 4. Not determined (timebox)

- Exact prompt-writer wording and rules (`ey()` at 20560–20605): read that code when porting batch 9.
- Ground-stacking details (raycast vs bounding box), the lift-arrow gizmo and sun-gizmo internals, and the car steering maths. Only their existence and UI were confirmed.
- Split-view input routing details and how render-on-demand would fit them (the artifact redraws continuously).
- Whether the artifact's undo snapshot includes takes snapshots on purpose (it does include them, since `takes` lives in `T`).
- Video quality bitrates for standard / high / max, and preview-quality pixel ratios.
- Mobile/touch behaviour and drag-and-drop to the outliner were not checked. No interactive clicking comparison was done beyond the first-load screenshots.
