import { z } from "zod";

export const AgentNameSchema = z.enum(["developer", "auditor", "marketing", "system"]);
export type AgentName = z.infer<typeof AgentNameSchema>;

/**
 * Usage is informational only. There is deliberately no configurable dollar
 * ceiling in the product runtime: normal ideation uses local inference, while
 * any cloud provider is a deliberate owner configuration choice.
 */
export const UsageStatusSchema = z.object({
  localRuns: z.number().int().nonnegative(),
  cloudRuns: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  observedCloudUsd: z.number().nonnegative(),
  estimatedCloudUsd: z.number().nonnegative(),
});
export type UsageStatus = z.infer<typeof UsageStatusSchema>;

export const ModelUsageSchema = z.object({
  provider: z.enum(["ollama", "codex-cli", "responses"]),
  execution: z.enum(["local", "cloud"]),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  observedUsd: z.number().nonnegative().optional(),
  estimatedUsd: z.number().nonnegative().optional(),
});
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

/** Stable, limited choices exposed to a QR-paired phone. */
export const FleetProfileIdSchema = z.enum(["compact", "balanced", "power", "studio"]);
export type FleetProfileId = z.infer<typeof FleetProfileIdSchema>;

/**
 * This is deliberately a capability summary, not a machine inventory. There
 * are no disk paths, serial identifiers, running processes, filenames, or
 * GPU guesses in this wire shape.
 */
export const LaptopCapabilitiesSchema = z.object({
  collectedAt: z.string().datetime(),
  platform: z.string().min(1).max(32),
  architecture: z.string().min(1).max(64),
  cpu: z.object({
    logicalCores: z.number().int().min(1).max(4_096),
    availableParallelism: z.number().int().min(1).max(4_096),
    model: z.string().min(1).max(160),
  }),
  memory: z.object({
    totalBytes: z.number().int().nonnegative(),
    freeBytes: z.number().int().nonnegative(),
  }),
  disk: z.object({
    available: z.boolean(),
    totalBytes: z.number().int().nonnegative().optional(),
    freeBytes: z.number().int().nonnegative().optional(),
    error: z.literal("unavailable").optional(),
  }),
  accelerator: z.literal("not-probed"),
});
export type LaptopCapabilities = z.infer<typeof LaptopCapabilitiesSchema>;

export const FleetProfileSchema = z.object({
  id: FleetProfileIdSchema,
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(320),
  auditorModel: z.string().min(1).max(160),
  developerModel: z.string().min(1).max(160),
  numCtx: z.number().int().min(4_096).max(131_072),
  maxLoadedModels: z.number().int().min(1).max(8),
  numParallel: z.number().int().min(1).max(8),
  keepAlive: z.string().min(1).max(32),
  minimumTotalMemoryBytes: z.number().int().nonnegative(),
  minimumLogicalCores: z.number().int().min(1),
  minimumFreeDiskBytes: z.number().int().nonnegative(),
  estimatedDownloadBytes: z.number().int().nonnegative(),
  estimatedWorkingMemoryBytes: z.number().int().nonnegative(),
});
export type FleetProfile = z.infer<typeof FleetProfileSchema>;

export const FleetProfileAssessmentSchema = z.object({
  profile: FleetProfileSchema,
  canInstall: z.boolean(),
  readyNow: z.boolean(),
  readiness: z.enum(["ready", "needs-memory-headroom", "needs-disk-check", "unsupported"]),
  reasons: z.array(z.string().min(1).max(500)).max(6),
});
export type FleetProfileAssessment = z.infer<typeof FleetProfileAssessmentSchema>;

/**
 * A secret-free, owner-facing summary of one explicitly paired home worker.
 * Worker addresses, shared secrets, local paths, and model tags stay on the
 * coordinator laptop. The paired phone only needs enough information to make
 * an informed per-idea consent decision.
 */
