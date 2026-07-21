import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BiTemporalKnowledgeGraph } from "./knowledge-graph.js";
import type { BrainContribution, BrainFactOrigin } from "./types.js";

const ORIGIN: BrainFactOrigin = { channel: "manual" };

function makeClock(startIso: string): { now: () => Date; advance: (ms: number) => void } {
  let atMs = new Date(startIso).getTime();
  return {
    now: () => new Date(atMs),
    advance: (ms: number) => { atMs += ms; },
  };
}

test("nodes and facts are idempotent by normalized identity and content hash", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omnibus-brain-idem-"));
  try {
    const clock = makeClock("2026-07-19T10:00:00.000Z");
    const graph = new BiTemporalKnowledgeGraph(dir, { now: clock.now });
    await graph.load();

    const first = await graph.assertNode({ kind: "entity", name: "SQLite  Storage!" });
    clock.advance(1_000);
    const second = await graph.assertNode({ kind: "entity", name: "sqlite storage" });
    assert.equal(first.id, second.id);
    assert.equal(graph.nodes().length, 1);

    const factInput = {
      subject: { kind: "entity" as const, name: "the bridge" },
      predicate: "uses",
      object: { kind: "entity" as const, name: "sqlite storage" },
      factText: "The bridge uses sqlite storage",
      origin: ORIGIN,
    };
    const factA = await graph.assertFact(factInput);
    clock.advance(1_000);
    const factB = await graph.assertFact(factInput);
    assert.equal(factA.id, factB.id);
    assert.equal(graph.currentFacts().length, 1);
    assert.equal(graph.stats().facts, 1);

    const matches = graph.findNodesByName("SQLITE storage");
    assert.equal(matches[0]?.id, first.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("contradiction supersedes bi-temporally: old belief invalidated, never deleted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omnibus-brain-supersede-"));
  try {
    const clock = makeClock("2026-07-19T10:00:00.000Z");
    const graph = new BiTemporalKnowledgeGraph(dir, { now: clock.now });
    await graph.load();

    const t1 = clock.now().toISOString();
    const oldFact = await graph.assertFact({
      subject: { kind: "entity", name: "bridge storage" },
      predicate: "uses",
      object: { kind: "entity", name: "sqlite" },
      factText: "Bridge storage uses sqlite",
      origin: ORIGIN,
    });
    clock.advance(60_000);
    const newFact = await graph.assertFact({
      subject: { kind: "entity", name: "bridge storage" },
      predicate: "uses",
      object: { kind: "entity", name: "postgres" },
      factText: "Bridge storage uses postgres",
      origin: ORIGIN,
    });

    const current = graph.currentFacts();
    assert.deepEqual(current.map(fact => fact.id), [newFact.id]);

    // The superseded record is still fully readable "as of" the moment the
    // bridge believed it: invalidation closed its interval, nothing was lost.
    const beliefsAtT1 = graph.factsAsOf(t1, t1);
    assert.deepEqual(beliefsAtT1.map(fact => fact.id), [oldFact.id]);
    const oldRecord = beliefsAtT1[0]!;
    assert.equal(oldRecord.txInvalidatedAt, newFact.txCreatedAt);
    assert.equal(oldRecord.validTo, newFact.validFrom);

    const stats = graph.stats();
    assert.equal(stats.facts, 2);
    assert.equal(stats.currentFacts, 1);
    assert.equal(stats.invalidatedFacts, 1);

    // Present-time bi-temporal view: the old fact's intervals were closed
    // with the new fact's timestamps.
    clock.advance(60_000);
    const nowIso = clock.now().toISOString();
    const asOfNow = graph.factsAsOf(nowIso, nowIso);
    assert.deepEqual(asOfNow.map(fact => fact.id), [newFact.id]);

    // Coexist mode records a parallel belief without invalidating anything.
    clock.advance(1_000);
    await graph.assertFact({
      subject: { kind: "entity", name: "bridge storage" },
      predicate: "uses",
      object: { kind: "entity", name: "an in-memory cache" },
      factText: "Bridge storage also uses an in-memory cache",
      origin: ORIGIN,
      onConflict: "coexist",
    });
    assert.equal(graph.currentFacts().length, 2);

    const subjectNode = graph.findNodesByName("bridge storage")[0]!;
    const edges = graph.neighbors(subjectNode.id);
    assert.equal(edges.length, 2);
    assert.ok(edges.every(edge => edge.fact.txInvalidatedAt === null));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalidateFact journals once and rejects unknown or repeated invalidation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omnibus-brain-invalidate-"));
  try {
    const clock = makeClock("2026-07-19T10:00:00.000Z");
    const graph = new BiTemporalKnowledgeGraph(dir, { now: clock.now });
    await graph.load();
    const fact = await graph.assertFact({
      subject: { kind: "decision", name: "queue design" },
      predicate: "prefers",
      object: { kind: "entity", name: "single worker" },
      factText: "Queue design prefers a single worker",
      origin: ORIGIN,
    });
    clock.advance(1_000);
    assert.equal(await graph.invalidateFact(fact.id, "revisited"), true);
    assert.equal(await graph.invalidateFact(fact.id, "again"), false);
    assert.equal(await graph.invalidateFact("f-doesnotexist0000", "nope"), false);
    assert.equal(graph.currentFacts().length, 0);
    assert.equal(graph.stats().invalidatedFacts, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mergeContributions converges to byte-identical journal state in any arrival order", async () => {
  const dirA = await mkdtemp(path.join(os.tmpdir(), "omnibus-brain-merge-a-"));
  const dirB = await mkdtemp(path.join(os.tmpdir(), "omnibus-brain-merge-b-"));
  try {
    const c1: BrainContribution = {
      txCreatedAt: "2026-07-19T09:00:00.000Z",
      origin: { channel: "fleet-review", workerId: "worker-1" },
      text: "Omnibus targets iphone as the primary device",
      triples: [{ subject: "omnibus", predicate: "targets", object: "iphone" }],
    };
    const c2: BrainContribution = {
      txCreatedAt: "2026-07-19T09:05:00.000Z",
      origin: { channel: "fleet-review", workerId: "worker-2" },
      text: "Omnibus now targets ipad instead",
      triples: [{ subject: "omnibus", predicate: "targets", object: "ipad", factText: "Now targets iPad" }],
      confidence: 0.9,
    };
    const c3: BrainContribution = {
      txCreatedAt: "2026-07-19T09:00:00.000Z",
      origin: { channel: "diagnostics" },
      text: "Diagnostics run passed with zero type errors across the whole workspace today",
    };
    const c4: BrainContribution = { ...c1 }; // exact duplicate arriving twice

    const graphA = new BiTemporalKnowledgeGraph(dirA, { now: () => new Date("2026-07-19T12:00:00.000Z") });
    const graphB = new BiTemporalKnowledgeGraph(dirB, { now: () => new Date("2026-07-20T03:00:00.000Z") });
    await graphA.load();
    await graphB.load();

    const resultA = await graphA.mergeContributions([c1, c2, c3, c4]);
    const resultB = await graphB.mergeContributions([c4, c3, c2, c1]);
    assert.deepEqual(resultA, { applied: 3, duplicates: 1 });
    assert.deepEqual(resultB, resultA);

    // The strongest form of order-independence: the persisted journals are
    // byte-identical, so every replica converges without reconciliation.
    const journalA = await readFile(path.join(dirA, "graph.ndjson"), "utf8");
    const journalB = await readFile(path.join(dirB, "graph.ndjson"), "utf8");
    assert.equal(journalA, journalB);

    const dumpA = JSON.stringify({ nodes: graphA.nodes(), current: graphA.currentFacts(), stats: graphA.stats() });
    const dumpB = JSON.stringify({ nodes: graphB.nodes(), current: graphB.currentFacts(), stats: graphB.stats() });
    assert.equal(dumpA, dumpB);

    // The contradiction inside the batch resolved deterministically: iphone
    // superseded by ipad, but still explainable at its original moment.
    const currentTexts = graphA.currentFacts().map(fact => fact.factText);
    assert.ok(currentTexts.includes("Now targets iPad"));
    assert.ok(!currentTexts.some(text => text.includes("iphone")));
    const beliefsAtStart = graphA.factsAsOf("2026-07-19T09:00:00.000Z", "2026-07-19T09:00:00.000Z");
    assert.ok(beliefsAtStart.some(fact => fact.factText.includes("iphone")));
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test("journal reload round-trips and load() is a one-shot", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omnibus-brain-reload-"));
  try {
    const clock = makeClock("2026-07-19T10:00:00.000Z");
    const graph = new BiTemporalKnowledgeGraph(dir, { now: clock.now });
    await graph.load();
    const keep = await graph.assertFact({
      subject: { kind: "artifact", name: "src/queue.ts" },
      predicate: "implements",
      object: { kind: "entity", name: "durable job queue" },
      factText: "queue.ts implements the durable job queue",
      origin: ORIGIN,
    });
    clock.advance(1_000);
    const drop = await graph.assertFact({
      subject: { kind: "artifact", name: "src/queue.ts" },
      predicate: "depends on",
      object: { kind: "entity", name: "redis" },
      factText: "queue.ts depends on redis",
      origin: ORIGIN,
    });
    clock.advance(1_000);
    await graph.invalidateFact(drop.id, "never true", clock.now().toISOString());

    const reloaded = new BiTemporalKnowledgeGraph(dir, { now: clock.now });
    await reloaded.load();
    await reloaded.load(); // second load must not double-apply
    assert.deepEqual(reloaded.stats(), graph.stats());
    assert.deepEqual(reloaded.currentFacts(), graph.currentFacts());
    assert.equal(reloaded.currentFacts()[0]?.id, keep.id);
    const droppedNow = reloaded.factsAsOf(
      "2026-07-19T10:00:01.500Z",
      "2026-07-19T10:00:01.500Z",
    ).find(fact => fact.id === drop.id);
    assert.ok(droppedNow, "invalidated fact must survive reload for as-of queries");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupt journal lines are skipped without losing intact entries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omnibus-brain-corrupt-"));
  try {
    const clock = makeClock("2026-07-19T10:00:00.000Z");
    const graph = new BiTemporalKnowledgeGraph(dir, { now: clock.now });
    await graph.load();
    await graph.assertFact({
      subject: { kind: "entity", name: "tunnel" },
      predicate: "requires",
      object: { kind: "entity", name: "pairing" },
      factText: "The tunnel requires device pairing",
      origin: ORIGIN,
    });
    const expected = graph.stats();

    const journal = path.join(dir, "graph.ndjson");
    await appendFile(journal, "this is not json\n", "utf8");
    await appendFile(journal, '{"op":"mystery","at":"2026-07-19T10:00:00.000Z"}\n', "utf8");
    await appendFile(journal, '{"op":"fact","at":', "utf8"); // torn partial write

    const reloaded = new BiTemporalKnowledgeGraph(dir, { now: clock.now });
    await reloaded.load();
    assert.equal(reloaded.stats().nodes, expected.nodes);
    assert.equal(reloaded.stats().facts, expected.facts);
    assert.equal(reloaded.stats().currentFacts, expected.currentFacts);
    assert.equal(reloaded.currentFacts().length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capacity invalidates the oldest lowest-confidence beliefs instead of deleting", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omnibus-brain-capacity-"));
  try {
    const clock = makeClock("2026-07-19T10:00:00.000Z");
    const graph = new BiTemporalKnowledgeGraph(dir, { maxFacts: 3, now: clock.now });
    await graph.load();

    // One shared subject keeps the journal short enough that the capacity
    // invalidation entry is still readable before any compaction rewrite.
    const facts = [];
    const confidences = [0.9, 0.2, 0.8, 0.9];
    for (let index = 0; index < 4; index += 1) {
      facts.push(await graph.assertFact({
        subject: { kind: "entity", name: "bridge" },
        predicate: `relates-${index}`,
        object: { kind: "entity", name: `concept ${index}` },
        factText: `Bridge relates to concept ${index}`,
        origin: ORIGIN,
        confidence: confidences[index]!,
      }));
      clock.advance(1_000);
    }

    const stats = graph.stats();
    assert.equal(stats.facts, 4);
    assert.equal(stats.currentFacts, 3);
    assert.equal(stats.invalidatedFacts, 1);

    const currentIds = new Set(graph.currentFacts().map(fact => fact.id));
    assert.ok(!currentIds.has(facts[1]!.id), "lowest-confidence fact should be invalidated");
    assert.ok(currentIds.has(facts[0]!.id) && currentIds.has(facts[2]!.id) && currentIds.has(facts[3]!.id));

    const journal = await readFile(path.join(dir, "graph.ndjson"), "utf8");
    assert.ok(journal.includes('"reason":"capacity"'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("journal compaction rewrites atomically and preserves bi-temporal state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omnibus-brain-compact-"));
  try {
    const clock = makeClock("2026-07-19T10:00:00.000Z");
    const graph = new BiTemporalKnowledgeGraph(dir, { maxFacts: 3, now: clock.now });
    await graph.load();

    // Distinct subjects/objects inflate the journal past 4x maxFacts lines,
    // forcing at least one compaction along the way.
    for (let index = 0; index < 6; index += 1) {
      await graph.assertFact({
        subject: { kind: "entity", name: `service ${index}` },
        predicate: "emits",
        object: { kind: "entity", name: `signal ${index}` },
        factText: `Service ${index} emits signal ${index}`,
        origin: ORIGIN,
        confidence: 0.5,
      });
      clock.advance(1_000);
    }

    const journal = await readFile(path.join(dir, "graph.ndjson"), "utf8");
    const lineCount = journal.split("\n").filter(line => line.trim()).length;
    const stats = graph.stats();
    assert.ok(lineCount <= stats.nodes + stats.facts + 3, "journal should have been compacted");

    const reloaded = new BiTemporalKnowledgeGraph(dir, { maxFacts: 3, now: clock.now });
    await reloaded.load();
    assert.deepEqual(reloaded.stats(), stats);
    assert.deepEqual(reloaded.currentFacts(), graph.currentFacts());
    assert.equal(reloaded.stats().facts, 6);
    assert.equal(reloaded.stats().currentFacts, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stored text is redacted and bounded before it ever reaches the journal", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omnibus-brain-redact-"));
  try {
    const graph = new BiTemporalKnowledgeGraph(dir, { now: () => new Date("2026-07-19T10:00:00.000Z") });
    await graph.load();
    await graph.assertFact({
      subject: { kind: "event", name: "diagnostics run" },
      predicate: "records",
      object: { kind: "entity", name: "leaked config" },
      factText: "Found api_key=super-secret-value-123 and Bearer abc.def.ghi in output",
      origin: ORIGIN,
    });
    const journal = await readFile(path.join(dir, "graph.ndjson"), "utf8");
    assert.ok(!journal.includes("super-secret-value-123"));
    assert.ok(!journal.includes("abc.def.ghi"));
    assert.ok(journal.includes("[REDACTED]"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("node cap recycles spent event nodes so ambient learning continues", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omnibus-brain-recycle-"));
  try {
    const clock = makeClock("2026-07-19T10:00:00.000Z");
    const graph = new BiTemporalKnowledgeGraph(dir, { maxNodes: 4, maxFacts: 2, now: clock.now });
    await graph.load();

    // First 10 words identical: every contribution shares one object entity
    // node and mints exactly one fresh event node, so the node cap is the
    // only pressure being exercised.
    const base = "repeated ambient observation payload marker alpha beta gamma delta epsilon";
    for (let index = 0; index < 6; index += 1) {
      const result = await graph.mergeContributions([{
        txCreatedAt: clock.now().toISOString(),
        origin: { channel: "diagnostics" },
        text: `${base} tail-${index}`,
      }]);
      assert.equal(result.applied, 1, `contribution ${index} must still be learned at the node cap`);
      clock.advance(60_000);
    }

    const stats = graph.stats();
    assert.equal(stats.droppedForNodeCapacity ?? 0, 0, "recycling must prevent capacity drops");
    assert.ok(stats.nodes <= 4, "node cap must hold");
    assert.ok(
      graph.currentFacts().some(fact => fact.factText.includes("tail-5")),
      "the newest contribution must be a current belief",
    );

    const journal = await readFile(path.join(dir, "graph.ndjson"), "utf8");
    assert.ok(journal.includes('"op":"retire-node"'), "retirements must be journaled");

    // Retired event nodes stay gone after replay; only spent events left.
    const reloaded = new BiTemporalKnowledgeGraph(dir, { maxNodes: 4, maxFacts: 2, now: clock.now });
    await reloaded.load();
    assert.deepEqual(reloaded.stats(), stats);
    assert.deepEqual(reloaded.currentFacts(), graph.currentFacts());
    assert.equal(reloaded.nodes().filter(node => node.kind === "event").length, 3);
    // Durable kinds are never recycled: the shared entity node survives.
    assert.equal(reloaded.nodes().filter(node => node.kind === "entity").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compaction archives old invalidated facts: live journal and RAM stay bounded", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omnibus-brain-archive-"));
  try {
    const clock = makeClock("2026-07-19T10:00:00.000Z");
    const graph = new BiTemporalKnowledgeGraph(dir, { maxFacts: 2, compactSlackLines: 4, now: clock.now });
    await graph.load();

    // Endless supersession on one slot: every belief is invalidated by the
    // next, so invalidated history grows without bound unless archived.
    const total = 30;
    for (let index = 0; index < total; index += 1) {
      await graph.assertFact({
        subject: { kind: "entity", name: "bridge storage" },
        predicate: "uses",
        object: { kind: "entity", name: index % 2 === 0 ? "sqlite" : "postgres" },
        factText: `storage belief ${index}`,
        origin: ORIGIN,
      });
      clock.advance(60_000);
    }

    const liveLines = (await readFile(path.join(dir, "graph.ndjson"), "utf8"))
      .split("\n").filter(line => line.trim());
    assert.ok(liveLines.length <= 25, `live journal must stay bounded, saw ${liveLines.length}`);
    assert.ok(graph.stats().facts <= 10, "in-memory fact count must stay bounded");
    assert.equal(graph.currentFacts().length, 1);
    assert.equal(graph.currentFacts()[0]?.factText, `storage belief ${total - 1}`);

    const archiveLines = (await readFile(path.join(dir, "graph-archive.ndjson"), "utf8"))
      .split("\n").filter(line => line.trim());
    assert.ok(archiveLines.length >= 20, "old invalidated facts must overflow to the archive");
    for (const line of archiveLines) {
      const entry = JSON.parse(line) as { op: string; fact: { txInvalidatedAt: string | null } };
      assert.equal(entry.op, "fact");
      assert.notEqual(entry.fact.txInvalidatedAt, null, "only invalidated facts may go cold");
    }
    // Complete history: every fact is either live or archived, exactly once.
    const liveFactLines = liveLines.filter(line => (JSON.parse(line) as { op: string }).op === "fact");
    assert.equal(archiveLines.length + liveFactLines.length, total);

    // load() never reads the archive and still reproduces the live state.
    const reloaded = new BiTemporalKnowledgeGraph(dir, { maxFacts: 2, compactSlackLines: 4, now: clock.now });
    await reloaded.load();
    assert.deepEqual(reloaded.stats(), graph.stats());
    assert.deepEqual(reloaded.currentFacts(), graph.currentFacts());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compaction aborts instead of clobbering a concurrent instance's appends", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omnibus-brain-concurrent-"));
  try {
    const clock = makeClock("2026-07-19T10:00:00.000Z");
    const first = new BiTemporalKnowledgeGraph(dir, { maxFacts: 2, compactSlackLines: 4, now: clock.now });
    await first.load();
    const believe = async (index: number): Promise<void> => {
      await first.assertFact({
        subject: { kind: "entity", name: "bridge storage" },
        predicate: "uses",
        object: { kind: "entity", name: index % 2 === 0 ? "sqlite" : "postgres" },
        factText: `storage belief ${index}`,
        origin: ORIGIN,
      });
      clock.advance(60_000);
    };
    for (let index = 0; index < 6; index += 1) await believe(index); // 14 lines: below threshold

    // A second live instance on the same brainDir (hook check while the
    // bridge runs) appends entries the first instance never replayed.
    const second = new BiTemporalKnowledgeGraph(dir, { now: clock.now });
    await second.load();
    await second.assertFact({
      subject: { kind: "entity", name: "instance b marker" },
      predicate: "notes",
      object: { kind: "entity", name: "sibling process" },
      factText: "written by instance b",
      origin: ORIGIN,
    });

    // Push the first instance past its compaction threshold: every compact
    // attempt must now detect the foreign lines and abort.
    for (let index = 6; index < 10; index += 1) await believe(index);

    const journal = await readFile(path.join(dir, "graph.ndjson"), "utf8");
    assert.ok(journal.includes("written by instance b"), "concurrent append must survive");
    const lineCount = journal.split("\n").filter(line => line.trim()).length;
    assert.equal(lineCount, 25, "no rewrite may happen while instances disagree");

    // A fresh load reconciles both writers' history.
    const fresh = new BiTemporalKnowledgeGraph(dir, { now: clock.now });
    await fresh.load();
    const texts = fresh.currentFacts().map(fact => fact.factText);
    assert.ok(texts.includes("written by instance b"));
    assert.ok(texts.includes("storage belief 9"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
