import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  sanitizeBrainText,
  type AntiPatternRegistryApi,
  type AntiPatternViolation,
  type LocalLlm,
  type RetrieverApi,
} from "./types.js";

/**
 * Shift-left pre-commit gate.
 *
 * The gate exists to make remembered anti-patterns *mechanical*: once a bug
 * class has been recorded with an explicit Wrong/Correct example, no commit
 * should reintroduce it silently. Two deliberate asymmetries define the
 * design:
 *
 * - Fail-open for missing tooling, fail-closed for real findings. A laptop
 *   without the omnibus binary (or with git wedged) must still be able to
 *   commit; a staged file that matches a blocking detector must not.
 * - Only mechanical detectors can block. The optional local-model layer is
 *   advisory by construction — its output is schema-parsed, size-bounded,
 *   never executed, and can never flip a passing commit to failing.
 */

export const OMNIBUS_HOOK_MARKER = "# omnibus-bridge second-brain pre-commit gate v1";

const HOOK_FILE = "pre-commit";
const BACKUP_FILE = "pre-commit.omnibus-backup";

/** Extensions the gate inspects; everything else is skipped untouched. */
const CHECKED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".swift", ".py", ".rs",
  ".go", ".java", ".kt", ".rb", ".c", ".h", ".cpp", ".m", ".json", ".yml", ".yaml",
]);

const EXTENSION_LANGUAGE: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".swift": "swift", ".py": "python", ".rs": "rust", ".go": "go",
  ".java": "java", ".kt": "kotlin", ".rb": "ruby",
  ".c": "c", ".h": "c", ".cpp": "cpp", ".m": "objective-c",
  ".json": "json", ".yml": "yaml", ".yaml": "yaml",
};

/** A staged blob larger than this is skipped: generated bundles, vendored
 *  archives, and lockfile churn are not where anti-patterns get typed. */
const MAX_STAGED_BLOB_BYTES = 262_144;
const MAX_STAGED_FILES = 400;
const MAX_REPORT_CHARS = 60_000;
/** Minimum wall-clock remaining before the advisory layer even starts. */
const MIN_ADVISORY_BUDGET_MS = 500;

export type RunCommandResult = { ok: boolean; stdout: string; stderr: string };

export type RunCommand = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<RunCommandResult>;

export type PreCommitOutcome = {
  ok: boolean;
  checkedFiles: number;
  blocking: number;
  warnings: number;
  fixedFiles: string[];
  report: string;
};

export type InstallResult = {
  installed: boolean;
  hookPath?: string;
  backedUpTo?: string;
  reason?: string;
};

export type UninstallResult = {
  removed: boolean;
  restoredBackup: boolean;
  reason?: string;
};

// ---------------------------------------------------------------------------
// Hook install / uninstall
// ---------------------------------------------------------------------------

/**
 * The hook script is intentionally plain POSIX sh with no environment
 * inheritance tricks: it probes for the omnibus binary with `command -v` and
 * exits 0 when the tool is absent, so uninstalling the bridge can never
 * brick the owner's ability to commit. A foreign hook is never silently
 * destroyed — without force we refuse; with force it is preserved as
 * pre-commit.omnibus-backup and chain-executed only after our gate passes.
 */
function buildHookScript(commandLine?: string): string {
  const line = sanitizeCommandLine(commandLine);
  const probe = line.split(/\s+/)[0] ?? "omnibus-bridge";
  return [
    "#!/bin/sh",
    OMNIBUS_HOOK_MARKER,
    "# Blocks staged changes that repeat recorded anti-patterns. Fail-open for",
    "# a missing tool, fail-closed for real findings. Managed by omnibus-bridge;",
    "# uninstall via omnibus-bridge or delete this file.",
    'OMNIBUS_HOOK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    `if ! command -v ${probe} >/dev/null 2>&1; then`,
    `  echo "[omnibus] ${probe} not found on PATH; skipping second-brain pre-commit gate." >&2`,
    "  exit 0",
    "fi",
    `${line} hook check --staged || exit $?`,
    `if [ -x "$OMNIBUS_HOOK_DIR/${BACKUP_FILE}" ]; then`,
    `  exec "$OMNIBUS_HOOK_DIR/${BACKUP_FILE}" "$@"`,
    "fi",
    "exit 0",
    "",
  ].join("\n");
}

