---
name: release
description: Ship a new ShotRef desktop version to GitHub Releases (version bump, What's new, release notes, full tests, Windows installers, publish, check the update feed). Use when Ali says "release", "publish the release", "ship 1.x.y" or similar. Not for the claude.ai artifact.
---

# Release ShotRef

Ali is not a coder: report in plain words, one line per step. Stop and ask at every **ASK** below. A release is public and can't be taken back quietly.

## 0. Where things stand (no changes yet)

- `git branch --show-current` must be `main`. If the work is on another branch, ASK before merging it.
- Version: `node -p "require('./package.json').version"`. Is it newer than the last tag (`gh release list -L 1`)? If not, propose the next number (fix = x.y.Z+1, features = x.Y+1.0) and **ASK**.
- `git status --short`: list anything uncommitted in plain words, as "release files" or "other work". Other work stays out unless Ali says otherwise.

## 1. Words (one ASK for all three)

- `electron/whats-new.json`: newest entry first, `{"version": "<v>", "items": [...]}`. Items are short, plain sentences about what the user sees (CLAUDE.md voice: sentence case, no code names). Cumulative display is automatic, so cover this version only.
- `docs/RELEASE-NOTES-<v>.md`: the same points for GitHub readers, plus "Download: ShotRef-Setup-<v>.exe (installer) or ShotRef-<v>-portable.exe. Unsigned: Windows may warn; choose More info, Run anyway."
- Screenshots in `docs/img/` only if the look changed. Say which ones changed.

Show Ali the What's new items and **ASK**: "Ship with these words?"

## 2. Tests (full suite, the one time it is required)

- `npm run build && npm test` (about 9 min, run in the background), then `npm run test:desktop`.
- Afterwards `tasklist | grep -ci electron` must print 0.
- Any failure: stop. Fix it or report it with the check's name. Never release on a failing test.

## 3. Commit and push (ASK)

- Commit only the release files (version, What's new, notes, screenshots, and fixes from step 2): `release: <v>`.
- **ASK** before `git push origin main`. `publish:win` refuses to run with uncommitted or unpushed work, by design.

## 4. Build and publish (ASK)

- `npm run dist:win` (about 3 min). Check that `release/` has `ShotRef-Setup-<v>.exe`, `.blockmap`, `ShotRef-<v>-portable.exe`, and that `latest.yml` says `version: <v>`.
- **ASK**: "Publish <v> to GitHub now? Installed copies will offer the update." On yes: `npm run publish:win` (about 230 MB, a few minutes). Use `-- --draft` if Ali wants to look first.

## 5. Check the update feed

- `gh release view v<v> --json assets -q ".assets[].name"` lists all 4 files.
- `latest.yml` on the release says `version: <v>`.
- If time allows, launch the previous installed version and confirm it offers <v>. Otherwise mark that "not checked".

## 6. Record and hand over

- PROJECT.md: rewrite Current state (`<v> RELEASED <date> (<release URL>)`) and append one Log line (tests with numbers, file sizes, what wasn't checked).
- Give Ali the release link and a short checklist:
  ```
  Build: <v>, <release URL>
  1. Open your installed ShotRef -> it offers <v> -> install it
  2. After the restart -> What's new lists the <v> items
  Reply with the numbers that didn't work.
  ```
- The claude.ai artifact is a separate step. Mention it, but don't republish without Ali's yes.

## Traps already met

- Never `dialog.showMessageBox` in Electron code. Use `electron/popup.cjs` (CLAUDE.md).
- `three` and `mp4-muxer` stay devDependencies; only `electron-updater` is a runtime dependency.
- A silent failed build makes old results look new: check that the `release/` file times are newer than the last commit.
