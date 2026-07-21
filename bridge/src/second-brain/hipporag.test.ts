import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { extractEntities, HippoRagRetriever } from "./hipporag.js";
import { NullLlm, OllamaJsonLlm } from "./local-llm.js";
import {
  normalizeBrainName,
  type BrainFact,
  type BrainGraphStats,
  type BrainNode,
  type BrainNodeKind,
  type KnowledgeGraphApi,
  type LocalLlm,
} from "./types.js";

/**
 * Self-contained in-memory KnowledgeGraphApi stub so these tests never depend
 * on the persistence module landing first, on git, on Ollama, or on network.
 */
class StubGraph implements KnowledgeGraphApi {
  private readonly nodeList: BrainNode[] = [];
  private readonly factList: BrainFact[] = [];
  private tick = 0;

  public node(name: string, kind: BrainNodeKind = "entity"): BrainNode {
    const normalizedName = normalizeBrainName(name);
    const existing = this.nodeList.find(node => node.normalizedName === normalizedName && node.kind === kind);
    if (existing) return existing;
    const node: BrainNode = {
      id: `node-${this.nodeList.length + 1}`,
      kind,
      name,
      normalizedName,
      txCreatedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    };
    this.nodeList.push(node);
    return node;
  }

  public fact(
    subject: string,
    predicate: string,
    object: string,
    factText: string,
    options: { confidence?: number } = {},
  ): BrainFact {
    const subjectNode = this.node(subject);
    const objectNode = this.node(object);
    this.tick += 1;
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick)).toISOString();
    const fact: BrainFact = {
      id: `fact-${this.tick}`,
      subjectId: subjectNode.id,
      predicate,
      objectId: objectNode.id,
      factText,
      validFrom: at,
      validTo: null,
      txCreatedAt: at,
      txInvalidatedAt: null,
      origin: { channel: "manual" },
      confidence: options.confidence ?? 0.8,
      contentHash: createHash("sha256")
        .update(`${subjectNode.id}|${predicate}|${objectNode.id}|${factText}`)
        .digest("hex"),
    };
    this.factList.push(fact);
    return fact;
  }

  public async load(): Promise<void> {}

  public async assertNode(input: { kind: BrainNodeKind; name: string; summary?: string }): Promise<BrainNode> {
    return this.node(input.name, input.kind);
  }

  public async assertFact(input: {
    subject: { kind: BrainNodeKind; name: string };
    predicate: string;
    object: { kind: BrainNodeKind; name: string };
    factText: string;
    origin: BrainFact["origin"];
  }): Promise<BrainFact> {
    return this.fact(input.subject.name, input.predicate, input.object.name, input.factText);
  }

  public async invalidateFact(): Promise<boolean> {
    return false;
  }

  public currentFacts(): BrainFact[] {
    return this.factList.filter(fact => fact.txInvalidatedAt === null);
  }

  public factsAsOf(): BrainFact[] {
    return this.currentFacts();
  }

  public nodes(): BrainNode[] {
    return [...this.nodeList];
  }

  public nodeById(id: string): BrainNode | undefined {
    return this.nodeList.find(node => node.id === id);
  }

  public neighbors(nodeId: string): Array<{ fact: BrainFact; otherId: string }> {
    return this.currentFacts()
      .filter(fact => fact.subjectId === nodeId || fact.objectId === nodeId)
      .map(fact => ({ fact, otherId: fact.subjectId === nodeId ? fact.objectId : fact.subjectId }));
  }

  public findNodesByName(query: string): BrainNode[] {
    const normalized = normalizeBrainName(query);
    if (!normalized) return [];
    return this.nodeList.filter(node => node.normalizedName === normalized);
  }

  public async mergeContributions(): Promise<{ applied: number; duplicates: number }> {
    return { applied: 0, duplicates: 0 };
  }

  public stats(): BrainGraphStats {
    return {
      nodes: this.nodeList.length,
      facts: this.factList.length,
      currentFacts: this.currentFacts().length,
      invalidatedFacts: 0,
      updatedAt: null,
    };
  }
}

test("heuristic extraction pulls file paths, identifiers, backtick spans, and phrases", async () => {
  const result = await extractEntities(
    "Refactor src/auth/AuthService.ts so token_cache respects `RateLimiter` limits from Home Fleet reviews",
    new NullLlm(),
  );
  assert.equal(result.heuristic, true);
  assert.deepEqual(result.triples, []);
  assert.ok(result.entities.length <= 12);
  for (const expected of ["src/auth/AuthService.ts", "AuthService", "token_cache", "RateLimiter", "Home Fleet"]) {
    assert.ok(result.entities.includes(expected), `missing entity ${expected} in ${JSON.stringify(result.entities)}`);
  }
});

test("LLM extraction path validates, sanitizes, and caps model output", async () => {
  const fakeLlm: LocalLlm = {
    generateJson: async () => ({
      entities: [
        "  Queue\tService  ",
        "x".repeat(500),
        ...Array.from({ length: 30 }, (_, index) => `Entity${index}`),
      ],
      triples: Array.from({ length: 20 }, (_, index) => ({
        subject: `S${index}`,
        predicate: "depends on",
        object: `O${index}`,
      })),
    }),
    available: async () => true,
  };
  const result = await extractEntities("anything", fakeLlm);
  assert.equal(result.heuristic, false);
  assert.equal(result.entities.length, 12);
  assert.equal(result.entities[0], "Queue Service");
  assert.equal(result.entities[1], "x".repeat(120));
  assert.equal(result.triples.length, 8);
  assert.deepEqual(result.triples[0], { subject: "S0", predicate: "depends on", object: "O0" });
});

