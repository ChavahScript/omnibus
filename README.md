# Omnibus

Omnibus is a local-first ideation room for developers. Pair an iPhone to a
laptop with a one-time QR code, give the phone a rough thought, and let the
laptop turn it into a decision-ready brief and a prompt for the developer’s
main IDE.

The dashboard is currently an iPhone/iOS app. Its local Node bridge can run on
a Mac or a Windows laptop, so a Windows machine can be the primary coordinator
even though building the iOS app itself still requires Apple tooling.

The default route uses local Ollama models only. The phone holds no model
credentials, the bridge binds to the laptop loopback interface, and optional
Codex CLI or GPT-5.6 Responses use is an explicit laptop-side configuration.

> The $100 limit was the team’s hackathon construction budget—not a feature
> limit imposed on an Omnibus user. Runtime usage is now observational
> telemetry only; local inference remains the normal path.

## What is implemented

| Capability | Status | Notes |
| --- | --- | --- |
| One-time laptop pairing | Implemented | QR code carries a 256-bit, single-use token; the iOS app opens an authenticated WSS session through a temporary localtunnel URL. |
| Windows bridge host | Implemented | A Windows computer can run the Node bridge, local Ollama team, and Home Fleet coordinator or worker. Ollama’s Windows installer remains an owner-run prerequisite. |
| QR-paired Fleet Setup | Implemented | The paired app receives a path-free laptop capacity summary, recommends one of four named local Ollama fleets, and can explicitly approve the selected local model download. |
| Home Fleet | Implemented, opt-in | A coordinator can ask explicitly paired spare laptops on the same trusted private LAN for bounded local peer reviews. Each worker must be actively approved and each idea asks for separate consent. |
| Local-first ideation | Implemented | A bounded, durable serial queue runs a local Ollama Auditor with safe workspace context, then a local Developer pass returns an inspectable report and paste-ready IDE prompt. |
| Codex CLI | Implemented, opt-in | Requires DEVELOPER_PROVIDER=codex-cli and explicit host-execution arming. plan is read-only; build stays workspace-bounded. |
| GPT-5.6 Responses | Implemented, opt-in | Requires a laptop-side OPENAI_API_KEY; it returns a result but never executes host commands. |
| Audit trail | Implemented | Redacted append-only NDJSON contains prompts, safe-context metadata, observable local stream chunks, Ollama latency/token metrics, agent outputs, queue state, and usage telemetry. |
| iOS ideation UI | Implemented | Persistent first-pair tutorial, Skia/Reanimated loading animation, monochrome idea room, local history, telemetry, live connection health, agent calls, and a mist-to-brief transition. |
| DiceBear avatars | Implemented | Deterministic transparent Bottts SVGs appear in the live agent call sheet. They remain network-dependent by design. |
| Higgsfield | Implemented as an explicitly armed job path | The app can request a confirmed marketing job; the official CLI runs on the laptop and writes an owner-review distribution handoff. There is no automatic social publishing. |
| Meta / TikTok publishing | Not implemented | There is no SDK, OAuth, token store, upload endpoint, or publisher integration. Omnibus does not bypass platform review or access controls. |
| Local workspace research | Implemented | The Auditor receives a bounded source map and selected snippets from the owner workspace; it refuses symlinks, VCS/dependency folders, hidden files, and likely secrets. |
| Second Brain | Implemented, on by default | A persistent, workspace-local knowledge layer: ambient capture distills git activity, optional diagnostics runs, and idea/brief history into a bi-temporal knowledge graph under `.omnibus/state/brain`; HippoRAG-style retrieval recalls linked memories for each new idea. `OMNIBUS_SECOND_BRAIN=false` restores the original stateless flow. |
| Code Digital Twin & anti-patterns | Implemented | Artifact/rationale modeling, remembered bug fixes and trade-offs, and a structured anti-pattern registry with explicit `// Wrong` / `// Correct` examples. Produced briefs are mechanically validated; `omnibus-bridge hook install` adds a shift-left pre-commit gate that blocks and can auto-correct known bad patterns. |
| Fleet context cache | Implemented, opt-in | With `HOME_FLEET_CONTEXT_SHARING=true`, the coordinator shares one redacted, content-addressed knowledge bundle with approved workers — seeded once, then transferred worker-to-worker over the authenticated LAN — so peer-review models keep a warm prompt prefix and answer with lower time-to-first-token. Off by default: workers then receive idea text only, exactly as before. |
| Cited web research | Implemented, opt-in | A paired owner can enter an existing Brave Search key once, then a per-idea phone confirmation can send only approved idea text to Brave; the local Auditor receives bounded, sanitized citations and the returned brief includes source links. Omnibus cannot create a Brave account or API key. |

