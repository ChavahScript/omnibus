# Omnibus — 3-minute demo video: script & production plan

Format: 1920×1080, 30 fps. The first two minutes are fully scripted below —
**Act I** is filmed in person with your HP laptop plus Higgsfield overlays;
**Act II** is assembled in Remotion from your screen recordings. The final
minute is a closing montage + CTA (sketched at the end, flexible).

Design rule for the whole video, learned on the thumbnail: **Higgsfield for
organic, cinematic texture; Remotion for every pixel of text.** Generated
type looks AI-made; code-rendered type looks engineered. All stat cards and
captions are Remotion components in the same Swiss monochrome system as the
Devpost card (Helvetica Neue weight-contrast + Menlo captions).

---

## ACT I — "The Drawer" (0:00–0:50, in person)

**Setting.** One continuous location: your desk. Warm practical light, camera
on tripod at chest height, you in frame from the waist up. The HP laptop
starts INSIDE a real drawer. Wear something plain — the laptop is the star.

### Shot 1 — Cold open (0:00–0:08)
*Camera: static medium shot. You pull open the drawer, lift out the HP,
blow dust off the lid (real dust if you can — flour works), hold it up.*

> **YOU:** "This is my old HP. Five years old. Slow enough that I replaced
> it, guilty enough that I kept it. My IT guy calls this e-waste."
>
> *(beat, look at camera)*
>
> "Statistically… he's right."

### Shot 2 — The exploded view (0:08–0:24)
*Camera: slow push-in as you hold the laptop flat toward the lens like an
offering. This is Higgsfield overlay territory — see cue H1. The laptop
"opens up" as a ghost-white exploded hologram: board, RAM, CPU floating
above the real chassis. Remotion stat cards type on beside it, one per
beat (see R1): "62,000,000 tonnes of e-waste in 2022 — UN" → "9 working
devices hoarded in the average household" → "median laptop lifespan: 5+
years".*

> **YOU (over the overlay):** "Sixteen gigs of RAM. Eight cores. Sitting in
> a drawer, doing the one thing computers are worst at: nothing.
> There are nine of these in the average house. Sixty-two million tonnes of
> this a year. And here's the part nobody tells you—"

### Shot 3 — The turn (0:24–0:38)
*No cut — Shot 2's clip ends on the laptop sitting open on the desk, dark
screen facing camera, and this beat animates that exact frame forward, so it
plays as one continuous shot. Higgsfield cue H3 (image-to-video generated
directly from the real open-laptop still — no compositing, the way Shot 2's
hologram was): the dead screen wakes. A soft white glow blooms out of the
black, then the Omnibus knowledge-graph constellation ignites across the
screen — glowing white nodes and thin connecting lines, a "second brain"
coming online, a few new nodes lighting up as it grows. Cool white light
spills from the screen onto the keys and the desk. The machine that was doing
nothing is suddenly alive. Hold on the lit screen for the tail so the stat
card can sit beside it.*

> **YOU:** "—this thing runs a seven-billion-parameter AI model at reading
> speed. Locally. Privately. Tonight. The most private AI infrastructure
> you will ever own is already in your house… powered off."
>
> *(Land "powered off" exactly as the screen finishes igniting — the whole
> beat is the turn from "powered off" to alive; the visual answers the line.)*

*Remotion card (R2), small, lower third: "7B model · ~15 tokens/sec · <4 GB
RAM — peer-reviewed, 2025".*

### Shot 4 — Cue the demo (0:38–0:50)
*Camera: over-the-shoulder on the HP's screen. One terminal, huge font,
one line typed on camera:*

```
npm i -g omnibus-bridge
```

> **YOU:** "So we stopped treating old laptops like trash, and started
> treating them like teammates. This is Omnibus — your ideas, your laptops,
> your second brain. Watch what happens when the drawer laptop gets a job."

*You spin the laptop to face the camera; the screen fills the frame —
match-cut to Act II (the digital half opens on that same terminal).*

---

## Higgsfield cue sheet

We landed on a better method than compositing an overlay: **image-to-video
from the actual filmed frame**, so the effect happens on your real laptop, on
your real desk, with zero masking. Shots 2 and 3 are both already generated
this way and graded to match the footage — they live in `docs/demo-assets/`.

**H2 — Exploded / x-ray hologram (Shot 2) — DONE:** generated from the
top-down closed-laptop frame; the closed lid turns translucent and the real
internals (board, dual fans, RAM, CPU, battery) light up in monochrome white.
File: `docs/demo-assets/shot2-hologram-matched.mp4`.

