import assert from "node:assert/strict";
import test from "node:test";
import { UsageLedger, estimateCloudUsd } from "./usage.js";

test("usage telemetry records local and cloud work without limiting either path", () => {
  const ledger = new UsageLedger();
  ledger.record({ provider: "ollama", execution: "local", inputTokens: 120, outputTokens: 48 });
  ledger.record({ provider: "responses", execution: "cloud", inputTokens: 1_000, outputTokens: 250, estimatedUsd: 0.01 });
  ledger.record({ provider: "codex-cli", execution: "cloud", observedUsd: 0.25 });

  assert.deepEqual(ledger.status(), {
    localRuns: 1,
    cloudRuns: 2,
    inputTokens: 1_120,
    outputTokens: 298,
    observedCloudUsd: 0.25,
    estimatedCloudUsd: 0.01,
  });
});

test("cloud cost estimates are optional telemetry, not a prerequisite for execution", () => {
  assert.equal(estimateCloudUsd(1_000_000, 500_000, 2, 8), 6);
  assert.equal(estimateCloudUsd(1_000, 500, 0, 8), undefined);
});
