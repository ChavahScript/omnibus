import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { AppState, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { BridgeConnection, parsePairingPayload, type BridgeDisconnect } from "./src/bridge";
import { CallSheet } from "./src/components/CallSheet";
import { IdeaAtmosphere, OmnibusSplash } from "./src/components/IdeaAtmosphere";
import { OfficeDashboard } from "./src/components/OfficeDashboard";
import { FleetSetupSheet } from "./src/components/FleetSetupSheet";
import { PairingOnboarding } from "./src/components/PairingOnboarding";
import { QRScanner } from "./src/components/QRScanner";
import {
  clearPairedBridgeProfile,
  loadLocalAppleProfile,
  loadPairedBridgeProfile,
  saveLocalAppleProfile,
  savePairedBridgeProfile,
} from "./src/localData";
import { colors } from "./src/theme";
import type { LocalAppleProfile } from "./src/localData";
import type { AgentName, BrainStatus, BridgeEvent, BridgeResumeProfile, CommandMode, ConnectionPresence, DashboardMessage, FleetSnapshot, HomeFleetInvite, UsageStatus } from "./src/types";

const PAIRING_ONBOARDED_KEY = "@omnibus/has-paired-laptop";
const HEARTBEAT_INTERVAL_MS = 8_000;
const HEARTBEAT_STALE_MS = 24_000;
// The transport itself makes five quick attempts. If a tunnel is unavailable
// longer than that, continue with an intentionally calm foreground cadence so
// a captive portal or short train/coffee-shop outage never forces a rescan.
const PERSISTED_SESSION_RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;

type ActiveCall = {
  correlationId: string;
  agent: AgentName;
  title: string;
  body: string;
};

export default function App(): React.JSX.Element {
  return <StartupGuard><OmnibusApp /></StartupGuard>;
}

/**
 * Production React Native does not show a useful red error overlay. Keep a
 * visible recovery state around the whole app so an optional native module can
 * never look like an unexplained black TestFlight launch.
 */
class StartupGuard extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  public state: { error: Error | null } = { error: null };

  public static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  public componentDidCatch(error: Error): void {
    console.error("Omnibus startup render error", error);
  }

  public render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return <SafeAreaView style={styles.recoverySafe}>
      <IdeaAtmosphere compact />
      <View style={styles.recovery}>
        <Text style={styles.recoveryKicker}>OMNIBUS / STARTUP CHECK</Text>
        <Text style={styles.recoveryTitle}>The working room could not finish opening.</Text>
        <Text style={styles.recoveryBody}>Close and reopen Omnibus. If this remains, install the newest TestFlight build before recording the demo.</Text>
      </View>
    </SafeAreaView>;
  }
}

