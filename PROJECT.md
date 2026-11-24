# ShotRef
Owner: Ali. Project file started 2026-11-22 (code existed from 2026-11-14 or earlier).
Read this before doing anything. Claude updates it at the end of every session.

## One sentence
A "very dumbed-down Blender" in one offline HTML file: block people and props, move the camera, export reference clips and frames for AI video models.

## Current state            (rewritten every session, 15 lines max)
Works:   ShotRef 1.2.0 = the claude.ai version's features (artifact 6uRy4QMBjvK9Rn5PLedSUq) rebuilt into this code, plus all earlier fixes, branding and the desktop app.
         Right-click menus, double-click lens focus, Build/Frame/Export steps, takes + compare, shots + shot bar, Export panel + AI prompt, frame pack, contact sheet,
         multi-select/lock/groups, people (body types, eyeline, sitting, actions), parenting/ground/camera mount, camera tabs, light/sun, My sets, Recent projects, Settings, split view.
Builds:  dist/ShotRef.html (1.0 MB). Windows: release/ShotRef-Setup-1.2.0.exe (122 MB), release/ShotRef-1.2.0-portable.exe (111 MB), unsigned.
Tests:   npm test 265/265 (~9 min), npm run test:desktop 14/14. Final whole-port review: Ready.
Code:    private GitHub https://github.com/alistotleLB/ShotRef (main).
Known:   walking feet slide slightly at heel strike (same in the claude.ai version). Minor parity leftovers listed in docs/plans (toolbar order, Add tab order, hint wording).
Next:    Ali runs checklist C3 (replaces C1 and C2). Then: installable web app + website.
Not yet tried by Ali: everything since 2026-11-22.

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

### Known failures
- None (2026-11-23). Parked: storage probe treats a completely full localStorage as "no storage" for that session.

### Target changes          (old target stays written here)
- none

### Ali's checklists
- C1: build dist/ShotRef.html of 2026-11-23. Steps in the Handoff section. Result: (waiting)
- C2: Windows app 1.1.0. Superseded by C3 (never run).
- C3: ShotRef 1.2.0 web + Windows. Steps in the Handoff section. Result: (waiting)

## Ali's notes               (every request/feedback, word for word)
| Id | Date | Ali's words | Status |
|----|------|-------------|--------|
| N-001 | 2026-11-22 | "Act as a principal software engineer leading a review of my application... give me a prioritized plan covering architecture, bugs and reliability, performance, and UI/UX." | done 2026-11-22 (report published; awaiting approvals) |
| N-002 | 2026-11-22 | "Also make use of Project Keeper skill." | done 2026-11-22 (this file) |
| N-003 | 2026-11-22 | "Approve all" | done 2026-11-23 (all 33 findings fixed; guessed: autosave option = full IndexedDB version; camera-view panel built directly instead of a mock-up first) |

| N-004 | 2026-11-23 | "Ok, Please orchestrate everything, Use Opus and Sonnet, However, do not go above the medium effort. Optimize for efficiency AND quality. Upload the project to github. And use all skills relevant to create a better output and more efficient workflow. Including Project Keeper and whatever you judge is helpful." | done 2026-11-23 (GitHub private repo; Phase 1 + 2 built; guessed: private repo, .shotref extension, autosave stays in browser storage) |

