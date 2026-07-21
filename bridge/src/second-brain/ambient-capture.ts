import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AuditTrail } from "../audit.js";
import type { AppConfig } from "../config.js";
import {
  redactBrainText,
  sanitizeBrainText,
  type AmbientCaptureApi,
  type AmbientCaptureStatus,
  type AmbientWatcherState,
  type BrainContribution,
  type KnowledgeGraphApi,
  type LocalLlm,
} from "./types.js";

/**
 * Ambient capture is the "no manual filing" layer of the Second Brain: it
 * observes what already happens on the owner's laptop — git working-tree
 * churn, an owner-named diagnostics command, and idea/brief/fleet-review
 * discussions — and distills each into bounded, redacted graph facts.
 *
 * Boundaries this module enforces:
 * - Git observation is strictly read-only (`status`/`log`/`diff --stat`),
 *   never runs hooks, and degrades to "unavailable" outside a repository.
 * - The diagnostics command is split on whitespace and spawned without a
 *   shell; pipes, redirects, and other shell syntax are unsupported by
 *   design so configuration can never smuggle a compound command.
 * - Every stored string passes redactBrainText + sanitizeBrainText, and the
 *   audit trail receives counts and fingerprints only — never diff bodies.
 * - Nothing here emits phone-bound events; all output is local graph state.
 */

export type RunCommand = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: Record<string, string> },
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

const STREAM_CAP_BYTES = 64 * 1024;
const GIT_COMMAND_TIMEOUT_MS = 10_000;
const DIAGNOSTICS_TIMEOUT_MS = 120_000;
const LLM_TIMEOUT_MS = 20_000;
/**
 * Watcher timers fire every poll interval, but a background 7B inference per
 * poll (~80/hour) would keep the laptop's GPU/memory hot around the clock.
 * Each watcher gets at most one LLM distillation attempt per this window;
 * every other poll uses the deterministic heuristics.
 */
const WATCHER_LLM_MIN_INTERVAL_MS = 10 * 60 * 1_000;
const MAX_GIT_PATH_FACTS = 20;
const MAX_DIAGNOSTIC_FACTS = 10;
const MAX_LLM_TRIPLES = 6;
const AMBIENT_CORRELATION_ID = "ambient";

const DISCUSSION_BOUNDS: Record<"idea" | "brief" | "peer-review", number> = {
  idea: 2_000,
  brief: 4_000,
  "peer-review": 900,
};

const BUGFIX_SUBJECT = /\b(fix|bug|regress|hotfix|revert)/i;
const DIAGNOSTIC_LINE = /(error|warning)\s*(TS\d+|E\d{2,4}|C\d{3,4}|\[.+?\])?\s*[:.]/i;
const DIAGNOSTIC_FILE = /^([\w@./\\-]+\.[A-Za-z0-9]{1,8})(?=[(:\s])/;

const TripleSchema = z.object({
  subject: z.string().min(1).max(240),
  predicate: z.string().min(1).max(120),
  object: z.string().min(1).max(240),
  factText: z.string().max(1_200).optional(),
});
type Triple = z.infer<typeof TripleSchema>;

/** Cursor state persisted so a restart never re-captures old git output. */
const CursorSchema = z.object({
  version: z.literal(1),
  fingerprint: z.string().max(64),
  head: z.string().max(64).nullable(),
  updatedAt: z.string(),
});
type CursorState = z.infer<typeof CursorSchema>;

/**
 * Default executor: no shell, bounded output, hard kill on timeout. It never
 * rejects — a missing binary or timeout is an { ok: false } observation, not
 * an exception a background timer would have to survive.
 */
export const defaultRunCommand: RunCommand = (command, args, options) =>
  new Promise(resolve => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ok, stdout, stderr });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
      });
    } catch {
      resolve({ ok: false, stdout: "", stderr: "" });
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish(false);
    }, options.timeoutMs);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < STREAM_CAP_BYTES) stdout += chunk.toString("utf8").slice(0, STREAM_CAP_BYTES - stdout.length);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STREAM_CAP_BYTES) stderr += chunk.toString("utf8").slice(0, STREAM_CAP_BYTES - stderr.length);
    });
    child.on("error", () => finish(false));
    child.on("close", code => finish(code === 0));
  });

