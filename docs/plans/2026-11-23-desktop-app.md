# Shared platform layer + Windows desktop app — plan

**Goal:** one codebase, three outputs: the single offline HTML file (unchanged behaviour), a Windows app (Electron: installer + portable .exe), and later a hosted web app. Only file handling differs between them.

**Spec:** Ali's request 2026-11-23 ("orchestrate everything… desktop app as well as a web app"), the Electron proposal Ali accepted (Save writes back to the same file, Save as, real dialogs that remember folders, recent projects, double-click a project file to open it, exports go to a chosen folder, installer + portable .exe, branding icons), `branding/BRAND.md`, and `CLAUDE.md` (both existing environments must keep working; no network; no alert/confirm/prompt).

## Global constraints
- `dist/ShotRef.html` stays one self-contained offline file and keeps working from disk and under the claude.ai CSP (`sandbox/app.html`). No new runtime dependencies in the page.
- The page never touches Node. Electron: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; a preload exposes a small `window.shotrefDesktop` API over IPC. Block all navigation and new windows; no network requests.
- Electron loads the **same** built `dist/ShotRef.html`. No second copy of app code.
- Project file contents stay format 2 JSON. Only add fields.
- `npm run build && npm test` stays green (79 checks today) after every task. New behaviour gets a check that fails before the change.
- Plain English, sentence case UI text (see BRAND.md voice).
- Dev tools allowed (Ali approved): `electron`, `electron-builder`. Nothing else without asking.

## Decisions (Claude's, flagged to Ali)
- **File extension `.shotref`** for new saves (web and desktop). Open accepts `.shotref` and `.shotref.json`. Why: Windows associates files by the last extension, so `.shotref.json` can't get its own icon or double-click without hijacking every `.json`. Cost if wrong: one string change.
- **Autosave stays in the page** (localStorage + IndexedDB). In Electron these live in the app's own profile folder with a large quota, so no disk-autosave code is needed. Why: no new code in the riskiest area. Cost if wrong: add a disk autosave later behind the same platform API.
- No auto-update yet (needs a hosting decision). App version shown in an About box.

## Task 1 — platform layer in the page (`src/platform.js`)
- New module `src/platform.js`, imported by `main.js`. Exports `platform` with:
  - `kind`: `'desktop' | 'claude' | 'web'`.
  - `saveBlob(suggestedName, blob, {filters})` → `{ok, name?}`. Web: today's `saveFile` logic (claude downloads API or `<a download>`). Desktop: native Save dialog.
  - `saveProject(text, {saveAs})` → `{ok, name}`. Desktop: writes back to the current file path unless `saveAs` or no path yet; web: downloads `shotref-<stamp>.shotref` every time.
  - `openProject()` → `{text, name} | null`. Desktop: native Open dialog. Web: the existing `#fOpen` input.
  - `currentName()`, `setDirty(bool)` (desktop updates the window title "name • ShotRef", plus "•" when unsaved), `onOpenFile(cb)` (desktop: file passed on launch / double-click / recent menu).
- `main.js`: `saveFile`, `saveProject`, Open button / Ctrl+O, drag-drop all go through `platform`. Add **Save as** (Ctrl+Shift+S; on web it is the same as Save). `setDirty(true)` on each committed edit, `false` after a save or open. Page title stays "ShotRef" on web.
- `#fOpen` accepts `.shotref,.json,application/json`.
- Tests (smoke.cjs): web save filename ends with `.shotref`; opening a `.shotref` file works; Ctrl+Shift+S triggers a save on web; with a fake `window.shotrefDesktop` injected before load, Save calls it and a second Save reuses the path (no dialog), Save as asks again, and the title shows the file name + dirty dot.

## Task 2 — Electron shell (`electron/`)
- `electron/main.cjs`: one BrowserWindow (min 1100×700, dark `#141518` background, icon `branding/shotref.ico`), loads `dist/ShotRef.html`. Single-instance lock; a second launch with a file sends it to the first window. Opens a file passed on the command line. Menu: File (New, Open…, Open recent (last 8, `app.addRecentDocument` too), Save, Save as…, Exit), Help (Quick start, About ShotRef: version). Menu items send IPC to the page, which runs its normal flow (confirm dialogs included).
- Native dialogs remember the last folder per kind (project / export / import) in a small JSON in `app.getPath('userData')`.
- `electron/preload.cjs`: exposes `window.shotrefDesktop = { version, saveBlob, saveProject, openProject, setTitle, onMenu, onOpenFile }`; data passed as ArrayBuffer/string only.
- Closing with unsaved changes: the page is asked; it shows its own confirmBox ("Save changes before closing?" Save / Don't save / Cancel).
- Packaging with electron-builder (config in package.json `build`): `npm run dist:win` → `release/ShotRef-Setup-<ver>.exe` (NSIS, per-user, desktop + Start menu shortcuts) and `release/ShotRef-<ver>-portable.exe`. `fileAssociations`: ext `shotref`, name "ShotRef project", icon `branding/shotref-project.ico`. appId `app.shotref.desktop`, productName "ShotRef".
- `npm run desktop` builds the page and starts Electron for development.
- Tests: `test/desktop.cjs` (playwright-core `_electron`), run by `npm run test:desktop`: app starts with no console errors; title is "ShotRef"; save via stubbed dialog writes a real file then Save writes again without a dialog; opening a file path from argv loads it; external navigation is blocked. `npm test` (web) stays unchanged.

## Review focus
1. A save that fails (disk full, read-only folder) must say so in plain words and keep the dirty mark.
2. Opening a file while an export runs is refused, as on web.
3. Double-clicking a project while the app is open opens it in the existing window (asks before replacing).
4. The claude.ai build never sees `window.shotrefDesktop`, and nothing in `platform.js` breaks under the strict CSP.
5. Closing with unsaved changes never loses work silently.
