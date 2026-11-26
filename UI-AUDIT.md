# ShotRef UI audit

Date: 26 November 2026. Version checked: 1.7.0 (built fresh from this folder today).
Nothing in the app was changed. The only new files are this report and ten screenshots in `docs/ui-audit/`.

## What ShotRef is, as I understand it

ShotRef is a simple 3D stage for a TV producer or videographer, not a 3D artist. You place people and props, move a camera, and export a short reference clip, frames and a text prompt to feed an AI video model such as Kling, Runway or Veo. It runs as a Windows desktop app, as a single web page opened in Chrome or Edge, and as a page on claude.ai. All three show the same screen.

The main task is three steps, and the app names them in its top bar: **1 Build** (place things), **2 Frame** (set the camera and its move), **3 Export**.

## How I checked

| What | How | Label used below |
|---|---|---|
| Web page | Built it and drove it with real clicks in Microsoft Edge, without a visible window. 114 screenshots. | seen running |
| Windows app | Opened the real app once (a throwaway profile, your settings untouched), took a picture of the window with its title bar, then closed it. Nothing was left running. | seen running |
| Window sizes | 900×600, 1100×700 (the smallest the Windows app allows), 1440×900 (the size it opens at), 1920×1080 maximized, 3440×1440 ultrawide | seen running |
| Windows scaling 125% and 150% | Imitated in Edge (a 1920×1080 laptop screen at each setting). Not a real scaled monitor. | seen running (imitated) |
| The main task | From first launch on an empty stage: add a man, go to Frame, Set start, turn the camera, Set end, play, Export video. | seen running |
| Contrast, text sizes, click target sizes, Tab key order | Measured on the live page | seen running |
| Things I could not see | Windows in light mode, a real 150% laptop, the installed (packaged) app, the page inside claude.ai, a screen reader | judged from code, or not checked |

The main task works. It took **10 clicks** from first launch to a saved MP4, and the 5 second 1080p video exported in **1.2 seconds**.

How much of the window the 3D view gets (the 3D view is the picture of your scene in the middle):

| Window | 3D view | Share of window | With timeline tracks open |
|---|---|---|---|
| 1100×700 (smallest Windows app) | 528×575 | 39% | 35% |
| 1280×620 (1080p laptop at 150%) | 708×497 | 44% | 38% |
| 1536×760 (1080p laptop at 125%) | 964×637 | 53% | 47% |
| 1920×970 (1080p at 100%, maximized) | 1348×847 | 61% | 56% |
| 3440×1330 (ultrawide) | 2868×1207 | 76% | 71% |

---

## 1. Verdict

The design is in good shape underneath: the three-step bar, the dark graphite look, the click-to-place flow and the keyboard support are all sound, and no button falls off the screen at any size I tried. What holds it back is that everything on screen speaks at the same volume, so a newcomer cannot tell what matters now, and on an ordinary laptop the picture is squeezed and covered by text.

**The single most damaging problem:** orange is used for almost everything, so it no longer points at anything. The opening screen has 13 orange outlines at once (weather, clouds, drift, grid, loop and so on), and the Frame step has more than 30 orange marks. The one button you actually need next never stands out.

No finding is Critical. Nothing blocks the task.

## 2. What already works and should be kept

