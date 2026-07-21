import "dotenv/config";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

/**
 * Installing the bridge turns a laptop into a small always-on database and
 * inference host. Those duties must fit the machine they land on, so any
 * capacity knob the owner did NOT set explicitly is sized from the laptop's
 * physical memory instead of a one-size default. The tiers deliberately
 * mirror the phone-facing fleet profiles (compact / balanced / power /
 * studio) so the whole product speaks one sizing language.
 */
export type BrainCapacityTier = "compact" | "balanced" | "power" | "studio";

type AdaptiveDefaults = {
  /** Context window requested from local Ollama when no profile chose one. */
  ollamaNumCtx: number;
  brainMaxNodes: number;
  brainMaxFacts: number;
  brainRetrievalTopK: number;
  brainRetrievalMaxChars: number;
  /** Slower ambient observation on small machines; the watcher is a guest. */
  ambientGitPollMs: number;
  /** Worker model residency after a context bundle: RAM is the real cost. */
  homeFleetWorkerKeepAlive: string;
};

const GIB = 1024 ** 3;

const ADAPTIVE_TIERS: Array<{ tier: BrainCapacityTier; minTotalMemoryBytes: number; defaults: AdaptiveDefaults }> = [
  { tier: "studio", minTotalMemoryBytes: 48 * GIB, defaults: { ollamaNumCtx: 32_768, brainMaxNodes: 8_000, brainMaxFacts: 24_000, brainRetrievalTopK: 16, brainRetrievalMaxChars: 6_000, ambientGitPollMs: 45_000, homeFleetWorkerKeepAlive: "10m" } },
  { tier: "power", minTotalMemoryBytes: 24 * GIB, defaults: { ollamaNumCtx: 32_768, brainMaxNodes: 4_000, brainMaxFacts: 12_000, brainRetrievalTopK: 12, brainRetrievalMaxChars: 4_000, ambientGitPollMs: 45_000, homeFleetWorkerKeepAlive: "10m" } },
  { tier: "balanced", minTotalMemoryBytes: 12 * GIB, defaults: { ollamaNumCtx: 16_384, brainMaxNodes: 3_000, brainMaxFacts: 8_000, brainRetrievalTopK: 10, brainRetrievalMaxChars: 3_200, ambientGitPollMs: 60_000, homeFleetWorkerKeepAlive: "5m" } },
  { tier: "compact", minTotalMemoryBytes: 0, defaults: { ollamaNumCtx: 8_192, brainMaxNodes: 1_500, brainMaxFacts: 4_000, brainRetrievalTopK: 8, brainRetrievalMaxChars: 2_400, ambientGitPollMs: 90_000, homeFleetWorkerKeepAlive: "2m" } },
];

export function resolveBrainCapacityTier(totalMemoryBytes: number): BrainCapacityTier {
  return (ADAPTIVE_TIERS.find(entry => totalMemoryBytes >= entry.minTotalMemoryBytes) ?? ADAPTIVE_TIERS[ADAPTIVE_TIERS.length - 1]!).tier;
}

const BooleanFromEnv = z.enum(["true", "false"]).transform(value => value === "true");
const Currency = z.coerce.number().finite().nonnegative();

/**
 * The zero-configuration local team. Exported so user-facing commands can
 * recognize "the owner never chose a model" without repeating the tag.
 */
export const DEFAULT_LOCAL_MODEL = "qwen2.5-coder:7b-instruct-q4_K_M";