export const HomeFleetWorkerSchema = z.object({
  id: z.string().uuid(),
  label: z.string().min(1).max(80),
  status: z.enum(["online", "offline", "needs-model"]),
  modelReady: z.boolean(),
  /** The paired phone owner must explicitly activate a newly joined worker. */
  approved: z.boolean(),
  lastSeenAt: z.string().datetime().optional(),
});
export type HomeFleetWorker = z.infer<typeof HomeFleetWorkerSchema>;

/**
 * The coordinator is always the laptop paired with the phone. Extra laptops
 * are private LAN workers; they are never placed behind the public phone
 * tunnel and cannot run host commands, pull models, or receive source files.
 */
export const HomeFleetSnapshotSchema = z.object({
  available: z.boolean(),
  workerLimit: z.number().int().min(1).max(8),
  workers: z.array(HomeFleetWorkerSchema).max(8),
  activeInviteExpiresAt: z.string().datetime().optional(),
});
export type HomeFleetSnapshot = z.infer<typeof HomeFleetSnapshotSchema>;

/** The invitation is transient and travels only on the authenticated phone socket. */
export const HomeFleetInviteSchema = z.object({
  correlationId: z.string().uuid(),
  /** The macOS / Linux / Git-Bash form: paste as-is into a POSIX shell. */
  command: z.string().min(1).max(8_000),
  /**
   * The Windows form. On a stock Windows client PowerShell resolves `npx` to
   * `npx.ps1`, which the default Restricted execution policy blocks, so the
   * bare command fails on camera. Wrapping it in `cmd /c` routes to `npx.cmd`
   * and is immune to execution policy. Optional so older phone builds that
   * only render `command` keep working.
   */
  commandWindows: z.string().min(1).max(8_100).optional(),
  expiresAt: z.string().datetime(),
});
export type HomeFleetInvite = z.infer<typeof HomeFleetInviteSchema>;

export const FleetSnapshotSchema = z.object({
  hardware: LaptopCapabilitiesSchema,
  profiles: z.array(FleetProfileAssessmentSchema).min(1).max(4),
  recommendedProfileId: FleetProfileIdSchema.optional(),
  detectedCapacity: z.enum(["compact", "balanced", "power", "studio", "below-minimum"]),
  notes: z.array(z.string().min(1).max(500)).max(6),
  activeProfileId: FleetProfileIdSchema.optional(),
  research: z.object({
    enabled: z.boolean(),
    hasBraveSearchApiKey: z.boolean(),
    provider: z.literal("brave"),
  }),
  provisioning: z.object({
    active: z.boolean(),
    profileId: FleetProfileIdSchema.optional(),
  }),
  homeFleet: HomeFleetSnapshotSchema,
});
export type FleetSnapshot = z.infer<typeof FleetSnapshotSchema>;

export const ClientCommandSchema = z.object({
  type: z.literal("command"),
  correlationId: z.string().uuid(),
  directive: z.string().trim().min(3).max(12_000),
  mode: z.enum(["build", "plan", "marketing"]).default("build"),
  /**
   * Per-request consent for the optional external search provider. It never
   * grants access to workspace context or makes browser activity autonomous.
   * Older mobile builds omit the property and remain local-only by default.
   */
  research: z.boolean().default(false),
  /**
   * A second, independent consent boundary. When true, only this original idea
   * may be sent to explicitly paired laptops on the
   * same private network for bounded peer review. Workspace files, saved
   * memory, search keys, audit logs, and host-execution capability never go.
   */
  homeFleet: z.boolean().default(false),
});
export type ClientCommand = z.infer<typeof ClientCommandSchema>;

/** Read-only request for the capability sheet shown immediately after pairing. */
export const FleetSnapshotRequestSchema = z.object({ type: z.literal("fleet_snapshot") });
export type FleetSnapshotRequest = z.infer<typeof FleetSnapshotRequestSchema>;

/**
 * Provisioning only accepts an allow-listed preset. A phone cannot smuggle a
 * model tag, shell command, disk path, or environment variable through this
 * channel.
 */
