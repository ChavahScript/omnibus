import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { findFleetProfile, type FleetProfileId } from "./fleet-profiles.js";

/**
 * Settings chosen from a QR-paired phone live beside the bridge's existing
 * local state, rather than in a project .env file.  That keeps setup out of
 * source control and lets the bridge resume a deliberately selected fleet on
 * its next launch.  The only credential currently supported here is a search
 * provider key; callers never receive it back after writing it.
 */
const StoredBridgeSettingsSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string().datetime(),
  fleetProfileId: z.enum(["compact", "balanced", "power", "studio"]).optional(),
  webResearch: z.object({
    enabled: z.boolean(),
    braveSearchApiKey: z.string().trim().min(10).max(512).optional(),
  }).optional(),
});

type StoredBridgeSettings = z.infer<typeof StoredBridgeSettingsSchema>;

export type BridgeSettingsSummary = {
  fleetProfileId?: FleetProfileId;
  research: {
    enabled: boolean;
    /** Presence only. The phone, logs, audits, and WebSocket events never see the key. */
    hasBraveSearchApiKey: boolean;
  };
};

export class BridgeSettingsError extends Error {
  public constructor(public readonly code: "RESEARCH_KEY_REQUIRED" | "SETTINGS_INVALID", message: string) {
    super(message);
    this.name = "BridgeSettingsError";
  }
}

/**
 * Private owner-side setting store.  There is intentionally no general
 * key/value API here: narrowly typed operations keep a paired phone from
 * turning the bridge into an arbitrary environment editor.
 */
export class BridgeSettingsStore {
  private readonly settingsPath: string;

  public constructor(private readonly statePath: string) {
    this.settingsPath = path.join(statePath, "bridge-settings.json");
  }

  public async summary(options: { hasExternalBraveSearchApiKey?: boolean; enabled?: boolean } = {}): Promise<BridgeSettingsSummary> {
    return toSummary(await this.load(), options);
  }

  /** Applies saved user choices to the in-memory runtime configuration. */
  public async applyTo(config: AppConfig): Promise<BridgeSettingsSummary> {
    const settings = await this.load();
    const profile = settings.fleetProfileId ? findFleetProfile(settings.fleetProfileId) : undefined;
    if (profile) {
      config.ollamaModel = profile.assignments.find(assignment => assignment.role === "auditor")!.model;
      config.ollamaDeveloperModel = profile.assignments.find(assignment => assignment.role === "developer")!.model;
      config.ollamaNumCtx = profile.ollama.numCtx;
      config.ollamaKeepAlive = profile.ollama.keepAlive;
    }

    // Explicit environment credentials still work as an operator override.
    // A persisted paired setup fills the gap only when the environment did not
    // supply a key, which avoids silently replacing an intentional .env value.
    const savedKey = settings.webResearch?.braveSearchApiKey;
    if (!config.braveSearchApiKey && savedKey) config.braveSearchApiKey = savedKey;
    // A user may keep their Brave key in an existing private environment file
    // and use the phone only to toggle activation. In that case persist the
    // preference but never duplicate the environment credential in state.
    if (settings.webResearch && config.braveSearchApiKey) {
      config.webResearchEnabled = settings.webResearch.enabled;
    }
    // A manually enabled flag without either an environment key or a saved
    // paired key is harmlessly downgraded to local-only mode. This lets a
    // stored QR-paired credential be applied after config parsing without
    // making an incomplete .env prevent the bridge from starting.
    if (config.webResearchEnabled && !config.braveSearchApiKey) config.webResearchEnabled = false;
    return toSummary(settings, {
      hasExternalBraveSearchApiKey: Boolean(config.braveSearchApiKey),
      enabled: config.webResearchEnabled,
    });
  }

