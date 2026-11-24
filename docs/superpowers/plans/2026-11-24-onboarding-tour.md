# Onboarding Tours Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two in-app tours (a basic one and a hands-on one on a practice stage), a first-run question, and Help-menu entries. When the tours end, newcomers know where everything in ShotRef is.

**Architecture:** A small in-house spotlight engine (`src/tour.js`) draws the dim, orange viewfinder corners and a bubble, and steps through a list of stops. The stop lists and their `before`/`waitFor` hooks live in `src/main.js`, because they read app state. All user-facing words live in `src/tour-copy.js`. The hands-on tour runs on a practice stage. `enterPractice()`/`leavePractice()` in `main.js` set the user's scene aside in memory, and nothing persists while practising.

**Tech Stack:** Plain JS ES modules bundled by esbuild into the single `dist/ShotRef.html`; three.js (existing); Electron for the desktop Help menu; tests are playwright-core in `test/smoke.cjs` and `test/desktop.cjs`.

**Spec:** `docs/superpowers/specs/2026-11-24-onboarding-tour-design.md` (approved by Ali 2026-11-24). Every implementer reads it together with this plan.

## Orchestration (Ali, 2026-11-24: "orchestrate the development across Opus and Sonnet helpers")

| Role | Model | Tasks |
|---|---|---|
| Copywriter | Sonnet | Task 1. Runs alongside Task 2. |
| Implementer | Sonnet | Tasks 2 to 6, one at a time |
| Task reviewer | Opus | After each task: checks against the spec and this plan, runs the task's tests and checks the screenshots |
| Final reviewer | Opus | Whole branch, after Task 6 |
| Orchestrator (this session) | Opus | Dispatches, settles review findings, runs the full suites, keeps PROJECT.md |

Effort: medium for every helper (as on earlier ShotRef rounds). Work happens on branch `feature/onboarding-tour`, with one commit per task. Nothing is pushed or released without Ali's yes.

## Global Constraints

- Single offline HTML file: no new dependency, library, CDN, font or network request. No `blob:` URLs, no `eval`, no inline `on*=` attributes in HTML strings (claude.ai CSP).
- No `alert`, `confirm` or `prompt`. Every `localStorage` access goes in try/catch.
- Colours come from the existing `:root` variables only: `--acc` #FF9A3C, `--acc2` #FFB870, `--bg` #141518, `--ink` #E7E9EC, plus the existing dialog background and border variables.
- Copy rules (BRAND.md voice): sentence case; buttons are verbs of 1 to 3 words; no "please", "just", "simply", "easy" or "!"; the app never says "I"; at most 2 sentences per stop body.
- z-index: the tour layer is 50. It sits above dialogs (about 30), below the toast (60) and below `#ctxMenu` (70).
- Motion: the corners travel in 350 ms with ease-in-out. The hands-on "done" pause is 700 ms. With `prefers-reduced-motion: reduce`, there is no travel.
- Bubble max width is 340 px. Below a 900 px wide window it pins to the bottom centre at full width minus 16 px.
- Idle: no animation loop while the tour is idle. Re-measuring happens on resize, on stop change and from `frame()` only while a tour is active.
- After every task: `npm run build && npm test` all pass. From Task 4 on, also `npm run test:desktop` all pass, and afterwards `tasklist | grep -ci electron` prints 0.
- All files keep LF line endings.

## Review Focus

1. **Starting a tour while an export runs or a dialog is open.** Expected: the tour refuses to start and shows a toast, except the first-run welcome window, which closes itself first. Test in Task 2.
2. **The window is resized, or Advanced controls are switched, mid-tour.** Expected: the corners and bubble re-place themselves; a target that becomes hidden shows as a centred bubble, with no error. Test in Task 3.
3. **Ctrl+Z pressed many times on the practice stage.** Expected: undo stops at the start of the practice stage and never reaches the user's real scene. Test in Task 4.
4. **The page is reloaded or closed mid hands-on tour.** Expected: the autosave still holds the real scene, and it reopens. Test in Task 4.
5. **A "Save changes first?" box or a right-click menu appears while the tour is on screen.** Expected: it shows above the dim and can be clicked, and ending the tour from inside it doesn't leave the box orphaned. Test in Task 4.

