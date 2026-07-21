import * as Clipboard from "expo-clipboard";
import React, { useEffect, useMemo, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { playOfficeHaptic } from "../haptics";
import { colors, springs } from "../theme";
import type { BrainStatus, FleetProfileId, FleetSnapshot, HomeFleetInvite } from "../types";
import { VectorIcon } from "./VectorIcon";

type FleetSetupSheetProps = {
  /** `null` is normal for the short period between a QR handshake and probe. */
  snapshot: FleetSnapshot | null;
  /** Counters-only Second Brain view; `null` while the laptop is answering. */
  brain: BrainStatus | null;
  /** Covers the outgoing WebSocket action as well as bridge-side provisioning. */
  busy: boolean;
  onDismiss: () => void;
  onRefresh: () => void;
  onProvision: (profileId: FleetProfileId) => void;
  onConfigureResearch: (enabled: boolean, braveSearchApiKey?: string) => void;
  /** Transient: it is intentionally not saved on the phone. */
  homeFleetInvite: HomeFleetInvite | null;
  onCreateHomeFleetInvite: () => void;
  onRemoveHomeFleetWorker: (workerId: string) => void;
  onApproveHomeFleetWorker: (workerId: string) => void;
};

/**
 * Phone-side control plane for the deliberately constrained local model
 * presets. This component receives only a capability summary: it never
 * renders a filesystem path, process list, key, or guessed GPU inventory.
 * A profile must be selected and then confirmed before it can trigger an
 * Ollama download on the paired laptop.
 */
export function FleetSetupSheet({
  snapshot,
  brain,
  busy,
  onDismiss,
  onRefresh,
  onProvision,
  onConfigureResearch,
  homeFleetInvite,
  onCreateHomeFleetInvite,
  onRemoveHomeFleetWorker,
  onApproveHomeFleetWorker,
}: FleetSetupSheetProps): React.JSX.Element {
  const lift = useSharedValue(76);
  const opacity = useSharedValue(0);
  const [selectedProfileId, setSelectedProfileId] = useState<FleetProfileId | null>(null);
  const [showResearchKey, setShowResearchKey] = useState(false);
  const [braveSearchApiKey, setBraveSearchApiKey] = useState("");

  useEffect(() => {
    lift.value = withSpring(0, springs.callSheet);
    opacity.value = withSpring(1, springs.callSheet);
    playOfficeHaptic("RotaryRumble", 360);
  }, [lift, opacity]);

  // A refreshed capability sheet can invalidate an old selection. We never
  // auto-select the recommendation: owner intent must be explicit before a
  // potentially multi-gigabyte local download can begin.
  useEffect(() => {
    if (!snapshot) return;
    setSelectedProfileId(current => current && snapshot.profiles.some(entry => entry.profile.id === current) ? current : null);
    if (snapshot.research.hasBraveSearchApiKey) {
      setShowResearchKey(false);
      setBraveSearchApiKey("");
    }
  }, [snapshot]);

  const selected = useMemo(() => snapshot?.profiles.find(entry => entry.profile.id === selectedProfileId) ?? null, [selectedProfileId, snapshot]);
  const provisioning = Boolean(busy || snapshot?.provisioning.active);
  const canProvision = Boolean(selected?.canInstall && !provisioning);
  const sheetStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: lift.value }],
  }));

  const dismiss = () => {
    if (provisioning) return;
    playOfficeHaptic("HeavySwitch");
    onDismiss();
  };

  const chooseProfile = (profileId: FleetProfileId) => {
    if (provisioning) return;
    playOfficeHaptic("RotaryRumble", 180);
    setSelectedProfileId(profileId);
  };

  const confirmFleet = () => {
    if (!selected || !canProvision) return;
    playOfficeHaptic("HeavySwitch");
    onProvision(selected.profile.id);
  };

  const toggleResearch = () => {
    if (!snapshot || provisioning) return;
    playOfficeHaptic("HeavySwitch");
    onConfigureResearch(!snapshot.research.enabled);
  };

  const connectResearch = () => {
    const key = braveSearchApiKey.trim();
    if (!key || provisioning) return;
    // The input is transient by design. The app does not retain provider
    // credentials in AsyncStorage, logs, history, or subsequent UI state.
    setBraveSearchApiKey("");
    playOfficeHaptic("HeavySwitch");
    onConfigureResearch(true, key);
  };

  return <View style={styles.scrim} accessibilityViewIsModal>
    <Pressable style={styles.backdrop} onPress={dismiss} accessibilityRole="button" accessibilityLabel="Close laptop fleet setup" />
    <KeyboardAvoidingView style={styles.keyboard} behavior={Platform.select({ ios: "padding", default: undefined })} pointerEvents="box-none">
      <Animated.View style={[styles.sheet, sheetStyle]}>
        <View style={styles.handle} />
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <View style={styles.headerKickerRow}><View style={styles.headerIcon}><VectorIcon name="phone" size={15} color={colors.ink} /></View><Text style={styles.eyebrow}>PAIRED LAPTOP / LOCAL FLEET</Text></View>
            <Text style={styles.title}>Give your laptop a team.</Text>
          </View>
          <View style={styles.headerControls}>
            <Pressable
              onPress={onRefresh}
              disabled={provisioning}
              style={({ pressed }) => [styles.refresh, pressed && !provisioning && styles.pressed, provisioning && styles.muted]}
              accessibilityRole="button"
              accessibilityLabel="Refresh laptop capabilities"
            >
              <VectorIcon name="bolt" size={15} color={colors.paper} />
              <Text style={styles.refreshText}>REFRESH</Text>
            </Pressable>
            <Pressable onPress={dismiss} disabled={provisioning} style={({ pressed }) => [styles.close, pressed && !provisioning && styles.pressed, provisioning && styles.muted]} accessibilityRole="button" accessibilityLabel="Close laptop fleet setup">
              <VectorIcon name="close" size={17} color={colors.paper} />
            </Pressable>
          </View>
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {!snapshot ? <LoadingCapabilityView /> : <>
            <CapabilityView snapshot={snapshot} />

            <View style={styles.sectionHeading}>
              <Text style={styles.sectionEyebrow}>LOCAL MODEL PROFILES</Text>
              <Text style={styles.sectionCaption}>Serial local work</Text>
            </View>
            <Text style={styles.sectionIntro}>Choose a conservative mode for this laptop. Your main laptop will only pull its approved local Ollama models after your confirmation.</Text>

            <View style={styles.profileList}>
              {snapshot.profiles.map(assessment => {
                const selectedCard = selectedProfileId === assessment.profile.id;
                const recommended = snapshot.recommendedProfileId === assessment.profile.id;
                const active = snapshot.activeProfileId === assessment.profile.id;
                return <Pressable
                  key={assessment.profile.id}
                  onPress={() => chooseProfile(assessment.profile.id)}
                  disabled={provisioning}
                  style={({ pressed }) => [
                    styles.profileCard,
                    selectedCard && styles.profileCardSelected,
                    !assessment.canInstall && styles.profileCardUnavailable,
                    pressed && !provisioning && styles.pressed,
                    provisioning && styles.muted,
                  ]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: selectedCard, disabled: provisioning }}
                  accessibilityLabel={`${assessment.profile.name}${active ? ", active" : ""}${recommended ? ", recommended" : ""}${assessment.canInstall ? "" : ", unavailable"}`}
                >
                  <View style={[styles.radio, selectedCard && styles.radioSelected, !assessment.canInstall && styles.radioUnavailable]}><View style={[styles.radioCore, selectedCard && styles.radioCoreSelected]} /></View>
                  <View style={styles.profileCopy}>
                    <View style={styles.profileTopLine}>
                      <Text style={[styles.profileName, !assessment.canInstall && styles.profileNameUnavailable]}>{assessment.profile.name.toUpperCase()}</Text>
                      <View style={styles.badges}>
                        {recommended ? <Text style={styles.recommendedBadge}>RECOMMENDED</Text> : null}
                        {active ? <Text style={styles.activeBadge}>ACTIVE</Text> : null}
                        {!assessment.canInstall ? <Text style={styles.unavailableBadge}>UNAVAILABLE</Text> : null}
                      </View>
                    </View>
                    <Text style={styles.profileDescription}>{assessment.profile.description}</Text>
                    <View style={styles.profileMetrics}>
                      <Metric label="DOWNLOAD" value={formatBytes(assessment.profile.estimatedDownloadBytes)} />
                      <Metric label="WORKING RAM" value={formatBytes(assessment.profile.estimatedWorkingMemoryBytes)} />
                      <Metric label="CONTEXT" value={formatContext(assessment.profile.numCtx)} />
                    </View>
                    {!assessment.readyNow ? <View style={styles.reasonWrap}>{assessment.reasons.map(reason => <Text key={reason} style={styles.reason}>• {reason}</Text>)}</View> : <Text style={styles.ready}>READY NOW</Text>}
                  </View>
                </Pressable>;
              })}
            </View>

            <ProvisionConfirmation selected={selected} busy={provisioning} canProvision={canProvision} onConfirm={confirmFleet} />

            <ResearchConfiguration
              snapshot={snapshot}
              busy={provisioning}
              showKeyInput={showResearchKey}
              braveSearchApiKey={braveSearchApiKey}
              onShowKeyInput={() => { playOfficeHaptic("RotaryRumble", 180); setShowResearchKey(true); }}
              onKeyChange={setBraveSearchApiKey}
              onConnect={connectResearch}
              onToggle={toggleResearch}
            />

            <HomeFleetConfiguration
              snapshot={snapshot}
              invite={homeFleetInvite}
              busy={provisioning}
              onCreateInvite={onCreateHomeFleetInvite}
              onRemoveWorker={onRemoveHomeFleetWorker}
              onApproveWorker={onApproveHomeFleetWorker}
            />

            <SecondBrainStatusView brain={brain} />

            <View style={styles.privacyNote}>
              <VectorIcon name="phone" size={15} color={colors.paperMuted} />
              <Text style={styles.privacyText}>This sheet receives only capacity information. It never receives laptop files, paths, provider keys, or a guessed GPU/VRAM inventory.</Text>
            </View>
          </>}
        </ScrollView>
      </Animated.View>
    </KeyboardAvoidingView>
  </View>;
}

