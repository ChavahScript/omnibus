import * as AppleAuthentication from "expo-apple-authentication";
import * as Clipboard from "expo-clipboard";
import React, { useEffect, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withSpring } from "react-native-reanimated";
import Svg, { Path, Rect } from "react-native-svg";
import { LocalAppleProfile } from "../localData";
import { colors, springs } from "../theme";
import { VectorIcon } from "./VectorIcon";

/**
 * One complete copyable command per platform. The Windows variant runs the
 * same chain through `cmd /c`, matching the Home Fleet invite convention:
 * it works in both Windows PowerShell 5.1 (which has no `&&`) and PowerShell 7,
 * and resolves npm's .cmd shims without tripping the script-execution policy.
 */
const BRIDGE_COMMANDS = {
  mac: "npm install -g omnibus-bridge && omnibus-bridge setup --install-runtime --pull-models && omnibus-bridge start",
  windows: 'cmd /c "npm install -g omnibus-bridge && omnibus-bridge setup --install-runtime --pull-models && omnibus-bridge start"',
} as const;

type BridgeOS = keyof typeof BRIDGE_COMMANDS;

type PairingOnboardingProps = {
  onScan: () => void;
  isConnecting: boolean;
  error?: string | null;
  appleProfile: LocalAppleProfile | null;
  onAppleSignedIn: (profile: LocalAppleProfile) => void;
  canReturnToWorkspace: boolean;
  onReturnToWorkspace: () => void;
};

type PickupAgentSpec = {
  id: string;
  homeX: number;
  homeY: number;
  outwardX: number;
  outwardY: number;
  pocketX: number;
  pocketY: number;
  delay: number;
  size: number;
  opacity: number;
};

/*
 * The values form a readable little story rather than a generic loading
 * indicator: agents begin inside the phone, scatter into the room, then
 * converge into the screen as the phone sweeps through to collect them.
 * Different launch offsets keep the motion organic without any randomness,
 * which makes the same calm loop repeat reliably on-device.
 */
const PICKUP_AGENTS: readonly PickupAgentSpec[] = [
  { id: "research", homeX: 15, homeY: 18, outwardX: 102, outwardY: 10, pocketX: 79, pocketY: 59, delay: 40, size: 11, opacity: 1 },
  { id: "builder", homeX: 27, homeY: 20, outwardX: 73, outwardY: 3, pocketX: 91, pocketY: 63, delay: 115, size: 9, opacity: 0.86 },
  { id: "operator", homeX: 14, homeY: 33, outwardX: 111, outwardY: 51, pocketX: 80, pocketY: 77, delay: 185, size: 12, opacity: 0.94 },
  { id: "editor", homeX: 27, homeY: 39, outwardX: 49, outwardY: 98, pocketX: 94, pocketY: 82, delay: 250, size: 10, opacity: 0.78 },
  { id: "planner", homeX: 19, homeY: 48, outwardX: 19, outwardY: 88, pocketX: 85, pocketY: 94, delay: 315, size: 8, opacity: 0.68 },
];

/*
 * Every visible movement below is spring-driven. Delays only stage the story;
 * they never interpolate a visual value. The lighter agent spring gives the
 * dots a buoyant departure, while the heavier pickup spring lets the phone
 * feel like a physical object gathering a small team back into its screen.
 */
const BEACON_BOUNCE_SPRING = {
  damping: 12,
  mass: 0.42,
  stiffness: 210,
  restDisplacementThreshold: 0.001,
  restSpeedThreshold: 0.001,
};

const BEACON_PICKUP_SPRING = {
  damping: 17,
  mass: 0.9,
  stiffness: 138,
  restDisplacementThreshold: 0.001,
  restSpeedThreshold: 0.001,
};

const BEACON_RETURN_SPRING = {
  damping: 18,
  mass: 0.72,
  stiffness: 165,
  restDisplacementThreshold: 0.001,
  restSpeedThreshold: 0.001,
};

/**
 * The first-run working room makes the local architecture tangible: a living
 * beacon represents the laptop bridge, then the phone scans its one-time QR.
 * The copyable command is deliberately complete, so a fresh Mac can install,
 * pull its local models, and start the bridge without hunting through docs.
 */
