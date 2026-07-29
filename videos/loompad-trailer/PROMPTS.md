# LoomPad — launch trailer, Higgsfield shot sheet

**Target:** 30 seconds, 9 shots, 16:9.
**Look:** graphite `#0A0A0B`, one accent orange `#FF6B2B`, hard product light, no
gradients-as-decoration. The film is *cold machined product → warm human desk*.

**The spine.** Nobody cares about a macropad. They care that five AI agents
can't remember anything between them. So the trailer opens on the *problem* as
type, turns the product on, and ends on the fact that you can build one tonight.

Everything below is image-to-video: upload the plate from `assets/`, paste the
prompt, pick the preset. Clips come back 3–5s; you only use the middle of most.

---

## Before you start — two rules that decide whether this looks good

**1. Prompt motion and light, never content.** These models invent things when
you describe objects. The plate already *is* the object. Say how the camera
moves and how the light behaves; say nothing about keycaps, logos, or text. Every
prompt below is written that way — if you add "with glowing agent logos", you
will get melted symbols.

**2. Never ask it to animate legible text.** The keycap glyphs and any UI text
will smear the moment there's real motion. That's why the UI shots use slow
push-ins only, and why every word in this trailer is a text card added in the
edit, not generated.

---

## Shot list

### 01 · COLD OPEN — the problem
**Asset:** none (text card, made in the edit)
**Duration:** 0:00–0:03
Black frame. Orange caret blinks once. Type on, monospace, one line at a time:

```
claude code  ·  memory: its own
codex        ·  memory: its own
opencode     ·  memory: its own
```

Then all three collapse into one line: `none of them can hand it over.`
No Higgsfield needed. Keep it silent except a low sub-bass hit on the collapse.

---

### 02 · THE OBJECT ARRIVES
**Asset:** `assets/01-hero.png`
**Preset:** Crash Zoom Out (fallback: Super Dolly Out)
**Duration:** 0:03–0:06

> Camera pulls back fast from an extreme close-up on the product's top surface to
> a three-quarter product view. The object stays perfectly still and centred.
> Hard key light from the upper left, deep black falloff behind. Faint warm
> orange bounce on the lower edges. Shallow depth of field settling to sharp.
> Cinematic product photography, matte plastic, no reflections on the backdrop.

*Cut on the frame where it lands sharp. This is your hero frame.*

---

### 03 · IT COMES APART
**Asset:** `assets/03-exploded.png`
**Preset:** Robo Arm (fallback: Arc Right)
**Duration:** 0:06–0:10

> Camera arcs slowly to the right around the floating stack of parts while they
> hold their separation. Precise mechanical motion, locked and smooth like a
> motion-control rig. Hard directional light rakes across each layer as it
> passes. Deep black background, warm orange floor bounce.

*The one shot that says "this is open hardware, you can see inside it."*

---

### 04 · THE DECK
**Asset:** `assets/02-top.png`
**Preset:** Dolly In (slow) — or Static with the push added in the edit
**Duration:** 0:10–0:13

> Slow straight push in toward the flat top-down face. Object dead still and
> perfectly square to frame. Light sweeps gently left to right across the
> surface. Nothing else moves.

*Keep it slow. This is the shot where a viewer counts the keys and realises
each one is a different agent. Text card bottom-left: `one key per agent`.*

---

### 05 · IT'S REAL
**Asset:** `assets/real-t42.png`
**Preset:** Handheld (fallback: Static + slight push)
**Duration:** 0:13–0:17

> Subtle handheld camera drift, very small movement, as if held by a person
> breathing. Warm practical desk light, shallow focus on the hand and the
> nearest keys, background falling soft. Documentary, unpolished, real.

*The hard cut from render to a real thumb on a real knob is the whole trailer.
Don't clean this shot up — the messy desk is the point. Text card: `built, not
rendered`.*

---

### 06 · THE SCHEMATIC
**Asset:** `assets/05-circuit.png`
**Preset:** Dolly In (very slow) or Static
**Duration:** 0:17–0:20

> Extremely slow push into the centre of a flat technical diagram. The image
> stays flat and square to camera, no perspective, no warping. Faint scanline
> shimmer. Everything else still.

*Flat, square, slow — anything more and the labels turn to mush. Text card:
`schematic, CAD and firmware — all public`.*

---

### 07 · THE SOFTWARE
**Asset:** `assets/06-ui-brain.png`
**Preset:** Dolly In (slow)
**Duration:** 0:20–0:23

> Slow push into a dark interface on a flat screen. The screen stays flat and
> square to camera. Subtle glow lift on the panel as it approaches. Nothing in
> the frame deforms.

*Text card: `one shared memory, every agent`.*

---

### 08 · THE PARTS LAID OUT
**Asset:** `assets/04-parts.png`
**Preset:** Arc Left (slow) or Lazy Susan
**Duration:** 0:23–0:26

> Camera drifts slowly left across a row of components laid flat on a dark
> surface. Even hard top light, long soft shadows pointing away from camera.
> Steady, unhurried, catalogue-like.

*Text card: `six printed parts. one evening.`*

---

### 09 · CLOSE
**Asset:** `assets/01-hero.png` again
**Preset:** Static, or Crash Zoom In on the final beat
**Duration:** 0:26–0:30

Hold the hero, then cut to black card:

```
LOOM
one brain, every agent

npm i -g @loompad/cli
loompad.tech
```

Orange rule under the wordmark. Hold four seconds. End.

---

## Music

Ask for it as a brief, not a genre: *"minimal industrial techno, 124 bpm, no
melody, one sub-bass pulse, metallic percussion, cold and precise, builds once
and stops dead."* The stop matters — cut the music on the last frame rather
than fading, so the silence lands under the URL.

Beat map: hits on 0:03 (object arrives), 0:13 (cut to real), 0:26 (close).

## Sound design

Three effects carry the whole thing: a mechanical key actuation on 0:10, a
single relay click on the cut to real at 0:13, and a low sub drop at 0:26. Real
switch sounds beat anything synthesised here — record your own pad if you can.

## Grade

Crush the blacks slightly, keep the product's white genuinely white, push only
the orange in saturation. Do not add a global warm LUT; the whole design is one
warm accent against neutral graphite, and a blanket grade destroys that.

## What to avoid in every prompt

- Naming keycaps, logos, symbols or any text → they will be regenerated wrong
- "Glowing", "neon", "holographic", "futuristic UI" → wrong brand entirely
- Fast motion on any shot containing readable text (06, 07)
- Lens flare, bokeh particles, floating dust — none of it is in the design system
- Asking for a hand to appear in the render shots; the only hand is the real one

## Assets in this folder

| File | What it is |
|---|---|
| `01-hero.png` | three-quarter hero on brand background |
| `02-top.png` | flat top-down deck, every agent key visible |
| `03-exploded.png` | the stack separated |
| `04-parts.png` | components in a row |
| `05-circuit.png` | wiring diagram, flat and legible |
| `06-ui-brain.png` | the shared memory, real screenshot |
| `real-t20/42/55.png` | real device on a real desk, pulled from the build footage |
| `*-cutout.png` | transparent PNGs of each render, if you want to recompose |

Regenerate the plates any time with `python3 make-assets.py`.
