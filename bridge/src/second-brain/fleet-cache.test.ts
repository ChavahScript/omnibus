import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../config.js";
import { HomeFleetService } from "../home-fleet-service.js";
import {
  CONTEXT_FETCH_PATH,
  CONTEXT_OFFER_PATH,
  HomeFleetCoordinator,
  HomeFleetWorker,
  type HomeFleetEndpoint,
} from "../home-fleet.js";
import { compileFleetContextBundle, PrefixCacheDirectory } from "./fleet-cache.js";
import type { FleetContextBundle } from "./types.js";

const FIXED_NOW = () => new Date("2026-07-19T12:00:00.000Z");

function sampleBundle(): FleetContextBundle {
  const bundle = compileFleetContextBundle({
    projectLabel: "Omnibus",
    factLines: [
      "The bridge persists memory as owner-only atomic JSON files",
      "Peer reviews receive only the owner's idea text",
    ],
    antiPatternDigest: "// Wrong\nfetch without timeout\n// Correct\nAbortSignal.timeout",
    invariants: ["Local-first: nothing leaves the laptop without explicit consent"],
  }, 20_000, FIXED_NOW);
  assert.ok(bundle);
  return bundle;
}

type FetchCall = { url: string; body?: string };

/** Records every outbound fetch (URL + string body) while delegating to the real fetch. */
function spyOnFetch(): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    return original(input as never, init);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("compileFleetContextBundle is deterministic, content-addressed, redacted, and undefined when empty", () => {
  const input = {
    projectLabel: "Omnibus",
    factLines: [
      "The queue retries jobs with bounded backoff",
      "A leaked credential sk-ABCDEF1234567890abcdef must never be distilled",
    ],
    antiPatternDigest: "// Wrong\neval(userInput)\n// Correct\nschema.parse(userInput)",
    invariants: ["Reviews are advisory only"],
  };
  const first = compileFleetContextBundle(input, 20_000, FIXED_NOW);
  const second = compileFleetContextBundle(input, 20_000, FIXED_NOW);
  assert.ok(first && second);
  assert.deepEqual(first, second);
  assert.equal(first.digest, createHash("sha256").update(first.text, "utf8").digest("hex"));
  assert.equal(first.compiledAt, "2026-07-19T12:00:00.000Z");
  assert.equal(first.facts, 2);
  assert.ok(first.antiPatterns >= 1);
  assert.match(first.text, /owner-approved/i);
  assert.match(first.text, /untrusted reference material/i);
  assert.match(first.text, /bounded backoff/);
  assert.match(first.text, /Reviews are advisory only/);
  assert.match(first.text, /\[REDACTED\]/);
  assert.doesNotMatch(first.text, /sk-ABCDEF/);

  // No distilled facts at all means no bundle, regardless of other sections.
  assert.equal(
    compileFleetContextBundle({ projectLabel: "X", factLines: [], antiPatternDigest: "digest", invariants: ["i"] }),
    undefined,
  );

  // Oversized requests are capped at the transport-safe 20k ceiling and the
  // truncation happens only at line boundaries.
  const capped = compileFleetContextBundle({
    projectLabel: "Big",
    factLines: Array.from({ length: 2_000 }, (_, index) => `fact ${index} ${"x".repeat(40)}`),
    antiPatternDigest: "",
    invariants: [],
  }, 1_000_000, FIXED_NOW);
  assert.ok(capped);
  assert.ok(capped.text.length <= 20_000);
  assert.match(capped.text, /x{40}$/);
  assert.ok(capped.facts < 2_000);
});

