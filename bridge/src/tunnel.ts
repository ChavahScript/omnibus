import localtunnel, { type Tunnel } from "localtunnel";
import { isIP } from "node:net";
import type { AppConfig } from "./config.js";
import { BYPASS_TUNNEL_HEADER } from "./security.js";

/**
 * These deliberately conservative values are fixed in the published bridge,
 * rather than being phone-controlled settings. A flaky public tunnel should
 * recover on its own, but it must never retry in a hot loop or keep quietly
 * creating public endpoints forever when a network is genuinely unavailable.
 */
export const TUNNEL_RECOVERY = {
  /** Give localtunnel's own socket-reconnect logic a chance before replacing it. */
  errorProbeDelayMs: 5_000,
  /** Detect a silently dead relay even if localtunnel did not emit `error`. */
  healthCheckIntervalMs: 30_000,
  healthCheckTimeoutMs: 6_000,
  /** Never let a hung relay-creation promise strand the local coordinator. */
  connectionTimeoutMs: 20_000,
  /** One transient probe miss is not enough to rotate a pairing endpoint. */
  healthCheckFailureThreshold: 3,
  /** Backoff applies to replacement endpoint creation after a confirmed outage. */
  retryBaseMs: 1_000,
  retryMaxMs: 30_000,
  retryLimit: 8,
  /** Keep trying after a failed burst without keeping a network hot loop alive. */
  cooldownRetryMs: 5 * 60_000,
  /** Symmetric jitter avoids synchronized retry storms after router recovery. */
  jitterFraction: 0.2,
} as const;

export type TunnelOnlineStatus = {
  kind: "online";
  url: string;
  /** Increments only when a brand-new public endpoint is created. */
  generation: number;
  /**
   * True only when a recovered relay has a different public origin. A new
   * relay at the same stable origin can retain its already-paired sessions;
   * requiring a fresh QR for that case would break recovery after a normal
   * Wi-Fi/relay interruption.
   */
  requiresFreshPairing: boolean;
};

export type TunnelConnectingStatus = {
  kind: "connecting";
  attempt: number;
  reason: "startup" | "recovery";
};

export type TunnelRecoveringStatus = {
  kind: "recovering";
  /** `0` means the existing relay is being probed before replacement. */
  attempt: number;
  retryInMs: number;
  reason: string;
  lastUrl: string;
  /**
   * The future replacement URL is not known yet, so this remains false until
   * activation proves that the public origin actually changed.
   */
  requiresFreshPairing: boolean;
};

export type TunnelFailedStatus = {
  kind: "failed";
  attempts: number;
  reason: string;
  lastUrl?: string;
  /** The supervisor stays alive and starts another bounded burst after this cooldown. */
  nextRetryInMs?: number;
  /** A future retry decides this only after it knows its public origin. */
  requiresFreshPairing: boolean;
};

export type TunnelClosedStatus = { kind: "closed" };

export type TunnelStatus =
  | TunnelOnlineStatus
  | TunnelConnectingStatus
  | TunnelRecoveringStatus
  | TunnelFailedStatus
  | TunnelClosedStatus;

export type TunnelHandle = {
  /** The currently active HTTPS relay URL. It changes only after replacement. */
  readonly url: string;
  readonly status: TunnelStatus;
  /**
   * Receives the current state immediately and later lifecycle transitions.
   * Listener failures are contained so terminal reporting can never crash the
   * bridge or suppress recovery.
   */
  subscribe: (listener: (status: TunnelStatus) => void) => () => void;
  /** Idempotent: clears probes/retries, detaches listeners, and closes the relay. */
  close: () => Promise<void>;
};

type TunnelClient = Pick<Tunnel, "url" | "close" | "on" | "off">;

type Timer = ReturnType<typeof setTimeout>;

type TunnelRuntime = {
  createTunnel: (config: AppConfig) => Promise<TunnelClient>;
  probe: (url: string) => Promise<boolean>;
  setTimer: (callback: () => void, delayMs: number) => Timer;
  clearTimer: (timer: Timer) => void;
  random: () => number;
};

/**
 * Optional runtime seams keep recovery logic deterministic under node:test.
 * They are intentionally not configuration: callers cannot redirect the
 * public tunnel or weaken retry limits through the phone-facing protocol.
 */
export type TunnelRuntimeOverrides = Partial<TunnelRuntime>;

