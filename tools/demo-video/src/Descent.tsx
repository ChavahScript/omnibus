import React, { useMemo } from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";

/**
 * Shot 3 — "DESCENT: Through the Black Glass and Back."
 *
 * The camera is sucked through the dark screen of the real HP laptop (the
 * exact last frame of assembled-seamless.mp4, public/stills/shot3-plate.png)
 * into the machine's world: a monochrome dark Windows desktop. The spoken
 * line is enacted by the OS itself — file-properties for the model, Notepad
 * typing at reading speed, a Wi-Fi-loss toast, a blocked cloud dialog, a
 * ready-tonight notification, a snap-grid workspace — until the machine is
 * shut down on "powered off" and we're back outside on the dark laptop, one
 * terminal cursor blinking awake.
 *
 * 1920x1080 · 30 fps · 450 frames (15 s) · silent (the line is read live).
 */

export const FPS = 30;
export const DESCENT_DURATION_FRAMES = 450;

const INK = "#f6f6f4";
const BG = "#0c0c0e";
const MUTED = "rgba(246,246,244,0.62)";
const FAINT = "rgba(246,246,244,0.26)";
const HAIR = "rgba(246,246,244,0.14)";
const GRID_DOT = "rgba(246,246,244,0.07)";
const WIN_BG = "#18181b";
const BAR_BG = "rgba(22,22,24,0.94)";
const SANS = `"Helvetica Neue", Helvetica, -apple-system, "Segoe UI", Arial, sans-serif`;
const MONO = `Menlo, "SF Mono", Consolas, monospace`;

/** Screen-glass quad of the real plate — measured on fine coordinate grids
 * (docs/demo-assets/_scout/tl_tr_measure.png, bl_br_measure.png). Keystone
 * converges toward the hinge: the screen leans back, viewed from above. */
const QUAD = {
  TL: [345, 103],
  TR: [1526, 101],
  BR: [1490, 695],
  BL: [405, 691],
} as const;
const QUAD_CX = (QUAD.TL[0] + QUAD.TR[0] + QUAD.BR[0] + QUAD.BL[0]) / 4;
const QUAD_CY = (QUAD.TL[1] + QUAD.TR[1] + QUAD.BR[1] + QUAD.BL[1]) / 4;
const GLASS_TILT_DEG =
  (Math.atan2(QUAD.TR[1] - QUAD.TL[1], QUAD.TR[0] - QUAD.TL[0]) * 180) / Math.PI;
const QUAD_POINTS = `${QUAD.TL} ${QUAD.TR} ${QUAD.BR} ${QUAD.BL}`;

const PLATE = "stills/shot3-plate.png";

const clamp = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };

/** Shared dive camera motion (still layer + desktop etching use the same). */
const diveMotion = (f: number) => {
  const z1 = interpolate(f, [0, 8], [1.0, 1.015], clamp);
  const z2 = interpolate(f, [8, 26], [1.015, 2.6], { ...clamp, easing: Easing.in(Easing.cubic) });
  const z3 = interpolate(f, [26, 31], [2.6, 6.0], clamp);
  const Z = f < 8 ? z1 : f < 26 ? z2 : z3;
  const p = interpolate(f, [8, 31], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  return {
    Z,
    p,
    cx: QUAD_CX + (960 - QUAD_CX) * p,
    cy: QUAD_CY + (540 - QUAD_CY) * p,
    rot: -GLASS_TILT_DEG * p,
  };
};

/** A quad corner as moved by the dive transform (screen space). */
const moveCorner = (
  [qx, qy]: readonly [number, number] | readonly number[],
  m: ReturnType<typeof diveMotion>,
) => {
  const x = (qx - QUAD_CX) * m.Z;
  const y = (qy - QUAD_CY) * m.Z;
  const r = (m.rot * Math.PI) / 180;
  return [x * Math.cos(r) - y * Math.sin(r) + m.cx, x * Math.sin(r) + y * Math.cos(r) + m.cy];
};

/** CSS matrix3d mapping the 1920x1080 desktop onto 4 destination corners
 * (TL,TR,BR,BL) — a projective corner-pin, solved by Gaussian elimination. */
const cornerPin = (dst: number[][]) => {
  const src = [
    [0, 0],
    [1920, 0],
    [1920, 1080],
    [0, 1080],
  ];
  const M: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    M.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    M.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  const n = 8;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    for (let k = c; k <= n; k++) M[c][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const factor = M[r][c];
      for (let k = c; k <= n; k++) M[r][k] -= factor * M[c][k];
    }
  }
  const h = M.map(row => row[n]);
  return `matrix3d(${h[0]},${h[3]},0,${h[6]},${h[1]},${h[4]},0,${h[7]},0,0,1,0,${h[2]},${h[5]},0,1)`;
};

