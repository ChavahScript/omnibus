import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import {
  Backdrop, BG, Caption, clamp, FAINT, HAIR, INK, MONO, MUTED, SANS,
  Terminal, TermLine, Win, mulberry32,
} from "./film-ui";

/**
 * ACT III — "Built with Codex" (film 2:02→3:00). 1920x1080 · 30fps ·
 * 1740 frames (58s) · silent. Beat-timed to the VO script; the repo stats
 * are real: 26,690 lines · 160 files · 2 days (git, 2026-07-20 → 07-21).
 *
 * Beats: codex session (0-9s) · subsystems cascade (9-20s) · the numbers
 * (20-28s) · the loop (28-40s) · architecture (40-50s) · end card (50-58s).
 */

export const ACT3_DURATION_FRAMES = 1740;

const SESSION: TermLine[] = [
  { at: 18, text: "codex", kind: "cmd", typed: true },
  { at: 44, text: "▌ Omnibus workspace · guardrails loaded from Second Brain", kind: "dim" },
  { at: 62, text: "build the fleet heartbeat verifier — verify the raw payload before sanitizing", kind: "cmd", typed: true },
  { at: 150, text: "+ src/home-fleet.ts        verifyHeartbeat(raw, secret)", kind: "out" },
  { at: 166, text: "+ src/home-fleet.ts        sanitizeAfterVerify(payload)", kind: "out" },
  { at: 182, text: "+ src/home-fleet.test.ts   rejects tampered nonce · accepts honest worker", kind: "out" },
  { at: 204, text: "✓ 3 files changed · tests passing", kind: "ok" },
];

const SUBSYSTEMS = [
  ["knowledge-graph.ts", "bi-temporal graph · deterministic merge"],
  ["hipporag.ts", "Personalized PageRank recall"],
  ["home-fleet.ts", "HMAC fleet protocol · P2P tickets"],
  ["precommit.ts", "the teaching gate"],
  ["ambient-capture.ts", "watches the repo · distills history"],
  ["OmnibusHaptics.swift", "CoreHaptics · the arrival pulse"],
] as const;

export const Act3: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ backgroundColor: BG, fontFamily: SANS }}>
      <Backdrop wordmark={f < 1500} />

      {/* B1 · a Codex session, guardrails already in the room */}
      <Win f={f} openAt={10} rect={[210, 150, 1500, 560]} title="codex — Omnibus workspace" closeAt={262}>
        <Terminal f={f} lines={SESSION} fontSize={22} />
      </Win>
      <Caption f={f} from={36} to={250} text="EVERY SUBSYSTEM STARTED AS A CONVERSATION" />

      {/* B2 · subsystems cascade — real filenames */}
      {SUBSYSTEMS.map(([file, sub], i) => {
        const openAt = 280 + i * 26;
        const col = i % 3, row = Math.floor(i / 3);
        return (
          <Win key={file} f={f} openAt={openAt} rect={[90 + col * 590, 150 + row * 330, 560, 290]} title={file} closeAt={568}>
            <div style={{ padding: "18px 22px" }}>
              <div style={{ color: INK, fontFamily: MONO, fontSize: 17, fontWeight: 700, letterSpacing: "0.04em" }}>{sub}</div>
              <div style={{ marginTop: 12 }}>
                {[0, 1, 2, 3].map(li => (
                  <div key={li} style={{ height: 9, borderRadius: 4, background: FAINT, opacity: 0.55 - li * 0.1, marginTop: 9, width: `${88 - li * 14}%` }} />
                ))}
              </div>
              <div style={{ marginTop: 14, color: MUTED, fontFamily: MONO, fontSize: 12, letterSpacing: "0.08em" }}>
                DESCRIBED → GENERATED → VERIFIED
              </div>
            </div>
          </Win>
        );
      })}
      <Caption f={f} from={300} to={556} text="I DESCRIBED SYSTEMS. CODEX BUILT THEM." />

      {/* B3 · the real numbers */}
      {f >= 600 && f < 850 ? <Numbers f={f} /> : null}

      {/* B4 · the loop — mistake → lesson → gate */}
      {f >= 860 && f < 1210 ? <Loop f={f} /> : null}
      <Caption f={f} from={900} to={1188} text="EVERY MISTAKE BECAME A RULE THE TOOL ENFORCES" />

      {/* B5 · the architecture it added up to */}
      {f >= 1220 && f < 1510 ? <Architecture f={f} /> : null}
      <Caption f={f} from={1250} to={1488} text="ONE DEVELOPER · TWO DAYS · A TEAM'S OUTPUT" />

      {/* B6 · end card */}
      {f >= 1512 ? <EndCard f={f} /> : null}
    </AbsoluteFill>
  );
};

