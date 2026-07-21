import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AntiPatternRegistryFileSchema,
  AntiPatternSchema,
  redactBrainText,
  sanitizeBrainText,
  type AntiPattern,
  type AntiPatternCheck,
  type AntiPatternDetector,
  type AntiPatternRegistryApi,
  type AntiPatternViolation,
} from "./types.js";

/**
 * Detection is deliberately bounded: a hostile or accidental megabyte of text
 * cannot turn a pre-commit check into a CPU sink, and a single noisy pattern
 * cannot flood a review with thousands of identical violations.
 */
const MAX_CHECK_CHARS = 250_000;
const MAX_VIOLATIONS_PER_PATTERN = 20;
const MAX_PATTERNS = 400;

type AddInput = Omit<AntiPattern, "id" | "createdAt" | "retiredAt">;

/**
 * The structured anti-pattern memory of the Code Digital Twin.
 *
 * Patterns are data, never code: a detector is a substring or a defensively
 * compiled regex, and an auto-fix is a plain find/replace. Nothing loaded from
 * disk (or later learned from a model) can execute; a corrupt or hand-edited
 * registry file degrades to the seeded defaults instead of crashing the
 * bridge. Retirement is bi-temporal soft deletion so a pattern the owner
 * outgrew remains inspectable but stops firing.
 */
export class AntiPatternRegistry implements AntiPatternRegistryApi {
  private readonly target: string;
  private readonly now: () => Date;
  private patterns: AntiPattern[] = [];

  public constructor(brainDir: string, options: { now?: () => Date } = {}) {
    this.target = path.join(brainDir, "anti-patterns.json");
    this.now = options.now ?? (() => new Date());
  }

  public async load(): Promise<void> {
    try {
      const file = AntiPatternRegistryFileSchema.parse(JSON.parse(await readFile(this.target, "utf8")));
      this.patterns = file.patterns;
      return;
    } catch {
      // Absent on first run, or corrupt after a crash/hand edit. Either way
      // the registry must come up with its baked-in safety net rather than
      // refuse to start, so reseed and best-effort persist.
    }
    this.patterns = this.seedDefaults();
    try {
      await this.persist();
    } catch {
      // An unwritable state dir keeps the seeds in memory only; detection
      // still works and the next successful mutation will persist.
    }
  }

  public list(options: { includeRetired?: boolean } = {}): AntiPattern[] {
    return options.includeRetired ? [...this.patterns] : this.patterns.filter(pattern => !pattern.retiredAt);
  }

  public async add(input: AddInput): Promise<AntiPattern> {
    const pattern = this.materialize(input);
    const existing = this.patterns.find(candidate => candidate.id === pattern.id);
    if (existing) return existing;
    if (this.patterns.length >= MAX_PATTERNS) {
      throw new Error("The anti-pattern registry is full; retire patterns before adding more.");
    }
    this.patterns.push(pattern);
    await this.persist();
    return pattern;
  }

  public async retire(id: string, reason: string): Promise<boolean> {
    const index = this.patterns.findIndex(pattern => pattern.id === id);
    if (index < 0) return false;
    const pattern = this.patterns[index]!;
    if (!pattern.retiredAt) {
      const note = sanitizeBrainText(redactBrainText(reason), 200);
      this.patterns[index] = AntiPatternSchema.parse({
        ...pattern,
        retiredAt: this.now().toISOString(),
        description: (note ? `${pattern.description} [retired: ${note}]` : pattern.description).slice(0, 1_200),
      });
      await this.persist();
    }
    return true;
  }