export function PairingOnboarding({
  onScan,
  isConnecting,
  error,
  appleProfile,
  onAppleSignedIn,
  canReturnToWorkspace,
  onReturnToWorkspace,
}: PairingOnboardingProps): React.JSX.Element {
  const lift = useSharedValue(22);
  const opacity = useSharedValue(0);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [bridgeOS, setBridgeOS] = useState<BridgeOS>("mac");
  const [appleAvailability, setAppleAvailability] = useState<"checking" | "available" | "unavailable">("checking");
  const [appleBusy, setAppleBusy] = useState(false);
  const [appleNotice, setAppleNotice] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    lift.value = withSpring(0, springs.entrance);
    opacity.value = withSpring(1, springs.entrance);
  }, [lift, opacity]);

  useEffect(() => {
    let active = true;
    if (Platform.OS !== "ios") {
      setAppleAvailability("unavailable");
      return () => { active = false; };
    }
    void AppleAuthentication.isAvailableAsync()
      .then(available => { if (active) setAppleAvailability(available ? "available" : "unavailable"); })
      .catch(() => { if (active) setAppleAvailability("unavailable"); });
    return () => { active = false; };
  }, []);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  const contentStyle = useAnimatedStyle(() => ({ opacity: opacity.value, transform: [{ translateY: lift.value }] }));

  const copyBridgeCommand = async () => {
    try {
      await Clipboard.setStringAsync(BRIDGE_COMMANDS[bridgeOS]);
      setCopyFailed(false);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1_900);
    } catch {
      setCopyFailed(true);
    }
  };

  const signInWithApple = async () => {
    if (appleBusy || appleAvailability !== "available") return;
    setAppleBusy(true);
    setAppleNotice(null);
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      const displayName = formatDisplayName(credential.fullName);
      onAppleSignedIn({
        appleUserId: credential.user,
        displayName,
        createdAt: appleProfile?.createdAt ?? new Date().toISOString(),
      });
      // Apple only returns name/email the first time. The stable user subject
      // is safely stored locally by App; tokens and email are intentionally
      // discarded because no account server exists to verify or use them.
      setAppleNotice(displayName ? `Local Apple profile ready for ${displayName}.` : "Local Apple profile is ready on this iPhone.");
    } catch (signInError) {
      if (!isAppleCancellation(signInError)) setAppleNotice("Apple sign-in could not finish. Try again on this signed-in iPhone.");
    } finally {
      setAppleBusy(false);
    }
  };

  return <View style={styles.root}>
    <View style={styles.grid} pointerEvents="none"><View style={styles.hairline} /><View style={styles.hairline} /></View>
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false} bounces={false}>
      <Animated.View style={[styles.content, contentStyle]}>
        <PairingBeacon />
        <Text style={styles.eyebrow}>OMNIBUS / LOCAL WORKING ROOM</Text>
        <Text style={styles.title}>Your group lives on your laptop.{"\n"}This is its quiet front door.</Text>
        <Text style={styles.body}>Install the bridge on any Mac or Windows laptop, let it prepare the local team, then scan its one-time pairing code. The phone stays a calm companion to the models and tools you choose on your laptop.</Text>

        <View style={styles.osToggle} accessibilityRole="tablist">
          {(["mac", "windows"] as const).map(os => (
            <Pressable
              key={os}
              onPress={() => { setBridgeOS(os); setCopied(false); setCopyFailed(false); }}
              style={[styles.osTab, bridgeOS === os && styles.osTabActive]}
              accessibilityRole="tab"
              accessibilityState={{ selected: bridgeOS === os }}
              accessibilityLabel={os === "mac" ? "Show macOS bridge command" : "Show Windows bridge command"}
            >
              <Text style={[styles.osTabText, bridgeOS === os && styles.osTabTextActive]}>{os === "mac" ? "MACOS" : "WINDOWS"}</Text>
            </Pressable>
          ))}
        </View>

        <Pressable
          onPress={() => { void copyBridgeCommand(); }}
          style={({ pressed }) => [styles.commandCard, pressed && styles.commandCardPressed]}
          accessibilityRole="button"
          accessibilityLabel={bridgeOS === "mac" ? "Copy macOS bridge install and setup command" : "Copy Windows bridge install and setup command"}
        >
          <View style={styles.commandTextWrap}>
            <Text style={styles.commandEyebrow}>{bridgeOS === "mac" ? "MAC BRIDGE / INSTALL + START" : "WINDOWS BRIDGE / INSTALL + START"}</Text>
            <Text selectable style={styles.command}>{BRIDGE_COMMANDS[bridgeOS]}</Text>
          </View>
          <View style={styles.commandAction}>
            <VectorIcon name="copy" size={16} color={colors.ink} />
            <Text style={styles.commandActionText}>{copied ? "COPIED" : copyFailed ? "RETRY" : "COPY"}</Text>
          </View>
        </Pressable>

        <View style={styles.steps}>
          <Step number="01" text={bridgeOS === "mac" ? "Copy the setup command, then run it in Terminal" : "Copy the setup command, then run it in PowerShell"} />
          <Step number="02" text="Scan the terminal QR code with this phone" />
          <Step number="03" text="Shape an idea with your local working group" />
        </View>

        <View style={styles.accountCard}>
          <Text style={styles.accountEyebrow}>OPTIONAL LOCAL PROFILE</Text>
          <Text style={styles.accountTitle}>Sign in with Apple</Text>
          <Text style={styles.accountBody}>This creates a Keychain-backed profile and keeps your submitted idea/report history on this iPhone. Apple credentials stay on-device; cloud sync is not enabled in this build.</Text>
          {appleAvailability === "available" ? <View style={[styles.appleButtonWrap, appleBusy && styles.appleButtonBusy]} pointerEvents={appleBusy ? "none" : "auto"}>
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
              buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
              cornerRadius={15}
              style={styles.appleButton}
              onPress={() => { void signInWithApple(); }}
            />
          </View> : <Text style={styles.appleUnavailable}>{appleAvailability === "checking" ? "Checking Apple sign-in…" : "Apple sign-in is available in the signed iPhone TestFlight build."}</Text>}
          {appleProfile ? <Text style={styles.accountStatus}>LOCAL APPLE PROFILE READY</Text> : null}
          {appleNotice ? <Text style={styles.accountNotice}>{appleNotice}</Text> : null}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable onPress={onScan} disabled={isConnecting} style={({ pressed }) => [styles.scan, pressed && styles.scanPressed, isConnecting && styles.scanDisabled]} accessibilityRole="button" accessibilityLabel="Scan laptop pairing code">
          <VectorIcon name="scan" size={19} color={colors.ink} />
          <Text style={styles.scanText}>{isConnecting ? "CONNECTING…" : "SCAN PAIRING CODE"}</Text>
        </Pressable>
        {canReturnToWorkspace ? <Pressable onPress={onReturnToWorkspace} style={styles.returnToWorkspace} accessibilityRole="button" accessibilityLabel="Return to ideation workspace"><Text style={styles.returnToWorkspaceText}>RETURN TO IDEATION</Text></Pressable> : null}
        <Text style={styles.footnote}>The app never stores your laptop’s provider keys. Local profiles and idea history do not become cloud accounts.</Text>
      </Animated.View>
    </ScrollView>
  </View>;
}

