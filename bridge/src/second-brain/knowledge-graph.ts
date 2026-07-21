import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  BrainJournalEntrySchema,
  normalizeBrainName,
  redactBrainText,
  sanitizeBrainText,
  type BrainContribution,
  type BrainFact,
  type BrainFactOrigin,
  type BrainGraphStats,
  type BrainJournalEntry,
  type BrainNode,
  type BrainNodeKind,
  type KnowledgeGraphApi,
} from "./types.js";

/**
 * Bi-temporal knowledge graph over an append-only NDJSON journal.
 *
 * Two design commitments shape everything here:
 *
 * 1. Nothing is ever deleted or overwritten. A contradicted fact is
 *    bi-temporally invalidated — its transaction interval is closed — so an
 *    "as of" query can still explain what the bridge believed at any past
 *    moment. Deprecated architecture decisions remain inspectable evidence,
 *    not lost history.
 *
 * 2. Every identifier is content-derived. Node ids hash (kind, normalized
 *    name); fact ids hash (contentHash, txCreatedAt); merge application order
 *    is a total sort on (txCreatedAt, text hash). Contributions that arrive
 *    in any order — for example Home Fleet peer reviews finishing while the
 *    phone was offline — therefore converge to byte-identical journal state
 *    on every replica, with no coordination protocol to get wrong.
 *
 * All stored text passes through redactBrainText + sanitizeBrainText at the
 * write boundary, so a secret that leaks into a diff or diagnostics run can
 * never persist into graph state, the fleet bundle, or any downstream prompt.
 * The journal itself is owner-only (dir 0o700, file 0o600) local state; it is
 * never phone-bound.
 */

const FACT_TEXT_MAX = 1_200;
const NODE_NAME_MAX = 240;
const NODE_SUMMARY_MAX = 2_000;
const PREDICATE_MAX = 120;
const REASON_MAX = 400;
const FIND_RESULT_CAP = 16;
/** Bounded triple fan-out per contribution so a hostile payload stays small. */
const MERGE_TRIPLES_CAP = 32;

const IsoDateTime = z.string().datetime();

type AssertNodeInput = { kind: BrainNodeKind; name: string; summary?: string };
type AssertFactInput = Parameters<KnowledgeGraphApi["assertFact"]>[0];

export class BiTemporalKnowledgeGraph implements KnowledgeGraphApi {
  private readonly journalPath: string;
  private readonly maxNodes: number;
  private readonly maxFacts: number;
  private readonly now: () => Date;

  private loaded = false;
  /**
   * Set when the journal exists but could not be read (EIO, EACCES, …).
   * Every mutation then becomes a no-op: appending to — or worse, compacting
   * from — an unknowingly empty memory image would overwrite real history
   * with a truncated one. A later load() retry clears it on success.
   */
  private loadFailed = false;
  private journalLines = 0;
  private lastEntryAt: string | null = null;
  private currentCount = 0;
  private droppedForNodeCapacity = 0;
  /** Serializes journal appends and compaction; see record(). */
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly nodesById = new Map<string, BrainNode>();
  private readonly nodeIdByKey = new Map<string, string>();
  private readonly factsById = new Map<string, BrainFact>();
  /** Latest fact id per contentHash; at most one of these is ever current. */
  private readonly factIdByContentHash = new Map<string, string>();
  private readonly adjacency = new Map<string, Set<string>>();

  public constructor(
    private readonly brainDir: string,
    options: { maxNodes?: number; maxFacts?: number; now?: () => Date } = {},
  ) {
    this.journalPath = path.join(brainDir, "graph.ndjson");
    this.maxNodes = options.maxNodes ?? 4_000;
    this.maxFacts = options.maxFacts ?? 12_000;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Replays the journal once; a second call is a no-op so callers may load
   * defensively. Corrupt lines (for example the tail of a partial write at
   * crash time) are skipped silently — a torn append must never brick the
   * brain, and every entry that did land intact is still honored.
   */
  public async load(): Promise<void> {
    if (this.loaded) return;
    let raw: string;
    try {
      raw = await readFile(this.journalPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // A missing journal is a legitimate fresh brain.
        this.loaded = true;
        this.loadFailed = false;
        return;
      }
      // The journal exists but is unreadable right now. Do NOT mark loaded:
      // a retry may succeed, and until it does the graph refuses writes so a
      // future compaction can never rewrite real history from empty memory.
      this.loadFailed = true;
      throw error;
    }
    this.loaded = true;
    this.loadFailed = false;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      this.journalLines += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = BrainJournalEntrySchema.safeParse(parsed);
      if (!entry.success) continue;
      this.applyToMemory(entry.data);
    }
  }