  public check(text: string, options: { language?: string } = {}): AntiPatternCheck {
    const bounded = text.slice(0, MAX_CHECK_CHARS);
    const lines = bounded.split("\n");
    const violations: AntiPatternViolation[] = [];
    for (const pattern of this.activePatterns()) {
      if (!languageApplies(pattern.language, options.language)) continue;
      const matches = compileMatcher(pattern.detector);
      if (!matches) continue;
      let reported = 0;
      for (let index = 0; index < lines.length && reported < MAX_VIOLATIONS_PER_PATTERN; index += 1) {
        const line = lines[index] ?? "";
        // Comment lines cannot bind sockets, spawn shells, or hold live
        // credentials — and Wrong/Correct teaching material quotes bad code
        // inside comments by design. Skipping them keeps the gate from
        // blocking a commit over its own documentation.
        if (isCommentLine(line)) continue;
        if (!matches(line)) continue;
        violations.push({
          pattern,
          line: index + 1,
          excerpt: line.trim().slice(0, 160),
          fixable: Boolean(pattern.autoFix),
        });
        reported += 1;
      }
    }
    violations.sort((left, right) =>
      severityRank(left.pattern.severity) - severityRank(right.pattern.severity) || left.line - right.line);
    return {
      violations,
      blocking: violations.filter(violation => violation.pattern.severity === "block").length,
      warnings: violations.filter(violation => violation.pattern.severity === "warn").length,
      checkedChars: bounded.length,
    };
  }

