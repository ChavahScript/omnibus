import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { collectWorkspaceContext } from "../workspace-context.js";
import {
  redactBrainText,
  sanitizeBrainText,
  type BrainFact,
  type BrainFactOrigin,
  type BrainNodeKind,
  type DigitalTwinApi,
  type KnowledgeGraphApi,
  type RetrieverApi,
} from "./types.js";

/**
 * Symbol discovery is bounded static text matching, never evaluation: the
 * regex only recognizes top-level `export` declarations inside snippets the
 * workspace-context scanner already deemed safe to read.
 */
const EXPORT_PATTERN = /export (?:async )?(?:function|class|const|type|interface) (\w+)/g;
const MAX_SYMBOLS_PER_SNIPPET = 32;
const MAX_FACT_TEXT_CHARS = 1_200;
const MAX_SUMMARY_WORDS = 8;

/**
 * The sync cursor is a digest, not a file list: twin-state.json records what
 * the workspace looked like without duplicating path metadata beyond what a
 * cheap change check needs.
 */
const TwinStateSchema = z.object({
  version: z.literal(1),
  digest: z.string().length(64),
  updatedAt: z.string(),
  artifacts: z.number().int().nonnegative(),
});
type TwinState = z.infer<typeof TwinStateSchema>;

const PREVENTION_KINDS = new Set<BrainNodeKind>(["bugfix", "decision", "antipattern"]);
const FALLBACK_KINDS = new Set<BrainNodeKind>(["bugfix", "decision"]);
const FALLBACK_FACTS = 6;

export type CodeDigitalTwinOptions = {
  workspacePath: string;
  brainDir: string;
  graph: KnowledgeGraphApi;
  config: Pick<AppConfig, "workspaceContextMaxFiles" | "workspaceContextMaxSnippets" | "workspaceContextMaxChars">;
  retriever?: RetrieverApi;
  now?: () => Date;
};

/**
 * The Code Digital Twin: a graph-backed model of what the workspace contains
 * and why it looks that way.
 *
 * Artifact discovery deliberately reuses collectWorkspaceContext so the twin
 * can never see more of the filesystem than the Auditor already may — the
 * symlink, VCS, dependency, and secret exclusions live in exactly one place.
 * Decisions and bug fixes are the twin's institutional memory: they are
 * recorded as bounded, redacted graph facts so a later idea can be checked
 * against the mistakes and trade-offs that shaped the codebase, without any
 * raw source or path leaving the laptop.
 */
export class CodeDigitalTwin implements DigitalTwinApi {
  private readonly workspacePath: string;
  private readonly statePath: string;
  private readonly graph: KnowledgeGraphApi;
  private readonly retriever: RetrieverApi | undefined;
  private readonly config: CodeDigitalTwinOptions["config"];
  private readonly now: () => Date;

  public constructor(options: CodeDigitalTwinOptions) {
    this.workspacePath = options.workspacePath;
    this.statePath = path.join(options.brainDir, "twin-state.json");
    this.graph = options.graph;
    this.retriever = options.retriever;
    this.config = options.config;
    this.now = options.now ?? (() => new Date());
  }

  public async syncArtifacts(): Promise<{ artifacts: number; changed: boolean }> {
    const context = await collectWorkspaceContext(this.workspacePath, {
      maxFiles: this.config.workspaceContextMaxFiles,
      maxSnippets: this.config.workspaceContextMaxSnippets,
      maxChars: this.config.workspaceContextMaxChars,
    });
    const files = context.available ? context.files : [];
    const digest = createHash("sha256")
      .update(JSON.stringify(files.map(file => [file.path, file.bytes])))
      .digest("hex");
    const previous = await this.readState();
    if (previous?.digest === digest) {
      // Ambient capture re-syncs on a timer; an unchanged workspace must cost
      // one scan and zero graph writes.
      return { artifacts: files.length, changed: false };
    }

    const origin: BrainFactOrigin = { channel: "twin" };
    for (const file of files) {
      const extension = path.extname(file.path).replace(/^\./, "").toLowerCase() || "file";
      await this.graph.assertFact({
        subject: { kind: "artifact", name: file.path },
        predicate: "is-artifact",
        object: { kind: "entity", name: extension },
        factText: boundedFactText(`${file.path} (${file.bytes} bytes) is a tracked workspace artifact`),
        origin,
      });
    }
    for (const snippet of context.snippets) {
      for (const symbol of extractExportedSymbols(snippet.text)) {
        await this.graph.assertFact({
          subject: { kind: "artifact", name: snippet.path },
          predicate: "exports",
          object: { kind: "entity", name: symbol },
          factText: boundedFactText(`${snippet.path} exports ${symbol}`),
          origin,
        });
      }
    }

    await this.writeState({
      version: 1,
      digest,
      updatedAt: this.now().toISOString(),
      artifacts: files.length,
    });
    return { artifacts: files.length, changed: true };
  }