  public async assertNode(input: AssertNodeInput): Promise<BrainNode> {
    return await this.assertNodeAt(input, this.now().toISOString());
  }

  public async assertFact(input: AssertFactInput): Promise<BrainFact> {
    const { fact } = await this.assertFactAt(input, this.now().toISOString());
    return { ...fact };
  }

  public async invalidateFact(factId: string, reason: string, validTo?: string | null): Promise<boolean> {
    const fact = this.factsById.get(factId);
    if (!fact || fact.txInvalidatedAt !== null) return false;
    const at = this.now().toISOString();
    const endsAt = validTo !== undefined && (validTo === null || IsoDateTime.safeParse(validTo).success)
      ? validTo
      : fact.validTo;
    await this.record({
      op: "invalidate",
      at,
      factId,
      validTo: endsAt,
      reason: cleanText(reason, REASON_MAX),
    });
    return true;
  }

  public currentFacts(): BrainFact[] {
    return [...this.factsById.values()]
      .filter(fact => fact.txInvalidatedAt === null)
      .sort(compareTxThenId)
      .map(fact => ({ ...fact }));
  }

  public factsAsOf(validTime: string, txTime?: string): BrainFact[] {
    const validMs = Date.parse(validTime);
    const txMs = Date.parse(txTime ?? this.now().toISOString());
    if (Number.isNaN(validMs) || Number.isNaN(txMs)) return [];
    return [...this.factsById.values()]
      .filter(fact =>
        Date.parse(fact.txCreatedAt) <= txMs
        && (fact.txInvalidatedAt === null || Date.parse(fact.txInvalidatedAt) > txMs)
        && Date.parse(fact.validFrom) <= validMs
        && (fact.validTo === null || Date.parse(fact.validTo) > validMs))
      .sort(compareTxThenId)
      .map(fact => ({ ...fact }));
  }

  public nodes(): BrainNode[] {
    return [...this.nodesById.values()].sort(compareTxThenId);
  }

  public nodeById(id: string): BrainNode | undefined {
    return this.nodesById.get(id);
  }

  public neighbors(nodeId: string): Array<{ fact: BrainFact; otherId: string }> {
    const factIds = this.adjacency.get(nodeId);
    if (!factIds) return [];
    const edges: Array<{ fact: BrainFact; otherId: string }> = [];
    for (const factId of factIds) {
      const fact = this.factsById.get(factId);
      if (!fact || fact.txInvalidatedAt !== null) continue;
      edges.push({ fact: { ...fact }, otherId: fact.subjectId === nodeId ? fact.objectId : fact.subjectId });
    }
    return edges.sort((a, b) => compareTxThenId(a.fact, b.fact));
  }

  public findNodesByName(query: string): BrainNode[] {
    const normalizedQuery = normalizeBrainName(cleanText(query, NODE_NAME_MAX));
    if (!normalizedQuery) return [];
    const tokens = normalizedQuery.split(" ").filter(Boolean);
    const scored: Array<{ node: BrainNode; score: number }> = [];
    for (const node of this.nodesById.values()) {
      if (node.normalizedName === normalizedQuery) {
        scored.push({ node, score: Number.MAX_SAFE_INTEGER });
        continue;
      }
      const nodeTokens = new Set(node.normalizedName.split(" "));
      let shared = 0;
      for (const token of tokens) if (nodeTokens.has(token)) shared += 1;
      if (shared > 0 && shared * 2 >= tokens.length) scored.push({ node, score: shared });
    }
    return scored
      .sort((a, b) => b.score - a.score || compareStrings(a.node.id, b.node.id))
      .slice(0, FIND_RESULT_CAP)
      .map(entry => entry.node);
  }

