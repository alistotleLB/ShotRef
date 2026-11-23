# ShotRef brand kit

Instructions for the coding agent. Everything you need is in this `branding/` folder.
Follow the project rules in `../CLAUDE.md` too, especially: the app stays **one offline HTML file**, so no external fonts, CDNs or image URLs. Embed SVG inline or as `data:` URLs.

---

## 1. Name

- Always **ShotRef**: one word, capital S, capital R.
- Never "Shotref", "Shot Ref", "SHOTREF" or "ShotRef Studio".
- The project file type is a **ShotRef project** (`.shotref.json`).

## 2. Slogan and copy

| Use | Text |
|---|---|
| Slogan (main) | **Block the shot. Move the camera. Guide the AI.** |
| Short tagline (top bar, under the logo, window subtitle) | **Camera moves for AI video** |
| One-line description (store listing, website meta, About box) | ShotRef is a simple 3D tool for blocking scenes and camera moves, then exporting reference clips for AI video models like Kling, Runway and Veo. |
| Longer description (website, installer, README intro) | Plan a shot in minutes, no 3D skills needed. Place people and props, draw their walks, set a start and end for the camera, and export a clean reference clip or frames. Use them to show an AI video model exactly the move you want. Works offline, in your browser or as a Windows app. |
| Welcome screen headline | **Start a shot** |
| Welcome screen body | Pick a starter set, or start from an empty stage. |

### Voice

- Plain English for a filmmaker, not a 3D artist. Use real set terms (dolly, truck, push in, rack focus, mark, blocking) with a short note where needed.
- Sentence case everywhere: "Export video", not "Export Video".
- Buttons start with a verb, 1–3 words: "Set start", "Export video", "Open project".
- No "please", no "successfully", no exclamation marks, no "simply/just/easy".
- Errors say what happened, then what to do: "That file isn't a ShotRef project. Try another file."
- Confirmations are short: "Saved", "Exported", "Copied".
- The app never says "I".

## 3. Colours

These match the colours already in `src/index.html` (`:root`). Keep the variable names; only add what's missing.

| Role | Hex | CSS variable |
|---|---|---|
| Brand orange (accent, path, primary highlight) | `#FF9A3C` | `--acc` (exists) |
| Orange, lighter (hover) | `#FFB870` | `--acc2` (exists) |
| Orange, dark tint (selected backgrounds) | `#5A3A1C` | `--accd` (exists) |
| Orange on light backgrounds (website, print, light mode) | `#E0761A` | add as `--acc-on-light` only where light surfaces are used |
| Ink (frame corners, main text on dark) | `#E7E9EC` | `--ink` (exists) |
| Charcoal (app background, dark corners on the icon) | `#141518` | `--bg` (exists) |
| Off-white (light backgrounds, website) | `#F4F3EF` | website only |

Rules:
- Orange is the **only** brand colour. Use it for the logo path, the current selection, the active tool and the main action. Don't use it for large flat areas inside the app.
- The app interface stays dark, like an edit suite.
- Blue, red and green in the app are for status (info, error, success), never for branding.

## 4. Type

- App and website: the system font stack, **no downloaded fonts** (the app must work offline):
  `"Segoe UI", system-ui, -apple-system, Helvetica, Arial, sans-serif`
- Wordmark: the same stack, weight 600, slight negative spacing (`letter-spacing: -0.4px` at 24 px). "Shot" is in ink or charcoal, and "Ref" is in orange.

## 5. Logo and icon: which file goes where

The **mark** is two frame corners with a camera path running from a start point to an end point.
- The **app icon** is the mark on an orange tile. Use it wherever the app is represented as an app.
- The **logo** is the mark without a tile, plus the word ShotRef. Use it inside the app and on the website.