  /**
   * Corrections are scoped to lines the pattern's own DETECTOR flags — never
   * a blind whole-file find/replace. Text that merely contains the fix's
   * needle without violating the pattern (a doc string, an unrelated token,
   * a comment) is left exactly as the owner wrote it.
   */
  public autoCorrect(text: string): { text: string; applied: number; appliedPatternIds: string[] } {
    const lines = text.split("\n");
    const appliedPatternIds: string[] = [];
    for (const pattern of this.activePatterns()) {
      const fix = pattern.autoFix;
      if (!fix) continue;
      const matches = compileMatcher(pattern.detector);
      if (!matches) continue;
      let applied = false;
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (isCommentLine(line) || !matches(line)) continue;
        let next = line;
        if (fix.isRegex) {
          try {
            next = line.replace(new RegExp(fix.find, "g"), fix.replace);
          } catch {
            break;
          }
        } else {
          next = line.split(fix.find).join(fix.replace);
        }
        if (next !== line) {
          lines[index] = next;
          applied = true;
        }
      }
      if (applied) appliedPatternIds.push(pattern.id);
    }
    return { text: lines.join("\n"), applied: appliedPatternIds.length, appliedPatternIds };
  }

  public promptDigest(maxChars = 3_000): string {
    const header = "Known anti-patterns (validate proposed code against these):";
    if (header.length > maxChars) return header.slice(0, maxChars);
    let digest = header;
    for (const pattern of this.activePatterns()) {
      const block = [
        `### ${pattern.title} (${pattern.severity})`,
        sanitizeBrainText(pattern.rationale, 240) || sanitizeBrainText(pattern.description, 240),
        "```",
        pattern.wrong,
        "```",
        "```",
        pattern.correct,
        "```",
      ].join("\n");
      // Truncation happens only at a pattern boundary: a half example teaches
      // a model the wrong lesson, so a block that does not fit is dropped.
      if (digest.length + 2 + block.length > maxChars) break;
      digest += `\n\n${block}`;
    }
    return digest;
  }

  private activePatterns(): AntiPattern[] {
    return this.patterns.filter(pattern => !pattern.retiredAt);
  }

  /**
   * Every stored field crosses the same redact + sanitize boundary as graph
   * facts. Examples keep their newlines (a Wrong/Correct example is code) but
   * still lose control characters and any recognizable secret material.
   */
  private materialize(input: AddInput): AntiPattern {
    const title = sanitizeBrainText(redactBrainText(input.title), 160);
    const wrong = sanitizeExample(input.wrong);
    return AntiPatternSchema.parse({
      ...input,
      id: `ap-${createHash("sha256").update(`${title}${wrong}`).digest("hex").slice(0, 12)}`,
      title,
      description: sanitizeBrainText(redactBrainText(input.description), 1_200),
      language: sanitizeBrainText(input.language, 40).toLowerCase() || "any",
      wrong,
      correct: sanitizeExample(input.correct),
      rationale: sanitizeBrainText(redactBrainText(input.rationale), 1_200),
      createdAt: this.now().toISOString(),
      retiredAt: null,
    });
  }

  private async persist(): Promise<void> {
    const file = AntiPatternRegistryFileSchema.parse({
      version: 1,
      updatedAt: this.now().toISOString(),
      patterns: this.patterns,
    });
    await mkdir(path.dirname(this.target), { recursive: true, mode: 0o700 });
    const temporary = `${this.target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.target);
  }

  /**
   * The baked-in safety net: the security and knowledge-hygiene rules this
   * codebase already enforces by convention, written down as data so the
   * Developer's proposals are checked against them mechanically.
   */
  private seedDefaults(): AntiPattern[] {
    const seeds: AddInput[] = [
      {
        title: "Binding a listener to all interfaces",
        description: "A server socket bound to the wildcard address is reachable from every network the laptop joins.",
        language: "typescript",
        wrong: [
          "// Wrong: the bridge becomes reachable from every network interface.",
          "const server = http.createServer(handler);",
          'server.listen(8787, "0.0.0.0");',
        ].join("\n"),
        correct: [
          "// Correct: loopback only; remote access goes through the supervised tunnel.",
          "const server = http.createServer(handler);",
          'server.listen(8787, "127.0.0.1");',
        ].join("\n"),
        detector: { kind: "substring", needle: "0.0.0.0" },
        autoFix: { find: "0.0.0.0", replace: "127.0.0.1", isRegex: false },
        severity: "block",
        rationale: "Omnibus is local-first; the only public surface is the supervised tunnel, so a wildcard bind silently widens the attack surface.",
        origin: { channel: "manual", detail: "seed" },
      },
      {
        title: "Shell-interpolated child process",
        description: "exec/execSync with an interpolated command string hands attacker-influenced text to a shell.",
        language: "typescript",
        wrong: [
          "// Wrong: interpolated shell text lets any variable become a command.",
          'import { execSync } from "node:child_process";',
          "execSync(`git log --oneline ${branch}`);",
        ].join("\n"),
        correct: [
          "// Correct: fixed executable, argument array, no shell.",
          'import { spawn } from "node:child_process";',
          'spawn("git", ["log", "--oneline", branch], { shell: false });',
        ].join("\n"),
        detector: { kind: "regex", pattern: "\\bexec(?:Sync)?\\s*\\(\\s*[`\"']" },
        severity: "block",
        rationale: "Interpolated shell text turns any variable into command injection; the codebase spawns fixed executables with shell:false and argument arrays.",
        origin: { channel: "manual", detail: "seed" },
      },
      {
        title: "Hardcoded credential in source",
        description: "A literal API key, secret, or password committed to source ships with every clone and bundle.",
        language: "typescript",
        wrong: [
          "// Wrong: the key ships with the source and the iOS bundle.",
          'const apiKey = "AKIAIOSFODNN7EXAMPLE";',
        ].join("\n"),
        correct: [
          "// Correct: credentials come from the environment or the private settings store.",
          "const openaiApiKey = process.env.OPENAI_API_KEY;",
          'if (!openaiApiKey) throw new Error("OPENAI_API_KEY is not configured");',
        ].join("\n"),
        detector: {
          kind: "regex",
          pattern: "(?:api[_-]?key|secret|password)\\s*[:=]\\s*[\"'][A-Za-z0-9/_+.-]{8,}[\"']",
          flags: "i",
        },
        severity: "block",
        rationale: "Keys belong in bridge/.env or the private settings store, never in code or the iOS bundle.",
        origin: { channel: "manual", detail: "seed" },
      },
      {
        title: "fetch without a timeout",
        description: "A fetch call with no AbortSignal can wait forever on a stalled peer.",
        language: "typescript",
        wrong: [
          "// Wrong: a stalled endpoint hangs the serial queue forever.",
          "const response = await fetch(url);",
        ].join("\n"),
        correct: [
          "// Correct: every network call carries an abort timeout.",
          "const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });",
        ].join("\n"),
        detector: { kind: "regex", pattern: "await\\s+fetch\\((?![^;]*signal)" },
        severity: "warn",
        rationale: "An unbounded network call can hang a serial queue forever; every fetch here carries AbortSignal.timeout.",
        origin: { channel: "manual", detail: "seed" },
      },
      {
        title: "parseInt without a radix",
        description: "parseInt with no radix argument leaves the base up to the input's prefix.",
        language: "any",
        wrong: [
          '// Wrong: "08" and "0x8" parse differently when the base is implied.',
          "const port = parseInt(value);",
        ].join("\n"),
        correct: [
          "// Correct: state the base explicitly.",
          "const port = parseInt(value, 10);",
        ].join("\n"),
        detector: { kind: "regex", pattern: "\\bparseInt\\s*\\([^,)]+\\)(?!\\s*,)" },
        severity: "warn",
        rationale: "An implied radix lets prefixed input choose its own base; numeric configuration must parse the same on every engine and every input.",
        origin: { channel: "manual", detail: "seed" },
      },
      {
        title: "Deleting knowledge instead of invalidating it",
        description: "Removing a fact record destroys the graph's ability to explain what the system believed and when.",
        language: "typescript",
        wrong: [
          "// Wrong: deletion erases the graph's ability to explain past reasoning.",
          "facts.delete(factId);",
        ].join("\n"),
        correct: [
          '// Correct: supersede bi-temporally so "as of" queries still explain the past.',
          'await graph.invalidateFact(factId, "superseded by a newer decision");',
        ].join("\n"),
        detector: { kind: "regex", pattern: "\\b(?:DELETE\\s+FROM\\s+facts|facts\\.delete\\(|removeFact\\()" },
        severity: "warn",
        rationale: "The Second Brain is bi-temporal; superseded facts are invalidated with transaction time so past reasoning stays explainable.",
        origin: { channel: "manual", detail: "seed" },
      },
    ];
    return seeds.map(seed => this.materialize(seed));
  }
}