## File structure

- Create `src/tour.js`: the engine only. It has no knowledge of ShotRef state, and stops are passed in.
- Create `src/tour-copy.js`: every tour string, keyed by stop id.
- Modify `src/main.js`:
  - stop lists `BASIC_STOPS` and `HANDS_STOPS`, plus `startTour(kind)`;
  - the practice stage;
  - the launch points;
  - the first-run flow (near `openStarters`, about line 3617; the boot code at about 5440);
  - the gear menu (`gearMenuItems`, about 2842);
  - `onDesktopMenu` (about 4664);
  - `__shotref` hooks.
- Modify `src/index.html`:
  - tour CSS;
  - the `#mTour` first-run dialog;
  - a tour buttons line in `#mHelp` (about line 518).
- Modify `electron/main.cjs`: two Help menu items (`buildMenu`, about line 169).
- Modify `test/smoke.cjs` (append checks) and `test/desktop.cjs` (one check).
- Modify `docs/GUIDE.md`, `README.md`, `CLAUDE.md` and `PROJECT.md` (Task 6).

## Stop ids (shared by Tasks 1, 3 and 5)

- Basic: `b-welcome`, `b-steps`, `b-add`, `b-picture`, `b-view`, `b-panel`, `b-timeline`, `b-file`, `b-gear`, `b-bye`.
- Hands-on: `h-welcome`, `h-build`, `h-place`, `h-drag`, `h-rightclick`, `h-scenetab`, `h-top`, `h-camera`, `h-cambar`, `h-focus`, `h-play`, `h-key`, `h-shots`, `h-gear`, `h-export`.

---

### Task 1: Tour copy (copywriter helper, Sonnet)

**Files:**
- Create: `src/tour-copy.js`

**Interfaces:**
- Produces: `export const TOUR_COPY` with this shape:
  ```js
  {
    ui: { next, back, end, finish, skip, progress: (n, total) => string },   // progress e.g. "3 of 8"
    welcome: { title, body, quick, hands, notNow },                          // first-run window #mTour
    menu: { heading, quick, hands },                                         // gear Help heading + items; desktop Help items reuse quick/hands
    helpPage: { lead, quick, hands },                                        // line at the top of the Quick start page
    basic: { [stopId]: { title, text } },
    hands: { [stopId]: { title, text, done? } },                             // done = one word shown with the tick, e.g. "Placed"; only on waitFor stops
  }
  ```