const ConfigObjectSchema = z.object({
  port: z.coerce.number().int().min(1024).max(65535).default(8787),
  // An empty value in the checked-in .env.example means "generate/persist a
  // safe workspace relay name", not a configuration error.
  tunnelSubdomain: z.preprocess(
    value => typeof value === "string" && !value.trim() ? undefined : value,
    z.string().trim().min(1).max(63).regex(/^[a-zA-Z0-9-]+$/).optional(),
  ),
  // All unqualified paths are resolved from the caller's current directory,
  // rather than from this npm package. That makes a global `omnibus-bridge`
  // installation keep its audit trail and optional Codex workspace under the
  // owner's project, not inside node_modules.
  workspaceRoot: z.string().min(1).default("."),
  hostExecutionEnabled: BooleanFromEnv.default("false"),
  // A running local coordinator/worker is active infrastructure, so keep an
  // owner laptop awake with its platform-native user-process assertion by
  // default. This never changes the system power plan and can be disabled for
  // battery-sensitive use with OMNIBUS_KEEP_AWAKE=false.
  keepAwakeEnabled: BooleanFromEnv.default("true"),
  // Ollama is intentionally the default: the core ideation workflow runs on
  // the owner's laptop and does not need an API key or a paid-model budget.
  developerProvider: z.enum(["ollama", "codex-cli", "responses"]).default("ollama"),
  openaiApiKey: z.string().min(1).optional(),
  openaiModel: z.string().min(1).default("gpt-5.6"),
  codexCommand: z.string().min(1).default("codex"),
  openAiInputUsdPerMillion: Currency.default(0),
  openAiOutputUsdPerMillion: Currency.default(0),
  maxDeveloperOutputTokens: z.coerce.number().int().min(256).max(32_000).default(6_000),
  ollamaBaseUrl: z.string().url().default("http://127.0.0.1:11434"),
  // Mirrors Ollama's optional storage-location environment variable. It is
  // used only for a local filesystem-capacity probe and never leaves the
  // laptop in the paired capability snapshot.
  ollamaModelsPath: z.string().trim().min(1).optional(),
  ollamaModel: z.string().min(1).default(DEFAULT_LOCAL_MODEL),
  // This can point at a larger local model than the fast auditor when the
  // laptop has the available memory. It defaults to the auditor model so a
  // fresh install remains zero-configuration and fully local.
  ollamaDeveloperModel: z.string().min(1).default(DEFAULT_LOCAL_MODEL),
  ollamaNumCtx: z.coerce.number().int().min(4096).max(131_072).default(32_768),
  // Sent on each local generation request. It bounds how long a selected
  // fleet remains resident after a job without changing Ollama's global
  // process configuration or affecting another local application.
  ollamaKeepAlive: z.string().trim().regex(/^(?:-1|0|[1-9][0-9]*(?:ms|s|m|h))$/).default("5m"),
  /**
   * Private-LAN Home Fleet settings. These are owner-side only: the paired
   * phone can request an invitation or per-idea review, but cannot alter a
   * listener address, port, model, or worker limit.
   */
  homeFleetCoordinatorPort: z.coerce.number().int().min(1024).max(65535).default(8791),
  homeFleetWorkerPort: z.coerce.number().int().min(1024).max(65535).default(8792),
  homeFleetBindHost: z.string().trim().min(1).max(128).optional(),
  homeFleetMaxWorkers: z.coerce.number().int().min(1).max(8).default(4),
  // A spare laptop is a fixed peer-review role, intentionally smaller than a
  // coordinator's full Auditor + Developer team. This value is owner-local
  // configuration; it never crosses the public tunnel or a worker invite.
  homeFleetWorkerModel: z.string().trim().min(1).max(160).default("qwen2.5-coder:1.5b"),
  homeFleetWorkerNumCtx: z.coerce.number().int().min(4_096).max(32_768).default(8_192),
  /**
   * Worker model residency once a context bundle is held. Idle workers keep
   * unloading after each review (keep_alive "0"); a worker that accepted the
   * owner's opt-in context bundle keeps its small model warm this long so the
   * pre-computed prompt prefix actually survives between peer reviews.
   */
  homeFleetWorkerKeepAlive: z.string().trim().regex(/^(?:-1|0|[1-9][0-9]*(?:ms|s|m|h))$/).default("10m"),
  // Web research is off unless the laptop owner opts in. Its key can live in
  // the environment *or* the private QR-paired settings store, so key
  // availability is finalized after configuration is loaded. The provider
  // only ever receives that request's idea/query -- never workspace files,
  // local memory, audit history, or model credentials.
  webResearchEnabled: BooleanFromEnv.default("false"),
  webResearchProvider: z.literal("brave").default("brave"),
  braveSearchApiKey: z.string().min(1).optional(),
  webResearchMaxResults: z.coerce.number().int().min(1).max(8).default(5),
  webResearchTimeoutMs: z.coerce.number().int().min(1_000).max(30_000).default(12_000),
  webResearchQueryMaxChars: z.coerce.number().int().min(80).max(400).default(400),
  webResearchMaxContentChars: z.coerce.number().int().min(512).max(10_000).default(5_000),
  higgsfieldCommand: z.string().min(1).default("higgsfield"),
  higgsfieldExecutionEnabled: BooleanFromEnv.default("false"),
  higgsfieldSoulId: z.string().trim().min(1).optional(),
  auditDir: z.string().min(1).default(".omnibus/audit"),
  stateDir: z.string().min(1).default(".omnibus/state"),
  // The bridge accepts a small burst from paired devices, but executes one
  // durable job at a time. Limits are intentionally low so local models do
  // not accumulate unbounded GPU/CPU work while a laptop is unattended.
  queueMaxPending: z.coerce.number().int().min(1).max(64).default(12),
  queueMaxAttempts: z.coerce.number().int().min(1).max(8).default(3),
  queueRetryBaseMs: z.coerce.number().int().min(250).max(120_000).default(1_500),
  // Safe workspace context is opt-in by construction: it is a bounded,
  // local filesystem scan used only by the local Auditor, never a broad
  // source upload or a recursive codebase index.
  workspaceContextMaxFiles: z.coerce.number().int().min(1).max(64).default(24),
  workspaceContextMaxSnippets: z.coerce.number().int().min(0).max(12).default(4),
  workspaceContextMaxChars: z.coerce.number().int().min(512).max(24_000).default(8_000),
  /**
   * The Second Brain is the persistent local knowledge layer: a bi-temporal
   * knowledge graph, HippoRAG retrieval, the Code Digital Twin, ambient
   * capture, and anti-pattern enforcement. It is local-first state under
   * .omnibus/state/brain and can be disabled entirely with one switch.
   */
  secondBrainEnabled: BooleanFromEnv.default("true"),
  // Ambient git observation is a bounded, read-only `git status/diff --stat`
  // poll of the owner workspace. It never runs hooks, never writes, and is
  // quietly unavailable when the workspace is not a git repository.
  ambientGitPollMs: z.coerce.number().int().min(5_000).max(3_600_000).default(45_000),
  /**
   * Optional owner-configured diagnostics command (for example "tsc --noEmit"
   * or "cargo check"). It is split on whitespace and spawned without a shell.
   * Ambient diagnostics stay off until the owner explicitly names a command;
   * the bridge never guesses or auto-runs a project's build system.
   */
  ambientCheckCommand: z.preprocess(
    value => typeof value === "string" && !value.trim() ? undefined : value,
    z.string().trim().min(1).max(400).optional(),
  ),
  ambientCheckIntervalMs: z.coerce.number().int().min(30_000).max(6 * 3_600_000).default(300_000),
  brainMaxNodes: z.coerce.number().int().min(100).max(50_000).default(4_000),
  brainMaxFacts: z.coerce.number().int().min(200).max(200_000).default(12_000),
  brainRetrievalTopK: z.coerce.number().int().min(1).max(64).default(12),
  brainRetrievalMaxChars: z.coerce.number().int().min(512).max(12_000).default(4_000),
  /**
   * A third, independent consent boundary for the Home Fleet. When true, the
   * coordinator may share one redacted, content-addressed knowledge bundle
   * (distilled facts + anti-pattern digest — never raw workspace files,
   * memory entries, credentials, or audit records) with approved workers so
   * their local models answer with a warm prompt prefix. Off by default:
   * without it the fleet remains idea-text-only exactly as before.
   */
  homeFleetContextSharing: BooleanFromEnv.default("false"),
  /** Pre-commit gate: mechanical anti-pattern checks are bounded by this. */
  precommitTimeoutMs: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  // The optional agentic pre-commit layer asks the local auditor model to
  // compare a staged diff against retrieved anti-patterns. Advisory only and
  // fail-open: a missing model can never brick an owner's commit.
  precommitLlmEnabled: BooleanFromEnv.default("false"),
});

