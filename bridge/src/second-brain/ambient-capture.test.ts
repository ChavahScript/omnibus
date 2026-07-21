import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AuditTrail } from "../audit.js";
import { AmbientCaptureService, type RunCommand } from "./ambient-capture.js";
import {
  normalizeBrainName,
  type BrainContribution,
  type BrainFact,
  type BrainNode,
  type KnowledgeGraphApi,
  type LocalLlm,
} from "./types.js";

type AssertFactInput = Parameters<KnowledgeGraphApi["assertFact"]>[0];

/**
 * Minimal in-test graph stub: records calls, fabricates bounded return
 * shapes. Intentionally NOT the real knowledge-graph implementation so this
 * suite has no timing dependency on sibling modules.
 */
class StubGraph implements KnowledgeGraphApi {
  public readonly assertedFacts: AssertFactInput[] = [];
  public readonly merged: BrainContribution[][] = [];

  public async load(): Promise<void> {}

  public async assertNode(input: { kind: BrainNode["kind"]; name: string; summary?: string }): Promise<BrainNode> {
    return {
      id: `n-${this.assertedFacts.length}`,
      kind: input.kind,
      name: input.name,
      normalizedName: normalizeBrainName(input.name),
      txCreatedAt: new Date(0).toISOString(),
    };
  }

  public async assertFact(input: AssertFactInput): Promise<BrainFact> {
    this.assertedFacts.push(input);
    return {
      id: `f-${this.assertedFacts.length}`,
      subjectId: "s",
      predicate: input.predicate,
      objectId: "o",
      factText: input.factText,
      validFrom: new Date(0).toISOString(),
      validTo: null,
      txCreatedAt: new Date(0).toISOString(),
      txInvalidatedAt: null,
      origin: input.origin,
      confidence: input.confidence ?? 0.5,
      contentHash: "0".repeat(64),
    };
  }

  public async invalidateFact(): Promise<boolean> {
    return false;
  }

  public currentFacts(): BrainFact[] {
    return [];
  }

  public factsAsOf(): BrainFact[] {
    return [];
  }

  public nodes(): BrainNode[] {
    return [];
  }

  public nodeById(): BrainNode | undefined {
    return undefined;
  }

  public neighbors(): Array<{ fact: BrainFact; otherId: string }> {
    return [];
  }

  public findNodesByName(): BrainNode[] {
    return [];
  }

  public async mergeContributions(contributions: BrainContribution[]): Promise<{ applied: number; duplicates: number }> {
    this.merged.push(contributions);
    return { applied: contributions.length, duplicates: 0 };
  }

  public stats(): { nodes: number; facts: number; currentFacts: number; invalidatedFacts: number; updatedAt: string | null } {
    return { nodes: 0, facts: 0, currentFacts: 0, invalidatedFacts: 0, updatedAt: null };
  }
}

const nullLlm: LocalLlm = {
  generateJson: async () => null,
  available: async () => false,
};

const baseConfig = {
  secondBrainEnabled: true,
  ambientGitPollMs: 3_600_000,
  ambientCheckCommand: undefined,
  ambientCheckIntervalMs: 3_600_000,
};

type FakeRun = { command: string; args: string[] };

/**
 * Strips the read-only safety prefix (`--no-optional-locks -c
 * core.fsmonitor=false`) the service prepends to every git invocation, so
 * dispatch below keys on the actual subcommand.
 */
function gitSubcommandArgs(args: string[]): string[] {
  const rest = [...args];
  while (rest[0] === "--no-optional-locks" || rest[0] === "-c") {
    rest.splice(0, rest[0] === "-c" ? 2 : 1);
  }
  return rest;
}

function gitFake(options: { insideWorkTree: boolean; porcelain?: string; log?: string; diffStat?: string; calls?: FakeRun[] }): RunCommand {
  return async (command, rawArgs) => {
    const args = gitSubcommandArgs(rawArgs);
    options.calls?.push({ command, args });
    if (command !== "git") return { ok: false, stdout: "", stderr: "" };
    if (args[0] === "rev-parse") {
      return options.insideWorkTree ? { ok: true, stdout: "true\n", stderr: "" } : { ok: false, stdout: "", stderr: "fatal: not a git repository" };
    }
    if (args[0] === "status") return { ok: true, stdout: options.porcelain ?? "", stderr: "" };
    if (args[0] === "log") return { ok: true, stdout: options.log ?? "", stderr: "" };
    if (args[0] === "diff") return { ok: true, stdout: options.diffStat ?? "", stderr: "" };
    return { ok: false, stdout: "", stderr: "" };
  };
}

