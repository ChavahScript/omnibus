import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuditTrail } from "../audit.js";
import type { AppConfig } from "../config.js";

type HiggsfieldJob = {
  id?: string;
  status?: string;
  assetUrl?: string;
};

type MarketingHandoff = {
  version: 1;
  createdAt: string;
  correlationId: string;
  provider: "higgsfield-cli";
  prompt: string;
  job: HiggsfieldJob;
  distribution: {
    state: "owner-review-required";
    supportedChannels: ["TikTok", "Meta"];
    nextSteps: string[];
  };
};

export class MarketingOpsAgent {
  public constructor(private readonly config: AppConfig, private readonly audit: AuditTrail) {}

  /**
   * Uses Higgsfield's official CLI as its API client. A successful job produces
   * an owner-readable handoff manifest under the local Omnibus state folder.
   * The manifest intentionally stops before social distribution: each platform
   * needs its own reviewed OAuth application, account authorization, and final
   * creative approval. There is no scraping, review bypass, or wrapper route.
   */
  public async createVideo(correlationId: string, brief: string, onProgress: (text: string) => void): Promise<string> {
    if (!this.config.higgsfieldExecutionEnabled) {
      return "Marketing execution is armed off. Set HIGGSFIELD_EXECUTION_ENABLED=true after authenticating the official Higgsfield CLI.";
    }
    const prompt = buildMarketingPrompt(brief);
    const args = this.config.higgsfieldSoulId
      ? ["generate", "create", "soul_cinema_studio", "--prompt", prompt, "--soul-id", this.config.higgsfieldSoulId, "--duration", "15", "--aspect_ratio", "9:16", "--wait", "--json"]
      : ["generate", "create", "marketing_studio_video", "--prompt", prompt, "--mode", "ugc", "--duration", "15", "--resolution", "720p", "--aspect_ratio", "9:16", "--wait", "--json"];
    await this.audit.append({ at: new Date().toISOString(), correlationId, agent: "marketing", event: "higgsfield_start", data: { command: this.config.higgsfieldCommand, args: redactArgs(args), prompt } });
    onProgress("Creating approved Higgsfield Marketing Studio video.");
    const output = await runHiggsfield(this.config.higgsfieldCommand, args, line => onProgress(normaliseProgress(line)));
    const job = extractHiggsfieldJob(output);
    onProgress("Preparing the owner-reviewed distribution handoff.");
    const handoffPath = await writeHandoff(this.config, correlationId, prompt, job);
    await this.audit.append({
      at: new Date().toISOString(),
      correlationId,
      agent: "marketing",
      event: "higgsfield_complete",
      data: { job, handoffPath, output: output.slice(-12_000) },
    });
    return formatCompletion(job, handoffPath);
  }

  public distributionBoundary(): string {
    return "Omnibus never auto-publishes. If the job completed, review its local distribution handoff and publish only through TikTok and Meta OAuth applications that your organization has registered, reviewed, and authorized.";
  }
}

/** Kept compact and specific so a raw idea cannot accidentally become an unlimited CLI prompt. */
export function buildMarketingPrompt(brief: string): string {
  const source = brief.trim().slice(0, 6_000);
  return [
    "Create a polished 15-second vertical product-story video for an owner-approved campaign.",
    "Use the supplied creative brief; avoid third-party trademarks, copyrighted characters, logos, or music unless explicitly licensed by the owner.",
    "Use clear visual storytelling, a strong opening moment, and no unverified claims.",
    "Creative brief:",
    source,
  ].join("\n\n");
}

function runHiggsfield(command: string, args: string[], onLine: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new Error("Higgsfield did not finish within 15 minutes. Check the official CLI job status, then retry.")));
    }, 15 * 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output = appendBounded(output, text);
      text.split("\n").filter(Boolean).forEach(onLine);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = appendBounded(stderr, chunk.toString("utf8")); });
    child.once("error", error => finish(() => reject(new Error(`Could not start the official Higgsfield CLI: ${error.message}`))));
    child.once("close", code => finish(() => code === 0
      ? resolve(output)
      : reject(new Error(`Higgsfield exited with ${code ?? "unknown"}: ${stderr.slice(-2_000)}`))));
  });
}

/** Accepts both one JSON document and line-oriented CLI progress output. */
export function extractHiggsfieldJob(output: string): HiggsfieldJob {
  const candidates: unknown[] = [];
  const trimmed = output.trim();
  if (trimmed) {
    try { candidates.push(JSON.parse(trimmed)); } catch { /* Try the individual output lines below. */ }
  }
  for (const line of output.split("\n").reverse()) {
    try { candidates.push(JSON.parse(line)); } catch { /* Progress lines are not necessarily JSON. */ }
  }
  for (const candidate of candidates) {
    const extracted = findJob(candidate);
    if (extracted.id || extracted.assetUrl || extracted.status) return extracted;
  }
  return {};
}

async function writeHandoff(config: AppConfig, correlationId: string, prompt: string, job: HiggsfieldJob): Promise<string> {
  const directory = path.join(config.statePath, "marketing");
  const target = path.join(directory, `${correlationId}.json`);
  const handoff: MarketingHandoff = {
    version: 1,
    createdAt: new Date().toISOString(),
    correlationId,
    provider: "higgsfield-cli",
    prompt,
    job,
    distribution: {
      state: "owner-review-required",
      supportedChannels: ["TikTok", "Meta"],
      nextSteps: [
        "Review the generated asset and claims before distribution.",
        "Use your organization’s approved TikTok or Meta OAuth publisher application.",
        "Attach platform-specific captions, disclosure, rights, and audience settings before posting.",
      ],
    },
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(target, JSON.stringify(handoff, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  return target;
}

function findJob(value: unknown, depth = 0): HiggsfieldJob {
  if (depth > 5 || !value || typeof value !== "object") return {};
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findJob(child, depth + 1);
      if (found.id || found.assetUrl || found.status) return found;
    }
    return {};
  }
  const record = value as Record<string, unknown>;
  const direct: HiggsfieldJob = {
    id: firstString(record, ["id", "job_id", "jobId", "generation_id", "generationId"]),
    status: firstString(record, ["status", "state"]),
    assetUrl: firstString(record, ["url", "asset_url", "assetUrl", "video_url", "videoUrl", "output_url", "outputUrl"]),
  };
  if (direct.id || direct.assetUrl || direct.status) return direct;
  for (const child of Object.values(record)) {
    const found = findJob(child, depth + 1);
    if (found.id || found.assetUrl || found.status) return found;
  }
  return {};
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  return undefined;
}

function appendBounded(current: string, incoming: string): string {
  const combined = current + incoming;
  return combined.length <= 96_000 ? combined : combined.slice(-96_000);
}

function normaliseProgress(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500) || "Higgsfield is processing the approved creative brief.";
}

function formatCompletion(job: HiggsfieldJob, handoffPath: string): string {
  const lines = ["Marketing asset job completed through the official Higgsfield CLI."];
  if (job.id) lines.push(`Job ID: ${job.id}`);
  if (job.status) lines.push(`Status: ${job.status}`);
  if (job.assetUrl) lines.push(`Asset: ${job.assetUrl}`);
  lines.push(`Local distribution handoff: ${handoffPath}`);
  return lines.join("\n");
}

function redactArgs(args: string[]): string[] {
  return args.map(argument => argument.startsWith("sk-") ? "[REDACTED]" : argument);
}
