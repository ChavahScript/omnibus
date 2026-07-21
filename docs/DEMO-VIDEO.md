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
*Camera: cut to close-up. You snap the laptop open. Screen glows on your
face. Higgsfield cue H2: the dust motes around the laptop reverse direction
and stream INTO the chassis as faint circuit traces light across the lid —
the "piecing it back together" moment.*

> **YOU:** "—this thing runs a seven-billion-parameter AI model at reading
> speed. Locally. Privately. Tonight. The most private AI infrastructure
> you will ever own is already in your house… powered off."

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

## Higgsfield cue sheet (generate before the shoot)

Both clips composite over your footage with **screen/lighten blend** (pure
black background = free transparency), so instruct the model accordingly.
Generate at 16:9; you'll scale/position in the editor or Remotion.

**H1 — Exploded laptop hologram (for Shot 2), ~10s:**
```bash
higgsfield generate create seedance_2_0 \
  --prompt "Macro product hologram animation on a pure black background: a ghostly white translucent wireframe laptop slowly separates into an exploded view — motherboard, RAM sticks, CPU die, cooling fan floating apart in layers, thin white connection lines between parts, subtle white particle shimmer, elegant slow rotation, monochrome, no text, no logos, studio darkness, cinematic depth of field" \
  --aspect_ratio 16:9 --duration 10 --wait
```

**H2 — Dust reversal / circuit ignition (for Shot 3), ~8s:**
```bash
higgsfield generate create seedance_2_0 \
  --prompt "On a pure black background: a cloud of grey dust particles drifts, then reverses and streams inward toward the center of frame, converging into glowing thin white circuit-board traces that ignite one by one like a city waking up at night, monochrome white on black, no text, elegant, slow motion, cinematic" \
  --aspect_ratio 16:9 --duration 8 --wait
```

Practical notes: film Shots 2–3 with slow, steady laptop movement so the
overlay doesn't need motion tracking — position the hologram beside/above
the laptop rather than locked to it. If a take feels dead, H1/H2 also read
well at 50% opacity behind you as ambient texture.

---

## ACT II — "The Demo" (0:50–2:00, screen recordings + Remotion)

I assemble this from your recordings in `tools/demo-video/` (Remotion
project already scaffolded — drop files into `tools/demo-video/footage/`
with these exact names). Record everything you can at 2× text size, dark
terminal theme, no personal info on screen.

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
