import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { AuditTrail } from "./audit.js";

/**
 * This is the URL used by Ollama's own current macOS installer script. It is
 * deliberately a fixed HTTPS origin rather than a configurable URL: a bridge
 * command must never become an arbitrary binary downloader.
 */
export const OLLAMA_MACOS_DOWNLOAD_URL = "https://ollama.com/download/Ollama-darwin.zip";

/**
 * Windows receives an explicit, owner-operated installer flow. The bridge
 * never downloads, launches, or scripts this installer: it is only a stable
 * official destination for the remediation shown by `doctor` and `setup`.
 */
export const OLLAMA_WINDOWS_INSTALL_URL = "https://ollama.com/download/windows";

/** `worker` is an explicitly paired private-LAN peer-review role. */
export type LocalModelRole = "auditor" | "developer" | "worker";

export type LocalModelRequirement = {
  model: string;
  roles: LocalModelRole[];
};

export type OllamaModel = {
  name: string;
  size?: number;
};

export type OllamaInspection = {
  reachable: boolean;
  models: OllamaModel[];
  error?: string;
};

export type OllamaServiceResult = {
  ready: boolean;
  startedByBridge: boolean;
  error?: string;
};

export type OllamaExecutable = {
  available: boolean;
  /** The command that was successfully probed and can safely launch `serve`. */
  command?: string;
  version?: string;
  source?: OllamaExecutableSource;
};

export type OllamaExecutableSource = "path" | "app-bundle" | "windows-user-install";

/** A fixed local command candidate; it is never treated as shell text. */
export type OllamaExecutableCandidate = {
  command: string;
  source: OllamaExecutableSource;
};

export type OllamaRuntimeInstallPlan = {
  supported: boolean;
  platform: NodeJS.Platform;
  downloadUrl?: string;
  /** A browser destination for an owner-managed platform installer. */
  manualInstallUrl?: string;
  installDirectory?: string;
  appPath?: string;
  executablePath?: string;
  reason?: string;
};

export type OllamaRuntimeInstallResult = {
  ready: boolean;
  installed: boolean;
  appPath?: string;
  executablePath?: string;
  error?: string;
};

export type PullProgress = {
  model: string;
  status: string;
  completed?: number;
  total?: number;
};

export type LocalInfrastructure = {
  firstRun: boolean;
  auditPath: string;
  statePath: string;
};

/**
 * Plans a platform-safe Ollama setup without mutating the computer. macOS has
 * a tightly scoped, signed-app bootstrap; Windows deliberately has a manual
 * installer plan so the bridge never downloads or scripts a Windows binary.
 */
export function createOllamaRuntimeInstallPlan(options: {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  localAppDataDirectory?: string;
} = {}): OllamaRuntimeInstallPlan {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const executablePath = windowsOllamaExecutablePath(options);
    return {
      supported: false,
      platform,
      manualInstallUrl: OLLAMA_WINDOWS_INSTALL_URL,
      executablePath,
      reason: "Automatic Ollama runtime installation is intentionally disabled on Windows. Download and run the official OllamaSetup.exe installer from https://ollama.com/download/windows, open a new terminal so its user PATH update is available, then re-run the bridge.",
    };
  }
  if (platform !== "darwin") {
    return {
      supported: false,
      platform,
      reason: "Automatic Ollama runtime installation is currently supported only on macOS. Install Ollama from https://ollama.com, then re-run the bridge.",
    };
  }
  const homeDirectory = path.resolve(options.homeDirectory ?? os.homedir());
  const installDirectory = path.join(homeDirectory, "Applications", "Omnibus");
  const appPath = path.join(installDirectory, "Ollama.app");
  return {
    supported: true,
    platform,
    downloadUrl: OLLAMA_MACOS_DOWNLOAD_URL,
    installDirectory,
    appPath,
    executablePath: path.join(appPath, "Contents", "Resources", "ollama"),
  };
}

