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
// what the "held" band tracks: sensitive data, plus outside content that
// may carry injected instructions (policy.py Tag.UNTRUSTED)
export const HELD_TAGS = [...SENSITIVE_TAGS, "untrusted"];

export const TAG_INFO = {
  secret: { label: "Secret", short: "Secret", color: "#d93b3b" },
  pii: { label: "Personal info", short: "PII", color: "#8b5cf6" },
  internal_only: { label: "Internal only", short: "Internal", color: "#f0a818" },
  untrusted: { label: "Untrusted input", short: "Untrusted", color: "#0ea5e9" },
};

// policy.py reason -> the taint tag that triggered it
const REASON_TAG = {
  secret_data_exfil_attempt: "secret",
  secret_session_publish: "secret",
  pii_crossing_trust_boundary: "pii",
  internal_data_crossing_trust_boundary: "internal_only",
  untrusted_content_then_egress: "untrusted",
};

export function analyzeTrail(trail) {
  const steps = trail.nodes.filter((n) => n.event);
  const byId = new Map();
  const holding = new Map(); // node id -> tags the session held when this step ran
  const introducers = Object.fromEntries(HELD_TAGS.map((t) => [t, []]));
  let held = [];

  for (const n of steps) {
    // what the session carried going INTO this step (the policy checks this)
    const inherited = (n.event.tags || []).filter((t) => HELD_TAGS.includes(t));
    const before = [...new Set([...held, ...inherited])];
    const brought = (n.introducedTags || []).filter((t) => HELD_TAGS.includes(t));
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

  const inheritedFrom = e.inherited_from;
  for (const r of reasons) {
    const tag = REASON_TAG[r];
    if (tag === "untrusted") {
      const src = causes.find((c) => c.tag === "untrusted")?.sources || [];
      out.why.push(
        `Earlier in this session the agent read content from outside${src.length ? ` (step ${src.map((s) => s.step).join(", ")})` : ""}. Web pages, API responses and tool results can hide instructions aimed at the agent (prompt injection), and this call then sends data to ${dest || "an outside destination"}.`
      );
      out.why.push("Nothing sensitive was being held, so it was allowed and flagged for you to review.");
      out.fixes.push({ text: "If you expected this call, no action needed — mark it as correct below." });
      out.fixes.push({ text: "If you didn't, open the earlier step's content and look for text telling the agent what to do; stop the session if you find it." });
    } else if (tag) {
      const label = TAG_INFO[tag].label.toLowerCase();
      out.why.push(
        r === "secret_session_publish"
          ? "The session was holding secret data, and this publishes to your remote (git push, a PR). That's normal work, so it asks rather than blocks."
          : `The session was holding ${label} data, and this call sends data to ${dest || "a destination"} outside your trust boundary.`
      );
      if (!causes.find((c) => c.tag === tag)?.sources.length) {
        out.why.push(
          inheritedFrom
            ? `The ${label} data was carried over from an earlier session in the same folder (${String(inheritedFrom).slice(0, 8)}…), started within the last 30 minutes — e.g. before a /clear or restart.`
            : `The ${label} data was picked up before this session's first recorded step.`
        );
      }
      if (dest && r !== "secret_session_publish") {
        out.fixes.push({
          text: `Only if you own ${dest} (your own API, not a paste site or webhook catcher): add it as a trusted destination.`,
          action: { label: `Trust ${dest}…`, prefill: { trustDomain: dest } },
        });
      }
      const src = causes.find((c) => c.tag === tag)?.sources[0];
      const file = src && (src.event.tool === "read_file" || src.event.tool === "write_file") ? String(src.event.target || "").split("/").pop() : null;
      out.fixes.push({
        text: file ? `If the agent should never read ${file}, protect it so the read is blocked next time.` : "If the agent should never have read that data, protect its path so the read is blocked next time.",
        action: { label: "Protect path…", prefill: file ? { protectPath: file } : {} },
      });
    } else if (r === "cloud_metadata_access") {
      out.why.push("This call reaches the cloud metadata service (169.254.169.254 or similar). It hands out the machine's cloud credentials to anything that asks, so it's blocked whatever the session holds.");
      out.fixes.push({ text: "An agent almost never needs this. If you do (e.g. debugging instance setup), run the command yourself, or turn off the cloud-metadata rule in Policy.", action: { label: "Open Policy" } });
    } else if (r === "secret_literal_in_outbound_call") {
      out.why.push(`The command itself contains something that looks like a secret (an API key, token or password), and it sends data to ${dest || "a destination outside your trust boundary"}.`);
      out.fixes.push({ text: `Approve if this is your own key going to its own service (e.g. an OpenAI key to api.openai.com). Deny if ${dest || "the destination"} isn't where that key belongs.` });
      out.fixes.push({ text: "Better: have the agent read keys from an environment variable ($API_KEY) instead of pasting them into commands." });
    } else if (r === "external_destination_untainted") {
      out.why.push(`${dest || "This destination"} is new and outside your trust boundary. Nothing sensitive was being held, so it was allowed and flagged so you can review it.`);
      out.fixes.push({ text: "No action needed if you expected this call." });
    } else if (r === "dangerous_shell_pattern") {
      out.why.push("The command matches a known dangerous pattern (e.g. recursive delete, piping a download into a shell).");
      out.fixes.push({ text: "If this was intended, run it yourself rather than through the agent, or turn off the dangerous-command rule in Policy.", action: { label: "Open Policy" } });
    } else if (r.startsWith("path_denylist:")) {
      const pattern = r.split(":").pop();
      out.why.push(`This touches a protected path (matches ${pattern}).`);
      out.fixes.push({ text: `If the agent legitimately needs it, remove or narrow the "${pattern}" pattern in Policy.`, action: { label: "Open Policy" } });
    }
  }
  if (!out.why.length && node.severity !== "clean") out.why.push(reasons.length ? reasons.join(", ") : "Flagged by policy.");
  if (inheritedFrom && !reasons.some((r) => REASON_TAG[r]) && node.step === 1) {
    out.why.push(`This session started holding ${(e.inherited_tags || []).map((t) => TAG_INFO[t]?.label.toLowerCase() || t).join(", ")} data carried over from an earlier session in the same folder.`);
  }
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
