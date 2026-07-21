import assert from "node:assert/strict";
import test from "node:test";
import { ClientMessageSchema, isReplayableBridgeEvent, type BridgeEvent } from "./contracts.js";

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
