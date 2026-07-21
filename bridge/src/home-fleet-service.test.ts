import assert from "node:assert/strict";
import test from "node:test";
import { selectPrivateLanHost } from "./home-fleet-service.js";

test("the production Home Fleet listener accepts only a concrete RFC1918 IPv4 bind address", () => {
  // The protocol primitive permits loopback for unit tests, but the actual
  // multi-laptop service must never advertise loopback, a public address, or
  // a hostname as its coordinator endpoint.
  assert.equal(selectPrivateLanHost("10.42.0.9"), "10.42.0.9");
  assert.equal(selectPrivateLanHost("172.20.4.9"), "172.20.4.9");
  assert.equal(selectPrivateLanHost("192.168.50.4"), "192.168.50.4");
  assert.equal(selectPrivateLanHost("127.0.0.1"), undefined);
  assert.equal(selectPrivateLanHost("8.8.8.8"), undefined);
  assert.equal(selectPrivateLanHost("home-laptop.local"), undefined);
});

test("duplicate worker labels get a stable, owner-readable display suffix so the owner can tell laptops apart", async () => {
  const { disambiguateWorkerLabels } = await import("./home-fleet-service.js");
  const worker = (id: string, label: string, registeredAt?: string) => ({
    id,
    label,
    status: "online" as const,
    modelReady: true,
    approved: true,
    ...(registeredAt ? { registeredAt } : {}),
  });
  // With pairing times, the suffix explains itself: earlier pairing is 1st,
  // regardless of the order the workers appear in the snapshot.
  const paired = disambiguateWorkerLabels([
    worker("bbbb2222-0000-4000-8000-000000000002", "macOS Peer · Cedar", "2026-07-19T10:05:00.000Z"),
    worker("aaaa1111-0000-4000-8000-000000000001", "macOS Peer · Cedar", "2026-07-19T10:00:00.000Z"),
    worker("cccc3333-0000-4000-8000-000000000003", "Windows Peer · Flint", "2026-07-19T10:10:00.000Z"),
  ]);
  assert.equal(paired[0]?.label, "macOS Peer · Cedar (paired 2nd)");
  assert.equal(paired[1]?.label, "macOS Peer · Cedar (paired 1st)");
  // A unique label is left exactly as the owner chose it.
  assert.equal(paired[2]?.label, "Windows Peer · Flint");
  // The pairing time is snapshot-internal and never crosses to the phone.
  assert.equal("registeredAt" in (paired[0] ?? {}), false);

  // Without pairing times the short worker-id fragment remains the fallback.
  const twins = disambiguateWorkerLabels([
    worker("aaaa1111-0000-4000-8000-000000000001", "macOS Peer · Cedar"),
    worker("bbbb2222-0000-4000-8000-000000000002", "macOS Peer · Cedar"),
  ]);
  assert.equal(twins[0]?.label, "macOS Peer · Cedar · aaaa");
  assert.equal(twins[1]?.label, "macOS Peer · Cedar · bbbb");
  // Suffixing twice would double-append; the helper is display-only and pure.
  assert.deepEqual(disambiguateWorkerLabels([worker("dddd", "Solo")]), [worker("dddd", "Solo")]);
});

type ServiceInternals = {
  available: boolean;
  coordinator: unknown;
  approvedWorkerIds: Set<string>;
  ensureCoordinatorListener: () => Promise<void>;
  activeInviteExpiresAt?: string;
};

