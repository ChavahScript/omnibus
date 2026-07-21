import { z } from "zod";

/**
 * Shared contracts for the Omnibus Second Brain.
 *
 * The Second Brain upgrades the bridge from stateless prompt generation into a
 * persistent, local-first project memory:
 *
 * - A bi-temporal knowledge graph (valid-time + transaction-time) replaces
 *   overwrite-style memory: deprecated decisions are invalidated, never lost.
 * - HippoRAG-style retrieval (entity extraction + Personalized PageRank over
 *   the graph) connects a new iPhone idea to disparate historical constraints
 *   in one retrieval step.
 * - A Code Digital Twin models code artifacts and design rationale, retains
 *   bug-fix history, and validates proposed code against structured
 *   anti-patterns with explicit Wrong/Correct examples.
 * - Ambient capture distills git activity, diagnostics output, and idea/brief
 *   discussions into graph facts without manual filing.
 * - A prefix-cache-aware Home Fleet layer shares one redacted, content-
 *   addressed project-context bundle so spare laptops answer with a warm
 *   prompt prefix instead of re-ingesting context on every review.
 *
 * Everything in this file is local-only state. Nothing here may contain
 * filesystem paths destined for the phone, credentials, or raw workspace
 * source beyond the bounded snippet rules the workspace-context module
 * already enforces.
 */

// ---------------------------------------------------------------------------
// Bi-temporal knowledge graph
// ---------------------------------------------------------------------------

export const BrainNodeKindSchema = z.enum([
  /** A named concept, technology, constraint, person-free project term. */
  "entity",
  /** A physical code artifact: file, module, exported symbol. */
  "artifact",
  /** A recorded design decision or trade-off with rationale. */
  "decision",
  /** A remembered bug fix: what broke, why, and how it was fixed. */
  "bugfix",
  /** A structured anti-pattern reference (detail lives in the registry). */
  "antipattern",
  /** An ambient event digest (git change, diagnostics run, discussion). */
  "event",
  /** A submitted idea / directive from the paired phone. */
  "idea",
]);
export type BrainNodeKind = z.infer<typeof BrainNodeKindSchema>;

export const BrainNodeSchema = z.object({
  id: z.string().min(1).max(64),
  kind: BrainNodeKindSchema,
  name: z.string().min(1).max(240),
  /** Lower-cased, whitespace/punctuation-collapsed form used for matching. */
  normalizedName: z.string().min(1).max(240),
  summary: z.string().max(2_000).optional(),
  /** Transaction time: when this bridge learned the node exists. */
  txCreatedAt: z.string().datetime(),
});
export type BrainNode = z.infer<typeof BrainNodeSchema>;

export const BrainFactOriginSchema = z.object({
  channel: z.enum(["git", "diagnostics", "discussion", "brief", "fleet-review", "twin", "manual", "antipattern"]),
  correlationId: z.string().max(64).optional(),
  /** Home Fleet worker id when a fact came from a queued peer review. */
  workerId: z.string().max(64).optional(),
  detail: z.string().max(400).optional(),
});
export type BrainFactOrigin = z.infer<typeof BrainFactOriginSchema>;

/**
 * A bi-temporal edge. `validFrom`/`validTo` describe when the fact was true
 * in the project's world; `txCreatedAt`/`txInvalidatedAt` describe when the
 * bridge learned and later superseded it. Invalidation never deletes: an
 * "as of" query can still explain what the system believed at any past
 * moment, and a deprecated architectural decision remains inspectable.
 */
export const BrainFactSchema = z.object({
  id: z.string().min(1).max(64),
  subjectId: z.string().min(1).max(64),
  predicate: z.string().min(1).max(120),
  objectId: z.string().min(1).max(64),
  /** Human-readable statement of the fact, bounded and redacted at write. */
  factText: z.string().min(1).max(1_200),
  /** Valid time: when the fact became true in the real project. */
  validFrom: z.string().datetime(),
  /** Null while the fact is still considered true. */
  validTo: z.string().datetime().nullable(),
  /** Transaction time: when this bridge recorded the fact. */
  txCreatedAt: z.string().datetime(),
  /** Null while the record is current; set when superseded/invalidated. */
  txInvalidatedAt: z.string().datetime().nullable(),
  origin: BrainFactOriginSchema,
  confidence: z.number().min(0).max(1),
  /** sha256 of (subject, predicate, object, factText); dedupe + merge key. */
  contentHash: z.string().length(64),
});
export type BrainFact = z.infer<typeof BrainFactSchema>;

