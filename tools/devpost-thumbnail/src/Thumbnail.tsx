import React from "react";
import { AbsoluteFill } from "remotion";

/**
 * Omnibus — Devpost card.
 *
 * Method: International Typographic Style. A strict grid (96px margins,
 * 64px module), one sans family with hard weight contrast, hairline rules
 * as structure, zero decoration. The only image is a functional schematic
 * of the real system (phone → bridge → fleet → brief), because an honest
 * diagram is more persuasive than any illustration. Everything must remain
 * legible when Devpost scales the card to ~460px wide.
 */

const W = 2048;
const H = 1360;
const M = 96; // outer margin
const BG = "#0c0c0e";
const INK = "#f6f6f4";
const MUTED = "rgba(246,246,244,0.60)";
const FAINT = "rgba(246,246,244,0.26)";
const GRID_DOT = "rgba(246,246,244,0.07)";
const SANS = `"Helvetica Neue", Helvetica, -apple-system, "Segoe UI", Arial, sans-serif`;
const MONO = `Menlo, "SF Mono", Consolas, monospace`;

// ---------------------------------------------------------------------------
// Schematic primitives — sharp corners, 2.5px strokes, orthogonal routing.
// ---------------------------------------------------------------------------

const STROKE = 2.5;

const Box: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
  filled?: boolean;
}> = ({ x, y, w, h, title, sub, filled }) => (
  <g>
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      fill={filled ? INK : "none"}
      stroke={INK}
      strokeWidth={STROKE}
    />
    <text
      x={x + 28}
      y={y + (sub ? h / 2 - 8 : h / 2 + 9)}
      fill={filled ? BG : INK}
      fontFamily={MONO}
      fontSize={27}
      fontWeight={700}
      letterSpacing="0.06em"
    >
      {title}
    </text>
    {sub ? (
      <text
        x={x + 28}
        y={y + h / 2 + 34}
        fill={filled ? "rgba(12,12,14,0.72)" : MUTED}
        fontFamily={MONO}
        fontSize={21}
        letterSpacing="0.05em"
      >
        {sub}
      </text>
    ) : null}
  </g>
);

/** Right-pointing solid arrowhead. */
const Head: React.FC<{ x: number; y: number; dir: "right" | "left" | "up" | "down" }> = ({ x, y, dir }) => {
  const s = 11;
  const points =
    dir === "right"
      ? `${x},${y} ${x - s * 1.6},${y - s} ${x - s * 1.6},${y + s}`
      : dir === "left"
        ? `${x},${y} ${x + s * 1.6},${y - s} ${x + s * 1.6},${y + s}`
        : dir === "up"
          ? `${x},${y} ${x - s},${y + s * 1.6} ${x + s},${y + s * 1.6}`
          : `${x},${y} ${x - s},${y - s * 1.6} ${x + s},${y - s * 1.6}`;
  return <polygon points={points} fill={INK} />;
};

