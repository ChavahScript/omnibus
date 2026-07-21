import React from "react";
import { AbsoluteFill, Easing, getStaticFiles, interpolate, OffthreadVideo, staticFile, useCurrentFrame } from "remotion";
import {
  AgentRow, Backdrop, BG, Caption, Card, clamp, FAINT, HAIR, INK, MONO, MUTED,
  Phone, QRCodeArt, SANS, Terminal, TermLine, Win, WIN_BG, mulberry32,
} from "./film-ui";

/**
 * ACT II — "The Demo" (film 1:02→2:02). A code-rendered recreation of the
 * real product flow in the film's design system, beat-timed to the VO script
 * in docs/DEMO-VIDEO.md. 1920x1080 · 30fps · 1800 frames (60s) · silent.
 *
 * Beats: pair (0-9s) · idea→agents (9-24s) · brief (24-31s) · recall
 * (31-38s) · fleet (38-48s) · gate (48-55s) · closing snap grid (55-60s).
 */

export const ACT2_DURATION_FRAMES = 1800;

const BOOT: TermLine[] = [
  { at: 15, text: "omnibus-bridge start", kind: "cmd", typed: true },
  { at: 48, text: "Local intelligence is ready; initializing the multi-agent orchestration bridge…", kind: "out" },
  { at: 66, text: "Second Brain · knowledge graph loaded (1,204 nodes)", kind: "out" },
  { at: 80, text: "Sized for this laptop · 16 GB → BALANCED tier", kind: "out" },
  { at: 96, text: "Scan to pair — one-time code, expires in 120s", kind: "ok" },
];

const GATE: TermLine[] = [
  { at: 1452, text: 'git commit -m "quick fix"', kind: "cmd", typed: true },
  { at: 1492, text: "[BLOCK] anti-pattern · sanitize-before-verify", kind: "block" },
  { at: 1500, text: "  Wrong:   sanitize(payload) before HMAC verify", kind: "out" },
  { at: 1508, text: "  Correct: verify the raw payload, sanitize after", kind: "out" },
  { at: 1524, text: "omnibus-bridge hook check --fix", kind: "cmd", typed: true },
  { at: 1558, text: "1 line corrected · lesson recorded 2 days ago", kind: "out" },
  { at: 1572, text: "git commit — ✓ passed", kind: "ok" },
];

const IDEA_1 = "offline export for the reports screen";
const IDEA_2 = "sync those exports when back online";

