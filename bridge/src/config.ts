import "dotenv/config";
import path from "node:path";
import { z } from "zod";

const BooleanFromEnv = z.enum(["true", "false"]).transform(value => value === "true");
const Currency = z.coerce.number().finite().nonnegative();

const ConfigSchema = z.object({
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
  ollamaModel: z.string().min(1).default("qwen2.5-coder:7b-instruct-q4_K_M"),
  // This can point at a larger local model than the fast auditor when the
  // laptop has the available memory. It defaults to the auditor model so a
  // fresh install remains zero-configuration and fully local.
  ollamaDeveloperModel: z.string().min(1).default("qwen2.5-coder:7b-instruct-q4_K_M"),
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
}).superRefine((value, ctx) => {
  if (value.developerProvider === "responses" && !value.openaiApiKey) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "OPENAI_API_KEY is required for DEVELOPER_PROVIDER=responses" });
  }
});

export type AppConfig = z.infer<typeof ConfigSchema> & {
  workspacePath: string;
  auditPath: string;
  statePath: string;
};

export type LoadConfigOptions = {
  /** Mainly useful for deterministic tests and embedded CLI callers. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = options.env ?? process.env;
  const parsed = ConfigSchema.parse({
    port: env.PORT,
    tunnelSubdomain: env.TUNNEL_SUBDOMAIN,
    workspaceRoot: env.WORKSPACE_ROOT,
    hostExecutionEnabled: env.HOST_EXECUTION_ENABLED,
    keepAwakeEnabled: env.OMNIBUS_KEEP_AWAKE,
    developerProvider: env.DEVELOPER_PROVIDER,
    openaiApiKey: env.OPENAI_API_KEY,
    openaiModel: env.OPENAI_MODEL,
    codexCommand: env.CODEX_COMMAND,
    openAiInputUsdPerMillion: env.OPENAI_INPUT_USD_PER_MILLION,
    openAiOutputUsdPerMillion: env.OPENAI_OUTPUT_USD_PER_MILLION,
    maxDeveloperOutputTokens: env.MAX_DEVELOPER_OUTPUT_TOKENS,
    ollamaBaseUrl: env.OLLAMA_BASE_URL,
    ollamaModelsPath: env.OLLAMA_MODELS,
    ollamaModel: env.OLLAMA_MODEL,
    ollamaDeveloperModel: env.OLLAMA_DEVELOPER_MODEL,
    ollamaNumCtx: env.OLLAMA_NUM_CTX,
    ollamaKeepAlive: env.OMNIBUS_OLLAMA_KEEP_ALIVE,
    homeFleetCoordinatorPort: env.HOME_FLEET_COORDINATOR_PORT,
    homeFleetWorkerPort: env.HOME_FLEET_WORKER_PORT,
    homeFleetBindHost: env.HOME_FLEET_BIND_HOST,
    homeFleetMaxWorkers: env.HOME_FLEET_MAX_WORKERS,
    homeFleetWorkerModel: env.HOME_FLEET_WORKER_MODEL,
    homeFleetWorkerNumCtx: env.HOME_FLEET_WORKER_NUM_CTX,
    homeFleetWorkerKeepAlive: env.HOME_FLEET_WORKER_KEEP_ALIVE,
    webResearchEnabled: env.WEB_RESEARCH_ENABLED,
    webResearchProvider: env.WEB_RESEARCH_PROVIDER,
    braveSearchApiKey: env.BRAVE_SEARCH_API_KEY,
    webResearchMaxResults: env.WEB_RESEARCH_MAX_RESULTS,
    webResearchTimeoutMs: env.WEB_RESEARCH_TIMEOUT_MS,
    webResearchQueryMaxChars: env.WEB_RESEARCH_QUERY_MAX_CHARS,
    webResearchMaxContentChars: env.WEB_RESEARCH_MAX_CONTENT_CHARS,
    higgsfieldCommand: env.HIGGSFIELD_COMMAND,
    higgsfieldExecutionEnabled: env.HIGGSFIELD_EXECUTION_ENABLED,
    higgsfieldSoulId: env.HIGGSFIELD_SOUL_ID,
    auditDir: env.AUDIT_DIR,
    stateDir: env.STATE_DIR,
    queueMaxPending: env.QUEUE_MAX_PENDING,
    queueMaxAttempts: env.QUEUE_MAX_ATTEMPTS,
    queueRetryBaseMs: env.QUEUE_RETRY_BASE_MS,
    workspaceContextMaxFiles: env.WORKSPACE_CONTEXT_MAX_FILES,
    workspaceContextMaxSnippets: env.WORKSPACE_CONTEXT_MAX_SNIPPETS,
    workspaceContextMaxChars: env.WORKSPACE_CONTEXT_MAX_CHARS,
    secondBrainEnabled: env.OMNIBUS_SECOND_BRAIN,
    ambientGitPollMs: env.OMNIBUS_AMBIENT_GIT_POLL_MS,
    ambientCheckCommand: env.OMNIBUS_AMBIENT_CHECK_COMMAND,
    ambientCheckIntervalMs: env.OMNIBUS_AMBIENT_CHECK_INTERVAL_MS,
    brainMaxNodes: env.OMNIBUS_BRAIN_MAX_NODES,
    brainMaxFacts: env.OMNIBUS_BRAIN_MAX_FACTS,
    brainRetrievalTopK: env.OMNIBUS_BRAIN_RETRIEVAL_TOP_K,
    brainRetrievalMaxChars: env.OMNIBUS_BRAIN_RETRIEVAL_MAX_CHARS,
    homeFleetContextSharing: env.HOME_FLEET_CONTEXT_SHARING,
    precommitTimeoutMs: env.OMNIBUS_PRECOMMIT_TIMEOUT_MS,
    precommitLlmEnabled: env.OMNIBUS_PRECOMMIT_LLM,
  });

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const workspacePath = resolveOwnerPath(cwd, parsed.workspaceRoot);
  return {
    ...parsed,
    workspacePath,
    ...(parsed.ollamaModelsPath ? { ollamaModelsPath: resolveOwnerPath(workspacePath, parsed.ollamaModelsPath) } : {}),
    auditPath: resolveOwnerPath(workspacePath, parsed.auditDir),
    statePath: resolveOwnerPath(workspacePath, parsed.stateDir),
  };
}

function resolveOwnerPath(base: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(base, value);
}
