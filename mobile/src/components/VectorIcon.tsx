import React from "react";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { colors } from "../theme";

export function VectorIcon({ name, size = 22, color = colors.paper }: { name: "scan" | "send" | "phone" | "bolt" | "copy" | "person" | "history" | "close" | "research"; size?: number; color?: string }): React.JSX.Element {
  if (name === "scan") return <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" stroke={color} strokeWidth={2} fill="none" strokeLinecap="round" /><Rect x={8} y={9} width={8} height={6} rx={1} stroke={color} strokeWidth={1.6} fill="none" /></Svg>;
  if (name === "send") return <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M3 11.5 21 3l-6.4 18-3.1-7.2L3 11.5Z" stroke={color} strokeWidth={1.8} strokeLinejoin="round" fill="none" /><Path d="m11.4 13.8 4.8-5.1" stroke={color} strokeWidth={1.8} strokeLinecap="round" /></Svg>;
  if (name === "phone") return <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M6.4 3.6 9 3l2.1 4.8-1.8 1.7c1.1 2.3 2.8 4 5.1 5.1l1.7-1.8L21 15l-.6 2.6c-.3 1.3-1.5 2.2-2.9 2.1C9.7 19.2 4.8 14.3 4.3 6.5c-.1-1.4.8-2.6 2.1-2.9Z" stroke={color} strokeWidth={1.8} fill="none" strokeLinejoin="round" /></Svg>;
  if (name === "copy") return <Svg width={size} height={size} viewBox="0 0 24 24"><Rect x={8} y={4} width={11} height={13} rx={2} stroke={color} strokeWidth={1.8} fill="none" /><Path d="M5 8v10c0 1.1.9 2 2 2h8" stroke={color} strokeWidth={1.8} fill="none" strokeLinecap="round" /></Svg>;
  if (name === "person") return <Svg width={size} height={size} viewBox="0 0 24 24"><Circle cx={12} cy={8.1} r={3.4} stroke={color} strokeWidth={1.7} fill="none" /><Path d="M5.2 20c.7-3.4 3.1-5.3 6.8-5.3s6.1 1.9 6.8 5.3" stroke={color} strokeWidth={1.7} strokeLinecap="round" fill="none" /></Svg>;
  if (name === "history") return <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M4.3 11.6A7.8 7.8 0 1 0 6.8 6" stroke={color} strokeWidth={1.8} fill="none" strokeLinecap="round" /><Path d="M4.2 4.8v4.5h4.5M12 7.7v4.8l3.2 2" stroke={color} strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" /></Svg>;
  if (name === "research") return <Svg width={size} height={size} viewBox="0 0 24 24"><Circle cx={10.4} cy={10.4} r={5.7} stroke={color} strokeWidth={1.7} fill="none" /><Path d="m14.6 14.6 4.8 4.8M7.1 10.4h6.6M10.4 7.1V13.7" stroke={color} strokeWidth={1.7} strokeLinecap="round" /></Svg>;
  if (name === "close") return <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="m6 6 12 12M18 6 6 18" stroke={color} strokeWidth={1.8} fill="none" strokeLinecap="round" /></Svg>;
  return <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="m13.4 2-8 11.3h5.3L10.6 22l8-11.4h-5.2L13.4 2Z" fill={color} /><Circle cx={12} cy={12} r={10.2} stroke={color} strokeWidth={1.1} fill="none" /></Svg>;
}