/**
 * Agent roles are configured independently even when they intentionally share
 * a single efficient model. This avoids duplicate disk downloads on a fresh
 * laptop while still permitting an owner to assign a larger developer model.
 */
export function requiredLocalModels(config: Pick<AppConfig, "ollamaModel" | "ollamaDeveloperModel">): LocalModelRequirement[] {
  const byModel = new Map<string, LocalModelRequirement>();
  const add = (model: string, role: LocalModelRole) => {
    const existing = byModel.get(model);
    if (existing) {
      existing.roles.push(role);
      return;
    }
    byModel.set(model, { model, roles: [role] });
  };
  add(config.ollamaModel, "auditor");
  add(config.ollamaDeveloperModel, "developer");
  return [...byModel.values()];
}

/** Creates private, inspectable local storage before any agent can run. */
export async function initializeLocalInfrastructure(config: AppConfig): Promise<LocalInfrastructure> {
  await Promise.all([
    mkdir(config.auditPath, { recursive: true, mode: 0o700 }),
    mkdir(config.statePath, { recursive: true, mode: 0o700 }),
  ]);

  const markerPath = path.join(config.statePath, "local-intelligence.json");
  let firstRun = false;
  try {
    await writeFile(markerPath, JSON.stringify({
      version: 1,
      initializedAt: new Date().toISOString(),
      runtime: "omnibus-bridge",
      storage: "local-only",
    }, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    firstRun = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  await new AuditTrail(config.auditPath).append({
    at: new Date().toISOString(),
    correlationId: `bootstrap-${randomUUID()}`,
    agent: "system",
    event: firstRun ? "local_intelligence_initialized" : "local_intelligence_started",
    data: {
      workspacePath: config.workspacePath,
      developerProvider: config.developerProvider,
      localModels: requiredLocalModels(config),
    },
  });
  return { firstRun, auditPath: config.auditPath, statePath: config.statePath };
}

/** Reads Ollama's local model inventory. It never downloads or starts anything. */
export async function inspectOllama(baseUrl: string): Promise<OllamaInspection> {
  try {
    const response = await fetch(`${normalizedBaseUrl(baseUrl)}/api/tags`, { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) return { reachable: false, models: [], error: `Ollama returned HTTP ${response.status}.` };
    const payload = await response.json() as { models?: unknown };
    const models = Array.isArray(payload.models)
      ? payload.models.flatMap(value => parseOllamaModel(value) ? [parseOllamaModel(value)!] : [])
      : [];
    return { reachable: true, models };
  } catch (error) {
    return { reachable: false, models: [], error: errorMessage(error) };
  }
}

/** Returns model-role assignments that are not yet present in Ollama's local store. */
export function missingLocalModels(requirements: LocalModelRequirement[], installed: OllamaModel[]): LocalModelRequirement[] {
  return requirements.filter(requirement => !installed.some(model => modelNamesMatch(requirement.model, model.name)));
}

/**
 * Starts `ollama serve` only when the configured endpoint is loopback, no
 * server is already reachable, and the Ollama executable is installed. The
 * service launch itself performs no model download.
 */
export async function ensureOllamaService(
  config: Pick<AppConfig, "ollamaBaseUrl">,
  options: { startIfNeeded: boolean; onStatus?: (message: string) => void } = { startIfNeeded: true },
): Promise<OllamaServiceResult> {
  const firstProbe = await inspectOllama(config.ollamaBaseUrl);
  if (firstProbe.reachable) return { ready: true, startedByBridge: false };
  if (!options.startIfNeeded) {
    return { ready: false, startedByBridge: false, error: `Ollama is not reachable at ${config.ollamaBaseUrl}.` };
  }
  if (!isLoopbackOllamaBaseUrl(config.ollamaBaseUrl)) {
    return {
      ready: false,
      startedByBridge: false,
      error: "Ollama auto-start is only allowed for a loopback OLLAMA_BASE_URL. Start the configured remote server yourself.",
    };
  }

  const executable = await inspectOllamaExecutable();
  if (!executable.available) {
    const runtimePlan = createOllamaRuntimeInstallPlan();
    return {
      ready: false,
      startedByBridge: false,
      error: runtimePlan.supported
        ? "Ollama is not installed. Re-run with `omnibus-bridge setup --install-runtime --pull-models` to explicitly provision the local runtime and model team."
        : runtimePlan.reason ?? "Ollama is not installed or is not on PATH. Install it from https://ollama.com, then re-run setup.",
    };
  }

  options.onStatus?.("Starting the installed Ollama service on this laptop…");
  const launched = launchOllamaService(executable.command!);
  if (!launched) {
    return { ready: false, startedByBridge: false, error: "Unable to launch `ollama serve`. Start Ollama manually and retry." };
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(300);
    const probe = await inspectOllama(config.ollamaBaseUrl);
    if (probe.reachable) return { ready: true, startedByBridge: true };
  }
  return {
    ready: false,
    startedByBridge: true,
    error: `Ollama did not become ready at ${config.ollamaBaseUrl}. Check its local logs and retry.`,
  };
}

/**
 * Returns the small, fixed local executable allow-list for the current
 * platform. Windows recognizes Ollama's documented per-user installer path;
 * macOS also recognizes the signed app locations. No candidate is shell text
 * and a custom installation remains supported through PATH.
 */
export function ollamaExecutableCandidates(options: {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  localAppDataDirectory?: string;
} = {}): OllamaExecutableCandidate[] {
  const platform = options.platform ?? process.platform;
  const candidates: OllamaExecutableCandidate[] = [{ command: "ollama", source: "path" }];
  if (platform === "darwin") {
    candidates.push(...macOSAppExecutableCandidates(options).map(command => ({ command, source: "app-bundle" as const })));
  } else if (platform === "win32") {
    candidates.push({ command: windowsOllamaExecutablePath(options), source: "windows-user-install" });
  }
  return candidates;
}

/** Probes only the fixed candidates returned by `ollamaExecutableCandidates`. */
export async function inspectOllamaExecutable(options: {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  localAppDataDirectory?: string;
} = {}): Promise<OllamaExecutable> {
  const candidates = ollamaExecutableCandidates(options);
  for (const candidate of candidates) {
    const version = await inspectExecutableVersion(candidate.command);
    if (version.available) return { ...version, command: candidate.command, source: candidate.source };
  }
  return { available: false };
}

/** Only a local endpoint may be started or provisioned by this bridge. */
export function isLoopbackOllamaBaseUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

/**
 * Explicitly installs the official macOS Ollama app into
 * ~/Applications/Omnibus/Ollama.app. It is intentionally never called from
 * npm lifecycle hooks or ordinary bridge startup: callers must first request
 * --install-runtime and obtain the owner's confirmation.
 *
 * The archive is fetched only over HTTPS, extracted into an owned temporary
 * directory, verified by both macOS code signing and Gatekeeper, and copied
 * only when the destination does not already exist. No sudo, shell pipeline,
 * or overwrite of /Applications/Ollama.app is involved.
 */
export async function installOllamaRuntime(options: {
  onStatus?: (message: string) => void;
  plan?: OllamaRuntimeInstallPlan;
} = {}): Promise<OllamaRuntimeInstallResult> {
  const plan = options.plan ?? createOllamaRuntimeInstallPlan();
  if (process.platform !== "darwin" || plan.platform !== "darwin" || !plan.supported || !plan.downloadUrl || !plan.installDirectory || !plan.appPath || !plan.executablePath) {
    return { ready: false, installed: false, error: plan.reason ?? "Automatic Ollama runtime installation is not available on this platform." };
  }

  const existing = await inspectOllamaExecutable();
  if (existing.available) {
    return {
      ready: true,
      installed: false,
      ...(existing.command ? { executablePath: existing.command } : {}),
    };
  }
  if (await isDirectory(plan.appPath)) {
    return {
      ready: false,
      installed: false,
      error: `Refusing to overwrite the existing ${plan.appPath}. Repair or remove that user-owned app bundle, then retry.`,
    };
  }

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "omnibus-ollama-runtime-"));
  try {
    const archivePath = path.join(temporaryDirectory, "Ollama-darwin.zip");
    const extractionDirectory = path.join(temporaryDirectory, "extracted");
    options.onStatus?.("Downloading the official Ollama macOS runtime over HTTPS…");
    await runInstallerCommand("/usr/bin/curl", [
      "--proto", "=https",
      "--proto-redir", "=https",
      "--fail",
      "--show-error",
      "--location",
      "--max-filesize", "2147483648",
      "--output", archivePath,
      plan.downloadUrl,
    ]);
    if (!(await isNonEmptyFile(archivePath))) {
      throw new Error("The official Ollama download was empty; no runtime was installed.");
    }

    options.onStatus?.("Verifying the signed Ollama app with macOS security tools…");
    await runInstallerCommand("/usr/bin/unzip", ["-q", archivePath, "-d", extractionDirectory]);
    const extractedAppPath = path.join(extractionDirectory, "Ollama.app");
    if (!(await isDirectory(extractedAppPath))) {
      throw new Error("The official Ollama archive did not contain Ollama.app; no runtime was installed.");
    }
    await runInstallerCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", extractedAppPath]);
    await runInstallerCommand("/usr/sbin/spctl", ["--assess", "--type", "execute", extractedAppPath]);

    await mkdir(plan.installDirectory, { recursive: true, mode: 0o755 });
    if (await isDirectory(plan.appPath)) {
      throw new Error(`Refusing to overwrite ${plan.appPath}; another installation appeared while the download was running.`);
    }
    options.onStatus?.(`Installing the verified runtime into ${plan.appPath}…`);
    await runInstallerCommand("/usr/bin/ditto", [extractedAppPath, plan.appPath]);
    if (!(await isDirectory(plan.appPath))) {
      throw new Error("Ollama was not copied into the user Applications folder; no runtime was installed.");
    }

    const installed = await inspectExecutableVersion(plan.executablePath);
    if (!installed.available) {
      throw new Error("The copied Ollama app does not expose a runnable local CLI; no service was started.");
    }
    return {
      ready: true,
      installed: true,
      appPath: plan.appPath,
      executablePath: plan.executablePath,
    };
  } catch (error) {
    return { ready: false, installed: false, error: errorMessage(error) };
  } finally {
    // This directory is created by mkdtemp above and contains only the
    // verified archive/extraction from this invocation.
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function macOSAppExecutableCandidates(options: { homeDirectory?: string } = {}): string[] {
  const homeDirectory = options.homeDirectory ?? os.homedir();
  return [
    "/Applications/Ollama.app/Contents/Resources/ollama",
    path.join(homeDirectory, "Applications", "Ollama.app", "Contents", "Resources", "ollama"),
    path.join(homeDirectory, "Applications", "Omnibus", "Ollama.app", "Contents", "Resources", "ollama"),
  ];
}

/**
 * Ollama's documented Windows installer location. `path.win32` keeps the
 * planned executable deterministic in tests run on non-Windows hosts; at
 * runtime Windows supplies LOCALAPPDATA and the resulting path is native.
 */
function windowsOllamaExecutablePath(options: {
  homeDirectory?: string;
  localAppDataDirectory?: string;
}): string {
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const localAppDataDirectory = options.localAppDataDirectory
    ?? (process.platform === "win32" ? process.env.LOCALAPPDATA : undefined)
    ?? path.win32.join(homeDirectory, "AppData", "Local");
  return path.win32.join(localAppDataDirectory, "Programs", "Ollama", "ollama.exe");
}

/** Safely checks whether one particular local executable can be invoked. */
async function inspectExecutableVersion(command: string): Promise<{ available: boolean; version?: string }> {
  return new Promise(resolve => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (value: { available: boolean; version?: string }) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(value);
    };
    let output = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, ["--version"], { shell: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      finish({ available: false });
      return;
    }
    timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ available: false });
    }, 3_000);
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.once("error", () => finish({ available: false }));
    child.once("close", code => finish(code === 0 ? { available: true, version: output.trim() || undefined } : { available: false }));
  });
}

