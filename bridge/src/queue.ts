import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CommandQueueSnapshotSchema,
  type ClientCommand,
  type CommandQueueSnapshot,
  type QueueJob,
} from "./contracts.js";

const EMPTY_QUEUE: CommandQueueSnapshot = {
  version: 1,
  updatedAt: new Date(0).toISOString(),
  jobs: [],
};

const MAX_FAILED_HISTORY = 16;
const MAX_RETRY_DELAY_MS = 60_000;

export type DurableQueueOptions = {
  maxPending: number;
  maxAttempts: number;
  retryBaseMs: number;
  /** Injectable only to make retry and recovery behaviour deterministic in tests. */
  now?: () => Date;
};

export type QueueEnqueueResult =
  | { accepted: true; job: QueueJob; position: number }
  | { accepted: false; reason: "QUEUE_FULL" | "DUPLICATE"; pending: number };

export type QueueFailureResult =
  | { retry: true; job: QueueJob; delayMs: number }
  | { retry: false; job: QueueJob };

/**
 * A tiny, disk-backed serial queue for owner-authorized commands.
 *
 * It deliberately has no worker loop and never starts work on its own: the
 * orchestrator explicitly claims one ready job, settles it, then decides when
 * to claim the next one. That keeps local inference serial, inspectable, and
 * bounded even when several paired devices submit requests at once.
 */
export class DurableCommandQueue {
  private readonly target: string;
  private state: CommandQueueSnapshot | undefined;
  private serial: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;

  public constructor(stateDir: string, private readonly options: DurableQueueOptions) {
    this.target = path.join(stateDir, "command-queue.json");
    this.now = options.now ?? (() => new Date());
  }

  public async enqueue(command: ClientCommand, ownerScope = "legacy"): Promise<QueueEnqueueResult> {
    return this.withLock(async () => {
      const state = await this.load();
      const pending = pendingJobs(state).length;
      const existingIndex = state.jobs.findIndex(job => job.id === command.correlationId);
      if (existingIndex >= 0 && state.jobs[existingIndex]!.status !== "failed") {
        return { accepted: false, reason: "DUPLICATE", pending };
      }
      if (pending >= this.options.maxPending) {
        return { accepted: false, reason: "QUEUE_FULL", pending };
      }

      // A colliding failed record is retained history, not live work: after a
      // restart-recovered failure the owner resubmits the same correlationId,
      // and that resubmission must start fresh attempts rather than being
      // refused as a duplicate of its own failure.
      if (existingIndex >= 0) state.jobs.splice(existingIndex, 1);

      const at = this.now().toISOString();
      const job: QueueJob = {
        id: command.correlationId,
        command,
        ownerScope: ownerScope.slice(0, 128) || "legacy",
        status: "queued",
        createdAt: at,
        updatedAt: at,
        attempts: 0,
        maxAttempts: this.options.maxAttempts,
        nextAttemptAt: null,
      };
      state.jobs.push(job);
      pruneFailedHistory(state);
      state.updatedAt = at;
      await this.persist(state);
      return { accepted: true, job: clone(job), position: pending + 1 };
    });
  }

  /**
   * Marks exactly one due job as running and persists that transition before
   * any model call begins. A crash therefore recovers a known job rather than
   * silently losing an in-flight directive.
   */
  public async claimNext(): Promise<QueueJob | null> {
    return this.withLock(async () => {
      const state = await this.load();
      const now = this.now();
      const job = state.jobs.find(candidate => isReady(candidate, now));
      if (!job) return null;

      job.status = "running";
      job.attempts += 1;
      job.nextAttemptAt = null;
      job.updatedAt = now.toISOString();
      state.updatedAt = job.updatedAt;
      await this.persist(state);
      return clone(job);
    });
  }

  /** Removes a completed command; its durable result belongs in audit/memory. */
  public async complete(jobId: string): Promise<void> {
    await this.withLock(async () => {
      const state = await this.load();
      const index = state.jobs.findIndex(job => job.id === jobId);
      if (index < 0) return;
      state.jobs.splice(index, 1);
      state.updatedAt = this.now().toISOString();
      await this.persist(state);
    });
  }

  /**
   * Persists retry state with capped exponential backoff. A terminal failure
   * remains as short, redacted history so the owner can inspect why a command
   * stopped without allowing it to consume pending queue capacity forever.
   */
  public async fail(jobId: string, error: string): Promise<QueueFailureResult> {
    return this.withLock(async () => {
      const state = await this.load();
      const job = state.jobs.find(candidate => candidate.id === jobId);
      if (!job) throw new Error(`Queue job ${jobId} is no longer available.`);
      const at = this.now();
      job.lastError = redactError(error);
      job.updatedAt = at.toISOString();

      if (job.attempts >= job.maxAttempts) {
        job.status = "failed";
        job.nextAttemptAt = null;
        pruneFailedHistory(state);
        state.updatedAt = job.updatedAt;
        await this.persist(state);
        return { retry: false, job: clone(job) };
      }

      const delayMs = retryDelayMs(this.options.retryBaseMs, job.attempts);
      job.status = "retrying";
      job.nextAttemptAt = new Date(at.getTime() + delayMs).toISOString();
      state.updatedAt = job.updatedAt;
      await this.persist(state);
      return { retry: true, job: clone(job), delayMs };
    });
  }

