# ShotRef
Owner: Ali. Project file started 2026-11-22 (code existed from 2026-11-14 or earlier).
Read this before doing anything. Claude updates it at the end of every session.

## One sentence
A "very dumbed-down Blender" in one offline HTML file: block people and props, move the camera, export reference clips and frames for AI video models.

## Current state            (rewritten every session, 15 lines max)
Works:   All 33 review findings fixed (2026-11-23). Branding applied (logo, tab icon, welcome header). Build OK (dist/ShotRef.html, 876 KB, one file). `npm test` = 79 automatic checks, all pass (about 2 min).
Broken:  Nothing known. One parked edge case: if browser storage is 100% full, autosave turns itself off for that session (with a toast).
Next:    Ali tries the new build with his own projects (checklist C1 below).
Not yet tried by Ali: everything from the fix work. Not tested on the real claude.ai artifact page (only the local strict-rules copy).
Waiting on Ali: checklist C1, since 2026-11-23. Backup of the pre-fix version: ..\Shotref-backup-2026-11-22

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
- Single offline HTML file, no network. Why: runs from disk and as a claude.ai artifact (see CLAUDE.md).
- `state` is plain JSON and the single source of truth; three.js rebuilt from it. Why: save, undo and autosave all come from one model. (Review 2026-11-22: keep this.)
- Assets kept out of undo snapshots. Why: snapshots stay ~25 KB even with 123 objects.

## How to build and run
Build: `npm install` once, then `npm run build` -> `dist/ShotRef.html` (0.7 s)
Run:   open `dist/ShotRef.html` in Chrome or Edge
Test:  `npm test` (78 checks, headless Edge, ~2 min; `node test/smoke.cjs --only <word>` for one). Speed: `node test/perf.cjs [file]`. Readable build: `npm run build:debug`.
Sandbox (claude.ai rules): see CLAUDE.md.

