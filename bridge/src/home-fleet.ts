import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";

/**
 * LAN-only home-fleet protocol.
 *
 * This module intentionally has no dependency on the public tunnel, the
 * WebSocket bridge, agent contracts, Ollama model-pull helpers, or child
 * process execution. A future coordinator can embed it behind a separate
 * private interface, while a worker can be started by a local CLI with an
 * owner-supplied join payload. HMAC authenticates peer requests but does not
 * encrypt review text, so this is intentionally for a trusted home LAN—not an
 * Internet, public-tunnel, or untrusted-Wi-Fi transport.
 */
export const HOME_FLEET_PROTOCOL_VERSION = 1 as const;
export const HOME_FLEET_MAX_REVIEW_TEXT_CHARS = 12_000;
export const HOME_FLEET_MAX_REVIEW_SUMMARY_CHARS = 6_000;

const REGISTER_PATH = "/home-fleet/v1/register";
const HEARTBEAT_PATH = "/home-fleet/v1/heartbeat";
const HEALTH_PATH = "/home-fleet/v1/health";
const CAPABILITIES_PATH = "/home-fleet/v1/capabilities";
const REVIEW_PATH = "/home-fleet/v1/review";
/** Coordinator -> worker: one signed, content-addressed context bundle offer. */
export const CONTEXT_OFFER_PATH = "/home-fleet/v1/context-offer";
/** Worker -> worker: ticket-authorized P2P fetch of an already-held bundle. */
export const CONTEXT_FETCH_PATH = "/home-fleet/v1/context-fetch";
const MAX_JSON_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
/**
 * Context messages carry up to ~20k chars of bundle text plus JSON escaping,
 * so they get a dedicated bound. Every other path keeps the original limit:
 * a v1 peer that never learned these paths sees no behavioural change.
 */
const MAX_CONTEXT_JSON_BYTES = 96 * 1024;
/** Bundle text ceiling mirrors the FleetContextBundle schema maximum. */
const MAX_CONTEXT_TEXT_CHARS = 24_000;
/** A worker keeps at most this many bundles resident (LRU). */
const MAX_WORKER_CONTEXT_BUNDLES = 2;
/** Heartbeats advertise at most this many warm digests. */
const MAX_CACHED_PREFIXES = 4;
/** Peer-transfer tickets are single-purpose and expire quickly. */
const CONTEXT_TICKET_TTL_MS = 120_000;
const AUTH_WINDOW_MS = 60_000;
const MAX_REPLAY_NONCES = 512;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_JOIN_TTL_MS = 5 * 60_000;

export type HomeFleetEndpoint = {
  protocol: "http";
  host: string;
  port: number;
  /** A canonical literal-IP endpoint. Hostnames and public addresses are never accepted. */
  url: string;
};

export type HomeFleetWorkerCapabilities = {
  protocolVersion: typeof HOME_FLEET_PROTOCOL_VERSION;
  roles: readonly ["review"];
  installedModels: string[];
  maxConcurrentReviews: 1;
  acceptsArbitraryCommands: false;
  permitsModelPulls: false;
};

export type HomeFleetWorkerHealth = {
  status: "ready";
  at: string;
};

export type HomeFleetWorkerStatus = "registered" | "healthy" | "unreachable" | "unauthorized";

export type HomeFleetWorkerSnapshot = {
  workerId: string;
  label: string;
  endpoint: HomeFleetEndpoint;
  registeredAt: string;
  status: HomeFleetWorkerStatus;
  lastCheckedAt?: string;
  health?: HomeFleetWorkerHealth;
  capabilities?: HomeFleetWorkerCapabilities;
  /** Warm bundle digests the worker advertised in its latest heartbeat. */
  cachedPrefixes?: string[];
};

export type HomeFleetCoordinatorSnapshot = {
  protocolVersion: typeof HOME_FLEET_PROTOCOL_VERSION;
  role: "coordinator";
  coordinatorId: string;
  endpoint?: HomeFleetEndpoint;
  pendingJoinTokens: number;
  workers: HomeFleetWorkerSnapshot[];
};

/** Safe to serialize into a QR code or a manually transferred join payload. */
export type HomeFleetJoinInvitation = {
  protocolVersion: typeof HOME_FLEET_PROTOCOL_VERSION;
  type: "home_fleet.join";
  invitationId: string;
  /** High-entropy, one-time token. Never include it in snapshots or logs. */
  joinToken: string;
  coordinatorId: string;
  coordinator: HomeFleetEndpoint;
  issuedAt: string;
  expiresAt: string;
};

export type HomeFleetRegistrationRequest = {
  protocolVersion: typeof HOME_FLEET_PROTOCOL_VERSION;
  type: "home_fleet.register";
  invitationId: string;
  coordinatorId: string;
  worker: {
    workerId: string;
    label: string;
    endpoint: HomeFleetEndpoint;
  };
  nonce: string;
  /** HMAC proof of the invitation token; the token itself is never sent. */
  proof: string;
  /**
   * Present only when a previously paired worker is deliberately repairing
   * its route with a fresh owner-issued invitation. It proves possession of
   * the old derived secret so a stolen invitation cannot replace an active
   * worker identity or consume its slot.
   */
  recoveryProof?: string;
};

export type HomeFleetRegistrationResponse = {
  protocolVersion: typeof HOME_FLEET_PROTOCOL_VERSION;
  type: "home_fleet.registered";
  invitationId: string;
  coordinatorId: string;
  workerId: string;
  registeredAt: string;
  /** HMAC proof derived from the one-time token and worker identity. */
  proof: string;
};

/** A worker-initiated, signed liveness/rebind request. */
export type HomeFleetHeartbeatRequest = {
  protocolVersion: typeof HOME_FLEET_PROTOCOL_VERSION;
  type: "home_fleet.heartbeat";
  workerId: string;
  /** The worker's current listener endpoint, verified against its TCP source. */
  endpoint: HomeFleetEndpoint;
  timestamp: string;
  nonce: string;
  /** Present only while the worker is advertising an owner-chosen rename. */
  label?: string;
  /**
   * Optional warm-cache advertisement (each entry a sha256 hex digest of a
   * context bundle this worker holds). A v0.2.0 worker that never sends the
   * field produces a byte-identical heartbeat and signature to before.
   */
  cachedPrefixes?: string[];
  proof: string;
};

/** Signed acknowledgement; lets the worker safely learn a moved coordinator endpoint. */
export type HomeFleetHeartbeatResponse = {
  protocolVersion: typeof HOME_FLEET_PROTOCOL_VERSION;
  type: "home_fleet.heartbeat_ack";
  coordinatorId: string;
  workerId: string;
  coordinator: HomeFleetEndpoint;
  at: string;
  requestNonce: string;
  proof: string;
};

export type HomeFleetHeartbeatResult = {
  status: "ok" | "unpaired" | "unreachable" | "unauthorized";
  /** The currently authenticated coordinator endpoint when the heartbeat succeeds. */
  coordinator?: HomeFleetEndpoint;
};

export type HomeFleetHealthResponse = {
  protocolVersion: typeof HOME_FLEET_PROTOCOL_VERSION;
  type: "home_fleet.health";
  workerId: string;
  health: HomeFleetWorkerHealth;
};

export type HomeFleetCapabilitiesResponse = {
  protocolVersion: typeof HOME_FLEET_PROTOCOL_VERSION;
  type: "home_fleet.capabilities";
  workerId: string;
  capabilities: HomeFleetWorkerCapabilities;
};

export type HomeFleetReviewRequest = {
  protocolVersion: typeof HOME_FLEET_PROTOCOL_VERSION;
  type: "home_fleet.review";
  requestId: string;
  /** Fixed review role input, bounded before it crosses the LAN. */
  text: string;
  /**
   * Optional warm-prefix routing hint: the digest of a context bundle the
   * coordinator believes this worker already holds. It never carries bundle
   * text and an unknown digest simply reviews without a prefix; cache state
   * can never fail a review.
   */
  prefixDigest?: string;
};

export type HomeFleetReviewResponse = {
  protocolVersion: typeof HOME_FLEET_PROTOCOL_VERSION;
  type: "home_fleet.review_result";
  workerId: string;
  requestId: string;
  summary: string;
};

export type HomeFleetReviewResult = {
  workerId: string;
  requestId: string;
  status: "ok" | "unreachable" | "rejected" | "unauthorized";
  summary?: string;
};

/**
 * A short-lived authorization for one worker to fetch one digest from one
 * peer worker. The ticket is an HMAC under the SERVING worker's derived
 * secret, so only the coordinator can mint it, only the serving worker can
 * verify it, and the requesting worker cannot forge or repurpose it.
 */
export type HomeFleetContextPeerHint = {
  workerId: string;
  endpoint: HomeFleetEndpoint;
  ticket: string;
  ticketExpiresAt: string;
};

/**
 * Coordinator -> worker context bundle offer, signed exactly like a review
 * request. Either `text` is inlined (seed transfer) or `peer` points at a
 * warm worker holding the same digest. Content addressing is the integrity
 * model: the receiving worker must verify sha256(text) === digest no matter
 * which route delivered the text.
 */
export type HomeFleetContextOfferRequest = {
  protocolVersion: typeof HOME_FLEET_PROTOCOL_VERSION;
  type: "home_fleet.context_offer";
  requestId: string;
  digest: string;
  chars: number;
  text?: string;
  peer?: HomeFleetContextPeerHint;
};

export type HomeFleetContextOfferResponse = {
  protocolVersion: typeof HOME_FLEET_PROTOCOL_VERSION;
  type: "home_fleet.context_offer_result";
  workerId: string;
  requestId: string;
  status: "warmed" | "cached" | "failed";
};

/** Worker -> worker P2P fetch of a bundle the serving worker already holds. */
export type HomeFleetContextFetchRequest = {
  protocolVersion: typeof HOME_FLEET_PROTOCOL_VERSION;
  type: "home_fleet.context_fetch";
  digest: string;
  requesterWorkerId: string;
  ticket: string;
  ticketExpiresAt: string;
  nonce: string;
};

export type HomeFleetContextFetchResponse = {
  protocolVersion: typeof HOME_FLEET_PROTOCOL_VERSION;
  type: "home_fleet.context_fetched";
  digest: string;
  text: string;
};

export type HomeFleetContextOfferResult = {
  workerId: string;
  requestId: string;
  status: "warmed" | "cached" | "failed" | "unreachable" | "rejected" | "unauthorized";
};

/** The complete serializable message family; no shell, URL, or model-pull message exists. */
export type HomeFleetMessage =
  | HomeFleetJoinInvitation
  | HomeFleetRegistrationRequest
  | HomeFleetRegistrationResponse
  | HomeFleetHeartbeatRequest
  | HomeFleetHeartbeatResponse
  | HomeFleetHealthResponse
  | HomeFleetCapabilitiesResponse
  | HomeFleetReviewRequest
  | HomeFleetReviewResponse
  | HomeFleetContextOfferRequest
  | HomeFleetContextOfferResponse
  | HomeFleetContextFetchRequest
  | HomeFleetContextFetchResponse;

/**
 * Sensitive owner-local state for durable coordinator pairing. It contains
 * derived worker secrets but deliberately excludes join invitations/tokens.
 * Callers must store it only in an owner-readable `0600` file; this module
 * performs validation and serialization but intentionally does not choose a
 * filesystem path or write secrets on its own.
 */
export type HomeFleetCoordinatorPrivateState = {
  version: typeof HOME_FLEET_PROTOCOL_VERSION;
  role: "coordinator";
  coordinatorId: string;
  workers: Array<{
    workerId: string;
    label: string;
    endpoint: HomeFleetEndpoint;
    registeredAt: string;
    /** Derived 32-byte HMAC secret, base64url encoded. */
    secret: string;
  }>;
};

/** Sensitive owner-local state for durable worker pairing; never send to UI. */
export type HomeFleetWorkerPrivateState = {
  version: typeof HOME_FLEET_PROTOCOL_VERSION;
  role: "worker";
  workerId: string;
  coordinator?: {
    coordinatorId: string;
    endpoint: HomeFleetEndpoint;
    /** Derived 32-byte HMAC secret, base64url encoded. */
    secret: string;
  };
};

export type HomeFleetReviewHandler = (input: Readonly<{
  requestId: string;
  text: string;
  /**
   * The exact locally held bundle text when the coordinator routed by a warm
   * prefix digest. Handlers that ignore it keep compiling and reviewing the
   * idea text exactly as before.
   */
  prefixText?: string;
}>) => Promise<{ summary: string }> | { summary: string };