| N-005 | 2026-11-23 | "The right click context menu doesnt work .. I need the same menu that is implemented in the webapp version .. the same with double click to focus. It doesnt work properly. Cant you please diagnose why the UI doesnt work like the webapp does, and fix the problem." | done 2026-11-24 (cause: the claude.ai version was a newer app whose source was lost; all its features rebuilt here in 9 reviewed batches) |
| N-006 | 2026-11-23 | (asked where the newer version's source is) "Only on claude.ai" | done 2026-11-24 |
| N-007 | 2026-11-23 | "dont forget to orchestrate the tasks across Opus and Sonnet for maximum efficiency" | done (Sonnet built, Opus reviewed, medium effort) |

### Approved and locked     (changing these needs Ali's yes)
- 2026-11-22 "Approve all": every item in the review checklist, including adding playwright-core as a dev-only test tool.

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
STATE     ShotRef 1.2.0: claude.ai features rebuilt here; web + Windows builds; 265 web + 14 desktop checks pass; final review Ready.
CHANGED   9 port batches (docs/plans/2026-11-23-port-plan.md, port-inventory.md). Rulings: opening/restoring never moves or changes anything (raised items become "Can float"); old files keep their blur/shadow look; with 2+ shots a length change re-times only that shot's camera; unreadable takes/sets kept byte-exact; recents never on the edit path; IndexedDB v2 (assets + projects).
OPEN      claude.ai artifact still runs the OLD newer build (6uRy4QMBjvK9Rn5PLedSUq): republish dist/ShotRef.html there only with Ali's OK. Foot slide polish. Code signing. Auto-update. Web app install + website.
FINDINGS  reference/ (git-ignored) holds the artifact build used for the port.
NEXT      Ali runs C3:
          Build: release/ShotRef-Setup-1.2.0.exe (or portable), and dist/ShotRef.html in Chrome/Edge.
          1. Open a project you made on claude.ai (Save it there first) -> everything looks the same: people, cars, shots, takes.
          2. Right-click a person, a prop, the floor and the camera -> the same menus as on claude.ai.
          3. Double-click a person -> the lens focuses on them (depth of field on).
          4. Shift-click two items, Ctrl+G, drag -> they move together; Ctrl+L locks one.
          5. Drag a person onto a chair -> they sit; drag away -> they stand.
          6. Add a shot (+ New shot), switch between shots -> each keeps its own camera move.
          7. Take menu -> New take, change something, Compare takes -> side by side.
          8. Export step -> Frame pack (zip) and Render video -> files open.
          9. Desktop: Ctrl+S saves to the same file; close with changes -> it asks.
          10. Reopen the app -> File > Open shows your recent projects.
          Reply with the numbers that didn't work, and what you saw.

## Log                       (append only, dated, real numbers; always last)
- 2026-11-22 project file created during a full review. Tools found: Node 24.21.0, npm 11.19.0, Python 3.12.10, Edge 156 (no Chrome). Deps: three 0.187.0, mp4-muxer 5.2.2, esbuild 0.28.2. No git.
- 2026-11-22 full review (review only, no code changes). 33 findings: 4 High, 5 Medium, 24 Low; 0 Critical after verification. Report: https://claude.ai/artifact/TJioX5TrTD7WdSdGpriewz. Baseline: build 0.68 s/854 KB; load 113 ms DCL; MP4 5 s 1080p 734 ms (pane) / 1228 ms (headless); 4K 5 s 1960 ms.
- 2026-11-23 all 33 findings fixed ("Approve all"). 8 tasks + final fix wave, each with failing-test-first and an independent review (review rounds caught and fixed 12 further problems). npm test 78/78. Idle script per 3 s: 123 -> 10 ms (3 objects), 1584 -> 6 ms (123 objects). Build 872 KB. Backup ..\Shotref-backup-2026-11-22.
- 2026-11-23 brand kit made in branding/ (BRAND.md + SVG/PNG/ICO). Logo = Ali's reference refined (frame corners + orange camera path); orange-tile app icon for web + Windows. Not yet applied to the app.
- 2026-11-23 branding applied to the app: title "ShotRef", SVG+PNG tab icon (data: URLs), theme-color, top-bar mark + tagline (word hidden below 1100 px), first-launch welcome header "Start a shot" with slogan. New smoke check; npm test 79/79. Build 876 KB.
- 2026-11-23 git + private GitHub repo. Phase 1 (src/platform.js, .shotref, Save as, unsaved mark) and Phase 2 (Electron 45.4.1, electron-builder 26.18.0) built by Sonnet implementers, reviewed by Opus (5 review rounds, 8 Important findings fixed). npm test 89/89, test:desktop 13/13. Installer 121 MB, portable 111 MB. Version 1.1.0.
- 2026-11-24 port of the claude.ai version done: 9 batches + final fix wave (Sonnet built, Opus reviewed; 2 Critical and 14 Important found and fixed in review). npm test 265/265 (~9 min), test:desktop 14/14. Version 1.2.0, installer 122 MB, portable 111 MB. Desktop tests now kill Electron process trees.
