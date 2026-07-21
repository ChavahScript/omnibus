import React from "react";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { colors } from "../theme";

/**
 * A small phone holding a team.  This is the only product mark used in the
 * client: it remains legible at favicon/app-icon scale and needs no emoji or
 * third-party illustration asset.
 */
export function OmnibusMark({ size = 44, inverted = false }: { size?: number; inverted?: boolean }): React.JSX.Element {
  const foreground = inverted ? colors.ink : colors.paper;
  const background = inverted ? colors.paper : colors.ink;
  return <Svg width={size} height={size} viewBox="0 0 64 64" accessibilityLabel="Omnibus mark">
    <Rect x={16} y={9} width={32} height={46} rx={8} fill={background} stroke={foreground} strokeWidth={2.4} />
    <Rect x={20} y={15} width={24} height={31} rx={4} fill="none" stroke={foreground} strokeWidth={2} opacity={0.72} />
    <Path d="M28 50h8" stroke={foreground} strokeWidth={2.4} strokeLinecap="round" />
    <Circle cx={17} cy={18} r={5.6} fill={foreground} />
    <Circle cx={47} cy={20} r={5.6} fill={foreground} />
    <Circle cx={16} cy={37} r={5.6} fill={foreground} />
    <Circle cx={47} cy={39} r={5.6} fill={foreground} />
    <Circle cx={32} cy={13} r={4.5} fill={foreground} />
  </Svg>;
}
