import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  GIBIBYTE,
  bytesFromFilesystemBlocks,
  bytesToGiB,
  probeDiskCapacity,
  probeHardware,
  probeLaptopCapabilities,
  toLaptopCapabilities,
} from "./hardware.js";

test("filesystem block arithmetic is exact for safe numbers and refuses invalid/overflow values", () => {
  assert.equal(bytesFromFilesystemBlocks(4, 1_024), 4_096);
  assert.equal(bytesFromFilesystemBlocks(4n, 1_024n), 4_096);
  assert.equal(bytesFromFilesystemBlocks(-1, 1_024), undefined);
  assert.equal(bytesFromFilesystemBlocks(Number.MAX_SAFE_INTEGER, 2), undefined);
  assert.equal(bytesToGiB(1.25 * GIBIBYTE), 1.3);
});

test("disk probe uses a local statfs boundary and degrades without raw filesystem errors", async () => {
  const snapshot = await probeDiskCapacity(".", async () => ({ bsize: 4_096, blocks: 100, bavail: 25 }));
  assert.deepEqual(snapshot, {
    path: path.resolve("."),
    available: true,
    totalBytes: 409_600,
    freeBytes: 102_400,
  });

  const unavailable = await probeDiskCapacity(".", async () => {
    throw new Error("/private/secret-mounted-volume is unavailable");
  });
  assert.deepEqual(unavailable, { path: path.resolve("."), available: false, error: "unavailable" });
});

test("a not-yet-created local model directory uses its existing parent volume for capacity planning", async () => {
  const modelDirectory = "/tmp/omnibus-test-models/not-created-yet";
  const observed: string[] = [];
  const capacity = await probeDiskCapacity(modelDirectory, async target => {
    observed.push(target);
    if (target === path.resolve(modelDirectory)) {
      const error = new Error("not found") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return { bsize: 1_024, blocks: 100, bavail: 40 };
  });
  assert.equal(capacity.available, true);
  assert.equal(capacity.path, path.dirname(path.resolve(modelDirectory)));
  assert.deepEqual(observed, [path.resolve(modelDirectory), path.dirname(path.resolve(modelDirectory))]);
});

test("hardware probe stays local and returns the capacity fields needed for fleet selection", async () => {
  const snapshot = await probeHardware({
    diskPath: ".",
    now: () => new Date("2026-07-17T12:00:00.000Z"),
    statfsReader: async () => ({ bsize: 4_096n, blocks: 1_000n, bavail: 500n }),
  });
  assert.equal(snapshot.collectedAt, "2026-07-17T12:00:00.000Z");
  assert.ok(snapshot.cpu.logicalCores >= 1);
  assert.ok(snapshot.cpu.availableParallelism >= 1);
  assert.ok(snapshot.memory.totalBytes >= snapshot.memory.freeBytes);
  assert.equal(snapshot.disk.freeBytes, 2_048_000);
  assert.equal(snapshot.accelerator, "not-probed");
});

test("wire-facing laptop capabilities omit the local disk path", async () => {
  const internal = await probeHardware({
    diskPath: ".",
    statfsReader: async () => ({ bsize: 4_096, blocks: 1_000, bavail: 500 }),
  });
  const safe = toLaptopCapabilities(internal);
  assert.equal("path" in safe.disk, false);
  assert.equal(JSON.stringify(safe).includes(path.resolve(".")), false);

  const probed = await probeLaptopCapabilities(".");
  assert.equal("path" in probed.disk, false);
});
