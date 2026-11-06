import { eventSeverity, sourceMeta } from "./theme.jsx";

/**
 * Turns a session's tool_call events into an ordered chain (step 1 -> 2
 * -> 3...) plus a serpentine ("S"/boustrophedon) position for each node:
 * left-to-right, then wrap to the next row right-to-left, and so on --
 * so a long-running session (a real task can rack up dozens of steps)
 * stays inside the available width instead of running a straight line
 * off the edge of the view. Shared by the main Graph tab and the
 * mini path embedded in an expanded Feed session card.
 */

export function buildTrail(session) {
  const toolCalls = session
    ? [...session.events].filter((e) => e.type === "tool_call").sort((a, b) => (a.ts || 0) - (b.ts || 0))
    : [];

  // A tool_call's own `tags` are the session's CUMULATIVE taint at that
  // moment, not what that step touched -- so once anything sensitive is
  // read, every later step carries the tags. What a step itself brought in
  // comes from the taint_update event the backend sends after a read; pair
  // each one with the latest matching call (same tool + target) before it.
  const introduced = new Map();
  if (session) {
    const updates = session.events.filter((e) => e.type === "taint_update" && (e.new_tags || []).length);
    for (const u of updates) {
      let match = null;
      for (const c of toolCalls) {
        if (c.tool === u.tool && c.target === u.target && (c.ts || 0) <= (u.ts || 0)) match = c;
      }
      if (match) introduced.set(match, [...new Set([...(introduced.get(match) || []), ...u.new_tags])]);
    }
  }

  const nodes = [{ id: "start", label: session ? sourceLabel(session.source) : "Start", isStart: true }];
  const links = [];
  toolCalls.forEach((event, i) => {
    const nodeId = `step-${i}`;
    nodes.push({
      id: nodeId,
      label: shortLabel(event),
      event,
      severity: eventSeverity(event),
      step: i + 1,
      introducedTags: introduced.get(event) || [],
    });
    links.push({ source: i === 0 ? "start" : `step-${i - 1}`, target: nodeId });
  });
  return { nodes, links };
}

function sourceLabel(source) {
  return sourceMeta(source).label;
}

function shortLabel(event) {
  const target = event.target || "";
  if (event.tool === "call_api") {
    try {
      return new URL(target).hostname;
    } catch {
      return target.slice(0, 24);
    }
  }
  if (event.tool === "run_shell" || event.tool === "websearch" || String(event.tool || "").startsWith("mcp__")) {
    // commands / search queries aren't paths: keep the start (the verb), not the text after the last "/"
    const cmd = target.trim().replace(/\s+/g, " ");
    return cmd.length > 30 ? `${cmd.slice(0, 29)}…` : cmd;
  }
  const parts = target.split("/");
  return (parts[parts.length - 1] || target).slice(0, 24);
}

/**
 * Mutates nodes with fx/fy (fixed positions) laid out in a serpentine
 * grid sized to `width`. Row 0 goes left->right, row 1 right->left, etc.
 * colSpacing/rowSpacing control density; both views can tune these for
 * their own scale (the small embedded mini-path wants a tighter grid
 * than the full-size Graph tab).
 */
export function layoutSerpentine(nodes, width, { colSpacing = 90, rowSpacing = 80 } = {}) {
  const cols = Math.max(2, Math.floor(width / colSpacing) || 2);

  nodes.forEach((node, i) => {
    if (node.isStart) {
      node.fx = 0;
      node.fy = 0;
      return;
    }
    const stepIndex = i - 1;
    const row = Math.floor(stepIndex / cols);
    const colInRow = stepIndex % cols;
    const col = row % 2 === 0 ? colInRow : cols - 1 - colInRow;
    node.fx = col * colSpacing;
    node.fy = (row + 1) * rowSpacing;
  });
  return nodes;
}