export type HomeFleetCoordinatorOptions = {
  coordinatorId?: string;
  now?: () => Date;
  requestTimeoutMs?: number;
  /** Hard protocol limit; recovery/rekey replaces an existing slot atomically. */
  maxWorkers?: number;
  /**
   * Owner-local integrations use this to atomically persist derived worker
   * secrets after a successful registration, route repair, or revocation. A
   * promise is awaited by the private HTTP handler before it acknowledges a
   * new/rekeyed session, preventing a power loss from silently consuming the
   * one-time invitation while losing the durable credential. Errors remain
   * non-fatal to the protocol reply so storage trouble never leaks LAN state.
   */
  onWorkerChanged?: () => void | Promise<void>;
};

export type HomeFleetListenOptions = {
  /** Must be an RFC1918 or loopback literal address. Defaults to loopback. */
  host?: string;
  /** Zero lets the OS allocate a local port; advertised endpoints always use the actual port. */
  port?: number;
};

export type HomeFleetWorkerOptions = HomeFleetListenOptions & {
  workerId?: string;
  label: string;
  /** Informational only. This module never pulls, changes, or runs a model. */
  installedModels?: readonly string[];
  /**
   * Owner-supplied local review implementation. The LAN protocol can pass
   * only bounded text to this callback; no remote command/model/url reaches it.
   */
  review?: HomeFleetReviewHandler;
  /**
   * Called after an authenticated coordinator endpoint/session change. The
   * embedding CLI can persist `exportPrivateState()` without this protocol
   * module ever choosing a secret-bearing filesystem path.
   */
  onCoordinatorChanged?: () => void;
  /** Set when the owner renamed this worker; the heartbeat carries it once. */
  advertiseLabelUpdate?: boolean;
  /**
   * Optional local prompt-prefix warmer invoked after a bundle is stored and
   * verified. The embedding CLI wires it to a bounded local Ollama generate;
   * this module never talks to Ollama itself. When absent, bundles are still
   * stored and advertised, and offers report "cached" instead of "warmed".
   */
  contextWarmer?: (bundle: { digest: string; text: string }) => Promise<boolean>;
  now?: () => Date;
};

export type HomeFleetReviewOptions = {
  /** Small bounded fanout; each worker also accepts only one review at a time. */
  concurrency?: number;
  /** Warm-prefix routing hint forwarded verbatim in each review request. */
  prefixDigest?: string;
};

export class HomeFleetError extends Error {
  public constructor(
    public readonly code:
      | "PRIVATE_ADDRESS_REQUIRED"
      | "INVALID_MESSAGE"
      | "JOIN_TOKEN_INVALID"
      | "JOIN_TOKEN_EXPIRED"
      | "WORKER_ALREADY_REGISTERED"
      | "WORKER_LIMIT_REACHED"
      | "WORKER_UNKNOWN"
      | "AUTHENTICATION_FAILED"
      | "REPLAY_REJECTED"
      | "REVIEW_UNAVAILABLE"
      | "REVIEW_BUSY"
      | "REQUEST_REJECTED",
    message: string,
  ) {
    super(message);
    this.name = "HomeFleetError";
  }
}

type PendingInvitation = {
  token: Buffer;
  coordinator: HomeFleetEndpoint;
  expiresAt: number;
};

type RegisteredWorker = {
  snapshot: HomeFleetWorkerSnapshot;
  secret: Buffer;
  /** Replay protection for worker-initiated heartbeats; intentionally transient. */
  heartbeatReplayWindow: ReplayWindow;
};

type WorkerCoordinatorSession = {
  coordinatorId: string;
  endpoint: HomeFleetEndpoint;
  secret: Buffer;
};

type AuthenticatedRequest = {
  requestNonce: string;
};

/**
 * LAN-only coordinator manager and registration server.
 *
 * Start it on an explicit private/loopback interface, issue one invitation,
 * and give the serialized invitation to an owner-controlled worker. It never
 * touches the public pairing tunnel and retains no join token after success.
 */
export class HomeFleetCoordinator {
  public readonly coordinatorId: string;
  private readonly invitations = new Map<string, PendingInvitation>();
  private readonly workers = new Map<string, RegisteredWorker>();
  private readonly now: () => Date;
  private readonly requestTimeoutMs: number;
  private readonly maxWorkers: number;
  private readonly onWorkerChanged: (() => void | Promise<void>) | undefined;
  private workerChangePersistence: Promise<void> = Promise.resolve();
  private server: Server | undefined;
  private endpoint: HomeFleetEndpoint | undefined;

  public constructor(options: HomeFleetCoordinatorOptions = {}) {
    this.coordinatorId = validateIdentifier(options.coordinatorId ?? randomUUID(), "coordinatorId");
    this.now = options.now ?? (() => new Date());
    this.requestTimeoutMs = clampInteger(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, 500, 15_000);
    this.maxWorkers = clampInteger(options.maxWorkers ?? 8, 1, 128);
    this.onWorkerChanged = options.onWorkerChanged;
  }

  /** Starts only the private registration listener; it is not a public tunnel server. */
  public async listen(options: HomeFleetListenOptions = {}): Promise<HomeFleetEndpoint> {
    if (this.server && this.endpoint) return clone(this.endpoint);
    const host = assertPrivateBindHost(options.host ?? "127.0.0.1");
    const port = assertListenPort(options.port ?? 0);
    const server = createServer((request, response) => {
      void this.handleRegistrationHttp(request, response);
    });
    await listenServer(server, host, port);
    const address = server.address();
    if (!address || typeof address === "string") {
      await closeServer(server);
      throw new HomeFleetError("REQUEST_REJECTED", "The private coordinator listener did not return a TCP address.");
    }
    this.server = server;
    this.endpoint = endpointFor(host, address.port);
    return clone(this.endpoint);
  }

