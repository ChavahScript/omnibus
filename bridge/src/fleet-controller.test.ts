import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AuditTrail } from "./audit.js";
import { BridgeSettingsStore } from "./bridge-settings.js";
import { loadConfig } from "./config.js";
import { FleetController, FleetControllerError } from "./fleet-controller.js";

/**
 * A loopback stand-in for the local Ollama API. Serving the compact profile's
 * exact model tag makes provisioning succeed without any network download.
 */
async function startFakeOllama(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/tags") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [{ name: "qwen2.5-coder:1.5b" }] }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

test("a successful provision returns a snapshot that already reports provisioning as finished", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "omnibus-fleet-controller-"));
  const { server, baseUrl } = await startFakeOllama();
  try {
    const config = loadConfig({ cwd: workspace, env: { OLLAMA_BASE_URL: baseUrl } });
    const controller = new FleetController(config, new BridgeSettingsStore(config.statePath), new AuditTrail(config.auditPath));

    const result = await controller.provision(randomUUID(), "compact", () => undefined);

    // The phone leaves the Fleet Setup sheet only when the success response
    // itself says provisioning finished; a stale `active: true` would trap it.
    assert.equal(result.provisioning.active, false);
    assert.equal(result.provisioning.profileId, undefined);
    assert.equal(result.activeProfileId, "compact");
    assert.equal(controller.isProvisioning, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a failed provision clears provisioning state so the next snapshot is not stuck active", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "omnibus-fleet-controller-fail-"));
  // Grab a port, then close it so the runtime probe deterministically fails.
  const { server, baseUrl } = await startFakeOllama();
  await new Promise(resolve => server.close(resolve));
  try {
    const config = loadConfig({ cwd: workspace, env: { OLLAMA_BASE_URL: baseUrl } });
    const controller = new FleetController(config, new BridgeSettingsStore(config.statePath), new AuditTrail(config.auditPath));

    await assert.rejects(
      () => controller.provision(randomUUID(), "compact", () => undefined),
      (error: unknown) => error instanceof FleetControllerError && error.code === "OLLAMA_UNAVAILABLE",
    );

    assert.equal(controller.isProvisioning, false);
    const after = await controller.snapshot();
    assert.equal(after.provisioning.active, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
