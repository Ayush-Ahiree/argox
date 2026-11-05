import React, { useEffect, useState, useCallback, useMemo } from "react";
import {
  T,
  tint,
  STATUS,
  TOOL_META,
  TAG_LABELS,
  sourceMeta,
  humanReason,
  eventSeverity,
  IconChevron,
  IconAlert,
  IconX,
  IconLock,
  IconShield,
  IconSearch,
  IconDownload,
  IconTrash,
  IconFile,
} from "./theme.jsx";
import { groupBySession, formatDuration, resolutionFor, unresolvedPending } from "./sessionUtils.js";
import { useEventStream } from "./useEventStream.js";
import { buildTrail } from "./pathLayout.js";

/**
 * Chronological event feed -- the default Argox view. For a security-review
 * workflow you want to read "what happened, in order, and did anything need
 * my attention" at a glance.
 *
 * Events are grouped into per-session cards: a single agent run can fire
 * many events in under a second, and a flat list makes that read as noise
 * instead of one story. Each expanded card is a vertical timeline on the
 * left and a session summary (counts + numbered path) on the right.
 *
 * Also owns the pause/confirm back-channel: a `confirm_request` event shows
 * Approve/Deny on the matching timeline row (and in a banner, in case that
 * row is filtered out). Clicking POSTs the decision to the relay's
 * /confirm-response endpoint, which the paused tool call picks up.
 */

const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "asked", label: "Needs approval", color: T.warning },
  { value: "blocked", label: "Blocked", color: T.critical },
  { value: "flagged", label: "Flagged", color: T.flagged },
  { value: "clean", label: "Clean", color: T.good },
];

function sessionMatches(session, filter) {
  if (filter === "all") return true;
  if (filter === "clean") return !session.blocked && !session.asked && !session.flagged;
  return session[filter] > 0;
}

