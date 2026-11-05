import React, { useEffect, useMemo, useState } from "react";
import { T, STATUS, TAG_LABELS, humanReason, eventSeverity } from "./theme.jsx";
import { groupBySession, timeAgo } from "./sessionUtils.js";
import { useEventStream } from "./useEventStream.js";
import { buildTrail } from "./pathLayout.js";
import IsoTrail, { CATEGORIES } from "./IsoTrail.jsx";

/**
 * Live path-tracing view. Each session is an actual chain: step 1 -> 2
 * -> 3 in call order, so you can ask Claude Code to "fix the taskbar
 * issue" and watch the trail extend live, file by file, tool by tool,
 * until it's done. Rendered as an isometric 3D scene (see IsoTrail.jsx).
 *
 * Defaults to auto-following the most recently active session (so a
 * brand-new task takes over the view the moment it starts); clicking an
 * older session in the sidebar pins the view there until you click
 * "Follow live" again.
 */

export default function Argox({ wsUrl = "ws://localhost:8765" }) {
  const { events, connected } = useEventStream(wsUrl);
  const [pinnedSession, setPinnedSession] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [focusCat, setFocusCat] = useState(null);

  const sessions = useMemo(() => groupBySession(events), [events]);
  const activeSessionId = pinnedSession || (sessions[0] && sessions[0].sessionId);
  const activeSession = sessions.find((s) => s.sessionId === activeSessionId) || null;
  const following = !pinnedSession;

  const trail = useMemo(() => buildTrail(activeSession), [activeSession]);
  const nodes = trail.nodes;

  // deselect a node that no longer exists (switched session)
  useEffect(() => {
    if (selectedNode && !nodes.some((n) => n.id === selectedNode.id)) setSelectedNode(null);
  }, [nodes, selectedNode]);

  useEffect(() => setFocusCat(null), [activeSessionId]);

  const focusCategory = CATEGORIES.find((c) => c.id === focusCat) || null;
  const focusSteps = focusCategory ? nodes.filter((n) => n.event && focusCategory.match(n)) : [];

  return (
    <div style={{ display: "flex", height: "100%", width: "100%", background: T.page, color: T.ink, overflow: "hidden", fontFamily: T.font }}>
      <div style={{ flex: "2 1 0%", minWidth: 0, position: "relative", overflow: "hidden" }}>
        <IsoTrail
          trail={trail}
          sessionKey={activeSessionId || "none"}
          connected={connected}
          live={following && !!activeSession}
          selectedId={selectedNode ? selectedNode.id : null}
          onSelect={(node) => setSelectedNode(node && node.event ? node : null)}
          focusCat={focusCat}
          onFocusCat={setFocusCat}
        />
      </div>

      <div style={{ flex: "1 0 300px", minWidth: 0, maxWidth: 360, borderLeft: `1px solid ${T.border}`, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "10px 14px", borderBottom: `1px solid ${T.border}`, background: T.surface }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 500, fontFamily: T.fontSerif }}>Live Path</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: T.inkMuted }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: connected ? T.good : T.inkMuted, display: "inline-block" }} />
              {connected ? "Connected" : "Disconnected"}
            </div>
          </div>
          {!following && (
            <button
              onClick={() => setPinnedSession(null)}
              style={{ marginTop: 8, fontSize: 11, background: `${T.good}22`, color: T.good, border: `1px solid ${T.good}`, borderRadius: 4, padding: "4px 10px", cursor: "pointer" }}
            >
              ● Follow live session
            </button>
          )}
        </div>

        <div style={{ padding: 10, borderBottom: `1px solid ${T.border}`, maxHeight: 220, overflowY: "auto" }}>
          <div style={{ fontSize: 11, color: T.inkMuted, marginBottom: 6 }}>Sessions</div>
          {sessions.length === 0 && <div style={{ fontSize: 12, opacity: 0.5 }}>No sessions yet.</div>}
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

        <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
          {focusCategory && (
            <ResourceSteps
              category={focusCategory}
              steps={focusSteps}
              selectedId={selectedNode ? selectedNode.id : null}
              onPick={setSelectedNode}
              onClose={() => setFocusCat(null)}
            />
          )}
          {selectedNode && selectedNode.event ? (
            <NodeDetail event={selectedNode.event} step={selectedNode.step} />
          ) : (
            !focusCategory && (
              <div style={{ fontSize: 12, opacity: 0.5, textAlign: "center", marginTop: 20 }}>Click a step in the path, or a resource block, for details.</div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function SessionPill({ session, active, isLive, onClick }) {
  const status = STATUS[session.severity];
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "6px 8px",
        marginBottom: 4,
        borderRadius: 6,
        background: active ? T.surfaceRaised : "transparent",
        border: `1px solid ${active ? status.color + "55" : "transparent"}`,
        cursor: "pointer",
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: status.color, flexShrink: 0 }} />
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{session.headline}</span>
      </div>
      {isLive && (
        <span style={{ fontSize: 9, color: T.good, fontWeight: 700, flexShrink: 0, letterSpacing: 0.3 }}>● LIVE</span>
      )}
    </div>
  );
}