test("PrefixCacheDirectory validates digests, tracks warm workers, and reports status", () => {
  const directory = new PrefixCacheDirectory();
  const digestA = "a".repeat(64);
  const digestB = "b".repeat(64);
  directory.record("worker-1", [digestA, "not-a-digest", "B".repeat(64)], "2026-07-19T12:00:00.000Z");
  directory.record("worker-2", [digestA, digestB], "2026-07-19T12:00:01.000Z");
  assert.deepEqual(directory.workersWarmFor(digestA), ["worker-1", "worker-2"]);
  assert.deepEqual(directory.workersWarmFor(digestB), ["worker-2"]);
  assert.deepEqual(directory.workersWarmFor("B".repeat(64)), []);

  // At most four digests survive per worker; extras are dropped.
  const many = ["1", "2", "3", "4", "5"].map(char => char.repeat(64));
  directory.record("worker-3", many, "2026-07-19T12:00:02.000Z");
  assert.deepEqual(directory.workersWarmFor(many[3]!), ["worker-3"]);
  assert.deepEqual(directory.workersWarmFor(many[4]!), []);

  directory.forget("worker-1");
  assert.deepEqual(directory.workersWarmFor(digestA), ["worker-2"]);

  assert.equal(directory.peerTransfers, 0);
  assert.equal(directory.countPeerTransfer(), 1);
  assert.equal(directory.countPeerTransfer(), 2);
  assert.equal(directory.peerTransfers, 2);

  const bundle = sampleBundle();
  directory.record("worker-2", [bundle.digest], "2026-07-19T12:00:03.000Z");
  const status = directory.status(bundle, true, directory.peerTransfers);
  assert.deepEqual(status, {
    sharingEnabled: true,
    bundleDigest: bundle.digest,
    bundleChars: bundle.text.length,
    bundleCompiledAt: bundle.compiledAt,
    workersWarm: 1,
    peerTransfers: 2,
  });
  assert.deepEqual(directory.status(undefined, false, 0), {
    sharingEnabled: false,
    bundleDigest: null,
    bundleChars: 0,
    bundleCompiledAt: null,
    workersWarm: 0,
    peerTransfers: 0,
  });
});

test("an inline seed offer stores the bundle, heartbeats advertise it, and warm reviews receive the exact prefix text", async () => {
  const warmedDigests: string[] = [];
  const reviewInputs: Array<{ requestId: string; text: string; prefixText?: string }> = [];
  const coordinator = new HomeFleetCoordinator();
  const worker = new HomeFleetWorker({
    label: "Cache One",
    installedModels: ["qwen2.5-coder:1.5b"],
    contextWarmer: async bundle => { warmedDigests.push(bundle.digest); return true; },
    review: input => { reviewInputs.push({ ...input }); return { summary: "ok" }; },
  });
  try {
    await coordinator.listen();
    await worker.listen();
    await worker.join(coordinator.issueJoinInvitation());
    const bundle = sampleBundle();

    const seeded = await coordinator.offerContext(worker.workerId, bundle);
    // Warming is detached from the offer response so a slow model ingest can
    // never outlive the coordinator's bounded HTTP window; the acknowledged
    // status is therefore "cached", and the warm call runs in the background.
    assert.equal(seeded.status, "cached");
    await waitFor(() => warmedDigests.length === 1);
    assert.deepEqual(warmedDigests, [bundle.digest]);
    // A digest already held answers "cached" with no second warm/transfer.
    const repeated = await coordinator.offerContext(worker.workerId, bundle);
    assert.equal(repeated.status, "cached");
    assert.deepEqual(warmedDigests, [bundle.digest]);

    assert.equal((await worker.heartbeat()).status, "ok");
    assert.deepEqual(coordinator.snapshot().workers[0]?.cachedPrefixes, [bundle.digest]);

    const warmReview = await coordinator.reviewWorkers([worker.workerId], "Review this bounded idea.", { prefixDigest: bundle.digest });
    assert.equal(warmReview[0]?.status, "ok");
    assert.equal(reviewInputs[0]?.prefixText, bundle.text);

    // An unknown digest must never fail the review; it simply runs cold.
    const coldReview = await coordinator.reviewWorkers([worker.workerId], "Review it again.", { prefixDigest: "f".repeat(64) });
    assert.equal(coldReview[0]?.status, "ok");
    assert.equal(reviewInputs[1]?.prefixText, undefined);
  } finally {
    await Promise.allSettled([worker.close(), coordinator.close()]);
  }
});

