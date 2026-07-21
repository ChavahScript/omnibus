import { spawn as nodeSpawn } from "node:child_process";

/**
 * Best-effort host sleep inhibition for a running coordinator or worker.
 *
 * It intentionally does not change global power plans, install drivers, run
 * a shell, or try to defeat an owner closing a laptop lid. Instead it starts
 * the platform's normal user-process inhibitor and keeps that helper alive
 * only while Omnibus is actively serving. If a platform policy rejects it,
 * Omnibus continues normally and reports the degraded protection locally.
 */
export type KeepAwakeStrategy = "disabled" | "caffeinate" | "windows-execution-state" | "systemd-inhibit" | "unavailable";

export type KeepAwakeStatus = {
  enabled: boolean;
  active: boolean;
  strategy: KeepAwakeStrategy;
  restartAttempt: number;
  message: string;
};

export type KeepAwakeChild = {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(): boolean | void;
};

export type KeepAwakeSpawn = (command: string, args: string[], options: {
  stdio: "ignore";
  windowsHide: boolean;
}) => KeepAwakeChild;

export type KeepAwakeOptions = {
  enabled: boolean;
  platform?: NodeJS.Platform;
  /** Injectable only for deterministic tests; production uses this Node PID. */
  parentPid?: number;
  /** Injectable only for deterministic tests; production uses this Node executable. */
  nodeExecutable?: string;
  spawn?: KeepAwakeSpawn;
  onStatus?: (status: KeepAwakeStatus) => void;
  /** Testable bounded retry values; production defaults favor battery safety. */
  restartBaseMs?: number;
  restartMaxMs?: number;
};

type CommandPlan = {
  strategy: Exclude<KeepAwakeStrategy, "disabled" | "unavailable">;
  command: string;
  args: string[];
};

const DEFAULT_RESTART_BASE_MS = 5_000;
const DEFAULT_RESTART_MAX_MS = 5 * 60_000;
const STABLE_HELPER_RESET_MS = 60_000;

// This is fixed source text, never interpolated with a workspace, model,
// hostname, or user directive. SetThreadExecutionState must be invoked by the
// process that remains alive, which is why the Windows helper is a small
// PowerShell host rather than a one-off command.
function windowsExecutionStateScript(parentPid: number): string {
  return [
  "Add-Type -TypeDefinition @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class OmnibusExecutionState {",
  "  [DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint flags);",
  "}",
  "'@",
  `$parentPid = ${parentPid}`,
  "while ($true) {",
  "  try { Get-Process -Id $parentPid -ErrorAction Stop | Out-Null } catch { break }",
  "  [OmnibusExecutionState]::SetThreadExecutionState(0x80000001) | Out-Null",
  "  Start-Sleep -Seconds 30",
  "}",
  ].join("\n");
}

// This child is deliberately tiny and contains no network, filesystem, or
// user-controlled input. `systemd-inhibit` holds its assertion only while the
// Node parent exists, including after an unexpected parent crash.
const LINUX_PARENT_WATCH_SCRIPT = [
  "const parentPid = Number(process.argv[1]);",
  "const watch = () => { try { process.kill(parentPid, 0); } catch { process.exit(0); } };",
  "watch();",
  "setInterval(watch, 5000);",
].join(" ");

/** Exposed for deterministic tests and transparent platform behavior. */
export function keepAwakeCommandFor(
  platform: NodeJS.Platform,
  parentPid = process.pid,
  nodeExecutable = process.execPath,
): CommandPlan | undefined {
  const safeParentPid = Number.isSafeInteger(parentPid) && parentPid > 0 ? parentPid : process.pid;
  switch (platform) {
    case "darwin":
      // Prevent idle system/disk sleep without forcing the display on. `-w`
      // makes caffeinate relinquish its assertion if this Node process dies.
      return { strategy: "caffeinate", command: "caffeinate", args: ["-i", "-m", "-w", String(safeParentPid)] };
    case "win32":
      return {
        strategy: "windows-execution-state",
        command: "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsExecutionStateScript(safeParentPid)],
      };
    case "linux":
      // systemd-inhibit is present on most contemporary desktop Linux hosts.
      // Its child is a fixed Node parent watcher, not a shell string, so a
      // killed coordinator cannot leave an endless sleep inhibitor behind.
      return {
        strategy: "systemd-inhibit",
        command: "systemd-inhibit",
        args: ["--what=idle:sleep", "--mode=block", "--why=Omnibus local work is active", nodeExecutable, "-e", LINUX_PARENT_WATCH_SCRIPT, String(safeParentPid)],
      };
    default:
      return undefined;
  }
}

/**
 * Owns one user-scoped sleep-inhibition helper. An unexpected helper exit is
 * retried with bounded exponential backoff, but a deliberate bridge shutdown
 * always cancels retries and releases the assertion immediately.
 */
export class KeepAwakeController {
  private readonly platform: NodeJS.Platform;
  private readonly spawn: KeepAwakeSpawn;
  private readonly plan: CommandPlan | undefined;
  private readonly restartBaseMs: number;
  private readonly restartMaxMs: number;
  private child: KeepAwakeChild | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private stabilityTimer: NodeJS.Timeout | undefined;
  private desired = false;
  private restartAttempt = 0;
  private statusValue: KeepAwakeStatus;

