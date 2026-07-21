import assert from "node:assert/strict";
import test from "node:test";
import type { BridgeEvent } from "./contracts.js";
import { DeviceEventReplay } from "./device-event-replay.js";

const correlationA = "11111111-1111-4111-8111-111111111111";
const correlationB = "22222222-2222-4222-8222-222222222222";

function status(correlationId: string, text: string): BridgeEvent {
  return { type: "status", correlationId, agent: "auditor", stage: "audit", text };
}

test("a resumed device receives its bounded own progress and result, never another device's", () => {
  const replay = new DeviceEventReplay();
  const liveA: BridgeEvent[] = [];
  const liveB: BridgeEvent[] = [];
  const firstA = replay.bind("device-a", event => liveA.push(event), false);
  const firstB = replay.bind("device-b", event => liveB.push(event), false);

  replay.emit("device-a", status(correlationA, "Auditor is working locally."));
  replay.emit("device-b", status(correlationB, "This belongs only to B."));
  firstA.detach();
  replay.emit("device-a", {
    type: "result",
    correlationId: correlationA,
    agent: "developer",
    summary: "A private local report completed while the phone changed networks.",
  });

  const resumedA = replay.bind("device-a", () => undefined, true);
  assert.equal(resumedA.replay.recovered, true);
  assert.deepEqual(resumedA.replay.events.map(event => event.type), ["status", "result"]);
  assert.ok(resumedA.replay.events.every(event => "correlationId" in event && event.correlationId === correlationA));
  assert.equal(liveA.length, 1);
  assert.equal(liveB.length, 1);
  assert.equal(liveB[0]?.type, "status");
  assert.equal((liveB[0] as Extract<BridgeEvent, { type: "status" }>).text, "This belongs only to B.");
});

test("one-time invitations, connection frames, and pongs are delivered live but never journaled", () => {
  const replay = new DeviceEventReplay();
  const live: BridgeEvent[] = [];
  const first = replay.bind("device-a", event => live.push(event), false);
  replay.emit("device-a", { type: "pong", sentAt: 42 });
  replay.emit("device-a", {
    type: "home_fleet_invite",
    invite: {
      correlationId: correlationA,
      command: "omnibus-bridge worker --invite contains-a-one-time-secret",
      expiresAt: "2026-07-18T12:00:00.000Z",
    },
  });
  first.detach();

  const resumed = replay.bind("device-a", () => undefined, true);
  assert.equal(live.length, 2);
  assert.equal(resumed.replay.recovered, true);
  assert.deepEqual(resumed.replay.events, []);
});

test("the journal is bounded, expires while detached, and an old socket cannot detach its replacement", () => {
  let now = 10_000;
  const replay = new DeviceEventReplay({ now: () => now, maxEventsPerDevice: 2, ttlMs: 1_000 });
  const original = replay.bind("device-a", () => undefined, false);
  replay.emit("device-a", status(correlationA, "one"));
  replay.emit("device-a", status(correlationA, "two"));
  replay.emit("device-a", status(correlationA, "three"));

  // A resume which races a delayed old close becomes authoritative; the old
  // close must not turn the replacement into a disconnected journal target.
  const replacement = replay.bind("device-a", () => undefined, true);
  assert.equal(original.isCurrent(), false);
  assert.equal(replacement.isCurrent(), true);
  original.detach();
  replay.emit("device-a", status(correlationA, "four"));
  replacement.detach();

  const afterGap = replay.bind("device-a", () => undefined, true);
  assert.deepEqual(afterGap.replay.events.map(event => event.type === "status" ? event.text : "unexpected"), ["three", "four"]);
  afterGap.detach();
  now += 1_001;
  const expired = replay.bind("device-a", () => undefined, true);
  assert.equal(expired.replay.recovered, false);
  assert.deepEqual(expired.replay.events, []);
});
