import React, { useEffect, useMemo } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { BlurMask, Canvas, Circle, Group, Line, RoundedRect, vec } from "@shopify/react-native-skia";
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withSequence, withSpring, withTiming } from "react-native-reanimated";
import { colors, springs } from "../theme";
import type { BrainStatus } from "../types";

type AtmosphereProps = { active?: boolean; settled?: boolean; compact?: boolean; brain?: BrainStatus | null; recallPulse?: number };

type ParticleSeed = {
  id: string;
  x: number;
  y: number;
  settleX: number;
  settleY: number;
  driftX: number;
  driftY: number;
  size: number;
};

const IDEA_PARTICLES: ParticleSeed[] = [
  { id: "northwest", x: 0.12, y: 0.19, settleX: -0.23, settleY: -0.17, driftX: 13, driftY: 8, size: 16 },
  { id: "north", x: 0.45, y: 0.09, settleX: -0.04, settleY: -0.25, driftX: -11, driftY: 12, size: 11 },
  { id: "northeast", x: 0.82, y: 0.22, settleX: 0.22, settleY: -0.13, driftX: 12, driftY: -9, size: 17 },
  { id: "west", x: 0.08, y: 0.57, settleX: -0.26, settleY: 0.02, driftX: 14, driftY: -10, size: 12 },
  { id: "east", x: 0.89, y: 0.54, settleX: 0.25, settleY: 0.03, driftX: -13, driftY: 11, size: 14 },
  { id: "southwest", x: 0.2, y: 0.86, settleX: -0.16, settleY: 0.22, driftX: 10, driftY: 8, size: 16 },
  { id: "south", x: 0.51, y: 0.93, settleX: 0.03, settleY: 0.27, driftX: -9, driftY: -12, size: 10 },
  { id: "southeast", x: 0.77, y: 0.82, settleX: 0.19, settleY: 0.17, driftX: 12, driftY: -8, size: 13 },
];

/**
 * The visual model for an idea: translucent Skia-rendered particles circulate
 * while the local review runs, then travel into a crisp shared center once a
 * brief is ready. Reanimated owns every movement on the UI thread, leaving
 * the JS thread free for typing and receiving bridge events.
 */
export function IdeaAtmosphere({ active = false, settled = false, compact = false, brain = null, recallPulse = 0 }: AtmosphereProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  const height = compact ? 142 : 280;
  const firstDrift = useSharedValue(-18);
  const secondDrift = useSharedValue(16);
  const density = useSharedValue(active ? 1 : 0.56);
  const centralScale = useSharedValue(settled ? 1 : 0.82);

  useEffect(() => {
    firstDrift.value = withRepeat(withSpring(18, springs.mist), -1, true);
    secondDrift.value = withRepeat(withSpring(-16, springs.mist), -1, true);
  }, [firstDrift, secondDrift]);

  useEffect(() => {
    density.value = withSpring(active ? 1 : settled ? 0.82 : 0.56, springs.entrance);
    centralScale.value = withSpring(settled ? 1 : 0.82, springs.entrance);
  }, [active, centralScale, density, settled]);

  const firstStyle = useAnimatedStyle(() => ({ opacity: density.value, transform: [{ translateX: firstDrift.value }] }));
  const secondStyle = useAnimatedStyle(() => ({ opacity: density.value * 0.72, transform: [{ translateX: secondDrift.value }] }));
  const centralStyle = useAnimatedStyle(() => ({ opacity: density.value, transform: [{ scale: centralScale.value }] }));
  const canvasWidth = Math.max(width, 320);
  const visibleParticles = compact ? IDEA_PARTICLES.slice(0, 5) : IDEA_PARTICLES;

  return <View pointerEvents="none" style={[styles.root, { height }]}>
    {brain?.enabled && !compact ? <BrainConstellation
      width={canvasWidth}
      height={height}
      facts={brain.facts}
      nodes={brain.nodes}
      active={active}
      recallPulse={recallPulse}
    /> : null}
    <Animated.View style={[styles.layer, firstStyle]}>
      <MistCanvas width={canvasWidth} height={height} variant="left" />
    </Animated.View>
    <Animated.View style={[styles.layer, secondStyle]}>
      <MistCanvas width={canvasWidth} height={height} variant="right" />
    </Animated.View>
    <Animated.View style={[styles.layer, centralStyle]}>
      <MistCanvas width={canvasWidth} height={height} variant={settled ? "settled" : "core"} />
    </Animated.View>
    {visibleParticles.map(seed => <IdeaParticle
      key={seed.id}
      active={active}
      settled={settled}
      size={seed.size}
      originX={canvasWidth * seed.x}
      originY={height * seed.y}
      targetX={canvasWidth / 2 + height * seed.settleX}
      targetY={height / 2 + height * seed.settleY}
      driftX={seed.driftX}
      driftY={seed.driftY}
    />)}
  </View>;
}