/**
 * Opens and supervises the public, phone-only relay.
 *
 * Localtunnel already reconnects individual relay sockets internally. The
 * supervisor supplements that behavior for the failure modes localtunnel
 * cannot report reliably: a relay that emits an error and stays unusable, a
 * silent dropped relay, and a future provider implementation that emits an
 * unexpected `close`. It never touches the private Home Fleet LAN services.
 */
export async function openTunnel(config: AppConfig, overrides: TunnelRuntimeOverrides = {}): Promise<TunnelHandle> {
  const supervisor = new TunnelSupervisor(config, createRuntime(overrides));
  // The local coordinator must remain alive through an internet outage. Do
  // not make `start` wait for a relay that may be unavailable for minutes;
  // observers receive `connecting`/`failed` status and an `online` event when
  // a safe HTTPS endpoint eventually returns.
  supervisor.start();
  return supervisor;
}

class TunnelSupervisor implements TunnelHandle {
  private active: TunnelClient | undefined;
  private activeListeners: { error: (error: Error) => void; close: () => void } | undefined;
  private retryTimer: Timer | undefined;
  private probeTimer: Timer | undefined;
  private closed = false;
  private probing = false;
  private replacementInProgress = false;
  private consecutiveProbeFailures = 0;
  private recoveryAttempt = 0;
  private endpointGeneration = 0;
  private currentUrl = "";
  private currentStatus: TunnelStatus = { kind: "connecting", attempt: 0, reason: "startup" };
  private readonly listeners = new Set<(status: TunnelStatus) => void>();

  public constructor(private readonly config: AppConfig, private readonly runtime: TunnelRuntime) {}

  public get url(): string {
    return this.currentUrl;
  }

  public get status(): TunnelStatus {
    return this.currentStatus;
  }

  public subscribe(listener: (status: TunnelStatus) => void): () => void {
    this.listeners.add(listener);
    this.notifyOne(listener, this.currentStatus);
    return () => this.listeners.delete(listener);
  }

  public start(): void {
    void this.connectInitial();
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    const tunnel = this.detachActive();
    this.setStatus({ kind: "closed" });
    try {
      tunnel?.close();
    } catch {
      // localtunnel.close() is synchronous and best-effort. Shutdown must
      // continue so the loopback HTTP server and keep-awake lease can close.
    }
  }

  private async connectInitial(): Promise<void> {
    let attempt = 0;
    let reason = "initial connection failed";
    while (!this.closed) {
      this.setStatus({ kind: "connecting", attempt, reason: "startup" });
      try {
        const tunnel = await this.createTunnelWithDeadline();
        if (this.closed) {
          safelyClose(tunnel);
          return;
        }
        if (this.activate(tunnel, false)) return;
        // An invalid URL is a provider failure, not a reason to print an
        // unusable QR code. Retry it through the same bounded startup path.
        throw new TunnelLifecycleError("The tunnel returned an invalid public URL.");
      } catch (error) {
        reason = errorMessage(error, reason);
        attempt += 1;
        if (attempt >= TUNNEL_RECOVERY.retryLimit) {
          this.setStatus({
            kind: "failed",
            attempts: attempt,
            reason,
            nextRetryInMs: TUNNEL_RECOVERY.cooldownRetryMs,
            requiresFreshPairing: false,
          });
          // Startup failures are not fatal to the coordinator. Keep the
          // loopback bridge, Home Fleet, local queue, and sleep-inhibition
          // lease running while the public relay takes a battery-conscious
          // five-minute pause before another bounded connection burst.
          this.retryTimer = this.runtime.setTimer(() => {
            this.retryTimer = undefined;
            if (!this.closed) void this.connectInitial();
          }, TUNNEL_RECOVERY.cooldownRetryMs);
          return;
        }
        const delay = retryDelay(attempt, this.runtime.random);
        this.setStatus({
          kind: "recovering",
          attempt,
          retryInMs: delay,
          reason,
          lastUrl: this.currentUrl,
          requiresFreshPairing: false,
        });
        await this.wait(delay);
      }
    }
  }