- **The 1 Build, 2 Frame, 3 Export bar.** It tells a newcomer the whole job in three words. (seen running)
- **Click a tile, then click the floor.** The item follows the pointer, a bar says "Click on the floor to place Man 1" with a Cancel button, and Esc works. (seen running)
- **The "Set start, reframe, Set end" flow**, with the message "Start saved. Now frame the END of the shot, then press Set end." and automatic playback afterwards. This is the best piece of guidance in the app. (seen running)
- **The Start and End thumbnails** in the camera Move tab. You see the move at a glance. (seen running)
- **The export panel's one-line summary** ("1920×1080 · 16:9 · Shaded") with a Change button, and the ready-written prompt. (seen running)
- **Keyboard support.** Tab moves in a sensible order, the focused control has a clear white outline, dialogs keep the focus inside, Esc closes them, Enter confirms, menus work with the arrow keys, and shortcuts are printed in the menus. (seen running)
- **The mouse pointer changes** to show what a drag will do (grab, turn, lift). (judged from code)
- **Only three text sizes** (11.5, 13 and 15 px) and one typeface. (seen running)
- **Sharpness at 125% and 150% scaling.** The 3D view is drawn at full screen resolution and the icons are drawings, not pictures, so nothing goes soft. (seen running, imitated)
- **Speed.** Clicks respond at once, and the export shows a progress bar with Cancel. (seen running)
- **Empty states that explain themselves**: "No recent projects yet. Projects you work on appear here automatically." and "Nothing here yet. Add a person or an object from the Add tab." (seen running)
- **Dark only.** Right for a tool that sits next to an edit or a grade. Do not add a light mode.

## 3. Findings, most serious first

### 1. Orange marks everything, so nothing leads
- **Where:** every screen. Worst in step 2 Frame. See `docs/ui-audit/01-empty-stage.png` and `03-frame-step.png`.
- **What is wrong:** the same orange outline means "this setting is currently chosen" on Day, Few, Fluffy, Slow, Grid, Camera preview, Shot 1, Editor, 5 s, Gentle, Loop and the Build step: 13 at once on the opening screen. Orange also fills the main buttons, colours the "Take 1" label, the checkboxes, the sliders, the time counter, the keys and the camera. In the Frame step, Set start and Set end are outlined in orange in two places each. The eye has nowhere to land, which is the "cluttered and intimidating" feeling you described on 25 November.
- **Severity:** Major. **Seen running.**
- **Fix:** keep one look for "chosen", but make it neutral. Change the outline from 1.5 px orange `#ff9a3c` to 1.5 px light grey `#c3c8cf`, keeping the raised fill `#3a3f47` and white text. Keep orange for four things only: the one main button of the current step, the camera and its keys, the playhead time, and the small step/tab marker. Change the "Take 1" label from orange `#ffb870` to the same grey as "File" (`#c3c8cf`). This takes the opening screen from 13 orange outlines to 2.
- **Effort:** Small (one place in the styles).
- **Risk:** low for function. **This reverses part of your 26 November decision** ("one selected look everywhere" was built as an orange ring). It keeps what you asked for, one look everywhere, and changes only its colour. Needs your explicit yes.

### 2. Two starter sets open on a black screen
- **Where:** File, New, then "Walk and talk" or "Street". See `docs/ui-audit/02-walk-and-talk-black.png` (taken in the real Windows app on your graphics card).
- **What is wrong:** the editor view starts inside or right beside a dark building. Most of the picture is black, the two people are hidden, and their name labels sit on top of each other. A newcomer who picks either of these (2 of 7 choices) will think the app is broken. The small camera preview in the corner shows the scene is actually fine.
- **Severity:** Major. **Seen running.**
- **Fix:** whenever a starter set or a project is loaded, point the editor view at the scene automatically: stand about 8 m behind and 5 m above the shot camera, looking at the middle of the people, then pull back until everything fits (the app already has this as "Zoom to the selection", the F key).
- **Effort:** Small to Medium.
- **Risk:** low. It changes the starting viewpoint only, not the scene. This is slightly more than a pure styling change, so I am flagging it. The automatic checks that load starter sets need a re-run.