const mulberry32 = (seed: number) => {
  let a = seed;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export const Descent: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ backgroundColor: BG, fontFamily: SANS }}>
      <Img src={staticFile(PLATE)} style={{ position: "absolute", width: 1, height: 1, opacity: 0 }} />

      {/* THE MACHINE'S WORLD — the Windows desktop behind the glass */}
      {f < 378 ? <Desktop f={f} /> : null}

      {/* THE STILL — dives past camera f0–31, returns after shutdown.
          The tail is a clean static hold: the Higgsfield fly-out clip
          (shot3b-flyout) continues from this exact frame. */}
      {f < 31 ? <DivePlate f={f} /> : null}
      {f >= 376 ? <ReturnPlate f={f} /> : null}
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Beat 0 — the dive (f0–31), unchanged mechanics
// ---------------------------------------------------------------------------

const DivePlate: React.FC<{ f: number }> = ({ f }) => {
  const { Z, cx, cy, rot } = diveMotion(f);
  const hole = interpolate(f, [6, 18], [0, 1], clamp);
  const ghost = interpolate(f, [20, 26, 31], [0, 0.18, 0.18], clamp);
  const vignette = interpolate(f, [14, 30], [0, 1], clamp);

  const group = (zoom: number) =>
    `translate(${cx}, ${cy}) rotate(${rot}) scale(${zoom}) translate(${-QUAD_CX}, ${-QUAD_CY})`;

  return (
    <AbsoluteFill>
      <svg width={1920} height={1080} viewBox="0 0 1920 1080">
        <defs>
          <mask id="glass" maskUnits="userSpaceOnUse" x={0} y={0} width={1920} height={1080}>
            <rect x={0} y={0} width={1920} height={1080} fill="white" />
            <polygon points={QUAD_POINTS} fill="black" fillOpacity={hole} />
          </mask>
        </defs>
        {ghost > 0 ? (
          <>
            <g transform={group(Z * 0.965)} opacity={ghost}>
              <image href={staticFile(PLATE)} width={1920} height={1080} mask="url(#glass)" preserveAspectRatio="none" />
            </g>
            <g transform={group(Z * 1.035)} opacity={ghost}>
              <image href={staticFile(PLATE)} width={1920} height={1080} mask="url(#glass)" preserveAspectRatio="none" />
            </g>
          </>
        ) : null}
        <g transform={group(Z)}>
          <image href={staticFile(PLATE)} width={1920} height={1080} mask="url(#glass)" preserveAspectRatio="none" />
        </g>
      </svg>
      <AbsoluteFill
        style={{
          background: "radial-gradient(ellipse at center, rgba(12,12,14,0) 35%, #0c0c0e 78%)",
          opacity: vignette,
        }}
      />
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// The Windows desktop (beats 1–6)
// ---------------------------------------------------------------------------

/** Win11-style snap cells (taskbar 56, margins 16). */
const TASKBAR_H = 56;
const CELL_W = (1920 - 3 * 16) / 2; // 936
const CELL_H = (1080 - TASKBAR_H - 3 * 16) / 2; // 488
const CELLS = {
  TL: [16, 16, CELL_W, CELL_H],
  TR: [16 + CELL_W + 16, 16, CELL_W, CELL_H],
  BL: [16, 16 + CELL_H + 16, CELL_W, CELL_H],
  BR: [16 + CELL_W + 16, 16 + CELL_H + 16, CELL_W, CELL_H],
} as const;

const SHUTDOWN_CLICK = 362;

const Desktop: React.FC<{ f: number }> = ({ f }) => {
  // ETCHED ON THE GLASS: the whole desktop is corner-pinned onto the screen
  // quad as it flies at the camera, un-warping to full frame exactly as the
  // quad grows past the viewport — the panel IS the desktop until we're
  // through it.
  const m = diveMotion(f);
  // 0 = pinned to the moving glass quad · 1 = flat full frame
  const unwarp = interpolate(m.Z, [1.5, 1.8], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const etched = f < 31 && unwarp < 1;
  const FULL = [
    [0, 0],
    [1920, 0],
    [1920, 1080],
    [0, 1080],
  ];
  let matrix: string | undefined;
  if (etched) {
    const tq = [QUAD.TL, QUAD.TR, QUAD.BR, QUAD.BL].map(c => moveCorner(c, m));
    const dst = tq.map((c, i) => [
      c[0] + (FULL[i][0] - c[0]) * unwarp,
      c[1] + (FULL[i][1] - c[1]) * unwarp,
    ]);
    matrix = cornerPin(dst);
  }
  // the screen lights up as the hole opens
  const reveal = interpolate(f, [6, 14], [0.15, 1], clamp);
  // light bloom while the glass opens
  const bloom = interpolate(f, [8, 30], [0, 1], clamp) * interpolate(f, [38, 62], [1, 0], clamp);
  // the machine dies on "powered off"
  const power = interpolate(f, [364, 374], [1, 0], { ...clamp, easing: Easing.in(Easing.quad) });

  return (
    <AbsoluteFill style={{ opacity: reveal * power }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: matrix,
          transformOrigin: "0 0",
        }}
      >
        <Wallpaper />
        {bloom > 0 ? (
          <AbsoluteFill
            style={{
              background:
                "radial-gradient(ellipse 900px 560px at 960px 540px, rgba(246,246,244,0.12), rgba(246,246,244,0.03) 55%, transparent 75%)",
              opacity: bloom,
            }}
          />
        ) : null}

        {/* windows — cascade order matters (later = on top) */}
        <PropertiesWindow f={f} />
        <NotepadWindow f={f} />
        <FleetWindow f={f} />
        <BrainWindow f={f} />

        <SnapOverlay f={f} />

        {/* dialogs above windows */}
        <BlockDialog f={f} />
        <ShutdownDialog f={f} />

        {/* toasts above dialogs */}
        <WifiToast f={f} />
        <ReadyToast f={f} />

        <Taskbar f={f} />
        <Pointer f={f} />
      </div>
    </AbsoluteFill>
  );
};

const Wallpaper: React.FC = () => {
  const dots = useMemo(() => {
    const out: Array<[number, number]> = [];
    for (let x = 32; x < 1920; x += 64) for (let y = 28; y < 1080; y += 64) out.push([x, y]);
    return out;
  }, []);
  return (
    <AbsoluteFill style={{ background: "radial-gradient(ellipse at 50% 42%, #121215, #0c0c0e 75%)" }}>
      <svg width={1920} height={1080} viewBox="0 0 1920 1080" style={{ position: "absolute" }}>
        {dots.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={1.6} fill={GRID_DOT} />
        ))}
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: SANS,
          fontWeight: 700,
          fontSize: 150,
          letterSpacing: "-0.035em",
          color: "rgba(246,246,244,0.05)",
        }}
      >
        Omnibus
      </div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Window chrome
