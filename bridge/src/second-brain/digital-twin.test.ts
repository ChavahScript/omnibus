import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodeDigitalTwin } from "./digital-twin.js";
import {
  normalizeBrainName,
  type BrainFact,
  type BrainGraphStats,
  type BrainNode,
  type BrainNodeKind,
  type KnowledgeGraphApi,
  type RetrievalResult,
  type RetrieverApi,
} from "./types.js";

const CONFIG = {
  workspaceContextMaxFiles: 24,
  workspaceContextMaxSnippets: 4,
  workspaceContextMaxChars: 8_000,
};

/**
 * In-test stand-in for the knowledge graph. The real implementation is owned
 * by another module; the twin only needs assertFact/nodeById/currentFacts to
 * behave, so this stub records everything in memory.
 */
class StubGraph implements KnowledgeGraphApi {
  public readonly facts: BrainFact[] = [];
  private readonly nodesById = new Map<string, BrainNode>();
  private readonly idsByKey = new Map<string, string>();
  private counter = 0;

  public async load(): Promise<void> {}

  public async assertNode(input: { kind: BrainNodeKind; name: string; summary?: string }): Promise<BrainNode> {
    return this.ensureNode(input.kind, input.name);
  }

  public async assertFact(input: {
    subject: { kind: BrainNodeKind; name: string };
    predicate: string;
    object: { kind: BrainNodeKind; name: string };
    factText: string;
    origin: BrainFact["origin"];
    validFrom?: string;
    confidence?: number;
    onConflict?: "supersede" | "coexist";
  }): Promise<BrainFact> {
    const subject = this.ensureNode(input.subject.kind, input.subject.name);
    const object = this.ensureNode(input.object.kind, input.object.name);
    const at = new Date().toISOString();
    const fact: BrainFact = {
      id: `f${(this.counter += 1)}`,
      subjectId: subject.id,
      predicate: input.predicate,
      objectId: object.id,
      factText: input.factText,
      validFrom: input.validFrom ?? at,
      validTo: null,
      txCreatedAt: at,
      txInvalidatedAt: null,
      origin: input.origin,
      confidence: input.confidence ?? 0.9,
      contentHash: createHash("sha256")
        .update(`${subject.id}|${input.predicate}|${object.id}|${input.factText}`)
        .digest("hex"),
    };
    this.facts.push(fact);
    return fact;
  }

  public async invalidateFact(): Promise<boolean> {
    return false;
  }

  public currentFacts(): BrainFact[] {
    return this.facts.filter(fact => fact.txInvalidatedAt === null);
  }

  public factsAsOf(): BrainFact[] {
    return [];
  }

  public nodes(): BrainNode[] {
    return [...this.nodesById.values()];
  }

  public nodeById(id: string): BrainNode | undefined {
    return this.nodesById.get(id);
  }

  public neighbors(): Array<{ fact: BrainFact; otherId: string }> {
    return [];
  }

  public findNodesByName(): BrainNode[] {
    return [];
  }

  public async mergeContributions(): Promise<{ applied: number; duplicates: number }> {
    return { applied: 0, duplicates: 0 };
  }

  public stats(): BrainGraphStats {
    return {
      nodes: this.nodesById.size,
      facts: this.facts.length,
      currentFacts: this.facts.length,
      invalidatedFacts: 0,
      updatedAt: null,
    };
  }

  public nodeName(id: string): string {
    return this.nodesById.get(id)?.name ?? "";
  }

  private ensureNode(kind: BrainNodeKind, name: string): BrainNode {
    const key = `${kind}|${normalizeBrainName(name)}`;
    const existingId = this.idsByKey.get(key);
    if (existingId) return this.nodesById.get(existingId)!;
    const node: BrainNode = {
      id: `n${(this.counter += 1)}`,
      kind,
      name,
      normalizedName: normalizeBrainName(name) || name.toLowerCase(),
      txCreatedAt: new Date().toISOString(),
    };
    this.nodesById.set(node.id, node);
    this.idsByKey.set(key, node.id);
    return node;
  }
}

