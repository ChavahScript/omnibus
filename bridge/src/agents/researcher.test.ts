import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AuditTrail } from "../audit.js";
import { loadConfig } from "../config.js";
import { deriveQuery, WebResearchAgent } from "./researcher.js";

test("research queries are derived only from the owner directive and stay inside provider limits", () => {
  const query = deriveQuery("  Compare\nprivate local LLM deployment options for a small product team.  ", 400);
  assert.equal(query, "Compare private local LLM deployment options for a small product team.");

  const longDirective = Array.from({ length: 80 }, (_, index) => `term${index}`).join(" ");
  const bounded = deriveQuery(longDirective, 400);
  assert.equal(bounded.split(" ").length, 50);
  assert.ok(bounded.length <= 400);
});

test("a requested web-research pass degrades to local-only work when the laptop has not enabled a provider", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "omnibus-researcher-test-"));
  try {
    const config = loadConfig({ cwd: workspace, env: { WEB_RESEARCH_ENABLED: "false" } });
    const outcome = await new WebResearchAgent(config, new AuditTrail(config.auditPath))
      .research("11111111-1111-4111-8111-111111111111", "Research a practical local-first developer tool.");
    assert.equal(outcome.kind, "unavailable");
    if (outcome.kind === "unavailable") assert.match(outcome.message, /not enabled/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