// ---------------------------------------------------------------------------

type Rect = readonly [number, number, number, number];

/** Generic Win11-ish window: opens, optionally snaps to a cell, minimizes. */
const Win: React.FC<{
  f: number;
  openAt: number;
  base: Rect;
  snap?: { at: number; to: Rect };
  minimizeAt?: number;
  title: string;
  children: React.ReactNode;
  statusBar?: string;
}> = ({ f, openAt, base, snap, minimizeAt, title, children, statusBar }) => {
  if (f < openAt) return null;
  const open = interpolate(f, [openAt, openAt + 6], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  let [x, y, w, h] = base;
  if (snap) {
    const t = interpolate(f, [snap.at, snap.at + 12], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
    x = x + (snap.to[0] - x) * t;
    y = y + (snap.to[1] - y) * t;
    w = w + (snap.to[2] - w) * t;
    h = h + (snap.to[3] - h) * t;
  }
  let minScale = 1;
  let minOpacity = 1;
  let minShift = 0;
  if (minimizeAt !== undefined && f >= minimizeAt) {
    const m = interpolate(f, [minimizeAt, minimizeAt + 10], [0, 1], { ...clamp, easing: Easing.in(Easing.cubic) });
    minScale = 1 - 0.85 * m;
    minOpacity = 1 - m;
    minShift = m * (1052 - (y + h / 2));
  }
  if (minOpacity <= 0) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: w,
        height: h,
        opacity: open * minOpacity,
        transform: `translateY(${minShift}px) scale(${(0.96 + 0.04 * open) * minScale})`,
        transformOrigin: "center",
        background: WIN_BG,
        border: `1px solid ${HAIR}`,
        borderRadius: 8,
        boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: 40,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          paddingLeft: 14,
          borderBottom: `1px solid ${HAIR}`,
          color: MUTED,
          fontFamily: SANS,
          fontSize: 19,
          letterSpacing: "0.01em",
        }}
      >
        <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden" }}>{title}</span>
        <span style={{ display: "flex", gap: 0, color: MUTED, fontFamily: MONO, fontSize: 16 }}>
          <span style={{ width: 44, textAlign: "center" }}>—</span>
          <span style={{ width: 44, textAlign: "center" }}>▢</span>
          <span style={{ width: 44, textAlign: "center" }}>✕</span>
        </span>
      </div>
      <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>{children}</div>
      {statusBar ? (
        <div
          style={{
            height: 30,
            flexShrink: 0,
            borderTop: `1px solid ${HAIR}`,
            display: "flex",
            alignItems: "center",
            paddingLeft: 12,
            color: MUTED,
            fontFamily: MONO,
            fontSize: 15,
            letterSpacing: "0.04em",
          }}
        >
          {statusBar}
        </div>
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Beat 1 — "seven-billion-parameter AI model": file properties
// ---------------------------------------------------------------------------

const PropertiesWindow: React.FC<{ f: number }> = ({ f }) => {
  const FINAL = "7,000,000,000";
  const rnds = useMemo(() => {
    const r = mulberry32(41);
    return Array.from({ length: FINAL.length }, () => r());
  }, []);
  let digitIndex = -1;
  const flap = FINAL.split("").map((ch, i) => {
    if (ch === ",") {
      return (
        <span key={i} style={{ display: "inline-block", width: "0.32em" }}>
          {ch}
        </span>
      );
    }
    digitIndex += 1;
    const settle = 51 + digitIndex * 2;
    const value = f >= settle ? ch : String(Math.floor(rnds[i] * 10 + f / 2) % 10);
    return (
      <span key={i} style={{ display: "inline-block", width: "0.58em", textAlign: "center" }}>
        {value}
      </span>
    );
  });
  const row = (label: string, value: React.ReactNode, showAt: number) =>
    f >= showAt ? (
      <div style={{ display: "flex", marginBottom: 16, opacity: interpolate(f, [showAt, showAt + 5], [0, 1], clamp) }}>
        <div style={{ width: 200, color: MUTED, fontFamily: MONO, fontSize: 20, letterSpacing: "0.04em", flexShrink: 0 }}>
          {label}
        </div>
        <div style={{ color: INK, fontFamily: MONO, fontSize: 20, letterSpacing: "0.02em" }}>{value}</div>
      </div>
    ) : null;
  return (
    <Win
      f={f}
      openAt={36}
      base={[180, 120, 680, 560]}
      snap={{ at: 232, to: CELLS.TL }}
      minimizeAt={318}
      title="mistral-7b.gguf Properties"
    >
      <div style={{ padding: "26px 30px" }}>
        {row("Type:", "GGUF language model", 40)}
        {row("Size:", "4.4 GB (4,733,640,704 bytes)", 43)}
        {f >= 46 ? (
          <div style={{ margin: "22px 0 26px", opacity: interpolate(f, [46, 52], [0, 1], clamp) }}>
            <div style={{ color: MUTED, fontFamily: MONO, fontSize: 20, letterSpacing: "0.04em", marginBottom: 6 }}>
              Parameters:
            </div>
            <div style={{ color: INK, fontFamily: SANS, fontWeight: 700, fontSize: 74, letterSpacing: "-0.035em", lineHeight: 1 }}>
              {flap}
            </div>
          </div>
        ) : null}
        {row("Quantized:", "Q4_K_M · runs in 16 GB RAM", 72)}
        {row("Location:", "C:\\Omnibus\\models", 76)}
        {row("Runs on:", "this laptop. no server.", 82)}
      </div>
    </Win>
  );
};

// ---------------------------------------------------------------------------
// Beat 2 — "at reading speed": Notepad typing tokens
// ---------------------------------------------------------------------------

const NOTE_LINES: Array<Array<string>> = [
  ["> the", " fast", "est", " way", " to", " own", " your", " ide", "as"],
  ["  is", " to", " own", " the", " mach", "ine."],
  ["", "auditor:", " enrich", "ing", " against", " your", " work", "space…"],
  ["developer:", " compos", "ing", " the", " brief…"],
  ["risk:", " reviewed", "  ·  feas", "ibility:", " high"],
];

const noteBorn = (() => {
  const born: number[][] = [];
  let t = 104;
  NOTE_LINES.forEach((line, li) => {
    born.push(
      line.map((_, ci) => {
        const fast = li < 2; // the spoken "reading speed" beat types at ~12 tok/s
        t += fast ? 2.5 : 6.5;
        return Math.round(t);
      }),
    );
    t += 10;
  });
  return born;
})();

const NotepadWindow: React.FC<{ f: number }> = ({ f }) => {
  const tokS = f < 150 ? "12.4 tok/s" : "11.8 tok/s";
  let lastVisible: [number, number] | null = null;
  NOTE_LINES.forEach((line, li) =>
    line.forEach((_, ci) => {
      if (f >= noteBorn[li][ci]) lastVisible = [li, ci];
    }),
  );
  return (
    <Win
      f={f}
      openAt={99}
      base={[820, 210, 780, 500]}
      snap={{ at: 240, to: CELLS.TR }}
      minimizeAt={326}
      title="brief.md — Notepad"
      statusBar={`Ln ${lastVisible ? lastVisible[0] + 1 : 1}, Col 12   ·   ${tokS}   ·   UTF-8`}
    >
      <div style={{ padding: "22px 26px", fontFamily: MONO, fontSize: 24, lineHeight: 1.65, letterSpacing: "0.02em" }}>
        {NOTE_LINES.map((line, li) => (
          <div key={li} style={{ whiteSpace: "pre", minHeight: line[0] === "" ? 20 : undefined }}>
            {line.map((chunk, ci) => {
              if (f < noteBorn[li][ci]) return null;
              const isNewest = lastVisible !== null && lastVisible[0] === li && lastVisible[1] === ci;
              const settled = f - noteBorn[li][ci] > 8;
              return (
                <span
                  key={ci}
                  style={{
                    color: settled && !isNewest ? MUTED : INK,
                    outline: isNewest ? `2px solid ${FAINT}` : "none",
                    outlineOffset: 3,
                  }}
                >
                  {chunk}
                </span>
              );
            })}
            {lastVisible !== null && lastVisible[0] === li ? (
              <span
                style={{
                  display: "inline-block",
                  width: 13,
                  height: 26,
                  background: Math.floor(f / 16) % 2 === 0 ? INK : "transparent",
                  verticalAlign: "text-bottom",
                  marginLeft: 4,
                }}
              />
            ) : null}
          </div>
        ))}
      </div>
    </Win>
  );
};

// ---------------------------------------------------------------------------
// Beat 5 — the workspace: fleet + second brain windows
// ---------------------------------------------------------------------------

const FleetWindow: React.FC<{ f: number }> = ({ f }) => {
  const row = (name: string, sub: string, status: string, showAt: number) =>
    f >= showAt ? (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "16px 4px",
          borderBottom: `1px solid ${HAIR}`,
          opacity: interpolate(f, [showAt, showAt + 5], [0, 1], clamp),
        }}
      >
        <span style={{ width: 14, height: 14, borderRadius: 7, background: INK, marginRight: 18, flexShrink: 0 }} />
        <span style={{ color: INK, fontFamily: MONO, fontSize: 22, letterSpacing: "0.03em", flex: 1 }}>
          {name}
          <span style={{ color: MUTED }}>{"  ·  "}{sub}</span>
        </span>
        <span style={{ color: MUTED, fontFamily: MONO, fontSize: 19, letterSpacing: "0.06em" }}>{status}</span>
      </div>
    ) : null;
  return (
    <Win f={f} openAt={248} base={CELLS.BL} minimizeAt={334} title="Omnibus — Home Fleet">
      <div style={{ padding: "18px 30px" }}>
        {row("HP-DRAWER", "this PC", "BRIDGE", 252)}
        {row("FLEET-01", "MACBOOK-AIR", "CONNECTED", 258)}
        {row("FLEET-02", "THINKPAD-T480", "CONNECTED", 264)}
        {f >= 272 ? (
          <div
            style={{
              marginTop: 22,
              color: MUTED,
              fontFamily: MONO,
              fontSize: 18,
              letterSpacing: "0.08em",
              opacity: interpolate(f, [272, 278], [0, 1], clamp),
            }}
          >
            3 MACHINES · ONE BRAIN · LAN ONLY
          </div>
        ) : null}
      </div>
    </Win>
  );
};

const BrainWindow: React.FC<{ f: number }> = ({ f }) => {
  const nodes = useMemo(() => {
    const r = mulberry32(23);
    return Array.from({ length: 14 }, () => [80 + r() * 700, 40 + r() * 240] as const);
  }, []);
  const edges = useMemo(() => {
    const r = mulberry32(77);
    return Array.from({ length: 16 }, () => [Math.floor(r() * 14), Math.floor(r() * 14)] as const).filter(
      ([a, b]) => a !== b,
    );
  }, []);
  const grow = interpolate(f, [258, 300], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const visNodes = Math.ceil(nodes.length * grow);
  return (
    <Win f={f} openAt={256} base={CELLS.BR} minimizeAt={342} title="Second Brain — HP-DRAWER">
      <div style={{ position: "absolute", inset: 0 }}>
        <svg width="100%" height="72%" viewBox="0 0 860 320">
          {edges.map(([a, b], i) =>
            a < visNodes && b < visNodes ? (
              <line
                key={i}
                x1={nodes[a][0]}
                y1={nodes[a][1]}
                x2={nodes[b][0]}
                y2={nodes[b][1]}
                stroke={FAINT}
                strokeWidth={1.5}
              />
            ) : null,
          )}
          {nodes.slice(0, visNodes).map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r={5} fill={INK} />
          ))}
        </svg>
        <div
          style={{
            position: "absolute",
            left: 30,
            bottom: 20,
            color: MUTED,
            fontFamily: MONO,
            fontSize: 19,
            letterSpacing: "0.06em",
          }}
        >
          1,204 NODES · 87 SESSIONS · 14 PROJECTS · REMEMBERS EVERYTHING
        </div>
      </div>
    </Win>
  );
};