function ResourceSteps({ category, steps, selectedId, onPick, onClose }) {
  return (
    <div style={{ marginBottom: 14, paddingBottom: 12, borderBottom: `1px solid ${T.border}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ width: 24, height: 24, borderRadius: 6, background: T.ink, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
          <category.Icon size={14} color="#fff" />
        </span>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{category.label}</div>
        <div style={{ fontSize: 11, color: T.inkMuted }}>
          {steps.length} step{steps.length === 1 ? "" : "s"}
        </div>
        <button onClick={onClose} style={{ marginLeft: "auto", fontSize: 11, color: T.inkMuted, background: "none", border: "none", cursor: "pointer" }}>
          Clear ✕
        </button>
      </div>
      {steps.length === 0 && <div style={{ fontSize: 12, opacity: 0.5 }}>Nothing in this session touched {category.label.toLowerCase()}.</div>}
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
              borderRadius: 6,
              cursor: "pointer",
              background: active ? T.surfaceRaised : "transparent",
              border: `1px solid ${active ? status.color + "55" : "transparent"}`,
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

function NodeDetail({ event, step }) {
  const status = STATUS[eventSeverity(event)];
  const visibleTags = (event.tags || []).filter((t) => TAG_LABELS[t]);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <span style={{ fontSize: 11, color: T.inkMuted }}>Step {step}</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, padding: "1px 7px 1px 5px", borderRadius: 4, background: `${status.color}1f`, color: status.color, fontWeight: 600 }}>
          <status.Icon size={10} color={status.color} />
          {status.label}
        </span>
      </div>
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>{event.tool}</div>
      <div style={{ fontSize: 12, opacity: 0.8, wordBreak: "break-all", marginBottom: 8 }}>{event.target}</div>
      {event.reasons && event.reasons.length > 0 && (
        <div style={{ fontSize: 11.5, opacity: 0.6, marginBottom: 8 }}>{event.reasons.map(humanReason).join(", ")}</div>
      )}
      {visibleTags.length > 0 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
          {visibleTags.map((t) => (
            <span key={t} style={{ fontSize: 10, padding: "1px 7px", borderRadius: 4, background: T.surfaceRaised, border: `1px solid ${T.border}`, color: T.inkSecondary }}>
              {TAG_LABELS[t]}
            </span>
          ))}
        </div>
      )}
      {event.risk_score !== undefined && (
        <div style={{ fontSize: 11, opacity: 0.6 }}>risk score: {event.risk_score}</div>
      )}
      <div style={{ fontSize: 11, opacity: 0.5, marginTop: 4 }}>{timeAgo(event.ts)}</div>
    </div>
  );
}
