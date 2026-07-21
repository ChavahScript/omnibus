import type { AuditTrail } from "./audit.js";
import { BridgeSettingsStore } from "./bridge-settings.js";
import type { AppConfig } from "./config.js";
import type { BridgeEvent, FleetProfile, FleetProfileAssessment, FleetSnapshot, HomeFleetSnapshot } from "./contracts.js";
import {
  findFleetProfile,
  recommendFleetProfiles,
  assessFleetProfile,
  type FleetProfile as LocalFleetProfile,
  type FleetProfileId,
} from "./fleet-profiles.js";
import { probeLaptopCapabilities } from "./hardware.js";
import { inspectOllama, missingLocalModels, pullLocalModels, type PullProgress } from "./local-intelligence.js";

export class FleetControllerError extends Error {
  public constructor(
    public readonly code: "FLEET_BUSY" | "FLEET_PROFILE_UNSUPPORTED" | "OLLAMA_UNAVAILABLE" | "FLEET_PROVISION_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "FleetControllerError";
  }
}

type FleetStatusSink = (event: Extract<BridgeEvent, { type: "status" }>) => void;

/**
 * The phone is a control plane, never a remote shell. This controller exposes
 * only safe capability inspection, fixed model-fleet selection, and an
 * explicit search-provider preference. All downloads still happen through
 * the laptop's loopback Ollama API and only after a paired owner action.
 */
export class FleetController {
  private provisioningProfileId: FleetProfileId | undefined;

  public constructor(
    private readonly config: AppConfig,
    private readonly settings: BridgeSettingsStore,
    private readonly audit: AuditTrail,
    /**
     * Kept as a narrow snapshot provider so Fleet Setup never gains authority
     * over LAN workers. The controller remains responsible only for this
     * laptop's approved Ollama presets.
     */
    private readonly homeFleetSnapshot: () => Promise<HomeFleetSnapshot> = async () => emptyHomeFleetSnapshot(),
  ) {}

  /** Lets the socket gateway avoid competing agent inference with a model pull. */
  public get isProvisioning(): boolean {
    return Boolean(this.provisioningProfileId);
  }

  public async snapshot(): Promise<FleetSnapshot> {
    const [hardware, settings, homeFleet] = await Promise.all([
      probeLaptopCapabilities(this.config.ollamaModelsPath ?? this.config.workspacePath),
      this.settings.summary({
        hasExternalBraveSearchApiKey: Boolean(this.config.braveSearchApiKey),
        enabled: this.config.webResearchEnabled,
      }),
      this.homeFleetSnapshot(),
    ]);
    const recommendation = recommendFleetProfiles(hardware);
    return {
      hardware,
      profiles: recommendation.profiles.map(toWireAssessment),
      recommendedProfileId: recommendation.recommendedProfileId,
      detectedCapacity: recommendation.detectedCapacity,
      notes: recommendation.notes,
      ...(settings.fleetProfileId ? { activeProfileId: settings.fleetProfileId } : {}),
      research: {
        enabled: settings.research.enabled,
        hasBraveSearchApiKey: settings.research.hasBraveSearchApiKey,
        provider: "brave",
      },
      provisioning: {
        active: Boolean(this.provisioningProfileId),
        ...(this.provisioningProfileId ? { profileId: this.provisioningProfileId } : {}),
      },
      homeFleet,
    };
  }