test("a cold worker fetches the bundle from a warm peer; forged tickets and tampered text are rejected", async () => {
  const coordinator = new HomeFleetCoordinator();
  const warmWorker = new HomeFleetWorker({ label: "Warm Peer", installedModels: ["m"] });
  const coldWorker = new HomeFleetWorker({ label: "Cold Peer", installedModels: ["m"] });
  const victimWorker = new HomeFleetWorker({ label: "Tamper Target", installedModels: ["m"] });
  let rogueServer: Server | undefined;
  const spy = spyOnFetch();
  try {
    await coordinator.listen();
    for (const worker of [warmWorker, coldWorker, victimWorker]) {
      await worker.listen();
      await worker.join(coordinator.issueJoinInvitation());
    }
    const bundle = sampleBundle();
    assert.equal((await coordinator.offerContext(warmWorker.workerId, bundle)).status, "cached");
    const warmEndpoint = warmWorker.snapshot().endpoint!;

    spy.calls.length = 0;
    const viaPeer = await coordinator.offerContext(
      coldWorker.workerId,
      bundle,
      { workerId: warmWorker.workerId, endpoint: warmEndpoint },
    );
    assert.equal(viaPeer.status, "cached");
    // The coordinator's offer carried no inline text — only digest + ticket —
    // and the bundle body moved worker-to-worker from the warm peer.
    const offerCall = spy.calls.find(call => call.url.endsWith(CONTEXT_OFFER_PATH));
    assert.ok(offerCall?.body);
    const offerBody = JSON.parse(offerCall.body) as { text?: string; digest: string; peer?: { workerId: string } };
    assert.equal(offerBody.text, undefined);
    assert.equal(offerBody.digest, bundle.digest);
    assert.equal(offerBody.peer?.workerId, warmWorker.workerId);
    assert.equal(spy.calls.filter(call => call.url === `${warmEndpoint.url}${CONTEXT_FETCH_PATH}`).length, 1);
    assert.equal((await coldWorker.heartbeat()).status, "ok");
    const coldSnapshot = coordinator.snapshot().workers.find(worker => worker.workerId === coldWorker.workerId);
    assert.deepEqual(coldSnapshot?.cachedPrefixes, [bundle.digest]);

    // A forged ticket cannot pull a bundle out of the serving worker.
    const forged = await fetch(`${warmEndpoint.url}${CONTEXT_FETCH_PATH}`, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: 1,
        type: "home_fleet.context_fetch",
        digest: bundle.digest,
        requesterWorkerId: coldWorker.workerId,
        ticket: "A".repeat(43),
        ticketExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        nonce: randomUUID(),
      }),
    });
    assert.equal(forged.status, 401);

    // A peer that returns text failing the digest check is not accepted:
    // content addressing is the transfer's integrity model.
    rogueServer = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        protocolVersion: 1,
        type: "home_fleet.context_fetched",
        digest: bundle.digest,
        text: "tampered bundle text that does not hash to the digest",
      }));
    });
    await new Promise<void>(resolve => rogueServer!.listen(0, "127.0.0.1", resolve));
    const rogueAddress = rogueServer.address();
    assert.ok(rogueAddress && typeof rogueAddress !== "string");
    const rogueEndpoint: HomeFleetEndpoint = {
      protocol: "http",
      host: "127.0.0.1",
      port: rogueAddress.port,
      url: `http://127.0.0.1:${rogueAddress.port}`,
    };
    const tampered = await coordinator.offerContext(
      victimWorker.workerId,
      bundle,
      { workerId: warmWorker.workerId, endpoint: rogueEndpoint },
    );
    assert.equal(tampered.status, "failed");
    assert.equal((await victimWorker.heartbeat()).status, "ok");
    const victimSnapshot = coordinator.snapshot().workers.find(worker => worker.workerId === victimWorker.workerId);
    assert.equal(victimSnapshot?.cachedPrefixes, undefined);
  } finally {
    spy.restore();
    await Promise.allSettled([
      warmWorker.close(),
      coldWorker.close(),
      victimWorker.close(),
      coordinator.close(),
      new Promise<void>(resolve => rogueServer ? rogueServer.close(() => resolve()) : resolve()),
    ]);
  }
});

// ---------------------------------------------------------------------------
// HomeFleetService (coordinator product layer) on a loopback listener
// ---------------------------------------------------------------------------

const SERVICE_DIRECTIVE = "Build a local-first notes app for the paired phone";
let promptWithoutSharing: string | undefined;

type ServiceHarness = {
  service: HomeFleetService;
  coordinator: HomeFleetCoordinator;
};

/**
 * The production service only binds RFC1918 adapters, which CI machines may
 * not have. These tests exercise the same code paths deterministically by
 * starting the service's own coordinator on loopback and stubbing listener
 * recovery, exactly like the protocol tests do.
 */