  public async recordDecision(input: { title: string; rationale: string; tradeoff?: string; origin: BrainFactOrigin }): Promise<void> {
    const title = sanitizeBrainText(redactBrainText(input.title), 200) || "Untitled decision";
    const rationale = sanitizeBrainText(redactBrainText(input.rationale), 800);
    await this.graph.assertFact({
      subject: { kind: "decision", name: title },
      predicate: "rationale",
      object: { kind: "entity", name: leadingWords(rationale) },
      factText: boundedFactText(`Decision: ${title}. Rationale: ${rationale}`),
      origin: input.origin,
    });
    const tradeoff = input.tradeoff ? sanitizeBrainText(redactBrainText(input.tradeoff), 800) : "";
    if (tradeoff) {
      await this.graph.assertFact({
        subject: { kind: "decision", name: title },
        predicate: "trades-off",
        object: { kind: "entity", name: leadingWords(tradeoff) },
        factText: boundedFactText(`Decision: ${title}. Trade-off: ${tradeoff}`),
        origin: input.origin,
      });
    }
  }

  public async recordBugFix(input: { title: string; cause: string; fix: string; origin: BrainFactOrigin }): Promise<void> {
    const title = sanitizeBrainText(redactBrainText(input.title), 200) || "Untitled bug fix";
    const cause = sanitizeBrainText(redactBrainText(input.cause), 800);
    const fix = sanitizeBrainText(redactBrainText(input.fix), 800);
    await this.graph.assertFact({
      subject: { kind: "bugfix", name: title },
      predicate: "caused-by",
      object: { kind: "entity", name: leadingWords(cause) },
      factText: boundedFactText(`Bug fix: ${title}. Cause: ${cause}`),
      origin: input.origin,
    });
    await this.graph.assertFact({
      subject: { kind: "bugfix", name: title },
      predicate: "fixed-by",
      object: { kind: "entity", name: leadingWords(fix) },
      factText: boundedFactText(`Bug fix: ${title}. Fix: ${fix}`),
      origin: input.origin,
    });
  }

  public async preventionContext(query: string, maxChars = 2_000): Promise<string> {
    let candidates: string[] | null = null;
    if (this.retriever) {
      try {
        const result = await this.retriever.retrieve(query);
        candidates = result.facts
          .filter(ranked => this.isPreventionFact(ranked.fact))
          .map(ranked => ranked.fact.factText);
      } catch {
        // A broken retriever must not break prompt assembly; degrade to the
        // deterministic recency fallback below.
      }
    }
    if (candidates === null) {
      candidates = this.graph.currentFacts()
        .filter(fact => this.matchesKinds(fact, FALLBACK_KINDS))
        .sort((left, right) => left.txCreatedAt.localeCompare(right.txCreatedAt))
        .slice(-FALLBACK_FACTS)
        .map(fact => fact.factText);
    }

    const unique = [...new Set(candidates.filter(text => text.trim().length > 0))];
    if (!unique.length) return "";
    const header = "Relevant past incidents and decisions (do not repeat these mistakes):";
    let out = header;
    let added = 0;
    for (const text of unique) {
      const bullet = `\n- ${text}`;
      if (out.length + bullet.length > maxChars) break;
      out += bullet;
      added += 1;
    }
    return added > 0 ? out : "";
  }

  private isPreventionFact(fact: BrainFact): boolean {
    return this.matchesKinds(fact, PREVENTION_KINDS);
  }

  private matchesKinds(fact: BrainFact, kinds: ReadonlySet<BrainNodeKind>): boolean {
    const subjectKind = this.graph.nodeById(fact.subjectId)?.kind;
    const objectKind = this.graph.nodeById(fact.objectId)?.kind;
    return (subjectKind !== undefined && kinds.has(subjectKind))
      || (objectKind !== undefined && kinds.has(objectKind));
  }

  private async readState(): Promise<TwinState | null> {
    try {
      return TwinStateSchema.parse(JSON.parse(await readFile(this.statePath, "utf8")));
    } catch {
      // Absent on the first sync, or corrupt after a crash: either way the
      // next sync re-records facts (assertFact is idempotent by contentHash).
      return null;
    }
  }

  private async writeState(state: TwinState): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.statePath);
  }
}

/** Everything stored in the graph crosses the shared redact + sanitize boundary. */
function boundedFactText(text: string): string {
  return sanitizeBrainText(redactBrainText(text), MAX_FACT_TEXT_CHARS) || "(empty)";
}

function extractExportedSymbols(snippet: string): string[] {
  const symbols = new Set<string>();
  for (const match of snippet.matchAll(EXPORT_PATTERN)) {
    const symbol = match[1];
    if (!symbol) continue;
    symbols.add(symbol.slice(0, 120));
    if (symbols.size >= MAX_SYMBOLS_PER_SNIPPET) break;
  }
  return [...symbols];
}

/** Entity node names stay short: the first words of a sentence, not the sentence. */
function leadingWords(text: string): string {
  const words = text.split(" ").filter(Boolean).slice(0, MAX_SUMMARY_WORDS).join(" ").slice(0, 120);
  return words || "unspecified";
}
