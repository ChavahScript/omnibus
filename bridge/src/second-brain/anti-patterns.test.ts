import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AntiPatternRegistry } from "./anti-patterns.js";

const FIXED_NOW = () => new Date("2026-01-02T03:04:05.000Z");

test("first load seeds the six default anti-patterns and persists them owner-only", async () => {
  const brainDir = await mkdtemp(path.join(os.tmpdir(), "omnibus-antipatterns-"));
  try {
    const registry = new AntiPatternRegistry(brainDir, { now: FIXED_NOW });
    await registry.load();

    const patterns = registry.list();
    assert.equal(patterns.length, 6);
    for (const pattern of patterns) {
      assert.match(pattern.id, /^ap-[0-9a-f]{12}$/);
      assert.equal(pattern.createdAt, "2026-01-02T03:04:05.000Z");
      assert.equal(pattern.retiredAt, null);
      assert.deepEqual(pattern.origin, { channel: "manual", detail: "seed" });
      assert.ok(pattern.wrong.startsWith("// Wrong"), `wrong example marker missing for ${pattern.title}`);
      assert.ok(pattern.correct.startsWith("// Correct"), `correct example marker missing for ${pattern.title}`);
    }

    const target = path.join(brainDir, "anti-patterns.json");
    const persisted = JSON.parse(await readFile(target, "utf8"));
    assert.equal(persisted.version, 1);
    assert.equal(persisted.patterns.length, 6);
    if (process.platform !== "win32") {
      assert.equal((await stat(target)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(brainDir, { recursive: true, force: true });
  }
});

test("check reports wildcard binds and shell-interpolated exec with 1-indexed lines, blocks first", async () => {
  const brainDir = await mkdtemp(path.join(os.tmpdir(), "omnibus-antipatterns-"));
  try {
    const registry = new AntiPatternRegistry(brainDir, { now: FIXED_NOW });
    await registry.load();

    const text = [
      'import http from "node:http";',
      "const port = parseInt(rawPort);",
      "const server = http.createServer(handler);",
      'server.listen(8787, "0.0.0.0");',
      "execSync(`ls ${dir}`);",
    ].join("\n");
    const result = registry.check(text, { language: "typescript" });

    assert.equal(result.blocking, 2);
    assert.equal(result.warnings, 1);
    assert.equal(result.checkedChars, text.length);

    // Blocking violations sort ahead of the parseInt warning on line 2.
    assert.equal(result.violations[0]?.pattern.title, "Binding a listener to all interfaces");
    assert.equal(result.violations[0]?.line, 4);
    assert.equal(result.violations[0]?.fixable, true);
    assert.ok(result.violations[0]!.excerpt.includes("0.0.0.0"));
    assert.equal(result.violations[1]?.pattern.title, "Shell-interpolated child process");
    assert.equal(result.violations[1]?.line, 5);
    assert.equal(result.violations[2]?.pattern.title, "parseInt without a radix");
    assert.equal(result.violations[2]?.line, 2);
    assert.ok(result.violations.every(violation => violation.excerpt.length <= 160));
  } finally {
    await rm(brainDir, { recursive: true, force: true });
  }
});

test("language scoping: typescript patterns skip other languages while any-language patterns still fire", async () => {
  const brainDir = await mkdtemp(path.join(os.tmpdir(), "omnibus-antipatterns-"));
  try {
    const registry = new AntiPatternRegistry(brainDir, { now: FIXED_NOW });
    await registry.load();

    const swiftResult = registry.check('listener.bind("0.0.0.0")\nlet port = parseInt(raw)', { language: "swift" });
    assert.equal(swiftResult.blocking, 0);
    assert.equal(swiftResult.warnings, 1);
    assert.equal(swiftResult.violations[0]?.pattern.title, "parseInt without a radix");
  } finally {
    await rm(brainDir, { recursive: true, force: true });
  }
});

test("autoCorrect rewrites wildcard binds to loopback", async () => {
  const brainDir = await mkdtemp(path.join(os.tmpdir(), "omnibus-antipatterns-"));
  try {
    const registry = new AntiPatternRegistry(brainDir, { now: FIXED_NOW });
    await registry.load();

    const bindPattern = registry.list().find(pattern => pattern.title === "Binding a listener to all interfaces");
    assert.ok(bindPattern);
    const corrected = registry.autoCorrect('app.listen(8787, "0.0.0.0");\nother.listen(9000, "0.0.0.0");');
    assert.equal(corrected.text, 'app.listen(8787, "127.0.0.1");\nother.listen(9000, "127.0.0.1");');
    assert.equal(corrected.applied, 1);
    assert.deepEqual(corrected.appliedPatternIds, [bindPattern.id]);

    const untouched = registry.autoCorrect("nothing to fix here");
    assert.equal(untouched.text, "nothing to fix here");
    assert.equal(untouched.applied, 0);
  } finally {
    await rm(brainDir, { recursive: true, force: true });
  }
});

test("retire hides a pattern from detection and listing but keeps it inspectable", async () => {
  const brainDir = await mkdtemp(path.join(os.tmpdir(), "omnibus-antipatterns-"));
  try {
    const registry = new AntiPatternRegistry(brainDir, { now: FIXED_NOW });
    await registry.load();
    const bindPattern = registry.list().find(pattern => pattern.title === "Binding a listener to all interfaces");
    assert.ok(bindPattern);

    assert.equal(await registry.retire(bindPattern.id, "team decided to allow LAN binds"), true);
    assert.equal(await registry.retire("ap-000000000000", "no such pattern"), false);

    const result = registry.check('server.listen(8787, "0.0.0.0");', { language: "typescript" });
    assert.equal(result.violations.length, 0);
    assert.equal(registry.list().length, 5);
    const retired = registry.list({ includeRetired: true }).find(pattern => pattern.id === bindPattern.id);
    assert.ok(retired?.retiredAt);

    // Retirement survives a reload from disk.
    const reloaded = new AntiPatternRegistry(brainDir, { now: FIXED_NOW });
    await reloaded.load();
    assert.equal(reloaded.list().length, 5);
  } finally {
    await rm(brainDir, { recursive: true, force: true });
  }
});

test("promptDigest is bounded and truncates only at pattern boundaries", async () => {
  const brainDir = await mkdtemp(path.join(os.tmpdir(), "omnibus-antipatterns-"));
  try {
    const registry = new AntiPatternRegistry(brainDir, { now: FIXED_NOW });
    await registry.load();

    const full = registry.promptDigest();
    assert.ok(full.startsWith("Known anti-patterns (validate proposed code against these):"));
    assert.ok(full.length <= 3_000);
    assert.ok(full.includes("// Wrong"));

    for (const maxChars of [40, 200, 600, 1_200, 3_000]) {
      const digest = registry.promptDigest(maxChars);
      assert.ok(digest.length <= maxChars, `digest exceeded ${maxChars} chars`);
      const wrongCount = digest.split("// Wrong").length - 1;
      const correctCount = digest.split("// Correct").length - 1;
      assert.equal(wrongCount, correctCount, "digest cut a pattern mid-example");
    }
  } finally {
    await rm(brainDir, { recursive: true, force: true });
  }
});

test("a corrupt registry file reseeds defaults instead of crashing", async () => {
  const brainDir = await mkdtemp(path.join(os.tmpdir(), "omnibus-antipatterns-"));
  try {
    await writeFile(path.join(brainDir, "anti-patterns.json"), "not json {{{", "utf8");
    const registry = new AntiPatternRegistry(brainDir, { now: FIXED_NOW });
    await registry.load();
    assert.equal(registry.list().length, 6);

    // The reseed also repaired the file on disk.
    const reloaded = new AntiPatternRegistry(brainDir, { now: FIXED_NOW });
    await reloaded.load();
    assert.equal(reloaded.list().length, 6);
  } finally {
    await rm(brainDir, { recursive: true, force: true });
  }
});

test("added patterns are persisted, detected, and idempotent by content", async () => {
  const brainDir = await mkdtemp(path.join(os.tmpdir(), "omnibus-antipatterns-"));
  try {
    const registry = new AntiPatternRegistry(brainDir, { now: FIXED_NOW });
    await registry.load();

    const input = {
      title: "Stray console.log in bridge code",
      description: "Debug logging belongs in the audit trail, not the terminal.",
      language: "typescript",
      wrong: "// Wrong\nconsole.log(queueState);",
      correct: "// Correct\nawait audit.record(correlationId, event);",
      detector: { kind: "substring", needle: "console.log(" } as const,
      severity: "warn" as const,
      rationale: "Stray logging leaks internal state to whatever captures stdout.",
      origin: { channel: "manual" as const, detail: "test" },
    };
    const added = await registry.add(input);
    assert.match(added.id, /^ap-[0-9a-f]{12}$/);
    const again = await registry.add(input);
    assert.equal(again.id, added.id);
    assert.equal(registry.list().length, 7);

    const reloaded = new AntiPatternRegistry(brainDir, { now: FIXED_NOW });
    await reloaded.load();
    assert.equal(reloaded.list().length, 7);
    const result = reloaded.check("console.log(x);", { language: "typescript" });
    assert.equal(result.violations[0]?.pattern.id, added.id);
  } finally {
    await rm(brainDir, { recursive: true, force: true });
  }
});

test("an invalid stored regex detector is skipped, never a crash", async () => {
  const brainDir = await mkdtemp(path.join(os.tmpdir(), "omnibus-antipatterns-"));
  try {
    const registry = new AntiPatternRegistry(brainDir, { now: FIXED_NOW });
    await registry.load();
    await registry.add({
      title: "Broken detector",
      description: "Simulates a hand-edited registry entry with a bad regex.",
      language: "any",
      wrong: "// Wrong\nbroken",
      correct: "// Correct\nfine",
      detector: { kind: "regex", pattern: "([unclosed" },
      severity: "warn",
      rationale: "Regexes from disk are data; they must fail closed.",
      origin: { channel: "manual", detail: "test" },
    });
    const result = registry.check("([unclosed appears literally", { language: "typescript" });
    assert.ok(result.violations.every(violation => violation.pattern.title !== "Broken detector"));
  } finally {
    await rm(brainDir, { recursive: true, force: true });
  }
});