  public constructor(private readonly options: KeepAwakeOptions) {
    this.platform = options.platform ?? process.platform;
    this.spawn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions));
    this.plan = keepAwakeCommandFor(this.platform, options.parentPid ?? process.pid, options.nodeExecutable ?? process.execPath);
    this.restartBaseMs = clampDelay(options.restartBaseMs ?? DEFAULT_RESTART_BASE_MS, 100, DEFAULT_RESTART_MAX_MS);
    this.restartMaxMs = clampDelay(options.restartMaxMs ?? DEFAULT_RESTART_MAX_MS, this.restartBaseMs, 30 * 60_000);
    this.statusValue = this.initialStatus();
  }

  public async start(): Promise<KeepAwakeStatus> {
    this.desired = true;
    if (!this.options.enabled || !this.plan) return this.publish(this.initialStatus());
    if (!this.child && !this.retryTimer) this.launch();
    return this.status();
  }

  public async stop(): Promise<void> {
    this.desired = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.clearStabilityTimer();
    const child = this.child;
    this.child = undefined;
    this.restartAttempt = 0;
    if (child) {
      try {
        child.kill();
      } catch {
        // Releasing a best-effort assertion must never block bridge shutdown.
      }
    }
    this.publish({
      enabled: this.options.enabled,
      active: false,
      strategy: this.options.enabled ? (this.plan?.strategy ?? "unavailable") : "disabled",
      restartAttempt: 0,
      message: "Sleep inhibition released.",
    });
  }

  public status(): KeepAwakeStatus {
    return { ...this.statusValue };
  }

  private initialStatus(): KeepAwakeStatus {
    if (!this.options.enabled) {
      return { enabled: false, active: false, strategy: "disabled", restartAttempt: 0, message: "Sleep inhibition is disabled by OMNIBUS_KEEP_AWAKE=false." };
    }
    if (!this.plan) {
      return { enabled: true, active: false, strategy: "unavailable", restartAttempt: 0, message: `No supported sleep-inhibition helper is available for ${this.platform}.` };
    }
    return { enabled: true, active: false, strategy: this.plan.strategy, restartAttempt: 0, message: "Sleep inhibition is waiting to start." };
  }

  private launch(): void {
    if (!this.desired || !this.options.enabled || !this.plan || this.child) return;
    try {
      const child = this.spawn(this.plan.command, [...this.plan.args], { stdio: "ignore", windowsHide: true });
      this.child = child;
      this.publish({
        enabled: true,
        active: true,
        strategy: this.plan.strategy,
        restartAttempt: this.restartAttempt,
        message: "Keeping this laptop awake while Omnibus is serving local work.",
      });
      this.armStabilityReset(child);
      child.once("error", error => this.handleUnexpectedError(child, error));
      child.once("exit", (code, signal) => this.handleUnexpectedStop(child, `Sleep-inhibition helper stopped${code === null ? "" : ` (code ${code})`}${signal ? ` (${signal})` : ""}.`));
    } catch (error) {
      this.handleLaunchFailure(
        error instanceof Error ? `Sleep-inhibition helper could not start: ${error.message}` : "Sleep-inhibition helper could not start.",
        error,
      );
    }
  }

  private handleUnexpectedError(child: KeepAwakeChild, error: Error): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.clearStabilityTimer();
    if (!this.desired) return;
    this.handleLaunchFailure(`Sleep-inhibition helper could not start: ${error.message}`, error);
  }

  private handleUnexpectedStop(child: KeepAwakeChild, message: string): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.clearStabilityTimer();
    if (!this.desired) return;
    this.scheduleRetry(message);
  }

  /** Missing or forbidden helpers will not appear simply by retrying them. */
  private handleLaunchFailure(message: string, error: unknown): void {
    if (isPermanentHelperFailure(error)) {
      this.desired = false;
      this.restartAttempt = 0;
      this.publish({
        enabled: true,
        active: false,
        strategy: "unavailable",
        restartAttempt: 0,
        message: `${message} Omnibus will continue without sleep inhibition; install or permit the platform helper, then restart Omnibus.`,
      });
      return;
    }
    this.scheduleRetry(message);
  }

  private scheduleRetry(message: string): void {
    if (!this.desired || !this.options.enabled || !this.plan || this.retryTimer) return;
    this.restartAttempt += 1;
    const cap = Math.min(this.restartMaxMs, this.restartBaseMs * 2 ** Math.min(this.restartAttempt - 1, 10));
    // Deterministic, bounded spread avoids a thundering herd after a shared
    // power-service restart while making logs and tests reproducible.
    const delay = Math.min(this.restartMaxMs, Math.round(cap * 0.8));
    this.publish({
      enabled: true,
      active: false,
      strategy: this.plan.strategy,
      restartAttempt: this.restartAttempt,
      message: `${message} Retrying sleep inhibition in ${Math.ceil(delay / 1_000)}s.`,
    });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.launch();
    }, delay);
    this.retryTimer.unref();
  }

  /** A helper that stayed up for a minute has earned a fresh retry budget. */
  private armStabilityReset(child: KeepAwakeChild): void {
    this.clearStabilityTimer();
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = undefined;
      if (this.child !== child) return;
      this.restartAttempt = 0;
      this.publish({
        enabled: true,
        active: true,
        strategy: this.plan!.strategy,
        restartAttempt: 0,
        message: "Keeping this laptop awake while Omnibus is serving local work.",
      });
    }, STABLE_HELPER_RESET_MS);
    this.stabilityTimer.unref();
  }

  private clearStabilityTimer(): void {
    if (!this.stabilityTimer) return;
    clearTimeout(this.stabilityTimer);
    this.stabilityTimer = undefined;
  }

  private publish(status: KeepAwakeStatus): KeepAwakeStatus {
    this.statusValue = status;
    this.options.onStatus?.(this.status());
    return this.status();
  }
}

function clampDelay(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function isPermanentHelperFailure(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}
