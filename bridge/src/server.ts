import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import express from "express";
import pino from "pino";
import { WebSocket, WebSocketServer } from "ws";
import type { AppConfig } from "./config.js";
import { UsageLedger } from "./usage.js";
import { ClientMessageSchema, classifyClientMessageRejection, type BridgeEvent, type ClientMessage } from "./contracts.js";
import { AuditTrail } from "./audit.js";
import { SerializableAgentMemory } from "./memory.js";
import { PairingResumptionStore, PairingToken, BYPASS_TUNNEL_HEADER, RESUME_SESSION_HEADER } from "./security.js";
import { CommandOrchestrator } from "./agents/orchestrator.js";
import { BridgeSettingsError, BridgeSettingsStore } from "./bridge-settings.js";
import { FleetController, FleetControllerError } from "./fleet-controller.js";
import { HomeFleetService, HomeFleetServiceError } from "./home-fleet-service.js";
import { DeviceEventReplay } from "./device-event-replay.js";
import { SecondBrain } from "./second-brain/second-brain.js";

export type BridgeServer = {
  pairing: PairingToken;
  /** Invalidates QR and transient reconnect secrets before a fresh QR prints. */
  rotatePairing: () => void;
  listen: () => Promise<void>;
  close: () => Promise<void>;
  broadcast: (event: BridgeEvent) => void;
};

