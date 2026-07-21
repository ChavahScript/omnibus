import type { AuditTrail } from "../audit.js";
import type { AppConfig } from "../config.js";
import { BraveSearchProvider, type WebResearchResult } from "../web-research.js";

/** Deliberately excludes workspace paths, model keys, and all other providers. */
export type WebResearchConfig = Pick<
  AppConfig,
  | "webResearchEnabled"
  | "webResearchProvider"
  | "braveSearchApiKey"
  | "webResearchMaxResults"
  | "webResearchTimeoutMs"
  | "webResearchQueryMaxChars"
  | "webResearchMaxContentChars"
>;

export type WebResearchOutcome =
  | { kind: "complete"; result: WebResearchResult }
  | { kind: "unavailable"; message: string };

/**
 * The only component permitted to contact the optional web provider.
 *
 * It receives the owner's per-request directive and produces sanitized public
 * search citations. It intentionally has no workspace root, local memory, or
 * model API credentials in its API surface, so those private inputs cannot be
 * accidentally added to a search request in a later refactor.
 */
export class WebResearchAgent {
  public constructor(private readonly config: WebResearchConfig, private readonly audit: AuditTrail) {}

  public async research(correlationId: string, directive: string): Promise<WebResearchOutcome> {
    if (!this.config.webResearchEnabled || !this.config.braveSearchApiKey) {
      const message = "Web research is not enabled on this laptop; Omnibus continued with the local review only.";
      await this.recordUnavailable(correlationId, "disabled", message);
      return { kind: "unavailable", message };
    }

    const query = deriveQuery(directive, this.config.webResearchQueryMaxChars);
    try {
      // The bridge finalizes key availability after it has loaded private
      // paired settings. It is passed directly to the provider adapter and is
      // never added to events, result objects, model prompts, or phone messages.
      const provider = new BraveSearchProvider({
        apiKey: this.config.braveSearchApiKey!,
        timeoutMs: this.config.webResearchTimeoutMs,
      });
      await this.audit.append({
        at: new Date().toISOString(),
        correlationId,
        agent: "auditor",
        event: "web_research_started",
        data: {
          provider: provider.name,
          query,
          maxResults: this.config.webResearchMaxResults,
          maxContentChars: this.config.webResearchMaxContentChars,
        },
      });
      const result = await provider.research({
        query,
        maxResults: this.config.webResearchMaxResults,
        maxContentChars: this.config.webResearchMaxContentChars,
      });
      await this.audit.append({
        at: new Date().toISOString(),
        correlationId,
        agent: "auditor",
        event: "web_research_complete",
        data: {
          provider: result.provider,
          query: result.query,
          retrievedAt: result.retrievedAt,
          citations: result.citations,
          diagnostics: result.diagnostics,
        },
      });
      return { kind: "complete", result };
    } catch (error) {
      // Search is an optional enrichment. A provider outage must not turn a
      // useful offline-first ideation run into a retried/failed queue job.
      const message = safeErrorMessage(error);
      await this.recordUnavailable(correlationId, "provider_error", message, query);
      return { kind: "unavailable", message };
    }
  }

  private async recordUnavailable(correlationId: string, reason: "disabled" | "provider_error", message: string, query?: string): Promise<void> {
    try {
      await this.audit.append({
        at: new Date().toISOString(),
        correlationId,
        agent: "auditor",
        event: "web_research_unavailable",
        data: { reason, message, ...(query ? { query } : {}) },
      });
    } catch {
      // Web research is deliberately degradable. A full audit volume must not
      // cause an otherwise local-only idea to be retried or rejected.
    }
  }
}

/**
 * Brave accepts at most 400 characters / 50 words in the adapter. Keeping the
 * query derived only from the explicit directive preserves the privacy split:
 * no workspace text or prior agent memory can ever leave the laptop here.
 */
export function deriveQuery(directive: string, maximumChars: number): string {
  const words = directive
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, 50);
  return words.join(" ").slice(0, Math.min(maximumChars, 400)).trim();
}

function safeErrorMessage(error: unknown): string {
  // Provider code already normalizes failures without exposing credentials;
  // bound the final string once more before it reaches the audit/phone UI.
  const message = error instanceof Error ? error.message : "Web research could not complete.";
  return `Web research was unavailable (${message.slice(0, 300)}). Omnibus continued with the local review only.`;
}
