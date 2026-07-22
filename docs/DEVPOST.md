# Omnibus — Devpost submission story

## Inspiration

I opened the drawer next to my desk. There was a working laptop in it — mine, six years old, replaced for being slow, kept out of guilt. That drawer is not unusual: the UN's [Global E-waste Monitor 2024](https://unitar.org/about/news-stories/press/global-e-waste-monitor-2024-electronic-waste-rising-five-times-faster-documented-e-waste-recycling) counted **62 million tonnes of e-waste in 2022**, and the average household hoards [9 devices that still work](https://weee-forum.org/ws_news/of-16-billion-mobile-phones-possessed-worldwide-5-3-billion-will-become-waste-in-2022/). What changed recently is what those machines are worth: an ordinary laptop CPU now runs a quantized 7B model at [reading speed, in under 4 GB of RAM](https://ceur-ws.org/Vol-4164/paper11.pdf) ([~14 tok/s on a base M1 Air](https://github.com/ggml-org/llama.cpp/discussions/4167)). The most private AI hardware I will ever own was sitting in a drawer, powered off.

The other half of the inspiration comes from how I actually work with coding models: **the model is consistently better than the prompt I give it.** Everything that makes an answer right for my codebase — the decisions already made, the constraints already hit, the approaches already rejected and why — lives in my head or in documents nobody re-reads. I don't retype any of that at 11pm. So a very capable model gives me a generic answer, and the gap was never intelligence. It was context.

Omnibus is both answers at once: the drawer laptop becomes the hardware, and the hardware carries the context.

## What it does

**Codex gives a developer hands. Omnibus gives Codex a memory, a conscience, and a fleet.**

If you write code at a company, you know the routine: you re-explain your service's constraints to an AI every session, you review agent diffs for mistakes your team already learned the hard way, and there are rules about what code may leave your machine. Omnibus is built against exactly those three problems.

1. **It briefs Codex before Codex touches a file.** Point the Developer route at the on-host Codex CLI and every task arrives with the project's recorded decisions, past bug fixes, and an anti-pattern registry with explicit `// Wrong` / `// Correct` examples. The model starts each session knowing what the person who's been on the team longest knows.

2. **It reviews the diff after.** Codex's output is checked against the same anti-patterns, and `omnibus-bridge hook install` adds a pre-commit gate that blocks known mistakes from anyone — me or the agent — and shows the Wrong/Correct example each time it blocks. It corrects the way a good reviewer does: with the reason.

3. **It is a personal prompt engineer.** I text it a half-formed idea from my phone. A local Auditor walks the project's knowledge graph to pull in the decisions and constraints that idea touches, optionally runs web research that comes back as cited claims (per-idea consent; sources treated as reference material, never as instructions), flags the risks, and hands back two things: a brief I can decide from, and a prompt for Codex that is already specific to this project. The distance between "add caching" and the prompt the model actually deserves — closed automatically.

4. **The memory is infrastructure, not a prompt.** A background process watches the repo read-only and distills everything — commits, ideas, briefs, reviews — into a bi-temporal knowledge graph: every fact carries when it was true and when the system learned it, and superseded decisions are marked invalid but never deleted. When someone asks "why is it built this way," there is an answer with a date on it.

5. **Spare laptops review the plan before I build it.** Machines on my LAN join over an HMAC-signed, replay-protected protocol and read each brief through fixed lenses — product, feasibility, risk. With explicit opt-in they share one redacted, content-addressed context bundle peer-to-peer to pre-warm each other's model caches.

6. **Nothing leaves the house — by construction.** The rule isn't in the README, it's in the types: distilled workspace knowledge can flow to the two local executors — loopback Ollama and the on-host Codex CLI — and cannot flow to any cloud route. No accounts, no API keys. This is a tool I could run on a work laptop without a meeting about it.

7. **It runs on whatever I have.** The bridge reads physical RAM and sizes everything to fit — context window, graph limits, retrieval depth, model residency — so an 8 GB machine works instead of swapping. Mac or Windows; the fleet invite pastes into PowerShell as-is.

**Codex writes the code; Omnibus makes sure it writes *my* code.**

## How I built it

I built Omnibus the way Omnibus argues you should build: Codex doing the hands-on work, wrapped in specification, verification, and memory.

