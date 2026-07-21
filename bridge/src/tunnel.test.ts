import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadConfig } from "./config.js";
import { openTunnel, TUNNEL_RECOVERY, type TunnelRuntimeOverrides, type TunnelStatus } from "./tunnel.js";

class FakeTunnel extends EventEmitter {
  public closed = false;

  public constructor(public readonly url: string) {
    super();
  }

  public close(): void {
    this.closed = true;
    this.emit("close");
  }
}

class FakeClock {
  private nextId = 1;
  private readonly pending = new Map<number, { callback: () => void; delayMs: number }>();

  public setTimer = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const id = this.nextId++;
    this.pending.set(id, { callback, delayMs });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  public clearTimer = (timer: ReturnType<typeof setTimeout>): void => {
    this.pending.delete(timer as unknown as number);
  };

  public runNext(): number {
    const entry = this.pending.entries().next().value as [number, { callback: () => void; delayMs: number }] | undefined;
    assert.ok(entry, "expected a scheduled timer");
    const [id, timer] = entry;
    this.pending.delete(id);
    timer.callback();
    return timer.delayMs;
  }

  public get count(): number {
    return this.pending.size;
  }
}

function testConfig() {
  return loadConfig({ cwd: "/tmp/omnibus-tunnel-test", env: {} });
}

function runtime(
  clock: FakeClock,
  tunnelFactory: () => Promise<FakeTunnel>,
  probe: () => Promise<boolean>,
): TunnelRuntimeOverrides {
  return {
    createTunnel: tunnelFactory,
    probe,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5,
  };
}