/** Append-only journal record persisted as NDJSON under state/brain/. */
export const BrainJournalEntrySchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("node"), at: z.string().datetime(), node: BrainNodeSchema }),
  z.object({ op: z.literal("fact"), at: z.string().datetime(), fact: BrainFactSchema }),
  z.object({
    op: z.literal("invalidate"),
    at: z.string().datetime(),
    factId: z.string().min(1).max(64),
    /** Valid-time end recorded with the invalidation, if known. */
    validTo: z.string().datetime().nullable(),
    reason: z.string().max(400),
  }),
  /**
   * Event-node recycling: only kind='event' nodes whose facts are ALL
   * bi-temporally invalidated are ever retired, and only to unblock a NEW
   * fact at the node cap. Entities, decisions, and bug fixes are never
   * recycled. Journals written before this op existed replay unchanged;
   * journals containing it are skipped (safeParse) by older readers.
   */
  z.object({
    op: z.literal("retire-node"),
    at: z.string().datetime(),
    nodeId: z.string().min(1).max(64),
    reason: z.string().max(400),
  }),
]);
export type BrainJournalEntry = z.infer<typeof BrainJournalEntrySchema>;

export type BrainGraphStats = {
  nodes: number;
  facts: number;
  currentFacts: number;
  invalidatedFacts: number;
  updatedAt: string | null;
  /** Facts refused because minting their nodes would exceed maxNodes. */
  droppedForNodeCapacity?: number;
};

/**
 * A queued contribution (for example a Home Fleet peer review that finished
 * while the iPhone was offline). Contributions carry their own transaction
 * timestamps; `mergeContributions` must produce the same final graph state
 * regardless of arrival order by sorting on (txCreatedAt, contentHash) and
 * deduplicating on contentHash before applying.
 */
export type BrainContribution = {
  txCreatedAt: string;
  origin: BrainFactOrigin;
  /** Free text the graph distills into subject/predicate/object facts. */
  text: string;
  /** Optional pre-extracted triples; free text is used when absent. */
  triples?: Array<{ subject: string; predicate: string; object: string; factText?: string }>;
  confidence?: number;
};

export interface KnowledgeGraphApi {
  load(): Promise<void>;
  /** Idempotent by normalizedName+kind; returns the canonical node. */
  assertNode(input: { kind: BrainNodeKind; name: string; summary?: string }): Promise<BrainNode>;
  /**
   * Idempotent by contentHash. When a new fact contradicts a current fact
   * with the same (subjectId, predicate) but different object, the older
   * fact is bi-temporally invalidated rather than overwritten.
   */
  assertFact(input: {
    subject: { kind: BrainNodeKind; name: string };
    predicate: string;
    object: { kind: BrainNodeKind; name: string };
    factText: string;
    origin: BrainFactOrigin;
    validFrom?: string;
    confidence?: number;
    /** Contradiction handling: "supersede" (default) or "coexist". */
    onConflict?: "supersede" | "coexist";
  }): Promise<BrainFact>;
  invalidateFact(factId: string, reason: string, validTo?: string | null): Promise<boolean>;
  /** Facts whose txInvalidatedAt is null (the graph's current beliefs). */
  currentFacts(): BrainFact[];
  /** Bi-temporal query: beliefs held at txTime about validity at validTime. */
  factsAsOf(validTime: string, txTime?: string): BrainFact[];
  nodes(): BrainNode[];
  nodeById(id: string): BrainNode | undefined;
  /** Current-fact adjacency for retrieval; includes both edge directions. */
  neighbors(nodeId: string): Array<{ fact: BrainFact; otherId: string }>;
  findNodesByName(query: string): BrainNode[];
  mergeContributions(contributions: BrainContribution[]): Promise<{ applied: number; duplicates: number }>;
  stats(): BrainGraphStats;
}

// ---------------------------------------------------------------------------
// Local LLM helper (entity extraction / distillation via local Ollama)
// ---------------------------------------------------------------------------

/**
 * A minimal local-generation interface. The default implementation calls the
 * loopback Ollama /api/generate endpoint with the auditor model and a JSON
 * instruction; every consumer must survive `null` (Ollama down) by falling
 * back to deterministic heuristics so tests and cold starts never block.
 */