export const FleetProvisionRequestSchema = z.object({
  type: z.literal("fleet_provision"),
  correlationId: z.string().uuid(),
  profileId: FleetProfileIdSchema,
});
export type FleetProvisionRequest = z.infer<typeof FleetProvisionRequestSchema>;

/** The optional key is sent once over the authenticated paired WebSocket. */
export const ResearchConfigureRequestSchema = z.object({
  type: z.literal("research_configure"),
  correlationId: z.string().uuid(),
  enabled: z.boolean(),
  braveSearchApiKey: z.string().trim().min(10).max(512).optional(),
});
export type ResearchConfigureRequest = z.infer<typeof ResearchConfigureRequestSchema>;

/** Creates one short-lived LAN worker invitation; the invite is returned as an event. */
export const HomeFleetInviteRequestSchema = z.object({
  type: z.literal("home_fleet_invite"),
  correlationId: z.string().uuid(),
});
export type HomeFleetInviteRequest = z.infer<typeof HomeFleetInviteRequestSchema>;

/** Removes a worker's coordinator credential and stops sending it any ideas. */
export const HomeFleetRemoveRequestSchema = z.object({
  type: z.literal("home_fleet_remove"),
  correlationId: z.string().uuid(),
  workerId: z.string().uuid(),
});
export type HomeFleetRemoveRequest = z.infer<typeof HomeFleetRemoveRequestSchema>;

/** Second owner confirmation before a newly registered LAN worker may review ideas. */
export const HomeFleetApproveRequestSchema = z.object({
  type: z.literal("home_fleet_approve"),
  correlationId: z.string().uuid(),
  workerId: z.string().uuid(),
});
export type HomeFleetApproveRequest = z.infer<typeof HomeFleetApproveRequestSchema>;

/**
 * Read-only request for the Second Brain status card. The reply is a bounded,
 * path-free counters snapshot; graph contents never cross to the phone.
 */
export const BrainStatusRequestSchema = z.object({ type: z.literal("brain_status") });
export type BrainStatusRequest = z.infer<typeof BrainStatusRequestSchema>;