function sanitizeCommandLine(commandLine?: string): string {
  const cleaned = (commandLine ?? "omnibus-bridge")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  return cleaned || "omnibus-bridge";
}

export async function installPreCommitHook(
  workspacePath: string,
  options: { force?: boolean; commandLine?: string } = {},
): Promise<InstallResult> {
  const gitDir = path.join(workspacePath, ".git");
  if (!(await isDirectory(gitDir))) {
    return {
      installed: false,
      reason: "This workspace is not a git repository (no .git directory), so the pre-commit gate has nowhere to install.",
    };
  }
  const hooksDir = path.join(gitDir, "hooks");
  await mkdir(hooksDir, { recursive: true, mode: 0o700 });
  const hookPath = path.join(hooksDir, HOOK_FILE);
  const backupPath = path.join(hooksDir, BACKUP_FILE);

  const existing = await readFileOrNull(hookPath);
  let backedUpTo: string | undefined;
  if (existing !== null && !existing.includes(OMNIBUS_HOOK_MARKER)) {
    if (!options.force) {
      return {
        installed: false,
        hookPath,
        reason: `An existing hook at .git/hooks/${HOOK_FILE} was not written by omnibus-bridge. Re-run with force to back it up to .git/hooks/${BACKUP_FILE} and chain it after the gate.`,
      };
    }
    // A second force-install must not overwrite the first backup — that
    // would silently destroy the only copy of the owner's original hook.
    if (await isFile(backupPath)) {
      return {
        installed: false,
        hookPath,
        reason: `A previous backup already exists at .git/hooks/${BACKUP_FILE}. Restore or remove it before force-installing over another foreign hook.`,
      };
    }
    await rename(hookPath, backupPath);
    backedUpTo = backupPath;
  }

  const temporary = `${hookPath}.${process.pid}.tmp`;
  await writeFile(temporary, buildHookScript(options.commandLine), { mode: 0o755 });
  await rename(temporary, hookPath);
  await chmod(hookPath, 0o755);
  return { installed: true, hookPath, ...(backedUpTo ? { backedUpTo } : {}) };
}

/**
 * Removal is as conservative as installation: only a hook carrying our marker
 * is ever deleted, and a backed-up foreign hook is restored to its original
 * name so force-install followed by uninstall is a clean round trip.
 */
export async function uninstallPreCommitHook(workspacePath: string): Promise<UninstallResult> {
  const hooksDir = path.join(workspacePath, ".git", "hooks");
  const hookPath = path.join(hooksDir, HOOK_FILE);
  const backupPath = path.join(hooksDir, BACKUP_FILE);
  const existing = await readFileOrNull(hookPath);
  if (existing === null) {
    return { removed: false, restoredBackup: false, reason: "No pre-commit hook is installed." };
  }
  if (!existing.includes(OMNIBUS_HOOK_MARKER)) {
    return {
      removed: false,
      restoredBackup: false,
      reason: `The hook at .git/hooks/${HOOK_FILE} was not written by omnibus-bridge; leaving it untouched.`,
    };
  }
  await rm(hookPath, { force: true });
  if (await isFile(backupPath)) {
    await rename(backupPath, hookPath);
    await chmod(hookPath, 0o755);
    return { removed: true, restoredBackup: true };
  }
  return { removed: true, restoredBackup: false };
}

// ---------------------------------------------------------------------------
// The staged check itself
// ---------------------------------------------------------------------------

export type PreCommitCheckOptions = {
  workspacePath: string;
  registry: AntiPatternRegistryApi;
  retriever?: RetrieverApi;
  llm?: LocalLlm;
  fix?: boolean;
  timeoutMs: number;
  llmEnabled?: boolean;
  runCommand?: RunCommand;
};

/** Untrusted local-model output must fit this shape or it is discarded. */
const AdvisorySchema = z.object({
  repeatsPastIssue: z.boolean(),
  advisory: z.string().min(1).max(1_500),
});

