import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { T, tint, STATUS, IconClaude, IconBot } from "./theme.jsx";
import { CATEGORIES } from "./IsoTrail.jsx";

/**
 * Flat "swim lane" view of a session for the Graph tab (the 2D half of
 * the 2D/3D toggle). One column per resource (Shell / Files / Network /
 * Sensitive data), one row per step in call order, so you read the
 * session top-to-bottom and see at a glance when the agent hops from the
 * shell to the network. Consecutive steps are joined by elbow connectors
 * coloured by the outcome of the step they lead into.
 *
 * Layout is plain absolute positioning from a measured width: rows have a
 * fixed height, so a new step only ever appends at the bottom and nothing
 * above it moves (no jitter while a session is live).
 */

const LANE_ORDER = ["shell", "files", "network", "sensitive"];
export const LANES = LANE_ORDER.map((id) => CATEGORIES.find((c) => c.id === id));
const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

// Each step sits in exactly one lane. Network wins (an exfil attempt reads
// as "sensitive data -> network"), then sensitive reads, then files, then shell.
export function laneOf(node) {
  if (!node.event) return "shell";
  if (CAT.network.match(node)) return "network";
  if (CAT.sensitive.match(node)) return "sensitive";
  if (CAT.files.match(node)) return "files";
  return "shell";
}

const TITLES = { read_file: "Read file", write_file: "Wrote file", run_shell: "Ran command", call_api: "Network request" };
export function stepTitle(event) {
  return TITLES[event.tool] || event.tool;
}

const SEV_RANK = { clean: 0, approved: 1, flagged: 2, warning: 3, denied: 4, critical: 4 };
const SEV_WORD = { approved: "approved", flagged: "flagged", warning: "awaiting approval", denied: "denied", critical: "blocked" };

const PAD_X = 24;
const STEP_COL = 48;
const LANE_GAP = 10;
const HEADER_H = 64; // sticky lane headers
const ROW = 62;
const CARD_H = 46;
const CARD_INSET = 6;
const TOP = 10; // space between header and the start block

