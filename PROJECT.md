# ShotRef
Owner: Ali. Project file started 2026-11-22 (code existed from 2026-11-14 or earlier).
Read this before doing anything. Claude updates it at the end of every session.

## One sentence
A "very dumbed-down Blender" in one offline HTML file: block people and props, move the camera, export reference clips and frames for AI video models.

## Current state            (rewritten every session, 15 lines max)
Works:   ShotRef 1.4.0, RELEASED 2026-11-24 (https://github.com/alistotleLB/ShotRef/releases/tag/v1.4.0): everything from 1.3.1 plus the
         quick tour (10 stops, orange viewfinder corners), the first-run question "Take a look round the set?", tour items in the Help menus.
Off:     the hands-on tour (16 stops, practice stage) is built and tested but switched off (Ali: needs a lot of improvement).
         Turn on: HANDS_TOUR_DEFAULT in src/main.js + HANDS_TOUR in electron/main.cjs (or the hidden pref handsTour for one browser).
Builds:  dist/ShotRef.html 1034 KB; release/ShotRef-Setup-1.4.0.exe (122 MB), ShotRef-1.4.0-portable.exe (111 MB), unsigned.
Tests:   npm test 318/318 (628 s), npm run test:desktop 23/23, 0 Electron left (run before merging; merge changed no code).
Code:    PUBLIC GitHub main = release 1.4.0. Branch feature/onboarding-tour merged (its GitHub copy is stale, 3 commits; PR #1 closed).
Known:   walking feet slide slightly at heel strike. claude.ai artifact still on 1.2.0 (not republished).
Next:    Ali tries checklist C4 (quick tour). Then: improve the hands-on tour (what Ali disliked: to ask), installable web app + website.
Not yet tried by Ali: the quick tour; everything since 2026-11-22.

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
- C4: quick tour, ShotRef 1.4.0 (released). Steps in the Handoff section. Result: (waiting). Hands-on items dropped (tour switched off, N-012).

## Ali's notes               (every request/feedback, word for word)
| Id | Date | Ali's words | Status |
|----|------|-------------|--------|
| N-001 | 2026-11-22 | "Act as a principal software engineer leading a review of my application... give me a prioritized plan covering architecture, bugs and reliability, performance, and UI/UX." | done 2026-11-22 (report published; awaiting approvals) |
| N-002 | 2026-11-22 | "Also make use of Project Keeper skill." | done 2026-11-22 (this file) |
| N-003 | 2026-11-22 | "Approve all" | done 2026-11-23 (all 33 findings fixed; guessed: autosave option = full IndexedDB version; camera-view panel built directly instead of a mock-up first) |

| N-004 | 2026-11-23 | "Ok, Please orchestrate everything, Use Opus and Sonnet, However, do not go above the medium effort. Optimize for efficiency AND quality. Upload the project to github. And use all skills relevant to create a better output and more efficient workflow. Including Project Keeper and whatever you judge is helpful." | done 2026-11-23 (GitHub private repo; Phase 1 + 2 built; guessed: private repo, .shotref extension, autosave stays in browser storage) |

| N-005 | 2026-11-23 | "The right click context menu doesnt work .. I need the same menu that is implemented in the webapp version .. the same with double click to focus. It doesnt work properly. Cant you please diagnose why the UI doesnt work like the webapp does, and fix the problem." | done 2026-11-24 (cause: the claude.ai version was a newer app whose source was lost; all its features rebuilt here in 9 reviewed batches) |
| N-006 | 2026-11-23 | (asked where the newer version's source is) "Only on claude.ai" | done 2026-11-24 |
| N-008 | 2026-11-24 | "Can you publish the latest release on github, along with proper basic documentation, and screenshots. Make it read to attract users." | done 2026-11-24 (repo public, MIT, v1.2.0; unsigned: Ali chose to publish anyway) |
| N-009 | 2026-11-24 | "Please add an update mechanism to the desktop app so I'm able to update the app whenever a make changes to the github." | built 2026-11-24 as 1.3.0, awaiting release + Ali's try-out (guessed: electron-updater, ask-before-download, Help menu check + auto-check switch, portable only opens the download page) |
| N-010 | 2026-11-24 | (screenshot with arrow) "Move these buttons as pet the arrow, and give them a title of \"View\" .. In their place, add a \"Camera Settings\" button..." then "skip the camera settings button for now" (the Frame step already opens that panel) | done 2026-11-24 (Editor/Top/Camera + split moved to a centred View group in the Shots row; not released yet) |
| N-011 | 2026-11-24 | "add: onboarding tour. Basic onboaring, and advanced interactive onboarding." then "Let's start with the onboarding process. Give me a clear plan before execution. I want you to orchestrate the development across Opus and Sonnet helpers. Use project keeper, and use all helpful skills for this tast." Answers: "Let's stop at \"they know where things are\"", "A: spotlight engine", "make sure to use UI/UX design skills", "Practice stage", then "Approved, but take these points into consideration: 1) On first run only, ask the user is they would like to take the tour. Mention that the tour can be taken later through the Help menu. 2) Use a copywriting specialized helper to write the content of the tour in an engaging and easy language." | built 2026-11-24 on branch feature/onboarding-tour, awaiting C4 (design docs/superpowers/specs/2026-11-24-onboarding-tour-design.md); guessed: "Help menu" = desktop Help menu + a Help heading in the gear menu |
| N-012 | 2026-11-24 | "I didn't like the long tour, it needs a lot of improvement, is there a way to keep the code, but disable the feature for now until we improve it?" | done 2026-11-24 (hands-on tour switched off: all entry points hidden, code and tests kept; quick tour stays; guessed: "the long tour" = the hands-on tour) |
| N-013 | 2026-11-24 | "publish the release when ready" | done 2026-11-24 (v1.4.0 published) |
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
STATE     ShotRef 1.4.0 released with the quick tour; the hands-on tour is built but switched off. 318/318 web, 23/23 desktop.
CHANGED   src/tour.js (spotlight engine: orange viewfinder corners, bubble, camera-path progress, keyboard, pauses while a dialog is open),
          src/tour-copy.js (all tour words; copywriter helper + controller edits), src/main.js (BASIC_STOPS, handsStops(), startTour, first-run #mTour,
          practice stage enterPractice/leavePractice/endPracticeFirst, guards on autosave/recents/platform.hold), electron/main.cjs (Help menu items),
          docs (GUIDE "Tours", README line, CLAUDE.md). Design: docs/superpowers/specs/2026-11-24-onboarding-tour-design.md; plan: docs/superpowers/plans/2026-11-24-onboarding-tour.md.
TESTS     npm test 317/317 (640 s) and test:desktop 23/23 on a build newer than the last commit, run by Claude 2026-11-24.
OPEN      Parked minors: refusal toast is generic during the brief boot photo load; after a dialog closes mid-tour, keyboard focus is on the page not the bubble;
          a photo decode can flash on the practice stage for one frame; drop test doesn't assert the image; one timing check allows 1.2 s.
          Hands-on tour off until improved. claude.ai artifact not republished (still 1.2.0). Unsigned builds as before.
FINDINGS  Review rounds found 2 work-loss races (see Lessons) and a dialog-under-tour bug; all fixed with tests.
NEXT      Ali runs C4 (1.4.0: the Windows app updates itself, or the release page has ShotRef.html):
          1. Open ShotRef.html in an InPrivate window -> "Take a look round the set?" appears before the starter sets; it offers the quick tour and Not now.
          2. Click Take the quick tour -> orange corners frame each part; Next, Back and End tour work; at the end the starter sets open.
          3. Reload -> the question does not appear again.
          4. Gear menu -> Help -> Take the quick tour runs it again; press ? -> Quick start has the tour button at the top.
          5. Windows app: Help menu -> Take the quick tour works; there is no hands-on item.
          6. Read the tour wording -> tell me any line you would change.
          Also: tell me what you disliked about the hands-on tour, so it can be improved.
          Reply with the numbers that didn't work, and what you saw.

## Log                       (append only, dated, real numbers; always last)
- 2026-11-22 project file created during a full review. Tools found: Node 24.21.0, npm 11.19.0, Python 3.12.10, Edge 156 (no Chrome). Deps: three 0.187.0, mp4-muxer 5.2.2, esbuild 0.28.2. No git.
- 2026-11-22 full review (review only, no code changes). 33 findings: 4 High, 5 Medium, 24 Low; 0 Critical after verification. Report: https://claude.ai/artifact/TJioX5TrTD7WdSdGpriewz. Baseline: build 0.68 s/854 KB; load 113 ms DCL; MP4 5 s 1080p 734 ms (pane) / 1228 ms (headless); 4K 5 s 1960 ms.
- 2026-11-23 all 33 findings fixed ("Approve all"). 8 tasks + final fix wave, each with failing-test-first and an independent review (review rounds caught and fixed 12 further problems). npm test 78/78. Idle script per 3 s: 123 -> 10 ms (3 objects), 1584 -> 6 ms (123 objects). Build 872 KB. Backup ..\Shotref-backup-2026-11-22.
- 2026-11-23 brand kit made in branding/ (BRAND.md + SVG/PNG/ICO). Logo = Ali's reference refined (frame corners + orange camera path); orange-tile app icon for web + Windows. Not yet applied to the app.
- 2026-11-23 branding applied to the app: title "ShotRef", SVG+PNG tab icon (data: URLs), theme-color, top-bar mark + tagline (word hidden below 1100 px), first-launch welcome header "Start a shot" with slogan. New smoke check; npm test 79/79. Build 876 KB.
- 2026-11-23 git + private GitHub repo. Phase 1 (src/platform.js, .shotref, Save as, unsaved mark) and Phase 2 (Electron 45.4.1, electron-builder 26.18.0) built by Sonnet implementers, reviewed by Opus (5 review rounds, 8 Important findings fixed). npm test 89/89, test:desktop 13/13. Installer 121 MB, portable 111 MB. Version 1.1.0.
- 2026-11-24 port of the claude.ai version done: 9 batches + final fix wave (Sonnet built, Opus reviewed; 2 Critical and 14 Important found and fixed in review). npm test 265/265 (~9 min), test:desktop 14/14. Version 1.2.0, installer 122 MB, portable 111 MB. Desktop tests now kill Electron process trees.
- 2026-11-24 claude.ai artifact 6uRy4QMBjvK9Rn5PLedSUq republished from the 1.2.0 build with the Desert overlook demo embedded (Ali: "Yes, republish it"). Checked headless first: 23 objects + photo, 0 errors.
- 2026-11-24 repo made public (MIT), release v1.2.0 with installer, portable exe and ShotRef.html; README + user guide + 6 screenshots. Ali chose to publish unsigned.
- 2026-11-24 update mechanism: electron-updater ^6.8 (only runtime dependency; three and mp4-muxer moved to devDependencies), electron/updater.cjs, Help menu items, scripts/publish-release.mjs, version 1.3.0. test:desktop 21/21. Packaged app launched and reached GitHub (404 on v1.2.0: no latest.yml yet, handled silently). Not tested: quitAndInstall (the install step) and a real update from an installed copy: needs 1.3.0 released, installed, then a later release.
- 2026-11-24 View buttons moved from the top bar into a centred "View" group in the Shots row (#shotRow: chips | View | contact sheet). Top bar is now two equal halves so the step bar stays centred (#top .topL/.topR). Found by tests and a screenshot: step bar off-centre, row 1 px too tall, and a stray "null" text. npm test 266/266, test:desktop 21/21. Docs and 6 README screenshots retaken. Not released (version still 1.3.0).
- 2026-11-24 onboarding tours (N-011): design approved, 6-task plan, built by Sonnet helpers (copywriter + 5 builders), each task reviewed by Opus; 4 fix rounds + 1 final fix wave. Reviews caught 2 work-loss races and a dialog-under-tour bug. npm test 317/317 (640 s), test:desktop 23/23. Build 1034 KB. Branch feature/onboarding-tour, not merged. PR #1 opened by mistake and closed.
- 2026-11-24 hands-on tour switched off (N-012: code and tests kept, entry points hidden, one-tour wording). npm test 318/318 (628 s), test:desktop 23/23. Merged into main, version 1.4.0, installers built (setup 122 MB, portable 111 MB), released v1.4.0 on GitHub (Ali: "publish the release when ready"); latest.yml serves 1.4.0.
