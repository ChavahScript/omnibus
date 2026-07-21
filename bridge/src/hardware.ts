import { statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** One gibibyte is used for all fleet estimates so UI labels stay consistent. */
export const GIBIBYTE = 1024 ** 3;

export type DiskCapacity = {
  /** Absolute path that was inspected; it is never sent to a remote service. */
  path: string;
  available: boolean;
  totalBytes?: number;
  freeBytes?: number;
  /** Deliberately generic so filesystem paths and host details do not leak. */
  error?: "unavailable";
};

export type HardwareSnapshot = {
  /** ISO timestamp lets a client distinguish a fresh probe from cached data. */
  collectedAt: string;
  platform: NodeJS.Platform;
  architecture: string;
  cpu: {
    logicalCores: number;
    /** `availableParallelism` respects any OS/container CPU allocation. */
    availableParallelism: number;
    /** A bounded descriptive label only; never a hardware serial or identifier. */
    model: string;
  };
  memory: {
    totalBytes: number;
    /** This is OS-reported immediately free memory, not a claim about reclaimable cache. */
    freeBytes: number;
  };
  disk: DiskCapacity;
  /**
   * Node's standard library intentionally does not expose portable VRAM/GPU
   * telemetry. Fleet selection therefore stays safe and deterministic using
   * CPU, system memory, and disk only rather than guessing at an accelerator.
   */
  accelerator: "not-probed";
};

/** A wire-safe disk view: filesystem capacity is useful, the local path is not. */
export type LaptopDiskCapacity = Omit<DiskCapacity, "path">;

/**
 * Stable product-facing capability snapshot. `HardwareSnapshot` remains an
 * internal probe result because it includes an absolute disk path; this type
 * is safe to send to the QR-paired phone and deliberately omits that path.
 */
export type LaptopCapabilities = Omit<HardwareSnapshot, "disk"> & {
  disk: LaptopDiskCapacity;
};

type StatfsValues = {
  bsize: number | bigint;
  blocks: number | bigint;
  bavail: number | bigint;
};

type StatfsReader = (targetPath: string) => Promise<StatfsValues>;

export type HardwareProbeOptions = {
  /** Defaults to the current workspace, where Ollama model data is normally managed. */
  diskPath?: string;
  /** Test-only boundary; production uses Node's built-in `fs.statfs`. */
  statfsReader?: StatfsReader;
  /** Test-only clock boundary; no hardware data is fetched from a network. */
  now?: () => Date;
};

/**
 * Collects a small, local-only hardware snapshot. This never spawns a process,
 * downloads software, or attempts GPU probing. `statfs` is used instead of a
 * shell command so packaging the bridge cannot accidentally create a command
 * injection surface during initial setup.
 */
export async function probeHardware(options: HardwareProbeOptions = {}): Promise<HardwareSnapshot> {
  const diskPath = path.resolve(options.diskPath ?? process.cwd());
  const [disk, cpu] = await Promise.all([
    probeDiskCapacity(diskPath, options.statfsReader ?? defaultStatfsReader),
    Promise.resolve(os.cpus()),
  ]);
  const logicalCores = Math.max(1, cpu.length);
  const availableParallelism = safeAvailableParallelism(logicalCores);
  const totalBytes = nonNegativeSafeInteger(os.totalmem());
  const freeBytes = Math.min(totalBytes, nonNegativeSafeInteger(os.freemem()));

  return {
    collectedAt: (options.now ?? (() => new Date()))().toISOString(),
    platform: os.platform(),
    architecture: os.arch(),
    cpu: {
      logicalCores,
      availableParallelism,
      model: boundedCpuModel(cpu[0]?.model),
    },
    memory: { totalBytes, freeBytes },
    disk,
    accelerator: "not-probed",
  };
}

/**
 * Product-facing capability probe used during QR-paired setup. The workspace
 * path is inspected only for the filesystem capacity where local bridge state
 * and model setup are being prepared; it is never enumerated or uploaded.
 */
export async function probeLaptopCapabilities(workspacePath: string): Promise<LaptopCapabilities> {
  return toLaptopCapabilities(await probeHardware({ diskPath: workspacePath }));
}

/** Converts an internal probe result to the path-free mobile protocol shape. */
export function toLaptopCapabilities(snapshot: HardwareSnapshot): LaptopCapabilities {
  const { path: _diskPath, ...disk } = snapshot.disk;
  return { ...snapshot, disk };
}

/**
 * Reads capacity for one already-resolved local path. A failed filesystem
 * probe is degradable: callers can still offer a low-risk preset, but must
 * ask the owner to confirm disk space before a model pull.
 */
export async function probeDiskCapacity(
  targetPath: string,
  reader: StatfsReader = defaultStatfsReader,
): Promise<DiskCapacity> {
  const resolvedPath = path.resolve(targetPath);
  let candidatePath = resolvedPath;
  try {
    while (true) {
      try {
        const result = await reader(candidatePath);
        const totalBytes = bytesFromFilesystemBlocks(result.blocks, result.bsize);
        const freeBytes = bytesFromFilesystemBlocks(result.bavail, result.bsize);
        if (totalBytes === undefined || freeBytes === undefined || freeBytes > totalBytes) {
          return { path: candidatePath, available: false, error: "unavailable" };
        }
        return { path: candidatePath, available: true, totalBytes, freeBytes };
      } catch (error) {
        // An explicit `OLLAMA_MODELS` directory may not exist until the first
        // pull. Its nearest existing parent is still on the same volume and
        // gives the owner a useful pre-download capacity estimate. Other
        // filesystem errors intentionally remain a generic unavailable state.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parentPath = path.dirname(candidatePath);
        if (parentPath === candidatePath) throw error;
        candidatePath = parentPath;
      }
    }
  } catch {
    // Do not expose raw filesystem errors: mounting details and user paths are
    // operationally useful to an attacker but not actionable in the phone UI.
    return { path: resolvedPath, available: false, error: "unavailable" };
  }
}

/** Converts filesystem block counts with overflow protection. */
export function bytesFromFilesystemBlocks(
  blocks: number | bigint,
  blockSize: number | bigint,
): number | undefined {
  const normalizedBlocks = toNonNegativeBigInt(blocks);
  const normalizedBlockSize = toNonNegativeBigInt(blockSize);
  if (normalizedBlocks === undefined || normalizedBlockSize === undefined) return undefined;
  const bytes = normalizedBlocks * normalizedBlockSize;
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(bytes);
}

/** A display helper that deliberately rounds only at the presentation boundary. */
export function bytesToGiB(bytes: number): number {
  return Math.round((nonNegativeSafeInteger(bytes) / GIBIBYTE) * 10) / 10;
}

const defaultStatfsReader: StatfsReader = async targetPath => statfs(targetPath);

function safeAvailableParallelism(fallback: number): number {
  try {
    return Math.max(1, os.availableParallelism());
  } catch {
    return fallback;
  }
}

function boundedCpuModel(value: string | undefined): string {
  const normalized = (value ?? "Unknown CPU").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized.slice(0, 160) || "Unknown CPU";
}

function nonNegativeSafeInteger(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

function toNonNegativeBigInt(value: number | bigint): bigint | undefined {
  if (typeof value === "bigint") return value >= 0n ? value : undefined;
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) return undefined;
  return BigInt(value);
}