  public async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.endpoint = undefined;
    if (server) await closeServer(server);
  }

  /**
   * Generates a short-lived, single-use invitation. The coordinator must be
   * listening first so a worker cannot be given an arbitrary callback URL.
   */
  public issueJoinInvitation(options: { ttlMs?: number } = {}): HomeFleetJoinInvitation {
    if (!this.endpoint) throw new HomeFleetError("REQUEST_REJECTED", "Start the private coordinator listener before issuing a worker invitation.");
    const ttlMs = clampInteger(options.ttlMs ?? DEFAULT_JOIN_TTL_MS, 30_000, 30 * 60_000);
    const issuedAt = this.now();
    const invitationId = randomUUID();
    const joinToken = randomBytes(32).toString("base64url");
    this.purgeExpiredInvitations(issuedAt.getTime());
    this.invitations.set(invitationId, {
      token: Buffer.from(joinToken, "base64url"),
      coordinator: clone(this.endpoint),
      expiresAt: issuedAt.getTime() + ttlMs,
    });
    return {
      protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
      type: "home_fleet.join",
      invitationId,
      joinToken,
      coordinatorId: this.coordinatorId,
      coordinator: clone(this.endpoint),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + ttlMs).toISOString(),
    };
  }

  /** Safe to expose to a local dashboard; secrets and invitations are omitted. */
  public snapshot(): HomeFleetCoordinatorSnapshot {
    this.purgeExpiredInvitations(this.now().getTime());
    return {
      protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
      role: "coordinator",
      coordinatorId: this.coordinatorId,
      ...(this.endpoint ? { endpoint: clone(this.endpoint) } : {}),
      pendingJoinTokens: this.invitations.size,
      workers: [...this.workers.values()]
        .map(record => clone(record.snapshot))
        .sort((left, right) => left.workerId.localeCompare(right.workerId)),
    };
  }

  /**
   * Revokes a worker locally by removing its derived secret and endpoint.
   * Future signed probes/reviews fail because the coordinator has no remaining
   * credential or network target for that worker. No caller-supplied endpoint
   * is accepted by this operation.
   */
  public removeWorker(workerId: string): boolean {
    const removed = this.workers.delete(validateIdentifier(workerId, "workerId"));
    if (removed) this.notifyWorkerChanged();
    return removed;
  }

  /**
   * Export just enough pairing material to resume signed LAN probes after a
   * restart. Pending join invitations are intentionally not durable, so a
   * restart always requires a fresh explicit invitation for a new worker.
   */
  public exportPrivateState(): HomeFleetCoordinatorPrivateState {
    return {
      version: HOME_FLEET_PROTOCOL_VERSION,
      role: "coordinator",
      coordinatorId: this.coordinatorId,
      workers: [...this.workers.values()]
        .map(record => ({
          workerId: record.snapshot.workerId,
          label: record.snapshot.label,
          endpoint: clone(record.snapshot.endpoint),
          registeredAt: record.snapshot.registeredAt,
          secret: record.secret.toString("base64url"),
        }))
        .sort((left, right) => left.workerId.localeCompare(right.workerId)),
    };
  }

  /** Imports validated owner-local state into a coordinator with the same identity. */
  public importPrivateState(value: unknown): void {
    const state = parseHomeFleetCoordinatorPrivateState(value);
    if (state.coordinatorId !== this.coordinatorId) {
      throw new HomeFleetError("INVALID_MESSAGE", "Coordinator private state belongs to a different coordinator identity.");
    }
    this.workers.clear();
    for (const worker of state.workers) {
      this.workers.set(worker.workerId, {
        secret: decodeSecret(worker.secret),
        heartbeatReplayWindow: new ReplayWindow(),
        snapshot: {
          workerId: worker.workerId,
          label: worker.label,
          endpoint: clone(worker.endpoint),
          registeredAt: worker.registeredAt,
          status: "registered",
        },
      });
    }
  }

  /** Constructs a coordinator with the identity and workers in private state. */
  public static fromPrivateState(value: unknown, options: Omit<HomeFleetCoordinatorOptions, "coordinatorId"> = {}): HomeFleetCoordinator {
    const state = parseHomeFleetCoordinatorPrivateState(value);
    const coordinator = new HomeFleetCoordinator({ ...options, coordinatorId: state.coordinatorId });
    coordinator.importPrivateState(state);
    return coordinator;
  }

  /**
   * Lower-level registration API for an embedding server. `sourceAddress`
   * must come from the TCP socket, never from a client-provided header.
   */
  public acceptRegistration(value: unknown, sourceAddress: string): HomeFleetRegistrationResponse {
    const request = parseRegistrationRequest(value);
    const source = normalizePrivateAddress(sourceAddress);
    if (!source) throw new HomeFleetError("PRIVATE_ADDRESS_REQUIRED", "Worker registration is permitted only from a private or loopback address.");
    if (request.coordinatorId !== this.coordinatorId) throw new HomeFleetError("JOIN_TOKEN_INVALID", "This join invitation belongs to another coordinator.");
    if (request.worker.endpoint.host !== source) {
      throw new HomeFleetError("PRIVATE_ADDRESS_REQUIRED", "The worker endpoint must exactly match the private address that registered it.");
    }

    const invitation = this.invitations.get(request.invitationId);
    if (!invitation) throw new HomeFleetError("JOIN_TOKEN_INVALID", "The join token is unknown or was already used.");
    if (invitation.expiresAt <= this.now().getTime()) {
      this.invitations.delete(request.invitationId);
      throw new HomeFleetError("JOIN_TOKEN_EXPIRED", "The join token expired. Generate a new invitation on the coordinator.");
    }
    if (!this.endpoint || !sameEndpoint(invitation.coordinator, this.endpoint)) {
      throw new HomeFleetError("JOIN_TOKEN_INVALID", "The registration was not sent to the invitation's private coordinator endpoint.");
    }
    if (!verifyMac(invitation.token, registrationPayload(request), request.proof)) {
      throw new HomeFleetError("JOIN_TOKEN_INVALID", "The worker could not prove possession of the join token.");
    }
    const existing = this.workers.get(request.worker.workerId);
    if (existing) {
      // A fresh invitation alone must never be able to take over an existing
      // slot. A repair/rekey additionally proves the current derived secret,
      // which lets the same physical worker recover after DHCP/coordinator
      // endpoint changes without creating a duplicate record.
      if (!request.recoveryProof || !verifyMac(existing.secret, registrationRecoveryPayload(request), request.recoveryProof)) {
        throw new HomeFleetError("WORKER_ALREADY_REGISTERED", "This worker identity is already paired with the coordinator.");
      }
    } else if (this.workers.size >= this.maxWorkers) {
      throw new HomeFleetError("WORKER_LIMIT_REACHED", "The Home Fleet worker limit has been reached. Repair an existing paired worker or remove one first.");
    }

    const registeredAt = this.now().toISOString();
    const secret = deriveWorkerSecret(invitation.token, request.worker.workerId);
    const response: HomeFleetRegistrationResponse = {
      protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
      type: "home_fleet.registered",
      invitationId: request.invitationId,
      coordinatorId: this.coordinatorId,
      workerId: request.worker.workerId,
      registeredAt,
      proof: "",
    };
    response.proof = signMac(secret, registrationResponsePayload(response));
    this.workers.set(request.worker.workerId, {
      secret,
      heartbeatReplayWindow: new ReplayWindow(),
      snapshot: {
        workerId: request.worker.workerId,
        label: request.worker.label,
        endpoint: clone(request.worker.endpoint),
        // Keep the durable original pairing time during a recovery. It makes
        // the replacement atomic from the owner's point of view while the
        // derived secret and endpoint are rekeyed below.
        registeredAt: existing?.snapshot.registeredAt ?? registeredAt,
        status: "registered",
      },
    });
    // One successful proof consumes the token immediately. The retained worker
    // secret cannot recreate another invitation and is never serialized.
    this.invitations.delete(request.invitationId);
    this.notifyWorkerChanged();
    return response;
  }

  /**
   * Authenticates a worker-owned liveness signal and, when its private LAN
   * address changed, atomically rebinds the existing slot. This is deliberately
   * not a registration path: it requires the already-paired derived secret,
   * preserves the worker ID, and cannot increase the fleet size.
   */
  public acceptHeartbeat(value: unknown, sourceAddress: string): HomeFleetHeartbeatResponse {
    const request = parseHeartbeatRequest(value);
    const source = normalizePrivateAddress(sourceAddress);
    if (!source) throw new HomeFleetError("PRIVATE_ADDRESS_REQUIRED", "Worker heartbeats are permitted only from a private or loopback address.");
    if (request.endpoint.host !== source) {
      throw new HomeFleetError("PRIVATE_ADDRESS_REQUIRED", "The worker heartbeat endpoint must exactly match its private TCP source address.");
    }
    const record = this.requireWorker(request.workerId);
    const now = this.now();
    if (!isTimestampFresh(request.timestamp, now)) {
      throw new HomeFleetError("AUTHENTICATION_FAILED", "Worker heartbeat timestamp is outside the allowed window.");
    }
    if (!isUuidLike(request.nonce)) throw new HomeFleetError("AUTHENTICATION_FAILED", "Worker heartbeat nonce is invalid.");
    if (!verifyMac(record.secret, heartbeatRequestPayload(request), request.proof)) {
      throw new HomeFleetError("AUTHENTICATION_FAILED", "Worker heartbeat signature is invalid.");
    }
    if (record.heartbeatReplayWindow.has(request.nonce, now.getTime())) {
      throw new HomeFleetError("REPLAY_REJECTED", "A worker heartbeat nonce was replayed.");
    }
    record.heartbeatReplayWindow.add(request.nonce, now.getTime());

    // Warm-cache state is authoritative from the worker's latest heartbeat
    // only: it is transient routing metadata, never persisted, and an absent
    // field (older workers, restarted workers) clears any previous claim.
    // Strict digest filtering happens HERE, after the MAC verified the raw
    // advertisement: a malformed or oversized entry costs the worker its
    // routing hint, never its heartbeat.
    const sanitizedPrefixes = parseCachedPrefixes(request.cachedPrefixes);
    if (sanitizedPrefixes) record.snapshot.cachedPrefixes = sanitizedPrefixes;
    else delete record.snapshot.cachedPrefixes;

    // An advertised rename becomes the durable display name. Sanitized only
    // after MAC verification; an empty result keeps the existing name so a
    // hostile rename cannot blank a Fleet Setup row.
    if (request.label !== undefined) {
      const renamed = request.label.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
      if (renamed && renamed !== record.snapshot.label) {
        record.snapshot.label = renamed;
        this.notifyWorkerChanged();
      }
    }

    const endpointChanged = !sameEndpoint(record.snapshot.endpoint, request.endpoint);
    if (endpointChanged) {
      // An IP/port change invalidates previous reverse health evidence. Keep
      // the one durable worker slot but require the next signed probe before
      // the phone may consider it online or use it for a review.
      record.snapshot.endpoint = clone(request.endpoint);
      record.snapshot.status = "registered";
      delete record.snapshot.health;
      delete record.snapshot.capabilities;
      this.notifyWorkerChanged();
    }
    record.snapshot.lastCheckedAt = now.toISOString();

    if (!this.endpoint) {
      throw new HomeFleetError("REQUEST_REJECTED", "The private coordinator listener is not running.");
    }
    const response: HomeFleetHeartbeatResponse = {
      protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
      type: "home_fleet.heartbeat_ack",
      coordinatorId: this.coordinatorId,
      workerId: request.workerId,
      coordinator: clone(this.endpoint),
      at: now.toISOString(),
      requestNonce: request.nonce,
      proof: "",
    };
    response.proof = signMac(record.secret, heartbeatResponsePayload(response));
    return response;
  }

  /**
   * Serializes owner-local durability work. We intentionally swallow storage
   * errors at this low-level boundary—the caller still gets a safe protocol
   * response—but a successful callback is awaited before a LAN registration
   * acknowledgement leaves this process.
   */
  private notifyWorkerChanged(): void {
    this.workerChangePersistence = this.workerChangePersistence
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.onWorkerChanged?.();
        } catch {
          // Storage errors are owner-local diagnostics, not LAN protocol data.
        }
      });
  }

  public async flushWorkerChangePersistence(): Promise<void> {
    await this.workerChangePersistence;
  }

  /** Performs authenticated health and capability probes against one paired worker. */
  public async inspectWorker(workerId: string): Promise<HomeFleetWorkerSnapshot> {
    const record = this.requireWorker(workerId);
    try {
      const health = parseHealthResponse(await this.authenticatedRequest(record, "GET", HEALTH_PATH), workerId);
      const capabilities = parseCapabilitiesResponse(await this.authenticatedRequest(record, "GET", CAPABILITIES_PATH), workerId);
      record.snapshot.status = "healthy";
      record.snapshot.lastCheckedAt = this.now().toISOString();
      record.snapshot.health = health.health;
      record.snapshot.capabilities = capabilities.capabilities;
    } catch (error) {
      record.snapshot.status = error instanceof HomeFleetError && error.code === "AUTHENTICATION_FAILED" ? "unauthorized" : "unreachable";
      record.snapshot.lastCheckedAt = this.now().toISOString();
    }
    return clone(record.snapshot);
  }

  /**
   * Fan out one fixed local `review` role to paired workers with a small
   * concurrency limit. There is no command, tool, URL, model tag, or pull
   * input in this API; workers receive only bounded text and return a summary.
   */
  public async reviewWorkers(
    workerIds: readonly string[],
    text: string,
    options: HomeFleetReviewOptions = {},
  ): Promise<HomeFleetReviewResult[]> {
    const safeText = validateReviewText(text);
    const uniqueWorkerIds = [...new Set(workerIds.map(workerId => validateIdentifier(workerId, "workerId")))];
    const concurrency = clampInteger(options.concurrency ?? 3, 1, 8);
    // An invalid routing hint is quietly dropped rather than failing the
    // review: prefix caching is an optimization layered on top of the fixed
    // review role, never a precondition for it.
    const prefixDigest = typeof options.prefixDigest === "string" && isSha256Hex(options.prefixDigest)
      ? options.prefixDigest
      : undefined;
    const jobs = uniqueWorkerIds.map(workerId => async () => this.reviewOne(workerId, safeText, prefixDigest));
    return runBounded(jobs, concurrency);
  }

  /**
   * Signs and sends one context-bundle offer to a paired worker. With no
   * `peerHint` the bundle text travels inline (seed transfer); with a warm
   * peer, only the digest plus a short-lived transfer ticket cross to the
   * receiving worker, and the bundle body moves worker-to-worker instead of
   * being re-sent by the coordinator.
   */
  public async offerContext(
    workerId: string,
    bundle: { digest: string; text: string },
    peerHint?: { workerId: string; endpoint: HomeFleetEndpoint },
  ): Promise<HomeFleetContextOfferResult> {
    const requestId = randomUUID();
    let record: RegisteredWorker;
    try {
      record = this.requireWorker(validateIdentifier(workerId, "workerId"));
    } catch {
      return { workerId, requestId, status: "rejected" };
    }
    let request: HomeFleetContextOfferRequest;
    try {
      const digest = validateContextDigest(bundle.digest);
      const text = validateContextText(bundle.text);
      if (sha256Hex(text) !== digest) {
        throw new HomeFleetError("INVALID_MESSAGE", "Context bundle text does not match its digest.");
      }
      request = {
        protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
        type: "home_fleet.context_offer",
        requestId,
        digest,
        chars: text.length,
      };
      if (peerHint && peerHint.workerId !== workerId) {
        // The ticket is minted under the SERVING worker's derived secret so
        // the receiving worker can present it but never forge or reuse it
        // for another digest, requester, server, or after expiry.
        const serving = this.requireWorker(validateIdentifier(peerHint.workerId, "workerId"));
        const endpoint = assertPrivateEndpoint(peerHint.endpoint.url);
        const ticketExpiresAt = new Date(this.now().getTime() + CONTEXT_TICKET_TTL_MS).toISOString();
        request.peer = {
          workerId: serving.snapshot.workerId,
          endpoint,
          ticket: signMac(serving.secret, contextTicketPayload(digest, workerId, serving.snapshot.workerId, ticketExpiresAt)),
          ticketExpiresAt,
        };
      } else {
        request.text = text;
      }
    } catch {
      return { workerId, requestId, status: "rejected" };
    }
    try {
      const response = parseContextOfferResponse(
        await this.authenticatedRequest(record, "POST", CONTEXT_OFFER_PATH, request),
        workerId,
        requestId,
      );
      return { workerId, requestId, status: response.status };
    } catch (error) {
      const status: HomeFleetContextOfferResult["status"] = error instanceof HomeFleetError && error.code === "AUTHENTICATION_FAILED"
        ? "unauthorized"
        : error instanceof HomeFleetError && (error.code === "INVALID_MESSAGE" || error.code === "REQUEST_REJECTED")
          ? "rejected"
          : "unreachable";
      return { workerId, requestId, status };
    }
  }

  private async reviewOne(workerId: string, text: string, prefixDigest?: string): Promise<HomeFleetReviewResult> {
    const requestId = randomUUID();
    let record: RegisteredWorker;
    try {
      record = this.requireWorker(workerId);
    } catch {
      return { workerId, requestId, status: "rejected" };
    }
    const request: HomeFleetReviewRequest = {
      protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
      type: "home_fleet.review",
      requestId,
      text,
      ...(prefixDigest ? { prefixDigest } : {}),
    };
    try {
      const response = parseReviewResponse(
        await this.authenticatedRequest(record, "POST", REVIEW_PATH, request),
        workerId,
        requestId,
      );
      record.snapshot.status = "healthy";
      record.snapshot.lastCheckedAt = this.now().toISOString();
      return { workerId, requestId, status: "ok", summary: response.summary };
    } catch (error) {
      const status: HomeFleetReviewResult["status"] = error instanceof HomeFleetError && error.code === "AUTHENTICATION_FAILED"
        ? "unauthorized"
        : error instanceof HomeFleetError && (error.code === "REVIEW_BUSY" || error.code === "REVIEW_UNAVAILABLE" || error.code === "REQUEST_REJECTED")
          ? "rejected"
          : "unreachable";
      record.snapshot.status = status === "unauthorized" ? "unauthorized" : "unreachable";
      record.snapshot.lastCheckedAt = this.now().toISOString();
      return { workerId, requestId, status };
    }
  }

  private async authenticatedRequest(
    record: RegisteredWorker,
    method: "GET" | "POST",
    path: string,
    body?: HomeFleetReviewRequest | HomeFleetContextOfferRequest,
  ): Promise<unknown> {
    // Revalidate the stored endpoint before every fetch so a corrupted state
    // object cannot turn this manager into an SSRF primitive.
    const endpoint = assertPrivateEndpoint(record.snapshot.endpoint.url);
    const coordinatorEndpoint = this.endpoint;
    if (!coordinatorEndpoint) {
      throw new HomeFleetError("REQUEST_REJECTED", "The private coordinator listener is not running.");
    }
    const requestNonce = randomUUID();
    const timestamp = this.now().toISOString();
    const serializedBody = body ? JSON.stringify(body) : "";
    const signature = signMac(record.secret, signedRequestPayload({
      method,
      path,
      coordinatorId: this.coordinatorId,
      coordinatorEndpoint: coordinatorEndpoint.url,
      timestamp,
      nonce: requestNonce,
      body: serializedBody,
    }));
    const response = await fetch(`${endpoint.url}${path}`, {
      method,
      redirect: "error",
      headers: {
        "accept": "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        "x-home-fleet-version": String(HOME_FLEET_PROTOCOL_VERSION),
        "x-home-fleet-coordinator-id": this.coordinatorId,
        "x-home-fleet-coordinator-endpoint": coordinatorEndpoint.url,
        "x-home-fleet-timestamp": timestamp,
        "x-home-fleet-nonce": requestNonce,
        "x-home-fleet-signature": signature,
      },
      ...(body ? { body: serializedBody } : {}),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    const responseText = await boundedResponseText(response);
    if (!response.ok) throw decodeRemoteError(response.status, responseText);
    const responseTimestamp = response.headers.get("x-home-fleet-timestamp");
    const responseNonce = response.headers.get("x-home-fleet-request-nonce");
    const responseSignature = response.headers.get("x-home-fleet-signature");
    if (!responseTimestamp || !responseNonce || !responseSignature || responseNonce !== requestNonce) {
      throw new HomeFleetError("AUTHENTICATION_FAILED", "Worker response did not include a valid authenticated request nonce.");
    }
    if (!isTimestampFresh(responseTimestamp, this.now())) {
      throw new HomeFleetError("AUTHENTICATION_FAILED", "Worker response timestamp is outside the allowed window.");
    }
    if (!verifyMac(record.secret, signedResponsePayload({
      status: response.status,
      timestamp: responseTimestamp,
      requestNonce,
      body: responseText,
    }), responseSignature)) {
      throw new HomeFleetError("AUTHENTICATION_FAILED", "Worker response signature is invalid.");
    }
    return parseJson(responseText);
  }

  private requireWorker(workerId: string): RegisteredWorker {
    const record = this.workers.get(workerId);
    if (!record) throw new HomeFleetError("WORKER_UNKNOWN", "The requested home-fleet worker is not paired.");
    return record;
  }

  private purgeExpiredInvitations(now: number): void {
    for (const [id, invitation] of this.invitations) {
      if (invitation.expiresAt <= now) this.invitations.delete(id);
    }
  }

  private async handleRegistrationHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = requestUrlPath(request);
    if (request.method !== "POST" || (path !== REGISTER_PATH && path !== HEARTBEAT_PATH)) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    const sourceAddress = request.socket.remoteAddress ?? "";
    if (!normalizePrivateAddress(sourceAddress)) {
      sendJson(response, 403, { error: "private_lan_required" });
      return;
    }
    try {
      const value = await readJsonBody(request);
      if (path === REGISTER_PATH) {
        const registered = this.acceptRegistration(value, sourceAddress);
        await this.flushWorkerChangePersistence();
        sendJson(response, 201, registered);
        return;
      }
      const heartbeat = this.acceptHeartbeat(value, sourceAddress);
      await this.flushWorkerChangePersistence();
      sendJson(response, 200, heartbeat);
    } catch (error) {
      sendJson(response, statusForError(error), publicErrorBody(error));
    }
  }
}

