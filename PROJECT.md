# ShotRef
Owner: Ali. Project file started 2026-11-22 (code existed from 2026-11-14 or earlier).
Read this before doing anything. Claude updates it at the end of every session.

## One sentence
A "very dumbed-down Blender" in one offline HTML file: block people and props, move the camera, export reference clips and frames for AI video models.

## Current state            (rewritten every session, 15 lines max)
Works:   ShotRef 1.6.0, RELEASED 2026-11-26 (https://github.com/alistotleLB/ShotRef/releases/tag/v1.6.0): UI refresh (section cards, one orange
         selected look, decluttered panels, shorter labels), picture tiles (Scene, clouds, Light from; reference art in src/tile-pics.js),
         right panel 336 px, skies with clouds, drag and drop from the Add panel, plus everything in 1.5.0 and earlier.
Off:     the hands-on tour (built, tested, switched off). Turn on: HANDS_TOUR_DEFAULT in src/main.js + HANDS_TOUR in electron/main.cjs.
Builds:  dist/ShotRef.html ~1074 KB; release/ShotRef-Setup-1.6.0.exe (122 MB), ShotRef-1.6.0-portable.exe (111 MB), unsigned.
Tests:   npm test 364/364 (659 s), test:desktop 28/28, 0 Electron left (2026-11-26, release commit 40166b6).
Code:    PUBLIC GitHub main = 1.6.0. Branch ui/refresh merged (kept locally). claude.ai artifact 6uRy4QMBjvK9Rn5PLedSUq = 1.6.0 (version 11, private, Desert overlook demo kept).
Known:   walking feet slide slightly at heel strike. Not checked: a real update from an installed copy to 1.6.0.
Next:    Ali updates the installed app (C7). Then UI phase 4 needs Ali's choices: camera tabs 5->3, one-click moves as 7 paired rows,
         steps vs Editor/Top/Camera, motion feel off the timeline, outliner grouping, Take menu placement.
Not yet tried by Ali: the 1.6.0 update itself; the quick tour.

## Ali's goals              (his exact words, dated; never reworded)
"Act as a principal software engineer leading a review of my application. Inspect the actual code, run the app and safe checks where possible, and give me a prioritized plan covering architecture, bugs and reliability, performance, and UI/UX." - Ali, 2026-11-22
"This is a review only. ... do not change my project files. The only exception is PROJECT.md" - Ali, 2026-11-22
Claude's reading (from CLAUDE.md): keep it simple and visual for a TV producer; easy beats powerful; power-user detail behind Advanced.

## What matters most
The core loop never loses work and always produces a correct clip: block -> move camera -> export.

## Scope
In: blocking, camera moves, people poses/walks, location photo, MP4/PNG export, save/open, claude.ai artifact build.
Out (ideas only, see CLAUDE.md): photo-to-scene, prompt card, OpenPose styles, shot list, audio, desktop packaging.

## Decisions and why
- One codebase, three outputs (offline file, Windows app via Electron, web app). Only file handling differs, in src/platform.js. Why: every fix reaches all three.
- Electron over Tauri. Why: Ali ranked updatability, performance, stability, portability, file handling over size; Electron pins its own browser engine.
- New project files use `.shotref`. Why: Windows can't give `.shotref.json` its own icon/double-click without taking over all .json files.
- Desktop autosave stays in the app's browser storage (large quota in Electron). Why: no new code in the riskiest area.
- Single offline HTML file, no network. Why: runs from disk and as a claude.ai artifact (see CLAUDE.md).
- `state` is plain JSON and the single source of truth; three.js rebuilt from it. Why: save, undo and autosave all come from one model. (Review 2026-11-22: keep this.)
- Assets kept out of undo snapshots. Why: snapshots stay ~25 KB even with 123 objects.

## How to build and run
Build: `npm install` once, then `npm run build` -> `dist/ShotRef.html` (0.7 s)
Run:   open `dist/ShotRef.html` in Chrome or Edge. Desktop: `npm run desktop`.
Windows installers: `npm run dist:win` -> release/ (about 3 min). Desktop tests: `npm run test:desktop`.
Test:  `npm test` (78 checks, headless Edge, ~2 min; `node test/smoke.cjs --only <word>` for one). Speed: `node test/perf.cjs [file]`. Readable build: `npm run build:debug`.
Sandbox (claude.ai rules): see CLAUDE.md.

