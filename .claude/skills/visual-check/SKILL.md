---
name: visual-check
description: Look at ShotRef's real screens after any change Ali will see (panels, buttons, wording, layout, colours, the 3D view). Saves the same 8 fixed screenshots every time and checks them against the design rules before Ali sees the change. Use after a UI change and before saying it is done, or when Ali asks "how does it look".
---

# Visual check

Tests prove nothing is broken. This answers the other question: **does it look right?** Do it before Ali sees a UI change, so he only has to judge taste, not spot mistakes.

## 1. Before you change anything: the "before" pictures

- If `dist/ShotRef.html` is from the code you are about to change, run `npm run visual -- dist/visual-before` first. Otherwise skip this step and compare against the description of the old look instead.

## 2. After the change: the "after" pictures

- `npm run build`, then `npm run visual`. The pictures go to `dist/visual/` (ignored by git).
- Check the printed `Build:` time is after your last edit. An old build gives old pictures.
- Any `ERRORS` or `FAIL` line: fix that first. It is a real page error.
- Only one screen matters? Use `npm run visual -- --only 05` to save time.

The 8 screens:

| File | Shows |
|---|---|
| 01-scene | starter scene, nothing selected (Scene panel) |
| 02-object | a person selected (object panel, selection toolbar) |
| 03-camera-view | camera selected, looking through the camera |
| 04-top-view | top view |
| 05-export | Export panel and prompt |
| 06-advanced | Advanced mode, camera panel |
| 07-empty | every object deleted (empty state) |
| 08-narrow | small window, 1100 x 700 |

If the change lives somewhere none of these reach (a dialog, a menu, the timeline with keys), add a screen to `SCREENS` in `test/visual.cjs` rather than taking a one-off picture. The set grows with the app.

## 3. Look, with a checklist

Read only the screens the change can affect, plus 08-narrow (it breaks first). For each, check:

1. **Did the change land?** The thing asked for is visible, at the size and place asked for.
2. **Nothing else moved:** compare with the before picture. Nothing unrelated is shifted, cut off or wrapped.
3. **Text:** no clipped or overlapping words, nothing cut with "…" that shouldn't be. Wording is sentence case and plain (CLAUDE.md voice).
4. **Design rules (CLAUDE.md):**
   - Is it readable in about 3 seconds?
   - Does each colour and icon keep one meaning?
   - About three text sizes.
   - Secondary controls stay quiet.
5. **Empty and small:** 07-empty and 08-narrow still make sense.

Zoom when unsure: crop the region with the Read tool's image, or add a screen at a larger viewport. Don't guess at 4-pixel details from a full-screen picture.

## 4. Report

- Say what you looked at and what you saw, in one line per screen that matters: "05-export: new button sits under Copy prompt, same width; nothing else moved."
- Show Ali the one or two pictures that show the change (attach the PNG). Don't send all 8.
- Anything that needs a person (feel, taste, real mouse use, the desktop app, claude.ai): put it on Ali's checklist and mark it "not checked".
- This doesn't replace the tests. CLAUDE.md test rules still apply.
