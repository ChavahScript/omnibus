import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  OMNIBUS_HOOK_MARKER,
  installPreCommitHook,
  runPreCommitCheck,
  uninstallPreCommitHook,
  type RunCommand,
} from "./precommit.js";
import type {
  AntiPattern,
  AntiPatternCheck,
  AntiPatternRegistryApi,
  LocalLlm,
  RetrieverApi,
} from "./types.js";

async function makeRepoDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omnibus-precommit-"));
  await mkdir(path.join(dir, ".git", "hooks"), { recursive: true });
  return dir;
}

function makePattern(overrides: Partial<AntiPattern> = {}): AntiPattern {
  return {
    id: "ap-eval",
    title: "Never eval untrusted input",
    description: "eval executes arbitrary strings.",
    language: "typescript",
    wrong: "// Wrong\nconst out = eval(input);",
    correct: "// Correct\nconst out = JSON.parse(input);",
    detector: { kind: "substring", needle: "eval(" },
    severity: "block",
    rationale: "Remote strings must never reach the interpreter.",
    origin: { channel: "manual" },
    createdAt: new Date(0).toISOString(),
    retiredAt: null,
    ...overrides,
  };
}

function makeRegistry(options: {
  pattern?: AntiPattern;
  needle?: string;
  fixable?: boolean;
  corrected?: string;
} = {}): AntiPatternRegistryApi & { autoCorrectCalls: number } {
  const pattern = options.pattern ?? makePattern();
  const needle = options.needle ?? "eval(";
  const registry = {
    autoCorrectCalls: 0,
    async load(): Promise<void> {},
    list: (): AntiPattern[] => [pattern],
    add: async (): Promise<AntiPattern> => pattern,
    retire: async (): Promise<boolean> => false,
    check(text: string): AntiPatternCheck {
      const violations = text
        .split("\n")
        .flatMap((line, index) =>
          line.includes(needle)
            ? [{ pattern, line: index + 1, excerpt: line.trim().slice(0, 160), fixable: options.fixable ?? false }]
            : []);
      const blocking = violations.filter(v => v.pattern.severity === "block").length;
      return { violations, blocking, warnings: violations.length - blocking, checkedChars: text.length };
    },
    autoCorrect(text: string): { text: string; applied: number; appliedPatternIds: string[] } {
      registry.autoCorrectCalls += 1;
      const corrected = options.corrected ?? text.split(needle).join("safeParse(");
      const applied = corrected === text ? 0 : 1;
      return { text: corrected, applied, appliedPatternIds: applied ? [pattern.id] : [] };
    },
    promptDigest: (): string => "",
  };
  return registry;
}

type Call = { command: string; args: string[] };

function makeRunCommand(handlers: {
  staged?: string[];
  blobs?: Record<string, string>;
  failList?: boolean;
  delayMs?: number;
}): { run: RunCommand; calls: Call[] } {
  const calls: Call[] = [];
  const run: RunCommand = async (command, rawArgs) => {
    // The gate prepends `-c core.quotePath=false` so non-ASCII staged paths
    // arrive unquoted; strip that read-only prefix before dispatching.
    const args = [...rawArgs];
    while (args[0] === "-c") args.splice(0, 2);
    calls.push({ command, args });
    if (handlers.delayMs) await new Promise(resolve => setTimeout(resolve, handlers.delayMs));
    // The gate probes repository membership before listing staged files.
    if (args[0] === "rev-parse") {
      if (handlers.failList) return { ok: false, stdout: "", stderr: "fatal: not a git repository", exitCode: 128 };
      return { ok: true, stdout: "true\n", stderr: "" };
    }
    if (args[0] === "diff") {
      if (handlers.failList) return { ok: false, stdout: "", stderr: "fatal: not a git repository" };
      return { ok: true, stdout: `${(handlers.staged ?? []).join("\n")}\n`, stderr: "" };
    }
    if (args[0] === "show") {
      const file = (args[1] ?? "").replace(/^:/, "");
      const blob = handlers.blobs?.[file];
      if (blob === undefined) return { ok: false, stdout: "", stderr: "missing" };
      return { ok: true, stdout: blob, stderr: "" };
    }
    return { ok: false, stdout: "", stderr: `unexpected: ${command}` };
  };
  return { run, calls };
}

// ---------------------------------------------------------------------------
// Hook install / uninstall
// ---------------------------------------------------------------------------

