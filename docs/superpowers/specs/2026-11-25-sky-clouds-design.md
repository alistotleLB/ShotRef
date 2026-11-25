# Sky and clouds: design

Approved by the owner on 2026-11-25 ("Turn it into a build plan"). First piece of the weather system; rain, snow and wind come later.

## Why
ShotRef's sky is a flat gradient fixed to the screen: no clouds, and it does not move when the camera pans, so a pan or orbit reads as "nothing moved" behind the subject. AI video models copy what they see in the reference clip. A world-anchored sky with clouds gives them the camera move and the mood of the light.

## Goals
- Clouds in the editor view, the shot view and every shot export (MP4, PNG, frame pack, contact sheet, thumbnails).
- One-click choices in Simple mode; fine control only in Advanced mode.
- Cloud cover changes the light believably (softer shadows, weaker sun, more fill) without overwriting the user's sun settings.
- Same frame, same clouds: every render of time `t` is identical.
- The prompt names the sky.

## Non-goals
- Rain, snow, wind effects on objects, lightning, cloud shadows on the ground, sky colour following time of day. Later.
- Volumetric or 3D clouds.

## Anti-goals (a failure even if it works)
- Clouds in clay, depth or normal renders (they would pollute depth maps).
- Old projects changing their look or their prompt.
- A panel full of sliders in Simple mode.
- Any network request, image file or `blob:` URL.

## Approaches considered
1. **Shader sky dome (chosen).** One full-sky mesh painted by a fragment shader: gradient, noise clouds, sun glow. Cheap, sharp at any export size, animates from a time uniform, no assets.
2. Canvas-painted panorama texture. Simpler shader, but repainting on each slider drag is slow and soft at 4K.
3. Billboard cloud cards in 3D. Real parallax, but sorting artefacts and cost; too much for blocking.

## Design
- **Dome:** a sphere drawn at the far plane (`gl_Position = pos.xyww`), centred on the rendering camera, `fog: false`, `depthWrite: false`. Replaces the gradient `scene.background` in shaded style. Hidden in the top view, in clay/depth/normal styles and when the location photo is the background.
- **Gradient:** the same three colours `skyTexture()` uses today (top = sky × 0.72, middle = sky, horizon = sky lerped 32% to white), mapped by elevation instead of screen height. Fog keeps using the horizon colour.
- **Clouds:** noise on a cloud plane above the camera (direction `d` → `d.xz / d.y`), threshold by cover, soft edges, fading toward the horizon. Looks: `fluffy` (cumulus), `wispy` (noise stretched 4× along drift direction, thinner), `flat` (low-contrast continuous sheet). Lit with the sun colour on top, shaded underside; at night dark blue-grey.
- **Sun glow:** small disc plus wide halo at the sun's direction, dimmed by cloud density in front of it.
- **Drift:** cloud offset = drift direction × speed × shot time. Speeds: Still 0, Slow, Breezy, Fast.
- **Light coupling (as a layer, stored values untouched):** with cover `c` in 0..1: effective sun intensity = `sunInt × (1 − 0.8c²)`, effective ambient = `ambInt + 0.6c²`, effective shadow softness = `min(1, shadowSoft + 0.7c)`. Clear (c = 0) gives back exactly the stored light.
- **Presets:** clicking an Environment preset also sets clouds: Studio → clear, Day → few/fluffy, Overcast → overcast/flat, Sunset → scattered/fluffy, Night → few/fluffy. Overcast's stored `sunInt`/`ambInt` change to 2.75/1.1 so the effective light equals today's Overcast (0.55/1.7).
- **Saved:** `settings.clouds = { cover, look, drift, dir, soft, seed }`. A file without it opens with cover 0 (exactly today's sky, prompt unchanged). A new scene starts with Few, fluffy, slow.
- **UI:** a "Sky" section in the Scene panel and the Sun panel. Simple: cover chips with small CSS swatches (Clear · Few · Scattered · Mostly cloudy · Overcast), and when cover > 0: Look chips, Drift chips, "Shuffle clouds" button, and a one-line description of the result. Advanced adds: exact cover slider, edge softness, direction slider. Sky and ground colour and fog stay in Advanced.
- **Prompt:** cover 0 leaves the light line exactly as today; otherwise the sky words join it ("Clear blue sky" is not written for cover 0, to keep old prompts unchanged).

## Left to the builder
Exact noise functions, octave count, glow exponents and colours, as long as the tests and the visual check pass.
