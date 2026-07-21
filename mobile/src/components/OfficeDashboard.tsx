import * as Clipboard from "expo-clipboard";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { IdeaAtmosphere } from "./IdeaAtmosphere";
import { OmnibusMark } from "./OmnibusMark";
import { VectorIcon } from "./VectorIcon";
import { loadLocalIdeaHistory, upsertLocalIdeaRecord } from "../localData";
import { colors, springs } from "../theme";
import { playOfficeHaptic } from "../haptics";
import type { LocalIdeaRecord } from "../localData";
import type { CommandMode, ConnectionPresence, DashboardMessage, FleetSnapshot, UsageStatus } from "../types";

type IdeaPhase = "idle" | "shaping" | "ready" | "failed";

type PendingCommand = {
  directive: string;
  mode: CommandMode;
  research: boolean;
  homeFleet: boolean;
};

type OmnibusDashboardProps = {
  connected: boolean;
  connectionPresence: ConnectionPresence;
  usage: UsageStatus | null;
  messages: DashboardMessage[];
  pairingError?: string | null;
  fleet: FleetSnapshot | null;
  hasLocalAppleProfile: boolean;
  onOpenAccount: () => void;
  onOpenFleet: () => void;
  onPair: () => void;
  onCommand: (directive: string, mode: CommandMode, research: boolean, homeFleet: boolean) => string | null;
};

/**
 * Omnibus is an ideation room, not a command console. One thought enters,
 * local agents shape it, and the returned brief becomes the clean starting
 * prompt for the owner’s main IDE. The client deliberately exposes only that
 * single useful path instead of leaking provider/model machinery into the UI.
 */