test("installPreCommitHook refuses when the workspace is not a git repository", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omnibus-precommit-"));
  try {
    const result = await installPreCommitHook(dir);
    assert.equal(result.installed, false);
    assert.match(result.reason ?? "", /not a git repository/);

    // A `.git` file (worktree pointer) is also not an installable target.
    await writeFile(path.join(dir, ".git"), "gitdir: elsewhere\n");
    const fileResult = await installPreCommitHook(dir);
    assert.equal(fileResult.installed, false);
    assert.match(fileResult.reason ?? "", /not a git repository/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installPreCommitHook writes an executable marked script with the fail-open probe", async () => {
  const dir = await makeRepoDir();
  try {
    const result = await installPreCommitHook(dir);
    assert.equal(result.installed, true);
    const hookPath = path.join(dir, ".git", "hooks", "pre-commit");
    assert.equal(result.hookPath, hookPath);
    const script = await readFile(hookPath, "utf8");
    assert.ok(script.startsWith("#!/bin/sh\n"));
    assert.ok(script.includes(OMNIBUS_HOOK_MARKER));
    assert.ok(script.includes("command -v omnibus-bridge"));
    assert.ok(script.includes("omnibus-bridge hook check --staged"));
    assert.ok(script.includes("exit 0"));
    const mode = (await stat(hookPath)).mode & 0o777;
    assert.equal(mode & 0o111, 0o111, "hook must be executable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installPreCommitHook honours a custom command line and strips control characters", async () => {
  const dir = await makeRepoDir();
  try {
    await installPreCommitHook(dir, { commandLine: "node ./dist/cli.js\nrm -rf /" });
    const script = await readFile(path.join(dir, ".git", "hooks", "pre-commit"), "utf8");
    assert.ok(script.includes("node ./dist/cli.js rm -rf / hook check --staged"));
    assert.ok(!script.includes("\nrm -rf /"), "newlines must not become separate shell commands");
    assert.ok(script.includes("command -v node"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installPreCommitHook refuses to overwrite a foreign hook without force", async () => {
  const dir = await makeRepoDir();
  const hookPath = path.join(dir, ".git", "hooks", "pre-commit");
  try {
    await writeFile(hookPath, "#!/bin/sh\necho custom-lint\n", { mode: 0o755 });
    const result = await installPreCommitHook(dir);
    assert.equal(result.installed, false);
    assert.match(result.reason ?? "", /pre-commit/);
    assert.equal(await readFile(hookPath, "utf8"), "#!/bin/sh\necho custom-lint\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installPreCommitHook with force backs up and chain-executes the foreign hook", async () => {
  const dir = await makeRepoDir();
  const hookPath = path.join(dir, ".git", "hooks", "pre-commit");
  const backupPath = path.join(dir, ".git", "hooks", "pre-commit.omnibus-backup");
  try {
    await writeFile(hookPath, "#!/bin/sh\necho custom-lint\n", { mode: 0o755 });
    const result = await installPreCommitHook(dir, { force: true });
    assert.equal(result.installed, true);
    assert.equal(result.backedUpTo, backupPath);
    assert.equal(await readFile(backupPath, "utf8"), "#!/bin/sh\necho custom-lint\n");
    const script = await readFile(hookPath, "utf8");
    assert.ok(script.includes(OMNIBUS_HOOK_MARKER));
    // The chain exec must come after our own check line so a blocked commit
    // never reaches the foreign hook.
    const checkAt = script.indexOf("hook check --staged");
    const chainAt = script.indexOf("pre-commit.omnibus-backup");
    assert.ok(checkAt >= 0 && chainAt > checkAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installPreCommitHook re-runs idempotently over its own hook", async () => {
  const dir = await makeRepoDir();
  try {
    const first = await installPreCommitHook(dir);
    const firstScript = await readFile(first.hookPath!, "utf8");
    const second = await installPreCommitHook(dir);
    assert.equal(second.installed, true);
    assert.equal(second.backedUpTo, undefined);
    assert.equal(await readFile(second.hookPath!, "utf8"), firstScript);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("uninstallPreCommitHook removes only our hook and restores a backup", async () => {
  const dir = await makeRepoDir();
  const hookPath = path.join(dir, ".git", "hooks", "pre-commit");
  try {
    await writeFile(hookPath, "#!/bin/sh\necho custom-lint\n", { mode: 0o755 });
    const refused = await uninstallPreCommitHook(dir);
    assert.equal(refused.removed, false);

    await installPreCommitHook(dir, { force: true });
    const result = await uninstallPreCommitHook(dir);
    assert.equal(result.removed, true);
    assert.equal(result.restoredBackup, true);
    assert.equal(await readFile(hookPath, "utf8"), "#!/bin/sh\necho custom-lint\n");
    await assert.rejects(stat(path.join(dir, ".git", "hooks", "pre-commit.omnibus-backup")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Staged check
// ---------------------------------------------------------------------------

test("runPreCommitCheck blocks on a mechanical finding and teaches the fix", async () => {
  const dir = await makeRepoDir();
  try {
    const { run } = makeRunCommand({
      staged: ["src/a.ts", "README.md", "image.png"],
      blobs: { "src/a.ts": "const input = read();\nconst out = eval(input);\n" },
    });
    const outcome = await runPreCommitCheck({
      workspacePath: dir,
      registry: makeRegistry(),
      timeoutMs: 5_000,
      runCommand: run,
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.checkedFiles, 1);
    assert.equal(outcome.blocking, 1);
    assert.ok(outcome.report.includes("src/a.ts:2"));
    assert.ok(outcome.report.includes("Never eval untrusted input"));
    assert.ok(outcome.report.includes("// Wrong\nconst out = eval(input);".split("\n")[1]!));
    assert.ok(outcome.report.includes("JSON.parse(input)"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runPreCommitCheck only fetches blobs for checkable extensions", async () => {
  const dir = await makeRepoDir();
  try {
    const { run, calls } = makeRunCommand({
      staged: ["src/a.ts", "docs/guide.md", "assets/logo.png", "script.py"],
      blobs: { "src/a.ts": "ok\n", "script.py": "ok\n" },
    });
    const outcome = await runPreCommitCheck({
      workspacePath: dir,
      registry: makeRegistry(),
      timeoutMs: 5_000,
      runCommand: run,
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.checkedFiles, 2);
    const shown = calls.filter(call => call.args[0] === "show").map(call => call.args[1]);
    assert.deepEqual(shown, [":src/a.ts", ":script.py"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runPreCommitCheck skips oversized staged blobs", async () => {
  const dir = await makeRepoDir();
  try {
    const { run } = makeRunCommand({
      staged: ["big.ts"],
      blobs: { "big.ts": `${"x".repeat(300_000)} eval(evil)\n` },
    });
    const outcome = await runPreCommitCheck({
      workspacePath: dir,
      registry: makeRegistry(),
      timeoutMs: 5_000,
      runCommand: run,
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.checkedFiles, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runPreCommitCheck fails open when git cannot list staged files", async () => {
  const dir = await makeRepoDir();
  try {
    const { run } = makeRunCommand({ failList: true });
    const outcome = await runPreCommitCheck({
      workspacePath: dir,
      registry: makeRegistry(),
      timeoutMs: 5_000,
      runCommand: run,
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.checkedFiles, 0);
    assert.match(outcome.report, /fail-open/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runPreCommitCheck with fix=true corrects the working tree, never the index", async () => {
  const dir = await makeRepoDir();
  try {
    const staged = "const out = eval(input);\n";
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "a.ts"), staged);
    const { run, calls } = makeRunCommand({ staged: ["src/a.ts"], blobs: { "src/a.ts": staged } });
    const outcome = await runPreCommitCheck({
      workspacePath: dir,
      registry: makeRegistry({ fixable: true }),
      fix: true,
      timeoutMs: 5_000,
      runCommand: run,
    });
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.fixedFiles, ["src/a.ts"]);
    assert.equal(outcome.blocking, 0);
    assert.match(outcome.report, /re-stage/i);
    assert.equal(await readFile(path.join(dir, "src", "a.ts"), "utf8"), "const out = safeParse(input);\n");
    // Correcting must never call `git add` or otherwise touch the index.
    assert.ok(calls.every(call => call.args[0] !== "add"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runPreCommitCheck keeps unfixable blocking violations blocking even with fix=true", async () => {
  const dir = await makeRepoDir();
  try {
    const staged = "const out = eval(input);\n";
    const { run } = makeRunCommand({ staged: ["src/a.ts"], blobs: { "src/a.ts": staged } });
    const registry = makeRegistry({ fixable: false });
    const outcome = await runPreCommitCheck({
      workspacePath: dir,
      registry,
      fix: true,
      timeoutMs: 5_000,
      runCommand: run,
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.blocking, 1);
    assert.deepEqual(outcome.fixedFiles, []);
    assert.equal(registry.autoCorrectCalls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runPreCommitCheck stops at the wall-clock bound and says so", async () => {
  const dir = await makeRepoDir();
  try {
    const { run } = makeRunCommand({
      staged: ["a.ts", "b.ts", "c.ts"],
      blobs: { "a.ts": "ok\n", "b.ts": "ok\n", "c.ts": "ok\n" },
      delayMs: 15,
    });
    const outcome = await runPreCommitCheck({
      workspacePath: dir,
      registry: makeRegistry(),
      timeoutMs: 1,
      runCommand: run,
    });
    assert.equal(outcome.ok, true);
    assert.ok(outcome.checkedFiles < 3);
    assert.match(outcome.report, /time budget/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("advisory layer appends warnings but can never block, and its errors are swallowed", async () => {
  const dir = await makeRepoDir();
  try {
    const retriever: RetrieverApi = {
      retrieve: async () => ({
        entities: ["eval"],
        seedNodeIds: ["n1"],
        facts: [],
        contextText: "[brain:bugfix] eval on remote input caused RCE in relay.ts",
        heuristic: true,
      }),
    };
    const llm: LocalLlm = {
      generateJson: async () => ({ repeatsPastIssue: true, advisory: "This mirrors the relay.ts eval RCE fix." }),
      available: async () => true,
    };
    const { run } = makeRunCommand({ staged: ["src/a.ts"], blobs: { "src/a.ts": "ok\n" } });
    const outcome = await runPreCommitCheck({
      workspacePath: dir,
      registry: makeRegistry(),
      retriever,
      llm,
      llmEnabled: true,
      timeoutMs: 5_000,
      runCommand: run,
    });
    assert.equal(outcome.ok, true, "advisory output must never block");
    assert.ok(outcome.report.includes("ADVISORY"));
    assert.ok(outcome.report.includes("relay.ts eval RCE"));

    // A throwing model is swallowed entirely.
    const brokenLlm: LocalLlm = {
      generateJson: async () => { throw new Error("ollama down"); },
      available: async () => false,
    };
    const { run: run2 } = makeRunCommand({ staged: ["src/a.ts"], blobs: { "src/a.ts": "ok\n" } });
    const quiet = await runPreCommitCheck({
      workspacePath: dir,
      registry: makeRegistry(),
      retriever,
      llm: brokenLlm,
      llmEnabled: true,
      timeoutMs: 5_000,
      runCommand: run2,
    });
    assert.equal(quiet.ok, true);
    assert.ok(!quiet.report.includes("ADVISORY"));

    // Malformed model JSON is discarded, never echoed into the report.
    const junkLlm: LocalLlm = {
      generateJson: async () => ({ advisory: 42, exec: "rm -rf /" }),
      available: async () => true,
    };
    const { run: run3 } = makeRunCommand({ staged: ["src/a.ts"], blobs: { "src/a.ts": "ok\n" } });
    const junk = await runPreCommitCheck({
      workspacePath: dir,
      registry: makeRegistry(),
      retriever,
      llm: junkLlm,
      llmEnabled: true,
      timeoutMs: 5_000,
      runCommand: run3,
    });
    assert.equal(junk.ok, true);
    assert.ok(!junk.report.includes("ADVISORY"));
    assert.ok(!junk.report.includes("rm -rf"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("foreign-hook refusal names the exact --force flag to type", async () => {
  const dir = await makeRepoDir();
  const hookPath = path.join(dir, ".git", "hooks", "pre-commit");
  try {
    await writeFile(hookPath, "#!/bin/sh\necho custom-lint\n", { mode: 0o755 });
    const result = await installPreCommitHook(dir);
    assert.equal(result.installed, false);
    assert.match(result.reason ?? "", /Re-run with --force/);
    assert.doesNotMatch(result.reason ?? "", /Re-run with force to/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("staged-file listing outside a git repository reports the real cause", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omnibus-precommit-"));
  try {
    // git's own stderr wording identifies the situation.
    const byStderr: RunCommand = async () => ({ ok: false, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git" });
    const stderrOutcome = await runPreCommitCheck({ workspacePath: dir, registry: makeRegistry(), timeoutMs: 5_000, runCommand: byStderr });
    assert.equal(stderrOutcome.ok, true);
    assert.match(stderrOutcome.report, /not a git repository/i);
    assert.doesNotMatch(stderrOutcome.report, /git unavailable or timed out/);

    // Exit status 128 alone is enough, even without stderr text.
    const byExitCode: RunCommand = async () => ({ ok: false, stdout: "", stderr: "", exitCode: 128 });
    const codeOutcome = await runPreCommitCheck({ workspacePath: dir, registry: makeRegistry(), timeoutMs: 5_000, runCommand: byExitCode });
    assert.match(codeOutcome.report, /not a git repository/i);

    // A genuinely broken git keeps blaming the tooling, not the repository.
    const toolingFailure: RunCommand = async () => ({ ok: false, stdout: "", stderr: "spawn git ENOENT", exitCode: 1 });
    const toolingOutcome = await runPreCommitCheck({ workspacePath: dir, registry: makeRegistry(), timeoutMs: 5_000, runCommand: toolingFailure });
    assert.match(toolingOutcome.report, /unavailable or timed out/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
