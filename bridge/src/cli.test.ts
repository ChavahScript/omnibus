import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildDoctorReport,
  formatDoctorTag,
  inspectStorage,
  parseCliArguments,
  planWorkerResidency,
  runCli,
  smallLaptopCapacityWarning,
  workerIdentityLines,
} from "./cli.js";
import { DEFAULT_LOCAL_MODEL } from "./config.js";
import { createOllamaRuntimeInstallPlan } from "./local-intelligence.js";

test("the safe first-run command requires an explicit model-pull flag", () => {
  assert.deepEqual(parseCliArguments(["setup"]), {
    command: "setup",
    installRuntime: false,
    pullModels: false,
    yes: false,
    startOllama: true,
    fix: false,
    force: false,
  });
  assert.deepEqual(parseCliArguments(["setup", "--install-runtime", "--pull-models", "--yes"]), {
    command: "setup",
    installRuntime: true,
    pullModels: true,
    yes: true,
    startOllama: true,
    fix: false,
    force: false,
  });
});

test("the CLI rejects noninteractive consent without an explicit download request", () => {
  assert.throws(() => parseCliArguments(["start", "--yes"]), /only valid with --install-runtime and\/or --pull-models/);
  assert.throws(() => parseCliArguments(["setup", "--unknown"]), /Unknown option/);
  assert.throws(() => parseCliArguments(["doctor", "--install-runtime"]), /doctor is read-only/);
});

test("the advertised help subcommand is accepted alongside --help", () => {
  assert.equal(parseCliArguments(["help"]).command, "help");
  assert.equal(parseCliArguments(["--help"]).command, "help");
});

test("the worker command accepts only an explicit invitation payload", () => {
  assert.deepEqual(parseCliArguments(["worker", "--join", "eyJ0eXBlIjoiaG9tZV9mbGVldC5qb2luIn0", "--pull-models"]), {
    command: "worker",
    installRuntime: false,
    pullModels: true,
    yes: false,
    startOllama: true,
    fix: false,
    force: false,
    joinPayload: "eyJ0eXBlIjoiaG9tZV9mbGVldC5qb2luIn0",
  });
  assert.throws(() => parseCliArguments(["start", "--join", "payload"]), /only valid with `omnibus-bridge worker`/);
  assert.throws(() => parseCliArguments(["worker", "--join"]), /requires one base64url invitation/);
});

test("the hook command exposes exactly three gate actions with scoped flags", () => {
  assert.deepEqual(parseCliArguments(["hook", "check", "--staged", "--fix"]), {
    command: "hook",
    hookAction: "check",
    installRuntime: false,
    pullModels: false,
    yes: false,
    startOllama: true,
    fix: true,
    force: false,
  });
  assert.equal(parseCliArguments(["hook", "install", "--force"]).hookAction, "install");
  assert.equal(parseCliArguments(["hook", "uninstall"]).hookAction, "uninstall");
  assert.throws(() => parseCliArguments(["hook"]), /needs one action/);
  assert.throws(() => parseCliArguments(["hook", "run"]), /needs one action/);
  assert.throws(() => parseCliArguments(["hook", "check", "--pull-models"]), /never download software or models/);
  assert.throws(() => parseCliArguments(["hook", "install", "--fix"]), /only valid with `omnibus-bridge hook check`/);
  assert.throws(() => parseCliArguments(["setup", "--force"]), /only valid with `omnibus-bridge hook install`/);
});

test("the worker --label flag names the laptop and is rejected elsewhere", () => {
  const options = parseCliArguments(["worker", "--join", "eyJ0eXBlIjoiaG9tZV9mbGVldC5qb2luIn0", "--label", "  Kitchen   MacBook  "]);
  assert.equal(options.workerLabel, "Kitchen MacBook");
  assert.throws(() => parseCliArguments(["worker", "--label"]), /requires a name/);
  assert.throws(() => parseCliArguments(["start", "--label", "Desk"]), /only valid with `omnibus-bridge worker`/);
});

