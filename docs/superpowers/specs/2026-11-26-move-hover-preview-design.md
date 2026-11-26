# Camera move hover previews: design

## Why
The Camera moves buttons (Move tab) are text labels. A first-time user can't tell a truck from a pan or an arc + push from a dolly in until they click and play the result. A looping preview on hover shows what each move does before it's applied. Reference: a grid of looping move clips where the hovered tile plays (Ali's recording, 2026-11-26).

## Goals
- Hover or keyboard focus on a move button shows a small looping preview of that move.
- The preview shows **the user's own shot**: it starts from the current framing, uses the current Strength value, and shows exactly what clicking the button would do.
- It works the same offline and on claude.ai.

## Non-goals
- No tile grid redesign: the buttons stay as they are.
- No touch support: there's no hover on touch screens, so the buttons work as they do today.
- The preview never improves the framing. It shows the move from where the camera is now, the same as the button does.

## Anti-goals (it's a failure if...)
- It changes the scene, undo history, the unsaved mark or autosave.
- It makes the app slow, or keeps drawing after the mouse leaves.
- It shows a blank or meaningless frame without explaining why.

## Approaches
1. **The user's own scene, with a demo fallback (chosen).** It shows the real result for this shot.
2. A fixed demo scene (mannequin and boxes). It looks the same every time but says nothing about the user's shot. It's kept only as the fallback below.
3. Pre-rendered clips embedded in the file. These would add a lot of size to a single offline file and couldn't follow Strength. Rejected.

## Framing (Ali's concern)
The preview does no framing of its own. It replays the move from the current camera pose, so a good starting framing gives a good preview, just as with the button. Two cases still need care:
- **Empty scene, or nothing visible in the frame at the start or end of the move:** show the built-in demo scene instead, with the note "Example. Add people or props to preview it on your shot."
- **The current shot already has keys:** a preview starts from the camera at the playhead, which is what `applyMove()` does today. Keys aren't touched.

## Design
- Split `applyMove(kind)` into `planMove(kind, amt)`, which is pure and returns `{base, keys}` without touching `state`, and `applyMove`, which writes the result, pushes an undo step and shows the toast. The preview and the button share `planMove`, so they can't disagree.
- Popover: a single `#movePeek` element, placed left of the right-hand panel and level with the hovered button, kept on screen. A canvas in the shot's aspect ratio, about 220 px wide, with the move name under it. It shows after a short hover delay (about 150 ms) and hides on mouse leave, blur, a click, a tab change or a panel rebuild.
- Loop: about 2.5 s for the move, plus about 0.4 s of hold at each end, with the shot's motion feel applied.
- Render: the main renderer draws the shot (through `withShotStyle`, with helpers and marks hidden, no depth of field) at the preview size into an offscreen target, then copies it to the popover canvas. It draws only while the popover is open and stops when it closes. No `blob:` URLs, no network.
- Demo fallback: a tiny fixed scene (floor grid, one mannequin, two boxes), built once on first need with a fixed camera pose.

## Left to the builder
- How to test "nothing visible" (for example, project the objects' bounding boxes into the start and end frames).
- Exact sizes, delays and placement maths, within the design rules (quiet, three text sizes).
- The smoke test: hovering shows the preview, the scene and undo history stay unchanged, and leaving stops the drawing.