function PairingBeacon(): React.JSX.Element {
  const phoneX = useSharedValue(4);
  const phoneY = useSharedValue(7);
  const phoneTilt = useSharedValue(0);
  const phoneScale = useSharedValue(1);

  useEffect(() => {
    phoneX.value = withRepeat(withSequence(
      withDelay(720, withSpring(68, BEACON_PICKUP_SPRING)),
      withDelay(260, withSpring(4, BEACON_RETURN_SPRING)),
      withDelay(520, withSpring(4, BEACON_RETURN_SPRING)),
    ), -1, false);
    phoneY.value = withRepeat(withSequence(
      withDelay(720, withSpring(44, BEACON_PICKUP_SPRING)),
      withDelay(260, withSpring(7, BEACON_RETURN_SPRING)),
      withDelay(520, withSpring(7, BEACON_RETURN_SPRING)),
    ), -1, false);
    phoneTilt.value = withRepeat(withSequence(
      withDelay(720, withSpring(14, BEACON_PICKUP_SPRING)),
      withDelay(260, withSpring(0, BEACON_RETURN_SPRING)),
      withDelay(520, withSpring(0, BEACON_RETURN_SPRING)),
    ), -1, false);
    phoneScale.value = withRepeat(withSequence(
      withDelay(720, withSpring(1.06, BEACON_PICKUP_SPRING)),
      withDelay(260, withSpring(1, BEACON_RETURN_SPRING)),
      withDelay(520, withSpring(1, BEACON_RETURN_SPRING)),
    ), -1, false);
  }, [phoneScale, phoneTilt, phoneX, phoneY]);

  const phoneStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: phoneX.value },
      { translateY: phoneY.value },
      { rotate: `${phoneTilt.value}deg` },
      { scale: phoneScale.value },
    ],
  }));

  return <View style={styles.beacon} pointerEvents="none" accessibilityElementsHidden>
    <Animated.View style={[styles.beaconPhone, phoneStyle]}>
      <BeaconPhone />
    </Animated.View>
    {PICKUP_AGENTS.map(agent => <PickupAgent key={agent.id} agent={agent} />)}
  </View>;
}