/**
 * LAN worker server. It exposes only authenticated health, capabilities, and
 * a fixed bounded review operation. It cannot receive a shell command, model
 * URL/tag, model-pull request, or a public-tunnel connection through this API.
 */
export class HomeFleetWorker {
  public readonly workerId: string;
  private readonly label: string;
  private readonly configuredHost: string;
  private readonly configuredPort: number;
  private readonly reviewHandler: HomeFleetReviewHandler | undefined;
  private readonly onCoordinatorChanged: (() => void) | undefined;
  private readonly contextWarmer: ((bundle: { digest: string; text: string }) => Promise<boolean>) | undefined;
  private readonly now: () => Date;
  private readonly capabilities: HomeFleetWorkerCapabilities;
  private readonly replayWindow = new ReplayWindow();
  /** Nonce window for P2P fetches served under coordinator-minted tickets. */
  private readonly contextFetchReplayWindow = new ReplayWindow();
  /** Digest-keyed LRU of verified bundle text; bounded and never persisted. */
  private readonly contextBundles = new Map<string, string>();
  private server: Server | undefined;
  private endpoint: HomeFleetEndpoint | undefined;
  private coordinator: WorkerCoordinatorSession | undefined;
  private reviewInFlight = false;
  /**
   * True while an owner rename still needs to reach the coordinator. The
   * label rides the signed heartbeat until one acknowledgement proves it
   * landed; against a coordinator too old to know the field, the next beat
   * falls back to the legacy payload so a rename can never strand a worker.
   */
  private advertiseLabelUpdate = false;

  public constructor(options: HomeFleetWorkerOptions) {
    this.workerId = validateIdentifier(options.workerId ?? randomUUID(), "workerId");
    this.label = validateLabel(options.label);
    this.advertiseLabelUpdate = options.advertiseLabelUpdate ?? false;
    this.configuredHost = assertPrivateBindHost(options.host ?? "127.0.0.1");
    this.configuredPort = assertListenPort(options.port ?? 0);
    this.reviewHandler = options.review;
    this.onCoordinatorChanged = options.onCoordinatorChanged;
    this.contextWarmer = options.contextWarmer;
    this.now = options.now ?? (() => new Date());
    this.capabilities = {
      protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
      roles: ["review"],
      installedModels: normalizeInstalledModels(options.installedModels ?? []),
      maxConcurrentReviews: 1,
      acceptsArbitraryCommands: false,
      permitsModelPulls: false,
    };
  }

  public async listen(): Promise<HomeFleetEndpoint> {
    if (this.server && this.endpoint) return clone(this.endpoint);
    const server = createServer((request, response) => {
      void this.handleWorkerHttp(request, response);
    });
    await listenServer(server, this.configuredHost, this.configuredPort);
    const address = server.address();
    if (!address || typeof address === "string") {
      await closeServer(server);
      throw new HomeFleetError("REQUEST_REJECTED", "The private worker listener did not return a TCP address.");
    }
    this.server = server;
    this.endpoint = endpointFor(this.configuredHost, address.port);
    return clone(this.endpoint);
  }