  /**
   * Ensures the exact, selected model tags exist locally and then persists the
   * choice. Arbitrary tags, shell commands, and environment values cannot
   * cross this boundary from a paired phone.
   */
  public async provision(
    correlationId: string,
    profileId: FleetProfileId,
    emit: FleetStatusSink,
  ): Promise<FleetSnapshot> {
    if (this.provisioningProfileId) {
      throw new FleetControllerError("FLEET_BUSY", "Another local model fleet is already being prepared. Wait for that download to finish.");
    }
    const profile = findFleetProfile(profileId);
    if (!profile) {
      throw new FleetControllerError("FLEET_PROFILE_UNSUPPORTED", "That local model fleet is not available.");
    }
    this.provisioningProfileId = profileId;
    try {
      const hardware = await probeLaptopCapabilities(this.config.ollamaModelsPath ?? this.config.workspacePath);
      const assessment = assessFleetProfile(profile, hardware);
      if (!assessment.canInstall) {
        throw new FleetControllerError(
          "FLEET_PROFILE_UNSUPPORTED",
          assessment.reasons[0] ?? "This laptop does not meet the selected fleet's minimum requirements.",
        );
      }
      if (!assessment.readyNow) {
        emit(status(correlationId, "fleet_headroom", assessment.reasons[0] ?? "Checking local capacity before download."));
      }

      emit(status(correlationId, "fleet_check", "Checking the local Ollama runtime before preparing the selected team."));
      const inspection = await inspectOllama(this.config.ollamaBaseUrl);
      if (!inspection.reachable) {
        throw new FleetControllerError(
          "OLLAMA_UNAVAILABLE",
          "The local Ollama runtime is not reachable. Start or install Ollama on this laptop, then tap the fleet again.",
        );
      }

      await this.auditEvent(correlationId, "fleet_provision_started", {
        profile: profile.id,
        models: profile.modelRequirements.map(requirement => ({ model: requirement.model, roles: requirement.roles })),
        readiness: assessment.readiness,
      });
      const missing = missingLocalModels(profile.modelRequirements, inspection.models);
      if (missing.length === 0) {
        emit(status(correlationId, "fleet_models_ready", "The selected local models are already available. Applying the fleet settings."));
      } else {
        emit(status(correlationId, "fleet_download", `Preparing ${missing.length} approved local model download${missing.length === 1 ? "" : "s"}.`));
        await pullLocalModels(
          this.config.ollamaBaseUrl,
          missing,
          createProgressRelay(correlationId, emit),
        );
      }

      const afterPull = await inspectOllama(this.config.ollamaBaseUrl);
      if (!afterPull.reachable || missingLocalModels(profile.modelRequirements, afterPull.models).length > 0) {
        throw new FleetControllerError("FLEET_PROVISION_FAILED", "The local runtime did not confirm every selected model. Check Ollama, then try again.");
      }

      await this.settings.setFleetProfile(profile.id);
      await this.settings.applyTo(this.config);
      await this.auditEvent(correlationId, "fleet_provision_completed", {
        profile: profile.id,
        context: profile.ollama.numCtx,
        keepAlive: profile.ollama.keepAlive,
        downloadedModels: missing.map(requirement => requirement.model),
      });
      emit(status(correlationId, "fleet_ready", `${profile.name} local models are ready. The Auditor will use this fleet; the Developer still follows its configured provider.`));
      // The returned snapshot is the phone's exit signal from the Fleet Setup
      // sheet. Provisioning state must be cleared before the snapshot is
      // captured, or the success response itself reports provisioning.active
      // and traps the phone in the sheet forever. The `finally` below stays as
      // the failure-path (and idempotent) guarantee.
      this.provisioningProfileId = undefined;
      return await this.snapshot();
    } catch (error) {
      await this.auditEvent(correlationId, "fleet_provision_failed", {
        profile: profileId,
        code: error instanceof FleetControllerError ? error.code : "FLEET_PROVISION_FAILED",
      });
      if (error instanceof FleetControllerError) throw error;
      // Model server errors can contain host-level detail. The phone gets a
      // neutral recovery message; the bridge terminal remains the owner-side
      // diagnostic surface.
      throw new FleetControllerError("FLEET_PROVISION_FAILED", "The local model download did not finish. Check the bridge terminal and Ollama, then try again.");
    } finally {
      this.provisioningProfileId = undefined;
    }
  }

