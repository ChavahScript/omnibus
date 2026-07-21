import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TunnelIdentityStore } from "./tunnel-identity.js";

test("a workspace gets one private stable requested tunnel subdomain", async () => {
  const statePath = await mkdtemp(path.join(os.tmpdir(), "omnibus-tunnel-identity-"));
  try {
    const store = new TunnelIdentityStore(statePath);
    const first = await store.resolve();
    const second = await store.resolve();
    assert.match(first ?? "", /^omnibus-[a-z0-9]{16}$/);
    assert.equal(second, first);
    assert.equal((await stat(store.path)).mode & 0o777, 0o600);
    assert.match(await readFile(store.path, "utf8"), new RegExp(first!));
  } finally {
    await rm(statePath, { recursive: true, force: true });
  }
});

test("an explicit owner tunnel subdomain takes precedence over stored identity", async () => {
  const statePath = await mkdtemp(path.join(os.tmpdir(), "omnibus-tunnel-identity-"));
  try {
    const store = new TunnelIdentityStore(statePath);
    assert.equal(await store.resolve("My-Bridge"), "my-bridge");
  } finally {
    await rm(statePath, { recursive: true, force: true });
  }
});
