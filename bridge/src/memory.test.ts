import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SerializableAgentMemory } from "./memory.js";

test("private memory context never crosses paired-device scopes", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "omnibus-memory-test-"));
  try {
    const memory = new SerializableAgentMemory(stateDir);
    await memory.append("11111111-1111-4111-8111-111111111111", "developer", "result", "Private result for phone A", "device-a");
    await memory.append("22222222-2222-4222-8222-222222222222", "developer", "result", "Private result for phone B", "device-b");
    await memory.append("33333333-3333-4333-8333-333333333333", "system", "directive", "Raw directive should not become context", "device-a");

    const context = await memory.contextualRecent("device-a", "00000000-0000-4000-8000-000000000000");
    assert.deepEqual(context.map(entry => entry.value), ["Private result for phone A"]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