**H3 — SHIPPED VERSION: "DESCENT — the machine's own desktop"
(`docs/demo-assets/shot3-descent.mp4`, 1080p/30fps/15s, silent).** Pure
Remotion (`tools/demo-video/src/Descent.tsx`, composition id `Descent`), not
AI-generated. The camera is sucked through the real laptop's dark screen
(frame 0 is the EXACT final frame of `assembled-seamless.mp4` — butt-splice
directly after, no transition; color/grain/HLG tags matched) into a monochrome
dark **Windows desktop**, where the OS itself acts out the spoken line through
popups:
- *"seven-billion-parameter AI model"* → `mistral-7b.gguf` **Properties**
  dialog; the Parameters row split-flap locks `7,000,000,000` on "billion"
- *"at reading speed"* → **Notepad** types the brief token-by-token; the
  status bar reads `12.4 tok/s`
- *"Locally."* → **"Wi-Fi disconnected"** toast — the typing never stutters
- *"Privately."* → permission dialog: `cloud-sync.exe is trying to send
  data` → the pointer clicks **BLOCK**
- *"Tonight."* → inverted toast: **Omnibus is ready · TONIGHT · 9:47 PM ·
  NO ACCOUNT · NO CLOUD** (the taskbar clock reads 9:47 PM throughout)
- *"most private AI infrastructure"* → Win11 **snap grid**: Properties,
  Notepad, Home Fleet, Second Brain tile into a 2×2 workspace
- *"already in your house… powered off"* → windows minimize, **Shut down
  HP-DRAWER?** dialog ("Your second brain is saved. It will remember — even
  powered off."), pointer clicks SHUT DOWN, the desktop dies to black, we're
  back outside on the dark laptop, holding static.
Read the line over it; land "powered off" exactly as the screen dies (~12.5s in).

**H3b — The fly-out (`docs/demo-assets/shot3b-flyout.mp4`, 1080p/24fps/8s,
silent).** Seedance image-to-video anchored on the descent's final frame, so
it butt-splices onto the descent's static tail (cut anywhere in the hold;
grade matched to ±1 RGB, same grain + HLG tags). One continuous AI move — no
color seam inside it: the camera pulls back from the dark laptop, the lid
closes on its own, then the closed laptop lifts off the desk and **flies out
the right edge of frame**, leaving the empty desk. The next clip is filmed
for real: you catch the laptop. (If the throw direction is wrong for the
catch, mirror the clip: `ffmpeg -i shot3b-flyout.mp4 -vf hflip …`.) If the
texture blink at the descent→flyout cut ever reads on a big screen, soften it
with a 4-frame cross-dissolve — the compositions match, so it melts cleanly.

**H3 — earlier alternate (composited screen-wake), kept for reference:**
the dead screen glows to life and the Omnibus knowledge-graph constellation
ignites across it (white nodes + connecting lines, the "second brain"), cool
light spilling onto the keys. 1080p / 30 fps / ~7 s, silent (read the line over
it). File: `docs/demo-assets/shot3-screen-wake.mp4`.

*Method note — why this one is a composite, not image-to-video.* Unlike H2, the
image-to-video route was blocked: Higgsfield's content filter false-positived on
the open-laptop still (`nsfw`) across four attempts (full frame + prompt
variants + a tightened 16:9 crop), regardless of wording. So H3 was built the
fallback way, which still uses your **real** frame and needs zero compositing on
your end:
1. Generate the constellation on **pure black** (text-to-video, no start image —
   nothing for the filter to catch):
   ```bash
   higgsfield generate create seedance_2_0 \
     --prompt "A knowledge-graph constellation igniting on a pure solid black background. Glowing soft-white nodes fade in one by one, thin white lines draw between them connecting the points into a living network, a few new nodes lighting up and linking as it grows — a second brain coming online. Slow, calm, cinematic, centered, white-on-black only, subtle bloom, no text, no UI, no laptop, no people, pure black background for screen-blend compositing" \
     --aspect_ratio 16:9 --duration 8 --wait
   ```
2. Freeze the settled open-laptop frame (the last clean frame of the previous
   clip), corner-pin the constellation onto the screen glass with ffmpeg
   `perspective`, `screen`-blend it, add a soft `gblur` spill for the light on
   the keys, a slight cool tint, a ~0.8 s dark "powered off" lead, then grade +
   grain-match to the footage. Full filtergraph: `docs/demo-assets/shot3.filter`.