export function OfficeDashboard({ connected, connectionPresence, usage, messages, pairingError, fleet, hasLocalAppleProfile, onOpenAccount, onOpenFleet, onPair, onCommand }: OmnibusDashboardProps): React.JSX.Element {
  const [idea, setIdea] = useState("");
  const [phase, setPhase] = useState<IdeaPhase>("idle");
  const [mode, setMode] = useState<CommandMode>("plan");
  const [submittedMode, setSubmittedMode] = useState<CommandMode>("plan");
  const [webResearchRequested, setWebResearchRequested] = useState(false);
  const [submittedResearch, setSubmittedResearch] = useState(false);
  const [homeFleetRequested, setHomeFleetRequested] = useState(false);
  const [submittedHomeFleet, setSubmittedHomeFleet] = useState(false);
  const [brief, setBrief] = useState("");
  const [submittedIdea, setSubmittedIdea] = useState("");
  const [requestStartedAt, setRequestStartedAt] = useState<number | null>(null);
  const [activeCorrelationId, setActiveCorrelationId] = useState<string | null>(null);
  const [activeRecordId, setActiveRecordId] = useState<string | null>(null);
  const [pendingCommand, setPendingCommand] = useState<PendingCommand | null>(null);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [history, setHistory] = useState<LocalIdeaRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const commandReady = connected && connectionPresence === "live";

  useEffect(() => {
    // A worker can go offline while this screen is open. Clearing stale
    // consent avoids silently reusing it when a different worker later joins.
    if (!fleet?.homeFleet.workers.some(worker => worker.status === "online" && worker.modelReady && worker.approved)) setHomeFleetRequested(false);
  }, [fleet]);

  const latestResult = useMemo(() => activeCorrelationId
    ? [...messages].reverse().find(message => message.stage === "result" && message.correlationId === activeCorrelationId)
    : undefined, [activeCorrelationId, messages]);
  const latestFailure = useMemo(() => activeCorrelationId
    ? [...messages].reverse().find(message => (message.stage === "COMMAND_FAILED" || message.stage === "COMMAND_IN_PROGRESS" || message.stage === "INVALID_MESSAGE") && message.correlationId === activeCorrelationId)
    : undefined, [activeCorrelationId, messages]);
  const signals = useMemo(() => activeCorrelationId
    ? messages.filter(message => (message.agent === "auditor" || message.agent === "developer" || message.agent === "marketing") && message.correlationId === activeCorrelationId).slice(-3)
    : [], [activeCorrelationId, messages]);

  const refreshHistory = useCallback(() => {
    setHistoryLoading(true);
    setHistoryError(null);
    void loadLocalIdeaHistory()
      .then(records => setHistory(records))
      .catch(() => setHistoryError("This iPhone could not read its saved idea history."))
      .finally(() => setHistoryLoading(false));
  }, []);

  const openHistory = useCallback(() => {
    setHistoryVisible(true);
    refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    if (latestResult && phase === "shaping" && requestStartedAt !== null && latestResult.at.getTime() >= requestStartedAt) {
      setBrief(latestResult.text);
      setPhase("ready");
      if (activeRecordId) {
        void upsertLocalIdeaRecord({
          id: activeRecordId,
          idea: submittedIdea,
          brief: latestResult.text,
          status: "complete",
          mode: submittedMode,
          research: submittedResearch,
          homeFleet: submittedHomeFleet,
          updatedAt: new Date().toISOString(),
        }).catch(() => {
          // Saved history is a local convenience and must never interrupt a
          // completed review if device storage is temporarily unavailable.
        });
      }
    }
  }, [activeRecordId, latestResult, phase, requestStartedAt, submittedHomeFleet, submittedIdea, submittedMode, submittedResearch]);

  useEffect(() => {
    if (latestFailure && phase === "shaping" && requestStartedAt !== null && latestFailure.at.getTime() >= requestStartedAt) {
      setPhase("failed");
      if (activeRecordId) {
        void upsertLocalIdeaRecord({
          id: activeRecordId,
          idea: submittedIdea,
          brief: null,
          status: "failed",
          mode: submittedMode,
          research: submittedResearch,
          homeFleet: submittedHomeFleet,
          updatedAt: new Date().toISOString(),
        }).catch(() => {});
      }
    }
  }, [activeRecordId, latestFailure, phase, requestStartedAt, submittedHomeFleet, submittedIdea, submittedMode, submittedResearch]);

  useEffect(() => {
    if (!connected && phase === "shaping") {
      setPhase("failed");
      if (activeRecordId) {
        void upsertLocalIdeaRecord({
          id: activeRecordId,
          idea: submittedIdea,
          brief: null,
          status: "failed",
          mode: submittedMode,
          research: submittedResearch,
          homeFleet: submittedHomeFleet,
          updatedAt: new Date().toISOString(),
        }).catch(() => {});
      }
    }
  }, [activeRecordId, connected, phase, submittedHomeFleet, submittedIdea, submittedMode, submittedResearch]);

  const beginCommand = useCallback((directive: string, requestedMode: CommandMode, requestedResearch: boolean, requestedHomeFleet: boolean) => {
    Keyboard.dismiss();
    playOfficeHaptic("HeavySwitch");
    // Marketing jobs use their own provider path; web research is a cited
    // input only for Auditor/Developer workflows.
    const research = requestedMode === "marketing" ? false : requestedResearch;
    const homeFleet = requestedMode === "marketing" ? false : requestedHomeFleet;
    setSubmittedIdea(directive);
    setSubmittedMode(requestedMode);
    setSubmittedResearch(research);
    setSubmittedHomeFleet(homeFleet);
    setBrief("");
    setPhase("shaping");
    const startedAt = Date.now();
    const recordId = `${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
    setRequestStartedAt(startedAt);
    setActiveRecordId(recordId);
    setIdea("");
    void upsertLocalIdeaRecord({
      id: recordId,
      idea: directive,
      brief: null,
      status: "submitted",
      mode: requestedMode,
      research,
      homeFleet,
      updatedAt: new Date(startedAt).toISOString(),
    }).catch(() => {
      // The bridge remains authoritative for this request; history is local.
    });
    const correlationId = onCommand(directive, requestedMode, research, homeFleet);
    if (!correlationId) {
      setPhase("failed");
      void upsertLocalIdeaRecord({
        id: recordId,
        idea: directive,
        brief: null,
        status: "failed",
        mode: requestedMode,
        research,
        homeFleet,
        updatedAt: new Date().toISOString(),
      }).catch(() => {});
      return;
    }
    setActiveCorrelationId(correlationId);
  }, [onCommand]);

  const submit = () => {
    if (!commandReady) {
      onPair();
      return;
    }
    const trimmed = idea.trim();
    if (!trimmed) return;
    const research = mode !== "marketing" && webResearchRequested;
    const homeFleet = mode !== "marketing" && homeFleetRequested && Boolean(fleet?.homeFleet.workers.some(worker => worker.status === "online" && worker.modelReady && worker.approved));
    if (mode === "plan" && !research && !homeFleet) {
      beginCommand(trimmed, mode, false, false);
      return;
    }
    // Local-only planning starts immediately. A request that enables external
    // web search, a workspace action, or a provider job must be acknowledged
    // immediately before it leaves this phone.
    Keyboard.dismiss();
    setPendingCommand({ directive: trimmed, mode, research, homeFleet });
  };

  const confirmPendingCommand = () => {
    if (!pendingCommand) return;
    const command = pendingCommand;
    setPendingCommand(null);
    if (!commandReady) {
      onPair();
      return;
    }
    beginCommand(command.directive, command.mode, command.research, command.homeFleet);
  };

  const restart = () => {
    playOfficeHaptic("HeavySwitch");
    setPhase("idle");
    setBrief("");
    setSubmittedIdea("");
    setSubmittedMode(mode);
    setSubmittedResearch(false);
    setSubmittedHomeFleet(false);
    setRequestStartedAt(null);
    setActiveCorrelationId(null);
    setActiveRecordId(null);
  };

  const connectionLabel = connectionPresence === "live"
    ? "LAPTOP LINKED"
    : connectionPresence === "checking" || connectionPresence === "connecting"
      ? "CHECKING"
      : connectionPresence === "stale"
        ? "LINK CHECK"
        : "PAIR LAPTOP";

  return <KeyboardAvoidingView style={styles.root} behavior={Platform.select({ ios: "padding", default: undefined })}>
    <IdeaAtmosphere active={phase === "shaping"} settled={phase === "ready"} />
    <View style={styles.header}>
      <View style={styles.brand}><View style={styles.mark}><OmnibusMark size={26} /></View><View><Text style={styles.brandName}>OMNIBUS</Text><Text style={styles.brandSub}>{hasLocalAppleProfile ? "APPLE / LOCAL PROFILE" : "LOCAL WORKING ROOM"}</Text></View></View>
      <View style={styles.headerActions}>
        <Pressable onPress={openHistory} style={({ pressed }) => [styles.historyControl, pressed && styles.connectionPressed]} accessibilityRole="button" accessibilityLabel="Open this iPhone's idea history">
          <VectorIcon name="history" size={17} color={colors.paper} />
        </Pressable>
        <Pressable onPress={onPair} style={({ pressed }) => [styles.connection, pressed && styles.connectionPressed]} accessibilityRole="button" accessibilityLabel={connected ? "Pair another laptop" : "Pair laptop"}>
          <View style={[styles.statusDot, connectionPresence === "live" && styles.statusDotLive, (connectionPresence === "checking" || connectionPresence === "connecting") && styles.statusDotChecking, connectionPresence === "stale" && styles.statusDotStale]} />
          <Text style={styles.connectionText}>{connectionLabel}</Text>
        </Pressable>
      </View>
    </View>
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      {phase === "ready" ? <ReadyBrief brief={brief} mode={submittedMode} onRestart={restart} /> : <IdeaComposer
        connected={commandReady}
        connectionPresence={connectionPresence}
        usage={usage}
        idea={idea}
        phase={phase}
        mode={mode}
        pairingError={pairingError}
        submittedIdea={submittedIdea}
        submittedMode={submittedMode}
        submittedResearch={submittedResearch}
        submittedHomeFleet={submittedHomeFleet}
        webResearchRequested={webResearchRequested}
        homeFleetRequested={homeFleetRequested}
        fleet={fleet}
        signals={signals}
        hasLocalAppleProfile={hasLocalAppleProfile}
        onChange={setIdea}
        onModeChange={nextMode => {
          setMode(nextMode);
          if (nextMode === "marketing") {
            setWebResearchRequested(false);
            setHomeFleetRequested(false);
          }
        }}
        onWebResearchChange={setWebResearchRequested}
        onHomeFleetChange={setHomeFleetRequested}
        onSubmit={submit}
        onPair={onPair}
        onOpenAccount={onOpenAccount}
        onOpenFleet={onOpenFleet}
        onRestart={restart}
      />}
    </ScrollView>
    {historyVisible ? <IdeaHistorySheet
      records={history}
      loading={historyLoading}
      error={historyError}
      onDismiss={() => setHistoryVisible(false)}
      onRefresh={refreshHistory}
    /> : null}
    {pendingCommand ? <ActionConfirmationSheet
      command={pendingCommand}
      onCancel={() => setPendingCommand(null)}
      onConfirm={confirmPendingCommand}
    /> : null}
  </KeyboardAvoidingView>;
}

function IdeaComposer({
  connected,
  connectionPresence,
  usage,
  idea,
  phase,
  mode,
  pairingError,
  submittedIdea,
  submittedMode,
  submittedResearch,
  submittedHomeFleet,
  webResearchRequested,
  homeFleetRequested,
  fleet,
  signals,
  hasLocalAppleProfile,
  onChange,
  onModeChange,
  onWebResearchChange,
  onHomeFleetChange,
  onSubmit,
  onPair,
  onOpenAccount,
  onOpenFleet,
  onRestart,
}: {
  connected: boolean;
  connectionPresence: ConnectionPresence;
  usage: UsageStatus | null;
  idea: string;
  phase: IdeaPhase;
  mode: CommandMode;
  pairingError?: string | null;
  submittedIdea: string;
  submittedMode: CommandMode;
  submittedResearch: boolean;
  submittedHomeFleet: boolean;
  webResearchRequested: boolean;
  homeFleetRequested: boolean;
  fleet: FleetSnapshot | null;
  signals: DashboardMessage[];
  hasLocalAppleProfile: boolean;
  onChange: (value: string) => void;
  onModeChange: (mode: CommandMode) => void;
  onWebResearchChange: (enabled: boolean) => void;
  onHomeFleetChange: (enabled: boolean) => void;
  onSubmit: () => void;
  onPair: () => void;
  onOpenAccount: () => void;
  onOpenFleet: () => void;
  onRestart: () => void;
}): React.JSX.Element {
  const isShaping = phase === "shaping";
  const isFailed = phase === "failed";
  const workflow = workflowCopy(mode);
  const buttonScale = useSharedValue(1);
  const actionStyle = useAnimatedStyle(() => ({ transform: [{ scale: buttonScale.value }] }));
  return <View style={styles.composer}>
    <Text style={styles.eyebrow}>{isShaping ? "WORKING GROUP / IN SESSION" : "A BETTER STARTING POINT"}</Text>
    <Text style={styles.title}>{isShaping ? shapingTitle(submittedMode) : "What do you want to make clearer?"}</Text>
    <Text style={styles.intro}>{isShaping ? shapingBody(submittedMode, submittedResearch, submittedHomeFleet) : "Bring the half-formed version. Omnibus will return the question, constraints, and first prompt worth putting into your main IDE."}</Text>

    {isShaping ? <View style={styles.processing}>
      <Text style={styles.quotedIdea}>“{submittedIdea}”</Text>
      <View style={styles.signalList}>
        {signals.length ? signals.map(signal => <View key={signal.id} style={styles.signal}><View style={styles.signalDot} /><Text style={styles.signalText}>{signal.text}</Text></View>) : <View style={styles.signal}><View style={styles.signalDot} /><Text style={styles.signalText}>Preparing the local review…</Text></View>}
      </View>
    </View> : isFailed ? <View style={styles.failure}>
      <Text style={styles.failureTitle}>The local review did not return.</Text>
      <Text style={styles.failureBody}>Confirm the bridge and local model are running on your laptop, then try the idea again.</Text>
      <Pressable style={styles.textAction} onPress={onRestart}><Text style={styles.textActionText}>TRY A NEW IDEA</Text></Pressable>
    </View> : <>
      <ModeSelector value={mode} disabled={isShaping} onChange={onModeChange} />
      {mode !== "marketing" ? <ResearchConsent enabled={webResearchRequested} disabled={isShaping} onChange={onWebResearchChange} /> : null}
      {mode !== "marketing" ? <HomeFleetConsent fleet={fleet?.homeFleet} enabled={homeFleetRequested} disabled={isShaping} onChange={onHomeFleetChange} /> : null}
      <FleetSetupCard fleet={fleet} connected={connected} onOpen={onOpenFleet} />
      <UsageTelemetry usage={usage} />
      {!connected && pairingError ? <Text style={styles.pairingNotice}>{pairingError}</Text> : null}
      {!connected && !pairingError && connectionPresence === "stale" ? <Text style={styles.pairingNotice}>The laptop link has not answered its health check. Keep Omnibus open for a moment, or scan a fresh bridge code.</Text> : null}
      <Pressable onPress={onOpenAccount} style={({ pressed }) => [styles.profilePrompt, pressed && styles.profilePromptPressed]} accessibilityRole="button" accessibilityLabel={hasLocalAppleProfile ? "Open local Apple profile" : "Set up Sign in with Apple"}>
        <VectorIcon name="person" size={17} color={colors.paper} />
        <View style={styles.profilePromptCopy}>
          <Text style={styles.profilePromptTitle}>{hasLocalAppleProfile ? "LOCAL APPLE PROFILE" : "SAVE THIS IPHONE’S IDEA HISTORY"}</Text>
          <Text style={styles.profilePromptBody}>{hasLocalAppleProfile ? "Manage the on-device profile" : "Set up Sign in with Apple"}</Text>
        </View>
      </Pressable>
      <View style={styles.inputShell}>
      <TextInput
        value={idea}
        onChangeText={onChange}
        multiline
        editable={connected}
        placeholder={connected ? workflow.placeholder : connectionPresence === "stale" ? "Waiting for your laptop link to respond" : "Pair your laptop to start an idea"}
        placeholderTextColor={colors.paperMuted}
        style={styles.input}
        textAlignVertical="top"
        accessibilityLabel="Idea to shape"
      />
      <View style={styles.inputFooter}>
        <Text style={styles.inputHint}>{connected
          ? workflow.inputHint
          : connectionPresence === "stale"
            ? "The saved pairing is not live yet"
            : connectionPresence === "connecting" || connectionPresence === "checking"
              ? "Restoring your saved laptop link…"
              : "Your phone needs a paired laptop"}</Text>
        <Animated.View style={actionStyle}>
          <Pressable
            onPressIn={() => { buttonScale.value = withSpring(0.94, springs.control); }}
            onPressOut={() => { buttonScale.value = withSpring(1, springs.control); }}
            onPress={connected ? onSubmit : onPair}
            style={[styles.submit, (!connected || !idea.trim()) && connected && styles.submitQuiet]}
            accessibilityRole="button"
            accessibilityLabel={connected ? workflow.actionLabel : "Pair laptop"}
          >
            {connected ? <VectorIcon name="send" size={18} color={colors.ink} /> : <VectorIcon name="scan" size={18} color={colors.ink} />}
          </Pressable>
        </Animated.View>
      </View>
      </View>
    </>}
    {!isShaping && !isFailed ? <Text style={styles.subtlePrompt}>{workflow.helper}</Text> : null}
  </View>;
}

/**
 * A visible entry back to the paired laptop's resource-aware control plane.
 * It communicates the selected local team without exposing model URLs or any
 * private machine inventory in the ideation surface.
 */
function FleetSetupCard({ fleet, connected, onOpen }: { fleet: FleetSnapshot | null; connected: boolean; onOpen: () => void }): React.JSX.Element {
  const active = fleet?.profiles.find(item => item.profile.id === fleet.activeProfileId)?.profile;
  const recommended = fleet?.profiles.find(item => item.profile.id === fleet.recommendedProfileId)?.profile;
  const homePeers = fleet?.homeFleet.workers.filter(worker => worker.status === "online" && worker.modelReady && worker.approved).length ?? 0;
  const title = active ? `${active.name.toUpperCase()} FLEET` : connected ? "CHOOSE LOCAL FLEET" : "LAPTOP FLEET";
  const body = active
    ? `LOCAL MODEL TEAM · ${Math.round(active.numCtx / 1024)}K CONTEXT · ${homePeers ? `${homePeers} HOME PEER${homePeers === 1 ? "" : "S"}` : "SERIAL WORK"}`
    : connected
      ? recommended ? `Recommended: ${recommended.name} · inspect your laptop before downloading` : "Inspect the paired laptop before downloading models"
      : "Pair your laptop to inspect a private local model team";
  return <Pressable
    onPress={onOpen}
    style={({ pressed }) => [styles.fleetCard, active && styles.fleetCardActive, pressed && styles.fleetCardPressed]}
    accessibilityRole="button"
    accessibilityLabel={active ? `Open ${active.name} local fleet settings` : "Open local fleet setup"}
  >
    <View style={[styles.fleetCardIcon, active && styles.fleetCardIconActive]}><VectorIcon name="bolt" size={17} color={active ? colors.ink : colors.paper} /></View>
    <View style={styles.fleetCardCopy}><Text style={styles.fleetCardTitle}>{title}</Text><Text numberOfLines={2} style={styles.fleetCardBody}>{body}</Text></View>
    <Text style={[styles.fleetCardAction, active && styles.fleetCardActionActive]}>{active ? "TUNE" : "SET UP"}</Text>
  </Pressable>;
}

function ReadyBrief({ brief, mode, onRestart }: { brief: string; mode: CommandMode; onRestart: () => void }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copyBrief = async () => {
    if (!brief) return;
    try {
      await Clipboard.setStringAsync(brief);
      setCopyError(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_800);
    } catch {
      setCopyError(true);
    }
  };
  const completion = completionCopy(mode);
  return <View style={styles.ready}>
    <View style={styles.readyLead}><Text style={styles.eyebrow}>{completion.eyebrow}</Text><Text style={styles.readyTitle}>{completion.title}</Text><Text style={styles.readyBody}>{completion.body}</Text></View>
    <View style={styles.brief}>
      <View style={styles.briefHeader}><Text style={styles.briefLabel}>THE BRIEF</Text><View style={styles.briefRule} /></View>
      <Text selectable style={styles.briefText}>{brief || "The working group returned without a written result. Try the request again from your paired laptop."}</Text>
    </View>
    <Pressable onPress={() => { void copyBrief(); }} disabled={!brief} style={({ pressed }) => [styles.copyBrief, pressed && styles.copyBriefPressed, !brief && styles.copyBriefDisabled]} accessibilityRole="button" accessibilityLabel="Copy IDE prompt">
      <VectorIcon name="copy" size={17} color={colors.ink} />
      <Text style={styles.copyBriefText}>{copied ? "COPIED TO CLIPBOARD" : copyError ? "COPY UNAVAILABLE" : completion.copyLabel}</Text>
    </Pressable>
    <Pressable onPress={onRestart} style={styles.newIdea} accessibilityRole="button" accessibilityLabel="Start a new idea"><Text style={styles.newIdeaText}>START A NEW IDEA</Text><VectorIcon name="send" size={16} color={colors.paper} /></Pressable>
  </View>;
}

type WorkflowCopy = {
  label: string;
  detail: string;
  placeholder: string;
  inputHint: string;
  actionLabel: string;
  helper: string;
};

const WORKFLOWS: Record<CommandMode, WorkflowCopy> = {
  plan: {
    label: "IDEATE",
    detail: "Audit the thought and return a sharper brief.",
    placeholder: "A rough idea is enough…",
    inputHint: "Local audit + IDE-ready brief · no workspace action",
    actionLabel: "Shape this idea",
    helper: "Try: “I want to help independent cafés reduce food waste without adding another dashboard.”",
  },
  build: {
    label: "IMPLEMENT",
    detail: "Ask the configured laptop workspace to act.",
    placeholder: "Describe the implementation you want reviewed…",
    inputHint: "A local confirmation is required before the request leaves this phone",
    actionLabel: "Request implementation",
    helper: "Example: “Turn the completed brief into a responsive landing page with an accessible waitlist form.”",
  },
  marketing: {
    label: "MARKETING",
    detail: "Prepare an explicitly requested media job.",
    placeholder: "Describe the campaign or media direction…",
    inputHint: "A local confirmation is required before a provider job is requested",
    actionLabel: "Request marketing job",
    helper: "Example: “Draft a 20-second launch concept for independent café owners, with a calm editorial tone.”",
  },
};

function workflowCopy(mode: CommandMode): WorkflowCopy {
  return WORKFLOWS[mode];
}

function shapingTitle(mode: CommandMode): string {
  if (mode === "build") return "Handing the work to your laptop.";
  if (mode === "marketing") return "Preparing the media request.";
  return "Giving the thought some shape.";
}

function shapingBody(mode: CommandMode, researched: boolean, homeFleet: boolean): string {
  if (mode === "build") return "Your laptop is auditing the request, then applying only the workspace policy it is configured to allow.";
  if (mode === "marketing") return "Your laptop is preparing the explicitly requested marketing job through its configured provider.";
  if (homeFleet && researched) return "Your laptop is collecting cited public sources and asking your paired home laptops for independent local peer reviews. Workspace files remain on the coordinator laptop.";
  if (homeFleet) return "Your laptop is using its local audit, then asking your paired home laptops for independent peer reviews. Workspace files and saved memory remain on the coordinator laptop.";
  return researched
    ? "Your laptop is collecting a few cited public sources, then using its local review to turn the rough thought into a usable brief for your IDE."
    : "Your laptop is running a local review and turning the rough thought into a usable brief for your IDE.";
}

function completionCopy(mode: CommandMode): { eyebrow: string; title: string; body: string; copyLabel: string } {
  if (mode === "build") return {
    eyebrow: "IMPLEMENTATION REQUEST / COMPLETE",
    title: "A returned work report.",
    body: "The paired laptop has returned its implementation result. Copy it into your IDE notes, or use it to decide the next request.",
    copyLabel: "COPY WORK REPORT",
  };
  if (mode === "marketing") return {
    eyebrow: "MARKETING REQUEST / COMPLETE",
    title: "A returned media update.",
    body: "The paired laptop has returned the marketing job result. Review it before taking any distribution action outside Omnibus.",
    copyLabel: "COPY MEDIA UPDATE",
  };
  return {
    eyebrow: "LOCAL REVIEW / COMPLETE",
    title: "An IDE-ready brief.",
    body: "This is the working group’s returned prompt. Bring it into your main IDE as-is, or use it as the clearer starting point for the next conversation.",
    copyLabel: "COPY IDE PROMPT",
  };
}

function ModeSelector({ value, disabled, onChange }: { value: CommandMode; disabled: boolean; onChange: (mode: CommandMode) => void }): React.JSX.Element {
  return <View style={styles.modeSection}>
    <View style={styles.sectionHeading}><Text style={styles.sectionEyebrow}>WORKFLOW</Text><Text style={styles.sectionCaption}>Choose what leaves the phone</Text></View>
    <View style={styles.modeList}>
      {(Object.keys(WORKFLOWS) as CommandMode[]).map(candidate => {
        const selected = candidate === value;
        const workflow = workflowCopy(candidate);
        return <Pressable
          key={candidate}
          onPress={() => onChange(candidate)}
          disabled={disabled}
          style={({ pressed }) => [styles.modeChoice, selected && styles.modeChoiceSelected, pressed && !disabled && styles.modeChoicePressed, disabled && styles.modeChoiceDisabled]}
          accessibilityRole="button"
          accessibilityState={{ selected, disabled }}
          accessibilityLabel={`${workflow.label}: ${workflow.detail}`}
        >
          <View style={[styles.modeIndicator, selected && styles.modeIndicatorSelected]}><View style={[styles.modeIndicatorCore, selected && styles.modeIndicatorCoreSelected]} /></View>
          <View style={styles.modeCopy}><Text style={[styles.modeLabel, selected && styles.modeLabelSelected]}>{workflow.label}</Text><Text style={styles.modeDetail}>{workflow.detail}</Text></View>
          {candidate !== "plan" ? <Text style={styles.modeGuard}>CONFIRM</Text> : <Text style={styles.modeGuard}>LOCAL</Text>}
        </Pressable>;
      })}
    </View>
  </View>;
}

/**
 * This is intentionally a per-idea consent rather than a global switch. The
 * bridge can only search when it has a laptop-side API key too, but the phone
 * is the place where the owner chooses whether the idea itself may leave the
 * laptop for public-web lookup.
 */
function ResearchConsent({ enabled, disabled, onChange }: { enabled: boolean; disabled: boolean; onChange: (enabled: boolean) => void }): React.JSX.Element {
  return <Pressable
    onPress={() => onChange(!enabled)}
    disabled={disabled}
    style={({ pressed }) => [styles.researchConsent, enabled && styles.researchConsentEnabled, pressed && !disabled && styles.researchConsentPressed, disabled && styles.modeChoiceDisabled]}
    accessibilityRole="switch"
    accessibilityState={{ checked: enabled, disabled }}
    accessibilityLabel="Use web research for this idea"
  >
    <View style={styles.researchIcon}><VectorIcon name="research" size={17} color={enabled ? colors.ink : colors.paper} /></View>
    <View style={styles.researchCopy}>
      <Text style={[styles.researchTitle, enabled && styles.researchTitleEnabled]}>WEB RESEARCH {enabled ? "ON" : "OFF"}</Text>
      <Text style={[styles.researchBody, enabled && styles.researchBodyEnabled]}>{enabled ? "This idea will be sent to the laptop’s configured search provider for cited public sources." : "Keep this idea on your laptop. Turn on to request cited public sources."}</Text>
    </View>
    <View style={[styles.researchSwitch, enabled && styles.researchSwitchEnabled]}><View style={[styles.researchKnob, enabled && styles.researchKnobEnabled]} /></View>
  </Pressable>;
}

/**
 * A separate consent from web research. A home worker is a laptop the owner
 * explicitly paired on the private LAN; it receives no source files, saved
 * history, credentials, or command-execution authority.
 */
function HomeFleetConsent({
  fleet,
  enabled,
  disabled,
  onChange,
}: {
  fleet: FleetSnapshot["homeFleet"] | undefined;
  enabled: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}): React.JSX.Element {
  const readyWorkers = fleet?.workers.filter(worker => worker.status === "online" && worker.modelReady && worker.approved) ?? [];
  const available = Boolean(fleet?.available && readyWorkers.length);
  if (!available) return <View style={[styles.researchConsent, styles.homeFleetUnavailable]}>
    <View style={styles.researchIcon}><VectorIcon name="phone" size={17} color={colors.paper} /></View>
    <View style={styles.researchCopy}>
      <Text style={styles.researchTitle}>HOME FLEET / NOT READY</Text>
      <Text style={styles.researchBody}>Add a private-LAN worker in Fleet Setup to request independent local peer reviews from spare laptops.</Text>
    </View>
  </View>;
  return <Pressable
    onPress={() => onChange(!enabled)}
    disabled={disabled}
    style={({ pressed }) => [styles.researchConsent, enabled && styles.researchConsentEnabled, pressed && !disabled && styles.researchConsentPressed, disabled && styles.modeChoiceDisabled]}
    accessibilityRole="switch"
    accessibilityState={{ checked: enabled, disabled }}
    accessibilityLabel="Use paired home laptops for peer review of this idea"
  >
    <View style={[styles.researchIcon, enabled && styles.fleetCardIconActive]}><VectorIcon name="phone" size={17} color={enabled ? colors.ink : colors.paper} /></View>
    <View style={styles.researchCopy}>
      <Text style={[styles.researchTitle, enabled && styles.researchTitleEnabled]}>HOME FLEET {enabled ? "ON" : "OFF"}</Text>
      <Text style={[styles.researchBody, enabled && styles.researchBodyEnabled]}>{enabled ? `${readyWorkers.length} paired laptop${readyWorkers.length === 1 ? "" : "s"} will receive this idea and its audit summary for local peer review.` : "Keep this idea on the coordinator. Turn on to ask your paired home laptops for bounded local peer review."}</Text>
    </View>
    <View style={[styles.researchSwitch, enabled && styles.researchSwitchEnabled]}><View style={[styles.researchKnob, enabled && styles.researchKnobEnabled]} /></View>
  </Pressable>;
}

function UsageTelemetry({ usage }: { usage: UsageStatus | null }): React.JSX.Element {
  if (!usage) return <View style={styles.telemetry}><View style={styles.sectionHeading}><Text style={styles.sectionEyebrow}>LAPTOP TELEMETRY</Text><Text style={styles.sectionCaption}>Appears after a live bridge handshake</Text></View></View>;
  const observed = Math.max(usage.observedCloudUsd, usage.estimatedCloudUsd);
  return <View style={styles.telemetry}>
    <View style={styles.sectionHeading}><Text style={styles.sectionEyebrow}>LAPTOP TELEMETRY</Text><Text style={styles.sectionCaption}>Informational, never a runtime quota</Text></View>
    <View style={styles.metrics}>
      <Metric label="LOCAL" value={`${formatCount(usage.localRuns)} RUNS`} />
      <Metric label="CLOUD" value={`${formatCount(usage.cloudRuns)} RUNS`} />
      <Metric label="TOKENS" value={`${formatCount(usage.inputTokens)} / ${formatCount(usage.outputTokens)}`} />
      {observed > 0 ? <Metric label="CLOUD USD" value={formatUsd(observed)} /> : null}
    </View>
  </View>;
}

function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <View style={styles.metric}><Text style={styles.metricLabel}>{label}</Text><Text style={styles.metricValue}>{value}</Text></View>;
}

function ActionConfirmationSheet({ command, onCancel, onConfirm }: { command: PendingCommand; onCancel: () => void; onConfirm: () => void }): React.JSX.Element {
  const lift = useSharedValue(72);
  const opacity = useSharedValue(0);
  const isBuild = command.mode === "build";
  const isMarketing = command.mode === "marketing";
  const usesHomeFleet = command.homeFleet;
  useEffect(() => {
    lift.value = withSpring(0, springs.callSheet);
    opacity.value = withSpring(1, springs.callSheet);
    playOfficeHaptic("RotaryRumble", 420);
  }, [lift, opacity]);
  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value, transform: [{ translateY: lift.value }] }));
  const close = () => {
    playOfficeHaptic("HeavySwitch");
    onCancel();
  };
  const confirm = () => {
    playOfficeHaptic("HeavySwitch");
    onConfirm();
  };
  const title = isBuild ? "Send implementation request?" : isMarketing ? "Create marketing request?" : usesHomeFleet ? "Use your home fleet?" : "Use web research for this idea?";
  const explanation = isMarketing
    ? "This sends a media request to the paired laptop’s configured provider. Omnibus does not publish to social platforms from this confirmation."
    : isBuild
      ? command.research
        ? "This sends the request to the paired laptop and asks its configured search provider for public sources using only this idea text. Workspace files stay local. The laptop can change files only if host execution is explicitly enabled in its selected workspace."
        : "This sends the request to the paired laptop. It can change files only if that laptop’s bridge is explicitly configured to allow host execution in its selected workspace."
      : command.research && usesHomeFleet
        ? "This sends only this idea text to the paired laptop’s configured search provider for public citations. It also sends only the original idea text to the private-LAN laptops you explicitly paired for local peer review. Workspace files, saved memory, audit output, credentials, and command authority stay on the coordinator laptop."
        : usesHomeFleet
          ? "This sends only the original idea text to the private-LAN laptops you explicitly paired for local peer review. Workspace files, saved memory, audit output, credentials, and command authority stay on the coordinator laptop."
          : "This sends only this idea text to the paired laptop’s configured search provider for public citations. Workspace files, local idea memory, and credentials stay on your laptop.";
  return <View style={styles.confirmScrim} accessibilityViewIsModal>
    <Animated.View style={[styles.confirmSheet, animatedStyle]}>
      <Text style={styles.confirmEyebrow}>{isBuild ? "IMPLEMENTATION / LOCAL CONFIRMATION" : isMarketing ? "MARKETING / LOCAL CONFIRMATION" : usesHomeFleet ? "HOME FLEET / LOCAL CONFIRMATION" : "WEB RESEARCH / LOCAL CONFIRMATION"}</Text>
      <Text style={styles.confirmTitle}>{title}</Text>
      <Text style={styles.confirmBody}>{explanation}</Text>
      <View style={styles.confirmDirective}><Text style={styles.confirmDirectiveLabel}>REQUEST</Text><Text numberOfLines={4} style={styles.confirmDirectiveText}>{command.directive}</Text></View>
      <View style={styles.confirmActions}>
        <Pressable onPress={close} style={styles.confirmCancel} accessibilityRole="button" accessibilityLabel="Cancel request"><Text style={styles.confirmCancelText}>CANCEL</Text></Pressable>
        <Pressable onPress={confirm} style={styles.confirmPrimary} accessibilityRole="button" accessibilityLabel={isBuild ? "Confirm implementation request" : isMarketing ? "Confirm marketing request" : usesHomeFleet ? "Confirm home fleet peer review" : "Confirm web research request"}><Text style={styles.confirmPrimaryText}>{isBuild ? "SEND REQUEST" : isMarketing ? "CREATE JOB" : usesHomeFleet ? "REVIEW & SHAPE" : "SEARCH & SHAPE"}</Text></Pressable>
      </View>
    </Animated.View>
  </View>;
}

function IdeaHistorySheet({ records, loading, error, onDismiss, onRefresh }: { records: LocalIdeaRecord[]; loading: boolean; error: string | null; onDismiss: () => void; onRefresh: () => void }): React.JSX.Element {
  const lift = useSharedValue(72);
  const opacity = useSharedValue(0);
  const [selectedId, setSelectedId] = useState<string | null>(records[0]?.id ?? null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    lift.value = withSpring(0, springs.callSheet);
    opacity.value = withSpring(1, springs.callSheet);
  }, [lift, opacity]);

  useEffect(() => {
    setSelectedId(current => current && records.some(record => record.id === current) ? current : records[0]?.id ?? null);
  }, [records]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value, transform: [{ translateY: lift.value }] }));
  const selected = records.find(record => record.id === selectedId) ?? null;
  const copySelected = async () => {
    if (!selected) return;
    const content = selected.brief ? `${selected.idea}\n\n${selected.brief}` : selected.idea;
    try {
      await Clipboard.setStringAsync(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_800);
    } catch {
      setCopied(false);
    }
  };
  const close = () => {
    playOfficeHaptic("HeavySwitch");
    onDismiss();
  };

  return <View style={styles.historyScrim} accessibilityViewIsModal>
    <Animated.View style={[styles.historySheet, animatedStyle]}>
      <View style={styles.historyHeader}>
        <View><Text style={styles.confirmEyebrow}>THIS IPHONE / IDEA HISTORY</Text><Text style={styles.historyTitle}>Your saved thinking.</Text></View>
        <Pressable onPress={close} style={styles.historyClose} accessibilityRole="button" accessibilityLabel="Close idea history"><VectorIcon name="close" size={17} color={colors.paper} /></Pressable>
      </View>
      <Text style={styles.historyIntro}>Ideas and returned reports remain on this device. They do not create a cloud account or sync queue.</Text>
      <View style={styles.historyTools}><Pressable onPress={onRefresh} style={styles.historyRefresh} accessibilityRole="button" accessibilityLabel="Refresh local idea history"><Text style={styles.historyRefreshText}>{loading ? "READING…" : "REFRESH"}</Text></Pressable><Text style={styles.historyCount}>{records.length} SAVED</Text></View>
      <ScrollView style={styles.historyScroll} contentContainerStyle={styles.historyScrollContent} showsVerticalScrollIndicator={false}>
        {error ? <Text style={styles.historyError}>{error}</Text> : null}
        {!loading && !error && records.length === 0 ? <View style={styles.historyEmpty}><Text style={styles.historyEmptyTitle}>No ideas saved yet.</Text><Text style={styles.historyEmptyBody}>Send your first request from this iPhone and its local record will appear here.</Text></View> : null}
        {records.map(record => {
          const selectedRecord = record.id === selectedId;
          return <Pressable key={record.id} onPress={() => setSelectedId(record.id)} style={({ pressed }) => [styles.historyRecord, selectedRecord && styles.historyRecordSelected, pressed && styles.historyRecordPressed]} accessibilityRole="button" accessibilityState={{ selected: selectedRecord }} accessibilityLabel={`Open ${modeLabel(record.mode)} ${record.status} record`}>
            <View style={styles.historyRecordTop}><Text style={styles.historyRecordMode}>{modeLabel(record.mode)}</Text><Text style={styles.historyRecordStatus}>{record.status.toUpperCase()}</Text></View>
            <Text numberOfLines={2} style={styles.historyRecordIdea}>{record.idea}</Text>
            <Text style={styles.historyRecordDate}>{readableDate(record.updatedAt)}</Text>
          </Pressable>;
        })}
        {selected ? <View style={styles.historyDetail}>
          <View style={styles.historyDetailHeader}><Text style={styles.historyDetailLabel}>{selected.brief ? "RETURNED RESULT" : "SAVED REQUEST"}</Text><Pressable onPress={() => { void copySelected(); }} style={styles.historyCopy} accessibilityRole="button" accessibilityLabel="Copy selected idea record"><VectorIcon name="copy" size={15} color={colors.ink} /><Text style={styles.historyCopyText}>{copied ? "COPIED" : "COPY"}</Text></Pressable></View>
          <Text selectable style={styles.historyDetailText}>{selected.brief ?? selected.idea}</Text>
        </View> : null}
      </ScrollView>
    </Animated.View>
  </View>;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

function modeLabel(mode: CommandMode | undefined): string {
  return workflowCopy(mode ?? "plan").label;
}

function readableDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "SAVED ON THIS IPHONE";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }).toUpperCase();
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.void },
  header: { paddingTop: 18, paddingHorizontal: 22, height: 82, alignItems: "center", justifyContent: "space-between", flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  brand: { flexDirection: "row", gap: 9, alignItems: "center" },
  mark: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  brandName: { color: colors.paper, letterSpacing: 1.1, fontSize: 12, fontWeight: "900" },
  brandSub: { color: colors.paperMuted, marginTop: 2, letterSpacing: 0.8, fontSize: 8, fontWeight: "800" },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 7 },
  historyControl: { width: 34, height: 32, alignItems: "center", justifyContent: "center", borderRadius: 10, borderWidth: 1, borderColor: colors.line, backgroundColor: "rgba(12,12,13,.68)" },
  connection: { minHeight: 32, paddingHorizontal: 10, gap: 6, alignItems: "center", flexDirection: "row", borderRadius: 10, borderWidth: 1, borderColor: colors.line, backgroundColor: "rgba(12,12,13,.68)" },
  connectionPressed: { opacity: 0.72 },
  statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.paperMuted },
  statusDotLive: { backgroundColor: colors.paper, shadowColor: colors.paper, shadowOpacity: 0.75, shadowRadius: 5 },
  statusDotChecking: { backgroundColor: colors.paperMuted, shadowColor: colors.paperMuted, shadowOpacity: 0.42, shadowRadius: 4 },
  statusDotStale: { backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.paperMuted },
  connectionText: { color: colors.paper, fontSize: 9, letterSpacing: 0.8, fontWeight: "800" },
  scroll: { flexGrow: 1, paddingHorizontal: 23, paddingBottom: 46 },
  composer: { flex: 1, paddingTop: 58, minHeight: 630 },
  eyebrow: { color: colors.paperMuted, fontSize: 10, letterSpacing: 1.55, fontWeight: "800" },
  title: { color: colors.paper, fontSize: 34, fontWeight: "700", letterSpacing: -1.1, lineHeight: 40, marginTop: 14, maxWidth: 450 },
  intro: { color: colors.paperMuted, fontSize: 15, lineHeight: 23, marginTop: 15, maxWidth: 470 },
  modeSection: { marginTop: 29 },
  sectionHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  sectionEyebrow: { color: colors.paperMuted, fontSize: 9, letterSpacing: 1.18, fontWeight: "900" },
  sectionCaption: { color: colors.paperMuted, textAlign: "right", fontSize: 9, lineHeight: 13 },
  modeList: { marginTop: 10, overflow: "hidden", borderWidth: 1, borderColor: colors.line, borderRadius: 17, backgroundColor: "rgba(20,20,21,.56)" },
  modeChoice: { minHeight: 58, paddingHorizontal: 14, gap: 11, alignItems: "center", flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  modeChoiceSelected: { backgroundColor: "rgba(244,244,240,.09)" },
  modeChoicePressed: { opacity: 0.74 },
  modeChoiceDisabled: { opacity: 0.58 },
  modeIndicator: { width: 17, height: 17, borderRadius: 9, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.lineStrong },
  modeIndicatorSelected: { borderColor: colors.paper },
  modeIndicatorCore: { width: 5, height: 5, borderRadius: 3, backgroundColor: "transparent" },
  modeIndicatorCoreSelected: { backgroundColor: colors.paper },
  modeCopy: { flex: 1, minWidth: 0 },
  modeLabel: { color: colors.paperMuted, fontSize: 10, letterSpacing: 1, fontWeight: "900" },
  modeLabelSelected: { color: colors.paper },
  modeDetail: { color: colors.paperMuted, marginTop: 3, fontSize: 11, lineHeight: 15 },
  modeGuard: { color: colors.paperMuted, fontSize: 8, letterSpacing: 0.9, fontWeight: "900" },
  researchConsent: { minHeight: 74, marginTop: 12, paddingHorizontal: 14, gap: 11, alignItems: "center", flexDirection: "row", borderRadius: 17, borderWidth: 1, borderColor: colors.line, backgroundColor: "rgba(20,20,21,.48)" },
  researchConsentEnabled: { borderColor: colors.paper, backgroundColor: "rgba(244,244,240,.11)" },
  researchConsentPressed: { opacity: 0.74 },
  homeFleetUnavailable: { opacity: 0.66 },
  researchIcon: { width: 33, height: 33, alignItems: "center", justifyContent: "center", borderRadius: 11, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface },
  researchCopy: { flex: 1, minWidth: 0 },
  researchTitle: { color: colors.paper, fontSize: 9, letterSpacing: 1, fontWeight: "900" },
  researchTitleEnabled: { color: colors.paper },
  researchBody: { color: colors.paperMuted, marginTop: 4, fontSize: 10, lineHeight: 14 },
  researchBodyEnabled: { color: colors.paper },
  researchSwitch: { width: 32, height: 19, padding: 2, borderRadius: 10, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface },
  researchSwitchEnabled: { borderColor: colors.paper, backgroundColor: colors.paper },
  researchKnob: { width: 13, height: 13, borderRadius: 7, backgroundColor: colors.paperMuted },
  researchKnobEnabled: { alignSelf: "flex-end", backgroundColor: colors.ink },
  fleetCard: { minHeight: 73, marginTop: 12, paddingHorizontal: 14, gap: 11, alignItems: "center", flexDirection: "row", borderRadius: 17, borderWidth: 1, borderColor: colors.line, backgroundColor: "rgba(20,20,21,.48)" },
  fleetCardActive: { borderColor: colors.lineStrong, backgroundColor: "rgba(244,244,240,.08)" },
  fleetCardPressed: { opacity: 0.74 },
  fleetCardIcon: { width: 33, height: 33, alignItems: "center", justifyContent: "center", borderRadius: 11, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface },
  fleetCardIconActive: { borderColor: colors.paper, backgroundColor: colors.paper },
  fleetCardCopy: { flex: 1, minWidth: 0 },
  fleetCardTitle: { color: colors.paper, fontSize: 9, letterSpacing: 1, fontWeight: "900" },
  fleetCardBody: { color: colors.paperMuted, marginTop: 4, fontSize: 10, lineHeight: 14 },
  fleetCardAction: { color: colors.paper, fontSize: 8, letterSpacing: 0.9, fontWeight: "900" },
  fleetCardActionActive: { color: colors.paperMuted },
  telemetry: { marginTop: 17, padding: 13, borderRadius: 16, borderWidth: 1, borderColor: colors.line, backgroundColor: "rgba(20,20,21,.42)" },
  metrics: { marginTop: 11, gap: 8, flexDirection: "row", flexWrap: "wrap" },
  metric: { minWidth: 72, paddingRight: 8 },
  metricLabel: { color: colors.paperMuted, fontSize: 8, letterSpacing: 0.82, fontWeight: "900" },
  metricValue: { color: colors.paper, marginTop: 3, fontSize: 11, fontWeight: "700" },
  pairingNotice: { color: colors.paperMuted, marginTop: 32, padding: 13, borderRadius: 14, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 13, lineHeight: 19 },
  profilePrompt: { marginTop: 28, minHeight: 59, paddingHorizontal: 15, gap: 11, alignItems: "center", flexDirection: "row", borderRadius: 17, borderWidth: 1, borderColor: colors.line, backgroundColor: "rgba(20,20,21,.66)" },
  profilePromptPressed: { opacity: 0.72 },
  profilePromptCopy: { flex: 1 },
  profilePromptTitle: { color: colors.paper, fontSize: 10, letterSpacing: 0.85, fontWeight: "900" },
  profilePromptBody: { color: colors.paperMuted, fontSize: 11, marginTop: 3 },
  inputShell: { minHeight: 198, marginTop: 19, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 23, overflow: "hidden", backgroundColor: "rgba(20,20,21,.8)", shadowColor: "#000", shadowOpacity: 0.42, shadowRadius: 20, shadowOffset: { width: 0, height: 12 } },
  input: { flex: 1, minHeight: 140, color: colors.paper, fontSize: 18, lineHeight: 27, padding: 18, letterSpacing: -0.25 },
  inputFooter: { minHeight: 56, paddingLeft: 18, paddingRight: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, alignItems: "center", justifyContent: "space-between", flexDirection: "row" },
  inputHint: { color: colors.paperMuted, flex: 1, paddingRight: 12, fontSize: 10, lineHeight: 14 },
  submit: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 13, backgroundColor: colors.paper },
  submitQuiet: { opacity: 0.43 },
  subtlePrompt: { color: colors.paperMuted, fontSize: 12, lineHeight: 18, marginTop: 17, maxWidth: 390 },
  processing: { marginTop: 60, minHeight: 240, padding: 20, borderRadius: 22, borderWidth: 1, borderColor: colors.line, backgroundColor: "rgba(20,20,21,.58)" },
  quotedIdea: { color: colors.paper, fontSize: 17, lineHeight: 25, letterSpacing: -0.25 },
  signalList: { marginTop: 34, gap: 13 },
  signal: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  signalDot: { marginTop: 6, width: 6, height: 6, borderRadius: 3, backgroundColor: colors.paper, shadowColor: colors.paper, shadowOpacity: 0.8, shadowRadius: 7 },
  signalText: { color: colors.paperMuted, flex: 1, fontSize: 13, lineHeight: 19 },
  failure: { marginTop: 50, padding: 20, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 20, backgroundColor: colors.surface },
  failureTitle: { color: colors.paper, fontSize: 18, fontWeight: "700" },
  failureBody: { color: colors.paperMuted, marginTop: 8, lineHeight: 20, fontSize: 14 },
  textAction: { alignSelf: "flex-start", marginTop: 21, borderBottomWidth: 1, borderBottomColor: colors.paper },
  textActionText: { color: colors.paper, fontSize: 10, letterSpacing: 1.1, fontWeight: "900", paddingBottom: 6 },
  ready: { paddingTop: 58, paddingBottom: 26 },
  readyLead: { maxWidth: 465 },
  readyTitle: { color: colors.paper, fontSize: 34, fontWeight: "700", letterSpacing: -1.1, lineHeight: 40, marginTop: 14 },
  readyBody: { color: colors.paperMuted, fontSize: 15, lineHeight: 23, marginTop: 15 },
  brief: { marginTop: 36, padding: 18, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 21, backgroundColor: "rgba(20,20,21,.87)" },
  briefHeader: { alignItems: "center", flexDirection: "row", gap: 10, marginBottom: 16 },
  briefLabel: { color: colors.paperMuted, fontSize: 9, letterSpacing: 1.3, fontWeight: "900" },
  briefRule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, flex: 1 },
  briefText: { color: colors.paper, fontSize: 14, lineHeight: 22 },
  copyBrief: { marginTop: 14, minHeight: 49, paddingHorizontal: 17, gap: 9, alignItems: "center", justifyContent: "center", flexDirection: "row", borderRadius: 16, backgroundColor: colors.paper },
  copyBriefPressed: { opacity: 0.78 },
  copyBriefDisabled: { opacity: 0.42 },
  copyBriefText: { color: colors.ink, letterSpacing: 1, fontSize: 10, fontWeight: "900" },
  newIdea: { marginTop: 20, minHeight: 51, paddingHorizontal: 17, alignItems: "center", justifyContent: "space-between", flexDirection: "row", borderRadius: 16, borderWidth: 1, borderColor: colors.lineStrong },
  newIdeaText: { color: colors.paper, letterSpacing: 1, fontSize: 10, fontWeight: "900" },
  confirmScrim: { ...StyleSheet.absoluteFillObject, zIndex: 30, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,.74)" },
  confirmSheet: { padding: 24, borderTopLeftRadius: 30, borderTopRightRadius: 30, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surfaceRaised },
  confirmEyebrow: { color: colors.paperMuted, fontSize: 9, letterSpacing: 1.25, fontWeight: "900" },
  confirmTitle: { color: colors.paper, fontSize: 27, lineHeight: 33, letterSpacing: -0.7, fontWeight: "700", marginTop: 11 },
  confirmBody: { color: colors.paperMuted, fontSize: 14, lineHeight: 21, marginTop: 12 },
  confirmDirective: { marginTop: 20, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: colors.line, backgroundColor: "rgba(7,7,7,.58)" },
  confirmDirectiveLabel: { color: colors.paperMuted, fontSize: 8, letterSpacing: 1.1, fontWeight: "900" },
  confirmDirectiveText: { color: colors.paper, fontSize: 13, lineHeight: 19, marginTop: 7 },
  confirmActions: { marginTop: 20, flexDirection: "row", gap: 10 },
  confirmCancel: { flex: 1, minHeight: 49, alignItems: "center", justifyContent: "center", borderRadius: 15, borderWidth: 1, borderColor: colors.lineStrong },
  confirmCancelText: { color: colors.paper, fontSize: 10, letterSpacing: 0.95, fontWeight: "900" },
  confirmPrimary: { flex: 1.35, minHeight: 49, alignItems: "center", justifyContent: "center", borderRadius: 15, backgroundColor: colors.paper },
  confirmPrimaryText: { color: colors.ink, fontSize: 10, letterSpacing: 0.95, fontWeight: "900" },
  historyScrim: { ...StyleSheet.absoluteFillObject, zIndex: 29, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,.74)" },
  historySheet: { maxHeight: "88%", minHeight: 430, paddingTop: 24, paddingHorizontal: 22, borderTopLeftRadius: 30, borderTopRightRadius: 30, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surfaceRaised },
  historyHeader: { flexDirection: "row", gap: 14, alignItems: "flex-start", justifyContent: "space-between" },
  historyTitle: { color: colors.paper, fontSize: 27, lineHeight: 33, letterSpacing: -0.7, fontWeight: "700", marginTop: 8 },
  historyClose: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 12, borderWidth: 1, borderColor: colors.line },
  historyIntro: { color: colors.paperMuted, marginTop: 12, fontSize: 13, lineHeight: 19 },
  historyTools: { marginTop: 16, paddingBottom: 12, alignItems: "center", justifyContent: "space-between", flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  historyRefresh: { minHeight: 30, paddingHorizontal: 10, justifyContent: "center", borderRadius: 10, backgroundColor: colors.paper },
  historyRefreshText: { color: colors.ink, fontSize: 9, letterSpacing: 0.85, fontWeight: "900" },
  historyCount: { color: colors.paperMuted, fontSize: 9, letterSpacing: 0.9, fontWeight: "900" },
  historyScroll: { flex: 1, minHeight: 0 },
  historyScrollContent: { paddingTop: 13, paddingBottom: 32 },
  historyError: { color: colors.paperMuted, padding: 13, borderRadius: 14, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface, fontSize: 13, lineHeight: 19 },
  historyEmpty: { paddingVertical: 38, paddingHorizontal: 8, alignItems: "center" },
  historyEmptyTitle: { color: colors.paper, fontSize: 17, fontWeight: "700" },
  historyEmptyBody: { color: colors.paperMuted, marginTop: 8, maxWidth: 280, textAlign: "center", fontSize: 13, lineHeight: 19 },
  historyRecord: { padding: 14, marginBottom: 9, borderRadius: 16, borderWidth: 1, borderColor: colors.line, backgroundColor: "rgba(7,7,7,.34)" },
  historyRecordSelected: { borderColor: colors.lineStrong, backgroundColor: "rgba(244,244,240,.09)" },
  historyRecordPressed: { opacity: 0.74 },
  historyRecordTop: { alignItems: "center", justifyContent: "space-between", flexDirection: "row" },
  historyRecordMode: { color: colors.paper, fontSize: 9, letterSpacing: 1, fontWeight: "900" },
  historyRecordStatus: { color: colors.paperMuted, fontSize: 8, letterSpacing: 0.8, fontWeight: "900" },
  historyRecordIdea: { color: colors.paper, marginTop: 8, fontSize: 14, lineHeight: 20 },
  historyRecordDate: { color: colors.paperMuted, marginTop: 9, fontSize: 8, letterSpacing: 0.7, fontWeight: "800" },
  historyDetail: { marginTop: 7, padding: 15, borderRadius: 18, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: "rgba(7,7,7,.52)" },
  historyDetailHeader: { alignItems: "center", justifyContent: "space-between", flexDirection: "row", gap: 12 },
  historyDetailLabel: { color: colors.paperMuted, flex: 1, fontSize: 8, letterSpacing: 1.02, fontWeight: "900" },
  historyCopy: { minHeight: 31, paddingHorizontal: 9, gap: 5, alignItems: "center", justifyContent: "center", flexDirection: "row", borderRadius: 10, backgroundColor: colors.paper },
  historyCopyText: { color: colors.ink, fontSize: 8, letterSpacing: 0.85, fontWeight: "900" },
  historyDetailText: { color: colors.paper, marginTop: 12, fontSize: 13, lineHeight: 20 },
});