/** Win11 snap-layout grid flashing while the windows arrange themselves. */
const SnapOverlay: React.FC<{ f: number }> = ({ f }) => {
  const vis =
    interpolate(f, [226, 234], [0, 1], clamp) * interpolate(f, [264, 274], [1, 0], clamp);
  if (vis <= 0) return null;
  return (
    <svg width={1920} height={1080} viewBox="0 0 1920 1080" style={{ position: "absolute", opacity: vis }}>
      {Object.values(CELLS).map((c, i) => (
        <rect
          key={i}
          x={c[0]}
          y={c[1]}
          width={c[2]}
          height={c[3]}
          rx={8}
          fill="rgba(246,246,244,0.03)"
          stroke={FAINT}
          strokeWidth={2}
          strokeDasharray="10 10"
        />
      ))}
    </svg>
  );
};

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

const Button: React.FC<{ primary?: boolean; label: string; pressed?: boolean }> = ({ primary, label, pressed }) => (
  <div
    style={{
      padding: "10px 30px",
      borderRadius: 6,
      border: primary ? `2px solid ${INK}` : `2px solid ${FAINT}`,
      background: primary ? INK : "transparent",
      color: primary ? BG : INK,
      fontFamily: MONO,
      fontSize: 20,
      fontWeight: primary ? 700 : 400,
      letterSpacing: "0.06em",
      transform: pressed ? "scale(0.94)" : "none",
    }}
  >
    {label}
  </div>
);

