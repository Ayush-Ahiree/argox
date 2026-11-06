/**
 * Shared session-grouping logic used by both EventFeed.jsx (incident
 * cards) and Argox.jsx (path graph), so "what counts as a session,
 * what's its headline, what's its source" stays identical across tabs
 * instead of two components quietly disagreeing with each other.
 */

export function sessionSource(events) {
  const withSource = events.find((e) => e.source);
  return withSource ? withSource.source : "toy_agent";
}

export function deriveHeadline(events) {
  const first = [...events].sort((a, b) => (a.ts || 0) - (b.ts || 0)).find((e) => e.type === "tool_call");
  if (!first || !first.target) return "session";
  if (first.tool === "call_api") {
    try {
      return new URL(first.target).hostname;
    } catch {
      return first.target;
    }
  }
  // commands aren't paths -- "git log -- app.py" shouldn't collapse to "app.py"
  if (first.tool === "run_shell") return first.target.trim().replace(/\s+/g, " ");
  const parts = first.target.split("/");
  return parts[parts.length - 1] || first.target;
}

export function formatDuration(seconds) {
  if (!seconds || seconds < 1) return "<1s";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// A pending_confirm tool_call is later followed by a confirm_resolution
// for the same tool+target once a human answers. Returns the set of
// pending tool_call events that have NOT been answered yet.
export function unresolvedPending(evts) {
  const resolutions = evts.filter((e) => e.type === "confirm_resolution").sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const used = new Set();
  const open = new Set();
  const pendings = evts.filter((e) => e.type === "tool_call" && e.decision === "pending_confirm").sort((a, b) => (a.ts || 0) - (b.ts || 0));
  for (const p of pendings) {
    const r = resolutions.find((r) => !used.has(r) && r.tool === p.tool && r.target === p.target && (r.ts || 0) >= (p.ts || 0));
    if (r) used.add(r);
    else open.add(p);
  }
  return open;
}

// The confirm_resolution that answered a given pending tool_call, if any.
export function resolutionFor(event, evts) {
  if (event.decision !== "pending_confirm") return null;
  return (
    evts
      .filter((e) => e.type === "confirm_resolution" && e.tool === event.tool && e.target === event.target && (e.ts || 0) >= (event.ts || 0))
      .sort((a, b) => (a.ts || 0) - (b.ts || 0))[0] || null
  );
}

export function timeAgo(ts) {
  if (!ts) return "";
  const diff = Date.now() / 1000 - ts;
  if (diff < 5) return "just now";
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

export function groupBySession(events) {
  const bySession = new Map();
  for (const e of events) {
    const sid = e.session_id || "unknown";
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push(e);
  }
  // policy reasons that mean "sensitive data tried to leave" vs "acted after
  // reading outside content" (agent/policy.py)
  const LEAK_REASONS = ["secret_data_exfil_attempt", "secret_session_publish", "pii_crossing_trust_boundary", "internal_data_crossing_trust_boundary"];
  const hasReason = (e, list) => e.type === "tool_call" && (e.reasons || []).some((r) => list.includes(r));
  const sessions = Array.from(bySession.entries()).map(([sessionId, evts]) => {
    // blocked includes human denials (confirm_resolution with decision "block")
    const blocked = evts.filter((e) => e.decision === "block").length;
    const asked = unresolvedPending(evts).size;
    const approved = evts.filter((e) => e.type === "confirm_resolution" && e.decision === "allow").length;
    const flagged = evts.filter((e) => e.decision === "allow" && (e.risk_score || 0) > 0).length;
    let severity = "clean";
    if (blocked > 0) severity = "critical";
    else if (asked > 0) severity = "warning";
    else if (flagged > 0) severity = "flagged";
    const times = evts.map((e) => e.ts || 0).filter(Boolean);
    return {
      sessionId,
      events: evts,
      blocked,
      asked,
      approved,
      flagged,
      // tool calls where sensitive data tried to leave the trust boundary
      leaks: evts.filter((e) => hasReason(e, LEAK_REASONS)).length,
      // outbound calls made after reading outside content (prompt-injection pattern)
      injection: evts.filter((e) => hasReason(e, ["untrusted_content_then_egress"])).length,
      severity,
      source: sessionSource(evts),
      headline: deriveHeadline(evts),
      total: evts.length,
      toolCalls: evts.filter((e) => e.type === "tool_call").length,
      firstTs: times.length ? Math.min(...times) : 0,
      lastTs: times.length ? Math.max(...times) : 0,
    };
  });
  sessions.sort((a, b) => b.lastTs - a.lastTs);
  return sessions;
}

// Stable per-event identity (not Math.random()): needed so a page refresh
// (restored from localStorage) and the relay's replay-on-connect buffer
// don't produce two copies of the same event when both land at once.
export function eventIdentity(event) {
  return `${event.ts}|${event.type}|${event.tool}|${event.target}`;
}
