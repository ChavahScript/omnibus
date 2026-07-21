# Omnibus bridge

`omnibus-bridge` is the local-first bridge behind Omnibus. It starts a secure
QR-paired WebSocket connection for the iOS app and runs its Auditor and
Developer agents on the owner's laptop through Ollama by default.

The iPhone dashboard is iOS-only, but the bridge is not Mac-only: a Windows
laptop can be the normal phone-paired coordinator, an additional Home Fleet
worker, or both. Building the mobile application still requires Apple’s iOS
toolchain; running `omnibus-bridge` does not.

No runtime or model is downloaded during `npm install`, a bare `npx` launch,
or ordinary package startup. Runtime and model downloads are explicit,
confirmed CLI actions (for example `--pull-models`) because they can install
software and use multiple gigabytes of local disk space.

## First run

Work from the project directory where you want Omnibus's local audit and state
files to live. Install the bridge once on any supported host:

```bash
npm install --global omnibus-bridge
```

### macOS

On a fresh Mac, the bridge can install the signed official Ollama runtime into
your user Applications folder:

```bash
omnibus-bridge setup --install-runtime --pull-models
omnibus-bridge start
```

`--install-runtime` and `--pull-models` each display exactly what will be
downloaded and ask for confirmation. The runtime flag is macOS-only; it uses
the fixed official `https://ollama.com` download URL, verifies the extracted
app with macOS code signing and Gatekeeper, installs it only under
`~/Applications/Omnibus/Ollama.app`, and never requests `sudo` or replaces an
existing Ollama app.

### Windows

The bridge supports a Windows host with an owner-installed local Ollama
runtime, but it deliberately does **not** automate Windows software
installation. This keeps a bridge command from downloading or invoking an
`.exe`, modifying PATH, or embedding a PowerShell/CMD install script.

