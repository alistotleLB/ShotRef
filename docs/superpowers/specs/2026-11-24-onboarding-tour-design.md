# Onboarding tours: design

Date: 2026-11-24. Status: approved by Ali 2026-11-24 ("Approved, but take these points into consideration"; both points folded in).

## Intent and why

ShotRef is for people who aren't 3D artists. Today a newcomer gets the "Start a shot" picker on first launch, plus a written Quick start page (`#mHelp`, gear menu or `?`). Nothing on screen shows them *where* things are. Ali wants two tours:

- **Basic tour**: a short guided walk round the screen.
- **Hands-on tour** (Ali: "advanced interactive onboarding"): a longer walk that also covers the less obvious parts, and asks the user to try each thing.

Ali's goal for both (2026-11-24): stop at **"they know where things are"**. Neither tour has to end with an exported clip.

## Goals

- Someone who has never seen ShotRef can name and find, after the basic tour: the three steps (Build, Frame, Export), the Add tab, the picture, the View buttons, the right-hand panel, the timeline, the File menu and the gear menu.
- After the hands-on tour they have also *used*: placing a person, right-click menus, Top and Camera view, double-click focus, play, and the Export step; and they know where shots, takes, the sun, keyframes and Advanced controls live.
- Works the same in all three places ShotRef runs: offline file, claude.ai artifact (strict CSP), Windows app.

## Non-goals

- Teaching a full shot from start to export (that's the Quick start page's job, which stays as it is).
- Screenshots, videos or images inside the tours.
- Auto-starting a tour on its own. On first run ShotRef asks once; otherwise tours start only when the user asks.
- Translation, analytics, progress saving mid-tour.

## Anti-goals (a failure even if it "works")

- A dim overlay or bubble left stuck on screen, or a tour that leaves the app unusable or keyboard focus lost.
- A tour that quietly changes the user's project in a way they can't undo.
- A tour that silently goes out of date when the layout changes (a stop pointing at nothing).
- Making the file noticeably bigger or adding any library or network request.

## Approaches (Ali picked A on 2026-11-24)

- **A. One spotlight tour engine (picked).** The screen dims except the part being explained; a speech bubble sits next to it. Both tours are lists of stops fed to the same engine; hands-on stops carry a "wait until" condition. Built in-house: works offline, under the claude.ai CSP and on desktop; tiny; points at the real UI so it can't go stale like pictures.
- B. Basic as an illustrated slideshow, advanced as spotlight. Rejected: two systems, images bloat the single file and go stale with every layout change.
- C. Pulsing hotspot dots on key buttons. Rejected: easy to miss things, no guided order, not really a tour.

## How it starts (Ali's first-run rule; the rest are Claude's calls, shown to Ali)

- **First run only, ShotRef asks.** Ali, 2026-11-24: "On first run only, ask the user is they would like to take the tour. Mention that the tour can be taken later through the Help menu."
  - A small welcome window opens *before* the "Start a shot" picker. It offers **Take the quick tour** (basic), **Try it hands-on** and **Not now**. It also says the tours are always in the Help menu later.
  - After the tour ends, or after Not now, the "Start a shot" picker opens as it does today. The question never appears again, whatever the answer: it's remembered in the same "seen" flag as today (`shotref.seenHelp`). Restored sessions, opened files, embedded demos and a broken autosave skip it, just as they skip the picker today.
- **"Help menu" in both places** (Claude's reading of Ali's words): on the desktop app, the native **Help** menu gets **Take the quick tour** and **Try it hands-on**. In the browser, the gear button (tooltip "Settings and help") gets a **Help** heading with the same two items, so the welcome text "the Help menu" is true everywhere. This replaces the earlier non-goal "no desktop Help menu entry".
- The gear menu items are listed above (the Help heading).
- The Quick start page (`#mHelp`) gets a line with both tour buttons at the top.
- Finishing or ending a tour is remembered in `shotref.prefs` (`tourBasicDone`, `tourHandsDone`), only to show a small tick in the gear menu. Nothing auto-starts.

## What it looks like

```
 ┌───────────────── dimmed screen ─────────────────┐
 │   ┌──────────────┐                              │
 │   │ 1 Build 2 Fr │◄── bright cut-out, orange    │
 │   └──────────────┘     outline                  │
 │      ┌─────────────────────────────┐            │
 │      │ The three steps        2/8 │            │
 │      │ Work left to right: Build, │            │
 │      │ then Frame, then Export.   │            │
 │      │ [Back] [End tour]   [Next]│            │
 │      └─────────────────────────────┘            │
 └─────────────────────────────────────────────────┘
```

