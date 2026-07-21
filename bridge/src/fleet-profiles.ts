import type { LocalModelRequirement, LocalModelRole } from "./local-intelligence.js";
import { GIBIBYTE, bytesToGiB, type LaptopCapabilities } from "./hardware.js";

/**
 * A profile is deliberately a conservative, named local fleet rather than an
 * arbitrary model string. This lets the phone describe the resource tradeoff
 * before the bridge downloads anything or changes the owner's Ollama config.
 */
export type FleetProfileId = "compact" | "balanced" | "power" | "studio";

export type FleetRoleAssignment = {
  role: LocalModelRole;
  /** A stable, public Ollama library tag; no unverified custom GGUF URL. */
  model: string;
  /** Approximate compressed download size, used for planning only. */
  estimatedDownloadBytes: number;
};

export type FleetProfile = {
  id: FleetProfileId;
  name: string;
  description: string;
  assignments: FleetRoleAssignment[];
  /** Directly compatible with `requiredLocalModels` / the existing pull flow. */
  modelRequirements: LocalModelRequirement[];
  ollama: {
    /** Bounded context is a first-class capacity decision because KV cache grows with it. */
    numCtx: number;
    /** Omnibus's conservative target; it does not rewrite another Ollama client's global policy. */
    maxLoadedModels: 1;
    /** The bridge queue is serial, so one parallel request is the predictable setting. */
    numParallel: 1;
    /** Per-request residency; `0` asks Ollama to unload a role model after its pass. */
    keepAlive: "0" | "2m";
  };
  capacity: {
    minimumTotalMemoryBytes: number;
    minimumLogicalCores: number;
    minimumFreeDiskBytes: number;
    /** Approximate model payload that will be pulled from the Ollama registry. */
    estimatedDownloadBytes: number;
    /** Approximate model + KV-cache working set, not a promise about performance. */
    estimatedWorkingMemoryBytes: number;
  };
};

export type FleetReadiness = "ready" | "needs-memory-headroom" | "needs-disk-check" | "unsupported";

export type FleetProfileAssessment = {
  profile: FleetProfile;
  /** The laptop is sufficient in durable capacity for this installation. */
  canInstall: boolean;
  /** Current free memory/disk also supports starting the selected fleet now. */
  readyNow: boolean;
  readiness: FleetReadiness;
  /** Compact, deterministic UI-safe explanations, never raw system errors. */
  reasons: string[];
};

export type FleetRecommendation = {
  /** At most four ordered choices; lowest resource mode appears first. */
  profiles: FleetProfileAssessment[];
  /** Highest ready profile; otherwise the highest installable profile; otherwise compact. */
  recommendedProfileId: FleetProfileId;
  detectedCapacity: "below-minimum" | "compact" | "balanced" | "power" | "studio";
  notes: string[];
};

const GIB = GIBIBYTE;

/**
 * Estimates are intentionally rounded upward. Ollama model sizes can vary a
 * little by platform/revision, while context and system pressure can vary a
 * great deal, so a plan should reserve more than the raw model-download size.
 */
