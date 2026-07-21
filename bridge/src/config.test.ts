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
