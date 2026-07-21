import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { WorkspaceContext, WorkspaceContextFile, WorkspaceContextSnippet } from "./contracts.js";

const BLOCKED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".omnibus",
  "node_modules",
  "Pods",
  "vendor",
  "coverage",
  "dist",
  "build",
  ".next",
]);

const BLOCKED_FILE_NAMES = new Set([
  ".env",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials",
  "credentials.json",
]);

const BLOCKED_FILE_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /(?:^|[._-])(secret|secrets|credential|credentials|private|apikey|api[_-]?key|token)(?:[._-]|$)/i,
  /\.(?:pem|key|p8|p12|pfx|cer|crt|der|mobileprovision)$/i,
];

const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html", ".java", ".js", ".json", ".jsx", ".kt", ".kts",
  ".m", ".md", ".mm", ".php", ".py", ".rb", ".rs", ".scala", ".scss", ".sh", ".sql", ".swift", ".toml", ".ts", ".tsx",
  ".txt", ".vue", ".xml", ".yaml", ".yml",
]);

const SAFE_BASENAMES = new Set([
  "Dockerfile",
  "Gemfile",
  "LICENSE",
  "Makefile",
  "Podfile",
  "README",
  "README.md",
  "README.mdx",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

const MAX_DEPTH = 7;
const MAX_SCANNED_ENTRIES = 900;
const MAX_FILE_BYTES = 262_144;

export type WorkspaceContextOptions = {
  maxFiles: number;
  maxSnippets: number;
  maxChars: number;
};

/**
 * Builds a deliberately small local-only source map for the Auditor.
 *
 * The scanner refuses symlinks, hidden files, VCS/dependency directories, and
 * filenames associated with credentials. It additionally skips any otherwise
 * safe-looking file that contains a likely literal credential. No network is
 * used and no file outside the resolved workspace root is opened.
 */
export async function collectWorkspaceContext(
  workspaceRoot: string,
  options: WorkspaceContextOptions,
): Promise<WorkspaceContext> {
  const limits = normalizeLimits(options);
  let root: string;
  try {
    root = await realpath(workspaceRoot);
  } catch (error) {
    return unavailableWorkspaceContext(`Workspace context is unavailable: ${errorMessage(error)}`);
  }

  const candidates: WorkspaceContextFile[] = [];
  const omitted = {
    excluded: 0,
    oversized: 0,
    unreadable: 0,
    sensitive: 0,
    truncated: false,
  };
  let scannedEntries = 0;

  const walk = async (directory: string, relativeDirectory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || scannedEntries >= MAX_SCANNED_ENTRIES || candidates.length >= limits.maxFiles) {
      omitted.truncated = true;
      return;
    }

    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      omitted.unreadable += 1;
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (scannedEntries >= MAX_SCANNED_ENTRIES || candidates.length >= limits.maxFiles) {
        omitted.truncated = true;
        return;
      }
      scannedEntries += 1;
      const relativePath = toPortablePath(relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name);
      const target = path.join(directory, entry.name);

      // Dirent is a first pass only. lstat makes the symlink boundary explicit
      // in the face of an entry changing between directory enumeration and use.
      let details: Awaited<ReturnType<typeof lstat>>;
      try {
        details = await lstat(target);
      } catch {
        omitted.unreadable += 1;
        continue;
      }
      if (details.isSymbolicLink()) {
        omitted.excluded += 1;
        continue;
      }

      if (details.isDirectory()) {
        if (isBlockedDirectory(entry.name) || entry.name.startsWith(".")) {
          omitted.excluded += 1;
          continue;
        }
        await walk(target, relativePath, depth + 1);
        continue;
      }
      if (!details.isFile()) {
        omitted.excluded += 1;
        continue;
      }
      if (!isCandidateFile(entry.name) || entry.name.startsWith(".")) {
        omitted.excluded += 1;
        continue;
      }
      if (details.size > MAX_FILE_BYTES) {
        omitted.oversized += 1;
        continue;
      }
      candidates.push({ path: relativePath, bytes: details.size });
    }
  };

  await walk(root, "", 0);
  const snippets: WorkspaceContextSnippet[] = [];
  let remainingChars = limits.maxChars;
  for (const candidate of candidates.slice().sort(compareCandidatePriority)) {
    if (snippets.length >= limits.maxSnippets || remainingChars <= 0) break;
    const target = path.join(root, candidate.path);
    let content: string;
    try {
      content = await readFile(target, "utf8");
    } catch {
      omitted.unreadable += 1;
      continue;
    }
    if (containsBinaryContent(content)) {
      omitted.excluded += 1;
      continue;
    }
    if (containsLikelySecret(content)) {
      // Skipping the entire file is safer than redacting a pattern we might
      // not recognize. It also means audit logs never gain the raw snippet.
      omitted.sensitive += 1;
      continue;
    }
    const excerpt = content.slice(0, remainingChars);
    if (!excerpt.trim()) continue;
    snippets.push({
      path: candidate.path,
      text: excerpt,
      truncated: content.length > excerpt.length,
    });
    remainingChars -= excerpt.length;
  }

  return {
    available: true,
    files: candidates,
    snippets,
    scannedEntries,
    omitted,
  };
}