## Machine and tool quirks  (add the moment a trap is found)
- Chrome is not installed; Microsoft Edge is at `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe` -> use it for headless tests.
- playwright-core 1.49 cannot drive this Edge (v156); 1.65.1 works (installed in scratchpad only).
- The Claude desktop browser pane blocks the sandbox iframe page (net::ERR_BLOCKED_BY_CLIENT) and runs at ~30 fps -> open `/app.html` directly for CSP checks; use headless Edge for timings.
- Git + private GitHub repo since 2026-11-23. GitHub CLI is at `C:/Program Files/GitHub CLI/gh.exe` (not on the Bash PATH). Commits use the GitHub no-reply email.
- npm may skip Electron's download -> run `node node_modules/electron/install.js`.
- Playwright can't attach to the packaged ShotRef.exe -> desktop tests run `electron .`; app.close() hangs with unsaved changes -> tests kill the process.

## Ground rules
Never: change project files during a review (except PROJECT.md); add a test framework or dependency without asking Ali; commit or publish without asking.
Storage: build output in `dist/` (git-ignored).
Tests: CLAUDE.md wins over Project Keeper's "run every test after a change". While working, run the matching checks (`--only`); run the full suite once before calling a task done.
Archive: closed notes and old log lines live in `PROJECT-archive.md`, word for word. Read it only when an old decision or result is needed.

## Tests and targets         (targets set before the work; change only under Target changes)
| Test | How to run | Target | Set by | Status |
|------|------------|--------|--------|--------|
| Build | `npm run build` | prints "ok", no errors | Claude | PASS 2026-11-22 (854 KB, 0.68 s) |
| Load, no console errors | headless Edge, ShotRef.html and app.html (CSP) | 0 errors | Claude | PASS 2026-11-22 |
| MP4 export 5 s 1080p default scene | `__shotref.exportVideo()` | completes, file > 0 | Claude | PASS 2026-11-22 (734 ms in desktop pane; 1228 ms headless) |
| Smoke suite | `npm run build && npm test` | all pass, 0 known-fail | Claude | PASS 2026-11-23 (89/89) |
| Idle CPU, 3 objects | `node test/perf.cjs` idle3.scriptMs | lower than before | Claude | PASS 2026-11-23: 123 -> 10 ms per 3 s |
| Idle CPU, 123 objects | `node test/perf.cjs` idle123.scriptMs | lower than before | Claude | PASS 2026-11-23: 1584 -> 6 ms per 3 s |
| Ali's own check | checklist C1 | all items OK | Ali | not run |
| Desktop checks | `npm run test:desktop` | all pass | Claude | PASS 2026-11-23 (13/13) |
| Ali's desktop check | checklist C2 | all items OK | Ali | not run |
| Tours: smoke + desktop | `npm test`, `npm run test:desktop` | all pass | Claude | PASS 2026-11-24 (317/317, 23/23) |
| Ali's tour check | checklist C4 | all items OK | Ali | not run |

### Known failures
- None (2026-11-23). Parked: storage probe treats a completely full localStorage as "no storage" for that session.

### Target changes          (old target stays written here)
- none

### Ali's checklists
- C1: build dist/ShotRef.html of 2026-11-23. Steps in the Handoff section. Result: (waiting)
- C2: Windows app 1.1.0. Superseded by C3 (never run).
- C3: ShotRef 1.2.0 web + Windows. Steps in the Handoff section. Result: (waiting)
- C5: What's new + ShotRef message boxes, 1.5.0 (after release). Steps in the Handoff section. Result: (waiting)
- C6: UI refresh, branch ui/refresh (npm run build, open dist/ShotRef.html). Steps in the Handoff section. Result: (waiting)
- C4: quick tour, ShotRef 1.4.0 (released). Steps in the Handoff section. Result: (waiting). Hands-on items dropped (tour switched off, N-012).

