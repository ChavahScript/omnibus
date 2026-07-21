import qrcode from "qrcode-terminal";
import type { AppConfig } from "./config.js";
import { createMastraRuntime } from "./agents/mastra.js";
import { createBridgeServer, type BridgeServer } from "./server.js";
import { openTunnel, type TunnelHandle } from "./tunnel.js";
import { KeepAwakeController } from "./keep-awake.js";
import { TunnelIdentityStore } from "./tunnel-identity.js";

export type RunningBridge = {
  bridge: BridgeServer;
  tunnel: TunnelHandle;
  close: () => Promise<void>;
};

// The Second Brain composition is exported for embedding desktop hosts; the
// running bridge constructs and manages its own instance internally.
export { SecondBrain } from "./second-brain/second-brain.js";
export { BiTemporalKnowledgeGraph } from "./second-brain/knowledge-graph.js";
export { HippoRagRetriever } from "./second-brain/hipporag.js";
export { AntiPatternRegistry } from "./second-brain/anti-patterns.js";
export { installPreCommitHook, runPreCommitCheck, uninstallPreCommitHook } from "./second-brain/precommit.js";

/**
 * Starts the public pairing bridge after the CLI has prepared the local model
 * team. Kept as an importable function so the published package has no
 * side-effect at import time and can be embedded safely by a desktop host.
 */
export async function startBridge(config: AppConfig): Promise<RunningBridge> {
  // Persisting a requested relay name makes the public origin normally stable
  // across relay reconnects. It is not a secret and never weakens the QR
  // token; an explicit TUNNEL_SUBDOMAIN remains the owner's override.
  config.tunnelSubdomain = await new TunnelIdentityStore(config.statePath).resolve(config.tunnelSubdomain);
  // Constructing the Mastra graph at startup makes the agent topology typed and
  // inspectable; operational state is persisted separately as JSON audit data.
  createMastraRuntime(config);
  const bridge = createBridgeServer(config);
  const keepAwake = new KeepAwakeController({
    enabled: config.keepAwakeEnabled,
    onStatus: status => {
      // The bridge still runs if an OS policy rejects the helper. This local
      // status is intentionally terminal-only, never exposed through pairing.
      if (status.active || status.restartAttempt > 0 || status.strategy === "unavailable") {
        console.log(`[power] ${status.message}`);
      }
    },
  });
  await keepAwake.start();
  try {
    await bridge.listen();
    const tunnel = await openTunnel(config);
    let printedGeneration = 0;
    let lastLifecycleNotice = "";

    /**
     * A QR secret is intentionally rendered exactly once.  The pairing class
     * erases its raw value after this call, so an endpoint recovery produces a
     * new token rather than quietly reusing a screenshot-able credential.
     */
    const printPairingQr = (url: string, replacement: boolean): void => {
      try {
        const qrPayload = bridge.pairing.qrPayload(url);
        console.log(`\nOmnibus bridge${replacement ? " recovered" : ""}: ${url}`);
        console.log(replacement
          ? "The public relay changed. Scan this fresh one-time code from the iOS dashboard."
          : "Scan this once from the iOS dashboard. It contains the secure pairing token.");
        qrcode.generate(qrPayload, { small: true });
      } catch (error) {
        // A QR print failure must never crash the only local coordinator. The
        // terminal makes the recovery action explicit instead of leaving a
        // live relay with an unknowable pairing state.
        console.error(`[pairing] Could not print the one-time QR code: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    };

    const unsubscribeTunnel = tunnel.subscribe(status => {
      if (status.kind === "online") {
        lastLifecycleNotice = "";
        if (status.generation <= printedGeneration) return;
        const isInitialEndpoint = printedGeneration === 0;
        printedGeneration = status.generation;
        if (isInitialEndpoint || status.requiresFreshPairing) {
          if (status.requiresFreshPairing) bridge.rotatePairing();
          printPairingQr(status.url, status.requiresFreshPairing);
        } else {
          // The supervised relay came back at the already-paired public
          // origin. Preserve the current QR/resume generation so an iPhone
          // that briefly lost service can reconnect on its own.
          console.log(`[tunnel] Phone relay recovered at its existing address; paired iPhones will resume automatically.`);
        }
        return;
      }

      // Avoid repainting the terminal on every listener tick while still
      // leaving a clear, user-actionable audit trail for a real outage.
      const notice = status.kind === "recovering"
        ? `recovering:${status.attempt}:${status.reason}`
        : status.kind === "failed"
          ? `failed:${status.reason}:${status.nextRetryInMs ?? 0}`
          : status.kind === "connecting"
            ? `connecting:${status.reason}:${status.attempt}`
          : "";
      if (!notice || notice === lastLifecycleNotice) return;
      lastLifecycleNotice = notice;
      if (status.kind === "connecting") {
        console.log(`[tunnel] Opening the secure phone relay (attempt ${status.attempt + 1})…`);
      } else if (status.kind === "recovering") {
        console.warn(`[tunnel] Phone relay is recovering; existing local work continues. Retrying in ${Math.ceil(status.retryInMs / 1_000)}s.`);
      } else if (status.kind === "failed") {
        const retry = status.nextRetryInMs ? ` It will try again in ${Math.ceil(status.nextRetryInMs / 60_000)} minutes.` : "";
        console.error(`[tunnel] Phone relay is unavailable.${retry} Keep this terminal open; Home Fleet and local work remain private-LAN/local.`);
      }
    });

    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      unsubscribeTunnel();
      await Promise.allSettled([tunnel.close(), bridge.close(), keepAwake.stop()]);
    })();
    const shutdown = async () => {
      await close();
      process.exit(0);
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    // Closing a terminal delivers SIGHUP on macOS/Linux, and Node synthesizes
    // SIGHUP on Windows console-window close (with a short OS deadline), so
    // registering it releases the tunnel and sleep lease cleanly on all three.
    process.once("SIGHUP", () => void shutdown());
    return { bridge, tunnel, close };
  } catch (error) {
    await Promise.allSettled([bridge.close(), keepAwake.stop()]);
    throw error;
  }
}
