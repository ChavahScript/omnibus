import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";

/** Shared Swiss-monochrome film vocabulary — Acts II & III. */

export const INK = "#f6f6f4";
export const BG = "#0c0c0e";
export const MUTED = "rgba(246,246,244,0.62)";
export const FAINT = "rgba(246,246,244,0.26)";
export const HAIR = "rgba(246,246,244,0.14)";
export const GRID_DOT = "rgba(246,246,244,0.07)";
export const WIN_BG = "#18181b";
export const SANS = `"Helvetica Neue", Helvetica, -apple-system, "Segoe UI", Arial, sans-serif`;
export const MONO = `Menlo, "SF Mono", Consolas, monospace`;

export const clamp = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };

export const mulberry32 = (seed: number) => {
  let a = seed;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Desktop backdrop: radial deep gray + engineering dot grid + faint wordmark. */
export const Backdrop: React.FC<{ wordmark?: boolean }> = ({ wordmark = true }) => (
  <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at 50% 42%, #121215, #0c0c0e 75%)" }}>
    <svg width={1920} height={1080} style={{ position: "absolute" }}>
      {Array.from({ length: 30 }, (_, ix) =>
        Array.from({ length: 17 }, (_, iy) => (
          <circle key={`${ix}-${iy}`} cx={32 + ix * 64} cy={28 + iy * 64} r={1.6} fill={GRID_DOT} />
        )),
      )}
    </svg>
    {wordmark ? (
      <div
        style={{
          position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: SANS, fontWeight: 700, fontSize: 150, letterSpacing: "-0.035em", color: "rgba(246,246,244,0.045)",
        }}
      >
        Omnibus
      </div>
    ) : null}
  </div>
);

type Rect = readonly [number, number, number, number];

/** Win11-flavored window, same chrome as the Descent world. */
export const Win: React.FC<{
  f: number;
  openAt: number;
  rect: Rect;
  title: string;
  children: React.ReactNode;
  statusBar?: string;
  closeAt?: number;
  snap?: { at: number; to: Rect };
}> = ({ f, openAt, rect, title, children, statusBar, closeAt, snap }) => {
  if (f < openAt || (closeAt !== undefined && f >= closeAt + 8)) return null;
  const open = interpolate(f, [openAt, openAt + 7], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const close = closeAt !== undefined ? interpolate(f, [closeAt, closeAt + 8], [1, 0], clamp) : 1;
  let [x, y, w, h] = rect;
  if (snap) {
    const t = interpolate(f, [snap.at, snap.at + 12], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
    x = x + (snap.to[0] - x) * t;
    y = y + (snap.to[1] - y) * t;
    w = w + (snap.to[2] - w) * t;
    h = h + (snap.to[3] - h) * t;
  }
  return (
    <div
      style={{
        position: "absolute", left: x, top: y, width: w, height: h,
        opacity: open * close,
        transform: `scale(${0.96 + 0.04 * open})`,
        transformOrigin: "center",
        background: WIN_BG, border: `1px solid ${HAIR}`, borderRadius: 8,
        boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}
    >
      <div
        style={{
          height: 38, flexShrink: 0, display: "flex", alignItems: "center", paddingLeft: 14,
          borderBottom: `1px solid ${HAIR}`, color: MUTED, fontFamily: SANS, fontSize: 18,
        }}
      >
        <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden" }}>{title}</span>
        <span style={{ display: "flex", color: MUTED, fontFamily: MONO, fontSize: 15 }}>
          <span style={{ width: 42, textAlign: "center" }}>—</span>
          <span style={{ width: 42, textAlign: "center" }}>▢</span>
          <span style={{ width: 42, textAlign: "center" }}>✕</span>
        </span>
      </div>
      <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>{children}</div>
      {statusBar ? (
        <div
          style={{
            height: 28, flexShrink: 0, borderTop: `1px solid ${HAIR}`, display: "flex", alignItems: "center",
            paddingLeft: 12, color: MUTED, fontFamily: MONO, fontSize: 14, letterSpacing: "0.04em",
          }}
        >
          {statusBar}
        </div>
      ) : null}
    </div>
  );
};

export type TermLine = { at: number; text: string; kind?: "cmd" | "out" | "ok" | "block" | "dim"; typed?: boolean };

/** Terminal content: lines appear at frames; `typed` lines type at ~28 chars/s. */
export const Terminal: React.FC<{ f: number; lines: TermLine[]; fontSize?: number }> = ({ f, lines, fontSize = 21 }) => {
  const visible = lines.filter(l => f >= l.at);
  const last = visible[visible.length - 1];
  return (
    <div style={{ padding: "16px 20px", fontFamily: MONO, fontSize, lineHeight: 1.75, letterSpacing: "0.01em" }}>
      {visible.map((l, i) => {
        let text = l.text;
        if (l.typed) {
          const chars = Math.floor(((f - l.at) / 30) * 28);
          text = l.text.slice(0, Math.max(0, chars));
        }
        const color =
          l.kind === "cmd" ? INK : l.kind === "ok" ? INK : l.kind === "block" ? BG : l.kind === "dim" ? FAINT : MUTED;
        return (
          <div
            key={i}
            style={{
              color,
              whiteSpace: "pre-wrap",
              fontWeight: l.kind === "block" || l.kind === "ok" ? 700 : 400,
              background: l.kind === "block" ? INK : "transparent",
              padding: l.kind === "block" ? "0px 8px" : undefined,
              display: l.kind === "block" ? "inline-block" : undefined,
              borderRadius: l.kind === "block" ? 3 : undefined,
            }}
          >
            {l.kind === "cmd" ? <span style={{ color: FAINT }}>{"$ "}</span> : null}
            {text}
            {l === last && l.typed && text.length < l.text.length ? (
              <span style={{ display: "inline-block", width: 11, height: fontSize + 2, background: INK, verticalAlign: "text-bottom", marginLeft: 3 }} />
            ) : null}
          </div>
        );
      })}
      {last && !last.typed ? (
        <span
          style={{
            display: "inline-block", width: 11, height: fontSize + 2,
            background: Math.floor(f / 16) % 2 === 0 ? INK : "transparent",
            verticalAlign: "text-bottom",
          }}
        />
      ) : null}
    </div>
  );
};

/** iPhone frame with dark screen content area. */
export const Phone: React.FC<{
  f: number; openAt: number; x: number; y: number; scale?: number; children: React.ReactNode;
}> = ({ f, openAt, x, y, scale = 1, children }) => {
  if (f < openAt) return null;
  const open = interpolate(f, [openAt, openAt + 8], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const W = 360, H = 740;
  return (
    <div
      style={{
        position: "absolute", left: x, top: y, width: W, height: H,
        opacity: open, transform: `scale(${scale * (0.97 + 0.03 * open)})`, transformOrigin: "top left",
        borderRadius: 48, border: `2.5px solid ${FAINT}`, background: "#101012",
        boxShadow: "0 30px 80px rgba(0,0,0,0.6)", overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute", top: 12, left: W / 2 - 55, width: 110, height: 26,
          borderRadius: 14, background: "#000", zIndex: 3,
        }}
      />
      <div style={{ position: "absolute", inset: 0, paddingTop: 54 }}>{children}</div>
    </div>
  );
};

/** Deterministic fake QR: finder squares + data cells. */
export const QRCodeArt: React.FC<{ size?: number; reveal: number }> = ({ size = 190, reveal }) => {
  const N = 21;
  const cell = size / N;
  const rnd = mulberry32(99);
  const cells: Array<[number, number]> = [];
  for (let yy = 0; yy < N; yy++)
    for (let xx = 0; xx < N; xx++) {
      const inFinder = (xx < 7 && yy < 7) || (xx >= N - 7 && yy < 7) || (xx < 7 && yy >= N - 7);
      if (!inFinder && rnd() > 0.52) cells.push([xx, yy]);
    }
  const shown = Math.floor(cells.length * reveal);
  const finder = (fx: number, fy: number) => (
    <>
      <rect x={fx * cell} y={fy * cell} width={7 * cell} height={7 * cell} fill="none" stroke={INK} strokeWidth={cell} />
      <rect x={(fx + 2) * cell} y={(fy + 2) * cell} width={3 * cell} height={3 * cell} fill={INK} />
    </>
  );
  return (
    <svg width={size} height={size} style={{ display: "block" }}>
      <rect width={size} height={size} fill={BG} />
      {reveal > 0.05 ? finder(0, 0) : null}
      {reveal > 0.1 ? finder(N - 7, 0) : null}
      {reveal > 0.15 ? finder(0, N - 7) : null}
      {cells.slice(0, shown).map(([xx, yy], i) => (
        <rect key={i} x={xx * cell} y={yy * cell} width={cell * 0.92} height={cell * 0.92} fill={INK} />
      ))}
    </svg>
  );
};

/** Bottom caption in the film's voice, with exit. */
export const Caption: React.FC<{ f: number; from: number; to: number; text: string }> = ({ f, from, to, text }) => {
  if (f < from || f > to + 10) return null;
  const rise = interpolate(f, [from, from + 10], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const exit = interpolate(f, [to, to + 10], [1, 0], clamp);
  return (
    <div
      style={{
        position: "absolute", left: 96, right: 96, bottom: 64,
        transform: `translateY(${(1 - rise) * 40}px)`, opacity: rise * exit,
        borderTop: `2px solid ${FAINT}`, paddingTop: 20,
        color: INK, fontFamily: MONO, fontSize: 30, letterSpacing: "0.14em",
      }}
    >
      {text}
    </div>
  );
};

/** Corner stat card. */
export const Card: React.FC<{ f: number; from: number; to: number; lines: string[] }> = ({ f, from, to, lines }) => {
  if (f < from || f > to + 8) return null;
  const pop = interpolate(f, [from, from + 8], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const exit = interpolate(f, [to, to + 8], [1, 0], clamp);
  return (
    <div
      style={{
        position: "absolute", top: 72, right: 96, opacity: pop * exit,
        transform: `translateY(${(1 - pop) * -24}px)`,
        border: `2.5px solid ${INK}`, padding: "18px 26px",
        color: INK, fontFamily: MONO, fontSize: 25, fontWeight: 700, letterSpacing: "0.08em",
        backgroundColor: "rgba(12,12,14,0.82)", lineHeight: 1.5,
      }}
    >
      {lines.map((l, i) => (
        <div key={i} style={{ color: i === 0 ? INK : MUTED, fontWeight: i === 0 ? 700 : 400 }}>{l}</div>
      ))}
    </div>
  );
};

/** Status row with spinner→check lifecycle. */
export const AgentRow: React.FC<{ f: number; at: number; doneAt: number; label: string; sub?: string }> = ({ f, at, doneAt, label, sub }) => {
  if (f < at) return null;
  const inO = interpolate(f, [at, at + 6], [0, 1], clamp);
  const done = f >= doneAt;
  const spin = ((f - at) * 24) % 360;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0", opacity: inO, borderBottom: `1px solid ${HAIR}` }}>
      {done ? (
        <svg width={20} height={20}><path d="M4 10 L9 15 L16 5" fill="none" stroke={INK} strokeWidth={2.5} /></svg>
      ) : (
        <svg width={20} height={20} style={{ transform: `rotate(${spin}deg)` }}>
          <circle cx={10} cy={10} r={7} fill="none" stroke={FAINT} strokeWidth={2.5} />
          <path d="M10 3 A7 7 0 0 1 17 10" fill="none" stroke={INK} strokeWidth={2.5} />
        </svg>
      )}
      <div style={{ flex: 1 }}>
        <div style={{ color: INK, fontFamily: MONO, fontSize: 15, fontWeight: 700, letterSpacing: "0.07em" }}>{label}</div>
        {sub ? <div style={{ color: MUTED, fontFamily: MONO, fontSize: 12.5, marginTop: 3, letterSpacing: "0.03em" }}>{sub}</div> : null}
      </div>
    </div>
  );
};
