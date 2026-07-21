import assert from "node:assert/strict";
import test from "node:test";
import {
  ClientMessageSchema,
  classifyClientMessageRejection,
  isReplayableBridgeEvent,
  salvageCorrelationId,
  type BridgeEvent,
} from "./contracts.js";

const correlationId = "11111111-1111-4111-8111-111111111111";

test("fleet provisioning protocol accepts only named local profiles", () => {
  const valid = ClientMessageSchema.safeParse({ type: "fleet_provision", correlationId, profileId: "balanced" });
  assert.equal(valid.success, true);

  const arbitraryModel = ClientMessageSchema.safeParse({
    type: "fleet_provision",
    correlationId,
    profileId: "llama.cpp --model /private/secret.gguf",
  });
  assert.equal(arbitraryModel.success, false);
});

test("research configuration bounds an optional paired key and has no general environment-message form", () => {
  assert.equal(ClientMessageSchema.safeParse({
    type: "research_configure",
    correlationId,
    enabled: true,
    braveSearchApiKey: "paired-provider-key",
  }).success, true);
  assert.equal(ClientMessageSchema.safeParse({
    type: "research_configure",
    correlationId,
    enabled: true,
    braveSearchApiKey: "short",
  }).success, false);
  assert.equal(ClientMessageSchema.safeParse({
    type: "set_environment",
    name: "WEB_RESEARCH_ENABLED",
    value: "true",
  }).success, false);
});

test("home fleet controls accept only fixed invitation, approval, and revoke shapes", () => {
  assert.equal(ClientMessageSchema.safeParse({ type: "home_fleet_invite", correlationId }).success, true);
  assert.equal(ClientMessageSchema.safeParse({ type: "home_fleet_approve", correlationId, workerId: "22222222-2222-4222-8222-222222222222" }).success, true);
  assert.equal(ClientMessageSchema.safeParse({ type: "home_fleet_remove", correlationId, workerId: "22222222-2222-4222-8222-222222222222" }).success, true);
  const inviteWithEndpoint = ClientMessageSchema.parse({ type: "home_fleet_invite", correlationId, endpoint: "https://public.example" });
  assert.equal(inviteWithEndpoint.type, "home_fleet_invite");
  assert.equal("endpoint" in inviteWithEndpoint, false);
  assert.equal(ClientMessageSchema.safeParse({ type: "home_fleet_remove", correlationId, workerId: "not-a-worker" }).success, false);
});

test("command defaults keep older clients local-only for home fleet", () => {
  const parsed = ClientMessageSchema.parse({
    type: "command",
    correlationId,
    directive: "Shape an owner-approved local product idea.",
    mode: "plan",
  });
  if (parsed.type !== "command") return assert.fail("expected a command");
  assert.equal(parsed.homeFleet, false);
});

test("only display-only paired events are eligible for a transient device replay", () => {
  const status: BridgeEvent = {
    type: "status",
    correlationId,
    agent: "auditor",
    stage: "audit",
    text: "Local audit is in progress.",
  };
  const invitation: BridgeEvent = {
    type: "home_fleet_invite",
    invite: {
      correlationId,
      command: "omnibus-bridge worker --invite one-time-secret",
      expiresAt: "2026-07-18T12:00:00.000Z",
    },
  };
  assert.equal(isReplayableBridgeEvent(status), true);
  assert.equal(isReplayableBridgeEvent(invitation), false);
  assert.equal(isReplayableBridgeEvent({ type: "pong", sentAt: 1 }), false);
});

test("only command-scoped errors are replayable; context-free protocol errors never become phantom toasts", () => {
  assert.equal(isReplayableBridgeEvent({ type: "error", correlationId, code: "LOCAL_TEAM_BUSY", message: "The local team is finishing an idea." }), true);
  assert.equal(isReplayableBridgeEvent({ type: "error", code: "INVALID_MESSAGE", message: "Invalid dashboard message." }), false);
  assert.equal(isReplayableBridgeEvent({ type: "error", correlationId: "", code: "INVALID_MESSAGE", message: "Invalid dashboard message." }), false);
});

test("directive length rejections get humane, distinct codes with the salvaged correlation id", () => {
  const short = ClientMessageSchema.safeParse({ type: "command", correlationId, directive: "  x  " });
  assert.equal(short.success, false);
  if (short.success) return assert.fail("expected a rejection");
  assert.deepEqual(classifyClientMessageRejection({ type: "command", correlationId, directive: "  x  " }, short.error), {
    code: "IDEA_TOO_SHORT",
    message: "Your idea needs at least 3 characters.",
    correlationId,
  });

  const longFrame = { type: "command", correlationId, directive: "à".repeat(12_001) };
  const long = ClientMessageSchema.safeParse(longFrame);
  assert.equal(long.success, false);
  if (long.success) return assert.fail("expected a rejection");
  const classified = classifyClientMessageRejection(longFrame, long.error);
  assert.equal(classified.code, "IDEA_TOO_LONG");
  assert.equal(classified.message, "Your idea is too long (max 12,000 characters). Split it into two ideas.");
  assert.equal(classified.correlationId, correlationId);
});

test("unknown message types and other schema failures classify as INVALID_MESSAGE without echoing zod internals", () => {
  const unknownFrame = { type: "set_environment", correlationId, name: "X", value: "1" };
  const unknown = ClientMessageSchema.safeParse(unknownFrame);
  assert.equal(unknown.success, false);
  if (unknown.success) return assert.fail("expected a rejection");
  const unknownClassified = classifyClientMessageRejection(unknownFrame, unknown.error);
  assert.equal(unknownClassified.code, "INVALID_MESSAGE");
  assert.equal(unknownClassified.correlationId, correlationId);
  assert.match(unknownClassified.message, /doesn't recognize that message type/);

  const otherFrame = { type: "fleet_provision", correlationId, profileId: "not-a-profile" };
  const other = ClientMessageSchema.safeParse(otherFrame);
  assert.equal(other.success, false);
  if (other.success) return assert.fail("expected a rejection");
  const otherClassified = classifyClientMessageRejection(otherFrame, other.error);
  assert.equal(otherClassified.code, "INVALID_MESSAGE");
  assert.equal(otherClassified.correlationId, correlationId);
});

test("correlation id salvage only echoes bounded UUID-shaped strings back to the phone", () => {
  assert.equal(salvageCorrelationId({ correlationId }), correlationId);
  assert.equal(salvageCorrelationId({ correlationId: "<script>alert(1)</script>" }), undefined);
  assert.equal(salvageCorrelationId({ correlationId: "x".repeat(65) }), undefined);
  assert.equal(salvageCorrelationId({ correlationId: 7 }), undefined);
  assert.equal(salvageCorrelationId("not-an-object"), undefined);
  assert.equal(salvageCorrelationId(null), undefined);
});
