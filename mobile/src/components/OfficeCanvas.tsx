import React from "react";
import { StyleSheet, useWindowDimensions } from "react-native";
import { Canvas, Circle, Group, Line, Path, Rect, RoundedRect, Shadow, vec } from "@shopify/react-native-skia";
import { colors } from "../theme";

/** Skia has one Shadow primitive; these named wrappers make outer/inner intent explicit. */
function DropShadow({ dx, dy, blur, color }: { dx: number; dy: number; blur: number; color: string }): React.JSX.Element {
  return <Shadow dx={dx} dy={dy} blur={blur} color={color} />;
}
function InnerShadow({ dx, dy, blur, color }: { dx: number; dy: number; blur: number; color: string }): React.JSX.Element {
  return <Shadow inner dx={dx} dy={dy} blur={blur} color={color} />;
}

export function OfficeCanvas(): React.JSX.Element {
  const { width, height } = useWindowDimensions();
  const dial = Math.min(width * 0.31, 140);
  return <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
    <Rect x={0} y={0} width={width} height={height} color={colors.ink}>
      <DropShadow dx={0} dy={12} blur={28} color="rgba(0,0,0,.9)" />
    </Rect>
    <RoundedRect x={14} y={52} width={width - 28} height={height - 82} r={30} color={colors.leather}>
      <InnerShadow dx={0} dy={5} blur={14} color="rgba(0,0,0,.82)" />
      <DropShadow dx={0} dy={9} blur={17} color="rgba(0,0,0,.5)" />
    </RoundedRect>
    <Group transform={[{ translateX: width - dial - 28 }, { translateY: 78 }]}>
      <Circle cx={dial / 2} cy={dial / 2} r={dial / 2} color={colors.brassDark}><DropShadow dx={4} dy={6} blur={7} color="rgba(0,0,0,.75)" /></Circle>
      <Circle cx={dial / 2} cy={dial / 2} r={dial * .39} color={colors.brass}><InnerShadow dx={2} dy={3} blur={4} color="rgba(0,0,0,.6)" /></Circle>
      <Circle cx={dial / 2} cy={dial / 2} r={dial * .25} color={colors.ink} />
      {Array.from({ length: 10 }, (_, index) => {
        const angle = (Math.PI * 2 * index) / 10 - Math.PI / 2;
        const start = vec(dial / 2 + Math.cos(angle) * dial * .34, dial / 2 + Math.sin(angle) * dial * .34);
        const end = vec(dial / 2 + Math.cos(angle) * dial * .42, dial / 2 + Math.sin(angle) * dial * .42);
        return <Line key={index} p1={start} p2={end} color={colors.paper} strokeWidth={2} />;
      })}
      <Path path="M58 32 L66 66 L52 66 Z" color={colors.red} />
    </Group>
  </Canvas>;
}