  private activate(tunnel: TunnelClient, isRelayReplacement: boolean): boolean {
    let url: string;
    try {
      url = normalizeTunnelUrl(tunnel.url);
    } catch (error) {
      safelyClose(tunnel);
      return false;
    }
    // `currentUrl` intentionally survives detachActive() while recovery is
    // running. It is the stable identity against which a new localtunnel
    // connection is compared. The QR/resume boundary follows the *public
    // origin*, not an opaque localtunnel socket instance.
    const publicOriginChanged = isRelayReplacement && Boolean(this.currentUrl) && url !== this.currentUrl;
    this.active = tunnel;
    this.currentUrl = url;
    this.replacementInProgress = false;
    this.recoveryAttempt = 0;
    this.consecutiveProbeFailures = 0;
    this.endpointGeneration += 1;
    const error = (cause: Error) => this.onRelayError(tunnel, cause);
    const close = () => this.onRelayClose(tunnel);
    this.activeListeners = { error, close };
    tunnel.on("error", error);
    tunnel.on("close", close);
    this.setStatus({ kind: "online", url, generation: this.endpointGeneration, requiresFreshPairing: publicOriginChanged });
    this.schedulePeriodicProbe();
    return true;
  }

  private onRelayError(tunnel: TunnelClient, error: Error): void {
    if (this.closed || tunnel !== this.active || this.replacementInProgress) return;
    // localtunnel has its own socket re-open loop. Probe before tearing down a
    // potentially healthy endpoint; a transient error should not kick a phone
    // off an otherwise recoverable WSS session or invalidate its QR pairing.
    this.clearProbeTimer();
    const reason = errorMessage(error, "The public tunnel reported a network error.");
    this.setStatus({
      kind: "recovering",
      attempt: 0,
      retryInMs: TUNNEL_RECOVERY.errorProbeDelayMs,
      reason,
      lastUrl: this.currentUrl,
      requiresFreshPairing: false,
    });
    this.probeTimer = this.runtime.setTimer(() => {
      this.probeTimer = undefined;
      void this.probeAfterRelayError(tunnel, reason);
    }, TUNNEL_RECOVERY.errorProbeDelayMs);
  }

  private onRelayClose(tunnel: TunnelClient): void {
    if (this.closed || tunnel !== this.active) return;
    // A provider-side close is terminal for this concrete relay. Do not wait
    // for probes that can no longer succeed; retire it and start bounded
    // replacement attempts immediately.
    this.beginReplacement("The public tunnel closed unexpectedly.");
  }

  private async probeAfterRelayError(tunnel: TunnelClient, reason: string): Promise<void> {
    if (this.closed || tunnel !== this.active || this.replacementInProgress) return;
    const healthy = await this.probeCurrentUrl();
    if (this.closed || tunnel !== this.active || this.replacementInProgress) return;
    if (healthy) {
      this.consecutiveProbeFailures = 0;
      this.setStatus({ kind: "online", url: this.currentUrl, generation: this.endpointGeneration, requiresFreshPairing: false });
      this.schedulePeriodicProbe();
      return;
    }
    this.beginReplacement(reason);
  }

  private schedulePeriodicProbe(): void {
    if (this.closed || !this.active || this.replacementInProgress) return;
    this.clearProbeTimer();
    this.probeTimer = this.runtime.setTimer(() => {
      this.probeTimer = undefined;
      void this.runPeriodicProbe();
    }, TUNNEL_RECOVERY.healthCheckIntervalMs);
  }

  private async runPeriodicProbe(): Promise<void> {
    if (this.closed || !this.active || this.replacementInProgress) return;
    const healthy = await this.probeCurrentUrl();
    if (this.closed || !this.active || this.replacementInProgress) return;
    const awaitingErrorProbe = this.currentStatus.kind === "recovering"
      && this.currentStatus.attempt === 0
      && !this.currentStatus.requiresFreshPairing;
    // An in-flight periodic probe can finish after an `error` event. In that
    // case do not let it accidentally cancel the deliberately delayed error
    // probe. A healthy result is enough to restore the endpoint; an unhealthy
    // result leaves the error-specific probe in charge of replacement.
    if (awaitingErrorProbe) {
      if (healthy) {
        this.consecutiveProbeFailures = 0;
        this.setStatus({ kind: "online", url: this.currentUrl, generation: this.endpointGeneration, requiresFreshPairing: false });
        this.schedulePeriodicProbe();
      }
      return;
    }
    if (healthy) {
      this.consecutiveProbeFailures = 0;
      this.schedulePeriodicProbe();
      return;
    }
    this.consecutiveProbeFailures += 1;
    if (this.consecutiveProbeFailures < TUNNEL_RECOVERY.healthCheckFailureThreshold) {
      // A hotel/router DNS hiccup must not invalidate a pairing. Keep the
      // existing relay alive until independently observed failures are enough
      // to establish that it really is no longer reachable.
      this.schedulePeriodicProbe();
      return;
    }
    this.beginReplacement("The public tunnel stopped answering health checks.");
  }

