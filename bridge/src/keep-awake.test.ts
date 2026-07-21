import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { KeepAwakeController, keepAwakeCommandFor, type KeepAwakeChild } from "./keep-awake.js";

class FakeChild extends EventEmitter implements KeepAwakeChild {
  public kill(): boolean {
    this.emit("exit", 0, null);
    return true;
  }
}

test("sleep inhibition plans use fixed platform commands without shell interpolation", () => {
  const mac = keepAwakeCommandFor("darwin", 4242);
  assert.equal(mac?.command, "caffeinate");
  assert.deepEqual(mac?.args, ["-i", "-m", "-w", "4242"]);
  const windows = keepAwakeCommandFor("win32", 4242);
  assert.equal(windows?.command, "powershell.exe");
  assert.equal(windows?.args.includes("-NoProfile"), true);
  assert.match(windows?.args.at(-1) ?? "", /SetThreadExecutionState/);
  assert.match(windows?.args.at(-1) ?? "", /Get-Process -Id \$parentPid/);
  const linux = keepAwakeCommandFor("linux", 4242, "/fixed/node");
  assert.equal(linux?.args.at(-4), "/fixed/node");
  assert.equal(linux?.args.at(-3), "-e");
  assert.match(linux?.args.at(-2) ?? "", /process\.kill/);
  assert.equal(linux?.args.at(-1), "4242");
  assert.equal(keepAwakeCommandFor("freebsd"), undefined);
});

test("disabled sleep inhibition never starts a helper", async () => {
  let starts = 0;
  const controller = new KeepAwakeController({
    enabled: false,
    platform: "darwin",
    spawn: () => {
      starts += 1;
      return new FakeChild();
    },
  });
  const status = await controller.start();
  assert.equal(status.strategy, "disabled");
  assert.equal(starts, 0);
  await controller.stop();
});

test("an unexpected helper exit is retried and a deliberate stop cancels retries", async () => {
  const children: FakeChild[] = [];
  const controller = new KeepAwakeController({
    enabled: true,
    platform: "darwin",
    restartBaseMs: 100,
    restartMaxMs: 100,
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });
  await controller.start();
  assert.equal(children.length, 1);
  children[0]?.emit("exit", 1, null);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(children.length, 2);
  await controller.stop();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(controller.status().active, false);
  assert.equal(children.length, 2);
});

test("a missing platform helper degrades once instead of retrying forever", async () => {
  const child = new FakeChild();
  const controller = new KeepAwakeController({
    enabled: true,
    platform: "darwin",
    spawn: () => child,
  });
  await controller.start();
  child.emit("error", Object.assign(new Error("caffeinate missing"), { code: "ENOENT" }));
  assert.equal(controller.status().active, false);
  assert.equal(controller.status().strategy, "unavailable");
  assert.match(controller.status().message, /continue without sleep inhibition/);
  await controller.stop();
});

test("repeated helper crashes use growing bounded backoff instead of a hot loop", async () => {
  const children: FakeChild[] = [];
  const controller = new KeepAwakeController({
    enabled: true,
    platform: "darwin",
    restartBaseMs: 100,
    restartMaxMs: 400,
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });
  await controller.start();
  children[0]?.emit("exit", 1, null);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(children.length, 2);
  children[1]?.emit("exit", 1, null);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(children.length, 2);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(children.length, 3);
  await controller.stop();
});
