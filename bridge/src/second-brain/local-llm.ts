import type { LocalLlm } from "./types.js";

/**
 * Local-only JSON generation against the owner's Ollama instance.
 *
 * The security posture here is deliberate: this client only ever targets the
 * configured base URL (loopback by default), model output is returned as
 * parsed data for the caller to schema-validate — never executed or templated
 * back into a command — and every failure mode (daemon down, HTTP error,
 * timeout, malformed JSON) collapses to `null` so Second Brain consumers are
 * forced through their deterministic heuristic fallbacks instead of throwing
 * out of background timers.
 */
export type OllamaJsonLlmOptions = {
  baseUrl: string;
  model: string;
  /** Passed through per-request; bounds model residency without touching global Ollama config. */
  keepAlive: string;
  numCtx: number;
  /** Injectable for tests; production always uses the platform fetch. */
  fetchImpl?: typeof fetch;
};

const DEFAULT_GENERATE_TIMEOUT_MS = 20_000;
const AVAILABILITY_PROBE_TIMEOUT_MS = 2_000;
const AVAILABILITY_CACHE_MS = 30_000;

export class OllamaJsonLlm implements LocalLlm {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly keepAlive: string;
  private readonly numCtx: number;
  private readonly fetchImpl: typeof fetch;
  private availability: { value: boolean; atMs: number } | null = null;

  public constructor(options: OllamaJsonLlmOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.keepAlive = options.keepAlive;
    this.numCtx = options.numCtx;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async generateJson(prompt: string, options: { timeoutMs?: number; keepAlive?: string } = {}): Promise<unknown | null> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_GENERATE_TIMEOUT_MS;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          format: "json",
          // Background callers (ambient watchers) pass "0" so a distillation
          // pass never extends model residency on a small laptop; foreground
          // callers inherit the configured window.
          keep_alive: options.keepAlive ?? this.keepAlive,
          options: { num_ctx: this.numCtx, temperature: 0 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as { response?: unknown };
      if (typeof payload?.response !== "string") return null;
      return parseModelJson(payload.response);
    } catch {
      // Timeouts, refused connections, and body-read failures are all normal
      // "Ollama is not around right now" states, never caller-visible errors.
      return null;
    }
  }

  public async available(): Promise<boolean> {
    const nowMs = Date.now();
    if (this.availability && nowMs - this.availability.atMs < AVAILABILITY_CACHE_MS) {
      return this.availability.value;
    }
    let value = false;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(AVAILABILITY_PROBE_TIMEOUT_MS),
      });
      value = response.ok;
    } catch {
      value = false;
    }
    // Both outcomes are cached: a down daemon should not be re-probed on
    // every ambient tick any more than a healthy one.
    this.availability = { value, atMs: nowMs };
    return value;
  }
}

/**
 * The always-absent LLM used by tests and OMNIBUS_SECOND_BRAIN heuristics-only
 * operation. Consumers that survive this survive a cold laptop.
 */
export class NullLlm implements LocalLlm {
  public async generateJson(_prompt: string, _options?: { timeoutMs?: number; keepAlive?: string }): Promise<unknown | null> {
    return null;
  }

  public async available(): Promise<boolean> {
    return false;
  }
}

/**
 * Local models frequently wrap JSON in a ```json fence or a sentence of
 * preamble even when asked for JSON only. Tolerating that here keeps the
 * "model output is data, callers schema-validate it" boundary in one place:
 * we extract the outermost {...} or [...] span and parse it, nothing more.
 */
function parseModelJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Fall through to span extraction.
  }
  const objectStart = trimmed.indexOf("{");
  const arrayStart = trimmed.indexOf("[");
  const starts = [objectStart, arrayStart].filter(index => index >= 0);
  if (starts.length === 0) return null;
  const start = Math.min(...starts);
  const closer = trimmed[start] === "{" ? "}" : "]";
  const end = trimmed.lastIndexOf(closer);
  if (end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}