  /**
   * Ends a recovered command without retrying it. This is used when the
   * original paired socket is gone after a bridge restart: automatic replay
   * could otherwise write to a workspace or start a paid provider job without
   * a currently connected owner's confirmation.
   */
  public async abandon(jobId: string, error: string): Promise<QueueJob | null> {
    return this.withLock(async () => {
      const state = await this.load();
      const job = state.jobs.find(candidate => candidate.id === jobId);
      if (!job) return null;
      job.status = "failed";
      job.nextAttemptAt = null;
      job.lastError = redactError(error);
      job.updatedAt = this.now().toISOString();
      pruneFailedHistory(state);
      state.updatedAt = job.updatedAt;
      await this.persist(state);
      return clone(job);
    });
  }

  /** Returns zero for immediately ready work, null when no pending work exists. */
  public async nextReadyDelayMs(): Promise<number | null> {
    return this.withLock(async () => {
      const state = await this.load();
      const now = this.now().getTime();
      const pending = pendingJobs(state);
      if (pending.length === 0) return null;
      if (pending.some(job => job.status === "queued")) return 0;
      const nextAt = pending
        .map(job => job.nextAttemptAt ? new Date(job.nextAttemptAt).getTime() : now)
        .reduce((earliest, candidate) => Math.min(earliest, candidate), Number.POSITIVE_INFINITY);
      return Math.max(0, nextAt - now);
    });
  }

  /** Exposed for diagnostics and tests; returned data is a defensive clone. */
  public async snapshot(): Promise<CommandQueueSnapshot> {
    return this.withLock(async () => clone(await this.load()));
  }

  private async load(): Promise<CommandQueueSnapshot> {
    if (this.state) return this.state;
    let raw: string | undefined;
    try {
      raw = await readFile(this.target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (raw === undefined) {
      this.state = clone(EMPTY_QUEUE);
    } else {
      try {
        this.state = CommandQueueSnapshotSchema.parse(JSON.parse(raw));
      } catch {
        // A corrupt durable file must not brick every future command. The
        // unreadable bytes are quarantined for the owner to inspect and the
        // queue continues empty; genuine I/O errors above still surface so a
        // detached volume is not silently treated as an empty queue.
        await this.quarantineCorruptFile();
        this.state = clone(EMPTY_QUEUE);
      }
    }

    const changed = recoverInterruptedJobs(this.state, this.now());
    if (changed) await this.persist(this.state);
    return this.state;
  }

  /** Best effort by design: quarantine failing must never block recovery. */
  private async quarantineCorruptFile(): Promise<void> {
    try {
      await rename(this.target, `${this.target}.corrupt-${this.now().getTime()}`);
    } catch {
      // The next persist() overwrites the corrupt bytes atomically anyway.
    }
  }

  private async persist(state: CommandQueueSnapshot): Promise<void> {
    await mkdir(path.dirname(this.target), { recursive: true, mode: 0o700 });
    const temporary = `${this.target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.target);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    // Preserve the serial chain after a rejected filesystem operation so a
    // later diagnostic call can still report the durable state.
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }
}

function pendingJobs(state: CommandQueueSnapshot): QueueJob[] {
  return state.jobs.filter(job => job.status !== "failed");
}

function isReady(job: QueueJob, now: Date): boolean {
  if (job.status === "queued") return true;
  if (job.status !== "retrying" || !job.nextAttemptAt) return false;
  return new Date(job.nextAttemptAt).getTime() <= now.getTime();
}

function retryDelayMs(base: number, attempts: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, base * (2 ** Math.max(0, attempts - 1)));
}

function recoverInterruptedJobs(state: CommandQueueSnapshot, now: Date): boolean {
  let changed = false;
  const at = now.toISOString();
  for (const job of state.jobs) {
    if (job.status !== "running") continue;
    changed = true;
    job.updatedAt = at;
    job.lastError = "Bridge restarted while this command was running.";
    if (job.attempts >= job.maxAttempts) {
      job.status = "failed";
      job.nextAttemptAt = null;
    } else {
      job.status = "retrying";
      job.nextAttemptAt = at;
    }
  }
  if (changed) {
    pruneFailedHistory(state);
    state.updatedAt = at;
  }
  return changed;
}

function pruneFailedHistory(state: CommandQueueSnapshot): void {
  const terminal = state.jobs
    .filter(job => job.status === "failed")
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  const excess = terminal.length - MAX_FAILED_HISTORY;
  if (excess <= 0) return;
  const remove = new Set(terminal.slice(0, excess).map(job => job.id));
  state.jobs = state.jobs.filter(job => !remove.has(job.id));
}

function redactError(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, 1_500);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