### 3. On an ordinary laptop the picture is squeezed and covered
- **Where:** the 3D view, at 1280×620 (a 1080p laptop at Windows' default 150% scaling) and at 1100×700. See `docs/ui-audit/04-laptop-150-frame.png` and `10-smallest-window.png`.
- **What is wrong:** the two side panels are a fixed 236 and 336 px wide, so the picture gets only 38 to 44% of the window. Then four things are drawn on top of it: the info line ("CAMERA Wide shot · 35 mm"), which has no background and becomes unreadable over the sky; the hint text, which wraps to two or three lines; pop-up messages, which land on top of the hint; and the camera preview. In split view (`08-split-view.png`) the five buttons above the camera picture wrap onto a second row. Your own screen is 2560×1440 at 100%, so you will not see any of this.
- **Severity:** Major. **Seen running (scaling imitated).**
- **Fix, four parts:**
  1. Fold the left Add/Items panel away automatically in steps 2 and 3 (it is not needed there), leaving a 44 px strip with a button to bring it back. On the 150% laptop the picture grows from 708 to 900 px wide (+27%).
  2. Give the info line the same dark backing as the hint: background `rgba(15,16,19,.7)`, padding 3 px 9 px, corner radius 6 px.
  3. Move pop-up messages from 200 px above the bottom to the top centre, 56 px from the top, so they never cover the hint or the picture.
  4. Keep the hint to one line: no wrapping, cut with "…" if too long, and trim the editor hint from 10 tips to 3 ("Drag: orbit · Right-drag: pan · Scroll: zoom"). The rest is already in Quick start.
- **Effort:** Medium (part 1), Small (parts 2 to 4).
- **Risk:** part 1 moves a panel, so the quick tour and the tests that click the left panel in steps 2 and 3 need checking. Parts 2 to 4 are safe.

### 4. Export does not finish clearly
- **Where:** step 3 Export, after pressing "Export video (MP4)". See `docs/ui-audit/05-export-done.png`.
- **What is wrong:** pressing the button in the panel opens a large options window (Aspect, Size, four render styles, four more buttons and a second "Export video (MP4)" button) while the video renders. When it is done, the window stays open, the only sign of success is small grey text "Done: 1.1 MB", and the big orange button invites you to export again. A message naming the file shows for 2.4 seconds at the top. Nothing says where the file went. The best moment in the app, "your clip is ready", is the weakest screen.
- **Severity:** Major. **Seen running.**
- **Fix:** from the panel, show a small progress window only: title "Exporting video…", the bar, Cancel. When it finishes, replace it with: a green tick, **"Video saved"**, the file name and size on one line, a line "It is in your Downloads folder" (web) or the folder you chose (Windows app), and two buttons: **Done** (main) and **Copy prompt** (the next thing you need for the AI tool). It stays until you close it. The full options window stays where it is, behind "Video options…".
- **Effort:** Medium.
- **Risk:** the export code is delicate. Only the window around it changes, but every export check must be re-run.

### 5. An empty stage does not say what to do
- **Where:** after choosing "Empty stage". See `docs/ui-audit/01-empty-stage.png`.
- **What is wrong:** the middle of the screen is a blank floor. The right panel opens on weather settings (Scene, Sky, Clouds, Look, Drift). The "Getting started" steps exist, but they are the last thing in the right panel, below the bottom edge of a 1440×900 window, so a newcomer never sees them.
- **Severity:** Major. **Seen running.**
- **Fix:** while the stage has no items, (a) move "Getting started" to the top of the right panel, above Scene, and (b) show one line in the middle of the floor: **"Your stage is empty. Click a person or prop on the left, then click the floor."** in 15 px text on the same dark backing as the hint. Both disappear when the first item is placed.
- **Effort:** Small.
- **Risk:** low.

### 6. The same control appears in two or three places, under different names
- **Where:** step 2 Frame and step 3 Export. See `docs/ui-audit/03-frame-step.png` and `07-camera-move-tab.png`.
- **What is wrong:**
  - "Set start" and "Set end" are above the picture and again in the Move tab.
  - Motion feel is on the timeline as "Constant / Gentle / Strong" with no label, and again in the Move tab as "Constant / Gentle ease / Strong ease".
  - Aspect, Size and style are in the camera's Output tab (called "View style"), in the Export panel behind Change (called "Render style"), and in the Video options window.
  - The camera has five tabs, but Photo holds one button, Output holds four dropdowns that Export repeats, and Lens holds one slider, seven chips and one tick box.
  
  A newcomer has to work out whether these are the same thing or different things, and which one to use.
- **Severity:** Major. **Seen running.**
- **Fix:** one home per control.
  - Set start / Set end: keep the pair above the picture, remove the pair in the Move tab (the thumbnails, Play and Clear move stay).
  - Motion feel: keep it in the Move tab, remove it from the timeline in normal mode, and use the same three words in both: Constant, Gentle, Strong.
  - Aspect, Size, style: Export only. Call it "Render style" everywhere.
  - Camera tabs from five to three: **Shot** (shot size, subject, location photo, mount), **Move**, **Lens** (focal length, handheld, blur background). The Guides dropdown moves to the grid button above the picture.
- **Effort:** Medium to Large.
- **Risk:** medium. This is the "phase 4" you have not yet decided on (PROJECT.md lists camera tabs 5 to 3 and motion feel off the timeline as waiting for your choice). The tour text and several tests point at these controls.

### 7. Every message looks the same and most vanish too fast
- **Where:** the pop-up message, used in 146 places.
- **What is wrong:** "Man 1 placed", "Saved…", a warning that a walk runs past the end of the shot, and "This isn't a ShotRef project, or the file is damaged" all appear as the same grey pill in the same spot. The default time on screen is 2.4 seconds, including for a 75-character instruction. A failed file open deserves more than a line that disappears. One message is internal language shown to a newcomer: opening the Living room starter says *"7 raised items were set to "Can float", so they stay where they are."* (`docs/ui-audit/09-living-room-message.png`).
- **Severity:** Major. **Seen running.**
- **Fix:** three kinds, same shape. Information: as now. Success: a green tick `#59d18a` in front. Problem: a 3 px red left edge `#ff7a7a`, and it stays until clicked or for 8 seconds. Time on screen for all: 1 second plus 60 ms per character, never under 2.4 seconds (so 75 characters stay 5.5 seconds). Do not show the "Can float" message when loading a starter set.
- **Effort:** Small to Medium.
- **Risk:** low. Some tests read message text and timing.

### 8. The Windows app can be too tall for a laptop screen, and forgets its size
- **Where:** the Windows app window.
- **What is wrong:** the window refuses to go below 1100×700 and always opens at 1440×900 in the same place. A 1920×1080 laptop at 150% scaling has only about 1280×672 of usable space, so the window cannot fit unless maximized, and the bottom of the timeline can end up under the taskbar. It does not remember the size or position you left it at.
- **Severity:** Major for laptop users. **Judged from code** (your screen is too large to show it).
- **Fix:** lower the minimum height from 700 to 600. Open maximized when the screen's usable area is smaller than 1440×900. Remember the last size, position and maximized state.
- **Effort:** Small.
- **Risk:** low. Do finding 3 first, so the 600-tall layout is comfortable.

### 9. Four rough edges in the Windows app
- **Where:** the Windows app. See `docs/ui-audit/06-windows-app.png`.
- **What is wrong and the fix for each:**
  1. **Two File menus.** Windows' own "File  Help" bar sits directly above the app's "File ▾" button, and the gear menu repeats Help. Fix: in the Windows app only, hide the in-app "File ▾" button and the Help group in the gear menu. The Windows menu bar already has all of it.
  2. **Old-style scroll bars.** The side panels show chunky grey Windows scroll bars with arrow buttons on a dark panel. Fix: thin scroll bars, thumb `#44484f`, no track.
  3. **Wrong word.** Settings says "Saved in this browser." (the phrase appears 8 times in all). Fix: in the Windows app say "Saved on this computer."
  4. **Title bar colour.** It follows Windows, so on a PC set to light mode there would be a white title bar and menu on a black app. Fix: force the dark title bar. (This one is judged from code. Your PC is in dark mode.)
- **Severity:** Minor. **Seen running** (1 to 3).
- **Effort:** Small each.
- **Risk:** item 1: the quick tour may point at the File button, so check the tour in the Windows app. Others: none.

### 10. The one-click camera moves are not paired
- **Where:** camera, Move tab, "Camera moves". See `docs/ui-audit/07-camera-move-tab.png`.
- **What is wrong:** "Static" takes the first cell, which pushes every opposite onto different rows: "Dolly in" sits beside Static, "Dolly out" beside "Orbit left", and so on for 18 buttons. You have to read every label to find one.
- **Severity:** Minor. **Seen running.**
- **Fix:** put Static on its own full-width row, then seven rows of opposites side by side: Dolly in | Dolly out, Orbit left | Orbit right, Truck left | Truck right, Crane up | Crane down, Pan left | Pan right, Tilt up | Tilt down, Zoom in | Dolly zoom. Then the three specials (Arc + push, Drone rise, Reveal) on a last row.
- **Effort:** Small.
- **Risk:** low (already on your phase 4 list).

### 11. The main button is sometimes the wrong one
- **Where:** right panel.
- **What is wrong:** a tree, a building or a box gets a full-width orange "Draw path" button and a "Speed 1.5 m/s" slider as its most prominent controls. Selecting three items makes "Group" the orange main button. The Export step has two orange buttons (Export video and Copy prompt).
- **Severity:** Minor. **Seen running.**
- **Fix:** orange fill only for: Draw walk path on a person, Choose photo, Export video. Make "Draw path" on props, "Group" and "Copy prompt" ordinary grey buttons. For props that never move by themselves (tree, building, house, rock, wall, stairs, floor tile, street lamp, cactus), fold the "Move & face" section shut by default.
- **Effort:** Small.
- **Risk:** none.

### 12. Half the text is at the smallest size
- **Where:** tile labels, notes, tab counts, the info line, timeline numbers.
- **What is wrong:** on the opening screen, 56 of 111 pieces of text are 11.5 px. On a 2560×1440 screen at 100% that is small for anyone over forty. Contrast is mostly fine (ordinary notes measure 5.2 to 1, and 4.5 is the usual minimum), with three exceptions: the line "Strength, softness and shadow depth: Advanced" at 3.3 to 1, the item counts in the Items list at 3.5 to 1, and the visibility dot at 4.05 to 1.
- **Severity:** Minor. **Seen running.**
- **Fix:** raise the small size from 11.5 to 12 px. Remove the 70% fade on the "…: Advanced" line. Change the Items counts and the visibility dot to `#aab0b8`.
- **Effort:** Small.
- **Risk:** a few labels may wrap ("Street lamp", "More shapes", "Scattered"). The screenshots must be checked afterwards.

### 13. Small things to click
- **Where:** the "?" on section headings (17×17 px), the hide button in the Items list (21×15), the lock button (19×13).
- **What is wrong:** the usual minimum for a comfortable click is 24×24 px. The hide button is also a plain dot, which does not say "visible".
- **Severity:** Minor. **Seen running.**
- **Fix:** make all three 24×24 px (the drawing inside can stay the same size). Replace the dot with the eye drawing the app already uses on the category headings.
- **Effort:** Small.
- **Risk:** none.

### 14. One thing, two names
- **Where:** various.
- **What is wrong and the fix:**
  - "View style" (Output tab) and "Render style" (Export): use **Render style**.
  - "Gentle" (timeline) and "Gentle ease" (Move tab): use **Gentle**.
  - "Overcast" is both a Scene choice and a Clouds choice, side by side: rename the Clouds one **Full cover**.
  - Starter sets name people "Person 1"; adding one names him "Man 1"; the panel is titled "Man": use **Man 1 / Woman 1 / Child 1** everywhere.
  - "It's always in the Help menu" (first-run window): on the web there is no Help menu, only a gear. On the web say **"It's always under the gear button, top right."**
- **Severity:** Minor. **Seen running.**
- **Effort:** Small.
- **Risk:** saved files keep their old names, which is fine. Tests that look for "Person 1" need updating.

### 15. Starter sets have no pictures
- **Where:** the "Start a shot" window.
- **What is wrong:** seven grey cards with text only, in a tool whose whole point is the picture. "Empty stage" is first, so it is the likeliest first click, and it leads to the blank screen in finding 5.
- **Severity:** Minor. **Seen running.**
- **Fix:** add a 16:9 thumbnail of each set's camera view at the top of its card (the Recent projects cards already work this way). Put "Two-person dialogue" first and "Empty stage" last.
- **Effort:** Medium (seven small pictures to make and store inside the file, about 5 KB each).
- **Risk:** adds about 35 KB to the single file.

### 16. Unclear symbols on the timeline and top bar
- **Where:** timeline buttons and the top bar.
- **What is wrong:** "◆◀" and "▶◆" (previous and next key) are not standard symbols. Undo and redo are small thin arrows. About half the buttons explain themselves with Windows' slow yellow-box tooltip (about a second's wait) and the buttons over the picture use the app's own instant dark tooltip, so the app feels like two different programs.
- **Severity:** Minor. **Seen running.**
- **Fix:** use the app's own instant tooltip on every button that has one. Replace the two key buttons with the standard skip symbols plus a small diamond drawn in the app's icon style, 17 px, like the other icons.
- **Effort:** Small to Medium.
- **Risk:** the tooltip must not run off the screen edge near the corners.

