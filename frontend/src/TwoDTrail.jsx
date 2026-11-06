import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { T, tint, STATUS, IconClaude, IconBot } from "./theme.jsx";
import { CATEGORIES } from "./IsoTrail.jsx";
import { HELD_TAGS, TAG_INFO } from "./taintFlow.js";

/**
 * Flat "swim lane" view of a session for the Graph tab (the 2D half of
 * the 2D/3D toggle). One column per resource (Shell / Files / Network /
 * Sensitive data), one row per step in call order.
 *
 * Two kinds of line:
 *   - thin elbow connectors: call order (step N -> N+1)
 *   - curved data-flow lines: the step that brought sensitive data into
 *     the session -> the later step blocked/flagged because of it
 * plus a "held" band beside the step numbers showing what sensitive data
 * the session was carrying at each point. Long runs of uneventful allowed
 * steps fold into one card so the incident isn't buried.
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

const TITLES = { read_file: "Read file", write_file: "Wrote file", run_shell: "Ran command", call_api: "Network request", websearch: "Web search" };
export function stepTitle(event) {
  const tool = event.tool || "";
  if (tool.startsWith("mcp__")) return `MCP: ${tool.split("__").slice(1).join(" / ")}`;
  return TITLES[tool] || tool;
}

const SEV_RANK = { clean: 0, approved: 1, flagged: 2, warning: 3, denied: 4, critical: 4 };
const SEV_WORD = { approved: "approved", flagged: "flagged", warning: "awaiting approval", denied: "denied", critical: "blocked" };

const PAD_X = 24;
const NUM_W = 36; // step numbers
const BAND_W = 36; // "held" band
const STEP_COL = NUM_W + BAND_W + 4;
const LANE_GAP = 10;
const HEADER_H = 64; // sticky lane headers
const ROW = 62;
const CARD_H = 46;
const CARD_INSET = 6;
const TOP = 10; // space between header and the start block
const FOLD_MIN = 4; // fold runs of at least this many quiet steps

export default function TwoDTrail({ trail, analysis, sessionKey, selectedId, relatedIds, onSelect, focusCat, onFocusCat, follow, active }) {
  const scrollRef = useRef(null);
  const [width, setWidth] = useState(0);
  const [unfolded, setUnfolded] = useState(() => new Set());

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => setUnfolded(new Set()), [sessionKey]);

  const steps = trail.nodes.filter((n) => !n.isStart);
  const start = trail.nodes.find((n) => n.isStart);

  const laneW = Math.round(Math.min(280, Math.max(170, (width - PAD_X * 2 - STEP_COL - LANE_GAP * 3) / 4)));
  const gridW = STEP_COL + laneW * 4 + LANE_GAP * 3;
  const laneX = (id) => STEP_COL + LANE_ORDER.indexOf(id) * (laneW + LANE_GAP);
  const cardW = laneW - CARD_INSET * 2;
  const rowY = (r) => TOP + r * ROW;

  // rows: each step, or a folded run of quiet steps
  const flowIds = useMemo(() => new Set(analysis.flows.flatMap((f) => [f.from.id, f.to.id])), [analysis]);
  const items = useMemo(() => {
    const quiet = (n, i) =>
      // the last few steps never fold, so a live session doesn't reshuffle under you
      n.severity === "clean" && !(analysis.holding.get(n.id)?.brought || []).length && !flowIds.has(n.id) && i < steps.length - 3;
    const out = [];
    let run = [];
    const flush = () => {
      const key = run.length ? run[0].id : null;
      if (run.length >= FOLD_MIN && !unfolded.has(key)) out.push({ kind: "group", key, nodes: run, lane: laneOf(run[0]) });
      else run.forEach((n, k) => out.push({ kind: "step", node: n, lane: laneOf(n), runKey: run.length >= FOLD_MIN && k === 0 ? key : null, runLen: run.length }));
      run = [];
    };
    steps.forEach((n, i) => {
      if (quiet(n, i)) run.push(n);
      else {
        flush();
        out.push({ kind: "step", node: n, lane: laneOf(n) });
      }
    });
    flush();
    return out.map((it, i) => ({ ...it, row: i + 1 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- steps is derived from trail
  }, [trail, analysis, flowIds, unfolded]);

  const rowOf = useMemo(() => {
    const m = new Map();
    items.forEach((it) => (it.kind === "group" ? it.nodes : [it.node]).forEach((n) => m.set(n.id, it)));
    return m;
  }, [items]);
  const bodyH = rowY(items.length) + CARD_H + 28;

  const laneStats = useMemo(
    () =>
      LANES.map((c) => {
        const inLane = steps.filter((n) => laneOf(n) === c.id);
        const worst = inLane.reduce((acc, n) => (SEV_RANK[n.severity] > SEV_RANK[acc] ? n.severity : acc), "clean");
        const worstCount = inLane.filter((n) => n.severity === worst).length;
        let summary = "Untouched";
        if (inLane.length) summary = worst === "clean" ? "All allowed" : `${worstCount} ${SEV_WORD[worst]}`;
        return { ...c, count: inLane.length, worst, summary };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trail]
  );

  const activeCat = focusCat ? CAT[focusCat] : null;
  const inFocus = (n) => !activeCat || activeCat.match(n);

  const center = (lane, row) => ({ x: laneX(lane) + laneW / 2, top: rowY(row), bottom: rowY(row) + CARD_H });
  const links = items.map((it, i) => {
    const prev = items[i - 1];
    const from = i === 0 ? center("shell", 0) : center(prev.lane, prev.row);
    const to = center(it.lane, it.row);
    const sev = it.kind === "group" ? "clean" : it.node.severity;
    const dim = it.kind === "step" && !inFocus(it.node);
    return { id: it.kind === "group" ? it.key : it.node.id, d: elbow(from.x, from.bottom, to.x, to.top), color: STATUS[sev].color, dim };
  });
  const newestId = steps.length ? steps[steps.length - 1].id : null;

  // data-flow curves: source card -> effect card
  const flows = analysis.flows
    .map((f) => {
      const a = rowOf.get(f.from.id);
      const b = rowOf.get(f.to.id);
      if (!a || !b) return null;
      const ax = laneX(a.lane) + CARD_INSET;
      const bx = laneX(b.lane) + CARD_INSET;
      const ay = rowY(a.row) + CARD_H / 2;
      const by = rowY(b.row) + CARD_H / 2;
      let p0, p3, c1, c2;
      if (a.lane === b.lane) {
        // same lane: bow out to the right of the column
        p0 = [ax + cardW, ay];
        p3 = [bx + cardW, by];
        const bow = Math.min(60, 24 + Math.abs(by - ay) * 0.15);
        c1 = [p0[0] + bow, ay];
        c2 = [p3[0] + bow, by];
      } else {
        const right = bx > ax;
        p0 = [right ? ax + cardW : ax, ay];
        p3 = [right ? bx : bx + cardW, by];
        const dx = (p3[0] - p0[0]) * 0.5;
        c1 = [p0[0] + dx, ay];
        c2 = [p3[0] - dx, by];
      }
      const mid = [(p0[0] + 3 * c1[0] + 3 * c2[0] + p3[0]) / 8, (p0[1] + 3 * c1[1] + 3 * c2[1] + p3[1]) / 8];
      const involved = !selectedId || f.from.id === selectedId || f.to.id === selectedId;
      return {
        id: f.id,
        d: `M${p0[0]} ${p0[1]} C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${p3[0]} ${p3[1]}`,
        color: STATUS[f.to.severity].color,
        tag: f.tag,
        mid,
        dim: !involved,
      };
    })
    .filter(Boolean);

  // "held" band: per row, which sensitive tags the session carries after it
  const band = items.map((it) => {
    const last = it.kind === "group" ? it.nodes[it.nodes.length - 1] : it.node;
    const h = analysis.holding.get(last.id) || { after: [], brought: [] };
    return { row: it.row, after: h.after, brought: it.kind === "step" ? h.brought : [] };
  });

  // keep the newest step in view while following live
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !active || !follow || !steps.length) return;
    const bottom = HEADER_H + rowY(items.length) + CARD_H + 24;
    if (bottom > el.scrollTop + el.clientHeight) el.scrollTo({ top: bottom - el.clientHeight, behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps.length, follow, active]);

  // bring a selected step into view (Prev / Next, incident nav, side panel)
  useEffect(() => {
    const el = scrollRef.current;
    const it = rowOf.get(selectedId);
    if (!el || !active || !it) return;
    const top = HEADER_H + rowY(it.row);
    if (top - HEADER_H < el.scrollTop || top + CARD_H > el.scrollTop + el.clientHeight) {
      el.scrollTo({ top: Math.max(0, top - el.clientHeight / 2), behavior: "smooth" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, active]);

  // selecting a step that's folded away (from 3D, the side panel, incident nav) unfolds its run
  useEffect(() => {
    const it = rowOf.get(selectedId);
    if (it && it.kind === "group") setUnfolded((s) => new Set(s).add(it.key));
  }, [selectedId, rowOf]);

  const toggleRun = (key) =>
    setUnfolded((s) => {
      const next = new Set(s);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

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
          <div style={{ position: "sticky", top: 0, zIndex: 4, height: HEADER_H, background: `linear-gradient(${T.page} 82%, transparent)` }}>
            <div style={{ position: "absolute", left: 0, top: 30, fontSize: 9.5, fontWeight: 600, letterSpacing: 0.6, color: T.inkMuted, fontFamily: T.fontMono }}>STEP</div>
            <div title="What the session is holding: secret / personal / internal-only data, and untrusted outside content" style={{ position: "absolute", left: NUM_W, top: 30, fontSize: 9.5, fontWeight: 600, letterSpacing: 0.6, color: T.inkMuted, fontFamily: T.fontMono }}>HELD</div>
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

            {/* step numbers (+ fold handle on the first row of an unfolded run) */}
            {items.map((it) => {
              const label =
                it.kind === "group"
                  ? `${String(it.nodes[0].step).padStart(2, "0")}–${String(it.nodes[it.nodes.length - 1].step).padStart(2, "0")}`
                  : String(it.node.step).padStart(2, "0");
              const sel = it.kind === "step" && it.node.id === selectedId;
              return (
                <div key={`n-${it.row}`} style={{ position: "absolute", left: 0, top: rowY(it.row) + CARD_H / 2 - 8, fontFamily: T.fontMono, fontSize: it.kind === "group" ? 9 : 11, lineHeight: "16px", color: sel ? T.ink : T.inkMuted, fontWeight: sel ? 600 : 400 }}>
                  {label}
                  {it.runKey && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleRun(it.runKey);
                      }}
                      title={`Fold these ${it.runLen} allowed steps`}
                      style={{ display: "block", marginTop: 2, padding: 0, border: "none", background: "none", fontSize: 9, color: T.inkMuted, cursor: "pointer", fontFamily: T.font, textDecoration: "underline" }}
                    >
                      fold
                    </button>
                  )}
                </div>
              );
            })}

            {/* held band */}
            <svg width={BAND_W} height={bodyH} style={{ position: "absolute", left: NUM_W, top: 0, overflow: "visible", pointerEvents: "none" }}>
              {HELD_TAGS.map((tag, k) => {
                const x = 6 + k * 7;
                return band.map((b) => {
                  if (!b.after.includes(tag)) return null;
                  const startsHere = b.brought.includes(tag);
                  const y0 = startsHere ? rowY(b.row) + CARD_H / 2 : rowY(b.row) - (ROW - CARD_H) / 2;
                  const y1 = rowY(b.row) + CARD_H + (ROW - CARD_H) / 2;
                  return (
                    <g key={`${tag}-${b.row}`} className="ax-2d-link">
                      <rect x={x} y={y0} width={4} height={y1 - y0} fill={TAG_INFO[tag].color} opacity={0.75} />
                      {startsHere && <circle cx={x + 2} cy={y0} r={4} fill={TAG_INFO[tag].color} stroke={T.page} strokeWidth={1.5} />}
                    </g>
                  );
                });
              })}
            </svg>

            {/* call-order connectors */}
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

            {/* folded runs + step cards */}
            {items.map((it) => {
              if (it.kind === "group") {
                const byLane = LANES.map((l) => [l.label, it.nodes.filter((n) => laneOf(n) === l.id).length]).filter(([, c]) => c);
                return (
                  <div
                    key={it.key}
                    className="ax-2d-card"
                    role="button"
                    tabIndex={0}
                    title="Expand"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleRun(it.key);
                    }}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggleRun(it.key))}
                    style={{
                      position: "absolute",
                      left: laneX(it.lane) + CARD_INSET,
                      top: rowY(it.row),
                      width: cardW,
                      height: CARD_H,
                      boxSizing: "border-box",
                      padding: "6px 9px",
                      borderRadius: T.radius,
                      border: `1px dashed ${T.borderStrong}`,
                      background: T.surface,
                      cursor: "pointer",
                      zIndex: 1,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: T.good }} />
                      <span style={{ fontSize: 12, fontWeight: 600, color: T.ink }}>{it.nodes.length} allowed steps</span>
                      <span style={{ marginLeft: "auto", fontSize: 10.5, color: T.inkMuted }}>Expand</span>
                    </div>
                    <div style={{ marginTop: 3, fontSize: 10.5, color: T.inkMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {byLane.map(([l, c]) => `${l} ${c}`).join(" · ")}
                    </div>
                  </div>
                );
              }
              const n = it.node;
              const st = STATUS[n.severity];
              const selected = n.id === selectedId;
              const related = relatedIds && relatedIds.has(n.id);
              const plain = n.severity === "clean";
              const brought = (analysis.holding.get(n.id)?.brought || []);
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
                    left: laneX(it.lane) + CARD_INSET,
                    top: rowY(it.row),
                    width: cardW,
                    height: CARD_H,
                    boxSizing: "border-box",
                    padding: "6px 9px",
                    borderRadius: T.radius,
                    background: plain ? T.surface : `linear-gradient(${tint(st.color, 7)}, ${tint(st.color, 7)}), ${T.surface}`,
                    border: `1px solid ${selected ? st.color : related ? T.ink : plain ? T.border : tint(st.color, 45)}`,
                    boxShadow: selected ? `0 0 0 3px ${tint(st.color, 20)}` : related ? `0 0 0 3px ${tint("#888888", 25)}` : T.shadow,
                    opacity: inFocus(n) ? 1 : 0.35,
                    cursor: "pointer",
                    outline: "none",
                    zIndex: selected || related ? 3 : 2,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ minWidth: 16, height: 16, padding: "0 3px", boxSizing: "border-box", borderRadius: 4, background: st.color, color: "#fff", fontSize: 9.5, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", fontFamily: T.font }}>
                      {n.step}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: T.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0 }}>{stepTitle(n.event)}</span>
                    {brought.map((t) => (
                      <span key={t} title={`This step brought ${TAG_INFO[t].label.toLowerCase()} data into the session`} style={{ flexShrink: 0, fontSize: 9.5, fontWeight: 700, padding: "1px 5px", borderRadius: 3, color: TAG_INFO[t].color, background: tint(TAG_INFO[t].color, 14) }}>
                        + {TAG_INFO[t].short}
                      </span>
                    ))}
                    <st.Icon size={13} color={st.color} style={{ flexShrink: 0 }} />
                  </div>
                  <div style={{ marginTop: 3, fontFamily: T.fontMono, fontSize: 11, color: T.inkSecondary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {n.event.target}
                  </div>
                </div>
              );
            })}

            {/* data-flow curves: drawn over the cards so the cause -> effect link is never hidden */}
            <svg width={gridW} height={bodyH} style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none", zIndex: 3 }}>
              <defs>
                {flows.map((f) => (
                  <marker key={f.id} id={`ax-arrow-${f.id.replace(/[^a-z0-9]/gi, "")}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0 0 L10 5 L0 10 z" fill={f.color} />
                  </marker>
                ))}
              </defs>
              {flows.map((f) => (
                <g key={f.id} className="ax-2d-link" style={{ opacity: f.dim ? 0.25 : 1 }}>
                  <path d={f.d} fill="none" stroke={T.page} strokeWidth={6} strokeLinecap="round" opacity={0.8} />
                  <path d={f.d} fill="none" stroke={f.color} strokeWidth={2.25} strokeDasharray="7 4" strokeLinecap="round" markerEnd={`url(#ax-arrow-${f.id.replace(/[^a-z0-9]/gi, "")})`} />
                </g>
              ))}
            </svg>
            {flows.map((f) => (
              <span
                key={`l-${f.id}`}
                className="ax-2d-link"
                style={{
                  position: "absolute",
                  left: f.mid[0],
                  top: f.mid[1],
                  transform: "translate(-50%, -50%)",
                  zIndex: 4,
                  pointerEvents: "none",
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "2px 7px",
                  borderRadius: 3,
                  whiteSpace: "nowrap",
                  color: "#fff",
                  background: f.color,
                  opacity: f.dim ? 0.3 : 1,
                  boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                }}
              >
                {f.tag === "untrusted" ? TAG_INFO[f.tag].label : `${TAG_INFO[f.tag].label} data`}
              </span>
            ))}
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
