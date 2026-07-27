# Frame packet: 06-close

## Project inputs

- Project: /Volumes/Extreme SSD/Projects/agent-lab/videos/loom-yc-launch
- Design tokens: /Volumes/Extreme SSD/Projects/agent-lab/videos/loom-yc-launch/frame.md
- RULES_DIR: /Users/jaibajrang/.claude/skills/hyperframes-animation/rules

## Assigned storyboard block

## Frame 6 — Close

- src: compositions/frames/06-close.html
- status: outline
- duration: 4.2s
- transition_in: cut
- scene: Wordmark, one line, install command
- note: deliberately longer than its 2.24s voice line — the last ~2s is a silent held card so the install line can be read (and screenshotted) after the narration stops
- voiceover: Loom. One brain, every agent.
- asset_candidates: og-image.png
- footage: footage/07-terminal.mp4 (optional, first 1.5s)
- poster: 2

**0.0–1.5s** — If `07-terminal.mp4` exists: `npm i -g @loompad/cli` typing into a
terminal, then `loom up`. Real, fast, unglamorous. Proof it ships.

**1.5–3.5s** — Final card. `LOOM` wordmark, the line `one brain, every agent`, and
below it in mono, orange: `npm i -g @loompad/cli` and `github.com/nickthelegend/loom`.
Hold dead still for the last full second — no fade, no zoom. The last frame should be
readable if someone pauses it, because someone will.

> Deliberately **not** on this card: "MIT", "local-first", "open source", a QR code,
> social handles, or a "Backed by" row. Every one of them is true and every one of
> them costs you the two seconds the install line needs to land.

---

## Video direction

**Cut rhythm.** Six frames in 30 seconds — an average of five seconds each, but the
distribution is the point: 5 / 3 / **9** / 5.5 / 4 / 3.5. The hero frame is nearly
twice the average. Resist the urge to even them out.

**Every transition is a hard cut.** No crossfades, no wipes, no push transitions. A
dev tool that cross-dissolves reads as a marketing deck. The only motion allowed
between frames is the Frame 1 → 2 collapse, which is a content move, not a transition.

**Colour.** Loom's real brand, captured from loompad.tech: near-black ground
(`#000` / `#0a0a0b`), one orange accent (`#ff6b2b`), Space Grotesk for display, mono
for chrome. The accent appears at most once per frame and never on two things at
once — it is the "look here" instruction, so spending it twice spends it to zero.

**Type.** Nothing on screen is a sentence except the Frame 1 problem statement and the
Frame 6 tagline. Everything else is one to three words. On-screen text and voiceover
must never say the same thing at the same moment — one of them is then redundant, and
the viewer notices the padding even if they can't name it.

**Captions on, always.** A partner may well watch this muted in a browser tab. The cut
has to work with the sound off, which is why the on-screen words in Frames 1, 3 and 6
carry the argument on their own.

**Footage handling.** Crop tight, zoom to ~150% before recording, speed up every wait,
kill personal data and system chrome. Details in `footage/README.md`. The failure mode
is always the same and it is always "too wide to read".

**What this video deliberately does not do:** no founder on camera (that belongs in
the separate YC founder video), no feature list, no architecture diagram, no
"introducing", no music swell at the logo, and no claim about traction that the
product can't show on screen.
