import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /("(?:api[_-]?key|token|secret|password)"\s*:\s*")[^"]+/gi,
];

export type AuditEvent = {
  at: string;
  correlationId: string;
  agent: "auditor" | "developer" | "marketing" | "system";
  event: string;
  data: Record<string, unknown>;
};

/** Append-only NDJSON preserves a reviewable event sequence without placing secrets in the trail. */
export class AuditTrail {
  public constructor(private readonly auditDir: string) {}

  public async append(event: AuditEvent): Promise<void> {
    await mkdir(this.auditDir, { recursive: true, mode: 0o700 });
    const day = event.at.slice(0, 10);
    const target = path.join(this.auditDir, `${day}.audit.ndjson`);
    const safeEvent = sanitize(event);
    await appendFile(target, `${JSON.stringify(safeEvent)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

function sanitize<T>(value: T): T {
  const json = JSON.stringify(value, (_key, nested) => {
    if (typeof nested !== "string") return nested;
    return SECRET_PATTERNS.reduce((clean, pattern) => clean.replace(pattern, match => {
      if (match.startsWith('"')) return `${match.slice(0, match.indexOf(":") + 2)}[REDACTED]`;
      return "[REDACTED]";
    }), nested);
  });
  return JSON.parse(json) as T;
}