  /**
   * The deterministic offline-merge primitive. Contributions are totally
   * ordered by (txCreatedAt, sha256 of text) and deduplicated on the text
   * hash before applying, so any arrival order of the same set produces the
   * same application sequence — and because every id and timestamp written
   * during a merge derives from contribution content (never the wall clock),
   * the resulting journal is byte-identical across replicas.
   */
  public async mergeContributions(contributions: BrainContribution[]): Promise<{ applied: number; duplicates: number }> {
    const ordered = contributions
      .map(contribution => ({ contribution, textHash: sha256Hex(contribution.text) }))
      .sort((a, b) =>
        compareStrings(a.contribution.txCreatedAt, b.contribution.txCreatedAt)
        || compareStrings(a.textHash, b.textHash));
    const seen = new Set<string>();
    let applied = 0;
    let duplicates = 0;
    for (const { contribution, textHash } of ordered) {
      if (seen.has(textHash)) {
        duplicates += 1;
        continue;
      }
      seen.add(textHash);
      const txCreatedAt = IsoDateTime.safeParse(contribution.txCreatedAt).success
        ? contribution.txCreatedAt
        : this.now().toISOString();
      const text = cleanText(contribution.text, FACT_TEXT_MAX) || "(empty)";
      const triples = (contribution.triples ?? []).slice(0, MERGE_TRIPLES_CAP);
      let created = false;
      if (triples.length > 0) {
        for (const triple of triples) {
          const result = await this.assertFactAt({
            subject: { kind: "entity", name: triple.subject },
            predicate: triple.predicate,
            object: { kind: "entity", name: triple.object },
            factText: triple.factText ?? text,
            origin: contribution.origin,
            validFrom: txCreatedAt,
            ...(contribution.confidence === undefined ? {} : { confidence: contribution.confidence }),
            onConflict: "supersede",
          }, txCreatedAt);
          created = created || result.created;
        }
      } else {
        // The event node is named by content hash, not timestamp: a queue
        // retry re-capturing the same text converges on the same node and
        // fact instead of minting a fresh per-attempt record forever.
        const result = await this.assertFactAt({
          subject: { kind: "event", name: `${contribution.origin.channel} ${textHash.slice(0, 12)}` },
          predicate: "records",
          object: { kind: "entity", name: text.split(" ").slice(0, 10).join(" ") },
          factText: text,
          origin: contribution.origin,
          validFrom: txCreatedAt,
          ...(contribution.confidence === undefined ? {} : { confidence: contribution.confidence }),
          onConflict: "supersede",
        }, txCreatedAt);
        created = result.created;
      }
      if (created) applied += 1;
      else duplicates += 1;
    }
    return { applied, duplicates };
  }