const ConfigSchema = ConfigObjectSchema.superRefine((value, ctx) => {
  if (value.developerProvider === "responses" && !value.openaiApiKey) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "OPENAI_API_KEY is required for DEVELOPER_PROVIDER=responses" });
  }
});

/**
 * The single source of truth mapping each config key to the environment
 * variable an owner actually types. Configuration errors are reported in this
 * vocabulary: internal camelCase key names must never appear in a message the
 * owner is expected to act on.
 */
const ENV_SOURCES = {
  port: "PORT",
  tunnelSubdomain: "TUNNEL_SUBDOMAIN",
  workspaceRoot: "WORKSPACE_ROOT",
  hostExecutionEnabled: "HOST_EXECUTION_ENABLED",
  keepAwakeEnabled: "OMNIBUS_KEEP_AWAKE",
  developerProvider: "DEVELOPER_PROVIDER",
  openaiApiKey: "OPENAI_API_KEY",
  openaiModel: "OPENAI_MODEL",
  codexCommand: "CODEX_COMMAND",
  openAiInputUsdPerMillion: "OPENAI_INPUT_USD_PER_MILLION",
  openAiOutputUsdPerMillion: "OPENAI_OUTPUT_USD_PER_MILLION",
  maxDeveloperOutputTokens: "MAX_DEVELOPER_OUTPUT_TOKENS",
  ollamaBaseUrl: "OLLAMA_BASE_URL",
  ollamaModelsPath: "OLLAMA_MODELS",
  ollamaModel: "OLLAMA_MODEL",
  ollamaDeveloperModel: "OLLAMA_DEVELOPER_MODEL",
  ollamaNumCtx: "OLLAMA_NUM_CTX",
  ollamaKeepAlive: "OMNIBUS_OLLAMA_KEEP_ALIVE",
  homeFleetCoordinatorPort: "HOME_FLEET_COORDINATOR_PORT",
  homeFleetWorkerPort: "HOME_FLEET_WORKER_PORT",
  homeFleetBindHost: "HOME_FLEET_BIND_HOST",
  homeFleetMaxWorkers: "HOME_FLEET_MAX_WORKERS",
  homeFleetWorkerModel: "HOME_FLEET_WORKER_MODEL",
  homeFleetWorkerNumCtx: "HOME_FLEET_WORKER_NUM_CTX",
  homeFleetWorkerKeepAlive: "HOME_FLEET_WORKER_KEEP_ALIVE",
  webResearchEnabled: "WEB_RESEARCH_ENABLED",
  webResearchProvider: "WEB_RESEARCH_PROVIDER",
  braveSearchApiKey: "BRAVE_SEARCH_API_KEY",
  webResearchMaxResults: "WEB_RESEARCH_MAX_RESULTS",
  webResearchTimeoutMs: "WEB_RESEARCH_TIMEOUT_MS",
  webResearchQueryMaxChars: "WEB_RESEARCH_QUERY_MAX_CHARS",
  webResearchMaxContentChars: "WEB_RESEARCH_MAX_CONTENT_CHARS",
  higgsfieldCommand: "HIGGSFIELD_COMMAND",
  higgsfieldExecutionEnabled: "HIGGSFIELD_EXECUTION_ENABLED",
  higgsfieldSoulId: "HIGGSFIELD_SOUL_ID",
  auditDir: "AUDIT_DIR",
  stateDir: "STATE_DIR",
  queueMaxPending: "QUEUE_MAX_PENDING",
  queueMaxAttempts: "QUEUE_MAX_ATTEMPTS",
  queueRetryBaseMs: "QUEUE_RETRY_BASE_MS",
  workspaceContextMaxFiles: "WORKSPACE_CONTEXT_MAX_FILES",
  workspaceContextMaxSnippets: "WORKSPACE_CONTEXT_MAX_SNIPPETS",
  workspaceContextMaxChars: "WORKSPACE_CONTEXT_MAX_CHARS",
  secondBrainEnabled: "OMNIBUS_SECOND_BRAIN",
  ambientGitPollMs: "OMNIBUS_AMBIENT_GIT_POLL_MS",
  ambientCheckCommand: "OMNIBUS_AMBIENT_CHECK_COMMAND",
  ambientCheckIntervalMs: "OMNIBUS_AMBIENT_CHECK_INTERVAL_MS",
  brainMaxNodes: "OMNIBUS_BRAIN_MAX_NODES",
  brainMaxFacts: "OMNIBUS_BRAIN_MAX_FACTS",
  brainRetrievalTopK: "OMNIBUS_BRAIN_RETRIEVAL_TOP_K",
  brainRetrievalMaxChars: "OMNIBUS_BRAIN_RETRIEVAL_MAX_CHARS",
  homeFleetContextSharing: "HOME_FLEET_CONTEXT_SHARING",
  precommitTimeoutMs: "OMNIBUS_PRECOMMIT_TIMEOUT_MS",
  precommitLlmEnabled: "OMNIBUS_PRECOMMIT_LLM",
} as const satisfies Record<keyof z.infer<typeof ConfigObjectSchema>, string>;