## Architecture

    iPhone Omnibus (iOS)
       |
       | one-time QR + authenticated WSS
       v
    Coordinator Node bridge (macOS or Windows) ──> bounded, durable serial queue
       |                         |
       |                         | device-scoped local memory
       | safe local source map    v
       v                    local audit trail + retry metadata
    Local Ollama auditor
       |
       | scoped/enriched directive
       v
    Local Ollama ideation agent
       |
       | decision-ready report + IDE-ready prompt
       v
    Omnibus brief / call sheet / local history on iPhone

    Optional Home Fleet (separate private-LAN path; never the public tunnel)

    Coordinator ── authenticated HTTP + HMAC, not encrypted ──> approved spare laptop(s)
                                                          fixed local Ollama peer review only

Optional provider paths remain laptop-side choices: Codex CLI can create a
read-only plan or perform explicitly armed workspace-bounded work; GPT-5.6
Responses can return a cloud-assisted result without host execution.

After QR pairing, Fleet Setup is a small local control plane rather than a
remote shell. The phone sees only a path-free summary—platform/architecture,
bounded CPU description and core counts, total/free system memory, and
filesystem capacity. It never receives a filesystem path, serial number,
running-process list, filename list, or a guessed GPU/VRAM value. It can choose
only an allow-listed Ollama profile; model tags, shell commands, paths, and
environment variables cannot be supplied by the phone.

If `OLLAMA_MODELS` is configured on the laptop, the capacity check uses that
model-storage volume; otherwise it uses the bridge workspace volume. The path
itself never crosses the paired connection.

    .
    ├── bridge/                         Local Node.js control plane
    │   ├── src/agents/                 Auditor, developer, marketing adapters, Mastra metadata
    │   ├── src/second-brain/           Bi-temporal knowledge graph, HippoRAG retrieval,
    │   │                               ambient capture, code digital twin, anti-pattern
    │   │                               registry, pre-commit gate, fleet prefix cache
    │   ├── src/audit.ts                Redacted append-only audit trail
    │   ├── src/usage.ts                Non-blocking local/cloud telemetry
    │   ├── src/server.ts               Express + authenticated WebSocket gateway
    │   ├── src/tunnel.ts               Programmatic localtunnel lifecycle
    │   └── src/keep-awake.ts           Cross-platform serving sleep-inhibition lease
    └── mobile/                         Expo React Native iOS application
        ├── src/components/             Onboarding, Skia atmosphere, ideation room, scanner
        ├── modules/haptics/ios/        CoreHaptics Expo module and AHAP patterns
        ├── scripts/generate-app-icon.mjs
        └── fastlane/                   Native sync, archive, and TestFlight lanes

Mastra supplies typed agent identities and a workflow graph in
bridge/src/agents/mastra.ts. The operational dispatch is deliberately explicit
in CommandOrchestrator, where queueing, pairing, device-scoped memory, audit
logging, provider selection, and host-execution boundaries are enforced. We do
not claim that Mastra itself executes the live agent calls.

## Security and local-first model

- The HTTP server listens on 127.0.0.1; the only public surface is a
  short-lived localtunnel URL.
- A freshly generated 256-bit pairing token is represented in the QR code and
  only its SHA-256 digest is retained by the server. It is consumed after one
  successful WebSocket upgrade.
- The app sends localtunnel’s bypass header during WebSocket upgrade, and the
  bridge requires that header plus the one-time token.
- The public relay is supervised with delayed health probes, bounded
  exponential-backoff replacement attempts, and a five-minute cooldown after
  a failed burst. The local coordinator stays running even when the relay is
  down at startup. A relay that recovers at the same public origin preserves
  the paired session; only a genuinely different public origin rotates the
  in-memory QR token and requires a fresh scan. A brief socket/Wi-Fi loss on
  an unchanged relay instead uses a short-lived, rotating resume secret, so
  the phone does not needlessly re-scan.
  This recovery path is separate from Home Fleet, whose workers continue to
  use only their direct private-LAN protocol.