const FLEET_PROFILES: readonly FleetProfile[] = [
  createProfile({
    id: "compact",
    name: "Compact",
    description: "Fast, private ideation for an 8 GB laptop. Both roles share one efficient coding model.",
    assignments: [{ role: "auditor", model: "qwen2.5-coder:1.5b", estimatedDownloadBytes: 1.1 * GIB }, { role: "developer", model: "qwen2.5-coder:1.5b", estimatedDownloadBytes: 1.1 * GIB }],
    numCtx: 8_192,
    keepAlive: "2m",
    minimumTotalMemoryBytes: 8 * GIB,
    minimumLogicalCores: 2,
    minimumFreeDiskBytes: 5 * GIB,
    estimatedWorkingMemoryBytes: 4 * GIB,
  }),
  createProfile({
    id: "balanced",
    name: "Balanced",
    description: "A separate fast auditor and stronger builder for typical 16 GB developer laptops.",
    assignments: [{ role: "auditor", model: "qwen2.5-coder:3b", estimatedDownloadBytes: 2.0 * GIB }, { role: "developer", model: "qwen2.5-coder:7b", estimatedDownloadBytes: 4.7 * GIB }],
    numCtx: 16_384,
    // Separate roles are deliberately unloaded between passes so a 16 GB
    // laptop does not retain both models just because one idea is in flight.
    keepAlive: "0",
    minimumTotalMemoryBytes: 16 * GIB,
    minimumLogicalCores: 4,
    minimumFreeDiskBytes: 12 * GIB,
    estimatedWorkingMemoryBytes: 12 * GIB,
  }),
  createProfile({
    id: "power",
    name: "Power",
    description: "Longer-context planning and higher-quality local implementation for 32 GB workstations.",
    assignments: [{ role: "auditor", model: "qwen2.5-coder:7b", estimatedDownloadBytes: 4.7 * GIB }, { role: "developer", model: "qwen2.5-coder:14b", estimatedDownloadBytes: 9.0 * GIB }],
    numCtx: 32_768,
    keepAlive: "0",
    minimumTotalMemoryBytes: 32 * GIB,
    minimumLogicalCores: 6,
    minimumFreeDiskBytes: 22 * GIB,
    estimatedWorkingMemoryBytes: 26 * GIB,
  }),
  createProfile({
    id: "studio",
    name: "Studio",
    description: "The largest local coding fleet, reserved for 64 GB machines with ample storage headroom.",
    assignments: [{ role: "auditor", model: "qwen2.5-coder:14b", estimatedDownloadBytes: 9.0 * GIB }, { role: "developer", model: "qwen2.5-coder:32b", estimatedDownloadBytes: 20.0 * GIB }],
    numCtx: 32_768,
    keepAlive: "0",
    minimumTotalMemoryBytes: 64 * GIB,
    minimumLogicalCores: 8,
    minimumFreeDiskBytes: 42 * GIB,
    estimatedWorkingMemoryBytes: 52 * GIB,
  }),
];

/** Returns immutable profile definitions without probing or mutating the laptop. */
export function localFleetProfiles(): readonly FleetProfile[] {
  return FLEET_PROFILES;
}

/** Looks up an approved preset only; arbitrary user-provided model strings are not profiles. */
export function findFleetProfile(id: string): FleetProfile | undefined {
  return FLEET_PROFILES.find(profile => profile.id === id);
}

/**
 * Pure deterministic capability assessment. It does not download models,
 * write environment variables, or trust a guessed GPU/VRAM value. Callers can
 * render all profiles and disable those that do not fit the detected laptop.
 */
export function recommendFleetProfiles(hardware: LaptopCapabilities): FleetRecommendation {
  const profiles = FLEET_PROFILES.map(profile => assessFleetProfile(profile, hardware));
  const ready = profiles.filter(profile => profile.readyNow);
  const installable = profiles.filter(profile => profile.canInstall);
  const recommended = (ready.length ? ready : installable).at(-1)?.profile.id ?? "compact";
  const selected = FLEET_PROFILES.find(profile => profile.id === recommended)!;

  return {
    profiles,
    recommendedProfileId: recommended,
    detectedCapacity: detectedCapacity(selected.id, profiles.some(profile => profile.canInstall)),
    notes: recommendationNotes(hardware, selected),
  };
}