async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "omnibus-twin-ws-"));
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(
    path.join(workspace, "src", "alpha.ts"),
    'export function alphaThing(): number {\n  return 1;\n}\n\nexport const alphaValue = "hello";\n',
    "utf8",
  );
  await writeFile(
    path.join(workspace, "src", "beta.ts"),
    "export class BetaService {\n  run(): void {}\n}\n",
    "utf8",
  );
  return workspace;
}

test("syncArtifacts records artifact and export facts, then reports unchanged on re-sync", async () => {
  const workspace = await makeWorkspace();
  const brainDir = await mkdtemp(path.join(os.tmpdir(), "omnibus-twin-brain-"));
  try {
    const graph = new StubGraph();
    const twin = new CodeDigitalTwin({
      workspacePath: workspace,
      brainDir,
      graph,
      config: CONFIG,
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });

    const first = await twin.syncArtifacts();
    assert.equal(first.changed, true);
    assert.equal(first.artifacts, 2);

    const artifactFacts = graph.facts.filter(fact => fact.predicate === "is-artifact");
    assert.equal(artifactFacts.length, 2);
    for (const fact of artifactFacts) {
      assert.equal(fact.origin.channel, "twin");
      assert.match(fact.factText, /is a tracked workspace artifact$/);
      assert.equal(graph.nodeById(fact.subjectId)?.kind, "artifact");
      assert.equal(graph.nodeName(fact.objectId), "ts");
    }
    const paths = artifactFacts.map(fact => graph.nodeName(fact.subjectId)).sort();
    assert.deepEqual(paths, ["src/alpha.ts", "src/beta.ts"]);

    const exported = graph.facts
      .filter(fact => fact.predicate === "exports")
      .map(fact => graph.nodeName(fact.objectId))
      .sort();
    assert.deepEqual(exported, ["BetaService", "alphaThing", "alphaValue"]);

    const factCountAfterFirst = graph.facts.length;
    const second = await twin.syncArtifacts();
    assert.equal(second.changed, false);
    assert.equal(second.artifacts, 2);
    assert.equal(graph.facts.length, factCountAfterFirst, "an unchanged workspace must cost zero graph writes");

    // A content change moves the digest and triggers a re-record.
    await writeFile(path.join(workspace, "src", "beta.ts"), "export class BetaService {\n  run(): void {}\n}\n// changed\n", "utf8");
    const third = await twin.syncArtifacts();
    assert.equal(third.changed, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(brainDir, { recursive: true, force: true });
  }
});

test("recordDecision and recordBugFix produce bounded graph facts with the right shape", async () => {
  const workspace = await makeWorkspace();
  const brainDir = await mkdtemp(path.join(os.tmpdir(), "omnibus-twin-brain-"));
  try {
    const graph = new StubGraph();
    const twin = new CodeDigitalTwin({ workspacePath: workspace, brainDir, graph, config: CONFIG });

    await twin.recordDecision({
      title: "Serial queue over parallel workers",
      rationale: "One durable job at a time keeps local models from accumulating unbounded work",
      tradeoff: "Throughput is capped at one idea at a time",
      origin: { channel: "manual" },
    });
    const rationaleFact = graph.facts.find(fact => fact.predicate === "rationale");
    assert.ok(rationaleFact);
    assert.equal(graph.nodeById(rationaleFact.subjectId)?.kind, "decision");
    assert.equal(rationaleFact.factText, "Decision: Serial queue over parallel workers. Rationale: One durable job at a time keeps local models from accumulating unbounded work");
    const tradeoffFact = graph.facts.find(fact => fact.predicate === "trades-off");
    assert.ok(tradeoffFact);
    assert.equal(tradeoffFact.subjectId, rationaleFact.subjectId);

    await twin.recordBugFix({
      title: "Queue stuck after crash",
      cause: "The in-flight job was never returned to pending on restart",
      fix: "Requeue any running job during load with a fresh attempt counter",
      origin: { channel: "diagnostics" },
    });
    const causedBy = graph.facts.find(fact => fact.predicate === "caused-by");
    const fixedBy = graph.facts.find(fact => fact.predicate === "fixed-by");
    assert.ok(causedBy);
    assert.ok(fixedBy);
    assert.equal(graph.nodeById(causedBy.subjectId)?.kind, "bugfix");
    assert.equal(causedBy.subjectId, fixedBy.subjectId);
    assert.match(causedBy.factText, /^Bug fix: Queue stuck after crash\. Cause: /);
    assert.match(fixedBy.factText, /^Bug fix: Queue stuck after crash\. Fix: /);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(brainDir, { recursive: true, force: true });
  }
});

test("preventionContext without a retriever falls back to recent bugfix/decision facts and stays bounded", async () => {
  const workspace = await makeWorkspace();
  const brainDir = await mkdtemp(path.join(os.tmpdir(), "omnibus-twin-brain-"));
  try {
    const graph = new StubGraph();
    const twin = new CodeDigitalTwin({ workspacePath: workspace, brainDir, graph, config: CONFIG });

    assert.equal(await twin.preventionContext("anything"), "", "an empty graph yields no context");

    await twin.recordBugFix({
      title: "Tunnel handshake loop",
      cause: "Reconnect fired before the previous socket closed",
      fix: "Debounce reconnects behind a single timer",
      origin: { channel: "manual" },
    });
    // Entity-to-entity noise must never surface as prevention context.
    await graph.assertFact({
      subject: { kind: "entity", name: "express" },
      predicate: "is-dependency",
      object: { kind: "entity", name: "http server" },
      factText: "express is an http server dependency",
      origin: { channel: "twin" },
    });

    const context = await twin.preventionContext("tunnel reconnect");
    assert.ok(context.startsWith("Relevant past incidents and decisions (do not repeat these mistakes):"));
    assert.ok(context.includes("Tunnel handshake loop"));
    assert.ok(!context.includes("express is an http server dependency"));
    assert.ok(context.length <= 2_000);

    const tight = await twin.preventionContext("tunnel reconnect", 30);
    assert.equal(tight, "", "a budget too small for any fact yields empty context");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(brainDir, { recursive: true, force: true });
  }
});

test("preventionContext with a retriever keeps only bugfix/decision/antipattern facts", async () => {
  const workspace = await makeWorkspace();
  const brainDir = await mkdtemp(path.join(os.tmpdir(), "omnibus-twin-brain-"));
  try {
    const graph = new StubGraph();
    const bugFact = await graph.assertFact({
      subject: { kind: "bugfix", name: "Watchdog starved the queue" },
      predicate: "caused-by",
      object: { kind: "entity", name: "busy loop" },
      factText: "Bug fix: Watchdog starved the queue. Cause: busy loop without backoff",
      origin: { channel: "manual" },
    });
    const noiseFact = await graph.assertFact({
      subject: { kind: "entity", name: "zod" },
      predicate: "validates",
      object: { kind: "entity", name: "schemas" },
      factText: "zod validates schemas",
      origin: { channel: "twin" },
    });

    const queries: string[] = [];
    const retriever: RetrieverApi = {
      async retrieve(query: string): Promise<RetrievalResult> {
        queries.push(query);
        return {
          entities: ["watchdog"],
          seedNodeIds: [bugFact.subjectId],
          facts: [
            { fact: bugFact, score: 0.9, subjectName: "Watchdog starved the queue", objectName: "busy loop" },
            { fact: noiseFact, score: 0.5, subjectName: "zod", objectName: "schemas" },
          ],
          contextText: "",
          heuristic: true,
        };
      },
    };
    const twin = new CodeDigitalTwin({ workspacePath: workspace, brainDir, graph, config: CONFIG, retriever });

    const context = await twin.preventionContext("watchdog");
    assert.deepEqual(queries, ["watchdog"]);
    assert.ok(context.includes("Watchdog starved the queue"));
    assert.ok(!context.includes("zod validates schemas"));

    // A throwing retriever degrades to the deterministic fallback.
    const broken: RetrieverApi = {
      async retrieve(): Promise<RetrievalResult> {
        throw new Error("retriever offline");
      },
    };
    const degraded = new CodeDigitalTwin({ workspacePath: workspace, brainDir, graph, config: CONFIG, retriever: broken });
    const fallback = await degraded.preventionContext("watchdog");
    assert.ok(fallback.includes("Watchdog starved the queue"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(brainDir, { recursive: true, force: true });
  }
});