- **Contracts first.** Each subsystem started as a written description and a shared set of TypeScript types. Codex implemented modules against those contracts in parallel, which is why independently generated code composed instead of colliding.
- **Codex wrote the hard parts.** The bi-temporal graph with deterministic multi-device merge (content-derived IDs, a total order on transaction-time plus content-hash), a dependency-free Personalized PageRank, the HMAC fleet protocol with nonce replay windows and single-use P2P tickets, and the Swift haptics module inside the Expo app.
- **I attacked everything before merging it.** Independent review passes tried to refute each claimed bug rather than confirm it. A separate product audit ran real WebSocket sessions and kill-and-restart runs against the built binary, not the source — it found **37 real bugs**, from a phone permanently trapped in a setup sheet to emoji input killing the socket. **199 automated tests across 34 test files** keep them dead.
- **The loop closed on itself.** The worst bugs from those sessions are now entries in Omnibus's own anti-pattern registry — the tool warns about the exact mistakes made while building it. Error, recorded lesson, never repeated: that loop is the product, demonstrated on the product.
- **The stack:** TypeScript on Node 22 (Express + WebSocket, zod-validated wire contracts, a durable command queue, a replay journal for phones that leave Wi-Fi), an append-only NDJSON journal for the graph, Expo/React Native with Skia and a custom Swift haptics module on iOS, shipped through Fastlane to TestFlight. The demo film's motion graphics are code-rendered Remotion — same describe, generate, verify loop as the code.

## Challenges I ran into

- **React Native reports "the bridge restarted" and "the Wi-Fi blinked" as the same error.** I complete the WebSocket upgrade just to close it with a code the phone can actually interpret.
- **The laptop is the database — and must not be eaten by it.** The fixes became features: RAM-tiered sizing, event recycling with a cold archive, and co-residence detection so a machine running coordinator and worker never loads the same model twice.
- **Ollama's prompt cache only rewards byte-identical prefixes.** One byte of drift and the latency win is gone — so shared context is addressed by its SHA-256 and transferred verbatim.
- **Sign what was sent, not what you parsed.** My first heartbeat handler sanitized fields before verifying the HMAC — silently changing the signed payload and rejecting honest workers.
- **Wrapping another agent without leaking to it.** Which executors may receive workspace knowledge had to be decided in types, not in prose. Local knowledge, local executors, no exceptions the compiler can't see.

## Accomplishments that I'm proud of

- A bi-temporal knowledge graph with deterministic multi-device merge — dependency-free TypeScript on a journal a human can read — that sizes itself to the machine it lands on.
- Multi-hop recall running at reading speed on hardware the UN counts as e-waste.
- A fleet protocol whose core promise — workers never see your files — survived an adversarial review aimed at breaking it.
- A pre-commit gate that explains itself instead of just failing.
- The Codex integration: memory in before the edit, the diff audited after, and the privacy boundary unmoved.
- 37 real bugs found by using the product like a user instead of reading it like an author.

## What I learned

- **Constraints are a design tool.** Local-first stopped being a philosophy and became the best feature the moment it was the only option.
- **The most useful assistant is the one that was in the room.** A 7B model that knows this project's history gives better answers about it than a frontier model meeting the code cold.
- **Memory and hands are different jobs.** Let the executor execute; let the system that kept the history decide what the executor needs to know — then check the work against it.
- **Caching is a privacy decision.** Sharing precomputed context between machines is a consent question, and it got its own switch, default off.
- **Check your own story.** I fact-checked every statistic in this submission adversarially and dropped the ones that didn't survive — including a few tempting ones about idle compute that turned out to be folklore.

## What's next for Omnibus

- **Close the Codex loop tighter:** blocked commits become session memory, so each mistake permanently improves the next attempt.
- **Move the real cache:** raw KV pages over the same ticketed P2P path, not just the prompt prefix.
- **Time-travel from the phone:** scrub the graph's timeline and watch a decision get made, contradicted, and superseded.
- **Android**, and a ten-minute onboarding that takes a drawer laptop from powered-off to named fleet member — because the [9 working devices in the average household](https://weee-forum.org/ws_news/of-16-billion-mobile-phones-possessed-worldwide-5-3-billion-will-become-waste-in-2022/) are the greenest datacenter never built.

---

## Built with (Devpost tags)

`typescript` `node.js` `react-native` `expo` `swift` `ollama` `codex` `express` `websocket` `zod` `ios` `xcode` `fastlane` `skia` `reanimated` `corehaptics` `hmac` `sha-256` `knowledge-graph` `hipporag` `pagerank` `p2p` `localtunnel` `npm` `brave-search` `remotion`

## Try it out

- **Code:** https://github.com/ChavahScript/omnibus
- **Install (bridge, npm):** https://www.npmjs.com/package/omnibus-bridge — `npm i -g omnibus-bridge && omnibus-bridge setup --install-runtime --pull-models && omnibus-bridge start`
