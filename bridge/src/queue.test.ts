import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ClientCommand } from "./contracts.js";
import { DurableCommandQueue } from "./queue.js";

function command(correlationId: string): ClientCommand {
  return {
    type: "command",
    correlationId,
    directive: "Turn the safe queue into a reliable local workflow.",
    mode: "plan",
    research: false,
    homeFleet: false,
  };
}

test("durable queue persists retries, applies a bounded backoff, and retains terminal metadata", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "omnibus-queue-test-"));
  let now = new Date("2026-07-17T12:00:00.000Z");
  const options = {
    maxPending: 2,
    maxAttempts: 2,
    retryBaseMs: 250,
    now: () => now,
  };
  try {
    const queue = new DurableCommandQueue(stateDir, options);
    const enqueued = await queue.enqueue(command("11111111-1111-4111-8111-111111111111"));
    assert.equal(enqueued.accepted, true);
    if (!enqueued.accepted) return assert.fail("command should fit in an empty queue");
    assert.equal(enqueued.position, 1);

    const firstAttempt = await queue.claimNext();
    assert.equal(firstAttempt?.attempts, 1);
    const retry = await queue.fail(firstAttempt!.id, "temporary Ollama failure");
    assert.equal(retry.retry, true);
    if (!retry.retry) return assert.fail("the first failure should be retryable");
    assert.equal(retry.delayMs, 250);
    assert.equal(await queue.claimNext(), null);

    now = new Date(now.getTime() + retry.delayMs);
    const secondAttempt = await queue.claimNext();
    assert.equal(secondAttempt?.attempts, 2);
    const terminal = await queue.fail(secondAttempt!.id, "Ollama remained unavailable");
    assert.equal(terminal.retry, false);

    const reloaded = new DurableCommandQueue(stateDir, options);
    const snapshot = await reloaded.snapshot();
    assert.equal(snapshot.jobs.length, 1);
    assert.equal(snapshot.jobs[0]?.status, "failed");
    assert.equal(snapshot.jobs[0]?.attempts, 2);
    assert.match(snapshot.jobs[0]?.lastError ?? "", /Ollama remained unavailable/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a running job is recovered as a bounded retry after a bridge restart", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "omnibus-queue-test-"));
  const now = new Date("2026-07-17T12:00:00.000Z");
  const options = { maxPending: 1, maxAttempts: 3, retryBaseMs: 250, now: () => now };
  try {
    const original = new DurableCommandQueue(stateDir, options);
    const enqueued = await original.enqueue(command("22222222-2222-4222-8222-222222222222"));
    assert.equal(enqueued.accepted, true);
    await original.claimNext();

    const restarted = new DurableCommandQueue(stateDir, options);
    const recovered = await restarted.snapshot();
    assert.equal(recovered.jobs[0]?.status, "retrying");
    assert.equal(recovered.jobs[0]?.nextAttemptAt, now.toISOString());
    assert.match(recovered.jobs[0]?.lastError ?? "", /restarted/i);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("queue capacity only counts commands that can still run", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "omnibus-queue-test-"));
  const options = { maxPending: 1, maxAttempts: 1, retryBaseMs: 250 };
  try {
    const queue = new DurableCommandQueue(stateDir, options);
    const first = await queue.enqueue(command("33333333-3333-4333-8333-333333333333"));
    assert.equal(first.accepted, true);
    const second = await queue.enqueue(command("44444444-4444-4444-8444-444444444444"));
    assert.deepEqual(second, { accepted: false, reason: "QUEUE_FULL", pending: 1 });

    const claimed = await queue.claimNext();
    await queue.fail(claimed!.id, "terminal failure");
    const afterFailure = await queue.enqueue(command("55555555-5555-4555-8555-555555555555"));
    assert.equal(afterFailure.accepted, true);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("an orphaned recovered command can be retained as failed history without replaying it", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "omnibus-queue-test-"));
  const options = { maxPending: 1, maxAttempts: 3, retryBaseMs: 250 };
  try {
    const queue = new DurableCommandQueue(stateDir, options);
    const enqueued = await queue.enqueue(command("66666666-6666-4666-8666-666666666666"), "paired-device-a");
    assert.equal(enqueued.accepted, true);
    const claimed = await queue.claimNext();
    assert.equal(claimed?.ownerScope, "paired-device-a");
    const abandoned = await queue.abandon(claimed!.id, "Bridge restarted; user must confirm again.");
    assert.equal(abandoned?.status, "failed");
    assert.match(abandoned?.lastError ?? "", /confirm again/i);
    assert.equal(await queue.nextReadyDelayMs(), null);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