- A paired iPhone can leave the home network: it reconnects over the public
  HTTPS/WSS relay when it regains Wi-Fi or cellular service. The bridge keeps
  a private stable requested tunnel subdomain for ordinary relay recovery and
  the app keeps its rolling resume credential in iOS Keychain—not its original
  QR token. A laptop/bridge restart, a permanently replaced relay origin, or a
  wiped Keychain deliberately requires a new scan because there is no hosted
  account/rendezvous service in this local-first build.
- While a coordinator or Home Fleet worker is serving, the npm bridge enables
  a user-scoped, best-effort sleep inhibitor by default (`OMNIBUS_KEEP_AWAKE=true`):
  macOS uses `caffeinate`, Windows renews `SetThreadExecutionState`, and Linux
  uses `systemd-inhibit`. The helper releases on normal shutdown and watches
  its parent so a crash cannot leave an endless inhibition process behind. It
  never changes a global power plan or overrides a lid close, forced shutdown,
  depleted battery, enterprise policy, or power outage.
- Home Fleet uses a separate, direct private-LAN listener. A worker never
  joins through the QR code or public tunnel; the existing paired phone only
  relays a short-lived, one-time join command to an owner-controlled laptop.
  The running coordinator and worker bind only to concrete RFC1918 IPv4
  addresses—not hostnames, loopback, or public addresses—so a spare laptop can
  be reached only on the private LAN. (The protocol library also supports
  loopback for isolated use, but the product does not use it for a fleet.)
- Home Fleet authenticates registration and requests with one-time proofs,
  per-worker HMAC secrets, timestamps, and replay-protected nonces. It is
  deliberately **HTTP, not TLS**: HMAC proves who sent a request but does not
  hide the idea text or review. Use it only on a trusted home/private LAN,
  never on public, guest, shared, or port-forwarded networks.
- A newly joined Home Fleet worker is not active merely because it registered:
  the paired owner must approve it in Fleet Setup, and the owner must turn on
  and confirm Home Fleet separately for each eligible idea. Workers receive
  only that idea’s bounded directive and return a bounded advisory review;
  they never receive workspace files/snippets, session memory, audit history,
  research credentials, provider keys, or host-command authority.
- Directives are schema-validated, size-bounded, and serialized one at a time
  through a small durable queue to keep the audit record intelligible.
- Fleet recommendations use CPU, system memory, and filesystem capacity only.
  Omnibus does not probe or guess GPU/VRAM or promise inference speed. Its
  local queue runs one request at a time; separate-role profiles request that
  Ollama unload a role model after its pass to limit retained memory. It does
  not alter Ollama's global server policy or control other local clients.
- A selected Fleet Setup profile and optional Brave key are stored privately at
  `.omnibus/state/bridge-settings.json` (owner-only permissions) rather than
  written into a project `.env` or sent back to the phone. The choice is applied
  to the running bridge and again on the next bridge startup.
- Command progress and output are sent only to the authenticated socket that
  initiated that idea; a second paired phone cannot receive its brief.
- Continuity memory is scoped to the random live WebSocket session, and only
  completed rationale/result summaries from that same session can inform a new
  **local Ollama** request. It is withheld for Codex and Responses routes.
- Web research is off by default. A phone must request and confirm it for an
  individual idea, and only that idea text reaches the configured search
  provider. Workspace files, local memory, and audit history stay on the
  laptop; the search key is used only in the provider authentication header and
  never reaches the phone, model prompt, or audit trail. Result URLs are
  citation data only; Omnibus never fetches them.
- If the bridge restarts, persisted unfinished commands are retained as failed
  history and need a fresh paired-device confirmation. Omnibus never replays
  workspace edits or provider jobs from a stale session.
- Ollama runs at 127.0.0.1:11434 by default. Provider keys exist only in
  bridge/.env, never in the iOS bundle or pairing payload.
- Codex workspace execution remains off until the owner sets
  HOST_EXECUTION_ENABLED=true.
- Audit records redact familiar bearer/API-key patterns and are written
  owner-readable.

## Run the bridge