async function createLoopbackService(root: string, sharing: boolean): Promise<ServiceHarness> {
  const config = loadConfig({
    cwd: root,
    env: {
      STATE_DIR: path.join(root, "state"),
      ...(sharing ? { HOME_FLEET_CONTEXT_SHARING: "true" } : {}),
    },
  });
  const service = new HomeFleetService(config);
  const internals = service as unknown as {
    coordinator: HomeFleetCoordinator;
    available: boolean;
    ensureCoordinatorListener: () => Promise<void>;
  };
  await internals.coordinator.listen();
  internals.available = true;
  internals.ensureCoordinatorListener = async () => {};
  return { service, coordinator: internals.coordinator };
}

async function pairServiceWorker(harness: ServiceHarness, worker: HomeFleetWorker): Promise<void> {
  await worker.listen();
  await worker.join(harness.coordinator.issueJoinInvitation());
  await harness.service.approveWorker(worker.workerId);
}

test("with sharing disabled the review path is byte-identical: same prompt, no provider call, zero context messages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omnibus-fleet-cache-"));
  const prompts: string[] = [];
  const worker = new HomeFleetWorker({
    label: "Plain Worker",
    installedModels: ["m"],
    review: ({ text }) => { prompts.push(text); return { summary: "fine" }; },
  });
  let harness: ServiceHarness | undefined;
  const spy = spyOnFetch();
  try {
    harness = await createLoopbackService(root, false);
    await pairServiceWorker(harness, worker);
    const bundle = sampleBundle();

    const baseline = await harness.service.review({ correlationId: "c1", directive: SERVICE_DIRECTIVE });
    assert.equal(baseline.attempted, 1);
    assert.equal(baseline.reviews.length, 1);

    let providerCalls = 0;
    harness.service.setContextBundleProvider(async () => { providerCalls += 1; return bundle; });
    spy.calls.length = 0;
    const withProvider = await harness.service.review({ correlationId: "c2", directive: SERVICE_DIRECTIVE });
    assert.equal(withProvider.attempted, 1);

    // The consent flag is off, so the provider is never even consulted and
    // the prompt that crossed the LAN is byte-identical to the baseline.
    assert.equal(providerCalls, 0);
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0], prompts[1]);
    assert.ok(!prompts[1]!.includes(bundle.text.slice(0, 60)));
    assert.ok(prompts[1]!.includes(SERVICE_DIRECTIVE));
    promptWithoutSharing = prompts[1];
    assert.equal(spy.calls.some(call => call.url.includes(CONTEXT_OFFER_PATH) || call.url.includes(CONTEXT_FETCH_PATH)), false);
    const reviewCall = spy.calls.find(call => call.url.endsWith("/home-fleet/v1/review"));
    assert.ok(reviewCall?.body);
    assert.equal((JSON.parse(reviewCall.body) as { prefixDigest?: string }).prefixDigest, undefined);

    const status = harness.service.cacheStatus();
    assert.equal(status.sharingEnabled, false);
    assert.equal(status.bundleDigest, null);
    assert.equal(status.peerTransfers, 0);
  } finally {
    spy.restore();
    await Promise.allSettled([worker.close(), harness?.service.close() ?? Promise.resolve()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("with sharing enabled, warm workers are routed first, cold workers are seeded peer-to-peer, and prompts stay unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omnibus-fleet-cache-"));
  const bundle = sampleBundle();
  const reviewLog = new Map<string, { text: string; prefixText?: string }>();
  const makeWorker = (id: string, label: string) => new HomeFleetWorker({
    workerId: id,
    label,
    installedModels: ["m"],
    review: input => {
      reviewLog.set(id, { text: input.text, ...(input.prefixText !== undefined ? { prefixText: input.prefixText } : {}) });
      return { summary: `${label} reviewed` };
    },
  });
  const workerA = makeWorker("worker-a", "Alpha");
  const workerB = makeWorker("worker-b", "Beta");
  const workerC = makeWorker("worker-c", "Gamma");
  const workerD = makeWorker("worker-d", "Delta");
  const workers = [workerA, workerB, workerC, workerD];
  let harness: ServiceHarness | undefined;
  const spy = spyOnFetch();
  try {
    harness = await createLoopbackService(root, true);
    for (const worker of workers) await pairServiceWorker(harness, worker);

    // Seed exactly one worker and let its signed heartbeat advertise the
    // digest; the service's next health refresh feeds the warm directory.
    assert.equal((await harness.coordinator.offerContext(workerD.workerId, bundle)).status, "cached");
    assert.equal((await workerD.heartbeat()).status, "ok");

    harness.service.setContextBundleProvider(async () => bundle);
    spy.calls.length = 0;
    const outcome = await harness.service.review({ correlationId: "c3", directive: SERVICE_DIRECTIVE });
    assert.equal(outcome.attempted, 3);
    assert.equal(outcome.reviews.length, 3);

    // Warm-first ordering: the warm worker (last by id) displaces the third
    // cold worker from the bounded three-review slice instead of idling.
    assert.deepEqual([...reviewLog.keys()].sort(), ["worker-a", "worker-b", "worker-d"]);
    assert.equal(reviewLog.has("worker-c"), false);

    // Every dispatched worker ended up warm and reviewed with the exact
    // bundle text as its prefix, while the prompt itself never embeds it.
    for (const id of ["worker-a", "worker-b", "worker-d"]) {
      assert.equal(reviewLog.get(id)?.prefixText, bundle.text);
      assert.ok(!reviewLog.get(id)!.text.includes(bundle.text.slice(0, 60)));
    }
    assert.ok(promptWithoutSharing, "the sharing-disabled test runs first in this file");
    const productLensPrompt = [...reviewLog.values()].map(entry => entry.text).find(text => text === promptWithoutSharing);
    assert.ok(productLensPrompt, "the first-lens prompt is byte-identical with and without sharing");

    // Both cold offers pointed at the warm peer: no inline text re-send, two
    // worker-to-worker fetches against the warm worker's endpoint.
    const offerBodies = spy.calls
      .filter(call => call.url.endsWith(CONTEXT_OFFER_PATH))
      .map(call => JSON.parse(call.body ?? "{}") as { text?: string; peer?: { workerId: string } });
    assert.equal(offerBodies.length, 2);
    for (const body of offerBodies) {
      assert.equal(body.text, undefined);
      assert.equal(body.peer?.workerId, workerD.workerId);
    }
    const warmEndpoint = workerD.snapshot().endpoint!;
    assert.equal(spy.calls.filter(call => call.url === `${warmEndpoint.url}${CONTEXT_FETCH_PATH}`).length, 2);

    const status = harness.service.cacheStatus();
    assert.equal(status.sharingEnabled, true);
    assert.equal(status.bundleDigest, bundle.digest);
    assert.equal(status.bundleChars, bundle.text.length);
    assert.equal(status.peerTransfers, 2);
    assert.ok(status.workersWarm >= 1);
  } finally {
    spy.restore();
    await Promise.allSettled([...workers.map(worker => worker.close()), harness?.service.close() ?? Promise.resolve()]);
    await rm(root, { recursive: true, force: true });
  }
});