  public async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.endpoint = undefined;
    if (server) await closeServer(server);
  }

  /** Joins an already-running private coordinator using one explicit invitation. */
  public async join(invitation: HomeFleetJoinInvitation): Promise<HomeFleetRegistrationResponse> {
    if (!this.endpoint) throw new HomeFleetError("REQUEST_REJECTED", "Start the private worker listener before joining a coordinator.");
    const safeInvitation = parseJoinInvitation(invitation);
    if (new Date(safeInvitation.expiresAt).getTime() <= this.now().getTime()) {
      throw new HomeFleetError("JOIN_TOKEN_EXPIRED", "The coordinator invitation has expired.");
    }
    const request: HomeFleetRegistrationRequest = {
      protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
      type: "home_fleet.register",
      invitationId: safeInvitation.invitationId,
      coordinatorId: safeInvitation.coordinatorId,
      worker: {
        workerId: this.workerId,
        label: this.label,
        endpoint: clone(this.endpoint),
      },
      nonce: randomUUID(),
      proof: "",
    };
    const token = tokenBuffer(safeInvitation.joinToken);
    request.proof = signMac(token, registrationPayload(request));
    if (this.coordinator?.coordinatorId === safeInvitation.coordinatorId) {
      // A fresh owner-issued invitation can repair an existing slot only when
      // this worker proves it still owns the prior derived session. The proof
      // is intentionally bound to this exact registration payload, including
      // the new endpoint and nonce, so it cannot be replayed as a command.
      request.recoveryProof = signMac(this.coordinator.secret, registrationRecoveryPayload(request));
    }
    const response = await fetch(`${safeInvitation.coordinator.url}${REGISTER_PATH}`, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
    });
    const responseText = await boundedResponseText(response);
    if (!response.ok) throw decodeRemoteError(response.status, responseText);
    const registered = parseRegistrationResponse(parseJson(responseText));
    if (
      registered.invitationId !== safeInvitation.invitationId ||
      registered.coordinatorId !== safeInvitation.coordinatorId ||
      registered.workerId !== this.workerId
    ) {
      throw new HomeFleetError("AUTHENTICATION_FAILED", "Coordinator registration response does not match this invitation and worker.");
    }
    const secret = deriveWorkerSecret(token, this.workerId);
    if (!verifyMac(secret, registrationResponsePayload(registered), registered.proof)) {
      throw new HomeFleetError("AUTHENTICATION_FAILED", "Coordinator registration response proof is invalid.");
    }
    this.coordinator = {
      coordinatorId: safeInvitation.coordinatorId,
      endpoint: clone(safeInvitation.coordinator),
      secret,
    };
    this.notifyCoordinatorChanged();
    return registered;
  }

  /** Convenience boundary for a future `worker --join '<json>'` CLI command. */
  public async joinSerializedInvitation(payload: string): Promise<HomeFleetRegistrationResponse> {
    return this.join(parseSerializedJoinInvitation(payload));
  }

  /**
   * Sends a bounded, signed heartbeat to the durable coordinator session.
   * A failed heartbeat never clears the local secret or stops the worker: an
   * unauthenticated LAN response must not be able to force a re-pair. Callers
   * may retry with backoff; a successful acknowledgement can safely replace a
   * moved coordinator endpoint because it is HMAC-authenticated by the current
   * derived session and tied to this request nonce.
   */
  public async heartbeat(): Promise<HomeFleetHeartbeatResult> {
    if (!this.endpoint || !this.coordinator) return { status: "unpaired" };
    const session = this.coordinator;
    const timestamp = this.now().toISOString();
    const nonce = randomUUID();
    // Held digests are advertised on every heartbeat so cache-aware routing
    // survives coordinator restarts without any bundle text re-crossing the
    // LAN. When nothing is held the field is omitted entirely, keeping the
    // wire bytes and signature identical to a pre-context-sharing worker.
    const cachedPrefixes = [...this.contextBundles.keys()].slice(-MAX_CACHED_PREFIXES);
    const request: HomeFleetHeartbeatRequest = {
      protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
      type: "home_fleet.heartbeat",
      workerId: this.workerId,
      endpoint: clone(this.endpoint),
      timestamp,
      nonce,
      ...(cachedPrefixes.length ? { cachedPrefixes } : {}),
      // A rename is advertised only until one coordinator acknowledges it.
      // Like cachedPrefixes, the optional field enters the HMAC only when
      // present, so an unrenamed worker signs bytes identical to older
      // builds and interop is preserved.
      ...(this.advertiseLabelUpdate ? { label: this.label } : {}),
      proof: "",
    };
    request.proof = signMac(session.secret, heartbeatRequestPayload(request));
    try {
      const response = await fetch(`${session.endpoint.url}${HEARTBEAT_PATH}`, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
      });
      const responseText = await boundedResponseText(response);
      if (!response.ok) {
        const remoteError = decodeRemoteError(response.status, responseText);
        if (remoteError.code === "AUTHENTICATION_FAILED" && this.advertiseLabelUpdate) {
          // A coordinator that predates rename advertisements verifies the
          // MAC over a payload without the label and rejects this beat. Keep
          // the local name, stop advertising, and retry legacy-shaped so the
          // pairing itself is never sacrificed to a cosmetic rename.
          this.advertiseLabelUpdate = false;
          return this.heartbeat();
        }
        return { status: remoteError.code === "AUTHENTICATION_FAILED" ? "unauthorized" : "unreachable" };
      }
      const acknowledged = parseHeartbeatResponse(parseJson(responseText));
      if (
        acknowledged.coordinatorId !== session.coordinatorId ||
        acknowledged.workerId !== this.workerId ||
        acknowledged.requestNonce !== nonce ||
        !isTimestampFresh(acknowledged.at, this.now()) ||
        !verifyMac(session.secret, heartbeatResponsePayload(acknowledged), acknowledged.proof)
      ) {
        return { status: "unauthorized" };
      }
      // The acknowledgement proves a coordinator verified the full signed
      // payload — including the advertised rename. Stop repeating it.
      this.advertiseLabelUpdate = false;
      if (!sameEndpoint(session.endpoint, acknowledged.coordinator)) {
        // Only a valid acknowledgement under the retained session may move a
        // coordinator target. This does not accept hostnames or public routes.
        this.coordinator = { ...session, endpoint: clone(acknowledged.coordinator) };
        this.notifyCoordinatorChanged();
      }
      return { status: "ok", coordinator: clone(acknowledged.coordinator) };
    } catch (error) {
      if (error instanceof HomeFleetError && error.code === "AUTHENTICATION_FAILED") return { status: "unauthorized" };
      return { status: "unreachable" };
    }
  }

  /** Secret-free worker state intended for an owner-local UI or CLI. */
  public snapshot(): {
    protocolVersion: typeof HOME_FLEET_PROTOCOL_VERSION;
    role: "worker";
    workerId: string;
    label: string;
    endpoint?: HomeFleetEndpoint;
    coordinatorId?: string;
    capabilities: HomeFleetWorkerCapabilities;
  } {
    return {
      protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
      role: "worker",
      workerId: this.workerId,
      label: this.label,
      ...(this.endpoint ? { endpoint: clone(this.endpoint) } : {}),
      ...(this.coordinator ? { coordinatorId: this.coordinator.coordinatorId } : {}),
      capabilities: clone(this.capabilities),
    };
  }

  /**
   * Export durable pairing material only. The owner-local caller is responsible
   * for a `0600` storage path; no invitation token or model configuration is
   * included here.
   */
  public exportPrivateState(): HomeFleetWorkerPrivateState {
    return {
      version: HOME_FLEET_PROTOCOL_VERSION,
      role: "worker",
      workerId: this.workerId,
      ...(this.coordinator ? {
        coordinator: {
          coordinatorId: this.coordinator.coordinatorId,
          endpoint: clone(this.coordinator.endpoint),
          secret: this.coordinator.secret.toString("base64url"),
        },
      } : {}),
    };
  }

  /** Restores a previously authenticated coordinator for this same worker identity. */
  public importPrivateState(value: unknown): void {
    const state = parseHomeFleetWorkerPrivateState(value);
    if (state.workerId !== this.workerId) {
      throw new HomeFleetError("INVALID_MESSAGE", "Worker private state belongs to a different worker identity.");
    }
    this.coordinator = state.coordinator
      ? {
        coordinatorId: state.coordinator.coordinatorId,
        endpoint: clone(state.coordinator.endpoint),
        secret: decodeSecret(state.coordinator.secret),
      }
      : undefined;
  }

  /** Creates a worker with a restored identity/session; local review code stays owner-supplied. */
  public static fromPrivateState(
    options: Omit<HomeFleetWorkerOptions, "workerId">,
    value: unknown,
  ): HomeFleetWorker {
    const state = parseHomeFleetWorkerPrivateState(value);
    const worker = new HomeFleetWorker({ ...options, workerId: state.workerId });
    worker.importPrivateState(state);
    return worker;
  }

  private async handleWorkerHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const sourceAddress = normalizePrivateAddress(request.socket.remoteAddress ?? "");
    if (!sourceAddress) {
      sendJson(response, 403, { error: "private_lan_required" });
      return;
    }
    if (!this.coordinator) {
      sendJson(response, 401, { error: "coordinator_not_paired" });
      return;
    }
    try {
      const path = requestUrlPath(request);
      const method = request.method ?? "";
      const bodyLimit = path === CONTEXT_OFFER_PATH || path === CONTEXT_FETCH_PATH ? MAX_CONTEXT_JSON_BYTES : MAX_JSON_BYTES;
      const serializedBody = method === "POST" ? await readRawBody(request, bodyLimit) : "";
      if (method === "POST" && path === CONTEXT_FETCH_PATH) {
        // Peer fetches are worker-to-worker: they carry a coordinator-minted
        // ticket instead of coordinator request headers, so they are handled
        // before (not through) the coordinator HMAC gate.
        this.handleContextFetch(response, parseJson(serializedBody));
        return;
      }
      const authenticated = this.authenticateCoordinatorRequest(request, method, path, serializedBody, sourceAddress);
      if (method === "POST" && path === CONTEXT_OFFER_PATH) {
        const offer = parseContextOfferRequest(parseJson(serializedBody));
        const status = await this.acceptContextOffer(offer);
        this.sendSigned(response, 200, authenticated.requestNonce, {
          protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
          type: "home_fleet.context_offer_result",
          workerId: this.workerId,
          requestId: offer.requestId,
          status,
        } satisfies HomeFleetContextOfferResponse);
        return;
      }
      if (method === "GET" && path === HEALTH_PATH) {
        this.sendSigned(response, 200, authenticated.requestNonce, {
          protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
          type: "home_fleet.health",
          workerId: this.workerId,
          health: { status: "ready", at: this.now().toISOString() },
        } satisfies HomeFleetHealthResponse);
        return;
      }
      if (method === "GET" && path === CAPABILITIES_PATH) {
        this.sendSigned(response, 200, authenticated.requestNonce, {
          protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
          type: "home_fleet.capabilities",
          workerId: this.workerId,
          capabilities: clone(this.capabilities),
        } satisfies HomeFleetCapabilitiesResponse);
        return;
      }
      if (method === "POST" && path === REVIEW_PATH) {
        const review = parseReviewRequest(parseJson(serializedBody));
        if (this.reviewInFlight) throw new HomeFleetError("REVIEW_BUSY", "This worker already has one local review in progress.");
        if (!this.reviewHandler) throw new HomeFleetError("REVIEW_UNAVAILABLE", "This worker has no local review handler configured.");
        this.reviewInFlight = true;
        try {
          // The callback is configured by the worker owner. This module never
          // spawns commands or pulls models; it supplies only the fixed text
          // plus, when the routing hint matches a locally verified bundle,
          // that bundle's exact text. An unknown digest reviews without a
          // prefix rather than failing: cache state never blocks a review.
          const prefixText = review.prefixDigest ? this.touchContextBundle(review.prefixDigest) : undefined;
          const localResult = await this.reviewHandler({
            requestId: review.requestId,
            text: review.text,
            ...(prefixText !== undefined ? { prefixText } : {}),
          });
          const summary = validateReviewSummary(localResult?.summary);
          this.sendSigned(response, 200, authenticated.requestNonce, {
            protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
            type: "home_fleet.review_result",
            workerId: this.workerId,
            requestId: review.requestId,
            summary,
          } satisfies HomeFleetReviewResponse);
        } finally {
          this.reviewInFlight = false;
        }
        return;
      }
      throw new HomeFleetError("REQUEST_REJECTED", "This worker exposes only fixed health, capabilities, and review endpoints.");
    } catch (error) {
      sendJson(response, statusForError(error), publicErrorBody(error));
    }
  }

  private authenticateCoordinatorRequest(
    request: IncomingMessage,
    method: string,
    path: string,
    body: string,
    sourceAddress: string,
  ): AuthenticatedRequest {
    if (!this.coordinator) throw new HomeFleetError("AUTHENTICATION_FAILED", "No coordinator is paired with this worker.");
    const version = request.headers["x-home-fleet-version"];
    const coordinatorId = request.headers["x-home-fleet-coordinator-id"];
    const coordinatorEndpointHeader = request.headers["x-home-fleet-coordinator-endpoint"];
    const timestamp = request.headers["x-home-fleet-timestamp"];
    const nonce = request.headers["x-home-fleet-nonce"];
    const signature = request.headers["x-home-fleet-signature"];
    if (
      version !== String(HOME_FLEET_PROTOCOL_VERSION) ||
      typeof coordinatorId !== "string" || coordinatorId !== this.coordinator.coordinatorId ||
      typeof coordinatorEndpointHeader !== "string" ||
      typeof timestamp !== "string" ||
      typeof nonce !== "string" ||
      typeof signature !== "string"
    ) {
      throw new HomeFleetError("AUTHENTICATION_FAILED", "Coordinator authentication headers are incomplete or invalid.");
    }
    const coordinatorEndpoint = parseEndpointHeader(coordinatorEndpointHeader, "Coordinator endpoint header is invalid.");
    if (coordinatorEndpoint.host !== sourceAddress) {
      throw new HomeFleetError("AUTHENTICATION_FAILED", "Coordinator endpoint does not match the private TCP source address.");
    }
    if (!isTimestampFresh(timestamp, this.now())) throw new HomeFleetError("AUTHENTICATION_FAILED", "Coordinator request timestamp is outside the allowed window.");
    if (!isUuidLike(nonce)) throw new HomeFleetError("AUTHENTICATION_FAILED", "Coordinator request nonce is invalid.");
    if (this.replayWindow.has(nonce, this.now().getTime())) throw new HomeFleetError("REPLAY_REJECTED", "A coordinator request nonce was replayed.");
    if (!verifyMac(this.coordinator.secret, signedRequestPayload({ method, path, coordinatorId, coordinatorEndpoint: coordinatorEndpoint.url, timestamp, nonce, body }), signature)) {
      throw new HomeFleetError("AUTHENTICATION_FAILED", "Coordinator request signature is invalid.");
    }
    this.replayWindow.add(nonce, this.now().getTime());
    if (!sameEndpoint(this.coordinator.endpoint, coordinatorEndpoint)) {
      // A signed inbound probe is the recovery path after the coordinator's
      // DHCP address/port changes. It cannot be triggered by an unauthenticated
      // host because the endpoint header is included in the HMAC payload.
      this.coordinator = { ...this.coordinator, endpoint: clone(coordinatorEndpoint) };
      this.notifyCoordinatorChanged();
    }
    return { requestNonce: nonce };
  }

  /**
   * Accepts one signed coordinator offer. A digest already held answers
   * "cached" without any transfer; otherwise the text arrives inline or via
   * a ticketed peer fetch, and either route must re-hash to the offered
   * digest before the worker will store or warm anything.
   */
  private async acceptContextOffer(offer: HomeFleetContextOfferRequest): Promise<HomeFleetContextOfferResponse["status"]> {
    if (this.touchContextBundle(offer.digest) !== undefined) return "cached";
    let text: string | undefined;
    if (offer.text !== undefined) {
      if (sha256Hex(offer.text) !== offer.digest) {
        throw new HomeFleetError("REQUEST_REJECTED", "Inline context bundle text does not match its digest.");
      }
      text = offer.text;
    } else if (offer.peer) {
      text = await this.fetchContextFromPeer(offer.digest, offer.peer);
    }
    if (text === undefined) return "failed";
    this.storeContextBundle(offer.digest, text);
    if (!this.contextWarmer) return "cached";
    // Warming can take far longer than the coordinator's bounded HTTP window
    // (a small laptop cold-loading its model can need minutes), so it runs
    // detached: the offer acknowledges "cached" immediately, and the warm
    // state reaches the coordinator through the next signed heartbeat's
    // cachedPrefixes advertisement instead of this response.
    const warmer = this.contextWarmer;
    void Promise.resolve()
      .then(() => warmer({ digest: offer.digest, text }))
      .catch(() => undefined);
    return "cached";
  }

  /**
   * P2P CPU-memory transfer: pull the bundle body from a warm peer worker so
   * the coordinator never re-sends large text. The peer endpoint passes the
   * same private-LAN validation as every other endpoint in this module, and
   * the received text is accepted only if it re-hashes to the offered digest
   * (content addressing, exactly like LMCache chunk hashes).
   */
  private async fetchContextFromPeer(digest: string, peer: HomeFleetContextPeerHint): Promise<string | undefined> {
    try {
      const endpoint = assertPrivateEndpoint(peer.endpoint.url);
      const request: HomeFleetContextFetchRequest = {
        protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
        type: "home_fleet.context_fetch",
        digest,
        requesterWorkerId: this.workerId,
        ticket: peer.ticket,
        ticketExpiresAt: peer.ticketExpiresAt,
        nonce: randomUUID(),
      };
      const response = await fetch(`${endpoint.url}${CONTEXT_FETCH_PATH}`, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
      });
      const responseText = await boundedResponseText(response, MAX_CONTEXT_JSON_BYTES);
      if (!response.ok) return undefined;
      const fetched = parseContextFetchResponse(parseJson(responseText));
      if (fetched.digest !== digest || sha256Hex(fetched.text) !== digest) return undefined;
      return fetched.text;
    } catch {
      // A missing/slow peer degrades to a "failed" offer; the coordinator
      // simply falls back to prompt-only or an inline re-seed. No review is
      // ever blocked by peer cache state.
      return undefined;
    }
  }

  /**
   * Serves one held bundle to a peer that presents a coordinator-minted
   * ticket. The ticket HMAC is keyed with this worker's own derived secret,
   * binds digest + requester + this worker + expiry, and proves the transfer
   * was authorized by the coordinator: the requesting peer alone can never
   * mint one, and an expired or foreign ticket is rejected before any text
   * leaves this process.
   */
  private handleContextFetch(response: ServerResponse, value: unknown): void {
    const session = this.coordinator;
    if (!session) {
      sendJson(response, 401, { error: "coordinator_not_paired" });
      return;
    }
    const request = parseContextFetchRequest(value);
    const now = this.now();
    const expiresAt = new Date(request.ticketExpiresAt).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime() || expiresAt > now.getTime() + 15 * 60_000) {
      throw new HomeFleetError("AUTHENTICATION_FAILED", "Context transfer ticket is expired or not yet valid.");
    }
    // Replay protection keys on the TICKET, not the requester-chosen nonce:
    // a nonce is free to mint, so keying on it would let anyone who observed
    // the plaintext LAN offer redeem the same ticket repeatedly until expiry.
    // One ticket authorizes exactly one transfer: the redeemed ticket is
    // remembered until its own expiry (below), so — unlike a fixed-window
    // dedup — it can never be purged while still redeemable.
    if (!isUuidLike(request.nonce)) {
      throw new HomeFleetError("REPLAY_REJECTED", "A context transfer nonce is invalid.");
    }
    if (this.contextFetchReplayWindow.has(request.ticket, now.getTime())) {
      throw new HomeFleetError("REPLAY_REJECTED", "A context transfer ticket was already redeemed.");
    }
    if (!verifyMac(session.secret, contextTicketPayload(request.digest, request.requesterWorkerId, this.workerId, request.ticketExpiresAt), request.ticket)) {
      throw new HomeFleetError("AUTHENTICATION_FAILED", "Context transfer ticket is invalid.");
    }
    this.contextFetchReplayWindow.add(request.ticket, now.getTime(), expiresAt);
    const text = this.touchContextBundle(request.digest);
    if (text === undefined) {
      throw new HomeFleetError("REQUEST_REJECTED", "This worker does not hold the requested context bundle.");
    }
    sendJson(response, 200, {
      protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
      type: "home_fleet.context_fetched",
      digest: request.digest,
      text,
    } satisfies HomeFleetContextFetchResponse);
  }

  /** Reads a held bundle and refreshes its LRU position. */
  private touchContextBundle(digest: string): string | undefined {
    const text = this.contextBundles.get(digest);
    if (text === undefined) return undefined;
    this.contextBundles.delete(digest);
    this.contextBundles.set(digest, text);
    return text;
  }

  private storeContextBundle(digest: string, text: string): void {
    this.contextBundles.delete(digest);
    this.contextBundles.set(digest, text);
    while (this.contextBundles.size > MAX_WORKER_CONTEXT_BUNDLES) {
      this.contextBundles.delete(this.contextBundles.keys().next().value!);
    }
  }

  private notifyCoordinatorChanged(): void {
    try {
      this.onCoordinatorChanged?.();
    } catch {
      // Persistence/UI callbacks must never break an authenticated response
      // path or make a paired worker stop serving its fixed review role.
    }
  }

  private sendSigned(response: ServerResponse, status: number, requestNonce: string, value: HomeFleetHealthResponse | HomeFleetCapabilitiesResponse | HomeFleetReviewResponse | HomeFleetContextOfferResponse): void {
    if (!this.coordinator) {
      sendJson(response, 401, { error: "coordinator_not_paired" });
      return;
    }
    const body = JSON.stringify(value);
    const timestamp = this.now().toISOString();
    const signature = signMac(this.coordinator.secret, signedResponsePayload({ status, timestamp, requestNonce, body }));
    response.statusCode = status;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-home-fleet-timestamp", timestamp);
    response.setHeader("x-home-fleet-request-nonce", requestNonce);
    response.setHeader("x-home-fleet-signature", signature);
    response.end(body);
  }
}