export const Act2: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ backgroundColor: BG, fontFamily: SANS }}>
      <Backdrop />

      {/* B1 · PAIR — the REAL bridge boot (vhs capture: real CLI, real tunnel,
          real QR) left, phone scanning right */}
      <Win f={f} openAt={6} rect={[96, 100, 980, 680]} title="HP-DRAWER — omnibus-bridge" closeAt={262}>
        {f >= 8 ? (
          <OffthreadVideo
            src={staticFile("captures/term-bridge.mp4")}
            style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top left" }}
            playbackRate={1.5}
            muted
          />
        ) : null}
      </Win>
      {f < 270 ? (
        <Phone f={f} openAt={40} x={1180} y={140} scale={0.82}>
          <PairScreen f={f} />
        </Phone>
      ) : null}
      <Caption f={f} from={30} to={250} text="ONE QR · NO ACCOUNTS · NO CLOUD" />

      {/* B2+B3 · IDEA → AGENTS → BRIEF — phone center + brief window right */}
      {f >= 276 && f < 940 ? (
        <Phone f={f} openAt={276} x={330} y={80} scale={1.18}>
          <IdeaScreen f={f} />
        </Phone>
      ) : null}
      <Win f={f} openAt={700} rect={[900, 150, 880, 620]} title="brief — offline export" closeAt={928}>
        <BriefDoc f={f} />
      </Win>
      <Caption f={f} from={300} to={690} text="AUDITOR → DEVELOPER — ON THE DRAWER LAPTOP" />
      <Caption f={f} from={716} to={912} text="SCOPED · RISKED · READY TO BUILD" />
      <Card f={f} from={520} to={690} lines={["RUNNING ON A 7B MODEL", "ON A LAPTOP"]} />

      {/* B4 · RECALL — second idea, memory lights up */}
      {f >= 940 && f < 1148 ? (
        <Phone f={f} openAt={940} x={330} y={80} scale={1.18}>
          <RecallScreen f={f} />
        </Phone>
      ) : null}
      {f >= 980 ? (
        <Win f={f} openAt={980} rect={[900, 210, 800, 500]} title="Second Brain — HP-DRAWER" closeAt={1136}>
          <BrainGraph f={f} igniteAt={1030} />
        </Win>
      ) : null}
      <Caption f={f} from={960} to={1128} text="IT WAS IN THE ROOM. IT REMEMBERS." />

      {/* B5 · FLEET — PowerShell joins, phone approves, lens reviews land */}
      <Win f={f} openAt={1152} rect={[80, 130, 900, 460]} title="THINKPAD-T480 — Windows PowerShell" closeAt={1428}>
        <Terminal
          f={f}
          fontSize={18}
          lines={[
            { at: 1160, text: 'cmd /c "npx --yes omnibus-bridge@0.2.1 worker --join eyJ2IjoxLCJob3N0Ijo…"', kind: "cmd", typed: true },
            { at: 1218, text: "Joined Home Fleet · this laptop reviews through the FEASIBILITY lens", kind: "out" },
            { at: 1232, text: 'Fleet Setup shows this laptop as "Windows Peer · Cedar"', kind: "ok" },
          ]}
        />
      </Win>
      {f >= 1240 && f < 1436 ? (
        <Phone f={f} openAt={1240} x={1240} y={110} scale={0.92}>
          <FleetScreen f={f} />
        </Phone>
      ) : null}
      <Caption f={f} from={1180} to={1420} text="THE DRAWER LAPTOP JUST JOINED THE REVIEW" />

      {/* B6 · GATE — the REAL pre-commit gate blocking a real staged
          anti-pattern, auto-fixing it, and passing (vhs capture) */}
      <Win f={f} openAt={1440} rect={[210, 130, 1500, 700]} title="HP-DRAWER — omnibus-bridge hook" closeAt={1642}>
        {f >= 1442 ? (
          <OffthreadVideo
            src={staticFile("captures/term-gate.mp4")}
            style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top left" }}
            playbackRate={1.7}
            muted
          />
        ) : null}
      </Win>
      <Caption f={f} from={1470} to={1630} text="IT GUARDS THE BRANCH." />

      {/* B7 · CLOSING SNAP GRID — four windows tile, mirroring Act I */}
      {f >= 1650 ? <ClosingGrid f={f} /> : null}
      <Caption f={f} from={1676} to={1790} text="YOUR LAPTOPS · YOUR IDEAS · ONE BRAIN" />
    </AbsoluteFill>
  );
};