test("multi-hop: a query naming only A ranks facts about C above an unconnected component", async () => {
  const graph = new StubGraph();
  const abFact = graph.fact("AuthService", "writes sessions to", "TokenCache", "AuthService writes sessions to TokenCache");
  const bcFact = graph.fact("TokenCache", "is throttled by", "RateLimiter", "TokenCache is throttled by RateLimiter");
  const unconnectedFact = graph.fact("BillingEngine", "stores invoices in", "InvoiceStore", "BillingEngine stores invoices in InvoiceStore");

  const retriever = new HippoRagRetriever(graph, new NullLlm());
  const result = await retriever.retrieve("How should AuthService handle burst traffic safely?");

  assert.equal(result.heuristic, true);
  assert.deepEqual(result.seedNodeIds, [graph.node("AuthService").id]);
  const hashOf = (fact: BrainFact) => fact.contentHash;
  const indexOf = (fact: BrainFact) => result.facts.findIndex(entry => hashOf(entry.fact) === hashOf(fact));
  assert.ok(indexOf(abFact) >= 0, "direct fact must be retrieved");
  const cIndex = indexOf(bcFact);
  assert.ok(cIndex >= 0, "two-hop fact about RateLimiter must be retrieved from a query naming only AuthService");
  const unconnectedIndex = indexOf(unconnectedFact);
  assert.ok(
    unconnectedIndex === -1 || unconnectedIndex > cIndex,
    "unconnected-component fact must rank below the two-hop fact",
  );
  assert.ok(result.contextText.startsWith("Second Brain recall"));
  assert.ok(result.contextText.includes("TokenCache is throttled by RateLimiter"));
  assert.ok(result.contextText.includes("[brain:manual 2026-01-01]"));
  assert.ok(!result.contextText.includes("InvoiceStore"));
});

test("retrieval is deterministic across runs", async () => {
  const graph = new StubGraph();
  graph.fact("AuthService", "uses", "TokenCache", "AuthService uses TokenCache", { confidence: 0.9 });
  graph.fact("TokenCache", "expires via", "RateLimiter", "TokenCache expires via RateLimiter", { confidence: 0.6 });
  graph.fact("AuthService", "logs to", "AuditTrail", "AuthService logs to AuditTrail", { confidence: 0.7 });
  graph.fact("RateLimiter", "protects", "AuditTrail", "RateLimiter protects AuditTrail", { confidence: 0.5 });

  const retriever = new HippoRagRetriever(graph, new NullLlm());
  const first = await retriever.retrieve("Improve AuthService resilience");
  const second = await retriever.retrieve("Improve AuthService resilience");
  assert.deepEqual(first, second);
  assert.ok(first.facts.length > 0);
});

test("topK bounds the ranked facts and the context text", async () => {
  const graph = new StubGraph();
  for (let index = 0; index < 6; index += 1) {
    graph.fact("HubService", "links to", `Spoke${index}`, `HubService links to Spoke${index}`);
  }
  const retriever = new HippoRagRetriever(graph, new NullLlm(), { topK: 2 });
  const result = await retriever.retrieve("HubService fan-out");
  assert.equal(result.facts.length, 2);
  assert.equal(result.contextText.split("\n").length, 3);

  const overridden = await retriever.retrieve("HubService fan-out", { topK: 4 });
  assert.equal(overridden.facts.length, 4);
});

test("empty graph returns an empty retrieval result", async () => {
  const retriever = new HippoRagRetriever(new StubGraph(), new NullLlm());
  const result = await retriever.retrieve("AuthService throughput");
  assert.deepEqual(result.seedNodeIds, []);
  assert.deepEqual(result.facts, []);
  assert.equal(result.contextText, "");
});

test("no seed match returns an empty retrieval result", async () => {
  const graph = new StubGraph();
  graph.fact("BillingEngine", "stores invoices in", "InvoiceStore", "BillingEngine stores invoices in InvoiceStore");
  const retriever = new HippoRagRetriever(graph, new NullLlm());
  const result = await retriever.retrieve("AuthService throughput");
  assert.deepEqual(result.seedNodeIds, []);
  assert.deepEqual(result.facts, []);
  assert.equal(result.contextText, "");
});

test("NullLlm is inert", async () => {
  const llm = new NullLlm();
  assert.equal(await llm.generateJson("anything"), null);
  assert.equal(await llm.available(), false);
});

test("OllamaJsonLlm tolerates fenced JSON, fails closed, and caches availability", async () => {
  let generateCalls = 0;
  let tagCalls = 0;
  const fetchImpl: typeof fetch = async input => {
    const url = String(input);
    if (url.endsWith("/api/generate")) {
      generateCalls += 1;
      if (generateCalls === 2) return new Response("boom", { status: 500 });
      if (generateCalls === 3) throw new Error("connection refused");
      return new Response(
        JSON.stringify({ response: 'Sure, here you go:\n```json\n{"entities": ["QueueService"]}\n```' }),
        { status: 200 },
      );
    }
    tagCalls += 1;
    return new Response(JSON.stringify({ models: [] }), { status: 200 });
  };

  const llm = new OllamaJsonLlm({
    baseUrl: "http://127.0.0.1:11434/",
    model: "test-model",
    keepAlive: "5m",
    numCtx: 8_192,
    fetchImpl,
  });
  assert.deepEqual(await llm.generateJson("extract"), { entities: ["QueueService"] });
  assert.equal(await llm.generateJson("http error"), null);
  assert.equal(await llm.generateJson("network error"), null);

  assert.equal(await llm.available(), true);
  assert.equal(await llm.available(), true);
  assert.equal(tagCalls, 1, "availability probes must be cached");
});