function OmnibusApp(): React.JSX.Element {
  const connection = useRef(new BridgeConnection()).current;
  const [scannerVisible, setScannerVisible] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connectionPresence, setConnectionPresence] = useState<ConnectionPresence>("offline");
  const [isConnecting, setIsConnecting] = useState(false);
  const [hasPairedBefore, setHasPairedBefore] = useState<boolean | null>(null);
  const [setupVisible, setSetupVisible] = useState(false);
  const [localAppleProfile, setLocalAppleProfile] = useState<LocalAppleProfile | null>(null);
  const [splashComplete, setSplashComplete] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [messages, setMessages] = useState<DashboardMessage[]>([]);
  const [usage, setUsage] = useState<UsageStatus | null>(null);
  const [fleet, setFleet] = useState<FleetSnapshot | null>(null);
  const [brain, setBrain] = useState<BrainStatus | null>(null);
  const [fleetSetupVisible, setFleetSetupVisible] = useState(false);
  const [fleetBusy, setFleetBusy] = useState(false);
  const [homeFleetInvite, setHomeFleetInvite] = useState<HomeFleetInvite | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const pairingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const persistedRecoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistedRecoveryAttempt = useRef(0);
  const lastResponsiveAt = useRef(0);
  const lastSocketRefreshAt = useRef(0);
  const appIsActive = useRef(AppState.currentState === "active");
  const didHandshake = useRef(false);
  const didOfferFleetSetup = useRef(false);
  // This profile is the only source used to resume after an app relaunch. It
  // never includes the one-time QR pairing token; see localData for the
  // Keychain-only storage boundary.
  const savedBridgeProfile = useRef<BridgeResumeProfile | null>(null);
  const bridgeProfileWrite = useRef<Promise<void>>(Promise.resolve());
  const bridgeProfileReady = useRef(false);
  const restoreAttempted = useRef(false);
  const manualPairingAttempted = useRef(false);
  const resumeInFlight = useRef(false);
  const [bridgeProfileLoaded, setBridgeProfileLoaded] = useState(false);
  const [persistedRecoveryCycle, setPersistedRecoveryCycle] = useState(0);

  const clearPairingTimeout = useCallback(() => {
    if (pairingTimeout.current !== null) {
      clearTimeout(pairingTimeout.current);
      pairingTimeout.current = null;
    }
  }, []);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatTimer.current !== null) {
      clearInterval(heartbeatTimer.current);
      heartbeatTimer.current = null;
    }
  }, []);

  const clearPersistedRecoveryTimer = useCallback(() => {
    if (persistedRecoveryTimer.current !== null) {
      clearTimeout(persistedRecoveryTimer.current);
      persistedRecoveryTimer.current = null;
    }
  }, []);

  const markBridgeResponsive = useCallback(() => {
    lastResponsiveAt.current = Date.now();
    if (didHandshake.current && appIsActive.current) setConnectionPresence("live");
  }, []);

  const runHeartbeat = useCallback(() => {
    if (!didHandshake.current || !appIsActive.current) return;
    // Keep sending a tiny ping even after the link is marked stale. A laptop
    // waking from sleep can then recover to live on its next pong without
    // forcing the owner to rescan an already-open session.
    const respondedRecently = Date.now() - lastResponsiveAt.current <= HEARTBEAT_STALE_MS;
    if (!connection.ping() || !respondedRecently) {
      setConnectionPresence("stale");
      // A phone coming out of iOS suspension can retain an OPEN-looking
      // native socket that no longer carries packets. Give the bridge a calm,
      // bounded fresh upgrade rather than waiting forever for that socket.
      const now = Date.now();
      if (!respondedRecently && now - lastSocketRefreshAt.current >= HEARTBEAT_STALE_MS) {
        lastSocketRefreshAt.current = now;
        connection.refresh();
      }
    }
  }, [connection]);

  const startHeartbeat = useCallback(() => {
    stopHeartbeat();
    if (!didHandshake.current || !appIsActive.current) return;
    runHeartbeat();
    heartbeatTimer.current = setInterval(runHeartbeat, HEARTBEAT_INTERVAL_MS);
  }, [runHeartbeat, stopHeartbeat]);

  useEffect(() => {
    let live = true;
    // Load both stores as one boot decision so an existing secure bridge
    // session cannot briefly show first-run onboarding while iOS reconnects.
    void Promise.all([
      AsyncStorage.getItem(PAIRING_ONBOARDED_KEY).catch(() => null),
      loadPairedBridgeProfile().catch(() => null),
    ]).then(([onboarded, profile]) => {
      if (!live) return;
      // A very fast manual scan can complete while Keychain is loading. Never
      // overwrite that newly rotated session with an older boot record.
      if (!manualPairingAttempted.current) savedBridgeProfile.current = profile;
      bridgeProfileReady.current = true;
      setHasPairedBefore(onboarded === "true" || profile !== null || savedBridgeProfile.current !== null);
      setBridgeProfileLoaded(true);
    });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    let live = true;
    void loadLocalAppleProfile()
      .then(profile => { if (live) setLocalAppleProfile(profile); })
      .catch(() => {
        // A local profile is optional. Pairing and ideation stay available if
        // Keychain is unavailable on a development device.
      });
    return () => { live = false; };
  }, []);

  useEffect(() => () => {
    clearPairingTimeout();
    stopHeartbeat();
    clearPersistedRecoveryTimer();
    connection.close();
  }, [clearPairingTimeout, clearPersistedRecoveryTimer, connection, stopHeartbeat]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", nextState => {
      appIsActive.current = nextState === "active";
      if (!appIsActive.current) {
        stopHeartbeat();
        clearPersistedRecoveryTimer();
        return;
      }
      if (didHandshake.current) {
        // Do not treat the time while iOS suspended JavaScript as a failed
        // link. A fresh ping on return is the authority for presence.
        lastResponsiveAt.current = Date.now();
        setConnectionPresence("checking");
        startHeartbeat();
      }
    });
    return () => subscription.remove();
  }, [clearPersistedRecoveryTimer, startHeartbeat, stopHeartbeat]);

  const append = useCallback((agent: AgentName, stage: string, text: string, correlationId?: string) => {
    setMessages(previous => [...previous, { id: String(Date.now()) + "-" + String(Math.random()), agent, stage, text, at: new Date(), correlationId }].slice(-60));
  }, []);

  const rememberSuccessfulPairing = useCallback(() => {
    setHasPairedBefore(true);
    void AsyncStorage.setItem(PAIRING_ONBOARDED_KEY, "true").catch(() => {
      // Onboarding remains safe even if device storage is unavailable.
    });
  }, []);

  /**
   * SecureStore writes are serialized because every successful resume rotates
   * the bearer secret. A late older write must never overwrite a newer hello.
   */
  const persistBridgeSession = useCallback((profile: BridgeResumeProfile): Promise<void> => {
    savedBridgeProfile.current = profile;
    const write = bridgeProfileWrite.current
      .catch(() => undefined)
      .then(() => savePairedBridgeProfile(profile));
    bridgeProfileWrite.current = write;
    return write;
  }, []);

  /** Forget the Keychain session only after a definitive security/expiry failure. */
  const forgetSavedBridgeSession = useCallback((): Promise<void> => {
    savedBridgeProfile.current = null;
    const clear = bridgeProfileWrite.current
      .catch(() => undefined)
      .then(() => clearPairedBridgeProfile());
    bridgeProfileWrite.current = clear;
    return clear;
  }, []);

  const rememberLocalAppleProfile = useCallback((profile: LocalAppleProfile) => {
    setLocalAppleProfile(profile);
    void saveLocalAppleProfile(profile).catch(() => {
      // The UI is explicit that this is local-only. Do not fall back to a
      // network request or persist an Apple credential anywhere else.
    });
  }, []);

  const onEvent = useCallback((event: BridgeEvent) => {
    if (event.type !== "hello") markBridgeResponsive();
    if (event.type === "hello") {
      didHandshake.current = true;
      resumeInFlight.current = false;
      lastSocketRefreshAt.current = 0;
      persistedRecoveryAttempt.current = 0;
      clearPersistedRecoveryTimer();
      clearPairingTimeout();
      setConnected(true);
      setUsage(event.usage);
      setSetupVisible(false);
      setIsConnecting(false);
      setPairingError(null);
      markBridgeResponsive();
      startHeartbeat();
      rememberSuccessfulPairing();
      // The bridge emits its own snapshot too, but requesting it here makes a
      // reconnect deterministic and avoids leaving a paired owner in an empty
      // setup sheet while a laptop wakes from sleep.
      connection.requestFleetSnapshot();
      connection.requestBrainStatus();
      append("system", "paired", "Laptop linked · local runs " + event.usage.localRuns + ", cloud runs " + event.usage.cloudRuns + ".");
    } else if (event.type === "brain") {
      // Counters only: the laptop's knowledge graph content stays local.
      setBrain(event.status);
    } else if (event.type === "fleet") {
      setFleet(event.snapshot);
      if (!event.snapshot.provisioning.active) setFleetBusy(false);
      // On a newly paired laptop with no saved fleet, put the owner's next
      // useful action directly in reach. It opens once per pairing attempt;
      // dismissing it remains a valid choice.
      if (!event.snapshot.activeProfileId && !didOfferFleetSetup.current) {
        didOfferFleetSetup.current = true;
        setFleetSetupVisible(true);
      }
    } else if (event.type === "home_fleet_invite") {
      // The one-time command lives only in this React state. It is never
      // copied to this iPhone's idea history or persisted in AsyncStorage.
      setHomeFleetInvite(event.invite);
      setFleetBusy(false);
      setFleetSetupVisible(true);
      append("system", "home_fleet_invite", "A short-lived home-worker command is ready. Paste it only into a laptop you control on this home network.", event.invite.correlationId);
    } else if (event.type === "status") {
      append(event.agent, event.stage, event.text, event.correlationId);
    } else if (event.type === "call") {
      setActiveCall(current => event.action === "open"
        ? { correlationId: event.correlationId, agent: event.agent, title: event.title, body: event.body }
        : current?.correlationId === event.correlationId ? null : current);
    } else if (event.type === "usage") {
      setUsage(event.usage);
    } else if (event.type === "result") {
      append(event.agent, "result", event.summary, event.correlationId);
    } else if (event.type === "error") {
      if ((event.code.startsWith("FLEET_") && event.code !== "FLEET_PROVISIONING") || event.code.startsWith("HOME_FLEET_") || event.code === "LOCAL_TEAM_BUSY" || event.code === "OLLAMA_UNAVAILABLE" || event.code === "RESEARCH_KEY_REQUIRED") setFleetBusy(false);
      append("system", event.code, event.message, event.correlationId);
    }
    // A pong has no feed entry by design; it only renews live presence.
  }, [append, clearPairingTimeout, clearPersistedRecoveryTimer, markBridgeResponsive, rememberSuccessfulPairing, startHeartbeat]);

  const onDisconnect = useCallback((disconnect: BridgeDisconnect) => {
    const wasPaired = didHandshake.current;
    didHandshake.current = false;
    resumeInFlight.current = false;
    lastSocketRefreshAt.current = 0;
    clearPairingTimeout();
    stopHeartbeat();
    setConnected(false);
    setConnectionPresence("offline");
    setIsConnecting(false);
    setActiveCall(null);
    setHomeFleetInvite(null);
    if (disconnect.unrecoverable) {
      // A verified rejection/identity change cannot recover by retrying an old
      // bearer secret. Delete precisely that Keychain record; no QR secret was
      // ever stored, and another phone/laptop profile remains untouched.
      void forgetSavedBridgeSession().catch(() => undefined);
      clearPersistedRecoveryTimer();
      setPairingError("The saved laptop session expired or changed. Scan the bridge's current one-time code to reconnect.");
      if (wasPaired) append("system", "connection", "Laptop session changed. Scan the bridge's current terminal code to reconnect safely.");
    } else if (disconnect.kind === "resume-retry-exhausted") {
      // Keep the secure profile: an offline tunnel, captive portal, or laptop
      // sleep is not proof that the pairing has expired. Foreground/cold boot
      // will use the newest saved secret to try again.
      append("system", "connection", "Laptop link is temporarily unavailable. Omnibus will retry when the app returns to the foreground.");
      if (appIsActive.current && savedBridgeProfile.current) setPersistedRecoveryCycle(cycle => cycle + 1);
    } else if (wasPaired) {
      append("system", "connection", "Laptop link closed. Pair a new terminal code to continue.");
    } else {
      setPairingError("That pairing code was rejected or expired. Restart the bridge and scan its newly printed code.");
    }
  }, [append, clearPairingTimeout, clearPersistedRecoveryTimer, forgetSavedBridgeSession, stopHeartbeat]);

  const onCode = useCallback((value: string) => {
    try {
      const pairing = parsePairingPayload(value);
      // A valid scan is an explicit attempt to replace the live laptop. Keep
      // the old Keychain profile until this new bridge sends its verified
      // hello, so an accidentally scanned/expired QR does not erase recovery.
      manualPairingAttempted.current = true;
      restoreAttempted.current = true;
      resumeInFlight.current = false;
      persistedRecoveryAttempt.current = 0;
      clearPersistedRecoveryTimer();
      clearPairingTimeout();
      didHandshake.current = false;
      setPairingError(null);
      setIsConnecting(true);
      setConnected(false);
      setFleet(null);
      setFleetBusy(false);
      setHomeFleetInvite(null);
      didOfferFleetSetup.current = false;
      setConnectionPresence("connecting");
      setScannerVisible(false);
      connection.connect(pairing, onEvent, onDisconnect, persistBridgeSession);
      pairingTimeout.current = setTimeout(() => {
        if (didHandshake.current) return;
        connection.close();
        resumeInFlight.current = false;
        setIsConnecting(false);
        setConnectionPresence("offline");
        setPairingError("Pairing timed out. Restart the bridge and scan the new one-time code it prints.");
      }, 12_000);
    } catch (error) {
      setIsConnecting(false);
      setConnectionPresence("offline");
      setPairingError(error instanceof Error ? error.message : "Could not read the pairing code.");
    }
  }, [clearPairingTimeout, clearPersistedRecoveryTimer, connection, onDisconnect, onEvent, persistBridgeSession]);

  /** Start a fresh resume attempt without ever reconstructing the QR token. */
  const resumeSavedBridge = useCallback((): boolean => {
    const profile = savedBridgeProfile.current;
    if (!profile || !appIsActive.current || resumeInFlight.current) return false;
    clearPairingTimeout();
    stopHeartbeat();
    didHandshake.current = false;
    resumeInFlight.current = true;
    setConnected(false);
    setIsConnecting(true);
    setConnectionPresence("connecting");
    setPairingError(null);
    connection.resume(profile, onEvent, onDisconnect, persistBridgeSession);
    return true;
  }, [clearPairingTimeout, connection, onDisconnect, onEvent, persistBridgeSession, stopHeartbeat]);

  useEffect(() => {
    if (!bridgeProfileLoaded || !bridgeProfileReady.current || restoreAttempted.current || manualPairingAttempted.current) return;
    restoreAttempted.current = true;
    resumeSavedBridge();
  }, [bridgeProfileLoaded, resumeSavedBridge]);

  useEffect(() => {
    if (persistedRecoveryCycle === 0 || !appIsActive.current || !savedBridgeProfile.current || resumeInFlight.current) return;
    clearPersistedRecoveryTimer();
    const delay = PERSISTED_SESSION_RETRY_DELAYS_MS[Math.min(
      persistedRecoveryAttempt.current,
      PERSISTED_SESSION_RETRY_DELAYS_MS.length - 1,
    )];
    persistedRecoveryAttempt.current += 1;
    persistedRecoveryTimer.current = setTimeout(() => {
      persistedRecoveryTimer.current = null;
      resumeSavedBridge();
    }, delay);
    return clearPersistedRecoveryTimer;
  }, [clearPersistedRecoveryTimer, persistedRecoveryCycle, resumeSavedBridge]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", nextState => {
      if (nextState !== "active") return;
      // If the bridge exhausted its short foreground retry burst while the
      // phone was offline, an app return is the natural battery-conscious
      // moment to refresh the last securely paired laptop.
      if (bridgeProfileReady.current && !didHandshake.current && !resumeInFlight.current) {
        clearPersistedRecoveryTimer();
        resumeSavedBridge();
      }
    });
    return () => subscription.remove();
  }, [clearPersistedRecoveryTimer, resumeSavedBridge]);

  const finishSplash = useCallback(() => setSplashComplete(true), []);

  const ready = splashComplete && hasPairedBefore !== null;
  const showOnboarding = hasPairedBefore === false || setupVisible;

  return <SafeAreaView style={styles.safe}>
    {!ready ? <OmnibusSplash onComplete={finishSplash} /> : showOnboarding
      ? <PairingOnboarding
          onScan={() => { setPairingError(null); setScannerVisible(true); }}
          isConnecting={isConnecting}
          error={pairingError}
          appleProfile={localAppleProfile}
          onAppleSignedIn={rememberLocalAppleProfile}
          canReturnToWorkspace={hasPairedBefore === true}
          onReturnToWorkspace={() => setSetupVisible(false)}
        />
      : <OfficeDashboard
          connected={connected}
          connectionPresence={connectionPresence}
          usage={usage}
          messages={messages}
          pairingError={pairingError}
          fleet={fleet}
          hasLocalAppleProfile={localAppleProfile !== null}
          onOpenAccount={() => setSetupVisible(true)}
          onOpenFleet={() => {
            if (!connection.requestFleetSnapshot()) {
              append("system", "FLEET_OFFLINE", "Pair the laptop before changing its local model fleet.");
              setScannerVisible(true);
              return;
            }
            setFleetSetupVisible(true);
          }}
          onPair={() => { setPairingError(null); setScannerVisible(true); }}
          onCommand={(directive, mode: CommandMode, research: boolean, homeFleet: boolean) => {
            try {
              // Modes and web-research consent describe intent, not
              // credentials: providers and any host-execution policy remain
              // entirely on the paired laptop.
              return connection.command(directive, mode, research, homeFleet);
            } catch (error) {
              append("system", "COMMAND_FAILED", error instanceof Error ? error.message : "Unable to send this idea to your laptop.");
              return null;
            }
          }}
        />}
    {fleetSetupVisible ? <FleetSetupSheet
      snapshot={fleet}
      brain={brain}
      busy={fleetBusy || Boolean(fleet?.provisioning.active)}
      onDismiss={() => setFleetSetupVisible(false)}
      onRefresh={() => { connection.requestFleetSnapshot(); connection.requestBrainStatus(); }}
      onProvision={profileId => {
        try {
          setFleetBusy(true);
          connection.provisionFleet(profileId);
        } catch (error) {
          setFleetBusy(false);
          append("system", "FLEET_OPERATION_FAILED", error instanceof Error ? error.message : "Unable to prepare that local fleet.");
        }
      }}
      onConfigureResearch={(enabled, braveSearchApiKey) => {
        try {
          setFleetBusy(true);
          connection.configureResearch(enabled, braveSearchApiKey);
        } catch (error) {
          setFleetBusy(false);
          append("system", "RESEARCH_CONFIGURATION_FAILED", error instanceof Error ? error.message : "Unable to configure cited web research.");
        }
      }}
      homeFleetInvite={homeFleetInvite}
      onCreateHomeFleetInvite={() => {
        try {
          setFleetBusy(true);
          setHomeFleetInvite(null);
          connection.createHomeFleetInvite();
        } catch (error) {
          setFleetBusy(false);
          append("system", "HOME_FLEET_INVITE_FAILED", error instanceof Error ? error.message : "Unable to create a home-worker invitation.");
        }
      }}
      onRemoveHomeFleetWorker={workerId => {
        try {
          setFleetBusy(true);
          connection.removeHomeFleetWorker(workerId);
        } catch (error) {
          setFleetBusy(false);
          append("system", "HOME_FLEET_REMOVE_FAILED", error instanceof Error ? error.message : "Unable to remove that home worker.");
        }
      }}
      onApproveHomeFleetWorker={workerId => {
        try {
          setFleetBusy(true);
          connection.approveHomeFleetWorker(workerId);
        } catch (error) {
          setFleetBusy(false);
          append("system", "HOME_FLEET_APPROVE_FAILED", error instanceof Error ? error.message : "Unable to activate that home worker.");
        }
      }}
    /> : null}
    <QRScanner visible={scannerVisible} onCode={onCode} onClose={() => {
      setScannerVisible(false);
      if (isConnecting) {
        clearPairingTimeout();
        connection.close();
        setIsConnecting(false);
        setConnectionPresence("offline");
      }
    }} />
    {activeCall ? <CallSheet
      agent={activeCall.agent}
      title={activeCall.title}
      body={activeCall.body}
      onDismiss={() => setActiveCall(null)}
    /> : null}
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.void },
  recoverySafe: { flex: 1, backgroundColor: colors.void },
  recovery: { flex: 1, justifyContent: "center", padding: 30 },
  recoveryKicker: { color: colors.paperMuted, fontSize: 10, fontWeight: "900", letterSpacing: 1.5 },
  recoveryTitle: { color: colors.paper, fontSize: 29, fontWeight: "700", letterSpacing: -0.6, lineHeight: 35, marginTop: 13 },
  recoveryBody: { color: colors.paperMuted, fontSize: 16, lineHeight: 24, marginTop: 14 },
});