/** Same pure calculation for a single user-selected mode. */
export function assessFleetProfile(profile: FleetProfile, hardware: LaptopCapabilities): FleetProfileAssessment {
  const reasons: string[] = [];
  const supportedArchitecture = hardware.architecture === "arm64" || hardware.architecture === "x64";
  if (!supportedArchitecture) reasons.push(`This ${hardware.architecture} architecture is not in the supported local-fleet presets.`);
  if (hardware.memory.totalBytes < profile.capacity.minimumTotalMemoryBytes) {
    reasons.push(`${profile.name} needs ${formatGiB(profile.capacity.minimumTotalMemoryBytes)} GB total memory; this laptop reports ${formatGiB(hardware.memory.totalBytes)} GB.`);
  }
  if (hardware.cpu.logicalCores < profile.capacity.minimumLogicalCores) {
    reasons.push(`${profile.name} needs ${profile.capacity.minimumLogicalCores}+ logical CPU cores; this laptop reports ${hardware.cpu.logicalCores}.`);
  }
  if (hardware.disk.available && (hardware.disk.freeBytes ?? 0) < profile.capacity.minimumFreeDiskBytes) {
    reasons.push(`${profile.name} needs ${formatGiB(profile.capacity.minimumFreeDiskBytes)} GB free disk; ${formatGiB(hardware.disk.freeBytes ?? 0)} GB is available.`);
  }

  const canInstall = reasons.length === 0;
  if (!canInstall) return { profile, canInstall, readyNow: false, readiness: "unsupported", reasons };

  if (!hardware.disk.available) {
    return {
      profile,
      canInstall: true,
      readyNow: false,
      readiness: "needs-disk-check",
      reasons: ["Free disk space could not be inspected. Confirm the profile's disk requirement before downloading models."],
    };
  }
  if (hardware.memory.freeBytes < profile.capacity.estimatedWorkingMemoryBytes) {
    return {
      profile,
      canInstall: true,
      readyNow: false,
      readiness: "needs-memory-headroom",
      reasons: [`${profile.name} estimates ${formatGiB(profile.capacity.estimatedWorkingMemoryBytes)} GB working memory; only ${formatGiB(hardware.memory.freeBytes)} GB is currently free. Close memory-heavy apps before starting it.`],
    };
  }
  return { profile, canInstall: true, readyNow: true, readiness: "ready", reasons: [] };
}

function createProfile(input: Omit<FleetProfile, "modelRequirements" | "capacity" | "ollama"> & {
  assignments: FleetRoleAssignment[];
  numCtx: number;
  keepAlive: "0" | "2m";
  minimumTotalMemoryBytes: number;
  minimumLogicalCores: number;
  minimumFreeDiskBytes: number;
  estimatedWorkingMemoryBytes: number;
}): FleetProfile {
  const modelRequirements = requirementsForAssignments(input.assignments);
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    assignments: input.assignments,
    modelRequirements,
    ollama: { numCtx: input.numCtx, maxLoadedModels: 1, numParallel: 1, keepAlive: input.keepAlive },
    capacity: {
      minimumTotalMemoryBytes: input.minimumTotalMemoryBytes,
      minimumLogicalCores: input.minimumLogicalCores,
      minimumFreeDiskBytes: input.minimumFreeDiskBytes,
      estimatedDownloadBytes: sumDistinctModelDownloads(input.assignments),
      estimatedWorkingMemoryBytes: input.estimatedWorkingMemoryBytes,
    },
  };
}

function requirementsForAssignments(assignments: FleetRoleAssignment[]): LocalModelRequirement[] {
  const requirements = new Map<string, LocalModelRequirement>();
  for (const assignment of assignments) {
    const existing = requirements.get(assignment.model);
    if (existing) existing.roles.push(assignment.role);
    else requirements.set(assignment.model, { model: assignment.model, roles: [assignment.role] });
  }
  return [...requirements.values()];
}

function sumDistinctModelDownloads(assignments: FleetRoleAssignment[]): number {
  const seen = new Set<string>();
  return assignments.reduce((total, assignment) => {
    if (seen.has(assignment.model)) return total;
    seen.add(assignment.model);
    return total + assignment.estimatedDownloadBytes;
  }, 0);
}

function detectedCapacity(id: FleetProfileId, anyInstallable: boolean): FleetRecommendation["detectedCapacity"] {
  return anyInstallable ? id : "below-minimum";
}

function recommendationNotes(hardware: LaptopCapabilities, profile: FleetProfile): string[] {
  const notes = [
    `Recommended ${profile.name}: ~${formatGiB(profile.capacity.estimatedDownloadBytes)} GB download, ~${formatGiB(profile.capacity.minimumFreeDiskBytes)} GB free disk, and ~${formatGiB(profile.capacity.estimatedWorkingMemoryBytes)} GB working memory.`,
    "Omnibus runs one request at a time. Separate-role presets ask Ollama to unload each role model after its pass to limit retained RAM and KV-cache pressure.",
  ];
  if (hardware.accelerator === "not-probed") {
    notes.push("GPU/VRAM is not inferred by the bridge; actual speed depends on your OS, accelerator support, and current system load.");
  }
  return notes;
}

function formatGiB(bytes: number): string {
  return bytesToGiB(bytes).toFixed(1);
}