export type AmbientCaptureOptions = {
  workspacePath: string;
  brainDir: string;
  graph: KnowledgeGraphApi;
  llm: LocalLlm;
  /**
   * Distillation model for captureDiscussion. Watcher timers race a live
   * inference job and use the (usually busy-gated) `llm`; discussion capture
   * is invoked from within the job lifecycle itself — already serialized with
   * agent inference — so it may use an ungated handle. Defaults to `llm`.
   */
  discussionLlm?: LocalLlm;
  /**
   * Capacity gate for LLM distillation: when this returns false (typically
   * because graph.stats().nodes is near the node cap and new triples would
   * mostly be dropped or recycled), the LLM triple-extraction call is skipped
   * entirely and heuristics run instead — the brain must never pay inference
   * cost for knowledge it cannot keep. Defaults to always-on.
   */
  shouldDistill?: () => boolean;
  audit: AuditTrail;
  config: Pick<AppConfig, "secondBrainEnabled" | "ambientGitPollMs" | "ambientCheckCommand" | "ambientCheckIntervalMs">;
  now?: () => Date;
  runCommand?: RunCommand;
};

export class AmbientCaptureService implements AmbientCaptureApi {
  private readonly workspacePath: string;
  private readonly brainDir: string;
  private readonly graph: KnowledgeGraphApi;
  private readonly llm: LocalLlm;
  private readonly discussionLlm: LocalLlm;
  private readonly shouldDistill: () => boolean;
  private readonly audit: AuditTrail;
  private readonly config: AmbientCaptureOptions["config"];
  private readonly now: () => Date;
  private readonly runCommand: RunCommand;

  private gitState: AmbientWatcherState = "disabled";
  private diagnosticsState: AmbientWatcherState = "disabled";
  private discussionsState: AmbientWatcherState = "disabled";
  private lastCaptureAt: string | null = null;
  private capturedEvents = 0;

  private gitTimer: NodeJS.Timeout | undefined;
  private diagnosticsTimer: NodeJS.Timeout | undefined;
  private gitBusy = false;
  private diagnosticsBusy = false;
  /** Last LLM distillation attempt per watcher, for the rate-limit guard. */
  private readonly watcherLlmLastAtMs = new Map<string, number>();
  private cursor: CursorState = { version: 1, fingerprint: "", head: null, updatedAt: new Date(0).toISOString() };

  public constructor(options: AmbientCaptureOptions) {
    this.workspacePath = options.workspacePath;
    this.brainDir = options.brainDir;
    this.graph = options.graph;
    this.llm = options.llm;
    this.discussionLlm = options.discussionLlm ?? options.llm;
    this.shouldDistill = options.shouldDistill ?? (() => true);
    this.audit = options.audit;
    this.config = options.config;
    this.now = options.now ?? (() => new Date());
    this.runCommand = options.runCommand ?? defaultRunCommand;
  }

  public async start(): Promise<void> {
    if (!this.config.secondBrainEnabled) {
      this.gitState = "disabled";
      this.diagnosticsState = "disabled";
      this.discussionsState = "disabled";
      return;
    }
    this.discussionsState = "active";
    await this.loadCursor();

    // A non-git workspace is a normal configuration, never an error: the
    // watcher simply reports "unavailable" and stays off.
    const probe = await this.git(["rev-parse", "--is-inside-work-tree"]);
    if (probe.ok && probe.stdout.trim() === "true") {
      this.gitState = "active";
      await this.pollGit();
      this.gitTimer = setInterval(() => {
        void this.pollGit();
      }, this.config.ambientGitPollMs);
      this.gitTimer.unref();
    } else {
      this.gitState = "unavailable";
    }

    if (this.config.ambientCheckCommand) {
      this.diagnosticsState = "active";
      await this.pollDiagnostics();
      this.diagnosticsTimer = setInterval(() => {
        void this.pollDiagnostics();
      }, this.config.ambientCheckIntervalMs);
      this.diagnosticsTimer.unref();
    } else {
      this.diagnosticsState = "disabled";
    }
  }

  public async stop(): Promise<void> {
    if (this.gitTimer) clearInterval(this.gitTimer);
    if (this.diagnosticsTimer) clearInterval(this.diagnosticsTimer);
    this.gitTimer = undefined;
    this.diagnosticsTimer = undefined;
  }