function LoadingCapabilityView(): React.JSX.Element {
  return <View style={styles.loading}>
    <View style={styles.loadingMark}><VectorIcon name="bolt" size={19} color={colors.ink} /></View>
    <Text style={styles.loadingTitle}>Reading the local envelope.</Text>
    <Text style={styles.loadingBody}>Your main laptop is checking safe capacity details before it suggests a model fleet.</Text>
  </View>;
}

function CapabilityView({ snapshot }: { snapshot: FleetSnapshot }): React.JSX.Element {
  const { hardware } = snapshot;
  const diskValue = hardware.disk.available && hardware.disk.freeBytes !== undefined
    ? `${formatBytes(hardware.disk.freeBytes)} FREE`
    : "CHECK ON LAPTOP";
  return <>
    <View style={styles.capabilityCard}>
      <View style={styles.capabilityHeader}><Text style={styles.capabilityLabel}>SAFE CAPABILITY VIEW</Text><Text style={styles.capabilityStatus}>{snapshot.provisioning.active ? "PREPARING" : "LIVE"}</Text></View>
      <View style={styles.capabilityMetrics}>
        <Metric label="MEMORY" value={`${formatBytes(hardware.memory.totalBytes)} TOTAL`} detail={`${formatBytes(hardware.memory.freeBytes)} free`} />
        <Metric label="DISK" value={diskValue} detail={hardware.disk.available && hardware.disk.totalBytes !== undefined ? `${formatBytes(hardware.disk.totalBytes)} total` : ""} />
        <Metric label="CPU" value={`${hardware.cpu.logicalCores} CORES`} detail={`${hardware.cpu.availableParallelism} available`} />
      </View>
    </View>
    {snapshot.notes.length ? <View style={styles.notes}>{snapshot.notes.map(note => <Text key={note} style={styles.note}>• {note}</Text>)}</View> : null}
  </>;
}