/** True only for RFC1918 IPv4 ranges and literal loopback addresses. */
export function isPrivateLanAddress(value: string): boolean {
  return normalizePrivateAddress(value) !== null;
}

/**
 * Produces a quote-free base64url token for a future human command such as:
 * `npx omnibus-bridge worker --join <payload>`.
 *
 * The payload contains no callback command or arbitrary URL; its only network
 * field is the coordinator's already-validated private LAN endpoint.
 */
export function serializeHomeFleetJoinInvitation(invitation: HomeFleetJoinInvitation): string {
  return Buffer.from(JSON.stringify(parseJoinInvitation(invitation)), "utf8").toString("base64url");
}

/** Validates a base64url manual/QR join payload without starting a worker. */
export function parseSerializedJoinInvitation(payload: string): HomeFleetJoinInvitation {
  if (!/^[A-Za-z0-9_-]{16,65536}$/.test(payload) || payload.length > MAX_JSON_BYTES * 2) {
    throw new HomeFleetError("INVALID_MESSAGE", "Join payload is not a bounded base64url token.");
  }
  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    if (Buffer.byteLength(decoded, "utf8") > MAX_JSON_BYTES) throw new HomeFleetError("INVALID_MESSAGE", "Join payload is too large.");
    return parseJoinInvitation(JSON.parse(decoded));
  } catch (error) {
    if (error instanceof HomeFleetError) throw error;
    throw new HomeFleetError("INVALID_MESSAGE", "Join payload is not valid JSON.");
  }
}

/** Validates a sensitive coordinator state object before an owner-local restore. */
export function parseHomeFleetCoordinatorPrivateState(value: unknown): HomeFleetCoordinatorPrivateState {
  const object = objectRecord(value);
  if (object.version !== HOME_FLEET_PROTOCOL_VERSION || object.role !== "coordinator" || !Array.isArray(object.workers)) {
    throw new HomeFleetError("INVALID_MESSAGE", "Coordinator private state is invalid.");
  }
  if (object.workers.length > 128) throw new HomeFleetError("INVALID_MESSAGE", "Coordinator private state has too many workers.");
  const seen = new Set<string>();
  const workers = object.workers.map(item => {
    const worker = objectRecord(item);
    const workerId = validateIdentifier(worker.workerId, "workerId");
    if (seen.has(workerId)) throw new HomeFleetError("INVALID_MESSAGE", "Coordinator private state contains a duplicate worker.");
    seen.add(workerId);
    const secret = validatePrivateSecret(worker.secret);
    return {
      workerId,
      label: validateLabel(worker.label),
      endpoint: parseEndpoint(worker.endpoint),
      registeredAt: validateIsoTimestamp(worker.registeredAt, "registeredAt"),
      secret,
    };
  });
  return {
    version: HOME_FLEET_PROTOCOL_VERSION,
    role: "coordinator",
    coordinatorId: validateIdentifier(object.coordinatorId, "coordinatorId"),
    workers,
  };
}

/** Validates a sensitive worker state object before an owner-local restore. */
export function parseHomeFleetWorkerPrivateState(value: unknown): HomeFleetWorkerPrivateState {
  const object = objectRecord(value);
  if (object.version !== HOME_FLEET_PROTOCOL_VERSION || object.role !== "worker") {
    throw new HomeFleetError("INVALID_MESSAGE", "Worker private state is invalid.");
  }
  let coordinator: HomeFleetWorkerPrivateState["coordinator"];
  if (object.coordinator !== undefined) {
    const stored = objectRecord(object.coordinator);
    coordinator = {
      coordinatorId: validateIdentifier(stored.coordinatorId, "coordinatorId"),
      endpoint: parseEndpoint(stored.endpoint),
      secret: validatePrivateSecret(stored.secret),
    };
  }
  return {
    version: HOME_FLEET_PROTOCOL_VERSION,
    role: "worker",
    workerId: validateIdentifier(object.workerId, "workerId"),
    ...(coordinator ? { coordinator } : {}),
  };
}

function parseJoinInvitation(value: unknown): HomeFleetJoinInvitation {
  const object = objectRecord(value);
  if (object.protocolVersion !== HOME_FLEET_PROTOCOL_VERSION || object.type !== "home_fleet.join") {
    throw new HomeFleetError("INVALID_MESSAGE", "Join invitation protocol version or type is invalid.");
  }
  const invitationId = validateIdentifier(object.invitationId, "invitationId");
  const joinToken = validateToken(object.joinToken);
  const coordinatorId = validateIdentifier(object.coordinatorId, "coordinatorId");
  const coordinator = parseEndpoint(object.coordinator);
  const issuedAt = validateIsoTimestamp(object.issuedAt, "issuedAt");
  const expiresAt = validateIsoTimestamp(object.expiresAt, "expiresAt");
  if (new Date(expiresAt).getTime() <= new Date(issuedAt).getTime()) throw new HomeFleetError("INVALID_MESSAGE", "Join invitation expiry is invalid.");
  return { protocolVersion: HOME_FLEET_PROTOCOL_VERSION, type: "home_fleet.join", invitationId, joinToken, coordinatorId, coordinator, issuedAt, expiresAt };
}

function parseRegistrationRequest(value: unknown): HomeFleetRegistrationRequest {
  const object = objectRecord(value);
  if (object.protocolVersion !== HOME_FLEET_PROTOCOL_VERSION || object.type !== "home_fleet.register") {
    throw new HomeFleetError("INVALID_MESSAGE", "Registration protocol version or type is invalid.");
  }
  const worker = objectRecord(object.worker);
  const request: HomeFleetRegistrationRequest = {
    protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
    type: "home_fleet.register",
    invitationId: validateIdentifier(object.invitationId, "invitationId"),
    coordinatorId: validateIdentifier(object.coordinatorId, "coordinatorId"),
    worker: {
      workerId: validateIdentifier(worker.workerId, "workerId"),
      label: validateLabel(worker.label),
      endpoint: parseEndpoint(worker.endpoint),
    },
    nonce: validateIdentifier(object.nonce, "nonce"),
    proof: validateProof(object.proof),
    ...(object.recoveryProof === undefined ? {} : { recoveryProof: validateProof(object.recoveryProof) }),
  };
  return request;
}

function parseRegistrationResponse(value: unknown): HomeFleetRegistrationResponse {
  const object = objectRecord(value);
  if (object.protocolVersion !== HOME_FLEET_PROTOCOL_VERSION || object.type !== "home_fleet.registered") {
    throw new HomeFleetError("INVALID_MESSAGE", "Registration response protocol version or type is invalid.");
  }
  return {
    protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
    type: "home_fleet.registered",
    invitationId: validateIdentifier(object.invitationId, "invitationId"),
    coordinatorId: validateIdentifier(object.coordinatorId, "coordinatorId"),
    workerId: validateIdentifier(object.workerId, "workerId"),
    registeredAt: validateIsoTimestamp(object.registeredAt, "registeredAt"),
    proof: validateProof(object.proof),
  };
}

function parseHeartbeatRequest(value: unknown): HomeFleetHeartbeatRequest {
  const object = objectRecord(value);
  if (object.protocolVersion !== HOME_FLEET_PROTOCOL_VERSION || object.type !== "home_fleet.heartbeat") {
    throw new HomeFleetError("INVALID_MESSAGE", "Worker heartbeat protocol version or type is invalid.");
  }
  // The advertisement is carried RAW (bounded only against abuse) so the
  // HMAC is verified over exactly what the worker signed. Strict digest
  // filtering happens after signature verification in acceptHeartbeat —
  // otherwise silently dropping one entry here would change the signed
  // payload and fail an honest worker's whole heartbeat.
  const cachedPrefixes = rawCachedPrefixes(object.cachedPrefixes);
  // Like cachedPrefixes, an advertised rename is carried RAW (bounded only
  // against abuse) so the MAC verifies what the worker signed; display
  // sanitation happens after verification in acceptHeartbeat.
  const label = typeof object.label === "string" && object.label.length > 0 && object.label.length <= 200
    ? object.label
    : undefined;
  return {
    protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
    type: "home_fleet.heartbeat",
    workerId: validateIdentifier(object.workerId, "workerId"),
    endpoint: parseEndpoint(object.endpoint),
    timestamp: validateIsoTimestamp(object.timestamp, "timestamp"),
    nonce: validateIdentifier(object.nonce, "nonce"),
    ...(label !== undefined ? { label } : {}),
    ...(cachedPrefixes ? { cachedPrefixes } : {}),
    proof: validateProof(object.proof),
  };
}

