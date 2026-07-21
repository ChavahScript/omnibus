import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

test("a corrupt memory file is quarantined and reads continue as if it never existed", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "omnibus-memory-test-"));
  try {
    await writeFile(path.join(stateDir, "agent-memory.json"), "{ definitely not json", "utf8");
    const memory = new SerializableAgentMemory(stateDir);

    assert.deepEqual(await memory.recent("11111111-1111-4111-8111-111111111111"), []);
    await memory.append("11111111-1111-4111-8111-111111111111", "developer", "result", "Fresh result after recovery", "device-a");
    const context = await memory.contextualRecent("device-a", "00000000-0000-4000-8000-000000000000");
    assert.deepEqual(context.map(entry => entry.value), ["Fresh result after recovery"]);

    const entries = await readdir(stateDir);
    assert.ok(
      entries.some(name => name.startsWith("agent-memory.json.corrupt-")),
      `expected a quarantined corrupt file, saw: ${entries.join(", ")}`,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("schema-invalid memory JSON is also quarantined rather than rethrown", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "omnibus-memory-test-"));
  try {
    await writeFile(path.join(stateDir, "agent-memory.json"), JSON.stringify({ version: 99, nonsense: true }), "utf8");
    const memory = new SerializableAgentMemory(stateDir);
    assert.deepEqual(await memory.recent("22222222-2222-4222-8222-222222222222"), []);
    const entries = await readdir(stateDir);
    assert.ok(entries.some(name => name.startsWith("agent-memory.json.corrupt-")));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
