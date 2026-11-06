/**
 * Security reading of a trail (see pathLayout.buildTrail): which steps
 * brought sensitive data into the session, what the session was holding
 * at every step, and which later decisions that data caused.
 *
 * This mirrors how agent/policy.py decides: a network call is blocked or
 * confirmed because of the session's *inherited* taint, which a step
 * introduced earlier (taint_update.new_tags -> node.introducedTags). The
 * Graph draws those cause -> effect links; the step panel explains them.
 */

export const SENSITIVE_TAGS = ["secret", "pii", "internal_only"];

export const TAG_INFO = {
  secret: { label: "Secret", color: "#d93b3b" },
  pii: { label: "Personal info", color: "#8b5cf6" },
  internal_only: { label: "Internal only", color: "#f0a818" },
};

// policy.py reason -> the taint tag that triggered it
const REASON_TAG = {
  secret_data_exfil_attempt: "secret",
  pii_crossing_trust_boundary: "pii",
  internal_data_crossing_trust_boundary: "internal_only",
};

export function analyzeTrail(trail) {
  const steps = trail.nodes.filter((n) => n.event);
  const byId = new Map();
  const holding = new Map(); // node id -> tags the session held when this step ran
  const introducers = { secret: [], pii: [], internal_only: [] };
  let held = [];

  for (const n of steps) {
    // what the session carried going INTO this step (the policy checks this)
    const inherited = (n.event.tags || []).filter((t) => SENSITIVE_TAGS.includes(t));
    const before = [...new Set([...held, ...inherited])];
    const brought = (n.introducedTags || []).filter((t) => SENSITIVE_TAGS.includes(t));
    held = [...new Set([...before, ...brought])];
    holding.set(n.id, { before, after: held, brought });
    brought.forEach((t) => introducers[t].push(n));
    byId.set(n.id, n);
  }

  // cause -> effect: a decision driven by tag T points back at every step
  // that brought T in before it
  const flows = [];
  const causes = new Map(); // effect id -> [{ tag, sources }]
  const effects = new Map(); // source id -> [effect nodes]
  for (const n of steps) {
    const tags = [...new Set((n.event.reasons || []).map((r) => REASON_TAG[r]).filter(Boolean))];
    if (!tags.length) continue;
    const list = tags.map((tag) => {
      const sources = introducers[tag].filter((s) => s.step < n.step);
      sources.forEach((s) => {
        flows.push({ id: `${s.id}->${n.id}:${tag}`, from: s, to: n, tag });
        effects.set(s.id, [...(effects.get(s.id) || []), n]);
      });
      return { tag, sources };
    });
    causes.set(n.id, list);
  }

  const incidents = steps.filter((n) => n.severity !== "clean");
  return { holding, flows, causes, effects, incidents, byId };
}

/** Plain-English "why" + "what to do" for one step. */
export function explainStep(node, analysis) {
  const e = node.event;
  const reasons = e.reasons || [];
  const causes = analysis.causes.get(node.id) || [];
  const dest = destination(e);
  const out = { verdict: null, why: [], fixes: [], causes, brought: analysis.holding.get(node.id)?.brought || [], ledTo: [...new Set(analysis.effects.get(node.id) || [])] };

  const blocked = e.decision === "block";
  const asked = e.decision === "pending_confirm";
  out.verdict = blocked ? "Blocked before it ran" : asked ? "Paused for your approval" : node.severity === "flagged" ? "Allowed, flagged for review" : null;

  for (const r of reasons) {
    const tag = REASON_TAG[r];
    if (tag) {
      const label = TAG_INFO[tag].label.toLowerCase();
      out.why.push(`The session was holding ${label} data, and this call sends data to ${dest || "a destination"} outside your trust boundary.`);
      if (!causes.find((c) => c.tag === tag)?.sources.length) {
        out.why.push(`The ${label} data was picked up before this session's first recorded step (earlier context, or a different session ID).`);
      }
      out.fixes.push({
        text: `If ${dest || "this destination"} is legitimate, it has to be a trusted destination. Trusted destinations are set in the backend today (agent/policy.py, ALLOWLISTED_DOMAINS), not yet from the dashboard.`,
      });
      out.fixes.push({ text: "If the agent should never have read that file, add its path to Protected paths so the read is blocked next time.", policy: true });
    } else if (r === "external_destination_untainted") {
      out.why.push(`${dest || "This destination"} is new and outside your trust boundary. Nothing sensitive was being held, so it was allowed and flagged so you can review it.`);
      out.fixes.push({ text: "No action needed if you expected this call." });
    } else if (r === "dangerous_shell_pattern") {
      out.why.push("The command matches a known dangerous pattern (e.g. recursive delete, piping a download into a shell).");
      out.fixes.push({ text: "If this was intended, run it yourself rather than through the agent, or turn off the dangerous-command rule in Policy.", policy: true });
    } else if (r.startsWith("path_denylist:")) {
      const pattern = r.split(":").pop();
      out.why.push(`This touches a protected path (matches ${pattern}).`);
      out.fixes.push({ text: `If the agent legitimately needs it, remove or narrow the "${pattern}" pattern in Policy.`, policy: true });
    }
  }
  if (!out.why.length && node.severity !== "clean") out.why.push(reasons.length ? reasons.join(", ") : "Flagged by policy.");
  return out;
}

function destination(e) {
  const t = e.target || "";
  if (e.tool === "call_api") {
    try {
      return new URL(t).hostname;
    } catch {
      return t;
    }
  }
  const m = t.match(/[a-z][a-z0-9+.-]*:\/\/([^/\s:'"]+)/i) || t.match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  return m ? m[1] : null;
}