  private async probeCurrentUrl(): Promise<boolean> {
    if (this.probing || !this.currentUrl) return false;
    this.probing = true;
    try {
      return await this.runtime.probe(this.currentUrl);
    } catch {
      return false;
    } finally {
      this.probing = false;
    }
  }

  private beginReplacement(reason: string): void {
    if (this.closed || this.replacementInProgress) return;
    this.replacementInProgress = true;
    this.clearProbeTimer();
    const retired = this.detachActive();
    safelyClose(retired);
    this.scheduleReplacement(reason);
  }

  private scheduleReplacement(reason: string): void {
    if (this.closed) return;
    const nextAttempt = this.recoveryAttempt + 1;
    if (nextAttempt > TUNNEL_RECOVERY.retryLimit) {
      this.replacementInProgress = false;
      this.setStatus({
        kind: "failed",
        attempts: this.recoveryAttempt,
        reason,
        ...(this.currentUrl ? { lastUrl: this.currentUrl } : {}),
        nextRetryInMs: TUNNEL_RECOVERY.cooldownRetryMs,
        requiresFreshPairing: false,
      });
      // A terminal state must be visible to the paired owner, but a bridge
      // that has already been started should not need a person at the laptop
      // just because a router or relay had a long outage. Cool down for five
      // minutes, then begin a new bounded burst. No QR/token is regenerated
      // until a replacement relay actually becomes healthy.
      this.retryTimer = this.runtime.setTimer(() => {
        this.retryTimer = undefined;
        if (this.closed) return;
        this.recoveryAttempt = 0;
        this.replacementInProgress = true;
        this.scheduleReplacement("The public tunnel is retrying after a cooldown.");
      }, TUNNEL_RECOVERY.cooldownRetryMs);
      return;
    }
    this.recoveryAttempt = nextAttempt;
    const delay = retryDelay(this.recoveryAttempt, this.runtime.random);
    this.setStatus({
      kind: "recovering",
      attempt: this.recoveryAttempt,
      retryInMs: delay,
      reason,
      lastUrl: this.currentUrl,
      requiresFreshPairing: false,
    });
    this.retryTimer = this.runtime.setTimer(() => {
      this.retryTimer = undefined;
      void this.connectReplacement(reason);
    }, delay);
  }

  private async connectReplacement(reason: string): Promise<void> {
    if (this.closed) return;
    this.setStatus({ kind: "connecting", attempt: this.recoveryAttempt, reason: "recovery" });
    try {
      const tunnel = await this.createTunnelWithDeadline();
      if (this.closed) {
        safelyClose(tunnel);
        return;
      }
      if (!this.activate(tunnel, true)) this.scheduleReplacement("The tunnel returned an invalid public URL.");
    } catch (error) {
      this.scheduleReplacement(errorMessage(error, reason));
    }
  }

  private detachActive(): TunnelClient | undefined {
    const tunnel = this.active;
    const listeners = this.activeListeners;
    this.active = undefined;
    this.activeListeners = undefined;
    if (tunnel && listeners) {
      tunnel.off("error", listeners.error);
      tunnel.off("close", listeners.close);
    }
    return tunnel;
  }