type ConfigKey = keyof typeof ENV_SOURCES;

/**
 * The plain-language shape of one schema field, recovered by unwrapping the
 * default/optional/effect layers. Deriving this from the schema itself (not a
 * parallel hand-written table) keeps error text honest when a bound changes.
 */
type FieldFacts =
  | { kind: "number"; min?: number; max?: number }
  | { kind: "duration" }
  | { kind: "boolean" }
  | { kind: "enum"; values: string[] }
  | { kind: "url" }
  | { kind: "other" };

function fieldFacts(key: ConfigKey): FieldFacts {
  let node: z.ZodTypeAny | undefined = (ConfigObjectSchema.shape as Record<string, z.ZodTypeAny>)[key];
  while (node) {
    if (node instanceof z.ZodDefault) { node = node._def.innerType as z.ZodTypeAny; continue; }
    if (node instanceof z.ZodOptional || node instanceof z.ZodNullable) { node = node.unwrap() as z.ZodTypeAny; continue; }
    if (node instanceof z.ZodEffects) { node = node._def.schema as z.ZodTypeAny; continue; }
    break;
  }
  if (node instanceof z.ZodNumber) {
    let min: number | undefined;
    let max: number | undefined;
    for (const check of node._def.checks) {
      if (check.kind === "min") min = check.value;
      if (check.kind === "max") max = check.value;
    }
    return { kind: "number", ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
  }
  if (node instanceof z.ZodEnum) {
    const values = node._def.values as string[];
    if (values.length === 2 && values.includes("true") && values.includes("false")) return { kind: "boolean" };
    return { kind: "enum", values };
  }
  if (node instanceof z.ZodLiteral) return { kind: "enum", values: [String(node._def.value)] };
  if (node instanceof z.ZodString) {
    const checks = node._def.checks;
    // The keep-alive fields are the only regex-guarded durations; recognize
    // them by their unit alternation instead of hard-coding key names.
    if (checks.some(check => check.kind === "regex" && check.regex.source.includes("ms|s|m|h"))) return { kind: "duration" };
    if (checks.some(check => check.kind === "url")) return { kind: "url" };
  }
  return { kind: "other" };
}

/** Bounded, control-character-free echo of the offending environment value. */
function clipEnvValue(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ");
  return cleaned.length > 60 ? `${cleaned.slice(0, 60)}…` : cleaned;
}

function describeConfigIssue(issue: z.ZodIssue, env: NodeJS.ProcessEnv): string {
  const key = typeof issue.path[0] === "string" ? issue.path[0] as ConfigKey : undefined;
  // superRefine issues carry no path and are already written in ENV VAR terms.
  if (!key) return issue.message;
  const envVar = ENV_SOURCES[key] ?? key;
  const raw = env[envVar];
  const shown = raw === undefined ? envVar : `${envVar}=${clipEnvValue(raw)}`;
  const facts = fieldFacts(key);
  switch (facts.kind) {
    case "duration":
      return `${shown} must look like 5m, 30s, 0 or -1`;
    case "number": {
      const bounds = facts.min !== undefined && facts.max !== undefined
        ? `${facts.min}–${facts.max}`
        : facts.min !== undefined ? `${facts.min} or more`
        : facts.max !== undefined ? `up to ${facts.max}` : "";
      const allowed = bounds ? ` (allowed ${bounds})` : "";
      if (issue.code === z.ZodIssueCode.too_small || issue.code === z.ZodIssueCode.too_big) {
        return `${shown} is out of range${allowed}`;
      }
      if (issue.code === z.ZodIssueCode.invalid_type && issue.expected === "integer") {
        return `${shown} is not a whole number${allowed}`;
      }
      return `${shown} is not a number${allowed}`;
    }
    case "boolean":
      return `${shown} must be true or false`;
    case "enum":
      return `${shown} must be one of: ${facts.values.join(", ")}`;
    case "url":
      return `${shown} must be a full URL such as http://127.0.0.1:11434`;
    case "other":
      return `${shown}: ${issue.message}`;
  }
}

/**
 * One actionable line per problem, phrased with the ENV VAR the owner can
 * actually change — never raw Zod JSON or internal camelCase key names.
 */
export function formatConfigIssues(issues: z.ZodIssue[], env: NodeJS.ProcessEnv): string {
  const lines = issues.slice(0, 20).map(issue => `  - ${describeConfigIssue(issue, env)}`);
  return ["Bridge configuration is invalid:", ...lines].join("\n");
}

export type AppConfig = z.infer<typeof ConfigSchema> & {
  workspacePath: string;
  auditPath: string;
  statePath: string;
  /** The adaptive sizing tier this configuration resolved against. */
  brainCapacityTier: BrainCapacityTier;
};

export type LoadConfigOptions = {
  /** Mainly useful for deterministic tests and embedded CLI callers. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable for deterministic tests; defaults to this machine's RAM. */
  totalMemoryBytes?: number;
};

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = options.env ?? process.env;
  const rawInput: Partial<Record<ConfigKey, string | undefined>> = {};
  for (const [key, envVar] of Object.entries(ENV_SOURCES) as Array<[ConfigKey, string]>) {
    rawInput[key] = env[envVar];
  }
  const result = ConfigSchema.safeParse(rawInput);
  if (!result.success) {
    throw new Error(formatConfigIssues(result.error.issues, env));
  }
  const parsed = result.data;

  // Adaptive overlay: a knob the owner set explicitly (env var present)
  // always wins; anything left at its schema default is re-sized to this
  // laptop's physical memory so a fresh install never asks an 8 GB machine
  // for a 32k context window or a 12k-fact knowledge graph.
  const totalMemoryBytes = options.totalMemoryBytes ?? os.totalmem();
  const tierEntry = ADAPTIVE_TIERS.find(entry => totalMemoryBytes >= entry.minTotalMemoryBytes) ?? ADAPTIVE_TIERS[ADAPTIVE_TIERS.length - 1]!;
  const isSet = (value: string | undefined): boolean => typeof value === "string" && value.trim().length > 0;
  const adapted = {
    ollamaNumCtx: isSet(env.OLLAMA_NUM_CTX) ? parsed.ollamaNumCtx : tierEntry.defaults.ollamaNumCtx,
    brainMaxNodes: isSet(env.OMNIBUS_BRAIN_MAX_NODES) ? parsed.brainMaxNodes : tierEntry.defaults.brainMaxNodes,
    brainMaxFacts: isSet(env.OMNIBUS_BRAIN_MAX_FACTS) ? parsed.brainMaxFacts : tierEntry.defaults.brainMaxFacts,
    brainRetrievalTopK: isSet(env.OMNIBUS_BRAIN_RETRIEVAL_TOP_K) ? parsed.brainRetrievalTopK : tierEntry.defaults.brainRetrievalTopK,
    brainRetrievalMaxChars: isSet(env.OMNIBUS_BRAIN_RETRIEVAL_MAX_CHARS) ? parsed.brainRetrievalMaxChars : tierEntry.defaults.brainRetrievalMaxChars,
    ambientGitPollMs: isSet(env.OMNIBUS_AMBIENT_GIT_POLL_MS) ? parsed.ambientGitPollMs : tierEntry.defaults.ambientGitPollMs,
    homeFleetWorkerKeepAlive: isSet(env.HOME_FLEET_WORKER_KEEP_ALIVE) ? parsed.homeFleetWorkerKeepAlive : tierEntry.defaults.homeFleetWorkerKeepAlive,
  };

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const workspacePath = resolveOwnerPath(cwd, parsed.workspaceRoot);
  return {
    ...parsed,
    ...adapted,
    brainCapacityTier: tierEntry.tier,
    workspacePath,
    ...(parsed.ollamaModelsPath ? { ollamaModelsPath: resolveOwnerPath(workspacePath, parsed.ollamaModelsPath) } : {}),
    auditPath: resolveOwnerPath(workspacePath, parsed.auditDir),
    statePath: resolveOwnerPath(workspacePath, parsed.stateDir),
  };
}

function resolveOwnerPath(base: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(base, value);
}
