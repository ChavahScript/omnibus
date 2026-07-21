import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";

test("a fresh bridge configuration uses local Ollama for both agents", () => {
  const keys = [
    "DEVELOPER_PROVIDER",
    "OPENAI_API_KEY",
    "HOST_EXECUTION_ENABLED",
    "OLLAMA_MODEL",
    "OLLAMA_DEVELOPER_MODEL",
  ] as const;
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    const config = loadConfig();
    assert.equal(config.developerProvider, "ollama");
    assert.equal(config.ollamaDeveloperModel, config.ollamaModel);
    assert.equal(config.hostExecutionEnabled, false);
    assert.equal(config.keepAwakeEnabled, true);
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("sleep inhibition can be disabled explicitly for battery-sensitive use", () => {
  const config = loadConfig({ cwd: "/tmp/omnibus-owner-workspace", env: { OMNIBUS_KEEP_AWAKE: "false" } });
  assert.equal(config.keepAwakeEnabled, false);
});

test("an empty tunnel subdomain permits the bridge to create its stable workspace identity", () => {
  const config = loadConfig({ cwd: "/tmp/omnibus-owner-workspace", env: { TUNNEL_SUBDOMAIN: "" } });
  assert.equal(config.tunnelSubdomain, undefined);
});

test("unqualified bridge paths resolve from the owner workspace", () => {
  const config = loadConfig({ cwd: "/tmp/omnibus-owner-workspace", env: {} });
  assert.equal(config.workspacePath, "/tmp/omnibus-owner-workspace");
  assert.equal(config.auditPath, "/tmp/omnibus-owner-workspace/.omnibus/audit");
  assert.equal(config.statePath, "/tmp/omnibus-owner-workspace/.omnibus/state");
});

test("an optional Ollama model storage path is resolved locally", () => {
  const config = loadConfig({
    cwd: "/tmp/omnibus-owner-workspace",
    env: { OLLAMA_MODELS: ".local-models" },
  });
  assert.equal(config.ollamaModelsPath, "/tmp/omnibus-owner-workspace/.local-models");
});

test("web research remains opt-in and can finish configuration from paired private settings", () => {
  const localOnly = loadConfig({ cwd: "/tmp/omnibus-owner-workspace", env: {} });
  assert.equal(localOnly.webResearchEnabled, false);
  assert.equal(localOnly.braveSearchApiKey, undefined);

  const pendingPairedKey = loadConfig({ cwd: "/tmp/omnibus-owner-workspace", env: { WEB_RESEARCH_ENABLED: "true" } });
  assert.equal(pendingPairedKey.webResearchEnabled, true);
  assert.equal(pendingPairedKey.braveSearchApiKey, undefined);

  const configured = loadConfig({
    cwd: "/tmp/omnibus-owner-workspace",
    env: {
      WEB_RESEARCH_ENABLED: "true",
      BRAVE_SEARCH_API_KEY: "test-key-stays-laptop-side",
      WEB_RESEARCH_MAX_RESULTS: "4",
      WEB_RESEARCH_QUERY_MAX_CHARS: "240",
    },
  });
  assert.equal(configured.webResearchEnabled, true);
  assert.equal(configured.webResearchProvider, "brave");
  assert.equal(configured.webResearchMaxResults, 4);
  assert.equal(configured.webResearchQueryMaxChars, 240);
});

test("capacity knobs adapt to the laptop's memory unless the owner set them explicitly", () => {
  const GIB = 1024 ** 3;
  const compact = loadConfig({ cwd: "/tmp/omnibus-owner-workspace", env: {}, totalMemoryBytes: 8 * GIB });
  assert.equal(compact.brainCapacityTier, "compact");
  assert.equal(compact.ollamaNumCtx, 8_192);
  assert.equal(compact.brainMaxFacts, 4_000);
  assert.equal(compact.homeFleetWorkerKeepAlive, "2m");
  assert.equal(compact.ambientGitPollMs, 90_000);

  const balanced = loadConfig({ cwd: "/tmp/omnibus-owner-workspace", env: {}, totalMemoryBytes: 16 * GIB });
  assert.equal(balanced.brainCapacityTier, "balanced");
  assert.equal(balanced.ollamaNumCtx, 16_384);
  assert.equal(balanced.brainMaxNodes, 3_000);

  const studio = loadConfig({ cwd: "/tmp/omnibus-owner-workspace", env: {}, totalMemoryBytes: 64 * GIB });
  assert.equal(studio.brainCapacityTier, "studio");
  assert.equal(studio.brainMaxFacts, 24_000);
  assert.equal(studio.brainRetrievalTopK, 16);

  // An explicit owner value always beats the adaptive default, on any tier.
  const pinned = loadConfig({
    cwd: "/tmp/omnibus-owner-workspace",
    env: { OLLAMA_NUM_CTX: "32768", OMNIBUS_BRAIN_MAX_FACTS: "12000" },
    totalMemoryBytes: 8 * GIB,
  });
  assert.equal(pinned.brainCapacityTier, "compact");
  assert.equal(pinned.ollamaNumCtx, 32_768);
  assert.equal(pinned.brainMaxFacts, 12_000);
  // Untouched knobs still adapt.
  assert.equal(pinned.brainMaxNodes, 1_500);
});

test("configuration errors speak in ENV VAR names with plain-word constraints", () => {
  assert.throws(
    () => loadConfig({ cwd: "/tmp/omnibus-owner-workspace", env: { OMNIBUS_BRAIN_MAX_NODES: "abc" } }),
    (error: unknown) =>
      error instanceof Error
      && /OMNIBUS_BRAIN_MAX_NODES=abc is not a number \(allowed 100–50000\)/.test(error.message)
      && !error.message.includes("brainMaxNodes")
      && !error.message.includes('"code"'),
  );
  assert.throws(
    () => loadConfig({ cwd: "/tmp/omnibus-owner-workspace", env: { OMNIBUS_OLLAMA_KEEP_ALIVE: "soon" } }),
    /OMNIBUS_OLLAMA_KEEP_ALIVE=soon must look like 5m, 30s, 0 or -1/,
  );
});

test("each invalid setting gets its own actionable line", () => {
  assert.throws(
    () => loadConfig({
      cwd: "/tmp/omnibus-owner-workspace",
      env: {
        OMNIBUS_BRAIN_MAX_NODES: "abc",
        OLLAMA_NUM_CTX: "100",
        HOST_EXECUTION_ENABLED: "yes",
        OLLAMA_BASE_URL: "nonsense",
        HOME_FLEET_WORKER_KEEP_ALIVE: "forever",
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Bridge configuration is invalid:/);
      assert.match(error.message, /OMNIBUS_BRAIN_MAX_NODES=abc is not a number \(allowed 100–50000\)/);
      assert.match(error.message, /OLLAMA_NUM_CTX=100 is out of range \(allowed 4096–131072\)/);
      assert.match(error.message, /HOST_EXECUTION_ENABLED=yes must be true or false/);
      assert.match(error.message, /OLLAMA_BASE_URL=nonsense must be a full URL such as http:\/\/127\.0\.0\.1:11434/);
      assert.match(error.message, /HOME_FLEET_WORKER_KEEP_ALIVE=forever must look like 5m, 30s, 0 or -1/);
      // One line per issue, and never internal camelCase key names.
      assert.equal(error.message.split("\n").length, 1 + 5);
      assert.doesNotMatch(error.message, /ollamaNumCtx|hostExecutionEnabled|ollamaBaseUrl|homeFleetWorkerKeepAlive/);
      return true;
    },
  );
});

test("cross-field requirements keep their ENV VAR wording", () => {
  assert.throws(
    () => loadConfig({ cwd: "/tmp/omnibus-owner-workspace", env: { DEVELOPER_PROVIDER: "responses" } }),
    /OPENAI_API_KEY is required for DEVELOPER_PROVIDER=responses/,
  );
});