  public status(): AmbientCaptureStatus {
    return {
      git: this.gitState,
      diagnostics: this.diagnosticsState,
      discussions: this.discussionsState,
      lastCaptureAt: this.lastCaptureAt,
      capturedEvents: this.capturedEvents,
    };
  }

  /**
   * Orchestrator-driven capture of idea/brief/fleet-review text. Failure is
   * silently swallowed by contract: a graph hiccup must never break the
   * ideation pipeline that called us.
   */
  public async captureDiscussion(input: {
    correlationId: string;
    role: "idea" | "brief" | "peer-review";
    text: string;
    workerId?: string;
  }): Promise<void> {
    try {
      if (!this.config.secondBrainEnabled) return;
      const bounded = sanitizeBrainText(redactBrainText(input.text), DISCUSSION_BOUNDS[input.role]);
      if (!bounded) return;
      const channel = input.role === "idea" ? "discussion" : input.role === "brief" ? "brief" : "fleet-review";
      const contribution: BrainContribution = {
        txCreatedAt: this.now().toISOString(),
        origin: {
          channel,
          correlationId: input.correlationId.slice(0, 64),
          ...(input.workerId ? { workerId: input.workerId.slice(0, 64) } : {}),
        },
        text: bounded,
      };
      // Near the node cap, distilled triples would be dropped or recycled
      // immediately: skip the inference and let the heuristic single-event
      // contribution carry the text instead.
      const triples = this.shouldDistill()
        ? await this.tryLlmTriples(
          `Extract up to ${MAX_LLM_TRIPLES} knowledge triples from this ${input.role} discussion.`,
          bounded,
          this.discussionLlm,
        )
        : null;
      if (triples) contribution.triples = triples;
      await this.graph.mergeContributions([contribution]);
      this.recordCapture();
    } catch {
      // Never throws: ambient capture is best-effort by design.
    }
  }

  // -------------------------------------------------------------------------
  // Git watcher
  // -------------------------------------------------------------------------

  private async pollGit(): Promise<void> {
    if (this.gitBusy) return;
    this.gitBusy = true;
    try {
      const [status, log, diffStat] = [
        await this.git(["status", "--porcelain=v1"]),
        await this.git(["log", "-1", "--format=%H%x09%s"]),
        await this.git(["diff", "--stat", "HEAD"]),
      ];
      const combined = `${status.stdout}\n---\n${log.stdout}\n---\n${diffStat.stdout}`.slice(0, 3 * STREAM_CAP_BYTES);
      const fingerprint = createHash("sha256").update(combined).digest("hex");
      if (fingerprint === this.cursor.fingerprint) return;

      let facts = 0;
      // Watcher-timer inference is doubly gated: capacity (shouldDistill) and
      // the per-watcher rate limit. Order matters — a capacity skip must not
      // consume the rate-limit window.
      const triples = this.shouldDistill() && this.watcherLlmAllowed("git")
        ? await this.tryLlmTriples(
          `Extract up to ${MAX_LLM_TRIPLES} knowledge triples describing what changed in this git workspace snapshot.`,
          combined,
        )
        : null;
      if (triples) {
        for (const triple of triples) {
          await this.graph.assertFact({
            subject: { kind: "entity", name: triple.subject },
            predicate: triple.predicate,
            object: { kind: "entity", name: triple.object },
            factText: triple.factText ?? `${triple.subject} ${triple.predicate} ${triple.object}`,
            origin: { channel: "git" },
          });
          facts += 1;
        }
      } else {
        facts += await this.captureGitHeuristics(status.stdout, log.stdout);
      }

      const head = this.parseHead(log.stdout);
      this.cursor = {
        version: 1,
        fingerprint,
        head: head?.hash ?? this.cursor.head,
        updatedAt: this.now().toISOString(),
      };
      await this.persistCursor();
      if (facts > 0) this.recordCapture();
      await this.audit.append({
        at: this.now().toISOString(),
        correlationId: AMBIENT_CORRELATION_ID,
        agent: "system",
        event: "ambient_git_captured",
        // Counts and fingerprint only: diff/status contents never enter the
        // audit trail, which travels further than the local graph does.
        data: { facts, fingerprint },
      });
    } catch {
      // Background timers must never throw.
    } finally {
      this.gitBusy = false;
    }
  }