/**
 * Wire-shape bound for the advertisement before MAC verification: strings
 * only, small count, short entries. Anything else is treated as absent —
 * which matches what a sender that never set the field signed.
 */
function rawCachedPrefixes(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return undefined;
  if (!value.every((entry): entry is string => typeof entry === "string" && entry.length <= 128)) return undefined;
  return [...value];
}

/**
 * Strictly validated warm-cache advertisement. Anything that is not a small
 * array of sha256 hex digests is treated as absent, so a malformed field can
 * only cost a worker its routing hint, never its heartbeat structure.
 * Individually invalid entries are dropped.
 */
function parseCachedPrefixes(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_CACHED_PREFIXES) return undefined;
  const digests = [...new Set(value.filter((entry): entry is string => typeof entry === "string" && isSha256Hex(entry)))];
  return digests.length ? digests : undefined;
}

function parseHeartbeatResponse(value: unknown): HomeFleetHeartbeatResponse {
  const object = objectRecord(value);
  if (object.protocolVersion !== HOME_FLEET_PROTOCOL_VERSION || object.type !== "home_fleet.heartbeat_ack") {
    throw new HomeFleetError("AUTHENTICATION_FAILED", "Coordinator heartbeat acknowledgement is invalid.");
  }
  return {
    protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
    type: "home_fleet.heartbeat_ack",
    coordinatorId: validateIdentifier(object.coordinatorId, "coordinatorId"),
    workerId: validateIdentifier(object.workerId, "workerId"),
    coordinator: parseEndpoint(object.coordinator),
    at: validateIsoTimestamp(object.at, "at"),
    requestNonce: validateIdentifier(object.requestNonce, "requestNonce"),
    proof: validateProof(object.proof),
  };
}

function parseHealthResponse(value: unknown, workerId: string): HomeFleetHealthResponse {
  const object = objectRecord(value);
  const health = objectRecord(object.health);
  if (object.protocolVersion !== HOME_FLEET_PROTOCOL_VERSION || object.type !== "home_fleet.health" || object.workerId !== workerId || health.status !== "ready") {
    throw new HomeFleetError("AUTHENTICATION_FAILED", "Worker health payload is invalid.");
  }
  return {
    protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
    type: "home_fleet.health",
    workerId,
    health: { status: "ready", at: validateIsoTimestamp(health.at, "health.at") },
  };
}

function parseCapabilitiesResponse(value: unknown, workerId: string): HomeFleetCapabilitiesResponse {
  const object = objectRecord(value);
  const capabilities = objectRecord(object.capabilities);
  if (object.protocolVersion !== HOME_FLEET_PROTOCOL_VERSION || object.type !== "home_fleet.capabilities" || object.workerId !== workerId) {
    throw new HomeFleetError("AUTHENTICATION_FAILED", "Worker capabilities payload is invalid.");
  }
  const models = capabilities.installedModels;
  if (!Array.isArray(models) || models.some(model => typeof model !== "string")) {
    throw new HomeFleetError("AUTHENTICATION_FAILED", "Worker model inventory is invalid.");
  }
  if (
    capabilities.protocolVersion !== HOME_FLEET_PROTOCOL_VERSION ||
    !Array.isArray(capabilities.roles) || capabilities.roles.length !== 1 || capabilities.roles[0] !== "review" ||
    capabilities.maxConcurrentReviews !== 1 ||
    capabilities.acceptsArbitraryCommands !== false ||
    capabilities.permitsModelPulls !== false
  ) {
    throw new HomeFleetError("AUTHENTICATION_FAILED", "Worker capabilities exceed the fixed home-fleet protocol.");
  }
  return {
    protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
    type: "home_fleet.capabilities",
    workerId,
    capabilities: {
      protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
      roles: ["review"],
      installedModels: normalizeInstalledModels(models),
      maxConcurrentReviews: 1,
      acceptsArbitraryCommands: false,
      permitsModelPulls: false,
    },
  };
}

function parseReviewRequest(value: unknown): HomeFleetReviewRequest {
  const object = objectRecord(value);
  if (object.protocolVersion !== HOME_FLEET_PROTOCOL_VERSION || object.type !== "home_fleet.review") {
    throw new HomeFleetError("INVALID_MESSAGE", "Worker review payload is invalid.");
  }
  // A malformed routing hint is dropped rather than rejected: prefix cache
  // state must never be able to fail an otherwise valid review request.
  const prefixDigest = typeof object.prefixDigest === "string" && isSha256Hex(object.prefixDigest) ? object.prefixDigest : undefined;
  return {
    protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
    type: "home_fleet.review",
    requestId: validateIdentifier(object.requestId, "requestId"),
    text: validateReviewText(object.text),
    ...(prefixDigest ? { prefixDigest } : {}),
  };
}

function parseReviewResponse(value: unknown, workerId: string, requestId: string): HomeFleetReviewResponse {
  const object = objectRecord(value);
  if (
    object.protocolVersion !== HOME_FLEET_PROTOCOL_VERSION || object.type !== "home_fleet.review_result" ||
    object.workerId !== workerId || object.requestId !== requestId
  ) {
    throw new HomeFleetError("AUTHENTICATION_FAILED", "Worker review response is invalid.");
  }
  return {
    protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
    type: "home_fleet.review_result",
    workerId,
    requestId,
    summary: validateReviewSummary(object.summary),
  };
}

function parseContextOfferRequest(value: unknown): HomeFleetContextOfferRequest {
  const object = objectRecord(value);
  if (object.protocolVersion !== HOME_FLEET_PROTOCOL_VERSION || object.type !== "home_fleet.context_offer") {
    throw new HomeFleetError("INVALID_MESSAGE", "Context offer payload is invalid.");
  }
  const digest = validateContextDigest(object.digest);
  const chars = object.chars;
  if (typeof chars !== "number" || !Number.isInteger(chars) || chars < 1 || chars > MAX_CONTEXT_TEXT_CHARS) {
    throw new HomeFleetError("INVALID_MESSAGE", "Context offer size is invalid.");
  }
  let peer: HomeFleetContextPeerHint | undefined;
  if (object.peer !== undefined) {
    const hint = objectRecord(object.peer);
    peer = {
      workerId: validateIdentifier(hint.workerId, "workerId"),
      endpoint: parseEndpoint(hint.endpoint),
      ticket: validateProof(hint.ticket),
      ticketExpiresAt: validateIsoTimestamp(hint.ticketExpiresAt, "ticketExpiresAt"),
    };
  }
  return {
    protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
    type: "home_fleet.context_offer",
    requestId: validateIdentifier(object.requestId, "requestId"),
    digest,
    chars,
    ...(object.text === undefined ? {} : { text: validateContextText(object.text) }),
    ...(peer ? { peer } : {}),
  };
}

function parseContextOfferResponse(value: unknown, workerId: string, requestId: string): HomeFleetContextOfferResponse {
  const object = objectRecord(value);
  if (
    object.protocolVersion !== HOME_FLEET_PROTOCOL_VERSION || object.type !== "home_fleet.context_offer_result" ||
    object.workerId !== workerId || object.requestId !== requestId ||
    (object.status !== "warmed" && object.status !== "cached" && object.status !== "failed")
  ) {
    throw new HomeFleetError("AUTHENTICATION_FAILED", "Worker context offer response is invalid.");
  }
  return {
    protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
    type: "home_fleet.context_offer_result",
    workerId,
    requestId,
    status: object.status,
  };
}

function parseContextFetchRequest(value: unknown): HomeFleetContextFetchRequest {
  const object = objectRecord(value);
  if (object.protocolVersion !== HOME_FLEET_PROTOCOL_VERSION || object.type !== "home_fleet.context_fetch") {
    throw new HomeFleetError("INVALID_MESSAGE", "Context fetch payload is invalid.");
  }
  return {
    protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
    type: "home_fleet.context_fetch",
    digest: validateContextDigest(object.digest),
    requesterWorkerId: validateIdentifier(object.requesterWorkerId, "requesterWorkerId"),
    ticket: validateProof(object.ticket),
    ticketExpiresAt: validateIsoTimestamp(object.ticketExpiresAt, "ticketExpiresAt"),
    nonce: validateIdentifier(object.nonce, "nonce"),
  };
}

function parseContextFetchResponse(value: unknown): HomeFleetContextFetchResponse {
  const object = objectRecord(value);
  if (object.protocolVersion !== HOME_FLEET_PROTOCOL_VERSION || object.type !== "home_fleet.context_fetched") {
    throw new HomeFleetError("INVALID_MESSAGE", "Context fetch response is invalid.");
  }
  return {
    protocolVersion: HOME_FLEET_PROTOCOL_VERSION,
    type: "home_fleet.context_fetched",
    digest: validateContextDigest(object.digest),
    text: validateContextText(object.text),
  };
}

/**
 * The exact transfer-ticket byte layout from the design: an HMAC over
 * "context-fetch|digest|requester|server|expiry" under the SERVING worker's
 * derived secret. Every field that would change the transfer's meaning is
 * inside the MAC, so a ticket cannot be replayed against a different digest,
 * server, requester, or window.
 */
function contextTicketPayload(digest: string, requesterWorkerId: string, servingWorkerId: string, ticketExpiresAt: string): string {
  return `context-fetch|${digest}|${requesterWorkerId}|${servingWorkerId}|${ticketExpiresAt}`;
}

function validateContextDigest(value: unknown): string {
  if (typeof value !== "string" || !isSha256Hex(value)) {
    throw new HomeFleetError("INVALID_MESSAGE", "Context bundle digest must be a sha256 hex string.");
  }
  return value;
}

function validateContextText(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > MAX_CONTEXT_TEXT_CHARS) {
    throw new HomeFleetError("INVALID_MESSAGE", "Context bundle text is missing or too large.");
  }
  return value;
}

function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function registrationPayload(request: Omit<HomeFleetRegistrationRequest, "proof"> | HomeFleetRegistrationRequest): string {
  return [
    "home-fleet-v1-register",
    request.invitationId,
    request.coordinatorId,
    request.worker.workerId,
    request.worker.label,
    request.worker.endpoint.url,
    request.nonce,
  ].join("\n");
}

/** A distinct context prevents a registration proof from being reused as a recovery proof. */
function registrationRecoveryPayload(request: HomeFleetRegistrationRequest): string {
  return [
    "home-fleet-v1-register-recovery",
    request.invitationId,
    request.coordinatorId,
    request.worker.workerId,
    request.worker.label,
    request.worker.endpoint.url,
    request.nonce,
  ].join("\n");
}

function registrationResponsePayload(response: Omit<HomeFleetRegistrationResponse, "proof"> | HomeFleetRegistrationResponse): string {
  return [
    "home-fleet-v1-registered",
    response.invitationId,
    response.coordinatorId,
    response.workerId,
    response.registeredAt,
  ].join("\n");
}

function heartbeatRequestPayload(request: Omit<HomeFleetHeartbeatRequest, "proof"> | HomeFleetHeartbeatRequest): string {
  // The optional warm-cache advertisement is inside the HMAC only when it is
  // present, so a worker that never sends it signs exactly the same payload
  // as a pre-context-sharing v0.2.0 worker.
  return [
    "home-fleet-v1-heartbeat",
    request.workerId,
    request.endpoint.url,
    request.timestamp,
    request.nonce,
    ...(request.cachedPrefixes?.length ? [`cached:${request.cachedPrefixes.join(",")}`] : []),
    ...(request.label !== undefined ? [`label:${request.label}`] : []),
  ].join("\n");
}

function heartbeatResponsePayload(response: Omit<HomeFleetHeartbeatResponse, "proof"> | HomeFleetHeartbeatResponse): string {
  return [
    "home-fleet-v1-heartbeat-ack",
    response.coordinatorId,
    response.workerId,
    response.coordinator.url,
    response.at,
    response.requestNonce,
  ].join("\n");
}

