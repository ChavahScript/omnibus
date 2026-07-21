import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import {
  OLLAMA_MACOS_DOWNLOAD_URL,
  OLLAMA_WINDOWS_INSTALL_URL,
  createOllamaRuntimeInstallPlan,
  initializeLocalInfrastructure,
  isLoopbackOllamaBaseUrl,
  missingLocalModels,
  ollamaExecutableCandidates,
  requiredLocalModels,
  type LocalModelRequirement,
} from "./local-intelligence.js";

test("the macOS runtime bootstrap is user-scoped and pinned to Ollama's HTTPS download origin", () => {
  const plan = createOllamaRuntimeInstallPlan({ platform: "darwin", homeDirectory: "/Users/ada" });
  assert.deepEqual(plan, {
    supported: true,
    platform: "darwin",
    downloadUrl: OLLAMA_MACOS_DOWNLOAD_URL,
    installDirectory: "/Users/ada/Applications/Omnibus",
    appPath: "/Users/ada/Applications/Omnibus/Ollama.app",
    executablePath: "/Users/ada/Applications/Omnibus/Ollama.app/Contents/Resources/ollama",
  });
  assert.match(OLLAMA_MACOS_DOWNLOAD_URL, /^https:\/\/ollama\.com\//);
  assert.doesNotMatch(plan.appPath!, /^\/Applications\//);
});

test("runtime bootstrap declines unsupported platforms and only permits local Ollama endpoints", () => {
  const plan = createOllamaRuntimeInstallPlan({ platform: "linux", homeDirectory: "/home/ada" });
  assert.equal(plan.supported, false);
  assert.match(plan.reason!, /only on macOS/);
  assert.equal(isLoopbackOllamaBaseUrl("http://127.0.0.1:11434"), true);
  assert.equal(isLoopbackOllamaBaseUrl("http://localhost:11434"), true);
  assert.equal(isLoopbackOllamaBaseUrl("https://ollama.example.test"), false);
});

test("Windows uses an owner-managed Ollama installer and plans only documented local executable probes", () => {
  const plan = createOllamaRuntimeInstallPlan({
    platform: "win32",
    homeDirectory: "C:\\Users\\ada",
    localAppDataDirectory: "C:\\Users\\ada\\AppData\\Local",
  });
  assert.equal(plan.supported, false);
  assert.equal(plan.manualInstallUrl, OLLAMA_WINDOWS_INSTALL_URL);
  assert.equal(plan.executablePath, "C:\\Users\\ada\\AppData\\Local\\Programs\\Ollama\\ollama.exe");
  assert.match(plan.reason!, /intentionally disabled on Windows/i);
  assert.match(plan.reason!, /official OllamaSetup\.exe installer/i);

  assert.deepEqual(ollamaExecutableCandidates({
    platform: "win32",
    homeDirectory: "C:\\Users\\ada",
    localAppDataDirectory: "C:\\Users\\ada\\AppData\\Local",
  }), [
    { command: "ollama", source: "path" },
    { command: "C:\\Users\\ada\\AppData\\Local\\Programs\\Ollama\\ollama.exe", source: "windows-user-install" },
  ]);
});

test("model requirements deduplicate a shared local model while retaining both agent roles", () => {
  const requirements = requiredLocalModels({
    ollamaModel: "qwen2.5-coder:7b-instruct-q4_K_M",
    ollamaDeveloperModel: "qwen2.5-coder:7b-instruct-q4_K_M",
  });
  assert.deepEqual(requirements, [{
    model: "qwen2.5-coder:7b-instruct-q4_K_M",
    roles: ["auditor", "developer"],
  }]);
});

test("model readiness accepts Ollama's equivalent latest tag and reports only missing roles", () => {
  const requirements: LocalModelRequirement[] = [
    { model: "model-a:latest", roles: ["auditor"] },
    { model: "model-b", roles: ["developer"] },
  ];
  assert.deepEqual(missingLocalModels(requirements, [{ name: "model-a" }]), [requirements[1]]);
});

test("local infrastructure is initialized in the caller workspace, not the npm package directory", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "omnibus-bridge-test-"));
  try {
    const config = loadConfig({
      cwd: workspace,
      env: {
        WORKSPACE_ROOT: ".",
        AUDIT_DIR: ".omnibus/audit",
        STATE_DIR: ".omnibus/state",
      },
    });
    const initialized = await initializeLocalInfrastructure(config);
    assert.equal(initialized.firstRun, true);
    await access(path.join(workspace, ".omnibus", "audit"));
    const marker = await readFile(path.join(workspace, ".omnibus", "state", "local-intelligence.json"), "utf8");
    assert.match(marker, /"runtime": "omnibus-bridge"/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
