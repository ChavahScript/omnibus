/**
 * Omnibus is deliberately almost colorless.  The small range of near-blacks
 * gives Skia shadows somewhere to land, while the off-white keeps long briefs
 * comfortable to read at night.  We avoid "pure" #000/#fff in the content
 * layer so surfaces retain a physical, paper-on-ink depth without becoming
 * glossy or skeuomorphic.
 */
export const colors = {
  void: "#070707",
  ink: "#0C0C0D",
  surface: "#141415",
  surfaceRaised: "#1B1B1D",
  line: "rgba(255,255,255,0.12)",
  lineStrong: "rgba(255,255,255,0.22)",
  paper: "#F4F4F0",
  paperMuted: "#B7B7B2",
  mist: "rgba(244,244,240,0.17)",
  mistBright: "rgba(244,244,240,0.42)",
  shadow: "rgba(0,0,0,0.72)",
  success: "#E7E7E2",

  // Compatibility aliases keep the small legacy scanner/call components
  // compiling while they inherit the new monochrome palette.
  leather: "#141415",
  leatherLight: "#1B1B1D",
  brass: "#DCDCD7",
  brassLight: "#F4F4F0",
  brassDark: "#73736F",
  neon: "#F4F4F0",
  red: "#E1E1DC",
  glass: "rgba(244,244,240,0.08)",
};

/**
 * Every motion in the mobile client uses a spring.  The weights distinguish
 * soft atmospheric movement from the purposeful, slightly heavier controls.
 */
export const springs = {
  mist: { damping: 18, mass: 1.7, stiffness: 36, restDisplacementThreshold: 0.001, restSpeedThreshold: 0.001 },
  entrance: { damping: 17, mass: 0.92, stiffness: 148, restDisplacementThreshold: 0.001, restSpeedThreshold: 0.001 },
  control: { damping: 18, mass: 0.78, stiffness: 248, restDisplacementThreshold: 0.001, restSpeedThreshold: 0.001 },
  heavySwitch: { damping: 19, mass: 0.92, stiffness: 230, restDisplacementThreshold: 0.001, restSpeedThreshold: 0.001 },
  callSheet: { damping: 22, mass: 0.9, stiffness: 220, restDisplacementThreshold: 0.001, restSpeedThreshold: 0.001 },
  dial: { damping: 14, mass: 0.75, stiffness: 180, restDisplacementThreshold: 0.001, restSpeedThreshold: 0.001 },
} as const;