| Place | File |
|---|---|
| **Web app** | |
| Browser tab icon | `svg/app-icon.svg` as `<link rel="icon" type="image/svg+xml">` plus `favicon-32.png` fallback (inline both as `data:` URLs) |
| Install / home screen (web manifest, if added) | `png/app-icon-maskable-192.png` and `-512.png` with `"purpose": "maskable"`, and `png/app-icon-512.png` with `"purpose": "any"` |
| iPhone/iPad home screen | `png/apple-touch-icon-180.png` |
| Theme colour (manifest + `<meta name="theme-color">`) | `#141518` |
| **Desktop app (Windows)** | |
| Program, taskbar, Start menu, shortcut, installer | `shotref.ico` (contains 16, 24, 32, 48, 64, 128 and 256 px) |
| `.shotref.json` file icon (file association) | `shotref-project.ico` |
| Larger app images (installer banner, store) | `png/app-icon-512.png`, `png/app-icon-1024.png` |
| **Inside the app (web and desktop, identical)** | |
| Top bar, left (replace the orange dot in `.brand`) | `svg/mark-on-dark.svg` inline, 20 px high, then the text "ShotRef" |
| Welcome screen and About box | `svg/logo-on-dark.svg` |
| Window / page `<title>` | `ShotRef` (currently "ShotRef Studio") |
| **Website, documents, social** | |
| On dark backgrounds | `svg/logo-on-dark.svg` or `png/logo-on-dark.png` |
| On light backgrounds | `svg/logo-on-light.svg` or `png/logo-on-light.png` |
| Avatar / profile picture | `png/app-icon-512.png` |

Small sizes: `app-icon-small.svg` is a simplified drawing (straight path, no dots) made for 16 and 24 px. The 16 and 24 px PNGs and the `.ico` already use it. Don't shrink the full icon below 32 px.

### Logo rules

- Leave clear space around the logo of at least the height of one frame corner.
- The minimum logo size is 20 px high in the app and 24 px on the web.
- Don't recolour the mark, stretch it, rotate it, add shadows or glows, or put the no-tile mark on an orange background.
- The orange dot with a glow in the current top bar is retired. Replace it with the mark.

## 6. Top bar change (exact)

In `src/index.html`:
- Line ~204: `<div class="brand"><span class="dot"></span>ShotRef <small>reference animation studio</small></div>`
  becomes the inline mark SVG + `ShotRef` + `<small>Camera moves for AI video</small>`.
- In `.brand`, set the weight to 600, and give the SVG `width:20px;height:20px;flex:none`.
- Delete the `.brand .dot` rule.
- Keep the existing `@media` rules that hide `<small>` on narrow screens. Below 1100 px only the mark shows (the word is hidden; `.brand` has `title="ShotRef"`).

**Status: applied 2026-11-23** (title, tab icon, theme colour, top bar, welcome header on first launch). Still to do with the Windows app: `.ico` files, file association, installer, About box.

## 7. Checks after implementing

- `npm run build && npm test` must pass (the CLAUDE.md rule). Add one smoke check: the page has a favicon link with a `data:` URL, and `.brand svg` exists.
- Open `dist/ShotRef.html` in Edge and check that the tab icon shows and the top bar shows the mark at 1280 px and 900 px wide.
- Under the strict claude.ai rules (`sandbox/app.html`), the icon must still show, because it uses `data:` and not `blob:`.

## 8. Files in this kit

```
branding/
  BRAND.md                 this guide
  shotref.ico              Windows app icon (16–256 px)
  shotref-project.ico      Windows icon for .shotref.json files
  favicon-32.png           browser tab fallback
  svg/  app-icon.svg  app-icon-small.svg  app-icon-maskable.svg
        mark-on-dark.svg  mark-on-light.svg
        logo-on-dark.svg  logo-on-light.svg  file-icon.svg
  png/  app-icon-{16,24,32,48,64,128,256,512,1024}.png
        app-icon-maskable-{192,512}.png  apple-touch-icon-180.png
        file-icon-{16,32,48,256}.png
        logo-on-{dark,light}.png  mark-on-{dark,light}-256.png
```

The logo SVGs use live text, so they look slightly different on machines without Segoe UI. For print or a store listing, use the PNGs.
The original reference files in `../Logos/` are kept as they are.
