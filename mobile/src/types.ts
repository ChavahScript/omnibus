export type AgentName = "developer" | "auditor" | "marketing" | "system";

/**
 * The mobile app only exposes three deliberately named paths. The bridge
 * validates the same literals, so a stale client cannot invent a privileged
 * command mode by changing UI state.
 */
export type CommandMode = "plan" | "build" | "marketing";

/**
 * Presence is separate from pairing: a phone can remember that it paired a
 * laptop while a heartbeat is still checking whether that laptop is awake.
 */
export type ConnectionPresence = "offline" | "connecting" | "checking" | "live" | "stale";

/**
 * Telemetry is recorded on the paired laptop but intentionally has no limit
 * state: Omnibus's normal workflow is local inference, not a prepaid product.
 */
export type UsageStatus = {
  localRuns: number;
  cloudRuns: number;
  inputTokens: number;
  outputTokens: number;
  observedCloudUsd: number;
  estimatedCloudUsd: number;
};

/** Named, conservative local-model teams accepted by the bridge protocol. */
export type FleetProfileId = "compact" | "balanced" | "power" | "studio";

/**
 * Path-free laptop capability view. It deliberately excludes filesystem
 * locations, serial numbers, process lists, and guessed GPU/VRAM values.
 */
export type LaptopCapabilities = {
  collectedAt: string;
  platform: string;
  architecture: string;
  cpu: { logicalCores: number; availableParallelism: number; model: string };
  memory: { totalBytes: number; freeBytes: number };
  disk: { available: boolean; totalBytes?: number; freeBytes?: number; error?: "unavailable" };
  accelerator: "not-probed";
};

export type FleetProfile = {
  id: FleetProfileId;
  name: string;
  description: string;
  auditorModel: string;
  developerModel: string;
  numCtx: number;
  maxLoadedModels: number;
  numParallel: number;
  keepAlive: string;
  minimumTotalMemoryBytes: number;
  minimumLogicalCores: number;
  minimumFreeDiskBytes: number;
  estimatedDownloadBytes: number;
  estimatedWorkingMemoryBytes: number;
};

export type FleetProfileAssessment = {
  profile: FleetProfile;
  canInstall: boolean;
  readyNow: boolean;
  readiness: "ready" | "needs-memory-headroom" | "needs-disk-check" | "unsupported";
  reasons: string[];
};

/**
 * A paired spare laptop contributes only bounded local peer review. Its
 * address, credentials, and model configuration stay on the coordinator.
 */
export type HomeFleetWorker = {
  id: string;
  label: string;
  status: "online" | "offline" | "needs-model";
  modelReady: boolean;
  approved: boolean;
  lastSeenAt?: string;
};

export type HomeFleetSnapshot = {
  available: boolean;
  workerLimit: number;
  workers: HomeFleetWorker[];
  activeInviteExpiresAt?: string;
};

/** A short-lived command for a laptop the owner controls, not a share link. */
export type HomeFleetInvite = {
  correlationId: string;
  command: string;
  expiresAt: string;
};

/** A complete, secret-free control-plane snapshot returned after QR pairing. */
export type FleetSnapshot = {
  hardware: LaptopCapabilities;
  profiles: FleetProfileAssessment[];
  recommendedProfileId?: FleetProfileId;
  detectedCapacity: FleetProfileId | "below-minimum";
  notes: string[];
  activeProfileId?: FleetProfileId;
  research: { enabled: boolean; hasBraveSearchApiKey: boolean; provider: "brave" };
  provisioning: { active: boolean; profileId?: FleetProfileId };
  homeFleet: HomeFleetSnapshot;
};

/**
 * A bounded, path-free view of the laptop's persistent Second Brain: the
 * bi-temporal knowledge graph, ambient watchers, anti-pattern registry, and
 * Home Fleet context cache. Counters only — fact text, node names, workspace
 * paths, and worker addresses never reach the phone.
 */
export type BrainWatcherState = "active" | "unavailable" | "disabled";

export type BrainStatus = {
  enabled: boolean;
  nodes: number;
  facts: number;
  invalidatedFacts: number;
  antiPatterns: number;
  lastCaptureAt: string | null;
  watchers: { git: BrainWatcherState; diagnostics: BrainWatcherState; discussions: BrainWatcherState };
  fleetCache: { sharingEnabled: boolean; bundleReady: boolean; workersWarm: number };
  /** Counts only: recalled entity text never crosses to the phone. */
  lastRetrieval: { entityCount: number; facts: number } | null;
};

export type BridgeEvent =
  | { type: "hello"; deviceId: string; usage: UsageStatus; resumeToken: string }
  | { type: "fleet"; snapshot: FleetSnapshot }
  | { type: "home_fleet_invite"; invite: HomeFleetInvite }
  | { type: "brain"; status: BrainStatus }
  | { type: "status"; correlationId: string; agent: AgentName; text: string; stage: string }
  | { type: "call"; correlationId: string; agent: AgentName; title: string; body: string; action: "open" | "close" }
  | { type: "usage"; usage: UsageStatus }
  | { type: "result"; correlationId: string; agent: AgentName; summary: string }
  | { type: "error"; correlationId?: string; code: string; message: string }
  | { type: "pong"; sentAt: number };

export type PairingPayload = { version: 1; bridgeUrl: string; token: string };

/**
 * The durable half of a completed pairing. This intentionally cannot recreate
 * a QR pairing: it holds the public bridge address and a rotating resumption
 * credential only after the bridge has authenticated the phone once.
 *
 * `resumeToken` is still a bearer credential, so callers must keep this type
 * in Keychain-backed storage rather than AsyncStorage or an app log.
 */
export type BridgeResumeProfile = {
  version: 1;
  bridgeUrl: string;
  resumeToken: string;
  deviceId: string;
  pairedAt: string;
  updatedAt: string;
};

export type DashboardMessage = {
  id: string;
  agent: AgentName;
  text: string;
  stage: string;
  at: Date;
  /** A command's stable identity keeps progress isolated to that idea. */
  correlationId?: string;
};
