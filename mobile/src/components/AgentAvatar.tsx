import React from "react";
import { View } from "react-native";
import { SvgUri } from "react-native-svg";
import type { AgentName } from "../types";

const seed: Record<AgentName, string> = { developer: "gearwright", auditor: "ledgerowl", marketing: "pressroom", system: "switchboard" };

export function AgentAvatar({ agent, size = 40 }: { agent: AgentName; size?: number }): React.JSX.Element {
  const uri = `https://api.dicebear.com/9.x/bottts/svg?seed=${encodeURIComponent(seed[agent])}&backgroundType=transparent`;
  return <View style={{ width: size, height: size, borderRadius: size / 2, overflow: "hidden" }}><SvgUri uri={uri} width={size} height={size} /></View>;
}