  public async setFleetProfile(fleetProfileId: FleetProfileId): Promise<BridgeSettingsSummary> {
    // The profile lookup is also a defensive validation boundary when this is
    // invoked by a future non-WebSocket caller.
    if (!findFleetProfile(fleetProfileId)) {
      throw new BridgeSettingsError("SETTINGS_INVALID", "That local model fleet is not available.");
    }
    const current = await this.load();
    const next: StoredBridgeSettings = {
      ...current,
      version: 1,
      updatedAt: new Date().toISOString(),
      fleetProfileId,
    };
    await this.write(next);
    return toSummary(next);
  }

  /**
   * Persists the paired owner's research preference. `apiKey` is optional so
   * a later one-tap enable can reuse an already stored key; it is never
   * returned, logged, or included in audit data.
   */
  public async configureWebResearch(input: { enabled: boolean; apiKey?: string; hasExistingKey?: boolean }): Promise<BridgeSettingsSummary> {
    const current = await this.load();
    const suppliedKey = input.apiKey?.trim();
    const storedKey = current.webResearch?.braveSearchApiKey;
    const braveSearchApiKey = suppliedKey || storedKey;
    const hasConfiguredKey = Boolean(braveSearchApiKey || input.hasExistingKey);
    if (input.enabled && !hasConfiguredKey) {
      throw new BridgeSettingsError(
        "RESEARCH_KEY_REQUIRED",
        "Add a Brave Search API key once on this paired phone before enabling cited web research.",
      );
    }
    const next: StoredBridgeSettings = {
      ...current,
      version: 1,
      updatedAt: new Date().toISOString(),
      webResearch: {
        enabled: input.enabled,
        ...(braveSearchApiKey ? { braveSearchApiKey } : {}),
      },
    };
    await this.write(next);
    return toSummary(next, {
      hasExternalBraveSearchApiKey: Boolean(input.hasExistingKey),
      enabled: input.enabled,
    });
  }

  /** Test and operational utility: exposes no persisted secret to callers. */
  public get path(): string {
    return this.settingsPath;
  }

  private async load(): Promise<StoredBridgeSettings> {
    try {
      const text = await readFile(this.settingsPath, "utf8");
      const parsed = StoredBridgeSettingsSchema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
      // A malformed private settings file should never make a local bridge
      // unusable. Ignore it until the owner makes a fresh choice in the app.
      return freshSettings();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return freshSettings();
      // Read errors are treated just like a missing choice. We intentionally
      // avoid passing host-specific filesystem details across the QR channel.
      return freshSettings();
    }
  }

  private async write(settings: StoredBridgeSettings): Promise<void> {
    await mkdir(this.statePath, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(this.statePath, `.bridge-settings-${randomUUID()}.tmp`);
    const body = `${JSON.stringify(settings, null, 2)}\n`;
    let committed = false;
    try {
      await writeFile(temporaryPath, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
      // `rename` makes the replacement atomic on the same local volume. A
      // brief interruption can therefore leave the old valid settings rather
      // than a partly written credentials file.
      await rename(temporaryPath, this.settingsPath);
      committed = true;
      await chmod(this.settingsPath, 0o600);
    } finally {
      // The name is a UUID generated in this function under our private state
      // directory. Removing only an uncommitted temp file prevents a failed
      // credential write from leaving a readable stale copy behind.
      if (!committed) await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

function freshSettings(): StoredBridgeSettings {
  return { version: 1, updatedAt: new Date(0).toISOString() };
}

function toSummary(
  settings: StoredBridgeSettings,
  options: { hasExternalBraveSearchApiKey?: boolean; enabled?: boolean } = {},
): BridgeSettingsSummary {
  const hasBraveSearchApiKey = Boolean(settings.webResearch?.braveSearchApiKey || options.hasExternalBraveSearchApiKey);
  return {
    ...(settings.fleetProfileId ? { fleetProfileId: settings.fleetProfileId } : {}),
    research: {
      enabled: Boolean((options.enabled ?? settings.webResearch?.enabled) && hasBraveSearchApiKey),
      hasBraveSearchApiKey,
    },
  };
}