// ---------------------------------------------------------------------------
// Doctor report, storage probe, capacity warning, worker residency/identity
// ---------------------------------------------------------------------------

function doctorConfig() {
  return {
    ollamaBaseUrl: "http://127.0.0.1:11434",
    auditPath: "/ws/.omnibus/audit",
    workspacePath: "/ws",
    brainCapacityTier: "compact" as const,
    ollamaNumCtx: 8_192,
    brainMaxNodes: 1_500,
    brainMaxFacts: 4_000,
    developerProvider: "ollama" as const,
    webResearchEnabled: false,
    webResearchProvider: "brave" as const,
  };
}

const macRuntimePlan = createOllamaRuntimeInstallPlan({ platform: "darwin", homeDirectory: "/Users/ada" });

test("doctor stays healthy when the Ollama service answers without a PATH binary", () => {
  const report = buildDoctorReport({
    config: doctorConfig(),
    ollama: { reachable: true, models: [{ name: "m" }] },
    executable: { available: false },
    storage: { ready: true },
    required: [{ model: "m", roles: ["auditor", "developer"] }],
    missing: [],
    runtimePlan: macRuntimePlan,
    totalMemoryBytes: 8 * 1024 ** 3,
  });
  assert.equal(report.unhealthy, false);
  assert.ok(report.lines.some(line => line.includes("service reachable; a PATH binary is not required")));
  assert.ok(!report.lines.some(line => line.includes("--install-runtime")), "no runtime install is prescribed while the service answers");
});

test("doctor prescribes --install-runtime only when service AND binary are absent", () => {
  const report = buildDoctorReport({
    config: doctorConfig(),
    ollama: { reachable: false, models: [], error: "connection refused — nothing is listening at that address (ECONNREFUSED)" },
    executable: { available: false },
    storage: { ready: true },
    required: [{ model: "m", roles: ["auditor", "developer"] }],
    missing: [],
    runtimePlan: macRuntimePlan,
    totalMemoryBytes: 8 * 1024 ** 3,
  });
  assert.equal(report.unhealthy, true);
  assert.ok(report.lines.some(line => line.includes("setup --install-runtime --pull-models")));
  assert.ok(report.lines.some(line => line.includes("ECONNREFUSED")));
});

test("doctor status tags align every row's text in the same column", () => {
  for (const kind of ["ok", "x", "!", "i"] as const) {
    assert.equal(formatDoctorTag(kind).length, 4);
  }
  const report = buildDoctorReport({
    config: { ...doctorConfig(), webResearchEnabled: true },
    ollama: { reachable: false, models: [], error: "unreachable" },
    executable: { available: false },
    storage: { ready: false },
    required: [{ model: "m", roles: ["auditor", "developer"] }],
    missing: [{ model: "m", roles: ["auditor", "developer"] }],
    runtimePlan: macRuntimePlan,
    totalMemoryBytes: 8 * 1024 ** 3,
  });
  const tagged = report.lines.filter(line => line.startsWith("["));
  assert.ok(tagged.length >= 5);
  for (const line of tagged) {
    assert.match(line.slice(0, 5), /^\[(?:ok|x|!|i)\] *$/, `misaligned tag in: ${line}`);
    assert.notEqual(line[5], " ", `text must start at column 5 in: ${line}`);
  }
});

test("doctor reports an unwritable parent instead of promising storage creation", () => {
  const report = buildDoctorReport({
    config: doctorConfig(),
    ollama: { reachable: true, models: [{ name: "m" }] },
    executable: { available: true, version: "1.0" },
    storage: { ready: false, blockedBy: "/ws" },
    required: [{ model: "m", roles: ["auditor", "developer"] }],
    missing: [],
    runtimePlan: macRuntimePlan,
    totalMemoryBytes: 8 * 1024 ** 3,
  });
  assert.equal(report.unhealthy, true);
  const line = report.lines.find(entry => entry.includes("Local storage"));
  assert.ok(line);
  assert.match(line, /\/ws is not writable/);
  assert.match(line, /WORKSPACE_ROOT/);
  assert.doesNotMatch(line, /will be created/);
});