export async function runPreCommitCheck(options: PreCommitCheckOptions): Promise<PreCommitOutcome> {
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(1, options.timeoutMs);
  const remaining = (): number => deadline - Date.now();
  const run = options.runCommand ?? defaultRunCommand;
  const cwd = options.workspacePath;
  const lines: string[] = [];
  const fixedFiles: string[] = [];
  let checkedFiles = 0;
  let blocking = 0;
  let warnings = 0;

  // core.quotePath=false makes git emit non-ASCII paths verbatim instead of
  // octal-escaped-and-quoted, which would otherwise defeat the extension
  // filter and `git show :<path>` — silently exempting those files from the
  // gate. A read-only -c override; no repository config is touched.
  const listed = await run("git", ["-c", "core.quotePath=false", "diff", "--cached", "--name-only", "--diff-filter=ACM"], {
    cwd,
    timeoutMs: Math.max(1, remaining()),
  }).catch((): RunCommandResult => ({ ok: false, stdout: "", stderr: "" }));

  if (!listed.ok) {
    return {
      ok: true,
      checkedFiles: 0,
      blocking: 0,
      warnings: 0,
      fixedFiles: [],
      report: "Pre-commit gate: could not list staged files (git unavailable or timed out). Gate skipped — fail-open for missing tooling.",
    };
  }

  const candidates = listed.stdout
    .split("\n")
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0 && CHECKED_EXTENSIONS.has(path.extname(entry).toLowerCase()))
    // Anti-pattern registry/teaching files quote bad code on purpose — the
    // gate validating its own Wrong examples would block its own material.
    .filter(entry => !path.basename(entry).toLowerCase().includes("anti-pattern"))
    .slice(0, MAX_STAGED_FILES);

  let timedOut = false;
  for (const file of candidates) {
    if (remaining() <= 0) {
      timedOut = true;
      break;
    }
    const shown = await run("git", ["-c", "core.quotePath=false", "show", `:${file}`], { cwd, timeoutMs: Math.max(1, remaining()) })
      .catch((): RunCommandResult => ({ ok: false, stdout: "", stderr: "" }));
    if (!shown.ok) continue;
    // ">=" is load-bearing: the capture buffer clips at the same bound, so a
    // larger blob can arrive as exactly the cap — treat that as oversized
    // rather than validating (or worse, --fix-rewriting) a truncated file.
    if (Buffer.byteLength(shown.stdout, "utf8") >= MAX_STAGED_BLOB_BYTES) continue;

    const language = EXTENSION_LANGUAGE[path.extname(file).toLowerCase()];
    const check = options.registry.check(shown.stdout, language ? { language } : undefined);
    checkedFiles += 1;
    warnings += check.warnings;
    if (check.violations.length === 0) continue;

    const allFixable = check.violations.every(violation => violation.fixable);
    if (options.fix && allFixable) {
      // The correction derives from the STAGED blob, so it may be written
      // only when the working-tree copy still matches it byte-for-byte —
      // otherwise --fix would silently overwrite edits made after staging.
      const workingMatchesStaged = await workingTreeMatches(cwd, file, shown.stdout);
      if (!workingMatchesStaged) {
        lines.push(`SKIPPED FIX ${file}: the working-tree copy differs from the staged copy; apply the correction manually or re-stage first.`);
      } else {
        const corrected = options.registry.autoCorrect(shown.stdout);
        if (corrected.applied > 0 && (await writeWorkingTreeFile(cwd, file, corrected.text))) {
          fixedFiles.push(file);
          lines.push(`FIXED ${file}: ${corrected.applied} auto-correction(s) written to the working tree. Review the change, then re-stage the file.`);
          continue;
        }
      }
    }

    blocking += check.blocking;
    for (const violation of check.violations) {
      lines.push(formatViolation(file, violation));
    }
  }

  if (timedOut) {
    lines.push(`NOTE: time budget of ${options.timeoutMs}ms exhausted after ${checkedFiles} of ${candidates.length} candidate file(s); the commit is not held beyond the bound.`);
  }

  // Advisory agentic layer: retrieval + local model, strictly non-blocking.
  // Any failure, timeout, or malformed model answer is swallowed — the
  // mechanical detectors above are the only authority over `ok`.
  if (options.llmEnabled && options.llm && options.retriever && remaining() > MIN_ADVISORY_BUDGET_MS) {
    const advisory = await runAdvisoryLayer(options, candidates, lines, remaining());
    if (advisory) lines.push(advisory);
  }

  const header = `Pre-commit gate: ${checkedFiles} staged file(s) checked, ${blocking} blocking violation(s), ${warnings} warning(s).`;
  const report = [header, ...lines].join("\n\n").slice(0, MAX_REPORT_CHARS);
  return { ok: blocking === 0, checkedFiles, blocking, warnings, fixedFiles, report };
}