/**
 * A conservative cross-language comment test: //, #, ;, block-comment lines
 * and doc-comment continuations (`* …`). Detection stays line-local by
 * design — precise multi-line comment tracking would need a per-language
 * parser and the cost of a miss here is one advisory finding, not a defect.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//")
    || trimmed.startsWith("#")
    || trimmed.startsWith("*")
    || trimmed.startsWith("/*")
    || trimmed.startsWith("<!--");
}

function severityRank(severity: AntiPattern["severity"]): number {
  return severity === "block" ? 0 : 1;
}

/**
 * A pattern scoped to one language never fires on another language's text;
 * an unscoped check (no language supplied) runs everything so the pre-commit
 * gate stays conservative when the caller cannot name the language.
 */
function languageApplies(patternLanguage: string, supplied: string | undefined): boolean {
  if (patternLanguage === "any" || !supplied) return true;
  return patternLanguage.toLowerCase() === supplied.toLowerCase();
}

/**
 * Detectors come from a disk file the owner (or a future learning loop) can
 * edit, so a regex that fails to compile is skipped rather than allowed to
 * throw out of every subsequent check. Sticky/global flags are stripped
 * because matching is per line and RegExp lastIndex state would make results
 * order-dependent.
 */
function compileMatcher(detector: AntiPatternDetector): ((line: string) => boolean) | null {
  if (detector.kind === "substring") {
    const needle = detector.needle;
    return line => line.includes(needle);
  }
  try {
    const flags = (detector.flags ?? "").replace(/[gy]/g, "");
    const regex = new RegExp(detector.pattern, flags);
    return line => regex.test(line);
  } catch {
    return null;
  }
}

/**
 * Wrong/Correct examples are code, so unlike single-line brain text they keep
 * newlines and tabs — but still lose other control characters and anything
 * the shared secret redaction recognizes.
 */
function sanitizeExample(value: string): string {
  return redactBrainText(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 2_000);
}