## Ali's notes               (every request/feedback, word for word)
| Id | Date | Ali's words | Status |
|----|------|-------------|--------|
| (closed notes N-001 to N-016 are in PROJECT-archive.md) | | | |


| N-009 | 2026-11-24 | "Please add an update mechanism to the desktop app so I'm able to update the app whenever a make changes to the github." | built 2026-11-24 as 1.3.0, awaiting release + Ali's try-out (guessed: electron-updater, ask-before-download, Help menu check + auto-check switch, portable only opens the download page) |
| N-011 | 2026-11-24 | "add: onboarding tour. Basic onboaring, and advanced interactive onboarding." then "Let's start with the onboarding process. Give me a clear plan before execution. I want you to orchestrate the development across Opus and Sonnet helpers. Use project keeper, and use all helpful skills for this tast." Answers: "Let's stop at \"they know where things are\"", "A: spotlight engine", "make sure to use UI/UX design skills", "Practice stage", then "Approved, but take these points into consideration: 1) On first run only, ask the user is they would like to take the tour. Mention that the tour can be taken later through the Help menu. 2) Use a copywriting specialized helper to write the content of the tour in an engaging and easy language." | built 2026-11-24 on branch feature/onboarding-tour, awaiting C4 (design docs/superpowers/specs/2026-11-24-onboarding-tour-design.md); guessed: "Help menu" = desktop Help menu + a Help heading in the gear menu |
| N-018 | 2026-11-25 | "Yes, phases 1–3" | done 2026-11-25 on branch ui/refresh (not merged, not released) |
| N-017 | 2026-11-25 | "In this conversation we'll work on improving the UI and the menu panels. Use all relevant skills, as well as project keeper. Split tasks and orchestrate when needed. Use Sonnet 5.5 and Opus 5.5..." then "commit them, and start executin. The main painpoint is that the interface looks cluttered and intimidating. It's hard to find what I am looking for. There is too much wordiness and unnecesary clitter on some panels. And the colors/shades all seem too monotonous, so it's challenging to see where one section ends and the other begins." | phases 1-3 done 2026-11-25 (branch ui/refresh); phase 4 (structure) waits on Ali's choices |
| N-007 | 2026-11-23 | "dont forget to orchestrate the tasks across Opus and Sonnet for maximum efficiency" | done (Sonnet built, Opus reviewed, medium effort) |

### Approved and locked     (changing these needs Ali's yes)
- 2026-11-22 "Approve all": every item in the review checklist, including adding playwright-core as a dev-only test tool.
- 2026-11-24 "Approved, but take these points into consideration": onboarding tour design (docs/superpowers/specs/2026-11-24-onboarding-tour-design.md), including the practice stage and the first-run question.

## Lessons
- The claude.ai artifact was edited in another conversation and drifted far ahead of this folder; the desktop app was built from the old code / cause: two copies of the app with no shared source / rule: this folder (GitHub) is the only source; never publish or edit ShotRef on claude.ai without building it from here, and republish from dist/ after changes.
- Desktop tests left 72 Electron copies (288 processes) running, slowing every later run 2-3x / cause: killing only the main process on Windows / rule: kill the whole tree (taskkill /T /F); check `tasklist | grep -ci electron` = 0 after test runs.
- Each review round on file handling found a new way to lose work (open over unsaved, undo past Open, Save as + undo, restored autosave) / cause: file identity and unsaved state interact with undo and autosave / rule: any change to save/open/undo/autosave gets a reviewer and a test per path.
- Each fix's own review caught real problems the fix itself created (backup of a broken autosave lost on quota; IndexedDB clean-up deleting a broken session's photos; keyboard reaching buttons behind the export window; shortcut letters changing a focused dropdown) / cause: fixes that touch storage or keyboard interact with other features / rule: keep a review after every fix and a test for each review finding.
- Mixed CRLF/LF line endings crept into test/smoke.cjs and made diffs unreadable / cause: different editing tools / rule: keep all files LF (check with `tr -cd '\r' < file | wc -c` = 0).