### 17. Name labels pile up in the 3D view
- **Where:** the 3D view, when two people stand close or far away. See `docs/ui-audit/02-walk-and-talk-black.png`.
- **What is wrong:** "Person 1" and "Person 2" print on top of each other and neither can be read.
- **Severity:** Minor. **Seen running.**
- **Fix:** when two labels would overlap, move the second one up by its own height plus 2 px.
- **Effort:** Small.
- **Risk:** none.

### 18. Quick start is a wall of text
- **Where:** gear, "Quick start and shortcuts".
- **What is wrong:** seven steps, each a paragraph of three to five sentences, followed by 22 shortcut rows. Step 3 alone holds six separate ideas. People do not read this.
- **Severity:** Minor. **Seen running.**
- **Fix:** one sentence per step (seven lines in all), and move the extra detail into the "?" notes that already sit beside the controls. Put Shortcuts on its own tab in the same window.
- **Effort:** Small (wording) to Medium (tab).
- **Risk:** none.

## 4. Top 5: the biggest improvement for the least work, in order

1. **Finding 2: the black starter sets.** Small job, removes the worst first impression.
2. **Finding 1: grey "chosen" outline, orange only for what matters.** One change in one place, and it changes the feel of every screen. Needs your yes because it adjusts your 26 November decision.
3. **Finding 5: the empty stage tells you what to do.** Small.
4. **Finding 3, parts 2 to 4: backing for the info line, messages at the top, one-line hint.** Small, and it clears the picture.
5. **Finding 4: a clear "Video saved" finish.** Medium, but it is the moment the whole app exists for.

