import type { BridgeEvent, BridgeResumeProfile, CommandMode, FleetProfileId, PairingPayload } from "./types";

type RNWebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
  options?: { headers?: Record<string, string> },
) => WebSocket;

const MAX_RESUME_ATTEMPTS = 5;
const MAX_RESUME_DELAY_MS = 16_000;
const SOCKET_HANDSHAKE_TIMEOUT_MS = 12_000;

/** Why a connection stopped. Only an explicit rejection is safe to forget. */
export type BridgeDisconnect = {
  kind: "pairing-rejected" | "resume-retry-exhausted" | "resume-rejected" | "resume-identity-mismatch";
  /** Network exhaustion stays recoverable on the next foreground/cold launch. */
  unrecoverable: boolean;
};

type SessionObserver = (profile: BridgeResumeProfile) => void | Promise<void>;

/**
 * Owns one phone-to-bridge connection. The QR secret authenticates only the
 * first upgrade; after a valid hello, a rotating resume secret lets a brief
 * Wi-Fi or relay socket drop recover without replaying a QR token. The app
 * can securely persist only that post-pairing session through this class's
 * `onSession` observer; this transport never asks it to store a QR secret.
 */
export class BridgeConnection {
  private socket: WebSocket | null = null;
  private pairing: PairingPayload | null = null;
  private bridgeUrl: string | null = null;
  private resumeToken: string | null = null;
  private deviceId: string | null = null;
  private pairedAt: string | null = null;
  private onEvent: ((event: BridgeEvent) => void) | null = null;
  private onDisconnect: ((disconnect: BridgeDisconnect) => void) | null = null;
  private onSession: SessionObserver | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private socketHandshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private socketAwaitingHello: WebSocket | null = null;
  private reconnectAttempt = 0;
  private didHandshake = false;
  private intentionallyClosed = false;
  private generation = 0;
  // WebSocket messages must remain ordered while a freshly rotated resume
  // secret is committed. Otherwise a status event could reach the dashboard
  // before its prerequisite hello/session write completed.
  private inboundQueue: Promise<void> = Promise.resolve();

  /**
   * Opens one pairing attempt. A socket opening is not enough: only a valid
   * bridge `hello` gives this client a resumption secret and a live session.
   */
  public connect(
    pairing: PairingPayload,
    onEvent: (event: BridgeEvent) => void,
    onDisconnect: (disconnect: BridgeDisconnect) => void,
    onSession?: SessionObserver,
  ): void {
    this.close();
    this.pairing = pairing;
    this.bridgeUrl = pairing.bridgeUrl;
    this.onEvent = onEvent;
    this.onDisconnect = onDisconnect;
    this.onSession = onSession ?? null;
    this.resumeToken = null;
    this.deviceId = null;
    this.pairedAt = new Date().toISOString();
    this.reconnectAttempt = 0;
    this.didHandshake = false;
    this.intentionallyClosed = false;
    this.generation += 1;
    this.openSocket(this.generation, false);
  }

  /**
   * Restores a previously authenticated session after a cold launch or when
   * iOS returns the app to the foreground. It cannot authenticate a new phone:
   * it works only with a server-issued rolling resume secret.
   */
  public resume(
    profile: BridgeResumeProfile,
    onEvent: (event: BridgeEvent) => void,
    onDisconnect: (disconnect: BridgeDisconnect) => void,
    onSession?: SessionObserver,
  ): void {
    if (!isBridgeResumeProfile(profile)) {
      onDisconnect({ kind: "resume-rejected", unrecoverable: true });
      return;
    }
    this.close();
    this.pairing = null;
    this.bridgeUrl = profile.bridgeUrl;
    this.resumeToken = profile.resumeToken;
    this.deviceId = profile.deviceId;
    this.pairedAt = profile.pairedAt;
    this.onEvent = onEvent;
    this.onDisconnect = onDisconnect;
    this.onSession = onSession ?? null;
    this.reconnectAttempt = 0;
    // The profile exists only after a previous verified hello. Treat it as a
    // resumable session, but wait for the new hello before the UI is live.
    this.didHandshake = true;
    this.intentionallyClosed = false;
    this.generation += 1;
    this.openSocket(this.generation, true);
  }