- [ ] **Step 1: Brief the copywriter.** It reads:
  - the spec sections "The stops", "Visual design" and "Tour copy";
  - `branding/BRAND.md` §2;
  - this plan's stop ids.

  The welcome body must say that the tours are always in the Help menu later (Ali's words). The `h-welcome` body must say it's a practice stage and that their scene comes back when the tour ends. `h-focus` must mention that the tour framed the person for them.
- [ ] **Step 2: Write `src/tour-copy.js`** with an entry for every stop id above. Fixed button labels: `ui.next` "Next", `ui.back` "Back", `ui.end` "End tour", `ui.finish` "Finish", `ui.skip` "Skip this step". Fixed menu items: `menu.quick` "Take the quick tour", `menu.hands` "Try it hands-on".
- [ ] **Step 3: Orchestrator voice check:**
  ```bash
  node -e "import('./src/tour-copy.js').then(({TOUR_COPY:c})=>{const s=JSON.stringify(c);const bad=s.match(/\b(please|just|simply|easy|easily)\b|!|\bI\b/gi);console.log(bad?'FAIL '+bad:'ok')})"
  ```
  Expected: `ok`. Also check that each stop body has at most 2 sentences.
- [ ] **Step 4: Commit:** `git add src/tour-copy.js && git commit -m "Tour copy"`

### Task 2: Spotlight engine

**Files:**
- Create: `src/tour.js`
- Modify: `src/index.html` (tour CSS only), `src/main.js` (import; one call in `frame()`; `__shotref.tour` hook)
- Test: `test/smoke.cjs`

**Interfaces:**
- Consumes: `TOUR_COPY.ui` (Task 1). Until Task 1 lands, use a stub with the same keys.
- Produces:
  ```js
  // stop: { id, target: string|(() => Element|null)|null, title, text, before?: () => void,
  //         waitFor?: (snap) => boolean, snap?: () => any, done?: string, interactive?: boolean }
  export function runTour({ stops, ui, interactive, onEnd, canKey }) // -> { end(reason), next(), back(), get index(), get stop() }
  export function tourActive()          // -> boolean
  export function tourTick()            // re-measure + evaluate waitFor; called from main.js frame() while active
  ```
  - `onEnd(reason)` receives `'finish' | 'end' | 'esc' | 'external'`.
  - `canKey(e)` returns true when an app key must reach the app, such as Esc while there's something to cancel. The engine calls it in its capture-phase keydown handler.
  - `snap()` is taken when a stop begins; `waitFor(snap)` must report a change since then.
  - DOM:
    - one root `#tour` (z-index 50) holding `.tour-dim` (box-shadow cut-out), `.tour-corners` (four L-shaped corners) and `.tour-bubble` (`role="dialog"`, `aria-labelledby`, `aria-live="polite"`);
    - the progress path is `.tour-path` with a `.tour-dot` positioned by `index / (stops.length - 1)`;
    - the button ids are `#tourNext`, `#tourBack` and `#tourEnd`.

- [ ] **Step 1: Write the failing smoke checks** (append to `test/smoke.cjs`). Through `__shotref.tour.run(stops)`, with a 3-stop test list targeting `#bFile`, `#bMenu` and `null`, check:
  - `tour engine: shows corners around the target and a bubble that stays on screen`: corner bounds contain the `#bFile` rect plus a 6 px margin, the bubble rect is inside the viewport at 1600×900 and 1280×720, and the bubble doesn't overlap the target rect.
  - `tour engine: Next, Back, Finish; Enter and arrows work`: `index` goes 0→1→0→1→2. Finish removes `#tour`.
  - `tour engine: Esc, End tour leave nothing behind`: after each, `document.querySelector('#tour')` is null, `tourActive()` is false, focus is back on the element focused before, and Space toggles playback again.
  - `tour engine: basic mode blocks app shortcuts and clicks`: during a non-interactive tour, pressing `T` leaves `view` unchanged, and clicking `#bUndo` does nothing.
  - `tour engine: refuses to start during an export or over a dialog` (Review Focus 1): with `openModal('mSettings')` open, `run` returns null and a toast shows.
  - `tour engine: runs under the claude.ai CSP with no console errors`: open `app.html` and run the 3-stop tour. `p.__errors` is empty.
  - `tour engine: reduced motion jumps the corners`: use `page.emulateMedia({ reducedMotion: 'reduce' })`. The computed `transition-duration` of `.tour-corners` is `0s`.
- [ ] **Step 2: Run them to see them fail.** Run `npm run build && node test/smoke.cjs --only "tour engine"`. Expected: FAIL (`__shotref.tour` undefined).
- [ ] **Step 3: Implement `src/tour.js` and the CSS** to the spec's "Visual design" and "Engine behaviour" sections and the Global Constraints. Placement: try right, below, left and above the target, in that order. Choose the first side that fits in the viewport with 12 px of clearance, otherwise pin to the bottom centre. Block clicks with the `.tour-dim` element itself, plus a transparent hit-catcher over the cut-out when not `interactive`.
- [ ] **Step 4: Wire it into `main.js`.** Call `if (tourActive()) tourTick();` at the start of `frame()`, and keep drawing while the tour is active only when a stop's target can move (the picture). Expose `__shotref.tour = { run, active: tourActive, end }`.
- [ ] **Step 5: Run the checks again.** Expected: all `tour engine` checks PASS. Then run `npm test` (all pass).
- [ ] **Step 6: Orchestrator look.** Take screenshots at 1600×900 and 1280×720 with the corners on `#bFile`. Check them against the spec's visual list.
- [ ] **Step 7: Commit:** `git commit -m "Tour engine: spotlight corners, bubble, keyboard"`

### Task 3: Basic tour, first-run question, Help menu items

**Files:**
- Modify: `src/main.js`, `src/index.html`, `electron/main.cjs`
- Test: `test/smoke.cjs`, `test/desktop.cjs`

**Interfaces:**
- Consumes: `runTour`, `tourActive` (Task 2), `TOUR_COPY` (Task 1).
- Produces:
  - `startTour(kind: 'basic' | 'hands')` in `main.js`. This is the only entry point.
  - Desktop menu commands `'tour-basic'` and `'tour-hands'`, handled in `onDesktopMenu`.
  - Prefs `tourBasicDone` and `tourHandsDone`.
  - `__shotref.startTour`.
  - Until Task 5, `startTour('hands')` only shows a toast: "The hands-on tour is coming." This line is removed in Task 5.

- [ ] **Step 1: Write the failing checks:**
  - `basic tour: every stop finds a visible target at 1600x900 and 1280x720`: run through all `BASIC_STOPS` with Next. For every non-null target, the element exists and has a non-zero rect inside the viewport, and there's no `console.warn` containing "tour stop".
  - `basic tour: Advanced controls switched and window resized mid-tour` (Review Focus 2): at `b-panel`, call `setSimple(!simple)` and resize to 1100×700. The corners re-place to the target rect within 2 frames, and there are no errors.
  - `first run asks about the tour, once`: in a fresh context, `#mTour` is visible and `#mStart` hidden. "Not now" closes it and opens `#mStart`. A reload shows neither.
  - `first run: Take the quick tour runs the basic tour, then the starter picker`: clicking `#tourQuick` starts the tour. Finish opens `#mStart`.
  - `first run question is skipped for restored, opened and embedded sessions`: with a restored autosave, `#mTour` stays hidden. The same applies with `__SHOTREF_EMBED__`.
  - `Help heading in the gear menu starts both tours; Quick start page has both buttons`.
  - In `test/desktop.cjs`: `Help menu has the two tour items and they reach the page`. Find them in `Menu.getApplicationMenu()` by label, click the first one, and check that `__shotref.tour.active()` is true.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement `BASIC_STOPS`** (ids and targets from the spec's "The stops" basic list) and `startTour`:
  - Basic `before` hooks only switch the view, the step and the left tab; they never edit `state`.
  - On end, `setPref('tourBasicDone', true)`. If the tour came from first run, `openStarters(true)` follows.
- [ ] **Step 4: Implement the first-run flow.**
  - In the boot code (main.js about line 5444), open `#mTour` where `openStarters(true)` is called today, under the same conditions. `#mTour` uses `TOUR_COPY.welcome` and the existing dialog styles.
  - The buttons are `#tourQuick`, `#tourHands` and `#tourNo`. Each closes `#mTour`. Quick and Hands start the tour (`firstRun: true`); No calls `openStarters(true)`.
  - The `shotref.seenHelp` flag stays the single first-run flag.
- [ ] **Step 5: Add the Help heading to `gearMenuItems()`.**
  - Under a `{ head: TOUR_COPY.menu.heading }`, add the items `tour-basic` and `tour-hands`, followed by the existing Quick start and About items.
  - Each tour item gets `check: getPref('tourBasicDone' / 'tourHandsDone', false)`.
  - Add `TOUR_COPY.helpPage` buttons at the top of `#mHelp`.
  - Add `tour-basic` and `tour-hands` to `onDesktopMenu`.
  - In `electron/main.cjs`, add both items after "Quick start" in the Help menu: `send('shotref:menu', 'tour-basic' | 'tour-hands')`.
- [ ] **Step 6: Run the checks again.** Expected: PASS. Then `npm test` and `npm run test:desktop` (all pass, 0 Electron processes left).
- [ ] **Step 7: Orchestrator look.** Screenshot every basic stop at 1280×720 and check against the spec, especially that no bubble covers its own target.
- [ ] **Step 8: Commit:** `git commit -m "Basic tour, first-run question, Help menu items"`

### Task 4: Practice stage

**Files:**
- Modify: `src/main.js`
- Test: `test/smoke.cjs`, `test/desktop.cjs`

**Interfaces:**
- Consumes: `replaceProject`'s set-aside fields (main.js about line 3643) as the list of what to keep, plus `buildState` and `fillStarter('empty')`.
- Produces:
  - `enterPractice()` and `leavePractice()`. `leavePractice()` is idempotent and returns a boolean telling whether it restored anything.
  - The `let practicing = null` module variable. Add it to the shared-`let` comment block at the top of `main.js`.
  - The guard `endPracticeFirst(go: () => void)`: if `practicing` is set, it ends the tour with reason `'external'` and calls `leavePractice()`, then calls `go()`.
  - `__shotref.practicing()`.

- [ ] **Step 1: Write the failing checks.** These are one per path, as the spec requires. The "same" comparison covers `JSON.stringify(stateForSave())`, the asset id set, `history().length` / `hi`, `platform.isDirty()` and the document identity (`platform.currentName()`).
  - `practice: Finish, End tour and Esc each bring the scene back exactly`: test a scene with 3 objects, a plate photo and 4 undo steps, marked unsaved.
  - `practice: nothing is written while practising`: spy on the `localStorage.setItem` calls for the `shotref.autosave` key and on IndexedDB `projects` puts. The count during practice is 0.
  - `practice: reload mid-tour reopens the real scene` (Review Focus 4): start the hands-on tour, add a person, reload. The restored scene equals the pre-tour scene.
  - `practice: undo stops at the practice stage` (Review Focus 3): add 2 items, press Ctrl+Z 10 times. Practice has 0 objects and the real scene is still untouched after End tour.
  - `practice: Open, New, Save, Save as, Recent and dropping a file end the tour first`: for each one, `practicing()` is false and the real scene is back before that action's own dialog or confirm appears.
  - `practice: a Save-changes box over the tour is clickable and nothing is left behind` (Review Focus 5): with the real scene unsaved, trigger New mid-tour. The tour ends, then `#mConfirm` shows with z-index above 50, and choosing "Don't save" leaves no `#tour`.
  - `practice: exporting a video ends the tour first`.
  - In `test/desktop.cjs`: `closing the window mid hands-on tour asks about the real scene`. With an unsaved real scene, send close-request mid-tour. The confirm text names the real project, and `practicing()` is false.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement `enterPractice()`/`leavePractice()`** to the spec's "The practice stage" section.
  - `enterPractice` keeps the same field list as `replaceProject`'s `prev`, plus `view`, the step and the editor camera pose. It swaps in the practice state, resets `hist` to a single snapshot, and calls `restore(snapshot())`.
  - `leavePractice` puts every field back and calls `restore(snapshot())`, `syncTopUI()` and `requestRender()`.
- [ ] **Step 4: Add the `practicing` guards** at the source, so one check covers every caller:
  - `autosave()` and `flushAutosave()` return early;
  - the recent-projects writer (`saveRecentNow` and the timer that calls it) returns early;
  - `platform.setDirty` and the title update are skipped;
  - `endPracticeFirst` wraps `openDialog`, `openStarters`, `saveProject`, `openRecent`, the drop handler, `platform.onOpenFile`, `onDesktopMenu` (all commands except `tour-*`), `closeRequested`, `exportVideo` and `whileLocked`.
- [ ] **Step 5: Run the checks again.** Expected: PASS. Then `npm test` and `npm run test:desktop` (all pass, 0 Electron processes).
- [ ] **Step 6: Commit:** `git commit -m "Practice stage for the hands-on tour"`

### Task 5: Hands-on tour

**Files:**
- Modify: `src/main.js`
- Test: `test/smoke.cjs`

**Interfaces:**
- Consumes:
  - `runTour({ interactive: true })` (Task 2);
  - `startTour` (Task 3);
  - `enterPractice` and `leavePractice` (Task 4);
  - `goStep`, `currentStep`, `setView`, `view`, `frameShot('medium', id)`, `focusLensAt`, `playing`, `select`.
- Produces: `HANDS_STOPS`. `startTour('hands')` now really runs the tour; remove the Task 3 toast.

- [ ] **Step 1: Write the failing checks:**
  - `hands-on tour: each try-stop advances only after its action, through the real UI`. Drive with playwright clicks and keys, not hooks, wherever a person could:
    - `h-build`: click Build;
    - `h-place`: click Person in `#addArea`, then click the canvas centre;
    - `h-drag`: drag the person 150 px;
    - `h-rightclick`: right-click the person;
    - `h-scenetab`: click the Scene tab;
    - `h-top`: press T;
    - `h-camera`: press C;
    - `h-focus`: double-click the person's screen point taken from `__shotref.evalObj`;
    - `h-play`: press Space;
    - `h-export`: click `#bExport`.

    For each one, assert that the stop doesn't advance before the action, shows `done` with a tick after it, and moves on within 1 s. The tour ends on `h-export`, then the real scene is back.
  - `hands-on tour: a condition already true never skips a stop`: start with view = top before `h-top`. The stop still waits.
  - `hands-on tour: Skip this step moves on without the action`.
  - `hands-on tour: Esc while placing cancels placing, not the tour`: at `h-place`, click Person, press Esc. `placing` is null and `tourActive()` is true. A second Esc ends the tour.
  - `hands-on tour: right-click menu shows above the dim`: at `h-rightclick`, the `#ctxMenu` z-index is above 50 and it's visible at its click point.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement `HANDS_STOPS`** (ids, targets and waits from the spec's hands-on list and its "Builder check answers" section):
  - each `snap()` records the value its `waitFor` compares against;
  - `h-focus.before` selects the tour's person and calls `frameShot('medium', id)`;
  - `h-cambar.before` and `h-focus.before` call `setView('camera')`;
  - `h-place.before` and `h-drag.before` call `goStep('build')`;
  - `canKey` lets Esc through when `placing`, `pathMode`, `rec`, `focusPick` or an open `#ctxMenu` is active.
  - On end: `setPref('tourHandsDone', true)`, then `leavePractice()`.
- [ ] **Step 4: Run the checks again.** Expected: PASS. Then `npm test` and `npm run test:desktop` (all pass).
- [ ] **Step 5: Orchestrator look.** Screenshot every hands-on stop at 1600×900 and 1280×720 and check them against the spec.
- [ ] **Step 6: Commit:** `git commit -m "Hands-on tour on the practice stage"`

### Task 6: Docs, project file, final review

**Files:**
- Modify: `docs/GUIDE.md`, `README.md`, `CLAUDE.md`, `PROJECT.md`

- [ ] **Step 1: Update the docs.**
  - `docs/GUIDE.md`: a short "Tours" section saying where to find both tours.
  - `README.md`: one line in the features list.
  - `CLAUDE.md` Architecture: `src/tour.js`, `src/tour-copy.js`, `practicing` and the `enterPractice`/`leavePractice` rules, and `startTour`.
- [ ] **Step 2: Final whole-branch review** by an Opus reviewer against the spec. Fix every Critical or Important finding, with a test for each.
- [ ] **Step 3: Run the full suites one last time.** Run `npm run build && npm test && npm run test:desktop`. Expected: all pass. Record the counts.
- [ ] **Step 4: Update PROJECT.md.** Write the Current state, a Log line with numbers, the N-011 status and the Handoff, plus Ali's checklist C4:
  1. a fresh browser profile shows the welcome question;
  2. the quick tour runs;
  3. the hands-on tour works, and the scene comes back;
  4. the Help menu has both tours (web and desktop);
  5. Ali reads the tour wording and says what he'd change.
- [ ] **Step 5: Commit:** `git commit -m "Docs and project notes for the tours"`. Then ask Ali whether to merge to `main`, push, and include this in the next release.
