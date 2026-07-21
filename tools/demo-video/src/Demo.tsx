import React from "react";
import {
  AbsoluteFill,
  getStaticFiles,
  interpolate,
  OffthreadVideo,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

/**
 * Act II of the Omnibus demo video (0:50–2:00 of the final cut) plus the
 * minute-three closer. Act I is live footage edited conventionally; this
 * composition renders the screen-recording half so every caption and stat
 * card matches the Devpost card's Swiss monochrome system exactly.
 *
 * Drop recordings into tools/demo-video/footage/ using the names from
 * docs/DEMO-VIDEO.md. A missing file renders as a labeled slate instead of
 * crashing, so the studio timeline is workable before the shoot.
 */

export const FPS = 30;
const SEC = FPS;

const INK = "#f6f6f4";
const BG = "#0c0c0e";
const MUTED = "rgba(246,246,244,0.62)";
const SANS = `"Helvetica Neue", Helvetica, -apple-system, "Segoe UI", Arial, sans-serif`;
const MONO = `Menlo, "SF Mono", Consolas, monospace`;

/** Beat plan: [footage file, seconds on screen, caption]. */
const BEATS: Array<{ file: string; seconds: number; caption: string; note?: string }> = [
  { file: "01-start-qr.mp4", seconds: 8, caption: "ONE QR · NO ACCOUNTS · NO CLOUD" },
  { file: "02-scan-pair.mp4", seconds: 7, caption: "PAIRED — SIZED FOR THIS LAPTOP" },
  { file: "03-idea-brief.mp4", seconds: 20, caption: "AUDITOR → DEVELOPER — A DECISION-READY BRIEF", note: "RUNNING ON A 7B MODEL. ON A LAPTOP." },
  { file: "04-recall.mp4", seconds: 15, caption: "IT WAS IN THE ROOM. IT REMEMBERS." },
  { file: "05-worker-join.mp4", seconds: 7, caption: "THE DRAWER LAPTOP GETS A JOB" },
  { file: "06-fleet-review.mp4", seconds: 13, caption: "THE DRAWER LAPTOP JUST JOINED THE REVIEW" },
  { file: "07-hook-block.mp4", seconds: 5, caption: "IT GUARDS THE BRANCH." },
];

const CLOSER_SECONDS = 12;

export const DEMO_DURATION_FRAMES =
  BEATS.reduce((total, beat) => total + beat.seconds * SEC, 0) + CLOSER_SECONDS * SEC;

export const Demo: React.FC = () => {
  let cursor = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: BG, fontFamily: SANS }}>
      {BEATS.map(beat => {
        const from = cursor;
        cursor += beat.seconds * SEC;
        return (
          <Sequence key={beat.file} from={from} durationInFrames={beat.seconds * SEC}>
            <Beat file={beat.file} caption={beat.caption} note={beat.note} />
          </Sequence>
        );
      })}
      <Sequence from={cursor} durationInFrames={CLOSER_SECONDS * SEC}>
        <Closer />
      </Sequence>
    </AbsoluteFill>
  );
};

const Beat: React.FC<{ file: string; caption: string; note?: string }> = ({ file, caption, note }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const fade = interpolate(frame, [0, 12, durationInFrames - 12, durationInFrames], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <Footage file={file} />
      <CaptionBar text={caption} />
      {note ? <StatCard text={note} appearAt={Math.floor(durationInFrames * 0.55)} /> : null}
    </AbsoluteFill>
  );
};

/** Renders the recording, or an honest slate when it has not been shot yet. */
const Footage: React.FC<{ file: string }> = ({ file }) => {
  const relative = `footage/${file}`;
  const exists = getStaticFiles().some(entry => entry.name === relative);
  if (!exists) return <Slate file={file} />;
  return (
    <OffthreadVideo
      src={staticFile(relative)}
      style={{ width: "100%", height: "100%", objectFit: "contain" }}
      muted
    />
  );
};

const Slate: React.FC<{ file: string }> = ({ file }) => (
  <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 24 }}>
    <div style={{ color: MUTED, fontFamily: MONO, fontSize: 30, letterSpacing: "0.12em" }}>AWAITING FOOTAGE</div>
    <div style={{ color: INK, fontFamily: MONO, fontSize: 44, fontWeight: 700 }}>{file}</div>
    <div style={{ color: MUTED, fontFamily: MONO, fontSize: 24 }}>see docs/DEMO-VIDEO.md · recording checklist</div>
  </AbsoluteFill>
);

/** Bottom caption in the Devpost card's editorial voice. */
const CaptionBar: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rise = spring({ frame, fps, config: { damping: 200, stiffness: 120 } });
  return (
    <div
      style={{
        position: "absolute",
        left: 96,
        right: 96,
        bottom: 64,
        transform: `translateY(${(1 - rise) * 40}px)`,
        opacity: rise,
        borderTop: "2px solid rgba(246,246,244,0.26)",
        paddingTop: 22,
        color: INK,
        fontFamily: MONO,
        fontSize: 30,
        letterSpacing: "0.14em",
      }}
    >
      {text}
    </div>
  );
};

/** A single fact, stated once, in the corner — never over the action. */
const StatCard: React.FC<{ text: string; appearAt: number }> = ({ text, appearAt }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame: frame - appearAt, fps, config: { damping: 200, stiffness: 140 } });
  if (frame < appearAt) return null;
  return (
    <div
      style={{
        position: "absolute",
        top: 72,
        right: 96,
        opacity: pop,
        transform: `translateY(${(1 - pop) * -24}px)`,
        border: `2.5px solid ${INK}`,
        padding: "20px 28px",
        color: INK,
        fontFamily: MONO,
        fontSize: 27,
        fontWeight: 700,
        letterSpacing: "0.08em",
        backgroundColor: "rgba(12,12,14,0.82)",
      }}
    >
      {text}
    </div>
  );
};

const Closer: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const inSpring = spring({ frame, fps, config: { damping: 200, stiffness: 90 } });
  return (
    <AbsoluteFill style={{ alignItems: "flex-start", justifyContent: "center", paddingLeft: 96 }}>
      <div style={{ color: INK, fontSize: 150, fontWeight: 700, letterSpacing: "-0.035em", opacity: inSpring }}>
        Omnibus
      </div>
      <div style={{ color: MUTED, fontSize: 44, marginTop: 24, opacity: inSpring }}>
        Your ideas. Your laptops. Your second brain.
      </div>
      <div style={{ color: INK, fontFamily: MONO, fontSize: 30, letterSpacing: "0.1em", marginTop: 72, opacity: inSpring }}>
        github.com/ChavahScript/omnibus&nbsp;&nbsp;·&nbsp;&nbsp;npm i -g omnibus-bridge
      </div>
    </AbsoluteFill>
  );
};