export interface LocalLlm {
  /**
   * Returns parsed JSON matching the caller's described shape, or null.
   * `keepAlive` overrides the configured Ollama model residency for this one
   * call: background watcher distillation passes "0" so an opportunistic 7B
   * inference never pins gigabytes of unified memory between polls, while
   * job-lifecycle callers keep the configured residency for prompt-cache
   * warmth.
   */
  generateJson(prompt: string, options?: { timeoutMs?: number; keepAlive?: string }): Promise<unknown | null>;
  available(): Promise<boolean>;
}

export type ExtractedEntities = {
  entities: string[];
  /** Optional relation triples when the model supplied them. */
  triples: Array<{ subject: string; predicate: string; object: string }>;
  /** True when heuristics produced the result because the LLM was absent. */
  heuristic: boolean;
};

// ---------------------------------------------------------------------------
// HippoRAG retrieval
// ---------------------------------------------------------------------------

export type RankedFact = {
  fact: BrainFact;
  score: number;
  subjectName: string;
  objectName: string;
};

export type RetrievalResult = {
  /** Query entities that seeded Personalized PageRank. */
  entities: string[];
  /** Node ids that matched seed entities. */
  seedNodeIds: string[];
  facts: RankedFact[];
  /**
   * Bounded, prompt-ready context text with [brain:*] citations. Empty
   * string when the graph had nothing relevant.
   */
  contextText: string;
  /** True when entity extraction fell back to heuristics. */
  heuristic: boolean;
};

export interface RetrieverApi {
  /**
   * HippoRAG-style single-step multi-hop retrieval: extract entities from the
   * query, seed Personalized PageRank on matching graph nodes (weighted by
   * inverse node frequency), rank current facts by combined node scores, and
   * return bounded prompt context. Deterministic for a fixed graph + seeds.
   */
  retrieve(query: string, options?: { topK?: number; maxContextChars?: number }): Promise<RetrievalResult>;
}

// ---------------------------------------------------------------------------
// Anti-patterns and the Code Digital Twin
// ---------------------------------------------------------------------------

export const AntiPatternDetectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("regex"), pattern: z.string().min(1).max(400), flags: z.string().max(8).optional() }),
  z.object({ kind: z.literal("substring"), needle: z.string().min(1).max(200) }),
]);
export type AntiPatternDetector = z.infer<typeof AntiPatternDetectorSchema>;

export const AntiPatternSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(160),
  description: z.string().min(1).max(1_200),
  /** Language hint ("typescript", "any", ...) used to scope detection. */
  language: z.string().min(1).max(40),
  /** Explicit example beginning with a `// Wrong` marker line. */
  wrong: z.string().min(1).max(2_000),
  /** Explicit example beginning with a `// Correct` marker line. */
  correct: z.string().min(1).max(2_000),
  detector: AntiPatternDetectorSchema,
  /** Optional mechanical replacement applied by auto-correction. */
  autoFix: z.object({ find: z.string().min(1).max(400), replace: z.string().max(400), isRegex: z.boolean().default(false) }).optional(),
  severity: z.enum(["block", "warn"]),
  rationale: z.string().max(1_200),
  origin: BrainFactOriginSchema,
  createdAt: z.string().datetime(),
  /** Bi-temporal soft retirement; a retired pattern no longer detects. */
  retiredAt: z.string().datetime().nullable(),
});
export type AntiPattern = z.infer<typeof AntiPatternSchema>;

export const AntiPatternRegistryFileSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string().datetime(),
  patterns: z.array(AntiPatternSchema).max(400),
});
export type AntiPatternRegistryFile = z.infer<typeof AntiPatternRegistryFileSchema>;

export type AntiPatternViolation = {
  pattern: AntiPattern;
  /** 1-indexed line in the checked text where the detector matched. */
  line: number;
  excerpt: string;
  fixable: boolean;
};

export type AntiPatternCheck = {
  violations: AntiPatternViolation[];
  blocking: number;
  warnings: number;
  checkedChars: number;
};

export interface AntiPatternRegistryApi {
  load(): Promise<void>;
  list(options?: { includeRetired?: boolean }): AntiPattern[];
  add(input: Omit<AntiPattern, "id" | "createdAt" | "retiredAt">): Promise<AntiPattern>;
  retire(id: string, reason: string): Promise<boolean>;
  /** Runs every active detector against the text. Pure and deterministic. */
  check(text: string, options?: { language?: string }): AntiPatternCheck;
  /** Applies safe autoFix replacements; returns corrected text + count. */
  autoCorrect(text: string): { text: string; applied: number; appliedPatternIds: string[] };
  /** Bounded Wrong/Correct digest for prompts and the fleet bundle. */
  promptDigest(maxChars?: number): string;
}