export default function EventFeed({ wsUrl = "ws://localhost:8765", authSession = null }) {
  const { events, pending, connected, resolveConfirm, clearEvents } = useEventStream(wsUrl, authSession);
  const [expandedEvents, setExpandedEvents] = useState(() => new Set());
  const [sessionOverrides, setSessionOverrides] = useState({});
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [toolFilter, setToolFilter] = useState("all");
  const [confirmClear, setConfirmClear] = useState(false);

  const toolOptions = useMemo(() => {
    const seen = new Set(events.map((e) => e.tool).filter(Boolean));
    return Array.from(seen).sort();
  }, [events]);

  // search + tool filter narrow the events; the status filter then picks
  // whole sessions, so the chip counts match what you'll see.
  const searchedEvents = useMemo(() => {
    const q = search.trim().toLowerCase();
    return events.filter((e) => {
      if (toolFilter !== "all" && e.tool !== toolFilter) return false;
      if (q) {
        const hay = [e.target, e.tool, e.session_id, ...(e.reasons || []).map(humanReason)]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [events, search, toolFilter]);

  const searchedSessions = useMemo(() => groupBySession(searchedEvents), [searchedEvents]);
  const sessions = useMemo(() => searchedSessions.filter((s) => sessionMatches(s, statusFilter)), [searchedSessions, statusFilter]);
  const allSessions = useMemo(() => groupBySession(events), [events]);

  const filterCounts = useMemo(
    () => Object.fromEntries(STATUS_FILTERS.map((f) => [f.value, searchedSessions.filter((s) => sessionMatches(s, f.value)).length])),
    [searchedSessions]
  );

  const totals = useMemo(
    () => ({
      sessions: allSessions.length,
      toolCalls: allSessions.reduce((n, s) => n + s.toolCalls, 0),
      blocked: allSessions.reduce((n, s) => n + s.blocked, 0),
      asked: allSessions.reduce((n, s) => n + s.asked, 0),
      flagged: allSessions.reduce((n, s) => n + s.flagged, 0),
    }),
    [allSessions]
  );

  const filtersActive = search.trim() !== "" || statusFilter !== "all" || toolFilter !== "all";

  const toggleSession = useCallback((sessionId, currentEffective) => {
    setSessionOverrides((prev) => ({ ...prev, [sessionId]: !currentEffective }));
  }, []);

  const toggleEvent = useCallback((key) => {
    setExpandedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const exportJson = useCallback(() => {
    const data = sessions.flatMap((s) => s.events).map(({ _key, ...rest }) => rest);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `argox-events-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [sessions]);

  const handleClearClick = useCallback(() => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    clearEvents();
    setConfirmClear(false);
  }, [confirmClear, clearEvents]);

  return (
    <div className="ax-scroll" style={{ height: "100%", width: "100%", overflowY: "auto", background: T.page, color: T.ink, fontFamily: T.font }}>
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "28px 32px 48px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, marginBottom: 18 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: -0.4 }}>Event Feed</h1>
            <div style={{ fontSize: 13, color: T.inkMuted, marginTop: 4 }}>Every tool call your agents make, grouped by session.</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <ToolbarButton onClick={exportJson} disabled={sessions.length === 0} icon={<IconDownload size={13} color={T.inkSecondary} />}>
              Export JSON
            </ToolbarButton>
            <ToolbarButton
              onClick={handleClearClick}
              onBlur={() => setConfirmClear(false)}
              disabled={events.length === 0}
              danger
              icon={<IconTrash size={13} color={T.criticalInk} />}
            >
              {confirmClear ? "Click again to clear" : "Clear logs"}
            </ToolbarButton>
          </div>
        </div>

        <StatStrip totals={totals} />

        {pending.length > 0 && (
          <div style={{ marginTop: 14 }}>
            {pending.map((item) => (
              <ConfirmBanner key={item.id} item={item} onResolve={resolveConfirm} />
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "stretch", marginTop: 16, flexWrap: "wrap" }}>
          <SearchBox value={search} onChange={setSearch} />
          <Segmented value={statusFilter} onChange={setStatusFilter} counts={filterCounts} />
          <ToolSelect
            value={toolFilter}
            onChange={setToolFilter}
            options={[{ value: "all", label: "All tools" }, ...toolOptions.map((t) => ({ value: t, label: TOOL_META[t]?.label || t }))]}
          />
        </div>

        <div style={{ fontSize: 12, color: T.inkMuted, margin: "16px 0 10px", display: "flex", justifyContent: "space-between" }}>
          <span>
            <b style={{ color: T.ink, fontWeight: 600 }}>{sessions.length}</b> session{sessions.length === 1 ? "" : "s"}
          </span>
          {!connected && <span>Disconnected — reconnecting…</span>}
        </div>

        {events.length === 0 && <EmptyState>Waiting for events — connect an agent from the Connect tab, then run anything.</EmptyState>}
        {events.length > 0 && sessions.length === 0 && <EmptyState>No sessions match{filtersActive ? " these filters" : ""}.</EmptyState>}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sessions.map((session, i) => {
            const defaultExpanded = i === 0 || session.asked > 0;
            const effectiveExpanded = Object.prototype.hasOwnProperty.call(sessionOverrides, session.sessionId)
              ? sessionOverrides[session.sessionId]
              : defaultExpanded;
            return (
              <SessionCard
                key={session.sessionId}
                session={session}
                expanded={effectiveExpanded}
                onToggle={() => toggleSession(session.sessionId, effectiveExpanded)}
                expandedEvents={expandedEvents}
                onToggleEvent={toggleEvent}
                pending={pending}
                onResolve={resolveConfirm}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- header

function StatStrip({ totals }) {
  const cells = [
    { label: "Sessions", value: totals.sessions, dot: T.ink },
    { label: "Tool calls", value: totals.toolCalls, dot: T.inkMuted },
    { label: "Needs approval", value: totals.asked, dot: T.warning, ink: T.warningInk, highlight: totals.asked > 0 },
    { label: "Blocked", value: totals.blocked, dot: T.critical, ink: T.criticalInk },
    { label: "Flagged", value: totals.flagged, dot: T.flagged, ink: T.flaggedInk },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", border: `1px solid ${T.border}`, borderRadius: T.radius, background: T.surface, overflow: "hidden" }}>
      {cells.map((c, i) => (
        <div
          key={c.label}
          style={{
            padding: "12px 16px",
            borderLeft: i ? `1px solid ${T.border}` : "none",
            background: c.highlight ? T.warningSurface : "transparent",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: T.inkMuted }}>
            <span style={{ width: 6, height: 6, borderRadius: 1, background: c.dot }} />
            {c.label}
          </div>
          <div style={{ fontSize: 24, fontWeight: 600, fontFamily: T.fontMono, marginTop: 6, letterSpacing: -0.5, color: c.value && c.ink ? c.ink : T.ink }}>{c.value}</div>
        </div>
      ))}
    </div>
  );
}

function SearchBox({ value, onChange }) {
  return (
    <div style={{ position: "relative", flex: "1 1 260px", minWidth: 200 }}>
      <IconSearch size={14} color={T.inkMuted} style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)" }} />
      <input
        className="ax-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search target, tool, reason…"
        style={{
          width: "100%",
          height: "100%",
          minHeight: 36,
          boxSizing: "border-box",
          fontFamily: T.font,
          fontSize: 13,
          padding: "0 30px 0 32px",
          borderRadius: T.radius,
          border: `1px solid ${T.border}`,
          background: T.surface,
          color: T.ink,
          outline: "none",
        }}
      />
      {value && (
        <button
          onClick={() => onChange("")}
          aria-label="Clear search"
          style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex" }}
        >
          <IconX size={12} color={T.inkMuted} />
        </button>
      )}
    </div>
  );
}

function Segmented({ value, onChange, counts }) {
  return (
    <div style={{ display: "flex", gap: 2, padding: 3, border: `1px solid ${T.border}`, borderRadius: T.radius, background: T.surface }}>
      {STATUS_FILTERS.map((f) => {
        const active = value === f.value;
        return (
          <button
            key={f.value}
            onClick={() => onChange(f.value)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 10px",
              borderRadius: T.radiusSm,
              border: "none",
              background: active ? T.surfaceRaised : "transparent",
              boxShadow: active ? `inset 0 0 0 1px ${T.border}` : "none",
              color: active ? T.ink : T.inkSecondary,
              fontFamily: T.font,
              fontSize: 12.5,
              fontWeight: active ? 600 : 500,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {f.color && <span style={{ width: 6, height: 6, borderRadius: 1, background: f.color }} />}
            {f.label}
            <span style={{ fontFamily: T.fontMono, fontSize: 11, padding: "0 5px", borderRadius: 3, background: active ? T.surface : T.surfaceRaised, color: T.inkMuted }}>
              {counts[f.value] || 0}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ToolSelect({ value, onChange, options }) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "0 4px 0 12px",
        border: `1px solid ${T.border}`,
        borderRadius: T.radius,
        background: T.surface,
        fontSize: 12.5,
        color: T.inkMuted,
      }}
    >
      Tool
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ fontFamily: T.font, fontSize: 12.5, fontWeight: 600, padding: "8px 4px", border: "none", background: "transparent", color: T.ink, outline: "none", cursor: "pointer", maxWidth: 170 }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ToolbarButton({ onClick, disabled, danger, onBlur, icon, children }) {
  return (
    <button
      className="ax-btn"
      onClick={onClick}
      onBlur={onBlur}
      disabled={disabled}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontFamily: T.font,
        fontSize: 12.5,
        fontWeight: 600,
        height: 32,
        padding: "0 12px",
        borderRadius: T.radius,
        border: `1px solid ${danger ? tint(T.critical, 30) : T.border}`,
        background: T.surface,
        color: danger ? T.criticalInk : T.ink,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        whiteSpace: "nowrap",
        boxShadow: T.shadow,
      }}
    >
      {icon}
      {children}
    </button>
  );
}

function EmptyState({ children }) {
  return (
    <div style={{ border: `1px dashed ${T.borderStrong}`, borderRadius: T.radius, color: T.inkMuted, fontSize: 13, padding: 40, textAlign: "center" }}>{children}</div>
  );
}

function ConfirmBanner({ item, onResolve }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "10px 14px",
        marginBottom: 6,
        background: T.warningSurface,
        borderRadius: T.radius,
        border: `1px solid ${tint(T.warning, 45)}`,
      }}
    >
      <div style={{ fontSize: 13, minWidth: 0, display: "flex", gap: 10, alignItems: "flex-start" }}>
        <IconAlert size={16} color={T.warningInk} style={{ marginTop: 1, flexShrink: 0 }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>Approval needed — {TOOL_META[item.tool]?.label || item.tool}</div>
          <div style={{ fontFamily: T.fontMono, fontSize: 12, color: T.inkSecondary, wordBreak: "break-all", marginTop: 3 }}>{item.target}</div>
          {(item.reasons || []).length > 0 && <div style={{ fontSize: 12, color: T.inkMuted, marginTop: 3 }}>{item.reasons.map(humanReason).join(", ")}</div>}
        </div>
      </div>
      <ApproveDeny item={item} onResolve={onResolve} />
    </div>
  );
}

function ApproveDeny({ item, onResolve }) {
  const btn = (primary) => ({
    fontFamily: T.font,
    fontSize: 12.5,
    fontWeight: 600,
    height: 30,
    padding: "0 14px",
    borderRadius: T.radius,
    cursor: "pointer",
    border: primary ? "none" : `1px solid ${T.borderStrong}`,
    background: primary ? T.ink : T.surface,
    color: primary ? T.page : T.ink,
  });
  return (
    <div style={{ display: "flex", gap: 6, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
      <button style={btn(false)} onClick={() => onResolve(item, false)}>
        Deny
      </button>
      <button style={btn(true)} onClick={() => onResolve(item, true)}>
        Approve
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- session card

function formatDateTime(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function formatClock(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function formatShortTime(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function SessionBadges({ session }) {
  const badges = [];
  if (session.asked) badges.push({ key: "asked", text: `${session.asked} needs approval`, s: STATUS.warning });
  if (session.blocked) badges.push({ key: "blocked", text: `${session.blocked} blocked`, s: STATUS.critical });
  if (session.flagged) badges.push({ key: "flagged", text: `${session.flagged} flagged`, s: STATUS.flagged });
  if (session.approved) badges.push({ key: "approved", text: `${session.approved} approved`, s: STATUS.approved });
  if (!badges.length) badges.push({ key: "clean", text: "All allowed", s: STATUS.clean });
  return (
    <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
      {badges.map((b) => (
        <Pill key={b.key} status={b.s}>
          {b.text}
        </Pill>
      ))}
    </div>
  );
}

function Pill({ status, children }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11.5,
        fontWeight: 600,
        padding: "3px 8px",
        borderRadius: T.radiusSm,
        background: tint(status.color, 12),
        border: `1px solid ${tint(status.color, 28)}`,
        color: status.ink,
        whiteSpace: "nowrap",
        lineHeight: 1.3,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 1, background: status.color }} />
      {children}
    </span>
  );
}

function SessionCard({ session, expanded, onToggle, expandedEvents, onToggleEvent, pending, onResolve }) {
  const ordered = useMemo(() => [...session.events].sort((a, b) => (a.ts || 0) - (b.ts || 0)), [session.events]);
  const open = useMemo(() => unresolvedPending(session.events), [session.events]);
  const agent = sourceMeta(session.source).label;
  const needsYou = session.asked > 0;

  return (
    <div
      style={{
        borderRadius: T.radius,
        border: `1px solid ${needsYou ? tint(T.warning, 55) : T.border}`,
        boxShadow: needsYou ? `0 0 0 3px ${tint(T.warning, 12)}` : T.shadow,
        background: T.surface,
        overflow: "hidden",
      }}
    >
      <div className="ax-session-head" onClick={onToggle} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", cursor: "pointer" }}>
        <span
          style={{
            width: 24,
            height: 24,
            flexShrink: 0,
            borderRadius: T.radiusSm,
            border: `1px solid ${T.border}`,
            background: T.surfaceRaised,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <IconChevron expanded={expanded} size={12} color={T.inkSecondary} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontFamily: T.fontMono, fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{session.headline}</div>
          <div style={{ fontSize: 12, color: T.inkMuted, marginTop: 3, display: "flex", gap: 6, flexWrap: "wrap" }}>
            <span style={{ color: T.inkSecondary, fontWeight: 500 }}>{agent}</span>
            <Dot />
            <span>{formatDateTime(session.firstTs)}</span>
            <Dot />
            <span>{formatDuration(session.lastTs - session.firstTs)}</span>
            <Dot />
            <span>
              {session.total} event{session.total === 1 ? "" : "s"}
            </span>
          </div>
        </div>
        <SessionBadges session={session} />
      </div>

      {expanded && (
        <div style={{ display: "flex", borderTop: `1px solid ${T.border}`, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 520px", minWidth: 0, padding: "14px 16px 14px 8px" }}>
            {ordered.map((event, i) => {
              const pendingItem = open.has(event)
                ? pending.find((p) => p.tool === event.tool && p.target === event.target && (!p.session_id || p.session_id === event.session_id))
                : null;
              return (
                <TimelineRow
                  key={event._key}
                  event={event}
                  last={i === ordered.length - 1}
                  expanded={expandedEvents.has(event._key)}
                  onToggle={() => onToggleEvent(event._key)}
                  unresolved={open.has(event)}
                  pendingItem={pendingItem}
                  onResolve={onResolve}
                />
              );
            })}
          </div>
          <SessionSidebar session={session} />
        </div>
      )}
    </div>
  );
}

function Dot() {
  return <span style={{ opacity: 0.6 }}>·</span>;
}

// ---------------------------------------------------------------- timeline

function eventTitle(event) {
  if (event.type === "taint_update") return { title: "Classified data", Icon: IconShield };
  const meta = TOOL_META[event.tool];
  return { title: meta?.label || event.tool || event.type, Icon: meta?.Icon || IconFile };
}

function TimelineRow({ event, last, expanded, onToggle, unresolved, pendingItem, onResolve }) {
  const severity = eventSeverity(event);
  const status = STATUS[severity];
  const { title, Icon } = eventTitle(event);
  const tags = (event.type === "taint_update" ? event.new_tags : event.tags) || [];
  const visibleTags = tags.filter((t) => TAG_LABELS[t]);
  const reasons = event.type === "tool_call" && event.reasons && event.reasons.length ? event.reasons.map(humanReason).join(", ") : null;
  const isAsk = severity === "warning";

  let cardBg = "transparent";
  let cardBorder = "transparent";
  if (isAsk) {
    cardBg = tint(T.warning, unresolved ? 12 : 7);
    cardBorder = tint(T.warning, unresolved ? 50 : 30);
  } else if (severity === "critical" || severity === "denied") {
    cardBg = tint(T.critical, 6);
    cardBorder = tint(T.critical, 25);
  } else if (expanded) {
    cardBg = T.sunken;
    cardBorder = T.border;
  }

  return (
    <div style={{ display: "flex", alignItems: "stretch" }}>
      <div style={{ width: 66, flexShrink: 0, fontFamily: T.fontMono, fontSize: 11, color: T.inkMuted, paddingTop: 13, textAlign: "right", paddingRight: 10, fontVariantNumeric: "tabular-nums" }}>
        {formatClock(event.ts)}
      </div>
      <div style={{ width: 16, flexShrink: 0, position: "relative", display: "flex", justifyContent: "center" }}>
        <div style={{ position: "absolute", top: 0, bottom: last ? "calc(100% - 16px)" : 0, width: 1, background: T.borderStrong }} />
        <div
          style={{
            position: "relative",
            marginTop: 13,
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: status.color,
            boxShadow: `0 0 0 3px ${T.surface}`,
          }}
        />
      </div>
      <div style={{ flex: 1, minWidth: 0, paddingLeft: 10, paddingBottom: 6 }}>
        <div style={{ borderRadius: T.radius, background: cardBg, border: `1px solid ${cardBorder}`, padding: "9px 12px" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <span
              style={{
                width: 26,
                height: 26,
                flexShrink: 0,
                borderRadius: T.radiusSm,
                border: `1px solid ${T.border}`,
                background: T.surface,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon size={13} color={T.inkSecondary} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
                {visibleTags.map((t) => (
                  <TagChip key={t} tag={t} />
                ))}
              </div>
              <div style={{ fontFamily: T.fontMono, fontSize: 12.5, color: T.inkSecondary, marginTop: 3, wordBreak: "break-all" }}>{event.target}</div>
              {reasons && (
                <div style={{ fontSize: 12, color: T.inkMuted, marginTop: 3 }}>
                  Reason — <span style={{ color: T.inkSecondary }}>{reasons}</span>
                </div>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
                <button
                  className="ax-link-btn"
                  onClick={onToggle}
                  style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: T.font, fontSize: 12, fontWeight: 600, color: T.accent }}
                >
                  {expanded ? "Hide details" : "Show details"}
                  <span style={{ display: "inline-flex", transform: expanded ? "rotate(-90deg)" : "rotate(90deg)" }}>
                    <IconChevron size={10} color={T.accent} />
                  </span>
                </button>
                {pendingItem && <ApproveDeny item={pendingItem} onResolve={onResolve} />}
              </div>
            </div>
            <Pill status={status}>{status.label}</Pill>
          </div>
          {expanded && <EventDetails event={event} />}
        </div>
      </div>
    </div>
  );
}

function TagChip({ tag }) {
  const sensitive = tag === "secret" || tag === "pii";
  const color = sensitive ? T.critical : T.inkMuted;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11,
        fontWeight: 600,
        padding: "1px 6px",
        borderRadius: T.radiusSm,
        background: tint(color, 10),
        border: `1px solid ${tint(color, 25)}`,
        color: sensitive ? T.criticalInk : T.inkSecondary,
      }}
    >
      {sensitive && <IconLock size={10} color={sensitive ? T.criticalInk : T.inkSecondary} />}
      {TAG_LABELS[tag]}
    </span>
  );
}

function EventDetails({ event }) {
  const rows = [
    ["Session", event.session_id],
    ["Source", event.source],
    ["Timestamp", event.ts ? new Date(event.ts * 1000).toISOString() : ""],
    ["Risk score", event.risk_score],
  ].filter(([, v]) => v !== undefined && v !== null && v !== "");
  return (
    <div style={{ display: "flex", gap: 14, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.border}`, flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 200px", minWidth: 0, display: "grid", gridTemplateColumns: "76px 1fr", rowGap: 6, columnGap: 8, alignContent: "start", fontSize: 12 }}>
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <span style={{ color: T.inkMuted }}>{k}</span>
            <span style={{ fontFamily: T.fontMono, fontSize: 11.5, color: T.inkSecondary, wordBreak: "break-all" }}>{String(v)}</span>
          </React.Fragment>
        ))}
      </div>
      <pre
        style={{
          flex: "2 1 320px",
          minWidth: 0,
          margin: 0,
          padding: "10px 12px",
          background: T.code,
          border: `1px solid ${T.border}`,
          borderRadius: T.radius,
          overflowX: "auto",
          fontFamily: T.fontMono,
          fontSize: 11.5,
          lineHeight: 1.55,
          color: T.inkSecondary,
        }}
      >
        {JSON.stringify(stripInternal(event), null, 2)}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------- sidebar

function SessionSidebar({ session }) {
  const { nodes } = useMemo(() => buildTrail(session), [session]);
  const steps = nodes.filter((n) => !n.isStart);

  const stats = useMemo(() => {
    const calls = session.events.filter((e) => e.type === "tool_call");
    const files = new Set(calls.filter((e) => e.tool === "read_file" || e.tool === "write_file").map((e) => e.target));
    const sensitive = new Set(session.events.filter((e) => e.type === "taint_update" && (e.new_tags || []).some((t) => TAG_LABELS[t])).map((e) => e.target));
    const decisions = session.events.filter(
      (e) => e.type === "confirm_resolution" || e.decision === "block" || e.decision === "pending_confirm" || (e.decision === "allow" && (e.risk_score || 0) > 0)
    ).length;
    return [
      { label: "Commands", value: calls.filter((e) => e.tool === "run_shell").length },
      { label: "Files touched", value: files.size },
      { label: "Sensitive files", value: sensitive.size, alert: sensitive.size > 0 },
      { label: "Policy decisions", value: decisions },
    ];
  }, [session.events]);

  return (
    <div style={{ flex: "0 0 300px", minWidth: 0, borderLeft: `1px solid ${T.border}`, background: T.sunken, padding: 16, boxSizing: "border-box" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {stats.map((s) => (
          <div key={s.label} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: "10px 12px" }}>
            <div style={{ fontFamily: T.fontMono, fontSize: 20, fontWeight: 600, color: s.alert ? T.criticalInk : T.ink }}>{s.value}</div>
            <div style={{ fontSize: 11.5, color: T.inkMuted, marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 11, fontWeight: 600, color: T.inkMuted, letterSpacing: 0.6, textTransform: "uppercase", margin: "18px 0 10px" }}>Path</div>
      {steps.length === 0 && <div style={{ fontSize: 12, color: T.inkMuted }}>No tool calls yet.</div>}
      <div>
        {steps.map((n, i) => {
          const resolution = resolutionFor(n.event, session.events);
          const sev = resolution ? eventSeverity(resolution) : n.severity;
          const st = STATUS[sev];
          const notes = [TOOL_META[n.event.tool]?.label || n.event.tool];
          if (n.introducedTags.some((t) => TAG_LABELS[t])) notes.push(`classified ${n.introducedTags.filter((t) => TAG_LABELS[t]).map((t) => TAG_LABELS[t].toLowerCase()).join(", ")}`);
          if (sev !== "clean") notes.push(st.label.toLowerCase());
          return (
            <div key={n.id} style={{ display: "flex", gap: 10 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
                <span
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: T.radiusSm,
                    background: st.color,
                    color: "#fff",
                    fontSize: 10,
                    fontWeight: 700,
                    fontFamily: T.fontMono,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {n.step}
                </span>
                {i < steps.length - 1 && <span style={{ flex: 1, width: 1, background: T.borderStrong, minHeight: 10 }} />}
              </div>
              <div style={{ minWidth: 0, paddingBottom: 10 }}>
                <div style={{ fontFamily: T.fontMono, fontSize: 12, color: T.ink, wordBreak: "break-all", lineHeight: 1.4 }}>{n.label}</div>
                <div style={{ fontSize: 11.5, color: T.inkMuted, marginTop: 1 }}>{notes.join(" · ")}</div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 8, paddingTop: 14, display: "grid", gridTemplateColumns: "58px 1fr", rowGap: 6, fontSize: 12 }}>
        <span style={{ color: T.inkMuted }}>Session</span>
        <span style={{ fontFamily: T.fontMono, fontSize: 11, color: T.inkSecondary, wordBreak: "break-all" }}>{session.sessionId}</span>
        <span style={{ color: T.inkMuted }}>Agent</span>
        <span style={{ color: T.inkSecondary }}>{sourceMeta(session.source).label}</span>
        <span style={{ color: T.inkMuted }}>Window</span>
        <span style={{ color: T.inkSecondary }}>
          {formatShortTime(session.firstTs)} – {formatShortTime(session.lastTs)}
        </span>
      </div>
    </div>
  );
}

function stripInternal(event) {
  const { _key, ...rest } = event;
  return rest;
}