## Review 2026-11-22
Full interactive report (private link): https://claude.ai/artifact/TJioX5TrTD7WdSdGpriewz
Method: Ali's 4-phase prompt. Code map, then 4 specialist reviewers (architecture, bugs, performance, UI/UX) using headless Edge, then 1 independent verifier. All 20 key findings were confirmed; 11 had their priority adjusted (mostly lowered for typical 1-10 object scenes) and 3 were added.
Overall: the core design is sound (keep the single JSON state, assets out of undo, the panel builders, single-file build). All three journeys work. The risks are in keeping work safe.

Top 3 (in order): 1) A1 autosave silently drops photos/models; 2) U1 walk-path Cancel covered by the camera preview at 1280-1536 px; 3) A2+A3+S2 safe Open (confirm, keep undo, refuse damaged files, one normalise step).
Flagged (could lose work): A1, A2, A3. Until fixed: press Save before opening another project or replacing a photo.

High:   A1 autosave drops assets · A2 damaged file can brick the app · U1 path Cancel hidden · S1 no automatic smoke test
Medium: A3 Open with no confirm/undo · A4 export settings changeable mid-export (stretched/cropped clips) · U2 programmer-language errors · U3 Camera view doesn't show camera tools · S2 no file version handling
Low:    A5-A12, U4-U8, P1-P8, S3-S5 (details in the report)
Perf baseline: cold start ~0.4 s, warm ~0.1 s; MP4 5 s 1080p ~0.7-1.2 s; 4K 10 s ~2.1 s; idle CPU 5-9% of one core for typical scenes. The 30 fps seen in the desktop pane is the pane, not ShotRef.
Not verified: the real claude.ai frame (downloads, clipboard), a normal non-headless window, slower PCs, Ali's own files.
Proposed order: Step 0 backup + smoke test (needs OK) -> quick wins -> A1, then A2+S2 -> design/measure items -> optional tidy-ups.

## Handoff                   (replaced each session)
STATE     UI refresh phases 1-3 done on branch ui/refresh (3 commits on top of c3a52ce). main still = 1.5.0 + sky work. Not merged, not released.
CHANGED   See Log 2026-11-25. Audit material: scratchpad ui-audit/ (review-visual.md, review-ia.md, review-copy.md, shoot.cjs re-captures 78 screenshots).
TESTS     npm test 362/362 (678 s), test:desktop 28/28, 0 Electron left. Final screenshots checked by Claude (camera shot tab, person panel).
OPEN      Phase 4 needs Ali: camera tabs 5->3 (Frame, Move, Lens), one-click moves as 7 paired rows, one navigation system (steps vs Editor/Top/Camera),
          motion feel off the timeline, outliner grouping, Take menu placement. Copy rows skipped: prompt labels, Help/About long text; cloud chip "Overcast" clashes with the Overcast scene preset.
          Output tab still repeats Export's aspect/size/style (phase 4, I2). Scene preset chips wrap ("Night" alone on line 2).
FINDINGS  Surfaces were 1.07-1.09:1 apart; headings were 11px muted under 13px content; 14 orange states on one screen. Tour dim colour follows --bg (test updated).
NEXT      Ali runs C6 on the web page (npm run build, open dist/ShotRef.html in Chrome/Edge):
          1. Look at the right panel -> each section is its own card with a clear white heading.
          2. Select a person -> Pose, Move & face, Eyeline, Appearance, Placement; Attach folded; "Frame with camera..." button picks the camera framing that person.
          3. Click the sun -> only sun controls (3 in normal mode); "Sky and clouds: Scene panel" goes back to the scene.
          4. Step 3 Export -> a summary line (size, aspect, style) with Change, then Export video, Frame pack, Prompt.
          5. Right-click a person -> Aim camera at this, Mount camera on this, Face camera all work.
          6. Overall: does it still feel cluttered or intimidating anywhere? Name the panel.
          Reply with the numbers that didn't work, and what you saw.

