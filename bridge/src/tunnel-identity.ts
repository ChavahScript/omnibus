import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const StoredTunnelIdentitySchema = z.object({
  version: z.literal(1),
  subdomain: z.string().regex(/^omnibus-[a-z0-9]{16}$/),
  createdAt: z.string().datetime(),
});

/**
 * Gives a bridge workspace one stable requested localtunnel subdomain. This
 * is not an authentication secret—the QR pairing token remains the security
 * boundary—but it gives an already paired phone the same public origin after
 * ordinary relay reconnects instead of making a phone on cellular rediscover
 * a random URL.
 */
export class TunnelIdentityStore {
  private readonly target: string;

  public constructor(private readonly statePath: string) {
    this.target = path.join(statePath, "tunnel-identity.json");
  }

  /** An explicit owner configuration always wins over the generated identity. */
  public async resolve(ownerSubdomain?: string): Promise<string | undefined> {
    const explicit = ownerSubdomain?.trim().toLowerCase();
    if (explicit) return explicit;
    const existing = await this.load();
    if (existing) return existing.subdomain;
    const identity = {
      version: 1 as const,
      subdomain: `omnibus-${randomBytes(8).toString("hex")}`,
      createdAt: new Date().toISOString(),
    };
    try {
      await this.write(identity);
      return identity.subdomain;
    } catch {
      // A read-only state directory must not make a local coordinator fail to
      // start. The tunnel still runs with the provider's ephemeral name; the
      // terminal makes fresh QR pairing available if that endpoint changes.
      return undefined;
    }
  }

  public get path(): string {
    return this.target;
  }

  private async load(): Promise<z.infer<typeof StoredTunnelIdentitySchema> | undefined> {
    try {
      const parsed = StoredTunnelIdentitySchema.safeParse(JSON.parse(await readFile(this.target, "utf8")));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private async write(identity: z.infer<typeof StoredTunnelIdentitySchema>): Promise<void> {
    await mkdir(this.statePath, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.statePath, `.tunnel-identity-${randomUUID()}.tmp`);
    let committed = false;
    try {
      await writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.target);
      committed = true;
      await chmod(this.target, 0o600);
    } finally {
      if (!committed) await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