function PickupAgent({ agent }: { agent: PickupAgentSpec }): React.JSX.Element {
  const x = useSharedValue(agent.homeX);
  const y = useSharedValue(agent.homeY);
  const scale = useSharedValue(1);

  useEffect(() => {
    x.value = withRepeat(withSequence(
      withDelay(agent.delay, withSpring(agent.outwardX, BEACON_BOUNCE_SPRING)),
      withDelay(380, withSpring(agent.pocketX, BEACON_PICKUP_SPRING)),
      withDelay(150, withSpring(agent.homeX, BEACON_RETURN_SPRING)),
      withDelay(520, withSpring(agent.homeX, BEACON_RETURN_SPRING)),
    ), -1, false);
    y.value = withRepeat(withSequence(
      withDelay(agent.delay, withSpring(agent.outwardY, BEACON_BOUNCE_SPRING)),
      withDelay(380, withSpring(agent.pocketY, BEACON_PICKUP_SPRING)),
      withDelay(150, withSpring(agent.homeY, BEACON_RETURN_SPRING)),
      withDelay(520, withSpring(agent.homeY, BEACON_RETURN_SPRING)),
    ), -1, false);
    scale.value = withRepeat(withSequence(
      withDelay(agent.delay, withSpring(1.22, BEACON_BOUNCE_SPRING)),
      withSpring(1, BEACON_BOUNCE_SPRING),
      withDelay(380, withSpring(0.76, BEACON_PICKUP_SPRING)),
      withDelay(150, withSpring(1, BEACON_RETURN_SPRING)),
      withDelay(520, withSpring(1, BEACON_RETURN_SPRING)),
    ), -1, false);
  }, [agent, scale, x, y]);

  const agentStyle = useAnimatedStyle(() => ({
    opacity: agent.opacity,
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }],
  }));

  return <Animated.View style={[styles.beaconAgent, { width: agent.size, height: agent.size, borderRadius: agent.size / 2 }, agentStyle]} />;
}

function BeaconPhone(): React.JSX.Element {
  return <Svg width={42} height={66} viewBox="0 0 42 66" fill="none" accessibilityElementsHidden>
    <Rect x={1.5} y={1.5} width={39} height={63} rx={10} fill={colors.paper} />
    <Rect x={5.5} y={7.5} width={31} height={44} rx={5.5} fill={colors.ink} />
    <Path d="M17 4.8H25" stroke={colors.ink} strokeWidth={2.2} strokeLinecap="round" />
    <Path d="M18 58.7H24" stroke={colors.ink} strokeWidth={2.2} strokeLinecap="round" />
  </Svg>;
}

function Step({ number, text }: { number: string; text: string }): React.JSX.Element {
  return <View style={styles.step}><Text style={styles.number}>{number}</Text><Text style={styles.stepText}>{text}</Text></View>;
}

function formatDisplayName(fullName: AppleAuthentication.AppleAuthenticationFullName | null): string | null {
  if (!fullName) return null;
  const name = [fullName.givenName, fullName.familyName].filter((part): part is string => typeof part === "string" && Boolean(part.trim())).join(" ").trim();
  return name || null;
}

