import React, { useEffect, useMemo, useRef, useState } from "react";
import { T, tint, STATUS, TAG_LABELS, humanReason, eventSeverity, sourceMeta, IconChevron } from "./theme.jsx";
import { groupBySession, timeAgo } from "./sessionUtils.js";
import { useEventStream } from "./useEventStream.js";
import { buildTrail } from "./pathLayout.js";
import IsoTrail, { CATEGORIES } from "./IsoTrail.jsx";
import TwoDTrail, { LANES, laneOf, stepTitle } from "./TwoDTrail.jsx";
import { analyzeTrail, explainStep, TAG_INFO } from "./taintFlow.js";
import { authHeaders, feedbackUrl } from "./lib/api.js";

/**
 * Live path-tracing view. Each session is an actual chain: step 1 -> 2
 * -> 3 in call order, so you can ask Claude Code to "fix the taskbar
 * issue" and watch the trail extend live, file by file, tool by tool,
 * until it's done.
 *
 * Two views of the same trail: an isometric 3D scene (IsoTrail, default)
 * and flat swim lanes (TwoDTrail). Switching morphs the camera like a map
 * tilting: the 3D scene tilts down to top-down while the lanes settle in
 * from the same angle, and back.
 *
 * Defaults to auto-following the most recently active session; clicking
 * an older session pins the view there until you click "Follow live".
 * The bar above the views jumps between incidents (flagged / blocked /
 * asked) and scrubs the session to any step -- with the "held" band that
 * shows what sensitive data the agent was carrying at that point.
 */

const MORPH_MS = 700;
// the angle the 2D lanes tilt away to (matches the 3D camera's direction)
const TILTED = "rotateX(42deg) rotateZ(-14deg) scale(0.86)";