function IdeaParticle({
  active,
  settled,
  size,
  originX,
  originY,
  targetX,
  targetY,
  driftX,
  driftY,
}: {
  active: boolean;
  settled: boolean;
  size: number;
  originX: number;
  originY: number;
  targetX: number;
  targetY: number;
  driftX: number;
  driftY: number;
}): React.JSX.Element {
  const x = useSharedValue(originX);
  const y = useSharedValue(originY);
  const opacity = useSharedValue(active ? 0.88 : 0.42);
  const scale = useSharedValue(active ? 1 : 0.75);

  useEffect(() => {
    if (settled) {
      x.value = withSpring(targetX, springs.entrance);
      y.value = withSpring(targetY, springs.entrance);
      opacity.value = withSpring(0.86, springs.entrance);
      scale.value = withSpring(0.72, springs.entrance);
      return;
    }
    x.value = withRepeat(withSpring(originX + driftX, springs.mist), -1, true);
    y.value = withRepeat(withSpring(originY + driftY, springs.mist), -1, true);
    opacity.value = withSpring(active ? 0.92 : 0.44, springs.entrance);
    scale.value = withSpring(active ? 1 : 0.75, springs.entrance);
  }, [active, driftX, driftY, opacity, originX, originY, scale, settled, targetX, targetY, x, y]);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateX: x.value - size / 2 }, { translateY: y.value - size / 2 }, { scale: scale.value }],
  }));
  return <Animated.View style={[styles.particle, { width: size, height: size }, style]}>
    <Canvas style={StyleSheet.absoluteFill}>
      <Circle cx={size / 2} cy={size / 2} r={size / 2.8} color={colors.mistBright}><BlurMask blur={size / 2.4} style="normal" /></Circle>
    </Canvas>
  </Animated.View>;
}

type ConstellationNode = { x: number; y: number; r: number };
type ConstellationEdge = { a: number; b: number };

/**
 * An ambient picture of the laptop's Second Brain: a small knowledge graph
 * whose node count grows with the real fact/node totals, rendered in the same
 * faint monochrome Skia language as the mist. It breathes quietly in the
 * background; when the Auditor reports a recall — the brain connecting this
 * idea to past project memory — a wave of brightness ripples through it.
 * Deliberately abstract: it depicts that a memory exists and is being used,
 * never any fact content (which never leaves the laptop anyway).
 */
function BrainConstellation({ width, height, facts, nodes, active, recallPulse }: {
  width: number;
  height: number;
  facts: number;
  nodes: number;
  active: boolean;
  recallPulse: number;
}): React.JSX.Element {
  // Node count scales with real knowledge but stays bounded for calm and perf.
  const count = Math.max(5, Math.min(16, 4 + Math.round(Math.sqrt(Math.max(facts, nodes)))));
  const layout = useMemo<{ nodes: ConstellationNode[]; edges: ConstellationEdge[] }>(() => {
    const cx = width / 2;
    const cy = height * 0.46;
    const maxR = height * 0.4;
    const placed: ConstellationNode[] = [];
    for (let i = 0; i < count; i += 1) {
      // Golden-angle spiral gives an organic, non-gridded spread; the ×N hash
      // adds a deterministic jitter so it never looks mechanical yet is stable.
      const angle = i * 2.399963;
      const radius = maxR * Math.sqrt((i + 0.6) / count);
      const jitter = ((i * 928371) % 17) / 17 - 0.5;
      placed.push({
        x: cx + Math.cos(angle + jitter) * radius,
        y: cy + Math.sin(angle + jitter) * radius * 0.82,
        r: 1.6 + ((i * 7) % 5) * 0.5,
      });
    }
    const edges: ConstellationEdge[] = [];
    for (let i = 1; i < count; i += 1) {
      edges.push({ a: i, b: i - 1 });
      if (i >= 3 && i % 2 === 0) edges.push({ a: i, b: i - 3 });
    }
    return { nodes: placed, edges };
  }, [count, width, height]);

  const drift = useSharedValue(0);
  const wave = useSharedValue(0);
  const presence = useSharedValue(0);

  useEffect(() => {
    drift.value = withRepeat(withSequence(withTiming(1, { duration: 5200 }), withTiming(0, { duration: 5200 })), -1, false);
  }, [drift]);
  useEffect(() => {
    presence.value = withSpring(active ? 1 : 0.55, springs.entrance);
  }, [active, presence]);
  // Fire the ripple on a recall, and also when the graph visibly grew after a
  // completed idea absorbed into memory. recallPulse changing is the trigger.
  useEffect(() => {
    if (recallPulse <= 0) return;
    wave.value = withSequence(withTiming(1, { duration: 240 }), withTiming(0, { duration: 1100 }));
  }, [recallPulse, wave]);
  useEffect(() => {
    // A growing node count is knowledge being absorbed; give it a soft swell.
    wave.value = withSequence(withTiming(0.7, { duration: 320 }), withTiming(0, { duration: 900 }));
  }, [count, wave]);

  const style = useAnimatedStyle(() => ({
    opacity: (0.1 + presence.value * 0.12) + wave.value * 0.5,
    transform: [
      { translateY: (drift.value - 0.5) * 10 },
      { scale: 1 + wave.value * 0.05 },
    ],
  }));

  return <Animated.View style={[styles.layer, style]} pointerEvents="none">
    <Canvas style={StyleSheet.absoluteFill}>
      <Group>
        {layout.edges.map((edge, index) => {
          const a = layout.nodes[edge.a]!;
          const b = layout.nodes[edge.b]!;
          return <Line key={`e${index}`} p1={vec(a.x, a.y)} p2={vec(b.x, b.y)} color={colors.lineStrong} strokeWidth={1} />;
        })}
        {layout.nodes.map((node, index) => <Circle key={`n${index}`} cx={node.x} cy={node.y} r={node.r} color={colors.mistBright}>
          <BlurMask blur={2.2} style="normal" />
        </Circle>)}
      </Group>
    </Canvas>
  </Animated.View>;
}