test("inspectStorage checks the nearest existing parent before promising creation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omnibus-cli-storage-"));
  try {
    const open = path.join(dir, "open");
    await mkdir(open, { recursive: true });
    const creatable = await inspectStorage({
      auditPath: path.join(open, ".omnibus", "audit"),
      statePath: path.join(open, ".omnibus", "state"),
    });
    assert.deepEqual(creatable, { ready: false });

    const locked = path.join(dir, "locked");
    await mkdir(locked, { mode: 0o555 });
    const blocked = await inspectStorage({
      auditPath: path.join(locked, ".omnibus", "audit"),
      statePath: path.join(locked, ".omnibus", "state"),
    });
    assert.equal(blocked.ready, false);
    assert.equal(blocked.blockedBy, locked);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a small laptop with the default 7B team gets a loud, non-mutating warning", () => {
  const GIB = 1024 ** 3;
  const base = {
    ollamaModel: DEFAULT_LOCAL_MODEL,
    ollamaDeveloperModel: DEFAULT_LOCAL_MODEL,
    fleetProfileStored: false,
    totalMemoryBytes: 8 * GIB,
  };
  const warning = smallLaptopCapacityWarning(base);
  assert.ok(warning);
  assert.match(warning, /8 GB/);
  assert.match(warning, /~5-7 GB/);
  assert.match(warning, /Compact fleet in Fleet Setup/);
  assert.match(warning, /OLLAMA_MODEL/);
  assert.match(warning, /No model was swapped automatically/);

  // Any explicit hardware-aware choice silences it.
  assert.equal(smallLaptopCapacityWarning({ ...base, fleetProfileStored: true }), undefined);
  assert.equal(smallLaptopCapacityWarning({ ...base, totalMemoryBytes: 16 * GIB }), undefined);
  assert.equal(smallLaptopCapacityWarning({
    ...base,
    ollamaModel: "qwen2.5-coder:1.5b",
    ollamaDeveloperModel: "qwen2.5-coder:1.5b",
  }), undefined);
  // One role still on the 7B default keeps the warning.
  assert.ok(smallLaptopCapacityWarning({ ...base, ollamaModel: "qwen2.5-coder:1.5b" }));
});

test("a co-resident coordinator forces worker keep_alive 0 and disables warming", () => {
  assert.deepEqual(planWorkerResidency({ coordinatorCoResident: false, configuredKeepAlive: "10m" }), {
    keepAlive: "10m",
    contextWarmingEnabled: true,
  });
  const shared = planWorkerResidency({ coordinatorCoResident: true, configuredKeepAlive: "10m" });
  assert.equal(shared.keepAlive, "0");
  assert.equal(shared.contextWarmingEnabled, false);
  assert.match(shared.notice ?? "", /coordinator runs from this same workspace/i);
  assert.match(shared.notice ?? "", /two resident models/);
});

test("worker terminals always name the laptop's Fleet Setup label", () => {
  assert.deepEqual(workerIdentityLines("Kitchen MacBook", false), [
    'Fleet Setup shows this laptop as "Kitchen MacBook".',
  ]);
  assert.deepEqual(workerIdentityLines("macOS Peer · Cedar", true), [
    'Fleet Setup shows this laptop as "macOS Peer · Cedar".',
    'Rename it any time: omnibus-bridge worker --label "Kitchen MacBook"',
  ]);
});

test("worker validates pairing preconditions before engaging keep-awake", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omnibus-cli-worker-"));
  const previousRoot = process.env.WORKSPACE_ROOT;
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    process.env.WORKSPACE_ROOT = dir;
    await assert.rejects(runCli(["worker"]), /--join <invitation>/);
    assert.ok(!logs.some(line => line.startsWith("[power]")), "keep-awake must not engage before validation");
  } finally {
    console.log = originalLog;
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
    await rm(dir, { recursive: true, force: true });
  }
});