/**
 * The report teaches instead of merely refusing: every violation carries the
 * pattern's own Wrong and Correct examples so the fix is copy-ready at the
 * terminal without opening the registry.
 */
function formatViolation(file: string, violation: AntiPatternViolation): string {
  const severity = violation.pattern.severity === "block" ? "BLOCK" : "WARN";
  return [
    `${file}:${violation.line} [${severity}] ${violation.pattern.title}`,
    `  matched: ${violation.excerpt}`,
    `  why: ${violation.pattern.rationale || violation.pattern.description}`,
    "  Wrong:",
    indent(violation.pattern.wrong),
    "  Correct:",
    indent(violation.pattern.correct),
  ].join("\n");
}

function indent(block: string): string {
  return block.split("\n").map(line => `    ${line}`).join("\n");
}

async function runAdvisoryLayer(
  options: PreCommitCheckOptions,
  candidates: string[],
  reportLines: string[],
  budgetMs: number,
): Promise<string | null> {
  try {
    const excerpts = reportLines
      .filter(line => line.includes("[BLOCK]"))
      .map(line => line.split("\n")[0] ?? "")
      .slice(0, 6);
    const summary = sanitizeBrainText(
      `Staged files: ${candidates.slice(0, 40).join(", ")}. Blocking findings: ${excerpts.join(" | ") || "none"}.`,
      2_000,
    );
    const retrieval = await withDeadline(
      options.retriever!.retrieve(summary, { topK: 8 }),
      Math.max(1, Math.floor(budgetMs / 2)),
    );
    if (!retrieval.contextText) return null;
    const prompt = [
      "You review a staged git change against past project knowledge.",
      "Past bugfixes and anti-patterns:",
      retrieval.contextText.slice(0, 4_000),
      "Staged change summary:",
      summary,
      'Answer only JSON: {"repeatsPastIssue": boolean, "advisory": "one short paragraph"}.',
    ].join("\n\n");
    const raw = await options.llm!.generateJson(prompt, { timeoutMs: Math.max(1, budgetMs) });
    const parsed = AdvisorySchema.safeParse(raw);
    if (!parsed.success) return null;
    const flag = parsed.data.repeatsPastIssue ? "may repeat a recorded past issue" : "no recorded past issue matched";
    return `ADVISORY (local model, never blocking — ${flag}): ${sanitizeBrainText(parsed.data.advisory, 1_000)}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Corrections go to the working tree only — never `git add`, never the index.
 * The owner reviews and re-stages; the gate must not be able to smuggle text
 * into a commit the owner has not looked at.
 */
async function writeWorkingTreeFile(workspacePath: string, file: string, text: string): Promise<boolean> {
  const root = path.resolve(workspacePath);
  const absolute = path.resolve(root, file);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return false;
  try {
    await writeFile(absolute, text, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** True when the working-tree copy of a staged file equals the staged blob. */
async function workingTreeMatches(workspacePath: string, file: string, stagedText: string): Promise<boolean> {
  const root = path.resolve(workspacePath);
  const absolute = path.resolve(root, file);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return false;
  try {
    return (await readFile(absolute, "utf8")) === stagedText;
  } catch {
    return false;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

async function readFileOrNull(target: string): Promise<string | null> {
  try {
    return await readFile(target, "utf8");
  } catch {
    return null;
  }
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("deadline exceeded")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Bounded stdout capture: enough to detect an oversized staged blob. */
const MAX_CAPTURED_STDOUT_BYTES = MAX_STAGED_BLOB_BYTES + 4_096;

const defaultRunCommand: RunCommand = (command, args, options) =>
  new Promise<RunCommandResult>(resolve => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout, stderr });
    };
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, Math.max(1, options.timeoutMs));
    child.stdout.on("data", (chunk: Buffer) => {
      // Capture is capped just above the blob limit: an oversized staged
      // file still measures as oversized and is skipped, without buffering
      // the whole blob in memory.
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_CAPTURED_STDOUT_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8_192) stderr += chunk.toString("utf8");
    });
    child.on("error", () => finish(false));
    child.on("close", code => finish(code === 0));
  });
