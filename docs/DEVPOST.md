# Omnibus — Devpost submission story

## Inspiration

Omnibus started as a joke with a budget: build an ornamental "CEO office" where an iPhone commands a staff of AI employees — on a **$100 hackathon construction budget**. That constraint did the designing for us. We couldn't afford a cloud bill, so the models had to run on hardware we already owned. Somewhere between the first Ollama token streaming off a five-year-old laptop and the third time we re-explained our own project to a stateless model, the joke became a thesis:

> The most private AI infrastructure you will ever own is the pile of laptops in your closet — it just needs an organization chart and a memory.

Two ideas kept us up at night. First, **idle hardware is an untapped fleet**: a spare MacBook and an old Windows laptop are a peer-review committee waiting for a protocol. Second, **stateless AI is amnesiac AI**: every prompt-generation tool forgets your architecture decisions the moment it answers. We wanted the opposite — an assistant that watches the project ambiently and connects tonight's shower thought to a constraint you recorded three weeks ago.

## What it does

Omnibus pairs an iPhone to a laptop with a one-time QR code. You type a rough idea into a single text field; a local agent pipeline — an **Auditor** that enriches the idea with bounded workspace context, then a **Developer** that composes the result — returns a decision-ready brief and a paste-ready IDE prompt. By default everything runs on local Ollama models — no accounts, no API keys — and nothing is shared with an outside service or another machine without its own per-idea consent switch (web research and Home Fleet each have one). Cloud provider modes exist only as explicit laptop-side opt-in configuration.

Around that core, four systems make it an actual "second brain":

- **Home Fleet.** Spare laptops on your LAN join via one-time invites and contribute bounded peer reviews through complementary lenses (product / feasibility / risk), over an HMAC-signed, replay-protected protocol. Workers never see your files — only the idea text you approved.
- **Bi-temporal knowledge graph.** Every distilled fact carries both *valid time* (when it was true) and *transaction time* (when the system learned it). Superseded decisions are invalidated, never deleted — the graph can explain what it believed last Tuesday and why that changed. Contributions queued while the phone was offline merge deterministically by transaction time and content hash, so any arrival order converges to the same state.
- **HippoRAG recall.** New ideas aren't matched against a flat vector store. We extract entities, seed **Personalized PageRank** over the knowledge graph, and rank facts by the stationary scores:

$$\pi = (1-d)\,p \;+\; d\,W^{\top}\pi$$

  where the personalization vector $p$ places its mass on the matched entity nodes, down-weighted by $1/\log(2+\mathrm{deg})$ so rare, specific entities steer harder than hubs. One retrieval step connects a new idea to a bug fix recorded weeks ago, two hops away.
- **Ambient capture + a shift-left gate.** Background watchers distill read-only git polls, optional compiler runs, and every idea/brief/peer-review into the graph — no manual note-filing. A structured anti-pattern registry (explicit `// Wrong` / `// Correct` examples) validates every generated brief, and `omnibus-bridge hook install` adds a pre-commit gate that mechanically blocks and auto-corrects known bad patterns. The gate fails open on infrastructure errors: only real findings may ever block a commit.

And the part we're weirdly proudest of: **peer-to-peer prefix caching**. With an explicit opt-in, the coordinator compiles one redacted, content-addressed context bundle, seeds it to a single worker, and the rest fetch it *worker-to-worker* using single-use HMAC tickets — then pre-warm it into their local model's prompt cache so repeat reviews skip re-ingesting project context entirely (an LMCache/Mooncake idea, adapted to Ollama).

## How we built it

- **Bridge (the control plane):** TypeScript on Node 22 — Express + `ws` behind a supervised localtunnel, zod-validated wire contracts, a durable serial command queue, an append-only redacted audit trail, and a device-event replay journal so a phone that walks out of Wi-Fi range gets its missed progress back.
- **Second Brain:** an append-only NDJSON journal for the bi-temporal graph (content-derived IDs so replicas converge byte-for-byte), a dependency-free Personalized PageRank implementation, ambient watchers with deterministic heuristic fallbacks for when the model is busy, and the anti-pattern registry with the pre-commit CLI.
- **Fleet protocol:** hand-rolled authenticated HTTP on RFC1918 addresses only — per-worker derived HMAC secrets, timestamps, nonce replay windows, one-time join invitations, and the new ticketed P2P context-transfer path.
- **iOS app:** Expo / React Native with the New Architecture, Skia + Reanimated for the idea-mist atmosphere, a custom CoreHaptics module in Swift, Keychain-held rolling resume credentials, and Fastlane→TestFlight delivery.
- **Process:** AI-assisted development end to end — agent teams audited the codebase, implemented modules against a shared type contract in parallel, and an adversarial review fleet (finders + independent skeptics per finding) caught 28 real defects before we trusted the result. Every claim above is covered by the bridge's 138 automated tests.