export type DigitalTwinArtifact = {
  path: string;
  bytes: number;
  /** Exported symbol names discovered by bounded static scanning. */
  symbols: string[];
};

export interface DigitalTwinApi {
  /**
   * Rescans the workspace within the same exclusion boundaries as
   * workspace-context and records artifact nodes/facts in the graph.
   */
  syncArtifacts(): Promise<{ artifacts: number; changed: boolean }>;
  recordDecision(input: { title: string; rationale: string; tradeoff?: string; origin: BrainFactOrigin }): Promise<void>;
  recordBugFix(input: { title: string; cause: string; fix: string; origin: BrainFactOrigin }): Promise<void>;
  /** Past bug fixes / trade-offs relevant to the query, for prompt injection. */
  preventionContext(query: string, maxChars?: number): Promise<string>;
}

// ---------------------------------------------------------------------------
// Ambient capture
// ---------------------------------------------------------------------------

export type AmbientWatcherState = "active" | "unavailable" | "disabled";

export type AmbientCaptureStatus = {
  git: AmbientWatcherState;
  diagnostics: AmbientWatcherState;
  discussions: AmbientWatcherState;
  lastCaptureAt: string | null;
  capturedEvents: number;
};

export interface AmbientCaptureApi {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Called by the orchestrator for every idea/brief; no watcher needed. */
  captureDiscussion(input: { correlationId: string; role: "idea" | "brief" | "peer-review"; text: string; workerId?: string }): Promise<void>;
  status(): AmbientCaptureStatus;
}

// ---------------------------------------------------------------------------
// Fleet prefix cache (P2P context bundle + cache-aware routing)
// ---------------------------------------------------------------------------

/**
 * One redacted, content-addressed project-context bundle. It is compiled
 * from distilled graph facts, invariants, and the anti-pattern digest —
 * never raw workspace files, credentials, memory entries, or audit records.
 * Sharing it with Home Fleet workers requires the owner to set
 * HOME_FLEET_CONTEXT_SHARING=true on the coordinator; the default fleet
 * behaviour remains idea-text-only exactly as before.
 */
export const FleetContextBundleSchema = z.object({
  /** sha256 hex digest of `text`; the cache/routing key. */
  digest: z.string().length(64),
  text: z.string().min(1).max(24_000),
  compiledAt: z.string().datetime(),
  facts: z.number().int().nonnegative(),
  antiPatterns: z.number().int().nonnegative(),
});
export type FleetContextBundle = z.infer<typeof FleetContextBundleSchema>;

export type FleetCacheWorkerView = {
  workerId: string;
  /** Digests the worker reports as warmed into its local model cache. */
  warmDigests: string[];
  reportedAt: string;
};

export type FleetCacheStatus = {
  sharingEnabled: boolean;
  bundleDigest: string | null;
  bundleChars: number;
  bundleCompiledAt: string | null;
  workersWarm: number;
  /** P2P transfers observed between workers (metadata only). */
  peerTransfers: number;
};

// ---------------------------------------------------------------------------
// Facade + phone-facing status
// ---------------------------------------------------------------------------

/**
 * Path-free, bounded status snapshot safe to send to the paired phone. The
 * wire schema is owned by contracts.ts (BrainStatusEventSchema) so the phone
 * boundary has exactly one definition.
 */
export type { BrainStatusEvent as SecondBrainStatus } from "../contracts.js";

// ---------------------------------------------------------------------------
// Shared helpers (implemented here so every module agrees exactly)
// ---------------------------------------------------------------------------

/** Canonical name normalization used for node identity and entity matching. */
export function normalizeBrainName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[^a-z0-9./:_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

/** Strips control characters and collapses whitespace for stored text. */
export function sanitizeBrainText(value: string, maxChars: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

/**
 * Mirrors the audit trail's secret redaction so distilled facts and fleet
 * bundles can never carry familiar bearer/API-key material even if a watcher
 * ingests it from a diff or diagnostics run.
 */
const BRAIN_SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /("(?:api[_-]?key|token|secret|password)"\s*:\s*")[^"]+/gi,
  /\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*[^\s"']{8,}/gi,
];

export function redactBrainText(value: string): string {
  return BRAIN_SECRET_PATTERNS.reduce(
    (clean, pattern) => clean.replace(pattern, match => {
      if (match.startsWith('"')) return `${match.slice(0, match.indexOf(":") + 2)}[REDACTED]`;
      return "[REDACTED]";
    }),
    value,
  );
}