function MistCanvas({ width, height, variant }: { width: number; height: number; variant: "left" | "right" | "core" | "settled" }): React.JSX.Element {
  const centerX = width / 2;
  const centerY = height / 2;
  const isSettled = variant === "settled";
  const left = variant === "left";
  const right = variant === "right";
  return <Canvas style={StyleSheet.absoluteFill}>
    {(left || right) && <Group opacity={0.9}>
      <Circle cx={left ? width * 0.14 : width * 0.82} cy={centerY * 0.9} r={height * 0.22} color={colors.mist}><BlurMask blur={34} style="normal" /></Circle>
      <Circle cx={left ? width * 0.32 : width * 0.65} cy={height * 0.3} r={height * 0.11} color={colors.mist}><BlurMask blur={28} style="normal" /></Circle>
      <Circle cx={left ? width * 0.46 : width * 0.49} cy={height * 0.76} r={height * 0.075} color={colors.mistBright}><BlurMask blur={22} style="normal" /></Circle>
    </Group>}
    {(variant === "core" || isSettled) && <Group>
      <Circle cx={centerX} cy={centerY} r={isSettled ? height * 0.14 : height * 0.22} color={isSettled ? "rgba(244,244,240,0.38)" : colors.mist}><BlurMask blur={isSettled ? 18 : 42} style="normal" /></Circle>
      {isSettled && <RoundedRect x={centerX - height * 0.13} y={centerY - height * 0.13} width={height * 0.26} height={height * 0.26} r={height * 0.075} color="rgba(244,244,240,0.13)" />}
    </Group>}
  </Canvas>;
}

type SplashProps = { onComplete: () => void };

type SplashWorkerPath = { id: string; fromX: number; fromY: number; toX: number; toY: number; delay: number };

const SPLASH_WORKERS: SplashWorkerPath[] = [
  // Final coordinates are the worker's top-left edge. With a 26 px head,
  // their centers form a balanced group around the phone's exact 128 × 129
  // center rather than leaning to one side during the last splash frame.
  { id: "north", fromX: 115, fromY: -36, toX: 115, toY: 68, delay: 20 },
  { id: "upper-left", fromX: 2, fromY: 26, toX: 85, toY: 90, delay: 72 },
  { id: "upper-right", fromX: 228, fromY: 26, toX: 145, toY: 90, delay: 124 },
  { id: "middle-left", fromX: -24, fromY: 128, toX: 80, toY: 120, delay: 176 },
  { id: "middle", fromX: 115, fromY: 286, toX: 115, toY: 116, delay: 228 },
  { id: "middle-right", fromX: 254, fromY: 128, toX: 150, toY: 120, delay: 280 },
  { id: "lower-left", fromX: 1, fromY: 228, toX: 87, toY: 148, delay: 332 },
  { id: "lower", fromX: 115, fromY: 292, toX: 115, toY: 155, delay: 384 },
  { id: "lower-right", fromX: 229, fromY: 228, toX: 143, toY: 148, delay: 436 },
];