export const ClientMessageSchema = z.discriminatedUnion("type", [
  ClientCommandSchema,
  FleetSnapshotRequestSchema,
  FleetProvisionRequestSchema,
  ResearchConfigureRequestSchema,
  HomeFleetInviteRequestSchema,
  HomeFleetRemoveRequestSchema,
  HomeFleetApproveRequestSchema,
  BrainStatusRequestSchema,
  z.object({ type: z.literal("ping"), sentAt: z.number() }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/**
 * A phone-safe description of why a client frame was rejected. Codes are
 * deliberately coarse: the common self-serve mistakes (idea length) get their
 * own codes so the app can react inline, while everything else collapses to
 * INVALID_MESSAGE with humane text that never echoes raw zod internals.
 */
export type ClientMessageRejection = {
  code: "IDEA_TOO_SHORT" | "IDEA_TOO_LONG" | "INVALID_MESSAGE";
  message: string;
  /** Present only when the client supplied a well-formed UUID correlation id. */
  correlationId?: string;
};

const UUID_LIKE_CORRELATION_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Recovers a correlation id from an otherwise-invalid decoded frame so the
 * app can attach the rejection to the action that caused it. Only a bounded,
 * strictly UUID-shaped string is echoed back; arbitrary client text is never
 * reflected into an event stream that may be journaled and replayed.
 */
export function salvageCorrelationId(decoded: unknown): string | undefined {
  if (typeof decoded !== "object" || decoded === null) return undefined;
  const candidate = (decoded as Record<string, unknown>).correlationId;
  if (typeof candidate !== "string" || candidate.length > 64) return undefined;
  return UUID_LIKE_CORRELATION_ID.test(candidate) ? candidate : undefined;
}

/**
 * Classifies a schema rejection into a humane, actionable error event body.
 * The zod issue paths (not client-controlled text) drive classification, so
 * a malicious frame cannot select a misleading message for a different field.
 */
export function classifyClientMessageRejection(decoded: unknown, error: z.ZodError): ClientMessageRejection {
  const correlationId = salvageCorrelationId(decoded);
  const directiveIssue = error.issues.find(issue => issue.path[0] === "directive");
  if (directiveIssue?.code === "too_small") {
    return { code: "IDEA_TOO_SHORT", message: "Your idea needs at least 3 characters.", correlationId };
  }
  if (directiveIssue?.code === "too_big") {
    return { code: "IDEA_TOO_LONG", message: "Your idea is too long (max 12,000 characters). Split it into two ideas.", correlationId };
  }
  const unknownType = error.issues.some(issue => issue.code === "invalid_union_discriminator"
    || (issue.path[0] === "type" && issue.path.length === 1));
  if (unknownType) {
    return { code: "INVALID_MESSAGE", message: "This bridge doesn't recognize that message type. Update the Omnibus app and try again.", correlationId };
  }
  return { code: "INVALID_MESSAGE", message: "Invalid dashboard message.", correlationId };
}

/**
 * The persisted queue intentionally stores only owner-supplied commands and
 * compact operational metadata.  It does not store model output or hidden
 * reasoning; those belong in the audited result and serializable memory.
 */
export const QueueJobStatusSchema = z.enum(["queued", "running", "retrying", "failed"]);
export type QueueJobStatus = z.infer<typeof QueueJobStatusSchema>;

export const QueueJobSchema = z.object({
  id: z.string().uuid(),
  command: ClientCommandSchema,
  /** Random per-WebSocket scope; prevents one paired device's memory from reaching another. */
  ownerScope: z.string().min(1).max(128).default("legacy"),
  status: QueueJobStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** Number of execution attempts that have actually begun. */
  attempts: z.number().int().nonnegative().max(8),
  maxAttempts: z.number().int().min(1).max(8),
  /** Null means the job is ready as soon as no earlier job is running. */
  nextAttemptAt: z.string().datetime().nullable(),
  lastError: z.string().max(1_500).optional(),
});
export type QueueJob = z.infer<typeof QueueJobSchema>;

export const CommandQueueSnapshotSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string().datetime(),
  jobs: z.array(QueueJobSchema).max(80),
});
export type CommandQueueSnapshot = z.infer<typeof CommandQueueSnapshotSchema>;

/** A bounded, source-only view passed to the local Auditor. */
export const WorkspaceContextFileSchema = z.object({
  path: z.string().min(1).max(320),
  bytes: z.number().int().nonnegative().max(262_144),
});
export type WorkspaceContextFile = z.infer<typeof WorkspaceContextFileSchema>;

export const WorkspaceContextSnippetSchema = z.object({
  path: z.string().min(1).max(320),
  text: z.string().min(1).max(8_000),
  truncated: z.boolean(),
});
export type WorkspaceContextSnippet = z.infer<typeof WorkspaceContextSnippetSchema>;

export const WorkspaceContextSchema = z.object({
  available: z.boolean(),
  note: z.string().max(500).optional(),
  files: z.array(WorkspaceContextFileSchema).max(64),
  snippets: z.array(WorkspaceContextSnippetSchema).max(12),
  scannedEntries: z.number().int().nonnegative().max(2_000),
  omitted: z.object({
    excluded: z.number().int().nonnegative(),
    oversized: z.number().int().nonnegative(),
    unreadable: z.number().int().nonnegative(),
    sensitive: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
});
export type WorkspaceContext = z.infer<typeof WorkspaceContextSchema>;

/**
 * A bounded, path-free Second Brain summary for the paired phone. It carries
 * counters and watcher states only — never node names, fact text, workspace
 * paths, or worker network identities.
 */
export const BrainStatusEventSchema = z.object({
  enabled: z.boolean(),
  /**
   * The adaptive sizing tier the bridge resolved for its own hardware. It is
   * a capacity label, not a machine inventory: no byte counts cross here.
   */
  capacityTier: z.enum(["compact", "balanced", "power", "studio"]).optional(),
  nodes: z.number().int().nonnegative(),
  facts: z.number().int().nonnegative(),
  invalidatedFacts: z.number().int().nonnegative(),
  antiPatterns: z.number().int().nonnegative(),
  lastCaptureAt: z.string().datetime().nullable(),
  watchers: z.object({
    git: z.enum(["active", "unavailable", "disabled"]),
    diagnostics: z.enum(["active", "unavailable", "disabled"]),
    discussions: z.enum(["active", "unavailable", "disabled"]),
  }),
  fleetCache: z.object({
    sharingEnabled: z.boolean(),
    bundleReady: z.boolean(),
    workersWarm: z.number().int().nonnegative(),
  }),
  /**
   * Counts only, deliberately: retrieval entities are extracted verbatim
   * from the most recent idea's text, and brain status answers ANY paired
   * device — echoing them would leak one device's directive fragments to
   * another, breaking per-device idea isolation.
   */
  lastRetrieval: z.object({
    entityCount: z.number().int().nonnegative(),
    facts: z.number().int().nonnegative(),
  }).nullable(),
});
export type BrainStatusEvent = z.infer<typeof BrainStatusEventSchema>;

export type BridgeEvent =
  | { type: "hello"; deviceId: string; usage: UsageStatus; resumeToken: string }
  | { type: "fleet"; snapshot: FleetSnapshot }
  | { type: "home_fleet_invite"; invite: HomeFleetInvite }
  | { type: "brain"; status: BrainStatusEvent }
  | { type: "status"; correlationId: string; agent: AgentName; text: string; stage: string }
  | { type: "call"; correlationId: string; agent: AgentName; title: string; body: string; action: "open" | "close" }
  | { type: "usage"; usage: UsageStatus }
  | { type: "result"; correlationId: string; agent: AgentName; summary: string }
  | { type: "error"; correlationId?: string; code: string; message: string }
  | { type: "pong"; sentAt: number };

/**
 * Events that are safe and useful to retain briefly for a reconnecting phone.
 *
 * This deliberately excludes `hello`, `pong`, Fleet snapshots, and Home Fleet
 * invitations. The first two are connection-specific, a fresh capability
 * snapshot is requested after every handshake, and an invitation contains a
 * one-time owner command which must never be re-sent after a socket gap.
 * Commands are client-to-bridge messages and are therefore never represented
 * here or replayed by the bridge.
 */
export type ReplayableBridgeEvent = Extract<BridgeEvent, {
  type: "status" | "call" | "usage" | "result" | "error";
}>;

/** A bounded device-local recovery view; it is kept only in bridge memory. */
export type DeviceEventReplaySnapshot = {
  events: ReplayableBridgeEvent[];
  /** True when the server observed a socket gap or session replacement. */
  recovered: boolean;
};

export function isReplayableBridgeEvent(event: BridgeEvent): event is ReplayableBridgeEvent {
  // A context-free protocol error (no correlationId) describes one dead
  // socket's malformed frame, not the device's work. Replaying it after a
  // resume would surface a phantom toast about nothing; only errors tied to
  // a specific command remain part of the recovery view.
  if (event.type === "error") return typeof event.correlationId === "string" && event.correlationId.length > 0;
  return event.type === "status"
    || event.type === "call"
    || event.type === "usage"
    || event.type === "result";
}

export const AuditResultSchema = z.object({
  enrichedDirective: z.string().min(1),
  riskSummary: z.array(z.string()).max(8),
  rationaleSummary: z.string().max(2_000),
  estimatedInputTokens: z.number().int().min(1).max(100_000),
  estimatedOutputTokens: z.number().int().min(1).max(50_000),
});
export type AuditResult = z.infer<typeof AuditResultSchema>;

export const AgentSnapshotSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  entries: z.array(z.object({
    correlationId: z.string(),
    /** Optional so pre-scope local history remains readable after an upgrade. */
    scope: z.string().min(1).max(128).optional(),
    role: AgentNameSchema,
    kind: z.string(),
    value: z.string().max(16_000),
    at: z.string(),
  })).max(200),
});
export type AgentSnapshot = z.infer<typeof AgentSnapshotSchema>;