function signedRequestPayload(input: {
  method: string;
  path: string;
  coordinatorId: string;
  coordinatorEndpoint: string;
  timestamp: string;
  nonce: string;
  body: string;
}): string {
  return ["home-fleet-v1-request", input.method, input.path, input.coordinatorId, input.coordinatorEndpoint, input.timestamp, input.nonce, digest(input.body)].join("\n");
}

function signedResponsePayload(input: { status: number; timestamp: string; requestNonce: string; body: string }): string {
  return ["home-fleet-v1-response", String(input.status), input.timestamp, input.requestNonce, digest(input.body)].join("\n");
}

function deriveWorkerSecret(token: Buffer, workerId: string): Buffer {
  return createHmac("sha256", token).update(`home-fleet-v1-worker:${workerId}`, "utf8").digest();
}

function signMac(secret: Buffer, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

function verifyMac(secret: Buffer, payload: string, proof: string): boolean {
  const expected = Buffer.from(signMac(secret, payload), "utf8");
  const received = Buffer.from(proof, "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function tokenBuffer(value: string): Buffer {
  const token = validateToken(value);
  const decoded = Buffer.from(token, "base64url");
  if (decoded.length !== 32) throw new HomeFleetError("INVALID_MESSAGE", "Join token has an invalid length.");
  return decoded;
}

function validatePrivateSecret(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{40,128}$/.test(value)) {
    throw new HomeFleetError("INVALID_MESSAGE", "Private home-fleet secret is invalid.");
  }
  if (Buffer.from(value, "base64url").length !== 32) {
    throw new HomeFleetError("INVALID_MESSAGE", "Private home-fleet secret has an invalid length.");
  }
  return value;
}

function decodeSecret(value: string): Buffer {
  return Buffer.from(validatePrivateSecret(value), "base64url");
}

function parseEndpoint(value: unknown): HomeFleetEndpoint {
  const object = objectRecord(value);
  if (object.protocol !== "http" || typeof object.url !== "string") throw new HomeFleetError("INVALID_MESSAGE", "Home-fleet endpoint is invalid.");
  const parsed = assertPrivateEndpoint(object.url);
  if (object.host !== parsed.host || object.port !== parsed.port) throw new HomeFleetError("INVALID_MESSAGE", "Home-fleet endpoint fields do not match its URL.");
  return parsed;
}

function parseEndpointHeader(value: string, message: string): HomeFleetEndpoint {
  try {
    return assertPrivateEndpoint(value);
  } catch {
    throw new HomeFleetError("AUTHENTICATION_FAILED", message);
  }
}

function assertPrivateEndpoint(raw: string): HomeFleetEndpoint {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HomeFleetError("PRIVATE_ADDRESS_REQUIRED", "Home-fleet endpoints must be valid private HTTP URLs.");
  }
  if (
    parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new HomeFleetError("PRIVATE_ADDRESS_REQUIRED", "Home-fleet endpoints allow only a private HTTP host and port.");
  }
  const host = normalizePrivateAddress(parsed.hostname);
  if (!host) throw new HomeFleetError("PRIVATE_ADDRESS_REQUIRED", "Home-fleet endpoints must use an RFC1918 or loopback IP literal, never a hostname or public address.");
  const port = parsed.port ? Number(parsed.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new HomeFleetError("PRIVATE_ADDRESS_REQUIRED", "Home-fleet endpoint port is invalid.");
  return endpointFor(host, port);
}

function endpointFor(host: string, port: number): HomeFleetEndpoint {
  const printableHost = host.includes(":") ? `[${host}]` : host;
  return { protocol: "http", host, port, url: `http://${printableHost}:${port}` };
}

function assertPrivateBindHost(host: string): string {
  const normalized = normalizePrivateAddress(host);
  if (!normalized) throw new HomeFleetError("PRIVATE_ADDRESS_REQUIRED", "Home-fleet listeners must bind to an RFC1918 or loopback literal address.");
  return normalized;
}

function assertListenPort(port: number): number {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new HomeFleetError("REQUEST_REJECTED", "Listener port is invalid.");
  return port;
}

function normalizePrivateAddress(value: string): string | null {
  let address = value.trim().toLowerCase();
  if (!address) return null;
  const zone = address.indexOf("%");
  if (zone >= 0) address = address.slice(0, zone);
  if (address.startsWith("[")) address = address.endsWith("]") ? address.slice(1, -1) : address;
  if (address.startsWith("::ffff:")) address = address.slice("::ffff:".length);
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    const isPrivate = octets[0] === 10 || octets[0] === 127 ||
      (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
      (octets[0] === 192 && octets[1] === 168);
    return isPrivate ? octets.join(".") : null;
  }
  // The requirement is RFC1918 plus loopback. Do not expand it to broad IPv6
  // ULA/link-local ranges without an explicit product security decision.
  return family === 6 && address === "::1" ? "::1" : null;
}

function sameEndpoint(left: HomeFleetEndpoint, right: HomeFleetEndpoint): boolean {
  return left.protocol === right.protocol && left.host === right.host && left.port === right.port;
}

function validateIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new HomeFleetError("INVALID_MESSAGE", `${name} is invalid.`);
  }
  return value;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validateLabel(value: unknown): string {
  if (typeof value !== "string") throw new HomeFleetError("INVALID_MESSAGE", "Worker label is invalid.");
  const label = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!label || label.length > 80) throw new HomeFleetError("INVALID_MESSAGE", "Worker label is invalid.");
  return label;
}

function normalizeInstalledModels(models: readonly string[]): string[] {
  const normalized = [...new Set(models.map(model => {
    if (typeof model !== "string") throw new HomeFleetError("INVALID_MESSAGE", "Worker model inventory is invalid.");
    const trimmed = model.trim();
    if (!trimmed || trimmed.length > 160 || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new HomeFleetError("INVALID_MESSAGE", "Worker model inventory is invalid.");
    return trimmed;
  }))];
  if (normalized.length > 64) throw new HomeFleetError("INVALID_MESSAGE", "Worker model inventory is too large.");
  return normalized.sort();
}

function validateToken(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{40,128}$/.test(value)) throw new HomeFleetError("INVALID_MESSAGE", "Join token is invalid.");
  return value;
}

function validateProof(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{40,128}$/.test(value)) throw new HomeFleetError("INVALID_MESSAGE", "Authentication proof is invalid.");
  return value;
}

function validateIsoTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || !Number.isFinite(new Date(value).getTime())) throw new HomeFleetError("INVALID_MESSAGE", `${name} is invalid.`);
  return new Date(value).toISOString();
}

function validateReviewText(value: unknown): string {
  if (typeof value !== "string") throw new HomeFleetError("REQUEST_REJECTED", "Review text is invalid.");
  const text = value.trim();
  if (text.length < 3 || text.length > HOME_FLEET_MAX_REVIEW_TEXT_CHARS) {
    throw new HomeFleetError("REQUEST_REJECTED", `Review text must be between 3 and ${HOME_FLEET_MAX_REVIEW_TEXT_CHARS} characters.`);
  }
  return text;
}

function validateReviewSummary(value: unknown): string {
  if (typeof value !== "string") throw new HomeFleetError("REQUEST_REJECTED", "Worker review summary is invalid.");
  const summary = value.trim();
  if (!summary || summary.length > HOME_FLEET_MAX_REVIEW_SUMMARY_CHARS) {
    throw new HomeFleetError("REQUEST_REJECTED", `Worker review summary must be no more than ${HOME_FLEET_MAX_REVIEW_SUMMARY_CHARS} characters.`);
  }
  return summary;
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HomeFleetError("INVALID_MESSAGE", "Home-fleet message must be an object.");
  return value as Record<string, unknown>;
}

function isTimestampFresh(value: string, now: Date): boolean {
  const at = new Date(value).getTime();
  return Number.isFinite(at) && Math.abs(now.getTime() - at) <= AUTH_WINDOW_MS;
}

class ReplayWindow {
  /** nonce -> the instant it may be forgotten (ms epoch). */
  private readonly nonces = new Map<string, number>();

  public has(nonce: string, now: number): boolean {
    this.purge(now);
    return this.nonces.has(nonce);
  }

  /**
   * Remembers `nonce` until `expiresAt` (default: `now + AUTH_WINDOW_MS`, which
   * reproduces the fixed-window behavior the timestamp-fresh paths rely on).
   * A caller whose credential can be accepted for longer than the auth window —
   * the context-fetch ticket, valid until its own `ticketExpiresAt` — must pass
   * that expiry so the redeemed credential stays remembered for its entire
   * validity. Otherwise it would be purged while still redeemable, and a
   * captured request could replay it, breaking the one-ticket-one-transfer rule.
   */
  public add(nonce: string, now: number, expiresAt: number = now + AUTH_WINDOW_MS): void {
    this.purge(now);
    this.nonces.set(nonce, expiresAt);
    while (this.nonces.size > MAX_REPLAY_NONCES) this.nonces.delete(this.nonces.keys().next().value!);
  }

  private purge(now: number): void {
    for (const [nonce, expiresAt] of this.nonces) if (now > expiresAt) this.nonces.delete(nonce);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return parseJson(await readRawBody(request));
}

async function readRawBody(request: IncomingMessage, limit = MAX_JSON_BYTES): Promise<string> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) throw new HomeFleetError("REQUEST_REJECTED", "Home-fleet request body is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new HomeFleetError("INVALID_MESSAGE", "Home-fleet message is not valid JSON.");
  }
}

function requestUrlPath(request: IncomingMessage): string {
  try {
    const parsed = new URL(request.url ?? "/", "http://home-fleet.invalid");
    if (parsed.search || parsed.hash) return "";
    return parsed.pathname;
  } catch {
    return "";
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(body);
}

function statusForError(error: unknown): number {
  if (!(error instanceof HomeFleetError)) return 500;
  switch (error.code) {
    case "PRIVATE_ADDRESS_REQUIRED": return 403;
    case "AUTHENTICATION_FAILED":
    case "REPLAY_REJECTED":
    case "JOIN_TOKEN_INVALID":
    case "JOIN_TOKEN_EXPIRED": return 401;
    case "REVIEW_BUSY": return 429;
    case "REVIEW_UNAVAILABLE": return 503;
    case "WORKER_ALREADY_REGISTERED": return 409;
    case "WORKER_LIMIT_REACHED": return 409;
    case "INVALID_MESSAGE":
    case "REQUEST_REJECTED": return 400;
    default: return 404;
  }
}

function publicErrorBody(error: unknown): { error: string } {
  if (!(error instanceof HomeFleetError)) return { error: "request_failed" };
  return { error: error.code.toLowerCase() };
}

async function boundedResponseText(response: Response, limit = MAX_RESPONSE_BYTES): Promise<string> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader && Number(lengthHeader) > limit) throw new HomeFleetError("REQUEST_REJECTED", "Home-fleet response is too large.");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > limit) throw new HomeFleetError("REQUEST_REJECTED", "Home-fleet response is too large.");
  return text;
}

function decodeRemoteError(status: number, body: string): HomeFleetError {
  let code = "request_rejected";
  try {
    const parsed = objectRecord(JSON.parse(body));
    if (typeof parsed.error === "string") code = parsed.error;
  } catch {
    // The public error remains generic; raw network content is never surfaced.
  }
  if (status === 401 || status === 403) return new HomeFleetError("AUTHENTICATION_FAILED", "The private home-fleet peer rejected authentication.");
  if (code === "review_busy") return new HomeFleetError("REVIEW_BUSY", "The worker is already reviewing another request.");
  if (code === "review_unavailable") return new HomeFleetError("REVIEW_UNAVAILABLE", "The worker has no review role available.");
  if (code === "worker_already_registered") return new HomeFleetError("WORKER_ALREADY_REGISTERED", "This worker identity is already paired with the coordinator.");
  if (code === "worker_limit_reached") return new HomeFleetError("WORKER_LIMIT_REACHED", "The Home Fleet worker limit has been reached.");
  return new HomeFleetError("REQUEST_REJECTED", "The private home-fleet peer rejected the fixed request.");
}

function listenServer(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => {
      server.off("listening", ready);
      reject(error);
    };
    const ready = () => {
      server.off("error", fail);
      resolve();
    };
    server.once("error", fail);
    server.once("listening", ready);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

async function runBounded<T>(jobs: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results = new Array<T>(jobs.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= jobs.length) return;
      results[index] = await jobs[index]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));
  return results;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