  /**
   * Forces a fresh WebSocket upgrade with the newest resume token. It is used
   * after iOS foregrounds an apparently open but non-responsive socket. No
   * command is replayed or queued by this recovery path.
   */
  public refresh(): boolean {
    if (this.intentionallyClosed || !this.didHandshake || !this.bridgeUrl || !this.resumeToken) return false;
    this.generation += 1;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    const previousSocket = this.socket;
    this.socket = null;
    this.clearSocketHandshakeTimeout(previousSocket);
    try { previousSocket?.close(); } catch { /* native socket may already be gone */ }
    this.openSocket(this.generation, true);
    return true;
  }

  private openSocket(generation: number, useResume: boolean): void {
    const pairing = this.pairing;
    const bridgeUrl = this.bridgeUrl;
    const pairingToken = pairing?.token;
    if (generation !== this.generation || !bridgeUrl || (!useResume && !pairingToken) || (useResume && !this.resumeToken)) return;
    const endpoint = bridgeWebSocketEndpoint(bridgeUrl);
    // Resume secrets travel in the upgrade header, never a URL. The app may
    // keep only a post-pairing rolling secret in Keychain; the original QR
    // secret is intentionally not retried or persisted.
    const url = useResume ? `${endpoint}/ws` : `${endpoint}/ws?token=${encodeURIComponent(pairingToken ?? "")}`;
    const Socket = WebSocket as unknown as RNWebSocketConstructor;
    let socket: WebSocket;
    try {
      socket = new Socket(url, [], {
        headers: {
          "bypass-tunnel-reminder": "true",
          ...(useResume && this.resumeToken ? { "x-omnibus-resume": this.resumeToken } : {}),
        },
      });
    } catch {
      this.handleSocketLoss(generation);
      return;
    }
    this.socket = socket;
    let closed = false;
    let errorFallback: ReturnType<typeof setTimeout> | null = null;
    const disconnectCurrentSocket = (closeCode?: number) => {
      if (closed) return;
      closed = true;
      if (errorFallback !== null) {
        clearTimeout(errorFallback);
        errorFallback = null;
      }
      this.clearSocketHandshakeTimeout(socket);
      if (this.socket === socket) this.socket = null;
      this.handleSocketLoss(generation, closeCode === 1008 ? "rejected" : undefined);
    };
    socket.onclose = event => disconnectCurrentSocket(event.code);
    socket.onerror = () => {
      if (generation !== this.generation || this.socket !== socket) return;
      try { socket.close(); } catch { /* a failed native upgrade can already be closed */ }
      // Let `onclose` win when it follows with a meaningful close code. In
      // particular, the bridge uses 1008 for a definitively expired stored
      // session; swallowing it here would make the app retry forever.
      errorFallback = setTimeout(() => disconnectCurrentSocket(), 250);
    };
    // Native WebSockets can remain in CONNECTING while a captive portal or a
    // dropped radio absorbs packets. Bound that state so persisted recovery
    // progresses to its next safe retry instead of appearing permanently busy.
    this.clearSocketHandshakeTimeout();
    this.socketAwaitingHello = socket;
    this.socketHandshakeTimer = setTimeout(() => {
      if (generation !== this.generation || this.socket !== socket) return;
      try { socket.close(); } catch { /* failed upgrades are already closed on some runtimes */ }
      disconnectCurrentSocket();
    }, SOCKET_HANDSHAKE_TIMEOUT_MS);
    socket.onmessage = message => {
      this.inboundQueue = this.inboundQueue
        .then(() => this.handleSocketMessage(socket, generation, bridgeUrl, message))
        .catch(() => {
          // A malformed payload or unavailable Keychain must not poison the
          // queue for later health/status messages.
        });
    };
  }

