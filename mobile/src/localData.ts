import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import type { BridgeResumeProfile, CommandMode } from "./types";

const APPLE_PROFILE_KEY = "@omnibus/apple-local-profile";
const IDEA_HISTORY_KEY = "@omnibus/local-idea-history";
// SecureStore keys may contain only alphanumeric characters, `.`, `-`, and
// `_`; keep this one separate from the older AsyncStorage names above.
const BRIDGE_PROFILE_KEY = "omnibus.bridge-session.v1";
const BRIDGE_PROFILE_OPTIONS = {
  // Do not migrate a live laptop credential through an iCloud/iTunes restore.
  // A restored iPhone must scan its own fresh QR code instead.
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  keychainService: "com.app.omnibus.bridge-session",
} as const;
const IDEA_HISTORY_LIMIT = 20;

/**
 * Omnibus deliberately separates a local Apple identity from cloud accounts.
 * The stable Apple subject stays in Keychain-backed SecureStore; we never keep
 * an identity token, authorization code, email address, or name on a server.
 */
export type LocalAppleProfile = {
  appleUserId: string;
  displayName: string | null;
  createdAt: string;
};

/** A compact local history makes the account option useful before sync exists. */
export type LocalIdeaRecord = {
  id: string;
  idea: string;
  brief: string | null;
  status: "submitted" | "complete" | "failed";
  /** Old on-device records predate mode selection, so this remains optional. */
  mode?: CommandMode;
  /** Whether this request had explicit approval to use configured web search. */
  research?: boolean;
  /** Whether this request had explicit approval to ask paired home laptops for peer review. */
  homeFleet?: boolean;
  updatedAt: string;
};

export async function loadLocalAppleProfile(): Promise<LocalAppleProfile | null> {
  const raw = await SecureStore.getItemAsync(APPLE_PROFILE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LocalAppleProfile>;
    if (typeof parsed.appleUserId !== "string" || !parsed.appleUserId) return null;
    return {
      appleUserId: parsed.appleUserId,
      displayName: typeof parsed.displayName === "string" ? parsed.displayName : null,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function saveLocalAppleProfile(profile: LocalAppleProfile): Promise<void> {
  await SecureStore.setItemAsync(APPLE_PROFILE_KEY, JSON.stringify(profile));
}

/**
 * Loads only a previously authenticated bridge resumption profile. The QR
 * token is deliberately absent from this schema and therefore can never be
 * written to Keychain by this module.
 */
export async function loadPairedBridgeProfile(): Promise<BridgeResumeProfile | null> {
  const raw = await SecureStore.getItemAsync(BRIDGE_PROFILE_KEY, BRIDGE_PROFILE_OPTIONS);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isBridgeResumeProfile(parsed)) return parsed;
  } catch {
    // An invalid record cannot be safely retried. Treat it as an unrecoverable
    // local expiry and remove it rather than surfacing it in application UI.
  }
  await SecureStore.deleteItemAsync(BRIDGE_PROFILE_KEY, BRIDGE_PROFILE_OPTIONS).catch(() => undefined);
  return null;
}

/** Persists a freshly rotated bridge resume secret in this device's Keychain. */
export async function savePairedBridgeProfile(profile: BridgeResumeProfile): Promise<void> {
  if (!isBridgeResumeProfile(profile)) throw new Error("Refusing to store an invalid bridge session.");
  await SecureStore.setItemAsync(BRIDGE_PROFILE_KEY, JSON.stringify(profile), BRIDGE_PROFILE_OPTIONS);
}

/** Used only for an explicit owner unlink or a definitively rejected session. */
export async function clearPairedBridgeProfile(): Promise<void> {
  await SecureStore.deleteItemAsync(BRIDGE_PROFILE_KEY, BRIDGE_PROFILE_OPTIONS);
}

/**
 * The actual content saved by the client remains on this iPhone. It is a
 * convenience history, not a sync queue and not a replacement for a backend.
 */
export async function upsertLocalIdeaRecord(record: LocalIdeaRecord): Promise<void> {
  const history = await loadLocalIdeaHistory();
  const withoutCurrent = history.filter(item => item.id !== record.id);
  const next = [record, ...withoutCurrent]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, IDEA_HISTORY_LIMIT);
  await AsyncStorage.setItem(IDEA_HISTORY_KEY, JSON.stringify(next));
}

export async function loadLocalIdeaHistory(): Promise<LocalIdeaRecord[]> {
  const raw = await AsyncStorage.getItem(IDEA_HISTORY_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLocalIdeaRecord).slice(0, IDEA_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function isLocalIdeaRecord(value: unknown): value is LocalIdeaRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<LocalIdeaRecord>;
  return typeof record.id === "string"
    && typeof record.idea === "string"
    && (typeof record.brief === "string" || record.brief === null)
    && (record.status === "submitted" || record.status === "complete" || record.status === "failed")
    && (record.mode === undefined || record.mode === "plan" || record.mode === "build" || record.mode === "marketing")
    && (record.research === undefined || typeof record.research === "boolean")
    && (record.homeFleet === undefined || typeof record.homeFleet === "boolean")
    && typeof record.updatedAt === "string";
}

function isBridgeResumeProfile(value: unknown): value is BridgeResumeProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<BridgeResumeProfile>;
  return profile.version === 1
    && isBridgeUrl(profile.bridgeUrl)
    && isResumeToken(profile.resumeToken)
    && typeof profile.deviceId === "string"
    && /^[A-Za-z0-9_-]{8,128}$/.test(profile.deviceId)
    && isTimestamp(profile.pairedAt)
    && isTimestamp(profile.updatedAt);
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

function isResumeToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