export function createBridgeServer(config: AppConfig): BridgeServer {
  const logger = pino({ level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.authorization", `req.headers.${RESUME_SESSION_HEADER}`, "token"] });
  const app = express();
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    // Localtunnel's warning is bypassed by this request header. Native clients
    // send it on their WebSocket request; exposing it here also documents the
    // required header in normal health probes and generated clients.
    response.setHeader("Access-Control-Allow-Headers", `Content-Type, ${BYPASS_TUNNEL_HEADER}, ${RESUME_SESSION_HEADER}`);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  app.get("/health", (_request, response) => response.status(200).json({ ok: true, service: "omnibus-bridge" }));

  const httpServer = createServer(app);
  // 128KB comfortably covers a schema-legal 12,000-character directive even
  // when every character is multibyte and JSON-escaped (~72KB observed). The
  // frame limit exists only to bound memory; zod does the actual rejecting so
  // an over-long idea gets a humane error event instead of a bare 1009 close.
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  const clients = new Set<WebSocket>();
  // A rolling resume token identifies one iPhone-held device scope. Keeping a
  // single active socket for it prevents a race during Wi-Fi/cellular handoff
  // from duplicating event delivery or letting a stale connection consume a
  // command after its replacement is live.
  const activeSocketByDevice = new Map<string, WebSocket>();
  const pairing = new PairingToken();
  const resumptions = new PairingResumptionStore();
  // Progress frames are bound to a paired device identity rather than a
  // particular TCP/WebSocket socket. This is what lets an in-flight local
  // run survive the phone moving between Wi-Fi and cellular.
  const deviceEvents = new DeviceEventReplay();
  const upgradeSessions = new WeakMap<object, { deviceId: string; resumeToken: string; resumed: boolean }>();
  // This ledger is deliberately observational. It supplies transparent model
  // usage to a paired client and audit trail, but never blocks a command.
  const usage = new UsageLedger();
  const audit = new AuditTrail(config.auditPath);
  // This listener is deliberately separate from the loopback bridge and its
  // public localtunnel URL. It advertises one concrete RFC1918 address only
  // to explicitly invited laptops on the same trusted private network.
  const homeFleet = new HomeFleetService(config);
  // The Second Brain is workspace-scoped persistent knowledge. It observes
  // the environment and every idea/brief, retrieves linked memories for the
  // local Auditor, and compiles the (opt-in) redacted Home Fleet context
  // bundle. All of its state stays under .omnibus/state/brain.
  const brain = new SecondBrain(config, audit);
  const orchestrator = new CommandOrchestrator(
    config,
    audit,
    new SerializableAgentMemory(config.statePath),
    usage,
    homeFleet,
    brain,
  );
  // Ambient distillation borrows the same local Ollama runtime as live
  // inference; the busy probe makes it yield (heuristic fallback) while the
  // single-flight queue is actually working.
  brain.setInferenceBusyProbe(() => orchestrator.isBusy);
  brain.setFleetCacheStatusProvider(() => homeFleet.cacheStatus());
  homeFleet.setContextBundleProvider(() => brain.fleetBundle());
  const fleet = new FleetController(config, new BridgeSettingsStore(config.statePath), audit, () => homeFleet.snapshot());
  // Correlation ids of commands dispatched to the orchestrator that have not
  // yet produced their terminal result/error frame. This is how the bridge
  // knows a pairing rotation is abandoning in-flight work: the finished brief
  // stays in the local audit log, and the next pairing deserves to hear that
  // it exists without any brief content crossing the new trust boundary.
  const inFlightCorrelationIds = new Set<string>();
  let previousSessionNoticePending = false;

  httpServer.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const bypassHeader = request.headers[BYPASS_TUNNEL_HEADER];
    const hasBypassHeader = Array.isArray(bypassHeader) ? bypassHeader.includes("true") : bypassHeader === "true";
    if (requestUrl.pathname !== "/ws" || !hasBypassHeader) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const resumeHeader = request.headers[RESUME_SESSION_HEADER];
    const resumeToken = Array.isArray(resumeHeader) ? undefined : resumeHeader;
    const pairedFromQr = pairing.verify(requestUrl.searchParams.get("token"));
    const resumedDeviceId = pairedFromQr ? undefined : resumptions.consume(resumeToken);
    if (!pairedFromQr && !resumedDeviceId) {
      // React Native reports an HTTP-upgrade 401 as the indistinguishable
      // WebSocket code 1006. For a *previously paired* device this is the one
      // case where iOS needs a definitive answer: the in-memory bridge was
      // restarted, the twelve-hour session elapsed, or its secret changed.
      // Complete the upgrade and close with 1008 so the app can delete only
      // that stale Keychain record and ask for a fresh QR instead of retrying
      // an expired bearer forever. Invalid QR scans still receive plain 401.
      if (resumeToken && !requestUrl.searchParams.has("token")) {
        webSocketServer.handleUpgrade(request, socket, head, rejectedSocket => {
          rejectedSocket.close(1008, "Omnibus resume session expired");
        });
        return;
      }
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const deviceId = resumedDeviceId ?? randomUUID();
    // Rotate after every successful resume. The replacement is sent only in
    // `hello`, then stored by iOS in its device-only Keychain. It never
    // becomes a query parameter, audit record, or bridge disk credential.
    upgradeSessions.set(request, {
      deviceId,
      resumeToken: resumptions.issue(deviceId),
      resumed: Boolean(resumedDeviceId),
    });
    webSocketServer.handleUpgrade(request, socket, head, webSocket => webSocketServer.emit("connection", webSocket, request));
  });

  webSocketServer.on("connection", (socket, request) => {
    const session = upgradeSessions.get(request);
    if (!session) {
      socket.close(1008, "pairing session missing");
      return;
    }
    const { deviceId, resumeToken, resumed } = session;
    const previousSocket = activeSocketByDevice.get(deviceId);
    if (previousSocket && previousSocket !== socket) {
      previousSocket.close(4001, "superseded by resumed Omnibus connection");
    }
    activeSocketByDevice.set(deviceId, socket);
    clients.add(socket);
    const eventBinding = deviceEvents.bind(deviceId, event => send(socket, event), resumed);
    // Non-command frames emitted by an in-flight job are delivered through
    // this indirection. Once the phone reconnects, the same job callback
    // automatically targets the replacement socket instead of a dead one.
    const deliver = (event: BridgeEvent): void => {
      // Terminal frames close out the in-flight command they answer; this is
      // the delivery-side half of the pairing-rotation orphaned-work notice.
      if ((event.type === "result" || event.type === "error") && event.correlationId) {
        inFlightCorrelationIds.delete(event.correlationId);
      }
      deviceEvents.emit(deviceId, event);
    };
    send(socket, { type: "hello", deviceId, usage: usage.status(), resumeToken });
    // `hello` is intentionally first: the mobile app commits the rotating
    // resume secret before it processes the small replay tail below.
    for (const event of eventBinding.replay.events) send(socket, event);
    if (previousSessionNoticePending) {
      // One notice on the first connection after a rotation abandoned live
      // work. Only the fact of completion crosses the new pairing boundary;
      // the brief itself stays in the laptop-local audit log.
      previousSessionNoticePending = false;
      deliver({
        type: "status",
        correlationId: randomUUID(),
        agent: "system",
        stage: "previous_session_note",
        text: "An idea from the previous pairing finished on this laptop; its brief is preserved in the local audit log (.omnibus/audit).",
      });
    }
    // Capability data is opt-in at pairing time and consists only of a small,
    // path-free resource summary. This makes the first phone screen useful
    // without asking the owner to edit a bridge environment file.
    void sendFleetSnapshot();
    logger.info({ deviceId }, "Paired Omnibus device");
    socket.on("message", raw => {
      if (!eventBinding.isCurrent()) {
        socket.close(4001, "superseded by resumed Omnibus connection");
        return;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw.toString());
      } catch {
        // No correlation id can be salvaged from a frame that never parsed.
        deliver({ type: "error", code: "INVALID_MESSAGE", message: "The bridge received a message it couldn't read. Update the Omnibus app and try again." });
        return;
      }
      const parsed = ClientMessageSchema.safeParse(decoded);
      if (!parsed.success) {
        const rejection = classifyClientMessageRejection(decoded, parsed.error);
        deliver({ type: "error", correlationId: rejection.correlationId, code: rejection.code, message: rejection.message });
        return;
      }
      void handleMessage(parsed.data);
    });
    const removeSocket = () => {
      clients.delete(socket);
      if (activeSocketByDevice.get(deviceId) === socket) activeSocketByDevice.delete(deviceId);
      eventBinding.detach();
    };
    socket.once("close", removeSocket);
    socket.once("error", removeSocket);

    async function sendFleetSnapshot(): Promise<void> {
      try {
        deliver({ type: "fleet", snapshot: await fleet.snapshot() });
      } catch {
        // The bridge remains usable even if the laptop's capability probe is
        // temporarily unavailable. No host-specific filesystem details cross
        // the WebSocket in this recovery state.
        deliver({ type: "error", code: "FLEET_SNAPSHOT_UNAVAILABLE", message: "The laptop capability check is temporarily unavailable. Try refreshing Fleet Setup." });
      }
    }

    async function handleMessage(message: ClientMessage): Promise<void> {
      if (message.type === "ping") {
        deliver({ type: "pong", sentAt: message.sentAt });
        return;
      }
      if (message.type === "fleet_snapshot") {
        await sendFleetSnapshot();
        return;
      }
      if (message.type === "brain_status") {
        deliver({ type: "brain", status: brain.status() });
        return;
      }
      if (message.type === "fleet_provision") {
        if (orchestrator.isBusy) {
          deliver({
            type: "error",
            correlationId: message.correlationId,
            code: "LOCAL_TEAM_BUSY",
            message: "The local team is finishing an idea. Wait for it to return before changing the model fleet.",
          });
          return;
        }
        orchestrator.pauseForFleetProvisioning();
        try {
          const snapshot = await fleet.provision(message.correlationId, message.profileId, deliver);
          deliver({ type: "fleet", snapshot });
        } catch (error) {
          sendFleetError(message.correlationId, error);
          await sendFleetSnapshot();
        } finally {
          orchestrator.resumeAfterFleetProvisioning();
        }
        return;
      }
      if (message.type === "research_configure") {
        try {
          const snapshot = await fleet.configureResearch(message.correlationId, {
            enabled: message.enabled,
            braveSearchApiKey: message.braveSearchApiKey,
          });
          deliver({ type: "fleet", snapshot });
          deliver({
            type: "status",
            correlationId: message.correlationId,
            agent: "system",
            stage: "research_configuration",
            text: snapshot.research.enabled
              ? "Cited web research is ready. Each idea still asks for its own consent before any query leaves this laptop."
              : "Cited web research is off. New ideas remain local unless you enable it again.",
          });
        } catch (error) {
          sendFleetError(message.correlationId, error);
        }
        return;
      }
      if (message.type === "home_fleet_invite") {
        try {
          const invite = await homeFleet.issueInvite(message.correlationId);
          deliver({ type: "home_fleet_invite", invite });
          await sendFleetSnapshot();
        } catch (error) {
          sendHomeFleetError(message.correlationId, error);
        }
        return;
      }
      if (message.type === "home_fleet_approve") {
        try {
          deliver({ type: "fleet", snapshot: await homeFleet.approveWorker(message.workerId).then(() => fleet.snapshot()) });
          deliver({
            type: "status",
            correlationId: message.correlationId,
            agent: "system",
            stage: "home_fleet_approved",
            text: "That Home Fleet laptop is activated for future explicitly consented peer reviews.",
          });
        } catch (error) {
          sendHomeFleetError(message.correlationId, error);
        }
        return;
      }
      if (message.type === "home_fleet_remove") {
        try {
          await homeFleet.removeWorker(message.workerId);
          deliver({ type: "fleet", snapshot: await fleet.snapshot() });
          deliver({
            type: "status",
            correlationId: message.correlationId,
            agent: "system",
            stage: "home_fleet_removed",
            text: "The Home Fleet laptop was removed. Its coordinator credential is revoked on this laptop.",
          });
        } catch (error) {
          sendHomeFleetError(message.correlationId, error);
        }
        return;
      }
      // A paired phone receives only its own idea's progress and output.
      // Broadcast remains available for deliberately global bridge notices,
      // but a second paired device must never see someone else's brief.
      // Scope persistent conversational memory to this one WebSocket device.
      // A later paired phone can never receive prior summaries by accident.
      if (fleet.isProvisioning) {
        deliver({
          type: "error",
          correlationId: message.correlationId,
          code: "FLEET_PROVISIONING",
          message: "The laptop is preparing its selected local models. Wait for Fleet Setup to report ready before sending an idea.",
        });
        return;
      }
      if (message.type !== "command") return;
      inFlightCorrelationIds.add(message.correlationId);
      try {
        await orchestrator.execute(message, deliver, deviceId);
      } finally {
        // The deliver wrapper normally clears this on the terminal frame; the
        // finally guards against an execution path that throws before one.
        inFlightCorrelationIds.delete(message.correlationId);
      }
    }

    function sendFleetError(correlationId: string, error: unknown): void {
      if (error instanceof FleetControllerError || error instanceof BridgeSettingsError) {
        deliver({ type: "error", correlationId, code: error.code, message: error.message });
        return;
      }
      // Do not serialize an Ollama, filesystem, or provider exception to the
      // remote phone. The paired owner can inspect their local terminal.
      deliver({ type: "error", correlationId, code: "FLEET_OPERATION_FAILED", message: "The laptop could not finish that Fleet Setup action. Check the bridge terminal and try again." });
    }

    function sendHomeFleetError(correlationId: string, error: unknown): void {
      if (error instanceof HomeFleetServiceError) {
        deliver({ type: "error", correlationId, code: error.code, message: error.message });
        return;
      }
      // Protocol exceptions can include private-address details. Preserve a
      // useful recovery action without leaking LAN topology to the phone.
      deliver({ type: "error", correlationId, code: "HOME_FLEET_OPERATION_FAILED", message: "The private Home Fleet action could not finish. Check the coordinator laptop and try again." });
    }
  });

  function broadcast(event: BridgeEvent): void {
    for (const client of clients) send(client, event);
  }

  return {
    pairing,
    rotatePairing: () => {
      // A genuinely different public origin is a security boundary. Do not
      // leave an older WebSocket alive beside the newly printed QR generation;
      // its token, resume secret, display replay, and command ingress all end
      // together. Same-origin relay recovery never calls this method.
      // Rotation severs event delivery, but the orchestrator keeps working.
      // Remember that a brief will finish (or already finished) unheard so the
      // first connection of the next pairing gets pointed at the local audit
      // log — the one place the abandoned result remains readable.
      if (inFlightCorrelationIds.size > 0) previousSessionNoticePending = true;
      resumptions.clear();
      deviceEvents.clear();
      pairing.rotate();
      for (const client of clients) client.close(1008, "Omnibus public bridge endpoint changed");
      activeSocketByDevice.clear();
    },
    broadcast,
    listen: async () => {
      const homeFleetStart = await homeFleet.start();
      if (homeFleetStart.available) {
        logger.info({ port: config.homeFleetCoordinatorPort }, "Home Fleet listening on private LAN");
        if (process.platform === "win32") {
          // The coordinator's registration listener triggers the same Windows
          // firewall prompt as a worker; without an Allow on Private, invited
          // laptops cannot register even though pairing looks successful.
          logger.info("If Windows Firewall asks, allow node.exe on Private networks so home laptops can join.");
        }
      } else logger.info("Home Fleet unavailable; ordinary local bridge remains ready");
      try {
        await brain.start();
        if (brain.enabled) logger.info("Second Brain is capturing ambient project knowledge locally");
      } catch (error) {
        // Persistent knowledge is an enhancement; a corrupt brain directory
        // must never prevent pairing or ordinary stateless ideation.
        logger.warn({ err: error instanceof Error ? error.message : String(error) }, "Second Brain could not start; continuing stateless");
      }
      try {
        await new Promise<void>((resolve, reject) => {
          httpServer.once("error", reject);
          httpServer.listen(config.port, "127.0.0.1", () => {
            httpServer.off("error", reject);
            logger.info({ port: config.port }, "Bridge listening on loopback");
            // Recovery is event-driven rather than a polling worker. Orphaned
            // commands are retained as failed history and require a fresh paired
            // device confirmation; a restarted bridge never replays stale work.
            orchestrator.resume();
            resolve();
          });
        });
      } catch (error) {
        await homeFleet.close().catch(() => undefined);
        throw error;
      }
    },
    close: async () => {
      orchestrator.stop();
      await brain.stop().catch(() => undefined);
      resumptions.clear();
      deviceEvents.clear();
      for (const client of clients) client.close(1001, "Omnibus bridge shutting down");
      activeSocketByDevice.clear();
      await homeFleet.close().catch(() => undefined);
      return new Promise((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
    },
  };
}

function send(socket: WebSocket, event: BridgeEvent): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
}