1. Download and run the official [Ollama Windows installer](https://ollama.com/download/windows).
2. Open a **new** PowerShell, Command Prompt, or Windows Terminal window. The
   official installer uses the per-user directory
   `%LOCALAPPDATA%\Programs\Ollama` and adds it to the user PATH.
3. Confirm the install with `ollama --version`, then run:

   ```powershell
   omnibus-bridge setup --pull-models
   omnibus-bridge start
   ```

The bridge checks `ollama` on PATH and the official per-user executable location
if PATH has not refreshed yet. It may start an already-installed local
`ollama serve` only for a loopback `OLLAMA_BASE_URL`; it never starts a remote
Ollama endpoint. If you move models to another drive, set `OLLAMA_MODELS` as a
Windows user environment variable, quit/relaunch the Ollama tray app, and open
a new terminal before starting Omnibus. See the official [Ollama Windows
documentation](https://docs.ollama.com/windows) for system requirements and
installer troubleshooting.

A Windows host can run either role in Omnibus: the phone-paired **coordinator**
or an explicitly invited **Home Fleet worker**. The same rule applies to both:
Ollama stays local to that computer and Omnibus never installs a Windows
runtime on the owner’s behalf.

On Linux, install [Ollama](https://ollama.com) using the platform's official
instructions, then omit `--install-runtime`.

This macOS-only one-liner is useful after the bridge has been installed:

```bash
omnibus-bridge setup --install-runtime --pull-models && omnibus-bridge start
```

For deliberate non-interactive macOS provisioning (for example, an
owner-managed installer), add `--yes` to the explicit requests:

```bash
omnibus-bridge setup --install-runtime --pull-models --yes && omnibus-bridge start
```

`--yes` is rejected unless it is paired with at least one explicit download
flag. It is never inferred from an npm lifecycle hook, a QR scan, or a mobile
app request. On Windows it can approve model pulls, but cannot bypass the
manual Ollama installer requirement.

The binary can also be run without a global install:

```bash
# macOS
npx omnibus-bridge setup --install-runtime --pull-models
npx omnibus-bridge start
```

On Windows, after completing the official installer flow above, use:

```powershell
npx omnibus-bridge setup --pull-models
npx omnibus-bridge start
```

## QR-paired Fleet Setup

Fleet Setup is the paired phone's narrow local-model control plane. It is not
a remote shell, arbitrary model downloader, or system inventory tool.

If the local Ollama **service** is reachable, `omnibus-bridge start` opens the
QR pairing bridge even when no models are installed. It reports missing default
models but does not pull them. After the owner pairs the app, Fleet Setup shows
a hardware-aware recommendation and the owner explicitly confirms a named
local model fleet before any model download begins.

The phone receives only a safe, path-free capability summary:

- platform and CPU architecture;
- a bounded CPU description plus logical/available core counts;
- total and currently free system memory; and
- filesystem capacity values or a generic unavailable state.

It never receives a filesystem path, serial identifier, process list,
filename list, or GPU/VRAM claim. Omnibus deliberately does **not** probe or
guess an accelerator; its estimates are conservative CPU/RAM/disk planning
figures, not speed promises.

When the laptop has set Ollama's `OLLAMA_MODELS` storage location, Fleet Setup
checks that volume's capacity (using an existing parent if it has not yet been
created). Otherwise it checks the bridge workspace volume. The selected path
is never included in the phone protocol.

Fleet Setup exposes only these allow-listed Ollama presets. Omnibus's bridge
queue runs one request at a time. The shared Compact model stays briefly warm;
the separate-role presets request that Ollama unload each role model after its
pass, limiting retained RAM and KV-cache pressure. Omnibus does not modify
Ollama's global server settings or claim to control other local Ollama clients,
so it does not infer a safe multi-model GPU/VRAM budget.

| Profile | Local roles | Context | Minimum laptop capacity | Approx. download / working memory |
| --- | --- | --- | --- | --- |
| Compact | `qwen2.5-coder:1.5b` shared by Auditor + Developer | 8K | 8 GB RAM, 2 logical cores, 5 GB free disk | 1.1 GB / 4 GB |
| Balanced | `qwen2.5-coder:3b` Auditor + `qwen2.5-coder:7b` Developer | 16K | 16 GB RAM, 4 logical cores, 12 GB free disk | 6.7 GB / 12 GB |
| Power | `qwen2.5-coder:7b` Auditor + `qwen2.5-coder:14b` Developer | 32K | 32 GB RAM, 6 logical cores, 22 GB free disk | 13.7 GB / 26 GB |
| Studio | `qwen2.5-coder:14b` Auditor + `qwen2.5-coder:32b` Developer | 32K | 64 GB RAM, 8 logical cores, 42 GB free disk | 29 GB / 52 GB |

The bridge rechecks the selected profile before provisioning and downloads only
its fixed public Ollama tags through the laptop's configured loopback Ollama
API. A paired phone cannot provide a tag, URL, shell command, disk path, or
environment variable. If a selected model already exists, Fleet Setup applies
the profile without another download.

After the selected fleet is ready, Omnibus atomically stores the profile in
`.omnibus/state/bridge-settings.json`. The state directory is private and the
settings file is written with owner-only permissions (`0700` directory, `0600`
file); the phone is told only the profile name and whether a research key is
present. The selection takes effect immediately and is applied again at the
next `setup`, `doctor`, or `start` invocation. It is intentionally kept out of
source-controlled `.env` files.

## Local intelligence lifecycle

`omnibus-bridge setup`

- creates private `.omnibus/audit/` and `.omnibus/state/` folders in the
  current project directory;
- with the explicit macOS-only `--install-runtime` flag, downloads and verifies
  the official Ollama app into the current user's Applications folder without
  modifying `/Applications` or the global PATH;
- starts an already-installed Ollama service when the configured endpoint is a
  local loopback URL and no service is running;
- inventories configured local models without downloading any by default; and
- records a redacted bootstrap event so the local agent lifecycle is auditable.

`omnibus-bridge start`

- verifies that the local Ollama service is reachable, but opens the QR bridge
  before models exist so the paired owner can use Fleet Setup;
- never silently pulls a missing model; the terminal reports it, while a paired
  owner can explicitly choose and confirm an allow-listed Fleet Setup download;
- initializes the typed Mastra agent topology, durable agent memory, audit
  trail, device-scoped command queue, secure QR token, Express/WebSocket
  server, and supervised HTTPS tunnel; and
- keeps the local coordinator alive if the public relay is temporarily down,
  then prints a QR code when a safe relay is available.

`omnibus-bridge doctor` is read-only. It checks the Ollama executable, local
service, configured model inventory, storage location, and provider selection.
When a Mac has no runtime, it prints the exact explicit bootstrap command; on
Windows it prints the official manual-installer guidance and checks both PATH
and Ollama's documented per-user executable location.

### Tunnel continuity and pairing recovery

The public QR/WSS relay is supervised rather than treated as a one-shot
connection. A transient localtunnel socket error first gets a delayed `/health`
probe, so a relay that recovered internally keeps its existing endpoint and
the current phone connection is not needlessly displaced. The bridge also
checks the relay periodically to detect silent network drops.

If the relay is confirmed unavailable or closes unexpectedly, Omnibus retires
that endpoint and opens a replacement with bounded exponential backoff and
jitter (up to eight fast attempts). After a failed burst it remains running,
reports the terminal state locally, and tries another bounded burst after a
five-minute cooldown. This avoids both a hot reconnect loop and a laptop that
needs manual attention after a longer router or relay outage.

The same behavior applies if the internet is unavailable at bridge startup:
the loopback coordinator, local queue, and Home Fleet listener stay alive while
the public relay retries in the background. The terminal prints the QR only
after a valid HTTPS endpoint exists; it never emits an empty or unsafe pairing
URL.

On an unchanged relay, a paired phone automatically retries a brief WebSocket
or Wi-Fi loss with a small rotating resumption secret held in bridge memory
and in that iPhone's device-only Keychain. It is never written to a bridge
file or placed in a URL. The bridge keeps a small, device-scoped in-memory
tail of display progress and the completed report, so a local job that finishes
during the gap can be shown after the phone resumes. Commands are never
replayed. A bridge restart, resumption expiry, or a genuinely different public
origin still intentionally asks for a fresh QR scan.

For phone continuity away from home, Omnibus persists a requested random
`omnibus-…` localtunnel subdomain in the coordinator's owner-only state folder
unless the owner sets `TUNNEL_SUBDOMAIN` themselves. That lets ordinary relay
reconnects retain the same public origin while the iPhone moves from Wi-Fi to
cellular. The QR token remains the authentication boundary; the subdomain is
not a secret. The iPhone stores only its rolling resume credential in its own
Keychain and retries the remembered bridge when it returns to the foreground.
If the laptop restarts, the relay provider permanently rejects the requested
name, or a bridge intentionally rotates to a different origin, no local app
can safely discover the new address without a hosted rendezvous service—the
terminal prints a new QR code in that case.

If a replacement relay returns at that same stable public origin, it is **not**
a new pairing generation: the bridge preserves the active resumption secrets
and the phone reconnects by itself. If the provider returns a genuinely
different origin, the bridge invalidates every old QR/resume secret and prints
a fresh QR code before continuing. Home Fleet workers are not affected by this
public relay recovery: their worker registration and review traffic stays on
the direct private LAN.

### Host availability while serving

`OMNIBUS_KEEP_AWAKE=true` is the default for `start`, model preparation, and
`worker`. It applies a user-scoped, best-effort inhibitor only for the active
Omnibus process: `caffeinate -i -m -w <pid>` on macOS, a fixed PowerShell
`SetThreadExecutionState` loop on Windows, and a fixed parent-watched
`systemd-inhibit` helper on Linux. Helper exits receive bounded retry; a
missing or forbidden helper degrades visibly instead of retrying forever.

This setting never changes a global power plan, installs a service, forces the
display on, or attempts to defeat a lid-close policy. It cannot survive a
forced reboot, power/battery loss, enterprise policy, or a laptop being
physically turned off. Set `OMNIBUS_KEEP_AWAKE=false` before launch for a
battery-sensitive session.

## Home Fleet: trusted private-LAN peer review

Home Fleet lets one phone-paired laptop use spare laptops you control for
independent, bounded local peer reviews. It is deliberately not a general
distributed-compute API, a remote shell, or a way to expose Ollama on the
Internet.

### Roles and boundaries

- The **coordinator** is the laptop paired to the iPhone. It runs the normal
  Auditor/Developer workflow, keeps workspace context, serializable session
  memory, audit files, and any provider credentials, and owns the regular
  QR/WSS tunnel.
- A **worker** is an extra Mac or Windows laptop on the same trusted private
  LAN. It has its own local Ollama runtime and accepts one fixed `review` role
  at a time. It cannot receive arbitrary protocol or shell commands, model
  tags, source files, provider credentials, or host-execution authority.
  Its only review input is the owner's bounded directive; it has no URL-fetch
  capability.
- The **iPhone remains iOS-only**. It is the consent/control surface; it is
  not a worker and it never receives a worker address or shared secret.

The public pairing QR code/localtunnel serves only the iPhone-to-coordinator
connection. It is never used to reach a worker. Worker registration and review
traffic move directly between coordinator and worker on a private LAN.

### Add a worker

1. Start the coordinator normally and pair the iPhone with its QR code.
2. In **Fleet Setup → Home Fleet**, create a worker invitation. The paired
   phone receives a short-lived one-time command, not a public share link.
3. On a spare laptop you own, ensure Node 22+ and a local Ollama runtime are
   available. On Windows, complete the official Ollama installation described
   above first. Paste the exact generated command into Terminal or Windows
   PowerShell:

   ```bash
   npx --yes omnibus-bridge@<version> worker --join <payload> --pull-models
   ```

   `<payload>` is an opaque, single-use join secret (currently short-lived,
   approximately five minutes). Do not modify, log, paste into a chat, or
   reuse it. The generated command pins the installed package version; its
   `npx --yes` only approves the temporary npm package download. Omnibus still
   asks at the worker terminal before a model is downloaded. `--pull-models`
   requests that worker's fixed local peer-review model; it never authorizes a
   runtime install or arbitrary model download.
4. The worker registers through the direct private-LAN coordinator listener.
   Return to Fleet Setup and **actively approve** that worker. Registration is
   not activation; an unapproved, offline, busy, or model-missing worker is
   never sent an idea.
5. For each eligible ideation or plan request, turn on **Home Fleet** and
   confirm it. This is separate from Web Research consent. A marketing job
   never uses Home Fleet workers.

At most the coordinator’s bounded worker limit is paired (four by default).
Removing a worker deletes the coordinator’s derived credential and stops later
dispatches; remove it promptly if the laptop changes owners or leaves the
trusted network.

Each running worker sends a signed heartbeat every 15 seconds under normal
conditions, with bounded retry after an outage. A valid heartbeat can rebind a
worker’s DHCP-moved address or learn a coordinator listener move; it never
clears a pairing merely because a LAN response is missing or unauthenticated.
At capacity, Fleet Setup can create a **repair invitation** only for an
existing worker that proves its old derived session; a new laptop is still
rejected until an owner removes a worker.

### What moves across the home LAN

For a specifically confirmed idea, the coordinator sends a bounded copy of the
owner's original directive to each ready, approved worker. The first three
ready workers receive complementary product, feasibility, and risk lenses, so
the bounded parallel work is additive rather than three identical prompts. A
worker returns a bounded peer-review summary. On the default local Ollama
Developer route, the
coordinator treats those summaries as untrusted advisory material for the
final report. When the selected Developer is Codex CLI or GPT-5.6 Responses,
Omnibus deliberately withholds worker summaries from that external or
tool-using executor.

The following always stay on the coordinator: workspace map/snippets, source
files, cross-idea/session memory, audit history, Brave/OpenAI/Higgsfield keys,
Codex authority, model-management authority, and host command execution.
Workers use their own loopback Ollama instance; the coordinator cannot pull or
change a worker model through the LAN protocol.

### Network and firewall requirements

The running coordinator and worker services are intentionally limited to
concrete RFC1918 private IPv4 addresses, never hostnames, loopback, or public
addresses. (The lower-level protocol permits loopback for isolated use; it
cannot connect a second laptop.) The coordinator checks that a
worker’s advertised literal address is the same private address that
registered it. There is no port-forwarding, reverse proxy, cloud relay, or
public-tunnel mode.

The LAN protocol uses HTTP with one-time join proofs and authenticated,
timestamped, replay-protected HMAC requests. **It is not TLS-encrypted.** HMAC
proves the paired peer sent a request; it does not conceal the approved idea
text or review from a network observer. Use only a trusted private home LAN;
do not use guest Wi-Fi, public/shared networks, or a network with untrusted
devices.

The default private listener ports are `8791` for the coordinator registration
listener and `8792` for a worker review listener. If macOS or Windows Firewall
asks, allow them only on the local/private subnet or **Private** network
profile—never Public/Guest. Do not create router port-forwards. Advanced
owners can choose a different private literal bind address or port on each
laptop with the owner-side `HOME_FLEET_*` settings; those settings are never
controlled by the phone or sent in an invitation.

### Worker model setup

The coordinator’s named Fleet Setup profile governs its local Auditor and
Developer. A worker is intentionally smaller and independent: it uses its own
fixed local peer-review model (`HOME_FLEET_WORKER_MODEL`, default
`qwen2.5-coder:1.5b`) and context (`HOME_FLEET_WORKER_NUM_CTX`, default 8192).
The generated worker command can pull only that configured worker model after
the owner supplied `--pull-models`; it does not make a model API reachable on
the LAN.

Useful owner-side settings, configured separately on the relevant laptop, are:

```dotenv
# Coordinator only: must be a private IPv4 literal for a multi-laptop fleet.
HOME_FLEET_BIND_HOST=192.168.1.20
HOME_FLEET_COORDINATOR_PORT=8791
HOME_FLEET_MAX_WORKERS=4

# Worker only: its own private IPv4 literal and fixed local review model.
HOME_FLEET_BIND_HOST=192.168.1.21
HOME_FLEET_WORKER_PORT=8792
HOME_FLEET_WORKER_MODEL=qwen2.5-coder:1.5b
HOME_FLEET_WORKER_NUM_CTX=8192
```

Use the actual private addresses allocated to your own machines; do not copy
the example addresses as public DNS records or expose them outside the home
LAN.

## Model team

Without a saved Fleet Setup selection, both roles default to
`qwen2.5-coder:7b-instruct-q4_K_M`, so a terminal-first installation pulls it
only once. A saved named fleet overrides the local Auditor/Developer model,
context, and per-request Ollama keep-alive values at bridge startup. The
Auditor always remains local; the selected Developer model is used when
`DEVELOPER_PROVIDER=ollama`, while Codex CLI and Responses remain explicit
owner-configured alternatives.

```dotenv
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5-coder:7b-instruct-q4_K_M
OLLAMA_DEVELOPER_MODEL=qwen2.5-coder:7b-instruct-q4_K_M
OLLAMA_NUM_CTX=32768
```

All unqualified paths (`WORKSPACE_ROOT`, `AUDIT_DIR`, and `STATE_DIR`) are
resolved from the terminal's current directory, not from `node_modules`. This
makes the globally installed binary safe to use from any owner-controlled
workspace.

### Local context, memory, and queueing

The default local Ollama route gives the Auditor a small workspace map and a
few source excerpts. This is not an unrestricted index: it refuses symlinks,
hidden/VCS/dependency folders, files with likely credential names, binary
files, oversized files, and files containing likely literal credentials.

```dotenv
QUEUE_MAX_PENDING=12
QUEUE_MAX_ATTEMPTS=3
QUEUE_RETRY_BASE_MS=1500
WORKSPACE_CONTEXT_MAX_FILES=24
WORKSPACE_CONTEXT_MAX_SNIPPETS=4
WORKSPACE_CONTEXT_MAX_CHARS=8000
```

The bridge executes one queued job at a time and keeps compact retry metadata
under `.omnibus/state/command-queue.json`. A restart never replays a stale
idea, workspace edit, or provider job: unfinished jobs remain inspectable as
failed history and require a new paired-device confirmation.

Completed rationale/result summaries can provide continuity for later requests
from the **same live paired session**. That memory is local-only and is withheld for
Codex CLI and Responses routes, so private prior work is not inserted into a
cloud provider prompt.

### Optional cited web research

Web research is disabled by default. After QR pairing, the owner can enter an
existing Brave Search API key once in Fleet Setup and enable research there;
the key is privately stored in `bridge-settings.json` and never returned to the
phone, event stream, or audit log. Omnibus cannot create a Brave account or API
key, cannot bypass Brave's access controls, and cannot enable research without
an owner-supplied key. A laptop owner may instead configure the same adapter in
their local `.env` file:

```dotenv
WEB_RESEARCH_ENABLED=true
WEB_RESEARCH_PROVIDER=brave
BRAVE_SEARCH_API_KEY=your-laptop-only-key
WEB_RESEARCH_MAX_RESULTS=5
WEB_RESEARCH_TIMEOUT_MS=12000
WEB_RESEARCH_QUERY_MAX_CHARS=400
WEB_RESEARCH_MAX_CONTENT_CHARS=5000
```

When an existing environment key is present, Fleet Setup recognizes the
provider and its on/off control records only the preference; it does not copy
the environment key into `bridge-settings.json`.

The iPhone still requires a per-idea **Web Research** toggle and a confirmation
before any search happens. The bridge sends only that approved idea text to
Brave's fixed HTTPS search endpoint; it never sends workspace files, local
agent memory, or audit history. The API key is used only as Brave's HTTPS
authentication header and never reaches the phone, a model prompt, or audit
trail. It does not fetch result pages:
it uses bounded search excerpts and sanitized citation URLs, so source links
cannot become an SSRF fetch path. The local Auditor treats those excerpts as
untrusted reference material and the copied report includes its source list.
If the provider is disabled, unavailable, or rejects a sensitive-looking
query, the local Ollama review continues and reports that research was skipped.

## Optional providers

`DEVELOPER_PROVIDER=ollama` is the default, and needs no API key or in-product
spending limit.

- `DEVELOPER_PROVIDER=responses` requires `OPENAI_API_KEY`. It produces a
  cloud-assisted report but cannot execute host commands.
- `DEVELOPER_PROVIDER=codex-cli` requires `HOST_EXECUTION_ENABLED=true` and a
  locally installed Codex CLI. It is constrained to `WORKSPACE_ROOT`.

The bridge records model, token, latency, and—when available—cloud cost
telemetry in its local audit trail. This is observational only: there is no
product-level dollar ceiling. The $100 hackathon constraint applies to building
Omnibus, not to an owner's use of the finished bridge.

## Marketing jobs

The mobile app can send a locally confirmed `marketing` request. It only runs
when the owner has installed/authenticated the official Higgsfield CLI and set:

```dotenv
HIGGSFIELD_EXECUTION_ENABLED=true
HIGGSFIELD_COMMAND=higgsfield
# Optional for a Soul-based asset:
HIGGSFIELD_SOUL_ID=
```

The bridge waits for the official CLI job, writes a bounded JSON handoff in
`.omnibus/state/marketing/`, and returns the job ID/asset URL when the CLI
provides them. Social distribution deliberately stops there: publishing needs
your own reviewed TikTok/Meta OAuth applications, authorized accounts, and a
final human review of claims, rights, disclosures, and audience settings.

## Development

```bash
npm install
npm --workspace bridge run typecheck
npm --workspace bridge test
npm --workspace bridge run build
```

The package's npm `prepack` hook compiles `dist/` before packaging; it does not
pull models or contact Ollama.

## Next-stage ideas — not part of this build

Home Fleet is implemented above. The following are future directions, not
features included in this package:

- **Project RAG:** a local, permissioned repository index with explicit file
  inclusion and inspectable retrieval citations.
- **Fleet calibration:** an opt-in on-device benchmark of a selected local
  profile, rather than relying only on capacity estimates.
- **Approval workflows:** richer human approvals for workspace edits, research,
  model changes, and any future distribution step.