/** Polls a condition; detached background warming has no completion event. */
async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitFor timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("an owner rename rides the signed heartbeat once and updates the coordinator's snapshot", async () => {
  const coordinator = new HomeFleetCoordinator();
  const worker = new HomeFleetWorker({ label: "macOS Peer · Cedar", installedModels: ["qwen2.5-coder:1.5b"] });
  try {
    await coordinator.listen();
    await worker.listen();
    await worker.join(coordinator.issueJoinInvitation());
    assert.equal(coordinator.snapshot().workers[0]?.label, "macOS Peer · Cedar");

    // Simulate `worker --label "Kitchen MacBook"` on a later run: same
    // pairing, new label, advertisement armed.
    const renamed = HomeFleetWorker.fromPrivateState(
      { label: "Kitchen MacBook", advertiseLabelUpdate: true },
      worker.exportPrivateState(),
    );
    await renamed.listen();
    assert.equal((await renamed.heartbeat()).status, "ok");
    assert.equal(coordinator.snapshot().workers[0]?.label, "Kitchen MacBook");

    // The advertisement stops after one acknowledged beat, and a plain
    // heartbeat (legacy payload shape) still verifies.
    assert.equal((await renamed.heartbeat()).status, "ok");
    assert.equal(coordinator.snapshot().workers[0]?.label, "Kitchen MacBook");
    await renamed.close();
  } finally {
    await Promise.allSettled([worker.close(), coordinator.close()]);
  }
});