A good second round: findings 9, 10, 11, 13 and 14 together. They are all small and safe.

## 5. One optional bolder idea: let each step own the screen

Today all three steps show the same four regions (Add panel, 3D view, settings panel, timeline) and only the right panel changes. There are also two ways to move around that overlap: the steps (Build, Frame, Export) and the views (Editor, Top, Camera).

The bolder version: each step is its own workspace.

- **Build:** Add panel on the left, the stage in the middle (Editor or Top), the selected item's settings on the right. No camera controls.
- **Frame:** the left panel folds away. The camera picture fills the middle, with the Editor view as a small inset you can click to enlarge (the reverse of today's corner preview). One right panel with Shot, Move and Lens. The timeline shows the camera only.
- **Export:** the finished picture on the left, one column on the right: format, the Export button, frame pack, prompt.

What it buys: a newcomer only ever sees the tools for the job at hand, the picture gets most of the window on a laptop, and the "steps or views?" question from your phase 4 list answers itself. It would also absorb findings 3 (part 1) and 6.

What it costs: Large. Several working sessions. It touches the quick tour, the first-run flow, and roughly 40 of the automatic checks, and it needs your decisions on the open phase 4 items first. I would only start it after the top 5 are in and you have used them for a few days.

---

## Screenshots saved with this report

`docs/ui-audit/`: 01 empty stage, 02 Walk and talk opening black (Windows app), 03 Frame step, 04 laptop at 150%, 05 export finished, 06 the Windows app window, 07 camera Move tab, 08 split view, 09 Living room message, 10 smallest window.
