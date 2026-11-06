import React, { useEffect, useState, useCallback, useRef } from "react";
import { T, tint, IconAlert } from "./theme.jsx";
import { authHeaders, policiesUrl } from "./lib/api.js";

// A few ready-to-use patterns so "what do I type here" has a concrete
// answer instead of just a placeholder -- click one to add it directly.
const EXAMPLE_PATTERNS = [
  { pattern: "*.pem", hint: "any private key file, anywhere" },
  { pattern: "*.key", hint: "any .key file, anywhere" },
  { pattern: "config/production/**", hint: "everything inside that folder, any depth" },
  { pattern: "id_rsa*", hint: "SSH private keys" },
];

/**
 * Lets you add/remove path-denylist patterns (admin/**, .env*, secrets/**
 * and anything else you add) without touching code. Backed by
 * hook_server.py's GET/POST /policies, which reads/writes policy.py's
 * policies.json -- both front-ends (toy agent + Claude Code hook) read
 * the same file, so an edit here applies to both immediately, no restart.
 */
// prefill: { trustDomain?, protectPath? } -- set when the Graph's "how to
// fix" sends you here, so the value is typed in and waiting for review
// (never saved automatically: trusting a host lets secrets go to it).
export default function PolicyEditor({ project = null, session = null, prefill = null }) {
  const [patterns, setPatterns] = useState(null);
  const [trusted, setTrusted] = useState(null);
  const [newDomain, setNewDomain] = useState(prefill?.trustDomain || "");
  const trustedRef = useRef(null);
  const patternsRef = useRef(null);
  const [toggles, setToggles] = useState(null);
  const [toggleLabels, setToggleLabels] = useState({});
  const [newPattern, setNewPattern] = useState(prefill?.protectPath || "");
  const [status, setStatus] = useState("loading"); // loading | ready | error | saving
  const [error, setError] = useState(null);
  // Transient inline feedback after an add/remove/duplicate, distinct from
  // `status` -- {kind: "success" | "info", text} -- auto-clears itself.
  const [feedback, setFeedback] = useState(null);
  const feedbackTimer = useRef(null);

  const flash = useCallback((kind, text) => {
    setFeedback({ kind, text });
    clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedback(null), 2500);
  }, []);

  const load = useCallback(() => {
    setStatus("loading");
    fetch(policiesUrl(project), { headers: authHeaders(session) })
      .then((r) => r.json())
      .then((data) => {
        setPatterns(data.deny_path_patterns || []);
        setToggles(data.rule_toggles || {});
        setToggleLabels(data.rule_toggle_labels || {});
        setTrusted(data.trusted_domains || []);
        setStatus("ready");
      })
      .catch((e) => {
        setError(String(e));
        setStatus("error");
      });
  }, [project, session]);

  useEffect(() => {
    load();
  }, [load]);

  // arriving from the Graph with a prefill: bring that section into view
  useEffect(() => {
    if (!prefill) return;
    if (prefill.trustDomain) setNewDomain(prefill.trustDomain);
    if (prefill.protectPath) setNewPattern(prefill.protectPath);
    const el = (prefill.trustDomain ? trustedRef : patternsRef).current;
    if (el && status === "ready") el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [prefill, status]);

  const save = useCallback(
    (body, applyLocal) => {
      setStatus("saving");
      fetch(policiesUrl(project), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(session) },
        body: JSON.stringify(body),
      })
        .then(async (r) => {
          const data = await r.json().catch(() => ({}));
          if (!r.ok) {
            // e.g. 503 "run migration 002 first": say what's wrong, keep the page usable
            setStatus("ready");
            flash("error", data.detail || data.error || `Save failed (${r.status})`);
            load();
            return;
          }
          applyLocal(data);
          setStatus("ready");
        })
        .catch((e) => {
          setError(String(e));
          setStatus("error");
        });
    },
    [project, session, flash, load]
  );

  const addPattern = (raw) => {
    const p = (raw ?? newPattern).trim();
    if (!p || !patterns) return;
    if (patterns.includes(p)) {
      setNewPattern("");
      flash("info", `"${p}" is already in the list — nothing changed.`);
      return;
    }
    setNewPattern("");
    const next = [...patterns, p];
    save({ deny_path_patterns: next }, (data) => {
      setPatterns(data.deny_path_patterns || next);
      flash("success", `Blocking "${p}" now — applies to every agent immediately.`);
    });
  };

  const removePattern = (p) => {
    if (!patterns) return;
    const next = patterns.filter((x) => x !== p);
    save({ deny_path_patterns: next }, (data) => {
      setPatterns(data.deny_path_patterns || next);
      flash("info", `Removed "${p}" — no longer blocked.`);
    });
  };

  const addDomain = () => {
    const d = newDomain.trim();
    if (!d || !trusted) return;
    const next = [...trusted, d];
    save({ trusted_domains: next }, (data) => {
      const saved = data.trusted_domains || [];
      setTrusted(saved);
      if (saved.length === trusted.length) flash("info", `"${d}" isn't a valid host (or is already trusted) — nothing changed.`);
      else {
        setNewDomain("");
        flash("success", `Trusting ${saved[saved.length - 1]} — sensitive data may now be sent there.`);
      }
    });
  };

  const removeDomain = (d) => {
    if (!trusted) return;
    const next = trusted.filter((x) => x !== d);
    save({ trusted_domains: next }, (data) => {
      setTrusted(data.trusted_domains || next);
      flash("info", `${d} is no longer trusted.`);
    });
  };

  const toggleRule = (key) => {
    if (!toggles) return;
    const next = { ...toggles, [key]: !toggles[key] };
    setToggles(next); // optimistic -- a toggle flip should feel instant
    save({ rule_toggles: next }, (data) => setToggles(data.rule_toggles || next));
  };

  return (
    <div style={{ height: "100%", width: "100%", background: T.page, color: T.ink, overflow: "auto", fontFamily: T.font }}>
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "32px 20px" }}>
        <div style={{ fontSize: 20, fontWeight: 500, fontFamily: T.fontSerif, marginBottom: 6 }}>Policy</div>
        <div style={{ fontSize: 13, color: T.inkSecondary, marginBottom: 24, lineHeight: 1.5 }}>
          Applies to <strong>every</strong> agent — Claude Code and the toy agent read the same rules live,
          no restart needed.
        </div>

        {status === "error" && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 12px", marginBottom: 16, background: `${T.critical}12`, border: `1px solid ${T.critical}40`, borderRadius: 6, fontSize: 13 }}>
            <IconAlert size={14} color={T.critical} />
            Couldn't reach the policy server ({policiesUrl(project)}). Is the backend running?
          </div>
        )}

        {/* These are two independent mechanisms, not one list -- calling
            that out up front is the difference between "I get what I'm
            editing" and guessing. */}
        <div
          style={{
            display: "flex",
            gap: 10,
            padding: "12px 14px",
            marginBottom: 24,
            background: T.surfaceRaised,
            border: `1px solid ${T.border}`,
            borderRadius: 6,
            fontSize: 13,
            lineHeight: 1.5,
            color: T.inkSecondary,
          }}
        >
          <span>Two independent layers below:</span>
          <span style={{ color: T.ink }}>
            <strong>rules</strong> turn a whole category of check on/off; the <strong>path denylist</strong> hard-blocks
            specific files by name, no matter what the rules say.
          </span>
        </div>

        <div style={cardStyle}>
          <SectionHeading>1 · Detection rules</SectionHeading>
          <div style={{ fontSize: 13, color: T.inkSecondary, marginBottom: 14, lineHeight: 1.5 }}>
            Independently on/off — turning one off stops that check from blocking or pausing a call, without
            touching the path denylist below.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {status === "loading" && !toggles && <div style={{ fontSize: 13, color: T.inkMuted }}>Loading…</div>}
            {toggles &&
              Object.keys(toggleLabels).map((key) => (
                <RuleToggleRow key={key} label={toggleLabels[key]} on={!!toggles[key]} onToggle={() => toggleRule(key)} disabled={status === "saving"} />
              ))}
          </div>
        </div>

        <div style={cardStyle} ref={patternsRef}>
          <SectionHeading>2 · Path denylist</SectionHeading>
          <div style={{ fontSize: 13, color: T.inkSecondary, marginBottom: 14, lineHeight: 1.5 }}>
            Any file whose path matches a pattern below is blocked outright — always, regardless of the rules
            above. A bare glob (no <code>/</code>) matches by <strong>filename</strong>, anywhere on disk (e.g.{" "}
            <code>*.pem</code> blocks every <code>.pem</code> file). <code>dir/**</code> matches{" "}
            <strong>everything inside that folder</strong>, at any depth (e.g. <code>secrets/**</code> blocks{" "}
            <code>secrets/keys/a.txt</code> too).
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
            {EXAMPLE_PATTERNS.map(({ pattern, hint }) => (
              <button
                key={pattern}
                title={`Add "${pattern}" — ${hint}`}
                onClick={() => addPattern(pattern)}
                disabled={status === "saving" || (patterns && patterns.includes(pattern))}
                style={{
                  padding: "5px 10px",
                  borderRadius: 4,
                  border: `1px solid ${T.borderStrong}`,
                  background: "transparent",
                  color: T.inkSecondary,
                  fontSize: 12,
                  fontFamily: T.fontMono,
                  cursor: "pointer",
                  opacity: patterns && patterns.includes(pattern) ? 0.4 : 1,
                }}
              >
                + {pattern}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input
              value={newPattern}
              onChange={(e) => setNewPattern(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addPattern()}
              placeholder="e.g. *.pem, config/production/**"
              style={{
                flex: 1,
                padding: "9px 12px",
                borderRadius: 6,
                border: `1px solid ${T.borderStrong}`,
                background: T.surface,
                color: T.ink,
                fontSize: 13,
                fontFamily: T.fontMono,
                outline: "none",
              }}
            />
            <button
              onClick={() => addPattern()}
              disabled={!newPattern.trim() || status === "saving"}
              style={{
                padding: "9px 18px",
                borderRadius: 6,
                border: "none",
                background: T.accent,
                color: T.onAccent,
                fontSize: 13,
                fontWeight: 600,
                cursor: newPattern.trim() ? "pointer" : "default",
                opacity: newPattern.trim() ? 1 : 0.5,
              }}
            >
              Add
            </button>
          </div>

          {feedback && (
            <div
              style={{
                fontSize: 12.5,
                padding: "7px 10px",
                marginBottom: 12,
                borderRadius: 6,
                background: feedback.kind === "success" ? tint(T.accent, 8) : feedback.kind === "error" ? tint(T.critical, 10) : tint(T.inkMuted, 8),
                color: feedback.kind === "success" ? T.accent : feedback.kind === "error" ? T.criticalInk : T.inkSecondary,
              }}
            >
              {feedback.text}
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {status === "loading" && <div style={{ fontSize: 13, color: T.inkMuted }}>Loading…</div>}
            {patterns && patterns.length === 0 && (
              <div style={{ fontSize: 13, color: T.inkMuted, fontStyle: "italic" }}>
                No patterns configured — nothing is blocked by path right now.
              </div>
            )}
            {patterns &&
              patterns.map((p) => (
                <div
                  key={p}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "10px 14px",
                    borderRadius: 6,
                    background: T.surface,
                    border: `1px solid ${T.border}`,
                  }}
                >
                  <code style={{ fontSize: 13, fontFamily: T.fontMono }}>{p}</code>
                  <button
                    onClick={() => removePattern(p)}
                    disabled={status === "saving"}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: T.critical,
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: "pointer",
                      padding: "4px 8px",
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
          </div>
        </div>

        <div style={cardStyle} ref={trustedRef}>
          <SectionHeading>3 · Trusted destinations</SectionHeading>
          <div style={{ fontSize: 13, color: T.inkSecondary, marginBottom: 12, lineHeight: 1.5 }}>
            Hosts inside your trust boundary, like your own APIs. Calls to them aren't treated as data leaving: a
            session holding secrets or personal data <strong>can send it here</strong>, and they aren't flagged as new
            destinations. Use <code>*.example.com</code> for every subdomain (it doesn't include{" "}
            <code>example.com</code> itself). localhost and 127.0.0.1 are always trusted.
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 10px", marginBottom: 12, borderRadius: 6, background: tint(T.warning, 10), border: `1px solid ${tint(T.warning, 35)}`, fontSize: 12.5, color: T.warningInk, lineHeight: 1.45 }}>
            <IconAlert size={14} color={T.warning} />
            Only add hosts you control or fully trust. A host an agent was steered to (a paste site, a webhook catcher)
            is exactly what this protection exists to stop.
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addDomain()}
              placeholder="e.g. api.mycompany.com, *.internal.mycompany.com"
              style={{
                flex: 1,
                padding: "9px 12px",
                borderRadius: 6,
                border: `1px solid ${prefill?.trustDomain && newDomain ? T.warning : T.borderStrong}`,
                background: T.surface,
                color: T.ink,
                fontSize: 13,
                fontFamily: T.fontMono,
                outline: "none",
              }}
            />
            <button
              onClick={addDomain}
              disabled={!newDomain.trim() || status === "saving"}
              style={{
                padding: "9px 18px",
                borderRadius: 6,
                border: "none",
                background: T.accent,
                color: T.onAccent,
                fontSize: 13,
                fontWeight: 600,
                cursor: newDomain.trim() ? "pointer" : "default",
                opacity: newDomain.trim() ? 1 : 0.5,
              }}
            >
              Trust
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {trusted && trusted.length === 0 && (
              <div style={{ fontSize: 13, color: T.inkMuted, fontStyle: "italic" }}>No trusted destinations yet — every outside host is checked.</div>
            )}
            {trusted &&
              trusted.map((d) => (
                <div key={d} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderRadius: 6, background: T.surface, border: `1px solid ${T.border}` }}>
                  <code style={{ fontSize: 13, fontFamily: T.fontMono }}>{d}</code>
                  <button
                    onClick={() => removeDomain(d)}
                    disabled={status === "saving"}
                    style={{ background: "transparent", border: "none", color: T.critical, fontSize: 12, fontWeight: 600, cursor: "pointer", padding: "4px 8px" }}
                  >
                    Remove
                  </button>
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const cardStyle = {
  border: `1px solid ${T.border}`,
  borderRadius: 6,
  padding: "18px 18px 20px",
  marginBottom: 20,
};

function SectionHeading({ children }) {
  return (
    <div style={{ fontSize: 13, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: T.inkMuted, marginBottom: 6 }}>
      {children}
    </div>
  );
}

function RuleToggleRow({ label, on, onToggle, disabled }) {
  return (
    <div
      onClick={disabled ? undefined : onToggle}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "10px 14px",
        borderRadius: 6,
        background: T.surface,
        border: `1px solid ${T.border}`,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <div style={{ fontSize: 13, lineHeight: 1.4 }}>{label}</div>
      <Switch on={on} />
    </div>
  );
}

function Switch({ on }) {
  return (
    <div
      style={{
        flexShrink: 0,
        width: 34,
        height: 20,
        borderRadius: 999,
        background: on ? T.accent : T.borderStrong,
        position: "relative",
        transition: "background 120ms ease",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 2,
          left: on ? 16 : 2,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: T.onAccent,
          transition: "left 120ms ease",
          boxShadow: "0 1px 2px rgba(23,20,14,0.25)",
        }}
      />
    </div>
  );
}