export default function TwoDTrail({ trail, selectedId, onSelect, focusCat, onFocusCat, follow, active }) {
  const scrollRef = useRef(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const steps = trail.nodes.filter((n) => !n.isStart);
  const start = trail.nodes.find((n) => n.isStart);

  const laneW = Math.round(Math.min(280, Math.max(170, (width - PAD_X * 2 - STEP_COL - LANE_GAP * 3) / 4)));
  const gridW = STEP_COL + laneW * 4 + LANE_GAP * 3;
  const laneX = (id) => STEP_COL + LANE_ORDER.indexOf(id) * (laneW + LANE_GAP);
  const cardW = laneW - CARD_INSET * 2;
  const rowY = (r) => TOP + r * ROW;
  const bodyH = rowY(steps.length) + CARD_H + 28;

  // eslint-disable-next-line react-hooks/exhaustive-deps -- steps is derived from trail
  const placed = useMemo(() => steps.map((n, i) => ({ node: n, lane: laneOf(n), row: i + 1 })), [trail]);

  const laneStats = useMemo(
    () =>
      LANES.map((c) => {
        const inLane = placed.filter((p) => p.lane === c.id).map((p) => p.node);
        const worst = inLane.reduce((acc, n) => (SEV_RANK[n.severity] > SEV_RANK[acc] ? n.severity : acc), "clean");
        const worstCount = inLane.filter((n) => n.severity === worst).length;
        let summary = "Untouched";
        if (inLane.length) summary = worst === "clean" ? "All allowed" : `${worstCount} ${SEV_WORD[worst]}`;
        return { ...c, count: inLane.length, worst, summary };
      }),
    [placed]
  );

  const activeCat = focusCat ? CAT[focusCat] : null;
  const inFocus = (n) => !activeCat || activeCat.match(n);

  const center = (lane, row) => ({ x: laneX(lane) + laneW / 2, top: rowY(row), bottom: rowY(row) + CARD_H });
  const links = placed.map((p, i) => {
    const from = i === 0 ? center("shell", 0) : center(placed[i - 1].lane, placed[i - 1].row);
    const to = center(p.lane, p.row);
    return { id: p.node.id, d: elbow(from.x, from.bottom, to.x, to.top), color: STATUS[p.node.severity].color, dim: !inFocus(p.node) };
  });
  const newestId = steps.length ? steps[steps.length - 1].id : null;

  // keep the newest step in view while following live / replaying
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !active || !follow || !steps.length) return;
    const bottom = HEADER_H + rowY(steps.length) + CARD_H + 24;
    if (bottom > el.scrollTop + el.clientHeight) el.scrollTo({ top: bottom - el.clientHeight, behavior: "smooth" });
  }, [steps.length, follow, active]);

  // bring a selected step into view (Prev / Next in the side panel)
  useEffect(() => {
    const el = scrollRef.current;
    const idx = steps.findIndex((n) => n.id === selectedId);
    if (!el || !active || idx < 0) return;
    const top = HEADER_H + rowY(idx + 1);
    if (top - HEADER_H < el.scrollTop || top + CARD_H > el.scrollTop + el.clientHeight) {
      el.scrollTo({ top: Math.max(0, top - el.clientHeight / 2), behavior: "smooth" });
    }
  }, [selectedId, active]);

  const SourceIcon = start && start.label === "Claude Code" ? IconClaude : IconBot;

  return (
    <div
      ref={scrollRef}
      className="ax-scroll"
      onClick={() => {
        onSelect(null);
        onFocusCat(null);
      }}
      style={{
        position: "absolute",
        inset: 0,
        overflow: "auto",
        background: `radial-gradient(${T.gridline} 1px, transparent 1px) 0 0 / 16px 16px, ${T.page}`,
      }}
    >
      {width > 0 && (
        <div style={{ position: "relative", width: gridW, margin: "0 auto", padding: `0 ${PAD_X}px` }}>
          {/* lane headers */}
          <div style={{ position: "sticky", top: 0, zIndex: 3, height: HEADER_H, background: `linear-gradient(${T.page} 82%, transparent)` }}>
            <div style={{ position: "absolute", left: 0, top: 30, fontSize: 10, fontWeight: 600, letterSpacing: 0.6, color: T.inkMuted, fontFamily: T.fontMono }}>STEP</div>
            {laneStats.map((c) => {
              const focused = focusCat === c.id;
              const sevColor = c.count ? STATUS[c.worst].ink : T.inkMuted;
              return (
                <button
                  key={c.id}
                  className="ax-seg-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onFocusCat(focused ? null : c.id);
                  }}
                  title={focused ? "Clear spotlight" : `Spotlight ${c.label.toLowerCase()} steps`}
                  style={{
                    position: "absolute",
                    left: laneX(c.id),
                    top: 12,
                    width: laneW,
                    height: 42,
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    padding: "0 10px",
                    boxSizing: "border-box",
                    background: T.surface,
                    border: `1px solid ${focused ? T.ink : T.border}`,
                    borderRadius: T.radius,
                    boxShadow: focused ? `0 0 0 2px ${tint("#000000", 6)}` : "none",
                    cursor: "pointer",
                    fontFamily: T.font,
                    textAlign: "left",
                    opacity: activeCat && !focused ? 0.55 : 1,
                  }}
                >
                  <span style={{ width: 24, height: 24, flexShrink: 0, borderRadius: T.radiusSm, background: T.sunken, border: `1px solid ${T.border}`, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                    <c.Icon size={13} color={T.inkSecondary} />
                  </span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: "block", fontSize: 12, fontWeight: 600, color: T.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.label}</span>
                    <span style={{ display: "block", fontSize: 10.5, color: sevColor, whiteSpace: "nowrap" }}>{c.summary}</span>
                  </span>
                  <span style={{ fontFamily: T.fontMono, fontSize: 15, fontWeight: 600, color: c.count ? T.ink : T.inkMuted }}>{c.count}</span>
                </button>
              );
            })}
          </div>

          <div style={{ position: "relative", height: bodyH }}>
            {/* lane backgrounds */}
            {LANES.map((c) => (
              <div
                key={c.id}
                style={{
                  position: "absolute",
                  left: laneX(c.id),
                  top: -6,
                  bottom: 8,
                  width: laneW,
                  borderRadius: T.radius,
                  border: `1px solid ${T.border}`,
                  background: tint(T.surface, focusCat === c.id ? 70 : 40),
                  transition: "background 200ms ease",
                }}
              />
            ))}

            {/* step numbers */}
            {placed.map((p) => (
              <div
                key={p.node.id}
                style={{ position: "absolute", left: 0, top: rowY(p.row) + CARD_H / 2 - 8, fontFamily: T.fontMono, fontSize: 11, color: p.node.id === selectedId ? T.ink : T.inkMuted, fontWeight: p.node.id === selectedId ? 600 : 400 }}
              >
                {String(p.row).padStart(2, "0")}
              </div>
            ))}

            {/* connectors */}
            <svg width={gridW} height={bodyH} style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" }}>
              {links.map((l) => (
                <g key={l.id} className="ax-2d-link" style={{ opacity: l.dim ? 0.25 : 1 }}>
                  <path d={l.d} fill="none" stroke={tint(l.color, 22)} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" />
                  <path
                    d={l.d}
                    fill="none"
                    stroke={l.color}
                    strokeWidth={2}
                    strokeDasharray="5 4"
                    strokeLinecap="round"
                    // only the newest link animates: one moving dash reads as "live"
                    // without repainting the whole connector layer every frame
                    className={l.id === newestId && follow ? "ax-dash" : undefined}
                  />
                </g>
              ))}
            </svg>

            {/* agent / session start */}
            {start && (
              <div
                className="ax-2d-card"
                style={{
                  position: "absolute",
                  left: laneX("shell") + CARD_INSET,
                  top: rowY(0),
                  width: cardW,
                  height: CARD_H,
                  boxSizing: "border-box",
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  padding: "0 10px",
                  borderRadius: T.radius,
                  background: "#1c1a16",
                  color: "#fff",
                  border: "1px solid rgba(255,255,255,0.1)",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
                }}
              >
                <span style={{ width: 26, height: 26, borderRadius: T.radiusSm, background: "rgba(255,255,255,0.12)", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <SourceIcon size={14} color="#fff" />
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: "block", fontSize: 12.5, fontWeight: 600 }}>{start.label}</span>
                  <span style={{ display: "block", fontSize: 10.5, fontFamily: T.fontMono, color: "rgba(255,255,255,0.55)" }}>session start</span>
                </span>
                {follow && <span style={{ width: 7, height: 7, borderRadius: "50%", background: T.good, boxShadow: `0 0 0 3px ${tint(T.good, 30)}` }} />}
              </div>
            )}

            {/* step cards */}
            {placed.map((p) => {
              const n = p.node;
              const st = STATUS[n.severity];
              const selected = n.id === selectedId;
              const plain = n.severity === "clean";
              return (
                <div
                  key={n.id}
                  className="ax-2d-card"
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(n);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(n);
                    }
                  }}
                  style={{
                    position: "absolute",
                    left: laneX(p.lane) + CARD_INSET,
                    top: rowY(p.row),
                    width: cardW,
                    height: CARD_H,
                    boxSizing: "border-box",
                    padding: "6px 9px",
                    borderRadius: T.radius,
                    background: plain ? T.surface : `linear-gradient(${tint(st.color, 7)}, ${tint(st.color, 7)}), ${T.surface}`,
                    border: `1px solid ${selected ? st.color : plain ? T.border : tint(st.color, 45)}`,
                    boxShadow: selected ? `0 0 0 3px ${tint(st.color, 20)}` : T.shadow,
                    opacity: inFocus(n) ? 1 : 0.35,
                    cursor: "pointer",
                    outline: "none",
                    zIndex: selected ? 2 : 1,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ minWidth: 16, height: 16, padding: "0 3px", boxSizing: "border-box", borderRadius: 4, background: st.color, color: "#fff", fontSize: 9.5, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", fontFamily: T.font }}>
                      {n.step}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: T.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0 }}>{stepTitle(n.event)}</span>
                    <st.Icon size={13} color={st.color} style={{ flexShrink: 0 }} />
                  </div>
                  <div style={{ marginTop: 3, fontFamily: T.fontMono, fontSize: 11, color: T.inkSecondary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {n.event.target}
                  </div>
                </div>
              );
            })}
          </div>

          {steps.length === 0 && (
            <div style={{ position: "absolute", top: HEADER_H + ROW + 20, left: 0, right: 0, textAlign: "center", fontSize: 13, color: T.inkMuted }}>
              Waiting for a session to trace — ask Claude Code to do something, or run the toy agent.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Elbow from (x1, y1) down to (x2, y2): straight down, across at the row
// gap's midpoint, then down into the next card -- with small rounded bends.
function elbow(x1, y1, x2, y2) {
  if (Math.abs(x1 - x2) < 1) return `M${x1} ${y1} V${y2}`;
  const my = (y1 + y2) / 2;
  const r = Math.min(6, Math.abs(x2 - x1) / 2, (y2 - y1) / 2);
  const dir = x2 > x1 ? 1 : -1;
  return `M${x1} ${y1} V${my - r} Q${x1} ${my} ${x1 + dir * r} ${my} H${x2 - dir * r} Q${x2} ${my} ${x2} ${my + r} V${y2}`;
}
