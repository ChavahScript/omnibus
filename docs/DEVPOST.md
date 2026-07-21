# Omnibus — Devpost submission story

## Inspiration

Open the drawer next to your desk. Statistically, there's a working computer in it.

The UN's [Global E-waste Monitor 2024](https://unitar.org/about/news-stories/press/global-e-waste-monitor-2024-electronic-waste-rising-five-times-faster-documented-e-waste-recycling) counted a record **62 million tonnes of e-waste in 2022 — up 82% since 2010** — heading for **82 million tonnes by 2030**, while the documented recycling rate *falls* from 22.3% toward 20%. The category that contains laptops managed only a 22% collection rate. And the machines we keep are barely better off than the ones we discard: the average European household holds [74 electronic products, 13 of them hoarded — 9 still in working order](https://weee-forum.org/ws_news/of-16-billion-mobile-phones-possessed-worldwide-5-3-billion-will-become-waste-in-2022/). In Ireland's national statistics, [58% of people who replaced a laptop or tablet still had the old one at home](https://www.cso.ie/en/releasesandpublications/ep/p-sust/sustainabilityofpersonalictdevices2022/disposingofdevices) in 2024, and EU-wide [only 11% of people recycled their old laptops](https://ec.europa.eu/eurostat/statistics-explained/index.php?title=Green_ICT_-_digital_devices_in_households). Meanwhile the median laptop replacement cycle has stretched [past five years](https://www.spglobal.com/market-intelligence/en/news-insights/articles/2024/3/consumer-checkup-higher-interest-rates-lead-to-longer-tech-replacement-cycles-80965629) — so the "old" laptop in that drawer is usually not old at all.

Here's what changed recently: those drawer laptops became AI hardware. A base M1 MacBook Air runs a quantized 7B coding model at [~14 tokens/second — reading speed](https://github.com/ggml-org/llama.cpp/discussions/4167); an ordinary i7 laptop CPU manages [~15 tokens/second, with the whole 4-bit model fitting in under 4 GB of RAM](https://ceur-ws.org/Vol-4164/paper11.pdf) (peer-reviewed, 2025). The most private AI infrastructure a developer will ever own is already sitting in their house, powered off.

That was half the inspiration. The other half was a pain every developer knows: **AI assistants are amnesiac**. You explain your architecture to a model, it answers, it forgets. Tomorrow you explain it again — or worse, you *don't*, and it confidently proposes the exact approach you rejected three weeks ago for reasons it never knew. We didn't want another prompt generator. We wanted a **side-by-side companion**: an assistant that is *present* in the project — watching the diffs, remembering the trade-offs, holding the vision — so that every rough idea you throw at it comes back audited, enriched, and faithful to what you're actually building.

Omnibus is both answers at once: the drawer laptops become the fleet, and the fleet gets a memory.

## What it does

Omnibus is the developer's ultimate assistant — an AI teammate that pairs to your iPhone with a one-time QR code and lives on your own laptops. You give it a rough thought in a single text field; it does what a great senior colleague would do with a half-formed idea:

1. **It knows what's going on.** A persistent **Second Brain** ambiently watches the project — read-only git polls, optional compiler runs, every past idea, brief, and peer review — and distills it all into a **bi-temporal knowledge graph**. Every fact carries both *valid time* (when it was true) and *transaction time* (when the system learned it); superseded decisions are invalidated, never deleted, so the assistant can explain what the project believed last month and why that changed. Nothing is manually filed. It just knows.

2. **It rigorously audits every prompt against your vision.** Your idea doesn't go straight to a model. A local **Auditor** first enriches it: HippoRAG-style recall extracts the idea's entities and runs **Personalized PageRank** over the knowledge graph —

$$\pi = (1-d)\,p \;+\; d\,W^{\top}\pi$$

   with seed mass on the matched entities, down-weighted by $1/\log(2+\mathrm{deg})$ so rare, specific concepts steer harder than hubs — connecting tonight's thought to a constraint recorded weeks ago, two hops away. The Auditor folds in bounded workspace context, flags risks, and checks the idea against the **Code Digital Twin**: remembered bug fixes, recorded trade-offs, and a registry of anti-patterns with explicit `// Wrong` / `// Correct` examples. What comes back is not a reply — it's a decision-ready brief and a paste-ready IDE prompt that already matches how *your* project does things.

3. **It convenes your fleet.** Spare laptops on your LAN join as **Home Fleet** workers over an HMAC-signed, replay-protected protocol and review each idea through stable, complementary lenses — product, feasibility, risk. With an explicit opt-in, the fleet shares one redacted, content-addressed context bundle **peer-to-peer** (single-use HMAC tickets, SHA-256 content addressing) and pre-warms it into each model's prompt cache, so repeat reviews answer with a fraction of the cold-start latency — an LMCache/Mooncake idea adapted to Ollama. Each laptop has a name ("macOS Peer · Cedar", or `--label "Kitchen MacBook"`), a stable lens, and a visible place in your organization.

4. **It guards the main branch.** `omnibus-bridge hook install` adds a shift-left pre-commit gate that mechanically blocks and auto-corrects known anti-patterns — and *teaches*, shipping the Wrong/Correct example with every block. The gate fails open on any infrastructure error; only real findings may ever stop a commit.

5. **It fits the machine it lands on.** Installing the bridge turns a laptop into a small always-on database and inference host, so the package sizes itself to the hardware: capacity knobs left unset resolve from physical memory into compact / balanced / power / studio tiers — context window, graph limits, retrieval depth, ambient cadence, model residency. An 8 GB drawer laptop is a first-class citizen, not an OOM report.

By default everything runs on local Ollama models — no accounts, no API keys — and nothing is shared with an outside service or another machine without its own per-idea consent switch (web research and Home Fleet each have one). Cloud provider modes exist only as explicit laptop-side opt-in configuration.

## How we built it

- **Bridge (the control plane):** TypeScript on Node 22 — Express + `ws` behind a supervised localtunnel, zod-validated wire contracts, a durable serial command queue, an append-only redacted audit trail, and a device-event replay journal so a phone that walks out of Wi-Fi range gets its missed progress back.
- **Second Brain:** an append-only NDJSON journal for the bi-temporal graph (content-derived IDs so replicas converge without coordination), a dependency-free Personalized PageRank implementation, ambient watchers with deterministic heuristic fallbacks and hard rate limits, and the anti-pattern registry with the pre-commit CLI.
- **Fleet protocol:** hand-rolled authenticated HTTP on RFC1918 addresses only — per-worker derived HMAC secrets, timestamps, nonce replay windows, one-time join invitations, signed heartbeats that carry cache advertisements and renames, and the ticketed P2P context-transfer path.
- **iOS app:** Expo / React Native with the New Architecture, Skia + Reanimated for the idea-mist atmosphere, a custom CoreHaptics module in Swift, Keychain-held rolling resume credentials, and Fastlane→TestFlight delivery.
- **Process:** AI-assisted development end to end — agent teams audited the codebase, implemented modules against a shared type contract in parallel, and adversarial review fleets (finders plus independent skeptics per finding) verified the work. A separate *product* audit drove real WebSocket journeys, kill-and-restart durability runs, and resource measurements against the built binary, surfacing 37 functional issues we then fixed. The bridge ships with 183 automated tests.

## Challenges we ran into

- **Local-first resumption is brutal.** React Native reports an HTTP 401 upgrade rejection as an indistinguishable WebSocket 1006. We had to complete the upgrade and close with a deliberate 1008 so iOS could tell "bridge restarted, forget the session" apart from "coffee-shop Wi-Fi blinked."
- **The laptop is the database — and must not be eaten by it.** Our first knowledge graph could out-grow an 8 GB machine and our ambient watcher could keep a 7B model resident all day. The fixes became features: memory-tiered adaptive sizing, event-node recycling with a cold archive so history is preserved without unbounded RAM, rate-limited distillation that never extends model residency, and co-residence detection so one machine running coordinator *and* worker never double-loads models.
- **Ollama's prompt cache only rewards byte-identical prefixes.** One byte of drift in the shared bundle and the latency win evaporates — so bundles are content-addressed by SHA-256, transferred verbatim, and warmed asynchronously so a slow model ingest can never time out the signed offer window.
- **Deterministic offline merges.** Fleet reviews finishing while the phone was offline must produce the same graph no matter the arrival order. That forced content-derived node/fact IDs, a total order on (transaction-time, content-hash), and a supersede rule that never lets a stale contribution invalidate a newer belief.
- **Sign what was sent, not what you parsed.** Our first heartbeat extension filtered invalid fields *before* HMAC verification — silently changing the signed payload and rejecting honest workers. Verify raw, sanitize after.
- **A pre-commit gate must never brick a commit.** Every infrastructure failure — unreadable graph journal, broken `.env`, a directory that isn't even a git repo (which git reports as "unknown option," exit 129, not "not a repository") — has to fail open, while real findings fail closed.

## Accomplishments that we're proud of

- A **bi-temporal knowledge graph with deterministic multi-device merge** — in dependency-free TypeScript, on an append-only journal a human can read — that sizes itself to the laptop it lives on.
- **HippoRAG-style multi-hop recall** running at reading speed on the kind of hardware the UN counts as e-waste.
- A LAN fleet protocol with one-time joins, replay windows, and **single-use P2P transfer tickets** — where the privacy invariant "workers never see your files" survived an adversarial review.
- A pre-commit gate that *teaches* — every block ships the pattern's own Wrong/Correct example — and auto-corrects only lines its detector actually flagged.
- A product-minded audit culture: 37 real functional findings (a phone permanently trapped in a setup sheet, emoji-heavy ideas killing the socket, corrupt state files bricking the queue) found by *using* the product, and fixed with 183 tests to hold the line.

## What we learned

- **Constraints are a design tool.** A $100 hackathon budget produced a better architecture than a blank check would have: local-first stopped being an ideology and became the only option — and then the best feature.
- **The best assistant is the one that was in the room.** Recall beats scale for a developer's daily work: a 7B model that *knows your project's history* gives more faithful briefs than a frontier model meeting your codebase for the first time.
- **Determinism is a distributed-systems feature you can have without a coordinator** if every identifier derives from content instead of clocks.
- **Caching is a privacy decision.** Sharing a pre-computed context across machines is a *consent boundary*, not an optimization flag — it deserved its own switch, default off.
- **Verify your own story.** We ran our statistics through adversarial verification and dropped every number that didn't survive — including some genuinely tempting ones about idle compute that turned out to be internet folklore.

## What's next for Omnibus

- **Fleet calibration:** measure a profile on the owner's actual hardware instead of estimating from specs.
- **True KV-tensor transfer:** swap the prompt-prefix cache for raw KV pages over the same ticketed P2P path via a vLLM/LMCache backend.
- **Graph time-travel UI:** scrub the knowledge graph's transaction timeline from the phone — watch a decision get made, contradicted, and superseded.
- **Android client** and richer approval gates for every action that touches the workspace or the network.
- **The drawer-laptop onboarding:** a guided flow that takes a five-year-old machine from powered-off to named fleet member in under ten minutes — because the [9 working devices hoarded in the average household](https://weee-forum.org/ws_news/of-16-billion-mobile-phones-possessed-worldwide-5-3-billion-will-become-waste-in-2022/) are the greenest datacenter never built.

---

## Built with (Devpost tags)

`typescript` `node.js` `react-native` `expo` `swift` `ollama` `express` `websocket` `zod` `ios` `xcode` `fastlane` `skia` `reanimated` `corehaptics` `hmac` `sha-256` `knowledge-graph` `hipporag` `pagerank` `p2p` `localtunnel` `npm` `brave-search` `remotion`

## Try it out

- **Code:** https://github.com/ChavahScript/omnibus
- **Install (bridge, npm):** https://www.npmjs.com/package/omnibus-bridge — `npm i -g omnibus-bridge && omnibus-bridge setup --install-runtime --pull-models && omnibus-bridge start`