  private async handleSocketMessage(
    socket: WebSocket,
    generation: number,
    bridgeUrl: string,
    message: MessageEvent,
  ): Promise<void> {
    if (generation !== this.generation || this.socket !== socket) return;
    try {
      const event = JSON.parse(String(message.data)) as BridgeEvent;
      if (event.type === "hello") {
        // Do not let an incomplete/forged hello advance the app's paired
        // state. A resumable session exists only after the bridge supplied
        // a correctly shaped in-memory secret.
        if (!isResumeToken(event.resumeToken)) return;
        // A valid resume must preserve the original bridge-issued device
        // identity. A mismatch indicates a replaced endpoint/session, not a
        // normal coffee-shop network transition, so it is safe to forget.
        if (this.deviceId && event.deviceId !== this.deviceId) {
          try { socket.close(1008, "resume identity changed"); } catch { /* close races are harmless */ }
          this.finishDisconnect(generation, { kind: "resume-identity-mismatch", unrecoverable: true });
          return;
        }
        this.clearSocketHandshakeTimeout(socket);
        this.resumeToken = event.resumeToken;
        this.deviceId = event.deviceId;
        this.pairing = null;
        this.didHandshake = true;
        this.reconnectAttempt = 0;
        const profile: BridgeResumeProfile = {
          version: 1,
          bridgeUrl: bridgeUrl,
          resumeToken: event.resumeToken,
          deviceId: event.deviceId,
          pairedAt: this.pairedAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        // Persist before handing the live state to the UI: a crash after
        // this point still leaves the newest rotating secret in Keychain.
        try { await this.onSession?.(profile); } catch { /* persistence is an app concern; keep a live session usable */ }
      }
      if (generation !== this.generation || this.socket !== socket) return;
      this.onEvent?.(event);
    } catch {
      // Malformed payloads cannot advance session state or crash the app.
    }
  }

  private handleSocketLoss(generation: number, reason?: "rejected"): void {
    if (generation !== this.generation || this.intentionallyClosed) return;
    if (reason === "rejected") {
      this.finishDisconnect(generation, { kind: "resume-rejected", unrecoverable: this.didHandshake });
      return;
    }
    if (this.didHandshake && this.resumeToken && this.reconnectAttempt < MAX_RESUME_ATTEMPTS) {
      this.reconnectAttempt += 1;
      const delay = Math.min(MAX_RESUME_DELAY_MS, 1_000 * 2 ** (this.reconnectAttempt - 1));
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.openSocket(generation, true);
      }, delay);
      return;
    }
    this.finishDisconnect(generation, {
      kind: this.didHandshake ? "resume-retry-exhausted" : "pairing-rejected",
      unrecoverable: false,
    });
  }

  private finishDisconnect(generation: number, disconnectReason: BridgeDisconnect): void {
    if (generation !== this.generation || this.intentionallyClosed) return;
    const disconnect = this.onDisconnect;
    this.socket = null;
    this.clearSocketHandshakeTimeout();
    this.pairing = null;
    this.resumeToken = null;
    this.bridgeUrl = null;
    this.deviceId = null;
    this.pairedAt = null;
    this.onEvent = null;
    this.onDisconnect = null;
    this.onSession = null;
    this.didHandshake = false;
    disconnect?.(disconnectReason);
  }

  /** Cancels reconnects and forgets all transient pairing/resume material. */
  public close(): void {
    this.intentionallyClosed = true;
    this.generation += 1;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.clearSocketHandshakeTimeout(socket);
    this.pairing = null;
    this.bridgeUrl = null;
    this.resumeToken = null;
    this.deviceId = null;
    this.pairedAt = null;
    this.onEvent = null;
    this.onDisconnect = null;
    this.onSession = null;
    this.didHandshake = false;
    this.reconnectAttempt = 0;
    try { socket?.close(); } catch { /* already closed by the native runtime */ }
  }

  private clearSocketHandshakeTimeout(socket?: WebSocket | null): void {
    if (socket && this.socketAwaitingHello !== socket) return;
    if (this.socketHandshakeTimer !== null) {
      clearTimeout(this.socketHandshakeTimer);
      this.socketHandshakeTimer = null;
    }
    this.socketAwaitingHello = null;
  }

  private requireOpenSocket(): WebSocket {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("The laptop link is reconnecting. Wait a moment or scan the fresh bridge code if it does not recover.");
    }
    return this.socket;
  }

  /** Sends an explicitly consented idea; no reconnect path queues commands. */
  public command(directive: string, mode: CommandMode, research = false, homeFleet = false): string {
    const socket = this.requireOpenSocket();
    const correlationId = makeUuid();
    socket.send(JSON.stringify({ type: "command", correlationId, directive, mode, research, homeFleet }));
    return correlationId;
  }

  /** Requests the secret-free laptop capability sheet after QR pairing. */
  public requestFleetSnapshot(): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ type: "fleet_snapshot" }));
    return true;
  }

  /** The bridge accepts only its fixed local model presets. */
  public provisionFleet(profileId: FleetProfileId): string {
    const socket = this.requireOpenSocket();
    const correlationId = makeUuid();
    socket.send(JSON.stringify({ type: "fleet_provision", correlationId, profileId }));
    return correlationId;
  }

  /** An optional Brave key crosses only this authenticated live socket. */
  public configureResearch(enabled: boolean, braveSearchApiKey?: string): string {
    const socket = this.requireOpenSocket();
    const correlationId = makeUuid();
    socket.send(JSON.stringify({
      type: "research_configure",
      correlationId,
      enabled,
      ...(braveSearchApiKey?.trim() ? { braveSearchApiKey: braveSearchApiKey.trim() } : {}),
    }));
    return correlationId;
  }

  /** Creates a short-lived, private-LAN worker command. */
  public createHomeFleetInvite(): string {
    const socket = this.requireOpenSocket();
    const correlationId = makeUuid();
    socket.send(JSON.stringify({ type: "home_fleet_invite", correlationId }));
    return correlationId;
  }

  /** Revokes a paired worker's coordinator credential. */
  public removeHomeFleetWorker(workerId: string): string {
    const socket = this.requireOpenSocket();
    const correlationId = makeUuid();
    socket.send(JSON.stringify({ type: "home_fleet_remove", correlationId, workerId }));
    return correlationId;
  }

  /** Second owner confirmation before a worker may review an idea. */
  public approveHomeFleetWorker(workerId: string): string {
    const socket = this.requireOpenSocket();
    const correlationId = makeUuid();
    socket.send(JSON.stringify({ type: "home_fleet_approve", correlationId, workerId }));
    return correlationId;
  }

  /** Requests the counters-only Second Brain status card. */
  public requestBrainStatus(): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ type: "brain_status" }));
    return true;
  }

  /** A lightweight reachability probe that never starts agent work. */
  public ping(sentAt = Date.now()): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ type: "ping", sentAt }));
    return true;
  }
}

function isResumeToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

function isBridgeResumeProfile(value: BridgeResumeProfile): boolean {
  if (value.version !== 1 || !isResumeToken(value.resumeToken)) return false;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(value.deviceId)) return false;
  if (!Number.isFinite(Date.parse(value.pairedAt)) || !Number.isFinite(Date.parse(value.updatedAt))) return false;
  return isBridgeUrl(value.bridgeUrl);
}

function isBridgeUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:")
      && Boolean(url.hostname)
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function bridgeWebSocketEndpoint(bridgeUrl: string): string {
  return bridgeUrl.replace(/\/+$/, "").replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}

function makeUuid(): string {
  // RFC 4122 v4-shaped ID without depending on a browser crypto polyfill.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, marker => {
    const random = Math.floor(Math.random() * 16);
    const value = marker === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export function parsePairingPayload(value: string): PairingPayload {
  const parsed = JSON.parse(value) as Partial<PairingPayload>;
  if (parsed.version !== 1 || !isBridgeUrl(parsed.bridgeUrl) || typeof parsed.token !== "string" || parsed.token.length < 32) {
    throw new Error("This is not an Omnibus bridge pairing code.");
  }
  return parsed as PairingPayload;
}
