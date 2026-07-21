import type { AuditTrail } from "../audit.js";
import { randomUUID } from "node:crypto";
import { isLocalExecutorProvider, type AppConfig } from "../config.js";
import type { AgentName, BridgeEvent, ClientCommand, QueueJob } from "../contracts.js";
import type { SerializableAgentMemory } from "../memory.js";
import { DurableCommandQueue } from "../queue.js";
import type { SecondBrain } from "../second-brain/second-brain.js";
import { UsageLedger } from "../usage.js";
import { LocalAuditor } from "./auditor.js";
import { DeveloperAgent, type HomeFleetPeerReview } from "./developer.js";
import { MarketingOpsAgent } from "./marketing.js";
import { WebResearchAgent } from "./researcher.js";
import type { WebResearchResult } from "../web-research.js";

/** Results are private to the device that initiated the command. */
export type CommandEventSink = (event: BridgeEvent) => void;

/**
 * The orchestration boundary for optional spare-laptop reviews. Implementors
 * may only receive the current idea and the already-produced local audit;
 * saved conversation memory, source snippets, search-provider credentials,
 * audit history, and any host-execution authority stay on the coordinator.
 */
export type HomeFleetReviewRequest = {
  correlationId: string;
  /**
   * The only owner content permitted to cross to a home worker. The local
   * Auditor's enriched directive is deliberately excluded because it may
   * summarize private workspace snippets or same-device memory.
   */
  directive: string;
};

export type HomeFleetReviewOutcome = {
  attempted: number;
  unavailable: number;
  reviews: HomeFleetPeerReview[];
};

export type HomeFleetReviewer = {
  review: (request: HomeFleetReviewRequest) => Promise<HomeFleetReviewOutcome>;
};

/**
 * Bridges are often left open while local models work for several minutes.
 * This orchestrator accepts a small burst of paired-device commands, persists
 * them before execution, and runs exactly one at a time. It does not use a
 * polling worker: every drain invocation handles at most one job, while a
 * single bounded retry timer is armed only when a retry is actually due.
 */
export class CommandOrchestrator {
  private readonly queue: DurableCommandQueue;
  private readonly liveSinks = new Map<string, CommandEventSink>();
  private draining = false;
  /**
   * True from drain start until the current job's terminal frame is emitted.
   * `isBusy` reads this instead of `draining` so fleet provisioning is held
   * off whenever local inference could start or is running, but is not
   * refused during the brief post-result bookkeeping tail of a drain pass.
   */
  private inferenceActive = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private fleetPaused = false;

  public constructor(
    private readonly config: AppConfig,
    private readonly audit: AuditTrail,
    private readonly memory: SerializableAgentMemory,
    private readonly usage: UsageLedger,
    private readonly homeFleet?: HomeFleetReviewer,
    private readonly brain?: SecondBrain,
  ) {
    this.queue = new DurableCommandQueue(config.statePath, {
      maxPending: config.queueMaxPending,
      maxAttempts: config.queueMaxAttempts,
      retryBaseMs: config.queueRetryBaseMs,
    });
  }