export default function Argox({ wsUrl = "ws://localhost:8765", project = null, session = null }) {
  const { events, connected } = useEventStream(wsUrl);
  const [pinnedSession, setPinnedSession] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [focusCat, setFocusCat] = useState(null);
  const [scrubPos, setScrubPos] = useState(null); // null = show everything (live)
  const [verdicts, setVerdicts] = useState({}); // event key -> "correct" | "false_positive" (this visit)

  const sessions = useMemo(() => groupBySession(events), [events]);
  const activeSessionId = pinnedSession || (sessions[0] && sessions[0].sessionId);
  const activeSession = sessions.find((s) => s.sessionId === activeSessionId) || null;
  const following = !pinnedSession;

  const trail = useMemo(() => buildTrail(activeSession), [activeSession]);
  const total = trail.nodes.length - 1;

  // replay: show only the first `pos` steps (null = everything, i.e. live)
  const shown = scrubPos === null ? total : Math.min(scrubPos, total);
  const visibleTrail = useMemo(
    () => (shown >= total ? trail : { nodes: trail.nodes.slice(0, shown + 1), links: trail.links.slice(0, shown) }),
    [trail, shown, total]
  );
  const visibleSteps = visibleTrail.nodes.filter((n) => n.event);
  const selectedNode = visibleSteps.find((n) => n.id === selectedId) || null;
  const analysis = useMemo(() => analyzeTrail(visibleTrail), [visibleTrail]);

  // what the selected step is linked to by data flow (its causes and effects)
  const relatedIds = useMemo(() => {
    if (!selectedNode) return null;
    const ids = new Set();
    (analysis.causes.get(selectedNode.id) || []).forEach((c) => c.sources.forEach((s) => ids.add(s.id)));
    (analysis.effects.get(selectedNode.id) || []).forEach((n) => ids.add(n.id));
    return ids.size ? ids : null;
  }, [selectedNode, analysis]);

  useEffect(() => {
    setFocusCat(null);
    setSelectedId(null);
    setScrubPos(null);
  }, [activeSessionId]);

  const scrub = (v) => setScrubPos(v >= total ? null : v);

  // incident navigation: jump between flagged / blocked / asked steps
  const incidents = analysis.incidents;
  const incIndex = selectedNode ? incidents.findIndex((n) => n.id === selectedNode.id) : -1;
  const gotoIncident = (dir) => {
    if (!incidents.length) return;
    let target;
    if (incIndex >= 0) target = incidents[(incIndex + dir + incidents.length) % incidents.length];
    else {
      const at = selectedNode ? selectedNode.step : dir > 0 ? 0 : Infinity;
      target = dir > 0 ? incidents.find((n) => n.step > at) || incidents[0] : [...incidents].reverse().find((n) => n.step < at) || incidents[incidents.length - 1];
    }
    setSelectedId(target.id);
  };

  // ---- 2D / 3D morph ----
  // mode: which view the toggle shows. flat: the 3D camera is top-down.
  // live3d: the 3D layer is rendering at all (it's skipped once fully hidden
  // so its animations stop costing anything while you're in 2D).
  const [mode, setMode] = useState("3d");
  const [flat, setFlat] = useState(false);
  const [live3d, setLive3d] = useState(true);
  const timer = useRef(null);
  const switchTo = (next) => {
    if (next === mode) return;
    clearTimeout(timer.current);
    setMode(next);
    if (next === "2d") {
      setFlat(true);
      timer.current = setTimeout(() => setLive3d(false), MORPH_MS);
    } else {
      setLive3d(true);
      // let the (still flat) scene render for a frame, then tilt it up
      requestAnimationFrame(() => requestAnimationFrame(() => setFlat(false)));
    }
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  // ← / → step through the selected session
  const selIndex = selectedNode ? visibleSteps.indexOf(selectedNode) : -1;
  const prev = selIndex > 0 ? visibleSteps[selIndex - 1] : null;
  const next = selIndex >= 0 && selIndex < visibleSteps.length - 1 ? visibleSteps[selIndex + 1] : null;
  useEffect(() => {
    const onKey = (e) => {
      if (!selectedNode || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === "ArrowLeft" && prev) setSelectedId(prev.id);
      if (e.key === "ArrowRight" && next) setSelectedId(next.id);
      if (e.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedNode, prev, next]);

  const onSelect = (node) => setSelectedId(node && node.event ? node.id : null);

  const sendFeedback = async (event, verdict) => {
    setVerdicts((m) => ({ ...m, [event._key]: "sending" }));
    try {
      const r = await fetch(feedbackUrl(project), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(session) },
        body: JSON.stringify({
          verdict,
          session_id: event.session_id,
          tool: event.tool,
          target: event.target,
          decision: event.decision,
          reasons: event.reasons || [],
          event_ts: event.ts,
        }),
      });
      setVerdicts((m) => ({ ...m, [event._key]: r.ok ? verdict : "error" }));
    } catch {
      setVerdicts((m) => ({ ...m, [event._key]: "error" }));
    }
  };
  const focusCategory = CATEGORIES.find((c) => c.id === focusCat) || null;
  const focusSteps = focusCategory ? visibleSteps.filter((n) => focusCategory.match(n)) : [];
  const is2d = mode === "2d";

  return (
    <div style={{ display: "flex", height: "100%", width: "100%", background: T.page, color: T.ink, overflow: "hidden", fontFamily: T.font }}>
      <div style={{ flex: "1 1 0%", minWidth: 0, display: "flex", flexDirection: "column" }}>
        <ReplayBar
          session={activeSession}
          steps={trail.nodes.filter((n) => n.event)}
          shown={shown}
          total={total}
          onScrub={scrub}
          incidents={incidents}
          incIndex={incIndex}
          onIncident={gotoIncident}
          mode={mode}
          onMode={switchTo}
        />

        <div style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden", perspective: 1800, background: T.page }}>
          {/* 3D layer: camera tilts to top-down and fades as it hands over to 2D */}
          <div
            className="ax-morph"
            style={{
              position: "absolute",
              inset: 0,
              opacity: is2d ? 0 : 1,
              transitionDelay: is2d ? "0ms, 260ms" : "0ms, 0ms",
              pointerEvents: is2d ? "none" : "auto",
              visibility: live3d ? "visible" : "hidden",
              contentVisibility: live3d ? "visible" : "hidden",
            }}
          >
            <IsoTrail
              trail={visibleTrail}
              layoutSteps={total}
              sessionKey={activeSessionId || "none"}
              connected={connected}
              live={following && !!activeSession}
              selectedId={selectedId}
              relatedIds={relatedIds}
              onSelect={onSelect}
              focusCat={focusCat}
              onFocusCat={setFocusCat}
              flat={flat}
              showLegend={false}
            />
          </div>

          {/* 2D layer: settles in from the 3D camera angle */}
          <div
            className="ax-morph"
            style={{
              position: "absolute",
              inset: 0,
              transformOrigin: "50% 35%",
              transform: is2d ? "none" : TILTED,
              opacity: is2d ? 1 : 0,
              pointerEvents: is2d ? "auto" : "none",
              visibility: is2d ? "visible" : "hidden",
              // visibility flips instantly on the way in, and only after the tilt on the way out
              transitionProperty: "transform, opacity, visibility",
              transitionDuration: `${MORPH_MS}ms, 420ms, 0ms`,
              transitionDelay: is2d ? "0ms, 200ms, 0ms" : `0ms, 0ms, ${MORPH_MS}ms`,
            }}
          >
            <TwoDTrail
              trail={visibleTrail}
              analysis={analysis}
              sessionKey={activeSessionId || "none"}
              selectedId={selectedId}
              relatedIds={relatedIds}
              onSelect={onSelect}
              focusCat={focusCat}
              onFocusCat={setFocusCat}
              follow={following && scrubPos === null}
              active={is2d}
            />
          </div>
        </div>

        <Legend />
      </div>

      <div style={{ flex: "0 0 clamp(300px, 24%, 380px)", minWidth: 0, borderLeft: `1px solid ${T.border}`, display: "flex", flexDirection: "column", background: T.surface }}>
        <div style={{ padding: "12px 14px", borderBottom: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 15, fontWeight: 500, fontFamily: T.fontSerif }}>Live Path</div>
          <button
            className="ax-seg-btn"
            onClick={() => setPinnedSession(null)}
            disabled={following}
            title={following ? "Following the newest session" : "Jump back to the newest session"}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              fontWeight: 600,
              fontFamily: T.font,
              padding: "4px 10px",
              borderRadius: T.radiusSm,
              border: `1px solid ${following ? tint(T.good, 40) : T.border}`,
              background: following ? tint(T.good, 12) : T.surface,
              color: following ? T.goodInk : T.inkSecondary,
              cursor: following ? "default" : "pointer",
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: following && connected ? T.good : T.inkMuted }} />
            {following ? "Following live" : "Follow live"}
          </button>
        </div>

        <div className="ax-scroll" style={{ padding: 8, borderBottom: `1px solid ${T.border}`, maxHeight: 200, overflowY: "auto" }}>
          {sessions.length === 0 && <div style={{ fontSize: 12, color: T.inkMuted, padding: 6 }}>No sessions yet.</div>}
          {sessions.map((s, i) => (
            <SessionPill
              key={s.sessionId}
              session={s}
              active={s.sessionId === activeSessionId}
              isLive={i === 0 && following}
              onClick={() => setPinnedSession(i === 0 ? null : s.sessionId)}
            />
          ))}
        </div>

        <div className="ax-scroll" style={{ flex: 1, overflowY: "auto", padding: 14 }}>
          {focusCategory && (
            <ResourceSteps category={focusCategory} steps={focusSteps} selectedId={selectedId} onPick={onSelect} onClose={() => setFocusCat(null)} />
          )}
          {selectedNode ? (
            <StepDetail
              key={selectedNode.id}
              node={selectedNode}
              total={visibleSteps.length}
              prev={prev}
              next={next}
              onPick={onSelect}
              analysis={analysis}
              verdict={verdicts[selectedNode.event._key]}
              onVerdict={(v) => sendFeedback(selectedNode.event, v)}
            />
          ) : (
            !focusCategory && (
              <div style={{ fontSize: 12, color: T.inkMuted, textAlign: "center", marginTop: 20 }}>
                Click a step, or a {is2d ? "lane header" : "resource block"}, for details.
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function ReplayBar({ session, steps, shown, total, onScrub, incidents, incIndex, onIncident, mode, onMode }) {
  const meta = sourceMeta(session ? session.source : null);
  const counts = steps.reduce((acc, n) => ({ ...acc, [n.severity]: (acc[n.severity] || 0) + 1 }), {});
  const pct = total ? (shown / total) * 100 : 100;
  return (
    <div style={{ padding: "12px 20px", borderBottom: `1px solid ${T.border}`, background: T.surface, display: "flex", flexDirection: "column", gap: 10, flexShrink: 0 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, padding: "2px 8px 2px 4px", borderRadius: T.radiusSm, border: `1px solid ${T.border}`, background: T.page }}>
              <span style={{ width: 16, height: 16, borderRadius: 3, background: T.ink, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                <meta.Icon size={10} color={T.page} />
              </span>
              {meta.label}
            </span>
            <span style={{ fontSize: 11.5, color: T.inkMuted }}>Session trace</span>
          </div>
          <div style={{ fontFamily: T.fontMono, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {session ? session.headline : "No session yet"}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <span style={{ fontFamily: T.fontMono, fontSize: 20, fontWeight: 600 }}>{total}</span>
          <span style={{ fontSize: 11.5, color: T.inkMuted, marginRight: 4 }}>steps</span>
          {["clean", "flagged", "warning", "critical", "approved", "denied"]
            .filter((k) => counts[k])
            .map((k) => (
              <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: T.radiusSm, background: tint(STATUS[k].color, 12), color: STATUS[k].ink }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: STATUS[k].color }} />
                {counts[k]} {STATUS[k].label.toLowerCase()}
              </span>
            ))}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <IncidentNav incidents={incidents} index={incIndex} onGo={onIncident} />
        <input
          className="ax-range"
          type="range"
          min={0}
          max={Math.max(total, 1)}
          value={shown}
          onChange={(e) => onScrub(Number(e.target.value))}
          aria-label="Replay position"
          disabled={!total}
          style={{ flex: 1, minWidth: 80, "--p": `${pct}%` }}
        />
        <span style={{ fontFamily: T.fontMono, fontSize: 11.5, color: T.inkMuted, whiteSpace: "nowrap", minWidth: 92, textAlign: "right" }}>
          Step {shown} / {total}
        </span>
        <ViewToggle mode={mode} onMode={onMode} />
      </div>
    </div>
  );
}

// ◀ Incident 2 of 3 ▶ -- jump straight to what needs a look
function IncidentNav({ incidents, index, onGo }) {
  const n = incidents.length;
  const arrow = (dir, label) => (
    <button
      className="ax-btn"
      onClick={() => onGo(dir)}
      disabled={!n}
      aria-label={label}
      title={label}
      style={{ width: 26, height: 28, border: "none", background: "transparent", color: n ? T.ink : T.inkMuted, cursor: n ? "pointer" : "default", fontSize: 12, padding: 0 }}
    >
      {dir < 0 ? "◀" : "▶"}
    </button>
  );
  const sev = index >= 0 ? STATUS[incidents[index].severity] : null;
  return (
    <div style={{ display: "inline-flex", alignItems: "center", height: 30, borderRadius: T.radius, border: `1px solid ${n ? tint(T.critical, 35) : T.border}`, background: n ? tint(T.critical, 6) : T.page, flexShrink: 0 }}>
      {arrow(-1, "Previous incident")}
      <span style={{ fontSize: 11.5, fontWeight: 600, minWidth: 118, textAlign: "center", color: n ? T.ink : T.inkMuted, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
        {sev && <span style={{ width: 6, height: 6, borderRadius: "50%", background: sev.color }} />}
        {!n ? "No incidents" : index >= 0 ? `Incident ${index + 1} of ${n}` : `${n} incident${n === 1 ? "" : "s"}`}
      </span>
      {arrow(1, "Next incident")}
    </div>
  );
}

const TOGGLE_W = 38;
function ViewToggle({ mode, onMode }) {
  return (
    <div role="tablist" aria-label="Graph view" style={{ position: "relative", display: "flex", padding: 2, borderRadius: T.radius, border: `1px solid ${T.border}`, background: T.page, flexShrink: 0 }}>
      <span
        className="ax-tab-indicator"
        aria-hidden
        style={{
          position: "absolute",
          top: 2,
          bottom: 2,
          left: 2,
          width: TOGGLE_W,
          transform: `translateX(${mode === "2d" ? 0 : TOGGLE_W}px)`,
          borderRadius: T.radiusSm,
          background: T.surface,
          boxShadow: `inset 0 0 0 1px ${T.border}, ${T.shadow}`,
        }}
      />
      {["2d", "3d"].map((m) => (
        <button
          key={m}
          role="tab"
          aria-selected={mode === m}
          onClick={() => onMode(m)}
          style={{
            position: "relative",
            width: TOGGLE_W,
            height: 24,
            border: "none",
            background: "transparent",
            fontFamily: T.font,
            fontSize: 11.5,
            fontWeight: 600,
            color: mode === m ? T.ink : T.inkMuted,
            cursor: "pointer",
            transition: "color 160ms ease",
          }}
        >
          {m.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function Legend() {
  const items = [
    ["Allowed", T.good],
    ["Flagged", T.flagged],
    ["Approval requested", T.warning],
    ["Blocked / denied", T.critical],
    ["Approved by you", T.approved],
  ];
  return (
    <div style={{ display: "flex", gap: 16, padding: "8px 20px", borderTop: `1px solid ${T.border}`, background: T.surface, fontSize: 11, color: T.inkMuted, flexShrink: 0 }}>
      {items.map(([label, color]) => (
        <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 14, height: 3, borderRadius: 2, background: color }} />
          {label}
        </span>
      ))}
    </div>
  );
}

function SessionPill({ session, active, isLive, onClick }) {
  const status = STATUS[session.severity];
  return (
    <div
      onClick={onClick}
      className="ax-seg-btn"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "6px 8px",
        marginBottom: 2,
        borderRadius: T.radiusSm,
        background: active ? tint(status.color, 10) : "transparent",
        border: `1px solid ${active ? tint(status.color, 40) : "transparent"}`,
        cursor: "pointer",
        fontSize: 11.5,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: status.color, flexShrink: 0 }} />
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontFamily: T.fontMono }}>{session.headline}</span>
      </div>
      {isLive && <span style={{ fontSize: 9, color: T.goodInk, fontWeight: 700, flexShrink: 0, letterSpacing: 0.4 }}>LIVE</span>}
    </div>
  );
}

function ResourceSteps({ category, steps, selectedId, onPick, onClose }) {
  return (
    <div style={{ marginBottom: 14, paddingBottom: 12, borderBottom: `1px solid ${T.border}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ width: 24, height: 24, borderRadius: T.radiusSm, background: T.ink, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
          <category.Icon size={14} color={T.page} />
        </span>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{category.label}</div>
        <div style={{ fontSize: 11, color: T.inkMuted }}>
          {steps.length} step{steps.length === 1 ? "" : "s"}
        </div>
        <button onClick={onClose} style={{ marginLeft: "auto", fontSize: 11, color: T.inkMuted, background: "none", border: "none", cursor: "pointer" }}>
          Clear ✕
        </button>
      </div>
      {steps.length === 0 && <div style={{ fontSize: 12, color: T.inkMuted }}>Nothing in this session touched {category.label.toLowerCase()}.</div>}
      {steps.map((n) => {
        const status = STATUS[n.severity];
        const active = selectedId === n.id;
        return (
          <div
            key={n.id}
            onClick={() => onPick(n)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 8px",
              marginBottom: 3,
              borderRadius: T.radiusSm,
              cursor: "pointer",
              background: active ? T.surfaceRaised : "transparent",
              border: `1px solid ${active ? tint(status.color, 40) : "transparent"}`,
            }}
          >
            <span style={{ minWidth: 20, height: 20, borderRadius: 4, background: status.color, color: T.onAccent, fontSize: 10.5, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
              {n.step}
            </span>
            <span style={{ fontSize: 12, fontFamily: T.fontMono, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: 1 }}>{n.label}</span>
            <status.Icon size={13} color={status.color} />
          </div>
        );
      })}
    </div>
  );
}

function StepDetail({ node, total, prev, next, onPick, analysis, verdict, onVerdict }) {
  const event = node.event;
  const ex = explainStep(node, analysis);
  const status = STATUS[eventSeverity(event)];
  const visibleTags = (event.tags || []).filter((t) => TAG_LABELS[t]);
  const lane = LANES.find((l) => l.id === laneOf(node));
  const [open, setOpen] = useState(false);
  const { _key, ...raw } = event;
  const rows = [
    ["Resource", lane ? lane.label : "—"],
    ["Tool", event.tool],
    ["Decision", event.decision || "—"],
    ...(event.reasons && event.reasons.length ? [["Reason", event.reasons.map(humanReason).join(", ")]] : []),
    ...(event.risk_score !== undefined ? [["Risk score", String(event.risk_score)]] : []),
    ["When", timeAgo(event.ts)],
  ];
  return (
    <div className="ax-expand">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.6, color: T.inkMuted, fontFamily: T.fontMono }}>
          STEP {node.step} OF {total}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: T.radiusSm, background: tint(status.color, 12), color: status.ink }}>
          <status.Icon size={11} color={status.color} />
          {status.label}
        </span>
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>{stepTitle(event)}</div>
      <div style={{ fontFamily: T.fontMono, fontSize: 12, padding: "8px 10px", borderRadius: T.radiusSm, background: T.sunken, border: `1px solid ${T.border}`, wordBreak: "break-all", marginBottom: 12 }}>
        {event.target}
      </div>
      <WhyPanel ex={ex} status={status} onPick={onPick} verdict={verdict} onVerdict={onVerdict} />
      <div style={{ display: "grid", gridTemplateColumns: "84px 1fr", rowGap: 6, fontSize: 12, marginBottom: 10 }}>
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <span style={{ color: T.inkMuted }}>{k}</span>
            <span style={{ fontFamily: k === "Tool" || k === "Decision" ? T.fontMono : T.font, wordBreak: "break-word" }}>{v}</span>
          </React.Fragment>
        ))}
      </div>
      {visibleTags.length > 0 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 10 }}>
          {visibleTags.map((t) => (
            <span key={t} style={{ fontSize: 10.5, padding: "1px 7px", borderRadius: T.radiusSm, background: T.surfaceRaised, border: `1px solid ${T.border}`, color: T.inkSecondary }}>
              {TAG_LABELS[t]}
            </span>
          ))}
        </div>
      )}
      <button className="ax-link-btn" onClick={() => setOpen((o) => !o)} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: "none", padding: 0, fontSize: 12, fontWeight: 600, color: T.goodInk, cursor: "pointer", fontFamily: T.font }}>
        {open ? "Hide details" : "Show details"} <IconChevron expanded={open} size={12} />
      </button>
      {open && (
        <pre className="ax-expand ax-scroll" style={{ marginTop: 8, padding: 10, borderRadius: T.radiusSm, background: T.code, border: `1px solid ${T.border}`, fontSize: 11, fontFamily: T.fontMono, overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          {JSON.stringify(raw, null, 2)}
        </pre>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 14 }}>
        <NavButton label="← Previous" node={prev} onPick={onPick} />
        <NavButton label="Next →" node={next} onPick={onPick} align="right" />
      </div>
    </div>
  );
}

function NavButton({ label, node, onPick, align = "left" }) {
  return (
    <button
      className="ax-btn"
      disabled={!node}
      onClick={() => node && onPick(node)}
      style={{
        textAlign: align,
        padding: "8px 10px",
        borderRadius: T.radius,
        border: `1px solid ${T.border}`,
        background: T.page,
        color: T.ink,
        fontFamily: T.font,
        cursor: node ? "pointer" : "default",
        opacity: node ? 1 : 0.45,
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: 10.5, color: T.inkMuted }}>{label}</div>
      <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {node ? `Step ${node.step} · ${stepTitle(node.event)}` : "—"}
      </div>
    </button>
  );
}

// The security story for one step: what happened, what caused it, what it
// led to, and what you can do about it.
function WhyPanel({ ex, status, onPick, verdict, onVerdict }) {
  const hasCause = ex.causes.some((c) => c.sources.length);
  if (!ex.verdict && !ex.brought.length && !ex.ledTo.length && !ex.why.length) return null;
  const goPolicy = (prefill) => window.dispatchEvent(new CustomEvent("argox:navigate", { detail: { view: "policy", prefill } }));
  const label = { fontSize: 10.5, fontWeight: 600, letterSpacing: 0.5, color: T.inkMuted, fontFamily: T.fontMono, margin: "10px 0 5px" };
  return (
    <div style={{ marginBottom: 12, padding: "10px 12px", borderRadius: T.radius, border: `1px solid ${ex.verdict ? tint(status.color, 40) : T.border}`, background: ex.verdict ? tint(status.color, 6) : T.page }}>
      {ex.verdict && <div style={{ fontSize: 12.5, fontWeight: 700, color: status.ink }}>{ex.verdict}</div>}
      {ex.why.map((w, i) => (
        <p key={i} style={{ fontSize: 12, lineHeight: 1.5, margin: "6px 0 0", color: T.inkSecondary }}>{w}</p>
      ))}

      {hasCause && (
        <>
          <div style={label}>DATA CAME FROM</div>
          {ex.causes.flatMap((c) => c.sources.map((s) => <StepLink key={`${c.tag}-${s.id}`} node={s} tag={c.tag} onPick={onPick} />))}
        </>
      )}

      {ex.brought.length > 0 && (
        <>
          <div style={label}>BROUGHT INTO THE SESSION</div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {ex.brought.map((t) => (
              <span key={t} style={{ fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 3, color: TAG_INFO[t].color, background: tint(TAG_INFO[t].color, 14) }}>{TAG_INFO[t].label}</span>
            ))}
          </div>
          <p style={{ fontSize: 11.5, lineHeight: 1.5, margin: "6px 0 0", color: T.inkMuted }}>
            From here on, any call that sends data outside your trust boundary is checked against this.
          </p>
        </>
      )}

      {ex.ledTo.length > 0 && (
        <>
          <div style={label}>LED TO</div>
          {ex.ledTo.map((n) => (
            <StepLink key={n.id} node={n} onPick={onPick} />
          ))}
        </>
      )}

      {ex.fixes.length > 0 && (
        <>
          <div style={label}>HOW TO FIX</div>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {ex.fixes.map((f, i) => (
              <li key={i} style={{ fontSize: 12, lineHeight: 1.5, color: T.inkSecondary, marginBottom: 4 }}>
                {f.text}
                {f.action && (
                  <button onClick={() => goPolicy(f.action.prefill)} className="ax-link-btn" style={{ marginLeft: 6, padding: 0, border: "none", background: "none", color: T.goodInk, fontWeight: 600, fontSize: 12, cursor: "pointer", fontFamily: T.font }}>
                    {f.action.label} →
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {ex.verdict && <VerdictRow verdict={verdict} onVerdict={onVerdict} />}
    </div>
  );
}

// "Was this decision right?" -- false positives are what get a security
// tool switched off, so make reporting one a single click.
function VerdictRow({ verdict, onVerdict }) {
  const done = verdict === "correct" || verdict === "false_positive";
  const btn = (v, label) => (
    <button
      className="ax-btn"
      onClick={() => onVerdict(v)}
      disabled={verdict === "sending"}
      style={{
        padding: "4px 10px",
        borderRadius: T.radiusSm,
        border: `1px solid ${T.border}`,
        background: T.surface,
        color: T.ink,
        fontSize: 11.5,
        fontWeight: 600,
        fontFamily: T.font,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
      {done ? (
        <span style={{ fontSize: 12, color: T.inkSecondary }}>
          Thanks — recorded as {verdict === "correct" ? "the right call" : "a false positive"}.
        </span>
      ) : (
        <>
          <span style={{ fontSize: 12, color: T.inkSecondary, marginRight: 2 }}>Was this the right call?</span>
          {btn("correct", "Yes")}
          {btn("false_positive", "No, false positive")}
          {verdict === "error" && <span style={{ fontSize: 11.5, color: T.criticalInk }}>Couldn't save — try again.</span>}
        </>
      )}
    </div>
  );
}

function StepLink({ node, tag, onPick }) {
  const st = STATUS[node.severity];
  return (
    <button
      className="ax-btn"
      onClick={() => onPick(node)}
      style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", textAlign: "left", padding: "5px 7px", marginBottom: 4, borderRadius: T.radiusSm, border: `1px solid ${T.border}`, background: T.surface, cursor: "pointer", fontFamily: T.font, color: T.ink }}
    >
      <span style={{ minWidth: 18, height: 18, borderRadius: 4, background: st.color, color: "#fff", fontSize: 10, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{node.step}</span>
      <span style={{ fontSize: 12, fontWeight: 600, flexShrink: 0 }}>{stepTitle(node.event)}</span>
      <span style={{ fontSize: 11, fontFamily: T.fontMono, color: T.inkSecondary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: 1 }}>{node.label}</span>
      {tag && <span style={{ fontSize: 10, fontWeight: 700, color: TAG_INFO[tag].color, flexShrink: 0 }}>{TAG_INFO[tag].label}</span>}
    </button>
  );
}