const Numbers: React.FC<{ f: number }> = ({ f }) => {
  const rnd = mulberry32(7);
  const flap = (final: string, settleStart: number) => {
    let di = -1;
    return final.split("").map((ch, i) => {
      if (!/\d/.test(ch)) return <span key={i} style={{ display: "inline-block", width: "0.34em" }}>{ch}</span>;
      di += 1;
      const settle = settleStart + di * 2;
      const v = f >= settle ? ch : String(Math.floor(rnd() * 10 + f / 2) % 10);
      return <span key={i} style={{ display: "inline-block", width: "0.58em", textAlign: "center" }}>{v}</span>;
    });
  };
  const fade = interpolate(f, [600, 612], [0, 1], clamp) * interpolate(f, [836, 850], [1, 0], clamp);
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", opacity: fade }}>
      <div style={{ color: INK, fontFamily: MONO, fontSize: 26, fontWeight: 700, letterSpacing: "0.08em" }}>WHAT TWO DAYS LOOKS LIKE</div>
      <div style={{ color: INK, fontFamily: SANS, fontWeight: 700, fontSize: 150, letterSpacing: "-0.035em", lineHeight: 1.15, marginTop: 10 }}>
        {flap("26,690", 626)}
      </div>
      <div style={{ color: MUTED, fontFamily: MONO, fontSize: 24, letterSpacing: "0.12em", marginTop: 2 }}>LINES OF TYPESCRIPT + SWIFT</div>
      <div style={{ display: "flex", gap: 64, marginTop: 44 }}>
        {[
          ["160", "FILES"],
          ["199", "TESTS"],
          ["2", "DAYS"],
          ["1", "DEVELOPER"],
        ].map(([n, label], i) => (
          <div key={label} style={{ textAlign: "center", opacity: interpolate(f, [700 + i * 12, 710 + i * 12], [0, 1], clamp) }}>
            <div style={{ color: INK, fontFamily: SANS, fontWeight: 700, fontSize: 64, letterSpacing: "-0.03em" }}>{n}</div>
            <div style={{ color: MUTED, fontFamily: MONO, fontSize: 16, letterSpacing: "0.14em", marginTop: 4 }}>{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

const Loop: React.FC<{ f: number }> = ({ f }) => {
  const box = (x: number, label: string, sub: string, at: number, inverted = false) => (
    <div
      style={{
        position: "absolute", left: x, top: 380, width: 430, padding: "24px 26px",
        border: `2.5px solid ${INK}`, borderRadius: 4,
        background: inverted ? INK : "rgba(12,12,14,0.85)",
        opacity: interpolate(f, [at, at + 10], [0, 1], clamp),
      }}
    >
      <div style={{ color: inverted ? BG : INK, fontFamily: MONO, fontSize: 21, fontWeight: 700, letterSpacing: "0.08em" }}>{label}</div>
      <div style={{ color: inverted ? "rgba(12,12,14,0.72)" : MUTED, fontFamily: MONO, fontSize: 15, marginTop: 9, lineHeight: 1.5 }}>{sub}</div>
    </div>
  );
  const arrow = (x: number, at: number) => (
    <svg width={110} height={24} style={{ position: "absolute", left: x, top: 440, opacity: interpolate(f, [at, at + 8], [0, 1], clamp) }}>
      <line x1={0} y1={12} x2={92} y2={12} stroke={INK} strokeWidth={2.5} strokeDasharray="10 10" />
      <polygon points="108,12 90,6 90,18" fill={INK} />
    </svg>
  );
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 220, textAlign: "center", color: INK, fontFamily: SANS, fontWeight: 700, fontSize: 58, letterSpacing: "-0.03em", opacity: interpolate(f, [868, 880], [0, 1], clamp) }}>
        It broke at 2 a.m. Once.
      </div>
      {box(140, "THE MISTAKE", "heartbeat filter sanitized fields before verifying the HMAC — honest workers rejected", 900)}
      {arrow(585, 950)}
      {box(710, "THE LESSON", "recorded in the anti-pattern registry: verify the raw payload, sanitize after", 968)}
      {arrow(1155, 1018)}
      {box(1280, "THE GATE", "now blocks that exact mistake on every commit — mine, or the agent's", 1036, true)}
    </div>
  );
};

const Architecture: React.FC<{ f: number }> = ({ f }) => {
  const item = (at: number) => interpolate(f, [at, at + 10], [0, 1], { ...clamp, easing: Easing.out(Easing.quad) });
  const label = (text: string, x: number, y: number, at: number, bold = false) => (
    <text x={x} y={y} fontFamily={MONO} fontSize={bold ? 26 : 20} fontWeight={bold ? 700 : 400}
      letterSpacing={bold ? "0.06em" : "0.05em"} fill={bold ? INK : MUTED} opacity={item(at)} textAnchor="middle">
      {text}
    </text>
  );
  return (
    <svg width={1920} height={1080} viewBox="0 0 1920 1080" style={{ position: "absolute" }}>
      <g opacity={item(1232)}>
        <rect x={810} y={400} width={300} height={180} fill="none" stroke={INK} strokeWidth={2.5} />
        <rect x={780} y={580} width={360} height={34} fill="none" stroke={INK} strokeWidth={2.5} />
      </g>
      {label("BRIDGE · HP-DRAWER", 960, 662, 1232, true)}
      <g opacity={item(1244)}>
        <rect x={420} y={420} width={84} height={156} fill="none" stroke={INK} strokeWidth={2.5} />
      </g>
      {label("IPHONE", 462, 404, 1244)}
      <g opacity={item(1256)}>
        <rect x={1390} y={412} width={150} height={76} fill="none" stroke={INK} strokeWidth={2.5} />
        <rect x={1376} y={488} width={178} height={16} fill="none" stroke={INK} strokeWidth={2.5} />
      </g>
      {label("FLEET", 1465, 396, 1256)}
      <g opacity={item(1268)}>
        <rect x={880} y={730} width={160} height={92} fill="none" stroke={INK} strokeWidth={2.5} />
        <circle cx={912} cy={764} r={3} fill={INK} />
        <circle cx={960} cy={788} r={3} fill={INK} />
        <circle cx={1006} cy={756} r={3} fill={INK} />
        <line x1={912} y1={764} x2={960} y2={788} stroke={INK} strokeWidth={1.5} />
        <line x1={960} y1={788} x2={1006} y2={756} stroke={INK} strokeWidth={1.5} />
      </g>
      {label("SECOND BRAIN", 960, 858, 1268)}
      <g opacity={item(1280)}>
        <line x1={504} y1={490} x2={796} y2={490} stroke={INK} strokeWidth={2.5} strokeDasharray="10 10" />
        <polygon points="810,490 792,484 792,496" fill={INK} />
        <line x1={1110} y1={458} x2={1376} y2={458} stroke={INK} strokeWidth={2.5} strokeDasharray="10 10" />
        <polygon points="1390,458 1372,452 1372,464" fill={INK} />
        <line x1={960} y1={614} x2={960} y2={716} stroke={INK} strokeWidth={2.5} strokeDasharray="4 8" />
        <polygon points="960,730 954,712 966,712" fill={INK} />
      </g>
      <g opacity={item(1300)}>
        <rect x={760} y={244} width={400} height={70} fill={INK} />
      </g>
      {f >= 1300 ? (
        <text x={960} y={290} fontFamily={MONO} fontSize={28} fontWeight={700} letterSpacing="0.1em" fill={BG} textAnchor="middle" opacity={item(1300)}>
          CODEX BUILT THIS
        </text>
      ) : null}
      <g opacity={item(1312)}>
        <line x1={960} y1={314} x2={960} y2={386} stroke={INK} strokeWidth={2.5} strokeDasharray="10 10" />
        <polygon points="960,400 954,382 966,382" fill={INK} />
      </g>
    </svg>
  );
};

const EndCard: React.FC<{ f: number }> = ({ f }) => {
  const wm = interpolate(f, [1516, 1544], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const track = interpolate(f, [1516, 1544], [-0.01, -0.035], { ...clamp, easing: Easing.out(Easing.cubic) });
  const rule = interpolate(f, [1544, 1566], [0, 64], { ...clamp, easing: Easing.out(Easing.cubic) });
  const tag = interpolate(f, [1554, 1579], [0, 1], clamp);
  const codex = interpolate(f, [1580, 1605], [0, 1], clamp);
  const cmd = interpolate(f, [1610, 1635], [0, 1], clamp);
  const cursorOn = f >= 1650 && Math.floor((f - 1650) / 16) % 2 === 0 ? 1 : 0;
  return (
    <AbsoluteFill style={{ background: BG }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 500 - 128, textAlign: "center", fontFamily: SANS, fontWeight: 700, fontSize: 128, letterSpacing: `${track}em`, color: INK, opacity: wm, lineHeight: 1 }}>
        Omnibus
      </div>
      <div style={{ position: "absolute", left: 960 - rule / 2, top: 560, width: rule, height: 2, background: FAINT }} />
      <div style={{ position: "absolute", left: 0, right: 0, top: 582, textAlign: "center", fontFamily: MONO, fontSize: 22, letterSpacing: "0.14em", color: MUTED, opacity: tag }}>
        YOUR LAPTOPS · YOUR IDEAS · YOUR MODELS
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 628, textAlign: "center", fontFamily: MONO, fontSize: 20, letterSpacing: "0.18em", fontWeight: 700, color: INK, opacity: codex }}>
        BUILT WITH CODEX
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 678, textAlign: "center", fontFamily: MONO, fontSize: 20, opacity: cmd }}>
        <span style={{ color: FAINT }}>$</span>
        <span style={{ color: INK }}> npx omnibus</span>
        <span style={{ display: "inline-block", width: 11, height: 22, marginLeft: 6, verticalAlign: "text-bottom", background: MUTED, opacity: cursorOn }} />
      </div>
    </AbsoluteFill>
  );
};