  private async captureGitHeuristics(porcelain: string, logLine: string): Promise<number> {
    let facts = 0;
    const isoDate = this.now().toISOString().slice(0, 10);
    const paths = porcelain
      .split("\n")
      .map(line => this.parsePorcelainPath(line))
      .filter((value): value is string => Boolean(value))
      .slice(0, MAX_GIT_PATH_FACTS);
    for (const changedPath of paths) {
      const name = this.clean(changedPath, 240);
      if (!name) continue;
      await this.graph.assertFact({
        subject: { kind: "artifact", name },
        predicate: "changed",
        object: { kind: "event", name: `working-tree ${isoDate}` },
        factText: this.clean(`${name} changed in the working tree (git status)`, 1_200),
        origin: { channel: "git" },
      });
      facts += 1;
    }

    const head = this.parseHead(logLine);
    if (head && head.hash !== this.cursor.head && BUGFIX_SUBJECT.test(head.subject)) {
      const subject = this.clean(head.subject, 240);
      if (subject) {
        await this.graph.assertFact({
          subject: { kind: "bugfix", name: subject },
          predicate: "fixed-by-commit",
          object: { kind: "event", name: `commit ${head.hash.slice(0, 12)}` },
          factText: this.clean(`Bug fix recorded from commit ${head.hash.slice(0, 12)}: ${subject}`, 1_200),
          origin: { channel: "git" },
        });
        facts += 1;
      }
    }
    return facts;
  }

  private parsePorcelainPath(line: string): string | null {
    if (line.length < 4) return null;
    let candidate = line.slice(3).trim();
    // Renames arrive as "old -> new"; the new path is the living artifact.
    const arrow = candidate.lastIndexOf(" -> ");
    if (arrow >= 0) candidate = candidate.slice(arrow + 4).trim();
    if (candidate.startsWith('"') && candidate.endsWith('"') && candidate.length > 1) {
      candidate = candidate.slice(1, -1);
    }
    return candidate || null;
  }

  private parseHead(logLine: string): { hash: string; subject: string } | null {
    const firstLine = logLine.split("\n")[0] ?? "";
    const tab = firstLine.indexOf("\t");
    if (tab <= 0) return null;
    const hash = firstLine.slice(0, tab).trim();
    const subject = firstLine.slice(tab + 1).trim();
    if (!/^[0-9a-f]{7,64}$/i.test(hash) || !subject) return null;
    return { hash, subject };
  }