  public stats(): BrainGraphStats {
    return {
      nodes: this.nodesById.size,
      facts: this.factsById.size,
      currentFacts: this.currentCount,
      invalidatedFacts: this.factsById.size - this.currentCount,
      updatedAt: this.lastEntryAt,
      ...(this.droppedForNodeCapacity ? { droppedForNodeCapacity: this.droppedForNodeCapacity } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Node identity is (kind, normalizedName): the id is a content hash of that
   * pair, so two replicas that learn the same concept independently mint the
   * same node and their fact edges line up without reconciliation.
   */
  private async assertNodeAt(input: AssertNodeInput, at: string): Promise<BrainNode> {
    const name = cleanText(input.name, NODE_NAME_MAX) || "unknown";
    const normalizedName = normalizeBrainName(name) || "unknown";
    const key = `${input.kind}|${normalizedName}`;
    const existingId = this.nodeIdByKey.get(key);
    if (existingId) {
      const existing = this.nodesById.get(existingId);
      if (existing) return existing;
    }
    const summary = input.summary === undefined ? "" : cleanText(input.summary, NODE_SUMMARY_MAX);
    const node: BrainNode = {
      id: `n-${sha256Hex(`${input.kind}|${normalizedName}`).slice(0, 16)}`,
      kind: input.kind,
      name,
      normalizedName,
      ...(summary ? { summary } : {}),
      txCreatedAt: at,
    };
    await this.record({ op: "node", at, node });
    return node;
  }

  private async assertFactAt(input: AssertFactInput, txCreatedAt: string): Promise<{ fact: BrainFact; created: boolean }> {
    // Node capacity is checked before minting: a fact that would push the
    // graph past maxNodes is dropped (and counted) rather than referencing
    // nodes the journal never recorded.
    const neededNodes = this.countMissingNodes([input.subject, input.object]);
    if (this.nodesById.size + neededNodes > this.maxNodes) {
      this.droppedForNodeCapacity += 1;
      const placeholder: BrainFact = {
        id: "f-dropped",
        subjectId: "n-dropped",
        predicate: cleanText(input.predicate, PREDICATE_MAX) || "relates to",
        objectId: "n-dropped",
        factText: cleanText(input.factText, FACT_TEXT_MAX) || "(dropped)",
        validFrom: txCreatedAt,
        validTo: null,
        txCreatedAt,
        txInvalidatedAt: txCreatedAt,
        origin: boundOrigin(input.origin),
        confidence: 0,
        contentHash: sha256Hex("dropped"),
      };
      return { fact: placeholder, created: false };
    }
    const subject = await this.assertNodeAt(input.subject, txCreatedAt);
    const object = await this.assertNodeAt(input.object, txCreatedAt);
    const predicate = cleanText(input.predicate, PREDICATE_MAX) || "relates to";
    const factText = cleanText(input.factText, FACT_TEXT_MAX) || predicate;
    const contentHash = sha256Hex(`${subject.normalizedName}|${predicate}|${object.normalizedName}|${factText}`);

    // Idempotence: an identical current belief is simply confirmed, never
    // duplicated. An invalidated record with the same content does not block
    // re-assertion — beliefs can legitimately return.
    const knownId = this.factIdByContentHash.get(contentHash);
    if (knownId) {
      const known = this.factsById.get(knownId);
      if (known && known.txInvalidatedAt === null) return { fact: known, created: false };
    }

    const id = `f-${sha256Hex(`${contentHash}|${txCreatedAt}`).slice(0, 16)}`;
    const collided = this.factsById.get(id);
    // Same content at the same transaction instant is literally the same
    // bi-temporal record; re-writing it would resurrect an invalidation.
    if (collided) return { fact: collided, created: false };

    const validFrom = input.validFrom !== undefined && IsoDateTime.safeParse(input.validFrom).success
      ? input.validFrom
      : txCreatedAt;
    const fact: BrainFact = {
      id,
      subjectId: subject.id,
      predicate,
      objectId: object.id,
      factText,
      validFrom,
      validTo: null,
      txCreatedAt,
      txInvalidatedAt: null,
      origin: boundOrigin(input.origin),
      confidence: clampConfidence(input.confidence),
      contentHash,
    };

    // Bi-temporal contradiction rule: for one (subject, predicate) slot the
    // belief with the LATER transaction time wins, decided by (txCreatedAt,
    // contentHash) so replicas agree without a clock. The loser's transaction
    // interval is closed — never deleted. This holds across separate merge
    // calls too: a stale contribution arriving late is recorded born-closed
    // instead of invalidating a belief the bridge learned after it.
    let winningConflict: BrainFact | undefined;
    if ((input.onConflict ?? "supersede") === "supersede") {
      for (const conflict of this.conflictingCurrentFacts(subject.id, predicate, object.id)) {
        const incomingWins = compareStrings(txCreatedAt, conflict.txCreatedAt) > 0
          || (compareStrings(txCreatedAt, conflict.txCreatedAt) === 0 && compareStrings(contentHash, conflict.contentHash) >= 0);
        if (incomingWins) {
          await this.record({
            op: "invalidate",
            at: txCreatedAt,
            factId: conflict.id,
            validTo: validFrom,
            reason: `superseded by ${id}`,
          });
        } else if (!winningConflict || compareStrings(conflict.txCreatedAt, winningConflict.txCreatedAt) > 0) {
          winningConflict = conflict;
        }
      }
    }

    await this.ensureFactCapacity(txCreatedAt);
    await this.record({ op: "fact", at: txCreatedAt, fact });
    if (winningConflict) {
      // The incoming fact lost to a belief this bridge already holds with a
      // newer transaction time. Close it immediately using the winner's
      // content-derived timestamps so any arrival order converges.
      await this.record({
        op: "invalidate",
        at: winningConflict.txCreatedAt,
        factId: id,
        validTo: winningConflict.validFrom,
        reason: `superseded by ${winningConflict.id}`,
      });
    }
    return { fact: this.factsById.get(id) ?? fact, created: true };
  }

  /** How many of these node identities do not exist yet. */
  private countMissingNodes(inputs: AssertNodeInput[]): number {
    const keys = new Set<string>();
    for (const input of inputs) {
      const normalizedName = normalizeBrainName(cleanText(input.name, NODE_NAME_MAX) || "unknown") || "unknown";
      const key = `${input.kind}|${normalizedName}`;
      if (!this.nodeIdByKey.has(key)) keys.add(key);
    }
    return keys.size;
  }

  private conflictingCurrentFacts(subjectId: string, predicate: string, objectId: string): BrainFact[] {
    const factIds = this.adjacency.get(subjectId);
    if (!factIds) return [];
    const conflicts: BrainFact[] = [];
    for (const factId of factIds) {
      const fact = this.factsById.get(factId);
      if (!fact || fact.txInvalidatedAt !== null) continue;
      if (fact.subjectId === subjectId && fact.predicate === predicate && fact.objectId !== objectId) {
        conflicts.push(fact);
      }
    }
    return conflicts.sort(compareTxThenId);
  }

  /**
   * Capacity is enforced bi-temporally too: the graph never deletes, it
   * invalidates the oldest lowest-confidence current beliefs so the journal
   * still explains what was displaced and why.
   */
  private async ensureFactCapacity(at: string): Promise<void> {
    while (this.currentCount >= this.maxFacts) {
      const victim = [...this.factsById.values()]
        .filter(fact => fact.txInvalidatedAt === null)
        .sort((a, b) =>
          a.confidence - b.confidence
          || compareStrings(a.txCreatedAt, b.txCreatedAt)
          || compareStrings(a.id, b.id))[0];
      if (!victim) return;
      await this.record({ op: "invalidate", at, factId: victim.id, validTo: null, reason: "capacity" });
    }
  }

  /** Single mutation point shared by live writes and journal replay. */
  private applyToMemory(entry: BrainJournalEntry): void {
    this.lastEntryAt = entry.at;
    if (entry.op === "node") {
      const key = `${entry.node.kind}|${entry.node.normalizedName}`;
      if (this.nodeIdByKey.has(key) || this.nodesById.has(entry.node.id)) return;
      this.nodeIdByKey.set(key, entry.node.id);
      this.nodesById.set(entry.node.id, entry.node);
      return;
    }
    if (entry.op === "fact") {
      if (this.factsById.has(entry.fact.id)) return;
      const fact = { ...entry.fact };
      this.factsById.set(fact.id, fact);
      this.factIdByContentHash.set(fact.contentHash, fact.id);
      this.addAdjacency(fact.subjectId, fact.id);
      this.addAdjacency(fact.objectId, fact.id);
      if (fact.txInvalidatedAt === null) this.currentCount += 1;
      return;
    }
    const fact = this.factsById.get(entry.factId);
    if (!fact || fact.txInvalidatedAt !== null) return;
    fact.txInvalidatedAt = entry.at;
    fact.validTo = entry.validTo;
    this.currentCount -= 1;
  }

  private addAdjacency(nodeId: string, factId: string): void {
    let set = this.adjacency.get(nodeId);
    if (!set) {
      set = new Set();
      this.adjacency.set(nodeId, set);
    }
    set.add(factId);
  }

  private async record(entry: BrainJournalEntry): Promise<void> {
    if (this.loadFailed) return;
    this.applyToMemory(entry);
    // Disk writes are strictly serialized: an append enqueued while a
    // compaction is rewriting the journal would otherwise land on the old
    // file an instant before rename() discards it.
    const task = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(this.brainDir, { recursive: true, mode: 0o700 });
      await appendFile(this.journalPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
      this.journalLines += 1;
      if (this.shouldCompact()) await this.compact();
    });
    this.writeQueue = task.catch(() => undefined);
    await task;
  }

  /**
   * Compact only when the journal carries meaningfully more lines than live
   * records. A fixed threshold would thrash once retained history alone
   * exceeded it — every append would trigger a full O(journal) rewrite.
   */
  private shouldCompact(): boolean {
    const retained = this.nodesById.size + this.factsById.size;
    return this.journalLines > retained * 2 + 1_024;
  }

  /**
   * Journal compaction is a pure re-serialization of live memory: nothing is
   * summarized away, invalidated facts keep their closed transaction
   * intervals inline. Atomic tmp-write + rename so a crash mid-compaction
   * leaves the previous journal intact.
   */
  private async compact(): Promise<void> {
    const lines: string[] = [];
    for (const node of [...this.nodesById.values()].sort(compareTxThenId)) {
      lines.push(JSON.stringify({ op: "node", at: node.txCreatedAt, node } satisfies BrainJournalEntry));
    }
    for (const fact of [...this.factsById.values()].sort(compareTxThenId)) {
      lines.push(JSON.stringify({ op: "fact", at: fact.txCreatedAt, fact } satisfies BrainJournalEntry));
    }
    await mkdir(this.brainDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.journalPath}.${process.pid}.tmp`;
    await writeFile(temporary, lines.length ? `${lines.join("\n")}\n` : "", { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.journalPath);
    this.journalLines = lines.length;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Redaction before sanitation: secrets die before any length slicing. */
function cleanText(value: string, maxChars: number): string {
  return sanitizeBrainText(redactBrainText(value), maxChars);
}

function clampConfidence(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0.7;
  return Math.min(1, Math.max(0, value));
}

function boundOrigin(origin: BrainFactOrigin): BrainFactOrigin {
  return {
    channel: origin.channel,
    ...(origin.correlationId ? { correlationId: cleanText(origin.correlationId, 64) } : {}),
    ...(origin.workerId ? { workerId: cleanText(origin.workerId, 64) } : {}),
    ...(origin.detail ? { detail: cleanText(origin.detail, 400) } : {}),
  };
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareTxThenId(a: { txCreatedAt: string; id: string }, b: { txCreatedAt: string; id: string }): number {
  return compareStrings(a.txCreatedAt, b.txCreatedAt) || compareStrings(a.id, b.id);
}