If you'd rather it happen on the real laptop via image-to-video after all, the
one workaround left is to generate a *synthetic* clean open-laptop frame (GPT
Image 2 won't trip the filter) and run image-to-video from that — it trades
"your actual desk" for "no ffmpeg composite." The composite above avoids that
trade, so it's the shipped version.

---

## ACT I — FINISHED MASTER (`docs/demo-assets/act1-final.mp4`)

The first 1:02 is fully posted: **act1-final.mp4** (1920×1080·30fps, −15.5
LUFS, HLG-tagged like the camera footage). Built from
`footage/copy_8226FE7C…mov` through five passes:
1. **Selective focus** — per-segment background defocus + dim through
   feathered masks (subject/x-ray/dialog isolation), gentle vignette on real
   footage; rack changes hidden at cuts. Masks in `docs/demo-assets/masks/`.
2. **Zoom EDL** — 10 moves (pushes/punches/catch-shake) frame-timed to word
   onsets (locked plan: `_scout/locked_plan.json`).
3. **Subtitles/graphics** — Remotion `Act1Overlay` (ProRes 4444 alpha):
   word-accurate captions (whisper word timings, corrected text), keyword
   emphasis (Helvetica 700) over Menlo caps, raised above the taskbar during
   the Windows world; 5 stat cards; end title card (Omnibus wordmark ·
   `YOUR LAPTOPS · YOUR IDEAS · YOUR MODELS` · `$ npx omnibus`).
4. **Sound design** — 32 cues: Mirelo foley (drawer, dust, hologram hum,
   dive riser→impact at 37.95, power-down, lid close, fly-off, catch) +
   synthesized UI (clicks, toast pops, ready-ding, split-flap flutter, snap
   thunks, minimize whooshes, end hit at 60.68). `docs/demo-assets/sfx/`.
5. **Music** — Sonilo 3-minute score (`music-full.m4a`), razor-edited so its
   minute-two DROP lands exactly on the dive (37.95), breakdown under the
   closing line, swell at the title card; ducked under VO via sidechain.

**Music continuation for parts 2–3:** the full 180s track is structured
sparse-build → groove (60s+) → emotional lift (≈148s+). Act I ends with the
track at position ≈ **83.9s** (mid-groove). Start part 2's music bed at
track 83.9s for a seamless continue; the lift section (~148s→end) is sized
for the Codex story + outro minute.

---

## ACTS II & III — FINISHED MASTERS

Both acts are fully produced as code-rendered Remotion recreations
(`tools/demo-video/src/Act2.tsx`, `Act3.tsx`, shared kit `film-ui.tsx`) —
same window chrome and design system as the Act I Windows world, all
on-screen text authentic to the product (real CLI strings, real repo stats:
26,690 lines · 160 files · 199 tests · 2 days).

- **`docs/demo-assets/act2-final.mp4`** (60s) — pair → idea → agents → brief
  → recall → fleet → gate → closing snap grid. Music: the score's groove
  (one internal loop), −21 LUFS bed with SFX — ready for VO on top.
- **`docs/demo-assets/act3-final.mp4`** (58s) — Codex session → subsystem
  cascade → the numbers → the 2 a.m. loop → architecture ("CODEX BUILT
  THIS") → end card with BUILT WITH CODEX. Music: the score's exclusive
  final 58s — the lift lands on the story's turn and the track's written
  ending resolves exactly on the end card.

Assemble: act1-final + act2-final + act3-final, butt-spliced. Record VO per
the timed scripts below and lay it on top (beds leave ~5 dB of headroom).

---

## ACT II — "The Demo" (legacy planning notes)

I assemble this from your recordings in `tools/demo-video/` (Remotion
project already scaffolded — drop files into `tools/demo-video/footage/`
with these exact names). Record everything you can at 2× text size, dark
terminal theme, no personal info on screen.

### ACT II SPOKEN SCRIPT (~55s read — record after the screen captures, same voice/mic as Act I)

> **YOU:** "Here's the real thing — no cuts.
> One command on the laptop. One scan with my phone. Paired —
> no accounts, no cloud, nothing leaves this room.
> I send it an idea straight from my couch — an auditor agent digs
> through my codebase, a developer agent drafts the plan — all of it
> running on the drawer laptop, at reading speed.
> The brief comes back scoped, risked, and ready to build.
> And when I send a second idea… it remembers the first.
> That's the second brain.
> Then my other laptop joins the fleet — and reviews the plan from
> three angles while I make coffee.
> And when I try to commit a mistake it has seen before — it blocks me.
> It learned.
> Your laptops. Your ideas. One brain."

Line-to-picture map: "One command" → `01-start-qr` · "One scan" → `02-scan-pair` ·
"I send it an idea…reading speed" → `03-idea-brief` · "The brief comes back" →
brief arrival moment · "second idea… remembers" → `04-recall` · "joins the
fleet…three angles" → `05-worker-join` + `06-fleet-review` · "blocks me. It
learned." → `07-hook-block` · closing triad over a 2×2 snap of all windows
(I'll build that in Remotion, mirroring Act I's grid).

### Recording checklist (what you capture)

| File | What to record | Length |
|---|---|---|
| `01-start-qr.mp4` | Mac/HP terminal: `omnibus-bridge start` → boot lines → QR renders | 15s |
| `02-scan-pair.mp4` | iPhone screen-record: scan QR → "Laptop linked" → Fleet Setup opens showing SIZED FOR tier | 15s |
| `03-idea-brief.mp4` | iPhone: type an idea (pick something real, e.g. "add offline export to the reports screen"), send → agent call sheet → status stream → brief arrives | 30s realtime (I'll speed-ramp) |
| `04-recall.mp4` | iPhone: submit a RELATED second idea → capture the "Second Brain recalled linked project memories" status + open Fleet Setup brain card (facts/nodes moved) | 20s |
| `05-worker-join.mp4` | **The HP from Act I**: paste the worker invite command in PowerShell → "Fleet Setup shows this laptop as …" line visible | 15s |
| `06-fleet-review.mp4` | iPhone: approve the HP in Fleet Setup (its name visible!), send an idea with Home Fleet on → lens-labeled peer reviews land in the brief | 25s |
| `07-hook-block.mp4` | Terminal: `git commit` → pre-commit gate blocks with the Wrong/Correct lesson → `--fix` → commit passes | 20s |

### Beat structure (what I build from it)

- **Beat 1 · Pair (0:50–1:05)** — `01` + `02` split-screen (terminal left,
  phone right in a device frame). Caption: `ONE QR · NO ACCOUNTS · NO CLOUD`.
- **Beat 2 · Idea → Brief (1:05–1:25)** — `03` full-bleed phone, speed-ramped;
  captions name the pipeline as it happens: `AUDITOR — enriching against
  your workspace` → `DEVELOPER — composing the brief`. Stat card at the
  brief's arrival: `RUNNING ON A 7B MODEL. ON A LAPTOP.`
- **Beat 3 · Second Brain (1:25–1:40)** — `04`; the recall status line gets
  a highlight ring; caption: `IT WAS IN THE ROOM. IT REMEMBERS.` Brain-card
  counters tick up.
- **Beat 4 · The drawer laptop gets a job (1:40–1:55)** — `05` + `06`. This
  is the emotional payoff: the HP from Act I appears BY NAME on the phone.
  Caption: `THE DRAWER LAPTOP JUST JOINED THE REVIEW.` Lens labels
  (Product/Feasibility/Risk) called out as they land.
- **Beat 5 · The gate (1:55–2:00)** — `07`, fast cut. Caption:
  `IT GUARDS THE BRANCH.` Hard cut to black on the commit passing.

## ACT III — "Built with Codex" (2:02–3:00)

The music's emotional lift arrives at track ~148s ≈ film ~2:06 — land the
story's turn there. Read ~55s at natural pace. Fill the [BRACKETS] with your
real numbers before recording — do not invent them.

> **YOU:** "I didn't build this alone. I built it with Codex.
> Every subsystem in Omnibus — the bridge, the fleet protocol, the
> second brain — started as a conversation. I described the system
> I wanted. Codex built it, tested it, and pushed back when I was wrong.
> [ [N] commits. [N] lines. [N] days. ] *(← your real stats)*
> When it broke at two in the morning, Codex debugged it with me.
> When I hit things I'd never done — mesh networking, color science,
> knowledge graphs — it had.
> *(music lift lands here)*
> Omnibus exists because one person with Codex can now build what
> used to take a team.
> Old laptops. New intelligence. One developer.
> Watch what happens next."

Visuals (screen recordings to capture, same 2× text/dark theme rules):
| File | What to record | Length |
|---|---|---|
| `c1-codex-session.mp4` | A real Codex session on this repo: prompt → diff streaming in | 20s |
| `c2-git-log.mp4` | `git log --oneline` scrolling the project history (or a GitHub commits page) | 10s |
| `c3-hard-moment.mp4` | The gnarliest thing Codex helped with (open that file/PR and scroll it) | 10s |
| `c4-repo-tree.mp4` | The repo tree / architecture doc briefly panned | 8s |
End card: Act I's title card returns + one added Menlo line: `BUILT WITH CODEX`.

### Minute three (sketch, outside the 2-minute script)

Closing montage over H2 re-used at low opacity: the Devpost thumbnail
schematic animates its connections (I can port it to Remotion), one line of
type — "Your ideas. Your laptops. Your second brain." — then the repo URL
and `npm i -g omnibus-bridge`. Optionally 10s of you closing the drawer,
empty. The laptop doesn't live there anymore.

---

## Platform note for the shoot

The bridge and Home Fleet workers run on both Windows and macOS (the phone
app is iOS). The HP's on-camera moments use PowerShell verbatim — the
worker invite command from Fleet Setup pastes as-is. A Windows-specific
compatibility audit ran across the CLI, Second Brain, and fleet protocol
before this script was finalized; anything it found is fixed in the repo.