  private git(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    // Observation must be genuinely side-effect free: without these overrides
    // a plain `git status` opportunistically rewrites .git/index (taking
    // index.lock under the owner's feet) and can execute a configured
    // core.fsmonitor hook. GIT_OPTIONAL_LOCKS=0 and the -c overrides make the
    // poll read-only in fact, not just in intent.
    return this.runCommand("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
      cwd: this.workspacePath,
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
      env: { GIT_OPTIONAL_LOCKS: "0" },
    });
  }

  // -------------------------------------------------------------------------
  // Diagnostics watcher
  // -------------------------------------------------------------------------

  private async pollDiagnostics(): Promise<void> {
    if (this.diagnosticsBusy) return;
    this.diagnosticsBusy = true;
    try {
      const command = this.config.ambientCheckCommand;
      if (!command) return;
      // Whitespace split, no shell: pipes/redirects/quoting are unsupported
      // by design so a configured command can never expand into a pipeline.
      const tokens = command.split(/\s+/).filter(Boolean);
      const executable = tokens[0];
      if (!executable) return;
      const result = await this.runCommand(executable, tokens.slice(1), {
        cwd: this.workspacePath,
        timeoutMs: DIAGNOSTICS_TIMEOUT_MS,
      });
      // A command that produced no output at all did not run — usually a
      // missing binary or a path with spaces (whitespace splitting is a
      // documented limitation). Surface that as "unavailable" instead of
      // letting the status card claim active observation forever.
      if (!result.ok && !result.stdout && !result.stderr) {
        this.diagnosticsState = "unavailable";
        return;
      }
      this.diagnosticsState = "active";
      // A failing build IS signal: parse diagnostics from the output
      // regardless of exit code. A crash with no parseable lines records
      // nothing and the watcher stays active.
      const seen = new Set<string>();
      let facts = 0;
      const lines = `${result.stdout}\n${result.stderr}`.split("\n");
      for (const line of lines) {
        if (facts >= MAX_DIAGNOSTIC_FACTS) break;
        if (!DIAGNOSTIC_LINE.test(line)) continue;
        const diagnostic = this.clean(line, 400);
        if (!diagnostic || seen.has(diagnostic)) continue;
        seen.add(diagnostic);
        const fileMatch = DIAGNOSTIC_FILE.exec(line.trim());
        const subjectName = fileMatch?.[1] ? this.clean(fileMatch[1], 240) || "workspace" : "workspace";
        await this.graph.assertFact({
          subject: { kind: "artifact", name: subjectName },
          predicate: "reports",
          object: { kind: "event", name: diagnostic.slice(0, 80) },
          factText: diagnostic.slice(0, 1_200),
          origin: { channel: "diagnostics" },
        });
        facts += 1;
      }
      if (facts > 0) this.recordCapture();
      await this.audit.append({
        at: this.now().toISOString(),
        correlationId: AMBIENT_CORRELATION_ID,
        agent: "system",
        event: "ambient_diagnostics_captured",
        data: { facts, commandOk: result.ok },
      });
    } catch {
      // Background timers must never throw.
    } finally {
      this.diagnosticsBusy = false;
    }
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  /**
   * At most one LLM distillation attempt per watcher per window, decided on
   * the injectable clock. The guard is monotonic in effect: a clock that
   * jumps backwards makes `nowMs < last + window` true, which fails safe
   * (skip the inference) rather than opening an unbounded burst. Stamped on
   * attempt, not success — a down Ollama must not be re-probed every poll.
   */
  private watcherLlmAllowed(watcher: string): boolean {
    const nowMs = this.now().getTime();
    const last = this.watcherLlmLastAtMs.get(watcher);
    if (last !== undefined && nowMs < last + WATCHER_LLM_MIN_INTERVAL_MS) return false;
    this.watcherLlmLastAtMs.set(watcher, nowMs);
    return true;
  }

  /**
   * Model output is untrusted: it is schema-parsed into bounded triples and
   * every field is redacted/sanitized before touching the graph. Anything
   * malformed collapses to null and the caller's deterministic fallback runs.
   */
  private async tryLlmTriples(instruction: string, context: string, llm: LocalLlm = this.llm): Promise<Triple[] | null> {
    try {
      const prompt = [
        instruction,
        'Respond with JSON only: {"triples":[{"subject":"...","predicate":"...","object":"...","factText":"..."}]}.',
        "Content:",
        sanitizeBrainText(redactBrainText(context), 4_000),
      ].join("\n");
      const raw = await llm.generateJson(prompt, { timeoutMs: LLM_TIMEOUT_MS });
      if (raw === null || raw === undefined) return null;
      const candidate = Array.isArray(raw) ? raw : (raw as { triples?: unknown }).triples;
      const parsed = z.array(TripleSchema).safeParse(candidate);
      if (!parsed.success) return null;
      const triples = parsed.data
        .slice(0, MAX_LLM_TRIPLES)
        .map(triple => ({
          subject: this.clean(triple.subject, 240),
          predicate: this.clean(triple.predicate, 120),
          object: this.clean(triple.object, 240),
          ...(triple.factText ? { factText: this.clean(triple.factText, 1_200) } : {}),
        }))
        .filter(triple => triple.subject && triple.predicate && triple.object);
      return triples.length > 0 ? triples : null;
    } catch {
      return null;
    }
  }

  private clean(value: string, maxChars: number): string {
    return sanitizeBrainText(redactBrainText(value), maxChars);
  }

  private recordCapture(): void {
    this.capturedEvents += 1;
    this.lastCaptureAt = this.now().toISOString();
  }

  private cursorPath(): string {
    return path.join(this.brainDir, "capture-cursor.json");
  }

  private async loadCursor(): Promise<void> {
    try {
      this.cursor = CursorSchema.parse(JSON.parse(await readFile(this.cursorPath(), "utf8")));
    } catch {
      // Missing or corrupt cursor means "capture from scratch", never a fault.
    }
  }

  private async persistCursor(): Promise<void> {
    try {
      await mkdir(this.brainDir, { recursive: true, mode: 0o700 });
      const temporary = `${this.cursorPath()}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(this.cursor, null, 2), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.cursorPath());
    } catch {
      // A cursor persist failure only risks a duplicate capture; the graph's
      // contentHash idempotency absorbs that.
    }
  }
}