test("the owner can invite the next laptop immediately after a worker consumes the previous join token", async () => {
  const { randomUUID } = await import("node:crypto");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { HomeFleetService, HomeFleetServiceError } = await import("./home-fleet-service.js");
  const { HOME_FLEET_PROTOCOL_VERSION } = await import("./home-fleet.js");
  const statePath = await mkdtemp(path.join(os.tmpdir(), "omnibus-home-fleet-invite-"));
  try {
    const config = {
      statePath,
      homeFleetMaxWorkers: 4,
      homeFleetCoordinatorPort: 4787,
      homeFleetContextSharing: false,
    } as unknown as import("./config.js").AppConfig;
    const service = new HomeFleetService(config);
    const internals = service as unknown as ServiceInternals;
    internals.ensureCoordinatorListener = async () => undefined;
    internals.available = true;

    let pendingJoinTokens = 0;
    const invitation = () => ({
      protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
      type: "home_fleet.join" as const,
      invitationId: randomUUID(),
      joinToken: "A".repeat(43),
      coordinatorId: randomUUID(),
      coordinator: { protocol: "http" as const, host: "192.168.44.10", port: 4787, url: "http://192.168.44.10:4787/" },
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    internals.coordinator = {
      snapshot: () => ({
        protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
        role: "coordinator",
        coordinatorId: "coordinator",
        pendingJoinTokens,
        workers: [],
      }),
      issueJoinInvitation: () => {
        pendingJoinTokens = 1;
        return invitation();
      },
    };

    const first = await service.issueInvite(randomUUID());
    assert.match(first.command, /worker --join/);
    // The Windows form wraps the same command in `cmd /c` so PowerShell's
    // default execution policy cannot block npm's npx.ps1 shim on camera.
    assert.ok(first.commandWindows, "invite should carry a Windows command form");
    assert.match(first.commandWindows!, /^cmd \/c "npx --yes omnibus-bridge@.* worker --join .* --pull-models"$/);

    // While the one-time token is still pending, a second invite is refused.
    await assert.rejects(
      () => service.issueInvite(randomUUID()),
      (error: unknown) => error instanceof HomeFleetServiceError && error.code === "HOME_FLEET_INVITE_ACTIVE",
    );

    // The worker registers: the coordinator consumes the token immediately,
    // long before the invitation's five-minute display expiry passes.
    pendingJoinTokens = 0;
    const view = await service.snapshot();
    assert.equal(view.activeInviteExpiresAt, undefined);
    const second = await service.issueInvite(randomUUID());
    assert.match(second.command, /worker --join/);
  } finally {
    await rm(statePath, { recursive: true, force: true });
  }
});

test("each laptop keeps its review lens when cache warmth reorders dispatch", async () => {
  const { assignPeerReviewLenses } = await import("./home-fleet-service.js");
  // The pure ranking is order-independent: the same selected set always maps
  // the same worker to the same lens.
  const forward = assignPeerReviewLenses(["cc", "aa", "bb"]);
  const shuffled = assignPeerReviewLenses(["bb", "cc", "aa"]);
  for (const id of ["aa", "bb", "cc"]) {
    assert.deepEqual(forward.get(id), shuffled.get(id));
  }
  assert.equal(forward.get("aa")?.label, "Product lens");
  assert.equal(forward.get("bb")?.label, "Feasibility lens");
  assert.equal(forward.get("cc")?.label, "Risk lens");

  const { randomUUID } = await import("node:crypto");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { HomeFleetService } = await import("./home-fleet-service.js");
  const { HOME_FLEET_PROTOCOL_VERSION } = await import("./home-fleet.js");
  const statePath = await mkdtemp(path.join(os.tmpdir(), "omnibus-home-fleet-lens-"));
  const config = {
    statePath,
    homeFleetMaxWorkers: 4,
    homeFleetCoordinatorPort: 4787,
    homeFleetContextSharing: true,
  } as unknown as import("./config.js").AppConfig;
  const service = new HomeFleetService(config);
  try {
    const internals = service as unknown as ServiceInternals;
    internals.ensureCoordinatorListener = async () => undefined;
    internals.available = true;

    const idA = "aaaa1111-0000-4000-8000-000000000001";
    const idB = "bbbb2222-0000-4000-8000-000000000002";
    const digest = "a".repeat(64);
    const endpoint = { protocol: "http" as const, host: "192.168.44.10", port: 4787, url: "http://192.168.44.10:4787/" };
    const capabilities = {
      protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
      roles: ["review"] as const,
      installedModels: ["qwen2.5-coder:3b"],
      maxConcurrentReviews: 1 as const,
      acceptsArbitraryCommands: false as const,
      permitsModelPulls: false as const,
    };
    let warmWorkerId = idB;
    const workerSnapshot = (workerId: string, label: string) => ({
      workerId,
      label,
      endpoint,
      registeredAt: "2026-07-19T10:00:00.000Z",
      status: "healthy" as const,
      lastCheckedAt: new Date().toISOString(),
      capabilities,
      cachedPrefixes: workerId === warmWorkerId ? [digest] : [],
    });
    const calls: Array<{ workerId: string; prompt: string }> = [];
    internals.coordinator = {
      snapshot: () => ({
        protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
        role: "coordinator",
        coordinatorId: "coordinator",
        endpoint,
        pendingJoinTokens: 0,
        workers: [workerSnapshot(idA, "Peer Cedar"), workerSnapshot(idB, "Peer Flint")],
      }),
      inspectWorker: async (workerId: string) => workerSnapshot(workerId, "probe"),
      offerContext: async () => ({ status: "warmed" }),
      reviewWorkers: async (workerIds: string[], prompt: string) => {
        calls.push({ workerId: workerIds[0]!, prompt });
        return [{ workerId: workerIds[0]!, status: "ok", summary: "Concise advisory bullets." }];
      },
      exportPrivateState: () => ({ workers: [] }),
      close: async () => undefined,
    };
    internals.approvedWorkerIds.add(idA);
    internals.approvedWorkerIds.add(idB);
    service.setContextBundleProvider(async () => ({
      digest,
      text: "distilled owner context",
      compiledAt: new Date().toISOString(),
      facts: 1,
      antiPatterns: 0,
    }));

    // Run one: B is warm, so B is dispatched first.
    await service.review({ correlationId: randomUUID(), directive: "Build a private recipe planner." });
    // Run two: warmth flips to A, so dispatch order flips too.
    warmWorkerId = idA;
    await service.review({ correlationId: randomUUID(), directive: "Build a private recipe planner." });

    assert.equal(calls.length, 4);
    assert.equal(calls[0]?.workerId, idB);
    assert.equal(calls[2]?.workerId, idA);

    // Dispatch order changed, but each laptop kept its lens across runs.
    const lensOf = (prompt: string) => /Your assigned ([a-z]+) lens:/.exec(prompt)?.[1];
    const runOne = new Map(calls.slice(0, 2).map(call => [call.workerId, lensOf(call.prompt)]));
    const runTwo = new Map(calls.slice(2).map(call => [call.workerId, lensOf(call.prompt)]));
    assert.equal(runOne.get(idA), "product");
    assert.equal(runOne.get(idB), "feasibility");
    assert.deepEqual([...runTwo.entries()].sort(), [...runOne.entries()].sort());
  } finally {
    await service.close();
    await rm(statePath, { recursive: true, force: true });
  }
});

test("interfacePriority ranks real NICs ahead of Windows virtual/VPN adapters", async () => {
  const { interfacePriority } = await import("./home-fleet-service.js");
  assert.ok(interfacePriority("Wi-Fi") < interfacePriority("vEthernet (Default Switch)"));
  assert.ok(interfacePriority("Ethernet") < interfacePriority("VMware Network Adapter VMnet8"));
  assert.ok(interfacePriority("en0") < interfacePriority("utun3"));
  assert.ok(interfacePriority("Ethernet") < interfacePriority("Tailscale"));
  assert.equal(interfacePriority("OpenVPN TAP-Windows6"), 2);
  assert.equal(interfacePriority("Wi-Fi"), 0);
  assert.equal(interfacePriority("Ethernet 2"), 0);
});
