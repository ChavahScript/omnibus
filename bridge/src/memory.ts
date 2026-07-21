import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { AgentSnapshotSchema, type AgentName, type AgentSnapshot } from "./contracts.js";

const EMPTY_MEMORY: AgentSnapshot = { version: 1, updatedAt: new Date(0).toISOString(), entries: [] };

/**
 * JSON-only memory is intentionally serializable and atomic. It stores short
 * work products, not hidden chain-of-thought, and can be inspected in a demo.
 */
export class SerializableAgentMemory {
  private readonly target: string;

  public constructor(stateDir: string) {
    this.target = path.join(stateDir, "agent-memory.json");
  }

  public async append(correlationId: string, role: AgentName, kind: string, value: string, scope?: string): Promise<void> {
    const state = await this.read();
    state.entries.push({
      correlationId,
      ...(scope ? { scope: scope.slice(0, 128) } : {}),
      role,
      kind,
      value: value.slice(0, 16_000),
      at: new Date().toISOString(),
    });
    state.entries = state.entries.slice(-200);
    state.updatedAt = new Date().toISOString();
    await this.write(state);
  }

  public async recent(correlationId: string): Promise<AgentSnapshot["entries"]> {
    return (await this.read()).entries.filter(entry => entry.correlationId === correlationId);
  }

  /**
   * Returns only compact, useful work products from the same paired device.
   * Directives and queue metadata are excluded so a later request gets useful
   * continuity without replaying a user's entire private command history.
   */
  public async contextualRecent(scope: string, excludingCorrelationId: string): Promise<AgentSnapshot["entries"]> {
    const usefulKinds = new Set(["rationale_summary", "result"]);
    return (await this.read()).entries
      .filter(entry => entry.scope === scope && entry.correlationId !== excludingCorrelationId && usefulKinds.has(entry.kind))
      .slice(-8);
  }

  private async read(): Promise<AgentSnapshot> {
    try {
      return AgentSnapshotSchema.parse(JSON.parse(await readFile(this.target, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_MEMORY);
      throw error;
    }
  }

  private async write(state: AgentSnapshot): Promise<void> {
    await mkdir(path.dirname(this.target), { recursive: true, mode: 0o700 });
    const temporary = `${this.target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.target);
  }
}