async function withTempDirs(run: (dirs: { brainDir: string; auditDir: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "omnibus-ambient-"));
  try {
    await run({ brainDir: path.join(root, "brain"), auditDir: path.join(root, "audit") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("git watcher captures changed-path and bugfix facts via heuristics", async () => {
  await withTempDirs(async ({ brainDir, auditDir }) => {
    const graph = new StubGraph();
    const now = () => new Date("2026-07-19T12:00:00.000Z");
    const runCommand = gitFake({
      insideWorkTree: true,
      porcelain: " M src/app.ts\n",
      log: "abcdef1234567890abcdef1234567890abcdef12\tfix: null deref in parser\n",
      diffStat: " src/app.ts | 2 +-\n",
    });
    const service = new AmbientCaptureService({
      workspacePath: "/workspace",
      brainDir,
      graph,
      llm: nullLlm,
      audit: new AuditTrail(auditDir),
      config: baseConfig,
      now,
      runCommand,
    });
    try {
      await service.start();
      assert.equal(service.status().git, "active");
      assert.equal(graph.assertedFacts.length, 2);

      const changed = graph.assertedFacts[0]!;
      assert.equal(changed.subject.kind, "artifact");
      assert.equal(changed.subject.name, "src/app.ts");
      assert.equal(changed.predicate, "changed");
      assert.equal(changed.object.kind, "event");
      assert.equal(changed.object.name, "working-tree 2026-07-19");
      assert.equal(changed.origin.channel, "git");
      assert.match(changed.factText, /src\/app\.ts changed in the working tree/);

      const bugfix = graph.assertedFacts[1]!;
      assert.equal(bugfix.subject.kind, "bugfix");
      assert.equal(bugfix.subject.name, "fix: null deref in parser");
      assert.equal(bugfix.predicate, "fixed-by-commit");
      assert.equal(bugfix.object.name, "commit abcdef123456");
      assert.equal(bugfix.origin.channel, "git");

      assert.equal(service.status().lastCaptureAt, now().toISOString());
      assert.equal(service.status().capturedEvents, 1);

      // The cursor persists the fingerprint, so an identical snapshot after
      // a restart records nothing new.
      const cursor = JSON.parse(await readFile(path.join(brainDir, "capture-cursor.json"), "utf8")) as { fingerprint: string };
      assert.equal(cursor.fingerprint.length, 64);
      await service.stop();

      const secondGraph = new StubGraph();
      const second = new AmbientCaptureService({
        workspacePath: "/workspace",
        brainDir,
        graph: secondGraph,
        llm: nullLlm,
        audit: new AuditTrail(auditDir),
        config: baseConfig,
        now,
        runCommand,
      });
      try {
        await second.start();
        assert.equal(secondGraph.assertedFacts.length, 0);
      } finally {
        await second.stop();
      }
    } finally {
      await service.stop();
    }
  });
});

test("non-git workspace reports unavailable and records nothing", async () => {
  await withTempDirs(async ({ brainDir, auditDir }) => {
    const graph = new StubGraph();
    const calls: FakeRun[] = [];
    const service = new AmbientCaptureService({
      workspacePath: "/workspace",
      brainDir,
      graph,
      llm: nullLlm,
      audit: new AuditTrail(auditDir),
      config: baseConfig,
      runCommand: gitFake({ insideWorkTree: false, calls }),
    });
    try {
      await service.start();
      assert.equal(service.status().git, "unavailable");
      assert.equal(service.status().diagnostics, "disabled");
      assert.equal(graph.assertedFacts.length, 0);
      // Only the probe ran; the poll loop never started.
      assert.deepEqual(calls.map(call => call.args[0]), ["rev-parse"]);
    } finally {
      await service.stop();
    }
  });
});

test("diagnostics watcher parses tsc-style errors into facts even on failing exit", async () => {
  await withTempDirs(async ({ brainDir, auditDir }) => {
    const graph = new StubGraph();
    const calls: FakeRun[] = [];
    const runCommand: RunCommand = async (command, args) => {
      calls.push({ command, args });
      if (command === "git") return { ok: false, stdout: "", stderr: "" };
      return {
        ok: false,
        stdout: [
          "src/a.ts(1,2): error TS2304: Cannot find name 'x'.",
          "just an informational line",
          "src/b.ts(3,4): error TS2345: Argument of type 'string' is not assignable.",
        ].join("\n"),
        stderr: "",
      };
    };
    const service = new AmbientCaptureService({
      workspacePath: "/workspace",
      brainDir,
      graph,
      llm: nullLlm,
      audit: new AuditTrail(auditDir),
      config: { ...baseConfig, ambientCheckCommand: "tsc --noEmit" },
      runCommand,
    });
    try {
      await service.start();
      assert.equal(service.status().diagnostics, "active");

      const diagCall = calls.find(call => call.command === "tsc");
      assert.ok(diagCall, "diagnostics command spawned without a shell");
      assert.deepEqual(diagCall.args, ["--noEmit"]);

      assert.equal(graph.assertedFacts.length, 2);
      const [first, second] = graph.assertedFacts;
      assert.equal(first!.subject.kind, "artifact");
      assert.equal(first!.subject.name, "src/a.ts");
      assert.equal(first!.predicate, "reports");
      assert.equal(first!.origin.channel, "diagnostics");
      assert.ok(first!.object.name.length <= 80);
      assert.equal(second!.subject.name, "src/b.ts");
      assert.match(second!.object.name, /TS2345/);
    } finally {
      await service.stop();
    }
  });
});

test("captureDiscussion falls back to a single heuristic contribution", async () => {
  await withTempDirs(async ({ brainDir, auditDir }) => {
    const graph = new StubGraph();
    const now = () => new Date("2026-07-19T09:30:00.000Z");
    const service = new AmbientCaptureService({
      workspacePath: "/workspace",
      brainDir,
      graph,
      llm: nullLlm,
      audit: new AuditTrail(auditDir),
      config: baseConfig,
      now,
      runCommand: gitFake({ insideWorkTree: false }),
    });
    try {
      await service.captureDiscussion({
        correlationId: "corr-1",
        role: "idea",
        text: "  Build an   offline sync layer with api_key=abcd1234efgh5678 embedded  ",
      });
      assert.equal(graph.merged.length, 1);
      const [contribution] = graph.merged[0]!;
      assert.ok(contribution);
      assert.equal(contribution.origin.channel, "discussion");
      assert.equal(contribution.origin.correlationId, "corr-1");
      assert.equal(contribution.txCreatedAt, now().toISOString());
      assert.equal(contribution.triples, undefined);
      // Redacted and whitespace-collapsed before storage.
      assert.match(contribution.text, /\[REDACTED\]/);
      assert.ok(!contribution.text.includes("abcd1234efgh5678"));
      assert.ok(!contribution.text.includes("  "));

      await service.captureDiscussion({ correlationId: "corr-2", role: "peer-review", text: "x".repeat(5_000), workerId: "worker-9" });
      const [review] = graph.merged[1]!;
      assert.ok(review);
      assert.equal(review.origin.channel, "fleet-review");
      assert.equal(review.origin.workerId, "worker-9");
      assert.equal(review.text.length, 900);

      await service.captureDiscussion({ correlationId: "corr-3", role: "brief", text: "b".repeat(5_000) });
      const [brief] = graph.merged[2]!;
      assert.ok(brief);
      assert.equal(brief.origin.channel, "brief");
      assert.equal(brief.text.length, 4_000);
    } finally {
      await service.stop();
    }
  });
});

test("secondBrainEnabled=false disables every watcher and makes start a no-op", async () => {
  await withTempDirs(async ({ brainDir, auditDir }) => {
    const graph = new StubGraph();
    const calls: FakeRun[] = [];
    const service = new AmbientCaptureService({
      workspacePath: "/workspace",
      brainDir,
      graph,
      llm: nullLlm,
      audit: new AuditTrail(auditDir),
      config: { ...baseConfig, secondBrainEnabled: false, ambientCheckCommand: "tsc --noEmit" },
      runCommand: gitFake({ insideWorkTree: true, calls }),
    });
    try {
      await service.start();
      assert.deepEqual(service.status(), {
        git: "disabled",
        diagnostics: "disabled",
        discussions: "disabled",
        lastCaptureAt: null,
        capturedEvents: 0,
      });
      assert.equal(calls.length, 0);
      await service.captureDiscussion({ correlationId: "corr", role: "idea", text: "ignored while disabled" });
      assert.equal(graph.merged.length, 0);
    } finally {
      await service.stop();
    }
  });
});

function makeClock(startIso: string): { now: () => Date; advance: (ms: number) => void } {
  let atMs = new Date(startIso).getTime();
  return {
    now: () => new Date(atMs),
    advance: (ms: number) => { atMs += ms; },
  };
}

/** LLM stub that counts calls and always returns one well-formed triple. */
function countingTripleLlm(): { llm: LocalLlm; count: () => number } {
  let calls = 0;
  return {
    llm: {
      generateJson: async () => {
        calls += 1;
        return { triples: [{ subject: "omnibus", predicate: "targets", object: "iphone" }] };
      },
      available: async () => true,
    },
    count: () => calls,
  };
}

test("watcher LLM distillation is rate-limited to one call per 10 minutes", async () => {
  await withTempDirs(async ({ brainDir, auditDir }) => {
    const graph = new StubGraph();
    const clock = makeClock("2026-07-19T09:00:00.000Z");
    const counting = countingTripleLlm();
    const gitOptions = { insideWorkTree: true, porcelain: " M src/a.ts\n" };
    const service = new AmbientCaptureService({
      workspacePath: "/workspace",
      brainDir,
      graph,
      llm: counting.llm,
      audit: new AuditTrail(auditDir),
      config: baseConfig,
      now: clock.now,
      runCommand: gitFake(gitOptions),
    });
    try {
      await service.start();
      assert.equal(counting.count(), 1, "first poll may use the LLM");
      assert.equal(graph.assertedFacts[0]?.subject.name, "omnibus");
      await service.stop();

      // A fresh snapshot one minute later must NOT trigger another 7B
      // inference; the deterministic heuristics carry the capture instead.
      gitOptions.porcelain = " M src/b.ts\n";
      clock.advance(60_000);
      await service.start();
      assert.equal(counting.count(), 1, "second poll inside the window must skip the LLM");
      assert.ok(
        graph.assertedFacts.some(fact => fact.subject.name === "src/b.ts" && fact.predicate === "changed"),
        "heuristics must still capture between LLM windows",
      );
      await service.stop();

      // Once the window elapses the next changed snapshot may distill again.
      gitOptions.porcelain = " M src/c.ts\n";
      clock.advance(10 * 60_000);
      await service.start();
      assert.equal(counting.count(), 2, "the window elapsing re-enables one LLM call");
    } finally {
      await service.stop();
    }
  });
});

test("shouldDistill=false skips every LLM call and falls back to heuristics", async () => {
  await withTempDirs(async ({ brainDir, auditDir }) => {
    const graph = new StubGraph();
    const counting = countingTripleLlm();
    const service = new AmbientCaptureService({
      workspacePath: "/workspace",
      brainDir,
      graph,
      llm: counting.llm,
      discussionLlm: counting.llm,
      shouldDistill: () => false,
      audit: new AuditTrail(auditDir),
      config: baseConfig,
      now: () => new Date("2026-07-19T12:00:00.000Z"),
      runCommand: gitFake({ insideWorkTree: true, porcelain: " M src/x.ts\n" }),
    });
    try {
      await service.start();
      assert.equal(counting.count(), 0, "capacity gate must skip watcher LLM cost");
      assert.ok(
        graph.assertedFacts.some(fact => fact.subject.name === "src/x.ts"),
        "heuristic capture must continue at the cap",
      );

      await service.captureDiscussion({ correlationId: "corr-cap", role: "idea", text: "an idea captured at the node cap" });
      assert.equal(counting.count(), 0, "discussion distillation must also skip the LLM");
      const [contribution] = graph.merged[0]!;
      assert.ok(contribution);
      assert.equal(contribution.triples, undefined, "heuristic contribution carries plain text");
    } finally {
      await service.stop();
    }
  });
});
