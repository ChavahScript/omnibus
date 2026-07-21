import assert from "node:assert/strict";
import test from "node:test";
import {
  HomeFleetCoordinator,
  HomeFleetError,
  HomeFleetWorker,
  isPrivateLanAddress,
  parseSerializedJoinInvitation,
  serializeHomeFleetJoinInvitation,
} from "./home-fleet.js";

test("home fleet accepts only RFC1918 or loopback literal addresses", () => {
  assert.equal(isPrivateLanAddress("10.2.3.4"), true);
  assert.equal(isPrivateLanAddress("172.16.0.1"), true);
  assert.equal(isPrivateLanAddress("172.31.255.255"), true);
  assert.equal(isPrivateLanAddress("192.168.1.8"), true);
  assert.equal(isPrivateLanAddress("127.0.0.1"), true);
  assert.equal(isPrivateLanAddress("::1"), true);
  assert.equal(isPrivateLanAddress("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateLanAddress("172.32.0.1"), false);
  assert.equal(isPrivateLanAddress("8.8.8.8"), false);
  assert.equal(isPrivateLanAddress("fc00::1"), false);
  assert.equal(isPrivateLanAddress("localhost"), false);
});

test("a private one-time invitation pairs a worker and authenticates fixed probes/reviews", async () => {
  const coordinator = new HomeFleetCoordinator();
  const worker = new HomeFleetWorker({
    label: "Desk Mini",
    installedModels: ["qwen2.5-coder:7b"],
    review: async ({ text }) => ({ summary: `Reviewed locally: ${text.slice(0, 48)}` }),
  });
  try {
    await coordinator.listen();
    await worker.listen();
    const invitation = coordinator.issueJoinInvitation();
    const serialized = serializeHomeFleetJoinInvitation(invitation);
    assert.match(serialized, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(parseSerializedJoinInvitation(serialized), invitation);

    await worker.joinSerializedInvitation(serialized);
    assert.equal(coordinator.snapshot().pendingJoinTokens, 0);
    assert.equal(coordinator.snapshot().workers.length, 1);

    const health = await coordinator.inspectWorker(worker.workerId);
    assert.equal(health.status, "healthy");
    assert.deepEqual(health.capabilities?.roles, ["review"]);
    assert.equal(health.capabilities?.acceptsArbitraryCommands, false);
    assert.equal(health.capabilities?.permitsModelPulls, false);

    const reviewed = await coordinator.reviewWorkers([worker.workerId], "Review this strictly bounded local product idea.");
    assert.deepEqual(reviewed.map(result => result.status), ["ok"]);
    assert.match(reviewed[0]?.summary ?? "", /Reviewed locally/);

    const endpoint = worker.snapshot().endpoint!;
    const unauthenticated = await fetch(`${endpoint.url}/home-fleet/v1/health`, { redirect: "error" });
    assert.equal(unauthenticated.status, 401);
    const unsupported = await fetch(`${endpoint.url}/home-fleet/v1/execute`, { redirect: "error" });
    assert.equal(unsupported.status, 401);

    await assert.rejects(
      () => worker.join(invitation),
      (error: unknown) => error instanceof HomeFleetError && (error.code === "AUTHENTICATION_FAILED" || error.code === "JOIN_TOKEN_INVALID"),
    );
  } finally {
    await Promise.allSettled([worker.close(), coordinator.close()]);
  }
});

test("registration acknowledgement waits for owner-local durable state work without exposing a storage error", async () => {
  let beginPersistence: (() => void) | undefined;
  let finishPersistence: (() => void) | undefined;
  const persistenceStarted = new Promise<void>(resolve => { beginPersistence = resolve; });
  const persistenceGate = new Promise<void>(resolve => { finishPersistence = resolve; });
  const coordinator = new HomeFleetCoordinator({
    onWorkerChanged: async () => {
      beginPersistence?.();
      await persistenceGate;
    },
  });
  const worker = new HomeFleetWorker({ label: "Durable Pair" });
  try {
    await coordinator.listen();
    await worker.listen();
    const joining = worker.join(coordinator.issueJoinInvitation());
    await persistenceStarted;
    let acknowledged = false;
    void joining.then(() => { acknowledged = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(acknowledged, false);

    finishPersistence?.();
    await joining;
    assert.equal(coordinator.snapshot().workers.length, 1);
  } finally {
    finishPersistence?.();
    await Promise.allSettled([worker.close(), coordinator.close()]);
  }
});

test("review fanout is bounded and unknown workers do not create a remote execution path", async () => {
  const coordinator = new HomeFleetCoordinator();
  const workerOne = new HomeFleetWorker({ label: "One", review: ({ text }) => ({ summary: `one:${text}` }) });
  const workerTwo = new HomeFleetWorker({ label: "Two", review: ({ text }) => ({ summary: `two:${text}` }) });
  try {
    await coordinator.listen();
    await workerOne.listen();
    await workerTwo.listen();
    await workerOne.join(coordinator.issueJoinInvitation());
    await workerTwo.join(coordinator.issueJoinInvitation());

    const results = await coordinator.reviewWorkers(
      [workerOne.workerId, "missing-worker", workerTwo.workerId],
      "Compare this idea without executing host commands.",
      { concurrency: 2 },
    );
    assert.deepEqual(results.map(result => result.status), ["ok", "rejected", "ok"]);
    assert.match(results[0]?.summary ?? "", /^one:/);
    assert.match(results[2]?.summary ?? "", /^two:/);
  } finally {
    await Promise.allSettled([workerOne.close(), workerTwo.close(), coordinator.close()]);
  }
});

test("private durable state excludes join tokens and supports owner-local restore/revocation", async () => {
  const coordinator = new HomeFleetCoordinator();
  const worker = new HomeFleetWorker({ label: "Persistent", review: ({ text }) => ({ summary: text }) });
  let restored: HomeFleetCoordinator | undefined;
  try {
    await coordinator.listen();
    await worker.listen();
    const invitation = coordinator.issueJoinInvitation();
    await worker.join(invitation);

    const coordinatorState = coordinator.exportPrivateState();
    const workerState = worker.exportPrivateState();
    assert.doesNotMatch(JSON.stringify(coordinatorState), new RegExp(invitation.joinToken));
    assert.doesNotMatch(JSON.stringify(workerState), new RegExp(invitation.joinToken));
    assert.equal(coordinatorState.workers[0]?.secret.length, 43);

    restored = HomeFleetCoordinator.fromPrivateState(coordinatorState);
    await restored.listen();
    const restoredHealth = await restored.inspectWorker(worker.workerId);
    assert.equal(restoredHealth.status, "healthy");

    const restoredWorker = HomeFleetWorker.fromPrivateState(
      { label: "Persistent", review: ({ text }) => ({ summary: text }) },
      workerState,
    );
    assert.equal(restoredWorker.snapshot().coordinatorId, coordinator.coordinatorId);
    assert.equal(restored.removeWorker(worker.workerId), true);
    assert.equal(restored.removeWorker(worker.workerId), false);
    assert.deepEqual((await restored.reviewWorkers([worker.workerId], "No worker remains.")).map(result => result.status), ["rejected"]);
  } finally {
    await Promise.allSettled([worker.close(), coordinator.close(), restored?.close()]);
  }
});

test("a restarted coordinator safely updates a worker's saved endpoint and worker heartbeat survives a temporary disconnect", async () => {
  const coordinator = new HomeFleetCoordinator();
  const worker = new HomeFleetWorker({ label: "Restartable", review: ({ text }) => ({ summary: text }) });
  let restored: HomeFleetCoordinator | undefined;
  try {
    await coordinator.listen();
    await worker.listen();
    await worker.join(coordinator.issueJoinInvitation());
    const state = coordinator.exportPrivateState();
    const oldCoordinatorPort = worker.exportPrivateState().coordinator?.endpoint.port;

    // A stopped coordinator does not make the worker forget credentials or
    // terminate its listener. It reports offline and can recover in place.
    await coordinator.close();
    assert.equal((await worker.heartbeat()).status, "unreachable");
    assert.equal(worker.snapshot().coordinatorId, state.coordinatorId);

    restored = HomeFleetCoordinator.fromPrivateState(state);
    const restoredEndpoint = await restored.listen();
    assert.notEqual(restoredEndpoint.port, oldCoordinatorPort);

    // The coordinator's first signed probe advertises its new endpoint. The
    // worker accepts that move only because its HMAC is valid and the declared
    // endpoint exactly matches the TCP source address.
    assert.equal((await restored.inspectWorker(worker.workerId)).status, "healthy");
    assert.equal(worker.exportPrivateState().coordinator?.endpoint.port, restoredEndpoint.port);
    assert.equal((await worker.heartbeat()).status, "ok");
  } finally {
    await Promise.allSettled([worker.close(), coordinator.close(), restored?.close()]);
  }
});

test("a worker rebinds its existing slot and a fresh invitation rekeys without duplicate capacity", async () => {
  const coordinator = new HomeFleetCoordinator({ maxWorkers: 1 });
  const original = new HomeFleetWorker({ label: "Movable", review: ({ text }) => ({ summary: text }) });
  let moved: HomeFleetWorker | undefined;
  let unpairedDuplicate: HomeFleetWorker | undefined;
  try {
    await coordinator.listen();
    await original.listen();
    await original.join(coordinator.issueJoinInvitation());
    const originalState = original.exportPrivateState();
    const originalEndpoint = original.snapshot().endpoint!;

    // A restart on a newly assigned listener port uses the retained secret to
    // update the record in place. It never creates a second fleet member.
    await original.close();
    moved = HomeFleetWorker.fromPrivateState(
      { label: "Movable", review: ({ text }) => ({ summary: text }) },
      originalState,
    );
    const movedEndpoint = await moved.listen();
    assert.notEqual(movedEndpoint.port, originalEndpoint.port);
    assert.equal((await moved.heartbeat()).status, "ok");
    assert.equal(coordinator.snapshot().workers.length, 1);
    assert.equal(coordinator.snapshot().workers[0]?.endpoint.port, movedEndpoint.port);
    assert.equal((await coordinator.inspectWorker(moved.workerId)).status, "healthy");

    // A one-time owner invitation plus the old derived secret rotates the
    // session atomically. A process without that prior secret cannot steal the
    // existing ID, and a brand-new ID cannot exceed the configured limit.
    const recoveryInvite = coordinator.issueJoinInvitation();
    await moved.join(recoveryInvite);
    assert.equal(coordinator.snapshot().workers.length, 1);
    assert.equal((await moved.heartbeat()).status, "ok");

    const rejectedInvite = coordinator.issueJoinInvitation();
    unpairedDuplicate = new HomeFleetWorker({ workerId: moved.workerId, label: "Imposter" });
    await unpairedDuplicate.listen();
    await assert.rejects(
      () => unpairedDuplicate!.join(rejectedInvite),
      (error: unknown) => error instanceof HomeFleetError && error.code === "WORKER_ALREADY_REGISTERED",
    );

    const newWorker = new HomeFleetWorker({ label: "Over limit" });
    await newWorker.listen();
    try {
      await assert.rejects(
        () => newWorker.join(rejectedInvite),
        (error: unknown) => error instanceof HomeFleetError && error.code === "WORKER_LIMIT_REACHED",
      );
    } finally {
      await newWorker.close();
    }
    assert.equal(coordinator.snapshot().workers.length, 1);
  } finally {
    await Promise.allSettled([original.close(), moved?.close(), unpairedDuplicate?.close(), coordinator.close()]);
  }
});
