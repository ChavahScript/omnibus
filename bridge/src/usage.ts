import type { ModelUsage, UsageStatus } from "./contracts.js";

/**
 * Tracks model usage for auditability without deciding whether a command may
 * run. The old budget guard was appropriate for the hackathon's construction
 * budget, but is the wrong control for a product whose normal path is local
 * inference and whose optional cloud costs belong to the owner's account.
 */
export class UsageLedger {
  private localRuns = 0;
  private cloudRuns = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private observedCloudUsd = 0;
  private estimatedCloudUsd = 0;

  public record(usage: ModelUsage): UsageStatus {
    if (usage.execution === "local") this.localRuns += 1;
    else this.cloudRuns += 1;
    this.inputTokens += normaliseCount(usage.inputTokens);
    this.outputTokens += normaliseCount(usage.outputTokens);
    this.observedCloudUsd += normaliseCurrency(usage.observedUsd);
    this.estimatedCloudUsd += normaliseCurrency(usage.estimatedUsd);
    return this.status();
  }

  public status(): UsageStatus {
    return {
      localRuns: this.localRuns,
      cloudRuns: this.cloudRuns,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      observedCloudUsd: roundCurrency(this.observedCloudUsd),
      estimatedCloudUsd: roundCurrency(this.estimatedCloudUsd),
    };
  }
}

/**
 * A Responses API reply reports tokens, not a bill. When the owner provides
 * current rates we record a transparent estimate; unknown/zero rates simply
 * remain unpriced and never block execution.
 */
export function estimateCloudUsd(
  inputTokens: number,
  outputTokens: number,
  inputUsdPerMillion: number,
  outputUsdPerMillion: number,
): number | undefined {
  if (
    !Number.isFinite(inputTokens)
    || !Number.isFinite(outputTokens)
    || inputTokens < 0
    || outputTokens < 0
    || !Number.isFinite(inputUsdPerMillion)
    || !Number.isFinite(outputUsdPerMillion)
    || inputUsdPerMillion <= 0
    || outputUsdPerMillion <= 0
  ) return undefined;
  return ((inputTokens * inputUsdPerMillion) + (outputTokens * outputUsdPerMillion)) / 1_000_000;
}

function normaliseCount(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normaliseCurrency(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}
