import React, { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { AgentAvatar } from "./AgentAvatar";
import { VectorIcon } from "./VectorIcon";
import { playOfficeHaptic } from "../haptics";
import { colors, springs } from "../theme";
import type { AgentName } from "../types";

export function CallSheet({ agent, title, body, onDismiss }: { agent: AgentName; title: string; body: string; onDismiss: () => void }): React.JSX.Element {
  const lift = useSharedValue(80);
  const opacity = useSharedValue(0);
  useEffect(() => {
    lift.value = withSpring(0, springs.callSheet);
    opacity.value = withSpring(1, springs.callSheet);
    playOfficeHaptic("RotaryRumble", 900);
  }, [lift, opacity]);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ translateY: lift.value }], opacity: opacity.value }));
  return <View style={styles.scrim}>
    <Animated.View style={[styles.sheet, animatedStyle]}>
      <View style={styles.callBadge}><VectorIcon name="phone" size={19} color={colors.ink} /></View>
      <AgentAvatar agent={agent} size={86} />
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.agent}>{agent.toUpperCase()} LINE</Text>
      <Text style={styles.body}>{body}</Text>
      <Pressable onPress={() => { playOfficeHaptic("HeavySwitch"); onDismiss(); }} style={styles.hangup} accessibilityRole="button" accessibilityLabel="Hide work call">
        <VectorIcon name="close" size={19} color={colors.ink} />
        <Text style={styles.hangupText}>HIDE CALL</Text>
      </Pressable>
    </Animated.View>
  </View>;
}

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFillObject, zIndex: 30, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,.74)" },
  sheet: { minHeight: 420, borderTopLeftRadius: 32, borderTopRightRadius: 32, alignItems: "center", padding: 28, backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.lineStrong },
  callBadge: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center", backgroundColor: colors.paper, marginBottom: 18 },
  title: { color: colors.paper, fontSize: 28, letterSpacing: -0.5, fontWeight: "700", marginTop: 18, textAlign: "center" },
  agent: { color: colors.paperMuted, fontSize: 10, letterSpacing: 1.7, fontWeight: "900", marginTop: 7 },
  body: { color: colors.paperMuted, fontSize: 15, lineHeight: 22, marginTop: 24, textAlign: "center", maxWidth: 390 },
  hangup: { minWidth: 126, minHeight: 48, paddingHorizontal: 17, gap: 8, borderRadius: 15, alignItems: "center", justifyContent: "center", flexDirection: "row", backgroundColor: colors.paper, marginTop: 30 },
  hangupText: { color: colors.ink, fontSize: 10, letterSpacing: 1, fontWeight: "900" },
});