/**
 * In-app splash rather than a static native launch image. The phone shell is
 * Skia-rendered; each team dot has a separate UI-thread spring and staggered
 * arrival path so the screen visibly becomes crowded with a working group.
 */
export function OmnibusSplash({ onComplete }: SplashProps): React.JSX.Element {
  const phoneScale = useSharedValue(0.88);
  const phoneOpacity = useSharedValue(0);

  useEffect(() => {
    phoneScale.value = withSpring(1, springs.entrance);
    phoneOpacity.value = withSpring(1, springs.entrance);
    const completeTimer = setTimeout(onComplete, 1_850);
    return () => clearTimeout(completeTimer);
  }, [onComplete, phoneOpacity, phoneScale]);

  const phoneStyle = useAnimatedStyle(() => ({ opacity: phoneOpacity.value, transform: [{ scale: phoneScale.value }] }));
  return <View style={styles.splash} accessibilityLabel="Omnibus is loading">
    <Animated.View style={[styles.splashGraphic, phoneStyle]}>
      <Canvas style={StyleSheet.absoluteFill}>
        {/* Crisp nested shapes intentionally replace the old blurred shell.
            Canvas anti-aliasing keeps the outline smooth at every scale. */}
        <RoundedRect x={55} y={16} width={146} height={226} r={29} color={colors.paper} />
        <RoundedRect x={61} y={23} width={134} height={212} r={23} color={colors.ink} />
        <RoundedRect x={67} y={39} width={122} height={177} r={18} color="#111112" />
        <RoundedRect x={103} y={29} width={50} height={5} r={3} color="rgba(244,244,240,0.38)" />
      </Canvas>
      <View style={styles.splashWorkers}>
        {SPLASH_WORKERS.map(worker => <SplashWorker key={worker.id} {...worker} />)}
      </View>
    </Animated.View>
  </View>;
}

// The dot is drawn at OVERSAMPLE× its displayed size and only ever scaled
// DOWN. iOS rasterizes a view's rounded corner and border at its model bounds
// and GPU-scales that raster to apply a transform, so an entrance that scales
// toward (and, on the underdamped spring, briefly past) 1.0 up-samples that
// tiny raster and looks soft until the spring settles. Rendering at 2× keeps
// the layer's raster always down-sampled — crisp through the whole arrival.
const WORKER_OVERSAMPLE = 2;
// The oversized box is centered on its old visual position by shifting each
// translate back by half the extra size, so geometry is pixel-identical.
const WORKER_CENTER_OFFSET = (26 * (WORKER_OVERSAMPLE - 1)) / 2;

function SplashWorker({ fromX, fromY, toX, toY, delay }: SplashWorkerPath): React.JSX.Element {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = 0;
    const startTimer = setTimeout(() => {
      progress.value = withSpring(1, { ...springs.entrance, damping: 15, stiffness: 118 });
    }, delay);
    return () => clearTimeout(startTimer);
  }, [delay, progress]);
  const style = useAnimatedStyle(() => ({
    opacity: 0.28 + progress.value * 0.72,
    transform: [
      { translateX: fromX + (toX - fromX) * progress.value - WORKER_CENTER_OFFSET },
      { translateY: fromY + (toY - fromY) * progress.value - WORKER_CENTER_OFFSET },
      // Displayed scale (0.64 → 1.0) divided by the oversample factor, so the
      // 2× raster resolves to the same on-screen size while staying downscaled.
      { scale: (0.64 + progress.value * 0.36) / WORKER_OVERSAMPLE },
    ],
  }));
  return <Animated.View style={[styles.worker, style]} />;
}

const styles = StyleSheet.create({
  root: { position: "absolute", top: 0, left: 0, right: 0, overflow: "hidden" },
  layer: { ...StyleSheet.absoluteFillObject },
  particle: { position: "absolute", left: 0, top: 0 },
  splash: { flex: 1, backgroundColor: colors.void, alignItems: "center", justifyContent: "center" },
  splashGraphic: { width: 256, height: 264, position: "relative" },
  splashWorkers: { position: "absolute", left: 0, top: 0, width: 256, height: 264 },
  // Drawn at 2× (52 px, 6 px border) and scaled down in SplashWorker so the
  // rounded border stays crisp through the entrance instead of up-sampling.
  worker: { position: "absolute", left: 0, top: 0, width: 52, height: 52, borderRadius: 26, backgroundColor: colors.paper, borderWidth: 6, borderColor: colors.ink },
});