/** "Privately." — cloud-sync.exe gets blocked. */
const BlockDialog: React.FC<{ f: number }> = ({ f }) => {
  if (f < 168 || f > 196) return null;
  const open = interpolate(f, [168, 174], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const close = interpolate(f, [190, 196], [1, 0], clamp);
  const pressed = f >= 185 && f <= 188;
  return (
    <div
      style={{
        position: "absolute",
        left: 620,
        top: 330,
        width: 680,
        opacity: open * close,
        transform: `scale(${0.96 + 0.04 * open})`,
        background: WIN_BG,
        border: `1px solid ${HAIR}`,
        borderRadius: 8,
        boxShadow: "0 32px 80px rgba(0,0,0,0.65)",
        padding: "28px 32px 26px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 14 }}>
        <svg width={34} height={34} viewBox="0 0 34 34">
          <path d="M17 3 L30 8 V16 C30 24 24 29 17 31 C10 29 4 24 4 16 V8 Z" fill="none" stroke={INK} strokeWidth={2.5} />
          <line x1={17} y1={12} x2={17} y2={20} stroke={INK} strokeWidth={2.5} />
          <circle cx={17} cy={25} r={1.8} fill={INK} />
        </svg>
        <div style={{ color: INK, fontFamily: SANS, fontSize: 26, fontWeight: 700, letterSpacing: "-0.01em" }}>
          cloud-sync.exe is trying to send data
        </div>
      </div>
      <div style={{ color: MUTED, fontFamily: MONO, fontSize: 20, letterSpacing: "0.02em", lineHeight: 1.5, marginBottom: 24 }}>
        Destination: api.cloud-sync.com · Payload: C:\ideas\*
      </div>
      <div style={{ display: "flex", gap: 16, justifyContent: "flex-end" }}>
        <Button label="ALLOW" />
        <Button label="BLOCK" primary pressed={pressed} />
      </div>
    </div>
  );
};

/** "powered off." — the machine is shut down on cue. */
const ShutdownDialog: React.FC<{ f: number }> = ({ f }) => {
  if (f < 348) return null;
  const open = interpolate(f, [348, 354], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const pressed = f >= SHUTDOWN_CLICK && f <= SHUTDOWN_CLICK + 3;
  return (
    <div
      style={{
        position: "absolute",
        left: 660,
        top: 400,
        width: 600,
        opacity: open,
        transform: `scale(${0.96 + 0.04 * open})`,
        background: WIN_BG,
        border: `1px solid ${HAIR}`,
        borderRadius: 8,
        boxShadow: "0 32px 80px rgba(0,0,0,0.65)",
        padding: "28px 32px 26px",
      }}
    >
      <div style={{ color: INK, fontFamily: SANS, fontSize: 26, fontWeight: 700, marginBottom: 12 }}>
        Shut down HP-DRAWER?
      </div>
      <div style={{ color: MUTED, fontFamily: MONO, fontSize: 20, lineHeight: 1.5, marginBottom: 24 }}>
        Your second brain is saved. It will remember — even powered off.
      </div>
      <div style={{ display: "flex", gap: 16, justifyContent: "flex-end" }}>
        <Button label="CANCEL" />
        <Button label="SHUT DOWN" primary pressed={pressed} />
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

const Toast: React.FC<{
  f: number;
  showAt: number;
  hideAt: number;
  inverted?: boolean;
  children: React.ReactNode;
}> = ({ f, showAt, hideAt, inverted, children }) => {
  if (f < showAt || f > hideAt + 8) return null;
  const slide = interpolate(f, [showAt, showAt + 8], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const out = interpolate(f, [hideAt, hideAt + 8], [1, 0], clamp);
  return (
    <div
      style={{
        position: "absolute",
        right: 24,
        bottom: TASKBAR_H + 24,
        width: 500,
        opacity: slide * out,
        transform: `translateX(${(1 - slide) * 48}px)`,
        background: inverted ? INK : WIN_BG,
        border: `1px solid ${inverted ? INK : HAIR}`,
        borderRadius: 8,
        boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
        padding: "22px 26px",
      }}
    >
      {children}
    </div>
  );
};

/** "Locally." — the network dies; the typing does not. */
const WifiToast: React.FC<{ f: number }> = ({ f }) => (
  <Toast f={f} showAt={142} hideAt={182}>
    <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
      <svg width={40} height={40} viewBox="0 0 40 40">
        <path d="M6 16 C14 8 26 8 34 16" fill="none" stroke={MUTED} strokeWidth={2.5} />
        <path d="M11 22 C16 17 24 17 29 22" fill="none" stroke={MUTED} strokeWidth={2.5} />
        <circle cx={20} cy={29} r={2.5} fill={MUTED} />
        <line x1={8} y1={34} x2={32} y2={6} stroke={INK} strokeWidth={3} />
      </svg>
      <div>
        <div style={{ color: INK, fontFamily: SANS, fontSize: 24, fontWeight: 700 }}>Wi-Fi disconnected</div>
        <div style={{ color: MUTED, fontFamily: MONO, fontSize: 18, letterSpacing: "0.03em", marginTop: 6 }}>
          Omnibus keeps working — nothing leaves this machine
        </div>
      </div>
    </div>
  </Toast>
);

/** "Tonight." — the inverted punch. */
const ReadyToast: React.FC<{ f: number }> = ({ f }) => (
  <Toast f={f} showAt={200} hideAt={244} inverted>
    <div style={{ color: BG, fontFamily: SANS, fontSize: 30, fontWeight: 700, letterSpacing: "-0.01em" }}>
      Omnibus is ready
    </div>
    <div style={{ color: "rgba(12,12,14,0.72)", fontFamily: MONO, fontSize: 19, letterSpacing: "0.08em", marginTop: 8 }}>
      TONIGHT · 9:47 PM · NO ACCOUNT · NO CLOUD
    </div>
  </Toast>
);

// ---------------------------------------------------------------------------
// Taskbar + pointer
// ---------------------------------------------------------------------------

const Taskbar: React.FC<{ f: number }> = ({ f }) => {
  const wifiDead = f >= 150;
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: TASKBAR_H,
        background: BAR_BG,
        borderTop: `1px solid ${HAIR}`,
        display: "flex",
        alignItems: "center",
      }}
    >
      {/* centered app glyphs */}
      <div style={{ position: "absolute", left: 0, right: 0, display: "flex", justifyContent: "center", gap: 30 }}>
        <svg width={22} height={22} viewBox="0 0 22 22">
          <rect x={1} y={1} width={9} height={9} fill={INK} />
          <rect x={12} y={1} width={9} height={9} fill={INK} />
          <rect x={1} y={12} width={9} height={9} fill={INK} />
          <rect x={12} y={12} width={9} height={9} fill={INK} />
        </svg>
        <svg width={22} height={22} viewBox="0 0 22 22">
          <circle cx={9.5} cy={9.5} r={7} fill="none" stroke={MUTED} strokeWidth={2.5} />
          <line x1={15} y1={15} x2={21} y2={21} stroke={MUTED} strokeWidth={2.5} />
        </svg>
        <svg width={22} height={22} viewBox="0 0 22 22">
          <path d="M1 6 h7 l2 3 h11 v10 h-20 z" fill="none" stroke={MUTED} strokeWidth={2} />
        </svg>
        <svg width={22} height={22} viewBox="0 0 22 22">
          <rect x={1} y={2} width={20} height={18} rx={2} fill="none" stroke={MUTED} strokeWidth={2} />
          <path d="M5 8 l4 4 -4 4" fill="none" stroke={MUTED} strokeWidth={2} />
          <line x1={11} y1={16} x2={17} y2={16} stroke={MUTED} strokeWidth={2} />
        </svg>
      </div>
      {/* system tray */}
      <div
        style={{
          position: "absolute",
          right: 22,
          display: "flex",
          alignItems: "center",
          gap: 18,
          color: MUTED,
          fontFamily: MONO,
          fontSize: 17,
          letterSpacing: "0.04em",
        }}
      >
        <svg width={20} height={20} viewBox="0 0 40 40">
          <path d="M6 16 C14 8 26 8 34 16" fill="none" stroke={MUTED} strokeWidth={3} />
          <path d="M11 22 C16 17 24 17 29 22" fill="none" stroke={MUTED} strokeWidth={3} />
          <circle cx={20} cy={29} r={3} fill={MUTED} />
          {wifiDead ? <line x1={8} y1={34} x2={32} y2={6} stroke={INK} strokeWidth={3.5} /> : null}
        </svg>
        <span style={{ color: f >= 200 && f <= 244 ? INK : MUTED, fontWeight: f >= 200 && f <= 244 ? 700 : 400 }}>
          9:47 PM
        </span>
      </div>
    </div>
  );
};

/** The white arrow pointer: rests, walks to BLOCK, walks to SHUT DOWN. */
const POINTER_PATH: Array<[number, number, number]> = [
  // [frame, x, y]
  [40, 1240, 760],
  [160, 1240, 760],
  [176, 1178, 505], // BLOCK button
  [196, 1178, 505],
  [220, 1300, 780],
  [340, 1300, 780],
  [352, 1146, 575], // SHUT DOWN button
  [450, 1146, 575],
];

const Pointer: React.FC<{ f: number }> = ({ f }) => {
  if (f < 40) return null;
  const xs = POINTER_PATH.map(p => p[0]);
  const x = interpolate(f, xs, POINTER_PATH.map(p => p[1]), { ...clamp, easing: Easing.inOut(Easing.quad) });
  const y = interpolate(f, xs, POINTER_PATH.map(p => p[2]), { ...clamp, easing: Easing.inOut(Easing.quad) });
  const clicking = (f >= 185 && f <= 188) || (f >= SHUTDOWN_CLICK && f <= SHUTDOWN_CLICK + 3);
  return (
    <svg
      width={30}
      height={30}
      viewBox="0 0 30 30"
      style={{ position: "absolute", left: x, top: y, transform: clicking ? "scale(0.85)" : "none" }}
    >
      <path d="M4 2 L4 24 L10 18 L14 27 L18 25 L14 16 L22 16 Z" fill={INK} stroke={BG} strokeWidth={1.5} />
    </svg>
  );
};

// ---------------------------------------------------------------------------
// Return + wake (unchanged mechanics, retimed)
// ---------------------------------------------------------------------------

const ReturnPlate: React.FC<{ f: number }> = ({ f }) => {
  const fade = interpolate(f, [376, 398], [0, 1], clamp);
  const settle = interpolate(f, [376, 400], [1.06, 1.0], { ...clamp, easing: Easing.out(Easing.cubic) });
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <Img
        src={staticFile(PLATE)}
        style={{
          width: "100%",
          height: "100%",
          transform: `scale(${settle})`,
          transformOrigin: "center",
        }}
      />
    </AbsoluteFill>
  );
};