async function flush(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

test("a transient localtunnel error preserves the endpoint when its health probe succeeds", async () => {
  const clock = new FakeClock();
  const first = new FakeTunnel("http://first.example.test");
  let opens = 0;
  const handle = await openTunnel(testConfig(), runtime(
    clock,
    async () => {
      opens += 1;
      return first;
    },
    async () => true,
  ));
  await flush();
  const states: TunnelStatus[] = [];
  handle.subscribe(status => states.push(status));

  first.emit("error", new Error("socket reset"));
  assert.equal(handle.status.kind, "recovering");
  assert.equal((handle.status as Extract<TunnelStatus, { kind: "recovering" }>).requiresFreshPairing, false);
  assert.equal(clock.runNext(), TUNNEL_RECOVERY.errorProbeDelayMs);
  await flush();

  assert.equal(opens, 1);
  assert.equal(handle.url, "https://first.example.test");
  assert.equal(handle.status.kind, "online");
  assert.equal((handle.status as Extract<TunnelStatus, { kind: "online" }>).generation, 1);
  assert.equal(states.at(-1)?.kind, "online");
  await handle.close();
});

test("an in-flight periodic probe cannot cancel the error-recovery probe", async () => {
  const clock = new FakeClock();
  const first = new FakeTunnel("http://first.example.test");
  let resolveFirstProbe: ((value: boolean) => void) | undefined;
  let probeCalls = 0;
  const handle = await openTunnel(testConfig(), runtime(
    clock,
    async () => first,
    async () => {
      probeCalls += 1;
      if (probeCalls > 1) return true;
      return new Promise<boolean>(resolve => { resolveFirstProbe = resolve; });
    },
  ));
  await flush();

  // Start and hold the routine health probe, then race it with a real relay
  // error. A false result from the old probe must leave the error probe armed.
  assert.equal(clock.runNext(), TUNNEL_RECOVERY.healthCheckIntervalMs);
  await flush();
  first.emit("error", new Error("socket reset"));
  resolveFirstProbe?.(false);
  await flush();

  assert.equal(handle.status.kind, "recovering");
  assert.equal(clock.count, 1);
  assert.equal(clock.runNext(), TUNNEL_RECOVERY.errorProbeDelayMs);
  await flush();
  assert.equal(handle.status.kind, "online");
  assert.equal(handle.url, "https://first.example.test");
  await handle.close();
});

test("an unexpected relay close requires a new pairing only when its public origin changes", async () => {
  const clock = new FakeClock();
  const first = new FakeTunnel("http://first.example.test");
  const second = new FakeTunnel("https://second.example.test");
  const plans = [first, second];
  const handle = await openTunnel(testConfig(), runtime(
    clock,
    async () => {
      const next = plans.shift();
      if (!next) throw new Error("unexpected extra open");
      return next;
    },
    async () => true,
  ));
  await flush();

  first.emit("close");
  const recovery = handle.status as Extract<TunnelStatus, { kind: "recovering" }>;
  assert.equal(recovery.kind, "recovering");
  // The replacement URL is still unknown at this point. Do not invalidate a
  // travelling phone before the supervisor can compare the real origin.
  assert.equal(recovery.requiresFreshPairing, false);
  assert.equal(recovery.retryInMs, TUNNEL_RECOVERY.retryBaseMs);
  assert.equal(clock.runNext(), TUNNEL_RECOVERY.retryBaseMs);
  await flush();

  assert.equal(first.closed, true);
  assert.equal(handle.url, "https://second.example.test");
  assert.equal(handle.status.kind, "online");
  const online = handle.status as Extract<TunnelStatus, { kind: "online" }>;
  assert.equal(online.generation, 2);
  assert.equal(online.requiresFreshPairing, true);
  await handle.close();
});

test("a stable localtunnel origin preserves the paired recovery generation after a relay reconnect", async () => {
  const clock = new FakeClock();
  const first = new FakeTunnel("https://stable.example.test");
  const replacement = new FakeTunnel("http://stable.example.test");
  const plans = [first, replacement];
  const handle = await openTunnel(testConfig(), runtime(
    clock,
    async () => {
      const next = plans.shift();
      if (!next) throw new Error("unexpected extra open");
      return next;
    },
    async () => true,
  ));
  await flush();

  first.emit("close");
  assert.equal(clock.runNext(), TUNNEL_RECOVERY.retryBaseMs);
  await flush();

  assert.equal(handle.url, "https://stable.example.test");
  const online = handle.status as Extract<TunnelStatus, { kind: "online" }>;
  assert.equal(online.generation, 2);
  assert.equal(online.requiresFreshPairing, false);
  await handle.close();
});

test("replacement retries are bounded and end in a visible failed state", async () => {
  const clock = new FakeClock();
  const first = new FakeTunnel("http://first.example.test");
  let opens = 0;
  const handle = await openTunnel(testConfig(), runtime(
    clock,
    async () => {
      opens += 1;
      if (opens === 1) return first;
      throw new Error("relay unavailable");
    },
    async () => false,
  ));
  await flush();

  first.emit("close");
  for (let attempt = 0; attempt < TUNNEL_RECOVERY.retryLimit; attempt += 1) {
    assert.ok(clock.count > 0, `expected retry timer ${attempt + 1}`);
    clock.runNext();
    await flush();
  }

  assert.equal(handle.status.kind, "failed");
  const failed = handle.status as Extract<TunnelStatus, { kind: "failed" }>;
  assert.equal(failed.attempts, TUNNEL_RECOVERY.retryLimit);
  assert.equal(failed.requiresFreshPairing, false);
  assert.equal(failed.nextRetryInMs, TUNNEL_RECOVERY.cooldownRetryMs);
  assert.equal(opens, 1 + TUNNEL_RECOVERY.retryLimit);
  assert.equal(clock.count, 1);
  assert.equal(clock.runNext(), TUNNEL_RECOVERY.cooldownRetryMs);
  assert.equal(handle.status.kind, "recovering");
  assert.equal(clock.count, 1);
  await handle.close();
});

test("close cancels a pending recovery and cannot reopen the public endpoint", async () => {
  const clock = new FakeClock();
  const first = new FakeTunnel("http://first.example.test");
  let opens = 0;
  const handle = await openTunnel(testConfig(), runtime(
    clock,
    async () => {
      opens += 1;
      return first;
    },
    async () => false,
  ));
  await flush();

  first.emit("close");
  assert.ok(clock.count > 0);
  await handle.close();
  assert.equal(handle.status.kind, "closed");
  assert.equal(clock.count, 0);
  await flush();
  assert.equal(opens, 1);
});

test("an unsafe initial URL is never returned as a QR endpoint", async () => {
  const clock = new FakeClock();
  const unsafe = new FakeTunnel("ftp://not-a-pairing-endpoint.example.test");
  const safe = new FakeTunnel("http://safe.example.test");
  const plans = [unsafe, safe];
  const opening = openTunnel(testConfig(), runtime(
    clock,
    async () => {
      const next = plans.shift();
      if (!next) throw new Error("no further tunnel available");
      return next;
    },
    async () => true,
  ));
  const handle = await opening;
  await flush();
  assert.equal(unsafe.closed, true);
  assert.equal(clock.runNext(), TUNNEL_RECOVERY.retryBaseMs);
  await flush();

  assert.equal(handle.url, "https://safe.example.test");
  assert.equal(handle.status.kind, "online");
  await handle.close();
});

test("a startup outage leaves the coordinator alive and retries after cooldown", async () => {
  const clock = new FakeClock();
  const recovered = new FakeTunnel("https://recovered.example.test");
  let opens = 0;
  const handle = await openTunnel(testConfig(), runtime(
    clock,
    async () => {
      opens += 1;
      if (opens <= TUNNEL_RECOVERY.retryLimit) throw new Error("offline at startup");
      return recovered;
    },
    async () => true,
  ));

  await flush();
  for (let retry = 1; retry < TUNNEL_RECOVERY.retryLimit; retry += 1) {
    assert.equal(clock.runNext() > 0, true);
    await flush();
  }

  assert.equal(handle.status.kind, "failed");
  assert.equal(handle.url, "");
  assert.equal(clock.runNext(), TUNNEL_RECOVERY.cooldownRetryMs);
  await flush();
  assert.equal(handle.status.kind, "online");
  assert.equal(handle.url, "https://recovered.example.test");
  await handle.close();
});

test("a hung relay creation times out and a late tunnel is closed instead of leaked", async () => {
  const clock = new FakeClock();
  let resolveLate: ((tunnel: FakeTunnel) => void) | undefined;
  const handle = await openTunnel(testConfig(), runtime(
    clock,
    async () => new Promise<FakeTunnel>(resolve => { resolveLate = resolve; }),
    async () => true,
  ));

  await flush();
  assert.equal(clock.runNext(), TUNNEL_RECOVERY.connectionTimeoutMs);
  await flush();
  assert.equal(handle.status.kind, "recovering");

  const late = new FakeTunnel("https://late.example.test");
  resolveLate?.(late);
  await flush();
  assert.equal(late.closed, true);
  await handle.close();
});