function ProvisionConfirmation({
  selected,
  busy,
  canProvision,
  onConfirm,
}: {
  selected: FleetSnapshot["profiles"][number] | null;
  busy: boolean;
  canProvision: boolean;
  onConfirm: () => void;
}): React.JSX.Element {
  const confirmScale = useSharedValue(1);
  const confirmStyle = useAnimatedStyle(() => ({ transform: [{ scale: confirmScale.value }] }));
  const label = busy
    ? "PREPARING LOCAL FLEET…"
    : !selected
      ? "CHOOSE A MODEL FLEET"
      : !selected.canInstall
        ? "PROFILE UNAVAILABLE"
        : `PREPARE ${selected.profile.name.toUpperCase()}`;
  const body = !selected
    ? "Select a profile above to see its download and working-memory envelope."
    : !selected.canInstall
      ? "This profile cannot fit the capability currently reported by the paired laptop."
      : selected.readyNow
        ? `${formatBytes(selected.profile.estimatedDownloadBytes)} may download if missing. Omnibus runs its local work one request at a time.`
        : `${formatBytes(selected.profile.estimatedDownloadBytes)} may download if missing. Read the capacity note above before preparing it.`;
  return <View style={styles.confirmBlock}>
    <Text style={styles.confirmEyebrow}>EXPLICIT LOCAL DOWNLOAD</Text>
    <Text style={styles.confirmBody}>{body}</Text>
    <Animated.View style={confirmStyle}>
      <Pressable
        onPressIn={() => { confirmScale.value = withSpring(0.97, springs.control); }}
        onPressOut={() => { confirmScale.value = withSpring(1, springs.control); }}
        onPress={onConfirm}
        disabled={!canProvision}
        style={({ pressed }) => [styles.confirmButton, (!canProvision || busy) && styles.confirmButtonDisabled, pressed && canProvision && styles.confirmButtonPressed]}
        accessibilityRole="button"
        accessibilityState={{ disabled: !canProvision, busy }}
        accessibilityLabel={label}
      >
        <VectorIcon name="bolt" size={17} color={canProvision ? colors.ink : colors.paperMuted} />
        <Text style={[styles.confirmButtonText, !canProvision && styles.confirmButtonTextDisabled]}>{label}</Text>
      </Pressable>
    </Animated.View>
  </View>;
}

