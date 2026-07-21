import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import plan from "./act1plan.json";

/**
 * Act I post overlay — subtitles, stat cards, end title card.
 * Rendered on a TRANSPARENT background (ProRes 4444) and composited over the
 * graded footage in ffmpeg. All times come from the locked post plan
 * (docs/demo-assets/_scout/locked_plan.json), which was cut to word-level
 * whisper timings. 1920x1080 · 30fps · 1854 frames.
 */

export const FPS = 30;
export const ACT1_DURATION_FRAMES = Math.round(61.8 * FPS);

const INK = "#f6f6f4";
const BG = "#0c0c0e";
const MUTED = "rgba(246,246,244,0.62)";
const FAINT = "rgba(246,246,244,0.26)";
const SANS = `"Helvetica Neue", Helvetica, -apple-system, "Segoe UI", Arial, sans-serif`;
const MONO = `Menlo, "SF Mono", Consolas, monospace`;

const clamp = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };

type Word = { t: string; emph?: boolean };
type Caption = { in: number; out: number; words: Word[]; y: string };
type StatCard = { in: number; out: number; lines: string[]; position?: string };

export const Act1Overlay: React.FC = () => {
  const f = useCurrentFrame();
  const t = f / FPS;
  return (
    <AbsoluteFill style={{ backgroundColor: "transparent", fontFamily: SANS }}>
      {(plan.captions as Caption[]).map((c, i) =>
        t >= c.in && t <= c.out ? <CaptionCard key={i} c={c} t={t} /> : null,
      )}
      {(plan.statCards as StatCard[]).map((s, i) =>
        t >= s.in && t <= s.out ? <Stat key={i} s={s} t={t} /> : null,
      )}
      {t >= plan.titleCard.in ? <TitleCard t={t} /> : null}
    </AbsoluteFill>
  );
};

const CaptionCard: React.FC<{ c: Caption; t: number }> = ({ c, t }) => {
  const bottom = c.y === "bottom-180" ? 180 : 96;
  const inP = interpolate(t, [c.in, c.in + 0.12], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const outP = interpolate(t, [c.out - 0.08, c.out], [1, 0], clamp);
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom,
        display: "flex",
        justifyContent: "center",
        opacity: inP * outP,
        transform: `translateY(${(1 - inP) * 14}px)`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 13,
          padding: "10px 26px",
          background: "rgba(12,12,14,0.55)",
          borderRadius: 6,
          whiteSpace: "nowrap",
        }}
      >
        {c.words.map((w, i) =>
          w.emph ? (
            <span
              key={i}
              style={{
                fontFamily: SANS,
                fontWeight: 700,
                fontSize: 40,
                letterSpacing: "-0.02em",
                color: INK,
              }}
            >
              {w.t}
            </span>
          ) : (
            <span
              key={i}
              style={{
                fontFamily: MONO,
                fontSize: 28,
                letterSpacing: "0.08em",
                color: MUTED,
              }}
            >
              {w.t}
            </span>
          ),
        )}
      </div>
    </div>
  );
};

const Stat: React.FC<{ s: StatCard; t: number }> = ({ s, t }) => {
  const pop = interpolate(t, [s.in, s.in + 0.25], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const out = interpolate(t, [s.out - 0.15, s.out], [1, 0], clamp);
  return (
    <div
      style={{
        position: "absolute",
        top: 72,
        right: 96,
        opacity: pop * out,
        transform: `translateY(${(1 - pop) * -24}px)`,
        border: `2.5px solid ${INK}`,
        padding: "18px 26px",
        color: INK,
        fontFamily: MONO,
        fontSize: 25,
        fontWeight: 700,
        letterSpacing: "0.08em",
        backgroundColor: "rgba(12,12,14,0.82)",
        lineHeight: 1.5,
      }}
    >
      {s.lines.map((l, i) => (
        <div key={i} style={{ color: i === 0 ? INK : MUTED, fontWeight: i === 0 ? 700 : 400 }}>
          {l}
        </div>
      ))}
    </div>
  );
};

/** End card per the locked spec: wordmark 60.68, rule 60.96, tagline 61.06,
 * command 61.30 with one cursor blink 61.55-61.80. Black backing (the footage
 * is already black there, but backing guarantees purity). */
const TitleCard: React.FC<{ t: number }> = ({ t }) => {
  const wm = interpolate(t, [60.68, 60.96], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const track = interpolate(t, [60.68, 60.96], [-0.01, -0.035], { ...clamp, easing: Easing.out(Easing.cubic) });
  const rule = interpolate(t, [60.96, 61.18], [0, 64], { ...clamp, easing: Easing.out(Easing.cubic) });
  const tag = interpolate(t, [61.06, 61.31], [0, 1], clamp);
  const cmd = interpolate(t, [61.3, 61.55], [0, 1], clamp);
  const cursorOn = t >= 61.55 && t < 61.8 ? 1 : 0;
  return (
    <AbsoluteFill style={{ background: BG }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 500 - 128,
          textAlign: "center",
          fontFamily: SANS,
          fontWeight: 700,
          fontSize: 128,
          letterSpacing: `${track}em`,
          color: INK,
          opacity: wm,
          lineHeight: 1,
        }}
      >
        Omnibus
      </div>
      <div
        style={{
          position: "absolute",
          left: 960 - rule / 2,
          top: 560,
          width: rule,
          height: 2,
          background: FAINT,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 604 - 22,
          textAlign: "center",
          fontFamily: MONO,
          fontSize: 22,
          letterSpacing: "0.14em",
          color: MUTED,
          opacity: tag,
        }}
      >
        YOUR LAPTOPS · YOUR IDEAS · YOUR MODELS
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 656 - 20,
          textAlign: "center",
          fontFamily: MONO,
          fontSize: 20,
          opacity: cmd,
        }}
      >
        <span style={{ color: FAINT }}>$</span>
        <span style={{ color: INK }}> npx omnibus</span>
        <span
          style={{
            display: "inline-block",
            width: 11,
            height: 22,
            marginLeft: 6,
            verticalAlign: "text-bottom",
            background: MUTED,
            opacity: cursorOn,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
