import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IDEA_MAX_CHARS,
  IDEA_MIN_CHARS,
  acceptsRecoveredBrief,
  isHomeFleetInviteStale,
  isIdeaTerminalFailure,
  localIdeaIssue,
} from "./types";
import type { DashboardMessage, HomeFleetSnapshot } from "./types";

function message(overrides: Partial<DashboardMessage>): DashboardMessage {
  return {
    id: "m-1",
    agent: "system",
    stage: "status",
    text: "",
    at: new Date("2026-07-21T10:00:00Z"),
    ...overrides,
  };
}

function homeFleet(overrides: Partial<HomeFleetSnapshot>): HomeFleetSnapshot {
  return { available: true, workerLimit: 3, workers: [], ...overrides };
}

const worker = (id: string): HomeFleetSnapshot["workers"][number] => ({
  id,
  label: id,
  status: "online",
  modelReady: true,
  approved: true,
});

test("localIdeaIssue mirrors the bridge minimum so a 1-2 char idea never enters shaping", () => {
  assert.equal(localIdeaIssue("ab"), "Give the idea at least 3 characters.");
  assert.equal(localIdeaIssue("a"), "Give the idea at least 3 characters.");
  assert.equal(localIdeaIssue("abc"), null);
  assert.equal(IDEA_MIN_CHARS, 3);
});

test("localIdeaIssue mirrors the bridge maximum so an oversized idea never enters shaping", () => {
  assert.equal(localIdeaIssue("x".repeat(IDEA_MAX_CHARS)), null);
  assert.equal(
    localIdeaIssue("x".repeat(IDEA_MAX_CHARS + 1)),
    "Ideas are limited to 12,000 characters — split this one.",
  );
  assert.equal(IDEA_MAX_CHARS, 12_000);
});

test("any error event for the active idea is terminal, without a stage allowlist", () => {
  const codes = [
    "FLEET_PROVISIONING",
    "COMMAND_QUEUE_FULL",
    "QUEUE_UNAVAILABLE",
    "DUPLICATE_COMMAND",
    "IDEA_TOO_LONG",
    "IDEA_TOO_SHORT",
    "COMMAND_FAILED",
    "SOME_FUTURE_CODE",
  ];
  for (const code of codes) {
    const failure = message({ stage: code, correlationId: "c-1", origin: "error" });
    assert.equal(isIdeaTerminalFailure(failure, "c-1"), true, code);
  }
});

test("errors for another idea and non-error feed entries never fail the active idea", () => {
  assert.equal(isIdeaTerminalFailure(message({ stage: "COMMAND_FAILED", correlationId: "c-2", origin: "error" }), "c-1"), false);
  assert.equal(isIdeaTerminalFailure(message({ stage: "COMMAND_FAILED", origin: "error" }), "c-1"), false);
  assert.equal(isIdeaTerminalFailure(message({ stage: "audit", correlationId: "c-1" }), "c-1"), false);
});

test("a replayed brief is accepted in the failed phase, upgrading the card", () => {
  assert.equal(acceptsRecoveredBrief("shaping"), true);
  assert.equal(acceptsRecoveredBrief("failed"), true);
  assert.equal(acceptsRecoveredBrief("idle"), false);
  assert.equal(acceptsRecoveredBrief("ready"), false);
});

test("the invite card clears once a home laptop has joined with it", () => {
  const tracking = { workerCountAtCreation: 1, inviteSeenInSnapshot: false };
  const joined = homeFleet({ workers: [worker("a"), worker("b")], activeInviteExpiresAt: "2026-07-21T10:05:00Z" });
  assert.equal(isHomeFleetInviteStale(tracking, joined), true);
});

test("the invite card clears when its expiry window disappears from a snapshot", () => {
  const seen = { workerCountAtCreation: 1, inviteSeenInSnapshot: true };
  assert.equal(isHomeFleetInviteStale(seen, homeFleet({ workers: [worker("a")] })), true);
  assert.equal(isHomeFleetInviteStale(seen, homeFleet({ workers: [worker("a")], activeInviteExpiresAt: "2026-07-21T10:05:00Z" })), false);
});

test("a snapshot generated before the invite existed cannot clear a fresh invite", () => {
  const unseen = { workerCountAtCreation: 1, inviteSeenInSnapshot: false };
  assert.equal(isHomeFleetInviteStale(unseen, homeFleet({ workers: [worker("a")] })), false);
});
