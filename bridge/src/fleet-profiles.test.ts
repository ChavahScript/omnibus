import assert from "node:assert/strict";
import test from "node:test";
import { GIBIBYTE, type LaptopCapabilities } from "./hardware.js";
import { assessFleetProfile, localFleetProfiles, recommendFleetProfiles } from "./fleet-profiles.js";

const GIB = GIBIBYTE;

function hardware(overrides: Partial<LaptopCapabilities> = {}): LaptopCapabilities {
  return {
    collectedAt: "2026-07-17T12:00:00.000Z",
    platform: "darwin",
    architecture: "arm64",
    cpu: { logicalCores: 8, availableParallelism: 8, model: "Apple Test" },
    memory: { totalBytes: 16 * GIB, freeBytes: 14 * GIB },
    disk: { available: true, totalBytes: 512 * GIB, freeBytes: 128 * GIB },
    accelerator: "not-probed",
    ...overrides,
  };
}

test("fleet definitions use known bounded Ollama tags and deduplicate a shared compact model", () => {
  const profiles = localFleetProfiles();
  assert.deepEqual(profiles.map(profile => profile.id), ["compact", "balanced", "power", "studio"]);
  assert.equal(profiles.length, 4);
  assert.deepEqual(profiles[0].modelRequirements, [{
    model: "qwen2.5-coder:1.5b",
    roles: ["auditor", "developer"],
  }]);
  for (const profile of profiles) {
    assert.equal(profile.ollama.maxLoadedModels, 1);
    assert.equal(profile.ollama.numParallel, 1);
    assert.ok(profile.capacity.estimatedDownloadBytes > 0);
    assert.ok(profile.capacity.estimatedWorkingMemoryBytes > profile.capacity.estimatedDownloadBytes);
  }
});

test("a healthy 16 GB laptop recommends the strongest ready bounded profile", () => {
  const recommendation = recommendFleetProfiles(hardware());
  assert.equal(recommendation.recommendedProfileId, "balanced");
  assert.equal(recommendation.detectedCapacity, "balanced");
  assert.equal(recommendation.profiles.find(profile => profile.profile.id === "balanced")?.readiness, "ready");
  assert.equal(recommendation.profiles.find(profile => profile.profile.id === "power")?.canInstall, false);
});

test("memory pressure is actionable without falsely claiming a capable laptop cannot install the profile", () => {
  const profile = localFleetProfiles().find(candidate => candidate.id === "balanced")!;
  const assessment = assessFleetProfile(profile, hardware({ memory: { totalBytes: 16 * GIB, freeBytes: 3 * GIB } }));
  assert.equal(assessment.canInstall, true);
  assert.equal(assessment.readyNow, false);
  assert.equal(assessment.readiness, "needs-memory-headroom");
  assert.match(assessment.reasons[0], /Close memory-heavy apps/i);
});

test("disk inspection uncertainty requires confirmation while impossible hardware is disabled", () => {
  const compact = localFleetProfiles()[0];
  const uncertainDisk = assessFleetProfile(compact, hardware({ disk: { available: false, error: "unavailable" } }));
  assert.equal(uncertainDisk.canInstall, true);
  assert.equal(uncertainDisk.readiness, "needs-disk-check");

  const unsupported = recommendFleetProfiles(hardware({
    architecture: "ia32",
    cpu: { logicalCores: 1, availableParallelism: 1, model: "Legacy" },
    memory: { totalBytes: 4 * GIB, freeBytes: 4 * GIB },
    disk: { available: true, totalBytes: 16 * GIB, freeBytes: 16 * GIB },
  }));
  assert.equal(unsupported.detectedCapacity, "below-minimum");
  assert.equal(unsupported.recommendedProfileId, "compact");
  assert.ok(unsupported.profiles.every(profile => !profile.canInstall));
});