  /**
   * A paired phone may save a provider key once, then toggle research without
   * another env edit. The settings store deliberately returns presence only.
   */
  public async configureResearch(
    correlationId: string,
    input: { enabled: boolean; braveSearchApiKey?: string },
  ): Promise<FleetSnapshot> {
    await this.settings.configureWebResearch({
      enabled: input.enabled,
      apiKey: input.braveSearchApiKey,
      hasExistingKey: Boolean(this.config.braveSearchApiKey),
    });
    await this.settings.applyTo(this.config);
    await this.auditEvent(correlationId, "web_research_configuration_changed", {
      enabled: input.enabled,
      keyProvided: Boolean(input.braveSearchApiKey?.trim()),
      provider: "brave",
    });
    return await this.snapshot();
  }

  private async auditEvent(correlationId: string, event: string, data: Record<string, unknown>): Promise<void> {
    // Audit storage is an accountability aid, not a reason to strand a local
    // model install after the owner explicitly approved it. Errors are kept
    // on the laptop and never expose data to the paired phone.
    await this.audit.append({ at: new Date().toISOString(), correlationId, agent: "system", event, data }).catch(() => undefined);
  }
}

function emptyHomeFleetSnapshot(): HomeFleetSnapshot {
  return { available: false, workerLimit: 4, workers: [] };
}

function toWireAssessment(assessment: import("./fleet-profiles.js").FleetProfileAssessment): FleetProfileAssessment {
  return {
    profile: toWireProfile(assessment.profile),
    canInstall: assessment.canInstall,
    readyNow: assessment.readyNow,
    readiness: assessment.readiness,
    reasons: assessment.reasons,
  };
}

function toWireProfile(profile: LocalFleetProfile): FleetProfile {
  const auditor = profile.assignments.find(assignment => assignment.role === "auditor");
  const developer = profile.assignments.find(assignment => assignment.role === "developer");
  // Every local profile is created from exactly these two roles. Throwing here
  // would be a package-author bug, not a remotely triggerable input path.
  if (!auditor || !developer) throw new Error("Fleet profile is missing a required local role.");
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    auditorModel: auditor.model,
    developerModel: developer.model,
    numCtx: profile.ollama.numCtx,
    maxLoadedModels: profile.ollama.maxLoadedModels,
    numParallel: profile.ollama.numParallel,
    keepAlive: profile.ollama.keepAlive,
    minimumTotalMemoryBytes: profile.capacity.minimumTotalMemoryBytes,
    minimumLogicalCores: profile.capacity.minimumLogicalCores,
    minimumFreeDiskBytes: profile.capacity.minimumFreeDiskBytes,
    estimatedDownloadBytes: profile.capacity.estimatedDownloadBytes,
    estimatedWorkingMemoryBytes: profile.capacity.estimatedWorkingMemoryBytes,
  };
}

function status(correlationId: string, stage: string, text: string): Extract<BridgeEvent, { type: "status" }> {
  return { type: "status", correlationId, agent: "system", stage, text };
}

/**
 * Ollama can emit hundreds of raw chunk progress records. The terminal still
 * gets detailed local activity, while this relay sends the phone a meaningful
 * state change or another update at most every 1.5 seconds per model.
 */
function createProgressRelay(correlationId: string, emit: FleetStatusSink): (progress: PullProgress) => void {
  const lastByModel = new Map<string, { marker: string; at: number }>();
  return progress => {
    const now = Date.now();
    const percent = progress.total && progress.completed !== undefined && progress.total > 0
      ? Math.min(100, Math.floor((progress.completed / progress.total) * 100))
      : undefined;
    const marker = `${progress.status}:${percent === undefined ? "" : Math.floor(percent / 10)}`;
    const prior = lastByModel.get(progress.model);
    if (prior?.marker === marker && now - prior.at < 1_500) return;
    lastByModel.set(progress.model, { marker, at: now });
    const suffix = percent === undefined ? "" : ` · ${percent}%`;
    emit(status(correlationId, "fleet_download", `${progress.model} · ${progress.status}${suffix}`));
  };
}