Prerequisites for a bridge host: Node 22+ and a local Ollama installation.
The bridge can be hosted on macOS or Windows. You need macOS/Xcode only when
you are building or modifying the separate iOS app; an iPhone can pair to a
bridge running on a Windows laptop.

The publishable, local-first CLI is `omnibus-bridge`. Its first-run command
creates local audit/state folders, explicitly installs the verified Ollama
runtime under the current Mac user's Applications folder only if it is absent,
asks before downloading the configured model team, then starts the QR pairing
bridge:

    npm install --global omnibus-bridge
    omnibus-bridge setup --install-runtime --pull-models && omnibus-bridge start

`--install-runtime` and `--pull-models` are deliberate: neither software nor
multi-gigabyte models are downloaded during npm installation or ordinary
bridge startup. On macOS the runtime comes only from the fixed official Ollama
HTTPS URL, is checked with macOS code-signing and Gatekeeper, and is installed
without `sudo` under `~/Applications/Omnibus/Ollama.app`. The exact command
above is also available as a copy button in Omnibus's first-launch tutorial.

When developing this repository before publishing the package:

    npm install
    npm --workspace bridge run build
    node bridge/dist/cli.js setup --install-runtime --pull-models && node bridge/dist/cli.js start

### Windows bridge host

Install Ollama using its official Windows installer, open a new PowerShell,
Command Prompt, or Windows Terminal window, and verify `ollama --version`.
Then run:

```powershell
npm install --global omnibus-bridge
omnibus-bridge setup --pull-models
omnibus-bridge start
```