### Visual design (UI/UX pass, Ali asked for it on 2026-11-24)

The generic product tour looks like this: a white bubble, a blue button, a soft glowing ring, and a row of grey dots for progress. That would look borrowed inside a dark edit-suite app. Instead, the tour borrows ShotRef's own mark, which is two frame corners joined by a camera path.

- **The one memorable thing: viewfinder corners.** The target isn't ringed by a rounded glow. Four orange L-shaped corners (`--acc` #FF9A3C, 2.5 px, round caps, like the logo's corners) frame it the way a camera viewfinder frames a subject. When the tour moves to the next stop, the corners **travel** from the old target to the new one in about 350 ms with an ease-in-out, like a short camera move. This is the tour's only motion. With `prefers-reduced-motion`, they jump instead.
- **Dim:** the app's charcoal (`--bg` #141518) at about 62 % opacity outside the cut-out. The cut-out has a 6 px margin and no fill, so the real control shows untouched.
- **Bubble:** an app panel, not a card. It uses the existing dialog background and border colours, an 8 px radius, the system font stack, and a 340 px maximum width, which keeps lines under about 60 characters. Title 15 px/600 in `--ink`, body 13 px/1.5 in the app's muted text colour. There's no shadow beyond what the app's dialogs already use.
- **Progress is a camera path.** Under the text, a thin orange line runs from a start dot to an end dot (the logo's path, drawn straight). A filled dot marks the current stop, with "3 of 8" beside it for screen readers and anyone counting. There are no numbered markers on the stops themselves, since the path already shows the sequence.
- **Buttons** follow the brand voice: verbs, 1 to 3 words, sentence case. **Next** is the one orange button (`--acc` fill, charcoal text). **Back** and **End tour** are quiet text buttons. The last stop says **Finish**. On hands-on stops the main button reads **Skip this step** until the action is done. Then the bubble shows a small orange tick with a confirmation word ("Placed", "Moved", "Focused") and moves on after 700 ms.
- **Copy rules** (BRAND.md voice): plain filmmaker English, no "please", "just", "simply", "easy" or exclamation marks, and the app never says "I". Every body is at most 2 sentences. Hands-on "try" stops start with the action ("Click Person, then click the floor.").
- **Focus and access:** the bubble is `role="dialog"` with a label and takes focus. Next has a visible 2 px focus ring in `--acc2`. Contrast is at least 4.5:1 for the text. It works with the keyboard alone.
- **Narrow windows:** below 900 px the bubble pins to the bottom centre at full width minus 16 px, and the corners still frame the target.
- Before each part is built, the builder takes a screenshot of the tour at 1600×900 and 1280×720 and checks it against this section: the corners aren't clipped, the bubble doesn't cover its own target, and the text is readable.

- Bubble contents: title, one or two plain sentences, the progress path, then Back, **Next** (**Finish** on the last stop) and **End tour**. On hands-on stops Next reads **Skip this step** until the action is done, then the bubble shows a tick and moves on by itself after a short pause.
- The bubble places itself on the side of the target with the most room and stays fully on screen, at the 1280 px and narrower widths the app supports too.

## Engine behaviour

- New module `src/tour.js` (engine: overlay, cut-out, bubble, placement, keyboard, wait loop). The stop lists live in `main.js` next to the code they point at, because the wait conditions read app state (`view`, `state.objects`, `selected`, the step, `playing`…).
- A stop is `{ target, title, text, before?, waitFor?, doneText? }`:
  - `target`: a CSS selector or a function returning an element, or null for a centred bubble (the welcome and goodbye stops).
  - `before`: optional set-up the engine runs first (e.g. open the Build step, switch the left tab) so the target exists.
  - `waitFor`: hands-on only, a function that returns true once the user has done the thing.
- Cut-out: one positioned element with a very large box-shadow for the dim, re-measured on every stop, on window resize and on each drawn frame while the target moves. It sits above the app but below the right-click menu (`#ctxMenu`) and toasts, so menus opened during hands-on stops show.
- Clicks:
  - Basic tour: clicks outside the bubble do nothing (no accidental edits).
  - Hands-on tour: clicks reach the spotlit area (and the canvas when the stop is about the picture); everything else is blocked.
- Keyboard: Esc ends the tour; Enter or → is Next; ← is Back. The bubble takes focus and its text is announced (`role="dialog"`, `aria-live`). During the basic tour app shortcuts are off; during hands-on they stay on (the user may press T or C), except while typing in the bubble.
- Missing target (hidden by a narrow window, Advanced controls off, a panel closed): the stop shows as a centred bubble rather than failing, and logs a `console.warn` naming the stop, so a test can catch it.
- Ending (Finish, End tour, Esc, or a project being opened mid-tour): remove every tour element and listener, give focus back to where it was, `requestRender()`. A tour can't start while an export runs or a modal is open (other than Start a shot, which it closes).

## The stops

Wording is the builder's to polish (plain English, sentence case, real operator terms); the order and targets are the design.

**Basic (8 + welcome + goodbye):**
0. Welcome (centred): "A quick look round. Takes about a minute."
1. Steps bar `#stepSeg`: work left to right, Build, Frame, Export; keys 1 2 3.
2. Add tab `#leftTabs`/`#addArea`: people and props; click one, then click the floor.
3. The picture `#vp`: drag to orbit, right-drag to pan, scroll to zoom; right-click anything for its menu.
4. View group `#viewGrp`: Editor, Top (floor plan), Camera (the shot), split view.
5. Right-hand panel `#right`: settings for whatever is selected.
6. Timeline `#tl`: play, the playhead, keyframes; shots live in the row above.
7. File `#bFile`: new, open, save, export.
8. Gear `#bMenu`: settings, Advanced controls, Quick start and these tours.
9. Goodbye (centred): where to find the hands-on tour and Quick start.

**Hands-on (about 15):** each "try" stop has a `waitFor`.
1. Welcome (centred): this is a practice stage; your scene comes back when the tour ends.
2. Steps bar: click **Build**. waitFor: step is build.
3. Add tab: click **Person**, then click the floor. waitFor: one more person in the scene than at the start.
4. The person: drag them somewhere. waitFor: their position changed.
5. Right-click the person. waitFor: the right-click menu is open. (The bubble steps aside so the menu shows; the menu closing by Esc does not end the tour.)
6. Scene tab `#leftTabs [data-lt=scene]`: everything in the shot, plus the sun. waitFor: Scene tab shown.
7. Top view: press **Top** or T. waitFor: view is top.
8. Camera view: press **Camera** or C. waitFor: view is camera.
9. Camera bar `#camBar`: Set start, Set end, Record, Location photo (point only, Next).
10. Double-click the person to focus the lens. waitFor: depth of field turned on with a focus distance set by the pick.
11. Play `#bPlay` or Space. waitFor: playback started.
12. Key button `#bKey`: keyframes, and where the blue action tags appear (point only).
13. Shots row `#shotBar` and Take button `#bTake`: other camera setups and alternative versions (point only).
14. Gear `#bMenu`: Advanced controls for more detail (point only; doesn't switch it on).
15. Export step `#bExport`: click it. waitFor: step is export. Goodbye: "You know your way round. The Quick start page has the rest."

Edits made during the hands-on tour happen on the practice stage only and are thrown away when it ends.

## Builder check answers (Claude's calls unless marked Ali's)

- **Wait conditions need a change, not a state.** Each `waitFor` gets a snapshot taken when its stop began and passes only on a change since then (step changed to build, view changed to top, person count went up, the person moved, a new focus pick). A condition that is already true never skips a stop by itself.
- **`before` re-runs on every stop, including after Back.** It puts the screen in the state the stop needs (e.g. Camera view for the camera bar, Editor view and Build step for the Add stops). The tour may change the view, step, left tab and selection without asking. These aren't undo steps and aren't saved. If the target still isn't visible after `before`, the stop shows as a centred bubble.
- **Focus stop (hands-on 10):** `before` selects the tour's person and frames a medium shot of them with the existing shot-size command, so they're in the picture. That's one undoable camera edit, and the bubble says so. The wait is for a new successful focus pick, not just "depth of field on".
- **Keyboard:** the tour listens in the capture phase. Esc goes to the app first when the app has something to cancel (an open menu, placing, a path, a recording, a focus pick). Otherwise Esc ends the tour. During the basic tour, every other app shortcut is stopped. During hands-on, app shortcuts work, and `before` re-runs if a key moved the screen away from the stop's view.
- **Layering:** the tour sits above dialogs and overlays (z-index about 30) and below toasts (60) and `#ctxMenu` (70), so menus and toasts show above it.
- **Export stop:** clicking Export also switches to Camera view and selects the Export panel. That's expected, and the goodbye bubble is placed with that in mind.
- **Shots row:** with one shot it's a single "Shot 1" chip. The text says "your shots appear here; + New shot adds another".
- **Which scene the hands-on tour uses: a practice stage (Ali's choice, 2026-11-24: "Practice stage").** Details are in the next section.

## The practice stage (hands-on tour)

When the hands-on tour starts, ShotRef sets the user's scene aside and shows an empty practice stage. When the tour ends, for any reason, the user's scene comes back exactly as it was. The user's work must be impossible to touch. The **Lessons** list in PROJECT.md says every past bug in this area lost work, so the following rules are strict:

- **Set aside in memory, all of it:** `state`, `assets`, selection, the playhead, undo history (`hist`, `histDoc`, `hi`), the document identity (`platform.getDoc()`), the unsaved mark, the view, the step and the editor camera. It uses the same fields the `replaceProject()` error path already restores, not a JSON round trip, so nothing is re-normalised.
- **Practice stage:** `buildState(() => fillStarter('empty'))`. Undo works inside it, but only for practice edits.
- **While practising, nothing is written:** no autosave to `localStorage` or IndexedDB, no Recent projects entry, no unsaved-mark change, no title change. If the browser or app closes mid-tour, the last autosave, which holds the user's real scene, is what reopens.
- **What ends the tour first** (scene put back, then the action runs as normal): Open, New/starter sets, Save, Save as, Recent projects, dropping a file, desktop menu commands, a file opened from Windows, and closing the desktop window (so the "unsaved changes?" question is about the real scene). The Export step itself stays inside the tour (stop 15), but rendering an export ends it first.
- **Ending is one path:** Finish, End tour, Esc and every case above call the same `leavePractice()`, which puts everything back and calls `requestRender()`. It is safe to call twice.
- The welcome stop says: "This is a practice stage. Your scene comes back when the tour ends."
- **Tests for this part, one per path:**
  - the scene, assets, undo depth, the unsaved mark and the document identity are identical after Finish, after End tour, after Esc and after Open mid-tour;
  - the autosave record is not touched during the tour;
  - on desktop, closing mid-tour asks about the real scene (`test:desktop`).

## Constraints (from CLAUDE.md)

- Single offline HTML file: no library, CDN, font or network request. CSP-safe: no inline `on*=` attributes in HTML strings, no `eval`, no `blob:` URLs.
- No `alert`/`confirm`/`prompt`. `localStorage` always in try/catch.
- Must not start or keep drawing frames by itself when idle beyond what a moving target needs (`requestRender()` rules).
- Plain English UI text, sentence case.
- `npm run build && npm test` must pass; `npm run test:desktop` too, because closing the desktop window mid-tour must restore the scene first.

## Tests (targets set now)

| Test | Target | Set by |
|---|---|---|
| Basic tour: every stop's target is found and visible at 1600×900 and 1280×720 | 0 missing targets | Claude |
| Hands-on tour: each waitFor stop advances when its action is done through the real UI or the `__shotref` hooks | all stops reached, ends on Export step | Claude |
| Esc, End tour and Finish each leave no tour element, no listener-driven redraw and focus back in the app | 0 leftovers | Claude |
| Start from gear menu (both), Quick start page and the first-launch button | all four start the right tour | Claude |
| Tour under the claude.ai-like CSP (`app.html`) | runs, 0 console errors | Claude |
| Full suite after the change | `npm test` all pass | Claude |
| Ali tries both tours | checklist items pass | Ali |

## Left to the builder

- Exact wording of each bubble, within the rules above.
- Animation (a short fade and slide, under 200 ms; none when `prefers-reduced-motion`).
- How the wait loop checks conditions (on each `changed()`/input event or a light timer), as long as idle CPU stays near today's numbers.
- Exact CSS, reusing the existing dialog styles where possible.

## Tour copy (Ali, 2026-11-24: "Use a copywriting specialized helper to write the content of the tour in an engaging and easy language.")

- All the words a user sees in the tours come from a dedicated copywriting helper, not from the engine's builder. That covers the first-run welcome, every stop title and body, the confirmation words, the button labels, the goodbye text and the menu items.
- The helper's brief: this design's stop lists and copy rules, BRAND.md's voice section, and the writing guidance from the frontend-design skill. It writes for a filmmaker who has never used 3D software: engaging and warm, but plain, short and specific.
- The copy lives in one place, `src/tour-copy.js`, keyed by stop id, so the builder never writes UI text and the wording can be changed later without touching the engine.
- Claude reviews the copy against the voice rules (no "please", "just", "simply", "easy" or "!", sentence case, at most 2 sentences, verbs on buttons). Ali sees the full copy in his checklist.

## Build order (for the plan)

0. Copy: the copywriting helper writes `src/tour-copy.js` (it runs alongside step 1).
1. Engine + basic tour + first-run question + Help menu items (gear and desktop) + tests.
2. Hands-on tour + tests.
3. Docs (docs/GUIDE.md, README mention), PROJECT.md, Ali's checklist.

Sonnet helpers build each part; an Opus reviewer checks each before the next starts; the full suite runs after each part.