function isAppleCancellation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ERR_REQUEST_CANCELED";
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.void },
  grid: { ...StyleSheet.absoluteFillObject, paddingTop: 72, paddingHorizontal: 28, gap: 92, opacity: 0.28 },
  hairline: { height: 1, backgroundColor: colors.line },
  scroll: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 27, paddingVertical: 38 },
  content: { maxWidth: 460, alignSelf: "center", width: "100%" },
  beacon: { width: 132, height: 120, marginBottom: 28, position: "relative" },
  beaconPhone: { position: "absolute", left: 0, top: 0, width: 42, height: 66, zIndex: 2 },
  beaconAgent: { position: "absolute", left: 0, top: 0, backgroundColor: colors.paper, borderWidth: 1.5, borderColor: colors.ink, zIndex: 3 },
  eyebrow: { color: colors.paperMuted, fontSize: 10, letterSpacing: 1.65, fontWeight: "800" },
  title: { color: colors.paper, fontSize: 31, fontWeight: "700", lineHeight: 38, letterSpacing: -0.75, marginTop: 13 },
  body: { color: colors.paperMuted, fontSize: 15, lineHeight: 23, marginTop: 18, maxWidth: 420 },
  osToggle: { marginTop: 25, flexDirection: "row", gap: 8 },
  osTab: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 11, borderWidth: 1, borderColor: colors.line },
  osTabActive: { backgroundColor: colors.paper, borderColor: colors.paper },
  osTabText: { color: colors.paperMuted, fontSize: 9, letterSpacing: 1.2, fontWeight: "900" },
  osTabTextActive: { color: colors.ink },
  commandCard: { marginTop: 12, padding: 15, gap: 13, flexDirection: "row", alignItems: "center", borderRadius: 18, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surfaceRaised },
  commandCardPressed: { opacity: 0.76, transform: [{ scale: 0.992 }] },
  commandTextWrap: { flex: 1, minWidth: 0 },
  commandEyebrow: { color: colors.paperMuted, fontSize: 9, letterSpacing: 1.2, fontWeight: "900" },
  command: { color: colors.paper, fontSize: 11, lineHeight: 17, marginTop: 7, fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }) },
  commandAction: { minWidth: 56, minHeight: 46, paddingHorizontal: 9, gap: 4, alignItems: "center", justifyContent: "center", borderRadius: 13, backgroundColor: colors.paper },
  commandActionText: { color: colors.ink, fontSize: 9, letterSpacing: 0.85, fontWeight: "900" },
  steps: { marginTop: 30, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  step: { flexDirection: "row", gap: 15, paddingVertical: 15, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  number: { color: colors.paperMuted, fontSize: 10, lineHeight: 18, letterSpacing: 1.2, fontWeight: "800" },
  stepText: { color: colors.paper, fontSize: 14, lineHeight: 19, flex: 1 },
  accountCard: { marginTop: 29, padding: 17, borderRadius: 20, borderWidth: 1, borderColor: colors.line, backgroundColor: "rgba(20,20,21,.84)" },
  accountEyebrow: { color: colors.paperMuted, fontSize: 9, letterSpacing: 1.3, fontWeight: "900" },
  accountTitle: { color: colors.paper, fontSize: 19, lineHeight: 24, fontWeight: "700", letterSpacing: -0.25, marginTop: 7 },
  accountBody: { color: colors.paperMuted, fontSize: 12, lineHeight: 18, marginTop: 8 },
  appleButtonWrap: { height: 50, marginTop: 16 },
  appleButtonBusy: { opacity: 0.58 },
  appleButton: { width: "100%", height: 50 },
  appleUnavailable: { color: colors.paperMuted, fontSize: 12, lineHeight: 18, marginTop: 15 },
  accountStatus: { color: colors.paper, fontSize: 9, letterSpacing: 1.05, fontWeight: "900", marginTop: 13 },
  accountNotice: { color: colors.paperMuted, fontSize: 12, lineHeight: 17, marginTop: 9 },
  error: { color: colors.paper, fontSize: 13, lineHeight: 19, marginTop: 18, padding: 12, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surfaceRaised },
  scan: { minHeight: 56, marginTop: 25, paddingHorizontal: 18, borderRadius: 17, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 10, backgroundColor: colors.paper },
  scanPressed: { transform: [{ scale: 0.98 }] },
  scanDisabled: { opacity: 0.55 },
  scanText: { color: colors.ink, fontSize: 12, letterSpacing: 1.05, fontWeight: "900" },
  returnToWorkspace: { alignSelf: "center", marginTop: 17, borderBottomWidth: 1, borderBottomColor: colors.lineStrong },
  returnToWorkspaceText: { color: colors.paper, fontSize: 10, letterSpacing: 1.05, fontWeight: "900", paddingBottom: 6 },
  footnote: { color: colors.paperMuted, textAlign: "center", fontSize: 11, lineHeight: 16, marginTop: 16 },
});