  /**
   * localtunnel has no cancellation input. A deadline therefore races the
   * connection attempt *and* closes any late tunnel that finally resolves, so
   * a wedged DNS/socket promise cannot strand this process or leak a second
   * public endpoint after recovery has already moved on.
   */
  private async createTunnelWithDeadline(): Promise<TunnelClient> {
    let timedOut = false;
    let timeout: Timer | undefined;
    const pending = this.runtime.createTunnel(this.config).then(tunnel => {
      if (timedOut || this.closed) {
        safelyClose(tunnel);
        throw new TunnelLifecycleError("The tunnel connection completed after its recovery window closed.");
      }
      return tunnel;
    });
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = this.runtime.setTimer(() => {
        timedOut = true;
        reject(new TunnelLifecycleError("The tunnel connection timed out."));
      }, TUNNEL_RECOVERY.connectionTimeoutMs);
    });
    try {
      return await Promise.race([pending, deadline]);
    } finally {
      if (timeout) this.runtime.clearTimer(timeout);
    }
  }

  private clearProbeTimer(): void {
    if (!this.probeTimer) return;
    this.runtime.clearTimer(this.probeTimer);
    this.probeTimer = undefined;
  }

  private clearTimers(): void {
    this.clearProbeTimer();
    if (this.retryTimer) {
      this.runtime.clearTimer(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private wait(delay: number): Promise<void> {
    return new Promise(resolve => {
      this.retryTimer = this.runtime.setTimer(() => {
        this.retryTimer = undefined;
        resolve();
      }, delay);
    });
  }

  private setStatus(status: TunnelStatus): void {
    this.currentStatus = status;
    for (const listener of this.listeners) this.notifyOne(listener, status);
  }

  private notifyOne(listener: (status: TunnelStatus) => void, status: TunnelStatus): void {
    try {
      listener(status);
    } catch {
      // A console/UI observer is never part of the tunnel's availability path.
    }
  }
}

export class TunnelLifecycleError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TunnelLifecycleError";
  }
}

function createRuntime(overrides: TunnelRuntimeOverrides): TunnelRuntime {
  return {
    createTunnel: overrides.createTunnel ?? (async config => localtunnel({ port: config.port, subdomain: config.tunnelSubdomain })),
    probe: overrides.probe ?? probeTunnel,
    setTimer: overrides.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
    clearTimer: overrides.clearTimer ?? (timer => clearTimeout(timer)),
    random: overrides.random ?? Math.random,
  };
}

/** A bounded, authenticated-looking GET; it never transmits a pairing token. */
async function probeTunnel(url: string): Promise<boolean> {
  const response = await fetch(new URL("/health", url), {
    method: "GET",
    headers: { [BYPASS_TUNNEL_HEADER]: "true" },
    redirect: "error",
    signal: AbortSignal.timeout(TUNNEL_RECOVERY.healthCheckTimeoutMs),
  });
  if (!response.ok) return false;
  const body = await response.json().catch(() => undefined) as { ok?: unknown; service?: unknown } | undefined;
  return body?.ok === true && body.service === "omnibus-bridge";
}

/**
 * A public pairing URL cannot carry credentials, fragments, or a non-HTTPS
 * scheme. `localtunnel` reports HTTP in some versions; the public endpoint is
 * upgraded before it ever reaches the QR code or mobile client.
 */
function normalizeTunnelUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new TunnelLifecycleError("The tunnel returned a non-HTTP public URL.");
  if (parsed.username || parsed.password || parsed.hash || parsed.search) throw new TunnelLifecycleError("The tunnel returned an unsafe public URL.");
  // A pairing QR must never turn a package/provider fault into a request for
  // the phone to reach localhost or a literal LAN address. localtunnel URLs
  // are named public origins; an IP literal is not a valid substitute here.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (hostname.toLowerCase() === "localhost" || isIP(hostname) !== 0) {
    throw new TunnelLifecycleError("The tunnel returned a non-public pairing URL.");
  }
  parsed.protocol = "https:";
  return parsed.toString().replace(/\/$/, "");
}

function retryDelay(attempt: number, random: () => number): number {
  const exponential = Math.min(TUNNEL_RECOVERY.retryMaxMs, TUNNEL_RECOVERY.retryBaseMs * (2 ** Math.max(0, attempt - 1)));
  // Clamp injected/test random values too; a recovery delay must always stay
  // bounded even when callers provide an imperfect deterministic runtime.
  const unit = Math.min(1, Math.max(0, random()));
  const multiplier = 1 - TUNNEL_RECOVERY.jitterFraction + unit * TUNNEL_RECOVERY.jitterFraction * 2;
  return Math.max(1, Math.min(TUNNEL_RECOVERY.retryMaxMs, Math.round(exponential * multiplier)));
}

function safelyClose(tunnel: TunnelClient | undefined): void {
  try {
    // Node treats an EventEmitter `error` without listeners as fatal. A
    // retired localtunnel client can still flush a late socket error while its
    // synchronous close propagates, so retain a tiny drain listener on the
    // discarded object. It is collectible with the client and cannot alter
    // supervisor state after its active listeners were detached.
    tunnel?.on("error", () => undefined);
    tunnel?.close();
  } catch {
    // Best-effort close; the retry supervisor remains responsible for state.
  }
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim().slice(0, 500);
  return fallback;
}
