import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AuditTrail } from "../audit.js";
import type { AppConfig } from "../config.js";
import type { BridgeEvent, ClientCommand } from "../contracts.js";
import type { SerializableAgentMemory } from "../memory.js";
import type { UsageLedger } from "../usage.js";
import { CommandOrchestrator } from "./orchestrator.js";

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

function orchestratorConfig(statePath: string): AppConfig {
  return {
    statePath,
    queueMaxPending: 4,
    queueMaxAttempts: 1,
    queueRetryBaseMs: 250,
  } as AppConfig;
}

const auditStub = { append: async () => undefined } as unknown as AuditTrail;
const usageStub = {} as UsageLedger;

function workingMemoryStub(): SerializableAgentMemory {
  return {
    append: async () => undefined,
    recent: async () => [],
    contextualRecent: async () => [],
  } as unknown as SerializableAgentMemory;
}

test("an unavailable queue store reports a neutral message, never raw parse or filesystem text", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omnibus-orchestrator-test-"));
  try {
    // statePath points at a regular file, so every durable read fails with a
    // real I/O error (ENOTDIR) rather than a quarantinable corrupt file.
    const bogusStatePath = path.join(dir, "not-a-directory");
    await writeFile(bogusStatePath, "plain file blocking the state dir", "utf8");
    const orchestrator = new CommandOrchestrator(orchestratorConfig(bogusStatePath), auditStub, workingMemoryStub(), usageStub);
    const events: BridgeEvent[] = [];
    await orchestrator.execute(command("11111111-1111-4111-8111-111111111111"), event => events.push(event));
    orchestrator.stop();

    const error = events.find(event => event.type === "error");
    assert.ok(error && error.type === "error");
    assert.equal(error.code, "QUEUE_UNAVAILABLE");
    assert.equal(error.message, "The local queue storage is unavailable. Check the bridge terminal.");
    assert.ok(!error.message.includes("ENOTDIR"));
    assert.ok(!error.message.includes(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the phone always receives the terminal error frame even when memory writes throw, and busy clears first", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "omnibus-orchestrator-test-"));
  try {
    const throwingMemory = {
      append: async () => {
        throw new Error("memory volume detached");
      },
      recent: async () => [],
      contextualRecent: async () => [],
    } as unknown as SerializableAgentMemory;
    const orchestrator = new CommandOrchestrator(orchestratorConfig(stateDir), auditStub, throwingMemory, usageStub);

    const events: BridgeEvent[] = [];
    let busyAtErrorFrame: boolean | undefined;
    let resolveTerminal: () => void = () => undefined;
    const terminalFrame = new Promise<void>(resolve => {
      resolveTerminal = resolve;
    });
    await orchestrator.execute(command("22222222-2222-4222-8222-222222222222"), event => {
      events.push(event);
      if (event.type === "error") {
        busyAtErrorFrame = orchestrator.isBusy;
        resolveTerminal();
      }
    });
    await terminalFrame;
    orchestrator.stop();

    const error = events.find(event => event.type === "error");
    assert.ok(error && error.type === "error", "the failure notice must reach the phone despite broken memory");
    assert.equal(error.code, "COMMAND_FAILED");
    assert.match(error.message, /memory volume detached/);
    // The fleet-provisioning gate is released before the terminal frame, so a
    // follow-up fleet_provision sent on receipt is not refused as busy.
    assert.equal(busyAtErrorFrame, false);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