function ResearchConfiguration({
  snapshot,
  busy,
  showKeyInput,
  braveSearchApiKey,
  onShowKeyInput,
  onKeyChange,
  onConnect,
  onToggle,
}: {
  snapshot: FleetSnapshot;
  busy: boolean;
  showKeyInput: boolean;
  braveSearchApiKey: string;
  onShowKeyInput: () => void;
  onKeyChange: (value: string) => void;
  onConnect: () => void;
  onToggle: () => void;
}): React.JSX.Element {
  const hasKey = snapshot.research.hasBraveSearchApiKey;
  if (hasKey) return <Pressable
    onPress={onToggle}
    disabled={busy}
    style={({ pressed }) => [styles.researchCard, snapshot.research.enabled && styles.researchCardEnabled, pressed && !busy && styles.pressed, busy && styles.muted]}
    accessibilityRole="switch"
    accessibilityState={{ checked: snapshot.research.enabled, disabled: busy }}
    accessibilityLabel="Enable cited web research on this paired laptop"
  >
    <View style={[styles.researchIcon, snapshot.research.enabled && styles.researchIconEnabled]}><VectorIcon name="research" size={18} color={snapshot.research.enabled ? colors.ink : colors.paper} /></View>
    <View style={styles.researchCopy}><Text style={[styles.researchTitle, snapshot.research.enabled && styles.researchTitleEnabled]}>CITED WEB RESEARCH {snapshot.research.enabled ? "ON" : "OFF"}</Text><Text style={[styles.researchBody, snapshot.research.enabled && styles.researchBodyEnabled]}>{snapshot.research.enabled ? "Your main laptop can use its configured provider when you explicitly turn research on for an idea." : "A provider key is already saved privately on the laptop. Tap to enable it for future explicitly consented ideas."}</Text></View>
    <View style={[styles.researchSwitch, snapshot.research.enabled && styles.researchSwitchEnabled]}><View style={[styles.researchKnob, snapshot.research.enabled && styles.researchKnobEnabled]} /></View>
  </Pressable>;

  return <View style={styles.researchSetup}>
    <View style={styles.researchSetupTop}>
      <View style={styles.researchIcon}><VectorIcon name="research" size={18} color={colors.paper} /></View>
      <View style={styles.researchCopy}><Text style={styles.researchTitle}>OPTIONAL CITED WEB RESEARCH</Text><Text style={styles.researchBody}>Add your own Brave Search API key once to enable public-source research. It is not stored on this iPhone.</Text></View>
    </View>
    {!showKeyInput ? <Pressable onPress={onShowKeyInput} disabled={busy} style={({ pressed }) => [styles.addKey, pressed && !busy && styles.pressed, busy && styles.muted]} accessibilityRole="button" accessibilityLabel="Add a Brave Search API key">
      <VectorIcon name="research" size={15} color={colors.ink} /><Text style={styles.addKeyText}>ADD BRAVE SEARCH KEY</Text>
    </Pressable> : <View style={styles.keyForm}>
      <Text style={styles.keyLabel}>BRAVE SEARCH API KEY</Text>
      <TextInput
        value={braveSearchApiKey}
        onChangeText={onKeyChange}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        textContentType="password"
        editable={!busy}
        placeholder="Paste key from Brave"
        placeholderTextColor={colors.paperMuted}
        style={styles.keyInput}
        accessibilityLabel="Brave Search API key"
      />
      <Text style={styles.keyNote}>Sent once through the authenticated laptop link, then saved only in your main laptop’s private local settings file.</Text>
      <Pressable onPress={onConnect} disabled={busy || braveSearchApiKey.trim().length < 10} style={({ pressed }) => [styles.connectKey, (busy || braveSearchApiKey.trim().length < 10) && styles.connectKeyDisabled, pressed && !busy && braveSearchApiKey.trim().length >= 10 && styles.pressed]} accessibilityRole="button" accessibilityState={{ disabled: busy || braveSearchApiKey.trim().length < 10 }} accessibilityLabel="Connect Brave Search and enable research">
        <VectorIcon name="research" size={15} color={busy || braveSearchApiKey.trim().length < 10 ? colors.paperMuted : colors.ink} /><Text style={[styles.connectKeyText, (busy || braveSearchApiKey.trim().length < 10) && styles.connectKeyTextDisabled]}>CONNECT BRAVE & ENABLE</Text>
      </Pressable>
    </View>}
  </View>;
}

/**
 * Home Fleet is a private-LAN compute pool, not an internet service. The
 * invitation contains a short-lived join secret and is held only in this
 * component tree until the sheet is closed or a fresh invitation replaces it.
 */
