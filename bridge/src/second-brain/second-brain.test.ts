import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AuditTrail } from "../audit.js";
import { loadConfig } from "../config.js";
import { SecondBrain } from "./second-brain.js";

const GIB = 1024 ** 3;

async function brainIn(root: string, provider: "ollama" | "codex-cli" | "responses"): Promise<SecondBrain> {
  const config = loadConfig({
    cwd: root,
    env: {
      DEVELOPER_PROVIDER: provider,
      // A dead loopback port: every LLM path must fall back to heuristics so
      // the test needs no Ollama and stays deterministic.
      OLLAMA_BASE_URL: "http://127.0.0.1:65500",
      ...(provider === "responses" ? { OPENAI_API_KEY: "test-key-not-real-1234" } : {}),
    },
    totalMemoryBytes: 16 * GIB,
  });
  const brain = new SecondBrain(config, new AuditTrail(config.auditPath));
  await brain.start();
  // Seed one remembered decision so recall has something to return. The
  // CamelCase token is what the heuristic entity extractor keys on when the
  // LLM is unavailable, so the query below can match this node deterministically.
  await brain.twin.recordDecision({
    title: "ReportsExport stays offline-first",
    rationale: "ReportsExport must work with no network by design.",
    origin: { channel: "manual", detail: "test-seed" },
  });
  return brain;
}

test("Second Brain recall reaches local executors (ollama, codex) and is withheld from the cloud route", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omnibus-brain-boundary-"));
  try {
    const query = "revisit ReportsExport for the export screen";

    // Cloud Responses: withheld regardless of graph content.
    const cloud = await brainIn(path.join(root, "cloud"), "responses");
    assert.equal(await cloud.enrichIdea("11111111-1111-4111-8111-111111111111", query), undefined);
    await cloud.stop();

    // Local Ollama: the gate is open, so seeded knowledge is recalled.
    const local = await brainIn(path.join(root, "ollama"), "ollama");
    const ollamaContext = await local.enrichIdea("22222222-2222-4222-8222-222222222222", query);
    assert.ok(ollamaContext && ollamaContext.length > 0, "loopback Ollama route should receive recall");
    await local.stop();

    // On-host Codex is a LOCAL executor too — it already reads the workspace
    // this knowledge was distilled from, so the same recall reaches it.
    const codex = await brainIn(path.join(root, "codex"), "codex-cli");
    const codexContext = await codex.enrichIdea("33333333-3333-4333-8333-333333333333", query);
    assert.ok(codexContext && codexContext.length > 0, "on-host Codex route should receive recall");
    await codex.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("executionGuardrails compiles decisions and anti-patterns for Codex, empty on a cold brain", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omnibus-guardrails-"));
  try {
    const brain = await brainIn(path.join(root, "codex"), "codex-cli");
    const guardrails = await brain.executionGuardrails("touch the ReportsExport path");
    assert.ok(guardrails, "a brain with a seeded decision and default anti-patterns should produce guardrails");
    assert.match(guardrails!, /Project guardrails recorded by the owner's Second Brain/);
    // The seeded anti-pattern registry always contributes its digest.
    assert.match(guardrails!, /anti-pattern/i);
    await brain.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