/**
 * Downloads precisely the supplied model list through Ollama's local API.
 * Callers are responsible for getting affirmative user consent first; this
 * module deliberately has no import-time or start-time pull behavior.
 */
export async function pullLocalModels(
  baseUrl: string,
  requirements: LocalModelRequirement[],
  onProgress: (progress: PullProgress) => void,
): Promise<void> {
  for (const requirement of requirements) {
    onProgress({ model: requirement.model, status: `Downloading for ${requirement.roles.join(" + ")}` });
    const response = await fetch(`${normalizedBaseUrl(baseUrl)}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: requirement.model, stream: true }),
      signal: AbortSignal.timeout(60 * 60 * 1_000),
    });
    if (!response.ok || !response.body) throw new Error(`Ollama could not pull ${requirement.model} (HTTP ${response.status}).`);
    await consumePullStream(response.body, requirement.model, onProgress);
  }
}

function parseOllamaModel(value: unknown): OllamaModel | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { name?: unknown; model?: unknown; size?: unknown };
  const name = typeof raw.name === "string" ? raw.name : typeof raw.model === "string" ? raw.model : null;
  if (!name) return null;
  return { name, ...(typeof raw.size === "number" && Number.isFinite(raw.size) ? { size: raw.size } : {}) };
}

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function modelNamesMatch(required: string, installed: string): boolean {
  const normalizedRequired = required.trim().toLowerCase();
  const normalizedInstalled = installed.trim().toLowerCase();
  if (normalizedRequired === normalizedInstalled) return true;
  const withoutLatest = (value: string) => value.endsWith(":latest") ? value.slice(0, -":latest".length) : value;
  return withoutLatest(normalizedRequired) === withoutLatest(normalizedInstalled);
}

function launchOllamaService(command: string): boolean {
  try {
    const child = spawn(command, ["serve"], {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    // The detached local service outlives this short-lived setup invocation.
    // We still probe the HTTP API before reporting it usable.
    child.once("error", () => undefined);
    child.unref();
    return true;
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

async function isNonEmptyFile(target: string): Promise<boolean> {
  try {
    const details = await stat(target);
    return details.isFile() && details.size > 0;
  } catch {
    return false;
  }
}

/** Executes a fixed system utility without a shell or interpolated command text. */
function runInstallerCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { shell: false, stdio: "inherit", windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited with status ${code ?? "unknown"}.`));
    });
  });
}

async function consumePullStream(
  body: ReadableStream<Uint8Array>,
  model: string,
  onProgress: (progress: PullProgress) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastMessage = "";
  const handleLine = (line: string) => {
    if (!line.trim()) return;
    let packet: { status?: unknown; completed?: unknown; total?: unknown; error?: unknown };
    try {
      packet = JSON.parse(line) as { status?: unknown; completed?: unknown; total?: unknown; error?: unknown };
    } catch {
      return;
    }
    if (typeof packet.error === "string") throw new Error(`Ollama failed to pull ${model}: ${packet.error}`);
    const status = typeof packet.status === "string" ? packet.status : "Downloading";
    const completed = typeof packet.completed === "number" ? packet.completed : undefined;
    const total = typeof packet.total === "number" ? packet.total : undefined;
    const fingerprint = `${status}:${completed ?? ""}:${total ?? ""}`;
    if (fingerprint !== lastMessage) {
      lastMessage = fingerprint;
      onProgress({ model, status, ...(completed === undefined ? {} : { completed }), ...(total === undefined ? {} : { total }) });
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  }
  buffer += decoder.decode();
  if (buffer.trim()) handleLine(buffer);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown local service error.";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
