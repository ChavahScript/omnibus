import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeSettingsStore } from "./bridge-settings.js";
import { loadConfig } from "./config.js";

test("a paired fleet choice persists privately and applies to the next local bridge configuration", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "omnibus-fleet-settings-"));
  try {
    const config = loadConfig({ cwd: workspace, env: {} });
    const store = new BridgeSettingsStore(config.statePath);
    const summary = await store.setFleetProfile("balanced");
    assert.equal(summary.fleetProfileId, "balanced");

    await store.applyTo(config);
    assert.equal(config.ollamaModel, "qwen2.5-coder:3b");
    assert.equal(config.ollamaDeveloperModel, "qwen2.5-coder:7b");
    assert.equal(config.ollamaNumCtx, 16_384);
    assert.equal(config.ollamaKeepAlive, "0");

    const details = await stat(store.path);
    assert.equal(details.mode & 0o777, 0o600);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("paired research setup keeps the key private while allowing a later one-tap toggle", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "omnibus-research-settings-"));
  try {
    const config = loadConfig({ cwd: workspace, env: {} });
    const store = new BridgeSettingsStore(config.statePath);
    await assert.rejects(
      () => store.configureWebResearch({ enabled: true }),
      /Brave Search API key/i,
    );

    const first = await store.configureWebResearch({ enabled: true, apiKey: "test-paired-secret-key" });
    assert.deepEqual(first.research, { enabled: true, hasBraveSearchApiKey: true });
    assert.doesNotMatch(JSON.stringify(first), /test-paired-secret-key/);
    await store.applyTo(config);
    assert.equal(config.webResearchEnabled, true);
    assert.equal(config.braveSearchApiKey, "test-paired-secret-key");

    const second = await store.configureWebResearch({ enabled: false });
    assert.deepEqual(second.research, { enabled: false, hasBraveSearchApiKey: true });
    const contents = await readFile(store.path, "utf8");
    assert.match(contents, /test-paired-secret-key/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a phone can activate an already configured environment key without copying it into bridge state", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "omnibus-env-research-settings-"));
  try {
    const config = loadConfig({
      cwd: workspace,
      env: { BRAVE_SEARCH_API_KEY: "environment-only-brave-key" },
    });
    const store = new BridgeSettingsStore(config.statePath);
    const summary = await store.configureWebResearch({ enabled: true, hasExistingKey: true });
    assert.deepEqual(summary.research, { enabled: true, hasBraveSearchApiKey: true });
    await store.applyTo(config);
    assert.equal(config.webResearchEnabled, true);
    assert.equal(config.braveSearchApiKey, "environment-only-brave-key");
    assert.doesNotMatch(await readFile(store.path, "utf8"), /environment-only-brave-key/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