  /**
   * Enqueue quickly so a second device does not lose its idea while Ollama is
   * occupied. The WebSocket remains scoped to the requester. If the bridge is
   * restarted, its recovered commands are retained as failed history and must
   * be confirmed and submitted again from a newly paired device; stale work
   * is never silently replayed into a workspace or cloud provider.
   */
  public async execute(command: ClientCommand, emit: CommandEventSink, ownerScope = `bridge-${randomUUID()}`): Promise<void> {
    let queued;
    try {
      queued = await this.queue.enqueue(command, ownerScope);
    } catch (error) {
      // The phone gets a neutral notice: a storage failure's raw text (Zod
      // issues, filesystem paths) belongs in the local audit trail only.
      emit({
        type: "error",
        correlationId: command.correlationId,
        code: "QUEUE_UNAVAILABLE",
        message: "The local queue storage is unavailable. Check the bridge terminal.",
      });
      void this.auditUnexpectedQueueError(error);
      return;
    }
    if (!queued.accepted) {
      emit({
        type: "error",
        correlationId: command.correlationId,
        code: queued.reason === "QUEUE_FULL" ? "COMMAND_QUEUE_FULL" : "DUPLICATE_COMMAND",
        message: queued.reason === "QUEUE_FULL"
          ? `The local team is already holding ${queued.pending} command${queued.pending === 1 ? "" : "s"}. Try again after one completes.`
          : "This command was already received by the local bridge.",
      });
      return;
    }

    this.liveSinks.set(command.correlationId, emit);
    try {
      await this.audit.append({
        at: new Date().toISOString(),
        correlationId: command.correlationId,
        agent: "system",
        event: "command_queued",
        data: { command, queue: { position: queued.position, maxAttempts: queued.job.maxAttempts } },
      });
      await this.memory.append(command.correlationId, "system", "directive", command.directive, ownerScope);
      await this.memory.append(
        command.correlationId,
        "system",
        "queue_enqueued",
        `position=${queued.position}; maxAttempts=${queued.job.maxAttempts}`,
        ownerScope,
      );
      emit({
        type: "status",
        correlationId: command.correlationId,
        agent: "system",
        stage: "queued",
        text: queued.position === 1
          ? "Your local team has the idea and is preparing it now."
          : `Your idea is queued behind ${queued.position - 1} local task${queued.position === 2 ? "" : "s"}.`,
      });
    } catch (error) {
      // The command has already been atomically persisted. Preserve forward
      // progress and report a neutral status rather than telling the phone its
      // saved idea was rejected because a secondary observability write failed.
      emit({
        type: "status",
        correlationId: command.correlationId,
        agent: "system",
        stage: "queued",
        text: "Your idea is saved locally and is waiting for the local team.",
      });
      void this.auditUnexpectedQueueError(error);
    } finally {
      // Once the durable write succeeds, a temporary audit/memory filesystem
      // problem must not strand the command in an otherwise runnable queue.
      this.kick();
    }
  }

  /** Resume recovered durable work after the bridge is listening again. */
  public resume(): void {
    this.stopped = false;
    this.kick();
  }

  /** Prevent a pending retry timer from keeping a bridge shutdown alive. */
  public stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  /**
   * Fleet provisioning uses the same local Ollama runtime as a command. The
   * socket gateway consults this read-only signal so it never starts a large
   * model pull alongside active agent inference.
   */
  public get isBusy(): boolean {
    return this.inferenceActive;
  }