const Note: React.FC<{ x: number; y: number; text: string; anchor?: "start" | "middle" | "end" }> = ({
  x,
  y,
  text,
  anchor = "middle",
}) => (
  <text
    x={x}
    y={y}
    fill={MUTED}
    fontFamily={MONO}
    fontSize={20}
    letterSpacing="0.10em"
    textAnchor={anchor}
  >
    {text}
  </text>
);

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export const Thumbnail: React.FC = () => {
  // --- schematic geometry (all on the 64px module where possible) ---------
  const bandTop = 736;

  const phone = { x: M, y: bandTop + 64, w: 288, h: 272 };
  const bridge = { x: 576, y: bandTop, w: 576, h: 400 };
  const workers = { x: 1472, w: W - M - 1472, h: 104, gap: 44, y: bandTop };
  const workerLabels: Array<[string, string]> = [
    ["WORKER 01", "PRODUCT LENS"],
    ["WORKER 02", "FEASIBILITY LENS"],
    ["WORKER 03", "RISK LENS"],
  ];

  const phoneMidY = phone.y + phone.h / 2;
  const bridgeMidY = bridge.y + bridge.h / 2;
  const returnY = bridge.y + bridge.h + 56;

  return (
    <AbsoluteFill style={{ backgroundColor: BG, fontFamily: SANS }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        {/* Engineering dot grid: structure, not noise. */}
        <g>
          {Array.from({ length: Math.floor(W / 64) + 1 }, (_, col) =>
            Array.from({ length: Math.floor(H / 64) + 1 }, (_, row) => (
              <circle key={`${col}-${row}`} cx={col * 64} cy={row * 64} r={1.6} fill={GRID_DOT} />
            )),
          )}
        </g>

        {/* Masthead rule + metadata. */}
        <line x1={M} y1={170} x2={W - M} y2={170} stroke={FAINT} strokeWidth={2} />
        <text x={M} y={134} fill={MUTED} fontFamily={MONO} fontSize={24} letterSpacing="0.14em">
          LOCAL-FIRST MULTI-AGENT IDEATION
        </text>
        <text x={W - M} y={134} fill={MUTED} fontFamily={MONO} fontSize={24} letterSpacing="0.14em" textAnchor="end">
          IPHONE + OLLAMA + SPARE LAPTOPS
        </text>

        {/* ------------------------- schematic ------------------------- */}

        {/* Phone. */}
        <Box x={phone.x} y={phone.y} w={phone.w} h={phone.h} title="IPHONE" sub="ONE IDEA FIELD" />

        {/* Phone → bridge. */}
        <line x1={phone.x + phone.w} y1={phoneMidY} x2={bridge.x - 4} y2={phoneMidY} stroke={INK} strokeWidth={STROKE} />
        <Head x={bridge.x - 2} y={phoneMidY} dir="right" />
        <Note x={(phone.x + phone.w + bridge.x) / 2} y={phoneMidY - 20} text="QR + WSS" />

        {/* Bridge (coordinator) with its two internal stages. */}
        <rect x={bridge.x} y={bridge.y} width={bridge.w} height={bridge.h} fill="none" stroke={INK} strokeWidth={STROKE} />
        <text
          x={bridge.x + 28}
          y={bridge.y + 52}
          fill={INK}
          fontFamily={MONO}
          fontSize={27}
          fontWeight={700}
          letterSpacing="0.06em"
        >
          BRIDGE — MAC / PC
        </text>
        <Box
          x={bridge.x + 32}
          y={bridge.y + 88}
          w={bridge.w - 64}
          h={124}
          title="AUDITOR → DEVELOPER"
          sub="LOCAL OLLAMA MODELS"
        />
        <Box
          x={bridge.x + 32}
          y={bridge.y + 244}
          w={bridge.w - 64}
          h={124}
          title="SECOND BRAIN"
          sub="BI-TEMPORAL GRAPH · HIPPORAG"
        />

        {/* Bridge → worker trunk, then orthogonal elbows. */}
        {(() => {
          const trunkX = 1344;
          const elements: React.ReactNode[] = [];
          elements.push(
            <line
              key="trunk-h"
              x1={bridge.x + bridge.w}
              y1={bridgeMidY}
              x2={trunkX}
              y2={bridgeMidY}
              stroke={INK}
              strokeWidth={STROKE}
              strokeDasharray="10 10"
            />,
          );
          const firstMid = workers.y + workers.h / 2;
          const lastMid = workers.y + 2 * (workers.h + workers.gap) + workers.h / 2;
          elements.push(
            <line
              key="trunk-v"
              x1={trunkX}
              y1={Math.min(firstMid, bridgeMidY)}
              x2={trunkX}
              y2={Math.max(lastMid, bridgeMidY)}
              stroke={INK}
              strokeWidth={STROKE}
              strokeDasharray="10 10"
            />,
          );
          for (let i = 0; i < 3; i += 1) {
            const midY = workers.y + i * (workers.h + workers.gap) + workers.h / 2;
            elements.push(
              <line
                key={`spur${i}`}
                x1={trunkX}
                y1={midY}
                x2={workers.x - 4}
                y2={midY}
                stroke={INK}
                strokeWidth={STROKE}
                strokeDasharray="10 10"
              />,
              <Head key={`head${i}`} x={workers.x - 2} y={midY} dir="right" />,
            );
          }
          elements.push(
            <Note key="lan" x={(bridge.x + bridge.w + trunkX) / 2} y={bridgeMidY - 20} text="LAN · HMAC" />,
          );
          return elements;
        })()}

        {/* Workers. */}
        {workerLabels.map(([title, sub], i) => (
          <Box
            key={title}
            x={workers.x}
            y={workers.y + i * (workers.h + workers.gap)}
            w={workers.w}
            h={workers.h}
            title={title}
            sub={sub}
          />
        ))}
        {/* P2P cache hops in the gaps between workers. */}
        {[0, 1].map(i => {
          const gapTop = workers.y + workers.h + i * (workers.h + workers.gap);
          const x = workers.x + 64;
          return (
            <g key={`p2p${i}`}>
              <line
                x1={x}
                y1={gapTop + 6}
                x2={x}
                y2={gapTop + workers.gap - 6}
                stroke={INK}
                strokeWidth={STROKE}
                strokeDasharray="4 8"
              />
              <Head x={x} y={gapTop + workers.gap - 4} dir="down" />
              {i === 0 ? (
                <text
                  x={x + 24}
                  y={gapTop + workers.gap / 2 + 7}
                  fill={MUTED}
                  fontFamily={MONO}
                  fontSize={20}
                  letterSpacing="0.10em"
                >
                  P2P PREFIX CACHE
                </text>
              ) : null}
            </g>
          );
        })}

        {/* Return path: brief back to the phone. Orthogonal, one elbow. */}
        <line x1={bridge.x + bridge.w / 2} y1={bridge.y + bridge.h} x2={bridge.x + bridge.w / 2} y2={returnY} stroke={INK} strokeWidth={STROKE} />
        <line x1={phone.x + phone.w / 2} y1={returnY} x2={bridge.x + bridge.w / 2} y2={returnY} stroke={INK} strokeWidth={STROKE} />
        <line x1={phone.x + phone.w / 2} y1={returnY} x2={phone.x + phone.w / 2} y2={phone.y + phone.h + 4} stroke={INK} strokeWidth={STROKE} />
        <Head x={phone.x + phone.w / 2} y={phone.y + phone.h + 2} dir="up" />
        <Note
          x={(phone.x + phone.w / 2 + bridge.x + bridge.w / 2) / 2}
          y={returnY - 18}
          text="DECISION-READY BRIEF + IDE PROMPT"
        />

        {/* Footer rule. */}
        <line x1={M} y1={1236} x2={W - M} y2={1236} stroke={FAINT} strokeWidth={2} />
      </svg>

      {/* ------------------------- typography ------------------------- */}

      {/* Wordmark: the one dominant element at gallery size. */}
      <div
        style={{
          position: "absolute",
          left: M - 10,
          top: 214,
          color: INK,
          fontSize: 268,
          fontWeight: 700,
          letterSpacing: "-0.035em",
          lineHeight: 1,
        }}
      >
        Omnibus
      </div>

      {/* Supporting statement: two measured lines, weight contrast only. */}
      <div
        style={{
          position: "absolute",
          left: M,
          top: 536,
          color: MUTED,
          fontSize: 46,
          fontWeight: 400,
          lineHeight: 1.38,
          maxWidth: 1400,
          letterSpacing: "0.002em",
        }}
      >
        Speak an idea into your iPhone. A private fleet of local models
        <br />
        turns it into a build-ready brief — and never forgets.
      </div>

      {/* Footer: capabilities index, editorial style. */}
      <div
        style={{
          position: "absolute",
          left: M,
          top: 1268,
          color: MUTED,
          fontFamily: MONO,
          fontSize: 23,
          letterSpacing: "0.12em",
        }}
      >
        QR PAIRING&nbsp;&nbsp;/&nbsp;&nbsp;BI-TEMPORAL MEMORY&nbsp;&nbsp;/&nbsp;&nbsp;HIPPORAG RECALL&nbsp;&nbsp;/&nbsp;&nbsp;PRE-COMMIT GATE
      </div>
      <div
        style={{
          position: "absolute",
          right: M,
          top: 1268,
          color: INK,
          fontFamily: MONO,
          fontSize: 23,
          fontWeight: 700,
          letterSpacing: "0.12em",
        }}
      >
        ZERO CLOUD
      </div>
    </AbsoluteFill>
  );
};