## Log                       (append only, dated, real numbers; always last)
- (2026-11-22 to 2026-11-24 entries moved to PROJECT-archive.md)
- 2026-11-25 drag and drop from the Add panel (side session, not committed): people, floor mark, props, shapes and My sets drag onto the editor, top, camera view and both split halves; the tile's own click-to-place runs when the pointer reaches the floor, so the real item is the preview and the drop is the same one undo step. Esc or letting go off the view leaves nothing. A chip with the tile follows the pointer off the view. Clicks still place as before. 3 new smoke checks; npm test 322/322 (640 s), test:desktop 28/28, 0 Electron left. Reviewed by a Sonnet helper; fixed Esc reaching the tour, the swallowed-click timing, drops over labels drawn on the view. Design: side-session notes drag-drop-design.md.
- 2026-11-25 UI audit (N-017): committed pending sky-panel work (c3a52ce); 78 screenshots (Sonnet); 3 reviews: visual (Opus, scratchpad ui-audit/review-visual.md), IA/clutter (Opus, review-ia.md), copy (Sonnet, review-copy.md, 89 rewrites). Key numbers: neighbouring surfaces 1.07-1.09:1 contrast; section headings 11px dimmer than their content; 14 orange states on one screen; ~15 settings duplicated in 2-3 places; person panel 12 sections. Colour preview (tokens, section cards, 13px headings, orange checkboxes) on branch ui/refresh, not committed. Proposal sent to Ali, awaiting approval.
- 2026-11-25 sky and clouds built on branch feature/sky-clouds (cloud cover chips, looks, drift, shuffle, a world-anchored sky dome, clouds soften the sun, sky named in the prompt); fix wave applied after visual QA. Not merged, not released.
- 2026-11-25 UI refresh phases 1-3 (N-018) on branch ui/refresh: 36da0ca (surfaces, cards, headings), a300f5a (button tiers, neutral .on, type scale 11.5/13/15, Add-panel cards, timeline clusters; Sun panel sun-only, simple sun = 3 controls, Getting started/Start from a set only on empty scene, Frame with camera… button replaces grid, Camera section removed, rare sections folded unless in use, Export format summary line, Items/Appearance renames, hint bar first 5 sessions, ground toggle only in Settings), abd3835 (~85 label rewrites, one name per thing, Opus review fixes x10, docs). Sonnet built, Opus reviewed. npm test 362/362 (678 s), test:desktop 28/28, 0 Electron left. Electron window/popup colours follow the new tokens. Not merged, not released.
- 2026-11-26 tiles: Scene/Light rows are 5 picture tiles using Ali's reference art (src/tile-pics.js, 15 KB WebP data: URLs; an engine-rendered version was built and dropped at Ali's request); cloud tiles match; right panel 300->336 px. One selected look everywhere (Ali: "why is the scene selection in orange, while the cloud selection in white?"): --sel fill + 1.5px orange ring; tabs/steps orange underline/disc; outliner and timeline rows identical; white focus ring; --accd removed. npm test 364/364, test:desktop see commit.
- 2026-11-26 token review: Higgsfield, Drive and DaVinci connectors blocked for this project (.claude/settings.local.json, git-ignored); design-council and colorist skills hidden; CLAUDE.md test rule changed to matching checks while working, full suite before done; Design rules section added to CLAUDE.md. 13 closed notes and 16 old log lines moved word for word to PROJECT-archive.md (PROJECT.md 4,300 -> about 3,000 words).
- 2026-11-26 1.6.0 RELEASED (Ali: "Yes, publish"): ui/refresh fast-forwarded into main, What's new + docs/RELEASE-NOTES-1.6.0.md, 6 README screenshots retaken (Sonnet). npm test 364/364 (659 s), test:desktop 28/28, 0 Electron. Installers 122/111 MB. Release has 5 assets; latest.yml serves 1.6.0. Not checked: update from an installed copy.
- 2026-11-26 claude.ai artifact 6uRy4QMBjvK9Rn5PLedSUq republished from 1.6.0 (Ali: "Yes, republish"), version 11, Desert overlook embed (key desert-overlook-v2) carried over from the live page. Checked headless first: 23 objects + photo, 10 picture tiles, 0 console errors. Not checked: inside the real claude.ai frame.
