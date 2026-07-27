---
format: 1920x1080
duration: 30s
message: Every coding agent keeps its own memory — Loom makes them one brain
arc: Pain → Claim → Mechanism → Proof → Reach → Close
audience: A YC partner skimming dozens of applications, who has personally re-explained a codebase to a second AI agent
mode: collaborative
music: focused-technical-build
---

# Loom — YC application video

**The job of this video:** make a partner believe, in 30 seconds, that (a) this is a
real pain they have felt, (b) there is a real product, running, that fixes it, and
(c) the person who built it can build.

**The one rule that governs every frame:** the product is on screen by 0:08 and never
leaves for longer than two seconds. Motion graphics are connective tissue between
shots of the real thing — never the subject. If a frame has no footage available, its
stand-in must still look like a *product*, not like a slide.

---

## Frame 1 — The pain

- src: compositions/frames/01-pain.html
- status: outline
- duration: 4.8s
- transition_in: cut
- scene: Two agent windows, the same project explained twice
- voiceover: Every coding agent keeps its own memory. Switch tools, and you start over.
- asset_candidates: workspace.png
- footage: footage/01-reexplain.mp4 (preferred) — else build the two-pane stand-in described below
- poster: 2.5

Open cold. **No logo, no title card** — a partner who sees branding first assumes
there is nothing behind it.

**0.0–2.0s** — A single dark pane, filling frame, mono type: a developer pasting a
long project explanation into Claude Code. We are close enough to read three or four
words, not the whole thing. The point is the *volume* of context, not its content.

**2.0–3.5s** — Hard cut, no transition, to a second identical-looking pane — different
agent, same wall of text going in again. The cut is the joke: nothing visibly changed
except the tool. Land this cut on the word "switch".

**3.5–5.0s** — Both panes sit side by side. A hairline rule divides them, and a single
orange word appears between: `no shared memory`. Hold. This is the only frame allowed
to state the problem in words.

> If `01-reexplain.mp4` doesn't arrive, build it: two mono panes, text typing in on
> the left, the same text typing in on the right two seconds later. It reads almost as
> well as real footage because the content is deliberately illegible anyway.

---

## Frame 2 — The claim

- src: compositions/frames/02-claim.html
- status: outline
- duration: 1.835s
- transition_in: cut
- scene: The wordmark and the one-line claim
- voiceover: Loom makes them one brain.
- asset_candidates: og-image.png
- footage: none — pure graphic frame, brand tokens only
- poster: 1.5

The only frame that is pure graphic, and it is three seconds long for a reason: it is
the hinge between problem and product, and it earns its place by being *short*.

**0.0–1.2s** — The two panes from Frame 1 slide together and collapse into one form.
Not a dissolve — a physical join, the divider line shrinking to nothing.

**1.2–3.0s** — `LOOM` in Space Grotesk 700, large, left-aligned on the black ground.
Beneath it, one line in mono at a quarter of the size: `the shared-memory layer for
AI coding agents`. Orange rule under the wordmark, drawn left-to-right in 300ms.

No tagline animation, no glow, no particles. Type and a rule.

---

## Frame 3 — The mechanism · **HERO**

- src: compositions/frames/03-mechanism.html
- status: outline
- duration: 8.405s
- transition_in: cut
- scene: The workspace, then the baton moving between agents mid-thread
- voiceover: One thread over every agent. Pass the baton, and the context goes with it — decisions, memory, the whole conversation.
- asset_candidates: workspace.png, brain.png
- footage: footage/02-workspace.mp4 + footage/03-baton-switch.mp4 (both required) — else push in slowly on workspace.png
- poster: 5

**The most important nine seconds in the video.** Nearly a third of the runtime, on
purpose. Everything before it is setup and everything after it is evidence; this is
the only stretch where the partner actually sees what the product *is*.

**0.0–2.5s** — `02-workspace.mp4`, full bleed, no frame or device mockup. The whole
workspace: projects left, thread centre, Explorer right. Let it sit still for a full
second before anything moves — a partner needs a beat to parse an unfamiliar UI. No
caption over this; the voiceover is carrying it.

**2.5–6.5s** — Cut to `03-baton-switch.mp4`, **cropped tight to the composer** so the
agent chips fill the lower third and are readable at phone size. The gesture: click
the agent selector, pick a different agent, send. The baton indicator moves. This is
the money shot — if only one shot in the video is legible, make it this one.

Hold a small orange callout on the baton indicator for ~800ms as it changes — a
hairline box, no arrow, no label. Draw the eye, don't annotate.

**6.5–9.0s** — Stay in the thread as the new agent's reply streams in *continuing the
same conversation*. Three words of on-screen mono, bottom-left, appearing one per
beat with the voiceover: `decisions` · `memory` · `the whole conversation`.

> The single most common way this frame fails is being too wide. Crop in. A partner
> watching at 40% zoom in a browser tab cannot read a full-width IDE.

---

## Frame 4 — The proof

- src: compositions/frames/04-proof.html
- status: outline
- duration: 5.888s
- transition_in: cut
- scene: Five agent marks, then a route running plan → execute → review
- voiceover: Five agents, working today. Or let Loom route the whole job — plan, execute, review.
- asset_candidates: board-projects.png, board-linear.png
- footage: footage/04-route.mp4 (preferred), footage/05-observatory.mp4 (optional tail) — else build the agent-mark row and route banner
- poster: 2

**0.0–2.0s** — Five agent brand marks in a row on black — Claude Code, Codex,
OpenCode, Grok, Antigravity — each landing on a beat, 120ms apart. Under them, mono:
`verified against a real version`. This is the "it actually works" claim and it needs
to be visibly *specific*.

**2.0–5.5s** — `04-route.mp4`: the route banner ticking `plan → execute → review`,
hops completing. Speed the footage up so the whole pipeline resolves inside three
seconds — nobody needs to watch an agent think. Keep the *completion* at full speed.

If `05-observatory.mp4` exists, take its last 800ms as a flash-cut on the final word:
a glimpse of traces and cost. Don't explain it. A partner who cares will notice a
company that instrumented itself; one who doesn't will read it as depth.

---

## Frame 5 — The reach

- src: compositions/frames/05-reach.html
- status: outline
- duration: 2.752s
- transition_in: cut
- scene: The same thread, on a phone
- voiceover: Same thread on your desk, and in your pocket.
- asset_candidates: keep-agents-moving-from-your-phone.jpg, workspace.png
- footage: footage/06-phone.mp4 (preferred)
- poster: 2

**0.0–1.5s** — Desktop thread, held from Frame 3's framing so the continuity is
obvious.

**1.5–4.0s** — Cut to the phone showing *the same conversation*. Real device in hand
if you have it; a screen recording is fine. The whole beat rests on the viewer
recognising the thread they were just looking at, so **do not** cut to a different
project or a different chat. Same content, smaller screen.

This is the shortest evidence beat and the one most likely to be cut if the edit runs
long. Cut it before you cut anything in Frame 3.

---

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