Omnibus deliberately does not download or invoke a Windows `.exe`, modify
PATH, or embed an installer script. The [bridge guide](bridge/README.md#windows)
has the exact Windows runtime and storage-location details.

The bridge prints a terminal QR code after localtunnel is ready. If the
internet or relay is temporarily unavailable, it keeps the local coordinator
and Home Fleet alive, reports recovery in the terminal, and prints the QR when
the relay returns. Open Omnibus, scan the code, then put an idea into the one
input field.

If the Ollama service is already available, `omnibus-bridge start` still opens
the QR bridge when no model has been pulled yet. It prints the missing default
models but does not download them implicitly. Pair the app and use **Fleet
Setup** to review a hardware-aware recommendation and explicitly approve the
chosen local download. The built-in profiles are **Compact** (8 GB class),
**Balanced** (16 GB), **Power** (32 GB), and **Studio** (64 GB); detailed model,
disk, and working-memory estimates are in [bridge/README.md](bridge/README.md#qr-paired-fleet-setup).

Fleet Setup persists its named selection only after the local models are ready.
The private selection is written atomically to
`.omnibus/state/bridge-settings.json` with owner-only permissions and is applied
on subsequent starts. It is not a general-purpose model downloader or remote
terminal.

Omnibus keeps a serving laptop awake by default without changing its global
power settings. Leave the terminal open and power connected for a long demo;
set `OMNIBUS_KEEP_AWAKE=false` before starting the bridge if preserving battery
matters more than continuous availability. Sleep inhibition and recovery logic
cannot substitute for a UPS or keep a laptop serving through a forced restart,
lid-close policy, or complete network/power loss.

### Home Fleet: use spare laptops you control

Home Fleet is optional. The laptop paired to the phone stays the **coordinator**:
it retains the full local Auditor/Developer workflow and all private workspace
context. An extra Mac or Windows laptop becomes a **worker** with its own local
Ollama installation and one fixed peer-review role.

1. Start the coordinator bridge, scan its normal QR code in Omnibus, and open
   **Fleet Setup → Home Fleet**.
2. Create a worker invitation. The phone displays a short-lived, one-time
   command; copy the exact command to a spare laptop you control on the same
   trusted private network.
3. On that worker, install Ollama first if necessary, then run the generated
   command. Its shape is:

   ```bash
   npx --yes omnibus-bridge@<version> worker --join <payload> --pull-models
   ```

   The generated command pins the installed package version. Its `npx --yes`
   accepts only the temporary npm package download; Omnibus still asks at the
   worker terminal before the potentially multi-gigabyte model download.
   `--pull-models` requests that worker's fixed local peer-review model. Do
   not edit, reuse, or share `<payload>`; it is a one-time join secret and
   expires quickly.
4. Return to Fleet Setup and actively approve the newly joined worker. A
   registration alone never grants it access to ideas.
5. For an ideation or plan request, turn on **Home Fleet** and confirm the
   request. The coordinator keeps its local audit/workspace context private,
   sends only the approved idea text to ready workers, and collects bounded
   independent reviews. The first three workers receive complementary product,
   feasibility, and risk lenses so their local compute is additive rather than
   redundant. On the default local Ollama Developer route, those
   reviews are treated as untrusted advisory material for the final brief. To
   prevent worker text from influencing an external or tool-using executor,
   Omnibus withholds peer reviews from Codex CLI and GPT-5.6 Responses routes.
   Marketing jobs do not use workers.

If a worker is offline, missing its local model, unapproved, busy, or removed,
the coordinator simply continues the local result path. Removing a worker
revokes its coordinator credential and stops future dispatches.

Workers send signed heartbeats while they are running. A temporary Wi-Fi loss,
worker DHCP move, or coordinator listener restart backs off and recovers
without discarding the worker’s local pairing. At the worker limit, Fleet Setup
still offers a **repair invitation** for an already paired laptop; the protocol
requires that laptop to prove its previous session and rejects any new worker
until a slot is removed.

#### Home Fleet network safety

Keep all participating laptops on the same trusted private/home LAN. Do not
put the Home Fleet ports behind a router port-forward, reverse proxy, VPN exit,
or public tunnel. If macOS or Windows Firewall asks, permit the coordinator and
worker listeners only on the **Private** network profile/local subnet—not on a
Public or Guest profile. The default private listeners use ports 8791
(coordinator registration) and 8792 (worker review); configure a different
private literal bind address/port only on the laptops you control. Because the
LAN protocol is authenticated but not encrypted, use a network whose members
you trust and remove a worker when its ownership or network trust changes.

### Second Brain: persistent local project memory

Omnibus no longer forgets. The bridge keeps a Second Brain on the laptop —
never in a cloud account — made of five cooperating parts:

- **Bi-temporal knowledge graph.** Every distilled fact records both when it
  was true in the project (valid time) and when the bridge learned it
  (transaction time). A superseded architectural decision is invalidated, not
  overwritten: the graph can still explain what was believed at any earlier
  moment and why it changed. Home Fleet contributions and capture events are
  merged deterministically by transaction time and content hash, so reasoning
  progress queued while the iPhone was offline produces the same knowledge
  state regardless of arrival order.
- **Ambient capture (agentic PKM).** Background watchers observe the
  environment instead of asking the owner to file notes: a read-only git poll
  (`git status` / `diff --stat`, never hooks or writes), an optional
  owner-named diagnostics command (`OMNIBUS_AMBIENT_CHECK_COMMAND`, spawned
  without a shell), and every idea, brief, and peer review that already flows
  through the bridge. Events are distilled by the local auditor model when it
  is idle — with a deterministic heuristic fallback — then redacted with the
  same secret patterns as the audit trail before anything is stored.
- **HippoRAG retrieval.** A new idea is not matched against a flat vector
  store. The bridge extracts entities from the idea, seeds Personalized
  PageRank on the matching graph nodes (rare, specific entities steer harder
  than hubs), and ranks facts by the combined walk scores — one retrieval
  step that connects tonight's idea to a constraint recorded weeks ago, two
  hops away. Recalled facts enter the Auditor prompt with `[brain:*]`
  citations under the same privacy gate as workspace snippets: loopback local
  Ollama only, never Codex or cloud routes.
- **Code Digital Twin + anti-patterns.** The twin records workspace artifacts
  (inside the same scanner boundaries as workspace context), design
  decisions, trade-offs, and bug-fix history, and injects "do not repeat
  these mistakes" context into new briefs. A structured anti-pattern registry
  (`.omnibus/state/brain/anti-patterns.json`, owner-editable) holds explicit
  `// Wrong` / `// Correct` examples; produced briefs are validated against
  it, and `omnibus-bridge hook install` writes a pre-commit gate that
  mechanically blocks — and where safe auto-corrects — known bad patterns
  before they reach the main branch. The optional local-model layer of the
  hook (`OMNIBUS_PRECOMMIT_LLM=true`) is advisory and fails open; a missing
  model can never brick a commit.
- **Prefix-cache-aware Home Fleet (opt-in).** With
  `HOME_FLEET_CONTEXT_SHARING=true` the coordinator compiles one redacted,
  content-addressed context bundle (distilled facts plus the anti-pattern
  digest — never raw files, session memory, credentials, or audit records),
  seeds it to one worker, and lets the others fetch it peer-to-peer over the
  same HMAC-authenticated LAN using coordinator-minted transfer tickets and
  sha256 content addressing (LMCache/Mooncake-inspired, adapted to Ollama's
  prompt-prefix cache). Workers warm the bundle into their local model,
  advertise warm digests in signed heartbeats, and the coordinator routes
  reviews warm-first — repeated peer reviews skip re-ingesting project
  context and answer with a much lower time-to-first-token. This is a third,
  independent consent boundary; leave it off and the fleet remains
  idea-text-only exactly as before. A worker holding a bundle keeps its small
  review model resident (`HOME_FLEET_WORKER_KEEP_ALIVE`, default 10m) instead
  of unloading after every review.

Everything lives under `.omnibus/state/brain/` with owner-only permissions,
inside the directory the workspace scanner already refuses to read back into
prompts. The brain is workspace-scoped by design — it distills the same
workspace the source scanner reads, so it follows the workspace-context
privacy precedent rather than the per-device memory precedent; per-device
conversation memory is unchanged. The paired phone sees only a counters card
(facts, nodes, watcher states, warm workers) — never fact text, paths, or
worker addresses.

DEVELOPER_PROVIDER=ollama is the default and requires no API key. Pick a model
appropriate to the laptop in OLLAMA_MODEL and OLLAMA_DEVELOPER_MODEL; the
latter can be a larger local model if desired.

Optional laptop-side providers:

    # Read-only planning or owner-approved workspace work via the local Codex CLI
    DEVELOPER_PROVIDER=codex-cli
    HOST_EXECUTION_ENABLED=true

    # Cloud result only; does not execute host commands
    DEVELOPER_PROVIDER=responses
    OPENAI_API_KEY=...
    OPENAI_MODEL=gpt-5.6

    # Optional cited web research; each phone request still needs its own confirmation
    WEB_RESEARCH_ENABLED=true
    BRAVE_SEARCH_API_KEY=...

See [bridge/README.md](bridge/README.md) for the provider details. Audit files
are created beneath `.omnibus/audit/` in the terminal's current project
directory; serializable agent memory is stored under `.omnibus/state/`.

## Run the iOS app

This is an Expo development build because the custom CoreHaptics module and
persistent first-launch storage are native dependencies; Expo Go is not enough.
The mobile app is iOS-only today; Windows compatibility applies to bridge hosts
and Home Fleet workers, not to an Android client.

    npm run mobile:native-sync
    npm run mobile:ios

On a fresh install the app shows:

1. A Skia/Reanimated splash: a phone becomes populated with its small working
   group.
2. A persistent pairing tutorial with a live bridge animation, a tap-to-copy
   `omnibus-bridge` setup command, Sign in with Apple for an on-device profile,
   QR scanning, and a Fleet Setup sheet for local model selection.
3. The monochrome ideation room with a single goading text field.
4. Three explicit workflows: a local ideation brief, a locally confirmed
   implementation request, or a locally confirmed marketing job. Ideation and
   implementation can optionally request cited web research through a separate
   per-idea confirmation; provider configuration and host-execution permission
   remain laptop-side.
5. Mist-like Skia particles while the local review runs, a live agent call
   sheet, connection-health telemetry, and a copyable result once it returns.
6. A local history drawer containing the most recent ideas and returned
   reports stored on that iPhone.

### Local Apple profile

The pairing screen and the home-screen profile card expose the official native
**Sign in with Apple** control. A successful sign-in stores only Apple’s stable
opaque user identifier and optional display name in the device Keychain via
Expo SecureStore. Submitted idea/report records are retained in the app’s
on-device storage. Omnibus deliberately discards Apple tokens, authorization
codes, and email addresses; there is no cloud-account or cross-device-sync
claim until a backend is designed to verify tokens and provide that service.

For a device/TestFlight build, enable **Sign In with Apple** for the explicit
`com.app.omnibus` App ID in Apple Developer. `mobile/app.json` declares
`ios.usesAppleSignIn` and the Expo Apple Authentication config plugin; run
`npm run mobile:native-sync` after pulling this change so the entitlement is
written into the generated Xcode project and provisioning profile.

The app icon is a custom black-and-white phone with five abstract team heads.
It is defined in mobile/assets/app-icon.svg and reproducibly rasterized with:

    npm --workspace mobile run assets:icon

### Native-build compatibility

Omnibus intentionally keeps Reanimated 4 and the React Native New
Architecture enabled. On this Xcode 26 development machine, Expo's prebuilt
React Native core did not include DevSupport symbols used by the development
client, so `expo-build-properties` opts into a source-built React Native core.
`mobile/plugins/withFmtConstevalFix.js` applies the narrow, reproducible fmt
11 compatibility fix during prebuild. Do not hand-edit `Pods`; run
`npm run mobile:native-sync` whenever native dependencies or app config change.

## iOS design implementation

- IdeaAtmosphere.tsx uses @shopify/react-native-skia blur masks and geometric
  surfaces for the dense splash and the idea mist.
- Reanimated drives the atmosphere layers, phone ingress, and controls with
  named withSpring configurations; visual motion does not require JS-frame
  animation.
- OmnibusMark.tsx and VectorIcon.tsx are custom vector paths; the app contains
  no system-emoji iconography.
- CallSheet.tsx uses live bridge call events with deterministic DiceBear
  identities. The call/result workflow remains usable if the optional avatar
  image service is unavailable.
- The existing HeavySwitch.ahap and RotaryRumble.ahap patterns remain bridged
  through HapticBridgeModule.swift. They are guarded as optional, so a missing
  or stale native integration cannot blank the whole application.

## TestFlight

The current bundle ID is com.app.omnibus. See
[docs/TESTFLIGHT.md](docs/TESTFLIGHT.md) for the Apple portal walkthrough.

    # Compile locally after a UI/native change
    npm run mobile:verify

    # Sign, archive, allocate the next TestFlight build number, and upload
    npm run mobile:testflight

mobile:testflight first performs native synchronization so Expo module
autolinking, the icon, and the release JS bundle agree. After Apple processes
the upload, install the latest build in an internal TestFlight group and keep
the laptop bridge running for the live demo.

## Verification

    npm run bridge:build
    npm run bridge:test
    npm --workspace mobile run typecheck
    npm run mobile:verify

`npm run bridge:test` includes Home Fleet protocol coverage for private-address
validation, one-time joining, signed/replay-protected requests, bounded peer
review fan-out, worker removal, and the absence of an arbitrary execution
endpoint. Test a real fleet only on a trusted private LAN with a coordinator
and worker you control.

## Next-stage ideas — not part of this build

Home Fleet and the Second Brain (which supersedes the earlier "Project RAG"
idea with graph-based retrieval and inspectable `[brain:*]` citations) are
implemented above. These are deliberate next-stage ideas, not current product
claims:

- **Fleet calibration:** an opt-in local benchmark that measures a selected
  profile on the owner’s machine instead of relying on hardware estimates.
- **Approval gates:** richer human approval steps for model pulls, workspace
  changes, external research, and any future publishing action.
- **True KV-tensor transfer:** the fleet context cache today shares bundle
  text and relies on each worker's Ollama prompt-prefix cache; a vLLM +
  LMCache backend could exchange raw KV pages between laptops through the
  same ticketed P2P path.

## How we collaborated with Codex and GPT-5.6

Codex accelerated the project’s working implementation: the typed Node bridge,
QR/WSS pairing boundary, local audit trail, Expo iOS integration, Fastlane
workflow, CoreHaptics bridge, and the current mobile UI were built and iterated
in this project thread.

The team made the key product decisions:

- Reframe the product from an ornamental CEO dashboard into a calm local-first
  ideation room.
- Treat the $100 hackathon creation constraint as a team-budget concern, not
  as a user-facing runtime refusal.
- Make local Ollama the primary route; keep Codex and GPT-5.6 valuable but
  owner-configured accelerators.
- Avoid overclaiming unfinished social publishing or web-research
  capabilities.

When configured, GPT-5.6 can provide the optional Responses result path, and
the local Codex CLI can provide read-only plans or explicitly armed
workspace-bounded implementation work. The normal ideation path remains
usable without either paid provider.