## Challenges we ran into

- **Local-first resumption is brutal.** React Native reports an HTTP 401 upgrade rejection as an indistinguishable WebSocket 1006. We had to complete the upgrade and close with a deliberate 1008 so iOS could tell "bridge restarted, forget the session" apart from "coffee-shop Wi-Fi blinked."
- **Ollama's prompt cache only rewards byte-identical prefixes.** One byte of drift in the shared bundle and the TTFT win evaporates — so bundles are content-addressed by SHA-256, transferred verbatim, and workers keep the model resident only after the owner opts in (residency vs. memory is a real trade on 8 GB laptops).
- **Deterministic offline merges.** Fleet reviews finishing while the phone was offline must produce the same graph no matter the arrival order. That forced content-derived node/fact IDs, a total order on (transaction-time, content-hash), and a supersede rule that never lets a stale contribution invalidate a newer belief.
- **Sign what was sent, not what you parsed.** Our first heartbeat extension filtered invalid cache digests *before* HMAC verification — silently changing the signed payload and rejecting honest workers. Verify raw, sanitize after.
- **A pre-commit gate must never brick a commit.** Every infrastructure failure — unreadable graph journal, broken `.env`, missing binary — has to fail open, while real anti-pattern findings fail closed. Getting that boundary exactly right took three passes and an adversarial reviewer.
- **Xcode 26 vs. React Native:** Expo's prebuilt core lacked DevSupport symbols, forcing a source-built RN core and a surgical `fmt` conteval patch just to get the dev client linking.

## Accomplishments that we're proud of

- A **bi-temporal knowledge graph with deterministic multi-device merge** — in dependency-free TypeScript, on an append-only journal a human can read.
- **HippoRAG-style multi-hop recall** running on consumer laptops with no vector database at all.
- A LAN fleet protocol with one-time joins, replay windows, and **single-use P2P transfer tickets** — where the privacy invariant "workers never see your files" survived an adversarial review.
- A pre-commit gate that *teaches* — every block ships the pattern's own Wrong/Correct example — and auto-corrects only lines its detector actually flagged.
- 138 automated tests, an append-only audit trail, and a README that never claims more than the code does.

## What we learned

- **Constraints are a design tool.** The $100 budget produced a better architecture than a blank check would have: local-first stopped being an ideology and became the only option — and then the best feature.
- **Determinism is a distributed-systems feature you can have without a coordinator** if every identifier derives from content instead of clocks.
- **Caching is a privacy decision.** Sharing a pre-computed context across machines is a *consent boundary*, not an optimization flag — it deserved its own switch, default off.
- **Adversarial review works.** Independent skeptics trying to refute each finding killed the plausible-but-wrong ones and confirmed 28 real bugs we'd have shipped otherwise.
- Small local models are genuinely useful when you stop asking them to be oracles and start giving them *structure*: bounded prompts, fixed roles, schema-validated output, and a memory that does the remembering for them.

## What's next for Omnibus

- **Fleet calibration:** measure a profile on the owner's actual hardware instead of estimating from specs.
- **True KV-tensor transfer:** swap the prompt-prefix cache for raw KV pages over the same ticketed P2P path via a vLLM/LMCache backend.
- **Android client** and richer approval gates for every action that touches the workspace or the network.
- **Graph time-travel UI:** scrub the knowledge graph's transaction timeline from the phone — watch a decision get made, contradicted, and superseded.

---

## Built with (Devpost tags)

`typescript` `node.js` `react-native` `expo` `swift` `ollama` `express` `websocket` `zod` `ios` `xcode` `fastlane` `skia` `reanimated` `corehaptics` `hmac` `sha-256` `knowledge-graph` `hipporag` `pagerank` `p2p` `localtunnel` `npm` `brave-search` `remotion`

## Try it out

- **Code:** https://github.com/ChavahScript/omnibus
- **Install (bridge, npm):** https://www.npmjs.com/package/omnibus-bridge — `npm i -g omnibus-bridge && omnibus-bridge setup --install-runtime --pull-models && omnibus-bridge start`
