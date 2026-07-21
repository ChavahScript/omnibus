import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";

export const BYPASS_TUNNEL_HEADER = "bypass-tunnel-reminder";
/** Resume secrets stay in the WebSocket upgrade header, never in a URL. */
export const RESUME_SESSION_HEADER = "x-omnibus-resume";

const DEFAULT_RESUME_TTL_MS = 12 * 60 * 60_000;
// A transport can die after the bridge accepts a resume header but before the
// rotating replacement secret reaches Keychain. Keep only the immediately
// used bearer valid for this short delivery window so a network handoff cannot
// strand the paired phone. It is not a second long-lived credential.
const DEFAULT_RESUME_DELIVERY_GRACE_MS = 60_000;
const MAX_RESUME_SESSIONS = 4;

/** One-time pairing token: only a SHA-256 digest remains after its QR is rendered. */
export class PairingToken {
  private token: string | undefined;
  private tokenDigest: string;
  private consumed = false;

  public constructor() {
    const token = randomBytes(32).toString("base64url");
    this.token = token;
    this.tokenDigest = digest(token);
  }

  public qrPayload(publicUrl: string): string {
    const token = this.token;
    if (!token) throw new Error("This pairing QR has already been printed. Rotate the pairing token before printing another code.");
    // The payload string still has to be handed to the QR renderer, but the
    // bridge itself retains only a digest after that one rendering. A later
    // reprint is deliberately a new generation, never a copyable old secret.
    this.token = undefined;
    return JSON.stringify({ version: 1, bridgeUrl: publicUrl, token });
  }

  public verify(candidate: string | null): boolean {
    if (this.consumed || !candidate || candidate.length > 256) return false;
    const candidateDigest = Buffer.from(digest(candidate), "hex");
    const expectedDigest = Buffer.from(this.tokenDigest, "hex");
    const valid = candidateDigest.length === expectedDigest.length && timingSafeEqual(candidateDigest, expectedDigest);
    if (valid) this.consumed = true;
    return valid;
  }

  /**
   * Invalidates a displayed or consumed QR secret before a replacement public
   * endpoint is announced. This is intentionally only an in-memory rotation:
   * the bridge never persists a pairing credential and an old QR can never
   * authenticate through a newly recovered tunnel.
   */
  public rotate(): void {
    const token = randomBytes(32).toString("base64url");
    this.token = token;
    this.tokenDigest = digest(token);
    this.consumed = false;
  }
}

/**
 * Short-lived, in-memory resumption secrets make a brief Wi-Fi/tunnel socket
 * drop recoverable after the owner has completed the one-time QR handshake.
 * They are deliberately independent from the QR token, rotate on each use,
 * expire after a bounded window, and are cleared whenever the public endpoint
 * is replaced. Nothing is persisted to disk or exposed in a phone URL.
 */
export class PairingResumptionStore {
  private readonly sessions = new Map<string, { digest: string; deviceId: string; expiresAt: number; deliveryGraceUntil?: number }>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly deliveryGraceMs: number;

  public constructor(options: { now?: () => number; ttlMs?: number; deliveryGraceMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = Math.max(60_000, Math.min(24 * 60 * 60_000, Math.floor(options.ttlMs ?? DEFAULT_RESUME_TTL_MS)));
    this.deliveryGraceMs = Math.max(10_000, Math.min(5 * 60_000, Math.floor(options.deliveryGraceMs ?? DEFAULT_RESUME_DELIVERY_GRACE_MS)));
  }

  public issue(deviceId: string): string {
    this.purgeExpired();
    while (this.sessions.size >= MAX_RESUME_SESSIONS) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.sessions.delete(oldest);
    }
    const token = randomBytes(32).toString("base64url");
    const tokenDigest = digest(token);
    this.sessions.set(tokenDigest, { digest: tokenDigest, deviceId, expiresAt: this.now() + this.ttlMs });
    return token;
  }

  /**
   * Redeems a secret and grants a tiny delivery grace after its first use.
   * During that grace, only the same device scope can ask for another rolling
   * replacement. This covers a lost `hello` during Wi-Fi/cellular handoff;
   * after grace it is removed rather than acting as a durable credential.
   */
  public consume(candidate: string | undefined): string | undefined {
    const now = this.now();
    this.purgeExpired(now);
    if (!candidate || candidate.length > 256) return undefined;
    const candidateDigest = digest(candidate);
    const record = this.sessions.get(candidateDigest);
    if (!record) return undefined;
    // Do not depend on map membership alone for secret comparison. This keeps
    // the token check constant-time when the record exists.
    const actual = Buffer.from(candidateDigest, "hex");
    const expected = Buffer.from(record.digest, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
    if (!record.deliveryGraceUntil) {
      record.deliveryGraceUntil = Math.min(record.expiresAt, now + this.deliveryGraceMs);
    }
    return record.deviceId;
  }

  public clear(): void {
    this.sessions.clear();
  }

  private purgeExpired(now = this.now()): void {
    for (const [key, value] of this.sessions) {
      if (value.expiresAt <= now || (value.deliveryGraceUntil !== undefined && value.deliveryGraceUntil <= now)) this.sessions.delete(key);
    }
  }
}

export function assertWorkspacePath(workspaceRoot: string, candidate: string): string {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Requested path escapes the configured workspace.");
  }
  return resolved;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