## Machine and tool quirks  (add the moment a trap is found)
- Chrome is not installed; Microsoft Edge is at `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe` -> use it for headless tests.
- playwright-core 1.49 cannot drive this Edge (v156); 1.65.1 works (installed in scratchpad only).
- The Claude desktop browser pane blocks the sandbox iframe page (net::ERR_BLOCKED_BY_CLIENT) and runs at ~30 fps -> open `/app.html` directly for CSP checks; use headless Edge for timings.
- Folder is not a git repository -> back up with a full copy (or `git init`, with Ali's OK) before any fix work.

## Ground rules
Never: change project files during a review (except PROJECT.md); add a test framework or dependency without asking Ali; commit or publish without asking.
Storage: build output in `dist/` (git-ignored).

## Tests and targets         (targets set before the work; change only under Target changes)
| Test | How to run | Target | Set by | Status |
|------|------------|--------|--------|--------|
| Build | `npm run build` | prints "ok", no errors | Claude | PASS 2026-11-22 (854 KB, 0.68 s) |
| Load, no console errors | headless Edge, ShotRef.html and app.html (CSP) | 0 errors | Claude | PASS 2026-11-22 |
| MP4 export 5 s 1080p default scene | `__shotref.exportVideo()` | completes, file > 0 | Claude | PASS 2026-11-22 (734 ms in desktop pane; 1228 ms headless) |
| Smoke suite | `npm run build && npm test` | all pass, 0 known-fail | Claude | PASS 2026-11-23 (79/79) |
| Idle CPU, 3 objects | `node test/perf.cjs` idle3.scriptMs | lower than before | Claude | PASS 2026-11-23: 123 -> 10 ms per 3 s |
| Idle CPU, 123 objects | `node test/perf.cjs` idle123.scriptMs | lower than before | Claude | PASS 2026-11-23: 1584 -> 6 ms per 3 s |
| Ali's own check | checklist C1 | all items OK | Ali | not run |

### Known failures
- None (2026-11-23). Parked: storage probe treats a completely full localStorage as "no storage" for that session.

### Target changes          (old target stays written here)
- none

### Ali's checklists
- C1: build dist/ShotRef.html of 2026-11-23. Steps in the Handoff section. Result: (waiting)

## Ali's notes               (every request/feedback, word for word)
| Id | Date | Ali's words | Status |
|----|------|-------------|--------|
| N-001 | 2026-11-22 | "Act as a principal software engineer leading a review of my application... give me a prioritized plan covering architecture, bugs and reliability, performance, and UI/UX." | done 2026-11-22 (report published; awaiting approvals) |
| N-002 | 2026-11-22 | "Also make use of Project Keeper skill." | done 2026-11-22 (this file) |
| N-003 | 2026-11-22 | "Approve all" | done 2026-11-23 (all 33 findings fixed; guessed: autosave option = full IndexedDB version; camera-view panel built directly instead of a mock-up first) |

### Approved and locked     (changing these needs Ali's yes)
- 2026-11-22 "Approve all": every item in the review checklist, including adding playwright-core as a dev-only test tool.

## Lessons
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
STATE     All 33 review findings fixed and verified (2026-11-23). 78/78 automatic checks pass. Pre-fix backup: ..\Shotref-backup-2026-11-22.
CHANGED   New: test/smoke.cjs, test/perf.cjs, src/project.js (open/clean-up of project files), src/keys.js (keyframe maths), docs/plans/2026-11-22-review-fixes.md. Changed: src/main.js, src/index.html, build.mjs, package.json (playwright-core dev tool; esbuild moved to dev), CLAUDE.md, README.md. Autosave now keeps photos/models in IndexedDB; Open asks first and can be undone; damaged files are refused; export is locked while running; walk-path Cancel fixed; camera tools show in Camera view; first launch shows starter sets; app only redraws when something changes.
TESTS     npm test 78/78. Idle script per 3 s: 3 objects 123 -> 10 ms, 123 objects 1584 -> 6 ms (headless Edge, same machine). Export time: no clear change (single runs 0.9-2.1 s).
OPEN      Parked: completely full localStorage -> autosave off for that session. Small leftovers listed in Claude's ledger as "leave" (e.g. heavy shot shortening can merge keys; digit type-ahead off in the FPS dropdown).
TRIED     The browser pane can't load the sandbox iframe page -> open /app.html directly instead.
FINDINGS  claude.ai rules (both storages throwing) were simulated headless: app boots, says "Autosave isn't available here. Use Save to keep your work.", exports work.
NEXT      Ali runs checklist C1:
          Build: dist/ShotRef.html (2026-11-23). Open it in Chrome or Edge.
          1. First open -> the starter-set picker shows (Quick start guide button inside it).
          2. Load a location photo, replace it with another, close and reopen the file -> the second photo is still there.
          3. Open one of your saved .shotref.json projects -> it asks "Open file" first; after opening, Ctrl+Z brings back the previous scene.
          4. Select a person, Draw walk path, click Cancel on the bar -> path mode ends, you stay in the Editor.
          5. Press C (Camera view) with nothing selected -> lens, shot sizes and Set start/Set end are on the right.
          6. Export an MP4, try clicking around while it renders -> nothing behind the window reacts; the clip comes out at the chosen size.
          7. Optional: publish the new build as the claude.ai artifact and check Save and Export download there.
          Reply with the numbers that didn't work, and what you saw.

## Log                       (append only, dated, real numbers; always last)
- 2026-11-22 project file created during a full review. Tools found: Node 24.21.0, npm 11.19.0, Python 3.12.10, Edge 156 (no Chrome). Deps: three 0.187.0, mp4-muxer 5.2.2, esbuild 0.28.2. No git.
- 2026-11-22 full review (review only, no code changes). 33 findings: 4 High, 5 Medium, 24 Low; 0 Critical after verification. Report: https://claude.ai/artifact/TJioX5TrTD7WdSdGpriewz. Baseline: build 0.68 s/854 KB; load 113 ms DCL; MP4 5 s 1080p 734 ms (pane) / 1228 ms (headless); 4K 5 s 1960 ms.
- 2026-11-23 all 33 findings fixed ("Approve all"). 8 tasks + final fix wave, each with failing-test-first and an independent review (review rounds caught and fixed 12 further problems). npm test 78/78. Idle script per 3 s: 123 -> 10 ms (3 objects), 1584 -> 6 ms (123 objects). Build 872 KB. Backup ..\Shotref-backup-2026-11-22.
- 2026-11-23 brand kit made in branding/ (BRAND.md + SVG/PNG/ICO). Logo = Ali's reference refined (frame corners + orange camera path); orange-tile app icon for web + Windows. Not yet applied to the app.
- 2026-11-23 branding applied to the app: title "ShotRef", SVG+PNG tab icon (data: URLs), theme-color, top-bar mark + tagline (word hidden below 1100 px), first-launch welcome header "Start a shot" with slogan. New smoke check; npm test 79/79. Build 876 KB.