function HomeFleetConfiguration({
  snapshot,
  invite,
  busy,
  onCreateInvite,
  onRemoveWorker,
  onApproveWorker,
}: {
  snapshot: FleetSnapshot;
  invite: HomeFleetInvite | null;
  busy: boolean;
  onCreateInvite: () => void;
  onRemoveWorker: (workerId: string) => void;
  onApproveWorker: (workerId: string) => void;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const homeFleet = snapshot.homeFleet;
  const online = homeFleet.workers.filter(worker => worker.status === "online" && worker.modelReady && worker.approved).length;
  const atWorkerLimit = homeFleet.workers.length >= homeFleet.workerLimit;
  // A full fleet may still need a recovery invitation: an already paired
  // laptop uses it to prove its prior session and rebind after DHCP, a reboot,
  // or a coordinator restart. The coordinator refuses a *new* worker at the
  // limit, so leaving this action available cannot expand the fleet silently.
  const canInvite = homeFleet.available && !busy;
  const copyInvite = async () => {
    if (!invite) return;
    try {
      await Clipboard.setStringAsync(invite.command);
      setCopyError(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_800);
    } catch {
      setCopyError(true);
    }
  };
  return <View style={styles.homeFleetSection}>
    <View style={styles.sectionHeading}>
      <Text style={styles.sectionEyebrow}>HOME FLEET</Text>
      <Text style={styles.sectionCaption}>{online} READY / {homeFleet.workers.length} PAIRED</Text>
    </View>
    <Text style={styles.sectionIntro}>Invite spare laptops you control on this private network. They can perform bounded local peer reviews only; they never receive workspace files, saved memory, provider keys, or command authority.</Text>
    <Text style={styles.homeFleetSafety}>Use a trusted home LAN only — pairing is authenticated, but Home Fleet does not encrypt review text. Never use public Wi-Fi, guest networks, port forwarding, or the public phone tunnel.</Text>
    {!homeFleet.available ? <View style={styles.homeFleetUnavailable}>
      <Text style={styles.homeFleetUnavailableTitle}>HOME FLEET IS NOT AVAILABLE</Text>
      <Text style={styles.homeFleetUnavailableBody}>Your main laptop could not open its home-network link. Keep the laptop link running, check the laptop's terminal, then refresh this sheet.</Text>
    </View> : <>
      <Pressable
        onPress={onCreateInvite}
        disabled={!canInvite}
        style={({ pressed }) => [styles.homeFleetInvite, !canInvite && styles.homeFleetInviteDisabled, pressed && canInvite && styles.pressed]}
        accessibilityRole="button"
        accessibilityState={{ disabled: !canInvite, busy }}
        accessibilityLabel="Create a one-time home laptop invitation"
      >
        <VectorIcon name="phone" size={16} color={canInvite ? colors.ink : colors.paperMuted} />
        <Text style={[styles.homeFleetInviteText, !canInvite && styles.homeFleetInviteTextDisabled]}>{busy ? "CONTACTING YOUR MAIN LAPTOP…" : atWorkerLimit ? "RE-PAIR A HOME LAPTOP" : "INVITE A HOME LAPTOP"}</Text>
      </Pressable>
      {atWorkerLimit ? <Text style={styles.homeFleetSafety}>The fleet is full. This re-pair command can reconnect an existing home laptop after a network change; remove a home laptop before adding a new one.</Text> : null}
      {invite ? <View style={styles.inviteCard}>
        <View style={styles.inviteHeader}><Text style={styles.inviteLabel}>ONE-TIME HOME LAPTOP COMMAND</Text><Text style={styles.inviteExpiry}>EXPIRES {readableExpiry(invite.expiresAt)}</Text></View>
        <Text selectable numberOfLines={4} style={styles.inviteCommand}>{invite.command}</Text>
        <Text style={styles.inviteNote}>Copy this into Terminal or Windows PowerShell on one spare laptop you control, while both laptops are on this same private network.</Text>
        <Pressable onPress={() => { void copyInvite(); }} style={({ pressed }) => [styles.copyInvite, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel="Copy home laptop command">
          <VectorIcon name="copy" size={15} color={colors.ink} /><Text style={styles.copyInviteText}>{copied ? "COPIED" : copyError ? "COPY UNAVAILABLE" : "COPY COMMAND"}</Text>
        </Pressable>
      </View> : null}
      {homeFleet.workers.length ? <View style={styles.workerList}>
        {homeFleet.workers.map(worker => <View key={worker.id} style={styles.workerRow}>
          <View style={[styles.workerDot, worker.status === "online" && worker.modelReady && worker.approved && styles.workerDotReady]} />
          <View style={styles.workerCopy}><Text style={styles.workerLabel}>{worker.label.toUpperCase()}</Text><Text style={styles.workerMeta}>HOME NETWORK / {!worker.approved ? "AWAITING APPROVAL" : worker.status === "online" && worker.modelReady ? "READY" : worker.status === "needs-model" ? "MODEL NEEDED" : "OFFLINE"}</Text></View>
          {!worker.approved ? <Pressable onPress={() => onApproveWorker(worker.id)} disabled={busy || !worker.modelReady || worker.status !== "online"} style={({ pressed }) => [styles.workerApprove, (busy || !worker.modelReady || worker.status !== "online") && styles.workerApproveDisabled, pressed && !busy && worker.modelReady && worker.status === "online" && styles.pressed]} accessibilityRole="button" accessibilityState={{ disabled: busy || !worker.modelReady || worker.status !== "online" }} accessibilityLabel={`Approve ${worker.label} for home fleet peer review`}><Text style={[styles.workerApproveText, (busy || !worker.modelReady || worker.status !== "online") && styles.workerApproveTextDisabled]}>ACTIVATE</Text></Pressable> : null}
          <Pressable onPress={() => onRemoveWorker(worker.id)} disabled={busy} style={({ pressed }) => [styles.workerRemove, pressed && !busy && styles.pressed, busy && styles.muted]} accessibilityRole="button" accessibilityLabel={`Remove ${worker.label} from the home fleet`}><VectorIcon name="close" size={13} color={colors.paper} /></Pressable>
        </View>)}
      </View> : <Text style={styles.homeFleetEmpty}>No spare laptops are paired yet. This laptop remains a complete local team on its own.</Text>}
    </>}
  </View>;
}

/**
 * The Second Brain lives entirely on the paired laptop. This card shows the
 * ambient knowledge system is alive — counters, watcher states, and the fleet
 * context-cache summary — without ever receiving graph content, file paths,
 * or worker network identities.
 */
function SecondBrainStatusView({ brain }: { brain: BrainStatus | null }): React.JSX.Element {
  const watcherText = (state: BrainStatus["watchers"]["git"]): string =>
    state === "active" ? "WATCHING" : state === "unavailable" ? "UNAVAILABLE" : "OFF";
  return <View style={styles.homeFleetSection}>
    <View style={styles.sectionHeading}>
      <Text style={styles.sectionEyebrow}>SECOND BRAIN</Text>
      <Text style={styles.sectionCaption}>{brain?.enabled ? `${brain.facts} FACTS / ${brain.nodes} NODES` : brain ? "OFF" : "CHECKING…"}</Text>
    </View>
    <Text style={styles.sectionIntro}>Your laptop keeps a persistent, local-only project memory: a bi-temporal knowledge graph fed by ambient capture of git activity, diagnostics, and your idea history. Nothing in it is uploaded or sent to this phone.</Text>
    {!brain ? <Text style={styles.homeFleetEmpty}>Waiting for the paired laptop to report its knowledge system.</Text>
      : !brain.enabled ? <Text style={styles.homeFleetEmpty}>The Second Brain is disabled on the laptop (OMNIBUS_SECOND_BRAIN=false). Ideas still work statelessly.</Text>
        : <>
          <View style={styles.brainMetrics}>
            {brain.capacityTier ? <Metric label="SIZED FOR" value={brain.capacityTier.toUpperCase()} detail="fits this laptop" /> : null}
            <Metric label="GIT WATCH" value={watcherText(brain.watchers.git)} />
            <Metric label="DIAGNOSTICS" value={watcherText(brain.watchers.diagnostics)} />
            <Metric label="ANTI-PATTERNS" value={`${brain.antiPatterns}`} />
            <Metric label="SUPERSEDED" value={`${brain.invalidatedFacts}`} detail="kept, never deleted" />
          </View>
          {brain.lastRetrieval ? <Text style={styles.homeFleetSafety}>Last idea recalled {brain.lastRetrieval.facts} linked memor{brain.lastRetrieval.facts === 1 ? "y" : "ies"} across {brain.lastRetrieval.entityCount} matched concept{brain.lastRetrieval.entityCount === 1 ? "" : "s"}.</Text> : null}
          <Text style={styles.homeFleetSafety}>
            {brain.fleetCache.sharingEnabled
              ? brain.fleetCache.bundleReady
                ? `Fleet context cache: bundle ready · ${brain.fleetCache.workersWarm} home laptop${brain.fleetCache.workersWarm === 1 ? "" : "s"} pre-warmed for faster peer reviews.`
                : "Fleet context cache: no context bundle yet — it compiles from distilled facts after a few ideas."
              : "Fleet context sharing is off (laptop-side HOME_FLEET_CONTEXT_SHARING). Home laptops keep receiving idea text only."}
          </Text>
        </>}
  </View>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }): React.JSX.Element {
  return <View style={styles.metric}><Text style={styles.metricLabel}>{label}</Text><Text style={styles.metricValue}>{value}</Text>{detail ? <Text style={styles.metricDetail}>{detail}</Text> : null}</View>;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 GB";
  const gib = bytes / (1024 * 1024 * 1024);
  if (gib >= 1) return `${gib >= 10 ? Math.round(gib) : gib.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

function formatContext(tokens: number): string {
  return `${Math.round(tokens / 1024)}K`;
}

function readableExpiry(value: string): string {
  const expiresAt = new Date(value).getTime();
  const minutes = Math.max(0, Math.ceil((expiresAt - Date.now()) / 60_000));
  return minutes > 1 ? `IN ${minutes} MIN` : "SOON";
}

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFillObject, zIndex: 50, backgroundColor: "rgba(0,0,0,.76)", justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFillObject },
  keyboard: { flex: 1, justifyContent: "flex-end" },
  sheet: { maxHeight: "91%", borderTopLeftRadius: 29, borderTopRightRadius: 29, overflow: "hidden", backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.lineStrong, shadowColor: "#000", shadowOpacity: 0.55, shadowOffset: { width: 0, height: -8 }, shadowRadius: 24 },
  handle: { alignSelf: "center", width: 35, height: 4, borderRadius: 4, marginTop: 10, backgroundColor: colors.lineStrong },
  header: { minHeight: 88, paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, alignItems: "center", justifyContent: "space-between", flexDirection: "row", gap: 12 },
  headerCopy: { flex: 1, minWidth: 0 },
  headerKickerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  headerIcon: { width: 25, height: 25, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: colors.paper },
  eyebrow: { color: colors.paperMuted, fontSize: 9, fontWeight: "900", letterSpacing: 1.05 },
  title: { color: colors.paper, fontSize: 23, fontWeight: "700", letterSpacing: -0.6, marginTop: 7 },
  headerControls: { flexDirection: "row", alignItems: "center", gap: 7 },
  refresh: { minHeight: 34, paddingHorizontal: 9, gap: 5, borderRadius: 10, alignItems: "center", justifyContent: "center", flexDirection: "row", borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  refreshText: { color: colors.paper, fontSize: 8, fontWeight: "900", letterSpacing: 0.72 },
  close: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  scroll: { flexShrink: 1 },
  scrollContent: { padding: 19, paddingBottom: 35 },
  pressed: { opacity: 0.7 },
  muted: { opacity: 0.55 },
  loading: { minHeight: 330, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  loadingMark: { width: 45, height: 45, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: colors.paper },
  loadingTitle: { color: colors.paper, fontSize: 20, fontWeight: "700", marginTop: 16, letterSpacing: -0.35, textAlign: "center" },
  loadingBody: { color: colors.paperMuted, fontSize: 13, lineHeight: 19, marginTop: 8, textAlign: "center", maxWidth: 310 },
  capabilityCard: { padding: 14, borderRadius: 17, borderWidth: 1, borderColor: colors.line, backgroundColor: "rgba(12,12,13,.5)" },
  capabilityHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  capabilityLabel: { color: colors.paperMuted, fontSize: 8, letterSpacing: 1.1, fontWeight: "900" },
  capabilityStatus: { color: colors.paper, fontSize: 8, letterSpacing: 0.9, fontWeight: "900" },
  capabilityMetrics: { marginTop: 12, flexDirection: "row", flexWrap: "wrap", gap: 16 },
  brainMetrics: { marginTop: 12, flexDirection: "row", flexWrap: "wrap", gap: 16 },
  metric: { minWidth: 74, flexGrow: 1 },
  metricLabel: { color: colors.paperMuted, fontSize: 8, fontWeight: "900", letterSpacing: 0.78 },
  metricValue: { color: colors.paper, fontSize: 11, fontWeight: "700", marginTop: 4 },
  metricDetail: { color: colors.paperMuted, fontSize: 9, marginTop: 2 },
  notes: { marginTop: 9, gap: 4 },
  note: { color: colors.paperMuted, fontSize: 10, lineHeight: 15 },
  sectionHeading: { marginTop: 25, alignItems: "center", justifyContent: "space-between", flexDirection: "row", gap: 10 },
  sectionEyebrow: { color: colors.paperMuted, fontSize: 9, fontWeight: "900", letterSpacing: 1.05 },
  sectionCaption: { color: colors.paperMuted, fontSize: 9, textAlign: "right" },
  sectionIntro: { color: colors.paperMuted, fontSize: 12, lineHeight: 18, marginTop: 8 },
  profileList: { marginTop: 12, overflow: "hidden", borderWidth: 1, borderColor: colors.line, borderRadius: 18, backgroundColor: "rgba(12,12,13,.44)" },
  profileCard: { minHeight: 122, padding: 13, flexDirection: "row", gap: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  profileCardSelected: { backgroundColor: "rgba(244,244,240,.09)" },
  profileCardUnavailable: { backgroundColor: "rgba(244,244,240,.025)" },
  radio: { width: 18, height: 18, marginTop: 1, borderRadius: 9, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.lineStrong },
  radioSelected: { borderColor: colors.paper },
  radioUnavailable: { borderColor: colors.paperMuted },
  radioCore: { width: 6, height: 6, borderRadius: 3, backgroundColor: "transparent" },
  radioCoreSelected: { backgroundColor: colors.paper },
  profileCopy: { flex: 1, minWidth: 0 },
  profileTopLine: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  profileName: { flexShrink: 1, color: colors.paper, fontSize: 10, letterSpacing: 1.05, fontWeight: "900" },
  profileNameUnavailable: { color: colors.paperMuted },
  badges: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end", gap: 5 },
  recommendedBadge: { color: colors.ink, fontSize: 7, letterSpacing: 0.64, fontWeight: "900", paddingHorizontal: 5, paddingVertical: 3, borderRadius: 4, backgroundColor: colors.paper },
  activeBadge: { color: colors.paper, fontSize: 7, letterSpacing: 0.64, fontWeight: "900", paddingHorizontal: 5, paddingVertical: 3, borderRadius: 4, borderWidth: 1, borderColor: colors.lineStrong },
  unavailableBadge: { color: colors.paperMuted, fontSize: 7, letterSpacing: 0.64, fontWeight: "900" },
  profileDescription: { color: colors.paperMuted, fontSize: 10, lineHeight: 14, marginTop: 5 },
  profileMetrics: { marginTop: 10, flexDirection: "row", flexWrap: "wrap", gap: 11 },
  reasonWrap: { marginTop: 8, gap: 3 },
  reason: { color: colors.paperMuted, fontSize: 9, lineHeight: 13 },
  ready: { color: colors.paper, fontSize: 8, fontWeight: "900", letterSpacing: 0.78, marginTop: 9 },
  confirmBlock: { marginTop: 15, padding: 14, borderRadius: 17, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: "rgba(244,244,240,.055)" },
  confirmEyebrow: { color: colors.paperMuted, fontSize: 8, letterSpacing: 1.02, fontWeight: "900" },
  confirmBody: { color: colors.paperMuted, fontSize: 11, lineHeight: 16, marginTop: 7 },
  confirmButton: { minHeight: 47, paddingHorizontal: 14, marginTop: 12, gap: 8, alignItems: "center", justifyContent: "center", flexDirection: "row", borderRadius: 14, backgroundColor: colors.paper },
  confirmButtonDisabled: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  confirmButtonPressed: { opacity: 0.78 },
  confirmButtonText: { color: colors.ink, fontSize: 9, fontWeight: "900", letterSpacing: 0.83 },
  confirmButtonTextDisabled: { color: colors.paperMuted },
  researchCard: { minHeight: 84, marginTop: 15, padding: 13, gap: 11, alignItems: "center", flexDirection: "row", borderWidth: 1, borderColor: colors.line, borderRadius: 17, backgroundColor: "rgba(12,12,13,.48)" },
  researchCardEnabled: { borderColor: colors.paper, backgroundColor: "rgba(244,244,240,.11)" },
  researchSetup: { marginTop: 15, padding: 14, borderRadius: 17, borderWidth: 1, borderColor: colors.line, backgroundColor: "rgba(12,12,13,.48)" },
  researchSetupTop: { gap: 11, alignItems: "center", flexDirection: "row" },
  researchIcon: { width: 35, height: 35, borderRadius: 11, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface },
  researchIconEnabled: { backgroundColor: colors.paper, borderColor: colors.paper },
  researchCopy: { flex: 1, minWidth: 0 },
  researchTitle: { color: colors.paper, fontSize: 9, letterSpacing: 0.9, fontWeight: "900" },
  researchTitleEnabled: { color: colors.paper },
  researchBody: { color: colors.paperMuted, fontSize: 10, lineHeight: 14, marginTop: 4 },
  researchBodyEnabled: { color: colors.paper },
  researchSwitch: { width: 32, height: 19, padding: 2, borderRadius: 10, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface },
  researchSwitchEnabled: { borderColor: colors.paper, backgroundColor: colors.paper },
  researchKnob: { width: 13, height: 13, borderRadius: 7, backgroundColor: colors.paperMuted },
  researchKnobEnabled: { alignSelf: "flex-end", backgroundColor: colors.ink },
  addKey: { minHeight: 40, paddingHorizontal: 12, marginTop: 13, gap: 7, alignItems: "center", justifyContent: "center", flexDirection: "row", borderRadius: 12, backgroundColor: colors.paper },
  addKeyText: { color: colors.ink, fontSize: 9, letterSpacing: 0.8, fontWeight: "900" },
  keyForm: { marginTop: 14 },
  keyLabel: { color: colors.paperMuted, fontSize: 8, letterSpacing: 0.9, fontWeight: "900" },
  keyInput: { minHeight: 46, paddingHorizontal: 12, marginTop: 7, borderRadius: 12, borderWidth: 1, borderColor: colors.lineStrong, color: colors.paper, fontSize: 14, backgroundColor: colors.ink },
  keyNote: { color: colors.paperMuted, fontSize: 10, lineHeight: 14, marginTop: 7 },
  connectKey: { minHeight: 41, paddingHorizontal: 12, marginTop: 11, gap: 7, alignItems: "center", justifyContent: "center", flexDirection: "row", borderRadius: 12, backgroundColor: colors.paper },
  connectKeyDisabled: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  connectKeyText: { color: colors.ink, fontSize: 9, letterSpacing: 0.74, fontWeight: "900" },
  connectKeyTextDisabled: { color: colors.paperMuted },
  homeFleetSection: { marginTop: 8 },
  homeFleetSafety: { color: colors.paperMuted, fontSize: 9, lineHeight: 14, marginTop: 8, opacity: 0.82 },
  homeFleetUnavailable: { marginTop: 12, padding: 14, borderWidth: 1, borderColor: colors.line, borderRadius: 17, backgroundColor: "rgba(12,12,13,.48)" },
  homeFleetUnavailableTitle: { color: colors.paper, fontSize: 9, letterSpacing: 0.9, fontWeight: "900" },
  homeFleetUnavailableBody: { color: colors.paperMuted, fontSize: 10, lineHeight: 15, marginTop: 6 },
  homeFleetInvite: { minHeight: 44, paddingHorizontal: 13, marginTop: 12, gap: 8, alignItems: "center", justifyContent: "center", flexDirection: "row", borderRadius: 13, backgroundColor: colors.paper },
  homeFleetInviteDisabled: { borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  homeFleetInviteText: { color: colors.ink, fontSize: 9, letterSpacing: 0.82, fontWeight: "900" },
  homeFleetInviteTextDisabled: { color: colors.paperMuted },
  inviteCard: { marginTop: 10, padding: 13, borderRadius: 16, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: "rgba(244,244,240,.055)" },
  inviteHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  inviteLabel: { flexShrink: 1, color: colors.paper, fontSize: 8, letterSpacing: 0.92, fontWeight: "900" },
  inviteExpiry: { color: colors.paperMuted, fontSize: 7, letterSpacing: 0.66, fontWeight: "900" },
  inviteCommand: { color: colors.paper, fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 9, lineHeight: 14, marginTop: 10 },
  inviteNote: { color: colors.paperMuted, fontSize: 10, lineHeight: 15, marginTop: 9 },
  copyInvite: { minHeight: 38, paddingHorizontal: 12, marginTop: 11, gap: 7, alignSelf: "flex-start", alignItems: "center", justifyContent: "center", flexDirection: "row", borderRadius: 11, backgroundColor: colors.paper },
  copyInviteText: { color: colors.ink, fontSize: 8, letterSpacing: 0.74, fontWeight: "900" },
  workerList: { marginTop: 11, overflow: "hidden", borderWidth: 1, borderColor: colors.line, borderRadius: 16, backgroundColor: "rgba(12,12,13,.42)" },
  workerRow: { minHeight: 55, paddingHorizontal: 12, alignItems: "center", flexDirection: "row", gap: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  workerDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.paperMuted },
  workerDotReady: { backgroundColor: colors.paper },
  workerCopy: { flex: 1, minWidth: 0 },
  workerLabel: { color: colors.paper, fontSize: 9, letterSpacing: 0.78, fontWeight: "900" },
  workerMeta: { color: colors.paperMuted, fontSize: 8, lineHeight: 12, marginTop: 3 },
  workerApprove: { minHeight: 29, paddingHorizontal: 7, alignItems: "center", justifyContent: "center", borderRadius: 8, backgroundColor: colors.paper },
  workerApproveDisabled: { borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  workerApproveText: { color: colors.ink, fontSize: 7, letterSpacing: 0.58, fontWeight: "900" },
  workerApproveTextDisabled: { color: colors.paperMuted },
  workerRemove: { width: 29, height: 29, borderRadius: 9, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  homeFleetEmpty: { color: colors.paperMuted, fontSize: 10, lineHeight: 15, marginTop: 10 },
  privacyNote: { marginTop: 16, paddingHorizontal: 4, gap: 8, flexDirection: "row", alignItems: "flex-start" },
  privacyText: { flex: 1, color: colors.paperMuted, fontSize: 9, lineHeight: 14 },
});
