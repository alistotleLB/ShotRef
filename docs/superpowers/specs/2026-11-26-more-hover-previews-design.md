# More hover previews: motion feel, poses, lens chips (design, approved 2026-11-26)

Builds on the camera move preview (`2026-11-26-move-hover-preview-design.md`, `#movePeek`, `peekShow/peekHide/peekTick/peekDraw` in `src/main.js`). The why is the same: these controls are words whose effect a first-time user can't picture, and a looping preview shows it before they click.

## Shared rules (same as the move preview)
- The same `#movePeek` box: 220 px long side, 150 ms hover delay, opens on hover or keyboard `:focus-visible`, closes on leave, click, blur, Escape, window blur, panel scroll, modals, panel rebuild and `setView`. It's off during export, playback, recording, piloting and tours.
- It never writes `state`, `editRev`, history, the unsaved mark or autosave, and never causes main-view redraws.
- Hover delay, failure handling and context-loss handling are unchanged.
- One box with several **sources**. Each hover names a source and its argument. Placement is left of the right panel, level with the control, except for a control in the bottom timeline bar: there the box sits **above** the control, horizontally centred on it, and clamped.

## 1. Motion feel
- Controls: the `feelSeg()` buttons in the Move tab and the `#feelBar` buttons in the bottom bar.
- If the shot has camera keys (2 or more), loop **the shot's own camera keys** with the hovered feel (`camTime` with `FEEL[hovered]`) on the user's own shot, with the same timing as the move preview: 2.5 s move plus 0.4 s holds, `t` over `0..lastT()`.
- If the camera is static, use `planMove('dollyIn', 1)` from the current framing with the hovered feel. If that has nothing in frame, use the demo scene, as for moves.
- Label: the feel's name (e.g. "Gentle ease"). With the static fallback, add the note "Shown on a dolly in. Your camera doesn't move yet."
- Hovering the feel that's already chosen still previews.

## 2. Poses
- Control: the `.posegrid` buttons for a selected person.
- Show the **selected person alone** in the demo-style scene (floor, grid, lights, no boxes): built with that person's body type, height and colours, seen from a three-quarter front angle and framed to their height. The camera is fixed.
- Animated poses loop by phase over time. `walk` and `run` play **on the spot** (the stride animates, the figure doesn't travel). `sit` puts them on a simple stool (a box about 0.45 m high) so the pose reads. Still poses hold.
- Label: the pose name. No note.
- The preview person is rebuilt when the hovered person or pose changes, and disposed on close (or cached per person id and disposed when another person is previewed).

## 3. Lens chips
- Control: the focal length chips on the Lens tab (14 to 135 mm).
- On the user's own shot at the playhead `T`, with the camera position and aim unchanged, animate the focal length from the current `camState.f` to the hovered value over 1.0 s (eased), then hold 1.5 s, then loop. If it's equal to the current value (within 0.5 mm), show a still.
- Label: "35mm → 85mm · Telephoto" (the chip's old `title` word moves into the label; the `title` is removed). Equal: "35mm · Normal".
- Nothing in frame: still show the user's shot. A lens change on an empty frame is honest, and no demo is needed.

## Non-goals
- No depth of field or render-style previews (later, maybe).
- No touch support.
