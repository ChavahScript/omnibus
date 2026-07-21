import assert from "node:assert/strict";
import test from "node:test";
import { PairingResumptionStore, PairingToken, assertWorkspacePath } from "./security.js";

test("pairing token permits exactly one successful handshake", () => {
  const pairing = new PairingToken();
  const payload = JSON.parse(pairing.qrPayload("https://bridge.example")) as { token: string };
  assert.equal(pairing.verify(payload.token), true);
  assert.equal(pairing.verify(payload.token), false);
  assert.equal(pairing.verify("invalid"), false);
  assert.throws(() => pairing.qrPayload("https://bridge.example"), /already been printed/);
});

test("rotating a pairing token invalidates every previously printed QR secret", () => {
  const pairing = new PairingToken();
  const first = JSON.parse(pairing.qrPayload("https://bridge.example")) as { token: string };

  assert.throws(() => pairing.qrPayload("https://bridge.example"), /already been printed/);
  pairing.rotate();
  const second = JSON.parse(pairing.qrPayload("https://bridge.example")) as { token: string };

  assert.notEqual(second.token, first.token);
  assert.equal(pairing.verify(first.token), false);
  assert.equal(pairing.verify(second.token), true);
  assert.equal(pairing.verify(second.token), false);
});

test("resumption secrets are memory-only, bounded, and retain only a short lost-hello grace", () => {
  let now = 1_000;
  const sessions = new PairingResumptionStore({ now: () => now, ttlMs: 60_000, deliveryGraceMs: 10_000 });
  const first = sessions.issue("device-a");
  assert.equal(sessions.consume(first), "device-a");
  // The bridge may have sent a new secret just as iOS changed networks. The
  // same old header can recover that lost hello for one very short window.
  assert.equal(sessions.consume(first), "device-a");
  now += 10_001;
  assert.equal(sessions.consume(first), undefined);

  const expired = sessions.issue("device-b");
  now += 60_001;
  assert.equal(sessions.consume(expired), undefined);

  const cleared = sessions.issue("device-c");
  sessions.clear();
  assert.equal(sessions.consume(cleared), undefined);
});

test("workspace paths cannot escape the configured root", () => {
  assert.equal(assertWorkspacePath("/project", "src/index.ts"), "/project/src/index.ts");
  assert.throws(() => assertWorkspacePath("/project", "../secret"), /escapes/);
});