/** Keeps the local Auditor prompt small without giving it an absolute path. */
export function formatWorkspaceContext(context: WorkspaceContext): string {
  if (!context.available) return context.note ?? "No workspace context was available.";
  const files = context.files.length
    ? context.files.map(file => `- ${file.path} (${file.bytes} bytes)`).join("\n")
    : "- No safe source files were selected.";
  const snippets = context.snippets.length
    ? context.snippets.map(snippet => [
      `--- ${snippet.path}${snippet.truncated ? " (truncated)" : ""} ---`,
      snippet.text,
    ].join("\n")).join("\n\n")
    : "No file snippets were included.";
  return [
    "Safe local workspace context (bounded and automatically filtered):",
    "File map:",
    files,
    "Selected source snippets:",
    snippets,
  ].join("\n");
}

/** Creates a no-source context when a caller cannot safely inspect a workspace. */
export function unavailableWorkspaceContext(note: string): WorkspaceContext {
  return {
    available: false,
    note: note.slice(0, 500),
    files: [],
    snippets: [],
    scannedEntries: 0,
    omitted: { excluded: 0, oversized: 0, unreadable: 0, sensitive: 0, truncated: false },
  };
}

function normalizeLimits(options: WorkspaceContextOptions): WorkspaceContextOptions {
  return {
    maxFiles: clampInteger(options.maxFiles, 1, 64),
    maxSnippets: clampInteger(options.maxSnippets, 0, 12),
    maxChars: clampInteger(options.maxChars, 512, 24_000),
  };
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function isBlockedDirectory(name: string): boolean {
  return BLOCKED_DIRECTORY_NAMES.has(name) || BLOCKED_FILE_PATTERNS.some(pattern => pattern.test(name));
}

function isCandidateFile(name: string): boolean {
  if (BLOCKED_FILE_NAMES.has(name) || BLOCKED_FILE_PATTERNS.some(pattern => pattern.test(name))) return false;
  return SAFE_BASENAMES.has(name) || SOURCE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function compareCandidatePriority(left: WorkspaceContextFile, right: WorkspaceContextFile): number {
  return candidatePriority(right.path) - candidatePriority(left.path) || left.path.localeCompare(right.path);
}

function candidatePriority(relativePath: string): number {
  const name = path.basename(relativePath);
  if (/^README(?:\.|$)/i.test(name)) return 4;
  if (name === "package.json") return 3;
  if (/^(src|app|lib)\//.test(toPortablePath(relativePath))) return 2;
  return 1;
}

function containsBinaryContent(content: string): boolean {
  return content.includes("\u0000");
}

function containsLikelySecret(content: string): boolean {
  return [
    /sk-[A-Za-z0-9_-]{16,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bBearer\s+[A-Za-z0-9._-]{12,}/i,
    /(?:api[_-]?key|access[_-]?token|secret|password|private[_-]?key)\s*[:=]\s*["'`][^"'`\r\n]{8,}/i,
  ].some(pattern => pattern.test(content));
}

function toPortablePath(value: string): string {
  return value.split(path.sep).join("/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 400) : "Unknown filesystem error.";
}
