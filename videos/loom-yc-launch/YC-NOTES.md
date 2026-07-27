# What YC actually asks for — read this before you submit

Researched from YC primary sources (ycombinator.com/video, the YC Library, Dalton
Caldwell's and Paul Graham's own words). The single most important finding first.

---

## ⚠️ The application has TWO video fields, and this video goes in the second one

**1. The founder video — NOT this video.**
[ycombinator.com/video](https://www.ycombinator.com/video), verbatim:

> "The video should be 1 minute long and should contain nothing except the founders
> talking."
>
> "**This is not the place to submit a demo or promotional video.** If you have a demo
> for your product, there is a separate place in the application for that. For this
> video, we want to hear how the founders communicate."
>
> "Do not recite a written script: Use bullet points instead."

Dalton Caldwell, YC's Head of Admissions, names putting a produced demo in this slot as
a specific anti-pattern he sees constantly
([Startup School](https://www.ycombinator.com/library/6t-how-to-apply-and-succeed-at-y-combinator)):

> "Another thing that people do a lot is they put in, like, an unrelated video of a
> product demo that they made with one of those free tools where there's no humans in
> it… there's a whole genre of things that people put in there that are not remotely
> following directions. So please follow the directions. I swear it matters."

He also quantifies why it matters:

> "if you have an application that actually follows the directions really well, and is
> well written and does the video stuff correctly… you get about **four times higher
> odds to get an interview**."

**So: the founder video must be you, on camera, one minute, unscripted, no music, no
screen recording, no editing.** All founders present. If you're remote, screen-record a
call. Paul Graham: *"We don't care about the pitch in the video. That's already in the
application. We just want to see what the founders are like as people."*

**2. The demo field — this is where `renders/video.mp4` goes.**
The form's helper text asks you to demonstrate how the product works via a short
screencast or live demo. Stephanie Simon (YC),
[Include a demo](https://www.ycombinator.com/library/J8-yc-application-tips-include-a-demo):

> "We don't care if the demo is unpolished. We don't care if you're still running it
> locally or if it's just a CSV right now. **The difference between nothing and
> something is actually huge to us.** It shows us that you're serious and that you can
> get something built."

---

## What the research changed about this cut

**Length.** I sampled 12 Launch YC videos from dev-tool/infra companies. Median **96.5s**,
mean 97s, range 46–207s. **Nothing in the sample was under 45 seconds.** Our 28s cut is
shorter than any YC launch video I could find.

That is fine for the *application demo field* — Simon's bar is "something rather than
nothing", and a partner skimming wants it short. But if you later want a **Launch YC**
post or a Product Hunt launch, plan a 60–90s cut instead. The extra time goes into the
workflow beat (Frame 3), not into more beats.

**Pace.** Every polished VO in the sample measured **142–164 wpm**. Ours is 68 words over
~26s of speech ≈ 157 wpm. On target.

**Openings.** Zero of the 12 opened on a logo animation. Four opened on a spoken claim
before any product appeared — TrustAI opens on a cold statistic, Vendo opens on a
literal coffee machine and delays the product past 10 seconds. Our problem-first open
is consistent with the strongest examples in the set.

**Chrome discipline is the most visible craft delta in the sample.** Rowboat, Clueso and
Nebula crop to the app window. OneCLI left Chrome tabs, the bookmarks bar, the macOS
menu bar, the Dock *and* the Loom recording controls in frame. Do not be OneCLI — see
`footage/README.md`.

**Screen-recording numbers** (Clueso, YC W23 — the only YC company publishing real craft
guidance): set app zoom to **110–125%** before recording; push-ins of **5–10%**, never
more than 15%; anchor zooms to the element, not screen centre; **250–400 ms** of space
after a click before a zoom lands; freeze **0.5–1.0s** on dense screens; cut all loading
waits.

---

## Things deliberately left out of this cut

- **No music.** MusicGen's dependencies aren't installed and there's no HeyGen
  credential, so the cut ships VO-only. Research is clear that a *music-only* dev-tool
  video is a failure mode, but VO-without-music is merely plainer, not wrong. If you
  want a bed: `pip install transformers torch soundfile numpy`, or
  `npx hyperframes auth login`, then re-run the audio step.
- **No founder on camera.** That belongs in the other field, unedited.
- **No MIT / open-source / local-first badges on the end card.** Every one is true and
  every one costs the install line its two seconds.

## Known cosmetic warnings (all deliberate)

`npx hyperframes check` reports 7 contrast warnings, 0 errors:
- 2 in Frame 1 — the wall of re-pasted context is *meant* to be unreadable; the point is
  its volume, not its content.
- 2 in Frame 3 — the inactive agent chips are dimmed so the active one reads.
- 3 in Frame 4 — 4.49:1 against a 4.5:1 threshold. Imperceptible.