  /**
   * Temporarily holds queued/retry work while Fleet Setup performs an
   * owner-approved local model pull. Running work is never pre-empted; the
   * server checks `isBusy` before entering this state.
   */
  public pauseForFleetProvisioning(): void {
    this.fleetPaused = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  /** Releases a fleet hold and drains any command received while it was active. */
  public resumeAfterFleetProvisioning(): void {
    this.fleetPaused = false;
    this.kick();
  }

  private kick(): void {
    if (this.stopped) return;
    if (this.fleetPaused) return;
    if (this.draining) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.draining = true;
    this.inferenceActive = true;
    void this.processOne()
      .catch(error => this.auditUnexpectedQueueError(error))
      .finally(() => {
        this.draining = false;
        this.inferenceActive = false;
        void this.scheduleNext();
      });
  }

  /** Arms one retry wakeup only when no command is currently ready. */
  private async scheduleNext(): Promise<void> {
    if (this.stopped || this.fleetPaused) return;
    let delay: number | null;
    try {
      delay = await this.queue.nextReadyDelayMs();
    } catch (error) {
      await this.auditUnexpectedQueueError(error);
      return;
    }
    if (delay === null) return;
    if (delay === 0) {
      this.kick();
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.stopped) return;
      this.kick();
    }, delay);
  }

  private async processOne(): Promise<void> {
    const job = await this.queue.claimNext();
    if (!job) return;
    if (!this.liveSinks.has(job.id)) {
      await this.queue.abandon(job.id, "Bridge restarted before the original paired device could confirm this command. Re-pair and submit it again.");
      await this.audit.append({
        at: new Date().toISOString(),
        correlationId: job.id,
        agent: "system",
        event: "command_reconfirmation_required",
        data: { mode: job.command.mode, attempts: job.attempts },
      });
      await this.memory.append(job.id, "system", "queue_reconfirmation_required", "Bridge restarted before execution could be safely resumed; submit the command again from a newly paired device.", job.ownerScope);
      return;
    }
    await this.runJob(job);
  }

  private async runJob(job: QueueJob): Promise<void> {
    const command = job.command;
    const correlationId = command.correlationId;
    const ownerScope = job.ownerScope;
    const emit = this.liveSinks.get(correlationId) ?? NOOP_EVENT_SINK;
    const callAgent = command.mode === "marketing" ? "marketing" : "developer";
    const status = (agent: AgentName, stage: string, text: string) => emit({ type: "status", correlationId, agent, stage, text });
    let succeeded = false;
    let capturedOutcome: { rationaleSummary?: string; resultSummary: string; peerReviews: HomeFleetPeerReview[] } | undefined;

    try {
      await this.audit.append({
        at: new Date().toISOString(),
        correlationId,
        agent: "system",
        event: "command_started",
        data: { mode: command.mode, research: command.research, homeFleet: command.homeFleet, attempt: job.attempts, maxAttempts: job.maxAttempts },
      });
      await this.memory.append(correlationId, "system", "queue_started", `attempt=${job.attempts}; maxAttempts=${job.maxAttempts}`, ownerScope);
      emit({ type: "call", correlationId, agent: callAgent, title: "Incoming work call", body: command.directive.slice(0, 240), action: "open" });

      if (command.mode === "marketing") {
        const marketing = new MarketingOpsAgent(this.config, this.audit);
        status("marketing", "create", "Marketing/Ops is preparing an official Higgsfield job.");
        const summary = await marketing.createVideo(correlationId, command.directive, text => status("marketing", "progress", text));
        await this.memory.append(correlationId, "marketing", "result", summary, ownerScope);
        // Inference is over; release the fleet-provisioning gate before the
        // phone sees the result so an immediate follow-up is not refused.
        this.inferenceActive = false;
        emit({ type: "result", correlationId, agent: "marketing", summary: `${summary}\n\n${marketing.distributionBoundary()}` });
      } else {
        let webResearch: WebResearchResult | undefined;
        let researchNotice: string | undefined;
        if (command.research) {
          status("auditor", "research", "Searching selected public sources. Only this approved idea text leaves the laptop; workspace files stay local.");
          const outcome = await new WebResearchAgent(this.config, this.audit).research(correlationId, command.directive);
          if (outcome.kind === "complete") {
            webResearch = outcome.result;
            status(
              "auditor",
              "research_complete",
              webResearch.citations.length
                ? `Collected ${webResearch.citations.length} citable public source${webResearch.citations.length === 1 ? "" : "s"}.`
                : "The search completed without safe citations; the local review will continue.",
            );
          } else {
            researchNotice = outcome.message;
            status("system", "research_unavailable", researchNotice);
          }
        }
        const auditor = new LocalAuditor(this.config, this.audit);
        status("auditor", "audit", "Auditor is enriching the directive on the local Ollama model.");
        const priorContext = await this.buildPrivateMemoryContext(ownerScope, correlationId);
        // Ambient discussion capture and HippoRAG recall are best-effort: the
        // brain must never delay or fail a queued idea it exists to serve.
        void this.brain?.captureIdea(correlationId, command.directive);
        let knowledgeContext: string | undefined;
        if (this.brain) {
          try {
            knowledgeContext = await this.brain.enrichIdea(correlationId, command.directive);
            if (knowledgeContext) {
              status("auditor", "recall", "Second Brain recalled linked project memories for this idea.");
            }
          } catch {
            knowledgeContext = undefined;
          }
        }
        const audited = await auditor.enrich(
          correlationId,
          command.directive,
          priorContext,
          webResearch,
          knowledgeContext,
          text => status("auditor", "audit_progress", text),
        );
        await this.memory.append(correlationId, "auditor", "rationale_summary", audited.rationaleSummary, ownerScope);
        status("auditor", "complete", audited.riskSummary.join(" · ") || "Local audit complete.");

        let peerReviews: HomeFleetPeerReview[] = [];
        if (command.homeFleet) {
          if (!this.homeFleet) {
            status("system", "home_fleet_unavailable", "Home Fleet is not available on this bridge, so the local review will continue alone.");
          } else {
            status("auditor", "home_fleet", "Asking your paired home laptops for independent local peer reviews.");
            const homeFleet = await this.homeFleet.review({
              correlationId,
              directive: command.directive,
            });
            peerReviews = homeFleet.reviews;
            await this.audit.append({
              at: new Date().toISOString(),
              correlationId,
              agent: "system",
              event: "home_fleet_peer_review_completed",
              data: {
                attempted: homeFleet.attempted,
                completed: peerReviews.length,
                unavailable: homeFleet.unavailable,
                // Keep the audit accountable without copying an individual
                // worker's network identity into a general agent record.
                labels: peerReviews.map(review => review.label),
              },
            });
            status(
              "auditor",
              peerReviews.length ? "home_fleet_complete" : "home_fleet_unavailable",
              peerReviews.length
                ? this.config.developerProvider === "ollama"
                  ? `${peerReviews.length} home peer review${peerReviews.length === 1 ? "" : "s"} will inform the local ideation brief.`
                  : `${peerReviews.length} home peer review${peerReviews.length === 1 ? "" : "s"} completed but will stay out of the configured cloud or workspace-execution provider.`
                : "No paired home laptops were ready, so the local review will continue alone.",
            );
          }
        }

        const developer = new DeveloperAgent(this.config, this.audit);
        const stage = command.mode === "plan" ? "ideate" : "execute";
        status("developer", stage, developer.startMessage(command.mode));
        // Codex works hand in hand with the Second Brain: the tool-using
        // executor receives recorded decisions and anti-patterns as explicit
        // guardrails. The Ollama route already carries this knowledge through
        // the Auditor's prompt, and the cloud route never receives it.
        const guardrails = this.config.developerProvider === "codex-cli" && this.brain
          ? await this.brain.executionGuardrails(command.directive).catch(() => undefined)
          : undefined;
        const result = await developer.execute(correlationId, audited, command.mode, text => status("developer", "progress", text), webResearch, peerReviews, guardrails);
        // Recording usage remains observational: the normal route is local
        // Ollama and this ledger never limits or denies a queued idea.
        emit({ type: "usage", usage: this.usage.record(result.usage) });
        let summary = researchNotice ? `${result.summary}\n\nResearch note: ${researchNotice}` : result.summary;
        // Validate any proposed code against the structured anti-pattern
        // registry before the brief reaches the phone. The appendix teaches
        // with the registry's Wrong/Correct examples; it never rewrites the
        // model's own report.
        const antiPatternNote = this.brain?.antiPatternAppendix(summary);
        if (antiPatternNote) summary = `${summary}\n\n${antiPatternNote}`;
        // After Codex has actually edited the workspace, audit what changed:
        // the working-tree diff is checked against the anti-pattern registry
        // so the owner sees at once whether the executor's edits repeat a
        // recorded mistake. Read-only, bounded, and best-effort.
        if (this.config.developerProvider === "codex-cli" && command.mode === "build" && this.brain) {
          const diffNote = await this.brain.antiPatternDiffAppendix().catch(() => undefined);
          if (diffNote) summary = `${summary}\n\n${diffNote}`;
        }
        await this.memory.append(correlationId, "developer", "result", summary, ownerScope);
        // Inference is over; release the fleet-provisioning gate before the
        // phone sees the result so an immediate follow-up is not refused.
        this.inferenceActive = false;
        emit({ type: "result", correlationId, agent: "developer", summary });
        capturedOutcome = {
          ...(audited.rationaleSummary ? { rationaleSummary: audited.rationaleSummary } : {}),
          resultSummary: summary,
          peerReviews,
        };
      }

      // Complete the durable job before best-effort observability writes. A
      // full audit disk after a model result must never cause that successful
      // model run to be replayed as a duplicate command.
      await this.queue.complete(job.id);
      succeeded = true;
      try {
        await this.audit.append({ at: new Date().toISOString(), correlationId, agent: "system", event: "command_completed", data: { attempts: job.attempts } });
        await this.memory.append(correlationId, "system", "queue_completed", `attempts=${job.attempts}`, ownerScope);
      } catch (observabilityError) {
        await this.auditUnexpectedQueueError(observabilityError);
      }
      // Knowledge distillation runs strictly after durable completion: its
      // writes are content-addressed and idempotent, so a crash between the
      // model result and this capture can never fork the graph or cause the
      // completed run to be replayed as a duplicate command. Its own guard
      // keeps it independent of the observability writes above — an audit
      // disk hiccup must not cost the brief its distilled memory.
      if (capturedOutcome && this.brain) {
        try {
          await this.brain.captureOutcome({ correlationId, ...capturedOutcome });
        } catch (captureError) {
          await this.auditUnexpectedQueueError(captureError);
        }
      }
    } catch (error) {
      const message = errorMessage(error);
      await this.settleFailure(job, emit, status, message);
    } finally {
      emit({
        type: "call",
        correlationId,
        agent: callAgent,
        title: succeeded ? "Work call complete" : "Work call paused",
        body: succeeded ? "The agent workflow has returned control to the dashboard." : "The local bridge has recorded this attempt.",
        action: "close",
      });
      if (succeeded) this.liveSinks.delete(correlationId);
    }
  }

  private async settleFailure(
    job: QueueJob,
    emit: CommandEventSink,
    status: (agent: AgentName, stage: string, text: string) => void,
    message: string,
  ): Promise<void> {
    // Inference for this attempt is over either way; release the
    // fleet-provisioning gate before any frame reaches the phone.
    this.inferenceActive = false;
    let settled;
    try {
      settled = await this.queue.fail(job.id, message);
    } catch (queueError) {
      emit({ type: "error", correlationId: job.command.correlationId, code: "COMMAND_FAILED", message });
      await this.auditUnexpectedQueueError(queueError);
      this.liveSinks.delete(job.command.correlationId);
      return;
    }

    const correlationId = job.command.correlationId;
    if (settled.retry) {
      status("system", "retrying", `Local workflow paused; retry ${settled.job.attempts + 1} of ${settled.job.maxAttempts} is scheduled.`);
      try {
        await this.audit.append({
          at: new Date().toISOString(),
          correlationId,
          agent: "system",
          event: "command_retry_scheduled",
          data: { attempt: settled.job.attempts, maxAttempts: settled.job.maxAttempts, delayMs: settled.delayMs, message },
        });
        await this.memory.append(correlationId, "system", "queue_retry", `attempt=${settled.job.attempts}; retryInMs=${settled.delayMs}; error=${message}`, job.ownerScope);
      } catch (observabilityError) {
        await this.auditUnexpectedQueueError(observabilityError);
      }
      return;
    }

    // The terminal error frame is emitted before the best-effort audit and
    // memory writes: a broken observability volume must never eat the failure
    // notice the phone is waiting on. Each write is guarded independently so
    // a failed audit append cannot suppress the memory record or vice versa.
    emit({ type: "error", correlationId, code: "COMMAND_FAILED", message });
    this.liveSinks.delete(correlationId);
    try {
      await this.audit.append({
        at: new Date().toISOString(),
        correlationId,
        agent: "system",
        event: "command_failed",
        data: { attempts: settled.job.attempts, maxAttempts: settled.job.maxAttempts, message },
      });
    } catch (observabilityError) {
      await this.auditUnexpectedQueueError(observabilityError);
    }
    try {
      await this.memory.append(correlationId, "system", "queue_failed", `attempts=${settled.job.attempts}; error=${message}`, job.ownerScope);
    } catch (observabilityError) {
      await this.auditUnexpectedQueueError(observabilityError);
    }
  }

  private async auditUnexpectedQueueError(error: unknown): Promise<void> {
    try {
      await this.audit.append({
        at: new Date().toISOString(),
        correlationId: `queue-${randomUUID()}`,
        agent: "system",
        event: "queue_internal_error",
        data: { message: errorMessage(error) },
      });
    } catch {
      // A broken audit volume must not create an unhandled promise rejection.
    }
  }

  /**
   * Cross-request continuity remains fully local and scoped to one live
   * paired session. It reaches LOCAL executors only — the loopback Ollama
   * route and the on-host Codex CLI, which already reads the workspace the
   * memory was distilled from. The cloud Responses route never receives
   * saved ideas or prior model work through any prompt.
   */
  private async buildPrivateMemoryContext(ownerScope: string, correlationId: string): Promise<string | undefined> {
    if (!isLocalExecutorProvider(this.config.developerProvider) || !isLoopbackEndpoint(this.config.ollamaBaseUrl)) {
      await this.audit.append({
        at: new Date().toISOString(),
        correlationId,
        agent: "system",
        event: "memory_context_withheld",
        data: { reason: !isLocalExecutorProvider(this.config.developerProvider) ? "developer_provider_is_a_cloud_route" : "ollama_endpoint_is_not_loopback" },
      });
      return undefined;
    }
    const entries = await this.memory.contextualRecent(ownerScope, correlationId);
    const context = entries.map(entry => `[${entry.role}] ${entry.value.slice(0, 1_000)}`).join("\n\n").slice(0, 6_000);
    await this.audit.append({
      at: new Date().toISOString(),
      correlationId,
      agent: "system",
      event: "memory_context_selected",
      data: { entries: entries.length, chars: context.length },
    });
    return context || undefined;
  }
}

const NOOP_EVENT_SINK: CommandEventSink = () => undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1_500) : "Unknown orchestration error";
}

function isLoopbackEndpoint(value: string): boolean {
  try {
    const hostname = new URL(value).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}
