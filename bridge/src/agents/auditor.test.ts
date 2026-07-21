import assert from "node:assert/strict";
import test from "node:test";
import type { AuditTrail } from "../audit.js";
import type { AppConfig } from "../config.js";
import { LocalAuditor } from "./auditor.js";

const auditStub = { append: async () => undefined } as unknown as AuditTrail;

/**
 * A deliberately non-loopback Ollama endpoint keeps workspace and memory
 * context out of the prompt, so the test never touches the filesystem; the
 * stubbed fetch below intercepts the request before any network is used.
 */
function auditorConfig(): AppConfig {
  return {
    developerProvider: "ollama",
    ollamaBaseUrl: "http://ollama.fleet.internal:11434",
    ollamaModel: "test-model",
    ollamaNumCtx: 2_048,
    ollamaKeepAlive: "5m",
  } as AppConfig;
}

function splitInto(value: string, parts: number): string[] {
  const size = Math.ceil(value.length / parts);
  const out: string[] = [];
  for (let index = 0; index < value.length; index += size) out.push(value.slice(index, index + size));
  return out;
}

test("auditor emits a throttled heartbeat while stream chunks arrive", async () => {
  let now = 0;
  const auditJson = JSON.stringify({
    enrichedDirective: "Do the audited thing carefully.",
    riskSummary: ["low blast radius"],
    rationaleSummary: "Deterministic heartbeat test fixture.",
    estimatedInputTokens: 10,
    estimatedOutputTokens: 10,
  });
  // Eight response chunks arriving one fake second apart: heartbeats are due
  // at t>=2500 (fires at 3000) and t>=5500 (fires at 6000) — exactly two.
  const pieces = splitInto(auditJson, 8);
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < pieces.length) {
        now += 1_000;
        controller.enqueue(encoder.encode(`${JSON.stringify({ response: pieces[index] })}\n`));
        index += 1;
      } else if (index === pieces.length) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ done: true, eval_count: 10, prompt_eval_count: 10 })}\n`));
        index += 1;
      } else {
        controller.close();
      }
    },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, body })) as unknown as typeof fetch;
  try {
    const auditor = new LocalAuditor(auditorConfig(), auditStub, () => now);
    const heartbeats: string[] = [];
    const result = await auditor.enrich(
      "33333333-3333-4333-8333-333333333333",
      "Build the durable thing.",
      undefined,
      undefined,
      undefined,
      text => heartbeats.push(text),
    );
    assert.equal(result.enrichedDirective, "Do the audited thing carefully.");
    assert.deepEqual(heartbeats, [
      "Auditor is still reviewing locally…",
      "Auditor is still reviewing locally…",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("auditor stays silent without an onProgress callback", async () => {
  let now = 0;
  const auditJson = JSON.stringify({
    enrichedDirective: "Quiet path.",
    riskSummary: [],
    rationaleSummary: "No heartbeat consumer.",
    estimatedInputTokens: 5,
    estimatedOutputTokens: 5,
  });
  const encoder = new TextEncoder();
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        now += 10_000;
        controller.enqueue(encoder.encode(`${JSON.stringify({ response: auditJson })}\n${JSON.stringify({ done: true })}\n`));
      } else {
        controller.close();
      }
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, body })) as unknown as typeof fetch;
  try {
    const auditor = new LocalAuditor(auditorConfig(), auditStub, () => now);
    const result = await auditor.enrich("44444444-4444-4444-8444-444444444444", "Build it quietly.");
    assert.equal(result.enrichedDirective, "Quiet path.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