const PairScreen: React.FC<{ f: number }> = ({ f }) => {
  const scanned = f >= 150;
  const scanline = interpolate(f % 70, [0, 70], [90, 480]);
  return (
    <div style={{ padding: "26px 24px", height: "100%" }}>
      <div style={{ color: MUTED, fontFamily: MONO, fontSize: 11, letterSpacing: "0.16em" }}>OMNIBUS / PAIR</div>
      {!scanned ? (
        <>
          <div style={{ marginTop: 16, height: 380, borderRadius: 18, border: `1.5px solid ${FAINT}`, position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", left: 14, top: scanline - 90, right: 14, height: 2.5, background: INK, opacity: 0.8 }} />
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.4 }}>
              <QRCodeArt size={150} reveal={1} />
            </div>
          </div>
          <div style={{ color: MUTED, fontFamily: MONO, fontSize: 12, marginTop: 18, letterSpacing: "0.08em" }}>POINT AT THE TERMINAL QR</div>
        </>
      ) : (
        <div style={{ marginTop: 40 }}>
          <div style={{ color: INK, fontFamily: SANS, fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em" }}>Laptop linked.</div>
          <div style={{ marginTop: 22, padding: "16px 18px", borderRadius: 14, border: `1.5px solid ${HAIR}`, background: "rgba(24,24,27,0.9)" }}>
            <div style={{ color: INK, fontFamily: MONO, fontSize: 14, fontWeight: 700, letterSpacing: "0.06em" }}>HP-DRAWER</div>
            <div style={{ color: MUTED, fontFamily: MONO, fontSize: 12, marginTop: 6 }}>BRIDGE · THIS LAPTOP</div>
            <div style={{ color: MUTED, fontFamily: MONO, fontSize: 12, marginTop: 12, borderTop: `1px solid ${HAIR}`, paddingTop: 10 }}>
              SIZED FOR · 16 GB → BALANCED
            </div>
            <div style={{ color: MUTED, fontFamily: MONO, fontSize: 12, marginTop: 5 }}>MODELS · LOCAL · NO CLOUD</div>
          </div>
          <div style={{ marginTop: 20, color: MUTED, fontFamily: MONO, fontSize: 11.5, letterSpacing: "0.1em" }}>
            {f >= 190 ? "SECOND BRAIN · SYNCED" : ""}
          </div>
        </div>
      )}
    </div>
  );
};

const IdeaScreen: React.FC<{ f: number }> = ({ f }) => {
  const typedChars = Math.floor(interpolate(f, [300, 400], [0, IDEA_1.length], clamp));
  const sent = f >= 420;
  return (
    <div style={{ padding: "24px 22px", height: "100%" }}>
      <div style={{ color: MUTED, fontFamily: MONO, fontSize: 11, letterSpacing: "0.16em" }}>OMNIBUS / NEW IDEA</div>
      <div
        style={{
          marginTop: 14, minHeight: 84, borderRadius: 14, border: `1.5px solid ${sent ? HAIR : FAINT}`,
          padding: "14px 16px", background: "rgba(24,24,27,0.9)",
        }}
      >
        <span style={{ color: INK, fontFamily: SANS, fontSize: 18, lineHeight: 1.45 }}>
          {IDEA_1.slice(0, typedChars)}
          {!sent && typedChars < IDEA_1.length ? (
            <span style={{ display: "inline-block", width: 10, height: 20, background: INK, verticalAlign: "text-bottom", marginLeft: 2 }} />
          ) : null}
        </span>
      </div>
      {!sent ? (
        <div
          style={{
            marginTop: 14, height: 46, borderRadius: 12, background: typedChars >= IDEA_1.length ? INK : "rgba(246,246,244,0.14)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: typedChars >= IDEA_1.length ? BG : MUTED, fontFamily: MONO, fontSize: 12, fontWeight: 700, letterSpacing: "0.12em",
          }}
        >
          SEND TO THE WORKING ROOM
        </div>
      ) : (
        <div style={{ marginTop: 16 }}>
          <AgentRow f={f} at={428} doneAt={560} label="AUDITOR — ENRICHING AGAINST YOUR WORKSPACE" sub="recall · workspace context · risk flags" />
          {f >= 470 ? (
            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              {["3 LINKED MEMORIES", "CODE TWIN · 2 LESSONS", "RISKS · 1"].map((chip, i) =>
                f >= 470 + i * 14 ? (
                  <span key={chip} style={{ border: `1.5px solid ${FAINT}`, borderRadius: 9, padding: "5px 10px", color: MUTED, fontFamily: MONO, fontSize: 10.5, letterSpacing: "0.08em" }}>
                    {chip}
                  </span>
                ) : null,
              )}
            </div>
          ) : null}
          <div style={{ marginTop: 8 }}>
            <AgentRow f={f} at={566} doneAt={700} label="DEVELOPER — COMPOSING THE BRIEF" sub="12.4 tok/s · mistral-7b · this laptop" />
          </div>
          {f >= 714 ? (
            <div style={{ marginTop: 18, color: INK, fontFamily: MONO, fontSize: 13, fontWeight: 700, letterSpacing: "0.1em" }}>
              BRIEF READY →
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
};

const BRIEF_LINES = [
  ["SCOPE", "cache report queries · serialize to local store · export from cache"],
  ["RESPECTS", "your decision (Jul 20): reports stay read-only offline"],
  ["RISKS", "stale-data window · storage cap on 8 GB tier"],
  ["STEPS", "3 steps · touches 4 files · est. one evening"],
  ["PROMPT", "paste-ready Codex prompt · project-native"],
] as const;

const BriefDoc: React.FC<{ f: number }> = ({ f }) => (
  <div style={{ padding: "20px 26px" }}>
    {BRIEF_LINES.map(([k, v], i) =>
      f >= 716 + i * 16 ? (
        <div key={k} style={{ display: "flex", gap: 16, padding: "10px 0", borderBottom: `1px solid ${HAIR}`, opacity: interpolate(f, [716 + i * 16, 722 + i * 16], [0, 1], clamp) }}>
          <div style={{ width: 120, color: MUTED, fontFamily: MONO, fontSize: 14, fontWeight: 700, letterSpacing: "0.1em", flexShrink: 0 }}>{k}</div>
          <div style={{ color: k === "PROMPT" ? INK : MUTED, fontFamily: MONO, fontSize: 15, lineHeight: 1.5, fontWeight: k === "PROMPT" ? 700 : 400 }}>{v}</div>
        </div>
      ) : null,
    )}
  </div>
);

const RecallScreen: React.FC<{ f: number }> = ({ f }) => {
  const typedChars = Math.floor(interpolate(f, [952, 1016], [0, IDEA_2.length], clamp));
  const sent = f >= 1024;
  return (
    <div style={{ padding: "24px 22px" }}>
      <div style={{ color: MUTED, fontFamily: MONO, fontSize: 11, letterSpacing: "0.16em" }}>OMNIBUS / NEW IDEA</div>
      <div style={{ marginTop: 14, minHeight: 84, borderRadius: 14, border: `1.5px solid ${FAINT}`, padding: "14px 16px", background: "rgba(24,24,27,0.9)" }}>
        <span style={{ color: INK, fontFamily: SANS, fontSize: 18, lineHeight: 1.45 }}>{IDEA_2.slice(0, typedChars)}</span>
      </div>
      {sent ? (
        <div style={{ marginTop: 18 }}>
          <div
            style={{
              padding: "13px 15px", borderRadius: 12, border: `2px solid ${INK}`,
              background: "rgba(246,246,244,0.06)",
              opacity: interpolate(f, [1030, 1040], [0, 1], clamp),
            }}
          >
            <div style={{ color: INK, fontFamily: MONO, fontSize: 12.5, fontWeight: 700, letterSpacing: "0.08em" }}>SECOND BRAIN · RECALLED</div>
            <div style={{ color: MUTED, fontFamily: MONO, fontSize: 12, marginTop: 7, lineHeight: 1.55 }}>
              offline export brief (today) · reports read-only decision (Jul 20) · storage cap lesson
            </div>
          </div>
          {f >= 1064 ? (
            <div style={{ marginTop: 14, color: MUTED, fontFamily: MONO, fontSize: 11.5, letterSpacing: "0.08em", opacity: interpolate(f, [1064, 1072], [0, 1], clamp) }}>
              AUDITOR — CONNECTING IT TO TONIGHT'S IDEA…
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

const BrainGraph: React.FC<{ f: number; igniteAt: number }> = ({ f, igniteAt }) => {
  const rnd = mulberry32(23);
  const nodes = Array.from({ length: 14 }, () => [60 + rnd() * 660, 40 + rnd() * 280] as const);
  const edges = Array.from({ length: 16 }, () => [Math.floor(rnd() * 14), Math.floor(rnd() * 14)] as const).filter(([a, b]) => a !== b);
  const lit = f >= igniteAt ? [2, 7, 11] : [];
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <svg width="100%" height="78%" viewBox="0 0 780 360">
        {edges.map(([a, b], i) => (
          <line key={i} x1={nodes[a][0]} y1={nodes[a][1]} x2={nodes[b][0]} y2={nodes[b][1]} stroke={FAINT} strokeWidth={1.5} />
        ))}
        {nodes.map(([x, y], i) => {
          const isLit = lit.includes(i);
          const pulse = isLit ? 1 + 0.35 * Math.sin((f - igniteAt) / 5) : 1;
          return <circle key={i} cx={x} cy={y} r={5 * pulse} fill={isLit ? INK : MUTED} opacity={isLit ? 1 : 0.6} />;
        })}
      </svg>
      <div style={{ position: "absolute", left: 26, bottom: 16, color: MUTED, fontFamily: MONO, fontSize: 16, letterSpacing: "0.06em" }}>
        {f >= igniteAt ? "1,207 NODES · +3 TONIGHT · NOTHING FORGOTTEN" : "1,204 NODES · 87 SESSIONS"}
      </div>
    </div>
  );
};

const FleetScreen: React.FC<{ f: number }> = ({ f }) => {
  const approved = f >= 1310;
  const row = (name: string, sub: string, status: string, at: number) =>
    f >= at ? (
      <div style={{ display: "flex", alignItems: "center", padding: "12px 2px", borderBottom: `1px solid ${HAIR}`, opacity: interpolate(f, [at, at + 6], [0, 1], clamp) }}>
        <span style={{ width: 10, height: 10, borderRadius: 5, background: INK, marginRight: 12, flexShrink: 0 }} />
        <span style={{ color: INK, fontFamily: MONO, fontSize: 12.5, flex: 1 }}>
          {name}
          <span style={{ color: MUTED }}>{"  ·  "}{sub}</span>
        </span>
        <span style={{ color: MUTED, fontFamily: MONO, fontSize: 10.5, letterSpacing: "0.06em" }}>{status}</span>
      </div>
    ) : null;
  return (
    <div style={{ padding: "24px 20px" }}>
      <div style={{ color: MUTED, fontFamily: MONO, fontSize: 11, letterSpacing: "0.16em" }}>OMNIBUS / HOME FLEET</div>
      <div style={{ marginTop: 10 }}>
        {row("HP-DRAWER", "this PC", "BRIDGE", 1248)}
        {row("Windows Peer · Cedar", "THINKPAD-T480", approved ? "CONNECTED" : "APPROVE?", 1258)}
      </div>
      {!approved && f >= 1270 ? (
        <div style={{ marginTop: 14, height: 42, borderRadius: 11, background: INK, display: "flex", alignItems: "center", justifyContent: "center", color: BG, fontFamily: MONO, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.1em" }}>
          APPROVE WORKER
        </div>
      ) : null}
      {approved ? (
        <div style={{ marginTop: 16 }}>
          <div style={{ color: MUTED, fontFamily: MONO, fontSize: 10.5, letterSpacing: "0.12em" }}>PEER REVIEWS · LANDING</div>
          {[
            ["PRODUCT", "ship the export toggle in settings, not a new screen"],
            ["FEASIBILITY", "cache layer exists — reuse the query serializer"],
            ["RISK", "cap offline store on the 8 GB tier"],
          ].map(([lens, text], i) =>
            f >= 1330 + i * 22 ? (
              <div key={lens} style={{ marginTop: 9, padding: "10px 12px", borderRadius: 10, border: `1.5px solid ${HAIR}`, opacity: interpolate(f, [1330 + i * 22, 1338 + i * 22], [0, 1], clamp) }}>
                <span style={{ color: INK, fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: "0.1em" }}>{lens}</span>
                <div style={{ color: MUTED, fontFamily: MONO, fontSize: 11.5, marginTop: 4, lineHeight: 1.45 }}>{text}</div>
              </div>
            ) : null,
          )}
        </div>
      ) : null}
    </div>
  );
};

const CELLS2 = {
  TL: [16, 16, 936, 488],
  TR: [968, 16, 936, 488],
  BL: [16, 520, 936, 488],
  BR: [968, 520, 936, 488],
} as const;

const ClosingGrid: React.FC<{ f: number }> = ({ f }) => (
  <>
    <Win f={f} openAt={1652} rect={CELLS2.TL} title="HP-DRAWER — omnibus-bridge">
      <Terminal f={f} fontSize={17} lines={[
        { at: 1656, text: "Bridge · paired · Second Brain synced", kind: "out" },
        { at: 1666, text: "Fleet · 2 machines · LAN only", kind: "ok" },
      ]} />
    </Win>
    <Win f={f} openAt={1660} rect={CELLS2.TR} title="brief — offline export">
      <BriefDoc f={Math.max(f, 1800)} />
    </Win>
    <Win f={f} openAt={1668} rect={CELLS2.BL} title="Second Brain — HP-DRAWER">
      <BrainGraph f={f} igniteAt={1690} />
    </Win>
    <Win f={f} openAt={1676} rect={CELLS2.BR} title="Windows Peer · Cedar — reviews">
      <Terminal f={f} fontSize={17} lines={[
        { at: 1680, text: "PRODUCT · FEASIBILITY · RISK — delivered", kind: "out" },
        { at: 1692, text: "prompt cache · warmed via P2P ticket", kind: "dim" },
      ]} />
    </Win>
  </>
);
